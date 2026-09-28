# Радити

AI-поддержка сайтов малого бизнеса: владелец пишет в чат — агент меняет сайт. Домен — raditi.ru.

Каркас B0–B5 собран: монорепозиторий, веб-приложение с входом и юридическими страницами,
оркестратор, схема данных, очередь писем, локальная инфраструктура и мониторинг.
Чат, выполнение правок на сайтах и биллинг ещё предстоит реализовать в этапах PoC и MVP.
P1 добавляет разбор событий четырёх CLI и зашифрованные снимки сессий с проверкой восстановления.
Локальная часть P2 добавляет Docker-провайдер, шлюз для runc, супервизор, аренду с эпохами
и доверенную Git-публикацию. P2 остаётся открытой: нужны Linux/runsc-сеть, восстановление
незавершённого хода и пилотный pull-runner; [проверки и границы](docs/plan/03-p2-verification.md).
Границы и проверка P1 — в [отчёте](docs/plan/02-p1-verification.md).

## Локальный запуск

Нужны Node из `.nvmrc`, pnpm из `package.json` и работающий Docker Desktop (macOS) или Docker (Linux).
В репозитории используйте `pnpm`, а не `npm`/`npx`.

```sh
nvm use
pnpm install --frozen-lockfile
cp .env.example .env
```

Копируйте `.env.example` только при первом запуске. В `.env` задайте `BETTER_AUTH_SECRET`:
подойдёт значение, созданное `openssl rand -base64 48`. Остальные значения подходят для локальной инфраструктуры.

```sh
pnpm infra:up
pnpm db:generate
pnpm db:deploy
pnpm db:seed
pnpm dev
```

Web: http://localhost:3000, core: http://localhost:8081/health, MCP: http://localhost:8082/health.
Останавливайте `pnpm dev` через Ctrl-C (SIGINT). Юридические страницы содержат заглушки реквизитов;
перед публикацией нужна проверка юристом.

`pnpm db:deploy` применяет новые миграции без сброса данных; `pnpm db:seed` безопасно повторять.
Применённые SQL-миграции не редактируйте — создавайте следующую через `pnpm db:migrate`.
На томе PostgreSQL от старого bootstrap обновите роли идемпотентным скриптом:

```sh
docker compose -f infra/dev/docker-compose.yml exec -T postgres \
  psql -U raditi -d postgres -v ON_ERROR_STOP=1 < infra/dev/postgres-init.sql
```

## Проверки

```sh
DATABASE_URL=postgresql://raditi:raditi@localhost:5432/raditi pnpm gates
pnpm format:check
pnpm e2e
```

`gates` проверяет окружение, типы, линтер, архитектурные слои, тесты и сборку.
Для тестов базы задавайте `DATABASE_URL` явно: без него интеграционные тесты БД пропускаются.
Перед `pnpm e2e` остановите `pnpm dev`. Smoke-набор сам запускает web на 3100 и core/MCP на 8181/8182,
проверяет главную, юридическую страницу и health всех трёх приложений, затем останавливает процессы.
Инфраструктура должна оставаться запущенной.

## Инфраструктура и мониторинг

`pnpm infra:up`, `infra:down`, `infra:logs` управляют PostgreSQL, Redis, SeaweedFS, OpenBao и Gitea.
Дополнительные профили: `site` — WordPress на 8080, `monitoring` — Prometheus на 9090 и Grafana на 3030,
`llm` — LiteLLM (удаляется в P3: профиль станет фейками подписок Codex и Kimi и локальным прокси выхода),
`ci` — раннер Gitea, `monitoring-host` — cAdvisor на Linux.

```sh
docker compose --env-file .env -f infra/dev/docker-compose.yml --profile monitoring --profile site up -d
```

Проверяются обязательные цели и цели включённых профилей. Выключенные дополнительные цели
ожидаемо отображаются как DOWN; подробности — в [инструкции мониторинга](infra/dev/monitoring/README.md).
Ключи моделей и регистрация раннера нужны только для соответствующих профилей.

## Где что находится

| Путь | Содержимое |
| --- | --- |
| `apps/web` | Next.js: вход, кабинет-заглушка, юридические страницы, API |
| `apps/orchestrator` | NestJS: роли core и MCP, очередь, outbox, уведомления; runner — заглушка |
| `apps/e2e` | Smoke-тесты Playwright |
| `packages` | Domain, порты и адаптеры, Prisma, auth, tRPC, UI |
| `infra/dev` | Docker Compose и мониторинг |
| `docs/spec.md` | Спецификация и архитектура |
| `docs/plan/roadmap.md` | Готовность этапов и следующие задачи |
| `CLAUDE.md`, `.claude/` | Правила и команды для работы с проектом |

Локальные секреты храните в `.env`, личные заметки — в `CLAUDE.local.md`: оба файла исключены из Git.
На macOS песочница использует `runc`; `runsc + gateway` явно отклоняется до проверки изоляции на Linux (P2).
