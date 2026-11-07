# Стенд стеков сайтов: `verify:stack`

```sh
pnpm verify:stack                                  # все стеки, все их сборки, все написанные группы
pnpm verify:stack -- --group=import                # только группа import
pnpm verify:stack -- --group=preview               # import и preview: preview идёт на сайте import
pnpm verify:stack -- --build=joomla-5.4.10 --keep  # одна сборка, стенд остаётся поднятым до Ctrl-C
pnpm verify:stack -- --no-build                    # сборки копии и образы прошлого прогона; отказ, если дерево изменилось
```

Стенд ведёт настоящие выпуски CMS из `STACK_STANDS` (`stacks.mjs`) через настоящую платформу ([план 62](../../../docs/plan/62-site-stacks.md), Т66, §5.5; [срезы Э3](../../../docs/plan/62-slices/e3.md), Э3.10). Для каждой сборки поднимается синтетический «прод» с её версией CMS и SFTP-хостинг над его папкой, а вокруг — та же платформа, что у `verify:release`: web, `core`, `llm`, `mcp`, `preview` из сборки приватной копии дерева, Gitea с раннером выкладки, OpenBao, PostgreSQL, Redis, S3 и настоящий OpenCode на синтетическом Z.ai. `verify:release` не меняется: стенд берёт его сервисы, сборку копии и окружения процессов только чтением экспортов; ни один файл `infra/dev/release-verify` стенд не правит. Каждая строка `PASS` — факт, прочитанный из базы, Gitea, Docker или ответа продукта; строка `NOTE` — не проверка. В конце печатается таблица сценариев.

Только синтетические данные. Настоящий GLM, ключи, `.env` и dev-инфраструктура не используются; опции адреса, базы или ключа стенд отвергает. Ядра закрытой CMS плана 62 здесь нет: `STACK_STANDS` и `cms-archives.json` её не называют, `--stack` с её именем — отказ со списком стеков.

## Опции

| Опция | Что делает |
| --- | --- |
| `--stack=<стек>` | Стек из `STACK_STANDS`, повторяется. По умолчанию — все. |
| `--build=<id>` | Строка `cms-archives.json` (как у `fetch-cms.mjs`), повторяется. Сборка не выбранного стека — отказ. |
| `--group=<группа>` | Повторяется. Группа, которая не идёт ни на одной выбранной сборке, — отказ: иначе она прошла бы пусто. Группа, чьи сценарии ещё не написаны (`release` — Э3.12, `browser`, `safety`, `safety-browser` — Э8 и Э11), — тоже отказ; без `--group` такие группы не идут, стенд пишет о них строку `NOTE`. Группа приводит с собой ту, на чьих итогах идёт (`GROUP_NEEDS`): `--group=preview` включает `import`. |
| `--no-build` | Сборки копии и образы прошлого прогона; отказ, если дерево изменилось после них. |
| `--keep` | Стенд остаётся поднятым после сценариев (и после провала) до Ctrl-C. |
| `--runtime=runc\|runsc` | Среда ходов и предпросмотров `core`; по умолчанию `runc`. До Э3.13 опция до `core` не доходит (окружение ролей стенда выпуска — `runc`), поэтому `runsc` — отказ в проверке перед запуском: иначе прогон шёл бы под `runc` и выглядел доказательством. |

Какие группы идут на сборке, считает одна функция `groupsOf(stand, build, support)` в `stand.mjs`: `import`, `preview`, `release` — всегда; `browser` — когда стенд стека обходит панель (`walks`), стек открывает её и ветка сборки тоже; `safety` — когда у стенда есть его случаи; `safety-browser` — с обоими. `support` — `StackSupport` адаптера стека; его передают в `standOptions(argv, { supports })`. Ни один стек стенда панель пока не открывает, и стенд его не передаёт: это сделает Э8.

## Что нужно на машине

- macOS с Docker Desktop (хранилище образов containerd: digest локальной сборки даёт только оно), `git`, `rsync`, `openssl`, `pnpm`, Gitleaks 8.30.1 (`P2_GITLEAKS_BINARY` или `PATH`), Chromium и WebKit Playwright этого дерева (`pnpm --filter e2e exec playwright install chromium webkit`; WebKit нужен группе `preview`).
- Закреплённые образы — стенд их не скачивает (`--pull never`): те же, что у `verify:release` (`postgres`, `redis`, `chrislusf/seaweedfs:4.47`, `ghcr.io/openbao/openbao:2.7.0`, `gitea/gitea:1.27.3-rootless`, `gitea/runner:4.0.0`, `linuxserver/openssh-server` по digest, `mariadb:11.4.13` — команды `docker pull` в [README стенда выпуска](../release-verify/README.md)), и основы `php@sha256:…` строк `infra/preview/site-bases.json` для версий PHP выбранных сборок (`docker pull <image>` строки).
- Архивы CMS стенд берёт сам: `fetchCmsArchive` для выбранных сборок в `RADITI_CMS_DIR` (без переменной — `$TMPDIR/raditi-cms`), сверка по сумме строки; повтор ничего не скачивает. Скачанное дерево только копируется в том «прода» и исполняется внутри его контейнера.
- Mac не должен засыпать: `caffeinate -i -s pnpm verify:stack`.

## Что поднимается

Всё одноразовое, со своим именем `raditi-stack-verify-<run>-…` и меткой `io.raditi.stack-verify=<run>`:

- PostgreSQL, Redis, SeaweedFS, OpenBao с AppRole на процесс, сертификаты стенда — `startPostgres`, `startRedis`, `startS3`, `startOpenbao`, `createCertificates` стенда выпуска с именами `stackNames(run)` (та же форма, что `standNames`, своя метка).
- Gitea 1.27.3, зеркало loopback и раннер выкладки `deploy` на образе `core` этого дерева — `startGitea`, `startMirror`, `startRunner`; сверх них — учётная запись `raditi-provisioner` в команде `provisioners` организации `sites` (создаёт репозитории и только), её токен — `GITEA_PROVISIONER_TOKEN` у `core`, как у `verify:site-import`.
- На каждую сборку — своя сеть, тома и два контейнера (`buildNames`): «прод» — образ `site` версии PHP сборки, точка входа `prod/entry.sh`, MariaDB внутри (пароль — файлом `/prod-secrets/db`, на stdin), сайт на `http://localhost:<порт>`, база на другом порту loopback; SFTP-хостинг стенда выпуска (`startHosting`) над томом папки документов. Стек ставит свою сборку сам (`install` записи стека: установка без браузера, наполнение синтетикой, удаление установщика).
- Образы: образы стенда выпуска (`STACK_BUILT_IMAGES` — песочница, шлюз, правила хоста, инструменты и браузер предпросмотра, `core`) под метками `raditi-stack-verify/*:local` и образ `site` на каждую версию PHP выбранных сборок (`raditi-stack-verify/preview-site:<версия>-local`, аргументы — `siteImageBuildArgs`, как у `verify:site-images`). Сборка `php-base` ходит в интернет (установщик, PECL, apt), если её слоёв нет в кеше.
- Приложения `llm`, `mcp`, `preview`, `core` и web из сборки приватной копии дерева (`$TMPDIR/raditi-stack-verify-build` или `STACK_VERIFY_BUILD_DIR` вне репозитория): копия строится так же, как у `verify:release` (`lockCopy` из `verify-billing.mjs`, удаление устаревших файлов и опустевших каталогов — `staleFiles`, `staleDirectories`, `keptFolder`), файлы самого стенда (`infra/dev/stack-verify/`) в копию и в метку сборки не входят: правка стенда не требует пересборки для `--no-build`. Поэтому ни одна сборка пакета или образа не читает эту папку. Окружения — `roleEnvironment` и `webEnvironment` стенда выпуска, `APP_ENV=test`; `core` поверх получает `GITEA_PROVISIONER_TOKEN`, Gitleaks первым в `PATH`, `SANDBOX_DEPLOYMENT=stack-<run>` (Э0и) и `PREVIEW_SITE_IMAGES` выбранных версий (`stackCoreEnvironment`).
- Синтетический Z.ai (`startFakeModel`) и аккаунт плана с профилями и ставками (`switchOnModel`). Владелец регистрируется через web (`signUpOwner`), его личное рабочее пространство класса `synthetic` — штатной `ensurePersonalWorkspaceWithGift`, тариф «Агентство» — `grantTariff`.

## Группа `import`

Сайт создаёт настоящая процедура: `project.create` клиентом `trpcClient` стенда импорта с cookie владельца — стек записи, источник SFTP хостинга сборки с закреплённым ключом, база MySQL прода на loopback (`tls: 'plain'`). Импорт ведёт настоящий `core` с настоящим сканером. Строк импорта стенд не пишет.

| Сценарий | Что проверяется |
| --- | --- |
| I1 импорт | `project.create` — `created`; этап `code_import` — `succeeded`; сайт `active`, стек записи; `stack_facts`: версия и ветка сборки, `limit` пуст, а сверх них — что называет `factsOf(build)` записи (у Joomla папка панели и `extras.sitename`); тег `v0.0.0` на единственном коммите `main` |
| I2 дерево | `main` содержит `markersInRepository(build)` (у Joomla 4.0 и новее — два класса ядра с `Configuration` в имени, которые правила импорта не должны срезать) и не содержит `absentFromRepository` (конфигурация, установщик, журналы, кеш, `.htaccess`); на сборках, где `scannerFinds(build)` записи это говорит, сканер снял хотя бы один файл (`summary.skipped.secret` больше нуля), а импорт пошёл дальше; строка `NOTE` — `summary.skipped` этапа как есть (у Joomla сканер снимает файлы `libraries/vendor` на 4.4.14, 5.4.10 и 6.2.0 — Т48 называл 5.4 и 6.2, §10 плана 62, Э3.10; число не закрепляется) |
| I5 версия | раз на стек, на хостинге первой сборки: дерево `refusedVersion` записи (у Joomla — три метки и манифест 2.5.28) — `project.create` отвечает `source_refused`, `version_unsupported`, сайта не пишет. У стека без `refuseBelow` `refusedVersion` — `null`, и I5 не идёт |
| I4 раскладка | раз на стек: дерево `refusedLayout.files` записи (у Joomla — метки, манифест, конфигурация с драйвером MySQL и `defines.php`: причина отказа одна — `defines.php`) — проект создан, этап `failed` с `layout_unsupported`, `stack_facts.limit` — `refusedLayout.limit` (`outside_root`), сайт `onboarding`, проект не удалён |
| I3 секреты | последней, после отказов: значения `secrets(prod)` записи (у Joomla — `$password`, `$secret`, `$smtppass` конфигурации), пароль базы и пароль хостинга не найдены ни в одном объекте git всех репозиториев `sites`, ни в дампе PostgreSQL, ни в ключах и значениях Redis, ни в выводе `core` и web. Каждое место ищется один раз на все сборки, строка — на сборку. Контроль в том же поиске: имя файла, который есть в каждом репозитории, — в объектах git, id каждого сайта — в дампе PostgreSQL и выводе `core`, ключи очереди `bull:site-import:` — в Redis, `Next.js` — в выводе web; среди просканированных репозиториев — репозиторий сайта каждой сборки |

I5 идёт перед I4: отказ не пишет сайта, и I4 берёт тот же адрес `http://127.0.0.1:<порт прода первой сборки>` (`project.create` отвергает повтор адреса у одного владельца). I3 идёт после них: пароль хостинга проходит и через проверки SFTP веток отказа.

Объекты git ищутся потоком `git cat-file --batch-all-objects --batch` каждого зеркала: хранилище объектов CMS больше 8 МиБ вывода, которые держит помощник `repositoryObjects` стенда импорта. Дампы PostgreSQL и Redis — его помощники `databaseDump` и `redisDump`, без маскирования вывода.

## Группа `preview`

Идёт за `import` на том же сайте каждой сборки и без него не запускается. Диалог открывает владелец (`task.create`); первый ответ сценарной модели держит гейт `waitFor` (`fake-model.mjs`), пока предпросмотр диалога не `ready`, — это предусловие стенда, не проверка. Ход — только `browser_navigate` (`browserTurn`): главная, закрытые пути `browserPaths.closed` записи стека, открытый `browserPaths.open`, затем ответ без изменений.

| Сценарий | Что проверяется |
| --- | --- |
| P1 готов | `preview_environments`: `ready`, ревизия 0, основа диалога; `runtime.web` — образ `site` версии PHP сборки; `unavailable_reason` пуст; запись несёт `seedTablesLeftOut` и `seedColumnsEmptied`, на чистой поставке оба 0 |
| P2 витрина | Вход по билету `preview.ticket` и куке шлюза: главная 200 с `x-raditi-preview: 1`, страница `page(build)` по ЧПУ 200 с её текстом; на обеих нет `Fatal error`, `Warning:`, ссылки на `localhost:<порт прода>` и канонической ссылки не на `origin` предпросмотра (`pageProblems`). Контроль: прод даёт обеим страницам каноническую ссылку на свой адрес (у Joomla — `params.domain` плагина `plg_system_sef`, который ставит установка стенда, а политика копии очищает). На сборках, где сканер снял файлы при импорте (`scannerFinds`), это и есть витрина без них (Т48) |
| P3 копия | `copyChecks(sql)` записи, строка на проверку, SQL от root сокета предпросмотра (`PREVIEW_ROOT_QUERY`). У Joomla: авторы на `@preview.invalid`; `contact_details` и `user_profiles` пусты; черновика нет, опубликованная статья есть; `plg_system_cache` нет; строка плагина SEF одна, её `params` — валидный JSON, `domain` пуст, а ключ, который установка стенда пишет рядом (`raditiStandKept`), на месте (`JOOMLA_SEF_SQL`) |
| P4 браузер агента | По телу последнего запроса хода к синтетическому Z.ai: `browser_navigate /` открыл главную (200); каждый путь `browserPaths.closed` (у Joomla `/administrator/`, `/configuration.php`) — отказ `BROWSER_PATH_DENIED`; контроль — `browserPaths.open` (картинка `images/`) открыт (200); ход не упал, диалог `awaiting_user` |
| P5 кадр (М2к) | Строка на сборку и движок: Chromium и WebKit. Страница кабинета (`frame.mjs`) — ответ самого браузера на адрес `APP_URL` стенда (`http://127.0.0.1:<порт web>`, маршрут Playwright), кадр с `PREVIEW_SANDBOX` и без referrer, вход — настоящий шлюз и билет `preview.ticket`. Контроль межсайтовости: кука из скрипта без атрибутов в кадре не живёт (Chromium запрещает кадру `document.cookie` — тоже «не живёт»), во вкладке того же предпросмотра живёт; иначе строка не считается. Затем вход в панель по `signIn(build)`: стенд ставит автору копии свой случайный пароль и права суперпользователя (`setPassword`, SQL от root: копия хранит случайный хеш), сначала контроли: на форме нет метки панели `signedIn`, а неверный пароль оставляет форму и текст из `lostCookie` (у Joomla — `JLIB_LOGIN_AUTHENTICATE`) без метки; затем верный пароль: форма из кадра ушла, метка `signedIn` есть (у Joomla 4.0 и новее `#sidebarmenu` — `#header` Atum есть и на странице входа), кадр на панели, текстов из `lostCookie` (потерянная кука, токен, отказ в пароле) нет; строка `NOTE` — имена кук предпросмотра, без значений |
| Pc закрытие | Диалог сборки закрыт `task.cancel`, как его закрывает владелец: `core` убирает предпросмотр (`destroyed`), браузер агента и песочницу хода — в Docker нет контейнера, сети или тома с метками сайта. Иначе уборка стенда сняла бы то, что принадлежит `core`, и прогон провалился бы |

WebKit не знает `--host-rules` и на `http://*.localhost` не держит куку шлюза с префиксом `__Host-` (замер 07.11.2026, WebKit 26.6: кука с одним `Secure` живёт, с префиксом — нет). Поэтому WebKit идёт через пересыльщик `startSecureForwarder` на loopback: он принимает `CONNECT` только к `*.localhost` на порту шлюза, завершает TLS сертификатом стенда (браузер — с `ignoreHTTPSErrors`), шлёт запрос шлюзу как браузер — в форме пути, с Host предпросмотра — и меняет `http://<хост предпросмотра>` на `https://` в `Location` и текстах ответа; простой `http://` предпросмотра получает 301 на `https://`. Настоящий Safari остаётся ручной проверкой (Т69).

## Как не мешает соседям

Своя метка и свои имена, порты — `freeLoopbackPort`, своя копия сборки, `SANDBOX_DEPLOYMENT=stack-<run>`: `core` другого дерева, который несёт Э0и, песочницы стенда не трогает. Временные базы дампа предпросмотров (`io.raditi.staging`) этой меткой защищены только с Э9.4. Рядом нельзя: `verify:release`, `verify:pipeline` (раннеры одноразовых Gitea путают контейнеры заданий) и другой прогон `verify:stack` на том же демоне. Уборка — как у `verify:release`: процессы, синтетический Z.ai, раннер, затем контейнеры, сети и тома по метке прогона и по меткам сайтов прогона, тома заданий по uuid раннера; в конце — проверка, что ничего не осталось. Логи упавшего прогона (с маскированием) — `$TMPDIR/raditi-stack-verify-logs-<run>`.

После `kill -9`:

```sh
docker rm -f -v $(docker ps -aq --filter label=io.raditi.stack-verify)
docker network rm $(docker network ls -q --filter label=io.raditi.stack-verify)
docker volume rm $(docker volume ls -q --filter label=io.raditi.stack-verify)
rm -rf "$TMPDIR"/raditi-stack-verify-run-* "$TMPDIR"/raditi-stack-verify-build.lock
```
