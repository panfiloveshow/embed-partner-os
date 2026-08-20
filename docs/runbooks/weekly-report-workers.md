# Runbook: недельный отчёт и digest

## Назначение

Два worker-процесса закрывают расписание понедельника 10:00 MSK отдельно от HTTP API. Оба требуют PostgreSQL; in-memory режим намеренно запрещён, поскольку не обеспечивает восстановление после перезапуска.

## Обязательная конфигурация

- `PERSISTENCE_MODE=postgres`
- `DATABASE_URL` — PostgreSQL Embed Partner OS
- `PUBLIC_APP_URL` — публичный адрес web-интерфейса без credentials
- `REPORT_DIGEST_WEBHOOK_URL` — HTTP(S) endpoint корпоративного notification gateway
- `REPORT_DIGEST_WEBHOOK_SECRET` — отдельный случайный секрет не короче 32 символов
- `REPORT_DIGEST_RECIPIENTS` — адресаты через запятую

Опционально задаются `WEEKLY_REPORT_FORMULA_VERSION`, `REPORT_DIGEST_POLL_MS`, `REPORT_DIGEST_BATCH_SIZE`, `REPORT_DIGEST_TIMEOUT_MS` и уникальный `OUTBOX_WORKER_ID`.

## Запуск

После применения миграций и seed:

```bash
npm run worker:weekly-report
npm run worker:report-digest
```

Для одноразовой эксплуатационной проверки используйте отдельные процессы с `WEEKLY_REPORT_RUN_ONCE=1` и `REPORT_DIGEST_RUN_ONCE=1`. Повтор безопасен: расписание имеет стабильный ключ, а gateway получает `OutboxEvent.id` в заголовке `Idempotency-Key`.

## Контракт notification gateway

Worker отправляет `POST application/json` со следующими полями: `messageId`, `recipients`, `subject`, `reportUrl`, `team`, `period`, `revision`, `exceptionCount` и `items`. `items` содержит до семи управленческих решений и рисков. Каждый запрос несёт `X-Embed-Timestamp`, `X-Embed-Message-Id` и `X-Embed-Signature: sha256=<hex>`. Gateway обязан отклонять слишком старый timestamp и проверять HMAC-SHA256 строки `<timestamp>.<messageId>.<raw body>` секретом `REPORT_DIGEST_WEBHOOK_SECRET`. Успехом считается любой HTTP 2xx; остальные статусы и таймаут повторяются через outbox backoff.

## Диагностика

- `weekly-report.generated` — снимок создан либо идемпотентно переиспользован.
- `weekly-report.waiting` — указан следующий слот запуска в UTC.
- `report-digest.batch` — содержит `claimed`, `published` и `failed`.
- В `outbox_event.last_error` хранится последняя транспортная ошибка, а `next_attempt_at` — время следующей попытки.

Перед production необходимо проверить конкурентный claim на реальном PostgreSQL, восстановление после остановки между отправкой и acknowledge, а также фактическую дедупликацию корпоративного gateway.
