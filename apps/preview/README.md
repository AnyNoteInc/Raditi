# preview

Шлюз предпросмотров диалогов (план 53, Р19): по точному `Host` находит предпросмотр в `preview_environments` и проксирует к его upstream, пускает по одноразовому билету кабинета, ставит свою cookie и отвечает только в iframe кабинета; для браузера агента работает как прямой прокси с разрешённых адресов. Порт 8090 (`PREVIEW_GATEWAY_PORT`).

## Устройство

Приложение Nest из модулей (план 56, §4.2); свой сервер `node:http` — провайдер, а не контроллер Nest: предел заголовков в 32 КиБ, `upgrade`, `CONNECT` и принудительное закрытие соединений задаются только своим сервером.

- `src/main.ts` разбирает окружение до Nest, `src/start.ts` создаёт контекст `AppModule.forRoot(config)` и открывает порт; строка запуска — `preview role listening on …`.
- `src/config/` — разбор окружения (`config.ts`, `loadPreviewConfig`), источники браузера агента (`browser-relays.ts`, `PREVIEW_BROWSER_RELAYS`) и глобальный `PreviewConfigModule` с токенами `PREVIEW_CONFIG` и `PREVIEW_CLOCK`.
- База — глобальный `DatabaseModule` из `@repo/service-runtime`: Nest закрывает пул после того, как шлюз закрылся.
- `src/access/` — кто может открыть предпросмотр: порт хранилища (`preview-access.ts`), его реализация на PostgreSQL (`PostgresPreviewAccess`) и `PreviewSessions` — строки хоста и сессии, которые шлюз помнит 5 секунд, и повторная проверка членства и сайта не чаще раза в минуту.
- `src/cookie/` — собственная cookie шлюза, её подпись и хеш билета кабинета; общая для `access` и `gateway`.
- `src/gateway/` — `PreviewGatewayServer` (приём запроса, цель по `Host` или от посредника браузера агента, отказы, `listen`, `address`, `close`) и его части: вход по билету (`entry.ts`), прокси к сайту (`proxy.ts`), websocket (`tunnels.ts`), пределы (`limits.ts`), ответы и предупреждения (`replies.ts`), заголовки (`headers.ts`), страницы (`pages.ts`). Хук остановки есть только у сервера: `close()` сам останавливает части в прежнем порядке. Предупреждения — строки JSON с контекстом логгера `PreviewGateway`.
- `src/testing/` — конфигурация тестов, хранилище в памяти, `createTestGateway` (модуль шлюза без базы) и строки базы для наборов с PostgreSQL.

## Что читает

`APP_ENV`; `DATABASE_URL`; `APP_URL` (кабинет, который встраивает предпросмотр: `frame-ancestors` и путь назад); адрес предпросмотров `PREVIEW_BASE_DOMAIN` (обязателен), `PREVIEW_SCHEME`, `PREVIEW_PUBLIC_PORT`; `GITEA_URL` — только чтобы проверить, что домен предпросмотров не лежит под доменом Gitea; `PREVIEW_GATEWAY_PORT`, `PREVIEW_GATEWAY_HOST`, `PREVIEW_SESSION_SECRET` (в production обязателен), `PREVIEW_BROWSER_RELAYS` (источники браузера агента; в production по умолчанию пуст — прямой прокси выключен, — а диапазон должен целиком лежать в частном или loopback-блоке). Redis, Vault и S3 не читает.

## Команды

- `pnpm --filter preview dev`, `build` (сначала собирает `@repo/service-runtime`), `start`, `typecheck`, `lint`, `test`.
- `pnpm --filter preview test:db` — наборы с PostgreSQL (хранилище билетов и сессий; вход по билету через `startPreview`): только с `DATABASE_URL` одноразовой базы и `RADITI_GATEWAY_DB_TESTS=1`. Локально их запускает `pnpm verify:db`, в CI — шаг job `gateway-db`.
- Стенд приложения — `pnpm verify:release` (предпросмотр диалога целиком, `node dist/main.js` в этом каталоге). Docker-тест менеджера предпросмотров `core` (`preview.yml`) запускает `dist/main.js` отдельным процессом (`apps/core/src/testing/preview-app.ts`), поэтому перед ним нужна сборка `preview`. `pnpm verify:preview-network` проверяет сеть вокруг предпросмотров и ведёт вместо шлюза свой заменитель: `apps/preview` он не запускает.
- Образ — `apps/preview/Dockerfile`, цель `runtime`; в compose app-ВМ — наложение `infra/app/docker-compose.preview.yml`, образ `PREVIEW_GATEWAY_IMAGE`.

## Чего не должно достигать

- Адреса upstream из запроса: он берётся только из строки `preview_environments`.
- Путь запроса (`src/gateway`, `src/access`, `src/cookie`) берёт из пакетов только `domain`, `db`, `ip-address` и токен Prisma из `service-runtime` (`preview-request-path`).
- Хранилищ, Vault, git, песочниц, платежей, почты и кода содержимого сайта (`preview-minimal-packages`, даже транзитивно через пакеты репозитория), `@repo/trpc` и `@repo/ui` (`llm-no-trpc-ui`), других приложений (`apps-are-isolated`). Приложение подключает только базу; Redis есть лишь у `core`.
- Cookie общего домена с кабинетом: домен предпросмотров отдельный регистрируемый (`raditi-preview.ru`), в production конфигурация отклоняет домен, у которого регистрируемый домен тот же, что у `APP_URL` или `GITEA_URL`.
