#!/usr/bin/env bun
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { buildManifest, gapLedger, sha256, toCsv } from '../src/recovery/content-recovery.ts';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const inputPath = arg('--input');
const outPath = arg('--out');
const gapsPath = arg('--gaps-out');
const hashesPath = arg('--hashes-out');
const runId = arg('--run-id', `recovery-${new Date().toISOString().slice(0, 10)}`);
if (!inputPath || !outPath) {
  console.error('Usage: bun scripts/gbrain-build-loss-manifest.mjs --input manifest-input.json --run-id RUN --out recovery-manifest.v3.csv [--gaps-out gaps.md] [--hashes-out hashes.txt]');
  process.exit(2);
}
const inputText = readFileSync(inputPath, 'utf8');
const rows = buildManifest(JSON.parse(inputText), runId);
const csv = toCsv(rows);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, csv);
if (gapsPath) writeFileSync(gapsPath, gapLedger(rows));
if (hashesPath) writeFileSync(hashesPath, `input_sha256 ${sha256(inputText)}\nmanifest_sha256 ${sha256(csv)}\n`);
console.log(JSON.stringify({ rows: rows.length, manifest_sha256: sha256(csv) }));
