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
import { sendMessage } from "./telegram.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createWebApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use("/static", express.static(path.join(__dirname, "public")));

  // --- health check for Render / uptime monitors ---
  app.get("/health", async (_req, res) => {
    const creds = await getCredentials();
    const tokens = await getTokens();
    const state = getWatcherState();
    const ok = !!creds;
    res.status(ok ? 200 : 503).json({
      status: ok ? "ok" : "no_account",
      loggedIn: ok,
      tokenValid: !!(tokens?.accessToken && tokens.accessExpiresAt > Date.now() / 1000),
      watcher: state,
      time: new Date().toISOString(),
    });
  });

  // --- login page ---
  app.get("/", async (_req, res) => {
    const creds = await getCredentials();
    if (creds) {
      const id = await getKv("identity", null);
      const state = getWatcherState();
      return res.send(loggedInPage(id, state));
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

  app.get("/api/state", async (_req, res) => {
    const creds = await getCredentials();
    const identity = await getKv("identity", null);
    const config = await getKv("watch_config", null);
    res.json({
      loggedIn: !!creds,
      identity,
      config,
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
</div>${foot()}`;
}

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
