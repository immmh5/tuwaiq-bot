// src/ai-tools.js — tool-calling layer for the AI assistant.
//
// Instead of dumping a snapshot into the prompt, the model gets a set of
// "tools" (in the OpenAI function-calling sense) and calls the ones it needs.
// This is the "MCP-like" design: the AI decides what to look at, pulls only
// that, and can drill into details a static snapshot could never carry.
//
// Every tool here is read-only by construction. There is intentionally no
// submit/upload/answer endpoint — the hard boundary (no homework solving) is
// enforced by the absence of the capability, not by a prompt instruction.

import { fetchScope } from "./watcher.js";
import { getMyAttendance, getSessionJoinLink } from "./tuwaiq.js";
import {
  renderScheduleImage,
  renderScheduleGridImage,
  renderAssignmentsImage,
  renderGradesImage,
} from "./images.js";
import { captureScope } from "./html-shot.js";

// Tool definitions as presented to the model (OpenAI function format).
export const TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "list_assignments",
      description: "واجبات الطالب. تقدر تصفّي بالحالة: pending (لم يُسلَّم)، submitted (مُسلَّم)، graded (مُصحَّح)، overdue (تأخر).",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "submitted", "graded", "overdue", "all"], description: "الحالة المطلوبة. افتراضي: all" },
          subject: { type: "string", description: "اسم المادة للتصفية (اختياري)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_materials",
      description: "المواد التعليمية والملفات المرفوعة. فيها روابط تحميل.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", description: "اسم المادة للتصفية (اختياري)" },
          limit: { type: "integer", description: "أقصى عدد نتائج. افتراضي 20" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_exams",
      description: "الاختبارات المتاحة والمحاولات.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_grades",
      description: "كل الدرجات المصحَّحة (من الواجبات والاختبارات).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_courses",
      description: "مقررات الطالب: المعلم، نسبة الحضور، الواجبات المعلقة، الدرجات النهائية.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_schedule",
      description: "الجدول الأسبوعي للحصص. استخدم 'today' لحصص اليوم، 'tomorrow' لبكرة.",
      parameters: {
        type: "object",
        properties: {
          when: { type: "string", enum: ["today", "tomorrow", "week"], description: "أي فترة. افتراضي: week" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_attendance",
      description: "نسبة الحضور وسجل الغياب.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_dashboard",
      description: "ملخص عام: عدد المقررات، الواجبات المستحقة قريبًا، الاختبارات المفتوحة، الحصص اليوم.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_unread_notifications",
      description: "الإشعارات غير المقروءة وعددها.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "send_schedule_image",
      description: "أرسل الجدول الأسبوعي كصورة مرتبة للطالب. استخدمها لما يطلب الجدول كصورة.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "send_assignments_image",
      description: "أرسل الواجبات كصورة مرتبة (المعلّقة، المصحّحة، المُسلَّمة). استخدمها لما يطلب الواجبات كصورة.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "send_schedule_grid",
      description: "أرسل الجدول كصورة بشبكة مثل المنصة بالضبط (الأيام أعمدة والأوقات صفوف، الحصص الملغاة باهتة). استخدمها لما يريد الجدول 'مثل ما يظهر في الموقع'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "send_grades_image",
      description: "أرسل الدرجات كصورة مع نسب مئوية وألوان. استخدمها لما يطلب الدرجات كصورة.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "send_exams_image",
      description: "أرسل الاختبارات القادمة كصورة مع عدّاد الأيام المتبقية. استخدمها لما يطلب الاختبارات كصورة أو يسأل «كم باقي على الاختبار».",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "send_materials_image",
      description: "أرسل المواد الدراسية كصورة مع نوع كل ملف. استخدمها لما يطلب المواد كصورة.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "send_notifications_image",
      description: "أرسل الإشعارات كصورة، غير المقروءة في الأعلى. استخدمها لما يطلب الإشعارات كصورة أو يسأل وش الجديد.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "capture_page",
      description: "التقط صورة لصفحة من المنصة (schedule/assignments/grades/materials/exams/attendance/courses). خيار احتياطي لما يريد لقطة حقيقية من الموقع.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["schedule", "assignments", "grades", "materials", "exams", "attendance", "courses"],
            description: "أي صفحة تلتقط. افتراضي: schedule",
          },
        },
        required: [],
      },
    },
  },
  // --- Action tools ---------------------------------------------------------
  // These change something rather than reading. Each one mirrors a command
  // the student could type, and they are all things the owner may do — the
  // line that stays uncrossed is submitting or solving anything on the
  // student's behalf, which has no tool here at all.
  {
    type: "function",
    function: {
      name: "set_notification_mode",
      description: "غيّر طريقة التنبيهات: كل عنصر لوحده أو كلها في رسالة وحدة.",
      parameters: {
        type: "object",
        properties: { mode: { type: "string", enum: ["individual", "digest"], description: "individual = كل عنصر لوحده، digest = رسالة وحدة" } },
        required: ["mode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_reminder_lead",
      description: "غيّر وقت التنبيه قبل الموعد النهائي بالساعات.",
      parameters: {
        type: "object",
        properties: { hours: { type: "number", enum: [6, 12, 24, 48], description: "كم ساعة قبل الموعد" } },
        required: ["hours"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_check_interval",
      description: "غيّر كم دقيقة بين كل فحصة للمنصة. القيم الصحيحة: 5، 10، 30، 60.",
      parameters: {
        type: "object",
        properties: { minutes: { type: "number", enum: [5, 10, 30, 60], description: "الدقائق بين الفحصات" } },
        required: ["minutes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "toggle_ai",
      description: "شغّل أو أوقف ردود الذكاء الاصطناعي للنص الحر.",
      parameters: {
        type: "object",
        properties: { enabled: { type: "boolean", description: "true = شغّال، false = متوقف" } },
        required: ["enabled"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_backup",
      description: "ابدأ نسخة احتياطية كاملة من كل المنصة. استخدمها لما يطلب نسخة احتياطية.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "run_fresh_check",
      description: "افحص المنصة الحين وأبلغ عن كل شي جديد. استخدمها لما يطلب فحص فوري.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "set_mega_enabled",
      description: "شغّل أو أوقف رفع النسخ الاحتياطية لـ MEGA.",
      parameters: {
        type: "object",
        properties: { enabled: { type: "boolean", description: "true = يرفع لـ MEGA، false = تلجرام بس" } },
        required: ["enabled"],
      },
    },
  },
];

const isoDay = (d) => d.toISOString().slice(0, 10);

// The platform sends statuses capitalised ("Pending", "Submitted", "Graded").
// Tool args arrive lowercase, so compare case-insensitively — otherwise a
// filter silently matches nothing and the AI wrongly reports "no assignments".
const norm = (v) => String(v || "").trim().toLowerCase();

// True when a not-yet-submitted assignment is past its due date.
const isOverdue = (x) =>
  norm(x.status) === "pending" && !!x.dueAt && new Date(x.dueAt).getTime() < Date.now();

// Execute one tool call against the live platform.
//
// Action tools receive the chat id so they can change that chat's settings.
// They deliberately never accept credentials or file ids — the capability
// surface is what the student could reach from the settings panel, nothing
// more.
export async function runTool(name, args, accessToken, ctx = {}) {
  const a = args || {};
  const chatId = ctx.chatId || null;
  switch (name) {
    case "list_assignments": {
      const items = (await fetchScope("assignments", accessToken)) || [];
      let rows = items;
      if (a.status && norm(a.status) !== "all") {
        const want = norm(a.status);
        if (want === "overdue") rows = rows.filter(isOverdue);
        else rows = rows.filter((x) => norm(x.status) === want);
      }
      if (a.subject) rows = rows.filter((x) => norm(x.subject).includes(norm(a.subject)));
      return rows.map((x) => ({
        id: x.id,
        title: x.title,
        subject: x.subject,
        status: x.status,
        overdue: isOverdue(x),
        dueAt: x.dueAt,
        score: x.score,
        maxScore: x.maxScore,
      }));
    }
    case "list_materials": {
      const items = (await fetchScope("materials", accessToken)) || [];
      let rows = a.subject ? items.filter((x) => (x.subject || "").includes(a.subject)) : items;
      return rows.slice(0, a.limit || 20).map((x) => ({
        id: x.id,
        title: x.title,
        subject: x.subject,
        type: x.contentType,
        createdAt: x.createdAt,
        url: x.fileUrl || x.externalUrl || x.url,
      }));
    }
    case "list_exams":
      return (await fetchScope("exams", accessToken)) || [];
    case "list_grades":
      return (await fetchScope("grades", accessToken)) || [];
    case "list_courses":
      return (await fetchScope("courses", accessToken)) || [];
    case "get_schedule": {
      const items = (await fetchScope("schedule", accessToken)) || [];
      const today = isoDay(new Date());
      const tomorrow = isoDay(new Date(Date.now() + 86400000));
      let rows = items;
      if (a.when === "today") rows = items.filter((s) => String(s.date || "").slice(0, 10) === today);
      if (a.when === "tomorrow") rows = items.filter((s) => String(s.date || "").slice(0, 10) === tomorrow);
      return rows.map((s) => ({
        title: s.title,
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        room: s.room,
        status: s.status,
      }));
    }
    case "get_attendance":
      return await getMyAttendance(accessToken);
    case "get_dashboard":
      return await fetchScope("home", accessToken);
    case "get_unread_notifications": {
      const items = (await fetchScope("notifications", accessToken)) || [];
      const unread = items.filter((n) => !n.read);
      return { unreadCount: unread.length, items: unread.slice(0, 10) };
    }
    case "send_schedule_image": {
      const sessions = (await fetchScope("schedule", accessToken)) || [];
      if (!sessions.length) return { error: "no schedule" };
      const { png, caption } = await renderScheduleImage(sessions);
      return { __photo: png, __caption: caption, count: sessions.length };
    }
    case "send_schedule_grid": {
      const sessions = (await fetchScope("schedule", accessToken)) || [];
      if (!sessions.length) return { error: "no schedule" };
      const { png, caption } = await renderScheduleGridImage(sessions);
      return { __photo: png, __caption: caption, count: sessions.length };
    }
    case "send_assignments_image": {
      const items = (await fetchScope("assignments", accessToken)) || [];
      if (!items.length) return { error: "no assignments" };
      const { png, caption } = await renderAssignmentsImage(items);
      return { __photo: png, __caption: caption, count: items.length };
    }
    case "send_grades_image": {
      const items = (await fetchScope("grades", accessToken)) || [];
      if (!items.length) return { error: "no grades" };
      const { png, caption } = await renderGradesImage(items);
      return { __photo: png, __caption: caption, count: items.length };
    }
    // The three scopes that gained images. Each returns the PNG the caller
    // ships as a photo; the model only sees a small confirmation.
    case "send_exams_image": {
      const items = (await fetchScope("exams", accessToken)) || [];
      if (!items.length) return { error: "no upcoming exams" };
      const { renderExamsImage } = await import("./images.js");
      const { png, caption } = await renderExamsImage(items);
      return { __photo: png, __caption: caption, count: items.length };
    }
    case "send_materials_image": {
      const items = (await fetchScope("materials", accessToken)) || [];
      if (!items.length) return { error: "no materials" };
      const { renderMaterialsImage } = await import("./images.js");
      const { png, caption } = await renderMaterialsImage(items);
      return { __photo: png, __caption: caption, count: items.length };
    }
    case "send_notifications_image": {
      const items = (await fetchScope("notifications", accessToken)) || [];
      if (!items.length) return { error: "no notifications" };
      const { renderNotificationsImage } = await import("./images.js");
      const { png, caption } = await renderNotificationsImage(items);
      return { __photo: png, __caption: caption, count: items.length };
    }
    // Raw capture of a platform page. Uses a real browser when one is
    // available (local/dev), otherwise the SVG renderer. This is the
    // "screenshot the HTML" capability the student asked for.
    case "capture_page": {
      const data = (await fetchScope(a.scope || "schedule", accessToken)) || [];
      const { png, caption, method } = await captureScope(a.scope || "schedule", data);
      return { __photo: png, __caption: caption, method, count: data.length };
    }
    // --- Actions -----------------------------------------------------------
    // Settings changes are scoped to the chat the conversation is happening
    // in, so a guest adjusting things only affects their own view. The tools
    // are loaded lazily to keep this module free of import cycles with the
    // command layer.
    case "set_notification_mode": {
      const { setSetting } = await import("./settings.js");
      if (!chatId) return { error: "no chat context" };
      await setSetting(chatId, "notify_digest", a.mode === "digest");
      return { ok: true, mode: a.mode };
    }
    case "set_reminder_lead": {
      const { setSetting } = await import("./settings.js");
      if (!chatId) return { error: "no chat context" };
      await setSetting(chatId, "remind_hours", Number(a.hours));
      return { ok: true, hours: Number(a.hours) };
    }
    case "set_check_interval": {
      const { setSetting } = await import("./settings.js");
      if (!chatId) return { error: "no chat context" };
      await setSetting(chatId, "check_interval", Number(a.minutes));
      return { ok: true, minutes: Number(a.minutes) };
    }
    case "toggle_ai": {
      const { setSetting } = await import("./settings.js");
      if (!chatId) return { error: "no chat context" };
      await setSetting(chatId, "ai_enabled", !!a.enabled);
      return { ok: true, enabled: !!a.enabled };
    }
    case "set_mega_enabled": {
      const { setSetting } = await import("./settings.js");
      if (!chatId) return { error: "no chat context" };
      await setSetting(chatId, "mega_enabled", !!a.enabled);
      return { ok: true, enabled: !!a.enabled };
    }
    // Commands are invoked through the same handler map the text commands
    // use, so the AI cannot reach a code path the student could not reach
    // by typing the command.
    case "run_backup": {
      const fn = await dispatchCommand("/backup", chatId);
      return fn ? { ok: true, started: true } : { error: "backup unavailable" };
    }
    case "run_fresh_check": {
      const fn = await dispatchCommand("/fresh", chatId);
      return fn ? { ok: true, started: true } : { error: "fresh check unavailable" };
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}

// Look a registered command up the same way a typed command is resolved, so
// an action tool runs the identical handler with the same access gate.
async function dispatchCommand(command, chatId) {
  const { resolveHandler } = await import("./telegram.js");
  const resolved = resolveHandler(command);
  if (!resolved) return null;
  resolved.fn({ chatId, args: [], text: command, raw: null, match: resolved.match });
  return resolved.fn;
}
