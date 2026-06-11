# June 2026 50K+ Scale Execution Pattern

## Context
Successful autonomous morning briefing executions validating scale-appropriate patterns:
- **June 5, 2026**: 51,145 pages - Initial large-scale validation
- **June 8, 2026**: 70,508 pages - 70K+ scale confirmation with continued reliability

## Execution Pattern

### Environment Setup
```bash
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd ~/gbrain
```

### Scale-Aware Query Strategy
At 50K+ pages, complex queries become unreliable with fragmented output. Primary strategy:
- **Use simple search patterns**: `gbrain search "term" --limit N` 
- **Use type filters**: `gbrain list --type person -n 10`
- **Avoid complex query strings**: Patterns like `gbrain query "active deals status"` fragment at this scale

### Key Commands That Work Reliably
- `gbrain stats` - Brain health metrics
- `gbrain health` - Health score (8/10 format)
- `gbrain doctor --json` - Detailed health breakdown
- `gbrain list --type person -n 10` - Recent people
- `gbrain get people/slug` - Individual page loads
- `gbrain search "deal" --limit 5` - Simple search patterns

### Health Reporting Rules (Confirmed June 2026)
- **Headline number**: Extract `brain_score` from doctor JSON (89/100 at 70K pages)
- **Secondary metrics**: Report `gbrain health` as Health: N/10
- **DO NOT report** top-level `health_score` field - it's a binary gate that floors to 0
- **Gate failures**: Report only actionable failing checks, not warnings
- **Scale behavior**: Brain score remains stable (89-94/100) even as page count grows 40%

### Em Dash Discipline
NEVER use em dashes in briefing output (HR-18 enforcement). Use commas, colons, or parentheses.

### Mission Control Integration
After successful briefing compilation:
```bash
cd /Users/TJ/mission-control && node scripts/build-and-push-brief.mjs
```
Expected output pattern:
- `briefs:upsert -> [ID] for 2026-06-05`
- `Brief saved to Library: [ID] for 2026-06-05`
- Success log written to `/Users/TJ/mission-control/logs/mc-pipeline-[date].jsonl`

## Performance Characteristics
**June 5, 2026 (51K pages)**:
- Total execution time: ~2 minutes for full briefing + MC integration
- Brain score: 94/100 with manageable health issues

**June 8, 2026 (70K pages)**:
- Execution time: ~3 minutes for full briefing + MC integration
- Brain score: 89/100 (stable despite 40% growth)
- Two stale locks detected and cleared via `gbrain sync --break-lock`
- Entity link coverage: 99%, timeline coverage: 51%
- Pattern reliability: 100% using simple search/list commands

**Scale invariants**:
- No timeouts or fragmentation when using simple patterns
- 100% embedding coverage maintained across scale increases
- MC integration remains reliable (brief upsert + library filing)

## Validation Markers

**June 5, 2026 execution**:
- Held message processing: Empty /tmp/cron-held/ directory confirmed
- People context: Top 5 loaded with full context (nateherk, Matt PCO, Hormozis, 1MarkMoss)
- Health metrics: All core systems operational despite sync staleness
- MC integration: Both brief upsert and library filing completed successfully

**June 8, 2026 execution (70K pages)**:
- Held message processing: No overnight messages - systems running normally
- People context: Brooke, Shaan Trivedi, Ron Wyden, Phil Pool-Raleigh, Bob Proctor
- Brain health: 89/100 with two cleared stale locks, 99% entity link coverage
- MC integration: Brief ID j974fnj41qmc05f4wf1z4jkk0h88872a, Library ID n176d50x96xx269n1f0k8awkvd8897ct
- Sponsor pipeline: 17 documented prospects, zero active deals confirmed

This pattern scales reliably from 50K to 70K+ pages and should be the template for future large-brain autonomous briefings.