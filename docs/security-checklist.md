# Чек-лист безопасности Embed Partner OS

Дата: 2026-08-25. Предназначен для службы безопасности заказчика и внутренней
приёмки перед продажей/внедрением.

## Встроенные механизмы (проверяются автотестами)

| Область | Механизм | Где смотреть |
| --- | --- | --- |
| Аутентификация | Проверяемая сервером сессия; три production-режима: `trusted_proxy` (закрытый контур + auth-оболочка), `oidc_jwt` (Bearer JWT через JWKS, issuer/audience/asimметричный алгоритм), локальный вход по паролю | `apps/api/src/auth/access-control.ts`, `auth/local-auth.ts` |
| Пароли | scrypt со случайной солью, сравнение за постоянное время, минимум 8 символов; hash не покидает БД | `auth/local-auth.ts` (`hashPassword`/`verifyPassword`) |
| Локальные сессии | HS256 JWT, issuer+audience, TTL 12 часов, секрет ≥32 символов (иначе старт невозможен) | `auth/local-auth.ts`, `auth/auth-base.ts` |
| Перебор паролей | Rate-limit входа: ≤10 попыток на email в минуту | `AuthController.login` |
| Авторизация | 7 ролей, точечные разрешения на каждый контур, scope `own/assigned/team/all` на уровне SQL-запросов | `auth/access-control.ts`, runbook access-control.md |
| Защита от self-lockout | Запрет отключения последнего администратора и самого себя без замены | `access-administration.service.ts` |
| Аудит | Append-only AuditLog (UPDATE/DELETE запрещены триггером БД) на каждую мутацию, включая отказы в доступе | миграции, `problem-details.filter.ts` |
| Идемпотентность | Обязательный `Idempotency-Key` на мутациях; повтор с другим payload → 409 | `application/idempotency.ts` |
| SSRF | SafeHttpClient: белый список схем/портов, запрет приватных IP, редиректы под контролем — для L0-проверок Радара и Similarweb | `monitoring/safe-http-client.ts` |
| Вебхуки | HMAC-SHA256 подпись (`X-Embed-Signature`), timestamp, message-id | `outbox/webhook-signature.ts` |
| Целостность отчётов | Неизменяемые ReportSnapshot (append-only), воспроизводимый payload, версия формул | runbook weekly-report-workers.md |
| Конфигурационные ворота | `NODE_ENV=production` запрещает memory-режим и `AUTH_MODE=development`; Swagger выключен в prod | `main.ts` |
| CORS | Явный allowlist через `CORS_ORIGINS`; dev-паттерн только для localhost | `main.ts` |
| Health | `/api/v1/health` публичен, раскрывает только режим/аптайм/время | `health.controller.ts` |

## Зависимости

- `npm audit --omit=dev`: 0 критических/средних в рантайм-зависимостях.
- 4 high — цепочка Prisma **CLI** (dev-инструмент миграций): отсутствует в
  runtime-образе; детали и план снятия — `docs/dependency-audit.md`.

## Ответственность развёртывания (вне кода)

1. TLS-терминация на границе (LB/reverse-proxy); внутри стека HTTP по
   изолированной Docker-сети.
2. Секреты (`LOCAL_AUTH_SECRET`, `*_WEBHOOK_SECRET`, TELEGRAM_BOT_TOKEN,
   пароль БД) хранить в secret-manager хостинга; в репозиторий не попадают
   (`.env` в `.gitignore`).
3. Postgres наружу не публиковать; при необходимости — смена пароля в
   compose и DATABASE_URL.
4. Регулярные бэкапы: `scripts/backup.sh` по cron (хранение по умолчанию 14).
5. Обновления зависимостей: пересборка образов `docker compose up -d --build`;
   контроль `npm audit` при каждом обновлении.

## Что НЕ входит в текущий объём (честно)

- Независимый внешний пентест — рекомендуется перед крупной сделкой;
  код готов предоставить тестовый стенд из compose.prod.yaml.
- SSO через конкретные облачные IdP (Okta/Azure AD) — подключается через
  стандартный режим `oidc_jwt` без изменений кода; конфигурация — на стороне
  заказчика.
