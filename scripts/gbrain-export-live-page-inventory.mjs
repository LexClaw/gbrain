#!/usr/bin/env bun
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { toCsv, MANIFEST_COLUMNS } from '../src/recovery/content-recovery.ts';

const out = process.argv[process.argv.indexOf('--out') + 1];
if (!out || !process.env.GBRAIN_HOME) {
  console.error('Usage: GBRAIN_HOME=<isolated> bun scripts/gbrain-export-live-page-inventory.mjs --out live-inventory.csv');
  process.exit(2);
}
if (process.env.DATABASE_URL || process.env.GBRAIN_DATABASE_URL) throw new Error('production DSN env vars must be unset');
const engine = new PGLiteEngine();
await engine.connect({ database_path: `${process.env.GBRAIN_HOME}/brain.pglite` });
await engine.initSchema();
try {
  const pages = await engine.executeRaw(`SELECT id, source_id, slug, type, title, content_hash, generation, updated_at FROM pages ORDER BY source_id, slug`);
  const rows = pages.map(p => Object.fromEntries(MANIFEST_COLUMNS.map(k => [k, '']))).map((r, i) => ({ ...r, run_id: 'live-inventory', source_id: pages[i].source_id, slug: pages[i].slug, type: pages[i].type, title: pages[i].title, live_present: 'true', live_page_id: String(pages[i].id), live_version: String(pages[i].generation), live_content_hash: pages[i].content_hash ?? '', live_updated_at: String(pages[i].updated_at), live_source_id: pages[i].source_id }));
  await Bun.write(out, toCsv(rows));
  console.log(JSON.stringify({ rows: rows.length }));
} finally { await engine.disconnect(); }
