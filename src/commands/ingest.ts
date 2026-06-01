/**
 * gbrain ingest — recipe entry point for sense ingestion.
 *
 * Subcommands:
 *   gbrain ingest url <url> [--slug <slug>] [--dry-run]
 *     Shell out to recipes/web-to-brain/scripts/web_fetch.py.
 *
 * Mirrors the youtube-channel-to-brain wiring: the recipe owns the
 * implementation (Python), the CLI is a thin dispatcher so the recipe
 * surface lives behind one canonical verb.
 */
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function recipeRoot(recipe: string): string {
  return join(homedir(), 'gbrain', 'recipes', recipe);
}

function runWebFetch(args: string[]): number {
  const root = recipeRoot('web-to-brain');
  const script = join(root, 'scripts', 'web_fetch.py');
  if (!existsSync(script)) {
    console.error(`Recipe not installed: ${script}`);
    return 2;
  }
  const py = process.env.GBRAIN_PYTHON || 'python3';
  const res = spawnSync(py, [script, ...args], {
    stdio: 'inherit',
    cwd: root,
  });
  if (res.error) {
    console.error(`Failed to run web_fetch.py: ${res.error.message}`);
    return 3;
  }
  return res.status ?? 1;
}

function printHelp() {
  console.log(`gbrain ingest — recipe ingestion dispatcher

USAGE
  gbrain ingest url <url> [--slug <canonical-slug>] [--dry-run]
  gbrain ingest url --enrich-queue
  gbrain ingest url --status

EXAMPLES
  gbrain ingest url https://stripe.com/about
  gbrain ingest url https://example.com/post --slug companies/example
  gbrain ingest url https://example.com/post --dry-run

The web-to-brain recipe writes a draft page under sources/web/<host>/<slug>.md
and queues a one-shot Hermes enrichment job. The cron-driven --enrich-queue
drainer dispatches those jobs every 15 minutes.
`);
}

export async function runIngest(args: string[]): Promise<void> {
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return;
  }
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === 'url') {
    // Pass through to web_fetch.py. Single-URL form: first positional becomes --url <u>.
    // Flags (--enrich-queue, --status, --dry-run, --slug) pass straight through.
    const fetchArgs: string[] = [];
    let i = 0;
    while (i < rest.length) {
      const a = rest[i];
      if (a === '--enrich-queue' || a === '--status' || a === '--dry-run') {
        fetchArgs.push(a);
        i += 1;
      } else if (a === '--slug') {
        fetchArgs.push('--slug', rest[i + 1] ?? '');
        i += 2;
      } else if (a.startsWith('--')) {
        fetchArgs.push(a);
        i += 1;
      } else if (!fetchArgs.includes('--url')) {
        fetchArgs.push('--url', a);
        i += 1;
      } else {
        fetchArgs.push(a);
        i += 1;
      }
    }
    if (!fetchArgs.length) {
      printHelp();
      process.exit(1);
    }
    const code = runWebFetch(fetchArgs);
    if (code !== 0) process.exit(code);
    return;
  }

  console.error(`Unknown ingest subcommand: ${sub}`);
  console.error('Run `gbrain ingest --help` for usage.');
  process.exit(1);
}
