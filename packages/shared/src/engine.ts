/**
 * Inference engines we can start inside a pod, and the model weight formats
 * each one can actually load.
 *
 * This mapping is the reason the app can warn before a pod is rented: picking
 * a GGUF repo for vLLM, or an FP8 repo for a card without hardware FP8, fails
 * only after several minutes of downloading otherwise.
 */
export const ENGINES = ['vllm', 'llamacpp'] as const
export type Engine = (typeof ENGINES)[number]

export const WEIGHT_FORMATS = ['bf16', 'fp16', 'fp8', 'awq', 'gptq', 'gguf', 'unknown'] as const
export type WeightFormat = (typeof WEIGHT_FORMATS)[number]

/** Formats each engine can serve. */
export const ENGINE_FORMATS: Record<Engine, readonly WeightFormat[]> = {
  vllm: ['bf16', 'fp16', 'fp8', 'awq', 'gptq'],
  llamacpp: ['gguf'],
}

/**
 * GPU architectures with hardware FP8 (Ada Lovelace and newer). On anything
 * older — an A100 or A6000, for instance — FP8 weights fall back to slower
 * emulation, so we steer the user to AWQ or GPTQ instead.
 */
const FP8_CAPABLE = /\b(ada|l40|l4|rtx\s?(40|50)|rtx\s?pro|h100|h200|b200|blackwell|hopper)\b/i

export function gpuSupportsFp8(gpuDisplayName: string): boolean {
  return FP8_CAPABLE.test(gpuDisplayName)
}

export type CompatibilityVerdict =
  | { ok: true }
  | { ok: false; reason: 'format-engine-mismatch' | 'fp8-unsupported-gpu'; detail: string }

/** Checks a model's weight format against the chosen engine and GPU. */
export function checkCompatibility(args: {
  engine: Engine
  format: WeightFormat
  gpuDisplayName: string
}): CompatibilityVerdict {
  const { engine, format, gpuDisplayName } = args

  if (format !== 'unknown' && !ENGINE_FORMATS[engine].includes(format)) {
    return {
      ok: false,
      reason: 'format-engine-mismatch',
      detail: `${format.toUpperCase()} weights cannot be served by ${engine}. Supported: ${ENGINE_FORMATS[engine].join(', ')}.`,
    }
  }

  if (format === 'fp8' && !gpuSupportsFp8(gpuDisplayName)) {
    return {
      ok: false,
      reason: 'fp8-unsupported-gpu',
      detail: `${gpuDisplayName} has no hardware FP8. Expect it to run slower than AWQ or GPTQ on this card.`,
    }
  }

  return { ok: true }
}
