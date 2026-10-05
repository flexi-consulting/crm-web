import { readFileSync } from "node:fs";
import Ajv from "ajv/dist/2020.js";

const descriptor = JSON.parse(readFileSync(new URL("../capabilities/s02-built-participants.v1.json", import.meta.url)));
const loadSchema = (ref) => JSON.parse(readFileSync(new URL(`../${ref}`, import.meta.url)));
const ajv = new Ajv();
const validInput = ajv.compile(loadSchema(descriptor.inputSchemaRef));
const validOutput = ajv.compile(loadSchema(descriptor.outputSchemaRef));

// In-process, stateful MCP compliance fixture. Never publish this transport or use request-supplied identity.
export function createOfflineBuiltCatalogMcp({ catalogBuilds, resolveTrustedProfile }) {
  return {
    async receive(raw) {
      let message;
      try { message = typeof raw === "string" ? JSON.parse(raw) : raw; }
      catch { return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
      const reply = (part) => JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, ...part });
      if (!message || message.jsonrpc !== "2.0" || !Object.hasOwn(message, "id")) return reply({ error: { code: -32600, message: "Invalid Request" } });
      if (message.method === "initialize") {
        if (message.params?.protocolVersion !== descriptor.mcpTool.protocolVersion) return reply({ error: { code: -32002, message: "CAPABILITY_VERSION_MISMATCH" } });
        return reply({ result: { protocolVersion: descriptor.mcpTool.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "crm-built-catalog-offline", version: descriptor.version } } });
      }
      if (message.method === "tools/list") return reply({ result: { tools: [{ name: descriptor.mcpTool.name, description: descriptor.description, inputSchema: loadSchema(descriptor.inputSchemaRef), _meta: { capabilityId: descriptor.capabilityId, capabilityVersion: descriptor.version } }] } });
      if (message.method !== "tools/call") return reply({ error: { code: -32601, message: "Method not found" } });
      if (message.params?.name !== descriptor.mcpTool.name) return reply({ error: { code: -32602, message: "UNKNOWN_TOOL" } });
      if (message.params?._meta?.capabilityVersion !== descriptor.version) return reply({ error: { code: -32002, message: "CAPABILITY_VERSION_MISMATCH" } });
      const args = message.params?.arguments;
      if (!validInput(args)) return reply({ error: { code: -32602, message: "INVALID_ARGUMENTS" } });
      let context;
      try { context = await resolveTrustedProfile?.(); } catch {}
      if (!context?.profileId || !Array.isArray(context.scopes)) return reply({ error: { code: -32001, message: "AUTH_CONTEXT_UNAVAILABLE" } });
      if (!descriptor.requiredScopes.every((scope) => context.scopes.includes(scope))) return reply({ error: { code: -32003, message: "SCOPE_DENIED" } });
      const domain = catalogBuilds.readParticipants({ profileId: context.profileId, buildId: args.buildId, query: args.q ?? "", classification: args.classification ?? null });
      if (domain.status !== 200) return reply({ error: { code: -32004, message: domain.body.code ?? "DOMAIN_UNAVAILABLE", data: domain.body } });
      if (!validOutput(domain.body)) throw new Error("Built catalog domain result violates MCP schema");
      return reply({ result: { content: [{ type: "text", text: JSON.stringify(domain.body) }], structuredContent: domain.body, isError: false } });
    }
  };
}
