# Worked example: scraping CoinPicks Army (2026-06-08)

Reverse-engineered https://www.skool.com/coinpicksarmy/about (owner Alexander
Lorenzo; TJ has met him). This is the canonical worked example for the
`__NEXT_DATA__` scrape technique and the capital-tiered-ladder model.

## Hard data pulled (verified live)

- **Price:** `displayPrice` = `{"currency":"usd","amount":199700,"recurring_interval":"year"}` → **$1,997/year** (~$166/mo).
- **Members:** `totalMembers` = 416 → implied ~$831K ARR on this tier alone.
- **Depth:** `numCourses` 4, `numModules` 211, `totalPosts` 10,821, `totalAdmins` 5.
- **Privacy:** `privacy` = 1 (private, survey-gated).
- **Tagline:** `description` = "The wealth of the wicked is stored up for the righteous" (Christian framing).

## The 3-tier capital ladder (from `lpDescription` + `links`)

The pitch routes members by how much capital they have:
1. **CoinPicks Genesis** — $1/month — for "<$2,000". Cheap front door / list-builder.
2. **CoinPicks Army** — $1,997/yr — for "$2,000–$250,000". The core engine (the 416).
3. **CoinPicks Inner Circle** — for "$500,000+". High-ticket; gets buy/sell calls
   **24h BEFORE Army** (signals-first-to-top-tier = free upsell mechanic).

To map the full ladder, follow the cross-links in `lpDescription`/`links` and
scrape the Genesis and Inner Circle /about pages the same way.

## The offer copy (`lpDescription`, verbatim "What You Get")

- Portfolio Insights — "See exactly how Alex positions investments, no guesswork."
- Trading Signals — "Simple buy/sell alerts (24 hours after InnerCircle)."
- Community — "Network with experienced investors following the same blueprint."
- Educational Videos — "Step-by-step roadmap, like following a recipe."
- Live Q&A — "1 hour weekly."
- "Complete system built from 8 years of experience — no finance background needed."
- Gold + Diamond Altcoin Research Databases.
- 15-day 100% money-back guarantee.

## The survey gate (`survey`, JSON string)

3 questions: (1) capital band (4 options <$1k / $1k–50k / $50k–250k / $250k+),
(2) "Can you afford this group?", (3) phone number capture. Segments by capital
AND captures phone for sales/SMS follow-up.

## Why it matters for Discover Crypto

- Answers TJ's "add a high-ticket" question: mirror the cheap→core→inner-circle ladder.
- "Complete system... no finance background" = same promise as TJ's chosen DC
  description ("Start investing with a system"). Validates the direction — but we
  must build a NAMED DC system to deliver it.
- DC's $99/mo undercuts Army's ~$166/mo, with a bigger/warmer YouTube brand (Nick + Drew).
- Filed to GBrain as `competitive-intel/coinpicks-army`.
