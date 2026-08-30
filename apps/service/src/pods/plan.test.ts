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
