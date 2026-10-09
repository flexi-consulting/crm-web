#!/usr/bin/env node
// Runs Agent Runner's real per-run MCP broker against the public synthetic CRM MCP Worker.
// Only the read-only catalog method is invoked; the app bearer stays in the Runner host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const runnerRoot = process.env.AI_AGENT_RUNNER_ROOT;
if (!runnerRoot) throw new Error("AI_AGENT_RUNNER_ROOT must point to an isolated built Agent Runner checkout");
const origin = process.env.CRM_MCP_SANDBOX_ORIGIN ??
  "https://crm-web-connected-mcp-sandbox-20261008b.skillset-apply.workers.dev";
const parsedOrigin = new URL(origin);
if (parsedOrigin.protocol !== "https:" || parsedOrigin.username || parsedOrigin.password || parsedOrigin.port ||
    parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash ||
    !/^crm-web-connected-mcp-sandbox-[a-z0-9-]+\.skillset-apply\.workers\.dev$/.test(parsedOrigin.hostname))
  throw new Error("CRM_MCP_SANDBOX_ORIGIN must be the stable HTTPS CRM synthetic Workers.dev origin");

const endpoint = new URL("/mcp", parsedOrigin);
const profileId = "profile_A";
const toolName = "crm_exhibitions_catalog_search";
const exhibitionId = "synthetic-current-source-shape";
const appToken = "b".repeat(64); // Public fixture token: CP accepts it only for the synthetic CRM profile.
const root = mkdtempSync(join(tmpdir(), "crm-public-agent-mcp-"));
const facade = new URL("../fixtures/catalog-search-runner-mcp.mjs", import.meta.url).pathname;
const bindingRef = `cred:crm-public-catalog-${randomUUID()}`;
const runnerRuns = [];
let remoteCalls = 0;
let runner;

async function mcpRequest(body) {
  remoteCalls += 1;
  const response = await fetch(endpoint, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${appToken}`, "content-type": "application/json",
      accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify(body) });
  assert.equal(response.status, 200, `CRM MCP returned HTTP ${response.status}`);
  const value = await response.json();
  assert.equal(value.jsonrpc, "2.0");
  assert.equal(value.id, body.id);
  return value;
}

try {
  const initialized = await mcpRequest({ jsonrpc: "2.0", id: "initialize", method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "agent-runner-crm-sandbox", version: "1" } } });
  assert.equal(initialized.result?.protocolVersion, "2025-06-18");
  const listed = await mcpRequest({ jsonrpc: "2.0", id: "tools-list", method: "tools/list", params: {} });
  const remoteTool = listed.result?.tools?.find((tool) => tool.name === toolName);
  assert.equal(remoteTool?._meta?.capabilityId, "crm.exhibitions.catalog.search");
  assert.equal(remoteTool?._meta?.capabilityVersion, "1.1.0");
  assert.deepEqual(remoteTool?._meta?.requiredScopes, ["crm.catalog.read"]);

  const [{ Runner }, { CapabilityRegistry }, { FakeEngine }, { validateRunSpec }] = await Promise.all([
    import(pathToFileURL(join(runnerRoot, "dist/runner/runner.js")).href),
    import(pathToFileURL(join(runnerRoot, "dist/mcp/capabilities.js")).href),
    import(pathToFileURL(join(runnerRoot, "dist/adapters/engine/fake-engine.js")).href),
    import(pathToFileURL(join(runnerRoot, "dist/contracts/run-spec.js")).href)
  ]);
  const registry = new CapabilityRegistry();
  registry.register({ capabilityId: toolName, capabilityVersion: 1,
    requiredScopes: ["crm.catalog.read"], requiredArguments: ["exhibitionId"], effect: "read",
    description: remoteTool.description,
    async invoke(invocation, context) {
      if (invocation.caller.profileId !== profileId || context.bindingValue !== appToken)
        return { kind: "blocked", reason: "synthetic profile/binding mismatch" };
      const response = await mcpRequest({ jsonrpc: "2.0", id: `call-${randomUUID()}`, method: "tools/call",
        params: { name: toolName, arguments: invocation.arguments,
          _meta: { capabilityVersion: remoteTool._meta.capabilityVersion } } });
      if (response.error) return { kind: "blocked", reason: response.error.message };
      const result = response.result?.structuredContent;
      if (!result || response.result?.isError) return { kind: "technical_error", code: "CRM_MCP_INVALID_RESULT" };
      return { kind: "completed", result };
    }
  });
  process.env.CRM_AGENT_RUNNER_ROOT = runnerRoot;
  process.env.MCP_ALLOWED_TOOLS = toolName;
  runner = new Runner({ rootDir: root, adapters: { fake: new FakeEngine("mcp-tools") },
    host: { region: "sandbox-eu", environment: "sandbox" }, cancelGraceMs: 500,
    capabilities: registry, bindingResolver: (ref) => ref === bindingRef ? appToken : null });

  const run = async ({ profile = profileId, scope = "crm.catalog.read", calls = [], denied = [] }) => {
    const id = randomUUID();
    const rawSpec = { contractVersion: 1, jobId: `job-${id}`, runId: `run-${id}`, operationId: `op-${id}`,
      userTaskId: `task-${id}`, profileId: profile, conversationId: `conv-${id}`, ownerGeneration: 1,
      engine: { name: "fake", adapterVersion: "1" }, cwd: join(root, `workspace-${id}`), envAllowlist: [],
      limits: { timeoutMs: 30000 }, credentialBindings: [{ ref: bindingRef, scope }],
      mcp: { servers: [{ serverId: "crm-web-public-catalog", transport: "stdio", command: process.execPath,
        args: [facade], envAllowlist: ["PATH", "CRM_AGENT_RUNNER_ROOT", "MCP_ALLOWED_TOOLS"],
        bindingRef, allowedTools: [toolName] }] },
      input: { inlinePrompt: JSON.stringify({ calls, denied }) } };
    const validated = validateRunSpec(rawSpec);
    assert.equal(validated.ok, true, validated.errors?.join("; "));
    const receipt = runner.start(validated.value);
    const outcome = await runner.waitFor(receipt.runId, 30000);
    assert.equal(outcome.outcome, "succeeded", JSON.stringify(outcome));
    const runDir = join(root, "runs", receipt.runId);
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
    const evidence = events.filter((event) => event.type === "log" &&
      event.payload?.message?.startsWith("mcp-evidence: "))
      .map((event) => JSON.parse(event.payload.message.slice("mcp-evidence: ".length)));
    const persisted = ["events.jsonl", "state.json", "result.json"].map((file) => readFileSync(join(runDir, file), "utf8"));
    assert.equal(persisted.some((value) => value.includes(appToken)), false,
      "synthetic CRM bearer persisted into Agent Run evidence");
    runnerRuns.push({ evidence, persisted });
    return evidence;
  };

  const accepted = await run({ calls: [{ tool: toolName,
    arguments: { exhibitionId, limit: 5 } }] });
  const toolCall = accepted.find((entry) => entry.step === "tool_call");
  assert.equal(toolCall?.ok, true, JSON.stringify(toolCall));
  assert.ok(accepted.find((entry) => entry.step === "tools_list")?.tools.some((tool) => tool.name === toolName));
  const item = toolCall.result.items?.[0];
  assert.equal(toolCall.result.artifactVersion, "1.2.0");
  assert.equal(item?.taxesPaidRub, 1250000);
  assert.equal(item?.employeeCount, 42);
  assert.equal(item?.directorName, "Synthetic Director 001");

  const wrongProfile = await run({ profile: "profile_B", denied: [{ tool: toolName,
    arguments: { exhibitionId, limit: 5 } }] });
  assert.equal(wrongProfile.find((entry) => entry.step === "tool_call_denied_probe")?.ok, true);
  const wrongScope = await run({ scope: "crm.catalog.denied", denied: [{ tool: toolName,
    arguments: { exhibitionId, limit: 5 } }] });
  assert.equal(wrongScope.find((entry) => entry.step === "tool_call_denied_probe")?.ok, true);
  assert.equal(remoteCalls, 3, "only MCP initialize, tools/list and the allowed read reached the CRM Worker");
  assert.equal(runnerRuns.some(({ persisted }) => persisted.some((value) => value.includes(appToken))), false);
  console.log(JSON.stringify({ result: "PASS", environment: "synthetic-sandbox",
    runner: "Agent Runner FakeEngine over its per-run MCP broker",
    crmTransport: `${parsedOrigin.origin}/mcp`, profileId, tool: toolName,
    capabilityVersion: remoteTool._meta.capabilityVersion, artifactVersion: toolCall.result.artifactVersion,
    facts: { taxesPaidRub: item.taxesPaidRub, employeeCount: item.employeeCount, directorName: item.directorName },
    wrongProfile: "refused before CRM call", wrongScope: "refused before CRM call",
    remoteMcpRequests: remoteCalls, bearerPersisted: false }));
} finally {
  await runner?.dispose();
  rmSync(root, { recursive: true, force: true });
}
