// src/scheduler.js — time-based notifications the student didn't ask for.
//
// The watcher reacts to new items appearing. This is the other half: things
// the bot should say on a clock, whether or not anything changed — today's
// schedule first thing in the morning, an exam that is a week out, a grade
// that moved since the last time the bot looked.
//
// Everything here reads and writes a single kv record ("scheduler_state") so
// a restart picks up exactly where it left off without re-announcing the same
// exam twice.

import { getKv, setKv, getTokens } from "./store.js";
import { fetchScope } from "./watcher.js";
import { getSettings } from "./settings.js";
// esc is the HTML-escaper shared by every formatter; without it Arabic titles
// carrying < > & would break Telegram's parse mode.
import { esc } from "./format.js";

// The Arab week starts on Sunday, and school days are Sunday–Thursday.
const WEEKDAY_NAMES = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// One state record holds every fired notification, keyed by scope+id, so a
// restart cannot re-fire the same exam reminder or the same morning message.
async function loadState() {
  const s = (await getKv("scheduler_state", null)) || {};
  // The record is replaced wholesale, so absent keys stay absent.
  if (!s.examAnnounced) s.examAnnounced = {};
  if (!s.morningDate) s.morningDate = null;
  if (!s.lastGrades) s.lastGrades = null;
  return s;
}

async function saveState(s) {
  await setKv("scheduler_state", s);
}

function startOfTomorrowInArabia(now) {
  // Saudi Arabia is UTC+3 with no daylight saving. A day boundary in UTC+3
  // is 21:00 UTC the previous day, which is what we anchor against so the
  // "morning" message never fires twice in one calendar day.
  const utc = now.getTime();
  const tomorrow = new Date(utc + DAY_MS);
  return tomorrow.toISOString().slice(0, 10);
}

function fmtDay(iso) {
  const d = new Date(iso);
  return `${WEEKDAY_NAMES[d.getDay()]} ${d.getDate()}`;
}

// ----- Morning briefing -----------------------------------------------------
// Fires once a day, early enough to be useful and late enough not to wake
// anyone: 06:30 UTC+3 = 03:30 UTC. Inside the window it fires once and then
// records the date so the rest of the day is quiet.
async function maybeMorning(now, send) {
  const utcHour = now.getUTCHours();
  // 03:30–09:00 UTC+3 = 00:30–06:00 UTC. Generous on purpose: the free tier
  // can be asleep at exactly 06:30, so a late wake-up still delivers.
  if (utcHour < 0 || utcHour > 6) return false;
  const today = now.toISOString().slice(0, 10);
  const state = await loadState();
  if (state.morningDate === today) return false;

  const tokens = await currentTokens();
  if (!tokens) return false;

  const dayName = WEEKDAY_NAMES[now.getDay()];
  const isWeekend = now.getDay() === 5 || now.getDay() === 6;
  if (isWeekend) {
    state.morningDate = today;
    await saveState(state);
    return false;
  }

  const [schedule, assignments] = await Promise.all([
    fetchScope("schedule", tokens.accessToken),
    fetchScope("assignments", tokens.accessToken),
  ]);

  const lines = [`🌅 <b>صباح الخير — ${fmtDay(now.toISOString())}</b>`, ""];

  const todays = (schedule || []).filter((s) => String(s.status || "").toLowerCase() !== "cancelled");
  if (todays.length) {
    lines.push(`🗓 <b>جدولك اليوم (${todays.length} حصة)</b>`);
    const byTime = [...todays].sort((a, b) => String(a.startsAt || "").localeCompare(String(b.startsAt || "")));
    for (const s of byTime.slice(0, 12)) {
      const t = s.startsAt ? String(s.startsAt).slice(0, 5) : "--:--";
      lines.push(`<code>${t}</code> ${esc(s.subjectName || s.title || "حصة")}${s.room ? ` — ${esc(s.room)}` : ""}`);
    }
    lines.push("");
  } else {
    lines.push("🗓 <b>ما في حصص اليوم</b>");
    lines.push("");
  }

  const due = (assignments || []).filter(
    (a) => !["Graded", "Submitted"].includes(a.status) && a.dueAt
  );
  const overdue = due.filter((a) => new Date(a.dueAt).getTime() < now.getTime());
  const soon = due
    .filter((a) => new Date(a.dueAt).getTime() >= now.getTime())
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
    .slice(0, 4);

  if (overdue.length) {
    lines.push(`🔴 <b>${overdue.length} واجب متأخر</b>`);
    for (const a of overdue.slice(0, 4)) lines.push(`• ${esc(a.title)} — ${esc(a.subject)}`);
    lines.push("");
  }
  if (soon.length) {
    lines.push(`⏰ <b>عندك ${soon.length} مستحق قريب</b>`);
    for (const a of soon) {
      const d = new Date(a.dueAt);
      lines.push(`• ${esc(a.title)} — ${esc(a.subject)} — <code>${d.toISOString().slice(5, 10)}</code>`);
    }
    lines.push("");
  }
  if (!overdue.length && !soon.length) {
    lines.push("✅ <b>ما عندك واجبات مستحقة</b> — يومك نظيف.");
    lines.push("");
  }

  state.morningDate = today;
  await saveState(state);
  await send(lines.join("\n"));
  return true;
}

// ----- Exam countdown --------------------------------------------------------
// Fires at two distances: seven days out ("a week from now") and two days out
// ("the day after tomorrow"). Both are far enough to study and close enough
// to matter. Each is announced once per exam.
async function maybeExamAlerts(now, send) {
  const tokens = await currentTokens();
  if (!tokens) return 0;
  const exams = await fetchScope("exams", tokens.accessToken);
  if (!Array.isArray(exams) || !exams.length) return 0;

  const state = await loadState();
  if (!state.examAnnounced) state.examAnnounced = {};
  let fired = 0;

  for (const e of exams) {
    if (!e.startsAt) continue;
    const start = new Date(e.startsAt).getTime();
    const diffDays = (start - now.getTime()) / DAY_MS;
    if (diffDays < 0 || diffDays > 8) continue;

    const id = String(e.id || `${e.title}|${e.startsAt}`);
    const announced = state.examAnnounced[id] || [];

    // 7-day window first, then the 2-day one. A scheduled announcement that
    // is in the past (the bot was asleep) still fires on the first wake.
    // The windows must not overlap: an exam due tomorrow belongs to the
    // 2-day message, so the 7-day branch only takes exams more than two
    // days out.
    let sendNow = null;
    if (diffDays > 2 && diffDays <= 7 && !announced.includes(7)) {
      sendNow = { days: 7, when: "باقي أسبوع" };
    } else if (diffDays <= 2 && !announced.includes(2)) {
      sendNow = { days: 2, when: diffDays <= 1 ? "باقي يوم" : "باقي يومين" };
    }
    if (!sendNow) continue;

    announced.push(sendNow.days);
    state.examAnnounced[id] = announced;

    const lines = [
      sendNow.days === 2 ? "🚨 <b>اختبار قريب!</b>" : "📅 <b>اختبار الأسبوع الجاي</b>",
      "",
      `📄 <b>${esc(e.title)}</b>`,
    ];
    if (e.subject) lines.push(`📚 ${esc(e.subject)}`);
    lines.push(`⏰ <b>${sendNow.when}</b> — <code>${fmtDay(e.startsAt)}</code>`);
    if (e.durationMin) lines.push(`⏱ ${e.durationMin} دقيقة`);
    lines.push("");
    lines.push(
      sendNow.days === 2
        ? "<i>بالتوفيق بكرة — اذاكر العصر وارتاح.</i>"
        : "<i>ذاكر وارتاح — أذكّرك مرة ثانية قبلها بيومين.</i>"
    );

    await send(lines.join("\n"));
    fired++;
  }

  if (fired) await saveState(state);
  return fired;
}

// ----- Smart grade alerts ----------------------------------------------------
// The watcher already announces "a grade appeared". What it cannot say is
// whether the number moved, because it only sees the present. This keeps the
// previous snapshot and reports the delta, so a re-grade or a correction
// arrives as "65 → 80 (+15)" rather than as a bare duplicate.
async function maybeGradeDeltas(now, send) {
  const tokens = await currentTokens();
  if (!tokens) return 0;
  const grades = await fetchScope("grades", tokens.accessToken);
  if (!Array.isArray(grades) || !grades.length) return 0;

  const state = await loadState();
  const prev = state.lastGrades || {};
  const byKey = {};
  let moved = 0;

  for (const g of grades) {
    const id = String(g.id || `${g.title}|${g.subject}`);
    byKey[id] = { score: g.score, max: g.maxScore, title: g.title, subject: g.subject };
    const before = prev[id];
    if (!before || before.score == null || g.score == null) continue;
    if (Number(before.score) === Number(g.score)) continue;

    moved++;
    const delta = Number(g.score) - Number(before.score);
    const sign = delta > 0 ? "+" : "";
    const pct =
      before.max && g.maxScore
        ? ` (${Math.round((Number(before.score) / before.max) * 100)}% → ${Math.round((Number(g.score) / g.maxScore) * 100)}%)`
        : "";

    const lines = [
      delta > 0 ? "📈 <b>درجتك طارت!</b>" : "📉 <b>درجتك تغيّرت</b>",
      "",
      `🏆 <b>${esc(g.title)}</b>`,
      `📚 ${esc(g.subject || "")}`,
      `السابق: <code>${before.score}</code> → الجديد: <code>${g.score}</code> <b>(${sign}${delta})</b>${pct}`,
    ];
    await send(lines.join("\n"));
  }

  state.lastGrades = byKey;
  await saveState(state);
  return moved;
}

// The tokens are refreshed by the watcher; the scheduler reads whatever is
// current rather than logging in itself, so it never adds an auth attempt.
async function currentTokens() {
  try {
    const t = await getTokens();
    if (t && t.accessToken && t.accessExpiresAt > Date.now() / 1000) return t;
  } catch {}
  return null;
}

// Main entry: called by the watcher's tick. Each feature is independently
// gated by its own setting, so the panel can turn one off without disabling
// the others. A send failure (bot asleep, Telegram hiccup) does not record
// state, so the message retries next tick.
export async function runScheduler({ send, now = new Date() } = {}) {
  if (!send) return { morning: 0, exams: 0, grades: 0 };
  const cfg = await getSettings(process.env.TELEGRAM_CHAT_ID || null).catch(() => ({}));

  let morning = 0;
  if (cfg.morning_briefing !== false) {
    try {
      morning = (await maybeMorning(now, send)) ? 1 : 0;
    } catch {}
  }

  let exams = 0;
  if (cfg.exam_countdown !== false) {
    try {
      exams = await maybeExamAlerts(now, send);
    } catch {}
  }

  let grades = 0;
  if (cfg.grade_alerts !== false) {
    try {
      grades = await maybeGradeDeltas(now, send);
    } catch {}
  }

  return { morning, exams, grades };
}
