import { describe, expect, test } from 'bun:test';
import { buildContentSanityAuditCheck } from '../src/commands/doctor.ts';
import {
  summarizeContentSanityEvents,
  type ContentSanityAuditEvent,
} from '../src/core/audit/content-sanity-audit.ts';

function event(
  event_type: ContentSanityAuditEvent['event_type'],
  reason: string,
): ContentSanityAuditEvent {
  return {
    ts: '2026-08-01T00:00:00.000Z',
    event_type,
    slug: 'code/large-file',
    source_id: 'default',
    bytes: 600_000,
    junk_pattern_matches: [],
    literal_substring_matches: [],
    reason_messages: [reason],
  };
}

describe('buildContentSanityAuditCheck', () => {
  test('oversize-only volume warns and summarizes reason codes', () => {
    const events = [
      ...Array.from({ length: 60 }, () => event('soft_block', 'PAGE_OVERSIZED: body 600000 bytes')),
      ...Array.from({ length: 40 }, () => event('warn', 'PAGE_OVERSIZE_WARN: body 100000 bytes')),
    ];

    const summary = summarizeContentSanityEvents(events);
    const check = buildContentSanityAuditCheck(summary);

    expect(summary.top_reasons).toEqual([
      { name: 'PAGE_OVERSIZED', count: 60 },
      { name: 'PAGE_OVERSIZE_WARN', count: 40 },
    ]);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('reasons: PAGE_OVERSIZED=60, PAGE_OVERSIZE_WARN=40');
  });

  test('one hard event fails among 100 oversize warnings', () => {
    const events = [
      ...Array.from({ length: 100 }, () => event('warn', 'PAGE_OVERSIZE_WARN: body 100000 bytes')),
      event('hard_block', 'PAGE_JUNK_PATTERN: matched access_denied'),
    ];

    const check = buildContentSanityAuditCheck(summarizeContentSanityEvents(events));

    expect(check.status).toBe('fail');
    expect(check.message).toContain('hard=1');
  });
});
