# Autonomous Cron Briefing Pattern

Validated execution pattern for morning briefings running via cron/autonomous context. Derived from successful 2026-05-18 execution following `gbrain-cron-ops` skill.

## Prerequisites

```bash
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd ~/gbrain
```

Always set PATH and working directory before gbrain commands in cron context. **Updated June 2026**: Full PATH export now includes ~/.local/bin for broader tool coverage and reliable autonomous execution.

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

### 4. Active Intelligence Queries (Scale-Aware)

**At 57K+ page scale**: Simple search patterns with limits are primary strategy, not fallback.

```bash
# Primary strategy (reliable at scale)
gbrain search "deal" --limit 5
gbrain search "meeting" --limit 5  
gbrain search "commitment" --limit 5

# Fallback only (timeout-prone at large scale)
gbrain query "active deals status"
gbrain query "pending commitments follow-ups"
gbrain query "meetings this week"
```

- **Scale degradation**: Complex queries become unreliable at 57K+ pages (fragmented output, timeouts)
- **Execution preference**: Use simple search patterns as primary approach, attempt complex queries only if simple patterns inadequate
- Report timeout issues explicitly: "Query timeout affecting deal visibility at current brain scale (57K+ pages)"

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
[health score with context, priority issues, maintenance success, mission control integration status]

**Note**: Mission Control Integration - After briefing compilation, run:
`cd /Users/TJ/mission-control && node scripts/build-and-push-brief.mjs`
This archives the brief to MC Library with trackable IDs. Log success/failure but never block main briefing delivery.
```

## Critical Rules for Cron Context

1. **No em dashes**: Use commas, colons, or parentheses instead (TJ hard rule)
2. **Self-contained execution**: No clarifying questions, autonomous decisions only
3. **Coverage gaps explicit**: Never hide ignorance, always surface missing context
4. **Delta-based health**: Compare against baselines, not just absolute numbers. Report actual health scores (e.g., 0/10) with context rather than hiding poor metrics.
5. **Source citations**: Include slug and update date for all factual claims  
6. **Health score transparency**: Present real system state (including poor scores) with actionable context, not false positive reports

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
- **Mission Control integration completed** with trackable brief and library IDs
- **Scale-aware query strategy** used (simple search patterns at 57K+ page scale)
- **Health transparency** maintained (real scores reported with context, not hidden)

**June 1, 2026 validation**: Successful autonomous execution at 57K page scale with overnight maintenance integration, demonstrating held message processing, em dash hygiene enforcement, Mission Control pipeline automation, and scale-appropriate query fallback patterns.