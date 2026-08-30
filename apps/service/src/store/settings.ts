import {
  SECRET_SETTING_KEYS,
  settingsSchema,
  type PublicSettings,
  type SecretSettingKey,
  type Settings,
  type SettingsPatch,
} from '@runpod-launcher/shared'
import { decryptSecret, encryptSecret } from './crypto.js'
import type { Db } from './db.js'

const SECRETS = new Set<string>(SECRET_SETTING_KEYS)

/**
 * Reads and writes the settings the user types into the app.
 *
 * Secret values are encrypted on the way in and decrypted only where they are
 * used — never on the way back out to a client. `readPublic` returns
 * `hasRunpodApiKey: true` instead of the key itself.
 */
export class SettingsStore {
  constructor(
    private readonly db: Db,
    private readonly masterKey: Buffer,
  ) {}

  /** Full settings including secrets. Service-internal use only. */
  read(): Settings {
    const rows = this.db.prepare('SELECT key, value, encrypted FROM settings').all() as Array<{
      key: string
      value: string
      encrypted: number
    }>

    const raw: Record<string, unknown> = {}
    for (const row of rows) {
      const value = row.encrypted ? decryptSecret(this.masterKey, row.value) : JSON.parse(row.value)
      raw[row.key] = value
    }
    return settingsSchema.parse(raw)
  }

  /** Settings safe to send to a client: secrets replaced by presence flags. */
  readPublic(): PublicSettings {
    const settings = this.read()
    const result = { ...settings } as Record<string, unknown>
    for (const key of SECRET_SETTING_KEYS) {
      delete result[key]
      result[`has${key[0]!.toUpperCase()}${key.slice(1)}`] = settings[key] !== null
    }
    return result as PublicSettings
  }

  /**
   * Applies a partial update. A secret set to `undefined` is left alone, so the
   * UI can submit a form without echoing back values it was never shown; `null`
   * clears it.
   */
  update(patch: SettingsPatch): void {
    const now = new Date().toISOString()
    const upsert = this.db.prepare(
      `INSERT INTO settings (key, value, encrypted, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                      encrypted = excluded.encrypted,
                                      updated_at = excluded.updated_at`,
    )
    const remove = this.db.prepare('DELETE FROM settings WHERE key = ?')

    this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue
        if (value === null) {
          remove.run(key)
          continue
        }
        const isSecret = SECRETS.has(key)
        const stored = isSecret
          ? encryptSecret(this.masterKey, value as string)
          : JSON.stringify(value)
        upsert.run(key, stored, isSecret ? 1 : 0, now)
      }
    })()
  }

  /** A single secret, decrypted. Returns null when unset. */
  secret(key: SecretSettingKey): string | null {
    return this.read()[key]
  }
}
