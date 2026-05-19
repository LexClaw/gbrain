"""youtube_lib.py -- Core library for the youtube-channel-to-brain recipe.

All importable logic lives here. The entry point is youtube_poll.py.

State convention: ~/.gbrain/integrations/youtube-channel-to-brain/
  channels.yaml, cursor.json, poll.lock, poll.log, heartbeat.jsonl,
  enrichment-queue/<video_id>.json, enrichment-queue/failed/<video_id>.json

Network: RSS feed at https://www.youtube.com/feeds/videos.xml?channel_id=UC...
         (no API key, no quota, last ~15 videos)

Transcripts: yt-dlp --write-auto-sub --skip-download. Whisper fallback is a
config flag only in v1; install deferred.

Exception discipline: catch (yt_dlp/DownloadError, NetworkError,
TranscriptUnavailable, OSError, xml.etree.ElementTree.ParseError) explicitly.
NEVER bare `except Exception`. Bugs must surface.
"""

from __future__ import annotations

import errno
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from contextlib import contextmanager
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

import requests
import yaml

# ---------- Constants ----------

STATE_DIR = Path.home() / ".gbrain" / "integrations" / "youtube-channel-to-brain"
CHANNELS_YAML = STATE_DIR / "channels.yaml"
CURSOR_JSON = STATE_DIR / "cursor.json"
POLL_LOCK = STATE_DIR / "poll.lock"
POLL_LOG = STATE_DIR / "poll.log"
HEARTBEAT = STATE_DIR / "heartbeat.jsonl"
QUEUE_DIR = STATE_DIR / "enrichment-queue"
QUEUE_FAILED_DIR = QUEUE_DIR / "failed"

YT_DLP = os.environ.get("YT_DLP_BIN", str(Path.home() / ".hermes/hermes-agent/venv/bin/yt-dlp"))
GBRAIN_BIN = os.environ.get("GBRAIN_BIN", "gbrain")

MIN_CUES = 3
RSS_URL = "https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
USER_AGENT = "youtube-channel-to-brain/0.1 (+https://github.com/garrytan/gbrain)"
HTTP_TIMEOUT = 20
HTTP_RETRIES = 3
ATOM_NS = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015",
           "media": "http://search.yahoo.com/mrss/"}

# ---------- Errors ----------


class NetworkError(RuntimeError):
    pass


class TranscriptUnavailable(RuntimeError):
    pass


class ChannelResolutionError(RuntimeError):
    pass


class DownloadError(RuntimeError):
    """Local shim so callers can catch yt-dlp failures without importing yt_dlp."""
    pass


# ---------- Logging ----------


def log(msg: str, *, level: str = "INFO") -> None:
    POLL_LOG.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    line = f"{ts} [{level}] {msg}\n"
    try:
        with POLL_LOG.open("a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass
    print(line, end="", file=sys.stderr)


def heartbeat(event: str, **fields) -> None:
    HEARTBEAT.parent.mkdir(parents=True, exist_ok=True)
    payload = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "event": event}
    payload.update(fields)
    try:
        with HEARTBEAT.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, sort_keys=True) + "\n")
    except OSError as e:
        log(f"heartbeat write failed: {e}", level="WARN")


# ---------- Lockfile ----------


@contextmanager
def poll_lock(path: Path = POLL_LOCK):
    """Non-blocking flock. Yields (acquired: bool). Second runner gets False and should exit 0."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.ftruncate(fd, 0)
            os.write(fd, f"{os.getpid()}\n".encode())
            yield True
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                yield False
            else:
                raise
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(fd)


# ---------- HTTP ----------


def http_get(url: str, *, retries: int = HTTP_RETRIES, session: Optional[requests.Session] = None) -> str:
    sess = session or requests.Session()
    delay = 1.0
    last_exc: Optional[Exception] = None
    for attempt in range(retries):
        try:
            r = sess.get(url, timeout=HTTP_TIMEOUT, headers={"User-Agent": USER_AGENT})
            if r.status_code == 200:
                return r.text
            if 500 <= r.status_code < 600 or r.status_code == 429:
                last_exc = NetworkError(f"HTTP {r.status_code} for {url}")
            else:
                raise NetworkError(f"HTTP {r.status_code} for {url}")
        except requests.RequestException as e:
            last_exc = NetworkError(str(e))
        time.sleep(delay)
        delay *= 2
    assert last_exc is not None
    raise last_exc


# ---------- Channel resolver ----------

_CHANNEL_PATTERNS = [
    re.compile(r'"channelId":"(UC[A-Za-z0-9_-]{20,})"'),
    re.compile(r'"externalId":"(UC[A-Za-z0-9_-]{20,})"'),
    re.compile(r'<meta property="og:url" content="https://www\.youtube\.com/channel/(UC[A-Za-z0-9_-]+)"'),
]


def resolve_channel(handle_or_url: str, *, session: Optional[requests.Session] = None) -> str:
    """Resolve @handle, channel URL, or raw UC... id to a canonical UC... id.

    Direct UC... ids pass through (regex match on full string). Otherwise fetch
    HTML and try 3 patterns in order. Fail loud if all 3 miss.
    """
    s = handle_or_url.strip()
    if re.fullmatch(r"UC[A-Za-z0-9_-]{20,}", s):
        return s

    if s.startswith("@"):
        url = f"https://www.youtube.com/{s}"
    elif s.startswith("http"):
        url = s
    else:
        url = f"https://www.youtube.com/@{s}"

    html = http_get(url, session=session)
    for pat in _CHANNEL_PATTERNS:
        m = pat.search(html)
        if m:
            return m.group(1)
    raise ChannelResolutionError(
        f"Could not resolve channel id from {url}. All 3 patterns missed; "
        "YouTube markup may have drifted. Inspect the page source and update _CHANNEL_PATTERNS."
    )


# ---------- RSS feed ----------


@dataclass
class Video:
    video_id: str
    title: str
    url: str
    published: str  # ISO-8601
    channel_id: str
    channel_title: str = ""
    description: str = ""
    duration_seconds: int = 0
    is_premiere: bool = False  # not directly in standard RSS; reserved for media:status="upcoming"


def parse_rss(xml_text: str) -> list[Video]:
    """Parse the YouTube channel RSS Atom feed. Returns videos in feed order
    (YouTube returns newest-first; caller should reverse for chronological).

    Raises xml.etree.ElementTree.ParseError on malformed XML (NOT swallowed here).
    """
    root = ET.fromstring(xml_text)
    out: list[Video] = []
    channel_title = ""
    ct = root.find("a:title", ATOM_NS)
    if ct is not None and ct.text:
        channel_title = ct.text.strip()
    for entry in root.findall("a:entry", ATOM_NS):
        vid_el = entry.find("yt:videoId", ATOM_NS)
        ch_el = entry.find("yt:channelId", ATOM_NS)
        t_el = entry.find("a:title", ATOM_NS)
        p_el = entry.find("a:published", ATOM_NS)
        link_el = entry.find("a:link", ATOM_NS)
        media_desc = entry.find("media:group/media:description", ATOM_NS)
        if vid_el is None or t_el is None or p_el is None:
            continue
        video_id = (vid_el.text or "").strip()
        if not video_id:
            continue
        url = (link_el.get("href") if link_el is not None else None) or f"https://www.youtube.com/watch?v={video_id}"
        # Check for premiere/upcoming. The Atom feed does not always include
        # media:status; we defensively look for it.
        status_el = entry.find("media:group/media:status", ATOM_NS)
        is_premiere = False
        if status_el is not None and (status_el.get("state") or "").lower() in ("upcoming", "scheduled"):
            is_premiere = True
        out.append(Video(
            video_id=video_id,
            title=(t_el.text or "").strip(),
            url=url,
            published=(p_el.text or "").strip(),
            channel_id=(ch_el.text or "").strip() if ch_el is not None else "",
            channel_title=channel_title,
            description=(media_desc.text or "").strip() if media_desc is not None and media_desc.text else "",
            is_premiere=is_premiere,
        ))
    return out


def fetch_rss(channel_id: str, *, session: Optional[requests.Session] = None) -> list[Video]:
    text = http_get(RSS_URL.format(channel_id=channel_id), session=session)
    return parse_rss(text)


# ---------- Cursor ----------


@dataclass
class ChannelCursor:
    handle: str = ""
    last_video_id: str = ""
    last_polled: str = ""
    last_success: str = ""
    consecutive_failures: int = 0


def load_cursor() -> dict[str, ChannelCursor]:
    """Read cursor.json. Returns empty dict if file missing.

    Raises OSError on read failure or json.JSONDecodeError on corruption.
    Per Grant gate: do NOT auto-repair. Fail loud, surface to gbrain doctor.
    """
    if not CURSOR_JSON.exists():
        return {}
    raw = CURSOR_JSON.read_text(encoding="utf-8")
    data = json.loads(raw)
    out: dict[str, ChannelCursor] = {}
    for cid, fields in (data.get("channels") or {}).items():
        out[cid] = ChannelCursor(**{k: fields.get(k, "") if k != "consecutive_failures" else fields.get(k, 0)
                                    for k in ChannelCursor.__dataclass_fields__.keys()})
    return out


def save_cursor(cursors: dict[str, ChannelCursor]) -> None:
    """Atomic write: tmp + fsync + rename."""
    CURSOR_JSON.parent.mkdir(parents=True, exist_ok=True)
    payload = {"channels": {cid: asdict(c) for cid, c in cursors.items()}}
    tmp_fd, tmp_path = tempfile.mkstemp(prefix=".cursor.", suffix=".tmp", dir=str(CURSOR_JSON.parent))
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, CURSOR_JSON)
    except OSError:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ---------- Channels config ----------


@dataclass
class ChannelConfig:
    handle: str
    channel_id: str
    author_slug: str
    poll_interval_hours: int = 4
    transcript_fallback: str = "skip"
    min_duration_seconds: int = 60


def load_channels() -> list[ChannelConfig]:
    if not CHANNELS_YAML.exists():
        return []
    data = yaml.safe_load(CHANNELS_YAML.read_text(encoding="utf-8")) or {}
    out: list[ChannelConfig] = []
    for c in data.get("channels", []) or []:
        out.append(ChannelConfig(
            handle=c["handle"],
            channel_id=c["channel_id"],
            author_slug=c["author_slug"],
            poll_interval_hours=int(c.get("poll_interval_hours", 4)),
            transcript_fallback=c.get("transcript_fallback", "skip"),
            min_duration_seconds=int(c.get("min_duration_seconds", 60)),
        ))
    return out


def save_channels(channels: list[ChannelConfig]) -> None:
    CHANNELS_YAML.parent.mkdir(parents=True, exist_ok=True)
    payload = {"channels": [asdict(c) for c in channels]}
    tmp_fd, tmp_path = tempfile.mkstemp(prefix=".channels.", suffix=".tmp", dir=str(CHANNELS_YAML.parent))
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            yaml.safe_dump(payload, f, sort_keys=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, CHANNELS_YAML)
    except OSError:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def subscribe(handle: str, *, session: Optional[requests.Session] = None) -> ChannelConfig:
    """Add (or refresh) a channel subscription. Idempotent on duplicate handle."""
    channel_id = resolve_channel(handle, session=session)
    author_slug = _slugify(handle.lstrip("@"))
    existing = load_channels()
    for c in existing:
        if c.handle.lower() == handle.lower() or c.channel_id == channel_id:
            c.channel_id = channel_id
            c.author_slug = author_slug
            save_channels(existing)
            return c
    new = ChannelConfig(handle=handle, channel_id=channel_id, author_slug=author_slug)
    existing.append(new)
    save_channels(existing)
    return new


# ---------- Transcript ----------


def _run_yt_dlp_subs(video_url: str, *, lang: str = "en", auto: bool, out_dir: Path) -> Optional[Path]:
    """Invoke yt-dlp to fetch subtitles (no media download). Returns the .vtt path or None."""
    out_dir.mkdir(parents=True, exist_ok=True)
    args = [
        YT_DLP, "--skip-download",
        "--sub-lang", lang,
        "--sub-format", "vtt",
        "--no-warnings",
        "-o", str(out_dir / "%(id)s.%(ext)s"),
        video_url,
    ]
    if auto:
        args.insert(2, "--write-auto-sub")
    else:
        args.insert(2, "--write-sub")
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise DownloadError(f"yt-dlp invocation failed: {e}") from e
    if proc.returncode != 0:
        raise DownloadError(f"yt-dlp exit {proc.returncode}: {proc.stderr.strip()[:500]}")
    candidates = sorted(out_dir.glob("*.vtt"))
    return candidates[0] if candidates else None


def count_cues(vtt_path: Path) -> int:
    """Count non-empty cue blocks in a WebVTT file. Empty/whitespace-only VTT returns 0."""
    if not vtt_path.exists():
        return 0
    try:
        text = vtt_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return 0
    return _count_cues_in_text(text)


def _count_cues_in_text(text: str) -> int:
    n = 0
    for line in text.splitlines():
        if "-->" in line:
            n += 1
    return n


def vtt_to_plain_text(vtt_path: Path) -> str:
    """Strip VTT timing and tags. Returns clean text, paragraphs separated by blank lines."""
    if not vtt_path.exists():
        return ""
    raw = vtt_path.read_text(encoding="utf-8", errors="replace")
    lines: list[str] = []
    skip_header = True
    last = ""
    for line in raw.splitlines():
        if skip_header:
            if line.strip().startswith("WEBVTT") or line.strip() == "" or line.strip().startswith("Kind:") or line.strip().startswith("Language:"):
                continue
            skip_header = False
        if "-->" in line:
            continue
        if line.strip().isdigit():
            continue
        # strip inline tags like <c> and <00:00:01.000>
        clean = re.sub(r"<[^>]+>", "", line).strip()
        if not clean:
            continue
        # de-dup adjacent identical lines (YT auto-CC repeats cues)
        if clean == last:
            continue
        lines.append(clean)
        last = clean
    return "\n".join(lines)


def fetch_transcript(video: Video, *, fallback: str = "skip", workdir: Optional[Path] = None) -> tuple[Optional[Path], Optional[str]]:
    """Tiered transcript fetch. Returns (vtt_path, plain_text) or (None, None).

    Tier 1: auto-CC. Tier 2: manual CC. Tier 3: whisper (opt-in only, default off).
    Empty VTT (< MIN_CUES) treated as miss and falls through.
    """
    workdir = workdir or Path(tempfile.mkdtemp(prefix="yt-channel-"))
    # Tier 1: auto
    try:
        vtt = _run_yt_dlp_subs(video.url, lang="en", auto=True, out_dir=workdir)
        if vtt and count_cues(vtt) >= MIN_CUES:
            return vtt, vtt_to_plain_text(vtt)
        if vtt:
            try:
                vtt.unlink()
            except OSError:
                pass
    except DownloadError as e:
        log(f"tier1 auto-CC failed for {video.video_id}: {e}", level="WARN")

    # Tier 2: manual
    try:
        vtt = _run_yt_dlp_subs(video.url, lang="en", auto=False, out_dir=workdir)
        if vtt and count_cues(vtt) >= MIN_CUES:
            return vtt, vtt_to_plain_text(vtt)
        if vtt:
            try:
                vtt.unlink()
            except OSError:
                pass
    except DownloadError as e:
        log(f"tier2 manual CC failed for {video.video_id}: {e}", level="WARN")

    # Tier 3: whisper (opt-in)
    if fallback == "whisper":
        if not shutil.which("whisper"):
            raise TranscriptUnavailable(
                "transcript_fallback=whisper but `whisper` is not on PATH. Install or revert to skip."
            )
        # Real implementation would download audio + run whisper. v1: deferred.
        log(f"whisper fallback configured but not implemented in v1 for {video.video_id}", level="WARN")
        return None, None

    return None, None


# ---------- Page writer ----------


def _slugify(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-") or "untitled"


def build_page(video: Video, channel: ChannelConfig, transcript: Optional[str], *, ingested_at: str) -> tuple[str, str]:
    """Build (slug, markdown) for a video page.

    Slug shape: sources/youtube/<channel-slug>/<YYYY-MM-DD>-<video-id>-<title-slug>
    """
    pub_date = (video.published or ingested_at)[:10]
    title_slug = _slugify(video.title)[:60]
    # FIX: gbrain put rejects slugs with uppercase letters (parses as tag names).
    # YouTube video_ids are case-sensitive but we only need a unique identifier in
    # the slug; the canonical video_id is preserved in frontmatter + url.
    vid_for_slug = video.video_id.lower()
    slug = f"sources/youtube/{channel.author_slug}/{pub_date}-{vid_for_slug}-{title_slug}"

    status = "pending_enrichment" if transcript else "transcript_unavailable"
    fm_lines = [
        "---",
        f'title: "{_yaml_str(video.title)}"',
        "type: source",
        "source_type: youtube",
        f'channel: "{channel.handle}"',
        f'channel_id: "{video.channel_id or channel.channel_id}"',
        f'video_id: "{video.video_id}"',
        f'url: "{video.url}"',
        f"duration_seconds: {int(video.duration_seconds)}",
        f'published: "{video.published}"',
        f'ingested: "{ingested_at}"',
        f"author: people/{channel.author_slug}",
        f"status: {status}",
        "tags: [youtube, source, video]",
        "---",
        "",
        f"# {video.title}",
        "",
        f"Source video: [{video.url}]({video.url})  ",
        f"Channel: {channel.handle}  ",
        f"Published: {video.published}  ",
        f"Author: [[people/{channel.author_slug}]]",
        "",
        "## Video metadata",
        "",
        f"- title: {video.title}",
        f"- video_id: {video.video_id}",
        f"- url: {video.url}",
        f"- channel_id: {video.channel_id or channel.channel_id}",
        f"- duration_seconds: {int(video.duration_seconds)}",
        f"- published: {video.published}",
        "",
    ]
    if video.description:
        fm_lines += ["## RSS description", "", video.description, ""]

    if transcript:
        fm_lines += [
            "## Raw transcript",
            "",
            "```",
            transcript.strip(),
            "```",
            "",
        ]
    else:
        fm_lines += [
            "## Raw transcript",
            "",
            "_Transcript unavailable. Tier 1 (auto-CC) and Tier 2 (manual CC) both missed; "
            "Tier 3 (whisper) disabled by config. Re-poll or enable whisper fallback._",
            "",
        ]

    fm_lines += [
        "## Enrichment instructions",
        "",
        f"This page is in status `{status}`. The `media-ingest` skill should:",
        "",
        "1. Read the raw transcript (above) and extract a concise 5 to 10 bullet summary",
        "2. Identify every person and company mentioned and create or back-link people/ and companies/ pages",
        f"3. Update [[people/{channel.author_slug}]] with a timeline entry pointing at this page",
        "4. Set `status: enriched` in the frontmatter when done",
        "5. Follow the media-ingest filing rules: primary subject relocation if the video is overwhelmingly about one entity",
        "",
    ]
    return slug, "\n".join(fm_lines)


def _yaml_str(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def gbrain_put(slug: str, content: str, *, bin: str = GBRAIN_BIN) -> None:
    """Write a page via `gbrain put`. Raises DownloadError on nonzero exit (callers must catch)."""
    try:
        proc = subprocess.run(
            [bin, "put", slug, "--content", content],
            capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        raise DownloadError(f"gbrain put failed to invoke: {e}") from e
    if proc.returncode != 0:
        raise DownloadError(f"gbrain put {slug} exit {proc.returncode}: {proc.stderr.strip()[:500]}")


def gbrain_upload_raw(file_path: Path, slug: str, *, bin: str = GBRAIN_BIN) -> bool:
    """Upload a raw file as a sidecar. Returns True on success, False on nonzero exit (logged)."""
    try:
        proc = subprocess.run(
            [bin, "files", "upload-raw", str(file_path), "--page", slug],
            capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        log(f"gbrain files upload-raw invoke failed: {e}", level="WARN")
        return False
    if proc.returncode != 0:
        log(f"gbrain files upload-raw {file_path} -> {slug} exit {proc.returncode}: {proc.stderr.strip()[:300]}", level="WARN")
        return False
    return True


# ---------- Enrichment queue ----------


def enqueue_enrichment(video: Video, channel: ChannelConfig, page_slug: str, transcript: Optional[str]) -> Path:
    """Drop a queue file for the enrich cron to consume. Idempotent: overwrites prior file for same video_id."""
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    QUEUE_FAILED_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "video_id": video.video_id,
        "video_url": video.url,
        "page_slug": page_slug,
        "channel_handle": channel.handle,
        "channel_id": channel.channel_id,
        "author_slug": channel.author_slug,
        "title": video.title,
        "published": video.published,
        "has_transcript": bool(transcript),
        "transcript_excerpt": (transcript or "")[:2000],
        "queued_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    target = QUEUE_DIR / f"{video.video_id}.json"
    tmp_fd, tmp_path = tempfile.mkstemp(prefix=f".{video.video_id}.", suffix=".tmp", dir=str(QUEUE_DIR))
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, target)
    except OSError:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    return target


def list_queue() -> list[Path]:
    if not QUEUE_DIR.exists():
        return []
    return sorted(p for p in QUEUE_DIR.glob("*.json") if p.parent == QUEUE_DIR)


def move_to_failed(queue_file: Path, reason: str) -> Path:
    QUEUE_FAILED_DIR.mkdir(parents=True, exist_ok=True)
    target = QUEUE_FAILED_DIR / queue_file.name
    try:
        data = json.loads(queue_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = {"raw": queue_file.read_text(encoding="utf-8", errors="replace")}
    data["_failure_reason"] = reason
    data["_failed_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    target.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
    try:
        queue_file.unlink()
    except OSError:
        pass
    return target


# ---------- Author page bootstrap ----------


def ensure_author_page(channel: ChannelConfig, *, bin: str = GBRAIN_BIN) -> None:
    """Create a minimal people/<author-slug> page if missing. Idempotent.

    The media-ingest enrichment subagent enriches this page; we just guarantee
    it exists so video pages can back-link to it.
    """
    slug = f"people/{channel.author_slug}"
    try:
        proc = subprocess.run([bin, "get", slug], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return
    if proc.returncode == 0 and proc.stdout.strip():
        return  # already exists
    name = channel.handle.lstrip("@")
    content = "\n".join([
        "---",
        f'title: "{name}"',
        "type: person",
        f'youtube_handle: "{channel.handle}"',
        f'youtube_channel_id: "{channel.channel_id}"',
        "tags: [person, youtube-author]",
        "---",
        "",
        f"# {name}",
        "",
        f"YouTube creator. Channel: {channel.handle} ({channel.channel_id}).",
        "",
        "_Stub page created by the youtube-channel-to-brain recipe. The media-ingest "
        "skill enriches this page as videos arrive._",
        "",
        "## Videos",
        "",
        "_Populated by media-ingest enrichment._",
        "",
    ])
    try:
        gbrain_put(slug, content, bin=bin)
        log(f"created stub people page: {slug}")
    except DownloadError as e:
        log(f"author page bootstrap failed for {slug}: {e}", level="WARN")


# ---------- Poll orchestration ----------


def poll_channel(channel: ChannelConfig, cursors: dict[str, ChannelCursor], *,
                 dry_run: bool = False, session: Optional[requests.Session] = None) -> dict:
    """Poll a single channel. Returns a summary dict for logging.

    Bumps cursor.consecutive_failures on RSS error; does NOT advance last_video_id.
    On success, advances last_video_id to the newest seen and resets failures.
    """
    summary = {
        "channel": channel.handle,
        "channel_id": channel.channel_id,
        "videos_ingested": 0,
        "videos_skipped": 0,
        "errors": [],
        "premiere_skipped": 0,
        "short_skipped": 0,
    }
    cur = cursors.get(channel.channel_id, ChannelCursor(handle=channel.handle))
    cur.handle = channel.handle
    cur.last_polled = datetime.now(timezone.utc).isoformat(timespec="seconds")

    try:
        videos = fetch_rss(channel.channel_id, session=session)
    except (NetworkError, ET.ParseError, OSError) as e:
        cur.consecutive_failures += 1
        cursors[channel.channel_id] = cur
        log(f"RSS fetch failed for {channel.handle}: {e}", level="ERROR")
        summary["errors"].append(f"rss: {e}")
        return summary

    if not videos:
        if cur.last_video_id:
            log(f"RSS empty for {channel.handle} but cursor had {cur.last_video_id}; not advancing", level="WARN")
            summary["errors"].append("rss_empty_after_cursor")
        else:
            log(f"RSS empty for {channel.handle} (first poll, channel has no videos)", level="INFO")
        cursors[channel.channel_id] = cur
        return summary

    # Determine new videos: those published after cur.last_video_id. If cursor is
    # empty (first poll), ingest all visible videos. RSS returns newest-first;
    # we want chronological (oldest-first) for timeline coherence.
    chronological = list(reversed(videos))
    if cur.last_video_id:
        new_videos = []
        seen_cursor = False
        for v in chronological:
            if seen_cursor:
                new_videos.append(v)
            elif v.video_id == cur.last_video_id:
                seen_cursor = True
        if not seen_cursor:
            # Cursor video is no longer in feed (aged out). Treat all as new but log.
            log(f"cursor video {cur.last_video_id} aged out of {channel.handle} feed; ingesting all", level="WARN")
            new_videos = chronological
    else:
        new_videos = chronological

    if not new_videos:
        cur.last_success = cur.last_polled
        cur.consecutive_failures = 0
        cursors[channel.channel_id] = cur
        log(f"no new videos for {channel.handle}")
        return summary

    if not dry_run:
        ensure_author_page(channel)

    latest_id = cur.last_video_id
    workdir_base = Path(tempfile.mkdtemp(prefix="yt-poll-"))
    try:
        for v in new_videos:
            if v.is_premiere:
                summary["premiere_skipped"] += 1
                summary["videos_skipped"] += 1
                log(f"skip premiere: {v.video_id} ({channel.handle})")
                continue
            if channel.min_duration_seconds and v.duration_seconds and v.duration_seconds < channel.min_duration_seconds:
                summary["short_skipped"] += 1
                summary["videos_skipped"] += 1
                log(f"skip short ({v.duration_seconds}s): {v.video_id}")
                continue

            ingested_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
            transcript_path = None
            transcript_text = None
            if not dry_run:
                video_workdir = workdir_base / v.video_id
                try:
                    transcript_path, transcript_text = fetch_transcript(
                        v, fallback=channel.transcript_fallback, workdir=video_workdir,
                    )
                except (DownloadError, TranscriptUnavailable, OSError) as e:
                    log(f"transcript fetch failed for {v.video_id}: {e}", level="WARN")

            slug, content = build_page(v, channel, transcript_text, ingested_at=ingested_at)

            if dry_run:
                log(f"[dry-run] would write {slug}")
                summary["videos_ingested"] += 1
                latest_id = v.video_id
                continue

            try:
                gbrain_put(slug, content)
            except DownloadError as e:
                log(f"gbrain put failed for {slug}: {e}", level="ERROR")
                summary["errors"].append(f"put:{v.video_id}:{e}")
                continue

            if transcript_path is not None:
                gbrain_upload_raw(transcript_path, slug)

            try:
                enqueue_enrichment(v, channel, slug, transcript_text)
            except OSError as e:
                log(f"enqueue_enrichment failed for {v.video_id}: {e}", level="WARN")

            summary["videos_ingested"] += 1
            latest_id = v.video_id
            log(f"ingested {v.video_id} -> {slug}")
    finally:
        try:
            shutil.rmtree(workdir_base, ignore_errors=True)
        except OSError:
            pass

    if latest_id and latest_id != cur.last_video_id:
        cur.last_video_id = latest_id
    cur.last_success = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cur.consecutive_failures = 0
    cursors[channel.channel_id] = cur
    return summary
