---
name: skool-community-intel
version: 1.0.0
risk: low
roles: [leigh, lex, sage, cal]
tags: [skool, competitive-intel, scraping, next-data, discover-crypto, community-building]
description: |
  Scrape structured data from Skool.com community pages (price, member count,
  tiers, offer copy, survey gates, course/module/post counts) by parsing the
  embedded __NEXT_DATA__ JSON blob, and turn it into competitive intel. Use when
  asked to "scrape this Skool page", "what is <competitor> charging", "reverse-
  engineer their community", or when studying Skool communities for the Discover
  Crypto build. Also carries the Skool community-building playbook (Maker School
  insights, capital-tiered ladder model) as reference knowledge.
---

# Skool Community Intel

Two jobs in one skill: (1) the repeatable TECHNIQUE for pulling hard data out of
a Skool community page, and (2) the PLAYBOOK knowledge for building/benchmarking
a paid Skool community (built for the Discover Crypto $10k-MRR Hormozi Platinum
mandate, but general).

## When to use

- "Scrape this Skool community / what are they charging / how many members"
- "Reverse-engineer their tiers / offer / funnel"
- Studying any Skool competitor for the Discover Crypto build (card kn76fy umbrella)
- Need the community-building playbook (what makes a Skool community win)

## TECHNIQUE: scrape a Skool page via __NEXT_DATA__

`web_extract` may be unconfigured on this box (returns "Web tools are not
configured. Set FIRECRAWL_API_KEY..."). Do NOT conclude scraping is impossible —
fall back to a direct curl + parse. Skool is a Next.js app, so the entire page
state (price, members, offer copy, survey, tiers) is embedded in the
`__NEXT_DATA__` JSON blob. This is far richer than the rendered text.

The `/about` page of any Skool community is public. Steps:

```bash
cd /tmp
# 1. Fetch with a real UA (Skool 403s a bare curl)
curl -sL -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" \
  "https://www.skool.com/<groupname>/about" -o page.html -w "HTTP:%{http_code} SIZE:%{size_download}\n" --max-time 25

# 2. Extract the __NEXT_DATA__ JSON (use python, not grep/sed)
python3 -c "
import re,json
h=open('page.html',encoding='utf-8').read()
m=re.search(r'<script id=\"__NEXT_DATA__\" type=\"application/json\">(.*?)</script>',h,re.S)
json.dump(json.loads(m.group(1)),open('page.json','w'))
print('ok',len(m.group(1)))
"

# 3. The group lives at props.pageProps.currentGroup.metadata
python3 -c "
import json
md=json.load(open('page.json'))['props']['pageProps']['currentGroup']['metadata']
print('METADATA KEYS:',list(md.keys()))
for k in ['displayName','description','displayPrice','totalMembers','totalAdmins',
          'totalPosts','numCourses','numModules','privacy','lpDescription',
          'membershipModel','owner','links','survey']:
    if k in md: print(f'{k}:',repr(md[k])[:700])
"
```

### Field map (verified 2026-06-08 on coinpicksarmy)

- `metadata.displayName` — community name.
- `metadata.description` — the short tagline/bio (NOT the full pitch).
- `metadata.lpDescription` — the FULL landing-page pitch (offer, "What You Get",
  tier links, guarantees). This is the richest field for competitive intel.
  It uses Skool's own `[ul][li]` markup, not real HTML.
- `metadata.displayPrice` — a JSON STRING (parse it again): `{"currency":"usd","amount":199700,"recurring_interval":"year"}`. Amount is in CENTS (199700 = $1,997). Watch `recurring_interval` (month vs year).
- `metadata.totalMembers` / `totalAdmins` / `totalPosts` / `numCourses` / `numModules` — hard activity numbers. Multiply members x price for an ARR estimate.
- `metadata.privacy` — 1 = private (survey/approval gate).
- `metadata.survey` — JSON string of the join-gate questions (often segments by
  capital + captures phone). Reveals their qualification + lead-capture strategy.
- `metadata.owner` — JSON string with `name`, `bio`, and `link_*` social handles.
- `metadata.links` — upgrade/cross-sell links (often point to OTHER tiers' /about pages — follow them to map the full ladder).

### After scraping: file it
File the result as `competitive-intel/<group>` in GBrain (put_page) AND, when it
informs an active build, link it to the relevant entity pages and the MC card.
Use the `competitive-intel` MC document folder. See
`references/coinpicks-army-2026-06-08.md` for a worked example with the full
data shape.

## PLAYBOOK: what makes a paid Skool community win

Distilled from the Skool Games #1 winner (Maker School, $335K/mo solo, ~1.5
hrs/day), the CoinPicks Army crypto competitor, and Discover Crypto member-product
work. Full detail in `references/maker-school-playbook.md`. For the Discover
Crypto assessment + workbook model, see
`references/discover-crypto-assessment-workbook-model-2026-06-11.md`.

For wellness / breathwork / nervous-system creators, also see
`references/wellness-practice-container-model.md`. The key adaptation: do not
build "course modules + general discussion." Build a **guided practice
container** where members practice, report felt shifts, ask questions, and see
other members' regulation wins. The course is the library; daily practice and
witness are the life of the group.

For Discover Crypto onboarding assets, see
`references/discover-crypto-assessment-workbook-model-2026-06-11.md`. The key
adaptation from the Ramsey/FPU model is: build a **behavior-change assessment +
workbook path**, not a generic crypto course. Free front-door = Crypto Investor
Readiness Assessment; paid member asset = Investor Operating System Workbook.
Trading belongs behind a discipline gate, not as the core promise.

The spine:
1. **Show up in the forum every single day.** This is ~80% of the win. Out-engage
   the average owner ~15x. Solo scales to ~8,000 members (~0.022 min/member/day).
   Don't pre-hire community managers — the creators people came for ARE the product.
2. **Sell the OUTCOME, not the topic.** Not "crypto analysis" → a specific
   measurable result + a named "system." (TJ's DC tagline: "Stop guessing. Start
   investing with a system. Change your life with Bitcoin." — this implies a real
   named framework must exist inside to deliver on it.)
3. **Launch now, build later.** Stand it up lean, improve 1% weekly. Don't wait
   for a finished classroom.
4. **The Wins channel is the churn-killer AND the sales engine.** Pin member
   results to the front page; keep 2 of 3 pinned posts as wins; a "Best of" wall
   = a standalone testimonial asset.
5. **Instant-ROI onboarding perk** (tool/exchange discounts) so the membership
   pays for itself day one. Onboarding = intro post + comment on 3 + read wins.
6. **Capital-tiered ladder for high-ticket** (validated by CoinPicks): cheap/$1
   front door → core (~$99/mo) → high-ticket inner circle that gets calls FIRST
   (signals-first-to-top-tier is a free upsell mechanic). Annual billing
   front-loads cash and cuts churn.
7. **Forums > calls.** Text posts serve ~100% and stay evergreen; calls serve only
   the ~15% who attend. Anchor on forum + one weekly call.
8. **Survey gate on join** segments by capital and captures a phone number.
9. **Price filters quality.** Too cheap attracts tire-kickers. Start, then raise
   consistently (gradual increases reduce churn).

## Pitfalls

- Don't conclude "can't scrape" when `web_extract` is unconfigured — curl + parse
  `__NEXT_DATA__` works and is richer.
- A bare curl gets 403; use a real browser User-Agent.
- `displayPrice` and `survey` and `owner` are JSON STRINGS nested inside the JSON
  — parse them a second time. `amount` is in cents.
- Use python to walk the JSON, not grep/sed against the HTML.
- The rendered/visible text underreports — the pitch, tiers, and survey live only
  in `lpDescription` / `survey` / `links`, not the visible About text.
- When a YouTube link the user shares is one you ALREADY transcribed this session,
  the remaining work is usually brain INGESTION (a queryable GBrain source page +
  entity backlinks), not re-extraction. Default to scrape+ingest in one pass.
