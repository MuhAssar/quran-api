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
| Language | TypeScript (target `es2017`, `commonjs` modules) | `tsconfig.json` |
| Runtime | Node.js 22 (`.nvmrc`) | Required for `node:sqlite` built-in module |
| Framework | NestJS 11 (`@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`) | Express HTTP adapter |
| Database driver | `node:sqlite` (`DatabaseSync`) — Node.js built-in | No native deps; no `better-sqlite3`/`sqlite3` package |
| Lint / format | ESLint 8 + `@typescript-eslint` + Prettier (`singleQuote: true`, `trailingComma: 'all'`) | `.eslintrc.js`, `.prettierrc` |
| Tests | Jest 28 + `ts-jest`; e2e via `supertest` | Configured in `package.json` and `test/jest-e2e.json` |
| Build tool | NestJS CLI (`nest build`) | `nest-cli.json`, `tsconfig.build.json` |

`@nestjs/swc` is intentionally **not** used — it caused issues with `node:sqlite` (commit `bf64087`).

`strictNullChecks`, `noImplicitAny`, and `strictBindCallApply` are disabled in `tsconfig.json`. Future code should not rely on the absence of these checks.

---

## 4. Repository layout

```
quran-api/
├── src/
│   ├── main.ts                  # Bootstrap, DB discovery, settings population
│   ├── settings.ts              # Mutable singleton holding resolved DB filenames
│   ├── app.module.ts            # Root NestJS module
│   ├── app.controller.ts        # HTTP routes
│   ├── app.controller.spec.ts   # Unit test for controller
│   └── app.service.ts           # SQLite query execution
├── test/
│   ├── app.e2e-spec.ts          # End-to-end test against the running app
│   └── jest-e2e.json            # E2E Jest config
├── docs/api/                    # Bruno HTTP collection (request examples)
│   ├── bruno.json
│   ├── hello.bru
│   ├── index.bru
│   ├── data.bru
│   ├── farsh.bru
│   └── environments/localhost.bru
├── *.db                          # SQLite database files (see §6). Gitignored.
├── nest-cli.json
├── tsconfig.json
├── tsconfig.build.json
├── .eslintrc.js
├── .prettierrc
├── .nvmrc                        # Node 22
└── package.json
```

`*.db`, `*.db-shm`, and `*.db-wal` are gitignored. Database files are distributed and versioned out-of-band; the application discovers whatever is present at runtime.

---

## 5. Bootstrap and database discovery

`src/main.ts` performs the following on startup:

1. Creates the Nest application from `AppModule`.
2. Enables permissive CORS: `origin: '*'`.
3. Reads the directory of the running script (`__dirname`) for `*.db` files. If none are found, retries one level up (`..`). This supports both `dist/` (production) and `src/` (dev) layouts when the DB files sit alongside or one level above the compiled code.
4. Picks one file per role by **filename prefix**:
   - `index*` → `settings.DB_INDEX`
   - `data*`  → `settings.DB_DATA`
   - `farsh*` → `settings.DB_FARSH`
   - `words*` → `settings.DB_WORDS`
5. Logs the resolved `settings` object.
6. Validates required databases:
   - Missing `DB_DATA` → log error and **abort startup** (process stays up but no listener).
   - Missing `DB_INDEX` → log error and **abort startup**.
   - Missing `DB_FARSH` → log a warning and continue.
   - Missing `DB_WORDS` → silently allowed (route will fail at query time).
7. Listens on port `3000` (hard-coded).

Implications:
- If two files match the same prefix (e.g. `data_v20.db` and `data_v21.db`), the result is whichever `Array#find` returns first — **non-deterministic without ordering**. Operationally, ship exactly one file per role.
- Port and CORS policy are hard-coded; changing them requires editing `main.ts`.

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

| Method | Path | Database | Description |
|---|---|---|---|
| `GET` | `/`   | —          | Health/hello. Returns the literal string `Hello World!`. |
| `GET` | `/i?sql=…` | `DB_INDEX` | Query the index database. |
| `GET` | `/d?sql=…` | `DB_DATA`  | Query the data database. |
| `GET` | `/f?sql=…` | `DB_FARSH` | Query the farsh database. |
| `GET` | `/w?sql=…` | `DB_WORDS` | Query the words database. |

### 7.1 Request

- Single query parameter `sql`, URL-encoded.
- Whitespace at the start of the SQL is tolerated (`.trim().toLowerCase().startsWith('select')`).
- If `sql` is empty/missing, the response is `[]` (HTTP 200) with no DB connection opened.

### 7.2 Response

- `Content-Type: application/json` (Nest default for non-string return values).
- Body: a JSON array of row objects keyed by column name (whatever `node:sqlite`'s `stmt.all()` returns).
- For non-`SELECT` SQL, the statement is `.run()` and the response is `[]`. (See §10 — this is gated by the read-only connection at the SQLite layer regardless.)

### 7.3 Errors

- Any thrown `SqliteError` (open error, prepare error, run error) is caught and re-thrown as Nest's `BadRequestException` with body containing `${err.code}: ${err.message}\n`. HTTP status is `400`.
- The DB handle is closed in both success and failure paths inside `getFromDB`.
- A request to a route whose database file was not discovered will hit `new DatabaseSync('', {readOnly:true})` and fail with a SQLite open error → 400.

### 7.4 CORS

`Access-Control-Allow-Origin: *` is set globally in `main.ts`. There is no preflight customization.

### 7.5 Example clients

The `docs/api/` folder is a Bruno collection demonstrating each endpoint. The `localhost` environment sets `baseUrl = http://localhost:3000`.

---

## 8. Code architecture

NestJS module graph is intentionally minimal:

- `AppModule` (`src/app.module.ts`) — registers `AppController` and `AppService`. No imports.
- `AppController` (`src/app.controller.ts`) — five routes (§7), each delegating to `AppService.getFromDB` with the corresponding `settings.DB_*` filename.
- `AppService` (`src/app.service.ts`) — single method `getFromDB(sql, dbFile)`:
  1. Returns `[]` for empty `sql`.
  2. Opens the file via `new DatabaseSync(dbFile, { readOnly: true })`. **A new connection is opened and closed per request.**
  3. Has dead code for `PRAGMA journal_mode = WAL` gated behind `if (!readOnly)` where `readOnly` is a hard-coded `true` — never executes.
  4. Decides between `stmt.all()` (for `SELECT`) and `stmt.run()` (otherwise) by string-prefix check.
  5. Closes the DB and returns rows.
- `settings` (`src/settings.ts`) — a single mutable object holding resolved DB filenames. Populated once at boot in `main.ts`.

There are no DTOs, pipes, guards, interceptors, filters, or middleware beyond Nest defaults.

---

## 9. Configuration

- **Port**: hard-coded `3000` in `main.ts`.
- **CORS**: hard-coded `*` in `main.ts`.
- **DB locations**: discovered from `__dirname` (and parent) at boot. There is no environment variable.
- There is no `.env` file and no `@nestjs/config` integration.

Future change to introduce env-based config should also externalize the port and DB directory.

---

## 10. Security model

This service is **dangerous to expose publicly as-is**. The design assumptions:

1. **Trusted clients only.** Clients submit raw SQL. There is no allowlist, parser, or sanitizer.
2. **Read-only at the SQLite layer.** `DatabaseSync(..., { readOnly: true })` prevents writes; an attempt to open a database in read-only mode also fails if the file does not exist (no accidental DB creation). Non-`SELECT` statements that pass the controller path into `stmt.run()` will fail at the SQLite layer.
3. **No resource limits.** A pathological query (e.g. cross join of `wordsall` × `book_*`) will consume CPU and memory until the request finishes or the process is killed. There is no statement timeout, no `LIMIT` injection, no row cap.
4. **Error messages leak SQL/SQLite internals** in the 400 body (`code: message`). Acceptable for trusted clients; not acceptable for public exposure.
5. **CORS is fully open.** Combined with read-only DBs this is intentional for browser-side use.

If/when this service is moved behind a public boundary, the gating layer must impose: query parsing/allowlisting, statement timeouts, row caps, rate limiting, and tightened CORS.

---

## 11. Build, run, test

Node version: **22** (per `.nvmrc`). `node:sqlite` requires a Node build that ships the `sqlite` built-in (Node 22+).

Scripts (`package.json`):

| Script | Command | Purpose |
|---|---|---|
| `start` | `nest start` | Run from sources via ts-node. |
| `start:dev` | `nest start --watch` | Watch mode. |
| `start:debug` | `nest start --debug --watch` | Watch + inspector. |
| `prebuild` | `rimraf dist` | Clean output. |
| `build` | `nest build` | Compile TS → `dist/` (uses `tsc`, not swc). |
| `start:prod` | `node dist/main` | Run compiled output. |
| `format` | `prettier --write …` | Format `src/` and `test/`. |
| `lint` | `eslint … --fix` | Lint and auto-fix. |
| `test` | `jest` | Unit tests (`*.spec.ts` under `src/`). |
| `test:watch` / `test:cov` / `test:debug` | Jest variants | — |
| `test:e2e` | `jest --config ./test/jest-e2e.json` | Boots the app and hits `/`. |

Database files must be present in the working directory of the running process (or one level up). For `npm start` from the repo root, this means the `*.db` files at the repo root are used directly.

---

## 12. Testing

Two suites exist today:

- `src/app.controller.spec.ts` — verifies `getHello()` returns `'Hello World!'`.
- `test/app.e2e-spec.ts` — boots the full app via `Test.createTestingModule` and `GET /`.

Neither suite exercises `getFromDB`. New tests touching the SQL path should:

- Avoid depending on the bundled large DB files.
- Either use a small fixture `.db` checked into a test-only fixtures directory, or open `:memory:` and seed it (note: `:memory:` is per-connection; the per-request open/close in `AppService` makes this awkward without refactoring the service to accept an injected DB handle).

---

## 13. Operational notes and known issues

- **Per-request connection open/close.** Every request pays the cost of opening the SQLite file, preparing the statement, executing, and closing. For the database sizes in use (up to ~300 MB), the OS page cache absorbs most of this, but throughput is bounded by single-statement latency. If sustained throughput becomes an issue, hold one `DatabaseSync` per role for the process lifetime instead of per-request — the database is read-only so concurrency is safe.
- **Synchronous SQLite in an async server.** `DatabaseSync` blocks the Node event loop for the duration of every query. Long-running queries will stall the server. Consider `node:sqlite` async APIs or a worker thread if/when long queries become common.
- **Boot-time abort is silent over HTTP.** If `DB_DATA` or `DB_INDEX` is missing, `bootstrap()` returns before `app.listen` and the process exits cleanly with a console error — there is no exit code distinguishing it from a normal shutdown. Wrappers/process managers should `grep` logs or be replaced with a `process.exit(1)` here.
- **Filename-prefix dispatch is ambiguous.** Shipping more than one `data*.db` (or `index*`, `farsh*`, `words*`) leads to nondeterministic selection. Treat the prefix as an exclusive role, not a glob.
- **Dead `PRAGMA journal_mode = WAL` branch** in `AppService` — kept for the day the connection is opened writable, but currently unreachable.
- **Strict TS checks disabled.** New code should not rely on this; ideally re-enable `strictNullChecks` incrementally.

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

When extending this service, prefer changes that preserve its core contract: **a thin, read-only, SQL pass-through over bundled SQLite databases**. Likely future directions, in roughly increasing risk order:

1. Externalize port and CORS via env (`@nestjs/config`).
2. Switch from per-request to per-process `DatabaseSync` handles (read-only ⇒ thread-safe enough for sequential JS).
3. Add a statement-timeout / row-cap interceptor before considering any public exposure.
4. Add a typed REST surface for the most common queries (`/sura/:n`, `/aya/:idx`, `/page/:n/:mushaf`) layered **on top of** the existing raw endpoints, not replacing them.
5. Replace prefix-based DB discovery with explicit env vars (`DB_DATA_PATH`, …) once more than one variant per role is plausible.
