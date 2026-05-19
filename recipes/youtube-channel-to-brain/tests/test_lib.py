"""Tests for youtube_lib.py public API.

Mocks: HTTP via `responses`, subprocess (yt-dlp + gbrain CLI) via monkeypatch.
Fixtures: tests/fixtures/{rss,vtt,channel-html}/
"""
from __future__ import annotations

import json
import os
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
import responses

# Make youtube_lib importable
SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture(autouse=True)
def isolate_state(tmp_path, monkeypatch):
    """Redirect STATE_DIR + all derived paths to tmp_path for every test."""
    import youtube_lib as yl
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setattr(yl, "STATE_DIR", state)
    monkeypatch.setattr(yl, "CHANNELS_YAML", state / "channels.yaml")
    monkeypatch.setattr(yl, "CURSOR_JSON", state / "cursor.json")
    monkeypatch.setattr(yl, "POLL_LOCK", state / "poll.lock")
    monkeypatch.setattr(yl, "POLL_LOG", state / "poll.log")
    monkeypatch.setattr(yl, "HEARTBEAT", state / "heartbeat.jsonl")
    monkeypatch.setattr(yl, "QUEUE_DIR", state / "enrichment-queue")
    monkeypatch.setattr(yl, "QUEUE_FAILED_DIR", state / "enrichment-queue" / "failed")
    yield yl


# ---------- resolve_channel ----------


def _read_fixture(rel: str) -> str:
    return (FIXTURES / rel).read_text(encoding="utf-8")


@responses.activate
def test_resolve_channel_passthrough_uc_id(isolate_state):
    yl = isolate_state
    assert yl.resolve_channel("UC0000FIXTUREHORMOZIaa") == "UC0000FIXTUREHORMOZIaa"


@responses.activate
def test_resolve_channel_handle_via_channelId(isolate_state):
    yl = isolate_state
    responses.add(
        responses.GET, "https://www.youtube.com/@AlexHormozi",
        body=_read_fixture("channel-html/hormozi.html"), status=200,
    )
    assert yl.resolve_channel("@AlexHormozi") == "UC0000FIXTUREHORMOZIaa"


@responses.activate
def test_resolve_channel_og_only(isolate_state):
    yl = isolate_state
    responses.add(
        responses.GET, "https://www.youtube.com/@og",
        body=_read_fixture("channel-html/og-only.html"), status=200,
    )
    assert yl.resolve_channel("og") == "UC0000FIXTUREOGaaaaaaaa"


@responses.activate
def test_resolve_channel_external_only(isolate_state):
    yl = isolate_state
    responses.add(
        responses.GET, "https://www.youtube.com/channel/UCabc",
        body=_read_fixture("channel-html/external-only.html"), status=200,
    )
    assert yl.resolve_channel("https://www.youtube.com/channel/UCabc") == "UC0000FIXTUREEXTaaaaaaa"


@responses.activate
def test_resolve_channel_no_match_raises(isolate_state):
    yl = isolate_state
    responses.add(
        responses.GET, "https://www.youtube.com/@nope",
        body=_read_fixture("channel-html/no-match.html"), status=200,
    )
    with pytest.raises(yl.ChannelResolutionError):
        yl.resolve_channel("@nope")


# ---------- http_get retry ----------


@responses.activate
def test_http_get_retries_then_succeeds(isolate_state, monkeypatch):
    yl = isolate_state
    monkeypatch.setattr(yl.time, "sleep", lambda *a, **k: None)
    responses.add(responses.GET, "http://x.test/", status=503)
    responses.add(responses.GET, "http://x.test/", status=200, body="ok")
    assert yl.http_get("http://x.test/", retries=2) == "ok"


@responses.activate
def test_http_get_4xx_fails_fast(isolate_state, monkeypatch):
    yl = isolate_state
    monkeypatch.setattr(yl.time, "sleep", lambda *a, **k: None)
    responses.add(responses.GET, "http://x.test/", status=404)
    with pytest.raises(yl.NetworkError):
        yl.http_get("http://x.test/", retries=3)


# ---------- parse_rss ----------


def test_parse_rss_hormozi(isolate_state):
    yl = isolate_state
    xml_text = _read_fixture("rss/hormozi_2026-05-15.xml")
    videos = yl.parse_rss(xml_text)
    assert len(videos) >= 1
    v = videos[0]
    assert v.video_id
    assert v.url.startswith("https://www.youtube.com/watch?v=")
    assert v.channel_title == "Alex Hormozi"


def test_parse_rss_malformed_raises(isolate_state):
    yl = isolate_state
    with pytest.raises(ET.ParseError):
        yl.parse_rss("<not xml")


# ---------- cursor IO + atomic write ----------


def test_cursor_roundtrip(isolate_state):
    yl = isolate_state
    assert yl.load_cursor() == {}
    cur = yl.ChannelCursor(handle="@A", last_video_id="abc", last_polled="t", last_success="t")
    yl.save_cursor({"UCx": cur})
    loaded = yl.load_cursor()
    assert loaded["UCx"].last_video_id == "abc"


def test_cursor_corrupt_raises(isolate_state):
    yl = isolate_state
    yl.CURSOR_JSON.parent.mkdir(parents=True, exist_ok=True)
    yl.CURSOR_JSON.write_text("{not json", encoding="utf-8")
    with pytest.raises(json.JSONDecodeError):
        yl.load_cursor()


# ---------- channels config + subscribe ----------


@responses.activate
def test_subscribe_new_then_idempotent(isolate_state):
    yl = isolate_state
    responses.add(
        responses.GET, "https://www.youtube.com/@AlexHormozi",
        body=_read_fixture("channel-html/hormozi.html"), status=200,
    )
    c1 = yl.subscribe("@AlexHormozi")
    assert c1.channel_id == "UC0000FIXTUREHORMOZIaa"
    assert c1.author_slug == "alexhormozi"
    # second subscribe with same handle is a no-op (re-resolve allowed)
    responses.add(
        responses.GET, "https://www.youtube.com/@AlexHormozi",
        body=_read_fixture("channel-html/hormozi.html"), status=200,
    )
    c2 = yl.subscribe("@AlexHormozi")
    assert c2.channel_id == c1.channel_id
    assert len(yl.load_channels()) == 1


# ---------- VTT helpers ----------


def test_count_cues_normal(isolate_state):
    yl = isolate_state
    assert yl.count_cues(FIXTURES / "vtt" / "normal.vtt") >= 3


def test_count_cues_empty(isolate_state):
    yl = isolate_state
    assert yl.count_cues(FIXTURES / "vtt" / "empty.vtt") == 0


def test_count_cues_missing_file(isolate_state, tmp_path):
    yl = isolate_state
    assert yl.count_cues(tmp_path / "nope.vtt") == 0


def test_vtt_to_plain_text(isolate_state):
    yl = isolate_state
    txt = yl.vtt_to_plain_text(FIXTURES / "vtt" / "normal.vtt")
    assert "acquisitions" in txt.lower()
    assert "-->" not in txt
    assert "<c>" not in txt


def test_vtt_to_plain_text_missing(isolate_state, tmp_path):
    yl = isolate_state
    assert yl.vtt_to_plain_text(tmp_path / "nope.vtt") == ""


# ---------- fetch_transcript tiered ----------


def test_fetch_transcript_tier1_success(isolate_state, monkeypatch, tmp_path):
    yl = isolate_state
    workdir = tmp_path / "wd"

    def fake_run(args, **kwargs):
        # simulate yt-dlp writing a vtt for tier 1 (auto-sub)
        outdir = Path(args[args.index("-o") + 1]).parent
        outdir.mkdir(parents=True, exist_ok=True)
        (outdir / "vid111.vtt").write_text(
            (FIXTURES / "vtt" / "normal.vtt").read_text(), encoding="utf-8"
        )

        class P:
            returncode = 0
            stderr = ""
        return P()

    monkeypatch.setattr(yl.subprocess, "run", fake_run)
    v = yl.Video(video_id="vid111", title="t", url="https://yt/v?vid111",
                 published="2026-01-01T00:00:00+00:00", channel_id="UCx")
    path, text = yl.fetch_transcript(v, workdir=workdir)
    assert path is not None
    assert "acquisitions" in (text or "").lower()


def test_fetch_transcript_all_tiers_miss_returns_none(isolate_state, monkeypatch, tmp_path):
    yl = isolate_state

    def fake_run(args, **kwargs):
        class P:
            returncode = 1
            stderr = "no subs"
        return P()

    monkeypatch.setattr(yl.subprocess, "run", fake_run)
    v = yl.Video(video_id="vid222", title="t", url="https://yt/v?vid222",
                 published="2026-01-01T00:00:00+00:00", channel_id="UCx")
    path, text = yl.fetch_transcript(v, workdir=tmp_path / "wd")
    assert path is None and text is None


def test_fetch_transcript_whisper_missing_raises(isolate_state, monkeypatch, tmp_path):
    yl = isolate_state

    def fake_run(args, **kwargs):
        class P:
            returncode = 1
            stderr = ""
        return P()
    monkeypatch.setattr(yl.subprocess, "run", fake_run)
    monkeypatch.setattr(yl.shutil, "which", lambda name: None)
    v = yl.Video(video_id="v", title="t", url="u", published="2026-01-01T00:00:00+00:00", channel_id="UCx")
    with pytest.raises(yl.TranscriptUnavailable):
        yl.fetch_transcript(v, fallback="whisper", workdir=tmp_path / "wd")


# ---------- build_page ----------


def test_build_page_with_transcript(isolate_state):
    yl = isolate_state
    v = yl.Video(video_id="abc123", title="My Video!", url="https://yt/v?abc123",
                 published="2026-05-15T12:00:00+00:00", channel_id="UCx",
                 description="Some description")
    ch = yl.ChannelConfig(handle="@AlexHormozi", channel_id="UCx", author_slug="alex-hormozi")
    slug, body = yl.build_page(v, ch, "transcript here", ingested_at="2026-05-15T13:00:00+00:00")
    assert slug.startswith("sources/youtube/alex-hormozi/2026-05-15-abc123-")
    # slug must be all-lowercase (gbrain put rejects uppercase as tag names)
    assert slug == slug.lower()
    assert "pending_enrichment" in body
    assert "transcript here" in body
    assert "[[people/alex-hormozi]]" in body


def test_build_page_without_transcript(isolate_state):
    yl = isolate_state
    v = yl.Video(video_id="abc", title="t", url="u", published="2026-05-15T00:00:00+00:00", channel_id="UCx")
    ch = yl.ChannelConfig(handle="@h", channel_id="UCx", author_slug="h")
    slug, body = yl.build_page(v, ch, None, ingested_at="2026-05-15T00:00:00+00:00")
    assert "transcript_unavailable" in body
    assert "Transcript unavailable" in body


# ---------- enqueue + queue lifecycle ----------


def test_enqueue_and_move_to_failed(isolate_state):
    yl = isolate_state
    v = yl.Video(video_id="vid333", title="t", url="u", published="p", channel_id="UCx")
    ch = yl.ChannelConfig(handle="@h", channel_id="UCx", author_slug="h")
    p = yl.enqueue_enrichment(v, ch, "sources/youtube/h/x", "some text")
    assert p.exists()
    assert yl.list_queue() == [p]
    failed = yl.move_to_failed(p, "test reason")
    assert failed.exists()
    assert not p.exists()
    data = json.loads(failed.read_text())
    assert data["_failure_reason"] == "test reason"


# ---------- poll_channel orchestration ----------


@responses.activate
def test_poll_channel_first_poll_ingests_all(isolate_state, monkeypatch):
    yl = isolate_state
    ch = yl.ChannelConfig(handle="@AlexHormozi", channel_id="UC0000FIXTUREHORMOZIaa",
                          author_slug="alex-hormozi", min_duration_seconds=0)
    responses.add(
        responses.GET,
        yl.RSS_URL.format(channel_id=ch.channel_id),
        body=_read_fixture("rss/hormozi_2026-05-15.xml"), status=200,
    )

    # Stub transcript fetch to return None,None (don't actually run yt-dlp)
    monkeypatch.setattr(yl, "fetch_transcript", lambda v, **kw: (None, None))
    # Stub gbrain put/upload/get
    put_calls = []

    def fake_put(slug, content, bin="gbrain"):
        put_calls.append(slug)
    monkeypatch.setattr(yl, "gbrain_put", fake_put)
    monkeypatch.setattr(yl, "gbrain_upload_raw", lambda *a, **k: True)
    monkeypatch.setattr(yl, "ensure_author_page", lambda *a, **k: None)

    cursors: dict = {}
    summary = yl.poll_channel(ch, cursors)
    assert summary["videos_ingested"] >= 1
    assert ch.channel_id in cursors
    assert cursors[ch.channel_id].last_video_id != ""


@responses.activate
def test_poll_channel_rss_failure_bumps_failures(isolate_state, monkeypatch):
    yl = isolate_state
    monkeypatch.setattr(yl.time, "sleep", lambda *a, **k: None)
    ch = yl.ChannelConfig(handle="@x", channel_id="UCxxx", author_slug="x")
    responses.add(responses.GET, yl.RSS_URL.format(channel_id="UCxxx"), status=500)
    responses.add(responses.GET, yl.RSS_URL.format(channel_id="UCxxx"), status=500)
    responses.add(responses.GET, yl.RSS_URL.format(channel_id="UCxxx"), status=500)
    cursors: dict = {}
    summary = yl.poll_channel(ch, cursors)
    assert summary["errors"]
    assert cursors[ch.channel_id].consecutive_failures == 1


# ---------- lockfile ----------


def test_poll_lock_second_holder_gets_false(isolate_state):
    yl = isolate_state
    with yl.poll_lock() as a:
        assert a is True
        with yl.poll_lock() as b:
            assert b is False
