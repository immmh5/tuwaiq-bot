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
      // The marker can also precede the number — "بالليل 3" — so look
      // backwards too.
      const prev = (words[i - 1] || "").replace(/[ً-ْ.,،]/g, "");
      const isPM2 = /^(مساء|مغرب|العصر|بالليل|ليل)$/.test(prev);
      const isAM2 = /^(صباح|الصبح|الصباح|بالصباح|بالنهار)$/.test(prev);
      let [h, m] = clean.split(/[.:]/).map(Number);
      // A bare small number with no marker is genuinely ambiguous, and the
      // sentence is the tiebreaker: "أذاكر", "أراجع", "أسلم" mean the
      // evening, since that is when a student does those. Without this, a
      // 5pm study session became a 5am one and woke nobody.
      const sentence = ascii;
      const eveningSense = /(اذاكر|أذاكر|أراجع|اراجع|أدرس|أطلع|أشوف|أكتب|أحل|أسلم|أخلص|أبدا)/.test(
        sentence,
      );
      const morningSense = /(الصبح|الصباح|أصحى|أصحي|فجر|قبل المدرسة|بدري)/.test(sentence);
      if (!isPM && !isAM && h <= 8 && eveningSense && !morningSense) {
        h += 12; // "5 أذاكر" → 17:00
      }
      if ((isPM || isPM2) && h < 12) h += 12;
      if ((isAM || isAM2) && h === 12) h = 0;
      time = `${String(h % 24).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}`;
      if (isPM || isAM) i++;
      continue;
    }
    kept.push(w);
  }
  // No day named → tomorrow, which is the usual intent mid-week.
  if (!dateISO) dateISO = tomorrowISO;
  if (!time) {
    // No clock named either. An exam or a grade is time-sensitive, so nudge
    // in the early afternoon — after school, before the evening — rather
    // than 8am, which the student sleeps through. Anything else keeps the
    // morning default.
    time = inferPriority(original).level === "high" ? "13:00" : "08:00";
  }
  const priority = inferPriority(original);
  const body = kept
    .join(" ")
    .replace(/^(إن|أن|إني|اني|ن)\s+/i, "")
    .trim();
  // The reminder needs something left to actually say.
  if (!body || body.length < 2) return null;
  return { date: dateISO, time, body, raw: original, priority: priority.level, reason: priority.reason };
}

// --- Importance ------------------------------------------------------------

// How much this matters, and why. Everything the bot does after this — how
// many times it nudges, whether it escalates, whether it calls — hangs off
// this one judgement, so the levels need to mean something.
//
// high    exam, test, quiz, payment, deadline tied to money or a grade.
//         Repeat with escalating urgency until 21:00.
// medium  homework, submission, a meeting, a permission slip.
//         Repeat once, then let it go.
// low     everything else — "جيب كتاب الأحياء". Say it once and stop.
//
// The words are matched on the sentence as a whole rather than word by word:
// "ما عندي اختبار" would otherwise look like an exam, and a negation in
// Arabic lands far from the noun.
const HIGH_PATTERNS = [
  // No \b word boundaries: JavaScript's \b does not work on Arabic letters,
  // so "باختبار" (prefixed with ب) would never match. Substring match instead.
  { re: /(اختبار|امتحان|إمتحان|تست|quiz|exam)/i, reason: "فيه اختبار" },
  { re: /(رسوم|دفع|سداد|فاتورة)/i, reason: "فيه دفع مالي" },
  { re: /(تسليم|موعد نهائي|ديدلاين|deadline)/i, reason: "فيه موعد نهائي" },
];
const MEDIUM_PATTERNS = [
  { re: /(واجب|فروض|assignment|homework)/i, reason: "فيه واجب" },
  { re: /(موعد|اجتماع|لقاء|مقابلة|مستشار)/i, reason: "فيه موعد" },
  { re: /(إذن|تصريح|موافقة|تسجيل)/i, reason: "فيه ورقة" },
];
// "ما عندي اختبار" / "مو عندي" — a negation near a high word downgrades it
// to low, because the student said the thing is not happening. \b is useless
// on Arabic, so the negation is matched as a leading phrase instead.
const NEGATED = /^(ما|مو|ليش|لا)\s+(عندي|في|بي)/i;

export function inferPriority(text) {
  const t = String(text || "");
  if (!t) return { level: "low", reason: "" };
  const hasHigh = HIGH_PATTERNS.some((p) => p.re.test(t));
  const hasMed = MEDIUM_PATTERNS.some((p) => p.re.test(t));
  // "ما عندي اختبار" — the student said the thing is not happening, so
  // whatever it was, it is not a reason to escalate.
  if (NEGATED.test(t) && (hasHigh || hasMed)) return { level: "low", reason: "قلت إنه ما فيه" };
  for (const p of HIGH_PATTERNS) if (p.re.test(t)) return { level: "high", reason: p.reason };
  for (const p of MEDIUM_PATTERNS) if (p.re.test(t)) return { level: "medium", reason: p.reason };
  return { level: "low", reason: "" };
}

// --- Storage ---------------------------------------------------------------

export async function listReminders(chatId) {
  const rows = await getKv(KEY(chatId), []);
  return Array.isArray(rows) ? rows : [];
}

export async function addReminder(chatId, reminder) {
  const rows = await listReminders(chatId);
  const rec = {
    id: `r${Date.now()}${rows.length}`,
    sent: [],
    ...reminder,
    createdAt: new Date().toISOString(),
  };
  rows.push(rec);
  await setKv(KEY(chatId), rows);
  return rec;
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

// How hard to push, by level. high repeats on a widening gap until the
// evening cutoff, medium gets one follow-up, low is a single nudge. The
// gaps are deliberately not aggressive — a reminder every twenty minutes is
// harassment, and the student asked for persistent, not unbearable.
export const ESCALATION = {
  high: { repeats: [0, 90, 180, 300], cutoffHour: 21 },
  medium: { repeats: [0, 150], cutoffHour: 21 },
  low: { repeats: [0], cutoffHour: 21 },
};

// Everything due at or before now, honouring the escalation schedule. A
// high-priority row is returned again on a later tick when its next gap
// opens, rather than being deleted after the first nudge, and it stops at
// 21:00 local so the evening is quiet. Marked "done" only when every nudge
// in its plan has gone out.
export async function collectDueReminders(chatId, now = new Date()) {
  const rows = await listReminders(chatId);
  if (!rows.length) return [];
  const localNow = new Date(now.getTime() + ARABIA_TZ_OFFSET_MIN * 60000);
  const stamp = now.getTime();
  const due = [];
  const stillActive = [];
  for (const r of rows) {
    const level = ESCALATION[r.priority] ? r.priority : "low";
    const plan = ESCALATION[level];
    const startMs = Date.parse(`${r.date}T${r.time}:00+03:00`);
    if (Number.isNaN(startMs)) continue;
    // Which nudge in the plan is next, counting the ones already sent.
    const sent = Array.isArray(r.sent) ? r.sent.length : 0;
    if (sent >= plan.repeats.length) continue; // everything already fired
    const nextAt = startMs + plan.repeats[sent] * 60000;
    // The evening cutoff: no nudge after 21:00, whatever the plan says.
    const cutoffMs = Date.parse(`${r.date}T${String(plan.cutoffHour).padStart(2, "0")}:00:00+03:00`);
    if (stamp < nextAt) { stillActive.push(r); continue; }
    if (stamp > cutoffMs && sent === 0) {
      // Missed the whole window (the service was asleep past the cutoff);
      // send once on the next wake rather than never.
      due.push({ ...r, final: true });
      stillActive.push({ ...r, sent: [1] });
      continue;
    }
    if (stamp > cutoffMs) { stillActive.push(r); continue; }
    const sent2 = Array.isArray(r.sent) ? [...r.sent] : [];
    sent2.push(nextAt);
    const finished = sent2.length >= plan.repeats.length;
    due.push({ ...r, nudge: sent2.length, final: finished });
    if (!finished) stillActive.push({ ...r, sent: sent2 });
  }
  await setKv(KEY(chatId), stillActive);
  return due;
}

// When the student answers — replies to the bot, taps "I've seen it", or
// sets the item done — every still-pending nudge stops. Without this a
// resolved exam would keep re-firing until the evening.
export async function ackReminder(chatId, id) {
  const rows = await listReminders(chatId);
  const kept = rows.filter((r) => r.id !== id);
  await setKv(KEY(chatId), kept);
  return rows.length - kept.length;
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
