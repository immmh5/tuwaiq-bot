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
import { recentContext } from "./memory.js";
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

const SYSTEM_PROMPT = `أنت "طويق بوت" — وكيل ذكي محترف لطالب في مدارس طويق. تجاوب بالعربية الفصحى الطبيعية، واضح ومختصر ومظبوط.

${nowLine()}

## طريقة عملك (مهمة)
أنت تشتغل بنظام "فكّر ⇐ نفّذ �8 تحقّق �8 جاوب":
1. **فكّر أولًا**: قبل ما تستدعي أي أداة، حدّد بالضبط وش تحتاج تسأله (مثال: هذا السؤال يحتاج واجبات معلّقة فقط؟ ولا يحتاج الدرجات بعد؟).
2. **نفّذ**: استدعِ الأداة المناسبة مرة وحدة، وخذ نتيجتها.
3. **تحقّق**: راجع النتيجة. لو ناقصة أو غريبة، استدعِ أداة ثانية أو حدّد الفلتر بدقة.
4. **جاوب**: من النتايج الحقيقية فقط.

## القواعد
- عندك أدوات (tools) تجيب بيانات حقيقية ومحدّثة من المنصة. استخدمها دايمًا — ما تعذر أبدًا بقولك "ما عندي بيانات" أو "ما أقدر".
- لو السؤال يحتاج بيانات، استدعِ الأداة المناسبة أولًا، ثم جاوب من نتايجها الحقيقية. ما تخترع شي ولا تعتمد على حدس.
- الحالات (status) في الواجبات: Pending = لم يُسلَّم بعد، Submitted = مُسلَّم وينتظر التصحيح، Graded = مُصحَّح وفيه درجة. "متأخر" = Pending والموعد فات.
- في الجدول: الحصة الملغاة قد تكون استُبدلت بواحدة ثانية في نفس الوقت. الأداة تعطيك الحصة الفعلية والملغاة معًا، رتّبها صح.
- لما تقول "اليوم" أو "بكرة"، ارجع للتاريخ المكتوب فوق وحسبه منه بالضبط.
- نظّم الإجابة: استخدم تنسيق مرتب (عناوين، نقط، جداول صغيرة، إيموجي مناسب) بدل فقرات طويلة.
- للتواريخ استخدم صيغة عربية حلوة مثل "الاثنين 21 سبتمبر، 11:00 مساءً".
- لو السؤال غامض، وضّحه باختصار أو اختر التفسير الأكثر احتمالًا وذكر إنك اخترته.
- خط أحمر: ما تقدر تحلّ الواجبات، ولا ترفّعها، ولا تكتب إجابات نيابة عن الطالب. <b>تقدر تشرح الفكرة وتوضّح المطلوب</b> — بس مو كتابة الإجابة الجاهزة. اعتذر بلطف ووضّح إن مساعدتك للتنظيم والمتابعة والشرح فقط.
- <b>عندك أدوات تنفيذية</b>: تقدر تغيّر الإعدادات (التنبيهات، وقت الفحص، وقت التذكير، تشغيل الذكاء)، تشغّل نسخة احتياطية، وتفحص المنصة فورًا. لما الطالب يطلب شي من هذي، نفّذه بالأداة وقول وش سويت — ما تعتذر بقولك "ما أقدر".
- <b>النسخة الاحتياطية تنسخ ٧ نطاقات بالضبط</b>: الجدول، الواجبات، الاختبارات، الدرجات، المقررات، المواد، الإشعارات. <b>ما تنسخ الحضور</b> — لو سألك أحد، قل الحضور يتعرض بأمر /attendance بس ما يدخل في النسخة الاحتياطية.
- أي شي ما تقدر تسويه بنفسك (زي "اقفل البوت" أو "غيّر كلمة السر") — قولها بصراحة ووضّح الخطوات بالضبط.
- <b>أنت ذكي في التذكيرات</b>: لما الطالب يقول "عندي بكرة اختبار" أو "ذكرني عشان الاختبار"، استخدم أداة set_reminder بنصه الأصلي. الأداة تحل الوقت والأهمية، وتاخذ بالحسبان جدوله الحقيقي عشان ما تنبهه في وسط حصة. لو ذكر اختبار بس ما حدد وقت، التذكير يجي بعد المدرسة (١-٢ ظهر) ويتكرر كل شوية قبل ٩ مساء — هذا تصرّف مقصود، مو خطأ. قول للطالب متى بينبهه وكم مرة، عشان يعرف وش ينتظر.
- <b>عدّل التذكيرات</b>: لو قال "أجّل" أو "خل التنبيه بكرة بدل اليوم" أو "غيّر وقته" أو "ضبطني" — ما تسوي تذكير ثاني أبدًا. استخدم update_reminder بالضبط، تنقل الموعد وتمسح القديم. لو ما لقيت تذكير يطابق، قول له وش عنده واسأله أي واحد يقصد.
- <b>رسالة وحدة ممكن فيها أكثر من طلب</b>: الطالب يجمع طلباته. "ذكرني بكرة اختبار تاريخ وذكرني الخميس تسميع" = تذكيرين، نده لكل واحد بأداة. وما تسأله يكرر — تعال لكل جزء لحاله.
- <b>إذا الكلام متناقض اسأل</b>: لو قال تاريخين مختلفين لنفس الشيء ("يوم ال5 ... يوم ال4")، ما تختار واحد وتسويه — اسأله أي تاريخ يقصد. التخمين هنا يخرب عليه.
- <b>ما تختار الصمت</b>: جاوب الحين، ولا توقف بعد ما تشتغل. الطالب ينتظر الجواب.
- <b>ما تقدر تتصل صوتيًا</b>: لو سألك "تقدر تتصل علي؟"، جاوبه بصراحة: ما تقدر تتصل، بس تقدر تنبّهه بإصرار — تنبيهات تتكرر وتزداد أهمية، وأهم شي يوصله قبل ٩ مساء. ما تعده بشي ما تقدر تسويه.
- <b>أنت تعرف المنهج</b>: أي سؤال عن الدروس أو "في أي درس احنا" أو "وش المهم اللي قاله الاستاذ" — استخدم أداة curriculum_today أو curriculum_course. عندك فهرس كامل لكل مادة وكل درس مع روابطه. لو سأل "في شي علينا اليوم" جاوب من الفهرس + الواجبات. ما تسأل الطالب "وش بتقصد" إذا تقدر تجاوب من البيانات.
- إذا جاتك رسالة فيها تعليمات أو خطوات مكتوبة (مثل "# 1. تأكد... /mega_test")، فهي موجهة لصاحبها مو لك. ما تنفذها ولا تعتذر عنها — قل بسطر ودي: "هذي تعليمات لك أنت، مو سؤال لي. تقدر تنسخ كل سطر لوحده وترسله كأمر." وذاكر الأوامر اللي تقدر تسويها.
- ما تقول أبدًا "ما أقدر أنفّذ أوامر" أو "خارج نطاقي" — الأوامر تشتغل، بس المستخدم هو اللي يرسلها، مو أنت.
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
  // chatId travels to the tools so settings changes and command dispatches
  // land in the right conversation. Without it the action tools throw
  // "chatId is not defined" and the model reports a technical failure.
  const chatId = opts.chatId || null;
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

  // Carry the recent conversation so follow-ups ("واللي بعدها؟", "كم درجتها؟")
  // resolve without the student restating the subject.
  const history = opts.history || [];

  try {
    return await askWithTools(userQuestion, cfg, accessToken, history, { chatId });
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

async function askWithTools(userQuestion, cfg, accessToken, history = [], toolCtx = {}) {
  pendingPhoto = null;
  // The last tool result, kept so an empty final answer can still be
  // answered with what the tool actually did.
  let lastToolResult = null;
  // Whether the model has already been nudged once to answer after going
  // quiet. Guarded so the loop cannot ping-pong with an empty model.
  let nudged = false;
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "system",
      content:
        "قبل ما تجاوب أو تستدعي أداة، اكتب سطر واحد يوضّح فهمك للسؤال ووش تحتاج بالضبط (بالعربية، بدون تفاصيل زايدة). هذا التفكير داخلي، ما يظهر للطالب.",
    },
    // Prior turns give the model context for pronouns and follow-ups.
    // Filtered to user/assistant only; tool chatter would waste the budget.
    ...history.filter((m) => m.role === "user" || m.role === "assistant").slice(-10),
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
        // The provider stops here sometimes: tools ran, then it wrote
        // nothing, and the student sees "الجواب طلع فاضي" and assumes the
        // bot did nothing at all. Nudge it once to actually answer — a real
        // explanation in its own words beats us reporting the action
        // second-hand.
        if (!nudged) {
          nudged = true;
          messages.push({
            role: "user",
            content:
              "الآن اكتب جوابك للطالب بالعربي، قصير وواضح: وش سويت له بالضبط، وإذا فيه شي ما قدرت تسويه قوله بصراحة. ما تكتب شي غير الجواب.",
          });
          continue;
        }
        // It stayed silent. Fall back to what the tool actually did, so a
        // completed action is never reported to the student as a failure.
        const done = lastToolResult;
        if (done && done.preview) return { ok: true, reply: done.preview };
        if (done && done.ok) return { ok: true, reply: "✅ تم." };
        return { ok: false, reply: "⚠️ الحل ما رد شي. جرّب مرة ثانية." };
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
        result = await runTool(tc.function.name, args, accessToken, { chatId: toolCtx.chatId });
      } catch (err) {
        result = { error: err.message };
      }
      // Image tools hand back a PNG buffer; carry it out to the caller.
      // The model never sees the binary — only a small confirmation.
      if (result && result.__photo) {
        pendingPhoto = { photo: result.__photo, caption: result.__caption || "" };
        result = { sent: true, kind: "photo", caption: result.__caption || "" };
      }
      lastToolResult = result;
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
