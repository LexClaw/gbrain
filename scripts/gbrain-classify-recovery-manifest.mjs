#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'fs';
import { parseCsv, buildManifest, toCsv } from '../src/recovery/content-recovery.ts';

const input = process.argv[process.argv.indexOf('--input') + 1];
const out = process.argv[process.argv.indexOf('--out') + 1];
if (!input || !out || input === process.argv[0] || out === process.argv[0]) {
  console.error('Usage: bun scripts/gbrain-classify-recovery-manifest.mjs --input recovery-manifest.v3.csv --out recovery-manifest.v3.csv');
  process.exit(2);
}
const rows = parseCsv(readFileSync(input, 'utf8'));
const reclassified = buildManifest({ predelete: rows, live: [] }, rows[0]?.run_id || 'recovery');
writeFileSync(out, toCsv(reclassified));
console.log(JSON.stringify({ rows: reclassified.length }));
