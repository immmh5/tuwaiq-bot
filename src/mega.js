// src/mega.js — MEGA backup destination for the bot's own account
//
// The bot owns its MEGA account outright. Credentials come from the
// environment (MEGA_EMAIL / MEGA_PASSWORD / MEGA_RECOVERY_KEY), so nothing
// is stored in the database and no per-user binding is needed.
//
// Uploads go to a dedicated dated folder, so the account stays organised
// and nothing else in it is touched.

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

// Try to log in and touch the account. This is the only reliable proof the
// credentials work — anything less and a backup fails at the worst moment.
export async function probeMega(cfg = getMegaConfig()) {
  if (!cfg?.email || !cfg?.password) return { ok: false, error: "MEGA غير مُعد في متغيرات البيئة" };
  try {
    const storage = openStorage(cfg);
    await ready(storage);
    await storage.loadAttributes();
    const root = storage.root;
    if (!root) return { ok: false, error: "ما قدرت أوصل لجذور الحساب" };
    storage.close();
    return { ok: true, email: cfg.email };
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
export async function uploadSnapshot({ cfg = getMegaConfig(), dateLabel, scopeIndex, scopeName, payload }) {
  if (!cfg) throw new Error("MEGA غير مُعد");
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
export async function uploadIndex({ cfg = getMegaConfig(), dateLabel, entries }) {
  if (!cfg) throw new Error("MEGA غير مُعد");
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
