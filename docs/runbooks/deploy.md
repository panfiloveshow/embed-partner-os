# Runbook: продакшн-развёртывание Docker Compose

Дата обновления: 2026-08-25. Требуется Docker 24+ с Compose V2 (`docker compose version`).

## Что поднимает стек

| Сервис | Назначение |
| --- | --- |
| `postgres` | PostgreSQL 16, данные в volume `embed-os-postgres` |
| `migrate` | разовые миграции Prisma на каждом старте стека, затем завершается |
| `api` | REST API `/api/v1`, health-check `/api/v1/health` |
| `web` | nginx: статика веб-интерфейса + обратный прокси `/api → api:3000` |
| `worker-placement-monitor` … `worker-radar-sourcing` | все 7 фоновых воркеров тем же образом, что и API |

Воркеры не обязаны быть на одном хосте с API: обработка очередей идемпотентна
(`SKIP LOCKED`, резервирование ключей до сетевых вызовов), поэтому при росте
нагрузки их можно выносить на отдельные узлы, масштабируя по одному сервису.

## Первый запуск

```bash
cp .env.example .env
# Минимум для старта уже вписан; проверьте значения:
#   CORS_ORIGINS=https://ваш-домен      (если фронт не за nginx из стека)
#   SIMILARWEB_API_KEY=…                (оценки трафика в Радаре)
#   REPORT_DIGEST_WEBHOOK_URL / SLA_NOTIFICATION_WEBHOOK_URL и секреты
#   RADAR_SOURCING_SEED_URLS            (автосбор кандидатов)
docker compose -f compose.prod.yaml up -d --build
```

Проверка готовности (подождите ~30–60 секунд после старта):

```bash
curl http://127.0.0.1:8080/api/v1/health
# {"status":"ok","persistenceMode":"postgres",…}
```

Веб-интерфейс: `http://<хост>:8080`. Порт меняется переменной `WEB_PORT`.

## Регистрация сотрудников

После первого старта войдите под bootstrap-пользователем seed-данных либо
создайте учётные записи через «Настройки → Роли и доступ» (см.
`docs/runbooks/access-control.md`). Для production задайте `AUTH_MODE=trusted_proxy`
(закрытый контур + auth-оболочка) или `AUTH_MODE=oidc_jwt` (API проверяет Bearer JWT
через JWKS) — оба режима описаны там же. `AUTH_MODE=development` запрещён при
`NODE_ENV=production` — API откажется стартовать.

## Демо-данные

```bash
docker compose -f compose.prod.yaml --profile seed run --rm seed
```

Заполняет базу демонстрационной выборкой («Сегодня», партнёры, возможности).
Для боевого стенда НЕ выполнять.

## Обновление версии

```bash
git pull
docker compose -f compose.prod.yaml up -d --build
```

Миграции применятся автоматически сервисом `migrate` до старта API
(обратная совместимость: только добавления таблиц/полей/индексов).

## Бэкап

Готовые скрипты (обёртки над docker compose, ротация последних 14 копий):

```bash
./scripts/backup.sh                       # дамп в ./backups/<дата>.dump
BACKUP_KEEP=30 ./scripts/backup.sh        # хранить 30
```

Расписание — системным cron на хосте (например, ежедневно в 03:00):

```cron
0 3 * * * /path/to/repo/scripts/backup.sh >> /var/log/embed-os-backup.log 2>&1
```

Ручной вариант и восстановление описаны ниже; есть скрипт-обёртка
`./scripts/restore.sh backups/embed-os-XXXX.dump`.

```bash
docker compose -f compose.prod.yaml exec postgres \
  pg_dump -U embed_os -d embed_os -Fc > "backup-$(date +%F).dump"
```

Расписание — системным cron на хосте (например, ежедневно в 03:00 с хранением
14 дней). Восстановление:

```bash
docker compose -f compose.prod.yaml stop api worker-placement-monitor \
  worker-weekly-report worker-report-digest worker-opportunity-sla \
  worker-sla-notification worker-radar-recheck worker-radar-sourcing
cat backup-2026-08-25.dump | docker compose -f compose.prod.yaml exec -T postgres \
  pg_restore -U embed_os -d embed_os --clean --if-exists
docker compose -f compose.prod.yaml start
```

## Размер образа vs функциональность Радара

`WITH_PLAYWRIGHT=1` (по умолчанию) ставит Chromium в образ API/воркеров — работает
L1-детекция видеостраниц Радара. Для компактного образа без headless-браузера:

```bash
WITH_PLAYWRIGHT=0 docker compose -f compose.prod.yaml up -d --build
```

и добавьте в `.env` строку `RADAR_L1_ENABLED=0`, чтобы инспектор не пытался
запускать браузер. Проверки L0 (HTML/sitemap/RSS/контакты) работают в обоих режимах.

## Диагностика

```bash
docker compose -f compose.prod.yaml ps                 # статусы и health
docker compose -f compose.prod.yaml logs -f api        # логи API
docker compose -f compose.prod.yaml logs -f worker-radar-recheck
```

Health endpoint всегда отвечает без аутентификации и показывает режим хранения;
`persistenceMode: "memory"` в production означать ошибку конфигурации — API в
таком режиме не стартует (защита в `main.ts`).

## Известные ограничения

- TLS терминируется вне стека (reverse-proxy хостинга или облачный LB);
  nginx внутри стека слушает HTTP на 80 порту внутренней сети.
- RabbitMQ publisher для transactional outbox остаётся за корпоративной
  конфигурацией брокера (README); события накапливаются в БД и доступны аудиту.
- Пароль `embed_os` в DATABASE_URL рассчитан на закрытый Docker-сеть хоста;
  при открытии Postgres наружу смените пароль в `x-db-env` и сервисе `postgres`.
