#!/usr/bin/env bash
# Creates the local database (if missing), applies pending migrations in order,
# and optionally loads seed data.
#
#   scripts/migrate.sh            # create DB + apply migrations
#   scripts/migrate.sh --seed     # ...and load seeds/ in name order (files and folders)
#   scripts/migrate.sh --reset    # drop and recreate the DB first (destroys data)
#
# Connection: DATABASE_URL (from the environment, else this repo's .env.local,
# else .env).
# Default: postgresql:///history_of?host=/var/run/postgresql  (local socket, your OS user as the DB role)
set -euo pipefail

DB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for env_file in "$DB_DIR/.env.local" "$DB_DIR/.env"; do
  if [[ -z "${DATABASE_URL:-}" && -f "$env_file" ]]; then
    DATABASE_URL="$(grep -E '^DATABASE_URL=' "$env_file" | tail -n1 | cut -d= -f2- | tr -d '"'"'" || true)"
  fi
done
DATABASE_URL="${DATABASE_URL:-postgresql:///history_of?host=/var/run/postgresql}"

SEED=false
RESET=false
for arg in "$@"; do
  case "$arg" in
    --seed)  SEED=true ;;
    --reset) RESET=true ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# Split "postgresql://…/<db>?<query>" into the database name and an admin URL
# for the same server (maintenance db "postgres"), keeping the query (e.g. host=).
URL_NO_QUERY="${DATABASE_URL%%\?*}"
QUERY=""
[[ "$DATABASE_URL" == *\?* ]] && QUERY="?${DATABASE_URL#*\?}"
DB_NAME="${URL_NO_QUERY##*/}"
ADMIN_URL="${URL_NO_QUERY%/*}/postgres${QUERY}"

PSQL=(psql -X -q -v ON_ERROR_STOP=1)

if $RESET; then
  echo "Dropping database $DB_NAME"
  "${PSQL[@]}" "$ADMIN_URL" -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)"
fi

exists="$("${PSQL[@]}" "$ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")"
if [[ "$exists" != "1" ]]; then
  echo "Creating database $DB_NAME"
  "${PSQL[@]}" "$ADMIN_URL" -c "CREATE DATABASE \"$DB_NAME\""
fi

"${PSQL[@]}" "$DATABASE_URL" <<'SQL'
SET client_min_messages = warning;
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
SQL

applied=0
for file in "$DB_DIR"/migrations/*.sql; do
  name="$(basename "$file")"
  sum="$(sha256sum "$file" | cut -d' ' -f1)"
  recorded="$("${PSQL[@]}" "$DATABASE_URL" -tAc "SELECT checksum FROM schema_migrations WHERE filename = '$name'")"

  if [[ -n "$recorded" ]]; then
    if [[ "$recorded" != "$sum" ]]; then
      echo "ERROR: $name was changed after it was applied. Add a new migration instead (or use --reset locally)." >&2
      exit 1
    fi
    continue
  fi

  echo "Applying $name"
  # Migration + bookkeeping row in one transaction.
  { cat "$file"; echo; echo "INSERT INTO schema_migrations (filename, checksum) VALUES ('$name', '$sum');"; } \
    | "${PSQL[@]}" --single-transaction "$DATABASE_URL"
  applied=$((applied + 1))
done
echo "Migrations: $applied applied, database is up to date."

if $SEED; then
  # Seeds run in name order. A numbered .sql file runs as is; a numbered folder
  # (e.g. 002_country_events/) runs every .sql file inside it.
  for entry in "$DB_DIR"/seeds/*; do
    name="$(basename "$entry")"
    if [[ -f "$entry" && "$entry" == *.sql ]]; then
      echo "Seeding $name"
      "${PSQL[@]}" "$DATABASE_URL" -f "$entry"
    elif [[ -d "$entry" ]]; then
      files=("$entry"/*.sql)
      [[ -e "${files[0]}" ]] || continue
      echo "Seeding $name (${#files[@]} files)"
      for file in "${files[@]}"; do
        "${PSQL[@]}" "$DATABASE_URL" -f "$file" || { echo "Failed on $name/$(basename "$file")" >&2; exit 1; }
      done
    fi
  done
fi
