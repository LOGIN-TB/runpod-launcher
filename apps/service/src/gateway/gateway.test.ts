import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import { registerGatewayRoutes, type GatewayDeps } from './routes.js'

const deps = (overrides: Partial<GatewayDeps> = {}): GatewayDeps => ({
  resolvePod: async () => ({ state: 'none' }),
  advertisedModels: async () => [],
  authenticateClient: async (token) => (token === 'good' ? { id: 'c1', name: 'client' } : null),
  recordUsage: () => {},
  wakeWaitSeconds: () => 60,
  track: (work: () => Promise<unknown>) => work(),
  ...overrides,
}) as GatewayDeps

const app = async (d: GatewayDeps) => {
  const server = Fastify()
  await registerGatewayRoutes(server, d)
  return server
}

const body = (response: { body: string }): Record<string, unknown> => JSON.parse(response.body)

test('a failure while resolving the pod still reads as an OpenAI error', async () => {
  // The real case: no RunPod key configured. It surfaced as Fastify's default
  // { statusCode, error, message }, which every OpenAI SDK renders as
  // "Unknown error" — turning a precise message into a mystery.
  const server = await app(
    deps({
      resolvePod: async () => {
        throw new Error('No RunPod API key configured. Add it in the launcher app.')
      },
    }),
  )

  const response = await server.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: 'Bearer good' },
    payload: { model: 'm', messages: [] },
  })

  assert.equal(response.statusCode, 503)
  const payload = body(response) as { error?: { message: string; type: string; code: string } }
  assert.ok(payload.error, 'the body must have an `error` object')
  assert.match(payload.error!.message, /No RunPod API key configured/)
  assert.equal(payload.error!.type, 'server_error')
})

test('/v1/models survives the same failure instead of returning a 500', async () => {
  const server = await app(
    deps({
      resolvePod: async () => {
        throw new Error('boom')
      },
    }),
  )
  const response = await server.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer good' } })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(body(response), { object: 'list', data: [] })
})

test('a bad token is rejected in the shape clients expect', async () => {
  const server = await app(deps())
  const response = await server.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer wrong' } })
  assert.equal(response.statusCode, 401)
  const payload = body(response) as { error: { code: string } }
  assert.equal(payload.error.code, 'invalid_api_key')
})

test('a sleeping pod that is still booting answers 503 with Retry-After', async () => {
  const server = await app(deps({ resolvePod: async () => ({ state: 'starting' }) }))
  const response = await server.inject({
    method: 'POST',
    url: '/v1/embeddings',
    headers: { authorization: 'Bearer good' },
    payload: { model: 'm', input: 'x' },
  })
  assert.equal(response.statusCode, 503)
  assert.equal(response.headers['retry-after'], '30')
  assert.equal((body(response) as { error: { code: string } }).error.code, 'model_loading')
})

test('models are advertised while the pod sleeps, or no client can ever wake it', () => {
  // A client lists models before it can pick one. With an empty list an agent
  // reports "0 models" and stops — so the request that would have started the
  // pod is never sent.
  return (async () => {
    const server = await app(
      deps({
        resolvePod: async () => ({ state: 'none' }),
        advertisedModels: async () => ['Qwen/Qwen3.8-27B-FP8', 'Qwen/Qwen3-Embedding-0.6B'],
      }),
    )
    const response = await server.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer good' },
    })
    const payload = body(response) as { data: Array<{ id: string }> }
    assert.deepEqual(payload.data.map((model) => model.id), [
      'Qwen/Qwen3.8-27B-FP8',
      'Qwen/Qwen3-Embedding-0.6B',
    ])
  })()
})

test('a running pod still reports what it actually serves, not the template', async () => {
  const server = await app(
    deps({
      resolvePod: async () => ({
        state: 'ready',
        pod: { chatUrl: 'http://x', embeddingUrl: null, podApiKey: 'k', servedModels: ['actually-loaded'] },
      }),
      advertisedModels: async () => ['something-else'],
    }),
  )
  const response = await server.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer good' } })
  assert.deepEqual((body(response) as { data: Array<{ id: string }> }).data.map((m) => m.id), ['actually-loaded'])
})

test('a pod that is RUNNING but not yet listening is waited for, not forwarded into', async () => {
  // Reported live: an agent got HTTP 404 in 0.35 s, three times. The route
  // existed and the model name matched — the 404 came from RunPod's proxy,
  // which answers 404 until something binds the port, and was passed straight
  // through. Our records said RUNNING, which RunPod reports minutes before the
  // engine can serve.
  const server = await app(deps({ resolvePod: async () => ({ state: 'starting' }) }))

  const response = await server.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: 'Bearer good' },
    payload: { model: 'm', messages: [{ role: 'user', content: 'hallo' }] },
  })

  assert.equal(response.statusCode, 503, 'not a 404: the request is early, not wrong')
  const payload = body(response) as { error: { code: string; message: string } }
  assert.equal(payload.error.code, 'model_loading')
  assert.match(payload.error.message, /still starting/)
  assert.equal(response.headers['retry-after'], '30')
})

test('a 404 from the proxy in front of the pod is not passed off as the engine’s', async () => {
  // The engine answers JSON. RunPod's proxy answers text when nothing is bound
  // to the port, and forwarding that told the client its request was wrong.
  const fromProxy = new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  const server = await app(
    deps({
      resolvePod: async () => ({
        state: 'ready',
        pod: { chatUrl: 'http://pod', embeddingUrl: null, podApiKey: 'k', servedModels: ['m'] },
      }),
    }),
  )
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => fromProxy) as unknown as typeof fetch
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer good' },
      payload: { model: 'm', messages: [] },
    })
    assert.equal(response.statusCode, 503)
    assert.equal((body(response) as { error: { code: string } }).error.code, 'model_loading')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a genuine 404 from the engine is passed through unchanged', async () => {
  const fromEngine = new Response('{"error":{"message":"no such model"}}', {
    status: 404,
    headers: { 'content-type': 'application/json' },
  })
  const server = await app(
    deps({
      resolvePod: async () => ({
        state: 'ready',
        pod: { chatUrl: 'http://pod', embeddingUrl: null, podApiKey: 'k', servedModels: ['m'] },
      }),
    }),
  )
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => fromEngine) as unknown as typeof fetch
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer good' },
      payload: { model: 'm', messages: [] },
    })
    assert.equal(response.statusCode, 404, 'the engine’s own verdict stands')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a request outside the scheduled hours is refused, not answered with a new GPU', async () => {
  // The two features cancelled each other out: the schedule stopped the pod at
  // 21:30:19 and the next request from the same agent rented another at
  // 21:30:21. The schedule then saves nothing and costs a broken task.
  const server = await app(
    deps({ resolvePod: async () => ({ state: 'outside-hours', window: '07:00–21:00 Europe/Berlin' }) }),
  )
  const response = await server.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: 'Bearer good' },
    payload: { model: 'm', messages: [] },
  })

  assert.equal(response.statusCode, 503)
  const payload = body(response) as { error: { code: string; message: string } }
  assert.equal(payload.error.code, 'outside_scheduled_hours')
  assert.match(payload.error.message, /07:00–21:00/)
  assert.match(payload.error.message, /start it from the launcher app/i)
})

test('requests are counted while they are being served', async () => {
  // The scheduler reads this to decide whether stopping would cut somebody off.
  let peak = 0
  let current = 0
  const server = await app(
    deps({
      resolvePod: async () => ({ state: 'none' }),
      track: async (work) => {
        current += 1
        peak = Math.max(peak, current)
        try {
          return await work()
        } finally {
          current -= 1
        }
      },
    }),
  )
  await server.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: 'Bearer good' },
    payload: { model: 'm', messages: [] },
  })
  assert.equal(peak, 1)
  assert.equal(current, 0, 'and released afterwards')
})
