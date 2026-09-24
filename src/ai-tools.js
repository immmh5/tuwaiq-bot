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
export async function runTool(name, args, accessToken) {
  const a = args || {};
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
    // Raw capture of a platform page. Uses a real browser when one is
    // available (local/dev), otherwise the SVG renderer. This is the
    // "screenshot the HTML" capability the student asked for.
    case "capture_page": {
      const data = (await fetchScope(a.scope || "schedule", accessToken)) || [];
      const { png, caption, method } = await captureScope(a.scope || "schedule", data);
      return { __photo: png, __caption: caption, method, count: data.length };
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}
