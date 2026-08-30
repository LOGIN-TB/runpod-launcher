import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { openDatabase } from '../store/db.js'
import { TokenStore } from './tokens.js'
import { PairingService } from './pairing.js'

const setup = (): { pairing: PairingService; tokens: TokenStore; db: Database.Database } => {
  const db = openDatabase(':memory:')
  const tokens = new TokenStore(db)
  return { db, tokens, pairing: new PairingService(db, tokens, 'AAAA-BBBB-CCCC') }
}

test('a correct code pairs a device', () => {
  const { pairing } = setup()
  const result = pairing.redeem('AAAA-BBBB-CCCC', 'Mac')
  assert.equal(result.ok, true)
  assert.ok(result.ok && result.token.length > 32)
})

test('the code is accepted regardless of case and surrounding space', () => {
  const { pairing } = setup()
  assert.equal(pairing.redeem('  aaaa-bbbb-cccc ', 'Mac').ok, true)
})

test('a code cannot be redeemed twice', () => {
  const { pairing } = setup()
  assert.equal(pairing.redeem('AAAA-BBBB-CCCC', 'Mac').ok, true)
  const second = pairing.redeem('AAAA-BBBB-CCCC', 'Attacker')
  assert.equal(second.ok, false)
  assert.match(second.ok === false ? second.reason : '', /already been used/)
})

test('a paired device can mint a fresh code for a second device', () => {
  const { pairing } = setup()
  pairing.redeem('AAAA-BBBB-CCCC', 'Mac')
  const next = pairing.issueNewCode('DDDD-EEEE-FFFF')
  assert.equal(next.code, 'DDDD-EEEE-FFFF')
  assert.equal(pairing.redeem('DDDD-EEEE-FFFF', 'Windows').ok, true)
})

test('guessing is locked out, and the lockout survives a correct guess', () => {
  const { pairing } = setup()
  for (let i = 0; i < 5; i += 1) pairing.redeem('ZZZZ-ZZZZ-ZZZZ', 'x')
  const afterLockout = pairing.redeem('AAAA-BBBB-CCCC', 'x')
  assert.equal(afterLockout.ok, false)
  assert.match(afterLockout.ok === false ? afterLockout.reason : '', /Too many attempts/)
})

test('devices and client tokens are separate realms', () => {
  const { tokens } = setup()
  const device = tokens.issue('devices', 'Mac')
  const client = tokens.issue('client_tokens', 'n8n')

  assert.equal(tokens.verify('devices', client.token), null, 'a client token must not pass as a device')
  assert.equal(tokens.verify('client_tokens', device.token), null, 'a device token must not pass as a client')
  assert.equal(tokens.verify('devices', device.token)?.name, 'Mac')
})

test('a revoked token stops working', () => {
  const { tokens } = setup()
  const issued = tokens.issue('client_tokens', 'n8n')
  assert.ok(tokens.verify('client_tokens', issued.token))
  tokens.revoke('client_tokens', issued.id)
  assert.equal(tokens.verify('client_tokens', issued.token), null)
})
