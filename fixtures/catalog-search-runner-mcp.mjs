#!/usr/bin/env node
// Agent Runner's per-run stdio MCP facade for the CRM catalog sandbox probe.
// Domain execution remains in the Runner host handler and calls CRM's real HTTP API.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const protocolVersion = "2025-06-18";
const descriptor = JSON.parse(readFileSync(new URL("../capabilities/s01-exhibition-catalog-search.v1.1.json", import.meta.url), "utf8"));
const inputSchema = JSON.parse(readFileSync(new URL(`../${descriptor.inputSchemaRef}`, import.meta.url), "utf8"));
const toolName = descriptor.mcpTool.name;
const serverId = process.env.MCP_SERVER_ID ?? "crm-catalog-read";
const allowedTools = new Set((process.env.MCP_ALLOWED_TOOLS ?? "").split(",").filter(Boolean));
const runnerRoot = process.env.CRM_AGENT_RUNNER_ROOT;
if (!runnerRoot) throw new Error("CRM_AGENT_RUNNER_ROOT is required by the sandbox-only MCP facade");
const { BridgeClient } = await import(pathToFileURL(join(runnerRoot,
  "src/mcp/fixtures/bridge-client.mjs")).href);
const bridge = new BridgeClient({ url: process.env.MCP_BRIDGE_URL ?? "",
  runToken: process.env.MCP_BRIDGE_TOKEN ?? "", serverId });
await bridge.open();

const tool = { name: toolName,
  description: descriptor.description, inputSchema,
  _meta: { capabilityId: descriptor.capabilityId, capabilityVersion: descriptor.version } };
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const textResult = outcome => ({ content: [{ type: "text", text: JSON.stringify({ outcome }) }],
  structuredContent: { outcome } });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let end = buffer.indexOf("\n");
  while (end >= 0) {
    const line = buffer.slice(0, end).replace(/\r$/, "");
    buffer = buffer.slice(end + 1);
    if (line.trim()) void handle(line);
    end = buffer.indexOf("\n");
  }
});
process.stdin.on("close", () => { bridge.close(); process.exit(0); });

async function handle(line) {
  let request;
  try { request = JSON.parse(line); } catch {
    send({ id: null, error: { code: -32700, message: "Parse error" } }); return;
  }
  const { id, method, params = {} } = request;
  if (id === undefined || id === null) return;
  if (method === "initialize") {
    send({ id, result: { protocolVersion, capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "crm-catalog-sandbox", version: "1.1.0" } } }); return;
  }
  if (method === "ping") { send({ id, result: {} }); return; }
  if (method === "tools/list") {
    send({ id, result: { tools: allowedTools.has(toolName) ? [tool] : [] } }); return;
  }
  if (method !== "tools/call") { send({ id, error: { code: -32601, message: "Method not found" } }); return; }
  if (params.name !== toolName || !allowedTools.has(toolName)) {
    send({ id, result: textResult({ kind: "technical_error", code: "TOOL_NOT_ALLOWED" }), isError: true }); return;
  }
  const response = await bridge.request("capability/invoke", { serverId, capabilityId: toolName,
    arguments: params.arguments ?? {} });
  if (response.ok === true && response.outcome) {
    send({ id, result: textResult(response.outcome), ...(response.outcome.kind === "completed" ? {} : { isError: true }) });
    return;
  }
  send({ id, error: { code: -32001, message: String(response.code ?? "CAPABILITY_INVOKE_FAILED"),
    data: { details: response.details ?? null } } });
}
