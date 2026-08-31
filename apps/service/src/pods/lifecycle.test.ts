import assert from 'node:assert/strict'
import { test } from 'node:test'
import { templateSchema, type Template } from '@runpod-launcher/shared'
import { openDatabase, type Db } from '../store/db.js'
import { RunpodClient } from '../runpod/client.js'
import { PodManager } from './manager.js'
import { reapSupersededPods } from './reaper.js'

const template = (overrides: Record<string, unknown> = {}): Template =>
  templateSchema.parse({
    id: 't1',
    name: 'nightly',
    image: 'img',
    gpuTypeId: 'NVIDIA A40',
    chatModel: { repoId: 'a/b' },
    lifecycleMode: 'stopResume',
    ...overrides,
  })

/** Records every action asked of RunPod, so the sequence can be asserted. */
interface Fake {
  actions: string[]
  created: number
  /** What RunPod still holds, which is what the reaper acts on. */
  livePods: Set<string>
  fetch: typeof fetch
}

const fakeRunpod = (options: { resumeFails?: boolean } = {}): Fake => {
  const state: Fake = {
    actions: [],
    created: 0,
    livePods: new Set<string>(),
    fetch: (async (url: unknown, init?: RequestInit) => {
      const target = String(url)
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

      if (target.includes('/catalog/gpus')) return json({ gpus: [{ id: 'NVIDIA A40', memory: 48 }] })

      // The reaper reconciles against this rather than against our own table,
      // because the table is the thing that can be wrong.
      if (target.endsWith('/v2/pods') && init?.method !== 'POST') {
        return json({ pods: [...state.livePods].map((id) => ({ id, status: 'EXITED', cost: 0.44 })) })
      }

      const action = /\/pods\/([^/]+)\/action$/.exec(target)
      if (action) {
        const requested = (JSON.parse(String(init?.body)) as { action: string }).action
        state.actions.push(`${requested}:${action[1]}`)
        if (requested === 'start' && options.resumeFails) {
          return new Response(
            '{"detail":"There are not enough free GPUs on the host machine to start this pod.","status":400}',
            { status: 400 },
          )
        }
        return json({ id: action[1], status: 'RUNNING', cost: 0.44, gpu: { id: 'NVIDIA A40', count: 1 }, startedAt: null })
      }

      if (target.endsWith('/v2/pods') && init?.method === 'POST') {
        state.created += 1
        state.livePods.add(`new-${state.created}`)
        return json({ id: `new-${state.created}`, status: 'RUNNING', cost: 0.44, startedAt: null })
      }
      return json({})
    }) as unknown as typeof fetch,
  }
  return state
}

const setup = (fake: Fake, tpl = template()): { db: Db; manager: PodManager } => {
  const db = openDatabase(':memory:')
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(tpl.id, tpl.name, JSON.stringify(tpl), now, now)
  return { db, manager: new PodManager(db, () => new RunpodClient('key', fake.fetch), () => null) }
}

test('a paused pod is the one that gets woken, not a brand-new one', async () => {
  // The defect: doStart looked for the pod to resume with current(), which
  // asks for `stopped_at IS NULL` — so the paused pod was never found and a new
  // one was built every cycle. Pause-and-resume had never resumed once.
  const fake = fakeRunpod()
  const { manager } = setup(fake)

  const first = await manager.start(template())
  assert.equal(first.id, 'new-1')

  await manager.stop('stopResume', 'outside-schedule')
  const second = await manager.start(template())

  assert.equal(second.id, 'new-1', 'the same pod came back')
  assert.equal(fake.created, 1, 'and no second pod was built')
  assert.deepEqual(fake.actions, ['stop:new-1', 'start:new-1'])
})

test('a terminated pod is never offered for resuming', async () => {
  const fake = fakeRunpod()
  const { manager } = setup(fake)

  await manager.start(template())
  await manager.act('new-1', 'terminate', 'deleted')

  assert.equal(manager.resumable('t1'), null)
  const next = await manager.start(template())
  assert.equal(next.id, 'new-2', 'a replacement was built, as it must be')
})

test('when resuming fails the old pod is terminated, not left behind', async () => {
  // Live cause of the pile-up: "There are not enough free GPUs on the host
  // machine". A new pod was built and the old one stayed at RunPod forever.
  const fake = fakeRunpod({ resumeFails: true })
  const { manager, db } = setup(fake)

  await manager.start(template())
  await manager.stop('stopResume', 'outside-schedule')
  const replacement = await manager.start(template())

  assert.equal(replacement.id, 'new-2')
  assert.ok(fake.actions.includes('terminate:new-1'), 'the pod that could not be resumed was removed')

  const row = db.prepare('SELECT terminated_at AS t, stop_reason AS r FROM pods WHERE id = ?').get('new-1') as {
    t: string | null
    r: string
  }
  assert.ok(row.t, 'and recorded as gone')
  assert.equal(row.r, 'superseded')
})

test('a full cycle leaves exactly one pod, which was the whole complaint', async () => {
  const fake = fakeRunpod()
  const { manager, db } = setup(fake)

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await manager.start(template())
    await manager.stop('stopResume', 'outside-schedule')
  }

  const alive = db
    .prepare('SELECT COUNT(*) AS n FROM pods WHERE terminated_at IS NULL')
    .get() as { n: number }
  assert.equal(alive.n, 1)
  assert.equal(fake.created, 1, 'three cycles, one pod ever built')
})

test('the reaper keeps the resumable pod and removes the rest', async () => {
  const fake = fakeRunpod()
  const { manager, db } = setup(fake)
  const now = new Date().toISOString()

  // Three stopped pods for one template, as an earlier version would leave.
  const insert = db.prepare(
    `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, started_at, stopped_at)
     VALUES (?, 't1', 'EXITED', 0.44, ?, ?, ?)`,
  )
  insert.run('old-1', '2026-09-01T01:00:00Z', now, now)
  insert.run('old-2', '2026-09-01T02:00:00Z', now, now)
  insert.run('newest', '2026-09-01T03:00:00Z', now, now)
  // RunPod still holds all three, which is the situation being cleared.
  for (const id of ['old-1', 'old-2', 'newest']) fake.livePods.add(id)

  const result = await reapSupersededPods(db, manager, () => {})

  assert.deepEqual(result.kept, ['newest'], 'the newest paused pod is the one resume would use')
  assert.deepEqual(result.terminated.sort(), ['old-1', 'old-2'])
})

test('the reaper leaves alone anything this launcher did not create', async () => {
  // The user's own ComfyUI pod must not be touched. The signal is a record in
  // our table, never the name.
  const fake = fakeRunpod()
  const { manager, db } = setup(fake)
  db.prepare(
    `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, stopped_at)
     VALUES ('someone-elses', NULL, 'EXITED', 0.53, ?, ?)`,
  ).run(new Date().toISOString(), new Date().toISOString())
  fake.livePods.add('someone-elses')

  const result = await reapSupersededPods(db, manager, () => {})
  assert.deepEqual(result.terminated, [])
  assert.ok(!fake.actions.some((entry) => entry.includes('someone-elses')))
})

test('recreate mode terminates on stop, so nothing accumulates there either', async () => {
  const fake = fakeRunpod()
  const tpl = template({ lifecycleMode: 'recreate', networkVolumeId: 'vol-1' })
  const { manager, db } = setup(fake, tpl)

  await manager.start(tpl)
  await manager.stop('recreate', 'outside-schedule')

  assert.ok(fake.actions.includes('terminate:new-1'))
  const row = db.prepare('SELECT terminated_at AS t FROM pods WHERE id = ?').get('new-1') as { t: string | null }
  assert.ok(row.t, 'and it is recorded as gone, so resume never considers it')
})

test('a pod our records call gone but RunPod still holds is cleared away', async () => {
  // The situation this reaper exists for, and the one reading our own table
  // could never find: an earlier version marked pods terminated locally without
  // ever telling RunPod, so they stood there indefinitely.
  const fake = fakeRunpod()
  const { manager, db } = setup(fake)
  const now = new Date().toISOString()

  db.prepare(
    `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, stopped_at, terminated_at)
     VALUES ('believed-gone', 't1', 'EXITED', 0.44, ?, ?, ?)`,
  ).run(now, now, now)
  fake.livePods.add('believed-gone')

  const result = await reapSupersededPods(db, manager, () => {})
  assert.deepEqual(result.terminated, ['believed-gone'])
})

test('a failure to reach RunPod terminates nothing at all', async () => {
  // An empty answer must not read as "RunPod has nothing", or a single outage
  // would conclude every pod is already gone.
  const db = openDatabase(':memory:')
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('t1', 'x', JSON.stringify(template()), now, now)
  db.prepare(
    `INSERT INTO pods (id, template_id, status, cost_per_hour, created_at, stopped_at)
     VALUES ('p1', 't1', 'EXITED', 0.44, ?, ?)`,
  ).run(now, now)

  const failing = (async () => new Response('upstream down', { status: 502 })) as unknown as typeof fetch
  const manager = new PodManager(db, () => new RunpodClient('k', failing), () => null)

  const result = await reapSupersededPods(db, manager, () => {})
  assert.deepEqual(result, { terminated: [], kept: [] })
})
