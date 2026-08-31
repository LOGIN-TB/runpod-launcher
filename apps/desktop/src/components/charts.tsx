import type { ReactNode } from 'react'
import type { SpendDay, SpendShare } from '@runpod-launcher/shared'
import { useI18n } from '../lib/i18n.js'

/**
 * The three pictures the cost screen needs.
 *
 * Drawn with CSS boxes rather than SVG. Bars are rectangles, and rectangles are
 * what CSS is for: the text stays real text — selectable, translatable, crisp at
 * any zoom — the colours come from the same tokens as everything else, so light
 * and dark need no second implementation, and there is no viewBox arithmetic to
 * get wrong. SVG would earn its place for a curve or an arc; not for this.
 *
 * Every figure is also present as text, because a picture nobody can read is
 * worse than a table.
 */

/**
 * How close a figure is to the limit that would stop the pods.
 *
 * A bar, not a dial. The question is "how much of my allowance is gone", and a
 * bar answers it at a glance at any size; a dial needs three times the space to
 * say the same thing. With no limit set there is no scale, so there is no bar —
 * only the amount, and the reason that is worth worrying about.
 */
export function LimitGauge({
  label,
  valueUsd,
  limitUsd,
  estimatedUsd = 0,
  unsetHint,
}: {
  label: string
  valueUsd: number
  limitUsd: number | null
  /** The part that is our own arithmetic, shown lighter inside the bar. */
  estimatedUsd?: number
  /** Said when no limit is set, because that is the state worth noticing. */
  unsetHint: string
}): ReactNode {
  const { t, money } = useI18n()

  if (limitUsd === null || limitUsd <= 0) {
    return (
      <div className="gauge">
        <span className="gauge-label">{label}</span>
        <span className="gauge-value">{money(valueUsd)}</span>
        <span className="field-error gauge-note">{unsetHint}</span>
      </div>
    )
  }

  const share = valueUsd / limitUsd
  const billed = Math.max(0, valueUsd - estimatedUsd)
  // Both widths are of the limit, so together they read as the whole figure.
  const billedPercent = Math.min(100, (billed / limitUsd) * 100)
  const estimatedPercent = Math.min(100 - billedPercent, (estimatedUsd / limitUsd) * 100)

  const tone = share >= 1 ? 'over' : share >= 0.8 ? 'near' : 'fine'
  const percentText = t('cost.percentOfLimit', {
    percent: Math.round(share * 100),
    limit: money(limitUsd),
  })

  return (
    <div className={`gauge gauge-${tone}`}>
      <span className="gauge-label">{label}</span>
      <span className="gauge-value">{money(valueUsd)}</span>

      {/* The numbers are in the label beside it, so the bar itself is scenery
          for a screen reader rather than something it has to describe. */}
      <div className="gauge-track" role="img" aria-label={`${label}: ${money(valueUsd)} ${percentText}`}>
        <div className="gauge-billed" style={{ width: `${billedPercent}%` }} />
        {estimatedPercent > 0 ? (
          <div className="gauge-estimated" style={{ width: `${estimatedPercent}%` }} />
        ) : null}
      </div>

      <span className="gauge-note muted">{percentText}</span>
    </div>
  )
}

/**
 * What each day of the month cost, split into GPU time and storage.
 *
 * The split is the point. A day with no GPU at all still costs money, because a
 * stopped pod keeps its disk — on the account this was built against, exactly
 * twenty cents a day. That is invisible in a single total and obvious here.
 */
export function DayBars({ days }: { days: SpendDay[] }): ReactNode {
  const { t, money } = useI18n()

  const peak = days.reduce((most, day) => Math.max(most, day.totalUsd), 0)
  if (peak <= 0) {
    return <p className="muted small">{t('cost.noSpendYet')}</p>
  }

  return (
    <>
      <div className="day-bars">
        {days.map((day) => {
          // A day that cost something never renders as nothing. Against a peak
          // of seven dollars, a twenty-cent day is a three-percent sliver —
          // invisible, and indistinguishable from a day that was genuinely
          // free. The floor distorts the comparison slightly and makes the
          // difference that matters legible: this day cost money, that one did
          // not. The exact figure is on the bar's own tooltip.
          const height = day.totalUsd > 0 ? Math.max(4, (day.totalUsd / peak) * 100) : 0
          // Of the bar, not of the day, so the two pieces stack to its height.
          const diskShare = day.totalUsd > 0 ? (day.diskUsd / day.totalUsd) * 100 : 0
          return (
            <div className="day-bar" key={day.day} title={`${day.day}: ${money(day.totalUsd)}`}>
              {/* Nothing at all for a day that cost nothing. A one-pixel stub
                  drew a faint line across three weeks of empty days and read as
                  "a little every day", which is the opposite of the truth. */}
              {height > 0 ? (
                <div
                  className={day.partial ? 'day-stack partial' : 'day-stack'}
                  style={{ height: `${height}%` }}
                >
                  <div className="day-gpu" style={{ height: `${100 - diskShare}%` }} />
                  <div className="day-disk" style={{ height: `${diskShare}%` }} />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {/* Only a few dates, or the axis becomes a grey smear at this width. The
          last day always gets one — it is today — unless a fifth-day label is
          already sitting next to it. */}
      <div className="day-axis">
        {days.map((day, index) => {
          const last = index === days.length - 1
          const crowded = last && (days.length - 1) % 5 <= 1
          const show = index === 0 || (index + 1) % 5 === 0 || (last && !crowded)
          return (
            <span className="day-tick" key={day.day}>
              {show ? dayOfMonth(day.day) : ''}
            </span>
          )
        })}
      </div>

      <div className="chart-legend muted small">
        <span>
          <i className="swatch swatch-gpu" /> {t('cost.gpu')}
        </span>
        <span>
          <i className="swatch swatch-disk" /> {t('cost.disk')}
        </span>
        {/* The pale bar has to be explained, or it reads as a third category
            rather than as today being partly an estimate. */}
        {days.some((day) => day.partial && day.totalUsd > 0) ? (
          <span>
            <i className="swatch swatch-partial" /> {t('cost.partialDay')}
          </span>
        ) : null}
        <span>{t('cost.peakDay', { amount: money(peak) })}</span>
      </div>
    </>
  )
}

/** Who spent it: one row per template, plus the pods that are not ours. */
export function ShareBars({ shares }: { shares: SpendShare[] }): ReactNode {
  const { t, money, number } = useI18n()

  const total = shares.reduce((sum, share) => sum + share.usd, 0)
  if (total <= 0) return <p className="muted small">{t('cost.noSpendYet')}</p>

  const name = (share: SpendShare): string =>
    share.kind === 'foreign'
      ? t('cost.foreign')
      : share.kind === 'deleted'
        ? t('cost.deletedTemplate')
        : share.name

  return (
    <table className="recipes">
      <tbody>
        {shares.map((share) => {
          const percent = (share.usd / total) * 100
          return (
            <tr key={`${share.kind}-${share.templateId ?? share.name}`}>
              <th scope="row">{name(share)}</th>
              <td className="share-cell">
                <div className={share.kind === 'template' ? 'share-bar' : 'share-bar other'}>
                  <div className="share-fill" style={{ width: `${percent}%` }} />
                </div>
              </td>
              <td className="share-amount">
                {money(share.usd)}{' '}
                <span className="muted">({number(percent, { maximumFractionDigits: 0 })}%)</span>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * The day number out of a `YYYY-MM-DD` key.
 *
 * Cut from the string rather than parsed. `new Date('2026-09-01')` is read as
 * UTC, so west of Greenwich it renders the day before — and these keys are
 * already in the user's own timezone.
 */
function dayOfMonth(day: string): string {
  return String(Number(day.slice(8, 10)))
}
