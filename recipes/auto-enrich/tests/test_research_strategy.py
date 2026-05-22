from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import research_strategy  # noqa: E402


# --- Helpers ---

def _make_candidate(page_type: str, **extra) -> dict:
    """Minimal candidate dict with common defaults."""
    return {
        "slug": "test/type-slug",
        "page_type": page_type,
        "frontmatter": {},
        **extra,
    }


PERSON_PAGE = """---
type: person
title: Jane Doe
x_handle: "@janedoe"
company: Acme Corp
company_website: "https://acme.example.com"
---
# Jane Doe
Just a stub.
"""

COMPANY_PAGE = """---
type: company
title: Y Combinator
website: "https://www.ycombinator.com"
---
# Y Combinator
Founded by Paul Graham, Jessica Livingston, Robert Morris, and Trevor Blackwell in 2005.
Graham announced the accelerator in March 2005.
"""

CONCEPT_PAGE = """---
type: concept
title: Machine Learning
---
# Machine Learning
A subset of artificial intelligence.
"""


# --- Tests ---

def test_person_with_x_handle():
    c = _make_candidate("person", frontmatter={
        "title": "Jane Doe", "x_handle": "@janedoe",
        "company": "Acme Corp", "company_website": "https://acme.example.com",
    })
    plan = research_strategy.build_query_plan(c, PERSON_PAGE)
    sources = {q["source"] for q in plan}
    assert "x" in sources, "person with @handle should include X-source query"
    assert any("@janedoe" in q["query"] for q in plan)


def test_person_without_x_handle():
    """Person without @handle must not include X-source query."""
    c = _make_candidate("person", frontmatter={
        "title": "John Smith",
    })
    plan = research_strategy.build_query_plan(c, "---\ntype: person\ntitle: John Smith\n---\n\nJust John.")
    sources = {q["source"] for q in plan}
    assert "x" not in sources, "person without @handle should omit X-source query"


def test_company_includes_crunchbase_web_news():
    """Company candidate should include crunchbase + web + news sources."""
    c = _make_candidate("company", frontmatter={
        "title": "Y Combinator",
        "website": "https://www.ycombinator.com",
    })
    plan = research_strategy.build_query_plan(c, COMPANY_PAGE)
    sources = {q["source"] for q in plan}
    assert "crunchbase" in sources, "company plan should include crunchbase"
    assert "web" in sources, "company plan should include web"
    assert "news" in sources, "company plan should include news"


def test_company_empty_plan_returns_something():
    """Company without website still produces web+crunchbase+news queries."""
    c = _make_candidate("company", frontmatter={"title": "RandomCo"})
    plan = research_strategy.build_query_plan(c, "RandomCo is a startup.")
    assert len(plan) >= 2, "company without website should still plan queries"
    sources = {q["source"] for q in plan}
    assert "crunchbase" in sources


def test_concept_includes_academic_wikipedia():
    """Concept candidate should include academic + web queries."""
    c = _make_candidate("concept", frontmatter={"title": "Machine Learning"})
    plan = research_strategy.build_query_plan(c, CONCEPT_PAGE)
    sources = {q["source"] for q in plan}
    assert "academic" in sources, "concept plan should include academic"
    assert "web" in sources, "concept plan should include web"
    assert any("Wikipedia" in q["query"] or "wikipedia" in q["rationale"] for q in plan)


def test_unknown_type_empty_plan():
    """Unknown page type returns empty query plan (skip-and-log)."""
    c = _make_candidate("meeting", frontmatter={})
    plan = research_strategy.build_query_plan(c, "A meeting about something.")
    assert plan == [], "unknown type should return empty plan"


def test_entity_fallback_web():
    """Entity (other than known types) returns empty plan per spec."""
    c = _make_candidate("entity", frontmatter={})
    plan = research_strategy.build_query_plan(c, "Some entity page.")
    assert plan == []


def test_query_cap_max_8():
    """Query plan must never exceed MAX_QUERIES."""
    # Build a person plan with all fields set to maximize queries
    c = _make_candidate("person", frontmatter={
        "title": "A Very Famous Person With A Really Long Name",
        "x_handle": "@famous",
        "company": "SomeBigCorp",
        "company_website": "https://bigcorp.example.com",
    })
    plan = research_strategy.build_query_plan(c, PERSON_PAGE)
    assert len(plan) <= research_strategy.MAX_QUERIES, (
        f"Plan has {len(plan)} queries, cap is {research_strategy.MAX_QUERIES}"
    )


def test_frontmatter_context_biases_person_query():
    """current_page_content is read for context bias."""
    c = _make_candidate("person", frontmatter={
        "title": "Bob",
        "company": "BigCorp",
    })
    plan = research_strategy.build_query_plan(c, BOB_PAGE)
    # At minimum a company search should appear
    assert any("bigcorp" in q["query"].lower() for q in plan), (
        f"Company in content should bias person queries to include company"
    )


BOB_PAGE = """---
type: person
title: Bob
company: BigCorp
---
# Bob
Works at BigCorp.
"""


def test_person_without_company():
    """Person without company still gets web and (with handle) X queries."""
    c = _make_candidate("person", frontmatter={
        "title": "No Company",
        "x_handle": "@nocompany",
    })
    plan = research_strategy.build_query_plan(c, "---\ntype: person\ntitle: No Company\n---\n\nNo company.")
    sources = {q["source"] for q in plan}
    assert "x" in sources
    assert "web" in sources
    assert "news" in sources


def test_plan_entries_have_required_keys():
    """Every query dict must have query, source, rationale."""
    c = _make_candidate("person", frontmatter={
        "title": "Alice", "x_handle": "@alice",
        "company": "Company", "company_website": "https://co.example.com",
    })
    plan = research_strategy.build_query_plan(c, PERSON_PAGE)
    for entry in plan:
        assert "query" in entry, entry
        assert "source" in entry, entry
        assert "rationale" in entry, entry


def test_plan_entries_have_valid_sources():
    """All source values must be from the known set."""
    valid_sources = {"x", "web", "news", "crunchbase", "academic", "linkedin", "page_grep"}
    c = _make_candidate("company", frontmatter={
        "title": "Acme", "website": "https://acme.example.com",
    })
    plan = research_strategy.build_query_plan(c, "---\n---\nFounded by Alice Smith and Bob Jones.")
    for entry in plan:
        assert entry["source"] in valid_sources, f"Unknown source: {entry['source']}"
