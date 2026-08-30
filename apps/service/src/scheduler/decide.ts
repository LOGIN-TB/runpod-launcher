import type { Template } from '@runpod-launcher/shared'

/**
 * Should the pod be running right now, and if the answer changed, why?
 *
 * Written as a pure function over an explicit `now` so every rule can be tested
 * without waiting for a clock or a timezone to roll over. The scheduler loop
 * does nothing but feed it state and carry out what it says.
 */

export type Action =
  | { do: 'start'; because: Reason }
  | { do: 'stop'; because: Reason }
  | { do: 'nothing'; because: Reason }

export type Reason =
  | 'inside-schedule'
  | 'outside-schedule'
  | 'idle-timeout'
  | 'max-runtime'
  | 'daily-limit'
  | 'monthly-limit'
  | 'schedule-disabled'
  | 'already-correct'
  | 'starting'
  | 'idle-until-requested'

export interface PodState {
  status: 'RUNNING' | 'STARTING' | 'PROVISIONING' | 'EXITED' | 'ERROR' | 'TERMINATED' | null
  startedAt: Date | null
  /** When the gateway last saw a request. Null means none since it started. */
  lastRequestAt: Date | null
  /**
   * When the pod was last stopped for being idle, if it was.
   *
   * Without this the two rules fight: idle shutdown stops the pod, the schedule
   * sees an open window and starts it again a minute later, and the cycle
   * repeats all day. Observed doing exactly that on 2026-08-30 — two full
   * start/stop rounds in seven minutes.
   */
  idleStoppedAt: Date | null
}

export interface Spend {
  todayUsd: number
  monthUsd: number
  dailyLimitUsd: number | null
  monthlyLimitUsd: number | null
}

export function decide(args: {
  template: Template
  pod: PodState
  spend: Spend
  now: Date
}): Action {
  const { template, pod, spend, now } = args
  const schedule = template.schedule
  const isUp = pod.status === 'RUNNING'
  const isComingUp = pod.status === 'STARTING' || pod.status === 'PROVISIONING'

  // Spend limits come first and are absolute. Every other rule is about
  // convenience; this one is the reason the project exists.
  if (isUp || isComingUp) {
    if (spend.dailyLimitUsd !== null && spend.todayUsd >= spend.dailyLimitUsd) {
      return { do: 'stop', because: 'daily-limit' }
    }
    if (spend.monthlyLimitUsd !== null && spend.monthUsd >= spend.monthlyLimitUsd) {
      return { do: 'stop', because: 'monthly-limit' }
    }
  }

  // A pod still coming up is left alone: acting on it would either restart a
  // boot that is going fine or fight the start that is already in flight.
  if (isComingUp) return { do: 'nothing', because: 'starting' }

  if (isUp) {
    // A hard ceiling on one run. This is the backstop against a pod that
    // nothing else notices — a stuck workflow keeping it "busy" all weekend.
    if (schedule.maxRuntimeHours > 0 && pod.startedAt) {
      const hoursUp = (now.getTime() - pod.startedAt.getTime()) / 3_600_000
      if (hoursUp >= schedule.maxRuntimeHours) return { do: 'stop', because: 'max-runtime' }
    }

    if (schedule.idleStopMinutes > 0) {
      // With no request since it started, idleness is measured from the start —
      // otherwise a pod nobody ever called would stay up forever.
      const since = pod.lastRequestAt ?? pod.startedAt
      if (since) {
        const idleMinutes = (now.getTime() - since.getTime()) / 60_000
        if (idleMinutes >= schedule.idleStopMinutes) return { do: 'stop', because: 'idle-timeout' }
      }
    }
  }

  if (!schedule.enabled) return { do: 'nothing', because: 'schedule-disabled' }

  const wanted = isInsideWindow(schedule, now)

  if (wanted && !isUp) {
    // Having been stopped for idleness inside this very window, the pod stays
    // down until the window comes round again — or until a request wakes it,
    // which is what the gateway is for. Restarting it here would undo the
    // saving the idle rule just made.
    if (stoppedIdleInThisWindow(schedule, pod, now)) {
      return { do: 'nothing', because: 'idle-until-requested' }
    }
    return { do: 'start', because: 'inside-schedule' }
  }

  if (!wanted && isUp) return { do: 'stop', because: 'outside-schedule' }
  return { do: 'nothing', because: 'already-correct' }
}

/**
 * Is `now` inside the template's operating window, in the template's own
 * timezone?
 *
 * The timezone belongs to the schedule, not to the server: a container on a VPS
 * runs in UTC, and "07:00" has to mean seven in the morning where the user is.
 * A window whose end is before its start crosses midnight — 22:00 to 06:00 is a
 * legitimate night shift, not a mistake.
 */
export function isInsideWindow(schedule: Template['schedule'], now: Date): boolean {
  if (!schedule.startAt || !schedule.stopAt) return false

  const local = localParts(now, schedule.timezone)
  const minutes = local.hour * 60 + local.minute
  const start = toMinutes(schedule.startAt)
  const stop = toMinutes(schedule.stopAt)

  if (start === stop) return false

  if (start < stop) {
    return schedule.weekdays.includes(local.weekday) && minutes >= start && minutes < stop
  }

  // Crosses midnight. The evening half belongs to the day it starts on; the
  // small hours belong to the previous day's window, so that a Friday-night run
  // is not cut off at midnight because Saturday is not a working day.
  if (minutes >= start) return schedule.weekdays.includes(local.weekday)
  const previousDay = (local.weekday + 6) % 7
  return minutes < stop && schedule.weekdays.includes(previousDay)
}

/**
 * Was the pod idle-stopped during the window occurrence we are in now, with no
 * request since?
 *
 * A request after the stop clears it: somebody wants the model, and the gateway
 * will have woken it anyway.
 */
function stoppedIdleInThisWindow(
  schedule: Template['schedule'],
  pod: PodState,
  now: Date,
): boolean {
  if (!pod.idleStoppedAt) return false
  if (pod.lastRequestAt && pod.lastRequestAt > pod.idleStoppedAt) return false

  const openedAt = windowOpenedAt(schedule, now)
  return openedAt !== null && pod.idleStoppedAt >= openedAt
}

/**
 * When the window we are currently inside opened.
 *
 * Identifies one occurrence of a recurring window, so "already stopped during
 * this one" can be distinguished from "a new day has begun".
 */
export function windowOpenedAt(schedule: Template['schedule'], now: Date): Date | null {
  if (!schedule.startAt || !isInsideWindow(schedule, now)) return null

  const local = localParts(now, schedule.timezone)
  const nowMinutes = local.hour * 60 + local.minute
  const startMinutes = toMinutes(schedule.startAt)

  // Past the start time today, the window opened today; before it, this is the
  // tail of a window that opened yesterday and crossed midnight.
  const minutesSinceOpen =
    nowMinutes >= startMinutes ? nowMinutes - startMinutes : nowMinutes + (24 * 60 - startMinutes)

  return new Date(now.getTime() - minutesSinceOpen * 60_000)
}

const toMinutes = (hhmm: string): number => {
  const [hours = '0', minutes = '0'] = hhmm.split(':')
  return Number(hours) * 60 + Number(minutes)
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Hour, minute and weekday in a given IANA timezone, without a date library. */
export function localParts(instant: Date, timeZone: string): {
  hour: number
  minute: number
  weekday: number
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(instant)

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '0'

  return {
    // `hour: '2-digit'` with hour12: false yields 24 for midnight in some
    // engines, which would put it outside every window.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  }
}
