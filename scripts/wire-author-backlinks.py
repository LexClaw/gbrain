#!/usr/bin/env python3
"""
Phase 2.1 -- Author backlinks wiring
Card: kn7a4p6cc5hkwg2t2yenyrpqss87jc4k

For every source page that references a person/company/project/entity,
ensure the referenced page has a wikilink back to the source in its
## Sources section. Append-only; never rewrites body.
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime

CHECKPOINT_FILE = "/tmp/reid-w2.1-progress.jsonl"
MAX_WALL_SECONDS = 8 * 60  # 8 minutes
BATCH_SIZE = 50
DB_URL = "postgres://localhost:5432/gbrain"

start_time = time.time()

def elapsed():
    return time.time() - start_time

def psql(query):
    result = subprocess.run(
        ["psql", DB_URL, "-t", "-A", "-F", "\t", "-c", query],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise RuntimeError(f"psql error: {result.stderr}")
    return result.stdout.strip()

def gbrain_get(slug):
    result = subprocess.run(
        ["gbrain", "get", slug],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        return None
    return result.stdout

def gbrain_put(slug, content):
    result = subprocess.run(
        ["gbrain", "put", slug],
        input=content, capture_output=True, text=True
    )
    return result.returncode == 0, result.stderr

def has_wikilink(body, source_slug):
    """Check if a wikilink to source_slug appears anywhere in body."""
    # Match [[source_slug]] or [[source_slug|...]]
    pattern = r'\[\[' + re.escape(source_slug) + r'(\|[^\]]+)?\]\]'
    return bool(re.search(pattern, body))

def append_source_link(body, source_slug):
    """
    Append [[source_slug]] to the ## Sources section.
    Creates the section if it does not exist.
    Append-only; never modifies other sections.
    """
    link = f"- [[{source_slug}]]"
    
    # Check if ## Sources section exists
    sources_match = re.search(r'^## Sources\s*$', body, re.MULTILINE)
    if sources_match:
        # Insert after the ## Sources line (before next ## heading or EOF)
        insert_pos = sources_match.end()
        # Find end of this section
        next_section = re.search(r'^##\s', body[insert_pos:], re.MULTILINE)
        if next_section:
            end_pos = insert_pos + next_section.start()
            # Insert before next section
            section_content = body[insert_pos:end_pos]
            # Append at end of section
            new_section = section_content.rstrip('\n') + '\n' + link + '\n\n'
            return body[:insert_pos] + new_section + body[end_pos:]
        else:
            # Sources is the last section
            return body.rstrip('\n') + '\n' + link + '\n'
    else:
        # No ## Sources section; append to end
        return body.rstrip('\n') + '\n\n## Sources\n\n' + link + '\n'

def load_checkpoint():
    done = set()
    if os.path.exists(CHECKPOINT_FILE):
        with open(CHECKPOINT_FILE) as f:
            for line in f:
                try:
                    rec = json.loads(line)
                    done.add((rec['source_slug'], rec['target_slug']))
                except Exception:
                    pass
    return done

def save_checkpoint(source_slug, target_slug, status):
    with open(CHECKPOINT_FILE, 'a') as f:
        f.write(json.dumps({
            'source_slug': source_slug,
            'target_slug': target_slug,
            'status': status,
            'ts': datetime.utcnow().isoformat()
        }) + '\n')

def get_all_candidates():
    """Return list of (source_slug, target_slug) pairs from all 4 frontmatter keys."""
    rows = []
    
    # 1. author (string)
    raw = psql("""
        SELECT slug, frontmatter->>'author'
        FROM pages
        WHERE slug LIKE 'sources/%/%' AND frontmatter ? 'author'
    """)
    if raw:
        for line in raw.splitlines():
            parts = line.split('\t')
            if len(parts) == 2:
                rows.append((parts[0].strip(), parts[1].strip()))
    
    # 2. companies (array)
    raw = psql("""
        SELECT slug, jsonb_array_elements_text(frontmatter->'companies')
        FROM pages
        WHERE slug LIKE 'sources/%/%' AND frontmatter ? 'companies'
    """)
    if raw:
        for line in raw.splitlines():
            parts = line.split('\t')
            if len(parts) == 2:
                rows.append((parts[0].strip(), parts[1].strip()))
    
    # 3. projects (array) -- currently 0 rows but check anyway
    raw = psql("""
        SELECT slug, jsonb_array_elements_text(frontmatter->'projects')
        FROM pages
        WHERE slug LIKE 'sources/%/%' AND frontmatter ? 'projects'
    """)
    if raw:
        for line in raw.splitlines():
            parts = line.split('\t')
            if len(parts) == 2:
                rows.append((parts[0].strip(), parts[1].strip()))
    
    # 4. entities (array) -- currently 0 rows but check anyway
    raw = psql("""
        SELECT slug, jsonb_array_elements_text(frontmatter->'entities')
        FROM pages
        WHERE slug LIKE 'sources/%/%' AND frontmatter ? 'entities'
    """)
    if raw:
        for line in raw.splitlines():
            parts = line.split('\t')
            if len(parts) == 2:
                rows.append((parts[0].strip(), parts[1].strip()))
    
    return rows

def main():
    print(f"[wire-backlinks] start at {datetime.utcnow().isoformat()}")
    print(f"[wire-backlinks] loading candidates from DB...")
    
    candidates = get_all_candidates()
    print(f"[wire-backlinks] total candidate (source, target) pairs: {len(candidates)}")
    
    done = load_checkpoint()
    if done:
        print(f"[wire-backlinks] resuming -- {len(done)} pairs already in checkpoint")
    
    stats = {
        'wired': 0,
        'already_linked': 0,
        'target_missing': 0,
        'errors': 0,
        'wired_pages': []
    }
    
    total = len(candidates)
    processed = 0
    
    for i, (source_slug, target_slug) in enumerate(candidates):
        # Check wall-clock timeout
        if elapsed() > MAX_WALL_SECONDS:
            print(f"\n[wire-backlinks] TIMEOUT at {elapsed():.1f}s -- checkpointing and exiting cleanly")
            print(f"[wire-backlinks] progress saved to {CHECKPOINT_FILE}")
            break
        
        # Skip if already done
        if (source_slug, target_slug) in done:
            continue
        
        # Progress counter every BATCH_SIZE
        if (i + 1) % BATCH_SIZE == 0:
            print(f"  [{i+1}/{total}] wired={stats['wired']} skipped={stats['already_linked']} missing={stats['target_missing']} elapsed={elapsed():.1f}s")
        
        processed += 1
        
        # Check if target page exists
        target_body = gbrain_get(target_slug)
        if target_body is None:
            stats['target_missing'] += 1
            save_checkpoint(source_slug, target_slug, 'target_missing')
            continue
        
        # Check if wikilink already present
        if has_wikilink(target_body, source_slug):
            stats['already_linked'] += 1
            save_checkpoint(source_slug, target_slug, 'already_linked')
            continue
        
        # Append the link
        new_body = append_source_link(target_body, source_slug)
        ok, err = gbrain_put(target_slug, new_body)
        
        if ok:
            stats['wired'] += 1
            stats['wired_pages'].append({'target': target_slug, 'source': source_slug})
            save_checkpoint(source_slug, target_slug, 'wired')
        else:
            stats['errors'] += 1
            print(f"  ERROR writing {target_slug}: {err[:100]}")
            save_checkpoint(source_slug, target_slug, 'error')
    
    print(f"\n[wire-backlinks] DONE in {elapsed():.1f}s")
    print(f"  wired:          {stats['wired']}")
    print(f"  already_linked: {stats['already_linked']}")
    print(f"  target_missing: {stats['target_missing']}")
    print(f"  errors:         {stats['errors']}")
    print(f"  total processed: {processed}")
    
    # Write stats to a JSON file for the report
    stats_out = {
        'run_ts': datetime.utcnow().isoformat(),
        'elapsed_seconds': elapsed(),
        'total_candidates': len(candidates),
        'wired': stats['wired'],
        'already_linked': stats['already_linked'],
        'target_missing': stats['target_missing'],
        'errors': stats['errors'],
        'sample_wired': stats['wired_pages'][:10]
    }
    with open('/tmp/reid-w2.1-stats.json', 'w') as f:
        json.dump(stats_out, f, indent=2)
    
    print(f"\n[wire-backlinks] stats written to /tmp/reid-w2.1-stats.json")
    return stats

if __name__ == '__main__':
    main()
