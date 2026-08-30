import { problem, type Problem } from './problems.js'

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
 *
 * Note `l40s?`: RunPod's name for the card is "NVIDIA L40S", and a `\b` after
 * `l40` does not match before the S. That typo made the launcher reject FP8 on
 * the very card it had been measured working on.
 */
const FP8_CAPABLE = /(\bada\b|\bl40s?\b|\bl4\b|rtx\s?(40|50)\d\d|rtx\s?pro|\bh100\b|\bh200\b|\bb200\b|\bb300\b|blackwell|hopper)/i

export function gpuSupportsFp8(gpuDisplayName: string): boolean {
  return FP8_CAPABLE.test(gpuDisplayName)
}

export type CompatibilityVerdict = { ok: true } | { ok: false; problem: Problem }

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
      problem: problem('format-engine-mismatch', {
        format: format.toUpperCase(),
        engine,
        supported: ENGINE_FORMATS[engine].join(', ').toUpperCase(),
      }),
    }
  }

  if (format === 'fp8' && !gpuSupportsFp8(gpuDisplayName)) {
    return { ok: false, problem: problem('fp8-unsupported-gpu', { gpu: gpuDisplayName }) }
  }

  return { ok: true }
}

/**
 * Card names seen on RunPod, with whether they have hardware FP8. Used as a
 * regression fixture — the matcher is name-based and names are irregular.
 */
export const FP8_SUPPORT_FIXTURE: ReadonlyArray<readonly [string, boolean]> = [
  ['NVIDIA L40S', true],
  ['NVIDIA L40', true],
  ['NVIDIA RTX 6000 Ada Generation', true],
  ['NVIDIA RTX PRO 4500 Blackwell', true],
  ['NVIDIA RTX PRO 6000 Blackwell Workstation Edition', true],
  ['NVIDIA H100 PCIe', true],
  ['NVIDIA H200', true],
  ['NVIDIA B300 SXM6 AC', true],
  ['NVIDIA RTX 5090', true],
  ['NVIDIA RTX 4090', true],
  ['NVIDIA RTX A6000', false],
  ['NVIDIA A40', false],
  ['NVIDIA A100 80GB PCIe', false],
  ['NVIDIA A100-SXM4-80GB', false],
  ['NVIDIA RTX A4000', false],
]
