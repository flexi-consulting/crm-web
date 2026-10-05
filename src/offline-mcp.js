import { s01ParticipantCapability, readExhibitionParticipants } from "./s01-participants.js";

// Test-only in-process JSON-RPC transport. This is intentionally not a production MCP server.
export function createOfflineS01McpServer({ dealIntents, resolveTrustedProfile }) {
  const descriptor = s01ParticipantCapability;
  return {
    async receive(raw) {
      let message;
      try { message = typeof raw === "string" ? JSON.parse(raw) : raw; }
      catch { return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
      const reply = (value) => JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, ...value });
      if (!message || message.jsonrpc !== "2.0" || !Object.hasOwn(message, "id")) return reply({ error: { code: -32600, message: "Invalid Request" } });
      if (message.method === "initialize") {
        if (message.params?.protocolVersion !== descriptor.mcpTool.protocolVersion) return reply({ error: { code: -32002, message: "CAPABILITY_VERSION_MISMATCH" } });
        return reply({ result: { protocolVersion: descriptor.mcpTool.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "crm-web-offline-contract", version: descriptor.version } } });
      }
      if (message.method === "tools/list") return reply({ result: { tools: [{ name: descriptor.mcpTool.name, description: "S-01 synthetic exhibition participants for the trusted profile.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, _meta: { capabilityId: descriptor.capabilityId, capabilityVersion: descriptor.version } }] } });
      if (message.method !== "tools/call") return reply({ error: { code: -32601, message: "Method not found" } });
      if (message.params?.name !== descriptor.mcpTool.name) return reply({ error: { code: -32602, message: "UNKNOWN_TOOL" } });
      if (message.params?._meta?.capabilityVersion !== descriptor.version) return reply({ error: { code: -32002, message: "CAPABILITY_VERSION_MISMATCH" } });
      const args = message.params?.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) return reply({ error: { code: -32602, message: "INVALID_ARGUMENTS" } });
      let context;
      try { context = await resolveTrustedProfile(); } catch {}
      const domain = readExhibitionParticipants(context ?? {}, dealIntents);
      if (domain.status !== 200) return reply({ error: { code: domain.status === 403 ? -32003 : -32001, message: domain.error.code, data: domain.error } });
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
    async readParticipants() {
      await this.request("initialize", { protocolVersion: s01ParticipantCapability.mcpTool.protocolVersion, capabilities: {}, clientInfo: { name: "crm-web-offline-test", version: "0.1.0" } });
      const list = await this.request("tools/list");
      const tool = list.tools.find((item) => item.name === s01ParticipantCapability.mcpTool.name);
      if (!tool || tool._meta.capabilityVersion !== s01ParticipantCapability.version) throw new Error("MCP_DESCRIPTOR_MISMATCH");
      const result = await this.request("tools/call", { name: tool.name, arguments: {}, _meta: { capabilityVersion: tool._meta.capabilityVersion } });
      return result.structuredContent;
    }
  };
}
