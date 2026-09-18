// src/format.js — human-friendly Arabic formatting for Telegram messages.
// Everything here is pure: no network, no store. Used by both the watcher
// notifications and the /list-* commands so they always look identical.

const RIYADH = "Asia/Riyadh";

const AR_DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const AR_MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

// Turn any ISO/date value into short readable Arabic, e.g. "الخميس ١٧ سبتمبر، ٩:٣٠ م".
// Returns "—" for missing/invalid input so messages never show raw timestamps.
export function fmtDate(input) {
  if (!input) return "—";
  const d = new Date(input);
  if (isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: RIYADH,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  const wd = AR_DAYS[d.getDay()];
  const mo = AR_MONTHS[d.getMonth()];
  const day = get("day");
  const hr = get("hour");
  const min = get("minute");
  const ampm = get("dayPeriod") === "PM" ? "م" : "ص";
  return `${wd} ${day} ${mo}، ${hr}:${min} ${ampm}`;
}

// Just the date part: "الخميس ١٧ سبتمبر"
export function fmtDay(input) {
  if (!input) return "—";
  const d = new Date(input);
  if (isNaN(d.getTime())) return "—";
  return `${AR_DAYS[d.getDay()]} ${d.getDate()} ${AR_MONTHS[d.getMonth()]}`;
}

// Relative time: "بعد ٣ ساعات", "منذ يومين", "الحين"
export function fmtRelative(input) {
  if (!input) return "";
  const d = new Date(input);
  if (isNaN(d.getTime())) return "";
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  const future = diff > 0;
  const min = Math.round(abs / 60000);
  const hr = Math.round(abs / 3600000);
  const day = Math.round(abs / 86400000);
  let s;
  if (min < 1) s = "الحين";
  else if (min < 60) s = `${min} دقيقة`;
  else if (hr < 24) s = `${hr} ساعة`;
  else if (day < 30) s = `${day} يوم`;
  else s = fmtDay(input);
  if (s === "الحين" || s.includes("يناير") || s.includes("فبراير")) return s;
  return future ? `بعد ${s}` : `منذ ${s}`;
}

// "2/5" or "—"
export function fmtScore(score, maxScore) {
  if (score == null) return "—";
  return maxScore != null ? `${score}/${maxScore}` : `${score}`;
}

// Arabic number formatting without heavy Intl locale dependency issues.
export function fmtNum(n) {
  if (n == null) return "—";
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Split long HTML text into Telegram-safe chunks (limit 4096).
export function chunkText(text, max = 3800) {
  if (text.length <= max) return [text];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < 1) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) out.push(rest);
  return out;
}

// ---- item renderers (shared by notifications and /list-* commands) ----

export function formatAssignment(a) {
  const bits = [`📝 <b>${esc(a.title)}</b>`];
  if (a.subject) bits.push(`   📚 ${esc(a.subject)}`);
  if (a.dueAt) {
    bits.push(`   ⏰ ${fmtDate(a.dueAt)}${a.isOverdue ? " 🔴 متأخر" : a.isDueSoon ? " 🟡 قريب" : ""}`);
  }
  if (a.status) bits.push(`   📊 ${esc(a.status)}`);
  if (a.gradePoints != null && a.maxPoints != null) bits.push(`   🏆 ${a.gradePoints}/${a.maxPoints}`);
  return bits.join("\n");
}

export function formatMaterial(m) {
  const bits = [`📚 <b>${esc(m.title)}</b>`];
  if (m.subject) bits.push(`   📗 ${esc(m.subject)}`);
  if (m.contentType) bits.push(`   📎 ${esc(m.contentType)}`);
  if (m.createdAt) bits.push(`   📅 ${fmtDate(m.createdAt)}`);
  return bits.join("\n");
}

export function formatExam(e) {
  const bits = [`📄 <b>${esc(e.title)}</b>`];
  if (e.subject) bits.push(`   📚 ${esc(e.subject)}`);
  if (e.startsAt) bits.push(`   ▶️ ${fmtDate(e.startsAt)}`);
  if (e.endsAt) bits.push(`   ⏹ ${fmtDate(e.endsAt)}`);
  if (e.durationMin) bits.push(`   ⏱ ${e.durationMin} دقيقة`);
  if (e.status) bits.push(`   📊 ${esc(e.status)}`);
  return bits.join("\n");
}

export function formatGrade(g) {
  const bits = [`🏆 <b>${esc(g.title)}</b>`];
  if (g.subject) bits.push(`   📚 ${esc(g.subject)}`);
  if (g.score != null) bits.push(`   🏆 ${fmtScore(g.score, g.maxScore)}`);
  if (g.createdAt) bits.push(`   📅 ${fmtDate(g.createdAt)}`);
  return bits.join("\n");
}

export function formatNotification(n) {
  const bits = [`🔔 <b>${esc(n.title)}</b>`];
  if (n.subject) bits.push(`   📚 ${esc(n.subject)}`);
  if (n.body) bits.push(`   💬 ${esc(String(n.body).slice(0, 180))}`);
  if (n.createdAt) bits.push(`   📅 ${fmtDate(n.createdAt)}`);
  return bits.join("\n");
}

export function formatList(header, items, fmt) {
  return [header, ...items.map(fmt)].join("\n");
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export { esc as escapeHtml };
