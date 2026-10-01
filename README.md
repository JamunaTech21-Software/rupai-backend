# RupAI Backend

The REST API for **RupAI**, an integrated ERP for tea estates.
**Express 5 · TypeScript (strict) · Prisma · MySQL 8 · Redis**

- Specification: `../RupAi_Complete_Technical_Specification_v1.0.md` (referred to as "the spec")
- Delivery plan: `../BACKLOG.md`
- Jira project: `RUP`

## Requirements

- **Node.js 24 LTS.** The version is pinned in `.nvmrc`; run `nvm use`.
- **npm 10 or later**
- **Docker**, for the local MySQL 8.4 (Redis and MailHog arrive in P0.07)

## Quick start

```bash
nvm use                  # Node 24
npm install              # also generates the Prisma client
cp .env.example .env
npm run db:up            # MySQL 8.4 in Docker, with accounts and settings
npm run db:migrate:deploy
npm run db:seed
npm run dev              # http://localhost:4000
```

## Scripts

| Script                            | What it does                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                     | Runs the API with reload on change (tsx watch)                                                                                        |
| `npm run build`                   | Compiles to `dist/`                                                                                                                   |
| `npm start`                       | Runs the compiled build                                                                                                               |
| `npm run typecheck`               | Type-checks without emitting files                                                                                                    |
| `npm run lint` / `lint:fix`       | Runs ESLint (strict type-checked rules)                                                                                               |
| `npm run format` / `format:check` | Runs Prettier                                                                                                                         |
| `npm test` / `test:watch`         | Runs the unit tests (no services needed)                                                                                              |
| `npm run test:db`                 | Runs the database tests against the local MySQL (`db:up` first)                                                                       |
| `npm run db:*`                    | Database: `up`, `down`, `migrate:new`, `migrate:dev`, `migrate:deploy`, `status`, `seed`, `drift`, `generate`. See `prisma/README.md` |
| `npm run check`                   | Runs typecheck, lint, format check and tests. This is what CI runs                                                                    |

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

## Database

MySQL 8.4 with Prisma, used **SQL-first**. Read [`prisma/README.md`](prisma/README.md) before touching the schema. In short: `schema.prisma` mirrors spec Part 3, migrations are generated with `--create-only` and hand-reviewed, and `db push` is blocked. The app connects as a DML-only account whose `UPDATE`/`DELETE` rights are granted per table, so append-only tables are enforced by the database itself.

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
