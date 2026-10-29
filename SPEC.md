# Quran API — Specification

This document is the single source of truth for the design, behavior, and operation of the `quran-api` service. It describes what the project is, what it exposes, how it is structured, and the constraints under which it must operate.

---

## 1. Purpose

`quran-api` is a small HTTP service that exposes the contents of several pre-built SQLite databases of Quran-related data (text, mushaf layout, words, translations, tafsir, qira'at, etc.) to client applications.

The databases are the **split content DBs** of the private `wursha-data` repo (October 2026, Wursha_QuranHolder `specs/data-db-split.md`): a core `quran_v1.db`, one `book_<key>_v1.db` per book, one `words_<layout>_v1.db` per word-coordinate layout, one `word_<key>_v1.db` per word-page tab and `farsh_v15.db`, plus one `layout_<key>_v1.db` per Mushaf layout from the private `wursha-layouts` repo. Each file is a **target** (`quran`, `book.tabary`, `words.madina`, `word.sarf`, `farsh`, `layout.madina`); the app (web build) sends its SQL to `GET /db/:target` (§7.A.2), the same SQL the Cordova and Electron builds run on the same files. The monolithic `data_v25.db` / `words_v5.db` / `farsh_v15.db` copies and their `data`/`farsh`/`words` roles are gone, with the legacy `/d`, `/f`, `/w` routes (removed after the app switched, data-db-split §5.4 step 3).

The service exposes a **curated, typed REST surface** (14 endpoints, §7) over the bundled databases. All endpoint inputs are validated and bound as SQL parameters; no client-supplied SQL is executed.

Next to the curated surface, `GET /db/:target?sql=` (§7.A.2) runs `SELECT`s from the app's web build on one content DB; it is trusted-network only (§10).

The service has **no index data** (sura/juz/quarter/page lists). Wursha_QuranHolder used to read it from `index_v14.db` through `/i`; since its PR #177 (October 2026) the app bundles those lists as JSON (`src/assets/json/index/`) on every platform, so the `index` DB role, `/i` and the curated `/editions/:edition/sora|part|quarter|pages` routes were removed here.

---

## 2. Scope and non-goals

In scope:
- Read-only access to bundled SQLite databases over HTTP via a curated REST surface.
- Edge-friendly responses (long `Cache-Control` on every GET) so a future CDN layer can absorb most traffic.
- CORS allowlist for browser clients (configurable per environment).

Out of scope (intentionally):
- Authentication, authorization, rate limiting, quotas.
- ORM models, migrations, or schema validation in the application code (schema lives in the DB; views handle aliasing).
- Write traffic from clients.
- Multi-tenancy, user accounts, or per-request configuration.

The curated routes are safe for **public deployment** (typed/bound inputs, capped result sizes, no client SQL). `/db/:target` is trusted-network only.

---

## 3. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (target `es2022`, `commonjs` modules) | `tsconfig.json` |
| Runtime | Node.js 22 (`.nvmrc`) | Required for `node:sqlite` built-in module |
| Framework | Hono 4 (`hono`) on Node via `@hono/node-server` | Web-standard `Request`/`Response`; runs unchanged on Node, Bun, Deno, Cloudflare Workers |
| Database driver | `@libsql/client` (Node build) opening local files via `file:` URLs | Async API; ships prebuilt native bindings (libsql, a SQLite fork). The same client is used in Workers (Phase 2b in `PLAN.md`); only the URL changes (`file:./…` ↔ `libsql://….turso.io`). |
| Dev runner | `tsx` | Used by `npm start` and `npm run start:dev` to run TS directly without a build step |
| Lint / format | ESLint 8 + `@typescript-eslint` + Prettier (`singleQuote: true`, `trailingComma: 'all'`) | `.eslintrc.js`, `.prettierrc` |
| Tests | Jest 29 + `ts-jest`; tests use Hono's `app.request()` directly (no HTTP loopback / supertest) | Configured in `package.json` |
| Build tool | `tsc -p tsconfig.build.json` | Plain TypeScript compiler, no NestJS CLI |

`strictNullChecks`, `noImplicitAny`, and `strict` are disabled in `tsconfig.json`. Future code should not rely on the absence of these checks.

NestJS was used previously and was removed in the Hono-on-Node migration (Phase 1.5 of `PLAN.md`). The route surface and behavior are preserved exactly; only the framework changed.

---

## 4. Repository layout

```
quran-api/
├── src/
│   ├── server.ts                # Entry point: opens DBs, starts the Node server
│   ├── app.ts                   # Hono app: all routes (curated + /db/:target)
│   ├── content-db.ts            # split content DBs: target registry, one libsql client per target, /db/:target
│   ├── editions.ts              # Edition allow-lists and per-resource capability checks
│   ├── validators.ts            # assertInt / assertFloat / assertBookCode / optionalInt
│   └── app.spec.ts              # Jest tests using `app.request()`
├── docs/api/                    # Bruno HTTP collection
│   ├── bruno.json
│   ├── hello.bru                # legacy /
│   ├── curated/                 # curated REST examples
│   │   ├── aya.bru
│   │   ├── page-ayat.bru
│   │   ├── aya-full.bru
│   │   ├── search.bru
│   │   ├── book-nearest.bru
│   │   ├── farsh.bru
│   │   └── word.bru
│   └── environments/localhost.bru
├── *.db                         # SQLite database files (see §6). Gitignored.
├── tsconfig.json
├── tsconfig.build.json
├── .eslintrc.js
├── .prettierrc
├── .nvmrc                       # Node 22
└── package.json
```

`*.db`, `*.db-shm`, and `*.db-wal` are gitignored. Database files are distributed and versioned out-of-band; the application discovers whatever is present at runtime.

---

## 5. Bootstrap and database discovery

`src/server.ts` is the entry point. On startup:

1. **Content DBs:** `openContentDbs(contentDbDirs(repoRoot), layoutDbDirs(repoRoot))` from `src/content-db.ts`. The folders are, in order: `DB_DIR` (if set), `../wursha-data/dist/` (a local data build), `../Wursha_QuranHolder/.data-cache/current/` (the release the app last fetched). The **first** folder that contains a `quran_v*.db` is used for every target (folders are never mixed, so all files come from one data release). The `layout.<key>` targets then come from the first layout folder that has a `layout_*_v*.db`: `LAYOUT_DB_DIR` (if set), `../wursha-layouts/dist/` (a local layouts build), `../Wursha_QuranHolder/.layouts-cache/current/` (the layouts release the app last fetched); they replace any layout DBs of the data folder (wursha-data releases up to v2026.11.1 had them). Each file name `<target with . → _>_v<N>.db` maps to a target; the highest `N` per target wins. A client is created on the first query of a target and checked against `_meta.key` (a renamed file fails instead of serving the wrong content). Startup fails (`process.exit(1)`) without `quran`, unless `DB_URL_TEMPLATE` is set (§9).
2. Builds the Hono app via `createApp()` from `src/app.ts`.
3. Starts the Node HTTP server via `serve({ fetch: app.fetch, port, hostname })` from `@hono/node-server`. Port is `process.env.PORT` (default `3000`); hostname is `process.env.HOST` (default `0.0.0.0`).

Implications:
- Boot failure is a real `process.exit(1)`, so process supervisors detect it correctly.
- Clients are never closed during normal operation. `closeContentDbs()` is exported for tests/teardown.

---

## 6. Database files

### 6.1 Split content DBs

Built and released by the `wursha-data` repo (its README lists the schemas; `_meta (key, value)` with `key`, `version`, `rev` in every file):

| Target | File | Tables |
|---|---|---|
| `quran` | `quran_v1.db` | `mosshf_madina\|shmrly\|tjwid\|libya\|hafs`, `book_quran`, `book_quranu`, `quran_colors`, views `<edition>_search` |
| `farsh` | `farsh_v15.db` | `madina`, `shmrly` |
| `words.<layout>` | `words_<layout>_v1.db` (`madina`, `shmrly`, `tjwid`) | `words (wordindex, wordsno, aya_index, surah, ayah, page_number, x, y, width, word, rawword, root)`, key `(wordindex, wordsno)`; `madina` has no marker rows (`wordsno` 999/1000/1001) |
| `book.<key>` | `book_<key>_v1.db` (62 books) | `book (aya_index INTEGER PRIMARY KEY, text)` |
| `word.<key>` | `word_<key>_v1.db` (`meaning`, `sarf`, `irab`, `qeraat`, `trns`) | `word (wordindex INTEGER PRIMARY KEY, text)`; `qeraat` also `text_n` (the old `qeraatN`) |
| `layout.<key>` | `layout_<key>_v1.db` (built and released by **`wursha-layouts`**, not wursha-data) | `mosshf` (verse geometry, one row per verse per page, `segment`), optional `words`, `farsh`; served through `/db/layout.<key>` only |

The `<edition>_all` and `<edition>_words` views of the monolithic files are gone: `/full` and the word routes compose the rows in code (§7.A).

---

## 7. HTTP API

Base URL (default): `http://localhost:3000`

### 7.A Curated REST surface (14 routes)

All curated GET responses set `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800` so a future edge cache absorbs most traffic. All inputs are validated and bound as SQL parameters; table/view names are only ever interpolated *after* the corresponding allow-list check.

**Health**

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Returns the literal string `Hello World!` (`Content-Type: text/plain`). |

**Mosshf (aya position)** (editions: `madina`, `shmrly`, `libya`, `tjwid`, `hafs`)

| Method | Path | Returns |
|---|---|---|
| `GET` | `/editions/:edition/aya/:idx` | One row from `mosshf_${edition}` by global aya index (1..6236) |
| `GET` | `/editions/:edition/sora/:s/aya/:n` | One row, by sura number (1..114) + aya number (1..286) |
| `GET` | `/editions/:edition/sora/:s/aya/:n/page` | Projected `page_number` only |
| `GET` | `/editions/:edition/page/:n/ayat` | All ayat on a page (1..604), ordered |

**Composite "all-data"** (editions: `madina`, `shmrly`, `libya`, `tjwid`)

| Method | Path | Returns |
|---|---|---|
| `GET` | `/editions/:edition/aya/:idx/full` | The `mosshf_${edition}` row plus `aya_text`, `aya_text_full`, `quranu` (the column names of the old `${edition}_all` view), and one column per book in `?books=a,b,…` (default: none; unknown book → 400), read from each `book.<key>`. `waqf` and `mwaqf` take the nearest preceding row (`NEAREST_BOOKS`), every other book its own row (`null` if none). |
| `GET` | `/editions/:edition/page/:n/full` | All ayat on a page, same columns, ordered |

**Search** (editions: `madina`, `shmrly`, `libya`, `tjwid`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/editions/:edition/search` | Query string: `q` (required), `field` ∈ `text\|text_uthamni\|text_full\|roots` (default `text`), `sora` (optional, 1..114), `limit` (default 100, max 1000). Returns rows from view `${edition}_search` matching `<field> LIKE '%q%'`. |
| `GET` | `/editions/:edition/search/count` | Same inputs except `limit`. Returns `{count: N}`. |

**Book window** (any allow-listed `bookCode`; allow-list = the `book.*` targets found at boot)

| Method | Path | Returns |
|---|---|---|
| `GET` | `/book/:bookCode/aya/:idx/nearest` | `{text: …}` — the nearest row of `book` on `book.<bookCode>` where `aya_index <= idx`. `null` if none. |

**Farsh** (editions: `madina`, `shmrly`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/editions/:edition/page/:n/farsh` | Query string: `qaree` ∈ `{A..Z}` (allow-listed), `waqf` ∈ `true\|false` (default `false`). Returns rows from physical table `madina`/`shmrly`. |

**Words** (editions: `madina`, `shmrly`, `tjwid`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/editions/:edition/page/:n/word/at` | Query string: `x`, `y` (floats 0..1). Returns the first word of `words` on `words.<layout>` whose box contains `(x, y)`. |
| `GET` | `/editions/:edition/word/:wordindex` | The word's layout row (`wordsno < 999`, so no marker row) plus `meaning`, `sarf`, `irab`, `qeraat`, `qeraatN`, `trns` from the five `word.<key>` packs. |
| `GET` | `/editions/:edition/word/:wordindex/aya-first` | `{wordindex}` of the first word in the same aya. With `?before=true`, the first word *before* `:wordindex` in that aya. |

The edition → layout map is `WORDS_LAYOUT` in `editions.ts` (`madina`, `shmrly`, `tjwid` → their own layout).

### 7.A.2 Raw SQL on one content DB: `GET /db/:target?sql=…`

The channel the app's web build uses (`ContentDbService.query(target, sql)` in Wursha_QuranHolder): the SQL is the same the Cordova and Electron builds run on the same file. `:target` must match `farsh|quran|words.<x>|book.<x>|word.<x>` and be a known target, else `400`. `SELECT` only (`400 ERR_NOT_SELECT`), empty `sql` → `200 []`, errors → `400 <code>: <message>`. Trusted network only (§10).

### 7.A.1 Static assets

| Method | Path | Description |
|---|---|---|
| `GET` / `HEAD` | `/athkar.zip` | Serves the bundled `athkar.zip` download (`Content-Type: application/zip`, `Content-Disposition: attachment`, `Cache-Control: public, max-age=86400`). Supports HTTP range requests (`206 Partial Content`) for resumable downloads. |

This route is **Node-only**: it is registered in `src/server.ts` (not `src/app.ts`) via `serveStatic` from `@hono/node-server/serve-static`, which uses `node:fs`. It is intentionally kept out of the runtime-agnostic `app.ts` so the Workers build is unaffected. The file path is `ATHKAR_ZIP_PATH` (§9), defaulting to `../../assets/athkar.zip` relative to the repo root. A missing file falls through to `404`.

### 7.C Response shape

- `Content-Type: application/json; charset=UTF-8` for JSON routes.
- Single-row endpoints return either the row object or `null` (book/word window, word-at).
- List endpoints return an array.
- `@libsql/client` returns `Row` objects whose own enumerable properties are exactly the column names, so `JSON.stringify` produces clean `{col: val, …}` objects with no numeric-index duplication.

### 7.D Errors

- Bad input (missing/invalid path or query param, unknown bookCode/qaree/edition) → `400` with `Content-Type: text/plain`.
- Known edition but the requested *resource* doesn't exist for it (e.g. `/editions/libya/page/1/farsh` — libya has no farsh table) → `404`.
- Underlying `LibsqlError` → `400` with `<code>: <message>\n`.
- Unknown content DB target → `400 ERR_UNKNOWN_TARGET`.

### 7.E CORS

Configured per environment via `CORS_ORIGINS` env var (comma-separated). Default is `*`. See §9.

### 7.5 Example clients

The `docs/api/` folder is a Bruno collection demonstrating each endpoint. The `localhost` environment sets `baseUrl = http://localhost:3000`.

---

## 8. Code architecture

Five small modules, no DI container:

- `src/content-db.ts` — the split content DBs. Exports `TARGET_RE`; `contentDbDirs(repoRoot)` (§5 step 1); `openContentDbs(dirs)` → `{ source, targets }`; `hasTarget(target)`; `getPackKeys('book' | 'word')` (keys of the `book.*` / `word.*` targets); `executeOn(target, sql, args?)` (bound query; one client per target, created on first use, `_meta.key` checked; unknown target → `ERR_UNKNOWN_TARGET`); `runTargetQuery(target, sql)` (`/db/:target`: empty → `[]`, non-`SELECT` → `ERR_NOT_SELECT`); `closeContentDbs()` for tests.

- `src/editions.ts` — edition allow-list + per-resource capability sets (`CAP_MOSSHF`, `CAP_ALL_SEARCH`, `CAP_WORDS`, `CAP_FARSH`); qaree allow-list; search-field allow-list. Exports `assertEdition(value, cap, capName)`, `assertQaree`, `assertSearchField` — each throws `HTTPException(400|404, …)`.
- `src/validators.ts` — `assertInt`, `optionalInt`, `assertFloat`, `assertBookCode`. Pure helpers throwing `HTTPException(400, …)`.
- `src/app.ts` — exports `createApp(): Hono`. Registers `cors()` (config from `CORS_ORIGINS`), `GET /db/:target` (§7.A.2) and the 14 curated routes (§7.A). Each curated handler is async and follows the same shape: parse + validate path/query params via helpers, build a parameterized SQL string with the validated edition/book interpolated, await `executeOn(target, sql, args)`, return `c.json(rows)` with `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800`.
- `src/server.ts` — the entry point. Reads `PORT`, `HOST`. Calls `openContentDbs(contentDbDirs(..))` (`process.exit(1)` without `quran`), registers the Node-only static route `GET /athkar.zip` (§7.A.1) via `serveStatic`, then `serve({ fetch: app.fetch, port, hostname })`.

There are no DTOs, pipes, guards, or interceptors. The only middleware is Hono's `cors()`.

---

## 9. Configuration

All via environment variables, read directly with `process.env`. No `.env` loader.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listen port. |
| `HOST` | `0.0.0.0` | HTTP listen address. |
| `CORS_ORIGINS` | `*` | Comma-separated origin allowlist for the `cors()` middleware. `*` keeps the wide-open behavior. |
| `ATHKAR_ZIP_PATH` | `../../assets/athkar.zip` (relative to repo root) | Filesystem path to the `athkar.zip` asset served at `GET /athkar.zip` (§7.A.1). |
| `DB_DIR` | (unset) | Folder with the split content DBs (§5 step 1); default `../wursha-data/dist/`, then `../Wursha_QuranHolder/.data-cache/current/`. |
| `LAYOUT_DB_DIR` | (unset) | Folder with the layout DBs (§5 step 1); default `../wursha-layouts/dist/`, then `../Wursha_QuranHolder/.layouts-cache/current/`. |
| `DB_URL_TEMPLATE` | (unset) | Hosted libsql: one database per target, e.g. `libsql://{target}-<org>.turso.io` (`.` in the target → `-`). Every target matching `TARGET_RE` then goes through the template; `DB_DIR` (if any) only lists the targets for the book allow-list. Check the hosting plan's database-count limit first (~70 databases). |


---

## 10. Security model

The **curated routes (§7.A) are safe to expose publicly.** Every endpoint:
- validates path/query inputs against typed ranges and allow-lists (editions, qaree, search-field, bookCode);
- interpolates only allow-listed strings into table/view names;
- binds every value as a SQL parameter (`@libsql/client` `{ sql, args }`) — no string concatenation;
- caps result sets (per-page for mosshf/composite; max 1000 for search; single-row for word lookups and book window).

**`GET /db/:target` (§7.A.2) is not safe for public exposure:** clients submit raw SQL, gated only by the `SELECT`-only check (`SELECT … RETURNING …` would pass), with no resource limits (a pathological cross join runs until it finishes), and error bodies expose SQLite internals. Every file is opened read-only through libsql, but a public deployment needs the curated routes only, or a parser/allowlist in front of `/db`.

`CORS_ORIGINS` (default `*`) should be tightened in production deployments to the known web origin of Wursha_QuranHolder.

`/db/:target` shares the process with the curated routes, so a client reaching it can exhaust the server. Restrict deployment posture accordingly.

---

## 11. Build, run, test

Node version: **22** (per `.nvmrc`). `node:sqlite` requires a Node build that ships the `sqlite` built-in (Node 22+).

Scripts (`package.json`):

| Script | Command | Purpose |
|---|---|---|
| `start` | `tsx src/server.ts` | **Run from sources directly.** No build step required — works on a fresh clone after `npm install`. Fully offline. |
| `start:dev` | `tsx watch src/server.ts` | Watch mode (auto-restart on change). |
| `prebuild` | `rimraf dist` | Clean output. |
| `build` | `tsc -p tsconfig.build.json` | Compile TS → `dist/`. |
| `start:prod` | `node dist/server.js` | Run the compiled output. |
| `format` | `prettier --write "src/**/*.ts"` | Format. |
| `lint` | `eslint "src/**/*.ts" --fix` | Lint and auto-fix. |
| `test` | `jest` | Tests (`*.spec.ts` under `src/`). |
| `test:watch` / `test:cov` | Jest variants | — |

Database files must be present in the working directory of the running process or one level up. For `npm start` from the repo root, the `*.db` files at the repo root are picked up directly.

---

## 12. Testing

One suite, `src/app.spec.ts`. Tests use Hono's built-in `app.request('/…')` which returns a standard `Response` — no HTTP loopback, no `supertest`, no separate process.

`beforeAll` calls `openContentDbs(contentDbDirs(process.cwd()), layoutDbDirs(process.cwd()))`, so tests run against the split files of a local `../wursha-data` build (or the app's fetched release) and the layout DBs of a local `../wursha-layouts` build (or the app's fetched layouts release). Add a fixture-DB path here when CI environments lack the binaries.

Coverage (36 tests): `/db/:target` (core and book SELECTs, unknown and malformed target → 400, write → 400), `/full` with and without `?books=` (nearest-row `waqf`, unknown book → 400), plus, from before: every curated route's happy path, at least one 400/404 per route, spot-checks (`/full` core texts; `search` caps at 1000; capability gaps return 404), 404s for the removed `/d`, `/f`, `/w`, `/i` and `/editions/:edition/sora`, and a CORS smoke check.

---

## 13. Operational notes and known issues

- **Old monolithic files in a folder are ignored.** `data_v*.db`, `words_v*.db` and `index_v*.db` don't match the target pattern; delete leftovers.
- **Strict TS checks disabled.** New code should not rely on this; ideally re-enable `strictNullChecks` incrementally.
- **`@libsql/client` ships native bindings.** Install pulls a prebuilt binary for the current OS/arch (macOS, Linux, Windows on x64 / arm64). No build toolchain required, but the install footprint is larger than the previous `node:sqlite` (which was built into Node).
- **Search uses simple `LIKE '%q%'` matching.** No Arabic normalization or pattern/word/root modes (yet). The audit found Wursha_QuranHolder normalizes Arabic text client-side before constructing the SQL; that normalization currently runs on the client and is preserved transparently because the curated `/search` simply substring-matches. Moving the normalization server-side is a follow-up — it lets clients pass raw query text and lets the server apply consistent rules.
- **Edition coverage is asymmetric.** `*_all`/`*_search` for `madina`/`shmrly`/`libya`/`tjwid`; `*_words` for `madina`/`shmrly`/`tjwid`; farsh tables for `madina`/`shmrly`. Other editions (warsh, qalon, hafs, …) ship as separate Cordova builds and don't currently need HTTP coverage. Requests for unsupported editions return `404`.

---

## 14. Versioning of databases

**Split content DBs:** `_v<N>` is the schema version of the file's kind (`wursha-data` `versions.json`); a content fix keeps the name and raises `_meta.rev`. The registry takes the highest `N` per target in its folder. Point `DB_DIR` at a release's files (or keep the sibling data build / the app's `.data-cache/current` up to date) to serve the same data the apps ship.

There is no in-app schema migration. The database files are produced and shipped externally.

---

## 15. Editor / tooling settings

- `.vscode/` is partially gitignored (only `settings.json`, `tasks.json`, `launch.json`, `extensions.json` are tracked).
- Prettier: `singleQuote: true`, `trailingComma: 'all'`.
- ESLint extends `plugin:@typescript-eslint/recommended` and `plugin:prettier/recommended`. `no-explicit-any`, `interface-name-prefix`, `explicit-function-return-type`, and `explicit-module-boundary-types` are all turned off.

---

## 16. Pointers for future work

The agreed direction lives in `PLAN.md`. Summary of the next likely changes:

1. **Phase 1 (lockdown):** replace the remaining three raw-SQL routes with a typed REST surface (`/sura/:n`, `/aya/:idx`, `/page/:mushaf/:n`, …) and tighten CORS / add row caps. Necessary before any public exposure.
2. **Phase 2 (Workers + Turso):** add a Cloudflare Workers entry that re-exports the same `app: Hono` and swap `node:sqlite` for `@libsql/client`. Keep the Node entry for `npm start` offline dev.
3. **Phase 3:** custom domain on Cloudflare + Workers Analytics.

Constraints to preserve through every step:
- `npm start` must continue to run the service locally and offline with no cloud account, no internet, no Docker.
- The Hono `app` instance stays runtime-agnostic; per-runtime entries (`server.ts` for Node, future `worker.ts` for Workers) are thin adapters around it.
