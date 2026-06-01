import { createClient, type Client, type InValue } from '@libsql/client';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ROLES = ['index', 'data', 'farsh', 'words'] as const;
export type Role = (typeof ROLES)[number];

const clients: Partial<Record<Role, Client>> = {};
const files: Partial<Record<Role, string>> = {};
let bookCodes: Set<string> = new Set();

function listDbFiles(dir: string): string[] {
  return readdirSync(dir, { encoding: 'utf8' }).filter((f) =>
    f.endsWith('.db'),
  );
}

function urlFromEnv(role: Role): string | undefined {
  const v = process.env[`DB_${role.toUpperCase()}_URL`];
  return v && v.trim() ? v.trim() : undefined;
}

export async function openDatabases(searchDirs: string[]): Promise<{
  files: Partial<Record<Role, string>>;
}> {
  for (const role of ROLES) {
    const envUrl = urlFromEnv(role);
    if (envUrl && !clients[role]) {
      clients[role] = createClient({ url: envUrl });
      files[role] = envUrl;
    }
  }

  for (const dir of searchDirs) {
    const found = listDbFiles(dir);
    if (found.length === 0) continue;
    for (const role of ROLES) {
      if (clients[role]) continue;
      const file = found.find((f) => f.startsWith(role));
      if (file) {
        const path = join(dir, file);
        clients[role] = createClient({ url: 'file:' + path });
        files[role] = path;
      }
    }
    if (Object.keys(clients).length === ROLES.length) break;
  }

  if (clients.data) {
    const result = await clients.data.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'book\\_%' ESCAPE '\\'",
    );
    bookCodes = new Set(
      result.rows.map((r) => String(r.name).replace(/^book_/, '')),
    );
  }

  return { files };
}

export function getDb(role: Role): Client | undefined {
  return clients[role];
}

export function getBookCodes(): ReadonlySet<string> {
  return bookCodes;
}

export async function execute(
  role: Role,
  sql: string,
  args?: Record<string, InValue>,
): Promise<Record<string, unknown>[]> {
  const client = clients[role];
  if (!client) {
    const err = new Error(`database for role "${role}" is not loaded`);
    (err as { code?: string }).code = 'ERR_DB_UNAVAILABLE';
    throw err;
  }
  const result = await client.execute({ sql, args: args ?? {} });
  return result.rows as unknown as Record<string, unknown>[];
}

export async function runQuery(role: Role, sql: string): Promise<unknown[]> {
  if (!sql) return [];
  if (!sql.trim().toLowerCase().startsWith('select')) {
    const err = new Error('only SELECT statements are allowed');
    (err as { code?: string }).code = 'ERR_NOT_SELECT';
    throw err;
  }
  return execute(role, sql);
}

export function closeDatabases(): void {
  for (const role of ROLES) {
    clients[role]?.close();
    delete clients[role];
    delete files[role];
  }
  bookCodes = new Set();
}
