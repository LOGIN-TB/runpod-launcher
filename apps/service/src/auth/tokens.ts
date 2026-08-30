import { createHash, randomUUID } from 'node:crypto'
import type { Db } from '../store/db.js'
import { generateToken, safeEqual } from '../store/crypto.js'

/**
 * Tokens are stored as SHA-256 hashes, never in clear.
 *
 * SHA-256 rather than Argon2 here on purpose: these are 256-bit random values,
 * not user-chosen passwords, so there is nothing to brute-force and the hash
 * only has to survive a database leak. The pairing code — short enough to
 * retype — is the one value that also gets a rate limit and an expiry.
 */
const hash = (token: string): string => createHash('sha256').update(token).digest('hex')

export interface Identity {
  id: string
  name: string
}

type TokenTable = 'devices' | 'client_tokens'

export class TokenStore {
  constructor(private readonly db: Db) {}

  /** Issues a token and returns it once — it is never retrievable again. */
  issue(table: TokenTable, name: string): { id: string; token: string } {
    const id = randomUUID()
    const token = generateToken()
    this.db
      .prepare(`INSERT INTO ${table} (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, name, hash(token), new Date().toISOString())
    return { id, token }
  }

  /** Resolves a presented token, or null when unknown or revoked. */
  verify(table: TokenTable, token: string): Identity | null {
    const row = this.db
      .prepare(`SELECT id, name, token_hash FROM ${table} WHERE revoked_at IS NULL`)
      .all() as Array<{ id: string; name: string; token_hash: string }>

    const presented = hash(token)
    const match = row.find((candidate) => safeEqual(candidate.token_hash, presented))
    if (!match) return null

    this.db
      .prepare(`UPDATE ${table} SET last_used_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), match.id)
    return { id: match.id, name: match.name }
  }

  revoke(table: TokenTable, id: string): void {
    this.db
      .prepare(`UPDATE ${table} SET revoked_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id)
  }

  list(table: TokenTable): Array<{ id: string; name: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }> {
    return this.db
      .prepare(
        `SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt
         FROM ${table} ORDER BY created_at DESC`,
      )
      .all() as Array<{ id: string; name: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }>
  }
}
