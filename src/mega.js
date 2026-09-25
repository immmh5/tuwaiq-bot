// src/mega.js — MEGA backup destination for the bot's own account
//
// The bot owns its MEGA account outright. Credentials come from the
// environment (MEGA_EMAIL / MEGA_PASSWORD / MEGA_RECOVERY_KEY), so nothing
// is stored in the database and no per-user binding is needed.
//
// Uploads go to a dedicated dated folder. After the backup the bot publishes
// a link to that folder, so the student opens it directly in MEGA rather
// than hunting for it.
//
// One session is held for the process lifetime. MEGA locks an account that
// logs in repeatedly from a datacentre IP — a backup touching five scopes
// used to log in six times in a row, and that was what tripped the account's
// abuse detection. Reusing a single session keeps the whole run to one login.

import { Storage } from "megajs";

let session = null;

// A failed login is remembered for a while. MEGA locks accounts that
// authenticate repeatedly from a datacentre IP, so hammering it after a
// refusal is the fastest way to get locked out again. During the cool-down
// every operation reports the failure instead of trying.
let lastFailure = null;
const COOLDOWN_MS = 5 * 60 * 1000;

function inCooldown() {
  if (!lastFailure) return false;
  if (Date.now() - lastFailure.at < COOLDOWN_MS) return true;
  lastFailure = null;
  return false;
}

// The bot's MEGA account, read straight from the environment.
export function getMegaConfig() {
  const email = process.env.MEGA_EMAIL;
  const password = process.env.MEGA_PASSWORD;
  if (!email || !password) return null;
  return {
    email,
    password,
    recoveryKey: process.env.MEGA_RECOVERY_KEY || null,
    source: "env",
  };
}

// True when MEGA is configured at all, used to decide whether the backup
// should attempt the cloud leg.
export function isMegaConfigured() {
  return !!getMegaConfig();
}

// Forget the cached session. Called when a login fails so the next attempt
// starts clean instead of reusing a half-dead one, and records why.
function dropSession(reason) {
  session = null;
  lastFailure = { at: Date.now(), reason: String(reason || "فشل الدخول") };
}

// One login, reused by every operation afterwards. The promise is cached too,
// so concurrent calls share the same attempt rather than starting a second.
export async function getSession(cfg = getMegaConfig()) {
  if (session) return session;
  if (inCooldown()) {
    throw new Error(`${lastFailure.reason} — أنتظر ٥ دقايق قبل المحاولة`);
  }
  if (!cfg?.email || !cfg?.password) throw new Error("MEGA غير مُعد");
  const storage = new Storage({
    email: cfg.email,
    password: cfg.password,
    // autoload fetches the account tree during login, which is exactly what
    // the bot needs before it can walk or create folders.
    autoload: true,
  });
  // megajs raises login failures as stray rejections from its own internals
  // instead of an error event a caller can await, so keep the promise and let
  // the caller's race bound it while a global guard absorbs the stray.
  storage._botPromise = new Promise((resolve, reject) => {
    storage.once("ready", resolve);
    storage.once("error", reject);
  });
  session = storage;
  return storage;
}

// megajs emits `ready` once the session and the account tree are in place.
function ready(storage) {
  return storage._botPromise;
}

// Try to log in and touch the account. This is the only reliable proof the
// credentials work — anything less and a backup fails at the worst moment.
//
// The promise races a timeout: on a wrong password megajs builds an error
// internally but never hands it to the callback, so ready() would hang
// forever and the command would never answer.
export async function probeMega(cfg = getMegaConfig()) {
  if (!cfg?.email || !cfg?.password) return { ok: false, error: "MEGA غير مُعد في متغيرات البيئة" };
  try {
    const storage = await getSession(cfg);
    const outcome = await Promise.race([
      ready(storage).then(() => "ok"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 20000)),
    ]);
    if (outcome !== "ok") {
      dropSession("MEGA ما رد — تأكد من الإيميل وكلمة السر");
      return { ok: false, error: "MEGA ما رد — تأكد من الإيميل وكلمة السر" };
    }
    if (!storage.root) {
      dropSession("ما قدرت أوصل لجذور الحساب");
      return { ok: false, error: "ما قدرت أوصل لجذور الحساب" };
    }
    // A working login clears the cool-down so a later failure can be retried.
    lastFailure = null;
    return { ok: true, email: cfg.email };
  } catch (err) {
    dropSession(err.message);
    return { ok: false, error: err.message || "فشل الدخول" };
  }
}

// Force a fresh login next time. Used when the credentials have changed and a
// cached session from the old ones would keep failing.
export function resetMegaSession() {
  session = null;
  lastFailure = null;
}

// Everything lives under one dedicated folder so the rest of the account is
// left untouched.
const ROOT_FOLDER = "طويق-نسخ-احتياطي";

// Upload one JSON file into the snapshot folder for a date. The layout is:
//
//   طويق-نسخ-احتياطي/
//     2026-09-25/
//       00-schedule.json
//       01-assignments.json
//       ...
//       فهرس.json
//
// Numbers keep the scopes in a stable order regardless of the viewer's sort.
// Every MEGA call waits with a deadline. megajs never hands a login failure
// to the caller — it builds the error internally and drops it, so without a
// bound an operation would hang forever and the command would never answer.
const MEGA_TIMEOUT = 30000;

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} — MEGA ما رد خلال ${MEGA_TIMEOUT / 1000}ث`)), MEGA_TIMEOUT)
    ),
  ]);
}

export async function uploadSnapshot({ cfg = getMegaConfig(), dateLabel, scopeIndex, scopeName, payload }) {
  if (!cfg) throw new Error("MEGA غير مُعد");
  // Reuses the one session rather than logging in per file — MEGA locks an
  // account that authenticates repeatedly, so a five-scope backup must not
  // become five logins.
  const storage = await getSession(cfg);
  const root = await ensureFolder(storage.root, ROOT_FOLDER);
  const dayFolder = await ensureFolder(root, dateLabel);
  const name = `${String(scopeIndex).padStart(2, "0")}-${scopeName}.json`;
  const data = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  await withTimeout(dayFolder.upload({ name }, data), `رفع ${name}`);
  return name;
}

// The index file lists every scope in the snapshot with its fetch time, so
// the folder is self-describing rather than a pile of opaque JSON. It also
// returns a link to the dated folder so the student can open it without
// browsing the account.
export async function uploadIndex({ cfg = getMegaConfig(), dateLabel, entries }) {
  if (!cfg) throw new Error("MEGA غير مُعد");
  const storage = await getSession(cfg);
  const root = await ensureFolder(storage.root, ROOT_FOLDER);
  const dayFolder = await ensureFolder(root, dateLabel);
  const data = Buffer.from(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: "sc.tuwaiq.edu.sa",
        scopes: entries,
      },
      null,
      2
    ),
    "utf8"
  );
  await withTimeout(dayFolder.upload({ name: "فهرس.json" }, data), "رفع الفهرس");
  const link = await folderLink(dayFolder);
  return { link };
}

// Turn the dated folder into a URL the student can open. MEGA needs a key to
// share an encrypted folder; link() handles generating and embedding it.
async function folderLink(folder) {
  try {
    const url = await folder.link({ key: true });
    return typeof url === "string" ? url : String(url);
  } catch {
    // Sharing is a convenience, not a requirement — a failed link must not
    // undo a backup that already succeeded.
    return null;
  }
}

// Find or create a child folder, so re-running a backup on the same day
// reuses one dated folder instead of producing a pile of them.
async function ensureFolder(parent, name) {
  const existing = (parent.children || []).find((c) => c.name === name && c.directory);
  if (existing) return existing;
  return parent.mkdir(name);
}
