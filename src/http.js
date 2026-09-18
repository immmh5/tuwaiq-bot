// src/http.js — transport layer.
//
// Why curl instead of fetch(): sc.tuwaiq.edu.sa sits behind Cloudflare bot
// management that fingerprints the TLS ClientHello (JA3). Node's TLS stack
// gets a permanent 403; curl and Python pass. We therefore drive the system
// curl binary, which also gives us exact control over redirects and cookies.
//
// Everything is passed as an argv array (no shell), so headers/bodies are safe.

import { spawn } from "node:child_process";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const DEFAULT_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
  "sec-ch-ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

/**
 * Perform an HTTP request through curl.
 * @returns {Promise<{status:number, headers:object, text:string, ok:boolean}>}
 */
export function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "-sS",
      "--show-error",
      "--compressed",
      "--no-buffer",
      "-D", "-", // dump headers to stdout, body follows after blank line
      "-o", "-", // body to stdout as well
      "-w", "\n__STATUS__:%{http_code}",
      "-X", opts.method || "GET",
      "--max-time", String(opts.timeout || 45),
      ...(opts.redirect === "manual" ? [] : ["-L"]),
    ];

    // cookies
    if (opts.cookie) args.push("-H", `Cookie: ${opts.cookie}`);

    // headers
    const headers = { ...DEFAULT_HEADERS, ...(opts.headers || {}) };
    if (opts.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    for (const [k, v] of Object.entries(headers)) {
      args.push("-H", `${k}: ${v}`);
    }

    // body (passed via stdin so binary/unicode payloads stay intact)
    let body = null;
    if (opts.body) {
      if (typeof opts.body === "string" || Buffer.isBuffer(opts.body)) {
        body = Buffer.from(opts.body);
      } else if (opts.body instanceof URLSearchParams) {
        body = Buffer.from(opts.body.toString());
      } else {
        body = Buffer.from(JSON.stringify(opts.body));
        args.push("-H", "Content-Type: application/json");
      }
      args.push("--data-binary", "@-");
    }

    args.push(url);

    const child = spawn("curl", args, { env: process.env });
    const chunks = [];
    let stderr = "";

    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => (stderr += c.toString()));

    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error("curl binary not found — the container must install curl"));
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (code !== 0 && !chunks.length) {
        return reject(new Error(`curl exited ${code}: ${stderr.trim()}`));
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve(parseCurlOutput(raw, stderr));
    });

    if (body) child.stdin.write(body);
    child.stdin.end();
  });
}

function parseCurlOutput(raw, stderr) {
  // curl with -D - -o - writes: response headers \r\n\r\n then body,
  // then (for -L) any further header blocks, ending with our __STATUS__ marker.
  const statusMatch = raw.match(/__STATUS__:(\d+)\s*$/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const withoutStatus = raw.replace(/__STATUS__:\d*\s*$/, "");

  // Take the LAST header block (after final redirect) and everything after it as body.
  const lastBreak = withoutStatus.lastIndexOf("\r\n\r\n");
  let headersText, bodyText;
  if (lastBreak === -1) {
    headersText = withoutStatus;
    bodyText = "";
  } else {
    headersText = withoutStatus.slice(0, lastBreak);
    bodyText = withoutStatus.slice(lastBreak + 4);
  }

  const headers = {};
  let firstLine = null;
  for (const line of headersText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^HTTP\/[\d.]+\s/.test(line)) {
      firstLine = line;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx > -1) {
      const k = line.slice(0, idx).trim().toLowerCase();
      const v = line.slice(idx + 1).trim();
      // set-cookie may appear multiple times; keep the first, expose all
      if (k === "set-cookie") {
        if (!headers[k]) headers[k] = v;
        (headers.__cookies = headers.__cookies || []).push(v);
      } else {
        headers[k] = v;
      }
    }
  }

  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: () => Promise.resolve(bodyText),
    get: (h) => headers[h.toLowerCase()],
    _stderr: stderr,
  };
}

export async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();

  if (res.status === 403 && text.includes("Cloudflare")) {
    throw new Error("blocked by Cloudflare (403)");
  }

  // The backend returns 500 (not 401) when a JWT is malformed/expired in a way
  // its middleware can't handle. Treat that as an auth problem so the caller
  // re-logins instead of retrying a broken token forever.
  if (res.status === 500 && opts.headers?.Authorization) {
    throw new Error(`auth/token problem (HTTP 500) on ${url}`);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}

// Convenience: extract the first set-cookie value without attributes
export function cookieValue(setCookieHeader) {
  if (!setCookieHeader) return null;
  return setCookieHeader.split(";")[0];
}
