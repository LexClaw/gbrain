/**
 * v0.32.2 — extract_facts cycle phase.
 *
 * Reconciles the facts DB index from the `## Facts` fence on each
 * entity page. Runs between the `extract` phase (which materializes
 * links + timeline) and `recompute_emotional_weight` so emotional
 * weight sees fresh take + fact state.
 *
 * Source-of-truth contract: the fence is canonical. For each page in
 * the affected slug set, this phase:
 *   1. Reads the markdown body (DB-side fetch via engine.getPage).
 *   2. Parses the `## Facts` fence with parseFactsFence.
 *   3. Maps ParsedFact → FenceExtractedFact via extractFactsFromFenceText.
 *   4. Wipes the page's DB index via deleteFactsForPage.
 *   5. Re-inserts via engine.insertFacts batch.
 *
 * After the phase, the DB index for every affected page byte-matches
 * the fence (modulo embeddings + runtime-derived fields). Pages with
 * no fence go through delete-then-empty-insert — DB rows for that
 * page coordinate are wiped; legacy NULL-source_markdown_slug rows
 * survive because deleteFactsForPage targets source_markdown_slug =
 * slug only.
 *
 * Empty-fence guard (Codex R2-#7): the phase refuses to do its
 * destructive reconciliation pass when legacy rows (row_num IS NULL,
 * entity_slug IS NOT NULL) still exist in the brain — they're the
 * v0.31 hot-memory facts pending the v0_32_2 backfill. Status returns
 * `warn` with a hint to run `gbrain apply-migrations --yes`. Without
 * the guard, an interrupted upgrade where v0_32_2 hasn't run could
 * leave the cycle silently misreporting "0 facts on people/alice"
 * while legacy rows linger in the DB.
 */

import type { BrainEngine } from '../engine.ts';
import { writeReceipt } from '../extract/receipt-writer.ts';
import { upsertExtractRollup } from '../extract/rollup-writer.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { extractFactsFromFenceText } from '../facts/extract-from-fence.ts';
import {
  runPhantomRedirectPass,
  emptyPhantomPassResult,
  type PhantomPassResult,
} from './phantom-redirect.ts';
import { embed, isAvailable } from '../ai/gateway.ts';

/**
 * Full-walk page batch size for the autopilot extract_facts phase.
 *
 * Pre-fix, the full-walk path called getAllSlugs() and materialized the entire
 * slug set before fetching pages one-by-one. On the live 69K-page brain that
 * kept the whole job's page index alive for the duration of extract_facts and
 * contributed to steady-state RSS above the 10GB watchdog. This cap bounds the
 * job-level working set to one listPages() batch at a time.
 */
export const DEFAULT_EXTRACT_FACTS_BATCH_SIZE = 250;
export const MIN_EXTRACT_FACTS_BATCH_SIZE = 1;
export const MAX_EXTRACT_FACTS_BATCH_SIZE = 1000;
const EXTRACT_FACTS_BATCH_SIZE_CONFIG_KEY = 'cycle.extract_facts.batch_size';
const EXTRACT_FACTS_BATCH_SIZE_ENV = 'GBRAIN_EXTRACT_FACTS_BATCH_SIZE';

export interface ExtractFactsOpts {
  /** Subset of slugs to reconcile. undefined = walk every page in the brain. */
  slugs?: string[];
  /** Dry-run: parse + count, no DB writes. */
  dryRun?: boolean;
  /** Optional source_id override for multi-source brains. Default 'default'. */
  sourceId?: string;
  /**
   * v0.35.5 (codex #10): brain directory for the phantom-redirect pre-pass.
   * The phantom handler needs disk access to append migrated fence rows
   * to canonical pages and to unlink phantom `.md` files. When omitted,
   * the phantom-redirect pass is skipped (callers like `gbrain dream`
   * that don't have a brainDir, e.g. headless eval runs, still get the
   * standard fence-reconcile loop).
   */
  brainDir?: string;
}

export interface ExtractFactsResult {
  pagesScanned: number;
  /** Number of listPages batches processed during a full-walk run. */
  batchesProcessed: number;
  /** Effective full-walk batch size. Null when a caller supplied explicit slugs. */
  batchSize: number | null;
  pagesWithFacts: number;
  factsInserted: number;
  factsDeleted: number;
  legacyRowsPending: number;
  guardTriggered: boolean;
  warnings: string[];
  /** v0.35.5: phantom-redirect pre-pass counts. */
  phantomsScanned: number;
  phantomsRedirected: number;
  phantomsAmbiguous: number;
  phantomsSkippedDrift: number;
  phantomsLockBusy: boolean;
  phantomsMorePending: boolean;
}

/**
 * Run the extract_facts phase against the current brain state. Returns
 * an ExtractFactsResult envelope; status mapping (ok / warn / fail)
 * happens in the cycle.ts caller.
 */
export async function runExtractFacts(
  engine: BrainEngine,
  opts: ExtractFactsOpts = {},
): Promise<ExtractFactsResult> {
  const sourceId = opts.sourceId ?? 'default';
  const result: ExtractFactsResult = {
    pagesScanned: 0,
    batchesProcessed: 0,
    batchSize: null,
    pagesWithFacts: 0,
    factsInserted: 0,
    factsDeleted: 0,
    legacyRowsPending: 0,
    guardTriggered: false,
    warnings: [],
    phantomsScanned: 0,
    phantomsRedirected: 0,
    phantomsAmbiguous: 0,
    phantomsSkippedDrift: 0,
    phantomsLockBusy: false,
    phantomsMorePending: false,
  };

  // ── Empty-fence guard (Codex R2-#7) ────────────────────────────
  // Pre-check: if any legacy fact rows exist (row_num NULL but
  // entity_slug NOT NULL), refuse to run the destructive
  // reconciliation pass. The v0_32_2 orchestrator must complete
  // first.
  const legacy = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*) AS n FROM facts WHERE row_num IS NULL AND entity_slug IS NOT NULL`,
  );
  const legacyCount = parseInt(legacy[0]?.n ?? '0', 10);
  result.legacyRowsPending = legacyCount;
  if (legacyCount > 0) {
    result.guardTriggered = true;
    result.warnings.push(
      `extract_facts: ${legacyCount} legacy v0.31 fact rows pending fence backfill. ` +
      `Run \`gbrain apply-migrations --yes\` to complete v0_32_2 before this phase ` +
      `can safely reconcile fence → DB.`,
    );
    return result;
  }

  // ── v0.35.5: phantom-redirect pre-pass ──────────────────────────
  //
  // Runs BEFORE the main reconcile loop so canonical pages are consistent
  // (compiled_truth + DB facts + content_hash) by the time the loop visits
  // them. Skipped when brainDir is undefined — the redirect handler needs
  // disk access to write canonical fences and unlink phantom `.md` files.
  // Idempotency-by-construction: phantom predicate filters out `deleted_at
  // IS NOT NULL` so a half-redirected page (soft-deleted, .md still on
  // disk) won't be re-redirected.
  let phantomResult: PhantomPassResult = emptyPhantomPassResult();
  if (opts.brainDir) {
    try {
      phantomResult = await runPhantomRedirectPass(
        engine,
        opts.brainDir,
        sourceId,
        opts.dryRun ?? false,
      );
    } catch (e) {
      // The pass owns its own per-phantom try/catch; reaching this catch
      // means the lock acquisition or the over-arching SQL query failed.
      // Surface as a warning, leave counters zero — main reconcile continues.
      const msg = e instanceof Error ? e.message : String(e);
      result.warnings.push(`phantom_redirect_pass_failed: ${msg.slice(0, 200)}`);
    }
  }
  result.phantomsScanned = phantomResult.scanned;
  result.phantomsRedirected = phantomResult.redirected;
  result.phantomsAmbiguous = phantomResult.ambiguous;
  result.phantomsSkippedDrift = phantomResult.skipped_drift;
  result.phantomsLockBusy = phantomResult.lock_busy;
  result.phantomsMorePending = phantomResult.more_pending;

  // ── Resolve target slug set ───────────────────────────────────
  // v0.36.x #1096: presence — not length — distinguishes the modes.
  // `slugs: []` from an incremental sync no-op was previously treated
  // identically to `slugs: undefined` (full-walk intent) because
  // `opts.slugs && opts.slugs.length > 0` is falsy for both. On a
  // multi-thousand-page brain the unintended full walk exceeds the
  // autopilot-cycle timeout (~600s) and dead-letters the job.
  let slugs: string[] | undefined;
  if (opts.slugs !== undefined) {
    // Caller explicitly passed a list (possibly empty). Empty array is a
    // real incremental no-op; don't escalate to full-brain walk.
    slugs = opts.slugs;
  } else {
    // Full walk streams below via listPages({limit, offset, sort:'slug'}).
    // Do NOT materialize every slug in the brain here.
    slugs = undefined;
  }
  // v0.35.5: union the canonicals touched by the phantom-redirect pass
  // so their DB facts get reconciled from the just-merged disk fence.
  // Without this, an incremental-mode cycle with phantom-but-not-canonical
  // in opts.slugs would leave canonical's DB facts stale until next full
  // walk (codex A1 — the round-14 risk specialized to scenario B).
  if (phantomResult.touched_canonicals.length > 0) {
    const slugSet = new Set(slugs ?? []);
    for (const c of phantomResult.touched_canonicals) slugSet.add(c);
    slugs = Array.from(slugSet);
  }

  // ── Reconcile each page ───────────────────────────────────────
  const reconcilePage = async (page: Awaited<ReturnType<BrainEngine['getPage']>>): Promise<void> => {
    if (!page) return;
    const slug = page.slug;
    result.pagesScanned += 1;

    const body = page.compiled_truth ?? '';
    const parsed = parseFactsFence(body);
    if (parsed.warnings.length > 0) {
      result.warnings.push(
        ...parsed.warnings.map(w => `${slug}: ${w}`),
      );
    }

    if (parsed.facts.length > 0) result.pagesWithFacts += 1;

    if (opts.dryRun) return;

    // Wipe-and-reinsert per page. The deleteFactsForPage call targets
    // source_markdown_slug = slug only, so NULL-source_markdown_slug
    // legacy rows survive (the partial-UNIQUE-index keyspace).
    const deleted = await engine.deleteFactsForPage(slug, sourceId);
    result.factsDeleted += deleted.deleted;

    if (parsed.facts.length === 0) return;

    // v0.35.4 (D-ENG-1) — thread page.effective_date as the fallback
    // valid_from. Without this, fence rows without explicit `validFrom:`
    // land with `valid_from = now()` (import timestamp) and every
    // trajectory query against the page returns import dates instead of
    // claim dates.
    const pageEffectiveDate = page.effective_date ? new Date(page.effective_date) : null;
    const extracted = extractFactsFromFenceText(parsed.facts, slug, sourceId, { pageEffectiveDate });

    // v0.35.4 (D-CDX-3) — batch-embed before insert. Without this,
    // cycle-inserted facts land with `embedding = NULL`, which breaks
    // consolidate's cosine clustering AND the drift_score formula in
    // find_trajectory. Falls open: if the embedding gateway is
    // unavailable (no API key configured), facts still insert with
    // NULL embeddings — drift_score gracefully returns null and
    // clustering falls back to recency.
    if (isAvailable('embedding') && extracted.length > 0) {
      try {
        const texts = extracted.map(e => e.fact);
        const embeddings = await embed(texts);
        // Defensive: embed should return one vector per input; if the
        // gateway returns a partial array (provider partial-batch retry
        // returning fewer than requested), only fill what we have.
        for (let i = 0; i < extracted.length && i < embeddings.length; i++) {
          extracted[i].embedding = embeddings[i];
        }
      } catch (err) {
        // Embedding failure is non-fatal — facts still get inserted, just
        // without embeddings. Cycle phase status stays 'ok'.
        result.warnings.push(
          `${slug}: extract_facts batch embed failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const inserted = await engine.insertFacts(extracted, { source_id: sourceId }); // gbrain-allow-direct-insert: extract_facts cycle phase reconciles fence → DB
    result.factsInserted += inserted.inserted;
  };

  if (slugs !== undefined) {
    for (const slug of slugs) {
      const page = await engine.getPage(slug, { sourceId });
      // Slug listed but not in DB — skip silently. The next cycle will pick it
      // up if it exists.
      await reconcilePage(page);
    }
  } else {
    const batchSize = await resolveExtractFactsBatchSize(engine);
    result.batchSize = batchSize;
    let offset = 0;
    // Stable slug-order pagination. This is safe because the loop mutates facts
    // rows, not pages rows; the best-effort receipt page is written after the
    // walk completes.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await engine.listPages({
        sourceId,
        limit: batchSize,
        offset,
        sort: 'slug',
      });
      if (batch.length === 0) break;
      result.batchesProcessed += 1;
      for (const page of batch) {
        await reconcilePage(page);
      }
      offset += batch.length;
      if (batch.length < batchSize) break;
    }
  }

  // v0.42 Wave B3: receipt + rollup. extract_facts is deterministic
  // (fence reconcile, no LLM cost); receipt only when facts were
  // actually inserted; rollup always fires.
  if (!opts.dryRun && result.factsInserted > 0) {
    const runId = `efacts-${Date.now().toString(36)}-${sourceId.slice(0, 4)}`;
    try {
      await writeReceipt(engine, {
        kind: 'facts.fence',
        source_id: sourceId,
        run_id: runId,
        round: 'single',
        extracted_at: new Date().toISOString(),
        total_rows: result.factsInserted,
        cost_usd: 0,
        summary:
          `Reconciled ${result.factsInserted} facts (and deleted ${result.factsDeleted}) ` +
          `across ${result.pagesScanned} scanned pages.`,
      });
    } catch (err) {
      console.error(`[extract_facts] receipt write failed: ${(err as Error).message}`);
    }
  }
  if (!opts.dryRun) {
    await upsertExtractRollup(engine, {
      kind: 'facts.fence',
      source_id: sourceId,
      cost_delta: 0,
      round_completed_delta: result.guardTriggered ? 0 : 1,
      halt_delta: result.guardTriggered ? 1 : 0,
    });
  }

  return result;
}

async function resolveExtractFactsBatchSize(engine: BrainEngine): Promise<number> {
  const fromEnv = parseBatchSize(process.env[EXTRACT_FACTS_BATCH_SIZE_ENV]);
  if (fromEnv !== null) return fromEnv;
  try {
    const fromConfig = parseBatchSize(await engine.getConfig(EXTRACT_FACTS_BATCH_SIZE_CONFIG_KEY));
    if (fromConfig !== null) return fromConfig;
  } catch {
    // Config read is best-effort; default remains bounded.
  }
  return DEFAULT_EXTRACT_FACTS_BATCH_SIZE;
}

function parseBatchSize(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const whole = Math.floor(n);
  if (whole < MIN_EXTRACT_FACTS_BATCH_SIZE) return MIN_EXTRACT_FACTS_BATCH_SIZE;
  if (whole > MAX_EXTRACT_FACTS_BATCH_SIZE) return MAX_EXTRACT_FACTS_BATCH_SIZE;
  return whole;
}
