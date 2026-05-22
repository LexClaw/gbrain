"""build_query_plan: produce a type-specific research query plan for a candidate.

Each query entry has:
  - query: str            (the literal search string)
  - source: str            (x|web|news|crunchbase|academic|linkedin|page_grep)
  - rationale: str         (why this query is being run)

Caps:
  - MAX_QUERIES per candidate (default 8) prevents runaway dispatch cost.
  - Unknown types fall through to a generic web query derived from the slug.

Per-type strategy (matches the auto-enrich plan lines 343-360):
  - person: X handle (if @handle in frontmatter), web, employer-website, news
  - company: official website + about page, Crunchbase, recent news, founder names
  - concept: academic-verify pass, Wikipedia, primary-source articles
  - other: generic web search with target_slug-derived keywords
"""

from __future__ import annotations

from typing import Any

MAX_QUERIES = 8


def build_query_plan(candidate: dict[str, Any], current_page_content: str) -> list[dict[str, str]]:
    """Build a type-specific query plan.

    Args:
        candidate: output dict from Phase 1 sensor with at least
            'slug', 'page_type', and optionally 'frontmatter'.
        current_page_content: the raw markdown of the candidate's current
            page (from `gbrain get <slug>`), used for context extraction.

    Returns:
        A list of query dicts capped at MAX_QUERIES.
    """
    ptype = candidate.get("page_type", "unknown")
    frontmatter = candidate.get("frontmatter", {})
    slug = candidate.get("slug", "")

    strategy = {
        "person": _person_plan,
        "company": _company_plan,
        "concept": _concept_plan,
    }

    build_fn = strategy.get(ptype)
    if build_fn is None:
        queries = _generic_web_plan(frontmatter, slug, current_page_content)
    else:
        queries = build_fn(frontmatter, slug, current_page_content)
    queries = queries[:MAX_QUERIES]
    return queries


def _generic_web_plan(fm: dict[str, Any], slug: str, page: str) -> list[dict[str, str]]:
    """Fallback for entity types not in {person, company, concept}.

    Per plan T2.0 (lines 343-360): generic web search with target_slug-derived
    keywords. Last segment of the slug, hyphens converted to spaces.
    """
    last_segment = slug.rsplit("/", 1)[-1]
    query = last_segment.replace("-", " ").strip()
    if not query:
        return []
    return [{
        "query": query,
        "source": "web",
        "rationale": "Generic web search for non-classified entity",
    }]


# -- Per-type helpers --

def _person_plan(fm: dict[str, Any], slug: str, page: str) -> list[dict[str, str]]:
    """Person strategy: X handle, web, employer website, news."""
    name = _extract_name(slug, fm)
    queries: list[dict[str, str]] = []

    # X handle search if @handle is in frontmatter
    handle = fm.get("x_handle") or fm.get("twitter") or fm.get("twitter_handle")
    if handle:
        clean_handle = handle.lstrip("@")
        queries.append({
            "query": f"@{clean_handle}",
            "source": "x",
            "rationale": f"Cross-reference X posts from @{clean_handle} for recent activity",
        })
        queries.append({
            "query": f"@{clean_handle} site:x.com",
            "source": "web",
            "rationale": f"Web search for X profile posts mentioning @{clean_handle}",
        })

    # LinkedIn
    queries.append({
        "query": f"{name} LinkedIn",
        "source": "web",
        "rationale": f"Find LinkedIn profile for {name}",
    })

    # Employer website if company is known
    company = fm.get("company") or fm.get("employer")
    if company:
        company_website = fm.get("company_website") or fm.get("employer_website")
        if company_website:
            queries.append({
                "query": f"{name} site:{_domain_from_url(company_website)}",
                "source": "web",
                "rationale": f"Search company website for {name}'s profile",
            })
        else:
            queries.append({
                "query": f"{name} {company}",
                "source": "web",
                "rationale": f"Web search for {name} at {company}",
            })

    # News mentions
    queries.append({
        "query": f"{name}",
        "source": "news",
        "rationale": f"Recent news mentions of {name}",
    })

    return queries


def _company_plan(fm: dict[str, Any], slug: str, page: str) -> list[dict[str, str]]:
    """Company strategy: website, Crunchbase, news, founder names."""
    name = _extract_name(slug, fm)
    queries: list[dict[str, str]] = []

    # Official website
    website = fm.get("website") or fm.get("url")
    if website:
        domain = _domain_from_url(website)
        queries.append({
            "query": f"site:{domain} about",
            "source": "web",
            "rationale": f"About page on {name}'s official website",
        })
    else:
        queries.append({
            "query": f"{name} official website",
            "source": "web",
            "rationale": f"Find official website for {name}",
        })

    # Crunchbase
    queries.append({
        "query": name,
        "source": "crunchbase",
        "rationale": f"Crunchbase profile for {name}",
    })

    # Recent news
    queries.append({
        "query": name,
        "source": "news",
        "rationale": f"Recent news about {name}",
    })

    # Founder names from existing page content
    if page:
        founders = _extract_potential_founders(page, name)
        for f in founders:
            queries.append({
                "query": f"{f} founder {name}",
                "source": "web",
                "rationale": f"Verify {f} as founder of {name}",
            })

    return queries


def _concept_plan(fm: dict[str, Any], slug: str, page: str) -> list[dict[str, str]]:
    """Concept strategy: academic, Wikipedia, primary sources."""
    name = _extract_name(slug, fm)
    queries: list[dict[str, str]] = []

    # Academic verification
    queries.append({
        "query": f"{name} academic",
        "source": "academic",
        "rationale": f"Verify {name} through academic sources",
    })

    # Wikipedia
    queries.append({
        "query": f"{name} Wikipedia",
        "source": "web",
        "rationale": f"Wikipedia article on {name}",
    })

    # Primary source articles
    queries.append({
        "query": name,
        "source": "web",
        "rationale": f"Primary source articles about {name}",
    })

    return queries


# -- Helpers --

def _extract_name(slug: str, fm: dict[str, Any]) -> str:
    """Heuristic name extraction from frontmatter or slug.
    
    Falls back to slug basename with hyphens as spaces.
    """
    name = (
        fm.get("title")
        or fm.get("name")
        or fm.get("display_name")
        or slug.rsplit("/", 1)[-1].replace("-", " ").title()
    )
    return name


def _domain_from_url(url: str) -> str:
    """Extract hostname from a URL string, stripping protocol and path."""
    if not url:
        return ""
    protocol_stripped = url.split("//")[-1] if "//" in url else url
    return protocol_stripped.split("/")[0].lower()


def _extract_potential_founders(page: str, company_name: str) -> list[str]:
    """Crude extraction of potential founder names from page content.

    Scans for patterns like 'founded by X' or 'co-founder X'.
    Returns at most 2 names to keep the query plan budget sane.
    """
    import re

    found: list[str] = []
    for pattern in [
        r"found(?:ed|er|ing)? by\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)",
        r"co-?found(?:er|ing|ed)?[:\s]+([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)",
    ]:
        for m in re.finditer(pattern, page, re.IGNORECASE):
            name = m.group(1)
            if name and name not in found:
                found.append(name)
        if len(found) >= 2:
            break

    return found[:2]
