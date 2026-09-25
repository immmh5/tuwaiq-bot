// src/mega.js — optional personal backup destination (MEGA)
//
// The bot uploads into the student's own MEGA account by logging in with
// their email and password. Folder links cannot work for this: a shared
// link grants read-only access, so the bot would be unable to write.
//
// Credentials are stored per user and never printed back. The upload itself
// goes to a dedicated dated folder so it never touches the rest of the
// account's tree.

import { Storage } from "megajs";

// Credentials are kept per user. They are the student's own MEGA login —
// the bot needs them to write into the account, and they are never echoed
// back through any command.
export async function setMegaCreds(telegramId, email, password, { setUserKv }) {
  await setUserKv(telegramId, "mega", {
    mode: "credentials",
    email,
    password,
    addedAt: Date.now(),
  });
  return { ok: true };
}

export async function getMegaConfig(telegramId, { getUserKv }) {
  const cfg = await getUserKv(telegramId, "mega", null);
  if (!cfg || cfg.mode !== "credentials") return null;
  return cfg;
}

export async function clearMegaLink(telegramId, { setUserKv }) {
  await setUserKv(telegramId, "mega", null);
}

// Try to log in and touch the account. This is the only reliable proof the
// credentials work — anything less and a backup fails at the worst moment.
export async function probeMega(cfg) {
  if (!cfg?.email || !cfg?.password) return { ok: false, error: "بيانات ناقصة" };
  try {
    const storage = Storage({
      email: cfg.email,
      password: cfg.password,
      autoload: false,
    });
    await ready(storage);
    await storage.loadAttributes();
    const root = storage.root;
    if (!root) return { ok: false, error: "ما قدرت أوصل لجذور الحساب" };
    storage.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || "فشل الدخول" };
  }
}

function openStorage(cfg) {
  return Storage({
    email: cfg.email,
    password: cfg.password,
    autoload: false,
  });
}

// megajs emits `ready` after login; wait for it so an upload never starts
// against a half-opened session.
function ready(storage) {
  return new Promise((resolve, reject) => {
    storage.once("ready", resolve);
    storage.once("error", reject);
    storage.login();
  });
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
export async function uploadSnapshot({ cfg, dateLabel, scopeIndex, scopeName, payload }) {
  const storage = openStorage(cfg);
  await ready(storage);
  await storage.loadAttributes();
  const root = await ensureFolder(storage.root, ROOT_FOLDER);
  const dayFolder = await ensureFolder(root, dateLabel);
  const name = `${String(scopeIndex).padStart(2, "0")}-${scopeName}.json`;
  const data = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  await dayFolder.upload({ name }, data);
  storage.close();
  return name;
}

// The index file lists every scope in the snapshot with its fetch time, so
// the folder is self-describing rather than a pile of opaque JSON.
export async function uploadIndex({ cfg, dateLabel, entries }) {
  const storage = openStorage(cfg);
  await ready(storage);
  await storage.loadAttributes();
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
  storage.close();
}

// Find or create a child folder, so re-running a backup on the same day
// reuses one dated folder instead of producing a pile of them.
async function ensureFolder(parent, name) {
  await parent.loadAttributes();
  const existing = (parent.children || []).find((c) => c.name === name && c.directory);
  if (existing) return existing;
  return parent.mkdir(name);
}
