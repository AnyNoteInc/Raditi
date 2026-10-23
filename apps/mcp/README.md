# mcp

MCP-шлюз к сайтам (spec §5, §8): единственное место, кроме шлюза подписок, куда ходит песочница. Проверяет токен хода по текущему назначению и аренде, отдаёт агенту `site_info`, а с профилями — `wp_rest` и `restore` (содержимое предпросмотра диалога или, на стендах, сайта) и `browser_*`. Хранит зашифрованные снимки и долговременный журнал вызовов. Порт 8082 (`MCP_PORT`), своя AppRole в Vault. Вход — `src/main.ts` → `src/start.ts` (`startMcp`), конфигурация — `src/config/config.ts` (`loadMcpConfig`). Здесь же доверенный откат правок (`McpTurnContentRollback`, `McpContentService`); сетевого канала `core` → `mcp` нет (N8). В compose app-ВМ сервис не добавлен (P6).

## Устройство

Приложение Nest из модулей (план 56, §4.3). Корень — `src/app.module.ts`: `AppModule.forRoot(config, testing?)` отказывает в составе, который пропустила конфигурация (профиль в production, профиль без S3 или без предпросмотров, швы стендов без профиля), затем — ещё до создания Nest — проверяет, что mcp-nest держит службу авторизации инструментов там, где её подменяет `server/mcp-runtime.ts`, и подключает модули по профилям: `site_info` есть всегда, контент — с `MCP_CONTENT_PROFILE`, браузер — с `MCP_BROWSER_PROFILE`; в этом порядке идут и инструменты. Свои настройки модули читают через `MCP_CONFIG`, аргумент `forRoot` у модулей профилей — только шов стендов. Каталоги `src`:

- `config` — разбор окружения (`loadMcpConfig`, `parseMcpHosts`) и глобальный `McpConfigModule` (`MCP_CONFIG`); `infra` — Vault роли (`SECRET_STORE`), база — `DatabaseModule` из `@repo/service-runtime`; `health` — `/health` (`HealthModule` из `@repo/service-runtime` и проверка запроса допуска);
- `common` — канонический JSON, проверка одной строки, id JSON-RPC и ошибки `/mcp`; `access` — допуск токена хода (`PostgresMcpAccess`), `McpAuthGuard` и политика запроса; `server` — среда mcp-nest, `/mcp` и `mountMcp` (вызывается до `listen`); `site-info` — `site_info`;
- `storage` — бакет артефактов (только с профилем); `privacy` — маркеры контактов; `content` — профиль контента (`wp_rest`, `db_schema`, `restore`, журнал, снимки, доверенный откат, обслуживание); `browser` — профиль браузера (`browser_*`).

Профили не импортируют друг друга, а то, на чём они стоят, не импортирует их, кроме схем аргументов инструментов (`content/content-arguments.ts`, `browser/browser-arguments.ts`): правила dependency-cruiser `mcp-profiles-apart`, `mcp-base-no-profiles` и `mcp-common-and-arguments-are-leaves`.

## Что читает

`APP_ENV`; `DATABASE_URL`; `VAULT_ADDR` и AppRole `mcp` (политика `mcp-content`); `MCP_PORT`, `MCP_ALLOWED_HOSTS` (в production обязательна), `MCP_CONTENT_PROFILE` и `MCP_BROWSER_PROFILE` (по умолчанию `off`, в production допустим только `off`); адрес предпросмотров `PREVIEW_BASE_DOMAIN`, `PREVIEW_SCHEME`, `PREVIEW_PUBLIC_PORT` и `PREVIEW_UPSTREAM_HOST`. Только вне production и только с профилем — S3 одного бакета артефактов: `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_BUCKET_ARTIFACTS`. Redis, git и биллинг не читает.

## Команды

- `pnpm --filter mcp dev`, `build` (сначала собирает `@repo/service-runtime`), `start`, `typecheck`, `lint`, `test`.
- `pnpm --filter mcp test:db` — интеграционные тесты на PostgreSQL (`DATABASE_URL`, `RADITI_GATEWAY_DB_TESTS=1`), только на одноразовой базе; обычный путь — `pnpm verify:db`.
- Стенды: `pnpm verify:agent-content` и `verify:site-connect` запускают `node dist/main.js` в этом каталоге; `pnpm verify:mcp-content` загружает модули из `dist` в своём рабочем процессе — `scripts/verify-content-worker.mjs` и его сценарии `scripts/verify-content-{turns,lifecycle,undo}.mjs` (супервизор хода — из `apps/core/dist/turns`). `scripts/verify-agent-content-undo.mjs` — доверенный откат живого режима `verify:agent-content`. В образ `mcp` стенды не попадают (`.dockerignore`; проверяет `pnpm verify:images`).
- Образ — `apps/mcp/Dockerfile`, цель `runtime`, без `git` и `gitleaks`.

## Чего не должно достигать

- Git, песочницы, драйверов агентов, бэкендов моделей, платежей, почты, `local-turns`, `@repo/trpc` и `@repo/ui` — даже транзитивно (`mcp-minimal-packages`, `llm-no-trpc-ui`); других приложений (`apps-are-isolated`).
- Пользователей и заказов сайта: агенту они недоступны (правило 4); контакты в содержимом шлюз заменяет маркерами, а карту маркеров держит в Vault (`src/privacy/content-privacy.ts`).
