#!/usr/bin/env node
import { readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createLegacyNoteRecoveryPlan } from "../src/legacy-note-recovery-plan.js";

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
async function privateInput(path) {
  const actual = await realpath(resolve(path));
  await outsideGit(actual);
  const item = await lstat(actual);
  if (!item.isFile() || item.mode & 0o077) throw new Error("legacy_private_input_permissions");
  return JSON.parse(await readFile(actual, "utf8"));
}

const [reportPath, receiptsPath, outputPath, decisionsPath, catalogsPath] = process.argv.slice(2);
try {
  if (!reportPath || !receiptsPath || !outputPath || Boolean(decisionsPath) !== Boolean(catalogsPath))
    throw new Error("legacy_plan_usage");
  const requestedOutput = resolve(outputPath);
  const parent = await realpath(dirname(requestedOutput));
  const output = join(parent, basename(requestedOutput));
  await outsideGit(parent);
  if ((await lstat(parent)).mode & 0o077) throw new Error("legacy_private_output_permissions");
  const report = await privateInput(reportPath);
  const expectedReceipts = await privateInput(receiptsPath);
  const decisions = decisionsPath ? await privateInput(decisionsPath) : [];
  const trustedCatalogs = catalogsPath ? await privateInput(catalogsPath) : [];
  const plan = createLegacyNoteRecoveryPlan({ report, expectedReceipts,
    decisions, trustedCatalogs, requireComplete: Boolean(decisionsPath) });
  await writeFile(output, JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify(plan.summary) + "\n");
} catch (error) {
  const code = /^legacy_[a-z_]+$/.test(error?.message ?? "") ? error.message : "io_unavailable";
  process.stderr.write(`legacy_plan_failed:${code}\n`);
  process.exitCode = 1;
}
