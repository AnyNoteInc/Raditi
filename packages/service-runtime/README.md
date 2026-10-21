# @repo/service-runtime

Общая Nest-обвязка приложений с базой — `core`, `llm`, `mcp` и `preview` (план 55): клиент и жизненный цикл Prisma, `/health` и токены внедрения. Запуск и остановка процесса, логгер и `.env` — в `@repo/app-bootstrap`; Redis, очереди и `/metrics` — только у `core` (`apps/core/src/infra/redis.ts`, `apps/core/src/metrics`; план 56). В отличие от остальных пакетов, которые отдают TypeScript-исходники, этот собирается в `dist` (`tsc`): в нём декораторы Nest, а Node их не вычищает. Типы и тесты читают исходники по условию `source`/`types`.

## Что даёт

- Основной вход: `createAppPrisma` и `PrismaLifecycle`; `DatabaseModule.forRoot(db)` — глобальный модуль с `PRISMA` и `PrismaLifecycle`: пул закрывается после остановки остальных модулей; `HealthController` (подробности — по токену, который приложение даёт под `HEALTH_DETAILS_TOKEN`; у `core` — значение `METRICS_TOKEN`) и `HealthModule.forRootAsync({ imports, inject, useFactory, details })` — `/health` по проверкам приложения; токены DI `PRISMA`, `SECRET_STORE`, `HEALTH_CHECKS`. `DatabaseModule.forRoot` вызывается в приложении один раз: Nest различает динамические модули по ссылке, второй вызов открыл бы второй пул.
- `./testing/fakes` — фейки базы, S3 и Vault для тестов приложений (в `dist` не попадает); фейки Redis и очередей — у `core` (`apps/core/src/testing/fakes.ts`).

## Что читает

Свои переменные пакет не объявляет: адреса и токены приходят из конфигурации приложения (`loadConfig`, `loadMcpConfig` и т. д.).

## Команды

- `pnpm --filter @repo/service-runtime build`, `typecheck`, `lint`, `test`. Пакет собирает `build` каждого приложения с базой (`pnpm --filter @repo/service-runtime build && nest build`).

## Чего не должно достигать

Только `domain`, `db` и `observability` (`service-runtime-tier`; сторож сети тестов из `@repo/app-bootstrap` — поддержка тестов). Не импортируют пакет `web`, `trpc`, `ui`, `auth`, `billing` и `notifications` (`web-no-role-runtime`), а раннер и пакеты, которые он запускает, не достигают его даже транзитивно (`runner-minimal-packages`).
