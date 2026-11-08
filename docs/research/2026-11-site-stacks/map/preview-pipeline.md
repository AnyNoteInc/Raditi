# Конвейер предпросмотра: как он работает и что нужно другим CMS

Клон `raditi-stacks`, ветка `feat/site-stacks`, коммит `c811abf1`. Код не менялся. Дата — 01.11.2026.

Короткие имена файлов: `preview-*.ts`, `site-sources.ts`, `database-settings.ts`, `previews.providers.ts` — `apps/core/src/previews/`; `runtime.ts`, `containers.ts`, `staging.ts` — `packages/sandbox-providers/src/preview/`; `mysql-copier.ts`, `sql.ts`, `policy-sql.ts`, `nested-secrets.ts` — `packages/site-connections/src/database-copy/`; `recipe.ts`, `ports.ts`, `runtime-match.ts`, `preview-config.ts`, `preview-secrets.ts` — `packages/domain/src/preview/`; `wordpress-*.ts`, `bitrix.ts`, `php-hosting.ts`, `registry.ts` — `packages/site-adapters/src/`; `init.sh`, `run-as.sh`, `Dockerfile`, `files.mjs` — `infra/preview/`; `preview-*.conf`, `*.php` — `infra/wordpress/`; `previews.ts`, `tasks.ts` — `packages/trpc/src/services/chat/`; `site-database-dump.ts` — `packages/trpc/src/services/`; `config.ts` в разделе 8 — `apps/core/src/config/`.

Метки достоверности: **код** — прочитано, ссылка путь:строка; **замер** — выполнено здесь в одноразовом контейнере Docker без сети (arm64, Docker Desktop 29.8.2); **источник** — внешний документ или файл на GitHub (список в конце); **по памяти** — не проверено, сверить до реализации.

## 1. Главное

1. **Ядро конвейера почти нейтрально к CMS.** `preview-builder.ts`, `runtime.ts`, `containers.ts`, `init.sh`, шлюз `apps/preview` и копировальщик названий WordPress не знают. Привязка сидит в пяти местах: образ `BASE` с WP-CLI, рецепт адаптера, политика копии, файлы `infra/wordpress`, домен объектов контента (`post|page`).
2. **MODX на нынешнем образе не запустится вообще: в нём нет `pdo_mysql`** (замер). `pdo_mysql` есть в списке расширений документации MODX 3, а его доступ к базе идёт через PDO (по памяти — xPDO). Joomla с `dbtype=pdomysql` и OpenCart с PDO-драйвером упрутся в то же.
3. **`BASE` от WordPress заменяется на `php:<x.y>-apache` без потерь.** Из образа WordPress реально используются семь расширений, два файла ini, модули Apache и пакеты ghostscript и libheif (раздел 5). Заодно это открывает PHP 7.4–8.1: у `wordpress:7.1.2` таких тегов нет, поэтому версии из `wordpress-preview.ts:18` сейчас без образа (план 58, §11).
4. **Главное препятствие — копия базы, а не образ.** Схема политики рассчитана на девять таблиц WordPress: максимум 64 правила, только точные имена таблиц, `match` по одной колонке, колонка из правила обязана быть в таблице. У Битрикса таблицы создаются на каждый инфоблок, а без строк в системных таблицах Joomla, MODX и OpenCart сайт падает или молча пуст.
5. **Предпросмотр становится `ready`, даже если сайт не открывается.** Сборка проверяет только TCP-порт (`runtime.ts:757-773`), `healthPath` читает лишь smoke-проверка, а она идёт только при кандидате (`preview-manager.ts:297`). Для WordPress это редкий случай, для новых CMS — основной способ сломаться незаметно.
6. **Ядро Битрикса в текущих правилах не попадает в репозиторий, поэтому предпросмотр Битрикса всегда `no_core`** (`bitrix.ts:18,43-44`, `preview-builder.ts:620-621`). Предпросмотр строится только из дерева git. Spec §13 («только `/local/`, ядро `/bitrix/` не трогаем») противоречит этому требованию — это решение владельца, а не деталь реализации.
7. **Первый этап можно сделать без CLI и плагина: `content: null`** (`recipe.ts:167`, `preview-builder.ts:749,800`). Предпросмотр и правки файлов работают, план БД отклоняется. Но у MODX шаблоны и сниппеты по умолчанию живут в базе (по памяти), так что режим «только файлы» там мало полезен.
8. **Дамп «База и бэкап» к CMS не привязан,** но работает только при `PREVIEW_EXECUTOR=local`, то есть в production его сейчас нет. Кроме того, дамп с `USE`, `DEFINER` или журнальными `SET` останавливает сборку (раздел 8).

## 2. Сборка от начала до конца

| Шаг | Где | Что происходит |
| --- | --- | --- |
| Создание | `packages/trpc/src/services/chat/previews.ts:74-96`, вызов `tasks.ts:292` | В транзакции `task.create`: строка `pending` и задание `preview.sync`, без базы — сразу `unavailable/no_database` |
| Захват | `preview-manager.ts:218-257` | Аренда строки, пульс, цикл «пока приходят новые просьбы» |
| Решение | `preview-facts.ts:243-267` | `destroy`, `build`, `expire` или `none` |
| Старт | `preview-builder.ts:428-465` | `building`, сброс upstream, `write_epoch + 1`, при новом семени проверка, что сайт свободен |
| Настройки базы | `:271-299` | `adapter.databaseSettings(read)` через файловый источник, иначе каталог базы |
| Рецепт | `:611-619` | Версия PHP от плагина прода → `adapter.previewRecipe(facts)`; исключение → `not_supported` |
| Ядро | `:620-621` | `git.missingPaths(requiredPaths)` → `no_core` |
| Образ | `:622`, `:342-349` | Первая версия из рецепта, для которой есть образ |
| Семя | `:636-678` | Копия → zstd → AES-GCM → S3; копия отбрасывается, если выпуск успел тронуть сайт |
| Контейнер | `:683-722`, `runtime.ts:618-785` | Сеть, правила хоста, тома, контейнер, файлы паролей, `configFiles`, настройки, ожидание готовности |
| Дерево | `:727-735`, `:896-974` | Целиком или разницей (до 2000 файлов), поверх — файлы платформы |
| База | `:739-747`, `runtime.ts:919-959` | Ожидание записей `mcp`, `DROP/CREATE`, загрузка семени `mariadb --binary-mode --sandbox` |
| Контент | `:749-800` | Учётка платформы, сверка с продом, повтор плана БД кандидата |
| Готово | `:803-826` | `ready`, upstream, `filesSha`, `preview_seed_mismatches` |
| Проверки | `preview-manager.ts:297-303` | `php_lint`, `preview_smoke` — только при кандидате |

## 3. Образ и версия PHP

**Выбор образа** (код): `siteImage()` идёт по `recipe.runtimeVersions` и берёт первую версию, которая есть в `PREVIEW_SITE_IMAGES` (`preview-builder.ts:342-349`). Переменная пуста — `failed/not_configured`. Подходящей нет — `unavailable/not_supported`. Формат — `8.3=<образ@sha256:…>,8.2=…`, ключ только версия вида `\d{1,2}\.\d{1,2}` (`preview-config.ts:167,180-200`). Стека в ключе нет.

**Версия сайта** узнаётся только через плагин прода (код):

- `deps.production()` → `gateway.runtime()` → `GET /raditi/v1/runtime` (`preview-builder.ts:196-203,601-613`, `raditi-content.php:478-487`).
- Нет плагина или ответа — исключение глотается (`:608-610`), `wordpressPhpVersions(undefined)` сортирует вокруг `DEFAULT_PHP = 8.3` (`wordpress-preview.ts:20,32-38`).
- Ответ содержит и список расширений, но в `SiteFacts` попадает только версия (`:613`, `:182-193`). Расширения видит только `previewRuntimeMatch` — подсказка в «Проверках» (`runtime-match.ts:33-48`).
- Метод порта `detect()` нигде не вызывается (`grep "\.detect("` пуст), `SiteFacts.version` в предпросмотре не заполняется, `extras` всегда `{}`.

**Следствие для новых CMS.** Плагина у них нет, значит версия PHP будет значением по умолчанию. Одного значения мало: Joomla 6 требует PHP 8.3+ (источник), а Joomla 3 и старые OpenCart на 8.3 не заработают (по памяти). Нужен новый способ (раздел 9.3). Повтора на следующей версии при фатальной ошибке нет: `siteImage` выбирает один раз.

## 4. Поля рецепта: кто читает и что завязано на WordPress

| Поле | Кто читает | Как работает | Завязка |
| --- | --- | --- | --- |
| `runtime` | `preview-checks.ts:47` | Выбор линтера | `z.literal('php')` (`recipe.ts:134`) |
| `runtimeVersions` | `siteImage` | Порядок предпочтения | Нейтрально |
| `database` | `preview-builder.ts:692`, `runtime.ts:629` | `mysql` или null; `postgres` — `badRequest` | MariaDB в образе |
| `requiredPaths` | `preview-builder.ts:620` | Проверка наличия в git на `headSha`; нет — `unavailable/no_core`, страница не рисуется. Причина снимается следующей сборкой (`preview-facts.ts:262-264`) | Список у адаптера |
| `generatedFiles` | `writePreviewTree`, `files.mjs platform` | До 16 файлов по 192 КиБ. Из экспорта git исключены (`:945`), пишет root с режимом 0444 при каждой записи дерева, папки на пути — root, группа PHP, 1775 (`ports.ts:343-349`). Синхронизация хода их не трогает и отказывает при попытке (`preview-sync.ts:155,258-265`) | Сами файлы — WordPress |
| `settings` | Файл настроек | Плоская запись имён `[A-Z_]+`, строка, число или флаг | Нейтрально |
| `healthPath` | Только `smokePages` (`preview-checks.ts:75`) | При сборке не проверяется | Нейтрально |
| `web.command` | `containers.ts:227` | `Cmd` → `init.sh "$@"` → `/bin/sh -c '"$@" 2>&1 \| cat'` от 33 (`init.sh:219`) | `apache2-foreground` есть в любом `php:*-apache` |
| `web.env` | `containers.ts:229` | `Env` контейнера, наследуется и `docker exec` | Нейтрально |
| `web.port` | `RADITI_WEB_PORT` | Цель шлюза входа и проверка порта | Нейтрально |
| `web.user` | `containers.ts:264,283`, `runtime.ts:662,748` | Владелец tmpfs и тома | **Расходится с `init.sh:24` `WEB=33:33`**: другой uid ломает старт |
| `web.docroot` | `containers.ts:238,254`, `runtime.ts:638` | Том дерева | `checkImage` отвергает образ с `VOLUME` вне docroot и `/var/lib/mysql` (`runtime.ts:191-193`) |
| `web.tmpfs` | **Никто** | Мёртвое поле: набор tmpfs жёстко в `containers.ts:262-270` | Убрать или подключить |
| `web.configFiles` | `runtime.ts:749-750` | До 8 файлов по 64 КиБ, в папку настроек при каждом `ensure`, входят в хеш: смена пересоздаёт контейнер (`containers.ts:289-290`) | Сейчас один `apache2.conf` |
| `content.access` | `preview-content.ts:64-86` | После загрузки семени печатает JSON доступа, плюс `origin`, в Vault `kv/previews/<id>/<kind>` | `wp eval` |
| `content.objects` | `preview-content.ts:89-103` | Ссылки объектов для сверки | **`publishedObjectRefSchema` — только `post\|page:<id>`** (`published-content.ts:4`) |
| `content.pages` | `preview-checks.ts:78` | Страницы smoke по типу объекта | Нейтрально |

**Файл настроек** (`previewSettingsSchema`, `ports.ts:302-315`): `/run/raditi/preview/settings.json`, версия 2, поля `hostname`, `origin`, `productionOrigin`, `database`, `settings`, `env`. Пишется от uid PHP с umask 077 на tmpfs при каждом `ensure`, после `configFiles`; `init.sh` ждёт его перед запуском сервера (`init.sh:218`). Секреты только в нём, сгенерированные файлы секретов не содержат.

**CLI.** `runtime.exec` запускает `run-as.sh 33:33 <сек> -- <argv>` в рабочей папке docroot с `HOME=/nonexistent`; группа процессов убивается по концу или сроку (`runtime.ts:961-988`, `run-as.sh`). В argv не больше 16 аргументов по 4096 знаков (`recipe.ts:79`), оболочки нет. От WordPress зависит только содержимое: `wp --skip-plugins --skip-themes eval <php>` (`wordpress-preview.ts:75`). Универсальная замена — `['php','-r',код]` с загрузкой ядра стека; `run-as.sh` менять не нужно.

**Что в файлах `infra/wordpress` — только WordPress и нужно каждому стеку заново:**

- `preview-wp-config.php`: подключение из настроек (`:26-38`), ключи из пароля базы (`:42-45`), адрес предпросмотра и подмена `$_SERVER` (`:49-64`), запреты обновлений (`:71-78`), переменные клиента, защищённые от имён конфигурации (`:90-107`).
- `raditi-preview.php`: письма (`:15-23`), cron (`:26-29`), подмена адресов в заголовках и теле (`:56-208`).
- `preview-apache.conf`: почти весь нейтрален, от WordPress зависят только правила `index.php` (`:72-78`). `AllowOverride None` (`:68`), а `.htaccess` не импортируется (`php-hosting.ts:5`), поэтому у каждого стека свои правила перезаписи.

## 5. Образ `site` и что он берёт из образа WordPress

`infra/preview/Dockerfile:8,48`: `FROM ${BASE}`, по умолчанию `wordpress@sha256:8ae73d59…`. Цель `site` добавляет MariaDB 11.8.9, tini, WP-CLI 2.12.0, Node, скрипты (`:49-86`). `ENTRYPOINT` заменён, поэтому `docker-entrypoint.sh` WordPress не запускается, а `/usr/src/wordpress` просто лежит в образе.

**Модули PHP образа `wordpress:7.1.2-php8.3-apache`** (замер, `php -m`, PHP 8.3.35, Debian 13):

`bcmath Core ctype curl date dom exif fileinfo filter gd hash iconv imagick intl json libxml mbstring mysqli mysqlnd openssl pcre PDO pdo_sqlite Phar posix random readline Reflection session SimpleXML sodium SPL sqlite3 standard tokenizer xml xmlreader xmlwriter Zend OPcache zip zlib`

**Разница с `php:8.3-apache`** (замер): `bcmath exif gd imagick intl mysqli zip`. Из `docker image history`:

- `docker-php-ext-configure gd --with-avif --with-freetype --with-jpeg --with-webp`
- `docker-php-ext-install bcmath exif gd intl mysqli zip`
- `pecl install imagick-3.8.1`
- apt: `ghostscript libheif-plugin-aomenc libheif-plugin-x265`
- `error-logging.ini`: `display_errors=Off`, `log_errors=On`, `error_log=/dev/stderr`
- `opcache-recommended.ini`: 128 МБ, `revalidate_freq=2`, у предпросмотра переопределён в `preview-apache.conf:39-46`
- Apache: `a2enmod rewrite expires remoteip`, `remoteip.conf`
- `VOLUME /var/www/html`, `WORKDIR /var/www/html`

**Чего нет** (замер): `pdo_mysql`, `pdo_pgsql`, `soap`, `ldap`, `calendar`, `gmp`, `xsl`, `sockets`, `bz2`, `pcntl`, `apcu`, `memcached`, `redis`, ionCube, cron, sendmail.

**Значения PHP по умолчанию** (замер): `memory_limit=128M`, `upload_max_filesize=2M`, `post_max_size=8M`, `max_input_vars` не задан (1000), `short_open_tag=1`, `session.save_path` пуст. `php.ini` в образе нет.

**Что действительно завязано на BASE:**

| Зависимость | Где | Переносится на `php:*-apache` |
| --- | --- | --- |
| `apache2-foreground` | `wordpress-preview.ts:108` | Да, есть в базе |
| uid 33 `www-data` | `init.sh:24` | Да, Debian |
| Debian 11–13 | `Dockerfile:53-56` | Да; PHP 7.4 — bullseye, старее нужен другой путь |
| `setpriv`, `setsid` | `Dockerfile:71` | Да, util-linux (проверка в сборке) |
| Модули из `mods-enabled` | `preview-apache.conf:29-30` | Да, плюс `a2enmod` |
| `VOLUME` | `runtime.ts:191-193` | Без него проще |
| Семь расширений и пакеты | список выше | Перенести в Dockerfile |
| WP-CLI | `Dockerfile:75-76` | Уже ставится отдельно, от `BASE` не зависит |

Риск замены: `error-logging.ini` надо перенести обязательно. Без него `display_errors` принимает значение PHP по умолчанию, и фатальные ошибки меняют поведение smoke (`preview-checks.ts:67`). Флаг `gd --with-avif` есть не у всех версий PHP, поэтому Dockerfile становится матрицей версий. Проверка — `verify:release` и сверка `php -m` до и после.

Образы цели `site` нигде не публикуются: в `publish-images.yml` матрицы только по `apps/*`, `infra/preview` там нет (код). `preview.yml` собирает только 8.3. На amd64 образ не проверялся (план 58, §11).

## 6. Копия базы

### Движки

- Копировальщик один, `createMysqlDatabaseCopier` (`previews.providers.ts:94`), отвергает всё кроме `mysql` (`mysql-copier.ts:481-482`). MariaDB и MySQL для него одно и то же.
- Контейнер всегда на MariaDB 11.8.9 (`Dockerfile:49`), даже если прод на MySQL.
- Мастер принимает PostgreSQL, но предпросмотр на нём упадёт: `badRequest` в копировальщике и в `runtime.ts:629-630`. Для Joomla и OpenCart на PostgreSQL ответ — `not_supported`, не `failed`.
- `serverVersion` пишется в итог копии, но сверки семейства нет (`ports.ts:77`).
- Загрузка через `mariadb --binary-mode --sandbox --max-allowed-packet=64M`; `\!` и `source` не выполняются (`runtime.ts:942-958`).

**Замер совместимости** (MariaDB 11.8.9 образа `site`, 11.4.13 образа дампа): `utf8mb4_0900_ai_ci`, `utf8mb4_0900_as_cs` и JSON принимаются; `NO_ZERO_DATE` в режиме по умолчанию нет. Значения сервера: `sql_mode=STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION`, `innodb_strict_mode=1`, `REPEATABLE-READ`, буфер 128 МБ, 151 соединение.

**Дефект для широких таблиц (замер).** `seedHeader` выставляет `SQL_MODE`, но не `innodb_strict_mode` (`sql.ts:198-211`). Таблица из 200 `varchar(255)` в cp1251 с форматом строк по умолчанию и 11 `varchar(1000)` в `COMPACT` дают `ERROR 1118 Row size too large` при строгом режиме; вариант `COMPACT` со строгим режимом 0 проходит. Таблицы, созданные на проде с выключенным строгим режимом, остановят загрузку всего семени: клиент работает без `--force`. Исправление — одна строка в заголовке семени или `--innodb-strict-mode=0` в `init.sh:193-196`. По памяти именно так настраивают сервер под Битрикс.

### Таблицы вне списка разрешённого

`copyTables` берёт все базовые таблицы с префиксом `tablePrefix` и подходящим именем (`mysql-copier.ts:571-579`). У каждой пишет `CREATE TABLE`, а строки только при наличии правила; иначе `structureOnly += 1` (`:603-618`). Строки такой таблицы не запрашиваются вовсе.

Следствия:

- **Режима «копия без строк не загружается» нет.** Загрузка пройдёт, а упасть может сайт. Отличить это умеет только smoke, и только при кандидате.
- **Всё или ничего.** Таблица, которую нельзя записать, рушит всю копию, даже если она не нужна: другой движок (`ARCHIVE`, `MRG_MyISAM`, `CSV` — `sql.ts:82`), партиции, `TABLESPACE` из `SHOW CREATE TABLE`, комментарий в списке колонок (`sql.ts:133-154,176-195`). Для структурных таблиц разумен пропуск с записью в сводку, а не отказ.
- **Таблицы без префикса не попадают даже структурой** (`mysql-copier.ts:578`). У Битрикса таблицы highload-блоков и модулей партнёров могут быть без `b_` (по памяти), поэтому ему нужен `tablePrefix: ''` с полными именами в правилах. Схема это допускает (`recipe.ts:35`).
- Представления, триггеры и процедуры не копируются (`:574`).
- Колонка из правила обязана существовать, иначе `structure_unsupported` на всю копию (`:595-596`). Разные версии CMS имеют разные колонки, а `SiteFacts.version` не заполнен. Отсутствующая **таблица** при этом безопасна (`:592`, `policy-sql.ts:77`).

### Сериализованные значения и адрес сайта

- **Значения не переписываются.** Адрес прода в базе остаётся; подменяет его `raditi-preview.php` при отдаче (spec §8). Поэтому длины в `serialize()` не ломаются и поиск-замена не нужен. Цена: у каждой CMS нужен свой слой подмены.
- `scrub_secrets` меняет только строки под ключами-секретами и пересчитывает длины (`nested-secrets.ts:116-122`). Значение читается как Latin-1, поэтому байтовые длины верны в любой кодировке, в том числе cp1251 (`:9-11,287-291`). Вложенные значения разбираются на глубину до 64. Что не разобралось целиком, копируется как есть (`:6-7`) — это молчаливое пропускание, важное для форматов других CMS.
- Регулярка ключей английская и общая (`:14-15`). Имена вроде `smtppass` (Joomla) и `mail_smtp_pass` (MODX) она не ловит: `passw(?:or)?d` требует `passwd` или `password`, а `pwd` здесь нет. Для настроек типа ключ-значение защиту дают условия `notLike` адаптера (`wordpress-db-copy.ts:86-96`), их надо писать на стек.
- `randomPasswordHash` выдаёт форму phpass `$P$B…` (`mysql-copier.ts:457-459`). Как случайная строка она безвредна, но имя и форма — от WordPress.

### Размер

Постоянные, настройкой не меняются (`ports.ts:81-103`, `preview-seed.ts:39-45`):

| Предел | Значение | При превышении |
| --- | --- | --- |
| Таблиц с префиксом | 1 000 | `copy_too_large` |
| Строк всего | 1 000 000 | `copy_too_large` |
| Одна строка | 4 МиБ | `copy_too_large` на всю копию |
| Семя до сжатия | 512 МиБ | то же |
| Семя сжатое | 256 МиБ, держится в памяти `core` при записи и чтении | `seed_too_large` |
| Запрос | 120 с | `copy_timed_out` |
| Копия целиком | 30 мин | то же |

Частичной копии нет: нет условия «последние N строк» и нет режима «при превышении оставить структуру». Каталог OpenCart или Битрикса на десятки тысяч товаров упрётся в миллион строк уже на таблицах свойств (оценка). Для Битрикса под вопросом и предел 1 000 таблиц: нужен замер на настоящей редакции.

**Семя строится на каждый диалог.** Ключ `previews/<siteId>/<previewId>/seed.sql.zst.enc`, в AAD входит `previewId` (`preview-seed.ts:47-48,64-74`), а политика вписывает `previewId` в данные через `overrides` (`wordpress-db-copy.ts:343`). Новый диалог копирует базу заново, с дампом — ещё и скачивает файл. Для WordPress терпимо, для крупных баз дорого. Чтобы делить семя между диалогами одной версии сайта, привязку к предпросмотру надо вынести из семени в шаг после загрузки.

## 7. Предпросмотр по запросу и `PREVIEW_IDLE_MINUTES`

Сборка не откладывается: строка и задание создаются вместе с диалогом, потому что по предпросмотру работают инструменты агента (spec §20, 27.10.2026). «По просьбе» относится к показу: кабинет не берёт билет, пока клиент не нажал пункт меню или `/preview`.

- **Билет.** `openPreview` (`previews.ts:185`): `pending` и `building` → `PREVIEW_NOT_READY`, экран спрашивает снова (`:216-218`). Остановленный собирается заново, если диалог не закрыт и проход не идёт; повтор просьбы не чаще раза в 60 с (`:144,153-177`).
- **Простой.** `previewIdle`: статус `ready`, задача не `queued/preparing/running`, с последнего использования прошло `PREVIEW_IDLE_MINUTES`, по умолчанию 30 (`preview-facts.ts:226-233`). Использование — создание, просмотр, билет, сессия шлюза (перепроверка раз в 60 с), начало и конец хода (`:28-35`).
- **Остановка.** `expirePreview`: контейнеры стоят, тома, семя и секреты живут (`preview-builder.ts:1037-1060`). Статус `expired`.
- **Пробуждение.** Открытие; начало прохода (`wakeStoppedPreview`, `preview-wake.ts:9-26`); сборщик при `expired` и недавнем просмотре или идущем проходе (`preview-manager.ts:493-518`).
- **Срок жизни.** `PREVIEW_TTL_HOURS` = 72 от последнего билета или до срока резерва (`:457-482`). Закрытый диалог: снос контейнеров, томов, секретов и семени (`preview-builder.ts:995-1031`).
- **Циклы.** Просьбы `mcp` — каждые 500 мс, сборщик — 30 с, до 4 просьб и 2 фоновых сборок (`preview-loops.ts:12-19`, `preview-manager.ts:72`).

Пересборка остановленного идёт от семени: копии с сайта нет, пока версия сайта та же (`preview-builder.ts:568`). Дерево пишется разницей, том сохраняется (`:703-706`), но база загружается из семени заново при каждой сборке (`:739-747`). Поэтому пробуждение стоит столько, сколько загрузка семени: для WordPress секунды, для базы на сотни мегабайт — минуты. Это нейтрально к CMS.

## 8. База, закрытая снаружи

**Как решено** (решение владельца от 26.10.2026). Владелец называет в «База и бэкап» файл `.sql` или `.sql.gz` на своём файловом источнике (`site_database_dumps`; `site-database-dump.ts`). Web хранит только имя. При сборке `core` читает файл по SFTP/FTP потоком, распаковывает gzip, загружает во временную MariaDB 11.4 и копирует её тем же копировальщиком и той же политикой (`preview-builder.ts:533-559`, `site-sources.ts:223-265`, `staging.ts`). Временная база удаляется после семени (`:680`) или сборщиком (`preview-manager.ts:601-621`).

| Случай | Итог |
| --- | --- |
| Нет ни базы, ни дампа | `unavailable/no_database`, сборки нет |
| Есть только дамп | Копия из дампа |
| Есть и живая база, и дамп | Живая побеждает, дамп игнорируется (`preview-facts.ts:204`). Если хостинг закрыл порт — `failed`, резервного хода нет |
| `PREVIEW_EXECUTOR=runner` (production) | `previews.docker` = null (`config.ts:590-596`), `staging` = null (`previews.providers.ts:96-102`), сборка — `not_configured` (`preview-builder.ts:543`) |

**Работает ли для других CMS.** Да, в коде дампа нет ни слова о стеке. Адаптеру нужны `databaseSettings(read)` и `databaseCopyPolicy`; при непрочитанной конфигурации префикс ищется в каталоге временной базы по таблицам политики (`database-settings.ts:27-51`).

**Ограничения, проверенные на `mariadb:11.4.13` с правами `loader`** (замер, аргументы как в `staging.ts:130-142,232`):

| Строка дампа | Итог |
| --- | --- |
| `CREATE DATABASE`/`USE` другой базы (`mysqldump --databases`) | ERROR 1044, загрузка остановлена |
| `CREATE DEFINER=… TRIGGER`, `… VIEW` | ERROR 1227 |
| `SET @@SESSION.SQL_LOG_BIN=0` (дампы с GTID) | ERROR 1227 |
| `SET @@GLOBAL.GTID_PURGED` | ERROR 1193 |
| Коллации MySQL 8, `LOCK TABLES`, MyISAM с FULLTEXT, cp1251 | Проходит |

Клиент идёт без `--force`, поэтому любая такая строка рушит сборку, а клиент видит безликую ошибку `runtime_failed` (`staging.ts:242`, `preview-builder.ts:171`). Для шаред-хостингов нужен фильтр потока: убрать `USE`, `CREATE DATABASE`, `DEFINER`, журнальные `SET`.

Формат: только `.sql` и `.sql.gz` до 512 МиБ, 1 ГиБ после распаковки, 30 мин (`database-dump.ts:11-19,22`). Штатные резервные копии CMS архивные (Битрикс — `.tar.gz` и тома, Akeeba — `.jpa`; по памяти) и не подойдут.

Туннеля через SSH к закрытому MySQL нет (`forwardOut` не найден). Для сайтов с SSH это естественный следующий шаг: живая база без дампа, все гарантии копии у источника сохраняются.

## 9. Что нужно, чтобы конвейер поднял четыре CMS

### 9.1 Требования к среде

| | Joomla | MODX | OpenCart | Битрикс |
| --- | --- | --- | --- | --- |
| PHP | 6.x — 8.3+; старше — другие версии (источник) | 3.x — 7.2+ (источник) | 4.x — 8.1+ (источник) | Проверять скриптом `bitrix_server_test.php` (источник) |
| Обязательные расширения | json, simplexml, dom, zlib, gd, mysqlnd или pdo_mysql (источник) | pdo_mysql, zlib, json, gd, imagick, simplexml, curl, mbstring (источник) | curl, zip, zlib, gd, mbstring, mysqli (источник) | mysqli, mbstring, gd, curl, zip; soap, ldap, sockets — проверить (по памяти) |
| Нет в нынешнем образе | pdo_mysql при `pdomysql` | **pdo_mysql, без него не работает** | pdo_mysql при PDO-драйвере | Проверить тем же скриптом |
| ini | `memory_limit` от 256M (источник) | От 64M (источник) | — | `max_input_vars` от 10000, `short_open_tag=On` (источник), `memory_limit` 256–512M, `opcache.revalidate_freq=0` |
| ionCube | Редко | Редко | Частые платные модули (по памяти) | Часть модулей партнёров (по памяти) |

Официальный образ Joomla 6.2 для ориентира (источник): `php:8.5-apache-trixie`; `bz2 bcmath exif gd gmp intl ldap mysqli pdo_mysql pdo_pgsql pgsql zip` и через PIE `apcu imagick php-memcached phpredis`; `a2enmod rewrite expires remoteip`.

**Предложение:** один общий образ на версию PHP на базе `php:<x.y>-apache` — объединение: нынешние семь плюс `pdo_mysql soap calendar gmp xsl sockets ldap bz2 apcu`, а `memcached` и `redis` только если сайты ими пользуются. Ключ `PREVIEW_SITE_IMAGES` остаётся версией, менять `siteImage`, `parsePreviewSiteImages` и `.env` не нужно. Лишние загруженные расширения не считаются расхождением (`runtime-match.ts:38-46`). Образы на стек дали бы матрицу 4×7 ради небольшой разницы.

**Настройки PHP схема уже позволяет без правок.**

- Под Apache: `php_admin_value` в `configFiles` (так сделано для opcache, `preview-apache.conf:39-46`).
- Для CLI: `web.env.PHP_INI_SCAN_DIR=:/run/raditi/preview` и `.ini` в `configFiles`. Замер: под CLI `memory_limit`, `sendmail_path`, `max_input_vars` применились. Под Apache не проверено.

**ionCube.** Загрузчики для PHP 8.3 и 8.4 на aarch64 есть (источник — репозиторий Remi, 14.4.1), условия распространения не подтверждены. Безопасный вариант: положить `.so` в образ, но не включать; `zend_extension` подключает `.ini` из `configFiles`, когда у сайта найдены закодированные файлы. Для этого нужно передать расширения прода в `SiteFacts` или искать заголовок ionCube при импорте. Под gVisor не проверялось.

**Cron не нужен, нужна обратная гарантия.** Демона в образе нет (замер), `init.sh` запускает ровно свои службы. Планировщики CMS работают от строк таблиц (`b_agent`, `#__scheduler_tasks`, `oc_cron`; по памяти), а эти таблицы останутся пустыми, если их не внести в список. Адаптеру нельзя добавлять их в политику. Почта: `sendmail_path=/bin/true` закрывает `mail()` для всех стеков, SMTP — фильтром настроек, потому что интернет предпросмотра открыт.

### 9.2 Адаптер: конфигурация, адрес, перезапись

| | Joomla | MODX | OpenCart | Битрикс |
| --- | --- | --- | --- | --- |
| Генерируемые файлы | `configuration.php`: класс `JConfig`, значения из файла настроек в конструкторе | `core/config/config.inc.php` и три `config.core.php` (корень, `manager`, `connectors`) | `config.php`, `admin/config.php`: `HTTP_SERVER`, `DIR_*`, `DB_*` (источник) | `bitrix/.settings.php`, `bitrix/php_interface/dbconn.php` |
| Настройки с прода | Больше 50 свойств, в том числе `sef`, `sef_rewrite`, `list_limit`, `offset`, `caching`, `session_handler`, `secret` (источник) | `$table_prefix`, кодировка, `$site_id`, `$uuid`, `$site_sessionname`, `$https_port`, абсолютные пути (источник) | `DB_PREFIX`, `DB_DRIVER`, `DIR_STORAGE` (источник) | `BX_UTF`, кодировка; префикса нет |
| `databaseSettings` | `$dbprefix` | `$table_prefix`, `$database_connection_charset` | `DB_PREFIX` | `tablePrefix: ''`, кодировка из `BX_UTF` |
| Перезапись | `index.php`, из `htaccess.txt` | `index.php?q=$1 [L,QSA]` (источник) | `index.php?_route_=…`, запрет `system/` (источник) | `/bitrix/urlrewrite.php` (по памяти) |
| Что может быть вне корня или в другом имени | `administrator` | `core/` вне web, переименованные `manager` и `connectors` | `system/storage` вне web, переименованный `admin`; `storage/modification` — живой код OCMOD (по памяти) | `/bitrix/`, `/upload/` не импортируются |
| Код в базе | Нет | **Шаблоны, чанки, сниппеты, плагины** (по памяти) | События и модификации | Частично настройки компонентов |
| Адрес предпросмотра | `live_site` пуст, домен из запроса (по памяти) | Вычисляется из `HTTP_HOST`, но есть `http_host` и `site_url` контекстов (по памяти) | Постоянная `HTTP_SERVER` | `b_lang`, `b_lang_domain` (по памяти) |

**Канала для настроек не хватает.** С прода в рецепт идут три значения `SiteDatabaseSettings`, схема строгая (`recipe.ts:34-39`), а `extras` пуст. Для Joomla нужен десяток настроек, и пересобирать их из `configuration.php` надо до рецепта. Нужен метод вроде `previewSettings(read)`, результат в `preview_environments.runtime` (предел CHECK — 8 КиБ), без секретов.

**Подмену адреса стоит вынести из WordPress.** Заголовки и буфер вывода в `raditi-preview.php:133-157,188-208` — чистый PHP. Это можно отдать как файл `configFiles` и подключить `php_admin_value auto_prepend_file`: подмена заработает для любой CMS без её плагина. Хуки WordPress (`wp_redirect`, `rest_pre_dispatch`, `is_admin`) останутся в адаптере, а исключения для админки станут списком путей в `settings`.

### 9.3 Что не хватает в схемах

**`previewRecipeSchema`:**

| Изменение | Зачем | Срочность |
| --- | --- | --- |
| Убрать `web.tmpfs` или подключить к `containers.ts` | Мёртвое поле; Битриксу может понадобиться больше `/tmp` | Низкая |
| Читать `web.user` в `init.sh` или зафиксировать `33:33` литералом | Скрытый разрыв договора | Низкая |
| `failureMarkers` | Ошибка базы может отдать 200 (OpenCart, Битрикс; по памяти); `FATAL` ловит только PHP (`preview-checks.ts:67`). В `VerifyPlan` такое поле уже есть | Средняя |
| `database.serverOptions` или единые флаги | `innodb_strict_mode`, `sql_mode`; проще единый выключенный strict | Высокая |
| `runtimeVersions` по версии CMS | Адаптеру нужна версия CMS из файла | Средняя |
| `runtime` остаётся `'php'` | Все четыре на PHP, расширять незачем | — |
| Формат версии `8.3` | Достаточно | — |
| Ini и расширения | Не нужно: `configFiles` и `web.env` | — |

**`databaseCopyPolicySchema`** — здесь основная работа:

| Изменение | Зачем |
| --- | --- |
| `tables.max(64)` → несколько сотен | У Битрикса и OpenCart системных таблиц больше |
| Правило по шаблону имени, остаётся списком разрешённого | `b_iblock_element_prop_s%`, `b_uts_iblock_%` создаются на каждый инфоблок (по памяти), политика их не знает, а каталог ей не передаётся |
| Необязательные колонки или версия в `SiteFacts` | Иначе разница версий рушит копию (`mysql-copier.ts:595`) |
| `match` по нескольким колонкам | `b_option`: модуль + имя + сайт; `oc_setting`: `key` + `store_id`; `#__extensions`: `folder` + `element` |
| Условие-ограничение строк на таблицу | Большие каталоги: иначе всё или ничего |
| `inCopied` с ИЛИ | Авторы материалов, категорий и прочего одним правилом |
| Пропуск таблицы, которую нельзя записать, если у неё нет правила | Сейчас чужая таблица модуля рушит копию |

Правило Р15 «список разрешённого, а не запрещённого» менять нельзя: это правило 1 CLAUDE.md. Режим «копировать всё, кроме…» не предлагается, даже если он проще. Таблицы модулей остаются структурой, а адаптер ведёт перечень известных расширений, как `displayOptions` с Elementor (`wordpress-db-copy.ts:215-233`).

**Домен и прочее вне схем:**

- `publishedObjectRefSchema` и `kind: post|page` (`published-content.ts:4,23`): иначе `content.objects` падает на `article:12`. Нужны объекты стека.
- `siteStacks` и enum БД `SiteStack`: добавить `joomla`, `modx`, `opencart`, миграция (`site-adapter.ts:26`, `schema.prisma:310`). Плюс реестр и `connectableStacks` (`registry.ts:7-10,33`).
- `CredentialKind` и `siteAccessKinds`: вид `wp`; для других стеков новые значения или общий `plugin`, путь Vault идёт от него (`preview-secrets.ts:21`).
- Причина `boot_failed` и проверка `healthPath` при сборке. Сейчас `ready` ничего не говорит о странице. `unavailable_reason` — строка с CHECK по форме, миграция не нужна; нужны слова в `preview-pane.tsx`.
- `databaseCopyLimits` — постоянные домена; для Битрикса `tables` и `rows` стоит вынести в политику с верхней границей.
- Определение версии PHP без плагина: заголовок `X-Powered-By`, версия CMS из файла (`libraries/src/Version.php`, `core/docs/version.inc.php`, `VERSION` в `index.php`, `bitrix/modules/main/classes/general/version.php`; пути по памяти) или ввод в мастере. Вызов `detect()` — готовое место.

### 9.4 Сложность по стекам для предпросмотра

| Порядок | Стек | Почему |
| --- | --- | --- |
| 1 | OpenCart | Два простых конфига, постоянные, mysqli. Сложность — много таблиц каталога и персональные данные заказов |
| 2 | Joomla | Конфигурация вся в файле, адрес от запроса. Сложность — `JConfig`, `#__extensions`, `#__assets`, `#__viewlevels` обязаны иметь строки |
| 3 | MODX | Нужен `pdo_mysql`, расширенный рецепт путей; правки в основном в базе, поэтому без плана БД агент мало что может |
| 4 | Битрикс | Ядро вне репозитория, пределы импорта, динамические таблицы, лицензионные значения в `b_option` |

**Битрикс отдельно.** Предпросмотр берёт дерево только из git, поэтому есть два пути:

- **А. Ядро в репозитории, как у WordPress** (решение от 17.10.2026). Проще всего, но пределы: 100 000 файлов и 1 ГиБ дерева (`publication.ts:28`, `limits.ts:49-53`), 20 000 папок, 200 000 записей и 4 ГиБ в `files.mjs:29-31`. Вместе с `upload/` реальный сайт, вероятно, не влезет; нужен замер.
- **Б. Отдельный слой ядра**: не в git, а архив на сайт в S3, разворачивается в том до дерева. Это новый механизм в `writePreviewTree`; строка spec §13 о выкладке «только `/local/`» при этом не меняется.

Ещё риски Битрикса (по памяти, проверить на установке): значения лицензии и пробного периода хранятся в `b_option` (`admin_passwordh`), и условие `notLike` на `pass` их отрежет; формы часто сохраняются в инфоблоки, значит персональные данные лежат в тех же таблицах, что и контент, — это вопрос к правилу 1. Условия лицензии на дополнительную копию — вопрос юристу.

## 10. Порядок работ по конвейеру

1. **Образ.** `BASE` → `php:<x.y>-apache`, объединённые расширения, матрица версий, сверка `php -m`, `verify:release` на WordPress. Публикация образов и amd64 — вместе с M10.
2. **Мелкие дефекты.** `innodb_strict_mode` в семени, `web.tmpfs`, `web.user`, пропуск структурных таблиц.
3. **Проверка при сборке.** `healthPath` с `failureMarkers`, причина `boot_failed`. Без этого остальная работа идёт вслепую.
4. **Схема политики и канал настроек конфигурации.**
5. **Общий слой подмены адреса** через `auto_prepend_file`.
6. **Первый стек с `content: null`** (OpenCart или Joomla): только файлы, предпросмотр, выпуск кода.
7. **Дамп:** фильтр потока, понятные причины отказа, staging на раннере (M10), туннель SSH.
8. **Контентный слой стека:** объекты, плагин или `php -r`, план БД.

## 11. Вопросы владельцу

Значения ниже — предложения этого отчёта, владелец их не видел.

1. Битрикс: ядро и `upload/` в репозиторий (меняет spec §13) или отдельный слой? **Предложение** — А, если замер на настоящей редакции уложится в пределы.
2. Один общий образ на версию PHP или образы по стекам? **Предложение** — общий.
3. Нижняя граница PHP. 7.4 собирается на текущем Dockerfile, 7.3 и старше требуют другого подхода к MariaDB. **Предложение** — 7.4+, старее `not_supported`.
4. Таблицы популярных расширений (магазины Joomla, miniShop2 у MODX, модули OpenCart): вести перечень в адаптере или показывать их пустыми? **Предложение** — короткий перечень, остальное структурой и честным словом в «Проверках».
5. Частичная копия больших каталогов допустима? Предпросмотр будет отличаться от сайта. **Предложение** — да, с пометкой.
6. ionCube в образе: требуется проверка условий распространения. **Предложение** — не включать до проверки.
7. PII в инфоблоках Битрикса: стек не отличает форму заявок от каталога. Значения по умолчанию нет — нужен выбор владельца с юристом.

## 12. Что проверено и что нет

**Выполнено:** чтение кода перечисленных файлов; `php -m`, ini, модули Apache и слои образа; значения MariaDB 11.8.9; разбор строк дампа на MariaDB 11.4.13; `PHP_INI_SCAN_DIR` под CLI.

**Не выполнено:** ни одна из четырёх CMS не запускалась. Списки таблиц, поведение при пустых таблицах и всё с меткой «по памяти» требуют проверки на настоящих установках. Числа Битрикса не измерены. Подключение ini и `auto_prepend_file` под Apache, ionCube и новые образы под gVisor не проверены.

## Источники

- [Joomla: Technical Requirements](https://manual.joomla.org/docs/get-started/technical-requirements/)
- [MODX 3: Server Requirements](https://docs.modx.com/3.x/en/getting-started/server-requirements)
- [OpenCart: Requirements](https://docs.opencart.com/requirements)
- [Тест сервера 1С-Битрикс](https://dev.1c-bitrix.ru/download/scripts/bitrix_server_test.php)
- [Remi: php83-php-ioncube-loader](https://mirror.nikhef.nl/mirror/remi/enterprise/8/safe/aarch64/repoview/php83-php-ioncube-loader.html)
- GitHub: `joomla-docker/docker-joomla` — `images/6.2/stable/php8.5/apache/Dockerfile`; `joomla/joomla-cms` (6.2-dev) — `installation/src/Model/ConfigurationModel.php`; `opencart/opencart` (master) — `upload/install/cli_install.php`, `upload/.htaccess.txt`; `modxcms/revolution` (3.x) — `core/docs/config.inc.tpl`, `ht.access`
