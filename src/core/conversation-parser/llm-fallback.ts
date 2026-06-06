/**
 * v0.41.16.0 — LLM fallback for the conversation parser.
 *
 * When every regex pattern matches 0 lines on a page, AND the user
 * has explicitly opted in via
 * `gbrain config set conversation_parser.llm_fallback_enabled true`
 * (D15: opt-IN by default for PRIVACY of chat logs), AND a budget
 * tracker is active, the orchestrator calls this to ask Haiku to
 * parse the body directly.
 *
 * Per D17 (codex outside voice): NO regex inference, NO persistence
 * to a separate inferred-patterns table. The LLM returns parsed
 * messages for THIS page only; cache hits by content_hash so re-runs
 * are free. Different page with same format = LLM gets called again.
 *
 * Adversarial-input contract: when the body is NOT chat-shaped
 * (README, code, recipe, lyrics), Haiku is instructed to return `[]`.
 * The orchestrator treats `[]` as "skip this page" — no fact
 * extraction. Caught by the adversarial fixture set in the nightly
 * probe.
 */

import { runLlmCall, parseLlmJson, type ChatTransport } from './llm-base.ts';
import type { BrainEngine } from '../engine.ts';
import type { MatchedMessage } from './types.ts';

const FALLBACK_SYSTEM_PROMPT = `You parse messages out of a chat-log body. The body may be from any chat platform (iMessage, Slack, Telegram, Discord, WhatsApp, Signal, IRC, Matrix, Teams, email-thread, Hermes session archive, etc.).

Return a JSON array of message objects. Each object has these fields:
  - speaker:   The display name of the message author. Strip emoji
               prefixes and platform decorations. Lowercase or
               capitalized to match how the name appears.
  - timestamp: ISO 8601 timestamp. If the body has time-only
               timestamps and no date is supplied here, use
               YYYY-MM-DDTHH:MM:00Z with the date set to
               1970-01-01.
  - text:      The message body. Multi-line messages join with '\\n'.
               Strip platform decorations like reaction blocks,
               attachment placeholders, "(edited)" markers.

Skip system messages ("Alice joined", "Bob left"), reactions on
prior messages, and notification footers.

Hermes session archives are chat logs even when they contain markdown
sections such as "## Corrections / Frustrations", "## Directives / Rules",
and "## Full Conversation". In those archives, role markers like
"**USER **" and "**ASSISTANT **" begin messages. Treat USER and
ASSISTANT as speakers, and parse the text under each marker until the
next role marker.

Skill-invocation wrappers and context-compaction summaries embedded in
USER turns are still conversation content: extract the surrounding
role-marked turns. Only return [] when there are genuinely NO
role-marked conversation turns at all.

IF THE BODY IS NOT A CHAT LOG (e.g. it's a README, code file,
recipe, song lyrics, log file with no speakers), return [].

Output ONLY the JSON array. No prose, no markdown fences.`;

export interface RunLlmFallbackOpts {
  modelStr: string;
  /** Page body to parse. */
  body: string;
  /** Sample size — only first N non-empty lines sent to Haiku.
   *  Default 200 (full page) for fallback since regex saw zero. */
  sampleLines?: number;
  /** Caller's abort signal. */
  signal?: AbortSignal;
  /** Engine for DB cache (optional). */
  engine?: BrainEngine;
  /** Test seam. */
  chatTransport?: ChatTransport;
}

/**
 * Returns parsed messages OR null on any failure (fail-open).
 * Returns `[]` when LLM explicitly signals "this isn't a chat log."
 */
export async function runLlmFallback(
  opts: RunLlmFallbackOpts,
): Promise<MatchedMessage[] | null> {
  const body = prepareFallbackBody(opts.body);
  const lines = body.split(/\r?\n/);
  const sampleN = opts.sampleLines ?? 200;
  // For fallback, send up to N non-empty lines (vs polish which gets
  // the full body + the regex output).
  const sampled = lines
    .filter((l) => l.trim().length > 0)
    .slice(0, sampleN)
    .join('\n');

  return runLlmCall<MatchedMessage[]>({
    shape: 'fallback',
    modelStr: opts.modelStr,
    content: sampled,
    system: FALLBACK_SYSTEM_PROMPT,
    signal: opts.signal,
    engine: opts.engine,
    chatTransport: opts.chatTransport,
    parse: (text) => {
      const parsed = parseLlmJson<unknown[]>(text, { array: true });
      if (parsed === null) return null;
      // Validate shape: every element has speaker (string), timestamp (string), text (string).
      const out: MatchedMessage[] = [];
      for (const item of parsed) {
        if (
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { speaker?: unknown }).speaker === 'string' &&
          typeof (item as { timestamp?: unknown }).timestamp === 'string' &&
          typeof (item as { text?: unknown }).text === 'string'
        ) {
          const m = item as { speaker: string; timestamp: string; text: string };
          out.push({
            speaker: m.speaker.trim(),
            timestamp: m.timestamp,
            text: m.text,
          });
        }
      }
      return out;
    },
  });
}

/**
 * Keep fallback privacy/cost bounded by sending only chat-shaped material.
 * Hermes session archives start with frontmatter, skill dumps, corrections,
 * and directives before the actual transcript. If we send the first 200
 * non-empty lines verbatim, Haiku often sees governance markdown instead of
 * role turns and correctly returns [] under the adversarial contract. For
 * archive-shaped bodies, trim to the Full Conversation role blocks first.
 */
function prepareFallbackBody(body: string): string {
  if (!body.includes('## Full Conversation')) return body;
  const start = body.indexOf('## Full Conversation');
  const transcript = body.slice(start);
  if (!/^\*\*(USER|ASSISTANT|SYSTEM|TOOL)\b/m.test(transcript)) return body;

  const blocks: string[] = [];
  const substantiveBlocks: string[] = [];
  const roleRx = /^\*\*(USER|ASSISTANT|SYSTEM|TOOL)\b[^\n]*$/gim;
  const matches = Array.from(transcript.matchAll(roleRx));
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const role = (m[1] ?? '').toUpperCase();
    if (role === 'SYSTEM' || role === 'TOOL') continue;
    const blockStart = m.index ?? 0;
    const blockEnd = i + 1 < matches.length ? matches[i + 1].index ?? transcript.length : transcript.length;
    const raw = transcript.slice(blockStart, blockEnd).trim();
    if (!raw) continue;
    const clipped = raw.slice(0, 4000);
    blocks.push(clipped);
    // LEX-FORK B-FIX-1: sample substantive turns, not skill-doc/context preambles.
    if (!isLowValueHermesPreambleBlock(raw, role)) substantiveBlocks.push(clipped);
  }

  const selected = substantiveBlocks.length >= 2 ? substantiveBlocks : blocks;
  return selected.length > 0 ? selected.slice(0, 20).join('\n\n') : body;
}

function isLowValueHermesPreambleBlock(block: string, role: string): boolean {
  if (role !== 'USER') return false;
  const body = stripRoleMarker(block).trimStart();
  if (body.startsWith('[IMPORTANT: The user has invoked the "')) return true;
  if (body.startsWith('[CONTEXT COMPACTION')) return true;
  return hasMostlyDocumentStructure(body);
}

function stripRoleMarker(block: string): string {
  return block.replace(/^\*\*(USER|ASSISTANT)\b[^\n]*\n?/i, '');
}

function hasMostlyDocumentStructure(body: string): boolean {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 10) return false;

  let documentLines = 0;
  let proseLines = 0;
  let inYamlFrontmatter = lines[0] === '---';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (i === 0 && line === '---') {
      documentLines++;
      continue;
    }
    if (inYamlFrontmatter) {
      documentLines++;
      if (line === '---') inYamlFrontmatter = false;
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      documentLines++;
      continue;
    }
    if (/^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      documentLines++;
      continue;
    }
    if (/^[A-Za-z0-9_-]+:\s+/.test(line)) {
      documentLines++;
      continue;
    }
    if (/^```/.test(line) || /^<!--/.test(line) || /^\|/.test(line)) {
      documentLines++;
      continue;
    }
    if (/[.!?]["')\]]?$/.test(line) && line.split(/\s+/).length >= 6) proseLines++;
  }

  return documentLines / lines.length > 0.9 && proseLines === 0;
}
