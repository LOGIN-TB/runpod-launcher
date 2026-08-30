import Fastify from 'fastify'
import { loadConfig } from './config.js'
import { openDatabase } from './store/db.js'
import { generatePairingCode, loadOrCreateMasterKey } from './store/crypto.js'
import { SettingsStore } from './store/settings.js'
import { TokenStore } from './auth/tokens.js'
import { RunpodClient } from './runpod/client.js'
import { PodManager } from './pods/manager.js'
import { registerGatewayRoutes } from './gateway/routes.js'
import { registerAdminRoutes } from './admin/routes.js'
import { PairingService } from './auth/pairing.js'
import { HuggingFaceClient } from './models/huggingface.js'

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

const pods = new PodManager(db, requireRunpodKey, () => settings.secret('huggingfaceToken'))
const pairing = new PairingService(db, tokens, config.pairingCode ?? generatePairingCode())
const huggingface = new HuggingFaceClient(() => settings.secret('huggingfaceToken'))

app.get('/health', async () => ({
  status: 'ok',
  paired: pairing.hasPairedDevice(),
  pod: pods.current(),
}))

await registerGatewayRoutes(app, {
  resolvePod: async ({ wait }) => {
    const active = pods.describe()
    if (active) return { state: 'ready', pod: active }

    const record = pods.current()
    const template = record ? pods.template(record.templateId) : null
    // Nothing has ever been started for this template, so there is nothing to
    // wake. Saying "still starting" here would send the caller waiting for a
    // boot that was never begun.
    if (!record || !template) return { state: 'none' }
    if (!wait) return { state: 'starting' }

    await pods.start(template)
    const ready = await pods.waitUntilRunning(record.id, settings.read().wakeWaitSeconds * 1000)
    const served = ready ? pods.describe() : null
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

await registerAdminRoutes(app, { db, settings, tokens, pods, pairing, requireRunpodKey, huggingface })

const address = await app.listen({ port: config.port, host: config.host })
app.log.info({ address, tlsMode: config.tlsMode }, 'launcher service listening')

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
    void app.close().then(() => {
      db.close()
      process.exit(0)
    })
  })
}
