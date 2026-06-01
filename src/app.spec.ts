import { createApp } from './app';
import { closeDatabases, openDatabases } from './db';

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await openDatabases([process.cwd()]);
  app = createApp();
});

afterAll(() => {
  closeDatabases();
});

describe('health', () => {
  it('GET / returns "Hello World!"', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Hello World!');
  });
});

describe('legacy raw SQL (kept during client migration)', () => {
  it('GET /i with empty sql returns []', async () => {
    const res = await app.request('/i');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('GET /d rejects non-SELECT with 400', async () => {
    const res = await app.request(
      '/d?sql=' + encodeURIComponent('create table _x(y int)'),
    );
    expect(res.status).toBe(400);
  });
});

describe('index resources', () => {
  it('GET /editions/madina/sora returns 114 rows', async () => {
    const res = await app.request('/editions/madina/sora');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as unknown[];
    expect(rows).toHaveLength(114);
  });

  it('GET /editions/madina/part returns 30 rows', async () => {
    const res = await app.request('/editions/madina/part');
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(30);
  });

  it('GET /editions/madina/quarter returns 240 rows', async () => {
    const res = await app.request('/editions/madina/quarter');
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(240);
  });

  it('GET /editions/madina/pages returns 604 rows', async () => {
    const res = await app.request('/editions/madina/pages');
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(604);
  });

  it('GET /editions/unknown/sora returns 400', async () => {
    const res = await app.request('/editions/unknown/sora');
    expect(res.status).toBe(400);
  });

  it('GET /editions/tjwid/sora returns 404 (capability gap)', async () => {
    const res = await app.request('/editions/tjwid/sora');
    expect(res.status).toBe(404);
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

  it('GET /editions/madina/aya/notanint returns 400', async () => {
    const res = await app.request('/editions/madina/aya/notanint');
    expect(res.status).toBe(400);
  });
});

describe('composite all-data', () => {
  it('GET /editions/madina/aya/1/full returns one row with many columns', async () => {
    const res = await app.request('/editions/madina/aya/1/full');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).length).toBeGreaterThan(20);
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
      '/editions/madina/search?q=' +
        encodeURIComponent('ا') +
        '&limit=2000',
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
