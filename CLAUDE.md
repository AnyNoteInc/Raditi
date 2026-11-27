# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Радити

Радити (raditi.ru) — сервис для малого бизнеса: владелец пишет в веб-чат или Telegram, AI-агент (OpenCode CLI с моделью GLM на Z.ai) делает работу в песочнице и в облачном браузере, публикует страницы (`<slug>.pages.raditi.ru`) и артефакты.

Язык: общение и документы — русский; код, идентификаторы и комментарии — английский; тексты интерфейса — русский. Клиенту — по-русски, на «вы», без жаргона.

## Где что читать

Этот файл — короткий. Подробности — в документах, читай нужное перед задачей:

- `docs/spec.md` — архитектура и решения (§N в коде и планах — его разделы; §20 — решения владельца и открытые вопросы).
- `docs/plan/roadmap.md` — этапы и задачи с ID (B1, P4, M5…); отмечай выполненное.
- `docs/plan/NN-*.md` — план и отчёт каждой крупной работы. Самые новые номера — текущее состояние. Сейчас важны: 83 (проекты-сайты, Gitea, предпросмотры и `/release` удалены), 84 (проекты в новом смысле — чаты по делу с инструкциями, контекстом, памятью и репозиторием GitHub/GitLab клиента), 88 (артефакты), 89 (план работы агента), 93 (артефактов четыре вида: «Документ», «Холст», «Презентация», «Изображение»; остальные удалены).
- `docs/business.md` — клиент, тарифы, кредиты.
- `docs/research/` — исследования, из которых взялись решения.

Многое в коде и документах о сайтах клиента, предпросмотре, выпуске (`/release`), Gitea и стеках — история после плана 83. «Проект» до плана 83 (сайт клиента) и «проект» плана 84 — разные вещи.

## Команды

Node 26.10 (`nvm use`), pnpm 12.6. `npm`/`npx` в репозитории не работают (`devEngines`) — только `pnpm` и `pnpm dlx`.

```sh
cp .env.example .env          # один раз; задать BETTER_AUTH_SECRET (openssl rand -base64 48)
pnpm install
pnpm infra:up                 # PostgreSQL, Redis, SeaweedFS, OpenBao dev (+ vault:bootstrap)
pnpm db:generate && pnpm db:deploy && pnpm db:seed
pnpm dev                      # web :3000, core :8081, mcp :8082, llm :8084, preview :8090, browser
```

- Проверки: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm check-architecture` (dependency-cruiser), `pnpm check-env`, `pnpm test:infra`; всё сразу — `pnpm gates`.
- Один пакет: `pnpm --filter <name> test` (`core`, `web`, `@repo/db`…). Один файл или тест — Vitest напрямую: `pnpm --filter core exec vitest run src/path/file.test.ts -t "имя теста"`.
- Тесты с базой — `pnpm verify:db` (одноразовая PostgreSQL, миграции, сверка со `schema.prisma`, интеграционные наборы пакетов).
- Миграции: `pnpm db:migrate` — новая миграция в dev; `pnpm db:deploy` — применить.
- `pnpm verify:*` — стенды на одноразовых сервисах в Docker (рабочий `.env` не читают): `verify:artifacts`, `verify:projects`, `verify:billing`, `verify:browser-task`, `verify:pages`, `verify:opencode`, `verify:vault`, `verify:images` и др. — у каждого README в `infra/dev/<имя>-verify/`.
- E2E: `pnpm e2e` (smoke; `pnpm dev` остановить, нужны миграции и сиды); браузерные наборы — `pnpm --filter e2e test:site`, `test:billing`, `test:landing`.
- `apps/runner` в `pnpm dev` не входит: `pnpm --filter runner build`, работает на песочной ВМ или в стендах.

## Архитектура

Монорепозиторий Turborepo. Пакеты — `@repo/<имя>`.

**Приложения — отдельные процессы со своим образом** (`apps/*`):
- `web` — Next.js (App Router), MUI, tRPC, better-auth: лендинг, кабинет, веб-чат (`/chats`), проекты, запланированные задачи, артефакты, настройки и биллинг; SSE-поток задачи, вебхуки (Telegram, ЮKassa, git-провайдеры, запуски расписаний от `core`).
- `core` — NestJS: жизненный цикл задач и ходов агента (очередь BullMQ `agent-turns`), квоты и кредиты, песочницы и зашифрованные снимки сессий в S3, доверенный git (зеркала репозиториев, бандл хода, `git-worker` без секретов), расписания, облачный браузер, API раннеров, outbox, уведомления, быстрые правки артефактов (один вызов модели через `llm` на `zai-api`, без песочницы, очередь `artifact-edits`, план 98). Redis — только у `core`.
- `llm` — шлюз к модели; единственный процесс с ключом провайдера (ключи хода с бюджетом).
- `mcp` — MCP-шлюз и ретранслятор MCP-серверов пространства (ключи — в Vault).
- `preview` — отдача опубликованных страниц; `browser` — worker облачного браузера и трансляция; `runner` — pull-раннер песочницы (gVisor).

Каждое Nest-приложение устроено одинаково: `main.ts` → `start.ts` → `src/app.module.ts` (`AppModule.forRoot`), `src/config/` — своя zod-схема и только свои переменные окружения; разделы — каталоги со своими модулями. Общий запуск — `@repo/app-bootstrap`, Prisma и `/health` — `@repo/service-runtime`.

**Слои пакетов (проверяет `pnpm check-architecture`, это правила, а не вкус):**
- `packages/domain` — ядро: `DomainError`, порты (`AgentDriver`, `SandboxProvider`, `LlmBackend`, `GitProvider`, `SecretStore`, `ObjectStorage`, `JobQueue`, `CloudBrowserSession`…) и zod-схемы общих событий и итога хода. Ни от чего в репозитории не зависит.
- Адаптеры реализуют порты и зависят только от domain: `db` (Prisma), `storage`, `vault`, `git-providers`, `sandbox-providers`, `browser-providers`, `agent-drivers`, `llm-backends`, `snapshots`, `yookassa`, `mail`, `telegram`…
- Выше — сервисы (`auth`, `billing`, `notifications`, `local-turns`, `turn-keys`, `browser-link`, `doc-render`…), транспорт `trpc` и `ui`. `observability` — сбоку, только серверный код приложений.
- Границы процессов — тоже правила dependency-cruiser (`llm-minimal-packages`, `mcp-minimal-packages`…): `llm` не тянет хранилища, git, песочницу и платежи даже транзитивно.
- Ядро агент-агностично: знает только порты и общие события домена, не конкретную оболочку.

Стенды: стенд одного приложения — в его `scripts/`, стенд нескольких — в `apps/core/scripts`; стенды грузят классы из `dist`.

## Правила, которые нельзя нарушать

Полные формулировки и исключения — spec и планы; здесь — суть.

1. **Хранилища — в России, модель — GLM на Z.ai.** База, S3, логи, снимки — только у российских провайдеров. Других провайдеров моделей нет.
2. **Секреты — только в Vault** (`kv/workspaces/<id>/env/…`, `…/git/…`, `…/mcp/…`, `kv/platform/…`). Не в БД, не в `.env` клиента, не в песочнице.
3. **Агент не отправляет, не сливает и не выкатывает в репозиторий клиента.** Коммит хода живёт в зеркале Радити; ветка `raditi/…`, запрос на слияние, принятие и выкладка — только по доверенной карточке клиента (HMAC, ожидаемая голова).
4. **Опасное — только через `request_approval`/доверенную карточку**; слова модели разрешением не считаются.
5. **Песочница** без учётных данных git и без секретов; git и gitleaks — у доверенной стороны в `core`.
6. **Настройки сборки (CI) агент без клиента не меняет**: дифф путей CI — только после отдельной карточки.
7. **Кредиты — через `credit_ledger`**: резерв в `credit_holds` при постановке в очередь, списание при `done`, возврат при `failed`/`cancelled`.
8. **Деньги — Decimal** (decimal.js), не `number`; в API — строки `toFixed`, проверяемые zod. Цены — в ₽ без НДС, о чеках и НДС в текстах для клиента не пишем.
9. **Клиенту — по-русски и на «вы»**; `client_message` проходит zod-схему итога хода.

## Как писать код

- zod на всех границах: вебхуки, tRPC, итог хода, события драйверов.
- Новая переменная окружения — сразу в `.env.example` и в `env` задачи `test` в `turbo.json` (в `globalEnv` — только общее: `APP_ENV`, `CI`, `NODE_ENV`; `pnpm check-env` проверяет объединение); читает её только приложение, чей `config.ts` её называет.
- Статусы задачи — только из spec §7: `queued`, `preparing`, `running`, `awaiting_user`, `awaiting_approval`, `deploying`, `verifying`, `done`, `failed`, `rolled_back`, `cancelled`.
- Бакеты — `raditi-inbox`, `raditi-sessions`, `raditi-logs`, `raditi-artifacts`, `raditi-backups`, `raditi-platform`.
- В биллинге `credit` — только существительное «кредит» (единица клиента); платёж не «credited», а «applied». Личное пространство создаёт `ensurePersonalWorkspaceWithGift` из `@repo/billing` (с подарком), не `ensurePersonalWorkspace` из `@repo/db`.
- Метрики — `@prometheus-io/client`, без идентификаторов (`task_id`, `user_id`) в метках.
- Тесты рядом с кодом (Vitest). Деньги, квоты, Vault, git-публикация — только с тестами. Фикстуры биллинга — `@repo/billing/testing` (только из тестов). Тесты приложений-ролей идут под сторожем сети `@repo/app-bootstrap/testing/network-guard`.
- Тест, читающий файл вне своего пакета, называет его в `inputs` задачи `test` в `turbo.json` (`$TURBO_ROOT$/…`), иначе turbo вернёт устаревший результат из кэша.
- Применённые миграции не редактируем — только следующая миграция с сохранением данных; связанные команды — в `BEGIN`/`COMMIT`.
- Коммиты — Conventional Commits на английском (semantic-release), по одной задаче roadmap.

## Как работать

1. Перед задачей — её строка в `docs/plan/roadmap.md` и указанные разделы spec / плана.
2. Задача трогает больше трёх файлов — сначала план, потом код.
3. В конце — `pnpm typecheck && pnpm lint && pnpm test` для затронутых пакетов и `pnpm check-architecture`.
4. Перед коммитом — `/spec-check` (агент `spec-reviewer`).
5. Если решение меняется — обнови `docs/spec.md` (и план) и скажи об этом в ответе.
6. Расхождение между документами или с решением владельца — спросить перед реализацией. Действует указание владельца «принимай все решения по умолчанию»: вопрос с названным значением по умолчанию работу не останавливает.

На macOS gVisor нет: песочница локально — `SANDBOX_RUNTIME=runc`, изоляцию под `runsc` проверять в Linux-ВМ (Colima, OrbStack, Lima). Код раннера не зависит от runtime.
