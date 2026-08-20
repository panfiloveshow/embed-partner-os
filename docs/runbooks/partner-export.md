# Runbook: permissioned CSV-экспорт партнёров

## Контракт PRT-008

`POST /api/v1/partners/exports` принимает JSON с теми же фильтрами, что `GET /api/v1/partners`, и возвращает `text/csv; charset=utf-8`. Выгрузка содержит только организации команды actor и не ограничивается UI-лимитом 200 строк.

Доступ разрешён только активному `User` с неотозванной записью `UserPermission(permission="partners.export")`. Отсутствующая identity даёт 401, отсутствующее право — 403.

## Доверенная граница

Экспорт проходит через общий access-control guard. В `AUTH_MODE=oidc_jwt` API самостоятельно проверяет Bearer JWT и полностью игнорирует `X-Embed-Actor`. В `AUTH_MODE=trusted_proxy` API не должен быть доступен из публичной сети в обход auth-proxy. Прокси обязан:

- проверить корпоративную OIDC-сессию;
- удалить любой `X-Embed-Actor`, полученный от клиента;
- записать в `X-Embed-Actor` проверенный OIDC `sub`;
- ограничить сетевой доступ к API только адресами proxy и workers.

После этого API запускается с `NODE_ENV=production`, `AUTH_MODE=trusted_proxy` и `TRUSTED_IDENTITY_HEADER=true`. Без корректного режима production-экспорт закрыт с кодом 503. Конфигурация direct JWT описана в `access-control.md`.

## Аудит и безопасность файла

Перед успешным ответом PostgreSQL-адаптер записывает `partner.registry.export` в `AuditLog`: actor, permission, набор фильтров, число строк, имя, SHA-256 checksum и время. Триггер `audit_log_append_only` запрещает `UPDATE` и `DELETE`. ID записи возвращается в `X-Export-Audit-Id`; история доступна через `GET /api/v1/partners/exports/audit` с тем же правом.

CSV использует UTF-8 BOM, `;`, CRLF и кавычки для всех ячеек. Значения, начинающиеся с `=`, `+`, `-` или `@`, экранируются апострофом для защиты от spreadsheet formula injection. Ответ содержит `Cache-Control: no-store` и `X-Content-Type-Options: nosniff`.

## Проверка

```bash
npm test
npm run typecheck
npm run build
```

Ручной smoke-сценарий: выбрать Score 70+ и статус интеграции, нажать «Экспорт CSV», сверить строки файла с таблицей и найти показанный audit ID через audit endpoint. В OIDC-режиме повторить запрос без Bearer-токена и с пользователем без `partners.export`, ожидая 401 и 403.
