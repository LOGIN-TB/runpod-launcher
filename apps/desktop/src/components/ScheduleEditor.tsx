import type { ReactNode } from 'react'
import type { Template } from '@runpod-launcher/shared'
import type { MessageKey } from '@runpod-launcher/i18n'
import { useI18n } from '../lib/i18n.js'
import { Field, Input } from './primitives.js'

type Schedule = Template['schedule']

/**
 * The schedule, in the terms someone actually thinks in: which days, from when
 * to when, and when to give up on an idle pod.
 *
 * Times belong to a timezone that is stated on screen. A container on a VPS
 * runs in UTC, and "07:00" has to mean seven in the morning where the user is —
 * showing which zone is meant is the difference between a schedule people trust
 * and one they check every morning.
 */
export function ScheduleEditor({
  schedule,
  timezone,
  onChange,
}: {
  schedule: Schedule
  timezone: string
  onChange: (next: Schedule) => void
}): ReactNode {
  const { t } = useI18n()
  const patch = (changes: Partial<Schedule>): void => onChange({ ...schedule, ...changes })

  const crossesMidnight =
    schedule.startAt !== undefined &&
    schedule.stopAt !== undefined &&
    schedule.startAt > schedule.stopAt

  return (
    <div className="stack">
      <label className="toggle">
        <input
          type="checkbox"
          checked={schedule.enabled}
          onChange={(event) => patch({ enabled: event.target.checked })}
        />
        <span>
          <strong>{t('schedule.enabled')}</strong>
          {!schedule.enabled ? <span className="muted small">{t('schedule.disabledHint')}</span> : null}
        </span>
      </label>

      {schedule.enabled ? (
        <>
          <Field label={t('schedule.days')}>
            <div className="weekdays">
              {[1, 2, 3, 4, 5, 6, 0].map((day) => {
                const on = schedule.weekdays.includes(day)
                return (
                  <button
                    key={day}
                    type="button"
                    className={on ? 'weekday on' : 'weekday'}
                    aria-pressed={on}
                    onClick={() =>
                      patch({
                        weekdays: on
                          ? schedule.weekdays.filter((d) => d !== day)
                          : [...schedule.weekdays, day].sort(),
                      })
                    }
                  >
                    {t(`weekday.${day}` as MessageKey)}
                  </button>
                )
              })}
            </div>
          </Field>

          <div className="row">
            <Field label={t('schedule.from')}>
              <Input
                type="time"
                value={schedule.startAt ?? '07:00'}
                onChange={(event) => patch({ startAt: event.target.value })}
              />
            </Field>
            <Field label={t('schedule.to')} hint={t('schedule.timezone') + ' ' + timezone}>
              <Input
                type="time"
                value={schedule.stopAt ?? '19:00'}
                onChange={(event) => patch({ stopAt: event.target.value })}
              />
            </Field>
          </div>

          {/* An overnight window is legitimate, but it looks like a mistake
              unless the interface says it understood. */}
          {crossesMidnight ? <p className="muted small">{t('schedule.crossesMidnight')}</p> : null}
        </>
      ) : null}

      <div className="row">
        <Field label={t('schedule.idle')}>
          <select
            className="input"
            value={schedule.idleStopMinutes}
            onChange={(event) => patch({ idleStopMinutes: Number(event.target.value) })}
          >
            <option value={0}>{t('schedule.idleOff')}</option>
            {[15, 30, 60, 120].map((minutes) => (
              <option key={minutes} value={minutes}>
                {t('schedule.minutes', { count: minutes })}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('schedule.maxRuntime')}>
          <select
            className="input"
            value={schedule.maxRuntimeHours}
            onChange={(event) => patch({ maxRuntimeHours: Number(event.target.value) })}
          >
            <option value={0}>{t('schedule.idleOff')}</option>
            {[4, 8, 12, 24].map((hours) => (
              <option key={hours} value={hours}>
                {t('schedule.hours', { count: hours })}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </div>
  )
}
