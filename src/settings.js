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
  // Text direction of the table.
  //   rtl — right to left (Arabic, the default)
  //   ltr — left to right
  schedule_direction: "rtl",
  // Strip the group suffix the platform appends to subject names
  // ("احياء 2-1" → "احياء").
  schedule_clean_names: true,
  // Show the room under each class in the grid.
  schedule_show_room: true,
  // How the bot greets a fresh item: one message per item, or a single
  // bundled digest.
  notify_digest: false,
  // Deadline reminder lead time, in hours.
  remind_hours: 24,
  // Watcher cadence, in minutes.
  check_interval: 10,
  // Whether the AI answers free text.
  ai_enabled: true,
};

// Human-readable labels per value, shown on the buttons themselves.
// Telegram clips long button labels, so these stay short; the panel body
// carries the fuller wording.
export const LABELS = {
  schedule_orientation: { days_top: "أيام أفقيًا", days_left: "أيام رأسيًا" },
  schedule_direction: { rtl: "يمين ← يسار", ltr: "يسار ← يمين" },
  schedule_clean_names: { true: "تنظيف: نعم", false: "تنظيف: لا" },
  schedule_show_room: { true: "القاعة: ظاهرة", false: "القاعة: مخفية" },
  notify_digest: { true: "مجمّعة", false: "فردية" },
  remind_hours: { 24: "٢٤ ساعة", 12: "١٢ ساعة", 48: "٤٨ ساعة", 6: "٦ ساعات" },
  check_interval: { 10: "١٠ دقائق", 5: "٥ دقائق", 30: "٣٠ دقيقة", 60: "ساعة" },
  ai_enabled: { true: "مفعّل", false: "متوقف" },
};

// The panel body names each setting, so the short button labels stay
// understandable in context.
export const SETTING_HINTS = {
  schedule_orientation: "الاتجاه",
  schedule_direction: "الكتابة",
  schedule_clean_names: "تنظيف الأسماء",
  schedule_show_room: "القاعة",
  notify_digest: "التنبيهات",
  remind_hours: "التذكير قبل",
  check_interval: "فحص كل",
  ai_enabled: "الذكاء",
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
// Numbers come back as numbers so remind_hours stays usable downstream.
export async function cycleSetting(chatId, name) {
  const all = await getSettings(chatId);
  const allowed = Object.keys(LABELS[name] || {});
  if (!allowed.length) return all;
  const cur = String(all[name]);
  const idx = allowed.indexOf(cur);
  const next = allowed[(idx + 1) % allowed.length];
  const numeric = Number(next);
  return setSetting(chatId, name, Number.isFinite(numeric) && next !== "" ? numeric : next);
}

export const SETTING_NAMES = Object.keys(DEFAULTS);

// Panel sections: each groups related settings so the buttons read as one
// subject per block rather than a flat list.
export const PANEL = [
  {
    title: "🗓 الجدول",
    items: ["schedule_orientation", "schedule_direction", "schedule_clean_names", "schedule_show_room"],
  },
  {
    title: "🔔 التنبيهات",
    items: ["notify_digest", "remind_hours"],
  },
  {
    title: "🔄 المراقبة",
    items: ["check_interval"],
  },
  {
    title: "🤖 الذكاء",
    items: ["ai_enabled"],
  },
];
