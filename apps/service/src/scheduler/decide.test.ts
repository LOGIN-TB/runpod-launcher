import assert from 'node:assert/strict'
import { test } from 'node:test'
import { templateSchema, type Template } from '@runpod-launcher/shared'
import { decide, isInsideWindow, localParts, windowOpenedAt, type PodState, type Spend } from './decide.js'

const template = (schedule: Partial<Template['schedule']> = {}): Template =>
  templateSchema.parse({
    id: 't1',
    name: 'test',
    image: 'img',
    gpuTypeId: 'NVIDIA L40S',
    chatModel: { repoId: 'a/b' },
    lifecycleMode: 'stopResume',
    schedule: {
      enabled: true,
      timezone: 'Europe/Berlin',
      weekdays: [1, 2, 3, 4, 5],
      startAt: '07:00',
      stopAt: '19:00',
      idleStopMinutes: 30,
      maxRuntimeHours: 12,
      ...schedule,
    },
  })

const pod = (overrides: Partial<PodState> = {}): PodState => ({
  status: 'RUNNING',
  startedAt: new Date('2026-09-01T06:00:00Z'),
  lastRequestAt: new Date('2026-09-01T06:00:00Z'),
  idleStoppedAt: null,
  engineReady: true,
  // Most tests are about the schedule acting on its own; the manual-start
  // exception has its own cases below.
  startedManually: false,
  ...overrides,
})

const noLimits: Spend = { todayUsd: 0, monthUsd: 0, dailyLimitUsd: null, monthlyLimitUsd: null }

/** Berlin is UTC+2 in September, so 07:00 UTC is 09:00 local. */
const at = (utc: string): Date => new Date(utc)

test('the timezone belongs to the schedule, not to the server', () => {
  // 05:30 UTC on a Tuesday is 07:30 in Berlin — inside a 07:00–19:00 window,
  // even though the container itself runs in UTC.
  const berlin = localParts(at('2026-09-01T05:30:00Z'), 'Europe/Berlin')
  assert.deepEqual(berlin, { hour: 7, minute: 30, weekday: 2 })

  const utc = localParts(at('2026-09-01T05:30:00Z'), 'UTC')
  assert.equal(utc.hour, 5)
})

test('the pod starts inside the window and stops outside it', () => {
  const inside = decide({ template: template(), pod: pod({ status: 'EXITED' }), spend: noLimits, now: at('2026-09-01T08:00:00Z') })
  assert.deepEqual(inside, { do: 'start', because: 'inside-schedule' })

  // Started at 14:00 UTC so the 12-hour ceiling is nowhere near; the only rule
  // in play is the window closing at 19:00 Berlin (17:00 UTC).
  const outside = decide({
    template: template(),
    pod: pod({ startedAt: at('2026-09-01T14:00:00Z'), lastRequestAt: at('2026-09-01T17:50:00Z') }),
    spend: noLimits,
    now: at('2026-09-01T18:00:00Z'),
  })
  assert.deepEqual(outside, { do: 'stop', because: 'outside-schedule' })
})

test('weekends are left alone when the schedule says weekdays', () => {
  // 2026-09-05 is a Saturday.
  const saturday = decide({
    template: template(),
    pod: pod({ status: 'EXITED' }),
    spend: noLimits,
    now: at('2026-09-05T08:00:00Z'),
  })
  assert.equal(saturday.do, 'nothing')
})

test('a window that crosses midnight is a night shift, not a mistake', () => {
  const night = template({ startAt: '22:00', stopAt: '06:00', weekdays: [1, 2, 3, 4, 5] })

  // Monday 23:00 Berlin — inside.
  assert.equal(isInsideWindow(night.schedule, at('2026-09-01T21:00:00Z')), true)
  // Tuesday 03:00 Berlin — still inside, belonging to Monday's window.
  assert.equal(isInsideWindow(night.schedule, at('2026-09-02T01:00:00Z')), true)
  // Tuesday 12:00 Berlin — outside.
  assert.equal(isInsideWindow(night.schedule, at('2026-09-02T10:00:00Z')), false)
  // Saturday 03:00 Berlin belongs to Friday night, which is a working day.
  assert.equal(isInsideWindow(night.schedule, at('2026-09-05T01:00:00Z')), true)
  // Sunday 03:00 belongs to Saturday night, which is not.
  assert.equal(isInsideWindow(night.schedule, at('2026-09-06T01:00:00Z')), false)
})

test('an idle pod is stopped even inside the window', () => {
  const action = decide({
    template: template(),
    pod: pod({ lastRequestAt: at('2026-09-01T08:00:00Z') }),
    spend: noLimits,
    now: at('2026-09-01T08:31:00Z'),
  })
  assert.deepEqual(action, { do: 'stop', because: 'idle-timeout' })
})

test('a pod nobody ever called is measured from its start, not left up forever', () => {
  const action = decide({
    template: template(),
    pod: pod({ startedAt: at('2026-09-01T08:00:00Z'), lastRequestAt: null }),
    spend: noLimits,
    now: at('2026-09-01T08:45:00Z'),
  })
  assert.deepEqual(action, { do: 'stop', because: 'idle-timeout' })
})

test('the runtime ceiling catches a pod that looks busy all weekend', () => {
  const action = decide({
    template: template({ idleStopMinutes: 0, enabled: false }),
    pod: pod({ startedAt: at('2026-09-01T00:00:00Z'), lastRequestAt: at('2026-09-01T12:29:00Z') }),
    spend: noLimits,
    now: at('2026-09-01T12:30:00Z'),
  })
  assert.deepEqual(action, { do: 'stop', because: 'max-runtime' })
})

test('a spend limit overrides everything, including the middle of the window', () => {
  const daily = decide({
    template: template(),
    pod: pod({ lastRequestAt: at('2026-09-01T08:29:00Z') }),
    spend: { todayUsd: 20.5, monthUsd: 40, dailyLimitUsd: 20, monthlyLimitUsd: null },
    now: at('2026-09-01T08:30:00Z'),
  })
  assert.deepEqual(daily, { do: 'stop', because: 'daily-limit' })

  const monthly = decide({
    template: template(),
    pod: pod({ lastRequestAt: at('2026-09-01T08:29:00Z') }),
    spend: { todayUsd: 1, monthUsd: 300, dailyLimitUsd: null, monthlyLimitUsd: 300 },
    now: at('2026-09-01T08:30:00Z'),
  })
  assert.deepEqual(monthly, { do: 'stop', because: 'monthly-limit' })
})

test('a spend limit does not start a pod that is already down', () => {
  // Stopping is the only thing a limit does; it must not become a reason to
  // act on a pod that is not costing anything.
  const action = decide({
    template: template(),
    pod: pod({ status: 'EXITED' }),
    spend: { todayUsd: 999, monthUsd: 999, dailyLimitUsd: 20, monthlyLimitUsd: 100 },
    now: at('2026-09-01T08:00:00Z'),
  })
  assert.equal(action.do, 'start', 'the limit applies to running pods, and this one is down')
})

test('a pod still booting is left alone', () => {
  for (const status of ['STARTING', 'PROVISIONING'] as const) {
    const action = decide({
      template: template(),
      pod: pod({ status, startedAt: null, lastRequestAt: null }),
      spend: noLimits,
      now: at('2026-09-01T08:00:00Z'),
    })
    assert.deepEqual(action, { do: 'nothing', because: 'starting' }, status)
  }
})

test('a disabled schedule still enforces idle and runtime ceilings', () => {
  const idle = decide({
    template: template({ enabled: false }),
    pod: pod({ lastRequestAt: at('2026-09-01T08:00:00Z') }),
    spend: noLimits,
    now: at('2026-09-01T08:31:00Z'),
  })
  assert.equal(idle.because, 'idle-timeout')

  const quiet = decide({
    template: template({ enabled: false }),
    pod: pod({ status: 'EXITED' }),
    spend: noLimits,
    now: at('2026-09-01T08:00:00Z'),
  })
  assert.deepEqual(quiet, { do: 'nothing', because: 'schedule-disabled' })
})

test('a window set to zero width never runs', () => {
  assert.equal(isInsideWindow(template({ startAt: '09:00', stopAt: '09:00' }).schedule, at('2026-09-01T07:00:00Z')), false)
})

test('winter time is handled, because the offset comes from the zone', () => {
  // Berlin is UTC+1 in January. 07:30 UTC is 08:30 local — inside the window.
  // Naive UTC arithmetic would have this an hour off twice a year.
  assert.equal(localParts(at('2026-01-05T07:30:00Z'), 'Europe/Berlin').hour, 8)
  assert.equal(localParts(at('2026-07-05T07:30:00Z'), 'Europe/Berlin').hour, 9)
})

test('an idle stop is not undone by the schedule a minute later', () => {
  // Observed live on 2026-08-30: the pod idle-stopped, the scheduler saw an
  // open window and started it again, and the cycle repeated — two full rounds
  // in seven minutes, each one a fresh GPU rental.
  const action = decide({
    template: template(),
    pod: pod({
      status: 'EXITED',
      startedAt: at('2026-09-01T06:00:00Z'),
      lastRequestAt: at('2026-09-01T06:05:00Z'),
      idleStoppedAt: at('2026-09-01T06:35:00Z'),
    }),
    spend: noLimits,
    now: at('2026-09-01T06:36:00Z'),
  })
  assert.deepEqual(action, { do: 'nothing', because: 'idle-until-requested' })
})

test('a request after the idle stop lets the schedule start it again', () => {
  // Somebody wants the model. The gateway would wake it anyway; the scheduler
  // must not be the thing standing in the way.
  const action = decide({
    template: template(),
    pod: pod({
      status: 'EXITED',
      idleStoppedAt: at('2026-09-01T06:35:00Z'),
      lastRequestAt: at('2026-09-01T06:40:00Z'),
    }),
    spend: noLimits,
    now: at('2026-09-01T06:41:00Z'),
  })
  assert.deepEqual(action, { do: 'start', because: 'inside-schedule' })
})

test('the next day’s window starts the pod again despite yesterday’s idle stop', () => {
  // Suppression is scoped to one occurrence of the window, not forever.
  const action = decide({
    template: template(),
    pod: pod({
      status: 'EXITED',
      idleStoppedAt: at('2026-09-01T09:00:00Z'),
      lastRequestAt: at('2026-09-01T08:00:00Z'),
    }),
    spend: noLimits,
    now: at('2026-09-02T06:00:00Z'),
  })
  assert.deepEqual(action, { do: 'start', because: 'inside-schedule' })
})

test('the window opening is located correctly, including across midnight', () => {
  // 09:00 Berlin on a Tuesday, window 07:00–19:00: opened two hours ago.
  const day = windowOpenedAt(template().schedule, at('2026-09-01T07:00:00Z'))
  assert.equal(day?.toISOString(), '2026-09-01T05:00:00.000Z')

  // 03:00 Berlin, window 22:00–06:00: opened at 22:00 the previous evening.
  const night = windowOpenedAt(template({ startAt: '22:00', stopAt: '06:00' }).schedule, at('2026-09-02T01:00:00Z'))
  assert.equal(night?.toISOString(), '2026-09-01T20:00:00.000Z')

  // Outside any window there is no occurrence to point at.
  assert.equal(windowOpenedAt(template().schedule, at('2026-09-01T20:00:00Z')), null)
})

test('a pod is never idle before its engine can answer', () => {
  // Measured live: a pod was stopped for idleness 64 seconds after starting,
  // under a 30-minute limit, while it was still downloading the model. The
  // download was paid for and then discarded.
  const action = decide({
    template: template({ idleStopMinutes: 30 }),
    pod: pod({
      startedAt: at('2026-09-01T06:00:00Z'),
      // An older pod's traffic, hours ago. This alone used to expire the clock.
      lastRequestAt: at('2026-09-01T01:00:00Z'),
      engineReady: false,
    }),
    now: at('2026-09-01T06:01:00Z'),
    spend: noLimits,
  })
  assert.notEqual(action.because, 'idle-timeout')
})

test('idleness runs from this pod’s start, not from an older pod’s last request', () => {
  // The bug in one line: `lastRequestAt ?? startedAt` took the most recent
  // request across all pods, so a brand-new pod inherited a clock that had
  // already expired.
  const justStarted = decide({
    template: template({ idleStopMinutes: 30 }),
    pod: pod({
      startedAt: at('2026-09-01T06:00:00Z'),
      lastRequestAt: at('2026-09-01T01:00:00Z'), // five hours ago, another pod
      engineReady: true,
    }),
    now: at('2026-09-01T06:01:00Z'),
    spend: noLimits,
  })
  assert.notEqual(justStarted.because, 'idle-timeout', 'one minute old is not idle')

  const genuinelyIdle = decide({
    template: template({ idleStopMinutes: 30 }),
    pod: pod({
      startedAt: at('2026-09-01T06:00:00Z'),
      lastRequestAt: at('2026-09-01T06:05:00Z'),
      engineReady: true,
    }),
    now: at('2026-09-01T06:40:00Z'),
    spend: noLimits,
  })
  assert.equal(genuinelyIdle.because, 'idle-timeout', '35 minutes after the last request is')
})

test('a spend limit still stops a pod that is not ready yet', () => {
  // Readiness protects the idle rule only. Money is money whether or not the
  // model has finished loading.
  const action = decide({
    template: template(),
    pod: pod({ engineReady: false, startedAt: at('2026-09-01T06:00:00Z') }),
    spend: { todayUsd: 50, monthUsd: 50, dailyLimitUsd: 20, monthlyLimitUsd: null },
    now: at('2026-09-01T06:01:00Z'),
  })
  assert.equal(action.because, 'daily-limit')
})

test('a pod somebody started by hand is not taken away before they can use it', () => {
  // Observed: created at 20:48, stopped by the schedule at 21:00 while still
  // loading, never having answered a request. Thirteen minutes of download
  // paid for and discarded.
  const action = decide({
    template: template(), // window closes at 19:00 Berlin
    pod: pod({
      startedManually: true,
      engineReady: false,
      startedAt: at('2026-09-01T17:50:00Z'),
      lastRequestAt: null,
    }),
    spend: noLimits,
    now: at('2026-09-01T18:00:00Z'),
  })
  assert.deepEqual(action, { do: 'nothing', because: 'manual-start' })
})

test('once it has been used, the schedule takes over again', () => {
  // The exception covers "I asked for this and cannot use it yet", not "this
  // may now run forever".
  const action = decide({
    template: template(),
    pod: pod({
      startedManually: true,
      engineReady: true,
      startedAt: at('2026-09-01T17:50:00Z'),
      lastRequestAt: at('2026-09-01T17:55:00Z'),
    }),
    spend: noLimits,
    now: at('2026-09-01T18:00:00Z'),
  })
  assert.deepEqual(action, { do: 'stop', because: 'outside-schedule' })
})

test('a pod the schedule started is stopped by the schedule, used or not', () => {
  const action = decide({
    template: template(),
    pod: pod({ startedManually: false, engineReady: false, startedAt: at('2026-09-01T17:50:00Z'), lastRequestAt: null }),
    spend: noLimits,
    now: at('2026-09-01T18:00:00Z'),
  })
  assert.deepEqual(action, { do: 'stop', because: 'outside-schedule' })
})

test('a spend limit still wins over a manual start', () => {
  const action = decide({
    template: template(),
    pod: pod({ startedManually: true, engineReady: false, lastRequestAt: null }),
    spend: { todayUsd: 99, monthUsd: 99, dailyLimitUsd: 10, monthlyLimitUsd: null },
    now: at('2026-09-01T18:00:00Z'),
  })
  assert.equal(action.because, 'daily-limit')
})

test('the runtime ceiling still applies to a manual start', () => {
  const action = decide({
    template: template({ maxRuntimeHours: 2 }),
    pod: pod({
      startedManually: true,
      engineReady: false,
      startedAt: at('2026-09-01T04:00:00Z'),
      lastRequestAt: null,
    }),
    spend: noLimits,
    now: at('2026-09-01T18:00:00Z'),
  })
  assert.equal(action.because, 'max-runtime')
})
