// src/watcher.js — polling engine: fetches everything, diffs against the store, notifies
import {
  getMyAssignments,
  getMyMaterials,
  getAvailableAttempts,
  getGrades,
  getStudentHome,
  normalizeAssignments,
  normalizeMaterials,
  normalizeExams,
  normalizeGrades,
} from "./tuwaiq.js";

import * as auth from "./auth.js";
import { sendMessage, escapeHtml } from "./telegram.js";
import {
  getTokens,
  saveTokens,
  getSeenIds,
  markSeen,
  getKv,
  setKv,
  pruneSeen,
} from "./store.js";

const normalize = {
  assignments: normalizeAssignments,
  materials: normalizeMaterials,
  exams: normalizeExams,
  grades: normalizeGrades,
};

const SCOPES = ["assignments", "materials", "exams", "grades"];

let running = false;
let lastCheck = null;
let lastError = null;
let consecutiveFailures = 0;
let lastLoginAt = 0;

export function getWatcherState() {
  return { running, lastCheck, lastError, consecutiveFailures };
}

// --- token plumbing -----------------------------------------------------------

// Clears stored tokens so the next check does a fresh login. Used whenever an
// API call suggests the token is no longer usable.
async function invalidateTokens() {
  await saveTokens(null);
}

async function ensureValidTokens() {
  let tokens = await getTokens();
  const now = Math.floor(Date.now() / 1000);

  if (tokens?.refreshToken && tokens.refreshExpiresAt > now + 60) {
    // access token expired (or about to) but refresh still valid
    if (!tokens.accessToken || tokens.accessExpiresAt <= now + 60) {
      try {
        tokens = await auth.refresh(tokens.refreshToken);
        await saveTokens(tokens);
      } catch (err) {
        console.log("refresh failed, doing full login:", err.message);
        tokens = null;
      }
    }
  } else {
    tokens = null;
  }

  if (!tokens?.accessToken) {
    const creds = await getKv("credentials", null);
    if (!creds) throw new Error("not logged in — open the login page first");

    // Throttle re-login attempts so a persistent failure can't hammer Keycloak
    const sinceLast = Date.now() - lastLoginAt;
    if (lastLoginAt && sinceLast < 60_000) {
      throw new Error(`login loop guard: last attempt ${Math.round(sinceLast / 1000)}s ago`);
    }
    lastLoginAt = Date.now();

    tokens = await auth.login(creds.username, creds.password);
    await saveTokens(tokens);
  }

  return tokens.accessToken;
}

// --- main check ---------------------------------------------------------------

export async function runCheckOnce() {
  if (running) return { skipped: true };
  running = true;
  try {
    let accessToken = await ensureValidTokens();
    const config = await getKv("watch_config", {
      assignments: true,
      materials: true,
      exams: true,
      grades: true,
    });

    const fetchers = {
      assignments: () => getMyAssignments(accessToken),
      materials: () => getMyMaterials(accessToken),
      exams: () => getAvailableAttempts(accessToken),
      grades: () => getGrades(accessToken),
    };

    const results = {};
    for (const scope of Object.keys(fetchers)) {
      if (!config[scope]) continue;
      try {
        results[scope] = normalize[scope](await fetchers[scope]());
      } catch (err) {
        // A bad/expired token surfaces as a 500 from this backend. Drop the
        // tokens and let the next cycle log in fresh rather than failing hard.
        if (/HTTP (401|500)|auth\/token problem/.test(err.message)) {
          console.log(`${scope}: token looks invalid, invalidating`);
          await invalidateTokens();
          accessToken = await ensureValidTokens();
          try {
            results[scope] = normalize[scope](await fetchers[scope]());
          } catch (err2) {
            lastError = `${scope}: ${err2.message}`;
            console.error(`${scope} retry failed:`, err2.message);
          }
        } else {
          lastError = `${scope}: ${err.message}`;
          console.error(`${scope} failed:`, err.message);
        }
      }
    }

    const fresh = await collectFreshItems(results);
    await notifyFresh(fresh);

    lastCheck = new Date().toISOString();
    lastError = null;
    consecutiveFailures = 0;

    // Identify who is logged in (for /who and the health page)
    const parsed = auth.decodeToken(accessToken);
    if (parsed) {
      await setKv("identity", {
        name: parsed.name || parsed.given_name || null,
        email: parsed.email || parsed.preferred_username || null,
        studentId: parsed.student_id || null,
        loggedAt: new Date().toISOString(),
      });
    }

    await pruneSeen();
    return { ok: true, counts: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.length])), fresh: fresh.length };
  } catch (err) {
    lastError = err.message;
    consecutiveFailures++;
    console.error("check failed:", err.message);
    if (consecutiveFailures >= 3) {
      await notifyOwner(
        "⚠️ <b>فشل الفحص ٣ مرات متتالية</b>\n" +
          `<code>${escapeHtml(err.message)}</code>\n\n` +
          "افحص الـ logs أو سجل دخول من جديد: <code>/logout</code> ثم افتح صفحة الدخول."
      ).catch(() => {});
      consecutiveFailures = 0;
    }
    return { ok: false, error: err.message };
  } finally {
    running = false;
  }
}

// Returns only items we have never seen before (per persistent id)
async function collectFreshItems(results) {
  const fresh = [];
  for (const [scope, items] of Object.entries(results)) {
    if (!items?.length) continue;
    const ids = items.map((i) => i.id);
    const seen = await getSeenIds(ids);
    for (const item of items) {
      if (!seen.has(item.id)) fresh.push({ scope, item });
    }
  }
  return fresh;
}

async function notifyFresh(fresh) {
  if (!fresh.length) return;
  const config = await getKv("watch_config", {});
  const lines = [];
  for (const { scope, item } of fresh) {
    lines.push(formatItem(scope, item));
    await markSeen(item); // mark before sending so a crash never re-notifies
  }
  // Chunk to respect Telegram's 4096 char limit
  const chunks = chunkLines(lines, 3500);
  for (const chunk of chunks) {
    await notifyOwner(chunk);
  }
}

function chunkLines(lines, maxChars) {
  const chunks = [];
  let cur = "";
  for (const line of lines) {
    if ((cur + "\n\n" + line).length > maxChars) {
      chunks.push(cur);
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function formatItem(scope, item) {
  const icons = { assignment: "📝", material: "📚", exam: "📄", grade: "🎯" };
  const scopeNames = {
    assignment: "واجب جديد",
    material: "مادة تعليمية جديدة",
    exam: "اختبار متاح",
    grade: "نتيجة جديدة",
  };
  const parts = [`${icons[scope] || "🔔"} <b>${scopeNames[scope] || "جديد"}</b>`];
  if (item.title) parts.push(`<b>${escapeHtml(item.title)}</b>`);
  if (item.subject) parts.push(`📚 ${escapeHtml(item.subject)}`);
  if (item.teacher) parts.push(`👨‍🏫 ${escapeHtml(item.teacher)}`);

  if (scope === "assignment") {
    if (item.dueAt) parts.push(`⏰ الاستحقاق: <code>${fmtDate(item.dueAt)}</code>`);
    if (item.isOverdue) parts.push("🔴 متأخر");
    else if (item.isDueSoon) parts.push("🟡 مستحق قريبًا");
    if (item.maxPoints != null) parts.push(`💰 الدرجة: ${item.maxPoints}`);
  }
  if (scope === "material") {
    if (item.contentType) parts.push(`🗂 النوع: ${item.contentType}`);
    if (item.externalUrl) parts.push(`🔗 <a href="${escapeHtml(item.externalUrl)}">رابط</a>`);
  }
  if (scope === "exam") {
    if (item.startsAt) parts.push(`▶️ يبدأ: <code>${fmtDate(item.startsAt)}</code>`);
    if (item.endsAt) parts.push(`⏹ ينتهي: <code>${fmtDate(item.endsAt)}</code>`);
    if (item.durationMin) parts.push(`⏱ المدة: ${item.durationMin} دقيقة`);
  }
  if (scope === "grade") {
    if (item.score != null && item.maxScore != null) {
      parts.push(`🎯 الدرجة: <b>${item.score} / ${item.maxScore}</b>`);
    } else if (item.score != null) {
      parts.push(`🎯 الدرجة: <b>${item.score}</b>`);
    }
    if (item.status) parts.push(`الحالة: ${item.status}`);
  }
  parts.push(`🔗 <a href="${item.url}">فتح في طويق</a>`);
  return parts.join("\n");
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("ar-SA", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Riyadh",
    });
  } catch {
    return iso;
  }
}

export async function notifyOwner(text) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.log("TELEGRAM_CHAT_ID not set; skipping notification");
    return;
  }
  await sendMessage(chatId, text);
}

// --- scheduler ----------------------------------------------------------------

let timer = null;

export function startWatcher() {
  if (timer) return;
  const intervalMin = Math.max(5, Math.min(120, Number(process.env.CHECK_INTERVAL_MIN) || 10));
  const run = async () => {
    try {
      await runCheckOnce();
    } catch (err) {
      console.error("scheduled check error:", err.message);
    }
  };
  // Fire immediately on boot, then on the interval
  setTimeout(run, 5000);
  timer = setInterval(run, intervalMin * 60 * 1000);
  console.log(`watcher started (every ${intervalMin} min)`);
}

export function stopWatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}
