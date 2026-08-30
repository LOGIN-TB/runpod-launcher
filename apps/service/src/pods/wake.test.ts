import assert from 'node:assert/strict'
import { test } from 'node:test'
import { templateSchema } from '@runpod-launcher/shared'
import { openDatabase } from '../store/db.js'
import { RunpodClient } from '../runpod/client.js'
import { PodManager } from './manager.js'

const scheduled = templateSchema.parse({
  id: 't1',
  name: 'nightly',
  image: 'img',
  gpuTypeId: 'NVIDIA L40S',
  chatModel: { repoId: 'a/b' },
  lifecycleMode: 'stopResume',
  schedule: { enabled: true, timezone: 'UTC', weekdays: [1], startAt: '07:00', stopAt: '19:00' },
})

const unscheduled = templateSchema.parse({
  id: 't2',
  name: 'manual',
  image: 'img',
  gpuTypeId: 'NVIDIA L40S',
  chatModel: { repoId: 'c/d' },
  lifecycleMode: 'stopResume',
})

const setup = () => {
  const db = openDatabase(':memory:')
  const now = new Date().toISOString()
  const insert = db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
  insert.run(unscheduled.id, unscheduled.name, JSON.stringify(unscheduled), now, now)
  insert.run(scheduled.id, scheduled.name, JSON.stringify(scheduled), now, now)
  const noop = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  return { db, manager: new PodManager(db, () => new RunpodClient('k', noop), () => null) }
}

test('after a scheduled stop, a request can still find something to wake', () => {
  // The failure this guards against: the scheduler stops the pod at 19:00,
  // pods.current() goes null, and wake-on-request silently stops working for
  // the entire night — exactly when it is wanted.
  const { db, manager } = setup()
  const then = new Date().toISOString()
  db.prepare(
    `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, started_at, stopped_at)
     VALUES ('p1', ?, 'EXITED', 0.99, ?, ?, ?)`,
  ).run(scheduled.id, then, then, then)

  assert.equal(manager.current(), null, 'the stopped pod is not current')
  assert.equal(manager.wakeTarget()?.name, 'nightly')
})

test('with no pod history at all, the scheduled template is the target', () => {
  const { manager } = setup()
  assert.equal(manager.wakeTarget()?.name, 'nightly')
})

test('with no templates at all there is nothing to wake', () => {
  const db = openDatabase(':memory:')
  const noop = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  const manager = new PodManager(db, () => new RunpodClient('k', noop), () => null)
  assert.equal(manager.wakeTarget(), null)
})

test('the last pod that ran wins over the scheduled one', () => {
  // Someone who started a different template by hand expects that one back,
  // not whatever the schedule happens to name.
  const { db, manager } = setup()
  const then = new Date().toISOString()
  db.prepare(
    `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, started_at, stopped_at)
     VALUES ('p2', ?, 'EXITED', 0.99, ?, ?, ?)`,
  ).run(unscheduled.id, then, then, then)
  assert.equal(manager.wakeTarget()?.name, 'manual')
})

test('a restart does not orphan a pod that is still running and still billed', async () => {
  // The pod's bearer token used to live only in memory. Restarting the service
  // left the launcher unable to reach a pod it was still paying for, and the
  // gateway reported it as absent.
  const db = openDatabase(':memory:')
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(scheduled.id, scheduled.name, JSON.stringify(scheduled), now, now)

  const seal = {
    encrypt: (value: string) => `enc:${value}`,
    decrypt: (value: string) => value.replace(/^enc:/, ''),
  }
  const created = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/v2/pods') && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: 'p9', status: 'RUNNING', cost: 0.5, startedAt: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

  const first = new PodManager(db, () => new RunpodClient('k', created), () => null, seal)
  await first.start(scheduled)
  const before = first.describe()
  assert.ok(before?.podApiKey, 'the running pod has a key')

  // A brand-new manager over the same database — what a container restart is.
  const afterRestart = new PodManager(db, () => new RunpodClient('k', created), () => null, seal)
  const after = afterRestart.describe()

  assert.ok(after, 'the pod is still visible after a restart')
  assert.equal(after!.podApiKey, before!.podApiKey, 'and reachable with the same key')

  // The key is not stored in clear.
  const row = db.prepare('SELECT api_key AS k FROM pods WHERE id = ?').get('p9') as { k: string }
  assert.ok(row.k.startsWith('enc:'))
})

test('RunPod rejecting a redundant start is agreement, not failure', async () => {
  // 409 means the pod is already up. It happens whenever our record has drifted
  // behind reality, and treating it as an error surfaced a raw upstream message.
  const db = openDatabase(':memory:')
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(scheduled.id, scheduled.name, JSON.stringify(scheduled), now, now)
  db.prepare(
    `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, started_at)
     VALUES ('p9', ?, 'EXITED', 0.5, ?, ?)`,
  ).run(scheduled.id, now, now)

  const conflicting = (async (url: unknown) => {
    const u = String(url)
    if (/\/pods\/[^/]+\/action$/.test(u)) {
      return new Response('{"detail":"action \\"start\\" is not valid for status RUNNING"}', { status: 409 })
    }
    if (/\/pods\/[^/]+$/.test(u)) {
      return new Response(JSON.stringify({ id: 'p9', status: 'RUNNING', cost: 0.5, startedAt: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

  const manager = new PodManager(db, () => new RunpodClient('k', conflicting), () => null)
  const record = await manager.start(scheduled)
  assert.equal(record.id, 'p9')
  assert.equal(record.status, 'RUNNING')
})

test('a single template is woken by a request even without a schedule', () => {
  // Otherwise wake-on-request quietly does nothing for the most common setup
  // of all: one template, started by hand, no schedule yet.
  const db = openDatabase(':memory:')
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(unscheduled.id, unscheduled.name, JSON.stringify(unscheduled), now, now)
  const noop = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  const manager = new PodManager(db, () => new RunpodClient('k', noop), () => null)
  assert.equal(manager.wakeTarget()?.name, 'manual')
})

test('several templates and no history stays ambiguous rather than guessing', () => {
  // Picking one would start a GPU nobody asked for, and bill for it.
  const { manager } = setup()
  const db = openDatabase(':memory:')
  const now = new Date().toISOString()
  const insert = db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
  const second = { ...unscheduled, id: 't3', name: 'another' }
  insert.run(unscheduled.id, unscheduled.name, JSON.stringify(unscheduled), now, now)
  insert.run(second.id, second.name, JSON.stringify(second), now, now)
  const noop = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  const ambiguous = new PodManager(db, () => new RunpodClient('k', noop), () => null)

  assert.equal(ambiguous.wakeTarget(), null)
  // The scheduled case from the other fixture still resolves.
  assert.equal(manager.wakeTarget()?.name, 'nightly')
})
