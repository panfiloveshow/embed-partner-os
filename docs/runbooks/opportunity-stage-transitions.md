# Runbook: переходы стадий Opportunity

## Команда перехода

Стадия меняется только проверяемой командой с текущей версией и ключом идемпотентности:

```bash
curl -X POST http://127.0.0.1:3000/api/v1/opportunities/OPPORTUNITY_ID/stage-transitions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: stage-transition-20260818-0001' \
  -d '{"version":1,"toStageCode":"S8","reason":"Обязательные проверки интеграции пройдены","stageData":{"pilotStartsAt":"2026-08-20T10:00:00+03:00","pilotEndsAt":"2026-09-03T10:00:00+03:00","successCriteria":"Плеер доступен минимум в 99% L0-проверок","pilotReviewAt":"2026-08-27T10:00:00+03:00","metricsSource":"RUTUBE Analytics"}}'
```

Повтор того же ключа и нормализованной команды возвращает исходный результат. Другой payload с тем же ключом возвращает `409 IDEMPOTENCY_KEY_REUSED`. Устаревшая версия возвращает `409 OPPORTUNITY_VERSION_CONFLICT` и `currentVersion`.

## Обязательные данные BR-003

Специфичные сведения передаются в `stageData`, объединяются с уже сохранёнными данными Opportunity и записываются атомарно с переходом. Связанные факты не дублируются в JSON: основной домен и тематика читаются из Organization, владелец и следующее действие — из Opportunity/Task, контакт — из Interaction/Contact, запуск — из Placement.

- `S1`: `geography`, `videoPlayerType`, `dataSource`, `researchCheckedAt` плюс основной домен и тематика организации;
- `S2`: `priorityReason`, `rutubeUseCase` плюс рассчитанный Score, владелец и следующая Task;
- `S3`: зафиксированные контакт/канал, дата, тип, результат взаимодействия и следующий шаг;
- `S4`: `need`, `stakeholders[]`, `objections`, `agreedDueAt`;
- `S7`: `testUrl`, `technicalContact`, `embedType`, `integrationChecklist[]`, `launchDueAt`;
- `S8`: `pilotStartsAt`, `pilotEndsAt`, `successCriteria`, `pilotReviewAt`, `metricsSource`;
- `S9`: активный Placement, `launched_at`, ответственный и успешная L0-проверка;
- `SL`: причина, комментарий, возврат/«не возвращать»; `competitorAlternative` передаётся при наличии.

При ошибке API возвращает `422 application/problem+json`, `code=BR-003` (для `S9` — `BR-007`) и `fieldErrors` с отдельной записью для каждого недостающего факта. Команда ничего не меняет.

## Допустимые переходы

- рабочая стадия `S0…S8` → следующая стадия, `SX` или `SL`;
- `S9` → `S10` или `SX`;
- `S10` → `SX`;
- `SX` → стадия, из которой возможность была приостановлена, либо `SL`;
- из `SL` переходы запрещены — для повторного запуска создаётся новая Opportunity.

Переход в `S9` разрешён только при наличии неархивного активного Placement с `launched_at`, успешной L0-проверкой и `health_status=healthy`. Технический риск сам стадию не меняет.

## Пауза

```json
{
  "version": 2,
  "toStageCode": "SX",
  "reason": "Решение партнёра",
  "pauseReason": "Нет ресурса на интеграцию в текущем квартале",
  "reviewAt": "2026-09-01T10:00:00+03:00"
}
```

`reviewAt` обязан быть в будущем. Ближайшая открытая Task превращается в задачу пересмотра на эту дату, а Opportunity получает статус `PAUSED`.

## Закрытие без запуска

```json
{
  "version": 2,
  "toStageCode": "SL",
  "reason": "Зафиксирован отказ",
  "closeReason": "Коммерческие условия",
  "closeComment": "Партнёр не согласовал модель размещения",
  "returnAt": "2026-11-18T10:00:00+03:00"
}
```

Вместо `returnAt` можно передать `"neverReturn": true`, но не оба поля одновременно. При закрытии открытые задачи отменяются, `next_task_id` очищается.

## Атомарность

В PostgreSQL одной serializable-транзакцией выполняются optimistic update Opportunity вместе с `stage_data`, изменение связанной Task, добавление StageHistory и AuditLog, публикация `opportunity.stage_changed` в transactional outbox и завершение IdempotencyRecord. StageHistory и AuditLog остаются append-only.

Перед production необходимо прогнать транзакционные сценарии на реальной PostgreSQL: гонку перехода с завершением Task, повтор команды после потери ответа и rollback после ошибки записи outbox.
