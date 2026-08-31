import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  localDayKey,
  localDaysBetween,
  rollUp,
  startOfLocalDay,
  startOfLocalMonth,
  type BillingRecord,
} from './spend-report.js'

const BERLIN = 'Europe/Berlin'
const KOLKATA = 'Asia/Kolkata'
const NEW_YORK = 'America/New_York'

const record = (over: Partial<BillingRecord> = {}): BillingRecord => ({
  podId: 'p1',
  startTime: '2026-08-30T10:00:00Z',
  endTime: '2026-08-30T11:00:00Z',
  totalAmount: 1,
  gpuAmount: 0.9,
  diskAmount: 0.1,
  ...over,
})

const round = (value: number): number => Math.round(value * 1e6) / 1e6

test('the month total ignores earlier months, even though RunPod ignores the from parameter', () => {
  // The bug this module exists for. `refreshBilled` summed every record it was
  // given and trusted `from` to have narrowed the range — and RunPod ignores
  // `from`, verified across three different ranges. On 31 August the account's
  // history happened to start on the 23rd, so the figure looked right by luck;
  // on 1 September it would have reported August as September, and gone on
  // growing until the monthly cap force-stopped everything for a false reason.
  const now = new Date('2026-09-01T12:00:00Z')
  const monthStart = startOfLocalMonth(now, BERLIN)

  const { totalUsd } = rollUp(
    [
      record({ startTime: '2026-08-23T10:00:00Z', endTime: '2026-08-23T11:00:00Z', totalAmount: 7 }),
      record({ startTime: '2026-09-01T08:00:00Z', endTime: '2026-09-01T09:00:00Z', totalAmount: 2 }),
    ],
    { timezone: BERLIN, from: monthStart, now },
  )

  assert.equal(totalUsd, 2, 'August stays in August')
})

test('a bucket straddling local midnight is split between the two days it covers', () => {
  // Berlin is UTC+2 in August, so 23:00–00:00Z is 01:00–02:00 the next day —
  // wholly one day. The interesting one is 21:00–23:00Z: 23:00–01:00 local.
  const now = new Date('2026-09-01T12:00:00Z')
  const { days } = rollUp(
    [
      record({
        startTime: '2026-08-30T21:00:00Z',
        endTime: '2026-08-30T23:00:00Z',
        totalAmount: 2,
        gpuAmount: 2,
        diskAmount: 0,
      }),
    ],
    { timezone: BERLIN, from: new Date('2026-08-01T00:00:00Z'), now },
  )

  assert.equal(round(days.get('2026-08-30')?.totalUsd ?? 0), 1)
  assert.equal(round(days.get('2026-08-31')?.totalUsd ?? 0), 1)
})

test('an hourly bucket in a half-hour timezone is split, not attributed whole', () => {
  // Asia/Kolkata is UTC+5:30. The 18:00–19:00Z bucket is 23:30–00:30 local, so
  // exactly half of it belongs to the next day. Attributing by `startTime`
  // would put all of it on the earlier day, every day, in that zone.
  const now = new Date('2026-08-31T23:00:00Z')
  const { days } = rollUp(
    [
      record({
        startTime: '2026-08-30T18:00:00Z',
        endTime: '2026-08-30T19:00:00Z',
        totalAmount: 1,
        gpuAmount: 1,
        diskAmount: 0,
      }),
    ],
    { timezone: KOLKATA, from: new Date('2026-08-01T00:00:00Z'), now },
  )

  assert.equal(round(days.get('2026-08-30')?.totalUsd ?? 0), 0.5)
  assert.equal(round(days.get('2026-08-31')?.totalUsd ?? 0), 0.5)
})

test('day buckets still land on the right local days, so a coarser bucket degrades instead of lying', () => {
  // `bucketSize` is echoed from the request, not from behaviour — exactly like
  // `from`, which is silently ignored. If hourly ever stops being honoured, the
  // chart should get coarser, not wrong.
  const now = new Date('2026-08-31T23:00:00Z')
  const { days } = rollUp(
    [
      record({
        startTime: '2026-08-30T00:00:00Z',
        endTime: '2026-08-31T00:00:00Z',
        totalAmount: 24,
        gpuAmount: 24,
        diskAmount: 0,
      }),
    ],
    { timezone: BERLIN, from: new Date('2026-08-01T00:00:00Z'), now },
  )

  // A UTC day in Berlin is 02:00–02:00, so two hours belong to the next day.
  assert.equal(round(days.get('2026-08-30')?.totalUsd ?? 0), 22)
  assert.equal(round(days.get('2026-08-31')?.totalUsd ?? 0), 2)
})

test('other is the remainder, so a charge type nobody knows about is still money', () => {
  const now = new Date('2026-08-31T23:00:00Z')
  const { days } = rollUp(
    [record({ totalAmount: 1, gpuAmount: 0.6, diskAmount: 0.1, cpuAmount: 0.05 })],
    { timezone: BERLIN, from: new Date('2026-08-01T00:00:00Z'), now },
  )

  const day = days.get('2026-08-30')
  assert.equal(round(day?.otherUsd ?? 0), 0.3, 'total minus gpu minus disk, not cpuAmount')
  assert.equal(round((day?.gpuUsd ?? 0) + (day?.diskUsd ?? 0) + (day?.otherUsd ?? 0)), 1)
})

test('a bucket that has not closed yet is left to the live estimate', () => {
  // Its amount is partial and its end lies in the future. Counting it as well
  // as estimating the same minutes is how "today" came to be double counted.
  const now = new Date('2026-08-31T12:30:00Z')
  const { totalUsd, billedThrough } = rollUp(
    [
      record({ startTime: '2026-08-31T11:00:00Z', endTime: '2026-08-31T12:00:00Z', totalAmount: 1 }),
      record({ startTime: '2026-08-31T12:00:00Z', endTime: '2026-08-31T13:00:00Z', totalAmount: 0.4 }),
    ],
    { timezone: BERLIN, from: new Date('2026-08-01T00:00:00Z'), now },
  )

  assert.equal(totalUsd, 1, 'only the closed hour is billed')
  assert.equal(
    billedThrough.get('p1'),
    Date.parse('2026-08-31T12:00:00Z'),
    'and the seam sits at the end of that hour',
  )
})

test('a bucket beginning before the window contributes only its tail', () => {
  const now = new Date('2026-09-01T12:00:00Z')
  // 22:00Z on 31 August is midnight in Berlin, so half of this two-hour bucket
  // falls in September.
  const { totalUsd } = rollUp(
    [
      record({
        startTime: '2026-08-31T21:00:00Z',
        endTime: '2026-08-31T23:00:00Z',
        totalAmount: 2,
      }),
    ],
    { timezone: BERLIN, from: startOfLocalMonth(now, BERLIN), now },
  )

  assert.equal(round(totalUsd), 1)
})

test('spend is attributed per pod, which is what makes a breakdown possible', () => {
  const now = new Date('2026-08-31T23:00:00Z')
  const { byPod } = rollUp(
    [
      record({ podId: 'ours', totalAmount: 3 }),
      record({ podId: 'theirs', totalAmount: 5 }),
      record({ podId: 'ours', totalAmount: 1 }),
    ],
    { timezone: BERLIN, from: new Date('2026-08-01T00:00:00Z'), now },
  )

  assert.equal(byPod.get('ours'), 4)
  assert.equal(byPod.get('theirs'), 5)
})

test('local midnight is the one in force at midnight, not the one in force now', () => {
  // Berlin gives up daylight saving on 25 October 2026 at 03:00 local. Asking
  // on the 26th, the offset now is +1 but the offset at the 25th's midnight was
  // +2 — a single-pass calculation lands an hour out and moves a day's spend.
  assert.equal(
    startOfLocalDay(new Date('2026-10-25T12:00:00Z'), BERLIN).toISOString(),
    '2026-10-24T22:00:00.000Z',
  )
  assert.equal(
    startOfLocalDay(new Date('2026-10-26T12:00:00Z'), BERLIN).toISOString(),
    '2026-10-25T23:00:00.000Z',
  )
})

test('the month starts at local midnight, west of Greenwich too', () => {
  // New York is UTC-4 in September, so the month begins at 04:00Z on the 1st.
  assert.equal(
    startOfLocalMonth(new Date('2026-09-15T12:00:00Z'), NEW_YORK).toISOString(),
    '2026-09-01T04:00:00.000Z',
  )
  assert.equal(
    startOfLocalMonth(new Date('2026-09-15T12:00:00Z'), BERLIN).toISOString(),
    '2026-08-31T22:00:00.000Z',
  )
})

test('the day series crosses a daylight saving change without repeating or skipping one', () => {
  const days = localDaysBetween(
    new Date('2026-10-23T12:00:00Z'),
    new Date('2026-10-27T12:00:00Z'),
    BERLIN,
  )
  assert.deepEqual(days, [
    '2026-10-23',
    '2026-10-24',
    '2026-10-25',
    '2026-10-26',
    '2026-10-27',
  ])
})

test('on the first of the month the series is one day long', () => {
  const now = new Date('2026-09-01T08:00:00Z')
  const days = localDaysBetween(startOfLocalMonth(now, BERLIN), now, BERLIN)
  assert.deepEqual(days, ['2026-09-01'])
})

test('the local day of an instant is the user day, not the server day', () => {
  // 23:30 in New York is already tomorrow in UTC. This is the whole reason the
  // timezone belongs to the settings rather than to the container.
  const instant = new Date('2026-08-31T03:30:00Z')
  assert.equal(localDayKey(instant, NEW_YORK), '2026-08-30')
  assert.equal(localDayKey(instant, BERLIN), '2026-08-31')
})
