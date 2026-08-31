import type { ReactNode } from 'react'
import { api, type Connection } from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { Card } from '../components/primitives.js'
import { DayBars, LimitGauge, ShareBars } from '../components/charts.js'
import { useCached } from '../lib/cached.js'

const POLL_MS = 60_000

/**
 * Where the money went.
 *
 * Its own screen because the answer needs room: two gauges, a month of days and
 * a breakdown do not belong under a pod list. The overview keeps the two gauges,
 * so the figure is still the first thing visible — a tool that spends money by
 * the hour should never make you go looking for that.
 */
export function Costs({ connection }: { connection: Connection }): ReactNode {
  const { t, money, dateTime } = useI18n()
  const report = useCached(`spend-report:${connection.baseUrl}`, () => api.spendReport(connection), {
    pollMs: POLL_MS,
  })

  if (!report.data) {
    return (
      <Card>
        <h2>{t('cost.title')}</h2>
        <p className="muted small">{report.error ?? t('pods.loading')}</p>
      </Card>
    )
  }

  const data = report.data

  return (
    <div className="stack">
      <Card>
        <h2>{t('cost.title')}</h2>
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
          {data.estimatedUsd > 0 ? ` · ${t('cost.estimated', { amount: money(data.estimatedUsd) })}` : ''}
        </p>
      </Card>

      <Card>
        <h3>{t('cost.perDay')}</h3>
        <DayBars days={data.days} />
      </Card>

      <Card>
        <h3>{t('cost.perTemplate')}</h3>
        <ShareBars shares={data.shares} />
        {/* Said plainly: most of a real account's bill can be pods this launcher
            never created, and the breakdown has to add up to the invoice. */}
        {data.shares.some((share) => share.kind !== 'template') ? (
          <p className="muted small">{t('cost.foreignHint')}</p>
        ) : null}
      </Card>

      <Card>
        <h3>{t('cost.limitsTitle')}</h3>
        <table className="recipes">
          <tbody>
            <tr>
              <th scope="row">{t('cost.dailyLimit')}</th>
              <td>
                {data.dailyLimitUsd === null ? (
                  <span className="field-error">{t('cost.limitUnset')}</span>
                ) : (
                  money(data.dailyLimitUsd)
                )}
              </td>
            </tr>
            <tr>
              <th scope="row">{t('cost.monthlyLimit')}</th>
              <td>
                {data.monthlyLimitUsd === null ? (
                  <span className="field-error">{t('cost.limitUnset')}</span>
                ) : (
                  money(data.monthlyLimitUsd)
                )}
              </td>
            </tr>
          </tbody>
        </table>
        {/* Two honest limits of the figures themselves, next to the limits that
            stop the pods — a cost screen that quietly disagrees with the RunPod
            invoice gets reported as a bug. */}
        <p className="muted small">{t('cost.scopeHint')}</p>
        <p className="muted small">
          {/* No timestamp before the first successful read — saying "as of now"
              while also saying the figures are stale contradicts itself. */}
          {data.fetchedAt === null
            ? t('cost.neverFetched', { zone: data.timezone })
            : t('cost.asOf', { when: dateTime(data.fetchedAt), zone: data.timezone })}
          {data.stale && data.fetchedAt !== null ? ` — ${t('cost.staleHint')}` : ''}
        </p>
      </Card>
    </div>
  )
}
