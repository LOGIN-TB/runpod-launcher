import type { Connection } from './api.js'

/**
 * Where the device token lives.
 *
 * Inside the Tauri shell it goes to the OS credential store — the macOS
 * Keychain, the Windows Credential Manager. In a plain browser there is no such
 * place, so it falls back to `localStorage`, which is fine for development and
 * stated plainly rather than pretended otherwise.
 *
 * The difference matters: a token in `localStorage` is readable by any script
 * on the page and travels in a disk backup in clear. It is a long-lived
 * credential that can rent GPUs on the user's account.
 */

const FALLBACK_KEY = 'launcher.connection'

interface TauriBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
}

/** Present only when running inside the desktop shell. */
function bridge(): TauriBridge | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: TauriBridge }).__TAURI_INTERNALS__
  return internals && typeof internals.invoke === 'function' ? internals : null
}

export const isDesktopShell = (): boolean => bridge() !== null

export async function loadConnection(): Promise<Connection | null> {
  const tauri = bridge()
  if (tauri) {
    const stored = await tauri.invoke<{ base_url: string; token: string } | null>('load_connection')
    return stored ? { baseUrl: stored.base_url, token: stored.token } : null
  }

  try {
    const raw = localStorage.getItem(FALLBACK_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Connection
    return parsed.baseUrl && parsed.token ? parsed : null
  } catch {
    return null
  }
}

export async function saveConnection(connection: Connection): Promise<void> {
  const tauri = bridge()
  if (tauri) {
    await tauri.invoke('save_connection', {
      connection: { base_url: connection.baseUrl, token: connection.token },
    })
    return
  }
  localStorage.setItem(FALLBACK_KEY, JSON.stringify(connection))
}

export async function clearConnection(): Promise<void> {
  const tauri = bridge()
  if (tauri) {
    await tauri.invoke('clear_connection')
    return
  }
  localStorage.removeItem(FALLBACK_KEY)
}

/**
 * Puts the hourly cost in the menu bar while a pod runs.
 *
 * Silently does nothing in a browser: the tray is the shell's contribution, and
 * the interface should not have to care which one it is in.
 */
export async function setTrayStatus(running: boolean, costPerHour: number): Promise<void> {
  const tauri = bridge()
  if (!tauri) return
  await tauri.invoke('set_tray_status', { running, costPerHour }).catch(() => undefined)
}
