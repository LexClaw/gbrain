#!/usr/bin/env bun

import { existsSync, mkdirSync, statSync, appendFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import postgres from 'postgres';

const DEFAULT_DATABASE_URL = 'postgres://localhost:5432/gbrain';
const GBRAIN_DIR = join(homedir(), '.gbrain');
const SNAPSHOT_DIR = join(GBRAIN_DIR, 'snapshots');
const PROGRESS_PATH = join(GBRAIN_DIR, 'dedup-progress.jsonl');

type Mode = 'dry-run' | 'execute' | 'test-tiebreak';

type Args = {
  mode: Mode;
  databaseUrl: string;
  reportPath?: string;
  snapshotPath?: string;
};

type PageRow = {
  id: number;
  slug: string;
  type: string;
  content_hash: string;
  created_at: Date;
  inbound_links: number;
  timeline_entries: number;
};

type Decision = {
  contentHash: string;
  canonical: PageRow;
  deletePages: PageRow[];
  archivePages: PageRow[];
};

type Summary = {
  mode: Mode;
  reportPath: string;
  snapshotPath: string | null;
  duplicateGroups: number;
  totalPagesInGroups: number;
  namespacedPagesInGroups: number;
  flatPagesInGroups: number;
  flatAndNamespacedGroups: number;
  namespacedOnlyGroups: number;
  flatOnlyGroups: number;
  nonArchiveSoftDeletes: number;
  archiveDuplicatesLeft: number;
  linksToRepoint: number;
  timelineEntriesToRepoint: number;
  groupsWithArchiveMembers: number;
  generatedAt: string;
};

function usage(): string {
  return `Usage:
  bun run scripts/dedup-content-hash.ts [--dry-run] [--report <path>] [--database-url <url>]
  GBRAIN_DEDUP_APPROVED=1 bun run scripts/dedup-content-hash.ts --execute [--snapshot <path>]

Defaults:
  --dry-run is default and writes no database changes.
  --execute requires GBRAIN_DEDUP_APPROVED=1 and a verified snapshot.
  --database-url defaults to GBRAIN_DATABASE_URL, DATABASE_URL, then ${DEFAULT_DATABASE_URL}.`;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'dry-run',
    databaseUrl: process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.mode = 'dry-run';
    } else if (arg === '--execute') {
      args.mode = 'execute';
    } else if (arg === '--test-tiebreak') {
      args.mode = 'test-tiebreak';
    } else if (arg === '--database-url') {
      args.databaseUrl = requireValue(argv, ++i, arg);
    } else if (arg === '--report') {
      args.reportPath = requireValue(argv, ++i, arg);
    } else if (arg === '--snapshot') {
      args.snapshotPath = requireValue(argv, ++i, arg);
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  return args;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return expandHome(value);
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDirs() {
  mkdirSync(GBRAIN_DIR, { recursive: true });
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

function createSnapshot(databaseUrl: string): string {
  ensureDirs();
  const out = join(SNAPSHOT_DIR, `pre-dedup-${timestamp()}.dump`);
  const dump = spawnSync('pg_dump', ['--format=custom', '--file', out, databaseUrl], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (dump.status !== 0) {
    throw new Error(`pg_dump failed: ${dump.stderr || dump.stdout}`);
  }
  assertSnapshotRestorable(out);
  return out;
}

function ensureSnapshot(databaseUrl: string, requestedPath?: string): string {
  const existing = requestedPath ?? findLatestSnapshot();
  if (existing) {
    assertSnapshotRestorable(existing);
    return existing;
  }
  return createSnapshot(databaseUrl);
}

function assertSnapshotRestorable(path: string) {
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error(`Snapshot missing or empty: ${path}`);
  }
  const listing = spawnSync('pg_restore', ['--list', path], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (listing.status !== 0 || listing.stdout.trim().length === 0) {
    throw new Error(`Snapshot is not restorable by pg_restore --list: ${path}\n${listing.stderr || listing.stdout}`);
  }
}

function findLatestSnapshot(): string | null {
  ensureDirs();
  const proc = spawnSync('bash', ['-lc', `ls -t ${shellQuote(SNAPSHOT_DIR)}/pre-dedup-*.dump 2>/dev/null | head -n 1`], {
    encoding: 'utf8',
  });
  const path = proc.stdout.trim();
  return path || null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isNamespaced(slug: string): boolean {
  return slug.includes('/');
}

function isArchive(slug: string): boolean {
  return slug.startsWith('archive/');
}

export function chooseCanonical(pages: PageRow[]): PageRow {
  if (pages.length === 0) throw new Error('chooseCanonical needs at least one page');
  const nonArchive = pages.filter(p => !isArchive(p.slug));
  const pool = nonArchive.length > 0 ? nonArchive : pages;
  const namespaced = pool.filter(p => isNamespaced(p.slug));
  const candidates = namespaced.length > 0 ? namespaced : pool;

  return [...candidates].sort((a, b) => {
    const inbound = b.inbound_links - a.inbound_links;
    if (inbound !== 0) return inbound;
    const timeline = b.timeline_entries - a.timeline_entries;
    if (timeline !== 0) return timeline;
    const created = a.created_at.getTime() - b.created_at.getTime();
    if (created !== 0) return created;
    const len = a.slug.length - b.slug.length;
    if (len !== 0) return len;
    const slug = a.slug.localeCompare(b.slug);
    if (slug !== 0) return slug;
    return a.id - b.id;
  })[0];
}

function runTiebreakCheck() {
  const base = (overrides: Partial<PageRow>): PageRow => ({
    id: 1,
    slug: 'faith/wiki/alpha-long',
    type: 'concept',
    content_hash: 'hash',
    created_at: new Date('2026-01-02T00:00:00Z'),
    inbound_links: 1,
    timeline_entries: 1,
    ...overrides,
  });

  const checks: Array<[string, PageRow[], string]> = [
    ['namespaced beats flat', [base({ slug: 'flat', inbound_links: 99 }), base({ slug: 'faith/wiki/ns', inbound_links: 1 })], 'faith/wiki/ns'],
    ['non-archive beats archive', [base({ slug: 'archive/wiki/ns', inbound_links: 99 }), base({ slug: 'faith/wiki/ns', inbound_links: 1 })], 'faith/wiki/ns'],
    ['most links', [base({ slug: 'faith/wiki/a', inbound_links: 2 }), base({ slug: 'faith/wiki/b', inbound_links: 3 })], 'faith/wiki/b'],
    ['most timeline', [base({ slug: 'faith/wiki/a', inbound_links: 2, timeline_entries: 4 }), base({ slug: 'faith/wiki/b', inbound_links: 2, timeline_entries: 5 })], 'faith/wiki/b'],
    ['earliest created', [base({ slug: 'faith/wiki/a', created_at: new Date('2026-01-01T00:00:00Z') }), base({ slug: 'faith/wiki/b', created_at: new Date('2026-01-02T00:00:00Z') })], 'faith/wiki/a'],
    ['shortest slug', [base({ slug: 'faith/wiki/longer' }), base({ slug: 'faith/a' })], 'faith/a'],
  ];

  for (const [name, pages, expected] of checks) {
    const actual = chooseCanonical(pages).slug;
    if (actual !== expected) throw new Error(`Tiebreak check failed (${name}): expected ${expected}, got ${actual}`);
  }

  console.log(`Tiebreak checks passed: ${checks.length}`);
}

async function loadDecisions(sql: ReturnType<typeof postgres>): Promise<{ decisions: Decision[]; summaryBase: Omit<Summary, 'mode' | 'reportPath' | 'snapshotPath' | 'nonArchiveSoftDeletes' | 'archiveDuplicatesLeft' | 'linksToRepoint' | 'timelineEntriesToRepoint' | 'generatedAt'> }> {
  const rows = await sql<PageRow[]>`
    WITH dup AS (
      SELECT content_hash
      FROM pages
      WHERE deleted_at IS NULL AND content_hash IS NOT NULL
      GROUP BY content_hash
      HAVING COUNT(*) > 1
    ), inbound AS (
      SELECT to_page_id AS id, COUNT(*)::int AS inbound_links
      FROM links
      GROUP BY to_page_id
    ), timeline AS (
      SELECT page_id AS id, COUNT(*)::int AS timeline_entries
      FROM timeline_entries
      GROUP BY page_id
    )
    SELECT
      p.id,
      p.slug,
      p.type,
      p.content_hash,
      p.created_at,
      COALESCE(i.inbound_links, 0)::int AS inbound_links,
      COALESCE(t.timeline_entries, 0)::int AS timeline_entries
    FROM pages p
    JOIN dup d ON d.content_hash = p.content_hash
    LEFT JOIN inbound i ON i.id = p.id
    LEFT JOIN timeline t ON t.id = p.id
    WHERE p.deleted_at IS NULL
    ORDER BY p.content_hash, p.slug, p.id
  `;

  const groups = new Map<string, PageRow[]>();
  for (const row of rows) {
    const key = row.content_hash;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const decisions: Decision[] = [];
  let flatAndNamespacedGroups = 0;
  let namespacedOnlyGroups = 0;
  let flatOnlyGroups = 0;
  let namespacedPagesInGroups = 0;
  let flatPagesInGroups = 0;
  let groupsWithArchiveMembers = 0;

  for (const [contentHash, pages] of groups) {
    const namespaced = pages.filter(p => isNamespaced(p.slug));
    const flat = pages.filter(p => !isNamespaced(p.slug));
    const archivePages = pages.filter(p => isArchive(p.slug));
    namespacedPagesInGroups += namespaced.length;
    flatPagesInGroups += flat.length;
    if (namespaced.length > 0 && flat.length > 0) flatAndNamespacedGroups++;
    else if (namespaced.length > 0) namespacedOnlyGroups++;
    else flatOnlyGroups++;
    if (archivePages.length > 0) groupsWithArchiveMembers++;

    const canonical = chooseCanonical(pages);
    decisions.push({
      contentHash,
      canonical,
      deletePages: pages.filter(p => p.id !== canonical.id && !isArchive(p.slug)),
      archivePages: pages.filter(p => p.id !== canonical.id && isArchive(p.slug)),
    });
  }

  return {
    decisions,
    summaryBase: {
      duplicateGroups: groups.size,
      totalPagesInGroups: rows.length,
      namespacedPagesInGroups,
      flatPagesInGroups,
      flatAndNamespacedGroups,
      namespacedOnlyGroups,
      flatOnlyGroups,
      groupsWithArchiveMembers,
    },
  };
}

async function countRepoints(sql: ReturnType<typeof postgres>, decisions: Decision[]) {
  const deletedIds = decisions.flatMap(d => d.deletePages.map(p => p.id));
  if (deletedIds.length === 0) return { linksToRepoint: 0, timelineEntriesToRepoint: 0 };
  const linkRows = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM links WHERE to_page_id = ANY(${deletedIds})`;
  const timelineRows = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM timeline_entries WHERE page_id = ANY(${deletedIds})`;
  return {
    linksToRepoint: Number(linkRows[0]?.count ?? 0),
    timelineEntriesToRepoint: Number(timelineRows[0]?.count ?? 0),
  };
}

async function executeDecisions(sql: ReturnType<typeof postgres>, decisions: Decision[]) {
  const startedAt = new Date().toISOString();
  let processedGroups = 0;
  let repointedLinks = 0;
  let repointedTimeline = 0;
  let softDeleted = 0;

  await sql.begin(async tx => {
    for (const decision of decisions) {
      if (decision.deletePages.length === 0) continue;
      const deleteIds = decision.deletePages.map(p => p.id);
      const canonicalId = decision.canonical.id;

      const links = await tx<{ id: number }[]>`
        UPDATE links
        SET to_page_id = ${canonicalId}
        WHERE to_page_id = ANY(${deleteIds})
        RETURNING id
      `;
      const timeline = await tx<{ id: number }[]>`
        UPDATE timeline_entries
        SET page_id = ${canonicalId}
        WHERE page_id = ANY(${deleteIds})
        ON CONFLICT (page_id, date, summary, source) DO NOTHING
        RETURNING id
      `;
      const pages = await tx<{ id: number }[]>`
        UPDATE pages
        SET deleted_at = now()
        WHERE id = ANY(${deleteIds}) AND deleted_at IS NULL
        RETURNING id
      `;

      processedGroups++;
      repointedLinks += links.length;
      repointedTimeline += timeline.length;
      softDeleted += pages.length;
      appendFileSync(PROGRESS_PATH, JSON.stringify({
        processed_at: new Date().toISOString(),
        content_hash: decision.contentHash,
        canonical_id: canonicalId,
        canonical_slug: decision.canonical.slug,
        soft_deleted_ids: pages.map(p => p.id),
        started_at: startedAt,
      }) + '\n');
    }
  });

  return { processedGroups, repointedLinks, repointedTimeline, softDeleted };
}

function buildReport(summary: Summary, decisions: Decision[]): string {
  const lines: string[] = [];
  lines.push('# GBrain content_hash dedup dry-run report');
  lines.push('');
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Mode: ${summary.mode}`);
  lines.push(`Snapshot: ${summary.snapshotPath ?? 'not created in dry-run'}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Duplicate groups: ${summary.duplicateGroups}`);
  lines.push(`- Total pages in duplicate groups: ${summary.totalPagesInGroups}`);
  lines.push(`- Namespaced pages in duplicate groups: ${summary.namespacedPagesInGroups}`);
  lines.push(`- Flat pages in duplicate groups: ${summary.flatPagesInGroups}`);
  lines.push(`- Flat and namespaced groups: ${summary.flatAndNamespacedGroups}`);
  lines.push(`- Namespaced-only groups: ${summary.namespacedOnlyGroups}`);
  lines.push(`- Flat-only groups: ${summary.flatOnlyGroups}`);
  lines.push(`- Non-archive soft-deletes planned: ${summary.nonArchiveSoftDeletes}`);
  lines.push(`- Archive duplicate pages left untouched: ${summary.archiveDuplicatesLeft}`);
  lines.push(`- Groups with archive members: ${summary.groupsWithArchiveMembers}`);
  lines.push(`- Links to repoint: ${summary.linksToRepoint}`);
  lines.push(`- Timeline entries to repoint: ${summary.timelineEntriesToRepoint}`);
  lines.push('');
  lines.push('## Canonical selection rules');
  lines.push('');
  lines.push('1. Prefer non-archive pages, archive pages are left untouched when a non-archive canonical exists.');
  lines.push('2. Prefer namespaced slugs over flat slugs.');
  lines.push('3. For namespaced candidates, sort by most inbound links, most timeline entries, earliest created_at, shortest slug, lexical slug, then id.');
  lines.push('');
  lines.push('## First 20 decisions');
  lines.push('');
  for (const decision of decisions.slice(0, 20)) {
    lines.push(`- content_hash: ${decision.contentHash}`);
    lines.push(`  - keep: ${decision.canonical.slug} (id ${decision.canonical.id}, inbound ${decision.canonical.inbound_links}, timeline ${decision.canonical.timeline_entries})`);
    lines.push(`  - soft-delete: ${decision.deletePages.map(p => `${p.slug} (id ${p.id})`).join(', ') || 'none'}`);
    lines.push(`  - archive untouched: ${decision.archivePages.map(p => `${p.slug} (id ${p.id})`).join(', ') || 'none'}`);
  }
  lines.push('');
  lines.push('## Full decisions');
  lines.push('');
  for (const decision of decisions) {
    lines.push(`- ${decision.contentHash}`);
    lines.push(`  - keep: ${decision.canonical.slug}`);
    for (const page of decision.deletePages) lines.push(`  - soft-delete: ${page.slug} -> ${decision.canonical.slug}`);
    for (const page of decision.archivePages) lines.push(`  - archive untouched: ${page.slug}`);
  }
  lines.push('');
  lines.push('## Execute command');
  lines.push('');
  lines.push('GBRAIN_DEDUP_APPROVED=1 bun run scripts/dedup-content-hash.ts --execute');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'test-tiebreak') {
    runTiebreakCheck();
    return;
  }

  ensureDirs();
  const generatedAt = new Date().toISOString();
  const reportPath = args.reportPath ?? join(GBRAIN_DIR, `dedup-dry-run-${timestamp()}.md`);
  let snapshotPath: string | null = null;

  if (args.mode === 'execute') {
    if (process.env.GBRAIN_DEDUP_APPROVED !== '1') {
      throw new Error('Refusing --execute: set GBRAIN_DEDUP_APPROVED=1 after TJ approval.');
    }
    snapshotPath = ensureSnapshot(args.databaseUrl, args.snapshotPath);
  }

  const sql = postgres(args.databaseUrl, { max: 4, idle_timeout: 20, connect_timeout: 10, prepare: false });
  try {
    const { decisions, summaryBase } = await loadDecisions(sql);
    const { linksToRepoint, timelineEntriesToRepoint } = await countRepoints(sql, decisions);
    const summary: Summary = {
      mode: args.mode,
      reportPath,
      snapshotPath,
      ...summaryBase,
      nonArchiveSoftDeletes: decisions.reduce((sum, d) => sum + d.deletePages.length, 0),
      archiveDuplicatesLeft: decisions.reduce((sum, d) => sum + d.archivePages.length, 0),
      linksToRepoint,
      timelineEntriesToRepoint,
      generatedAt,
    };

    const report = buildReport(summary, decisions);
    writeFileSync(reportPath, report);

    if (args.mode === 'execute') {
      const result = await executeDecisions(sql, decisions);
      console.log(JSON.stringify({ ...summary, executeResult: result }, null, 2));
    } else {
      console.log(JSON.stringify(summary, null, 2));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
