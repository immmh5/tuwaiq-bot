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
  // --- Backup ---------------------------------------------------------------
  // Per-scope download control for /backup. Each is on by default; turning
  // a scope off skips it entirely (no text, no image).
  backup_schedule: true,
  backup_assignments: true,
  backup_courses: true,
  backup_grades: true,
  backup_materials: true,
  // --- Format ---------------------------------------------------------------
  // Which representation /backup sends per scope. "image" renders the nice
  // card, "text" sends a plain list, "both" sends the image then the list.
  backup_format: "both",
  // --- Automation -----------------------------------------------------------
  // When true the scheduled check also refreshes the backup snapshot, so a
  // copy of the platform is always waiting without asking for it.
  backup_auto: true,
  // --- MEGA -----------------------------------------------------------------
  // The folder link the bot posts after each backup. Defaults to the shared
  // archive folder; the student can point it at any folder they can open.
  mega_folder_link: "https://mega.nz/folder/itwAWC7T#QhhnE5EiLy8qEHaYrLQoZQ",
  // Send the backup snapshot to MEGA on every run. Turning it off keeps the
  // backup Telegram-only while the account details are being sorted out.
  mega_enabled: true,
  // --- Display --------------------------------------------------------------
  // 24-hour clock everywhere, since the platform is Arabic-locale.
  time_format: "24h",
  // --- Proactive notifications ---------------------------------------------
  // These are the clock-driven messages: the morning briefing, the exam
  // countdown, and the grade-change report. All default on and all flip off
  // independently from the panel.
  morning_briefing: true,
  exam_countdown: true,
  grade_alerts: true,
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
  morning_briefing: { true: "الصباحية: شغّالة", false: "الصباحية: مطفية" },
  exam_countdown: { true: "الاختبارات: شغّال", false: "الاختبارات: مطفية" },
  grade_alerts: { true: "الدرجات: شغّال", false: "الدرجات: مطفية" },
  check_interval: { 10: "١٠ دقائق", 5: "٥ دقائق", 30: "٣٠ دقيقة", 60: "ساعة" },
  ai_enabled: { true: "مفعّل", false: "متوقف" },
  // Scope toggles for the backup. The label carries the scope name so the
  // row reads naturally under its section heading.
  backup_schedule: { true: "الجدول: نعم", false: "الجدول: لا" },
  backup_assignments: { true: "الواجبات: نعم", false: "الواجبات: لا" },
  backup_courses: { true: "المقررات: نعم", false: "المقررات: لا" },
  backup_grades: { true: "الدرجات: نعم", false: "الدرجات: لا" },
  backup_materials: { true: "المواد: نعم", false: "المواد: لا" },
  backup_format: { image: "صورة بس", text: "نص بس", both: "صورة + نص" },
  backup_auto: { true: "تلقائي: شغال", false: "تلقائي: متوقف" },
  // MEGA section. The link toggle is a pair of well-known values rather than
  // free text — a button cannot hold a URL the student would type.
  mega_enabled: { true: "MEGA: شغال", false: "MEGA: متوقف" },
  // Clock format, shown in captions and reminders.
  time_format: { "24h": "٢٤ ساعة", "12h": "١٢ ساعة" },
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
  backup_format: "شكل النسخة",
  backup_auto: "التلقائي",
  mega_enabled: "النسخ السحابي",
  time_format: "الساعة",
  morning_briefing: "صباحية يومية",
  exam_countdown: "عدّاد الاختبارات",
  grade_alerts: "تنبيه تغيّر الدرجات",
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
  // "true"/"false" must land as real booleans — the renderers compare with
  // !== false, and a string "false" is not false, which silently kept every
  // boolean toggle stuck on its default.
  const asBool = next === "true" ? true : next === "false" ? false : null;
  if (asBool !== null) return setSetting(chatId, name, asBool);
  const numeric = Number(next);
  return setSetting(chatId, name, Number.isFinite(numeric) && next !== "" ? numeric : next);
}

export const SETTING_NAMES = Object.keys(DEFAULTS);

// Panel sections: each groups related settings so the buttons read as one
// subject per block rather than a flat list. The key is what the category
// button carries, so the main page can open a sub-page for one section.
export const PANEL = [
  {
    title: "🗓 الجدول",
    key: "schedule",
    items: ["schedule_orientation", "schedule_direction", "schedule_clean_names", "schedule_show_room"],
  },
  {
    title: "🔔 التنبيهات",
    key: "alerts",
    items: ["notify_digest", "remind_hours", "time_format"],
  },
  {
    // The clock-driven messages: what the bot says unprompted, and when.
    title: "📣 التنبيهات الذكية",
    key: "smart",
    items: ["morning_briefing", "exam_countdown", "grade_alerts"],
  },
  {
    title: "🔄 المراقبة",
    key: "watch",
    items: ["check_interval"],
  },
  {
    title: "🤖 الذكاء",
    key: "ai",
    items: ["ai_enabled"],
  },
  {
    // Backup and MEGA are one concern: MEGA is where the backup lands, so
    // its switch belongs with the scopes and the format rather than in a
    // section of its own.
    title: "💾 النسخة الاحتياطية",
    key: "backup",
    items: ["backup_auto", "backup_format", "mega_enabled"],
  },
  {
    title: "💾 النطاقات",
    key: "scopes",
    items: ["backup_schedule", "backup_assignments", "backup_courses", "backup_grades", "backup_materials"],
  },
];
