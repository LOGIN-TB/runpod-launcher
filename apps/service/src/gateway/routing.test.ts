import assert from 'node:assert/strict'
import { test } from 'node:test'
import { templateSchema, type Template } from '@runpod-launcher/shared'
import { openDatabase, type Db } from '../store/db.js'
import { RunpodClient } from '../runpod/client.js'
import { PodManager, PodLimitReached } from '../pods/manager.js'
import { TokenStore } from '../auth/tokens.js'
import { createPodResolver } from './resolve.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const template = (id: string, name: string, overrides: Record<string, unknown> = {}): Template =>
  templateSchema.parse({
    id,
    name,
    image: 'img',
    gpuTypeId: 'NVIDIA A40',
    chatModel: { repoId: `org/${name}` },
    lifecycleMode: 'stopResume',
    ...overrides,
  })

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

/**
 * A RunPod that hands out pods, and pod engines that answer.
 *
 * `created` records the pods in the order they were rented, which is how these
 * tests can say "this request reached that pod" rather than "a pod appeared
 * somewhere".
 */
const world = () => {
  const created: string[] = []

  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const target = String(url)
    if (target.includes('/catalog/gpus')) return json({ gpus: [{ id: 'NVIDIA A40', memory: 48 }] })

    if (target.endsWith('/v2/pods') && init?.method === 'POST') {
      const id = `pod${created.length + 1}`
      created.push(id)
      return json({ id, status: 'RUNNING', cost: 0.4, gpu: { id: 'NVIDIA A40', count: 1 }, startedAt: null })
    }
    // The engine's own health probe, which decides whether a request may be
    // forwarded at all.
    if (target.endsWith('/health')) return new Response('ok', { status: 200 })

    // The status poll between creating a pod and forwarding into it.
    const detail = /\/v2\/pods\/(pod\d+)$/.exec(target)
    if (detail) {
      return json({
        id: detail[1],
        status: 'RUNNING',
        cost: 0.4,
        gpu: { id: 'NVIDIA A40', count: 1 },
        startedAt: null,
      })
    }
    return json({})
  }) as unknown as typeof fetch

  return { created, fetchImpl }
}

const setup = (templates: Template[], maxConcurrentPods = 2) => {
  const db: Db = openDatabase(':memory:')
  const now = new Date().toISOString()
  for (const tpl of templates) {
    db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(tpl.id, tpl.name, JSON.stringify(tpl), now, now)
  }

  const w = world()
  const pods = new PodManager(
    db,
    () => new RunpodClient('key', w.fetchImpl),
    () => null,
    undefined,
    () => maxConcurrentPods,
  )

  // The pod's own engine is reached through the global fetch rather than the
  // RunPod client: `waitUntilServing` and `engineAnswers` probe `/health`
  // directly. Left alone, these tests would wait on the real network.
  globalThis.fetch = w.fetchImpl

  return { db, pods, resolver: createPodResolver({ pods, wakeWaitSeconds: () => 30 }), ...w }
}

const client = (name: string, templateId: string | null) => ({ id: `tok-${name}`, name, templateId })

test('a request lands on its own template pod, not on whichever pod is up', async () => {
  // The claim this whole change rests on. Before it, both tokens reached the
  // same pod, because the gateway asked "which pod is running" and never "who
  // is calling".
  const { pods, resolver, created } = setup([template('a', 'n8n'), template('b', 'hermes')])

  const first = await resolver.resolvePod({ wait: true, client: client('n8n', 'a') })
  const second = await resolver.resolvePod({ wait: true, client: client('hermes', 'b') })

  assert.equal(first.state, 'ready')
  assert.equal(second.state, 'ready')
  assert.equal(created.length, 2, 'each template got its own pod')

  // Both are up at once, and each token still resolves to its own.
  assert.equal(pods.runningPods().length, 2)
  assert.equal(pods.currentFor('a')?.id, created[0])
  assert.equal(pods.currentFor('b')?.id, created[1])

  const again = await resolver.resolvePod({ wait: true, client: client('n8n', 'a') })
  assert.ok(
    again.state === 'ready' && again.pod.chatUrl?.includes(created[0]!),
    'the next request from n8n reaches the pod n8n started, not the newer one',
  )
})

test('one application cannot wake another application pod', async () => {
  // Hermes asking for a model must not start the GPU another application rents.
  // Only the schedule of the template being woken applies.
  const { resolver, created } = setup([
    template('a', 'n8n'),
    template('b', 'hermes', {
      // Closed on every weekday, so a wake attempt on `b` is refused whatever
      // the clock says.
      schedule: { enabled: true, timezone: 'UTC', weekdays: [], startAt: '07:00', stopAt: '19:00' },
    }),
  ])

  const blocked = await resolver.resolvePod({ wait: true, client: client('hermes', 'b') })
  assert.equal(blocked.state, 'outside-hours', 'hermes is outside its own hours')
  assert.equal(created.length, 0, 'and nothing was rented')

  const allowed = await resolver.resolvePod({ wait: true, client: client('n8n', 'a') })
  assert.equal(allowed.state, 'ready', 'n8n has no schedule and is served')
  assert.equal(created.length, 1, 'one pod, and it is the one n8n asked for')
})

test('a token with no target is told to assign one instead of getting a pod', async () => {
  // Only reachable on an installation that already had several templates when
  // targets arrived, where binding the token would have been a guess.
  const { resolver, created } = setup([template('a', 'n8n'), template('b', 'hermes')])
  const resolution = await resolver.resolvePod({ wait: true, client: client('stray', null) })

  assert.equal(resolution.state, 'unassigned')
  assert.equal(created.length, 0, 'an unassigned token must not rent anything')
})

test('a client is offered its own models and no others', async () => {
  // An agent lists models before it can pick one. Offering another template's
  // model would have it choose something it can never reach.
  const { resolver } = setup([
    template('a', 'n8n', { chatModel: { repoId: 'org/chat-a' }, maxModelLen: 40960 }),
    template('b', 'hermes', { chatModel: { repoId: 'org/chat-b' } }),
  ])

  const forN8n = await resolver.advertisedModels(client('n8n', 'a'))
  assert.deepEqual(forN8n.names, ['org/chat-a'])
  assert.deepEqual((await resolver.advertisedModels(client('hermes', 'b'))).names, ['org/chat-b'])
  assert.deepEqual((await resolver.advertisedModels(client('stray', null))).names, [])

  // The window travels with the list, because clients ask for it and size their
  // requests by it. Without it an agent guesses — and a guess of 65536 output
  // tokens against a 16384 window fails the whole call.
  assert.equal(forN8n.contextTokens, 40960, 'the template window, before the pod is even up')
})

test('the pod limit refuses the extra pod and names the ones holding the slots', async () => {
  // The cap is the only thing between a handful of mappings and a handful of
  // simultaneous GPU bills. The message has to say which pod to stop, or the
  // user is left hunting for it.
  const { pods, resolver, created } = setup(
    [template('a', 'n8n'), template('b', 'hermes'), template('c', 'openclaw')],
    2,
  )

  await resolver.resolvePod({ wait: true, client: client('n8n', 'a') })
  await resolver.resolvePod({ wait: true, client: client('hermes', 'b') })
  assert.equal(created.length, 2)

  await assert.rejects(
    () => pods.start(template('c', 'openclaw')),
    (error: Error) => {
      assert.ok(error instanceof PodLimitReached)
      assert.match(error.message, /2 of 2/)
      assert.match(error.message, /n8n/)
      assert.match(error.message, /hermes/)
      return true
    },
  )
  assert.equal(created.length, 2, 'and no third pod was rented')
})

test('two accesses onto one template share its pod', async () => {
  const { resolver, created } = setup([template('a', 'n8n')])
  await resolver.resolvePod({ wait: true, client: client('n8n-workflow-1', 'a') })
  await resolver.resolvePod({ wait: true, client: client('n8n-workflow-2', 'a') })
  assert.equal(created.length, 1, 'n:1 is one pod, not one per access')
})

test('an existing install keeps working: its tokens stay on the one template', () => {
  // The upgrade path, driven through the real migration rather than a copy of
  // its SQL. An existing single-pod setup must not turn into two accesses that
  // both need assigning by hand before anything works again.
  const file = join(mkdtempSync(join(tmpdir(), 'migrate-')), 'launcher.db')

  const before = openDatabase(file)
  const now = new Date().toISOString()
  const tpl = template('only', 'the-one')
  before
    .prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(tpl.id, tpl.name, JSON.stringify(tpl), now, now)
  for (const [id, name] of [
    ['t1', 'n8n'],
    ['t2', 'hermes'],
  ]) {
    before
      .prepare('INSERT INTO client_tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, `hash-${id}`, now)
  }
  // Wind the schema back to what it looked like before targets existed.
  before.exec('ALTER TABLE client_tokens DROP COLUMN template_id')
  before.close()

  const after = openDatabase(file)
  assert.deepEqual(
    new TokenStore(after).list('client_tokens').map((token) => token.templateId),
    ['only', 'only'],
    'both keep reaching the pod they always reached',
  )
  after.close()
})

test('a column is added even when the migration counter has run ahead', () => {
  // The failure that produced this design, seen on a live database. Migrations
  // used to be counted, so a step withdrawn after somebody had already run it
  // left their counter one ahead — and the next column added was silently
  // skipped. The service then crashed on a column it had just been told to use.
  const file = join(mkdtempSync(join(tmpdir(), 'drift-')), 'launcher.db')

  const drifted = openDatabase(file)
  drifted.exec('ALTER TABLE usage DROP COLUMN template_id')
  // A counter well past anything this version would ever set.
  drifted.pragma('user_version = 99')
  drifted.close()

  const repaired = openDatabase(file)
  const columns = repaired.prepare('PRAGMA table_info(usage)').all() as Array<{ name: string }>
  assert.ok(
    columns.some((column) => column.name === 'template_id'),
    'the column is restored from the real schema, whatever the counter says',
  )
  repaired.close()
})

test('past traffic keeps its template, so a busy pod is not stopped on upgrade', () => {
  // Seen live on the first restart after this change: the usage history had no
  // template on it, so every pod read as never used and the idle rule stopped a
  // pod whose last request was thirteen minutes old under a sixty-minute limit.
  const file = join(mkdtempSync(join(tmpdir(), 'usage-')), 'launcher.db')

  const before = openDatabase(file)
  const now = new Date().toISOString()
  const tpl = template('only', 'the-one')
  before
    .prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(tpl.id, tpl.name, JSON.stringify(tpl), now, now)
  before
    .prepare('INSERT INTO client_tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .run('tok', 'n8n', 'hash', now)
  before
    .prepare('INSERT INTO usage (at, token_id, endpoint) VALUES (?, ?, ?)')
    .run(now, 'tok', '/v1/chat/completions')
  // Back to the schema as it was before any of this: neither the token nor the
  // request carried a template. Both columns are added in one pass on upgrade,
  // tokens first, which is what lets the requests be attributed through them.
  before.exec('ALTER TABLE usage DROP COLUMN template_id')
  before.exec('ALTER TABLE client_tokens DROP COLUMN template_id')
  before.close()

  const after = openDatabase(file)
  const row = after.prepare('SELECT template_id AS templateId FROM usage').get() as {
    templateId: string | null
  }
  assert.equal(row.templateId, 'only', 'the request is attributed through its token')
  after.close()
})

test('an access can only be removed once it is blocked', () => {
  // Blocking is what stops a client working; removing is only about tidying the
  // list afterwards. Letting a removal do both would turn a cleanup gesture
  // into an outage for whatever was still using that token.
  const db = openDatabase(':memory:')
  const tokens = new TokenStore(db)
  const { id } = tokens.issue('client_tokens', 'n8n')

  assert.equal(tokens.delete('client_tokens', id), false, 'an active access stays')
  assert.equal(tokens.list('client_tokens').length, 1)

  tokens.revoke('client_tokens', id)
  assert.equal(tokens.delete('client_tokens', id), true)
  assert.equal(tokens.list('client_tokens').length, 0, 'and then it is gone for good')
})

test('a removed access no longer opens the gateway', () => {
  // The obvious property, worth pinning: `verify` reads the table, so a deleted
  // row cannot authenticate — and a revoked one could not either.
  const db = openDatabase(':memory:')
  const tokens = new TokenStore(db)
  const { id, token } = tokens.issue('client_tokens', 'n8n')

  assert.ok(tokens.verify('client_tokens', token), 'it works while it exists')
  tokens.revoke('client_tokens', id)
  tokens.delete('client_tokens', id)
  assert.equal(tokens.verify('client_tokens', token), null)
})
