// src/store.js — Postgres persistence for state, credentials and seen items
import pg from "pg";

const { Pool } = pg;

let pool = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seen_items (
  id text PRIMARY KEY,
  kind text NOT NULL,
  title text,
  subject text,
  payload jsonb NOT NULL,
  notified boolean NOT NULL DEFAULT true,
  seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS seen_items_kind_idx ON seen_items(kind);
`;

export async function initStore(connectionString) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required (use Supabase or Neon free Postgres)");
  }
  // Managed Postgres (Supabase/Neon/Render) requires SSL; local dev does not
  // support it. Explicit ?sslmode= always wins; otherwise localhost-style hosts
  // are treated as local, everything else as a managed provider.
  const { hostname, searchParams } = new URL(connectionString);
  const isLocalHost = /^(localhost|127\.0\.0\.1|::1|[^.]+)$/.test(hostname);
  const sslmode = searchParams.get("sslmode");
  const useSsl = sslmode ? sslmode !== "disable" : !isLocalHost;

  pool = new Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 30000,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  });
  await pool.query(SCHEMA);
  return pool;
}

export function getPool() {
  if (!pool) throw new Error("store not initialised");
  return pool;
}

// --- key/value settings -------------------------------------------------------

export async function setKv(key, value) {
  await getPool().query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

export async function getKv(key, fallback = null) {
  const r = await getPool().query("SELECT value FROM kv WHERE key = $1", [key]);
  return r.rowCount ? r.rows[0].value : fallback;
}

// --- credentials --------------------------------------------------------------

export async function saveCredentials(username, password) {
  await setKv("credentials", { username, password });
}

export async function getCredentials() {
  return getKv("credentials", null);
}

export async function clearCredentials() {
  await getPool().query("DELETE FROM kv WHERE key IN ('credentials','tokens')");
}

// --- tokens -------------------------------------------------------------------

export async function saveTokens(tokens) {
  await setKv("tokens", tokens);
}

export async function getTokens() {
  return getKv("tokens", null);
}

// --- seen items ---------------------------------------------------------------

export async function markSeen(item) {
  await getPool().query(
    `INSERT INTO seen_items (id, kind, title, subject, payload, notified, seen_at)
     VALUES ($1, $2, $3, $4, $5, true, now())
     ON CONFLICT (id) DO NOTHING`,
    [item.id, item.kind, item.title, item.subject, JSON.stringify(item.raw || item)]
  );
}

export async function isSeen(id) {
  const r = await getPool().query("SELECT 1 FROM seen_items WHERE id = $1", [id]);
  return r.rowCount > 0;
}

export async function getSeenIds(ids) {
  if (!ids.length) return new Set();
  const r = await getPool().query(
    `SELECT id FROM seen_items WHERE id = ANY($1::text[])`,
    [ids]
  );
  return new Set(r.rows.map((row) => row.id));
}

export async function listSeen(limit = 50, kind = null) {
  const q = kind
    ? "SELECT * FROM seen_items WHERE kind=$1 ORDER BY seen_at DESC LIMIT $2"
    : "SELECT * FROM seen_items ORDER BY seen_at DESC LIMIT $1";
  const r = await getPool().query(q, kind ? [kind, limit] : [limit]);
  return r.rows;
}

export async function resetSeen() {
  await getPool().query("TRUNCATE seen_items");
}

export async function pruneSeen(keepDays = 180) {
  await getPool().query(
    "DELETE FROM seen_items WHERE seen_at < now() - ($1::int) * interval '1 day'",
    [keepDays]
  );
}
