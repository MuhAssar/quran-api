# Quran API — Specification

This document is the single source of truth for the design, behavior, and operation of the `quran-api` service. It describes what the project is, what it exposes, how it is structured, and the constraints under which it must operate.

---

## 1. Purpose

`quran-api` is a small HTTP service that exposes the contents of several pre-built SQLite databases of Quran-related data (text, mushaf layout, words, translations, tafsir, qira'at, etc.) to client applications.

It is intentionally a **thin pass-through layer**: clients submit raw SQL `SELECT` queries via query string, the service runs them against a chosen database file in read-only mode, and returns the rows as JSON.

The service does **not** model any domain in code. All schema knowledge lives in the SQLite databases and in the clients that consume them.

---

## 2. Scope and non-goals

In scope:
- Read-only access to bundled SQLite databases over HTTP.
- Arbitrary `SELECT` SQL execution by the client.
- CORS-open responses for browser clients.

Out of scope (intentionally):
- Authentication, authorization, rate limiting, quotas.
- A typed REST/GraphQL surface; clients write their own SQL.
- ORM models, migrations, or schema validation in the application code.
- Write traffic from clients (the service opens databases read-only).
- Multi-tenancy, user accounts, or per-request configuration.

Because clients send raw SQL, this service is intended for **trusted-network deployment** (local app, embedded use, or a private network). It must not be exposed to the public internet without an additional layer in front of it.

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
│   ├── app.ts                   # Hono app: routes + handlers
│   ├── db.ts                    # DB discovery, persistent handles, query execution
│   └── app.spec.ts              # Jest tests using `app.request()`
├── docs/api/                    # Bruno HTTP collection (request examples)
│   ├── bruno.json
│   ├── hello.bru
│   ├── index.bru
│   ├── data.bru
│   ├── farsh.bru
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

| Method | Path | Role | Description |
|---|---|---|---|
| `GET` | `/`   | —          | Health/hello. Returns the literal string `Hello World!` (`Content-Type: text/plain`). |
| `GET` | `/i?sql=…` | `index` | Query the index database. |
| `GET` | `/d?sql=…` | `data`  | Query the data database. |
| `GET` | `/f?sql=…` | `farsh` | Query the farsh database. |
| `GET` | `/w?sql=…` | `words` | Query the words database. |

### 7.1 Request

- Single query parameter `sql`, URL-encoded.
- Whitespace at the start of the SQL is tolerated; `.trim().toLowerCase().startsWith('select')` is the gate.
- **Only `SELECT` statements are accepted.** Anything else returns 400 with `ERR_NOT_SELECT: only SELECT statements are allowed`. This is the application-layer write protection (see §10).
- If `sql` is empty/missing, the response is `[]` (HTTP 200) without touching the database.

### 7.2 Response

- `Content-Type: application/json; charset=UTF-8` for SQL routes (`c.json(rows)`).
- Body: a JSON array of row objects keyed by column name. `@libsql/client` returns `Row` objects whose own enumerable properties are exactly the column names, so `JSON.stringify` produces clean `{col: val, …}` objects with no numeric-index duplication.

### 7.3 Errors

- Any thrown `LibsqlError` (parse error, runtime error) is caught and re-thrown as a Hono `HTTPException(400, …)` with body `${err.code}: ${err.message}\n` and `Content-Type: text/plain`. HTTP status is `400`.
- Non-`SELECT` SQL → `400 ERR_NOT_SELECT`.
- A request to a route whose DB file was not discovered → `400 ERR_DB_UNAVAILABLE: database for role "<role>" is not loaded`.

### 7.4 CORS

`Access-Control-Allow-Origin: *` is set globally via `cors({ origin: '*' })` in `src/app.ts`. No preflight customization.

### 7.5 Example clients

The `docs/api/` folder is a Bruno collection demonstrating each endpoint. The `localhost` environment sets `baseUrl = http://localhost:3000`.

---

## 8. Code architecture

Three small modules, no DI container:

- `src/db.ts` — owns the four `@libsql/client` `Client` instances in module scope. Exports:
  - `ROLES` / `Role` — the four role names (`'index' | 'data' | 'farsh' | 'words'`).
  - `openDatabases(searchDirs)` — discovers `*.db` files by prefix and opens one libsql `Client` per role via `createClient({ url: 'file:' + path })`; returns the resolved file paths for logging. Idempotent: a role already opened is not reopened.
  - `getDb(role)` — accessor for callers that want the raw `Client`.
  - `runQuery(role, sql): Promise<unknown[]>` — async. Returns `[]` for empty SQL; throws `ERR_NOT_SELECT` if SQL doesn't start with `select`; otherwise calls `client.execute(sql)` and returns `result.rows`.
  - `closeDatabases()` — for tests/teardown only.
- `src/app.ts` — exports `createApp(): Hono`. Registers global CORS (`*`), the `GET /` hello, and the four `GET /{i,d,f,w}` SQL routes. Each SQL route is async, reads `?sql=`, awaits `runQuery(role, sql)`, and converts thrown errors into `HTTPException(400, …)` with the `code: message\n` body.
- `src/server.ts` — the entry point. Calls `openDatabases`, validates required roles (exits non-zero if `data` or `index` missing), then `serve({ fetch: app.fetch, port, hostname })`.

There are no DTOs, pipes, guards, or interceptors. The only middleware is Hono's `cors()`.

---

## 9. Configuration

- **Port**: `process.env.PORT` (default `3000`). Read in `src/server.ts`.
- **Hostname**: `process.env.HOST` (default `0.0.0.0`).
- **CORS**: hard-coded `*` in `src/app.ts`.
- **DB locations**: discovered from `__dirname` (and parent) at boot. There is no environment variable yet for explicit paths.
- There is no `.env` file and no config-loader library — direct `process.env` reads only.

Phase 1 of `PLAN.md` will add explicit `DB_*_PATH` env vars and a CORS allowlist.

---

## 10. Security model

This service is **dangerous to expose publicly as-is**. The design assumptions:

1. **Trusted clients only.** Clients submit raw SQL. There is no allowlist, parser, or sanitizer beyond the `SELECT`-only gate.
2. **Application-layer write protection.** `runQuery` rejects any SQL that does not start with `select` (case-insensitive, after `trim()`) with `400 ERR_NOT_SELECT`. This replaces the previous SQLite-driver-level read-only handle, because `@libsql/client` does not expose a `readOnly` flag for `file:` URLs (`?mode=ro` returns `URL_PARAM_NOT_SUPPORTED`). The SQL is *not* further parsed — `SELECT … RETURNING …` would still pass the gate, so don't rely on it as a sandbox.
3. **No resource limits.** A pathological query (e.g. cross join of `wordsall` × `book_*`) will consume CPU and memory until the request finishes or the process is killed. There is no statement timeout, no `LIMIT` injection, no row cap.
4. **Async DB I/O does not stall the event loop** the way the previous `node:sqlite` `DatabaseSync` did, but a single expensive query still ties up CPU for its duration.
5. **Error messages leak SQL/SQLite internals** in the 400 body (`code: message`). Acceptable for trusted clients; not acceptable for public exposure.
6. **CORS is fully open.** Intentional for browser-side use.

If/when this service is moved behind a public boundary, the gating layer must impose: query parsing/allowlisting, statement timeouts, row caps, rate limiting, and tightened CORS. See `PLAN.md` for the agreed migration toward typed routes + edge hosting.

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

Current coverage:
- `GET /` returns `Hello World!`.
- `GET /i` with no `sql` returns `[]`.

Tests do not currently exercise the SQL path. New tests that hit `runQuery` should either:
- Provide a small fixture `.db` placed where `openDatabases()` will discover it, or
- Refactor `db.ts` to accept an injectable handle (e.g. seed an in-memory `DatabaseSync(':memory:', { readOnly: false })` for the test process).

---

## 13. Operational notes and known issues

- **Filename-prefix dispatch is ambiguous.** Shipping more than one `data*.db` (or `index*`, `farsh*`, `words*`) leads to nondeterministic selection. Treat the prefix as an exclusive role, not a glob.
- **Strict TS checks disabled.** New code should not rely on this; ideally re-enable `strictNullChecks` incrementally.
- **`@libsql/client` ships native bindings.** Install pulls a prebuilt binary for the current OS/arch (macOS, Linux, Windows on x64 / arm64). No build toolchain required, but the install footprint is larger than the previous `node:sqlite` (which was built into Node).
- **No driver-level read-only mode for `file:` URLs.** Write protection is enforced at the application layer (§10). If that gate is ever bypassed, writes will succeed against the local files.

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
