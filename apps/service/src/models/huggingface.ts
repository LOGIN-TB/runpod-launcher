import type { Engine, Problem, WeightFormat } from '@runpod-launcher/shared'
import {
  bytesToGib,
  checkCompatibility,
  engineForFormat,
  estimateKvHeadroomGib,
  problem,
  UNUSABLE_FORMATS,
} from '@runpod-launcher/shared'

const round1 = (value: number): number => Math.round(value * 10) / 10

const API = 'https://huggingface.co/api'

export interface ModelSearchHit {
  repoId: string
  downloads: number
  likes: number
  pipelineTag: string | null
  gated: boolean
  /** Guessed from the name, so the list can show it without fetching each repo. */
  format: WeightFormat
  /** Which engine would serve it, or null if nothing here can. */
  engine: Engine | null
}

/** One downloadable quantisation inside a GGUF repository. */
export interface GgufVariant {
  /** Quantisation level, e.g. `Q4_K_M`. */
  label: string
  /** Tag that selects this variant for `-hf repo:tag`, unambiguously. */
  variant: string
  /** Set when several builds share a level, to tell them apart on screen. */
  qualifier: string | null
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
  inaccessible: Problem | null
}

export interface ModelVerdict {
  details: ModelDetails
  compatible: boolean
  /** Reasons as codes plus values; the app phrases them in the user's language. */
  problems: Problem[]
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

  /**
   * Searches the hub for models that suit the given slot.
   *
   * Deliberately not a single tagged query. Quantised repositories very often
   * carry no `pipeline_tag` at all — every GGUF build of Qwen3.8 is untagged —
   * so a tag-filtered search makes exactly the small, cheap variants people
   * want invisible while showing the full-size original.
   *
   * The untagged sweep is therefore run alongside the tagged ones and merged.
   */
  async search(query: string, kind: Kind, limit = 20): Promise<ModelSearchHit[]> {
    const queries: Array<Record<string, string>> = [
      ...SLOT_TAGS[kind].map((tag) => ({ pipeline_tag: tag })),
      // No tag: catches the quantised builds, which are usually untagged.
      {},
    ]

    const pages = await Promise.all(
      queries.map(async (extra) => {
        const url = new URL(`${API}/models`)
        url.searchParams.set('search', query)
        url.searchParams.set('sort', 'downloads')
        url.searchParams.set('direction', '-1')
        url.searchParams.set('limit', String(limit * 2))
        for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value)
        const response = await this.fetchImpl(url, { headers: this.headers() })
        if (!response.ok) return []
        return (await response.json()) as Array<Record<string, unknown>>
      }),
    )

    const seen = new Map<string, ModelSearchHit>()
    for (const raw of pages.flat()) {
      const repoId = String(raw.id ?? raw.modelId ?? '')
      if (!repoId || seen.has(repoId)) continue

      const format = detectFormat(repoId, [])
      const engine = engineForFormat(format)

      // Dropped rather than shown as incompatible: an MLX build cannot run on
      // rented NVIDIA hardware under any circumstances, and its huge download
      // count would otherwise push the usable quantisations off the list.
      if (UNUSABLE_FORMATS.includes(format)) continue

      seen.set(repoId, {
        repoId,
        downloads: Number(raw.downloads ?? 0),
        likes: Number(raw.likes ?? 0),
        pipelineTag: (raw.pipeline_tag as string | undefined) ?? null,
        gated: Boolean(raw.gated),
        format,
        engine,
      })
    }

    // Quantised builds first, then by popularity. Someone searching from this
    // app is renting a GPU by the hour; the smaller build is nearly always the
    // one they want, and sorting by downloads alone buries it.
    const quantised = (hit: ModelSearchHit): number =>
      hit.format === 'unknown' || hit.format === 'bf16' || hit.format === 'fp16' ? 1 : 0

    return [...seen.values()]
      .sort((a, b) => quantised(a) - quantised(b) || b.downloads - a.downloads)
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
          ? problem('repo-gated', { repoId })
          : response.status === 404
            ? problem('repo-missing', { repoId })
            : problem('hub-error', { status: response.status })
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
    /** Which GGUF build to size, when the repository offers several. */
    variant?: string
    kind: Kind
    engine: Engine
    gpuDisplayName: string
    gpuMemoryGb: number
    otherSlotBytes?: number
    gpuMemoryUtilization?: number
  }): Promise<ModelVerdict> {
    const details = await this.inspect(args.repoId, args.revision)
    const problems: Problem[] = []

    // A GGUF repository is a set of alternatives, so the size depends entirely
    // on which one is chosen. Sizing the default when the user has picked
    // another is how a 15 GB build gets rejected for not fitting.
    if (args.variant && details.ggufVariants) {
      const chosen = details.ggufVariants.find((candidate) => candidate.variant === args.variant)
      if (chosen) details.weightBytes = chosen.bytes
    }

    if (details.inaccessible) {
      return { details, compatible: false, problems: [details.inaccessible], headroomGib: null }
    }

    const verdict = checkCompatibility({
      engine: args.engine,
      format: details.format,
      gpuDisplayName: args.gpuDisplayName,
    })
    if (!verdict.ok) problems.push(verdict.problem)

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
        problem('does-not-fit', {
          weightsGib: round1(weightsGib),
          cardGib: args.gpuMemoryGb,
          otherGib: round1(otherGib),
        }),
      )
    } else if (headroomGib < 4) {
      problems.push(problem('tight-headroom', { headroomGib: round1(headroomGib) }))
    }

    return { details, compatible: problems.length === 0, problems, headroomGib }
  }
}

/**
 * Groups a GGUF repository's files into the alternatives it actually offers.
 *
 * The grouping key is the whole filename minus any shard suffix, not the
 * quantisation level. A repository routinely carries several distinct models
 * side by side at the same level — a plain build, a `noMTP` build, a small
 * `draft` model — and keying on the level alone welds them into one entry whose
 * size is their sum. That is how a 29 GB Q8_0 was reported as 57 GB and
 * rejected as too large for a card it fits on comfortably.
 *
 * Real shards, named `…-00001-of-00002.gguf`, do belong together and are added.
 */
export function groupGgufVariants(
  files: ReadonlyArray<{ rfilename: string; size?: number }>,
): GgufVariant[] {
  const groups = new Map<string, GgufVariant>()

  for (const file of files) {
    if (!/\.gguf$/i.test(file.rfilename)) continue
    const name = file.rfilename.replace(/^.*\//, '')

    // `mmproj-*` is the vision projector that accompanies a multimodal model,
    // not a model itself. Listing it as a choice offers a 0.9 GB "variant" of
    // a 27B model.
    if (/^mmproj[-_]/i.test(name)) continue

    const base = name.replace(/-\d{5}-of-\d{5}\.gguf$/i, '').replace(/\.gguf$/i, '')

    const existing = groups.get(base)
    if (existing) {
      existing.bytes += file.size ?? 0
      existing.files.push(file.rfilename)
    } else {
      groups.set(base, {
        label: quantisationLabel(base),
        variant: base,
        qualifier: null,
        bytes: file.size ?? 0,
        files: [file.rfilename],
      })
    }
  }

  const variants = [...groups.values()].sort((a, b) => a.bytes - b.bytes)

  // The tag only needs to be as long as it takes to be unambiguous. Where a
  // level appears once, `Q8_0` is enough; where two builds share it, the
  // qualifier in front comes along: `noMTP-Q8_0`.
  const levelCounts = new Map<string, number>()
  for (const variant of variants) levelCounts.set(variant.label, (levelCounts.get(variant.label) ?? 0) + 1)

  for (const variant of variants) {
    if ((levelCounts.get(variant.label) ?? 0) > 1) {
      variant.variant = distinguishingSuffix(variant.variant)
      // Everything before the level, which is what separates the two builds.
      variant.qualifier = variant.variant.slice(0, Math.max(0, variant.variant.length - variant.label.length - 1)) || null
    } else {
      variant.variant = variant.label
    }
  }

  return variants
}

/** The quantisation level in a GGUF filename, e.g. `Q4_K_M`. */
function quantisationLabel(base: string): string {
  return /[-_](I?Q\d[A-Z0-9_]*|BF16|F16|F32)$/i.exec(base)?.[1]?.toUpperCase() ?? base
}

/**
 * What tells one variant from another, for `-hf repo:tag`.
 *
 * llama.cpp matches the tag against the filename, so anything unique to this
 * variant works — `Q4_K_M` for the plain build, `noMTP-Q8_0` for the other one.
 */
function distinguishingSuffix(base: string): string {
  const quant = quantisationLabel(base)
  if (quant === base) return base
  // Keep any qualifier sitting in front of the level, such as `noMTP`.
  const before = base.slice(0, base.length - quant.length - 1)
  const qualifier = /[-_]([A-Za-z][A-Za-z0-9]*)$/.exec(before)?.[1]
  return qualifier && !/^\d+B$/i.test(qualifier) ? `${qualifier}-${quant}` : quant
}

/**
 * Picks a sensible default from a GGUF repository: the largest variant at or
 * below 8-bit. Q8_0 is close to lossless, and anything above it is the
 * unquantised weights, which defeat the point of choosing GGUF.
 */
export function pickDefaultGgufVariant(variants: readonly GgufVariant[]): GgufVariant | null {
  // Draft models are speculative-decoding helpers, a couple of GB each. They
  // are never what somebody means by "the model".
  const candidates = variants.filter((v) => !/draft/i.test(v.variant))
  const quantised = candidates.filter((v) => /^I?Q[1-8]/i.test(v.label))
  const pool = quantised.length > 0 ? quantised : candidates
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
  if (/\bmlx\b/i.test(repoId)) return 'mlx'

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
  if (/\bmlx\b/.test(name)) return 'mlx'
  if (name.includes('nvfp4')) return 'nvfp4'
  if (name.includes('awq') || /w4a16|int4/.test(name)) return 'awq'
  if (name.includes('gptq')) return 'gptq'
  if (name.includes('fp8')) return 'fp8'
  if (/int8|w8a/.test(name)) return 'fp8'
  return 'unknown'
}
