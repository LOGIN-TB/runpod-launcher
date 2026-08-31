import { templateSchema, type Template } from '@runpod-launcher/shared'
import type { Db } from '../store/db.js'
import type { SettingsStore } from '../store/settings.js'
import type { PodManager } from '../pods/manager.js'
import { decide, type Action, type PodState } from './decide.js'
import { reapSupersededPods } from '../pods/reaper.js'
import type { SpendTracker } from './spend.js'
import type { NotificationSink } from './notify.js'

const TICK_MS = 60_000

/** What the scheduler decided for one template, and why. */
export interface ScheduledDecision {
  templateId: string
  templateName: string
  action: Action
}

interface Logger {
  info: (obj: unknown, msg: string) => void
  warn: (obj: unknown, msg: string) => void
  error: (obj: unknown, msg: string) => void
}

/**
 * Runs the schedule.
 *
 * All it does is read state, ask `decide` what should happen, and carry that
 * out. Every rule lives in the pure function next door, where it can be tested
 * against a fixed clock instead of by waiting until seven in the morning.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private warnedAboutKey = false

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsStore,
    private readonly pods: PodManager,
    private readonly spend: SpendTracker,
    private readonly notifier: NotificationSink,
    private readonly log: Logger,
    /** How many gateway requests are being served right now. */
    private readonly inFlight: () => number = () => 0,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    // `unref` keeps the timer from holding the process open during shutdown.
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * What would happen on the next tick, without doing it.
   *
   * A schedule that quietly does nothing is very hard to diagnose from the
   * outside; this lets the app show the reason at any hour.
   */
  async preview(now: Date = new Date()): Promise<ScheduledDecision[]> {
    const templates = this.scheduledTemplates()
    if (templates.length === 0) return []
    const settings = this.settings.read()
    const snapshot = await this.spend.snapshot(now)

    return Promise.all(
      templates.map(async (template) => ({
        templateId: template.id,
        templateName: template.name,
        action: decide({
          template,
          pod: await this.podStateAsync(template.id),
          spend: {
            todayUsd: snapshot.todayUsd,
            monthUsd: snapshot.monthUsd,
            dailyLimitUsd: settings.dailyLimitUsd,
            monthlyLimitUsd: settings.monthlyLimitUsd,
          },
          now,
        }),
      })),
    )
  }

  /**
   * One pass over every scheduled template. Public so tests can drive it
   * without waiting a minute.
   *
   * Returns the one action worth reporting — the first that actually did
   * something, or null when every template was left alone. Each template's own
   * decision is logged and audited regardless.
   */
  async tick(now: Date = new Date()): Promise<Action | null> {
    // A tick that overruns must not overlap the next one: starting a pod takes
    // minutes, and two ticks both deciding to start would rent two GPUs.
    if (this.running) return null
    this.running = true
    try {
      const acted = await this.runOnce(now)
      return acted.find((entry) => entry.action.do !== 'nothing')?.action ?? acted[0]?.action ?? null
    } catch (error) {
      this.log.error({ error: (error as Error).message }, 'scheduler tick failed')
      return null
    } finally {
      this.running = false
    }
  }

  private async runOnce(now: Date): Promise<ScheduledDecision[]> {
    // Cheap when there is nothing to do, and it catches pods left behind by an
    // earlier version or by a start that failed halfway.
    await reapSupersededPods(this.db, this.pods, (message, detail) => this.log.info(detail, message)).catch(
      (error: unknown) => this.log.warn({ error: (error as Error).message }, 'reaping pods failed'),
    )

    // Credentials arrive after the service is already up: the user pairs first,
    // then types the key. Checking here rather than at boot is what stops the
    // schedule from silently doing nothing until the next container restart.
    if (!this.settings.secret('runpodApiKey')) {
      if (!this.warnedAboutKey) {
        this.log.info({}, 'scheduler idle: no RunPod key configured yet')
        this.warnedAboutKey = true
      }
      return []
    }
    this.warnedAboutKey = false

    const templates = this.scheduledTemplates()
    if (templates.length === 0) return []

    const settings = this.settings.read()
    const snapshot = await this.spend.snapshot(now)

    // One after another rather than in parallel: starts are what consume the
    // concurrent-pod budget, and two decided in the same instant would each see
    // room for one more.
    const decisions: ScheduledDecision[] = []
    for (const template of templates) {
      decisions.push({
        templateId: template.id,
        templateName: template.name,
        action: await this.applyTo(template, snapshot, settings, now),
      })
    }
    return decisions
  }

  /** Decides for one template, and carries the decision out. */
  private async applyTo(
    template: Template,
    snapshot: { todayUsd: number; monthUsd: number },
    settings: { dailyLimitUsd: number | null; monthlyLimitUsd: number | null },
    now: Date,
  ): Promise<Action> {
    const action = decide({
      template,
      pod: await this.podStateAsync(template.id),
      spend: {
        todayUsd: snapshot.todayUsd,
        monthUsd: snapshot.monthUsd,
        dailyLimitUsd: settings.dailyLimitUsd,
        monthlyLimitUsd: settings.monthlyLimitUsd,
      },
      now,
    })

    if (action.do === 'nothing') return action

    this.audit(action, template)

    if (action.do === 'stop') {
      await this.pods.stop(template.id, template.lifecycleMode, action.because)
      await this.notifier.send({
        kind:
          action.because === 'daily-limit' || action.because === 'monthly-limit'
            ? 'spend-limit-reached'
            : action.because === 'max-runtime'
              ? 'max-runtime-reached'
              : 'pod-stopped',
        message: stopMessage(action.because, snapshot.todayUsd),
        details: { template: template.name, reason: action.because, todayUsd: round(snapshot.todayUsd) },
      })
      return action
    }

    try {
      const record = await this.pods.start(template, 'scheduler')
      await this.notifier.send({
        kind: 'pod-started',
        message: `Started ${template.name} at $${record.costPerHour.toFixed(2)}/h.`,
        details: { template: template.name, podId: record.id, costPerHour: record.costPerHour },
      })
    } catch (error) {
      // A failed scheduled start is silent otherwise: nobody is watching at
      // 07:00, and the first sign would be a workflow timing out later. The
      // concurrent-pod limit arrives here too, which is why it names the pods
      // that are holding the slots.
      await this.notifier.send({
        kind: 'pod-start-failed',
        message: `Could not start ${template.name}: ${(error as Error).message}`,
        details: { template: template.name, error: (error as Error).message },
      })
      this.log.error({ error: (error as Error).message }, 'scheduled start failed')
    }
    return action
  }

  /**
   * Every template the schedule has something to say about.
   *
   * Two groups, and both are needed. Templates with a pod up, because stopping
   * something means stopping what is actually running — including a pod started
   * by hand from a template with no schedule at all. And templates with a
   * schedule enabled, because that is what a start comes from.
   *
   * This used to return one template and warn that the rest were ignored. It
   * was true then and is not now: applications are mapped to their own pods, so
   * a schedule that only ever governed the first of them would leave the others
   * running all night.
   */
  private scheduledTemplates(): Template[] {
    const byId = new Map<string, Template>()

    for (const pod of this.pods.runningPods()) {
      const template = this.pods.template(pod.templateId)
      if (template) byId.set(template.id, template)
    }

    const rows = this.db.prepare('SELECT config FROM templates ORDER BY created_at').all() as Array<{ config: string }>
    for (const row of rows) {
      const parsed = templateSchema.safeParse(JSON.parse(row.config))
      if (parsed.success && parsed.data.schedule.enabled && !byId.has(parsed.data.id)) {
        byId.set(parsed.data.id, parsed.data)
      }
    }

    return [...byId.values()]
  }

  private async podStateAsync(templateId: string): Promise<PodState> {
    const base = this.podStateFor(templateId)
    if (base.status !== 'RUNNING') return base
    // Asking the engine directly, because RunPod's RUNNING arrives minutes
    // before it can answer anything.
    return {
      ...base,
      engineReady:
        this.pods.describeFor(templateId) !== null && (await this.pods.engineAnswers(templateId)),
    }
  }

  private podStateFor(templateId: string): PodState {
    const record = this.pods.currentFor(templateId)
    const row = this.db
      .prepare('SELECT started_at AS startedAt FROM pods WHERE id = ?')
      .get(record?.id ?? '') as { startedAt: string | null } | undefined

    // This template's own traffic. Read across all templates, a busy pod would
    // keep every idle one alive — the same mistake that once measured a fresh
    // pod's idleness from another pod's last request and killed it after 64
    // seconds under a thirty-minute limit.
    const lastRequest = this.db
      .prepare('SELECT at FROM usage WHERE template_id = ? ORDER BY id DESC LIMIT 1')
      .get(templateId) as { at: string } | undefined

    const startedBy = this.db
      .prepare('SELECT started_by AS startedBy FROM pods WHERE id = ?')
      .get(record?.id ?? '') as { startedBy: string } | undefined

    const idleStop = this.db
      .prepare(
        `SELECT stopped_at AS stoppedAt FROM pods
          WHERE stop_reason = 'idle-timeout' AND template_id = ?
          ORDER BY stopped_at DESC LIMIT 1`,
      )
      .get(templateId) as { stoppedAt: string | null } | undefined

    return {
      status: (record?.status as PodState['status']) ?? null,
      startedAt: row?.startedAt ? new Date(row.startedAt) : null,
      lastRequestAt: lastRequest ? new Date(lastRequest.at) : null,
      idleStoppedAt: idleStop?.stoppedAt ? new Date(idleStop.stoppedAt) : null,
      engineReady: false,
      startedManually: (startedBy?.startedBy ?? 'user') === 'user',
      inFlightRequests: this.inFlight(),
    }
  }

  private audit(action: Action, template: Template): void {
    this.db
      .prepare('INSERT INTO audit_log (at, actor, action, detail, ip) VALUES (?, ?, ?, ?, ?)')
      .run(
        new Date().toISOString(),
        'scheduler',
        `pod.${action.do}`,
        JSON.stringify({ reason: action.because, template: template.name }),
        null,
      )
    this.log.info({ action: action.do, reason: action.because, template: template.name }, 'scheduler acting')
  }
}

const round = (value: number): number => Math.round(value * 100) / 100

function stopMessage(reason: Action['because'], todayUsd: number): string {
  switch (reason) {
    case 'daily-limit':
      return `Daily spending limit reached ($${round(todayUsd)}). The pod has been stopped.`
    case 'monthly-limit':
      return `Monthly spending limit reached. The pod has been stopped.`
    case 'max-runtime':
      return 'The pod hit its maximum run time and has been stopped.'
    case 'idle-timeout':
      return 'No requests for a while, so the pod has been stopped.'
    default:
      return 'The pod has been stopped, outside its scheduled hours.'
  }
}
