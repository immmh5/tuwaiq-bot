// Student-set reminders: "ذكرني بكرة الساعة ٨ باختبار الفيزياء".
//
// The platform's own deadlines already drive the deadline reminders; this is
// for everything else — a test a teacher announced verbally, a trip, a
// permission slip. The student says it in their own words and the bot brings
// it back at the time they named.
//
// Reminders live in the KV store under one key per chat, which survives
// restarts and the free tier's sleeps. The scheduler ticks every minute and
// fires anything whose time has come, then deletes it so it never repeats.

import { getKv, setKv } from "./store.js";

const KEY = (chatId) => `reminders:${chatId}`;

// Clock-driven notifications already exist; reminders join the same queue so
// the student gets one message, not a burst.
const ARABIA_TZ_OFFSET_MIN = 180; // UTC+3, Saudi time, no DST to track.

// --- Parsing ---------------------------------------------------------------

// "بكرة", "اليوم", "الاثنين".. → an absolute date. Returns null when the word
// is not a day name, so the caller can tell "no date given" from a bad one.
function dayWordToISO(word, now = new Date()) {
  const days = ["الاحد", "الاثنين", "الثلاثاء", "الاربعاء", "الخميس", "الجمعة", "السبت"];
  const aliases = {
    الاحد: "الاحد", احد: "الاحد",
    الاثنين: "الاثنين", اثنين: "الاثنين",
    الثلاثاء: "الثلاثاء", ثلاثاء: "الثلاثاء", الثلاء: "الثلاثاء",
    الاربعاء: "الاربعاء", اربعاء: "الاربعاء", الاربع: "الاربعاء",
    الخميس: "الخميس", خميس: "الخميس",
    الجمعة: "الجمعة", جمعة: "الجمعة", الجمعه: "الجمعة",
    السبت: "السبت", سبت: "السبت",
  };
  const clean = String(word || "").replace(/[ً-ْ]/g, "").trim();
  const target = aliases[clean];
  if (!target) return null;
  const want = days.indexOf(target);
  // Shift now to Saudi time so "today" means the student's today.
  const local = new Date(now.getTime() + ARABIA_TZ_OFFSET_MIN * 60000);
  const dow = (local.getDay() + 6) % 7; // make Monday=0 like the days array
  let add = (want - dow + 7) % 7;
  if (add === 0) add = 7; // "الاثنين" on a Monday means next Monday
  const d = new Date(local.getTime() + add * 86400000);
  return d.toISOString().slice(0, 10);
}

// "٨", "8", "8:30", "٨:٣٠" → "HH:MM". Arabic-Indic digits are the norm on the
// platform, so convert before parsing. Returns null when there is no clock
// time to be found, meaning the reminder defaults to 8 in the morning.
function parseTime(text) {
  const t = String(text || "")
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));
  const m = t.match(/(\d{1,2})[:.\s]?(\d{0,2})/);
  if (!m) return null;
  let h = Math.min(23, Math.max(0, parseInt(m[1], 10) || 0));
  let min = m[2] ? Math.min(59, parseInt(m[2], 10) || 0) : 0;
  // "8 ص" / "8 م" — 8pm should be 20:00, not 08:00.
  if (/م\b|مساء|مغرب/.test(t) && h < 12) h += 12;
  if (/ص\b|صباح/.test(t) && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// Pull the day and the clock out of a free sentence by walking the words.
// Keeping the pieces as whole tokens is what stops "الساعة 8" from leaving
// "الساعة" behind or eating a letter of the word after the number.
export function parseReminder(text, now = new Date()) {
  const original = String(text || "").trim();
  if (!original) return null;
  // Arabic-Indic and Persian digits appear constantly on the platform; map
  // them to ASCII once so every regex below sees one shape.
  const ascii = original
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d).toString())
    .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d).toString());
  const words = ascii.split(/\s+/);
  let dateISO = null;
  let time = null;
  const kept = [];
  const localNow = new Date(now.getTime() + ARABIA_TZ_OFFSET_MIN * 60000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const todayISO = iso(localNow);
  const tomorrowISO = iso(new Date(localNow.getTime() + 86400000));

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const clean = w.replace(/[ً-ْ.,،]/g, "");
    // Relative days.
    if (!dateISO) {
      if (/^(اليوم|النهار|هاليوم)$/.test(clean)) { dateISO = todayISO; continue; }
      if (/^(بكرة|بكره|بكر|غدا|غادة|باكر)$/.test(clean)) { dateISO = tomorrowISO; continue; }
      if (/^(بعد)$/.test(clean) && /^(بكرة|بكره|غدا)$/.test((words[i + 1] || "").replace(/[ً-ْ]/g, ""))) {
        dateISO = iso(new Date(localNow.getTime() + 2 * 86400000));
        i++; continue;
      }
      const wd = dayWordToISO(clean, now);
      if (wd) { dateISO = wd; continue; }
    }
    // "الساعة" just marks a clock is coming; drop the word and let the next
    // token be parsed as the time.
    if (/^(الساعة|ساعة|الساعه)$/.test(clean) && !time) continue;
    // Clock: "8", "8:30", "8.30" optionally followed by ص/م.
    if (!time && /^(\d{1,2})([:.]\d{1,2})?$/.test(clean)) {
      const next = (words[i + 1] || "").replace(/[ً-ْ.,،]/g, "");
      // "بالليل" reads as PM, "بالصباح" as AM — students say these more than
      // the bare ص/م markers.
      const isPM = /^(م|مساء|مغرب|العصر|بالليل|ليل)$/.test(next);
      const isAM = /^(ص|صباح|الصبح|الصباح|بالصباح|بالنهار)$/.test(next);
      let [h, m] = clean.split(/[.:]/).map(Number);
      if (isPM && h < 12) h += 12;
      if (isAM && h === 12) h = 0;
      time = `${String(h % 24).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}`;
      if (isPM || isAM) i++;
      continue;
    }
    kept.push(w);
  }
  // No day named → tomorrow, which is the usual intent mid-week.
  if (!dateISO) dateISO = tomorrowISO;
  if (!time) time = "08:00";
  const body = kept
    .join(" ")
    .replace(/^(إن|أن|إني|اني|ن)\s+/i, "")
    .trim();
  // The reminder needs something left to actually say.
  if (!body || body.length < 2) return null;
  return { date: dateISO, time, body, raw: original };
}

// --- Storage ---------------------------------------------------------------

export async function listReminders(chatId) {
  const rows = await getKv(KEY(chatId), []);
  return Array.isArray(rows) ? rows : [];
}

export async function addReminder(chatId, reminder) {
  const rows = await listReminders(chatId);
  rows.push({ id: `r${Date.now()}${rows.length}`, ...reminder, createdAt: new Date().toISOString() });
  await setKv(KEY(chatId), rows);
  return rows;
}

export async function removeReminder(chatId, id) {
  const rows = await listReminders(chatId);
  const kept = rows.filter((r) => r.id !== id);
  await setKv(KEY(chatId), kept);
  return rows.length - kept.length;
}

export async function clearReminders(chatId) {
  await setKv(KEY(chatId), []);
}

// --- Firing ----------------------------------------------------------------

// Everything due at or before now. Returns the fired rows so the caller can
// report them, and removes them from the store so a reboot never re-sends.
export async function collectDueReminders(chatId, now = new Date()) {
  const rows = await listReminders(chatId);
  if (!rows.length) return [];
  const stamp = now.toISOString();
  const due = rows.filter((r) => `${r.date} ${r.time}:00` <= stamp);
  if (!due.length) return [];
  const kept = rows.filter((r) => !due.includes(r));
  await setKv(KEY(chatId), kept);
  return due;
}

// Arabic-formatted "الخميس ١ أكتوبر · ٥:٠٠ م" for the confirmation message,
// so the student can see the bot understood the time right.
export function fmtReminder(r) {
  const [h, m] = r.time.split(":").map(Number);
  const hh = h % 12 === 0 ? 12 : h % 12;
  const ap = h < 12 ? "ص" : "م";
  const mm = m ? `:${String(m).padStart(2, "0")}` : "";
  return `${r.date} · ${hh}${mm} ${ap}`;
}
