# План 56. Приложения `core`, `llm`, `mcp`, `preview` и `runner` — модули Nest, код одного приложения — в нём самом

Состояние: **сделано (23.10.2026); итог, отличия от плана, проверки и числа — §10.** Дерево — `/Users/victor/Projects/raditi-nest`, ветка `refactor/nest-modules` от `main` (`c706a11`); основное дерево не меняется, ветка не отправлена.

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

1. **Тесты `core`, которые ведут настоящий движок раннера** (около 137 определений: супервизор хода, восстановление, дедлайны; единственная проверка связки `core`↔`runner` в CI): **узкое исключение для тестов.** Один тестовый файл `apps/core/src/testing/runner-side.ts` импортирует три файла движка из `apps/runner/src`; правило dependency-cruiser разрешает это только ему, продуктовый код по-прежнему изолирован. (Сделано так: файл берёт два файла движка, `core-client.ts` и `sandbox-runner.ts`; правило и входы turbo называют все три, вместе с `runner-reconciler.ts`, — §10, «Отличия от плана».)
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
src/testing/                          ids.ts, config.ts (testRunnerConfig), scripted-core.ts, fake-core-server.ts
```

- Сторона песочницы для тестов (`sandboxSide()`: `LocalTurnExecutor` над поддельным Docker) — не `src/testing/sandbox-side.ts` раннера, как в первом наброске, а подпуть `@repo/local-turns/testing` (С3): её берут и тесты раннера, и перекрёстные тесты `core`, а `core` достаёт приложение раннера только через `runner-side.ts`. Правило `package-testing-only-in-tests` называет и `local-turns` (§10, «Отличия от плана»).
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
src/infra/                            infra.module.ts (SECRET_STORE); DatabaseModule.forRoot(db) — в AppModule.forRoot рядом
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
src/infra/                            infra.module.ts (глобальный: OBJECT_STORAGE, SECRET_STORE, REDIS), redis.ts,
                                      infra.tokens.ts; PRISMA даёт DatabaseModule.forRoot(db) пакета (§5.2), его
                                      AppModule.forRoot импортирует рядом с InfraModule, как mcp и preview
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
`maskTurnEvents` (11 строк, только `core`) → `apps/core/src/turns/turn-events-mask.ts`; тесты `turn-output.test.ts`, которые проверяют код пакета без `@repo/agent-drivers`, — в пакет. Пакет получает подпуть `./testing` (`src/testing.ts`): сторону песочницы раннера `sandboxSide()` для тестов `apps/runner` и перекрёстных тестов `core` (С3, §4.1); его импортируют только тесты, `src/testing` приложений и стенды (`package-testing-only-in-tests`).

### 5.6. Удаляемые пакеты
`@repo/runner-engine` и `@repo/preview-gateway`: каталоги, правила `runner-engine-tier` и `preview-gateway-tier` (вместо них — правила допустимых пакетов на каталоги приложений), упоминания в `RUNTIME`/`SERVICES`, фильтрах путей workflow, `verify-images`, SonarCloud, документах.

## 6. Стенды, образы, CI

- Переезжают шесть стендов (решение 2): пути импортов внутри (`../../mcp/dist/…` → `../dist/…`, `../dist/turns/…` → `../../core/dist/turns/…`), кто их запускает (`infra/dev/site-verify/verify-content.mjs` — `cwd` `apps/mcp`, `infra/dev/llm-verify/workers.mjs` — каталог по роли, `verify-agent-content.mjs` — путь стенда отката), контракты (`infra/app/ci.test.mjs`, `infra/dev/site-verify/content-stand.test.mjs`, `infra/dev/llm-verify/{agent-content,live,workers}.test.mjs`), фильтры `wordpress-content.yml`.
- `.dockerignore` исключает стенды и их тесты из контекста образов (операторские команды остаются); `verify:images` проверяет, что в образах нет `verify-*.mjs`.
- `apps/core/package.json`: убираются `@repo/runner-engine`, `@repo/preview-gateway`, `@modelcontextprotocol/core`; `@repo/browser-providers` и `@rekog/mcp-nest` — в `devDependencies`; неиспользуемые `express`, `pg`, `@types/express`, `@types/pg` — после `pnpm why`: `pg` и `@types/pg` убраны (С10; `core` их не импортирует, `pg` — лишь необязательный пир `bullmq`, который нужен только его бэкенду PostgreSQL и разрешается и без `core`), `express` и `@types/express` остаются — `express` обязательный пир `@rekog/mcp-nest`, а `@types/express` дают типы `NestExpressApplication` в `src/start.ts`.
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

## 10. Результат (23.10.2026)

Сделано 21–23.10.2026 в дереве `raditi-nest`, ветка `refactor/nest-modules` от `main` (`c706a11`): план — `663c915`, срезы С1–С10 — коммиты после него. С3–С6 шли в своих деревьях (`raditi-nest-runner`, `raditi-nest-preview`, `raditi-nest-mcp`, `raditi-nest-llm`) и слиты в ветку в С7 — `6ea09e7`, `49ee10d`, `a0df45a`, `9da083c` (commitlint не принимает тип `merge`, поэтому коммиты слияния названы `refactor(<приложение>): merge …`). Каждый срез прошёл независимое ревью, подтверждённые замечания исправлены отдельными коммитами. Миграций БД нет; основное дерево, dev-база и dev-OpenBao не затронуты, `.env` не читался, `--live` не запускался. Ничего не отправлено.

### Что куда переехало

- **`apps/runner`** (С3): движок из `@repo/runner-engine` — `src/core-api` (`HttpRunnerTransport`), `src/sandbox-runner` (`SandboxRunner`), `src/reconciler` (`RunnerReconciler`), `src/vm-token` (токен ВМ, `RUNNER_TOKEN`, `RUNNER_ID` — `runnerIdOf`), `src/sandbox` (`runnerSandboxConfig`, `SANDBOX_PROVIDER`, `TURN_EXECUTOR`), `RunnerLifecycle` (запуск: опрос → сверка; остановка: сверка → опрос → `transport.close()`); `build` — `nest build`. Пакет удалён, тесты движка — в `apps/runner`, перекрёстные — в `apps/core/src/runner-api/runner-protocol.cross.test.ts`.
- **`apps/preview`** (С4): сервер из `@repo/preview-gateway` — `src/gateway` (`PreviewGatewayServer` и его части `entry`, `proxy`, `tunnels`, `limits`, `replies`, `headers`, `pages`), `src/access` (`PostgresPreviewAccess`, `PreviewSessions`, `ttl-cache`), `src/cookie`, `src/config/browser-relays.ts`; `close()` по-прежнему сам выполняет весь порядок остановки. Пакет удалён. Хранилище шлюза берёт токен `PRISMA` из подпути `@repo/service-runtime/tokens`, правило `preview-request-path` стало `reachable`. Тест хранилища из `core` — в `apps/preview` (`test:db`, шаг `gateway-db`, восьмой набор `verify:db`).
- **`apps/mcp`** (С5): 28 файлов из корня `src` — по разделам `config`, `infra`, `health`, `common`, `access`, `server`, `site-info`, `storage`, `privacy`, `content`, `browser`. `AppModule.forRoot(config, testing?)` даёт девять отказов в прежнем порядке и словами, затем проверяет `@rekog/mcp-nest` ещё до создания Nest (`assertMcpNestToolAuthorization`, ревью С5). `StorageModule` — статический глобальный, модули профилей читают настройки через `MCP_CONFIG`, аргумент `forRoot` у `BrowserModule` и `ContentModule` — только шов стендов. Стенды контента и отката — в `apps/mcp/scripts`.
- **`apps/llm`** (С6): `LlmAppModule` и класс `LlmRuntime` в 210 строк — по разделам `config`, `infra`, `egress`, `pool`, `accounting`, `maintenance`, `gateway`; хук остановки у роли один — `LlmRuntime`, порядок и сроки прежние. `session-lock.ts` — в `src/subscriptions`; рабочий процесс стенда шлюза — `apps/llm/scripts/verify-llm-worker.mjs`, роль он строит через `AppModule` и `app.get(LlmRuntime)`.
- **`apps/core`** (С8): `CoreModule` → `AppModule.forRoot({ config, background })`. Глобальные — конфигурация, `DatabaseModule`, `InfraModule` (S3, Vault, Redis), `QueueModule` и статический `MetricsRegistryModule`; новые `LeasesModule` (`SITE_LEASES`, `TURN_ASSIGNMENTS`) и `SiteContentModule` (`PLAN_VALUES`, `HOST_LOOKUP` и фабрика `SITE_CONTENT_RESOLVERS` — по резолверу на потребителя, как прежде); `YOOKASSA` — в `BillingModule`; `TurnsModule` не глобальный и владеет движком хода; токены — по `<раздел>.tokens.ts`. Каталоги `src/core/` и `src/runner/` и мёртвые `src/version.ts` и `deploy-step/index.ts` удалены.
- **Пакеты** (С1, С2): `@repo/turn-keys` разделён по протоколу — в пакете `turn-key.ts`, `call-ledger.ts` (`LlmCallLedger`), `turn-revocation.ts` (`revokeTurnCredentials`) и сокращённый `gateway-types.ts`; выдача ключей, сборщик и `backends.ts` — в `apps/core/src/llm`, значения переменных клиента — в `apps/core/src/site-env`, приём запросов (`PostgresGatewayStore`) — в `apps/llm/src/accounting`. `@repo/site-content` отдал `core` значения плана БД, шаги и запись предпросмотра, `mcp` — токен `MCP_CONTENT_RESOLVER` и получил из `mcp` 34 теста резолвера и 3 теста значений предпросмотра. `@repo/service-runtime` отдал `core` метрики, их токены и фейки Redis, очереди и S3 и получил `DatabaseModule` и `HealthModule`. `@repo/app-bootstrap` отдал `readAppVersion` в `apps/mcp/src/version.ts` и больше не зависит от `zod`. `@repo/local-turns` отдал `maskTurnEvents` в `apps/core/src/turns/turn-events-mask.ts`, получил тесты вывода хода из `core` и подпуть `./testing`.
- **С9**: `.dockerignore` и проверка стендов в образах (`verify:images` — 26 проверок вместо 22), SonarCloud, фильтры путей workflow (новый пробел нашёлся один — `packages/storage/**` в `llm-gateway.yml`), CLAUDE.md, spec, README, roadmap.

### Решения владельца и как они исполнены

1. **Тесты `core` с настоящим движком раннера.** `apps/core/src/testing/runner-side.ts` — единственный файл, которому `apps-are-isolated` разрешает импорт другого приложения; правило `runner-side-reaches-the-engine-only` пускает его только к файлам движка, `runner-engine-speaks-the-protocol-only` и `runner-engine-takes-only-types-of-zod` держат сами эти файлы на протоколе, `core-product-no-testing` — продукт `core` без него. Тесты `core` с видом `runner` (супервизор, восстановление, дедлайны) и `runner-protocol.cross.test.ts` идут через него.
2. **Стенды.** Шесть стендов одного приложения переехали (пять — в `apps/mcp/scripts`, один — в `apps/llm/scripts`), стенды нескольких приложений остались в `apps/core/scripts`. `.dockerignore` не пускает в образы `**/scripts/verify-*.mjs`, `**/scripts/*.test.mjs` и `apps/core/scripts/opencode-runner-fixture*.mjs`; `verify:images` проверяет в каждом образе, что стендов нет, а команды оператора есть, тест `infra/app/verify-images.test.mjs` применяет `.dockerignore` к каждому каталогу `scripts/` так, как Docker, а образ `core` в С10 собран и проверен отдельно (ниже).
3. **`@repo/turn-keys` по протоколу** — как выше. `apps/llm/src/subscriptions/retire.integration.test.ts` переписан без кода `core`, проверки стороны `core` — в `apps/core/src/llm/turn-credentials.integration.test.ts`.
4. **Docker-тест менеджера предпросмотров** запускает `apps/preview/dist/main.js` процессом (`apps/core/src/testing/preview-app.ts`): приложение считается запущенным, только когда в его выводе есть строка `preview role listening on …`, отвечает `/__raditi/health` и процесс жив, а остановка проверяет код выхода (ревью С4); `preview.yml` сначала собирает `preview`.

Значения по умолчанию §2.1 исполнены, как записаны. Объём анализа SonarCloud (непустые строки): 48 887 на `c706a11`, 45 729 на дереве плана с прежним списком, 50 221 с новым (С9); `apps/llm/src/subscriptions/session-lock.ts` в список назван отдельно — на `c706a11` он лежал в `src/gateway` и анализировался.

### Отличия от плана

1. **Сторона песочницы для тестов — подпуть `@repo/local-turns/testing`** (`sandboxSide()`), а не `apps/runner/src/testing/sandbox-side.ts` из наброска §4.1 (С3). Её берут и тесты раннера, и перекрёстные тесты `core`, а `core` достаёт приложение раннера только через `runner-side.ts`. Правило `package-testing-only-in-tests` называет теперь и `local-turns`; §4.1 и §5.5 поправлены.
2. **`runner-side.ts` берёт два файла движка, правило и входы называют три.** Файл реэкспортирует `HttpRunnerTransport`, `RunnerCallError`, `RunnerCommandFence`, `RunnerTransport` из `core-client.ts` и `SandboxRunner`, `SandboxRunnerDependencies` из `sandbox-runner.ts`; `RunnerReconciler` тестам `core` не нужен. Правило `runner-side-reaches-the-engine-only` (`RUNNER_ENGINE` в `.dependency-cruiser.cjs`), входы `test` в `turbo.json` и `typecheck` в новом `apps/core/turbo.json` называют все три файла, вместе с `runner-reconciler.ts`, нарочно: файлы движка могут импортировать друг друга, и то, что достаёт `runner-side.ts`, может вырасти без нового импорта в нём. Контракт `infra/app/ci.test.mjs` берёт набор файлов из правила, проходит импорты `runner-side.ts` и требует, чтобы входы называли ровно этот набор (ревью С3). Слова «три файла» в решении 1 (§2) и в §6 — о допуске правила и входах, а не об импорте.
3. **`TasksModule.forRoot(turns)` и `PreviewsModule.forRoot(turns)` — исключение из §3, п. 6** (С8, записано в §3, п. 6, и §4.5 ревью С8): статический `TurnsModule` изменил бы поведение — исполнитель хода выбирает настройка, фабрики `SANDBOX_PROVIDER` и `RunnerApiServer` отказывают в чужом режиме, а `RunnerHub` получил бы хуки остановки и при локальном исполнителе.
4. **Порядок остановки** — два сознательных отличия, оба от своего глобального `DatabaseModule`: у `core` Redis закрывается, потом Prisma отключается (прежде — одновременно в одном `InfraModule`, §4.5), у `preview` Prisma отключается после закрытия шлюза (§4.2). Остальной порядок запуска и остановки `core` при обоих исполнителях прежний — сверен пробой хуков старого и нового дерева (С8); его держат место `turns` в `AppModule` после `SiteProvisioningModule` и модуль исполнителя последним в импортах `TurnsModule`, а закрепляют тесты `app.module.test.ts` («starts and stops its background in the order it always had», «builds one turn engine and one metrics registry for the whole process»). `QueueModule.forRoot({ redisUrl, background })` остался динамическим: `@nestjs/bullmq` берёт `manualRegistration` только параметром модуля (ревью С9, §3, п. 6).
5. **Зависимости `core`:** `pg` и `@types/pg` убраны — `core` их не импортировал ни на `c706a11`, ни после, `pg` лишь необязательный пир `bullmq`; `express` и `@types/express` оставлены — `express` обязательный пир `@rekog/mcp-nest` (зависимость стенда `verify-llm-mcp-tools.mjs`), `@types/express` дают типы `NestExpressApplication` в `src/start.ts` (С10, §6).
6. **`.dockerignore` закрывает и `packages/*/scripts`** (шаблоны `**/`): иначе в образе раннера остались бы стенды `packages/agent-drivers/scripts` и `packages/sandbox-providers/scripts` (С9).
7. **`GatewayModule` у `llm` и `preview` ничего не экспортируют:** `start.ts` и рабочий процесс стенда берут `LlmRuntime` и `PreviewGatewayServer` через `app.get`, которому экспорт не нужен (§3, п. 4). Это закрепляют тесты «gives startLlm the runtime of the gateway, which no module exports» и «gives startPreview the server of the gateway, which no module exports» (С7 и ревью С7).

### Тесты до и после

Базовая линия `c706a11` (`baseline.sh`: vitest JSON каждого рабочего пространства без `DATABASE_URL`) — 35 рабочих пространств, 13 085 прошли, 2 526 пропущены. Конечное дерево (`f189633`) — 33 рабочих пространства (два пакета удалены), 13 119 прошли, 2 531 пропущены, ни один не упал; `node --test` `core` — 58 из 58. Изменились:

| Рабочее пространство | `c706a11`: прошли / пропущены | `f189633` | Откуда разница |
| --- | --- | --- | --- |
| `core` | 1575 / 296 | 1601 / 295 | −14 случаев вывода хода — в `local-turns`, +3 теста записи предпросмотра (С1); тесты выдачи ключей, сборщика и переменных клиента из `turn-keys` (С2); −27 тестов движка — в `runner` (С3); 7 пропущенных без базы тестов хранилища предпросмотров — в `preview` (С4); новые тесты устройства (С8, С10) |
| `llm` | 444 / 118 | 464 / 117 | тесты хранилища шлюза из `turn-keys` (С2), тесты модулей (С6, ревью С6 и С7) |
| `mcp` | 541 / 144 | 506 / 144 | −37 тестов — в `site-content` (С1), +2 теста `createMcpRuntime` (ревью С5) |
| `preview` | 7 / 0 | 62 / 7 | 53 теста из `preview-gateway`, 7 тестов с базой из `core`, тесты порядка остановки и экспорта (С4, С7) |
| `runner` | 7 / 0 | 39 / 0 | тесты движка из `runner-engine` и `core` (С3, ревью С3) |
| `@repo/turn-keys` | 90 | 30 | тесты ушли в `core` и `llm`, новые тесты журнала вызовов и отзыва (С2) |
| `@repo/site-content` | 7 | 41 | +34 теста резолвера и +3 теста значений предпросмотра из `mcp`, −3 теста записи предпросмотра — в `core` (С1) |
| `@repo/local-turns` | 2 | 16 | 14 случаев вывода хода из `core` (С1) |
| `@repo/service-runtime` | 1 | 5 | тесты `DatabaseModule` и `HealthModule` (С1) |
| `@repo/runner-engine` | 3 | — | пакет удалён, тесты — в `runner` |
| `@repo/preview-gateway` | 53 | — | пакет удалён, тесты — в `preview` |

Остальные 24 рабочих пространства — с прежними числами. Пропало 66 названий, каждое объяснено (сверено скриптом): 35 — «McpAppModule ›» → «AppModule ›» (С5); 14 — «CoreModule ›» → «AppModule ›» (С8); 2 — «InfraModule: the ЮKassa client ›» → «BillingModule: the ЮKassa client ›» (С8); 2 — «RunnerModule ›» → «AppModule ›» и «runnerSandboxConfig ›» (С3); 2 — «SandboxRunner with core ›» → «SandboxRunner commands ›»: они ведут только раннер (С3); 2 — половины «belongs to core alone: the runner …» модульных тестов биллинга и импорта сайта удалены по §4.1 (их держат `apps-are-isolated` и `runner-no-platform-access`), теперь это «belongs to core: its root module imports it»; 1 — «PostgresPreviewAccess › carries a visitor…» → «the preview app on PostgreSQL ›», теперь через `startPreview` (С4); 3 — пропущенные без базы тесты «operator retirement with disposable PostgreSQL» переписаны по §5.3 (С2): две новые версии в `llm`, сторона `core` — в наборе «fenced turn keys, write-once recovery and admission closure» и в «revocation of a turn key»; 5 — названия `it.each` со случайными UUID и метками времени, они меняются на каждом прогоне. Появилось 105 названий: те же переименования и переносы и новые тесты срезов. Ни один тест не потерян; ни условие `skipIf`/`runIf`, ни предел времени ни одного теста не изменились (ревью С10, линза «тесты и CI»).

### Проверки на конечном дереве (С10, `f189633`)

Каждая команда с Docker шла через общий замок Docker, по одной; стенды — под `caffeinate`.

| Проверка | Результат |
| --- | --- |
| `pnpm install --frozen-lockfile`, `pnpm db:generate` | код 0 |
| `pnpm gates` без кеша turbo (`TURBO_FORCE=true`) | код 0 за 202 с: format:check; check-env — 119 переменных; typecheck и lint — 35 из 35; check-architecture — 2003 модуля, 8732 связи, нарушений нет; test — 34 из 34 задач (`core` 1601 прошли и 285 пропущены в обычном отчёте vitest, `node --test` 58 из 58; web 1914 и 3; domain 4209; `mcp` 506 и 144; `llm` 464 и 117; `preview` 62 и 7; `runner` 39; tRPC 766 и 146; billing 359 и 1018; db 123 и 739; site-adapters 584 и 24; turn-keys 30; site-content 41; local-turns 16; service-runtime 5); `test:infra` — 627, 620 прошли, 7 пропущены; build — 8 из 8. Первый прогон упал за 171 с на нестабильности, которая была и до плана (ниже) |
| `pnpm verify:db` | код 0 за 568 с: 566 проверок общего пользователя и обновления; восемь наборов — db 862, `core` 1883 и 13 пропущены, `llm` 581, `mcp` 650, `preview` 69, billing 1377, tRPC 912, web 1917. Первый запуск остановился на preflight: Docker Desktop ответил «No such image» на закреплённую ссылку `postgres:17.11-alpine3.24@sha256:…`, хотя образ был; `docker pull` той же ссылки это снял — так уже бывало в ревью С6 и в С8 |
| `pnpm verify:images` | 26 проверок (`llm`, `mcp`, `preview`, раннер), 336 с |
| Образ `core` (`docker build -f apps/core/Dockerfile --target runtime`) | собран за 97 с; вне `node_modules` ни одного `verify-*.mjs`, `scripts/*.test.mjs` и `opencode-runner-fixture*`; в `apps/core/scripts` ровно шесть команд оператора; `src/billing/operator-cli.ts`, `src/releases/operator-cli.ts` и `dist/deploy-step/cli.js` на месте; uid 10001, git 2.47.3, gitleaks 8.30.1, `.env` нет. С `--network none` каждая команда оператора загружается из исходников и отказывает пустому вводу своими словами (код 1), `deploy-step` без аргументов печатает справку (код 2), `dist/main.js` — «Invalid core configuration» под `[core]` |
| `verify:llm-gateway` | 58 проверок, 325 с со сборкой; 42 завершённых вызова |
| `verify:agent-content` | 13 проверок, 56 с со сборкой |
| образ `llm` (`raditi-p3verify-llm:b14`, по `infra/app/README.md`, «Проверки»), `verify:llm-firewall` | собран за 367 с; firewall — прошёл, 44 с |
| `verify:llm-app` | 11 групп, 20 с, на этом образе |
| `verify:edge` | 31 проверка, 264 с со сборкой образов web, `core` и migrate |
| `verify:vault` | 586 и 63 (клиент), 5 с |
| `verify:site` | 8 строк PASS, 24 с (WordPress 7.1.2, MariaDB 11.4.13, WP-CLI 2.12.0) |
| `verify:mcp-content` | 34 PASS, 73 с со сборкой |
| `verify:site-connect` | 9 проверок, 54 с со сборкой |
| `verify:gitea` | 28 строк PASS, 40 с |
| `verify:site-import` | 47 проверок, 211 с со сборкой; браузерных сценариев — 10 |
| `verify:billing` | 26 сценариев, 702 проверки, 212 с (своя копия сборки — `BILLING_VERIFY_BUILD_DIR`) |
| `pnpm e2e` | 169 тестов (6 smoke и 163 главной), 278 с, на одноразовых PostgreSQL, Redis, SeaweedFS и OpenBao |
| `verify:release` | 19 сценариев, 196 проверок и 4 строки `NOTE`, как 19.10.2026; 927 с со сборкой, 217 строк PASS, FAIL нет (своя копия сборки — `RELEASE_VERIFY_BUILD_DIR`) |
| `verify:pipeline` (после `verify:release`) | 37 проверок (40 строк PASS: проверки, итог и две строки уборки — как 19.10.2026), 231 с, образом `core`, который собрал `verify:release` |
| Docker-тесты `core` так, как их ведёт `preview.yml` | 2 файла, 8 тестов: `preview.docker.integration` 4 из 4 и `working-tree-export.docker` 4 из 4 — второй в плане 56 впервые (в С4 и С7 не было образа `raditi-preview-sandbox:local`, теперь он собран, как в workflow); 75 с на одноразовой PostgreSQL с 35 миграциями |
| `verify:preview-network` | 52 из 52, 18 с |
| Docker-тест `core` так, как его ведёт `release-deploy.yml` (`deploy.integration`) | 5 из 5, 121 с |
| `verify:snapshots` | прошёл, 2 с |
| `verify:transport` | PASS, 12 проверенных пунктов, 35 с (Docker Desktop, `runc`) |
| `verify:publication` | прошёл, 15 с (gitleaks 8.30.1) |
| семь сценариев `verify-runner.mjs` под gVisor (Colima: Docker 29.5.2, `runsc` release-20260921.0) | все 7, 129 с; в ВМ ничего не осталось |
| `verify:opencode-supervisor` под gVisor | PASS, 68 с. Первый запуск отказал на preflight: с пустым `HOME` у Docker CLI нет контекста `desktop-linux`; с `DOCKER_HOST` сокета Docker Desktop, как в прогонах 15.10.2026, — зелёный |

`verify:snapshots`, `verify:transport`, `verify:publication` и `verify-runner.mjs` шли скриптами напрямую, под `env -i` с переменными из отчёта 47 и одноразовыми PostgreSQL, SeaweedFS и OpenBao: пакетные команды читают корневой `.env`. Ни одна проверка не упала из-за перестройки: после `f189633` код не менялся, итог правит только документы.

До этих прогонов в С10 закрыты восемь мелких замечаний ревью С7–С9 (`7b7d088`, `f0d0c9f`, `3748e18`, `f189633`): `infra/app/ci.test.mjs` считает рабочим пространством только каталог с `package.json` (остаток удалённого пакета ломал три теста); новый контракт — каждый модуль `dist`, который грузит стенд, имеет исходник в своём приложении (77 путей); тест, что менеджер предпросмотров, навык выпуска и планировщик отмены получают по своему резолверу контента сайта; `pg` убран из `core`; `session-lock.ts` — в `sonar.inclusions`; §8 spec и README `core` описывают порядок запуска и остановки и движок хода так, как в коде; тест `.dockerignore` берёт `scripts/` через `git ls-files`.

### Ревью С10

Четыре линзы — поведение, границы и устройство Nest, документы и правила, тесты и CI; каждое замечание проверено двумя независимыми голосами. Линза «поведение» сверила старый и новый код каждого приложения и пакета и **дефектов поведения не нашла**: множества контекстов логгеров, строк логов, имён и меток метрик совпадают, новых текстов отказов в продукте нет, все динамические модули строятся по одному разу, код, который Node грузит из исходников, импортируется. Подтверждено восемь замечаний, все мелкие:

- семь — о документах (два из них — одно и то же о `runner-side.ts` с двух линз), исправлены коммитом этого итога: `runner-side.ts` берёт два файла движка, а правило и входы turbo называют три (CLAUDE.md, spec §6 и §20, `apps/core/README.md`, `.claude/agents/spec-reviewer.md`); пункт SonarCloud spec §20 называет `session-lock.ts`; README `@repo/ip-address` говорил, что пакет может импортировать любой пакет, — его импортируют только приложения; §4.1 и §5.5 плана называли `sandbox-side.ts` раннера (выше, «Отличия от плана», п. 1); spec §16 называл перед утверждением курса кредита наборы трёх приложений — теперь `core`, `llm`, `mcp` и `preview`; `infra/dev/site-verify/README.md` говорил, что `wordpress-content.yml` на GitHub не выполнялся, — он прошёл в PR #3 и PR #10;
- восьмое — найдено и не в этой работе: Docker-набор операций БД плагина «Радити» на MariaDB 11.4 и MySQL 8.4 (`packages/site-adapters/src/wordpress-db.integration.test.ts`, 16 случаев, `RADITI_PREVIEW_DOCKER_TESTS=1`) не ведёт ни один workflow — так было и на `c706a11` (файл пришёл с #9). CI здесь не менялся; чтобы включить набор в шаг «Preview suites against the real daemon» `preview.yml`, нужны ещё загрузка `mysql:8.4` и `infra/wordpress/**` в фильтре путей.

Отклонено одно замечание: интеграционные тесты `core` и `llm` после С2 сверяют «чужую» сторону копиями её SQL (`admissibleKey`, `requestRetirement`, `withdrawRetirement` в `apps/core/src/llm/turn-credentials.integration.test.ts`, `retireDrained` в `apps/llm/src/subscriptions/retire.integration.test.ts`). Оба голоса: копии совпадают с продуктовым SQL построчно (заявленного расхождения нет), так решено в §5.3 — `apps-are-isolated` не даёт тесту одного приложения импортировать другое, — а связку `core` ↔ `llm` целиком ведёт стенд B13 (`verify:llm-gateway`, `llm-gateway.yml` на каждое изменение `apps/core`, `apps/llm`, `turn-keys` и `db`): выдачу на выводимом аккаунте, приём и отзыв, вывод аккаунта сборщиком и командой оператора. Свой SQL каждая сторона по-прежнему проверяет настоящим кодом в своём наборе.

Проверка по спецификации (`/spec-check`) после итога подтвердила одно мелкое замечание о документах: CLAUDE.md в «Стеке» и «Структуре» называл `@repo/turn-keys` общим для `core` и `llm`, а формат токена MCP и ключа хода из пакета берёт и `mcp` (`apps/mcp/src/access/mcp-access.ts`, `mcp-auth.guard.ts`, `apps/mcp/src/browser/mcp-browser.ts`). Обе строки теперь говорят то же, что spec §6 и README пакета; код не менялся.

### Не запускалось

- Живой режим (`--live`) — по правилам; `.env` не читался.
- Часть `verify:llm-app` с hairpin на мосту Linux: «SKIP: Docker Desktop cannot bind the Linux bridge IP on macOS» — её ведёт `llm-app.yml` на Linux, как и в плане 55.
- `verify:edge --renewal` (проверка 19, продление сертификата) и `--real-address` (только CI на Linux с `userland-proxy: false`).
- Docker-наборы пакетов из `preview.yml` и `release-deploy.yml` — среда предпросмотров `sandbox-providers`, `wordpress-preview` `site-adapters`, `mysql-copier` и запись по SFTP и FTP `site-connections`, `playwright` `browser-providers`: план 56 этих пакетов не менял.
- `verify:opencode`, `test:billing` и `test:site` в С10 не запускались — в §8 их нет.
- Прогон на GitHub: ветка не отправлена.

### Известная нестабильность

`apps/core/src/site-provisioning/site-import.test.ts` под полной нагрузкой машины: в первом прогоне `pnpm gates` 2 из 41 тестов («recovery › between main and the tag: no second download…» и «a push of main that outlived its run › lands during the walk…») вышли за предел vitest 5 с при загрузке 474%; повтор — зелёный. Сам файл, код, который он проверяет, его фикстуры и `vitest.config.ts` `core` с `c706a11` не менялись; самый долгий тест файла и тогда, и сейчас идёт 2,8–3,1 с в одиночку. Предел времени не трогали: поведение не меняется, причина — не перестройка.

### Открыто

- SonarCloud снова посчитает перенесённые файлы новым кодом (§2.1, риск 6); его замечания в коде, который был до переноса, перестройка не чинит — как и в PR #10.
- Ничего не отправлено, на GitHub ветка не исполнялась: фильтры путей и имена скриптов workflow проверены контрактом `infra/app/ci.test.mjs`, но не прогоном.
- Пробелы фильтров путей, которые были и на `c706a11` (`preview.yml` не называет `apps/core/src/{config,git-workspace,site-provisioning}` и пакеты `turn-keys`, `mail`, `vault`, `yookassa`, `agent-drivers`, `storage`; `wordpress-content.yml` — `apps/core/src/sessions/snapshot.service.ts`), оставлены как были (С9).
- `verify:images` не собирает образ `core`: его содержимое проверено в С10 вручную, а результат `.dockerignore` для `core` держит тест `verify-images.test.mjs`. Контракт путей сборки стендов проверяет, что исходник есть, но не что в нём есть имена, которые стенд импортирует.
- Дочерний процесс `startPreviewApp` не останавливается вместе с убитым воркером vitest (ревью С4); исправление С4 только не даёт принять такой остаток за проверяемое приложение.
- Задачи roadmap этой работой не закрываются: N8 (канал `core` → `mcp`) и P6 (`mcp` в compose app-ВМ) открыты, как были.
