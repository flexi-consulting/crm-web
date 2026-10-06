#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { verifyLegacyCatalogBackup } from "../src/private-legacy-handoff.js";
import { buildLegacyCurrentCandidateList } from "../src/legacy-current-candidates.js";

async function outsideGit(path) {
  let current = resolve(path);
  while (true) {
    try { await lstat(join(current, ".git")); throw new Error("legacy_private_path_in_git"); }
    catch (error) { if (error?.message === "legacy_private_path_in_git") throw error;
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error; }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
async function privateBytes(path) {
  const actual = await realpath(resolve(path));
  await outsideGit(actual);
  const item = await lstat(actual);
  if (!item.isFile() || item.mode & 0o077) throw new Error("legacy_private_input_permissions");
  return readFile(actual);
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const [reportPath, receiptsPath, backupPath, outputPath] = process.argv.slice(2);
try {
  if (!reportPath || !receiptsPath || !backupPath || !outputPath)
    throw new Error("legacy_candidate_usage");
  const backup = await realpath(resolve(backupPath));
  await outsideGit(backup);
  if ((await lstat(backup)).mode & 0o077)
    throw new Error("legacy_private_backup_permissions");
  const requestedOutput = resolve(outputPath), parent = await realpath(dirname(requestedOutput));
  await outsideGit(parent);
  if ((await lstat(parent)).mode & 0o077)
    throw new Error("legacy_private_output_permissions");
  const output = join(parent, basename(requestedOutput));
  const reportBytes = await privateBytes(reportPath);
  const report = JSON.parse(reportBytes.toString("utf8"));
  const receipts = JSON.parse((await privateBytes(receiptsPath)).toString("utf8"));
  if (receipts.correlationReport !== sha(reportBytes))
    throw new Error("legacy_correlation_receipt_mismatch");
  const manifest = await verifyLegacyCatalogBackup(backup);
  if (manifest.manifestSha256 !== receipts.current ||
      report.sourceReceipts?.historical !== receipts.historical ||
      report.sourceReceipts?.notesSql !== receipts.notesSql)
    throw new Error("legacy_source_receipt_mismatch");
  const list = await buildLegacyCurrentCandidateList({ correlationReport: report,
    verifiedManifest: manifest,
    readObject: (digest) => readFile(join(backup, "objects", digest)) });
  await writeFile(output, JSON.stringify(list, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify(list.summary) + "\n");
} catch (error) {
  const code = /^legacy_[a-z_]+$/.test(error?.message ?? "") ? error.message : "io_unavailable";
  process.stderr.write(`legacy_candidates_failed:${code}\n`);
  process.exitCode = 1;
}
