import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import {
  TARGET_RE,
  executeOn,
  getPackKeys,
  runTargetQuery,
} from './content-db';
import {
  CAP_ALL_SEARCH,
  CAP_FARSH,
  CAP_MOSSHF,
  CAP_WORDS,
  NEAREST_BOOKS,
  WORDS_LAYOUT,
  WORD_PACKS,
  assertEdition,
  assertQaree,
  assertSearchField,
} from './editions';
import {
  assertBookCode,
  assertFloat,
  assertInt,
  optionalInt,
} from './validators';

const SEARCH_LIMIT_MAX = 1000;
const SEARCH_LIMIT_DEFAULT = 100;
const CACHE_PUBLIC = 'public, s-maxage=86400, stale-while-revalidate=604800';

function corsConfig() {
  const raw = (process.env.CORS_ORIGINS ?? '*').trim();
  if (raw === '*' || raw === '') return { origin: '*' as const };
  const allow = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { origin: allow };
}

function withCache<T>(c: Context, body: T): Response {
  c.header('Cache-Control', CACHE_PUBLIC);
  return c.json(body as object);
}

/** `?books=a,b` → known book keys (unknown ones are a 400). */
function parseBooks(raw: string | undefined): string[] {
  if (!raw) return [];
  const known = getPackKeys('book');
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((code) => assertBookCode(code, known));
}

/** Verse rows of an edition with the core texts, under the names the old `<edition>_all` views used. */
function ayaWithTextSql(edition: string, where: string): string {
  return `SELECT m.*, q.text AS aya_text, q.text_full AS aya_text_full, u.text AS quranu
    FROM mosshf_${edition} m
    LEFT JOIN book_quran q ON q.aya_index = m.aya_index
    LEFT JOIN book_quranu u ON u.aya_index = m.aya_index
    WHERE ${where} ORDER BY m.aya_index`;
}

/** Adds each book's text (column named after the book) to verse rows, one query per `book.<key>`. */
async function addBooks(
  rows: Record<string, unknown>[],
  books: string[],
): Promise<Record<string, unknown>[]> {
  if (rows.length === 0 || books.length === 0) return rows;
  const from = Number(rows[0].aya_index);
  const to = Number(rows[rows.length - 1].aya_index);
  await Promise.all(
    books.map(async (code) => {
      const nearest = NEAREST_BOOKS.has(code);
      const start = nearest
        ? `coalesce((SELECT max(aya_index) FROM book WHERE aya_index <= :from), :from)`
        : ':from';
      const texts = await executeOn(
        `book.${code}`,
        `SELECT aya_index, text FROM book WHERE aya_index BETWEEN ${start} AND :to ORDER BY aya_index`,
        { from, to },
      );
      let next = 0;
      let text: unknown = null;
      for (const row of rows) {
        const idx = Number(row.aya_index);
        if (nearest) {
          while (next < texts.length && Number(texts[next].aya_index) <= idx) {
            text = texts[next++].text;
          }
          row[code] = text;
        } else {
          row[code] =
            texts.find((t) => Number(t.aya_index) === idx)?.text ?? null;
        }
      }
    }),
  );
  return rows;
}

function wordsTarget(edition: string): string {
  return `words.${WORDS_LAYOUT[edition]}`;
}

export function createApp(): Hono {
  const app = new Hono();
  app.use('*', cors(corsConfig()));

  // ─── Health ──────────────────────────────────────────────────────────
  app.get('/', (c) => c.text('Hello World!'));

  // ─── Raw SQL on one split content DB (Wursha_QuranHolder specs/data-db-split.md §5) ───
  app.get('/db/:target', async (c) => {
    const target = c.req.param('target');
    if (!TARGET_RE.test(target)) {
      throw new HTTPException(400, { message: `invalid target: ${target}\n` });
    }
    try {
      return c.json(await runTargetQuery(target, c.req.query('sql') ?? ''));
    } catch (err) {
      const e = err as { code?: string; message?: string };
      throw new HTTPException(400, {
        message: `${e.code ?? 'ERR'}: ${e.message ?? String(err)}\n`,
      });
    }
  });

  // ─── 7.2 Mosshf (aya position) ───────────────────────────────────────
  app.get('/editions/:edition/aya/:idx', async (c) => {
    const edition = assertEdition(c.req.param('edition'), CAP_MOSSHF, 'aya');
    const idx = assertInt(c.req.param('idx'), 'idx', 1, 6236);
    const rows = await executeOn(
      'quran',
      `SELECT * FROM mosshf_${edition} WHERE aya_index = :idx`,
      { idx },
    );
    return withCache(c, rows);
  });

  app.get('/editions/:edition/sora/:s/aya/:n', async (c) => {
    const edition = assertEdition(c.req.param('edition'), CAP_MOSSHF, 'aya');
    const s = assertInt(c.req.param('s'), 's', 1, 114);
    const n = assertInt(c.req.param('n'), 'n', 1, 286);
    const rows = await executeOn(
      'quran',
      `SELECT * FROM mosshf_${edition} WHERE sora_number = :s AND aya_number = :n`,
      { s, n },
    );
    return withCache(c, rows);
  });

  app.get('/editions/:edition/sora/:s/aya/:n/page', async (c) => {
    const edition = assertEdition(c.req.param('edition'), CAP_MOSSHF, 'aya');
    const s = assertInt(c.req.param('s'), 's', 1, 114);
    const n = assertInt(c.req.param('n'), 'n', 1, 286);
    const rows = await executeOn(
      'quran',
      `SELECT page_number FROM mosshf_${edition} WHERE sora_number = :s AND aya_number = :n`,
      { s, n },
    );
    return withCache(c, rows);
  });

  app.get('/editions/:edition/page/:n/ayat', async (c) => {
    const edition = assertEdition(c.req.param('edition'), CAP_MOSSHF, 'page');
    const n = assertInt(c.req.param('n'), 'n', 1, 604);
    const rows = await executeOn(
      'quran',
      `SELECT * FROM mosshf_${edition} WHERE page_number = :n ORDER BY aya_index`,
      { n },
    );
    return withCache(c, rows);
  });

  // ─── 7.3 Composite "all-data" ────────────────────────────────────────
  app.get('/editions/:edition/aya/:idx/full', async (c) => {
    const edition = assertEdition(
      c.req.param('edition'),
      CAP_ALL_SEARCH,
      'full',
    );
    const idx = assertInt(c.req.param('idx'), 'idx', 1, 6236);
    const books = parseBooks(c.req.query('books'));
    const rows = await executeOn(
      'quran',
      ayaWithTextSql(edition, 'm.aya_index = :idx'),
      { idx },
    );
    return withCache(c, await addBooks(rows, books));
  });

  app.get('/editions/:edition/page/:n/full', async (c) => {
    const edition = assertEdition(
      c.req.param('edition'),
      CAP_ALL_SEARCH,
      'full',
    );
    const n = assertInt(c.req.param('n'), 'n', 1, 604);
    const books = parseBooks(c.req.query('books'));
    const rows = await executeOn(
      'quran',
      ayaWithTextSql(edition, 'm.page_number = :n'),
      { n },
    );
    return withCache(c, await addBooks(rows, books));
  });

  // ─── 7.4 Search ──────────────────────────────────────────────────────
  app.get('/editions/:edition/search', async (c) => {
    const edition = assertEdition(
      c.req.param('edition'),
      CAP_ALL_SEARCH,
      'search',
    );
    const q = c.req.query('q');
    if (!q) throw new HTTPException(400, { message: 'missing q\n' });
    const field = assertSearchField(c.req.query('field'));
    const sora = optionalInt(c.req.query('sora'), 'sora', 1, 114);
    const limit =
      optionalInt(c.req.query('limit'), 'limit', 1, SEARCH_LIMIT_MAX) ??
      SEARCH_LIMIT_DEFAULT;
    const soraClause = sora !== undefined ? ' AND sora_number = :sora' : '';
    const rows = await executeOn(
      'quran',
      `SELECT * FROM ${edition}_search WHERE ${field} LIKE :pattern${soraClause} ORDER BY aya_index LIMIT :limit`,
      sora !== undefined
        ? { pattern: `%${q}%`, sora, limit }
        : { pattern: `%${q}%`, limit },
    );
    return withCache(c, rows);
  });

  app.get('/editions/:edition/search/count', async (c) => {
    const edition = assertEdition(
      c.req.param('edition'),
      CAP_ALL_SEARCH,
      'search',
    );
    const q = c.req.query('q');
    if (!q) throw new HTTPException(400, { message: 'missing q\n' });
    const field = assertSearchField(c.req.query('field'));
    const sora = optionalInt(c.req.query('sora'), 'sora', 1, 114);
    const soraClause = sora !== undefined ? ' AND sora_number = :sora' : '';
    const rows = await executeOn(
      'quran',
      `SELECT count(*) AS count FROM ${edition}_search WHERE ${field} LIKE :pattern${soraClause}`,
      sora !== undefined ? { pattern: `%${q}%`, sora } : { pattern: `%${q}%` },
    );
    return withCache(c, rows[0] ?? { count: 0 });
  });

  // ─── 7.5 Book window ─────────────────────────────────────────────────
  app.get('/book/:bookCode/aya/:idx/nearest', async (c) => {
    const bookCode = assertBookCode(
      c.req.param('bookCode'),
      getPackKeys('book'),
    );
    const idx = assertInt(c.req.param('idx'), 'idx', 1, 6236);
    const rows = await executeOn(
      `book.${bookCode}`,
      `SELECT text FROM book WHERE aya_index <= :idx ORDER BY aya_index DESC LIMIT 1`,
      { idx },
    );
    return withCache(c, rows[0] ?? null);
  });

  // ─── 7.6 Farsh ───────────────────────────────────────────────────────
  app.get('/editions/:edition/page/:n/farsh', async (c) => {
    const edition = assertEdition(c.req.param('edition'), CAP_FARSH, 'farsh');
    const n = assertInt(c.req.param('n'), 'n', 1, 604);
    const qaree = assertQaree(c.req.query('qaree'));
    const waqf = c.req.query('waqf') === 'true';
    const table = edition;
    const sql = waqf
      ? `SELECT * FROM ${table} WHERE page_number = :n AND (qaree = :qaree OR qaree = 'Q')`
      : `SELECT * FROM ${table} WHERE page_number = :n AND qaree = :qaree`;
    const rows = await executeOn('farsh', sql, { n, qaree });
    return withCache(c, rows);
  });

  // ─── 7.7 Words ───────────────────────────────────────────────────────
  app.get('/editions/:edition/page/:n/word/at', async (c) => {
    const edition = assertEdition(c.req.param('edition'), CAP_WORDS, 'word');
    const n = assertInt(c.req.param('n'), 'n', 1, 604);
    const x = assertFloat(c.req.query('x'), 'x', 0, 1);
    const y = assertFloat(c.req.query('y'), 'y', 0, 1);
    const rows = await executeOn(
      wordsTarget(edition),
      `SELECT * FROM words WHERE :x BETWEEN x AND x + width AND :y BETWEEN y - 0.07 AND y AND page_number = :n ORDER BY aya_index LIMIT 1`,
      { x, y, n },
    );
    return withCache(c, rows[0] ?? null);
  });

  app.get('/editions/:edition/word/:wordindex', async (c) => {
    const edition = assertEdition(c.req.param('edition'), CAP_WORDS, 'word');
    const wordindex = assertInt(
      c.req.param('wordindex'),
      'wordindex',
      1,
      99_999,
    );
    const rows = await executeOn(
      wordsTarget(edition),
      `SELECT * FROM words WHERE wordindex = :wordindex AND wordsno < 999`,
      { wordindex },
    );
    // The word-page texts, from the five word.<key> packs (as the old <edition>_words view had them).
    const texts: Record<string, unknown> = {};
    await Promise.all(
      WORD_PACKS.map(async (key) => {
        const found = await executeOn(
          `word.${key}`,
          `SELECT * FROM word WHERE wordindex = :wordindex`,
          { wordindex },
        );
        texts[key] = found[0]?.text ?? null;
        if (key === 'qeraat') texts.qeraatN = found[0]?.text_n ?? null;
      }),
    );
    return withCache(
      c,
      rows.map((row) => ({ ...row, ...texts })),
    );
  });

  app.get('/editions/:edition/word/:wordindex/aya-first', async (c) => {
    const edition = assertEdition(c.req.param('edition'), CAP_WORDS, 'word');
    const wordindex = assertInt(
      c.req.param('wordindex'),
      'wordindex',
      1,
      99_999,
    );
    const before = c.req.query('before') === 'true';
    const verse = `SELECT aya_index FROM words WHERE wordindex = :wordindex AND wordsno < 999`;
    const sql = before
      ? `SELECT MIN(wordindex) AS wordindex FROM words WHERE aya_index = (${verse}) AND wordindex < :wordindex`
      : `SELECT MIN(wordindex) AS wordindex FROM words WHERE aya_index = (${verse})`;
    const rows = await executeOn(wordsTarget(edition), sql, { wordindex });
    return withCache(c, rows[0] ?? null);
  });

  return app;
}
