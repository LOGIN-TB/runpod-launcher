import { z } from 'zod'
import { ENGINES } from './engine.js'

/**
 * How a template goes to sleep.
 *
 * `stopResume` keeps the pod and its disk: fastest to wake, but RunPod bills
 * idle volume storage at double rate and may hand back zero GPUs on resume.
 * `recreate` terminates the pod and rebuilds it against a network volume:
 * cheaper at rest and free to pick any available GPU, at the cost of a longer
 * start and a new pod address each time.
 */
export const lifecycleModeSchema = z.enum(['stopResume', 'recreate'])
export type LifecycleMode = z.infer<typeof lifecycleModeSchema>

const modelSlotSchema = z.object({
  /** HuggingFace repository id, e.g. `Qwen/Qwen3.8-27B-FP8`. */
  repoId: z.string().min(1),
  /** Branch, tag or commit. Defaults to the repo's default branch. */
  revision: z.string().optional(),
  /**
   * Which build to load from a GGUF repository, e.g. `Q4_K_M`.
   *
   * A GGUF repository is a set of alternatives, not one model — the same
   * weights at a dozen precisions, sometimes several model variants each. The
   * choice belongs in the template, or the engine picks for itself.
   */
  quantisation: z.string().optional(),
  /**
   * Name this model answers to in OpenAI requests. Defaults to `repoId`, which
   * is what most clients send.
   */
  servedName: z.string().optional(),
  /**
   * Share of total GPU memory this process may claim (vLLM's
   * `--gpu-memory-utilization`). Left unset, the service splits what is
   * available between the active slots.
   */
  gpuMemoryFraction: z.number().gt(0).lte(1).optional(),
})

export type ModelSlot = z.infer<typeof modelSlotSchema>

const scheduleSchema = z.object({
  enabled: z.boolean().default(false),
  /** IANA zone, e.g. `Europe/Berlin`. */
  timezone: z.string().default('UTC'),
  /** 0 = Sunday, matching `Date#getDay`. */
  weekdays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
  /** `HH:MM` in the zone above. */
  startAt: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  stopAt: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  /** Stop the pod after this many minutes without a request. 0 disables it. */
  idleStopMinutes: z.number().int().min(0).default(0),
  /** Terminate unconditionally after this many hours. Guards against a stuck pod. */
  maxRuntimeHours: z.number().int().min(0).default(12),
})

export const templateSchema = z
  .object({
    id: z.string(),
    name: z.string().min(1),
    engine: z.enum(ENGINES).default('vllm'),
    /** Container image. Pinned deliberately — `latest` has broken model support before. */
    image: z.string().min(1),

    chatModel: modelSlotSchema.nullable().default(null),
    embeddingModel: modelSlotSchema.nullable().default(null),

    gpuTypeId: z.string().min(1),
    /**
     * Cards to fall back to, in order, when the preferred one has no capacity.
     *
     * Not a nicety: in testing, every 48 GB card on RunPod sat at LOW
     * availability, and a start pinned to one card and one data center failed
     * outright. A schedule that wakes a pod at 07:00 needs somewhere else to go.
     */
    gpuFallbackIds: z.array(z.string()).default([]),
    gpuCount: z.number().int().min(1).default(1),
    cloud: z.enum(['SECURE', 'COMMUNITY']).default('SECURE'),
    dataCenterIds: z.array(z.string()).default([]),

    containerDiskGb: z.number().int().min(10).default(50),
    networkVolumeId: z.string().nullable().default(null),
    networkVolumeMountPath: z.string().default('/workspace'),

    /** Context window. Left unset, the engine's own default applies. */
    maxModelLen: z.number().int().positive().optional(),

    /**
     * Maximum concurrent sequences the engine will admit.
     *
     * Worth setting explicitly for hybrid-attention models. Qwen3.8's Gated
     * DeltaNet layers need one recurrent cache block *per concurrent sequence*,
     * and that budget comes out of whatever VRAM the weights leave behind. On a
     * 48 GB card with 28.5 GB of weights only 211 blocks fit, so vLLM's default
     * of 256 makes the engine refuse to start:
     *
     *   ValueError: max_num_seqs (256) exceeds available Mamba cache blocks (211)
     *
     * Measured on an L40S, 2026-08-30. A plain transformer has no such limit,
     * which is why the default is left unset rather than lowered for everyone.
     */
    maxConcurrentSequences: z.number().int().positive().optional(),

    /**
     * Arguments appended to the image's entrypoint, with placeholders filled in:
     * `{{chatModel}}`, `{{embeddingModel}}`, `{{apiKey}}`, `{{maxModelLen}}`,
     * `{{chatGpuFraction}}`, `{{embeddingGpuFraction}}`, `{{mountPath}}`.
     *
     * The launcher's own pod image needs none of this — it reads environment
     * variables. This exists so a stock image (`vllm/vllm-openai`, whose
     * entrypoint is `vllm serve`) or any other inference server can be used
     * without building anything first.
     */
    args: z.string().optional(),
    env: z.record(z.string(), z.string()).default({}),

    lifecycleMode: lifecycleModeSchema.default('recreate'),
    schedule: scheduleSchema.prefault({}),
  })
  .refine((t) => t.chatModel !== null || t.embeddingModel !== null, {
    message: 'A template needs at least one model — chat, embedding, or both.',
    path: ['chatModel'],
  })
  .refine((t) => t.lifecycleMode !== 'recreate' || t.networkVolumeId !== null, {
    message:
      'Rebuilding the pod each time only makes sense with a network volume — otherwise the model is downloaded again on every start.',
    path: ['networkVolumeId'],
  })

export type Template = z.infer<typeof templateSchema>

/** Ports the pod exposes, by role. Both are always published; only started processes listen. */
export const POD_PORTS = { chat: 8000, embedding: 8001 } as const
