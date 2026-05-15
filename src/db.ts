import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ROLES = ['index', 'data', 'farsh', 'words'] as const;
export type Role = (typeof ROLES)[number];

const handles: Partial<Record<Role, DatabaseSync>> = {};
const files: Partial<Record<Role, string>> = {};

function listDbFiles(dir: string): string[] {
  return readdirSync(dir, { encoding: 'utf8' }).filter((f) =>
    f.endsWith('.db'),
  );
}

export function openDatabases(searchDirs: string[]): {
  files: Partial<Record<Role, string>>;
} {
  for (const dir of searchDirs) {
    const found = listDbFiles(dir);
    if (found.length === 0) continue;
    for (const role of ROLES) {
      const file = found.find((f) => f.startsWith(role));
      if (file && !handles[role]) {
        const path = join(dir, file);
        handles[role] = new DatabaseSync(path, { readOnly: true });
        files[role] = path;
      }
    }
    if (Object.keys(handles).length === ROLES.length) break;
  }
  return { files };
}

export function getDb(role: Role): DatabaseSync | undefined {
  return handles[role];
}

export function runQuery(role: Role, sql: string): unknown[] {
  if (!sql) return [];
  const db = handles[role];
  if (!db) {
    const err = new Error(`database for role "${role}" is not loaded`);
    (err as { code?: string }).code = 'ERR_DB_UNAVAILABLE';
    throw err;
  }
  const stmt = db.prepare(sql);
  if (sql.trim().toLowerCase().startsWith('select')) {
    return stmt.all();
  }
  stmt.run();
  return [];
}

export function closeDatabases(): void {
  for (const role of ROLES) {
    handles[role]?.close();
    delete handles[role];
    delete files[role];
  }
}
