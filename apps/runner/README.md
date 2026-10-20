# runner

Pull-раннер песочной ВМ (spec §8, §19): сам забирает ходы у API раннеров `core` и владеет контейнерами этой ВМ — песочницей, `sandbox-gw` и сторожем сети. Входящих портов нет. Приложение тонкое: `src/config.ts` (`loadRunnerConfig`), `src/start.ts`, `src/main.ts`; движок — пакет `@repo/runner-engine`, исполнитель хода — `@repo/local-turns`, снимки — `@repo/snapshots`.

## Что читает

`APP_ENV`; `RUNNER_CORE_URL` (адрес API раннеров `core`), `RUNNER_TOKEN_FILE` (токен ВМ — абсолютный путь к файлу, не значение), `RUNNER_CORE_CA_FILE`, `RUNNER_S3_ORIGIN` (в production обязателен, только `https://`), `RUNNER_MAX_TURNS` (1); `SANDBOX_*` (среда исполнения, образы шлюза и сторожа, `SANDBOX_EGRESS_REFUSED_SUBNETS`). В production не стартует ни с какой другой переменной, кроме системных, `APP_ENV` и `NODE_ENV`; в ошибке называются только имена.

## Команды

- `pnpm --filter runner build` (собирает `@repo/runner-engine`, затем приложение), `start`, `typecheck`, `lint`, `test`. Скрипта `dev` нет: в `pnpm dev` раннер не стартует.
- Стенды: `pnpm --filter core verify:runner`, `pnpm verify:opencode-supervisor` (раннер под gVisor в Linux-ВМ); образ проверяет `pnpm verify:images` (в нём нет пакетов `db` и `service-runtime`, Prisma, `pg`, S3 SDK и BullMQ, есть `scripts/runner-token.mjs`).
- Образ — `apps/runner/Dockerfile`, цель `runtime`, без `git` и `gitleaks` (git хода работает внутри песочницы); compose песочной ВМ берёт его как `RUNNER_IMAGE` (`infra/sandbox`). Токен ВМ выпускает `scripts/runner-token.mjs` этого приложения (`pnpm --filter runner runner-token`, на песочной ВМ — из образа раннера) (`infra/app/README.md`, «Токены раннеров»).

## Чего не должно достигать

- PostgreSQL, Redis, Vault, S3, платёжного магазина и кода API раннеров `core` (`apps/core/src/runner-api`) — даже транзитивно (`runner-no-platform-access`); у песочной ВМ нет платформенных секретов.
- `@repo/service-runtime` и `@repo/db` — ни приложению, ни пакетам, которые оно запускает, даже транзитивно (`runner-minimal-packages`): запуск процесса даёт `@repo/app-bootstrap`. `@repo/trpc`, `@repo/ui` и другие приложения недоступны.
