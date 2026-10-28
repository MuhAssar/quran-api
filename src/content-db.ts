import { createClient, type Client, type InValue } from '@libsql/client';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The split content DBs of the wursha-data repo, one client per target, created on first use
 * (Wursha_QuranHolder specs/data-db-split.md §5). A target names one file:
 * `<target with . → _>_v<N>.db` (`quran` → `quran_v1.db`, `book.tabary` → `book_tabary_v1.db`).
 */

export const TARGET_RE =
  /^(farsh|quran|words\.[a-z0-9]+|book\.[a-z0-9]+|word\.[a-z0-9]+)$/;
const FILE_RE =
  /^(farsh|quran|words_[a-z0-9]+|book_[a-z0-9]+|word_[a-z0-9]+)_v(\d+)\.db$/;

interface Entry {
  url: string;
  version: number;
}

const registry = new Map<string, Entry>();
const clients = new Map<string, Promise<Client>>();
let source: string | undefined;
let urlTemplate: string | undefined;

/** Where the files are looked for, in order: `DB_DIR`, the sibling data build, the app's fetched release. */
export function contentDbDirs(repoRoot: string): string[] {
  const dirs = [
    process.env.DB_DIR?.trim(),
    join(repoRoot, '..', 'wursha-data', 'dist'),
    join(repoRoot, '..', 'Wursha_QuranHolder', '.data-cache', 'current'),
  ];
  return dirs.filter((dir): dir is string => !!dir).map((dir) => resolve(dir));
}

/**
 * Builds the registry from the first folder that has a `quran_v*.db` (folders are never mixed, so
 * all files come from one data release), taking the highest version per target. With
 * `DB_URL_TEMPLATE` (hosted, e.g. `libsql://{target}-org.turso.io`; `.` in the target → `-`) every
 * target is reached through the template instead, and the folder (if any) only lists the targets.
 */
export function openContentDbs(dirs: string[]): {
  source?: string;
  targets: string[];
} {
  urlTemplate = process.env.DB_URL_TEMPLATE?.trim() || undefined;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir, { encoding: 'utf8' });
    if (!names.some((name) => /^quran_v\d+\.db$/.test(name))) continue;
    for (const name of names) {
      const match = FILE_RE.exec(name);
      if (!match) continue;
      const target = match[1].replace('_', '.');
      const version = Number(match[2]);
      if ((registry.get(target)?.version ?? -1) < version) {
        registry.set(target, { url: 'file:' + join(dir, name), version });
      }
    }
    source = dir;
    break;
  }
  return {
    source: urlTemplate ?? source,
    targets: [...registry.keys()].sort(),
  };
}

export function hasTarget(target: string): boolean {
  return registry.has(target) || (!!urlTemplate && TARGET_RE.test(target));
}

/** Keys of the `book.<key>` targets (the books the app can ask for). */
export function getPackKeys(kind: 'book' | 'word'): ReadonlySet<string> {
  return new Set(
    [...registry.keys()]
      .filter((target) => target.startsWith(kind + '.'))
      .map((target) => target.slice(kind.length + 1)),
  );
}

function unavailable(target: string): Error {
  const err = new Error(`unknown content DB target "${target}"`);
  (err as { code?: string }).code = 'ERR_UNKNOWN_TARGET';
  return err;
}

async function clientFor(target: string): Promise<Client> {
  if (!hasTarget(target)) throw unavailable(target);
  let client = clients.get(target);
  if (!client) {
    const url = urlTemplate
      ? urlTemplate.replace('{target}', target.replace('.', '-'))
      : registry.get(target)!.url;
    client = (async () => {
      const c = createClient({ url });
      // The file must be what its name says (a renamed or misplaced file would serve wrong content).
      const meta = await c.execute("SELECT value FROM _meta WHERE key = 'key'");
      const key = meta.rows[0]?.value;
      if (key !== target) {
        c.close();
        throw new Error(
          `${url}: _meta.key is ${String(key)}, expected ${target}`,
        );
      }
      return c;
    })();
    client.catch(() => clients.delete(target));
    clients.set(target, client);
  }
  return client;
}

export async function executeOn(
  target: string,
  sql: string,
  args?: Record<string, InValue>,
): Promise<Record<string, unknown>[]> {
  const client = await clientFor(target);
  const result = await client.execute({ sql, args: args ?? {} });
  return result.rows as unknown as Record<string, unknown>[];
}

/** The raw-SQL channel (`GET /db/:target?sql=`): SELECT only, like the legacy routes. */
export async function runTargetQuery(
  target: string,
  sql: string,
): Promise<unknown[]> {
  if (!hasTarget(target)) throw unavailable(target);
  if (!sql) return [];
  if (!sql.trim().toLowerCase().startsWith('select')) {
    const err = new Error('only SELECT statements are allowed');
    (err as { code?: string }).code = 'ERR_NOT_SELECT';
    throw err;
  }
  return executeOn(target, sql);
}

export async function closeContentDbs(): Promise<void> {
  for (const client of clients.values()) {
    (await client.catch(() => undefined))?.close();
  }
  clients.clear();
  registry.clear();
  source = undefined;
  urlTemplate = undefined;
}
