// src/ai.js — optional AI layer for the bot.
//
// When configured (OPENAI_API_KEY or any OpenAI-compatible endpoint), the bot
// answers free-text questions in Arabic using live platform data as context.
// When unconfigured, the bot behaves exactly as before (commands only).
//
// Design note: the model is a *reader*. It can summarise, count, compare and
// explain. It is deliberately never given write/submission endpoints, so it
// cannot submit homework even if asked — that line stays enforced by the
// absence of the capability itself.

const DEFAULT_MODEL = process.env.AI_MODEL || "gpt-4o-mini";

const SYSTEM_PROMPT = `أنت "طويق بوت"، مساعد ذكي لطالب في مدارس طويق. تجاوب بالعربية الفصحى الطبيعية، واضح ومختصر.

القواعد:
- عندك بيانات حقيقية ومحدّثة من منصة طويق (في السياق تحت). اعتمد عليها.
- لو السؤال يحتاج بيانات ما هي موجودة، قُل إنك ما تقدر تجيبها الحين.
- نظّم الإجابة: استخدم تنسيق مرتب (عناوين، نقط، جداول صغيرة) بدل فقرات طويلة.
- للتواريخ استخدم صيغة عربية حلوة مثل "الاثنين 21 سبتمبر، 11:00 مساءً".
- مهم: ما تقدر تحلّ الواجبات، ولا ترفّعها، ولا تكتب إجابات نيابة عن الطالب. هذا خط أحمر. لو طلب منك شي كذا، اعتذر بلطف ووضّح إن مساعدتك للتنظيم والمتابعة فقط.
- جاوب بأقصر شكل ممكن مع الحفاظ على الوضوح.`;

export function isAIEnabled() {
  return !!(process.env.OPENAI_API_KEY || process.env.AI_API_KEY);
}

export function aiConfig() {
  return {
    enabled: isAIEnabled(),
    baseURL: process.env.AI_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY || process.env.AI_API_KEY || "",
    model: DEFAULT_MODEL,
  };
}

// Ask the model a question with the platform snapshot as context.
export async function askAI(userQuestion, contextJson, opts = {}) {
  const cfg = aiConfig();
  if (!cfg.enabled) {
    return {
      ok: false,
      reply:
        "🤖 الذكاء الاصطناعي ما هو مفعّل الحين.\n\nتقدر تستخدم الأوامر (جرّب /help).\n\nولتفعيله: /ai setup",
    };
  }
  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "system",
        content: `بيانات منصة طويق الحالية (JSON):\n\n${contextJson}`,
      },
      { role: "user", content: userQuestion },
    ],
    temperature: 0.4,
    max_tokens: opts.maxTokens || 1200,
  };
  const res = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal ?? AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, reply: `⚠️ الذكاء الاصطناعي ردّ بخطأ (${res.status}): ${text.slice(0, 150)}` };
  }
  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim();
  if (!reply) return { ok: false, reply: "⚠️ ما رجع جواب. جرّب مرة ثانية." };
  return { ok: true, reply };
}
