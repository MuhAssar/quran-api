import { createClient, type Client, type InValue } from '@libsql/client';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The split content DBs of the wursha-data repo, plus the layout DBs of the wursha-layouts repo, one
 * client per target, created on first use (Wursha_QuranHolder specs/data-db-split.md §5). A target
 * names one file: `<target with . → _>_v<N>.db` (`quran` → `quran_v1.db`, `book.tabary` →
 * `book_tabary_v1.db`, `layout.madina` → `layout_madina_v1.db`).
 */

export const TARGET_RE =
  /^(quran|book\.[a-z0-9]+|word\.[a-z0-9]+|layout\.[a-z0-9]+)$/;
const FILE_RE =
  /^(quran|book_[a-z0-9]+|word_[a-z0-9]+|layout_[a-z0-9]+)_v(\d+)\.db$/;
const LAYOUT_FILE_RE = /^layout_[a-z0-9]+_v\d+\.db$/;

interface Entry {
  url: string;
  version: number;
}

const registry = new Map<string, Entry>();
const clients = new Map<string, Promise<Client>>();
let source: string | undefined;
let layoutSource: string | undefined;
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
 * Where the layout DBs (`layout_<key>_v<N>.db`) are looked for, in order: `LAYOUT_DB_DIR`, the
 * sibling wursha-layouts build, the app's fetched layouts release. Layouts live in wursha-layouts
 * (Wursha_QuranHolder specs/mushaf-layouts.md §11.1); wursha-data releases up to v2026.11.1 also had
 * them, and are used only when none of these folders has any.
 */
export function layoutDbDirs(repoRoot: string): string[] {
  const dirs = [
    process.env.LAYOUT_DB_DIR?.trim(),
    join(repoRoot, '..', 'wursha-layouts', 'dist'),
    join(repoRoot, '..', 'Wursha_QuranHolder', '.layouts-cache', 'current'),
  ];
  return dirs.filter((dir): dir is string => !!dir).map((dir) => resolve(dir));
}

/**
 * Builds the registry from the first folder that has a `quran_v*.db` (folders are never mixed, so
 * all files come from one data release), taking the highest version per target. The `layout.*`
 * targets then come from the first of `layoutDirs` that has a `layout_*_v*.db` (one layouts release
 * or build), replacing any the data folder had. With `DB_URL_TEMPLATE` (hosted, e.g.
 * `libsql://{target}-org.turso.io`; `.` in the target → `-`) every target is reached through the
 * template instead, and the folders (if any) only list the targets.
 */
export function openContentDbs(
  dirs: string[],
  layoutDirs: string[] = [],
): {
  source?: string;
  layoutSource?: string;
  targets: string[];
} {
  urlTemplate = process.env.DB_URL_TEMPLATE?.trim() || undefined;
  const register = (dir: string, names: string[], only?: RegExp) => {
    for (const name of names) {
      const match = FILE_RE.exec(name);
      if (!match || (only && !only.test(name))) continue;
      const target = match[1].replace('_', '.');
      const version = Number(match[2]);
      if ((registry.get(target)?.version ?? -1) < version) {
        registry.set(target, { url: 'file:' + join(dir, name), version });
      }
    }
  };
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir, { encoding: 'utf8' });
    if (!names.some((name) => /^quran_v\d+\.db$/.test(name))) continue;
    register(dir, names);
    source = dir;
    break;
  }
  for (const dir of layoutDirs) {
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir, { encoding: 'utf8' });
    if (!names.some((name) => LAYOUT_FILE_RE.test(name))) continue;
    for (const target of [...registry.keys()].filter((t) =>
      t.startsWith('layout.'),
    )) {
      registry.delete(target);
    }
    register(dir, names, LAYOUT_FILE_RE);
    layoutSource = dir;
    break;
  }
  return {
    source: urlTemplate ?? source,
    layoutSource: urlTemplate ? undefined : layoutSource,
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
  layoutSource = undefined;
  urlTemplate = undefined;
}
