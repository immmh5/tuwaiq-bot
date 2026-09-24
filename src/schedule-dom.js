// src/schedule-dom.js — render the platform's own timetable markup to a PNG.
//
// The student asked for the schedule image to be *the site's table*, not our
// reinterpretation of it. So instead of reshaping API data, this parses the
// real /student/schedule HTML — the exact `.tt` grid the student pasted — and
// redraws it with the platform's own palette and typography extracted from
// the shipped CSS bundle:
//
//   data-tint 0..5  →  --eqc-ink / --eqc-soft pairs (per-subject colours)
//   .tt-class       →  ink @16% fill, ink @32% inset border, 11px radius
//   .is-cancelled   →  opacity .52, subject line struck through
//   .is-live        →  #2e9d78 ring
//
// Colours are hard-coded from the live stylesheet so the image matches the
// page without shipping or re-fetching CSS at runtime.

import { renderAsync } from "@resvg/resvg-js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, "..", "assets", "fonts");

// The platform's own subject colours, lifted verbatim from its CSS.
const TINT = {
  0: { ink: "#8b6cd9", soft: "#efe9fb" },
  1: { ink: "#35a37f", soft: "#e2f4ec" },
  2: { ink: "#e07a6a", soft: "#fdeae7" },
  3: { ink: "#4a8fd4", soft: "#e7f1fc" },
  4: { ink: "#cf9a2c", soft: "#fbf2da" },
  5: { ink: "#a05fb5", soft: "#f6ebf9" },
};
const LIVE_RING = "#2e9d78";
const DAY_NAMES = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];

const esc = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

// --- HTML scraping ----------------------------------------------------------

// Parse the `.tt-wrap` block straight out of the page HTML. The grid is
// server-rendered into #root, so one authenticated GET is enough — no JS.
export function parseScheduleHTML(html) {
  const wrap = html.match(/<div class="tt-wrap"[^>]*>([\s\S]*?)<\/div><\/div><\/div>/);
  const root = wrap ? wrap[0] : html;

  const out = { days: [], classes: [] };

  // Day headers carry the day name and date; .is-today marks the current day.
  for (const m of root.matchAll(/<div class="tt-dhead( is-today)?"[^>]*>\s*<div class="tt-dhead-day"[^>]*>([^<]+)<\/div>\s*<div class="tt-dhead-date"[^>]*>([^<]+)<\/div>/g)) {
    out.days.push({ name: m[2].trim(), date: m[3].trim(), isToday: !!m[1] });
  }

  // Each column is a day; within it every .tt-class is absolutely positioned
  // with `top`/`height` in px, carrying subject, time, room, tint and state.
  const cols = [...root.matchAll(/<div class="tt-col( is-today)?"[^>]*>([\s\S]*?)<\/div>\s*(?=<div class="tt-col|<\/div>\s*<\/div>)/g)];
  for (let ci = 0; ci < cols.length; ci++) {
    const colHTML = cols[ci][2];
    for (const c of colHTML.matchAll(/<div class="tt-class([^"]*)"[^>]*data-tint="(\d+)"[^>]*title="([^"]*)"[^>]*style="top:\s*([\d.]+)px;\s*height:\s*([\d.]+)px;"[^>]*>\s*<span class="tt-class-subj"[^>]*>([^<]+)<\/span>(?:\s*<span class="tt-class-meta"[^>]*>([^<]*)<\/span>)?/g)) {
      const meta = (c[7] || "").trim();
      out.classes.push({
        col: ci,
        cls: c[1].trim(),
        tint: Number(c[2]),
        title: c[3].trim(),
        top: Number(c[4]),
        height: Number(c[5]),
        subj: c[6].trim(),
        meta,
        cancelled: c[1].includes("is-cancelled"),
        live: c[1].includes("is-live"),
        done: c[1].includes("is-done"),
        upcoming: c[1].includes("is-upcoming"),
      });
    }
  }

  const axis = [...root.matchAll(/<div class="tt-hour"><span[^>]*>([^<]+)<\/span><\/div>/g)].map((m) => m[1].trim());
  out.axis = axis;

  // Week range for the header strip, when present.
  const wr = html.match(/<span class="ss-weeknav-range"[^>]*>([^<]+)<\/span>/);
  out.weekRange = wr ? wr[1].trim() : null;

  // "الآن" strip — the live class banner.
  const now = html.match(/<span bf="" dir="rtl">جارية الآن:\s*<strong[^>]*>([^<]+)<\/strong>[^<]*<\/span>/);
  out.nowText = now ? now[1].trim() : null;

  return out;
}

// --- Rendering --------------------------------------------------------------

export async function renderSiteSchedule(parsed, { width = 1080 } = {}) {
  const { days, classes, axis, weekRange, nowText } = parsed;
  const nCols = Math.max(days.length, 1);

  // Geometry mirrors the page: axis gutter, header row, then slot rows.
  const PAD = 18;
  const AXIS_W = 74;
  const HEAD_H = 62;
  const gridW = width - PAD * 2 - AXIS_W;
  const colW = gridW / nCols;

  // Row pitch: the site uses 45-min slots at 67.5px; we scale px → our height.
  const maxTop = classes.reduce((m, c) => Math.max(m, c.top + c.height), 540);
  const scale = (maxTop > 0 ? 1 : 1) * 1; // keep the page's own pixel space
  const gridH = Math.ceil(maxTop * scale) + 8;
  const height = HEAD_H + gridH + (nowText ? 44 : 0) + 96;

  const parts = [];
  let y0 = 96;

  // Header strip
  parts.push(`<text x="${width/2}" y="34" font-family="Noto Sans Arabic, Noto Sans, sans-serif" font-size="26" font-weight="700" fill="#2c2540" text-anchor="middle" direction="rtl">🗓 جدولي الأسبوعي</text>`);
  if (weekRange) {
    parts.push(`<text x="${width/2}" y="62" font-family="Noto Sans Arabic, Noto Sans, sans-serif" font-size="17" fill="#8a8798" text-anchor="middle" direction="rtl">${esc(weekRange)}</text>`);
  }

  // Day headers
  for (let i = 0; i < days.length; i++) {
    const x = PAD + AXIS_W + i * colW;
    if (days[i].isToday) {
      parts.push(`<rect x="${x}" y="${y0}" width="${colW}" height="${HEAD_H - 4}" fill="#7c5cbf1f"/>`);
    }
    parts.push(`<line x1="${x}" y1="${y0 + HEAD_H - 4}" x2="${x + colW}" y2="${y0 + HEAD_H - 4}" stroke="rgba(124,92,191,.14)" stroke-width="1"/>`);
    parts.push(`<text x="${x + colW/2}" y="${y0 + 24}" font-family="Noto Sans Arabic, Noto Sans, sans-serif" font-size="18" font-weight="800" fill="#2c2540" text-anchor="middle" direction="rtl">${esc(days[i].name)}</text>`);
    parts.push(`<text x="${x + colW/2}" y="${y0 + 44}" font-family="Noto Sans Arabic, Noto Sans, sans-serif" font-size="14" fill="#8a8798" text-anchor="middle" direction="rtl">${esc(days[i].date)}</text>`);
  }

  // Hour rows: the page labels 7ص..12م spaced evenly; reproduce that grid.
  const rowH = axis.length > 1 ? (gridH - 8) / (axis.length - 1) : gridH;
  for (let i = 0; i < axis.length; i++) {
    const y = y0 + HEAD_H + (axis.length > 1 ? i * rowH : 0);
    parts.push(`<line x1="${PAD + AXIS_W}" y1="${y}" x2="${width - PAD}" y2="${y}" stroke="rgba(124,92,191,.08)" stroke-width="1"/>`);
    parts.push(`<text x="${PAD + AXIS_W - 12}" y="${y + 6}" font-family="Noto Sans Arabic, Noto Sans, sans-serif" font-size="15" fill="#8a8798" text-anchor="end" direction="rtl">${esc(axis[i])}</text>`);
  }

  // Class cards, in the page's own positions and palette.
  for (const c of classes) {
    const x = PAD + AXIS_W + c.col * colW + 4;
    const y = y0 + HEAD_H + c.top * scale;
    const w = colW - 8;
    const h = c.height * scale;
    const t = TINT[c.tint] || TINT[0];
    const opacity = c.cancelled ? 0.52 : 1;

    let card = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="11" fill="${t.soft}" opacity="${opacity}"/>`;
    // ink @32% inset ring, like the page's box-shadow
    card += `<rect x="${x + 0.75}" y="${y + 0.75}" width="${w - 1.5}" height="${h - 1.5}" rx="10.25" fill="none" stroke="${t.ink}" stroke-opacity="0.32" stroke-width="1" opacity="${opacity}"/>`;
    // live classes get the green pulse ring
    if (c.live) {
      card += `<rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${h - 2}" rx="10" fill="none" stroke="${LIVE_RING}" stroke-width="1.5" opacity="${opacity}"/>`;
    }
    parts.push(card);

    const subjY = y + Math.min(h * 0.46, 26);
    parts.push(`<text x="${x + 9}" y="${subjY}" font-family="Noto Sans Arabic, Noto Sans, sans-serif" font-size="16" font-weight="800" fill="#2c2540" direction="rtl" opacity="${opacity}">${esc(c.subj)}</text>`);
    // cancelled subjects are struck through on the page
    if (c.cancelled) {
      const tw = Math.min(w - 18, c.subj.length * 9.5 + 6);
      parts.push(`<line x1="${x + 9}" y1="${subjY - 4}" x2="${x + 9 + tw}" y2="${subjY - 4}" stroke="#2c2540" stroke-width="1.2" opacity="0.55"/>`);
    }
    if (c.meta && h > 34) {
      parts.push(`<text x="${x + 9}" y="${subjY + 19}" font-family="Noto Sans Arabic, Noto Sans, sans-serif" font-size="13" fill="#2c2540" fill-opacity="0.82" direction="rtl" opacity="${opacity}">${esc(c.meta)}</text>`);
    }
  }

  // Live-class banner, reproducing the page's "جارية الآن" strip.
  if (nowText) {
    const by = y0 + HEAD_H + gridH + 14;
    parts.push(`<rect x="${PAD + AXIS_W}" y="${by}" width="${gridW}" height="34" rx="17" fill="#e2f4ec"/>`);
    parts.push(`<circle cx="${PAD + AXIS_W + 20}" cy="${by + 17}" r="5" fill="#2e9d78"/>`);
    parts.push(`<text x="${PAD + AXIS_W + 36}" y="${by + 23}" font-family="Noto Sans Arabic, Noto Sans, sans-serif" font-size="15" font-weight="700" fill="#1f6b52" direction="rtl">جارية الآن: ${esc(nowText)}</text>`);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" direction="rtl">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    ${parts.join("\n")}
  </svg>`;

  const fontFiles = [
    path.join(FONT_DIR, "NotoSansArabic-Regular.ttf"),
    path.join(FONT_DIR, "NotoSansArabic-Bold.ttf"),
  ];
  const img = await renderAsync(svg, {
    background: "#ffffff",
    font: { fontFiles, loadSystemFonts: true, defaultFontFamily: "Noto Sans Arabic" },
    fitTo: { mode: "width", value: width },
  });
  return { png: img.asPng(), svg };
}
