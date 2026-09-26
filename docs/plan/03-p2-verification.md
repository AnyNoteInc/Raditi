# P2: локальный Docker и супервизор хода

Проверено 26.09.2026 на macOS, Node 26.10.0, pnpm 12.6, Docker Desktop 29.6.2, runtime `runc`. Это проверка локальной части P2. Весь пункт roadmap остаётся открытым: Linux/gVisor networking и пилотный pull-runner ещё не готовы.

## Реализовано

- `packages/sandbox-providers`: настоящий Docker provider через локальный Unix socket. Образ закреплён digest, uid 10001, read-only rootfs, cap-drop ALL, no-new-privileges, ограниченные tmpfs/CPU/RAM/PID, без host mounts и опубликованных портов. Создание, поиск, повторное подключение и удаление сверяют точные ID, метки, эпоху и настройки контейнера.
- До передачи любых данных задачи доверенный bootstrap один раз выполняется как uid 0 без дополнительных capabilities и сохраняет PID/starttime служебного процесса в отдельном root-owned tmpfs. Файл доступен агенту только для чтения; подмена argv или pid не делает процесс исключением для quiesce. Агент и все обычные exec работают как uid 10001.
- Обёртка exec сохраняет ограниченные бинарные stdout/stderr, отдельные байтовые оффсеты и результат. Команды, stdin и файлы проходят через exec; archive API и `docker cp` не используются. Проверены timeout, cancel, потомок с `setsid`, quiesce и переподключение новым экземпляром provider. Deadline exec хранится также в неизменяемых аргументах Docker Exec.
- Для `runc`: internal bridge на попытку, отдельный служебный сетевой фильтр, шлюз с точным списком маршрутов. Разрешены POST `/v1/responses`, POST `/v1/chat/completions`, GET/POST/DELETE `/mcp`. DNS, прямой доступ к адресам, произвольные Host/пути/методы, redirect, CONNECT и upgrade не разрешены. Служебные контейнеры имеют собственные PID-пространства; агент не получает `NET_ADMIN`.
- Отдельный deadline watchdog работает без процесса core, удаляет просроченные контейнеры и ресурсы шлюза. Есть отдельный compose-файл; сокет Docker подключён только к этому доверенному сервису. Watchdog необходимо запустить до приёма ходов.
- `PostgresSiteLeaseStore`: атомарный захват, эпоха, продление, проверка и освобождение по полному fence; неоднозначная запись удерживает аренду. Сроки проверяются по часам PostgreSQL, включая повторную проверку после ожидания row lock. Проверены 12 конкурентных претендентов и восстановление только точной удержанной эпохи.
- Аренда супервизора и recovery имеет минимум 90 секунд запаса после лимита операции: 60 секунд на начатую команду публикации и 30 секунд на завершение. Регрессии проверяют push в последний момент при зависшем heartbeat; неоднозначный результат удерживает аренду.
- Доверенные Git-команды запускает отдельный Node-супервизор с абсолютным монотонным deadline: timeout сохраняется при SIGSTOP core, разрыв IPC при SIGKILL core завершает группу native-процесса. Семь регрессий проверяют эту границу и точность двоичного ввода/вывода. CAS защищает Git-ref, но не является общей транзакцией PostgreSQL и Git; неоднозначный ответ сервера требует проверки кандидата и recovery.
- `TurnSupervisor`: аренда → чистая рабочая копия → restore → подготовка драйвера → exec → quiesce → кандидат Git → снимок → удаление контейнера → fenced push. Нормализованные события и фазы пишутся в `TaskEvent` под проверкой аренды; известные секреты не принимаются в журнал. SQL-схема не менялась.
- Доверенная публикация: Git bundle без credentials передаётся в контейнер через stdin; на хосте отдельный чистый index, ограничение патча/архивов/объектов, запрет опасных путей и типов файлов, gitleaks, детерминированный коммит от бота, push с проверкой исходного SHA. Настройки и hooks `.git` агента не используются на хосте.
- Снимок содержит полный патч кандидата, его `headSha` и пустой `untracked`. Опциональные `git.publication.taskId/committedAt` защищены AAD; старые снимки P1 сохраняют прежний формат AAD. Capture сравнивает с доверенным исходным SHA, включая самостоятельно закоммиченные агентом изменения.
- `TurnPublicationRecovery.recover({ heldFence, snapshot, workspace })` восстанавливает публикацию только из завершённого проверенного снимка. Новая эпоха, удаление старых контейнеров по точным ID, повторная сборка и проверка SHA, fenced CAS push, журнал и освобождение аренды. Неоднозначность снова удерживает аренду.

## Проверки и повтор

Финальный `pnpm gates` прошёл: `check-env`, `typecheck`, `lint`, `check-architecture`, `test`, `test:sandbox-infra`, `build`. Основной прогон — 1378 пройденных тестов; 61 проверка PostgreSQL/Docker без opt-in пропущена. Эти интеграционные проверки выполнены отдельно, как описано ниже; Node-набор шлюза/watchdog с Docker — 6/6.

Интеграционные тесты не требуют моделей, настоящих клиентских данных и внешних Git-репозиториев. PostgreSQL-проверки запускаются при непустой `DATABASE_URL`; в обычном прогоне без неё пропускаются. Отдельно выполнены все 85 тестов `@repo/db` на PostgreSQL и три теста SQL-журнала хода.

Собрать локальные образы из корня репозитория:

```sh
docker build --target runtime -f infra/sandbox/Dockerfile -t raditi-sandbox-runtime:p2 .
docker build --target gateway -f infra/sandbox/Dockerfile -t raditi-sandbox-gateway:p2 .
docker build --target network-guard -f infra/sandbox/Dockerfile -t raditi-sandbox-guard:p2 .
docker build --target watchdog -f infra/sandbox/Dockerfile -t raditi-sandbox-watchdog:p2 .
```

Закрепить именно результаты сборки, затем запустить реальные Docker-тесты:

```sh
export RADITI_DOCKER_TEST_IMAGE="$(docker image inspect raditi-sandbox-runtime:p2 --format '{{index .RepoDigests 0}}')"
export SANDBOX_GATEWAY_IMAGE="$(docker image inspect raditi-sandbox-gateway:p2 --format '{{index .RepoDigests 0}}')"
export SANDBOX_NETWORK_GUARD_IMAGE="$(docker image inspect raditi-sandbox-guard:p2 --format '{{index .RepoDigests 0}}')"
pnpm --filter @repo/sandbox-providers exec vitest run src/docker.integration.test.ts src/gateway/gateway.integration.test.ts
pnpm test:sandbox-infra
```

На Docker с классическим image store локальная сборка может не иметь `RepoDigests`: сначала загрузить образ в локальный реестр и получить digest оттуда. Не заменять его изменяемым тегом в `SandboxSpec`.

Проверены десять Docker-тестов: девять для provider/runtime и один для полной сети. Watchdog проверен и отдельным Node-процессом, и реально собранным контейнером compose. Временные контейнеры, сети, записи тестов и запущенные для проверки сервисы удаляются/останавливаются; собранные локальные образы оставлены для повтора.

Запуск независимого watchdog:

```sh
export SANDBOX_WATCHDOG_IMAGE="$(docker image inspect raditi-sandbox-watchdog:p2 --format '{{index .RepoDigests 0}}')"
docker compose --env-file .env -f infra/sandbox/docker-compose.yml up -d
```

`SANDBOX_DOCKER_SOCKET` по умолчанию `/var/run/docker.sock`. TCP и `DOCKER_HOST` не используются. Настройки шлюза — единая группа: `SANDBOX_GATEWAY_IMAGE`, `SANDBOX_NETWORK_GUARD_IMAGE`, `SANDBOX_LLM_UPSTREAM`, `SANDBOX_MCP_UPSTREAM`. Последние два значения — доверенные HTTP(S) origins без credentials, пути и query; внутри шлюза они должны быть достижимы через его служебную сеть. При отсутствии группы разрешён только `network: none`.

Проверен настоящий Gitea registry: отдельная синтетическая учётная запись и token только на время проверки, push → удаление локальной ссылки → pull по точному digest → сверка. Учётная запись, пакет и локальные registry-ссылки удалены. Повтор при запущенной локальной Gitea:

```sh
node packages/sandbox-providers/scripts/verify-registry.mjs raditi-sandbox-runtime:p2 <gitea-container-id> http://127.0.0.1:3300
```

Для проверки доверенной публикации нужен gitleaks на доверенном хосте. Использован официальный v8.30.1 для darwin_arm64, архив SHA-256 `b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5`, сверенный с checksums релиза. Проверены обычная публикация, реальный синтетический секрет, попытка подавления через `gitleaks:allow` и отказ без раскрытия секрета. Скрипт повторной проверки — `apps/orchestrator/scripts/verify-publication.mjs`; пути задаются `P2_GITLEAKS_BINARY` и `P2_SANDBOX_IMAGE`, сначала нужен build orchestrator. Он работает с временным локальным bare-репозиторием и Docker, не с репозиторием пользователя.

## Незакрытые гейты

1. **Linux/runsc и сеть.** `runsc + gateway` сейчас явно отклоняется. gVisor использует netstack/AF_PACKET; namespace OUTPUT-фильтр, проверенный под runc, не доказывает изоляцию под runsc. Нужна фильтрация на стороне хоста и проверка DNS/IPv4/IPv6/host/bridge/metadata endpoint на Linux. Production по-прежнему требует gVisor; переключать его на runc нельзя.
2. **Роль runner пилота.** Pull-dispatch без входящих портов, отдельная ВМ, выдача core ограниченных S3 grants и ключа данных, перенос аренд и журналов между процессами. Нынешний локальный adapter не выдаётся за распределённый runner.
3. **Восстановление незавершённого exec.** Provider умеет attach, а журнал хранит execId и оффсеты полных строк. Автоматического восстановления всего TurnSupervisor с повторной выдачей credentials и исходным RunContext пока нет. Завершённый снимок можно повторно опубликовать; неполный snapshot reservation сохраняется для отдельного разбора.
4. **Интеграция следующих задач.** Реальные AgentDriver prepare/command/resume — P4/P5; выпуск коротких credentials и REST GitProvider — P8; очередь, Task/TaskTurn lifecycle, деньги, Redis/SSE и выдача результата клиенту — P12. Текущий recovery возвращает manifest/headSha, не реконструирует продуктовый статус задачи.

Изменения последовательности снимка и публикации, отдельных оффсетов потоков и ограничений сети внесены в `docs/spec.md`. Полный P2 не отмечен выполненным.
