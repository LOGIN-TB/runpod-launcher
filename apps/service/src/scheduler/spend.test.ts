import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openDatabase } from '../store/db.js'
import { RunpodClient } from '../runpod/client.js'
import { localDayKey, SpendTracker, startOfLocalMonth } from './spend.js'
import { billed, billingStub, failingBilling, trackerWith } from './spend.fixtures.js'

const near = (actual: number, expected: number, what: string, tolerance = 0.01): void => {
  assert.ok(Math.abs(actual - expected) < tolerance, `${what}: expected ~${expected}, got ${actual}`)
}

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
  const from = startOfLocalMonth(new Date('2026-09-15T12:00:00Z'), 'Europe/Berlin')
  assert.ok(from < new Date('2026-09-01T00:00:00Z'))
  assert.ok(from > new Date('2026-08-30T00:00:00Z'))
})

test('billed amounts are split into today and this month', async () => {
  const { tracker } = trackerWith([
    billed({ totalAmount: 3.5, startTime: '2026-09-01T00:00:00Z' }),
    billed({ totalAmount: 2.25, startTime: '2026-09-15T00:00:00Z' }),
  ])
  const snapshot = await tracker.snapshot(new Date('2026-09-15T12:00:00Z'))
  near(snapshot.monthUsd, 5.75, 'the month')
  near(snapshot.todayUsd, 2.25, 'today')
})

test('spend from an earlier month stays in that month, though RunPod ignores the range', async () => {
  // The bug this was heading for. `from` is not honoured, so the whole account
  // history arrives every time and used to be summed as "this month". On 31
  // August the account's history happened to begin on the 23rd, so the number
  // was right by accident; on 1 September it would have reported August as
  // September and gone on accumulating until the monthly cap force-stopped
  // everything for a reason that was not true.
  const { tracker } = trackerWith([
    billed({ totalAmount: 7, startTime: '2026-08-23T10:00:00Z' }),
    billed({ totalAmount: 2, startTime: '2026-09-01T08:00:00Z' }),
  ])
  const snapshot = await tracker.snapshot(new Date('2026-09-01T12:00:00Z'))
  near(snapshot.monthUsd, 2, 'September, not August as well')
})

test('an hour RunPod has already billed is not estimated a second time', async () => {
  // Measured on a live account at 13:34 UTC: hourly billing was current to
  // 12:00, and a day record for today already existed. The old estimate ran
  // from `started_at`, so every billed hour was counted twice — and the spend
  // caps compare that very figure.
  const { tracker } = trackerWith(
    [
      billed({ totalAmount: 1, podId: 'p1', startTime: '2026-09-15T10:00:00Z' }),
      billed({ totalAmount: 1, podId: 'p1', startTime: '2026-09-15T11:00:00Z' }),
    ],
    [{ id: 'p1', rate: 2, startedAt: '2026-09-15T10:00:00Z' }],
    { timezone: 'UTC' },
  )

  const snapshot = await tracker.snapshot(new Date('2026-09-15T12:30:00Z'))

  near(snapshot.estimatedUsd, 1, 'half an hour past the seam at $2/h')
  near(snapshot.todayUsd, 3, 'two billed hours plus half an estimated one')
})

test('a pod resumed after a week is charged from the resume, not from its first start', async () => {
  // `started_at` is not re-stamped on resume — confirmed in `record()`, whose
  // conflict branch leaves it alone. Trusting it alone would report a week of
  // "live" cost for a pod that came back ten minutes ago.
  const { tracker } = trackerWith(
    [billed({ totalAmount: 5, podId: 'p1', startTime: '2026-09-15T11:00:00Z' })],
    [{ id: 'p1', rate: 3, startedAt: '2026-09-08T09:00:00Z' }],
    { timezone: 'UTC' },
  )

  const snapshot = await tracker.snapshot(new Date('2026-09-15T12:30:00Z'))
  near(snapshot.estimatedUsd, 1.5, 'half an hour since the last billed hour, not seven days')
})

test('a pod that ran across midnight contributes only the hours after midnight to today', async () => {
  const { tracker } = trackerWith([], [{ id: 'p1', rate: 1, startedAt: '2026-09-14T20:00:00Z' }], {
    timezone: 'UTC',
  })
  const snapshot = await tracker.snapshot(new Date('2026-09-15T03:00:00Z'))

  near(snapshot.estimatedUsd, 3, 'three hours of the new day')
  near(snapshot.estimatedMonthUsd, 7, 'but seven hours of the month')
})

test('a pod that is still provisioning counts, because RunPod bills it', async () => {
  // Thirteen minutes of paid download were measured in this project. A figure
  // that excluded them made the brake weaker than intended during a start.
  const { tracker } = trackerWith(
    [],
    [{ id: 'p1', rate: 4, startedAt: '2026-09-15T11:00:00Z', status: 'PROVISIONING' }],
    { timezone: 'UTC' },
  )
  const snapshot = await tracker.snapshot(new Date('2026-09-15T12:00:00Z'))
  near(snapshot.estimatedUsd, 4, 'an hour at $4 while it comes up')
})

test('the figure for today turns over at local midnight without waiting for the cache', async () => {
  // The billed part used to be worked out once per fetch and reused for five
  // minutes. Just after midnight the daily cap was therefore compared against
  // yesterday's spend, and a pod started at 00:01 could be stopped for it.
  const { tracker } = trackerWith(
    [billed({ totalAmount: 6, podId: 'other', startTime: '2026-09-14T20:00:00Z' })],
    [],
    { timezone: 'UTC' },
  )

  const before = await tracker.snapshot(new Date('2026-09-14T23:59:00Z'))
  near(before.todayUsd, 6, 'yesterday, before midnight')

  const after = await tracker.snapshot(new Date('2026-09-15T00:01:00Z'))
  near(after.todayUsd, 0, 'and a minute later it is a new day, cache or no cache')
})

test('a billing outage does not disable the limits', async () => {
  const db = openDatabase(':memory:')
  db.prepare(
    `INSERT INTO pods (id, status, cost_per_hour, created_at, started_at) VALUES (?, 'RUNNING', ?, ?, ?)`,
  ).run('p1', 2.0, '2026-09-15T09:00:00Z', '2026-09-15T09:00:00Z')

  const tracker = new SpendTracker(db, () => new RunpodClient('key', failingBilling()), () => 'UTC')
  const snapshot = await tracker.snapshot(new Date('2026-09-15T12:00:00Z'))

  // History is lost, but the live run still counts — so a cap can still fire.
  assert.ok(snapshot.todayUsd >= 6, `three hours at $2 should still be counted, got ${snapshot.todayUsd}`)
  assert.equal(snapshot.stale, true, 'and it says the history is stale rather than pretending')
})

test('a billing outage is not retried on every single call', async () => {
  // The old catch left the timestamp alone, so the cache read as expired
  // immediately and the next call refetched. Between the scheduler's minute and
  // the app's thirty seconds that is a request storm at an endpoint already
  // in trouble.
  let calls = 0
  const db = openDatabase(':memory:')
  const tracker = new SpendTracker(
    db,
    () => new RunpodClient('key', failingBilling(() => (calls += 1))),
    () => 'UTC',
  )

  await tracker.snapshot(new Date('2026-09-15T12:00:00Z'))
  await tracker.snapshot(new Date('2026-09-15T12:00:10Z'))
  await tracker.snapshot(new Date('2026-09-15T12:00:20Z'))
  assert.equal(calls, 1, 'one attempt, not three')

  await tracker.snapshot(new Date('2026-09-15T12:02:00Z'))
  assert.equal(calls, 2, 'and it does try again later')
})

test('two callers at once cause one billing request', async () => {
  let calls = 0
  const counting = (async (url: unknown) => {
    if (String(url).includes('/billing/pods')) calls += 1
    return new Response(JSON.stringify({ records: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  const db = openDatabase(':memory:')
  const tracker = new SpendTracker(db, () => new RunpodClient('key', counting), () => 'UTC')

  const now = new Date('2026-09-15T12:00:00Z')
  await Promise.all([tracker.snapshot(now), tracker.snapshot(now), tracker.snapshot(now)])
  assert.equal(calls, 1)
})

test('changing the timezone re-cuts the days without asking RunPod again', async () => {
  let calls = 0
  let timezone = 'UTC'
  const counting = (async (url: unknown) => {
    const target = String(url)
    if (!target.includes('/billing/pods')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    calls += 1
    return new Response(
      JSON.stringify({
        records: [billed({ totalAmount: 4, podId: 'other', startTime: '2026-09-14T23:00:00Z' })],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  const db = openDatabase(':memory:')
  const tracker = new SpendTracker(db, () => new RunpodClient('key', counting), () => timezone)

  const now = new Date('2026-09-15T02:00:00Z')
  const inUtc = await tracker.snapshot(now)
  near(inUtc.todayUsd, 0, 'in UTC that hour belongs to the 14th')

  timezone = 'Europe/Berlin'
  const inBerlin = await tracker.snapshot(now)
  near(inBerlin.todayUsd, 4, 'in Berlin it is already the 15th')
  assert.equal(calls, 1, 'and the records did not have to be fetched again')
})

test('a stopped pod contributes nothing live', async () => {
  const { tracker } = trackerWith(
    [],
    [
      {
        id: 'p1',
        rate: 5,
        startedAt: '2026-09-15T09:00:00Z',
        status: 'EXITED',
        stoppedAt: '2026-09-15T10:00:00Z',
      },
    ],
    { timezone: 'UTC' },
  )
  const snapshot = await tracker.snapshot(new Date('2026-09-15T12:00:00Z'))
  assert.equal(snapshot.estimatedUsd, 0)
})

test('two pods running cost twice as much, and the limit sees it', async () => {
  // The live estimate is what the daily and monthly brakes are compared
  // against. Counting one pod when two are up reports half the spend, which
  // quietly disables the brake exactly when it matters most.
  const { tracker } = trackerWith(
    [],
    [
      { id: 'pod-a', rate: 0.5, startedAt: '2026-09-01T10:00:00Z', templateId: 't1' },
      { id: 'pod-b', rate: 0.8, startedAt: '2026-09-01T10:00:00Z', templateId: 't1' },
    ],
    { timezone: 'UTC' },
  )

  const snapshot = await tracker.snapshot(new Date('2026-09-01T12:00:00Z'))
  near(snapshot.estimatedUsd, 2.6, 'two hours at $0.50 plus two hours at $0.80')
  near(snapshot.todayUsd, 2.6, 'and that is the whole of today')
})

test('the breakdown names foreign pods instead of dropping them', async () => {
  // On the account that prompted this, 61% of the bill was pods the launcher
  // never created. Leaving them out gives a breakdown that does not add up to
  // the figure on the invoice.
  const { tracker } = trackerWith(
    [
      billed({ totalAmount: 4, podId: 'ours', startTime: '2026-09-01T08:00:00Z' }),
      billed({ totalAmount: 9, podId: 'somebody-elses', startTime: '2026-09-01T08:00:00Z' }),
    ],
    [{ id: 'ours', rate: 0, startedAt: '2026-09-01T08:00:00Z', templateId: 't1', status: 'EXITED', stoppedAt: '2026-09-01T09:00:00Z' }],
    { timezone: 'UTC' },
  )

  const report = await tracker.report(new Date('2026-09-01T12:00:00Z'))
  const foreign = report.shares.find((share) => share.kind === 'foreign')
  const ours = report.shares.find((share) => share.kind === 'template')

  near(foreign?.usd ?? 0, 9, 'the foreign share')
  near(ours?.usd ?? 0, 4, 'ours')
  near(
    report.shares.reduce((sum, share) => sum + share.usd, 0),
    report.monthUsd,
    'and the parts add up to the whole',
  )
})

test('a pod whose template was deleted keeps its spend', async () => {
  const db = openDatabase(':memory:')
  db.prepare(
    `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, started_at, stopped_at)
     VALUES ('orphan', NULL, 'EXITED', 0, ?, ?, ?)`,
  ).run('2026-09-01T08:00:00Z', '2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z')

  const tracker = new SpendTracker(
    db,
    () =>
      new RunpodClient(
        'key',
        billingStub([billed({ totalAmount: 3, podId: 'orphan', startTime: '2026-09-01T08:00:00Z' })]),
      ),
    () => 'UTC',
  )

  const report = await tracker.report(new Date('2026-09-01T12:00:00Z'))
  const deleted = report.shares.find((share) => share.kind === 'deleted')
  near(deleted?.usd ?? 0, 3, 'still counted, just no longer named')
})

test('the day series covers the month so far, and today carries the estimate', async () => {
  const { tracker } = trackerWith(
    [billed({ totalAmount: 2, podId: 'other', startTime: '2026-09-01T08:00:00Z' })],
    [{ id: 'p1', rate: 1, startedAt: '2026-09-03T10:00:00Z' }],
    { timezone: 'UTC' },
  )

  const report = await tracker.report(new Date('2026-09-03T12:00:00Z'))
  assert.deepEqual(
    report.days.map((day) => day.day),
    ['2026-09-01', '2026-09-02', '2026-09-03'],
    'including the empty middle day',
  )
  near(report.days[0]?.totalUsd ?? 0, 2, 'the first')
  assert.equal(report.days[1]?.totalUsd, 0, 'the quiet one')
  near(report.days[2]?.totalUsd ?? 0, 2, "today's two estimated hours")
  assert.equal(report.days[2]?.partial, true, 'and today is marked as partly estimated')
  near(
    report.days.reduce((sum, day) => sum + day.totalUsd, 0),
    report.monthUsd,
    'the bars add up to the headline',
  )
})

test('the report says it is about pods, because network volumes are not in it', async () => {
  const { tracker } = trackerWith([], [], { timezone: 'UTC' })
  const report = await tracker.report(new Date('2026-09-01T12:00:00Z'))
  assert.equal(report.scope, 'pods')
})

test('before the first successful read there is no "as of" time to give', async () => {
  // Reporting a timestamp while also reporting the figures as stale contradicts
  // itself, and the screen showed both at once.
  const { tracker } = trackerWith([], [], { timezone: 'UTC', fetchImpl: failingBilling() })
  const report = await tracker.report(new Date('2026-09-15T12:00:00Z'))

  assert.equal(report.fetchedAt, null)
  assert.equal(report.stale, true)
})
