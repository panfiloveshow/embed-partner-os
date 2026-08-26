#!/usr/bin/env bash
# Восстановление базы Embed Partner OS из дампа, созданного backup.sh.
#
# Использование:
#   ./scripts/restore.sh backups/embed-os-2026-08-25_0300.dump [compose-file]
#
# Скрипт останавливает api и все воркеры (postgres остаётся), восстанавливает
# дамп с --clean --if-exists и запускает стек обратно.
set -euo pipefail

DUMP_FILE="${1:?Укажите путь к дампу: ./scripts/restore.sh backups/xxx.dump}"
COMPOSE_FILE="${2:-compose.prod.yaml}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

[ -f "$DUMP_FILE" ] || { echo "Дамп не найден: $DUMP_FILE"; exit 1; }

cd "$ROOT"
WORKERS="api worker-placement-monitor worker-weekly-report worker-report-digest \
worker-opportunity-sla worker-sla-notification worker-radar-recheck \
worker-radar-sourcing worker-outbox-relay"

echo "[restore] Останавливаю приложение: $WORKERS"
docker compose -f "$COMPOSE_FILE" stop $WORKERS

echo "[restore] Восстанавливаю $DUMP_FILE"
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_restore -U embed_os -d embed_os --clean --if-exists < "$DUMP_FILE"

echo "[restore] Запускаю стек"
docker compose -f "$COMPOSE_FILE" start
sleep 5

HEALTH=$(curl -s -m 10 "http://127.0.0.1:${WEB_PORT:-8080}/api/v1/health" || true)
echo "[restore] Health после восстановления: $HEALTH"
