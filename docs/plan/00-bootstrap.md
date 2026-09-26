# Первый шаг: каркас монорепозитория

Цель — рабочий монорепозиторий Радити по образцу AnyNote, в котором можно сразу браться за задачи PoC. Бизнес-логики на этом шаге нет: только структура, конфиги, порты, заготовки адаптеров и схема данных.

## Исходные данные

- Образец: `../AnyNote` (github.com/anynoteinc/anynote). Сначала — разведка агентом `anynote-scout`, потом план, потом код.
- Решения владельца от 26.09.2026 — в CLAUDE.md и spec; исследования и версии — в `docs/research/2026-09-bootstrap/`. Где AnyNote расходится с ними, берём решения: MUI 9, а не v6; Vitest вместо Jest, ts-jest и ts-node; генератор `prisma-client` вместо `prisma-client-js`; Yandex SmartCaptcha вместо reCAPTCHA; `@trpc/tanstack-react-query` вместо `@trpc/react-query`; `@rekog/mcp-nest` 2 — код версии 1.9 из AnyNote не переносится.
- Структура и роли пакетов — docs/spec.md §6. Компоненты — §5. Бакеты — §14. Vault — §15. Схема данных — §16. Тарифы — §17 и docs/business.md §6.
- Локальная инфраструктура уже описана в `infra/dev/docker-compose.yml`; переменные — в `.env.example`.

## Порядок

B0 → B1 → B3 → B2 → B4 → B5. Пакеты идут раньше приложений: приложения собирают адаптеры в порты. После каждого шага — `pnpm install` и `pnpm typecheck`; дальше не идём, пока шаг не зелёный. Один шаг — один коммит (Conventional Commits).

## B0. Документы

- spec, CLAUDE.md, docs/business.md, roadmap и этот файл приведены к решениям от 26.09.2026.
- Отчёты исследований — в `docs/research/2026-09-bootstrap/`.

## B1. Корень репозитория

- Взять из AnyNote: `package.json` (переименовать в `raditi`), `pnpm-workspace.yaml`, `turbo.json`, базовые `tsconfig`, ESLint и Prettier, конфиг dependency-cruiser и скрипт `check-architecture`, commitlint и semantic-release.
- Версии:
  - Node 26.10 — в `.nvmrc`, `engines` и `devEngines.runtime`; pnpm 12.6 — через `devEngines.packageManager`, поле `packageManager` не нужно;
  - вся настройка pnpm — в `pnpm-workspace.yaml`: `catalog`, `allowBuilds` (prisma, `@prisma/engines`, `@swc/core`, esbuild);
  - Turborepo 2.11;
  - TypeScript: `tsc` 7.0 проверяет типы, пакет `typescript` — 6.0 через псевдоним `npm:@typescript/typescript6` для typescript-eslint, dependency-cruiser, Nest CLI и `next build`. В базовом tsconfig — `rootDir` и `types`, без `baseUrl`;
  - ESLint 10 без `eslint-plugin-react` и `eslint-config-next`; Vitest 5, для Nest — unplugin-swc; ts-node и Jest не переносим.
- Слои dependency-cruiser — порты и адаптеры (CLAUDE.md, «Как писать код»): `domain` ни от чего не зависит; адаптеры (db, storage, vault, git-providers, sandbox-providers, agent-drivers, site-adapters, yookassa, mail, telegram) зависят только от `domain`; выше — сервисы (auth, notifications), транспорт (trpc) и ui; приложения — точка сборки; пакеты не импортируют приложения.
- В `turbo.json` → `globalEnv` — все переменные из `.env.example`.
- Корневые скрипты для инфраструктуры: `infra:up`, `infra:down`, `infra:logs` (обёртки над `docker compose --env-file .env -f infra/dev/docker-compose.yml`).
- GitHub Actions: workflow `ci` — typecheck, lint, test, check-architecture, build на Node 26 и pnpm 12 (действие установки pnpm 12 проверить); workflow `release` — semantic-release с `@semantic-release/github`, changelog и git.

## B3. Пакеты

- `domain` — только типы, интерфейсы и zod-схемы, без реализации:
  - `DomainError`, как в AnyNote;
  - `AgentDriver` и `AgentEvent` (`started`, `message`, `command`, `file_change`, `tool_call`, `question`, `usage`, `completed`, `failed`); `parseEvent` возвращает массив событий, `sessionState` — что упаковать в `home.tar.zst`; zod-схема итога хода из §8 с тестом на пример из spec;
  - `SandboxProvider`, `GitProvider`, `SiteAdapter` из §13 (с `protectedPaths()`), `SecretStore`, `ObjectStorage`, `JobQueue`.
- Адаптеры из AnyNote с минимальной адаптацией: `db`, `storage`, `yookassa`, `mail`, `telegram`. Всё, что относится к продукту AnyNote, убрать. `storage` реализует `ObjectStorage`, знает бакеты `raditi-*`; presigned и multipart — TODO для M2 (загрузки из браузера; внутри песочницы presigned-ссылок нет).
- Новые адаптеры — заготовки, реализующие порты:
  - `vault` → `SecretStore`: KV v2, Transit, SSH, AppRole, wrapping (§15);
  - `git-providers` → `GitProvider`: `gitea` (репозитории, секреты и переменные Actions, PR, вебхуки, §10), `github`, `gitlab`;
  - `sandbox-providers` → `SandboxProvider`: `docker` на dockerode, runtime — из `SANDBOX_RUNTIME`;
  - `agent-drivers` → `AgentDriver`: `codex`, `kimi`, `qwen`, `opencode`;
  - `site-adapters` → `SiteAdapter`: `wordpress` (`protectedPaths`: `wp-config.php`, `wp-admin/`, `wp-includes/`), `bitrix` (`/bitrix/`).
- Сервисы:
  - `auth` — better-auth 1.7 из AnyNote, телеметрия выключена явно. reCAPTCHA заменить своим плагином Yandex SmartCaptcha на `hooks.before`: регистрация, вход, сброс пароля, письмо подтверждения; заголовок `x-captcha-response`; запрос без успешной проверки пропускаем, только если Яндекс недоступен: сетевая ошибка, 5xx или 429. Ключи `SMARTCAPTCHA_SERVER_KEY` и `SMARTCAPTCHA_CLIENT_KEY`: пустые в dev — капча выключена, в проде обязательны;
  - `notifications`.
- `trpc` — tRPC 11.19 на `@trpc/tanstack-react-query`; деньги в DTO — строки.
- `ui` — MUI 9.4 на Emotion, `@mui/material-nextjs/v16-appRouter`.

## B2. Приложения

- `apps/web`: Next.js 16.3 и React 19.3, сборка на Turbopack (без `--webpack`).
  - Route groups `(about)` (пока заглушка, лендинг — задача M8), `(auth)`, `(protected)`.
  - MDX (`@next/mdx`, `mdx-components.tsx`). Юридические документы из AnyNote, адаптированные под Радити: пользовательское соглашение, оферта, политика конфиденциальности, согласие на обработку ПДн, согласие на рассылки, сведения об операторе. Реквизиты — заглушки `[НАЗВАНИЕ]`, `[ИНН]`, `[ОГРН]`, `[АДРЕС]`, `[ПОЧТА]`; налоговые разделы — под ООО с НДС 22% и чеки 54-ФЗ; реестр документов один; пометка «нужна проверка юристом».
  - `/api/health` проверяет базу, Redis, S3 и Vault; `/api/metrics` — по Bearer `METRICS_TOKEN`.
- `apps/orchestrator`: NestJS 12.1 (ESM), один образ, роль выбирается конфигурацией при запуске.
  - `core`: модули `health`, `metrics`, `queue` (`@nestjs/bullmq`, Redis), `outbox` (relay — заготовка), `tasks` (пустая машина состояний со статусами §7), `drivers` (реестр драйверов — пока пустой), `sandbox` (`SandboxProvider` из конфигурации), `cron` (job schedulers BullMQ).
  - `mcp`: `health` и MCP-сервер на `@rekog/mcp-nest` 2 (Streamable HTTP) без инструментов, на своём порту.
  - `runner`: заглушка, реализация — P2.
  - `/metrics` — по `METRICS_TOKEN`, библиотека `@prometheus-io/client`.
- `apps/e2e`: Playwright 1.63, один smoke-тест: главная, `/api/health` и health оркестратора отвечают.

## B4. Схема данных v1

- Prisma строго `7.10.0` (тег `latest` у CLI указывает на 8.0 RC), генератор `prisma-client` с `output`, `PrismaPg`, `prisma.config.ts`.
- Таблицы из §16: users, user_consents, workspaces, members, channel_identities, sites, environments, credential_refs, chat_sessions, tasks, task_turns, task_events, attachments, snapshots, deployments, agent_drivers, subscription_accounts, subscriptions, orders, outbox_events, audit_log, site_leases (аренда сайта, §7), git_repositories, mcp_calls.
- Биллинг: `plans` (kind QUOTA, PAYG, PACK), `pricing_rules`, `llm_providers`, `llm_models` (класс модели), `llm_model_prices`, `token_usage`, `billing_accounts` (unit EDIT, RUB), `credit_holds`, `credit_ledger` (ключ идемпотентности).
- Деньги — Decimal всегда с явной точностью (Decimal без `@db` даёт `decimal(65,30)`):
  - суммы клиента — `Decimal(12,2)`, балансы и журнал — `Decimal(14,2)`;
  - цены провайдеров — ₽ за 1 млн токенов с НДС, `Decimal(14,6)`, с `effective_from` и ставкой НДС `Decimal(5,4)`;
  - себестоимость — `Decimal(18,10)`, наценка — `Decimal(8,4)`;
  - CHECK-ограничения — вручную в SQL миграции: баланс не меньше нуля, записи в правках — целые.
- Статус задачи — enum из §7. В `credential_refs` — только путь в Vault, тип и `key_version`.
- Сиды (идемпотентные):
  - `plans`: «Старт» 4900.00 ₽, 30 правок в месяц, до 5 в день, 1 сайт; «Бизнес» 12900.00 ₽, 80, до 10, 3 сайта; «Агентство» 39900.00 ₽, 250, до 30, 15 сайтов; пакет из 10 правок — 1990.00 ₽; «Оплата за действие» — 0.00 ₽ (docs/business.md §6).
  - `pricing_rules` для «Оплаты за действие» по классам моделей (гипотеза): наценка 2.0000, фикса 30.00 ₽, минимум 50.00 ₽, резерв 300.00 / 600.00 / 1500.00 ₽ для лёгкого, стандартного и тяжёлого класса.
  - `agent_drivers`: `codex`, `kimi` — включены; `qwen`, `opencode` — выключены.
  - `llm_providers`, `llm_models`, `llm_model_prices`: точные цены за 1 млн токенов с НДС, ставка НДС 0.2200, ссылка на прайс. В docs/business.md §5 цены округлены — точные в `docs/research/2026-09-bootstrap/billing.md` §2.

## B5. Локальная инфраструктура и мониторинг

- `docker compose --env-file .env -f infra/dev/docker-compose.yml up -d` поднимает PostgreSQL, Redis, SeaweedFS (бакеты `raditi-*` создаёт `s3-init`), OpenBao в dev-режиме и Gitea с Actions.
- Образы закреплены: postgres 17.11, redis 8.10.2, seaweedfs 4.47, aws-cli 2.37.4, openbao 2.7.0, gitea 1.27.3-rootless, gitea/runner 4.0.0 (вместо устаревшего act_runner), litellm v1.102.1 по digest, mariadb 11.4.13, wordpress 7.1.2-php8.3. Порты — только на `127.0.0.1`.
- Redis — для BullMQ: `appendonly yes`, `maxmemory-policy noeviction`.
- Профиль `monitoring`: Prometheus 3.15, Grafana 13.2 без телеметрии наружу (источники данных и дашборды — из файлов), postgres-exporter, redis_exporter, blackbox-exporter. Профиль `monitoring-host` — cAdvisor, только Linux.
- Цели Prometheus: SeaweedFS, OpenBao, Gitea, gitea/runner, LiteLLM (отдельный порт метрик), web `/api/metrics` и orchestrator `/metrics` по `METRICS_TOKEN`. В метки не кладём `task_id` и `user_id`.
- Новые переменные (`METRICS_TOKEN`, `SMARTCAPTCHA_*` и другие) — в `.env.example` и `globalEnv`.
- Для задач с выкладкой нужен сайт с SSH: добавить в compose отдельный профиль с SSH-доступом к тестовому WordPress, когда дойдём до P8.

## Критерии готовности

- `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm check-architecture` — зелёные локально и в GitHub Actions.
- `pnpm dev` поднимает web и orchestrator в ролях `core` и `mcp`; `/api/health` и health оркестратора видят базу, Redis, S3 и Vault.
- Миграция применяется к локальной базе, сиды — включая «Оплату за действие» и правила цены — можно запускать повторно.
- Smoke-тест в `apps/e2e` проходит.
- С профилем `monitoring` Grafana видит Prometheus, все цели — в состоянии `up`.
- CLAUDE.md обновлён: «Состояние», «Команды», «Структура».
