# Стенд первоначального импорта сайта

```sh
pnpm verify:site-import                              # весь путь: стенд, браузер, восстановление
pnpm verify:site-import -- --infra-only              # только самопроверки стенда
pnpm verify:site-import -- --only b1,r3              # отдельные части (идентификаторы ниже)
pnpm verify:site-import -- --keep                    # оставить стенд после прохода до Ctrl-C
```

Скрипт пакета собирает orchestrator и запускает `node infra/dev/site-import-verify/verify-site-import.mjs`; без сборки проверяется та сборка `apps/orchestrator/dist`, что лежит в дереве.

Стенд среза W5 плана [мастера подключения сайта](../../../docs/plan/39-site-connection-wizard.md): путь «мастер → outbox → скачивание файлов по SFTP или FTP → приватный репозиторий Gitea → первый коммит и тег `v0.0.0`» на настоящих серверах — одноразовых и только на `127.0.0.1`. Браузер (Playwright) проходит мастер, экран «Настраиваем сайт» и «Изменить доступ»; сам стенд ведёт сценарии восстановления через API кабинета (tRPC с cookie сессии) и снаружи — Docker, Gitea, PostgreSQL, OpenBao — проверяет каждый импортированный сайт и всё, что прогон оставил.

Стенд не читает `.env` репозитория, ничего не скачивает (`--pull=never`, кроме `apk add` при первой сборке образа хостинга) и не трогает чужие контейнеры, сети, тома и процессы: каждый контейнер называется `raditi-siteimport-<run>-<service>` и несёт метку `io.raditi.siteimport-verify=<run>`; `next dev` чужого прогона (другой сессии, `pnpm dev`) стенд ждёт, а не останавливает. Данные синтетические, секреты случайные; они живут в памяти и в файлах `0600` каталога запуска, в контейнеры попадают через `--env-file`, `docker cp` и stdin, в браузерную половину — через файл `0600`, путь к которому — единственная переменная `SITE_IMPORT_STAND_FILE`; аргументами процессов они не бывают. Вывод называет проверки и порты, но не секреты.

## Части прогона

| Id | Что доказывает | Где |
| --- | --- | --- |
| `infra` | Самопроверки стенда (ниже) | `infra-checks.mjs` |
| `b1` | SSH с паролем и MySQL с проверкой TLS: «Проверяем подключение…», панель «Сверьте ключ сервера» с отпечатком, который посчитал стенд, «Ключ совпадает, продолжить», «Добавить проект». Пока `core` остановлен, проект ждёт в очереди: экран настройки «Ожидаем начала настройки» без рейки разделов, адрес раздела (`/changes`) ведёт на «Обзор», в списке — «Настраиваем»; событие outbox этапа содержит ровно `{ siteId, stage }`. Затем тест просит стенд запустить `core` и дожидается карточки «Первоначальная версия сайта сохранена» с `v0.0.0` и «Ожидает подключения» в списке | `apps/e2e/tests/site-import/held.spec.ts` |
| `b2` | FTPS с проверкой сертификата (CA стенда), пользователь `ftpsite`, без базы данных | `wizard.spec.ts` |
| `b3` | SSH по ключу RSA с парольной фразой и PostgreSQL с проверкой TLS | `wizard.spec.ts` |
| `b4` | Отказы шага остаются на шаге со своим текстом: неверный пароль (`auth_failed`); папка без WordPress (`not_site_root`), папка с WordPress уровнем ниже и кнопка «Подставить папку …», после которой проверка проходит; «Назад» сохраняет введённое; после пройденной проверки «Далее» новой проверки не шлёт, а правка поля — шлёт; ключ сервера сменился (второй ключ запасного хостинга): панель «Ключ сервера изменился» с новым отпечатком и только кнопка «Принять новый ключ»; неверный пароль базы на третьем шаге (`database_refused`). Ни один отказ не создал проекта | `wizard.spec.ts` |
| `b5` | Тот же запрос создания (тело, перехваченное у мастера) повторно возвращает тот же проект; тот же ключ запроса с другим адресом — `PROJECT_REQUEST_CONFLICT`; второго сайта, этапа и события нет. FTP без шифрования | `wizard.spec.ts` |
| `r1` | `kill -9` роли `core`, пока импорт скачивает файлы (запасной хостинг заморожен `docker pause`): этап молчит, через 120 с сборщик возвращает его в очередь (`enqueues` 2, вторая аренда), импорт проходит; один корневой коммит, один тег | `scenarios.mjs` |
| `r2` | SIGTERM роли `core` во время скачивания: этап отпущен в `queued`, `enqueues` 2, событие outbox доступно через ≈45 с; перезапущенный `core` его доводит | `scenarios.mjs` |
| `r3` | Тег пропал после публикации `main`: тег удалён в Gitea, этап вручную помечен `failed`, `siteConnection.retry` — тот же коммит снова под тегом, `main` тот же; хостинг не видел нового входа (`sitec` считается по журналу sshd): коммит взят из Gitea, не скачан заново | `scenarios.mjs` |
| `r4` | Чужой `v0.0.0`: тег перенесён на коммит другой ветки (Contents API), этап вручную `failed`, «Повторить» — `repository_mismatch`; тег и `main` не тронуты (без force и перетегирования); экран настройки показывает безопасный текст | `scenarios.mjs`, `setup.spec.ts` |
| `r5` | Хостинг отказывает в соединениях (`docker stop`): этап возвращается в очередь (`enqueues` 2) и ни разу не `failed`; хостинг снова работает — импорт проходит | `scenarios.mjs` |
| `r6` | Сайт создан при остановленном `core` (событие — ровно идентификаторы), пароль `siteb` сменён на хостинге: импорт `auth_failed`. В браузере «Повторить» снова останавливается, «Изменить доступ» с новым паролем — импорт проходит (тот же сервер: остаётся ключ, подтверждённый при создании, сверять его заново не просят); `credential_refs.key_version` стал 2 и равен текущей версии в OpenBao | `verify-site-import.mjs`, `setup.spec.ts` |

После браузерной половины и после сценариев восстановления каждый созданный сайт проверяется снаружи (`verifySite`): сайт `onboarding`; этап `succeeded` (у `r4` — `failed` `repository_mismatch`) с ожидаемыми `attempt` и `enqueues` и сводкой, равной манифесту (`files`, `bytes`, `skipped` по причинам); `site_initial_versions` — коммит `main`, `v0.0.0`, `imported_at`, файлы и байты; одна строка `git_repositories`; ссылки `credential_refs` с каноническими путями `kv/sites/<id>/<вид>` и `key_version`, равным `current_version` в OpenBao; строки `site_code_sources` (порт, папка, закреплённый ключ, защита FTP) и `site_databases`; события outbox этапа (`attempt:enqueues`) опубликованы и без payload; одна запись `site.create` в аудите; репозиторий `sites/site-<id>` приватный (без токена — 404), в нём ровно `main` и лёгкий `v0.0.0` (кроме чужой ветки `r4`), один коммит без родителя от `Raditi Bot <bot@raditi.ru>`, дерево — ровно файлы манифеста байт в байт (id блобов git).

В конце (`all`): ни одного секрета стенда — паролей, ключей и их строк, парольной фразы, паролей баз, ключей и солей `wp-config.php`, поддельного ключа AWS, токенов и SecretID — в `pg_dump` базы платформы, в каждом ключе и значении Redis (BullMQ), в каждом объекте git каждого репозитория `sites` (у сайта с входом по ключу `notes/leaked.txt` с паролями хостинга законно попадает в репозиторий), в журналах `core` и `next dev`; MySQL и PostgreSQL сайта с начала сценариев не получили ни записи, ни запроса к таблицам пользователя; оба хостинга байт в байт прежние; в OpenBao доступы ровно тех сайтов, на которые ссылаются `credential_refs`; не осталось захватов создания.

Весь прогон на Mac с Docker Desktop вместе со сборкой orchestrator занимает 3,5–4 минуты (два прогона подряд 17.10.2026: 227 и 200 с, по 47 проверок): подъём стенда — около 16 с, самопроверки — около 10 с, `next dev` с первой компиляцией страниц — около 20 с, браузерная половина (10 тестов) вместе с `r3`, `r4` — около 40 с, сценарии `r1`, `r2`, `r5` — около двух с половиной минут (`r1` ждёт сборщика: этап становится «молчащим» через 120 с после последнего пульса, сборщик ходит раз в минуту; в прогонах — 129–130 с). Если `next dev` для `apps/web` уже запущен кем-то другим (Next разрешает один на каталог приложения), стенд ждёт до 15 минут и пишет об этом строку.

## Что поднимается

| Сервис | Образ | Что внутри |
| --- | --- | --- |
| PostgreSQL платформы | `postgres:17.11-alpine3.24` (digest) | данные в tmpfs, пользователь `raditi`; миграции и сиды дерева применяются собственным конфигом Prisma стенда (конфиг репозитория загружает `.env`) |
| Redis | `redis:8.10.2-alpine` (digest) | пароль из файла, `noeviction`, без диска |
| S3 | `chrislusf/seaweedfs:4.47` (digest) | бакеты `raditi-siteimport-<run>-{inbox,sessions,logs,artifacts,backups,platform}`; роли `core` S3 обязателен: конфигурация разбирает его при старте, health проверяет четыре бакета |
| OpenBao | `ghcr.io/openbao/openbao:2.7.0` (digest) | dev-сервер; `bootstrapLocalVault` (`infra/vault/bootstrap.mjs`) создаёт `turns/`, `subs/`, `kv/`, `transit/` и девять политик; AppRole `web` — `sites-writer`, AppRole `core` — `core-turns`, `core-transit`, `core-site-import` |
| Gitea | `gitea/gitea:1.27.3-rootless` (digest) | HTTPS с CA стенда, организация `sites` (private); команда `bots` (write, все репозитории, code/pulls/actions) с ботом `raditi-bot` и его токеном `write:user`, `write:repository` (`GITEA_TOKEN`); команда `provisioners` (`can_create_org_repo`) с `raditi-provisioner` и его токеном `write:organization`, `write:repository` (`GITEA_PROVISIONER_TOKEN`) |
| Хостинги `site` и `spare` | `raditi-siteimport-server:<хеш>` из `Dockerfile` (Alpine 3.22 по digest) | OpenSSH 10: только SFTP (`internal-sftp`, chroot `/home/site`) для `site` (пароль и ключи), `siteb`, `sitec`; vsftpd 3.0.5: явный FTPS (`AUTH TLS`, сертификат CA стенда, `require_ssl_reuse=YES`) и обычный FTP для `site` и `ftpsite`, только пассивный режим на `127.0.0.1`. `spare` — тот же сервер для сценариев, которые меняют его на ходу (другой ключ, пауза) |
| MySQL сайта | `mysql:8.4` (digest) | база `wp_stand`, пользователь `stand` (его пароль — `DB_PASSWORD` в `wp-config.php` сайта), таблица `wp_posts` с одной строкой; TLS с сертификатом CA стенда; general log в `mysql.general_log` |
| PostgreSQL сайта | `postgres:17.11-alpine3.24` (digest) | база и пользователь `stand`, таблица `pages` с одной строкой; `ssl=on` с сертификатом CA стенда; `log_statement=all` |
| `core` | `node apps/orchestrator/dist/main.js` | `stand.core.start()`; окружение — `env.core` (ниже) |
| web | `next dev` в `apps/web` на `127.0.0.1` | `stand.web.start()`; окружение — `env.web`; своя группа процессов, журнал `logs/web.log` |

Порты — случайные свободные на `127.0.0.1`. У хостингов порты SSH, FTP и диапазон из десяти пассивных портов выбираются заранее и публикуются 1:1: vsftpd называет в ответе PASV адрес `127.0.0.1` и номер порта, который снаружи тот же. Ключ сервера SSH меняется без перезапуска контейнера: `useHostKey('second')` подставляет второй ключ и шлёт sshd `SIGHUP`.

Образ хостинга собирается один раз на содержимое `Dockerfile` и `server/` (тег — их хеш) и остаётся между запусками; для сборки нужен локальный `alpine:3.22` того же digest и сеть для `apk add`.

## Сайт на хостинге

Домашний каталог пользователей хостинга (chroot) содержит три папки: `public_html/` — сайт, который импортируют сценарии; `empty_root/` — папка без WordPress (`not_site_root`); `nested/public_html/` — WordPress на уровень ниже (подсказка корня). Дерево строит `fixture.mjs`: одни и те же байты в каждом запуске, кроме секретных значений (`newFixtureValues`).

В `public_html/` лежат ядро WordPress и медиа (настоящие JPEG и PDF) — они импортируются; `wp-config.php` с паролем базы и восемью ключами, `wp-config-sample.php`, `.htaccess`, кэш, `debug.log`, `backup.sql` — исключаются правилами адаптера; `.git/` (`vcs`) и `.github/` (`ci`); `old/` с `wp-content/` и `wp-includes/` — вложенная установка (`nested_site`); ссылка `link-to-config` на `wp-config.php` (`link`); `Кириллица/страница.html`. Три файла проверяют сканирование секретов: `notes/leaked.txt` содержит дословно пароли всех учётных записей хостинга, и тот, который получит `siteb` позже (отбрасывается сверкой точных значений доступа, если доступ — пароль; при входе по ключу его ничто не отбрасывает), `notes/db.txt` — `DB_PASSWORD` из `wp-config.php` (точные значения `wp-config.php`), `notes/aws.txt` — пару ключей AWS, которую находит Gitleaks.

`importManifest(values)` перечисляет каждую запись папки сайта с исходом (`take`, `skip` с причиной из `importSkipReasons` и записью, на которой решение принято, или `secret` с источником), `expectedImport(values, { auth: 'password' | 'key' })` — что должно оказаться в репозитории (путь, размер, id блоба git), чего там быть не должно и счётчики пропусков сводки этапа. `stand.test.mjs` сверяет манифест с правилами адаптера WordPress и политикой путей `packages/domain` — правка правил импорта без правки манифеста роняет `pnpm test:infra`.

## Что возвращает startStand

`startStand({ signal, log })` из `stand.mjs` поднимает стенд и возвращает объект:

- `env.core` — всё окружение роли `core`: `NODE_ENV=production` (чтобы не загружался `.env` репозитория), `APP_ENV=development` (адреса хостинга на loopback допустимы), `ORCHESTRATOR_ROLES=core`, база, Redis, S3, AppRole `core` (`VAULT_ROLE_ID`, `VAULT_SECRET_ID`), `GITEA_URL` по HTTPS, `GITEA_TOKEN`, `GITEA_PROVISIONER_TOKEN`, `GIT_CA_FILE` и `NODE_EXTRA_CA_CERTS` — CA стенда, `PATH` с Gitleaks 8.30.1 первым; Docker локального исполнителя и канал к `llm` указывают туда, где ничего не слушает;
- `env.web` — окружение `next dev`: каждое имя `.env.example` задано (пустое, если web оно не нужно — пустое значение считается незаданным, и `.env` разработчика ничего не добавит), AppRole `web`, CA стенда, `APP_ENV=development`, случайный `BETTER_AUTH_SECRET`, `APP_URL` — `http://127.0.0.1:<порт>`;
- `coordinates` — адреса, порты, пользователи и имена контейнеров каждого сервиса (`siteServer`, `spareServer` с отпечатками двух ключей в формате продукта `ssh-ed25519 SHA256:…`), папки сайта, `role_id` и файлы SecretID обеих AppRole, файлы токенов Gitea;
- `caPath`, `logsDir`, `directory` — CA стенда, каталог журналов (`core.log`, `web.log`, `playwright.log`), каталог запуска;
- `secrets` — то, что сценарий вводит: пароль, ключ ed25519 и ключ RSA с парольной фразой пользователя `site`, пароли `ftpsite`, `siteb` (и его будущий), `sitec`, доступы MySQL и PostgreSQL сайта;
- `fixture` — значения, дерево, манифест, `expected(auth)`, ожидаемые находки Gitleaks;
- `giteaApi` — `repository`, `repositories`, `branch`, `refs`, `tags`, `commit`, `tree` (рекурсивно), `raw`, `createFile` (коммит через Contents API, в пустом репозитории — первая ветка), `createTag` (лёгкий тег через API), `deleteTag` и `pushTag` (через git: API тегов знает только теги, которые Gitea уже перенесла в свою таблицу), `createRepository` (токеном учётной записи, которая создаёт репозитории), `deleteRepository`, `clone`, `gitEnvironment('bot' | 'provisioner')` и `request` для остального;
- `db` — `pool` и `query` клиента `pg` к базе платформы;
- `vault` — `operator` (root-токен dev-сервера), `login('web' | 'core')`, `request`, `metadata(path)`, `list(folder)`;
- `core` — `start({ overrides, wait })`, `stop()` (SIGTERM), `kill()` (SIGKILL), `health()`, `running()`, `log()`, `pid()`;
- `web` — `start({ waitMs, onWait })` (ждёт чужой `next dev` каталога `apps/web`), `stop()`, `origin`, `running()`, `log()`;
- `siteServer`, `spareServer` — `useHostKey`, `snapshot()` (каждая запись домашнего каталога с типом, размером, правами, временем и SHA-256), `logs()`, `logins(user)`, `setPassword(user, password)` (через stdin `chpasswd`), `pause()`, `unpause()`, `stopContainer()`, `startContainer()`;
- `siteDatabases.mysql.statements()` и `siteDatabases.postgres.statements()` — что сервер получил;
- `docker(args)`, `containerLogs(service)`, `redact(text)`, `secretValues()`, `hostingPasswords()`, `closeLater(fn)`, `stop()`.

`stop()` закрывает то, что отдали `closeLater`, останавливает `next dev` (всю его группу процессов) и `core`, закрывает клиент базы, удаляет контейнеры запуска (только с меткой этого запуска) и каталог запуска; повторный вызов ждёт первый. Если `startStand` падает, всё созданное к этому моменту удаляется, а в ошибке остаются журналы контейнеров (без секретов) для приватной диагностики.

Браузерная половина (`apps/e2e/playwright.site-import.config.ts`) получает файл `browserStand(...)`: адрес кабинета, cookie сессий пользователей (стенд регистрирует их сам через API `@repo/auth`, `accounts.mjs`), хостинги, доступы, адрес и токен управляющего сервера стенда (`control.mjs`: запустить `core`, сменить ключ запасного хостинга) и сайты, которые стенд сделал сам. Проект `held` — один `b1`, пока `core` остановлен; проект `wizard` — остальное параллельно, после `b1`. Трассировки выключены: в них остались бы введённые пароли; снимки экрана при сбое уходят в приватную диагностику.

## Самопроверки (`infra`)

1. База платформы: применены все миграции дерева, сиды записали тарифы.
2. OpenBao: AppRole `web` пишет `kv/data/sites/<id>/ssh` с CAS 0, второй такой записи отказано, прочитать обратно не может; AppRole `core` читает с версией 1, писать не может, `…/wp` не читает.
3. Gitea: токен `raditi-provisioner` создаёт `sites/selfcheck` — приватный, пустой, ветка `main`; токен бота создать репозиторий не может, без токена репозиторий не виден; бот пушит по HTTPS с CA стенда, токен — в `http.extraHeader` из окружения; работают коммит через Contents API (и первая ветка пустого репозитория), лёгкий тег, дерево, файл, клон.
4. SFTP: хостинг предъявляет ключ с отпечатком, который посчитал стенд; проверка без подтверждённого ключа на сервер не входит (в журнале sshd нет попыток входа); `site` входит по паролю, по ключу ed25519 и по ключу RSA с парольной фразой; неверный пароль и `ftpsite` не входят; второй ключ подставляется и убирается; бинарные файлы приходят байт в байт.
5. FTP: явный FTPS проверяется только CA стенда (без него — ошибка сертификата), обычный FTP для `ftpsite`, имена UTF-8, ссылки видны ссылками, данные идут на опубликованные пассивные порты `127.0.0.1`.
6. Дерево хостинга после проверок байт в байт прежнее.
7. Gitleaks 8.30.1 с конфигурацией продукта (`[extend] useDefault = true`) находит среди пропускаемых правилами файлов ровно `notes/aws.txt`.
8. MySQL и PostgreSQL сайта отвечают по TLS, проверенному CA стенда; по одной таблице; их журналы показывают присланные запросы, строк таблиц никто не читал.
9. Только с `--infra-only`: `core` из `apps/orchestrator/dist` стартует на стенде (AppRole `core`, `APP_ENV=development`): база, Redis, S3 и Vault — `ok`; останавливается по SIGTERM; секретов в его журнале нет.

`--infra-only` занимает около 30 секунд.

## Требования

- Локальный Docker: Docker Desktop на macOS, на Linux — Docker хоста; удалённые адреса Docker отклоняются.
- Уже загруженные образы (стенд их не скачивает и, если образа нет, называет команду):

  ```sh
  docker pull postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
  docker pull redis:8.10.2-alpine@sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0
  docker pull chrislusf/seaweedfs:4.47@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882
  docker pull ghcr.io/openbao/openbao:2.7.0@sha256:71156a1c6623a5fa3f5e61b0c6a8ead0faf0df29a778339188443551995d1315
  docker pull gitea/gitea:1.27.3-rootless@sha256:1c17ecaead42eb3b5391553d8708103a4beb0e86edf5b9ebc1eb269c318845f2
  docker pull mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb
  docker pull alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce
  ```

- Gitleaks 8.30.1: `P2_GITLEAKS_BINARY` (абсолютный путь) или `gitleaks` на `PATH`; `git`, `openssl`, `pgrep`, `lsof` (macOS).
- `pnpm install` и браузер Playwright (`pnpm --filter e2e exec playwright install chromium`): клиенты самопроверок — библиотеки продукта (`ssh2`, `basic-ftp`, `mysql2`, `pg` из `packages/site-connections`, `pg` из `packages/db`, `@aws-sdk/client-s3` из `packages/storage`).
- Свободный каталог `apps/web` для `next dev`: `pnpm dev` и браузерные прогоны других конфигов стенд дождётся, но не остановит.

## Уборка после `kill -9`

Обычный выход, ошибка и сигналы `SIGINT`, `SIGTERM`, `SIGHUP` убирают всё сами. Если процесс стенда убит принудительно, остаются контейнеры с меткой запуска, каталог `$TMPDIR/raditi-siteimport-<run>` и, возможно, процессы `core` и `next dev`. Следующий запуск стенда убирает их сам по записи `run.json` в каталоге запуска: контейнеры с меткой того запуска, процессы `core`, записанные в нём и работающие в его каталоге, `next dev`, записанный в нём, если он работает в `apps/web` на порту записи, и сам каталог — и печатает строку `SWEPT run <run> …`. Ничего не выбирается только по имени.

Вручную:

```sh
docker ps -a --filter label=io.raditi.siteimport-verify --format '{{.Names}} {{.Label "io.raditi.siteimport-verify"}}'
docker rm -fv <имена контейнеров>
rm -rf "$TMPDIR"/raditi-siteimport-<run>
# Образы хостинга прежних версий стенда (тег — хеш Dockerfile и server/):
docker images --filter label=io.raditi.siteimport-verify.image
docker rmi raditi-siteimport-server:<тег>
```

Диагностика упавшего прогона (без секретов: журналы `core`, `next dev`, Playwright и снимки экрана упавших тестов) остаётся в `$TMPDIR/raditi-siteimport-diagnostic-*/` с правами `0600` — путь печатается в строке `FAIL` или `LOGS`.

## Особенности

- Все клиенты приходят на хостинг с адреса шлюза Docker. Поэтому у sshd выключен `PerSourcePenalties`: OpenSSH 10 иначе наказывает соединения, которые только обмениваются ключами, — а первая проверка мастера делает именно это, — и закрывает вход всем.
- vsftpd 3.0.5 из Alpine не знает `utf8_filesystem`; имена файлов он передаёт байтами как есть, поэтому UTF-8 доходит без перекодирования.
- Gitea заполняет таблицы веток и тегов после push в фоне и до этого отвечает на `GET /branches/main` кодом 500, а на `DELETE /tags/v0.0.0` — 404; `giteaApi.refs` читает сам git, `deleteTag` и `pushTag` работают через git.
- Пока Gitea не обработала в фоне первый push, она считает репозиторий пустым, и ветка, созданная в это время, становится веткой по умолчанию. Тогда повтор импорта справедливо отказывает `repository_not_created`: ветка по умолчанию не `main`. Поэтому `r4` делает чужую ветку только после того, как Gitea сама видит `main` и репозиторий непустой.
- Один CA на все серверы стенда: сертификата, которому продукт не доверяет (`certificate_untrusted`), у стенда пока нет.
- `core` запускается из `apps/orchestrator/dist` дерева: проверяется та сборка, что лежит там сейчас.
- Пределы мастера (единицы проверок, отказы входа, проверки одновременно, три подключения в работе) считаются на пользователя: у каждого сценария и каждого отказа `b4` свой пользователь.
