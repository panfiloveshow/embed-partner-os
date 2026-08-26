#!/usr/bin/env bash
# Резервная копия базы Embed Partner OS (продакшн-стек Docker Compose).
#
# Использование:
#   ./scripts/backup.sh [compose-file]
#
# По умолчанию пишет сжатый дамп в ./backups/<дата>.dump и хранит
# последние BACKUP_KEEP файлов (по умолчанию 14). Для cron:
#   0 3 * * * /path/to/repo/scripts/backup.sh >> /var/log/embed-os-backup.log 2>&1
set -euo pipefail

COMPOSE_FILE="${1:-compose.prod.yaml}"
KEEP="${BACKUP_KEEP:-14}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$ROOT/backups"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%F_%H%M)"
TARGET="$BACKUP_DIR/embed-os-$STAMP.dump"

cd "$ROOT"
echo "[backup] pg_dump -> $TARGET"
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U embed_os -d embed_os -Fc > "$TARGET"

# Ротация: оставляем последние KEEP дампов.
ls -1t "$BACKUP_DIR"/embed-os-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs rm -f || true

SIZE=$(du -h "$TARGET" | cut -f1)
echo "[backup] готово: $TARGET ($SIZE). Храним последние $KEEP."
