import type { SpendDay, SpendReport, SpendShare } from '@runpod-launcher/shared'
import type { RunpodClient } from '../runpod/client.js'
import type { Db } from '../store/db.js'
import {
  localDayKey,
  localDaysBetween,
  rollUp,
  startOfLocalDay,
  startOfLocalMonth,
  type BillingRecord,
  type RollUp,
} from './spend-report.js'

export { localDayKey, startOfLocalDay, startOfLocalMonth }

/**
 * What has been spent today and this month.
 *
 * Two sources, because neither is enough alone. RunPod's billing lags reality —
 * measured on a live account, by about an hour and a half — so a limit relying
 * on it alone would fire late. The running pods' own hourly rate covers exactly
 * that gap and no more: the seam is each pod's latest closed billing bucket, so
 * the estimate never covers minutes that have already been charged.
 *
 * Getting that seam wrong is not cosmetic. It used to be `started_at`, which
 * assumed same-day cost had not been booked yet — it has — so every already
 * billed hour was estimated a second time, and the spend caps read an inflated
 * figure and fired early.
 */
export interface SpendSnapshot {
  todayUsd: number
  monthUsd: number
  /** How much of today's figure is estimated rather than billed. */
  estimatedUsd: number
  /** The same for the month, which is a different window and so a different number. */
  estimatedMonthUsd: number
  /** When billing was last read successfully, or null if it never has been. */
  fetchedAt: Date | null
  /** True when the last billing read failed and these are the previous figures. */
  stale: boolean
}

const CACHE_MS = 5 * 60_000
/**
 * How long to wait before trying billing again after a failure.
 *
 * Without it a RunPod outage was retried on every single call: the cache was
 * left untouched on error, so it read as expired immediately, and between the
 * scheduler's minute and the app's thirty seconds that is a request storm
 * aimed at an endpoint that is already unwell.
 */
const RETRY_MS = 60_000

/** Pods RunPod charges for. A pod is billed from the moment it is created. */
const BILLED_STATES = "('RUNNING', 'STARTING', 'PROVISIONING')"

interface Cache {
  /**
   * The records themselves, not sums.
   *
   * Sums had to be recomputed to answer any new question, and one of them was
   * quietly wrong: `billedToday` was calculated against the day it was fetched
   * and then reused for five minutes, so just after local midnight the daily
   * cap was compared against yesterday's spend.
   *
   * Keeping records also makes the timezone a display concern: changing it
   * re-cuts the days without another request.
   */
  records: BillingRecord[]
  /**
   * When billing was last read **successfully**, or null if it never has been.
   *
   * Not "when we last tried". Setting this on a failure made the outage look
   * like a fresh answer, so the retry gate below never got a turn and the
   * figures stayed frozen for five minutes at a time.
   */
  succeededAt: Date | null
  lastAttemptAt: Date
  failed: boolean
}

export class SpendTracker {
  private cache: Cache | null = null
  /** One request at a time, however many callers ask at once. */
  private inFlight: Promise<void> | null = null
  /** The last fold, so thirty-second polling does not re-add thousands of records. */
  private folded: { key: string; month: RollUp; today: RollUp } | null = null

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
    const { month, today } = await this.folds(now)
    const timezone = this.timezone()

    const dayStart = startOfLocalDay(now, timezone)
    const monthStart = startOfLocalMonth(now, timezone)
    const liveToday = this.liveCost(now, dayStart, month.billedThrough)
    const liveMonth = this.liveCost(now, monthStart, month.billedThrough)

    return {
      todayUsd: today.totalUsd + liveToday,
      monthUsd: month.totalUsd + liveMonth,
      estimatedUsd: liveToday,
      estimatedMonthUsd: liveMonth,
      fetchedAt: this.cache?.succeededAt ?? null,
      stale: this.cache?.failed ?? true,
    }
  }

  /**
   * The same money, broken down: per day and per template.
   *
   * Derived from the same cached records as `snapshot()`, deliberately. Two
   * requests would give two answers — 15.6205 against 15.6579 on a real
   * account, the difference being the hour in progress — and a cap firing on
   * one figure while the screen shows the other is not defensible.
   */
  async report(now: Date = new Date()): Promise<SpendReport> {
    const snapshot = await this.snapshot(now)
    const { month } = await this.folds(now)
    const timezone = this.timezone()

    const todayKey = localDayKey(now, timezone)
    const days: SpendDay[] = localDaysBetween(startOfLocalMonth(now, timezone), now, timezone).map(
      (day) => {
        const found = month.days.get(day)
        return {
          day,
          gpuUsd: found?.gpuUsd ?? 0,
          diskUsd: found?.diskUsd ?? 0,
          otherUsd: found?.otherUsd ?? 0,
          // Today carries the unbilled estimate as well, or the bars would not
          // add up to the headline figure.
          totalUsd: (found?.totalUsd ?? 0) + (day === todayKey ? snapshot.estimatedUsd : 0),
          partial: day === todayKey,
        }
      },
    )

    return {
      timezone,
      todayUsd: snapshot.todayUsd,
      monthUsd: snapshot.monthUsd,
      dailyLimitUsd: null,
      monthlyLimitUsd: null,
      estimatedUsd: snapshot.estimatedUsd,
      ratePerHourUsd: this.currentRate(),
      days,
      shares: this.shares(month, snapshot.estimatedMonthUsd),
      fetchedAt: snapshot.fetchedAt?.toISOString() ?? null,
      stale: snapshot.stale,
      scope: 'pods',
    }
  }

  /**
   * Who spent it, largest first.
   *
   * Three kinds, and the third is the one that matters: on a real account most
   * of the bill can be pods this launcher never created. Leaving them out would
   * make a breakdown that does not add up to the figure on the invoice — 61% of
   * it missing, in the case that prompted this.
   */
  private shares(month: RollUp, estimatedMonthUsd: number): SpendShare[] {
    const known = new Map(
      (
        this.db
          .prepare(
            `SELECT p.id AS podId, p.template_id AS templateId, t.name AS name
             FROM pods p LEFT JOIN templates t ON t.id = p.template_id`,
          )
          .all() as Array<{ podId: string; templateId: string | null; name: string | null }>
      ).map((row) => [row.podId, row]),
    )

    const byKey = new Map<string, SpendShare>()
    const add = (key: string, share: Omit<SpendShare, 'usd'>, usd: number): void => {
      const existing = byKey.get(key) ?? { ...share, usd: 0 }
      existing.usd += usd
      byKey.set(key, existing)
    }

    for (const [podId, usd] of month.byPod) {
      const row = known.get(podId)
      if (!row) {
        add('foreign', { templateId: null, name: 'foreign', kind: 'foreign' }, usd)
      } else if (row.templateId === null) {
        // `ON DELETE SET NULL` on the template reference, so a null id here
        // reliably means the template was deleted. Its name went with it, and
        // every deleted template lands in one group.
        add('deleted', { templateId: null, name: 'deleted', kind: 'deleted' }, usd)
      } else {
        add(row.templateId, { templateId: row.templateId, name: row.name ?? row.templateId, kind: 'template' }, usd)
      }
    }

    // The unbilled part belongs to whatever is running now, and the pods
    // running now are ours by definition — a foreign pod has no record here.
    for (const [templateId, usd] of this.unbilledByTemplate(estimatedMonthUsd)) {
      const row = byKey.get(templateId)
      if (row) row.usd += usd
      else add(templateId, { templateId, name: this.templateName(templateId), kind: 'template' }, usd)
    }

    return [...byKey.values()].filter((share) => share.usd > 0).sort((a, b) => b.usd - a.usd)
  }

  /** Splits the unbilled estimate across the templates whose pods are running. */
  private unbilledByTemplate(total: number): Map<string, number> {
    const split = new Map<string, number>()
    if (total <= 0) return split

    const rows = this.db
      .prepare(
        `SELECT template_id AS templateId, cost_per_hour AS rate
         FROM pods WHERE stopped_at IS NULL AND status IN ${BILLED_STATES} AND template_id IS NOT NULL`,
      )
      .all() as Array<{ templateId: string; rate: number }>

    const rateSum = rows.reduce((sum, row) => sum + row.rate, 0)
    if (rateSum <= 0) return split
    for (const row of rows) {
      split.set(row.templateId, (split.get(row.templateId) ?? 0) + (total * row.rate) / rateSum)
    }
    return split
  }

  private templateName(templateId: string): string {
    const row = this.db.prepare('SELECT name FROM templates WHERE id = ?').get(templateId) as
      | { name: string }
      | undefined
    return row?.name ?? templateId
  }

  /** RunPod's reported hourly rate for everything running right now. */
  private currentRate(): number {
    const rows = this.db
      .prepare(
        `SELECT cost_per_hour AS rate FROM pods
         WHERE stopped_at IS NULL AND status IN ${BILLED_STATES}`,
      )
      .all() as Array<{ rate: number }>
    return rows.reduce((sum, row) => sum + row.rate, 0)
  }

  /** The month and today folds, refetching billing only when it is stale. */
  private async folds(now: Date): Promise<{ month: RollUp; today: RollUp }> {
    await this.ensureBilled(now)
    const timezone = this.timezone()

    // Keyed on what the answer depends on: when the records were read, which
    // timezone cuts them, and which local day it is. A timezone change
     // therefore re-cuts immediately without another request.
    const key = `${this.cache?.succeededAt?.getTime() ?? 0}|${timezone}|${localDayKey(now, timezone)}`
    if (this.folded?.key === key) return this.folded

    const records = this.cache?.records ?? []
    const month = rollUp(records, { timezone, from: startOfLocalMonth(now, timezone), now })
    const today = rollUp(records, { timezone, from: startOfLocalDay(now, timezone), now })
    this.folded = { key, month, today }
    return this.folded
  }

  private async ensureBilled(now: Date): Promise<void> {
    const cache = this.cache
    const age = cache?.succeededAt ? now.getTime() - cache.succeededAt.getTime() : Infinity
    const sinceAttempt = cache ? now.getTime() - cache.lastAttemptAt.getTime() : Infinity

    if (age <= CACHE_MS) return
    // After a failure, wait before trying again rather than on every call.
    if (cache?.failed && sinceAttempt < RETRY_MS) return

    this.inFlight ??= this.refreshBilled(now).finally(() => {
      this.inFlight = null
    })
    await this.inFlight
  }

  private async refreshBilled(now: Date): Promise<void> {
    const timezone = this.timezone()
    // Sent even though RunPod ignores it, so a future fix helps rather than
    // truncates. The filtering that actually matters happens in `rollUp`.
    const from = startOfLocalMonth(now, timezone)

    try {
      const { records } = await this.runpod().listPodBilling({
        from: from.toISOString(),
        bucketSize: 'hour',
      })

      // Only what the window can still need. One record per pod per hour and no
      // working range filter means the response grows with the age of the
      // account; retaining all of it would grow memory with it.
      const horizon = from.getTime() - 48 * 3_600_000
      const kept = (records as unknown as BillingRecord[]).filter(
        (record) => Date.parse(record.endTime) > horizon,
      )

      this.cache = { records: kept, succeededAt: now, lastAttemptAt: now, failed: false }
      this.folded = null
    } catch {
      // A billing outage must not disable the limits. The last known figures
      // stay, so the estimate still grows and a cap can still fire; only the
      // historical part goes stale, and it says so.
      this.cache = {
        records: this.cache?.records ?? [],
        succeededAt: this.cache?.succeededAt ?? null,
        lastAttemptAt: now,
        failed: true,
      }
    }
  }

  /**
   * Cost of the running pods that billing has not booked yet.
   *
   * From each pod's own seam, which is the latest of three things: the end of
   * its last closed billing bucket, its start, and the start of the window
   * being asked about.
   *
   * All three are needed. Without the bucket end, already billed hours are
   * counted twice. Without the pod's start, a pod created ten minutes ago is
   * charged from another pod's seam. And `started_at` alone is not enough
   * either, because it is not re-stamped when a pod is resumed — a pod created
   * on the 1st and resumed on the 20th would otherwise report nineteen days of
   * "live" cost.
   */
  private liveCost(now: Date, windowStart: Date, billedThrough: Map<string, number>): number {
    const rows = this.db
      .prepare(
        `SELECT id, cost_per_hour AS rate, started_at AS startedAt
         FROM pods WHERE stopped_at IS NULL AND status IN ${BILLED_STATES}`,
      )
      .all() as Array<{ id: string; rate: number; startedAt: string | null }>

    return rows.reduce((total, row) => {
      if (!row.startedAt) return total
      const seam = Math.max(
        Date.parse(row.startedAt),
        billedThrough.get(row.id) ?? 0,
        windowStart.getTime(),
      )
      const hours = (now.getTime() - seam) / 3_600_000
      return total + Math.max(0, hours) * row.rate
    }, 0)
  }
}
