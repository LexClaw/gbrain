#!/usr/bin/env bun
import { readFileSync } from 'fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { applyRecoveryManifest, assertAllowlistedEnvironment, loadAllowlist, parseCsv, rollbackBatch } from '../src/recovery/content-recovery.ts';

function arg(name, fallback = '') { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
const manifestPath = arg('--manifest');
const allowlistPath = arg('--allowlist');
const worktree = arg('--worktree', process.cwd());
const expectedHead = arg('--expected-head');
const batchId = arg('--batch-id', 'batch-1');
const approvalHash = arg('--approval-hash', 'isolated-rehearsal');
const rollback = process.argv.includes('--rollback');
const dryRun = process.argv.includes('--dry-run');
if (!manifestPath || !allowlistPath || !expectedHead) {
  console.error('Usage: GBRAIN_HOME=<isolated> bun scripts/gbrain-apply-recovery-manifest.mjs --manifest recovery-manifest.v3.csv --allowlist allowlist.json --worktree <path> --expected-head <sha> --batch-id B --approval-hash H [--dry-run|--rollback]');
  process.exit(2);
}
const allow = loadAllowlist(allowlistPath);
const asserted = assertAllowlistedEnvironment(allow, { worktree, expectedHead });
const rows = parseCsv(readFileSync(manifestPath, 'utf8'));
const engine = new PGLiteEngine();
await engine.connect({ database_path: `${process.env.GBRAIN_HOME}/brain.pglite` });
await engine.initSchema();
try {
  const result = rollback
    ? await rollbackBatch(engine, rows[0]?.run_id || '', batchId)
    : await applyRecoveryManifest(engine, rows, { batchId, approvalHash, dryRun });
  console.log(JSON.stringify({ asserted, result }, null, 2));
} finally {
  await engine.disconnect();
}
