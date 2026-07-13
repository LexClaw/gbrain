#!/usr/bin/env bun
import { readFileSync } from 'fs';
import { parseCsv } from '../src/recovery/content-recovery.ts';
const manifest = process.argv[process.argv.indexOf('--manifest') + 1];
if (!manifest) { console.error('Usage: bun scripts/gbrain-derived-coverage-report.mjs --manifest recovery-manifest.v3.csv'); process.exit(2); }
const rows = parseCsv(readFileSync(manifest, 'utf8'));
const approved = rows.filter(r => ['add_exact','merge_exact'].includes(r.restore_action));
console.log(JSON.stringify({ derived_data_mutation_approved: false, approved_page_rows: approved.length, required_separate_gate: true }, null, 2));
