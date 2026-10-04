# Staging: set-up and deploy runbook (P0.08)

Staging is where the manager verifies each feature. It runs on **one always-on machine**, with nothing on a public port.

```text
manager's browser ──► https://<project>.vercel.app                      (Vercel: the React app)
                        ├─ /*                     → index.html
                        └─ /api/* /health* /docs* → https://api-staging.<domain>   (rewrite, same origin for the browser)
                                                       │ Cloudflare Tunnel (outbound from the machine)
                                                       ▼
                       staging machine (Docker): api ─ mysql ─ redis ─ mail (Mailpit) ─ backup ─ cloudflared

team ──► https://mail-staging.<domain> (Cloudflare Access: team emails only) → Mailpit, to read reset emails
```

**Why the rewrite matters:** the browser only ever talks to the Vercel address. The refresh-token cookie (P1.02, `HttpOnly`, `SameSite=Strict`, path `/api/v1/auth`) is therefore first-party and just works. No CORS, and no cross-site cookies.

**Why there is no Cloudflare Access on `api-staging`:** Vercel's rewrite cannot sign in to Access, so Access would block every API call. The API is protected by its own sign-in, lockout and rate limits, and staging holds only demo data. Mailpit is protected by Access because it has no login of its own.

## What you need (decision T-8)

| Item                                                                 | Example                      |
| -------------------------------------------------------------------- | ---------------------------- |
| An always-on Linux machine with Docker (Ubuntu 24.04 LTS, 2 GB RAM+) | A small VPS, or an office PC |
| A domain whose DNS is on Cloudflare (free plan)                      | `example.com`                |
| A Vercel account with access to the frontend repository              | Project `rupai-staging`      |
| SSH access to the machine, and the repository cloned on it           | `git clone … ~/rupai`        |

## 1. Prepare the machine (once)

```bash
# Docker Engine + Compose plugin (https://docs.docker.com/engine/install/ubuntu/), then:
sudo usermod -aG docker "$USER"   # log out and back in
git clone <repo-url> ~/rupai && cd ~/rupai/backend/deploy/staging
cp .env.example .env && chmod 600 .env
```

Fill in `.env`: every password with `openssl rand -hex 24`, `AUTH_TOKEN_SECRET` with `openssl rand -base64 48`, and `APP_PUBLIC_URL` with the Vercel URL. Choose `BOOTSTRAP_ADMIN_PASSWORD` and `DEMO_PASSWORD` (12+ characters).

Close every inbound port except SSH (`sudo ufw default deny incoming && sudo ufw allow OpenSSH && sudo ufw enable`). Nothing in the stack publishes a port.

## 2. Create the Cloudflare Tunnel (once)

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** (type _Cloudflared_). Name it `rupai-staging`.
2. Copy the **token** from the install command into `.env` as `CLOUDFLARE_TUNNEL_TOKEN`. You do not need to run the install command, because the `cloudflared` container uses the token.
3. Add **public hostnames** to the tunnel:

   | Hostname                | Service            |
   | ----------------------- | ------------------ |
   | `api-staging.<domain>`  | `http://api:4000`  |
   | `mail-staging.<domain>` | `http://mail:8025` |

4. **Zero Trust → Access → Applications → Add (self-hosted)** for `mail-staging.<domain>`, with a policy allowing the team's emails. Do **not** add one for `api-staging`.

## 3. Deploy

```bash
cd ~/rupai/backend/deploy/staging
./deploy.sh            # latest main;  ./deploy.sh <tag|branch|commit> for a specific one
```

The script fetches the ref, builds the images, backs the database up, applies migrations, seeds (and the demo accounts if `DEMO_PASSWORD` is set), starts the new API, and waits for `/health/ready`. If the API does not become ready, it puts the previous version back and exits with an error. Run it again for every feature the manager should see.

The first deploy creates the database, its two accounts (`rupai_migrator` for DDL, `rupai_app` for data only) and the bootstrap admin.

## 4. Connect Vercel (once, frontend repository)

1. Copy [`deploy/vercel/vercel.json`](../deploy/vercel/vercel.json) to the root of the frontend repository and replace `api-staging.example.com` with your hostname. Commit it (it belongs to the frontend developer's repository).
2. Vercel → **Add New → Project** → import the frontend repository. The framework is detected as Vite. Leave `VITE_API_*` unset: the app calls the relative `/api/v1`.
3. Every push to the main branch redeploys. Pull requests get preview URLs, which reach the same staging API.
4. If the production URL changes (a custom domain), update `APP_PUBLIC_URL` in `.env` and run `./deploy.sh` again.

## 5. Check it (the P0.08 verification)

1. `https://<project>.vercel.app/health/ready` returns `ok` for database and Redis.
2. Sign in as `admin` with `BOOTSTRAP_ADMIN_PASSWORD`. You are asked to change it. Or sign in as `manager` / `viewer` with `DEMO_PASSWORD`.
3. The top bar shows the **staging banner** (from `X-Environment: staging`).
4. Forgot password for `manager@rupai.local` → the email appears at `https://mail-staging.<domain>` (behind Access).
5. `https://<project>.vercel.app/docs` shows the API documentation.
6. Nothing listens publicly on the machine: `sudo ss -tlnp` shows only SSH.
7. **Client IP:** sign in once, then `docker compose logs api | grep auth.login_succeeded | tail -1`. The `ip` must be **your** public IP (see https://ifconfig.me). If it shows a Vercel or Cloudflare address, adjust `TRUST_PROXY` in `.env` (it is the number of proxies between the user and the API) and run `./deploy.sh` again. The sign-in lockout and rate limits depend on this.

## Day to day

| Task                     | Command (in `backend/deploy/staging`)                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Deploy a new version     | `./deploy.sh`                                                                                                         |
| Which version is running | `cat .deployed-tag`, or `/health` → `commit`                                                                          |
| API logs                 | `docker compose logs -f api`                                                                                          |
| Status                   | `docker compose ps`                                                                                                   |
| Restart the API          | `docker compose restart api`                                                                                          |
| Backups                  | `ls backups/` (nightly at 02:00 Dhaka, plus one before every deploy, 14 days)                                         |
| Restore a backup         | `gunzip -c backups/<file>.sql.gz \| docker compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" rupai'` |
| Reset staging completely | `docker compose down -v` then `./deploy.sh` (**deletes all staging data**)                                            |
| Rotate the token secret  | Move `AUTH_TOKEN_SECRET` to `AUTH_TOKEN_PREVIOUS_SECRET`, set a new one, `./deploy.sh`                                |

Copy `backups/` off the machine from time to time. A backup on the same disk does not survive the disk.

## Temporary address without a domain (quick tunnel)

Until there is a domain on Cloudflare, set `COMPOSE_PROFILES=quicktunnel` in `.env` and run `./deploy.sh` (or `./deploy.sh --worktree` on a developer machine, which deploys the files on disk without touching git). Instead of the named tunnel, the stack starts a Cloudflare _quick tunnel_, and the script prints its address: `https://<random-words>.trycloudflare.com`.

- It needs no domain, token or dashboard set-up.
- **The address changes whenever the `quicktunnel` container restarts** (a reboot, Docker restarting). A normal `./deploy.sh` leaves it running, so the address survives deploys. After a change, look the address up with `docker compose logs quicktunnel | grep trycloudflare` and update the destination in the frontend's `vercel.json`.
- Mailpit is not exposed in this mode. Read reset emails on the machine itself at http://127.0.0.1:8026.
- Moving to a domain later: set `COMPOSE_PROFILES=tunnel`, fill in `CLOUDFLARE_TUNNEL_TOKEN`, add the public hostnames (step 2), and run `docker compose rm -sf quicktunnel && ./deploy.sh`.
