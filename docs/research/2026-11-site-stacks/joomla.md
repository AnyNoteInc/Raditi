# Joomla: сведения для адаптера стека Радити

Дата проверки всех источников: 01.11.2026. Код читался, не запускался.

Скачано и прочитано (в `research/src/joomla/`):

| Каталог | Что это | Откуда |
| --- | --- | --- |
| `pkg-6.2.0`, `pkg-5.4.10` | Официальные полные пакеты релиза (с `libraries/vendor` и собранным `media/`) | `github.com/joomla/joomla-cms/releases`, `Joomla_6.2.0-Stable-Full_Package.tar.gz`, `Joomla_5.4.10-Stable-Full_Package.tar.gz` |
| `cms-6.2.0`, `cms-5.4.10`, `cms-4.4.14`, `cms-3.10.12` | Git-теги (нет `libraries/vendor` и собранного `media/`) | `github.com/joomla/joomla-cms`, теги |
| `docker-joomla` | Исходники официального образа | `github.com/joomla-docker/docker-joomla` |
| `ru-RU-pack` | Официальный пакет локализации 6.2.0.1 | `update.joomla.org`, `downloads.joomla.org` |
| `ext-joomshopping/src` | JoomShopping 5.10.0, коммит `48fce22` от 29.10.2026, как пример магазина | `github.com/joomshopping/joomshopping` |

Ссылки на код Joomla ниже — `<тег>:путь:строка` относительно этих каталогов; на код Радити — путь в `raditi-stacks`.

## 1. Версии, требования, веб-сервер

### 1.1. Ветки на 01.11.2026

| Ветка | Последний релиз | Дата релиза | Статус | Источник |
| --- | --- | --- | --- | --- |
| 6.x | 6.2.0 «Mwezi» | 13.10.2026 | **Актуальная.** Ветка вышла 14.10.2025. Исправления ошибок до 17.10.2028, безопасность до 16.10.2029. Следующие: 6.2.1 — 24.11.2026; 6.3.0 — 13.04.2027 | [roadmap](https://developer.joomla.org/roadmap.html), [релизы GitHub](https://github.com/joomla/joomla-cms/releases) |
| 5.x | 5.4.10 | 13.10.2026 | **Только безопасность.** Обычная поддержка кончилась 13.10.2026; безопасность до 12.10.2027 | [roadmap](https://developer.joomla.org/roadmap.html) |
| 4.x | 4.4.14 «Pamoja» | 30.09.2025 (`cms-4.4.14:libraries/src/Version.php:93`) | **Снята с поддержки.** На [downloads.joomla.org/cms](https://downloads.joomla.org/cms) в разделе Unsupported. Конец — 14.10.2025 по roadmap и заметке 5.2.6, 17.10.2025 по docs.joomla.org (источники расходятся на три дня) | [заметка 5.2.6](https://joomla.org/announcements/release-news/5925-joomla-5-2-6-security-release.html), [форум, раздел 4.x](https://forum.joomla.org/viewforum.php?f=807) |
| 3.x | 3.10.12 | 08.07.2023 (`cms-3.10.12:libraries/src/Version.php:114`) | **Снята с поддержки.** Официальная поддержка до 17.08.2023; платная программа eLTS Joomla до 17.02.2025, новых обновлений больше нет | [заметка 4.2 и 3.10.11](https://www.joomla.org/announcements/release-news/joomla-4-2-release.html), [elts.joomla.org](https://elts.joomla.org/) |
| 2.5, 1.x | — | — | Снята, код архитектурно другой (нет `libraries/src`) | там же |

Последние релизы проверены по `api.github.com/repos/joomla/joomla-cms/releases` и `git ls-remote --tags`.

### 1.2. Что живёт в реальности

| Показатель | Значение | Источник |
| --- | --- | --- |
| Доля Joomla среди всех сайтов | 1,1% (1,6% среди сайтов с известной CMS) | [W3Techs, 01.11.2026](https://w3techs.com/technologies/details/cm-joomla) |
| Распределение версий среди сайтов Joomla (W3Techs, по всему миру) | 3 — 51,1%; 5 — 20,4%; 6 — 10,5%; 4 — 7,7%; 2 — 6,0%; 1 — 4,4% | [W3Techs, 01.11.2026](https://w3techs.com/technologies/details/cm-joomla/all/all) |
| Статистика самой Joomla (плагин отправки статистики, только установки, которые его включили; всего 3 295 185 записей, накоплено за годы) | 3.9 — 24,09%; 3.6 — 20,48%; 3.8 — 15,84%; 3.5 — 10,98%; 3.7 — 7,17%; 3.10 — 6,77%; 4.0–4.4 — 8,69%; 5.0–5.4 — 3,97%; 6.0–6.2 — 1,95% | `https://developer.joomla.org/stats/cms_version` |
| PHP (та же статистика) | 5.6 — 23,64%; 7.0 — 10,3%; 7.4 — 9,88%; 7.2 — 8,82%; 5.5 — 7,92%; 7.3 — 7,67%; 7.1 — 7,17%; 5.4 — 6,47%; 5.3 — 5,15%; 8.0 — 3,2%; 8.1 — 2,87%; 8.2 — 2,78%; 8.3 — 2,28%; 8.4 — 1,35%; 8.5 — 0,49% | `https://developer.joomla.org/stats/php_version` |
| СУБД (та же статистика) | `mysqli` — 88,38%; `mysql` — 8,2%; `pdomysql` — 3,25%; PostgreSQL (`pgsql` + `postgresql`) — 0,14%; `sqlsrv` — 0,02% | `https://developer.joomla.org/stats/db_type` |
| Доля на .ru | W3Techs на странице сегментации .ru показывает только тройку: WordPress 33,3%, Tilda 27,4%, Bitrix 16,0%. Доли Joomla на странице нет | [W3Techs .ru](https://w3techs.com/technologies/segmentation/tld-ru-/content_management) |

**Россия отдельно: не проверено.** Первичных данных о распределении версий Joomla именно в России не нашёл. Вывод по мировым данным (не по России): половина сайтов — ветка 3, которой нет поддержки, а её PHP бывает 5.x и 7.x. Это прямо ломает допущение об одной версии PHP (раздел 12).

### 1.3. Требования по веткам

| | 3.10.12 | 4.4.14 | 5.4.10 | 6.2.0 |
| --- | --- | --- | --- | --- |
| Минимум PHP в коде (`JOOMLA_MINIMUM_PHP`) | 5.3.10 (`cms-3.10.12:index.php:12`) | 7.2.5 (`cms-4.4.14:index.php:13`) | 8.1.0 (`cms-5.4.10:index.php:13`) | 8.3.0 (`cms-6.2.0:index.php:13`) |
| PHP рекомендуемый (Manual) | — | 8.2 | 8.3 | 8.4 |
| MySQL минимум / рекомендуемый | не проверено | 5.6 / 8.0+ | 8.0.13 / 8.1 | 8.0.13 / 8.4 |
| MariaDB минимум / рекомендуемый | не проверено | не указано в Manual | 10.4.0 / 11.1.0 | 10.4 (поддерживается 10.6) / 12.0 |
| PostgreSQL минимум / рекомендуемый | не проверено | 11.0 / 11.0+ | 12.0 / 16.0 | 12.0 (поддерживается 14.0) / 17.6 |
| Apache | не проверено | 2.4 | 2.4 | 2.4 |
| nginx минимум / рекомендуемый | не проверено | 1.10 / 1.18+ | 1.21 / 1.25 | 1.26 / 1.29 |
| IIS | не проверено | 8 / 10+ | 10 | 10 |

Источники: [Manual 6.x](https://manual.joomla.org/docs/get-started/technical-requirements/), [5.4](https://manual.joomla.org/docs/5.4/get-started/technical-requirements/), [4.4](https://manual.joomla.org/docs/4.4/get-started/technical-requirements/).

Важно: это **документированные** минимумы. Жёсткий порог в коде драйвера ниже: `MysqliDriver::$dbMinimum = '5.6'`, `$dbMinMariadb = '10.0'`, `PgsqlDriver::$dbMinimum = '9.4.0'` и в 5.4.10, и в 6.2.0 (`pkg-6.2.0:libraries/vendor/joomla/database/src/Mysqli/MysqliDriver.php:87,95`, `pkg-6.2.0:libraries/vendor/joomla/database/src/Pgsql/PgsqlDriver.php:55`). Соответственно, рабочий сайт клиента может стоять на СУБД старше документированного минимума.

### 1.4. Расширения и настройки PHP

Обязательные (проверки установщика `cms-6.2.0:installation/src/Model/ChecksModel.php:66-133`): `zlib`, `xml`, хотя бы один драйвер БД (`DatabaseDriver::getConnectors()`), `parse_ini_string` не отключена, `json_encode`/`json_decode`, запись в `configuration.php` или корень. Если загружен `mbstring` — `mbstring.language=neutral`.

По `composer.json` 6.2.0: `ext-json`, `ext-simplexml`, `ext-gd`, `ext-dom`, `php ^8.3.0`. По Manual: `json`, `simplexml`, `dom`, `zlib`, `gd` и один из `mysqlnd`, `pdo_mysql`, `pdo_pgsql`; рекомендуется `mbstring`; память — от 256 МБ.

Рекомендуемые настройки (`cms-6.2.0:installation/src/Model/ChecksModel.php:158-222`): `display_errors` выключен, `file_uploads` включён, `output_buffering` выключен, `session.auto_start` выключен, `zip`, `gd`, `iconv`, `intl` (`transliterator_transliterate`) есть.

### 1.5. Веб-сервер

| Что | Деталь |
| --- | --- |
| Шаблон Apache | `htaccess.txt` в корне: пакет **не** кладёт `.htaccess`, его включают переименованием. Нет `.htaccess` и `sef_rewrite=0` — рабочее состояние сайта: адреса вида `/index.php/...` |
| Веб-сервер IIS | `web.config.txt` |
| Настройка в конфиге | `$sef` (адреса человекочитаемые), `$sef_rewrite` (убрать `index.php`), `$sef_suffix` — `configuration.php`. По умолчанию в шаблоне `sef=true`, `sef_rewrite=false` (`cms-6.2.0:installation/configuration.php-dist`) |
| Правила перезаписи | Две ветки: `/api/*` → `api/index.php`, всё остальное → `index.php`; плюс `RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]` — без неё токен API не доходит на FastCGI (`cms-6.2.0:htaccess.txt`) |
| Блок защиты | `RewriteRule .* index.php [F]` на `base64_encode`, `<script>`, `GLOBALS`, `_REQUEST` в строке запроса |
| Без `mod_rewrite` | `RedirectMatch 302 ^/$ /index.php/` |
| Сжатие | Отдаёт готовые `.css.gz` и `.js.gz` из `media/`, когда клиент принимает gzip |

Официальный образ `:apache` при первом запуске сам делает `.htaccess` из `htaccess.txt` — раздел 11.

## 2. Распознавание

### 2.1. Метки корня (`rootMarkers`)

Договор метода: «записи, которые есть в корне всегда; мастер отказывает папке без них, импорт не заходит во вложенную папку, где они есть все» (`packages/domain/src/ports/site-adapter.ts:186-190`). Сравнение без регистра и только по именам записей папки (`packages/domain/src/site-connection/import-policy.ts:120-127`).

| Запись | Есть в корне 3.10–6.2 | Есть в `administrator/` | Вывод |
| --- | --- | --- | --- |
| `administrator` | да | нет | **брать** |
| `libraries` | да | нет | **брать** |
| `plugins` | да | нет | **брать** |
| `includes`, `components`, `modules`, `language`, `templates`, `cache` | да | да (все шесть) | не брать: `administrator/` выдаёт себя за корень |
| `index.php` | да | да | не брать |
| `configuration.php` | обычно да | нет | не брать: с `defines.php` может лежать выше (раздел 4.3), у неустановленной копии его нет |
| `api` | только ≥ 4.0 | нет | не брать: нет у 3.x |
| `cli`, `layouts`, `media`, `images`, `tmp` | да | нет | можно, но не нужно |

**Рекомендация: `['administrator', 'libraries', 'plugins']`.** Слабое место: файловый режим «публичная папка» (раздел 4.3). Там веб-корень содержит только `index.php`, `defines.php`, `administrator/`, `api/`, `media` и `images` (симлинки), `robots.txt`, `.htaccess` (`cms-6.2.0:libraries/src/Helper/PublicFolderGeneratorHelper.php:96-185`); `libraries` и `plugins` лежат выше веб-корня. Такой сайт мастер не примет, пока клиент не укажет папку выше веб-корня: по этой причине нужен текст подсказки.

Вложенные копии (`old/`, `backup/`, `test/`) имеют все три метки: импорт в них не зайдёт, что и нужно.

### 2.2. Чтение версии файлом, без выполнения

Порядок проверки (проверено на тегах 2.5.28, 3.4.8, 3.7.5, 3.8.0, 3.10.12, 4.4.14, 5.4.10, 6.2.0):

| Файл | Ветки | Синтаксис |
| --- | --- | --- |
| `administrator/manifests/files/joomla.xml` | 2.5 – 6.2 (проверено 3.10, 4.4, 5.4, 6.2) | `<name>files_joomla</name>`, `<version>6.2.0</version>`, `<creationDate>2026-10</creationDate>`. **Лучший источник:** один формат на все ветки, есть и точная версия, и подтверждение, что это Joomla |
| `libraries/src/Version.php` | 3.8 – 6.2 | `const MAJOR_VERSION = 6;`, `MINOR_VERSION`, `PATCH_VERSION`; перед `const` может стоять `public`. В 3.x ещё `const RELEASE = '3.10';`, `const DEV_LEVEL = '12';`. 4.x и новее `RELEASE` не имеют |
| `libraries/cms/version/version.php` | 2.5 – 3.7 | 2.5 и 3.4: `public $RELEASE = '3.4';`, `public $DEV_LEVEL = '8';`; 3.7: `const RELEASE = '3.7';`, `const DEV_LEVEL = '5';` |

`Version::isInDevelopmentState()` важен: при `DEV_STATUS` не `Stable` папка `installation/` не отправляет на установщик (`cms-6.2.0:includes/framework.php:19-24`).

Минимальная версия PHP сайта читается из `index.php`: `define('JOOMLA_MINIMUM_PHP', '8.3.0');` (в 5.x и новее с `\` перед `define`).

### 2.3. Отличие от похожих систем

| Что | Признак |
| --- | --- |
| Joomla ≥ 1.5 | `class JConfig` в `configuration.php` (проверено на шаблоне 2.5.28: `class JConfig {`, `public $password`) |
| Joomla 1.0, Mambo | Не `JConfig`: иные файлы конфигурации. Точный синтаксис не проверено; для продукта не нужен — в список подключаемых версий они не входят |
| **Joomla 3.x UTD** (форк JoomlaWorks) | Живой форк ветки 3: [репозиторий](https://github.com/joomlaworks/joomla-3.x), версия 3.17.0 от 10.10.2026, последний push 10.10.2026. Манифест тот же: `<name>files_joomla</name>`, но `<version>3.17.0</version>`, `const RELEASE = '3.17';`. Отличить от официальной 3.10 можно только по числу: официальных 3.11+ нет. Есть свой `cli/joomla.php`, чего нет в официальной 3.10, и встроенный сервер MCP. PHP от 7.1 (базовая 7.4), поддержка SQLite экспериментальная. Распространённость в России **не проверено** |
| RU-редакция | **Отдельной редакции нет.** Официальный пакет локализации `pkg_ru-RU` (версия 6.2.0.1, авторы — Russian Translation Team, `joomlaportal.ru`) ставится поверх обычной Joomla: `language/ru-RU/`, `administrator/language/ru-RU/`, `api/language/ru-RU/` (537 файлов `.ini` в `ru-RU-pack`). Источник: [сведения обновления](https://update.joomla.org/language/details6/ru-RU_details.xml), [список переводов](https://update.joomla.org/language/translationlist_6.xml). На [joomlaportal.ru](https://joomlaportal.ru/) тоже только пакет локализации, полного русского дистрибутива на главной странице нет |
| Сайт из резервной копии Akeeba | В корне может лежать `kickstart.php`, а `installation/` — установщик восстановления ANGIE, а не установщик Joomla. Сведения из документации Akeeba; файл `kickstart.php` не проверено |

### 2.4. Что `detect` прочитает до импорта

| Что | Откуда | Зачем |
| --- | --- | --- |
| Версия | `administrator/manifests/files/joomla.xml` | ветка: PHP, селекторы админки, наличие API |
| Движок БД | `public $dbtype = 'mysqli';` в `configuration.php` | `mysqli`, `mysql`, `pdomysql` — MySQL; `pgsql`, `postgresql` — PostgreSQL; `sqlsrv`, `sqlazure` — вне поддержки |
| Префикс | `public $dbprefix = 'jos_';` | раздел 4 |
| Включён ли ЧПУ | `$sef`, `$sef_rewrite` | предпросмотр и проверки |
| Внешний кеш и сессии | `$cache_handler`, `$session_handler` | предпросмотр их заменяет |

## 3. Дерево

### 3.1. Размеры

Официальный полный пакет 6.2.0: 28,6 МБ `.tar.gz`, 34,9 МБ `.zip`, в распакованном виде 111 МБ и 9 808 файлов. 5.4.10 — 109 МБ. Крупнее всего: `media/` 42 МБ, `libraries/` 32 МБ, `plugins/` 14 МБ, `administrator/` 12 МБ, `installation/` 5 МБ (удаляется при установке). Размер типичного сайта с медиа: **не проверено** (первичных данных нет).

### 3.2. Карта каталогов

| Путь | Что | Чьё | Git / импорт | Скачать заново |
| --- | --- | --- | --- | --- |
| `index.php`, `includes/`, `libraries/`, `layouts/joomla/`, `cli/joomla.php` | Ядро | ядро | импортируется, агенту закрыто | да, по версии |
| `administrator/` кроме `cache/`, `logs/` | Админка: `components/`, `modules/`, `templates/`, `language/`, `manifests/` | ядро плюс расширения | импортируется, агенту закрыто | ядро да, расширения клиента нет |
| `api/` | Приложение Web Services (≥ 4.0) | ядро плюс расширения | закрыто | да |
| `components/com_*/`, `modules/mod_*/`, `plugins/<группа>/<имя>/` | Фронт компонентов, модули, плагины. Ядро и сторонние лежат **вперемешку** | смешано | импортируется | только сверкой с манифестами |
| `administrator/components/com_*/`, `administrator/modules/mod_*/` | Админская половина тех же расширений | смешано | импортируется | то же |
| `templates/<имя>/` | Шаблоны сайта, в том числе `templates/<имя>/html/` — переопределения вывода, главное место правок | код клиента | **рабочий набор** | ядро: `cassiopeia`, `cassiopeia_extended`, `system` |
| `administrator/templates/<имя>/` | Шаблоны админки (`atum`, `system`) | ядро | закрыто | да |
| `media/` | Статика ядра и расширений: `media/vendor/`, `media/com_*/`, `media/plg_*/`, `media/templates/site/<шаблон>/` и `media/templates/administrator/<шаблон>/` (с 4.1) | смешано | импортируется | ядро да |
| `media/templates/site/<шаблон>/` | CSS, JS, изображения шаблонов нового вида, например `css/user.css` Cassiopeia | код клиента | **рабочий набор**: половина шаблона живёт вне `templates/` | |
| `language/overrides/`, `administrator/language/overrides/` | Переопределения текстов: `<тег>.override.ini` | код клиента | рабочий набор | нет |
| `language/<тег>/`, `administrator/language/<тег>/`, `api/language/<тег>/` | Языковые пакеты | ядро или сторонние | закрыто | да, `ru-RU` и другие с update.joomla.org |
| `images/` | Медиатека | контент | импортируется, агенту только добавление | **нет** |
| `files/` | Вторая корневая папка медиатеки: `plg_filesystem_local` по умолчанию `[{"directory":"images"},{"directory":"files"}]` (`cms-6.2.0:plugins/filesystem/local/local.xml:33`) | контент | как `images/` | **нет** |
| `cache/` | Кеш сайта; группы — `cache/<группа>/`, страницы — `cache/page/` | мусор | исключить | да |
| `administrator/cache/` | Кеш админки и **`autoload_psr4.php`** — карта пространств имён расширений, собирается заново (`cms-6.2.0:libraries/namespacemap.php:33`) | мусор | исключить | да |
| `tmp/` | Распаковка установщика, `tmp_path` по умолчанию (`cms-6.2.0:installation/src/Model/ConfigurationModel.php:448`) | мусор, может содержать архивы | исключить | да |
| `administrator/logs/` | Журналы, **файлы с расширением `.php`** (раздел 9) | персональные данные | исключить; `*.log` их не ловит | нет |
| `installation/` | Установщик. На работающем сайте его нет; если есть, сайт уходит на установщик (`cms-6.2.0:includes/framework.php:19-40`) | опасно | исключить обязательно | да |
| `configuration.php` | Конфигурация с секретами | секрет | исключить | нет |
| `configuration.php.*`, `configuration.bak`, `configuration_old.php` | Копии конфигурации на хостинге | секрет | исключить шаблоном `configuration*` | нет |
| `.htaccess`, `htaccess.txt`, `web.config`, `web.config.txt`, `robots.txt`, `robots.txt.dist` | Настройки веб-сервера, индексации. `htaccess.txt` безвреден, но клиент его может использовать как черновик | смешано | `.htaccess` исключён общим правилом | `*.txt` да |
| `defines.php` (в корне) | Необязательный файл переопределения путей (раздел 4.3) | опасно | защищённый путь | нет |

Папка `cache/` и `tmp/` присутствуют в корне пакета, в них только `index.html`. Пустые папки надо воссоздать в предпросмотре: `cache`, `tmp`, `administrator/cache`, `administrator/logs`.

### 3.3. Бэкапы внутри дерева

| Источник | Путь | Формат | Проверено |
| --- | --- | --- | --- |
| Akeeba Backup, Joomla 3 | `administrator/components/com_akeeba/backup/` | `.jpa`, `.jps` (зашифрованный), части `.j01` и т. п., `.zip` | [Akeeba: где файлы](https://www.akeeba.com/documentation/troubleshooter/abwherearemyfiles.html), расширения частей — не проверено |
| Akeeba Backup, новые версии | `administrator/components/com_akeebabackup/backup/` | то же | **Не проверено:** страницы Akeeba называют только `com_akeeba`; имя `com_akeebabackup` есть лишь в сниппете поиска. В правила импорта включить из осторожности |
| Akeeba, настроено иначе | любая папка | — | ловится только шаблонами |

В `archivesAndDumps` (`packages/site-adapters/src/php-hosting.ts`) уже есть `*.jpa`, но **нет `*.jps` и `*.j[0-9][0-9]`**. Дополнить.

### 3.4. Файлы посетителей

В ядре нет папки загрузок посетителей: у формы контакта ядра нет поля файла (`pkg-6.2.0:components/com_contact/forms/contact.xml`). Опасность — у расширений, и они держат файлы **внутри своего `components/`**, не в `images/`:

| Расширение | Путь | Что там |
| --- | --- | --- |
| JoomShopping 5.10.0 | `components/com_jshopping/files/pdf_orders/` | **PDF заказов: имена, адреса, телефоны покупателей** |
| | `components/com_jshopping/files/files_products/`, `demo_products/`, `importexport/`, `video_products/` | Продаваемые файлы, выгрузки |
| | `components/com_jshopping/files/img_products/`, `img_categories/`, `img_manufs/`, `img_attributes/`, `img_labels/` | Медиа товаров |

Источник: `ext-joomshopping/src/install/install.php:96-104` ([репозиторий](https://github.com/joomshopping/joomshopping), версия из `jshopping.xml`). Следствие: шаблон `components/*/files/` надо считать данными, а не кодом. Пути других расширений (VirtueMart, HikaShop, форм) **не проверено**.

## 4. Конфигурация

### 4.1. Файл

Один файл: `configuration.php` в `JPATH_CONFIGURATION` (по умолчанию корень). Это **класс с публичными свойствами**, не `define`, не массив:

Пересказ: файл объявляет класс `JConfig`, каждая настройка — его публичное свойство, например `offline`, `password`, `dbprefix`, `log_priorities`. Значения — логические, строки и массивы.









Форма записи, которую пишет сама Joomla (`pkg-6.2.0:libraries/vendor/joomla/registry/src/Format/Php.php:39-61`): по одной строке `\tpublic $имя = значение;\n`, строки в одинарных кавычках через `addcslashes($value, '\\\'')`, числа и логические значения как есть (с Framework Registry 2.0; в 3.x все значения могли быть строками, вид `public $x = '0';`), вложенные значения — `array(...)`. Закрывающего `?>` нет (`closingtag => false`), а старые файлы могут его иметь. Вручную отредактированный файл может иметь комментарии: шаблон `configuration.php-dist` содержит их справа от значений.

Разбор без выполнения подходит имеющимся `phpStringsAfter` и `phpConfigStrings` (`packages/site-adapters/src/php-config.ts`): перед значением — `\bpublic[ \t\r\n]+\$password[ \t\r\n]*=[ \t\r\n]*`, после — `[ \t\r\n]*;`. Самый ранний формат тот же: шаблон 2.5.28 содержит `public $password`. Для ветвей старше 2.5 вид не проверялся.

### 4.2. Все значения, которые считаются секретом

Источник: `$protectedConfigurationFields` (`pkg-6.2.0:administrator/components/com_config/src/Model/ApplicationModel.php:65`), список скрытых полей `SysinfoModel` (`pkg-6.2.0:administrator/components/com_admin/src/Model/SysinfoModel.php:290`), шаблоны конфигурации по веткам.

| Свойство `JConfig` | Что | Ветки |
| --- | --- | --- |
| `password` | Пароль БД | все |
| `secret` | Секрет сайта, раздел 4.5 | все; значение из шаблона 3.x `FBVtggIk5lAzEU9H` — образцовое, не считать секретом (аналог `put your unique phrase here` у WordPress, `packages/site-adapters/src/wordpress.ts:176`) |
| `smtppass`, `smtpuser` | Почта. `smtppass` — секрет; `smtpuser` обычно адрес почты | все |
| `smtp_oauth2_client_secret`, `smtp_oauth2_refresh_token` | OAuth2 для почты | есть в 6.2.0 (`pkg-6.2.0:libraries/src/Mail/MailerFactory.php:101-103`), нет в 5.4.10 |
| `proxy_pass`, `proxy_user` | Прокси исходящих запросов | есть в шаблонах 3.10, 4.4, 6.2 |
| `ftp_pass`, `ftp_user`, `ftp_host`, `ftp_root` | FTP-слой записи: **пароль FTP сайта** | 3.x (`cms-3.10.12:installation/configuration.php-dist:53-58`); в шаблонах 4.4.14 и 6.2.0 их нет |
| `redis_server_auth`, `session_redis_server_auth` | Пароль Redis кеша и сессий | все c Redis |
| `dbsslkey` | **Путь** к файлу клиентского ключа БД, не сам ключ. Значения не секретны, но файл по этому пути важен | ≥ 4.0 |

Секреты в базе — раздел 6.2.

Для `configSecrets` читать один файл: `configuration.php`. `dbsslkey`, `dbsslcert`, `dbsslca` — пути; проверять их как секрет не нужно. `$root_user` (раздел 8.4) не секрет, но опасен: если задан, это логин супер-пользователя.

### 4.3. Запуск с другой конфигурацией, не меняя файл

Переменных окружения Joomla не читает ни для одной настройки. Способы:

| Способ | Как работает | Ветки | Для предпросмотра |
| --- | --- | --- | --- |
| **Сгенерировать свой `configuration.php`** | Как `wp-config.php` у WordPress: импорт файл не берёт, предпросмотр пишет свой. Свойства класса могут быть только константами, поэтому значения из `settings.json` надо читать **в конструкторе `JConfig`**: `new JConfig()` вызывается всюду (`pkg-6.2.0:includes/framework.php:48`, `pkg-6.2.0:libraries/src/Service/Provider/Config.php:52`), `Registry` читает `get_object_vars` | все | **Рекомендуется.** Ограничение: свойство должно быть объявлено в классе: `property_exists('\JConfig', 'root_user')` смотрит на класс (`pkg-6.2.0:libraries/src/Application/AdministratorApplication.php:383`) |
| Перекрыть `JPATH_CONFIGURATION` файлом `defines.php` в корне | `index.php` и `administrator/includes/app.php` подключают `<корень>/defines.php` до всего. В 5.0+ `includes/defines.php` уважает уже заданные константы (`\defined('JPATH_CONFIGURATION') || \define(...)`, `pkg-6.2.0:includes/defines.php:17`) | 5.x, 6.x просто; 3.x, 4.x файл должен определить `_JDEFINES` и **все** константы `JPATH_*` сам (`cms-4.4.14:includes/app.php:16-23`) | Работает, но без выгоды перед первым способом; `defines.php` в корне — ещё один файл, который сайт клиента может иметь |
| Режим «публичная папка» (≥ 5.0) | `php cli/joomla.php site:create-public-folder` или `--public-folder` у установщика | ≥ 5.0 | Это не инструмент предпросмотра, а вариант установки у клиента, который надо уметь распознать |

`administrator/` и `api/` читают тот же файл (`pkg-6.2.0:administrator/includes/framework.php:44`, `pkg-6.2.0:api/includes/framework.php:43`). Если установлен `defines.php` со своим `JPATH_ROOT`, корень `configuration.php` переезжает вместе с ним.

Важно: **Общие настройки админки перезаписывают `configuration.php`** (`writeConfigFile`, `pkg-6.2.0:administrator/components/com_config/src/Model/ApplicationModel.php:827-856`): класс записывается заново из `Registry`, конструктор и комментарии теряются, права ставятся 0444. В предпросмотре это ломает связь с `settings.json`, поэтому экран `com_config` браузеру агента закрыт, а сам файл платформа пишет при каждой записи дерева, как уже сделано для `wp-config.php`. Команда `config:set` консоли делает то же.

### 4.4. Что из `configuration.php` — настройки сайта, а не инфраструктура

**Главное отличие от `wp-config.php`.** В WordPress адрес, название и язык живут в базе, а в файле только инфраструктура. В Joomla в этом файле и то, и другое:

| Группа | Свойства | Что делать в предпросмотре |
| --- | --- | --- |
| Инфраструктура, заменить | `host`, `user`, `password`, `db`, `dbtype`, `dbencryption`, `dbssl*`, `secret`, `tmp_path`, `log_path`, `cache_handler`, `session_handler`, `redis_*`, `memcached_*`, `session_redis_*`, `session_memcached_*`, `proxy_*`, `smtp*`, `mailer`, `sendmail`, `live_site`, `cookie_domain`, `cookie_path`, `force_ssl`, `helpurl`, `offline`, `debug`, `error_reporting`, `gzip`, `caching` | Значения предпросмотра |
| Отключить | `mailonline=false`, `caching=0`, `debug=false`, `robots='noindex, nofollow'` | Значения предпросмотра |
| **Настройки сайта, нужны те же, что на проде** | `sitename`, `sitename_pagetitles`, `MetaDesc`, `MetaAuthor`, `MetaVersion`, `MetaRights`, `offset`, `sef`, `sef_rewrite`, `sef_suffix`, `unicodeslugs`, `list_limit`, `access`, `editor`, `feed_limit`, `feed_email`, `dbprefix` | Перенести: без них предпросмотр выглядит иначе, другие адреса страниц и другое время |
| Сторонние | Любые свойства, которые дописало расширение | неизвестно: брать список разрешённого |

`dbprefix`, `sitename` и другие — не секреты, поэтому читать их надо списком разрешённых имён (не отрицанием), тем же разбором констант. `SiteDatabaseSettings` (`packages/domain/src/preview/recipe.ts`) держит только `tablePrefix`, `charset`, `collation`: для Joomla нужен ещё один набор значений в `SiteFacts`.

Кодировки в файле **нет вообще**: драйвер сам ставит `utf8mb4` (`pkg-6.2.0:libraries/src/Service/Provider/Database.php:109-116`, `pkg-6.2.0:libraries/vendor/joomla/database/src/Mysqli/MysqliDriver.php:800-827`) и падает на `utf8`, только если сервер не умеет. Значение для `databaseSettings`: всегда `charset: 'utf8mb4'`, `collation: 'utf8mb4_unicode_ci'` (так создаёт таблицы `installation/sql/mysql/base.sql`). Таблицы старых сайтов могут быть `utf8_general_ci`, а в 3.x есть таблица `#__utf8_conversion`: фактическую кодировку копии показывает информация о таблицах, а не файл. Договор метода («null — конфигурация их не называет») **не подходит**: для Joomla значение вычисляется, а не читается.

### 4.5. На что влияет `secret`

| Что | Где | Следствие смены в копии |
| --- | --- | --- |
| Имя cookie сессии: `md5(secret . session_name)` | `pkg-6.2.0:libraries/src/Service/Provider/Session.php:303` | Безвредно |
| Токен формы: `md5(secret . userId . sessionToken)` | `pkg-6.2.0:libraries/src/Application/ApplicationHelper.php:75`, `pkg-6.2.0:libraries/src/Session/Session.php` | Безвредно |
| Токен API: `base64("sha256:<id>:" + HMAC(seed, secret))` | `pkg-6.2.0:plugins/api-authentication/token/src/Extension/Token.php:184-205` | Токены прода в копии не работают: так и нужно |
| Кеш: `md5(secret)` в имени файла | `pkg-6.2.0:libraries/src/Cache/CacheStorage.php:103` | Безвредно |
| Шифрование `#__user_mfa` | `pkg-6.2.0:administrator/components/com_users/src/Service/Encrypt.php:127` | Таблицу не копировать |
| WebAuthn | `pkg-6.2.0:plugins/system/webauthn/src/CredentialRepository.php:588` | Таблицу не копировать |
| Капча ALTCHA, 6.x | `pkg-6.2.0:plugins/captcha/powcaptcha/src/Provider/POWCaptchaProvider.php:166,212` | Безвредно |
| Идентификатор сборки медиа | `pkg-6.2.0:libraries/src/Version.php:241` | Безвредно |

В копии `secret` выводить из пароля базы предпросмотра, как ключи `wp-config.php` (`infra/wordpress/preview-wp-config.php`). Для сайтов с пустым `secret` токены API не работают вовсе (`Token.php`: «An empty secret!»).

### 4.6. Где привязан адрес сайта

**Адрес сайта в базе не хранится.** В этом главное отличие от WordPress (`siteurl`, `home`).

| Где | Что | Для копии |
| --- | --- | --- |
| `$_SERVER['HTTP_HOST']` | Основной источник: `Uri::getInstance()` строит адрес из него (`pkg-6.2.0:libraries/src/Uri/Uri.php`), база пути — из `SCRIPT_NAME` | Ничего делать не нужно: копия откроется по своему имени |
| `$live_site` | Необязательный жёсткий адрес, при заполнении **всё строится из него** (`pkg-6.2.0:libraries/src/Uri/Uri.php:134-145`) | В `configuration.php` предпросмотра — пусто |
| `$_SERVER['HTTPS']` и `HTTP_X_FORWARDED_PROTO` | https определяется по ним **без оглядки на `behind_loadbalancer`** (`pkg-6.2.0:libraries/vendor/joomla/application/src/AbstractWebApplication.php:846-857`, `pkg-6.2.0:libraries/src/Uri/Uri.php:66-74`) | Шлюз предпросмотра обязан слать `X-Forwarded-Proto: https`, иначе ссылки станут `http://` |
| `$force_ssl` | 0, 1 — админка, 2 — весь сайт: `pkg-6.2.0:libraries/src/Application/CMSApplication.php:847`, редирект на `https` | В предпросмотре 0 |
| `$cookie_domain`, `$cookie_path` | Cookie привязана к домену прода | В предпросмотре пусто |
| `.htaccess` | `RewriteBase /подпапка/`, редиректы на канонический домен | Копии не читают (`infra/wordpress/preview-apache.conf`) |
| `plg_system_sef` | `{"domain":"","indexphp":"1","trailingslash":"0","enforcesuffix":"1","strictrouting":"1"}` в `#__extensions.params` (`pkg-6.2.0:installation/sql/mysql/base.sql:368`). `domain` — адрес для тега `canonical` (`pkg-6.2.0:plugins/system/sef/src/Extension/Sef.php:187-217`). Остальные ключи — редиректы внутри сайта (`Sef.php:149-164`), домена они не меняют | Обнулить `domain` в копии |
| Содержимое: `#__content.introtext`, `fulltext`, `images`, `#__modules.content`, `#__menu.link`, `#__menu.params` | Встречаются абсолютные адреса, вставленные руками или редактором. Штатно ссылки относительны (`images/...`, `index.php?...`) | Заменить при выдаче, как `raditi-preview.php` у WordPress |
| Подпапка | Определяется автоматически по `SCRIPT_NAME`; `$live_site` при этом не нужен | Предпросмотр всегда корневой: подпапку надо либо снять, либо учесть в заменах |
| Системные плагины и расширения | Плагины редиректов доменов, sh404SEF и др. | Не проверено |

## 5. Где живёт то, что клиент хочет менять

### 5.1. Карта

| Что просит клиент | Где | Форма | Кто меняет |
| --- | --- | --- | --- |
| Текст статьи, «страницы» | `#__content`: `title`, `alias`, `introtext`, `fulltext`, `state`, `catid`, `images` (JSON), `urls` (JSON), `attribs` (JSON), `metadesc`, `metadata` (JSON) | база | через модель, раздел 7 |
| Адрес страницы, пункт меню | `#__menu`: `path`, `alias`, `link` (`index.php?option=com_content&view=article&id=12`), `params` (JSON), `lft`/`rgt`, `home` | база, вложенные множества | только моделью |
| Главная страница | Строка `#__menu` с `home=1` на нужном языке | база | только моделью |
| Блок, HTML-модуль, виджет | `#__modules`: `content` (HTML у `mod_custom`), `params` (JSON), `position`, `published`, плюс привязка к страницам `#__modules_menu` | база | через модель |
| Категории | `#__categories`: `title`, `alias`, `path`, `description`, `lft`/`rgt`, `extension`, `asset_id` | база, вложенные множества | только моделью |
| Цвета, логотип, шрифт шаблона | `#__template_styles.params` (JSON) | база | настройка из закрытого списка |
| Вёрстка, вывод | `templates/<шаблон>/index.php`, `templates/<шаблон>/html/<компонент>/<вид>/*.php` (переопределения), `templates/<шаблон>/html/layouts/` | файлы | **агент кодом** |
| CSS, JS | `templates/<шаблон>/css/` (старый вид) или `media/templates/site/<шаблон>/css/` (шаблоны с 4.1, `user.css`) | файлы | **агент кодом** |
| Подписи интерфейса сайта | `language/overrides/ru-RU.override.ini`, `administrator/language/overrides/ru-RU.override.ini` | файлы INI | агент кодом, или `#__overrider` — служебный поиск |
| Название сайта, описание, режим «сайт выключен», часовой пояс | `configuration.php`: `sitename`, `MetaDesc`, `offline`, `offset` | **файл с секретами** | раздел 12, п. 1 |
| Настройки компонента или плагина | `#__extensions.params` (JSON одной строкой на расширение) | база | только закрытым списком ключей |
| Поля пользовательские | `#__fields`, `#__fields_groups`, `#__fields_categories`, `#__fields_values` | база | через модель |
| Теги | `#__tags` (вложенные множества), `#__contentitem_tag_map` | база | через модель |
| Контакты организации | `#__contact_details` | база | через модель; см. 6.3 |
| Перенаправления | `#__redirect_links` | база | закрыто |
| Письма сайта | `#__mail_templates` | база | закрыто |
| Товары JoomShopping | `#__jshopping_products`: колонки с языком в имени, например `name_ru-RU`, `description_ru-RU` (`ext-joomshopping/src/admin/install/install.sql:26`) | база | отдельная работа, ядро о них не знает |

### 5.2. Что агент делает кодом, а что только базой

| Кодом можно | Только базой (моделью) |
| --- | --- |
| Переопределения `templates/*/html/` | Текст любой статьи, модуля, категории |
| CSS и JS шаблона | Меню и адреса |
| Новые модули, плагины, компоненты в файлах — **но они не заработают без строки в `#__extensions`** (раздел 7.4) | Настройки шаблона, включённые модули, порядок блоков |
| Языковые переопределения | Настройки расширений |

### 5.3. Выгрузка контента в файлы

В ядре механизма нет: у Joomla нет аналога статических элементов MODX. Частичный обход: `mod_custom` с PHP не поддерживается ядром, зато модуль можно заменить кодом через переопределение `templates/<шаблон>/html/mod_custom/default.php`. Это уже правка вёрстки, а не контента.

### 5.4. Статья изнутри: где ломается модель «заголовок, текст, отрывок»

| Поле Радити | В Joomla | Особенность |
| --- | --- | --- |
| `title` | `#__content.title` | совпадает |
| `content` | `articletext`, виртуальное поле: `introtext` + `<hr id="system-readmore">` + `fulltext` (`pkg-6.2.0:administrator/components/com_content/src/Model/ArticleModel.php:417`) | Запись: `Table\Content::bind` режет по регулярному выражению `#<hr\s+id=("\|')system-readmore("\|')\s*\/*>#i` (`pkg-6.2.0:libraries/src/Table/Content.php:151-160`) |
| `excerpt` | Отдельного отрывка нет. `metadesc` — описание для поисковиков, `introtext` — первая часть текста | Либо нет поля, либо `excerpt` = `introtext`, и тогда `content` = только `fulltext`, что расходится с тем, что видит редактор |
| `status: publish` / `draft` | `state`: 1 опубликовано, 0 снято, 2 в архиве, -2 в корзине. Плюс `publish_up`, `publish_down` — отложенная публикация | Плюс этапы workflow, если включены (`workflow_enabled` в параметрах `com_content`) |
| `slug` | `alias`; адрес зависит ещё и от меню | Нет одного поля «адрес» |
| `kind: post` / `page` | Нет деления: всё статьи | `publishedObjectRefSchema` (`packages/domain/src/ports/published-content.ts`) не подходит: `^(post\|page):` |

## 6. База

### 6.1. Таблицы ядра

В 6.2.0 и 5.4.10 — 76 таблиц, наборы одинаковые. В 4.4.14 нет `scheduler_logs`, `schemaorg`, `tuf_metadata`. В 3.10.12 — 78 таблиц, в их числе `finder_links_terms0…f`, `ucm_history`, `utf8_conversion`, `core_log_searches`, но нет `workflow*`, `mail_templates`, `scheduler_*`, `guidedtours`, `user_mfa`, `webauthn_credentials`, `history` (`cms-3.10.12:installation/sql/mysql/joomla.sql`, `pkg-6.2.0:installation/sql/mysql/{base,extensions,supports}.sql`). Все создаются одной кодировкой `utf8mb4_unicode_ci`, InnoDB.

В SQL ядра префикс записан `#__`; при установке он заменяется (`$db->replacePrefix`). Таблицы расширений имеют тот же префикс: `jos_jshopping_orders`.

**Разделение ниже — по чтению кода и схем, запуском не проверялось.** Правило копирования: всё, чего нет в списке, — только структура (`packages/domain/src/preview/recipe.ts`, `databaseCopyPolicySchema`).

| Группа | Таблицы | В копии |
| --- | --- | --- |
| Каркас, без строк сайт не запустится | `extensions`, `assets`, `languages`, `menu`, `menu_types`, `modules`, `modules_menu`, `template_styles`, `usergroups`, `viewlevels`, `schemas`, `content_types` | Все строки; `extensions.params`, `extensions.custom_data`, `modules.params`, `template_styles.params` — `scrub_secrets` |
| Контент | `content`, `content_frontpage`, `categories`, `tags`, `contentitem_tag_map`, `fields`, `fields_groups`, `fields_categories`, `fields_values`, `ucm_base`, `ucm_content`, `associations`, `schemaorg`, `newsfeeds`, `banners` | Строки; см. фильтры 6.3 |
| Workflow, **обязательны для списка статей** | `workflows`, `workflow_stages`, `workflow_transitions`, `workflow_associations` | Все; у `workflow_associations` — по скопированным статьям. Без строки статья на сайте есть, а в списке админки её **нет**: запрос идёт через `INNER JOIN` (`pkg-6.2.0:administrator/components/com_content/src/Model/ArticlesModel.php:279-281`) |
| Служебные пустые | `session`, `updates`, `update_sites`, `update_sites_extensions`, `tuf_metadata`, `postinstall_messages`, `overrider`, `finder_*`, `guidedtours`, `guidedtour_steps`, `template_overrides`, `action_log_config`, `action_logs_extensions`, `mail_templates`, `redirect_links` | Только структура, кроме случая, когда нужна работа соответствующего экрана: `action_log_config`, `action_logs_extensions`, `mail_templates` — справочники ядра, в них нет людей, но их параметры надо обрабатывать `scrub_secrets` |

### 6.2. Персональные данные и секреты

| Таблица | Колонки | Что |
| --- | --- | --- |
| `users` | `name`, `username`, `email`, `password`, `activation`, `params`, `otpKey`, `otep`, `lastvisitDate`, `registerDate`, `authProvider` | Люди и секреты |
| `user_profiles` | `profile_key`, `profile_value` | Адреса, телефоны, **и токены API: ключи `joomlatoken.token`, `joomlatoken.enabled`** |
| `user_keys` | `token`, `series`, `uastring` | Запомнить меня |
| `user_mfa`, `webauthn_credentials` | `options`, `credential` | Вторые факторы, зашифрованы `secret` |
| `user_notes` | `subject`, `body` | Заметки о людях |
| `session` | `data`, `username`, `userid` | Сессии с данными: **не копировать** |
| `action_logs` | `message`, `ip_address`, `user_id` | Журнал действий с IP |
| `action_logs_users` | | |
| `privacy_requests`, `privacy_consents` | `email`, `confirm_token`, `body`, `token` | Запросы и согласия |
| `messages`, `messages_cfg` | `subject`, `message` | Внутренняя почта |
| `banner_clients` | `name`, `contact`, `email`, `extrainfo` | Рекламодатели |
| `contact_details` | `name`, `address`, `telephone`, `mobile`, `fax`, `email_to`, `user_id`, `image` | Контакты: могут быть организацией, а могут — конкретным человеком |
| `content` | `created_by_alias`, `metadata` (JSON с ключом `author`), `created_by`, `modified_by` | Подпись автора |
| `content_rating` | `lastip` | IP |
| `redirect_links` | `referer`, `old_url` | Адреса, в которых бывают данные |
| `history` | `version_data`, `editor_user_id` | Полные JSON прошлых версий: в том числе то, что удалили с сайта |
| `ucm_content` | `core_created_by_alias`, `core_body` | Дубли контента |
| `finder_*` | | Индекс поиска |
| `scheduler_logs` | | Журнал задач |
| JoomShopping | `jshopping_orders`, `jshopping_order_item`, `jshopping_order_history`, `jshopping_users`, `jshopping_cart_temp`, `jshopping_products_reviews`, `jshopping_payment_trx`, `jshopping_payment_trx_data` | Заказы и покупатели: `f_name`, `l_name`, `email`, `phone`, `street`, `ip_address` (`ext-joomshopping/src/admin/install/install.sql:435-467`) |

Секреты в базе:

| Где | Ключ | Источник |
| --- | --- | --- |
| `#__update_sites.extra_query`, `#__updates.extra_query` | **Ключи загрузки платных расширений:** значение между `prefix` и `suffix` из тега `<dlid>` манифеста, обычно `dlid=…`. Это строка запроса, а не JSON: `scrub_secrets` её не тронет. Значит только структура таблицы | `pkg-6.2.0:installation/sql/mysql/base.sql:877,918`, `pkg-6.2.0:administrator/components/com_installer/src/Helper/InstallerHelper.php:257-265` |
| `#__extensions.params` для `com_joomlaupdate` | `update_token` — токен автообновления ядра, с 5.4 | `pkg-6.2.0:administrator/components/com_joomlaupdate/config.xml:101` |
| `#__extensions.params` для `plg_authentication_ldap` | `username`, `password` | `pkg-6.2.0:plugins/authentication/ldap/ldap.xml:135-143` |
| `#__extensions.params` для `plg_multifactorauth_yubikey` | `secret` | `pkg-6.2.0:plugins/multifactorauth/yubikey/src/Extension/Yubikey.php:334` |
| `#__extensions.params` для `plg_captcha_recaptcha`, `plg_captcha_recaptcha_invisible` | `private_key`. В пакетах 5.4.10 и 6.2.0 этих плагинов нет, но на сайтах, обновлённых с 4.x, строка может остаться | `cms-4.4.14:plugins/captcha/recaptcha/recaptcha.xml:45` |
| `#__scheduler_tasks.params` | `authKey` у `plg_task_requests` | `pkg-6.2.0:plugins/task/requests/forms/get_requests.xml:47` |
| `#__mail_templates.params` | Своя почта шаблона, поле пароля | `pkg-6.2.0:administrator/components/com_mails/forms/template.xml:192` |
| `#__jshopping_payment_method.payment_params` | JSON с ключами платёжных систем, в том числе ЮKassa ([модуль YooMoney](https://github.com/yoomoney/cms-joomshopping)) | `ext-joomshopping/src/site/Table/PaymentMethodTable.php:64,179` |

`scrub_secrets` (`packages/site-connections/src/database-copy/nested-secrets.ts`): регулярное выражение покрывает `update_token`, `private_key`, `password`, `secret`, `authKey`. Названия `username`, `smtpuser` и `dlid` под него не попадают.

### 6.3. Обезличивание: черновик правил

| Таблица | Условие | Колонки |
| --- | --- | --- |
| `users` | `inCopied(id, content, created_by)` | `name`: `synthetic_name`; `username`: `synthetic_login`; `email`: `synthetic_email`; `password`: `random_password_hash`; `activation`, `params`, `otpKey`, `otep`, `authProvider`: `empty`; `lastvisitDate`, `lastResetTime`: `null` |
| `content` | `state IN (0, 1, 2)` | `created_by_alias`: `empty`; `metadata`: требуется новая обработка: **ключ `author`** не секрет и `scrub_secrets` его не очистит |
| `workflow_associations` | `inCopied(item_id, content, id)` и `extension = 'com_content.article'` | |
| `content_frontpage` | `inCopied(content_id, content, id)` | |
| `contentitem_tag_map` | `inCopied(content_item_id, content, id)`; типы `com_content.article`, `com_content.category` | |
| `fields_values` | Условие: значение может быть привязано к пользователю (`context = com_users.user`). Нужно фильтровать через `fields.context`: связка `inCopied` этого не выразит напрямую | |
| `user_usergroup_map` | Только скопированные пользователи | Без групп |
| `extensions` | Все | `params`, `custom_data`: `scrub_secrets` |
| `assets` | Все | Имена содержат названия статей, не людей |

`randomPasswordHash` копировщика даёт строку `$P$B…` длиной 35 (`packages/site-connections/src/database-copy/mysql-copier.ts:457`). `UserHelper::verifyPassword` разберёт её как phpass, и пароль не подойдёт (`pkg-6.2.0:libraries/src/User/UserHelper.php:469-476`); длина укладывается в `varchar(100)`. Обработка годится без изменений.

Переопределения копии (`overrides`). Договор позволяет и менять строку, и добавлять, и удалять. Сопоставлять удобно по `extensions.name`.

| Что | Зачем |
| --- | --- |
| `plg_system_cache`: `enabled = 0` | Кеш страниц работает **независимо от `$caching`** (`pkg-6.2.0:plugins/system/cache/src/Extension/Cache.php:166`), копия показывала бы старое |
| `plg_system_schedulerunner`: `enabled = 0` | Иначе задачи запускает посещение страницы: на каждой странице скрипт ленивого планировщика (`pkg-6.2.0:plugins/system/schedulerunner/src/Extension/ScheduleRunner.php:35,109-124`). Дополнительно не копировать `scheduler_tasks` |
| `plg_system_sef`: `domain` обнулить | Иначе `canonical` указывает на прод |
| `plg_system_stats`, `plg_system_privacyconsent`, `plg_user_terms` | Первый отправляет статистику наружу; второй на фронте уводит вошедшего на профиль (`pkg-6.2.0:plugins/system/privacyconsent/src/Extension/PrivacyConsent.php:266-300`). Третий не проверялся |
| `com_users`: снять `forceMFAUserGroups` | Иначе учётная запись платформы при входе уйдёт на обязательную настройку 2FA (`pkg-6.2.0:libraries/src/Application/MultiFactorAuthenticationHandler.php:104,153`). **`set` заменяет значение колонки целиком**: нужно либо менять весь JSON, либо новая операция правки ключа |
| Строка расширения платформы | Договор позволяет добавить: раздел 7.4. Значения `set` ограничены 1 024 символами |

### 6.4. Администратор в копии без браузера

| Способ | Ветки | Как |
| --- | --- | --- |
| Команда | ≥ 4.0 | `php cli/joomla.php user:add --username=raditi-platform --name=Raditi --email=platform@preview.invalid --password=… --usergroup='Super Users' -n`. **Пароль идёт аргументом**; `user:reset-password` — то же. Название группы зависит от базы: у сайта группу могли переименовать |
| SQL | все | Одна строка `#__users` и одна `#__user_usergroup_map`. Минимум колонок без значения по умолчанию: `name`, `username`, `email`, `password`, `block=0`, `registerDate`, `activation=''`, `params='{}'`, `requireReset=0` |

Хеш: `password_hash($p, PASSWORD_BCRYPT)` даёт `$2y$…`, по умолчанию в `UserHelper::hashPassword`; при входе проверка идёт по префиксу: `$2`, `$argon2id`, `$argon2i`, `$P$`, иначе цепочка старых алгоритмов (`pkg-6.2.0:libraries/src/User/UserHelper.php:438-510`).

Номер группы: у ядра `8` — Super Users (`pkg-6.2.0:installation/sql/mysql/base.sql:987`), но права определяет не номер, а `core.admin` в корневой строке `#__assets`. Надёжнее читать группу с `core.admin = 1` из `assets.rules` строки `root.1`.

Запасной способ: свойство `$root_user` в `JConfig` делает пользователя супер-пользователем без групп (`pkg-6.2.0:libraries/src/User/User.php:394-400`, `pkg-6.2.0:libraries/src/Access/Access.php:965-967`). Пишем `configuration.php` сами, значит можем использовать, но при каждом входе админка показывает предупреждение `JWARNING_REMOVE_ROOT_USER`.

Токен API в копии. `#__user_profiles`: `(id, 'joomlatoken.token', base64(32 случайных байта))`, `(id, 'joomlatoken.enabled', 1)`. Значение для запросов: `base64_encode("sha256:$id:" . hash_hmac('sha256', base64_decode($seed), $secret))` (`pkg-6.2.0:plugins/user/token/src/Field/JoomlatokenField.php:106-115`, `pkg-6.2.0:plugins/user/token/src/Extension/Token.php:66,448`). Пользователь должен входить в `allowedUserGroups`, по умолчанию `[8]` (`Token.php:489`). Поддерживается `sha256` и `sha512` (`pkg-6.2.0:plugins/api-authentication/token/src/Extension/Token.php:50`).

### 6.5. Команды консоли

`php cli/joomla.php <команда>`, ≥ 4.0. Перечень из `pkg-6.2.0:libraries/src/Console/` и кода установщика. Нужен `configuration.php`, иначе «Install Joomla to run cli commands» (`pkg-6.2.0:cli/joomla.php:49-58`). В 3.10 этого файла нет, только `cli/garbagecron.php`, `cli/sessionGc.php`, `cli/sessionMetadataGc.php`, `cli/finder_indexer.php`, `cli/update_cron.php`, `cli/deletefiles.php`.

| Группа | Команды |
| --- | --- |
| Кеш, сессии | `cache:clean [expired]`, `session:gc`, `session:metadata:gc` |
| Конфигурация | `config:get`, `config:set`, `site:down`, `site:up`, `site:create-public-folder` |
| Расширения | `extension:install --path\|--url`, `extension:remove`, `extension:list`, `extension:enable`, `extension:disable`, `extension:discover`, `extension:discover:list`, `extension:discover:install --eid` |
| Пользователи | `user:add`, `user:delete`, `user:list`, `user:reset-password`, `user:addtogroup`, `user:removefromgroup` |
| Ядро | `core:update`, `core:update:check`, `core:update:channel`, `core:autoupdate:register`, `core:autoupdate:unregister`, `update:extensions:check`, `update:joomla:remove-old-files`, `maintenance:database --fix` |
| Планировщик, поиск | `scheduler:list`, `scheduler:run`, `scheduler:state`, `finder:index` |

Список извлечён из `$defaultName` файлов `pkg-6.2.0:libraries/src/Console/*.php`; набор команд в 4.x и 5.x надо сверять по своей ветке. `config:set` перезаписывает `configuration.php`.

`--live-site=<адрес>` — консольная опция для генерации ссылок (`pkg-6.2.0:libraries/src/Application/ConsoleApplication.php:500-506`).

## 7. Программный доступ

### 7.1. Web Services API (≥ 4.0)

| Что | Значение |
| --- | --- |
| Точка входа | `/api/index.php/v1/...`; с правилами `htaccess.txt` — `/api/v1/...` |
| Заголовки | `X-Joomla-Token: <токен>` или `Authorization: Bearer <токен>`; `Accept: application/vnd.api+json` (иначе 406, `pkg-6.2.0:libraries/src/Application/ApiApplication.php:276-284`); `Content-Type: application/json` |
| Вход | Плагины группы `api-authentication`. `token` включён, `basic` выключен (`pkg-6.2.0:installation/sql/mysql/base.sql:260-261`). Cookie сессии не принимается: `login(['username'=>''], ['action'=>'core.login.api'])` идёт через эти плагины |
| Кому | Токен есть у групп из `allowedUserGroups`, по умолчанию только Super Users. Manual: «Super User или минимум `core.login.api` и `core.login.site`» ([Manual](https://manual.joomla.org/docs/general-concepts/webservices/)) |
| Включено ли | `plg_webservices_content`, `plg_user_token`, `plg_api-authentication_token` включены и при новой установке, и при обновлении с 3.x (`cms-4.4.14:administrator/components/com_admin/sql/updates/mysql/4.0.0-2019-03-09.sql:11`, `4.0.0-2020-02-02.sql:10-11`). Токен каждый супер-пользователь создаёт себе сам в профиле |
| Ошибки | JSON:API |

Маршруты 6.2.0 (`plugins/webservices/*`): `v1/content/articles`, `v1/content/categories`, `v1/content/articles/:id/contenthistory`, `v1/fields/content/articles`, `v1/fields/groups/content/articles`, `v1/menus/site`, `v1/menus/site/items`, `v1/menus/site/items/types`, `v1/modules/site`, `v1/modules/types/site`, `v1/media/adapters`, `v1/media/files`, `v1/tags`, `v1/templates/styles/site`, `v1/languages`, `v1/languages/content`, `v1/languages/overrides/site/`, `v1/redirects`, `v1/plugins`, `v1/extensions`, `v1/users`, `v1/users/groups`, `v1/users/levels`, `v1/messages`, `v1/config/application`, `v1/config/:component_name`, `v1/contacts`, `v1/banners`, `v1/newsfeeds/feeds`, `v1/privacy/requests`, `v1/privacy/consents`, `v1/joomlaupdate/healthcheck`.

Статьи: `createCRUDRoutes` даёт `GET` список и элемент, `POST`, `PATCH /:id`, `DELETE /:id` (`pkg-6.2.0:libraries/src/Router/ApiRouter.php:64-80`). Поля ответа: `id`, `asset_id`, `title`, `text`, `introtext`, `fulltext`, `tags`, `language`, `state`, `category`, `images`, `metakey`, `metadesc`, `metadata`, `access`, `featured`, `alias`, `note`, `publish_up`, `publish_down`, `urls`, `created`, `created_by`, `created_by_alias`, `modified`, `modified_by`, `hits`, `version`, `featured_up`, `featured_down`, `schemaorg` (`pkg-6.2.0:api/components/com_content/src/View/Articles/JsonapiView.php:41-84`). `text` — объединение через пробел, помечено устаревшим с 6.2.0 и будет снято в 8.0. Ответ проходит плагины контента. Запись идёт через `articletext`.

Ограничение для нашей модели: API нужен супер-пользователь сайта и его токен. В 3.10 API нет вовсе (в UTD есть свой MCP).

### 7.2. Один файл PHP с ядром внутри

Код прочитан, **не запускался**.

Пересказ порядка шагов, ветки 5.x и 6.x, файл лежит в корне сайта:

1. Задать `_JEXEC` и `JPATH_BASE`, подключить `includes/defines.php` и `includes/framework.php`.
2. Взять контейнер методом `Joomla\CMS\Factory::getContainer` и дать псевдонимы сессии: `session.web`, `session` и классы сессии ведут на `session.web.administrator`.
3. Получить из контейнера `Joomla\CMS\Application\AdministratorApplication` и записать его в `Factory::$application`.
4. Через `bootComponent` компонента `com_content`, `getMVCFactory` и `createModel` получить модель `Article` с префиксом `Administrator` и настройкой `ignore_request`.
5. Читать запись методом `getItem`, сохранять методом `save` с полями `id`, `title`, `articletext`, `catid`.















| Ветка | Отличие |
| --- | --- |
| 5.x, 6.x | Выше. Алиасы взяты из `pkg-6.2.0:administrator/includes/app.php:36-48`. `JPATH_BASE` должен указывать туда же, откуда стартует приложение; для `administrator` — на `administrator/`: см. `pkg-6.2.0:administrator/includes/defines.php`, разделы путей там свои. Самый прямой путь: положить файл в `administrator/` и использовать `administrator/includes/{defines,framework}.php` |
| 4.x | В `includes/app.php` есть `_JDEFINES`; иначе так же (`cms-4.4.14:includes/app.php`) |
| 3.x | Классы: `JFactory::getApplication('administrator')`, `JModelLegacy::addIncludePath(...)`, `JTable::getInstance('Content')`. Пример запуска без веб-слоя — `cms-3.10.12:cli/garbagecron.php`: `import.legacy.php`, `cms.php`, `JApplicationCli` |

`model->save()` делает всё сразу: `#__assets`, `version`, `#__history`, теги, workflow, события плагинов. Прямой `UPDATE #__content` работает для текста, но пропускает версии, поиск, кеш, плагины; прямой `INSERT` оставляет статью невидимой в админке (нет `workflow_associations`) и без `asset_id`.

Права и фильтры: в `AdminModel::save` нет ни `authorise`, ни проверки формы (`pkg-6.2.0:libraries/src/MVC/Model/AdminModel.php`, метод целиком, 188 строк); права проверяет контроллер (`FormController::allowEdit`), а `ComponentHelper::filterText` стоит на поле формы (`pkg-6.2.0:administrator/components/com_content/forms/article.xml:56`). Такой вызов — доверенный код: он пишет в обход фильтра HTML по группам пользователей, поэтому значение от агента надо проверять самому.

Консоль кода на лету не исполняет: аналога `wp eval` нет. Договор `previewContentRecipeSchema` (16 аргументов по 4 096 знаков) на `php -r` не рассчитан: нужен файл-команда, который пишет `generatedFiles`, например `cli/raditi.php`.

### 7.3. Модель расширений

| Тип | Где | Манифест | Заметка |
| --- | --- | --- | --- |
| `component` | `components/com_x/`, `administrator/components/com_x/`, `api/components/com_x/` | `x.xml` | Свои таблицы, свой `option` |
| `module` | `modules/mod_x/`, `administrator/modules/mod_x/` | `mod_x.xml` | Экземпляры — строки `#__modules` |
| `plugin` | `plugins/<группа>/<имя>/` | `<имя>.xml` | События: `system`, `content`, `user`, `webservices`, `task`, … |
| `template` | `templates/<имя>/`, `administrator/templates/<имя>/` | `templateDetails.xml` | |
| `library` | `libraries/<имя>/` | `administrator/manifests/libraries/` | |
| `language` | `language/<тег>/` | `<тег>/langmetadata.xml` или `install.xml` | |
| `file` | произвольно | `administrator/manifests/files/` | Ядро само — `files_joomla` |
| `package` | | `administrator/manifests/packages/` | Набор расширений |

Новый плагин 4.x и новее: `plugins/system/raditi/{raditi.xml, services/provider.php, src/Extension/Raditi.php}` (образец: `pkg-6.2.0:plugins/system/shortcut/`). Старый вид `plugins/system/raditi/raditi.php` с классом `PlgSystemRaditi` по-прежнему загружается и в 6.2.0 (`pkg-6.2.0:libraries/src/Extension/ExtensionManagerTrait.php`, `loadPluginFromFilesystem`), поэтому один файл может работать на всех ветках.

### 7.4. Как поставить без браузера. Можно ли один файл без регистрации

| Способ | Ветки | Что нужно |
| --- | --- | --- |
| `php cli/joomla.php extension:install --path=/путь/x.zip` | ≥ 4.0 | SSH и PHP на хостинге |
| Положить файлы, потом `extension:discover`, `extension:discover:install --eid=…`, `extension:enable` | ≥ 4.0 | То же; ядро находит манифесты само (`pkg-6.2.0:libraries/src/Installer/Adapter/PluginAdapter.php`, `discover`) |
| `INSERT` в `#__extensions` | все | Доступ к БД. Загрузчик читает только `enabled=1`, `type='plugin'`, `state IN (0,1)`, уровень доступа (`pkg-6.2.0:libraries/src/Plugin/PluginHelper.php`, `load`). Минимальные колонки: `name`, `type`, `element`, `folder`, `client_id`, `enabled`, `access`, `manifest_cache`, `params`, `custom_data` |
| **Один файл в корне, с запуском ядра** | все | Только запись файла по SFTP или FTP. Без строки в базе. Сам проверяет токен, загружает ядро, как в 7.2 |

**Аналога `mu-plugins` нет:** ни один каталог не подключается без строки в базе. Для предпросмотра есть обход, которого нет на проде: Apache предпросмотра наш, значит `php_admin_value auto_prepend_file` может подключить файл до `index.php` и выставить `ob_start` для подмены адресов. Способ выведен из чтения, не проверялся.

Для прода по FTP без SSH и без БД единственный путь без браузера — файл `raditi-content.php` в корне: адаптер не сможет полагаться на плагин. Файл должен быть доступен снаружи, защищён своим токеном и пережить `RewriteCond %{REQUEST_FILENAME} !-f` (правила `htaccess.txt` существующие файлы пропускают). У многих хостингов и правил безопасности такой файл может быть закрыт — **не проверено**.

## 8. Админка

### 8.1. Вход

| Что | Значение |
| --- | --- |
| Путь | `/administrator/` — `/administrator/index.php`. **Штатно не переименовывается:** `JPATH_ADMINISTRATOR` — папка, адреса строятся от `SCRIPT_NAME`, настройки нет. Дополнительная защита — вне ядра: Basic-аутентификация, сторонние плагины с «секретным словом» (не проверено) |
| Адрес формы | **Любой адрес под `/administrator/`.** Гостю `findOption()` подменяет `option` на `com_login` без редиректа, а адрес в браузере не меняется (`pkg-6.2.0:libraries/src/Application/AdministratorApplication.php`, `findOption`). Форма может быть на `/administrator/index.php?option=com_content&view=articles` |
| Форма | `form#form-login`, метод POST, действие `index.php` |
| Логин | `input[name="username"]#mod-login-username` |
| Пароль | `input[name="passwd"]#mod-login-password` — **`passwd`, не `password`** |
| Кнопка | 4.x–6.x: `button#btn-login-submit`, текст `JLOGIN`: «Log in» / «Войти» |
| Скрытые | `option=com_login`, `task=login`, `return`, токен CSRF |
| Язык | `select[name="lang"]`, только если установлено больше одного языка админки (`pkg-6.2.0:administrator/modules/mod_login/src/Helper/LoginHelper.php:42-64`) |
| 3.10 | `input[name="username"]`, `input[name="passwd"]`, `input[name="secretkey"]#mod-login-secretkey` (код 2FA), форма `#form-login`; кнопка без `id`: `button.login-button`, текст `MOD_LOGIN_LOGIN` (`cms-3.10.12:administrator/modules/mod_login/tmpl/default.php:21-100`) |
| CSRF | `<input type="hidden" name="<md5>" value="1">`: имя поля — хеш, значение `1` (`pkg-6.2.0:libraries/src/HTML/Helpers/Form.php`, `token`; `pkg-6.2.0:libraries/src/Session/Session.php`, `getFormToken`). В JavaScript токен лежит в `Joomla.getOptions('csrf.token')` (`pkg-6.2.0:media/system/js/core.js:638`), сервер принимает заголовок `X-CSRF-Token` (`pkg-6.2.0:libraries/src/Session/Session.php:70`) |
| Капча | В форме админки ядра капчи нет (`administrator/modules/mod_login`, `com_login`: совпадений нет) |
| 2FA, ≥ 4.2 | После входа — редирект 307 на `index.php?option=com_users&view=captive` (`pkg-6.2.0:libraries/src/Application/MultiFactorAuthenticationHandler.php:146`). Поле `input[name="code"]#users-mfa-code`, кнопка `#users-mfa-captive-button-submit`, форма `#users-mfa-captive-form`. Способы: `totp`, `email`, `fixed`, `webauthn`, `yubikey` (`plugins/multifactorauth/`) |
| Обязательная смена пароля | `requireReset` уводит на `com_users&task=user.edit` |
| Обязательная настройка 2FA | `forceMFAUserGroups` в `com_users`: `com_users&view=methods` |
| Вход фронта | Другая форма: `password`, не `passwd`; `task=user.login`. Сессии админки и фронта **раздельные**: имя cookie из `md5(secret . 'administrator')` и `md5(secret . 'site')`, пока не включён `shared_session` |

Для `signIn`: `login: '#mod-login-username'`, `password: '#mod-login-password'`, `submit: '#btn-login-submit'`, для 3.x `'#form-login button.login-button'`. `isSignInPage(path)` по адресу решить нельзя (раздел 12).

### 8.2. Экраны

Все идут через один файл: `/administrator/index.php?option=<компонент>&view=<вид>&task=<задача>`. Значения можно передать и в POST.

| Экран | Адрес |
| --- | --- |
| Список статей | `option=com_content&view=articles` |
| Новая статья | `option=com_content&task=article.add` |
| Редактор | `option=com_content&task=article.edit&id={id}` → редирект на `view=article&layout=edit&id={id}` |
| Категории | `option=com_categories&view=categories&extension=com_content` |
| Меню | `option=com_menus&view=menus`; пункты `option=com_menus&view=items&menutype=<тип>` |
| Модули | `option=com_modules&view=modules&client_id=0` |
| Медиа | `option=com_media` |
| Теги | `option=com_tags&view=tags` |
| Пользователи | `option=com_users&view=users`, также `view=groups`, `levels`, `notes` |
| Контакты | `option=com_contact&view=contacts` |
| Заказы | В ядре нет. JoomShopping: `option=com_jshopping&controller=orders` (образец маршрута `controller=orderstatus` подтверждён, сам `orders` — нет) |
| Общие настройки | `option=com_config` |
| Настройки компонента | `option=com_config&view=component&component=com_content` |
| Расширения | `option=com_installer&view=install`, `manage`, `update`, `discover`, `database`, `warnings`, `languages`, `updatesites` |
| Плагины | `option=com_plugins&view=plugins` |
| Стили шаблонов | `option=com_templates&view=styles&client_id=0` |
| **Редактор файлов шаблона** | `option=com_templates&view=templates`, далее `view=template&id={extension_id}`: **правка PHP из браузера, аналог консоли** |
| Обновление ядра | `option=com_joomlaupdate` |
| Сведения о системе | `option=com_admin&view=sysinfo` |
| Кеш, блокировки | `option=com_cache`, `option=com_checkin` |
| Журнал, приватность | `option=com_actionlogs&view=actionlogs`, `option=com_privacy&view=requests`, `view=consents` |
| Планировщик, письма, редиректы | `option=com_scheduler&view=tasks`, `option=com_mails&view=templates`, `option=com_redirect&view=links` |
| Бэкап | В ядре нет. Akeeba: `option=com_akeebabackup` или `option=com_akeeba` |
| Консоль SQL | В ядре нет |

**Фронтовая поверхность.** Войдя на сайт, супер-пользователь редактирует и там: `index.php?option=com_content&view=form&layout=edit&a_id={id}`, а `components/com_config` — настройки сайта и шаблона на фронте (`index.php?option=com_config&view=config`, `view=templates`). Плюс `components/com_users`, `com_media`, `com_modules`. Политика браузера должна закрывать и их.

### 8.3. Редактор статьи

| Что | 4.x–6.x | 3.10 |
| --- | --- | --- |
| Форма | `form#item-form[name="adminForm"]` | то же |
| Заголовок | `#jform_title`, `jform[title]` | то же |
| Псевдоним | `#jform_alias`, `jform[alias]` | то же |
| Текст | `jform[articletext]`, `#jform_articletext`; при TinyMCE правка в iframe, textarea скрыта | то же |
| Статус | `select#jform_state`, `jform[state]`: 1, 0, 2, -2 | то же |
| Категория | `#jform_catid` | то же |
| Сохранить | `joomla-toolbar-button#toolbar-apply`, внутри `button`; задача `article.apply` | `#toolbar-apply button`, `onclick` с `Joomla.submitbutton('article.apply')` |
| Сохранить и закрыть | Внутри выпадающего `#toolbar-save-group`: `article.save` | `#toolbar-save button` |
| Сохранить и создать | `article.save2new` | `#toolbar-save-new button` |
| Копия | `article.save2copy` | `#toolbar-save-copy button` |
| Отмена | `article.cancel` | `#toolbar-cancel button` |

`id` кнопки: `<имя панели>-<имя кнопки>` (`pkg-6.2.0:libraries/src/Toolbar/ToolbarButton.php:219-222`), выпадающие группы содержат `group` и выводят `<a class="dropdown-item">` (`pkg-6.2.0:layouts/joomla/toolbar/standard.php`). Точных `id` дочерних кнопок группы `ensureUniqueId` запуском не подтверждал.

Тексты (`administrator/language/en-GB/joomla.ini`, `ru-RU-pack`, 6.2.0.1):

| Ключ | Английский | Русский | Действие |
| --- | --- | --- | --- |
| `JTOOLBAR_APPLY` | Save | Сохранить | `save` |
| `JTOOLBAR_SAVE` | Save & Close | Сохранить и закрыть | `save` |
| `JTOOLBAR_SAVE_AND_NEW` | Save & New | Сохранить и создать | `save` |
| `JTOOLBAR_SAVE_AS_COPY` | Save as Copy | Сохранить как копию | `save`, новый объект |
| `JTOOLBAR_CANCEL` | Cancel | Отменить | нет |
| `JTOOLBAR_CLOSE` | Close | Закрыть | нет |
| `JTOOLBAR_NEW` | New | Создать | нет |
| `JTOOLBAR_PUBLISH` | Publish | Опубликовать | `publish`, но это **массовое действие списка** |
| `JTOOLBAR_TRASH` | Trash | В корзину | закрыть агенту |
| `JTOOLBAR_EMPTY_TRASH` | Empty Trash | Очистить корзину | закрыть всем |
| `JLOGIN` | Log in | Войти | |
| `JGLOBAL_USERNAME` | Username | Логин | |
| `JGLOBAL_PASSWORD` | Password | Пароль | |

Отдельной кнопки «Опубликовать» в редакторе нет. Публикует поле «Статус» и обычное сохранение: `browserCommitAction` не отличит `publish` от `save` по названию.

### 8.4. Блокировка записи

`task=article.edit` — **GET-запрос, меняющий базу**: ставит `checked_out` и `checked_out_time` (`pkg-6.2.0:libraries/src/MVC/Controller/FormController.php:371-395`). Снимается только через «Закрыть»/«Отменить» (`article.cancel`) или `com_checkin`. Без выхода статья остаётся заблокированной агентом: другому редактору покажет замок.

Прямой заход на `view=article&layout=edit&id=N` без предварительного `task=article.edit` не откроет форму: редирект на список с ошибкой `JLIB_APPLICATION_ERROR_UNHELD_ID` (`pkg-6.2.0:administrator/components/com_content/src/Controller/DisplayController.php`). Отсюда: `editUrl` чекпоинта — только адрес с `task=article.edit`.

### 8.5. Проверка GET-запросом

Договор: только GET, тело текстом или JSON (`packages/domain/src/browser/checkpoint.ts`, `isBrowserVerificationPlan`). Проверять нельзя через `task=article.edit`: это запись. Вариант:

`GET /administrator/index.php?option=com_content&view=articles&filter[search]=id:{id}&filter[published]=*&list[limit]=5`

Поиск `id:N` — штатный (`pkg-6.2.0:administrator/components/com_content/src/Model/ArticlesModel.php:469`). В ответе HTML: строка таблицы со ссылкой `task=article.edit&id={id}`, заголовком и кнопкой состояния. Недостаток: фильтр остаётся в сессии пользователя. Разбор кнопки состояния на 4.x–6.x и 3.x различается, надо брать фикстуры с живой админки.

JSON в админке `com_content` не отдаёт, а API сессионной cookie не принимает.

Другой путь: `GET /index.php?option=com_content&view=article&id={id}` у сайта покажет статью, но только опубликованную и если сессия фронта есть для закрытых.

### 8.6. Что опасно давать агенту

Запрещающего списка не хватит: **любое расширение отвечает на `option=com_*`**, значит нужен разрешающий список.

| Разрешить агенту | Условие |
| --- | --- |
| `com_login` | Только `task=login`, `task=logout` |
| `com_cpanel` | Просмотр |
| `com_content` | `view=articles`, `view=article`, `task=article.*`; без `articles.delete`, `articles.trash` |
| `com_categories` | Только `extension=com_content`, только просмотр и создание |
| `com_media` | Просмотр и загрузка; `task=api.files` с HTTP-методом `DELETE` закрыть. `POST` и `PUT` идут по тому же адресу (`pkg-6.2.0:administrator/components/com_media/src/Controller/ApiController.php:48-90`), метод виден только в запросе |
| `com_ajax` | Только пустой запрос `option=com_ajax&format=json`: это keepalive (`pkg-6.2.0:libraries/src/WebAsset/AssetItem/KeepaliveAssetItem.php:58`). С параметрами `plugin`, `module` он вызывает код расширений |
| `com_users` | Только для 2FA клиента: `view=captive`, `task=captive.validate`; смена пароля при `requireReset` |

Клиенту, взявшему управление, можно перенести статью в корзину (`articles.trash`), как у WordPress по решению Б37; `articles.delete` и «Очистить корзину» закрыты всем.

Закрыть всем: `com_config`, `com_installer`, `com_plugins`, `com_templates`, `com_joomlaupdate`, `com_admin`, `com_users` (кроме строки выше), `com_actionlogs`, `com_privacy`, `com_mails`, `com_scheduler`, `com_redirect`, `com_checkin`, `com_cache`, `com_languages`, `com_messages`, `com_contact`, `com_banners`, а также все сторонние: `com_jshopping`, `com_virtuemart`, `com_akeeba*`.

Разбор запроса: `option` берётся из запроса и нижним регистром (`strtolower`, `findOption`), значит сравнивать без регистра. Значения могут быть и в POST: смотреть `postData`. Пустой `option` у вошедшего — `com_cpanel`.

## 9. Проверка сайта после выпуска

### 9.1. Страницы

| Что | Значение |
| --- | --- |
| Обязательная | Главная: `new URL(site.url).pathname`. Подпапка определяется сама |
| Статья по номеру | `{front}index.php?option=com_content&view=article&id={id}`: работает при любых настройках ЧПУ. `plg_system_sef` с `strictrouting=1` редиректит на канонический адрес внутри сайта (`pkg-6.2.0:plugins/system/sef/src/Extension/Sef.php:164`), и проверка выпуска редирект внутри сайта уже проходит (`packages/domain/src/ports/site-adapter.ts`, `SiteHttpResponse.location`) |
| Многоязычный сайт | Плагин `languagefilter` может редиректить на `/ru/`. Внутри сайта |
| Не брать | `/administrator/` (Basic, защита), `/api/`: закрыты на части сайтов; проверка откатит выпуск, который ничего не сломал |

### 9.2. `failureMarkers`

Сравнение побайтное (`packages/domain/src/ports/site-adapter.ts:71-75`). Важнее всего строки, которые Joomla отдаёт **с кодом 200**, поскольку 5xx проверка ловит и без них.

| Строка | Где | Код ответа | Ветки |
| --- | --- | --- | --- |
| `No configuration file found and no installation code available. Exiting...` | `pkg-6.2.0:includes/framework.php:26`, `cms-4.4.14:includes/framework.php:30`, `cms-3.10.12:includes/framework.php:42` | **200** | все |
| `Sorry, your PHP version is not supported` | `pkg-6.2.0:templates/system/incompatible.html`, через `die()` в `index.php` | **200** | ≥ 4.0 |
| `Environment Setup Incomplete` | `pkg-6.2.0:templates/system/build_incomplete.html`, через `echo` и `exit` в `includes/app.php` | **200** | ≥ 4.0 |
| `Database Error: ` | `jexit` в `pkg-6.2.0:libraries/src/Service/Provider/Database.php:129`, `pkg-6.2.0:libraries/src/Factory.php:690`, `cms-3.10.12:libraries/src/Factory.php:664` | 500, если заголовки ещё не ушли | все |
| `Sorry, there was a problem we could not recover from.` | `h1` файла `templates/system/fatal-error.html`. Русский текст подставляет JavaScript на клиенте из `window.errorLocale`, поэтому **английская строка есть в HTML всегда**, у русского сайта тоже | 500 | ≥ 4.0 |
| `An Error Occurred: ` | `title` того же файла | 500 | ≥ 4.0 |
| `Произошла критическая ошибка` | В `window.errorLocale` | 500 | ≥ 4.0 |
| `<b>Fatal error</b>:`, `<b>Parse error</b>:` | PHP с `display_errors` и `html_errors`; Joomla при `error_reporting=maximum` включает показ (`pkg-6.2.0:includes/framework.php`) | 200 | все |

Не считать сбоем: `The site is offline`-подобная страница: у `offline.php` код **503** (`pkg-6.2.0:libraries/src/Application/SiteApplication.php:567`), проверка поймает по коду. Перенаправление на `installation/index.php` при оставленной папке (`includes/framework.php:32`) даёт 3xx: проверка пойдёт за ним. Отдельно проверять, что в выпуск не попала папка `installation/`.

Обычная страница ошибки `error.php` шаблона отдаёт код самой ошибки (`pkg-6.2.0:libraries/src/Document/ErrorDocument.php:131`).

У `cms-3.10.12` файлов `fatal-error.html`, `incompatible.html`, `build_incomplete.html` нет: для 3.x остаются `No configuration file…`, `Database Error: ` и строки PHP. Вид страницы 500 в 3.x не сверялся.

### 9.3. Журналы

| Файл | Что | Источник |
| --- | --- | --- |
| `<log_path>/joomla_core_errors.php` | Ошибки ядра | `pkg-6.2.0:libraries/src/Application/CMSApplication.php:1365` |
| `<log_path>/error.php` | Журнал по умолчанию | `pkg-6.2.0:libraries/src/Log/Logger/FormattedtextLogger.php:92` |
| `<log_path>/deprecated.php`, `everything.php`, `custom-logging.php`, `error.w3c.php`, `jcontroller.log.php`, `jmodulehelper.log.php` | Разное, включается настройками | `CMSApplication.php:1355-1391`, `pkg-6.2.0:libraries/src/Log/Logger/W3cLogger.php:47` |

`log_path` — абсолютный путь хостинга из `configuration.php` (`pkg-6.2.0:installation/src/Model/ConfigurationModel.php:447`), обычно `<корень>/administrator/logs`. В шаблонах 3.4 значение по умолчанию было `/var/logs`, в 3.10 — `/administrator/logs`. На сайте, перенесённом с другого сервера, значение может указывать в никуда.

Журналы начинаются с `#\n#<?php die('Forbidden.'); ?>` (`FormattedtextLogger.php:254`), поэтому имеют расширение `.php`, и шаблоны `*.log` их **не ловят**: нужен `/administrator/logs/`.

### 9.4. Кеш

| Что | Как сбросить | Заметка |
| --- | --- | --- |
| Кеш Joomla (`cache/`, `administrator/cache/`) | `php cli/joomla.php cache:clean`, ≥ 4.0. Без SSH: удалить содержимое кроме `index.html` | `cache:clean expired` только просроченное |
| `administrator/cache/autoload_psr4.php` | Удалить. Пересобирается на следующем запросе (`pkg-6.2.0:libraries/namespacemap.php:33`) | Обязателен после нового расширения с пространством имён |
| Кеш страниц `cache/page/` | В `cache:clean` | Плагин работает независимо от `$caching` |
| OPcache | Joomla инвалидирует только то, что записала сама (`pkg-6.2.0:libraries/vendor/joomla/filesystem/src/File.php:371-395`). Файлы, записанные по SFTP, подхватятся по `opcache.revalidate_freq`. При `validate_timestamps=0` — только сброс изнутри PHP: нужен доступ по HTTP | Для `SiteCodeCacheGateway` нужен файл-точка входа, раздел 7.4 |
| Версия медиа | Строка `?<hash>` у CSS и JS: `Version::getMediaVersion()`, кеш в группе `_media_version` (`pkg-6.2.0:libraries/src/Version.php`). Файл `user.css` поменялся, а хеш нет: браузер может держать старый файл. Сброс — `setMediaVersion` или очистка кеша | Точная логика пересчёта не сверялась |
| Сторонние кеши | JCH Optimize и подобные, CDN | Не проверено |

## 10. Лицензия и право

**Это выдержка из текстов; заключение юриста не получено.**

| Вопрос | Ответ | Источник |
| --- | --- | --- |
| Лицензия ядра | GNU GPL версии 2 или новее | `pkg-6.2.0:LICENSE.txt`, `pkg-6.2.0:README.txt:14` |
| Хранить ядро | GPL это не ограничивает | там же |
| Запускать копию сайта клиента | GPL не ограничивает запуск | там же |
| Базовый образ с ядром | Внутреннее использование не есть распространение. Если образ передаётся третьим лицам, действуют обязанности GPL (исходный код, лицензия). Официальный образ сам содержит пакет и лежит на Docker Hub | чтение GPLv2, вопрос юристу |
| Языковой пакет | GPL v2 или новее | `ru-RU-pack/pkg_ru-RU.xml` |
| Форк UTD | GPL v2 или новее, независимый проект | [README](https://github.com/joomlaworks/joomla-3.x) |
| Платные расширения клиента | Лицензии свои; условия правообладателя у каждого. JoomShopping указан как GPL (`ext-joomshopping/src/jshopping.xml:9`). Наличие закодированных файлов (ionCube) **не проверено** | |
| Торговый знак | Open Source Matters владеет знаками. «В большинстве случаев для использования имени или логотипа надо запросить разрешение»; исключение — чисто описательное упоминание, пример дан про статью. В имя продукта, домена, компании без разрешения включать нельзя, нужна оговорка о независимости. Пишем ли «подходит для сайтов на Joomla» на лендинге — **вопрос юристу и, возможно, запрос через тикет** | [tm.joomla.org: имя и логотип](https://tm.joomla.org/joomla-name-and-logo-use.html), [FAQ](https://tm.joomla.org/trademark-faq.html) |
| Персональные данные | Те же правила Радити, что у WordPress: правила 1 и 2 `CLAUDE.md` | |
| Договор с хостингом клиента | Доступ к базе и файлам — за клиентом | |

## 11. Docker

### 11.1. Официальный образ

| Что | Значение | Источник |
| --- | --- | --- |
| Образ | `joomla` на Docker Hub, Docker Official Image | [hub.docker.com/_/joomla](https://hub.docker.com/_/joomla) |
| Кто ведёт | Проект Joomla: организация `joomla-docker`, сопровождающие Llewellyn van der Merwe и Harald Leithner | `docker-joomla/conf/maintainers.json` |
| Свежесть | Обновлён 3 дня назад на момент проверки; коммит `9206c61` от 30.10.2026 | [Hub](https://hub.docker.com/_/joomla), `git log` |
| Ветки | **Только две:** 6.2.0 (PHP 8.3, 8.4, 8.5), 5.4.10 (PHP 8.2, 8.3). **Образов 4.4 и 3.10 в поддержке нет.** | Hub, `docker-joomla/images/` |
| Варианты | `apache`, `fpm`, `fpm-alpine`, и в репозитории `*-dev` с Composer, Node, Xdebug | `docker-joomla/images/6.2/stable/php8.4/` |
| Основа | `FROM php:8.4-apache-trixie` | `docker-joomla/images/6.2/stable/php8.4/apache/Dockerfile:2` |
| Расширения PHP | `bz2 bcmath exif gd gmp intl ldap mysqli pdo_mysql pdo_pgsql pgsql zip opcache apcu imagick memcached redis` | там же |
| Сервер | Apache, `a2enmod rewrite expires remoteip`; `remoteip.conf` доверяет частным подсетям | там же |
| Ядро | Скачивается из релиза на GitHub, сверяется `JOOMLA_SHA512`, лежит в `/usr/src/joomla`, при первом запуске копируется в `/var/www/html` | там же |
| Запуск | `ENTRYPOINT /entrypoint.sh`, `CMD apache2-foreground`, `VOLUME /var/www/html` | там же |
| Автоустановка | Все `JOOMLA_SITE_NAME`, `JOOMLA_ADMIN_USER`, `JOOMLA_ADMIN_USERNAME`, `JOOMLA_ADMIN_PASSWORD`, `JOOMLA_ADMIN_EMAIL` плюс `JOOMLA_DB_HOST`, `JOOMLA_DB_USER`, `JOOMLA_DB_PASSWORD` или `_FILE`, `JOOMLA_DB_NAME`, `JOOMLA_DB_TYPE`, `JOOMLA_DB_PREFIX` (по умолчанию `joom_`) | `docker-joomla/src/runtime/docker-entrypoint.sh`, `joomla_install` |
| После установки | `JOOMLA_EXTENSIONS_URLS`, `JOOMLA_EXTENSIONS_PATHS`, `JOOMLA_CLI_COMMANDS`, `JOOMLA_SMTP_HOST`, `JOOMLA_SMTP_HOST_PORT` | там же |
| Удаляет | `installation/` сам: `rm -rf -- installation` | там же |
| `.htaccess` | Копирует из `htaccess.txt` и комментирует `Options -Indexes` | там же, `joomla_copy_files` |
| Переменная | `ENV JOOMLA_INSTALLATION_DISABLE_LOCALHOST_CHECK=1`: снимает требование проверочного файла для удалённой БД в веб-установщике (`pkg-6.2.0:installation/src/Helper/DatabaseHelper.php:339`). В CLI-установке проверки нет | там же |

### 11.2. Базовые образы предпросмотра

Цель `site` в `infra/preview/Dockerfile` берёт образ по `BASE` и добавляет MariaDB 11.8.9, Node, WP-CLI, `tini`. Сравнение состава расширений:

| | `wordpress:*-apache` (основа сейчас) | `joomla:*-apache` |
| --- | --- | --- |
| Базовый | `php:8.3-apache` | `php:8.4-apache-trixie` |
| Расширения сборки | `bcmath exif gd intl mysqli zip`, `imagick` | те же плюс `bz2 gmp ldap pdo_mysql pdo_pgsql pgsql apcu memcached redis` |
| Модули Apache | `rewrite expires remoteip` | те же |

[Dockerfile wordpress](https://raw.githubusercontent.com/docker-library/wordpress/master/latest/php8.3/apache/Dockerfile).

Вывод. Для `mysqli`-сайта Joomla обязательные расширения есть уже в нынешнем образе `wordpress`: `dom`, `simplexml`, `json`, `zlib`, `xml` идут с PHP-образом (не сверялось запуском), `gd`, `mysqli`, `zip`, `intl` добавлены. Значит на первом шаге можно не заводить отдельный образ на Joomla: предпросмотр пишет `mysqli` в `dbtype`, а `$dbtype = 'pdomysql'` у 3,25% установок заменяется конфигурацией предпросмотра. Недостающие `pdo_mysql`, `redis`, `memcached` для сайта не нужны, поскольку кеш и сессии заменяются. Стороннему коду они могут понадобиться.

Если всё-таки брать `BASE=joomla:…`: цель `site` проверяет кодовое имя Debian (`bullseye`, `bookworm`, `trixie`), поэтому варианты `apache` подойдут, `fpm-alpine` нет. `ENTRYPOINT` цель заменяет своим.

Подбор PHP по веткам:

| Ветка | Рекомендованный ряд | Образы |
| --- | --- | --- |
| 6.x | 8.4, 8.3, 8.5 | `joomla:*` или общий PHP |
| 5.4 | 8.3, 8.2, 8.1 | `joomla:*` для 8.2, 8.3 |
| 4.4 | 8.2, 8.1, 8.0, 7.4 | Только общий PHP |
| 3.10 | 7.4, 8.0 | Только общий PHP. **PHP 5.6 и 7.0–7.3 среди `phpVersions` адаптера WordPress нет** (`packages/site-adapters/src/wordpress-preview.ts:17`), а цель `site` не примет Debian старше bullseye: сайт на расширениях под PHP 5.6 в предпросмотре может не работать. Работу 3.10 на 8.1 и новее не проверял |

Совместимость сторонних расширений с такими заменами проверяется только запуском: **не проверено**. Совместимость Joomla 3.10 с MariaDB 11.8.9 предпросмотра **не проверено** (документированная матрица 3.x не получена).

`opcache.revalidate_freq` предпросмотра уже 0 (`infra/wordpress/preview-apache.conf`): для Joomla годится.

Конфигурация Apache для предпросмотра отличается от WordPress. `.htaccess` предпросмотр не читает, поэтому в файле конфигурации должны быть правила раздела 1.5: `/api/` → `api/index.php`, всё остальное → `index.php`, `HTTP_AUTHORIZATION` — и закрыты `administrator/logs/`, `administrator/cache/`, `cache/`, `tmp/`, `configuration.php`, `defines.php`. Запрет прямого доступа к `.php` внутри `components/`, `libraries/`: файлы ядра начинаются с `defined('_JEXEC') or die`, но файлы клиента могут этого не иметь.

### 11.3. Как получить установленный сайт в стенде

| Ветка | Способ |
| --- | --- |
| 5.4, 6.2 | Официальный образ с автоустановкой, раздел 11.1 |
| ≥ 4.3 | Распаковать `Joomla_<версия>-Stable-Full_Package.tar.gz`, затем `php installation/joomla.php install --site-name=… --admin-user=… --admin-username=… --admin-password=… --admin-email=… --db-type=mysqli --db-host=… --db-user=… --db-pass=… --db-name=… --db-prefix=jos_ --db-encryption=0 --no-interaction`. Опции берутся из формы `pkg-6.2.0:installation/forms/setup.xml`; есть `--public-folder`. Язык всегда `en-GB` (`pkg-6.2.0:installation/src/Console/InstallCommand.php`), установка заново на существующий `configuration.php` отказывает. Источники: [код](https://github.com/joomla/joomla-cms/pull/38325), [документация](https://docs.joomla.org/J4.x:Joomla_CLI_Installation) |
| 3.10, 4.0–4.2 | CLI-установки нет. Сделать снимок базы один раз веб-установщиком, а для 3.10 можно импортировать `installation/sql/mysql/joomla.sql` с заменой `#__` и написать `configuration.php` вручную из `configuration.php-dist`, затем удалить `installation/` |
| Русский язык | `php cli/joomla.php extension:install --url=<URL пакета ru-RU>`, адрес — из `https://update.joomla.org/language/details6/ru-RU_details.xml`; язык по умолчанию — `#__extensions.params` компонента `com_languages`: `{"administrator":"ru-RU","site":"ru-RU"}`. В установке CLI язык не задаётся |
| Снимок | `mysqldump` базы и архив дерева без `installation/`; адрес не привязан: снимок поднимается на любом имени |

## 12. Что ломает WordPress-мышление

| № | Допущение | Как в Joomla | Где в коде Радити |
| --- | --- | --- | --- |
| 1 | Настройки сайта в базе, значит `option_update` пишет строку через плагин | Название, описание, «сайт выключен», часовой пояс, ЧПУ — в `configuration.php`. Менять на проде значит писать **файл с паролями**. Нужна либо отдельная операция, либо эти настройки вне плана БД | `dbSettings`, `DbSetting`, `dbOperationKinds` |
| 2 | Файл конфигурации сайта — только инфраструктура, его можно заменить | Часть значений обязана попасть в предпросмотр с прода: `sitename`, `MetaDesc`, `sef`, `offset`, `list_limit` | `SiteDatabaseSettings`, `previewRecipe.settings` |
| 3 | Адрес сайта в базе, в копии его надо подменять | Адреса в базе нет, копия открывается на своём имени сама. Подмена нужна только для абсолютных ссылок в тексте. Обязателен заголовок `X-Forwarded-Proto` от шлюза | `raditi-preview.php`, `productionOrigin` |
| 4 | Есть `mu-plugins`: положил файл — работает | Нет аналога. Любое расширение — строка `#__extensions`. На проде по FTP остаётся файл-точка входа, в копии — добавление строки через `overrides` | `wordpressPlatformFiles`, `previewGeneratedFileSchema` |
| 5 | Есть `wp eval` | Нет исполнения строки кода, консоли нет в 3.10 | `previewContentRecipeSchema.access`, `objects` |
| 6 | Объект — `post:42` или `page:42` | `article:42`; страниц нет, статьи и пункты меню раздельно | `publishedObjectRefSchema`, `browserCheckpointKinds = ['post']`, `dbRecordRefSchema` |
| 7 | Поля `title`, `content`, `excerpt` | `introtext`/`fulltext` делятся по `<hr id="system-readmore">`, отрывка нет | `publishedContentFieldsSchema`, `publishedContentHashMaterial` |
| 8 | Адрес статьи — `slug` | Адрес складывается из меню, категории, `id`, `alias` и языка | `dbSlugSchema`, `recordPages`, `DbCreatedRecord.slug` |
| 9 | Вход на отдельной странице `/wp-login.php` | Форма на **любом** адресе `/administrator/...`, адрес не меняется. `isSignInPage(path)` не решается по пути, а `signIn` ждёт поля по таймауту (`packages/browser-providers/src/cloud/cloud-browser.ts:1301-1330`). Нужна проверка наличия формы в DOM | `BrowserSignInForm` |
| 10 | Экран определяется путём | Один файл на все экраны, смысл в `option`, `view`, `task`, `layout`, в том числе в POST и JSON; нижний регистр применяется. `pageDenied(path)` получает путь с запросом | `BrowserTaskPolicy` |
| 11 | Можно перечислить опасные экраны | Сторонний компонент отвечает на свой `option`. Только разрешающий список | вопрос владельцу в плане 57, §6 |
| 12 | GET безопасен | `task=article.edit` — GET, который ставит блокировку | `isBrowserVerificationPlan`, `editUrl` |
| 13 | Редактор открывается по прямому адресу | Без предварительного `task=article.edit` — отказ, состояние в сессии | `browserCheckpointOf` |
| 14 | Объект можно бросить | Брошенный редактор оставляет `checked_out`: нужно «Закрыть» | Б22 |
| 15 | Кнопка «Опубликовать» в редакторе | Статус — поле формы, публикует обычное сохранение | `browserCommitAction` |
| 16 | Есть один редактор | TinyMCE, CodeMirror, без редактора или сторонний JCE, у пользователя свой (`params.editor`) | `browserGuide` |
| 17 | Админка одна | Минимум две разметки: Isis в 3.x, Atum в 4.x и новее | Селекторы по веткам |
| 18 | Ветка почти одна | Половина сайтов — 3.x, сайт на 3.x не имеет API, консоли и 2FA нового вида | Весь адаптер |
| 19 | Версия не старше официальной | Форк UTD: `3.17.0`. `3.1x` не значит ошибку разбора | `SiteFacts.version` |
| 20 | Папка `wp-content` делит чужое и своё | Ядро и сторонние лежат вперемешку в `components/`, `modules/`, `plugins/`, `administrator/`, `media/`. Границу даёт `ExtensionHelper::$coreExtensions` (`pkg-6.2.0:libraries/src/Extension/ExtensionHelper.php:50`, с 3.7.4) или `#__extensions`: рабочий набор зависит от сайта | `agentWorkingSet`, `protectedPaths` |
| 21 | Тема — одна папка | Половина шаблона в `media/templates/site/<имя>/`, настройки в `#__template_styles`, тексты в `language/overrides/` | `agentWorkingSet` |
| 22 | Медиа в одной папке | `images/`, `files/`, плюс произвольные папки из `plg_filesystem_local` (`params.directories`) и `components/com_jshopping/files/` | `mediaRules`, `importRules` |
| 23 | Журналы `*.log` | `.php` в `administrator/logs/` | `buildOutput`, `serverLogs` |
| 24 | Файл настроек не лежит рядом с мусором | Копии `configuration.php.bak` и подобные: шаблон `configuration*` | `importExcludes` |
| 25 | Метки корня не встречаются в подпапках | `administrator/` выглядит как корень: `includes`, `components`, `modules`, `language`, `templates` | `rootMarkers` |
| 26 | Веб-корень есть корень сайта | Режим публичной папки с симлинками; при импорте по FTP симлинк не скачать как папку. **Поведение импорта с симлинками не проверено** | импорт |
| 27 | Копия таблиц по строкам не нарушает целостность | `#__assets`, `#__categories`, `#__menu`, `#__tags` — вложенные множества (`lft`, `rgt`). Частичная копия `#__menu` или вставка новой статьи SQL портит дерево | `post_create`, `databaseCopyPolicy` |
| 28 | Запись новой строки через SQL допустима | Статья без `workflow_associations` не видна в админке | `post_create` |
| 29 | Секрет лежит под именованным ключом | `extra_query` — строка запроса с ключом загрузки | `scrub_secrets` |
| 30 | `set` меняет значение настройки | Настройки — один JSON на расширение, менять ключ нельзя, только всю строку | `overrides`, `option_update` |
| 31 | Колонка — идентификатор `[A-Za-z0-9_]` | JoomShopping: `name_ru-RU`. `identifier` отвергнет такие колонки в условиях копии | `identifier` в `packages/domain/src/preview/recipe.ts` |
| 32 | `main` равен установленной версии, пока работает платформа | В 5.4.10 и 6.2.0 есть автообновление ядра: `autoupdate` в `com_joomlaupdate`, по умолчанию `0` (`pkg-6.2.0:administrator/components/com_joomlaupdate/config.xml:82-87`), вход `index.php?jautoupdate=1` (`pkg-6.2.0:index.php:40`), команды `core:autoupdate:register` и `core:autoupdate:unregister`. Включённое на сайте автообновление меняет прод без выпуска; `detect` должен это видеть | сверка конфликтов |
| 33 | Посетитель не запускает работу сайта | Ленивый планировщик запускает задачи с посещений | `databaseCopyPolicy` |
| 34 | Кеш страниц выключается общей настройкой | `plg_system_cache` работает сам по себе | `overrides` |
| 35 | Обновление ядра меняет только файлы | Плюс `#__schemas`, `manifest_cache`: `update:joomla:remove-old-files`, `maintenance:database` | выпуск |
| 36 | Правила `.htaccess` нужны всегда | Joomla работает и без него, с адресами `/index.php/...`. При `sef_rewrite=1` без правил внутренние страницы дают 404 веб-сервера. Предпросмотр обязан держать правила у себя и считать `sef_rewrite` из конфигурации | `preview-apache.conf` |
| 37 | Папка установщика не вредит | `installation/index.php` в дереве уводит сайт на установку | `previewRecipe.requiredPaths` |
| 38 | MySQL | `postgres` есть в `databaseEngines`, у Joomla возможен: 0,14% установок. Копировщик только MySQL: отказ | `databaseSettings` |
| 39 | Язык админки известен | Выбирается пользователем, у нас только `en` и `ru` | `browserCommitAction`, `browserGuide` |

## Приложение. Значения методов `SiteAdapter`

Черновик: каждое значение подтверждено разделом выше. `not_supported` значит, что для метода нужно менять порт.

| Метод | Значение |
| --- | --- |
| `rootMarkers` | `['administrator', 'libraries', 'plugins']` |
| `configSecrets` | `configuration.php`: `password`, `secret`, `smtppass`, `proxy_pass`, `ftp_pass`, `redis_server_auth`, `session_redis_server_auth`, `smtp_oauth2_client_secret`, `smtp_oauth2_refresh_token`; исключить образец `FBVtggIk5lAzEU9H` |
| `databaseSettings` | `tablePrefix` из `$dbprefix`; `charset: 'utf8mb4'`, `collation: 'utf8mb4_unicode_ci'`; `null` при `$dbtype` не из MySQL |
| `importRules` | Исключить: `configuration.php`, `configuration*`, `defines.php`, `installation/`, `cache/*`, `administrator/cache/*`, `tmp/*`, `administrator/logs/`, `logs/`, `administrator/components/com_akeeba/backup/`, `administrator/components/com_akeebabackup/backup/`, `components/com_jshopping/files/pdf_orders/`, `components/com_jshopping/files/importexport/`, `kickstart.php`, общие списки `php-hosting.ts` с добавлением `*.jps`, `*.j[0-9][0-9]` |
| `protectedPaths` | `configuration.php`, `defines.php`, `index.php`, `includes/`, `libraries/`, `layouts/joomla/`, `cli/`, `api/`, `installation/`, `administrator/`, `images/`, `files/`, плюс `phpServerConfigProtected` и ядро из `$coreExtensions` |
| `agentWorkingSet` | `/templates/`, `/media/templates/site/`, `/language/overrides/`, `/administrator/language/overrides/`, сторонние `/components/com_*`, `/modules/mod_*`, `/plugins/*/*`, если они не из `$coreExtensions` |
| `mediaRules` | `addOnlyPaths: ['images/raditi/']`, остальные правила как у WordPress: `refusedNameParts` те же |
| `previewRecipe` | `requiredPaths`: `index.php`, `includes/framework.php`, `libraries/bootstrap.php`, `administrator/index.php`; `generatedFiles`: `configuration.php`, файл-точка входа, `cli/raditi.php`; `settings`: разрешённые значения из `configuration.php`; `web` — как у WordPress, с Apache своего образа |
| `databaseCopyPolicy` | Раздел 6 |
| `verify` | Раздел 9 |
| `browserTaskPolicy` | Раздел 8.6; `startPath: '/administrator/index.php?option=com_content&view=articles'`, `new URL(path, origin)` в `apps/browser/src/sessions/session-manager.ts:203` запрос сохраняет; `extraHosts: []` |
| `browserCheckpointOf` | `option=com_content` и `task=article.edit&id=N` либо `view=article&layout=edit&id=N`; `editUrl` всегда с `task=article.edit` |
| `browserCommitAction` | Таблица 8.3 |
| `browserVerification` | Раздел 8.5 |
| `publicOriginals` | Ядро: `raw.githubusercontent.com/joomla/joomla-cms/<тег>/<путь>`. Файлы тега и пакета совпадают в `libraries/src`, `administrator/components`, `templates`; в `plugins` два различия (проверено `diff -rq` на 6.2.0). `libraries/vendor` и собранного `media/` в git нет: их подтвердит только пакет релиза целиком. Сторонние расширения общего хранилища не имеют |
| `detect`, `backup`, `deployVars`, `agentGuide` | У WordPress не реализованы; для Joomla `detect` — раздел 2.4 |
