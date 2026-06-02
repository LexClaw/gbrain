#!/usr/bin/env bun
/**
 * One-shot GBrain historical cleanup Wave 1 backfill.
 *
 * Scope:
 * - sources/<handle>/<date>-<slug>: derive x_handle from X source_url first,
 *   then slug component 2 when it is already X-API-valid.
 * - tweet-<id>: derive x_handle from twitter/x.com URL when present; otherwise
 *   parse early body @mentions conservatively (single unique mention in first
 *   200 chars); otherwise stand down with paraphrase/citation_status markers.
 * - author chain: propagate people/<slug>.frontmatter.x_handle where available.
 *
 * Additive metadata only. No body rewrites.
 */

import postgres from "postgres";

type Row = {
  id: number;
  slug: string;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
};

type Mutation = {
  id: number;
  slug: string;
  patch: Record<string, string>;
  reason: string;
};

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost:5432/gbrain";
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

function validHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/^@/, "").trim();
  return HANDLE_RE.test(trimmed) ? trimmed : null;
}

function handleFromXUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)\//i);
  if (!match) return null;
  const handle = decodeURIComponent(match[1]);
  if (["i", "intent", "share", "search", "home", "hashtag"].includes(handle.toLowerCase())) return null;
  return validHandle(handle);
}

function slugComponentHandle(slug: string): string | null {
  const component = slug.split("/")[1];
  return validHandle(component);
}

function conservativeMentionHandle(text: string): string | null {
  const first200 = text.slice(0, 200);
  const matches = [...first200.matchAll(/(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{1,15})\b/g)].map((m) => m[2]);
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : null;
}

function addMutation(mutations: Mutation[], row: Row, patch: Record<string, string>, reason: string) {
  mutations.push({ id: row.id, slug: row.slug, patch, reason });
}

function parseArgs() {
  return { live: process.argv.includes("--live") };
}

const { live } = parseArgs();
const sql = postgres(DATABASE_URL, { max: 1 });

try {
  const before = await sql<[{ count: string }]>`select count(*)::text as count from pages`;
  console.log(`Connected to ${DATABASE_URL}; pages=${before[0].count}; mode=${live ? "LIVE" : "DRY-RUN"}`);

  const mutations: Mutation[] = [];

  // 1.1 sources/<handle>/*: source_url is authoritative for X; slug component is fallback.
  const sources = await sql<Row[]>`
    select id, slug, compiled_truth, frontmatter
    from pages
    where slug like 'sources/%/%'
      and not (frontmatter ? 'x_handle')
  `;
  for (const row of sources) {
    const fromUrl = handleFromXUrl(row.frontmatter.source_url);
    if (fromUrl) {
      addMutation(mutations, row, { x_handle: fromUrl }, "1.1 sources: x_handle from X source_url");
      continue;
    }
    const fromSlug = slugComponentHandle(row.slug);
    if (fromSlug && row.slug.split("/")[1] !== "youtube") {
      addMutation(mutations, row, { x_handle: fromSlug }, "1.1 sources: x_handle from valid slug component");
    }
  }

  // 1.2 tweet-<id>: URL first; conservative single early mention second; otherwise stand-down marker.
  const tweets = await sql<Row[]>`
    select id, slug, compiled_truth, frontmatter
    from pages
    where slug ~ '^tweet-[0-9]+$'
      and not (frontmatter ? 'x_handle')
  `;
  for (const row of tweets) {
    const fromUrl = handleFromXUrl(row.frontmatter.url) ?? handleFromXUrl(row.frontmatter.source_url);
    if (fromUrl) {
      addMutation(mutations, row, { x_handle: fromUrl }, "1.2 tweet: x_handle from tweet URL");
      continue;
    }
    const fromMention = conservativeMentionHandle(row.compiled_truth);
    if (fromMention) {
      addMutation(mutations, row, { x_handle: fromMention }, "1.2 tweet: x_handle from single @handle in first 200 chars");
      continue;
    }
    const patch: Record<string, string> = {};
    if (row.frontmatter.provenance !== "paraphrase") patch.provenance = "paraphrase";
    if (row.frontmatter.citation_status !== "missing") patch.citation_status = "missing";
    if (Object.keys(patch).length > 0) addMutation(mutations, row, patch, "1.2/1.4 tweet: unrecoverable handle stand-down marker");
  }

  // 1.3 author chain propagation for any author-bearing page still without x_handle.
  const authorRows = await sql<(Row & { person_handle: string | null })[]>`
    select s.id, s.slug, s.compiled_truth, s.frontmatter, p.frontmatter->>'x_handle' as person_handle
    from pages s
    join pages p on p.slug = s.frontmatter->>'author'
    where s.frontmatter ? 'author'
      and not (s.frontmatter ? 'x_handle')
      and p.frontmatter ? 'x_handle'
  `;
  const already = new Set(mutations.map((m) => m.id));
  for (const row of authorRows) {
    const h = validHandle(row.person_handle);
    if (h && !already.has(row.id)) addMutation(mutations, row, { x_handle: h }, "1.3 author-chain: propagated people/<slug>.x_handle");
  }

  const byReason = new Map<string, number>();
  for (const m of mutations) byReason.set(m.reason, (byReason.get(m.reason) ?? 0) + 1);
  console.log("Planned mutations by reason:");
  for (const [reason, count] of [...byReason.entries()].sort()) console.log(`  ${count}\t${reason}`);

  const invalid = mutations.filter((m) => m.patch.x_handle && !HANDLE_RE.test(m.patch.x_handle));
  if (invalid.length) {
    console.error("Invalid x_handle patches:", invalid.slice(0, 10));
    process.exit(2);
  }

  console.log("Sample mutations:");
  for (const m of mutations.slice(0, 20)) console.log(JSON.stringify(m));

  if (!live) {
    console.log("Dry-run only. Re-run with --live to apply.");
    process.exit(0);
  }

  await sql.begin(async (tx) => {
    for (const m of mutations) {
      let patch = sql.json(m.patch);
      await tx`
        update pages
        set frontmatter = frontmatter || ${patch}::jsonb,
            updated_at = now()
        where id = ${m.id}
      `;
    }
  });

  console.log(`Applied ${mutations.length} additive frontmatter patches.`);
} finally {
  await sql.end({ timeout: 5 });
}
