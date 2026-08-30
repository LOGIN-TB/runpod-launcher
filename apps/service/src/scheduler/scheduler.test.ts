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
  pod?: { status: string; startedAt: string; rate: number }
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
      `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, started_at)
       VALUES ('p1', ?, ?, ?, ?, ?)`,
    ).run(tpl.id, options.pod.status, options.pod.rate, options.pod.startedAt, options.pod.startedAt)
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
