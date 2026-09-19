// src/telegram.js — minimal Telegram Bot API client (long polling)
import { fetchJson } from "./http.js";

const API = "https://api.telegram.org";

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
        handleMessage(u);
      }
    } catch (err) {
      // Two pollers on the same token fight forever. Back off progressively so
      // the losing instance doesn't hammer the API; after repeated 409s it
      // stops polling entirely and the surviving instance takes over cleanly.
      if (/409|Conflict/.test(err.message)) {
        conflicts++;
        console.error(`telegram poll conflict (${conflicts}) — another instance may be running`);
        if (conflicts >= 6) {
          console.error("too many poll conflicts; this instance stops polling");
          polling = false;
          return;
        }
        await sleep(5000 * conflicts);
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

async function getUpdates(offsetValue, timeout) {
  const url = new URL(`${API}/bot${token}/getUpdates`);
  url.searchParams.set("offset", String(offsetValue));
  url.searchParams.set("timeout", String(timeout));
  url.searchParams.set("allowed_updates", JSON.stringify(["message"]));
  const res = await globalThis.fetch(url, { method: "GET" });
  const data = await res.json();
  if (!data.ok) throw new Error(`getUpdates: ${JSON.stringify(data).slice(0, 150)}`);
  return data.result;
}

function handleMessage(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const text = msg.text.trim();
  const chatId = msg.chat.id;

  // Remember the last chat that messaged the bot so the owner can look it up
  // at /api/whoami and paste it into TELEGRAM_CHAT_ID.
  import("./store.js")
    .then(({ setKv }) => setKv("last_chat_id", String(chatId)))
    .catch(() => {});

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

  const fn = handlers.get(key);
  if (fn) {
    Promise.resolve(fn({ chatId, args, text, raw: msg })).catch((err) => {
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
    aiHandler?.({ chatId, text }).catch(() => {});
  }
}

// Registered by index.js when the AI module is wired up.
export let aiHandler = null;
export function setAIHandler(fn) {
  aiHandler = fn;
}

function printHelp(chatId) {
  const help = [
    "<b>🤖 بوت طويق — المراقب الذكي</b>",
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
