import type { Engine, WeightFormat } from './engine.js'

/**
 * What to run a model with, given the format its weights are in.
 *
 * The engine is not a free choice: GGUF belongs to llama.cpp and everything
 * else to vLLM. Making the user pick, and then silently starting the wrong one,
 * is how a perfectly good 4-bit build ends up as a pod that crash-loops on an
 * argument the engine does not know.
 *
 * `args` uses the same placeholders as a template: `{{chatModel}}`,
 * `{{apiKey}}`, `{{maxModelLen}}`, `{{totalContext}}`, `{{chatGpuFraction}}`,
 * `{{maxConcurrentSequences}}`, `{{mountPath}}`.
 *
 * Note that the same template setting means different things to the two
 * engines, which is why they cannot share one argument string.
 */
export interface EnginePreset {
  engine: Engine
  image: string
  chatArgs: string
  embeddingArgs: string
  /** Sensible number of concurrent requests for this engine. */
  defaultConcurrency: number
  /** Shown in the editor so the choice is not silent. */
  note: string
}

export const VLLM_PRESET: EnginePreset = {
  engine: 'vllm',
  defaultConcurrency: 64,
  // Pinned deliberately: `latest` has broken freshly released architectures.
  image: 'vllm/vllm-openai:v0.28.0',
  chatArgs:
    '{{chatModel}} --port 8000 --host 0.0.0.0 --api-key {{apiKey}}' +
    ' --max-model-len {{maxModelLen}} --gpu-memory-utilization {{chatGpuFraction}}' +
    ' --max-num-seqs {{maxConcurrentSequences}}',
  embeddingArgs:
    '{{embeddingModel}} --port 8001 --host 0.0.0.0 --api-key {{apiKey}}' +
    ' --gpu-memory-utilization {{embeddingGpuFraction}}',
  note: 'vLLM — highest throughput, reads FP8, AWQ, GPTQ and unquantised weights.',
}

export const LLAMACPP_PRESET: EnginePreset = {
  engine: 'llamacpp',
  image: 'ghcr.io/ggml-org/llama.cpp:server-cuda',
  /**
   * Concurrent requests multiply memory here, because each slot is given its
   * own share of the shared context. vLLM's default of 64 would ask for a
   * million tokens of cache; four is a sane starting point for one person and
   * their agents.
   */
  defaultConcurrency: 4,
  // llama-server takes a HuggingFace repo directly with -hf, and picks the
  // quantisation from the tag after the colon.
  // `--ctx-size` is the budget for all slots together, so it is the per-request
  // window multiplied by the number of slots. Passing the per-request figure
  // straight through left each slot with a 256-token window.
  chatArgs:
    '-hf {{chatModel}} --host 0.0.0.0 --port 8000 --api-key {{apiKey}}' +
    ' --ctx-size {{totalContext}} --n-gpu-layers 999 --parallel {{maxConcurrentSequences}}',
  embeddingArgs:
    '-hf {{embeddingModel}} --host 0.0.0.0 --port 8001 --api-key {{apiKey}}' +
    ' --embedding --n-gpu-layers 999',
  note: 'llama.cpp — the only engine that reads GGUF, so 5-bit and 6-bit builds work here and nowhere else.',
}

export const PRESETS: Record<Engine, EnginePreset> = {
  vllm: VLLM_PRESET,
  llamacpp: LLAMACPP_PRESET,
}

/** The preset for a model's weight format, or null if nothing can serve it. */
export function presetForFormat(format: WeightFormat): EnginePreset | null {
  if (format === 'gguf') return LLAMACPP_PRESET
  if (format === 'mlx') return null
  return VLLM_PRESET
}
