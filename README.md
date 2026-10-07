# RupAI Backend

The REST API for **RupAI**, an integrated ERP for tea estates.
**Express 5 · TypeScript (strict) · Prisma · MySQL 8 · Redis**

- Specification: `../RupAi_Complete_Technical_Specification_v1.0.md` (referred to as "the spec")
- Delivery plan: `../BACKLOG.md`
- Jira project: `RUP`

## Requirements

- **Node.js 24 LTS.** The version is pinned in `.nvmrc`; run `nvm use`.
- **npm 10 or later**
- **Docker**, for the local stack (MySQL 8.4, Redis 7.4, Mailpit) and for the database tests

## Quick start

```bash
nvm use                  # Node 24
npm install              # also generates the Prisma client
cp .env.example .env
npm run stack:up         # MySQL 8.4 + Redis 7.4 + Mailpit in Docker (all on 127.0.0.1)
npm run db:migrate:deploy
npm run db:seed          # permission catalogue, Administrator role, bootstrap admin (BOOTSTRAP_ADMIN_*)
npm run db:seed:demo     # optional: demo accounts `manager` and `viewer` (DEMO_PASSWORD; never in production)
npm run dev              # http://localhost:4000, API docs at http://localhost:4000/docs
```

**Frontend developers:** follow [`docs/FRONTEND_SETUP.md`](docs/FRONTEND_SETUP.md).
**Staging** (manager verification, frontend on Vercel): [`docs/STAGING.md`](docs/STAGING.md).

| Service  | Address                                    | Notes                                                                     |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| MySQL    | `127.0.0.1:3306`                           | Accounts from `docker/mysql/init`. `npm run db:up` alone starts only this |
| Redis    | `127.0.0.1:6379`                           | Password `rupai_redis_dev`, AOF on, `noeviction`                          |
| Mailpit  | SMTP `127.0.0.1:1025`, UI `localhost:8025` | Catches every outgoing mail (from P1.02)                                  |
| API docs | `/docs`, `/docs/openapi.json`              | Swagger UI. On outside production, off in it (`DOCS_ENABLED`)             |

## Scripts

| Script                            | What it does                                                                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                     | Runs the API with reload on change (tsx watch)                                                                                                                                      |
| `npm run build`                   | Compiles to `dist/`                                                                                                                                                                 |
| `npm start`                       | Runs the compiled build                                                                                                                                                             |
| `npm run typecheck`               | Type-checks without emitting files                                                                                                                                                  |
| `npm run lint` / `lint:fix`       | Runs ESLint (strict type-checked rules)                                                                                                                                             |
| `npm run format` / `format:check` | Runs Prettier                                                                                                                                                                       |
| `npm test` / `test:watch`         | Runs the unit tests (no services needed)                                                                                                                                            |
| `npm run test:db`                 | Runs the database tests against a throwaway MySQL 8.4 started by Testcontainers (only Docker needs to be running). Set `TEST_DB_HOST=127.0.0.1` to reuse the `db:up` server instead |
| `npm run ci`                      | Runs exactly what CI runs: typecheck, lint, format, all tests, build, audit                                                                                                         |
| `npm run db:*`                    | Database: `up`, `down`, `migrate:new`, `migrate:dev`, `migrate:deploy`, `status`, `seed`, `drift`, `generate`. See `prisma/README.md`                                               |
| `npm run check`                   | Runs typecheck, lint, format check and unit tests (a quick pre-push check)                                                                                                          |
| `npm run stack:up` / `stack:down` | Starts or stops the whole local stack (MySQL, Redis, Mailpit)                                                                                                                       |
| `npm run docs:openapi`            | Writes the OpenAPI 3.1 document to `docs/openapi.json` (generated, not committed). Import it into Postman or Insomnia                                                               |

## Project layout

```
src/
  app.ts          Express app factory (no port binding, so tests can import it)
  server.ts       Process entry: listen and graceful shutdown
  config/         Validated environment configuration (P0.02)
  middleware/     Request context, error handler, validation, auth guards
  core/           Cross-cutting engines: errors, auth, scope, audit, rules,
                  approval, jobs, storage, posting, stock (see src/core/README.md)
  modules/        One folder per bounded context (see src/modules/README.md)
prisma/           schema.prisma, hand-reviewed migrations, seeds (P0.03)
tests/
  unit/           Pure rule and calculation tests
  integration/    API and database tests against a real MySQL (P0.06)
```

## Configuration and logging

- **Configuration:** every setting comes from environment variables, documented in `.env.example`. A local `.env` is loaded if present; real environment variables always win. `src/config/env.ts` validates everything at start-up, and the server **refuses to start** with a list of every problem if a value is missing or malformed. Secret values are never echoed.
- **Request id:** every request gets a request id (a ULID, or the caller's `X-Request-Id` if it is safe). It is returned in the `X-Request-Id` header and appears on every log line for that request.
- **Logging:** logs are structured JSON (Pino). Use `getLogger(rootLogger)` inside services to get the request-bound logger. Passwords, tokens, national IDs and bank details are redacted automatically (at the top level and one level deep), and request headers and bodies are never logged.
- **Environment header:** non-production environments send `X-Environment`, so the web app can show an environment banner.

## API conventions

Every endpoint follows spec Part 4, through the helpers in `src/core/http`. Don't hand-roll these:

- **Base path** `/api/v1`. Modules are listed in `src/modules/index.ts` (`buildModules`).
- **Declaring endpoints:** build every module with `defineModule({ name, path, tag, platform })` and `.route({ method, path, summary, auth, params, query, body, list, ifMatch, idempotent, success, errors, handler })`. The route wires validation, the list grammar, If-Match and Idempotency-Key for you, and the same declaration generates the OpenAPI document. A declaration is checked at start-up: a missing permission (`module.action`), a public route without a reason, undeclared error codes, or a list without declared filters and sorts stops the server (Spec P4 §6).
- **Responses:** `sendOne` / `sendCreated` / `sendPage` / `sendCursorPage`. That gives `{ data, meta: { request_id, … } }`, never a bare array. BigInt ids serialise as strings, and money as decimal strings.
- **Errors:** throw `AppError(code, message, details)`. The central handler maps codes to statuses (`src/core/errors/codes.ts`) and sends `{ error: { code, message, details, request_id } }`. Unexpected errors become a 500 with nothing internal leaked.
- **Validation:** `validate({ params, query, body })` with Zod strict objects. Failures give 422 `VALIDATION_FAILED`, with field paths like `lines.0.quantity`.
- **Lists:** `listQuery(spec)` declares filterable, sortable and includable fields and the pagination mode. Anything undeclared is refused with 422 (`UNKNOWN_FILTER`, `UNKNOWN_SORT`, `UNKNOWN_INCLUDE`), and `per_page` is clamped to 200.
- **Concurrency:** versioned resources send `ETag`. Mutations call `requireIfMatch` and `assertVersion`: a missing header gives 422 `PRECONDITION_REQUIRED`, a stale version gives 409 `VERSION_CONFLICT`.
- **Retries:** `idempotency({ store })` on transition endpoints. The same `Idempotency-Key` replays the original response.
- **Rate limits:** every `/api/v1` route gets the read (120/min) or write (60/min) class. Stricter classes are in `RATE_LIMIT_CLASSES`. Counters live in Redis (`rupai:rl:<class>:<user|ip>`), so the limit is shared by every API process.
- **Health:** `GET /health` (liveness) and `GET /health/ready` (database and Redis reachable, otherwise 503), outside `/api/v1`, unauthenticated, not logged.

> With `REDIS_URL` set (required in production), idempotency records (`rupai:idem:<sha256>`) and rate-limit counters are in Redis and shared across processes. Without it they fall back to per-process memory, which is for local development only; the server logs a warning.

## Money, ids and dates

- **Money and quantities:** use `Dec` from `src/core/money/decimal.ts`, never `number`. Validate input with `zDecimal('money' | 'qty' | 'rate' | 'pct')`, which refuses JSON numbers, exponents and extra decimal places. Round payable amounts with `roundMoney` (2 dp, half up, per component). Split totals with `allocate` (the rounding difference goes to the largest line) or `splitInstalments` (the final instalment absorbs it). Output with `toDecimalString(value, kind)`.
- **Ids:** BIGINT ids are strings in the API (`zId` → bigint). The six field-capture tables use ULIDs (`newUlid`, `zUlid`).
- **Dates:** business dates are `YYYY-MM-DD` (`zBusinessDate`). Always convert DATE columns with `businessDateFromDb` / `businessDateToDb`, or they shift by a day. "Today" for an estate is `todayIn(config.timezone)`. Timestamps need an explicit offset (`zTimestamp`).

## Users, roles and permissions (P1.01)

- **Two layers** (Spec P6 §2): a **permission** (`module.action`, e.g. `sale.approve`) decides whether a user may do something at all; **scope** (P1.03) decides which records. Declare the permission on the route (`auth: { permission: 'sale.approve' }`). `defineModule` then answers 401 without a signed-in user and 403 `PERMISSION_DENIED` without the permission, before the body is validated.
- **Resolved on every request**, from active user → active roles → unexpired grants → permissions. A disabled user, a deactivated role or a lapsed temporary grant loses access immediately.
- **The catalogue** (`src/modules/identity/permission-catalogue.ts`) holds every permission the application enforces: 92 modules, 630 permissions, each module's actions set by its class (P6 Table 3.2). It is seeded as system rows, and the app account cannot change them. A new module's permissions are added there, and the seed adds them.
- **Seeded:** the catalogue, the `ADMINISTRATOR` system role (R-01: platform administration only, with no business approve, reject or post), and the bootstrap admin, user id 1. Its password comes from `BOOTSTRAP_ADMIN_PASSWORD` and must be changed at first sign-in. The other 17 roles of P6 §7 are created once the client confirms them.
- **Guards:** a new user has no roles; passwords are argon2id and never returned; a system role can only be renamed; a role held by anyone cannot be deleted; at least one active user always holds the Administrator role permanently (`LAST_ADMINISTRATOR`).
- Own-account endpoints (`/auth/me`, sessions, password change) declare `auth: { signedIn: true, reason }` instead of a permission.

## Audit, status history and access log (P1.05)

- **Four append-only tables** (P3 §29): `audit_change` (field-level before/after), `status_history` (every state change), `access_log` (sign-ins, failures, lockouts, logouts, refreshes, password events, permission and scope denials, exports, prints), `integration_log` (external calls, by reference only). The app account has **no UPDATE or DELETE** on them, so the database itself makes them immutable.
- **The audit writer** (`src/core/audit/audit.ts`) runs in the **same transaction** as the change. If the audit write fails, the change fails. Depth follows P1 Table 13.1: each module declares a record type, its class and the fields it tracks (`identity.audit.ts`). Masters record their significant fields. Policy and financial records also keep the client address and user agent. Passwords and secrets are never written: a password change shows as `(changed)`.
- **Wired in:** every user, role, scope grant and authorisation change is audited. Users and roles get status history. Every sign-in event (P1.02) and every permission denial is in the access log. Scope denials are logged even though the caller only sees 404: the scope extension checks whether the record exists outside the scope.
- **The access log is written outside the caller's transaction**, because a refused sign-in or a denied request never commits. A failed write is logged and never changes the answer.
- **API** (`audit.view`): `GET /audit/changes`, `/audit/status-history`, `/audit/access-log`. These are cursor-paginated, newest first, and need a time range (at most 366 days unless one record is named).

## Separation of duties (P1.04)

- **The rules** (`src/modules/identity/sod-rules.ts`, P6 Table 5.1) are expanded into concrete permission combinations, for example `payroll.create + payroll.approve`, or `user.edit` with any financial approve or post. `GET /access/sod-rules` lists them. The 15 **sensitive permissions** of P6 Table 10.1 are listed in the permission catalogue.
- **Checked on the union of a user's roles** whenever it changes: role assignment, a role's permissions changing (every holder is re-checked), and role reactivation. A conflict or sensitive permission does not forbid the change. It needs a **named, written authorisation**: without one the change is `422 AUTHORISATION_REQUIRED`, whose details carry each `key`. Resend with `authorisations: [{ key, reason }]` (on a role change, with `user_id`). `POST /users/{id}/roles/check` previews it without changing anything.
- **Recorded** in `access_authorisation`: the user, rule, permissions, reason, who authorised and when. Removal is recorded too (`DELETE /users/{id}/authorisations/{id}`), never deleted.
- **`GET /access/concentration-report`** (P6 §9.2) lists active overrides (and whether they are still held), sensitive-permission holders, users with 4+ roles, and approve+post holders. It also works as the review: every conflict held **without** an authorisation, however it arose.
- The bootstrap administrator's (and the demo `manager`'s) sensitive permissions are seeded as authorised.

## Data scope (P1.03)

- **Permission says what, scope says which records** (Spec P1 §12, P6 §4). A user's scope is the **union** of their grants in `user_scope` (all_estates, estate, division, section, department, facility), plus implicit **self** (records about their own employment profile). Expired grants and disabled users confer nothing. It is resolved per request, so a change applies on the next request.
- **Enforced in the data-access layer:** a Prisma client extension filters every query on a registered estate- or facility-tier model. Out-of-scope rows are absent from lists and aggregates, a single one is 404, an out-of-scope create is 403 `SCOPE_DENIED`, and a scoped query without a scope throws. How to register a model: [`src/modules/README.md`](src/modules/README.md#data-scope-for-estate--and-facility-tier-tables-p103).
- **API:** `GET/POST /users/{id}/scopes`, `PATCH` (expiry, If-Match) and `DELETE /users/{id}/scopes/{grantId}`. `/auth/me` returns the resolved `scope`. The bootstrap admin is seeded with all_estates.
- No scoped business table exists until P1.07 (estates). The mechanism is tested against a stand-in model (`tests/db/scope.test.ts`), with the reusable leakage suite every later epic plugs into.

## Sign-in and sessions (P1.02)

- **Tokens** (Spec P4 §2.2): `POST /api/v1/auth/login` returns a **15-minute access token** in the body. The SPA keeps it **in memory only** and sends it as `Authorization: Bearer …`. The **refresh token is an HttpOnly, SameSite=Strict cookie** scoped to `/api/v1/auth`, and no script can read it. The SPA calls the API on its own origin (Vite proxy locally, one host on staging), so the cookie is first-party.
- **Identity only:** the access token carries user id, session id, token id, issued-at and expiry, with no permissions. Permissions are resolved per request (P1.01), so a role change applies to the next request.
- **Revocable:** every request checks its session (`auth_session`): not revoked, not expired, user active. The answer is cached in Redis for ≤ 30 s, with a database fallback. Revocations write a tombstone. **Disabling a user, logout, logout-all, a password change or reset, and refresh-token reuse end access on the next request**, not at token expiry.
- **Rotation:** each `POST /auth/refresh` uses up the refresh token and issues a new one. **Presenting a used refresh token ends the whole session** (theft) and is logged as `auth.refresh_reuse`. The client must refresh single-flight.
- **Lockout:** 5 consecutive failures lock the account for 15 minutes (`AUTH_LOCKOUT_*`). On top of that, sign-in is limited to 5 per minute per IP and per username. An unknown username and a wrong password get the same answer. Only the right password learns that an account is locked or disabled (`ACCOUNT_LOCKED`).
- **Temporary passwords:** while `must_change_password` is set (a new user or the bootstrap admin), every permission route answers `403 PASSWORD_CHANGE_REQUIRED`. Own-account endpoints still work.
- **Password reset:** `POST /auth/password/forgot` always answers 202. If the address belongs to an active user, a single-use link valid for 30 minutes is emailed: `<APP_PUBLIC_URL>/reset-password#token=…`. Locally the email lands in Mailpit (http://localhost:8025). A reset clears any lockout and ends every session.
- **Key rotation:** set a new `AUTH_TOKEN_SECRET` and move the old one to `AUTH_TOKEN_PREVIOUS_SECRET`. Nobody is signed out.
- **Events** (`event: auth.*` in the log): login succeeded/failed, account locked, token refreshed, refresh reuse, logout, logout-all, session revoked, password changed/reset/reset requested. They move to `access_log` with P1.05.
- **Try it:** `npm run db:seed`, then sign in as `admin` with `BOOTSTRAP_ADMIN_PASSWORD`, then `POST /auth/password/change`. In `/docs`, paste the access token into **Authorize**.

## Deployment (P0.08)

- **Image:** `Dockerfile` has two targets. `runtime` is the API (compiled JavaScript and production dependencies, runs as `node`, with a health check). `tools` is the full toolchain for `prisma migrate deploy` and the seeds.
- **Staging:** `deploy/staging/` has the Compose stack (api, MySQL, Redis, Mailpit, nightly backup, Cloudflare Tunnel; no public port), `.env.example` for its secrets, and `deploy.sh`. The script builds, backs up, migrates, seeds, swaps the API, waits for `/health/ready`, and rolls the API back if it does not become ready. The frontend is on Vercel and reaches the API through rewrites (`deploy/vercel/vercel.json`), so the browser sees one origin. Runbook: [`docs/STAGING.md`](docs/STAGING.md).
- **`TRUST_PROXY`** accepts a hop count (`2` on staging: Vercel, then Cloudflare), so sign-in lockout and rate limits see the user's IP.

## Database

MySQL 8.4 with Prisma, used **SQL-first**. Read [`prisma/README.md`](prisma/README.md) before touching the schema. In short: `schema.prisma` mirrors spec Part 3, migrations are generated with `--create-only` and hand-reviewed, and `db push` is blocked. The app connects as a DML-only account whose `UPDATE`/`DELETE` rights are granted per table, so append-only tables are enforced by the database itself.

## Testing

| Level                       | Where                             | Runs against                                                                                                                                                                             |
| --------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit and integration (HTTP) | `tests/unit`, `tests/integration` | Nothing external. The app is driven with Supertest                                                                                                                                       |
| Database                    | `tests/db`                        | A **real MySQL 8.4** (Spec P13 §8.1) and Redis 7.4, started by Testcontainers with the production settings and accounts. `TEST_DB_HOST` / `TEST_REDIS_URL` reuse the local stack instead |

- **Isolation:** `withRollback(db, fn)` runs a test's writes in a transaction that is always rolled back. Suites needing DDL use `createTempDatabase()` (a `rupai_tmp_*` database, dropped afterwards, with its grants revoked).
- **Fixture:** `tests/fixtures/minimal-dataset.ts` holds the minimal dataset (P13 §7.1). Each epic adds its rows as an idempotent seeder.
- **Acting as a user:** API suites sign in for real (`tests/db/auth.test.ts`: `POST /auth/login`, then a bearer token). For speed, `buildTestApp` and the P1.01 suite still mount `testActor()`, where `as(request, userId)` sets the actor without a session. Permissions are real either way: give the user a role holding them. `testModuleDeps()` builds everything `buildModules` needs.
- **A real schema:** `createMigratedDatabase()` builds a throwaway database from the actual migrations and seeders (app and migrator connections). API suites run against it.
- **What counts as tested:** each spec worked example, error code, state transition and invariant has a test. Coverage percentage is not a target (P13 §8.2).
- **CI** (`.github/workflows/ci.yml`) runs `npm run ci`'s steps on every push and pull request. Any failure blocks the merge.

## Non-negotiable conventions

These come straight from the spec, and code review enforces them.

1. **The spec's Part 3 is the authority on the schema.** Prisma is used SQL-first: migrations are created with `--create-only` and the SQL is hand-reviewed. `prisma db push` is never used (BACKLOG §2.1).
2. **No floats for money or quantities.** Use decimal types, and transmit values as decimal strings (Spec P9 §2.1, P4 §2.3).
3. **Approval is the derivation boundary.** Posting, stock movement and settlement happen atomically with the approval that causes them (Spec P1 §2.2, §4.3).
4. **Posted and derived records are never edited.** They are corrected by reversal (Spec P1 §2.3, §3.1.5).
5. **Scope is enforced in the data-access layer.** A record outside the caller's scope returns `404`, not `403` (Spec P4 §4.3).
6. **No secret is ever committed.** Configuration comes from the environment only (Spec P14 §4.3).

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/) with the Jira key, for example:

```
feat(auth): rotate refresh tokens on use (RUP-66)
```

The Husky hooks (`lint-staged` on pre-commit, `commitlint` on commit-msg) are set up by `npm install` once this folder is inside a git repository. If the git root is the parent `RupAI/` folder rather than `backend/`, change `prepare` to `cd .. && husky backend/.husky`.
