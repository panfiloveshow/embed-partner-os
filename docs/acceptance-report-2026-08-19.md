# Итоговая приёмка R0 — 19 августа 2026

Источник: ТЗ «Система автоматизации развития эмбедной сети RUTUBE», версия 1.0 от 17 августа 2026 года.

## Статус

Обязательный объём R0 реализован на 100%. Оставшиеся корпоративные значения — issuer/audience/JWKS и web SDK OIDC, ключ официального поставщика трафика, адрес notification gateway, egress allowlist и пилотная выборка — являются эксплуатационной конфигурацией конкретного стенда, а не незавершёнными функциями приложения.

## Матрица обязательного ядра

| Контур | Статус | Приёмочное подтверждение |
|---|---:|---|
| SSO, роли, scope, аудит | 100% | JWT/JWKS verifier, trusted proxy, 7 ролей, pre-provisioning OIDC identity, `own`/`assigned`/`team`/`all`, append-only AuditLog |
| Организации, домены, группы, контакты | 100% | единый реестр, M:N contact–organization, дедупликация, merge, archive/restore |
| Возможности и воронка | 100% | versioned stage machine S0–S10/SX/SL, minimum data, StageHistory, optimistic locking |
| Сегодня, задачи, взаимодействия, waiting | 100% | приоритетная очередь, причины, complete/reschedule, обязательный next step |
| SLA и эскалации | 100% | версионируемые пороги, incident/task, идемпотентная эскалация, HMAC webhook |
| Импорт CSV/XLSX | 100% | preview, create/update/skip/conflict, ручное разрешение, атомарный commit, построчный протокол |
| Радар и ЛПР | 100% | URL/CSV/XLSX, robots + SSRF guard, evidence, score, публичные контакты/ЛПР, Similarweb provider, accept/defer/reject/merge |
| Placement и L0 | 100% | lifecycle, безопасная iframe-проверка, history, retry/lease/DLQ, Alert и техническая Task |
| Партнёры и экспорт | 100% | фильтры, карточка 360°, scoped CSV, checksum и аудит выдачи |
| Воронка и отчёты | 100% | kanban/table, неизменяемый недельный snapshot, scheduler, подписанный digest |
| Надёжность фоновых процессов | 100% | transactional outbox, `SKIP LOCKED`, lease, backoff, идемпотентность |
| Русский адаптивный web-интерфейс | 100% | desktop/mobile представления, доступные имена элементов, обработка loading/error/retry |

## Проверки

- 18 миграций применены к чистому локальному PostgreSQL, seed завершён успешно.
- Реальный PostgreSQL API подтвердил области: менеджер с `own` не увидел чужие задачи; руководитель с `team` увидел 5 командных задач.
- Создание OIDC-пользователя в PostgreSQL и повтор с тем же ключом вернули один user; в базе создано ровно по одной записи AuditLog, OutboxEvent и завершённому IdempotencyRecord.
- Живой web-сценарий подтвердил кнопку «Добавить пользователя», валидацию формы, успешное создание и отображение роли/разрешений.
- Полный регрессионный прогон: 214 тестов, 45 файлов, без ошибок.
- Production build API, web, contracts и domain завершён без ошибок.

## Конфигурация запуска

Перед корпоративным развёртыванием заполнить `.env` по `.env.example`, применить `npm run db:migrate`, выполнить `npm run db:seed`, зарегистрировать OIDC subjects сотрудников через «Настройки → Роли и доступ», запустить API/web и требуемые worker-процессы. Traffic в Радаре показывается только при наличии официального `SIMILARWEB_API_KEY`; при отсутствии ключа система честно возвращает «нет данных».
