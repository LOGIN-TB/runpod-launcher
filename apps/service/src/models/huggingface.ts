import type { Engine, WeightFormat } from '@runpod-launcher/shared'
import { checkCompatibility } from '@runpod-launcher/shared'

const API = 'https://huggingface.co/api'

export interface ModelSearchHit {
  repoId: string
  downloads: number
  likes: number
  pipelineTag: string | null
  gated: boolean
}

/** One downloadable quantisation inside a GGUF repository. */
export interface GgufVariant {
  /** Quantisation label, e.g. `Q4_K_M`. */
  label: string
  bytes: number
  /** Files to fetch — more than one when the weights are sharded. */
  files: string[]
}

export interface ModelDetails {
  repoId: string
  /**
   * Size of the weights that would actually be downloaded.
   *
   * For a normal repository this is the sum of its weight files. For a GGUF
   * repository it is the size of one variant — such a repo carries every
   * quantisation side by side, and summing them gives an absurd number
   * (`unsloth/Qwen3.8-27B-GGUF` totals 472 GB across 20-odd variants of a
   * 27B model).
   */
  weightBytes: number
  /** Present only for GGUF repositories: the quantisations on offer. */
  ggufVariants?: GgufVariant[]
  format: WeightFormat
  /** True when the repo requires accepting terms before download. */
  gated: boolean
  /** Set when we could not read the config — the repo may be gated or private. */
  inaccessible: string | null
}

export interface ModelVerdict {
  details: ModelDetails
  compatible: boolean
  problems: string[]
  /** VRAM left for the KV cache after weights and the other slot, in GiB. */
  headroomGib: number | null
}

type Kind = 'chat' | 'embedding'

/** HuggingFace pipeline tags that belong in each model slot. */
const SLOT_TAGS: Record<Kind, string[]> = {
  chat: ['text-generation', 'image-text-to-text'],
  embedding: ['feature-extraction', 'sentence-similarity'],
}

export class HuggingFaceClient {
  constructor(
    private readonly token: () => string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    const token = this.token()
    return token ? { Authorization: `Bearer ${token}`, Accept: 'application/json' } : { Accept: 'application/json' }
  }

  /** Searches the hub, restricted to models that suit the given slot. */
  async search(query: string, kind: Kind, limit = 20): Promise<ModelSearchHit[]> {
    const results = await Promise.all(
      SLOT_TAGS[kind].map(async (tag) => {
        const url = new URL(`${API}/models`)
        url.searchParams.set('search', query)
        url.searchParams.set('pipeline_tag', tag)
        url.searchParams.set('sort', 'downloads')
        url.searchParams.set('direction', '-1')
        url.searchParams.set('limit', String(limit))
        const response = await this.fetchImpl(url, { headers: this.headers() })
        if (!response.ok) return []
        return (await response.json()) as Array<Record<string, unknown>>
      }),
    )

    return results
      .flat()
      .map((raw) => ({
        repoId: String(raw.id ?? raw.modelId ?? ''),
        downloads: Number(raw.downloads ?? 0),
        likes: Number(raw.likes ?? 0),
        pipelineTag: (raw.pipeline_tag as string | undefined) ?? null,
        gated: Boolean(raw.gated),
      }))
      .filter((hit) => hit.repoId.length > 0)
      .sort((a, b) => b.downloads - a.downloads)
      .slice(0, limit)
  }

  /**
   * Reads a repo's file list and config to work out how big it is and what
   * format the weights are in.
   *
   * Doing this before a pod is rented is the whole point: an incompatible
   * choice otherwise fails after several minutes of downloading, on a GPU that
   * is already being billed.
   */
  async inspect(repoId: string, revision?: string): Promise<ModelDetails> {
    const ref = revision ? `/revision/${encodeURIComponent(revision)}` : ''
    const url = `${API}/models/${repoId}${ref}?blobs=true`
    const response = await this.fetchImpl(url, { headers: this.headers() })

    if (!response.ok) {
      const reason =
        response.status === 401 || response.status === 403
          ? 'This repository is gated. Accept its terms on HuggingFace and add a token with access in Settings.'
          : response.status === 404
            ? 'No such repository, or the revision does not exist.'
            : `HuggingFace returned ${response.status}.`
      return { repoId, weightBytes: 0, format: 'unknown', gated: response.status === 403, inaccessible: reason }
    }

    const info = (await response.json()) as {
      siblings?: Array<{ rfilename: string; size?: number }>
      gated?: boolean | string
      config?: { quantization_config?: { quant_method?: string; fmt?: string } }
    }

    const files = info.siblings ?? []
    const format = detectFormat(repoId, files.map((f) => f.rfilename), info.config?.quantization_config)

    if (format === 'gguf') {
      const variants = groupGgufVariants(files)
      const preferred = pickDefaultGgufVariant(variants)
      return {
        repoId,
        weightBytes: preferred?.bytes ?? 0,
        ggufVariants: variants,
        format,
        gated: Boolean(info.gated),
        inaccessible: null,
      }
    }

    return {
      repoId,
      weightBytes: files
        .filter((file) => /\.(safetensors|bin)$/i.test(file.rfilename))
        .reduce((sum, file) => sum + (file.size ?? 0), 0),
      format,
      gated: Boolean(info.gated),
      inaccessible: null,
    }
  }

  /** Full verdict: can this model run here, and what is left for context? */
  async evaluate(args: {
    repoId: string
    revision?: string
    kind: Kind
    engine: Engine
    gpuDisplayName: string
    gpuMemoryGb: number
    otherSlotBytes?: number
    gpuMemoryUtilization?: number
  }): Promise<ModelVerdict> {
    const details = await this.inspect(args.repoId, args.revision)
    const problems: string[] = []

    if (details.inaccessible) {
      return { details, compatible: false, problems: [details.inaccessible], headroomGib: null }
    }

    const verdict = checkCompatibility({
      engine: args.engine,
      format: details.format,
      gpuDisplayName: args.gpuDisplayName,
    })
    if (!verdict.ok) problems.push(verdict.detail)

    const weightsGib = bytesToGib(details.weightBytes)
    const otherGib = bytesToGib(args.otherSlotBytes ?? 0)
    const headroomGib = estimateKvHeadroomGib({
      gpuMemoryGib: args.gpuMemoryGb,
      weightsGib,
      otherSlotGib: otherGib,
      ...(args.gpuMemoryUtilization === undefined ? {} : { utilization: args.gpuMemoryUtilization }),
    })

    if (headroomGib <= 0) {
      problems.push(
        `${weightsGib.toFixed(1)} GiB of weights leave no room on a ${args.gpuMemoryGb} GiB card` +
          (otherGib > 0 ? ` alongside the other model's ${otherGib.toFixed(1)} GiB.` : '.'),
      )
    } else if (headroomGib < 4) {
      problems.push(
        `Only ${headroomGib.toFixed(1)} GiB would be left for context. Expect a very short context window.`,
      )
    }

    return { details, compatible: problems.length === 0, problems, headroomGib }
  }
}

const BYTES_PER_GIB = 1024 ** 3

/** HuggingFace reports file sizes in decimal bytes; GPUs and vLLM talk in GiB. */
export const bytesToGib = (bytes: number): number => bytes / BYTES_PER_GIB

/**
 * Estimates how much VRAM is left for the KV cache, in **GiB**.
 *
 * Everything here is GiB on purpose. Card capacities and vLLM's own numbers are
 * GiB, while HuggingFace file sizes are decimal bytes — mixing the two is a 7%
 * error, which on a 48 GiB card invents 3.5 GB of headroom that is not there.
 *
 * Two deductions beyond the weights:
 *  - `--gpu-memory-utilization` caps what the engine may touch at all.
 *  - CUDA context, activations and captured CUDA graphs take a slice on top.
 *
 * That second slice is proportional, not fixed. Measured on 2026-08-30, same
 * engine and settings:
 *
 *   L40S 48 GiB, FP8     45.12 usable - 28.51 weights - 10.58 KV = 6.03 overhead
 *   L40S 48 GiB, INT4    45.12 usable - 17.71 weights - 21.58 KV = 5.83 overhead
 *   RTX PRO 4500 32 GiB  30.08 usable - 17.71 weights -  9.38 KV = 2.99 overhead
 *
 * A fixed 6 GiB fits the first two and is twice the truth on the third. 12% of
 * the capped budget lands within about 0.6 GiB of all three, so that is what is
 * used — with the caveat that it is a fit to three points, not a model of what
 * the allocator actually does. Treat the result as an estimate to warn on, not
 * a promise.
 */
export function estimateKvHeadroomGib(args: {
  gpuMemoryGib: number
  weightsGib: number
  otherSlotGib?: number
  utilization?: number
}): number {
  const OVERHEAD_SHARE = 0.12
  const usable = args.gpuMemoryGib * (args.utilization ?? 0.94)
  return usable * (1 - OVERHEAD_SHARE) - args.weightsGib - (args.otherSlotGib ?? 0)
}

/**
 * Groups a GGUF repository's files into one entry per quantisation.
 *
 * Filenames follow `Name-Q4_K_M.gguf`, and large ones are sharded as
 * `Name-Q8_0-00001-of-00002.gguf`. The shards of one quantisation belong
 * together; different quantisations are alternatives, not parts.
 */
export function groupGgufVariants(
  files: ReadonlyArray<{ rfilename: string; size?: number }>,
): GgufVariant[] {
  const groups = new Map<string, GgufVariant>()

  for (const file of files) {
    if (!/\.gguf$/i.test(file.rfilename)) continue
    const name = file.rfilename.replace(/^.*\//, '')
    const withoutShard = name.replace(/-\d{5}-of-\d{5}\.gguf$/i, '').replace(/\.gguf$/i, '')
    const label = /-(I?Q\d[^-]*|BF16|F16|F32)$/i.exec(withoutShard)?.[1]?.toUpperCase() ?? withoutShard

    const existing = groups.get(label)
    if (existing) {
      existing.bytes += file.size ?? 0
      existing.files.push(file.rfilename)
    } else {
      groups.set(label, { label, bytes: file.size ?? 0, files: [file.rfilename] })
    }
  }

  return [...groups.values()].sort((a, b) => a.bytes - b.bytes)
}

/**
 * Picks a sensible default from a GGUF repository: the largest variant at or
 * below 8-bit. Q8_0 is close to lossless, and anything above it is the
 * unquantised weights, which defeat the point of choosing GGUF.
 */
export function pickDefaultGgufVariant(variants: readonly GgufVariant[]): GgufVariant | null {
  const eightBitOrLess = variants.filter((v) => /^I?Q[1-8]/i.test(v.label))
  const pool = eightBitOrLess.length > 0 ? eightBitOrLess : variants
  return pool.at(-1) ?? null
}

/**
 * Works out the weight format from the repo's own metadata, falling back to the
 * name. `quantization_config` is authoritative; names are a convention.
 */
export function detectFormat(
  repoId: string,
  filenames: readonly string[],
  quantConfig?: { quant_method?: string; fmt?: string },
): WeightFormat {
  if (filenames.some((name) => /\.gguf$/i.test(name))) return 'gguf'

  const method = (quantConfig?.quant_method ?? '').toLowerCase()
  if (method.includes('awq')) return 'awq'
  if (method.includes('gptq')) return 'gptq'
  if (method.includes('fp8') || (quantConfig?.fmt ?? '').toLowerCase().includes('e4m3')) return 'fp8'
  if (method.includes('compressed-tensors')) {
    // compressed-tensors covers several widths; the name carries which one.
    return /w4a16|int4/i.test(repoId) ? 'awq' : 'fp8'
  }

  const name = repoId.toLowerCase()
  if (name.includes('gguf')) return 'gguf'
  if (name.includes('awq') || /w4a16|int4/.test(name)) return 'awq'
  if (name.includes('gptq')) return 'gptq'
  if (name.includes('fp8')) return 'fp8'
  if (/int8|w8a/.test(name)) return 'fp8'
  return 'unknown'
}
