import { createServer as nodeCreateServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { catalog } from "./fixtures.js";

const manifest = {
  serviceId: "crm-web.exhibitions",
  release: {
    version: process.env.CRM_WEB_RELEASE_VERSION ?? "0.1.0",
    sourceRevision: process.env.CRM_WEB_SOURCE_REVISION ?? "working-tree",
    environment: process.env.CRM_WEB_ENVIRONMENT ?? "development"
  },
  platformContractRange: ">=1.0.0 <2.0.0",
  domainApiVersion: "1.0.0",
  capabilities: [{
    id: "exhibitions.catalog.read",
    version: "1.0.0",
    required: true,
    inputSchemaRef: "schemas/catalog-query.schema.json",
    outputSchemaRef: "schemas/catalog.schema.json",
    effect: "read",
    requiredScopes: [],
    operationRef: "GET /api/v1/catalog"
  }],
  readiness: {
    status: "ready",
    scope: "local_process_only",
    reason: { code: "local_process_available" },
    checked: {
      serviceId: "crm-web.exhibitions",
      release: {
        version: process.env.CRM_WEB_RELEASE_VERSION ?? "0.1.0",
        sourceRevision: process.env.CRM_WEB_SOURCE_REVISION ?? "working-tree",
        environment: process.env.CRM_WEB_ENVIRONMENT ?? "development"
      },
      platformContractRange: ">=1.0.0 <2.0.0",
      domainApiVersion: "1.0.0"
    }
  },
  compatibility: { deprecatedCapabilities: [] },
  endpoints: {
    readiness: { method: "GET", path: "/api/v1/readiness" },
    catalog: { method: "GET", path: "/api/v1/catalog" }
  }
};

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

export function createServer() {
  return nodeCreateServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      return json(response, 405, { error: "method_not_allowed" });
    }
    if (url.pathname === "/api/v1/manifest") return json(response, 200, manifest);
    if (url.pathname === "/api/v1/readiness") {
      return json(response, 200, manifest.readiness);
    }
    if (url.pathname === "/api/v1/catalog") {
      const params = [...url.searchParams.keys()];
      const queryValues = url.searchParams.getAll("q");
      if (params.some((key) => key !== "q") || queryValues.length > 1 || (queryValues[0] && [...queryValues[0]].length > 120)) {
        return json(response, 400, { error: "invalid_query" });
      }
      const query = (queryValues[0] ?? "").trim().toLocaleLowerCase("en");
      const items = query
        ? catalog.filter((item) => `${item.name} ${item.city} ${item.country}`.toLocaleLowerCase("en").includes(query))
        : catalog;
      return json(response, 200, { domainApiVersion: manifest.domainApiVersion, items });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(new URL("../public/index.html", import.meta.url));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return response.end(html);
    }
    return json(response, 404, { error: "not_found" });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, "127.0.0.1", () => {
    console.log(`crm-web listening on http://127.0.0.1:${port}`);
  });
}
