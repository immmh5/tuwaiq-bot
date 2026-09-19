// src/images.js — render platform data to PNG images for Telegram.
//
// Uses @resvg/resvg-js to convert SVG to PNG. No browser needed, which keeps
// it inside Render's free 512MB tier. Arabic shaping and RTL come from the
// Noto Sans Arabic font installed in the Dockerfile.
//
// Every renderer returns a PNG Buffer plus a caption.

import { renderAsync } from "@resvg/resvg-js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Load the Arabic font from the repo rather than trusting the system font
// collection. resvg silently drops glyphs when it cannot resolve a family,
// which rendered an "empty" schedule image on Render even though the apt
// font package was installed.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, "..", "assets", "fonts");

// resvg resolves font families from the system collection, but silently drops
// glyphs (leaving an "empty" image with no visible text) when a family is
// missing. Loading the TTFs explicitly from the repo makes rendering
// identical everywhere — the Dockerfile installs the same fonts as a backup.
const fontFiles = [
  path.join(FONT_DIR, "NotoSansArabic-Regular.ttf"),
  path.join(FONT_DIR, "NotoSansArabic-Bold.ttf"),
];

const ARABIC_FONT = "Noto Sans Arabic, Noto Sans, sans-serif";

// Colours — dark theme, reads well in Telegram night mode.
const C = {
  bg: "#0e1420",
  card: "#182234",
  cardAlt: "#1e2a40",
  line: "#2a3a55",
  text: "#f1f5f9",
  sub: "#94a3b8",
  accent: "#60a5fa",
  good: "#34d399",
  warn: "#fbbf24",
  bad: "#f87171",
  purple: "#a78bfa",
};

const RENDER_OPTS = {
  background: C.bg,
  font: {
    fontFiles,
    loadSystemFonts: true,
    defaultFontFamily: "Noto Sans Arabic",
  },
};

async function toPng(svg, width = 1000) {
  const img = await renderAsync(svg, { ...RENDER_OPTS, fitTo: { mode: "width", value: width } });
  return img.asPng();
}

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const DAY = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const MONTH = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

// "07:00:00" → "7:00 ص"
const fmtClock = (t) => {
  if (!t) return "";
  const [h, m] = String(t).split(":");
  const hh = Number(h);
  if (isNaN(hh)) return String(t);
  const ap = hh >= 12 ? "م" : "ص";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${m ?? "00"} ${ap}`;
};

// ISO date string → "الأحد 13 سبتمبر"
const fmtDayName = (iso) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return `${DAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
};


function header(title, subtitle) {
  return `
  <rect x="0" y="0" width="1000" height="118" fill="${C.accent}" opacity="0.08"/>
  <text x="980" y="58" font-family="${ARABIC_FONT}" font-size="40" font-weight="700"
        fill="${C.text}" text-anchor="end" direction="rtl">${esc(title)}</text>
  <text x="980" y="96" font-family="${ARABIC_FONT}" font-size="22"
        fill="${C.sub}" text-anchor="end" direction="rtl">${esc(subtitle)}</text>
  <rect x="0" y="118" width="1000" height="2" fill="${C.line}"/>`;
}

// ---- Schedule image ---------------------------------------------------------
// The platform renders both halves of a substitution: the cancelled original
// AND its replacement share a slot (same day + start time), and the original
// is drawn pale. Drawing every row verbatim produced the "repeated classes"
// the student saw. So sessions are grouped by slot; when a slot holds a
// cancelled session next to a live one, they are merged into a single card
// that shows the live subject with the cancelled one as a pale "استبدلت".
function groupSlots(sessions) {
  const bySlot = new Map();
  for (const s of sessions) {
    const day = String(s.date || "").slice(0, 10);
    const slot = `${day}|${s.startTime || ""}`;
    if (!bySlot.has(slot)) bySlot.set(slot, { day, start: s.startTime, items: [] });
    bySlot.get(slot).items.push(s);
  }
  return [...bySlot.values()].sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    return String(a.start).localeCompare(String(b.start));
  });
}

export async function renderScheduleImage(sessions) {
  const slots = groupSlots(sessions);
  const today = new Date().toISOString().slice(0, 10);

  // Collapse into per-day sections of resolved cards.
  const byDay = new Map();
  for (const slot of slots) {
    if (!byDay.has(slot.day)) byDay.set(slot.day, []);
    const live = slot.items.filter((s) => s.status !== "cancelled");
    const cancelled = slot.items.filter((s) => s.status === "cancelled");
    if (live.length) {
      // Substitution: show the replacement, note what it replaced.
      byDay.get(slot.day).push({
        ...live[0],
        replacedBy: cancelled.length ? cancelled[0].title : null,
      });
    } else {
      // Genuinely cancelled with no replacement.
      for (const c of cancelled) byDay.get(slot.day).push({ ...c, replacedBy: null });
    }
  }

  const days = [...byDay.keys()].sort();
  const rows = [];
  let y = 140;
  const PAD = 32;
  const W = 1000 - PAD * 2;

  for (const day of days) {
    const isToday = day === today;
    const list = byDay.get(day);
    const activeCount = list.filter((s) => s.status !== "cancelled").length;

    rows.push(`
    <rect x="${PAD}" y="${y}" width="${W}" height="52" rx="12" fill="${isToday ? C.accent : C.card}" opacity="${isToday ? 0.18 : 1}"/>
    <text x="${PAD + 20}" y="${y + 35}" font-family="${ARABIC_FONT}" font-size="24" font-weight="700"
          fill="${isToday ? C.accent : C.text}" direction="rtl">${esc(fmtDayName(day))}${isToday ? "  • اليوم" : ""}</text>
    <text x="${PAD + W - 20}" y="${y + 35}" font-family="${ARABIC_FONT}" font-size="20"
          fill="${C.sub}" text-anchor="end" direction="rtl">${activeCount} حصة</text>`);
    y += 64;

    for (const s of list) {
      const cancelled = s.status === "cancelled";
      const time = fmtClock(s.startTime);
      const room = s.room ? `غرفة ${s.room}` : "—";
      const accent = cancelled ? C.bad : C.good;
      const h = s.replacedBy ? 84 : 56;

      rows.push(`
      <rect x="${PAD}" y="${y}" width="${W}" height="${h}" rx="10" fill="${C.cardAlt}"/>
      <rect x="${PAD}" y="${y}" width="6" height="${h}" rx="3" fill="${accent}"/>
      <text x="${PAD + 22}" y="${y + 33}" font-family="${ARABIC_FONT}" font-size="22" font-weight="600"
            fill="${C.text}" direction="rtl">${esc(s.title)}</text>
      <text x="${PAD + W - 290}" y="${y + 33}" font-family="${ARABIC_FONT}" font-size="19"
            fill="${C.sub}" text-anchor="end" direction="rtl">${esc(room)}</text>
      <text x="${PAD + W - 22}" y="${y + 33}" font-family="${ARABIC_FONT}" font-size="19"
            fill="${C.sub}" text-anchor="end" direction="rtl">${esc(time)}</text>`);
      if (s.replacedBy) {
        rows.push(`
        <text x="${PAD + 22}" y="${y + 66}" font-family="${ARABIC_FONT}" font-size="17"
              fill="${C.warn}" direction="rtl">↩ استُبدلت بـ: ${esc(s.replacedBy)}</text>`);
      } else if (cancelled) {
        rows.push(`
        <text x="${PAD + 22}" y="${y + 33}" font-family="${ARABIC_FONT}" font-size="17"
              fill="${C.bad}" direction="rtl">ملغاة</text>`);
      }
      y += h + 10;
    }
    y += 12;
  }

  const liveCount = slots.reduce((n, s) => n + (s.items.some((x) => x.status !== "cancelled") ? 1 : 0), 0);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${y}" direction="rtl">
    <rect width="1000" height="${y}" fill="${C.bg}"/>
    ${header("🗓 الجدول الأسبوعي", `${liveCount} حصة فعلية في ${days.length} أيام`)}
    ${rows.join("")}
  </svg>`;
  return {
    png: await toPng(svg),
    caption: `🗓 جدولك الأسبوعي — ${liveCount} حصة`,
  };
}

// ---- Assignments image -------------------------------------------------------
export async function renderAssignmentsImage(assignments) {
  const pend = assignments.filter((a) => String(a.status).toLowerCase() === "pending");
  const graded = assignments.filter((a) => String(a.status).toLowerCase() === "graded");
  const rest = assignments.filter((a) => !pend.includes(a) && !graded.includes(a));

  const rows = [];
  let y = 140;
  const PAD = 32;
  const W = 1000 - PAD * 2;

  const section = (title, color, list, showScore) => {
    if (!list.length) return;
    rows.push(`
    <rect x="${PAD}" y="${y}" width="${W}" height="48" rx="12" fill="${color}" opacity="0.16"/>
    <text x="${PAD + 20}" y="${y + 32}" font-family="${ARABIC_FONT}" font-size="22" font-weight="700"
          fill="${color}" direction="rtl">${esc(title)} (${list.length})</text>`);
    y += 60;
    for (const a of list) {
      const overdue =
        showScore && a.dueAt && new Date(a.dueAt).getTime() < Date.now();
      const due = a.dueAt ? fmtDayName(a.dueAt) : "—";
      const score =
        a.score != null ? `🏆 ${a.score}/${a.maxScore ?? "?"}` : "";
      rows.push(`
      <rect x="${PAD}" y="${y}" width="${W}" height="64" rx="10" fill="${C.cardAlt}"/>
      <rect x="${PAD}" y="${y}" width="6" height="64" rx="3" fill="${overdue ? C.bad : color}"/>
      <text x="${PAD + 22}" y="${y + 28}" font-family="${ARABIC_FONT}" font-size="22" font-weight="600"
            fill="${C.text}" direction="rtl">${esc(a.title)}</text>
      <text x="${PAD + 22}" y="${y + 52}" font-family="${ARABIC_FONT}" font-size="18"
            fill="${C.sub}" direction="rtl">📚 ${esc(a.subject || "—")}${overdue ? "  • متأخر" : ""}</text>
      <text x="${PAD + W - 22}" y="${y + 30}" font-family="${ARABIC_FONT}" font-size="18"
            fill="${C.sub}" text-anchor="end" direction="rtl">⏰ ${esc(due)}</text>
      ${score ? `<text x="${PAD + W - 22}" y="${y + 54}" font-family="${ARABIC_FONT}" font-size="18"
            fill="${C.good}" text-anchor="end" direction="rtl">${esc(score)}</text>` : ""}`);
      y += 74;
    }
    y += 14;
  };

  section("📝 الواجبات المعلّقة", C.warn, pend, true);
  section("✅ المصحّحة", C.good, graded, true);
  section("📦 المُسلَّمة", C.sub, rest, false);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${Math.max(y, 200)}" direction="rtl">
    <rect width="1000" height="${Math.max(y, 200)}" fill="${C.bg}"/>
    ${header("📝 الواجبات", `${assignments.length} واجب — ${pend.length} معلّق`)}
    ${rows.join("")}
  </svg>`;
  return {
    png: await toPng(svg),
    caption: `📝 ${assignments.length} واجب (${pend.length} معلّق)`,
  };
}

// ---- Grades image ------------------------------------------------------------
export async function renderGradesImage(grades) {
  const PAD = 32;
  const W = 1000 - PAD * 2;
  let y = 140;

  const rows = grades.slice(0, 20).map((g) => {
    const score = g.score ?? "—";
    const max = g.maxScore ?? "?";
    const pct =
      g.score != null && g.maxScore ? Math.round((g.score / g.maxScore) * 100) : null;
    const bar = pct != null ? Math.max(6, Math.round((pct / 100) * 240)) : 0;
    const color = pct == null ? C.sub : pct >= 80 ? C.good : pct >= 50 ? C.warn : C.bad;
    const r = `
    <rect x="${PAD}" y="${y}" width="${W}" height="62" rx="10" fill="${C.cardAlt}"/>
    <text x="${PAD + 22}" y="${y + 30}" font-family="${ARABIC_FONT}" font-size="21" font-weight="600"
          fill="${C.text}" direction="rtl">${esc(g.title)}</text>
    <text x="${PAD + 22}" y="${y + 53}" font-family="${ARABIC_FONT}" font-size="17"
          fill="${C.sub}" direction="rtl">📚 ${esc(g.subject || "—")}</text>
    <text x="${PAD + W - 22}" y="${y + 30}" font-family="${ARABIC_FONT}" font-size="22" font-weight="700"
          fill="${color}" text-anchor="end" direction="rtl">${esc(String(score))}/${esc(String(max))}</text>
    ${pct != null ? `<rect x="${PAD + W - 280}" y="${y + 40}" width="240" height="8" rx="4" fill="${C.line}"/>
    <rect x="${PAD + W - 280 + (240 - bar)}" y="${y + 40}" width="${bar}" height="8" rx="4" fill="${color}"/>` : ""}`;
    y += 72;
    return r;
  });

  if (!rows.length) {
    rows.push(`<text x="500" y="220" font-family="${ARABIC_FONT}" font-size="24" fill="${C.sub}"
      text-anchor="middle" direction="rtl">لا توجد درجات بعد</text>`);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${Math.max(y, 240)}" direction="rtl">
    <rect width="1000" height="${Math.max(y, 240)}" fill="${C.bg}"/>
    ${header("🏆 الدرجات", `${grades.length} درجة`)}
    ${rows.join("")}
  </svg>`;
  return { png: await toPng(svg), caption: `🏆 درجاتك (${grades.length})` };
}
