import { createApp } from './app';

describe('app', () => {
  it('GET / returns "Hello World!"', async () => {
    const app = createApp();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Hello World!');
  });

  it('GET /i with empty sql returns []', async () => {
    const app = createApp();
    const res = await app.request('/i');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
