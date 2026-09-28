# Край app-ВМ: Traefik, Let's Encrypt и выкладка

Проверено 27.09.2026 на macOS, Node 26.10.0, pnpm 12.6, Docker Desktop 29.6.2 (Compose 5.3.1). Это проверка compose app-ВМ (`infra/app`), образов `web` и `orchestrator` и края: Traefik выпускает настоящие сертификаты у Pebble вместо Let's Encrypt и отдаёт настоящий web. Обязательный прогон на Linux с `userland-proxy: false` (`--real-address`) делает workflow `edge.yml`; он прошёл 28.09.2026 (раздел «Прогон на Linux»).

## Что сделано

- **Образы.** `apps/web/Dockerfile` (standalone-сервер Next.js) и `apps/orchestrator/Dockerfile` (один образ на роли `core`, `mcp` и `runner`, плюс стадия `migrate` с Prisma CLI). База — `node:26.10.0-trixie-slim` по digest, pnpm 12.6.0 закреплён версией, turbo — из lockfile (`pnpm exec turbo prune`). В образе orchestrator — git 2.47.3 (сборка падает, если git старше 2.47) и gitleaks 8.30.1 из его образа по digest. Процесс не владеет своим кодом: файлы принадлежат root, uid задаёт compose.
- **Compose app-ВМ** (`infra/app/docker-compose.yml`): Traefik 3.7.13, web, core, PostgreSQL 17, Redis 8; миграции и сиды — профиль `ops`, явные шаги. Статика Traefik — только флаги, маршруты — file provider (`traefik/dynamic/raditi.yml`), без сокета Docker и панели. Сервисы под разными uid, с `read_only`, `cap_drop: ALL`, `no-new-privileges` и лимитами; секреты — файлы `/run/raditi/<сервис>/`, смонтированные только в свой контейнер (`create_host_path: false`). web и core не делят ни одной сети.
- **Роли PostgreSQL и ACL Redis.** `postgres/init-roles.sh`: схема принадлежит `raditi`, web и core работают как `raditi_web` и `raditi_core` только с DML. Redis — `user default off`, у `web` и `core` нет `@admin`, `FLUSHALL`, `FLUSHDB`, `KEYS`, `SWAPDB`; у `health` — только `PING`.
- **Эксплуатация.** `preflight.sh` (Docker 28+, `userland-proxy: false`, `live-restore`, `APP_PRIVATE_IP` — адрес ВМ, каталоги секретов на tmpfs с нужными владельцами и правами, нет секретов в `.env`, внешние тома, `vm.overcommit_memory`, NTP, нет AAAA), юнит `systemd/raditi-app.service`, runbook `README.md`, раскладка секретов `secrets.example/`.
- **Проверки без демона** (`pnpm test:infra`, входит в `pnpm gates` и CI): `compose.test.mjs` сверяет конфигурацию, которую собирает `docker compose config`, — порты, uid, сети, секреты, флаги Traefik, образы по digest; `traefik.test.mjs` — маршруты; `images.test.mjs` — Dockerfile и совпадение digest в `env.example` и `verify-edge.mjs`.
- **Сквозная проверка** `pnpm verify:edge` (`infra/app/verify-edge.mjs`, `verify/`): прод-compose плюс Pebble, pebble-challtestsrv и эхо-сервис; случайные секреты во временном каталоге; всё созданное удаляется.
- **CI.** `edge.yml` — сборка трёх образов и `node infra/app/verify-edge.mjs --no-build --real-address` на Linux с `userland-proxy: false` (только Node из `.nvmrc`, без установки зависимостей монорепозитория), по изменениям края — самого workflow, `infra/app`, Dockerfile и того, что они собирают (`turbo.json`, `package.json` приложений и `@repo/db`, `prisma.config.ts`), настроек web и `core` вместе со схемами пакетов, которые проверяются при старте, health, привязки порта и адреса API раннеров — и вручную (по желанию с `--renewal`); для merge не обязателен. `edge-cert.yml` — ежедневная проверка срока сертификата apex и `www` (запас 21 день), включается переменной `EDGE_CERT_HOST`.

## Образы

| Образ | Откуда | Digest |
| --- | --- | --- |
| Node 26.10.0 trixie-slim (база web и orchestrator) | `docker.io/library/node` | `sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1` |
| gitleaks 8.30.1 | `ghcr.io/gitleaks/gitleaks` | `sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f` |
| Traefik 3.7.13 | `ghcr.io/traefik/traefik` | `sha256:f86a2cab1b5c649070c49f883c743dd32d8485a56e3368c5f93b9e91f1e91259` |
| PostgreSQL 17.11 (alpine 3.24) | `docker.io/library/postgres` | `sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24` |
| Redis 8.10.2 (alpine) | `docker.io/library/redis` | `sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0` |
| Pebble 2.10.1 (только проверка) | `ghcr.io/letsencrypt/pebble` | `sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199` |
| pebble-challtestsrv 2.10.1 (только проверка) | `ghcr.io/letsencrypt/pebble-challtestsrv` | `sha256:12ce21884def456bcf9786542113949e1f19dc7738d2c70e156c2d0c38a1405b` |
| whoami 1.12.0 (только проверка) | `ghcr.io/traefik/whoami` | `sha256:c4717a8d1f0134a7444e24f881160e033991f23027c6c5a9a3f8fd22e70d1d44` |

Digest — индекс мультиплатформенного образа (`docker buildx imagetools inspect`). Traefik берётся из `ghcr.io/traefik/traefik`: образ `docker.io/library/traefik:v3.7.13` — другая сборка с другим digest (`sha256:24841fe2…`). Зеркала в своём реестре должны сохранять эти digest (`crane copy`, `skopeo copy --all --preserve-digests`).

Размер локальных образов (arm64): web — 454 МБ (103 МБ сжатый), orchestrator — 1,28 ГБ (272 МБ), migrate — 2,01 ГБ (412 МБ: стадия сборки с Prisma CLI и dev-зависимостями).

## Сквозная проверка

```sh
pnpm verify:edge                   # сборка образов и проверка, ~7 минут с кэшем сборки
pnpm verify:edge -- --no-build     # образы raditi-verify/*:local уже собраны, ~45 секунд
pnpm verify:edge -- --renewal      # плюс продление 30-минутного сертификата, ещё ~10 минут
```

Результат на Docker Desktop — два прогона 27.09.2026: `-- --no-build` (25 проверок) и полный со сборкой образов из рабочего дерева и `--renewal` (26 проверок, 17 минут). После полного прогона не осталось ни контейнеров, ни томов, ни сетей, ни временного каталога. Повтор 28.09.2026 на ветке с `150f865` (полная проверка ветки, `03-p2-verification.md`): полный прогон со сборкой образов без `--renewal` — 25 проверок за 4 минуты, после него тоже ничего не осталось.

| № | Проверка | Итог |
| --- | --- | --- |
| 1 | Сертификат `raditi.test` от Pebble Intermediate, цепочка до корня Pebble, SAN — только apex | ✓ |
| 1b | Отдельный сертификат `www.raditi.test` | ✓ |
| 2 | `https://raditi.test/` — 200, HTML с «Радити», HSTS от web | ✓ |
| 3 | `/api/health` без токена — только `{"status":…}` | ✓ |
| 3b | С токеном: у web и core `database` и `redis` — `ok` под ролями `raditi_web`/`raditi_core` и пользователями Redis `web`/`core` | ✓ |
| 4 | `http://…:18080/x?y=1` → 301 на `https://raditi.test/x?y=1`, без порта | ✓ |
| 5 | `www` → 301 на apex | ✓ |
| 6 | Неизвестный SNI и рукопожатие без SNI отклонены (`sniStrict`) | ✓ |
| 7 | `/api/metrics` на apex и `www` с верным токеном — 403 от Traefik | ✓ |
| 8 | Поддельные `X-Forwarded-For` и `X_Forwarded_For` не доходят: один адрес, `X-Forwarded-Proto: https` | ✓ |
| 8b | Только Linux, `--real-address`: Traefik передаёт настоящий адрес клиента | ✓ (Linux) |
| 9 | Через край `POST /runner/v1/poll`, `/health`, `/metrics`, `Host: core` — только 403/404/421, ответов core нет | ✓ |
| 10 | Панели и API Traefik нет | ✓ |
| 11 | Из Traefik имена `core`, `postgres`, `redis` не разрешаются | ✓ |
| 11b | web и core не видят друг друга | ✓ |
| 12 | Опубликованы только 18080 и 18443 Traefik, 18083 core (API раннеров), 15000 Pebble — все на `127.0.0.1` | ✓ |
| 13 | API раннеров — голый HTTP; неверный токен — 401 `{"error":"UNAUTHORIZED"}` от core | ✓ |
| 13b | Верный токен, привязанный к `10.0.0.1`, с другого адреса — 401 | ✓ |
| 13c | Только Linux, `--real-address`: верный токен со своего адреса принят, `core` видит этот адрес | ✓ (Linux) |
| 14 | TLS на порту API раннеров нет | ✓ |
| 15 | На адресе хоста в локальной сети порт API раннеров закрыт | ✓ |
| 16 | Токен сброса пароля (apex и `www`) и query-строки в журнал Traefik не попадают, пути попадают | ✓ |
| 17 | В журнале Traefik нет ошибок, все флаги приняты | ✓ |
| 18 | После пересоздания контейнера Traefik сертификат тот же, новых заказов у Pebble нет | ✓ |
| 19 | `--renewal`: сертификат на 30 минут (`ACME_CERT_HOURS=1`) Traefik продлевает сам, серийный номер меняется примерно через 10 минут | ✓ |
| 20 | web с конфигурацией без `BETTER_AUTH_SECRET` выходит с ошибкой за 30 секунд и называет только секцию `auth` | ✓ |
| 21 | `raditi_web` не может `CREATE TABLE`; ни одна роль не суперпользователь; `raditi_core` читает таблицы; по сети (по имени сервиса, не через `127.0.0.1`, где `trust`) неверный пароль отклонён, а суперпользователь `postgres` не входит и со своим паролем | ✓ |
| 22 | Redis: `FLUSHALL`, `CONFIG`, `KEYS` для `web` и `GET` для `health` — `NOPERM` | ✓ |

8b и 13c (настоящий адрес клиента у Traefik и у core) выполняются только с `--real-address` на Linux: на Docker Desktop соединение с опубликованным портом всегда приходит с адреса шлюза (`172.x.0.1`).

## Прогон на Linux

GitHub Actions, `edge.yml`, Ubuntu 24.04 с `userland-proxy: false`: `verify:edge -- --no-build --real-address`. Прогон 36362229172 на `150f865` (28.09.2026) — 26 проверок, в том числе 8b (Traefik передаёт настоящий адрес клиента) и 13c (верный токен со своего адреса принят, `core` видит этот адрес). Проверка 15 с `--real-address` не выполняется: API раннеров опубликован на адресе хоста в локальной сети.

Прежний прогон (36360514788) упал на 8b: Docker подменяет адрес источника у любого соединения самого хоста с опубликованным портом, и Traefik видел адрес шлюза моста. С `150f865` клиент `--real-address` работает в своём сетевом пространстве имён и ходит к хосту через пару veth; токен раннера привязан к его адресу.

## Что поменялось относительно дизайна

- **Traefik — из `ghcr.io/traefik/traefik`.** Digest в дизайне — от этого образа; у `docker.io/library/traefik` другой. Бинарь — `/usr/local/bin/traefik`, а не `/traefik`: healthcheck вызывает `traefik` из `PATH`.
- **`aliasheadersstrategy=delete` на всех точках входа**, не только на `websecure`: Traefik 3.7 иначе пишет предупреждение для `web` и `internal`.
- **`SANDBOX_IMAGE_PREFIX` в окружении core** (`env.example`: `git.raditi.ru/raditi/agent`): без него core в проде не стартует (секция драйверов агентов).
- **tmpfs `migrate` — блочным списком.** Во flow-последовательности YAML запятые в `size=64m,uid=…` делят элемент, и Docker отказывает.
- **`.dockerignore`** исключает `infra`, кроме `infra/sandbox/*.mjs`: их копируют образы песочницы (`infra/sandbox/Dockerfile`).
- **Без строки `# syntax=`**: встроенный frontend Docker 29 уже умеет cache mounts и ничего не тянет с Docker Hub.
- **Проверка 11b** сверяет адреса: DNS хоста отвечает на имя `web` (это ещё и домен верхнего уровня) адресом `127.0.53.53`. Главное — адрес чужого контейнера не разрешается и соединения нет.
- **Проверка 10** следует одному редиректу Next (`/dashboard/` → `/dashboard`), потом ждёт 404.
- **Проверка 17** не ищет строку `Configuration loaded from flags`: в JSON-журнале Traefik 3.7 её нет. Флаги приняты, если запустился провайдер ACME: с неизвестным флагом Traefik не стартует.
- **Проверка 20** передаёт web все несекретные настройки из compose, поэтому сломана ровно секция `auth`.
- **Логи — journald хоста** (ревью 28.09.2026): у драйвера `local` логи удалялись вместе с контейнером при каждой выкладке. `verify:edge` сначала проверяет, что демон пишет в journald и читает оттуда (`docker logs`); если нет — как у Docker Desktop, — стек запускается с `verify/compose.local-logs.yml`, который меняет только драйвер. Прогон на Docker Desktop 28.09.2026 со сборкой образов: 25 проверок, драйвер `local`. На Linux (`edge.yml`) стек идёт с journald; драйвер записи и чтения проверен на ВМ Colima (Docker 29.5).

## Не закрыто

- **Первая выкладка** ждёт секреты из Vault через vault-agent (M10) — открытый вопрос 3 дизайна; куда пушить образы до реестра Gitea — там же.
- **`allowencodedpercent=false`** проверен только на страницах, которые открывает `verify:edge`; e2e через край не гонялся.
