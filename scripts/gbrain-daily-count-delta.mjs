#!/usr/bin/env bun
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
if (!process.env.GBRAIN_HOME || process.env.DATABASE_URL || process.env.GBRAIN_DATABASE_URL) throw new Error('isolated GBRAIN_HOME required and DSN env vars must be unset');
const engine = new PGLiteEngine();
await engine.connect({ database_path: `${process.env.GBRAIN_HOME}/brain.pglite` });
await engine.initSchema();
try {
  const rows = await engine.executeRaw(`SELECT date_trunc('day', updated_at)::text AS day, COUNT(*)::text AS pages FROM pages GROUP BY 1 ORDER BY 1`);
  console.log(JSON.stringify({ daily_counts: rows }, null, 2));
} finally { await engine.disconnect(); }
