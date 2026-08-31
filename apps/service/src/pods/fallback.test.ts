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
    // Every card here is the same size, so none is filtered out as too small.
    if (String(url).includes('/catalog/gpus')) {
      return new Response(
        JSON.stringify({
          gpus: [
            { id: 'NVIDIA L40S', memory: 48 },
            { id: 'NVIDIA RTX 6000 Ada Generation', memory: 48 },
            { id: 'NVIDIA A40', memory: 48 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
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

/** A fetch where the pod record exists locally but is gone at RunPod. */
const fetchWithVanishedPod = (created: string[]): typeof fetch =>
  (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/catalog/gpus')) {
      return new Response(JSON.stringify({ gpus: [{ id: 'NVIDIA L40S', memory: 48 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (/\/pods\/[^/]+\/action$/.test(u)) {
      return new Response('{"detail":"pod not found","status":404}', { status: 404 })
    }
    if (u.endsWith('/v2/pods') && init?.method === 'POST') {
      created.push('created')
      return new Response(
        JSON.stringify({ id: 'fresh-pod', status: 'RUNNING', cost: 0.99, startedAt: null }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

test('a pod deleted outside the launcher is replaced, not resumed into a 404', async () => {
  const created: string[] = []
  const db = openDatabase(':memory:')
  const now = new Date().toISOString()
  const tpl = template({ lifecycleMode: 'stopResume' })
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('t1', 'test', JSON.stringify(tpl), now, now)
  // A paused pod the launcher still believes in, which no longer exists at
  // RunPod — what happens when someone terminates it from RunPod's own console.
  db.prepare(
    `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, stopped_at)
     VALUES ('ghost-pod', 't1', 'EXITED', 0.99, ?, ?)`,
  ).run(now, now)

  const manager = new PodManager(db, () => new RunpodClient('key', fetchWithVanishedPod(created)), () => null)
  const record = await manager.start(tpl)

  assert.equal(record.id, 'fresh-pod')
  assert.equal(created.length, 1, 'a replacement pod was built')
})

/** GPU sizes as RunPod reports them, for the fallback-safety tests. */
const CATALOG = {
  gpus: [
    { id: 'NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition', memory: 96 },
    { id: 'NVIDIA RTX PRO 6000 Blackwell Server Edition', memory: 96 },
    { id: 'NVIDIA A40', memory: 48 },
    { id: 'NVIDIA GeForce RTX 3090', memory: 24 },
  ],
}

test('a fallback never lands on a smaller card than the one asked for', async () => {
  // Reported from a real run: a template asking for a 96 GiB Blackwell got an
  // A40 with 48 GiB, because the fallbacks had been chosen by price alone.
  // The next card in that list had 24 GiB.
  const seen: string[][] = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/catalog/gpus')) {
      return new Response(JSON.stringify(CATALOG), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (u.endsWith('/v2/pods') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { gpu: { id: string }; dataCenterIds?: string[] }
      seen.push([body.gpu.id, (body.dataCenterIds ?? []).join(',') || 'unpinned'])
      return new Response(CAPACITY_BODY, { status: 400 })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

  const db = openDatabase(':memory:')
  const tpl = template({
    gpuTypeId: 'NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition',
    gpuFallbackIds: ['NVIDIA A40', 'NVIDIA GeForce RTX 3090', 'NVIDIA RTX PRO 6000 Blackwell Server Edition'],
    dataCenterIds: [],
  })
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('t1', 'test', JSON.stringify(tpl), now, now)

  const manager = new PodManager(db, () => new RunpodClient('key', fetchImpl), () => null)
  await assert.rejects(() => manager.start(tpl))

  const tried = seen.map(([gpu]) => gpu)
  assert.deepEqual(tried, [
    'NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition',
    'NVIDIA RTX PRO 6000 Blackwell Server Edition',
  ])
  assert.ok(!tried.includes('NVIDIA A40'), 'a 48 GiB card must not stand in for a 96 GiB one')
  assert.ok(!tried.includes('NVIDIA GeForce RTX 3090'), 'nor a 24 GiB one')
})

test('an equally large card is a legitimate fallback', async () => {
  const seen: string[][] = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/catalog/gpus')) {
      return new Response(JSON.stringify(CATALOG), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.endsWith('/v2/pods') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { gpu: { id: string } }
      seen.push([body.gpu.id])
      if (seen.length < 2) return new Response(CAPACITY_BODY, { status: 400 })
      return new Response(JSON.stringify({ id: 'pod1', status: 'RUNNING', cost: 2, startedAt: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

  const db = openDatabase(':memory:')
  const tpl = template({
    gpuTypeId: 'NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition',
    gpuFallbackIds: ['NVIDIA RTX PRO 6000 Blackwell Server Edition'],
    dataCenterIds: [],
  })
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('t1', 'test', JSON.stringify(tpl), now, now)

  const manager = new PodManager(db, () => new RunpodClient('key', fetchImpl), () => null)
  const record = await manager.start(tpl)
  assert.equal(record.id, 'pod1')
  assert.equal(seen.length, 2)
})

test('an unreadable GPU catalog means no fallbacks, not unchecked ones', async () => {
  // Falling back without being able to verify size is the exact failure this
  // guards against. An unstartable pod is cheaper than a wrong one.
  const seen: string[][] = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/catalog/gpus')) return new Response('upstream down', { status: 502 })
    if (u.endsWith('/v2/pods') && init?.method === 'POST') {
      seen.push([(JSON.parse(String(init.body)) as { gpu: { id: string } }).gpu.id])
      return new Response(CAPACITY_BODY, { status: 400 })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

  const db = openDatabase(':memory:')
  const tpl = template({ dataCenterIds: [] })
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('t1', 'test', JSON.stringify(tpl), now, now)

  const manager = new PodManager(db, () => new RunpodClient('key', fetchImpl), () => null)
  await assert.rejects(() => manager.start(tpl))
  assert.deepEqual(seen.map(([gpu]) => gpu), ['NVIDIA L40S'], 'only the card that was asked for')
})

test('a paused pod whose host lost its GPU says so, and says what to do', async () => {
  // Live on 2026-08-30, resuming a paused pod: "There are not enough free GPUs
  // on the host machine to start this pod." A stopped pod keeps its machine but
  // not a claim on a card. The pod is fine; it just cannot come back there.
  const db = openDatabase(':memory:')
  const tpl = template({ lifecycleMode: 'stopResume', dataCenterIds: [] })
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('t1', 'test', JSON.stringify(tpl), now, now)
  db.prepare(
    `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, started_at, stopped_at)
     VALUES ('paused', 't1', 'EXITED', 0.99, ?, ?, ?)`,
  ).run(now, now, now)

  const noGpu = (async (url: unknown) => {
    if (/\/pods\/[^/]+\/action$/.test(String(url))) {
      return new Response(
        '{"detail":"There are not enough free GPUs on the host machine to start this pod.","status":400}',
        { status: 400 },
      )
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

  const manager = new PodManager(db, () => new RunpodClient('k', noGpu), () => null)
  await assert.rejects(() => manager.resume('paused'), /no free GPU any more.*Create a new pod/s)
})

test('stopping something already stopped is agreement, not an error', async () => {
  // RunPod rejects the redundant transition. Surfacing that as a failure makes
  // a button look broken for doing exactly what was asked.
  const db = openDatabase(':memory:')
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO pods (id, status, cost_per_hour, created_at) VALUES ('p1', 'EXITED', 0.5, ?)`,
  ).run(now)

  const conflicting = (async (url: unknown) => {
    if (/\/pods\/[^/]+\/action$/.test(String(url))) {
      return new Response('{"detail":"action \\"stop\\" is not valid for status EXITED"}', { status: 409 })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

  const manager = new PodManager(db, () => new RunpodClient('k', conflicting), () => null)
  await manager.act('p1', 'stop')
  const row = db.prepare('SELECT stopped_at AS s FROM pods WHERE id = ?').get('p1') as { s: string | null }
  assert.ok(row.s, 'and the pod is recorded as stopped')
})
