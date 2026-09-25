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

-- Every Telegram user the bot has met. One row per person, so settings,
-- phone number and role are theirs alone and no account is shared by
-- accident. This is the project-wide user store.
CREATE TABLE IF NOT EXISTS users (
  telegram_id text PRIMARY KEY,
  phone text,
  role text NOT NULL DEFAULT 'guest',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS seen_items_kind_idx ON seen_items(kind);
CREATE INDEX IF NOT EXISTS users_phone_idx ON users(phone);
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
// The Tuwaiq account lives in the environment as TUWAIQ_USERNAME /
// TUWAIQ_PASSWORD — the bot owns the account outright, so there is no
// per-user binding and no credentials in the database to leak. Anything
// previously stored is migrated to the same shape on read.

// Fallback for accounts linked before the move to environment credentials.
export async function saveCredentials(username, password) {
  await setKv("credentials", { username, password });
}

export async function getCredentials() {
  if (process.env.TUWAIQ_USERNAME && process.env.TUWAIQ_PASSWORD) {
    return {
      username: process.env.TUWAIQ_USERNAME,
      password: process.env.TUWAIQ_PASSWORD,
      source: "env",
    };
  }
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

// --- users --------------------------------------------------------------------
// One record per Telegram user. The platform account stays owned by whoever
// set it up; these rows carry a person's own phone number, role, and any
// per-user state that should never leak between accounts.

export async function upsertUser(telegramId, patch = {}) {
  const pool = getPool();
  const cols = Object.keys(patch).filter((k) => ["phone", "role"].includes(k));
  if (!cols.length) {
    await pool.query(
      "INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [String(telegramId)]
    );
  } else {
    const vals = [String(telegramId), ...cols.map((c) => patch[c])];
    const setClause = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
    const valClause = cols.map((c, i) => `$${i + 2}`).join(", ");
    await pool.query(
      `INSERT INTO users (telegram_id, ${cols.join(", ")})
       VALUES (${valClause ? "$1, " + valClause : "$1"})
       ON CONFLICT (telegram_id) DO UPDATE SET ${setClause}, updated_at = now()`,
      vals
    );
  }
  return getUser(telegramId);
}

export async function getUser(telegramId) {
  const r = await getPool().query("SELECT * FROM users WHERE telegram_id = $1", [
    String(telegramId),
  ]);
  return r.rowCount ? r.rows[0] : null;
}

// The owner is recognised by either signal: the configured chat id, or the
// phone number the person shared with the bot. The phone is the primary
// check — it comes from Telegram itself, not from a chat id pasted out of a
// dashboard.
export function isOwner(telegramId) {
  const owner = process.env.OWNER_TELEGRAM_ID;
  return !!owner && String(telegramId) === String(owner);
}

export function isOwnerPhone(phone) {
  const owner = process.env.OWNER_PHONE;
  if (!owner) return false;
  const a = String(phone || "").replace(/[^\d]/g, "");
  const b = String(owner).replace(/[^\d]/g, "");
  if (!a || !b) return false;
  // Compare the trailing digits: a shared contact arrives with the country
  // code (966…) while the config may or may not carry it, and either form
  // should match.
  const tail = (s, n) => s.slice(-n);
  return a === b || tail(a, 9) === tail(b, 9) || tail(a, 10) === tail(b, 10);
}

// The async owner check used by the command gate: chat id first (cheap),
// then the number this person has on file.
export async function isOwnerOf(chatId) {
  if (isOwner(chatId)) return true;
  const stored = await getPhone(chatId);
  return !!(stored && isOwnerPhone(stored));
}

export async function setPhone(telegramId, phone) {
  return upsertUser(telegramId, { phone: phone || null });
}

export async function getPhone(telegramId) {
  const u = await getUser(telegramId);
  return u?.phone || null;
}

// --- per-user key/value ------------------------------------------------------
// Settings and MEGA links are scoped to the user, not the shared kv table,
// so two people on the bot never see each other's configuration.
export async function setUserKv(telegramId, key, value) {
  return setKv(`user:${telegramId}:${key}`, value);
}

export async function getUserKv(telegramId, key, fallback = null) {
  return getKv(`user:${telegramId}:${key}`, fallback);
}
