import { createBuiltCatalogD1HttpHandler } from "./built-catalog-d1-http.js";

// Pinned to trained-assist-control-plane#66 (connected-app-identity v1).
// This boundary is opt-in and read-only. The control plane, not the app or
// browser, selects the profile and grants the audience-specific scopes.
const AUDIENCE = "crm-web";
const SCOPES = new Set(["crm.catalog.read", "crm.notes.read", "crm.deals.read"]);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SCOPE = /^[A-Za-z][A-Za-z0-9.]{1,99}$/;
const READ_ROUTES = [
  { pattern: /^\/catalogs\/build-[a-f0-9]{24}(?:\/participants\/co-[a-f0-9]{20})?$/, scope: "crm.catalog.read" },
  { pattern: /^\/api\/v1\/catalog-builds\/build-[a-f0-9]{24}(?:\/participants(?:\/co-[a-f0-9]{20})?)?$/, scope: "crm.catalog.read" },
  { pattern: /^\/api\/v1\/deal-reviews\/review-[0-9a-f-]{36}$/, scope: "crm.deals.read" },
  { pattern: /^\/api\/v1\/deal-operations\/op-[0-9a-f-]{36}$/, scope: "crm.deals.read" }
];
const json = (status, error) => new Response(JSON.stringify({ error }), { status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export function activeIdentity(value, issuer, nowSeconds) {
  if (!value || Object.keys(value).sort().join(",") !==
    "active,aud,exp,iss,nbf,profileId,scopes,sessionId,sub" || value.active !== true ||
    value.iss !== issuer || value.aud !== AUDIENCE ||
    ![value.sub, value.profileId, value.sessionId].every((part) => ID.test(part)) ||
    !Number.isInteger(value.nbf) || !Number.isInteger(value.exp) ||
    value.nbf > nowSeconds || value.exp <= nowSeconds || value.exp <= value.nbf ||
    value.exp - value.nbf > 3600 || !Array.isArray(value.scopes) ||
    value.scopes.length < 1 || value.scopes.length > 16 ||
    new Set(value.scopes).size !== value.scopes.length ||
    !value.scopes.every((scope) => SCOPE.test(scope) && SCOPES.has(scope))) return null;
  return { profileId: value.profileId, principalId: value.sub,
    sessionId: value.sessionId, scopes: value.scopes };
}

export function createConnectedCrmReadBoundary({ enabled = false, issuer, introspect,
  handleScopedRequest, now = () => Math.floor(Date.now() / 1000) } = {}) {
  return async (request) => {
    if (!enabled) return json(404, "not_found");
    if (typeof introspect !== "function" || typeof handleScopedRequest !== "function" ||
        typeof issuer !== "string" || !issuer.startsWith("https://"))
      return json(503, "connected_identity_unavailable");
    let url;
    try { url = new URL(request.url); } catch { return json(400, "invalid_url"); }
    const route = READ_ROUTES.find((entry) => entry.pattern.test(url.pathname));
    if (request.method !== "GET" || !route) return json(404, "not_found");
    // Neither query values nor legacy cookies may carry profile identity.
    if (["profileId", "userId", "token", "access_token"].some((key) => url.searchParams.has(key)))
      return json(400, "untrusted_identity_input");
    const authorization = request.headers.get("authorization");
    const match = /^Bearer ([A-Za-z0-9._~+/-]{16,512})$/.exec(authorization ?? "");
    if (!match) return json(401, "connected_session_required");
    let result;
    try { result = await introspect({ token: match[1], audience: AUDIENCE }); }
    catch { return json(503, "connected_identity_unavailable"); }
    if (result?.active === false && Object.keys(result).length === 1)
      return json(401, "connected_session_inactive");
    const identity = activeIdentity(result, issuer, now());
    if (!identity) return json(503, "connected_identity_invalid");
    if (!identity.scopes.includes(route.scope)) return json(403, "required_scope_missing");
    // Only synthetic read scopes are translated for the existing D1 handler.
    // This wrapper's route allowlist prevents their reuse on mutation routes.
    const scopes = identity.scopes.flatMap((scope) => scope === "crm.catalog.read"
      ? ["crm.catalog.build.read.synthetic"] : scope === "crm.deals.read"
        ? ["crm.deals.review.synthetic", "crm.deals.operations.read.synthetic"] : []);
    return handleScopedRequest(request, { profileId: identity.profileId, scopes,
      principalId: identity.principalId, sessionId: identity.sessionId });
  };
}

export function createConnectedCrmD1ReadHandler({ db, provider, issuer, introspect,
  enabled = false, now } = {}) {
  return createConnectedCrmReadBoundary({ enabled, issuer, introspect, now,
    handleScopedRequest: (request, identity) => createBuiltCatalogD1HttpHandler({
      db, provider, enabled: true, resolveTrustedProfile: () => identity
    })(request) });
}
