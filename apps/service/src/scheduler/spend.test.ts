import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openDatabase } from '../store/db.js'
import { RunpodClient } from '../runpod/client.js'
import { localDayKey, SpendTracker, startOfMonth } from './spend.js'

test('"today" means the user\'s today, not the server\'s', () => {
  // 23:30 UTC on 1 September is already 2 September in Berlin. A limit that
  // used the server's date would reset the day two hours late every night.
  const instant = new Date('2026-09-01T23:30:00Z')
  assert.equal(localDayKey(instant, 'UTC'), '2026-09-01')
  assert.equal(localDayKey(instant, 'Europe/Berlin'), '2026-09-02')
})

test('the billing window starts before the first of the month, not on it', () => {
  // Berlin's first of the month begins at 22:00 UTC on the last day of the
  // previous one. Querying from midnight UTC would drop those hours.
  const from = startOfMonth(new Date('2026-09-15T12:00:00Z'), 'Europe/Berlin')
  assert.ok(from < new Date('2026-09-01T00:00:00Z'))
  assert.ok(from > new Date('2026-08-30T00:00:00Z'))
})

/** A RunPod stub returning one billed day plus whatever else is asked for. */
const billing = (records: Array<{ totalAmount: number; startTime: string }>): typeof fetch =>
  (async (url: unknown) => {
    const body = String(url).includes('/billing/pods') ? { records } : {}
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

const trackerWith = (records: Array<{ totalAmount: number; startTime: string }>, pod?: { rate: number; startedAt: string }) => {
  const db = openDatabase(':memory:')
  if (pod) {
    db.prepare(
      `INSERT INTO pods (id, status, cost_per_hour, created_at, started_at) VALUES (?, 'RUNNING', ?, ?, ?)`,
    ).run('p1', pod.rate, pod.startedAt, pod.startedAt)
  }
  return new SpendTracker(db, () => new RunpodClient('key', billing(records)), () => 'Europe/Berlin')
}

test('billed amounts are split into today and this month', async () => {
  const tracker = trackerWith([
    { totalAmount: 3.5, startTime: '2026-09-01T00:00:00Z' },
    { totalAmount: 2.25, startTime: '2026-09-15T00:00:00Z' },
  ])
  const snapshot = await tracker.snapshot(new Date('2026-09-15T12:00:00Z'))
  assert.equal(snapshot.monthUsd, 5.75)
  assert.equal(snapshot.todayUsd, 2.25)
})

test('the run in flight is added, because billing books it only after midnight', async () => {
  // Without this, a limit could never fire on the day the money is spent.
  const tracker = trackerWith([{ totalAmount: 1, startTime: '2026-09-01T00:00:00Z' }], {
    rate: 0.99,
    startedAt: '2026-09-15T10:00:00Z',
  })
  const snapshot = await tracker.snapshot(new Date('2026-09-15T12:00:00Z'))

  assert.ok(Math.abs(snapshot.estimatedUsd - 1.98) < 0.01, `two hours at $0.99, got ${snapshot.estimatedUsd}`)
  assert.ok(Math.abs(snapshot.todayUsd - 1.98) < 0.01, 'nothing was billed today yet')
  assert.ok(Math.abs(snapshot.monthUsd - 2.98) < 0.01, 'one billed dollar plus the live run')
})

test('a billing outage does not disable the limits', async () => {
  const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
  const db = openDatabase(':memory:')
  db.prepare(
    `INSERT INTO pods (id, status, cost_per_hour, created_at, started_at) VALUES (?, 'RUNNING', ?, ?, ?)`,
  ).run('p1', 2.0, '2026-09-15T09:00:00Z', '2026-09-15T09:00:00Z')

  const tracker = new SpendTracker(db, () => new RunpodClient('key', failing), () => 'UTC')
  const snapshot = await tracker.snapshot(new Date('2026-09-15T12:00:00Z'))

  // History is lost, but the live run still counts — so a cap can still fire.
  assert.ok(snapshot.todayUsd >= 6, `three hours at $2 should still be counted, got ${snapshot.todayUsd}`)
})

test('a stopped pod contributes nothing live', async () => {
  const db = openDatabase(':memory:')
  db.prepare(
    `INSERT INTO pods (id, status, cost_per_hour, created_at, started_at, stopped_at)
     VALUES (?, 'EXITED', ?, ?, ?, ?)`,
  ).run('p1', 5.0, '2026-09-15T09:00:00Z', '2026-09-15T09:00:00Z', '2026-09-15T10:00:00Z')

  const tracker = new SpendTracker(db, () => new RunpodClient('key', billing([])), () => 'UTC')
  const snapshot = await tracker.snapshot(new Date('2026-09-15T12:00:00Z'))
  assert.equal(snapshot.estimatedUsd, 0)
})
