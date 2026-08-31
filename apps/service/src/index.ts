import Fastify from 'fastify'
import { loadConfig } from './config.js'
import { openDatabase } from './store/db.js'
import { decryptSecret, encryptSecret, generatePairingCode, loadOrCreateMasterKey } from './store/crypto.js'
import { SettingsStore } from './store/settings.js'
import { migrateTemplates } from './store/migrate-templates.js'
import { TokenStore } from './auth/tokens.js'
import { RunpodClient } from './runpod/client.js'
import { PodManager } from './pods/manager.js'
import { registerGatewayRoutes } from './gateway/routes.js'
import { createPodResolver } from './gateway/resolve.js'
import { registerAdminRoutes } from './admin/routes.js'
import { registerCors } from './http/cors.js'
import { PairingService } from './auth/pairing.js'
import { HuggingFaceClient } from './models/huggingface.js'
import { SpendTracker } from './scheduler/spend.js'
import { Notifier } from './scheduler/notify.js'
import { Scheduler } from './scheduler/scheduler.js'
import { InFlight } from './gateway/inflight.js'
import { reapSupersededPods } from './pods/reaper.js'

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

// Templates carry the arguments they were created with, so a corrected preset
// does not reach the ones that already exist.
migrateTemplates(db, (message) => app.log.warn({}, message))
const tokens = new TokenStore(db)

const requireRunpodKey = (): RunpodClient => {
  const key = settings.secret('runpodApiKey')
  if (!key) throw new Error('No RunPod API key configured. Add it in the launcher app.')
  return new RunpodClient(key)
}

const pods = new PodManager(
  db,
  requireRunpodKey,
  () => settings.secret('huggingfaceToken'),
  {
    encrypt: (value) => encryptSecret(masterKey, value),
    decrypt: (value) => decryptSecret(masterKey, value),
  },
  () => settings.read().maxConcurrentPods,
)
const pairing = new PairingService(db, tokens, config.pairingCode ?? generatePairingCode())
const huggingface = new HuggingFaceClient(() => settings.secret('huggingfaceToken'))
const spend = new SpendTracker(db, requireRunpodKey, () => settings.read().timezone)
const notifier = new Notifier(settings, app.log)
// Counts requests in flight, so the scheduler does not stop a pod in the
// middle of generating an answer somebody is waiting for.
const inFlight = new InFlight()
const scheduler = new Scheduler(db, settings, pods, spend, notifier, app.log, () => inFlight.count)

// The desktop app's webview has its own origin, so every call it makes is
// cross-origin. Without this the app cannot reach the service at all.
registerCors(app, settings, process.env.ALLOW_UI_ORIGIN)

app.get('/health', async () => ({
  status: 'ok',
  paired: pairing.hasPairedDevice(),
  pod: pods.current(),
}))

const resolver = createPodResolver({ pods, wakeWaitSeconds: () => settings.read().wakeWaitSeconds })

await registerGatewayRoutes(app, {
  ...resolver,
  authenticateClient: async (token) => tokens.verify('client_tokens', token),
  recordUsage: (entry) => {
    db.prepare(
      `INSERT INTO usage (at, token_id, template_id, model, endpoint, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      entry.tokenId,
      entry.templateId,
      entry.model,
      entry.endpoint,
      entry.durationMs,
    )
  },
  wakeWaitSeconds: () => settings.read().wakeWaitSeconds,
  track: (work) => inFlight.track(work),
})

await registerAdminRoutes(app, { db, settings, tokens, pods, pairing, requireRunpodKey, huggingface, spend, scheduler })

const address = await app.listen({ port: config.port, host: config.host })
app.log.info({ address, tlsMode: config.tlsMode }, 'launcher service listening')

// Always running. Each tick checks for credentials itself, because they are
// entered after the service is up — gating the start on them meant a schedule
// created on day one would not run until the container was restarted.
scheduler.start()
app.log.info({}, 'scheduler running')

// Clears away pods left behind before this version existed. The scheduler does
// the same on every tick; doing it at startup means a long-stopped launcher
// tidies up immediately rather than a minute later.
if (settings.secret('runpodApiKey')) {
  void reapSupersededPods(db, pods, (message, detail) => app.log.info(detail, message)).catch(
    (error: unknown) => app.log.warn({ error: (error as Error).message }, 'reaping pods failed'),
  )
}

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
