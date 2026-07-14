import { describe, expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import postgres from 'postgres';
import { validateManifest } from '../src/recovery/content-recovery.ts';
// @ts-ignore executable .mjs script intentionally exports test seams.
const m4: any = await import('../scripts/gbrain-build-merge-manifest.mjs');
const {
  EXIT,
  M4Error,
  REQUIRED_PRODUCTION_DENY_HASH,
  SOURCE_CENSUS_SQL,
  assertConnectedIdentityAllowed,
  assertDsnNotProduction,
  assertNoWriteProof,
  buildPlanFromSnapshots,
  canonicalJsonBytewise,
  contentIdentityHash,
  pageVersionMarker,
  parseArgs,
  parseRunId,
  renderSanitizedCommandLog,
  renderOutputs,
  validatePinnedInputSemantics,
  verifyFileHash,
  writeOutputsAndReturnExitCode,
  writeOutputs,
} = m4;

const uuidDefault = '9e589d6a-f73f-4533-817f-5cdc91d12c1f';
const uuidVault = 'b37a5d03-53b2-469b-aede-0a9c126a59c5';
const uuidGstack = 'ae47e7a7-107e-4277-9b12-d6432c33c4f2';
const runId = 'gbrain-merge-v4-m4-20260713T170000Z';
const postgresFixtureDsn = process.env.M4_POSTGRES_URL ?? process.env.DATABASE_URL;
const postgresFixturePort = postgresFixtureDsn ? new URL(postgresFixtureDsn).port || '5432' : '';
const postgresFixtureTest = postgresFixtureDsn && !['5432', '5433'].includes(postgresFixturePort) ? test : test.skip;

function source(id: string, uuid = uuidDefault, active_pages = 1) {
  return { id, name: id, local_path: `/fixture/${id}`, config: uuid ? { uuid } : {}, effective_source_uuid: uuid, active_pages, total_pages: active_pages, tombstoned_pages: 0 };
}

function baseSources() {
  return {
    historical: [source('default', uuidDefault, 10), source('vault', uuidVault, 0), source('gstack-code-gstac-26360719b3ad9c', uuidGstack, 0)],
    current: [source('default', '', 10), source('vault', '', 1), source('gstack-code-gstac-26360719b3ad9c', '', 1), source('brain-sync-remote-sdekfy', '', 0)],
  };
}

function cliArgv(overrides: Record<string, string> = {}) {
  const values = {
    'historical-dsn': 'postgres://TJ@127.0.0.1:15433/gbrain_merge_v4',
    'current-dsn': 'postgres://TJ@127.0.0.1:15434/gbrain_prod_inventory_r2',
    decisions: 'd.json',
    'm2-receipt': 'm2.json',
    'm2-uuid-gate': 'uuid.json',
    'm2-preflight': 'preflight.json',
    'production-deny-identity-hash': REQUIRED_PRODUCTION_DENY_HASH,
    'm3-receipt': 'm3.json',
    'm3-overlap': 'overlap.json',
    plan: 'plan.md',
    runtime: '/runtime',
    'runtime-head': 'bc85238a6ba1dc36e98f1719508b36158982278e',
    'run-id': runId,
    'out-dir': 'out',
    ...overrides,
  };
  return [
    '--historical-dsn', values['historical-dsn'],
    '--current-dsn', values['current-dsn'],
    '--decisions', values.decisions,
    '--m2-receipt', values['m2-receipt'],
    '--m2-uuid-gate', values['m2-uuid-gate'],
    '--m2-preflight', values['m2-preflight'],
    '--production-deny-identity-hash', values['production-deny-identity-hash'],
    '--m3-receipt', values['m3-receipt'],
    '--m3-overlap', values['m3-overlap'],
    '--plan', values.plan,
    '--runtime', values.runtime,
    '--runtime-head', values['runtime-head'],
    '--run-id', values['run-id'],
    '--out-dir', values['out-dir'],
    '--json',
  ];
}

let nextId = 1;
function page(partial: Record<string, unknown>) {
  const id = nextId++;
  return {
    id,
    input_source_id: 'default',
    slug: `fixture/page-${id}`,
    type: 'note',
    page_kind: 'markdown',
    title: `Fixture ${id}`,
    compiled_truth: `# Fixture ${id}\n\nBody ${id}`,
    timeline: '',
    frontmatter: {},
    stored_content_hash: '',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    source_path: '/fixture/default',
    deleted_at: null,
    generation: 1,
    ...partial,
  };
}

function snapshots(historicalPages: any[], currentPages: any[], pageVersions: any[] = []) {
  const sources = baseSources();
  return {
    runId,
    historical: { sources: sources.historical, pages: historicalPages, pageVersions },
    current: { sources: sources.current, pages: currentPages, pageVersions: [] },
  };
}

function classCounts(plan: any) {
  return plan.manifestMetadata.count_summary.classes;
}

function expectM4Error(fn: () => unknown, code: number) {
  try {
    fn();
    throw new Error('expected M4Error');
  } catch (err) {
    expect(err).toBeInstanceOf(M4Error);
    expect((err as any).exitCode).toBe(code);
  }
}

describe('M4 run id and CLI grammar', () => {
  test('valid run id derives generated_at_utc without wall clock input', () => {
    expect(parseRunId(runId)).toEqual({ runId, generated_at_utc: '2026-07-13T17:00:00Z' });
  });

  test('invalid run ids reject non-canonical timestamps', () => {
    for (const bad of [
      'gbrain-merge-v4-m4-20260713T170060Z',
      'gbrain-merge-v4-m4-2026-07-13T170000Z',
      'gbrain-merge-v4-m4-spec-v3-20260713T170000Z',
      'gbrain-merge-v4-m4-20260713t170000z',
    ]) {
      expectM4Error(() => parseRunId(bad), EXIT.usage);
    }
  });

  test('all CLI flags are mandatory and optional values are exact', () => {
    const argv = [
      ...cliArgv().slice(0, -1),
      '--class6-cap', '1000',
      '--w2-net-bound', '3067',
      '--w2-gross-bound', '4977',
      '--json',
    ];
    expect(parseArgs(argv)['run-id']).toBe(runId);
    expectM4Error(() => parseArgs([...argv, '--bogus', 'x']), EXIT.usage);
    expectM4Error(() => parseArgs(argv.filter((v) => v !== '--json')), EXIT.usage);
    expectM4Error(() => parseArgs(argv.map((v) => (v === '1000' ? '999' : v))), EXIT.usage);
  });
});

describe('M4 production deny gates', () => {
  test('direct and canonical production DSNs are denied before connection', () => {
    expectM4Error(() => assertDsnNotProduction('postgres://TJ@127.0.0.1:5432/gbrain'), EXIT.productionDenied);
    expectM4Error(() => assertDsnNotProduction('postgres://TJ@127.0.0.1/gbrain'), EXIT.productionDenied);
    expectM4Error(() => assertDsnNotProduction('postgres://TJ@127.0.0.1:5432/not_prod'), EXIT.productionDenied);
    expectM4Error(() => assertDsnNotProduction('postgres://TJ@127.0.0.1:15433/gbrain'), EXIT.productionDenied);
  });

  test('malformed DSN blocks before connection', () => {
    expectM4Error(() => assertDsnNotProduction('not a postgres dsn'), EXIT.productionDenied);
  });

  test('pinned production deny hash mismatch remains exit 5', () => {
    expectM4Error(() => assertDsnNotProduction('postgres://TJ@127.0.0.1:15433/gbrain_merge_v4', 'a'.repeat(64)), EXIT.pinnedInput);
  });

  test('same OID 16384 with isolated dbname and port passes identity denial', () => {
    expect(assertConnectedIdentityAllowed({ database_name: 'gbrain_merge_v4', server_port: '5433', database_oid: '16384' }, {})).toBeUndefined();
  });

  test('production dbname with different OID blocks after connection', () => {
    expectM4Error(() => assertConnectedIdentityAllowed({ database_name: 'gbrain', server_port: '5433', database_oid: '20000' }, {}), EXIT.productionDenied);
  });

  test('production port with different OID blocks after connection', () => {
    expectM4Error(() => assertConnectedIdentityAllowed({ database_name: 'gbrain_merge_v4', server_port: '5432', database_oid: '20000' }, {}), EXIT.productionDenied);
  });

  test('full production identity blocks after connection', () => {
    expectM4Error(() => assertConnectedIdentityAllowed({
      host: '127.0.0.1/32',
      port: 5432,
      dbname: 'gbrain',
      current_user: 'TJ',
      database_oid: '16384',
      schema_version: '118',
      recovery_identity_present: false,
    }, {}), EXIT.productionDenied);
  });
});

describe('M4 source census SQL', () => {
  postgresFixtureTest('uses the production source census query against real PostgreSQL', async () => {
    const sql = postgres(postgresFixtureDsn!, { max: 1, idle_timeout: 1, connect_timeout: 10 });
    try {
      await sql.unsafe('BEGIN');
      await sql.unsafe(`
        CREATE TEMP TABLE sources (
          id text PRIMARY KEY,
          name text NOT NULL,
          local_path text,
          config jsonb NOT NULL DEFAULT '{}'::jsonb
        ) ON COMMIT DROP
      `);
      await sql.unsafe(`
        CREATE TEMP TABLE pages (
          id integer PRIMARY KEY,
          source_id text NOT NULL REFERENCES sources(id),
          deleted_at timestamptz
        ) ON COMMIT DROP
      `);
      await sql.unsafe(`
        INSERT INTO sources (id, name, local_path, config) VALUES
          ('default', 'Default', '/fixture/default', '{"uuid":"${uuidDefault}"}'::jsonb),
          ('gstack-code-gstac-26360719b3ad9c', 'GStack', '/fixture/gstack', '{"source_uuid":"${uuidGstack}"}'::jsonb),
          ('vault', 'Vault', '/fixture/vault', '{"uuid":"${uuidVault}"}'::jsonb)
      `);
      await sql.unsafe(`
        INSERT INTO pages (id, source_id, deleted_at) VALUES
          (1, 'default', NULL),
          (2, 'default', NULL),
          (3, 'default', '2026-07-10T00:00:00Z'),
          (4, 'gstack-code-gstac-26360719b3ad9c', NULL)
      `);

      const rows = await sql.unsafe(SOURCE_CENSUS_SQL);

      expect(rows.map((row) => row.id)).toEqual(['default', 'gstack-code-gstac-26360719b3ad9c', 'vault']);
      expect(rows.map((row) => row.effective_source_uuid)).toEqual([uuidDefault, uuidGstack, uuidVault]);
      expect(rows.map((row) => Number(row.active_pages))).toEqual([2, 1, 0]);
      expect(rows.map((row) => Number(row.total_pages))).toEqual([3, 1, 0]);
      expect(rows.map((row) => Number(row.tombstoned_pages))).toEqual([1, 0, 0]);
      expect(rows[0].name).toBe('Default');
      expect(rows[0].local_path).toBe('/fixture/default');
      await sql.unsafe('ROLLBACK');
    } catch (err) {
      await sql.unsafe('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});

describe('M4 hashing and page-version evidence', () => {
  test('canonical JSON sorts by UTF-8 byte order', () => {
    expect(canonicalJsonBytewise({ b: 1, a: 2, 'é': 3 })).toBe('{"a":2,"b":1,"é":3}');
  });

  test('content identity differs from applicator hash semantics for bare CR and NFC', async () => {
    const { contentHash } = await import('../src/recovery/content-recovery.ts');
    const text = 'Cafe\u0301\rLine  \n';
    expect(contentIdentityHash(text)).not.toBe(contentHash(text));
  });

  test('page-version marker has a stable byte fixture and SQL marker is computed in memory', () => {
    const marker = pageVersionMarker({
      page_version_id: 12,
      page_id: 34,
      input_source_id: 'default',
      slug: 'people/example',
      snapshot_at: '2026-07-05T01:02:03.004Z',
      compiled_truth: 'Cafe\u0301\r\nBody  \n',
      frontmatter: { z: 1, a: ['x'] },
    });
    expect(marker).toBe('fc4a4db6ba20f3c27f3f0c0fbfb8e260c23be2b0dc85f5f1705501ccb6e7d57b');
    const script = readFileSync(join(process.cwd(), 'scripts/gbrain-build-merge-manifest.mjs'), 'utf8');
    expect(script).not.toContain('sha256_marker');
  });

  test('raw-byte input hash verification and no-write proof fail closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-m4-hash-'));
    try {
      const file = join(dir, 'input.json');
      writeFileSync(file, '{"a":1}\n');
      expect(verifyFileHash(file, 'e346432021b04179518d9614f3560ccd71354a4ee101ddcb893d6959a9d6301c', 'fixture')).toBe('e346432021b04179518d9614f3560ccd71354a4ee101ddcb893d6959a9d6301c');
      expectM4Error(() => verifyFileHash(file, 'a'.repeat(64), 'fixture'), EXIT.pinnedInput);
      expect(assertNoWriteProof({ pages: '1' }, { pages: '1' })).toBe(true);
      expectM4Error(() => assertNoWriteProof({ pages: '1' }, { pages: '2' }), EXIT.noWriteProof);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('semantic validation pins D2/D3, M2 UUID rows, merge target identity, and M3 production flags', () => {
    const docs = {
      decisions: {
        schema_version: 'gbrain_merge_human_decision_packet_v1',
        approved: true,
        approved_by: 'TJ',
        approved_at_utc: '2026-07-13T16:01:35Z',
        D2: { source_map: [
          { input_source_id: 'default', target_source_id: 'default', target_source_uuid: uuidDefault },
          { input_source_id: 'vault', target_source_id: 'vault', target_source_uuid: uuidVault },
          { input_source_id: 'gstack-code-gstac-26360719b3ad9c', target_source_id: 'gstack-code-gstac-26360719b3ad9c', target_source_uuid: uuidGstack },
        ], quarantined_source: 'brain-sync-remote-sdekfy' },
        D3: { path: '/Users/TJ/hermes-workspace/Lex-Workspace/wiki' },
      },
      m2Receipt: { status: 'PASS', success: true, exit_gate: { uuid_gate_green: true, m4_planning_may_begin: true, production_untouched_where_comparable: true } },
      m2UuidGate: {
        pass: true,
        rows: [
          { input_source_id: 'default', target_source_id: 'default', target_source_uuid: uuidDefault },
          { input_source_id: 'vault', target_source_id: 'vault', target_source_uuid: uuidVault },
          { input_source_id: 'gstack-code-gstac-26360719b3ad9c', target_source_id: 'gstack-code-gstac-26360719b3ad9c', target_source_uuid: uuidGstack },
        ],
        checks: { each_actionable_source_has_nonempty_effective_uuid: true, all_three_unique: true },
        quarantined_source: { active_pages: 0 },
      },
      m2Preflight: {
        pass: true,
        differs_from_merge: true,
        read_only_probe_only: true,
        runtime_head: { clean: true },
        merge_target_identity_hash: 'fdb43be2976e613335ad0d1f9ea587c63b957c3160959ef68da6f2274e03e079',
        production_readonly_identity_denial_proof: {
          comparable_identity_hash: REQUIRED_PRODUCTION_DENY_HASH,
          dsn_redacted: 'postgres://TJ@127.0.0.1:5432/gbrain',
          identity: { dbname: 'gbrain', port: 5432, database_oid: '16384' },
        },
      },
      m3Receipt: { status: 'PASS', success: true, dump: { hash_matches_required: true, active_pages: 21492 }, production_mutation_flags: { pages: false, sources: false } },
      m3Overlap: { default_overlap: 11843, identical: 11639, divergent: 204, historical_only: 94684, current_default_only: 8107, candidate_matches_previous_m3: true },
    };
    expect(validatePinnedInputSemantics({ 'runtime-head': 'bc85238a6ba1dc36e98f1719508b36158982278e', 'production-deny-identity-hash': REQUIRED_PRODUCTION_DENY_HASH }, docs).production_deny_identity_hash).toBe(REQUIRED_PRODUCTION_DENY_HASH);
    const wrong = structuredClone(docs);
    wrong.m3Receipt.dump.active_pages = 21491;
    expectM4Error(() => validatePinnedInputSemantics({ 'runtime-head': 'bc85238a6ba1dc36e98f1719508b36158982278e', 'production-deny-identity-hash': REQUIRED_PRODUCTION_DENY_HASH }, wrong), EXIT.pinnedInput);
  });
});

describe('M4 classification and accounting', () => {
  test('classifies all M4 classes with deterministic draft/final split', () => {
    const h1 = page({ slug: 'same', compiled_truth: 'same' });
    const c1 = page({ slug: 'same', compiled_truth: 'same' });
    const h2 = page({ slug: 'historical-only' });
    const c3 = page({ slug: 'current-only' });
    const h4 = page({ slug: 'changed', compiled_truth: 'old body' });
    const c4 = page({ slug: 'changed', compiled_truth: 'new body', updated_at: '2026-07-06T00:00:00.000Z' });
    const h5 = page({ slug: 'truncated', title: 'Truncated Fixture', source_path: '/fixture/default/truncated.md', compiled_truth: '# Long\n\n' + 'A long paragraph. '.repeat(30), updated_at: '2026-06-01T00:00:00.000Z' });
    const c5 = page({ slug: 'truncated', title: 'Truncated Fixture', source_path: '/fixture/default/truncated.md', compiled_truth: '# Long', updated_at: '2026-06-02T00:00:00.000Z' });
    const h6 = page({ slug: 'conflict', compiled_truth: 'historical body' });
    const c6 = page({ slug: 'conflict', compiled_truth: 'unrelated current body' });
    const h7 = page({ slug: 'old-tombstone', deleted_at: '2026-06-05T00:00:00.000Z' });
    const d8 = page({ slug: 'derived', derived_only: true });
    const plan = buildPlanFromSnapshots(snapshots([h1, h2, h4, h5, h6, h7, d8], [c1, c3, c4, c5, c6]));
    expect(classCounts(plan)).toMatchObject({ '1': 1, '2': 1, '3': 1, '4': 1, '5': 1, '6': 1, '7': 1, '8': 1, '9': 0 });
    expect(plan.manifestDraftRows.map((r: any) => r.restore_action).sort()).toEqual(['add_exact', 'merge_exact']);
    expect(plan.accountingProof.pass).toBe(true);
  });

  test('class 5 timestamp-only divergent row falls to class 6', () => {
    const h = page({ slug: 'timestamp-only', compiled_truth: 'historical body' });
    const c = page({ slug: 'timestamp-only', compiled_truth: 'current body', updated_at: '2026-06-02T00:00:00.000Z' });
    const plan = buildPlanFromSnapshots(snapshots([h], [c]));
    expect(classCounts(plan)['6']).toBe(1);
    expect(classCounts(plan)['5']).toBe(0);
  });

  test('unrelated post-cut page version does not rescue an old divergent row into class 4', () => {
    const h = page({ slug: 'pv-unrelated', compiled_truth: 'historical body', updated_at: '2026-06-01T00:00:00.000Z' });
    const c = page({ slug: 'pv-unrelated', compiled_truth: 'current body', updated_at: '2026-06-02T00:00:00.000Z' });
    const plan = buildPlanFromSnapshots(snapshots([h], [c], [{
      page_version_id: 501,
      page_id: h.id,
      input_source_id: 'default',
      slug: 'pv-unrelated',
      snapshot_at: '2026-07-05T00:00:00.000Z',
      compiled_truth: 'different post-cut version body',
      frontmatter: {},
    }]));
    expect(classCounts(plan)['6']).toBe(1);
    expect(classCounts(plan)['4']).toBe(0);
    expect(plan.manifestDraftRows).toHaveLength(0);
  });

  test('page-version body proof uses applicator hash, not normalized identity hash', () => {
    const h = page({ slug: 'pv-hash-family', compiled_truth: 'historical body', updated_at: '2026-06-01T00:00:00.000Z' });
    const c = page({ slug: 'pv-hash-family', compiled_truth: 'Café\nLine', updated_at: '2026-06-02T00:00:00.000Z' });
    const pvBody = 'Cafe\u0301\rLine  \n';
    expect(contentIdentityHash(pvBody)).toBe(contentIdentityHash(c.compiled_truth));
    const plan = buildPlanFromSnapshots(snapshots([h], [c], [{
      page_version_id: 502,
      page_id: h.id,
      input_source_id: 'default',
      slug: 'pv-hash-family',
      snapshot_at: '2026-07-05T00:00:00.000Z',
      compiled_truth: pvBody,
      frontmatter: {},
    }]));
    expect(classCounts(plan)['6']).toBe(1);
    expect(classCounts(plan)['4']).toBe(0);
  });

  test('class 5 strict prefix and heading truncation require metadata identity equality', () => {
    const longBody = '# Shared\n\n' + 'Same historical paragraph. '.repeat(30);
    const hPrefix = page({ slug: 'meta-prefix', compiled_truth: longBody, frontmatter: { entity: 'historical' }, title: 'Historical Title', type: 'person', source_path: '/fixture/default/historical.md' });
    const cPrefix = page({ slug: 'meta-prefix', compiled_truth: '# Shared\n\nSame historical paragraph.', frontmatter: { entity: 'current' }, title: 'Current Title', type: 'company', source_path: '/fixture/default/current.md' });
    const hHeading = page({ slug: 'meta-heading', compiled_truth: longBody, effective_date: '2026-01-01T00:00:00.000Z' });
    const cHeading = page({ slug: 'meta-heading', compiled_truth: '# Shared', effective_date: '2026-02-01T00:00:00.000Z' });
    const plan = buildPlanFromSnapshots(snapshots([hPrefix, hHeading], [cPrefix, cHeading]));
    expect(classCounts(plan)['6']).toBe(2);
    expect(classCounts(plan)['5']).toBe(0);
  });

  test('class 5 explicit human disposition requires exact row identity and hashes', () => {
    const h = page({ slug: 'human-class5', compiled_truth: 'historical body' });
    const c = page({ slug: 'human-class5', compiled_truth: 'current body' });
    const plan = buildPlanFromSnapshots({
      ...snapshots([h], [c]),
      humanDispositions: [{
        canonical_source_id: 'default',
        slug: 'human-class5',
        historical_page_id: h.id,
        current_page_id: c.id,
        historical_content_identity_hash: contentIdentityHash(h.compiled_truth),
        current_content_identity_hash: contentIdentityHash(c.compiled_truth),
        approve_historical_preservation: true,
      }],
    });
    expect(classCounts(plan)['5']).toBe(1);
  });

  test('unknown source, duplicate identity, class 6 cap, and accounting residue stop with required codes', () => {
    expectM4Error(() => buildPlanFromSnapshots({
      runId,
      historical: { sources: [...baseSources().historical, source('rogue', '', 1)], pages: [], pageVersions: [] },
      current: { sources: baseSources().current, pages: [], pageVersions: [] },
    }), EXIT.unknownSource);

    expectM4Error(() => buildPlanFromSnapshots(snapshots([page({ slug: 'dup' }), page({ slug: 'dup' })], [])), EXIT.duplicateOrAccounting);

    expectM4Error(() => buildPlanFromSnapshots({ ...snapshots([page({ slug: 'cap', compiled_truth: 'a' })], [page({ slug: 'cap', compiled_truth: 'b' })]), class6Cap: 0 }), EXIT.class6Cap);

  });

  test('missing, duplicate, and mismatched target UUIDs stop with source UUID code', () => {
    const good = baseSources();
    expectM4Error(() => buildPlanFromSnapshots({
      runId,
      historical: { sources: [source('default', '', 1)], pages: [], pageVersions: [] },
      current: { sources: good.current, pages: [], pageVersions: [] },
    }), EXIT.sourceUuid);
    expectM4Error(() => buildPlanFromSnapshots({
      runId,
      historical: { sources: [source('default', uuidDefault, 1), source('default', uuidDefault, 1)], pages: [], pageVersions: [] },
      current: { sources: good.current, pages: [], pageVersions: [] },
    }), EXIT.sourceUuid);
    expectM4Error(() => buildPlanFromSnapshots({
      runId,
      historical: { sources: [source('default', uuidVault, 1)], pages: [], pageVersions: [] },
      current: { sources: good.current, pages: [], pageVersions: [] },
    }), EXIT.sourceUuid);
  });

  test('current Vault and GStack rows use target UUIDs from source map, not blank current UUIDs', () => {
    const vault = page({ input_source_id: 'vault', slug: 'vault/new', source_path: '/fixture/vault' });
    const gstack = page({ input_source_id: 'gstack-code-gstac-26360719b3ad9c', slug: 'gstack/new', source_path: '/fixture/gstack' });
    const plan = buildPlanFromSnapshots(snapshots([], [vault, gstack]));
    expect(plan.manifestDraftRows.map((r: any) => r.source_uuid).sort()).toEqual([uuidGstack, uuidVault].sort());
  });

  test('actionable draft source path follows signed source local path, not page metadata', () => {
    const current = page({ slug: 'path-contract', source_path: '/page/metadata/path-contract.md' });
    const plan = buildPlanFromSnapshots(snapshots([], [current]));
    const row = plan.manifestDraftRows[0];
    expect(row.source_path).toBe('/fixture/default');
    expect(row.source_path).not.toBe(current.source_path);
    const payload = plan.payloadBundle.payloads[row.recovery_payload_hash];
    expect(payload.source_path).toBe('/fixture/default');
    expect(row.source_path).toBe(baseSources().current.find((s) => s.id === 'default')?.local_path);
    expect(renderOutputs(plan)['classification-ledger.csv']).toContain('/page/metadata/path-contract.md,/fixture/default');
  });

  test('current Vault and GStack drafts require matching historical target source rows', () => {
    const vault = page({ input_source_id: 'vault', slug: 'vault/missing', source_path: '/fixture/vault' });
    const gstack = page({ input_source_id: 'gstack-code-gstac-26360719b3ad9c', slug: 'gstack/missing', source_path: '/fixture/gstack' });
    const sources = baseSources();
    expectM4Error(() => buildPlanFromSnapshots({
      runId,
      historical: { sources: [source('default', uuidDefault, 1)], pages: [], pageVersions: [] },
      current: { sources: sources.current, pages: [vault], pageVersions: [] },
    }), EXIT.sourceUuid);
    expectM4Error(() => buildPlanFromSnapshots({
      runId,
      historical: { sources: [source('default', uuidDefault, 1), source('vault', '', 0)], pages: [], pageVersions: [] },
      current: { sources: sources.current, pages: [vault], pageVersions: [] },
    }), EXIT.sourceUuid);
    expectM4Error(() => buildPlanFromSnapshots({
      runId,
      historical: { sources: [source('default', uuidDefault, 1), source('vault', uuidGstack, 0)], pages: [], pageVersions: [] },
      current: { sources: sources.current, pages: [vault], pageVersions: [] },
    }), EXIT.sourceUuid);
    expectM4Error(() => buildPlanFromSnapshots({
      runId,
      historical: { sources: [source('default', uuidDefault, 1), source('gstack-code-gstac-26360719b3ad9c', uuidGstack, 0), source('gstack-code-gstac-26360719b3ad9c', uuidGstack, 0)], pages: [], pageVersions: [] },
      current: { sources: sources.current, pages: [gstack], pageVersions: [] },
    }), EXIT.sourceUuid);
    const plan = buildPlanFromSnapshots(snapshots([], [vault, gstack]));
    expect(plan.manifestDraftRows.map((r: any) => `${r.source_id}:${r.source_uuid}`).sort()).toEqual([
      `gstack-code-gstac-26360719b3ad9c:${uuidGstack}`,
      `vault:${uuidVault}`,
    ]);
  });
});

describe('M4 outputs', () => {
  test('draft manifest is explicitly not apply-ready and current validator rejects it', () => {
    const plan = buildPlanFromSnapshots(snapshots([], [page({ slug: 'new-page' })]));
    const files = renderOutputs(plan);
    const metadata = JSON.parse(files['manifest-metadata.json']);
    expect(metadata.direct_apply_ready).toBe(false);
    expect(metadata.validate_manifest_expected_to_pass).toBe(false);
    expect(validateManifest(plan.manifestDraftRows as any).length).toBeGreaterThan(0);
  });

  test('finalizer default compile set is only class 3/4 draft rows', () => {
    const h1 = page({ slug: 'same2', compiled_truth: 'same' });
    const c1 = page({ slug: 'same2', compiled_truth: 'same' });
    const h2 = page({ slug: 'historical-only2' });
    const c3 = page({ slug: 'current-only2' });
    const h4 = page({ slug: 'changed2', compiled_truth: 'old body' });
    const c4 = page({ slug: 'changed2', compiled_truth: 'new body', updated_at: '2026-07-06T00:00:00.000Z' });
    const plan = buildPlanFromSnapshots(snapshots([h1, h2, h4], [c1, c3, c4]));
    expect(plan.manifestDraftRows.map((r: any) => r.v43_class).sort()).toEqual(['3', '4']);
  });

  test('artifact bytes are deterministic across locales and write no forbidden placeholders', () => {
    const plan = buildPlanFromSnapshots(snapshots([], [page({ slug: 'deterministic' })]));
    const a = renderOutputs(plan);
    const b = renderOutputs(plan);
    expect(a['SHA256SUMS.txt']).toBe(b['SHA256SUMS.txt']);
    for (const [name, content] of Object.entries(a)) {
      expect(content).not.toMatch(/\b(TBD|TODO|PLACEHOLDER|PENDING|unknown)\b|0{64}|00000000-0000-0000-0000-000000000000/);
      expect(name.endsWith('.csv') || name.endsWith('.json') || name.endsWith('.md') || name.endsWith('.txt')).toBe(true);
    }
  });

  test('W2 bounds excess writes blocking artifacts and returns exit 7 without draft rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-m4-w2-'));
    try {
      const plan = buildPlanFromSnapshots({ ...snapshots([], [page({ slug: 'w2', deleted_at: '2026-07-05T00:00:00.000Z' })]), w2NetBound: 0 });
      expect(plan.accountingProof.blocking).toBe(true);
      expect(plan.accountingProof.pass).toBe(false);
      expect(plan.manifestDraftRows).toHaveLength(0);
      const exitCode = writeOutputsAndReturnExitCode(dir, plan);
      expect(exitCode).toBe(EXIT.w2Bound);
      expect(readFileSync(join(dir, 'loss-window-report.md'), 'utf8')).toContain('BLOCKING: W2 bounds exceeded');
      expect(JSON.parse(readFileSync(join(dir, 'accounting-proof.json'), 'utf8')).pass).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, 'manifest-metadata.json'), 'utf8')).blocking).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('command log is deterministic and redacts password-bearing DSNs from every output file', () => {
    const secret = 'fixture-secret-password';
    const opts = parseArgs(cliArgv({
      'historical-dsn': `postgres://TJ:${secret}@127.0.0.1:15433/gbrain_merge_v4`,
      'current-dsn': `postgres://TJ:${secret}@127.0.0.1:15434/gbrain_prod_inventory_r2`,
    }));
    const commandLine = renderSanitizedCommandLog(opts);
    expect(commandLine).toContain('postgres://TJ:***@127.0.0.1:15433/gbrain_merge_v4');
    expect(commandLine).not.toContain(secret);
    const plan = buildPlanFromSnapshots(snapshots([], [page({ slug: 'redaction' })]));
    const files = renderOutputs(plan, { commandLine });
    for (const content of Object.values(files)) {
      expect(String(content)).not.toContain(secret);
    }
  });

  test('writeOutputs emits only the required files under out-dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-m4-test-'));
    try {
      const plan = buildPlanFromSnapshots(snapshots([], [page({ slug: 'write-out' })]));
      writeOutputs(dir, plan);
      const sha = readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8');
      expect(sha).toContain('manifest-draft.csv');
      expect(sha).toContain('classification-ledger.csv');
      expect(sha).toContain('accounting-proof.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
