# Радар кандидатов

Экран «Радар» закрывает RAD-001…009 и AC-08: менеджер добавляет URL вручную либо загружает CSV/XLSX, получает evidence и объяснимый Partner Score, затем принимает, откладывает, отклоняет или объединяет кандидата с обязательной причиной.

## Ручной ввод и импорт

Ручная форма принимает название сайта, публичный HTTP(S)-домен/URL и источник. Дополнительно можно указать тематику, язык, географию, частоту публикаций, CMS, наличие контакта, диапазон видеостраниц и оценку трафика.

CSV/XLSX использует совместимый минимальный шаблон:

```csv
organization_name,domain,source,segment
Пример Медиа,https://example.ru/video,Публичный каталог,Новости
```

Файл ограничен 10 МБ и 10 000 строками. Повтор домена внутри файла пропускается. Технические поддомены `admin`, `api`, `assets`, `cdn`, `dev`, `internal`, `preview`, `stage`, `staging`, `static` и `test` отклоняются. Совпадение с активной Organization или кандидатом помечается как дубль, снижает score и блокирует создание новой Organization.

## Проверка страницы

`POST /api/v1/radar/candidates/:id/checks` выполняется асинхронно: эндпоинт только помечает кандидата (`inspectionPending: true`) и сразу отвечает `202` с текущим состоянием, поэтому медленный или вредоносный сайт не блокирует API. Сама инспекция выполняется в фоне: в PostgreSQL-режиме её подхватывает worker `radar-recheck` (запрошенные проверки имеют приоритет над плановыми), в dev/in-memory-режиме — фоновое выполнение в том же процессе. Результат появляется в `GET /api/v1/radar/candidates`, когда `inspectionPending` снова становится `false`; фронтенд поллит очередь каждые ~3 секунды до ~2 минут.

Инспекция проверяет HTTP(S), DNS/IP и каждый redirect; запрещает private, loopback, link-local, metadata, multicast и IPv4-mapped IPv6; читает `robots.txt` без cookies/credentials; ограничивает redirects пятью, запрос 15 секундами и ответ 5 МБ. Evidence сохраняется даже для `not_found`, `blocked` и `unknown`; сырой HTML не хранится.

После основной страницы Радар исследует до трёх бизнес-страниц, объявленные same-origin sitemap (включая один уровень sitemap index) и RSS/Atom. В выборку попадает не более 12 HTML-страниц за запуск; внешние URL из XML игнорируются, все вторичные запросы проходят ту же SSRF-защиту и правила robots.txt. В досье сохраняются размер найденного множества, фактическое покрытие, видеостраницы, частота публикаций, CMS, ЛПР, публичные каналы и confidence каждого сигнала.

Блок «Почему сейчас» раскрывает фактические причины приоритета. «Потенциал» объединяет официальную оценку Similarweb и наблюдаемую долю видеостраниц; без ключа `SIMILARWEB_API_KEY` трафик и производные возможности явно остаются неизвестными. «Первое касание» — локальный черновик: копирование не отправляет письмо и не создаёт внешнюю коммуникацию.

## Плановая перепроверка

В PostgreSQL-режиме отдельный worker сначала выполняет запрошенные через API проверки (`inspection_requested_at`), а затем повторно исследует кандидатов `READY` и наступившие `DEFERRED`, если у них нет свежего evidence. Стабильный ключ временного слота (для запрошенных проверок — ключ от времени запроса) защищает запись результата от дублей. Без запущенного worker запрошенные проверки в PostgreSQL-режиме не выполняются. Новые ЛПР, каналы, рост трафика и рост числа видеостраниц сохраняются как change signals и поднимаются в «Почему сейчас».

```bash
PERSISTENCE_MODE=postgres npm run worker:radar-recheck
```

Настройки: `RADAR_RECHECK_INTERVAL_HOURS` (168), `RADAR_RECHECK_POLL_MS` (3600000), `RADAR_INSPECTION_POLL_MS` (15000 — частота подхвата запрошенных проверок), `RADAR_RECHECK_BATCH_SIZE` (25), `RADAR_RECHECK_RUN_ONCE` (0/1).

## Score и решения

Score раскрывается по группам и факторам. Ручная поправка хранится отдельно и всегда требует комментария. Решение использует актуальную `version` кандидата и обязательный `Idempotency-Key`.

- `accept` требует evidence и отсутствия дубля активной Organization;
- `defer` требует `deferUntil`;
- `reject` сохраняет причину и комментарий;
- `merge` требует другого существующего кандидата.

После `accept` в одной транзакции создаются Organization, Domain, Opportunity S0 и первая Task «Исследовать кандидата из Радара».

## API

- `GET /api/v1/radar/candidates`;
- `POST /api/v1/radar/candidates`;
- `POST /api/v1/radar/candidates/import` (`multipart/form-data`, поле `file`);
- `POST /api/v1/radar/candidates/:id/checks` — асинхронно, отвечает `202` и `inspectionPending: true`;
- `POST /api/v1/radar/candidates/:id/score-adjustments`;
- `POST /api/v1/radar/candidates/:id/decisions`.

Конфликт версии возвращает `409 RADAR_CANDIDATE_VERSION_CONFLICT` и `currentVersion`; нарушение бизнес-правила — `422` с `fieldErrors`.

## Проверка

```bash
npm run db:validate
npm run typecheck
npm test
npm run build
```

Для PostgreSQL дополнительно применить миграции, выполнить seed и пройти сценарии `accept`, stale version и повтор того же idempotency key. Browser QA проверяется на desktop и 390×844 без горизонтального overflow.
