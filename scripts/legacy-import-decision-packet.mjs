#!/usr/bin/env node
import { writeFile, chmod, lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildLegacyImportDecisionPacket } from "../src/legacy-import-decision-packet.js";

async function outsideGit(path) {
  let dir = await realpath(dirname(resolve(path)));
  while (true) {
    try { await lstat(join(dir, ".git")); throw new Error("private_output_in_git"); }
    catch (error) { if (error?.message === "private_output_in_git") throw error;
      if (error?.code !== "ENOENT") throw error; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

async function run([backupDir, reviewPacketPath, outputPath]) {
  if (![backupDir, reviewPacketPath, outputPath].every(Boolean)) throw new Error("usage");
  await outsideGit(outputPath);
  const packet = await buildLegacyImportDecisionPacket({ backupDir, reviewPacketPath });
  await writeFile(outputPath, JSON.stringify(packet, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await chmod(outputPath, 0o600);
  const catalogs = packet.owners.flatMap((owner) => owner.catalogs);
  process.stdout.write(JSON.stringify({ status: packet.status, approvedForImport: false,
    ownerCount: packet.owners.length, catalogCount: catalogs.length,
    rows: catalogs.reduce((sum, item) => sum + item.rowCount, 0),
    identityDecisions: catalogs.reduce((sum, item) => sum + item.identityDecisions.length, 0),
    fieldDecisions: catalogs.reduce((sum, item) => sum + item.fieldDecisions.length, 0),
    structurallyProjected: catalogs.filter((item) => item.structuralProjectionStatus === "projected").length,
    structurallyInvalid: catalogs.filter((item) => !["projected", "blocked_on_identity_resolution"]
      .includes(item.structuralProjectionStatus)).length }) + "\n");
}

run(process.argv.slice(2)).catch((error) => {
  const code = /^[a-z_]+$/.test(error?.message ?? "") ? error.message : "input_unavailable";
  process.stderr.write(`legacy_import_review_failed:${code}\n`);
  process.exitCode = 1;
});
