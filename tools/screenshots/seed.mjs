#!/usr/bin/env node
/**
 * Seeds a throwaway service with the data the screenshots show.
 *
 * Fixed, invented values on purpose: the images end up in a public repository,
 * so they must not carry a real key, a real pod id or a real bill. The RunPod
 * key here is deliberately fake — screens that need live data will show their
 * empty state, which is itself worth illustrating.
 *
 * Prints the device token for capture.mjs to use.
 */
const SERVICE = process.argv[2] ?? 'http://localhost:8080'
const CODE = process.argv[3]

if (!CODE) {
  console.error('usage: node tools/screenshots/seed.mjs <service-url> <pairing-code>')
  process.exit(1)
}

const paired = await fetch(new URL('/pair', SERVICE), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: CODE, deviceName: 'Documentation' }),
}).then((r) => r.json())

if (!paired.token) {
  console.error('pairing failed:', paired.error)
  process.exit(1)
}

const call = (path, body, method = 'POST') =>
  fetch(new URL(path, SERVICE), {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${paired.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

await call(
  '/settings',
  {
    timezone: 'Europe/Berlin',
    dailyLimitUsd: 15,
    monthlyLimitUsd: 200,
    maxConcurrentPods: 2,
    // Obviously not a key. It only has to make the screens look configured;
    // anything that talks to RunPod will show its error state, which is itself
    // worth illustrating.
    runpodApiKey: 'rpa_documentation_placeholder_0000000000',
  },
  'PATCH',
)

/**
 * Two templates, so the mappings screen has something to show.
 *
 * One application per pod is the arrangement worth illustrating: a single
 * template would make every screen look like the old one-pod launcher, which is
 * precisely the shape this stopped being.
 */
const template = async (body) => (await call('/templates', body)).json()

const chat = await template({
  name: 'qwen-chat',
  engine: 'vllm',
  image: 'vllm/vllm-openai:v0.28.0',
  chatModel: { repoId: 'RedHatAI/Qwen3.8-27B-INT4' },
  gpuTypeId: 'NVIDIA L40S',
  maxModelLen: 32768,
  maxConcurrentSequences: 64,
  lifecycleMode: 'stopResume',
  toolCallParser: 'qwen3_xml',
  reasoningParser: 'qwen3',
  networkVolumeId: null,
  schedule: {
    enabled: true,
    timezone: 'Europe/Berlin',
    weekdays: [1, 2, 3, 4, 5],
    startAt: '07:00',
    stopAt: '19:00',
    idleStopMinutes: 30,
    maxRuntimeHours: 12,
  },
})

const rag = await template({
  name: 'rag-embeddings',
  engine: 'vllm',
  image: 'vllm/vllm-openai:v0.28.0',
  chatModel: null,
  embeddingModel: { repoId: 'Qwen/Qwen3-Embedding-0.6B' },
  gpuTypeId: 'NVIDIA A40',
  maxConcurrentSequences: 64,
  lifecycleMode: 'stopResume',
  networkVolumeId: null,
})

// Each access points at the pod it should reach: two applications on the chat
// pod, one on the embedding pod, and one deliberately unassigned so the state
// that needs attention is visible too.
await call('/client-tokens', { name: 'n8n', templateId: chat.id })
await call('/client-tokens', { name: 'Hermes agent', templateId: chat.id })
await call('/client-tokens', { name: 'RAG indexer', templateId: rag.id })
await call('/client-tokens', { name: 'Open WebUI', templateId: null })

console.log(paired.token)
