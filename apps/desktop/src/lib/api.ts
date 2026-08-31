import type { Problem, PublicSettings, SpendReport, Template } from '@runpod-launcher/shared'
import { serviceFetch } from './http.js'

/**
 * Talks to the launcher service.
 *
 * The device token lives in the browser's local storage during development and
 * in the OS keychain once the Tauri shell wraps this; either way it is set once
 * at pairing and never typed again.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface Connection {
  baseUrl: string
  token: string
}

async function request<T>(connection: Connection, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await serviceFetch(new URL(path, connection.baseUrl), {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })
  } catch (cause) {
    // A network-level failure is the common case when the container is down,
    // and it deserves a different message from a rejection by the service.
    throw new ApiError(0, (cause as Error).message)
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(response.status, body.error ?? `${response.status} ${response.statusText}`)
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}

export interface PodView {
  pod: { id: string; templateId: string; status: string; costPerHour: number } | null
  serving: { chatUrl: string | null; embeddingUrl: string | null; servedModels: string[] } | null
  /** Whether a pod has ever been created here — not whether one is up now. */
  everStarted: boolean
}

export interface GpuType {
  id: string
  name: string
  memory: number
  price: { secure?: number; community?: number }
  availability?: 'HIGH' | 'MEDIUM' | 'LOW' | string
}

export interface ModelHit {
  repoId: string
  downloads: number
  pipelineTag: string | null
  gated: boolean
  format: string
  /** Which engine would serve it. Shown so the choice is never silent. */
  engine: 'vllm' | 'llamacpp' | null
}

export interface ModelVerdict {
  details: {
    repoId: string
    weightBytes: number
    format: string
    gated: boolean
    ggufVariants?: Array<{ label: string; variant: string; qualifier: string | null; bytes: number; files: string[] }>
    /** vLLM parsers this model needs, read from its own chat template. */
    toolCallParser?: string | null
    reasoningParser?: string | null
    /** The longest context the model itself supports, whatever the card allows. */
    nativeContextTokens?: number | null
  }
  compatible: boolean
  problems: Problem[]
  headroomGib: number | null
}

export interface SpendSnapshot {
  todayUsd: number
  monthUsd: number
  /** The part that is the launcher's arithmetic, not RunPod's bill. */
  estimatedUsd: number
  dailyLimitUsd: number | null
  monthlyLimitUsd: number | null
}

export interface ScheduleAction {
  do: 'start' | 'stop' | 'nothing'
  because: string
}

/** What the schedule would do to one template, and why. */
export interface ScheduledDecision {
  templateId: string
  templateName: string
  action: ScheduleAction
}

export type Readiness = 'provisioning' | 'preparing' | 'ready' | 'failed' | 'stopped'

export interface PodStatusReport {
  id: string
  templateId: string
  templateName: string | null
  runpodStatus: string
  readiness: Readiness
  costPerHour: number
  runningForSeconds: number | null
  detail: string | null
  gpu: string | null
  isActive: boolean
}

export interface SelfTestResult {
  ok: boolean
  status?: number
  durationMs?: number
  reason?: string
  detail?: string
}

export interface ActivityEvent {
  at: string
  by: 'schedule' | 'you'
  action: string
  detail: Record<string, unknown> | null
}

export interface ClientToken {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  /** The template this access reaches, or null while it is unassigned. */
  templateId: string | null
}

export const api = {
  /** Exchanges a pairing code for a device token. Needs no token itself. */
  async pair(baseUrl: string, code: string, deviceName: string): Promise<{ token: string; deviceId: string }> {
    const response = await serviceFetch(new URL('/pair', baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName }),
    })
    const body = (await response.json().catch(() => ({}))) as { token?: string; deviceId?: string; error?: string }
    if (!response.ok || !body.token) throw new ApiError(response.status, body.error ?? 'Pairing failed')
    return { token: body.token, deviceId: body.deviceId ?? '' }
  },

  health: (baseUrl: string) => serviceFetch(new URL('/health', baseUrl)).then((r) => r.json()),

  settings: (c: Connection) => request<PublicSettings>(c, '/settings'),
  saveSettings: (c: Connection, patch: Record<string, unknown>) =>
    request<PublicSettings>(c, '/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  verifyRunpodKey: (c: Connection) =>
    request<{ valid: boolean; error?: string }>(c, '/settings/verify-runpod', { method: 'POST' }),

  templates: (c: Connection) => request<{ templates: Template[] }>(c, '/templates'),
  createTemplate: (c: Connection, template: Record<string, unknown>) =>
    request<Template>(c, '/templates', { method: 'POST', body: JSON.stringify(template) }),

  pod: (c: Connection, templateId?: string) =>
    request<PodView>(c, templateId ? `/pod?templateId=${encodeURIComponent(templateId)}` : '/pod'),
  startPod: (c: Connection, templateId: string) =>
    request<{ id: string }>(c, '/pod/start', { method: 'POST', body: JSON.stringify({ templateId }) }),
  stopPod: (c: Connection, templateId?: string) =>
    request<{ stopped: string | null }>(c, '/pod/stop', {
      method: 'POST',
      body: JSON.stringify(templateId ? { templateId } : {}),
    }),

  pods: (c: Connection) => request<{ pods: PodStatusReport[] }>(c, '/pods'),
  activity: (c: Connection) => request<{ events: ActivityEvent[] }>(c, '/activity'),
  startOnePod: (c: Connection, id: string) =>
    request<{ id: string }>(c, `/pods/${id}/start`, { method: 'POST', body: '{}' }),
  stopOnePod: (c: Connection, id: string) => request<unknown>(c, `/pods/${id}/stop`, { method: 'POST', body: '{}' }),
  deletePod: (c: Connection, id: string) => request<void>(c, `/pods/${id}`, { method: 'DELETE' }),
  selfTest: (c: Connection, templateId?: string) =>
    request<SelfTestResult>(c, '/pod/selftest', {
      method: 'POST',
      body: JSON.stringify(templateId ? { templateId } : {}),
    }),
  updateTemplate: (c: Connection, id: string, template: Record<string, unknown>) =>
    request<Template & { appliesToNextPod: boolean }>(c, `/templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(template),
    }),
  deleteTemplate: (c: Connection, id: string) => request<void>(c, `/templates/${id}`, { method: 'DELETE' }),

  gpus: (c: Connection) => request<{ gpus: GpuType[] }>(c, '/catalog/gpus'),

  spend: (c: Connection) => request<SpendSnapshot>(c, '/spend'),
  schedulePreview: (c: Connection) => request<{ actions: ScheduledDecision[] }>(c, '/schedule/preview'),
  /** The breakdown behind the two figures: per day and per template. */
  spendReport: (c: Connection) => request<SpendReport>(c, '/spend/report'),

  searchModels: (c: Connection, q: string, kind: 'chat' | 'embedding') =>
    request<{ models: ModelHit[] }>(c, `/models/search?q=${encodeURIComponent(q)}&kind=${kind}`),
  evaluateModel: (c: Connection, body: Record<string, unknown>) =>
    request<ModelVerdict>(c, '/models/evaluate', { method: 'POST', body: JSON.stringify(body) }),

  clientTokens: (c: Connection) => request<{ tokens: ClientToken[] }>(c, '/client-tokens'),
  createClientToken: (c: Connection, name: string, templateId: string | null) =>
    request<{ id: string; token: string }>(c, '/client-tokens', {
      method: 'POST',
      body: JSON.stringify({ name, templateId }),
    }),
  /** Points an existing access at another template, without touching the client. */
  assignClientToken: (c: Connection, id: string, templateId: string | null) =>
    request<{ id: string; templateId: string | null }>(c, `/client-tokens/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ templateId }),
    }),
  revokeClientToken: (c: Connection, id: string) =>
    request<void>(c, `/client-tokens/${id}/revoke`, { method: 'POST', body: '{}' }),
  /** Only for an access that is already blocked; the service refuses otherwise. */
  deleteClientToken: (c: Connection, id: string) =>
    request<void>(c, `/client-tokens/${id}`, { method: 'DELETE' }),
}
