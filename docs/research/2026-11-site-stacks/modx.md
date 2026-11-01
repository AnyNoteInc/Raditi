# MODX Revolution 2.8 и 3.x: сведения для адаптера стека Радити

Дата проверки всех сведений — 01.11.2026, если не сказано иначе.

**Как читались источники.** Скачанное ничем не запускалось: ни PHP, ни установщик, ни образы. Всё ниже — чтение кода и документации, поведение на живой установке помечено «не проверено запуском», где это важно.

| Что | Откуда | Метка |
| --- | --- | --- |
| MODX 3.2.4-pl | `research/src/modx/rev-3.2.4` — тег `v3.2.4-pl`, `c7c38028`, 26.08.2026 | ссылки вида `core/src/Revolution/modX.php:527` без пометки — этот тег |
| MODX 2.8.9-pl | `research/src/modx/rev-2.8.9` — тег `v2.8.9-pl`, `7e1d1afe`, 21.07.2026 | ссылки с пометкой «2.8.9» |
| Релизные архивы | `https://modx.s3.amazonaws.com/releases/<версия>/modx-<версия>-pl.zip` (ответ 200 для 3.2.4 и 2.8.9), `-advanced.zip`, `-sdk.zip`; распакованы в `research/src/modx/dist-*` | — |
| Документация | `modxorg/Docs`, ветка `3.x` `f93e8651`, 23.10.2026, и ветка `2.x` — исходник `docs.modx.com` | `docs:<путь>` |
| Русская документация Extras | `modx-pro/Docs` — исходник `docs.modx.pro` | `ru-docs:<путь>` |
| Радити | `raditi-stacks`, ветка `feat/site-stacks`, `c811abf1` | полный путь от корня репозитория |

**Что было недоступно.** `modx.com`, `docs.modx.com`, `support.modx.com`, `modmore.com`, `support.modmore.com` и `wmtips.com` отвечают 403 и WebFetch, и curl; `modstore.pro` отказывает в соединении (`ECONNREFUSED`). Поэтому страницы загрузки и условия магазина дополнений прочитаны только в выдержках поисковой выдачи — такие места помечены.

---

## 0. Главное

1. **Актуальная версия — 3.2.4-pl (26.08.2026), ветка 2.x получает только критические исправления (2.8.9-pl, 21.07.2026).** Нужны обе: 2.8 с отдельной раскладкой классов и другими требованиями к PHP.
2. **Код сайта — в базе.** Шаблоны, чанки, сниппеты (PHP) и плагины (PHP) лежат в `site_templates`, `site_htmlsnippets`, `site_snippets`, `site_plugins`. Импорт файлов по FTP не даёт агенту почти ничего из того, что клиент называет «вёрсткой». Нужна выгрузка элементов в файлы и новый вид операции плана БД. Это главное отличие от WordPress.
3. **Содержимое страницы — язык шаблонов.** `[[!Сниппет]]` в тексте выполняет код, `[[++настройка]]` печатает системную настройку на публичную страницу. Из подстановок вырезан только короткий список ключей (`modX.php`, `initialize`); ключи дополнений, например платёжные, остаются. Значение `content_update` нельзя считать «просто текстом».
4. **Пути не фиксированы.** В 2.x `core/` можно переименовать и вынести за корень сайта, а `manager/`, `connectors/` и `assets/` — в обеих ветках; имя файла конфигурации зависит от `MODX_CONFIG_KEY`. У `SiteFacts` сейчас всегда `docroot: '/'` и `extras: {}` (`apps/core/src/previews/preview-builder.ts:189-190`), то есть раскладке сайта негде жить.
5. **`rootMarkers` по одному списку имён не сработает.** `manager/` и `connectors/` сами содержат `index.php` и `config.core.php`, поэтому обход `apps/core/src/site-provisioning/tree-walk.ts:211-218` пропустит их как «вложенный сайт», если поставить эти два имени.
6. **`core/cache/` нельзя импортировать.** В `core/cache/system_settings/config.cache.php` лежит копия всех системных настроек, с паролем SMTP. Там же скомпилированный PHP элементов и отрисованные страницы.
7. **Образы предпросмотра не подойдут как есть.** База `site` — образ `wordpress` (`infra/preview/Dockerfile:8`), в нём нет `pdo_mysql`, а xPDO работает только через PDO. Ядро MODX в образ класть не нужно: оно приходит с деревом сайта.
8. **Официального образа Docker нет.** `modxcms/docker-modx` стоит на PHP 7.1 и MODX 2.7.0, последний коммит основной ветки — 30.09.2020. В `docker-library/official-images` записи `modx` нет.
9. **Входа по токену нет, REST ядра нет.** Аналога Application Passwords нет. Нужен свой файл-соединитель на сайте со своей аутентификацией, новый вид доступа в `siteAccessKinds`.
10. **Форма входа показывается на любом адресе `manager/`.** `BrowserSignInForm.isSignInPage(path)` по одному адресу страницу входа не отличит (`packages/domain/src/ports/site-adapter.ts:319`).

---

## 1. Версии, требования, веб-сервер

### 1.1. Ветки

Даты — коммиты тегов на GitHub (`gh api repos/modxcms/revolution/commits/<тег>`). Релизов GitHub Releases у проекта нет (`/releases` пуст), источник истины — теги и `core/docs/changelog.txt`.

| Ветка | Последняя | Дата | Статус | PHP, минимум | PHP, верх | СУБД |
| --- | --- | --- | --- | --- | --- | --- |
| 3.x (основная, `3.x`) | нет выпуска новее 3.2.4 | коммит 28.10.2026 | разработка; вехи `v3.3.0`, `v4.0.0` (docs:getting-started/roadmap.md) | — | — | — |
| 3.2 | **3.2.4-pl** | 26.08.2026 | актуальная | 8.1 (`composer.json`) | 8.5: «PHP 8.5 Compatibility (#16794)» в 3.2.0-pl | MySQL 5.7 минимум; рекомендуются MySQL 8.0+, MariaDB 10.6+, Percona 8.0+ |
| 3.1 | 3.1.2-pl | 02.04.2025 | новых тегов нет, ветки `3.1.x` на GitHub нет | 7.4.0 | 8.4: «PHP 8.4 compatibility updates (#16654)» в 3.1.0-pl; 8.2 в CI — там же (#16327) | те же |
| 3.0 | 3.0.6-pl | 09.12.2024 | ветка `3.0.x` есть, новых тегов нет; `3.0.x-dev` на Packagist менялась 22.07.2026 | 7.2.5 | 8.1 проверялся в CI с 3.0.0-rc1 (#15960) | те же |
| 2.8 | **2.8.9-pl** | 21.07.2026 | только критические уязвимости: `SECURITY.md`, «2.x — Critical vulnerabilities only» | 5.6 (`composer.json` 2.8.9) | PHP 8 — правки в 2.8.2–2.8.3 (2021), 8.2 — убраны предупреждения в 2.8.7–2.8.8; 8.3+ в журнале не упомянут | docs ветки 2.x: минимум 4.1.20, «5.6 or up strongly recommended» |
| 2.0–2.7 | 2.7.3 и старше | — | не поддерживаются | 5.3.3+ | — | — |

Проверка «новее нет»: `releases/3.2.5/modx-3.2.5-pl.zip`, `releases/3.3.0/...`, `releases/2.8.10/...` на S3 отвечают 403, Packagist называет `v3.2.4-pl` последним тегом. Википедия в выдаче ещё называет 3.2.3, это устарело.

`SECURITY.md` пишет «3.x — Yes» целиком, без разбивки по минорным. Какие ветки 3.x реально получают заплатки, из него не следует: 3.2.3 и 2.8.9 вышли в один день с одной правкой («Validate cultureKey…»), а тега 3.0.7 или 3.1.3 нет.

Установщик проверяет PHP 7.4.0 (`setup/provisioner/requirements.php`), а `composer.json` требует 8.1. Документация прямо предупреждает: на PHP 7.4 установка пройдёт, а обновление упадёт на Composer (docs:getting-started/upgrading-to-3.0/requirements.md). Значит, сайт на 3.2.x с PHP 7.4 в природе возможен только сломанным, а номер PHP хостинга надо сверять с версией MODX.

### 1.2. Что живёт в России

| Показатель | Значение | Источник |
| --- | --- | --- |
| Доля в мире | 0,1% всех сайтов и 0,1% сайтов с известной CMS, ноябрь 2026 | w3techs.com/technologies/details/cm-modx |
| Доля в зоне `.ru` | на открытой странице W3Techs нет; там WordPress 33,3%, Tilda 27,4%, 1C-Bitrix 16,0% на 01.11.2026 | w3techs.com/technologies/segmentation/tld-ru-/content_management |
| Доля в России, 2024 | MODX 2,24%; WordPress 45,45%, 1С-Битрикс 14,25%, Joomla 8,56%, Drupal 2,38%, OpenCart 1,63%; база — чуть больше 911 тыс. сайтов на CMS | рейтинг YBRU, пересказ workspace.ru; первичный отчёт не читался |
| Оценка числа сайтов | около 20 тыс. | моя оценка: 2,24% от 911 тыс.; в источнике числа нет |
| Распределение по версиям | **не проверено**: W3Techs версий MODX не даёт, Packagist (975 установок в месяц) для этой CMS не показателен: сайты ставят архивом | — |
| Где больше сайтов | «Россия, Украина, Беларусь» | wmtips, только выдержка поиска; страница отвечает 403 |

Косвенный вывод, не измерение: в России нужно считать основной пару «2.8 и 3.x». Магазинный стек де-факто — miniShop2 (`modx-pro/miniShop2`, 4.4.2-pl, 29.09.2025), для MODX 3 — MiniShop3 (`modx-pro/MiniShop3`, идёт как `v1.14.3-beta2`, 22.10.2026), дополнения продаёт русский магазин modstore.pro.

### 1.3. Расширения и php.ini

| Что | 3.x | 2.8 |
| --- | --- | --- |
| Обязательные расширения | `curl dom fileinfo gd json pdo simplexml xml xmlwriter zip zlib` и `pdo_mysql` (docs:getting-started/server-requirements.md, `setup/provisioner/requirements.php`) | `zlib json gd pdo pdo_mysql imagick simplexml curl mbstring` — «required or commonly required» (docs ветки 2.x) |
| Рекомендуемые | `mbstring` (нужен при `use_multibyte`), `iconv` (транслитерация алиасов), `imagick`, `intl` | — |
| `memory_limit` | минимум 24M для установщика, рекомендуется 64M+ | от 64M |
| `max_execution_time` | совет 120 для установки на медленных хостингах (docs:getting-started/installation/advanced.md) | так же |
| `session.gc_probability` | должен быть больше 0: сессии лежат в БД, системный cron их не чистит; без GC `modx_session` растёт до гигабайт, по данным SiteDash около 2021 года так у примерно трёх сайтов из десяти (docs:getting-started/maintenance/session-garbage-collection.md) | так же |
| Права БД | `SELECT INSERT UPDATE DELETE`, для установки и дополнений `CREATE ALTER INDEX DROP`, некоторым дополнениям `CREATE TEMPORARY TABLES` | так же |
| Движки и кодировки | MyISAM и InnoDB; `utf8` и `utf8mb4`, рекомендуется `utf8mb4` | `utf8`, `utf8mb4` |

Драйвер СУБД в 3.x один — `mysql`; `postgres` — сторонний, `sqlsrv` удалён в 3.0, в 2.x ещё есть (`core/model/modx/metadata.sqlsrv.php`, 2.8.9).

### 1.4. Веб-сервер и адреса

| Сервер | Правило | Где |
| --- | --- | --- |
| Apache 2.4 + `mod_rewrite` | `RewriteCond %{REQUEST_FILENAME} !-f`, `RewriteCond %{REQUEST_FILENAME} !-d`, `RewriteRule ^(.*)$ index.php?q=$1 [L,QSA]` | `ht.access:52-54` |
| nginx 1.18+ | `location @modx { rewrite ^/(.*)$ /index.php?q=$1&$args last; }`, `location / { absolute_redirect off; try_files $uri $uri/ @modx; }` | docs:getting-started/friendly-urls/nginx.md |
| Закрыть от веба | Apache: `RewriteRule ^(\.(?!well-known)\|_build\|_gitify\|_backup\|core\|config.core.php) /index.php?q=doesnotexist [L,R=404]`; nginx: `location ~ ^/(_build\|_gitify\|_backup\|core\|config\.core\.php) { deny all; }` | docs:getting-started/maintenance/securing-modx.md |

Детали, которые важны адаптеру:

- файл в дистрибутиве называется `ht.access`, без точки, и работает, только если его переименовать; в `manager/` и `core/` лежат свои `ht.access` (`core/ht.access` закрывает всё ядро);
- параметр `q` — значение настройки `request_param_alias`, `id` — `request_param_id`. Обе можно сменить;
- настройка `friendly_urls` по умолчанию `false`: сайт без ЧПУ открывается как `index.php?id=12`;
- `preview-apache.conf` читает `AllowOverride None`, поэтому правила из `.htaccess` сайта в предпросмотр не попадут. Правила ЧПУ и закрытие `core/` должны быть в конфигурации Apache рецепта, как у WordPress (`infra/wordpress/preview-apache.conf`).

---

## 2. Распознавание

### 2.1. Файлы корня

Дистрибутив traditional 3.2.4 содержит ровно: `config.core.php connectors/ core/ ht.access index.php manager/ setup/`. `assets/` и `assets/components/` создаёт установщик (`setup/includes/modinstall.class.php:292-310`). Advanced содержит только `core/` и `setup/`, остальное разворачивается установкой.

| Запись | 3.x | 2.8 | Может отсутствовать или называться иначе |
| --- | --- | --- | --- |
| `index.php` | есть всегда | есть всегда | нет |
| `config.core.php` | есть | есть | `index.php` подключает его через `@include` и без него берёт `<корень>/core/`, но установщик пишет файл всегда |
| `core/` | есть всегда: «cannot be moved or renamed» (docs:getting-started/upgrading-to-3.0/core-folder.md, #15476 открыт) | **может быть переименована и вынесена за корень сайта** | на 2.x — да |
| `manager/` | по умолчанию | по умолчанию | да: Advanced или вручную (`$modx_manager_path`, `$modx_manager_url`) |
| `connectors/` | по умолчанию | по умолчанию | да: то же |
| `assets/` | по умолчанию | по умолчанию | да: `$modx_assets_path`, `$modx_assets_url` |
| `.htaccess` | по желанию | по желанию | да, на nginx его нет |
| `setup/` | должна быть удалена | так же | обычно нет; если есть — это дыра и повод предупредить клиента |

Переименование `manager/` в России — обычная рекомендация: скрипт `ru-docs:faq/manager-customize/rename.md`, статья на Хабре 2017 года советует переименовать `connectors` и `manager` и вынести `core`. Доля таких сайтов **не проверена**.

**Ловушка вложенных папок.** Порт говорит: «a folder below the root with all of them is not entered» (`apps/core/src/site-provisioning/tree-walk.ts:53`, проверка `isNestedSiteRoot` на `:211-218`). После установки в `manager/` лежат `index.php` и `config.core.php`, в `connectors/` — тоже (дистрибутив: `dist-3.2.4/modx-3.2.4-pl/manager`, `.../connectors`). Значит:

| Кандидат `rootMarkers()` | Итог |
| --- | --- |
| `['index.php', 'config.core.php']` | импорт пропустит `manager/` и `connectors/` как вложенные сайты |
| `['index.php', 'config.core.php', 'core']` | годится для 3.x и обычного 2.x; мастер откажет сайту 2.x с вынесенным `core` (`packages/trpc/src/services/site-access.ts:141`) |
| `['core', 'connectors', 'manager']` | ломается на переименованных папках |

Вывод: для MODX нужен не список имён, а предикат: корень — папка с `index.php` и `config.core.php`, в которой нет `controllers/` и `templates/` (признак `manager/`) и нет `lang.js.php` (признак `connectors/`), и `config.core.php` определяет `MODX_CORE_PATH`. Либо `rootMarkers` остаётся для запроса к мастеру, а для обхода добавляется `isNestedRoot(names)`.

### 2.2. Версия без выполнения кода

1. Прочитать `config.core.php` и достать `MODX_CORE_PATH` и `MODX_CONFIG_KEY`. Встречаются две формы:
   - `define('MODX_CORE_PATH', '/var/www/u1/data/www/example.ru/core/');` — запись установщика, абсолютный путь на хостинге (`_build/resolvers/resolve.core.php`, в конце файла ещё и `?>`);
   - `define('MODX_CORE_PATH', dirname(__FILE__) . '/core/');` — как в дистрибутиве traditional.

   Ветка `case '@traditional':` в `resolve.core.php` не срабатывает: ключ в дистрибутиве `'@traditional@'` (`setup/includes/config.core.php`), с закрывающей `@`. По коду файл переписывается литералом всегда. **Не проверено запуском**, поэтому парсер обязан принимать обе формы.
2. Сопоставить путь с деревом FTP. Абсолютный путь хостинга не равен пути в FTP. Рабочее правило: путь оканчивается на `/core/` рядом с корнем сайта. Иначе (`/core_a1b2/`, `../core/`) нужен поиск папки по имени последнего сегмента в корне и на уровень выше, а если FTP заперт в docroot, ядро недоступно и импорт невозможен: это честный отказ мастера.
3. Прочитать `<core>/docs/version.inc.php`. Формат один в 2.x и 3.x:

Пересказ: пять присваиваний массиву `$v`: `version` (первая цифра), `major_version` (вторая), `minor_version` (третья), `patch_level` (например, `pl`), `distro` (например, `@traditional@`).







Итог `3.2.4-pl`. Имена полей сдвинуты относительно обычных: `major_version` — это вторая цифра. Запасные пути: первая строка `MODX Revolution 3.2.4-pl (August 26, 2026)` в `<core>/docs/changelog.txt`; в базе — `system_settings.settings_version` и `settings_distro`.

### 2.3. От чего отличать

| Система | Признаки | Что с ней делать |
| --- | --- | --- |
| **MODX Revolution 3.x** | `core/src/Revolution/modX.php`, `core/vendor/autoload.php`, `core/docs/version.inc.php`, `connectors/index.php` | этот адаптер |
| **MODX Revolution 2.x** | `core/model/modx/modx.class.php`, `core/xpdo/xpdo.class.php`, нет `core/src` и `core/vendor` | этот адаптер, другая ветка рецепта |
| **Evolution CMS 3.x** | нет `connectors/` и `config.core.php`; есть `manager/includes/version.inc.php`, `manager/actions/`, `core/factory/version.php` (массив `version`, `release_date`, `branch`, `full_appname`), `core/bootstrap.php`, `core/artisan`, `core/custom/` | **отдельная система**: 3.6.0 от 21.10.2026, PHP `^8.4.1`, GPL-3.0, основа на компонентах Laravel (`illuminate/*` ^13 в `core/composer.json`), конфигурация — `core/custom/config/database/connections/default.php` с `env('DB_PASSWORD', …)`, миграции `core/database/migrations` |
| **MODX Evolution 1.x, старый Evo** | `manager/includes/config.inc.php`, `manager/includes/version.inc.php` с `$modx_version`, `assets/cache/`, `assets/snippets/`, `assets/plugins/` | отдельная система, старый PHP; `modxcms/evolution` заморожен, архив с 09.03.2021 |

У Evolution те же имена части таблиц (`site_content`, `site_templates`, `site_htmlsnippets`) и тот же префикс `modx_`, поэтому отличать по базе ненадёжно: только по файлам. Точный номер старых 1.x **не проверен**: замороженный репозиторий на последнем коммите уже читает `core/factory/version.php`.

Evolution предлагается не включать в первую волну: другая схема пользователей, другой фреймворк, отдельный рынок. Мастер должен узнавать её и говорить клиенту, что система пока не поддерживается, а не принимать за Revolution.

Сборок и «русских редакций» ядра нет: русский словарь входит в ядро (`core/lexicon/ru`, 46 файлов). `modx-pro/revolution` — обычный форк GitHub (`fork: true`, родитель `modxcms/revolution`), не отдельный дистрибутив. Поле `distro` бывает `@traditional@`, `@advanced@`, `@sdk@` и `@git@` (в git-дереве). Сайт на Git-установке отличается наличием `_build/`.

---

## 3. Дерево

Размеры — распакованные архивы. 3.2.4 traditional — 77 МБ: `core` 59 МБ (`vendor` 19, `packages` 20, `lexicon` 15), `manager` 13, `setup` 4,5, `connectors` 20 КБ. 2.8.9 traditional — 44 МБ: `core` 31 МБ (`model` 10, `packages` 5,2). Рабочий сайт прибавляет `assets/` и `core/packages/`: их объём **не проверен**, он зависит от каталога товаров.

Обозначения: «импорт» — брать в репозиторий сайта; «агент» — входит в рабочий набор; «заново» — можно скачать из релиза.

| Путь (3.x; в скобках 2.x) | Что это | Импорт | Агент | Заново |
| --- | --- | --- | --- | --- |
| `index.php`, `config.core.php` | вход и путь к ядру | да; `config.core.php` без секретов, но с абсолютным путём, предпросмотр и выпуск его не переписывают с репозитория | нет | `index.php` — да |
| `connectors/`, `manager/` | AJAX-вход и админка | да | нет | да |
| `core/src/`, `core/vendor/`, `core/include/` (`core/model/`, `core/xpdo/`) | ядро | да | нет | да |
| `core/lexicon/`, `core/docs/`, `core/error/` | словари, версия, страницы ошибок | да | нет | да |
| `core/model/schema/` | XML-схема | да | нет | да |
| `core/config/` | `config.inc.php` или `<ключ>.inc.php`, файлы дополнений (`mxbackup.php`, `mxbackup/profiles/`) | **нет, всю папку** | нет | нет |
| `core/cache/` | кеш и журнал | **нет**: секреты, скомпилированный PHP | нет | пересобирается |
| `core/packages/` | скачанные пакеты, `core.transport.zip` и распакованные копии | нет: большой объём, платные пакеты | нет | ядро — да, дополнения — от поставщика |
| `core/components/<пакет>/` | PHP дополнений | да | только свои, не чужие | дополнения — от поставщика |
| `core/export/`, `core/import/` | выгрузки | нет | нет | — |
| `assets/components/<пакет>/` | веб-файлы дополнений | да | нет | от поставщика |
| `assets/` кроме `components/` | вёрстка сайта и медиа, имена произвольны: `assets/templates/`, `assets/images/`, `assets/files/` | да | CSS, JS, шаблоны — да, медиа — только добавлять | нет |
| `setup/` | установщик | **нет** | нет | да |
| `_build/` | есть только у Git-установки | нет | нет | да |
| `_backup/`, `_data/`, `_packages/`, `.gitify` | каталоги Gitify; `_backup/` — дампы базы | `_backup/` нет | нет | — |
| `.htaccess`, `.user.ini`, `php.ini` | настройки сервера | нет (`phpServerConfigFiles`) | нет | — |

**Кеш, подробно** (docs:getting-started/directory-structure.md, код `modCacheManager`):

| Путь в `core/cache/` | Что внутри | Почему не брать |
| --- | --- | --- |
| `system_settings/config.cache.php` | все системные настройки | пароль SMTP, ключи дополнений |
| `context_settings/<контекст>/context.cache.php` | настройки контекста, карта событий и псевдонимов | адреса, ключи |
| `resource/<контекст>/resources/<id>.cache.php` | отрисованная страница (ключ `[contextKey]/resources/[id]`, `modResource.php:469`; документация пишет `cache/web/resources/12.cache.php`, по коду есть ещё раздел `resource`) | устаревшее содержимое |
| `includes/elements/modsnippet/<id>.include.cache.php`, `scripts/` | PHP сниппетов и плагинов из базы | это код клиента без контроля |
| `logs/error.log` | журнал | персональные данные, пути |
| `mgr/`, `lexicon_topics/`, `namespaces/`, `menu/`, `registry/`, `auto_publish/`, `rss/` | служебное | — |

При `MODX_CONFIG_KEY` не `config` всё это лежит в `core/cache/<ключ>/` (`core/src/Revolution/modX.php:528-529`). Дополнения пишут в кеш своё: `core/cache/msyandexdelivery_requests.log`, `core/cache/msrussianpost_requests.log`, `core/cache/logs/commerceml.log`, `core/cache/imageoptimizer/` (ru-docs).

**Бэкапы внутри дерева.** Стандартного места в ядре нет. Известные: `_backup/` (Gitify, `backup_directory`), `core/packages/easycookies/backups/`, у mxBackup каталог `backups` рядом с корнем сайта, если он не настроен (`ru-docs:components/mxbackup/settings.md`). Общие маски `archivesAndDumps` их закрывают; `core/components/mxlogger/standalone.key` закрывает маска `*.key`.

**Файлы посетителей.** Ядро своего каталога не заводит. Дополнения пишут в `assets/`: в примерах документации встречаются `assets/uploadify/…`, `assets/files/…`, `assets/images/catalog`. Точного списка папок форм и заказов **нет**: пути FormIt, Tickets и Office **не проверены**. Закрытие должно идти списком адаптера плюс сканер, как у WordPress (`visitorDirs` в `packages/site-adapters/src/wordpress.ts:85-104`).

**Медиа.** Таблицы медиатеки нет. Медиа — это просто файлы, а в содержимом хранится путь относительно `<base href>`, например `assets/images/a.jpg`. TV типа `image` хранит путь относительно источника. Для `mediaRules.addOnlyPaths` это проще, чем у WordPress: `assets/raditi/` не требует записей в базе.

**Что можно скачать заново.** Ядро — по адресу S3 выше, для `publicOriginals` это прямой аналог `wordpress-public-code.ts`: файл ядра сравнивается с файлом из архива той же версии. Дополнения открытого репозитория идут через `https://rest.modx.com/extras/` (`_build/transport.core.php:191`), магазина — `https://modstore.pro/extras/` с ключом; платные байты сравнить не с чем.

---

## 4. Конфигурация

### 4.1. Файлы

| Файл | Что в нём | Сколько копий |
| --- | --- | --- |
| `config.core.php` | `define('MODX_CORE_PATH', …)`, `define('MODX_CONFIG_KEY', 'config')` | **три**: корень, `manager/`, `connectors/` |
| `<core>/config/<MODX_CONFIG_KEY>.inc.php` | база, пути, адреса | одна; имя зависит от ключа |
| `config.context.php` | необязательный; `return 'ключ контекста';`, читает `index.php` 3.2.4 | ноль или один |

### 4.2. `config.inc.php`: синтаксис

Шаблон — `core/docs/config.inc.tpl`, запись — `setup/includes/runner/modinstallrunner.class.php:165-232`. Это обычные присваивания PHP в одинарных кавычках, с экранированием `\\` и `\'` (с 3.2.4 — `escapeConfigValue`; в старых установках значение могло быть записано без экранирования). Имена в 2.8.9 те же, другой порядок.

Пересказ. Присваивания переменных:

- база: `$database_type`, `$database_server`, `$database_connection_charset`, `$table_prefix`, `$dbase`, `$database_user`, `$database_password`, `$database_dsn`, `$config_options`, `$driver_options`;
- установка: `$lastInstallTime`, `$site_id`, `$site_sessionname`, `$https_port`, `$uuid`.

Дальше для каждой папки идёт блок с проверкой `defined`: сначала переменные пути и адреса, потом константы. Так заданы `MODX_ASSETS_PATH` и `MODX_ASSETS_URL`, `MODX_BASE_PATH` и `MODX_BASE_URL`, `MODX_CONNECTORS_PATH` и `MODX_CONNECTORS_URL`, `MODX_CORE_PATH`, `MODX_MANAGER_PATH` и `MODX_MANAGER_URL`, `MODX_PROCESSORS_PATH`.





















Разбор без выполнения: `phpStringsAfter` из `packages/site-adapters/src/php-config.ts` подходит как есть, с шаблонами вида `\$database_password[ \t\r\n]*=[ \t\r\n]*` и концом `[ \t\r\n]*;` — ровно как `tablePrefixAssignment` в `wordpress-db-copy.ts:26-27`. Нужны и переменные путей: из них адаптер узнаёт фактические имена папок.

`$config_options` и `$driver_options` — массив, записанный `var_export`. Литералами из него достаётся не всё: в `$config_options` могут быть реплики БД (`connections` с паролями), кеш-бэкенды, любые ключи. Для `configSecrets` этот блок надо прочесть целиком и взять строковые литералы.

### 4.3. Все секреты в файлах

| Значение | Где | Смысл |
| --- | --- | --- |
| `$database_password`, `$database_user` | `config.inc.php` | доступ к базе |
| `$database_dsn`, `$database_server`, `$dbase` | там же | адрес и имя базы; для `site_databases` |
| `$config_options['connections']` и прочее | там же | реплики, кеш; `modX.php:564` ставит первичное соединение перед ними |
| `$site_id` | там же | начало `uniqid` токена входа (`modUser.php:427`); не пароль, но уникален для сайта |
| `$uuid` | там же | идентификатор установки, участвует в метке версии статики менеджера (`modManagerController.php:1058`) |
| `$site_sessionname` | там же | имя сессии |
| `core/config/*.php` кроме основного | файлы дополнений | могут держать доступы (`core/config/mxbackup.php`) |
| `core/components/mxlogger/standalone.key` | файл дополнения | пример ключа вне `core/config/` |

Лицензионного ключа ядра нет. Ключи платных дополнений — в базе (`transport_providers`), см. §6.3.

`configSecrets(read)` сначала читает `config.core.php`, берёт ключ, затем `core/config/<ключ>.inc.php`. Порт читает «файл корня сайта по относительному пути» (`site-adapter.ts:192-198`), поэтому при вынесенном `core` на 2.x файл недоступен, и нужно отдавать адаптеру чтение относительно найденного каталога.

### 4.4. Кодировка и `databaseSettings`

| Поле `SiteDatabaseSettings` | Источник |
| --- | --- |
| `tablePrefix` | `$table_prefix`; по умолчанию `modx_`, часто случайный: смена префикса — рекомендация `securing-modx.md` |
| `charset` | `$database_connection_charset`; проверить совпадение с `charset=` в `$database_dsn` |
| `collation` | в конфигурации нет, поэтому `null`. Установщик держит `database_collation` только на время установки |

`modx_charset` (по умолчанию `UTF-8`) — настройка вывода, не соединения. В `setup/config.dist.new.xml` по умолчанию `utf8` и `utf8_general_ci`, в рекомендациях `utf8mb4`. Двойное кодирование старых сайтов **не проверено**, но чтение дампа в той же кодировке соединения, что и у сайта, совпадает с договором Р15.

### 4.5. Запуск с другой конфигурацией, не меняя файл

MODX переменные окружения не читает.

| Способ | Работает | Как |
| --- | --- | --- |
| **Сгенерированный `core/config/config.inc.php`** поверх дерева | да, самый простой | как `preview-wp-config.php`: файл без секретов читает `settings.json` предпросмотра; `core/config/` не импортируется, поэтому конфликта нет |
| **Свой ключ конфигурации** | да, по коду | сгенерировать три `config.core.php` с `MODX_CONFIG_KEY='raditi-preview'`; тогда читается `core/config/raditi-preview.inc.php`, а кеш идёт в `core/cache/raditi-preview/` (`modX.php:527-529`). Параметр `--config_key` есть и у установщика |
| **`auto_prepend_file`** | частично | константы в `config.inc.tpl` стоят под `if (!defined(...))`, поэтому `MODX_BASE_URL`, `MODX_SITE_URL`, `MODX_HTTP_HOST`, `MODX_URL_SCHEME` можно задать заранее. Но `$database_*` присваиваются безусловно, а `config.core.php` определяет константы без проверки (в `index.php` и `manager/index.php` спасает `@include`, `connectors/index.php` проверяет сам) |
| **`$config_options`** для настроек | нет | в `_loadConfig` настройки из БД идут поверх: `array_merge($this->config, $config)` (`modX.php:2922`, `_loadConfig`). Принудительно задать настройку отсюда нельзя, только через строку `system_settings` |
| **Код в самом конфиге** | да | `config.inc.php` — PHP, он выполняется на каждый запрос внутри `loadConfig` и в 2.x, и в 3.x. Это единственная точка, общая для обеих веток, где можно зарегистрировать `header_register_callback` и подмену `$_SERVER` |

### 4.6. Где привязан адрес

| Место | Что | Что сделать в копии |
| --- | --- | --- |
| `$_SERVER['HTTP_HOST']` | `MODX_HTTP_HOST` и из него `MODX_SITE_URL` считаются на каждый запрос (`config.inc.tpl`) | адрес сайта по большей части берётся из заголовка `Host`, запись в базе не нужна. Подставить `HTTP_HOST` и `SERVER_NAME` в начале конфига, как `preview-wp-config.php` |
| `$_SERVER['HTTPS']`, `$https_port` | `$isSecureRequest` | шлюз предпросмотра завершает TLS: выставить `$_SERVER['HTTPS']='on'`, иначе схема `http://`. `HTTP_X_FORWARDED_PROTO` читает только установщик |
| `$http_host` | только для CLI | написать адрес предпросмотра |
| `MODX_BASE_URL` и `$modx_*_url` | подпапка | предпросмотр живёт в корне: `/`; абсолютные пути `/sub/…` в содержимом сломаются |
| `system_settings` | ключа `site_url` нет, «это config value, не системная настройка» (docs:building-sites/tag-syntax/common.md) | но `getConfig` ставит константы только `if (!isset)`, а `_loadConfig` кладёт БД сверху: строка с ключом `site_url`, `base_url`, `http_host`, `url_scheme` в `system_settings` переопределит адрес. Закрыть в списке копии |
| `context_setting` | `site_url`, `http_host`, `base_url`, `site_start`, `error_page`, `cultureKey` на контекст | многодоменные и многоязычные сайты: убрать ключи адреса для `web`; остальные контексты в предпросмотре не откроются, шлюз-плагин выбирает контекст по `http_host` (docs:building-sites/contexts/gateway-plugin.md) |
| `session_cookie_domain`, `session_cookie_path`, `session_cookie_secure` | cookie | перекрыть через `overrides` |
| `manager_login_url_alternate` | редирект неавторизованных в менеджере | перекрыть пустым |
| `workspaces.path`, `namespaces.path`, `extension_packages.path` | обычно `{core_path}…`, но могут быть абсолютными; документация прямо пишет про белую страницу при старом пути в `workspaces` | проверять и перекрывать |
| `media_sources.properties` | `basePath`, `baseUrl`; абсолютные пути и ключи S3 | чистить |
| Настройки дополнений | пути Gallery, `extension_packages` и подобное (docs:getting-started/maintenance/moving-your-site.md) | только сканом |
| Текст страниц | абсолютные `https://example.ru/…`; ссылки `[[~12]]` безопасны | подмена при выводе |
| `<base href="[[++site_url]]">` | обычный приём в шаблонах | сам станет адресом предпросмотра; относительные пути работают |
| Редиректы | `_cleanResourceIdentifier` шлёт 301 на `site_url`, если запрос к пустому алиасу не равен `base_url` (`modRequest.php:355-357`), `request_method_strict` — с `?id=` на ЧПУ | следствие неверного `base_url` — петля |
| `.htaccess` | редиректы `www`/`https` | предпросмотр его не читает |
| `core/cache/**` | всё выше, скомпилированное | должен быть пуст; очистка после каждой загрузки базы |

Подмена адреса в готовой странице. У WordPress это mu-plugin с фильтрами (`infra/wordpress/raditi-preview.php`). В MODX 2.x такого механизма без строки в базе нет: плагин `OnWebPagePrerender` — это строка `site_plugins` и строка `site_plugin_events`. Способ, одинаковый для 2.x и 3.x: буфер вывода и `header_register_callback` из сгенерированного конфига. Но `index.php` делает `ob_start()` раньше, а `modResponse` может сбросить буферы. Запасной способ — `mod_substitute` в конфигурации Apache или строки плагина в копии базы. Поведение буфера **не проверено запуском**.

---

## 5. Где живёт то, что клиент хочет менять

### 5.1. Карта

| Что просит клиент | Где лежит | Менять файлом | Менять через базу |
| --- | --- | --- | --- |
| Текст страницы, новость | `site_content`: `pagetitle`, `longtitle`, `description`, `introtext`, `content`, `alias`, `menutitle`, `published`, `pub_date` | нет | да |
| Товар miniShop2 | строка `site_content` с `class_key=msProduct` и строка `ms2_products` (`article`, `price`, `old_price`, `weight`, `remains`, `reserved`, `image`, `thumb`, `vendor`, `made_in`, `new`, `popular`, `favorite`, `tags`, `color`, `size`, `source`) | нет | да |
| Дополнительные поля страницы (TV) | значения — `site_tmplvar_contentvalues` (`tmplvarid`, `contentid`, `value`), определения — `site_tmplvars`, привязка — `site_tmplvar_templates` | нет | да |
| Вёрстка, общие блоки | **шаблон** `site_templates.content`, **чанк** `site_htmlsnippets.snippet`; оба `mediumtext` | только если элемент статический | да |
| Логика на PHP | **сниппет** `site_snippets.snippet`, **плагин** `site_plugins.plugincode`, события — `site_plugin_events` | только если статический | да, это выполняемый код |
| CSS, JS, картинки темы | `assets/…`, имена папок произвольны | да | нет |
| Настройки сайта | `system_settings` (242 ключа в ядре), `context_setting`, `user_settings`, `user_group_settings` | нет | да, закрытым списком |
| Меню сайта | нет отдельной сущности: это дерево `site_content` (`parent`, `menuindex`, `hidemenu`) и вызов `pdoMenu` или `Wayfinder` в шаблоне. Таблица `menus` — меню **админки** | — | поля страниц |
| Тексты интерфейса | файлы `core/lexicon/`, правки — `lexicon_entries` | файлы ядра нельзя | да |
| Формы | вызов `FormIt` в чанке, письма — в чанках | нет | чанки |
| Код дополнения клиента | `core/components/<пакет>/`, `assets/components/<пакет>/` | да, если свой | — |
| Настройки «для клиента» | ClientConfig (таблицы `clientconfig_*`, точные имена **не проверены**) | нет | да |

У `site_templates`, `site_htmlsnippets`, `site_snippets`, `site_plugins`, `site_tmplvars` есть поля `static` и `static_file`; у сниппетов и плагинов ещё `properties`, у плагинов `disabled`. Имя элемента — `templatename` у шаблонов, `name` у остальных, не больше 50 знаков.

**Шаблон не файл.** У `site_templates` нет пути. На типичном сайте весь HTML живёт в базе, а `assets/` содержит только статику. Поэтому «рабочий набор адаптера» из файлов для MODX почти пуст, и важная часть работы агента — это правка строк базы.

### 5.2. Статические элементы

Официальный механизм файлового хранения (docs:building-sites/elements/static-elements.md).

| Свойство | Значение |
| --- | --- |
| Поля | `static=1`, `static_file` (относительно источника, либо `core/components/`, либо настройка `element_static_path`, либо абсолютный путь), `source` (id источника, 0 — нет) |
| Автоматизация, с 2.7 | `static_elements_automate_templates`, `_tvs`, `_chunks`, `_snippets`, `_plugins`, `static_elements_default_mediasource`, `static_elements_basepath`, `static_elements_default_category`, `static_elements_html_extension` |
| Раскладка файлов | `{static_elements_basepath}/{type}/{category}/{filename}.{extension}`, например `components/site/elements/chunks/html/footer.chunk.tpl` |
| Запрет | `isStaticSourceValidPath` не даёт положить файл прямо в `core/config/` (`core/src/Revolution/modElement.php`) |

Как оно работает на самом деле:

- `modElement::getContent()` при `isStatic()` читает файл, и **если он отличается от базы — пишет его в базу прямо при обработке запроса**: `setContent` и `save()` (`modElement.php:532-550`). Обычный GET к сайту меняет строку таблицы;
- `modScript::loadScript()` пересобирает `*.include.cache.php`, только если файл новее кеша (`filemtime`);
- `modElement::save()` при сохранении из админки пишет в файл (`setFileContent`), если файл доступен на запись. Иначе берёт содержимое файла, и правка в менеджере теряется (`modElement.php:193-245`);
- «MODX only checks the contents of the file when the element is requested uncached»: кешированная страница содержит старый чанк до очистки кеша;
- `setFileContent` у скриптов дописывает `<?php\n`, `set()` срезает открывающий тег: сравнивать файл и поле байт в байт нельзя.

Вывод для выпуска: если элемент статический и его файл меняется в git, файл — истина, а база догонит его сама; нужна только очистка кеша. Это единственный случай, когда обычный путь выпуска по файлам работает для кода сайта. Список таких файлов известен только из базы, а `static_file` может указывать куда угодно, в том числе за пределы дерева.

### 5.3. Выгрузка в файлы

| Способ | Что даёт | Годится ли |
| --- | --- | --- |
| Перевод элементов в статические на сайте клиента | истина в файлах | **меняет прод**; нельзя без выпуска и согласия |
| Перевод только в копии предпросмотра | агент работает файлами | рабочий путь: в копии `static=1`, файлы пишутся из базы; обратный перенос на прод — операцией плана БД |
| Gitify 2.2.0 (`modmore/Gitify`, MIT, 19.09.2025, PHP ≥ 7.2.5) | `extract` и `build`: файлы `_data/<раздел>/<имя>` — блок YAML, разделитель `\n-----\n\n` (`src/Gitify.php:23`), затем содержимое; разделы задаются в `.gitify` с `class` и `primary` | образец формата; как зависимость не нужен: тянет Symfony 5, ставится Composer |
| Свой файл `raditi-export.php` | читает элементы через xPDO, пишет дерево | рекомендуется: один скрипт, те же правила, что у плагина |

Предлагаемая форма: каталог платформы, например `.raditi/elements/{templates,chunks,snippets,plugins}/<имя>.<расш>` с id в манифесте. Агент правит, платформа сравнивает с базой копии и складывает операции нового вида, условно `element_update`.

### 5.4. Что агенту можно

| Объект | Можно агенту | Риск |
| --- | --- | --- |
| Тексты страниц | да, в предпросмотре | теги MODX в тексте: §12, п. 2 |
| Шаблоны и чанки | да, в предпросмотре, с планом БД | секреты в тексте, вызовы сниппетов |
| Сниппеты и плагины | это код в базе, эквивалент файла темы WordPress; кандидат на отдельный вид операции и на проверку дифф-правилами | выполняются на проде сразу после выпуска, `gitleaks` и `protectedPaths` их сейчас не видят |
| Статика `assets/` | да | — |
| Настройки | только закрытый список | рядом лежат пароли |
| Шаблон страницы (`template`), `class_key`, `context_key` | нет без согласования | ломает вывод |
| Дополнения | нет | правило 4 |

---

## 6. База

### 6.1. Таблицы ядра

Источник — `core/model/schema/*.xml` 3.2.4: объявлено 72 таблицы, установщик создаёт 70 (`setup/includes/tables_create.php`). `site_element` и `site_script` — базовые классы схемы с именем таблицы, но в списке создания их нет, поэтому адаптер не должен требовать их наличия. Имена ниже без префикса. Какой минимум нужен для запуска, **запуском не проверено**: группы составлены по коду `initialize`, `_loadConfig`, `modContext`.

| Группа | Таблицы | Строки в копии |
| --- | --- | --- |
| Запуск сайта | `context`, `context_setting`, `system_settings`, `system_eventnames`, `namespaces`, `extension_packages`, `workspaces`, `content_type`, `media_sources`, `media_sources_contexts`, `media_sources_elements` | да, с фильтрами |
| Контент | `site_content`, `site_tmplvar_contentvalues`, `context_resource`, `document_groups`, `documentgroup_names` | да, без удалённых (`deleted=0`) |
| Код сайта | `site_templates`, `site_htmlsnippets`, `site_snippets`, `site_plugins`, `site_plugin_events`, `site_tmplvars`, `site_tmplvar_templates`, `site_tmplvar_access`, `categories`, `categories_closure`, `property_set`, `element_property_sets` | да, с чисткой секретов |
| Права и менеджер | `access_actiondom`, `access_category`, `access_context`, `access_elements`, `access_media_source`, `access_menus`, `access_namespace`, `access_permissions`, `access_policies`, `access_policy_template_groups`, `access_policy_templates`, `access_resource_groups`, `access_resources`, `access_templatevars`, `membergroup_names`, `user_group_roles`, `menus`, `actiondom`, `actions_fields`, `fc_profiles`, `fc_profiles_usergroups`, `fc_sets`, `dashboard`, `dashboard_widget`, `dashboard_widget_placement`, `lexicon_entries` | да: без `access_*` не работает проверка контекста `modContext::checkPolicy` |
| Люди | `users`, `user_attributes`, `member_groups`, `user_settings`, `user_group_settings`, `user_messages` | только синтетические авторы и своя учётная запись платформы |
| Журналы и состояние | `session`, `active_users`, `manager_log`, `register_queues`, `register_topics`, `register_messages`, `deprecated_call`, `deprecated_method` | нет, только структура |
| Пакеты | `transport_packages`, `transport_providers` | первая — да (список установленного); вторая — нет |

**Предел схемы.** `databaseCopyPolicySchema.tables` — `.max(64)` (`packages/domain/src/preview/recipe.ts:246`). В группах с данными выше уже 58 таблиц ядра, один miniShop2 добавляет ещё 13, итого 71. Предел придётся поднять.

### 6.2. Персональные данные

| Таблица | Поля | Что в копии |
| --- | --- | --- |
| `users` | `username`, `password`, `cachepwd`, `salt`, `remote_key`, `remote_data`, `session_stale` | только авторы скопированных страниц: `username` → `synthetic_login`, `password` → `random_password_hash`, `cachepwd`, `salt`, `remote_key`, `remote_data`, `session_stale` → `empty` |
| `user_attributes` | `fullname`, `email`, `phone`, `mobilephone`, `dob`, `gender`, `address`, `country`, `city`, `state`, `zip`, `fax`, `photo`, `comment`, `website`, `extended`, `sessionid`, `lastlogin`, `thislogin`, `logincount` | `inCopied` по `internalKey`; `fullname` → `synthetic_name`, `email` → `synthetic_email`, остальное `empty` |
| `user_settings`, `user_group_settings` | значения настроек людей | нет |
| `user_messages` | переписка в админке | нет |
| `session` | `data`: сериализованная сессия, в том числе токены | нет |
| `active_users` | `ip`, `lasthit` | нет |
| `manager_log` | действия админов | нет |
| `register_messages` | одноразовые ссылки сброса пароля и входа (`/pwd/change/…`, `/pwd/magiclink/…`, `manager/controllers/default/security/login.class.php`) | нет |
| `member_groups` | кто в каких группах | только своя запись |

Покупатели магазина и посетители с личным кабинетом лежат в тех же `users` и `user_attributes`, что и администраторы: отдельной таблицы клиентов сайта в ядре нет. Копировать `users` целиком нельзя никогда.

Дополнения, которые встречаются в России:

| Дополнение | Персональные данные: только структура | Каталог: нужны строки |
| --- | --- | --- |
| miniShop2 | `ms2_orders`, `ms2_order_addresses` (`receiver`, `phone`, `email`, `index`, `city`, `street`, `building`, `room`, `comment`, `text_address`), `ms2_order_products`, `ms2_order_logs`, `ms2_customer_profiles` | `ms2_products`, `ms2_vendors`, `ms2_product_categories`, `ms2_product_options`, `ms2_product_files`, `ms2_options`, `ms2_category_options`, `ms2_links`, `ms2_product_links`, `ms2_order_statuses`, `ms2_deliveries`, `ms2_payments`, `ms2_delivery_payments`; у `ms2_deliveries` и `ms2_payments` поле `properties` — `scrub_secrets` |
| MiniShop3 | `ms3_orders`, `ms3_order_addresses`, `ms3_order_products`, `ms3_order_logs`, `ms3_customers`, `ms3_customer_addresses`, `ms3_customer_tokens`, `ms3_customer_groups` | `ms3_products`, `ms3_vendors`, `ms3_product_*`, `ms3_options`, `ms3_links`, `ms3_order_statuses`, `ms3_deliveries`, `ms3_payments` и служебные `ms3_*_fields` |
| FormIt | `formit_forms` (заявки) | — |
| Tickets | `tickets_comments`, `tickets_threads`, `tickets_votes`, `tickets_stars`, `tickets_views`, `tickets_mail_queues`, `tickets_authors`, `tickets_author_actions`, `tickets_files`, `tickets_totals` | — |
| Quip | комментарии (`modxcms/Quip`, не развивается с 2022), имена таблиц **не проверены** | — |

Список разрешённого здесь работает как надо: что не названо, идёт только структурой. Цена — неназванное дополнение откроется пустым. Магазин без таблиц `ms2_*` покажет страницу товара без цены и вариантов. Значит, адаптеру нужен учёт дополнений по `transport_packages` и `namespaces`.

### 6.3. Секреты в базе

| Где | Ключи | Как отсечь |
| --- | --- | --- |
| `system_settings` | `mail_smtp_user`, `mail_smtp_pass`, `mail_dkim_passphrase`, `mail_dkim_privatekeystring`, `mail_dkim_privatekeyfile`, `proxy_username`, `proxy_password`; `xtype='text-password'` у `mail_smtp_pass`, `mail_dkim_passphrase`, `proxy_password` | `notLike` по `key` и отдельное условие на `xtype` |
| `system_settings` дополнений | токены и ключи: `msyandexdelivery_*`, `msp3*`, `ms2_*`, любые | поле `namespace` и шаблоны `%key%`, `%token%`, `%secret%`, `%pass%`, `%api%` |
| `context_setting` | те же ключи на контекст | то же |
| `transport_providers` | `username`, `api_key`, `properties` | не копировать |
| `media_sources` | `properties`: `key`, `secret_key` у S3 (`core/src/Revolution/Sources/modS3MediaSource.php:45-46`, `:146-155`), пути | `scrub_secrets` |
| `ms2_payments`, `ms2_deliveries` | `properties` | `scrub_secrets` |
| **Код элементов** | ключи API прямо в тексте: `site_snippets.snippet`, `site_plugins.plugincode`, `site_templates.content`, `site_htmlsnippets.snippet`, и значения по умолчанию в `properties`, `property_set.properties` | **`scrub_secrets` этого не поймает**: он читает ключи сериализованных значений, а не текст PHP. Перед показом агенту нужен `gitleaks` по выгруженным элементам |

### 6.4. Как обезличить, чтобы сайт работал

Принципы те же, что в `packages/site-adapters/src/wordpress-db-copy.ts`: список разрешённого, фильтр в `SELECT`, `overrides` для своего состояния. Особенности MODX:

| Тема | Что делать |
| --- | --- |
| `system_settings` | лучше `notLike` по шаблонам и `xtype`, чем перечень 242+ ключей: условия `in` и `like` ограничены 256 значениями, а настройки дополнений заранее не известны. Это отступление от «только список разрешённого», его надо признать в проекте |
| `overrides` | `site_status=1`, `site_unavailable_page=0`, `session_cookie_domain=''`, `session_cookie_secure=0`, `manager_login_url_alternate=''`, `emailsender=admin@preview.invalid`, `mail_use_smtp=0`, `auto_check_pkg_updates=0`, `feed_modx_news_enabled=0`, `feed_modx_security_enabled=0`, `passwordless_activated=0` |
| Письма | `mail()` гасится `sendmail_path=/bin/false` в php.ini предпросмотра; у дополнений со своим транспортом это надо проверять отдельно |
| Индексация | MODX `noindex` сам не ставит: заголовок `X-Robots-Tag` на уровне Apache |
| `context_setting` | составной ключ `(context_key, key)`; `overrides.match` — одна колонка (`recipe.ts:260`), поэтому «поменять только у `web`» этой формой не выразить |
| `site_plugin_events` | составной ключ `(pluginid, event)`, та же проблема |
| Удалённые страницы | `deleted=1` не копировать |
| Кеш | после каждой загрузки базы чистить `core/cache/`, иначе сайт покажет то, что было до загрузки |

### 6.5. Администратор в копии без браузера

Рекомендуемый путь — файл PHP в копии, через API, он сам подберёт хеш. Для `PreviewContentRecipe.access` это команда вида `['php', '/var/www/html/raditi-preview-cli.php', 'access']`.

```php
$user = $modx->newObject($userClass, ['username' => 'raditi-platform', 'active' => 1]);
$user->set('password', $password);      // modUser::set сам хеширует (modUser.php:62-67)
$user->setSudo(true);                   // sudo через массовое присваивание закрыт: modUser.php:58
$profile = $modx->newObject($profileClass);
$profile->fromArray(['email' => 'platform@preview.invalid', 'fullname' => 'Радити']);
$user->addOne($profile);
$user->save();
$user->joinGroup('Administrator', 2);   // группа 1 Administrator, роль 2 Super User
```

Этот фрагмент не запускался. Если нужен прямой SQL:

| Шаг | Значения |
| --- | --- |
| `users` | `username`, `password`, `hash_class`, `salt`, `class_key`, `active=1`, `sudo=1`, `primary_group=1`, `createdon=UNIX_TIMESTAMP()` |
| `class_key` | 3.x `MODX\Revolution\modUser` (`core/model/schema/modx.mysql.schema.xml:1201`), 2.x `modUser` |
| `hash_class`, новая установка | 3.x `MODX\Revolution\Hashing\modNative` (`:1205`), 2.x `hashing.modNative` (2.8.9, `core/model/schema/modx.mysql.schema.xml:1246`). Алгоритм — `password_hash($p, PASSWORD_DEFAULT)` (`core/src/Revolution/Hashing/modNative.php`), то есть bcrypt `$2y$` |
| `hash_class`, старая установка | `hashing.modPBKDF2`: PBKDF2-HMAC-SHA256, соль — поле `salt`, 1000 итераций, 32 байта, base64 (`core/src/Revolution/Hashing/modPBKDF2.php`). В 3.x такая строка понимается через `modX::loadClass` (`modX.php:2554`) |
| Запасной вариант | `hash_class='hashing.modMD5'`, `password=MD5('…')` (docs:building-sites/client-proofing/security/troubleshooting-security/resetting-a-user-password-manually.md). Страница устарела: по умолчанию там назван PBKDF2 |
| `user_attributes` | `internalKey=<id>`, `email`, `fullname`, `blocked=0`: вход читает блокировку из профиля |
| `member_groups` | `user_group=1`, `member=<id>`, `role=2`, `rank=0` |

`password_min_length` — 12 по умолчанию, но проверяется процессором пользователя, а не `modUser::set`.

### 6.6. Командная строка

В ядре **нет** аналога WP-CLI и нет `bin` в `composer.json`.

| Инструмент | Что умеет | Состояние |
| --- | --- | --- |
| `setup/index.php`, `setup/cli-install.php` | только установка и обновление | ядро |
| Gitify (`modmore/Gitify`) | `extract`, `build`, `backup`, `restore`, `clearcache`, `modx:install`, `modx:download`, `modx:upgrade`, `package:install`, `init` | 2.2.0, 19.09.2025, MIT |
| `finetuned/modx-cli` | «MODX 3 CLI», только 3.x, PHP ≥ 8.1 | последний коммит 26.09.2026, MIT; 2.8 не умеет |
| Console, modalConsole | PHP-консоль в админке | дополнения; агенту закрыть |

Для платформы проще свой `php`-скрипт с `MODX_API_MODE`: он работает и на 2.8, и на 3.x, образ не требует ничего, кроме PHP CLI. WP-CLI из `infra/preview/Dockerfile` для MODX не нужен.

---

## 7. Программный доступ к контенту

### 7.1. Что есть в ядре

| Механизм | Что это | Подходит |
| --- | --- | --- |
| Коннекторы и процессоры | `connectors/index.php` + `action`; `core/src/Revolution/Processors/` (2.x: `core/model/modx/processors/`) | внутренний API админки: нужна сессия и токен `modAuth`. Снаружи не для интеграции |
| `modRestService`, `modRestController` | `MODX\Revolution\Rest\*`: набор классов для своего REST; маршрутов из коробки нет (docs:extending-modx/developing-restful-api.md) | можно, но надо поднимать `rest/index.php` и правила перезаписи |
| xPDO | `$modx->getObject`, `getCollection`, `newObject`, `newQuery` | да |
| `$modx->runProcessor('resource/update', …)` | те же проверки, что в админке, событие `OnDocFormSave`, пересчёт `uri` | да, при заданном `$modx->user` |
| mxHeadless (`ru-docs:components/mxheadless`) | REST как дополнение из modstore | стороннее |

Аналога `wp-json`, Application Passwords и nonce нет.

### 7.2. Один файл, который загружает ядро

Один приём на обе ветки: `index.php` с `MODX_API_MODE` (`index.php:15-17`, `:62`), он сам найдёт ядро, загрузчик и контекст. Подтверждение — docs:building-sites/client-proofing/security/troubleshooting-security/resetting-a-user-password-manually.md. Для 3.x документация показывает ещё и прямой путь через `config.core.php` и `vendor/autoload.php` (docs:extending-modx/modx-class/loading-externally.md); для 2.x это `core/model/modx/modx.class.php`.

```php
<?php
define('MODX_API_MODE', true);
require __DIR__ . '/index.php';                 // даёт $modx, инициализированный контекстом web

$cls  = class_exists('MODX\Revolution\modResource') ? 'MODX\Revolution\modResource' : 'modResource';
$page = $modx->getObject($cls, 12);
echo $page->get('pagetitle');
$page->set('content', $newContent);
$page->save();
$modx->cacheManager->refresh([
    'resource' => ['contexts' => [$page->get('context_key')]],
]);
```

Что важно:

- прямой `$page->save()` не вызывает `OnDocFormSave`, не проверяет права и не чистит кеш;
- `runProcessor` от анонима откажет: `Resource/Update` требует `save_document` (`core/src/Revolution/Processors/Resource/Update.php:81`). Нужен `$modx->user` с правами, например строка с `sudo=1`;
- в режиме API `modRequest::handleRequest` не вызывается, поэтому `modRequest::sanitizeRequest` (`modRequest.php:82`, `:418-438`) не работает, и `[[…]]` в запросе доходит до кода как есть. В админке слой есть: `modManagerRequest.php:72`, а контексту `mgr` задано `allow_tags_in_post=true` (`_build/data/transport.core.context_settings.php`). Своему файлу вся проверка входа — своя;
- имена классов без пространства в 3.x работают через псевдонимы (`load_deprecated_global_class_aliases`, `core/include/deprecated.php`), но их автозагрузка уходит в 3.3 или 3.4 (docs:getting-started/roadmap.md). Поэтому `class_exists`, а не строка `'modResource'`.

### 7.3. Модель расширений

| Форма | Что это | Как поставить без браузера | Регистрация в базе |
| --- | --- | --- | --- |
| **Дополнение (Extra)** | транспортный пакет `.transport.zip`: файлы, строки базы, резолверы PHP | положить в `core/packages/`, затем `runProcessor('workspace/packages/scanlocal')` и `workspace/packages/install` с `signature` (`core/src/Revolution/Processors/Workspace/Packages/Install.php:48-58`), либо `gitify package:install` | да: `transport_packages`, `namespaces`, элементы |
| **Плагин** | строка `site_plugins` и строки `site_plugin_events` | SQL или xPDO, затем очистить кеш контекста: карта событий кешируется | да |
| **Сниппет** | строка `site_snippets` | то же | да |
| **`bootstrap.php` пространства имён** | **только 3.x**: `<namespace.path>/bootstrap.php` подключается на каждый запрос (`modX.php:641-648`; docs:extending-modx/namespaces.md); в 2.8.9 такого кода нет | файл и строка `namespaces` | одна строка |
| **Отдельный файл-соединитель** | `assets/components/raditi/connector.php` или файл в корне | просто положить | **нет** |

Аналога `wp-content/mu-plugins/` без строки в базе нет. Ближайшие: `bootstrap.php` (3.x, одна строка) и сам `config.inc.php` (обе ветки). Для плагина контента платформы подходит отдельный файл: его можно положить по SFTP без единой записи в базу, он сам подключает ядро. Но хостинг может запрещать выполнение PHP в `assets/`, поэтому место выбирается проверкой.

Своё состояние плагина (эпоха, журнал вызовов, квитанции) лучше держать в своей таблице: `system_settings` кешируется в `core/cache/system_settings/`, а запись настройки в обход `modSystemSetting` кеш не сбрасывает. У WordPress это опции и своя таблица; порт `SiteDbGateway` от хранения не зависит.

---

## 8. Админка

### 8.1. Адрес и вход

| Параметр | Значение |
| --- | --- |
| Адрес по умолчанию | `/manager/`. Переименовывается; настоящий адрес — `$modx_manager_url` из конфига |
| Подмена входа | `manager_login_url_alternate`: неавторизованных перенаправляет на указанный адрес (`core/src/Revolution/modManagerResponse.php:80-82`) |
| Страница входа | **своего адреса нет**: любой адрес менеджера без сессии показывает форму, маршрут внутри меняется на `security/login` (`modManagerResponse.php:75-77`) |
| Метод | обычная отправка формы `POST` на тот же адрес, кнопка `login=1` (`manager/controllers/default/security/login.class.php:397`) |
| CSRF | на входе токена нет; `modhash` — только для сброса пароля |
| Капча, 2FA | в ядре нет; дополнения подключаются событиями `OnManagerLoginFormPrerender`, `OnManagerLoginFormRender`, `OnBeforeManagerLogin`, `OnManagerAuthentication` |
| Вход по ссылке | настройка `passwordless_activated`: форма без пароля, поле `#modx-login-passwordless`. С ней сохранённый вход не работает |
| Блокировка | `failed_login_attempts=5`, `blocked_minutes=60` |
| Сессия | `session_cookie_lifetime=604800`; сессии в `modx_session`; имя куки — настройка `session_name` |

Селекторы формы совпадают в 2.8.9 и 3.2.4:

| Поле | Селектор | `name` |
| --- | --- | --- |
| Форма | `#modx-login-form` | — |
| Логин | `#modx-login-username` | `username` |
| Пароль | `#modx-login-password` | `password` |
| Кнопка | `#modx-login-btn` | `login`, `value=1` |
| Запомнить | `#modx-login-rememberme` | `rememberme` |
| Скрытые | — | `login_context=mgr`, `modhash`, `returnUrl` (в 2.8.9 поле сброса называется `modahsh`) |

Тексты: `Имя пользователя`, `Пароль`, кнопка `Войти` (`core/lexicon/ru/login.inc.php`); `Username`, `Password`, `Login` (`en`). Язык — по заголовку `Accept-Language` и переключателю `manager_language` на форме (`login.class.php`, `handleLanguageChange`).

### 8.2. Экраны

Маршруты — параметр `a` от адреса менеджера. Список взят из `manager/controllers/default` и `_build/data/transport.core.menus.php`. Числовые `a=30` — версии до 2.3.

| Экран | Адрес | Агент |
| --- | --- | --- |
| Редактор страницы | `?a=resource/update&id={id}` | да |
| Новая страница | `?a=resource/create&parent={p}&context_key=web` | да |
| Данные страницы | `?a=resource/data&id={id}` | да |
| Расписание | `?a=resource/site_schedule` | да |
| Корзина | `?a=resource/trash` | нет |
| Поиск | `?a=search` | да |
| Рабочий стол | `?a=welcome` | **нет**: виджеты показывают пользователей |
| Шаблон, чанк, сниппет, плагин, TV | `?a=element/{template,chunk,snippet,plugin,tv}/update&id={id}` | сниппет и плагин — **нет**, это выполнение PHP на проде |
| Пользователи | `?a=security/user`, `?a=security/user/update&id={id}`, `?a=security/user/create` | нет |
| Группы и права | `?a=security/permission`, `?a=security/usergroup/update&id={id}`, `?a=security/resourcegroup`, `?a=security/forms` | нет |
| Сообщения, профиль | `?a=security/message`, `?a=security/profile` | нет |
| Системные настройки | `?a=system/settings` | нет |
| Контексты | `?a=context`, `?a=context/update&key={key}` | нет |
| Дополнения | `?a=workspaces`, `?a=workspaces/package/view`, `?a=workspaces/namespace`, `?a=workspaces/lexicon` | нет |
| Файлы | `?a=media/browser`, `?a=system/file/edit`, `?a=system/file/create`, источники `?a=source` | `media/browser` — только загрузка в свою папку; редактор файлов — нет |
| Журналы и сведения | `?a=system/event`, `?a=system/logs`, `?a=system/info`, `?a=system/contenttype`, `?a=system/action`, `?a=system/dashboards` | нет |
| Выход | `?a=security/logout` | нет |
| Экраны дополнений | `?a=<маршрут>&namespace=<ns>`: заказы miniShop2 — `?a=mgr/orders&namespace=minishop2`, настройки — `?a=mgr/settings&namespace=minishop2` | **нет, закрывать всё с `namespace`** |

Бэкапа и консоли в ядре нет, только в дополнениях. Товар miniShop2 открывается как обычная страница: `?a=resource/update&id={id}` с `class_key=msProduct`.

Стартовая страница браузера задачи. В ядре нет плоского списка страниц, дерево ресурсов — панель слева. У узла дерева есть адрес `?a=resource/update&id={id}` (`core/src/Revolution/Processors/Resource/GetNodes.php:493`), но видит ли панель Ext JS 3 дерево доступности Playwright, **не проверено запуском**. Рабочий стол закрыт, поэтому кандидаты на старт — `?a=resource/site_schedule` и `?a=search`.

### 8.3. Запросы менеджера

Вся работа идёт XHR на один адрес: `POST <connectors>/index.php`, поле `action`, заголовок `modAuth: <MODx.siteId>` или параметр `HTTP_MODAUTH` (`core/src/Revolution/modConnectorResponse.php:111-121`, `manager/assets/modext/core/modx.component.js:101`).

| Действие | 3.x | 2.x |
| --- | --- | --- |
| Сохранить страницу | `Resource/Update` | `resource/update` |
| Создать | `Resource/Create` | `resource/create` |
| Прочитать | `Resource/Get` | `resource/get` |
| В корзину | `Resource/Delete` | `resource/delete` |
| Удалить навсегда | `Resource/Trash/Purge`, `Resource/EmptyRecycleBin` | `resource/emptyrecyclebin` |
| Снять с публикации | `Resource/Unpublish` | `resource/unpublish` |
| Сбросить кеш | `System/ClearCache` | `system/clearcache` |
| Вход | `Security/Login` | `security/login` |
| Загрузка файла | `Browser/File/Upload` | `browser/file/upload` |

Подвох для `requestDenied`: `modX::runProcessor` принимает `action` тремя способами — полным именем класса `MODX\Revolution\Processors\...`, строкой с любым регистром (`resource/update` превратится в класс через `ucfirst`) и файлом процессора (`modX.php:1769-1810`). `action` читается и из адреса, и из тела (`$_REQUEST`, `modConnectorRequest.php`), для TV сегмент подменяется на `TemplateVar`. Правило адаптера должно быть **списком разрешённого**, нормализовать значение (нижний регистр, `\` → `/`) и смотреть и query, и тело. У дополнений свои коннекторы: `assets/components/<пакет>/connector.php`, `action=mgr/orders/getlist`. Все такие пути закрывать по умолчанию.

`SiteBrowserRequest.postData` — текст формы; Ext шлёт `application/x-www-form-urlencoded`, загрузка файлов — multipart.

### 8.4. Редактор страницы

Интерфейс — Ext JS 3 с прослойкой ModExt (`manager/assets/modext/`). Кнопки строятся скриптом (`manager/assets/modext/sections/resource/update.js`, `getButtons`).

| Элемент | Селектор | Текст | Что делает |
| --- | --- | --- | --- |
| Сохранить | `#modx-abtn-save` | `Сохранить` / `Save` | XHR `Resource/Update`, Ctrl+S |
| Копировать | `#modx-abtn-duplicate` | `Копировать` / `Duplicate` | окно дублирования |
| Просмотреть | `#modx-abtn-preview` | `Просмотреть` / `View` | открывает страницу |
| Закрыть | `#modx-abtn-cancel` | `Закрыть` / `Close` | — |
| Удалить | `#modx-abtn-delete` | **только иконка** `icon-trash-o` | `Resource/Delete` |
| Восстановить | `#modx-abtn-undelete` | только иконка | — |
| Удалить навсегда | `#modx-abtn-purge` | только иконка | — |

**Отдельной кнопки «Опубликовать» нет.** Публикация — флажок `#modx-resource-published` (`name=published`) на панели страницы, применяется той же кнопкой «Сохранить». Значит, `browserCommitAction(role, name)` видит только `save`, а публикация ли это, видно из `published` в теле запроса или из последующего чтения.

Поля: `#modx-resource-pagetitle`, `#modx-resource-longtitle`, `#modx-resource-description`, `#modx-resource-introtext`, `#modx-resource-alias`, содержимое — `#ta`, скрытая копия `#hiddenContent` (`manager/assets/modext/widgets/resource/modx.panel.resource.js`). Визуального редактора в ядре нет: TinyMCE RTE, CKEditor, Ace — дополнения (`which_editor`), разметка поля зависит от них.

### 8.5. Перепроверка сохранения GET-запросом

| Способ | Что даёт | Оговорка |
| --- | --- | --- |
| `?a=resource/update&id={id}` | HTML с `MODx.load({...})`, где `record` — поля страницы, плюс `preview_url` (`manager/controllers/default/resource/update.class.php:48-70`) | побочный эффект: `addLock` ставит блокировку на 360 с (`update.class.php:214`, `core/src/Revolution/modResource.php:766-781`) |
| `<connectors>/index.php?action=Resource/Get&id={id}&HTTP_MODAUTH=<токен>` | JSON | токен сначала надо прочитать со страницы менеджера (`MODx.siteId`). Форма плана та же, что у WordPress: первый GET за токеном, второй за объектом (`packages/site-adapters/src/wordpress-browser-task.ts:773-782`) |
| `?a=resource/data&id={id}` | только `id`, `context_key`, `class_key`, `pagetitle`, `preview_url`, `parents` | статуса публикации нет |
| Публичный адрес | `index.php?id={id}` | только опубликованное |

Адрес редактора для `browserCheckpointOf`: `<manager>/?a=resource/update&id={id}`. После создания панель уходит на маршрут из ответа с `id` (`modx.panel.resource.js:346`), поэтому id определяется адресом, как у WordPress.

### 8.6. Что опасно давать агенту

| Что | Почему |
| --- | --- |
| Сниппеты и плагины (`Element/Snippet/*`, `Element/Plugin/*`) | произвольный PHP на проде: `SECURITY.md` прямо называет скрипты менеджера намеренным поведением |
| Шаблоны и чанки в задаче браузера | вызов любого сниппета тегом, вывод настроек |
| Поле `content` страницы с тегами | то же: §12, п. 2 |
| `Browser/File/*`, `?a=system/file/edit` | источник Filesystem по умолчанию начинается с корня сайта: `basePath` пуст (`core/src/Revolution/Sources/modFileMediaSource.php:102-108`, `modMediaSource.php:282-285`), `skipFiles` не закрывает `core/` (`modFileMediaSource.php:178-183`), `Browser/File/Get` с правом `file_view` читает файл. По коду виден `core/config/config.inc.php`; **не проверено запуском** |
| `System/*`, `Workspace/*`, `Security/*`, `Context/*`, `Source/*` | настройки, пакеты, пользователи, контексты |
| Удаление | `Resource/Delete`, `Resource/Trash/Purge`, `Resource/EmptyRecycleBin`, кнопки без текста |
| Группы ресурсов на странице | закрывают страницу от посетителей через обычное поле формы |
| Экраны дополнений и их коннекторы | заказы, покупатели, платежи |
| `mail_*`, `emailsender` | смена отправителя и SMTP |

---

## 9. Проверка сайта после выпуска

### 9.1. Что открывать

| Поле `VerifyPlan` | Значение для MODX |
| --- | --- |
| `pages` | путь адреса сайта, как у WordPress. Только главная: `error_page` по умолчанию `1`, то есть страница 404 отдаёт содержимое главной с кодом 404, а прочие адреса зависят от ЧПУ |
| `recordPages` | `{ resource: '<front>index.php?id={id}' }`: работает при любом значении `friendly_urls`, при `request_method_strict` даёт 301 на ЧПУ (`core/src/Revolution/modRequest.php:97-108`). Параметр может быть не `id`, если сменён `request_param_id` |
| `logFiles` | `<core>/cache/logs/error.log`; при своём ключе конфигурации — `<core>/cache/<ключ>/logs/error.log`; настройки `error_log_filename`, `error_log_filepath` могут увести журнал в другое место |
| `failureMarkers` | таблица ниже |

### 9.2. Текст поломки на странице

| Текст | Откуда | Код ответа |
| --- | --- | --- |
| `A fatal application error has been encountered.` | `core/error/fatal.include.php` | 500 |
| `Error 500: Internal Server Error` | там же | 500 |
| `Error 503: Site temporarily unavailable` | `index.php`, класс не найден или автозагрузчик недоступен | 503 |
| `Error 503: Service temporarily unavailable` | `modX::sendError`, `modX.php:1165` | 503 |
| `Error 503: Service Unavailable` | `core/error/unavailable.include.php` | 503 |
| `Site temporarily unavailable` | `index.php`, `modX::sendError` | 503 |
| `MODX not installed. Install now?` | `index.php`: конфиг не загрузился | 503 |
| `Could not load MODX config file.` | `modX.php`, `loadConfig`; печатается как `error_message` | 503 |
| `<b>Fatal error</b>:`, `<b>Parse error</b>:` | PHP с `display_errors`, та же пара, что у WordPress | любой |

`site_status=0` — сайт закрыт владельцем: `modRequest.php:89` выводит `site_unavailable_message`, это не поломка выпуска, но проверка увидит чужую страницу. Значение настройки по умолчанию — тег словаря `[[%site_unavailable_message]]`, текст зависит от языка.

**Что маркеры не поймают.** Сниппет с ошибкой обычно не роняет страницу: `modErrorHandler` пишет в журнал, вывод продолжается, блок просто исчезает. Поэтому после выпуска важнее новые строки `(ERROR @ …)` в `error.log`, чем текст страницы. Строка журнала имеет вид `[YYYY-MM-DD HH:MM:SS] (ERROR @ файл : строка) сообщение`. Журнал растёт сам и содержит старые ошибки: сравнивать надо только хвост, дописанный после выпуска. `[[` как маркер брать нельзя: это законный текст в примерах и в выводе `&#91;&#91;`.

### 9.3. Кеш

| Уровень | Как сбросить | Заметка |
| --- | --- | --- |
| `core/cache/` целиком | удалить содержимое по FTP или SFTP | «MODX rebuilds cache on demand, so clearing `core/cache/` is safe» (docs:getting-started/directory-structure.md); `moving-your-site.md` называет это самым надёжным способом |
| API | `$modx->cacheManager->refresh()`: разделы `auto_publish`, `system_settings`, `context_settings`, `namespaces`, `db`, `media_sources`, `lexicon_topics`, `scripts`, `default`, `resource`, `menu` (`core/src/Revolution/modCacheManager.php:579-591`) | через файл-соединитель |
| Частично | `refresh(['resource' => ['contexts' => ['web']]])` | для правки текста хватит |
| Админка | `System/ClearCache`, событие `OnSiteRefresh` | не для автоматики |
| Кеш PHP | **ядро не вызывает `opcache_reset` и `opcache_invalidate`** (поиск по `core/src` и по `xpdo` в дистрибутиве пуст) | своя функция в соединителе; порт `SiteCodeCacheGateway` подходит (`packages/domain/src/ports/published-content.ts:199-203`), но `refreshCode(paths)` у MODX шире файлов выпуска: скомпилированные скрипты лежат в `core/cache/includes/` |

Порядок при выпуске: файлы → операции базы → сброс кеша MODX → сброс opcache → проверка. Без сброса проверка увидит старую страницу: и правка базы, и правка файла статического элемента не видны до `refresh`.

---

## 10. Лицензия и право

| Вопрос | Ответ | Основание |
| --- | --- | --- |
| Лицензия ядра | GPL-2.0, `composer.json`: `GPL-2.0+`; `Copyright (c) 2006-present by MODX, LLC` | `LICENSE`, `COPYRIGHT`, API GitHub |
| Хранить ядро клиента в его приватном репозитории | ограничений лицензии не видно: это копия у того, кто её получил | GPL; заключение — за юристом |
| Запускать копию сайта клиента в предпросмотре | то же: запуск GPL не ограничивает | то же |
| Базовый образ с ядром | не нужен: ядро приходит с деревом сайта. Если платформа будет раздавать образ наружу, это распространение GPL с обязанностями по исходникам; внутренний образ — нет | то же |
| Правка ядра агентом | закрыта правилами продукта; лицензия разрешает | — |
| Торговая марка MODX | условия **не проверены**: `modx.com` недоступен | — |
| Дополнения открытого репозитория | обычно GPL, каждое со своей лицензией | `manifest-attributes.license` пакета |
| Платные дополнения modstore.pro | по FAQ магазина: платное дополнение покупается заново на каждый сайт, ключи создаются из кабинета, ставить на localhost не рекомендуется, стабильность там не гарантируют. Домены для копий не описаны | только выдержка поисковой выдачи `en.modstore.pro/faq`; сам сайт недоступен, **первичный текст не прочитан** |
| Зашифрованные пакеты modstore | пакеты собираются как `EncryptedVehicle`, для установки нужен поставщик `https://modstore.pro/extras/` с email и API-ключом; иначе `Package provider not found` | `ru-docs:components/msyandexdelivery/index.md`, `components/mxquickview/index.md` |
| Работает ли установленное платное дополнение на другом домене | **не проверено.** Проверка лицензии при выполнении может быть | — |
| modmore | лицензия на одну установку и один основной домен; копии **не проверены** | выдержка `support.modmore.com`, страница отвечает 403 |

Практический вывод: предпросмотр на домене `*.raditi-preview.ru` с платными дополнениями — это отдельный вопрос к условиям магазинов. Это не вопрос лицензии ядра. Дополнения с проверкой домена могут отказать в копии, и лента должна говорить об этом словами клиента, а не показывать пустой блок.

---

## 11. Docker

### 11.1. Что есть

| Образ | Кто | Состояние | Вывод |
| --- | --- | --- | --- |
| `docker-library/official-images`, `library/modx` | — | **записи нет** (перечень каталога `library` на 01.11.2026; есть `joomla` и `wordpress`) | официального образа Docker Hub нет |
| `modxcms/docker-modx` | организация MODX | `FROM php:7.1-apache`, `MODX_VERSION 2.7.0`, последний коммит 30.09.2020, в compose образ `maki/modx` | мёртв |
| `Prihod/docker-modx` | сообщество | nginx, PHP, MariaDB, последний коммит 07.09.2026; ставит `php setup/index.php --installmode=new` | образец сценария, не основа |
| `modmore/Gitify` `modx:install` | modmore | `php -d date.timezone=… setup/index.php --installmode=new --config=…` (`src/Command/InstallModxCommand.php:115`) | образец вызова |

### 11.2. Базовый образ предпросмотра

Ядро в образ класть не нужно: оно в репозитории сайта, а `core/vendor/` входит в импорт. Нужны только PHP, Apache, MariaDB.

| Что | Состояние в `infra/preview/Dockerfile` | Что сделать |
| --- | --- | --- |
| База PHP и Apache | `ARG BASE=wordpress@sha256:…` | официальный образ `wordpress` ставит `bcmath exif gd intl mysqli zip`, `imagick` (`docker-library/wordpress`, `latest/php8.3/apache/Dockerfile:45-54`) |
| **`pdo_mysql`** | **нет** | `docker-php-ext-install pdo_mysql`: без него xPDO не подключится к базе. Можно собрать от `php:<версия>-apache`: WordPress здесь нужен только как источник расширений |
| `curl dom fileinfo json mbstring pdo simplexml xml xmlwriter zlib` | есть в официальном образе `php` по умолчанию | **не проверено запуском** |
| `gd`, `zip`, `intl`, `imagick` | есть | — |
| `mod_rewrite` | подключается в `preview-apache.conf` | — |
| MariaDB 11.8.9 | есть | подходит: 10.6+ рекомендован |
| WP-CLI | есть | для MODX не нужен |
| Выбор образа | `PREVIEW_SITE_IMAGES` — только по версии PHP (`8.3=<digest>`) | один образ на все PHP-стеки, если добавить расширения общим слоем |
| PHP для 2.8 | `phpVersions` в `wordpress-preview.ts:18` начинается с 7.4 | сайты на PHP 5.6–7.3 пойдут на 7.4; на 2.8 вероятны предупреждения и отличия. `runtimeVersions` для 2.8 лучше ограничить `7.4`–`8.1` (8.2 только с поправками 2.8.7+), для 3.2 — `8.1`–`8.5`, для 3.1 — `7.4`–`8.4`, для 3.0 — `7.4`–`8.2` |

Рецепт зависит от ветки: для 2.x и 3.x разный список `requiredPaths`, но запуск один и тот же: `index.php`, Apache, конфиг.

### 11.3. Установленный сайт в стенде

Шаги не запускались, собраны из docs:getting-started/installation/cli.md и `setup/config.dist.new.xml`.

```sh
curl -fsSO https://modx.s3.amazonaws.com/releases/3.2.4/modx-3.2.4-pl.zip
unzip -q modx-3.2.4-pl.zip && mv modx-3.2.4-pl/* /var/www/html/
# база уже создана; config.xml вне дерева
php /var/www/html/setup/index.php --installmode=new --config=/tmp/modx-config.xml
```

Пересказ. Файл настроек собран по образцу `setup/config.dist.new.xml`, заполненный файл стенда — `scripts/spike-gap6/modx-config.xml`. Что в нём важно:

- база: `database_type`, `database_server`, `database`, `database_user`, `database_password`, `database_connection_charset` и `database_charset` со значением `utf8mb4`, `database_collation` со значением `utf8mb4_unicode_ci`, `table_prefix`;
- адрес: `https_port`, `http_host`;
- `inplace` = 1, потому что архив уже распакован; `unpacked` = 0; `language`;
- администратор: `cmsadmin`, `cmspassword`, `cmsadminemail`;
- пути: `core_path`, `context_mgr_path` и `_url`, `context_connectors_path` и `_url`, `context_web_path` и `_url`;
- `remove_setup_directory` = 1.






















| Деталь | Значение |
| --- | --- |
| Записываемые папки | корень, `core/config`, `core/packages`, `core/cache`, `core/export` (docs:getting-started/installation/advanced.md) |
| Журнал установки | `core/cache/logs/` |
| Другой ключ | `--config_key=<ключ>` |
| Защита | после запуска `setup/.locked` не даёт запустить установщик снова, если папка не удалена (`setup/includes/modinstall.class.php:659-672`) |
| Снимок для стенда | `mysqldump` + архив дерева без `core/cache`; один снимок на ветку 2.8 и 3.2 |
| 2.8 | тот же сценарий, архив `releases/2.8.9/modx-2.8.9-pl.zip`, PHP 7.4 |
| Дополнения в снимке | `gitify package:install` либо пакет в `core/packages/` с процессорами; поставщик по умолчанию — `https://rest.modx.com/extras/` (`_build/transport.core.php:191`). miniShop2 у поставщика modstore, ключ — не для стенда; проще собрать из `modx-pro/miniShop2` |

Сеть: доступ к S3 AWS из России и из CI **не проверялся**, поэтому архив версии лучше держать в своём зеркале с контрольной суммой.

---

## 12. Что сломает допущения WordPress

1. **Код сайта в базе.** Рабочий набор и `git` хода рассчитаны на файлы: тема лежит в `wp-content/themes/`. Здесь шаблон — строка таблицы. Диффа, `gitleaks`, `protectedPaths` и `forbiddenCiPaths` для него нет. Нужны выгрузка в файлы и вид операции `element_update` в `dbOperationKinds` (`packages/domain/src/release/db-plan.ts:29-34`), плюс правило 3: файл выпуска сегодня не меняет базу, а тут «вёрстка» — это операция плана.
2. **Текст страницы исполняется.** Парсер обрабатывает `[[Snippet]]`, `[[!Snippet]]`, `[[$chunk]]`, `[[*field]]`, `[[++setting]]`, `[[~id]]`, `[[%lexicon]]` и фильтры внутри `site_content.content`, чанков и шаблонов. Настройки становятся подстановками целиком, из них вырезаны только `password`, `username`, `mail_smtp_pass`, `mail_smtp_user`, `proxy_password`, `proxy_username`, `connections`, `dsn`, пути и несколько других ключей (`modX.php`, `initialize`, при `filter_config_placeholders`; в 2.8.9 тот же фильтр). Ключи дополнений не вырезаны, как и `mail_dkim_passphrase` и `mail_dkim_privatekeystring` ядра. Следствия: `content_update` с `[[++mail_dkim_privatekeystring]]` или с ключом платёжки напечатает секрет на публичной странице; `[[!Сниппет]]` запустит код; модель можно подтолкнуть к этому текстом с чужой страницы. План БД должен проверять теги: разрешать `[[~id]]` и список безопасных, остальное показывать клиенту.
3. **`rootMarkers` — не список имён**: §2.1. `manager/` и `connectors/` выглядят как вложенный сайт.
4. **Одного корня нет.** На 2.x `core/` бывает вне docroot. `SiteFacts.docroot` всюду `'/'`, `readRootFile`, импорт и запись на хостинг исходят из одного дерева. Нужно либо отказать таким сайтам в мастере словами клиента, либо ввести соответствие «путь в репозитории → путь на хостинге».
5. **Имена папок разные у каждого сайта.** `manager/`, `connectors/`, `assets/`, ключ конфигурации. `protectedPaths(site)`, `agentWorkingSet(site)`, `browserTaskPolicy(site)`, `generatedFiles` зависят от них, а `extras` всюду пуст (`apps/core/src/previews/preview-builder.ts:190`, `apps/core/src/releases/release-skill.ts:701`, `apps/core/src/tasks/pass-facts.ts:67`). Раскладку нужно читать при подключении и хранить со строкой сайта. `BrowserTaskSite` тоже знает только `url` (`site-adapter.ts:290-292`), а политике нужен адрес менеджера и коннекторов.
6. **Абсолютные пути в трёх файлах `config.core.php` и в `config.inc.php`.** Перенос с хостинга в контейнер меняет их. Они не секрет, но предпросмотр обязан писать свои, а выпуск обязан **не** писать файлы из репозитория на прод: иначе сайт клиента получит путь контейнера.
7. **Кеш лежит в дереве и держит секреты.** `core/cache/` исключается безусловно. После выпуска кеш надо чистить, opcache сбрасывать отдельно. В предпросмотре полная запись дерева (`replace`, `infra/preview/files.mjs:437-439`) сносит `core/cache/` вместе со всем остальным, а запись разницы (`apps/core/src/previews/preview-builder.ts:890-902`) его не трогает: после синхронизации хода кеш устарел и его надо сбрасывать командой. Папок `core/cache/`, `core/packages/`, `core/export/` в репозитории нет: рецепт создаёт их сам, а создаст ли MODX их на лету при таких правах, **не проверено запуском**.
8. **Чтение страницы меняет базу.** `modElement::getContent()` у статических элементов пишет файл в базу при GET. Состояние «до» для плана БД может поменяться от обычного просмотра.
9. **Нет REST и токена.** `SiteContentAdapter.accessKind` сегодня `wp`, `siteAccessKinds` — `ssh, ftp, wp, browser, git, db` (`site-adapter.ts:95`). Нужен вид доступа для файла-соединителя MODX и свой способ подписи запроса. В `apps/mcp` инструмент называется `wp_rest` и прибит литералом схемы (`apps/mcp/src/access/mcp-policy.ts:39`, `apps/mcp/src/content/mcp-content.controller.ts:50`), `published-value.ts` в `packages/site-content` тоже его знает.
10. **Объекты не `post` и `page`.** `publishedObjectRefSchema` — `^(post|page):…` (`packages/domain/src/ports/published-content.ts:4`). В MODX один тип `resource:<id>`, различие — `class_key`. `publishedContentFieldsSchema` даёт `title`, `content`, `excerpt`, а здесь `pagetitle`, `longtitle`, `description`, `introtext`, `content`, `menutitle` и TV. `browserCheckpointKinds` — только `post`.
11. **Предел значения.** `dbPlanLimits.valueBytes` — 32 КиБ, а `content` и код элементов — `mediumtext`. Большой шаблон в план не влезет.
12. **Предел политики копии.** 64 таблицы, 256 значений в условии, 32 `overrides`, `match` по одной колонке: §6.1, §6.4.
13. **`dbSettingSchema` и имена ключей.** `^[a-z][a-z0-9_]{0,63}$` (`packages/domain/src/release/db-objects.ts:457`) не примет `cultureKey`, `modRequest.class` и ключи с точкой вроде `mxbackup.storage_path`. В `system_settings.key` до 50 знаков, ограничение ложится только на закрытый список, но `option:`-ссылки ему подчинены.
14. **Кодировка соединения без `collation`.** `collation: null` законен по схеме, но `database_collation` из конфига не узнать.
15. **Один контекст — допущение.** `web` по умолчанию, но многоязычные и многодоменные сайты держат несколько контекстов с `site_url`, `http_host` и шлюз-плагином (Babel и аналоги). На одном адресе предпросмотра откроется только один контекст. Адреса других контекстов надо либо отображать на поддомены, либо честно говорить, что не показываем.
16. **Подмена адреса без mu-plugin.** Хука, не зависящего от базы, в 2.x нет: §4.6.
17. **Письма и cron.** Отключаются не одной константой, а настройками, `sendmail_path` и списком разрешённого. Cron ядра нет, `auto_publish` идёт по запросу через кеш.
18. **Страница входа не отличается по адресу.** `isSignInPage(path)` чисто по пути не ответит. Если вернуть `true` для всего `manager/`, `signIn` будет ждать поля на вошедшей странице до конца срока (`packages/browser-providers/src/cloud/cloud-browser.ts:1312-1335`). Порту нужен признак по странице: наличие `#modx-login-form`.
19. **Интерфейс — Ext JS 3.** Сохранение идёт XHR с одним адресом, политика разбирает тело. Кнопки удаления без текста, значит `browserCommitAction(role, name)` их не назовёт: закрывать надо запросом, а не кнопкой. Дерево ресурсов, контекстное меню и окна Ext — не обычная разметка. Насколько наблюдение через дерево доступности пригодно для работы агента, **не проверено запуском** и может оказаться главным риском браузерных задач.
20. **Публикация — флажок.** Отдельного действия нет, `BrowserCommitAction` `publish` определить по кнопке нельзя.
21. **Блокировки.** Открытие редактора ставит блокировку на 360 с; другой пользователь увидит «занято» (`update.class.php:214-226`): кнопка `#modx-abtn-save` скрыта, вместо неё `#modx-abtn-locked`. Сессия агента и сессия клиента в одном браузере совпадают, но открытая у клиента админка в другом браузере помешает.
22. **Файловый менеджер видит корень.** §8.6.
23. **`users` — это и клиенты магазина.** Покупатели и администраторы лежат в одной таблице и различаются только членством в группах и `sudo`.
24. **Дополнения меняют схему и маршруты.** `ms2_*`, `ms3_*`, `tickets_*`, `formit_forms` и другие: персональные данные и каталог зависят от того, что установлено. WordPress-подход «закрытый список экранов» здесь не работает: у каждого дополнения свой `namespace` и свой коннектор, только запрет по умолчанию.
25. **Обновление ядра.** Обновить MODX — запустить `setup`, а не положить файлы. В 3.x дополнительно Composer. Адаптеру нельзя обещать «обновите ядро кнопкой».
26. **Опасность от старого PHP.** Сайт на 2.8 может держаться на PHP 5.6–7.3, а образов таких нет; на 7.4 он может открыться иначе, чем на проде.
27. **`.htaccess` в `manager/` и `core/`.** Ими держится закрытие ядра. Импорт их не берёт (`phpServerConfigFiles`), поэтому в предпросмотре закрытие должно быть в конфигурации Apache, иначе `core/` отдаётся по HTTP.
28. **Установка не требует плагина, но и не даёт его.** В WordPress плагин «Радити» — обычная часть экосистемы, а здесь файл-соединитель в `assets/` виден как чужой PHP, и правила хостинга могут запрещать его запуск.

---

## 13. Карта к `SiteAdapter`

Предложения, не решения. Проверяются при написании адаптера.

| Метод | Значение для MODX |
| --- | --- |
| `stack` | новое значение `modx` в `siteStacks` (`site-adapter.ts:26`); подпись в `apps/web/src/components/projects/project-labels` |
| `detect` | у WordPress `notImplemented`; для MODX полезен: версия, ветка, раскладка из §2.2 |
| `rootMarkers` | предикат вместо списка: §2.1 |
| `importRules.exclude` | `/core/config/`, `/core/cache/`, `/core/packages/`, `/core/export/`, `/core/import/`, `/setup/`, `/_build/`, `/_backup/`, `/_data/`, `/_packages/`, `/.gitify`, `config.inc.php*` на любой глубине, общие `archivesAndDumps`, `dataFiles`, `secretFiles`, `serverLogs`, `phpServerConfigFiles`; имена `core/` и остальных папок — из раскладки |
| `protectedPaths` | `index.php`, `config.core.php`, `core/`, `manager/`, `connectors/`, `setup/`, `assets/components/`, `**/.htaccess` и другие из `phpServerConfigProtected`, файлы платформы |
| `snapshotExcludes` | `core/cache/`, `core/packages/`, медиа, `vendor/`, `core/vendor/`, журналы |
| `agentWorkingSet` | `include`: `/assets/`, папка выгрузки элементов, свои `core/components/<ns>/`; `exclude`: `/assets/components/`, медиа, общие списки |
| `mediaRules` | `addOnlyPaths: ['assets/raditi/']`, остальное как у WordPress. SVG и загрузку PHP отклонять, как там же |
| `configSecrets` | `config.core.php` → ключ → `<core>/config/<ключ>.inc.php`: `$database_password`, `$database_user`, `$database_dsn`, `$site_id`, `$uuid`, строки `$config_options` |
| `publicOriginals` | ядро: архив той же версии с S3 по `core/docs/version.inc.php`. Дополнения: `rest.modx.com`, платные нет |
| `databaseSettings` | `$table_prefix`, `$database_connection_charset`, `collation: null` |
| `previewRecipe` | `runtimeVersions` по ветке (§11.2); `database: 'mysql'`; `requiredPaths` 3.x: `index.php`, `core/vendor/autoload.php`, `core/src/Revolution/modX.php`, `core/docs/version.inc.php`, 2.x: `index.php`, `core/model/modx/modx.class.php`, `core/xpdo/xpdo.class.php`, `core/docs/version.inc.php`; `generatedFiles`: `core/config/config.inc.php`, три `config.core.php`, файл-соединитель, `raditi-preview-cli.php`; `settings`: `TABLE_PREFIX`, `DB_CHARSET`; Apache: своя копия конфигурации с правилом ЧПУ и `Require all denied` на `core/`; `content.access`, `content.objects` через `php`, `pages: { resource: '/index.php?id={id}' }` |
| `databaseCopyPolicy` | §6.1–§6.4, `engine: 'mysql'`, `users` и `user_attributes` синтетические, `overrides` из §6.4 |
| `dbOperationKinds` | `content_update` с полями MODX, `option_update`, `post_create` (`resource`), `schema_migration` для таблиц платформы, новый вид для элементов |
| `dbSettings` | короткий закрытый список: `site_name` и подобное; адрес, почта, вход, кеш — никогда |
| `dbPlanGuide` | описание инструментов и ссылок `[[~id]]`; запрет тегов исполнения |
| `verify` | §9 |
| `browserRequestDenied`, `browserTaskPolicy` | запрет по умолчанию, разрешённые `a=` и `action` из §8.2–§8.3, нормализация, все `assets/components/*/connector.php` закрыты; `signIn` с селекторами §8.1 |
| `browserCheckpointOf` | `<manager>/?a=resource/update&id={id}` → `resource`, id; нужен новый вид в `browserCheckpointKinds` |
| `browserCommitAction` | `button` + `Сохранить` или `Save` → сохранение; публикации по кнопке нет |
| `browserVerification` | §8.5: `GET` за токеном, `GET Resource/Get` |
| `browserGuide` | особенности Ext, `Ctrl+S`, вкладки, флажок публикации |
| `SiteContentAdapter` | свой `accessKind`, файл-соединитель, `createCodeCache` с `opcache_reset` и `refresh` |

Новые сущности архитектуры, которые вытекают из разделов выше:

| Что | Зачем |
| --- | --- |
| Раскладка сайта рядом со строкой `sites` (или `site_code_sources`) | `core`, `manager`, `connectors`, `assets`, ключ конфигурации, ветка, версия. Заполнять в `detect` |
| Обход импорта с предикатом корня | §2.1 |
| Выгрузка элементов и вид операции для них | §5.3, §12.1 |
| Проверка тегов содержимого | §12.2 |
| Учёт установленных дополнений | §6.2, §10 |
| Общий хук «подмена адреса» для PHP-стеков | §4.6: пригодится и Joomla, и OpenCart |
| Общий образ `site` с `pdo_mysql` | §11.2 |
| Признак страницы входа по DOM | §12.18 |

---

## 14. Источники

Дата обращения ко всем — 01.11.2026.

**Первичные, прочитаны целиком или в нужных файлах**

- MODX Revolution, теги [`v3.2.4-pl`](https://github.com/modxcms/revolution/tree/v3.2.4-pl) и [`v2.8.9-pl`](https://github.com/modxcms/revolution/tree/v2.8.9-pl); список тегов и веток — API GitHub.
- Архивы: `https://modx.s3.amazonaws.com/releases/3.2.4/modx-3.2.4-pl.zip`, `…-advanced.zip`, `…-sdk.zip`, `https://modx.s3.amazonaws.com/releases/2.8.9/modx-2.8.9-pl.zip`, `…-advanced.zip`.
- [`modxorg/Docs`](https://github.com/modxorg/Docs), ветки `3.x` и `2.x`: `en/getting-started/*`, `en/building-sites/*`, `en/extending-modx/*`.
- [`modx-pro/Docs`](https://github.com/modx-pro/Docs): `docs/faq/*`, `docs/components/*`.
- [`evolution-cms/evolution`](https://github.com/evolution-cms/evolution), ветка `3.6.x`; [`modxcms/evolution`](https://github.com/modxcms/evolution) — архив.
- [`modx-pro/miniShop2`](https://github.com/modx-pro/miniShop2), [`modx-pro/MiniShop3`](https://github.com/modx-pro/MiniShop3), [`Sterc/FormIt`](https://github.com/Sterc/FormIt), [`modx-pro/Tickets`](https://github.com/modx-pro/Tickets): схемы.
- [`modmore/Gitify`](https://github.com/modmore/Gitify), [`Finetuned/modx-cli`](https://github.com/Finetuned/modx-cli), [`modxcms/docker-modx`](https://github.com/modxcms/docker-modx), [`Prihod/docker-modx`](https://github.com/Prihod/docker-modx).
- [`docker-library/official-images`](https://github.com/docker-library/official-images/tree/master/library), [`docker-library/wordpress`](https://github.com/docker-library/wordpress).
- [Packagist `modx/revolution`](https://packagist.org/packages/modx/revolution).
- [Issue #15476](https://github.com/modxcms/revolution/issues/15476): MODX3 Core Folder Name cannot be renamed, открыт.

**Статистика**

- [W3Techs, MODx](https://w3techs.com/technologies/details/cm-modx): 0,1%, ноябрь 2026.
- [W3Techs, CMS в `.ru`](https://w3techs.com/technologies/segmentation/tld-ru-/content_management): 01.11.2026, MODX на странице нет.
- [Рейтинг CMS YBRU 2024, workspace.ru](https://workspace.ru/blog/reyting-cms-i-platform-po-sozdaniyu-saytov-v-2024-v-rossii-ot-ybru/): вторичный пересказ, первичный отчёт не читался.

**Только выдержки поиска, первичная страница недоступна**

- [FAQ modstore.pro](https://en.modstore.pro/faq): соединение отклонено.
- [support.modmore.com, лицензии](https://support.modmore.com/article/240-can-i-use-a-single-license-on-a-multi-context-site-or-across-different-domains): 403.
- [wmtips, MODX](https://www.wmtips.com/technologies/cms/modx): 403.
- [Хабр, статья о защите MODX, 2017](https://habr.com/ru/post/335148): как свидетельство практики, не как норма.
- [Анонс 3.2.0, community.modx.com](https://community.modx.com/t/revolution-3-2-0-released/8983): прочитан, о поддержке старых веток ничего не сказано.

**Не проверено и остаётся открытым**

| Вопрос | Как закрыть |
| --- | --- |
| Распределение версий MODX в России | выборка по живым сайтам |
| Минимальный набор таблиц для запуска | стенд из §11.3 |
| Форма `config.core.php` на установленном сайте | стенд |
| Наблюдение Ext JS 3 через дерево доступности | стенд с браузером |
| Подмена адреса буфером вывода | стенд |
| Работа платных дополнений на чужом домене | условия modstore и проба на купленном дополнении, вместе с владельцем |
| Доля сайтов с вынесенным `core` | выборка; мастер должен считать такие отказы |
| Точные папки файлов посетителей у FormIt, Tickets, Office | чтение кода дополнений при написании адаптера |

