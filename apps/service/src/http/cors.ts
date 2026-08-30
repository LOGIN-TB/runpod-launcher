import type { FastifyInstance } from 'fastify'
import type { SettingsStore } from '../store/settings.js'

/**
 * Origins the desktop app is served from.
 *
 * A Tauri webview does not run on `http://localhost`; it has its own scheme,
 * and which one depends on the platform. Every request it makes to the service
 * is therefore cross-origin, and without these headers the webview discards the
 * response — the app reports "nothing answered at that address" while the
 * service is answering perfectly well to every other client.
 */
const APP_ORIGINS = [
  'tauri://localhost', // macOS and Linux
  'http://tauri.localhost', // Windows
  'https://tauri.localhost',
]

/**
 * Allows the app, the dev server, and any browser client the user has added.
 *
 * CORS is not what protects this service — every route needs a bearer token,
 * and a web page cannot obtain one by asking. It is kept narrow regardless, so
 * a page the user happens to have open cannot probe their own machine.
 */
export function registerCors(
  app: FastifyInstance,
  settings: SettingsStore,
  devOrigin: string | undefined,
): void {
  const refused = new Set<string>()
  const allowed = (origin: string): boolean => {
    if (APP_ORIGINS.includes(origin)) return true
    if (devOrigin && origin === devOrigin) return true
    // Browser clients such as Open WebUI, added by the user in Settings.
    return settings.read().corsOrigins.includes(origin)
  }

  app.addHook('onSend', async (request, reply) => {
    const origin = request.headers.origin
    if (!origin) return

    if (!allowed(origin)) {
      // Named once per origin. A blocked response looks identical to an
      // unreachable service from inside a webview, and without this line the
      // only way to tell them apart is to guess.
      if (!refused.has(origin)) {
        refused.add(origin)
        app.log.warn(
          { origin },
          'refused a cross-origin request; add this origin to corsOrigins if it is yours',
        )
      }
      return
    }
    reply.header('access-control-allow-origin', origin)
    reply.header('access-control-allow-headers', 'authorization, content-type')
    reply.header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    reply.header('access-control-max-age', '86400')
    // Caches must not hand one origin's response to another.
    reply.header('vary', 'origin')
  })

  app.options('/*', async (_request, reply) => reply.code(204).send())
}
