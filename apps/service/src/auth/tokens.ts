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
  /**
   * The template this client may reach, or null.
   *
   * Device tokens are never bound to a template — they control the launcher
   * rather than use a model, so this is null for them. For a client token it is
   * the whole routing decision: the pod a request lands on is the pod of this
   * template, which is what lets n8n and a local agent point at different
   * hardware without either of them knowing that.
   */
  templateId: string | null
}

type TokenTable = 'devices' | 'client_tokens'

/** Only client tokens carry a target; the devices table has no such column. */
const isTargeted = (table: TokenTable): boolean => table === 'client_tokens'

export interface TokenSummary {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  templateId: string | null
}

export class TokenStore {
  constructor(private readonly db: Db) {}

  /** Issues a token and returns it once — it is never retrievable again. */
  issue(
    table: TokenTable,
    name: string,
    templateId: string | null = null,
  ): { id: string; token: string } {
    const id = randomUUID()
    const token = generateToken()
    if (isTargeted(table)) {
      this.db
        .prepare(
          `INSERT INTO ${table} (id, name, token_hash, created_at, template_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, name, hash(token), new Date().toISOString(), templateId)
    } else {
      this.db
        .prepare(`INSERT INTO ${table} (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)`)
        .run(id, name, hash(token), new Date().toISOString())
    }
    return { id, token }
  }

  /**
   * Points a client token at a template, or clears its target.
   *
   * Re-pointing happens here rather than at the client: the credential the
   * application holds stays valid, so moving n8n from one pod to another is a
   * change in the launcher alone.
   */
  assign(id: string, templateId: string | null): void {
    this.db.prepare(`UPDATE client_tokens SET template_id = ? WHERE id = ?`).run(templateId, id)
  }

  /** Resolves a presented token, or null when unknown or revoked. */
  verify(table: TokenTable, token: string): Identity | null {
    const target = isTargeted(table) ? 'template_id AS templateId' : 'NULL AS templateId'
    const rows = this.db
      .prepare(`SELECT id, name, token_hash, ${target} FROM ${table} WHERE revoked_at IS NULL`)
      .all() as Array<{ id: string; name: string; token_hash: string; templateId: string | null }>

    const presented = hash(token)
    const match = rows.find((candidate) => safeEqual(candidate.token_hash, presented))
    if (!match) return null

    this.db
      .prepare(`UPDATE ${table} SET last_used_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), match.id)
    return { id: match.id, name: match.name, templateId: match.templateId }
  }

  revoke(table: TokenTable, id: string): void {
    this.db
      .prepare(`UPDATE ${table} SET revoked_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id)
  }

  /**
   * Removes a revoked entry for good, so the list stops growing.
   *
   * Only a revoked one: revoking is what actually stops the access working, and
   * it is reversible in the sense that the record is still there to explain what
   * happened. Deleting is only about tidying the list afterwards, so it must not
   * be the step that also cuts off a live client — that would make a cleanup
   * gesture into an outage.
   *
   * Returns false when the entry is unknown or still active.
   */
  delete(table: TokenTable, id: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM ${table} WHERE id = ? AND revoked_at IS NOT NULL`)
      .run(id)
    return result.changes > 0
  }

  list(table: TokenTable): TokenSummary[] {
    const target = isTargeted(table) ? 'template_id AS templateId' : 'NULL AS templateId'
    return this.db
      .prepare(
        `SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt,
                revoked_at AS revokedAt, ${target}
         FROM ${table} ORDER BY created_at DESC`,
      )
      .all() as TokenSummary[]
  }
}
