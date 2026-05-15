# Working in this repo

## SPEC.md is the source of truth

`SPEC.md` (at the repo root) is the canonical description of this project: purpose, architecture, tech stack, database catalog, HTTP surface, configuration, security model, build/test/run, known issues.

**At the start of every session, read `SPEC.md` before doing any other exploration.** It will give you the right mental model in one file and save you redundant searching.

**Whenever you change something that the spec covers, update `SPEC.md` in the same change.** The spec must not drift from the code. Specifically, update it when you:

- add/remove/rename an HTTP route, query parameter, or response shape
- change bootstrap behavior, port, CORS, or DB-discovery logic
- add, remove, rename, or version-bump a `.db` file, table, or column referenced in §6
- change the tech stack (Node version, NestJS major, swap a dependency, add/remove a build tool)
- change scripts in `package.json`, lint/format/tsconfig settings, or test layout
- change the security posture (auth, rate limiting, CORS, statement limits)
- discover a new operational gotcha worth recording in §13

Treat a PR that changes behavior without updating `SPEC.md` as incomplete. If a change makes part of the spec obsolete, delete or rewrite that section — don't leave stale text alongside new text.

When in doubt about whether a change warrants a spec update: if a future contributor reading only `SPEC.md` would get a wrong answer after your change, update the spec.
