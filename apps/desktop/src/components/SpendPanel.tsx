import { useEffect, useState, type ReactNode } from 'react'
import type { MessageKey } from '@runpod-launcher/i18n'
import type { PublicSettings } from '@runpod-launcher/shared'
import { api, type Connection, type ScheduledDecision, type SpendSnapshot } from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { Card } from './primitives.js'

const POLL_MS = 30_000

/**
 * Spending, and what the scheduler intends to do about it.
 *
 * The estimated share is called out rather than folded in. RunPod books costs
 * once a day, so the current run is the launcher's own arithmetic — presenting
 * that as a billed figure would be a small lie that shows up later as a
 * discrepancy nobody can explain.
 */
export function SpendPanel({ connection }: { connection: Connection }): ReactNode {
  const { t, money } = useI18n()
  const [spend, setSpend] = useState<SpendSnapshot | null>(null)
  // One entry per template now: each application's pod has its own schedule,
  // so showing a single next action would hide the others.
  const [decisions, setDecisions] = useState<ScheduledDecision[]>([])
  /** The guards themselves, not just how close the spend is to them. */
  const [settings, setSettings] = useState<PublicSettings | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const [nextSpend, preview, nextSettings] = await Promise.all([
        api.spend(connection).catch(() => null),
        api.schedulePreview(connection).catch(() => null),
        api.settings(connection).catch(() => null),
      ])
      if (cancelled) return
      if (nextSpend) setSpend(nextSpend)
      if (nextSettings) setSettings(nextSettings)
      setDecisions(preview?.actions ?? [])
    }
    void load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [connection])

  if (!spend) return null

  return (
    <Card>
      <h3>{t('cost.title')}</h3>

      <div className="spend-grid">
        <Amount
          label={t('cost.today')}
          value={money(spend.todayUsd)}
          limit={spend.dailyLimitUsd === null ? t('cost.noLimit') : t('cost.limitOf', { amount: money(spend.dailyLimitUsd) })}
          over={spend.dailyLimitUsd !== null && spend.todayUsd >= spend.dailyLimitUsd}
        />
        <Amount
          label={t('cost.month')}
          value={money(spend.monthUsd)}
          limit={spend.monthlyLimitUsd === null ? t('cost.noLimit') : t('cost.limitOf', { amount: money(spend.monthlyLimitUsd) })}
          over={spend.monthlyLimitUsd !== null && spend.monthUsd >= spend.monthlyLimitUsd}
        />
      </div>

      {spend.estimatedUsd > 0 ? (
        <p className="muted small">{t('cost.estimated', { amount: money(spend.estimatedUsd) })}</p>
      ) : null}

      {/* The guards themselves, spelled out.
          Reading them off the amounts above only works while a limit exists;
          with none set, the interesting fact is that nothing would stop a pod
          left running, and that deserves saying rather than a dash. */}
      <table className="recipes">
        <tbody>
          <tr>
            <th scope="row">{t('cost.dailyLimit')}</th>
            <td>
              {spend.dailyLimitUsd === null ? (
                <span className="field-error">{t('cost.limitUnset')}</span>
              ) : (
                money(spend.dailyLimitUsd)
              )}
            </td>
          </tr>
          <tr>
            <th scope="row">{t('cost.monthlyLimit')}</th>
            <td>
              {spend.monthlyLimitUsd === null ? (
                <span className="field-error">{t('cost.limitUnset')}</span>
              ) : (
                money(spend.monthlyLimitUsd)
              )}
            </td>
          </tr>
          {settings ? (
            <tr>
              <th scope="row">{t('settings.maxPods')}</th>
              <td>{settings.maxConcurrentPods}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {decisions.map(({ templateId, templateName, action }) => (
        <p className="muted small" key={templateId}>
          <strong>
            {decisions.length > 1 ? `${templateName} — ` : ''}
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

function Amount({
  label,
  value,
  limit,
  over,
}: {
  label: string
  value: string
  limit: string
  over: boolean
}): ReactNode {
  return (
    <div className={over ? 'amount over' : 'amount'}>
      <span className="amount-label">{label}</span>
      <span className="amount-value">{value}</span>
      <span className="amount-limit">{limit}</span>
    </div>
  )
}
