#!/usr/bin/env node
import { captureLegacyCatalogs, verifyLegacyCatalogBackup,
  restoreLegacyCatalogsLocal } from "../src/private-legacy-handoff.js";

const [mode, ...args] = process.argv.slice(2);
try {
  if (mode === "capture" && args.length === 2) {
    const result = await captureLegacyCatalogs({ sourceRoot: args[0], outputDir: args[1] });
    process.stdout.write(JSON.stringify(result) + "\n");
  } else if (mode === "verify" && args.length === 1) {
    const manifest = await verifyLegacyCatalogBackup(args[0]);
    process.stdout.write(JSON.stringify({ verifiedFiles: manifest.records.length }) + "\n");
  } else if (mode === "restore-local" && args.length === 3) {
    const receipts = await restoreLegacyCatalogsLocal({ backupDir: args[0],
      mappingFile: args[1], endpoint: args[2] });
    process.stdout.write(JSON.stringify({ restoredCatalogs: receipts.length,
      stored: receipts.filter((item) => item.status === "stored").length,
      replayed: receipts.filter((item) => item.status === "replay").length }) + "\n");
  } else {
    process.stderr.write("usage: legacy-ex-handoff.mjs capture SOURCE_ROOT NEW_PRIVATE_DIR | verify PRIVATE_DIR | restore-local PRIVATE_DIR PRIVATE_MAPPING_JSON http://127.0.0.1:PORT/\n");
    process.exitCode = 2;
  }
} catch (error) {
  // Never print private paths, IDs, provider bodies or captured catalog bytes.
  const code = /^legacy_[a-z0-9_]+$/.test(error?.message ?? "") ? error.message : "io_unavailable";
  process.stderr.write(`legacy_handoff_failed:${code}\n`);
  process.exitCode = 1;
}
