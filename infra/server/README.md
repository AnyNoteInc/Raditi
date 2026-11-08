# Один сервер: вся платформа на одной ВМ

Запрос владельца от 08.11.2026: развернуть платформу на сервере `45.8.250.117` (Selectel, Москва, Ubuntu 22.04, 4 vCPU, 8 ГБ) и выкладывать версии из GitHub по тегу выпуска. Многомашинная схема spec §19 (app-ВМ, ВМ Vault, песочные ВМ, узел выхода) здесь сведена на одну машину: compose app-ВМ (`infra/app/docker-compose.yml`) остаётся основой, а это наложение добавляет то, что в spec живёт на других машинах.

| Где в spec §19 | Здесь |
| --- | --- |
| ВМ Vault с TLS | OpenBao 2.7.2 на хосте (systemd), TLS внутреннего CA, `vault.raditi.internal` |
| vault-agent, `raditi-secrets.service` | `host/platform-secrets.mjs render` перед `docker.service` |
| S3 российского облака | SeaweedFS 4.47 в compose, TLS внутреннего CA, `s3.raditi.internal:8333`, path-style |
| Песочная ВМ (раннер, watchdog) | те же контейнеры на этом Docker, песочницы под `runsc` |
| Частная сеть | адрес `10.10.0.10` на интерфейсе `raditi0` (`raditi-net.service`), снаружи отброшен `raditi-host.nft` |
| Группы безопасности облака | `raditi-host.nft`: на хост снаружи — только SSH 2222; 80 и 443 — опубликованные порты Traefik |
| Узел выхода `egress-1` | не нужен: `llm` ходит к `api.z.ai` прямым путём (ответ владельца на П2) |

Чего пока нет: Gitea и раннера выкладки сайтов — без них не работают чаты с проектом (git хода, `/release`); предпросмотров — нет wildcard-сертификата `*.raditi-preview.ru` (владелец: «сертификаты пока только на корень») и исполнителя предпросмотров в production (M10). Работают кабинет, вход и регистрация, биллинг (без магазина ЮKassa), письма, заявки, чаты без проекта с агентом и облачным браузером.

## Что где

| Файл | Что это |
| --- | --- |
| `docker-compose.server.yml` | Наложение: S3, `mcp`, `browser`, шлюз трансляции (`preview`), раннер, watchdog, `llm` без узла выхода, маршруты сервера в Traefik |
| `traefik/server.yml` | `deploy.sh` копирует его в `traefik/dynamic/` рядом с `raditi.yml`. Панель Traefik `traefik.raditi.ru` с basic auth, корень `raditi-preview.ru` → кабинет, поток браузера `wss://raditi.ru/v1/browser/stream` → шлюз трансляции |
| `env.example` | Образец `/opt/raditi/app/.env`: только несекретное; `*_IMAGE` и `APP_REVISION` пишет `deploy.sh` |
| `preflight.sh` | Проверки хоста перед стартом (часть `infra/app/preflight.sh`, которая верна для одной машины, плюс адрес, firewall, OpenBao, gVisor) |
| `deploy.sh` | Выкладка тега: запись для отката, файлы, digest, pull, preflight, дамп, миграции, сиды, `up` |
| `host/install.sh` | Хост: gVisor, Docker, journald, часы, OpenBao, внутренний CA, юниты; повторяемый |
| `host/vault-setup.sh` | AppRole `web`, `core`, `llm`, `mcp` и `renderer` |
| `host/platform-secrets.mjs` | `seed` — случайные секреты платформы в Vault, `set` — ключ владельца со stdin, `render` — `/run/raditi/<сервис>/` |
| `host/internal-ca.sh` | Внутренний CA и сертификаты `*.raditi.internal` |

## Хост

Один раз, под root, из копии `infra/server/host`:

```sh
sh install.sh                                   # пакеты, gVisor, настройки Docker, OpenBao, CA, юниты
umask 077                                       # init.json хранит ключ распечатки и root-токен
curl -sf -X PUT --data '{"secret_shares":1,"secret_threshold":1}' http://127.0.0.1:8200/v1/sys/init \
  > /etc/raditi/openbao/init.json
jq -c '{key: .keys_base64[0]}' /etc/raditi/openbao/init.json > /etc/raditi/openbao/unseal.json
jq -r .root_token /etc/raditi/openbao/init.json > /etc/raditi/openbao/root-token
chmod 0400 /etc/raditi/openbao/*
systemctl restart openbao-unseal
node ../../vault/bootstrap.mjs --address http://127.0.0.1:8200 < /etc/raditi/openbao/root-token
/usr/local/lib/raditi/vault-setup.sh
/usr/local/lib/raditi/platform-secrets.mjs seed
systemctl start raditi-secrets
```

- **Ключ распечатки на сервере** — решение владельца от 08.11.2026: перезагрузка не требует человека, но root сервера получает и секреты. `init.json` (ключ и root-токен) владелец копирует себе в надёжное место; без него данные Vault после потери сервера не вернуть.
- **Порядок загрузки:** `raditi-net` (адрес) и `raditi-host-firewall` → `openbao` → `openbao-unseal` → `raditi-secrets` → `chrony-wait` (`time-sync.target`) → `docker`. `/run` — tmpfs, секреты рендерятся заново при каждой загрузке, а каждый сервис получает новый SecretID AppRole (прежние уничтожаются).
- **Ключи владельца** уходят в Vault только со stdin: `printf %s "<ключ>" | ssh … /usr/local/lib/raditi/platform-secrets.mjs set app/core SENDSAY_API_KEY`, затем `platform-secrets.mjs render core` и `docker compose up -d --force-recreate --no-deps core`. Рендер выпускает названным сервисам с AppRole новый SecretID и уничтожает прежние, поэтому рендерят только те сервисы, которые сразу пересоздают; `systemctl restart raditi-secrets` рендерит все — это делается только при загрузке. Поля — `app/web` `SMARTCAPTCHA_CLIENT_KEY`, `SMARTCAPTCHA_SERVER_KEY`; `app/core` `SENDSAY_API_KEY`, `LEADS_TELEGRAM_BOT_TOKEN`, `GITEA_TOKEN`.
- **Пароль панели Traefik** — `kv/platform/app/traefik` (`dashboard_user`, `dashboard_password`); прочитать на сервере: `curl -s -H "X-Vault-Token: $(cat /etc/raditi/openbao/root-token)" http://127.0.0.1:8200/v1/kv/data/platform/app/traefik | jq -r '.data.data.dashboard_password'`.
- **Токен раннера** выпущен на сервере (`/etc/raditi/runner/runner-token`, 0400) и его не покидает; в `.env` — только `server-1:<sha256>@172.29.83.1`. Раннер работает в сети хоста, а Docker без userland-proxy подменяет адрес локального соединения с опубликованным портом на шлюз моста `core`: поэтому подсеть `core-egress` закреплена (`172.29.83.0/24`), и хеш привязан к её шлюзу. С того же адреса `core` видит любой контейнер, который пришёл к `10.10.0.10:8083` через hairpin, — допуск держит токен.

## Выкладка

`release.yml` после semantic-release и публикации образов (`publish-images.yml`, теперь и песочница, `sandbox-gw`, сторож сети, watchdog, прокси выхода и образы браузерной сессии) вызывает `deploy.yml`: тот копирует `infra/app` и `infra/server` тега и `images.env` выпуска в `/opt/raditi/incoming/<тег>/` и запускает там `server/deploy.sh <тег>`. Повтор или откат на прежний выпуск — `workflow_dispatch` с тегом (`gh workflow run deploy.yml -f tag=v1.25.0`). Секреты GitHub: `SSH_HOST`, `SSH_PORT`, `SSH_USERNAME`, `SSH_PRIVATE_KEY` и `SSH_KNOWN_HOSTS` (закреплённый ключ хоста); образы тянутся токеном задания (`packages: read`), он читается один раз со stdin во временный `DOCKER_CONFIG`.

Шаги `deploy.sh` — «Обычная выкладка» `infra/app/README.md`: запись в `/opt/raditi/releases.log`, файлы тега (`.env` не трогается), digest и `APP_REVISION` из `images.env`, pull, `preflight.sh`, `dump-db.sh` (когда база уже есть), бакеты, `migrate`, `seed`, `up -d --wait`, удаление образов, которых нет ни в `.env`, ни в последних записях журнала. Миграции, которые требуют остановки сервисов (`infra/app/README.md`, шаги 4 и 5), этот скрипт не останавливает: такой выпуск выкладывается руками.

## Отличия от многомашинной схемы

- **Firewall `llm` (`llm-firewall.mjs`) не ставится:** он собран под узел выхода. Порт 8084 опубликован только на `10.10.0.10`, снаружи закрыт; изнутри до него может дойти любой контейнер с выходом в сеть, а `llm` пускает только по ключу хода. Все клиенты приходят через hairpin и видны как `172.29.84.1` (`LLM_GATEWAY_CLIENTS`).
- **Vault, S3, база и API раннеров** на хосте доступны контейнерам с выходом в сеть (не песочницам: у них internal-сеть и `sandbox-gw`, а прокси выхода закрывает `10.10.0.0/24` и публичный адрес сервера — `SANDBOX_EGRESS_REFUSED_SUBNETS`).
- **Бэкапы** (`dump-db.sh`, S3) — на том же диске, что база. Хранилище вне сервера — задача следующего шага.
- **Сокет Docker** есть у `browser`, раннера и watchdog, а это root хоста — там же ключ распечатки, root-токен OpenBao и `renderer.json`. В многомашинной схеме выход из gVisor или захват раннера давал только песочную ВМ, здесь — все секреты платформы. Граница — gVisor (правило 5); риск принят вместе с решением о сервере (spec §20, С1, С11), вынести песочницу на отдельную ВМ — следующий шаг.
- **Root-токен OpenBao** лежит на сервере (`/etc/raditi/openbao/root-token`, 0400): им работают `seed`, `set` и `model-setup.sh`. Отозвать его после настройки и выпускать токены оператора на 15 минут — решение владельца (spec §20, С11).
- **Права S3:** у `browser` — только чтение `raditi-inbox`; у web и `core` — чтение и запись без `Admin` (бакеты создаёт `weed shell`).
