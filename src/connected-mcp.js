import capability from "../capabilities/s01-exhibition-catalog-search.v1.1.json" with { type: "json" };
import inputSchema from "../schemas/s01-catalog-search-input.schema.json" with { type: "json" };
import dealCapability from "../capabilities/s04-deals-agent-mcp.v1.json" with { type: "json" };
import dealReviewInput from "../schemas/s04-review-input.schema.json" with { type: "json" };
import dealCreateInput from "../schemas/s04-create-input.schema.json" with { type: "json" };
import dealOperationInput from "../schemas/s04-operation-input.schema.json" with { type: "json" };

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

async function callCatalog(request, args, handleCall) {
  const url = new URL(`/api/v1/catalogs/${encodeURIComponent(args.exhibitionId)}/entries`, request.url);
  for (const [key, value] of Object.entries(args)) {
    if (key !== "exhibitionId") url.searchParams.set(key, String(value));
  }
  const headers = new Headers();
  const authorization = request.headers.get("authorization");
  if (authorization) headers.set("authorization", authorization);
  const result = await handleCall(new Request(url, { method: "GET", headers }));
  const body = await result.json().catch(() => null);
  if (!result.ok) return { error: errorForDomain(result.status) };
  return { body };
}

const exactKeys = (value, schema) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every((key) => Object.hasOwn(schema.properties, key)) &&
  schema.required.every((key) => Object.hasOwn(value, key));
function validDealArgs(tool, args) {
  const schema = tool.operation === "prepare" ? dealReviewInput :
    tool.operation === "confirm" ? dealCreateInput : dealOperationInput;
  if (!exactKeys(args, schema)) return false;
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key];
    if (field.type === "string" && (typeof value !== "string" ||
        field.minLength !== undefined && [...value].length < field.minLength ||
        field.maxLength !== undefined && [...value].length > field.maxLength ||
        field.pattern && !(new RegExp(field.pattern)).test(value))) return false;
  }
  if (args.buildId && !/^co-[a-f0-9]{20}$/.test(args.companyId ?? "") ||
      !args.buildId && /^co-/.test(args.companyId ?? "")) return false;
  return true;
}

function dealRequest(request, tool, args) {
  let path = tool.httpBinding.split(" ", 2)[1];
  for (const [key, value] of Object.entries(args))
    path = path.replace(`{${key}}`, encodeURIComponent(value));
  const method = tool.httpBinding.split(" ", 2)[0];
  const body = tool.operation === "prepare" ? args : tool.operation === "confirm" ? { revision: args.revision } : {};
  return new Request(new URL(path, request.url), { method,
    headers: { authorization: request.headers.get("authorization") ?? "",
      ...(method === "POST" ? { "content-type": "application/json" } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
}

async function invokeDomain(handleCall, request, { expectedPending = false } = {}) {
  const result = await handleCall(request);
  const body = await result.json().catch(() => null);
  if (expectedPending && result.status === 409 && body?.error === "human_approval_required")
    return { body, pending: true };
  if (result.status === 202 && body?.status === "unknown") return { body, pending: true };
  if (!result.ok) return { error: errorForDomain(result.status) };
  return { body };
}

/** Stateless Streamable HTTP JSON MCP endpoint for the declared CRM catalog read capability. */
export function createCrmConnectedMcpHandler({ enabled = false, dealsEnabled = false,
  handleRead, handleCall = handleRead } = {}) {
  if (typeof handleRead !== "function" || typeof handleCall !== "function")
    throw new TypeError("connected CRM MCP requires trusted canonical handlers");
  const dealTools = dealCapability.tools.filter((tool) =>
    ["prepare", "confirm", "get", "reconcile"].includes(tool.operation));
  const listedTools = [{ name: capability.mcpTool.name, description: capability.description,
    inputSchema, _meta: { capabilityId: capability.capabilityId, capabilityVersion: capability.version,
      effect: capability.effect, requiredScopes: capability.requiredScopes } },
  ...(dealsEnabled ? dealTools.map((tool) => ({ name: tool.name, description: dealCapability.description,
    inputSchema: JSON.parse(JSON.stringify(tool.operation === "prepare" ? dealReviewInput :
      tool.operation === "confirm" ? dealCreateInput : dealOperationInput)),
    _meta: { capabilityId: dealCapability.capabilityId, capabilityVersion: dealCapability.version,
      effect: tool.operation === "get" ? "read" : "write", requiredScopes: [tool.scope] } })) : [])];
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
        serverInfo: { name: "crm-web", version: dealsEnabled ? "1.2.0" : capability.version }
      } });
    }
    if (message.method === "tools/list") {
      return rpc(message.id, { result: { tools: listedTools } });
    }
    if (message.method !== "tools/call")
      return rpc(message.id, { error: { code: -32601, message: "Method not found" } });

    const params = message.params;
    const dealTool = dealsEnabled && dealTools.find((tool) => tool.name === params?.name);
    const expectedVersion = dealTool ? dealCapability.version : capability.version;
    if (params?.name !== capability.mcpTool.name && !dealTool)
      return rpc(message.id, { error: { code: -32602, message: "UNKNOWN_TOOL" } });
    if (params?._meta?.capabilityVersion !== expectedVersion)
      return rpc(message.id, { error: { code: -32002, message: "CAPABILITY_VERSION_MISMATCH" } });
    if (dealTool ? !validDealArgs(dealTool, params.arguments) : !validArgs(params.arguments))
      return rpc(message.id, { error: { code: -32602, message: "INVALID_ARGUMENTS" } });
    let domain;
    try {
      domain = dealTool
        ? await invokeDomain(handleCall, dealRequest(request, dealTool, params.arguments),
          { expectedPending: dealTool.operation === "confirm" })
        : await callCatalog(request, params.arguments, handleCall);
    } catch { return rpc(message.id, { error: { code: -32005, message: "DOMAIN_UNAVAILABLE" } }); }
    if (domain.error) return rpc(message.id, { error: domain.error });
    return rpc(message.id, { result: {
      content: [{ type: "text", text: JSON.stringify(domain.body) }],
      structuredContent: domain.body,
      isError: false,
      ...(domain.pending ? { _meta: { outcome: "pending" } } : {})
    } });
  };
}
