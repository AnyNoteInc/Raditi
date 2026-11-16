# mcp

MCP-шлюз чатов (spec §5, §8): единственное место, кроме шлюза подписок, куда ходит песочница. Проверяет токен хода по текущему назначению и аренде чата (строка `site_leases` с id чата), отдаёт агенту `site_info`, веб-поиск, документы и страницы рабочего пространства, а чату с браузером — `web_*` в его облачном браузере на открытых сайтах, через рабочий процесс браузера (`apps/browser`; [план 57](../../docs/plan/57-browser-tasks.md), Б20). Проектов, сайтов и предпросмотров нет с 15.11.2026 ([план 83](../../docs/plan/83-remove-projects.md)): профили контента (`wp_rest`, `restore`, `db_schema`) и браузера предпросмотра (`browser_*`) удалены. Порт 8082 (`MCP_PORT`), своя AppRole в Vault. Вход — `src/main.ts` → `src/start.ts` (`startMcp`), конфигурация — `src/config/config.ts` (`loadMcpConfig`). В compose app-ВМ сервис не добавлен (P6).

## Устройство

Приложение Nest из модулей (план 56, §4.3). Корень — `src/app.module.ts`: `AppModule.forRoot(config)` ещё до создания Nest проверяет, что mcp-nest держит службу авторизации инструментов там, где её подменяет `server/mcp-runtime.ts`, и подключает модули: `site_info` есть всегда, семейство `web` — с `BROWSER_WORKER_URL`, веб-поиск и документы — всегда, страницы — с `PAGES_BASE_DOMAIN`, запланированные задачи — всегда; в этом порядке идут и инструменты. Каталоги `src`:

- `config` — разбор окружения (`loadMcpConfig`, `parseMcpHosts`) и глобальный `McpConfigModule` (`MCP_CONFIG`); `infra` — Vault роли (`SECRET_STORE`), база — `DatabaseModule` из `@repo/service-runtime`; `health` — `/health` (`HealthModule` из `@repo/service-runtime` и проверка запроса допуска);
- `common` — канонический JSON, проверка одной строки, id JSON-RPC и ошибки `/mcp`; `access` — допуск токена хода (`PostgresMcpAccess`), `McpAuthGuard` и политика запроса; `server` — среда mcp-nest, `/mcp` и `mountMcp` (вызывается до `listen`); `site-info` — `site_info`: сайта у чата нет, а чату с браузером — кто им сейчас управляет (`browser-tasks.ts`);
- `privacy` — карты контактов прежних ходов; `web` — облачный браузер чата (`web_*`): допуск каждого вызова по ходу и открытой сессии браузера чата (`mcp-web-store.ts`), действие — рабочему процессу браузера через `@repo/browser-link`, ответ — в пределах 64 КиБ (`mcp-web.ts`); `search` — `raditi_search_web`; `pages` ([план 69](../../docs/plan/69-pages.md)) — три семейства: `docs` (`raditi_doc_*`, у любого хода), `pages` (чтение страниц, только при `PAGES_BASE_DOMAIN`) и `pages_changes` (публикация и любое изменение страниц); `schedule` ([план 82](../../docs/plan/82-scheduled-tasks.md), Зп31–Зп34, Зп54) — запланированные задачи автора чата в его личном рабочем пространстве: семейство `schedule` (`raditi_schedule_list`, у любого хода) и `schedule_changes` (`raditi_schedule_create`, `raditi_schedule_update`, `raditi_schedule_delete` — резерв сейчас, применяет `core` в конце хода); `skill-relay` — ретранслятор MCP-серверов рабочего пространства с ключом владельца.
- Проход запланированной задачи без клиента (`unattended` допуска, `passUnattended` из `@repo/db`; план 82, Зп27, Зп28, Зп32, Зп50, Зп51): семейства `pages_changes` и `schedule_changes` ему не объявляются, вызов изменяющего инструмента или с `confirmedByClient` получает отказ `SCHEDULE_FORBIDDEN` результатом инструмента (`MCP_UNATTENDED_REFUSAL`), ретранслятор навыков отвечает тем же отказом на `tools/call` и пропускает остальное (`initialize`, `tools/list`, уведомления), а каждое действие `web_*` уходит браузеру с `readOnly: true` — страницы только читают.

## Что читает

`APP_ENV`; `DATABASE_URL`; `VAULT_ADDR` и AppRole `mcp` (политика `mcp-content`); `MCP_PORT`, `MCP_ALLOWED_HOSTS` (в production обязательна); рабочий процесс браузера — `BROWSER_WORKER_URL`, `BROWSER_WORKER_TOKEN` и `BROWSER_SESSION_MAX_HOURS` (без адреса семейства `web` нет; в production обычный http — только на частный или loopback-адрес); пределы веб-поиска `WEB_SEARCH_*`; адрес страниц `PAGES_BASE_DOMAIN` и `PAGES_PUBLIC_PORT`. Redis, S3, git и биллинг не читает.

## Команды

- `pnpm --filter mcp dev`, `build` (сначала собирает `@repo/service-runtime`), `start`, `typecheck`, `lint`, `test`.
- `pnpm --filter mcp test:db` — интеграционные тесты на PostgreSQL (`DATABASE_URL`, `RADITI_GATEWAY_DB_TESTS=1`), только на одноразовой базе; обычный путь — `pnpm verify:db`.
- Образ — `apps/mcp/Dockerfile`, цель `runtime`, без `git` и `gitleaks`.

## Чего не должно достигать

- Git, песочницы, драйверов агентов, бэкендов моделей, платежей, почты, `local-turns`, `@repo/trpc` и `@repo/ui` — даже транзитивно (`mcp-minimal-packages`, `llm-no-trpc-ui`); других приложений (`apps-are-isolated`).
