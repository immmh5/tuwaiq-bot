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

export async function toPng(svg, width = 1000) {
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

// Every image honours the same three choices the student sets once in the
// panel: text direction, whether group suffixes get trimmed, and whether the
// room shows. Renderers that never had a room just ignore that one.
//
// This used to be schedule-only; the panel still calls it "الجدول" but the
// values apply to every renderer, so a student who reads right-to-left in
// the table reads right-to-left everywhere.
export function imageOpts(opts = {}) {
  const direction = opts.direction === "ltr" ? "ltr" : "rtl";
  const cleanNames = opts.cleanNames !== false;
  const showRoom = opts.showRoom !== false;
  return { direction, rtl: direction === "rtl", cleanNames, showRoom };
}

// Strip the trailing group marker the platform appends to subject names.
// "احياء 2-1" → "احياء". Kept as a standalone helper because every renderer
// needs the same treatment, and a student who turns it off wants it off
// everywhere at once.
export function cleanSubjectName(t, cleanNames = true) {
  if (!cleanNames) return String(t ?? "");
  return String(t ?? "")
    .replace(/\s+\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?\s*$/, "")
    .replace(/\s+[-–]?\d+(?:\.\d+)?\s*$/, "")
    .trim();
}

// ---- Schedule image ---------------------------------------------------------
// ---- Schedule grid ----------------------------------------------------------
// Mirrors the platform's own timetable layout: days as columns, times as
// rows, a class placed in its slot and dimmed when cancelled. The site
// renders a substitution as two cards stacked in the same slot — the
// cancelled original pale, its replacement bold — and this reproduces that
// exactly, so the image is the page's grid and not a re-interpretation.
export async function renderScheduleGridImage(sessions, opts = {}) {
  const today = new Date().toISOString().slice(0, 10);
  // opts.orientation: "days_top" (the site's layout) or "days_left".
  // opts.showRoom: draw the room under each class.
  // opts.direction: "rtl" (Arabic, default) or "ltr" — which side the first
  //   day column starts from.
  // opts.cleanNames: strip the "2-1" group suffix from subject names.
  const orientation = opts.orientation === "days_left" ? "days_left" : "days_top";
  const showRoom = opts.showRoom !== false;
  const rtl = opts.direction !== "ltr";
  const cleanNames = opts.cleanNames !== false;
  const toMin = (t) => {
    const [h, m] = String(t || "0:0").split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const fmtSlot = (m) => {
    const h = Math.floor(m / 60);
    const mm = String(m % 60).padStart(2, "0");
    const ap = h >= 12 ? "م" : "ص";
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${hh}:${mm} ${ap}`;
  };
  const norm = (s) => ({
    ...s,
    day: String(s.date || "").slice(0, 10),
    startMin: toMin(s.startTime),
    endMin: toMin(s.endTime) || toMin(s.startTime) + 45,
  });
  // The platform appends a group suffix to most subject names — "احياء 2-1",
  // "اللغة الانجليزية 2-1" — which is noise in a one-student timetable. The
  // raw title field is worse ("احياء 2-1 - ثاني ثانوي 203"), so subjectName
  // is the source. This trims any trailing group marker in the forms the
  // platform uses, and leaves a subject that has no suffix untouched.
  const cleanTitle = (t) => {
    if (!cleanNames) return t;
    return String(t || "")
      // "احياء 2-1", "اللغة الانجليزية 2-1" → whole trailing token
      .replace(/\s+\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?\s*$/, "")
      // "احياء -1", "احياء 2" → lone suffix
      .replace(/\s+[-–]?\d+(?:\.\d+)?\s*$/, "")
      .trim();
  };
  // subjectName is the clean course name; title carries a section suffix
  // ("احياء 2-1 - ثاني ثانوي 203") that only gets in the way.
  const nameOf = (s) => cleanTitle(s.subject || s.subjectName || s.title || "");
  // The platform sends status capitalised ("Cancelled", "Pending"), so the
  // comparison is case-insensitive — a case-sensitive filter was letting
  // cancelled classes through and the student saw them in the table.
  const isCancelled = (s) =>
    String(s.status || (s.isCancelled ? "cancelled" : "")).toLowerCase() === "cancelled";
  const all = (sessions || []).filter((s) => !isCancelled(s)).map(norm);
  const days = [...new Set(all.map((s) => s.day))].sort();
  if (!days.length) days.push(today);

  // Slots are the real rows/columns of the table. The platform's week has a
  // fixed set of start times (7:00, 7:45, 8:30, 9:45 …) and every class
  // lands on one of them, so the grid is built from the distinct start
  // times actually present. The axis is then a label on each cell and can
  // never drift against the cards — which is what made the earlier
  // free-minute hour grid disagree with the classes beneath it.
  const slots = [...new Set(all.map((s) => s.startMin))].sort((a, b) => a - b);
  if (!slots.length) slots.push(7 * 60);

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
  const subjTint = new Map();
  for (const s of all) if (s.subject && !subjTint.has(s.subject)) subjTint.set(s.subject, subjTint.size);
  const colorFor = (s) => TINTS[(subjTint.get(s.subject) ?? 0) % TINTS.length];

  // Geometry. In days_top the X axis is days and the Y axis is slots;
  // days_left swaps them. Both share one cell math, so a card always sits
  // inside its cell and the header above it lines up exactly.
  const daysTop = orientation === "days_top";
  const nXAxis = daysTop ? days.length : slots.length;
  // Text direction. In rtl the first day (Sunday) sits at the right edge
  // and the week runs leftward, which is how the platform itself lays it
  // out. In ltr the first day is at the left.
  const colRank = (i) => (rtl ? nXAxis - 1 - i : i);
  const PAD = 26;
  const GUTTER = 76;
  const TITLE_H = 82;
  const HEAD_H = 52;
  const W = 1180;
  const nX = daysTop ? days.length : slots.length;
  const nY = daysTop ? slots.length : days.length;
  // Every cell gets the same height, so a day with many classes never
  // squeezes its cards shorter than their text.
  const ROW_H = 92;
  const gridH = ROW_H * nY;
  const h = TITLE_H + HEAD_H + gridH + PAD;

  // Direction is a real flip, not just column order. Every x below is
  // derived from these two edges, so the whole table — gutter, cards and
  // every label inside them — flips together and nothing is left stranded
  // off the canvas:
  //   rtl: the time gutter runs down the right edge, grid fills the rest
  //   ltr: the gutter is on the left, grid fills the rest
  const DIR = rtl ? "rtl" : "ltr";
  const gridX0 = rtl ? PAD : PAD + GUTTER;
  const gridX1 = rtl ? W - PAD - GUTTER : W - PAD;
  const gridW2 = gridX1 - gridX0;
  const cellW2 = gridW2 / nX;
  // The gutter's text edge: where a slot label's anchor sits. In rtl that
  // is the left edge of the gutter (label hangs left of the grid), in ltr
  // the right edge.
  const gutterTextX = rtl ? gridX1 + 12 : gridX0 - 12;
  const gutterAnchor = rtl ? "start" : "end";
  // Card text hugs the leading edge of its own card in the table's
  // direction, so a label never collides with the gutter.
  const textAnchor = rtl ? "end" : "start";
  const textX = (cx, pad) => (rtl ? cx + cellW2 - pad : cx + pad);

  const parts = [];

  // Axis labels, each centred on the cell it belongs to.
  if (daysTop) {
    for (let i = 0; i < days.length; i++) {
      const isToday = days[i] === today;
      const cx = gridX0 + colRank(i) * cellW2 + cellW2 / 2;
      if (isToday) parts.push(`<rect x="${cx - cellW2 / 2 + 2}" y="${TITLE_H}" width="${cellW2 - 6}" height="${HEAD_H - 8}" rx="10" fill="#7c5cbf1f"/>`);
      parts.push(`<text x="${cx}" y="${TITLE_H + 30}" font-family="${ARABIC_FONT}" font-size="19" font-weight="800" fill="${isToday ? "#7c5cbf" : "#2c2540"}" text-anchor="middle" direction="${DIR}">${esc(fmtDayName(days[i]).split(" ")[0])}</text>`);
    }
    for (let j = 0; j < slots.length; j++) {
      parts.push(`<text x="${gutterTextX}" y="${TITLE_H + HEAD_H + j * ROW_H + ROW_H / 2 + 5}" font-family="${ARABIC_FONT}" font-size="15" fill="#8a8798" text-anchor="${gutterAnchor}" direction="${DIR}">${fmtSlot(slots[j])}</text>`);
    }
  } else {
    for (let j = 0; j < slots.length; j++) {
      const cx = gridX0 + colRank(j) * cellW2 + cellW2 / 2;
      parts.push(`<text x="${cx}" y="${TITLE_H + 30}" font-family="${ARABIC_FONT}" font-size="15" fill="#8a8798" text-anchor="middle" direction="${DIR}">${fmtSlot(slots[j])}</text>`);
    }
    for (let i = 0; i < days.length; i++) {
      const isToday = days[i] === today;
      const ry = TITLE_H + HEAD_H + i * ROW_H;
      if (isToday) parts.push(`<rect x="${PAD}" y="${ry}" width="${W - PAD * 2}" height="${ROW_H - 4}" fill="#7c5cbf1f"/>`);
      parts.push(`<text x="${gutterTextX}" y="${ry + ROW_H / 2 + 6}" font-family="${ARABIC_FONT}" font-size="18" font-weight="800" fill="${isToday ? "#7c5cbf" : "#2c2540"}" text-anchor="${gutterAnchor}" direction="${DIR}">${esc(fmtDayName(days[i]).split(" ")[0])}</text>`);
    }
  }

  // Faint cell separators, behind the cards
  for (let i = 0; i <= nX; i++) {
    const lx = gridX0 + i * cellW2;
    parts.push(`<line x1="${lx}" y1="${TITLE_H + HEAD_H}" x2="${lx}" y2="${TITLE_H + HEAD_H + gridH}" stroke="rgba(124,92,191,.10)" stroke-width="1"/>`);
  }
  for (let j = 0; j <= nY; j++) {
    const ly = TITLE_H + HEAD_H + j * ROW_H;
    parts.push(`<line x1="${gridX0}" y1="${ly}" x2="${gridX1}" y2="${ly}" stroke="rgba(124,92,191,.10)" stroke-width="1"/>`);
  }

  // A cell holds its classes. Two real classes in one slot (the student
  // takes both هندسة and تطوير البرمجيات at 09:45 Sunday) stack inside
  // the cell, each keeping full cell width.
  const cellOf = (s) => {
    const di = days.indexOf(s.day);
    const si = slots.indexOf(s.startMin);
    // In days_top the day is the column, so direction applies to it. In
    // days_left the slot time is the column, so direction applies there.
    return daysTop ? { x: colRank(di), y: si } : { x: colRank(si), y: di };
  };
  const byCell = new Map();
  for (const s of all) {
    const c = cellOf(s);
    const k = `${c.x}|${c.y}`;
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push(s);
  }

  // Fit Arabic text inside a card. SVG has no automatic wrapping, so the
  // text is measured and split at word boundaries, then truncated with an
  // ellipsis if it still does not fit — this is what stopped names like
  // "تطوير البرمجيات" running past the card's edge.
  const charW = (fontSize) => fontSize * 0.52;
  const wrapText = (text, maxW, fontSize) => {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    for (const word of words) {
      const trial = cur ? cur + " " + word : word;
      if (trial.length * charW(fontSize) <= maxW || !cur) cur = trial;
      else { lines.push(cur); cur = word; }
    }
    if (cur) lines.push(cur);
    if (lines.length > 2) {
      lines[1] = lines[1].slice(0, Math.max(1, lines[1].length - 1)) + "…";
      lines.length = 2;
    }
    return lines;
  };

  for (const [, items] of byCell) {
    const c = cellOf(items[0]);
    const cx = gridX0 + c.x * cellW2;
    const cy0 = TITLE_H + HEAD_H + c.y * ROW_H;
    const n = items.length;
    const subH = n > 1 ? (ROW_H - 8 - (n - 1) * 6) / n : ROW_H - 8;

    const draw = (s, idx) => {
      const cy = cy0 + 4 + idx * (subH + 6);
      const t = colorFor(s);
      const innerW = cellW2 - 14;
      parts.push(`<rect x="${cx + 3}" y="${cy}" width="${innerW}" height="${subH}" rx="10" fill="${t.soft}"/>`);
      parts.push(`<rect x="${cx + 3.75}" y="${cy + 0.75}" width="${innerW - 1.5}" height="${subH - 1.5}" rx="9.25" fill="none" stroke="${t.ink}" stroke-opacity="0.32" stroke-width="1"/>`);

      const lines = wrapText(nameOf(s), innerW - 14, 15);
      const lineH = 19;
      const textTop = cy + (subH - lines.length * lineH) / 2 + 14;
      // Centred in the card, so no side is left empty regardless of
      // direction — a short name no longer clings to one edge.
      const centerX = cx + 3 + innerW / 2;
      lines.forEach((ln, li) => {
        parts.push(`<text x="${centerX}" y="${textTop + li * lineH}" font-family="${ARABIC_FONT}" font-size="15" font-weight="800" fill="#2c2540" text-anchor="middle" direction="${DIR}">${esc(ln)}</text>`);
      });
      if (showRoom && s.room && subH > 54 && n === 1) {
        parts.push(`<text x="${centerX}" y="${cy + subH - 10}" font-family="${ARABIC_FONT}" font-size="12" fill="#2c2540" fill-opacity="0.72" text-anchor="middle" direction="${DIR}">${esc(s.room)}</text>`);
      }
    };

    items.forEach((s, i) => draw(s, i));
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" direction="${DIR}">
    <rect width="${W}" height="${h}" fill="#ffffff"/>
    <text x="${W / 2}" y="38" font-family="${ARABIC_FONT}" font-size="26" font-weight="700" fill="#2c2540" text-anchor="middle" direction="${DIR}">🗓 جدولي الأسبوعي</text>
    <text x="${W / 2}" y="66" font-family="${ARABIC_FONT}" font-size="15" fill="#8a8798" text-anchor="middle" direction="${DIR}">جدولك الفعلي لهذا الأسبوع</text>
    ${parts.join("\n")}
  </svg>`;
  // Self-diagnosis: the renderer reports what it actually drew, so the bot
  // can sanity-check its own output instead of shipping a broken table and
  // waiting for the student to notice.
  const diag = { cells: byCell.size, stacked: 0, slots: slots.length, days: days.length };
  for (const [, items] of byCell) if (items.length > 1) diag.stacked++;
  const liveCount = all.length;
  const countWord =
    liveCount === 1 ? "حصة واحدة" : liveCount === 2 ? "حصتين" : `${liveCount} حصص`;
  // Provenance: the image is built from a live platform payload, and the
  // stamp says exactly when that payload was fetched, so the student can
  // see the data is fresh rather than taken from a stored snapshot.
  const stamp = new Date().toLocaleString("ar-SA", {
    timeZone: "Asia/Riyadh",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });
  return {
    png: await toPng(svg, 1600),
    caption: `🗓 جدولك الأسبوعي — ${countWord}\n🔄 من المنصة مباشرة · ${stamp}`,
    diag,
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

export async function renderScheduleImage(sessions, opts = {}) {
  const { rtl, cleanNames } = imageOpts(opts);
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
          fill="${isToday ? C.accent : C.text}" direction="${rtl ? "rtl" : "ltr"}">${esc(fmtDayName(day))}${isToday ? "  • اليوم" : ""}</text>
    <text x="${PAD + W - 20}" y="${y + 35}" font-family="${ARABIC_FONT}" font-size="20"
          fill="${C.sub}" text-anchor="end" direction="${rtl ? "rtl" : "ltr"}">${activeCount} حصة</text>`);
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
            fill="${C.text}" direction="${rtl ? "rtl" : "ltr"}">${esc(cleanSubjectName(s.title, cleanNames))}</text>
      <text x="${PAD + W - 290}" y="${y + 33}" font-family="${ARABIC_FONT}" font-size="19"
            fill="${C.sub}" text-anchor="end" direction="${rtl ? "rtl" : "ltr"}">${esc(room)}</text>
      <text x="${PAD + W - 22}" y="${y + 33}" font-family="${ARABIC_FONT}" font-size="19"
            fill="${C.sub}" text-anchor="end" direction="${rtl ? "rtl" : "ltr"}">${esc(time)}</text>`);
      if (s.replacedBy) {
        rows.push(`
        <text x="${PAD + 22}" y="${y + 66}" font-family="${ARABIC_FONT}" font-size="17"
              fill="${C.warn}" direction="${rtl ? "rtl" : "ltr"}">↩ استُبدلت بـ: ${esc(s.replacedBy)}</text>`);
      } else if (cancelled) {
        rows.push(`
        <text x="${PAD + 22}" y="${y + 33}" font-family="${ARABIC_FONT}" font-size="17"
              fill="${C.bad}" direction="${rtl ? "rtl" : "ltr"}">ملغاة</text>`);
      }
      y += h + 10;
    }
    y += 12;
  }

  const liveCount = slots.reduce((n, s) => n + (s.items.some((x) => x.status !== "cancelled") ? 1 : 0), 0);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${y}" direction="${rtl ? "rtl" : "ltr"}">
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
export async function renderAssignmentsImage(assignments, opts = {}) {
  const { rtl, cleanNames } = imageOpts(opts);
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
            fill="${C.text}" direction="${rtl ? "rtl" : "ltr"}">${esc(a.title)}</text>
      <text x="${PAD + 22}" y="${y + 52}" font-family="${ARABIC_FONT}" font-size="18"
            fill="${C.sub}" direction="${rtl ? "rtl" : "ltr"}">📚 ${esc(cleanSubjectName(a.subject, cleanNames) || "—")}${overdue ? "  • متأخر" : ""}</text>
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

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${Math.max(y, 200)}" direction="${rtl ? "rtl" : "ltr"}">
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
export async function renderGradesImage(grades, opts = {}) {
  const { rtl, cleanNames } = imageOpts(opts);
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
          fill="${C.sub}" direction="${rtl ? "rtl" : "ltr"}">📚 ${esc(cleanSubjectName(g.subject, cleanNames) || "—")}</text>
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

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${Math.max(y, 240)}" direction="${rtl ? "rtl" : "ltr"}">
    <rect width="1000" height="${Math.max(y, 240)}" fill="${C.bg}"/>
    ${header("🏆 الدرجات", `${grades.length} درجة`)}
    ${rows.join("")}
  </svg>`;
  return { png: await toPng(svg), caption: `🏆 درجاتك (${grades.length})` };
}

// ---- Exams image --------------------------------------------------------------
// Exams are few and far between, so the card leads with the countdown and
// puts the date and duration underneath — the question the student is
// actually asking is "how much time do I have left", not "what is this exam".
export async function renderExamsImage(exams, opts = {}) {
  const { rtl, cleanNames } = imageOpts(opts);
  const PAD = 32;
  const W = 1000 - PAD * 2;
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  const upcoming = (exams || [])
    .filter((e) => e.startsAt && new Date(e.startsAt).getTime() > now)
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());

  let y = 140;
  const rows = [];
  for (const e of upcoming.slice(0, 10)) {
    const start = new Date(e.startsAt).getTime();
    const days = Math.ceil((start - now) / DAY_MS);
    const label = days <= 1 ? "باقي أقل من يوم" : days === 2 ? "باقي يومين" : `باقي ${days} يوم`;
    const urgent = days <= 2 ? C.bad : days <= 7 ? C.warn : C.good;

    rows.push(`
    <rect x="${PAD}" y="${y}" width="${W}" height="86" rx="12" fill="${C.cardAlt}"/>
    <rect x="${PAD}" y="${y}" width="6" height="86" rx="3" fill="${urgent}"/>
    <text x="${PAD + 22}" y="${y + 34}" font-family="${ARABIC_FONT}" font-size="24" font-weight="700"
          fill="${C.text}" direction="${rtl ? "rtl" : "ltr"}">${esc(e.title || "اختبار")}</text>
    <text x="${PAD + 22}" y="${y + 66}" font-family="${ARABIC_FONT}" font-size="19"
          fill="${C.sub}" direction="${rtl ? "rtl" : "ltr"}">📚 ${esc(cleanSubjectName(e.subject, cleanNames) || "—")}  •  ⏱ ${esc(String(e.durationMin || "—"))} دقيقة</text>
    <text x="${PAD + W - 22}" y="${y + 36}" font-family="${ARABIC_FONT}" font-size="20" font-weight="700"
          fill="${urgent}" text-anchor="end" direction="${rtl ? "rtl" : "ltr"}">${esc(label)}</text>
    <text x="${PAD + W - 22}" y="${y + 66}" font-family="${ARABIC_FONT}" font-size="17"
          fill="${C.sub}" text-anchor="end" direction="${rtl ? "rtl" : "ltr"}">${esc(fmtDayName(e.startsAt))}</text>`);
    y += 100;
  }
  if (!upcoming.length) {
    rows.push(`
    <rect x="${PAD}" y="${y}" width="${W}" height="80" rx="12" fill="${C.cardAlt}"/>
    <text x="500" y="${y + 48}" font-family="${ARABIC_FONT}" font-size="22" font-weight="600"
          fill="${C.sub}" text-anchor="middle" direction="rtl">ما في اختبارات قادمة — ارتاح</text>`);
    y += 94;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${Math.max(y, 200)}" direction="${rtl ? "rtl" : "ltr"}">
    <rect width="1000" height="${Math.max(y, 200)}" fill="${C.bg}"/>
    ${header("📄 الاختبارات", `${upcoming.length} اختبار قادم`)}
    ${rows.join("")}
  </svg>`;
  return { png: await toPng(svg), caption: `📄 ${upcoming.length} اختبار قادم` };
}

// ---- Materials image -----------------------------------------------------------
// Materials are the longest list on the platform, so the image shows the most
// recent ones with their type — the student is usually looking for "that file
// the teacher just uploaded", not the whole bibliography.
export async function renderMaterialsImage(materials, opts = {}) {
  const { rtl, cleanNames } = imageOpts(opts);
  const PAD = 32;
  const W = 1000 - PAD * 2;
  let y = 140;
  const rows = [];
  for (const m of (materials || []).slice(0, 12)) {
    const icon = String(m.contentType || "").match(/pdf|file|doc/i) ? "📎" : "🎬";
    rows.push(`
    <rect x="${PAD}" y="${y}" width="${W}" height="70" rx="10" fill="${C.cardAlt}"/>
    <rect x="${PAD}" y="${y}" width="6" height="70" rx="3" fill="${C.accent}"/>
    <text x="${PAD + 22}" y="${y + 32}" font-family="${ARABIC_FONT}" font-size="21" font-weight="600"
          fill="${C.text}" direction="${rtl ? "rtl" : "ltr"}">${esc(m.title || "مادة")}</text>
    <text x="${PAD + 22}" y="${y + 56}" font-family="${ARABIC_FONT}" font-size="17"
          fill="${C.sub}" direction="${rtl ? "rtl" : "ltr"}">📚 ${esc(cleanSubjectName(m.subject, cleanNames) || "—")}</text>
    <text x="${PAD + W - 22}" y="${y + 34}" font-family="${ARABIC_FONT}" font-size="18"
          fill="${C.sub}" text-anchor="end" direction="${rtl ? "rtl" : "ltr"}">${icon} ${esc(String(m.contentType || "ملف"))}</text>`);
    y += 82;
  }
  if (!rows.length) {
    rows.push(`
    <rect x="${PAD}" y="${y}" width="${W}" height="80" rx="12" fill="${C.cardAlt}"/>
    <text x="500" y="${y + 48}" font-family="${ARABIC_FONT}" font-size="22" font-weight="600"
          fill="${C.sub}" text-anchor="middle" direction="rtl">ما في مواد جديدة</text>`);
    y += 94;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${Math.max(y, 200)}" direction="${rtl ? "rtl" : "ltr"}">
    <rect width="1000" height="${Math.max(y, 200)}" fill="${C.bg}"/>
    ${header("📚 المواد", `${(materials || []).length} مادة`)}
    ${rows.join("")}
  </svg>`;
  return { png: await toPng(svg), caption: `📚 ${(materials || []).length} مادة` };
}

// ---- Notifications image -------------------------------------------------------
// The notification list is what the platform's bell shows; the image keeps
// unread ones on top and marks them, so a glance answers "what did I miss".
export async function renderNotificationsImage(notifications, opts = {}) {
  const { rtl, cleanNames } = imageOpts(opts);
  const PAD = 32;
  const W = 1000 - PAD * 2;
  const list = (notifications || []).slice(0, 10);
  let y = 140;
  const rows = [];
  for (const n of list) {
    const unread = n.read === false || n.isRead === false;
    rows.push(`
    <rect x="${PAD}" y="${y}" width="${W}" height="74" rx="10" fill="${C.cardAlt}"/>
    <rect x="${PAD}" y="${y}" width="6" height="74" rx="3" fill="${unread ? C.accent : C.line}"/>
    <text x="${PAD + 22}" y="${y + 32}" font-family="${ARABIC_FONT}" font-size="21" font-weight="${unread ? "700" : "500"}"
          fill="${C.text}" direction="${rtl ? "rtl" : "ltr"}">${esc(n.title || "إشعار")}${unread ? "  •" : ""}</text>
    <text x="${PAD + 22}" y="${y + 58}" font-family="${ARABIC_FONT}" font-size="16"
          fill="${C.sub}" direction="${rtl ? "rtl" : "ltr"}">${esc(String(n.body || "").slice(0, 90))}</text>`);
    y += 86;
  }
  if (!rows.length) {
    rows.push(`
    <rect x="${PAD}" y="${y}" width="${W}" height="80" rx="12" fill="${C.cardAlt}"/>
    <text x="500" y="${y + 48}" font-family="${ARABIC_FONT}" font-size="22" font-weight="600"
          fill="${C.sub}" text-anchor="middle" direction="rtl">ما في إشعارات</text>`);
    y += 94;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${Math.max(y, 200)}" direction="${rtl ? "rtl" : "ltr"}">
    <rect width="1000" height="${Math.max(y, 200)}" fill="${C.bg}"/>
    ${header("🔔 الإشعارات", `${list.length} أحدث إشعار`)}
    ${rows.join("")}
  </svg>`;
  return { png: await toPng(svg), caption: `🔔 ${list.length} إشعار` };
}
