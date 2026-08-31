import type { ReactNode } from 'react'
import type { MessageKey } from '@runpod-launcher/i18n'
import { api, type Connection } from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { Button, Card } from './primitives.js'
import { LimitGauge } from './charts.js'
import { useCached } from '../lib/cached.js'

const POLL_MS = 30_000

/**
 * Spending, at the size the overview can afford.
 *
 * Two gauges and the current hourly rate, because that is the question this
 * screen is for. The month of days, the breakdown and the limits live on the
 * cost screen, where there is room for them.
 *
 * The estimated share is called out rather than folded in. RunPod's billing runs
 * about an hour behind, so the most recent minutes are the launcher's own
 * arithmetic — presenting that as a billed figure would be a small lie that
 * surfaces later as a discrepancy nobody can explain.
 */
export function SpendPanel({
  connection,
  onGoToCosts,
}: {
  connection: Connection
  onGoToCosts: () => void
}): ReactNode {
  const { t, money } = useI18n()

  // Cached, so switching away and back does not blank the card out. It used to
  // return null until the first answer arrived — the same empty gap that was
  // just removed from the pod and access lists.
  const report = useCached(`spend-report:${connection.baseUrl}`, () => api.spendReport(connection), {
    pollMs: POLL_MS,
  })
  const decisions = useCached(
    `schedule-preview:${connection.baseUrl}`,
    () => api.schedulePreview(connection).then((r) => r.actions),
    { pollMs: POLL_MS },
  )

  const data = report.data
  if (!data) return null

  return (
    <Card>
      <div className="row space-between">
        <h3>{t('cost.title')}</h3>
        <Button variant="ghost" onClick={onGoToCosts}>
          {t('cost.seeAll')}
        </Button>
      </div>

      <div className="spend-grid">
        <LimitGauge
          label={t('cost.today')}
          valueUsd={data.todayUsd}
          limitUsd={data.dailyLimitUsd}
          estimatedUsd={data.estimatedUsd}
          unsetHint={t('cost.limitUnset')}
        />
        <LimitGauge
          label={t('cost.month')}
          valueUsd={data.monthUsd}
          limitUsd={data.monthlyLimitUsd}
          unsetHint={t('cost.limitUnset')}
        />
      </div>

      <p className="muted small">
        {data.ratePerHourUsd > 0
          ? t('cost.burningNow', { amount: money(data.ratePerHourUsd) })
          : t('cost.burningNothing')}
      </p>

      {/* The scheduler's intentions stay here: they are about pods, and the pods
          are on this screen. */}
      {(decisions.data ?? []).map(({ templateId, templateName, action }) => (
        <p className="muted small" key={templateId}>
          <strong>
            {(decisions.data ?? []).length > 1 ? `${templateName} — ` : ''}
            {t('schedule.nextAction')}:{' '}
          </strong>
          {action.do === 'start'
            ? t('schedule.willStart')
            : action.do === 'stop'
              ? t('schedule.willStop')
              : t('schedule.noChange')}
          {' — '}
          {t(`schedule.reason.${action.because}` as MessageKey)}
        </p>
      ))}
    </Card>
  )
}
