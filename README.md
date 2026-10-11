# Радити

AI-поддержка сайтов малого бизнеса: владелец пишет в чат — агент меняет сайт. Домен — raditi.ru.

Каркас B0–B5 собран: монорепозиторий, веб-приложение с входом и юридическими страницами,
оркестратор, схема данных, очередь писем, локальная инфраструктура и мониторинг.
Чат, выполнение правок на сайтах и биллинг ещё предстоит реализовать в этапах PoC и MVP.
P1 добавляет разбор событий четырёх CLI и зашифрованные снимки сессий с проверкой восстановления.
P2 добавляет Docker-провайдер, шлюз, супервизор, аренду с эпохами, доверенную Git-публикацию
и pull-runner с восстановлением незавершённого хода. Изоляция и восстановление проверены
в Linux-ВМ с runsc; [проверки и границы](docs/plan/03-p2-verification.md).
Границы и проверка P1 — в [отчёте](docs/plan/02-p1-verification.md).
Локально реализованы шлюз подписок (P3, B2–B14), драйверы Codex и Kimi (P4, P5) и основа MCP
с контентом WordPress (P6). Ревью 02–03.10.2026 прошло это дерево в два прохода; что исправлено,
чем проверено и что осталось открытым — [отчёт ревью](docs/plan/29-review-2026-10.md).
С 11.10.2026 (G8) в дереве одна оболочка — OpenCode CLI с GLM на Z.ai: драйверы Codex и Kimi, код qwen
и OAuth удалены, продукт переключён миграцией и сидами ([отчёт](docs/plan/48-removal.md)).

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

Web: http://localhost:3000, core: http://localhost:8081/health, MCP: http://localhost:8082/health,
шлюз подписок: http://127.0.0.1:8084/health (`ORCHESTRATOR_ROLES=core,mcp,llm`). Без прокси узла выхода
(четыре `LLM_EGRESS_*` пусты) dev-шлюз идёт прямым путём: допуск открыт, к провайдеру он соединяется сам
и только к Z.ai. С заданным mTLS-прокси через него идут все провайдеры, допуск открывает успешная проба
канала, иначе шлюз отвечает `degraded`. Темп и потолок вызовов одного ключа хода задают
`LLM_MAX_CALLS_PER_KEY_30S` и `LLM_MAX_CALLS_PER_KEY` ([отчёт G4](docs/plan/43-zai-gateway-stand.md));
[основной шлюз B9](docs/plan/16-p3-main-gateway.md), [здоровье пула B10](docs/plan/17-p3-pool-health.md) (обновление токенов из него удалено в G8),
[ключи хода B11](docs/plan/18-p3-turn-keys.md), [операторские команды B12](docs/plan/19-p3-subscription-commands.md).
B9–B14 реализованы и проверены локально, в том числе стенд шлюза с CLI в контейнерах (B13) и production-профиль `llm` (B14).
Приёмка P3 по решению владельца от 05.10.2026 — живой проход на GLM и решение владельца. Живой проход сделан
10.10.2026 командами `pnpm verify:llm-gateway --live` и `pnpm verify:agent-content --live`
([отчёт G6](docs/plan/45-zai-live.md)); в тот же день переписан текст контракта итога хода, и узкий замер
`pnpm verify:llm-gateway --live --results` дважды дал 10 валидных итогов из 10 — две короткие серии
([отчёт об итоге хода](docs/plan/46-turn-result-glm.md)); решение владельца и полный продуктовый e2e с WordPress
остаются открытыми.

Для проверок окон из `core` задайте `LLM_CONTROL_URL` частным origin шлюза: его Host должен
входить в `LLM_GATEWAY_HOSTS`, адрес `core` — в `LLM_GATEWAY_CLIENTS`; авторизация —
`METRICS_TOKEN`. В production адрес задаётся явно. Без него неизвестные окна остаются
в ожидании; доступ к токенам подписки в `subs/` роли `core` не нужен.
Останавливайте `pnpm dev` через Ctrl-C (SIGINT). Юридические страницы содержат заглушки реквизитов;
перед публикацией нужна проверка юристом.

`pnpm infra:up` после запуска контейнеров сам настраивает dev-OpenBao (`pnpm vault:bootstrap`): mounts
`turns/`, `subs/`, `kv/` и `transit/` и восемь политик; повторный запуск ничего не меняет. Dev-OpenBao хранит данные
в памяти: после пересоздания контейнера `vault` (`pnpm infra:down`, перезапуск Docker) секреты пропадают —
в аккаунты подписок нужно войти заново, доступы сайтов и ключи рабочих пространств — создать заново.
[Подробности](infra/vault/README.md).

`pnpm db:deploy` применяет новые миграции без сброса данных; `pnpm db:seed` безопасно повторять.
Перед подключением команды `db:*` печатают строку `[db] target <user>@<host>/<db>` и откуда взят
`DATABASE_URL` — из `.env` репозитория или из окружения; экспортированная переменная важнее `.env`.
Применённые SQL-миграции не редактируйте — создавайте следующую через `pnpm db:migrate`.
Миграция `20261011090000_switch_to_opencode` переключает базу на одну оболочку — OpenCode — и останавливается,
ничего не изменив, если в базе остался невыведенный аккаунт Codex или Kimi с сохранённым входом либо
незавершённая задача прежней оболочки; что сделать до неё и как выйти из остановки — [отчёт](docs/plan/48-removal.md).
Все сервисы, миграции, сиды и экспортёр используют одного пользователя PostgreSQL `raditi`,
владельца базы и схемы. На томе от старого bootstrap примените переход идемпотентным скриптом:

```sh
docker compose -f infra/dev/docker-compose.yml exec -T postgres \
  psql -U raditi -d raditi -v ON_ERROR_STOP=1 < infra/dev/postgres-init.sql
```

## Проверки

```sh
DATABASE_URL=postgresql://raditi:raditi@localhost:5432/raditi pnpm gates
pnpm format:check
pnpm e2e
pnpm verify:vault
pnpm verify:site
pnpm verify:db
P2_GITLEAKS_BINARY=/абсолютный/путь/gitleaks pnpm verify:gitea
pnpm verify:pipeline
pnpm verify:site-connect
```

`gates` проверяет формат, окружение, типы, линтер, архитектурные слои, тесты, тесты инфраструктуры и сборку.
Для тестов базы задавайте `DATABASE_URL` явно: без него тесты с базой пропускаются. Обычный путь для них —
`pnpm verify:db` на одноразовой PostgreSQL; интеграционные наборы orchestrator
(`pnpm --filter orchestrator test:db`, `RADITI_GATEWAY_DB_TESTS=1`) меняют общие строки справочников
и идут только на такой базе.
Перед `pnpm e2e` остановите `pnpm dev`. Smoke-набор сам запускает web на 3100 и core/MCP на 8181/8182,
проверяет главную, юридическую страницу и health всех трёх приложений, затем останавливает процессы.
Инфраструктура должна оставаться запущенной, миграции и сиды — применены (`pnpm db:deploy && pnpm db:seed`):
главная показывает тарифы из базы. Экспортированные `DATABASE_URL` и `REDIS_URL` важнее `.env`.

`verify:vault` проверяет клиент KV v2 и Transit и реальные политики, включая роли `mcp` и `core` под AppRole
и отказ роли `llm` в записи секрета подписки, на одноразовом локальном OpenBao.
`verify:site` проверяет настоящую страницу локального WordPress: снимок → изменение → публичный HTTP → восстановление.
`verify:db` применяет миграции на отдельной PostgreSQL, сверяет схему с `schema.prisma`, проверяет единого пользователя `raditi`,
переход со старых ролей, переключение на OpenCode на базе прежних оболочек настоящими командами Prisma,
сиды на этой базе и на новой — каталог одной оболочки, повторный запуск ничего не меняет, — затем запускает
четыре набора тестов: базы, orchestrator, tRPC и web. [Подробности](infra/dev/db-verify/README.md).
`verify:gitea` проверяет git хода на одноразовой Gitea 1.27.3 по HTTPS: доступы на чтение и запись со сроком,
клон, push в `agent/<taskId>`, отказ диффу с `.gitea/`. Нужен `P2_GITLEAKS_BINARY`.
[Подробности](infra/dev/gitea-verify/README.md), [отчёт](docs/plan/32-gitea-turn-git.md).
`verify:pipeline` — спайк пайплайна сайта на одноразовых Gitea 1.27.3, раннерах gitea/runner 4.0.0 и OpenBao:
обязательный workflow из `ci/`, вебхуки, одноразовая обёртка, откат.
[Подробности](infra/dev/pipeline-verify/README.md), [отчёт](docs/plan/34-gitea-pipeline-spike.md).
`verify:site-connect` проверяет локальное подключение сайта: команда `infra/dev/site-verify/connect-local.mjs`
на одноразовых PostgreSQL, OpenBao и Gitea и профиле `site` dev compose под собственным проектом пишет доступ
в OpenBao, привязывает плагин, создаёт ключ рабочего пространства и репозиторий и переводит сайт в `active`;
затем штатная роль `mcp` правит страницу. Сначала собирается orchestrator.
[Подробности](infra/dev/site-verify/README.md), [отчёт](docs/plan/36-local-site-connect.md).
Эти проходы используют отдельные ресурсы и удаляют их после проверки; нужны уже загруженные образы и локальный Docker.
По указанию владельца от 30.09.2026 облачная выкладка отложена до полного локального e2e через агента,
«Применить», бэкап, проверку и откат. [Критерии](infra/dev/site-verify/README.md); подготовительная проверка страницы этот гейт не закрывает.

## Инфраструктура и мониторинг

`pnpm infra:up`, `infra:down`, `infra:logs` управляют PostgreSQL, Redis, SeaweedFS, OpenBao и Gitea.
Дополнительные профили: `site` — WordPress на 8080 (тип окружения `local`, плагин «Радити» в `mu-plugins`
только на чтение; подключение сайта к платформе — `infra/dev/site-verify/README.md`, «Локальное подключение сайта»),
`monitoring` — Prometheus на 9090 и Grafana на 3030, `ci` — раннер Gitea, `monitoring-host` — cAdvisor на Linux.

```sh
docker compose --env-file .env -f infra/dev/docker-compose.yml --profile monitoring --profile site up -d
```

Проверяются обязательные цели и цели включённых профилей. Выключенные дополнительные цели
ожидаемо отображаются как DOWN; подробности — в [инструкции мониторинга](infra/dev/monitoring/README.md).
Для профиля `ci` нужна регистрация раннера. Шлюз подписок на синтетическом провайдере и с локальным прокси выхода
проверяется отдельным стендом — [инструкция](infra/dev/llm-verify/README.md).
Production-профиль `llm` находится в `infra/app`; облачная выкладка остаётся за гейтом WordPress e2e.
Основной шлюз, ключи хода и операторские команды реализованы в B9–B12; обновителя токенов и входа по коду
с G8 нет: секрет подписки — ключ плана, роль `llm` его только читает ([отчёт](docs/plan/48-removal.md)).
Новые аккаунты импортируются выключенными; действующий порядок входа, повторного входа и вывода — spec §15
и отчёт G8, а [runbook B12](docs/plan/19-p3-subscription-commands.md) — история: он описывает ещё device-вход
и автоматический отзыв токенов. B13 и B14 проверены локально: общий проход с CLI, синтетическим провайдером
и production-профилем `llm`; [отчёт B14](docs/plan/21-p3-app-llm.md).

Образ стека песочницы задаёт `SANDBOX_IMAGE=…@sha256:<digest>` вместо `SANDBOX_IMAGE_PREFIX`; драйвер получает
этот образ. В production переменная обязательна, нулевой digest-заглушка из `.env.example` отклоняется.
Вне production незаданное значение заменяется этой заглушкой: `core` стартует, но ни один ход на ней
не запустится. Рабочий `.env` автоматически не меняется.

Драйвер OpenCode 1.18.34 — единственный драйвер пакета — проверяется отдельно:

```sh
docker build -f infra/sandbox/Dockerfile --target runtime -t raditi-g3verify-sandbox:local .
pnpm verify:opencode
```

Проход идёт в контейнерах без сети на сценарном провайдере: ход, продолжение из файлов сессии,
враждебные репозиторий и база сессии, отказы MCP, код в рабочей копии и в домашнем каталоге CLI.
С `--runtime runsc` на демоне с gVisor те же сценарии идут под gVisor. Полный проход через супервизор,
pull-раннер, зашифрованные снимки и локальную Git-публикацию — `pnpm verify:opencode-supervisor`:
Docker Desktop для одноразовых PostgreSQL/S3/OpenBao и локальная Linux-ВМ с gVisor для раннера;
рабочий `.env` не читается. Ключ плана и подписки не нужны; [отчёт G3](docs/plan/42-opencode-driver.md).
Драйверы Codex и Kimi и их стенды (`verify:codex`, `verify:codex-supervisor`, `verify:kimi-supervisor`)
удалены в G8 ([отчёт](docs/plan/48-removal.md)).

Первый локальный блок P6 защищает `/mcp` токеном хода и предоставляет `site_info`
с публичным адресом и стеком назначенного сайта. Проверка на отдельной PostgreSQL —
`pnpm verify:db`; настройка точных upstream Host — `MCP_ALLOWED_HOSTS`, обязательна для роли
`mcp` в production. Добавлена локальная основа зашифрованных снимков и долговременного
журнала: повтор ответа и блокировка незавершённой записи сохраняются после перезапуска.
В явно включённом локальном профиле подключены ограниченный `wp_rest`, `restore`, маскирование
контактов, обратный откат хода и восстановление по квитанции сайта. Доверенный возврат правок идёт
по ограждению аренды сайта, без ключа хода: откат перед заменой хода, возврат правок незавершённого хода
и «Отменить» завершённой задачи под арендой `revert` ([отчёт](docs/plan/35-content-host-undo.md)); вызовы
из очереди и интерфейса ещё впереди. Проверка настоящего
WordPress с PostgreSQL, S3 и Vault — `pnpm verify:mcp-content` (Docker Desktop или обычный Docker
на Linux; в CI — workflow `wordpress-content.yml`). Та же правка настоящим OpenCode
CLI через `sandbox-gw` и роли `llm` и `mcp`, на синтетическом провайдере, —
`pnpm verify:agent-content` (в CI — workflow `agent-content.yml`; строки Codex и Kimi удалены в G8,
после удаления на GitHub стенд ещё не выполнялся);
[отчёт](docs/plan/30-agent-content-stand.md), [строка OpenCode](docs/plan/44-agent-content-opencode.md).
С флагом `--live` оба стенда — этот и `pnpm verify:llm-gateway` — идут на настоящем GLM (`api.z.ai`): только
вручную, с ключом плана в окружении команды (`ZAI_API_KEY`), только с синтетикой, не в CI; `--rehearsal` — тот же
код на синтетическом Z.ai, без ключа. С G7 репетиции записаны шагами CI после детерминированного прохода
(`llm-gateway.yml`, `agent-content.yml`) и на GitHub идут с 11.10.2026
([отчёт G7](docs/plan/47-common-scenarios-zai.md)). У стенда шлюза есть ещё `--live --results` — узкий замер итога хода:
десять ходов, не больше 20 запросов провайдеру и 10 минут (`infra/dev/llm-verify/README.md`, «Живой режим»;
[отчёт G6](docs/plan/45-zai-live.md), [отчёт об итоге хода](docs/plan/46-turn-result-glm.md)).
Контент в запущенной роли включает `MCP_CONTENT_PROFILE=local` (по умолчанию `off` — только `site_info`;
в production допустим только `off`): доступ сайта роль читает из Vault по ссылке `credential_refs` —
[отчёт](docs/plan/33-mcp-role-content-resolver.md); production-подключение и продуктовый откат остаются в P6. Границы и повтор —
[доступ MCP](docs/plan/24-p6-mcp-access.md), [снимки и журнал](docs/plan/25-p6-content-journal.md),
[контент WordPress](docs/plan/26-p6-wordpress-content.md).

## Где что находится

| Путь | Содержимое |
| --- | --- |
| `apps/web` | Next.js: вход, кабинет, юридические страницы, API |
| `apps/orchestrator` | NestJS: роли core, MCP, llm (шлюз подписок) и pull-runner; очередь, outbox, уведомления |
| `apps/e2e` | Smoke-тесты Playwright |
| `packages` | Domain, порты и адаптеры, Prisma, auth, tRPC, UI |
| `infra/dev` | Docker Compose, мониторинг и локальные стенды (`db-verify`, `site-verify`, `gitea-verify`, `pipeline-verify`, `llm-verify`) |
| `ci` | Обязательные workflow сайтов для `platform/ci` в Gitea (пока подменные шаги) |
| `infra/app`, `infra/sandbox`, `infra/egress` | app-ВМ, песочная ВМ и узел выхода к провайдерам моделей |
| `infra/vault`, `infra/wordpress` | Политики и bootstrap Vault; плагин контента для WordPress |
| `docs/spec.md` | Спецификация и архитектура |
| `docs/plan/roadmap.md` | Готовность этапов и следующие задачи |
| `CLAUDE.md`, `.claude/` | Правила и команды для работы с проектом |

Локальные секреты храните в `.env`, личные заметки — в `CLAUDE.local.md`: оба файла исключены из Git.
На macOS песочница использует `runc`; `runsc` со шлюзом требует Linux и настройки изоляции из P2.
