import { createCrmConnectedBrowserHandler, createCrmControlPlaneClient } from "./connected-browser-bff.js";
import { createCrmBrowserD1Store } from "./connected-browser-d1-store.js";
import { createBuiltCatalogD1HttpHandler } from "./built-catalog-d1-http.js";

const unavailable = () => new Response(JSON.stringify({ error: "connected_browser_unavailable" }), {
  status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const notFound = () => new Response(JSON.stringify({ error: "not_found" }), {
  status: 404, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

/** Opt-in Worker composition. No test headers can become a trusted profile or approval. */
export function createCrmConnectedWorkerHandler({ fetcher = fetch, now = () => Date.now() } = {}) {
  return async (request, env) => {
    if (env?.CRM_CONNECTED_BROWSER_ENABLED !== "true") return notFound();
    try {
      const issuer = env.CRM_CONNECTED_CP_ISSUER;
      const publicOrigin = env.CRM_CONNECTED_PUBLIC_ORIGIN;
      const redirectUri = env.CRM_CONNECTED_REDIRECT_URI;
      const defaultReturnPath = env.CRM_CONNECTED_DEFAULT_CATALOG_PATH;
      const client = createCrmControlPlaneClient({ issuer, allowedIssuerOrigins: [issuer],
        serviceKey: env.CRM_CONNECTED_CP_SERVICE_KEY, fetcher });
      const store = createCrmBrowserD1Store(env.CRM_DB, { now });
      // The domain adapter requires a provider port, but the connected boundary permits GET only.
      const read = (received, identity) => createBuiltCatalogD1HttpHandler({ db: env.CRM_DB,
        enabled: true, now: () => new Date(now()).toISOString(),
        provider: { async create() { throw new Error("connected_browser_write_forbidden"); } },
        resolveTrustedProfile: () => identity })(received);
      const browser = createCrmConnectedBrowserHandler({ enabled: true, issuer,
        allowedIssuerOrigins: [issuer], publicOrigin, redirectUri, defaultReturnPath, store,
        exchangeCode: client.exchangeCode, introspect: client.introspect,
        handleScopedRequest: read, now });
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
      await createCrmBrowserD1Store(env.CRM_DB).pruneExpired();
  }
};
