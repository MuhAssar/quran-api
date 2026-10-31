import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import {
  TARGET_RE,
  executeOn,
  getPackKeys,
  runTargetQuery,
} from './content-db';
import { assertBookCode, assertInt } from './validators';

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

  // ─── Book window ─────────────────────────────────────────────────────
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

  return app;
}
