# core

Ядро платформы (spec §5): жизненный цикл задач и диалогов, очередь `agent-turns`, воркеры BullMQ и cron, песочницы и ходы, публикация в git, выпуск `/release` и «Отменить выпуск», первоначальный импорт сайта, менеджер предпросмотров, биллинг, уведомления. Один процесс, одна роль (бывший `apps/orchestrator`; `ORCHESTRATOR_ROLES` удалена). Вход — `src/main.ts` → `src/start.ts` (`startCore`), конфигурация — `src/config/config.ts` (`loadConfig`). Сверх `/health` и `/metrics` на `CORE_PORT` (8081) открывает API раннеров (`RUNNER_API_PORT`, 8083, при `TURN_EXECUTOR=runner`) и API выпуска (`RELEASE_API_PORT`, 8085, при заданном `RELEASE_API_HOST`).

## Устройство

- `src/app.module.ts` — `AppModule.forRoot({ config, background })`. Глобальные модули — только инфраструктура: `CoreConfigModule` (`src/config/config.module.ts`; токены `CORE_CONFIG` и `BACKGROUND_JOBS` — `config.tokens.ts`), `DatabaseModule` из `@repo/service-runtime`, `InfraModule` (S3, Vault, Redis), `QueueModule.forRoot({ redisUrl, background })` (очереди BullMQ; `background` включает воркеры — `manualRegistration`, его `@nestjs/bullmq` принимает только параметром модуля) и `MetricsRegistryModule` — один реестр метрик процесса. Остальные модули разделов импортирует тот, кто их использует.
- `src/turns` — движок хода: `TurnsModule.forRoot(executor)` даёт `TURN_EXECUTOR` (раннеры через API раннеров или Docker самого `core`), супервизор, восстановление, журнал ходов и `TurnRuntime`. `AppModule.forRoot` строит его один раз и передаёт тот же объект в `TasksModule.forRoot` и `PreviewsModule.forRoot`: Nest различает динамические модули по ссылке, второй вызов дал бы второй `LiveTurns`.
- `src/browser` — облачный браузер задач без репозитория (план 57, Б10, Б18): `BrowserModule` даёт `BrowserSessions` — открытие сессии перед проходом, проверку сохранённого на сайте, закрытие с задачей и сверку с процессом `browser`; без `BROWSER_WORKER_URL` — `null`, и такая задача получает отказ `unavailable`. Его импортирует `TasksModule`: проход, итог прохода и сборщик диалогов (он же убирает из `raditi-inbox` файлы, которые так и не отправили, — Б26).
- `src/leases` — аренда сайта и назначения ходов (`SITE_LEASES`, `TURN_ASSIGNMENTS`). `src/site-content` — значения плана БД (`PLAN_VALUES`), DNS адреса сайта (`HOST_LOOKUP`) и фабрика доступа к контенту сайта (`SITE_CONTENT_RESOLVERS`): у каждого потребителя свой экземпляр и свой кеш доступа на 60 с.
- Токены раздела лежат в `<раздел>.tokens.ts`, фабрики разделов, где их много, — в `<раздел>.providers.ts` (`turns`, `tasks`, `previews`). Классы, которые строят тесты и стенды (`new X(...)`), сохраняют конструкторы и подключаются фабриками.
- Порядок запуска и остановки фоновых частей задаёт Nest по графу модулей, тест `src/app.module.test.ts` (`lifecycleOf`) закрепляет его для обоих исполнителей.
  - При запуске: очистка клонов публикации, подметание доступов git, затем циклы — сборщик ключей хода, outbox, биллинг, импорт сайта, ходы, диалоги, предпросмотры, выпуск.
  - При остановке: циклы в обратном порядке, затем воркеры BullMQ, API выпуска, API раннеров (при `TURN_EXECUTOR=runner`), отзыв доступов git этого процесса, Redis и последней — Prisma.
  - API раннеров закрывается до отзыва доступов git: поэтому `RunnerApiModule` стоит в `TurnsModule.forRoot` последним. Redis и Prisma закрываются друг за другом, а не одновременно, как прежде в одном `InfraModule`: `DatabaseModule` — свой глобальный модуль (единственное сознательное отличие плана 56 для `core`, §4.5).
- Вне Nest: `src/deploy-step` (команда задания выкладки, `dist/deploy-step/cli.js`) и команды оператора `src/{billing,releases}/operator-cli.ts`, которые запускаются из исходников.

## Что читает

Окружение читает `loadConfig`; полный перечень — `.env.example`. Группы: `APP_ENV`, `APP_URL`, `METRICS_TOKEN`; `DATABASE_URL`, `REDIS_URL`; `VAULT_*`; `S3_*`; `SANDBOX_*` и `TURN_EXECUTOR`, `RUNNER_TOKENS`; `GITEA_*`, `GIT_CA_FILE`, `GIT_MIRROR_DIR`; `LLM_CONTROL_URL`; `PREVIEW_*`; `RELEASE_API_*`; `BROWSER_WORKER_URL`, `BROWSER_WORKER_TOKEN`, `BROWSER_SESSION_MAX_HOURS`; `BILLING_*`, `YOOKASSA_*`, почта. Вне production загружает корневой `.env` (`@repo/app-bootstrap/load-env`).

## Команды

- `pnpm --filter core dev` (`nest start --watch`), `build` (сначала собирает `@repo/service-runtime`), `start`, `typecheck`, `lint`, `test` (скрипты `scripts/*.test.mjs` и Vitest).
- `pnpm --filter core test:db` — интеграционные тесты на PostgreSQL (`DATABASE_URL`, `RADITI_GATEWAY_DB_TESTS=1`), только на одноразовой базе; обычный путь — `pnpm verify:db`.
- Операторские команды: `billing:refund`, `billing:stop-renewal`, `billing:refunds-needed`, `billing:settle-payment`, `billing:rates`, `releases:resolve`; окружение им задаётся явно, `.env` не читается.
- Стенды `verify:*`, которые ведут сразу несколько приложений (`llm`, `mcp`, `runner`) из их `dist`, живут в `scripts/` этого приложения; стенды одного приложения — в нём самом (стенд контента и доверенный откат живого режима — `apps/mcp/scripts`, процесс роли стенда шлюза — `apps/llm/scripts`). В образ стенды, их тесты и фикстура раннера стенда (`opencode-runner-fixture*.mjs`) не попадают (`.dockerignore`): в `scripts/` образа — только команды оператора `billing-*.mjs` и `releases-resolve.mjs`. Команда задания выкладки — `dist/deploy-step/cli.js` (образ `core`).
- Образ — `apps/core/Dockerfile`, цели `runtime` и `migrate`; в нём `git` и `gitleaks`.

## Чего не должно достигать

- Других приложений: общаются по сети, не импортом (`apps-are-isolated`); `@repo/trpc` и `@repo/ui` (`core-no-trpc-ui`). Исключение — тестовый `src/testing/runner-side.ts`: он даёт перекрёстным тестам настоящий движок раннера, два файла `apps/runner/src` — `core-api/core-client.ts` и `sandbox-runner/sandbox-runner.ts` (план 56, решение 1; `runner-side-reaches-the-engine-only`). Правило и входы `typecheck` в `apps/core/turbo.json` и `test` в корневом `turbo.json` называют все три файла движка, вместе с `reconciler/runner-reconciler.ts`, которого тесты `core` сейчас не берут: файлы движка могут импортировать друг друга (контракт — `infra/app/ci.test.mjs`).
- Ключа аккаунта пула: его читает только `llm` (`subs/` в Vault).
- `src/testing` из продуктового кода (`core-product-no-testing`); `src/deploy-step` не достаёт БД, Redis и S3 даже транзитивно.
