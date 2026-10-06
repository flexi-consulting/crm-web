import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, lstat, chmod, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { projectLegacyExSnapshot } from "./legacy-ex-snapshot.js";

const SOURCE_NAMES = new Set(["enriched.json", "targets.json", "requisites_enrichment.json",
  "exhibitors.json", "ex-array.json"]);
const idOk = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isInside = (root, path) => path === root || path.startsWith(`${root}${sep}`);
async function dirs(path) {
  try { return (await readdir(path, { withFileTypes: true })).filter((item) => item.isDirectory())
    .map((item) => join(path, item.name)); } catch { return []; }
}
async function files(path) {
  try { return (await readdir(path, { withFileTypes: true })).filter((item) => item.isFile())
    .map((item) => join(path, item.name)); } catch { return []; }
}
async function discover(sourceRoot) {
  const found = [];
  for (const profile of await dirs(sourceRoot)) {
    for (const project of await dirs(join(profile, "projects"))) {
      for (const file of await files(join(project, "data")))
        if (SOURCE_NAMES.has(basename(file))) found.push({ path: file, kind: "source_json" });
      for (const deploy of await dirs(join(project, "deploy")))
        for (const file of await files(deploy))
          if (basename(file) === "index.html") found.push({ path: file, kind: "deployed_html" });
    }
    for (const expo of await dirs(join(profile, "expo-pipeline"))) {
      for (const file of await files(expo)) {
        if (SOURCE_NAMES.has(basename(file))) found.push({ path: file, kind: "source_json" });
        if (basename(file) === "index.html") found.push({ path: file, kind: "deployed_html" });
      }
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export function parseLegacyExHtml(bytes) {
  const html = bytes.toString("utf8");
  const eventMatch = html.match(/\bconst EVENT_KEY\s*=\s*['"]([a-z0-9][a-z0-9-]{0,79})['"]\s*;/);
  const marker = /\bconst EX\s*=\s*/g.exec(html);
  if (!eventMatch || !marker) throw new Error("legacy_html_header_invalid");
  const start = html.indexOf("[", marker.index + marker[0].length);
  if (start < 0 || html.slice(marker.index + marker[0].length, start).trim())
    throw new Error("legacy_ex_array_missing");
  let depth = 0, inString = false, escaped = false, end = -1;
  for (let index = start; index < html.length; index++) {
    const ch = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) { end = index + 1; break; }
  }
  if (end < 0 || html.slice(end).trimStart()[0] !== ";") throw new Error("legacy_ex_array_invalid");
  let entries;
  try { entries = JSON.parse(html.slice(start, end)); } catch { throw new Error("legacy_ex_array_invalid"); }
  if (!Array.isArray(entries)) throw new Error("legacy_ex_array_invalid");
  return { eventKey: eventMatch[1], entries };
}

export function identityQuarantine(entries) {
  const groups = new Map(), unsafe = [];
  entries.forEach((row, index) => {
    const id = row?.id;
    if (!idOk(id)) unsafe.push({ index, id: typeof id === "string" ? id : null });
    const key = typeof id === "string" ? id : `invalid-row-${index}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  return { rows: entries.length,
    duplicates: [...groups].filter(([, indices]) => indices.length > 1)
      .map(([id, indices]) => ({ id, indices })), unsafe };
}

async function privateJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function captureLegacyCatalogs({ sourceRoot, outputDir }) {
  const root = await realpath(resolve(sourceRoot));
  const out = resolve(outputDir);
  await mkdir(out, { mode: 0o700 });
  await chmod(out, 0o700);
  const objectDir = join(out, "objects");
  await mkdir(objectDir, { mode: 0o700 });
  const discovered = await discover(root);
  const records = [], quarantine = [];
  for (const item of discovered) {
    const actual = await realpath(item.path);
    if (!isInside(root, actual) || !(await lstat(item.path)).isFile())
      throw new Error("legacy_source_path_invalid");
    const bytes = await readFile(actual);
    if (bytes.length > 50_000_000) throw new Error("legacy_source_too_large");
    const sha256 = digest(bytes), objectPath = join(objectDir, sha256);
    try { await writeFile(objectPath, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    await chmod(objectPath, 0o600);
    if (digest(await readFile(objectPath)) !== sha256) throw new Error("legacy_backup_byte_mismatch");
    const sourcePath = relative(root, actual);
    const record = { sourcePath, kind: item.kind, objectSha256: sha256, bytes: bytes.length };
    if (item.kind === "deployed_html") {
      try {
        const parsed = parseLegacyExHtml(bytes);
        record.eventKey = parsed.eventKey;
        const conflicts = identityQuarantine(parsed.entries);
        quarantine.push({ sourcePath, objectSha256: sha256, eventKey: parsed.eventKey, ...conflicts });
      } catch (error) {
        quarantine.push({ sourcePath, objectSha256: sha256, error: error.message });
      }
    }
    records.push(record);
  }
  const manifest = { version: 1, records };
  await privateJson(join(out, "manifest.json"), manifest);
  await privateJson(join(out, "identity-quarantine.json"), { version: 1, catalogs: quarantine });
  return { files: records.length, html: records.filter((item) => item.kind === "deployed_html").length,
    sourceJson: records.filter((item) => item.kind === "source_json").length,
    duplicateIds: quarantine.reduce((sum, item) => sum + (item.duplicates ?? []).reduce((n, group) => n + group.indices.length - 1, 0), 0),
    unsafeIds: quarantine.reduce((sum, item) => sum + (item.unsafe?.length ?? 0), 0) };
}

export async function verifyLegacyCatalogBackup(backupDir) {
  const root = resolve(backupDir);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.records)) throw new Error("legacy_manifest_invalid");
  for (const record of manifest.records) {
    if (!/^[a-f0-9]{64}$/.test(record.objectSha256 ?? "") ||
        !Number.isSafeInteger(record.bytes) || record.bytes < 0 ||
        !["deployed_html", "source_json"].includes(record.kind)) throw new Error("legacy_manifest_invalid");
    const bytes = await readFile(join(root, "objects", record.objectSha256));
    if (bytes.length !== record.bytes || digest(bytes) !== record.objectSha256)
      throw new Error("legacy_backup_byte_mismatch");
  }
  return manifest;
}

function applyIdentityResolution(entries, resolutions) {
  const conflicts = identityQuarantine(entries);
  const required = new Set([...conflicts.unsafe.map((item) => item.index),
    ...conflicts.duplicates.flatMap((group) => group.indices)]);
  if (!resolutions || typeof resolutions !== "object" || Array.isArray(resolutions) ||
      Object.keys(resolutions).length !== required.size ||
      Object.keys(resolutions).some((key) => !/^(0|[1-9]\d*)$/.test(key) || !required.has(Number(key)) || !idOk(resolutions[key])))
    throw new Error("legacy_identity_resolution_required");
  for (const group of conflicts.duplicates) {
    if (idOk(group.id) && group.indices.filter((index) => resolutions[index] === group.id).length !== 1)
      throw new Error("legacy_duplicate_owner_required");
  }
  const mapped = entries.map((row, index) => ({ ...row, id: required.has(index) ? resolutions[index] : row.id }));
  if (identityQuarantine(mapped).duplicates.length || identityQuarantine(mapped).unsafe.length)
    throw new Error("legacy_identity_resolution_conflict");
  return mapped;
}

export async function prepareLegacyRestore({ backupDir, mappingFile }) {
  const manifest = await verifyLegacyCatalogBackup(backupDir);
  const mapping = JSON.parse(await readFile(resolve(mappingFile), "utf8"));
  if (mapping.version !== 1 || !Array.isArray(mapping.catalogs)) throw new Error("legacy_mapping_invalid");
  const html = manifest.records.filter((record) => record.kind === "deployed_html");
  if (mapping.catalogs.length !== html.length) throw new Error("legacy_mapping_incomplete");
  const byPath = new Map(mapping.catalogs.map((item) => [item.sourcePath, item]));
  if (byPath.size !== html.length) throw new Error("legacy_mapping_incomplete");
  const ready = [];
  for (const record of html) {
    const selected = byPath.get(record.sourcePath);
    if (!selected || selected.sourceSha256 !== record.objectSha256 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(selected.profileRef ?? "") ||
        selected.eventKey !== record.eventKey) throw new Error("legacy_mapping_invalid");
    const bytes = await readFile(join(resolve(backupDir), "objects", record.objectSha256));
    const parsed = parseLegacyExHtml(bytes);
    const entries = applyIdentityResolution(parsed.entries, selected.resolutions);
    const projected = projectLegacyExSnapshot({ profileRef: selected.profileRef,
      eventKey: selected.eventKey, entries });
    if (projected.status !== "projected") throw new Error(`legacy_import_preflight_${projected.status}`);
    ready.push({ profileRef: selected.profileRef, eventKey: selected.eventKey,
      entries, sourceSha256: record.objectSha256, expectedBuildId: projected.build.buildId,
      expectedRevision: projected.build.artifact.sourceRevision });
  }
  return ready;
}

export async function restoreLegacyCatalogsLocal({ backupDir, mappingFile, endpoint,
  fetchImpl = globalThis.fetch }) {
  const ready = await prepareLegacyRestore({ backupDir, mappingFile });
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/" || url.search || url.hash) throw new Error("local_d1_endpoint_required");
  const results = [];
  for (const item of ready) {
    const response = await fetchImpl(new URL("/catalog/import-legacy", url), { method: "POST",
      headers: { "content-type": "application/json", "x-test-profile": item.profileRef },
      body: JSON.stringify({ eventKey: item.eventKey, entries: item.entries }) });
    if (![200, 201].includes(response.status)) throw new Error("legacy_local_d1_import_failed");
    const body = await response.json();
    if (!["stored", "replay"].includes(body.status) || body.buildId !== item.expectedBuildId ||
        body.sourceRevision !== item.expectedRevision)
      throw new Error("legacy_local_d1_receipt_invalid");
    results.push({ sourceSha256: item.sourceSha256, buildId: body.buildId, status: body.status });
  }
  return results;
}
