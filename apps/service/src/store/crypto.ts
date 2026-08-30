import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12

/**
 * Loads the master key, creating it on first start.
 *
 * The key lives as a file in the service's data volume rather than being
 * derived from a password the user types. That is a deliberate trade: a
 * password would protect the secrets from someone with server access, but the
 * scheduler has to stop a pod at 03:00 without anybody present — and a service
 * that cannot start unattended after a reboot silently stops saving money.
 */
export function loadOrCreateMasterKey(path: string): Buffer {
  try {
    const key = readFileSync(path)
    if (key.length !== KEY_BYTES) {
      throw new Error(`Master key at ${path} is ${key.length} bytes, expected ${KEY_BYTES}`)
    }
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const key = randomBytes(KEY_BYTES)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, key, { mode: 0o600 })
    chmodSync(path, 0o600)
    return key
  }
}

/** Encrypts a secret. Output is `iv.tag.ciphertext`, base64url, safe to store. */
export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64url')).join('.')
}

export function decryptSecret(key: Buffer, stored: string): string {
  const parts = stored.split('.')
  if (parts.length !== 3) throw new Error('Malformed encrypted value')
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer]
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** Constant-time comparison, for tokens and pairing codes. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** A URL-safe random token. 32 bytes is 256 bits of entropy. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/**
 * A short pairing code a person can read off a log and retype.
 * Ambiguous characters (0/O, 1/I/L) are excluded on purpose.
 */
export function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const raw = randomBytes(12)
  const chars = Array.from(raw, (byte) => alphabet[byte % alphabet.length])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`
}
