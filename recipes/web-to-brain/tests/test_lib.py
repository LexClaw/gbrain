"""Tests for web_lib.py public API.

Mocks: HTTP via `responses`. subprocess (gbrain CLI) via monkeypatch.
Fixtures: tests/fixtures/{html,robots}/

Spec gate 8: recorded fixtures only, no live HTTP in CI.
"""
from __future__ import annotations

import gzip
import json
import sys
import time
from pathlib import Path

import pytest
import responses

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _read(rel: str) -> str:
    return (FIXTURES / rel).read_text(encoding="utf-8")


@pytest.fixture(autouse=True)
def isolate_state(tmp_path, monkeypatch):
    import web_lib as wl
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setattr(wl, "STATE_DIR", state)
    monkeypatch.setattr(wl, "FETCH_LOCK", state / "fetch.lock")
    monkeypatch.setattr(wl, "FETCH_LOG", state / "fetch.log")
    monkeypatch.setattr(wl, "HEARTBEAT", state / "heartbeat.jsonl")
    monkeypatch.setattr(wl, "ROBOTS_CACHE", state / "robots-cache")
    monkeypatch.setattr(wl, "QUEUE_DIR", state / "enrichment-queue")
    monkeypatch.setattr(wl, "QUEUE_FAILED_DIR", state / "enrichment-queue" / "failed")
    yield wl


# ---------- URL helpers ----------


def test_normalize_url(isolate_state):
    wl = isolate_state
    assert wl.normalize_url("HTTPS://Example.COM/Path#frag") == "https://example.com/Path"
    assert wl.normalize_url("http://x.test") == "http://x.test/"


def test_url_host(isolate_state):
    wl = isolate_state
    assert wl.url_host("https://example.com/a/b") == "example.com"


def test_make_job_id_stable(isolate_state):
    wl = isolate_state
    assert wl.make_job_id("https://example.com/x") == wl.make_job_id("https://example.com/x")
    assert wl.make_job_id("HTTPS://EXAMPLE.com/x#a") == wl.make_job_id("https://example.com/x")


# ---------- http_fetch: status codes, redirects, content-type ----------


@responses.activate
def test_http_fetch_happy_path(isolate_state):
    wl = isolate_state
    responses.add(responses.GET, "http://x.test/a",
                  body="<html><body><p>hello world content here</p></body></html>",
                  status=200, content_type="text/html; charset=utf-8")
    fr = wl.http_fetch("http://x.test/a")
    assert fr.status == 200
    assert "hello world" in fr.body
    assert fr.final_url == "http://x.test/a"
    assert fr.elapsed_ms >= 0


@responses.activate
def test_http_fetch_403(isolate_state):
    wl = isolate_state
    responses.add(responses.GET, "http://x.test/", status=403, body="forbidden")
    with pytest.raises(wl.NetworkError):
        wl.http_fetch("http://x.test/")


@responses.activate
def test_http_fetch_404(isolate_state):
    wl = isolate_state
    responses.add(responses.GET, "http://x.test/", status=404, body="not found")
    with pytest.raises(wl.NetworkError):
        wl.http_fetch("http://x.test/")


@responses.activate
def test_http_fetch_429(isolate_state):
    wl = isolate_state
    responses.add(responses.GET, "http://x.test/", status=429, body="too many")
    with pytest.raises(wl.NetworkError):
        wl.http_fetch("http://x.test/")


@responses.activate
def test_http_fetch_503(isolate_state):
    wl = isolate_state
    responses.add(responses.GET, "http://x.test/", status=503, body="down")
    with pytest.raises(wl.NetworkError):
        wl.http_fetch("http://x.test/")


@responses.activate
def test_http_fetch_redirect_chain_succeeds(isolate_state):
    wl = isolate_state
    responses.add(responses.GET, "http://x.test/a", status=301,
                  headers={"Location": "http://x.test/b"})
    responses.add(responses.GET, "http://x.test/b", status=302,
                  headers={"Location": "http://x.test/c"})
    responses.add(responses.GET, "http://x.test/c", status=200,
                  body="<html><p>final</p></html>", content_type="text/html")
    fr = wl.http_fetch("http://x.test/a")
    assert fr.final_url == "http://x.test/c"
    assert len(fr.redirect_chain) == 3


@responses.activate
def test_http_fetch_redirect_loop(isolate_state):
    wl = isolate_state
    responses.add(responses.GET, "http://x.test/a", status=302,
                  headers={"Location": "http://x.test/b"})
    responses.add(responses.GET, "http://x.test/b", status=302,
                  headers={"Location": "http://x.test/a"})
    with pytest.raises(wl.RedirectLoop):
        wl.http_fetch("http://x.test/a")


@responses.activate
def test_http_fetch_too_many_redirects(isolate_state):
    wl = isolate_state
    for i in range(7):
        responses.add(responses.GET, f"http://x.test/{i}", status=302,
                      headers={"Location": f"http://x.test/{i+1}"})
    with pytest.raises(wl.NetworkError):
        wl.http_fetch("http://x.test/0", max_redirects=3)


@responses.activate
def test_http_fetch_rejects_non_html(isolate_state):
    wl = isolate_state
    responses.add(responses.GET, "http://x.test/file.pdf", status=200,
                  body=b"%PDF-1.4 stuff", content_type="application/pdf")
    with pytest.raises(wl.UnsupportedContentType):
        wl.http_fetch("http://x.test/file.pdf")


@responses.activate
def test_http_fetch_too_large(isolate_state):
    wl = isolate_state
    big = "x" * (200 * 1024)
    responses.add(responses.GET, "http://x.test/big", status=200,
                  body=big, content_type="text/html")
    with pytest.raises(wl.ContentTooLarge):
        wl.http_fetch("http://x.test/big", max_body=100 * 1024)


@responses.activate
def test_http_fetch_gzip_body(isolate_state):
    """Body has gzip magic but no Content-Encoding header (rare; we handle it)."""
    wl = isolate_state
    raw = gzip.compress(b"<html><body><p>gzip body content</p></body></html>")
    responses.add(responses.GET, "http://x.test/gz", status=200,
                  body=raw, content_type="text/html")
    fr = wl.http_fetch("http://x.test/gz")
    assert "gzip body content" in fr.body


@responses.activate
def test_http_fetch_cloudflare_bot_block(isolate_state):
    wl = isolate_state
    responses.add(responses.GET, "http://x.test/", status=403,
                  headers={"cf-mitigated": "challenge"},
                  body=b"Sorry, you have been blocked. Error code: 1020")
    with pytest.raises(wl.BotBlocked):
        wl.http_fetch("http://x.test/")


@responses.activate
def test_http_fetch_uses_declared_user_agent(isolate_state):
    """Gate 5: UA must be declared and on every request."""
    wl = isolate_state
    captured = {}

    def cb(req):
        captured["ua"] = req.headers.get("User-Agent")
        return (200, {"Content-Type": "text/html"}, "<html><p>ok</p></html>")

    responses.add_callback(responses.GET, "http://x.test/", callback=cb)
    wl.http_fetch("http://x.test/")
    assert captured["ua"] == wl.USER_AGENT
    assert "gbrain-web-to-brain" in captured["ua"]


# ---------- robots.txt (gate 4) ----------


@responses.activate
def test_robots_disallow_blocks_our_ua(isolate_state):
    wl = isolate_state
    responses.add(responses.GET, "https://x.test/robots.txt", status=200,
                  body=_read("robots/disallow.txt"))
    assert wl.robots_allows("https://x.test/private/secret") is False
    assert wl.robots_allows("https://x.test/public") is True


@responses.activate
def test_robots_404_treated_as_allow(isolate_state):
    wl = isolate_state
    responses.add(responses.GET, "https://x.test/robots.txt", status=404)
    assert wl.robots_allows("https://x.test/anything") is True


@responses.activate
def test_robots_5xx_treated_as_allow_no_cache(isolate_state):
    wl = isolate_state
    responses.add(responses.GET, "https://x.test/robots.txt", status=503)
    assert wl.robots_allows("https://x.test/anything") is True
    # Not cached, so a second call re-fetches.
    responses.add(responses.GET, "https://x.test/robots.txt", status=200,
                  body=_read("robots/disallow.txt"))
    assert wl.robots_allows("https://x.test/private/x") is False


@responses.activate
def test_robots_cached_ttl(isolate_state, monkeypatch):
    wl = isolate_state
    responses.add(responses.GET, "https://x.test/robots.txt", status=200,
                  body=_read("robots/allow-all.txt"))
    assert wl.robots_allows("https://x.test/a") is True
    # No second registration; cache must hit.
    assert wl.robots_allows("https://x.test/b") is True


@responses.activate
def test_robots_crawl_delay(isolate_state):
    wl = isolate_state
    responses.add(responses.GET, "https://x.test/robots.txt", status=200,
                  body=_read("robots/crawl-delay.txt"))
    delay = wl.robots_crawl_delay("https://x.test/a")
    assert delay in (5, 5.0)


# ---------- SPA detection (gate 6) ----------


def test_spa_detector_nextjs_positive(isolate_state):
    wl = isolate_state
    res = wl.detect_spa(_read("html/spa-nextjs.html"))
    assert res.is_spa is True
    assert res.reason


def test_spa_detector_react_positive(isolate_state):
    wl = isolate_state
    res = wl.detect_spa(_read("html/spa-react.html"))
    assert res.is_spa is True


def test_spa_detector_vue_positive(isolate_state):
    wl = isolate_state
    res = wl.detect_spa(_read("html/spa-vue.html"))
    assert res.is_spa is True


def test_spa_detector_real_article_negative(isolate_state):
    wl = isolate_state
    res = wl.detect_spa(_read("html/article-valid.html"))
    assert res.is_spa is False, f"false positive on real article: {res.reason}"
    assert res.has_article is True


def test_spa_detector_short_real_negative_status(isolate_state):
    wl = isolate_state
    res = wl.detect_spa(_read("html/short-but-real-1.html"))
    assert res.is_spa is False, f"false positive on status page: {res.reason}"


def test_spa_detector_short_real_negative_bio(isolate_state):
    wl = isolate_state
    res = wl.detect_spa(_read("html/short-but-real-2.html"))
    assert res.is_spa is False, f"false positive on partner bio: {res.reason}"


def test_spa_detector_short_real_negative_pricing(isolate_state):
    wl = isolate_state
    res = wl.detect_spa(_read("html/short-but-real-3.html"))
    assert res.is_spa is False, f"false positive on pricing one-liner: {res.reason}"


def test_spa_detector_malformed_no_crash(isolate_state):
    wl = isolate_state
    # malformed.html has no <article>/<main>/<p> with structure. Acceptable for
    # the detector to flag this; it must NOT crash.
    res = wl.detect_spa(_read("html/malformed.html"))
    assert res is not None


# ---------- extract_content ----------


def test_extract_content_real_article(isolate_state):
    wl = isolate_state
    ex = wl.extract_content(_read("html/article-valid.html"))
    assert ex.title
    assert "compounding" in ex.text.lower()
    assert ex.likely_paywall is False


def test_extract_content_paywall_marker(isolate_state):
    wl = isolate_state
    html = """<html><body><article>
    <h1>Investigation</h1>
    <p>Some teaser paragraph that hooks readers and then cuts off.</p>
    <p>Subscribe to continue reading this story.</p>
    </article></body></html>"""
    ex = wl.extract_content(html)
    assert ex.likely_paywall is True


def test_extract_content_empty_raises(isolate_state):
    wl = isolate_state
    with pytest.raises(wl.ExtractionFailed):
        wl.extract_content("<html><head><title>x</title></head><body></body></html>")


# ---------- build_draft_page ----------


def test_build_draft_page_slug_shape(isolate_state):
    wl = isolate_state
    ex = wl.Extracted(title="Hello World", byline="Jane R", text="body text here", html="<p>body text here</p>")
    slug, body = wl.build_draft_page(
        "https://example.com/about",
        "https://example.com/about",
        ex,
        fetched_at="2026-05-15T12:00:00+00:00",
        bytes_read=1234,
    )
    assert slug.startswith("sources/web/example-com/2026-05-15-about-")
    assert slug == slug.lower()
    assert "pending_enrichment" in body
    assert "[Source: example.com, https://example.com/about, 2026-05-15]" in body
    assert "body text here" in body


def test_build_draft_page_slug_override(isolate_state):
    wl = isolate_state
    ex = wl.Extracted(title="Acme About", byline="", text="acme is a company", html="<p>acme</p>")
    slug, body = wl.build_draft_page(
        "https://acme.example.com/about",
        "https://acme.example.com/about",
        ex,
        fetched_at="2026-05-15T12:00:00+00:00",
        slug_override="companies/acme",
    )
    assert "companies-acme" in slug
    assert slug.startswith("sources/web/acme-example-com/")


def test_build_draft_page_paywall_note(isolate_state):
    wl = isolate_state
    ex = wl.Extracted(title="t", byline="", text="x", html="<p>x</p>", likely_paywall=True)
    slug, body = wl.build_draft_page("u", "u", ex, fetched_at="2026-05-15T00:00:00+00:00")
    assert "likely_paywall: true" in body
    assert "paywall detected" in body


# ---------- enqueue + queue lifecycle ----------


def test_enqueue_and_move_to_failed(isolate_state):
    wl = isolate_state
    p = wl.enqueue_enrichment("job123", "https://example.com/a", "sources/web/example-com/x")
    assert p.exists()
    assert wl.list_queue() == [p]
    failed = wl.move_to_failed(p, "test reason")
    assert failed.exists() and not p.exists()
    data = json.loads(failed.read_text())
    assert data["_failure_reason"] == "test reason"


def test_enqueue_idempotent_same_job_id(isolate_state):
    wl = isolate_state
    p1 = wl.enqueue_enrichment("jobX", "u", "s")
    p2 = wl.enqueue_enrichment("jobX", "u", "s")
    assert p1 == p2
    assert len(wl.list_queue()) == 1


# ---------- lockfile ----------


def test_fetch_lock_second_holder_gets_false(isolate_state):
    wl = isolate_state
    with wl.fetch_lock() as a:
        assert a is True
        with wl.fetch_lock() as b:
            assert b is False


# ---------- ingest_url orchestration (end-to-end with all subprocess stubbed) ----------


@responses.activate
def test_ingest_url_happy_path(isolate_state, monkeypatch, capsys):
    wl = isolate_state
    # robots
    responses.add(responses.GET, "https://x.test/robots.txt", status=200,
                  body=_read("robots/allow-all.txt"))
    # page
    responses.add(responses.GET, "https://x.test/article", status=200,
                  body=_read("html/article-valid.html"),
                  content_type="text/html; charset=utf-8")

    put_calls = []
    monkeypatch.setattr(wl, "gbrain_put", lambda slug, content, bin="gbrain": put_calls.append(slug))
    monkeypatch.setattr(wl, "gbrain_upload_raw", lambda *a, **k: True)
    monkeypatch.setattr(wl, "gbrain_page_enriched", lambda slug, bin="gbrain": False)

    result = wl.ingest_url("https://x.test/article")
    assert result.status == "ok"
    assert result.page_slug.startswith("sources/web/x-test/")
    assert len(put_calls) == 1
    assert len(wl.list_queue()) == 1
    out = capsys.readouterr().out
    assert "RUN_START" in out
    assert "ROBOTS_CHECK" in out
    assert "URL_FETCHED" in out
    assert "ENRICH_QUEUED" in out
    assert "RUN_COMPLETE" in out


@responses.activate
def test_ingest_url_robots_disallow(isolate_state, monkeypatch, capsys):
    wl = isolate_state
    responses.add(responses.GET, "https://x.test/robots.txt", status=200,
                  body=_read("robots/disallow.txt"))
    monkeypatch.setattr(wl, "gbrain_put", lambda *a, **k: pytest.fail("must not write"))

    result = wl.ingest_url("https://x.test/private/secret")
    assert result.status == "skip"
    assert result.reason == "robots_disallowed"
    out = capsys.readouterr().out
    assert "ROBOTS_DISALLOW" in out
    assert "RUN_COMPLETE" in out
    assert len(wl.list_queue()) == 0


@responses.activate
def test_ingest_url_spa_skips_cleanly(isolate_state, monkeypatch, capsys):
    wl = isolate_state
    responses.add(responses.GET, "https://x.test/robots.txt", status=200,
                  body=_read("robots/allow-all.txt"))
    responses.add(responses.GET, "https://x.test/spa", status=200,
                  body=_read("html/spa-nextjs.html"),
                  content_type="text/html")
    monkeypatch.setattr(wl, "gbrain_put", lambda *a, **k: pytest.fail("must not write SPA garbage"))

    result = wl.ingest_url("https://x.test/spa")
    assert result.status == "skip"
    assert result.reason.startswith("spa:")
    out = capsys.readouterr().out
    assert "SPA_DETECTED" in out


@responses.activate
def test_ingest_url_idempotent_when_enriched(isolate_state, monkeypatch, capsys):
    """Gate 2: re-running on an already-enriched page is a no-op."""
    wl = isolate_state
    responses.add(responses.GET, "https://x.test/robots.txt", status=200,
                  body=_read("robots/allow-all.txt"))
    responses.add(responses.GET, "https://x.test/article", status=200,
                  body=_read("html/article-valid.html"),
                  content_type="text/html")
    monkeypatch.setattr(wl, "gbrain_page_enriched", lambda slug, bin="gbrain": True)
    monkeypatch.setattr(wl, "gbrain_put",
                        lambda *a, **k: pytest.fail("must not re-write enriched page"))

    result = wl.ingest_url("https://x.test/article")
    assert result.status == "skip"
    assert result.reason == "already_enriched"
    out = capsys.readouterr().out
    assert "RUN_COMPLETE" in out
    assert len(wl.list_queue()) == 0


@responses.activate
def test_ingest_url_dry_run_writes_nothing(isolate_state, monkeypatch):
    wl = isolate_state
    responses.add(responses.GET, "https://x.test/robots.txt", status=200,
                  body=_read("robots/allow-all.txt"))
    responses.add(responses.GET, "https://x.test/article", status=200,
                  body=_read("html/article-valid.html"),
                  content_type="text/html")
    monkeypatch.setattr(wl, "gbrain_put", lambda *a, **k: pytest.fail("dry-run must not write"))

    result = wl.ingest_url("https://x.test/article", dry_run=True)
    assert result.status == "ok"
    assert result.reason == "dry-run"
    assert len(wl.list_queue()) == 0
