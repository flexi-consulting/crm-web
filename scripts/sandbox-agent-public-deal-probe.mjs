#!/usr/bin/env node
// Agent Runner MCP -> stable public CRM sandbox -> connected BFF and deal-review handlers.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);
const runnerRoot = resolve(process.env.AI_AGENT_RUNNER_ROOT ?? "");
const publicOrigin = (process.env.CRM_SANDBOX_PUBLIC_ORIGIN ?? "").replace(/\/$/, "");
if (!process.env.AI_AGENT_RUNNER_ROOT) throw new Error("AI_AGENT_RUNNER_ROOT must point to an isolated Agent Runner checkout");
if (!publicOrigin) throw new Error("CRM_SANDBOX_PUBLIC_ORIGIN must point to the stable synthetic sandbox ingress");
const origin = new URL(publicOrigin);
assert.equal(origin.protocol, "https:");
assert.match(origin.hostname, /^[a-z0-9-]+\.skillset-apply\.workers\.dev$/);

const profileId = "profile_A";
const toolName = "crm_deal_prepare_from_participant";
const serverId = "crm-web-s04-sandbox";
const bindingRef = `cred:crm-public-deal-${randomBytes(6).toString("hex")}`;
const workDir = mkdtempSync(join(tmpdir(), "crm-agent-public-deal-"));
const cookieFor = response => response.headers.getSetCookie().map(value => value.split(";", 1)[0])
  .find(value => value.startsWith("__Host-crm-connected-session="));
const request = (path, options = {}) => fetch(`${publicOrigin}${path}`, { redirect: "manual", ...options });
const evidenceFor = runRoot => readFileSync(join(runRoot, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
  .filter(event => event.type === "log" && event.payload?.stream === "stdout" &&
    event.payload.message.startsWith("mcp-evidence: "))
  .map(event => JSON.parse(event.payload.message.slice("mcp-evidence: ".length)));
let runner;

try {
  const login = await request("/__sandbox-login?view=deal");
  assert.equal(login.status, 303);
  const session = cookieFor(login);
  assert.ok(session, "synthetic deal entry should issue a profile-bound session");
  const dealUrl = new URL(login.headers.get("location"), publicOrigin);
  const match = dealUrl.pathname.match(/^\/catalogs\/(build-[a-f0-9]{24})\/participants\/(co-[a-f0-9]{20})\/deal$/);
  assert.ok(match, `unexpected sandbox deal entry path: ${dealUrl.pathname}`);
  const [, buildId, companyId] = match;
  const dealPage = await request(dealUrl.pathname, { headers: { cookie: session } });
  assert.equal(dealPage.status, 200);
  const html = await dealPage.text();
  assert.match(html, /Подготовить сделку/);
  const csrf = html.match(/name="_csrf" value="([a-f0-9]{64})"/)?.[1];
  const exhibitionId = html.match(/name="exhibitionId" value="([a-z0-9-]+)"/)?.[1];
  const title = html.match(/name="title" maxlength="160" required value="([^"]+)"/)?.[1];
  const companyInn = html.match(/name="companyInn" maxlength="20" required value="([^"]+)"/)?.[1];
  assert.ok(csrf && exhibitionId && title && companyInn, "deal form must render its CSRF and trusted source fields");

  const [{ Runner }, { CapabilityRegistry }, { FakeEngine }, { validateRunSpec }] = await Promise.all([
    import(pathToFileURL(join(runnerRoot, "dist/runner/runner.js")).href),
    import(pathToFileURL(join(runnerRoot, "dist/mcp/capabilities.js")).href),
    import(pathToFileURL(join(runnerRoot, "dist/adapters/engine/fake-engine.js")).href),
    import(pathToFileURL(join(runnerRoot, "dist/contracts/run-spec.js")).href)
  ]);
  const registry = new CapabilityRegistry();
  registry.register({ capabilityId: toolName, capabilityVersion: 1,
    requiredScopes: ["crm.deals.create"], requiredArguments: ["buildId", "companyId", "exhibitionId", "title", "companyInn", "contactName", "dealComment"],
    effect: "write", description: "Prepare a synthetic deal review through the connected CRM app",
    async invoke(invocation, context) {
      if (invocation.caller.profileId !== profileId || context.bindingValue !== session)
        return { kind: "blocked", reason: "synthetic profile/session binding mismatch" };
      const response = await request("/api/v1/deal-reviews", { method: "POST",
        headers: { cookie: context.bindingValue, origin: "https://crm.example.invalid",
          "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify(invocation.arguments) });
      let result;
      try { result = await response.json(); } catch { return { kind: "technical_error", code: "CRM_INVALID_RESPONSE" }; }
      if (!response.ok) return { kind: "blocked", reason: String(result.error ?? `CRM_HTTP_${response.status}`) };
      return { kind: "completed", result, effectReceipt: { receiptId: result.reviewId,
        capabilityId: toolName, capabilityVersion: 1, operationId: invocation.caller.operationId,
        bindingRef: invocation.binding.ref, at: new Date().toISOString() } };
    } });

  const facade = join(root, "fixtures/s04-runner-mcp.mjs");
  const allowedEnv = ["PATH", "CRM_AGENT_RUNNER_ROOT", "MCP_ALLOWED_TOOLS"];
  process.env.CRM_AGENT_RUNNER_ROOT = runnerRoot;
  process.env.MCP_ALLOWED_TOOLS = toolName;
  runner = new Runner({ rootDir: workDir, adapters: { fake: new FakeEngine("mcp-tools") },
    host: { region: "sandbox-eu", environment: "sandbox" }, cancelGraceMs: 500,
    capabilities: registry, bindingResolver: ref => ref === bindingRef ? session : null });
  const cwd = join(workDir, "agent-workspace");
  const rawSpec = { contractVersion: 1, jobId: `job-${randomBytes(4).toString("hex")}`,
    runId: `run-${randomBytes(6).toString("hex")}`, operationId: `op-${randomBytes(6).toString("hex")}`,
    userTaskId: `task-${randomBytes(6).toString("hex")}`, profileId,
    conversationId: `conv-${randomBytes(6).toString("hex")}`, ownerGeneration: 1,
    engine: { name: "fake", adapterVersion: "1" }, cwd, envAllowlist: [], limits: { timeoutMs: 60_000 },
    credentialBindings: [{ ref: bindingRef, scope: "crm.deals.create" }],
    mcp: { servers: [{ serverId, transport: "stdio", command: process.execPath,
      args: [facade], envAllowlist: allowedEnv, bindingRef, allowedTools: [toolName] }] },
    input: { inlinePrompt: JSON.stringify({ calls: [{ tool: toolName, arguments: {
      buildId, companyId, exhibitionId, title, companyInn,
      contactName: "Synthetic Contact", dealComment: "Discuss catalog participation." } }], denied: [] }) } };
  const validated = validateRunSpec(rawSpec);
  assert.equal(validated.ok, true, validated.errors?.join("; "));
  const receipt = runner.start(validated.value);
  const outcome = await runner.waitFor(receipt.runId, 30_000);
  const runRoot = join(workDir, "runs", receipt.runId);
  const events = readFileSync(join(runRoot, "events.jsonl"), "utf8");
  assert.equal(outcome.outcome, "succeeded", `${JSON.stringify(outcome)}\n${events}`);
  assert.equal(existsSync(cwd), false);
  const evidence = evidenceFor(runRoot);
  const listed = evidence.find(item => item.step === "tools_list");
  const call = evidence.find(item => item.step === "tool_call");
  assert.ok(listed?.tools.some(tool => tool.name === toolName));
  assert.equal(call?.ok, true, JSON.stringify(call));
  assert.equal(call.result.status, "prepared");
  assert.equal(call.result.details.companyId, companyId);
  assert.equal(call.result.details.title, title);
  assert.equal(call.result.details.dealComment, "Discuss catalog participation.");
  const review = await request(`/api/v1/deal-reviews/${encodeURIComponent(call.result.reviewId)}`,
    { headers: { cookie: session } });
  assert.equal(review.status, 200);
  const reviewData = await review.json();
  assert.deepEqual(reviewData.details, call.result.details);
  assert.equal(reviewData.status, "prepared");
  const persisted = ["events.jsonl", "state.json", "result.json"].map(name =>
    readFileSync(join(runRoot, name), "utf8"));
  assert.equal(persisted.some(value => value.includes(session)), false,
    "connected-session cookie must not be persisted in Agent Runner artifacts");
  process.stdout.write(`${JSON.stringify({ outcome: "pass", runner: "FakeEngine over Agent Runner MCP bridge",
    siteTransport: "stable Workers.dev -> Quick Tunnel -> synthetic CRM connected app handlers",
    profileId, tool: toolName, reviewStatus: reviewData.status,
    publicDealPage: "rendered", reviewReadBack: "matched MCP result",
    externalDealCreated: false, sessionBindingPersisted: false })}\n`);
} finally {
  runner?.dispose();
  rmSync(workDir, { recursive: true, force: true });
}
