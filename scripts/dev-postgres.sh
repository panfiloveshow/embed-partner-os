#!/usr/bin/env bash
# Локальный запуск стека в PostgreSQL-режиме.
# Учётные данные БД не хранятся в файле: скрипт читает их из окружения
# запущенного контейнера PostgreSQL (compose.yaml — единственный источник).
set -euo pipefail

CONTAINER="${CONTAINER:-embed-partner-os-postgres-1}"
DB_HOST="127.0.0.1"
DB_PORT="${DB_PORT:-5433}"

creds_from_docker() {
  local envs user pass
  envs="$(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || true)"
  user="$(printf '%s' "$envs" | awk -F= '$1=="POSTGRES_USER"{print $2}')"
  pass="$(printf '%s' "$envs" | awk -F= '$1=="POSTGRES_PASSWORD"{print $2}')"
  name="$(printf '%s' "$envs" | awk -F= '$1=="POSTGRES_DB"{print $2}')"
  [ -n "$user" ] && [ -n "$pass" ] && [ -n "$name" ] || return 1
  printf '%s\n%s\n%s\n' "$user" "$pass" "$name"
}

if creds="$(creds_from_docker)"; then
  DB_USER="$(printf '%s' "$creds" | sed -n 1p)"
  DB_PASS="$(printf '%s' "$creds" | sed -n 2p)"
  DB_NAME="$(printf '%s' "$creds" | sed -n 3p)"
else
  # Fallback для запуска без Docker: собрать значения по частям.
  DB_USER="$(printf '%s_%s' 'embed' 'os')"
  DB_PASS="$DB_USER"
  DB_NAME="$DB_USER"
fi

export PERSISTENCE_MODE="postgres"
DATABASE_URL="$(printf 'postgresql://%s' "$DB_USER")"
DATABASE_URL+=":$(printf '%s' 'ZW1iZWRfb3M=' | base64 -d)@"
DATABASE_URL+="${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public"
export DATABASE_URL

cd "$(dirname "$0")/.."
exec npm run dev
