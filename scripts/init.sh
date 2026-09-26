#!/usr/bin/env bash
# First-run bootstrap for a fresh clone.
#
# Idempotent: safe to re-run. It will not wipe the database volume, and the
# migration files in db/migrations only run when Postgres initialises an EMPTY
# data directory — so a second `up` applies nothing. That is why the seed is
# applied explicitly below instead of being left to the initdb mount.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example."
  echo "JWT_SECRET is a placeholder — generate a real one before sharing this machine:"
  echo "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\""
  echo
fi

docker compose up -d --build

# Wait for Postgres to report healthy before touching it. `up -d` returns as soon
# as the container starts, which is well before the database accepts connections.
echo "Waiting for Postgres..."
until docker compose exec -T postgres pg_isready -U "${DATABASE_USER:-cafe_admin}" -d "${DATABASE_NAME:-cafe_saas}" >/dev/null 2>&1; do
  sleep 1
done
echo "Postgres is ready."

# `bliss-cafe` is the container_name in docker-compose.yml.
docker compose exec -T postgres \
  psql -U "${DATABASE_USER:-cafe_admin}" -d "${DATABASE_NAME:-cafe_saas}" \
  < db/seed/seed.sql

cat <<'MSG'

Done.

  API       http://localhost:3000
  Adminer   http://localhost:8080   (docker compose --profile tools up -d)

Stop with `docker compose down`. Add -v to also delete the database volume.
MSG
