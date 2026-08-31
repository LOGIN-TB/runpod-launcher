/**
 * Folding RunPod's billing records into the numbers we show and enforce.
 *
 * Pure on purpose: no database, no network, no clock. Every awkward case here —
 * a bucket straddling local midnight, a timezone at half past the hour, a
 * daylight-saving transition, a charge type RunPod has not invented yet — is a
 * few lines of arithmetic that deserve tests, and none of them need a pod.
 *
 * The reason this exists at all is that `spend.ts` used to reduce the whole
 * response to two numbers and throw the rest away. The response carries one
 * record per pod per time bucket, split into GPU, disk and CPU — which is
 * everything needed to say where the money went.
 */

/** One billing record, as `GET /v2/billing/pods` returns it. */
export interface BillingRecord {
  podId: string
  /** Half-open bucket `[startTime, endTime)`, RFC 3339. */
  startTime: string
  endTime: string
  totalAmount: number
  gpuAmount?: number
  diskAmount?: number
  cpuAmount?: number
}

/** What one local day cost, split the way RunPod splits it. */
export interface DayCost {
  /** `YYYY-MM-DD` in the configured timezone. */
  day: string
  gpuUsd: number
  diskUsd: number
  /**
   * Everything that is neither GPU nor disk.
   *
   * A remainder rather than `cpuAmount`, so a charge type RunPod adds later
   * shows up as money instead of quietly disappearing from the total.
   */
  otherUsd: number
  totalUsd: number
}

export interface RollUp {
  /** Only the days that cost something; the caller fills the gaps. */
  days: Map<string, DayCost>
  /** Pod id → what it was billed inside the window. */
  byPod: Map<string, number>
  /**
   * Pod id → the end of its latest completed bucket, in ms.
   *
   * This is the seam between "billed" and "estimated". Without it the live
   * estimate covers time RunPod has already charged for, and the figure the
   * spend caps read is inflated — measured on a real account, by about an hour
   * and a half of GPU time at any moment.
   */
  billedThrough: Map<string, number>
  totalUsd: number
}

/**
 * Sums the records that fall inside `[from, now)`.
 *
 * Buckets that have not closed yet are skipped entirely: their amount is
 * partial and their `endTime` lies in the future, so counting them would double
 * up with the live estimate that covers the same minutes.
 */
export function rollUp(
  records: readonly BillingRecord[],
  window: { timezone: string; from: Date; now: Date },
): RollUp {
  const days = new Map<string, DayCost>()
  const byPod = new Map<string, number>()
  const billedThrough = new Map<string, number>()
  let totalUsd = 0

  for (const record of records) {
    const start = Date.parse(record.startTime)
    const end = Date.parse(record.endTime)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue

    // Not closed yet — the live estimate speaks for these minutes.
    if (end > window.now.getTime()) continue

    const from = Math.max(start, window.from.getTime())
    if (from >= end) continue

    const total = Number(record.totalAmount) || 0
    const gpu = Number(record.gpuAmount) || 0
    const disk = Number(record.diskAmount) || 0
    // Clamped: rounding in RunPod's own figures can make the parts exceed the
    // total by a fraction of a cent, and a negative "other" reads as nonsense.
    const other = Math.max(0, total - gpu - disk)

    // The share of the bucket that lies inside the window, so a bucket that
    // begins before the first of the month contributes only its tail.
    const inWindow = (end - from) / (end - start)

    totalUsd += total * inWindow
    byPod.set(record.podId, (byPod.get(record.podId) ?? 0) + total * inWindow)
    billedThrough.set(record.podId, Math.max(billedThrough.get(record.podId) ?? 0, end))

    // Spread across the local days the bucket touches, in proportion to how
    // much of it each day holds.
    //
    // Attributing the whole bucket to the day of its `startTime` would be
    // wrong wherever a bucket boundary is not also a local midnight — most
    // obviously in Asia/Kolkata at UTC+5:30, where an hourly bucket straddles
    // midnight twice a day. It would also turn a silently-ignored `bucketSize`
    // into a wrong chart rather than a coarse one.
    for (const slice of localDaySlices(from, end, window.timezone)) {
      const share = slice.ms / (end - from)
      const existing = days.get(slice.day) ?? {
        day: slice.day,
        gpuUsd: 0,
        diskUsd: 0,
        otherUsd: 0,
        totalUsd: 0,
      }
      existing.gpuUsd += gpu * inWindow * share
      existing.diskUsd += disk * inWindow * share
      existing.otherUsd += other * inWindow * share
      existing.totalUsd += total * inWindow * share
      days.set(slice.day, existing)
    }
  }

  return { days, byPod, billedThrough, totalUsd }
}

/** How many milliseconds of `[from, to)` fall on each local day it touches. */
function localDaySlices(from: number, to: number, timeZone: string): Array<{ day: string; ms: number }> {
  const slices: Array<{ day: string; ms: number }> = []
  let cursor = from
  // Bounded by construction — each step advances to the next local midnight —
  // but a bucket is at most a day or two, so this loop runs once or twice.
  while (cursor < to) {
    const day = localDayKey(new Date(cursor), timeZone)
    const nextMidnight = startOfLocalDay(new Date(cursor + 24 * 3_600_000), timeZone).getTime()
    // Guards against a zone whose offset change makes the "next" midnight land
    // at or before the cursor; without it this would not terminate.
    const boundary = nextMidnight > cursor ? Math.min(nextMidnight, to) : to
    slices.push({ day, ms: boundary - cursor })
    cursor = boundary
  }
  return slices
}

/**
 * Every local day from `from` to `now`, in order, including the empty ones.
 *
 * Advancing by local midnights rather than by 24 hours, because a daylight
 * saving transition makes one day 23 or 25 hours long — adding a fixed day
 * would duplicate or skip a date exactly twice a year.
 */
export function localDaysBetween(from: Date, now: Date, timeZone: string): string[] {
  const days: string[] = []
  let cursor = startOfLocalDay(from, timeZone)
  const last = localDayKey(now, timeZone)

  // The bound is a safety net, not the exit: a month has 31 days and the loop
  // stops on the key. Without it a bad timezone could spin forever.
  for (let guard = 0; guard < 400; guard += 1) {
    const key = localDayKey(cursor, timeZone)
    days.push(key)
    if (key === last) break
    const next = startOfLocalDay(new Date(cursor.getTime() + 36 * 3_600_000), timeZone)
    if (next.getTime() <= cursor.getTime()) break
    cursor = next
  }
  return days
}

/** `YYYY-MM-DD` in the user's timezone, so "today" means their today. */
export function localDayKey(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

/**
 * How far ahead of UTC the zone is at that instant, in milliseconds.
 *
 * Read out of `Intl` rather than from a table, so it is right across daylight
 * saving and for the zones that sit at half or quarter past the hour.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant)

  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0')

  // `hour12: false` yields 24 for midnight in some engines.
  const asUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour') % 24,
    value('minute'),
    value('second'),
  )
  return asUtc - instant.getTime()
}

/**
 * Local midnight of the day that instant falls on.
 *
 * Two passes, because the offset to subtract is the one in force *at midnight*,
 * not the one in force now — they differ on the two days a year the clocks
 * change, which is exactly when a wrong answer moves a day's spend.
 */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  const [year = 1970, month = 1, day = 1] = localDayKey(instant, timeZone).split('-').map(Number)
  const wallClock = Date.UTC(year, month - 1, day)
  const guess = new Date(wallClock - zoneOffsetMs(instant, timeZone))
  return new Date(wallClock - zoneOffsetMs(guess, timeZone))
}

/** Local midnight on the first of the month that instant falls in. */
export function startOfLocalMonth(instant: Date, timeZone: string): Date {
  const [year = 1970, month = 1] = localDayKey(instant, timeZone).split('-').map(Number)
  const wallClock = Date.UTC(year, month - 1, 1)
  const guess = new Date(wallClock - zoneOffsetMs(instant, timeZone))
  return new Date(wallClock - zoneOffsetMs(guess, timeZone))
}
