// src/web.js — express app: login page + health + JSON api for the dashboard
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  saveCredentials,
  getCredentials,
  clearCredentials,
  getKv,
  setKv,
  saveTokens,
  getTokens,
  listSeen,
  resetSeen,
} from "./store.js";
import { login, decodeToken } from "./auth.js";
import { runCheckOnce, getWatcherState, startWatcher, stopWatcher } from "./watcher.js";
import { sendMessage, isPolling, startWatchdog } from "./telegram.js";

// Lightweight Telegram reachability check: tries to reach the chat without
// posting anything visible (getChat works for private chats the bot knows).
async function probeTelegram(chatId) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return false;
    const url = `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return false;
    const d = await r.json();
    return d.ok === true;
  } catch {
    return false;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createWebApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use("/static", express.static(path.join(__dirname, "public")));

  // --- health check for Render / uptime monitors ---
  // Render requires a 2xx here or the deploy never succeeds. "No account yet"
  // is a valid state (the user hasn't logged in), not a service failure — so we
  // return 200 and surface the linkage state in the payload. Real failures
  // (process alive but DB unreachable) still report degraded.
  app.get("/health", async (_req, res) => {
    try {
      const creds = await getCredentials();
      const tokens = await getTokens();
      const state = getWatcherState();
      res.status(200).json({
        status: creds ? "ok" : "no_account",
        loggedIn: !!creds,
        tokenValid: !!(tokens?.accessToken && tokens.accessExpiresAt > Date.now() / 1000),
        watcher: state,
        time: new Date().toISOString(),
      });
    } catch (err) {
      // Store may be briefly unavailable (auto-paused Supabase waking up).
      // Still answer 200 so Render doesn't kill the deploy.
      res.status(200).json({
        status: "degraded",
        error: err.message,
        time: new Date().toISOString(),
      });
    }
  });

  // --- login page ---
  app.get("/", async (_req, res) => {
    try {
      const creds = await getCredentials();
      if (creds) {
        const id = await getKv("identity", null);
        const state = getWatcherState();
        return res.send(loggedInPage(id, state));
      }
    } catch (err) {
      return res.send(errorPage(`قاعدة البيانات غير متاحة: ${err.message}`));
    }
    return res.sendFile(path.join(__dirname, "public", "login.html"));
  });

  app.post("/login", async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).send(errorPage("الإيميل والباسوورد مطلوبين"));
    }
    try {
      const tokens = await login(username, password);
      await saveCredentials(username, password);
      await saveTokens(tokens);
      const parsed = decodeToken(tokens.accessToken);
      const identity = {
        name: parsed?.name || parsed?.given_name || null,
        email: parsed?.email || parsed?.preferred_username || username,
        loggedAt: new Date().toISOString(),
      };
      await setKv("identity", identity);
      startWatcher();
      try {
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (chatId) {
          await sendMessage(
            chatId,
            `✅ <b>تم تسجيل الدخول بنجاح</b>\n👤 ${identity.name || identity.email}\n\nالبوت يراقب الحين. استخدم /status للتأكد.`
          );
        }
      } catch (e) {
        console.log("telegram notify failed:", e.message);
      }
      return res.send(successPage(identity));
    } catch (err) {
      return res.status(401).send(errorPage(err.message));
    }
  });

  app.post("/logout", async (_req, res) => {
    stopWatcher();
    await clearCredentials();
    res.send(loggedOutPage());
  });

  app.post("/check", async (_req, res) => {
    const r = await runCheckOnce();
    res.json(r);
  });

  // --- dashboard data ---
  // --- control endpoints (used by the MCP integration / external scripts) ---
  // Protected with a shared secret so only the owner can drive the bot.
  app.use("/ctl", (req, res, next) => {
    const secret = process.env.CONTROL_SECRET;
    if (!secret) return res.status(503).json({ error: "CONTROL_SECRET not configured" });
    const auth = req.headers.authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (token !== secret) return res.status(401).json({ error: "unauthorized" });
    next();
  });

  app.get("/ctl/status", async (_req, res) => {
    const creds = await getCredentials();
    const identity = await getKv("identity", null);
    const config = await getKv("watch_config", {
      assignments: true,
      materials: true,
      exams: true,
      grades: true,
    });
    res.json({
      running: getWatcherState().running,
      loggedIn: !!creds,
      identity,
      config,
      watcher: getWatcherState(),
      intervalMin: Number(process.env.CHECK_INTERVAL_MIN) || 10,
    });
  });

  app.post("/ctl/pause", async (_req, res) => {
    stopWatcher();
    res.json({ ok: true, running: false, message: "watcher paused" });
  });

  app.post("/ctl/resume", async (_req, res) => {
    const creds = await getCredentials();
    if (!creds) return res.status(400).json({ ok: false, error: "no account linked" });
    startWatcher();
    res.json({ ok: true, running: true, message: "watcher resumed" });
  });

  app.post("/ctl/check", async (_req, res) => {
    const r = await runCheckOnce();
    res.json(r);
  });

  app.post("/ctl/watch", async (req, res) => {
    const { scope, enabled } = req.body || {};
    const valid = ["assignments", "materials", "exams", "grades"];
    if (!valid.includes(scope) || typeof enabled !== "boolean") {
      return res.status(400).json({ error: "bad request; need scope + boolean enabled" });
    }
    const config = await getKv("watch_config", {});
    config[scope] = enabled;
    await setKv("watch_config", config);
    res.json({ ok: true, config });
  });

  app.get("/ctl/seen", async (req, res) => {
    const rows = await listSeen(Number(req.query.limit) || 20, req.query.kind || null);
    res.json(rows);
  });

  app.post("/ctl/reset", async (_req, res) => {
    await resetSeen();
    res.json({ ok: true, message: "seen log cleared" });
  });

  // --- telegram chat id discovery ---
  // The owner sends /start to the bot; this endpoint shows the chat id that
  // last messaged it so it can be pasted into TELEGRAM_CHAT_ID on Render.
  app.get("/api/whoami", async (_req, res) => {
    const chatId = await getKv("last_chat_id", null);
    res.json({ chatId, configured: process.env.TELEGRAM_CHAT_ID || null });
  });

  app.get("/api/state", async (_req, res) => {
    const creds = await getCredentials();
    const identity = await getKv("identity", null);
    const config = await getKv("watch_config", null);
    const seen = await listSeen(6, null);
    // probe Telegram once: a chat id that can't receive messages is the most
    // common misconfiguration, so surface it on the dashboard.
    let telegramOk = null;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (chatId) {
      telegramOk = await probeTelegram(chatId);
    }
    res.json({
      loggedIn: !!creds,
      identity,
      config,
      seen,
      telegramOk,
      // Surface the poll loop's liveness — "up" and "listening" differ.
      polling: isPolling(),
      watcher: getWatcherState(),
      intervalMin: Number(process.env.CHECK_INTERVAL_MIN) || 10,
    });
  });

  app.post("/api/config", async (req, res) => {
    const { scope, enabled } = req.body || {};
    const valid = ["assignments", "materials", "exams", "grades"];
    if (!valid.includes(scope) || typeof enabled !== "boolean") {
      return res.status(400).json({ error: "bad request" });
    }
    const config = await getKv("watch_config", {});
    config[scope] = enabled;
    await setKv("watch_config", config);
    res.json({ ok: true, config });
  });

  app.get("/api/seen", async (req, res) => {
    const kind = req.query.kind || null;
    const rows = await listSeen(50, kind);
    res.json(rows);
  });

  app.post("/api/reset", async (_req, res) => {
    await resetSeen();
    res.json({ ok: true });
  });

  return app;
}

// --- inline HTML pages (kept tiny so the whole bot is a few files) -----------

function head(title) {
  return `<!doctype html><html lang="ar" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — بوت طويق</title>
<link rel="stylesheet" href="/static/style.css"></head><body>
<div class="wrap">`;
}
function foot() {
  return `</div></body></html>`;
}

function errorPage(msg) {
  return `${head("خطأ")}
<div class="card error"><h2>⚠️ تعذّر تسجيل الدخول</h2>
<p>${escape(msg)}</p>
<a class="btn" href="/">رجوع</a></div>${foot()}`;
}

function successPage(identity) {
  return `${head("تم")}
<div class="card ok"><h2>✅ تم ربط الحساب</h2>
<p>أهلًا <b>${escape(identity.name || identity.email)}</b> — البوت يراقب منصتك الحين.</p>
<p class="muted">غلق هذه الصفحة لا يوقف البوت. التنبيهات تروح على تلجرام.</p>
<a class="btn" href="/">اللوحة</a></div>${foot()}`;
}

function loggedOutPage() {
  return `${head("تم الخروج")}
<div class="card"><h2>👋 تم تسجيل الخروج</h2>
<p>تم مسح بياناتك. سجّل دخول من جديد لما تبي ترجع البوت.</p>
<a class="btn" href="/">تسجيل دخول</a></div>${foot()}`;
}

function loggedInPage(identity, state) {
  const lastCheck = state.lastCheck
    ? new Date(state.lastCheck).toLocaleString("ar-SA", { timeZone: "Asia/Riyadh" })
    : "لم يفحص بعد";
  const err = state.lastError ? `<div class="card error"><b>آخر خطأ:</b> ${escape(state.lastError)}</div>` : "";
  return `${head("لوحة التحكم")}
<div class="card">
  <div class="row"><h2>🤖 بوت طويق شغّال</h2>
  <span class="badge ok">متصل</span></div>
  <p>المستخدم: <b>${escape(identity?.name || identity?.email || "—")}</b></p>
  <p class="muted">آخر فحص: ${escape(lastCheck)}</p>
  <div class="row">
    <form method="post" action="/check"><button class="btn">🔍 افحص الحين</button></form>
    <form method="post" action="/logout" onsubmit="return confirm('متأكد من تسجيل الخروج؟')">
      <button class="btn danger">🚪 تسجيل الخروج</button></form>
  </div>
</div>
<div class="card" id="status-card"><p class="muted">جاري تحميل الحالة…</p></div>
<div class="card" id="seen-card"><p class="muted">جاري تحميل آخر العناصر…</p></div>
${err}
<script>${DASHBOARD_JS}</script>
${foot()}`;
}

// Dashboard client script. Kept as a plain string so the template literals here
// don't clash with the server-side ones in loggedInPage.
const DASHBOARD_JS = `
async function load() {
  try {
    const s = await (await fetch("/api/state")).json();
    const w = s.watcher || {};
    const cfg = s.config || {};
    const scopes = {assignments:"الواجبات", materials:"المواد", exams:"الاختبارات", grades:"الدرجات"};
    const chips = Object.entries(scopes).map(function(e){
      return cfg[e[0]] === false
        ? '<span class="badge off">' + e[1] + ': متوقف</span>'
        : '<span class="badge ok">' + e[1] + ': شغّال</span>';
    }).join(" ");
    document.getElementById("status-card").innerHTML =
      "<h3>الحالة</h3><div class='row'>" + chips + "</div>" +
      "<p class='muted'>المراقبة: " + (w.running ? "🟢 تعمل الآن" : "🔴 متوقفة") +
      " · الفحص كل " + s.intervalMin + " دقيقة · فشل متتالي: " + (w.consecutiveFailures || 0) + "</p>" +
      "<p class='muted'>تلجرام: " + (s.telegramOk === false
        ? "🔴 ما يوصل (راجع TELEGRAM_CHAT_ID)"
        : "🟢 جاهز") + "</p>";
    const rows = (s.seen || []).map(function(r){
      return "<div class='item'><span class='badge " + (r.kind||"") + "'>" +
        String(r.kind||"").toUpperCase() + "</span>" +
        "<b>" + escapeH(r.title) + "</b><br>" +
        "<span class='muted'>" + escapeH(r.subject||"") +
        (r.dueAt ? " · موعد التسليم: " + escapeH(r.dueAt) : "") +
        "</span></div>";
    }).join("") || '<p class="muted">لا يوجد بعد — اضغط "افحص الحين"</p>';
    document.getElementById("seen-card").innerHTML = "<h3>آخر ما رُصد</h3>" + rows;
  } catch(e) {
    document.getElementById("status-card").innerHTML = '<p class="muted">تعذّر تحميل الحالة</p>';
  }
}
function escapeH(s){return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;");}
load();
setInterval(load, 15000);
`;

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
