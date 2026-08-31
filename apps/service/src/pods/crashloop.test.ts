import assert from 'node:assert/strict'
import { test } from 'node:test'
import { templateSchema } from '@runpod-launcher/shared'
import { openDatabase } from '../store/db.js'
import { RunpodClient } from '../runpod/client.js'
import { PodManager } from './manager.js'

/** The log a pod produced on 2026-08-30 with an argument vLLM 0.28 removed. */
const CRASH_LOG = [
  'start container for vllm/vllm-openai:v0.28.0: begin',
  'vllm: error: unrecognized arguments: --task embed',
  'start container for vllm/vllm-openai:v0.28.0: begin',
  'vllm: error: unrecognized arguments: --task embed',
  'start container for vllm/vllm-openai:v0.28.0: begin',
  'vllm: error: unrecognized arguments: --task embed',
].join('\n')

const HEALTHY_LOG = [
  'start container for vllm/vllm-openai:v0.28.0: begin',
  'INFO Loading weights took 5.06 seconds',
  'INFO Application startup complete.',
].join('\n')

const tpl = templateSchema.parse({
  id: 't1',
  name: 'x',
  image: 'img',
  gpuTypeId: 'NVIDIA L40S',
  chatModel: { repoId: 'a/b' },
  lifecycleMode: 'stopResume',
})

const managerWith = (log: string) => {
  const db = openDatabase(':memory:')
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(tpl.id, tpl.name, JSON.stringify(tpl), now, now)
  db.prepare(
    `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, started_at, api_key)
     VALUES ('p1', ?, 'RUNNING', 0.99, ?, ?, 'k')`,
  ).run(tpl.id, now, now)

  const fetchImpl = (async (url: unknown) => {
    const u = String(url)
    if (u.includes('/logs')) return new Response(log, { status: 200 })
    if (u.includes('proxy.runpod.net')) return new Response('not found', { status: 404 })
    if (/\/v2\/pods\/[^/]+$/.test(u)) {
      return new Response(JSON.stringify({ id: 'p1', status: 'RUNNING', cost: 0.99, startedAt: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

  return new PodManager(db, () => new RunpodClient('k', fetchImpl), () => null)
}

test('an engine that keeps exiting is reported, not waited out', async () => {
  // Live on 2026-08-30 this held a client request for seven minutes and then
  // said "retry shortly", for a pod that could never have come up.
  const manager = managerWith(CRASH_LOG)
  await assert.rejects(
    () => manager.waitUntilServing('p1', 't1', 60_000),
    /keeps exiting on startup/,
  )
})

test('an engine that is merely slow is given its time', async () => {
  // One container start and no fatal error: still booting, not broken.
  const manager = managerWith(HEALTHY_LOG)
  const serving = await manager.waitUntilServing('p1', 't1', 22_000)
  assert.equal(serving, false, 'it never became healthy, but it was not called a crash either')
})
