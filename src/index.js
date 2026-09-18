// src/index.js — boot: store, telegram commands, web server, watcher
import express from "express";
import { initStore, getKv, setKv, getCredentials, resetSeen, listSeen } from "./store.js";
import { createWebApp } from "./web.js";
import { setTelegramToken, on, startPolling, sendMessage, escapeHtml } from "./telegram.js";
import { runCheckOnce, getWatcherState, startWatcher, notifyOwner } from "./watcher.js";
import { getMyAssignments, normalizeAssignments } from "./tuwaiq.js";
import { getTokens } from "./store.js";
import { getStudentHome } from "./tuwaiq.js";

const PORT = process.env.PORT || 3000;

async function requireLogin(chatId) {
  const creds = await getCredentials();
  if (!creds) {
    await sendMessage(chatId, "🔒 الحساب غير مربوط. افتح رابط Render وسجّل دخول أولًا.");
    return false;
  }
  return true;
}

async function main() {
  // 1. persistence (Supabase / Neon Postgres)
  await initStore(process.env.DATABASE_URL);

  // 2. telegram
  if (process.env.TELEGRAM_BOT_TOKEN) {
    setTelegramToken(process.env.TELEGRAM_BOT_TOKEN);
    registerCommands();
    startPolling();
    console.log("telegram bot started");
  } else {
    console.warn("TELEGRAM_BOT_TOKEN missing — notifications disabled until set");
  }

  // 3. web server (Render port + login page + health)
  const app = createWebApp();
  app.listen(PORT, () => console.log(`listening on :${PORT}`));

  // 4. resume watching if an account is already linked
  const creds = await getCredentials();
  if (creds) {
    startWatcher();
    console.log("account linked — watcher resumed");
  } else {
    console.log("no account yet — waiting for login at /");
  }

  // 5. friendly reminder if the bot is half-configured
  if (!process.env.TELEGRAM_CHAT_ID) {
    console.warn("TELEGRAM_CHAT_ID missing — send /start to the bot and set it as env var");
  }
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
}

function isWithin24h(iso) {
  if (!iso) return false;
  const d = new Date(iso).getTime();
  return d > Date.now() && d < Date.now() + 24 * 60 * 60 * 1000;
}

main().catch((err) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});
