import type { BrainEngine } from '../engine.ts';
import type { SearchResult, Page } from '../types.ts';

const TOOL_WORKFLOW_LINK_TYPES = new Set([
  'uses_tool',
  'alternative_to',
  'step_in',
  'produces',
]);

export interface TypedEdgeContextOpts {
  depth?: number;
  maxAnchors?: number;
  maxNeighbors?: number;
  sourceId?: string;
  sourceIds?: string[];
}

export async function gatherTypedEdgeNeighborSlugs(
  engine: BrainEngine,
  anchors: string[],
  opts: TypedEdgeContextOpts = {},
): Promise<string[]> {
  const maxAnchors = opts.maxAnchors ?? 5;
  const maxNeighbors = opts.maxNeighbors ?? 20;
  const depth = opts.depth ?? 2;
  const anchorSet = new Set(anchors.filter(Boolean).slice(0, maxAnchors));
  if (anchorSet.size === 0 || maxNeighbors <= 0) return [];

  const slugs = new Set<string>();
  for (const anchor of anchorSet) {
    const paths = await engine.traversePaths(anchor, {
      depth,
      direction: 'both',
      ...(opts.sourceId !== undefined ? { sourceId: opts.sourceId } : {}),
      ...(opts.sourceIds !== undefined ? { sourceIds: opts.sourceIds } : {}),
    });
    for (const path of paths) {
      if (!TOOL_WORKFLOW_LINK_TYPES.has(path.link_type)) continue;
      if (!anchorSet.has(path.from_slug)) slugs.add(path.from_slug);
      if (!anchorSet.has(path.to_slug)) slugs.add(path.to_slug);
      if (slugs.size >= maxNeighbors) return Array.from(slugs);
    }
  }
  return Array.from(slugs);
}

function pageToGraphSearchResult(page: Page, score: number): SearchResult {
  return {
    slug: page.slug,
    page_id: page.id,
    title: page.title,
    type: page.type,
    chunk_text: page.compiled_truth,
    chunk_source: 'compiled_truth',
    chunk_id: 0,
    chunk_index: 0,
    score,
    stale: false,
    source_id: page.source_id,
    effective_date: page.effective_date ? page.effective_date.toISOString().slice(0, 10) : null,
    effective_date_source: page.effective_date_source ?? null,
  };
}

export async function appendTypedEdgeNeighborResults(
  engine: BrainEngine,
  results: SearchResult[],
  opts: TypedEdgeContextOpts = {},
): Promise<SearchResult[]> {
  if (results.length === 0) return results;
  const anchors = results.map(r => r.slug);
  const neighborSlugs = await gatherTypedEdgeNeighborSlugs(engine, anchors, opts);
  if (neighborSlugs.length === 0) return results;

  const seen = new Set(results.map(r => r.slug));
  const appended: SearchResult[] = [];
  const baseScore = results.length > 0
    ? Math.max(0.0001, Math.min(...results.map(r => Number.isFinite(r.score) ? r.score : 0.0001)) * 0.95)
    : 0.0001;

  for (const slug of neighborSlugs) {
    if (seen.has(slug)) continue;
    const page = await engine.getPage(slug, opts.sourceId !== undefined ? { sourceId: opts.sourceId } : undefined);
    if (!page) continue;
    seen.add(slug);
    appended.push(pageToGraphSearchResult(page, baseScore));
  }

  return appended.length > 0 ? [...results, ...appended] : results;
}
