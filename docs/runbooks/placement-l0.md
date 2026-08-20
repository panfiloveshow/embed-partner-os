# Runbook: Placement и L0-мониторинг

## Регистрация

```bash
curl -X POST http://127.0.0.1:3000/api/v1/placements \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: placement-register-20260818-0001' \
  -d '{"organizationId":"...","opportunityId":"...","pageUrl":"https://partner.example/article","embedType":"video","environment":"production","businessStatus":"active","launchedAt":"2026-08-18T08:00:00+03:00"}'
```

Организация и возможность должны совпадать и принадлежать доступной команде. Для активного размещения обязательна дата запуска.

## Жизненный цикл и архив

Изменение параметров или бизнес-статуса требует актуальную `version`, явную причину и отдельный ключ идемпотентности:

```bash
curl -X PATCH http://127.0.0.1:3000/api/v1/placements/PLACEMENT_ID \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: placement-update-20260818-0001' \
  -d '{"version":1,"businessStatus":"paused","reason":"Пауза по запросу партнёра"}'
```

`planned`, `paused` и `ended` обнуляют `next_check_at` и снимают lease планового worker. Возврат в `active` либо изменение URL/среды ставит немедленную проверку. Устаревшая версия возвращает `409 PLACEMENT_VERSION_CONFLICT` с `currentVersion`.

Мягкое архивирование также защищено версией и не удаляет историю:

```bash
curl -X POST http://127.0.0.1:3000/api/v1/placements/PLACEMENT_ID/archive \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: placement-archive-20260818-0001' \
  -d '{"version":2,"reason":"Размещение демонтировано"}'
```

Обе команды атомарно сохраняют AuditLog и OutboxEvent. При завершении или архивировании открытый технический Alert и связанная Task закрываются; архивная запись исключается из рабочих API, но остаётся в PostgreSQL для будущего административного восстановления.

## Проверка

```bash
curl -X POST http://127.0.0.1:3000/api/v1/placements/PLACEMENT_ID/l0-checks \
  -H 'Idempotency-Key: placement-check-20260818-0001'
```

История доступна через `GET /api/v1/placements/PLACEMENT_ID/checks`, реестр — через `GET /api/v1/placements`.

`blocked` означает policy/SSRF/403/429, `unknown` — недоказанный сетевой результат, `failed` — подтверждённое отсутствие iframe или ошибку доступного embed URL. Только две последовательные `failed` открывают технический Alert.

## Плановый worker

После применения миграций запустите отдельный процесс:

```bash
PERSISTENCE_MODE=postgres npm run worker:placement-monitor
```

Для smoke-запуска одной пачки установите `PLACEMENT_MONITOR_RUN_ONCE=1`. Период опроса, размер пачки, lease и лимит попыток задаются через `PLACEMENT_MONITOR_POLL_MS`, `PLACEMENT_MONITOR_BATCH_SIZE`, `PLACEMENT_MONITOR_LEASE_MS` и `PLACEMENT_MONITOR_MAX_ATTEMPTS`.

Каждая due-запись захватывается через `FOR UPDATE SKIP LOCKED`. Просроченная lease может быть перезахвачена. Один `monitor_job_key` сохраняется на всех retry одного планового запуска, поэтому потеря ответа не создаст дубль `HealthCheck`.

При ошибке проверки worker планирует retry с экспоненциальной задержкой от 1 до 45 минут. После исчерпания попыток запись получает `monitor_dead_at` и больше не claim-ится.

### Dead-letter

Просмотр неразобранных записей:

```sql
SELECT id, page_url, monitor_attempts, monitor_last_error, monitor_dead_at
FROM placement
WHERE monitor_dead_at IS NOT NULL
ORDER BY monitor_dead_at;
```

После устранения причины одну запись можно вернуть в очередь, сохранив её idempotency key:

```sql
UPDATE placement
SET monitor_dead_at = NULL,
    monitor_attempts = 0,
    monitor_last_error = NULL,
    next_check_at = CURRENT_TIMESTAMP
WHERE id = 'PLACEMENT_UUID' AND monitor_dead_at IS NOT NULL;
```

Перед production необходимо применить миграцию на копии обезличенных данных, проверить два конкурентных worker-процесса и lease recovery, прогнать DNS rebinding/redirect на изолированном стенде и настроить создание будущих месячных partitions до перемещения строк из default partition.
