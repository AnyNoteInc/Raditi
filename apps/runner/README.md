# runner

Pull-раннер песочной ВМ (spec §8, §19): сам забирает ходы у API раннеров `core` и владеет контейнерами этой ВМ — песочницей, `sandbox-gw` и сторожем сети. Входящих портов нет: это контекст приложения Nest без HTTP-сервера, собранный из модулей (план 56, §4.1). Движок раннера — в самом приложении (до плана 56 — пакет `@repo/runner-engine`); исполнитель хода — `@repo/local-turns`, снимки — `@repo/snapshots`, разбор событий агента — `@repo/agent-drivers`, Docker — `@repo/sandbox-providers`.

## Устройство

- `src/main.ts` — `.env`, разбор конфигурации до Nest, предел остановки; `src/start.ts` — `startRunner`: контекст `AppModule.forRoot(config, { onRetired })`. Сессию, которую `core` вывел, процесс завершает, чтобы перезапуститься с новой.
- `src/app.module.ts` — `AppModule`: модули разделов и `RunnerLifecycle` (`src/runner-lifecycle.ts`), единственный провайдер с хуками. Запуск — опрос, затем сверка контейнеров; остановка — сверка, опрос, затем соединения с `core`; контейнеры остаются. Порядок проверяет `src/app.module.test.ts`.
- `src/config/` — `loadRunnerConfig` и `RunnerConfig`, глобальный `RunnerConfigModule` (токены `RUNNER_CONFIG`, `RUNNER_OPTIONS`).
- `src/vm-token/` — токен ВМ из `RUNNER_TOKEN_FILE`, прочитанный один раз при запуске (`RUNNER_TOKEN`), и id раннера, который он называет (`RUNNER_ID`).
- `src/core-api/` — `HttpRunnerTransport` к API раннеров `core`, `RunnerCallError`, `runnerRefusal`.
- `src/sandbox/` — Docker ВМ через локальный сокет (`SANDBOX_PROVIDER`; контейнеры ходов помечены id раннера из токена) и `LocalTurnExecutor` над ним (`TURN_EXECUTOR`).
- `src/sandbox-runner/` — цикл опроса `SandboxRunner`: команды `core`, их исполнение и отчёты.
- `src/reconciler/` — `RunnerReconciler`: уборка контейнеров ходов, у которых, по ответу `core`, нет владельца.
- `src/testing/` — только тестам: `testRunnerConfig`, поддельный `core` в памяти (`scripted-core.ts`) и по HTTP с проверкой токена (`fake-core-server.ts`) на схемах протокола `@repo/domain`, образцовые id. Сторону песочницы тестам даёт `@repo/local-turns/testing`.

`src/core-api/core-client.ts`, `src/sandbox-runner/sandbox-runner.ts` и `src/reconciler/runner-reconciler.ts` импортируют только `@repo/domain`, `@repo/observability`, `@nestjs/common` (из него — `Logger`; правило не различает, что взято из пакета), из `zod` — только типы, и друг друга (`runner-engine-speaks-the-protocol-only`, `runner-engine-takes-only-types-of-zod`): перекрёстные тесты `core` ведут настоящий движок через `apps/core/src/testing/runner-side.ts` (план 56, решение 1) — единственный файл другого приложения, которому разрешено импортировать раннер (`apps-are-isolated`, `runner-side-reaches-the-engine-only`). Поэтому все три файла движка названы во входах `test` в `turbo.json` и `typecheck` в `apps/core/turbo.json` — и те, которые `runner-side.ts` сейчас не импортирует: файлы движка могут импортировать друг друга (это держит `infra/app/ci.test.mjs`).

## Что читает

`APP_ENV`; `RUNNER_CORE_URL` (адрес API раннеров `core`), `RUNNER_TOKEN_FILE` (токен ВМ — абсолютный путь к файлу, не значение), `RUNNER_CORE_CA_FILE`, `RUNNER_S3_ORIGIN` (в production обязателен, только `https://`), `RUNNER_MAX_TURNS` (1); `SANDBOX_*` (среда исполнения, образы шлюза и сторожа, `SANDBOX_EGRESS_REFUSED_SUBNETS`). В production не стартует ни с какой другой переменной, кроме системных, `APP_ENV` и `NODE_ENV`; в ошибке называются только имена.

## Команды

- `pnpm --filter runner build` (`nest build`), `start`, `typecheck`, `lint`, `test`. Скрипта `dev` нет: в `pnpm dev` раннер не стартует.
- Тесты приложения ведут поддельный `core`. Связку с настоящим `core` — ход целиком по HTTP, перезапуск `core`, перехват контейнера перезапущенным раннером — проверяют тесты `core`: `apps/core/src/runner-api/runner-protocol.cross.test.ts` и тесты супервизора хода, восстановления и дедлайнов в `apps/core/src/turns`.
- Стенды: `pnpm --filter core verify:runner`, `pnpm verify:opencode-supervisor` (раннер под gVisor в Linux-ВМ); образ проверяет `pnpm verify:images` (в нём нет пакетов `db` и `service-runtime`, Prisma, `pg`, S3 SDK, BullMQ и стендов, есть `scripts/runner-token.mjs`).
- Образ — `apps/runner/Dockerfile`, цель `runtime`, без `git` и `gitleaks` (git хода работает внутри песочницы); compose песочной ВМ берёт его как `RUNNER_IMAGE` (`infra/sandbox`). Токен ВМ выпускает `scripts/runner-token.mjs` этого приложения (`pnpm --filter runner runner-token`, на песочной ВМ — из образа раннера) (`infra/app/README.md`, «Токены раннеров»).

## Чего не должно достигать

- PostgreSQL, Redis, Vault, S3, платёжного магазина и кода API раннеров `core` (`apps/core/src/runner-api`) — даже транзитивно (`runner-no-platform-access`); у песочной ВМ нет платформенных секретов.
- `@repo/service-runtime` и `@repo/db` — ни приложению вместе с его тестами, ни пакетам, которые оно запускает, даже транзитивно и даже ради типов (`runner-minimal-packages`): запуск процесса даёт `@repo/app-bootstrap`.
- Других пакетов репозитория, кроме `domain`, `app-bootstrap`, `ip-address`, `observability`, `agent-drivers`, `sandbox-providers`, `local-turns` и `snapshots` (`runner-app-packages`); `@repo/trpc`, `@repo/ui` и другие приложения недоступны (`apps-are-isolated`).
