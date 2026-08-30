/**
 * The fetch the app uses to reach the launcher service.
 *
 * Inside the desktop shell this is Tauri's, which performs the request in Rust.
 * That matters for one reason: a webview is bound by CORS, and the service
 * lives at whatever address the user types. Relying on the browser fetch would
 * mean every user had to configure CORS on their own service before the app
 * could talk to it — and when they had not, the app reported the service as
 * unreachable while it was answering perfectly well. Requests from Rust are not
 * cross-origin at all.
 *
 * In a plain browser it falls back to the built-in fetch, where CORS does
 * apply; the service allows the dev server origin for exactly that case.
 */
type FetchLike = typeof fetch

let cached: FetchLike | null = null

export async function serviceFetch(input: URL | string, init?: RequestInit): Promise<Response> {
  cached ??= await resolveFetch()
  return cached(input as RequestInfo, init)
}

async function resolveFetch(): Promise<FetchLike> {
  if (!('__TAURI_INTERNALS__' in globalThis)) return globalThis.fetch.bind(globalThis)
  try {
    const plugin = await import('@tauri-apps/plugin-http')
    return plugin.fetch as unknown as FetchLike
  } catch {
    // Better a request that CORS might block than no request at all.
    return globalThis.fetch.bind(globalThis)
  }
}
