#!/usr/bin/env bun
import { readFileSync } from 'fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseCsv, verifyRecovery } from '../src/recovery/content-recovery.ts';

const manifestPath = process.argv[process.argv.indexOf('--manifest') + 1];
const runId = process.argv[process.argv.indexOf('--run-id') + 1];
const dbPath = process.env.GBRAIN_HOME ? `${process.env.GBRAIN_HOME}/brain.pglite` : undefined;
if (!manifestPath || !runId) {
  console.error('Usage: GBRAIN_HOME=<isolated> bun scripts/gbrain-verify-recovery.mjs --manifest recovery-manifest.v3.csv --run-id RUN');
  process.exit(2);
}
const engine = new PGLiteEngine();
await engine.connect(dbPath ? { database_path: dbPath } : {});
await engine.initSchema();
try {
  const rows = parseCsv(readFileSync(manifestPath, 'utf8'));
  const result = await verifyRecovery(engine, rows, runId);
  console.log(JSON.stringify(result, null, 2));
  process.exit(Object.values(result).every(v => v.pass) ? 0 : 1);
} finally {
  await engine.disconnect();
}
