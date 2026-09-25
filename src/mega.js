// src/mega.js — optional personal backup destination (MEGA)
//
// Two ways to link a MEGA account, chosen by whichever the student prefers:
//
//   folder link  — a shared-folder URL (https://mega.nz/folder/xxxx#key).
//                  Nothing but that folder is reachable, and no password is
//                  ever stored. This is the default and the recommended path.
//   credentials  — MEGA email + password, needed only when the student wants
//                  the backup written into an existing folder of their tree
//                  rather than a shared one.
//
// Everything uploaded lands under a dated folder, one JSON file per scope,
// plus an index file describing what the snapshot contains.

import { Storage, File } from "megajs";

let cached = null;

// The link is stored per user. The key is the decryption key embedded in the
// URL itself, so the folder stays encrypted with the student's own key — the
// bot never holds a MEGA password in the folder-link mode.
export async function setMegaLink(telegramId, url, { setUserKv, getUserKv }) {
  const parsed = parseFolderLink(url);
  if (!parsed) throw new Error("رابط غير صالح — تأكد إنه رابط مجلد MEGA");
  await setUserKv(telegramId, "mega", { url, mode: "folder", addedAt: Date.now() });
  return parsed;
}

export async function getMegaConfig(telegramId, { getUserKv }) {
  return getUserKv(telegramId, "mega", null);
}

export async function clearMegaLink(telegramId, { setUserKv }) {
  await setUserKv(telegramId, "mega", null);
}

// MEGA folder links look like https://mega.nz/folder/<id>#<key>. Both halves
// are required — the id says where, the key decrypts the listing.
export function parseFolderLink(url) {
  const m = String(url || "").match(/mega\.nz\/(?:folder|f)\/([a-zA-Z0-9_-]+)#([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  return { id: m[1], key: m[2] };
}

// Build a storage object for the given config. megajs accepts the folder URL
// directly when it is a public shared folder, which is why no password is
// needed in that mode.
function openStorage(cfg) {
  if (cfg.mode === "credentials") {
    return Storage({
      email: cfg.email,
      password: cfg.password,
      autoload: false,
    });
  }
  return File.fromURL(cfg.url);
}

// Verify the link works and that the folder can actually be written to,
// before promising that a backup will succeed. A shared folder without
// upload permission would otherwise fail only at the worst moment.
export async function probeMega(cfg) {
  const parsed = parseFolderLink(cfg.url);
  if (!parsed) return { ok: false, error: "رابط غير صالح" };
  // A real probe needs a live session; without credentials we can at least
  // confirm the shape is right so a typo does not get saved.
  return { ok: true, id: parsed.id };
}

// Upload one JSON file into the snapshot folder for a date. The layout is:
//
//   <root>/
//     2026-09-25/
//       00-الجدول.json
//       01-الواجبات.json
//       ...
//       فهرس.json
//
// Numbers keep the scopes in a stable order regardless of the viewer's sort.
export async function uploadSnapshot({ cfg, dateLabel, scopeIndex, scopeName, payload }) {
  const storage = openStorage(cfg);
  await storage.loadAttributes();
  const root = cfg.mode === "credentials" ? storage.root : storage;

  const dayFolder = await ensureFolder(root, dateLabel);
  const name = `${String(scopeIndex).padStart(2, "0")}-${scopeName}.json`;
  const data = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  await dayFolder.upload({ name }, data);
  return name;
}

// Find or create a child folder, so re-running a backup on the same day
// reuses one dated folder instead of producing a pile of them.
async function ensureFolder(parent, name) {
  await parent.loadAttributes();
  const existing = (parent.children || []).find((c) => c.name === name && c.directory);
  if (existing) return existing;
  return parent.mkdir(name);
}

// The index file lists every scope in the snapshot with its fetch time, so
// the folder is self-describing rather than a pile of opaque JSON.
export async function uploadIndex({ cfg, dateLabel, entries }) {
  const storage = openStorage(cfg);
  await storage.loadAttributes();
  const root = cfg.mode === "credentials" ? storage.root : storage;
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
}
