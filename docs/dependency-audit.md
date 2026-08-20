# Аудит npm-зависимостей

Дата проверки: 2026-08-19.

## Результат

- Безопасный `npm audit fix --omit=dev` обновил `@nestjs/swagger` до 11.4.7 и `js-yaml` до 5.3.0.
- Критических, средних и низких проблем аудит не показывает.
- Остаются четыре high-предупреждения в цепочке `prisma -> @prisma/config -> effect/deepmerge-ts`. В lock-файле эти пакеты помечены `devOptional` и используются Prisma CLI для generate/validate/migrate, а не кодом HTTP API.
- Предложенный npm автофикс требует `--force` и откат Prisma 6.19.0 до 6.12.0, поэтому он не применён.

## Контроль

- Не включать Prisma CLI в финальный runtime-образ; generate и migrate выполнять на build/deploy-этапе.
- Не передавать Prisma CLI недоверенные конфигурации или рекурсивные объекты.
- Повторять `npm audit --omit=dev` при каждом обновлении Prisma и снять исключение, как только upstream выпустит совместимое исправление.

## Команды проверки

```bash
npm audit --omit=dev
npm explain effect
npm explain deepmerge-ts
```
