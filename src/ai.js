// src/ai.js — AI assistant with tool calling.
//
// The model is given tools (src/ai-tools.js) and calls them to pull exactly
// the data it needs, then answers. This is an MCP-style design: the AI is the
// orchestrator, the tools are read-only views over the platform.
//
// Boundary: the tool set is deliberately read-only. There is no submission,
// upload or answering tool, so the AI cannot do homework even if asked — the
// capability does not exist in the system.

import { TOOL_SPECS, runTool } from "./ai-tools.js";
import { fetchScope } from "./watcher.js";
import { escapeHtml as esc } from "./format.js";
import { getTokens } from "./store.js";

const DEFAULT_MODEL = process.env.AI_MODEL || "Atria-Dawn-Preview";

// The model has no clock. Without this it calls whatever day it guesses
// "today" and gives wrong advice about what is due tonight.
const nowLine = () => {
  const d = new Date();
  const days = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  const months = [
    "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
    "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
  ];
  const h = d.getUTCHours();
  const ap = h >= 12 ? "مساءً" : "صباحًا";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `التاريخ والوقت الحالي (توقيت جرينتش): ${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}، الساعة ${h12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${ap}`;
};

const SYSTEM_PROMPT = `أنت "طويخ بوت" — مساعد ذكي لطالب في مدارس طويق. تجاوب بالعربية الفصحى الطبيعية، واضح ومختصر ومظبوط.

${nowLine()}

القواعد:
- عندك أدوات (tools) تجيب لك بيانات حقيقية ومحدّثة من المنصة. استخدمها دايمًا — ما تعذر أبدًا بقولك "ما عندي بيانات".
- لو السؤال يحتاج بيانات، استدعِ الأداة المناسبة أولًا، ثم جاوب من نتايجها الحقيقية. ما تخترع شي.
- الحالات (status) في الواجبات: Pending = لم يُسلَّم بعد، Submitted = مُسلَّم وينتظر التصحيح، Graded = مُصحَّح وفيه درجة. "متأخر" = Pending والموعد فات.
- لما تقول "اليوم" أو "بكرة"، ارجع للتاريخ المكتوب فوق وحسبه منه بالضبط.
- نظّم الإجابة: استخدم تنسيق مرتب (عناوين، نقط، جداول صغيرة، إيموجي مناسب) بدل فقرات طويلة.
- للتواريخ استخدم صيغة عربية حلوة مثل "الاثنين 21 سبتمبر، 11:00 مساءً".
- خط أحمر: ما تقدر تحلّ الواجبات، ولا ترفّعها، ولا تكتب إجابات نيابة عن الطالب. اعتذر بلطف ووضّح إن مساعدتك للتنظيم والمتابعة فقط.
- جاوب بأقصر شكل ممكن مع الحفاظ على الوضوح والترتيب.`;

export function isAIEnabled() {
  return !!(process.env.OPENAI_API_KEY || process.env.AI_API_KEY || process.env.ATRIA_API_KEY);
}

export function aiConfig() {
  const apiKey = process.env.OPENAI_API_KEY || process.env.AI_API_KEY || process.env.ATRIA_API_KEY || "";
  return {
    enabled: !!apiKey,
    baseURL: (process.env.AI_BASE_URL || "https://api.atria-asi.ai/v1").replace(/\/$/, ""),
    apiKey,
    model: DEFAULT_MODEL,
  };
}

// One round-trip to the model. Returns the raw JSON body.
async function chatOnce(messages, cfg, { tools } = {}) {
  const body = {
    model: cfg.model,
    messages,
    temperature: 0.4,
    max_tokens: 1500,
    stream: false,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const res = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`bad JSON from model: ${text.slice(0, 200)}`);
  }
}

// Full conversation loop: ask → model may call tools → run them → ask again
// with results → until the model produces a final text answer.
// Capped so a chatty model can't loop forever on the free tier.
const MAX_ROUNDS = 6;

export async function askAI(userQuestion, opts = {}) {
  const cfg = aiConfig();
  if (!cfg.enabled) {
    return {
      ok: false,
      reply:
        "🤖 الذكاء الاصطناعي ما هو مفعّل الحين.\n\nتقدر تستخدم الأوامر (جرّب /help).\n\nولتفعيله: اضبط مفتاح API في إعدادات الخدمة.",
    };
  }
  const accessToken = opts.accessToken;
  if (!accessToken) return { ok: false, reply: "🔒 الحساب غير مربوط." };

  try {
    return await askWithTools(userQuestion, cfg, accessToken);
  } catch (err) {
    // Some providers reject the tools array outright (400) or don't return
    // tool_calls. Fall back to the snapshot design so the bot still answers.
    if (/400|tool|unsupported|Bad Request/i.test(err.message)) {
      try {
        return await askWithSnapshot(userQuestion, cfg, accessToken);
      } catch (err2) {
        return { ok: false, reply: `⚠️ الخطأ: <code>${esc(err2.message).slice(0, 200)}</code>` };
      }
    }
    return { ok: false, reply: `⚠️ ما قدرت أجاوب: <code>${esc(err.message).slice(0, 200)}</code>` };
  }
}

// Primary path: MCP-style tool calling. The model pulls exactly the scopes
// it needs, so simple questions are fast and detailed ones are thorough.
// Image tools (renderScheduleImage etc.) return a PNG the caller sends.
let pendingPhoto = null;

async function askWithTools(userQuestion, cfg, accessToken) {
  pendingPhoto = null;
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userQuestion },
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const data = await chatOnce(messages, cfg, { tools: TOOL_SPECS });
    const choice = data?.choices?.[0];
    if (!choice) return { ok: false, reply: "⚠️ ما رجع جواب. جرّب مرة ثانية." };

    const msg = choice.message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    // No tool calls → this is the final answer.
    if (!toolCalls.length) {
      const reply = (msg.content || "").trim();
      if (!reply) {
        // Some providers return an empty content on the first pass but have
        // already emitted tool results; keep the photo if we have one.
        if (pendingPhoto) return { ok: true, reply: "", photo: pendingPhoto };
        return { ok: false, reply: "⚠️ الجواب طلع فاضي. جرّب مرة ثانية." };
      }
      return { ok: true, reply, photo: pendingPhoto || null };
    }

    // Record the assistant's tool-call message, then each tool result.
    messages.push({ role: "assistant", content: msg.content || "", tool_calls: toolCalls });
    for (const tc of toolCalls) {
      let args = {};
      try {
        args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        args = {};
      }
      let result;
      try {
        result = await runTool(tc.function.name, args, accessToken);
      } catch (err) {
        result = { error: err.message };
      }
      // Image tools hand back a PNG buffer; carry it out to the caller.
      // The model never sees the binary — only a small confirmation.
      if (result && result.__photo) {
        pendingPhoto = { photo: result.__photo, caption: result.__caption || "" };
        result = { sent: true, kind: "photo", caption: result.__caption || "" };
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result).slice(0, 6000),
      });
    }
  }
  return { ok: false, reply: "⚠️ تعقّد السؤال كثير. جرّب أسأل بشكل أبسط." };
}

// Fallback path: pull the live snapshot once and answer from it. Used when the
// provider doesn't support function calling. Never says "I have no data"
// because the whole platform is in the prompt.
async function askWithSnapshot(userQuestion, cfg, accessToken) {
  const scopes = ["assignments", "grades", "courses", "schedule", "materials", "exams", "notifications"];
  const out = {};
  await Promise.all(
    scopes.map(async (s) => {
      try {
        const items = await Promise.race([
          fetchScope(s, accessToken),
          new Promise((_, rej) => setTimeout(() => rej(new Error("scope timeout")), 25000)),
        ]);
        out[s] = (items || []).slice(0, 25).map((i) => ({
          title: i.title ?? null,
          subject: i.subject ?? null,
          status: i.status ?? null,
          score: i.score ?? i.gradePoints ?? null,
          maxScore: i.maxScore ?? i.maxPoints ?? null,
          dueAt: i.dueAt ?? null,
          date: i.date ?? null,
          startTime: i.startTime ?? null,
          endTime: i.endTime ?? null,
          room: i.room ?? null,
          teacher: i.teacher ?? null,
          attendanceRate: i.attendanceRate ?? null,
          read: i.read ?? null,
          contentType: i.contentType ?? null,
          url: i.fileUrl || i.externalUrl || i.url || null,
        }));
      } catch (err) {
        out[s] = { error: err.message };
      }
    })
  );

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "system",
      content: `بيانات منصة طويق الحالية (JSON حقيقي ومحدّث):\n\n${JSON.stringify(out).slice(0, 14000)}`,
    },
    { role: "user", content: userQuestion },
  ];

  const data = await chatOnce(messages, cfg, {});
  const choice = data?.choices?.[0];
  const reply = (choice?.message?.content || "").trim();
  if (!reply) return { ok: false, reply: "⚠️ الجواب طلع فاضي. جرّب مرة ثانية." };
  return { ok: true, reply };
}
