# llm

Шлюз подписок (spec §5, §15): единственный процесс, который держит ключ провайдера модели (Z.ai: `zai-coding`, `zai-api`). Проверяет ключ хода, подставляет ключ аккаунта пула, держит бюджет ключа хода, пишет расход в `llm_calls` и `token_usage`, следит за здоровьем пула. Слушает порт 8084 (`LLM_GATEWAY_PORT`) на частном адресе, одна реплика. Вход — `src/main.ts` → `src/start.ts` (`startLlm`): конфигурация разбирается до Nest, затем `AppModule.forRoot(config)` собирает роль из модулей, а `LlmRuntime` запускает её и останавливает.

## Устройство

- `src/app.module.ts` — `AppModule.forRoot(config)`: `LlmConfigModule`, `InfraModule` (оба глобальные) и `GatewayModule`.
- `src/config` — `config.ts` (`loadLlmConfig`), `llm-config.ts` (переменные шлюза; без декораторов — его грузят из исходников команды оператора и `infra/dev/llm-verify/live.test.mjs`), `config.module.ts` (`LLM_CONFIG`).
- `src/infra` — `PRISMA` и `SECRET_STORE` (токены `@repo/service-runtime`), реестр бэкендов `LLM_BACKENDS`, один `Logger('LlmGateway')` всей роли (`LLM_LOGGER`), проверка здоровья базы и Vault (`HEALTH_PROBE`), отключение базы не дольше 2 с со строкой `llm_database_shutdown_timeout` (`DATABASE_SHUTDOWN`; не `PrismaLifecycle`, у которого предела нет).
- `src/egress` — путь к провайдерам с прокси и без него (`egress.ts`, `egress-probe.ts` — без декораторов, их берут и команды оператора), его здоровье `EgressHealth` и ворота: генерации, пробы аккаунтов, перепроверка региона.
- `src/pool` — ключи аккаунтов из Vault `subs/` (`credentials.ts`) и здоровье пула (`SubscriptionPoolHealth`).
- `src/accounting` — приём запросов по ключу хода (`PostgresGatewayStore`: `lookup`, `admit`, `refuse` поверх журнала вызовов `@repo/turn-keys`), его типы и сборщик потерянных вызовов (`LostCallCollector`).
- `src/maintenance` — фоновые задачи по имени (`MaintenanceJobs`), пробы канала и перепроверка региона (`ChannelMonitor`), проход пула раз в минуту (`PoolTicker`).
- `src/gateway` — HTTP-сервер шлюза (`server.ts`, свой `node:http`: список допуска раньше маршрутизации, SSE, отказы в форме адаптера), готовность и здоровье (`readiness.ts`), `LlmRuntime` (`llm-runtime.ts`): порядок запуска — строка `llm_egress_path`, первый сбор и проверка канала, `listen`, таймеры — и остановки — HTTP до 30 с, пул и канал до 3 с, задачи 1 с, сборщик 1 с, база 2 с — в одном месте.
- `src/subscriptions` — команды оператора вне Nest (из исходников, без декораторов; `session-lock.ts` нужен только им); правило `llm-operator-cli-no-nest` не даёт им достичь модулей Nest и пакетов `@nestjs/*`.
- `scripts` — `subscription-*.mjs` (команды оператора) и `verify-llm-worker.mjs` — процесс роли стенда шлюза: собирает роль тем же `AppModule` из сборки. В образ стенд не попадает (`.dockerignore`), команды оператора — попадают.

## Что читает

`APP_ENV`, `METRICS_TOKEN`; `DATABASE_URL`; `VAULT_ADDR` и AppRole (`VAULT_ROLE_ID`, `VAULT_SECRET_ID`) с одним правом `read` на `subs/`; `LLM_GATEWAY_PORT`, `LLM_GATEWAY_LISTEN_HOST`, `LLM_GATEWAY_CLIENTS`, `LLM_GATEWAY_HOSTS`; `LLM_EGRESS_*` (прокси узла выхода; без них шлюз ходит к Z.ai сам); `LLM_MAX_REQUESTS_PER_KEY`, `LLM_MAX_CALLS_PER_KEY_30S`, `LLM_MAX_CALLS_PER_KEY`; вне production — подмена адреса провайдера `LLM_BACKEND_URL_ZAI_CODING` и `LLM_UPSTREAM_CA_FILE`. Redis, S3 и git не читает.

## Команды

- `pnpm --filter llm dev`, `build` (сначала собирает `@repo/service-runtime`), `start`, `typecheck`, `lint`, `test`.
- `pnpm --filter llm test:db` — интеграционные тесты на PostgreSQL (`DATABASE_URL`, `RADITI_GATEWAY_DB_TESTS=1`), только на одноразовой базе; обычный путь — `pnpm verify:db`.
- `pnpm --filter llm subscriptions:login`, `subscriptions:retire`, `subscriptions:token` — импорт ключа аккаунта, вывод аккаунта и токен writer/admin; окружение задаётся явно, секреты — закрытыми файлами и скрытым stdin.
- Стенды (`verify:llm-gateway`, `verify:llm-app`, `verify:llm-firewall`, `verify:agent-content`) — `apps/core/scripts` и `infra/app`; процесс роли стенда шлюза — `scripts/verify-llm-worker.mjs` (нужна сборка `pnpm --filter llm build`).
- Образ — `apps/llm/Dockerfile`, цель `runtime`, без `git` и `gitleaks`.

## Чего не должно достигать

- Хранилища, git, песочницы, браузера, платежей, почты, снимков и кода содержимого сайтов — даже транзитивно (`llm-minimal-packages`); `@repo/trpc` и `@repo/ui` (`llm-no-trpc-ui`); других приложений (`apps-are-isolated`).
- Ключ аккаунта не попадает в песочницу, на песочную ВМ, `turn_assignments.plan`, логи и метрики: в песочницу идут только ключ хода и токен MCP.
