import assert from 'node:assert/strict'
import { test } from 'node:test'
import { engineForFormat, suitableGpus, UNUSABLE_FORMATS } from './engine.js'
import { presetForFormat, LLAMACPP_PRESET, VLLM_PRESET } from './presets.js'

test('GGUF selects llama.cpp, everything else vLLM, MLX nothing', () => {
  // Reported from a real session: picking a smaller quantisation produced a
  // template that still ran vLLM, which cannot read GGUF at all.
  assert.equal(presetForFormat('gguf'), LLAMACPP_PRESET)
  assert.equal(presetForFormat('awq'), VLLM_PRESET)
  assert.equal(presetForFormat('fp8'), VLLM_PRESET)
  assert.equal(presetForFormat('nvfp4'), VLLM_PRESET)
  assert.equal(presetForFormat('mlx'), null)

  assert.equal(engineForFormat('gguf'), 'llamacpp')
  assert.equal(engineForFormat('mlx'), null)
})

test('MLX is marked unusable, because no rented NVIDIA card can run it', () => {
  assert.ok(UNUSABLE_FORMATS.includes('mlx'))
})

test('each preset passes the model and the key to its own engine correctly', () => {
  // The two engines take completely different arguments; a template built for
  // one and started with the other crash-loops.
  assert.match(VLLM_PRESET.chatArgs, /^\{\{chatModel\}\} --port 8000/)
  assert.match(VLLM_PRESET.chatArgs, /--max-num-seqs/)

  assert.match(LLAMACPP_PRESET.chatArgs, /-hf \{\{chatModel\}\}/)
  assert.match(LLAMACPP_PRESET.chatArgs, /--n-gpu-layers 999/)
  assert.ok(!LLAMACPP_PRESET.chatArgs.includes('--max-model-len'), 'that flag is vLLM-only')

  for (const preset of [VLLM_PRESET, LLAMACPP_PRESET]) {
    assert.match(preset.chatArgs, /\{\{apiKey\}\}/, 'the engine must require a token')
    assert.match(preset.embeddingArgs, /--port 8001/, 'embeddings live on their own port')
  }
})

const GPUS = [
  { id: 'NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition', memory: 96 },
  { id: 'NVIDIA L40S', memory: 48 },
  { id: 'NVIDIA A40', memory: 48 },
  { id: 'NVIDIA GeForce RTX 3090', memory: 24 },
]

test('a card too small for the weights is never offered as a fallback', () => {
  // The failure this comes from: a 96 GiB card fell back to 48 GiB, with a
  // 24 GiB card next in line.
  const fits = suitableGpus(GPUS, { format: 'fp8', weightsGib: 60 })
  assert.deepEqual(
    fits.map((gpu) => gpu.memory),
    [96],
  )
})

test('an FP8 model is not offered an Ampere card, which has no hardware FP8', () => {
  const fits = suitableGpus(GPUS, { format: 'fp8', weightsGib: 18 })
  const ids = fits.map((gpu) => gpu.id)
  assert.ok(ids.includes('NVIDIA L40S'), 'Ada can')
  assert.ok(!ids.includes('NVIDIA A40'), 'Ampere cannot')
})

test('a 4-bit model does fit the cheap Ampere cards', () => {
  const ids = suitableGpus(GPUS, { format: 'awq', weightsGib: 18 }).map((gpu) => gpu.id)
  assert.ok(ids.includes('NVIDIA A40'))
  assert.ok(!ids.includes('NVIDIA GeForce RTX 3090'), '24 GiB leaves no room for the KV cache')
})

const PRICED = [
  { id: 'NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition', memory: 96, manufacturer: 'NVIDIA', price: { secure: 0.5 } },
  { id: 'NVIDIA RTX PRO 6000 Blackwell Server Edition', memory: 96, manufacturer: 'NVIDIA', price: { secure: 2.09 } },
  { id: 'NVIDIA B300 SXM6 AC', memory: 288, manufacturer: 'NVIDIA', price: { secure: 7.89 } },
  { id: 'AMD Instinct MI300X OAM', memory: 192, manufacturer: 'AMD', price: { secure: 2.39 } },
]

test('a substitute card is never more expensive than the one chosen', () => {
  // Falling back from a $0.50 card to a $7.89 one is a worse outcome than not
  // starting: the user never agreed to that rate.
  const ids = suitableGpus(PRICED, { format: 'awq', weightsGib: 18, maxPricePerHour: 0.5 }).map((g) => g.id)
  assert.ok(!ids.some((id) => id.includes('B300')))
  assert.ok(!ids.some((id) => id.includes('Server Edition')))
})

test('an AMD card is never a substitute, because the pod images are CUDA', () => {
  const ids = suitableGpus(PRICED, { format: 'awq', weightsGib: 18 }).map((g) => g.id)
  assert.ok(!ids.some((id) => id.startsWith('AMD')), 'MI300X has the memory but not the runtime')
})

test('each engine declares a concurrency that suits how it spends memory', () => {
  // llama.cpp divides one context budget between slots, so every extra slot
  // costs memory. vLLM's limit is independent of the per-request window.
  assert.equal(LLAMACPP_PRESET.defaultConcurrency, 4)
  assert.equal(VLLM_PRESET.defaultConcurrency, 64)
  assert.match(LLAMACPP_PRESET.chatArgs, /--ctx-size \{\{totalContext\}\}/)
  assert.match(VLLM_PRESET.chatArgs, /--max-model-len \{\{maxModelLen\}\}/)
})
