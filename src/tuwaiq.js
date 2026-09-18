// src/tuwaiq.js — typed client for the student API endpoints
import { fetchJson } from "./http.js";

const BASE = "https://sc.tuwaiq.edu.sa/api/v1";

function authHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-CSRF-Protection": "1",
  };
}

// --- Profile -----------------------------------------------------------------

// Indirection so tests can swap the transport (ES module namespace bindings
// are read-only). Real callers use the exported wrappers, which default to the
// live implementations.
export const apiImpl = {};

function bind(name, fn) {
  return (...args) => (apiImpl[name] ||= fn)(...args);
}

export const getMe = bind("getMe", _getMe);
export const getMyAssignments = bind("getMyAssignments", _getMyAssignments);
export const getAssignmentById = bind("getAssignmentById", _getAssignmentById);
export const getMyMaterials = bind("getMyMaterials", _getMyMaterials);
export const getMaterialById = bind("getMaterialById", _getMaterialById);
export const getAvailableAttempts = bind("getAvailableAttempts", _getAvailableAttempts);
export const getExamModes = bind("getExamModes", _getExamModes);
export const getGrades = bind("getGrades", _getGrades);
export const getGradesDropdown = bind("getGradesDropdown", _getGradesDropdown);
export const getStudentHome = bind("getStudentHome", _getStudentHome);
export const getMyCourses = bind("getMyCourses", _getMyCourses);
export const getMySchedule = bind("getMySchedule", _getMySchedule);

async function _getMe(accessToken) {
  // /auth/me is the frontend's "who am I" call; used to verify the session
  return fetchJson(`${BASE}/auth/me`, { headers: authHeaders(accessToken) });
}

// --- Assignments -------------------------------------------------------------

async function _getMyAssignments(accessToken, page = 1, pageSize = 100) {
  return fetchJson(
    `${BASE}/assignments/my-assignments?page=${page}&pageSize=${pageSize}`,
    { headers: authHeaders(accessToken) }
  );
}

async function _getAssignmentById(accessToken, id) {
  return fetchJson(`${BASE}/assignments/${id}`, { headers: authHeaders(accessToken) });
}

// --- Materials ---------------------------------------------------------------

async function _getMyMaterials(accessToken) {
  return fetchJson(`${BASE}/materials/my-materials`, { headers: authHeaders(accessToken) });
}

async function _getMaterialById(accessToken, id) {
  return fetchJson(`${BASE}/materials/${id}`, { headers: authHeaders(accessToken) });
}

// --- Exams -------------------------------------------------------------------

async function _getAvailableAttempts(accessToken, page = 1, pageSize = 50) {
  return fetchJson(
    `${BASE}/attempts/available?page=${page}&pageSize=${pageSize}`,
    { headers: authHeaders(accessToken) }
  );
}

async function _getExamModes(accessToken) {
  return fetchJson(`${BASE}/exams/modes`, { headers: authHeaders(accessToken) });
}

// --- Grades ------------------------------------------------------------------
// NOTE: /grades is an Admin/Teacher-only endpoint (verified in the frontend
// bundle: GradesPage uses role:"Admin"). Students get a 403 there. Real student
// grades live in my-assignments (gradePoints) and attempts (exam results), so
// the student-facing "grades" is derived from those.

async function _getGrades(accessToken) {
  // Deprecated as a primary source: kept for compatibility but the student
 // grade view is built from assignments + attempts in fetchScope.
  return fetchJson(`${BASE}/grades`, { headers: authHeaders(accessToken) });
}

// Student-visible grades assembled from sources the student can actually read.
async function _getMyGrades(accessToken) {
  const [assignments, attempts] = await Promise.all([
    getMyAssignments(accessToken).catch(() => ({ items: [] })),
    getAvailableAttempts(accessToken).catch(() => ({ items: [] })),
  ]);
  const out = [];
  for (const a of normalizeAssignments(assignments)) {
    if (a.gradePoints != null || a.status === "Graded") {
      out.push({
        id: `grd-${a.id}`,
        kind: "grade",
        title: a.title,
        subject: a.subject,
        score: a.gradePoints ?? null,
        maxScore: a.maxPoints ?? null,
        status: a.status,
        createdAt: a.dueAt,
        url: a.url,
        raw: a.raw,
      });
    }
  }
  for (const e of normalizeExams(attempts)) {
    if (e.status && /completed|graded|finished/i.test(e.status)) {
      out.push({
        id: `grd-${e.id}`,
        kind: "grade",
        title: e.title,
        subject: e.subject,
        score: e.score ?? null,
        maxScore: null,
        status: e.status,
        createdAt: e.endsAt,
        url: e.url,
        raw: e.raw,
      });
    }
  }
  return out;
}

export const getMyGrades = bind("getMyGrades", _getMyGrades);

async function _getGradesDropdown(accessToken) {
  return fetchJson(`${BASE}/grades/dropdown`, { headers: authHeaders(accessToken) });
}

// --- Dashboard (fast overview, matches what the student sees) ----------------

async function _getStudentHome(accessToken, now = new Date().toISOString()) {
  return fetchJson(`${BASE}/dashboard/student?now=${encodeURIComponent(now)}`, {
    headers: authHeaders(accessToken),
  });
}

// --- Courses / schedule ------------------------------------------------------

async function _getMyCourses(accessToken) {
  return fetchJson(`${BASE}/subjectofferings/my-courses?now=${encodeURIComponent(new Date().toISOString())}`, {
    headers: authHeaders(accessToken),
  });
}

async function _getMySchedule(accessToken, weekStart) {
  const q = weekStart ? `weekStart=${encodeURIComponent(weekStart)}&` : "";
  return fetchJson(`${BASE}/subjectofferings/my-schedule?${q}now=${encodeURIComponent(new Date().toISOString())}`, {
    headers: authHeaders(accessToken),
  });
}

// --- Notifications / announcements ------------------------------------------
// These power the platform's bell icon and are the fastest way to see anything
// new across all subjects at once.

async function _getNotifications(accessToken, page = 1, pageSize = 20) {
  return fetchJson(`${BASE}/notifications?page=${page}&pageSize=${pageSize}`, {
    headers: authHeaders(accessToken),
  });
}

async function _getUnreadCount(accessToken) {
  return fetchJson(`${BASE}/notifications/unread-count`, { headers: authHeaders(accessToken) });
}

async function _getCommunications(accessToken, page = 1, pageSize = 20) {
  return fetchJson(
    `${BASE}/communications?page=${page}&pageSize=${pageSize}`,
    { headers: authHeaders(accessToken) }
  );
}

async function _getCommunicationsUnread(accessToken) {
  return fetchJson(`${BASE}/communications/unread-count`, { headers: authHeaders(accessToken) });
}

export const getNotifications = bind("getNotifications", _getNotifications);
export const getUnreadCount = bind("getUnreadCount", _getUnreadCount);
export const getCommunications = bind("getCommunications", _getCommunications);
export const getCommunicationsUnread = bind("getCommunicationsUnread", _getCommunicationsUnread);

// --- Normalisation -----------------------------------------------------------
// The API shapes differ slightly per resource; normalise to a flat list of items
// the watcher can dedupe on. Keeps the rest of the app dumb about payload shapes.

export function normalizeAssignments(payload) {
  const rows = payload?.items || payload?.data || payload?.assignments || payload || [];
  return (Array.isArray(rows) ? rows : rows?.items || []).map((a) => ({
    id: `asg-${a.id}`,
    kind: "assignment",
    title: a.title,
    subject: a.subjectName || a.offeringTitle || null,
    teacher: a.teacherName || null,
    dueAt: a.dueAt || null,
    status: a.status || null,
    isOverdue: !!a.isOverdue,
    isDueSoon: !!a.isDueSoon,
    maxPoints: a.maxPoints ?? null,
    gradePoints: a.gradePoints ?? null,
    description: a.description || a.instructions || null,
    createdAt: a.createdAt || a.publishedAt || null,
    url: `https://sc.tuwaiq.edu.sa/student/assignments`,
    raw: a,
  }));
}

export function normalizeMaterials(payload) {
  const rows = payload?.materials || payload?.items || payload?.data || payload || [];
  return (Array.isArray(rows) ? rows : rows?.items || []).map((m) => ({
    id: `mat-${m.id}`,
    kind: "material",
    title: m.title,
    subject: m.subjectName || m.offeringTitle || null,
    teacher: m.teacherName || null,
    contentType: m.contentType || null,
    summary: m.summary || null,
    createdAt: m.createdAt || m.publishedAt || null,
    // The frontend modal downloads via href = fileUrl ?? externalUrl, so both
    // are the real "get this file" targets for the /download command.
    fileUrl: m.fileUrl || null,
    externalUrl: m.externalUrl || null,
    url: `https://sc.tuwaiq.edu.sa/student/materials`,
    raw: m,
  }));
}

export function normalizeExams(payload) {
  const rows = payload?.items || payload?.data || payload?.attempts || payload || [];
  return (Array.isArray(rows) ? rows : rows?.items || []).map((e) => ({
    id: `exm-${e.id ?? e.examId}`,
    kind: "exam",
    title: e.title || e.examTitle || `امتحان #${e.id ?? e.examId}`,
    subject: e.subjectName || e.offeringTitle || null,
    teacher: e.teacherName || null,
    status: e.status || null,
    startsAt: e.startsAt || e.availableFrom || null,
    endsAt: e.endsAt || e.availableUntil || null,
    durationMin: e.durationMin || e.timeLimitMin || null,
    url: `https://sc.tuwaiq.edu.sa/student/exams`,
    raw: e,
  }));
}

export function normalizeGrades(payload) {
  const rows = payload?.items || payload?.data || payload?.grades || payload || [];
  return (Array.isArray(rows) ? rows : rows?.items || []).map((g) => ({
    id: `grd-${g.id ?? g.assignmentId ?? g.examId}`,
    kind: "grade",
    title: g.title || g.assignmentTitle || g.examTitle || "نتيجة",
    subject: g.subjectName || g.offeringTitle || null,
    score: g.score ?? g.gradePoints ?? g.marks ?? null,
    maxScore: g.maxScore ?? g.maxPoints ?? g.outOf ?? null,
    status: g.status || null,
    createdAt: g.gradedAt || g.publishedAt || null,
    url: `https://sc.tuwaiq.edu.sa/student/assignments`,
    raw: g,
  }));
}

export function normalizeNotifications(payload) {
  const rows = payload?.items || payload?.data || payload?.notifications || payload || [];
  return (Array.isArray(rows) ? rows : rows?.items || []).map((n) => ({
    id: `ntf-${n.id}`,
    kind: "notification",
    title: n.title || n.subject || n.message?.slice(0, 60) || "إشعار",
    subject: n.subjectName || n.offeringTitle || n.category || null,
    body: n.message || n.body || n.text || null,
    read: !!n.isRead,
    createdAt: n.createdAt || n.sentAt || n.date || null,
    url: `https://sc.tuwaiq.edu.sa/notifications`,
    raw: n,
  }));
}

export const normalize = {
  assignments: normalizeAssignments,
  materials: normalizeMaterials,
  exams: normalizeExams,
  grades: normalizeGrades,
  notifications: normalizeNotifications,
};
