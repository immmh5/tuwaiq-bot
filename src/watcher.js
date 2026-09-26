// src/watcher.js — polling engine: fetches everything, diffs against the store, notifies
import {
  getMyAssignments,
  getMyMaterials,
  getAvailableAttempts,
  getGrades,
  getMyGrades,
  getStudentHome,
  getMyCourses,
  getMySchedule,
  getNotifications,
  normalizeAssignments,
  normalizeMaterials,
  normalizeExams,
  normalizeGrades,
  normalizeNotifications,
  normalizeSchedule,
  normalizeCourses,
} from "./tuwaiq.js";

import * as auth from "./auth.js";
import { sendMessage, escapeHtml } from "./telegram.js";
import { fmtDate } from "./format.js";
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

let running = false;   // is the scheduler itself up?
let checking = false;  // is a check in flight? (re-entry guard)
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

// Shared scope fetcher used both by the periodic check and the /list Telegram
// commands. Returns normalised items for one scope, retrying once with fresh
// tokens when the backend rejects the JWT.
export async function fetchScope(scope, accessToken) {
  // Each entry is an async fn returning already-normalised items.
  const fetchers = {
    assignments: async (t) => normalizeAssignments(await getMyAssignments(t)),
    materials: async (t) => normalizeMaterials(await getMyMaterials(t)),
    exams: async (t) => normalizeExams(await getAvailableAttempts(t)),
    // /grades is teacher-only (403 for students); grades are derived from
    // assignments + exam attempts instead.
    grades: async (t) => await getMyGrades(t),
    notifications: async (t) => normalizeNotifications(await getNotifications(t)),
    // /subjectofferings/my-courses and /my-schedule return {courses} and
    // {sessions} respectively (verified in the frontend bundles).
    courses: async (t) => normalizeCourses(await getMyCourses(t)),
    schedule: async (t) => normalizeSchedule(await getMySchedule(t)),
    home: async (t) => await getStudentHome(t),
  };
  const fn = fetchers[scope];
  if (!fn) throw new Error(`unknown scope: ${scope}`);
  try {
    return await fn(accessToken);
  } catch (err) {
    if (/HTTP (401|500)|auth\/token problem/.test(err.message)) {
      await invalidateTokens();
      const fresh = await ensureValidTokens();
      return await fn(fresh);
    }
    throw err;
  }
}

// --- one place everything announces through ---------------------------------
//
// Without this, a single check cycle sends up to four separate messages: one
// per fresh item batch, one per deadline milestone, and whatever the scheduler
// wants to say. Collected here and flushed once, the student reads one
// notification instead of a burst, and the ordering is deterministic.
let pendingQueue = [];
let flushTimer = null;
let flushing = false;

export function queueNotify(text) {
  if (!text) return;
  pendingQueue.push(text);
  scheduleFlush();
}

// Multiple ticks can land in the same window (a check running while the
// scheduler fires). Debounce by a beat so they all leave together.
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushQueue();
  }, 2500);
}

export async function flushQueue() {
  // Re-entrancy guard: two timers could both see a non-empty queue.
  if (flushing) return;
  const items = pendingQueue.splice(0);
  if (!items.length) return;
  flushing = true;
  try {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) return;
    // Telegram caps a message at 4096 characters; split on block boundaries
    // and never mid-item.
    const blocks = [];
    let cur = [];
    let len = 0;
    for (const text of items) {
      const n = text.length;
      if (len + n + 4 > 3500 && cur.length) {
        blocks.push(cur.join("\n\n"));
        cur = [];
        len = 0;
      }
      cur.push(text);
      len += n + 4;
    }
    if (cur.length) blocks.push(cur.join("\n\n"));
    for (const b of blocks) await sendMessage(chatId, b);
  } catch (err) {
    console.error("flush failed:", err.message);
    // Put them back so nothing is lost to a transient Telegram error.
    pendingQueue = items.concat(pendingQueue);
    scheduleFlush();
  } finally {
    flushing = false;
  }
}

export async function runCheckOnce() {
  if (checking) return { skipped: true };
  checking = true;
  try {
    let accessToken = await ensureValidTokens();
    // A stored config from before notifications was watched returns without
    // the key, which silently disabled the whole scope. Merge the defaults in
    // so an old record still turns every scope on.
    const storedConfig = await getKv("watch_config", {});
    const config = {
      assignments: true,
      materials: true,
      exams: true,
      grades: true,
      // notifications is what the platform's bell shows; without it here the
      // scope is never fetched, so /img_notifications and /backup both see
      // an empty list even when the student has unread alerts.
      notifications: true,
      ...storedConfig,
    };

    const results = {};
    // Every scope the platform exposes is polled. notifications was missing
    // from this list, which meant the merge above could turn it on while the
    // loop still never asked for it.
    for (const scope of Object.keys({ assignments: 1, materials: 1, exams: 1, grades: 1, notifications: 1 })) {
      if (!config[scope]) continue;
      try {
        results[scope] = await fetchScope(scope, accessToken);
      } catch (err) {
        lastError = `${scope}: ${err.message}`;
        console.error(`${scope} failed:`, err.message);
      }
    }

    const fresh = await collectFreshItems(results);
    await notifyFresh(fresh);

    // Deadline nudge: fire once per pending assignment when it crosses the
    // 24-hour line, not on every check — otherwise the bot spams every cycle.
    if (config.assignments && Array.isArray(results.assignments)) {
      await checkDeadlineReminders(results.assignments);
    }

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
    checking = false;
  }
}

// Deadline reminders: "باقيلك بس يوم" — fire once per assignment when it
// crosses the 24h line, then again if it turns overdue. Each nudge records
// which milestone it hit so a 10-minute cycle never repeats the same alert.
async function checkDeadlineReminders(assignments) {
  const cfg = await getKv("reminders_config", { enabled: true });
  if (cfg.enabled === false) return;

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const sent = await getKv("reminders_sent", {});

  for (const a of assignments) {
    if (!a || !a.dueAt) continue;
    const st = String(a.status || "").toLowerCase();
    if (st !== "pending") continue; // only outstanding work gets nudged

    const due = new Date(a.dueAt).getTime();
    if (!Number.isFinite(due)) continue;

    const key = String(a.id);
    const overdue = due < now;
    const dueSoon = !overdue && due - now <= DAY;

    // Milestone: "due_soon" first, "overdue" if it slips past. An assignment
    // that goes from soon → overdue gets exactly one follow-up.
    const milestone = overdue ? "overdue" : dueSoon ? "due_soon" : null;
    if (!milestone) continue;
    if (sent[key] === milestone) continue; // already said this one

    const hours = overdue
      ? Math.max(1, Math.round((now - due) / (60 * 60 * 1000)))
      : Math.max(1, Math.round((due - now) / (60 * 60 * 1000)));

    const urgent = overdue
      ? `🔴 <b>فاتك الواجب!</b> تأخر <b>${hours} ساعة</b>`
      : `⏰ <b>باقي أقل من ٢٤ ساعة</b> — حوالي ${hours} ساعة`;

    await queueNotify(
      `${urgent}\n\n` +
        `📝 <b>${escapeHtml(a.title || "واجب")}</b>\n` +
        `📚 ${escapeHtml(a.subject || "—")}\n` +
        `⏰ الاستحقاق: <code>${fmtDate(a.dueAt)}</code>\n\n` +
        `<i>عشان أسكت عنه، سلّمه أو اطلب مني أساعدك بالتنظيم.</i>`
    );

    sent[key] = milestone;
  }

  // Prince: drop keys for work that is no longer pending, so the set can't
  // grow without bound over a whole semester.
  const live = new Set(assignments.filter((a) => a && a.id != null).map((a) => String(a.id)));
  for (const k of Object.keys(sent)) if (!live.has(k)) delete sent[k];

  await setKv("reminders_sent", sent);
  await setKv("reminders_config", cfg);
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
  // Master switch: mute "new item" alerts without stopping the scan or the
  // deadline reminders. Items are still marked seen so they don't burst out
  // the moment alerts come back on.
  if (config.newAlerts === false) {
    for (const { item } of fresh) await markSeen(item);
    return;
  }
  const lines = [];
  for (const { scope, item } of fresh) {
    lines.push(formatItem(scope, item));
    await markSeen(item); // mark before sending so a crash never re-notifies
  }
  // Queue the whole batch as one block; the flush merges it with anything
  // else this cycle produced.
  queueNotify(lines.join("\n\n"));
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
// The cadence can be changed at runtime from the settings panel, so the
// effective interval is resolved here rather than read once at boot.
export async function getCheckIntervalMinutes() {
  // Per-chat setting wins when set; the env var is the fallback.
  const { getKv } = await import("./store.js");
  try {
    const cfg = await getKv(`settings:${process.env.TELEGRAM_CHAT_ID || "owner"}`, {});
    if (cfg && cfg.check_interval) return Math.max(5, Math.min(120, Number(cfg.check_interval) || 10));
  } catch {}
  return Math.max(5, Math.min(120, Number(process.env.CHECK_INTERVAL_MIN) || 10));
}

export async function startWatcher() {
  if (timer) return;
  const intervalMin = await getCheckIntervalMinutes();
  // running tracks the scheduler itself, not an in-flight check, so it is
  // set here and only cleared on stop — reporting it from inside the check
  // made the health endpoint say the watcher was off whenever the last
  // check bailed early.
  running = true;
  const run = async () => {
    try {
      await runCheckOnce();
    } catch (err) {
      console.error("scheduled check error:", err.message);
    }
    // The clock-driven features (morning briefing, exam countdown, grade
    // deltas) ride the same tick. They are individually gated by settings,
    // and each one records what it already announced, so nothing repeats.
    // They queue through the same collector as the fresh items and the
    // deadline reminders, so one cycle yields one message.
    try {
      const { runScheduler } = await import("./scheduler.js");
      await runScheduler({ send: (text) => queueNotify(text) });
    } catch (err) {
      console.error("scheduler tick error:", err.message);
    }
  };
  // Fire immediately on boot, then on the interval
  setTimeout(run, 5000);
  timer = setInterval(run, intervalMin * 60 * 1000);
  console.log(`watcher started (every ${intervalMin} min)`);
}

// Restart the scheduler so a settings change to the interval takes effect
// without waiting for the next redeploy.
export async function restartWatcher() {
  stopWatcher();
  await startWatcher();
}

export function stopWatcher() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
