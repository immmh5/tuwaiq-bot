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

// Supabase's *direct* host (db.<ref>.supabase.co) publishes an IPv6-only DNS
// record, and Render's free instances have no IPv6 egress → ENETUNREACH.
// The *pooler* host (aws-0-<region>.pooler.supabase.com) has real IPv4.
// Rewrite the direct host to the pooler automatically so any DATABASE_URL
// variant works. Safe no-op for non-Supabase connections.
function preferIPv4Host(connectionString) {
  try {
    const u = new URL(connectionString);
    const direct = u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
    if (direct) {
      // region is encoded in the pooler CNAME; we try the generic pooler and
      // let DNS resolve it. If the region-specific host is known it is used.
      u.hostname = `aws-0-ap-northeast-2.pooler.supabase.com`;
      u.username = u.username.startsWith("postgres.")
        ? u.username
        : `postgres.${direct[1]}`;
      if (!/:\d+$/.test(u.host) || u.port === "5432") u.port = "6543";
      console.log(`store: rewrote Supabase direct host → pooler (${u.host})`);
      return u.toString();
    }
  } catch {
    /* not a URL-shaped string — leave as-is */
  }
  return connectionString;
}

export async function initStore(connectionString) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required (use Supabase or Neon free Postgres)");
  }

  const finalUrl = preferIPv4Host(connectionString);

  // Managed Postgres (Supabase/Neon/Render) requires SSL; local dev does not
  // support it. Explicit ?sslmode= always wins; otherwise localhost-style hosts
  // are treated as local, everything else as a managed provider.
  const { hostname, searchParams } = new URL(finalUrl);
  const isLocalHost = /^(localhost|127\.0\.0\.1|::1|[^.]+)$/.test(hostname);
  const sslmode = searchParams.get("sslmode");
  const useSsl = sslmode ? sslmode !== "disable" : !isLocalHost;

  pool = new Pool({
    connectionString: finalUrl,
    max: 4,
    idleTimeoutMillis: 30000,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    // Belt and braces: pin lookups to IPv4 even when the pooler isn't used.
    family: 4,
  });

  await initWithRetry(pool);
  return pool;
}

// The schema migration is the first thing that touches the network. Transient
// DNS/routing failures at boot shouldn't kill the process — Render would keep
// flapping the service. Retry a few times before giving up.
async function initWithRetry(pool, attempts = 5) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query(SCHEMA);
      return;
    } catch (err) {
      lastErr = err;
      console.log(`store init attempt ${i}/${attempts} failed: ${err.message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
  throw lastErr;
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
  const t = await getKv("tokens", null);
  if (!t?.accessToken) return t;
  // Access tokens expire. When one does, renew it from the refresh token
  // instead of letting every subsequent call fail with an expired token —
  // that is what silently stopped the watcher.
  const exp = Number(t.accessExpiresAt || 0);
  const now = Date.now() / 1000;
  if (exp > now + 60) return t;
  if (!t.refresh_token) return t;
  try {
    const { refresh } = await import("./auth.js");
    const fresh = await refresh(t.refresh_token);
    if (fresh?.accessToken) {
      await setKv("tokens", { ...t, ...fresh });
      console.log("access token refreshed");
      return { ...t, ...fresh };
    }
  } catch (err) {
    console.error("token refresh failed:", err.message);
  }
  return t;
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
