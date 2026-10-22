# llm

Шлюз подписок (spec §5, §15): единственный процесс, который держит ключ провайдера модели (Z.ai: `zai-coding`, `zai-api`). Проверяет ключ хода, подставляет ключ аккаунта пула, держит бюджет ключа хода, пишет расход в `llm_calls` и `token_usage`, следит за здоровьем пула. Слушает порт 8084 (`LLM_GATEWAY_PORT`) на частном адресе, одна реплика. Вход — `src/main.ts` → `src/start.ts` (`startLlm`), конфигурация — `src/config.ts` (`loadLlmConfig`); код шлюза — `src/gateway`, приём запросов по ключу хода (`PostgresGatewayStore`: `lookup`, `admit`, `refuse` поверх журнала вызовов `@repo/turn-keys`) и его типы — `src/accounting`, операторские команды — `src/subscriptions`.

## Что читает

`APP_ENV`, `METRICS_TOKEN`; `DATABASE_URL`; `VAULT_ADDR` и AppRole (`VAULT_ROLE_ID`, `VAULT_SECRET_ID`) с одним правом `read` на `subs/`; `LLM_GATEWAY_PORT`, `LLM_GATEWAY_LISTEN_HOST`, `LLM_GATEWAY_CLIENTS`, `LLM_GATEWAY_HOSTS`; `LLM_EGRESS_*` (прокси узла выхода; без них шлюз ходит к Z.ai сам); `LLM_MAX_REQUESTS_PER_KEY`, `LLM_MAX_CALLS_PER_KEY_30S`, `LLM_MAX_CALLS_PER_KEY`; вне production — подмена адреса провайдера `LLM_BACKEND_URL_ZAI_CODING` и `LLM_UPSTREAM_CA_FILE`. Redis, S3 и git не читает.

## Команды

- `pnpm --filter llm dev`, `build` (сначала собирает `@repo/service-runtime`), `start`, `typecheck`, `lint`, `test`.
- `pnpm --filter llm test:db` — интеграционные тесты на PostgreSQL (`DATABASE_URL`, `RADITI_GATEWAY_DB_TESTS=1`), только на одноразовой базе; обычный путь — `pnpm verify:db`.
- `pnpm --filter llm subscriptions:login`, `subscriptions:retire`, `subscriptions:token` — импорт ключа аккаунта, вывод аккаунта и токен writer/admin; окружение задаётся явно, секреты — закрытыми файлами и скрытым stdin.
- Стенды (`verify:llm-gateway`, `verify:llm-app`, `verify:llm-firewall`, `verify:agent-content`) — `apps/core/scripts` и `infra/app`.
- Образ — `apps/llm/Dockerfile`, цель `runtime`, без `git` и `gitleaks`.

## Чего не должно достигать

- Хранилища, git, песочницы, браузера, платежей, почты, снимков и кода содержимого сайтов — даже транзитивно (`llm-minimal-packages`); `@repo/trpc` и `@repo/ui` (`llm-no-trpc-ui`); других приложений (`apps-are-isolated`).
- Ключ аккаунта не попадает в песочницу, на песочную ВМ, `turn_assignments.plan`, логи и метрики: в песочницу идут только ключ хода и токен MCP.
