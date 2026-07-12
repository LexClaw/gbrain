#!/usr/bin/env bun
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
if (!process.env.GBRAIN_HOME || process.env.DATABASE_URL || process.env.GBRAIN_DATABASE_URL) throw new Error('isolated GBRAIN_HOME required and DSN env vars must be unset');
const engine = new PGLiteEngine();
await engine.connect({ database_path: `${process.env.GBRAIN_HOME}/brain.pglite` });
await engine.initSchema();
try {
  const rows = await engine.executeRaw('SELECT id, name, local_path, config FROM sources ORDER BY id');
  console.log(JSON.stringify({ sources: rows }, null, 2));
} finally { await engine.disconnect(); }
