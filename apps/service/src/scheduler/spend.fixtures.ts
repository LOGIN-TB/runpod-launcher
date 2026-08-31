import { openDatabase } from '../store/db.js'
import { RunpodClient } from '../runpod/client.js'
import { SpendTracker } from './spend.js'
import type { BillingRecord } from './spend-report.js'

/**
 * Shared setup for the spend tests.
 *
 * In its own file rather than in `spend.test.ts`, because `npm test` runs
 * `dist/**\/*.test.js` — importing one test file from another would run its
 * tests a second time, under the wrong name.
 */

/** A billing record with only the interesting field spelled out. */
export const billed = (over: Partial<BillingRecord> & { totalAmount: number }): BillingRecord => {
  const startTime = over.startTime ?? '2026-09-01T00:00:00Z'
  return {
    podId: 'p1',
    startTime,
    // An hour long unless said otherwise, matching `bucketSize=hour`.
    endTime: over.endTime ?? new Date(Date.parse(startTime) + 3_600_000).toISOString(),
    gpuAmount: over.totalAmount,
    diskAmount: 0,
    ...over,
  }
}

/**
 * A RunPod stub that answers the billing endpoint.
 *
 * Faithful to the real thing in the way that matters: it **ignores** `from` and
 * `to`, because RunPod does — verified against three different ranges, all
 * returning the account's whole history. Code that relies on those parameters
 * has to fail here too.
 */
export const billingStub = (records: readonly BillingRecord[]): typeof fetch =>
  (async (url: unknown) => {
    const target = String(url)
    if (!target.includes('/billing/pods')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const bucketSize = new URL(target).searchParams.get('bucketSize') ?? 'day'
    return new Response(JSON.stringify({ metadata: { query: { bucketSize } }, records }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

/** A stub that always fails, for the outage cases. */
export const failingBilling = (onCall?: () => void): typeof fetch =>
  (async () => {
    onCall?.()
    return new Response('nope', { status: 500 })
  }) as unknown as typeof fetch

export interface FixturePod {
  id?: string
  rate: number
  startedAt: string
  status?: 'RUNNING' | 'STARTING' | 'PROVISIONING' | 'EXITED'
  stoppedAt?: string
  templateId?: string
}

/** A tracker over an in-memory database, with whatever pods the test needs. */
export const trackerWith = (
  records: readonly BillingRecord[],
  pods: FixturePod[] = [],
  options: { timezone?: string; fetchImpl?: typeof fetch } = {},
): { tracker: SpendTracker; db: ReturnType<typeof openDatabase> } => {
  const db = openDatabase(':memory:')

  const templates = new Set(pods.map((pod) => pod.templateId).filter((id) => id !== undefined))
  for (const id of templates) {
    db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, `template-${id}`, '{}', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')
  }

  for (const [index, pod] of pods.entries()) {
    db.prepare(
      `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, started_at, stopped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      pod.id ?? `p${index + 1}`,
      pod.templateId ?? null,
      pod.status ?? 'RUNNING',
      pod.rate,
      pod.startedAt,
      pod.startedAt,
      pod.stoppedAt ?? null,
    )
  }

  const fetchImpl = options.fetchImpl ?? billingStub(records)
  return {
    db,
    tracker: new SpendTracker(
      db,
      () => new RunpodClient('key', fetchImpl),
      () => options.timezone ?? 'Europe/Berlin',
    ),
  }
}
