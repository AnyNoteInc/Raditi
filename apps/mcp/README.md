# mcp

MCP-шлюз к сайтам (spec §5, §8): единственное место, кроме шлюза подписок, куда ходит песочница. Проверяет токен хода по текущему назначению и аренде, отдаёт агенту `site_info`, а с профилями — `wp_rest` и `restore` (содержимое предпросмотра диалога или, на стендах, сайта) и `browser_*`. Хранит зашифрованные снимки и долговременный журнал вызовов. Порт 8082 (`MCP_PORT`), своя AppRole в Vault. Вход — `src/main.ts` → `src/start.ts` (`startMcp`), конфигурация — `src/config.ts` (`loadMcpConfig`). Здесь же доверенный откат правок (`McpTurnContentRollback`, `McpContentService`); сетевого канала `core` → `mcp` нет (N8). В compose app-ВМ сервис не добавлен (P6).

## Что читает

`APP_ENV`; `DATABASE_URL`; `VAULT_ADDR` и AppRole `mcp` (политика `mcp-content`); `MCP_PORT`, `MCP_ALLOWED_HOSTS` (в production обязательна), `MCP_CONTENT_PROFILE` и `MCP_BROWSER_PROFILE` (по умолчанию `off`, в production допустим только `off`); адрес предпросмотров `PREVIEW_BASE_DOMAIN`, `PREVIEW_SCHEME`, `PREVIEW_PUBLIC_PORT` и `PREVIEW_UPSTREAM_HOST`. Только вне production и только с профилем — S3 одного бакета артефактов: `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_BUCKET_ARTIFACTS`. Redis, git и биллинг не читает.

## Команды

- `pnpm --filter mcp dev`, `build` (сначала собирает `@repo/service-runtime`), `start`, `typecheck`, `lint`, `test`.
- `pnpm --filter mcp test:db` — интеграционные тесты на PostgreSQL (`DATABASE_URL`, `RADITI_GATEWAY_DB_TESTS=1`), только на одноразовой базе; обычный путь — `pnpm verify:db`.
- Стенды: `pnpm verify:agent-content` и `verify:site-connect` запускают `node dist/main.js` в этом каталоге; `pnpm verify:mcp-content` загружает модули из `apps/mcp/dist` в своём рабочем процессе (`apps/core/scripts/verify-content-worker.mjs`).
- Образ — `apps/mcp/Dockerfile`, цель `runtime`, без `git` и `gitleaks`.

## Чего не должно достигать

- Git, песочницы, драйверов агентов, бэкендов моделей, платежей, почты, `local-turns`, `@repo/trpc` и `@repo/ui` — даже транзитивно (`mcp-minimal-packages`, `llm-no-trpc-ui`); других приложений (`apps-are-isolated`).
- Пользователей и заказов сайта: агенту они недоступны (правило 4); контакты в содержимом шлюз заменяет маркерами, а карту маркеров держит в Vault (`content-privacy.ts`).
