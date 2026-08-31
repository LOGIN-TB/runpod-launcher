import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = Database.Database

/**
 * The initial schema, applied once on a database that does not exist yet.
 *
 * Everything added after it lives in `COLUMNS` below, which is checked against
 * the real schema on every start rather than counted.
 */
const SCHEMA = `
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
`

/**
 * Columns added after the initial schema.
 *
 * Ensured by looking at the table rather than by counting applied migrations.
 * The counter was not safe: it records how many steps ran, so removing or
 * reordering a step silently skips one for everybody whose database already
 * counted past it. That happened here — a backfill was written, run on a live
 * database, then withdrawn as wrong, and the next column added after it was
 * never created on that machine. Reading the actual schema cannot drift, and
 * it repairs the installations that already drifted.
 */
const COLUMNS: ReadonlyArray<{
  table: string
  column: string
  definition: string
  /** Run once, immediately after this column is created. */
  backfill?: string
}> = [
  // Why a pod was stopped. Needed so an idle shutdown is not immediately undone
  // by the schedule seeing an open window and starting the pod again.
  { table: 'pods', column: 'stop_reason', definition: 'TEXT' },
  // The pod's own bearer token. Held only in memory before, so a service
  // restart left the launcher unable to reach a pod it was still paying for.
  { table: 'pods', column: 'api_key', definition: 'TEXT' },
  // Who started it. A pod somebody started by hand must not be taken away by
  // the schedule before they have had a chance to use it.
  { table: 'pods', column: 'started_by', definition: "TEXT NOT NULL DEFAULT 'user'" },
  // Paused and gone are different states, and only one of them can be resumed.
  // Without the distinction the launcher could not find the pod it was meant to
  // wake, so it built a new one every time and left the old behind.
  { table: 'pods', column: 'terminated_at', definition: 'TEXT' },
  // Which template a client token may reach.
  //
  // Every token used to reach whichever pod happened to be running, which is
  // fine with one pod and wrong with several: n8n and a local agent each need
  // to land on their own. The token is the routing key because the client
  // already sends it — nothing changes on their side to be pointed elsewhere.
  {
    table: 'client_tokens',
    column: 'template_id',
    definition: 'TEXT REFERENCES templates(id)',
    // An existing installation keeps working: with exactly one template, being
    // bound to it is exactly what its tokens already did. With several, the
    // target stays unset and the gateway asks for an assignment rather than
    // guessing — a guess would start hardware nobody chose.
    //
    // Tied to the column's creation rather than run on every start, so that
    // later deliberately clearing a target is not undone by a restart.
    backfill: `UPDATE client_tokens
                  SET template_id = (SELECT id FROM templates)
                WHERE (SELECT COUNT(*) FROM templates) = 1`,
  },
  {
    // What the pod was actually started with.
    //
    // A resume brings the container back exactly as it was, arguments included,
    // so a corrected template silently does not reach it. Seen live: a vLLM pod
    // was missing its tool-call parser, the template was fixed, and pausing and
    // starting again resumed the same broken container — the obvious repair
    // gesture doing nothing at all. Comparing this against what the template
    // would render now is what turns that into a rebuild.
    table: 'pods',
    column: 'args_fingerprint',
    definition: 'TEXT',
  },
  {
    // Which template served a request. The idle rule reads the newest request
    // to decide whether a pod is still in use; read across all pods, traffic on
    // one would keep every other pod awake.
    table: 'usage',
    column: 'template_id',
    definition: 'TEXT',
    // Past traffic is attributed through the token that made it, which now
    // carries a target. Without this the history reads as no traffic at all,
    // and the idle rule stops a busy pod on the first tick after the upgrade —
    // seen live: a pod with a sixty-minute idle limit and a request thirteen
    // minutes old was stopped immediately.
    backfill: `UPDATE usage
                  SET template_id = (
                    SELECT template_id FROM client_tokens WHERE client_tokens.id = usage.token_id
                  )`,
  },
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
  db.transaction(() => {
    // A brand-new database, and nothing else. An existing one counted past this
    // point long ago and keeps whatever number it has.
    if ((db.pragma('user_version', { simple: true }) as number) === 0) {
      db.exec(SCHEMA)
      db.pragma('user_version = 1')
    }

    for (const { table, column, definition, backfill } of COLUMNS) {
      if (hasColumn(db, table, column)) continue
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`)
      if (backfill) db.exec(backfill)
    }
  })()
}

/** Does this table already have that column? */
function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return columns.some((row) => row.name === column)
}
