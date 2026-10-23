# План 56. Приложения `core`, `llm`, `mcp`, `preview` и `runner` — модули Nest, код одного приложения — в нём самом

Состояние: **в работе (21.10.2026).** Дерево — `/Users/victor/Projects/raditi-nest`, ветка `refactor/nest-modules` от `main` (`c706a11`); основное дерево не меняется. Итог и числа — §10.

Запрос владельца (21.10.2026): «рассмотри приложения `apps/core`, `apps/llm`, `apps/mcp`, `apps/preview`, `apps/runner`, переделай их под структуру приложений Nest, когда оно состоит из модулей; подумай о выносе из `apps/core` в `apps/llm`, `apps/mcp`, `apps/preview`, `apps/runner`: всё, что используется только в производных сервисах, нужно перенести туда из `apps/core`, а не только вынести настройку в сопутствующие сервисы, как это сделано сейчас».

Опись сделана по графу dependency-cruiser и по импортам каждого символа (`src`, тесты, `scripts`, стенды `infra`, workflow).

## 1. Что есть сейчас

### 1.1. Главная находка

**В продуктовом коде `apps/core/src` нет ни одного файла, который нужен только другому приложению.** Все 125 его файлов без тестов достигает только продуктовый код `core`. Для других приложений в `core` лежат:

- тесты чужого кода: `src/runner/*.test.ts` (только тесты `@repo/runner-engine`), тесты пакетов `local-turns`, `turn-keys` и `site-content`, тест хранилища шлюза предпросмотров;
- стенды `scripts/verify-*.mjs`, шесть из которых ведут только `mcp` или только `llm`;
- зависимости, нужные только тестам или стендам: `@repo/runner-engine`, `@repo/preview-gateway`, `@repo/browser-providers`, `@rekog/mcp-nest`, `@modelcontextprotocol/core`.

Код одного приложения на самом деле лежит в общих пакетах, созданных разделением 20.10.2026:

| Пакет | В продукте нужен | Что с ним |
| --- | --- | --- |
| `@repo/runner-engine` (1,8 тыс. строк) | только `runner` | переезжает в `apps/runner` целиком, пакет удаляется |
| `@repo/preview-gateway` (1,7 тыс.) | только `preview` | переезжает в `apps/preview` целиком, пакет удаляется |
| `@repo/turn-keys` (2,3 тыс.) | выдача ключей, сборщик, `backends`, переменные сайта — только `core`; приём запросов шлюзом — только `llm` | делится по протоколу (§5.3) |
| `@repo/site-content` (1,1 тыс.) | значения плана БД, шаги предпросмотра, запись предпросмотра — только `core`; токен `MCP_CONTENT_RESOLVER` — только `mcp` | они уходят в приложения, общее остаётся (§5.4) |
| `@repo/service-runtime` | метрики (`MetricsController`, `MetricsTokenGuard`, `MetricsRegistryModule`) и токены `METRICS_*`, `BACKGROUND_JOBS`, `OBJECT_STORAGE` — только `core` | уходят в `core`; пакет получает общие `DatabaseModule` и `HealthModule` (§5.2) |
| `@repo/app-bootstrap` | `readAppVersion` — только `mcp` (копия в `core` мертва) | уходит в `mcp` |
| `@repo/local-turns` | `maskTurnEvents` — только `core` | уходит в `core`; остальное общее для `core` и `runner` |
| `@repo/snapshots`, `@repo/ip-address` | несколько приложений | без изменений |

### 1.2. Устройство Nest сейчас

- `core` уже собран из модулей по разделам: `CoreModule.forRoot` подключает около двадцати модулей. Но почти все провайдеры — фабрики-замыкания (55 `useFactory` на 13 классов), четыре модуля глобальные, движок хода строит `TasksModule`, а не `TurnsModule`, токены всех разделов лежат в одном `infra/tokens.ts`.
- `llm`: один модуль `LlmAppModule.forRoot` с тремя провайдерами; всю роль собирает в конструкторе один класс `LlmRuntime` (210 строк).
- `mcp`: 28 файлов прямо в `src`, один `McpAppModule.forRoot` строит все провайдеры в замыканиях.
- `preview` и `runner`: только настройка и запуск, код — в пакетах.

## 2. Решения владельца (21.10.2026)

1. **Тесты `core`, которые ведут настоящий движок раннера** (около 137 определений: супервизор хода, восстановление, дедлайны; единственная проверка связки `core`↔`runner` в CI): **узкое исключение для тестов.** Один тестовый файл `apps/core/src/testing/runner-side.ts` импортирует три файла движка из `apps/runner/src`; правило dependency-cruiser разрешает это только ему, продуктовый код по-прежнему изолирован.
2. **Стенды:** стенды, которые ведут одно приложение, — в это приложение: четыре стенда контента и стенд отката (`verify-content-{worker,turns,lifecycle,undo}.mjs`, `verify-agent-content-undo.mjs`) — в `apps/mcp/scripts`, рабочий процесс стенда шлюза (`verify-llm-worker.mjs`) — в `apps/llm/scripts`. Стенды нескольких приложений остаются в `apps/core/scripts`. Стенды исключаются из образов (`.dockerignore`).
3. **`@repo/turn-keys` — делить по протоколу:** выдача ключей, сборщик, `backends` и переменные сайта — в `apps/core`; приём запросов и его типы — в `apps/llm`; в пакете остаётся то, что нужно обоим: формат ключа, журнал вызовов (закрытие и учёт) и отзыв ключей.
4. **Docker-тест менеджера предпросмотров** (`preview.yml`): тест запускает собранный `apps/preview/dist/main.js` отдельным процессом, без импорта; `preview.yml` сначала собирает `preview`.

Это меняет решение плана 55 §10, п. 2 («движок раннера и сервер шлюза предпросмотров — пакеты, приложения `runner` и `preview` тонкие»): запись 20.10.2026 в spec §20 остаётся историей, новое решение записывается рядом.

### 2.1. Значения по умолчанию (по указанию владельца от 09.10.2026)

- **Свои HTTP-серверы остаются провайдерами,** а не контроллерами Nest: шлюз `llm` (`gateway/server.ts`), шлюз предпросмотров, API раннеров и API выпуска `core`. Переход на HTTP-слой Nest изменил бы поведение: предел размера заголовков задаётся только при создании своего сервера, список допуска `llm` срабатывает до маршрутизации, учёт SSE и обрыва, ответы отказа в форме адаптера, `upgrade` и `CONNECT`, принудительное закрытие соединений. «Приложение из модулей» — это внедрение зависимостей, конфигурация и жизненный цикл.
- **Команды оператора остаются вне Nest:** `subscriptions:*` (`apps/llm/src/subscriptions/cli.ts`), `billing:*` и `releases:resolve` (`apps/core/src/{billing,releases}/operator-cli.ts`) запускаются из исходников через type stripping.
- **`deploy-step` остаётся в `core`:** путь `/app/apps/core/dist/deploy-step/cli.js` — договор с `platform/ci` в Gitea.
- **`@nestjs/config` не вводится:** каждое приложение разбирает окружение zod-схемой до создания Nest, отказ печатается до Nest.
- **Метрики `core` уходят из `service-runtime` в `core`.** Решение от 20.10.2026 было «общая обвязка — в одном пакете, а не копиями»; метрики нужны только `core`, поэтому копий не появляется. Общими в пакете остаются Prisma и health; к ним добавляются модули `DatabaseModule` и `HealthModule`.
- **Символы `@repo/domain`, которые использует одно приложение, не переносятся:** домен — ядро портов, его разделение не создавало.
- **Обслуживание контента `mcp`** (`McpContentMaintenance`) по-прежнему без расписания: перестройка его не добавляет.
- **Классы, которые строят тесты и стенды** (`new X(...)`), сохраняют конструкторы; в модули они подключаются фабриками.
- **SonarCloud:** список `sonar.inclusions` идёт за перенесённым кодом, объём анализа почти не меняется. Перенесённые файлы SonarCloud снова посчитает новым кодом; его замечания в коде, который был до переноса, этот рефакторинг не чинит (как и в PR #10).

## 3. Соглашения для всех пяти приложений

1. **Вход.** `src/main.ts` и `src/start.ts` сохраняют роль: `main.ts` загружает `.env` и `reflect-metadata`, разбирает конфигурацию до Nest, вызывает `start<App>(config)`, включает предел остановки. `dist/main.js` — путь образа и стендов, не меняется.
2. **Корневой модуль** — `src/app.module.ts`, класс `AppModule`, единственный динамический корень: `AppModule.forRoot(config, …)`. Прежние имена (`CoreModule`, `LlmAppModule`, `McpAppModule`, `PreviewGatewayModule`, `RunnerModule`) уходят, стенды и текстовые контракты обновляются в том же срезе.
3. **Конфигурация** — каталог `src/config/`: `config.ts` (разбор окружения, тип, `ConfigError`), `config.module.ts` — глобальный `<App>ConfigModule.forRoot(config)` с токеном `<APP>_CONFIG` (`CORE_CONFIG`, `LLM_CONFIG`, `MCP_CONFIG`, `PREVIEW_CONFIG`, `RUNNER_CONFIG`), тесты конфигурации. Модули разделов читают свой срез конфигурации через токен, а не замыканием.
4. **Один раздел — один каталог** `src/<раздел>/` с `<раздел>.module.ts`, его провайдерами, контроллерами, процессорами и тестами. Модуль экспортирует только то, что внедряют другие модули. Новые токены раздела — в `<раздел>.tokens.ts`; существующий токен переезжает, только если переезжает или делится его файл.
5. **Глобальные модули** — только инфраструктура: модуль конфигурации, база и хранилища, очередь (`core`), реестр метрик (`core`). Остальные модули импортируются явно тем, кто их использует; неявной зависимости от глобального модуля (как `TasksModule` от `TurnsModule` сейчас) нет.
6. **Динамические модули.** Кроме корня и модуля конфигурации, `forRoot` остаётся только там, где модуль включается по профилю (`mcp`: контент, браузер, хранилище). Исключение среди модулей разделов одно — модули `core`, которые ведут ходы: `forRoot(turns)` у них только принимает единственный объект `TurnsModule.forRoot` (§4.5). Из инфраструктуры (п. 5) динамические — `DatabaseModule.forRoot(db)` и `HealthModule.forRootAsync` пакета (§5.2) и очередь `core`: `QueueModule.forRoot({ redisUrl, background })` остаётся таким, каким был до плана, — `background` включает воркеры BullMQ (`manualRegistration`), а `@nestjs/bullmq` принимает его только параметром модуля, не из фабрики, поэтому на `CORE_CONFIG` очередь не переводится (ревью С9, 23.10.2026). Результат `forRoot` создаётся один раз и передаётся дальше тем же объектом: Nest различает динамические модули по ссылке, и повторный `forRoot` молча создаёт второй набор провайдеров (второй реестр метрик, второй `LiveTurns`).
7. **Внедрение — по токену** (`@Inject(TOKEN)` или фабрика с `inject`); внедрение по типу класса без явного `@Inject` не используется — правило `consistent-type-imports` превращает такие импорты в `import type`. Классы, которые строят тесты и стенды, сохраняют конструкторы и подключаются фабриками; классы-оболочки приложения (фоновые циклы, жизненный цикл) могут стать `@Injectable()`.
8. **Порядок остановки,** у которого больше одного шага со сроками, остаётся в одном провайдере: `LlmRuntime` у `llm`, `PreviewGatewayServer.close()` у `preview`, `RunnerLifecycle` у `runner`. Внутри одного модуля Nest 12.1 останавливает провайдеры одного уровня одновременно, а глобальные модули — последними; на это опираются только там, где это сказано явно, и тест проверяет порядок.
9. **Без изменений:** контексты логгеров, тексты строк логов (их ищут стенды и тесты), имена и метки метрик, тексты отказов, имена переменных окружения, порты, пути Vault, очереди, протоколы.
10. **`src/testing/`** — только в корне `src` приложения (его исключает `tsconfig.build.json`, на него опираются правила и SonarCloud); `version.ts` у `mcp` — в корне `src` (путь `../package.json` считается во время работы).
11. **Код, который Node запускает из исходников** (type stripping), остаётся без декораторов, параметров-свойств и `enum`: замыкание команд оператора `llm` (`subscriptions/*`, `egress.ts`, `egress-probe.ts`, `credentials.ts`, `session-lock.ts`, `llm-config.ts`), `apps/core/src/{billing,releases}/operator-cli.ts`, `turns/turn-result.ts`, `testing/ids.ts`, `deploy-step/{backup,envelope}.ts`, `git-workspace/process.ts`, `llm/backends.ts` (с С2 его грузит из исходников `scripts/verify-llm-zai-setup.mjs`, а с ним — `node --test scripts/*.test.mjs` из `test` приложения `core`). Их подключают фабрики.

## 4. Целевая раскладка приложений

### 4.1. `apps/runner` — движок из `@repo/runner-engine`

```
src/main.ts, start.ts                 startRunner: createApplicationContext(AppModule.forRoot(config, { onRetired }))
src/app.module.ts                     AppModule.forRoot: RunnerConfigModule, VmTokenModule, CoreApiModule, SandboxModule,
                                      SandboxRunnerModule, ReconcilerModule; RunnerLifecycle (порядок запуска и остановки)
src/runner-lifecycle.ts               start: runner → reconciler; stop: reconciler → runner → transport.close()
src/config/                           config.ts (loadRunnerConfig + RunnerConfig из пакета), config.module.ts
src/vm-token/                         runner-token.ts (+ тест), vm-token.module.ts (RUNNER_TOKEN, RUNNER_ID)
src/core-api/                         core-client.ts (HttpRunnerTransport, RunnerCallError, runnerRefusal), core-api.module.ts
src/sandbox/                          runner-sandbox-config.ts, sandbox.module.ts (SANDBOX_PROVIDER, TURN_EXECUTOR — LocalTurnExecutor)
src/sandbox-runner/                   sandbox-runner.ts (как есть), sandbox-runner.module.ts
src/reconciler/                       runner-reconciler.ts, reconciler.module.ts
src/testing/                          ids.ts, config.ts (testRunnerConfig), scripted-core.ts, fake-core-server.ts, sandbox-side.ts
```

- Тесты раннера из `apps/core/src/runner/*.test.ts` переезжают сюда с поддельным `core` на схемах протокола `@repo/domain`: группы «commands», «snapshot parts», `isTurnSnapshotUrl`, тест сверки, тест модуля (против `fake-core-server.ts`), половина теста клиента.
- Перекрёстные сценарии (два теста «with core», полный ход по HTTP клиента и сервера, вид `runner` в `turn-supervisor.test.ts`, `turn-exec-recovery.test.ts`, `turn-deadline.test.ts`) остаются в `core` и берут движок через `apps/core/src/testing/runner-side.ts` (решение 1). Файлы `core-client.ts`, `sandbox-runner.ts`, `runner-reconciler.ts` не импортируют модули и токены приложения — только `@repo/domain`, `@repo/observability`, `@nestjs/common` (`Logger`) и друг друга.
- Половина «runner не импортирует биллинг» тестов `billing.module.test.ts` и `site-provisioning.module.test.ts` удаляется: это держат правила `apps-are-isolated` и `runner-no-platform-access`.
- `package.json`: `build` — `nest build`; зависимости `agent-drivers`, `local-turns`, `snapshots` — прямые (раньше транзитивные; содержимое образа то же).

### 4.2. `apps/preview` — сервер из `@repo/preview-gateway`

```
src/app.module.ts                     AppModule.forRoot: PreviewConfigModule, DatabaseModule (service-runtime), GatewayModule
src/config/                           config.ts, config.module.ts (PREVIEW_CONFIG, PREVIEW_CLOCK), browser-relays.ts (+ тест)
src/access/                           access.module.ts, preview-access.ts (порт и записи), postgres-preview-access.ts,
                                      preview-sessions.ts (кеши маршрутов и сессий), ttl-cache.ts, интеграционный тест хранилища
src/cookie/                           preview-cookie.ts (+ тест) — общий для access и gateway
src/gateway/                          gateway.module.ts, preview-gateway.server.ts (приём, цель, отказы, listen/address/close),
                                      entry.ts, proxy.ts, tunnels.ts, limits.ts, replies.ts, headers.ts, pages.ts, тесты
src/testing/                          fakes.ts, memory-access.ts, gateway.ts (createTestGateway)
```

- `PreviewGatewayServer` сохраняет внешний вид (`listen`, `address`, `close`, `recheckTunnels`), `close()` по-прежнему одна выполняет остановку в прежнем порядке; у разделённых провайдеров своих хуков остановки нет. 32 теста сервера — защита разделения.
- `preview-access.integration.test.ts` переезжает из `core` в `apps/preview`; у `preview` появляются `test:db`, шаг `gateway-db` в `ci.yml` и набор в `verify:db` (восемь наборов вместо семи).
- Docker-тест `core` запускает `apps/preview/dist/main.js` процессом (`apps/core/src/testing/preview-app.ts`, решение 4).
- Отличие поведения, одно и сознательное: с глобальным `DatabaseModule` Prisma отключается после закрытия шлюза, а не одновременно с ним — этого и требует комментарий `PrismaLifecycle`.

### 4.3. `apps/mcp`

```
src/app.module.ts                     AppModule.forRoot(config, testing?): девять отказов в прежнем порядке и словами,
                                      модули по профилям; порядок SiteInfo → Content → Browser сохраняет порядок инструментов
src/version.ts                        readAppVersion (из app-bootstrap) + MCP_VERSION
src/config/                           config.ts, config.module.ts (MCP_CONFIG), allowed-hosts.ts (parseMcpHosts — разрыв
                                      цепочки config.ts → mcp-policy.ts → mcp-content.ts)
src/infra/                            infra.module.ts (DatabaseModule, SECRET_STORE)
src/health/                           health.module.ts (HealthModule из service-runtime, проверка допуска)
src/common/                           canonical-json.ts, one-line.ts, json-rpc.ts, mcp-http-error.ts
src/access/                           mcp-access.ts, mcp-request.ts, mcp-auth.guard.ts, mcp-policy.ts, access.module.ts
src/server/                           mcp-runtime.ts, mount-mcp.ts, mcp-http.controller.ts, server.module.ts
src/site-info/                        mcp-tools.controller.ts (класс McpToolsController), site-info.module.ts
src/storage/                          content-storage.ts, screenshots.ts, storage.module.ts (MCP_CONTENT_STORAGE)
src/privacy/                          content-privacy.ts, content-contacts.ts, privacy.module.ts
src/content/                          content.module.ts, content.tokens.ts (MCP_CONTENT_RESOLVER из site-content),
                                      content-arguments.ts, mcp-content.ts, mcp-content.controller.ts, mcp-journal.ts,
                                      content-snapshots.ts, mcp-content-maintenance.ts, mcp-turn-content-rollback.ts,
                                      preview-content.ts
src/browser/                          browser.module.ts, browser-arguments.ts, mcp-browser.ts, mcp-browser-store.ts,
                                      mcp-browser.controller.ts
scripts/                              verify-content-{worker,turns,lifecycle,undo}.mjs, verify-agent-content-undo.mjs
```

- `mountMcp(app)` остаётся функцией запуска (`json` с пределом 100 КиБ, фильтр ошибок только для `/mcp`, `setHttpAdapter → connectMicroservice → startAllMicroservices` до `listen`); фильтр ошибок не становится `APP_FILTER`.
- Тест `preview-db-values.test.ts` переезжает в `@repo/site-content`; `site-content-resolver.test.ts` делится: 18 тестов на поддельном адаптере — в пакет, 4 с адаптерами реестра — остаются в `mcp`.
- Строка запуска `mcp role listening on …` не меняется (её ищут два стенда).

### 4.4. `apps/llm`

```
src/app.module.ts                     AppModule.forRoot(config): LlmConfigModule, InfraModule, GatewayModule
src/config/                           config.ts, llm-config.ts (без декораторов: его загружают CLI и infra), config.module.ts
src/infra/                            infra.module.ts: PRISMA, SECRET_STORE, LLM_BACKENDS, LLM_LOGGER ('LlmGateway'),
                                      HEALTH_PROBE; отключение базы с пределом 2 с и строкой llm_database_shutdown_timeout
src/egress/                           egress.ts, egress-probe.ts (без декораторов), egress.module.ts, EgressNotDelivered
src/pool/                             credentials.ts (+ subscriptionCredentialPath), pool-health.ts, pool-health-store.ts
                                      (+ resetsPlausible), pool.module.ts
src/accounting/                       gateway-store.ts (приём запросов из turn-keys), gateway-types.ts, lost-call-collector.ts,
                                      accounting.module.ts
src/maintenance/                      maintenance-jobs.ts, channel-monitor.ts, maintenance.module.ts
src/gateway/                          server.ts (путь и текст не меняются), readiness.ts, llm-runtime.ts (порядок listen и
                                      остановки), gateway.module.ts
src/subscriptions/                    команды оператора, вне Nest; + session-lock.ts (нужен только им)
scripts/                              subscription-*.mjs, verify-llm-worker.mjs
```

- Порядок запуска (строка `llm_egress_path` → первый сбор и проверка канала → `listen` → таймеры) и остановки (HTTP до 30 с → пул и канал до 3 с → задачи 1 с → сборщик 1 с → база 2 с) сохраняются; общий срок 37 с внутри 40 с остановки compose.
- `gateway/server.ts` остаётся на месте и без правок текста: его читают четыре текстовых контракта.
- Рабочий процесс стенда строит роль через `AppModule` и `app.get(LlmRuntime)`, а не `new LlmRuntime(...)`.

### 4.5. `apps/core`

```
src/app.module.ts                     AppModule.forRoot({ config, background }) (бывший core/core.module.ts)
src/config/                           config.ts, runner-tokens.ts, config.module.ts (CoreConfigModule: CORE_CONFIG,
                                      BACKGROUND_JOBS), config.tokens.ts
src/infra/                            infra.module.ts (глобальный: PRISMA через DatabaseModule, OBJECT_STORAGE, SECRET_STORE,
                                      REDIS), redis.ts, infra.tokens.ts
src/leases/                           leases.module.ts: SITE_LEASES, TURN_ASSIGNMENTS
src/metrics/                          metrics.module.ts, metrics.controller.ts, metrics-registry (из service-runtime)
src/health/                           health.module.ts через HealthModule из service-runtime
src/llm/                              llm.module.ts (выдача ключей хода), turn-credentials.ts, credential-sweeper.ts,
                                      backends.ts (из turn-keys), credential-runtime.ts, pool-probe-client.ts
src/site-env/                         site-env-values.ts (из turn-keys)
src/site-content/                     site-content.module.ts: значения плана БД (db-plan-values.ts из site-content),
                                      поиск адреса, фабрика доступа к контенту сайта (по экземпляру на потребителя)
src/turns/                            turns.module.ts — движок хода (TURN_EXECUTOR, LiveTurns, журнал, TurnSupervisor,
                                      TurnExecRecovery, TurnRuntime, TurnReconciler), turns.providers.ts,
                                      turn-runtime.ts и preview-turn-rollback.ts (из tasks), turn-events-mask.ts
src/tasks/, previews/, releases/, release-api/, runner-api/, git-workspace/, site-provisioning/, billing/,
notifications/, outbox/, queue/, drivers/, sandbox/, sessions/
                                      свои токены в <раздел>.tokens.ts, сборка в <раздел>.providers.ts, где фабрик много
src/deploy-step/                      без изменений (не Nest; мёртвый index.ts удаляется)
src/testing/                          + runner-side.ts (решение 1), preview-app.ts (решение 4)
```

- Каталог `core/` уходит, `src/runner/` (только тесты) уходит, мёртвый `src/version.ts` удаляется.
- `TurnsModule` перестаёт быть глобальным и владеет движком хода; `TasksModule` и `PreviewsModule` импортируют его явно; `TurnsModule.forRoot` строится один раз — в `AppModule.forRoot`, — и `TasksModule.forRoot(turns)` и `PreviewsModule.forRoot(turns)` получают этот же объект. Это единственные `forRoot` модулей разделов вне профилей (исключение из §3, п. 6; очередь — инфраструктура, там же): без профиля нужен был бы статический `TurnsModule`, а он изменил бы поведение — исполнитель хода выбирает настройка, фабрики `SANDBOX_PROVIDER` и `RunnerApiServer` отказывают в чужом режиме, а `RunnerHub` получил бы хуки остановки и при локальном исполнителе.
- Отличие поведения, одно и сознательное (как у `preview`, §4.2): `DatabaseModule` — свой глобальный модуль, поэтому при остановке `RedisLifecycle` и `PrismaLifecycle` идут друг за другом — Redis закрывается, потом Prisma отключается, — а не одновременно, как прежде в одном `InfraModule`. Остальной порядок запуска и остановки при обоих исполнителях прежний; его проверяет `app.module.test.ts`.
- Классы, которые строят стенды из `dist` (`TurnSupervisor`, `LiveTurns`, `TaskEventTurnJournal`, `RunnerHub`, `RemoteTurnExecutor`, `RunnerApiServer`, `SnapshotService`, `GitWorkspaceService` и др.), сохраняют конструкторы и пути файлов.
- Пути, на которые опираются стенды и CI, не меняются: `dist/main.js`, `dist/deploy-step/cli.js`, `dist/{config,git-workspace,llm,runner-api,sessions,turns}/…` классов, которые грузят стенды, и `src/llm/backends.ts`, который стенды грузят из исходников (§3, п. 11); тексты, которые читают контрактные тесты (имена метрик в `billing.module.ts` и т. п.), переносятся вместе с контрактом.

## 5. Общие пакеты

### 5.1. `@repo/app-bootstrap`
`readAppVersion` переезжает в `apps/mcp/src/version.ts`; `apps/core/src/version.ts` (мёртвый) удаляется; зависимость `zod` пакету больше не нужна.

### 5.2. `@repo/service-runtime`
- В `core` уходят `MetricsController`, `MetricsTokenGuard`, `MetricsRegistryModule`, токены `METRICS_REGISTRY`, `METRICS_TOKEN`, `BACKGROUND_JOBS`, `OBJECT_STORAGE`, поддельные Redis и очередь из `testing/fakes`.
- Остаются `createAppPrisma`, `PrismaLifecycle`, `HealthController`, `HEALTH_DETAILS_TOKEN`, токены `PRISMA`, `SECRET_STORE`, `HEALTH_CHECKS`.
- Добавляются `DatabaseModule.forRoot(db)` (глобальный: `PRISMA` и `PrismaLifecycle`) — для `core`, `mcp` и `preview` — и `HealthModule.forRootAsync({ imports, inject, useFactory, details? })` — для `core` и `mcp`. `llm` свой `PrismaLifecycle` не берёт: у него отключение с пределом и предупреждением.

### 5.3. `@repo/turn-keys` (решение 3)
- Остаётся: `turn-key.ts` (формат и хеш ключа, замок пула, путь и схема ссылки ключа хода — без `subscriptionCredentialPath`), новый `call-ledger.ts` (закрытие и учёт вызовов: `finish`, `collectLost`, общий для приёма помощник транзакции, `recordRefusal`, цены, `lastCompletedUsage`), новый `turn-revocation.ts` (`revokeTurnCredentials` — отзыв с тем же ограждением, что у `core`; его вызывает и CLI `llm` при выводе аккаунта), сокращённый `gateway-types.ts`.
- В `apps/core/src/llm/`: `GatewayTurnCredentials` (отзыв — через `revokeTurnCredentials`), `CredentialSweeper` (запасной сборщик — журнал вызовов пакета), `backends.ts`; в `apps/core/src/site-env/` — `site-env-values.ts`; их модульные тесты.
- В `apps/llm/src/accounting/`: приём запросов (`lookup`, `admit`, `refuse` поверх журнала) и его типы; в `egress/` — `EgressNotDelivered`, в `pool/` — `resetsPlausible` и `subscriptionCredentialPath`.
- `apps/llm/src/subscriptions/retire.integration.test.ts` переписывается без кода `core`: ключи создаются строками базы, отзыв — общим `revokeTurnCredentials`, шаги сборщика — тем SQL, который он выполняет; проверки стороны `core` («выдача отказывает аккаунту на выводе», «сборщик держит аккаунт, пока вызов открыт») переезжают в интеграционные тесты `core`. Связку `core`↔`llm` целиком по-прежнему проверяет стенд B13 (`verify:llm-gateway`).
- `turn-keys-tier` больше не разрешает `llm-backends`; в образе `mcp` его больше нет, `verify:images` это проверяет.

### 5.4. `@repo/site-content`
- В `core`: `db-plan-values.ts` (→ `apps/core/src/site-content/`), функции шагов предпросмотра (`previewContentAccess`, `previewContentObjects`, `seedMismatches`, `replayDbPlan` и др. → `apps/core/src/previews/preview-content.ts`), запись предпросмотра (`previewRecordSchema` и др. → `apps/core/src/previews/preview-record.ts`).
- В `mcp`: токен `MCP_CONTENT_RESOLVER`; мёртвый реэкспорт `hostSearchText`, `mentionsPreviewHost` из `mcp-content.ts` удаляется.
- Остаётся общее: `previewContentGateway`, `preview-db-runtime`, `preview-transport`, `PreviewDbValueStorage`, `publishedValueRefusal`, `createSiteContentResolver`, пределы размера.

### 5.5. `@repo/local-turns`
`maskTurnEvents` (11 строк, только `core`) → `apps/core/src/turns/turn-events-mask.ts`; тесты `turn-output.test.ts`, которые проверяют код пакета без `@repo/agent-drivers`, — в пакет.

### 5.6. Удаляемые пакеты
`@repo/runner-engine` и `@repo/preview-gateway`: каталоги, правила `runner-engine-tier` и `preview-gateway-tier` (вместо них — правила допустимых пакетов на каталоги приложений), упоминания в `RUNTIME`/`SERVICES`, фильтрах путей workflow, `verify-images`, SonarCloud, документах.

## 6. Стенды, образы, CI

- Переезжают шесть стендов (решение 2): пути импортов внутри (`../../mcp/dist/…` → `../dist/…`, `../dist/turns/…` → `../../core/dist/turns/…`), кто их запускает (`infra/dev/site-verify/verify-content.mjs` — `cwd` `apps/mcp`, `infra/dev/llm-verify/workers.mjs` — каталог по роли, `verify-agent-content.mjs` — путь стенда отката), контракты (`infra/app/ci.test.mjs`, `infra/dev/site-verify/content-stand.test.mjs`, `infra/dev/llm-verify/{agent-content,live,workers}.test.mjs`), фильтры `wordpress-content.yml`.
- `.dockerignore` исключает стенды и их тесты из контекста образов (операторские команды остаются); `verify:images` проверяет, что в образах нет `verify-*.mjs`.
- `apps/core/package.json`: убираются `@repo/runner-engine`, `@repo/preview-gateway`, `@modelcontextprotocol/core`; `@repo/browser-providers` и `@rekog/mcp-nest` — в `devDependencies`; неиспользуемые `express`, `pg`, `@types/express`, `@types/pg` — после `pnpm why`.
- dependency-cruiser: исключение `apps-are-isolated` только для `apps/core/src/testing/runner-side.ts` и правило, что оно достаёт только три файла движка; правила допустимых пакетов для `apps/runner/src` и для пути запроса `apps/preview/src/{gateway,access,cookie}`; правило, что команды оператора `llm` не достигают модулей Nest.
- turbo: входы `test` и `typecheck` у `core` называют три файла движка раннера (иначе кеш turbo вернёт зелёный результат после правки раннера); `rootDir` `core` переезжает из `tsconfig.json` в `tsconfig.build.json` (контракт `pipeline-verify/stand.test.mjs` правится вместе).
- Фильтры путей workflow называют новые каталоги и не называют удалённые пакеты.

## 7. Срезы

Каждый срез зелёный отдельно (typecheck, lint, test затронутых пакетов, `check-architecture`, `test:infra`) и коммитится отдельно (Conventional Commits на английском).

| Срез | Что | Где |
| --- | --- | --- |
| С1 | пакеты: `app-bootstrap`, `service-runtime` (метрики → `core`, `DatabaseModule`, `HealthModule`), `site-content`, `local-turns` | основное дерево ветки |
| С2 | `turn-keys` по протоколу; `verify:db` | основное дерево ветки |
| С3 | `apps/runner` из `runner-engine`, `runner-side.ts` | своё дерево от С2 |
| С4 | `apps/preview` из `preview-gateway`, `test:db`, docker-тест через процесс | своё дерево от С2 |
| С5 | `apps/mcp` по модулям, стенды `mcp` | своё дерево от С2 |
| С6 | `apps/llm` по модулям, рабочий процесс стенда | своё дерево от С2 |
| С7 | слияние С3–С6 в ветку | основное дерево ветки |
| С8 | `apps/core` по модулям | основное дерево ветки |
| С9 | `.dockerignore`, SonarCloud, фильтры workflow, CLAUDE.md, spec, README, roadmap | основное дерево ветки |
| С10 | проверки §8 и ревью | основное дерево ветки |

## 8. Проверки

- До изменений — базовая линия: число тестов каждого пакета (`vitest --reporter=json`, прошло и пропущено). После — то же; каждое расхождение объяснено (перенос, удаление по §4, новые тесты).
- `pnpm gates` без кеша turbo, `pnpm verify:db`, `pnpm verify:images`.
- Стенды: `verify:llm-gateway`, `verify:agent-content`, `verify:mcp-content`, `verify:site-connect`, `verify:release`, `verify:site-import`, `verify:billing`, `verify:pipeline` (не одновременно с `verify:release`), `verify:gitea`, `verify:preview-network`, `verify:edge`, `verify:llm-app` (с образом `llm` из этого дерева), `pnpm e2e`; docker-тесты предпросмотра (`RADITI_PREVIEW_DOCKER_TESTS=1`) и выкладки (`RADITI_HOSTING_DOCKER_TESTS=1`).
- Стенды раннера под gVisor (`verify:runner`, `verify:opencode-supervisor`) — если поднимается Colima с `runsc`; иначе — «не проверено».
- Живой режим (`--live`) не запускается; `.env` не читается.

## 9. Риски

1. Стенды строят классы приложений из `dist` и сверяют текст файлов регулярными выражениями — каждый перенос файла обновляет стенд и контракт в том же срезе.
2. Порядок остановки при разделении провайдеров (`llm`, `preview`, `runner`) — в одном месте, с тестом порядка.
3. Повторный `forRoot` динамического модуля — второй набор провайдеров без ошибки (§3, п. 6).
4. Код, который Node запускает из исходников, — без декораторов (§3, п. 11); `cli.test.ts` и тесты операторских команд ловят нарушение только при запуске.
5. Слияние С3–С6: общие файлы (`.dependency-cruiser.cjs`, `ci.test.mjs`, workflow, `turbo.json`, `pnpm-lock.yaml`).
6. SonarCloud снова посчитает перенесённый код новым.

## 10. Результат

Заполняется по завершении.
