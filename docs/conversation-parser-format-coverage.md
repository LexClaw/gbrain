# Conversation parser format coverage

Card: `kn78tc8368q2jf826zf6yecban88bspb` — "Conversation format coverage
improvement: 82% no-match rate degrading recall accuracy"

## Summary

`gbrain doctor` flagged `conversation_format_coverage` at 82% no-match
(41/50 sampled pages matched NO built-in pattern). Root cause analysis on
the actual failing corpus found two distinct categories, only one of which
is a real parser gap:

1. **Genuine transcripts in an uncovered format (18 pages)** — voice-server
   call logs and browser `/talk` session transcripts render speaker turns
   as `**Speaker**: text` (bold around the name, colon OUTSIDE the bold,
   no per-line timestamp). No prior built-in covered this: every other
   pattern either requires a time anchor or puts the colon INSIDE the bold
   (`**Name:**` → `bold-name-no-time`). These scored 0 and lost all speaker
   attribution + fact extraction.

2. **Prose meeting-briefs / summary notes (23 pages)** — Zoom AI Companion
   notes and stand-up prep briefs with `## Summary`, `## Key Decisions`,
   `Key Outcomes`, bullet lists. These have NO speaker-turn structure.
   `no_match` is the CORRECT verdict; forcing them to parse would fabricate
   conversation turns from bullet points and corrupt downstream facts.

Note: the doctor labels the sample "conversation pages", but this brain has
zero `conversation`-type pages. The 50 sampled are all `type=meeting`
(the doctor samples conversation/meeting/slack/email, capped 50/type).

## Fix

### New built-in: `bold-name-colon-outside`

Added to `src/core/conversation-parser/builtins.ts`. Deterministically
parses the 18 genuine transcripts. Zero LLM cost, zero hallucination risk.

```
regex:    /^\*\*([^*\[\]]+?)\*\*\s*:\s*(.*)$/
captures: { speaker_group: 1, text_group: 2 }
date_source: frontmatter   (no per-line timestamp → 00:00:00 anchor)
multi_line:  false
quick_reject: /^\*\*/
score_full_body: true      (broad-regex guard; see below)
```

Matches:        `**Lex**: Hey there`  /  `**Caller**: Thank you.`
Source format:  Hit Network voice-server call logs + browser `/talk` sessions

**Non-shadow guarantee** (the safety is in the REGEX, not declaration
order — parse.ts scores every candidate independently, index is only the
tie-break):

- `bold-name-no-time`'s `**Name:**` (colon INSIDE): after the closing `**`
  this regex requires `:`, but `**Name:**` has no colon after the closing
  `**`. Disjoint.
- `bold-paren-time` / `imessage-slack`'s `**Name** (time):`: after the
  closing `**` comes ` (`, not `:`. Disjoint.
- `telegram-bracket`'s `**[18:37] Name:**`: the `[^*\[\]]` speaker class
  excludes `[`, so a bracketed speaker never matches. Disjoint.

**Broad-regex guard** (`score_full_body: true`): `**Word**: text` is also a
common prose idiom (`**Status**:`, `**Owner**:`). A notes page with a few
such lines clustered in its head would score 0.3 on the head pass, skip the
`< SCORING_HEAD_TRIGGER_THRESHOLD` rescore, and clear the 0.05 acceptance
floor — mis-parsing prose as a conversation. `score_full_body` recomputes
the winner's score over the FULL body before the floor, so such a page
falls to `no_match` (3/83 ≈ 0.036 < 0.05) while a real transcript stays
well above it. Same mechanism as `bold-name-no-time`.

### LLM fallback enabled (opt-in)

```
gbrain config set conversation_parser.llm_fallback_enabled true
```

Written to the DB plane, where `parseConversationAsync` → `isLlmFallbackEnabled`
reads it via `engine.getConfig`. The fallback model is `openai:gpt-4o-mini`
(utility tier, cheap), gated by an active BudgetTracker. On THIS corpus the
fallback adds little: the remaining 23 no_match pages are prose summaries
with no turns to recover, so the deterministic pattern is what actually
moved the metric. Fallback is a safety net for future unseen transcript
shapes that the built-ins miss.

## Result

| Metric                          | Before | After |
|---------------------------------|--------|-------|
| no_match rate (doctor sample)   | 82.0%  | 46.0% |
| `bold-name-colon-outside` hits  | 0      | 18    |
| `bold-name-no-time` hits        | 9      | 9     |
| genuine transcripts unparsed    | 18     | 0     |

The remaining 23 no_match are all prose meeting-briefs (16 Zoom AI
Companion summaries + 7 stand-up prep briefs). They have no speaker turns;
`no_match` is correct. The doctor check stays `warn` only because its
threshold is `>10%` no-match, not because of a remaining parser gap.

## Candidate patterns for future built-in additions

If a corpus later contains transcripts in these shapes (none present in
the current brain, so NOT added — would be speculative), they are the next
candidates:

- **Plain `Speaker: text`** (no bold) — risky: collides with prose `Label:
  value` lines. Would need a strong density + speaker-allowlist guard.
- **`[HH:MM:SS] Speaker: text`** (bracketed leading timestamp, non-Matrix)
  — generic IRC/log shape; `matrix-element` covers the `@user:server`
  variant only.
- **Zoom AI Companion structured-notes → facts**: the 23 prose pages are
  better served by the `extract-conversation-facts` summary path than by
  the turn parser. They are correctly out of scope for format coverage.

## Files

- `src/core/conversation-parser/builtins.ts` — new pattern + count comments.
- `src/commands/conversation-parser.ts` — stale count comment fixed.
- `test/conversation-parser/parse.test.ts` — 5 new tests (parse, voice-call
  shape, 2 disjointness regressions, prose-guard).
