// Per-chat settings the student controls from the settings panel.
//
// Every value has a default here and an override in the KV store keyed by
// chat, so a setting survives restarts and the panel always reads back what
// was chosen. Adding a new setting means adding a key to DEFAULTS and a
// label to LABELS — the panel and the renderers pick it up automatically.

import { getKv, setKv } from "./store.js";

const DEFAULTS = {
  // Schedule table orientation.
  //   days_top    — days across the top, times down the left (the site's own
  //                 layout, and the default)
  //   days_left   — days down the left side, times across the top
  schedule_orientation: "days_top",
  // Show the room under each class in the grid.
  schedule_show_room: true,
  // How the bot greets a fresh item: one message per item, or a single
  // bundled digest.
  notify_digest: false,
  // Deadline reminder lead time, in hours.
  remind_hours: 24,
};

// Human-readable labels per value, shown on the buttons themselves.
export const LABELS = {
  schedule_orientation: {
    days_top: "أيام أفقيًا (مثل المنصة)",
    days_left: "أيام رأسيًا",
  },
  schedule_show_room: { true: "القاعة: ظاهرة", false: "القاعة: مخفية" },
  notify_digest: { true: "تنبيهات: مجمّعة", false: "تنبيهات: فردية" },
};

const KEY = (chatId) => `settings:${chatId}`;

// Read one setting, falling back to its default.
export async function getSetting(chatId, name) {
  const all = await getKv(KEY(chatId), {});
  const v = all[name];
  if (v === undefined || v === null) return DEFAULTS[name];
  return v;
}

// Read every setting at once.
export async function getSettings(chatId) {
  const stored = await getKv(KEY(chatId), {});
  return { ...DEFAULTS, ...stored };
}

// Write one setting and return the full set, so the panel can re-render
// itself in one round trip.
export async function setSetting(chatId, name, value) {
  const all = await getSettings(chatId);
  all[name] = value;
  await setKv(KEY(chatId), all);
  return all;
}

// Cycle a setting through its allowed values — used by toggle buttons.
export async function cycleSetting(chatId, name) {
  const all = await getSettings(chatId);
  const allowed = Object.keys(LABELS[name] || {});
  if (!allowed.length) return all;
  const idx = allowed.indexOf(String(all[name]));
  const next = allowed[(idx + 1) % allowed.length];
  return setSetting(chatId, name, next === "true" ? true : next === "false" ? false : next);
}

export const SETTING_NAMES = Object.keys(DEFAULTS);
