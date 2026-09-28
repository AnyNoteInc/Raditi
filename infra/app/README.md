# app-ВМ: выкладка и эксплуатация

Compose app-ВМ (spec §19): Traefik — единственный публичный вход (80/443, сертификаты Let's Encrypt выпускает сам), web, `core`, PostgreSQL, Redis. Миграции и сиды — отдельные шаги (профиль `ops`). LiteLLM (P3) и роль `mcp` (P6) сюда пока не входят.

| Файл | Что это |
| --- | --- |
| `docker-compose.yml` | Сервисы, сети, тома. Статика Traefik — флагами в `command:` |
| `traefik/dynamic/raditi.yml` | Маршруты: apex → web, `www` → редирект на apex, `/api/metrics` закрыт |
| `env.example` | Образец `/opt/raditi/app/.env`: только несекретные значения и образы по digest |
| `secrets.example/` | Раскладка секретов `/run/raditi/<сервис>/` — какие файлы и что в них |
| `postgres/init-roles.sh` | Роли PostgreSQL: владелец схемы `raditi`, `raditi_web` и `raditi_core` только с DML |
| `preflight.sh` | Проверки хоста перед стартом, `ExecStartPre` юнита |
| `systemd/raditi-app.service` | Запуск стека, как только проходит `preflight.sh`; повтор каждые 30 секунд |
| `*.test.mjs`, `verify-edge.mjs`, `verify/` | Проверки: `pnpm test:infra` и `pnpm verify:edge` |

## Что открыто

- **Всему миру** — только 80 и 443 Traefik. 80 — редирект на HTTPS и проверка HTTP-01: Let's Encrypt проверяет домен из нескольких стран, поэтому 80 открыт всем.
- **API раннеров** (:8083) — голый HTTP, опубликован только на `APP_PRIVATE_IP`. Группа безопасности открывает его только подсети песочных ВМ. Хеш токена ВМ привязан к её частному адресу (`RUNNER_TOKENS=id:sha256@ip`).
- **Не публикуются:** `core` :8081, PostgreSQL, Redis, Traefik :9000 (ping и метрики).

Опубликованные порты Docker обходят `ufw`, поэтому граница — группы безопасности облака: 80 и 443 — всем, 8083 — подсеть песочных ВМ, 22 — бастион.

## Секреты

В `docker-compose.yml`, `.env` сервера и git секретов нет. Каждый сервис читает свои файлы из `/run/raditi/<сервис>/` — это tmpfs хоста. Их рендерит `raditi-secrets.service` (vault-agent, M10) из `kv/platform/app/<сервис>` до старта `docker.service`. Каталог монтируется только в свой контейнер. Если каталога нет, контейнер не стартует: пустой каталог Docker не создаёт.

| Каталог | uid | Файлы |
| --- | --- | --- |
| `web/` | 10001 | `app.env`: `DATABASE_URL` (`raditi_web`), `REDIS_URL` (пользователь `web`), `BETTER_AUTH_SECRET`, ключи SmartCaptcha, ключи S3 сервисного аккаунта web, AppRole web, `METRICS_TOKEN` |
| `core/` | 10002 | `app.env`: `DATABASE_URL` (`raditi_core`), `REDIS_URL` (пользователь `core`), ключи S3 сервисного аккаунта core, AppRole core, `METRICS_TOKEN`, `SENDSAY_API_KEY` |
| `migrate/` | 10004 | `app.env`: `DATABASE_URL` владельца схемы `raditi` (им же пользуется `seed`) |
| `postgres/` | 70 | `superuser-password`, `owner-password`, `web-password`, `core-password` |
| `redis/` | 10003 | `users.acl` (SHA-256 паролей `web`, `core`, `health`; `user default off`), `health-password` |

- Каталог — 0700, файлы — 0400, владелец — uid своего сервиса.
- Пароль роли PostgreSQL и `DATABASE_URL` сервиса, пароль пользователя Redis и `REDIS_URL` — одно значение из одной записи Vault.
- Пароли ролей PostgreSQL и пользователей Redis — только из алфавита `[A-Za-z0-9_-]` (`openssl rand -hex 24` или base64url). Шаблон подставляет их в `DATABASE_URL` и `REDIS_URL` без кодирования, а `@ / : ? # %` ломают адрес, хотя файл `*-password` получит пароль целиком.
- `app.env` читает `node --env-file`: без кавычек всё после `#` отбрасывается. Поэтому шаблон пишет каждое значение в двойных кавычках (`KEY="…"`); `"`, `\` и перевод строки в значении недопустимы.
- Хеш для `users.acl`: `printf %s "$пароль" | sha256sum`, в файле — `#<hex>`.
- `superuser-password` нужен только первому `initdb`: `10-roles.sh` снимает пароль суперпользователя `postgres`, и тот входит только через сокет внутри контейнера. Ротация его не касается, но файл должен быть: образ читает его при каждом старте.
- Исключение из правила 2: ключи сертификата и ACME-аккаунта лежат в `acme.json` на томе `acme` (0600, только Traefik). В Vault и бэкапы они не входят. При утрате сертификат перевыпускается — сначала правка CAA (раздел «Утрата `acme.json` и смена способа проверки»); лимит Let's Encrypt — 5 одинаковых сертификатов в неделю.

После ротации паролей ролей `raditi`, `raditi_web` и `raditi_core` — в `/opt/raditi/app` выполнить `docker compose exec -T postgres sh -s < postgres/init-roles.sh`, затем перезапуск web и `core`. Скрипт берётся с хоста, а не из контейнера: смонтированный в него одиночный файл после обновления каталога остаётся прежней версией, пока контейнер postgres не пересоздан (git и rsync заменяют файл новым). Скрипт повторяемый.

После ротации паролей Redis, когда vault-agent отрендерил новые `users.acl`, `health-password` и `REDIS_URL` web и `core`, — `docker compose restart redis`, затем сразу `docker compose restart web core`. Redis читает `--aclfile` только при старте, а `ACL LOAD` выполнить некому: `default` выключен, у `web`, `core` и `health` нет `@admin`. Данные сохраняет AOF. До перезапуска web и `core` входят со старым паролем и получают `WRONGPASS`, а очереди стоят, поэтому паузу между шагами держать короткой. Без отказов входа: на время ротации в `users.acl` у пользователя два хеша (`#<старый> #<новый>`) — перезапустить Redis, затем web и `core` с новым `REDIS_URL`, затем убрать старый хеш и снова перезапустить Redis.

## Первая выкладка

1. **DNS и сеть.** A-записи apex и `www`, без AAAA, пока мосты Docker без IPv6. Группы безопасности — как выше.
2. **Хост** (Ansible, M10): Docker 28 и новее, в `/etc/docker/daemon.json` — `"userland-proxy": false` и `"live-restore": true`; `vm.overcommit_memory=1`; chrony и `systemctl enable chrony-wait.service`, чтобы `time-sync.target` при загрузке ждал синхронизации часов. Логи контейнеров идут в journald хоста и переживают пересоздание контейнера (до M9 это единственный след инцидента): в `/etc/systemd/journald.conf.d/raditi.conf` — `Storage=persistent`, `SystemMaxUse=10G`, `MaxRetentionSec=90day` (в журнале запросов — адреса клиентов, это персональные данные, поэтому срок ограничен: 90 дней); в `/etc/systemd/system/docker.service.d/journal.conf` — `[Service]` и `LogRateLimitIntervalSec=0`, иначе под нагрузкой journald отбрасывает строки журнала запросов. Читать — `journalctl CONTAINER_NAME=raditi-app-traefik-1` или `docker compose logs`. Каталог `/opt/raditi/app` — этот каталог репозитория и `.env` по образцу `env.example` (root:docker, 0640). Рядом, вне синхронизируемого каталога, — пустой `/opt/raditi/releases.log` для записей об откате (`install -m 0640 -g docker /dev/null /opt/raditi/releases.log`, раздел «Обычная выкладка»).
3. **Тома:** `docker volume create raditi-app-acme`, то же для `raditi-app-pgdata` и `raditi-app-redis`. `docker compose down -v` их не удаляет.
4. **Staging Let's Encrypt.** В `.env`: `ACME_CA_SERVER=https://acme-staging-v02.api.letsencrypt.org/directory`, `ACME_STORAGE_FILE=acme-staging.json`. Затем `./preflight.sh` и `docker compose up -d --wait traefik`.
5. **Проверка снаружи**, не с ВМ:
   - `curl -i http://raditi.ru/.well-known/acme-challenge/probe` → 404 от Traefik: порт 80 доступен из интернета;
   - `openssl s_client -connect raditi.ru:443 -servername raditi.ru` → издатель staging.

   Если первый заказ не удался, Traefik не повторит его до перезапуска: исправить причину и выполнить `docker compose restart traefik`. Лимит Let's Encrypt — 5 неудачных проверок в час на имя.
6. **Боевой Let's Encrypt.** Вернуть боевые `ACME_*` и выполнить `docker compose up -d --wait traefik`: флаги сменились, контейнер пересоздаётся.
7. **Стек:** `docker compose run --rm migrate` → `docker compose run --rm seed` → `docker compose up -d --wait`.
8. **После выкладки.**
   - CAA: `0 issue "letsencrypt.org; accounturi=<из acme.json>; validationmethods=http-01"`. Запись разрешает выпуск только текущему ACME-аккаунту и только через HTTP-01: при утрате `acme.json` и при переходе на DNS-01 её сначала меняют (раздел «Утрата `acme.json` и смена способа проверки»).
   - Включить `.github/workflows/edge-cert.yml`: переменная репозитория `EDGE_CERT_HOST=raditi.ru`.
   - `systemctl enable raditi-app.service` (файл — `systemd/raditi-app.service`).

## Обычная выкладка

0. **Запись для отката** — одна на выкладку, до первой правки `.env`: `{ date -Is; grep -E '^(APP_REVISION|[A-Z_]+_IMAGE)=' /opt/raditi/app/.env; } >> /opt/raditi/releases.log`. Так в журнале остаются ревизия и digest релиза, который работает сейчас: шаги 1 и 2 их перезапишут, а прежние контейнеры `up` удалит.
1. **Файлы.** Привести `/opt/raditi/app` (всё, кроме `.env`) к коммиту, из которого собраны образы: `docker-compose.yml`, маршруты Traefik, `preflight.sh` и `postgres/init-roles.sh` должны быть той же ревизии. Новые переменные из `env.example` дописать в `.env`. Коммит записать в `.env` рядом с digest: `APP_REVISION=<sha>`.
2. **Роли PostgreSQL.** Если релиз менял `postgres/init-roles.sh` (`git diff --quiet <прежний APP_REVISION> <новый> -- infra/app/postgres/init-roles.sh` в клоне репозитория завершается не нулём) — `docker compose exec -T postgres sh -s < postgres/init-roles.sh`. К уже созданной базе скрипт сам не применяется: `initdb` запускает его только на пустом томе.
3. **Образы.** Новые digest `WEB_IMAGE`, `ORCHESTRATOR_IMAGE`, `MIGRATE_IMAGE` в `.env`, затем `./preflight.sh` (в том числе проверяет, что все образы — по digest) и `docker compose pull web core migrate`.
4. `docker compose run --rm migrate`. Миграции только расширяют схему: сужение — в следующем релизе, потому что старые web и `core` работают на новой схеме, а отката схемы у Prisma нет.
5. `docker compose up -d --wait --no-deps web core`. Пока web пересоздаётся, Traefik несколько секунд отвечает 502, потоки задач переподключаются. Это принято. Если релиз менял флаги Traefik (`command:`) или сервисы `traefik`, `postgres`, `redis` — `docker compose up -d --wait` без `--no-deps`. Файлы `traefik/dynamic` Traefik перечитывает сам.
6. `docker compose run --rm seed` — только если сиды менялись. Сбой сида не мешает работе web и `core`.

Выкладка через GitHub Actions (M10) делает те же шаги и пишет ту же запись в `releases.log`.

**Откат.** Последняя запись в `/opt/raditi/releases.log` — релиз, который работал до текущей выкладки. Привести `/opt/raditi/app` к её `APP_REVISION` и заменить в `.env` только строки из записи — `APP_REVISION` и `*_IMAGE`. Остальное, например `RUNNER_TOKENS`, не трогать: откат не должен отменять ротацию или отзыв токенов. Затем `./preflight.sh` и `docker compose up -d --wait --no-deps web core` (без `--no-deps`, если менялись Traefik или сервисы данных). Схему и роли не откатываем: старый код совместим с новой схемой.

**Перезагрузка ВМ.** `/run` — tmpfs. `raditi-secrets.service` рендерит секреты до `docker.service`, и контейнеры поднимает сам dockerd (`restart: unless-stopped`). Пока секретов нет, контейнеры не стартуют. Если секреты отрендерились позже или часы ещё не синхронизированы, `preflight.sh` не проходит, и `raditi-app.service` повторяет запуск каждые 30 секунд, пока стек не поднимется: `systemctl status raditi-app.service` покажет, какая проверка мешает.

## Токены раннеров

Токен песочной ВМ (`rnr_<id>.<секрет>`) лежит только на своей ВМ: `/etc/raditi/runner-token`, владелец root, права 0400, в раннер монтируется только для чтения. На app-ВМ в `.env` — только его SHA-256, привязанный к частному адресу ВМ: `RUNNER_TOKENS=<id>:<sha256>@<IP>`, до двух хешей на раннер через запятую (spec §15). Токен открывает только ходы своего раннера и только с этого адреса.

**Выпуск.** На песочной ВМ, чтобы токен её не покидал, образом раннера:

```sh
sudo docker run --rm --network none --user 0:0 -v /etc/raditi:/etc/raditi \
  --entrypoint node "$RUNNER_IMAGE" scripts/runner-token.mjs \
  issue sandbox-1 /etc/raditi/runner-token --ip 10.10.1.11
```

Скрипт создаёт файл с правами 0400 и не перезаписывает существующий. В вывод попадает только строка для `RUNNER_TOKENS`, сам токен не печатается. `--ip` — частный адрес этой ВМ (RFC 1918 или IPv6 ULA), имя не принимается. Строку дописать в `RUNNER_TOKENS` в `.env` app-ВМ и выполнить `docker compose up -d --wait --no-deps core`: переменная сменилась, поэтому контейнер пересоздаётся.

**Ротация.**
1. На ВМ выпустить новый токен в соседний файл: `… issue sandbox-1 /etc/raditi/runner-token.next --ip <IP>`.
2. На app-ВМ дописать новую строку рядом со старой и пересоздать `core`, как при выпуске. Оба токена работают.
3. На ВМ: `mv /etc/raditi/runner-token.next /etc/raditi/runner-token` и `docker compose --profile runner restart runner` в каталоге compose ВМ. Раннер начинает новую сессию. Если в этот момент шёл ход, `core` удалит его контейнер, и ход завершится как `lost` без списания. Поэтому ротацию лучше делать, когда ходов нет.
4. Убрать старую строку из `RUNNER_TOKENS` и снова пересоздать `core`.

**Отзыв** (токен скомпрометирован или ВМ выведена). Убрать строку из `RUNNER_TOKENS` и пересоздать `core`: токен сразу перестаёт открывать API раннеров. Затем выпустить новый, как выше.

**Адрес ВМ сменился.** Хеш привязан к адресу. На ВМ выполнить `… hash /etc/raditi/runner-token --ip <новый IP>` — той же командой `docker run`, только `hash` вместо `issue` — и заменить строку в `RUNNER_TOKENS`.

## Образы

Только по digest, значений по умолчанию нет. Docker Hub отвечает 403 для российских IP, поэтому образы берутся из своего реестра (M10). Зеркала сохраняют upstream-digest: `crane copy` или `skopeo copy --all --preserve-digests`, а не `docker pull/tag/push`. Свои образы:

```sh
docker build --platform linux/amd64 -f apps/web/Dockerfile --target runtime -t <реестр>/raditi/web .
docker build --platform linux/amd64 -f apps/orchestrator/Dockerfile --target runtime -t <реестр>/raditi/orchestrator .
docker build --platform linux/amd64 -f apps/orchestrator/Dockerfile --target migrate -t <реестр>/raditi/migrate .
```

ВМ — x86_64: без `--platform linux/amd64` на Mac получится образ arm64, который на ВМ не запустится. Выпускные образы будет собирать GitHub Actions (M10). Если хост сборки не достаёт до Docker Hub или ghcr.io — передать зеркало с тем же digest: `--build-arg NODE_IMAGE=<реестр>/mirror/node:26.10.0-trixie-slim@<digest из ARG в Dockerfile>`, для orchestrator — ещё и `GITLEAKS_IMAGE`.

## Срок сертификата

До алертов M9 срок проверяет ежедневный workflow `edge-cert.yml` (apex и `www`, запас 21 день). Let's Encrypt писем больше не шлёт, а продление может молча сломаться — из-за смены группы безопасности, AAAA-записи или защиты от DDoS, которая режет зарубежные точки проверки. Запасной путь — DNS-01 через Yandex Cloud DNS (провайдер lego `yandexcloud`): это правка CAA и compose, см. следующий раздел.

## Утрата `acme.json` и смена способа проверки

CAA привязывает выпуск к ACME-аккаунту из `acme.json` и к HTTP-01. Пока запись не поправлена, Let's Encrypt откажет новому аккаунту и любой другой проверке, а при `sniStrict` без сертификата сайт недоступен по HTTPS. Поэтому любой из сценариев начинается с CAA.

**Утрачен `acme.json`** (вместе с ним — ключ аккаунта и текущий сертификат):
1. Заменить CAA на `0 issue "letsencrypt.org; validationmethods=http-01"` — без `accounturi` — и дождаться TTL записи.
2. `docker compose restart traefik`: Traefik заводит новый аккаунт и выпускает сертификаты.
3. Когда сертификаты выпущены, вернуть в CAA `accounturi` нового аккаунта из `acme.json`. Заранее его не узнать: адрес аккаунта появляется только после регистрации.

**Переход на DNS-01** (HTTP-01 сломан: группа безопасности, AAAA, защита от DDoS):
1. Сначала CAA: `validationmethods=http-01,dns-01` (`accounturi` оставить, если `acme.json` цел) и дождаться TTL.
2. Затем правка `docker-compose.yml` обычным релизом:
   - флаг `--certificatesresolvers.le.acme.dnschallenge.provider=yandexcloud`;
   - каталог секретов `${SECRETS_DIR}/traefik`, который vault-agent рендерит из `kv/platform/app/traefik`, смонтированный только в Traefik;
   - учётные данные `YANDEX_CLOUD_IAM_TOKEN` и `YANDEX_CLOUD_FOLDER_ID` — через переменные lego `*_FILE`, не значениями в `environment:`;
   - `traefik` — в `secretDirs` в `compose.test.mjs`.

## Проверки

- `pnpm test:infra` — compose, маршруты и Dockerfile без Docker-демона (в `pnpm gates`).
- `pnpm verify:edge` — сквозная проверка на Pebble вместо Let's Encrypt; результаты — `docs/plan/04-edge-verification.md`.
