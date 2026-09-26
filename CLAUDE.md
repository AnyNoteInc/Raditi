# Радити

Радити (raditi.ru) — сервис для малого бизнеса: владелец пишет в веб-чат или Telegram, что поменять на сайте, и AI-агент меняет его сайт — в MVP на WordPress, дальше на 1С-Битрикс и других CMS. Контент правится прямо на сайте со снимком для отката, код — через git-репозиторий сайта (наша Gitea или GitHub/GitLab клиента): ветка, PR, «Применить», выкладка с бэкапом, проверкой и автооткатом. Окружение у сайта одно — прод.

## Где что читать

| Файл | Когда открывать |
| --- | --- |
| `docs/spec.md` | Архитектура и решения. Перед задачей читай нужный раздел (§N ниже — его разделы) |
| `docs/business.md` | Портрет клиента, тарифы, квоты, «Оплата за действие», себестоимость задачи |
| `docs/plan/roadmap.md` | Этапы, гейты и задачи с ID (B1, P4, M5…) — отмечай выполненное |
| `docs/plan/00-bootstrap.md` | Первый шаг: развернуть монорепозиторий |
| `docs/research/2026-09-bootstrap/` | Исследования к `/bootstrap`: версии, очередь, песочница, биллинг, капча, мониторинг. Откуда взялись решения владельца от 26.09.2026 |
| `docs/landing/` | Прототип лендинга для `apps/web` `(about)` |
| `docs/model/Raditi_unit_economics.xlsx` | Модель юнит-экономики |
| `../AnyNote` | Образец структуры и пакетов — только чтение |

## Состояние

Каркас готов (`/bootstrap`, B0–B5, 26.09.2026): монорепозиторий, пакеты-порты и адаптеры, `apps/web`, `apps/orchestrator` (роли `core` и `mcp`; `runner` — заглушка до P2), `apps/e2e`, схема данных v1 с миграциями и сидами, локальная инфраструктура с мониторингом. Работают вход по почте и паролю с согласиями, юридические страницы, health и метрики, outbox → BullMQ → письма. P1 добавляет парсеры четырёх CLI и выбор файлов сессии, зашифрованные снимки ходов в S3 и проверяемое восстановление через порт Sandbox; отчёт — `docs/plan/02-p1-verification.md`. Следующий шаг — P2: Docker-провайдер и раннер. Запуск CLI с моделями — P4/P5; бизнес-логика задач, git-провайдеры и оплата ещё впереди (`docs/plan/roadmap.md`). Реквизиты оператора в юридических текстах — заглушки (`apps/web/content/legal/README.md`).

Локальные проверки и границы результата — `docs/plan/01-bootstrap-verification.md`; GitHub Actions нужно подтвердить после отправки ветки.

## Стек

- Node 26.10 (в прод — после перехода ветки 26 в LTS 28.10.2026), pnpm 12.6, Turborepo 2.11, TypeScript strict: типы проверяет `tsc` 7.0, а пакет `typescript` — 6.0 через псевдоним (typescript-eslint, dependency-cruiser и Nest CLI с TS 7 не работают). ESLint 10, Vitest 5 (для Nest — unplugin-swc), zod 4.6; слои проверяет dependency-cruiser (`pnpm check-architecture`).
- `apps/web` — Next.js 16.3 (App Router), React 19.3, MUI 9.4, MDX: лендинг `(about)` и юридические страницы, вход `(auth)`, кабинет и веб-чат `(protected)`; tRPC 11.19 (`@trpc/tanstack-react-query`), better-auth 1.7 с Yandex SmartCaptcha, SSE-поток задачи, вебхуки Telegram, ЮKassa и git-провайдеров.
- `apps/orchestrator` — NestJS 12.1 (ESM). Один код и один образ, три роли запуска:
  - `core` — жизненный цикл задач, квоты, воркеры BullMQ, cron, управление песочницами, публикация в git;
  - `mcp` — MCP-шлюз к сайтам (WP-CLI, REST, Playwright): отдельный процесс и порт, своя AppRole в Vault и своя роль в PostgreSQL без доступа к биллингу. Кроме LLM-шлюза, это единственное, куда ходит песочница;
  - `runner` — pull-раннер на песочной ВМ: сам забирает ходы, владеет контейнерами, входящих портов нет, аренда с эпохой (этап P2).
- `apps/e2e` — Playwright 1.63.
- `packages/*` — порты и адаптеры (см. «Как писать код»): ядро `domain`; адаптеры `db` (Prisma 7.10, генератор `prisma-client`, PrismaPg), `storage`, `vault`, `git-providers`, `sandbox-providers`, `agent-drivers`, `site-adapters`, `yookassa`, `mail`, `telegram`; сервисы `auth`, `notifications`; транспорт `trpc`; `ui`.
- Очередь — Redis 8.10 + BullMQ 6.3 через `@nestjs/bullmq` 12:
  - истина о задаче — `tasks.status` в PostgreSQL; постановка в очередь — атомарно с записью в БД через `outbox_events` и relay в `core`;
  - `awaiting_user` и `awaiting_approval` — статус плюс отложенная задача-таймер BullMQ, а не висящий job;
  - строго один ход, выкладка или откат на сайт — аренда сайта в PostgreSQL;
  - cron — job schedulers BullMQ; живой поток задачи — история в `task_events` плюс Redis pub/sub между репликами web.
- Инфраструктура: PostgreSQL 17, Redis 8 (appendonly, `maxmemory-policy noeviction`), S3 (в проде — российское облако, локально SeaweedFS), OpenBao, Gitea 1.27 + gitea/runner — для репозиториев сайтов и реестра образов песочниц, LiteLLM не ниже 1.83.7 (один экземпляр, в изолированном сегменте), Docker 29 + gVisor (`runsc`, systrap), свой реестр образов (Docker Hub отвечает 403 для российских IP).
- Наблюдаемость: Prometheus + Grafana (локально — профиль `monitoring`), метрики — `@prometheus-io/client`. Sentry — позже, только свой сервер в России.
- Код платформы — на GitHub: CI и релизы — GitHub Actions (typecheck, lint, test, check-architecture, build; semantic-release с `@semantic-release/github`). Выкладка платформы на ВМ через GitHub Actions — задача M10.

## Команды

Node 26.10 (`nvm use`) и pnpm 12.6. `npm` и `npx` внутри репозитория не работают (`devEngines`), вместо них — `pnpm` и `pnpm dlx`.

- `cp .env.example .env` и задать `BETTER_AUTH_SECRET` (`openssl rand -base64 48`); `pnpm install`.
- `pnpm infra:up` / `infra:down` / `infra:logs` — PostgreSQL, Redis, SeaweedFS (+ бакеты `raditi-*`), OpenBao dev, Gitea. Профили (`--profile` или `COMPOSE_PROFILES` в `.env`): `site` — тестовый WordPress на :8080, `llm` — LiteLLM на :4000, `ci` — gitea/runner, `monitoring` — Prometheus :9090 и Grafana :3030, `monitoring-host` — cAdvisor (только Linux). Если `docker compose` висит на «Error getting credentials» — ответьте на запрос связки ключей macOS.
- `pnpm db:migrate` (новая миграция в dev), `pnpm db:deploy` (применить), `pnpm db:seed` (справочники, повторный запуск безопасен), `pnpm db:generate`.
- `pnpm dev` — web :3000, orchestrator :8081 (core) и :8082 (mcp). Останавливать Ctrl-C (SIGINT): SIGTERM оставляет дочерние процессы.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm check-architecture`, `pnpm check-env`; всё сразу — `pnpm gates`.
- Тесты `@repo/db` с базой: `DATABASE_URL=postgresql://raditi:raditi@localhost:5432/raditi pnpm --filter @repo/db test` (без переменной они пропускаются).
- `pnpm e2e` — smoke на поднятой инфраструктуре (web на :3100, core на :8181, mcp на :8182); `pnpm dev` перед этим остановить.
- `pnpm --filter orchestrator verify:snapshots` — локальная интеграционная проверка P1 на SeaweedFS + OpenBao из `.env`: временные синтетические данные, без моделей; свой Transit-ключ и S3-объекты удаляются после проверки.
- Health: web `/api/health`, orchestrator `/health` — публично только status; подробности web и core — с `Authorization: Bearer $METRICS_TOKEN`, MCP всегда только status. Метрики — `/api/metrics` и `/metrics` с тем же токеном.

## Структура

```
apps/
  web/            Next.js: (about) и /terms (MDX из content/legal), (auth), (protected), onboarding, api/{auth,trpc,health,metrics,webhooks/yookassa}
  orchestrator/   NestJS: config, roles (core, mcp, runner), health, metrics, queue (BullMQ), outbox relay, notifications, tasks, drivers, sandbox, mcp
  e2e/            Playwright smoke
packages/
  domain/         ядро: порты, общие события и итог хода (zod), статусы §7, политика песочницы и путей диффа, реестр юридических документов, APP_ENV
  db/             Prisma: схема v1, миграции, сиды, клиент PrismaPg, outbox
  storage vault git-providers sandbox-providers agent-drivers site-adapters yookassa mail telegram — адаптеры
  auth notifications — сервисы; trpc — транспорт; ui — MUI-тема, формы входа, SmartCaptcha
  eslint-config typescript-config — общие конфиги
infra/dev/        docker compose, конфиги LiteLLM, раннера, Prometheus и Grafana
docs/             spec, business, план, исследования, лендинг
.github/          CI и релизы (GitHub Actions)
```

## Правила, которые нельзя нарушать

1. **Данные клиентов — только в России.** Модели — Yandex AI Studio, Cloud.ru (только модели на серверах Cloud.ru), GigaChat. База, S3, логи — у российских провайдеров. Никаких OpenAI, Anthropic, Google API с данными клиентов (152-ФЗ).
2. **Секреты — только в Vault.** В базе — `credential_refs` (путь в Vault), в коде, логах, S3 и Git — никогда. Форма доступов пишет в Vault и не умеет читать обратно. Сервисы входят по AppRole со своими политиками (§15). Локально ключи провайдеров можно держать в `.env`.
3. **Прод один.** Код попадает на сайт только после «Применить»: бэкап → выкладка → проверка → автооткат. Контент меняется сразу, но перед правкой — снимок в `raditi-artifacts`; «Отменить» работает 7 дней (§7, §10, §11).
4. **Опасное — только через `request_approval`.** Удаление страниц, смена темы, плагины, настройки оплаты, массовые правки (больше 20 объектов). Пользователи и заказы сайта агенту недоступны.
5. **Песочница.** Задача — логическая сессия, контейнер — на один ход; в `awaiting_user` и `awaiting_approval` контейнера нет, сессия лежит в `raditi-sessions`. Docker + gVisor (`runsc`, systrap): dockerd от root, в контейнере uid 10001, read-only rootfs, cap-drop ALL, no-new-privileges, 2 vCPU, 4 ГБ, 512 процессов, 20 минут на ход; граница изоляции — gVisor. Сеть — internal без DNS и интернета, единственный выход — `sandbox-gw` с белым списком путей к LiteLLM и MCP-шлюзу. Долгоживущих секретов внутри нет, presigned-ссылок S3 тоже: файлы кладёт и забирает хост, коммит и push делает доверенная сторона (§8, §14).
6. **Пайплайн агент не меняет.** Выкладка — только обязательным пайплайном (в Gitea — workflow из `platform/ci`; для GitHub и GitLab клиента — открытый вопрос §20). Дифф агента отклоняется, если трогает пути CI (`.gitea/`, `.github/`, `.gitlab-ci.yml`, `.gitlab/`, `.forgejo/`, `.woodpecker*`, `.drone.yml`, `Jenkinsfile`, `bitbucket-pipelines.yml`, `.circleci/`), `.gitmodules` или `SiteAdapter.protectedPaths()` (§10).
7. **Квоты и кошелёк — через `credit_ledger`.** Резерв в `credit_holds` при постановке в очередь: на тарифе с квотой — одна правка, на «Оплате за действие» — сумма резерва по классу модели. Списание при `done` (на «Оплате за действие» — цена по `pricing_rules` из токенов журнала LiteLLM, не больше резерва), возврат резерва при `failed` и `cancelled`. У каждой записи — ключ идемпотентности. Уточнение и «Изменить» — не новая задача, «Отменить» бесплатно (§17).
8. **Агент-агностичность.** Ядро знает только порты из `packages/domain`: `AgentDriver` и общие события (`started`, `message`, `command`, `file_change`, `tool_call`, `question`, `usage`, `completed`, `failed`), `SandboxProvider`, `GitProvider`, `SiteAdapter`, `SecretStore`, `ObjectStorage`, `JobQueue`. Никаких `if (driver === 'codex')`, `if (provider === 'github')` или `if (cms === 'wordpress')` вне адаптера (§8, §13).
9. **Деньги — Decimal.** Цены показываем в ₽ с НДС. Суммы клиента — `Decimal(12,2)` и `Decimal(14,2)`; цены провайдеров — ₽ за 1 млн токенов с НДС, `Decimal(14,6)`, с историей (`effective_from`) и ставкой НДС `Decimal(5,4)`; себестоимость — `Decimal(18,10)`; наценка — `Decimal(8,4)`. Округление HALF_UP до копеек — один раз на действие. В DTO и API деньги — строки.
10. **Клиенту — по-русски и на «вы».** Без жаргона и английских терминов; `client_message` уходит клиенту как есть и проходит zod-схему итога хода (§8).

## Как писать код

- **Порты и адаптеры.** `packages/domain` — ядро: `DomainError`, порты и zod-схемы общих событий и итога хода; бизнес-логика со временем переезжает сюда. domain не зависит ни от одного пакета репозитория.
- Адаптеры реализуют порты и зависят только от domain: `db`, `storage`, `vault`, `git-providers`, `sandbox-providers`, `agent-drivers`, `site-adapters`, `yookassa`, `mail`, `telegram`. Реализации одного порта — в одном пакете: `git-providers` — gitea, github, gitlab; `sandbox-providers` — docker; `agent-drivers` — codex, kimi, qwen, opencode; `site-adapters` — wordpress, bitrix.
- Выше адаптеров — сервисы (`auth`, `notifications`), транспорт (`trpc`) и `ui`. Приложения (`web`, `orchestrator`, `e2e`) — точка сборки: создают адаптеры и подставляют их в порты. Зависимости только вниз, пакеты не импортируют приложения; слои проверяет dependency-cruiser.
- Пакеты называются `@repo/<имя>`.
- zod на всех границах: вебхуки, tRPC, итог хода агента, события драйверов.
- Деньги в коде — Decimal (decimal.js), не `number`. В DTO и API — строки с фиксированным числом знаков (`toFixed`), их проверяют zod-схемы.
- Новая переменная окружения — сразу в `.env.example` и в `globalEnv` в `turbo.json`.
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
- **Открытые вопросы** — spec §20.
