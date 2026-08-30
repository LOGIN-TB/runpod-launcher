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
