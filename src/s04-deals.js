import { readFileSync } from "node:fs";
import Ajv from "ajv/dist/2020.js";
import { normalizeDealReviewRequest } from "./deal-reviews.js";

export const s04DealCapability = Object.freeze(JSON.parse(readFileSync(new URL("../capabilities/s04-deals.v1.json", import.meta.url), "utf8")));
const readSchema = (ref) => JSON.parse(readFileSync(new URL(`../${ref}`, import.meta.url), "utf8"));
const ajv = new Ajv();
for (const ref of ["schemas/s04-review-input.schema.json", "schemas/s04-review-output.schema.json", "schemas/s04-create-input.schema.json", "schemas/s04-operation-input.schema.json", "schemas/synthetic-deal-operation.schema.json"]) ajv.addSchema(readSchema(ref));
const validators = new Map(s04DealCapability.tools.map((tool) => [tool.name, {
  input: ajv.getSchema(`https://crm-web.example.invalid/${tool.inputSchemaRef}`),
  output: ajv.getSchema(`https://crm-web.example.invalid/${tool.outputSchemaRef}`)
}]));

// Test-only JSON-RPC transport: the same injected domain service is also used by HTTP.
export function createOfflineS04McpServer({ dealService, reviewService, resolveTrustedProfile, resolveTrustedReviewReceipt }) {
  let negotiated = false;
  let initialized = false;
  return {
    async receive(raw) {
      let message;
      try { message = typeof raw === "string" ? JSON.parse(raw) : raw; }
      catch { return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
      const reply = (part) => JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, ...part });
      if (message?.jsonrpc !== "2.0") return reply({ error: { code: -32600, message: "Invalid Request" } });
      if (message.method === "initialize") {
        if (message.params?.protocolVersion !== s04DealCapability.protocolVersion) return reply({ error: { code: -32002, message: "CAPABILITY_VERSION_MISMATCH" } });
        negotiated = true;
        return reply({ result: { protocolVersion: s04DealCapability.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "crm-s04-offline", version: s04DealCapability.version } } });
      }
      if (message.method === "notifications/initialized") {
        if (negotiated) initialized = true;
        return null;
      }
      if (!initialized) return reply({ error: { code: -32000, message: "NOT_INITIALIZED" } });
      if (message.method === "tools/list") return reply({ result: { tools: s04DealCapability.tools.map((tool) => ({ name: tool.name, description: s04DealCapability.description, inputSchema: readSchema(tool.inputSchemaRef), _meta: { capabilityId: s04DealCapability.capabilityId, capabilityVersion: s04DealCapability.version } })) } });
      if (message.method !== "tools/call") return reply({ error: { code: -32601, message: "Method not found" } });
      const tool = s04DealCapability.tools.find((item) => item.name === message.params?.name);
      if (!tool) return reply({ error: { code: -32602, message: "UNKNOWN_TOOL" } });
      if (message.params?._meta?.capabilityVersion !== s04DealCapability.version) return reply({ error: { code: -32002, message: "CAPABILITY_VERSION_MISMATCH" } });
      const args = message.params?.arguments;
      if (!validators.get(tool.name).input(args)) return reply({ error: { code: -32602, message: "INVALID_ARGUMENTS" } });
      let context;
      try { context = await resolveTrustedProfile(); } catch {}
      if (!context?.profileId || !Array.isArray(context.scopes)) return reply({ error: { code: -32001, message: "AUTH_CONTEXT_UNAVAILABLE" } });
      if (!context.scopes.includes(tool.scope)) return reply({ error: { code: -32003, message: "SCOPE_DENIED" } });
      let domain;
      if (tool.operation === "prepare") {
        const request = normalizeDealReviewRequest(args);
        if (!request) return reply({ error: { code: -32602, message: "INVALID_ARGUMENTS" } });
        domain = await reviewService.prepare({ profileId: context.profileId, request });
      } else if (tool.operation === "confirm") {
        let trustedReceipt;
        try { trustedReceipt = await resolveTrustedReviewReceipt?.({ profileId: context.profileId, reviewId: args.reviewId, revision: args.revision }); } catch {}
        domain = await reviewService.confirm({ profileId: context.profileId, reviewId: args.reviewId, revision: args.revision, trustedReceipt });
      } else {
        domain = await dealService[tool.operation]({ profileId: context.profileId, operationId: args.operationId });
      }
      if (domain.status >= 400) return reply({ error: { code: -32004, message: domain.body.error, data: domain.body } });
      if (!validators.get(tool.name).output(domain.body)) throw new Error("S04 domain result violates descriptor schema");
      return reply({ result: { content: [{ type: "text", text: JSON.stringify(domain.body) }], structuredContent: domain.body, isError: false } });
    }
  };
}
