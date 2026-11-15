# preview

Приложение двух слушателей: опубликованные страницы рабочих пространств ([план 69](../../docs/plan/69-pages.md), Ст4) и шлюз трансляции облачного браузера чата ([план 57](../../docs/plan/57-browser-tasks.md), Б12). Шлюза предпросмотров (`site-…-chat-….raditi-preview.ru`) нет с 15.11.2026 — он ушёл вместе с проектами ([план 83](../../docs/plan/83-remove-projects.md), БП2). Нужен хотя бы один слушатель: без `PAGES_BASE_DOMAIN` и без `BROWSER_WORKER_URL` роль не стартует.

## Устройство

Приложение Nest из модулей (план 56, §4.2); свои серверы `node:http` — провайдеры, а не контроллеры Nest.

- `src/main.ts` разбирает окружение до Nest, `src/start.ts` создаёт контекст `AppModule.forRoot(config)` и открывает порты; строки запуска — `browser stream listening on …` и `pages listening on …`.
- `src/config/` — разбор окружения (`config.ts`, `loadPreviewConfig`) и глобальный `PreviewConfigModule` с токенами `PREVIEW_CONFIG` и `PREVIEW_CLOCK` (`config.tokens.ts`, там же тип конфигурации `PreviewConfig`).
- База — глобальный `DatabaseModule` из `@repo/service-runtime`: Nest закрывает пул после того, как слушатели закрылись.
- `src/browser-stream/` — трансляция облачного браузера чата: `BrowserStreamListener`, хранилище билетов на PostgreSQL (`PostgresBrowserStreamStore`) и `BrowserStreamModule`, который `AppModule` подключает, только когда заданы `BROWSER_WORKER_URL` и `BROWSER_WORKER_TOKEN`.
- `src/pages/` — опубликованные страницы: `PagesServer`, cookie пароля (`page-cookie.ts`), ответы платформы (`page-replies.ts`), хранилище на PostgreSQL (`PostgresPagesStore`) и `PagesModule`, который `AppModule` подключает, только когда задан `PAGES_BASE_DOMAIN`.
- `src/testing/` — конфигурация тестов.

Health роли — `GET /__raditi/health` на порту страниц (8092, `PAGES_PORT`) с любым `Host`, который не адрес страницы (`127.0.0.1:8092`): ответ `200 ok`.

Шлюз трансляции — порт 8091 (`BROWSER_STREAM_PORT`). Кабинет открывает WebSocket на `/v1/browser/stream` только со своего `Origin` (origin `APP_URL`; иначе 403 до перехода на WebSocket) и первым сообщением шлёт `hello` с одноразовым билетом (`browser.streamTicket`; в базе — только SHA-256; нет `hello` за 10 с — закрытие 4401). Шлюз тратит билет, проверяет право смотреть, открывает поток процесса `browser` с его токеном и пересылает; право смотреть перепроверяется каждые 15 с. Билеты, ввод и кадры в журнал не попадают. Сервер шлюза — `createBrowserStreamGateway` из `@repo/browser-link`.

Страницы — порт 8092 (`PAGES_PORT`), только при `PAGES_BASE_DOMAIN`. Страница — точный `Host` `<slug>.<PAGES_BASE_DOMAIN>`, содержимое текущей версии из PostgreSQL под CSP и заголовками `@repo/domain`; пароль — `scrypt`, cookie `raditi_page` только этого поддомена, подписана `PAGES_COOKIE_SECRET`. Путь запроса держит правило `pages-request-path`. Стенд — `pnpm verify:pages` (`scripts/verify-pages.mjs`, фикстуры — `infra/dev/pages-verify`).

## Что читает

`APP_ENV`; `DATABASE_URL`; `APP_URL` (origin кабинета для трансляции); для шлюза трансляции — `BROWSER_STREAM_PORT` (8091), `BROWSER_STREAM_HOST` (IP; пусто — 127.0.0.1 вне production, все адреса в production), `BROWSER_WORKER_URL` и `BROWSER_WORKER_TOKEN` — обе или ни одной. Для страниц — `PAGES_BASE_DOMAIN`, `PAGES_PORT` (8092, не равен порту трансляции), `PAGES_HOST`, `PAGES_PUBLIC_PORT` (только вне production), `PAGES_COOKIE_SECRET` (в production — свой, от 32 знаков) и `PAGES_ABUSE_EMAIL`. Redis, Vault и S3 не читает.

## Команды

- `pnpm --filter preview dev`, `build` (сначала собирает `@repo/service-runtime`), `start`, `typecheck`, `lint`, `test`.
- `pnpm --filter preview test:db` — наборы с PostgreSQL: только с `DATABASE_URL` одноразовой базы и `RADITI_GATEWAY_DB_TESTS=1`. Локально их запускает `pnpm verify:db`, в CI — шаг job `gateway-db`.
- Образ — `apps/preview/Dockerfile`, цель `runtime`.

## Чего не должно достигать

- Хранилищ, Vault, git, песочниц, платежей, почты и кода содержимого сайта (`preview-minimal-packages`), `@repo/trpc` и `@repo/ui`, других приложений (`apps-are-isolated`). Приложение подключает только базу.
