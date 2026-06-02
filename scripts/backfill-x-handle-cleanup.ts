#!/usr/bin/env bun
/**
 * One-shot GBrain historical cleanup Wave 1 backfill.
 *
 * Scope for card kn713xmc:
 * - 1.2 tweet-<id>: fill missing frontmatter.x_handle from early body @handle
 *   first, then X API v2 tweet lookup by id. Also writes source_url.
 * - 1.3 author-chain pages: fill missing x_handle from source URL, author
 *   handle text, or people/<slug>.frontmatter.x_handle when available.
 * - 1.6 integrity auto batch evidence is captured by the operator command.
 *
 * Additive JSONB metadata only. No body rewrites.
 */

import postgres from "postgres";

type Frontmatter = Record<string, unknown>;

type Row = {
  id: number;
  slug: string;
  compiled_truth: string;
  frontmatter: Frontmatter;
};

type AuthorRow = Row & { person_handle: string | null };

type Mutation = {
  id: number;
  slug: string;
  patch: Record<string, string>;
  reason: string;
};

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost:5432/gbrain";
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const TWEET_RE = /^tweet-([0-9]+)$/;
const RESERVED = new Set(["i", "intent", "share", "search", "home", "hashtag"]);

type TwitterUser = { id: string; username?: string };
type TwitterTweet = { id: string; author_id?: string };
type TwitterResponse = {
  data?: TwitterTweet[];
  includes?: { users?: TwitterUser[] };
  errors?: Array<{ detail?: string; title?: string; value?: string }>;
};

function validHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^@/, "");
  return HANDLE_RE.test(trimmed) ? trimmed : null;
}

function handleFromXUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)(?:\/|$)/i);
  if (!match) return null;
  const handle = decodeURIComponent(match[1]);
  if (RESERVED.has(handle.toLowerCase())) return null;
  return validHandle(handle);
}

function statusIdFromXUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/?#]+\/status\/([0-9]+)/i);
  return match?.[1] ?? null;
}

function conservativeMentionHandle(text: string): string | null {
  const first200 = text.slice(0, 200);
  const matches = [...first200.matchAll(/(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{1,15})\b/g)].map((m) => m[2]);
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : null;
}

function handlesFromAuthor(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const handles = new Set<string>();
  for (const item of values) {
    if (typeof item !== "string") continue;
    for (const match of item.matchAll(/@([A-Za-z0-9_]{1,15})\b/g)) handles.add(match[1]);
  }
  return [...handles];
}

function singleAuthorHandle(value: unknown): string | null {
  const handles = handlesFromAuthor(value);
  return handles.length === 1 ? handles[0] : null;
}

function parseArgs() {
  const args = new Set(process.argv.slice(2));
  return {
    live: args.has("--live"),
    skipApi: args.has("--skip-api"),
  };
}

function addMutation(mutations: Mutation[], row: Row, patch: Record<string, string>, reason: string) {
  const current = row.frontmatter ?? {};
  const additive: Record<string, string> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (current[key] !== value) additive[key] = value;
  }
  if (Object.keys(additive).length > 0) mutations.push({ id: row.id, slug: row.slug, patch: additive, reason });
}

function tweetIdFromSlug(slug: string): string | null {
  return slug.match(TWEET_RE)?.[1] ?? null;
}

function sourceUrl(handle: string, id: string): string {
  return `https://x.com/${handle}/status/${id}`;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function lookupTweetHandles(tweetIds: string[]): Promise<Map<string, string>> {
  const token = (process.env.X_API_BEARER_TOKEN ?? process.env.X_BEARER_TOKEN ?? "").trim();
  const found = new Map<string, string>();
  if (!token || tweetIds.length === 0) return found;

  for (let i = 0; i < tweetIds.length; i += 100) {
    const batch = tweetIds.slice(i, i + 100);
    const url = new URL("https://api.twitter.com/2/tweets");
    url.searchParams.set("ids", batch.join(","));
    url.searchParams.set("tweet.fields", "author_id");
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", "username");

    let response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 429) {
      const reset = Number(response.headers.get("x-rate-limit-reset") ?? "0") * 1000;
      const waitMs = Math.max(1_000, Math.min(15 * 60_000, reset - Date.now() + 1_000));
      console.log(`X API 429, waiting ${waitMs}ms before retry`);
      await sleep(waitMs);
      response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`X API tweet lookup failed: HTTP ${response.status} ${body.slice(0, 500)}`);
    }

    const json = (await response.json()) as TwitterResponse;
    const users = new Map<string, string>();
    for (const user of json.includes?.users ?? []) {
      const handle = validHandle(user.username);
      if (handle) users.set(user.id, handle);
    }
    for (const tweet of json.data ?? []) {
      const handle = tweet.author_id ? users.get(tweet.author_id) : null;
      if (handle) found.set(tweet.id, handle);
    }
    console.log(`X API batch ${Math.floor(i / 100) + 1}: requested=${batch.length}, resolved=${found.size}`);
  }

  return found;
}

function printCounts(label: string, counts: Record<string, number>) {
  console.log(`${label}: ${JSON.stringify(counts)}`);
}

const { live, skipApi } = parseArgs();
const sql = postgres(DATABASE_URL, { max: 1 });

try {
  const beforeRows = await sql<[{ tweet_total: number; tweet_missing: number; author_missing: number; bad_x_handle: number }]>`
    select
      count(*) filter (where slug ~ '^tweet-[0-9]+$')::int as tweet_total,
      count(*) filter (where slug ~ '^tweet-[0-9]+$' and not (frontmatter ? 'x_handle'))::int as tweet_missing,
      count(*) filter (where frontmatter ? 'author' and not (frontmatter ? 'x_handle'))::int as author_missing,
      count(*) filter (where frontmatter ? 'x_handle' and not ((frontmatter->>'x_handle') ~ '^[A-Za-z0-9_]{1,15}$'))::int as bad_x_handle
    from pages
  `;
  printCounts("before", beforeRows[0]);
  console.log(`mode=${live ? "LIVE" : "DRY-RUN"}; skipApi=${skipApi}`);

  const mutations: Mutation[] = [];

  const tweets = await sql<Row[]>`
    select id, slug, coalesce(compiled_truth, '') as compiled_truth, frontmatter
    from pages
    where slug ~ '^tweet-[0-9]+$'
      and not (frontmatter ? 'x_handle')
    order by slug
  `;

  const apiCandidates: Row[] = [];
  for (const row of tweets) {
    const tweetId = tweetIdFromSlug(row.slug);
    if (!tweetId) continue;
    const fromUrl = handleFromXUrl(row.frontmatter.url) ?? handleFromXUrl(row.frontmatter.source_url) ?? handleFromXUrl(row.frontmatter.source);
    if (fromUrl) {
      addMutation(mutations, row, { x_handle: fromUrl, source_url: sourceUrl(fromUrl, tweetId) }, "1.2 tweet: x_handle from frontmatter X URL");
      continue;
    }
    const fromMention = conservativeMentionHandle(row.compiled_truth);
    if (fromMention) {
      addMutation(mutations, row, { x_handle: fromMention, source_url: sourceUrl(fromMention, tweetId) }, "1.2 tweet: x_handle from single @handle in first 200 chars");
      continue;
    }
    apiCandidates.push(row);
  }

  if (!skipApi) {
    const idByRow = new Map<Row, string>();
    for (const row of apiCandidates) {
      const id = tweetIdFromSlug(row.slug);
      if (id) idByRow.set(row, id);
    }
    const apiHandles = await lookupTweetHandles([...idByRow.values()]);
    for (const [row, id] of idByRow) {
      const handle = apiHandles.get(id);
      if (handle) {
        addMutation(mutations, row, { x_handle: handle, source_url: sourceUrl(handle, id) }, "1.2 tweet: x_handle from X API v2 tweet lookup");
      } else if (row.frontmatter.provenance !== "paraphrase" || row.frontmatter.citation_status !== "missing") {
        addMutation(mutations, row, { provenance: "paraphrase", citation_status: "missing" }, "1.2 tweet: unresolved, marked paraphrase/missing citation");
      }
    }
  }

  const authorRows = await sql<AuthorRow[]>`
    select s.id, s.slug, coalesce(s.compiled_truth, '') as compiled_truth, s.frontmatter,
           p.frontmatter->>'x_handle' as person_handle
    from pages s
    left join pages p on p.slug = s.frontmatter->>'author'
    where s.frontmatter ? 'author'
      and not (s.frontmatter ? 'x_handle')
    order by s.slug
  `;
  const already = new Set(mutations.map((m) => m.id));
  for (const row of authorRows) {
    if (already.has(row.id)) continue;
    const fromUrl = handleFromXUrl(row.frontmatter.source_url) ?? handleFromXUrl(row.frontmatter.source) ?? handleFromXUrl(row.frontmatter.url);
    const fromAuthor = singleAuthorHandle(row.frontmatter.author);
    const fromPerson = validHandle(row.person_handle);
    const handle = fromUrl ?? fromAuthor ?? fromPerson;
    if (!handle) continue;
    const patch: Record<string, string> = { x_handle: handle };
    const statusId = statusIdFromXUrl(row.frontmatter.source_url) ?? statusIdFromXUrl(row.frontmatter.source) ?? statusIdFromXUrl(row.frontmatter.url);
    if (statusId) patch.source_url = sourceUrl(handle, statusId);
    addMutation(mutations, row, patch, fromUrl ? "1.3 author-chain: x_handle from source URL" : fromAuthor ? "1.3 author-chain: x_handle from author field" : "1.3 author-chain: propagated people/<slug>.x_handle");
  }

  const invalid = mutations.filter((m) => m.patch.x_handle && !HANDLE_RE.test(m.patch.x_handle));
  if (invalid.length) {
    console.error("Invalid x_handle patches:", invalid.slice(0, 10));
    process.exit(2);
  }

  const byReason = new Map<string, number>();
  for (const m of mutations) byReason.set(m.reason, (byReason.get(m.reason) ?? 0) + 1);
  console.log("planned mutations by reason:");
  for (const [reason, count] of [...byReason.entries()].sort()) console.log(`${count}\t${reason}`);
  console.log(`planned total=${mutations.length}`);

  if (!live) {
    console.log("Dry-run only. Re-run with --live to apply.");
    process.exit(0);
  }

  await sql.begin(async (tx) => {
    for (const m of mutations) {
      await tx`
        update pages
        set frontmatter = frontmatter || ${sql.json(m.patch)}::jsonb,
            updated_at = now()
        where id = ${m.id}
      `;
    }
  });

  console.log(`applied total=${mutations.length}`);
  const afterRows = await sql<[{ tweet_total: number; tweet_missing: number; author_missing: number; bad_x_handle: number }]>`
    select
      count(*) filter (where slug ~ '^tweet-[0-9]+$')::int as tweet_total,
      count(*) filter (where slug ~ '^tweet-[0-9]+$' and not (frontmatter ? 'x_handle'))::int as tweet_missing,
      count(*) filter (where frontmatter ? 'author' and not (frontmatter ? 'x_handle'))::int as author_missing,
      count(*) filter (where frontmatter ? 'x_handle' and not ((frontmatter->>'x_handle') ~ '^[A-Za-z0-9_]{1,15}$'))::int as bad_x_handle
    from pages
  `;
  printCounts("after", afterRows[0]);
} finally {
  await sql.end({ timeout: 5 });
}
