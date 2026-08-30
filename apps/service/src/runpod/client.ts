import { OPERATIONS, type runpod } from '@runpod-launcher/shared'

const BASE_URL = 'https://api.runpod.io'

export class RunpodError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    readonly body: string,
  ) {
    super(`RunPod ${operation} failed: ${status} ${body.slice(0, 300)}`)
    this.name = 'RunpodError'
  }

  /**
   * True when RunPod had no matching machine free.
   *
   * This is not an edge case. Capacity for the affordable 48 GB cards is thin
   * and moves within minutes — an L40S reported as HIGH availability was gone
   * three minutes later in testing. Anything that pins placement (a network
   * volume ties every pod to one data center) makes it far more likely.
   *
   * Callers must treat it as "try somewhere else", not as a failure.
   */
  get isCapacityExhausted(): boolean {
    return this.status === 400 && /no longer any instances available/i.test(this.body)
  }
}

type Operation = keyof typeof OPERATIONS

interface CallOptions {
  /** Values substituted into `{placeholders}` in the operation path. */
  params?: Record<string, string>
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  signal?: AbortSignal
}

/**
 * Thin typed wrapper over the RunPod REST API v2.
 *
 * Paths and methods come from `OPERATIONS`, which is generated from RunPod's
 * live OpenAPI spec — nothing here is hand-written from documentation prose.
 */
export class RunpodClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(operation: Operation, options: CallOptions = {}): Promise<T> {
    const spec = OPERATIONS[operation]
    let path: string = spec.path
    for (const [key, value] of Object.entries(options.params ?? {})) {
      path = path.replace(`{${key}}`, encodeURIComponent(value))
    }

    const url = new URL(path, BASE_URL)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const init: RequestInit = {
      method: spec.method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    }

    const response = await this.fetchImpl(url, init)
    if (!response.ok) {
      throw new RunpodError(response.status, operation, await response.text().catch(() => ''))
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  /** Verifies the key works, without changing anything. */
  async verifyKey(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.call('listPods', { query: { limit: 1 }, ...(signal ? { signal } : {}) })
      return true
    } catch (error) {
      if (error instanceof RunpodError && (error.status === 401 || error.status === 403)) return false
      throw error
    }
  }

  listPods(): Promise<{ pods: runpod.Pod[] }> {
    return this.call('listPods')
  }

  getPod(id: string): Promise<runpod.Pod> {
    return this.call('getPod', { params: { id } })
  }

  createPod(body: runpod.CreatePodRequest): Promise<runpod.Pod> {
    return this.call('createPod', { body })
  }

  /** `start` | `stop` | `restart` | `terminate` — the spec's own transitions. */
  podAction(id: string, action: runpod.PodAction): Promise<runpod.Pod> {
    return this.call('podAction', { params: { id }, body: { action } })
  }

  deletePod(id: string): Promise<void> {
    return this.call('deletePod', { params: { id } })
  }

  getPodLogs(id: string): Promise<unknown> {
    return this.call('getPodLogs', { params: { id } })
  }

  /**
   * GPU catalog. `include=AVAILABILITY` is worth the extra field: capacity for
   * the affordable 48 GB cards is thin and moves within minutes, so a stored
   * answer goes stale fast — always ask before starting a pod.
   */
  listGpuTypes(options: { availability?: boolean } = {}): Promise<{ gpus: runpod.GpuType[] }> {
    return this.call('listGpuTypes', {
      query: options.availability ? { include: 'AVAILABILITY', product: 'POD', count: 1 } : {},
    })
  }

  listDataCenters(): Promise<{ dataCenters: runpod.DataCenter[] }> {
    return this.call('listDataCenters')
  }

  /** One data center, optionally with which GPUs it currently has. */
  getDataCenter(id: string, options: { gpuAvailability?: boolean } = {}): Promise<runpod.DataCenter> {
    return this.call('getDataCenter', {
      params: { id },
      query: options.gpuAvailability ? { include: 'GPU_AVAILABILITY' } : {},
    })
  }

  listNetworkVolumes(): Promise<{ networkVolumes: runpod.NetworkVolume[] }> {
    return this.call('listNetworkVolumes')
  }

  createNetworkVolume(body: runpod.CreateNetworkVolumeRequest): Promise<runpod.NetworkVolume> {
    return this.call('createNetworkVolume', { body })
  }

  listTemplates(): Promise<{ templates: runpod.Template[] }> {
    return this.call('listTemplates')
  }

  /** Actual billed cost, rather than our own estimate from hourly rate. */
  listPodBilling(query: { from?: string; to?: string; podId?: string } = {}): Promise<{
    records: runpod.PodBillingRecord[]
  }> {
    return this.call('listPodBilling', { query })
  }
}

/** The public URL RunPod's HTTP proxy assigns to a pod port. */
export function podProxyUrl(podId: string, port: number): string {
  return `https://${podId}-${port}.proxy.runpod.net`
}
