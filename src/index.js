// src/index.js — boot: store, telegram commands, web server, watcher
import express from "express";
import { initStore, getKv, setKv, getCredentials, resetSeen, listSeen, getTokens } from "./store.js";
import { createWebApp } from "./web.js";
import { setTelegramToken, on, startPolling, sendMessage, escapeHtml } from "./telegram.js";
import { runCheckOnce, getWatcherState, startWatcher, notifyOwner, fetchScope } from "./watcher.js";
import { getMyAssignments, getStudentHome, getUnreadCount, normalizeAssignments } from "./tuwaiq.js";
import {
  chunkText,
  formatList,
  formatAssignment,
  formatMaterial,
  formatExam,
  formatGrade,
  formatNotification,
  escapeHtml as esc,
} from "./format.js";

const PORT = process.env.PORT || 3000;

async function requireLogin(chatId) {
  const creds = await getCredentials();
  if (!creds) {
    await sendMessage(chatId, "🔒 الحساب غير مربوط. افتح رابط Render وسجّل دخول أولًا.");
    return false;
  }
  return true;
}

// main() is retained for reference; mainWithRetry below is what actually boots.
async function main() {
  await initStore(process.env.DATABASE_URL);
  const app = createWebApp();
  app.listen(PORT, () => console.log(`listening on :${PORT}`));
}

function registerCommands() {
  on("/status", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const state = getWatcherState();
    const tokens = await getTokens();
    const identity = await getKv("identity", null);
    const intervalMin = Number(process.env.CHECK_INTERVAL_MIN) || 10;
    const lines = [
      "<b>📊 حالة البوت</b>",
      `👤 الحساب: <code>${escapeHtml(identity?.email || identity?.name || "—")}</code>`,
      `🔄 الفحص: ${state.running ? "جاري" : "خامل"} كل ${intervalMin} دقيقة`,
      `🕒 آخر فحص: ${state.lastCheck ? new Date(state.lastCheck).toLocaleString("ar-SA", { timeZone: "Asia/Riyadh" }) : "لم يفحص بعد"}`,
      `🔑 الجلسة: ${tokens?.refreshExpiresAt > Date.now() / 1000 ? "سارية" : "تحتاج تجديد"}`,
    ];
    if (state.lastError) lines.push(`⚠️ آخر خطأ: <code>${escapeHtml(state.lastError)}</code>`);
    await sendMessage(chatId, lines.join("\n"));
  });

  on("/check", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    await sendMessage(chatId, "🔍 أبدأت الفحص...");
    const r = await runCheckOnce();
    if (r.ok) {
      const counts = Object.entries(r.counts || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(" | ");
      await sendMessage(chatId, `�️ تم الفحص\n${counts}\n🆕 جديد: ${r.fresh}`);
    } else {
      await sendMessage(chatId, `❌ فشل: <code>${escapeHtml(r.error)}</code>`);
    }
  });

  on("/watch", async ({ chatId, args }) => {
    if (!(await requireLogin(chatId))) return;
    const config = await getKv("watch_config", {
      assignments: true,
      materials: true,
      exams: true,
      grades: true,
    });
    const [scope, state] = args;
    const valid = ["assignments", "materials", "exams", "grades"];
    if (!scope) {
      const names = { assignments: "الواجبات", materials: "المواد", exams: "الاختبارات", grades: "النتائج" };
      const lines = ["<b>👁 النطاقات</b>"];
      for (const k of valid) {
        lines.push(`${config[k] ? "🟢" : "⚫"} <code>${k}</code> — ${names[k]}`);
      }
      lines.push("\nللتغيير: <code>/watch assignments off</code>");
      await sendMessage(chatId, lines.join("\n"));
      return;
    }
    if (!valid.includes(scope)) {
      await sendMessage(chatId, `❌ نطاق غير معروف. المتاحة: ${valid.join(", ")}`);
      return;
    }
    if (state !== "on" && state !== "off") {
      await sendMessage(chatId, "استخدم: <code>/watch assignments on</code> أو <code>off</code>");
      return;
    }
    config[scope] = state === "on";
    await setKv("watch_config", config);
    await sendMessage(chatId, `${state === "on" ? "🟢" : "⚫"} نطاق <code>${scope}</code> ${state === "on" ? "شُغّل" : "أُطفئ"}`);
  });

  on("/interval", async ({ chatId, args }) => {
    if (!(await requireLogin(chatId))) return;
    const current = Number(process.env.CHECK_INTERVAL_MIN) || 10;
    const n = Number(args[0]);
    if (!n || n < 5 || n > 120) {
      await sendMessage(
        chatId,
        `🕒 الفاصل الحالي: ${current} دقيقة (يُضبط من متغيرات البيئة <code>CHECK_INTERVAL_MIN</code>)\nالأوامر المحلية غير مدعومة — استخدم env var.`
      );
      return;
    }
  });

  on("/who", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const identity = await getKv("identity", null);
    await sendMessage(
      chatId,
      `<b>👤 الحساب الحالي</b>\nالاسم: ${escapeHtml(identity?.name || "—")}\nالإيميل: <code>${escapeHtml(identity?.email || "—")}</code>`
    );
  });

  on("/logout", async ({ chatId }) => {
    const { clearCredentials } = await import("./store.js");
    await clearCredentials();
    await sendMessage(chatId, "👋 تم مسح الحساب. سجّل دخول من جديد من صفحة Render.");
  });

  on("/seen", async ({ chatId, args }) => {
    const kind = args[0] || null;
    const rows = await listSeen(15, kind);
    if (!rows.length) {
      await sendMessage(chatId, "📭 لا يوجد سجل بعد.");
      return;
    }
    const lines = ["<b>_ARCHIVE آخر ما رُصد</b>"];
    for (const r of rows) {
      const at = new Date(r.seen_at).toLocaleString("ar-SA", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Riyadh" });
      lines.push(`• <code>${r.kind}</code> ${escapeHtml(r.title || "—")} — ${at}`);
    }
    await sendMessage(chatId, lines.join("\n"));
  });

  on("/reset", async ({ chatId }) => {
    await resetSeen();
    await sendMessage(chatId, "🧹 مُسح سجل المراقبة. كل عنصر سيعُد جديدًا في الفحصة الجاية.");
  });

  on("/due", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const payload = await getMyAssignments(tokens.accessToken);
    const items = normalizeAssignments(payload).filter(
      (a) => !["Graded", "Submitted"].includes(a.status) && (a.isDueSoon || a.isOverdue || isWithin24h(a.dueAt))
    );
    if (!items.length) {
      await sendMessage(chatId, "✅ لا واجبات مستحقة خلال ٢٤ ساعة.");
      return;
    }
    const lines = ["<b>⏰ مستحق خلال ٢٤ ساعة</b>"];
    for (const a of items) {
      lines.push(`📝 <b>${escapeHtml(a.title)}</b>\n📚 ${escapeHtml(a.subject || "—")} ⏰ <code>${a.dueAt || "—"}</code>`);
    }
    await sendMessage(chatId, lines.join("\n"));
  });

  on("/dashboard", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const home = await getStudentHome(tokens.accessToken);
    const lines = ["<b>🏫 لوحة طويق</b>"];
    const tryField = (obj, key, label) => {
      const v = obj?.[key];
      if (v != null) lines.push(`${label}: <b>${escapeHtml(String(v))}</b>`);
    };
    tryField(home, "pendingAssignments", "📝 واجبات للتسليم");
    tryField(home, "dueSoon", "⏰ مستحقة قريبًا");
    tryField(home, "overdue", "🔴 متأخرة");
    tryField(home, "availableExams", "📄 اختبارات متاحة");
    tryField(home, "newMaterials", "📚 مواد جديدة");
    if (lines.length === 1) lines.push("<code>" + escapeHtml(JSON.stringify(home).slice(0, 800)) + "</code>");
    await sendMessage(chatId, lines.join("\n"));
  });

  // ===== comprehensive listing commands =====
  // Each pulls live from the platform (never a cache) and renders through the
  // shared formatters so dates, scores and status always look the same.

  const sendList = async (chatId, header, items, fmt) => {
    if (!items || !items.length) {
      await sendMessage(chatId, `${header}\n<i>فاضي</i>`);
      return;
    }
    const shown = items.slice(0, 12);
    const more = items.length > shown.length ? `\n<i>و ${items.length - shown.length} أخرى…</i>` : "";
    await sendMessage(chatId, formatList(header, shown, fmt) + more);
  };

  on("/assignments", async ({ chatId, args }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const items = await fetchScope("assignments", tokens.accessToken);
    const filter = args[0];
    let rows = items;
    if (filter === "pending") rows = items.filter((a) => !["Graded", "Submitted"].includes(a.status));
    if (filter === "graded") rows = items.filter((a) => a.gradePoints != null || a.status === "Graded");
    if (filter === "overdue") rows = items.filter((a) => a.isOverdue);
    const label = { pending: "غير مسلّمة", graded: "المصححة", overdue: "المتأخرة" }[filter];
    await sendList(chatId, `📝 الواجبات${label ? ` — ${label}` : ""}`, rows, formatAssignment);
  });

  on("/materials", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    await sendList(chatId, "📚 المواد", await fetchScope("materials", tokens.accessToken), formatMaterial);
  });

  on("/exams", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    await sendList(chatId, "📄 الاختبارات المتاحة", await fetchScope("exams", tokens.accessToken), formatExam);
  });

  on("/grades", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    await sendList(chatId, "🏆 الدرجات", await fetchScope("grades", tokens.accessToken), formatGrade);
  });

  on("/courses", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const items = await fetchScope("courses", tokens.accessToken);
    if (!Array.isArray(items) || !items.length) {
      await sendMessage(chatId, "📚 ما في مقررات الحين.");
      return;
    }
    const lines = ["<b>🎓 مقرراتي</b>"];
    for (const c of items.slice(0, 20)) {
      lines.push(`• <b>${esc(String(c.title || c.name || "—"))}</b>`);
    }
    await sendMessage(chatId, lines.join("\n"));
  });

  on("/schedule", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const items = await fetchScope("schedule", tokens.accessToken);
    if (!Array.isArray(items) || !items.length) {
      await sendMessage(chatId, "🗓 ما في جدول الحين.");
      return;
    }
    const lines = ["<b>🗓 الجدول</b>"];
    for (const s of items.slice(0, 20)) {
      const t = s.title || s.subjectName || s.subject || "—";
      const day = s.day || s.date || s.weekday || "";
      lines.push(`• <b>${esc(String(t))}</b>${day ? ` — <code>${esc(String(day))}</code>` : ""}`);
    }
    await sendMessage(chatId, lines.join("\n"));
  });

  // Announcements / notifications from the platform bell icon.
  on("/notifications", async ({ chatId, args }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const items = await fetchScope("notifications", tokens.accessToken);
    const onlyUnread = args[0] === "unread";
    const rows = onlyUnread ? items.filter((n) => !n.read) : items;
    await sendList(chatId, `🔔 الإشعارات${onlyUnread ? " — غير المقروءة" : ""}`, rows, formatNotification);
  });

  // ===== download =====
  // /download <id> sends the file link for a material the bot has seen.
  // The platform exposes fileUrl (S3) or externalUrl; the frontend modal uses
  // exactly these to download/open, so we do the same.
  on("/download", async ({ chatId, args }) => {
    if (!(await requireLogin(chatId))) return;
    const target = args[0];
    if (!target) {
      await sendMessage(
        chatId,
        "📥 <b>تحميل مادة</b>\n\nاكتب رقم المادة بعد الأمر.\nمثال: <code>/download 12</code>\n\nتقدر تجيب الأرقام من <code>/materials</code>"
      );
      return;
    }
    const tokens = await getTokens();
    const materials = await fetchScope("materials", tokens.accessToken);
    // accept "12" or "mat-12"
    const needle = target.replace(/^mat-/, "");
    const m = materials.find((x) => String(x.id).replace(/^mat-/, "") === needle);
    if (!m) {
      await sendMessage(chatId, `❌ ما لقيت مادة برقم <code>${esc(target)}</code>`);
      return;
    }
    const link = m.fileUrl || m.externalUrl;
    if (!link) {
      await sendMessage(
        chatId,
        `📎 <b>${esc(m.title)}</b>\nالمادة ما عليها رابط ملف مباشر. افتحها من المنصة:\n${m.url}`
      );
      return;
    }
    const size = m.contentType ? `\n🗂 النوع: <code>${esc(m.contentType)}</code>` : "";
    await sendMessage(
      chatId,
      `📥 <b>${esc(m.title)}</b>${size}\n\n🔗 <a href="${esc(link)}">اضغط لتحميل الملف</a>\n\n<i>الرابط قد ينتهي بعد فترة — لو ما فتح، جرّب مرة ثانية.</i>`
    );
  });

  on("/unread", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const count = await getUnreadCount(tokens.accessToken);
    const n = count?.count ?? count?.unreadCount ?? count;
    await sendMessage(chatId, `🔔 عندك <b>${n ?? 0}</b> إشعار غير مقروء.\nجرّب <code>/notifications</code>`);
  });

  // "show me everything" — one snapshot of the whole platform.
  on("/all", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const t = tokens.accessToken;
    const scopes = [
      ["assignments", "📝 الواجبات", formatAssignment],
      ["materials", "📚 المواد", formatMaterial],
      ["exams", "📄 الاختبارات", formatExam],
      ["grades", "🏆 الدرجات", formatGrade],
      ["notifications", "🔔 الإشعارات", formatNotification],
    ];
    const parts = [];
    for (const [scope, label, fmt] of scopes) {
      try {
        const items = await fetchScope(scope, t);
        const shown = items.slice(0, 6);
        const more = items.length > 6 ? `\n<i>و ${items.length - 6} أخرى…</i>` : "";
        parts.push(items.length ? formatList(label, shown, fmt) + more : `${label}\n<i>فاضي</i>`);
      } catch (err) {
        parts.push(`${label}\n<i>خطأ: ${esc(err.message)}</i>`);
      }
    }
    for (const chunk of chunkText(parts.join("\n\n"))) {
      await sendMessage(chatId, chunk);
    }
  });

  on("/help", async ({ chatId }) => {
    await sendMessage(chatId, HELP_TEXT);
  });
}

const HELP_TEXT = `<b>🤖 أوامر بوت طويق</b>

<b>كل المنصة:</b>
/all — كل شي في المنصة (واجبات + مواد + اختبارات + درجات + إشعارات)
/dashboard — ملخص سريع من لوحة طويق

<b>أوامر لكل نطاق:</b>
/assignments [pending / graded / overdue] — الواجبات
/materials — كل المواد
/exams — الاختبارات المتاحة
/grades — كل الدرجات
/courses — مقرراتي
/schedule — الجدول
/notifications — الإشعارات
/unread — عدد الإشعارات غير المقروءة
/download 12 — تحميل مادة برقمها
/due — الواجبات المستحقة خلال ٢٤ ساعة

<b>التحكم:</b>
/status — حالة البوت
/check — فحص فوري
/watch assignments on|off — تشغيل/إيقاف مراقبة نطاق
/interval 15 — تغيير دقيقة الفحص
/seen — آخر ما رُصد
/reset — مسح السجل
/who — الحساب الحالي
/logout — تسجيل الخروج
/help — هذه القائمة`;

// --- boot ---------------------------------------------------------------------
// Supabase free tier can take a few seconds to wake from auto-pause, and fresh
// Render instances hit transient routing errors. Retry the DB-backed steps and
// always start the web server so Render's health check has something to hit.
async function mainWithRetry() {
  let storeOk = false;
  for (let i = 1; i <= 5 && !storeOk; i++) {
    try {
      await initStore(process.env.DATABASE_URL);
      storeOk = true;
    } catch (err) {
      console.error(`store init failed (attempt ${i}/5):`, err.message);
      if (i === 5) console.error("giving up on the store; running in degraded mode");
      else await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }

  if (storeOk) {
    if (process.env.TELEGRAM_BOT_TOKEN) {
      setTelegramToken(process.env.TELEGRAM_BOT_TOKEN);
      registerCommands();
      startPolling();
      console.log("telegram bot started");
    } else {
      console.warn("TELEGRAM_BOT_TOKEN missing — notifications disabled until set");
    }

    const creds = await getCredentials();
    if (creds) {
      startWatcher();
      console.log("account linked — watcher resumed");
    } else {
      console.log("no account yet — waiting for login at /");
    }
  }

  const app = createWebApp();
  app.listen(PORT, () => console.log(`listening on :${PORT}`));

  if (!process.env.TELEGRAM_CHAT_ID) {
    console.warn("TELEGRAM_CHAT_ID missing — send /start to the bot and set it as env var");
  }
}

mainWithRetry().catch((err) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});
