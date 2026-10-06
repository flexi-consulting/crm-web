import { createCrmConnectedBrowserHandler, createCrmControlPlaneClient } from "./connected-browser-bff.js";
import { createCrmBrowserD1Store } from "./connected-browser-d1-store.js";
import { createBuiltCatalogD1HttpHandler } from "./built-catalog-d1-http.js";
import { createCatalogV11ReadHandler, createCatalogV11ParticipantLinkHandler,
  createCatalogV11D1Repository } from "./catalog-query-v11.js";
import { createBuiltCatalogD1Repository } from "./built-catalog-d1.js";
import { createWeeekHttpTransport } from "./weeek-http-transport.js";
import { createWeeekCorrelationProvider } from "./weeek-correlation-provider.js";
import { createConnectedAppDealApproval } from "./connected-app-approval.js";

const unavailable = () => new Response(JSON.stringify({ error: "connected_browser_unavailable" }), {
  status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const notFound = () => new Response(JSON.stringify({ error: "not_found" }), {
  status: 404, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

/**
 * Opt-in Worker composition. Approval must come from a separately reviewed
 * trusted issuer. In particular, an authenticated create scope is not approval.
 */
export function createCrmConnectedWorkerHandler({ fetcher = fetch, now = () => Date.now(),
  resolveWeeekToken, resolveWeeekStatusIds, resolveLeadStatusId,
  resolveTrustedReviewReceipt } = {}) {
  return async (request, env) => {
    if (env?.CRM_CONNECTED_BROWSER_ENABLED !== "true") return notFound();
    try {
      const issuer = env.CRM_CONNECTED_CP_ISSUER;
      const publicOrigin = env.CRM_CONNECTED_PUBLIC_ORIGIN;
      const redirectUri = env.CRM_CONNECTED_REDIRECT_URI;
      const defaultReturnPath = env.CRM_CONNECTED_DEFAULT_CATALOG_PATH;
      const client = createCrmControlPlaneClient({ issuer, allowedIssuerOrigins: [issuer],
        serviceKey: env.CRM_CONNECTED_CP_SERVICE_KEY, fetcher });
      const resolveDealApproval = ({ request: receivedRequest, identity, reviewId, revision, review }) => {
        if (typeof resolveTrustedReviewReceipt === "function")
          return resolveTrustedReviewReceipt({ request: receivedRequest, identity, reviewId, revision, review, env });
        return createConnectedAppDealApproval({ db: env.CRM_DB, issuer,
          prepareApproval: client.prepareApproval, consumeApproval: client.consumeApproval, now })({
          request: receivedRequest, identity, reviewId, revision, review });
      };
      const store = createCrmBrowserD1Store(env.CRM_DB, {
        encryptionKey: env.CRM_CONNECTED_BFF_ENCRYPTION_KEY, now });
      const transport = createWeeekHttpTransport({ fetchImpl: fetcher,
        resolveToken: async (profileId) => {
          if (typeof resolveWeeekToken !== "function") throw new Error("weeek_credential_binding_unavailable");
          return resolveWeeekToken(profileId, env);
        } });
      const provider = createWeeekCorrelationProvider({ transport,
        resolveStatusIds: async (profileId) => {
          if (typeof resolveWeeekStatusIds !== "function") throw new Error("weeek_status_binding_unavailable");
          return resolveWeeekStatusIds(profileId, env);
        } });
      const read = (received, identity) => createBuiltCatalogD1HttpHandler({ db: env.CRM_DB,
        enabled: true, now: () => new Date(now()).toISOString(), provider,
        resolveLeadStatusId: async (profileId) => {
          if (typeof resolveLeadStatusId !== "function") return undefined;
          return resolveLeadStatusId(profileId, env);
        }, resolveTrustedProfile: () => identity,
        resolveTrustedReviewReceipt: (receivedRequest, trusted, reviewId, revision, review) =>
          resolveDealApproval({ request: receivedRequest, identity: trusted, reviewId, revision, review }) })(received);
      const connectedRead = async (received, identity) => {
        const path = new URL(received.url).pathname;
        const eventParticipant = path.match(/^\/catalogs\/(?!build-)([a-z0-9][a-z0-9-]{0,79})\/participants\/(co-[a-f0-9]{20})$/);
        const exhibition = /^\/catalogs\/(?!build-)[a-z0-9][a-z0-9-]{0,79}$/.test(path);
        if (!eventParticipant && !exhibition) return read(received, identity);
        if (!identity?.profileId || !Array.isArray(identity?.scopes)) return new Response(
          JSON.stringify({ error: "trusted_profile_unavailable" }), { status: 503 });
        const resolveTrustedProfile = () => ({ profileId: identity.profileId,
          scopes: identity.scopes.includes("crm.catalog.read") ||
            identity.scopes.includes("crm.catalog.build.read.synthetic") ? ["crm.catalog.read"] : [] });
        const catalogV11 = createCatalogV11D1Repository(env.CRM_DB);
        const builtCatalog = createBuiltCatalogD1Repository(env.CRM_DB);
        if (eventParticipant) return createCatalogV11ParticipantLinkHandler({
          repository: catalogV11, resolveTrustedProfile,
          resolveLegacyParticipant: ({ profileId, eventKey, companyId }) =>
            builtCatalog.resolveLegacyParticipantByCompanyId({
              profileRef: profileId, eventKey, companyId })
        })(received);
        return createCatalogV11ReadHandler({ repository: catalogV11, resolveTrustedProfile,
          resolveParticipantCompanyIds: ({ profileId, eventKey }) => builtCatalog.listLegacyParticipantCompanyIds({
            profileRef: profileId, eventKey }) })(received);
      };
      const browser = createCrmConnectedBrowserHandler({ enabled: true, issuer,
        allowedIssuerOrigins: [issuer], publicOrigin, redirectUri, defaultReturnPath, store,
        exchangeCode: client.exchangeCode, introspect: client.introspect,
        handleScopedRequest: connectedRead, now });
      return await browser(request);
    } catch {
      // D1/CP/config failures never fall through to another route or expose credentials.
      return unavailable();
    }
  };
}

export default {
  fetch: createCrmConnectedWorkerHandler(),
  async scheduled(_event, env) {
    if (env?.CRM_CONNECTED_BROWSER_ENABLED === "true")
      await createCrmBrowserD1Store(env.CRM_DB, {
        encryptionKey: env.CRM_CONNECTED_BFF_ENCRYPTION_KEY }).pruneExpired();
  }
};
