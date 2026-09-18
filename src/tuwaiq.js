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

async function _getGrades(accessToken) {
  return fetchJson(`${BASE}/grades`, { headers: authHeaders(accessToken) });
}

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
