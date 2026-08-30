/**
 * VRAM arithmetic, in one place.
 *
 * Both the model picker's verdict and the fallback-GPU filter need to answer
 * the same question — how much is left for the KV cache — and two formulas that
 * disagree let a card pass one check and fail the other.
 */

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
 * Is there enough left for a usable context window?
 *
 * 4 GiB is the same threshold the picker warns at. Below it the card holds the
 * weights and almost nothing else: a 24 GiB card with 18 GiB of weights leaves
 * about 1.7 GiB, which is a few thousand tokens.
 */
export const MIN_USABLE_KV_GIB = 4
