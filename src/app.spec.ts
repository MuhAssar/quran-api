import { createApp } from './app';
import {
  closeContentDbs,
  contentDbDirs,
  layoutDbDirs,
  openContentDbs,
} from './content-db';

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  openContentDbs(contentDbDirs(process.cwd()), layoutDbDirs(process.cwd()));
  app = createApp();
});

afterAll(async () => {
  await closeContentDbs();
});

describe('health', () => {
  it('GET / returns "Hello World!"', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Hello World!');
  });
});

describe('legacy raw SQL routes (removed after the DB split)', () => {
  it.each(['/d', '/f', '/w'])('GET %s returns 404', async (path) => {
    const res = await app.request(
      path + '?sql=' + encodeURIComponent('select 1'),
    );
    expect(res.status).toBe(404);
  });
});

describe('split content DBs (GET /db/:target)', () => {
  it('runs a SELECT on the core', async () => {
    const res = await app.request(
      '/db/quran?sql=' +
        encodeURIComponent(
          'SELECT aya_index, sora_number, aya_number FROM verses WHERE aya_index = 1',
        ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { aya_index: 1, sora_number: 1, aya_number: 1 },
    ]);
  });

  it('runs a SELECT on a book pack', async () => {
    const res = await app.request(
      '/db/book.tabary?sql=' +
        encodeURIComponent('SELECT count(*) AS n FROM book'),
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ n: number }>;
    expect(rows[0].n).toBeGreaterThan(6000);
  });

  it('runs a SELECT on a layout DB (from wursha-layouts)', async () => {
    const res = await app.request(
      '/db/layout.madina?sql=' +
        encodeURIComponent('SELECT count(DISTINCT aya_index) AS n FROM mosshf'),
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ n: number }>;
    expect(rows[0].n).toBe(6236);
  });

  it('rejects an unknown target with 400', async () => {
    const res = await app.request(
      '/db/book.nope?sql=' + encodeURIComponent('SELECT 1'),
    );
    expect(res.status).toBe(400);
  });

  it.each(['farsh', 'words.madina'])(
    'rejects the retired legacy target %s with 400',
    async (target) => {
      const res = await app.request(
        `/db/${target}?sql=` + encodeURIComponent('SELECT 1'),
      );
      expect(res.status).toBe(400);
    },
  );

  it('rejects a malformed target with 400', async () => {
    const res = await app.request(
      '/db/..%2Fdata?sql=' + encodeURIComponent('SELECT 1'),
    );
    expect(res.status).toBe(400);
  });

  it('rejects non-SELECT with 400', async () => {
    const res = await app.request(
      '/db/quran?sql=' + encodeURIComponent('delete from quran_colors'),
    );
    expect(res.status).toBe(400);
  });
});

describe('legacy edition routes (removed with the per-edition geometry)', () => {
  it.each([
    '/editions/madina/aya/1',
    '/editions/madina/sora/1/aya/1',
    '/editions/madina/sora/1/aya/1/page',
    '/editions/madina/page/1/ayat',
    '/editions/madina/aya/1/full',
    '/editions/madina/page/1/full',
    '/editions/madina/search?q=' + encodeURIComponent('الله'),
    '/editions/madina/search/count?q=' + encodeURIComponent('الله'),
    '/editions/madina/page/1/farsh?qaree=A',
    '/editions/madina/page/1/word/at?x=0.5&y=0.5',
    '/editions/madina/word/1',
    '/editions/madina/word/1/aya-first',
    '/editions/madina/sora',
    '/i?sql=' + encodeURIComponent('select 1'),
  ])('GET %s returns 404', async (path) => {
    const res = await app.request(path);
    expect(res.status).toBe(404);
  });
});

describe('book window', () => {
  it('GET /book/qortoby/aya/1/nearest returns text', async () => {
    const res = await app.request('/book/qortoby/aya/1/nearest');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string } | null;
    expect(body).toBeTruthy();
    expect(typeof body?.text).toBe('string');
  });

  it('GET /book/notarealbook/aya/1/nearest returns 400', async () => {
    const res = await app.request('/book/notarealbook/aya/1/nearest');
    expect(res.status).toBe(400);
  });
});

describe('CORS', () => {
  it('default config allows any origin', async () => {
    const res = await app.request('/', {
      headers: { Origin: 'https://example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
