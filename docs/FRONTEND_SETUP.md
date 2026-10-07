# Running the backend for frontend development (P0.08)

You run the backend **on your own machine**. The frontend's Vite dev server proxies `/api` to it, so the browser sees one origin: no CORS, and the sign-in cookie works. Nothing depends on the backend developer's laptop.

## Prerequisites

- **Docker Desktop** (MySQL, Redis and Mailpit run in containers)
- **Node 24** via nvm: `nvm install 24 && nvm use 24` (`backend/.nvmrc` says 24)
- The repository cloned, with `backend/` next to `frontend/`

## First time

```bash
cd backend
cp .env.example .env          # works as is for local development
npm ci                        # also generates the Prisma client
npm run stack:up              # MySQL 8.4, Redis 7.4, Mailpit (waits until healthy)
npm run db:migrate:deploy     # creates the tables
npm run db:seed               # permission catalogue, Administrator role, bootstrap admin
npm run db:seed:demo          # optional: demo accounts `manager` and `viewer`
npm run dev                   # API on http://localhost:4000, reloads on change
```

Check: http://localhost:4000/health/ready returns `ok`.

Then in `frontend/`: `npm run dev`. The Vite proxy sends `/api` to `http://localhost:4000` (set `VITE_API_PROXY_TARGET` to change it).

**Always call the API through the proxy** (the relative `/api/v1/...`), never `http://localhost:4000` directly. The refresh token is an `HttpOnly` cookie and only works same-origin.

## Accounts

| Username  | Password (local)                                 | What it is                                                         |
| --------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| `admin`   | `BOOTSTRAP_ADMIN_PASSWORD` in `.env`             | Bootstrap administrator. Must change the password at first sign-in |
| `manager` | `DEMO_PASSWORD` in `.env` (after `db:seed:demo`) | Administrator + Demo estate administration (P1.07), all estates    |
| `viewer`  | `DEMO_PASSWORD`                                  | Read-only (users, roles, hierarchy), scope: estate DEMO-A only     |

Five wrong passwords lock an account for 15 minutes. To unlock locally: `docker exec rupai-mysql mysql -uroot -prupai_root_dev rupai -e "UPDATE user SET locked_until = NULL, failed_attempts = 0"`.

## The API contract

- **Swagger UI:** http://localhost:4000/docs. Every endpoint, its permission, filters and error codes, all generated from the code, so it is always current. Click **Authorize** and paste an access token from `POST /api/v1/auth/login`.
- **For Postman/Insomnia or MSW:** `npm run docs:openapi` writes `docs/openapi.json`.
- The `[BE]` story of each feature in Jira has a comment with the screen-level contract.

## Emails

Password reset emails go to **Mailpit**: http://localhost:8025. The link is `http://localhost:5173/reset-password#token=…` (`APP_PUBLIC_URL`).

## When a new backend feature lands

```bash
cd backend
git pull
npm ci                      # if package-lock.json changed
npm run db:migrate:deploy   # new tables
npm run db:seed             # new seed data (idempotent, safe to run any time)
npm run dev
```

Then switch that feature's MSW mocks off (`VITE_MOCK_API`).

## Troubleshooting

| Symptom                                        | Fix                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Invalid configuration — refusing to start`    | The message names the variable. Compare your `.env` with `.env.example` (new settings are added there) |
| `/health/ready` says database or redis is down | `npm run stack:up`, then `docker ps` should show `rupai-mysql`, `rupai-redis` healthy                  |
| Port 3306 / 6379 / 4000 already in use         | Stop the other MySQL/Redis/server, or set `MYSQL_PORT` / `REDIS_PORT` / `PORT` in `.env`               |
| `The table … does not exist`                   | `npm run db:migrate:deploy`                                                                            |
| Every request is `401` after a while           | The access token lasts 15 minutes. Call `POST /api/v1/auth/refresh` (through the proxy)                |
| `403 PASSWORD_CHANGE_REQUIRED`                 | The account has a temporary password. `POST /api/v1/auth/password/change` first                        |
| Start again with an empty database             | `npm run stack:down && docker volume rm rupai_mysql-data`, then the "First time" steps from `stack:up` |
