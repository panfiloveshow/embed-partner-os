# Runbook: сессия, роли и разрешения

## Контракт

`GET /api/v1/session` возвращает проверенную сервером учётную запись: OIDC subject, пользователя, роль, разрешения и область доступа. Поддерживаются роли из ТЗ: менеджер, руководитель, технический специалист, аналитик, юрист, администратор и наблюдатель.

API проверяет отдельные разрешения для чтения и мутаций. В частности, просмотр контактов (`contacts.view`) не даёт права их изменять (`contacts.write`), а просмотр партнёров (`partners.read`) не даёт права на экспорт (`partners.export`). Наблюдатель локального демо (`X-Embed-Actor: bootstrap:observer`) может читать доступные разделы, но получает `403 ACCESS_PERMISSION_DENIED` на мутации.

В PostgreSQL роль хранится как активное разрешение `role:<role>`, остальные права — как отдельные записи `UserPermission`. Seed выдаёт демонстрационному пользователю `role:admin`; администратор получает полный набор разрешений. Отказ известному PostgreSQL-пользователю записывается в append-only `AuditLog` как `access.denied`.

## Администрирование доступа

Экран `Настройки → Роли и доступ` использует `GET /api/v1/settings/access/users`, `POST /api/v1/settings/access/users` и `PATCH /api/v1/settings/access/users/:userId`. Все маршруты требуют `system.admin`; мутации дополнительно требуют `Idempotency-Key` и причину. Администратор заранее регистрирует точный OIDC `sub`, корпоративный email, команду и роль, поэтому неизвестная identity не получает доступ автоматически. Изменение существующей записи также требует актуальную `version` пользователя.

Роль задаёт рекомендуемый набор прав, после чего администратор может уточнить отдельные разрешения. Изменение статуса на `inactive` немедленно запрещает создание следующей сессии. Сервер не разрешает изменять собственную учётную запись или отключать/понижать последнего активного администратора. Успешная PostgreSQL-команда в одной транзакции создаёт либо версионирует `user_account`, записывает `UserPermission`, создаёт `settings.access.user-created` или `settings.access.user-updated` в AuditLog и OutboxEvent и завершает IdempotencyRecord.

Перед включением PostgreSQL-режима примените миграцию `20260819150000_user_access_admin`, добавляющую optimistic-locking версию учётной записи.

## Режимы аутентификации

`AUTH_MODE=development` разрешён только вне production. Запрос без identity получает демонстрационную сессию `bootstrap:anna.sokolova`, а `X-Embed-Actor: bootstrap:observer` позволяет проверить read-only роль.

В production выберите один режим:

1. `AUTH_MODE=trusted_proxy` и `TRUSTED_IDENTITY_HEADER=true`. Auth-proxy проверяет корпоративную OIDC-сессию, удаляет входящий клиентский `X-Embed-Actor`, записывает проверенный `sub` и закрывает прямой сетевой доступ к API.
2. `AUTH_MODE=oidc_jwt`. API принимает только `Authorization: Bearer <JWT>` и игнорирует `X-Embed-Actor`. Обязательны `OIDC_ISSUER`, `OIDC_AUDIENCE` и HTTPS `OIDC_JWKS_URL`. Допустимые алгоритмы ограничены `RS256`, `PS256`, `ES256`; default — `RS256`. Проверяются подпись, issuer, audience, `sub`, `iat`, `exp` и время действия.

Публичный JWKS кэшируется в памяти, имеет cooldown 30 секунд, максимальный возраст 10 минут и настраиваемый таймаут `OIDC_JWKS_TIMEOUT_MS`. JWKS URL должен быть доверенной эксплуатационной конфигурацией с egress allowlist. Ошибка конфигурации возвращает `503 IDENTITY_CONFIGURATION_ERROR`, отсутствующая или недействительная identity — `401 AUTHENTICATION_REQUIRED`.

Web-клиент в production запускается с `VITE_AUTH_MODE=external` и получает access token от корпоративной auth-оболочки через `window.embedPartnerAuth`. Токен хранится только в памяти, не в `localStorage` или `sessionStorage`. После `401` API-клиент один раз запрашивает refresh у оболочки и повторяет запрос. Если refresh не помог, показывается экран повторного входа. Выход из sidebar вызывает метод оболочки `logout()`.

Оболочка должна определить bridge до загрузки web-bundle:

```ts
window.embedPartnerAuth = {
  getAccessToken: ({ forceRefresh } = {}) => corporateOidc.getToken({ forceRefresh }),
  login: () => corporateOidc.login(),
  logout: () => corporateOidc.logout(),
  subscribe: (listener) => corporateOidc.subscribe(listener),
};
```

В `development` bridge не нужен; API возвращает демонстрационную сессию. В production отсутствующий bridge явно показывает ошибку конфигурации и не запускает запросы без identity.

## Область данных PostgreSQL

После проверки guard сохраняет actor в изолированном request context. Все PostgreSQL-адаптеры используют его как автора команд и ключ idempotency. `own` и `assigned` ограничивают рабочие сущности текущим владельцем, `team` — командой пользователя, `all` — всеми командами. Связанные контакты и организации проверяются через ту же область; недоступная запись отвечает как отсутствующая и не раскрывает её существование. Фоновые worker-процессы без HTTP-сессии используют системного actor и глобальную область.

## Production-gates

- получить production issuer, client ID, redirect URI, групповые claims и подключить конкретный OIDC SDK к `window.embedPartnerAuth`;
- проверить PostgreSQL/OIDC/concurrency, append-only аудит отказов и попытки обхода proxy на тестовом стенде.

## Проверка

```bash
curl http://127.0.0.1:3000/api/v1/session

curl -X POST http://127.0.0.1:3000/api/v1/tasks/task-11/reschedule \
  -H 'X-Embed-Actor: bootstrap:observer' \
  -H 'Idempotency-Key: observer-denied-check' \
  -H 'Content-Type: application/json' \
  -d '{"dueAt":"2026-08-27T12:00:00+03:00","reason":"Проверка запрета"}'
```

Первый запрос должен вернуть роль `admin`; второй — `403 ACCESS_PERMISSION_DENIED` без изменения задачи.

Проверка матрицы и версионной команды:

```bash
curl http://127.0.0.1:3000/api/v1/settings/access/users

curl -X PATCH http://127.0.0.1:3000/api/v1/settings/access/users/00000000-0000-4000-8000-000000000005 \
  -H 'Idempotency-Key: access-user-update-0001' \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"status":"active","role":"analyst","permissions":["today.read","partners.read","reports.view"],"reason":"Перевод в аналитическую функцию"}'
```

Проверка direct JWT режима выполняется на тестовом стенде с реальным токеном:

```bash
AUTH_MODE=oidc_jwt NODE_ENV=production npm run start -w @embed-os/api

curl http://127.0.0.1:3000/api/v1/session \
  -H "Authorization: Bearer $OIDC_ACCESS_TOKEN"
```

Запрос без Bearer, с истёкшим токеном, другим `aud`, другим `iss` и поддельным `X-Embed-Actor` должен вернуть 401.
