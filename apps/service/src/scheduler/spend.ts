import type { RunpodClient } from '../runpod/client.js'
import type { Db } from '../store/db.js'

/**
 * What has been spent today and this month.
 *
 * Two sources, because neither is enough alone. RunPod's billing endpoint gives
 * real amounts but is bucketed per day, so the current run does not appear
 * until after midnight — a limit relying on it alone would never fire on the
 * day it matters. The running pod's own hourly rate covers that gap.
 *
 * The result is therefore billed-to-date plus an estimate of the run in flight.
 */
export interface SpendSnapshot {
  todayUsd: number
  monthUsd: number
  /** How much of the figure is estimated rather than billed. */
  estimatedUsd: number
  fetchedAt: Date
}

const CACHE_MS = 5 * 60_000

export class SpendTracker {
  private cache: { snapshot: SpendSnapshot; billedToday: number; billedMonth: number } | null = null

  constructor(
    private readonly db: Db,
    private readonly runpod: () => RunpodClient,
    private readonly timezone: () => string,
  ) {}

  /**
   * Current spend. Billing is refetched at most every five minutes; the live
   * portion is recomputed on every call, since that is the part that moves.
   */
  async snapshot(now: Date = new Date()): Promise<SpendSnapshot> {
    const stale = !this.cache || now.getTime() - this.cache.snapshot.fetchedAt.getTime() > CACHE_MS
    if (stale) await this.refreshBilled(now)

    const billedToday = this.cache?.billedToday ?? 0
    const billedMonth = this.cache?.billedMonth ?? 0
    const live = this.liveRunCost(now)

    return {
      todayUsd: billedToday + live,
      monthUsd: billedMonth + live,
      estimatedUsd: live,
      fetchedAt: this.cache?.snapshot.fetchedAt ?? now,
    }
  }

  private async refreshBilled(now: Date): Promise<void> {
    const from = startOfMonth(now, this.timezone())
    try {
      const { records } = await this.runpod().listPodBilling({ from: from.toISOString() })
      const dayKey = localDayKey(now, this.timezone())

      let today = 0
      let month = 0
      for (const record of records) {
        const amount = Number((record as { totalAmount?: number }).totalAmount ?? 0)
        month += amount
        const start = (record as { startTime?: string }).startTime
        if (start && localDayKey(new Date(start), this.timezone()) === dayKey) today += amount
      }
      this.cache = {
        snapshot: { todayUsd: today, monthUsd: month, estimatedUsd: 0, fetchedAt: now },
        billedToday: today,
        billedMonth: month,
      }
    } catch {
      // A billing outage must not disable the limits. Keeping the last known
      // figures means the estimate still grows and a cap can still fire; only
      // the historical part goes stale.
      if (!this.cache) {
        this.cache = {
          snapshot: { todayUsd: 0, monthUsd: 0, estimatedUsd: 0, fetchedAt: now },
          billedToday: 0,
          billedMonth: 0,
        }
      }
    }
  }

  /** Cost of the run currently in progress, which billing has not booked yet. */
  private liveRunCost(now: Date): number {
    const row = this.db
      .prepare(
        `SELECT cost_per_hour AS rate, started_at AS startedAt
         FROM pods WHERE stopped_at IS NULL AND status = 'RUNNING'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { rate: number; startedAt: string | null } | undefined

    if (!row?.startedAt) return 0
    const hours = (now.getTime() - new Date(row.startedAt).getTime()) / 3_600_000
    return Math.max(0, hours) * row.rate
  }
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

/** Midnight on the first of the month, in the user's timezone. */
export function startOfMonth(instant: Date, timeZone: string): Date {
  const [year = '1970', month = '01'] = localDayKey(instant, timeZone).split('-')
  // Reaching back a day covers the offset between the zone and UTC, so the
  // first hours of the month are never missed.
  const utcFirst = new Date(`${year}-${month}-01T00:00:00Z`)
  return new Date(utcFirst.getTime() - 24 * 3_600_000)
}
