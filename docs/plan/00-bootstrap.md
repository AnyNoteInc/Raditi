# Первый шаг: каркас монорепозитория

Цель — рабочий монорепозиторий Радити по образцу AnyNote, в котором можно сразу браться за задачи PoC. Бизнес-логики на этом шаге нет: только структура, конфиги, заготовки и схема данных.

## Исходные данные

- Образец: `../AnyNote` (github.com/anynoteinc/anynote). Сначала — разведка агентом `anynote-scout`, потом план, потом код.
- Структура и роли пакетов — docs/spec.md §6. Компоненты — §5. Бакеты — §14. Vault — §15. Схема данных — §16.
- Локальная инфраструктура уже описана в `infra/dev/docker-compose.yml`; переменные — в `.env.example`.

## B1. Корень репозитория

- Взять из AnyNote: `package.json` (переименовать в `raditi`), `pnpm-workspace.yaml`, `turbo.json`, базовые `tsconfig`, ESLint и Prettier, конфиг dependency-cruiser и скрипт `check-architecture`, commitlint и semantic-release, `.nvmrc` (версия Node — как в AnyNote).
- Слои dependency-cruiser: приложения → UI → домен → инфраструктурные сервисы → чистые адаптеры. Новые пакеты раскладываются так: `vault` и `gitea` — адаптеры; `agent-runtime` и `site-adapters` — сервисы.
- В `turbo.json` → `globalEnv` — все переменные из `.env.example`.
- Корневые скрипты для инфраструктуры: `infra:up`, `infra:down`, `infra:logs` (обёртки над `docker compose --env-file .env -f infra/dev/docker-compose.yml`).

## B2. Приложения

- `apps/web`: Next.js 16 как в AnyNote; route groups `(about)` (пока заглушка, лендинг — задача M8), `(auth)`, `(protected)`; маршрут `/api/health` проверяет базу, Redis, S3 и Vault.
- `apps/agents`: NestJS 11 — модули `health`, `queue` (BullMQ, подключение к Redis), `tasks` (пустая машина состояний со статусами §7), `drivers` (реестр драйверов — пока пустой), `sandbox` (интерфейс раннера с `SANDBOX_RUNTIME` из конфигурации).
- `apps/engines`: NestJS 11 — модули `health`, `mcp` (заготовка MCP-сервера на `@rekog/mcp-nest` без инструментов), `cron`.
- `apps/e2e`: Playwright, один smoke-тест: главная и `/api/health` отвечают.

## B3. Пакеты

- Перенести из AnyNote с минимальной адаптацией: `db`, `domain`, `auth`, `trpc`, `ui`, `storage`, `yookassa`, `telegram`, `mail`, `notifications`. Всё, что относится к продукту AnyNote, убрать.
- `storage`: добавить конфиг нескольких бакетов `raditi-*`; presigned и multipart — отметить как TODO для задач P1 и M2.
- Новые пакеты — только типы, интерфейсы и заглушки, без реализации:
  - `agent-runtime`: `AgentDriver`, `AgentEvent` (`started`, `message`, `command`, `file_change`, `tool_call`, `question`, `usage`, `completed`, `failed`), zod-схема итога хода из §8 с тестом на пример из spec.
  - `site-adapters`: `SiteAdapter` из §13 и заготовка `wordpress`.
  - `vault`: интерфейс клиента (KV v2, Transit, SSH, AppRole, wrapping) из §15.
  - `gitea`: интерфейс клиента (репозитории, секреты и переменные Actions, PR, вебхуки) из §10.

## B4. Схема данных v1

- Таблицы из §16: users, user_consents, workspaces, members, channel_identities, sites, environments, credential_refs, chat_sessions, tasks, task_events, attachments, snapshots, deployments, agent_drivers, llm_providers, llm_models, subscription_accounts, plans, subscriptions, orders, credit_ledger, outbox_events, audit_log.
- Деньги — целые копейки. Статус задачи — enum из §7. В `credential_refs` — только путь в Vault, тип и `key_version`.
- Сиды (идемпотентные):
  - `plans`: «Старт» 490 000 коп., квота 30 в месяц, до 5 в день, 1 сайт; «Бизнес» 1 290 000 коп., 80 в месяц, до 10 в день, 3 сайта; «Агентство» 3 990 000 коп., 250 в месяц, до 30 в день, 15 сайтов; пакет из 10 правок — 199 000 коп. (docs/business.md §6).
  - `agent_drivers`: `codex`, `kimi` — включены; `qwen`, `opencode` — выключены.
  - `llm_providers` и `llm_models`: цены за 1 млн токенов из docs/business.md §5, в копейках.

## B5. Локальная инфраструктура

- `docker compose --env-file .env -f infra/dev/docker-compose.yml up -d` поднимает PostgreSQL, Redis, SeaweedFS (бакеты `raditi-*` создаёт `s3-init`), OpenBao в dev-режиме и Gitea с Actions.
- Сверить версии образов с AnyNote (PostgreSQL, Redis) и выровнять.
- Для задач с выкладкой нужен сайт с SSH: добавить в compose отдельный профиль с SSH-доступом к тестовому WordPress, когда дойдём до P8.

## Критерии готовности

- `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm check-architecture` — зелёные.
- `pnpm dev` поднимает web, agents и engines; `/api/health` видит базу, Redis, S3 и Vault.
- Миграция применяется к локальной базе, сиды можно запускать повторно.
- Smoke-тест в `apps/e2e` проходит.
- CLAUDE.md обновлён: «Состояние», «Команды», «Структура», выбранный scope пакетов.
