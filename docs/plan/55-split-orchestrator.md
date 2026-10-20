# План 55. Разделение `apps/orchestrator` на `apps/core`, `apps/mcp`, `apps/llm`, `apps/runner`

Состояние: **сделано (20.10.2026); итог и второй заход по ответам владельца — §10.** План утверждён по вопросам 1–3 (20.10.2026). Решения владельца: (1) шлюз предпросмотров — отдельное `apps/preview`; (2) модули `Infra`, `Health`, `Metrics` собираются в один общий пакет в `packages/` (собираемый, с `dist`; §3.1); (3) реализация доверенного отката остаётся в `apps/mcp`. Остальные вопросы приняты значениями по умолчанию. Работа идёт в отдельном дереве `/Users/victor/Projects/raditi-split`, ветка `refactor/split-orchestrator` от `main` (`970cf27`); основное дерево не меняется.

Опись ниже сделана по реальным импортам (`src`, тесты, `scripts`, стенды `infra`, workflow), скрипт описи — не в репозитории. Числа — строки без тестов / строки тестов.

## 1. Что есть сейчас

Один пакет `orchestrator`: `src` ≈ 56 тыс. строк без тестов (из них 4,1 тыс. — `src/testing`), один `Dockerfile`, один `dist/main.js`, роль выбирает `ORCHESTRATOR_ROLES` (`core`, `mcp`, `llm`, `preview`, `runner`). Каждая роль уже отдельное Nest-приложение (`roles.ts`: пять `start*`), поэтому разрез по процессам готов; не готов разрез по коду.

| Каталог `src` | Строк | Тестов (строк) | Куда |
| --- | --- | --- | --- |
| `mcp` | 7 481 | 11 790 | `apps/mcp` (+ 4 файла в пакет) |
| `llm-gateway` | 3 661 | 8 029 | `apps/llm` (+ `store`, `types` в пакет) |
| `subscriptions` | 1 610 | 3 431 | `apps/llm` (команды `subscriptions:*`) |
| `llm` | 1 595 | 3 269 | пакет `turn-keys`; `llm.module.ts` — `apps/core` |
| `runner` | 1 732 | 1 458 | `apps/runner` |
| `sessions` | 1 332 | 1 757 | 5 файлов в пакет `snapshots`; `snapshot.service` — `apps/core` |
| `preview-gateway` | 1 663 | 1 510 | отдельное приложение или `apps/core` (вопрос 1) |
| `config` | 1 556 | 2 431 | разрезается по приложениям (§4) |
| `infra`, `health`, `metrics`, `version`, `load-env`, `env-file` | ≈ 0,5 тыс. | ≈ 0,5 тыс. | `service-runtime` (§3.1) |
| остальное (`tasks`, `turns`, `previews`, `releases`, `git-workspace`, `deploy-step`, `site-provisioning`, `runner-api`, `billing`, `release-api`, `outbox`, `queue`, `notifications`, `drivers`, `sandbox`, `core`) | ≈ 32 тыс. | ≈ 36 тыс. | `apps/core` |
| `testing` | 4 143 | 172 | по приложениям и `…/testing` пакетов (§3.6) |

### 1.1. Связи, которые надо разорвать (прямые, без тестов)

Приложение приложение не импортирует (`apps-are-isolated` уже в `.dependency-cruiser.cjs`), поэтому каждая строка ниже — вынос.

**`mcp` ← → ядро**
- `mcp` берёт: `llm/turn-key.ts` (формат и хеш ключа хода, 4 файла), `sessions/snapshot-crypto.ts` (2), `previews/{preview-record, preview-content}` (3 файла), `health`, `infra`, `version`, `config`.
- Ядро берёт у `mcp`: `mcp/published-value.ts` (`releases/release-skill`, `releases/undo-planner`), `mcp/preview-db-values.ts` (`PreviewDbValueStorage` — `previews`, `releases`, `tasks`, `previews/db-plan-values`), `mcp/site-content-resolver.ts` (`createSiteContentResolver` — `previews.module`, `releases.module`). То есть ядро и `mcp` в процессе строят один и тот же доступ к содержимому сайта и одно и то же хранилище значений плана БД.
- `config/config.ts` импортирует `mcp/mcp-policy.ts` (`parseMcpHosts`) — поэтому замыкание роли `llm` по `config.ts` втягивает 11 файлов `mcp` (≈ 4,7 тыс. строк). Это артефакт общего конфига, а не настоящая зависимость.

**`llm-gateway` ← → ядро**
- Шлюз берёт `llm/turn-key.ts` (2 файла), `config/llm-config.ts`, `infra/{prisma,tokens}`.
- Ядро берёт у шлюза: `llm-gateway/store.ts` (`PostgresGatewayStore` — `llm/credential-sweeper`) и `llm-gateway/types.ts` (`llm/turn-credentials`). Команды `subscriptions` берут `llm-gateway/{egress, egress-probe, session-lock, credentials}` и `llm/{turn-credentials, backends, turn-key}` — `GatewayTurnCredentials` нужен им при выводе аккаунта (отзыв ключей).
- `config/config.ts` импортирует `llm/pool-probe-client.ts` (`poolControlOrigin`); сам клиент пробы нужен ядру (он ходит в управляющий порт роли `llm`).

**`runner`**: замыкание без `config.ts` — `runner` (6 файлов), `sessions/{archive-validation, presigned-transfer, sandbox-snapshot, snapshot-crypto, snapshot-parts}`, `turns/{local-turn-executor, turn-output, working-tree-export}`, `sandbox/exec`, `git-workspace/base-bundle`, `infra/tokens`. Ни одного пакета платформы (`db`, `vault`, `storage`…): правило `runner-no-platform-access` уже держит это транзитивно. `local-turn-executor` нужен и ядру (`TURN_EXECUTOR=local`).

**Прочее**: `testing/ids.ts` читают 11 модулей; `config/config.ts` ↔ `runner/runner-config.ts`; `tasks/turn-planner` берёт `llm/backends` (`llmGatewayBaseUrl`); `releases` и `tasks` — `llm/site-env-values`.

### 1.2. Что читают стенды и скрипты

- `dist/main.js` — 28 вхождений (запуск ролей с `ORCHESTRATOR_ROLES`).
- Глубокие импорты из `dist/<модуль>/*.js` (≈ 45 вхождений): `mcp/{mcp-content, mcp-access, content-snapshots, mcp-journal, mcp-app.module, content-privacy, mcp-turn-content-rollback, mcp-tools.controller, mcp-server, mcp-content-maintenance}`, `llm/{turn-credentials, pool-probe-client, backends, turn-key, credential-sweeper}`, `llm-gateway/{llm-app.module, egress, credentials}`, `sessions/*`, `turns/*`, `git-workspace/*`, `runner-api/*`, `config/{config, llm-config, runner-tokens}`, `deploy-step/cli`, `infra/tokens`.
- Приложения упоминают `orchestrator`: `infra/app` (9 файлов), `infra/dev/*-verify` и `llm-verify` (≈ 50), `.github/workflows` (9 файлов, 44 строки), `apps/e2e`, `infra/sandbox`, `.sonarcloud.properties` (список `sonar.inclusions` с путями `apps/orchestrator/src/…`), `ci/`, `package.json` (корневые `verify:*`), `turbo.json`, `.dependency-cruiser.cjs`, `docs/` (68 файлов, 52 из них — `docs/plan`, остаются историей).

### 1.3. Находки, которые меняют постановку

1. **Клиента доверенного отката контента нет.** `McpContentService` реализует `TrustedContentUndo` и `McpTurnContentRollback` — но они вызываются только внутри процесса `mcp` и в стендах (`verify-content-turns.mjs`, `mcp-host-undo.integration.test.ts`). Ядро в продукте откатывает через `PreviewTurnRollback` (`tasks/preview-rollback.ts`) — по предпросмотру, а сетевого канала `core → mcp` нет (spec §20, N8). Выносить в пакет нечего; выдумывать клиент — это новый протокол, а его постановка запрещает. Предлагаю: реализация остаётся в `apps/mcp`, стенды берут её из `apps/mcp/dist`; клиент — отдельная задача N8 (вопрос 3).
2. **Пакеты поставляются исходниками TypeScript, их запускает Node (type-stripping, `erasableSyntaxOnly`)**, декораторы там невозможны (`nestjs.json` включает их только в приложениях; во всех пакетах ни одного `@Injectable`). Поэтому `service-runtime` как пакет с готовыми Nest-модулями (`InfraModule`, `HealthModule`, `MetricsModule`) собрать нельзя без сборки пакета в `dist` — новой категории (вопрос 2). Вся декорированная часть — модули, контроллеры, процессоры (38 файлов) — остаётся в приложениях.
3. **Четыре файла из кандидатов на вынос используют синтаксис, который type-stripping не пропускает** (параметры-свойства конструктора, `enum`): `llm-gateway/store.ts` (1 место), `sessions/archive-validation.ts` (1), `turns/local-turn-executor.ts` (13), `mcp/preview-db-values.ts` (2). При переносе их придётся переписать без смены поведения (явные поля и присваивание в конструкторе); тесты этих файлов — защита.
4. **`mcp` в production ещё не выкладывается**: `infra/app/docker-compose.yml` — «mcp joins in P6». Образ и `Dockerfile` для `mcp` делаем сейчас, сервис в compose app-ВМ остаётся там, где его добавит P6.
5. **Образ один, а тянет всё**: `runtime` ставит `git` и `gitleaks` для всех ролей, включая `llm` (единственная, у которой есть ключ провайдера). После разделения у `llm` и `mcp` их не будет — меньше поверхности; это сознательное следствие, а не скрытое изменение поведения.

## 2. Целевая раскладка

```
apps/
  core/      роль core (+ runner-api, release-api, previews, releases, tasks, turns, billing…) и deploy-step
  llm/       роль llm (шлюз) + subscriptions:login|retire|token
  mcp/       роль mcp
  runner/    роль runner
  preview/   шлюз предпросмотров — отдельное приложение (рекомендую) или вторая точка входа core (вопрос 1)
packages/ (новые)
  turn-keys/         ключи хода, выдача, сборщик, клиент управляющего порта llm, хранилище и типы шлюза
  snapshots/         шифрование, части, проверка архива, перенос, снимок песочницы
  local-turns/       исполнитель хода в локальном Docker и то, что нужно раннеру
  site-content/      доступ к содержимому сайта и значениям плана БД — общее для core и mcp
  service-runtime/   каркас без Nest: загрузка env, ConfigError и разбор, listenHost, остановка
```

Порты, пути Vault, AppRole, очереди, миграции, имена переменных окружения и протоколы **не меняются**.

## 3. Пакеты и их границы

Слой каждого — между адаптерами и приложениями (как `billing`): зависят от `domain`, `db`, `observability` и адаптеров, не от приложений. Правило `apps-are-isolated` остаётся; добавляются правила §5.

### 3.1. `@repo/service-runtime` (без Nest)
- Из `load-env.ts`, `env-file.ts` (+ тесты), `version.ts`, частей `roles.ts`: `LOCAL_HOST`, `listenHost`, таймаут и сигналы остановки, `logger` вида `appLogger`.
- Из `config/config.ts`: `ConfigError`, `port()`, `present()`, `isOrigin`, `registrableDomain` — то, что нужно любым двум конфигам.
- Фабрики Prisma/Redis/Vault-клиентов из `infra/*` без декораторов; сами Nest-модули `InfraModule`, `HealthModule`, `MetricsModule` (≈ 400 строк декорированного кода: `infra.module`, `lifecycle`, `health.controller/module`, `metrics.controller/module`) — **по экземпляру в каждом приложении**. Это дублирование ≈ 400 строк × 4; цена за то, что пакеты остаются исходниками. Альтернатива — собираемый пакет (вопрос 2).
- `private-address.ts` идёт в `@repo/domain` (чистая функция без ввода-вывода, нужна `turn-keys`, ядру и конфигу `llm`).

### 3.2. `@repo/turn-keys`
Из `llm/`: `turn-key.ts`, `turn-credentials.ts` (855), `credential-sweeper.ts`, `backends.ts`, `pool-probe-client.ts`, `site-env-values.ts`; из `llm-gateway/`: `store.ts` (760, `PostgresGatewayStore`), `types.ts`. Зависит от `domain`, `db`. В приложениях остаётся:
- `apps/core`: `llm.module.ts` (Nest-обвязка), планировщик и супервизор (потребители);
- `apps/llm`: `server`, `egress*`, `pool-health*`, `credentials`, `session-lock`, `llm-config`, модуль, `subscriptions/*`;
- `apps/mcp`: только `turn-key.ts` (проверка формата и хеш).

### 3.3. `@repo/snapshots`
`sessions/{snapshot-crypto, snapshot-parts, archive-validation, presigned-transfer, sandbox-snapshot}` (≈ 860 строк). Потребители: `runner`, `core` (`snapshot.service` остаётся в core: S3 и Transit), `mcp` (`snapshot-crypto`). Не должен транзитивно достигать `db`, `vault`, `storage`, `ioredis`, `bullmq` — правило `runner-no-platform-access` переезжает на пакет.

### 3.4. `@repo/local-turns`
`turns/{local-turn-executor, turn-output, working-tree-export}`, `sandbox/exec.ts`, `git-workspace/base-bundle.ts` (≈ 1 тыс. строк). Нужен `runner` и `core` (`TURN_EXECUTOR=local`). То же ограничение, что у `snapshots`.

### 3.5. `@repo/site-content`
Из `previews/`: `preview-record`, `preview-transport`, `db-plan-values`, `preview-content`; из `mcp/`: `preview-db-values`, `preview-content` (адаптер к `mcp`), `published-value`, `site-content-resolver` и тип `ContentGatewayResolver`; из `mcp/content-snapshots` — две константы пределов размера. Общее для `core` (строит доступ к предпросмотру и значениям плана) и `mcp` (пишет и читает через него). `ContentGatewayResolver` сейчас зависит от `McpSiteScope | McpJournalScope` из `mcp-journal`/`mcp-content` — в пакет уходит узкий структурный тип `ContentScope` (поля, которые резолвер читает), `mcp` присваивает ему свои типы. Это самое тонкое место выноса (§7, риск 2).

### 3.6. Тесты и `testing`
Каждый новый пакет получает подпуть `./testing` (как `@repo/billing/testing`) со своими фикстурами. Распределение `src/testing/*`: `ids`, `network-guard*`, `fake-redis` — общие, идут в `service-runtime/testing` (каждый `vitest.config` приложения подключает `network-guard.setup`); `fakes`, `llm-certificates`, `turn-credentials`, `snapshots`, `turn-assignments`, `runner-*`, `site-leases`, `crash`, `turn-journal` — по месту использования; остальное (`deploy-step`, `previews`, `releases`, `site-import*`, `file-source`) остаётся в `apps/core`. Правило `orchestrator-product-no-testing` размножается на каждое приложение и пакет. Число тестов по пакетам сравниваю до/после (§6).

## 4. Конфигурация

Сейчас `loadConfig` (≈ 1 тыс. строк) собирает одну схему `ownEnvSchema`, выбирает поля по ролям и проверяет перекрёстное (одинаковые порты при совмещении ролей, общий `METRICS_TOKEN`, зависимость настроек предпросмотра от ядра). Новое:
- Каждое приложение — свой `src/config.ts` со своей схемой и только своими переменными (заменяет «проверку окружения только активных ролей»).
- Общие фрагменты вокруг предпросмотра (`PREVIEW_BASE_DOMAIN`, `PREVIEW_SCHEME`, `PREVIEW_PUBLIC_PORT`, `PREVIEW_UPSTREAM_HOST` читают `core`, `mcp`, `preview`) уже частично в `@repo/domain` (`previewAddressFromEnv`) — остаток уходит туда же.
- Перекрёстные проверки «порты ролей не совпадают» исчезают (процессы раздельны); остаются проверки значений по умолчанию портов и правило «`MCP_PORT` отличен от `ORCHESTRATOR_PORT`» как тест на дефолты. Правило «`METRICS_TOKEN` web ≠ токен `core` и `llm`» живёт в preflight `infra/app`, а не в `loadConfig` — проверю по коду в С3.
- `ORCHESTRATOR_PORT` и остальные имена переменных сохраняются (вопрос 7). `ORCHESTRATOR_ROLES` удаляется по мере выхода приложений и окончательно в С6.
- `pnpm check-env`, `.env.example`, `infra/app/env.example`, `globalEnv` в `turbo.json` — переменные расписываются по приложениям (комментариями-разделами), список имён тот же.

## 5. Срезы

Каждый срез зелёный отдельно и коммитится отдельно по просьбе владельца (`git commit --only`, Conventional Commits на английском). Перед С1 снимаю **базовую линию** на `main`: число тестов по пакетам (`vitest --reporter=json`), результаты стендов из §6. После каждого среза — сравнение: сумма не уменьшилась, перемещения объяснены.

**С1. Правила внутри orchestrator.** В `.dependency-cruiser.cjs`: `mcp/` и `llm-gateway/` (и `subscriptions/`, `runner/`, `preview-gateway/`) не импортируют друг друга и каталоги ядра, кроме списка, который выдаст первый прогон (он и есть список выноса из §1.1). Ожидаемо красное → допускается список временных исключений, который каждый следующий срез сужает до пустого. Коммит с документом плана, без кода продукта.

**С2a. Разрез конфигурации внутри orchestrator.** `config.ts` → `config/{core,mcp,llm,runner,preview}-config.ts` + общий; `parseMcpHosts` и `poolControlOrigin` перестают тянуться из общего файла. Поведение и ошибки `ConfigError` те же (тесты `config.test.ts` переезжают по файлам). После среза замыкания `llm-gateway` и `runner` не содержат `mcp`.

**С2b. Вынос пакетов** — по коммиту на пакет, в порядке `service-runtime` (минимальный) → `snapshots` → `local-turns` → `turn-keys` → `site-content`. Импорты в orchestrator и стендах (`dist/…` → пакет) обновляются в том же коммите. Переписывание четырёх файлов под `erasableSyntaxOnly` — в коммите пакета, которому принадлежит файл.

**С3. `apps/llm`.** Каталог `apps/llm`: `main.ts`, модуль, `config.ts`, `subscriptions/*` (скрипты `subscriptions:*` из `scripts/` переезжают), свои `Infra/Health/Metrics`-модули, `Dockerfile` без `git` и `gitleaks`, `nest-cli.json`, tsconfig, vitest. Роль `llm` исчезает из `roles.ts`, `ORCHESTRATOR_ROLES: llm` — из compose, `infra/app` получает `LLM_IMAGE`. Стенды `verify:llm-gateway`, `verify:llm-app`, `verify:llm-firewall`, `verify:agent-content` переводятся. Первым — потому что держит единственный ключ провайдера и самый узкий набор зависимостей.

**С4. `apps/mcp`.** То же для `mcp`; скрипты стендов, которые берут `dist/mcp/*`, берут `apps/mcp/dist`. Образ `mcp` собирается и проверяется стендами; сервис в production-compose не добавляется (находка 4).

**С5. `apps/runner`.** Роль `runner` + `runner-token` (скрипт `runner-token.mjs` выпускает токен раннера, читает `RUNNER_TOKENS` ядра — оставляю в `apps/core`, обновив импорты; уточню в С5). Правило `runner-no-platform-access` перенесено на `apps/runner/` и пакеты `snapshots`, `local-turns`. `infra/sandbox` получает `RUNNER_IMAGE`.

**С6. Остаток → `apps/core`.** Переименование `apps/orchestrator` → `apps/core` (история через `git mv`), `ORCHESTRATOR_ROLES` и `roles.ts` удаляются, остаются `start` ядра и (по ответу на вопрос 1) шлюз предпросмотров. `deploy-step` остаётся здесь (образ `deploy`-раннера — образ ядра). Обновляются: CLAUDE.md, spec §5/§6/§8/§13–§15/§20, README стендов, `.sonarcloud.properties`.

## 6. Проверки

На каждом срезе, где применимо: `pnpm typecheck && pnpm lint && pnpm test && pnpm check-architecture && pnpm check-env`, затем `pnpm gates`.

| Стенд | Срезы |
| --- | --- |
| `verify:db`, `verify:vault`, `verify:billing` | С2b и далее, на каждом |
| `verify:llm-gateway`, `verify:agent-content`, `verify:mcp-content` | С3, С4, С6 |
| `verify:llm-app`, `verify:llm-firewall`, `verify:edge` (образ из текущего дерева) | С3, С6 |
| `verify:runner`, `verify:opencode-supervisor` (Linux-ВМ под gVisor) | С5; если Colima/ВМ недоступны — прямо скажу «не проверено» |
| `verify:release`, `verify:site-import`, `verify:site-connect`, `verify:pipeline`, `verify:preview-network`, `verify:gitea`, `pnpm e2e` | С6 |

Не запускаю: всё, что идёт к настоящим провайдерам (`--live`). Не читаю `.env`. `verify:release` и `verify:pipeline` — не одновременно (README стенда). Dev-база, dev-OpenBao и основное дерево не затрагиваются; миграций нет.

Для сравнения «до и после»: таблица «пакет → число тестов (прошло / пропущено)» из `vitest --reporter=json` на `main` и после каждого среза, плюс число проверок каждого стенда (CLAUDE.md называет: `verify:db` 566, `verify:release` 196, `verify:billing` 702, `verify:agent-content` 13, `verify:mcp-content` 34, `verify:llm-gateway` 58 и т. д. — перемеряю, а не доверяю).

## 7. Что затрагивается (чек-лист)

- `turbo.json` — задачи новых приложений и пакетов, `globalEnv` (имена не меняются, `ORCHESTRATOR_ROLES` уходит в С6), `inputs` тестов, читающих файлы вне пакета (`.env.example`, оферта и др. — перенести на новые имена).
- `.env.example`, `infra/app/env.example`, `check-env`.
- `.dependency-cruiser.cjs` — правила §1.1 как постоянные; `runner-no-platform-access` и `deploy-step-no-platform-access` на новые пути; `orchestrator-no-trpc-ui` и `orchestrator-product-no-testing` на каждое приложение; новые пакеты в слоях; `billing-testing-only-in-tests` не трогается.
- `Dockerfile` на приложение (`turbo prune <app> --docker`), `infra/app/docker-compose*.yml` (`ORCHESTRATOR_IMAGE` → `CORE_IMAGE` / `LLM_IMAGE` / `MCP_IMAGE` / `RUNNER_IMAGE`, uid-ы сохраняются: core 10002, llm 10008), `compose.test.mjs`, preflight, runbook, `verify-llm-app.mjs`, `infra/sandbox/docker-compose.yml`, образ задания `deploy` в конфигурации раннера.
- `.github/workflows/*` (9 файлов): фильтры путей, имена в `pnpm --filter`, job `gateway-db` (`test:db` с `RADITI_GATEWAY_DB_TESTS=1` — сейчас в одном пакете, станет по пакетам); контракт `infra/app/ci.test.mjs` — каждый скрипт workflow существует, каждый фильтр путей называет существующие файлы.
- Стенды и скрипты: все из §1.2 + корневой `package.json` (`verify:*`, `dev`), `apps/e2e/playwright.config.ts`, `infra/dev/*-verify` (stand.mjs запускают роли через `ORCHESTRATOR_ROLES`), `infra/dev/monitoring` (prometheus.yml).
- `.sonarcloud.properties` — `sonar.inclusions` называет `apps/orchestrator/src/…`.
- Документы: CLAUDE.md («Стек», «Структура», «Команды»: `pnpm --filter orchestrator …`, операторские `subscriptions:*`, `billing:*`, `releases:resolve`, `runner-token`), spec §8, §13–§15 и §20 (решение «разделить» + вопросы), README стендов. Отчёты `docs/plan/*` — история, не переписываются.

## 8. Риски

1. **`config.ts`** — самый связанный файл (перекрёстные проверки, общие схемы, 121 тест). Резать в С2a отдельно от переездов.
2. **`site-content`**: резолвер зависит от типов журнала `mcp`; узкий `ContentScope` должен совпасть структурно с обоими `McpSiteScope` и `McpJournalScope`, иначе придётся двигать часть журнала.
3. **Стенды** глубоко импортируют `dist/…` (≈ 45) и спавнят `dist/main.js` (28) — широко, но механически; опасность — стенд, который «зелёный, потому что ничего не запустил»; проверяю поломкой (как делает README `verify:billing`) на стендах llm и mcp.
4. **Переписывание под `erasableSyntaxOnly`** четырёх файлов (особенно `local-turn-executor`, 13 мест).
5. **Dev-режим**: `pnpm dev` запускал роли одним процессом; теперь 4–5 процессов через turbo, с теми же портами (8081/8082/8084/8090/8083). Совмещённых ролей в одном процессе, которые полагались бы на память общего процесса, не нашёл (`startRoles` создаёт независимые Nest-приложения) — но проверю `wrapResolver` и `LlmRuntime` при С4/С3.
6. **CI**: workflow на GitHub не воспроизводятся локально; контракт `ci.test.mjs` проверяет имена, но не исполняемость — часть шагов подтвердится только прогоном PR.
7. **Ширина диффа**: переносы файлов + правки импортов; ревью упрощаю тем, что переезды идут коммитами «только перенос» отдельно от правок поведения (их, по условию, нет).

## 9. Вопросы владельцу

1. **Шлюз предпросмотров** (`preview`, 1,7 тыс. строк, свой порт и своя cookie): отдельное приложение `apps/preview` (рекомендую — зависит только от конфига и инфры, ORCHESTRATOR_ROLES исчезает целиком) или вторая точка входа `apps/core` (тогда у `core` остаётся выбор роли)?
2. **Общие Nest-модули** (`Infra/Health/Metrics`, ≈ 400 строк): дублировать в каждом приложении при пакете `service-runtime` без Nest (по умолчанию) или сделать собираемый пакет с `dist` (новая категория, меняет `Dockerfile`, turbo и порядок сборки)?
3. **Клиент доверенного отката контента**: его нет (находка 1). Оставляю реализацию в `apps/mcp`, не создаю канал `core → mcp` — это N8, отдельная работа. Подтвердите.
4. **Имена образов**: `ORCHESTRATOR_IMAGE` → `CORE_IMAGE`, `LLM_IMAGE`, `MCP_IMAGE`, `RUNNER_IMAGE` (меняются `infra/app`, runbook, preflight, CI, README); образ `deploy`-раннера — образ ядра. По умолчанию — да.
5. **`mcp` в production-compose**: образ собираю и проверяю, сервис в compose app-ВМ не добавляю (находка 4, это P6). По умолчанию — так.
6. **Имена переменных не меняются**, в том числе `ORCHESTRATOR_PORT` для `core` (ради «порты и имена не меняются»); переименование в `CORE_PORT` — отдельным решением. По умолчанию — не переименовывать.
7. **Корневой `pnpm dev`**: остаётся одной командой, но запускает пять процессов (web, core, mcp, llm, preview/runner по необходимости). Допустимо?
8. **Порядок**: С1 → С2a → С2b → С3 → С4 → С5 → С6, как в постановке, с добавлением С2a. Коммиты — только по вашей просьбе.

До ответа на вопросы 1–3 перемещений файлов не делаю.

## 10. Результат (20.10.2026)

Сделано в дереве `raditi-split`, ветка `refactor/split-orchestrator` от `main` (`970cf27`). Не закоммичено: коммиты — по просьбе владельца. Миграций БД нет, основное дерево, dev-база и dev-OpenBao не затронуты, настоящие провайдеры и `--live` не запускались, `.env` не читался.

### Что получилось

- Пять приложений вместо одного: `apps/core` (бывший `apps/orchestrator`), `apps/llm`, `apps/mcp`, `apps/runner`, `apps/preview` (ответ владельца на вопрос 1). Выбор роли (`ORCHESTRATOR_ROLES`, `roles.ts`) удалён; у каждого приложения своя точка входа, схема переменных (`loadConfig` у `core`, `loadLlmConfig`, `loadMcpConfig`, `loadPreviewConfig`, `loadRunnerConfig`) и свой `Dockerfile`.
- Девять новых пакетов: `app-bootstrap` (каркас процесса без базы и Redis, исходники; добавлен вторым заходом), `service-runtime` и `runner-engine` (собираемые, `dist`; ответ на вопрос 2), `snapshots`, `local-turns`, `turn-keys`, `site-content`, `preview-gateway`, `ip-address`.
- Срезы: С1 и С2a — правила границ и разрез конфигурации (переходные правила потом удалены, остались постоянные); С2b — пакеты; С3 — `apps/llm`; С4 — `apps/mcp`; С5 — `apps/runner` и `runner-engine`; С6 — переименование в `apps/core`, `apps/preview`, снятие `ORCHESTRATOR_ROLES`, документы.
- В `core` остались: жизненный цикл задач и диалогов, очередь `agent-turns`, воркеры и cron, песочницы и ходы, публикация в git, биллинг, выпуск, импорт сайта, менеджер предпросмотров, API раннеров и выпуска, `deploy-step`. Всё это — одна транзакционная область вокруг БД, Redis, S3 и аренды сайта; делить её по процессам нечем: общего у частей — одни и те же таблицы и очереди, а канала между ними нет.
- Скрипты стендов и операторские команды `billing:*`, `releases:resolve` остались в `apps/core/scripts`: стенды ведут несколько приложений сразу. Команды `subscriptions:*` переехали в `apps/llm`, `runner-token` — в `apps/runner`.

### Отличия от плана

1. Разбор адресов не ушёл в `@repo/domain`, а стал листом `@repo/ip-address`: домену нельзя `node:net`.
2. Шлюз предпросмотров и движок раннера — пакеты (`preview-gateway`, `runner-engine`), а не код приложений: тесты `core` ведут их против настоящих собеседников, а приложения друг друга не импортируют. `preview` и `runner` тонкие.
3. `runner-token` по плану С5 оставался в `apps/core`. Runbook (`infra/app/README.md`, «Токены раннеров») выпускает токен на песочной ВМ образом раннера, а образа `core` на ВМ нет, поэтому скрипт переехал в `apps/runner/scripts`; тест, который проверяет, что `core` принимает его вывод, остался в `core` и запускает скрипт как программу.
4. План обещал, что образ `mcp` собирается и проверяется стендами. В первом заходе этого не было (образы собирали вручную); по ответу владельца образы `llm`, `mcp`, `preview` и `runner` теперь собирает и проверяет стенд `pnpm verify:images` и workflow `images.yml`. `core` и `web` собирает `verify:edge`.
5. Дерево разделено без отдельной проверки на GitHub: workflow (фильтры путей, имена скриптов) проверены контрактом `infra/app/ci.test.mjs`, но не исполнялись.

### Проверки на конечном дереве

| Проверка | Результат |
| --- | --- |
| `pnpm gates` (format, check-env, typecheck, lint, check-architecture, test, test:infra, build; без кэша turbo) | код 0; check-architecture — 1887 модулей, 8140 связей; `test:infra` — 603, 596 прошли, 7 пропущены (как на `main`) |
| `pnpm verify:db` | 566 проверок; наборы: db 862, core 1854 (+13 пропущены), llm 562, mcp 685, billing 1377, tRPC 912, web 1917 |
| `verify:vault` | 586 и 63 (клиент) |
| `verify:llm-gateway` | 58 проверок |
| `verify:agent-content` | 13 |
| `verify:mcp-content` | код 0 |
| `verify:site-connect` | 9 |
| `verify:site-import` | 47 проверок, 205 с |
| `verify:gitea` | 28 PASS |
| `verify:billing` | 26 сценариев, 702 проверки, 165 с (первый прогон упал в `checkout` на гонке стенда, см. ниже; повтор — зелёный) |
| `verify:llm-app` / `verify:llm-firewall` | 11 групп / прошёл |
| `verify:preview-network` | 52 из 52 |
| `verify:release` | 19 сценариев, 196 проверок, 824 с |
| `verify:pipeline` | 40 PASS (в итоговой строке стенда — 37), образом `raditi-release-verify/core:local` |
| `verify:edge` | 31 проверка |
| `verify:opencode-supervisor` под gVisor (Colima) | PASS: настоящий OpenCode, раннер `apps/runner`, снимки и публикация |
| семь сценариев `verify-runner.mjs` под gVisor (Colima) | PASS (запуск скриптом без `.env` над одноразовыми сервисами, как в отчёте 47) |
| `pnpm e2e` | 169 тестов, код 0 (одноразовые PostgreSQL и Redis; S3 и Vault — dev-сервисы по значениям `.env.example`) |

Не запускалось: workflow GitHub; `verify:snapshots` и `verify:transport` (пакетные команды читают корневой `.env`); `verify:opencode` и `verify:site` (код, который они проверяют, не менялся); браузерные `test:billing`, `test:site`, `test:landing` (код web не менялся, правки — два комментария); стенды на Linux вне Colima.

### Тесты до и после

`orchestrator` на `main`: 2891 прошёл и 548 пропущены. После разделения: `core` 1571 и 286, `llm` 444 и 118, `mcp` 541 и 144, `runner` 7, `preview` 7, `service-runtime` 17, `ip-address` 42, `preview-gateway` 53, `turn-keys` 90, `snapshots` 102, `site-content` 7, `local-turns` 2, `runner-engine` 3 — вместе 2886 прошли и 548 пропущены (пропущенные совпали). Разница в 5 — по сравнению заголовков тестов: удалено 34 теста выбора роли и тестов «роль одна в процессе» (`ORCHESTRATOR_ROLES`, порты ролей, `roles.test.ts`), добавлено 29 — их замены в конфигурации каждого приложения. Остальные пакеты (domain 4209, db 862, billing 1377, tRPC 912, web 1917 и др.) — те же числа, что на `main`.

### Что сломалось по дороге и как исправлено

- Стенд `verify:release` запускал `preview` из каталога `apps/core` и не собирал `apps/preview`: роль падала на конфигурации ядра. Исправлено, сборка и запуск — из `apps/preview`.
- Сценарий стенда `verify:gitea` читал `loadConfig(...).core`; конфигурация ядра стала плоской. Исправлено.
- Compose в `verify:edge` стал требовать `LLM_IMAGE` (compose подставляет значения всех сервисов, и профиля `llm` тоже): стенд получил заглушку, которую не скачивает.
- Фильтр путей `preview.yml` называл пустой каталог `apps/core/src/preview-gateway`; контракт `ci.test.mjs` пустой каталог принимает (проверяет `existsSync`), поэтому фильтр заметили только после его удаления. Теперь фильтр называет `apps/preview`, `packages/preview-gateway`, `service-runtime` и `ip-address`.
- Стенд `verify:runner` читал все строки `task_events` задачи как записи журнала хода, а с `feed.step` (чат, 17.10.2026) у них нет ограждения: на `main` стенд после чата не запускали, поломка не от разделения. Журнал хода теперь читается без строк `feed.*`.
- `verify:billing` один раз упал в `checkout` («письмо вышло из outbox один раз» — статус `pending` вместо `published`) под нагрузкой машины: письмо успевало дойти раньше, чем relay отмечал событие. Код relay при разделении менялся только в импортах; повтор на спокойной машине — 702 проверки. Стенд читает статус один раз, без ожидания: гонка стенда, а не продукта.

### Ревью конечного дерева (`/spec-check`) и что по нему исправлено

Независимый проход нашёл три группы дефектов, все исправлены: (1) `verify:llm-gateway` и его живой режим собирали только `core` и `llm`, а читают инструменты роли `mcp` из `apps/mcp/dist` — локально их скрывала старая сборка, на чистом раннере CI стенд упал бы; (2) `verify:opencode-supervisor` не собирал `apps/runner`, который запускает в конце; (3) тексты: `env.example` называл `LLM_IMAGE` и `PREVIEW_GATEWAY_IMAGE` необязательными, хотя compose подставляет значения всех сервисов; документы говорили, что образ `mcp` проверяют стенды; `.sonarcloud.properties` расширил охват анализа (возвращён прежний); `@repo/llm-backends` лежал в `dependencies` у `turn-keys` ради одного теста (перенесён в `devDependencies`: граф кода `mcp` его не достигает, но `turbo prune` берёт и `devDependencies`, поэтому исходники пакета — без секретов — в образе `mcp` остаются). Контракт образов `infra/app/images.test.mjs` теперь покрывает Dockerfile всех шести приложений: свой `turbo prune`, своя сборка, свой каталог, ни `git`, ни `gitleaks` вне `core`. Нарушений правил 1–11 CLAUDE.md ревью не нашло.

### Второй заход: ответы владельца на вопросы итога (20.10.2026)

1. «выделяй пакет каркас без db & ioredis» — пакет `@repo/app-bootstrap` (исходники, только `domain` и Nest): запуск и остановка, логгер с именем контейнера, `.env`, `ConfigError`, версия, сторож сети тестов и образцовые id. Из `service-runtime` они ушли, а Redis (клиент, проверка здоровья, остановка, токен `REDIS`) переехал в `apps/core/src/infra/redis.ts` — Redis есть только у `core`. Из пакетов каркаса раннер зависит только от `app-bootstrap`, а `runner-engine`, `snapshots` и `local-turns` — ни от одного (`app-bootstrap` у них только ради сторожа сети тестов); `runner-minimal-packages` не пускает их к `service-runtime` и `db` даже транзитивно. В образе раннера теперь нет пакетов `db` и `service-runtime`, Prisma, `pg`, S3 SDK и BullMQ (`verify:images`). `ioredis` в нём остаётся: это необязательная зависимость `@nestjs/microservices`, которую pnpm подставляет к `@nestjs/core` во всех приложениях (её тянет `mcp`), раннер её не загружает; `dedupePeerDependents: false` проверен и её не убирает — откачен.
2. «ничего страшного, меняй вместе» — допуска `ORCHESTRATOR_ROLES` нет; compose песочной ВМ и образ раннера меняются вместе (`infra/sandbox/README.md`).
3. «добавь в сборку в CI github» — `infra/app/verify-images.mjs` (`pnpm verify:images`, 22 проверки) и workflow `images.yml`: образы `llm`, `mcp`, `preview` и раннера из своих Dockerfile, проверка снаружи (своё приложение, uid 10001, старт без настроек — отказ «Invalid <приложение> configuration» под своим логгером, нет `git`, `gitleaks`, `.env` и запрещённых пакетов; у раннера — нет доступа к данным платформы, есть `runner-token`); у каждого контейнера срок, образ и кэш сборки в CI удаляются сразу после своих проверок. `images.test.mjs` проверяет Dockerfile всех шести приложений.
4. «подтверждаю» — проверка workflow на GitHub прогоном PR: дерево уходит одним коммитом в черновой PR.
5. «переименуй ORCHESTRATOR_PORT и сделай как сейчас по названию контейнера» — `CORE_PORT`; префикс строк логов приложения и контекст логгеров запуска — `core`, `llm`, `mcp`, `preview`, `runner`; метка `app` метрик `core` — `core`; job Prometheus dev-мониторинга — `core`; `ConfigError` ядра — общий, с темой `core`; `createOrchestratorPrisma` → `createAppPrisma`. Отказ конфигурации до создания Nest печатает встроенный логгер Nest текстом и в production (`[Nest] … ERROR [<приложение>] …`); остальные записи в production — JSON.
6. «поправь конфигурацию агентов» — `anynote-scout.md` описывает пять приложений и общие пакеты (и продавца без чеков 54-ФЗ), `spec-reviewer.md` — выпуск `/release` (владелец или администратор) вместо «Применить» и границы приложений (пункт 12).

Независимое ревью второго захода (4 направления, каждое с перепроверкой) подтвердило 21 находку из 25, все исправлены: тест `core` читает `apps/runner/scripts/runner-token.mjs` — файл добавлен во входы `test` в `turbo.json` и в контракт `ci.test.mjs`; правило `ip-address-is-a-leaf` делает «лист» проверяемым; `images.yml` освобождает диск и ставит только Node, как `edge.yml`; остальное — тексты CLAUDE.md, spec, README и агентов, которые второй заход сделал неверными. Стенд биллинга поймал ещё ожидание отсортированного списка переменных `core` и путь `env-file.ts` в стенде.

`/spec-check` перед коммитом нарушений правил не нашёл; по его находкам: правило `package-testing-only-in-tests` теперь держит и `src/testing` пакетов `app-bootstrap`, `service-runtime` и `runner-engine` (проверено нарочно добавленным импортом); из Dockerfile раннера убран шаг `db:generate` (пакета `db` в его образе нет); списки `verify:images` сведены к правилам dependency-cruiser; у `appLogger` и поиска `.env` появились свои тесты (`app-bootstrap` — 17); `infra/app/docker-compose.yml` назван входом `test` (его читает тест `llm`); `src/testing` не попадает в `dist` `service-runtime` и `runner-engine`, а их `build` сначала чистит `dist`; повторные импорты одного модуля слиты, импорты пакетов стоят над относительными. Скрипт слияния задел две строки `import` внутри шаблонов (генерируемые сканеры тестов `git-workspace`) — 30 тестов упали, строки восстановлены, файлы сверены с `main`.

Проверки второго захода (20.10.2026, Docker Desktop, `runc`; Colima под gVisor для раннера):

| Проверка | Результат |
| --- | --- |
| `pnpm gates` (без кэша turbo) | код 0; `check-architecture` — 1887 модулей, 0 нарушений; `test:infra` — 622, 615 прошли, 7 пропущены |
| тесты | `app-bootstrap` 12, `service-runtime` 1, `core` 1575 и 286 пропущены (+4 теста Redis из `service-runtime`), `llm` 444 и 118, `mcp` 541 и 144, `runner` 7, `preview` 7; всего по прежнему orchestrator — 2886 прошли и 548 пропущены, как в первом заходе |
| `pnpm verify:db` | 566 проверок; db 862, core 1858 (+13 пропущены), llm 562, mcp 685, billing 1377, tRPC 912, web 1917 |
| `verify:llm-gateway` / `verify:agent-content` / `verify:mcp-content` | 58 / 13 / 34 PASS |
| `verify:site-connect` / `verify:gitea` / `verify:site-import` | 9 / 28 PASS / 47 (201 с) |
| `verify:billing` | 26 сценариев, 702 проверки |
| `verify:llm-app` / `verify:llm-firewall` | 11 групп / прошёл (образ `llm` пересобран) |
| `verify:release` | 19 сценариев, 196 проверок, 798 с |
| `verify:pipeline` / `verify:edge` | 40 PASS / 31 |
| `pnpm e2e` | 169 тестов |
| `verify:images` | 22 проверки, 356 с |
| `verify:opencode-supervisor` и семь сценариев `verify-runner.mjs` под gVisor (Colima) | PASS: раннер `apps/runner` без `service-runtime` |

После правок по `/spec-check` (правило тестовых модулей, Dockerfile раннера, сборка `runner-engine`, порядок импортов) ещё раз прошли `pnpm gates`, `verify:images` (22), `verify:llm-gateway` (58), `verify:agent-content` (13), `verify:mcp-content`, `verify:db` (566), `verify:release` (196, 803 с) и `pnpm e2e` (169); стенды раннера под gVisor шли до этих правок — код процесса раннера они не меняли, образ раннера после них проверил `verify:images`.

Не запускались: `verify:vault` и `verify:preview-network` (второй заход их кода не касался; в первом — зелёные), `verify:snapshots` и `verify:transport` (читают корневой `.env`), workflow GitHub (прогон PR).

### Открыто

- Клиент доверенного возврата и канал `core → mcp` (N8): вне этой работы.
- Сервис `mcp` в compose app-ВМ — вместе с P6.
- Подтвердить на GitHub workflow под новыми именами — прогон чернового PR (ответ владельца от 20.10.2026).
- `preflight.sh` проверяет дайджесты `LLM_IMAGE` и `PREVIEW_GATEWAY_IMAGE` всегда, хотя профиль `llm` и наложение предпросмотров необязательны: условным его делать или нет — решение владельца.
- Усилить контракт `ci.test.mjs`: фильтр `/**` должен называть каталог, в котором есть файл.
- `ioredis` в образе раннера: необязательная зависимость `@nestjs/microservices`, которую pnpm подставляет к `@nestjs/core` всех приложений (её тянет `mcp`); раннер её не загружает, `dedupePeerDependents: false` её не убирает. Убрать совсем можно только отказом `mcp` от `@nestjs/microservices` или отдельным lockfile раннера.
- В `dependencies` `apps/core/package.json` лежат пакеты, которые нужны только тестам (`@repo/browser-providers`, `@repo/preview-gateway`) или скриптам стендов (`@rekog/mcp-nest`, `@modelcontextprotocol/core`). Не мешают, чистка — отдельным коммитом. (`src/testing` пакетов `service-runtime` и `runner-engine` в `dist` больше не попадает, а их `build` теперь сначала чистит `dist`: устаревшая сборка не скрывает пропавший экспорт.)
- В `apps/e2e/playwright.config.ts` фоновый `mcp` запускается без ожидания (Playwright ждёт порт `core`); смоук «MCP starts» проходил во всех прогонах.
