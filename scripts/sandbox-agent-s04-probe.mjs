#!/usr/bin/env node
// Exercises the CRM S-04 domain methods through Agent Runner MCP and the actual
// connected-app Worker/BFF/D1 handlers with synthetic CP and Weeek ports.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer as createPortServer } from "node:net";

const root = resolve(new URL("..", import.meta.url).pathname);
const runnerRoot = resolve(process.env.AI_AGENT_RUNNER_ROOT ?? "");
if (!process.env.AI_AGENT_RUNNER_ROOT) throw new Error("AI_AGENT_RUNNER_ROOT must point to an isolated Agent Runner checkout");
const nodeBin = process.execPath;
const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
const config = "test/wrangler.connected-browser-local.toml";
const profileId = "profile_A";
const toolNames = ["crm_deal_prepare_from_participant", "crm_deal_create_from_participant",
  "crm_deal_get_operation", "crm_deal_reconcile_operation"];
const bindingRef = `cred:crm-deal-create-${process.pid}`;
const bindingSecret = `synthetic-session-binding-${process.pid}`;
const workDir = mkdtempSync(join(tmpdir(), "crm-agent-s04-sandbox-"));
const publicOrigin = "https://crm.example.invalid";
const issue = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`command_failed:${args[0]}:${result.stderr || result.stdout}`);
  return result.stdout;
};
const port = async () => {
  const server = createPortServer();
  await new Promise((resolveListen, reject) => server.listen(0, "127.0.0.1",
    error => error ? reject(error) : resolveListen()));
  const value = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return value;
};
const request = (base, path, options = {}) => fetch(`${base}${path}`, { redirect: "manual", ...options });
const cookie = (response, name) => response.headers.getSetCookie().map(part => part.split(";")[0])
  .find(part => part.startsWith(`${name}=`));
let worker, runner;

try {
  const migrations = ["0001_s04_domain.sql", "0002_built_catalog.sql", "0003_weeek_deal_identity.sql",
    "0004_legacy_catalog_refs.sql", "0005_connected_browser_sessions.sql", "0006_connected_browser_mode.sql",
    "0007_connected_browser_s04_commands.sql", "0008_cp_approval_intents.sql",
    "0009_encrypt_connected_browser_secrets.sql", "0010_catalog_v11_artifacts.sql", "0011_catalog_v12_artifacts.sql"];
  for (const migration of migrations) issue(nodeBin, [wrangler, "d1", "execute", "CRM_DB", "--config", config,
    "--local", "--persist-to", workDir, "--file", `migrations/${migration}`, "--yes", "--json"]);
  issue(nodeBin, [wrangler, "d1", "execute", "WEEEK_FIXTURE_DB", "--config", config, "--local",
    "--persist-to", workDir, "--file", "test/fixtures/weeek-http-provider.sql", "--yes", "--json"]);

  const workerPort = await port(), inspectorPort = await port();
  worker = spawn(nodeBin, [wrangler, "dev", "--config", config, "--ip", "127.0.0.1", "--port",
    String(workerPort), "--inspector-port", String(inspectorPort), "--persist-to", workDir, "--log-level", "error"],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let workerLogs = "";
  worker.stdout.on("data", part => { workerLogs += part; });
  worker.stderr.on("data", part => { workerLogs += part; });
  const site = `http://127.0.0.1:${workerPort}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (worker.exitCode !== null) throw new Error(`worker_stopped:${workerLogs}`);
    try { if ((await fetch(`${site}/health`)).ok) break; } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 150));
    if (attempt === 99) throw new Error(`worker_start_timeout:${workerLogs}`);
  }

  const seed = await (await request(site, "/__seed")).json();
  await request(site, "/__cp-control?mode=deal_create");
  const dealPath = `/catalogs/${seed.buildId}/participants/${seed.companyId}/deal`;
  const landing = await request(site, dealPath);
  assert.equal(landing.status, 303);
  const startLocation = new URL(landing.headers.get("location"));
  const start = await request(site, `${startLocation.pathname}${startLocation.search}`);
  assert.equal(start.status, 303);
  const authorize = new URL(start.headers.get("location"));
  const pending = cookie(start, "__Host-crm-connected-pending");
  assert.ok(pending);
  const callback = await request(site, `/auth/connected/callback?code=${"c".repeat(64)}` +
    `&state=${authorize.searchParams.get("state")}&iss=${encodeURIComponent("https://cp.example.invalid")}`,
  { headers: { cookie: pending } });
  assert.equal(callback.status, 303);
  const session = cookie(callback, "__Host-crm-connected-session");
  assert.ok(session);
  const pageResponse = await request(site, dealPath, { headers: { cookie: session } });
  assert.equal(pageResponse.status, 200, `${await pageResponse.clone().text()}\n${workerLogs}`);
  const page = await pageResponse.text();
  assert.match(page, /Подготовить сделку/);
  assert.match(page, new RegExp(seed.companyName));
  const csrf = page.match(/name="_csrf" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(csrf, "connected CRM deal page should provide its server-issued CSRF value");

  const [{ Runner }, { CapabilityRegistry }, { FakeEngine }, { validateRunSpec }] = await Promise.all([
    import(pathToFileURL(join(runnerRoot, "dist/runner/runner.js")).href),
    import(pathToFileURL(join(runnerRoot, "dist/mcp/capabilities.js")).href),
    import(pathToFileURL(join(runnerRoot, "dist/adapters/engine/fake-engine.js")).href),
    import(pathToFileURL(join(runnerRoot, "dist/contracts/run-spec.js")).href)
  ]);
  const registry = new CapabilityRegistry();
  const routeFor = (tool, args) => {
    if (tool === toolNames[0]) return ["POST", "/api/v1/deal-reviews", args];
    if (tool === toolNames[1]) return ["POST", `/api/v1/deal-reviews/${args.reviewId}/confirm`, { revision: args.revision }];
    if (tool === toolNames[2]) return ["GET", `/api/v1/deal-operations/${args.operationId}`, undefined];
    return ["POST", `/api/v1/deal-operations/${args.operationId}/reconcile`, {}];
  };
  for (const tool of toolNames) registry.register({ capabilityId: tool, capabilityVersion: 1,
    requiredScopes: ["crm.deals.create"], requiredArguments: tool === toolNames[0]
      ? ["buildId", "companyId", "exhibitionId", "title", "companyInn", "contactName", "dealComment"]
      : tool === toolNames[1] ? ["reviewId", "revision"] : ["operationId"],
    effect: tool === toolNames[0] || tool === toolNames[1] ? "write" : "read",
    description: "CRM S-04 reviewed deal operation over the connected Worker HTTP handler",
    async invoke(invocation, context) {
      if (invocation.caller.profileId !== profileId || context.bindingValue !== session)
        return { kind: "blocked", reason: "synthetic profile/session binding mismatch" };
      const [method, path, body] = routeFor(tool, invocation.arguments);
      const headers = { cookie: context.bindingValue, origin: publicOrigin, "x-csrf-token": csrf,
        ...(body === undefined ? {} : { "content-type": "application/json" }) };
      const response = await request(site, path, { method, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      let result;
      try { result = await response.json(); } catch { return { kind: "technical_error", code: "CRM_INVALID_RESPONSE" }; }
      if (tool === toolNames[1] && response.status === 202)
        return { kind: "blocked", reason: "PROVIDER_OUTCOME_UNKNOWN" };
      if (!response.ok) return { kind: "blocked", reason: String(result.error ?? `CRM_HTTP_${response.status}`) };
      if (tool === toolNames[1] && result.status === "unknown")
        return { kind: "blocked", reason: "PROVIDER_OUTCOME_UNKNOWN" };
      const outcome = { kind: "completed", result };
      if (tool === toolNames[0] || tool === toolNames[1]) outcome.effectReceipt = {
        receiptId: tool === toolNames[0] ? result.reviewId : result.dealId,
        capabilityId: tool, capabilityVersion: 1, operationId: invocation.caller.operationId,
        bindingRef: invocation.binding.ref, at: new Date().toISOString(),
        ...(tool === toolNames[1] ? { externalRef: result.dealId } : {}) };
      return outcome;
    } });

  const facade = join(root, "fixtures/s04-runner-mcp.mjs");
  const envAllowlist = ["PATH", "CRM_AGENT_RUNNER_ROOT", "MCP_ALLOWED_TOOLS"];
  process.env.CRM_AGENT_RUNNER_ROOT = runnerRoot;
  process.env.MCP_ALLOWED_TOOLS = toolNames.join(",");
  runner = new Runner({ rootDir: workDir, adapters: { fake: new FakeEngine("mcp-tools") },
    host: { region: "sandbox-eu", environment: "sandbox" }, cancelGraceMs: 500,
    capabilities: registry, bindingResolver: ref => ref === bindingRef ? session : null });
  const agentRuns = [];
  const invokeAgent = async ({ profile = profileId, calls = [], denied = [] }) => {
    const cwd = join(workDir, `agent-workspace-${agentRuns.length + 1}`);
    const rawSpec = { contractVersion: 1, jobId: `job-${process.pid}-${agentRuns.length}`,
      runId: `run-${process.pid}-${agentRuns.length}`, operationId: `op-${process.pid}-${agentRuns.length}`,
      userTaskId: `task-${process.pid}`, profileId: profile, conversationId: `conv-${process.pid}`,
      ownerGeneration: 1, engine: { name: "fake", adapterVersion: "1" }, cwd,
      envAllowlist: [], limits: { timeoutMs: 60_000 }, credentialBindings: [
        { ref: bindingRef, scope: "crm.deals.create" }],
      mcp: { servers: [{ serverId: "crm-web-s04-sandbox", transport: "stdio", command: nodeBin,
        args: [facade], envAllowlist, bindingRef, allowedTools: toolNames }] },
      input: { inlinePrompt: JSON.stringify({ calls, denied }) } };
    const validated = validateRunSpec(rawSpec);
    assert.equal(validated.ok, true, validated.errors?.join("; "));
    const receipt = runner.start(validated.value);
    const outcome = await runner.waitFor(receipt.runId, 30_000);
    const events = readFileSync(join(workDir, "runs", receipt.runId, "events.jsonl"), "utf8");
    assert.equal(outcome.outcome, "succeeded", `${JSON.stringify(outcome)}\n${events}`);
    const evidenceText = readFileSync(join(cwd, "mcp-evidence.jsonl"), "utf8");
    const evidence = evidenceText.trim().split("\n").map(JSON.parse);
    const listed = evidence.find(item => item.step === "tools_list");
    const callResults = evidence.filter(item => item.step === "tool_call");
    const deniedResults = evidence.filter(item => item.step === "tool_call_denied_probe");
    assert.ok(toolNames.every(name => listed?.tools.some(tool => tool.name === name)));
    assert.ok(callResults.every(item => item.ok), JSON.stringify(callResults));
    assert.ok(deniedResults.every(item => item.ok), JSON.stringify(deniedResults));
    agentRuns.push({ receipt, cwd, evidenceText });
    return { calls: callResults.map(item => item.result), denied: deniedResults };
  };

  const draft = { buildId: seed.buildId, companyId: seed.companyId, exhibitionId: seed.exhibitionId,
    title: `Встреча с ${seed.companyName}`, companyInn: "0000000001", contactName: "Synthetic Contact",
    dealComment: "Discuss the catalog participation." };
  const preparedRun = await invokeAgent({ calls: [{ tool: toolNames[0], arguments: draft }] });
  const review = preparedRun.calls[0];
  assert.equal(review.status, "prepared");
  assert.equal(review.details.companyId, seed.companyId);
  assert.equal(review.details.title, draft.title);
  assert.equal(review.details.dealComment, draft.dealComment);
  const reviewFromWorker = await (await request(site, `/api/v1/deal-reviews/${review.reviewId}`,
    { headers: { cookie: session } })).json();
  assert.deepEqual(reviewFromWorker.details, review.details);

  const crossProfile = await invokeAgent({ profile: "profile_B", denied: [
    { tool: toolNames[0], arguments: draft }
  ] });
  assert.equal(crossProfile.denied[0].expect, "refused");
  const beforeApproval = await (await request(site, "/__cp-count")).json();
  assert.equal(beforeApproval.weeekCreatePosts, 0);
  const noApproval = await invokeAgent({ denied: [{ tool: toolNames[1], arguments: {
    reviewId: review.reviewId, revision: review.revision
  } }] });
  assert.equal(noApproval.denied[0].expect, "refused");
  const pendingApprovalPage = await request(site, "/deal-workflow/confirm", { method: "POST",
    headers: { cookie: session, origin: publicOrigin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, reviewId: review.reviewId, revision: review.revision }) });
  assert.equal(pendingApprovalPage.status, 409);
  assert.match(await pendingApprovalPage.text(), /Проверить и подтвердить действие в Control Plane/);
  assert.equal((await (await request(site, "/__cp-count")).json()).weeekCreatePosts, 0);

  const operationId = review.operationId;
  await request(site, "/__cp-control?mode=receipt_approved");
  const uncertainRun = await invokeAgent({ denied: [{ tool: toolNames[1], arguments: {
    reviewId: review.reviewId, revision: review.revision
  } }] });
  assert.equal(uncertainRun.denied[0].ok, true);
  const unknownOperation = await (await request(site, `/api/v1/deal-operations/${operationId}`,
    { headers: { cookie: session } })).json();
  assert.equal(unknownOperation.status, "unknown");
  const afterCreate = await (await request(site, "/__cp-count")).json();
  assert.equal(afterCreate.weeekCreatePosts, 1);
  const reconciled = await invokeAgent({ calls: [{ tool: toolNames[3], arguments: { operationId } }] });
  assert.equal(reconciled.calls[0].status, "created");
  assert.equal(reconciled.calls[0].dealId, "weeek_deal_opaque_001");
  const operation = await invokeAgent({ calls: [{ tool: toolNames[2], arguments: { operationId } }] });
  assert.equal(operation.calls[0].status, "created");
  assert.equal(operation.calls[0].linkStatus, "linked");
  assert.equal((await (await request(site, "/__cp-count")).json()).weeekCreatePosts, 1,
    "reconciliation and replay must not send a second Weeek create request");

  const persisted = agentRuns.flatMap(({ receipt, cwd, evidenceText }) => [
    ...["events.jsonl", "state.json", "result.json"].map(name =>
      readFileSync(join(workDir, "runs", receipt.runId, name), "utf8")),
    evidenceText, readFileSync(join(cwd, ".runner/mcp.json"), "utf8")
  ]);
  assert.equal(persisted.some(value => value.includes(session)), false,
    "connected-session cookie must not be persisted in Agent Run evidence/config");
  process.stdout.write(`${JSON.stringify({ outcome: "pass", runner: "FakeEngine over Agent Runner MCP bridge",
    siteTransport: "local connected CRM Worker/BFF/D1", profileId, tools: toolNames,
    dealReview: "prepared and read back through real app handlers", crossProfileCall: "refused",
    unapprovedCall: "refused before Weeek", uncertainProviderOutcome: "reconciled",
    finalDeal: operation.calls[0].dealId, weeekCreatePosts: afterCreate.weeekCreatePosts,
    ui: "connected deal page and Control Plane approval step rendered", sessionBindingPersisted: false })}\n`);
} finally {
  runner?.dispose();
  if (worker && worker.exitCode === null) {
    worker.kill("SIGTERM");
    await Promise.race([new Promise(resolveClose => worker.once("close", resolveClose)),
      new Promise(resolveTimeout => setTimeout(() => { worker.kill("SIGKILL"); resolveTimeout(); }, 3000))]);
  }
  rmSync(workDir, { recursive: true, force: true });
}
