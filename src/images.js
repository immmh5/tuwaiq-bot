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
// ---- Schedule grid ----------------------------------------------------------
// Mirrors the platform's own timetable layout: days as columns, times as
// rows, a class placed in its slot and dimmed when cancelled. The site
// renders a substitution as two cards stacked in the same slot — the
// cancelled original pale, its replacement bold — and this reproduces that
// exactly, so the image is the page's grid and not a re-interpretation.
export async function renderScheduleGridImage(sessions) {
  const today = new Date().toISOString().slice(0, 10);
  const toMin = (t) => {
    const [h, m] = String(t || "0:0").split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const norm = (s) => ({
    ...s,
    day: String(s.date || "").slice(0, 10),
    startMin: toMin(s.startTime),
    endMin: toMin(s.endTime) || toMin(s.startTime) + 45,
    cancelled: s.status === "cancelled",
  });
  const all = (sessions || []).map(norm);
  const days = [...new Set(all.map((s) => s.day))].sort();
  if (!days.length) days.push(today);

  // Open and close of the whole grid, in minutes — the site lays cards out
  // on this same axis, positioning each by its real start/end times.
  const lo = Math.min(...all.map((s) => s.startMin), 7 * 60);
  const hi = Math.max(...all.map((s) => s.endMin), 13 * 60);
  const SPAN = hi - lo;

  // The platform's own subject palette, verbatim from its shipped CSS
  // (data-tint 0..5 → --eqc-ink / --eqc-soft). Using the page's real colours
  // is what makes the grid read as "the site's table" instead of ours.
  const TINTS = [
    { ink: "#8b6cd9", soft: "#efe9fb" },
    { ink: "#35a37f", soft: "#e2f4ec" },
    { ink: "#e07a6a", soft: "#fdeae7" },
    { ink: "#4a8fd4", soft: "#e7f1fc" },
    { ink: "#cf9a2c", soft: "#fbf2da" },
    { ink: "#a05fb5", soft: "#f6ebf9" },
  ];
  // Assign one tint per subject, in first-seen order, mirroring how the
  // page assigns data-tint per offering.
  const subjTint = new Map();
  for (const s of all) if (s.subject && !subjTint.has(s.subject)) subjTint.set(s.subject, subjTint.size);
  const colorFor = (s) => TINTS[(subjTint.get(s.subject) ?? 0) % TINTS.length];

  const PAD = 28;
  const LABEL = 84; // right-side gutter for the time axis (RTL)
  const HEAD = 64; // header row height
  const CW = Math.floor((1000 - PAD * 2 - LABEL) / days.length);

  // Vertical axis: one minute of class time maps to a fixed number of
  // pixels, exactly like the site's 45-min = 67.5px grid. The whole grid
  // stretches to fit the week's earliest start and latest end.
  const TOP = HEAD + 8;
  const PPM = 1.5; // px per minute (45 min → 67.5px, the site's own scale)
  const h = TOP + SPAN * PPM + 70;

  const xOf = (i) => PAD + LABEL + i * CW;
  const w = 1000;

  const parts = [];
  // Hour rules and labels, every full hour the grid spans
  const firstH = Math.floor(lo / 60);
  const lastH = Math.ceil(hi / 60);
  for (let hh = firstH; hh <= lastH; hh++) {
    const y = TOP + (hh * 60 - lo) * PPM;
    parts.push(`<line x1="${PAD}" y1="${y}" x2="${w - PAD}" y2="${y}" stroke="rgba(124,92,191,.14)" stroke-width="1"/>`);
    parts.push(
      `<text x="${PAD + LABEL - 14}" y="${y + 5}" font-family="${ARABIC_FONT}" font-size="16" fill="#8a8798" text-anchor="end" direction="rtl">${hh}:00</text>`
    );
  }

  // Day headers, today highlighted like the site's .is-today gradient
  for (let i = 0; i < days.length; i++) {
    const x = xOf(i);
    const isToday = days[i] === today;
    if (isToday) parts.push(`<rect x="${x}" y="36" width="${CW - 6}" height="${HEAD - 12}" rx="10" fill="#7c5cbf1f"/>`);
    parts.push(`<line x1="${x}" y1="${HEAD + 4}" x2="${x + CW - 6}" y2="${HEAD + 4}" stroke="rgba(124,92,191,.14)" stroke-width="1"/>`);
    parts.push(
      `<text x="${x + CW / 2 - 3}" y="60" font-family="${ARABIC_FONT}" font-size="20" font-weight="800" fill="${isToday ? "#7c5cbf" : "#2c2540"}" text-anchor="middle" direction="rtl">${esc(fmtDayName(days[i]).split(" ")[0])}</text>`
    );
  }

  // Group per day+slot. Overlapping sessions in one slot — the cancelled
  // original beside its replacement, or a genuine double period — share the
  // column side by side instead of being squeezed into stacked thin rows,
  // which is what the site itself does.
  const slotKey = (s) => `${s.day}|${s.startMin}`;
  const bySlot = new Map();
  for (const s of all) {
    if (!bySlot.has(slotKey(s))) bySlot.set(slotKey(s), []);
    bySlot.get(slotKey(s)).push(s);
  }

  for (const [, items] of bySlot) {
    const s0 = items[0];
    const col = days.indexOf(s0.day);
    const x = xOf(col);
    const yTop = TOP + (s0.startMin - lo) * PPM + 2;
    const cardH = Math.max((s0.endMin - s0.startMin) * PPM - 4, 44);
    const n = items.length;
    const subW = (CW - 12) / n;

    // Site-faithful card: soft fill, ink-coloured inset ring, and the
    // cancelled variant at 52% opacity with its title struck through —
    // the same recipe the platform's own CSS uses for .tt-class.
    const draw = (s, idx, pale) => {
      const cx = x + 6 + idx * subW;
      const t = colorFor(s);
      const time = fmtClock(s.startTime);
      const op = pale ? 0.52 : 1;
      const tx = cx + subW / 2;
      parts.push(`<rect x="${cx}" y="${yTop}" width="${subW - 4}" height="${cardH}" rx="11" fill="${t.soft}" opacity="${op}"/>`);
      parts.push(`<rect x="${cx + 0.75}" y="${yTop + 0.75}" width="${subW - 5.5}" height="${cardH - 1.5}" rx="10.25" fill="none" stroke="${t.ink}" stroke-opacity="0.32" stroke-width="1" opacity="${op}"/>`);
      parts.push(`<text x="${tx}" y="${yTop + Math.min(cardH * 0.5, 24)}" font-family="${ARABIC_FONT}" font-size="17" font-weight="800" fill="#2c2540" text-anchor="middle" direction="rtl" opacity="${op}">${esc(s.title)}</text>`);
      if (pale) {
        const tw2 = Math.min(subW - 18, s.title.length * 10 + 6);
        parts.push(`<line x1="${tx - tw2 / 2}" y1="${yTop + Math.min(cardH * 0.5, 24) - 5}" x2="${tx + tw2 / 2}" y2="${yTop + Math.min(cardH * 0.5, 24) - 5}" stroke="#2c2540" stroke-width="1.2" opacity="0.55"/>`);
      }
      if (cardH > 40 && n === 1) {
        parts.push(
          `<text x="${cx + 10}" y="${yTop + Math.min(cardH * 0.5, 24) + 19}" font-family="${ARABIC_FONT}" font-size="13" fill="#2c2540" fill-opacity="0.82" direction="rtl" opacity="${op}">${esc(time)}${s.room ? " · " + esc(s.room) : ""}${pale ? " · ملغاة" : ""}</text>`
        );
      }
    };

    // A cancelled class is drawn pale next to its replacement; if the slot
    // has no live session the cancelled one still shows, on its own.
    const cancelled = items.filter((s) => s.cancelled);
    const live = items.filter((s) => !s.cancelled);
    const order = [...live, ...cancelled];
    order.forEach((s, i) => draw(s, i, s.cancelled));
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" direction="rtl">
    <rect width="${w}" height="${h}" fill="#ffffff"/>
    <text x="${w / 2}" y="34" font-family="${ARABIC_FONT}" font-size="26" font-weight="700" fill="#2c2540" text-anchor="middle" direction="rtl">🗓 جدولي الأسبوعي</text>
    <text x="${w / 2}" y="62" font-family="${ARABIC_FONT}" font-size="16" fill="#8a8798" text-anchor="middle" direction="rtl">نفس ألوان وتخطيط المنصة — الحصص الملغاة باهتة</text>
    ${parts.join("")}
  </svg>`;
  const liveCount = all.filter((s) => !s.cancelled).length;
  return {
    png: await toPng(svg),
    caption: `🗓 جدولك الأسبوعي — ${liveCount} حصة فعلية (نفس ترتيب المنصة)`,
  };
}

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
