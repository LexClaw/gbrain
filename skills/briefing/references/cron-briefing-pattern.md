# Autonomous Cron Briefing Pattern

Validated execution pattern for morning briefings running via cron/autonomous context. Derived from successful 2026-05-18 execution following `gbrain-cron-ops` skill.

## Prerequisites

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd ~/gbrain
```

Always set PATH and working directory before gbrain commands in cron context.

## Execution Sequence

### 1. Check for Held Messages (overnight cron outputs)
```bash
ls -la /tmp/cron-held/ 2>/dev/null
```
- Process any .md files: read content verbatim under sub-heading naming originating job
- Remove processed files: `rm /tmp/cron-held/*.md`
- Confirm cleanup: directory should show only `archived/` subdirectory

### 2. Brain Health Baseline
```bash
gbrain stats
gbrain doctor --json
```
- Lead with growth metrics (pages, links, timeline counts)
- Extract health score and coverage percentages
- Note any warnings requiring attention

### 3. People in Play (Top 5 Analysis)
```bash
gbrain list --type person -n 10
```
- For top 5 most recently updated: `gbrain get <slug>`
- Extract: who they are, why active now, recent timeline context
- Explicitly note any coverage gaps ("No brain page for X")

### 4. Active Intelligence Queries
```bash
gbrain query "active deals status"
gbrain query "pending commitments follow-ups"
gbrain query "meetings this week"
```
- **Timeout handling**: If queries timeout, fall back to simpler searches
- Report timeout issues explicitly: "Query timeout affecting deal visibility"

### 5. Recent Activity Context
```bash
gbrain list --limit 20 --sort updated
```
- Focus on last 24h changes
- Identify content themes, new entity creation
- Note intelligence synthesis patterns

## Output Format (Autonomous Context)

```
DAILY BRIEFING -- [day, month date, year]
========================

**BRAIN HEALTH SUMMARY**
[stats summary with key metrics]

**OVERNIGHT UPDATES**
[held message content or "No held messages"]

**PEOPLE IN PLAY**
[top 5 with context and sources]

**ACTIVE DEALS & PROJECTS** 
[query results with specific card/deadline context]

**RECENT INTELLIGENCE (24h)**
[synthesis themes, new ingestions, coverage expansion]

**BRAIN COVERAGE GAPS**
[explicitly noted gaps and enrichment suggestions]

**SYSTEM STATUS**
[health score, any issues, maintenance notes]
```

## Critical Rules for Cron Context

1. **No em dashes**: Use commas, colons, or parentheses instead (TJ hard rule)
2. **Self-contained execution**: No clarifying questions, autonomous decisions only
3. **Coverage gaps explicit**: Never hide ignorance, always surface missing context
4. **Delta-based health**: Compare against baselines, not just absolute numbers
5. **Source citations**: Include slug and update date for all factual claims

## Timeout Recovery

When `gbrain query` times out (large brain, complex queries):
- Fall back to `gbrain search "<topic>" --limit 5`
- Report timeout explicitly in briefing
- Use simpler retrieval patterns: `gbrain list --type <type> -n 10`

## Integration with GBrain-Cron-Ops

This pattern implements the "Morning Briefing Integration Pattern (May 6-10, 2026)" from `gbrain-cron-ops` skill:
- Held message processing for overnight autonomous work visibility
- Brain health metrics as briefing foundation  
- Environment setup for GBrain CLI in cron context
- Em dash enforcement in human-facing output
- Timeout handling refinements for large brain operations

## Validation

Successful execution when:
- All brain CLI commands complete without PATH errors
- Held messages processed and cleaned from `/tmp/cron-held/`
- People context loaded for top 5 most recent updates
- Health metrics and coverage gaps explicitly reported
- Output contains no em dashes, follows mobile-friendly formatting
- Brain state properly established before any analysis or queries