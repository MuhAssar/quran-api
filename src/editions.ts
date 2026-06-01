import { HTTPException } from 'hono/http-exception';

export const EDITIONS = [
  'madina',
  'shmrly',
  'libya',
  'tjwid',
  'hafs',
] as const;
export type Edition = (typeof EDITIONS)[number];

const EDITION_SET: ReadonlySet<string> = new Set(EDITIONS);

export const CAP_INDEX: ReadonlySet<Edition> = new Set([
  'madina',
  'shmrly',
  'libya',
]);
export const CAP_PAGES: ReadonlySet<Edition> = new Set([
  'madina',
  'shmrly',
  'libya',
]);
export const CAP_MOSSHF: ReadonlySet<Edition> = new Set([
  'madina',
  'shmrly',
  'libya',
  'tjwid',
  'hafs',
]);
export const CAP_ALL_SEARCH: ReadonlySet<Edition> = new Set([
  'madina',
  'shmrly',
  'libya',
  'tjwid',
]);
export const CAP_WORDS: ReadonlySet<Edition> = new Set([
  'madina',
  'shmrly',
  'tjwid',
]);
export const CAP_FARSH: ReadonlySet<Edition> = new Set(['madina', 'shmrly']);

export function assertEdition(
  value: string | undefined,
  cap: ReadonlySet<Edition>,
  capName: string,
): Edition {
  if (!value) {
    throw new HTTPException(400, { message: 'missing edition\n' });
  }
  if (!EDITION_SET.has(value)) {
    throw new HTTPException(400, { message: `unknown edition: ${value}\n` });
  }
  if (!cap.has(value as Edition)) {
    throw new HTTPException(404, {
      message: `edition ${value} does not support ${capName}\n`,
    });
  }
  return value as Edition;
}

const QAREES = new Set([
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'O',
  'P',
  'R',
  'S',
  'T',
  'U',
  'W',
  'X',
  'Y',
  'Z',
]);

export function assertQaree(value: string | undefined): string {
  if (!value) {
    throw new HTTPException(400, { message: 'missing qaree\n' });
  }
  if (!QAREES.has(value)) {
    throw new HTTPException(400, { message: `unknown qaree: ${value}\n` });
  }
  return value;
}

export const SEARCH_FIELDS = new Set([
  'text',
  'text_uthamni',
  'text_full',
  'roots',
]);

export function assertSearchField(value: string | undefined): string {
  const v = value ?? 'text';
  if (!SEARCH_FIELDS.has(v)) {
    throw new HTTPException(400, {
      message: `invalid field: ${v} (allowed: text, text_uthamni, text_full, roots)\n`,
    });
  }
  return v;
}
