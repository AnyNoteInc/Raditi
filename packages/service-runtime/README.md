# @repo/service-runtime

Общая Nest-обвязка приложений с базой — `core`, `llm`, `mcp` и `preview` (план 55): клиент и жизненный цикл Prisma, `/health`, `/metrics` и токены внедрения. Запуск и остановка процесса, логгер и `.env` — в `@repo/app-bootstrap`; Redis — только у `core` (`apps/core/src/infra/redis.ts`). В отличие от остальных пакетов, которые отдают TypeScript-исходники, этот собирается в `dist` (`tsc`): в нём декораторы Nest, а Node их не вычищает. Типы и тесты читают исходники по условию `source`/`types`.

## Что даёт

- Основной вход: `createAppPrisma` и `PrismaLifecycle`, `HealthController` (подробности — по `METRICS_TOKEN`), `MetricsController` с `MetricsTokenGuard`, `MetricsRegistryModule.forApp(<имя контейнера>)` — реестр Prometheus с меткой `app`, токены DI (`PRISMA`, `OBJECT_STORAGE`, `SECRET_STORE`, `HEALTH_CHECKS`, `METRICS_REGISTRY`, `METRICS_TOKEN`, `BACKGROUND_JOBS`).
- `./testing/fakes` — фейки инфраструктуры для тестов приложений (в `dist` не попадает).

## Что читает

Свои переменные пакет не объявляет: адреса, порты и `METRICS_TOKEN` приходят из конфигурации приложения (`loadConfig`, `loadLlmConfig` и т. д.).

## Команды

- `pnpm --filter @repo/service-runtime build`, `typecheck`, `lint`, `test`. Пакет собирает `build` каждого приложения с базой (`pnpm --filter @repo/service-runtime build && nest build`).

## Чего не должно достигать

Только `domain`, `db` и `observability` (`service-runtime-tier`; сторож сети тестов из `@repo/app-bootstrap` — поддержка тестов). Не импортируют пакет `web`, `trpc`, `ui`, `auth`, `billing` и `notifications` (`web-no-role-runtime`), а раннер и пакеты, которые он запускает, не достигают его даже транзитивно (`runner-minimal-packages`).
