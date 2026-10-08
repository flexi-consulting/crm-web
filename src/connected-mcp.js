import capability from "../capabilities/s01-exhibition-catalog-search.v1.1.json" with { type: "json" };
import inputSchema from "../schemas/s01-catalog-search-input.schema.json" with { type: "json" };

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow"
};
const MAX_BODY_BYTES = 64 * 1024;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function response(body, status = 200, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status, headers: { ...JSON_HEADERS, ...headers }
  });
}

function rpc(id, result) {
  return response({ jsonrpc: "2.0", id, ...result });
}

function validArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some(key => !hasOwn(inputSchema.properties, key))) return false;
  if (inputSchema.required.some(key => !hasOwn(value, key))) return false;
  for (const [key, item] of Object.entries(value)) {
    const schema = inputSchema.properties[key];
    if (schema.type === "string" || schema.enum) {
      if (typeof item !== "string" || schema.maxLength !== undefined && [...item].length > schema.maxLength ||
          schema.pattern && !(new RegExp(schema.pattern)).test(item) || schema.enum && !schema.enum.includes(item)) return false;
    } else if (schema.type === "integer") {
      if (!Number.isInteger(item) || schema.minimum !== undefined && item < schema.minimum ||
          schema.maximum !== undefined && item > schema.maximum) return false;
    } else return false;
  }
  return true;
}

async function readJson(request) {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return { error: "body_too_large" };
  if (!request.body) return { error: "empty_body" };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return { error: "body_too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }; }
  catch { return { error: "invalid_json" }; }
}

function acceptedJson(request) {
  const accept = request.headers.get("accept") ?? "";
  return accept.split(",").some(part => {
    const mediaType = part.trim().split(";", 1)[0].toLowerCase();
    return mediaType === "application/json" || mediaType === "*/*";
  });
}

function errorForDomain(status) {
  if (status === 401 || status === 503) return { code: -32001, message: "AUTH_CONTEXT_UNAVAILABLE" };
  if (status === 403) return { code: -32003, message: "SCOPE_DENIED" };
  if (status === 400) return { code: -32602, message: "INVALID_ARGUMENTS" };
  if (status === 404) return { code: -32004, message: "NOT_FOUND" };
  return { code: -32005, message: "DOMAIN_UNAVAILABLE" };
}

async function callCatalog(request, args, handleRead) {
  const url = new URL(`/api/v1/catalogs/${encodeURIComponent(args.exhibitionId)}/entries`, request.url);
  for (const [key, value] of Object.entries(args)) {
    if (key !== "exhibitionId") url.searchParams.set(key, String(value));
  }
  const headers = new Headers();
  const authorization = request.headers.get("authorization");
  if (authorization) headers.set("authorization", authorization);
  const result = await handleRead(new Request(url, { method: "GET", headers }));
  const body = await result.json().catch(() => null);
  if (!result.ok) return { error: errorForDomain(result.status) };
  return { body };
}

/** Stateless Streamable HTTP JSON MCP endpoint for the declared CRM catalog read capability. */
export function createCrmConnectedMcpHandler({ enabled = false, handleRead } = {}) {
  if (typeof handleRead !== "function") throw new TypeError("connected CRM MCP requires the trusted canonical read handler");
  return async request => {
    if (!enabled) return response({ error: "not_found" }, 404);
    if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405, { allow: "POST" });
    if (!acceptedJson(request)) return response({ error: "not_acceptable" }, 406);
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
      return response({ error: "unsupported_media_type" }, 415);

    const parsed = await readJson(request);
    if (parsed.error === "body_too_large") return response({ error: parsed.error }, 413);
    if (parsed.error) return response({ error: parsed.error }, 400);
    const message = parsed.value;
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" ||
        typeof message.method !== "string") return rpc(message?.id ?? null, { error: { code: -32600, message: "Invalid Request" } });
    if (message.method !== "initialize") {
      const protocolVersion = request.headers.get("mcp-protocol-version") ?? "2025-03-26";
      if (protocolVersion !== capability.mcpTool.protocolVersion)
        return response({ jsonrpc: "2.0", id: hasOwn(message, "id") ? message.id : null,
          error: { code: -32002, message: "UNSUPPORTED_PROTOCOL_VERSION" } }, 400);
    }
    const hasId = hasOwn(message, "id");
    const validId = typeof message.id === "string" || Number.isSafeInteger(message.id) || message.id === null;
    if (hasId && !validId) return rpc(null, { error: { code: -32600, message: "Invalid Request" } });
    if (!hasId) {
      if (message.method.startsWith("notifications/")) return response(null, 202);
      return response(null, 202);
    }

    if (message.method === "initialize") {
      if (message.params?.protocolVersion !== capability.mcpTool.protocolVersion)
        return rpc(message.id, { error: { code: -32002, message: "CAPABILITY_VERSION_MISMATCH" } });
      return rpc(message.id, { result: {
        protocolVersion: capability.mcpTool.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "crm-web", version: capability.version }
      } });
    }
    if (message.method === "tools/list") {
      return rpc(message.id, { result: { tools: [{
        name: capability.mcpTool.name,
        description: capability.description,
        inputSchema,
        _meta: { capabilityId: capability.capabilityId, capabilityVersion: capability.version,
          effect: capability.effect, requiredScopes: capability.requiredScopes }
      }] } });
    }
    if (message.method !== "tools/call")
      return rpc(message.id, { error: { code: -32601, message: "Method not found" } });

    const params = message.params;
    if (params?.name !== capability.mcpTool.name)
      return rpc(message.id, { error: { code: -32602, message: "UNKNOWN_TOOL" } });
    if (params?._meta?.capabilityVersion !== capability.version)
      return rpc(message.id, { error: { code: -32002, message: "CAPABILITY_VERSION_MISMATCH" } });
    if (!validArgs(params.arguments))
      return rpc(message.id, { error: { code: -32602, message: "INVALID_ARGUMENTS" } });
    let domain;
    try { domain = await callCatalog(request, params.arguments, handleRead); }
    catch { return rpc(message.id, { error: { code: -32005, message: "DOMAIN_UNAVAILABLE" } }); }
    if (domain.error) return rpc(message.id, { error: domain.error });
    return rpc(message.id, { result: {
      content: [{ type: "text", text: JSON.stringify(domain.body) }],
      structuredContent: domain.body,
      isError: false
    } });
  };
}
