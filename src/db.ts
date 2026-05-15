import { createClient, type Client } from '@libsql/client';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ROLES = ['index', 'data', 'farsh', 'words'] as const;
export type Role = (typeof ROLES)[number];

const clients: Partial<Record<Role, Client>> = {};
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
      if (file && !clients[role]) {
        const path = join(dir, file);
        clients[role] = createClient({ url: 'file:' + path });
        files[role] = path;
      }
    }
    if (Object.keys(clients).length === ROLES.length) break;
  }
  return { files };
}

export function getDb(role: Role): Client | undefined {
  return clients[role];
}

export async function runQuery(role: Role, sql: string): Promise<unknown[]> {
  if (!sql) return [];
  if (!sql.trim().toLowerCase().startsWith('select')) {
    const err = new Error('only SELECT statements are allowed');
    (err as { code?: string }).code = 'ERR_NOT_SELECT';
    throw err;
  }
  const client = clients[role];
  if (!client) {
    const err = new Error(`database for role "${role}" is not loaded`);
    (err as { code?: string }).code = 'ERR_DB_UNAVAILABLE';
    throw err;
  }
  const result = await client.execute(sql);
  return result.rows;
}

export function closeDatabases(): void {
  for (const role of ROLES) {
    clients[role]?.close();
    delete clients[role];
    delete files[role];
  }
}
