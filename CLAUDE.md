# Радити

Радити (raditi.ru) — сервис для малого бизнеса: владелец пишет в веб-чат или Telegram, что поменять на сайте, и AI-агент меняет его сайт — в MVP на WordPress, дальше на 1С-Битрикс и других CMS. Контент правится прямо на сайте со снимком для отката, код — через git-репозиторий сайта (наша Gitea или GitHub/GitLab клиента): ветка, PR, «Применить», выкладка с бэкапом, проверкой и автооткатом. Окружение у сайта одно — прод.

## Где что читать

| Файл | Когда открывать |
| --- | --- |
| `docs/spec.md` | Архитектура и решения. Перед задачей читай нужный раздел (§N ниже — его разделы) |
| `docs/business.md` | Портрет клиента, тарифы, квоты, «Оплата за действие», себестоимость задачи |
| `docs/plan/roadmap.md` | Этапы, гейты и задачи с ID (B1, P4, M5…) — отмечай выполненное |
| `docs/plan/00-bootstrap.md` | Первый шаг: развернуть монорепозиторий |
| `docs/research/2026-09-bootstrap/` | Исследования к `/bootstrap`: версии, очередь, песочница, биллинг, капча, мониторинг. Откуда взялись решения владельца от 26.09.2026; части о LiteLLM и российских моделях — история |
| `docs/research/2026-09-subscriptions/` | Исследования, ревью и проект P3 (`p3-design.md`): подписки Codex и Kimi, 152-ФЗ, шлюз подписок. Откуда взялись решения владельца от 28.09.2026 |
| `docs/landing/` | Прототип лендинга для `apps/web` `(about)` |
| `docs/model/Raditi_unit_economics.xlsx` | Модель юнит-экономики |
| `../AnyNote` | Образец структуры и пакетов — только чтение |

## Состояние

Каркас готов (`/bootstrap`, B0–B5, 26.09.2026): монорепозиторий, пакеты-порты и адаптеры, `apps/web`, `apps/orchestrator` (роли `core`, `mcp` и `runner`), `apps/e2e`, схема данных v1 с миграциями и сидами, локальная инфраструктура с мониторингом. Работают вход по почте и паролю с согласиями, юридические страницы, health и метрики, outbox → BullMQ → письма. P1 добавляет парсеры четырёх CLI и выбор файлов сессии, зашифрованные снимки ходов в S3 и проверяемое восстановление через порт Sandbox; отчёт — `docs/plan/02-p1-verification.md`. P2 готов (27.09.2026): Docker provider под `runsc` и `runc` со шлюзом (под `runsc` — мост попытки без адреса хоста и правило `INPUT DROP` на хосте, spec §8 «Сеть»), супервизор хода на порту `TurnExecutor`, SQL-аренда, доверенная Git-публикация, роль `runner` (pull без входящих портов, API раннеров в `core` на отдельном порту, presigned-ссылки и ключ данных на ход) и восстановление незавершённого exec. Всё проверено в Linux-ВМ под gVisor, в том числе `kill -9` `core` и раннера. Отчёт, открытые вопросы и остаток для M10 и P3–P12 — `docs/plan/03-p2-verification.md`. Выкладка app-ВМ (часть M10): `infra/app` — Compose с Traefik и Let's Encrypt, Dockerfile `web` и `orchestrator`, runbook и preflight, сквозная проверка `pnpm verify:edge` на Pebble; секреты из Vault через vault-agent и Ansible — M10. Супервизор, recovery и локальный сборщик мусора подключаются к очереди в P12; решения по умолчанию в spec §20 (для гейтов P2 и для выкладки app-ВМ) ждут владельца. 28.09.2026 владелец перевёл модели на подписки Codex и Kimi (правило 1); P3 — шлюз подписок, роль `llm`, проект — `docs/research/2026-09-subscriptions/p3-design.md`. До коммитов P3 в коде и `infra/dev` ещё остаются LiteLLM, российские провайдеры моделей и GigaChat: их не развиваем, они удаляются. Запуск CLI на подписках — P4/P5; бизнес-логика задач, git-провайдеры и оплата ещё впереди (`docs/plan/roadmap.md`). Реквизиты оператора в юридических текстах — заглушки (`apps/web/content/legal/README.md`).

Локальные проверки и границы результата — `docs/plan/01-bootstrap-verification.md`; GitHub Actions нужно подтвердить после отправки ветки.

## Стек

- Node 26.10 (в прод — после перехода ветки 26 в LTS 28.10.2026), pnpm 12.6, Turborepo 2.11, TypeScript strict: типы проверяет `tsc` 7.0, а пакет `typescript` — 6.0 через псевдоним (typescript-eslint, dependency-cruiser и Nest CLI с TS 7 не работают). ESLint 10, Vitest 5 (для Nest — unplugin-swc), zod 4.6; слои проверяет dependency-cruiser (`pnpm check-architecture`).
- `apps/web` — Next.js 16.3 (App Router), React 19.3, MUI 9.4, MDX: лендинг `(about)` и юридические страницы, вход `(auth)`, кабинет и веб-чат `(protected)`; tRPC 11.19 (`@trpc/tanstack-react-query`), better-auth 1.7 с Yandex SmartCaptcha, SSE-поток задачи, вебхуки Telegram, ЮKassa и git-провайдеров.
- `apps/orchestrator` — NestJS 12.1 (ESM). Один код и один образ, четыре роли запуска (`llm` — с P3):
  - `core` — жизненный цикл задач, квоты, воркеры BullMQ, cron, управление песочницами, публикация в git;
  - `mcp` — MCP-шлюз к сайтам (WP-CLI, REST, Playwright): отдельный процесс и порт, своя AppRole в Vault и своя роль в PostgreSQL без доступа к биллингу. Кроме шлюза подписок, это единственное, куда ходит песочница;
  - `llm` — шлюз подписок на app-ВМ: порт 8084 на частном адресе, одна реплика. Проверяет ключ хода (его выдаёт `core` вместе с выбором аккаунта пула), подставляет токен подписки, держит потолок попытки, пишет расход из ответов провайдера в `llm_calls` и `token_usage`; к провайдерам ходит только через узел выхода `egress-1`. Токены подписок читает и обновляет только эта роль: своя AppRole, своя роль PostgreSQL `raditi_llm` вне `raditi_app`, без Redis;
  - `runner` — pull-раннер на песочной ВМ: сам забирает ходы у API раннеров `core` (`RUNNER_API_PORT`), владеет контейнерами; входящих портов и доступов к базе, Redis, Vault и S3 нет, аренда с эпохой. Где идут ходы, задаёт `TURN_EXECUTOR`: `runner`, а `local` — Docker самого `core`, только не в проде.
- `apps/e2e` — Playwright 1.63.
- `packages/*` — порты и адаптеры (см. «Как писать код»): ядро `domain`; адаптеры `db` (Prisma 7.10, генератор `prisma-client`, PrismaPg), `storage`, `vault`, `git-providers`, `sandbox-providers`, `agent-drivers`, `llm-backends` (с P3), `site-adapters`, `yookassa`, `mail`, `telegram`; сервисы `auth`, `notifications`; транспорт `trpc`; `ui`.
- Модели — только по подпискам (правило 1): Codex CLI на подписке ChatGPT и Kimi Code CLI на подписке Kimi Code, пул личных аккаунтов. Классы `light`, `standard` и `heavy` — профили (оболочка, модель, уровень рассуждения), без роутера и классификатора. LiteLLM, Yandex AI Studio, Cloud.ru и GigaChat убраны решением от 28.09.2026.
- Очередь — Redis 8.10 + BullMQ 6.3 через `@nestjs/bullmq` 12:
  - истина о задаче — `tasks.status` в PostgreSQL; постановка в очередь — атомарно с записью в БД через `outbox_events` и relay в `core`;
  - `awaiting_user` и `awaiting_approval` — статус плюс отложенная задача-таймер BullMQ, а не висящий job;
  - строго один ход, выкладка или откат на сайт — аренда сайта в PostgreSQL;
  - cron — job schedulers BullMQ; живой поток задачи — история в `task_events` плюс Redis pub/sub между репликами web.
- Инфраструктура: PostgreSQL 17, Redis 8 (appendonly, `maxmemory-policy noeviction`), S3 (в проде — российское облако, локально SeaweedFS), OpenBao, Gitea 1.27 + gitea/runner — для репозиториев сайтов и реестра образов песочниц, узел выхода `egress-1` за рубежом (по умолчанию Казахстан; HTTPS CONNECT-прокси с mTLS и точным белым списком хостов провайдеров, TLS от шлюза до провайдера сквозной, секретов на ВМ нет), Docker 29 + gVisor (`runsc`, systrap), свой реестр образов (Docker Hub отвечает 403 для российских IP). Traefik 3.7 — единственный публичный вход app-ВМ (80/443, сертификаты Let's Encrypt выпускает сам, маршруты — file provider без сокета Docker); между ВМ — HTTP на частные IP-адреса, кроме Vault и Gitea (TLS); токен раннера привязан к адресу ВМ.
- Наблюдаемость: Prometheus + Grafana (локально — профиль `monitoring`), метрики — `@prometheus-io/client`. Sentry — позже, только свой сервер в России.
- Код платформы — на GitHub: CI и релизы — GitHub Actions (typecheck, lint, test, check-architecture, build; semantic-release с `@semantic-release/github`). Выкладка платформы на ВМ через GitHub Actions — задача M10.

## Команды

Node 26.10 (`nvm use`) и pnpm 12.6. `npm` и `npx` внутри репозитория не работают (`devEngines`), вместо них — `pnpm` и `pnpm dlx`.

- `cp .env.example .env` и задать `BETTER_AUTH_SECRET` (`openssl rand -base64 48`); `pnpm install`.
- `pnpm infra:up` / `infra:down` / `infra:logs` — PostgreSQL, Redis, SeaweedFS (+ бакеты `raditi-*`), OpenBao dev, Gitea. Профили (`--profile` или `COMPOSE_PROFILES` в `.env`): `site` — тестовый WordPress на :8080, `llm` — LiteLLM на :4000 (удаляется в P3; профиль станет фейками подписок и локальным прокси выхода), `ci` — gitea/runner, `monitoring` — Prometheus :9090 и Grafana :3030, `monitoring-host` — cAdvisor (только Linux). Если `docker compose` висит на «Error getting credentials» — ответьте на запрос связки ключей macOS.
- `pnpm db:migrate` (новая миграция в dev), `pnpm db:deploy` (применить), `pnpm db:seed` (справочники, повторный запуск безопасен), `pnpm db:generate`.
- `pnpm dev` — web :3000, orchestrator :8081 (core) и :8082 (mcp); при `TURN_EXECUTOR=runner` — ещё API раннеров :8083. Останавливать Ctrl-C (SIGINT): SIGTERM оставляет дочерние процессы.
- С P3, вместе с кодом: роль `llm` в `pnpm dev` на :8084; `pnpm --filter orchestrator verify:llm-gateway` — фейки подписок, настоящие Codex CLI и Kimi CLI в контейнерах, настоящие роли PostgreSQL; `subscriptions:login`, `subscriptions:retire`, `subscriptions:token` — вход, вывод аккаунта и токен оператора. Пока этих команд нет. Настоящие подписки в dev не используются: проверка владельца — на отдельном стенде (`p3-design.md` §9).
- Роль `runner` — `ORCHESTRATOR_ROLES=runner` с `RUNNER_CORE_URL`, `RUNNER_TOKEN_FILE`, `RUNNER_S3_ORIGIN` (в проде обязателен, только `https://`; при path-style S3 — с бакетом сессий) и `SANDBOX_*`. Токен и запись для `RUNNER_TOKENS` в `core` локально — `pnpm --filter orchestrator runner-token issue <id> <файл>` (без `--ip` запись принимается только вне прода). Для песочной ВМ токен выпускается на ней самой образом раннера, с `--ip <частный IP ВМ>`, чтобы он не покидал ВМ: `infra/app/README.md`, «Токены раннеров» (там же ротация).
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:infra`, `pnpm build`, `pnpm check-architecture`, `pnpm check-env`; всё сразу — `pnpm gates`. `test:infra` — тесты `infra/*/*.test.mjs` (песочная ВМ, compose app-ВМ, маршруты Traefik, Dockerfile); нужен Docker CLI, демон — нет.
- Тесты `@repo/db` с базой: `DATABASE_URL=postgresql://raditi:raditi@localhost:5432/raditi pnpm --filter @repo/db test` (без переменной они пропускаются).
- `pnpm --filter @repo/storage test:s3` — presigned-ссылки на локальном SeaweedFS с `S3_*` из `.env`; в обычном `pnpm test` без `S3_ENDPOINT` на loopback эти тесты пропускаются.
- `pnpm e2e` — smoke на поднятой инфраструктуре (web на :3100, core на :8181, mcp на :8182); `pnpm dev` перед этим остановить.
- `pnpm --filter orchestrator verify:snapshots` — локальная интеграционная проверка P1 на SeaweedFS + OpenBao из `.env`: временные синтетические данные, без моделей; свой Transit-ключ и S3-объекты удаляются после проверки.
- `pnpm --filter orchestrator verify:runner` — гейты 2 и 3 P2: `core` на этой машине, раннер в Linux-ВМ под gVisor (Colima), полный ход с restore, `kill -9` `core` и раннера. Образы собираются в демоне ВМ; переменные `P2_RUNNER_*` и повтор — `docs/plan/03-p2-verification.md`. Всё созданное удаляется.
- `pnpm verify:edge` — сквозная проверка края app-ВМ: сборка образов web и orchestrator, Traefik выпускает сертификаты у локального Pebble, web отвечает по HTTPS, core снаружи и из сети web не виден, API раннеров — HTTP только на частном адресе; `-- --renewal` — плюс продление, `-- --real-address` — только в CI с `userland-proxy: false`. Порты 18080, 18443, 18083 и 15000 на `127.0.0.1` должны быть свободны; результаты — `docs/plan/04-edge-verification.md`.
- Health: web `/api/health`, orchestrator `/health` — публично только status; подробности web и core — с `Authorization: Bearer $METRICS_TOKEN`, MCP всегда только status. Метрики — `/api/metrics` и `/metrics` с тем же токеном.

## Структура

```
apps/
  web/            Next.js: (about) и /terms (MDX из content/legal), (auth), (protected), onboarding, api/{auth,trpc,health,metrics,webhooks/yookassa}
  orchestrator/   NestJS: config, roles (core, mcp, runner), health, metrics, queue (BullMQ), outbox relay, notifications, drivers,
                  sandbox, sessions (снимки ходов), turns (супервизор хода, аренда, журнал, recovery), git-workspace (доверенная публикация), mcp,
                  runner (роль runner: опрос core, Docker ВМ), runner-api (API раннеров в core);
                  с P3 — llm-gateway (роль llm) и llm (ключи хода в core)
  e2e/            Playwright smoke
packages/
  domain/         ядро: порты, общие события и итог хода (zod), статусы §7, политика песочницы и путей диффа, реестр юридических документов, APP_ENV, withTimeout, разбор env (parseEnv, envVar, envProblems, Env)
  db/             Prisma: схема v1, миграции, сиды, клиент PrismaPg, outbox
  storage vault git-providers sandbox-providers agent-drivers site-adapters yookassa mail telegram — адаптеры;
                  с P3 — llm-backends (openai-chatgpt, kimi-code)
  auth notifications — сервисы; trpc — транспорт; ui — MUI-тема, формы входа, SmartCaptcha
  observability — общие для приложений health, метрики, проверка bearer-токена, лог ошибок (только сервер)
  eslint-config typescript-config — общие конфиги
infra/dev/        локальная инфраструктура: docker compose, конфиги раннера, Prometheus и Grafana; LiteLLM — до удаления в P3
infra/sandbox/    песочная ВМ: watchdog, sandbox-gw, раннер
infra/app/        app-ВМ: compose с Traefik и Let's Encrypt, runbook, preflight, проверки, verify-edge
infra/egress/     с P3 — узел выхода egress-1 за рубежом: CONNECT-прокси с mTLS, runbook
docs/             spec, business, план, исследования, лендинг
.github/          CI и релизы (GitHub Actions)
```

## Правила, которые нельзя нарушать

1. **Хранилища — в России, модели — по подпискам Codex и Kimi.** База, S3, логи, снимки и журналы платформы — только у российских провайдеров. Задания, сообщения и файлы клиента, код и содержимое его сайта обрабатывают модели OpenAI (США) через подписки ChatGPT для Codex CLI и Moonshot AI через подписки Kimi Code (юрлицо и страна — по заключению юриста) — решение владельца от 28.09.2026. Других провайдеров моделей нет: GigaChat, Yandex AI Studio и Cloud.ru убраны. Сообщения и файлы клиента сначала записываются в PostgreSQL и S3 в России; прямого пути «браузер → провайдер модели» нет. К провайдерам ходит только шлюз подписок (роль `llm`) через узел выхода за рубежом; тела запросов нигде не пишутся. Персональные данные третьих лиц — посетителей, авторов комментариев и заявок, клиентов сайта — агенту не передаются (§11). Данные клиентов уходят провайдеру только после гейта 152-ФЗ (§18): `issue` не выдаёт ключ хода рабочему пространству с реальными данными без записи в `cross_border_clearances` для этой оболочки. Никаких других зарубежных API с данными клиентов.
2. **Секреты — только в Vault.** В базе — `credential_refs` (путь в Vault), в коде, логах, S3 и Git — никогда. Форма доступов пишет в Vault и не умеет читать обратно. Сервисы входят по AppRole со своими политиками (§15). Токены подписок — только в Vault mount `subs/` (`max_versions=1`, `cas_required`). Читает и обновляет их только роль `llm`, импорт пишет и не читает обратно, удаляет — только политика admin. В песочницу, на песочную ВМ и `egress-1`, в `turn_assignments.plan`, логи и метрики они не попадают. Локально ключи сервисов можно держать в `.env`; тестовые подписки живут в OpenBao (`subscriptions:login`), не в `.env`.
3. **Прод один.** Код попадает на сайт только после «Применить»: бэкап → выкладка → проверка → автооткат. Контент меняется сразу, но перед правкой — снимок в `raditi-artifacts`; «Отменить» работает 7 дней (§7, §10, §11).
4. **Опасное — только через `request_approval`.** Удаление страниц, смена темы, плагины, настройки оплаты, массовые правки (больше 20 объектов). Пользователи и заказы сайта агенту недоступны.
5. **Песочница.** Задача — логическая сессия, контейнер — на один ход; в `awaiting_user` и `awaiting_approval` контейнера нет, сессия лежит в `raditi-sessions`. Docker + gVisor (`runsc`, systrap): dockerd от root, в контейнере uid 10001, read-only rootfs, cap-drop ALL, no-new-privileges, 2 vCPU, 4 ГБ, 512 процессов, 20 минут на ход; граница изоляции — gVisor. Сеть — internal без DNS и интернета, единственный выход — `sandbox-gw` с белым списком путей к шлюзу подписок (роль `llm`) и MCP-шлюзу. Долгоживущих секретов внутри нет, presigned-ссылок S3 тоже: файлы кладёт и забирает хост, коммит и push делает доверенная сторона (§8, §14).
6. **Пайплайн агент не меняет.** Выкладка — только обязательным пайплайном (в Gitea — workflow из `platform/ci`; для GitHub и GitLab клиента — открытый вопрос §20). Дифф агента отклоняется, если трогает пути CI (`.gitea/`, `.github/`, `.gitlab-ci.yml`, `.gitlab/`, `.forgejo/`, `.woodpecker*`, `.drone.yml`, `Jenkinsfile`, `bitbucket-pipelines.yml`, `.circleci/`), `.gitmodules` или `SiteAdapter.protectedPaths()` (§10).
7. **Квоты и кошелёк — через `credit_ledger`.** Резерв в `credit_holds` при постановке в очередь: на тарифе с квотой — одна правка, на «Оплате за действие» — сумма резерва по классу модели. Списание при `done` (на «Оплате за действие» — цена по `pricing_rules` из `token_usage` шлюза подписок по опубликованным учётным ставкам, не больше резерва; оценки по вине платформы не выставляются), возврат резерва при `failed` и `cancelled`. На тарифе с квотой учётная себестоимость попытки — не больше 135, 285 и 735 ₽ для `light`, `standard` и `heavy`. У каждой записи — ключ идемпотентности. Уточнение и «Изменить» — не новая задача, «Отменить» бесплатно (§17).
8. **Агент-агностичность.** Ядро знает только порты из `packages/domain`: `AgentDriver` и общие события (`started`, `message`, `command`, `file_change`, `tool_call`, `question`, `usage`, `completed`, `failed`), `SandboxProvider`, `TurnExecutor`, `TurnCredentialSource`, `TurnAssignmentStore`, `SiteLeaseStore`, `LlmBackend`, `GitProvider`, `SiteAdapter`, `SecretStore`, `ObjectStorage`, `JobQueue`. Никаких `if (driver === 'codex')`, `if (backend === 'openai-chatgpt')`, `if (provider === 'github')` или `if (cms === 'wordpress')` вне адаптера (§8, §13).
9. **Деньги — Decimal.** Цены показываем в ₽ с НДС. Суммы клиента — `Decimal(12,2)` и `Decimal(14,2)`; учётные ставки моделей — ₽ за 1 млн токенов с НДС, `Decimal(14,6)`, с историей (`effective_from`) и ставкой НДС `Decimal(5,4)`, утверждаются раз в квартал; стоимость аккаунта подписки — ₽ в месяц, `Decimal(12,2)`, с историей; себестоимость — `Decimal(18,10)`; наценка — `Decimal(8,4)`. Округление HALF_UP до копеек — один раз на действие. В DTO и API деньги — строки.
10. **Клиенту — по-русски и на «вы».** Без жаргона и английских терминов; `client_message` уходит клиенту как есть и проходит zod-схему итога хода (§8).

## Как писать код

- **Порты и адаптеры.** `packages/domain` — ядро: `DomainError`, порты и zod-схемы общих событий и итога хода; бизнес-логика со временем переезжает сюда. domain не зависит ни от одного пакета репозитория.
- Адаптеры реализуют порты и зависят только от domain: `db`, `storage`, `vault`, `git-providers`, `sandbox-providers`, `agent-drivers`, `llm-backends` (с P3), `site-adapters`, `yookassa`, `mail`, `telegram`. Реализации одного порта — в одном пакете: `git-providers` — gitea, github, gitlab; `sandbox-providers` — docker; `agent-drivers` — codex, kimi, qwen, opencode (qwen и opencode — код P1, выключен, в продукт не входит); `llm-backends` — openai-chatgpt, kimi-code; `site-adapters` — wordpress, bitrix.
- Выше адаптеров — сервисы (`auth`, `notifications`), транспорт (`trpc`) и `ui`. Приложения (`web`, `orchestrator`, `e2e`) — точка сборки: создают адаптеры и подставляют их в порты. Зависимости только вниз, пакеты не импортируют приложения; слои проверяет dependency-cruiser.
- `observability` — сбоку от слоёв, только серверный код приложений: health, метрики, bearer-токен, `errorMessage` и `throttledLogger`. Зависит только от domain и `@prometheus-io/client`; импортируют его только приложения. Чистые помощники без ввода-вывода, нужные и доверенному коду (`withTimeout`, разбор env: `parseEnv`, `envVar`, `envProblems`, `Env`), — в domain.
- Пакеты называются `@repo/<имя>`.
- zod на всех границах: вебхуки, tRPC, итог хода агента, события драйверов.
- Деньги в коде — Decimal (decimal.js), не `number`. В DTO и API — строки с фиксированным числом знаков (`toFixed`), их проверяют zod-схемы.
- Новая переменная окружения — сразу в `.env.example` и в `globalEnv` в `turbo.json`. Переменные, которые подставляет только compose app-ВМ (`APP_DOMAIN`, `ACME_*`, образы и т. п.), — в `infra/app/env.example`: приложения их не читают.
- Ошибки домена — `DomainError`, как в AnyNote.
- Статусы задачи — только из §7: `queued`, `preparing`, `running`, `awaiting_user`, `awaiting_approval`, `deploying`, `verifying`, `done`, `failed`, `rolled_back`, `cancelled`.
- Бакеты — `raditi-inbox`, `raditi-sessions`, `raditi-logs`, `raditi-artifacts`, `raditi-backups`, `raditi-platform` (§14).
- Метрики — `@prometheus-io/client`. В метки не кладём `task_id`, `user_id` и другие идентификаторы; Prometheus — не источник для биллинга.
- Тесты рядом с кодом (Vitest). Всё, что трогает деньги, квоты, Vault, выкладку и откат, — только с тестами.
- Применённые миграции не редактируем: изменения схемы и CHECK-ограничений — следующей миграцией с сохранением данных.
- Коммиты — Conventional Commits на английском (релизы собирает semantic-release), по одной задаче из roadmap.
- Язык: общение и документы — русский; код, идентификаторы и комментарии — английский; тексты интерфейса — русский.

## Как работать в этом репозитории

1. Перед задачей прочитай её строку в `docs/plan/roadmap.md` и указанные разделы spec.
2. Задача трогает больше трёх файлов — сначала план, потом код.
3. Похожий код сначала ищи в `../AnyNote` (агент `anynote-scout`) и адаптируй под правила выше, а не копируй вслепую.
4. В конце — `pnpm typecheck && pnpm lint && pnpm test` для затронутых пакетов и `pnpm check-architecture`.
5. Перед коммитом — `/spec-check`.
6. Если решение меняется — обнови `docs/spec.md` и скажи об этом в ответе.

## Локальная разработка на macOS

gVisor работает только на Linux. На Mac песочница запускается с `SANDBOX_RUNTIME=runc`; изоляцию под `runsc` проверяй в Linux-ВМ (OrbStack, Colima, Lima) или на dev-сервере. Код раннера не должен зависеть от runtime — он приходит из конфигурации.

## Бренд

Название — «Радити» (со старославянского — «забота»), домен raditi.ru. В коде и инфраструктуре — `raditi`: бакеты `raditi-*`, имя корневого пакета `raditi`. Пакеты — в scope `@repo/*`, как в AnyNote (решение от 26.09.2026).

## Расхождения в документах — спросить перед реализацией

- **Подключение сайта.** Spec §12 — мастер с доступами SSH, FTP и входом в админку. `docs/business.md` §2 и лендинг — «в один клик» через плагин «Радити», без SSH и FTP. Какой путь в MVP и как при плагине выкладывать код — решает владелец продукта. От ответа зависят публикация кода и `GitProvider`.
- **Выкладка для сайтов в GitHub или GitLab клиента.** Код идёт через `GitProvider`, а выкладывает пайплайн клиента. Как это совместить с правилами 3 и 6 — открытый вопрос (§20).
- **Оплата за действие.** Открыто: платит ли клиент за `rolled_back`; сгорает ли остаток кошелька и как возвращать аванс; чеки 54-ФЗ на аванс (касса с признаком `advance` или `full_prepayment` плюс чеки зачёта); налоговый режим; минимальное пополнение. Спросить до M5.
- **Учётные ставки и цена кредита Codex.** У подписки нет цены за токен. Ставку модели выводит владелец — у Codex из цены кредита (в рублях она не опубликована), у Kimi из цены Open Platform с множителем квоты — и утверждает раз в квартал; без ставки ключ хода не выдаётся. Нужны до проверки владельца в P3; НДС и окончательные значения — с бухгалтером до M5.
- **Получатель данных в Kimi.** Юрлицо и страна не установлены: соглашение Kimi называет Beijing Moonshot (КНР), условия Kimi OpenPlatform — Moonshot AI PTE. LTD. (Сингапур). Устанавливаются по фактической покупке и условиям в аккаунте, заключение юриста — до гейта 152-ФЗ. До него `kimi-code` на реальных данных выключен.
- **Подписки для реальных данных.** Личные подписки нарушают условия OpenAI и Kimi — риск блокировки владелец принял. ChatGPT Business или API вместо них — решение до гейта 152-ФЗ вместе с юристом.
- **Открытые вопросы** — spec §20. Там же 33 вопроса проекта P3 с решениями по умолчанию, которые ждут подтверждения владельца (номера — как в `docs/research/2026-09-subscriptions/p3-design.md` §17), и вопросы юристу по трансграничной передаче.
