import type { Db } from '../store/db.js'
import { safeEqual } from '../store/crypto.js'
import type { TokenStore } from './tokens.js'

/**
 * First-contact handshake between the desktop app and the service.
 *
 * The code is short enough to read off a container log and retype, which makes
 * it the weakest secret in the system — so it is single-use, expires, and
 * survives only a handful of wrong guesses. Once redeemed, the app holds a
 * full-strength device token instead and the code is irrelevant.
 */
export class PairingService {
  static readonly TTL_MINUTES = 30
  private static readonly MAX_ATTEMPTS = 5

  private attempts = 0
  private expiresAt: number
  private redeemed = false
  #code: string

  constructor(
    private readonly db: Db,
    private readonly tokens: TokenStore,
    initialCode: string,
  ) {
    this.#code = initialCode
    this.expiresAt = Date.now() + PairingService.TTL_MINUTES * 60_000
  }

  get code(): string {
    return this.#code
  }

  /**
   * Mints a fresh code so an already-paired device can enrol a second one — a
   * Windows machine alongside a Mac — without restarting the container.
   * Callers must already hold a device token.
   */
  issueNewCode(newCode: string): { code: string; expiresAt: string } {
    this.#code = newCode
    this.attempts = 0
    this.redeemed = false
    this.expiresAt = Date.now() + PairingService.TTL_MINUTES * 60_000
    return { code: this.#code, expiresAt: new Date(this.expiresAt).toISOString() }
  }

  hasPairedDevice(): boolean {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM devices WHERE revoked_at IS NULL')
      .get() as { count: number }
    return row.count > 0
  }

  /** Exchanges a correct code for a device token. */
  redeem(
    presentedCode: string,
    deviceName: string,
  ): { ok: true; token: string; id: string } | { ok: false; reason: string } {
    if (this.redeemed) {
      return {
        ok: false,
        reason:
          'This pairing code has already been used. Generate a new one from an app that is already paired, or restart the service.',
      }
    }
    if (this.attempts >= PairingService.MAX_ATTEMPTS) {
      return { ok: false, reason: 'Too many attempts. Restart the service to get a fresh code.' }
    }
    if (Date.now() > this.expiresAt) {
      return { ok: false, reason: 'This pairing code has expired. Restart the service for a new one.' }
    }

    const normalise = (value: string): string => value.trim().toUpperCase().replace(/\s+/g, '')
    if (!safeEqual(normalise(presentedCode), normalise(this.code))) {
      this.attempts += 1
      return { ok: false, reason: 'Wrong pairing code.' }
    }

    // Burn the code before issuing: a code that survives its own redemption is
    // a standing invitation for anyone who ever saw a log line.
    this.redeemed = true
    const issued = this.tokens.issue('devices', deviceName || 'Unnamed device')
    return { ok: true, token: issued.token, id: issued.id }
  }
}
