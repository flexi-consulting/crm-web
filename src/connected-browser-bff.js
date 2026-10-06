import { activeIdentity, createConnectedCrmReadBoundary } from "./connected-profile-session.js";

const AUDIENCE = "crm-web";
const PENDING = "__Host-crm-connected-pending";
const SESSION = "__Host-crm-connected-session";
const AUTH_PATH = "/v1/connected-app-sessions/authorize";
const SCOPES = ["crm.catalog.read", "crm.deals.read"];
const encoder = new TextEncoder();
const random = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const hex = (bytes) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
const digest = async (value) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const challenge = async (verifier) => base64url(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));
const safeHex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const cookie = (name, value, age, sameSite = "Strict") =>
  `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=${sameSite}`;
const error = (status, code) => new Response(JSON.stringify({ error: code }), { status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const redirect = (location, cookies = []) => {
  const headers = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  for (const value of cookies) headers.append("set-cookie", value);
  return new Response(null, { status: 303, headers });
};
function readCookie(request, name) {
  const values = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return safeHex(value) ? value : null;
}

/** Disposable test store. A deployed Worker must inject a durable store with atomic takePending. */
export function createMemoryCrmBrowserStore() {
  const pending = new Map();
  const sessions = new Map();
  return {
    async putPending(key, value) { pending.set(key, structuredClone(value)); },
    async takePending(key) { const value = pending.get(key) ?? null; pending.delete(key); return value; },
    async putSession(key, value) { sessions.set(key, structuredClone(value)); },
    async getSession(key) { return sessions.get(key) ?? null; },
    async deleteSession(key) { sessions.delete(key); }
  };
}

/** Only the BFF calls these ports. The service credential belongs in a server secret binding. */
export function createCrmControlPlaneClient({ issuer, allowedIssuerOrigins, serviceKey, fetcher = fetch } = {}) {
  if (typeof issuer !== "string" || !issuer.startsWith("https://") || new URL(issuer).origin !== issuer ||
      !allowedIssuerOrigins?.includes(issuer) || typeof serviceKey !== "string" || serviceKey.length < 32)
    throw new TypeError("connected_client_configuration_required");
  const authorization = `Bearer ${serviceKey}`;
  return {
    async exchangeCode({ code, state, verifier, redirectUri }) {
      const response = await fetcher(`${issuer}/v1/connected-app-sessions/exchange`, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
        headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: AUDIENCE,
          redirect_uri: redirectUri, code, state, code_verifier: verifier })
      });
      return response.status === 201 ? response.json() : null;
    },
    async introspect({ token, audience }) {
      const response = await fetcher(`${issuer}/v1/connected-app-sessions/introspect`, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ token, audience })
      });
      if (!response.ok) throw new Error("connected_identity_unavailable");
      return response.json();
    }
  };
}

/** Disabled by default. Browser credentials never reach the domain handler. */
export function createCrmConnectedBrowserHandler({ enabled = false, issuer, allowedIssuerOrigins,
  publicOrigin, redirectUri, store, exchangeCode, introspect, handleScopedRequest,
  now = () => Date.now() } = {}) {
  if (!enabled) return async () => error(404, "not_found");
  if (typeof issuer !== "string" || !issuer.startsWith("https://") || new URL(issuer).origin !== issuer ||
      !allowedIssuerOrigins?.includes(issuer) || typeof publicOrigin !== "string" ||
      !publicOrigin.startsWith("https://") || new URL(publicOrigin).origin !== publicOrigin ||
      redirectUri !== `${publicOrigin}/auth/connected/callback` ||
      !store || !["putPending", "takePending", "putSession", "getSession", "deleteSession"]
        .every((key) => typeof store[key] === "function") ||
      typeof exchangeCode !== "function" || typeof introspect !== "function" ||
      typeof handleScopedRequest !== "function") throw new TypeError("connected_browser_ports_required");

  const scopedRead = createConnectedCrmReadBoundary({ enabled: true, issuer, introspect,
    handleScopedRequest, now: () => Math.floor(now() / 1000) });
  return async (request) => {
    const url = new URL(request.url);
    if (url.origin !== publicOrigin) return error(400, "invalid_origin");
    if (url.pathname === "/auth/connected/start" && request.method === "GET") {
      if (url.searchParams.size) return error(400, "invalid_auth_request");
      const handle = random(), state = random(), verifier = random();
      await store.putPending(await digest(handle), { state, verifier, createdAt: now() });
      const target = new URL(AUTH_PATH, issuer);
      for (const [key, value] of Object.entries({ response_type: "code", client_id: AUDIENCE,
        redirect_uri: redirectUri, scope: SCOPES.join(" "), state,
        code_challenge_method: "S256", code_challenge: await challenge(verifier) }))
        target.searchParams.set(key, value);
      return redirect(target.href, [cookie(PENDING, handle, 300, "Lax")]);
    }
    if (url.pathname === "/auth/connected/callback" && request.method === "GET") {
      const handle = readCookie(request, PENDING);
      const transaction = handle ? await store.takePending(await digest(handle)) : null;
      const keys = [...url.searchParams.keys()];
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      if (!transaction || now() - transaction.createdAt > 300_000 || keys.length !== 3 ||
          new Set(keys).size !== 3 || keys.some((key) => !["code", "state", "iss"].includes(key)) ||
          !safeHex(code) || state !== transaction.state || url.searchParams.get("iss") !== issuer)
        return error(401, "invalid_auth_callback");
      let exchanged;
      try { exchanged = await exchangeCode({ code, state, verifier: transaction.verifier, redirectUri }); }
      catch { return error(503, "token_exchange_unavailable"); }
      if (!safeHex(exchanged?.token) || !Number.isSafeInteger(exchanged.expiresAt) ||
          exchanged.expiresAt <= Math.floor(now() / 1000)) return error(503, "token_exchange_unavailable");
      let identity;
      try { identity = await introspect({ token: exchanged.token, audience: AUDIENCE }); }
      catch { return error(503, "connected_identity_unavailable"); }
      if (!activeIdentity(identity, issuer, Math.floor(now() / 1000)) ||
          identity.exp > exchanged.expiresAt || !SCOPES.every((scope) => identity.scopes.includes(scope)))
        return error(401, "connected_session_inactive");
      const newHandle = random();
      await store.putSession(await digest(newHandle), { token: exchanged.token, csrf: random(),
        createdAt: now(), expiresAt: exchanged.expiresAt });
      const previous = readCookie(request, SESSION);
      if (previous) await store.deleteSession(await digest(previous));
      return redirect(publicOrigin, [cookie(PENDING, "", 0, "Lax"), cookie(SESSION, newHandle, 3600)]);
    }
    if (url.pathname === "/auth/connected/logout" && request.method === "POST") {
      const handle = readCookie(request, SESSION);
      const record = handle ? await store.getSession(await digest(handle)) : null;
      if (!record || request.headers.get("origin") !== publicOrigin ||
          request.headers.get("x-csrf-token") !== record.csrf) return error(403, "csrf_required");
      if (handle) await store.deleteSession(await digest(handle));
      return new Response(null, { status: 204, headers: { "set-cookie": cookie(SESSION, "", 0),
        "cache-control": "no-store" } });
    }
    if (request.method !== "GET") return error(404, "not_found");
    if (request.headers.has("authorization")) return error(400, "untrusted_browser_authorization");
    const handle = readCookie(request, SESSION);
    if (!handle) return error(401, "connected_session_required");
    const session = await store.getSession(await digest(handle));
    if (!safeHex(session?.token)) return error(401, "connected_session_required");
    if (url.pathname === "/auth/connected/session") {
      if (url.searchParams.size) return error(400, "invalid_query");
      let identity;
      try { identity = await introspect({ token: session.token, audience: AUDIENCE }); }
      catch { return error(503, "connected_identity_unavailable"); }
      const active = activeIdentity(identity, issuer, Math.floor(now() / 1000));
      if (!active) return identity?.active === false ? error(401, "connected_session_inactive") :
        error(503, "connected_identity_invalid");
      return new Response(JSON.stringify({ authenticated: true, profileId: active.profileId,
        scopes: active.scopes, csrfToken: session.csrf }), { status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    headers.set("authorization", `Bearer ${session.token}`);
    return scopedRead(new Request(request, { headers }));
  };
}
