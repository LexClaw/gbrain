import { describe, expect, test } from 'bun:test';
import { isConversationFormatCoverageCandidate } from '../src/commands/doctor.ts';
import type { Page } from '../src/core/types.ts';

function page(overrides: Partial<Page>): Page {
  return {
    id: 1,
    slug: 'meetings/example',
    type: 'meeting',
    title: 'Example',
    compiled_truth: '',
    timeline: '',
    frontmatter: {},
    created_at: new Date('2026-06-18T00:00:00Z'),
    updated_at: new Date('2026-06-18T00:00:00Z'),
    source_id: 'default',
    ...overrides,
  };
}

describe('conversation_format_coverage candidate filtering', () => {
  test('excludes meeting prep briefs from parser coverage denominator', () => {
    expect(
      isConversationFormatCoverageCandidate(
        page({
          title: 'Tim Status Call: June 18, 2026 prep brief',
          frontmatter: {
            status: 'prepared',
            source: 'workspace/briefs/meetings/2026-06-17-tim-status-call.md',
          },
        }),
        '# Tim Status Call\n\n## State\n\nPrepared agenda with no speaker turns.',
      ),
    ).toBe(false);
  });

  test('keeps transcript-like meetings in parser coverage denominator', () => {
    expect(
      isConversationFormatCoverageCandidate(
        page({
          title: 'Voice Call: +177****3508',
          compiled_truth: '**TJ Shedd:** Hello.\n**Caller:** Hi.',
          frontmatter: { status: 'captured' },
        }),
        '**TJ Shedd:** Hello.\n**Caller:** Hi.\n**TJ Shedd:** Good.',
      ),
    ).toBe(true);
  });

  test('keeps non-meeting conversation-like page types', () => {
    expect(isConversationFormatCoverageCandidate(page({ type: 'email' }))).toBe(true);
  });
});
