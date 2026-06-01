import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { execute, getBookCodes, runQuery, type Role } from './db';
import {
  CAP_ALL_SEARCH,
  CAP_FARSH,
  CAP_INDEX,
  CAP_MOSSHF,
  CAP_PAGES,
  CAP_WORDS,
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
const CACHE_PUBLIC =
  'public, s-maxage=86400, stale-while-revalidate=604800';

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

function legacySqlHandler(role: Role) {
  return async (c: Context) => {
    const sql = c.req.query('sql') ?? '';
    try {
      const rows = await runQuery(role, sql);
      return c.json(rows);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      throw new HTTPException(400, {
        message: `${e.code ?? 'ERR'}: ${e.message ?? String(err)}\n`,
      });
    }
  };
}

export function createApp(): Hono {
  const app = new Hono();
  app.use('*', cors(corsConfig()));

  // ─── Health ──────────────────────────────────────────────────────────
  app.get('/', (c) => c.text('Hello World!'));

  // ─── Legacy raw-SQL routes (kept during client migration) ────────────
  app.get('/i', legacySqlHandler('index'));
  app.get('/d', legacySqlHandler('data'));
  app.get('/f', legacySqlHandler('farsh'));
  app.get('/w', legacySqlHandler('words'));

  // ─── 7.1 Index resources ─────────────────────────────────────────────
  app.get('/editions/:edition/sora', async (c) => {
    const edition = assertEdition(c.req.param('edition'), CAP_INDEX, 'sora');
    const rows = await execute(
      'index',
      `SELECT * FROM ${edition}_sora ORDER BY page_number`,
    );
    return withCache(c, rows);
  });

  app.get('/editions/:edition/part', async (c) => {
    const edition = assertEdition(c.req.param('edition'), CAP_INDEX, 'part');
    const rows = await execute(
      'index',
      `SELECT * FROM ${edition}_part ORDER BY page_number`,
    );
    return withCache(c, rows);
  });

  app.get('/editions/:edition/quarter', async (c) => {
    const edition = assertEdition(
      c.req.param('edition'),
      CAP_INDEX,
      'quarter',
    );
    const rows = await execute(
      'index',
      `SELECT * FROM ${edition}_quarter ORDER BY page_number`,
    );
    return withCache(c, rows);
  });

  app.get('/editions/:edition/pages', async (c) => {
    const edition = assertEdition(c.req.param('edition'), CAP_PAGES, 'pages');
    const rows = await execute(
      'index',
      `SELECT * FROM mosshf_${edition}_pages ORDER BY page_number`,
    );
    return withCache(c, rows);
  });

  // ─── 7.2 Mosshf (aya position) ───────────────────────────────────────
  app.get('/editions/:edition/aya/:idx', async (c) => {
    const edition = assertEdition(c.req.param('edition'), CAP_MOSSHF, 'aya');
    const idx = assertInt(c.req.param('idx'), 'idx', 1, 6236);
    const rows = await execute(
      'data',
      `SELECT * FROM mosshf_${edition} WHERE aya_index = :idx`,
      { idx },
    );
    return withCache(c, rows);
  });

  app.get('/editions/:edition/sora/:s/aya/:n', async (c) => {
    const edition = assertEdition(c.req.param('edition'), CAP_MOSSHF, 'aya');
    const s = assertInt(c.req.param('s'), 's', 1, 114);
    const n = assertInt(c.req.param('n'), 'n', 1, 286);
    const rows = await execute(
      'data',
      `SELECT * FROM mosshf_${edition} WHERE sora_number = :s AND aya_number = :n`,
      { s, n },
    );
    return withCache(c, rows);
  });

  app.get('/editions/:edition/sora/:s/aya/:n/page', async (c) => {
    const edition = assertEdition(c.req.param('edition'), CAP_MOSSHF, 'aya');
    const s = assertInt(c.req.param('s'), 's', 1, 114);
    const n = assertInt(c.req.param('n'), 'n', 1, 286);
    const rows = await execute(
      'data',
      `SELECT page_number FROM mosshf_${edition} WHERE sora_number = :s AND aya_number = :n`,
      { s, n },
    );
    return withCache(c, rows);
  });

  app.get('/editions/:edition/page/:n/ayat', async (c) => {
    const edition = assertEdition(c.req.param('edition'), CAP_MOSSHF, 'page');
    const n = assertInt(c.req.param('n'), 'n', 1, 604);
    const rows = await execute(
      'data',
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
    const rows = await execute(
      'data',
      `SELECT * FROM ${edition}_all WHERE aya_index = :idx`,
      { idx },
    );
    return withCache(c, rows);
  });

  app.get('/editions/:edition/page/:n/full', async (c) => {
    const edition = assertEdition(
      c.req.param('edition'),
      CAP_ALL_SEARCH,
      'full',
    );
    const n = assertInt(c.req.param('n'), 'n', 1, 604);
    const rows = await execute(
      'data',
      `SELECT * FROM ${edition}_all WHERE page_number = :n ORDER BY aya_index`,
      { n },
    );
    return withCache(c, rows);
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
    const rows = await execute(
      'data',
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
    const rows = await execute(
      'data',
      `SELECT count(*) AS count FROM ${edition}_search WHERE ${field} LIKE :pattern${soraClause}`,
      sora !== undefined ? { pattern: `%${q}%`, sora } : { pattern: `%${q}%` },
    );
    return withCache(c, rows[0] ?? { count: 0 });
  });

  // ─── 7.5 Book window ─────────────────────────────────────────────────
  app.get('/book/:bookCode/aya/:idx/nearest', async (c) => {
    const bookCode = assertBookCode(c.req.param('bookCode'), getBookCodes());
    const idx = assertInt(c.req.param('idx'), 'idx', 1, 6236);
    const rows = await execute(
      'data',
      `SELECT text FROM book_${bookCode} WHERE aya_index <= :idx ORDER BY aya_index DESC LIMIT 1`,
      { idx },
    );
    return withCache(c, rows[0] ?? null);
  });

  // ─── 7.6 Farsh ───────────────────────────────────────────────────────
  app.get('/editions/:edition/page/:n/farsh', async (c) => {
    const edition = assertEdition(
      c.req.param('edition'),
      CAP_FARSH,
      'farsh',
    );
    const n = assertInt(c.req.param('n'), 'n', 1, 604);
    const qaree = assertQaree(c.req.query('qaree'));
    const waqf = c.req.query('waqf') === 'true';
    const table = edition;
    const sql = waqf
      ? `SELECT * FROM ${table} WHERE page_number = :n AND (qaree = :qaree OR qaree = 'Q')`
      : `SELECT * FROM ${table} WHERE page_number = :n AND qaree = :qaree`;
    const rows = await execute('farsh', sql, { n, qaree });
    return withCache(c, rows);
  });

  // ─── 7.7 Words ───────────────────────────────────────────────────────
  app.get('/editions/:edition/page/:n/word/at', async (c) => {
    const edition = assertEdition(c.req.param('edition'), CAP_WORDS, 'word');
    const n = assertInt(c.req.param('n'), 'n', 1, 604);
    const x = assertFloat(c.req.query('x'), 'x', 0, 1);
    const y = assertFloat(c.req.query('y'), 'y', 0, 1);
    const rows = await execute(
      'words',
      `SELECT * FROM ${edition}_words WHERE :x BETWEEN x AND x + width AND :y BETWEEN y - 0.07 AND y AND page_number = :n ORDER BY aya_index LIMIT 1`,
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
    const rows = await execute(
      'words',
      `SELECT * FROM ${edition}_words WHERE wordindex = :wordindex`,
      { wordindex },
    );
    return withCache(c, rows);
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
    const sql = before
      ? `SELECT MIN(wordindex) AS wordindex FROM ${edition}_words WHERE aya_index = (SELECT aya_index FROM ${edition}_words WHERE wordindex = :wordindex) AND wordindex < :wordindex`
      : `SELECT MIN(wordindex) AS wordindex FROM ${edition}_words WHERE aya_index = (SELECT aya_index FROM ${edition}_words WHERE wordindex = :wordindex)`;
    const rows = await execute('words', sql, { wordindex });
    return withCache(c, rows[0] ?? null);
  });

  return app;
}
