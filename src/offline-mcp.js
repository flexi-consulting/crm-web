import { s01ParticipantCapability, readExhibitionParticipants } from "./s01-participants.js";
import { s01CatalogSearchCapability } from "./s01-catalog-search.js";
import { readFileSync } from "node:fs";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schema = (ref) => JSON.parse(readFileSync(new URL(`../${ref}`, import.meta.url), "utf8"));
const ajv = new Ajv();
addFormats(ajv);
const toolSchemas = [s01ParticipantCapability, s01CatalogSearchCapability].map((descriptor) => ({
  descriptor,
  input: schema(descriptor.inputSchemaRef),
  output: schema(descriptor.outputSchemaRef),
  error: schema(descriptor.errorsSchemaRef)
}));
for (const entry of toolSchemas) {
  entry.validInput = ajv.compile(entry.input);
  entry.validOutput = ajv.compile(entry.output);
  entry.validError = ajv.compile(entry.error);
}

// Test-only in-process JSON-RPC transport. This is intentionally not a production MCP server.
export function createOfflineS01McpServer({ dealIntents, resolveTrustedProfile, catalogSearchHandler = null }) {
  const tools = [
    { ...toolSchemas.find((entry) => entry.descriptor === s01ParticipantCapability),
      run: async (args) => {
        let context;
        try { context = await resolveTrustedProfile(); } catch {}
        const domain = readExhibitionParticipants(context ?? {}, dealIntents);
        return { ...domain, rpcError: domain.error };
      } }
  ];
  if (typeof catalogSearchHandler === "function") {
    tools.push({ ...toolSchemas.find((entry) => entry.descriptor === s01CatalogSearchCapability),
      run: async (args) => {
        const { exhibitionId, ...query } = args;
        const url = new URL(`/api/v1/catalogs/${encodeURIComponent(exhibitionId)}/entries`, "http://crm.local");
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
        const response = await catalogSearchHandler(new Request(url, { method: "GET" }));
        const body = await response.json();
        if (response.status !== 200) {
          const code = body.error === "trusted_profile_unavailable" ? "AUTH_CONTEXT_UNAVAILABLE" :
            body.error === "required_scope_missing" ? "SCOPE_DENIED" :
            body.error === "invalid_query" ? "INVALID_ARGUMENTS" :
            body.error === "catalog_not_found" ? "NOT_FOUND" : "DOMAIN_UNAVAILABLE";
          return { status: response.status, rpcError: { code, message: body.error } };
        }
        return { status: response.status, body };
      } });
  }
  return {
    async receive(raw) {
      let message;
      try { message = typeof raw === "string" ? JSON.parse(raw) : raw; }
      catch { return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
      const reply = (value) => JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, ...value });
      if (!message || message.jsonrpc !== "2.0" || !Object.hasOwn(message, "id")) return reply({ error: { code: -32600, message: "Invalid Request" } });
      if (message.method === "initialize") {
        if (message.params?.protocolVersion !== s01ParticipantCapability.mcpTool.protocolVersion) return reply({ error: { code: -32002, message: "CAPABILITY_VERSION_MISMATCH" } });
        return reply({ result: { protocolVersion: s01ParticipantCapability.mcpTool.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "crm-web-offline-contract", version: "1.0.0" } } });
      }
      if (message.method === "tools/list") return reply({ result: { tools: tools.map(({ descriptor, input }) => ({
        name: descriptor.mcpTool.name, description: descriptor.description, inputSchema: input,
        _meta: { capabilityId: descriptor.capabilityId, capabilityVersion: descriptor.version }
      })) } });
      if (message.method !== "tools/call") return reply({ error: { code: -32601, message: "Method not found" } });
      const selected = tools.find(({ descriptor }) => message.params?.name === descriptor.mcpTool.name);
      if (!selected) return reply({ error: { code: -32602, message: "UNKNOWN_TOOL" } });
      const { descriptor } = selected;
      if (message.params?._meta?.capabilityVersion !== descriptor.version) return reply({ error: { code: -32002, message: "CAPABILITY_VERSION_MISMATCH" } });
      const args = message.params?.arguments;
      if (!selected.validInput(args)) return reply({ error: { code: -32602, message: "INVALID_ARGUMENTS" } });
      const domain = await selected.run(args);
      if (domain.status !== 200) {
        const error = domain.rpcError;
        if (!selected.validError(error)) throw new Error("Offline MCP domain error violates capability schema");
        return reply({ error: { code: domain.status === 403 ? -32003 : -32001, message: error.code ?? error.message, data: error } });
      }
      if (!selected.validOutput(domain.body)) throw new Error("Offline MCP domain result violates capability schema");
      return reply({ result: { content: [{ type: "text", text: JSON.stringify(domain.body) }], structuredContent: domain.body, isError: false } });
    }
  };
}

export function createOfflineS01McpClient(server) {
  let nextId = 0;
  return {
    async request(method, params = {}) {
      const request = { jsonrpc: "2.0", id: ++nextId, method, params };
      const response = JSON.parse(await server.receive(JSON.stringify(request)));
      if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code, data: response.error.data });
      return response.result;
    },
    async call(capability, args) {
      const list = await this.request("tools/list");
      const tool = list.tools.find((item) => item._meta.capabilityId === capability.capabilityId);
      if (!tool || tool._meta.capabilityVersion !== capability.version) throw new Error("MCP_DESCRIPTOR_MISMATCH");
      const result = await this.request("tools/call", { name: tool.name, arguments: args, _meta: { capabilityVersion: tool._meta.capabilityVersion } });
      return result.structuredContent;
    },
    async readParticipants() {
      await this.request("initialize", { protocolVersion: s01ParticipantCapability.mcpTool.protocolVersion, capabilities: {}, clientInfo: { name: "crm-web-offline-test", version: "0.1.0" } });
      return this.call(s01ParticipantCapability, {});
    },
    async searchCatalog(args) {
      await this.request("initialize", { protocolVersion: s01CatalogSearchCapability.mcpTool.protocolVersion, capabilities: {}, clientInfo: { name: "crm-web-offline-test", version: "0.1.0" } });
      return this.call(s01CatalogSearchCapability, args);
    }
  };
}
