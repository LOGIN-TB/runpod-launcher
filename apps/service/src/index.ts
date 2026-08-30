import Fastify from 'fastify'
import { loadConfig } from './config.js'
import { openDatabase } from './store/db.js'
import { decryptSecret, encryptSecret, generatePairingCode, loadOrCreateMasterKey } from './store/crypto.js'
import { SettingsStore } from './store/settings.js'
import { TokenStore } from './auth/tokens.js'
import { RunpodClient } from './runpod/client.js'
import { PodManager } from './pods/manager.js'
import { registerGatewayRoutes } from './gateway/routes.js'
import { registerAdminRoutes } from './admin/routes.js'
import { PairingService } from './auth/pairing.js'
import { HuggingFaceClient } from './models/huggingface.js'
import { SpendTracker } from './scheduler/spend.js'
import { Notifier } from './scheduler/notify.js'
import { Scheduler } from './scheduler/scheduler.js'

const config = loadConfig()
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  // Long generations must not be cut off by our own server.
  requestTimeout: 0,
  // Coolify and other proxies sit in front; trust their forwarding headers so
  // audit log entries record the real client address.
  trustProxy: config.tlsMode === 'proxy',
})

const db = openDatabase(config.databasePath)
const masterKey = loadOrCreateMasterKey(config.masterKeyPath)
const settings = new SettingsStore(db, masterKey)
const tokens = new TokenStore(db)

const requireRunpodKey = (): RunpodClient => {
  const key = settings.secret('runpodApiKey')
  if (!key) throw new Error('No RunPod API key configured. Add it in the launcher app.')
  return new RunpodClient(key)
}

const pods = new PodManager(db, requireRunpodKey, () => settings.secret('huggingfaceToken'), {
  encrypt: (value) => encryptSecret(masterKey, value),
  decrypt: (value) => decryptSecret(masterKey, value),
})
const pairing = new PairingService(db, tokens, config.pairingCode ?? generatePairingCode())
const huggingface = new HuggingFaceClient(() => settings.secret('huggingfaceToken'))
const spend = new SpendTracker(db, requireRunpodKey, () => settings.read().timezone)
const notifier = new Notifier(settings, app.log)
const scheduler = new Scheduler(db, settings, pods, spend, notifier, app.log)

/**
 * Lets the UI's dev server talk to the service.
 *
 * Only in development: the built app is served from the same origin (or from
 * Tauri's own scheme), so production never needs this. Origins the gateway
 * accepts are configured separately, in settings.
 */
if (process.env.ALLOW_UI_ORIGIN) {
  const allowed = process.env.ALLOW_UI_ORIGIN
  app.addHook('onSend', async (request, reply) => {
    reply.header('access-control-allow-origin', allowed)
    reply.header('access-control-allow-headers', 'authorization, content-type')
    reply.header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  })
  app.options('/*', async (_request, reply) => reply.code(204).send())
}

app.get('/health', async () => ({
  status: 'ok',
  paired: pairing.hasPairedDevice(),
  pod: pods.current(),
}))

await registerGatewayRoutes(app, {
  resolvePod: async ({ wait }) => {
    const active = pods.describe()
    if (active) return { state: 'ready', pod: active }

    // Falls back to the scheduled template, so a request arriving after the
    // night shutdown can still wake the pod — which is the whole point of
    // wake-on-request.
    const template = pods.wakeTarget()
    if (!template) return { state: 'none' }

    const waitSeconds = settings.read().wakeWaitSeconds
    if (!wait || waitSeconds === 0) return { state: 'starting' }

    const record = await pods.start(template)
    // Waits for the engine to answer, not just for RunPod to schedule the
    // container — those are minutes apart, and the gap is exactly where a
    // client would get a bare 404 from a port nothing is listening on.
    const serving = await pods.waitUntilServing(record.id, waitSeconds * 1000)
    const served = serving ? pods.describe() : null
    return served ? { state: 'ready', pod: served } : { state: 'starting' }
  },
  authenticateClient: async (token) => tokens.verify('client_tokens', token),
  recordUsage: (entry) => {
    db.prepare(
      `INSERT INTO usage (at, token_id, model, endpoint, duration_ms) VALUES (?, ?, ?, ?, ?)`,
    ).run(new Date().toISOString(), entry.tokenId, entry.model, entry.endpoint, entry.durationMs)
  },
  wakeWaitSeconds: () => settings.read().wakeWaitSeconds,
})

await registerAdminRoutes(app, { db, settings, tokens, pods, pairing, requireRunpodKey, huggingface, spend, scheduler })

const address = await app.listen({ port: config.port, host: config.host })
app.log.info({ address, tlsMode: config.tlsMode }, 'launcher service listening')

// Always running. Each tick checks for credentials itself, because they are
// entered after the service is up — gating the start on them meant a schedule
// created on day one would not run until the container was restarted.
scheduler.start()
app.log.info({}, 'scheduler running')

if (!pairing.hasPairedDevice()) {
  // Printed plainly rather than through the structured logger: this is the one
  // line a person has to read off the screen and retype into the app.
  process.stdout.write(
    `\n${'='.repeat(58)}\n` +
      `  Pair the launcher app with this code:\n\n` +
      `      ${pairing.code}\n\n` +
      `  It works once and expires in ${PairingService.TTL_MINUTES} minutes.\n` +
      `${'='.repeat(58)}\n\n`,
  )
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'shutting down')
    scheduler.stop()
    void app.close().then(() => {
      db.close()
      process.exit(0)
    })
  })
}
