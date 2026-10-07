#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile, chmod, lstat, realpath } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { buildLegacyProfileReviewPacket } from "../src/legacy-profile-review-packet.js";

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

async function run([manifestPath, expectedSha256, outputPath]) {
  if (![manifestPath, expectedSha256, outputPath].every(Boolean)) throw new Error("usage");
  await outsideGit(outputPath);
  const actual = await realpath(resolve(manifestPath));
  const bytes = await readFile(actual);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== expectedSha256) throw new Error("source_receipt_mismatch");
  const packet = buildLegacyProfileReviewPacket(JSON.parse(bytes.toString("utf8")), sha);
  await writeFile(outputPath, JSON.stringify(packet, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await chmod(outputPath, 0o600);
  process.stdout.write(JSON.stringify({ status: packet.status, catalogCount: packet.owners
    .reduce((total, owner) => total + owner.catalogs.length, 0), ownerCount: packet.owners.length,
    approvedForImport: false }) + "\n");
}

run(process.argv.slice(2)).catch((error) => {
  const code = /^[a-z_]+$/.test(error?.message ?? "") ? error.message : "input_unavailable";
  process.stderr.write(`legacy_profile_review_packet_failed:${code}\n`);
  process.exitCode = 1;
});
