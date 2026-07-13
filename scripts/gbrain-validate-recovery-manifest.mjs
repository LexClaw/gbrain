#!/usr/bin/env bun
import { readFileSync } from 'fs';
import { parseCsv, sha256, validateManifest } from '../src/recovery/content-recovery.ts';

const input = process.argv[process.argv.indexOf('--input') + 1];
if (!input || input === process.argv[0]) {
  console.error('Usage: bun scripts/gbrain-validate-recovery-manifest.mjs --input recovery-manifest.v3.csv');
  process.exit(2);
}
const text = readFileSync(input, 'utf8');
const rows = parseCsv(text);
const errors = validateManifest(rows);
console.log(JSON.stringify({ rows: rows.length, sha256: sha256(text), valid: errors.length === 0, errors }, null, 2));
process.exit(errors.length === 0 ? 0 : 1);
