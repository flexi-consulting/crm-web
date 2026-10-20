// Shared Cloudflare Workers API helpers for the exhibition deal deployment.

const apiBase = "https://api.cloudflare.com/client/v4";

export const readApiToken = () => {
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
  return token;
};

export const apiRequest = async (path, init = {}) => {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${readApiToken()}`,
      ...(init.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${path} failed with ${response.status}: ${text.slice(0, 400)}`);
  }
  try {
    return { body: JSON.parse(text), text };
  } catch {
    return { body: null, text };
  }
};

export const fetchWorkerSettings = async (accountId, name) => {
  const { body } = await apiRequest(`/accounts/${accountId}/workers/scripts/${name}/settings`);
  return body?.result || {};
};

export const fetchWorkerBundle = async (accountId, name) => {
  const { body, text } = await apiRequest(`/accounts/${accountId}/workers/scripts/${name}`);
  const raw = typeof body?.result === "string" ? body.result : text;
  if (typeof raw !== "string" || !raw.includes("--")) {
    throw new Error(`${name}: unexpected script payload`);
  }
  return raw;
};

export const parseMultipart = (text) => {
  const separator = text.indexOf("\r\n");
  const boundary = text.slice(0, separator).trim();
  if (!boundary.startsWith("--")) throw new Error("multipart_boundary_missing");
  const parts = [];
  for (const chunk of text.split(boundary).slice(1)) {
    if (chunk.startsWith("--")) break;
    const headerEnd = chunk.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = chunk.slice(0, headerEnd);
    const name = headers.match(/name="([^"]+)"/)?.[1] || "";
    const content = chunk.slice(headerEnd + 4).replace(/\r\n$/, "");
    parts.push({ name, headers, content });
  }
  return parts;
};

export const patchWorkerSettings = async (accountId, name, bindings) => {
  const form = new FormData();
  form.set("settings", JSON.stringify({ bindings }));
  await apiRequest(`/accounts/${accountId}/workers/scripts/${name}/settings`, {
    method: "PATCH",
    body: form
  });
};

export const setWorkerSecret = async (accountId, name, secretName, secretText) => {
  await apiRequest(`/accounts/${accountId}/workers/scripts/${name}/secrets`, {
    method: "PUT",
    body: JSON.stringify({ name: secretName, text: secretText, type: "secret_text" })
  });
};

export const diffBindings = (before, after) => {
  const beforeMap = new Map((before.bindings || []).map((binding) => [binding.name, JSON.stringify(binding)]));
  const afterMap = new Map((after.bindings || []).map((binding) => [binding.name, JSON.stringify(binding)]));
  return {
    before: beforeMap.size,
    after: afterMap.size,
    missing: [...beforeMap.keys()].filter((key) => !afterMap.has(key)),
    changed: [...beforeMap.keys()].filter((key) => afterMap.has(key) && beforeMap.get(key) !== afterMap.get(key)),
    added: [...afterMap.keys()].filter((key) => !beforeMap.has(key))
  };
};
