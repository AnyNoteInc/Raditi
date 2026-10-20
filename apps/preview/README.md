# preview

Шлюз предпросмотров диалогов (план 53, Р19): по точному `Host` находит предпросмотр в `preview_environments` и проксирует к его upstream, пускает по одноразовому билету кабинета, ставит свою cookie и отвечает только в iframe кабинета; для браузера агента работает как прямой прокси с разрешённых адресов. Порт 8090 (`PREVIEW_GATEWAY_PORT`). Сервер шлюза — пакет `@repo/preview-gateway`; приложение собирает вокруг него Nest-модуль (`src/preview-gateway.module.ts`), конфигурацию (`src/config.ts`, `loadPreviewConfig`) и запуск (`src/start.ts`).

## Что читает

`APP_ENV`; `DATABASE_URL`; `APP_URL` (кабинет, который встраивает предпросмотр: `frame-ancestors` и путь назад); адрес предпросмотров `PREVIEW_BASE_DOMAIN` (обязателен), `PREVIEW_SCHEME`, `PREVIEW_PUBLIC_PORT`; `GITEA_URL` — только чтобы проверить, что домен предпросмотров не лежит под доменом Gitea; `PREVIEW_GATEWAY_PORT`, `PREVIEW_GATEWAY_HOST`, `PREVIEW_SESSION_SECRET` (в production обязателен), `PREVIEW_BROWSER_RELAYS` (источники браузера агента; в production по умолчанию пуст — прямой прокси выключен). Redis, Vault и S3 не читает.

## Команды

- `pnpm --filter preview dev`, `build` (сначала собирает `@repo/service-runtime`), `start`, `typecheck`, `lint`, `test`.
- Стенд приложения — `pnpm verify:release` (предпросмотр диалога целиком, `node dist/main.js` в этом каталоге). `pnpm verify:preview-network` проверяет сеть вокруг предпросмотров и ведёт вместо шлюза свой заменитель: `apps/preview` он не запускает.
- Образ — `apps/preview/Dockerfile`, цель `runtime`; в compose app-ВМ — наложение `infra/app/docker-compose.preview.yml`, образ `PREVIEW_GATEWAY_IMAGE`.

## Чего не должно достигать

- Адреса upstream из запроса: он берётся только из строки `preview_environments`.
- Хранилищ, Vault, git, песочниц, платежей, почты и кода содержимого сайта (`preview-minimal-packages`, даже транзитивно через пакеты репозитория), `@repo/trpc` и `@repo/ui` (`llm-no-trpc-ui`), других приложений (`apps-are-isolated`). Приложение подключает только базу; Redis есть лишь у `core`.
- Cookie общего домена с кабинетом: домен предпросмотров отдельный регистрируемый (`raditi-preview.ru`), в production конфигурация отклоняет домен, у которого регистрируемый домен тот же, что у `APP_URL` или `GITEA_URL`.
