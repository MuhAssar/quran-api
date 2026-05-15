import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { Role, runQuery } from './db';

function sqlHandler(role: Role) {
  return async (c: import('hono').Context) => {
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
  app.use('*', cors({ origin: '*' }));

  app.get('/', (c) => c.text('Hello World!'));
  app.get('/i', sqlHandler('index'));
  app.get('/d', sqlHandler('data'));
  app.get('/f', sqlHandler('farsh'));
  app.get('/w', sqlHandler('words'));

  return app;
}
