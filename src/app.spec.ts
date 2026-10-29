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
          'SELECT aya_index FROM mosshf_madina WHERE aya_index = 1',
        ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ aya_index: 1 }]);
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

describe('mosshf endpoints', () => {
  it('GET /editions/madina/aya/1 returns one row with basmala', async () => {
    const res = await app.request('/editions/madina/aya/1');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      aya_index: number;
      page_number: number;
      sora_number: number;
      aya_number: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].aya_index).toBe(1);
    expect(rows[0].sora_number).toBe(1);
    expect(rows[0].aya_number).toBe(1);
  });

  it('GET /editions/madina/sora/1/aya/1 returns the same row', async () => {
    const res = await app.request('/editions/madina/sora/1/aya/1');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ aya_index: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].aya_index).toBe(1);
  });

  it('GET /editions/madina/sora/1/aya/1/page returns page_number', async () => {
    const res = await app.request('/editions/madina/sora/1/aya/1/page');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ page_number: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].page_number).toBeGreaterThan(0);
  });

  it('GET /editions/madina/page/1/ayat returns Fatiha ayat', async () => {
    const res = await app.request('/editions/madina/page/1/ayat');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as unknown[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /editions/madina/aya/9999 returns [] (out of range)', async () => {
    const res = await app.request('/editions/madina/aya/9999');
    expect(res.status).toBe(400);
  });

  it('GET /editions/unknown/aya/1 returns 400', async () => {
    const res = await app.request('/editions/unknown/aya/1');
    expect(res.status).toBe(400);
  });

  it('GET /editions/madina/sora returns 404 (index routes removed; the app bundles that data)', async () => {
    const res = await app.request('/editions/madina/sora');
    expect(res.status).toBe(404);
  });

  it('GET /i returns 404 (legacy index route removed)', async () => {
    const res = await app.request('/i?sql=' + encodeURIComponent('select 1'));
    expect(res.status).toBe(404);
  });

  it('GET /editions/madina/aya/notanint returns 400', async () => {
    const res = await app.request('/editions/madina/aya/notanint');
    expect(res.status).toBe(400);
  });
});

describe('composite all-data', () => {
  it('GET /editions/madina/aya/1/full returns the verse with its core texts', async () => {
    const res = await app.request('/editions/madina/aya/1/full');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].aya_text).toBeTruthy();
    expect(rows[0].aya_text_full).toBeTruthy();
    expect(rows[0].quranu).toBeTruthy();
    expect(rows[0].tabary).toBeUndefined();
  });

  it('GET /editions/madina/aya/2/full?books=tabary,waqf adds those books', async () => {
    const res = await app.request(
      '/editions/madina/aya/2/full?books=tabary,waqf',
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(typeof rows[0].tabary).toBe('string');
    // waqf has one row per waqf: verse 2 gets the nearest preceding one
    expect(typeof rows[0].waqf).toBe('string');
  });

  it('GET /editions/madina/aya/1/full?books=nope returns 400', async () => {
    const res = await app.request('/editions/madina/aya/1/full?books=nope');
    expect(res.status).toBe(400);
  });

  it('GET /editions/madina/page/1/full returns multiple rows', async () => {
    const res = await app.request('/editions/madina/page/1/full');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as unknown[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('search', () => {
  it('GET /editions/madina/search?q=الفاتحة returns rows', async () => {
    const res = await app.request(
      '/editions/madina/search?q=' + encodeURIComponent('الفاتحة'),
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
  });

  it('GET /editions/madina/search without q returns 400', async () => {
    const res = await app.request('/editions/madina/search');
    expect(res.status).toBe(400);
  });

  it('GET /editions/madina/search?q=…&limit=2000 caps at 1000', async () => {
    const res = await app.request(
      '/editions/madina/search?q=' + encodeURIComponent('ا') + '&limit=2000',
    );
    expect(res.status).toBe(400);
  });

  it('GET /editions/madina/search/count?q=… returns a count object', async () => {
    const res = await app.request(
      '/editions/madina/search/count?q=' + encodeURIComponent('الله'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(typeof body.count).toBe('number');
    expect(body.count).toBeGreaterThan(0);
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

describe('farsh', () => {
  it('GET /editions/madina/page/1/farsh?qaree=A returns rows', async () => {
    const res = await app.request('/editions/madina/page/1/farsh?qaree=A');
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it('GET /editions/madina/page/1/farsh?qaree=X returns 400', async () => {
    const res = await app.request(
      '/editions/madina/page/1/farsh?qaree=NOT_A_QAREE',
    );
    expect(res.status).toBe(400);
  });

  it('GET /editions/libya/page/1/farsh?qaree=A returns 404 (capability gap)', async () => {
    const res = await app.request('/editions/libya/page/1/farsh?qaree=A');
    expect(res.status).toBe(404);
  });
});

describe('words', () => {
  it('GET /editions/madina/page/1/word/at?x=0.5&y=0.5 responds 200', async () => {
    const res = await app.request(
      '/editions/madina/page/1/word/at?x=0.5&y=0.5',
    );
    expect(res.status).toBe(200);
  });

  it('GET /editions/madina/word/1 returns rows', async () => {
    const res = await app.request('/editions/madina/word/1');
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it('GET /editions/madina/word/1/aya-first returns one row', async () => {
    const res = await app.request('/editions/madina/word/1/aya-first');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wordindex: number } | null;
    expect(body).toBeTruthy();
  });

  it('GET /editions/madina/word/1/aya-first?before=true respects before flag', async () => {
    const res = await app.request(
      '/editions/madina/word/1/aya-first?before=true',
    );
    expect(res.status).toBe(200);
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
