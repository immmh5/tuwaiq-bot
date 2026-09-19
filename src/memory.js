// src/memory.js — short-term conversation memory.
//
// The AI sees the last few exchanges so follow-up questions ("واللي بعده؟",
// "كم درجتها؟") resolve against the same subject without the student
// restating it. Kept in-process per chat: it is a working buffer, not a
// permanent record — a restart clears it, which is the right trade for a
// monitoring bot on the free tier (no DB writes per message).
//
// Long lookback is exposed on demand via getHistory(n), wired to /history.

const MAX_CONTEXT = 5; // exchanges the model sees by default
const MAX_STORED = 40; // ceiling so memory cannot grow unbounded

// chatId -> [{ role, content, ts }]
const store = new Map();

function bucket(chatId) {
  if (!store.has(chatId)) store.set(chatId, []);
  return store.get(chatId);
}

// Record one side of a conversation.
export function remember(chatId, role, content) {
  const b = bucket(chatId);
  b.push({ role, content, ts: Date.now() });
  if (b.length > MAX_STORED) b.splice(0, b.length - MAX_STORED);
}

// The recent slice the model gets as context (user + assistant turns).
export function recentContext(chatId, n = MAX_CONTEXT) {
  return bucket(chatId).slice(-n * 2);
}

// Longer lookback for the /history command and for "scroll back further".
export function getHistory(chatId, n = 10) {
  return bucket(chatId).slice(-n * 2);
}

export function clear(chatId) {
  store.delete(chatId);
}
