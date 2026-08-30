import { POD_PORTS, templateSchema, type Template, type runpod } from '@runpod-launcher/shared'
import type { Db } from '../store/db.js'
import { generateToken } from '../store/crypto.js'
import { podProxyUrl, RunpodClient, RunpodError } from '../runpod/client.js'
import { podRoleUrls, type ActivePod } from '../gateway/routes.js'
import { buildCreatePodRequest } from './plan.js'

const READY_POLL_MS = 5_000

export interface PodRecord {
  id: string
  templateId: string
  status: runpod.PodStatus
  costPerHour: number
}

/**
 * How far along a pod is, in terms someone waiting can act on.
 *
 * RunPod's own status jumps to RUNNING within seconds while the engine is
 * still fetching twenty gigabytes, and stays RUNNING whether the engine came
 * up or died. Reported live on 2026-08-30: eleven minutes of an apparently
 * running pod with no way to tell downloading from broken.
 */
export type Readiness =
  | 'provisioning' // RunPod has not placed it yet
  | 'preparing' // container up, engine still fetching or loading the model
  | 'ready' // the engine answers
  | 'failed' // the engine keeps exiting
  | 'stopped'

export interface PodStatusReport {
  id: string
  templateId: string
  templateName: string | null
  runpodStatus: runpod.PodStatus
  readiness: Readiness
  costPerHour: number
  /** Seconds since the pod was started, so a long wait is visible as one. */
  runningForSeconds: number | null
  /** Set when readiness is 'failed'. */
  detail: string | null
  gpu: string | null
  isActive: boolean
}

/**
 * Owns the lifecycle of the single active pod.
 *
 * The two sleep modes differ in more than speed. `stopResume` keeps the machine
 * assignment, so it wakes fast — but RunPod may hand back zero GPUs if capacity
 * moved on, and idle volume storage bills at double rate. `recreate` throws the
 * pod away and builds a new one against the network volume: slower to start,
 * cheaper at rest, and free to land on whatever GPU is actually available.
 */
export class PodManager {
  private startInFlight: Promise<PodRecord> | null = null

  constructor(
    private readonly db: Db,
    private readonly runpod: () => RunpodClient,
    private readonly huggingfaceToken: () => string | null,
    /**
     * Encrypts the pod's own bearer token for storage. Left undefined the token
     * is kept in clear, which is only acceptable in tests.
     */
    private readonly seal: { encrypt: (value: string) => string; decrypt: (value: string) => string } = {
      encrypt: (value) => value,
      decrypt: (value) => value,
    },
  ) {}

  /** The token the running pod's engine expects, read back from storage. */
  private podApiKeyFor(podId: string): string | null {
    const row = this.db.prepare('SELECT api_key AS apiKey FROM pods WHERE id = ?').get(podId) as
      | { apiKey: string | null }
      | undefined
    if (!row?.apiKey) return null
    try {
      return this.seal.decrypt(row.apiKey)
    } catch {
      return null
    }
  }

  current(): PodRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, template_id AS templateId, status, cost_per_hour AS costPerHour
         FROM pods WHERE stopped_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as PodRecord | undefined
    return row ?? null
  }

  /**
   * The template a request should wake.
   *
   * The pod that was running last, if there is a record of one — otherwise the
   * template with a schedule enabled. Without that fallback, wake-on-request
   * stops working the moment the scheduler stops the pod, which is precisely
   * when it is needed.
   */
  wakeTarget(): Template | null {
    const current = this.current()
    if (current) return this.template(current.templateId)

    const lastRun = this.db
      .prepare('SELECT template_id AS templateId FROM pods ORDER BY created_at DESC LIMIT 1')
      .get() as { templateId: string | null } | undefined
    if (lastRun?.templateId) {
      const template = this.template(lastRun.templateId)
      if (template) return template
    }

    const templates = (
      this.db.prepare('SELECT config FROM templates ORDER BY created_at').all() as Array<{ config: string }>
    )
      .map((row) => templateSchema.safeParse(JSON.parse(row.config)))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []))

    const scheduled = templates.find((template) => template.schedule.enabled)
    if (scheduled) return scheduled

    // With exactly one template there is no ambiguity about what was meant, so
    // a request wakes it even with no schedule set. More than one and no
    // history is genuinely ambiguous — guessing there would start the wrong
    // GPU and bill for it.
    return templates.length === 1 ? (templates[0] ?? null) : null
  }

  template(id: string): Template | null {
    const row = this.db.prepare('SELECT config FROM templates WHERE id = ?').get(id) as
      | { config: string }
      | undefined
    return row ? templateSchema.parse(JSON.parse(row.config)) : null
  }

  /** Creates a pod for a template, or resumes the stopped one it already has. */
  async start(template: Template): Promise<PodRecord> {
    // Collapse concurrent starts: several client requests arriving at once
    // while the pod sleeps must not each rent a GPU.
    this.startInFlight ??= this.doStart(template).finally(() => {
      this.startInFlight = null
    })
    return this.startInFlight
  }

  private async doStart(template: Template): Promise<PodRecord> {
    const client = this.runpod()
    const existing = this.current()

    if (existing && template.lifecycleMode === 'stopResume') {
      const resumed = await this.tryResume(client, existing.id, template.id)
      if (resumed) return resumed
    }

    const podApiKey = generateToken()
    const pod = await this.createWithFallback(client, template, podApiKey)
    return this.record(pod, template.id, podApiKey)
  }

  /**
   * Creates the pod, walking through the template's fallback cards when RunPod
   * reports no capacity.
   *
   * Measured on 2026-08-30: every 48 GB card was at LOW availability, and an
   * L40S that the catalog called HIGH was unavailable three minutes later.
   * Pinning a data center — which a network volume forces — turned that into an
   * outright failure, while the same request unpinned succeeded immediately.
   * So the last resort is to drop the data center preference rather than leave
   * the user with no pod at all.
   */
  private async createWithFallback(
    client: RunpodClient,
    template: Template,
    podApiKey: string,
  ): Promise<runpod.Pod> {
    const fallbacks = await this.usableFallbacks(client, template)
    const attempts: Array<{ gpuTypeId: string; unpinned: boolean }> = [
      ...[template.gpuTypeId, ...fallbacks].map((gpuTypeId) => ({ gpuTypeId, unpinned: false })),
    ]
    // Dropping the data center is only possible without a network volume: the
    // volume exists in exactly one region and the pod must be able to reach it.
    if (!template.networkVolumeId && template.dataCenterIds.length > 0) {
      attempts.push({ gpuTypeId: template.gpuTypeId, unpinned: true })
    }

    let lastError: unknown
    for (const attempt of attempts) {
      const candidate: Template = {
        ...template,
        gpuTypeId: attempt.gpuTypeId,
        ...(attempt.unpinned ? { dataCenterIds: [] } : {}),
      }
      try {
        return await client.createPod(
          buildCreatePodRequest({
            template: candidate,
            podApiKey,
            huggingfaceToken: this.huggingfaceToken(),
          }),
        )
      } catch (error) {
        if (!(error instanceof RunpodError) || !error.isCapacityExhausted) throw error
        lastError = error
      }
    }
    throw lastError instanceof Error
      ? new Error(
          `No capacity for ${[template.gpuTypeId, ...template.gpuFallbackIds].join(', ')}` +
            (template.networkVolumeId
              ? ` in the network volume's data center. Add fallback GPUs, or drop the volume so placement can move.`
              : `. Add fallback GPUs to the template.`),
          { cause: lastError },
        )
      : new Error('Pod creation failed for an unknown reason')
  }

  /**
   * Attempts to wake the pod we already have. Returns null when it cannot be
   * resumed, in which case the caller builds a fresh one.
   *
   * Two ways that happens, both seen in practice:
   *  - The pod is gone. Somebody terminated it in RunPod's own console, or it
   *    was cleaned up. Our record outlives it, and resuming a ghost 404s.
   *  - It comes back with no GPU. RunPod hands back zero GPUs when capacity has
   *    moved on, leaving a pod that bills for storage and serves nothing.
   */
  private async tryResume(
    client: RunpodClient,
    podId: string,
    templateId: string,
  ): Promise<PodRecord | null> {
    let pod: runpod.Pod
    try {
      pod = await client.podAction(podId, 'start')
    } catch (error) {
      if (error instanceof RunpodError && error.status === 404) {
        this.markStopped(podId)
        return null
      }
      // The host gave the card away while the pod was paused. Nothing is wrong
      // with the pod; it simply cannot come back here.
      if (error instanceof RunpodError && error.isHostGpuUnavailable) {
        this.markStopped(podId, 'host-gpu-unavailable')
        return null
      }
      // Already running. RunPod rejects a redundant start with 409, which is
      // agreement, not failure — it happens whenever our record has drifted
      // behind reality, such as after the service restarts.
      if (error instanceof RunpodError && error.status === 409) {
        const current = await client.getPod(podId).catch(() => null)
        return current ? this.record(current, templateId) : null
      }
      throw error
    }

    if ((pod.gpu?.count ?? 0) > 0) return this.record(pod, templateId)

    await client.podAction(podId, 'terminate').catch(() => undefined)
    this.markStopped(podId)
    return null
  }

  /**
   * Fallback cards that are actually safe to land on.
   *
   * A fallback to a *smaller* card is never safe, whatever it costs. Without
   * this check a template asking for a 96 GiB Blackwell fell back to a 48 GiB
   * A40 and would have gone on to a 24 GiB card — quietly undoing the
   * compatibility check that had just been run on the primary choice, and
   * renting hardware that cannot hold the model.
   *
   * Enforced here as well as in the editor: a template can be created through
   * the API, and this is the last point before money is spent.
   */
  private async usableFallbacks(client: RunpodClient, template: Template): Promise<string[]> {
    if (template.gpuFallbackIds.length === 0) return []

    const catalog = await client.listGpuTypes().catch(() => null)
    // Unable to check, so no fallbacks: the user gets the card they chose or
    // nothing. Falling back unverified is precisely the failure this guards
    // against, and an unstartable pod is cheaper than a wrong one.
    if (!Array.isArray(catalog?.gpus)) return []

    const memory = new Map(catalog.gpus.map((gpu) => [gpu.id, gpu.memory]))
    const primary = memory.get(template.gpuTypeId)
    if (primary === undefined) return []

    return template.gpuFallbackIds.filter((id) => (memory.get(id) ?? 0) >= primary)
  }

  async stop(mode: Template['lifecycleMode'], reason = 'manual'): Promise<void> {
    const existing = this.current()
    if (!existing) return
    const client = this.runpod()
    await client.podAction(existing.id, mode === 'stopResume' ? 'stop' : 'terminate')
    this.markStopped(existing.id, reason)
  }

  /**
   * Waits until the pod actually answers requests, not merely until RunPod
   * calls it RUNNING.
   *
   * Those are minutes apart. RunPod reports RUNNING as soon as the container is
   * scheduled; the engine still has to fetch weights, build the KV cache and
   * compile kernels — 140 seconds of that measured on 2026-08-30, on top of the
   * download. A gateway that trusts RUNNING forwards the first request into a
   * port nothing is listening on and hands the client a bare 404.
   */
  async waitUntilServing(podId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    const pod = await this.waitUntilRunning(podId, timeoutMs)
    if (!pod) return false

    const active = this.describe()
    const base = active?.chatUrl ?? active?.embeddingUrl
    if (!base) return false

    let crashChecks = 0
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) })
        if (response.ok) return true
      } catch {
        // Not up yet. The proxy answers 404 or 502 until the engine binds.
      }

      // A misconfigured engine never binds, and waiting the full budget for it
      // teaches the user nothing. Seen live: `--task embed`, removed in vLLM
      // 0.28, made the container restart in a loop while a client request was
      // held for seven minutes and then told to "retry shortly".
      crashChecks += 1
      if (crashChecks % 4 === 0 && (await this.engineIsCrashLooping(podId))) {
        throw new Error(
          'The inference engine keeps exiting on startup. Check the pod log — usually a wrong argument or a model the engine cannot load.',
        )
      }

      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
    }
    return false
  }

  /**
   * Looks for the engine restarting repeatedly, which means it will never come
   * up on its own no matter how long the caller waits.
   */
  private async engineIsCrashLooping(podId: string): Promise<boolean> {
    const logs = await this.runpod()
      .getPodLogs(podId)
      .catch(() => '')

    const restarts = logs.match(/start container for /g)?.length ?? 0
    const fatal = /error: unrecognized arguments|Traceback \(most recent call last\)|ValueError:/.test(logs)
    return restarts >= 3 && fatal
  }

  /** Polls RunPod until the pod reports RUNNING, or the deadline passes. */
  async waitUntilRunning(podId: string, timeoutMs: number): Promise<runpod.Pod | null> {
    const deadline = Date.now() + timeoutMs
    const client = this.runpod()
    while (Date.now() < deadline) {
      const pod = await client.getPod(podId)
      this.db
        .prepare('UPDATE pods SET status = ?, cost_per_hour = ?, last_seen_at = ? WHERE id = ?')
        .run(pod.status, pod.cost, new Date().toISOString(), podId)
      if (pod.status === 'RUNNING') return pod
      if (pod.status === 'ERROR' || pod.status === 'TERMINATED') return null
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
    }
    return null
  }

  /**
   * Every pod this launcher knows about, with how far along each one is.
   *
   * Taken from RunPod rather than from our own table: a pod started here and
   * then left behind still costs money, and one that is invisible cannot be
   * stopped.
   */
  async listAll(): Promise<PodStatusReport[]> {
    const live = await this.runpod()
      .listPods()
      .then((result) => result.pods)
      .catch(() => [])

    const known = this.db
      .prepare('SELECT id, template_id AS templateId, started_at AS startedAt FROM pods')
      .all() as Array<{ id: string; templateId: string | null; startedAt: string | null }>
    const byId = new Map(known.map((row) => [row.id, row]))
    const currentId = this.current()?.id ?? null

    const names = new Map(
      (this.db.prepare('SELECT id, name FROM templates').all() as Array<{ id: string; name: string }>).map(
        (row) => [row.id, row.name],
      ),
    )

    return Promise.all(
      live.map(async (pod) => {
        const record = byId.get(pod.id)
        const readiness = await this.readinessOf(pod)
        const startedAt = pod.startedAt ?? record?.startedAt ?? null
        return {
          id: pod.id,
          templateId: record?.templateId ?? '',
          templateName: record?.templateId ? (names.get(record.templateId) ?? null) : null,
          runpodStatus: pod.status,
          readiness: readiness.state,
          costPerHour: pod.cost,
          runningForSeconds: startedAt ? Math.round((Date.now() - new Date(startedAt).getTime()) / 1000) : null,
          detail: readiness.detail,
          gpu: pod.gpu?.id ?? null,
          isActive: pod.id === currentId,
        }
      }),
    )
  }

  /** Does the active pod's engine answer right now? */
  async engineAnswers(): Promise<boolean> {
    const active = this.describe()
    const base = active?.chatUrl ?? active?.embeddingUrl
    if (!base) return false
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4_000) })
      return response.ok
    } catch {
      return false
    }
  }

  /** Asks the pod's own engine whether it is serving yet. */
  private async readinessOf(pod: runpod.Pod): Promise<{ state: Readiness; detail: string | null }> {
    if (pod.status === 'PROVISIONING' || pod.status === 'STARTING') {
      return { state: 'provisioning', detail: null }
    }
    if (pod.status !== 'RUNNING') return { state: 'stopped', detail: null }

    for (const port of [POD_PORTS.chat, POD_PORTS.embedding]) {
      try {
        const response = await fetch(`${podProxyUrl(pod.id, port)}/health`, {
          signal: AbortSignal.timeout(4_000),
        })
        if (response.ok) return { state: 'ready', detail: null }
      } catch {
        // Still coming up, or this port is not in use by this template.
      }
    }

    if (await this.engineIsCrashLooping(pod.id)) {
      return {
        state: 'failed',
        detail: 'The engine keeps exiting on startup. Check the pod log — usually a wrong argument or a model it cannot load.',
      }
    }
    return { state: 'preparing', detail: null }
  }

  /**
   * Stops or terminates any pod, not only the active one.
   *
   * A redundant action is agreement rather than failure: stopping an
   * already-stopped pod, or deleting one RunPod has already removed, is the
   * state the caller wanted.
   */
  async act(podId: string, action: 'stop' | 'terminate', reason = 'manual'): Promise<void> {
    try {
      await this.runpod().podAction(podId, action)
    } catch (error) {
      const benign =
        error instanceof RunpodError && (error.status === 409 || error.status === 404)
      if (!benign) throw error
    }
    this.markStopped(podId, reason)
  }

  /**
   * Resumes a pod that was paused, and makes it the one the gateway uses.
   *
   * The counterpart to pausing. Without it a paused pod could only be deleted,
   * which throws away the model it has already downloaded — the whole reason
   * for pausing rather than deleting in the first place.
   */
  async resume(podId: string): Promise<PodRecord> {
    const row = this.db
      .prepare('SELECT template_id AS templateId FROM pods WHERE id = ?')
      .get(podId) as { templateId: string | null } | undefined
    if (!row?.templateId) throw new Error('That pod is not one this launcher created.')

    const client = this.runpod()
    const resumed = await this.tryResume(client, podId, row.templateId)
    if (!resumed) {
      throw new Error(
        'This pod cannot be resumed: the machine it was paused on has no free GPU any more. ' +
          'Create a new pod from the same template — the model will be downloaded again.',
      )
    }
    this.select(podId)
    return resumed
  }

  /** Makes an existing pod the one the gateway routes to. */
  select(podId: string): boolean {
    const row = this.db.prepare('SELECT id FROM pods WHERE id = ?').get(podId) as { id: string } | undefined
    if (!row) return false
    // One pod serves at a time; the others are marked stopped locally so the
    // gateway has an unambiguous target.
    this.db.prepare("UPDATE pods SET stopped_at = COALESCE(stopped_at, ?) WHERE id != ?").run(
      new Date().toISOString(),
      podId,
    )
    this.db.prepare('UPDATE pods SET stopped_at = NULL WHERE id = ?').run(podId)
    return true
  }

  /** Describes the running pod to the gateway, or null when nothing serves. */
  describe(): ActivePod | null {
    const record = this.current()
    if (!record || record.status !== 'RUNNING') return null
    const template = this.template(record.templateId)
    if (!template) return null

    const urls = podRoleUrls((port) => podProxyUrl(record.id, port), {
      chat: template.chatModel !== null,
      embedding: template.embeddingModel !== null,
    })

    const servedModels = [template.chatModel, template.embeddingModel]
      .filter((slot) => slot !== null)
      .map((slot) => slot.servedName ?? slot.repoId)

    const podApiKey = this.podApiKeyFor(record.id)
    if (!podApiKey) return null

    return { ...urls, podApiKey, servedModels }
  }

  private record(pod: runpod.Pod, templateId: string, podApiKey?: string): PodRecord {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, started_at, last_seen_at, api_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status,
                                       cost_per_hour = excluded.cost_per_hour,
                                       stopped_at = NULL,
                                       stop_reason = NULL,
                                       last_seen_at = excluded.last_seen_at,
                                       -- A resume keeps the key it was created with.
                                       api_key = COALESCE(excluded.api_key, pods.api_key)`,
      )
      .run(
        pod.id,
        templateId,
        pod.status,
        pod.cost,
        now,
        pod.startedAt ?? now,
        now,
        podApiKey === undefined ? null : this.seal.encrypt(podApiKey),
      )
    return { id: pod.id, templateId, status: pod.status, costPerHour: pod.cost }
  }

  private markStopped(podId: string, reason = 'replaced'): void {
    this.db
      .prepare("UPDATE pods SET stopped_at = ?, status = 'EXITED', stop_reason = ? WHERE id = ?")
      .run(new Date().toISOString(), reason, podId)
  }
}
