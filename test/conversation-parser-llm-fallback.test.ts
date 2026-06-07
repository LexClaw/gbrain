/**
 * LEX-FORK: regression coverage for wiring Garry's T4 LLM fallback into
 * the async conversation-parser path for Hermes session archive pages.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseConversation, parseConversationAsync } from '../src/core/conversation-parser/parse.ts';
import { withBudgetTracker } from '../src/core/ai/gateway.ts';
import { BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import type { ChatTransport } from '../src/core/conversation-parser/llm-base.ts';

const SESSION_FIXTURE = readFileSync(
  new URL('./fixtures/conversation-parser/hermes-session-archive-39d867.md', import.meta.url),
  'utf8',
);

const ZERO_FACT_SESSION_FIXTURE = readFileSync(
  new URL('./fixtures/conversation-parser/hermes-session-archive-3d1468.md', import.meta.url),
  'utf8',
);

describe('conversation parser LLM fallback', () => {
  test('synchronous parser remains regex-only for Hermes session archives', () => {
    const result = parseConversation(SESSION_FIXTURE, {
      diagnostic: true,
      noFallback: true,
    });
    expect(result.phase).toBe('no_match');
    expect(result.messages).toHaveLength(0);
  });

  test('async parser uses opt-in fallback and extracts Hermes session messages', async () => {
    const transport: ChatTransport = async (opts) => {
      // prepareFallbackBody trims to the role-marked transcript turns and
      // drops the governance preamble (## Corrections / Frustrations) AND the
      // ## Full Conversation header itself — the LLM receives the turns, not
      // the section header. Assert on the turn markers, not the header.
      expect(opts.messages[0]?.content).toContain('**USER **');
      expect(opts.messages[0]?.content).toContain('**ASSISTANT');
      expect(opts.messages[0]?.content).not.toContain('## Corrections / Frustrations');
      return {
        text: JSON.stringify([
          {
            speaker: 'USER',
            timestamp: '2026-05-19T23:03:00Z',
            text: 'Please verify the CLI surface before filing the card.',
          },
          {
            speaker: 'ASSISTANT',
            timestamp: '2026-05-19T23:04:00Z',
            text: 'I will probe the live state before acting.',
          },
        ]),
        blocks: [],
        stopReason: 'end',
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        model: 'anthropic:claude-haiku-4-5-20251001',
        providerId: 'anthropic',
      };
    };
    const engine = {
      getConfig: async (key: string) =>
        key === 'conversation_parser.llm_fallback_enabled' ? 'true' : null,
    };
    const tracker = new BudgetTracker({ maxCostUsd: 0.5, label: 'test' });
    const result = await withBudgetTracker(tracker, () =>
      parseConversationAsync(SESSION_FIXTURE, {
        diagnostic: true,
        engine: engine as never,
        chatTransport: transport,
      }),
    );

    expect(result.phase).toBe('llm_fallback');
    expect(result.llm_fallback_model).toBe('anthropic:claude-haiku-4-5-20251001');
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[0]?.speaker).toBe('USER');
  });

  test('fallback samples substantive Hermes turns instead of skill-doc preambles', async () => {
    const transport: ChatTransport = async (opts) => {
      const content = opts.messages[0]?.content ?? '';
      expect(content).not.toContain('[IMPORTANT: The user has invoked the "overnight-wave" skill');
      expect(content).not.toContain('[CONTEXT COMPACTION');
      expect(content).toContain('Wave 2 Execution Summary - COMPLETE');
      expect(content).toContain('Strategic-Consulting Skill Pre-Load Pattern');
      expect(opts.system).toContain('Skill-invocation wrappers and context-compaction summaries embedded in');
      expect(opts.system).toContain('Only return [] when there are genuinely NO');
      return {
        text: JSON.stringify([
          {
            speaker: 'ASSISTANT',
            timestamp: '1970-01-01T00:00:00Z',
            text: 'Wave 2 Execution Summary - COMPLETE',
          },
        ]),
        blocks: [],
        stopReason: 'end',
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        model: 'anthropic:claude-haiku-4-5-20251001',
        providerId: 'anthropic',
      };
    };
    const engine = {
      getConfig: async (key: string) =>
        key === 'conversation_parser.llm_fallback_enabled' ? 'true' : null,
    };
    const tracker = new BudgetTracker({ maxCostUsd: 0.5, label: 'test' });
    const result = await withBudgetTracker(tracker, () =>
      parseConversationAsync(ZERO_FACT_SESSION_FIXTURE, {
        diagnostic: true,
        engine: engine as never,
        chatTransport: transport,
      }),
    );

    expect(result.phase).toBe('llm_fallback');
    expect(result.messages).toHaveLength(1);
  });

  test('fallback parses fenced JSON arrays from model output', async () => {
    const transport: ChatTransport = async () => ({
      text: '```json\n[{"speaker":"USER","timestamp":"1970-01-01T00:00:00Z","text":"fenced JSON should parse"}]\n```',
      blocks: [],
      stopReason: 'end',
      usage: {
        input_tokens: 20,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      model: 'anthropic:claude-haiku-4-5-20251001',
      providerId: 'anthropic',
    });
    const engine = {
      getConfig: async (key: string) =>
        key === 'conversation_parser.llm_fallback_enabled' ? 'true' : null,
    };
    const tracker = new BudgetTracker({ maxCostUsd: 0.5, label: 'test' });
    const result = await withBudgetTracker(tracker, () =>
      parseConversationAsync('## Full Conversation\n\n**USER **\nfenced JSON smoke', {
        diagnostic: true,
        engine: engine as never,
        chatTransport: transport,
      }),
    );

    expect(result.phase).toBe('llm_fallback');
    expect(result.messages[0]?.text).toBe('fenced JSON should parse');
  });

  test('fallback returns [] for non-chat bodies without producing messages', async () => {
    const transport: ChatTransport = async () => ({
      text: '[]',
      blocks: [],
      stopReason: 'end',
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      model: 'anthropic:claude-haiku-4-5-20251001',
      providerId: 'anthropic',
    });
    const engine = {
      getConfig: async (key: string) =>
        key === 'conversation_parser.llm_fallback_enabled' ? 'true' : null,
    };
    const tracker = new BudgetTracker({ maxCostUsd: 0.5, label: 'test' });
    const result = await withBudgetTracker(tracker, () =>
      parseConversationAsync('# README\n\nThis is not a chat transcript.', {
        engine: engine as never,
        chatTransport: transport,
      }),
    );

    expect(result.phase).toBe('no_match');
    expect(result.messages).toHaveLength(0);
    expect(result.llm_fallback_model).toBe('anthropic:claude-haiku-4-5-20251001');
  });
});
