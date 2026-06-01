# Quran API — Specification

This document is the single source of truth for the design, behavior, and operation of the `quran-api` service. It describes what the project is, what it exposes, how it is structured, and the constraints under which it must operate.

---

## 1. Purpose

`quran-api` is a small HTTP service that exposes the contents of several pre-built SQLite databases of Quran-related data (text, mushaf layout, words, translations, tafsir, qira'at, etc.) to client applications.

The service exposes a **curated, typed REST surface** (~15 endpoints, §7) over the bundled databases. All endpoint inputs are validated and bound as SQL parameters; no client-supplied SQL is executed.

For backwards compatibility during the client migration to the curated surface, the service also keeps four **legacy raw-SQL pass-through routes** (`/i`, `/d`, `/f`, `/w`) that accept a `?sql=` query string and execute `SELECT` statements against the chosen DB. These will be removed once Wursha_QuranHolder's web build is migrated (Phase 1.10 in `PLAN.md`).

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

The curated routes are safe for **public deployment** (typed/bound inputs, capped result sizes, no client SQL). The legacy raw-SQL routes remain trusted-network only until they are removed.

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
│   ├── app.ts                   # Hono app: all routes (curated + legacy)
│   ├── db.ts                    # libsql clients, parameterized execute(), book-code discovery
│   ├── editions.ts              # Edition allow-lists and per-resource capability checks
│   ├── validators.ts            # assertInt / assertFloat / assertBookCode / optionalInt
│   └── app.spec.ts              # Jest tests using `app.request()`
├── docs/api/                    # Bruno HTTP collection
│   ├── bruno.json
│   ├── hello.bru                # legacy /
│   ├── index.bru                # legacy /i?sql=
│   ├── data.bru                 # legacy /d?sql=
│   ├── farsh.bru                # legacy /f?sql=
│   ├── curated/                 # curated REST examples
│   │   ├── sora.bru
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

1. Calls `openDatabases([__dirname, join(__dirname, '..')])` from `src/db.ts`. This walks the search directories in order and, on the first directory containing any `*.db` files, picks one file per role by **filename prefix**:
   - `index*` → role `'index'`
   - `data*`  → role `'data'`
   - `farsh*` → role `'farsh'`
   - `words*` → role `'words'`
   For each matched file, opens a single `@libsql/client` `Client` via `createClient({ url: 'file:' + path })` and stores it in module scope. The client is reused for the lifetime of the process — there is **no per-request open/close**.
2. Logs the resolved file paths.
3. Validates required databases:
   - Missing `data` → log error and `process.exit(1)`.
   - Missing `index` → log error and `process.exit(1)`.
   - Missing `farsh` → log a warning and continue.
   - Missing `words` → silently allowed (route will throw `ERR_DB_UNAVAILABLE` at query time).
4. Builds the Hono app via `createApp()` from `src/app.ts`.
5. Starts the Node HTTP server via `serve({ fetch: app.fetch, port, hostname })` from `@hono/node-server`. Port is `process.env.PORT` (default `3000`); hostname is `process.env.HOST` (default `0.0.0.0`).

Implications:
- If two files match the same prefix (e.g. `data_v20.db` and `data_v21.db`), the result is whichever `Array#find` returns first — **non-deterministic without ordering**. Operationally, ship exactly one file per role.
- Boot failure is now a real `process.exit(1)` (improvement over the previous silent NestJS abort), so process supervisors detect it correctly.
- DB handles are never closed during normal operation. `closeDatabases()` is exported from `db.ts` for tests/teardown.

---

## 6. Database files

The service expects up to four SQLite database files. Filenames carry version suffixes (e.g. `data_v21.db`); only the prefix matters to the loader.

### 6.1 `index_v11.db` (role: `DB_INDEX`)
General Quran indexing data. Tables present:

- `quran_sora` — sura metadata: `sora_number, sora_name, sora_name_tshkeel, sora_type, ayat_number`
- `quran_part` — juz' metadata: `part_number, part_name, start_aya`
- `quran_quarter` — hizb-quarter metadata: `quarter_number, quarter_name, start_aya, sora_number, aya_number, hizb_number, part_number`
- Per-mushaf page/sura/part/quarter cross-reference tables for the **Madina**, **Libya**, and **Shmrly** mushafs:
  - `mosshf_madina_pages`, `mosshf_madina_sora`, `mosshf_madina_part`, `mosshf_madina_quarter`
  - `mosshf_libya_pages`, `mosshf_libya_part`, `mosshf_libya_quarter`, `mosshf_libya_sora`
  - `mosshf_shmrly_pages`, `mosshf_shmrly_part`, `mosshf_shmrly_quarter`, `mosshf_shmrly_sora`

### 6.2 `data_v21.db` (role: `DB_DATA`)
Bulk content. ~65 tables, including but not limited to:

- `book_quran` (`aya_index, text, text_full, roots`) — 6,236 ayat (canonical count).
- `book_quranu` — uthmani text.
- Translations: `book_english`, `book_french`, `book_russian`, `book_indonesian`, `book_malay`, `book_turkish`, `book_urdu`, `book_farsi`, `book_pickthall`, `book_sahihint`, `book_dutch`, `book_azerbaijani`, …
- Tafsir / commentary: `book_jlalin`, `book_katheer`, `book_qortoby`, `book_baghawy`, `book_tabary`, `book_sa3dy`, `book_moyassar`, `book_mokhtsr`, `book_zadmaseer`, `book_ibnatiyah`, `book_juzay`, `book_waseet`, `book_tanweer`, …
- Qira'at-related: `book_qhamza`, `book_qibnkather`, `book_qqalon`, `book_qwarsh`, `book_kisai`, `book_khalaf`, `book_kisaikhalaf`, `book_yaqob`, `book_aljadwal`, `book_all10`, `book_tayseer10`, `book_sho3ba`, `book_aboamro`, `book_abujafar`, …
- Linguistic: `book_e3rab` (i'rab), `book_m3any` (meanings), `book_phonetic`, `book_waqf` (stop signs), `book_motshabeh7`, `book_shawahid`, `book_mgharieb`, `book_ashabsela`, `book_sama`, `book_nozol`, `book_twsot`, `book_ibnamer`, `book_alnashir`, `book_basryan`, `book_ayaroots`, `ayaroots`.
- Mushaf glyph layout: `mosshf_hafs`, `mosshf_libya`, `mosshf_madina`, `mosshf_shmrly`, `mosshf_tjwid`, plus `LibyaPages`.

Common shape for `book_*` tables: `(aya_index INTEGER PRIMARY KEY, text TEXT, ...)` keyed by a 1..6236 ayat index.

Common shape for `mosshf_*` tables: `(aya_index, page_number, sora_number, aya_number, x_ratio, y_ratio, x_prev_ratio, y_prev_ratio)` — coordinates for rendering an aya marker on a mushaf page.

### 6.3 `farsh_v12.db` (role: `DB_FARSH`)
Per-glyph rendering data ("farsh" = laid-out page elements) for two mushafs:

- `madina` — 82,067 rows
- `shmrly` — 139,229 rows

Each row: `qaree, page_number, color, x, y, width, style, circle`. Used to render colorized tajweed overlays.

### 6.4 `words_v2.db` (role: `DB_WORDS`)
Per-word data with one row per Quranic word (~83,927 rows). Table `wordsall`:

`wordindex, surah, ayah, wordsno, page_number2, word, rawword, aya_index, page_number1, x, y, width, root, x1, y1, width1, meaning, sarf, irab, qeraat, qeraatN, trns, x2, y2, width2`

Indexed by `wordindex`. `words_v1.db` is a legacy version still bundled but superseded by `_v2`.

---

## 7. HTTP API

Base URL (default): `http://localhost:3000`

All endpoints accept a single query parameter `sql`. The value is forwarded verbatim to `db.prepare(sql)`.

### 7.A Curated REST surface (15 routes)

All curated GET responses set `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800` so a future edge cache absorbs most traffic. All inputs are validated and bound as SQL parameters; table/view names are only ever interpolated *after* the corresponding allow-list check.

**Health**

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Returns the literal string `Hello World!` (`Content-Type: text/plain`). |

**Index resources** (editions: `madina`, `shmrly`, `libya`)

| Method | Path | Returns |
|---|---|---|
| `GET` | `/editions/:edition/sora` | 114 rows from view `${edition}_sora` |
| `GET` | `/editions/:edition/part` | 30 rows from view `${edition}_part` |
| `GET` | `/editions/:edition/quarter` | 240 rows from view `${edition}_quarter` |
| `GET` | `/editions/:edition/pages` | 604 rows from table `mosshf_${edition}_pages` |

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
| `GET` | `/editions/:edition/aya/:idx/full` | One row from view `${edition}_all` (~67 columns: mosshf + every tafsir/translation/qira'at) |
| `GET` | `/editions/:edition/page/:n/full` | All ayat on a page, full rows |

**Search** (editions: `madina`, `shmrly`, `libya`, `tjwid`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/editions/:edition/search` | Query string: `q` (required), `field` ∈ `text\|text_uthamni\|text_full\|roots` (default `text`), `sora` (optional, 1..114), `limit` (default 100, max 1000). Returns rows from view `${edition}_search` matching `<field> LIKE '%q%'`. |
| `GET` | `/editions/:edition/search/count` | Same inputs except `limit`. Returns `{count: N}`. |

**Book window** (any allow-listed `bookCode`; allow-list built at boot from `book_*` tables)

| Method | Path | Returns |
|---|---|---|
| `GET` | `/book/:bookCode/aya/:idx/nearest` | `{text: …}` — the nearest book entry where `aya_index <= idx`. `null` if none. |

**Farsh** (editions: `madina`, `shmrly`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/editions/:edition/page/:n/farsh` | Query string: `qaree` ∈ `{A..Z}` (allow-listed), `waqf` ∈ `true\|false` (default `false`). Returns rows from physical table `madina`/`shmrly`. |

**Words** (editions: `madina`, `shmrly`, `tjwid`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/editions/:edition/page/:n/word/at` | Query string: `x`, `y` (floats 0..1). Returns the first word whose box contains `(x, y)`. |
| `GET` | `/editions/:edition/word/:wordindex` | All instances of a word. |
| `GET` | `/editions/:edition/word/:wordindex/aya-first` | `{wordindex}` of the first word in the same aya. With `?before=true`, the first word *before* `:wordindex` in that aya. |

### 7.A.1 Static assets

| Method | Path | Description |
|---|---|---|
| `GET` / `HEAD` | `/athkar.zip` | Serves the bundled `athkar.zip` download (`Content-Type: application/zip`, `Content-Disposition: attachment`, `Cache-Control: public, max-age=86400`). Supports HTTP range requests (`206 Partial Content`) for resumable downloads. |

This route is **Node-only**: it is registered in `src/server.ts` (not `src/app.ts`) via `serveStatic` from `@hono/node-server/serve-static`, which uses `node:fs`. It is intentionally kept out of the runtime-agnostic `app.ts` so the Workers build is unaffected. The file path is `ATHKAR_ZIP_PATH` (§9), defaulting to `../../assets/athkar.zip` relative to the repo root. A missing file falls through to `404`.

### 7.B Legacy raw-SQL routes (deprecated, to be removed in Phase 1.10)

These remain live while Wursha_QuranHolder is migrated to the curated surface:

| Method | Path | Role |
|---|---|---|
| `GET` | `/i?sql=…` | `index` |
| `GET` | `/d?sql=…` | `data` |
| `GET` | `/f?sql=…` | `farsh` |
| `GET` | `/w?sql=…` | `words` |

- Only `SELECT` statements are accepted (app-layer gate); anything else → `400 ERR_NOT_SELECT`.
- Empty `sql` → `200 []`.
- Errors are wrapped as `400 <code>: <message>\n`.

### 7.C Response shape

- `Content-Type: application/json; charset=UTF-8` for JSON routes.
- Single-row endpoints return either the row object or `null` (book/word window, word-at).
- List endpoints return an array.
- `@libsql/client` returns `Row` objects whose own enumerable properties are exactly the column names, so `JSON.stringify` produces clean `{col: val, …}` objects with no numeric-index duplication.

### 7.D Errors

- Bad input (missing/invalid path or query param, unknown bookCode/qaree/edition) → `400` with `Content-Type: text/plain`.
- Known edition but the requested *resource* doesn't exist for it (e.g. `/editions/tjwid/sora` — tjwid has no sora view) → `404`.
- Underlying `LibsqlError` → `400` with `<code>: <message>\n`.
- DB role missing at boot → `400 ERR_DB_UNAVAILABLE` if any endpoint touches that role.

### 7.E CORS

Configured per environment via `CORS_ORIGINS` env var (comma-separated). Default is `*`. See §9.

### 7.5 Example clients

The `docs/api/` folder is a Bruno collection demonstrating each endpoint. The `localhost` environment sets `baseUrl = http://localhost:3000`.

---

## 8. Code architecture

Five small modules, no DI container:

- `src/db.ts` — owns the four `@libsql/client` `Client` instances in module scope. Exports:
  - `ROLES` / `Role` — the four role names (`'index' | 'data' | 'farsh' | 'words'`).
  - `openDatabases(searchDirs)` — **async**. For each role: uses `DB_${ROLE}_URL` env var if set, otherwise discovers `*.db` files by prefix and opens with `file:` URL. After opening the data client, populates the `bookCodes` set by querying `sqlite_master` for `book_*` tables.
  - `getDb(role)` — raw `Client` accessor.
  - `getBookCodes()` — the allow-list of bookCodes discovered at boot.
  - `execute(role, sql, args?)` — parameter-bound query for curated routes; throws `ERR_DB_UNAVAILABLE` if the role isn't loaded.
  - `runQuery(role, sql)` — legacy raw-SQL helper. Returns `[]` for empty SQL; throws `ERR_NOT_SELECT` if SQL doesn't start with `select`; otherwise delegates to `execute(role, sql)`.
  - `closeDatabases()` — for tests/teardown only.
- `src/editions.ts` — edition allow-list + per-resource capability sets (`CAP_INDEX`, `CAP_PAGES`, `CAP_MOSSHF`, `CAP_ALL_SEARCH`, `CAP_WORDS`, `CAP_FARSH`); qaree allow-list; search-field allow-list. Exports `assertEdition(value, cap, capName)`, `assertQaree`, `assertSearchField` — each throws `HTTPException(400|404, …)`.
- `src/validators.ts` — `assertInt`, `optionalInt`, `assertFloat`, `assertBookCode`. Pure helpers throwing `HTTPException(400, …)`.
- `src/app.ts` — exports `createApp(): Hono`. Registers `cors()` (config from `CORS_ORIGINS`), the 4 legacy routes, and the 15 curated routes (§7.A). Each curated handler is async and follows the same shape: parse + validate path/query params via helpers, build a parameterized SQL string with the validated edition/book interpolated, await `execute(role, sql, args)`, return `c.json(rows)` with `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800`.
- `src/server.ts` — the entry point. Reads `PORT`, `HOST`. Awaits `openDatabases([__dirname, ../])`, validates required roles (`process.exit(1)` if `data` or `index` missing), registers the Node-only static route `GET /athkar.zip` (§7.A.1) via `serveStatic`, then `serve({ fetch: app.fetch, port, hostname })`.

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
| `DB_INDEX_URL` | (filesystem discovery) | Override the libsql URL for the index DB. Accepts any libsql URL: `file:/path/to/index.db`, `libsql://…turso.io`, `http://127.0.0.1:8080`. |
| `DB_DATA_URL` | (filesystem discovery) | Same, for the data DB. |
| `DB_FARSH_URL` | (filesystem discovery) | Same, for the farsh DB. |
| `DB_WORDS_URL` | (filesystem discovery) | Same, for the words DB. |

If any `DB_*_URL` is unset, `openDatabases` falls back to filesystem discovery (look for `*.db` files starting with the role prefix in `__dirname` then `__dirname/..`).

---

## 10. Security model

The **curated routes (§7.A) are safe to expose publicly.** Every endpoint:
- validates path/query inputs against typed ranges and allow-lists (editions, qaree, search-field, bookCode);
- interpolates only allow-listed strings into table/view names;
- binds every value as a SQL parameter (`@libsql/client` `{ sql, args }`) — no string concatenation;
- caps result sets (114/30/240/604 for index resources; per-page for mosshf/composite; max 1000 for search; single-row for word lookups and book window).

The **legacy raw-SQL routes (§7.B) are not safe for public exposure** and will be removed in Phase 1.10:

1. Clients submit raw SQL — no allowlist or parser beyond the `SELECT`-only gate.
2. `runQuery` rejects non-`SELECT` SQL with `400 ERR_NOT_SELECT`. The SQL is not further parsed — `SELECT … RETURNING …` would still pass.
3. No resource limits — a pathological cross join consumes CPU/memory until the request finishes.
4. Error bodies expose SQLite internals (`<code>: <message>`).

`CORS_ORIGINS` (default `*`) should be tightened in production deployments to the known web origin of Wursha_QuranHolder.

The legacy routes share the process with the curated routes, so attackers reaching them can still exhaust the server. Restrict deployment posture accordingly until Phase 1.10 ships.

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

`beforeAll` calls `await openDatabases([process.cwd()])`, so tests run against the bundled `.db` files in the repo root. Add a fixture-DB path here when CI environments lack the binaries.

Coverage at Phase 1 completion (31 tests): every curated route's happy path, at least one 400/404 per route, byte-shape spot-checks (`madina_all` returns ≥20 columns; `search` caps at 1000; capability gaps return 404), the two surviving legacy raw-SQL behaviors (empty SQL → `[]`, write rejected → 400), and a CORS smoke check.

---

## 13. Operational notes and known issues

- **Filename-prefix dispatch is ambiguous.** Shipping more than one `data*.db` (or `index*`, `farsh*`, `words*`) leads to nondeterministic selection. Treat the prefix as an exclusive role, not a glob. The `DB_${ROLE}_URL` env vars (§9) are the deterministic alternative.
- **Strict TS checks disabled.** New code should not rely on this; ideally re-enable `strictNullChecks` incrementally.
- **`@libsql/client` ships native bindings.** Install pulls a prebuilt binary for the current OS/arch (macOS, Linux, Windows on x64 / arm64). No build toolchain required, but the install footprint is larger than the previous `node:sqlite` (which was built into Node).
- **Search uses simple `LIKE '%q%'` matching.** No Arabic normalization or pattern/word/root modes (yet). The audit found Wursha_QuranHolder normalizes Arabic text client-side before constructing the SQL; that normalization currently runs on the client and is preserved transparently because the curated `/search` simply substring-matches. Moving the normalization server-side is a follow-up — it lets clients pass raw query text and lets the server apply consistent rules.
- **Edition coverage is asymmetric.** Index views exist for `madina`/`shmrly`/`libya`; `*_all`/`*_search` for `madina`/`shmrly`/`libya`/`tjwid`; `*_words` for `madina`/`shmrly`/`tjwid`; farsh tables for `madina`/`shmrly`. Other editions (warsh, qalon, hafs, …) ship as separate Cordova builds and don't currently need HTTP coverage. Requests for unsupported editions return `404`.
- **Legacy raw-SQL routes still live** (§7.B) until Wursha_QuranHolder's web build is migrated and Phase 1.10 of `PLAN.md` ships.

---

## 14. Versioning of databases

DB files use a `_vNN` suffix encoding their schema/content version (e.g. `data_v21.db`, `farsh_v12.db`, `index_v11.db`, `words_v2.db`). When a DB file is regenerated with a schema change, the suffix bumps and the prefix-based loader picks up the newer file as long as the older one is removed from the directory.

There is no in-app schema migration. The database files are produced and shipped externally.

---

## 15. Editor / tooling settings

- `.vscode/` is partially gitignored (only `settings.json`, `tasks.json`, `launch.json`, `extensions.json` are tracked).
- Prettier: `singleQuote: true`, `trailingComma: 'all'`.
- ESLint extends `plugin:@typescript-eslint/recommended` and `plugin:prettier/recommended`. `no-explicit-any`, `interface-name-prefix`, `explicit-function-return-type`, and `explicit-module-boundary-types` are all turned off.

---

## 16. Pointers for future work

The agreed direction lives in `PLAN.md`. Summary of the next likely changes:

1. **Phase 1 (lockdown):** replace the four raw-SQL routes with a typed REST surface (`/sura/:n`, `/aya/:idx`, `/page/:mushaf/:n`, …) and tighten CORS / add row caps. Necessary before any public exposure.
2. **Phase 2 (Workers + Turso):** add a Cloudflare Workers entry that re-exports the same `app: Hono` and swap `node:sqlite` for `@libsql/client`. Keep the Node entry for `npm start` offline dev.
3. **Phase 3:** custom domain on Cloudflare + Workers Analytics.

Constraints to preserve through every step:
- `npm start` must continue to run the service locally and offline with no cloud account, no internet, no Docker.
- The Hono `app` instance stays runtime-agnostic; per-runtime entries (`server.ts` for Node, future `worker.ts` for Workers) are thin adapters around it.
