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

Работают кабинет, вход и регистрация, биллинг (без магазина ЮKassa), письма, заявки в Telegram, чаты, облачный браузер, опубликованные страницы и Telegram. Проектов, предпросмотров, `/release` и Gitea нет с 15.11.2026 ([план 83](../../docs/plan/83-remove-projects.md)).

## Что где

| Файл | Что это |
| --- | --- |
| `docker-compose.server.yml` | Наложение: S3, `mcp`, `browser`, шлюз трансляции (`preview`), раннер, watchdog, `llm` без узла выхода, маршруты сервера в Traefik |
| `traefik/server.yml` | `deploy.sh` копирует его в `traefik/dynamic/` рядом с `raditi.yml`. Панель Traefik `traefik.raditi.ru` с basic auth, поток браузера `wss://raditi.ru/v1/browser/stream` → шлюз трансляции |
| `env.example` | Образец `/opt/raditi/app/.env`: только несекретное; `*_IMAGE` и `APP_REVISION` пишет `deploy.sh` |
| `preflight.sh` | Проверки хоста перед стартом (часть `infra/app/preflight.sh`, которая верна для одной машины, плюс адрес, firewall, OpenBao, gVisor) |
| `deploy.sh` | Выкладка тега: запись для отката, файлы, digest, pull, preflight, дамп, миграции, сиды, `up` |
| `host/install.sh` | Хост: gVisor, Docker, journald, часы, OpenBao, внутренний CA, юниты; повторяемый |
| `host/vault-setup.sh` | AppRole `web` (`sites-writer`, `workspace-provisioner`), `core` (`core-turns`, `core-transit`, `core-workspace-env`, `core-git`), `llm`, `mcp` и `renderer`; политики ролей сверяет с `infra/vault/bootstrap.mjs` тест `server.test.mjs` |
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
- **Ключи владельца** уходят в Vault только со stdin: `printf %s "<ключ>" | ssh … /usr/local/lib/raditi/platform-secrets.mjs set app/core SENDSAY_API_KEY`, затем `platform-secrets.mjs render core` и `docker compose up -d --force-recreate --no-deps core`. Рендер выпускает названным сервисам с AppRole новый SecretID и уничтожает прежние, поэтому рендерят только те сервисы, которые сразу пересоздают; `systemctl restart raditi-secrets` рендерит все — это делается только при загрузке. Поля — `app/web` `SMARTCAPTCHA_CLIENT_KEY`, `SMARTCAPTCHA_SERVER_KEY`, `YANDEX_SPEECHKIT_API_KEY`, `YANDEX_CLIENT_ID` и `YANDEX_CLIENT_SECRET` (приложение Яндекс ID входа, адрес возврата `https://raditi.ru/api/auth/callback/yandex`); `app/core` `SENDSAY_API_KEY`, `LEADS_TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN` (бот чата, его получают и `web`, и `core`, [план 80](../../docs/plan/80-telegram.md)), `WEB_PUSH_PRIVATE_KEY`; `gitlab-oauth` и `github-app` — раздел «Репозитории проектов» ниже. Выкладка рендерит `web` и `core` заново и пересоздаёт их, поэтому ключ, положенный до выкладки, новая версия получает сама ([план 75](../../docs/plan/75-chat-input-output.md)).
- **Пароль панели Traefik** — `kv/platform/app/traefik` (`dashboard_user`, `dashboard_password`); прочитать на сервере: `curl -s -H "X-Vault-Token: $(cat /etc/raditi/openbao/root-token)" http://127.0.0.1:8200/v1/kv/data/platform/app/traefik | jq -r '.data.data.dashboard_password'`.
- **Токен раннера** выпущен на сервере (`/etc/raditi/runner/runner-token`, 0400) и его не покидает; в `.env` — только `server-1:<sha256>@172.29.83.1`. Раннер работает в сети хоста, а Docker без userland-proxy подменяет адрес локального соединения с опубликованным портом на шлюз моста `core`: поэтому подсеть `core-egress` закреплена (`172.29.83.0/24`), и хеш привязан к её шлюзу. С того же адреса `core` видит любой контейнер, который пришёл к `10.10.0.10:8083` через hairpin, — допуск держит токен.

## Репозитории проектов: GitLab и GitHub

[План 84](../../docs/plan/84-projects.md), §4.2, ПР10. Токены подключений клиентов лежат в `kv/workspaces/<пространство>/git/<id подключения>`: пишет web (политика `sites-writer`, прочитать обратно не может), читает и обновляет по CAS `core` (`core-git`, роль `core` в `vault-setup.sh`); `git-worker` своей роли и `/run/raditi` не получает, `mcp` токенов git не видит. `deploy.sh` политик Vault, ролей и правил хоста не трогает (`infra/vault` в файлы тега не входит), поэтому выпуск с `core-git` и новым `raditi-host.nft` один раз доводится руками на сервере, из дерева этого тега: `node infra/vault/bootstrap.mjs --address http://127.0.0.1:8200 < /etc/raditi/openbao/root-token` (пишет политику `core-git` и новые пути `sites-writer`), `install -m 0755 infra/server/host/vault-setup.sh /usr/local/lib/raditi/ && /usr/local/lib/raditi/vault-setup.sh` (роль `core` с `core-git`), `install -m 0644 infra/server/host/raditi-host.nft /etc/raditi/ && nft -f /etc/raditi/raditi-host.nft`, затем `platform-secrets.mjs render web core` и пересоздать оба. Без этого `core` в production не прочитает и не обновит доступы GitLab. Общие секреты платформы:

- **`repo_confirm_secret`** (`kv/platform/shared`) — HMAC карточек репозитория `REPO_CONFIRM_SECRET`, web и `core`. Создаёт `platform-secrets.mjs seed` (его вызывает и `deploy.sh`). Новое значение (удалить поле, `seed`, `render web core`, пересоздать оба) гасит открытые карточки «Отправить», «Принять» и «Выкатить» — клиент нажимает их заново.
- **`kv/platform/gitlab-oauth`** — OAuth-приложение Радити на gitlab.com: `client_id`, `client_secret` → `GITLAB_OAUTH_CLIENT_*` у web (вход) и `core` (обновление токенов). Регистрация — владелец, учётная запись Радити на gitlab.com: «Edit profile» → «Applications» → «Add new application»; имя «Радити»; Redirect URI — `https://raditi.ru/api/git/gitlab/callback` (план 84, §4.4); Confidential — да; права `api` и `write_repository`, больше ничего. Затем `printf %s "<Application ID>" | ssh … platform-secrets.mjs set gitlab-oauth client_id` и так же `client_secret`, `render web core`, пересоздать оба. Пока полей нет или есть только одно, рендер группу не отдаёт (и пишет, каких полей нет), а «Подключить GitLab.com» помечен «Скоро». Смена секрета: в GitLab «Renew secret», `set gitlab-oauth client_secret`, `render web core`, пересоздать оба; выданные клиентам токены остаются в силе, обновляются уже новым секретом.
- **`kv/platform/github-app`** (Э10) — GitHub App Радити: `app_id`, `slug`, `client_id`, `client_secret`, `webhook_secret`, `private_key`. Web получает `slug`, `client_id`, `client_secret`, `webhook_secret`; `core` — `GITHUB_APP_ID` и ключ файлом `/run/raditi/core/github-app.pem` (0400, в контейнере — `/run/raditi/github-app.pem`, `GITHUB_APP_PRIVATE_KEY_FILE`): многострочный PEM в `app.env` не помещается. Регистрация — владелец, организация Радити на GitHub: «Settings» → «Developer settings» → «GitHub Apps» → «New GitHub App»; Callback URL — `https://raditi.ru/api/git/github/callback`, Webhook URL — `https://raditi.ru/api/webhooks/github` (план 84, §4.4; вебхуки — Э10); «Request user authorization during installation» — да; права репозитория: Contents, Pull requests, Actions — запись, Checks, Statuses — чтение, Workflows — запись (в токен попадает только после карточки ПР16), Metadata — чтение; «Any account». Ключ: «Generate a private key» скачивает `.pem` — он кладётся файлом через stdin, `ssh … platform-secrets.mjs set github-app private_key < raditi.private-key.pem` (принимается только PEM ключа RSA), остальные поля — по одному, как выше. Пока не заданы все шесть, рендер группу не отдаёт. **Смена ключа:** в настройках приложения «Generate a private key» (у приложения может быть несколько ключей), `set github-app private_key < новый.pem`, `render core`, пересоздать `core`, проверить подключение GitHub в кабинете и только потом удалить прежний ключ в GitHub. Секрет вебхука — так же: новый в GitHub и `set github-app webhook_secret`, `render web`, пересоздать web.
- **Сеть `git-worker`.** Рабочий git разбирает pack чужих серверов (ПР33) и стоит в своей сети `git-egress` — мост `rd-git` (`BRIDGE_PREFIX=rd`). `raditi-host.nft` отбрасывает с этого моста всё, что идёт на сам хост (его `10.10.0.10` и публичный адрес), и пересылку на частные адреса — опубликованные порты платформы Docker отдаёт через FORWARD на адреса контейнеров. В интернет мост открыт: адрес каждой операции выбирает и закрепляет `core` (`SANDBOX_EGRESS_REFUSED_SUBNETS`). Другой `BRIDGE_PREFIX` — поправить имя моста в `raditi-host.nft`.

## Gitea и предпросмотры

С 15.11.2026 их нет ([план 83](../../docs/plan/83-remove-projects.md), БП2, БП10, БП13): ни сервисов `gitea` и `gitea-runner`, ни раннера выкладки, ни предпросмотров чатов, ни домена `raditi-preview.ru`. Первая выкладка этого выпуска (`deploy.sh`, шаг 7) сама удаляет их контейнеры (`--remove-orphans`), сети предпросмотров и тома `raditi-app-gitea`, `raditi-app-gitea-config`, `raditi-app-gitea-runner` и `raditi-ci-ca`. Руками остаётся владельцу: удалить у регистратора записи DNS `raditi-preview.ru` и `*.raditi-preview.ru` (домен можно не продлевать); сертификаты этого домена лежат в `acme.json` тома `acme` и Traefik их больше не продлевает. В OpenBao сервера остаются ключи `kv/platform/app/gitea`, `kv/platform/gitea-org-owner`, `kv/platform/app/mcp` и `kv/sites/*` — их никто не читает, оператор удаляет их токеном root.

## Страницы

Опубликованные страницы агента ([план 69](../../docs/plan/69-pages.md), Ст3, Ст4): `https://<slug>.pages.raditi.ru/` отдаёт слушатель страниц приложения `preview` на `8092` (`PAGES_PORT`), маршрут — `traefik/dynamic/pages.yml` (одна метка из 26 знаков base32 под `PAGES_BASE_DOMAIN`). Корень `pages.raditi.ru` — ссылки по токену плана 67 — принадлежит web и в этот маршрут не входит.

- **Сертификат** `*.pages.raditi.ru` — резолвер `pages`, DNS-01 через API reg.ru (lego `regru`, `PREVIEW_DNS_PROVIDER=regru` — имя переменной осталось от предпросмотров): логин и альтернативный пароль API — `kv/platform/app/traefik` (`regru_username`, `regru_password`), IP сервера разрешён в настройках API reg.ru; reg.ru отдаёт новую TXT-запись через минуты, поэтому `REGRU_PROPAGATION_TIMEOUT=1800`. Зона `raditi.ru` должна лежать в этом же аккаунте reg.ru. Сертификаты резолвера — в своём файле `pages-acme.json` тома `acme`. Запись DNS `*.pages.raditi.ru` → `45.8.250.117`.
- **Секрет** cookie пароля страницы `PAGES_COOKIE_SECRET`: поле `app/preview` в Vault, `seed` создаёт его, `render preview` кладёт в `/run/raditi/preview/app.env`. `deploy.sh` делает оба шага на каждой выкладке; `seed` значение не переписывает.
- **Переменные** `.env`: `PAGES_BASE_DOMAIN=pages.raditi.ru` выкладка добавит сама. `BROWSER_PLATFORM_HOSTS` не меняется: `raditi.ru` в нём закрывает браузеру чата всё под собой, кроме страниц агента. Их открывает исключение по `PAGES_BASE_DOMAIN` у `browser`, а прокси выхода сессии пускает к адресу сервера (`BROWSER_PAGE_ADDRESSES=45.8.250.117`, выкладка добавит строку сама) только имя страницы на 443 (план 69, Ст26). После выкладки проверьте: страница открывается в браузере чата.

## Telegram

`api.telegram.org` с этого сервера не отвечает. По просьбе владельца (бесплатный прокси) `core` ходит к нему через `host/telegram-proxy.mjs` (`raditi-telegram-proxy.service`, `TELEGRAM_PROXY_URL=http://10.10.0.10:3129`): тот принимает только `CONNECT api.telegram.org:443` и ведёт его через пул проверенных бесплатных публичных HTTP-прокси (с 14.11.2026 прокси попадает в пул, только если через него проходит рукопожатие TLS с проверенным сертификатом `api.telegram.org`: многие бесплатные прокси подменяют TLS, и `core` их всё равно отклоняет — в логе `Telegram getUpdates failed: ? TypeError SELF_SIGNED_CERT_IN_CHAIN`) (список proxyscrape, обновление раз в 20 минут и при нехватке, нерабочий отбрасывается). TLS — сквозной от `core` до Telegram: публичный прокси видит только имя хоста. Tor с этого сервера не проходит (DPI на рукопожатии, без мостов). Надёжность бесплатных прокси не гарантирована: при долгом сбое заявки ждут в очереди.

**Бот чата `@raditi_bot`** ([план 80](../../docs/plan/80-telegram.md)). Telegram не открывает соединение к серверу (`getWebhookInfo` — `Connection timed out`, 15.11.2026), поэтому вебхука нет: `core` раз в 2 с читает `getUpdates` через тот же прокси и отдаёт каждое обновление web на `TELEGRAM_INTAKE_URL=https://raditi.ru/api/webhooks/telegram` через Traefik (общей сети у `core` и web нет) с секретом в заголовке; web скачивает через прокси файлы и голосовые. Токен кладёт владелец: `printf %s "<токен>" | ssh … platform-secrets.mjs set app/core TELEGRAM_BOT_TOKEN`; секрет `TELEGRAM_WEBHOOK_SECRET` создаёт `platform-secrets.mjs seed`; рендер отдаёт оба и `web`, и `core`. В `.env` сервера — `TELEGRAM_BOT_USERNAME=raditi_bot`. Темы в личных чатах включает владелец бота в мини-приложении @BotFather; без них бот ведёт «текущий чат». Проверка: `/start` боту без ссылки отвечает «Подключите Telegram в кабинете», а в логе `core` — `The bot of the chat reads its updates every 2 s`.

**Запланированные задачи** ([план 82](../../docs/plan/82-scheduled-tasks.md), Зп19). `core` раз в минуту находит задачи, которым пора, и передаёт каждый запуск web на `SCHEDULE_INTAKE_URL=https://raditi.ru/api/webhooks/scheduled-runs` через Traefik, как обновления бота, с секретом в заголовке `x-raditi-schedule-secret`; web начинает чат запуска. Секрет `SCHEDULE_INTAKE_SECRET` создаёт `platform-secrets.mjs seed` в `kv/platform/app/core`; рендер отдаёт его и `web`, и `core`. Маршрут проходит через общий маршрут `/api/*` Traefik, на краю его не закрывают. Адрес задаёт `docker-compose.yml`, поэтому секрет обязателен: без него `core` не стартует (`SCHEDULE_INTAKE_URL and SCHEDULE_INTAKE_SECRET: set both or neither`), а `deploy.sh` перед рендером всегда делает `seed`. Проверка: в логе `core` — `Scheduled tasks are claimed every 60 s`.

## Модель

Бэкенд — `zai-coding`, план GLM Coding Plan (указание владельца от 09.11.2026: «используй провайдер zai-coding»; уровень `lite` — значение по умолчанию П4): `model-setup.sh key zai-coding lite` (ключ со stdin) и `model-setup.sh enable zai-coding` (провайдер, профили, ставки `2026-11-06-zai-coding.json`, курс 6,00 с `--confirm-exposure`, аккаунт). `zai-api` — запасной путь (П88): его аккаунт импортирован, провайдер, профили и аккаунт выключены. Клиренс (`model-setup.sh clearance <бэкенд> …`) записан для обоих: уведомление по ст. 22 — рег. № 76439/77 от 14.05.2026, по ст. 12 — «подаётся», передача — решение владельца от 09.11.2026.

## Выкладка

`release.yml` после semantic-release и публикации образов (`publish-images.yml`, теперь и песочница, `sandbox-gw`, сторож сети, watchdog, прокси выхода и образы браузерной сессии) вызывает `deploy.yml`: тот копирует `infra/app` и `infra/server` тега и `images.env` выпуска в `/opt/raditi/incoming/<тег>/` и запускает там `server/deploy.sh <тег>`. Повтор или откат на прежний выпуск — `workflow_dispatch` с тегом (`gh workflow run deploy.yml -f tag=v1.25.0`). Секреты GitHub: `SSH_HOST`, `SSH_PORT`, `SSH_USERNAME`, `SSH_PRIVATE_KEY` и `SSH_KNOWN_HOSTS` (закреплённый ключ хоста); образы тянутся токеном задания (`packages: read`), он читается один раз со stdin во временный `DOCKER_CONFIG`.

Шаги `deploy.sh` — «Обычная выкладка» `infra/app/README.md`: запись в `/opt/raditi/releases.log`, файлы тега (`.env` не трогается), digest и `APP_REVISION` из `images.env`, pull, `seed` секретов платформы и `render preview`, `preflight.sh`, `dump-db.sh` (когда база уже есть), бакеты, `migrate`, `seed`, `up -d --wait`, удаление образов, которых нет ни в `.env`, ни в последних записях журнала. Миграции, которые требуют остановки сервисов (`infra/app/README.md`, шаги 4 и 5), этот скрипт не останавливает: такой выпуск выкладывается руками.

## Отличия от многомашинной схемы

- **Firewall `llm` (`llm-firewall.mjs`) не ставится:** он собран под узел выхода. Порт 8084 опубликован только на `10.10.0.10`, снаружи закрыт; изнутри до него может дойти любой контейнер с выходом в сеть, а `llm` пускает только по ключу хода. Порт опубликован через сеть `core-egress`: песочницы приходят через hairpin и видны как её шлюз `172.29.83.1`, а `core` стоит в той же сети и приходит со своего закреплённого адреса `172.29.83.10` — оба адреса в `LLM_GATEWAY_CLIENTS`. Без второго `llm` отвечает пробе окон квоты 403 `raditi_route`, снимок окон плана после сброса не обновляется, и каждый ход ждёт `SUBSCRIPTION_WAIT` (09.11.2026).
- **Vault, S3, база и API раннеров** на хосте доступны контейнерам с выходом в сеть (не песочницам: у них internal-сеть и `sandbox-gw`, а прокси выхода закрывает `10.10.0.0/24` и публичный адрес сервера — `SANDBOX_EGRESS_REFUSED_SUBNETS`; не `git-worker`: его мост `rd-git` к хосту и частным адресам закрывает `raditi-host.nft`).
- **Бэкапы** (`dump-db.sh`, S3) — на том же диске, что база. Хранилище вне сервера — задача следующего шага.
- **Сокет Docker** есть у `browser`, раннера и watchdog, а это root хоста — там же ключ распечатки, root-токен OpenBao и `renderer.json`. В многомашинной схеме выход из gVisor или захват раннера давал только песочную ВМ, здесь — все секреты платформы. Граница — gVisor (правило 5); риск принят вместе с решением о сервере (spec §20, С1, С11), вынести песочницу на отдельную ВМ — следующий шаг.
- **Root-токен OpenBao** лежит на сервере (`/etc/raditi/openbao/root-token`, 0400): им работают `seed`, `set` и `model-setup.sh`. Отозвать его после настройки и выпускать токены оператора на 15 минут — решение владельца (spec §20, С11).
- **Права S3:** у `browser` — только чтение `raditi-inbox`; у web и `core` — чтение и запись без `Admin` (бакеты создаёт `weed shell`).

## Домен страниц агента

Корень `pages.raditi.ru` ([план 67](../../docs/plan/67-agent-documents.md), Д3; ответ владельца от 13.11.2026) отвечает web: страницы, которые агент делает для клиента, кабинет показывает во фрейме по адресу `https://pages.raditi.ru/v/<token>`. Адрес корня web выводит из `PAGES_BASE_DOMAIN` ([план 69](../../docs/plan/69-pages.md), Ст3): своей переменной у него нет. Нужны запись A `pages.raditi.ru` на адрес сервера (запись `*.pages.raditi.ru` её не покрывает) и строка `.env` `PAGES_ROOT_HOST=pages.raditi.ru` — тогда маршрут `pages-root` в `traefik/server.yml` появляется и сам заказывает сертификат HTTP-01. Пустой `PAGES_ROOT_HOST` — маршрута нет, и кабинет показывает страницы чата фреймом, который не откроется; скачать их можно всегда. Секрет подписи `PAGES_SIGNING_SECRET` создаёт `platform-secrets.mjs seed` в `kv/platform/app/web`; новое значение (удалить поле и `seed`, затем `render web` и пересоздать web) гасит все выданные адреса страниц — открытые вкладки возьмут новый адрес по «Обновить». Поддомены `*.pages.raditi.ru` — план 69.
