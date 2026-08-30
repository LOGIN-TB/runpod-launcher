import { templateSchema, type Template, type runpod } from '@runpod-launcher/shared'
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
 * Owns the lifecycle of the single active pod.
 *
 * The two sleep modes differ in more than speed. `stopResume` keeps the machine
 * assignment, so it wakes fast — but RunPod may hand back zero GPUs if capacity
 * moved on, and idle volume storage bills at double rate. `recreate` throws the
 * pod away and builds a new one against the network volume: slower to start,
 * cheaper at rest, and free to land on whatever GPU is actually available.
 */
export class PodManager {
  /** Token the pod's own vLLM servers require. Regenerated per pod. */
  private podApiKey: string | null = null
  private startInFlight: Promise<PodRecord> | null = null

  constructor(
    private readonly db: Db,
    private readonly runpod: () => RunpodClient,
    private readonly huggingfaceToken: () => string | null,
  ) {}

  current(): PodRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, template_id AS templateId, status, cost_per_hour AS costPerHour
         FROM pods WHERE stopped_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as PodRecord | undefined
    return row ?? null
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
      const pod = await client.podAction(existing.id, 'start')
      // RunPod warns a resumed pod can come back with no GPU at all. Left
      // unhandled, that is a pod that bills for storage and serves nothing.
      if ((pod.gpu?.count ?? 0) > 0) return this.record(pod, template.id)
      await client.podAction(existing.id, 'terminate').catch(() => undefined)
      this.markStopped(existing.id)
    }

    this.podApiKey = generateToken()
    const pod = await this.createWithFallback(client, template, this.podApiKey)
    return this.record(pod, template.id)
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
    const attempts: Array<{ gpuTypeId: string; unpinned: boolean }> = [
      ...[template.gpuTypeId, ...template.gpuFallbackIds].map((gpuTypeId) => ({
        gpuTypeId,
        unpinned: false,
      })),
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

  async stop(mode: Template['lifecycleMode']): Promise<void> {
    const existing = this.current()
    if (!existing) return
    const client = this.runpod()
    await client.podAction(existing.id, mode === 'stopResume' ? 'stop' : 'terminate')
    this.markStopped(existing.id)
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

  /** Describes the running pod to the gateway, or null when nothing serves. */
  describe(): ActivePod | null {
    const record = this.current()
    if (!record || record.status !== 'RUNNING' || !this.podApiKey) return null
    const template = this.template(record.templateId)
    if (!template) return null

    const urls = podRoleUrls((port) => podProxyUrl(record.id, port), {
      chat: template.chatModel !== null,
      embedding: template.embeddingModel !== null,
    })

    const servedModels = [template.chatModel, template.embeddingModel]
      .filter((slot) => slot !== null)
      .map((slot) => slot.servedName ?? slot.repoId)

    return { ...urls, podApiKey: this.podApiKey, servedModels }
  }

  private record(pod: runpod.Pod, templateId: string): PodRecord {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, started_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status,
                                       cost_per_hour = excluded.cost_per_hour,
                                       stopped_at = NULL,
                                       last_seen_at = excluded.last_seen_at`,
      )
      .run(pod.id, templateId, pod.status, pod.cost, now, pod.startedAt ?? now, now)
    return { id: pod.id, templateId, status: pod.status, costPerHour: pod.cost }
  }

  private markStopped(podId: string): void {
    this.db
      .prepare("UPDATE pods SET stopped_at = ?, status = 'EXITED' WHERE id = ?")
      .run(new Date().toISOString(), podId)
  }
}
