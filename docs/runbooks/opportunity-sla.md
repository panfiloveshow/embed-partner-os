# Runbook: контроль SLA возможностей

## Назначение

Два независимых worker-процесса реализуют BR-004, BR-005, AC-05 и AC-06. `opportunity-sla-worker` выявляет зависшие активные возможности, создаёт ответственному задачу и управляет жизненным циклом инцидента. `sla-notification-worker` доставляет предупреждения владельцам и эскалации руководителям через transactional outbox.

Оба процесса требуют `PERSISTENCE_MODE=postgres`. In-memory режим намеренно не поддерживается: он не даёт транзакционной идемпотентности и восстановления после перезапуска.

## Пороговые значения

Конфигурация хранится в опубликованной версии `ProcessDefinition.schema_json`:

```json
{
  "sla": {
    "escalationAfterDays": 3,
    "thresholds": {
      "S0": 2,
      "S1": 2,
      "S2": 3,
      "S3": 3,
      "S4": 5,
      "S5": 5,
      "S6": 5,
      "S7": 7,
      "S8": 7,
      "S9": 14,
      "S10": 14
    }
  }
}
```

Менять опубликованную схему на месте нельзя. Администратор открывает «Настройки → Настройки SLA», задаёт пороги, срок эскалации и обязательную причину изменения. Система идемпотентно создаёт новую версию `ProcessDefinition`, пишет аудит и переводит на неё действующие незакрытые возможности текущей версии. Уже открытый инцидент продолжает использовать зафиксированные при создании пороги. Встроенные значения служат безопасным fallback для исторических схем без секции `sla`.

API экрана: `GET /api/v1/settings/sla` и `PATCH /api/v1/settings/sla`. Оба маршрута требуют `system.admin`, а мутация также требует актуальную `version` и `Idempotency-Key`.

## Жизненный цикл

Маркер последней активности — самая поздняя дата из создания Opportunity, последнего Interaction и последнего StageHistory. Контролируется только статус `ACTIVE`:

1. После достижения порога стадии создаётся открытый `OpportunitySlaIncident`, Task типа `sla_reaction` с приоритетом 95 и событие `opportunity.stale` для владельца.
2. Если владелец не восстановил активность за `escalationAfterDays`, инцидент получает `escalated_at`, а событие `opportunity.sla_escalated` уходит руководителям.
3. Новое Interaction, смена стадии либо переход в `WAITING`, `PAUSED` или `CLOSED` переводит инцидент в `resolved` и отменяет ещё открытую системную Task.
4. Эскалированный открытый инцидент отображается в следующем недельном отчёте как риск высокой важности. Обычный семидневный `stage-stall` для той же возможности не дублируется.

Уникальность `(opportunity_id, activity_marker_at)` и условные обновления защищают от повторных Task и эскалаций при конкурентных запусках. Outbox отправляется at-least-once, поэтому notification gateway обязан дедуплицировать запросы по заголовку `Idempotency-Key`, равному `OutboxEvent.id`.

## Конфигурация процессов

Обязательные значения:

- `PERSISTENCE_MODE=postgres`;
- `DATABASE_URL`;
- `PUBLIC_APP_URL` — публичный адрес web-интерфейса;
- `SLA_NOTIFICATION_WEBHOOK_URL` — HTTP(S) endpoint notification gateway;
- `SLA_NOTIFICATION_WEBHOOK_SECRET` — отдельный случайный секрет не короче 32 символов;
- `SLA_ESCALATION_RECIPIENTS` — адреса руководителей через запятую.

Notification gateway проверяет `X-Embed-Timestamp` и `X-Embed-Signature: sha256=<hex>` как HMAC-SHA256 строки `<timestamp>.<X-Embed-Message-Id>.<raw body>` секретом `SLA_NOTIFICATION_WEBHOOK_SECRET`, отклоняет просроченные запросы и дедуплицирует их по `Idempotency-Key`.

Опционально задаются `SLA_MONITOR_POLL_MS`, `SLA_MONITOR_BATCH_SIZE`, `SLA_NOTIFICATION_POLL_MS`, `SLA_NOTIFICATION_BATCH_SIZE`, `SLA_NOTIFICATION_TIMEOUT_MS` и уникальный `SLA_NOTIFICATION_WORKER_ID`.

## Запуск и smoke-проверка

После применения миграций и seed запустите отдельные процессы:

```bash
npm run worker:opportunity-sla
npm run worker:sla-notification
```

Для одной итерации установите `SLA_MONITOR_RUN_ONCE=1` и `SLA_NOTIFICATION_RUN_ONCE=1`. В журнале monitor появляются только пачки с изменениями: `opportunity-sla.batch` содержит `scanned`, `opened`, `escalated`, `resolved`; доставка пишет `sla-notification.batch` с `claimed`, `published`, `failed`.

Проверка приёмки:

1. Создать активную Opportunity с маркером активности старше порога и выполнить monitor один раз.
2. Убедиться, что созданы ровно один открытый инцидент, одна Task и одно событие `opportunity.stale`.
3. Повторить monitor и убедиться, что количества не изменились.
4. Сдвинуть время тестового стенда за срок эскалации, выполнить monitor и проверить ровно одно событие `opportunity.sla_escalated`.
5. Повторить запуск — второй эскалации быть не должно.
6. Добавить Interaction либо изменить статус, выполнить monitor и проверить `status=resolved` и отмену открытой SLA-задачи.
7. Сформировать недельный снимок и проверить `sla-escalation` в `payload.funnel.topStalls` и `payload.exceptions`.

Перед production обязательны прогон миграции на копии обезличенных данных, конкурентный тест нескольких monitor/notification workers, проверка дедупликации gateway, реальные списки получателей и мониторинг возраста необработанных outbox-событий.
