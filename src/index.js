// src/index.js — boot: store, telegram commands, web server, watcher
import express from "express";
import { initStore, getKv, setKv, getCredentials, resetSeen, listSeen, getTokens, isOwner, isOwnerOf as isOwnerOfStore, upsertUser, getUser, setPhone, getPhone, isOwnerPhone } from "./store.js";
import { createWebApp, startSelfPing } from "./web.js";
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
  requestContact,
  hideKeyboard,
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

// Access control. The bot starts private: only the owner's own Telegram id
// (OWNER_TELEGRAM_ID) may use it. The owner can open it to guests from the
// settings panel, in which case anyone may read through the linked account
// but the destructive commands stay owner-only.
export function botMode() {
  return process.env.BOT_MODE === "public" ? "public" : "private";
}

// The owner is recognised by the phone number they shared with the bot,
// falling back to the configured chat id. The number is the primary signal:
// it comes from Telegram itself.
export async function isOwnerOf(chatId) {
  return isOwnerOfStore(chatId);
}

// Commands that change the account or wipe data are never handed to a guest.
// A guest reads through the linked account; letting them log it out or reset
// its history would break things for everyone else.
const OWNER_ONLY = new Set([
  "/logout",
  "/reset",
  "/forget",
  "/watch",
  "/interval",
  "/mode",
]);

// Every command passes through here first. In private mode anything that
// isn't the owner is refused outright; in public mode the owner-only list
// still applies, and the guest is told why rather than silently ignored.
export async function gateCommand(chatId, command) {
  // The owner is recognised by the phone number they shared with the bot,
  // or by the configured chat id. Either signal grants full access.
  if (await isOwnerOfStore(chatId)) return true;
  if (botMode() === "private") {
    await sendMessage(
      chatId,
      "🔒 البوت خاص الحين — المالك فقط يستخدمه.\n<i>تقدر تسأل المالك يفتحه للعامة من الإعدادات.</i>"
    ).catch(() => {});
    return false;
  }
  if (OWNER_ONLY.has(command)) {
    await sendMessage(
      chatId,
      "🚫 هذا الأمر للمالك فقط — أنت تستخدم البوت كضيف.\n<i>تقدر تتصفح المنصة وتاخذ نسختك الاحتياطية، لكن ما تقدر تعدّل الحساب.</i>"
    ).catch(() => {});
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
  // Every command is wrapped so access control cannot be forgotten on a new
  // one: the wrapper refuses non-owners in private mode and blocks the
  // owner-only list for guests in public mode, then records the caller.
  const guarded = (cmd, fn) =>
    on(cmd, async (ctx) => {
      if (!(await gateCommand(ctx.chatId, cmd))) return;
      // Remember everyone the bot has met, so a person's phone number and
      // role survive restarts and never get mixed up with another account.
      // The role is resolved from the phone number they shared with the
      // bot, falling back to the configured chat id.
      const owner = await isOwnerOfStore(ctx.chatId).catch(() => false);
      await upsertUser(ctx.chatId, {
        role: owner ? "owner" : "guest",
      }).catch(() => {});
      return fn(ctx);
    });
  // ---- Settings panel ------------------------------------------------------
  // The student drives the bot by tapping instead of typing. The panel reads
  // its values from the per-chat settings store, and every button re-renders
  // the same message in place, so the menu never scrolls the chat away.
  // (The rows are built by settingsRows further down, which also appends the
  // owner-only access switch.)

  // The backup panel reuses the same button machinery, but only lists the
  // backup settings — the two panels stay separate so editing one does not
  // rewrite the other.
  async function backupRows(cfg, chatId) {
    const scopes = ["backup_schedule", "backup_assignments", "backup_courses", "backup_grades", "backup_materials"];
    const formats = ["backup_format", "backup_auto"];
    const { isMegaConfigured } = await megaModule();
    const linked = isMegaConfigured();
    return [
      // The backup panel re-renders its own page, so the section is backup.
      scopes.map((name) => ({ label: LABELS[name][String(cfg[name])], action: `set_backup:${name}` })),
      formats.map((name) => ({ label: LABELS[name][String(cfg[name])], action: `set_backup:${name}` })),
      [
        { label: linked ? "✅ MEGA مربوط" : "🔗 ربط MEGA", action: "mega_help" },
        { label: "💾 نفّذ نسخة الحين", action: "run_backup" },
      ],
      [{ label: "⛔ إغلاق", action: "close" }],
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

  // The main settings page is a category picker — one button per section —
  // rather than every toggle at once. Tapping one opens a second page
  // holding just that section's toggles, so the panel never grows past one
  // screen no matter how many settings exist.
  async function settingsText(cfg, chatId, section) {
    if (section) {
      const sec = PANEL.find((s) => s.key === section);
      if (!sec) return "<b>⚙️ الإعدادات</b>";
      const lines = [`<b>${sec.title}</b>`, ""];
      for (const name of sec.items) {
        lines.push(`${SETTING_HINTS[name] || name}: ${LABELS[name][String(cfg[name])] || cfg[name]}`);
      }
      lines.push("");
      lines.push("<i>اضغط أي زر عشان تغيره — التغيير فوري.</i>");
      return lines.join("\n");
    }
    const lines = ["<b>⚙️ الإعدادات</b>", "", "اختر القسم اللي تبي تعدّله:"];
    if (chatId && (await isOwnerOfStore(chatId))) {
      lines.push("");
      lines.push("🔒 <b>الوصول</b>");
      lines.push(`الوضع: ${botMode() === "public" ? "عام — الضيوف مسموحين" : "خاص — أنت فقط"}`);
    }
    return lines.join("\n");
  }

  async function settingsRows(cfg, chatId, section) {
    if (section) {
      // A sub-page shows one section's toggles plus a way back. Two buttons
      // a row keeps it readable on a phone.
      const sec = PANEL.find((s) => s.key === section);
      if (!sec) return [[{ label: "🔙 رجوع", action: "settings:" }]];
      const items = sec.items.map((name) => ({
        label: LABELS[name][String(cfg[name])] || String(cfg[name]),
        action: `set_${section}:${name}`,
      }));
      const rows = [];
      for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
      rows.push([{ label: "🔙 رجوع للإعدادات", action: "settings:" }]);
      return rows;
    }
    // Main page: one button per category.
    const rows = PANEL.map((sec) => [
      {
        label: sec.title,
        action: `settings:${sec.key}`,
      },
    ]);
    if (chatId && (await isOwnerOfStore(chatId))) {
      rows.push([
        {
          label: botMode() === "public" ? "🔒 خاص (أنا فقط)" : "🌐 عام (سماح للضيوف)",
          action: "mode:flip",
        },
      ]);
    }
    return rows.concat([[{ label: "⛔ إغلاق", action: "close" }]]);
  }

  guarded("/settings", async ({ chatId }) => {
    const cfg = await getSettings(chatId);
    await sendButtons(chatId, (await settingsText(cfg, chatId)), (await settingsRows(cfg, chatId)));
  });

  // The only way the bot opens to other people. Flipping it is an owner
  // action by construction — the button only exists on the owner's panel,
  // and the callback re-checks ownership before touching the flag.
  onCallback("mode", async ({ chatId, queryId, arg }) => {
    if (!(await isOwnerOfStore(chatId))) {
      await answerCallbackQuery(queryId, "🚫 للمالك فقط");
      return;
    }
    if (arg === "flip") {
      const next = botMode() === "public" ? "private" : "public";
      // The mode lives in the environment, so flipping it needs a restart
      // to take effect; the message says so rather than claiming an instant
      // change that did not happen.
      await answerCallbackQuery(
        queryId,
        next === "public" ? "🌐 سيصبح عام بعد إعادة التشغيل" : "🔒 سيصبح خاص بعد إعادة التشغيل"
      );
      await sendMessage(
        chatId,
        `⚠️ <b>تغيير الوضع يحتاج إعادة تشغيل</b>\n\nالوضع الجديد: <b>${
          next === "public" ? "عام — الضيوف مسموحين" : "خاص — أنت فقط"
        }</b>\n\n<i>أضف في Render متغير البيئة:</i>\n<code>BOT_MODE=${next}</code>\n<i>ثم أعد النشر.</i>`
      );
    }
  });

  // A toggle press. The action is "set_<section>:<name>" — the section is
  // encoded in the action so the panel re-renders the same sub-page instead
  // of jumping back to the category list.
  onCallback("set", async ({ chatId, messageId, arg, queryId, action }) => {
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
    // "set_<section>:<name>" — the prefix says which sub-page to redraw.
    const section = action?.startsWith("set_") ? action.slice("set_".length) : null;
    // The backup panel is its own message with its own layout, so a toggle
    // there redraws that panel rather than the settings sub-page.
    if (section === "backup") {
      await editMessage(messageId, chatId, await backupPanelText(cfg), await backupRows(cfg, chatId));
    } else {
      await editMessage(messageId, chatId, (await settingsText(cfg, chatId, section)), (await settingsRows(cfg, chatId, section)));
    }
    await answerCallbackQuery(queryId, `✅ ${LABELS[arg][String(cfg[arg])]}`);
  });

  // Category navigation: the main page opens a sub-page for one section, and
  // the empty section returns to the main page.
  onCallback("settings", async ({ chatId, messageId, arg, queryId }) => {
    const cfg = await getSettings(chatId);
    const section = arg || null;
    if (section && !PANEL.some((s) => s.key === section)) {
      await answerCallbackQuery(queryId, "❓ قسم غير معروف");
      return;
    }
    await editMessage(messageId, chatId, (await settingsText(cfg, chatId, section)), (await settingsRows(cfg, chatId, section)));
    await answerCallbackQuery(queryId, "");
  });

  onCallback("close", async ({ chatId, messageId, queryId }) => {
    await editMessage(messageId, chatId, "✅ تم. تقدر تفتحها أي وقت بـ <code>/settings</code>", null);
    await answerCallbackQuery(queryId, "");
  });

  onCallback("open_settings", async ({ chatId, queryId }) => {
    const cfg = await getSettings(chatId);
    await sendButtons(chatId, (await settingsText(cfg, chatId)), (await settingsRows(cfg, chatId)));
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

  guarded("/status", async ({ chatId }) => {
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

  guarded("/check", async ({ chatId }) => {
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
  guarded("/fresh", async ({ chatId }) => {
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

  guarded("/watch", async ({ chatId, args }) => {
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

  // /interval_<n> — the cadence in the token, no space. The value still has
  // to live in the environment to take effect, so the command reports where
  // to set it rather than pretending it changed something.
  guarded(/^\/interval_(\d+)$/, async (ctx) => intervalImpl(ctx, Number(ctx.match[1])));
  guarded("/interval", async (ctx) => intervalImpl(ctx, Number(ctx.args[0])));

  async function intervalImpl({ chatId }, n) {
    if (!(await requireLogin(chatId))) return;
    const current = Number(process.env.CHECK_INTERVAL_MIN) || 10;
    if (!n || n < 5 || n > 120) {
      await sendMessage(
        chatId,
        `🕒 الفاصل الحالي: ${current} دقيقة (يُضبط من متغيرات البيئة <code>CHECK_INTERVAL_MIN</code>)\nالأوامر المحلية غير مدعومة — استخدم env var.`
      );
      return;
    }
  }

  // Scope toggles as single tokens: /watch_assignments_on instead of
  // "/watch assignments on".
  const WATCH_SCOPES = ["assignments", "materials", "exams", "grades", "notifications"];
  for (const scope of WATCH_SCOPES) {
    guarded(`/watch_${scope}_on`, async (ctx) => watchSetImpl(ctx, scope, "on"));
    guarded(`/watch_${scope}_off`, async (ctx) => watchSetImpl(ctx, scope, "off"));
  }

  async function watchSetImpl({ chatId }, scope, state) {
    if (!(await requireLogin(chatId))) return;
    const cfg = await getKv("watch_config", {});
    cfg[scope] = state === "on";
    await setKv("watch_config", cfg);
    await sendMessage(chatId, `${state === "on" ? "🟢" : "⚫"} نطاق <code>${scope}</code> ${state === "on" ? "شُغّل" : "أُطفئ"}`);
  }

  guarded("/who", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const identity = await getKv("identity", null);
    const phone = await getPhone(chatId);
    const owner = await isOwnerOfStore(chatId);
    const role = owner ? "المالك" : "ضيف";
    await sendMessage(
      chatId,
      [
        "<b>👤 الحساب الحالي</b>",
        `الاسم: ${escapeHtml(identity?.name || "—")}`,
        `الإيميل: <code>${escapeHtml(identity?.email || "—")}</code>`,
        `رقمك: <code>${escapeHtml(phone || "غير محدد")}</code>`,
        `دورك: ${role}`,
        `الوضع: ${botMode() === "public" ? "عام" : "خاص"}`,
        "",
        `<i>عرف البوت بنفسك بضغطة: <code>/identify</code></i>`,
        `<i>أو يدويًا: <code>/phone 050xxxxxxx</code></i>`,
      ].join("\n")
    );
  });

  // Each person carries their own phone number, so the account record and
  // any per-user state stay attached to the right person rather than to the
  // shared platform account.
  guarded("/phone", async ({ chatId, args }) => {
    // Numbers arrive without a space: /phone_0501234567. The trailing part of
    // the command itself is the number, so args is empty in that case.
    const raw = (args || []).join("").trim();
    if (!raw) {
      const phone = await getPhone(chatId);
      await sendMessage(
        chatId,
        `📞 رقمك الحالي: <code>${escapeHtml(phone || "غير محدد")}</code>\n\n<i>تغييره: <code>/phone_050xxxxxxx</code>\n<i>أو بضغطة: <code>/identify</code></i>`
      );
      return;
    }
    const digits = raw.replace(/[^\d+]/g, "");
    if (digits.length < 9) {
      await sendMessage(chatId, "⚠️ رقم غير صالح — تأكد من كتابته صح.");
      return;
    }
    await setPhone(chatId, digits);
    await sendMessage(chatId, `✅ تم حفظ رقمك: <code>${escapeHtml(digits)}</code>`);
  });

  // /phone_<digits> — the number is part of the command token, so no space is
  // needed and Telegram registers it as one command.
  guarded(/^\/phone_(\d{9,15})$/, async ({ chatId, match }) => {
    const digits = match[1];
    await setPhone(chatId, digits);
    await sendMessage(chatId, `✅ تم حفظ رقمك: <code>${escapeHtml(digits)}</code>`);
  });

  // A contact shared through Telegram's button arrives here. The number came
  // from Telegram itself, so it is the bot's real identification of who it is
  // talking to — no typing, no dashboard, no chat id to copy anywhere.
  on("/contact", async ({ chatId, args, raw }) => {
    const digits = (args[0] || "").replace(/[^\d]/g, "");
    if (!digits) return;
    await hideKeyboard(chatId, `✅ وصل رقمك: <code>${escapeHtml(digits)}</code>`);
    const owner = await isOwnerOfStore(chatId);
    await upsertUser(chatId, {
      role: owner ? "owner" : "guest",
    }).catch(() => {});
    await sendMessage(
      chatId,
      [
        `✅ <b>عرفتك — رقمك: <code>${escapeHtml(digits)}</code></b>`,
        `دورك: <b>${owner ? "المالك" : "ضيف"}</b>`,
        "",
        owner
          ? "<i>أنت تتحكم بالبوت بالكامل — كل الأوامر والأزرار متاحة لك.</i>"
          : "<i>تستخدم البوت كضيف — تقدر تتصفح وتاخذ نسختك، لكن ما تعدّل الحساب.</i>",
      ].join("\n")
    );
  });

  // Ask for the number the easy way: one tap on Telegram's own contact
  // sheet, which is what @ppua-style bots use to read a caller's number.
  guarded("/identify", async ({ chatId }) => {
    await requestContact(
      chatId,
      [
        "📞 <b>عرف البوت مين معاه</b>",
        "",
        "اضغط الزر تحت — يرسل رقمك من تلجرام نفسه (ما تكتب شي).",
        "",
        "<i>الرقم يُستخدم لمعرفة دورك: مالك ولا ضيف.</i>",
      ].join("\n")
    );
  });

  // MEGA setup help. The illustrated walk-through was removed: the image
  // pipeline turned out to be unreliable in this curl setup, and a guide
  // that arrives as plain text says the same thing without a failure mode.
  // The account is owned by the bot and lives in the environment, so there
  // is little left to teach — just which variables to set.
  guarded("/guide", async ({ chatId }) => {
    await sendMessage(
      chatId,
      [
        "☁️ <b>MEGA — كيف يشتغل</b>",
        "",
        "البوت عنده حساب MEGA خاص فيه، مربوط من متغيرات البيئة:",
        "<code>MEGA_EMAIL</code> — إيميل الحساب",
        "<code>MEGA_PASSWORD</code> — كلمة السر",
        "<code>MEGA_RECOVERY_KEY</code> — مفتاح الاستعادة (اختياري)",
        "",
        "كل نسخة احتياطية تُرفع لمجلد <code>طويق-نسخ-احتياطي</code>،",
        "والبوت يرسلك رابط المجلد بعد كل نسخة.",
        "",
        "للتأكد إن الدخول يشتغل: <code>/mega_test</code>",
      ].join("\n")
    );
  });

  guarded("/logout", async ({ chatId }) => {
    const { clearCredentials } = await import("./store.js");
    await clearCredentials();
    await sendMessage(chatId, "👋 تم مسح الحساب. سجّل دخول من جديد من صفحة Render.");
  });

  guarded("/seen", async ({ chatId, args }) => {
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

  // Manual test of the proactive notifications: runs the scheduler once and
  // shows what fired, so the student can verify the morning briefing or the
  // exam countdown without waiting for 06:30.
  guarded("/proactive", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    await sendMessage(chatId, "📣 أجرب التنبيهات الذكية الحين…").catch(() => {});
    try {
      const { runScheduler } = await import("./scheduler.js");
      const res = await runScheduler({ send: (text) => sendMessage(chatId, text) });
      if (!res.morning && !res.exams && !res.grades) {
        await sendMessage(
          chatId,
          "✅ كل التنبيهات إما وصلت مسبقًا أو ما في شي جديد.\n\n<i>الصباحية تأتي مرة في اليوم، والاختبارات تتذكّر مرة واحدة لكل موعد.</i>"
        );
      }
    } catch (err) {
      await sendMessage(chatId, `⚠️ ما قدرت: <code>${esc(err.message)}</code>`);
    }
  });

  guarded("/reset", async ({ chatId }) => {
    await resetSeen();
    await sendMessage(chatId, "🧹 مُسح سجل المراقبة. كل عنصر سيعُد جديدًا في الفحصة الجاية.");
  });

  guarded("/due", async ({ chatId }) => {
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

  guarded("/dashboard", async ({ chatId }) => {
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

  // Sub-commands carry the filter in the token so no argument has to be
  // typed — "/assignments pending" becomes /assignments_pending.
  guarded("/assignments_pending", async (ctx) => assignmentsImpl(ctx, "pending"));
  guarded("/assignments_graded", async (ctx) => assignmentsImpl(ctx, "graded"));
  guarded("/assignments_overdue", async (ctx) => assignmentsImpl(ctx, "overdue"));
  guarded("/assignments", async (ctx) => assignmentsImpl(ctx, ctx.args[0]));

  async function assignmentsImpl({ chatId }, filter) {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const items = await fetchScope("assignments", tokens.accessToken);
    let rows = items;
    if (filter === "pending") rows = items.filter((a) => !["Graded", "Submitted"].includes(a.status));
    if (filter === "graded") rows = items.filter((a) => a.gradePoints != null || a.status === "Graded");
    if (filter === "overdue") rows = items.filter((a) => a.isOverdue);
    const label = { pending: "غير مسلّمة", graded: "المصححة", overdue: "المتأخرة" }[filter];
    await sendList(chatId, `📝 الواجبات${label ? ` — ${label}` : ""}`, rows, formatAssignment);
  }

  guarded("/materials", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    await sendList(chatId, "📚 المواد", await fetchScope("materials", tokens.accessToken), formatMaterial);
  });

  guarded("/exams", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    await sendList(chatId, "📄 الاختبارات المتاحة", await fetchScope("exams", tokens.accessToken), formatExam);
  });

  guarded("/grades", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    await sendList(chatId, "🏆 الدرجات", await fetchScope("grades", tokens.accessToken), formatGrade);
  });

  guarded("/courses", async ({ chatId }) => {
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

  guarded("/schedule_today", async (ctx) => scheduleImpl(ctx, "today"));
  guarded("/schedule", async (ctx) => scheduleImpl(ctx, ctx.args[0]));

  async function scheduleImpl({ chatId }, arg) {
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
    const onlyToday = arg === "today";
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
  }

  guarded("/attendance", async ({ chatId }) => {
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
  guarded("/notifications", async ({ chatId, args }) => {
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
  // /download_<n> — the material number is part of the token, so the command
  // stays a single word. /download still shows the picker.
  guarded(/^\/download_(\d+)$/, async (ctx) => downloadImpl(ctx, ctx.match[1]));
  guarded("/download", async (ctx) => downloadImpl(ctx, ctx.args[0]));

  async function downloadImpl({ chatId }, target) {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const materials = await fetchScope("materials", tokens.accessToken);
    if (!target) {
      // Show an inline picker so the user doesn't have to remember ids.
      const lines = ["📥 <b>تحميل مادة</b>", "", "اختر برقم من القائمة:"];
      materials.slice(0, 15).forEach((m, i) => {
        lines.push(`<code>${i + 1}</code> — ${esc(String(m.title).slice(0, 45))}`);
      });
      lines.push("", `<i>اكتب: <code>/download_3</code></i>`);
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
  }

  guarded("/unread", async ({ chatId }) => {
    if (!(await requireLogin(chatId))) return;
    const tokens = await getTokens();
    const count = await getUnreadCount(tokens.accessToken);
    const n = count?.count ?? count?.unreadCount ?? count;
    await sendMessage(chatId, `🔔 عندك <b>${n ?? 0}</b> إشعار غير مقروء.\nجرّب <code>/notifications</code>`);
  });

  // "show me everything" — one snapshot of the whole platform.
  guarded("/all", async ({ chatId }) => {
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
  guarded("/backup", async ({ chatId }) => {
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
    // If the student linked a MEGA folder, the same data is written there as
    // structured JSON, one file per scope under a dated folder. Without MEGA
    // configured in the environment this whole step is skipped and the
    // backup stays in Telegram.
    const { getMegaConfig, uploadSnapshot, uploadIndex } = await megaModule();
    const megaCfg = cfg.mega_enabled === false ? null : getMegaConfig();
    const dateLabel = new Date().toISOString().slice(0, 10);
    const snapshot = [];

    for (const [key, label, scope] of plan) {
      try {
        const items = await fetchScope(scope, tokens.accessToken);
        const live = (items || []).filter(
          (s) => String(s.status || "").toLowerCase() !== "cancelled"
        );
        const n = (key === "schedule" ? live : items || []).length;
        const word = n === 1 ? "عنصر واحد" : n === 2 ? "عنصرين" : `${n} عنصر`;

        if (megaCfg) {
          const idx = plan.findIndex((p) => p[0] === key);
          const payload = {
            scope: key,
            fetchedAt: new Date().toISOString(),
            count: n,
            items: key === "schedule" ? live : items || [],
          };
          try {
            const name = await uploadSnapshot({
              cfg: megaCfg,
              dateLabel,
              scopeIndex: idx,
              scopeName: scope,
              payload,
            });
            snapshot.push({ scope, file: name, count: n });
          } catch (err) {
            console.error(`mega upload failed for ${scope}:`, err.message);
          }
        }

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
    // The index file is written last, once every scope has landed, so the
    // dated folder describes itself fully. It also publishes a link to that
    // folder, which is the only URL the student needs.
    let megaLink = null;
    let megaError = null;
    // The folder the student pointed at is the one to open. The per-run link
    // megajs publishes is more precise but not always available, so it is
    // preferred and the configured folder is the fallback.
    const configuredLink = cfg.mega_folder_link || null;
    if (megaCfg && snapshot.length) {
      try {
        const res = await uploadIndex({
          cfg: megaCfg,
          dateLabel,
          entries: snapshot.map((s) => ({
            scope: s.scope,
            file: s.file,
            items: s.count,
            fetchedAt: new Date().toISOString(),
          })),
        });
        megaLink = res?.link || configuredLink;
      } catch (err) {
        // A failed cloud leg must not cost the backup itself: everything is
        // already in Telegram. Surface the reason so the student can fix the
        // credentials instead of guessing why the link stopped coming.
        console.error("mega index upload failed:", err.message);
        megaError = err.message || "فشل الرفع لـ MEGA";
      }
    }

    await sendMessage(
      chatId,
      [
        "✅ <b>تمت النسخة الاحتياطية</b>",
        `ناجح: ${totalCount.ok} | فشل: ${totalCount.fail}`,
        megaCfg && snapshot.length
          ? `☁️ MEGA: ${snapshot.length} ملف في مجلد <code>${dateLabel}</code>`
          : "☁️ MEGA: غير مربوط — قلّل فقط لـ تلجرام",
        megaError
          ? `⚠️ <b>MEGA فشل:</b> <code>${esc(megaError).slice(0, 150)}</code>\n<i>النسخة وصلت في تلجرام — أصلح MEGA من المتغيرات.</i>`
          : null,
        "",
        `<i>${
          cfg.backup_auto === false
            ? "التحديث التلقائي متوقف — شغّله من /backupcfg"
            : "التحديث التلقائي شغال مع كل فحص"
        }</i>`,
        megaLink ? "" : null,
        megaLink ? `🔗 <b>افتح النسخة في MEGA:</b>` : null,
        megaLink ? `<a href="${esc(megaLink)}">${esc(megaLink)}</a>` : null,
      ]
        .filter((x) => x !== null)
        .join("\n")
    );
  });

  // Backup settings panel: which scopes get copied, and in what shape. Same
  // button machinery as /settings, its own message so the two stay separate.
  guarded("/backupcfg", async ({ chatId }) => {
    const cfg = await getSettings(chatId);
    await sendBackupPanel(chatId, cfg);
  });

  // The backup panel is its own message, redrawn in place after each toggle
  // so the student watches the values move. It reuses the settings sub-page
  // mechanism with the "backup" section.
  async function sendBackupPanel(chatId, cfg) {
    await sendButtons(chatId, await backupPanelText(cfg), await backupRows(cfg, chatId));
  }

  async function backupPanelText(cfg) {
    return [
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
      `MEGA: ${cfg.mega_enabled === false ? "متوقف" : "شغال"}`,
      "",
      "<i>اضغط أي زر عشان تغيره — التغيير فوري.</i>",
    ].join("\n");
  }

  guarded("/help", async ({ chatId }) => {
    await sendMessage(chatId, HELP_TEXT);
  });

  // ===== MEGA: the bot's own backup destination =====
  // The account is owned by the bot and lives in the environment, so the
  // only commands that make sense here are reading state and testing the
  // login. There is no linking flow left to expose.

  async function megaModule() {
    return import("./mega.js");
  }

  guarded("/mega", async (ctx) => megaImpl(ctx, (ctx.args[0] || "").toLowerCase()));
  guarded("/mega_status", async (ctx) => megaImpl(ctx, "status"));
  guarded("/mega_test", async (ctx) => megaImpl(ctx, "test"));
  // Drops the cached MEGA session and any cool-down. Needed after the
  // credentials change in Render, where a stale session from the old password
  // would keep failing and keep the cool-down armed.
  guarded("/mega_reset", async (ctx) => {
    const { resetMegaSession } = await megaModule();
    resetMegaSession();
    await sendMessage(
      chatId,
      "🔄 تم مسح جلسة MEGA.\n<code>/mega_test</code> الحين يجرب الدخول من جديد."
    );
  });

  async function megaImpl({ chatId }, sub) {
    const { getMegaConfig, probeMega, isMegaConfigured } = await megaModule();

    if (sub === "off") {
      await sendMessage(
        chatId,
        "🔒 MEGA مربوط بمتغيرات البيئة في Render — ما يُفصل من هنا.\n<i>احذف MEGA_EMAIL و MEGA_PASSWORD من Render عشان توقفه.</i>"
      );
      return;
    }
    if (sub === "status" || !sub) {
      if (!isMegaConfigured()) {
        await sendMessage(
          chatId,
          [
            "💾 <b>حالة MEGA</b>",
            "غير مُعد الحين.",
            "",
            "MEGA يُربط من متغيرات البيئة في Render:",
            "<code>MEGA_EMAIL</code> — إيميل حساب MEGA",
            "<code>MEGA_PASSWORD</code> — كلمة السر",
            "<code>MEGA_RECOVERY_KEY</code> — مفتاح الاستعادة (اختياري)",
            "",
            "<i>كيف يشتغل: <code>/guide</code></i>",
          ].join("\n")
        );
        return;
      }
      const cfg = getMegaConfig();
      await sendMessage(
        chatId,
        `💾 <b>حالة MEGA</b>\nالوضع: مربوط ✅\nالإيميل: <code>${esc(cfg.email)}</code>\nمفتاح الاستعادة: ${
          cfg.recoveryKey ? "موجود ✅" : "غير محدد"
        }`
      );
      return;
    }
    if (sub === "test") {
      await sendMessage(chatId, "🧪 أجرب الدخول لحساب MEGA…").catch(() => {});
      const probe = await probeMega();
      if (!probe.ok) {
        // megajs reports a wrong email and a wrong password identically as
        // "object not found", and an unconfirmed account hangs, so the fix
        // is usually in the Render variables rather than the code.
        const raw = String(probe.error || "");
        const isAuth = /not found|wrong|expired|timeout|ما رد/i.test(raw);
        await sendMessage(
          chatId,
          [
            `⚠️ <b>فشل الدخول لـ MEGA</b>`,
            `<code>${esc(raw).slice(0, 150)}</code>`,
            "",
            isAuth
              ? [
                  "<b>الأسباب المحتملة:</b>",
                  "1️⃣ الإيميل <code>MEGA_EMAIL</code> غلط أو غير مُفعّل",
                  "2️⃣ كلمة السر <code>MEGA_PASSWORD</code> غلط",
                  "3️⃣ الحساب ما أكّد بالإيميل بعد",
                  "",
                  "<i>افتح MEGA، سجّل دخول يدويًا بنفس البيانات — لو ما قدرت، البوت كمان ما يقدر.</i>",
                ].join("\n")
              : null,
          ]
            .filter((x) => x !== null)
            .join("\n")
        );
        return;
      }
      await sendMessage(chatId, "✅ الدخول نجح! الحساب جاهز للنسخ الاحتياطي.");
      return;
    }
    await sendMessage(
      chatId,
      [
        "💾 <b>أوامر MEGA</b>",
        "/mega_status — الحالة",
        "/mega_test — تجربة الدخول",
        "",
        "<i>الربط يتم من متغيرات البيئة في Render.</i>",
      ].join("\n")
    );
  }

  // The callback behind the MEGA button on the backup panel, so the student
  // can reach the link flow without typing the command.
  onCallback("mega_help", async ({ chatId, queryId }) => {
    await answerCallbackQuery(queryId, "💾 انظر رسالة /mega");
    await sendMessage(
      chatId,
      [
        "💾 <b>ربط MEGA</b>",
        "MEGA ما يسمح بالرفع عن طريق الرابط — الرابط يعطي قراءة فقط.",
        "لازم البوت يدخل حسابك بالإيميل وكلمة السر.",
        "",
        "1️⃣ افتح حسابك في MEGA",
        "2️⃣ أرسل: <code>/mega email@example.com كلمةالسر</code>",
        "3️⃣ جرّب: <code>/mega_test</code>",
        "",
        "<i>🔒 الربط يتم من متغيرات البيئة في Render — ما تُرسل بالأوامر.</i>",
        "<i>كيف يشتغل MEGA: <code>/guide</code></i>",
      ].join("\n")
    );
  });

  // ===== AI: free-text chat =====
  // Any message that isn't a command is treated as a question for the AI.
  // It answers using a live snapshot of the platform as context.
  guarded("/ai", async ({ chatId, args, text }) => {
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
  guarded("/today", async ({ chatId }) => {
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
  // Every image command starts with /img_ so they group together in the
  // command menu. /img_grid is the API-driven week view; /img_site is the
  // table exactly as the platform draws it and the one the schedule
  // commands point at. The old /img_schedule is gone — one schedule image
  // command is enough, and the site-faithful one is it.
  guarded("/img_grid", async (ctx) => onImg(ctx, "grid"));
  guarded("/img_assignments", async (ctx) => onImg(ctx, "assignments"));
  guarded("/img_grades", async (ctx) => onImg(ctx, "grades"));
  guarded("/img_site", async (ctx) => siteImpl(ctx, "schedule"));

  // Legacy spellings still answer, so an existing habit does not break, but
  // they redirect to the single schedule image rather than rendering a
  // second, less faithful version of the same table.
  guarded("/img_schedule", async (ctx) => siteImpl(ctx, "schedule"));
  guarded("/site_schedule", async (ctx) => siteImpl(ctx, "schedule"));
  guarded("/site", async (ctx) => siteImpl(ctx, String(ctx.args[0] || "schedule")));

  async function siteImpl({ chatId }, scope) {
    if (!(await requireLogin(chatId))) return;
    if (scope !== "schedule") {
      await sendMessage(chatId, "📸 الحين يدعم: <code>/img_site</code>");
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
  }

  guarded("/remind_on", async (ctx) => remindImpl(ctx, "on"));
  guarded("/remind_off", async (ctx) => remindImpl(ctx, "off"));
  guarded("/remind", async (ctx) => remindImpl(ctx, String(ctx.args[0] || "").toLowerCase()));

  async function remindImpl({ chatId }, arg) {
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
        "<code>/remind_on</code> — تشغيل\n<code>/remind_off</code> — إيقاف"
    );
  }

  // Master switch for the "new item appeared" notifications.
  guarded("/newalerts_on", async (ctx) => newalertsImpl(ctx, "on"));
  guarded("/newalerts_off", async (ctx) => newalertsImpl(ctx, "off"));
  guarded("/newalerts", async (ctx) => newalertsImpl(ctx, String(ctx.args[0] || "").toLowerCase()));

  async function newalertsImpl({ chatId }, arg) {
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
        "<code>/newalerts_on</code> — تشغيل\n<code>/newalerts_off</code> — إيقاف"
    );
  }

  // Recall earlier conversation. The model only sees the last few exchanges
  // by default; this lets the student page back further on demand.
  // /history_<n> keeps the count in the token, so no space is needed.
  guarded(/^\/history_(\d+)$/, async ({ chatId, match }) => historyImpl(chatId, Number(match[1])));
  guarded("/history", async (ctx) => historyImpl(ctx.chatId, Number(ctx.args[0]) || 10));

  async function historyImpl(chatId, n) {
    const count = Math.min(n || 10, 20);
    const rows = getHistory(chatId, count);
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
  }

  guarded("/forget", async ({ chatId }) => {
    clearMemory(chatId);
    await sendMessage(chatId, "🧹 نسيت المحادثة السابقة.\n\n<i>ابدأ من جديد — أسمعك.</i>");
  });

  // Send a rendered PNG image of a scope — schedule, assignments or grades.
  guarded("/img", async ({ chatId, args }) => {
    // "schedule" is not a scope here anymore — /img_site is the one schedule
    // image, so a bare /img points at it rather than rendering a second
    // version of the same table.
    const scope = args[0] || "site";
    if (scope === "schedule") return siteImpl({ chatId }, "schedule");
    await onImg({ chatId }, scope);
  });

  // Telegram commands can't contain spaces, so multi-word scopes are joined
  // with an underscore — they register cleanly and show as one command.
  // Shared by /img <scope> and the /img_<scope> shortcuts.
  async function onImg({ chatId }, scope) {
    if (!(await requireLogin(chatId))) return;
    const valid = ["assignments", "grades", "grid"];
    if (!valid.includes(scope)) {
      await sendMessage(
        chatId,
        "🖼 <b>الصور</b>\n\n<code>/img_site</code> — الجدول مثل ما يظهر في المنصة بالضبط\n<code>/img_grid</code> — شبكة الأيام والأوقات\n<code>/img_assignments</code> — الواجبات\n<code>/img_grades</code> — الدرجات"
      );
      return;
    }
    const tokens = await getTokens();
    // Human-readable labels so every step announces itself — the student
    // should never watch the bot go quiet while it fetches and renders.
    const STEP = {
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

  // One sub-command per scope, so the export is one token.
  const EXPORT_SCOPES = ["assignments", "materials", "exams", "grades", "courses", "schedule", "notifications"];
  for (const scope of EXPORT_SCOPES) {
    guarded(`/export_${scope}`, async (ctx) => exportImpl(ctx, scope));
  }
  guarded("/export", async (ctx) => exportImpl(ctx, String(ctx.args[0] || "")));

  async function exportImpl({ chatId }, scope) {
    if (!(await requireLogin(chatId))) return;
    const valid = EXPORT_SCOPES;
    if (!valid.includes(scope)) {
      await sendMessage(
        chatId,
        "📥 <b>تصدير JSON</b>\n\nالاستعمال: <code>/export_&lt;نطاق&gt;</code>\n\nالنطاقات المتاحة:\n<code>" +
          valid.map((s) => `/export_${s}`).join("</code> · <code>") +
          "</code>"
      );
      return;
    }
    const tokens = await getTokens();
    const items = await fetchScope(scope, tokens.accessToken);
    await sendMessage(chatId, `<code>${esc(JSON.stringify(items, null, 1).slice(0, 3800))}</code>`);
  }
}

const HELP_TEXT = `<b>🤖 أوامر بوت طويق</b>

📫 <b>تواصل مع البوت:</b> <code>twqbot@duck.com</code>

<b>🌟 الأساسيات:</b>
/all — كل شي في المنصة
/dashboard — ملخص سريع من لوحة طويق
/today — حصص اليوم بس
/backup — 💾 <b>نسخة احتياطية كاملة</b>
/help — هذه القائمة

<b>📚 لكل نطاق:</b>
/assignments — الواجبات
/assignments_pending — الواجبات المعلّقة
/assignments_graded — الواجبات المُصحَّحة
/assignments_overdue — الواجبات المتأخرة
/materials — كل المواد
/exams — الاختبارات المتاحة
/grades — كل الدرجات
/courses — مقرراتي (مع الحضور والدرجات)
/schedule — الجدول الأسبوعي
/schedule_today — حصص اليوم
/attendance — نسبة الحضور
/notifications — الإشعارات
/unread — عدد الإشعارات غير المقروءة
/due — الواجبات المستحقة خلال ٢٤ ساعة
/download_12 — تحميل مادة برقمها

<b>📸 الصور (كلها /img_):</b>
/img_site — <b>الجدول مثل المنصة بالضبط</b>
/img_grid — الجدول بشبكة الأيام والأوقات
/img_assignments — الواجبات كصورة
/img_grades — الدرجات كصورة

<b>📣 التنبيهات الذكية:</b>
/proactive — جرّبها الحين
<i>الصباحية كل يوم ٦:٣٠ ص + عدّاد الاختبارات + تغيّر الدرجات</i>
<i>تشغّلها وتطفّيها من /settings</i>

<b>⏰ التنبيهات:</b>
/remind_on — تنبيه "باقيلك بس يوم"
/remind_off — إيقاف تنبيه اليوم
/newalerts_on — تنبيهات الشي الجديد
/newalerts_off — إيقاف تنبيهات الجديد
/history_10 — استرجع آخر ١٠ محادثات
/forget — امسح ذاكرة المحادثة
/export_grades — تصدير JSON لأي نطاق

<b>🤖 الذكاء الاصطناعي:</b>
/ai — حالة الذكاء وإعداداته
<i>أي كلام بدون / — اسأله أي شي عن منصتك!</i>

<b>🛠 التحكم:</b>
/status — حالة البوت
/check — فحص فوري
/fresh — ✅ أثبت إن البيانات من المنصة الحين
/settings — ⚙️ لوحة الإعدادات (أزرار)
/backupcfg — 💾 إعدادات النسخة الاحتياطية (أزرار)
/watch — قائمة النطاقات وحالتها
/watch_assignments_on — شغّل مراقبة الواجبات
/watch_assignments_off — أوقف مراقبة الواجبات
/interval_15 — تغيير دقيقة الفحص (٥–١٢٠)
/seen — آخر ما رُصد
/reset — مسح السجل

<b>☁️ MEGA (نسخ احتياطي سحابي):</b>
/guide — 📚 <b>كيف يشتغل MEGA</b>
/mega_status — حالة الاتصال
/mega_test — تجربة الدخول
/mega_reset — مسح الجلسة بعد تغيير كلمة السر
<i>الربط من متغيرات البيئة: MEGA_EMAIL و MEGA_PASSWORD</i>

<b>👤 الحساب:</b>
/identify — 🆕 <b>عرّف البوت بنفسك</b> (زر مشاركة الرقم)
/phone_050xxxxxxx — حفظ أو تغيير رقمك
/who — رقمك، دورك، وحالة MEGA
/logout — تسجيل الخروج

<i>💡 كل الأوامر بدون مسافة — اكتبها بالضبط مثل ما هي مكتوبة.</i>`;

// --- boot ---------------------------------------------------------------------
// Supabase free tier can take a few seconds to wake from auto-pause, and fresh
// Render instances hit transient routing errors. Retry the DB-backed steps and
// always start the web server so Render's health check has something to hit.
async function mainWithRetry() {
  // megajs raises login failures as stray rejections from its own internals
  // instead of an error event a caller can await, so a wrong MEGA password
  // would otherwise kill the process mid-command. Log and keep running: a
  // failed backup is recoverable, a dead bot is not.
  process.on("unhandledRejection", (reason) => {
    console.warn("unhandledRejection:", String(reason?.message || reason).slice(0, 200));
  });
  process.on("uncaughtException", (err) => {
    console.warn("uncaughtException:", String(err?.message || err).slice(0, 200));
  });

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

  // Keep the Render free-tier instance warm: the service sleeps after 15 min
  // of no inbound traffic, and a self-ping every 13 min is enough to count.
  startSelfPing();

  if (!process.env.TELEGRAM_CHAT_ID) {
    console.warn("TELEGRAM_CHAT_ID missing — send /start to the bot and set it as env var");
  }
}

mainWithRetry().catch((err) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});
