"""web_lib.py -- Core library for the web-to-brain recipe.

All importable logic lives here. The entry point is web_fetch.py.

State convention: ~/.gbrain/integrations/web-to-brain/
  fetch.lock, fetch.log, heartbeat.jsonl,
  robots-cache/<host>.json, enrichment-queue/<job_id>.json,
  enrichment-queue/failed/<job_id>.json

Network: HTTP(S) GET with declared UA, 5MB body cap, 30s timeout,
         max 5 redirect hops, loop detection.

Extraction: readability-lxml (Document) for main content.

SPA detection is structural, not length-based (per spec gate 6):
  - Empty known SPA root containers with no rendered children
  - Script bytes / visible text bytes ratio > 10
  - Absence of <article>, <main>, or <p> tags with real text content

Exception discipline: catch (NetworkError, RobotsDisallowed, SPADetected,
PaywallSuspected, BotBlocked, OSError, etree.ParseError) explicitly.
Never bare `except Exception`. Bugs must surface.
"""

from __future__ import annotations

import errno
import fcntl
import gzip
import hashlib
import json
import os
import re
import sys
import tempfile
import time
import urllib.parse
import urllib.robotparser
import xml.etree.ElementTree as ET
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import requests
from bs4 import BeautifulSoup
from readability import Document

# ---------- Constants ----------

VERSION = "0.1.0"

STATE_DIR = Path.home() / ".gbrain" / "integrations" / "web-to-brain"
FETCH_LOCK = STATE_DIR / "fetch.lock"
FETCH_LOG = STATE_DIR / "fetch.log"
HEARTBEAT = STATE_DIR / "heartbeat.jsonl"
ROBOTS_CACHE = STATE_DIR / "robots-cache"
QUEUE_DIR = STATE_DIR / "enrichment-queue"
QUEUE_FAILED_DIR = QUEUE_DIR / "failed"

GBRAIN_BIN = os.environ.get("GBRAIN_BIN", "gbrain")

USER_AGENT = f"gbrain-web-to-brain/{VERSION} (+https://github.com/garrytan/gbrain)"
HTTP_TIMEOUT = 30
HTTP_MAX_BODY = 5 * 1024 * 1024  # 5 MB
HTTP_REDIRECT_CAP = 5
ROBOTS_TTL_SECONDS = 24 * 3600

# SPA detection thresholds. Tuned against tests/fixtures/html/spa-* (positive)
# and short-but-real-* (negative). Do not tweak without re-running the corpus.
SPA_SCRIPT_TEXT_RATIO = 10.0
SPA_KNOWN_ROOT_IDS = {"__next", "root", "app", "__nuxt", "svelte"}
MIN_REAL_P_CHARS = 20

PAYWALL_MARKERS = [
    "subscribe to continue",
    "subscribe to read",
    "to continue reading",
    "create a free account to read",
    "this article is for subscribers",
]

# ---------- Errors ----------


class NetworkError(RuntimeError):
    pass


class RobotsDisallowed(RuntimeError):
    pass


class SPADetected(RuntimeError):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class PaywallSuspected(RuntimeError):
    pass


class BotBlocked(RuntimeError):
    pass


class ContentTooLarge(RuntimeError):
    pass


class UnsupportedContentType(RuntimeError):
    pass


class RedirectLoop(RuntimeError):
    pass


class ExtractionFailed(RuntimeError):
    pass


# ---------- Logging / heartbeat ----------


def log(msg: str, *, level: str = "INFO") -> None:
    FETCH_LOG.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    line = f"{ts} [{level}] {msg}\n"
    try:
        with FETCH_LOG.open("a", encoding="utf-8") as f:
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


def stdout_event(name: str, **fields) -> None:
    """Stdout contract per spec section 5 (mirrors x-to-brain).

    Format: NAME k=v k=v ...
    """
    parts = [name]
    for k, v in fields.items():
        s = str(v)
        if " " in s or "=" in s:
            s = '"' + s.replace('"', '\\"') + '"'
        parts.append(f"{k}={s}")
    print(" ".join(parts), flush=True)


# ---------- Lockfile ----------


@contextmanager
def fetch_lock(path: Path = FETCH_LOCK):
    """Non-blocking flock. Yields (acquired: bool)."""
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


# ---------- URL helpers ----------


def normalize_url(url: str) -> str:
    """Normalize URL: lowercase scheme + host, strip fragment, drop trailing slash on path."""
    parts = urllib.parse.urlsplit(url.strip())
    scheme = parts.scheme.lower() or "https"
    netloc = parts.netloc.lower()
    path = parts.path or "/"
    return urllib.parse.urlunsplit((scheme, netloc, path, parts.query, ""))


def url_host(url: str) -> str:
    return urllib.parse.urlsplit(url).netloc.lower()


def url_to_slug(url: str) -> str:
    """Build a stable slug from a URL.

    sources/web/<host>/<YYYY-MM-DD>-<path-slug>
    Path-slug is a hash-prefixed version when path is empty or only "/".
    """
    parts = urllib.parse.urlsplit(url)
    host = parts.netloc.lower().replace(":", "-")
    path = (parts.path or "/").strip("/")
    if parts.query:
        path = f"{path}-{parts.query}"
    path_slug = _slugify(path) if path else _slugify(host)
    # Short hash suffix guarantees uniqueness for path collisions on same host.
    h = hashlib.sha1(url.encode("utf-8")).hexdigest()[:6]
    return f"{host}/{path_slug}-{h}" if path_slug else f"{host}/{h}"


def _slugify(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:80]


# ---------- HTTP fetch ----------


@dataclass
class FetchResult:
    final_url: str
    status: int
    content_type: str
    body: str
    bytes_read: int
    elapsed_ms: int
    redirect_chain: list[str] = field(default_factory=list)


def _decode_body(raw: bytes, content_type: str) -> str:
    # charset hint
    charset = "utf-8"
    m = re.search(r"charset=([\w\-]+)", content_type or "", re.I)
    if m:
        charset = m.group(1)
    try:
        return raw.decode(charset, errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


def http_fetch(url: str, *, session: Optional[requests.Session] = None,
               max_body: int = HTTP_MAX_BODY,
               max_redirects: int = HTTP_REDIRECT_CAP) -> FetchResult:
    """Fetch a URL with declared UA. Follows redirects manually for loop detection.

    Returns FetchResult on 2xx HTML/text response.
    Raises NetworkError for non-2xx, RedirectLoop for redirect cycles,
    UnsupportedContentType for non-HTML, ContentTooLarge for >max_body,
    BotBlocked when Cloudflare 1020 / specific bot-block signatures detected.
    """
    sess = session or requests.Session()
    seen: list[str] = []
    current = url
    t0 = time.time()
    for hop in range(max_redirects + 1):
        seen.append(current)
        try:
            r = sess.get(
                current,
                timeout=HTTP_TIMEOUT,
                headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1"},
                allow_redirects=False,
                stream=True,
            )
        except requests.RequestException as e:
            raise NetworkError(f"request failed for {current}: {e}") from e

        if r.status_code in (301, 302, 303, 307, 308):
            loc = r.headers.get("Location")
            if not loc:
                raise NetworkError(f"redirect status {r.status_code} with no Location for {current}")
            nxt = urllib.parse.urljoin(current, loc)
            if nxt in seen:
                raise RedirectLoop(f"redirect loop detected: {seen + [nxt]}")
            current = nxt
            r.close()
            continue

        if r.status_code >= 400:
            # Cloudflare bot-block markers: 403 + cf-mitigated header, or
            # 1020 errors in the body. Surfaces in fetch.log as BOT_BLOCKED.
            cf_mitigated = (r.headers.get("cf-mitigated") or "").lower()
            body_peek = b""
            try:
                body_peek = r.raw.read(2048, decode_content=True) or b""
            except (OSError, requests.RequestException):
                body_peek = b""
            if r.status_code == 403 and (cf_mitigated == "challenge" or b"error code: 1020" in body_peek.lower()):
                raise BotBlocked(f"cloudflare bot-block on {current}")
            raise NetworkError(f"HTTP {r.status_code} for {current}")

        ct = r.headers.get("Content-Type", "")
        if "html" not in ct.lower() and "text/plain" not in ct.lower() and "text" not in ct.lower():
            # accept text/* and text/html; reject application/pdf, image/*, video/*, etc.
            raise UnsupportedContentType(f"content-type={ct} for {current}")

        # Read with size cap. Handle gzip transparently (requests does this
        # when stream=True only if Content-Encoding header is present and
        # we read via iter_content).
        chunks: list[bytes] = []
        total = 0
        try:
            for chunk in r.iter_content(chunk_size=65536, decode_unicode=False):
                if not chunk:
                    continue
                total += len(chunk)
                if total > max_body:
                    raise ContentTooLarge(f"body exceeded {max_body} bytes for {current}")
                chunks.append(chunk)
        except requests.RequestException as e:
            raise NetworkError(f"body read failed for {current}: {e}") from e
        raw = b"".join(chunks)
        # If Content-Encoding wasn't auto-decoded (rare), handle gzip magic.
        if raw[:2] == b"\x1f\x8b":
            try:
                raw = gzip.decompress(raw)
            except OSError as e:
                raise NetworkError(f"gzip decode failed for {current}: {e}") from e
        body = _decode_body(raw, ct)
        elapsed = int((time.time() - t0) * 1000)
        return FetchResult(
            final_url=current,
            status=r.status_code,
            content_type=ct,
            body=body,
            bytes_read=total,
            elapsed_ms=elapsed,
            redirect_chain=seen,
        )
    raise NetworkError(f"exceeded {max_redirects} redirect hops starting at {url}")


# ---------- robots.txt ----------


@dataclass
class RobotsRecord:
    host: str
    allowed_paths: dict  # path -> bool, small cache. We mainly call allowed() per URL.
    crawl_delay: Optional[float]
    fetched_at: float
    raw: str = ""


def _robots_cache_path(host: str) -> Path:
    safe = host.replace(":", "-").replace("/", "-")
    return ROBOTS_CACHE / f"{safe}.json"


def load_robots(host: str, *, session: Optional[requests.Session] = None,
                ttl: int = ROBOTS_TTL_SECONDS,
                _now: Optional[float] = None) -> Optional[urllib.robotparser.RobotFileParser]:
    """Return a RobotFileParser for host, hitting cache when fresh.

    None means robots.txt was unreachable or missing (treat as allow per RFC).
    Cache is JSON with the raw robots body; we re-parse on read to avoid
    pickling the parser.
    """
    now = _now if _now is not None else time.time()
    cache = _robots_cache_path(host)
    raw: Optional[str] = None
    if cache.exists():
        try:
            data = json.loads(cache.read_text(encoding="utf-8"))
            if (now - float(data.get("fetched_at", 0))) < ttl:
                raw = data.get("raw")
        except (OSError, json.JSONDecodeError, ValueError):
            raw = None
    if raw is None:
        sess = session or requests.Session()
        url = f"https://{host}/robots.txt"
        try:
            r = sess.get(url, timeout=10, headers={"User-Agent": USER_AGENT})
            if r.status_code == 200:
                raw = r.text[:512 * 1024]  # cap to 512KB
            elif 400 <= r.status_code < 500:
                # 404 = no robots = allow all per RFC.
                raw = ""
            else:
                # 5xx = transient; treat as allow but DO NOT cache.
                return None
        except requests.RequestException:
            return None
        cache.parent.mkdir(parents=True, exist_ok=True)
        try:
            cache.write_text(json.dumps({"fetched_at": now, "raw": raw}, sort_keys=True), encoding="utf-8")
        except OSError as e:
            log(f"robots cache write failed for {host}: {e}", level="WARN")
    rp = urllib.robotparser.RobotFileParser()
    rp.parse((raw or "").splitlines())
    return rp


def robots_allows(url: str, *, session: Optional[requests.Session] = None,
                  ua: str = USER_AGENT) -> bool:
    host = url_host(url)
    rp = load_robots(host, session=session)
    if rp is None:
        return True  # robots unreachable = allow per RFC
    return rp.can_fetch(ua, url)


def robots_crawl_delay(url: str, *, session: Optional[requests.Session] = None,
                       ua: str = USER_AGENT) -> Optional[float]:
    host = url_host(url)
    rp = load_robots(host, session=session)
    if rp is None:
        return None
    try:
        return rp.crawl_delay(ua)
    except AttributeError:
        return None


# ---------- SPA detection (structural; spec gate 6) ----------


@dataclass
class SPACheck:
    is_spa: bool
    reason: str = ""
    script_bytes: int = 0
    text_bytes: int = 0
    has_article: bool = False
    has_main: bool = False
    real_p_count: int = 0


def detect_spa(html: str) -> SPACheck:
    """Structural SPA detection.

    Returns SPACheck. is_spa True ONLY when at least one of:
      A) Known SPA root div is empty (no child elements with real text), AND
         no <article>/<main> with real <p> text elsewhere.
      B) Script bytes / visible text bytes ratio > SPA_SCRIPT_TEXT_RATIO AND
         no <article>/<main> with real <p> text AND real_p_count == 0.
      C) No <article>, no <main>, no <p> > MIN_REAL_P_CHARS chars anywhere.

    Length of extracted content is NOT a signal here. Short-but-real pages
    pass because they retain <article>/<main>/<p> structure.
    """
    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception as e:  # lxml ParserError isn't bare-exception worth catching
        return SPACheck(is_spa=True, reason=f"parser-error:{type(e).__name__}")

    # script size
    script_bytes = sum(len((s.string or "")) + len(str(s.get("src") or "")) for s in soup.find_all("script"))
    # visible text bytes (rough: text content excluding script/style)
    for tag in soup(["script", "style", "noscript", "template"]):
        tag.extract()
    text_bytes = len(soup.get_text(separator=" ", strip=True))

    has_article = bool(soup.find("article"))
    has_main = bool(soup.find("main"))
    real_p_count = 0
    for p in soup.find_all("p"):
        if len((p.get_text(strip=True) or "")) >= MIN_REAL_P_CHARS:
            real_p_count += 1

    # A) Known SPA root container empty
    for root_id in SPA_KNOWN_ROOT_IDS:
        root = soup.find(id=root_id)
        if root is not None:
            child_text = root.get_text(strip=True)
            child_elements = [c for c in root.find_all(True, recursive=False)]
            if not child_text and not child_elements:
                if not (has_article or has_main) and real_p_count == 0:
                    return SPACheck(
                        is_spa=True,
                        reason=f"empty-root:#{root_id}",
                        script_bytes=script_bytes,
                        text_bytes=text_bytes,
                        has_article=has_article,
                        has_main=has_main,
                        real_p_count=real_p_count,
                    )

    # B) script/text ratio AND no structured content AND no real p
    if text_bytes > 0:
        ratio = script_bytes / max(text_bytes, 1)
    else:
        ratio = float("inf") if script_bytes > 0 else 0.0
    if ratio > SPA_SCRIPT_TEXT_RATIO and not (has_article or has_main) and real_p_count == 0:
        return SPACheck(
            is_spa=True,
            reason=f"script-ratio:{ratio:.1f}",
            script_bytes=script_bytes,
            text_bytes=text_bytes,
            has_article=has_article,
            has_main=has_main,
            real_p_count=real_p_count,
        )

    # C) No structural content anywhere
    if not has_article and not has_main and real_p_count == 0:
        return SPACheck(
            is_spa=True,
            reason="no-content",
            script_bytes=script_bytes,
            text_bytes=text_bytes,
            has_article=has_article,
            has_main=has_main,
            real_p_count=real_p_count,
        )

    return SPACheck(
        is_spa=False,
        reason="",
        script_bytes=script_bytes,
        text_bytes=text_bytes,
        has_article=has_article,
        has_main=has_main,
        real_p_count=real_p_count,
    )


# ---------- Readability extraction ----------


@dataclass
class Extracted:
    title: str
    byline: str
    text: str  # plain text body
    html: str  # readability-cleaned HTML body
    likely_paywall: bool = False


def extract_content(html: str) -> Extracted:
    """Run Readability over html. Returns Extracted.

    Raises ExtractionFailed when no usable content surfaces.
    """
    try:
        doc = Document(html)
        title = (doc.short_title() or doc.title() or "").strip()
        summary_html = doc.summary(html_partial=True)
    except Exception as e:
        raise ExtractionFailed(f"readability failed: {e}") from e

    soup = BeautifulSoup(summary_html, "lxml")
    text = soup.get_text(separator="\n", strip=True)
    # Byline heuristic: first <p> or <span> with "by " prefix, or meta[name=author].
    byline = ""
    head_soup = BeautifulSoup(html, "lxml")
    meta_author = head_soup.find("meta", attrs={"name": "author"})
    if meta_author and meta_author.get("content"):
        byline = meta_author["content"].strip()
    if not byline:
        for el in head_soup.find_all(["p", "span", "div"], class_=re.compile(r"byline|author", re.I)):
            t = (el.get_text(strip=True) or "")
            if t:
                byline = t
                break

    if not text.strip():
        raise ExtractionFailed("readability returned empty body")

    lowered = text.lower()
    likely_paywall = any(m in lowered for m in PAYWALL_MARKERS)

    return Extracted(title=title, byline=byline, text=text, html=summary_html, likely_paywall=likely_paywall)


# ---------- Draft page writer ----------


def build_draft_page(url: str, final_url: str, extracted: Extracted, *,
                     fetched_at: str, slug_override: Optional[str] = None,
                     bytes_read: int = 0) -> tuple[str, str]:
    """Build (slug, markdown) for a draft web page.

    Default slug: sources/web/<host>/<YYYY-MM-DD>-<path-slug>-<hash>
    With slug_override: sources/web/<host>/<override>  (override is appended
    so canonical entity routing happens at enrichment, not in the collector).
    """
    host = url_host(final_url)
    host_slug = host.replace(":", "-").replace(".", "-")
    date = fetched_at[:10]
    if slug_override:
        slug = f"sources/web/{host_slug}/{date}-{_slugify(slug_override)}"
    else:
        parts = urllib.parse.urlsplit(final_url)
        path = (parts.path or "/").strip("/")
        if parts.query:
            path = f"{path}-{parts.query}"
        path_slug = _slugify(path) if path else "index"
        h = hashlib.sha1(final_url.encode("utf-8")).hexdigest()[:6]
        slug = f"sources/web/{host_slug}/{date}-{path_slug}-{h}"

    title = extracted.title or url
    paywall_flag = "true" if extracted.likely_paywall else "false"
    fm_lines = [
        "---",
        f'title: "{_yaml_str(title)}"',
        "type: source",
        "source_type: web",
        f'url: "{final_url}"',
        f'original_url: "{url}"' if final_url != url else f'url: "{final_url}"',
        f'host: "{host}"',
        f'fetched: "{fetched_at}"',
        f"bytes: {int(bytes_read)}",
        f"likely_paywall: {paywall_flag}",
        f'byline: "{_yaml_str(extracted.byline)}"' if extracted.byline else 'byline: ""',
        "status: pending_enrichment",
        "tags: [web, source]",
        "---",
        "",
        f"# {title}",
        "",
        f"[Source: {host}, {final_url}, {fetched_at[:10]}]",
        "",
    ]
    if extracted.byline:
        fm_lines.append(f"Byline: {extracted.byline}")
        fm_lines.append("")
    if extracted.likely_paywall:
        fm_lines.append("_Note: likely paywall detected. Extracted teaser only._")
        fm_lines.append("")
    fm_lines.append("## Content")
    fm_lines.append("")
    fm_lines.append(extracted.text.strip())
    fm_lines.append("")
    fm_lines.append("## Enrichment instructions")
    fm_lines.append("")
    fm_lines.append("This page is `status: pending_enrichment`. The `ingest` skill should:")
    fm_lines.append("")
    fm_lines.append("1. Read this page in full.")
    fm_lines.append("2. Identify every person and company. Create or back-link `people/<slug>` and `companies/<slug>` pages per `skills/_brain-filing-rules.md`.")
    fm_lines.append("3. Add a timeline entry on each linked entity pointing at this page.")
    fm_lines.append("4. If the page is overwhelmingly ABOUT one entity, relocate it under that entity following media-ingest primary-subject rules.")
    fm_lines.append("5. Set frontmatter `status: enriched` and add `enriched_at: <iso>` then write back with `gbrain put`.")
    fm_lines.append("")
    return slug, "\n".join(fm_lines)


def _yaml_str(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


# ---------- gbrain CLI wrappers ----------


def gbrain_get_exists(slug: str, *, bin: str = GBRAIN_BIN) -> bool:
    import subprocess
    try:
        proc = subprocess.run([bin, "get", slug], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0 and bool(proc.stdout.strip())


def gbrain_page_enriched(slug: str, *, bin: str = GBRAIN_BIN) -> bool:
    """True iff the page already exists AND frontmatter carries enriched_at."""
    import subprocess
    try:
        proc = subprocess.run([bin, "get", slug], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return False
    if proc.returncode != 0 or not proc.stdout.strip():
        return False
    return bool(re.search(r"(?m)^enriched_at\s*:", proc.stdout))


def gbrain_put(slug: str, content: str, *, bin: str = GBRAIN_BIN) -> None:
    import subprocess
    try:
        proc = subprocess.run(
            [bin, "put", slug, "--content", content],
            capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        raise NetworkError(f"gbrain put failed to invoke: {e}") from e
    if proc.returncode != 0:
        raise NetworkError(f"gbrain put {slug} exit {proc.returncode}: {proc.stderr.strip()[:500]}")


def gbrain_upload_raw(file_path: Path, slug: str, *, bin: str = GBRAIN_BIN) -> bool:
    import subprocess
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


def enqueue_enrichment(job_id: str, url: str, page_slug: str, *,
                       target_slug_override: Optional[str] = None,
                       title: str = "") -> Path:
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    QUEUE_FAILED_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "job_id": job_id,
        "url": url,
        "page_slug": page_slug,
        "target_slug_override": target_slug_override,
        "title": title,
        "queued_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    target = QUEUE_DIR / f"{job_id}.json"
    tmp_fd, tmp_path = tempfile.mkstemp(prefix=f".{job_id}.", suffix=".tmp", dir=str(QUEUE_DIR))
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
        data = {"raw": queue_file.read_text(encoding="utf-8", errors="replace") if queue_file.exists() else ""}
    data["_failure_reason"] = reason
    data["_failed_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    target.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
    try:
        queue_file.unlink()
    except OSError:
        pass
    return target


# ---------- Job ID ----------


def make_job_id(url: str) -> str:
    """Stable job id per URL so re-runs overwrite the same queue file."""
    return hashlib.sha1(normalize_url(url).encode("utf-8")).hexdigest()[:12]


# ---------- Orchestration: ingest_url ----------


@dataclass
class IngestResult:
    url: str
    final_url: str
    job_id: str
    page_slug: str
    status: str  # ok | skip | fail
    reason: str = ""
    bytes_read: int = 0


def ingest_url(url: str, *, slug_override: Optional[str] = None,
               session: Optional[requests.Session] = None,
               dry_run: bool = False) -> IngestResult:
    """One-shot ingest. Emits stdout contract lines per spec section 5."""
    url = normalize_url(url)
    job_id = make_job_id(url)
    stdout_event("RUN_START", url=url, job_id=job_id)

    host = url_host(url)

    # robots.txt
    try:
        allowed = robots_allows(url, session=session)
    except (OSError,) as e:
        log(f"robots check error for {host}: {e}", level="WARN")
        allowed = True  # fail open per RFC
    stdout_event("ROBOTS_CHECK", host=host, allowed=str(allowed).lower())
    if not allowed:
        stdout_event("ROBOTS_DISALLOW", url=url)
        heartbeat("robots_disallow", url=url, host=host)
        stdout_event("RUN_COMPLETE", job_id=job_id, status="skip", reason="robots_disallowed")
        return IngestResult(url=url, final_url=url, job_id=job_id, page_slug="",
                            status="skip", reason="robots_disallowed")

    # fetch
    try:
        fr = http_fetch(url, session=session)
    except (NetworkError, UnsupportedContentType, ContentTooLarge,
            RedirectLoop, BotBlocked) as e:
        reason = f"{type(e).__name__}:{e}"
        log(reason, level="ERROR")
        heartbeat("fetch_failed", url=url, reason=reason)
        if isinstance(e, BotBlocked):
            stdout_event("BOT_BLOCKED", host=host)
        stdout_event("RUN_COMPLETE", job_id=job_id, status="fail", reason=type(e).__name__)
        return IngestResult(url=url, final_url=url, job_id=job_id, page_slug="",
                            status="fail", reason=reason)

    stdout_event("URL_FETCHED", url=fr.final_url, bytes=fr.bytes_read, ms=fr.elapsed_ms)

    # SPA detection (gate 6)
    spa = detect_spa(fr.body)
    if spa.is_spa:
        stdout_event("SPA_DETECTED", url=fr.final_url, reason=spa.reason)
        heartbeat("spa_detected", url=fr.final_url, reason=spa.reason,
                  script_bytes=spa.script_bytes, text_bytes=spa.text_bytes)
        stdout_event("RUN_COMPLETE", job_id=job_id, status="skip", reason=f"spa:{spa.reason}")
        return IngestResult(url=url, final_url=fr.final_url, job_id=job_id, page_slug="",
                            status="skip", reason=f"spa:{spa.reason}")

    # Readability extract
    try:
        extracted = extract_content(fr.body)
    except ExtractionFailed as e:
        reason = f"extraction:{e}"
        log(reason, level="ERROR")
        heartbeat("extraction_failed", url=fr.final_url, reason=str(e))
        stdout_event("RUN_COMPLETE", job_id=job_id, status="fail", reason="extraction_failed")
        return IngestResult(url=url, final_url=fr.final_url, job_id=job_id, page_slug="",
                            status="fail", reason=reason)

    if extracted.likely_paywall:
        log(f"LIKELY_PAYWALL:{host}", level="WARN")

    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    slug, content = build_draft_page(url, fr.final_url, extracted,
                                     fetched_at=fetched_at, slug_override=slug_override,
                                     bytes_read=fr.bytes_read)

    # Idempotency (gate 2): if page is already enriched, skip without
    # re-writing or re-queuing. Re-ingesting after enrichment is a no-op.
    if not dry_run and gbrain_page_enriched(slug):
        heartbeat("idempotent_skip", url=fr.final_url, page_slug=slug)
        stdout_event("RUN_COMPLETE", job_id=job_id, status="skip", reason="already_enriched")
        return IngestResult(url=url, final_url=fr.final_url, job_id=job_id, page_slug=slug,
                            status="skip", reason="already_enriched")

    if dry_run:
        stdout_event("RUN_COMPLETE", job_id=job_id, status="ok", reason="dry-run")
        return IngestResult(url=url, final_url=fr.final_url, job_id=job_id, page_slug=slug,
                            status="ok", reason="dry-run", bytes_read=fr.bytes_read)

    # Save raw HTML for provenance, then write draft page.
    raw_dir = Path(tempfile.mkdtemp(prefix="web-to-brain-"))
    try:
        raw_path = raw_dir / f"{job_id}.html"
        raw_path.write_text(fr.body, encoding="utf-8", errors="replace")

        gbrain_put(slug, content)
        gbrain_upload_raw(raw_path, slug)

        enqueue_enrichment(job_id, fr.final_url, slug,
                           target_slug_override=slug_override, title=extracted.title)
        stdout_event("ENRICH_QUEUED", job_id=job_id, page=slug)
        heartbeat("ingest_ok", url=fr.final_url, page_slug=slug, bytes=fr.bytes_read)
        stdout_event("RUN_COMPLETE", job_id=job_id, status="ok", reason="enrich_queued")
        return IngestResult(url=url, final_url=fr.final_url, job_id=job_id, page_slug=slug,
                            status="ok", reason="enrich_queued", bytes_read=fr.bytes_read)
    finally:
        # leave raw file in /tmp; gbrain files upload-raw has already copied it
        # into the brain. /tmp is the OS's problem to clean.
        pass
