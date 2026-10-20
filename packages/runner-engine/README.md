# @repo/runner-engine

Движок раннера песочной ВМ (spec §8, §19): HTTP-транспорт к API раннеров `core`, цикл опроса `SandboxRunner`, сверка контейнеров (`runner-reconciler`), чтение токена ВМ и Nest-модуль `RunnerModule`, который их собирает. Приложение `apps/runner` — тонкая оболочка над ним: конфигурация, запуск, остановка. Собирается в `dist` (`tsc`) из-за декораторов Nest; типы и тесты читают исходники.

## Что читает

Окружения не читает: получает готовый `RunnerConfig` (`RUNNER_CORE_URL`, `RUNNER_TOKEN_FILE`, `RUNNER_CORE_CA_FILE`, `RUNNER_S3_ORIGIN`, `RUNNER_MAX_TURNS` и настройки песочницы), который строит `loadRunnerConfig` приложения. Токен читает из файла при старте. Переносит снимки хода по временным ссылкам S3 от `core` и только на `RUNNER_S3_ORIGIN`.

## Команды

- `pnpm --filter @repo/runner-engine build`, `typecheck`, `lint`, `test`. Сборку запускает `build` приложения `runner`.
- `./testing` — `testRunnerConfig` для тестов; тесты «раннер против API ядра» лежат в `apps/core/src/runner`.

## Чего не должно достигать

- БД, Redis, Vault, S3, биллинга и кода API раннеров `core` — даже транзитивно (`runner-no-platform-access`).
- Из пакетов платформы берёт только `domain`, `agent-drivers`, `sandbox-providers`, `local-turns`, `snapshots` и `observability` (`runner-engine-tier`); `@repo/service-runtime` и `@repo/db` — ни в каком виде, даже транзитивно (`runner-minimal-packages`); сторож сети тестов — из `@repo/app-bootstrap`.
