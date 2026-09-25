// src/index.js — boot: store, telegram commands, web server, watcher
import express from "express";
import { initStore, getKv, setKv, getCredentials, resetSeen, listSeen, getTokens } from "./store.js";
import { createWebApp } from "./web.js";
import {
  setTelegramToken,
  on,
  startPolling,
  sendMessage,
  escapeHtml,
  editMessageText,
  sendButtons,
  editMessage,
  answerCallbackQuery,
  onCallback,
} from "./telegram.js";
import {
  getSettings,
  setSetting,
  cycleSetting,
  LABELS,
  SETTING_NAMES,
  SETTING_HINTS,
  PANEL,
} from "./settings.js";
import { runCheckOnce, getWatcherState, startWatcher, notifyOwner, fetchScope } from "./watcher.js";
import { getMyAssignments, getStudentHome, getUnreadCount, getMyAttendance, normalizeAssignments } from "./tuwaiq.js";
import {
  chunkText,
  formatList,
  formatAssignment,
  formatMaterial,
  formatExam,
  formatGrade,
  formatNotification,
  fmtDay,
  fmtTime,
  escapeHtml as esc,
} from "./format.js";
import { askAI, aiConfig, isAIEnabled } from "./ai.js";
import { setAIHandler, sendPhoto, isPolling, startWatchdog } from "./telegram.js";
import { remember, recentContext, getHistory, clear as clearMemory } from "./memory.js";

const PORT = process.env.PORT || 3000;

async function requireLogin(chatId) {
  const creds = await getCredentials();
  if (!creds) {
    await sendMessage(chatId, "🔒 الحساب غير مربوط. افتح رابط Render وسجّل دخول أولًا.");
    return false;
  }
  return true;
}

// Shared by /ai and the free-text handler: hand the question to the
// tool-calling agent. It pulls only the scopes it needs, so a simple
// question is fast and a detailed one is thorough.
async function answerWithAI(chatId, question) {
  if (!(await requireLogin(chatId))) return;
  // The panel toggle is per-chat and takes effect immediately.
  const cfg = await getSettings(chatId).catch(() => ({}));
  if (cfg.ai_enabled === false || !isAIEnabled()) {
    await sendMessage(
      chatId,
      "🤖 الذكاء الاصطناعي متوقف الحين.\n\nتقدر تشغّله من <code>/settings</code>، أو تستخدم الأوامر (جرّب /help)."
    );
    return;
  }
  const tokens = await getTokens();
  // Stage announcements so the student sees movement while the agent
  // thinks, fetches and renders — silence is what made it feel hung.
  const prog = await sendMessage(chatId, "🤖 أفكر…").catch(() => null);
  let bumped = false;
  const bump = async (msg) => {
    if (bumped) return;
    bumped = true;
    if (prog && prog.message_id) {
      await editMessageText(prog.message_id, chatId, msg).catch(() => sendMessage(chatId, msg).catch(() => {}));
    } else {
      await sendMessage(chatId, msg).catch(() => {});
    }
  };
  setTimeout(() => bump("⏳ لسه أجمع البيانات…"), 8000).unref?.();
  setTimeout(() => bump("⏳ شوي وأخلّص…"), 20000).unref?.();
  try {
    const history = recentContext(chatId);
    // Cap the whole agent run: a hung model otherwise leaves the student
    // staring at "ثواني…" forever. Two minutes is generous for a multi-tool
    // answer and still tells them something went wrong.
    const res = await Promise.race([
      askAI(question, { accessToken: tokens.accessToken, history }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("انتهى وقت الجواب (دقيقتين)")), 120000)
      ),
    ]);
    // Image tools return a PNG alongside (or instead of) the text.
    // Surface failures instead of swallowing them — otherwise the model
    // cheerfully claims the image was sent while nothing arrived.
    // Image tools return { photo: <Buffer>, caption }; pass both parts on.
    // (Handing the wrapper to sendPhoto directly was the "instance of Object"
    // error that made every AI image fail to arrive.)
    if (res.photo) {
      try {
        await sendPhoto(chatId, res.photo.photo, res.photo.caption || res.caption || "");
      } catch (err) {
        await sendMessage(
          chatId,
          `⚠️ ما قدرت أوصل الصورة: <code>${esc(err.message).slice(0, 150)}</code>\n\n<i>جرّب: /img schedule</i>`
        ).catch(() => {});
      }
    }
    if (res.reply) {
      remember(chatId, "assistant", res.reply);
      for (const chunk of chunkText(res.reply, 3800)) {
        await sendMessage(chatId, chunk);
      }
    }
  } catch (err) {
    await sendMessage(chatId, `⚠️ ما قدرت أجاوب: <code>${esc(err.message)}</code>`);
  }
}

// main() is retained for reference; mainWithRetry below is what actually boots.
async function main() {
  await initStore(process.env.DATABASE_URL);
  const app = createWebApp();
  app.listen(PORT, () => console.log(`listening on :${PORT}`));
}

function registerCommands() {
  // ---- Settings panel ------------------------------------------------------
  // The student drives the bot by tapping instead of typing. The panel reads
  // its values from the per-chat settings store, and every button re-renders
  // the same message in place, so the menu never scrolls the chat away.
  function settingsRows(cfg) {
    // One row per section so the buttons stay under their heading and no
    // row is wider than the phone screen.
    return PANEL.map((sec) =>
      sec.items.map((name) => ({
        label: LABELS[name][String(cfg[name])] || String(cfg[name]),
        action: `set:${name}`,
      }))
    ).concat([[{ label: "⛔ إغلاق", action: "close" }]]);
  }

  // The backup panel reuses the same button machinery, but only lists the
  // backup settings — the two panels stay separate so editing one does not
  // rewrite the other.
  function backupRows(cfg) {
    const scopes = ["backup_schedule", "backup_assignments", "backup_courses", "backup_grades", "backup_materials"];
    const formats = ["backup_format", "backup_auto"];
    return [
      scopes.map((name) => ({ label: LABELS[name][String(cfg[name])], action: `set:${name}` })),
      formats.map((name) => ({ label: LABELS[name][String(cfg[name])], action: `set:${name}` })),
      [{ label: "💾 نفّذ نسخة الحين", action: "run_backup" }, { label: "⛔ إغلاق", action: "close" }],
    ];
  }

  // A button on the backup panel that runs the copy in place, so the student
  // can flip a scope and immediately see the result. It answers the press
  // and hands control to the same handler /backup registered, so there is
  // exactly one copy of the work.
  onCallback("run_backup", async ({ chatId, queryId }) => {
    await answerCallbackQuery(queryId, "💾 أبدأ النسخة…");
    // Look the handler up the same way the message path does, then invoke it
    // with the shape it expects.
    const { getHandler } = await import("./telegram.js");
    const fn = typeof getHandler === "function" ? getHandler("/backup") : null;
    if (fn) await fn({ chatId, args: "", text: "/backup" }).catch(() => {});
  });

  function settingsText(cfg) {
    const lines = ["<b>⚙️ الإعدادات</b>", ""];
    for (const sec of PANEL) {
      lines.push(`<b>${sec.title}</b>`);
      for (const name of sec.items) {
        lines.push(`${SETTING_HINTS[name] || name}: ${LABELS[name][String(cfg[name])] || cfg[name]}`);
      }
      lines.push("");
    }
    lines.push("<i>اضغط أي زر عشان تغيره — التغيير فوري.</i>");
    return lines.join("\n");
  }

  on("/settings", async ({ chatId }) => {
    const cfg = await getSettings(chatId);
    await sendButtons(chatId, settingsText(cfg), settingsRows(cfg));
  });

  // A button press. The action carries the setting name; the handler cycles
  // to the next allowed value and rewrites the panel. Some settings also
  // have an immediate runtime effect, so those are applied right here.
  onCallback("set", async ({ chatId, messageId, arg, queryId }) => {
    if (!SETTING_NAMES.includes(arg)) {
      await answerCallbackQuery(queryId, "❓ إعداد غير معروف");
      return;
    }
    const cfg = await cycleSetting(chatId, arg);
    // The watcher cadence only takes effect on a restart, so restart it
    // whenever that setting moves.
    if (arg === "check_interval") {
      try {
        const { restartWatcher } = await import("./watcher.js");
        await restartWatcher();
      } catch {}
    }
    await editMessage(messageId, chatId, settingsText(cfg), settingsRows(cfg));
    await answerCallbackQuery(queryId, `✅ ${LABELS[arg][String(cfg[arg])]}`);
  });

  onCallback("close", async ({ chatId, messageId, queryId }) => {
    await editMessage(messageId, chatId, "✅ تم. تقدر تفتحها أي وقت بـ <code>/settings</code>", null);
    await answerCallbackQuery(queryId, "");
  });

  onCallback("open_settings", async ({ chatId, queryId }) => {
    const cfg = await getSettings(chatId);
    await sendButtons(chatId, settingsText(cfg), settingsRows(cfg));
    await answerCallbackQuery(queryId, "");
  });

  // Quick actions row attached to the schedule image — the student sees the
  // table and can flip its orientation without leaving the chat.
  async function rerenderGrid(chatId, cfg) {
    const tokens = await getTokens();
    const items = (await fetchScope("schedule", tokens.accessToken)).filter(
      (s) => String(s.status || "").toLowerCase() !== "cancelled"
    );
    const { renderScheduleGridImage } = await import("./images.js");
    return renderScheduleGridImage(items, {
      orientation: cfg.schedule_orientation,
      showRoom: cfg.schedule_show_room !== false,
      direction: cfg.schedule_direction === "ltr" ? "ltr" : "rtl",
      cleanNames: cfg.schedule_clean_names !== false,
    });
  }

  onCallback("flip", async ({ chatId, queryId }) => {
    const cfg = await getSettings(chatId);
    const next = cfg.schedule_orientation === "days_top" ? "days_left" : "days_top";
    await setSetting(chatId, "schedule_orientation", next);
    await answerCallbackQuery(queryId, `✅ ${LABELS.schedule_orientation[next]}`);
    const out = await rerenderGrid(chatId, { ...cfg, schedule_orientation: next });
    await sendPhoto(chatId, out.png, `${out.caption} — ${LABELS.schedule_orientation[next]}`);
  });

  onCallback("flipdir", async ({ chatId, queryId }) => {
    const cfg = await getSettings(chatId);
    const next = cfg.schedule_direction === "ltr" ? "rtl" : "ltr";
    await setSetting(chatId, "schedule_direction", next);
    await answerCallbackQuery(queryId, `✅ ${LABELS.schedule_direction[next]}`);
    const out = await rerenderGrid(chatId, { ...cfg, schedule_direction: next });
    await sendPhoto(chatId, out.png, `${out.caption} — ${LABELS.schedule_direction[next]}`);
  });

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
    await sendMessage(chatId, "🔍 أبدأت الفحص...").catch(() => {});
    const r = await runCheckOnce();
    // Self-check the renderer too: fetch the real schedule, render it, and
    // confirm the image actually contains every class the platform sent.
    // The bot verifies its own output instead of waiting for the student
    // to notice something is off.
    let renderNote = "";
    try {
      const tokens = await getTokens();
      const items = (await fetchScope("schedule", tokens.accessToken)).filter(
        (s) => String(s.status || "").toLowerCase() !== "cancelled"
      );
      const { renderScheduleGridImage } = await import("./images.js");
      const out = await renderScheduleGridImage(items);
      const d = out.diag || {};
      renderNote =
        `\n🖼 الرسم: ${items.length} حصة → ${d.slots || 0} خانة` +
        (d.stacked ? ` (${d.stacked} خانة فيها أكثر من حصة، متراصة)` : "");
    } catch (e) {
      renderNote = `\n🖼 الرسم: تعذّر التحقق (<code>${esc(e.message).slice(0, 80)}</code>)`;
    }
    if (r.ok) {
      const counts = Object.entries(r.counts || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(" | ");
      await sendMessage(chatId, `✅ تم الفحص\n${counts}\n🆕 جديد: ${r.fresh}${renderNote}`);
    } else {
      await sendMessage(chatId, `❌ فشل: <code>${escapeHtml(r.error)}</code>${renderNote}`);
    }
  });

  // Proof of freshness: pull the schedule straight from the platform and
  // report the exact payload the bot just saw, with the fetch time. This is
  // the answer to "does the bot really read the site, or is it showing me
  // something it stored?" — nothing here is cached.
  on("/fresh", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    await sendMessage(chatId, "🔄 أجيب بيانات حية من المنصة الحين…").catch(() => {});
    const t0 = Date.now();
    try {
      const tokens = await getTokens();
      const items = await fetchScope("schedule", tokens.accessToken);
      const live = (items || []).filter(
        (s) => String(s.status || "").toLowerCase() !== "cancelled"
      );
      const ms = Date.now() - t0;
      const stamp = new Date().toLocaleString("ar-SA", {
        timeZone: "Asia/Riyadh",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const first = live[0];
      await sendMessage(
        chatId,
        [
          "✅ <b>جبتها من المنصة مباشرة</b>",
          `🕐 وقت الجلب: <code>${stamp}</code> (${ms}ms)`,
          `📡 الرد: <code>${items.length}</code> جلسة، <code>${live.length}</code> فعلي`,
          first
            ? `🔍 أول حصة: <code>${escapeHtml(first.title)}</code> · <code>${escapeHtml(
                String(first.startTime || "")
              )}</code>`
            : "",
          "",
          "<i>كل شي تشوفه يجي من sc.tuwaiq.edu.sa وقت ما تطلبه — ما عندي نسخة محفوظة.</i>",
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (err) {
      await sendMessage(chatId, `⚠️ ما قدرت: <code>${escapeHtml(err.message)}</code>`);
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
    for (const c of items.slice(0, 15)) {
      const bits = [`📘 <b>${esc(String(c.title || "—"))}</b>`];
      if (c.teacher) bits.push(`   👨‍🏫 ${esc(String(c.teacher))}`);
      if (c.attendanceRate != null) bits.push(`   ✅ الحضور: ${c.attendanceRate}%`);
      const pending = [c.pendingAssignments, c.dueSoonAssignments, c.openExams]
        .filter((v) => v != null && v > 0);
      if (pending.length) bits.push(`   📊 واجبات: ${c.pendingAssignments ?? 0} · مستحقة: ${c.dueSoonAssignments ?? 0} · اختبارات: ${c.openExams ?? 0}`);
      if (c.finalGrade != null) bits.push(`   🏆 الدرجة النهائية: ${esc(String(c.finalGrade))}`);
      lines.push(bits.join("\n"));
    }
    await sendMessage(chatId, lines.join("\n\n"));
  });

  on("/schedule", async ({ chatId, args }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const items = await fetchScope("schedule", tokens.accessToken);
    if (!Array.isArray(items) || !items.length) {
      await sendMessage(chatId, "🗓 ما في جدول الحين.");
      return;
    }
    // group by day so it reads like the platform's weekly grid
    const byDay = new Map();
    for (const s of items) {
      const day = s.date ? String(s.date).slice(0, 10) : "—";
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(s);
    }
    const today = new Date().toISOString().slice(0, 10);
    const days = [...byDay.keys()].sort();
    const onlyToday = args[0] === "today";
    const shown = onlyToday ? days.filter((d) => d === today) : days;
    const lines = ["<b>🗓 الجدول الأسبوعي</b>"];
    for (const day of shown) {
      const isToday = day === today;
      lines.push(`\n<b>${isToday ? "🔵 يومك الحين" : fmtDay(day)}</b>`);
      for (const s of byDay.get(day).slice(0, 8)) {
        const time = s.startTime ? fmtTime(s.startTime, s.endTime) : "";
        const room = s.room ? ` · غرفة ${esc(String(s.room))}` : "";
        const tag = s.status === "cancelled" ? " ❌ ملغاة" : "";
        lines.push(`• ${esc(String(s.title))}${time ? ` — <code>${time}</code>` : ""}${room}${tag}`);
      }
    }
    await sendMessage(chatId, lines.join("\n"));
  });

  on("/attendance", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const att = await getMyAttendance(tokens.accessToken);
    const lines = ["<b>✅ الحضور</b>"];
    // /attendance/my-attendance may be a summary object or a list per course.
    const tryField = (label, v) => {
      if (v != null && v !== "") lines.push(`${label}: <b>${esc(String(v))}</b>`);
    };
    if (Array.isArray(att)) {
      for (const c of att.slice(0, 10)) {
        lines.push(
          `📘 <b>${esc(String(c.subjectName || c.offeringTitle || "مادة"))}</b> — ${esc(String(c.attendanceRate ?? c.percentage ?? "—"))}%`
        );
      }
    } else if (att && typeof att === "object") {
      tryField("نسبة الحضور", att.attendanceRate ?? att.rate ?? att.percentage);
      tryField("الحصص الحضورية", att.attended ?? att.present ?? att.totalPresent);
      tryField("الغياب", att.absences ?? att.absent ?? att.totalAbsent);
      tryField("التأخير", att.late ?? att.lateArrivals);
      tryField("الإجمالي", att.totalSessions ?? att.total);
      if (lines.length === 1) {
        // Unknown shape — show the keys so we can adapt in the next iteration.
        lines.push(`<i>ما في بيانات واضحة. المفاتيح:</i>`);
        lines.push(`<code>${esc(JSON.stringify(Object.keys(att)).slice(0, 300))}</code>`);
      }
    } else {
      lines.push("<i>ما في بيانات حضور الحين.</i>");
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
    const tokens = await getTokens();
    const materials = await fetchScope("materials", tokens.accessToken);
    if (!target) {
      // Show an inline picker so the user doesn't have to remember ids.
      const lines = ["📥 <b>تحميل مادة</b>", "", "اختر برقم من القائمة:"];
      materials.slice(0, 15).forEach((m, i) => {
        lines.push(`<code>${i + 1}</code> — ${esc(String(m.title).slice(0, 45))}`);
      });
      lines.push("", `<i>اكتب: <code>/download 3</code></i>`);
      await sendMessage(chatId, lines.join("\n"));
      return;
    }
    const n = Number(target);
    // accept either the list position (1..N) or the raw id ("mat-221"/"221").
    let m;
    if (Number.isInteger(n) && n >= 1 && n <= materials.length) {
      m = materials[n - 1];
    } else {
      const needle = String(target).replace(/^mat-/, "");
      m = materials.find((x) => String(x.id).replace(/^mat-/, "") === needle);
    }
    if (!m) {
      await sendMessage(chatId, `❌ ما لقيت مادة برقم <code>${esc(target)}</code>\nجرّب <code>/download</code> لحالة القائمة`);
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
    // Announce each scope as it is fetched, so a slow platform never looks
    // like the bot froze mid-run.
    await sendMessage(chatId, "⏳ أجيب كل شي من المنصة…").catch(() => {});
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

  // A full copy of the platform, respecting the student's per-scope and
  // per-format choices. Scope toggles skip a section entirely; the format
  // setting decides whether a section arrives as the rendered card, a plain
  // list, or both — so the student can take the schedule as an image and the
  // grades as text without touching anything else.
  on("/backup", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const cfg = await getSettings(chatId);
    const tokens = await getTokens();
    const fmt = cfg.backup_format || "both";

    const plan = [
      ["schedule", "🗓 الجدول", "schedule"],
      ["assignments", "📝 الواجبات", "assignments"],
      ["courses", "📘 المقررات", "courses"],
      ["grades", "🏆 الدرجات", "grades"],
      ["materials", "📚 المواد", "materials"],
    ].filter(([key]) => cfg[`backup_${key}`] !== false);

    if (!plan.length) {
      await sendMessage(chatId, "🚫 كل النطاقات متوقفة من إعدادات النسخة الاحتياطية.\nشغّلها من <code>/backupcfg</code>.");
      return;
    }

    await sendMessage(chatId, `💾 أبدأ النسخة الاحتياطية — ${plan.length} نطاقات…`).catch(() => {});

    // Each scope carries its own image renderer and text formatter; the
    // format setting picks which are actually sent.
    const img = await import("./images.js");
    const renderers = {
      schedule: img.renderScheduleGridImage,
      assignments: img.renderAssignmentsImage,
      grades: img.renderGradesImage,
    };
    const totalCount = { ok: 0, fail: 0 };
    for (const [key, label, scope] of plan) {
      try {
        const items = await fetchScope(scope, tokens.accessToken);
        const live = (items || []).filter(
          (s) => String(s.status || "").toLowerCase() !== "cancelled"
        );
        const n = (key === "schedule" ? live : items || []).length;
        const word = n === 1 ? "عنصر واحد" : n === 2 ? "عنصرين" : `${n} عنصر`;

        if ((fmt === "image" || fmt === "both") && renderers[key]) {
          const out = await renderers[key](live, {
            orientation: cfg.schedule_orientation,
            showRoom: cfg.schedule_show_room !== false,
            direction: cfg.schedule_direction === "ltr" ? "ltr" : "rtl",
            cleanNames: cfg.schedule_clean_names !== false,
          });
          await sendPhoto(chatId, out.png, `${label} — ${word}`);
        }
        if (fmt === "text" || fmt === "both") {
          const body = (key === "schedule" ? live : items || []).slice(0, 12);
          const text = body.length
            ? body.map((s, i) => `${i + 1}. ${esc(String(s.title || s.subjectName || s.name || "—"))}`).join("\n")
            : "<i>فاضي</i>";
          for (const chunk of chunkText(`${label} (${word})\n${text}`)) {
            await sendMessage(chatId, chunk);
          }
        }
        totalCount.ok++;
      } catch (err) {
        totalCount.fail++;
        await sendMessage(chatId, `${label}\n<i>خطأ: ${esc(err.message)}</i>`).catch(() => {});
      }
    }
    await sendMessage(
      chatId,
      `✅ <b>تمت النسخة الاحتياطية</b>\nناجح: ${totalCount.ok} | فشل: ${totalCount.fail}\n\n<i>${
        cfg.backup_auto === false ? "التحديث التلقائي متوقف — شغّله من /backupcfg" : "التحديث التلقائي شغال مع كل فحص"
      }</i>`
    );
  });

  // Backup settings panel: which scopes get copied, and in what shape. Same
  // button machinery as /settings, its own message so the two stay separate.
  on("/backupcfg", async ({ chatId }) => {
    const cfg = await getSettings(chatId);
    await sendButtons(
      chatId,
      [
        "<b>💾 إعدادات النسخة الاحتياطية</b>",
        "",
        "<b>النطاقات</b>",
        `الجدول: ${cfg.backup_schedule === false ? "متوقف" : "شغال"}`,
        `الواجبات: ${cfg.backup_assignments === false ? "متوقف" : "شغال"}`,
        `المقررات: ${cfg.backup_courses === false ? "متوقف" : "شغال"}`,
        `الدرجات: ${cfg.backup_grades === false ? "متوقف" : "شغال"}`,
        `المواد: ${cfg.backup_materials === false ? "متوقف" : "شغال"}`,
        "",
        "<b>الشكل</b>",
        `الطريقة: ${LABELS.backup_format[String(cfg.backup_format)]}`,
        `التلقائي: ${cfg.backup_auto === false ? "متوقف" : "شغال"}`,
        "",
        "<i>اضغط أي زر عشان تغيره — التغيير فوري.</i>",
      ].join("\n"),
      backupRows(cfg)
    );
  });

  on("/help", async ({ chatId }) => {
    await sendMessage(chatId, HELP_TEXT);
  });

  // ===== AI: free-text chat =====
  // Any message that isn't a command is treated as a question for the AI.
  // It answers using a live snapshot of the platform as context.
  on("/ai", async ({ chatId, args, text }) => {
    const q = args.join(" ").trim();
    if (!q) {
      const cfg = aiConfig();
      await sendMessage(
        chatId,
        `<b>🤖 الذكاء الاصطناعي</b>\n\nالحالة: <b>${cfg.enabled ? "✅ مفعّل" : "❌ غير مفعّل"}</b>\nالنموذج: <code>${esc(cfg.model)}</code>\n\n` +
          (cfg.enabled
            ? "اكتب أي سؤال بدون '/' وأرد عليك:\n<i>«وش عندي واجبات هالأسبوع؟»</i>"
            : "للتفعيل، اضبط <code>OPENAI_API_KEY</code> (أو <code>AI_API_KEY</code>) في إعدادات الخدمة.\nتقدر تستخدم OpenAI، أو أي خدمة متوافقة (DeepSeek، Groq، غيرها) عبر <code>AI_BASE_URL</code>.")
      );
      return;
    }
    await answerWithAI(chatId, q);
  });

  // Today's classes at a glance — the most-used view for a student.
  on("/today", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const items = await fetchScope("schedule", tokens.accessToken);
    const today = new Date().toISOString().slice(0, 10);
    const mine = items.filter((s) => String(s.date || "").slice(0, 10) === today);
    if (!mine.length) {
      await sendMessage(chatId, "🎉 ما في حصص اليوم — استمتع!");
      return;
    }
    const lines = [`<b>📅 حصص اليوم (${fmtDay(today)})</b>`];
    mine.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    for (const s of mine) {
      const time = s.startTime ? fmtTime(s.startTime, s.endTime) : "—";
      lines.push(`• ${esc(String(s.title))} — <code>${time}</code>${s.room ? ` · غرفة ${esc(String(s.room))}` : ""}`);
    }
    await sendMessage(chatId, lines.join("\n"));
  });

  // Raw JSON export for anything the structured commands don't cover yet.
  // Deadline-reminder switch: "باقيلك بس يوم لا يفوتك" on or off.
  // Stored in reminders_config so it survives restarts.
  // Telegram commands can't contain spaces, so multi-word scopes are joined
  // with an underscore — they register cleanly and show as one command.
  on("/img_grid", async (ctx) => onImg(ctx, "grid"));
  on("/img_schedule", async (ctx) => onImg(ctx, "schedule"));
  on("/img_assignments", async (ctx) => onImg(ctx, "assignments"));
  on("/img_grades", async (ctx) => onImg(ctx, "grades"));

  // The table exactly as the site shows it. The web page needs a Keycloak
  // browser session (the bearer token is not enough), so this establishes
  // one from the /login chain, then reads the real /student/schedule HTML
  // and redraws it in the platform's own palette. If the session cannot be
  // established it falls back to the API-driven grid rather than failing.
  on("/site", async ({ chatId, args }) => {
    if (!(await requireLogin(chatId))) return;
    const scope = String(args[0] || "schedule");
    if (scope !== "schedule") {
      await sendMessage(chatId, "📸 الحين يدعم: <code>/site schedule</code>");
      return;
    }
    const tokens = await getTokens();
    await sendMessage(chatId, "📸 أجهّز الجدول من المنصة…").catch(() => {});

    try {
      const { getSchedulePageHTML } = await import("./tuwaiq.js");
      const { parseScheduleHTML, renderSiteSchedule } = await import("./schedule-dom.js");

      await sendMessage(chatId, "🔍 أبحث عن الجدول…").catch(() => {});
      const html = await getSchedulePageHTML(tokens.accessToken);

      if (html && html.includes("tt-wrap")) {
        const parsed = parseScheduleHTML(html);
        const live = (parsed.classes || []).filter((c) => !c.cancelled);
        if (live.length) {
          await sendMessage(chatId, "🖌 أرسم الجدول الحين…").catch(() => {});
          const { png } = await renderSiteSchedule({ ...parsed, classes: live });
          await sendPhoto(chatId, png, `📸 جدولك مثل ما يظهر في المنصة — ${live.length} حصة`);
          return;
        }
      }
      // No grid on the page: fall back to the API grid, which is the same
      // layout in the site's colours.
      await sendMessage(chatId, "📊 أجيب الجدول من بياناتك…").catch(() => {});
      const items = (await fetchScope("schedule", tokens.accessToken)).filter((s) => s.status !== "cancelled");
      if (!Array.isArray(items) || !items.length) {
        await sendMessage(chatId, "ما في بيانات للجدول الحين.");
        return;
      }
      const { renderScheduleGridImage } = await import("./images.js");
      await sendMessage(chatId, "🖌 أرسم الجدول الحين…").catch(() => {});
      const { png } = await renderScheduleGridImage(items);
      await sendPhoto(chatId, png, `📸 جدولك — ${items.length} حصة`);
    } catch (err) {
      await sendMessage(chatId, `⚠️ ما قدرت أصوّر: <code>${esc(err.message)}</code>`);
    }
  });

  on("/remind", async ({ chatId, args }) => {
    const arg = String(args[0] || "").toLowerCase();
    const cfg = await getKv("reminders_config", { enabled: true });
    if (arg === "on" || arg === "off") {
      cfg.enabled = arg === "on";
      await setKv("reminders_config", cfg);
      await sendMessage(
        chatId,
        cfg.enabled
          ? "⏰ <b>تنبيهات الموعد النهائي مفعّلة</b>\n\nبأرسلك تنبيه لكل واجب باقي عليه <b>أقل من ٢٤ ساعة</b>، وتنبيه ثاني لو فاته الموعد.\n\n<i>مرة وحدة لكل واجب — ما بسپم.</i>"
          : "🔕 <b>تنبيهات الموعد النهائي مطفية</b>\n\nما بأرسل تذكيرات الأوقات.\n\n<i>جرّب /remind on وقت ما تبيها ترجع.</i>"
      );
      return;
    }
    await sendMessage(
      chatId,
      `⏰ <b>تنبيهات الموعد النهائي</b> — <b>${cfg.enabled === false ? "مطفية 🔕" : "مفعّلة ✅"}</b>\n\n` +
        "باقي عليه <b>أقل من ٢٤ ساعة</b> → تنبيه\nفات الموعد → تنبيه ثاني\n\n" +
        "<code>/remind on</code> — تشغيل\n<code>/remind off</code> — إيقاف"
    );
  });

  // Master switch for the "new item appeared" notifications.
  on("/newalerts", async ({ chatId, args }) => {
    const arg = String(args[0] || "").toLowerCase();
    const cfg = await getKv("watch_config", {});
    if (arg === "on" || arg === "off") {
      // Keep scope toggles, flip only the new-alert kill switch.
      cfg.newAlerts = arg === "on";
      await setKv("watch_config", cfg);
      await sendMessage(
        chatId,
        cfg.newAlerts
          ? "🔔 <b>تنبيهات الجديد مفعّلة</b>\n\nبأرسلك كل واجب أو مادة أو اختبار أو درجة جديدة أول ما تنزل."
          : "🔕 <b>تنبيهات الجديد مطفية</b>\n\nما بنبهك على الشي الجديد.\n\n<i>الفحص لسه شغّال — استخدم الأوامر وقت ما تبي.</i>"
      );
      return;
    }
    await sendMessage(
      chatId,
      `🔔 <b>تنبيهات الجديد</b> — <b>${cfg.newAlerts === false ? "مطفية 🔕" : "مفعّلة ✅"}</b>\n\n` +
        "<code>/newalerts on</code> — تشغيل\n<code>/newalerts off</code> — إيقاف"
    );
  });

  // Recall earlier conversation. The model only sees the last few exchanges
  // by default; this lets the student page back further on demand.
  on("/history", async ({ chatId, args }) => {
    const n = Math.min(Number(args[0]) || 10, 20);
    const rows = getHistory(chatId, n);
    if (!rows.length) {
      await sendMessage(chatId, "📭 ما في محادثة محفوظة الحين.\n\n<i>اكتب أي سؤال وبأذكره.</i>");
      return;
    }
    const lines = [`<b>💬 آخر ${Math.ceil(rows.length / 2)} محادثة</b>`, ""];
    for (const m of rows) {
      const who = m.role === "user" ? "🙋‍♂️ أنت" : "🤖 البوت";
      lines.push(`${who}: <i>${esc(m.content.slice(0, 300))}</i>`);
      lines.push("");
    }
    await sendMessage(chatId, lines.join("\n"));
  });

  on("/forget", async ({ chatId }) => {
    clearMemory(chatId);
    await sendMessage(chatId, "🧹 نسيت المحادثة السابقة.\n\n<i>ابدأ من جديد — أسمعك.</i>");
  });

  // Send a rendered PNG image of a scope — schedule, assignments or grades.
  on("/img", async ({ chatId, args }) => {
    const scope = args[0] || "schedule";
    await onImg({ chatId }, scope);
  });

  // Telegram commands can't contain spaces, so multi-word scopes are joined
  // with an underscore — they register cleanly and show as one command.
  // Shared by /img <scope> and the /img_<scope> shortcuts.
  async function onImg({ chatId }, scope) {
    if (!(await requireLogin(chatId))) return;
    const valid = ["schedule", "assignments", "grades", "grid"];
    if (!valid.includes(scope)) {
      await sendMessage(
        chatId,
        "🖼 <b>صورة</b>\n\nالاستعمال: <code>/img &lt;نطاق&gt;</code>\n\n<code>" +
          valid.join("</code> · <code>") +
          "</code>\n\n<i>/img_schedule — الجدول كصورة مرتبة\n/img_grid — شبكة الأيام والأوقات\nأو بكلمة: /img schedule</i>"
      );
      return;
    }
    const tokens = await getTokens();
    // Human-readable labels so every step announces itself — the student
    // should never watch the bot go quiet while it fetches and renders.
    const STEP = {
      schedule: "🗓 أجيب جدولك وأرسمه…",
      grid: "🗓 أبني شبكة الجدول…",
      assignments: "📚 أجيب واجباتك وأرسمها…",
      grades: "📊 أجيب درجاتك وأرسمها…",
    };
    try {
      const { renderScheduleImage, renderAssignmentsImage, renderGradesImage, renderScheduleGridImage } =
        await import("./images.js");
      if (scope === "grid") {
        await sendMessage(chatId, STEP.grid).catch(() => {});
        const items = await fetchScope("schedule", tokens.accessToken);
        if (!Array.isArray(items) || !items.length) {
          await sendMessage(chatId, "ما في بيانات للجدول الحين.");
          return;
        }
        // Honour the student's chosen orientation, direction and room.
        const cfg = await getSettings(chatId);
        // fetchScope("schedule") already normalises to {subject, date,
        // startTime, endTime, room, status} — the exact fields the renderer
        // reads. Mapping them again here looked up keys that no longer
        // exist (sessionDate instead of date), which blanked the day and
        // collapsed the whole week into one column.
        const live = items.filter(
          (s) => String(s.status || "").toLowerCase() !== "cancelled"
        );
        const out = await renderScheduleGridImage(live, {
          orientation: cfg.schedule_orientation,
          showRoom: cfg.schedule_show_room !== false,
          direction: cfg.schedule_direction === "ltr" ? "ltr" : "rtl",
          cleanNames: cfg.schedule_clean_names !== false,
        });
        await sendPhoto(chatId, out.png, out.caption);
        // Then a small control row so the table can be flipped in place.
        await sendButtons(chatId, "أو تتحكم بالجدول من هنا:", [
          [{ label: "🔄 اقلب الاتجاه", action: "flip" }, { label: " ↔️ يمين/يسار", action: "flipdir" }],
          [{ label: "⚙️ كل الإعدادات", action: "open_settings" }],
        ]);
        return;
      }
      await sendMessage(chatId, STEP[scope] || "📸 أجهّز صورتك…").catch(() => {});
      const items = await fetchScope(scope, tokens.accessToken);
      if (!Array.isArray(items) || !items.length) {
        await sendMessage(chatId, `ما في بيانات لـ <code>${esc(scope)}</code> الحين.`);
        return;
      }
      await sendMessage(chatId, "🖌 أرسم الصورة الحين…").catch(() => {});
      const out =
        scope === "schedule"
          ? await renderScheduleImage(items)
          : scope === "assignments"
          ? await renderAssignmentsImage(items)
          : await renderGradesImage(items);
      await sendPhoto(chatId, out.png, out.caption);
    } catch (err) {
      await sendMessage(chatId, `⚠️ ما قدرت أصوّر: <code>${esc(err.message)}</code>`);
    }
  }

  on("/export", async ({ chatId, args }) => {
    if (!(await requireLogin(chatId))) return;
    const scope = args[0];
    const valid = ["assignments", "materials", "exams", "grades", "courses", "schedule", "notifications"];
    if (!valid.includes(scope)) {
      await sendMessage(
        chatId,
        "📥 <b>تصدير JSON</b>\n\nالاستعمال: <code>/export &lt;نطاق&gt;</code>\n\nالنطاقات المتاحة:\n<code>" +
          valid.join("</code> · <code>") +
          "</code>"
      );
      return;
    }
    const tokens = await getTokens();
    const items = await fetchScope(scope, tokens.accessToken);
    await sendMessage(chatId, `<code>${esc(JSON.stringify(items, null, 1).slice(0, 3800))}</code>`);
  });
}

const HELP_TEXT = `<b>🤖 أوامر بوت طويق</b>

<b>كل المنصة:</b>
/all — كل شي في المنصة (واجبات + مواد + اختبارات + درجات + إشعارات)
/dashboard — ملخص سريع من لوحة طويق
/backup — 🆕 <b>نسخة احتياطية كاملة</b> لكل المنصة

<b>أوامر لكل نطاق:</b>
/assignments [pending / graded / overdue] — الواجبات
/materials — كل المواد
/exams — الاختبارات المتاحة
/grades — كل الدرجات
/courses — مقرراتي (مع الحضور والدرجات)
/schedule — الجدول الأسبوعي
/schedule today — حصص يوم محدد
/today — حصص اليوم بس
/attendance — نسبة الحضور
/notifications — الإشعارات
/unread — عدد الإشعارات غير المقروءة
/download 12 — تحميل مادة برقمها

<b>📸 الصور:</b>
/img schedule — الجدول كصورة مرتبة
/img grid — الجدول بشبكة الأيام والأوقات
/img assignments — الواجبات كصورة
/img grades — الدرجات كصورة
/site schedule — <b>صورة الجدول مثل ما يظهر في المنصة بالضبط</b>

<b>⏰ التنبيهات:</b>
/remind on — تنبيه "باقيلك بس يوم" (on/off)
/newalerts on — تنبيهات الشي الجديد (on/off)
/history 10 — استرجع آخر محادثات
/forget — امسح ذاكرة المحادثة
/export grades — تصدير JSON لأي نطاق
/due — الواجبات المستحقة خلال ٢٤ ساعة

<b>🤖 الذكاء الاصطناعي:</b>
/ai — حالة الذكاء وإعداداته
أي كلام بدون / — اسأله أي شي عن منصتك!

<b>🛠 التحكم:</b>
/status — حالة البوت
/check — فحص فوري
/fresh — ✅ أثبت إن البيانات من المنصة الحين
/settings — ⚙️ لوحة الإعدادات (أزرار)
/backupcfg — 🆕 <b>إعدادات النسخة الاحتياطية</b> (أزرار)
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
      // Route free-text messages (no "/") to the AI layer.
      setAIHandler(async ({ chatId, text }) => {
        remember(chatId, "user", text);
        await answerWithAI(chatId, text);
      });
      startPolling();
      // If the poll loop ever dies (conflict, OOM, crash), restart it within
      // a minute instead of going deaf until the next deploy.
      startWatchdog();
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
