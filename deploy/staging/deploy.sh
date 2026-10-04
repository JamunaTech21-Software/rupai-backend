#!/usr/bin/env bash
# Deploys a commit to STAGING (P0.08). Run on the staging machine:
#
#   cd backend/deploy/staging && ./deploy.sh            # the latest main
#   ./deploy.sh v0.3.0                                  # a tag, branch or commit
#   ./deploy.sh --worktree                              # the files as they are, no git at all
#                                                       # (a developer machine acting as staging)
#
#   1. fetch and check out the ref (detached)        5. seed (idempotent; demo accounts if DEMO_PASSWORD)
#   2. build the api and tools images, tagged by SHA 6. start the new api
#   3. start the stack (database, Redis, mail, …)    7. wait for /health/ready
#   4. back up, then apply migrations                8. on failure: put the previous api back, exit 1
#
# Migrations are not rolled back on failure. They are written expand-then-contract (prisma/README.md),
# so the previous api keeps working on the migrated schema. The pre-migration backup is the last resort.
set -euo pipefail
cd "$(dirname "$0")"

REF="${1:-main}"
log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mDEPLOY FAILED: %s\033[0m\n' "$*" >&2; exit 1; }

[ -f .env ] || die "deploy/staging/.env is missing (copy .env.example and fill it in)"
command -v docker >/dev/null || die "docker is not installed"
if grep -Eq '^COMPOSE_PROFILES=(.*,)?tunnel(,|$)' .env && ! grep -Eq '^CLOUDFLARE_TUNNEL_TOKEN=.+' .env; then
  die "CLOUDFLARE_TUNNEL_TOKEN is empty in .env (or remove 'tunnel' from COMPOSE_PROFILES)"
fi

if [ "${REF}" = "--worktree" ]; then
  # Deploy exactly what is on disk. Never touches git (the working tree may hold uncommitted work).
  SHA="local-$(date -u +%Y%m%d%H%M%S)"
  log "Deploying the working tree as ${SHA}"
else
  log "Fetching ${REF}"
  git fetch --tags --prune origin
  if git rev-parse --verify --quiet "origin/${REF}" >/dev/null; then TARGET="origin/${REF}"; else TARGET="${REF}"; fi
  git checkout --quiet --detach "${TARGET}"
  SHA="$(git rev-parse --short=12 HEAD)"
fi
export API_TAG="${SHA}"
PREVIOUS="$(cat .deployed-tag 2>/dev/null || true)"
echo "deploying ${SHA} (previous: ${PREVIOUS:-none})"

log "Building images"
docker compose build api tools

log "Starting the stack"
docker compose up -d mysql redis mail backup

log "Backing up before migrating"
docker compose exec -T backup bash /usr/local/bin/backup.sh --once || die "backup failed; nothing was changed"

log "Applying migrations"
docker compose run --rm tools npx prisma migrate deploy || die "migration failed; the previous api is still running"

log "Seeding"
docker compose run --rm tools npm run --silent db:seed || die "seed failed; the previous api is still running"
if grep -Eq '^DEMO_PASSWORD=.{12,}' .env; then
  docker compose run --rm tools npm run --silent db:seed:demo || die "demo seed failed"
fi

log "Starting api ${SHA}"
docker compose up -d --no-deps api
docker compose up -d # everything else, including the tunnel (COMPOSE_PROFILES=tunnel)

log "Waiting for /health/ready"
ready=0
for _ in $(seq 1 30); do
  if docker compose exec -T api node -e \
    "fetch('http://127.0.0.1:4000/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 2
done

if [ "${ready}" != 1 ]; then
  docker compose logs --tail 50 api || true
  if [ -n "${PREVIOUS}" ]; then
    log "Rolling back to ${PREVIOUS}"
    API_TAG="${PREVIOUS}" docker compose up -d --no-deps api
  fi
  die "api ${SHA} did not become ready"
fi

docker tag "rupai-api:${SHA}" rupai-api:latest
docker tag "rupai-tools:${SHA}" rupai-tools:latest
echo "${SHA}" > .deployed-tag
docker image prune -f >/dev/null
log "Deployed ${SHA}"
docker compose exec -T api node -e \
  "fetch('http://127.0.0.1:4000/health').then(r=>r.json()).then(b=>console.log(JSON.stringify(b)))"
if grep -Eq '^COMPOSE_PROFILES=(.*,)?quicktunnel(,|$)' .env; then
  url=""
  for _ in $(seq 1 30); do
    url="$(docker compose logs quicktunnel 2>/dev/null | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
    [ -n "${url}" ] && break
    sleep 2
  done
  log "Public API address (temporary, changes if the quicktunnel container restarts): ${url:-not found yet, see: docker compose logs quicktunnel}"
fi
