# core

Ядро платформы (spec §5): жизненный цикл задач и диалогов, очередь `agent-turns`, воркеры BullMQ и cron, песочницы и ходы, публикация в git, выпуск `/release` и «Отменить выпуск», первоначальный импорт сайта, менеджер предпросмотров, биллинг, уведомления. Один процесс, одна роль (бывший `apps/orchestrator`; `ORCHESTRATOR_ROLES` удалена). Вход — `src/main.ts` → `src/start.ts` (`startCore`), конфигурация — `src/config/config.ts` (`loadConfig`). Сверх `/health` и `/metrics` на `CORE_PORT` (8081) открывает API раннеров (`RUNNER_API_PORT`, 8083, при `TURN_EXECUTOR=runner`) и API выпуска (`RELEASE_API_PORT`, 8085, при заданном `RELEASE_API_HOST`).

## Что читает

Окружение читает `loadConfig`; полный перечень — `.env.example`. Группы: `APP_ENV`, `APP_URL`, `METRICS_TOKEN`; `DATABASE_URL`, `REDIS_URL`; `VAULT_*`; `S3_*`; `SANDBOX_*` и `TURN_EXECUTOR`, `RUNNER_TOKENS`; `GITEA_*`, `GIT_CA_FILE`, `GIT_MIRROR_DIR`; `LLM_CONTROL_URL`; `PREVIEW_*`; `RELEASE_API_*`; `BILLING_*`, `YOOKASSA_*`, почта. Вне production загружает корневой `.env` (`@repo/app-bootstrap/load-env`).

## Команды

- `pnpm --filter core dev` (`nest start --watch`), `build` (сначала собирает `@repo/service-runtime`), `start`, `typecheck`, `lint`, `test` (скрипты `scripts/*.test.mjs` и Vitest).
- `pnpm --filter core test:db` — интеграционные тесты на PostgreSQL (`DATABASE_URL`, `RADITI_GATEWAY_DB_TESTS=1`), только на одноразовой базе; обычный путь — `pnpm verify:db`.
- Операторские команды: `billing:refund`, `billing:stop-renewal`, `billing:refunds-needed`, `billing:settle-payment`, `billing:rates`, `releases:resolve`; окружение им задаётся явно, `.env` не читается.
- Стенды `verify:*` живут в `scripts/` этого приложения: они ведут сразу несколько приложений (`llm`, `mcp`, `runner`) из их `dist`. Команда задания выкладки — `dist/deploy-step/cli.js` (образ `core`).
- Образ — `apps/core/Dockerfile`, цели `runtime` и `migrate`; в нём `git` и `gitleaks`.

## Чего не должно достигать

- Других приложений: общаются по сети, не импортом (`apps-are-isolated`); `@repo/trpc` и `@repo/ui` (`core-no-trpc-ui`). Исключение — тестовый `src/testing/runner-side.ts`: он даёт перекрёстным тестам настоящий движок раннера, три файла `apps/runner/src` (план 56, решение 1; `runner-side-reaches-the-engine-only`). Поэтому эти файлы названы во входах `typecheck` в `apps/core/turbo.json` и `test` в корневом `turbo.json`.
- Ключа аккаунта пула: его читает только `llm` (`subs/` в Vault).
- `src/testing` из продуктового кода (`core-product-no-testing`); `src/deploy-step` не достаёт БД, Redis и S3 даже транзитивно.
