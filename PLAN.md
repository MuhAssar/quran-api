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

The full curated catalog (one endpoint per real client call site, derived from auditing the Wursha_QuranHolder client) lives in §7 below. Headline shape:

- Edition is a **path parameter** on almost every route (`/editions/:edition/…`); the client already abstracts editions and table names follow `${edition}_*` / `mosshf_${edition}` patterns.
- Inputs are typed (numbers, enums) and bound to libsql via `client.execute({ sql, args })` — no SQL is built from request strings.
- The server enforces row caps (1000 max for search, page-bounded for everything else) and validates `bookCode` against an allow-list of the 63 known book table suffixes.
- Pre-joined "all-data" responses (mosshf row + every book column for an aya) are preserved — the client deliberately uses those to avoid round-trips.

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

### Phase 1 — Lock down: replace raw-SQL with the curated catalog

Built on Phase 2a — implementation uses `@libsql/client` and async handlers throughout. The four legacy routes (`/i`, `/d`, `/f`, `/w`) coexist with the 15 curated routes during the client migration and are removed in 1.10.

Sub-steps:

- [ ] **1.1 Audit and confirm.** Walk through §7 with the latest client (Wursha_QuranHolder) to confirm every call site has a target endpoint. Record the file:line of each call site next to its target row in §7. (High-level audit already done; per-call-site tagging deferred to the client-migration PR in 1.9.)
- [x] **1.2 Resolve table-name discrepancy.** ✅ The client's expected names (`madina_sora`, `madina_search`, `madina_all`, `madina_words`, etc.) all exist as **SQL VIEWS** in the bundled DBs. Missed in the initial audit because `SELECT name FROM sqlite_master WHERE type='table'` excludes views. Present in both the API repo's DBs and the client's newer DBs. Handlers query the views directly. See §8.
- [x] **1.3 `BOOK_CODES` allow-list.** ✅ Discovered dynamically at boot in `src/db.ts` (`SELECT name FROM sqlite_master WHERE name LIKE 'book\_%' ESCAPE '\'`). No hardcoded list to maintain — adding a new `book_*` table is automatically reflected.
- [x] **1.4 Validators.** ✅ Two files: `src/editions.ts` (edition allow-list + per-resource capability sets `CAP_INDEX`/`CAP_PAGES`/`CAP_MOSSHF`/`CAP_ALL_SEARCH`/`CAP_WORDS`/`CAP_FARSH`, plus qaree and search-field allow-lists), and `src/validators.ts` (`assertInt`, `optionalInt`, `assertFloat`, `assertBookCode`). All throw `HTTPException(400|404, …)` directly.
- [x] **1.5 Implement the catalog.** ✅ All 15 routes in `src/app.ts`. Every handler uses libsql parameter binding for values (`{ sql, args: { ... } }`); table/view names interpolated only after the corresponding allow-list check. Per-route caps in place. Every GET sets `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800`.
- [x] **1.6 CORS.** ✅ Configured via `CORS_ORIGINS` env var (comma-separated). Default `*` for dev; production deployments set the Wursha_QuranHolder web origin.
- [x] **1.7 Env config.** ✅ `PORT`, `HOST`, `CORS_ORIGINS`, `DB_INDEX_URL`, `DB_DATA_URL`, `DB_FARSH_URL`, `DB_WORDS_URL`. Each `DB_*_URL` takes priority over filesystem discovery, which stays as a fallback for the `npm start` workflow.
- [x] **1.8 Integration tests.** ✅ 31 tests in `src/app.spec.ts` covering every curated route's happy path, at least one 400/404 per route, capability-gap 404s, search-cap rejection, byte-shape checks on the composite endpoint, the two surviving legacy behaviors, and a CORS smoke check. `beforeAll` opens DBs from `process.cwd()`. (Fixture-DB path deferred — only matters if CI lacks the binaries.)
- [ ] **1.9 Migrate the client.** Coordinate with Wursha_QuranHolder: open a PR there that swaps each web-platform call site to the new endpoint. Cordova and Electron branches unchanged. `/i`, `/d`, `/f`, `/w` stay live during this period.
- [ ] **1.10 Remove the raw-SQL routes** from `src/app.ts` and the SELECT-only gate from `src/db.ts`. Drop the `getDb` export if no caller uses it.
- [x] **1.11 Bruno collection.** ✅ Curated examples under `docs/api/curated/` (`sora`, `aya`, `page-ayat`, `aya-full`, `search`, `book-nearest`, `farsh`, `word`). Legacy `.bru` files at the top level kept until 1.10.
- [x] **1.12 SPEC.md updates.** ✅ Rewrote §1, §2, §4, §7 (split into §7.A curated, §7.B legacy, §7.C/D/E response/errors/CORS), §8 (5-module architecture), §9 (full env-var table), §10 (curated routes safe to expose publicly; legacy routes not), §12 (test coverage), §13 (current known issues only).

**Status:** Server side is complete. 1.9 and 1.10 are gated on the client team's web-build migration PR. Until then, both surfaces coexist on the running server.

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

### Phase 2a — Driver swap on Node: `node:sqlite` → `@libsql/client` ✅

Stays on Node, stays offline, `npm start` unchanged. Only the data layer changed.

- [x] Added `@libsql/client`; removed the `node:sqlite` import from `src/db.ts`.
- [x] Replaced `DatabaseSync(path, { readOnly: true })` with `createClient({ url: 'file:' + path })`. One client per role in module scope, same lifecycle.
- [x] Converted `runQuery(role, sql)` to `async`; uses `client.execute(sql)` and returns `result.rows` (libsql's `Row` serializes as a clean `{col: val}` object — no remapping needed).
- [x] Made `sqlHandler` in `src/app.ts` `async`; awaits `runQuery`.
- [x] **Application-layer write protection** added in `runQuery`: rejects non-`SELECT` SQL with `400 ERR_NOT_SELECT`. This was needed because `@libsql/client` does not support `?mode=ro` for `file:` URLs (returns `URL_PARAM_NOT_SUPPORTED`). Externally-visible behavior matches the previous `node:sqlite` read-only handle (writes still 400).
- [x] Verified `npm install && npm start` works with no network — confirmed via `lsof` that the libsql client opens zero non-loopback sockets when serving `file:` URLs.
- [x] Smoke-tested all four routes: `/`, `/i` (sura list), `/d` (book_quran), `/f` (82,067 farsh rows), `/w` (83,927 words rows), empty SQL, invalid SQL, and a `CREATE TABLE` write attempt (rejected).
- [x] `SPEC.md` updated (§3 driver row, §5 bootstrap, §7 request/response/errors, §8 architecture, §10 security, §13 ops).
- [x] `ExperimentalWarning: SQLite is an experimental feature…` on stderr is gone (no longer using `node:sqlite`).

After Phase 2a: handlers are async, the event-loop-blocking issue is gone, the driver is exactly the one Phase 2b will use, and Goal 3 still holds.

### Phase 2b — Runtime swap: add Workers + Turso (≈1–1.5 days from Phase 2a)

Adds a second runtime entry alongside the Node one. The Hono app, route handlers, and `db.ts` query code stay identical — only the URL the libsql client points at changes (`file:` for Node dev, `libsql://` for the deployed Worker).

- [ ] `turso auth signup` → `turso db create quran`.
- [ ] Import each bundled `.db` into Turso: `sqlite3 <file>.db ".dump" | turso db shell quran` (one DB per role to avoid table-name collisions, *or* one consolidated DB with a `<role>__` prefix convention).
- [ ] Issue a read-only Turso token.
- [ ] Make `db.ts` URL-source aware: read the libsql URL from env (`DB_INDEX_URL`, `DB_DATA_URL`, …), defaulting to `file:./<file>.db` discovery on Node. The Worker entry sets the env to `libsql://…turso.io` URLs.
- [ ] Add `src/worker.ts` exporting `{ fetch: app.fetch }`. Same `createApp()` from Phase 1.5/2a.
- [ ] Configure `wrangler.toml`; store `TURSO_*_URL` and `TURSO_AUTH_TOKEN` via `wrangler secret put`.
- [ ] Add `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800` to every GET handler.
- [ ] (Optional) Add a Cloudflare Cache Rule to bypass the Worker entirely for hot URLs.
- [ ] Port (rewrite) the `docs/api/` Bruno collection to any updated route shapes.
- [ ] **Re-verify Goal 3 after the change:** `npm start` (the Node entry) must still serve every route fully offline against the local `file:./<file>.db` URLs — no calls to `*.turso.io`, no Cloudflare API calls, no `wrangler` required for `npm start`.
- [ ] Add `npm run start:worker` → `wrangler dev` for contributors who want to test the Workers runtime locally (Miniflare; offline once `wrangler` is installed but it does talk to Turso for data unless an embedded replica is configured).
- [ ] Update `SPEC.md` §3 (add the Workers runtime), §4 (add `src/worker.ts`), §8 (note the dual-entry pattern), §11 (new scripts), and add a section on the deployed environment.

### Phase 3 — Custom domain + observability (≈½ day)

- [ ] Move the domain to Cloudflare DNS (free) and bind it to the Worker route.
- [ ] Enable Workers Analytics (free).
- [ ] Verify Turso usage dashboard shows expected read volumes.
- [ ] Document `wrangler tail` for live log tailing in `SPEC.md`.

### Phase 4 — Retire any prior deployment

- [ ] Remove any pre-Hono process from any prior host (NestJS was already removed from the codebase in Phase 1.5; this is just decommissioning live deployments).
- [ ] Final `SPEC.md` pass: delete every reference to drivers/runtimes that are no longer used.

---

## 4. What stays vs. what changes

| Stays | Changes |
|---|---|
| All `.db` data, table schemas, column meanings | NestJS → Hono on Node (Phase 1.5) → Hono on Node + Workers (Phase 2b) |
| TypeScript, ESLint, Prettier configs | `node:sqlite` (sync) → `@libsql/client` with `file:` URL (async, Phase 2a) → same client with `libsql://` URL on Workers (Phase 2b) |
| The four logical namespaces (sura/aya/page, translations, tafsir, words, farsh) | Raw SQL endpoint → typed REST routes (Phase 1) |
| Bruno collection structure under `docs/api/` (contents rewritten) | Hosting model: long-lived Node process → also runs as stateless Workers (Phase 2b adds, doesn't replace) |
| Single `npm start` running pure Node, fully offline (Goal 3) | Build tool: NestJS CLI → `tsc` (Phase 1.5) |

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
- **Client breakage.** The known consumer is Wursha_QuranHolder (Ionic/Angular), which has ~12 distinct call sites across `IndexService`, `SearchService`, `FarshService`, `WordService`. Phase 1.9 ports the client one site at a time before the raw-SQL routes are removed in 1.10.
- ~~**Table-name discrepancy.**~~ ✅ **Resolved (2026-05-16).** No discrepancy: every `${edition}_sora|_part|_quarter|_all|_search|_words` name the client references is a SQL VIEW in the bundled DBs. The initial audit missed it because the schema dump filtered on `type='table'`. Implementation queries the views directly; no schema changes required. Details in §8.
- **`turso dev` availability.** With the 2a/2b split, `npm start` no longer depends on `turso dev` at all — Phase 2a uses `@libsql/client` with `file:./<file>.db` directly (libsql's bundled native bindings open the local SQLite file). `turso dev` only matters if a contributor wants to test Worker behavior locally against a libSQL *server* rather than a local file; even that is optional since `wrangler dev` can point at the cloud Turso for one-off Worker testing.
- **Native bindings in `@libsql/client`.** The Node build ships prebuilt binaries for macOS/Linux/Windows on x64 and arm64. Install is a regular `npm install` with no toolchain required, but the package is heavier than `node:sqlite` (which is built into Node). If a contributor environment ever lacks a prebuilt binary, fallback is to `@libsql/client/web` with a local `sqld` (`turso dev`) — back to the two-process setup, but only as an escape hatch.

---

## 7. Curated endpoint catalog

Derived from auditing every call site in Wursha_QuranHolder. One row per real client query. This is the implementation reference for Phase 1.

**Conventions**
- `:edition` ∈ `{madina, shmrly, libya, tjwid, warsh, qalon, twst, hafs, shoba, jafar, aamer, asbhani, kathir, ibnaamer, thkwan}` — server validates against an allow-list.
- `:bookCode` ∈ the 63 codes listed at the bottom of this section — server validates against an allow-list.
- `:idx` is a global aya index (1..6236).
- All numeric path/query params are validated as integers in plausible ranges; out-of-range → `400`.
- All SQL is composed with libsql parameter binding; user-supplied strings are never interpolated.
- Default response: `200` JSON. Errors: `400` for bad input, `404` for "no such resource" only where the client distinguishes (most empty results return `200 []`).

### 7.1 Index resources — replaces `/i`

| Endpoint | Replaces | SQL pattern (illustrative) | Cap |
|---|---|---|---|
| `GET /editions/:edition/sora` | `getAllItems<SoraModel>` (`madina_sora`) | `SELECT * FROM ${edition}_sora ORDER BY page_number` | 114 rows (number of suras) |
| `GET /editions/:edition/part` | `getAllItems<PartModel>` | `SELECT * FROM ${edition}_part ORDER BY page_number` | 30 rows |
| `GET /editions/:edition/quarter` | `getAllItems<QuarterModel>` | `SELECT * FROM ${edition}_quarter ORDER BY page_number` | 240 rows |
| `GET /editions/:edition/pages` | `getAllItems<PageModel>` (`mosshf_madina_pages`) | `SELECT * FROM mosshf_${edition}_pages ORDER BY page_number` | 604 rows |

These are heavy on the wire but cached per edition on the client (and at the edge in Phase 2b) — request rate is essentially "once per app launch."

### 7.2 Mosshf (page/aya position) — replaces most of `/d`

| Endpoint | Replaces | SQL pattern | Notes / cap |
|---|---|---|---|
| `GET /editions/:edition/aya/:idx` | `getAya` | `SELECT * FROM mosshf_${edition} WHERE aya_index = :idx` | 1 row |
| `GET /editions/:edition/sora/:s/aya/:n` | `getAyaBy` | `SELECT * FROM mosshf_${edition} WHERE sora_number = :s AND aya_number = :n` | 1 row |
| `GET /editions/:edition/sora/:s/aya/:n/page` | `getAyaPage` | `SELECT page_number FROM mosshf_${edition} WHERE sora_number = :s AND aya_number = :n` | 1 row, projected |
| `GET /editions/:edition/page/:n/ayat` | `getAllAyasInPage` | `SELECT * FROM mosshf_${edition} WHERE page_number = :n ORDER BY aya_index` | ≤ ~20 rows |

`mosshf_${edition}` columns: `aya_index, page_number, sora_number, aya_number, x_ratio, y_ratio, x_prev_ratio, y_prev_ratio`.

### 7.3 Composite "all-data" — replaces the heavy `/d` calls

These preserve the client's deliberate denormalization (one row contains every book/translation/tafsir column for that aya).

| Endpoint | Replaces | SQL pattern | Notes / cap |
|---|---|---|---|
| `GET /editions/:edition/aya/:idx/full` | `getAllDataOf` | `SELECT * FROM ${edition}_all WHERE aya_index = :idx` | 1 row, ~70 columns |
| `GET /editions/:edition/page/:n/full` | `getAllDataInPage` | `SELECT * FROM ${edition}_all WHERE page_number = :n ORDER BY aya_index` | ≤ ~20 rows × ~70 columns. Largest payload in the API. |

If a client wants only a subset of book columns, support an optional `?fields=text,katheer,m3any,…` query param (validated against the bookCode allow-list + the always-present mosshf columns) so the response shrinks. Default = all columns (current client behavior).

### 7.4 Search — replaces the dynamic `searchFor*`

| Endpoint | Replaces | Inputs | Notes |
|---|---|---|---|
| `GET /editions/:edition/search` | `searchFor`, `searchFor2`, `searchCountFor` | `q` (required), `field` ∈ `text\|text_uthamni\|text_full\|roots` (default `text`), `mode` ∈ `plain\|word\|pattern\|root` (default `plain`), `sora` (optional), `limit` (default 100, **max 1000**), `count` ∈ `true\|false` | Server applies Arabic normalization (hamza/ya/ta) and the same `REPLACE`-based diacritic-insensitive matching the client uses. `count=true` returns `{count: N}` instead of rows. |

Server-side normalization is the meaningful behavior change: the client today builds the regex/pattern itself. Centralizing it ensures consistency and lets the server pre-validate / reject pathological patterns (e.g. unbounded `%%%%`).

### 7.5 Book window (tafsir / translation / qira'at text) — replaces `getBookText`, `getWordBookText`

| Endpoint | Replaces | SQL pattern | Notes |
|---|---|---|---|
| `GET /book/:bookCode/aya/:idx/nearest` | `getBookText`, `getWordBookText` | `SELECT text FROM book_${bookCode} WHERE aya_index <= :idx ORDER BY aya_index DESC LIMIT 1` | "Nearest preceding" semantic (not every aya has every book entry). 1 row, projected to `{text}`. |

`bookCode` is validated against the allow-list (§7.7). Edition is **not** in the path — `book_*` tables are not edition-scoped.

### 7.6 Farsh (qira'at marks) — replaces `/f`

| Endpoint | Replaces | SQL pattern | Notes |
|---|---|---|---|
| `GET /editions/:edition/page/:n/farsh` | `getAllFarshInPage` | `SELECT * FROM ${farshTable} WHERE page_number = :n AND (qaree = :qaree${withWaqf ? " OR qaree = 'Q'" : ''})` | `farshTable` = `shmrly` for shmrly edition, else `madina`. Query params: `qaree` (required, FarshQareeEnum), `waqf` ∈ `true\|false` (default `false`). |

### 7.7 Words — replaces `/w`

| Endpoint | Replaces | SQL pattern | Notes |
|---|---|---|---|
| `GET /editions/:edition/page/:n/word/at` | `getNearestWord` | `SELECT * FROM ${edition}_words WHERE :x BETWEEN x AND x+width AND :y BETWEEN y-0.07 AND y AND page_number = :n ORDER BY aya_index LIMIT 1` | Query params: `x`, `y` (floats, 0..1). Server returns first match (the client takes only the first row anyway). |
| `GET /editions/:edition/word/:wordindex` | `getAllDataOf` (word service) | `SELECT * FROM ${edition}_words WHERE wordindex = :wordindex` | All instances of a word. |
| `GET /editions/:edition/word/:wordindex/aya-first` | `getAyaFirstWordIndex` | `SELECT MIN(wordindex) AS wordindex FROM ${edition}_words WHERE aya_index = (SELECT aya_index FROM ${edition}_words WHERE wordindex = :wordindex) [AND wordindex < :wordindex]` | Optional `before=true` query param adds the bounding clause (the current client passes a SQL fragment; replace with a typed flag). |

### 7.8 Health

| Endpoint | Replaces | Notes |
|---|---|---|
| `GET /` | current `/` | Keeps returning `Hello World!` for liveness checks. |

### 7.9 Allow-listed `bookCode` values (63)

```
Tafsirs (20):     mokhtsr, qortoby, katheer, moyassar, sa3dy, baghawy, tabary,
                  tanweer, nozol, waseet, juzay, aljadwal, aldur, mgharieb,
                  alnashir, zadmaseer, ibnatiyah, nasafi, nathm, adwaa
Qira'at (21):     tayseer10, qqalon, qwarsh, qibnkather, aboamro, ibnamer, sho3ba,
                  qhamza, kisai, abujafar, yaqob, khalaf, all10, asbhni, shawahid,
                  ashabsela, twsot, sama, asemamer, kisaikhalaf, basryan
Meanings/Grammar: m3any, e3rab, motshabeh7
Waqf:             waqf, mwaqf
Translations (14):english, phonetic, russian, turkish, indonesian, malay, urdu,
                  farsi, pickthall, french, dutch, azerbaijani, sahihint, german
Scripture/misc:   quranu, taybashahid
```

This list is the source of truth for Phase 1.3's `BOOK_CODES` constant and the `?fields=` validator in §7.3.

### 7.10 Endpoint count

15 distinct routes (1 health + 4 index + 4 mosshf + 2 composite + 1 search + 1 book + 1 farsh + 3 words). Every existing client call site has a target.

---

## 8. View-based query strategy (resolved from §6)

The bundled DBs ship with SQL VIEWS that present clean `${edition}_*` names over the underlying tables. Phase 1 handlers **query the views, not the base tables**, so the implementation stays trivial and the response shape is byte-identical to today's raw-SQL responses.

### Views present in the bundled DBs

| DB | Views | Backed by |
|---|---|---|
| `index_v11.db` (and `index_v13.db` in the client) | `madina_sora`, `madina_part`, `madina_quarter`; `shmrly_sora`, `shmrly_part`, `shmrly_quarter`; `libya_sora`, `libya_part`, `libya_quarter` | Joins of `mosshf_${edition}_*` with `quran_*` |
| `data_v21.db` (and `data_v23.db` in the client) | `madina_search`, `shmrly_search`, `libya_search`, `tjwid_search`; `madina_all`, `shmrly_all`, `libya_all`, `tjwid_all` | Joins/correlated-subqueries over `mosshf_${edition}` + ~50 `book_*` tables |
| `words_v2.db` (and `words_v4.db` in the client) | `madina_words`, `shmrly_words`, (`tjwid_words` in newer DB) | Projection over `wordsall` with column renames (`x1`→`x`, `y1`→`y`, `width1`→`width`, `page_number1`→`page_number`) |
| `farsh_v12.db` | (no views; physical tables `madina` and `shmrly`) | — |

### Example view definitions (from this repo's `index_v11.db` / `data_v21.db`)

```sql
-- madina_sora (index DB)
CREATE VIEW madina_sora AS
SELECT mosshf_madina_sora.page_number, quran_sora.*
FROM quran_sora
JOIN mosshf_madina_sora ON quran_sora.sora_number = mosshf_madina_sora.sora_number;

-- madina_search (data DB)
CREATE VIEW madina_search AS
SELECT mosshf_madina.*, book_quran.text, book_quran.text_full,
       book_quranu.text AS text_uthamni, book_quran.roots
FROM mosshf_madina
JOIN book_quran   ON mosshf_madina.aya_index = book_quran.aya_index
JOIN book_quranu  ON mosshf_madina.aya_index = book_quranu.aya_index;

-- madina_all (data DB) — projects ~50 book_* columns per aya via correlated subqueries
CREATE VIEW madina_all AS SELECT *,
  (SELECT text FROM book_qortoby WHERE aya_index = mosshf_madina.aya_index) AS qortoby,
  (SELECT text FROM book_katheer WHERE aya_index = mosshf_madina.aya_index) AS katheer,
  -- … ~50 more columns, plus a nearest-preceding waqf:
  (SELECT text FROM book_waqf
     WHERE aya_index <= mosshf_madina.aya_index
     ORDER BY aya_index DESC LIMIT 1) AS waqf
FROM mosshf_madina;
```

### Handler-to-view mapping

| Endpoint (§7) | Queries view | Notes |
|---|---|---|
| `GET /editions/:edition/sora` | `${edition}_sora` | Index DB view |
| `GET /editions/:edition/part` | `${edition}_part` | Index DB view |
| `GET /editions/:edition/quarter` | `${edition}_quarter` | Index DB view |
| `GET /editions/:edition/pages` | `mosshf_${edition}_pages` | Physical table (no view layer) |
| `GET /editions/:edition/aya/:idx` and siblings | `mosshf_${edition}` | Physical table in Data DB |
| `GET /editions/:edition/aya/:idx/full`, `/page/:n/full` | `${edition}_all` | Data DB view |
| `GET /editions/:edition/search` | `${edition}_search` | Data DB view |
| `GET /book/:bookCode/aya/:idx/nearest` | `book_${bookCode}` | Physical table; allow-list validated |
| `GET /editions/:edition/page/:n/farsh` | `madina` or `shmrly` | Physical table (selected by edition) |
| `GET /editions/:edition/page/:n/word/at`, `/word/:wordindex` | `${edition}_words` | Words DB view |

This means the handler logic is, for almost every route, a single parameter-bound SELECT against a view. No JOINs to author, no column lists to maintain — that work was already done in the DB schema.

### Edition coverage gaps to validate in Phase 1.1

The view set is not symmetric across editions. Spot checks against this repo's DBs:

- **Index DB:** has views for `madina`, `shmrly`, `libya`. No views for `tjwid`, `warsh`, `qalon`, `hafs`, `shoba`, `jafar`, `aamer`, `asbhani`, `kathir`, `ibnaamer`, `thkwan`, `twst`. The client's edition services for those likely either don't call `getAllItems` (Tjwid service only sets DB tables, not sora/part/quarter tables) or rely on the client's local DB having additional views the API repo's DB does not.
- **Data DB:** has `*_search` and `*_all` for `madina`, `shmrly`, `libya`, `tjwid` — not for the other editions.
- **Words DB:** API repo's `words_v2.db` has `madina_words`, `shmrly_words`, `tjwid_words`. Client's newer `words_v4.db` confirmed same set.

If the API will ever serve those editions, the views need to be added to the DBs (a one-shot `CREATE VIEW` script) or the endpoints must return 404 for unsupported editions. Phase 1.1's audit should enumerate which editions the *web platform* of Wursha_QuranHolder actually exercises — likely a small subset, since most editions ship as separate Cordova builds (`to-warsh.sh`, `to-hafs.sh`, etc. swap edition assets at build time, not at runtime).

---

## 9. Cordova / Electron compatibility (resolved from the user's question)

**The HTTP API changes in Phase 1 cannot break the Cordova or Electron paths of Wursha_QuranHolder**, because those platforms never call the HTTP API. The platform dispatch in `IndexService.executeSql` (and the equivalents in `SearchService`, `WordService`, `FarshService`) routes by `Platform.is(…)`:

```ts
if (this.platform.is('electron')) {
  return await (window as any).api.index(query);   // IPC to Node's better-sqlite3 / sql.js
} else if (this.platform.is('cordova')) {
  const data = await this.db.executeSql(query, []); // on-device SQLite plugin
  // …row extraction…
} else {
  // Web only — hits our HTTP API
  return await this.http.get<any[]>(`${env.quranApiUrl}/i?sql=${query}`).toPromise();
}
```

Implications:

1. **Web is the only HTTP consumer.** Any change to `/i`, `/d`, `/f`, `/w` (or their replacements) affects web users only. Cordova/Electron continue using their on-device DBs unchanged.
2. **Row shape is the contract.** The Cordova path returns `data.rows.item(i)` (a plain `{column: value}` object from the SQLite plugin). The HTTP path returns the same shape from `JSON.stringify(client.execute(sql).rows)`. The shared model constructors (`SoraModel`, `MosshfDataModel`, `WordsDataModel`, `FarshModel`) read `dbRow.page_number`, `dbRow.sora_number`, etc. — so **as long as the curated endpoints return rows with the same snake_case column names as the underlying view/table, no client code besides the URL-builder needs to change**.
3. **The client-side migration in Phase 1.9 is platform-scoped.** Each data service method gets an updated `else` branch (the web case): instead of building a SQL string and `GET /i?sql=…`, it builds a typed URL like `GET /editions/madina/sora`. The Cordova and Electron branches are untouched. PR is small per service.
4. **Same DB version, both sides.** The client ships `index_v13.db`, `data_v23.db`, `words_v4.db`, `farsh_v14.db` (in `Wursha_QuranHolder/www/`). The API repo currently has `*_v11`, `*_v21`, `*_v2`, `*_v12`. Either is fine for the curated-endpoint implementation — the relevant views exist in both — but the API repo should be bumped to the newer DB versions before deploy so any new columns/views the client expects are present.
5. **Edition coverage gaps (§8) only matter for web.** A Cordova build for the Warsh edition ships with a Warsh-flavored asset bundle (per `to-warsh.sh`) and uses the on-device DB; the API never hears about it. If/when a web build of Wursha_QuranHolder is published for an edition outside `{madina, shmrly, libya, tjwid}`, the API DBs need the corresponding views added — track in Phase 1.1.

### Concrete safety checks to run in Phase 1.9

- [ ] For every curated endpoint shipped, write a parity test: a row from the new endpoint matches `json.dumps(rows from the equivalent raw SQL)` byte-for-byte (modulo response ordering — both should be sorted).
- [ ] Manual smoke test on iOS Cordova build + Android Cordova build + Electron build: the app must work entirely offline (airplane mode), proving HTTP is never touched.
- [ ] Manual smoke test on the web build with the new endpoints, confirming render parity with the Cordova build for a few pages.
