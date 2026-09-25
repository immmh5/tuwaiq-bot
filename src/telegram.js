// src/telegram.js — minimal Telegram Bot API client (long polling)
import { fetchJson } from "./http.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const API = "https://api.telegram.org";

// The bot's own contact address. Set as an env var so it can be re-pointed
// without a redeploy, with the permanent address as the default.
export const BOT_EMAIL = process.env.BOT_EMAIL || "twqbot@duck.com";

// Run curl with the given args and return { status, text }.
// Used for multipart uploads (photos) that the JSON helper can't express.
function curlRaw(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, { env: process.env });
    let out = Buffer.alloc(0);
    let err = "";
    child.stdout.on("data", (c) => (out = Buffer.concat([out, c])));
    child.stderr.on("data", (c) => (err += c.toString()));
    child.on("error", () => reject(new Error("curl binary not found")));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`curl exited ${code}: ${err.trim()}`));
      const text = out.toString("utf-8");
      const m = text.match(/__STATUS__:(\d+)/);
      resolve({ status: m ? Number(m[1]) : 200, text });
    });
  });
}

let token = null;
let offset = 0;
let handlers = new Map();
let polling = false;

export function setTelegramToken(t) {
  token = t;
}

export function on(command, fn) {
  handlers.set(command, fn);
}

// Look a registered command back up, so a button can invoke the same
// handler the text command uses instead of duplicating its body.
export function getHandler(command) {
  return handlers.get(command);
}

// Resolve the handler for a command token, including regex-registered
// commands like /phone_0501234567. Returns { fn, match } or null.
export function resolveHandler(key) {
  const exact = handlers.get(key);
  if (exact) return { fn: exact, match: null };
  for (const [pattern, fn] of handlers.entries()) {
    if (pattern instanceof RegExp) {
      const m = key.match(pattern);
      if (m) return { fn, match: m };
    }
  }
  return null;
}

export async function sendMessage(chatId, text, extra = {}) {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  };
  const res = await globalThis.fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram error: ${JSON.stringify(data).slice(0, 200)}`);
  return data.result;
}

// Rewrite a message already sent, so progress updates replace each other
// instead of stacking up in the chat. Falls back silently if the edit fails.
export async function editMessageText(messageId, chatId, text) {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const res = await globalThis.fetch(`${API}/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram error: ${JSON.stringify(data).slice(0, 200)}`);
  return data.result;
}
//
// Why curl and not globalThis.fetch: sendMessage goes through the app's
// curl-based transport, which is what reaches api.telegram.org from the
// Render container. sendPhoto previously called raw fetch, which failed
// silently — the tool reported success and the student never got the image.
export async function sendPhoto(chatId, pngBuffer, caption = "") {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("photo", new Blob([pngBuffer], { type: "image/png" }), "tuwaiq.png");
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  }
  // curl multipart: -F builds the form from key=value pairs; the photo is
  // streamed from a temp file so binary bytes survive intact.
  const tmp = path.join(os.tmpdir(), `tuwaiq-${Date.now()}.png`);
  await fs.writeFile(tmp, pngBuffer);
  try {
    const args = [
      "-sS", "--show-error", "--compressed", "-L",
      "--max-time", "60",
      // http.js parses the same marker; keep the wire format identical.
      "-w", "\n__STATUS__:%{http_code}",
      "-F", `chat_id=${chatId}`,
      // curl sniffs the PNG type from the file itself. Adding ";type=image/png"
      // breaks here: curl treats ";" as a parameter separator, and on the
      // deployment's curl the token boundary lands mid-path, surfacing as
      // "Failed to open/read local data" (exit 26) even though the file
      // exists. A quoted spec also works, but relying on sniffing is one
      // moving part fewer.
      "-F", `photo=@${tmp}`,
    ];
    if (caption) {
      // -F treats < and > in a value as an instruction to read the field body
      // from a file, so an HTML caption like "<b>1</b>" fails the whole
      // request with exit 26 before the photo is sent. --form-string takes
      // the value literally, which is what a caption needs.
      args.push("--form-string", `caption=${caption}`);
      args.push("-F", "parse_mode=HTML");
    }
    args.push(`${API}/bot${token}/sendPhoto`);
    const { status, text } = await curlRaw(args);
    // curlRaw appends the __STATUS__ marker to the body; strip it before
    // parsing or a successful upload is misread as a failure. (This was
    // reporting "couldn't deliver" for photos that had already arrived.)
    const body = text.replace(/__STATUS__:\d*\s*$/, "").trim();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      data = { ok: false, description: body.slice(0, 200) };
    }
    if (!data.ok) throw new Error(`telegram error: ${JSON.stringify(data).slice(0, 300)}`);
    return data.result;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

// Long-poll loop. One call per bot instance; run in the background.
export async function startPolling() {
  if (!token || polling) return;
  polling = true;
  // Drop pending updates from previous runs
  offset = 0;
  let conflicts = 0;
  while (polling) {
    try {
      const updates = await getUpdates(offset, 60);
      conflicts = 0;
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.callback_query) handleCallback(u);
        else handleMessage(u);
      }
    } catch (err) {
      // Two pollers on the same token fight. Back off progressively, but
      // never permanently give up — the loop heals itself once the stale
      // instance is gone, which is what keeps the bot responsive.
      if (/409|Conflict/.test(err.message)) {
        conflicts++;
        console.error(`telegram poll conflict (${conflicts}) — another instance may be running`);
        const backoff = Math.min(5000 * conflicts, 30000);
        await sleep(backoff);
        conflicts = 0; // forgive; a transient burst shouldn't kill the bot
        continue;
      }
      console.error("telegram poll error:", err.message);
      await sleep(5000);
    }
  }
}

export function stopPolling() {
  polling = false;
}

// Is the poll loop currently alive? Exposed for /health so the student can
// tell "bot is up" from "bot is running but deaf".
export function isPolling() {
  return polling;
}

// Self-healing watchdog: if the poll loop ever exits (crash, OOM kill of the
// task, unrecoverable error), this restarts it within a minute. Without it
// the bot silently goes deaf and stays deaf until a redeploy.
export function startWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(() => {
    if (!polling && token) {
      console.error("poll loop died — watchdog restarting it");
      startPolling().catch((e) => console.error("watchdog restart failed:", e.message));
    }
  }, 60000);
}

let watchdog = null;

async function getUpdates(offsetValue, timeout) {
  const url = new URL(`${API}/bot${token}/getUpdates`);
  url.searchParams.set("offset", String(offsetValue));
  url.searchParams.set("timeout", String(timeout));
  url.searchParams.set("allowed_updates", JSON.stringify(["message", "callback_query"]));
  // Must go through the curl transport: raw fetch cannot reliably reach
  // api.telegram.org from the container, and a failed long-poll silently
  // kills the loop — the bot then ignores every message until restart.
  const data = await fetchJson(url.toString(), { method: "GET", timeout: timeout + 20 });
  if (!data.ok) throw new Error(`getUpdates: ${JSON.stringify(data).slice(0, 150)}`);
  return data.result;
}

function handleMessage(update) {
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;

  // Remember the last chat that messaged the bot so the owner can look it up
  // at /api/whoami and paste it into TELEGRAM_CHAT_ID.
  import("./store.js")
    .then(({ setKv }) => setKv("last_chat_id", String(chatId)))
    .catch(() => {});

  // A shared contact arrives as its own message type, not as text. Telegram
  // only hands over a phone number when the person taps the button, so this
  // is the bot learning the number from Telegram itself rather than being
  // told it. The number is normalised to digits so it compares reliably
  // against the configured owner number.
  if (msg.contact) {
    const raw = String(msg.contact.phone_number || "");
    const digits = raw.replace(/[^\d]/g, "");
    import("./store.js")
      .then(({ setPhone, upsertUser }) =>
        Promise.all([setPhone(chatId, digits), upsertUser(chatId)]),
      )
      .then(() => {
        const fn = handlers.get("/contact");
        if (fn) fn({ chatId, args: [digits], text: "", raw: msg });
      })
      .catch(() => {});
    return;
  }

  if (!msg.text) return;
  const text = msg.text.trim();

  // Only the owner chat is allowed to control the bot.
  const allowed = process.env.TELEGRAM_CHAT_ID
    ? String(chatId) === String(process.env.TELEGRAM_CHAT_ID)
    : true;

  if (!allowed) {
    sendMessage(chatId, "🚫 هذا البوت غير مخصص لك.").catch(() => {});
    return;
  }

  const [cmd, ...args] = text.split(/\s+/);
  const key = cmd.toLowerCase().replace(/@.+$/, "");

  // Regex commands (/phone_0501234567) resolve through the matcher; plain
  // commands still take the fast exact path.
  const resolved = resolveHandler(key);
  if (resolved) {
    Promise.resolve(
      resolved.fn({ chatId, args, text, raw: msg, match: resolved.match }),
    ).catch((err) => {
      sendMessage(chatId, `⚠️ خطأ: <code>${escapeHtml(err.message)}</code>`).catch(() => {});
    });
  } else if (key === "/start") {
    printHelp(chatId);
  } else if (key.startsWith("/")) {
    sendMessage(
      chatId,
      `❓ أمر ما أعرفه: <code>${escapeHtml(key)}</code>\nجرّب <code>/help</code> لقائمة كل الأوامر.`
    ).catch(() => {});
  } else {
    // Free text → the AI layer (if enabled). Keeps the command UX untouched.
    // A swallowed error here presents as "ثواني…" then silence, so report it.
    Promise.resolve(aiHandler?.({ chatId, text })).catch((err) => {
      sendMessage(
        chatId,
        `⚠️ انقطع الجواب: <code>${escapeHtml(String(err.message || err)).slice(0, 200)}</code>\n\n<i>جرّب مرة ثانية.</i>`
      ).catch(() => {});
    });
  }
}

// Registered by index.js when the AI module is wired up.
export let aiHandler = null;
export function setAIHandler(fn) {
  aiHandler = fn;
}

// ---- Inline buttons ---------------------------------------------------------
// Telegram "callback" buttons: a press sends an update the bot answers. The
// settings panel and quick actions ride on this so the student drives the
// bot by tapping instead of typing commands.
const callbackHandlers = new Map();

export function onCallback(action, fn) {
  callbackHandlers.set(action, fn);
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const res = await globalThis.fetch(`${API}/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram error: ${JSON.stringify(data).slice(0, 200)}`);
  return data.result;
}

// Send a message with inline buttons. rows is an array of rows, each a list
// of { label, action } — action lands in callback_query.data on tap.
export async function sendButtons(chatId, text, rows, extra = {}) {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const reply_markup = {
    inline_keyboard: rows.map((row) =>
      row.map((b) => ({
        text: b.label,
        callback_data: String(b.action).slice(0, 64),
      }))
    ),
  };  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup,
    ...extra,
  };
  const res = await globalThis.fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram error: ${JSON.stringify(data).slice(0, 200)}`);
  return data.result;
}

// Ask the person to share their own phone number. Telegram only reveals a
// number this way — a bot cannot read it from a chat — and the button
// surfaces a one-tap system sheet rather than asking them to type digits.
// This is how the bot learns who it is talking to.
export async function requestContact(chatId, text) {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: {
      keyboard: [
        [
          {
            text: "📞 مشاركة رقمي",
            request_contact: true,
          },
        ],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  };
  const res = await globalThis.fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram error: ${JSON.stringify(data).slice(0, 200)}`);
  return data.result;
}

// Clear the contact keyboard once the number is in, so the button does not
// linger on screen after it has served its purpose.
export async function hideKeyboard(chatId, text = "✅ تم") {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const res = await globalThis.fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: { remove_keyboard: true },
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram error: ${JSON.stringify(data).slice(0, 200)}`);
  return data.result;
}

// Rewrite an existing message's text and buttons together.
export async function editMessage(messageId, chatId, text, rows) {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const reply_markup = rows
    ? {
        inline_keyboard: rows.map((row) =>
          row.map((b) => ({
            text: b.label,
            callback_data: String(b.action).slice(0, 64),
          }))
        ),
      }
    : undefined;
  const res = await globalThis.fetch(`${API}/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(reply_markup ? { reply_markup } : {}),
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram error: ${JSON.stringify(data).slice(0, 200)}`);
  return data.result;
}

function handleCallback(update) {
  const cq = update.callback_query;
  if (!cq) return;
  const chatId = cq.message?.chat?.id;
  const data = cq.data || "";
  const messageId = cq.message?.message_id;

  const allowed = process.env.TELEGRAM_CHAT_ID
    ? String(chatId) === String(process.env.TELEGRAM_CHAT_ID)
    : true;
  if (!allowed) {
    answerCallbackQuery(cq.id, "🚫 غير مسموح").catch(() => {});
    return;
  }

  // callback_data carries an optional argument: "action:value".
  const [action, ...rest] = data.split(":");
  const fn = callbackHandlers.get(action);
  if (fn) {
    Promise.resolve(fn({ chatId, messageId, arg: rest.join(":"), queryId: cq.id }))
      .catch((err) => {
        answerCallbackQuery(cq.id, "⚠️ " + String(err.message).slice(0, 180)).catch(() => {});
      });
  } else {
    answerCallbackQuery(cq.id, "❓ ما أعرف هذا الزر").catch(() => {});
  }
}

function printHelp(chatId) {
  const help = [
    "<b>🤖 بوت طويق — المراقب الذكي</b>",
    "",
    "<b>📫 تواصل مع البوت:</b>",
    `<code>${BOT_EMAIL}</code>`,
    "",
    "<b>المراقبة:</b>",
    "/status — حالة الاتصال وآخر فحص",
    "/check — افحص الحين (بدون انتظار)",
    "",
    "<b>التحكم بالنطاقات:</b>",
    "/watch — قائمة النطاقات وحالتها",
    "/watch <code>&lt;نطاق&gt; on|off</code> — تشغيل/إطفاء نطاق",
    "النطاقات: <code>assignments</code> <code>materials</code> <code>exams</code> <code>grades</code>",
    "",
    "<b>الجدولة:</b>",
    "/interval — كم دقيقة بين كل فحصة",
    "/interval <code>&lt;دقائق&gt;</code> — تغيير المدة (٥–١٢٠)",
    "",
    "<b>الحساب:</b>",
    "/who — مين مسجل دخول حاليًا",
    "/logout — تسجيل خروج ومسح البيانات",
    "",
    "<b>السجل:</b>",
    "/seen — آخر الأشياء اللي تنبهت عليها",
    "/seen <code>&lt;نطاق&gt;</code> — تصفية حسب النطاق",
    "/reset — مسح السجل (راح ينبه على كل شي مرة ثانية)",
    "",
    "<b>تنبيهات الجدول:</b>",
    "/due — واجبات مستحقة خلال ٢٤ ساعة",
  ].join("\n");
  sendMessage(chatId, help).catch(() => {});
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
