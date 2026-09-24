// src/auth.js — Keycloak PKCE login + token management (headless, no browser)
import crypto from "node:crypto";
import { fetch, cookieValue } from "./http.js";

const REALM = "https://sso.tuwaiq.edu.sa/auth/realms/main";
const CLIENT_ID = "eduquest-web";
const REDIRECT_URI = "https://sc.tuwaiq.edu.sa/sso-callback.html";

const base64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function makePkce() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(
    crypto.createHash("sha256").update(verifier, "ascii").digest()
  );
  return { verifier, challenge };
}

function randomString(len = 24) {
  return base64url(crypto.randomBytes(len));
}

// Step 1+2: open authorize URL, parse the login form action (session-bound)
async function openLoginForm() {
  const { verifier, challenge } = makePkce();
  const state = randomString();
  const nonce = randomString();

  const url = new URL(`${REALM}/protocol/openid-connect/auth`);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  const res = await fetch(url.toString(), {
    headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    redirect: "manual",
  });

  if (!res.ok) throw new Error(`authorize HTTP ${res.status}`);

  const html = await res.text();
  const m = html.match(/<form id="kc-form-login"[^>]*action="([^"]+)"/);
  if (!m) throw new Error("login form not found (account may require another flow)");

  const cookie = cookieValue(res.get("set-cookie"));

  return {
    action: m[1].replace(/&amp;/g, "&"),
    cookie,
    verifier,
    state,
    nonce,
  };
}

// Step 3: POST credentials, follow to the redirect that carries ?code=
async function postCredentials(action, cookie, username, password) {
  const body = new URLSearchParams();
  body.set("username", username);
  body.set("password", password);
  body.set("credentialId", "");
  body.set("login", "Log in");

  const res = await fetch(action, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: action,
      Cookie: cookie,
    },
    body,
    redirect: "manual",
  });

  const next = res.get("location");
  const nextCookie = cookieValue(res.get("set-cookie")) || cookie;

  // 302 to redirect_uri?code=... on success
  if (next && next.includes("code=")) {
    return { redirectUrl: next, cookie: nextCookie };
  }

  // Keycloak may bounce through /auth/realms/main/login-actions/authenticate again
  if (next) {
    const res2 = await fetch(next, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Cookie: nextCookie,
      },
      redirect: "manual",
    });
    const loc2 = res2.get("location");
    const c2 = cookieValue(res2.get("set-cookie")) || nextCookie;
    if (loc2 && loc2.includes("code=")) {
      return { redirectUrl: loc2, cookie: c2 };
    }
    if (loc2 && loc2.includes("error=")) {
      const params = new URL(loc2).searchParams;
      throw new Error(
        `login rejected: ${params.get("error")} ${params.get("error_description") || ""}`
      );
    }
  }

  // Fall back to parsing the HTML error banner
  const html = await res.text().catch(() => "");
  const errMatch =
    html.match(/بيانات الدخول غير صحيحة/) ||
    html.match(/Invalid username or password/) ||
    html.match(/class="[^"]*error-message[^"]*"[^>]*>\s*([^<]{3,120})/);
  throw new Error(
    errMatch ? `login failed: ${errMatch[1] || errMatch[0]}` : `login failed (HTTP ${res.status})`
  );
}

// Step 4: exchange code for tokens
async function exchangeCode(code, verifier) {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("client_id", CLIENT_ID);
  body.set("redirect_uri", REDIRECT_URI);
  body.set("code_verifier", verifier);

  const res = await fetch(`${REALM}/protocol/openid-connect/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const data = parseJson(await res.text());
  if (!res.ok || !data.access_token) {
    throw new Error(`token exchange failed: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

// Establish a real browser session against the platform itself.
//
// The OAuth bearer token is honoured by the API but NOT by the web app —
// /student/schedule redirects to login unless it sees Keycloak's
// AUTH_SESSION_ID cookie. A cheap browser-style pass through the platform's
// own /login route (which 302s into Keycloak and back) collects that cookie,
// so any page can then be read exactly as the student sees it.
export async function establishSession(accessToken) {
  const jar = [];
  const remember = (res) => {
    const set = res.get("set-cookie");
    if (set) jar.push(set.split(/\s*;\s*/)[0]);
  };

  // 1. GET /login with the bearer token; the app redirects into Keycloak to
  //    start a code flow, exactly as a browser visit would.
  let res = await fetch("https://sc.tuwaiq.edu.sa/login", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "manual",
    timeout: 30,
  });
  remember(res);

  // 2. Walk the redirect chain manually, collecting every Set-Cookie.
  //    The one that matters is AUTH_SESSION_ID, issued by Keycloak.
  let loc = res.get("location");
  let hops = 0;
  while (loc && hops < 8) {
    res = await fetch(loc, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        ...(jar.length ? { Cookie: jar.join("; ") } : {}),
      },
      redirect: "manual",
      timeout: 30,
    });
    remember(res);
    const next = res.get("location");
    if (!next) break;
    loc = next;
    hops++;
  }

  const cookieStr = jar.join("; ");
  return { cookie: cookieStr, ok: /AUTH_SESSION_ID/.test(cookieStr), hops };
}

// Indirection so tests can swap the implementation (ES module namespace
// bindings are read-only). Production code calls authImpl.* through the
// exported wrappers below.
export const authImpl = {};

export async function login(username, password) {
  return (authImpl.login ||= realLogin)(username, password);
}

export async function refresh(refreshToken) {
  return (authImpl.refresh ||= realRefresh)(refreshToken);
}

export async function realLogin(username, password) {
  const form = await openLoginForm();
  const { redirectUrl } = await postCredentials(form.action, form.cookie, username, password);

  const code = new URL(redirectUrl).searchParams.get("code");
  const returnedState = new URL(redirectUrl).searchParams.get("state");
  if (!code) throw new Error("no authorization code in redirect");
  if (returnedState && returnedState !== form.state) throw new Error("state mismatch (possible MITM)");

  const tokens = await exchangeCode(code, form.verifier);
  return normalizeTokens(tokens);
}

export async function realRefresh(refreshToken) {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("client_id", CLIENT_ID);

  const res = await fetch(`${REALM}/protocol/openid-connect/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const data = parseJson(await res.text());
  if (!res.ok || !data.access_token) {
    throw new Error(`token refresh failed: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return normalizeTokens(data);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`token endpoint returned non-JSON: ${text.slice(0, 200)}`);
  }
}

function normalizeTokens(t) {
  const now = Math.floor(Date.now() / 1000);
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token || null,
    idToken: t.id_token || null,
    // Keycloak returns relative expires_in; absolute is safer to store
    accessExpiresAt: t.expires_in ? now + Number(t.expires_in) : now + 300,
    refreshExpiresAt: t.refresh_expires_in ? now + Number(t.refresh_expires_in) : now + 86400,
  };
}

export function decodeToken(token) {
  try {
    const part = token.split(".")[1];
    return JSON.parse(
      Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
  } catch {
    return null;
  }
}
