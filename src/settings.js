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
  // Exams and notifications are watched and shown in /all; the backup covers
  // every watched scope so the archive never silently misses a kind of data.
  backup_exams: true,
  backup_notifications: true,
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
  // --- Hidden classes -------------------------------------------------------
  // Session keys the student asked the bot to drop from the schedule. The
  // platform occasionally books two classes into the same slot — its own
  // grid draws both stacked at the same offset — and only the student knows
  // which one is real. Each key is "date|startTime" so hiding survives the
  // platform renumbering its session ids. Every schedule view filters these.
  schedule_hidden: [],
  // --- Original files -------------------------------------------------------
  // Whether /backup also downloads the platform's documents and slides and
  // archives them, not just the JSON describing them. The links expire, so
  // without this the backup describes a file it can no longer open.
  backup_files: true,
  // How many files to pull in one run. Capped to protect the free tier's
  // memory: a full term of lecture videos would not fit in 512MB.
  backup_file_limit: 12,
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
  backup_exams: { true: "الاختبارات: نعم", false: "الاختبارات: لا" },
  backup_notifications: { true: "الإشعارات: نعم", false: "الإشعارات: لا" },
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

// The key that identifies a class slot across platform renumberings: the day
// and the start time. Two records sharing it are the platform double-booking
// the same slot, which it does often enough that the student needs a way to
// say which one is theirs.
export function sessionKey(s) {
  const date = s.date || s.sessionDate || "";
  const start = s.startTime || "";
  return `${String(date).slice(0, 10)}|${String(start).slice(0, 5)}`;
}

// A stable id for one class in one slot. Hiding by slot alone was wrong: when
// two classes share 07:00 on Thursday, hiding "احياء" also hid "اللغة
// الانجليزية" and left the student with an empty first period. The hide key
// therefore carries the subject too.
//
// The subject is hashed rather than inlined because Telegram caps
// callback_data at 64 bytes and Arabic subjects are wide — the raw string
// would not fit. Six base36 chars is ~2 billion values; a student's week has
// under a hundred classes, so a clash would mean one extra hidden class, not
// data loss.
export function hideKey(s) {
  const subj = String(s.subject || s.subjectName || s.title || "").trim();
  let h = 0;
  for (let i = 0; i < subj.length; i++) {
    h = (h * 31 + subj.charCodeAt(i)) >>> 0;
  }
  return `${sessionKey(s)}|${h.toString(36).padStart(6, "0")}`;
}

// Drop the classes this chat has hidden. Every schedule view calls this —
// the text list, the day cards, the grid image, and the backup — so hiding
// a phantom class removes it everywhere at once instead of from one view.
export function filterHidden(items, hidden) {
  if (!Array.isArray(hidden) || !hidden.length) return items || [];
  // Entries saved before the subject was part of the key are slot keys, and
  // a slot key hides every class in that slot — which is the bug the student
  // hit when hiding one of two Thursday 07:00 classes hid the other. They
  // cannot match anything now that the key carries a subject hash, so they
  // are ignored here; the student's English lesson comes back.
  const drop = new Set(cleanHidden(hidden));
  return (items || []).filter((s) => !drop.has(hideKey(s)));
}

// Keep only hide keys that name one class — date, time, and subject hash.
// Legacy entries that stop at date|time are dropped, since they would hide
// a whole slot rather than the one class the student picked.
export function cleanHidden(hidden) {
  return (Array.isArray(hidden) ? hidden : []).filter((k) =>
    /^\d{4}-\d{2}-\d{2}\|\d{2}:\d{2}\|[0-9a-z]{6}$/.test(String(k)),
  );
}

// Find slots the platform booked twice. Returns [{key, date, start, items}]
// so the caller can show the student exactly which classes clash and offer a
// button per side. Only flags live (non-cancelled) classes, since a
// cancelled class stacked on its replacement is the normal, correct state.
export function findConflicts(items) {
  const seen = new Map();
  for (const s of items || []) {
    if (String(s.status || "").toLowerCase() === "cancelled") continue;
    const k = sessionKey(s);
    if (!k.startsWith("2")) continue; // no parseable date → nothing to compare
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(s);
  }
  return [...seen.values()].filter((g) => g.length > 1).map((g) => ({
    key: sessionKey(g[0]),
    date: String(g[0].date || g[0].sessionDate || "").slice(0, 10),
    start: g[0].startTime,
    items: g,
  }));
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
    // These four govern every image the bot draws, not just the table —
    // direction, name cleaning, and the room all flow to each renderer.
    title: "🖼 الصور",
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
    items: ["backup_schedule", "backup_assignments", "backup_courses", "backup_grades", "backup_materials", "backup_exams", "backup_notifications"],
  },
];
