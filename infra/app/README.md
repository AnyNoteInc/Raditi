# app-ВМ: выкладка и эксплуатация

**Гейт владельца от 30.09.2026:** до выкладки на облачные серверы вся работа выполняется локально и проходит полный e2e с настоящим WordPress — агентская задача, применение кода, бэкап, проверка, автоматический и ручной откат. [Критерии локального прохода](../dev/site-verify/README.md). Подготовительный `pnpm verify:site` и smoke платформы этот гейт не закрывают. Пока полного отчёта нет, ниже приведён будущий runbook, облачная выкладка отложена.

Compose app-ВМ (spec §19): Traefik — единственный публичный вход (80/443, сертификаты Let's Encrypt выпускает сам), web, `core`, PostgreSQL, Redis. Миграции и сиды — отдельные шаги (профиль `ops`). Каждое приложение платформы — свой процесс и свой образ: `core` (`CORE_IMAGE`, `apps/core/Dockerfile`), шлюз подписок `llm` (P3, `LLM_IMAGE`, `apps/llm/Dockerfile`) включается профилем `llm`, шлюз предпросмотров `preview` (`PREVIEW_GATEWAY_IMAGE`, `apps/preview/Dockerfile`) — наложением `docker-compose.preview.yml`, раннер песочной ВМ (`RUNNER_IMAGE`, `apps/runner/Dockerfile`) работает на своих ВМ (`infra/sandbox`). `mcp` (P6) в compose app-ВМ ещё не добавлен, сервис появится с P6. Образы `llm`, `mcp`, `preview` и раннера собирает и проверяет снаружи `pnpm verify:images` (workflow `images.yml`), `core` и `web` — `verify:edge`; `Dockerfile` всех шести проверяет контракт `images.test.mjs`. Переменной `ORCHESTRATOR_ROLES` больше нет: что запустится, определяет образ.

| Файл | Что это |
| --- | --- |
| `docker-compose.yml` | Сервисы, сети, тома. Статика Traefik — флагами в `command:` |
| `traefik/dynamic/raditi.yml` | Маршруты: apex → web, `www` → редирект на apex, `/api/metrics` закрыт, предел тела запросов к API — 512 КиБ |
| `docker-compose.preview.yml`, `traefik/dynamic/preview.yml` | Предпросмотры диалогов, по выбору: шлюз `preview`, wildcard через DNS-01 и маршрут к шлюзу (раздел «Предпросмотры») |
| `env.example` | Образец `/opt/raditi/app/.env`: только несекретные значения и образы по digest |
| `secrets.example/` | Раскладка секретов `/run/raditi/<сервис>/` — какие файлы и что в них |
| `postgres/init-roles.sh` | Единый пользователь PostgreSQL `raditi`, владелец базы и схемы, для приложений, миграций, сидов и экспортёра; переход со старых ролей |
| `preflight.sh` | Проверки хоста перед стартом, `ExecStartPre` юнита |
| `dump-db.sh` | Дамп базы перед миграцией, шаг обычной выкладки |
| `systemd/raditi-app.service` | Запуск стека, как только проходит `preflight.sh`; повтор каждые 30 секунд |
| `*.test.mjs`, `verify-edge.mjs`, `verify/` | Проверки: `pnpm test:infra` и `pnpm verify:edge` |

Образ песочницы задаётся одной переменной `SANDBOX_IMAGE=git.raditi.ru/raditi/sbx-wordpress@sha256:<digest>` для всех драйверов WordPress. Перед запуском заменить нулевой digest из образца фактическим дайджестом собранного образа: preflight отвергает нулевой digest у любого образа; `SANDBOX_IMAGE_PREFIX` больше не используется. Образ передаёт core, раннер получает его в назначении хода.

## Что открыто

- **Всему миру** — только 80 и 443 Traefik. 80 — редирект на HTTPS и проверка HTTP-01: Let's Encrypt проверяет домен из нескольких стран, поэтому 80 открыт всем.
- **API раннеров** (:8083) — голый HTTP, опубликован только на `APP_PRIVATE_IP`. Группа безопасности открывает его только подсети песочных ВМ. Хеш токена ВМ привязан к её частному адресу (`RUNNER_TOKENS=id:sha256@ip`).
- **Шлюз подписок** (:8084, профиль `llm`) — HTTP только на `APP_PRIVATE_IP`, для подсетей песочных ВМ. Core обращается к этому же адресу с общим `METRICS_TOKEN`; общих сетей core/llm нет. После Docker SNAT шлюз видит core, web и Traefik под одним адресом (`LLM_OUT_GATEWAY`), поэтому их различает firewall хоста: новые соединения к шлюзу принимаются только с моста core и из подсетей песочных ВМ (раздел «Профиль llm»).
- **Не публикуются:** `core` :8081, PostgreSQL, Redis, Traefik :9000 (ping и метрики).

Опубликованные порты Docker обходят `ufw`, поэтому граница — группы безопасности облака: 80 и 443 — всем, 8083 и 8084 — подсеть песочных ВМ, 22 — бастион.

## Предел тела запросов

Запросы к `/api/` с любым методом, кроме GET и HEAD, идут через маршрут `web-api-body` с middleware `api-body-limit` (buffering): тело до 512 КиБ и ответ до 8 МиБ Traefik держит целиком в памяти. Исключение — загрузка аватара `/api/profile/avatar`: её 5 МиБ web читает сам после проверки сессии. Тот же middleware стоит на маршруте `web-reset-password`. Страницы и GET, в том числе SSE-поток задачи, через него не идут: middleware задерживает весь ответ.

- Тело больше предела получает 413 от Traefik, web такого запроса не видит. Тело без объявленной длины тоже получает 413: для него Traefik открывает временный файл, который остаётся пустым, поэтому у контейнера есть tmpfs `/tmp` на 1 МиБ. Без записываемого `/tmp` ответ был бы 500.
- На каждое отклонённое тело Traefik пишет строку уровня `error` от `oxy/buffer`. Это отклонённый запрос, а не сбой. В журнале доступа у него `DownstreamStatus: 413`, `OriginStatus: 0` и маршрут `web-api-body@file`.
- Ответ API больше 8 МиБ на запрос с телом клиент не получит: на краю он превращается в 500.
- Собственные пределы web меньше и действуют и за краем, и внутри сети Docker: `/api/auth/*` — 64 КиБ, `/api/trpc/*` — 256 КиБ, вебхук ЮKassa — 64 КиБ, аватар — 5 МиБ и 64 КиБ на обёртку формы. Тело запроса к странице Next буферизует не больше 1 МБ.
- Ограничения числа одновременных запросов на краю пока нет: каждое тело в полёте занимает память Traefik (256 МиБ на контейнер). Решение — за владельцем, к M10.

## Секреты

В `docker-compose.yml`, `.env` сервера и git секретов нет. Каждый сервис читает свои файлы из `/run/raditi/<сервис>/` — это tmpfs хоста. Их рендерит `raditi-secrets.service` (vault-agent, M10) из `kv/platform/app/<сервис>` до старта `docker.service`. Каталог монтируется только в свой контейнер. Если каталога нет, контейнер не стартует: пустой каталог Docker не создаёт.

| Каталог | uid | Файлы |
| --- | --- | --- |
| `web/` | 10001 | `app.env`: `DATABASE_URL` (`raditi`), `REDIS_URL` (общий пользователь `default`), `BETTER_AUTH_SECRET`, ключи SmartCaptcha, ключи S3 сервисного аккаунта web, AppRole web, собственный `METRICS_TOKEN` (не равен токену core и llm); `vault-ca.pem` |
| `core/` | 10002 | `app.env`: `DATABASE_URL` (`raditi`), `REDIS_URL` (общий пользователь `default`), ключи S3 сервисного аккаунта core, AppRole core, `METRICS_TOKEN` (общий с llm), `SENDSAY_API_KEY`; `vault-ca.pem` |
| `llm/` | 10008 | `app.env`: общий `DATABASE_URL` (`raditi`), собственные `VAULT_ROLE_ID`/`VAULT_SECRET_ID` для `llm-subscriptions`, общий с core `METRICS_TOKEN`; `vault-ca.pem`, `egress-ca.pem`, `egress-client.pem` (цепочка), `egress-client-key.pem` |
| `migrate/` | 10004 | `app.env`: `DATABASE_URL` владельца схемы `raditi` (им же пользуется `seed`) |
| `postgres/` | 70 | `superuser-password`, `password` (общий пароль `raditi`) |
| `redis/` | 10003 | `users.acl` (единственный пользователь `default`, SHA-256 общего пароля), `password` (тот же пароль для healthcheck) |

- Каталог — 0700, файлы — 0400, владелец — uid своего сервиса.
- Общий пароль PostgreSQL в `postgres/password` и во всех `DATABASE_URL` берётся из одной записи Vault. Общий пароль Redis в `redis/password`, его SHA-256 в `users.acl` и `REDIS_URL="redis://:<пароль>@redis:6379"` у web и core также берутся из одной записи Vault.
- Пароли PostgreSQL и Redis — только из алфавита `[A-Za-z0-9_-]` (`openssl rand -hex 24` или base64url). Шаблон подставляет их в `DATABASE_URL` и `REDIS_URL` без кодирования, а `@ / : ? # %` ломают адрес, хотя файл секрета получит пароль целиком.
- `app.env` читает `node --env-file`: без кавычек всё после `#` отбрасывается. Поэтому шаблон пишет каждое значение в двойных кавычках (`KEY="…"`); `"`, `\` и перевод строки в значении недопустимы.
- `NODE_EXTRA_CA_CERTS` и другие переменные, которые Node читает при старте процесса, задаются через `environment:` в `docker-compose.yml`, а не `app.env`. Vault отвечает по TLS с сертификатом внутреннего CA (spec §19): web, `core` и `llm` получают `NODE_EXTRA_CA_CERTS=/run/raditi/vault-ca.pem` — файл своего каталога секретов — и запись `vault.raditi.internal` → `VAULT_PRIVATE_IP` в `extra_hosts`, без резолвера. `VAULT_PRIVATE_IP` обязателен в `.env` и при выключенном профиле `llm`; preflight требует `vault-ca.pem` у web и core всегда, у llm — при включённом профиле, и тогда же проверяет, что все три файла содержат только действующие сертификаты CA. Приложение `llm` в production принимает в `NODE_EXTRA_CA_CERTS` только этот путь (`PRODUCTION_VAULT_CA_FILE` в `apps/llm/src/config/llm-config.ts`; тест `apps/llm/src/config/llm-config.contract.test.ts` держит его равным значению в `docker-compose.yml`): с любым другим файлом оно не стартует и называет переменную — это исполняет `pnpm verify:llm-app` на production-образе. Команды оператора (`pnpm --filter llm subscriptions:*`) этим правилом не связаны. К провайдерам переменная не относится: их TLS шлюз проверяет по встроенному набору корней Node. Сами файлы рендерит vault-agent (M10). По решению владельца подключения web к Redis, S3 и Vault сохраняются для предстоящих функций; health проверяет их вместе с PostgreSQL.
- Хеш для `users.acl`: `printf %s "$пароль" | sha256sum`, в файле — `#<hex>`.
- `superuser-password` нужен только первому `initdb`: `10-roles.sh` снимает пароль суперпользователя `postgres`, и тот входит только через сокет внутри контейнера. Ротация его не касается, но файл должен быть: образ читает его при каждом старте.
- Исключение из правила 2: ключи сертификата и ACME-аккаунта лежат в `acme.json` на томе `acme` (0600, только Traefik). В Vault и бэкапы они не входят. При утрате Traefik регистрирует новый аккаунт и перевыпускает сертификаты с учётом действующих лимитов Let's Encrypt (раздел «Утрата `acme.json` и смена способа проверки»).

**PostgreSQL: один пользователь.** По решению владельца от 30.09.2026 все сервисы, включая `llm` и будущий `mcp`, миграции, сиды и экспортёр используют `raditi`, владельца базы и схемы. Отдельных пользователей и ACL по сервисам, таблицам или колонкам нет. Проверки бюджета, отзыва ключей и правил учёта остаются в коде и ограничениях БД. AppRole Vault и uid контейнеров сохраняются; Redis также использует одного пользователя `default`.

**Переход со старых ролей.** На существующем томе сначала остановить web и `core` (`docker compose stop web core`), а также `llm`, `mcp` и экспортёр, если они уже подключены. Отрендерить `postgres/password` и все `DATABASE_URL` с пользователем `raditi` и общим паролем. Из `/opt/raditi/app` выполнить `docker compose exec -T postgres sh -s < postgres/init-roles.sh`, затем пересоздать подключающиеся сервисы. Скрипт в одной транзакции убирает прежние роли, их обычные и default privileges; при неожиданном владении объектами или зависимостях останавливается без удаления данных. Применённую миграцию B6 не переписывают: её старые условные ACL после удаления ролей пропускаются. Таблицы, данные и история миграций сохраняются.

**Ротация общего пароля.** Обновить `postgres/password` и все `DATABASE_URL`, выполнить `docker compose exec -T postgres sh -s < postgres/init-roles.sh`, затем перезапустить все подключающиеся сервисы. `migrate` и `seed` получат новое значение при следующем запуске. Скрипт берётся с хоста, а не из контейнера: смонтированный одиночный файл после обновления каталога остаётся прежней версией, пока контейнер postgres не пересоздан (git и rsync заменяют файл новым). Скрипт повторяемый и работает до и после миграций.

**Redis: один пользователь и пароль.** Web, `core` и healthcheck используют `default`; отдельных пользователей `web`, `core` и `health` нет. Пароль обязателен, административные команды и `FLUSHALL`, `FLUSHDB`, `KEYS`, `SWAPDB` запрещены. Redis не публикует порт наружу. При переходе со старой схемы остановить web и `core`, заменить `users.acl` и оба `REDIS_URL`, отрендерить `redis/password` вместо `health-password`, затем выполнить `docker compose up -d --wait redis web core`: healthcheck изменился, поэтому Redis пересоздаётся; его данные сохраняются в прежнем томе.

**Ротация Redis.** Vault-agent обновляет `users.acl`, `redis/password` и `REDIS_URL` web и core из одной записи. Затем `docker compose stop web core`, `docker compose restart redis`, `docker compose start web core`. Redis читает ACL при старте, приложения — `app.env` при старте; данные сохраняет AOF. На время этих команд сервисы приостановлены. Изменение пароля не требует отдельной учётной записи администратора.

## Профиль llm

Профиль выключен по умолчанию. Перед его включением нужны рабочий HTTPS Vault, отдельный AppRole с политикой `llm-subscriptions` и mTLS-прокси выхода. В `.env` задаются `COMPOSE_PROFILES=llm`, частные `APP_PRIVATE_IP` и `VAULT_PRIVATE_IP`, публичный `EGRESS_PROXY_IP` и `VAULT_ADDR=https://vault.raditi.internal:8200`. Документационный адрес прокси из образца намеренно не проходит preflight. В `LLM_GATEWAY_CLIENTS` — только подсети песочных ВМ и точный `LLM_OUT_GATEWAY/32` для управляющих запросов core после Docker SNAT. Из этого же списка firewall хоста берёт адреса, с которых принимает входящие к шлюзу; запись `LLM_OUT_GATEWAY/32` он не использует, core допускается по своему мосту. Подсети песочных ВМ не должны совпадать с подсетями мостов Docker этой ВМ: иначе контейнер с таким адресом пройдёт как песочная ВМ. Подсеть `LLM_OUT_SUBNET` не пересекается с адресами app/Vault и существующими сетями Docker; по умолчанию — `172.29.84.0/24`. Единственному провайдеру продукта, Z.ai, узел выхода не нужен (ответ владельца на П2 от 05.10.2026; прямой путь шлюз умеет с G4), но профиль пока собран только с прокси: Compose всегда задаёт `llm` четыре `LLM_EGRESS_*`, а preflight требует `EGRESS_PROXY_IP`. Профиль без узла выхода — задача M10.

Контейнер собран из своего образа `LLM_IMAGE` (`apps/llm/Dockerfile`: без `git` и `gitleaks`, они шлюзу не нужны), одна реплика, uid 10008, ходит только к PostgreSQL, Vault и прокси. Его сети: `llm-data` с PostgreSQL, `llm-edge` для входящих и `llm-out` для выхода. Общих сетей с web, core и Redis нет. Пароль PostgreSQL общий; AppRole и каталог секретов отдельные. Ключи аккаунтов подписки лежат в Vault (`subs/`): шлюз их только читает (политика `llm-subscriptions`), записывает команда оператора `subscriptions:login` (`pnpm --filter llm subscriptions:login …`). Секреты и формат — [secrets.example/llm](secrets.example/llm/README.md).

**Сетевая граница до старта Docker.** На Linux-хосте нужны Node 26 по пути `/usr/bin/node`, nftables, kmod, procps (`sysctl`) и модуль `br_netfilter`. Юниты и preflight вызывают helper именно через `/usr/bin/node`: туда дистрибутив ставит собственный, более старый Node. На Node младше 26 `llm-firewall.mjs` и `llm-preflight.mjs` завершаются с ошибкой «Node 26 or newer is required», а не с кодом 0 без единого правила. Helper устанавливается в `/usr/local/lib/raditi/llm-firewall.mjs` отдельно от каталога приложения, чтобы переживать откаты. Первую установку выполнять до первого запуска llm. Из `/opt/raditi/app` под root:

```sh
install -d -o root -g root -m 0755 /usr/local/lib/raditi /etc/systemd/system/docker.service.d
install -o root -g root -m 0644 llm-firewall.mjs /usr/local/lib/raditi/.llm-firewall.mjs.new
mv -f /usr/local/lib/raditi/.llm-firewall.mjs.new /usr/local/lib/raditi/llm-firewall.mjs
install -o root -g root -m 0644 systemd/raditi-llm-firewall.service /etc/systemd/system/raditi-llm-firewall.service
install -o root -g root -m 0644 systemd/docker-llm.conf /etc/systemd/system/docker.service.d/llm.conf
systemctl daemon-reload
systemctl enable raditi-llm-firewall.service
systemctl reload-or-restart raditi-llm-firewall.service
```

Это будущие действия на app-ВМ, локальные проверки их на хосте не выполняют. Тот же порядок обновляет ранее установленную версию с путём helper внутри `/opt/raditi/app`: заменяются обе unit-конфигурации и перечитывается systemd. Файл helper заменяется атомарно; preflight активного профиля требует его совпадения с кодом выбранного релиза.

Служба атомарно устанавливает собственную таблицу `inet raditi_llm` с hooks INPUT/FORWARD приоритета −10 и включает bridge netfilter. Правила существуют до запуска dockerd и его автоматического восстановления контейнеров; после системной загрузки nftables, перед каждым запуском Docker проверяются реальные правила. Из `rd-llmout` новые соединения разрешены только к `EGRESS_PROXY_IP:443` и `VAULT_PRIVATE_IP:8200`; из `rd-llmdb` — только к PostgreSQL :5432 в том же мосту; из `rd-llmedge` новые соединения запрещены. Доступ к портам хоста закрыт. Новые соединения в мосты llm (цепочка `to_llm`) разрешены только на порт 8084 в `rd-llmout`: с моста core `rd-core` и с адресов песочных ВМ из `LLM_GATEWAY_CLIENTS`. С мостов web и Traefik, с остальных адресов и на остальные порты, в том числе к PostgreSQL через `rd-llmdb`, — запрещены. Процессы самого хоста через FORWARD не проходят и этим правилом не ограничены: на app-ВМ работает только Docker. IPv6 закрыт раньше разрешения ответного трафика. Docker DNS использует недоступный loopback upstream; PostgreSQL разрешается локально, Vault закреплён через `extra_hosts`, прокси задан IP с проверкой TLS-имени.

Проверка перед запуском — `./preflight.sh`: валидирует профиль, права файлов, сертификаты, ключи, digest всех образов из `env.example` (включая `LLM_IMAGE` и `PREVIEW_GATEWAY_IMAGE`: они нужны, даже когда профиль `llm` или наложение предпросмотров выключены), CA Vault в каталогах web, core и llm, разделение AppRole, общий пароль БД, управляющий токен (общий у core и llm и обязательно отличный от `METRICS_TOKEN` web: web открыт в интернет), реальные правила и зависимости systemd. Отдельный секрет управляющего канала вместо `METRICS_TOKEN` — задача кода шлюза, до неё Prometheus, читающий метрики core, знает и этот токен. Затем — обычный порядок bootstrap/миграций ниже и `docker compose up -d --wait llm`. Health успешен только при HTTP 200: PostgreSQL, Vault, mTLS-проба и сборщик готовы. Он не заменяет проверку ACL AppRole: оператор проверяет права `subs/` и `turns/` по [runbook Vault](../vault/README.md).

При смене адресов сначала применить новую политику через `systemctl reload raditi-llm-firewall.service`, затем preflight и пересоздание llm. В рабочей конфигурации `BRIDGE_PREFIX` фиксирован как `rd`: preflight и firewall отвергают другое имя, чтобы после перезагрузки старые контейнеры не оказались вне правил. Переопределение в Compose предназначено только для одноразовых проверок. Перед выключением профиля выполнить `docker compose stop llm` и `docker compose rm llm`, затем убрать профиль и перезагрузить правила. Отключённый профиль сохраняет запрет для трёх мостов llm; простое выключение systemd-службы не удаляет правила. Но `docker.service` требует эту службу (`Requires=`): `systemctl stop` или `restart raditi-llm-firewall.service` останавливает или перезапускает и dockerd (контейнеры при `live-restore` продолжают работать), поэтому правила меняют только через `reload`. Служба следует за `nftables.service` (`PartOf=`, `ReloadPropagatedFrom=`), который при reload, restart и stop выполняет `flush ruleset`: после reload и restart таблица применяется заново (restart — вместе с перезапуском dockerd, он же восстанавливает собственные правила Docker), после stop служба и dockerd остановлены, preflight не проходит. Правку правил в обход systemd (`nft flush ruleset` вручную) замечают только preflight и следующий старт Docker; периодическая проверка и алерт — M9/M10. При выключенном профиле helper читает из `.env` только `COMPOSE_PROFILES` и `BRIDGE_PREFIX`: строка другого сервиса в непонятном ему виде (строчное имя, `export`) запуску Docker не мешает. При включённом профиле любая такая строка останавливает запуск; сообщение называет номер строки, без её текста. Node/nftables и drop-in Docker остаются установленными.

Перед пересозданием или ротацией прекратить выдачу новых ходов и дождаться активных вызовов. Vault-agent атомарно заменяет файлы внутри смонтированного каталога; затем `docker compose restart llm`: сертификаты и `app.env` читаются при старте. Приватный CA Vault не добавляется к доверию TLS провайдеров. Ротация mTLS не требует повторного входа в подписки.

## Предпросмотры

Предпросмотр диалога — рабочая копия сайта по адресу `https://site-<алиас сайта>-chat-<алиас диалога>.<PREVIEW_BASE_DOMAIN>` ([план 53](../../docs/plan/53-chat-preview-release.md), Р17, Р19). Снаружи его открывает шлюз — приложение `apps/preview` со своим образом `PREVIEW_GATEWAY_IMAGE`: по точному `Host` он находит предпросмотр в `preview_environments` и проксирует к его upstream; адрес upstream берётся только из строки, не из запроса. Вход — только по одноразовому билету из кабинета (`/preview/open` web), дальше — собственная cookie шлюза.

Включаются отдельным файлом Compose поверх основного, по умолчанию выключены: в `.env` — `COMPOSE_FILE=docker-compose.yml:docker-compose.preview.yml` и `PREVIEW_BASE_DOMAIN=raditi-preview.ru`, как в `env.example` (документационный `preview.example.com` preflight отклоняет). Без файла маршрута к предпросмотрам нет, и Traefik не читает ни одного секрета DNS.

- **Домен.** `raditi-preview.ru` (решение владельца от 18.10.2026; покупается до M10, заявка в Public Suffix List — позже, к запуску не обязательна). Отдельный регистрируемый домен, не под `APP_DOMAIN` и не под доменом Gitea: предпросмотр выполняет код сайта, а cookie общего домена дошли бы до кабинета. Шлюз и web в production с таким доменом не стартуют (проверка по Public Suffix List). HSTS кабинета с `includeSubDomains` на этот домен не распространяется.
- **Сертификат.** Wildcard `*.<PREVIEW_BASE_DOMAIN>` выпускает отдельный резолвер Traefik `preview` проверкой DNS-01 через Yandex Cloud DNS (провайдер lego `yandexcloud`): HTTP-01 wildcard не выпускает. Резолвер `le` кабинета не меняется, проверка у каждого резолвера одна (`pnpm test:infra`). Зона `PREVIEW_BASE_DOMAIN` делегирована в Yandex Cloud DNS; запись `*.<PREVIEW_BASE_DOMAIN>` указывает на публичный адрес app-ВМ; CAA — как у основного домена.
- **Маршрут.** `traefik/dynamic/preview.yml` пропускает к шлюзу (`preview:8090`) только имена вида `site-…-chat-….<PREVIEW_BASE_DOMAIN>` — ровно одна метка над базой. Файл целиком под условием `PREVIEW_BASE_DOMAIN` в окружении Traefik; маршруты кабинета в `raditi.yml` по-прежнему ведут только к web.
- **Секреты.** `${SECRETS_DIR}/traefik` (uid 65532): `yandex-cloud-iam-token` и `yandex-cloud-folder-id` — ключ сервисного аккаунта с ролью `dns.editor` только на эту зону, через переменные lego `*_FILE` ([образец](secrets.example/traefik/README.md)). `${SECRETS_DIR}/preview` (uid 10009): `app.env` с `DATABASE_URL` и `PREVIEW_SESSION_SECRET` ([образец](secrets.example/preview/app.env)). Vault: `kv/platform/app/traefik` и `kv/platform/app/preview`. Preflight проверяет оба каталога и домен, только когда `COMPOSE_FILE` называет файл предпросмотров.
- **Сети.** Шлюз и Traefik встречаются только в `preview-edge`, шлюз и PostgreSQL — в `preview-data`; общих сетей с web, core и Redis у шлюза нет. `preview-out` (мост `rd-preview`) — выход шлюза к upstream предпросмотров на частных адресах песочных ВМ; ограничить его подсетью песочных ВМ — правило firewall хоста M10.
- **Адрес.** Файл даёт одни и те же `PREVIEW_BASE_DOMAIN` и `PREVIEW_SCHEME=https` (порт — порт схемы, `PREVIEW_PUBLIC_PORT` не задан) трём сервисам: web строит по ним билеты и `/preview/open`, core — имена предпросмотров, шлюз — маршрут. Других переменных web и core файл не добавляет (`pnpm test:infra`). Без файла у web и core этих переменных нет — предпросмотров нет.
- **Шлюз.** Одна реплика, uid 10009, порт не публикуется, слушает все адреса своего контейнера (`PREVIEW_GATEWAY_HOST` не задан). Браузер агента ходит к шлюзу как к прокси только с адресов `PREVIEW_BROWSER_RELAYS`; в production список по умолчанию пуст — прямой прокси выключен, пока браузеры предпросмотров не переедут на песочные ВМ (M10). Диапазон в списке должен целиком лежать в частном или loopback-блоке: `10.0.0.0/1` не принимается.
- **Кабинет.** Web встраивает предпросмотр в iframe. CSP с `frame-src` предпросмотров отдаёт proxy web на каждой странице по переменным окружения работающего контейнера, а не по переменным сборки: образ web один для всех окружений. Заголовки `next.config.ts` (их Next фиксирует при `next build`) несут ту же политику без предпросмотров — для маршрутов API и файлов. `X-Frame-Options: DENY` кабинета не меняется.

Предпросмотры и браузеры в облаке исполняет раннер песочной ВМ — это M10; до него файл описывает только край и шлюз.

## Первая выкладка

1. **DNS и сеть.** A-записи apex и `www`, без AAAA, пока мосты Docker без IPv6. Группы безопасности — как выше.
2. **Хост** (Ansible, M10): Node 26 в `/usr/bin/node` для preflight и юнитов firewall и Docker 28 и новее, с профилем `llm` — Docker 29 и новее (без userland-proxy Docker 28 закрывает опубликованный порт для контейнеров других мостов, и `core` не достучится до `llm`; preflight это проверяет), в `/etc/docker/daemon.json` — `"userland-proxy": false` и `"live-restore": true`; `vm.overcommit_memory=1`; chrony и `systemctl enable chrony-wait.service`, чтобы `time-sync.target` при загрузке ждал синхронизации часов; в `/etc/systemd/system/docker.service.d/time-sync.conf` — `[Unit]`, `Wants=time-sync.target` и `After=time-sync.target`: контейнеры поднимает сам dockerd (`restart: unless-stopped`), и без этого PostgreSQL, от часов которого считаются сроки аренды, и `core` с восстановлением ходов стартуют до синхронизации (после перезагрузки `systemctl show docker -p After` называет `time-sync.target`). Логи контейнеров идут в journald хоста и переживают пересоздание контейнера (до M9 это единственный след инцидента): в `/etc/systemd/journald.conf.d/raditi.conf` — `[Journal]`, затем `Storage=persistent`, `SystemMaxUse=10G`, `MaxRetentionSec=90day` и `ForwardToSyslog=no`, после чего `systemctl restart systemd-journald` (в журнале запросов — адреса клиентов, это персональные данные, поэтому срок ограничен: 90 дней; без заголовка секции journald пропускает ключи и хранит журнал без срока, а без `ForwardToSyslog=no` rsyslog Ubuntu копирует журнал запросов в `/var/log/syslog`, вне лимита 10 ГБ); в `/etc/systemd/system/docker.service.d/journal.conf` — `[Service]` и `LogRateLimitIntervalSec=0`, иначе под нагрузкой journald отбрасывает строки журнала запросов. Лимит 10 ГБ общий для всех контейнеров, поэтому поток запросов может вытеснить следы инцидента раньше 90 дней; Traefik принимает не больше 32 КиБ заголовков на запрос, до M9 риск принят (spec §20). Читать — `journalctl CONTAINER_NAME=raditi-app-traefik-1` или `docker compose logs`. Каталог `/opt/raditi/app` — этот каталог репозитория на коммите, из которого собраны образы, и `.env` по образцу `env.example` (root:docker, 0640) с `APP_REVISION=<полный sha этого коммита>`: без него первая обычная выкладка запишет в `releases.log` пустую ревизию, и ни шаг bootstrap PostgreSQL, ни откат на первый релиз не узнают, к какой ревизии вернуться. Рядом, вне синхронизируемого каталога, — пустой `/opt/raditi/releases.log` для записей об откате (`install -m 0640 -g docker /dev/null /opt/raditi/releases.log`, раздел «Обычная выкладка»).
3. **Тома:** `docker volume create raditi-app-acme`, то же для `raditi-app-pgdata` и `raditi-app-redis`. `docker compose down -v` их не удаляет.
4. **Staging Let's Encrypt.** В `.env`: `ACME_CA_SERVER=https://acme-staging-v02.api.letsencrypt.org/directory`, `ACME_STORAGE_FILE=acme-staging.json`. Затем `./preflight.sh` и `docker compose up -d --wait traefik`.
5. **Проверка снаружи**, не с ВМ:
   - `curl -i http://raditi.ru/.well-known/acme-challenge/probe` → 404 от Traefik: порт 80 доступен из интернета;
   - `openssl s_client -connect raditi.ru:443 -servername raditi.ru` → издатель staging.

   Если первый заказ не удался, Traefik не повторит его до перезапуска: исправить причину и выполнить `docker compose restart traefik`. Лимит Let's Encrypt — 5 неудачных проверок в час на имя.
6. **Боевой Let's Encrypt.** Вернуть боевые `ACME_*` и выполнить `docker compose up -d --wait traefik`: флаги сменились, контейнер пересоздаётся.
7. **Стек:** `docker compose up -d --wait postgres` → `docker compose exec -T postgres sh -s < postgres/init-roles.sh` → `docker compose run --rm migrate` → `docker compose run --rm seed` → `docker compose up -d --wait`. Bootstrap на пустом томе выполняется и через `initdb`; повторный запуск безопасен. Дамп перед первой миграцией не нужен: база ещё пуста. Все шаги работают с одним владельцем `raditi`; дополнительного отзыва прав после миграции нет.
8. **После выкладки.**
   - CAA: `0 issue "letsencrypt.org"`. Для MVP ограничиваем центр сертификации без привязки к одному ACME-аккаунту или способу проверки. Это обычная запись из [документации Let's Encrypt](https://letsencrypt.org/docs/caa/); `accounturi` и `validationmethods` — дополнительные ограничения, которые здесь не требуются.
   - Включить `.github/workflows/edge-cert.yml`: переменная репозитория `EDGE_CERT_HOST=raditi.ru`.
   - `systemctl enable raditi-app.service` (файл — `systemd/raditi-app.service`).

## Обычная выкладка

При включённом профиле `llm` во всех командах ниже, где перечислены `web core`, добавляется `llm`: загрузка, пересоздание, остановка перед восстановлением БД и откат. `core` и `llm` — разные образы (`CORE_IMAGE`, `LLM_IMAGE`), но обновляются вместе: они делят схему базы и управляющий порт шлюза. Так же — `preview` с наложением предпросмотров (`PREVIEW_GATEWAY_IMAGE`), он читает ту же базу. Для релиза с изменением helper или его systemd-файлов сначала обновить файлы приложения, повторить установку системного helper и units из раздела «Профиль llm», затем выполнять preflight. Изменение только сетевых адресов требует `systemctl reload raditi-llm-firewall.service`. Откат не меняет секреты подписок, AppRole и сетевые адреса.

0. **Запись для отката** — одна на выкладку, до первой правки `.env`: `{ date -Is; grep -E '^(APP_REVISION|WEB_IMAGE|CORE_IMAGE|LLM_IMAGE|PREVIEW_GATEWAY_IMAGE|MIGRATE_IMAGE)=' /opt/raditi/app/.env; } >> /opt/raditi/releases.log`. Так в журнале остаются ревизия и digest релиза, который работает сейчас: шаги 1 и 2 их перезапишут, а прежние контейнеры `up` удалит.
1. **Файлы.** Привести `/opt/raditi/app` (всё, кроме `.env`) к коммиту, из которого собраны образы: `docker-compose.yml`, маршруты Traefik, `preflight.sh` и `postgres/init-roles.sh` должны быть той же ревизии. Новые переменные из `env.example` дописать в `.env`. Коммит записать в `.env` рядом с digest: `APP_REVISION=<sha>`.
2. **Bootstrap PostgreSQL.** Если релиз менял `postgres/init-roles.sh` (`git diff --quiet <прежний APP_REVISION> <новый> -- infra/app/postgres/init-roles.sh` в клоне репозитория завершается не нулём), запуск обязателен: отрендерить актуальные секреты, затем `docker compose exec -T postgres sh -s < postgres/init-roles.sh`. При первом переходе на единого пользователя сначала остановить сервисы со старыми логинами и поменять все `DATABASE_URL`, как описано выше. К уже созданной базе скрипт сам не применяется: `initdb` запускает его только на пустом томе. Миграция B6 проверяет, что старые `subscription_accounts` и `token_usage` пусты; при отказе нужна отдельная миграция данных, очищать таблицы ради продолжения нельзя.
3. **Образы.** Новые digest `WEB_IMAGE`, `CORE_IMAGE`, `MIGRATE_IMAGE` (а с профилем `llm` и наложением предпросмотров — `LLM_IMAGE` и `PREVIEW_GATEWAY_IMAGE`) в `.env`, затем `./preflight.sh` (в том числе проверяет, что все образы — по digest), `df -h /var/lib/docker` (свободно не меньше 15 ГБ: каждый релиз приносит 1–2,5 ГБ новых слоёв) и `docker compose pull web core migrate` (с профилем `llm` — и `llm`, с наложением предпросмотров — и `preview`).
4. **Дамп базы** — `./dump-db.sh`. Отката миграций у Prisma нет: данные, которые испортила миграция, вернёт только этот дамп. Скрипт снимает `pg_dump -Fc` суперпользователем через сокет, проверяет, что в архиве есть данные `_prisma_migrations`, и дописывает путь к дампу в запись шага 0 (`dump=…`). Дампы лежат в `/opt/raditi/backups` (каталог 0700, файлы 0600, владелец root: в них персональные данные и сессии), хранятся пять последних и не старше 30 дней, как бэкапы платформы (spec §14); лишние скрипт удаляет при каждом запуске. Завершился не нулём — не мигрировать. Ночные бэкапы вне ВМ (M10) он не заменяет: диск у дампа и базы один.
5. `docker compose run --rm migrate`. Миграции только расширяют схему: сужение — в следующем релизе, потому что старые web и `core` работают на новой схеме. Исключение — релиз с миграцией `20261011090000_switch_to_opencode` (переключение на OpenCode, 11.10.2026): её применяют при остановленных `core`, `llm` и раннерах, а перед ней выводят аккаунты прежних провайдеров; что проверить до неё, как выйти из её остановок и что включить после — [отчёт G8](../../docs/plan/48-removal.md), «Миграция», «До миграции: что проверить и как подготовить базу», «Что включает оператор». На первой выкладке отступать не от чего: база пуста.
6. `docker compose up -d --wait --no-deps web core`. Пока web пересоздаётся, Traefik несколько секунд отвечает 502, потоки задач переподключаются. Это принято. Если релиз менял флаги Traefik (`command:`) или сервисы `traefik`, `postgres`, `redis` — `docker compose up -d --wait` без `--no-deps`. Файлы `traefik/dynamic` Traefik перечитывает сам.
7. `docker compose run --rm seed` — только если сиды менялись. Сбой сида не мешает работе web и `core`.
8. **Старые образы.** Удалить локальные образы `<реестр>/raditi/{web,core,llm,preview,migrate}`, чей digest нет ни в текущем `.env`, ни в последней записи `releases.log` (к ней откатываются): список — `docker image ls --digests --format '{{.Repository}}@{{.Digest}} {{.ID}}'`, удаление — `docker image rm <ID>`. `docker image prune` не подходит: у образов, скачанных по digest, нет тега, и он удалит и образы для отката.

Выкладка через GitHub Actions (M10) делает те же шаги и пишет ту же запись в `releases.log`.

**Откат.** Последняя запись в `/opt/raditi/releases.log` — релиз, который работал до текущей выкладки. Привести `/opt/raditi/app` к её `APP_REVISION` и заменить в `.env` строки `APP_REVISION`, `WEB_IMAGE`, `CORE_IMAGE`, `LLM_IMAGE`, `PREVIEW_GATEWAY_IMAGE` и `MIGRATE_IMAGE` из записи, и только их. Остальное, например `RUNNER_TOKENS`, не трогать: откат не должен отменять ротацию или отзыв токенов. Затем `./preflight.sh` и `docker compose up -d --wait --no-deps web core` (без `--no-deps`, если менялись Traefik или сервисы данных). Перед возвратом файлов релиза, в котором ещё нет llm, остановить и удалить контейнер llm, выключить профиль в сохраняемом `.env` и выполнить `systemctl reload raditi-llm-firewall.service`: действует deny-all. Затем возвращать каталог приложения к прежней ревизии. Установленные `/usr/local/lib/raditi/llm-firewall.mjs`, Node/nftables и оба systemd-файла сохраняются: Docker после перезагрузки проверяет существующий helper, даже когда в старом релизе его нет. При откате между релизами с llm вернуть также соответствующую установленную копию helper и units по порядку установки выше и применить правила до preflight. Схему и переход на единого пользователя не откатываем: старый код совместим с новой схемой. Образы PostgreSQL, Redis и Traefik откат не понижает: новый Redis мог уже переписать AOF или RDB в формате, который старый образ не прочтёт, — их меняют отдельным релизом со своей проверкой.

**`core` и раннеры** — два образа (`CORE_IMAGE` и `RUNNER_IMAGE`, `apps/runner/Dockerfile`) и один релиз: схемы протокола раннера и журнала хода закрытые (`.strict()`, перечисления фаз и причин). Выкладка — сначала `core`, потом `RUNNER_IMAGE` на песочных ВМ. Откат — сначала раннеры, потом `core`, и только когда нет открытых назначений, в журнале которых есть фазы или причины, неизвестные прежнему релизу (например, `vacating` и `awaiting_runner`); иначе дождаться их закрытия. «Старый код совместим с новой схемой» — про схему базы, а не про записи журнала (spec §19, «Выкладка»).

**Миграция испортила данные.** Базу возвращает дамп из той же записи (строка `dump=`). Всё, что записано после дампа, — задачи, платежи, входы — пропадёт, поэтому сначала решить, нельзя ли исправить данные следующей миграцией. Если нельзя — до отката кода:

```sh
docker compose stop web core
docker compose exec -T postgres pg_restore -U postgres -d postgres \
  --clean --if-exists --create --no-acl --exit-on-error < /opt/raditi/backups/<дамп>.dump
```

`--create` пересоздаёт базу целиком: владелец `raditi` приходит из дампа, а таблицы миграции, которых в дампе нет, исчезают. `--no-acl` пропускает старые GRANT/REVOKE и default privileges: дамп, снятый до перехода, может ссылаться на уже удалённых пользователей. Без `--create` флаг `--clean` не удалит таблицу, на которую ссылается новая, и восстановление остановится на полпути. После восстановления повторить `docker compose exec -T postgres sh -s < postgres/init-roles.sh`, затем откат кода, как выше.

**Перезагрузка ВМ.** `/run` — tmpfs. `raditi-secrets.service` рендерит секреты до `docker.service`, и контейнеры поднимает сам dockerd (`restart: unless-stopped`). Пока секретов нет, контейнеры не стартуют. До синхронизации часов их держит drop-in `time-sync.target` у docker.service (раздел «Первая выкладка», п. 2); проверка часов в `preflight.sh` защищает ручной запуск и `raditi-app.service`. Если секреты отрендерились позже, `preflight.sh` не проходит, и `raditi-app.service` повторяет запуск каждые 30 секунд, пока стек не поднимется: `systemctl status raditi-app.service` покажет, какая проверка мешает.

## Токены раннеров

Токен песочной ВМ (`rnr_<id>.<секрет>`) лежит только на своей ВМ: `/etc/raditi/runner-token`, владелец root, права 0400, в раннер монтируется только для чтения. На app-ВМ в `.env` — только его SHA-256, привязанный к частному адресу ВМ: `RUNNER_TOKENS=<id>:<sha256>@<IP>`, до двух хешей на раннер через запятую (spec §15). Токен работает только с этого адреса. Раннеры забирают ходы сами: с токеном можно забрать любой ожидающий ход любого клиента, а к ходам другого раннера он не пускает (spec §15, §18).

**Выпуск.** На песочной ВМ, чтобы токен её не покидал, образом раннера (скрипт `scripts/runner-token.mjs` живёт в `apps/runner`):

```sh
sudo docker run --rm --network none --user 0:0 -v /etc/raditi:/etc/raditi \
  --entrypoint node "$RUNNER_IMAGE" scripts/runner-token.mjs \
  issue sandbox-1 /etc/raditi/runner-token --ip 10.10.1.11
```

Скрипт создаёт файл с правами 0400 и не перезаписывает существующий. В вывод попадает только строка для `RUNNER_TOKENS`, сам токен не печатается. `--ip` — частный адрес этой ВМ (RFC 1918 или IPv6 ULA), имя не принимается. Строку дописать в `RUNNER_TOKENS` в `.env` app-ВМ и выполнить `docker compose up -d --wait --no-deps core`: переменная сменилась, поэтому контейнер пересоздаётся.

Адрес обязателен у каждой записи: ключ хода привязан к адресу своего раннера, и `core` с `TURN_EXECUTOR=runner` не стартует, если у раннера есть хеш без адреса или два хеша с разными адресами. Вне прода правило то же, но адрес может быть любым: для раннера на своей машине токен выпускается без `--ip`, а к напечатанной записи дописывается `@127.0.0.1`.

**Ротация.**
1. На ВМ выпустить новый токен в соседний файл с тем же адресом: `… issue sandbox-1 /etc/raditi/runner-token.next --ip <IP>`.
2. На app-ВМ дописать новую строку рядом со старой и пересоздать `core`, как при выпуске. Оба токена работают.
3. На ВМ: `mv /etc/raditi/runner-token.next /etc/raditi/runner-token` и `docker compose --profile runner restart runner` в каталоге compose ВМ. Раннер начинает новую сессию. Если в этот момент шёл ход, `core` удалит его контейнер, и ход завершится как `lost` без списания. Поэтому ротацию лучше делать, когда ходов нет.
4. Убрать старую строку из `RUNNER_TOKENS` и снова пересоздать `core`.

**Отзыв** (токен скомпрометирован или ВМ выведена). Убрать строку из `RUNNER_TOKENS` и пересоздать `core`: токен сразу перестаёт открывать API раннеров. Затем выпустить новый, как выше.

**Адрес ВМ сменился.** Хеш привязан к адресу. На ВМ выполнить `… hash /etc/raditi/runner-token --ip <новый IP>` — той же командой `docker run`, только `hash` вместо `issue` — и заменить строку в `RUNNER_TOKENS`.

## Образы

Только по digest, значений по умолчанию нет. Docker Hub отвечает 403 для российских IP, поэтому образы берутся из своего реестра (M10). Зеркала сохраняют upstream-digest: `crane copy` или `skopeo copy --all --preserve-digests`, а не `docker pull/tag/push`. Свои образы:

```sh
docker build --platform linux/amd64 -f apps/web/Dockerfile --target runtime -t <реестр>/raditi/web .
docker build --platform linux/amd64 -f apps/core/Dockerfile --target runtime -t <реестр>/raditi/core .
docker build --platform linux/amd64 -f apps/core/Dockerfile --target migrate -t <реестр>/raditi/migrate .
docker build --platform linux/amd64 -f apps/llm/Dockerfile --target runtime -t <реестр>/raditi/llm .
docker build --platform linux/amd64 -f apps/preview/Dockerfile --target runtime -t <реестр>/raditi/preview .
```

`llm` (`LLM_IMAGE`) нужен с профилем `llm`, `preview` (`PREVIEW_GATEWAY_IMAGE`) — с наложением предпросмотров; у каждого свой `Dockerfile` и своё замыкание пакетов (`turbo prune <приложение>`): у `llm`, `preview` и `mcp` нет `git` и `gitleaks`, они только у `core`. Образ раннера для песочных ВМ — `apps/runner/Dockerfile` (`RUNNER_IMAGE` в compose песочной ВМ, [`infra/sandbox`](../sandbox/README.md)), образ `mcp` — `apps/mcp/Dockerfile`: в compose app-ВМ его пока нет (P6). Образы `llm`, `mcp`, `preview` и раннера собирает и проверяет `pnpm verify:images`: своё приложение стартует и отказывает в пустой конфигурации своими словами, uid 10001, нет `git`, `gitleaks` и `.env`, в образе раннера нет пакетов `db` и `service-runtime`, Prisma, `pg`, S3 SDK и BullMQ и есть `scripts/runner-token.mjs`; `Dockerfile` проверяет `infra/app/images.test.mjs`. У каждого `Dockerfile` есть цель `runtime`, а цель `migrate` — только у `core`.

ВМ — x86_64: без `--platform linux/amd64` на Mac получится образ arm64, который на ВМ не запустится. Выпускные образы будет собирать GitHub Actions (M10). Если хост сборки не достаёт до Docker Hub или ghcr.io — передать зеркало с тем же digest: `--build-arg NODE_IMAGE=<реестр>/mirror/node:26.10.0-trixie-slim@<digest из ARG в Dockerfile>`, для `core` — ещё и `GITLEAKS_IMAGE`.

## Срок сертификата

До алертов M9 срок проверяет ежедневный workflow `edge-cert.yml` (apex и `www`, запас 21 день). Let's Encrypt писем больше не шлёт, а продление может молча сломаться — из-за смены группы безопасности, AAAA-записи или защиты от DDoS, которая режет зарубежные точки проверки. Запасной путь — DNS-01 через Yandex Cloud DNS (провайдер lego `yandexcloud`): это правка compose и секретов, см. следующий раздел.

## Утрата `acme.json` и смена способа проверки

CAA `0 issue "letsencrypt.org"` допускает новый ACME-аккаунт и смену способа проверки без изменения DNS. Если по прежнему runbook уже выставлены `accounturi` или `validationmethods`, один раз заменить такую запись на обычную и дождаться её TTL. При `sniStrict` без сертификата сайт недоступен по HTTPS.

**Утрачен `acme.json`** (вместе с ним — ключ аккаунта и текущий сертификат):
1. `docker compose restart traefik`: Traefik заводит новый аккаунт и выпускает сертификаты.
2. Проверить HTTPS для apex и `www`, издателя и срок сертификатов. При отказе проверить журнал Traefik и причину ACME-ошибки перед повторной попыткой.

**Переход на DNS-01** (HTTP-01 сломан: группа безопасности, AAAA, защита от DDoS). Правка `docker-compose.yml` обычным релизом:

- флаг `--certificatesresolvers.le.acme.httpchallenge.entrypoint=web` заменить на `--certificatesresolvers.le.acme.dnschallenge.provider=yandexcloud`, а не добавить второй рядом: из двух проверок одного резолвера lego выбирает HTTP-01, и продление снова падает. Резолвер с двумя проверками не пропустит `pnpm test:infra`;
- каталог секретов `${SECRETS_DIR}/traefik`, который vault-agent рендерит из `kv/platform/app/traefik`, смонтированный только в Traefik;
- учётные данные `YANDEX_CLOUD_IAM_TOKEN` и `YANDEX_CLOUD_FOLDER_ID` — через переменные lego `*_FILE`, не значениями в `environment:`;
- `traefik` — в `secretDirs` в `compose.test.mjs`.

## Проверки

- `pnpm test:infra` — compose, маршруты, Dockerfile, preflight, правила llm, `dump-db.sh` и контракт CI (`ci.test.mjs`: job и шаги workflow, закреплённые образы стендов) (в `pnpm gates`; resolved Compose требует установленного CLI).
- `pnpm verify:llm-firewall` — только локальный Docker endpoint; удалённый context/`DOCKER_HOST` отклоняется до операций со стендом, выбранный endpoint закрепляется на весь прогон и уборку. Реальные пакеты в одноразовом контейнере с отдельными сетевыми пространствами; сетевые правила хоста не меняет.
- `docker build -f apps/llm/Dockerfile --target runtime -t raditi-p3verify-llm:b14 .`, затем `pnpm verify:llm-app` — production-образ `llm` из app Compose с собственной PostgreSQL, HTTPS OpenBao и mTLS-прокси. Аккаунты подписок не нужны; ограничения и итог — [B14](../../docs/plan/21-p3-app-llm.md). На Linux стенд делает управляющий запрос `core` → `llm` через опубликованный порт и требует Docker 29: более старый движок отклоняется до создания ресурсов, с названием причины. В CI (`llm-app.yml`) движок раннера заменяется на версию из `APP_DOCKER_VERSION`: образ раннера GitHub несёт Docker 28.
- `pnpm verify:images [-- --no-build] [--keep] [--only llm,runner]` — образы `llm`, `mcp`, `preview` и раннера из их `Dockerfile` (цель `runtime`), проверка снаружи: `node dist/main.js` своего приложения от uid 10001, старт без настроек кончается отказом «Invalid <приложение> configuration» под логгером `[<приложение>]`, нет `git`, `gitleaks`, `.env` и запрещённых приложению пакетов; у раннера — нет Prisma, `pg`, S3 SDK и BullMQ, есть `scripts/runner-token.mjs` этого runbook. 6–8 минут со сборкой, образы потом удаляются; в CI — `images.yml`.
- `pnpm verify:edge` — сквозная проверка на Pebble вместо Let's Encrypt, в том числе дамп и восстановление базы и пределы тела запросов на краю и в web (проверки 24–26); результаты — `docs/plan/04-edge-verification.md`.
