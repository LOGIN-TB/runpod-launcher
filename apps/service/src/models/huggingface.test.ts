import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bytesToGib, estimateKvHeadroomGib, FP8_SUPPORT_FIXTURE, gpuSupportsFp8 } from '@runpod-launcher/shared'
import {
  detectFormat,
  groupGgufVariants,
  HuggingFaceClient,
  pickDefaultGgufVariant,
} from './huggingface.js'

test('the weight format comes from metadata first, then the name', () => {
  assert.equal(detectFormat('someone/model', ['model-00001.gguf']), 'gguf')
  assert.equal(detectFormat('x/y', ['a.safetensors'], { quant_method: 'awq' }), 'awq')
  assert.equal(detectFormat('x/y', ['a.safetensors'], { quant_method: 'gptq' }), 'gptq')
  assert.equal(detectFormat('Qwen/Qwen3.8-27B-FP8', ['a.safetensors']), 'fp8')
  assert.equal(detectFormat('RedHatAI/Qwen3.8-27B-INT4', ['a.safetensors']), 'awq')
  assert.equal(detectFormat('philbert440/Qwen3.8-27B-W4A16-AWQ', ['a.safetensors']), 'awq')
  assert.equal(detectFormat('Qwen/Qwen3.8-27B', ['a.safetensors']), 'unknown')
})

/** Serves one canned repo response, so the tests do not touch the network. */
const stubHub = (payload: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

/** Real sizes, measured from the hub on 2026-08-30. */
const FP8_REPO = {
  siblings: [{ rfilename: 'model-00001.safetensors', size: 30_900_000_000 }],
  config: { quantization_config: { quant_method: 'fp8' } },
}
const INT4_REPO = {
  siblings: [{ rfilename: 'model-00001.safetensors', size: 19_500_000_000 }],
  config: { quantization_config: { quant_method: 'compressed-tensors' } },
}

const client = (payload: unknown, status = 200) =>
  new HuggingFaceClient(() => null, stubHub(payload, status))

test('FP8 weights are rejected on a card without hardware FP8', async () => {
  const verdict = await client(FP8_REPO).evaluate({
    repoId: 'Qwen/Qwen3.8-27B-FP8',
    kind: 'chat',
    engine: 'vllm',
    gpuDisplayName: 'NVIDIA RTX A6000',
    gpuMemoryGb: 48,
  })
  assert.equal(verdict.compatible, false)
  assert.deepEqual(verdict.problems.map((p) => p.code), ['fp8-unsupported-gpu'])
})

test('GGUF weights are rejected for vLLM, with the reason spelled out', async () => {
  const verdict = await client({
    siblings: [{ rfilename: 'Qwen3.8-27B-Q8_0.gguf', size: 29_000_000_000 }],
  }).evaluate({
    repoId: 'unsloth/Qwen3.8-27B-GGUF',
    kind: 'chat',
    engine: 'vllm',
    gpuDisplayName: 'NVIDIA L40S',
    gpuMemoryGb: 48,
  })
  assert.equal(verdict.compatible, false)
  assert.deepEqual(verdict.problems.map((p) => p.code), ['format-engine-mismatch'])
})

test('FP8 does not fit on a 32 GB card, but INT4 does — the measured case', async () => {
  const fp8 = await client(FP8_REPO).evaluate({
    repoId: 'Qwen/Qwen3.8-27B-FP8',
    kind: 'chat',
    engine: 'vllm',
    gpuDisplayName: 'NVIDIA RTX PRO 4500 Blackwell',
    gpuMemoryGb: 32,
  })
  assert.equal(fp8.compatible, false)
  assert.deepEqual(fp8.problems.map((p) => p.code), ['does-not-fit'])

  const int4 = await client(INT4_REPO).evaluate({
    repoId: 'RedHatAI/Qwen3.8-27B-INT4',
    kind: 'chat',
    engine: 'vllm',
    gpuDisplayName: 'NVIDIA RTX PRO 4500 Blackwell',
    gpuMemoryGb: 32,
  })
  assert.equal(int4.compatible, true)
  // vLLM reported 9.38 GiB of KV cache for exactly this combination.
  assert.ok(Math.abs(int4.headroomGib! - 9.38) < 1.5, `estimated ${int4.headroomGib}`)
})

test('a second model on the card is counted against the headroom', async () => {
  const verdict = await client(INT4_REPO).evaluate({
    repoId: 'RedHatAI/Qwen3.8-27B-INT4',
    kind: 'chat',
    engine: 'vllm',
    gpuDisplayName: 'NVIDIA RTX PRO 4500 Blackwell',
    gpuMemoryGb: 32,
    otherSlotBytes: 8_000_000_000,
  })
  assert.equal(verdict.compatible, false)
  assert.ok(verdict.problems.some((p) => p.code === 'does-not-fit' || p.code === 'tight-headroom'))
})

test('a gated repository says so instead of failing later on the pod', async () => {
  const verdict = await client({}, 403).evaluate({
    repoId: 'meta-llama/Something',
    kind: 'chat',
    engine: 'vllm',
    gpuDisplayName: 'NVIDIA L40S',
    gpuMemoryGb: 48,
  })
  assert.equal(verdict.compatible, false)
  assert.deepEqual(verdict.problems.map((p) => p.code), ['repo-gated'])
})

test('every RunPod card name is classified correctly for FP8', () => {
  // Name-based matching is brittle and RunPod's names are irregular. A missing
  // `s` in the L40S pattern once made the launcher reject FP8 on the exact card
  // it had been measured working on.
  for (const [name, expected] of FP8_SUPPORT_FIXTURE) {
    assert.equal(gpuSupportsFp8(name), expected, `${name} should be ${expected ? '' : 'not '}FP8-capable`)
  }
})

test('a GGUF repo is read as alternatives, not as one giant download', () => {
  // unsloth/Qwen3.8-27B-GGUF carries 20+ quantisations of the same model side
  // by side. Summing them reported 472 GB for a 27B model.
  const files = [
    { rfilename: 'Qwen3.8-27B-IQ1_S.gguf', size: 6_190_000_000 },
    { rfilename: 'Qwen3.8-27B-Q4_K_M.gguf', size: 16_500_000_000 },
    { rfilename: 'Qwen3.8-27B-Q8_0-00001-of-00002.gguf', size: 15_000_000_000 },
    { rfilename: 'Qwen3.8-27B-Q8_0-00002-of-00002.gguf', size: 14_000_000_000 },
    { rfilename: 'Qwen3.8-27B-BF16.gguf', size: 54_700_000_000 },
    { rfilename: 'README.md' },
  ]
  const variants = groupGgufVariants(files)
  const byLabel = Object.fromEntries(variants.map((v) => [v.label, v]))

  assert.deepEqual(Object.keys(byLabel).sort(), ['BF16', 'IQ1_S', 'Q4_K_M', 'Q8_0'])
  assert.equal(byLabel.Q8_0!.bytes, 29_000_000_000, 'shards of one quantisation are added together')
  assert.equal(byLabel.Q8_0!.files.length, 2)

  // The default skips the unquantised BF16, which defeats the point of GGUF.
  assert.equal(pickDefaultGgufVariant(variants)?.label, 'Q8_0')
})

test('a GGUF repo reports one variant’s size, not the whole repository', async () => {
  const verdict = await client({
    siblings: [
      { rfilename: 'm-Q4_K_M.gguf', size: 16_500_000_000 },
      { rfilename: 'm-Q8_0.gguf', size: 29_000_000_000 },
      { rfilename: 'm-BF16.gguf', size: 54_700_000_000 },
    ],
  }).evaluate({
    repoId: 'unsloth/Qwen3.8-27B-GGUF',
    kind: 'chat',
    engine: 'llamacpp',
    gpuDisplayName: 'NVIDIA L40S',
    gpuMemoryGb: 48,
  })
  assert.equal(verdict.details.weightBytes, 29_000_000_000)
  assert.equal(verdict.details.ggufVariants?.length, 3)
  assert.equal(verdict.compatible, true, 'Q8_0 fits on a 48 GB card with llama.cpp')
})

test('the KV headroom estimate matches what the two measured runs actually got', () => {
  // Both on an L40S 48 GiB, vLLM 0.28.0, --gpu-memory-utilization 0.94,
  // measured 2026-08-30. The weight sizes are the repositories' file sizes,
  // which is all the app knows before renting anything; the KV figures are what
  // vLLM then reported.
  const cases = [
    { name: 'FP8 on L40S', gib: 48, weightBytes: 30.9e9, measuredKvGib: 10.58 },
    { name: 'INT4 on L40S', gib: 48, weightBytes: 19.5e9, measuredKvGib: 21.58 },
    { name: 'INT4 on RTX PRO 4500', gib: 32, weightBytes: 19.5e9, measuredKvGib: 9.38 },
  ]

  for (const c of cases) {
    const estimate = estimateKvHeadroomGib({
      gpuMemoryGib: c.gib,
      weightsGib: bytesToGib(c.weightBytes),
    })
    assert.ok(
      Math.abs(estimate - c.measuredKvGib) < 1.5,
      `${c.name}: estimated ${estimate.toFixed(1)} GiB against ${c.measuredKvGib} GiB measured`,
    )
  }
})

test('mixing GB and GiB would invent headroom that is not there', () => {
  // A 48 GiB card holding 30.9e9 bytes of weights: read as decimal GB, the
  // weights look 2 units smaller than they are. That is the difference between
  // "fits with room to spare" and "will not start".
  assert.ok(30.9e9 / 1e9 - bytesToGib(30.9e9) > 2)
})

test('the estimate does not promise room that utilisation has already excluded', () => {
  const full = estimateKvHeadroomGib({ gpuMemoryGib: 48, weightsGib: 20, utilization: 1 })
  const capped = estimateKvHeadroomGib({ gpuMemoryGib: 48, weightsGib: 20, utilization: 0.8 })
  assert.ok(capped < full)
  // The 20% held back is itself subject to the proportional overhead, so the
  // difference is 48 x 0.20 x 0.88, not a flat 48 x 0.20.
  assert.equal(Number((full - capped).toFixed(2)), Number((48 * 0.2 * 0.88).toFixed(2)))
})
