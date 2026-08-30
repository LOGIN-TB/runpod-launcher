import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = Database.Database

/**
 * Schema migrations, applied in order. Each entry runs exactly once; the
 * applied count is tracked in SQLite's own `user_version`.
 *
 * Never edit a migration that has shipped — append a new one instead.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    encrypted  INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  -- Paired desktop apps. The token itself is never stored, only its hash.
  CREATE TABLE devices (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    token_hash  TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
  );

  -- Tokens for anything that consumes the model: n8n, agents, scripts.
  -- Deliberately separate from devices: these may never start a pod.
  CREATE TABLE client_tokens (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
  );

  CREATE TABLE templates (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    config     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE pods (
    id            TEXT PRIMARY KEY,
    template_id   TEXT REFERENCES templates(id) ON DELETE SET NULL,
    status        TEXT NOT NULL,
    cost_per_hour REAL NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    started_at    TEXT,
    stopped_at    TEXT,
    last_seen_at  TEXT
  );

  CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    detail     TEXT,
    ip         TEXT
  );
  CREATE INDEX idx_audit_at ON audit_log(at);

  CREATE TABLE usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT NOT NULL,
    token_id      TEXT,
    model         TEXT,
    endpoint      TEXT NOT NULL,
    prompt_tokens INTEGER,
    output_tokens INTEGER,
    duration_ms   INTEGER
  );
  CREATE INDEX idx_usage_at ON usage(at);
  `,
  // Why a pod was stopped. Needed so an idle shutdown is not immediately undone
  // by the schedule seeing an open window and starting the pod again.
  `ALTER TABLE pods ADD COLUMN stop_reason TEXT;`,
  // The bearer token the pod's own engine expects, encrypted.
  //
  // It used to live only in memory, so restarting the service left the launcher
  // unable to talk to a pod that was still running and still being billed —
  // invisible to the gateway until somebody noticed the charge.
  `ALTER TABLE pods ADD COLUMN api_key TEXT;`,
  // Who asked for this pod. A person clicking "create pod" is giving an
  // instruction for now; the schedule is for when nobody is watching, and it
  // should not overrule the person who is.
  `ALTER TABLE pods ADD COLUMN started_by TEXT NOT NULL DEFAULT 'user';`,
]

export function openDatabase(path: string): Db {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version]
    if (!sql) continue
    db.transaction(() => {
      db.exec(sql)
      db.pragma(`user_version = ${version + 1}`)
    })()
  }
}
