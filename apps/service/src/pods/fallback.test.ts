import assert from 'node:assert/strict'
import { test } from 'node:test'
import { templateSchema } from '@runpod-launcher/shared'
import { openDatabase } from '../store/db.js'
import { RunpodClient, RunpodError } from '../runpod/client.js'
import { PodManager } from './manager.js'

/** The exact 400 RunPod returned on 2026-08-30 when an L40S had just gone. */
const CAPACITY_BODY = JSON.stringify({
  detail: 'There are no longer any instances available with the requested specifications. Please refresh and try again.',
  status: 400,
  title: 'Bad Request',
})

test('the capacity error is recognised, and other 400s are not', () => {
  assert.equal(new RunpodError(400, 'createPod', CAPACITY_BODY).isCapacityExhausted, true)
  assert.equal(new RunpodError(400, 'createPod', '{"detail":"invalid image"}').isCapacityExhausted, false)
  assert.equal(new RunpodError(401, 'createPod', CAPACITY_BODY).isCapacityExhausted, false)
})

/** A fetch that fails with the capacity error until the Nth call. */
const fetchThatSucceedsOnAttempt = (n: number, seen: string[][]): typeof fetch => {
  let calls = 0
  return (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/v2/pods') && init?.method === 'POST') {
      calls += 1
      const body = JSON.parse(String(init.body)) as { gpu: { id: string }; dataCenterIds?: string[] }
      seen.push([body.gpu.id, (body.dataCenterIds ?? []).join(',') || 'unpinned'])
      if (calls < n) return new Response(CAPACITY_BODY, { status: 400 })
      return new Response(
        JSON.stringify({ id: 'pod1', status: 'RUNNING', cost: 0.99, startedAt: null }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

const template = (overrides: Record<string, unknown> = {}) =>
  templateSchema.parse({
    id: 't1',
    name: 'test',
    image: 'img',
    gpuTypeId: 'NVIDIA L40S',
    gpuFallbackIds: ['NVIDIA RTX 6000 Ada Generation', 'NVIDIA A40'],
    dataCenterIds: ['EU-NL-1'],
    chatModel: { repoId: 'a/b' },
    lifecycleMode: 'stopResume',
    ...overrides,
  })

const managerWith = (fetchImpl: typeof fetch): PodManager => {
  const db = openDatabase(':memory:')
  // `pods.template_id` references `templates`, so the row has to exist before a
  // pod can be recorded against it.
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('t1', 'test', JSON.stringify(template()), now, now)
  return new PodManager(db, () => new RunpodClient('key', fetchImpl), () => null)
}

test('a card with no capacity falls through to the next one', async () => {
  const seen: string[][] = []
  const manager = managerWith(fetchThatSucceedsOnAttempt(2, seen))
  const record = await manager.start(template())
  assert.equal(record.id, 'pod1')
  assert.deepEqual(seen, [
    ['NVIDIA L40S', 'EU-NL-1'],
    ['NVIDIA RTX 6000 Ada Generation', 'EU-NL-1'],
  ])
})

test('with every card exhausted, placement is unpinned as a last resort', async () => {
  const seen: string[][] = []
  const manager = managerWith(fetchThatSucceedsOnAttempt(4, seen))
  await manager.start(template())
  assert.equal(seen.length, 4)
  assert.deepEqual(seen[3], ['NVIDIA L40S', 'unpinned'], 'the final attempt drops the data center')
})

test('a network volume forbids unpinning, and the error says why', async () => {
  const seen: string[][] = []
  const manager = managerWith(fetchThatSucceedsOnAttempt(99, seen))
  await assert.rejects(
    () => manager.start(template({ networkVolumeId: 'vol1' })),
    /drop the volume so placement can move/,
  )
  assert.equal(seen.length, 3, 'three cards tried, no unpinned attempt')
})
