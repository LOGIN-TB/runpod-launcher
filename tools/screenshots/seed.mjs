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

await call('/settings', { timezone: 'Europe/Berlin', dailyLimitUsd: 15, monthlyLimitUsd: 200 }, 'PATCH')

await call('/templates', {
  name: 'qwen-chat',
  engine: 'vllm',
  image: 'vllm/vllm-openai:v0.28.0',
  chatModel: { repoId: 'RedHatAI/Qwen3.8-27B-INT4' },
  gpuTypeId: 'NVIDIA L40S',
  maxModelLen: 32768,
  maxConcurrentSequences: 64,
  lifecycleMode: 'stopResume',
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

await call('/client-tokens', { name: 'n8n' })
await call('/client-tokens', { name: 'RAG indexer' })

console.log(paired.token)
