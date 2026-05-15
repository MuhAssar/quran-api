# Refactor Plan — Cheap Public Hosting at Scale

**Goals**
1. Host the service online on the cheapest viable plan.
2. Support thousands of concurrent users / requests.
3. **Run locally and fully offline with a single `npm start`** (no cloud account, no internet, no Docker required). This is a hard constraint, not a nice-to-have — it rules out any option that has no local server story.

This plan is the agreed direction. It supersedes any conflicting suggestions in older notes. Once a phase ships, mark it ✅ and update `SPEC.md` to reflect reality.

---

## 0. Constraint to acknowledge first

The current `?sql=…` raw-SQL pass-through (see `SPEC.md` §7, §10) **cannot be exposed publicly**. Any user can submit `SELECT * FROM wordsall CROSS JOIN book_quran` and either burn a serverless CPU quota or OOM a small VM. Every option below assumes the raw-SQL surface is replaced by curated endpoints (or, at minimum, a tightly parsed/limited SQL subset with mandatory `LIMIT`).

If that assumption is ever rejected, this plan is invalid — fall back to "private network only, no public deployment."

---

## 1. Target stack

### Runtime — Hono on Cloudflare Workers
- Hono's controller/handler API is close enough to NestJS that route migration is mechanical.
- Workers scale to thousands of concurrent requests with no provisioning, sub-millisecond cold start, ~300 global PoPs.
- TypeScript-native; existing ESLint/Prettier configs carry over.
- `node:sqlite` does not run on Workers — that driver is replaced (see below).

### Database — Turso (libSQL)
- libSQL is a SQLite fork; standard SQLite SQL works unchanged.
- Total bundled data is ~410 MB (`data_v21.db` 306 MB, `words_v2.db` 91 MB, `farsh_v12.db` 13 MB, `index_v11.db` 124 KB) — well under Turso's 9 GB free-tier ceiling.
- Edge-replicated reads → low latency from any PoP.
- Read-only by access control (issue read-only tokens to the Worker).
- Migration is a straightforward `sqlite3 file.db ".dump" | turso db shell <name>` per file.
- **Offline story:** `@libsql/client` accepts `libsql://…` (cloud), `http://127.0.0.1:8080` (local `sqld`), or `file:local.db` (plain SQLite, when running on Node). For local dev we point at a local `sqld` started by `turso dev`, so the same connection code works in both environments — only the URL changes.

### API surface — typed REST, not raw SQL
Keep the four logical namespaces but expose curated routes. Initial set:

- `GET /sura` — list sura metadata
- `GET /sura/:n` — single sura
- `GET /aya/:idx` — single aya by global index
- `GET /aya/:sura/:n` — single aya by sura+aya
- `GET /page/:mushaf/:n` — page layout (joined with words and farsh)
- `GET /translation/:lang/:idx` — translation by language and aya index
- `GET /tafsir/:book/:idx` — tafsir entry
- `GET /word/:idx` — single word
- `GET /search?q=…&book=…&limit=…` — text search with **mandatory LIMIT cap**

Every GET response sets `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800`. Quranic data is static, so Cloudflare's edge cache absorbs nearly all repeat traffic without hitting Turso at all.

### Hosting / cost
- Cloudflare Workers free tier: 100k req/day. Paid: $5/mo for 10M req/mo.
- Turso free tier: 9 GB storage, 1 B row reads/mo, 25 M row writes/mo.
- Realistic monthly cost: **$0** until real traffic; **$5** well into tens of thousands of MAU.

---

## 2. Why not the alternatives

| Option | Why it loses |
|---|---|
| Keep NestJS on Fly.io / Render small VM | $2–7/mo, but a single small instance handles dozens, not thousands, of concurrent requests when SQLite is sync (`node:sqlite`). One slow query stalls the event loop. Vertical scaling defeats "cheapest." |
| Cloudflare D1 instead of Turso | D1 free is 5 GB / 5 M reads/day, but `data_v21.db` at 306 MB makes import slow/finicky. More importantly, D1 has no full local-server equivalent (only `wrangler dev --local`, which is limited and Wrangler-coupled), so it conflicts with Goal 3. |
| sql.js / wa-sqlite in Workers, DB in R2 | Fits the edge model in theory, but loading a 306 MB SQLite via R2 per cold worker is impractical; range-VFS is fragile. |
| Pre-generate all responses as static JSON to a CDN | Truly free and infinitely scalable, but search/word endpoints have an unbounded query space — not viable. |

---

## 3. Phased migration

### Phase 1 — Lock down the current service (≈1 day)

Done on the existing NestJS codebase. Even if Phase 2 slips, this checkpoint is publishable.

- [ ] Replace raw-SQL endpoints (`/i`, `/d`, `/f`, `/w`) with the typed route list in §1, implemented against `node:sqlite`.
- [ ] Open one `DatabaseSync` per role at boot and reuse for the process lifetime (today's code opens/closes per request — see `SPEC.md` §13).
- [ ] Enforce `LIMIT` and per-handler row caps server-side.
- [ ] Externalize port, CORS origins, and DB file paths to env vars (`@nestjs/config`).
- [ ] Tighten CORS from `*` to an allowlist.
- [ ] Update `SPEC.md` §7, §9, §10, §13 to reflect the new route surface and the removal of raw SQL.

Outcome: safe to host on a $2–3/mo Fly.io / Railway instance and handle hundreds of concurrent requests.

### Phase 1.5 — Hono on Node ✅ (done ahead of Phase 1)

Framework-only swap. Phase 1 (typed-route lockdown) was deferred and will run on top of this; the four raw-SQL routes are preserved as-is for now.

- [x] Added `hono` and `@hono/node-server`; removed `@nestjs/*`, `reflect-metadata`, `rxjs`, `supertest`, `ts-node`, `tsconfig-paths`, `ts-loader`, `source-map-support`.
- [x] Replaced `src/main.ts` + `src/app.module.ts` + `src/app.controller.ts` + `src/app.service.ts` + `src/settings.ts` with `src/server.ts` + `src/app.ts` + `src/db.ts`. The four routes (`/`, `/i`, `/d`, `/f`, `/w`) and their JSON / 400 contracts are unchanged.
- [x] Kept `node:sqlite` (`DatabaseSync`); each role's handle is opened once at boot in `src/db.ts` and reused for the process lifetime (eliminates the previous per-request open/close).
- [x] Kept the bundled `.db` files and the prefix-based discovery (`index*`, `data*`, `farsh*`, `words*`).
- [x] Scripts: `npm start` runs `tsx src/server.ts` directly — no build step required for offline dev. `npm run start:prod` runs `node dist/server.js`. No `wrangler`, no `turso dev`, no second process.
- [x] Dropped `nest-cli.json`; build is now `tsc -p tsconfig.build.json`.
- [x] Replaced the Jest+supertest tests with `src/app.spec.ts` using Hono's `app.request()`. Removed the `test/` folder.
- [x] Verified `npm install && npm start` works locally; smoke-tested all four routes against the bundled DBs and 400-on-error.
- [x] `SPEC.md` updated (§3, §4, §5, §7, §8, §9, §10, §11, §12, §13, §16).
- [x] Boot now `process.exit(1)`s on missing required DB (improvement over the previous silent NestJS abort).

After Phase 1.5 the service is deployable to any Node host (Fly.io, Render, Railway) and offline dev is a single `npm start`. It does **not** yet meet Goals 1 and 2 — those need Phase 2.

### Phase 2 — Port to Workers + Turso (≈2 days from Phase 1.5)

Building on the Hono app from Phase 1.5, the only meaningful changes are: swap the DB driver, swap the runtime adapter, and add edge caching.

- [ ] `turso auth signup` → `turso db create quran`.
- [ ] Import each bundled `.db` into Turso: `sqlite3 <file>.db ".dump" | turso db shell quran` (run per file; namespace tables if collisions occur, e.g. prefix `index_`, `words_`, `farsh_`).
- [ ] Issue a read-only Turso token for the Worker.
- [ ] Add a Cloudflare Workers entry alongside the Node entry (e.g. `src/worker.ts` exporting `{ fetch: app.fetch }`); the same `app: Hono` instance from Phase 1.5 serves both runtimes.
- [ ] Swap `node:sqlite` for `@libsql/client` (`client.execute({ sql, args })`). Keep the call sites identical between Node (`file:./quran.db` or `http://127.0.0.1:8080`) and Workers (`libsql://….turso.io`).
- [ ] Configure `wrangler.toml`; store `TURSO_URL` and `TURSO_TOKEN` via `wrangler secret put`.
- [ ] Add `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800` to every GET handler.
- [ ] (Optional) Add a Cloudflare Cache Rule to bypass the Worker entirely for hot URLs.
- [ ] Port (rewrite) the `docs/api/` Bruno collection to the new route shapes.
- [ ] **Wire up the `npm start` offline path (Goal 3):** make `npm start` spawn `turso dev --db-file ./quran.db` and `wrangler dev` together (e.g. via `concurrently` or `npm-run-all`). Document a one-time `npm run db:import` script that imports the bundled `.db` files into `./quran.db` so a fresh clone goes from zero to running offline with `npm install && npm run db:import && npm start`.
- [ ] Verify `npm start` works with the network disabled — no calls to `*.turso.io`, no Cloudflare API calls, no auth prompts.
- [ ] Rewrite `SPEC.md` to describe the Hono + Turso architecture; archive the NestJS sections.

### Phase 3 — Custom domain + observability (≈½ day)

- [ ] Move the domain to Cloudflare DNS (free) and bind it to the Worker route.
- [ ] Enable Workers Analytics (free).
- [ ] Verify Turso usage dashboard shows expected read volumes.
- [ ] Document `wrangler tail` for live log tailing in `SPEC.md`.

### Phase 4 — Retire the NestJS deployment

- [ ] Remove the NestJS process from any prior host.
- [ ] Remove unused dependencies (`@nestjs/*`, `express`, `node:sqlite` reference, `rimraf`).
- [ ] Final `SPEC.md` pass: delete every reference to the old runtime.

---

## 4. What stays vs. what changes

| Stays | Changes |
|---|---|
| All `.db` data, table schemas, column meanings | NestJS → Hono (Phase 1.5, on Node) → Hono on Workers (Phase 2) |
| TypeScript, ESLint, Prettier configs | `node:sqlite` (sync, in-process) → `@libsql/client` (async, HTTP) — at Phase 2 only |
| The four logical namespaces (sura/aya/page, translations, tafsir, words, farsh) | Raw SQL endpoint → typed REST routes (Phase 1) |
| Bruno collection structure under `docs/api/` (contents rewritten) | Hosting model: long-lived Node process → stateless Workers (Phase 2) |
| Single `npm start` for offline dev (Goal 3) | Build tool: NestJS CLI → `tsc` (or `tsup`) at Phase 1.5 |

---

## 5. Cost summary

| Traffic | Monthly cost |
|---|---|
| Idle | $0 |
| ~3 M req/mo (≈100 k/day) | $0 (within Workers free tier; most reads served from Cloudflare cache) |
| ~10 M req/mo | $5 (Workers Paid) |
| ~100 M req/mo | ~$30–50 (Workers + Turso paid; Cloudflare bandwidth is free) |

---

## 6. Risks and open questions

- **Table name collisions across DBs.** Today's four databases share names like `wordsall` only within their own DB; merging into one Turso DB needs a namespacing convention (e.g. `index__quran_sora`, `data__book_quran`, `words__wordsall`). Decide before Phase 2 import.
- **Turso row-read budget.** 1 B reads/mo is generous, but a chatty endpoint that returns thousands of rows per call can spike usage. The mandatory `LIMIT` cap and edge caching mitigate this; monitor in Phase 3.
- **Search latency.** Full-text search across `book_*` tables may need an FTS5 virtual table created during the Turso import.
- **Client breakage.** Any current client relying on `?sql=…` will break in Phase 1. Confirm the consumer set before starting.
- **`turso dev` availability.** Goal 3 depends on the `turso` CLI being installable on the contributor's OS. It supports macOS, Linux, and Windows (via WSL/native), so this is broadly safe — but if a contributor environment ever can't run `turso dev`, the fallback is `@libsql/client` with a `file:./quran.db` URL on a Node adapter for Hono (Hono runs unchanged on Node), which keeps the offline goal but loses runtime parity with production Workers.
