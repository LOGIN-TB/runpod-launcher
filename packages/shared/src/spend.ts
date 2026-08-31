/**
 * The shape of the cost report, shared by the service and the app.
 *
 * Declared here rather than duplicated in the app's own `api.ts` — which is how
 * `SpendSnapshot` is handled — because this one is far too big to keep in step
 * by hand. Five scalars can be copied; a series, a breakdown and their units
 * cannot.
 */

/** What one local day cost, split the way RunPod splits it. */
export interface SpendDay {
  /** `YYYY-MM-DD` in the report's timezone. Never parse this with `new Date`. */
  day: string
  gpuUsd: number
  /**
   * Storage. The reason a launcher that is "switched off" still costs money:
   * a stopped pod keeps its disk, and RunPod keeps charging for it.
   */
  diskUsd: number
  /** Everything else, as a remainder, so a new charge type is still visible. */
  otherUsd: number
  totalUsd: number
  /** True for today, whose figure is partly the launcher's own arithmetic. */
  partial: boolean
}

/** What one template — or one group of pods — cost over the window. */
export interface SpendShare {
  /** Null for pods this launcher did not create, and for deleted templates. */
  templateId: string | null
  name: string
  usd: number
  /**
   * Which group this is, so the app can label it rather than guess from the id.
   *
   * `foreign` matters: on a real account most of the bill can be pods the
   * launcher never touched, and a breakdown that hides them does not add up to
   * the total anybody recognises.
   */
  kind: 'template' | 'deleted' | 'foreign'
}

export interface SpendReport {
  /** The timezone the days are cut on, from the settings. */
  timezone: string
  todayUsd: number
  monthUsd: number
  dailyLimitUsd: number | null
  monthlyLimitUsd: number | null
  /** Today's spend that is not yet billed — the launcher's own arithmetic. */
  estimatedUsd: number
  /** RunPod's reported hourly rate for everything running right now. */
  ratePerHourUsd: number
  /** From the first of the local month to today, with the empty days present. */
  days: SpendDay[]
  /** Largest first. Sums to `monthUsd` minus the unbilled estimate. */
  shares: SpendShare[]
  /**
   * When the billing figures were last read successfully, or null if never.
   *
   * Null rather than "now": claiming a timestamp while also saying the figures
   * are stale is a contradiction, and the honest answer to "as of when?" before
   * the first successful read is "there has not been one".
   */
  fetchedAt: string | null
  /** True when that read failed and these are the previous figures. */
  stale: boolean
  /**
   * Pods only.
   *
   * `GET /v2/billing/pods` does not cover network volumes or serverless, and a
   * network volume bills while every pod is stopped. Said here so the app can
   * say it too, rather than quietly disagreeing with the RunPod invoice.
   */
  scope: 'pods'
}
