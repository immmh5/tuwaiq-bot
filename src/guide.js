// src/guide.js — illustrated setup guides, rendered as images
//
// The bot already draws the timetable as SVG, so a step-by-step guide uses
// the same engine rather than shipping a pile of static PNGs. Each step is
// one image: a title, a numbered instruction, and the action to take, laid
// out in the same visual language as the rest of the bot.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ARABIC_FONT = "Noto Sans Arabic, Noto Sans, sans-serif";
const __dirname = dirname(fileURLToPath(import.meta.url));

// Brand palette, matching the rest of the bot's cards.
const C = {
  bg: "#ffffff",
  text: "#2c2540",
  sub: "#8a8798",
  accent: "#7c5cbf",
  soft: "#efe9fb",
  good: "#35a37f",
  step: "#7c5cbf",
};

// Named images bundled with the bot. A step may point at one of these
// instead of drawing its own illustration.
const ASSETS = {
  mega_folder: join(__dirname, "..", "assets", "guide", "mega-folder.png"),
  mega_link: join(__dirname, "..", "assets", "guide", "mega-link.png"),
  mega_paste: join(__dirname, "..", "assets", "guide", "mega-paste.png"),
  identify: join(__dirname, "..", "assets", "guide", "identify.png"),
};

// One rendered step. Numbered badge, headline, body, and a closing hint.
function renderStep({ n, title, body, hint }) {
  const W = 900;
  const H = 560;
  const parts = [];

  // Header band with the step number.
  parts.push(`<rect x="0" y="0" width="${W}" height="96" fill="${C.soft}"/>`);
  parts.push(
    `<circle cx="64" cy="48" r="30" fill="${C.step}"/>`,
  );
  parts.push(
    `<text x="64" y="58" font-family="${ARABIC_FONT}" font-size="30" font-weight="800" fill="#ffffff" text-anchor="middle" direction="rtl">${n}</text>`,
  );
  parts.push(
    `<text x="116" y="58" font-family="${ARABIC_FONT}" font-size="28" font-weight="800" fill="${C.text}" direction="rtl">${esc(title)}</text>`,
  );

  // Body lines, wrapped by hand for control.
  const lines = String(body || "").split("\n");
  let y = 160;
  for (const ln of lines) {
    parts.push(
      `<text x="${W - 60}" y="${y}" font-family="${ARABIC_FONT}" font-size="24" fill="${C.text}" text-anchor="end" direction="rtl">${esc(ln)}</text>`,
    );
    y += 44;
  }

  if (hint) {
    const hy = H - 96;
    parts.push(`<rect x="60" y="${hy}" width="${W - 120}" height="64" rx="12" fill="#e2f4ec"/>`);
    parts.push(
      `<text x="${W - 84}" y="${hy + 40}" font-family="${ARABIC_FONT}" font-size="22" font-weight="700" fill="${C.good}" text-anchor="end" direction="rtl">✓ ${esc(hint)}</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" direction="rtl">
    <rect width="${W}" height="${H}" fill="${C.bg}"/>
    ${parts.join("\n")}
  </svg>`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// The MEGA setup walk-through. Each entry is one image the bot sends in
// order, so the student reads it like a slideshow.
const MEGA_STEPS = [
  {
    n: 1,
    title: "افتح MEGA وأنشئ مجلد",
    body: "افتح حسابك في MEGA\nواضغط New Folder\nوسمّه: طويق-نسخ-احتياطي",
    hint: "المجلد يكون فارغ — البوت يسوي الباقي",
  },
  {
    n: 2,
    title: "شارك المجلد برابط",
    body: "اضغط بزر الفأرة على المجلد\nاختر Get Link\nانسخ الرابط",
    hint: "تأكد إن الصلاحية: Read and write",
  },
  {
    n: 3,
    title: "أرسل الرابط للبوت",
    body: "انسخ الرابط ورسله هنا:\n/mega https://mega.nz/folder/xxx#key",
    hint: "البوت يحفظ الرابط بس — ما يخزن كلمة سرك",
  },
  {
    n: 4,
    title: "جرّب الكتابة",
    body: "اكتب:\n/mega test\nالبوت يرفع ملف تجريبي ويتأكد",
    hint: "بعدها /backup يصير يحفظ في مجلدك",
  },
];

// A bundled image for a step, if one exists; null otherwise.
export function stepImage(name) {
  try {
    return readFileSync(ASSETS[name] || ASSETS[Object.keys(ASSETS)[0]]);
  } catch {
    return null;
  }
}

export { MEGA_STEPS, renderStep };
