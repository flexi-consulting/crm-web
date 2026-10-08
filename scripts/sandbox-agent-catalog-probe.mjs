#!/usr/bin/env node
// Runs an actual Agent Runner FakeEngine over its per-run stdio MCP broker against
// the connected CRM Worker, using only an invented CP profile and D1 fixture.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer as createPortServer } from "node:net";

const crmRoot = resolve(new URL("..", import.meta.url).pathname);
const runnerRoot = resolve(process.env.AI_AGENT_RUNNER_ROOT ?? "");
if (!process.env.AI_AGENT_RUNNER_ROOT) throw new Error("AI_AGENT_RUNNER_ROOT must point to an isolated Agent Runner checkout");
const nodeBin = process.execPath;
const wrangler = join(crmRoot, "node_modules/wrangler/bin/wrangler.js");
const config = "test/wrangler.connected-browser-local.toml";
const profileId = "profile_A";
const exhibitionId = "synthetic-event-001";
const toolName = "crm_exhibitions_catalog_search";
const bindingRef = `cred:crm-catalog-${randomBytes(6).toString("hex")}`;
const workDir = mkdtempSync(join(tmpdir(), "crm-agent-mcp-sandbox-"));
const port = async () => {
  const server = createPortServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
};
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: crmRoot, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`command_failed:${args[0]}:${result.stderr || result.stdout}`);
  return result.stdout;
};
const cookie = (response, name) => response.headers.getSetCookie().map(part => part.split(";")[0])
  .find(part => part.startsWith(`${name}=`));
const request = (base, path, options = {}) => fetch(`${base}${path}`, { redirect: "manual", ...options });
const readMcpEvidence = (runRoot) => readFileSync(join(runRoot, "events.jsonl"), "utf8")
  .trim().split("\n").map(JSON.parse)
  .filter(event => event.type === "log" && event.payload?.stream === "stdout" &&
    event.payload.message.startsWith("mcp-evidence: "))
  .map(event => JSON.parse(event.payload.message.slice("mcp-evidence: ".length)));
let worker;
let runner;

try {
  let site, eventId, session;
  const publicOrigin = process.env.CRM_SANDBOX_PUBLIC_ORIGIN?.replace(/\/$/, "");
  if (publicOrigin) {
    const origin = new URL(publicOrigin);
    assert.equal(origin.protocol, "https:");
    assert.match(origin.hostname, /^[a-z0-9-]+\.skillset-apply\.workers\.dev$/,
      "public probe must use the approved stable Workers.dev sandbox ingress");
    site = origin.origin;
    const login = await request(site, "/__sandbox-login?view=catalog");
    assert.equal(login.status, 303);
    const catalogLocation = new URL(login.headers.get("location"), site);
    eventId = catalogLocation.pathname.split("/").at(-1);
    session = cookie(login, "__Host-crm-connected-session");
    assert.ok(session, "public synthetic login must return its profile-bound session cookie");
  } else {
    const migrations = ["0001_s04_domain.sql", "0002_built_catalog.sql", "0003_weeek_deal_identity.sql",
      "0004_legacy_catalog_refs.sql", "0005_connected_browser_sessions.sql", "0006_connected_browser_mode.sql",
      "0007_connected_browser_s04_commands.sql", "0008_cp_approval_intents.sql",
      "0009_encrypt_connected_browser_secrets.sql", "0010_catalog_v11_artifacts.sql", "0011_catalog_v12_artifacts.sql"];
    for (const migration of migrations) run(nodeBin, [wrangler, "d1", "execute", "CRM_DB", "--config", config,
      "--local", "--persist-to", workDir, "--file", `migrations/${migration}`, "--yes", "--json"]);
    run(nodeBin, [wrangler, "d1", "execute", "WEEEK_FIXTURE_DB", "--config", config, "--local",
      "--persist-to", workDir, "--file", "test/fixtures/weeek-http-provider.sql", "--yes", "--json"]);

    const workerPort = await port(), inspectorPort = await port();
    worker = spawn(nodeBin, [wrangler, "dev", "--config", config, "--ip", "127.0.0.1", "--port",
      String(workerPort), "--inspector-port", String(inspectorPort), "--persist-to", workDir, "--log-level", "error"],
    { cwd: crmRoot, stdio: ["ignore", "pipe", "pipe"] });
    let workerLogs = "";
    worker.stdout.on("data", chunk => { workerLogs += chunk; });
    worker.stderr.on("data", chunk => { workerLogs += chunk; });
    site = `http://127.0.0.1:${workerPort}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (worker.exitCode !== null) throw new Error(`worker_stopped:${workerLogs}`);
      try { if ((await fetch(`${site}/health`)).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
      if (attempt === 99) throw new Error(`worker_start_timeout:${workerLogs}`);
    }

    const seed = await (await request(site, "/__seed")).json();
    eventId = seed.v11ExhibitionId;
    const deepLink = await request(site, `/catalogs/${eventId}`);
    assert.equal(deepLink.status, 303);
    const startLocation = new URL(deepLink.headers.get("location"));
    const start = await request(site, startLocation.pathname + startLocation.search);
    assert.equal(start.status, 303);
    const cpAuthorize = new URL(start.headers.get("location"));
    const pending = cookie(start, "__Host-crm-connected-pending");
    const callback = await request(site, `/auth/connected/callback?code=${"c".repeat(64)}` +
      `&state=${cpAuthorize.searchParams.get("state")}&iss=${encodeURIComponent("https://cp.example.invalid")}`,
    { headers: { cookie: pending } });
    assert.equal(callback.status, 303);
    session = cookie(callback, "__Host-crm-connected-session");
  }

  const page = await request(site, `/catalogs/${eventId}`, { headers: { cookie: session } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Synthetic Director 001/);
  assert.match(html, /Уплаченные налоги: 1,25 млн ₽ \(2024\)/);
  assert.match(html, /Сотрудники: 42 \(2025\)/);

  const sessionBinding = `${session}`;
  const capability = {
    capabilityId: toolName, capabilityVersion: 1, requiredScopes: ["crm.catalog.read"],
    requiredArguments: ["exhibitionId"], effect: "read",
    description: "CRM catalog search via the connected app's real HTTP handler",
    async invoke(invocation, context) {
      if (invocation.caller.profileId !== profileId || context.bindingValue !== sessionBinding)
        return { kind: "blocked", reason: "synthetic profile/session binding mismatch" };
      const result = await fetch(`${site}/api/v1/catalogs/${encodeURIComponent(String(invocation.arguments.exhibitionId))}/entries`, {
        headers: { cookie: context.bindingValue }
      });
      if (!result.ok) return { kind: "technical_error", code: `CRM_HTTP_${result.status}` };
      return { kind: "completed", result: await result.json() };
    }
  };
  const [{ Runner }, { CapabilityRegistry }, { FakeEngine }, { validateRunSpec }] = await Promise.all([
    import(pathToFileURL(join(runnerRoot, "dist/runner/runner.js")).href),
    import(pathToFileURL(join(runnerRoot, "dist/mcp/capabilities.js")).href),
    import(pathToFileURL(join(runnerRoot, "dist/adapters/engine/fake-engine.js")).href),
    import(pathToFileURL(join(runnerRoot, "dist/contracts/run-spec.js")).href)
  ]);
  const registry = new CapabilityRegistry();
  registry.register(capability);
  const bindings = [{ ref: bindingRef, scope: "crm.catalog.read" }];
  const fixtureServer = join(crmRoot, "fixtures/catalog-search-runner-mcp.mjs");
  const allowedEnv = ["PATH", "CRM_AGENT_RUNNER_ROOT", "MCP_ALLOWED_TOOLS"];
  process.env.MCP_ALLOWED_TOOLS = toolName;
  process.env.CRM_AGENT_RUNNER_ROOT = runnerRoot;
  runner = new Runner({ rootDir: workDir,
    adapters: { fake: new FakeEngine("mcp-tools") },
    host: { region: "sandbox-eu", environment: "sandbox" },
    cancelGraceMs: 500, capabilities: registry,
    bindingResolver: ref => ref === bindingRef ? sessionBinding : null });
  const rawSpec = { contractVersion: 1, jobId: `job-${randomBytes(4).toString("hex")}`,
    runId: `run-${randomBytes(6).toString("hex")}`, operationId: `op-${randomBytes(6).toString("hex")}`,
    userTaskId: `task-${randomBytes(6).toString("hex")}`, profileId,
    conversationId: `conv-${randomBytes(6).toString("hex")}`, ownerGeneration: 1,
    engine: { name: "fake", adapterVersion: "1" }, cwd: join(workDir, "agent-workspace"),
    envAllowlist: [], limits: { timeoutMs: 60_000 }, credentialBindings: bindings,
    mcp: { servers: [{ serverId: "crm-web-catalog", transport: "stdio", command: nodeBin,
      args: [fixtureServer], envAllowlist: allowedEnv, bindingRef, allowedTools: [toolName] }] },
    input: { inlinePrompt: JSON.stringify({ calls: [{ tool: toolName,
      arguments: { exhibitionId: eventId, limit: 5 } }], denied: [] }) } };
  const validated = validateRunSpec(rawSpec);
  assert.equal(validated.ok, true, validated.errors?.join("; "));
  const receipt = runner.start(validated.value);
  const outcome = await runner.waitFor(receipt.runId, 30_000);
  const runRoot = join(workDir, "runs", receipt.runId);
  const eventText = readFileSync(join(runRoot, "events.jsonl"), "utf8");
  assert.equal(outcome.outcome, "succeeded", `${JSON.stringify(outcome)}\n${eventText}`);
  assert.equal(existsSync(validated.value.cwd), false, "Runner should sweep the temporary MCP workspace");
  const lines = readMcpEvidence(runRoot);
  const listed = lines.find(item => item.step === "tools_list");
  const toolCall = lines.find(item => item.step === "tool_call");
  assert.ok(listed?.tools.some(tool => tool.name === toolName && tool.effect === "read"));
  assert.equal(toolCall?.ok, true, JSON.stringify(toolCall));
  assert.equal(toolCall.result.artifactVersion, "1.2.0");
  assert.equal(toolCall.result.items[0].taxesPaidRub, 1250000);
  assert.equal(toolCall.result.items[0].employeeCount, 42);
  assert.equal(toolCall.result.items[0].directorName, "Synthetic Director 001");
  assert.equal(toolCall.result.items.length, 1);
  const surfaces = ["events.jsonl", "state.json", "result.json"].map(name => readFileSync(join(runRoot, name), "utf8"));
  assert.equal(surfaces.some(value => value.includes(sessionBinding)), false,
    "session credential must not appear in Agent Run evidence or MCP config");
  process.stdout.write(`${JSON.stringify({ outcome: "pass", runner: "FakeEngine over Agent Runner MCP bridge",
    siteTransport: publicOrigin ? "stable Workers.dev -> Quick Tunnel -> synthetic CRM Worker" : "local Wrangler Worker HTTP",
    profileId, toolName, artifactVersion: toolCall.result.artifactVersion,
    facts: { taxesPaidRub: toolCall.result.items[0].taxesPaidRub,
      employeeCount: toolCall.result.items[0].employeeCount, directorName: toolCall.result.items[0].directorName },
    rendered: { tax: /Уплаченные налоги: 1,25 млн ₽ \(2024\)/.test(html),
      employees: /Сотрудники: 42 \(2025\)/.test(html), director: /Synthetic Director 001/.test(html) } })}\n`);
} finally {
  runner?.dispose();
  if (worker && worker.exitCode === null) {
    worker.kill("SIGTERM");
    await Promise.race([new Promise(resolve => worker.once("close", resolve)),
      new Promise(resolve => setTimeout(() => { worker.kill("SIGKILL"); resolve(); }, 3000))]);
  }
  rmSync(workDir, { recursive: true, force: true });
}
