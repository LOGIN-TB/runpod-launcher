import assert from 'node:assert/strict'
import { test } from 'node:test'
import { templateSchema, type Template } from '@runpod-launcher/shared'
import { openDatabase, type Db } from '../store/db.js'
import { loadOrCreateMasterKey } from '../store/crypto.js'
import { SettingsStore } from '../store/settings.js'
import { RunpodClient } from '../runpod/client.js'
import { PodManager } from '../pods/manager.js'
import { SpendTracker } from './spend.js'
import { Notifier, type Notification, type NotificationSink } from './notify.js'
import { Scheduler } from './scheduler.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const silent = { info: () => {}, warn: () => {}, error: () => {} }

const template = (overrides: Record<string, unknown> = {}): Template =>
  templateSchema.parse({
    id: 't1',
    name: 'scheduled',
    image: 'img',
    gpuTypeId: 'NVIDIA L40S',
    chatModel: { repoId: 'a/b' },
    lifecycleMode: 'stopResume',
    schedule: {
      enabled: true,
      timezone: 'Europe/Berlin',
      weekdays: [1, 2, 3, 4, 5],
      startAt: '07:00',
      stopAt: '19:00',
      idleStopMinutes: 0,
      maxRuntimeHours: 0,
    },
    ...overrides,
  })

interface Harness {
  scheduler: Scheduler
  db: Db
  calls: string[]
  sent: Notification[]
}

function harness(options: {
  tpl?: Template
  pod?: { status: string; startedAt: string; rate: number; startedBy?: 'user' | 'scheduler' }
  billed?: number
  limits?: { dailyLimitUsd?: number | null }
} = {}): Harness {
  const db = openDatabase(':memory:')
  const key = loadOrCreateMasterKey(join(mkdtempSync(join(tmpdir(), 'sched-')), 'master.key'))
  const settings = new SettingsStore(db, key)
  // The scheduler stays idle without credentials, which is what the
  // 'schedule created before the key' test below covers.
  settings.update({ runpodApiKey: 'rpa_test', timezone: 'Europe/Berlin', ...options.limits })

  const tpl = options.tpl ?? template()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(tpl.id, tpl.name, JSON.stringify(tpl), now, now)

  if (options.pod) {
    db.prepare(
      `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, started_at, started_by)
       VALUES ('p1', ?, ?, ?, ?, ?, ?)`,
    ).run(
      tpl.id,
      options.pod.status,
      options.pod.rate,
      options.pod.startedAt,
      options.pod.startedAt,
      // Whoever started it decides whether the schedule may take it away, so
      // the tests have to say.
      options.pod.startedBy ?? 'scheduler',
    )
  }

  const calls: string[] = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/billing/pods')) {
      return json({ records: [{ totalAmount: options.billed ?? 0, startTime: new Date().toISOString() }] })
    }
    if (/\/pods\/[^/]+\/action$/.test(u)) {
      calls.push(`action:${JSON.parse(String(init?.body)).action}`)
      return json({ id: 'p1', status: 'RUNNING', cost: 0.99, gpu: { id: 'g', count: 1 }, startedAt: null })
    }
    if (u.endsWith('/v2/pods') && init?.method === 'POST') {
      calls.push('create')
      return json({ id: 'p1', status: 'RUNNING', cost: 0.99, startedAt: null })
    }
    return json({})
  }) as unknown as typeof fetch

  const runpod = (): RunpodClient => new RunpodClient('key', fetchImpl)
  const pods = new PodManager(db, runpod, () => null)
  const spend = new SpendTracker(db, runpod, () => 'Europe/Berlin')

  const sent: Notification[] = []
  const notifier = new Notifier(settings, silent, (async () => new Response('', { status: 200 })) as unknown as typeof fetch)
  const recording: NotificationSink = {
    send: async (n: Notification) => {
      sent.push(n)
      await notifier.send(n)
    },
  }

  return { scheduler: new Scheduler(db, settings, pods, spend, recording, silent), db, calls, sent }
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** A Tuesday. 06:00 UTC is 08:00 Berlin (inside), 18:00 UTC is 20:00 (outside). */
const insideHours = new Date('2026-09-01T06:00:00Z')
const outsideHours = new Date('2026-09-01T18:00:00Z')

test('the scheduler starts a pod when the window opens', async () => {
  const h = harness()
  const action = await h.scheduler.tick(insideHours)
  assert.deepEqual(action, { do: 'start', because: 'inside-schedule' })
  assert.deepEqual(h.calls, ['create'])
  assert.equal(h.sent.at(-1)?.kind, 'pod-started')
})

test('the scheduler stops it when the window closes', async () => {
  const h = harness({ pod: { status: 'RUNNING', startedAt: '2026-09-01T14:00:00Z', rate: 0.99 } })
  const action = await h.scheduler.tick(outsideHours)
  assert.equal(action?.do, 'stop')
  assert.deepEqual(h.calls, ['action:stop'])
})

test('a spend limit stops the pod and says so', async () => {
  const h = harness({
    pod: { status: 'RUNNING', startedAt: '2026-09-01T00:00:00Z', rate: 2.0 },
    limits: { dailyLimitUsd: 5 },
  })
  const action = await h.scheduler.tick(insideHours)
  assert.equal(action?.because, 'daily-limit')
  assert.deepEqual(h.calls, ['action:stop'])

  const alert = h.sent.at(-1)
  assert.equal(alert?.kind, 'spend-limit-reached')
  assert.match(alert!.message, /Daily spending limit reached/)
})

test('every scheduler action is written to the audit log', async () => {
  const h = harness()
  await h.scheduler.tick(insideHours)
  const rows = h.db.prepare("SELECT actor, action, detail FROM audit_log WHERE actor = 'scheduler'").all() as Array<{
    action: string
    detail: string
  }>
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.action, 'pod.start')
  assert.match(rows[0]!.detail, /inside-schedule/)
})

test('a failed start is reported rather than passing in silence', async () => {
  // Nobody is watching at 07:00; without this the first sign is a workflow
  // timing out hours later.
  const db = openDatabase(':memory:')
  const key = loadOrCreateMasterKey(join(mkdtempSync(join(tmpdir(), 'sched-')), 'master.key'))
  const settings = new SettingsStore(db, key)
  settings.update({ runpodApiKey: 'rpa_test' })
  const tpl = template()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(tpl.id, tpl.name, JSON.stringify(tpl), now, now)

  const failing = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes('/billing/pods')) return json({ records: [] })
    if (String(url).endsWith('/v2/pods') && init?.method === 'POST') {
      return new Response('{"detail":"boom"}', { status: 500 })
    }
    return json({})
  }) as unknown as typeof fetch

  const runpod = (): RunpodClient => new RunpodClient('key', failing)
  const sent: Notification[] = []
  const notifier: NotificationSink = { send: async (n: Notification) => void sent.push(n) }
  const scheduler = new Scheduler(
    db,
    settings,
    new PodManager(db, runpod, () => null),
    new SpendTracker(db, runpod, () => 'UTC'),
    notifier,
    silent,
  )

  await scheduler.tick(insideHours)
  assert.equal(sent.at(-1)?.kind, 'pod-start-failed')
  assert.match(sent.at(-1)!.message, /Could not start/)
})

test('overlapping ticks do not rent two GPUs', async () => {
  // Starting takes minutes. Two ticks both deciding to start would each create
  // a pod, and the second one would be invisible and billed.
  const h = harness()
  await Promise.all([h.scheduler.tick(insideHours), h.scheduler.tick(insideHours)])
  assert.equal(h.calls.filter((call) => call === 'create').length, 1)
})

test('nothing happens with no scheduled template', async () => {
  const h = harness({ tpl: template({ schedule: { enabled: false, timezone: 'UTC', weekdays: [], idleStopMinutes: 0, maxRuntimeHours: 0 } }) })
  assert.equal(await h.scheduler.tick(insideHours), null)
  assert.deepEqual(h.calls, [])
})

test('a schedule created before the RunPod key still runs once the key arrives', async () => {
  // The order every new user follows: pair, create a template, then paste the
  // key. Gating the scheduler on start-up credentials meant it stayed asleep
  // until the container was restarted, and the schedule looked broken.
  const db = openDatabase(':memory:')
  const key = loadOrCreateMasterKey(join(mkdtempSync(join(tmpdir(), 'sched-')), 'master.key'))
  const settings = new SettingsStore(db, key)
  const tpl = template()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(tpl.id, tpl.name, JSON.stringify(tpl), now, now)

  const calls: string[] = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes('/billing/pods')) return json({ records: [] })
    if (String(url).endsWith('/v2/pods') && init?.method === 'POST') {
      calls.push('create')
      return json({ id: 'p1', status: 'RUNNING', cost: 0.99, startedAt: null })
    }
    return json({})
  }) as unknown as typeof fetch

  const runpod = (): RunpodClient => new RunpodClient(settings.secret('runpodApiKey') ?? '', fetchImpl)
  const scheduler = new Scheduler(
    db,
    settings,
    new PodManager(db, runpod, () => null),
    new SpendTracker(db, runpod, () => 'Europe/Berlin'),
    { send: async () => {} } satisfies NotificationSink,
    silent,
  )

  // No key yet: the tick must be a quiet no-op, not a crash and not an action.
  assert.equal(await scheduler.tick(insideHours), null)
  assert.deepEqual(calls, [])

  settings.update({ runpodApiKey: 'rpa_test' })

  // Same scheduler instance, no restart.
  const action = await scheduler.tick(insideHours)
  assert.deepEqual(action, { do: 'start', because: 'inside-schedule' })
  assert.deepEqual(calls, ['create'])
})

test('the scheduler leaves a hand-started pod alone until it has been used', async () => {
  // End to end through the scheduler, not just the decision: a pod created by
  // hand shortly before the window closes must survive long enough to be
  // usable, or its download was paid for and thrown away.
  const h = harness({
    pod: { status: 'RUNNING', startedAt: '2026-09-01T17:50:00Z', rate: 0.99, startedBy: 'user' },
  })
  const action = await h.scheduler.tick(outsideHours)
  assert.deepEqual(action, { do: 'nothing', because: 'manual-start' })
  assert.deepEqual(h.calls, [], 'nothing was stopped')
})

test('traffic on one pod does not keep another pod alive', async () => {
  // The failure this guards against was already seen once in a simpler form: a
  // fresh pod was killed after 64 seconds under a thirty-minute idle limit,
  // because idleness was measured from the newest request across all pods
  // rather than from this pod's own. With one pod per application the same bug
  // inverts — a busy pod would hold every idle one open, billing all night.
  const db = openDatabase(':memory:')
  const key = loadOrCreateMasterKey(join(mkdtempSync(join(tmpdir(), 'sched-')), 'master.key'))
  const settings = new SettingsStore(db, key)
  settings.update({ runpodApiKey: 'rpa_test', timezone: 'Europe/Berlin' })

  // Two templates, each with a five-minute idle limit and no schedule window,
  // so idleness is the only thing that can stop either of them.
  const busy = template({
    id: 'busy',
    name: 'busy',
    schedule: { enabled: true, timezone: 'Europe/Berlin', weekdays: [1, 2, 3, 4, 5], startAt: '07:00', stopAt: '19:00', idleStopMinutes: 5, maxRuntimeHours: 0 },
  })
  const quiet = template({
    id: 'quiet',
    name: 'quiet',
    schedule: { enabled: true, timezone: 'Europe/Berlin', weekdays: [1, 2, 3, 4, 5], startAt: '07:00', stopAt: '19:00', idleStopMinutes: 5, maxRuntimeHours: 0 },
  })

  const created = new Date(insideHours.getTime() - 60 * 60_000).toISOString()
  for (const tpl of [busy, quiet]) {
    db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(tpl.id, tpl.name, JSON.stringify(tpl), created, created)
    // With an api_key, because `describeFor` needs it to reach the engine and
    // nothing counts as idle until the engine actually answers.
    db.prepare(
      `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, started_at, started_by, api_key)
       VALUES (?, ?, 'RUNNING', 0.5, ?, ?, 'scheduler', 'k')`,
    ).run(`pod-${tpl.id}`, tpl.id, created, created)
  }

  // One request a minute ago, on the busy template only.
  db.prepare('INSERT INTO usage (at, token_id, template_id, endpoint) VALUES (?, ?, ?, ?)').run(
    new Date(insideHours.getTime() - 60_000).toISOString(),
    'tok',
    'busy',
    '/v1/chat/completions',
  )

  const stopped: string[] = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/billing/pods')) return json({ records: [] })
    const action = /\/pods\/([^/]+)\/action$/.exec(u)
    if (action) {
      stopped.push(`${action[1]}:${JSON.parse(String(init?.body)).action}`)
      return json({ id: action[1], status: 'EXITED', cost: 0.5, startedAt: null })
    }
    if (u.endsWith('/health')) return new Response('ok', { status: 200 })
    return json({})
  }) as unknown as typeof fetch
  globalThis.fetch = fetchImpl

  const runpod = (): RunpodClient => new RunpodClient('key', fetchImpl)
  const pods = new PodManager(db, runpod, () => null)
  const scheduler = new Scheduler(
    db,
    settings,
    pods,
    new SpendTracker(db, runpod, () => 'Europe/Berlin'),
    { send: async () => {} },
    silent,
  )

  await scheduler.tick(insideHours)

  assert.deepEqual(stopped, ['pod-quiet:stop'], 'only the idle pod was stopped')
  assert.ok(pods.currentFor('busy'), 'the busy pod is still up')
  assert.equal(pods.currentFor('quiet'), null, 'and the idle one is not')
})
