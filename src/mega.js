// src/mega.js — MEGA backup destination for the bot's own account
//
// The bot owns its MEGA account outright. Credentials come from the
// environment (MEGA_EMAIL / MEGA_PASSWORD / MEGA_RECOVERY_KEY), so nothing
// is stored in the database and no per-user binding is needed.
//
// Uploads go to a dedicated dated folder. After the backup the bot publishes
// a link to that folder, so the student opens it directly in MEGA rather
// than hunting for it.

import { Storage } from "megajs";

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

function openStorage(cfg) {
  // megajs turns a failed login into an unhandled rejection from its own
  // internals rather than an `error` event, so a bad password would crash
  // the process. Keep a handle on the storage to close it, and let the
  // caller's try/catch catch what it can while a global guard turns the
  // stray rejection into a normal failure.
  const storage = new Storage({
    email: cfg.email,
    password: cfg.password,
    // autoload fetches the account tree during login, which is exactly what
    // the bot needs before it can walk or create folders.
    autoload: true,
  });
  // Capture rejections megajs raises outside the ready/error event pair.
  storage._botPromise = new Promise((resolve, reject) => {
    storage.once("ready", resolve);
    storage.once("error", reject);
  });
  return storage;
}

// megajs emits `ready` once the session and the account tree are in place.
// Waiting for it means an upload never starts against a half-opened session.
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
  const storage = openStorage(cfg);
  try {
    const outcome = await Promise.race([
      ready(storage).then(() => "ok"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 20000)),
    ]);
    if (outcome !== "ok") return { ok: false, error: "MEGA ما رد — تأكد من الإيميل وكلمة السر" };
    if (!storage.root) return { ok: false, error: "ما قدرت أوصل لجذور الحساب" };
    storage.close();
    return { ok: true, email: cfg.email };
  } catch (err) {
    storage.close();
    return { ok: false, error: err.message || "فشل الدخول" };
  }
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
export async function uploadSnapshot({ cfg = getMegaConfig(), dateLabel, scopeIndex, scopeName, payload }) {
  if (!cfg) throw new Error("MEGA غير مُعد");
  const storage = openStorage(cfg);
  try {
    await ready(storage);
    const root = await ensureFolder(storage.root, ROOT_FOLDER);
    const dayFolder = await ensureFolder(root, dateLabel);
    const name = `${String(scopeIndex).padStart(2, "0")}-${scopeName}.json`;
    const data = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
    await dayFolder.upload({ name }, data);
    storage.close();
    return name;
  } catch (err) {
    storage.close();
    throw err;
  }
}

// The index file lists every scope in the snapshot with its fetch time, so
// the folder is self-describing rather than a pile of opaque JSON. It also
// returns a link to the dated folder so the student can open it without
// browsing the account.
export async function uploadIndex({ cfg = getMegaConfig(), dateLabel, entries }) {
  if (!cfg) throw new Error("MEGA غير مُعد");
  const storage = openStorage(cfg);
  try {
    await ready(storage);
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
    await dayFolder.upload({ name: "فهرس.json" }, data);
    const link = await folderLink(dayFolder);
    storage.close();
    return { link };
  } catch (err) {
    storage.close();
    throw err;
  }
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
