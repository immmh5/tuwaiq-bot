// The curriculum index — the bot's map of what the student is actually
// studying.
//
// The platform does not expose a "lesson for today" endpoint; what it does
// expose is materials (documents, slides, videos) posted per course, plus a
// timetable and a list of assignments. That is enough to answer the
// questions the student asks — "في شي علينا اليوم؟", "في أي درس احنا؟",
// "وش المهم اللي قاله الاستاذ؟" — by building an index once and reading it.
//
// The index is built from the live materials list and stored per chat, so a
// question does not re-scan the platform every time. It is refreshed by the
// watcher alongside everything else.

import { getKv, setKv } from "./store.js";

const KEY = (chatId) => `curriculum:${chatId}`;

// --- Building ---------------------------------------------------------------

// Group materials by course and sort newest first, so "what did we cover"
// reads chronologically and "the latest lesson" is simply the head.
export function buildIndex(materials, courses = []) {
  const byCourse = new Map();
  const courseNames = new Set(
    (courses || []).map((c) => c.title).filter(Boolean),
  );
  for (const m of materials || []) {
    const course = cleanSubject(m.subject) || "—";
    if (!byCourse.has(course)) byCourse.set(course, []);
    byCourse.get(course).push(m);
  }
  const out = {};
  for (const [course, rows] of byCourse) {
    // Only keep the fields the answers need; raw is dropped so the index
    // stays small enough to hand to the model.
    out[course] = rows
      .filter((m) => m.title)
      .map((m) => ({
        title: String(m.title),
        type: typeLabel(m.contentType),
        teacher: m.teacher || null,
        at: m.createdAt || null,
        date: m.createdAt ? String(m.createdAt).slice(0, 10) : null,
        link: m.fileUrl || m.externalUrl || null,
      }))
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  }
  return { courses: [...courseNames], byCourse: out, builtAt: new Date().toISOString() };
}

// Strip the group suffix the platform appends, so "احياء 2-1" and "احياء"
// in the timetable collapse to one course in the index.
function cleanSubject(s) {
  const t = String(s || "").trim();
  if (!t) return null;
  return t
    .replace(/\s+\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?\s*$/, "")
    .replace(/\s+[-–]?\d+(?:\.\d+)?\s*$/, "")
    .trim();
}

function typeLabel(t) {
  const s = String(t || "").toUpperCase();
  if (s.includes("VIDEO")) return "فيديو";
  if (s.includes("PRESENT")) return "عرض";
  if (s.includes("DOC") || s.includes("PDF")) return "ملف";
  if (s.includes("LINK") || s.includes("URL")) return "رابط";
  if (s.includes("IMAGE")) return "صورة";
  return String(t || "مادة");
}

// --- Storage ----------------------------------------------------------------

export async function saveIndex(chatId, index) {
  await setKv(KEY(chatId), index);
  return index;
}

export async function getIndex(chatId) {
  return await getKv(KEY(chatId), null);
}

// --- Answering --------------------------------------------------------------

// What the timetable says the student has today, cross-referenced with the
// latest lesson in each of those courses. This is the "في أي درس احنا اليوم"
// answer: the lesson taught today where one exists, the next class otherwise.
export function lessonsForToday(index, schedule, todayISO) {
  if (!index || !index.byCourse) return [];
  const today = (schedule || []).filter((s) => {
    const d = String(s.date || s.sessionDate || "").slice(0, 10);
    return d === todayISO;
  });
  const seen = new Set();
  const out = [];
  for (const s of today) {
    const course = cleanSubject(s.subject || s.subjectName || s.title);
    if (!course || seen.has(course)) continue;
    seen.add(course);
    const rows = index.byCourse[course] || [];
    if (!rows.length) continue;
    out.push({ course, room: s.room || null, time: s.startTime || null, latest: rows[0] });
  }
  return out;
}

// Whether anything is due today — assignments whose deadline falls on this
// date, or a lesson posted today. Returns a plain list so the caller decides
// how to word the yes/no.
export function dueToday(index, assignments, todayISO) {
  const hw = (assignments || []).filter((a) => {
    const d = a.dueAt ? String(a.dueAt).slice(0, 10) : null;
    return d === todayISO && !["graded", "submitted"].includes(String(a.status || "").toLowerCase());
  });
  const lessons = (index && index.byCourse) ? Object.values(index.byCourse)
    .flat()
    .filter((r) => r.date === todayISO) : [];
  return { assignments: hw, lessons };
}

// The one-paragraph digest the model reads when the student asks a curriculum
// question. Everything the model needs, nothing it does not: the courses, the
// two most recent lessons per course, and today's timetable. Capped so a
// term's worth of materials does not blow the context.
export function digestForModel(index, schedule, todayISO) {
  if (!index) return "ما عندي فهرس للمنهج الحين.";
  const lines = [];
  const today = (schedule || [])
    .filter((s) => String(s.date || s.sessionDate || "").slice(0, 10) === todayISO)
    .map((s) => `${cleanSubject(s.subject || s.subjectName || s.title)} ${s.startTime ? `(${String(s.startTime).slice(0, 5)})` : ""}`)
    .filter(Boolean);
  lines.push(`حصص اليوم (${todayISO}): ${today.length ? today.join("، ") : "ما في حصص"}`);
  for (const [course, rows] of Object.entries(index.byCourse)) {
    const top = rows.slice(0, 2);
    lines.push(`📘 ${course}: ${top.map((r) => `${r.title} (${r.type})`).join(" — ")}`);
  }
  return lines.join("\n");
}
