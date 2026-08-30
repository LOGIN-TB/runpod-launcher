import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { openDatabase } from '../store/db.js'
import { loadOrCreateMasterKey } from '../store/crypto.js'
import { SettingsStore } from '../store/settings.js'
import { registerCors } from './cors.js'

const build = async (options: { devOrigin?: string; corsOrigins?: string[] } = {}) => {
  const key = loadOrCreateMasterKey(join(mkdtempSync(join(tmpdir(), 'cors-')), 'master.key'))
  const settings = new SettingsStore(openDatabase(':memory:'), key)
  if (options.corsOrigins) settings.update({ corsOrigins: options.corsOrigins })

  const app = Fastify()
  registerCors(app, settings, options.devOrigin)
  app.get('/health', async () => ({ status: 'ok' }))
  return app
}

const allowOrigin = (response: { headers: Record<string, unknown> }): string | undefined =>
  response.headers['access-control-allow-origin'] as string | undefined

test('the desktop app can reach the service on every platform', async () => {
  // This is what broke the first real test of the packaged app: the service
  // ran fine, answered curl fine, and the webview silently dropped every
  // response — so the app said "nothing answered at that address".
  const app = await build()
  for (const origin of ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']) {
    const response = await app.inject({ method: 'GET', url: '/health', headers: { origin } })
    assert.equal(allowOrigin(response), origin, `${origin} must be allowed`)
    assert.equal(response.headers['vary'], 'origin')
  }
})

test('a preflight is answered, so requests carrying a token are allowed through', async () => {
  const app = await build()
  const response = await app.inject({
    method: 'OPTIONS',
    url: '/settings',
    headers: { origin: 'tauri://localhost', 'access-control-request-method': 'PATCH' },
  })
  assert.equal(response.statusCode, 204)
  assert.match(String(response.headers['access-control-allow-headers']), /authorization/)
})

test('an unrelated page gets no CORS headers at all', async () => {
  const app = await build()
  const response = await app.inject({
    method: 'GET',
    url: '/health',
    headers: { origin: 'https://evil.example.com' },
  })
  assert.equal(allowOrigin(response), undefined)
})

test('a browser client the user added is allowed, and only that one', async () => {
  const app = await build({ corsOrigins: ['https://chat.example.com'] })

  const added = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://chat.example.com' } })
  assert.equal(allowOrigin(added), 'https://chat.example.com')

  const other = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://chat.example.org' } })
  assert.equal(allowOrigin(other), undefined, 'a lookalike domain must not pass')
})

test('the dev server origin is allowed only when configured', async () => {
  const without = await build()
  assert.equal(
    allowOrigin(await without.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:5173' } })),
    undefined,
  )

  const with_ = await build({ devOrigin: 'http://localhost:5173' })
  assert.equal(
    allowOrigin(await with_.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:5173' } })),
    'http://localhost:5173',
  )
})
