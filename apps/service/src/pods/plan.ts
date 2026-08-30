import { POD_PORTS, type ModelSlot, type Template, type runpod } from '@runpod-launcher/shared'

/**
 * How much of the card each process may claim.
 *
 * vLLM's `--gpu-memory-utilization` is a fraction of *total* GPU memory, and
 * two processes on one card each interpret it independently — so the shares
 * must add up to less than 1 with room left for CUDA context and fragmentation.
 * With only one model active it gets almost the whole card, which directly buys
 * context length.
 */
const HEADROOM = 0.06
const EMBEDDING_SHARE = 0.06

export interface VramSplit {
  chat: number | null
  embedding: number | null
}

export function planVramSplit(template: Template): VramSplit {
  const hasChat = template.chatModel !== null
  const hasEmbedding = template.embeddingModel !== null

  const embedding = hasEmbedding
    ? (template.embeddingModel?.gpuMemoryFraction ?? EMBEDDING_SHARE)
    : null

  if (!hasChat) return { chat: null, embedding: embedding === null ? null : 1 - HEADROOM }

  const chat =
    template.chatModel?.gpuMemoryFraction ?? (hasEmbedding ? 1 - HEADROOM - (embedding ?? 0) : 1 - HEADROOM)

  return { chat: round(chat), embedding: embedding === null ? null : round(embedding) }
}

const round = (n: number): number => Math.round(n * 100) / 100

/** Environment the pod entrypoint reads. Mirrors the contract in pod/start-vllm.sh. */
export function buildPodEnv(args: {
  template: Template
  vram: VramSplit
  podApiKey: string
  huggingfaceToken: string | null
}): Record<string, string> {
  const { template, vram, podApiKey, huggingfaceToken } = args
  const env: Record<string, string> = {
    LAUNCHER_API_KEY: podApiKey,
    // Keeping the HuggingFace cache on the mounted volume is what makes the
    // rebuild-every-time lifecycle viable: no 30 GB download on each start.
    HF_HOME: `${template.networkVolumeMountPath}/huggingface`,
    ...template.env,
  }

  if (huggingfaceToken) env.HF_TOKEN = huggingfaceToken

  addSlot(env, 'CHAT', template.chatModel)
  addSlot(env, 'EMBED', template.embeddingModel)

  if (vram.chat !== null) env.LAUNCHER_CHAT_GPU_FRACTION = String(vram.chat)
  if (vram.embedding !== null) env.LAUNCHER_EMBED_GPU_FRACTION = String(vram.embedding)
  if (template.maxModelLen !== undefined) env.LAUNCHER_CHAT_MAX_LEN = String(template.maxModelLen)
  if (template.maxConcurrentSequences !== undefined) {
    env.LAUNCHER_CHAT_MAX_SEQS = String(template.maxConcurrentSequences)
  }

  return env
}

function addSlot(env: Record<string, string>, prefix: 'CHAT' | 'EMBED', slot: ModelSlot | null): void {
  if (!slot) return
  env[`LAUNCHER_${prefix}_MODEL`] = slot.repoId
  if (slot.revision) env[`LAUNCHER_${prefix}_REVISION`] = slot.revision
  if (slot.servedName) env[`LAUNCHER_${prefix}_SERVED_NAME`] = slot.servedName
}

/**
 * Fills placeholders in a template's `args`. The pod API key is substituted
 * here rather than stored, so it never lands in the template record.
 */
export function renderArgs(args: string, context: {
  template: Template
  vram: VramSplit
  podApiKey: string
}): string {
  const { template, vram, podApiKey } = context
  // llama.cpp selects a build with `repo:tag`; vLLM takes the repository alone.
  const ref = (slot: ModelSlot | null): string =>
    slot === null ? '' : slot.quantisation ? `${slot.repoId}:${slot.quantisation}` : slot.repoId

  const values: Record<string, string> = {
    chatModel: ref(template.chatModel),
    embeddingModel: ref(template.embeddingModel),
    apiKey: podApiKey,
    maxModelLen: template.maxModelLen === undefined ? '' : String(template.maxModelLen),
    maxConcurrentSequences:
      template.maxConcurrentSequences === undefined ? '' : String(template.maxConcurrentSequences),
    /**
     * Context across all slots together, for engines that share one budget.
     *
     * vLLM's `--max-model-len` is per request and independent of how many run
     * at once. llama.cpp's `--ctx-size` is the total, divided by `--parallel`.
     * Passing the same number to both gave 16384/64 = 256 tokens per request,
     * and every agent failed with "request exceeds the available context size
     * (256 tokens)" on its first message.
     */
    totalContext: String((template.maxModelLen ?? 8192) * (template.maxConcurrentSequences ?? 1)),
    chatGpuFraction: vram.chat === null ? '' : String(vram.chat),
    embeddingGpuFraction: vram.embedding === null ? '' : String(vram.embedding),
    mountPath: template.networkVolumeMountPath,
  }
  return args.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole)
}

/** Turns a template into the exact body RunPod's createPod expects. */
export function buildCreatePodRequest(args: {
  template: Template
  podApiKey: string
  huggingfaceToken: string | null
  namePrefix?: string
}): runpod.CreatePodRequest {
  const { template, podApiKey, huggingfaceToken, namePrefix = 'launcher' } = args
  const vram = planVramSplit(template)

  const request: runpod.CreatePodRequest = {
    name: `${namePrefix}-${template.name}`.slice(0, 60),
    image: template.image,
    cloud: template.cloud,
    gpu: { id: template.gpuTypeId, count: template.gpuCount },
    disk: template.containerDiskGb,
    env: buildPodEnv({ template, vram, podApiKey, huggingfaceToken }),
    // Both ports are always published. Only the servers the template enables
    // actually listen, and the gateway knows which those are.
    ports: [`${POD_PORTS.chat}/http`, `${POD_PORTS.embedding}/http`],
  }

  if (template.args) request.args = renderArgs(template.args, { template, vram, podApiKey })
  if (template.dataCenterIds.length > 0) request.dataCenterIds = template.dataCenterIds

  if (template.networkVolumeId) {
    request.mounts = {
      network: [{ volumeId: template.networkVolumeId, path: template.networkVolumeMountPath }],
    }
  }

  return request
}
