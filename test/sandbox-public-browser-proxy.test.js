import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};

test("public browser proxy uses relative redirects, limits controls and resumes synthetic approval", async (t) => {
  const paths = [];
  const upstream = createServer(async (request, response) => {
    paths.push(request.url);
    if (request.url === "/redirect") {
      response.writeHead(303, { location: "https://crm.example.invalid/catalogs/demo" });
      response.end();
      return;
    }
    if (request.url === "/approval-html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<a href="https://cp.example.invalid/v1/connected-app-approvals/review?intent=' + "a".repeat(64) + '">Review</a>');
      return;
    }
    if (request.url === "/__sandbox-approve") {
      response.writeHead(200);
      response.end("approved");
      return;
    }
    response.writeHead(200);
    response.end("ok");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const reservation = createServer();
  const proxyPort = await listen(reservation);
  await new Promise(resolveClose => reservation.close(resolveClose));
  const proxy = spawn(process.execPath, ["scripts/sandbox-public-browser-proxy.mjs"], {
    cwd: root,
    env: { ...process.env, CRM_SANDBOX_WORKER_ORIGIN: `http://127.0.0.1:${upstreamPort}`,
      CRM_SANDBOX_PROXY_PORT: String(proxyPort) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  proxy.stdout.on("data", chunk => { logs += chunk; });
  proxy.stderr.on("data", chunk => { logs += chunk; });
  t.after(() => proxy.kill("SIGTERM"));
  const site = `http://127.0.0.1:${proxyPort}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (proxy.exitCode !== null) throw new Error(`proxy exited early: ${logs}`);
    try { if ((await fetch(`${site}/ready`)).ok) break; } catch {}
    await delay(20);
    if (attempt === 99) throw new Error(`proxy did not start: ${logs}`);
  }

  const redirect = await fetch(`${site}/redirect`, { redirect: "manual" });
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.get("location"), "/catalogs/demo");

  const page = await (await fetch(`${site}/approval-html`)).text();
  assert.match(page, /href="\/__sandbox-approve"/);
  assert.doesNotMatch(page, /cp\.example\.invalid/);

  const hidden = await fetch(`${site}/__cp-count`);
  assert.equal(hidden.status, 404);
  assert.equal(paths.includes("/__cp-count"), false);

  const confirm = await fetch(`${site}/deal-workflow/confirm`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: "csrf", reviewId: "review-1", revision: "a".repeat(64) }) });
  assert.equal(confirm.status, 200);
  const approval = await fetch(`${site}/__sandbox-approve`);
  assert.equal(approval.status, 200);
  const approvalPage = await approval.text();
  assert.match(approvalPage, /Синтетическое подтверждение/);
  assert.match(approvalPage, /review-1/);
});
