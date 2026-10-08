#!/usr/bin/env node
// Test-only same-origin bridge for a Cloudflare Quick Tunnel. It rewrites the
// local Worker's fixed origin and provides an explicit synthetic CP approval page.
import { createServer } from "node:http";

const upstream = process.env.CRM_SANDBOX_WORKER_ORIGIN ?? "http://127.0.0.1:33008";
const publicOrigin = process.env.CRM_SANDBOX_PUBLIC_ORIGIN;
const port = Number(process.env.CRM_SANDBOX_PROXY_PORT ?? 33006);
const upstreamUrl = new URL(upstream);
if (upstreamUrl.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(upstreamUrl.hostname) ||
    upstreamUrl.pathname !== "/" || upstreamUrl.search || upstreamUrl.hash || upstreamUrl.username || upstreamUrl.password)
  throw new Error("CRM_SANDBOX_WORKER_ORIGIN must point to a local Worker origin");
if (!/^https:\/\//.test(publicOrigin ?? "") || new URL(publicOrigin).origin !== publicOrigin)
  throw new Error("CRM_SANDBOX_PUBLIC_ORIGIN must be the HTTPS Quick Tunnel origin");
let pendingApproval = null;
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
})[char]);

const server = createServer(async (request, response) => {
  try {
    const bodyChunks = [];
    for await (const chunk of request) bodyChunks.push(chunk);
    const body = Buffer.concat(bodyChunks);
    const path = request.url ?? "/";
    if (!path.startsWith("/") || path.startsWith("//")) {
      response.writeHead(400, { "cache-control": "no-store" });
      response.end("invalid path");
      return;
    }
    if (path.startsWith("/__") && !["/__sandbox-login", "/__sandbox-approve"].includes(path.split("?", 1)[0])) {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end("not found");
      return;
    }
    if (path.split("?", 1)[0] === "/__sandbox-approve") {
      const approved = await fetch(`${upstream}/__sandbox-approve`);
      if (!approved.ok || !pendingApproval) {
        response.writeHead(409, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
        response.end("No pending synthetic approval. Return to the CRM review first.");
        return;
      }
      const { csrf, reviewId, revision } = pendingApproval;
      const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Тестовое подтверждение Control Plane</title><h1>Синтетическое подтверждение</h1><p>Только локальный sandbox: синтетический Control Plane одобрил показанную CRM операцию. Нажмите, чтобы продолжить тот же черновик.</p><form method="post" action="/deal-workflow/confirm"><input type="hidden" name="_csrf" value="${escape(csrf)}"><input type="hidden" name="reviewId" value="${escape(reviewId)}"><input type="hidden" name="revision" value="${escape(revision)}"><button>Продолжить с одобренным черновиком</button></form></html>`;
      response.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff", "x-robots-tag": "noindex" });
      response.end(html);
      return;
    }
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("accept-encoding");
    if (request.method === "POST") headers.set("origin", "https://crm.example.invalid");
    if (path.split("?", 1)[0] === "/deal-workflow/confirm" && request.method === "POST") {
      const form = new URLSearchParams(body.toString("utf8"));
      if (form.get("_csrf") && form.get("reviewId") && form.get("revision"))
        pendingApproval = { csrf: form.get("_csrf"), reviewId: form.get("reviewId"), revision: form.get("revision") };
    }
    const result = await fetch(`${upstream}${path}`, { method: request.method, headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : body, redirect: "manual" });
    const outgoingHeaders = new Headers(result.headers);
    outgoingHeaders.delete("content-encoding");
    outgoingHeaders.delete("content-length");
    const location = outgoingHeaders.get("location");
    if (location?.startsWith("https://crm.example.invalid"))
      outgoingHeaders.set("location", location.replace("https://crm.example.invalid", publicOrigin));
    let responseBody = Buffer.from(await result.arrayBuffer());
    if (result.headers.get("content-type")?.includes("text/html")) {
      const html = responseBody.toString("utf8").replace(
        /https:\/\/cp\.example\.invalid\/v1\/connected-app-approvals\/review\?intent=[a-f0-9]{64}/g,
        `${publicOrigin}/__sandbox-approve`);
      responseBody = Buffer.from(html);
    }
    response.writeHead(result.status, Object.fromEntries(outgoingHeaders));
    response.end(responseBody);
  } catch {
    response.writeHead(502, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
    response.end("sandbox proxy error");
  }
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`CRM sandbox proxy listening on 127.0.0.1:${port}\n`));
