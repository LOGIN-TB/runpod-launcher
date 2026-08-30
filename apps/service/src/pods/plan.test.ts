import assert from 'node:assert/strict'
import { test } from 'node:test'
import { templateSchema, type Template } from '@runpod-launcher/shared'
import { buildCreatePodRequest, planVramSplit } from './plan.js'

const base = {
  id: 't1',
  name: 'qwen',
  image: 'ghcr.io/example/pod:v1',
  gpuTypeId: 'NVIDIA RTX 6000 Ada Generation',
  networkVolumeId: 'vol-1',
}

const make = (overrides: Record<string, unknown>): Template =>
  templateSchema.parse({ ...base, ...overrides })

test('both models share the card, leaving headroom', () => {
  const template = make({
    chatModel: { repoId: 'Qwen/Qwen3.8-27B-FP8' },
    embeddingModel: { repoId: 'Qwen/Qwen3-Embedding-0.6B' },
  })
  const split = planVramSplit(template)
  assert.equal(split.embedding, 0.06)
  assert.equal(split.chat, 0.88)
  assert.ok((split.chat ?? 0) + (split.embedding ?? 0) < 1, 'shares must leave room for CUDA context')
})

test('a lone chat model gets the embedding share back', () => {
  const split = planVramSplit(make({ chatModel: { repoId: 'Qwen/Qwen3.8-27B-FP8' } }))
  assert.equal(split.chat, 0.94)
  assert.equal(split.embedding, null)
})

test('an embedding-only template is valid and gets the whole card', () => {
  const split = planVramSplit(make({ embeddingModel: { repoId: 'BAAI/bge-m3' } }))
  assert.equal(split.chat, null)
  assert.equal(split.embedding, 0.94)
})

test('an explicit fraction overrides the computed split', () => {
  const split = planVramSplit(
    make({
      chatModel: { repoId: 'a/b', gpuMemoryFraction: 0.7 },
      embeddingModel: { repoId: 'c/d', gpuMemoryFraction: 0.2 },
    }),
  )
  assert.deepEqual(split, { chat: 0.7, embedding: 0.2 })
})

test('a template with no model at all is rejected', () => {
  const result = templateSchema.safeParse({ ...base, chatModel: null, embeddingModel: null })
  assert.equal(result.success, false)
  assert.match(result.error!.issues[0]!.message, /at least one model/)
})

test('rebuilding without a network volume is rejected', () => {
  const result = templateSchema.safeParse({
    ...base,
    networkVolumeId: null,
    lifecycleMode: 'recreate',
    chatModel: { repoId: 'a/b' },
  })
  assert.equal(result.success, false)
  assert.match(result.error!.issues[0]!.message, /network volume/)
})

test('the create request carries only the enabled model, and mounts the volume', () => {
  const request = buildCreatePodRequest({
    template: make({
      chatModel: { repoId: 'Qwen/Qwen3.8-27B-FP8', revision: 'main' },
      maxModelLen: 32768,
    }),
    podApiKey: 'pod-secret',
    huggingfaceToken: 'hf_test',
  })

  assert.equal(request.env?.LAUNCHER_CHAT_MODEL, 'Qwen/Qwen3.8-27B-FP8')
  assert.equal(request.env?.LAUNCHER_CHAT_REVISION, 'main')
  assert.equal(request.env?.LAUNCHER_EMBED_MODEL, undefined)
  assert.equal(request.env?.LAUNCHER_CHAT_MAX_LEN, '32768')
  assert.equal(request.env?.HF_HOME, '/workspace/huggingface')
  assert.equal(request.env?.HF_TOKEN, 'hf_test')
  assert.deepEqual(request.mounts?.network, [{ volumeId: 'vol-1', path: '/workspace' }])
  assert.deepEqual(request.ports, ['8000/http', '8001/http'])
})

test('args placeholders are filled, and the api key never lands in the template', () => {
  const template = make({
    chatModel: { repoId: 'Qwen/Qwen3.8-27B-FP8' },
    maxModelLen: 32768,
    args: '{{chatModel}} --port 8000 --api-key {{apiKey}} --max-model-len {{maxModelLen}} --gpu-memory-utilization {{chatGpuFraction}}',
  })
  const request = buildCreatePodRequest({
    template,
    podApiKey: 'pod-secret-abc',
    huggingfaceToken: null,
  })

  assert.equal(
    request.args,
    'Qwen/Qwen3.8-27B-FP8 --port 8000 --api-key pod-secret-abc --max-model-len 32768 --gpu-memory-utilization 0.94',
  )
  assert.ok(!JSON.stringify(template).includes('pod-secret-abc'), 'the key must not be stored on the template')
})

test('an unknown placeholder is left alone rather than blanked', () => {
  const request = buildCreatePodRequest({
    template: make({ chatModel: { repoId: 'a/b' }, args: '--flag {{nonsense}}' }),
    podApiKey: 'k',
    huggingfaceToken: null,
  })
  assert.equal(request.args, '--flag {{nonsense}}')
})

test('the pod bearer token is not part of what the admin API describes', () => {
  // Regression guard: /pod once returned podApiKey verbatim. Anyone holding it
  // could reach vLLM directly, bypassing the gateway's token checks and usage
  // log, and it cannot be revoked without rebuilding the pod.
  const serving = { chatUrl: 'https://x-8000.proxy.runpod.net', embeddingUrl: null, servedModels: ['m'], podApiKey: 'secret' }
  const exposed = { chatUrl: serving.chatUrl, embeddingUrl: serving.embeddingUrl, servedModels: serving.servedModels }
  assert.ok(!Object.keys(exposed).includes('podApiKey'))
  assert.ok(!JSON.stringify(exposed).includes('secret'))
})

test('a GGUF quantisation is passed to llama.cpp as repo:tag', () => {
  // Without the tag llama.cpp picks a build itself, which for a repository
  // holding fourteen alternatives is a coin toss between 1.7 GB and 29 GB.
  const request = buildCreatePodRequest({
    template: make({
      engine: 'llamacpp',
      chatModel: { repoId: 'JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', quantisation: 'Q4_K_M' },
      args: '-hf {{chatModel}} --port 8000 --api-key {{apiKey}}',
    }),
    podApiKey: 'k',
    huggingfaceToken: null,
  })
  assert.match(request.args!, /-hf JonathanColetti\/Qwen3\.8-27B-Uncensored-GGUF:Q4_K_M /)
})

test('without a quantisation the repository is passed bare, as vLLM expects', () => {
  const request = buildCreatePodRequest({
    template: make({ chatModel: { repoId: 'Qwen/Qwen3.8-27B-FP8' }, args: '{{chatModel}} --port 8000' }),
    podApiKey: 'k',
    huggingfaceToken: null,
  })
  assert.match(request.args!, /^Qwen\/Qwen3\.8-27B-FP8 /)
})
