// src/html-shot.js — capture platform pages as images.
//
// Two strategies, in order of preference:
//   1. Playwright/Chromium when a browser is available (renders the real
//      page with all its CSS, so the screenshot looks exactly like the site).
//   2. A bundled SVG fallback that re-lays the data out by hand.
//
// On Render's free 512MB tier Chromium is too heavy to install, so the SVG
// path is what actually runs in production; the browser path exists for
// local/dev and for any future upgrade.

import { renderScheduleImage, renderAssignmentsImage, renderGradesImage } from "./images.js";

let _browser = null;
let _playwrightTried = false;

async function getBrowser() {
  if (_playwrightTried) return _browser;
  _playwrightTried = true;
  try {
    const { chromium } = await import("playwright");
    _browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  } catch {
    _browser = null;
  }
  return _browser;
}

// Map a friendly scope name to the on-platform URL the student would visit.
const SCOPE_URL = {
  schedule: "/student/schedule",
  assignments: "/student/assignments",
  grades: "/student/assignments",
  materials: "/student/materials",
  exams: "/student/exams",
  attendance: "/student/attendance",
  courses: "/student/courses",
};

// Try a real browser screenshot first; fall back to the SVG renderer.
// Returns { png, caption, method } so the caller can say how it was made.
export async function captureScope(scope, data, { baseUrl, cookies } = {}) {
  const browser = await getBrowser();
  if (browser && baseUrl && cookies) {
    try {
      const page = await browser.newPage({
        viewport: { width: 1200, height: 900 },
        deviceScaleFactor: 2,
      });
      await page.context().addCookies(cookies);
      await page.goto(`${baseUrl}${SCOPE_URL[scope] || "/dashboard"}`, {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      // Hide the chatbot itself and the header chrome for a clean shot.
      await page.addStyleTag({
        content: `.page-header, footer, .sidebar-wrapper, .Toastify { display: none !important; }`,
      });
      const el = (await page.$(".sc-page")) || (await page.$(".page-body")) || (await page.$("body"));
      const png = await el.screenshot({ type: "png" });
      await page.close();
      return { png, caption: `🖼 ${scope} — لقطة من المنصة`, method: "browser" };
    } catch {
      // fall through to SVG
    }
  }
  const out =
    scope === "schedule"
      ? await renderScheduleImage(data)
      : scope === "assignments"
      ? await renderAssignmentsImage(data)
      : await renderGradesImage(data);
  return { ...out, method: "svg" };
}
