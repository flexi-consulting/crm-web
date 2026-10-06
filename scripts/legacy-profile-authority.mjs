#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile, chmod, lstat, realpath } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { auditLegacyProfileAuthority } from "../src/legacy-profile-authority.js";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function outsideGit(path) {
  let dir = dirname(resolve(path));
  while (true) {
    try { await lstat(join(dir, ".git")); throw new Error("private_output_in_git"); }
    catch (error) { if (error?.message === "private_output_in_git") throw error;
      if (error?.code !== "ENOENT") throw error; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

async function run([manifestPath, authorityPath, mappingPath, notesPath, outputPath]) {
  if (![manifestPath, authorityPath, mappingPath, notesPath, outputPath].every(Boolean))
    throw new Error("usage");
  await outsideGit(outputPath);
  const inputs = await Promise.all([manifestPath, authorityPath, mappingPath, notesPath]
    .map(async (path) => {
      const actual = await realpath(resolve(path));
      const bytes = await readFile(actual);
      return { data: JSON.parse(bytes.toString("utf8")), sha256: digest(bytes) };
    }));
  const [manifest, authority, mapping, notes] = inputs;
  if (mapping.data.manifestSha256 !== manifest.sha256 ||
      mapping.data.authoritySha256 !== authority.sha256 ||
      mapping.data.notesSha256 !== notes.sha256) throw new Error("source_receipt_mismatch");
  const report = auditLegacyProfileAuthority({ manifest: manifest.data,
    authority: authority.data, mapping: mapping.data, notes: notes.data });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await chmod(outputPath, 0o600);
  process.stdout.write(JSON.stringify({ status: report.status, totals: report.totals,
    approvedForImport: report.approvedForImport }) + "\n");
}

run(process.argv.slice(2)).catch((error) => {
  const code = /^[a-z_]+$/.test(error?.message ?? "") ? error.message : "input_unavailable";
  process.stderr.write(`legacy_profile_audit_failed:${code}\n`);
  process.exitCode = 1;
});
