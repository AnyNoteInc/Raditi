# Тесты, CI и окружение: что значит «доказано» для нового стека

Клон `raditi-stacks`, ветка `feat/site-stacks` = `main` `c811abf1`, 01.11.2026. Код не менялся. Замерено на этой машине (`docker`, `gh run`) или прочитано в отчётах; всё остальное помечено «оценка». Сведения о CMS — из первичных источников, раздел 10.

## 1. Итог

1. **Сейчас «доказано» — это лестница из девяти ступеней**, и только у WordPress она пройдена целиком (раздел 2). Новому стеку нужны не все ступени: ступени сети предпросмотра, снимков, биллинга и песочницы от CMS не зависят, повторять их на каждую CMS бессмысленно. Минимальный набор на CMS — раздел 8: образ, рецепт на копии базы, плагин, выпуск по SFTP, импорт по мастеру, короткий проход `verify:release`, один проход под `runsc`.
2. **Самая дорогая часть проверок — не стенды, а установка настоящей CMS и решение о контентном инструменте.** Стенды привязаны к WordPress слабо: в трёх главных файлах `verify:release` стековых строк 78 из 4 222 (`scenarios.mjs` — 30 из 2 461, `stand.mjs` — 35 из 1 289, `setup.mjs` — 13 из 472), плюс блок установки сайта в `services.mjs`; в `isolation.mjs` их нет, а `verify:site-import` не запускает CMS вообще. Зато `wp_rest` назван в продуктовом коде `apps/mcp/src/content/*` и `apps/mcp/src/access/mcp-policy.ts`: пока нет решения, чем агент правит контент Joomla или MODX, сценарии S1, S3, S8 и `verify:mcp-content` спроектировать нельзя.
3. **Матрица образов — не 4 CMS × версии PHP.** Образ `site` различается только версией PHP, а CMS приходит деревом и рецептом (`PREVIEW_SITE_IMAGES` ключуется версией PHP, `preview-config.ts:181-201`, `preview-builder.ts:342-349`). Если заменить основу `wordpress@…` на нейтральную `php:<версия>-apache` с объединением расширений, образов будет шесть на все CMS, а разбор переменной и `core` не меняются (раздел 5). Основа `wordpress` не годится уже сейчас: у неё нет `pdo_mysql`, без которого MODX не работает, и нет тегов PHP 7.4–8.1.
4. **Битрикс нельзя вести теми же путями.** Лицензия (п. 4.8) запрещает копировать и распространять программу и сайты на её основе, демо-версия — только для ознакомления и на 30 дней (п. 1.8, 6.3), копия для разработки и тестирования — без внешнего доступа (п. 4.2). Настоящего ядра не может быть ни в репозитории, ни в образе GHCR, ни в кеше GitHub Actions. Значит, в CI у Битрикса только синтетическое дерево, а настоящий проход — локально на дистрибутиве вне репозитория. Тот же п. 4.2 — вопрос к самому предпросмотру Битрикса на публичном адресе, с открытым интернетом: это юристу.
5. **Ни один workflow не идёт под `runsc`, а прогона настоящего WordPress под gVisor нет ни в одном отчёте**: `preview.docker.integration.test.ts` зашил `runtime: 'runc'` (`:209`, `:224`, `:652`), рецептный набор идёт обычным `docker run`, стенды выпуска и браузера отказывают не на Docker Desktop (`verify-release.mjs:278`, `verify-browser-task.mjs:77`). Для новой CMS это не наследуется автоматически: под gVisor образ `site` проверен только на маленьком `index.php`.
6. **Два тяжёлых стенда нельзя гнать рядом с `feat/chats-first` на одном Docker Desktop**: у песочниц одна метка владельца на все развёртывания (`packages/sandbox-providers/src/docker.ts:42,75,482`), и чужой `core` с `TURN_EXECUTOR=local` удаляет их раз в 30 с. Интеграционные наборы в Docker от этого не страдают, и их можно вести на отдельном демоне (раздел 7).

## 2. Лестница: что сегодня считается доказанным

Время — последние записанные прогоны; «CI» — длительность workflow по `gh run list`, 26–30.10.2026.

| № | Ступень | Чем проверяется | Что именно доказывает | Время | Где идёт |
| --- | --- | --- | --- | --- | --- |
| 0 | Адаптер | `packages/site-adapters/src/wordpress*.test.ts` (4 731 строка тестов на 3 141 строку кода), `import-rules.test.ts`, `registry.test.ts` | Импорт, рабочий набор, защищённые пути, политика копии, MCP и браузера как чистые правила | секунды | `pnpm gates`, job `gates` |
| 1 | Образ `site` | `infra/preview/site.test.mjs` (статично); `packages/sandbox-providers/src/preview/runtime.integration.test.ts`; `pnpm verify:preview-network` | Службы под своими uid, база, ссылки отклоняются, сеть закрыта со всех сторон, у каждой «закрытой» цели есть контроль | CI: шаг наборов 57–81 с, сеть 69–70 с | `preview.yml`; сеть — ещё Colima `runc` и `runsc`, 48 из 48 |
| 2 | Рецепт на настоящей CMS | `wordpress-preview.integration.test.ts`, 8 случаев | WordPress 7.1.2 read-only от `www-data`: адрес предпросмотра вместо прода, нет почты и cron, файлы платформы закрыты, «не готов» без настроек | в том же шаге | `preview.yml` |
| 3 | Копия базы | `mysql-copier.integration.test.ts` + `wordpress-policy.fixture.json` | Правило 1: в семени нет строки вне политики, значения байт в байт, отказы | в том же шаге | `preview.yml` |
| 4 | Предпросмотр целиком | `apps/core/src/previews/preview.docker.integration.test.ts`, 4 случая | Прод → копия → `main` → кандидат с операцией БД → запись дерева идущего хода → уничтожение | 46–50 с | `preview.yml`, только `runc` |
| 5 | Плагин и контент | `wordpress-db.integration.test.ts` (8 случаев, MariaDB 11.4 и MySQL 8.4); `pnpm verify:mcp-content` (34 PASS) | Все виды операций плана БД, ограждение; снимок до записи, повтор, откат, квитанции, точность хранения | контент ~73 с; CI 2 мин | Набор БД — **ни один workflow**; контент — `wordpress-content.yml` |
| 6 | Выпуск | `apps/core/src/deploy-step/deploy.integration.test.ts`, 5 случаев; `pnpm verify:release` | Файлы по SFTP, запись плагином, проверка, возврат; затем весь путь чат → `/release` | CI 3 мин; стенд 660–866 с со сборкой, 710 с `--no-build`, 2 132 с с холодным кешем | `release-deploy.yml`; стенд — только Docker Desktop |
| 7 | Импорт и мастер | `pnpm verify:site-import`, 47 проверок | Мастер, SFTP, FTP(S), Gitea, тег `v0.0.0`, восстановление, ни одного секрета в базе, Redis, логах и git | 200–227 с | локально; Docker Desktop и Linux |
| 8 | Браузер задач | `pnpm verify:browser-task`, 13 сценариев, 110 проверок | Вход клиента, политика админки, дубликаты, секреты входа | 344–391 с | только Docker Desktop |

Не зависят от CMS и новой работы на стек не требуют: `verify:vault` (кроме путей `wp`, раздел 6), `verify:db` (кроме новой миграции перечисления), `verify:gitea`, `verify:pipeline`, `verify:llm-*`, `verify:opencode*`, `verify:runner`, `verify:snapshots`, `verify:images`, `verify:edge`, `verify:billing`. Ещё две проверки стоит не размножать: `verify:site` (основа WordPress, импортирует `wordpressAdapter` и его политику, `verify-site.mjs:15-21`, workflow нет, её заменяет ступень 2) и `verify:agent-content` (58 с, CI 5–10 мин): она доказывает договор CLI ↔ `sandbox-gw` ↔ `mcp`, а не стек — достаточно одной строки `ROWS`, и только если у стека другой контентный инструмент.

`pnpm verify:site-connect` и `connect-local.mjs` — WordPress-only подготовка стенда (M4); стенды новых CMS пишут сайт строками сами, как `verify:release` (`verify-release.mjs:585-595`).

Браузерные наборы `test:site` (49 проверок) и `test:billing` (23) к стеку привязаны тонко: `stack: 'wordpress'` в строках (`apps/e2e/tests/site/site.ts:20,60`, `apps/e2e/fixtures/credits.ts:209`), синтетический WordPress мастера (`apps/e2e/fixtures/site-files.ts:41-43`) и текст тарифа «один сайт на WordPress» (`plans.spec.ts:157`, `manage.spec.ts:281`), который рождается в `apps/web/src/components/billing/plan-format.ts:109-112`. Этот текст придётся сделать нейтральным при подключении первой новой CMS, вместе с `pricing.tsx:228`, пятью строками лендинга и тремя юридическими документами (`public-offer.md`, `user-agreement.md`, `privacy-policy.md`): это задевает `test:billing`, `test:landing`, `verify:billing` и редакции документов. В CI оба набора не входят.

### Дыры лестницы, которые есть уже у WordPress

- `wordpress-db.integration.test.ts` и `packages/sandbox-providers/src/preview/staging.integration.test.ts` не запускает ни один workflow: шаг `preview.yml:150-153` называет четыре других файла. Контракт `ci.test.mjs:407` проходит, потому что проверяет переменную и фильтр путей, а не сам запуск файла. Новый `<cms>-db.integration.test.ts` окажется в той же дыре.
- Прогона настоящей CMS под `runsc` нет ни в одном отчёте (итог, п. 5).
- Собирается и проверяется только образ PHP 8.3 (раздел 5).
- Сборка под `amd64` у образа `site` проверена только на GitHub-раннере; на выпускной реестр он не попадает.

## 3. Что в стендах привязано к WordPress и что потребуется

Подсчёт строк — вхождения `wp-`, `/wp/`, `wp_`, `.wp(`, `WordPress`, `post_title`, `blogdescription`.

### `verify:preview-network` (`infra/dev/preview-verify`)

Привязки почти нет: свой рецепт и один `index.php` (`verify-preview-network.mjs:211-246,386`), от WordPress — только digest основы (`:27-29`, `:260-264`). На каждую CMS не повторяется. Нужно одно: прогон на каждом образе PHP (параметр образа вместо сборки `8.3-local`), когда образов станет несколько.

### `verify:site-import` (`infra/dev/site-import-verify`)

Самый дешёвый стенд: импорт не запускает CMS, он читает файлы. Сценарии нейтральны (0 стековых строк из 767), привязка — `fixture.mjs` (58 строк: дерево, ключи `wp-config.php`, `WP_SECRET_NAMES`), `infra-checks.mjs:318-411` (имена файлов в самопроверке хостинга), `scenarios.mjs:164` (`stack: 'wordpress'`), база `wp_stand` и тексты `wizard.spec.ts:97-114`.

Для CMS нужна синтетическая фикстура, а не установка: дерево с `rootMarkers` адаптера, конфигурация с секретами, файлы, которые импорт обязан пропустить, манифест. Что положить в секретный файл каждой CMS: Joomla — `configuration.php` (`$password`, `$secret`, `$smtppass`), OpenCart — `config.php` и `admin/config.php` (`DB_PASSWORD`), MODX — `core/config/config.inc.php` (пути `core` и админки можно переименовать, а `core` — вынести из корня: эта раскладка должна быть в фикстуре), Битрикс — `bitrix/.settings.php`, `bitrix/php_interface/dbconn.php`. Сценарии восстановления `r1`–`r6` от стека не зависят: на CMS достаточно одного прохода `b2`-образного сценария и `verifySite` с параметром `--stack` (оценка: +40–60 с на CMS).

В `bitrix.ts:53-58` записан известный дефект: маркер `bitrix` слишком слаб для вложенной проверки корня. Фикстуре нужна папка шаблона с вложенным `components/bitrix/`, иначе стенд его не поймает.

### `verify:release` (`infra/dev/release-verify`)

Привязка собрана в нескольких местах:

- `stand.mjs:27-37` — образы; `:429-435` — окружение `WORDPRESS_*`; `:736` `themeFiles()`; `:749` медиа; `:757` `REPOSITORY_EXCLUDES`; `:720` ловушка отмены в `mu-plugins`; `:795` `MODEL_TURNS` с `wp_rest` и маршрутами `/wp/v2/*`;
- `services.mjs:484-595` — установка, WP-CLI, ожидания по файлам `wp-includes/version.php`;
- `setup.mjs` — `installProductionSite`, плагин в `wp-content/mu-plugins`, доступы;
- `scenarios.mjs` — 19 вызовов `site.sql` с `wp_posts`, `wp_options`, `wp_users` и 2 `site.wp`;
- `verify-release.mjs:518,590` — `getSiteContentAdapter('wordpress')` и `stack: 'wordpress'`.

Остальное — Gitea, раннер, `deploy-step`, OpenBao, S3, контроль сети (`isolation.mjs`), деньги — нейтрально. Выделяется объект стека: образы и установка; пути темы, подвала и стиля; прочитать и поменять заголовок и настройку прода; файлы-ловушки «ломает только прод»; `REPOSITORY_EXCLUDES`; ходы сценарной модели. Для CMS нужен не весь стенд: S1, S2 (без атак — они проверяют образ и сеть), S4, S5 и S6, а S8 и S9 — только где адаптер объявляет эти виды операций.

Сломанный на проде подвал (S5) зависит от константы предпросмотра: `generatedFiles` рецепта обязан давать CMS такой же признак, иначе сценарий не отличит прод от предпросмотра.

### `verify:browser-task` (`infra/dev/browser-task-verify`)

`site.mjs` (262 строки), три плагина в `fixture/mu-plugins` (перехват cookie входа, предел загрузки, медленная публикация), 22 строки `scenarios.mjs` и 6 строк `programs.mjs` (`wp-login.php`, `wp-admin/edit.php`, таблицы). Сайт доступен под именем `wp.raditi.test` через `BROWSER_LOCAL_SITES`, эта механика нейтральна.

Браузерная ступень — отдельная: пока у стека нет политики `SiteAdapter.browser*`, её и не надо проходить. Но есть дыра: `siteCapabilities` (`packages/trpc/src/services/site-capabilities.ts:70-84`) не смотрит на стек и скажет `browser: 'ready'` любому сайту на `https`, а `bitrixAdapter.browserTaskPolicy` бросает `notImplemented`. Включение стека в `connectableStacks` без политики браузера даст падение, а не отказ. Нужна проверка и тест до подключения первой новой CMS.

### `verify:mcp-content` и `verify:agent-content`

Стенд контента привязан сильнее всех: `content-fidelity.mjs` (396 строк) и `content-permissions.mjs` (289 строк) проверяют поведение фильтров WordPress, `apps/mcp/scripts/verify-content-*.mjs` — протокол плагина, `compose.yml` — переменные `WORDPRESS_*`. У CMS свои правила: фильтр HTML редактора, права ролей, транзакции (MyISAM в старых таблицах), кеш страниц. Переносится только каркас: PostgreSQL, S3, OpenBao, роль `mcp`, журнал. Проектировать стенд можно после решения о контентном инструменте.

### Контракты на `wp` в Vault и базе

Вид доступа `wp` — это перечисление `siteAccessKinds` (`packages/domain/src/ports/site-adapter.ts:95`, тест `:16`), `CredentialKind` в Prisma (`schema.prisma:465-474`), политики `core-release.hcl:5`, `mcp-content.hcl:2,8`, `bootstrap.test.mjs:88,90,120` и `verify-local.mjs:403,630,633,887,975,1040,1483,1526`. Новый стек — или новые виды доступа на CMS с миграцией и правкой всего этого списка, или один нейтральный вид. Нейтральный вид оставляет три строки `path`, виды на CMS дают пятнадцать; выбирает проект, а тесты идут за решением.

Перечисление стеков: `siteStacks` (`site-adapter.ts:26`), `enum SiteStack` (`schema.prisma:310`), `packages/db/src/enums.test.ts`, `stackLabels`, `z.enum(siteStacks)` в манифесте выпуска (`deploy-manifest.ts:391`). Манифест строгий: `core` и образ задания выкладки должны быть одного выпуска — в репозитории это уже условие (`infra/app/README.md`).

## 4. Как получить установленный сайт в стенде

Стенды ничего не тянут сами (`--pull=never`, CI тянет по digest). У образов CMS есть образец: `site-import-verify` собирает образ хостинга один раз, тег — хеш содержимого (README, «Хостинг»), а `infra/preview/Dockerfile:75` берёт файл по `ADD --checksum`. Так же стоит собирать прод стенда: `php:…-apache` по digest + архив CMS по sha256.

| CMS | Лицензия | Откуда | Установка без браузера | На arm64 | Что учесть |
| --- | --- | --- | --- | --- | --- |
| Joomla 5.4 / 6.2 | GPL | Docker Official: `joomla:5.4.10-php8.3-apache`, `6.2.0-php8.3-apache` | Переменные `JOOMLA_SITE_NAME`, `JOOMLA_ADMIN_*`, `JOOMLA_DB_*` образа или `php installation/joomla.php install` (с 4.3) | да | Официальные теги 5.x — PHP 8.2–8.3, 6.x — 8.3–8.5. `dbtype` бывает `mysqli` и `pdomysql`, а у `site` нет `pdo_mysql`. Стартовая страница без данных пуста — нужны материалы в начальной фикстуре |
| OpenCart 4.1.0.4 | GPL-3 | Официального образа нет (404 в `docker-library`). Bitnami перенёс публичный каталог в замороженный `bitnamilegacy` (про OpenCart отдельно не подтверждено), на него не опираемся. Архив релиза GitHub по sha256 | `php install/cli_install.php install --username … --http_server … --db_*`: проверяет PHP ≥ 8.0, gd, curl, `mysqli`, `iconv` или `mbstring`, openssl; переписывает `config.php` и `admin/config.php`, которые должны существовать | любая, основа `php` | Каталог после установки пуст — товары сидом. `install/` удалить после установки. ocStore и ветка 3.x — другой код, в этой разведке не проверялись |
| MODX 3.2 | GPL-2 | Официального образа нет (404). Архив с modx.com по sha256, который фиксируем сами | `php setup/index.php --installmode=new --config=<xml>` (`config.dist.new.xml`) | любая, основа `php` | Требует PHP ≥ 8.1 и `pdo_mysql`, в CLI-установку идёт XML с паролями — писать файлом `0600`. Страницы живут в базе, не в файлах: тема агента — `chunks`/`templates` в БД, стенду нужен плагин, а не правка файла |
| 1С-Битрикс | Собственная, EULA от 27.05.2025 | Демо «encode» с 1c-bitrix.ru: `.zip`, `.tar.gz`, `BitrixSetup` | Официальной CLI-установки не нашёл: мастер через веб. Автоматизируется Playwright или HTTP-запросами к мастеру (оценка: минуты). Снимок базы и файлов допустим только вне репозитория | не проверено | Минимум по странице загрузки: PHP 8.2, MySQL 8.0 — а у нас MariaDB 11.8 в `site`. Хостеры требуют `sql_mode=''` и `innodb_strict_mode=0` (не официальный источник) — в рецепте флагов базы нет (`init.sh:193-195`), но можно задать файлом `after_connect_d7.php`. Демо — 30 дней |

Снимок базы как способ ускорить стенд не нужен Joomla, OpenCart и MODX: у них CLI-установка секунд на десятки (оценка), а `wp core install` стенды и так делают при каждом запуске. Снимок нужен только Битриксу.

**Битрикс и лицензия** (`eula_bus.pdf`, ред. 27.05.2025; это чтение разведчика, а не заключение юриста):

- п. 1.8: демо «исключительно для целей самостоятельного ознакомления, оценки и проверки»; п. 6.3.2: по истечении срока использование прекращается.
- п. 4.2: временная установка на дополнительный компьютер — только для разработки, тестирования и наполнения Сайта, «при условии отсутствия любого „внешнего“ доступа к ней», и копия немедленно удаляется.
- п. 4.8: нельзя «копировать, распространять Программу и ее компоненты, а также созданные на базе Программы Сайты, в любой форме».
- п. 6.4: NFR-лицензия при согласии 1С-Битрикс допускает разработку и тестирование для себя, без продажи и отчуждения.
- п. 8.3: деобфускация и снятие ограничений — ответственность; поэтому продление демо правкой ядра, которую советуют на форумах, исключено.

Следствия для проверок: ядра нет в git, образах, GHCR, кеше Actions и артефактах; в CI — только синтетическое дерево; настоящий стенд — локально, на дистрибутиве по абсолютному пути вне репозитория, в отдельной переменной стенда. Контракт `ci.test.mjs:407` требует, чтобы каждую переменную-включатель задавал workflow, поэтому такая переменная пойдёт в исключения `elsewhere` с причиной — как `RADITI_LLM_FIREWALL_PACKET_TEST`. Стартовый дистрибутив — NFR, если 1С-Битрикс её выдаст; до тех пор Битрикс считается недоказанным.

## 5. Образы `site`

**Что есть.** `infra/preview/Dockerfile:8` — `ARG BASE=wordpress@sha256:8ae7…`; цель `site` (`:48-86`) добавляет MariaDB 11.8.9, WP-CLI 2.12.0, Node, tini и `init.sh`, `run-as.sh`, `forward.mjs`, `dns.mjs`. WordPress из `/usr/src/wordpress` не используется: дерево приходит томом, а рецепт запускает `apache2-foreground` (`wordpress-preview.ts:108`). Размер (`docker image ls`, arm64): образ 1,42 ГБ, основа 1,12 ГБ, `php:8.3-apache` 724 МБ. Замер: PHP 8.3.35, Debian trixie.

**Чего нет.** Основа — без `pdo_mysql`, `pgsql`, `soap`, `ldap`, `gmp`, `bz2`, `calendar`, `xsl`, `apcu`, `redis`, `memcached` (замер `php -m`). Для MODX `pdo_mysql` обязателен. Отсутствие остальных предпросмотр покажет клиенту через `previewRuntimeMatch` (`packages/domain/src/preview/runtime-match.ts`) строкой о различии, но страницы, им зависящие, упадут.

**Собирается только PHP 8.3**, хотя рецепт называет семь версий (`wordpress-preview.ts:18`): `preview.yml:136-137`, `stand.mjs:70-72,621`, `verify-preview-network.mjs:264`. В плане 58 (стр. 133) задумано семь образов, а в его итоге (стр. 233) записано как недоказанное: «у `wordpress:7.1.2` нет тегов PHP 7.4–8.1». Основа `wordpress` эту матрицу собрать не может в принципе.

**Варианты матрицы.**

| Вариант | Образов | `PREVIEW_SITE_IMAGES` | Минусы |
| --- | --- | --- | --- |
| А. CMS × PHP на родных основах | около 20: Joomla 2 ветки × 2–3 PHP, OpenCart 3, MODX 3, Битрикс 3, WordPress 4 | Ключ `<стек>:<версия>`: правка `parsePreviewSiteImages`, `preview-builder.ts`, `config.test.ts`, `stand.test.mjs:222`, README | Основ Битрикса, OpenCart и MODX нет; цена сборки, диска и пинов в 3–4 раза выше; `init.sh` и Dockerfile размножаются по неродным дистрибутивам |
| Б. Нейтральная основа `php:<версия>-apache` с объединением расширений | 6: 7.4, 8.1, 8.2, 8.3, 8.4, 8.5 (8.0 — вопрос владельцу) | Без изменений: `8.3=…,8.2=…` | Образ шире нужного любой одной CMS: `previewRuntimeMatch` не покажет лишнего, код сайта может пройти там, где на хостинге расширения нет. Надо проверить совпадение с WordPress: `imagick` — через PECL на каждой версии |

**Рекомендация — Б.** Различия CMS уходят в рецепт: `web.command`, `configFiles`, `generatedFiles`, `settings`, `content`. Схема рецепта это держит: файлов до 16 по 192 КиБ, конфигураций сервера до 8 по 64 КиБ (`recipe.ts`). Исключения, которые надо учесть:

- WP-CLI остаётся в образе и не мешает; своей CLI-обвязки образ другим CMS не даёт: `cliArgv` рецепта — это `php <скрипт>`, и скрипт — файл `generatedFiles`.
- `preview-apache.conf` выключает `.htaccess`, «поэтому правила WordPress здесь» (`:5-6`): у каждой CMS своя конфигурация с правилами ЧПУ, иначе в предпросмотре откроется только главная. Это отдельная проверка рецепта. Правила из `.htaccess` конкретного сайта в предпросмотр не попадут.
- База — только MariaDB 11.8.9. `recipe.database` допускает `postgres`, а копировальщика PostgreSQL нет (`@repo/site-connections/database-copy` — только `mysql`): Joomla на PostgreSQL и Битрикс «Энтерпрайз для PostgreSQL» будут `unavailable`, это надо сделать явным отказом и тестом.
- ionCube: платные модули PHP-магазинов нередко кодируются им (из опыта, замера нет). Если ставить загрузчик, это проприетарный бинарник в образе; по умолчанию — нет, различие покажет «Проверки». Нужен ли он демо-дистрибутиву Битрикса «encode», не проверено.

**Закрепление digest.** Сейчас digest основы WordPress повторён в `Dockerfile:8`, `release-verify/stand.mjs:27-28`, `verify-preview-network.mjs:28-29`, `verify-site.mjs:24-25`, `verify-site-connect.mjs:54`, `preview.yml`, `release-deploy.yml`, `wordpress-content.yml` и трижды в `ci.yml:116-124`. Для нескольких версий нужна таблица одним файлом, например `infra/preview/site-bases.json` (версия → digest `php`, Debian), которую читают стенды и контракт, а сборка получает `--build-arg BASE=`. PHP 7.4, 8.0 и 8.1 из `docker-library/official-images` уже убраны (проверено 01.11.2026): их digest заморожены, обновлений безопасности нет. Предпросмотр изолирован и живёт недолго, но `php:7.4` стоит на bullseye: срок LTS Debian 11 истёк в 2026 году (из памяти, проверить сборкой), и `apt-get` Dockerfile может потребовать `archive.debian.org`.

**Локальная сборка.** Digest локальной сборки есть только в хранилище containerd (`infra/preview/README.md:28`); на Mac это Docker Desktop по умолчанию. Mac — arm64, выпуск — amd64: стендам на Mac нужен только свой образ 8.3, остальные версии CI собирает нативно. QEMU не нужен.

**Цена сборки.** Замер: шаг «Build the images of previews» — 131–141 с на шесть образов, из них `site` без компиляции. У нейтральной основы компиляция `gd`, `intl`, `zip`, `bcmath`, `exif`, `pdo_mysql`, `mysqli`, PECL `imagick`: оценка 4–8 мин на версию на раннере без кеша, с кешем GHA — минута-две. Диск песочной ВМ: шесть образов по 1,2–1,4 ГБ при частично общих слоях — 6–8 ГБ (оценка), это место в расчёт ВМ M10 ещё не заложено.

**Выпуск.** Образов `site` в `publish-images.yml` нет, как и `tools`, `browser`, `network-guard`, `gateway`, `watchdog`, `client-egress` и образа песочницы. Добавить в его матрицу нельзя: `ci.test.mjs:965-983` требует, чтобы цели `runtime` были ровно `apps/*/Dockerfile`, а прочая цель — только `migrate`, `images.env` пишет одну переменную на образ (`publish-images.yml:158-169`), а `PREVIEW_SITE_IMAGES` — это карта. Нужен отдельный workflow (`publish-preview-images.yml`) со своим контрактом и строкой `PREVIEW_SITE_IMAGES=…` в `images.env`. Пока это не блокирует: `PREVIEW_EXECUTOR=runner` не реализован (`preview-builder.ts:96,101`), production требует его (`apps/core/src/config/config.ts:559-562`), то есть предпросмотров в production нет до M10. В `infra/app/env.example` переменной нет, а `compose.test.mjs:623-628` разрешает наложению добавить `core` только адрес предпросмотров: туда придётся вписать и образы. Зеркала — `crane copy` с сохранением digest (`infra/app/README.md:197`): Docker Hub отвечает 403 для российских адресов, это касается и основ `php`.

## 6. Что затронет новый код: CI, окружение, контракты

### Workflow и фильтры путей

Любая правка `packages/site-adapters/**` (там будут адаптеры и вшитые плагины) запускает: `ci`, `preview`, `release-deploy`, `wordpress-content`, `agent-content` по имени и `images`, `billing`, `llm-app` по `packages/**`. Замер: 10–15, 7–29, 3, 2, 5–10, 10–16 и 4–11 минут (`llm-app` не мерил) — примерно час раннера на push уже сегодня, это цена, а не блокер.

| Файл | Что менять | Контракт, который упадёт или промолчит |
| --- | --- | --- |
| `ci.yml:109-124`, job `gates` | `php -l` на плагины новых CMS; на нижней поддерживаемой версии PHP, а не только на 8.3: плагин работает на PHP хостинга | `ci.test.mjs:760-782` читает только `infra/wordpress` и требует ровно три файла: новые каталоги он **молча пропустит**. Надо обобщить |
| `preview.yml:117-153` | Новые основы, образы PHP, наборы `<cms>-preview` и `<cms>-db`. Предел job — 60 мин, запас есть | `ci.test.mjs:407` пройдёт и без запуска файла. Нужен новый контракт: каждый файл под переменной назван в шаге workflow; он сразу поймает две имеющиеся дыры |
| `release-deploy.yml:15-28,50-62` | Плагины CMS в фильтре, образы, набор deploy-step на CMS | Фильтр называет один файл `infra/wordpress/raditi-content.php` |
| `wordpress-content.yml` | Не трогать | `ci.test.mjs:581-718`: `siteImages.length === 4`, список pull равен образам стендов, `runs` — ровно два шага. Новый стенд контента — только новым workflow |
| `agent-content.yml` | Нет | Фильтр уже содержит `packages/site-adapters/**`, `infra/wordpress/**` |
| `images.yml`, `verify-images.mjs` | Нет: образы `site` здесь не живут, `APPS` — только приложения (`:16`). Если появится новый пакет — добавить в `FORBIDDEN_PACKAGES` (`:25`) | Фильтр не содержит `infra/preview/**` |
| `publish-images.yml` | Нет, отдельный workflow (раздел 5) | `ci.test.mjs:953-1019` |
| Новый `site-stacks.yml` | Матрица `stack: [joomla, opencart, modx]`, `fail-fast: false`, `pull_request` с фильтром своего стека. Битрикса нет | `ci.test.mjs:254` (пути существуют), `:273` (скрипты существуют), `:407` (переменная задана) |
| Новый `site-images.yml` | Матрица PHP: сборка, `php -m` против списка, старт контейнера | Фильтр: `infra/preview/**`, `infra/app/ci.test.mjs` |

Стенды `verify:release`, `verify:browser-task`, `verify:site-import`, `verify:site`, `verify:gitea`, `verify:pipeline`, `test:site` и `test:billing` в CI не идут (grep по `.github/workflows`), поэтому ступени 6–8 проверяются только руками. Причины у первых двух устройственные: сеть заданий держится на прокси портов Docker Desktop (README стенда, «Сеть заданий выкладки»).

### Окружение

- `.env.example` и `turbo.json globalEnv`: при варианте Б новых переменных продукта нет, `PREVIEW_SITE_IMAGES` остаётся. Комментарий `.env.example:186-190` верен и после смены основы.
- Переменные стендов (`RELEASE_VERIFY_BUILD_DIR` и подобные) в `.env.example` не объявляются (П58). Новый включатель набора — другое дело: он попадает в `.env.example`, `globalEnv` и под `ci.test.mjs:407`. Проще оставить `RADITI_PREVIEW_DOCKER_TESTS` и `RADITI_HOSTING_DOCKER_TESTS`.
- `scripts/check-env.mjs` проверяет только направление `.env.example` → `globalEnv`.
- `infra/app`: `docker-compose.yml` и `docker-compose.preview.yml` образов предпросмотра не называют, `env.example` — тоже; `images.test.mjs` и `verify-images.mjs` смотрят только на `apps/*/Dockerfile`. До M10 менять нечего; в M10 — `PREVIEW_SITE_IMAGES` и прочие `PREVIEW_*_IMAGE` у `core` и правка `compose.test.mjs:623-628` (раздел 5). `SANDBOX_IMAGE` там уже есть: `infra/app/env.example:57`.
- `infra/preview/.dockerignore` — белый список: каждый новый файл образа добавляется, `site.test.mjs` проверяет его строкой. `site.test.mjs:63` требует `ARG BASE=wordpress@sha256:` — смена основы правит этот тест.
- `turbo.json:171-187` (`tasks.test.inputs`): если тесты адаптера читают `infra/<cms>/*` (как `wordpress-preview.test.ts` сверяет вшитые файлы), файлы надо назвать там. `ci.test.mjs:798-851` перечисляет известные файлы и новые не ищет: забытый вход даст зелёный результат из кеша turbo после правки плагина.
- `packages/site-adapters/scripts/embed-wordpress-files.mjs` с жёстким списком (`:20-25`) и `wordpress-preview-files.ts`: образы приложений не содержат `infra/`, поэтому плагины каждой CMS вшиваются строками. Скрипт нужно обобщить, а сверку `wordpress-preview.test.ts:46` повторить на каждую CMS.
- `infra/dev/docker-compose.yml`: профиль `site` (`:157-214`) — один WordPress для `pnpm dev`. Для ручной работы с другими CMS нужны свои профили; стендам они не нужны.
- `infra/sandbox/Dockerfile:23` ставит `php-cli` и `composer`: проверки агента внутри песочницы идут на PHP Debian. Имя `raditi/sbx-wordpress` (`.env.example:272`, `infra/app/env.example:57`) историческое, образ нейтрален.
- `php_lint` кандидата идёт в CLI-контейнере предпросмотра (`apps/core/src/previews/preview-checks.ts:131`), то есть на PHP образа: нейтрально.

### Правила dependency-cruiser, gates, Sonar

- `check-architecture` идёт только по `apps packages` (`package.json:14`): `infra/<cms>` и PHP он не видит, правил не заденет.
- Код в `packages/site-adapters/src/` новых правил не требует: это слой адаптеров, он импортирует только `domain` (`adapters-depend-on-domain-only`, `.dependency-cruiser.cjs:108`). Общий PHP-код нескольких CMS (`php-config.ts`, `php-hosting.ts`) там и лежит.
- `site-connections` и `sandbox-providers` импортировать `site-adapters` не могут (то же правило): копировальщик получает политику параметром, проверка корня — маркеры через зависимость (`packages/site-connections/src/services.ts:18-19`). Новые проверки CMS идут тем же путём.
- **Новый пакет не нужен и дорого стоит:** слой в `ADAPTERS` или `SERVICES` (`:9-14`, иначе `no-unclassified-package`), `*-minimal-packages` у `llm`, `mcp`, `preview`, `runner`, `browser`, списки `FORBIDDEN_PACKAGES`, фильтры путей нескольких workflow. Образы — каталог `infra/preview`, не пакет.
- `web` импортирует `@repo/site-adapters` (`apps/web/src/server/site-connections.ts:4`), `web-no-role-runtime` этому не мешает; но вшитые плагины четырёх CMS окажутся в серверной сборке web. Объём мал (сейчас 110 КиБ на WordPress), запрещающего правила нет.
- `pnpm format:check` — `prettier --check .`, а `.prettierignore` не исключает `infra/dev/**`: чужое дерево CMS с `css`, `js`, `json`, закоммиченное как фикстура, сломает `gates`. Деревья не коммитить: синтетические собирать кодом (как `fixture.mjs`), настоящие получать на стенде.
- `pnpm test:infra` — маска `infra/*/*.test.mjs infra/dev/*/*.test.mjs` (`package.json:26`): тесты глубже одного уровня не соберутся.
- **Sonar.** `.sonarcloud.properties:22`: `infra/wordpress/**`, `infra/preview/**`, `packages/sandbox-providers/**` и `packages/site-connections/src/**` анализируются, `packages/site-adapters/**` — нет. Новые `infra/<cms>/**` без правки списка анализироваться не будут: код, который пишет в базу клиента, надо добавить, а файл читается с ветки по умолчанию, то есть действует после слияния. Цена: `raditi-content.php` — 1 420 строк, с файлами предпросмотра 1 739; четыре CMS — около 7 000 строк PHP (оценка) в общий на организацию план 50 000. Текущий расход не узнал: MCP вернул пустые меры. `infra/dev/**` не анализируется, `**/*-fixture.mjs` — тестовый код.

## 7. Время, машины, соседство

### Где что можно гнать

| Что | Docker Desktop (`runc`) | Colima `gvisor` (`runc`) | Colima (`runsc`) | CI |
| --- | --- | --- | --- | --- |
| Наборы `*.integration.test.ts` через `createDockerPreviewRuntime` | да | да, `SANDBOX_DOCKER_SOCKET` | да, `PREVIEW_RUNTIME=runsc` (только `runtime.integration.test.ts`) | `runc` |
| `preview.docker.integration.test.ts` | да | не проверялось | нет: `runtime: 'runc'` в коде | `runc` |
| `wordpress-preview`, `wordpress-db`, `deploy.integration` | да | через `DOCKER_HOST`, не проверялось | нет: обычный `docker run` | `runc`; `wordpress-db` не идёт |
| `verify:preview-network` | да | да, стенд внутри ВМ | да, 48 из 48 | `runc` |
| `verify:mcp-content`, `verify:agent-content`, `verify:site-import` | да | Linux-Docker поддержан, в Colima не проверялось | нет | первые два — `runc` |
| `verify:release`, `verify:browser-task` | да, только здесь | отказ | отказ | нет |
| `verify:opencode`, `verify:opencode-supervisor`, `verify-runner` | да | да | да, это их смысл | `runc` |

Машина: Docker Desktop 29.8.2, arm64, 10 CPU, 23,4 ГиБ; Colima `gvisor` 29.5.2, aarch64, 4 CPU, 8 ГиБ. Чтобы рецепт CMS прошёл под gVisor, нужен новый набор через `createDockerPreviewRuntime` с настоящей CMS: это малая правка — вынести `runtime` из `preview.docker.integration.test.ts` в переменную окружения (`PREVIEW_RUNTIME`, как у `runtime.integration.test.ts`).

Что gVisor может сломать у CMS (проверить, а не предполагать): `innodb-use-native-aio=0` уже учтён в `init.sh`, `PidsLimit` поднят до 128 (`infra/preview/README.md:47`). Битрикс и OpenCart тяжелее WordPress по файлам, и файловая система gVisor на дереве в десятки тысяч файлов может замедлить холодный старт и `files.mjs`; срок готовности предпросмотра надо замерить.

### Сколько это идёт

Минимальный набор на CMS из раздела 8 (оценка по близким шагам): образ — 1 мин на версию с кешем; рецепт на копии — 1,5–2 мин; плагин — 1–2 мин; deploy-step — 1–2 мин; импорт — 1 мин; короткий `verify:release` — 6–8 мин с `--no-build` (полный 19-сценарный — 11,8 мин, S1–S7 первого состава занимали около 6 мин); `runsc` — 3–4 мин. Итого на CMS 15–20 мин локально, на четыре CMS последовательно — около часа с четвертью. В CI, в матрице: 6–8 мин на стек параллельно.

### Рядом с `feat/chats-first`

Состояние на момент разведки: на Docker Desktop работают `raditi-dev-*` и `raditi-db-verify` (идёт `verify:db` другой сессии), в Colima `gvisor` лежат образы `raditi-chats-*`. Похоже, что вторая ветка занимает оба демона.

| Что мешает | Причина | Что делать |
| --- | --- | --- |
| Чужой `core` с `TURN_EXECUTOR=local` удаляет песочницы | Метка владельца `raditi` одна на все развёртывания (`docker.ts:42,75,482`); `TurnReconciler` (`apps/core/src/turns/turn-reconciler.ts`) раз в 30 с убирает то, чего нет в его базе | `verify:release`, `verify:browser-task`, `pnpm dev` и `pnpm e2e` — по очереди. Настоящее лечение — метка развёртывания: небольшая правка, полезная обеим веткам |
| Одна копия сборки | `$TMPDIR/raditi-release-verify-build`, `raditi-browser-task-verify-build`, `raditi-billing-verify-build`, замок `lockCopy` | Задать `RELEASE_VERIFY_BUILD_DIR`, `BROWSER_TASK_VERIFY_BUILD_DIR`, `BILLING_VERIFY_BUILD_DIR` на дерево. Без этого стенд другой ветки упрётся в замок или соберёт чужое дерево |
| Общие теги образов | `raditi-release-verify/*:local`, `raditi-preview-*:local`: последний сборщик переставляет тег, а `--no-build` возьмёт его digest | Сборка рядом недопустима; после чужой сборки — без `--no-build` |
| Раннеры Gitea | `verify:pipeline` и `verify:release` путают контейнеры заданий | Не рядом |
| Фиксированные порты | web :3100/:3110, подделка ЮKassa :4110, OpenBao :4210, core :8181, mcp :8182, `verify:edge` :18080…; `verify:preview-network` на 8090 находит свободный | `test:site`, `test:billing`, `e2e` — по одному на машину |
| Сон Mac | Стенды считают время по часам | `caffeinate -i -s` |
| Память | Предел контейнера предпросмотра один на все стеки: 2 CPU, 2 ГиБ, 512 процессов (`previewContainerLimits`, `preview-builder.ts:126`), PHP и база делят его; браузер — ещё 1,5 ГиБ; Desktop 23,4 ГиБ | Два тяжёлых стенда рядом нежелательны. Предел надо проверить на Битриксе и OpenCart: рецепт им не управляет |

Безопасно рядом: наборы Docker с уникальными именами (`raditi-r5b-…`), чистые тесты, `test:infra`, `check-architecture`. Самый чистый вариант — отдельный профиль Colima под эту ветку (`colima start stacks`): свой демон, ни чужих `core`, ни чужих тегов; `runsc` ставится как в `gvisor` (`docs/plan/03-p2-verification.md`). В нём идут ступени 1–5 и `runsc`; на Docker Desktop остаётся только `verify:release` по договорённости об окне.

## 8. Минимальный набор на CMS

Принцип: каждая проверка должна уметь упасть по причине, которой нет у других. Поэтому сеть, снимки, деньги и песочница не повторяются, а установка идёт настоящая и строка «копия базы поднимает сайт» стоит в центре: позволенный список таблиц легко отрезает то, без чего CMS не стартует, и это не видно ни на полной базе, ни на чистых тестах.

| № | Проверка | Файл (новый) | Что ловит | Joomla, OpenCart, MODX | Битрикс |
| --- | --- | --- | --- | --- | --- |
| М0 | Чистые тесты адаптера | `<cms>*.test.ts` | Маркеры, импорт, защищённые пути, рабочий набор, политика копии, сверка вшитых файлов. Объём у WordPress — 1,5 строки теста на строку кода | CI | CI |
| М1 | Образ на каждой версии PHP | `infra/preview/site.test.mjs`, `site-images.yml` | `php -m` равен списку, `init.sh` стартует, база отвечает | CI, один раз на все CMS | CI |
| М2 | **Прод → копия по политике → предпросмотр** | `<cms>-preview.integration.test.ts` | Настоящая CMS, read-only корень, uid 33, `generatedFiles`, база из копировальщика: сайт отвечает с адресом предпросмотра, ЧПУ работают, нет почты и cron, файлы платформы закрыты, в копии нет людей и секретов | CI | Локально |
| М3 | Плагин: операции и ограждение | `<cms>-db.integration.test.ts` | Каждый вид операции адаптера, снимок и возврат, отказ старой эпохи, запись под правами пользователя плагина | CI, и назвать файл в шаге | Локально |
| М4 | Выкладка | параметр `deploy.integration.test.ts` | Файлы по SFTP, запись, проверка сайта, откат сломанного выпуска, кеш кода CMS | CI | Локально |
| М5 | Мастер и импорт | `verify:site-import --stack=<cms>` | Маркеры на настоящем SFTP, секреты конфигурации не ушли в git, пропуски манифеста | локально | локально, синтетическое дерево |
| М6 | Короткий выпуск | `verify:release --stack=<cms> --only s1,s2,s4,s5,s6` | Ход, кандидат, предпросмотр, `/release`, возврат, конфликт с правкой владельца: весь шов | локально, Docker Desktop | локально, на лицензии |
| М7 | Под gVisor | М2 с `PREVIEW_RUNTIME=runsc` в Colima | Что сломает `runsc`: файловая система, `pdo`, время старта | локально, на каждую смену образа | локально |

М0–М5 и М7 не требуют решения о контентном инструменте, кроме М3: если для CMS нет контентного инструмента, у плагина только операции выпуска. М6 в первой итерации может идти без правки контента: агент меняет файлы шаблона через `bash`, план БД пуст. Такой проход уже доказывает путь файлов и `/release`, а операции БД добавляются вместе с адаптером: S8 — там, где `dbOperationKinds` не пуст.

Браузерная ступень (`verify:browser-task`, сценарии входа, закрытых экранов и черновика) нужна только стеку с политикой браузера; до этого — отказ в `siteCapabilities` и тест на него. `verify:mcp-content` в полном составе нужен только тому стеку, где агент правит опубликованное содержимое инструментом. Настоящий GLM — один проход `--live` после гейта владельца, как у WordPress; настоящий сайт клиента запрещён правилом 1.

**Условие включения в `connectableStacks`:** М0–М6 зелёные на Docker Desktop под `runc`, М7 прошёл хотя бы один раз, в отчёте записано, какие виды операций стек объявляет и что не проверено. Битрикс — только на дистрибутиве с законным основанием (вопрос 1).

**Порядок.** Сначала Joomla: есть официальный образ, CLI-установка и ключи `ADMIN_*`, поэтому на ней обкатывается объект стека в стендах, новый workflow и нейтральная основа. Затем OpenCart (файловые шаблоны, CLI-установка) и MODX (содержимое в базе, `pdo_mysql`). Битрикс — последним.

**Сначала, для всех:** перенести `wordpress-db.integration.test.ts` и `staging.integration.test.ts` в workflow; контракт «каждый файл под переменной назван в шаге»; нейтральная основа `site` с прогоном всей регрессии WordPress (`verify:preview-network`, `verify:release`, Docker-наборы `preview.yml`): смена основы — главный риск регрессии для единственного рабочего стека; вынести `runtime` из `preview.docker.integration.test.ts`; проверка стека в `siteCapabilities`; обобщение `php -l` и `embed-wordpress-files.mjs`.

## 9. Вопросы владельцу и юристу

1. **Битрикс для проверок.** Получить у 1С-Битрикс NFR-лицензию (п. 6.4 EULA) или партнёрский ключ? По умолчанию: до её получения Битрикс в проде не подключается, настоящего ядра нет в репозитории, образах и CI, локальный стенд использует дистрибутив вне репозитория.
2. **Битрикс в предпросмотре — юристу.** Копия ядра клиента на серверах Радити по публичному адресу, с открытым интернетом, в репозитории Gitea или томе: совместимо ли это с п. 4.2, 4.3 и 4.8? Адаптер сейчас исключает `bitrix/` из импорта (`bitrix.ts:18,43-44`), а предпросмотру нужно дерево целиком (`requiredPaths`, `no_core`). По умолчанию: до заключения предпросмотра Битрикса нет, доступен только путь «браузер» или правка файлов `/local/` без запуска.
3. **Основа образа.** По умолчанию — нейтральная `php:<версия>-apache` с объединением расширений, шесть образов, ключ `PREVIEW_SITE_IMAGES` не меняется.
4. **Список PHP.** По умолчанию 7.4, 8.1, 8.2, 8.3, 8.4, 8.5; 8.0 — ближайшая соседняя версия, а рецепт WordPress продолжит её называть: `siteImage` выберет первую из имеющихся. Для 7.4 и 8.1 digest заморожены, обновлений нет: держать ли их?
5. **Какие версии CMS считаем поддержанными.** По умолчанию — проверяем по одной актуальной ветке: Joomla 5.4 и 6.2 отдельным проходом М2, OpenCart 4.1, MODX 3.2. OpenCart 3.x, ocStore и MODX 2.8, которых на российском рынке много, — нет, пока не будет такого клиента. Подтвердить или расширить.
6. **Условие включения стека.** По умолчанию — раздел 8. Готовы ли принять, что `verify:release` на CMS остаётся локальным, как у WordPress?
7. **CI.** По умолчанию — два новых workflow с фильтрами (`site-images.yml`, `site-stacks.yml`) и отдельный `publish-preview-images.yml`, а `wordpress-content.yml` не трогаем.
8. **ionCube в образе.** По умолчанию — нет, показываем отсутствие в «Проверках».
9. **Соседство с `feat/chats-first`.** По умолчанию — отдельный профиль Colima для наборов, окно на Docker Desktop для `verify:release` и отдельная маленькая правка: метка развёртывания у песочниц.

## 10. Источники

- Docker Official Images: [library/joomla](https://raw.githubusercontent.com/docker-library/official-images/master/library/joomla), [описание образа joomla](https://raw.githubusercontent.com/docker-library/docs/master/joomla/content.md), [library/php](https://raw.githubusercontent.com/docker-library/official-images/master/library/php); `library/modx` и `library/opencart` — 404 (01.11.2026).
- Joomla: [CLI Installation](https://docs.joomla.org/J4.x:Joomla_CLI_Installation).
- OpenCart: [cli_install.php](https://raw.githubusercontent.com/opencart/opencart/master/upload/install/cli_install.php), [релизы](https://github.com/opencart/opencart/releases).
- MODX: [CLI install](https://docs.modx.com/3.x/en/getting-started/installation/cli), [Server Requirements](https://docs.modx.com/3.x/en/getting-started/server-requirements).
- 1С-Битрикс: [страница загрузки](https://www.1c-bitrix.ru/download/cms.php), [EULA, ред. 27.05.2025](https://1C-Bitrix.ru/download/law/eula_bus.pdf). Настройки базы — [Timeweb](https://timeweb.com/ru/docs/virtualnyj-hosting/cms/ustranenie-oshibok-cms-bitriks/), не официальный источник.
- Bitnami: [письмо о переносе каталога](https://www.eclipse.org/lists/tractusx-dev/msg00667.html), [заметка Rafay](https://docs.rafay.co/blog/2025/09/04/important-update-changes-to-bitnami-public-catalog/).
