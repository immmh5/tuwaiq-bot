// src/index.js — boot: store, telegram commands, web server, watcher
import express from "express";
import { initStore, getKv, setKv, getCredentials, resetSeen, listSeen, getTokens } from "./store.js";
import { createWebApp } from "./web.js";
import { setTelegramToken, on, startPolling, sendMessage, escapeHtml } from "./telegram.js";
import { runCheckOnce, getWatcherState, startWatcher, notifyOwner, fetchScope } from "./watcher.js";
import { getMyAssignments, getStudentHome, normalizeAssignments } from "./tuwaiq.js";

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
  // Each /list-* command pulls a scope live from the platform (never the cache),
  // so the user always sees the current state, not the last snapshot.

  on("/list-assignments", async ({ chatId, args }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const items = await fetchScope("assignments", tokens.accessToken);
    const filter = args[0]; // pending | graded | overdue
    let rows = items;
    if (filter === "pending") rows = items.filter((a) => !["Graded", "Submitted"].includes(a.status));
    if (filter === "graded") rows = items.filter((a) => a.gradePoints != null || a.status === "Graded");
    if (filter === "overdue") rows = items.filter((a) => a.isOverdue);
    if (!rows.length) {
      await sendMessage(chatId, `📭 ما في واجبات${filter ? ` (${filter})` : ""}.`);
      return;
    }
    await sendMessage(chatId, formatList("📝 كل الواجبات", rows.slice(0, 15), formatAssignment));
  });

  on("/list-materials", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const items = await fetchScope("materials", tokens.accessToken);
    if (!items.length) {
      await sendMessage(chatId, "📭 ما في مواد منشورة.");
      return;
    }
    await sendMessage(chatId, formatList("📚 كل المواد", items.slice(0, 15), formatMaterial));
  });

  on("/list-exams", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const items = await fetchScope("exams", tokens.accessToken);
    if (!items.length) {
      await sendMessage(chatId, "📭 ما في اختبارات متاحة الحين.");
      return;
    }
    await sendMessage(chatId, formatList("📄 الاختبارات المتاحة", items.slice(0, 15), formatExam));
  });

  on("/list-grades", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const items = await fetchScope("grades", tokens.accessToken);
    if (!items.length) {
      await sendMessage(chatId, "📭 ما في درجات منشورة.");
      return;
    }
    await sendMessage(chatId, formatList("🏆 كل الدرجات", items.slice(0, 15), formatGrade));
  });

  on("/list-courses", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const items = await fetchScope("courses", tokens.accessToken);
    if (!Array.isArray(items) || !items.length) {
      await sendMessage(chatId, "📭 ما في مقررات.");
      return;
    }
    const lines = ["<b>🎓 مقرراتي</b>"];
    for (const c of items.slice(0, 20)) {
      const t = c.title || c.name || "—";
      lines.push(`• <b>${escapeHtml(String(t))}</b>${c.teacherName ? ` — ${escapeHtml(c.teacherName)}` : ""}`);
    }
    await sendMessage(chatId, lines.join("\n"));
  });

  on("/list-schedule", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const items = await fetchScope("schedule", tokens.accessToken);
    if (!Array.isArray(items) || !items.length) {
      await sendMessage(chatId, "📭 ما في جدول الحين." + (items ? ` <code>${escapeHtml(JSON.stringify(items).slice(0, 300))}</code>` : ""));
      return;
    }
    const lines = ["<b>🗓 الجدول الأسبوعي</b>"];
    for (const s of items.slice(0, 20)) {
      lines.push(`• <b>${escapeHtml(String(s.title || s.subjectName || "—"))}</b> <code>${escapeHtml(String(s.day ?? s.date ?? ""))}</code>`);
    }
    await sendMessage(chatId, lines.join("\n"));
  });

  // "show me everything" — the full platform snapshot in one command
  on("/all", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const t = tokens.accessToken;
    const parts = [];
    const scopes = [
      ["assignments", "📝 الواجبات", formatAssignment],
      ["materials", "📚 المواد", formatMaterial],
      ["exams", "📄 الاختبارات", formatExam],
      ["grades", "🏆 الدرجات", formatGrade],
    ];
    for (const [scope, label, fmt] of scopes) {
      try {
        const items = await fetchScope(scope, t);
        parts.push(
          items.length
            ? formatList(label, items.slice(0, 6), fmt) + (items.length > 6 ? `\n<i>و ${items.length - 6} أخرى…</i>` : "")
            : `${label}\n<i>فاضي</i>`
        );
      } catch (err) {
        parts.push(`${label}\n<i>خطأ: ${escapeHtml(err.message)}</i>`);
      }
    }
    for (const chunk of chunkText(parts.join("\n\n"), 3900)) {
      await sendMessage(chatId, chunk);
    }
  });

  on("/help", async ({ chatId }) => {
    await sendMessage(chatId, HELP_TEXT, { parseMode: "HTML" });
  });
}

const HELP_TEXT = `<b>🤖 أوامر بوت طويق</b>

<b>كل المنصة:</b>
/all — كل شي في المنصة (واجبات + مواد + اختبارات + درجات)
/dashboard — ملخص سريع من لوحة طويق

<b>أوامر مخصصة لكل نطاق:</b>
/list-assignments — كل الواجبات
/list-assignments pending — غير مسلّمة بس
/list-assignments graded — المصححة
/list-assignments overdue — المتأخرة
/list-materials — كل المواد
/list-exams — الاختبارات المتاحة
/list-grades — كل الدرجات
/list-courses — مقرراتي
/list-schedule — الجدول الأسبوعي
/due — الواجبات المستحقة خلال ٢٤ ساعة

<b>التحكم:</b>
/status — حالة البوت والاتصال
/check — فحص فوري
/watch assignments on — تشغيل مراقبة نطاق
/watch exams off — إيقافها
/interval 15 — تغيير دقيقية الفحص
/seen — آخر ما رُصد
/reset — مسح السجل
/who — الحساب الحالي
/logout — تسجيل الخروج
/help — هذه القائمة`;

function chunkText(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < 1) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) out.push(rest);
  return out;
}

function formatList(header, items, fmt) {
  return [header, ...items.map(fmt)].join("\n");
}

function formatAssignment(a) {
  const bits = [`📝 <b>${escapeHtml(a.title)}</b>`];
  if (a.subject) bits.push(`   📚 ${escapeHtml(a.subject)}`);
  if (a.dueAt) bits.push(`   ⏰ <code>${escapeHtml(String(a.dueAt))}</code>${a.isOverdue ? " 🔴 متأخر" : a.isDueSoon ? " 🟡 قريب" : ""}`);
  if (a.status) bits.push(`   📊 ${escapeHtml(a.status)}`);
  if (a.gradePoints != null && a.maxPoints != null) bits.push(`   🏆 ${a.gradePoints}/${a.maxPoints}`);
  return bits.join("\n");
}

function formatMaterial(m) {
  const bits = [`📚 <b>${escapeHtml(m.title)}</b>`];
  if (m.subject) bits.push(`   📗 ${escapeHtml(m.subject)}`);
  if (m.contentType) bits.push(`   📎 ${escapeHtml(m.contentType)}`);
  if (m.createdAt) bits.push(`   📅 <code>${escapeHtml(String(m.createdAt))}</code>`);
  return bits.join("\n");
}

function formatExam(e) {
  const bits = [`📄 <b>${escapeHtml(e.title)}</b>`];
  if (e.subject) bits.push(`   📚 ${escapeHtml(e.subject)}`);
  if (e.startsAt) bits.push(`   ▶️ <code>${escapeHtml(String(e.startsAt))}</code>`);
  if (e.endsAt) bits.push(`   ⏹ <code>${escapeHtml(String(e.endsAt))}</code>`);
  if (e.durationMin) bits.push(`   ⏱ ${e.durationMin} دقيقة`);
  if (e.status) bits.push(`   📊 ${escapeHtml(e.status)}`);
  return bits.join("\n");
}

function formatGrade(g) {
  const score = g.score != null ? `   🏆 <b>${g.score}${g.maxScore != null ? `/${g.maxScore}` : ""}</b>` : "";
  return [`🏆 <b>${escapeHtml(g.title)}</b>`, g.subject ? `   📚 ${escapeHtml(g.subject)}` : "", score].filter(Boolean).join("\n");
}

function isWithin24h(iso) {
  if (!iso) return false;
  const d = new Date(iso).getTime();
  return d > Date.now() && d < Date.now() + 24 * 60 * 60 * 1000;
}

async function mainWithRetry() {
  // Supabase free tier can take a few seconds to wake from auto-pause, and
  // fresh Render instances may hit transient routing errors. Boot the web
  // server first so /health responds, then retry the DB-backed steps.
  let storeOk = false;
  for (let i = 1; i <= 5 && !storeOk; i++) {
    try {
      await initStore(process.env.DATABASE_URL);
      storeOk = true;
    } catch (err) {
      console.error(`store init failed (attempt ${i}/5):`, err.message);
      if (i === 5) {
        console.error("giving up on the store; running in degraded mode");
      } else {
        await new Promise((r) => setTimeout(r, 5000 * i));
      }
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

  // Always start the web server so Render's health check has something to hit.
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
