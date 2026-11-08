# 1С-Битрикс: Управление сайтом — исследование для адаптера стека Радити

Все внешние источники проверены 01.11.2026, если не сказано иное. Код Радити — `raditi-stacks` (ветка `feat/site-stacks`, `c811abf1`).
Прочитанный код Битрикса (скачан). Для этого отчёта он не запускался; один раз ставилось демо вендора ради замера деревьев админки, `map/gap-agent-quality-per-stack.md`, §4.2, стенд удалён, вопрос О5 проекта:

| Что | Откуда | Версия | Где лежит |
| --- | --- | --- | --- |
| Дистрибутив «Стандарт» | https://www.1c-bitrix.ru/download/standard_encode.tar.gz | `SM_VERSION` 26.150.0 от 2026-02-19, архив от 02.04.2026, 318 042 733 байта, sha256 `ca53f4fa…0276` | `research/src/bitrix/tree` |
| Дистрибутив «Бизнес» | https://www.1c-bitrix.ru/download/business_encode.tar.gz | та же версия, архив от 02.04.2026, 398 402 890 байт | `research/src/bitrix/tree-business` |
| Документация вендора | https://github.com/bitrix-tools/framework-docs | `8eabcce` от 30.10.2026 | `research/src/bitrix/gh/framework-docs` |
| Контейнеры вендора | https://github.com/bitrix-tools/env-docker | `528f46e` от 22.10.2026 | `research/src/bitrix/gh/env-docker` |
| EULA | https://www.1c-bitrix.ru/download/law/eula_bus.pdf | редакция от 27.05.2025 | `research/src/bitrix/law` |
| `restore.php`, `bitrixsetup.php`, `bitrix_server_test.php` | https://www.1c-bitrix.ru/download/scripts/ | на 01.11.2026 | `research/src/bitrix/scripts-dl` |

Пути вида `main/...` ниже — от `bitrix/modules/` дистрибутива; пути `packages/...`, `apps/...` — от корня Радити.

**Ограничение исследования.** Обфусцированные файлы ядра не декодировались: EULA относит обфусцированный код к техническим средствам защиты (п. 3.7), алгоритмы и исходные коды — к коммерческой тайне (п. 3.2), а деобфускацию с целью устранения ограничений — к нарушениям (п. 8.3). Поэтому то, что делает проверка лицензии внутри этих файлов, описано только по документации и открытому коду. Что не подтвердилось, помечено «не проверено» и выясняется только опытом на стенде с законной лицензией или ответом вендора.

## 0. Главные выводы

1. **Юридическая стена важнее технической.** EULA п. 4.8 запрещает копировать Программу и созданные на её базе Сайты в любой форме и любым способом, в том числе в исходном коде, п. 4.2 разрешает дополнительную копию только для разработки и тестирования и только если к ней нет внешнего доступа, ни из интернета, ни из-за пределов локальной сети пользователя. Предпросмотр Радити — копия на чужих серверах, открываемая по адресу в интернете. Базовый образ с ядром, импорт ядра в Gitea и кеш ядра у платформы упираются в эти пункты. До ответа юриста и письменной позиции 1С-Битрикс предпросмотр с настоящим ядром делать нельзя считать решённым (раздел 10).
2. **Первый срез, который можно делать сразу, — задачи в браузере на самом сайте** (план 57, Б1): ни копии ядра, ни копии базы, ни импорта. Вариант мастера «Без доступа к файлам» уже есть. Нужны только методы `browserTaskPolicy`, `browserCheckpointOf`, `browserCommitAction`, `browserVerification`, `browserGuide` и расширение типов (раздел 8).
3. **Причина запрета импорта ядра в заглушке нигде не записана**: `packages/site-adapters/src/bitrix.ts:13` и `docs/spec.md:1452` просто объявляют «ядро `/bitrix/` не трогаем». Проверка показала, что запрет верен по двум независимым причинам: EULA и размер. Установленное ядро «Бизнес» — оценка ≈ 1,6 ГБ, ≈ 108 000 файлов и ≈ 45 000 папок; лимиты импорта — 1 ГиБ, 100 000 файлов, 20 000 папок (`packages/domain/src/site-connection/limits.ts:51-60`). Один только нераспакованный мастером дистрибутив «Бизнес» уже даёт 25 194 папки.
4. **Допущение заглушки «код сайта живёт в `/local/`» неверно для реальных сайтов.** Папка `/local/` — рекомендация, а не обязанность. Шаблоны по умолчанию лежат в `/bitrix/templates/<ID>/`, свои компоненты — в `/bitrix/components/<vendor>/`, обработчики — в `/bitrix/php_interface/init.php`, партнёрские модули — в `/bitrix/modules/<vendor>.<name>/`. Заглушка исключает `/bitrix/` целиком (`bitrix.ts:18,44`), поэтому типичный сайт придёт в репозиторий без своего кода.
5. **Корень сайта Битрикса — это контент, а не «ядро».** Страницы — файлы `index.php` в папках, меню — `.top.menu.php`, свойства разделов — `.section.php`, права — `.access.php`, адреса — `urlrewrite.php`. У WordPress корень из рабочего набора убран (`wordpress-working-set.ts:29`), здесь такое решение отрезало бы половину задач клиента.
6. **Белый список таблиц в нынешней форме не работает.** Значимая часть таблиц создаётся динамически (`b_iblock_element_prop_s<ID>`, `b_uts_*`, таблицы HL-блоков с произвольными именами), а инфоблоки — универсальное хранилище, куда часто пишут заявки и отзывы: разрешённая таблица сама по себе не гарантирует отсутствие персональных данных (раздел 6).
7. **Рабочее окружение можно взять у вендора, ядро — нет.** `env-docker` (GPL-3.0, «поддерживается и развивается командой внутри компании») даёт образы PHP 8.2–8.5, Percona и nginx, но дистрибутива в них нет: его ставят руками через `bitrixsetup.php` или `restore.php`. Вендор сам ядро в образы не кладёт.

## 1. Версии, требования, окружение

### 1.1. Линии продукта

| Рубеж | Что меняется | Источник |
| --- | --- | --- |
| main 26.1000.0 от 22.09.2026 | Самая свежая версия главного модуля на дату проверки | https://dev.1c-bitrix.ru/docs/versions.php |
| 26.150.0 от 2026-02-19 | Версия, которую сейчас отдают дистрибутивы (`main/classes/general/version.php`) | дистрибутив |
| 24.100.0 | Конфигурация может лежать в `/local/` (`.settings.php`, `.settings_extra.php`, `php_interface/dbconn.php`) | `framework-docs/pages/framework/settings.md` |
| 24.0.0 | Продукты только в UTF-8; «Поддержка кодировки windows-1251 полностью прекращена» | https://dev.1c-bitrix.ru/learning/course/index.php?COURSE_ID=135&LESSON_ID=2593 (изм. 21.10.2026) |
| 23.200.0 | Появился мастер «Конвертация в utf8»; без конвертации main ≥ 24.0.0 не ставится | `framework-docs/pages/advanced/encoding.md:203-205` |
| 20.100.0 | `mbstring.func_overload` больше не нужен, его надо удалить; до этой версии нужен `=2` | тот же урок LESSON_ID=2593 |
| 16.5.7 | Маркер «Установка для разработки» | https://dev.1c-bitrix.ru/learning/course/index.php?COURSE_ID=135&LESSON_ID=8471 (изм. 06.06.2025) |

Официальной таблицы «ветка — конец поддержки» не нашлось (не проверено). Обновления получает только действующая лицензия: при ограниченной лицензии недоступны «Обновление продукта» и установка модулей Маркетплейса (https://www.1c-bitrix.ru/legal/limited_license.php, EULA п. 6.2). Отсюда следует вывод, а не измерение: у сайта с истёкшим ключом версия застывает, поэтому в реальности живут и cp1251, и PHP 7.x.

**Доля в России.** iTrack, январь 2024, 5 465 652 домена .RU: WordPress 42,87%, Tilda 18,51%, 1С-Битрикс 11,79%, Joomla 7,13%, MODX Revolution 1,85%, OpenCart 1,76% (https://itrack.ru/research/cmsrate/). **Доля версий и кодировок: данных нет, не проверено.** Заголовок `X-Powered-CMS: Bitrix Site Manager (<хеш>)` версию не называет.

### 1.2. Требования актуальной ветки

| Что | Значение | Источник |
| --- | --- | --- |
| PHP | 8.2.0 с 01.02.2026, рекомендуется 8.4+ | LESSON_ID=2593 |
| PHP в коде дистрибутива | 8.1.0, константа `MIN_PHP_VER` — расходится с документацией | `main/classes/general/site_checker.php` |
| PHP для `restore.php` | ≥ 7.4 | `scripts-dl/restore.php:20` |
| MySQL | 8.0+, `utf8mb4` (не `utf8mb3`), `utf8mb4_0900_ai_ci` для MySQL 8.x и 9.x | LESSON_ID=2593 |
| MariaDB | 10.x и 11.x, `utf8mb4_unicode_ci`; для РЕД ОС, ALT, Astra рекомендована вместо MySQL | LESSON_ID=2593 |
| Percona | VMBitrix 9.0.x — 8.0, опция 8.4; env-docker — 8.0.46, 8.4.11, 9.7.2 | https://www.1c-bitrix.ru/download/vmbitrix.php, env-docker README:3096 |
| MySQL 9.7 | Удалены `md5()`, `sha1()`; нужен `INSTALL COMPONENT 'file://component_classic_hashing'` | env-docker README:3117 |
| PostgreSQL | Только лицензия «Энтерпрайз для Постгрес» | LESSON_ID=2593, requirements.php |
| Веб-сервер | Apache 2.0+, nginx последней стабильной | LESSON_ID=2593 |
| Установка | Только в корень веб-сервера: `index.php` дистрибутива сверяет свой адрес и иначе отказывает | `index.php` дистрибутива |

**Расширения PHP.** Проверяются функциями: `fsockopen`, `xml_parser_create`, `imagettftext` (FreeType), `gzcompress`, `imagecreatetruecolor`, `imagecreatefromjpeg`, `hash`, `highlight_file`, `openssl_encrypt`, `mb_substr`, транспорт `ssl` (`main/classes/general/site_checker.php`). Официальный образ добавляет `mysqli pdo_mysql bz2 pgsql pdo_pgsql zip gd opcache ldap exif intl calendar sodium gettext pspell xml xmlwriter xsl shmop sysvmsg sysvsem sysvshm sockets memcache memcached` плюс `redis apcu igbinary msgpack imagick amqp ssh2` (`env-docker/sources/bxphp8235/Dockerfile`).

**php.ini**, значения вендора (LESSON_ID=2593, `env-docker/confs/php82/etc/php/conf.d/bitrixenv.ini`):

| Параметр | Значение | Зачем Радити это знать |
| --- | --- | --- |
| `short_open_tag` | `On` | Обязателен: ядро и публичные файлы начинаются с `<?`; без него `index.php` и `restore.php` отказывают |
| `memory_limit` | `256M` (образ — `512M`) | Значение по умолчанию PHP (128M) мало |
| `max_input_vars` | `10000` | Значение по умолчанию (1000) ломает большие формы админки |
| `pcre.backtrack_limit`, `pcre.recursion_limit` | `1000000`, `14000` | |
| `default_charset` | `UTF-8` | Для cp1251 — `windows-1251` |
| `mbstring.func_overload` | `0`; `2` только до main 20.100.0 | Директива удалена в PHP 8.0 (https://www.php.net/manual/en/migration80.incompatible.php), поэтому старому сайту нужен PHP ≤ 7.4 |
| `session.auto_start`, `zend.multibyte` | `0` | `site_checker.php:565,571` |
| `opcache.revalidate_freq` | `0` | `site_checker.php:598`; совпадает с `preview-apache.conf` |
| `upload_max_filesize`, `post_max_size` | `1024M` | |
| `max_execution_time`, `max_file_uploads` | `300`, `100` | |
| `realpath_cache_size` | `4096k` | |
| `session.name` | `BITRIX_PHPSESSID` | Только в образе вендора |

**MySQL должен работать мягко:** `innodb_strict_mode = OFF`, `sql_mode` пустой, `innodb_large_prefix` не выключен (`site_checker.php:2404-2421`). База предпросмотра Радити — MariaDB 11.8.9 (`infra/preview/Dockerfile`). Настройки соединения сайт может ставить в `after_connect_d7.php`; содержимое этого файла пишет мастер установки, он обфусцирован, поэтому точный текст не проверен.

### 1.3. Перезапись адресов

`.htaccess` дистрибутива, пересказ:

- страница 404 — `/404.php`;
- запрос, для которого нет файла, ссылки или папки, уходит в `/bitrix/urlrewrite.php`;
- заголовок `Authorization` передаётся в переменную `REMOTE_USER`;
- индексные файлы — `index.php` и `index.html`.







Цепочка: нет файла → `/bitrix/urlrewrite.php` → `main/include/urlrewrite.php` → `/urlrewrite.php` в корне (`$arUrlRewrite` с `CONDITION`, `RULE`, `ID`, `PATH`) → `/404.php`. Вариант с роутингом — `/bitrix/routing_index.php` (`framework-docs/pages/framework/request-lifecycle.md`). Закрытые каталоги: `/bitrix/.access.php` запрещает `admin` и `wizards` всем, `/upload/.htaccess` запрещает выполнение PHP, есть `bitrix/modules/.htaccess` и `bitrix/updates/.htaccess`.

`preview-apache.conf` читает `.htaccess` выключенным и держит правила WordPress внутри себя, поэтому у Битрикса будет свой конфиг Apache с правилами выше.

## 2. Распознавание

### 2.1. Метки корня

| Что | Есть всегда? | Вывод для `rootMarkers()` |
| --- | --- | --- |
| Папка `bitrix` | Да | Есть и во вложенных: `local/components/bitrix`, `bitrix/components/bitrix`, `bitrix/templates/*/components/bitrix`, `bitrix/modules/*/install/{components,gadgets,blocks,activities,wizards}/bitrix`. Это и есть `TODO(stage 3)` в `bitrix.ts:54` |
| `.access.php` | Да: мастер проверяет его наличие, без него всем «Запрещено» (LESSON_ID=3293) | Во всех перечисленных вложенных папках его нет |
| `upload` | Нет: имя меняется опцией `main.upload_dir` | Не годится |
| `index.php` | Почти всегда | Слабая метка |
| `urlrewrite.php` | Только после первых правил | Не годится |

**Предложение:** `['bitrix', '.access.php']`. `isNestedSiteRoot` сверяет имена записей каталога, поэтому важно, что список FTP показывает точечные файлы: `packages/site-connections/src/sources/ftp.ts:310` просит `MLSD`, затем `LIST -a`. На сервере, который и на `LIST -a` прячет такие файлы, проверка корня откажет ошибочно (не проверено на хостингах).

### 2.2. Что прочитать файлами, без выполнения

| Вопрос | Файл | Синтаксис |
| --- | --- | --- |
| Версия продукта | `bitrix/modules/main/classes/general/version.php` | Константы `SM_VERSION` и `SM_VERSION_DATE`: номер и дата строкой |
| Версия модуля | `bitrix/modules/<id>/install/version.php` | Массив `$arModuleVersion`, ключи `VERSION` и `VERSION_DATE` |
| Кодировка | `bitrix/.settings.php`, `bitrix/php_interface/dbconn.php` | Ключ `utf_mode`; константа `BX_UTF` — с main ≥ 24 её задаёт само ядро (`main/include/constants.php`), поэтому в файле её может не быть |
| Редакция | Набор папок `bitrix/modules/*` | Стандарт — 26 модулей, Бизнес — 49. Только у Бизнеса из пары: `abtest advertising bitrix.eshop bizproc bizprocdesigner calendar catalog conversion currency idea learning lists mail pull report sale sender statistic storeassist support webservice wiki workflow`. Какие из них входят в «Малый бизнес», не проверено |
| Не установлен | `install.config` в корне и `index.php` с константой `install_edition` | Дистрибутив распакован, мастер не пройден. Эти файлы проверяет и cron вендора (`env-docker/sources/bxphp8235/bitrix.sh`) |

**Снаружи, без доступа к файлам** (для варианта мастера «Без доступа к файлам»): заголовок `X-Powered-CMS: Bitrix Site Manager (<хеш>)` (виден на самом 1c-bitrix.ru; в открытом коде его нет, можно ли его отключить, не проверено), cookie `BITRIX_SM_*` (префикс меняется опцией `main.cookie_name`), пути `/bitrix/js/`, `/bitrix/cache/`, `/bitrix/templates/` в HTML, форма `form_auth` на `/bitrix/admin/`.

### 2.3. Похожие системы

| Что | Как отличить |
| --- | --- |
| «Битрикс24» в коробке | `bitrix/modules/intranet`, `bitrix/modules/crm`, `bitrix/modules/tasks`. Отдельный продукт с отдельным EULA (`EULA_Б24.pdf`); адаптеру стоит отказать |
| Отраслевые решения Маркетплейса (Аспро и др.) | Не форки, а модули и мастера внутри `/bitrix/modules/<vendor>.<name>/`; у установленного сайта шаблон и компоненты лежат в `/bitrix/`. Форков ядра в открытых источниках не нашлось (не проверено) |
| Многосайтовость на разных доменах | Ядро установлено один раз, у остальных сайтов `bitrix`, `upload` (и `local`) — символические ссылки (`framework-docs/pages/advanced/multisite.md`). `tree-walk.ts:197,240` ссылки не проходит, поэтому подключать надо папку, где ядро лежит настоящей папкой |

## 3. Дерево

Замеры по дистрибутиву от 02.04.2026:

| | Стандарт | Бизнес |
| --- | --- | --- |
| До установки, МБ | 651 | 898 |
| Файлов | 40 191 | 63 676 |
| Папок | 15 096 | 25 194 |
| Самый большой файл | | 9,8 МБ |

Из «Бизнеса» при установке копируются из `bitrix/modules/*/install/<d>` в `bitrix/<d>` (`main/install/index.php` и такие же `InstallFiles` модулей): `js` 368 МБ и 16 067 файлов, `components` 201 МБ и 19 832, `images` 66,5 МБ, `wizards` 31,9 МБ, `blocks` 23,2 МБ, `templates` 11,3 МБ, прочее ≈ 25 МБ; всего ≈ 727 МБ, ≈ 45 000 файлов, ≈ 19 800 папок. **Оценка установленного ядра «Бизнес»: ≈ 1,6 ГБ, ≈ 108 000 файлов, ≈ 45 000 папок без `/upload/`, кеша и бэкапов.** Оценка, не замер: установка не запускалась, и ставятся не все модули. Размеры реальных сайтов не проверены.

| Путь | Что это | В репозиторий | Агенту | Заново скачать |
| --- | --- | --- | --- | --- |
| `/bitrix/modules/` кроме партнёрских | Ядро (EULA п. 1.11) | Нет | Нет | Только из дистрибутива той же версии плюс обновления по ключу |
| `/bitrix/modules/<vendor>.<name>/` | Партнёрские модули, часто платные; часть файлов обфусцирована | Вопрос к лицензиям авторов | Нет | Нет |
| `/bitrix/{admin,js,css,fonts,images,panel,sounds,themes,tools,services,gadgets/bitrix,components/bitrix,activities/bitrix,blocks/bitrix,wizards/bitrix,routes}` | Копии из модулей; менять запрещено (`how-customize.md`) | Нет | Нет | Да, из модулей |
| `/bitrix/templates/<ID>/`, `/bitrix/templates/.default/` | **Код клиента**: шаблоны сайта и компонентов | Да | Да | Нет |
| `/bitrix/components/<vendor>/` | **Код клиента** | Да | Да | Нет |
| `/bitrix/php_interface/init.php`, `<SITE_ID>/init.php`, `include/`, `user_lang/` | **Код клиента** | Да | С осторожностью | Нет |
| `/bitrix/php_interface/dbconn.php`, `after_connect*.php`, `dbconn_error.php`, `dbquery_error.php` | Настройки подключения | `dbconn.php` — нет | Нет | Нет |
| `/local/**` | **Код клиента**, рекомендованное место | Да, кроме `.settings*.php` и `php_interface/dbconn.php` | Да | Нет |
| `/bitrix/.settings.php`, `.settings_extra.php`, `license_key.php` | Секреты | Нет | Нет | Нет |
| `/bitrix/cache/`, `managed_cache/`, `stack_cache/`, `html_pages/` | Кеш | Нет | Нет | Само |
| `/bitrix/backup/`, в том числе `clouds/`, `sites/` | **Полные бэкапы с дампом базы внутри дерева** | Нет | Нет | Нет |
| `/bitrix/tmp/`, `/bitrix/updates/`, `/upload/tmp/` | Временное | Нет | Нет | |
| `/bitrix/modules/error.log`, `updater*.log`, `/bitrix/site_checker_<md5>.log`, `/mysql_debug.sql` | Логи; последний — в корне сайта, с текстами запросов | Нет | Нет | |
| `/index.php`, `/<раздел>/index.php`, `/404.php`, `/urlrewrite.php`, `/robots.txt`, `/sitemap*.xml`, `.section.php`, `.top.menu.php`, `.left.menu.php`, `.access.php`, `/include/*`, `sect_*.php` | **Страницы и контент, лежат файлами** | Да | Да | Нет |
| `/upload/iblock/`, `/upload/medialibrary/` (документация называет `/upload/media/`), `/upload/uf/`, `/upload/fileman/`, `/upload/catalog/` | Медиа контента | По решению как у WP | Только добавлять | Нет |
| `/upload/resize_cache/` | Кеш миниатюр | Нет | Нет | Само |
| `/upload/main/`, `/upload/form/`, `/upload/forum/`, `/upload/blog/`, `/upload/support/`, `/upload/sale/`, `/upload/subscribe/`, `/upload/socialservices/`, `/upload/bizproc_wf/`, `/upload/calendar/`, `/upload/1c_*` | **Файлы посетителей и покупателей, выгрузки 1С** | Нет | Нет | Нет |

Каталоги `/upload/` выведены из вызовов `CFile::SaveFile` по коду дистрибутива; `/upload/1c_*` закрыт от веба и в конфиге nginx вендора (`env-docker/confs/nginx/inc/block.conf:62`). Поле «Папка по умолчанию» (`main.upload_dir`) меняет корень `/upload/`.

**Бэкапы в дереве.** Имя — `<дата>_<время>_full_<случайное>.tar`, со сжатием `.tar.gz`, с шифрованием `.enc.gz`, большие режутся на части с числовым суффиксом (`.tar.1`, `.tar.gz.2`, `.enc.3`), рядом `*.sql` и `*_after_connect.sql` (`main/classes/general/backup.php`, `main/tools/backup.php`, `restore.php:734,1823`). `archivesAndDumps` в `php-hosting.ts` части с числовым суффиксом и `.enc.gz` не ловит: `/bitrix/backup/` обязан оставаться в исключениях, а копии, перенесённые в корень, найдёт только сканер. Ключ шифрования бэкапа по умолчанию — лицензионный ключ сайта (`backup.php:786-792`).

## 4. Конфигурация

### 4.1. Файлы и порядок чтения

| Файл | Что | Правило |
| --- | --- | --- |
| `/bitrix/.settings.php`, `/local/.settings.php` | Настройки ядра D7, подключение к БД | `Loader::getLocal` (`main/lib/loader.php`): если есть файл в `/local/`, он **заменяет** файл из `/bitrix/` целиком, с main 24.100.0 |
| `/bitrix/.settings_extra.php`, `/local/.settings_extra.php` | Перекрытие | Заменяет **ключ верхнего уровня целиком** (`main/lib/config/configuration.php`) |
| `/bitrix/php_interface/dbconn.php`, `/local/php_interface/dbconn.php` | Константы старого ядра | Обязателен: его подключает `main/start.php`. Его `$DBHost`, `$DBLogin`, `$DBPassword`, `$DBName` ядро обнуляет сразу после подключения (`main/start.php`). Значит, с актуальными версиями подключение идёт только из `.settings.php`. `main/lib/config/migrator.php` показывает, откуда они брались на старых |
| `/bitrix/php_interface/after_connect_d7.php` | Команды после соединения | `/local/` важнее |
| `/bitrix/license_key.php` | Лицензионный ключ | Переменная `$LICENSE_KEY` (`main/options.php`) |
| `/bitrix/php_interface/init.php`, `/local/php_interface/init.php` | Код сайта | Файл в `/local/` **отключает** файл в `/bitrix/` (`directory-structure.md`) |
| `.settings.php` модуля | `modules/<id>/.settings.php` | Сервисы и команды модуля |

Формат `.settings.php` — PHP-файл, возвращающий массив; значение раздела лежит в обёртке с ключами `value` и `readonly`. Пересказ:

- раздел `utf_mode`: признак UTF-8;
- раздел `connections`, соединение `default`: `className` (класс соединения с MySQL из пространства `Bitrix\Main\DB`), `host`, `database`, `login`, `password`, `options`;
- `readonly` закрывает раздел от записи из админки.














Необязательный ключ `charset` соединения читается в `main/lib/db/mysqliconnection.php`. Префикса таблиц нет: ядро зашито на `b_`.

### 4.2. Все секреты в файлах

| Файл | Ключ | Статус в `bitrix.ts` |
| --- | --- | --- |
| `.settings.php` | `connections.value.*.password`, в том числе дополнительных соединений | Читается по ключу `password` |
| `.settings.php` | `crypto.value.crypto_key` — шифрует `CryptoField`, куки, входит в ключ `Signer` (`main/lib/security/sign/signer.php`, `main/lib/web/cookiescrypter.php`) | **Не читается** |
| `.settings.php` | `smtp` — логин и пароль почты (`env-docker` README:883) | `password` читается |
| `.settings.php` | `pull.value.signature_key` (README:735) | **Не читается** |
| `.settings.php` | `cache` и `session`: хосты, порты, пароли Redis и Memcached | `password` читается |
| `.settings.php`, `.settings_extra.php`, `/local/*` | То же в перекрывающих файлах | **`.settings_extra.php` и файлы `/local/` не читаются** (`bitrix.ts:108-123`, тест `bitrix.test.ts:151,157` закрепляет отказ) |
| `dbconn.php` | `$DBPassword` | Читается только из `bitrix/php_interface/`, **`local/php_interface/dbconn.php` не читается** |
| `license_key.php` | `$LICENSE_KEY` — ключ лицензии, он же ключ бэкапа | **Не читается и не исключён** отдельным правилом (сейчас уходит вместе с `/bitrix/`) |
| Партнёрские модули | Свои файлы настроек | Не перечислимо |

Разбор без выполнения PHP уже есть: `phpStringsAfter` и `phpConfigStrings` (`packages/site-adapters/src/php-config.ts`). Нужны ещё две записи: `crypto_key` и `signature_key`, плюс `$LICENSE_KEY\s*=`. Ограничение читателя: значение не в UTF-8 даёт `null` (`php-config.ts`, `fromByteString`), поэтому пароль с байтами cp1251 на старом сайте не прочитается, а `configSecrets` молча вернёт меньше секретов.

### 4.3. Запуск с другой конфигурацией

| Что заменить | Как | Подводный камень |
| --- | --- | --- |
| Подключение к БД | Сгенерировать `bitrix/.settings.php` целиком, как `wp-config.php` у WordPress, значения читать из `PREVIEW_SETTINGS_PATH` | Сайт с `/local/.settings.php` этот файл проигнорирует: генерировать и его либо доказать его отсутствие |
| Точечное перекрытие | `.settings_extra.php` | Ключ верхнего уровня заменяется целиком: `connections` затрёт дополнительные соединения. Работает только у файла, который ядро действительно находит |
| Константы и функции | PHP `auto_prepend_file` через `php_admin_value` в конфиге Apache предпросмотра, файл рядом с настройками, вне дерева | **Лучшая замена mu-plugin**: не конфликтует с `init.php` клиента (`init.php` в `/local/` отключил бы файл клиента в `/bitrix/`). константы раньше сайта: `NO_AGENT_CHECK`, `DisableEventsCheck`, `BX_CRONTAB_SUPPORT`, функция `custom_mail`, которая глотает всю почту (`main/tools.php`) |
| `dbconn.php` | Подложить свой | Файл обязателен (`start.php:38`). Константы клиента из него пропадут (`BX_CACHE_SID`, `BX_FILE_PERMISSIONS`, `CACHED_*`, `BX_TEMPORARY_FILES_DIRECTORY`) |
| Переменные окружения | Ядро само `getenv` для подключения не читает; `.settings.php` — обычный PHP, и в нём можно написать `getenv` | В `main/lib/config`, `application.php` и `start.php` вызовов `getenv` нет. Из окружения читается только `BX_PERSONAL_ROOT`, через `$_SERVER` (`main/bx_root.php`) |
| Лицензия копии | Копия без `license_key.php` | Поведение скрыто в `main/lib/license.php`. Не проверено |

### 4.4. Привязка к адресу

| Где | Что | Для копии |
| --- | --- | --- |
| Заголовок `Host` | Сайт выбирается по домену из настроек, затем по папке; порт не учитывается; **если домен не подошёл, открывается сайт по умолчанию** (`advanced/multisite.md`) | Хорошая новость: чужой адрес сам по себе не ломает одиночный сайт |
| `b_lang.SERVER_NAME`, `b_lang_domain` | URL сервера, домены | Заменить; у многосайтовой установки с `DOMAIN_LIMITED='Y'` откроется только сайт `DEF='Y'` |
| `b_lang.DOC_ROOT` | Абсолютный путь на диске | **Очистить**, иначе «виден только экран авторизации» (LESSON_ID=3293) |
| `b_option`: `main.server_name` | Адрес для писем, карты сайта, ссылок | Заменить |
| `b_option`: `main.cookie_name`, `main.ALLOW_SPREAD_COOKIE`, домены кук | | `ALLOW_SPREAD_COOKIE` выключить: `/bitrix/spread.php` переносит куки на домены сайтов |
| `https` | `isHttps`: порт 443, серверная переменная `HTTPS`, либо ключ `https_request` в настройках (`main/lib/httprequest.php`). **`X-Forwarded-Proto` ядро не смотрит** | За шлюзом предпросмотра задать `SetEnv HTTPS on` либо ключ `https_request` со значением `true` |
| Редиректы | На домен, на `https`, на `www`: в удалённом `.htaccess`, в `init.php`, в шаблоне, в `urlrewrite.php`, в модуле `security` (`b_sec_redirect_url`) | Код клиента может увести с предпросмотра на прод. Нужен перехват вывода и заголовка `Location`, как `ob_start('raditi_preview_output')` в `infra/wordpress/raditi-preview.php:207`; из `auto_prepend_file` |
| Абсолютные ссылки | `DETAIL_TEXT`, включаемые области, шаблоны, `CANONICAL_PAGE_URL` | Заменять в потоке вывода |
| Кеш | `/bitrix/cache` и `html_pages/<domain>/` не копируются; композит выключить | |

Подпапка не поддерживается мастером: ставить можно только в корень. Адрес предпросмотра `site-<алиас>-chat-<алиас>.<домен>` это учитывает.

## 5. Где живёт то, что клиент хочет менять

| Что клиент просит | Где лежит | Менять кодом? | Выгрузить в файлы? |
| --- | --- | --- | --- |
| Текст обычной страницы, раздел «О компании» | **Файл** `/<раздел>/index.php`: HTML между `header.php` и `footer.php`, заголовок задаёт вызов `SetTitle` в самом файле | Да, это файл. Правка попадает в git и в выпуск | Уже файл |
| SEO страницы | вызов `SetPageProperty` в файле, переменные `$sSectionName` и `$arDirProperties` в `.section.php` | Да | Уже файл |
| Меню | `.top.menu.php`, `.left.menu.php` (`$aMenuLinks`); у каталога ещё `.top.menu_ext.php` с компонентом | Да | Уже файл |
| Телефон в шапке, баннер, подвал | Включаемые области: файлы `/include/*.php`, `sect_*.php`, компонент `bitrix:main.include` | Да | Уже файл |
| Шапка, вёрстка | `/bitrix/templates/<ID>/header.php`, `footer.php`, `template_styles.css` или `/local/templates/` | Да | Уже файл |
| Какой шаблон на какой адрес | `b_site_template` (условия и сортировка) | Только БД | Нет |
| Параметры компонента на странице | Массив в вызове `IncludeComponent` прямо в файле страницы | Да | Уже файл |
| Вид компонента | `<шаблон>/components/bitrix/<компонент>/<вариант>/template.php`, `result_modifier.php` | Да | Уже файл |
| Новость, статья, товар, услуга | **База**: `b_iblock_element` (`NAME`, `CODE`, `PREVIEW_TEXT`, `DETAIL_TEXT`, `*_TEXT_TYPE`, `ACTIVE`, `ACTIVE_FROM`, `ACTIVE_TO`, `SORT`, `IBLOCK_SECTION_ID`), свойства — `b_iblock_element_property` либо `b_iblock_element_prop_s<ID>`, `_m<ID>` | Только API | Нет |
| Раздел каталога | `b_iblock_section`, поля — `b_uts_iblock_<ID>_section` | Только API | Нет |
| Цена, остаток | `b_catalog_price`, `b_catalog_product`, `b_catalog_store_product` | Только API; часто перезаписывается обменом с 1С | Нет |
| Посадочные на «Сайты24» | `b_landing`, `b_landing_block` | Только API | Нет |
| Справочники, HL-блоки | Отдельные таблицы, имя в `b_hlblock_entity.TABLE_NAME` | Только API | Нет |
| Почтовые шаблоны | `b_event_message` | Только API | Нет |
| Настройки модулей | `b_option`, `b_option_site` | Только API | Нет |
| Картинки контента | `/upload/iblock/<xxx>/<имя>` + строка `b_file` (`SUBDIR`, `FILE_NAME`) | Файл без строки `b_file` не виден | Нет |

Вывод для рабочего набора: корневые файлы публичной части **должны** входить в него, в отличие от WordPress. Исключить из него надо `/bitrix/` кроме пунктов раздела 3, `/upload/`, `/bitrix/php_interface/dbconn.php` и конфигурацию. Платформенный путь для контента инфоблоков — операция плана БД через свой файл PHP, а не правка файлов.

## 6. База

### 6.1. Что нужно, чтобы сайт запустился

Минимальный набор выведен из схемы и порядка запуска, **не проверен запуском**: `b_lang`, `b_lang_domain`, `b_language`, `b_culture`, `b_site_template`, `b_module`, `b_module_to_module`, `b_module_group`, `b_option`, `b_option_site`, `b_group`, `b_task`, `b_operation`, `b_task_operation`, `b_group_task`, `b_group_subordinate`, `b_user_field`, `b_user_field_lang`, `b_user_field_enum`, `b_file`, `b_event_type`.

`b_module_to_module` обязателен: там лежат обработчики событий модулей, поэтому партнёрское поведение сайта держится на базе. Без `b_module` модули считаются неустановленными.

Лицензионные строки `b_option` ядро прячет даже от обычного списка настроек: `crc_code`, `admin_passwordh`, `server_uniq_id`, `PARAM_MAX_SITES`, `PARAM_MAX_USERS`, все `~…` (`main/lib/config/option.php`), а в сбросе настроек сохраняет `admin_passwordh`, `PARAM_MAX_SITES`, `PARAM_MAX_USERS`, `crc_code`, `vendor` (`main/options.php`). **Что будет с копией без этих строк, не проверено; копировать их или нет, решается опытом.**

### 6.2. Классы таблиц

| Класс | Таблицы | В копии |
| --- | --- | --- |
| Контент | `b_iblock*`, `b_iblock_element_prop_*`, `b_catalog_*` кроме пользовательских, `b_catalog_currency*`, `b_medialib_*`, `b_landing*`, `b_hlblock_*`, `b_uts_*`, `b_utm_*`, `b_seo_sitemap*`, `b_form`, `b_form_field`, `b_form_answer` | Да, с оговоркой 6.3 |
| Индексы, можно перестроить | `b_search_*`, `b_iblock_<ID>_index`, `b_iblock_<ID>_index_val`, `b_sale_d_ix_*` | Структура; поиск и фасетный фильтр в копии будут пустыми |
| Кеш и служебное | `b_cache_tag`, `b_composite_*`, `b_agent`, `b_undo`, `b_perf_*`, `b_iblock_cache` | Структура |
| Персональные | `b_user` (ФИО, телефоны, адреса, `PERSONAL_*`, `WORK_*`, `ADMIN_NOTES`), `b_user_index`, `b_user_phone_auth`, `b_user_profile_history`, `b_user_profile_record`, `b_user_device*`, `b_user_session`, `b_consent_user_consent*`, `b_sale_order`, `b_sale_order_props_value`, `b_sale_basket`, `b_sale_fuser`, `b_sale_user_props*`, `b_sale_user_account`, `b_sale_user_transact`, `b_sale_user_cards`, `b_sale_order_payment`, `b_sale_order_delivery`, `b_catalog_subscribe`, `b_catalog_viewed_product`, `b_catalog_contractor`, `b_form_result`, `b_form_result_answer`, `b_subscription`, `b_posting*`, `b_sender_contact`, `b_sender_posting*`, `b_mail_*`, `b_forum_*`, `b_blog_*`, `b_ticket*`, `b_vote_event*`, `b_stat_*`, `b_conv_*`, `b_event`, `b_event_log`, `b_location_address`, `b_bp_*` | Только структура |
| Секреты | `b_sale_bizval.PROVIDER_VALUE` (ключи платёжных систем), `b_sale_pay_system_action`, `b_sale_cashbox`, `OFD_SETTINGS`, `b_sale_delivery_srv`, `b_rest_app` (`CLIENT_SECRET`, `APPLICATION_TOKEN`), `b_rest_ap.PASSWORD` (входящие вебхуки), `b_clouds_file_bucket.SETTINGS`, `b_mail_mailbox.PASSWORD`, `b_mail_oauth`, `b_main_mail_sender`, `b_app_password`, `b_user_stored_auth`, `b_user_password`, `b_user_auth_code`, `b_sec_user.SECRET`, `b_sec_recovery_codes`, `b_socialservices_user` (`OATOKEN`, `OASECRET`, `REFRESH_TOKEN`), `b_bitrixcloud_option`, `b_seo_service_*`, `b_messageservice_*` | Только структура |

Секретные строки `b_option` (найдены по коду): `main.signer_default_key` (пересоздаётся сам, `signer.php:252-256`), `main.~rsa_key_pem`, `main.~rsa_keys_openssl`, `main.server_uniq_id` (основа `sessid`, `main/tools.php`), `main.update_site_proxy_pass`, `main.controller_member_secret_id`, `main.controller_proxy_password`, `main.translate_key_yandex`, `fileman.yandex_map_api_key`, `fileman.google_map_api_key`, `location.google_map_api_key`, `location.google_map_api_key_backend`, `socialservices.*_appsecret`, `rest.service_client_secret`, `messageservice.smsru_secret_key`, `sale.config_external_oauth_key`, `sale.config_external_access_token`, `sale.config_external_refresh_token`, `pull.signature_key`. Список получен поиском по шаблону имени и неполон: партнёрские модули пишут в `b_option` свои ключи, поэтому там нужен белый список, а не чёрный.

### 6.3. Что ломает модель белого списка

1. **Динамические таблицы.** Инфоблоки 2.0 (`VERSION=2`): `b_iblock_element_prop_s<ID>`, `b_iblock_element_prop_m<ID>` (`iblock/classes/general/iblock.php:11-12`). Пользовательские поля: `b_uts_<ENTITY>`, `b_utm_<ENTITY>` (`main/classes/general/usertype.php`). Фасетный индекс: `b_iblock_<ID>_index`, `_index_val`. HL-блоки: произвольное `TABLE_NAME`. `databaseCopyPolicySchema` принимает только точные имена (`identifier`), до 64 правил, и `databaseCopyPolicy(site, preview)` не видит базу (`packages/domain/src/preview/recipe.ts:235`). Нужны шаблоны имён, больший предел и список таблиц, снятый с самой базы.
2. **Инфоблок — универсальное хранилище.** Заявки, отзывы и анкеты часто лежат в инфоблоках (компонент `bitrix:iblock.element.add.form`, HL-блоки). Разрешив `b_iblock_element`, можно унести персональные данные. Правило 1 требует фильтра по `IBLOCK_ID`: разрешать инфоблоки, у которых есть публичный вывод, или спрашивать владельца. Какое правило надёжно, не проверено.
3. **`b_file` общий.** В нём и картинки контента, и файлы форм, и аватары: фильтровать по `MODULE_ID` и по ссылкам из разрешённых таблиц.
4. **Сериализация.** `b_option.VALUE` и многие поля хранят PHP-`serialize`; подмена адреса должна его сохранять. Обработка `scrub_secrets` здесь пригодна.
5. **Строки в cp1251.** Дамп старого сайта надо читать и писать в его кодировке; копия сервера с `character_set_server` другой кодировки даёт `ERROR 1062` (LESSON_ID=3293).
6. **Сортировка.** MySQL 8 на Битриксе — `utf8mb4_0900_ai_ci`, а база предпросмотра Радити — MariaDB 11.8.9. Псевдоним этих сортировок описан в задаче MDEV-35256, но вышел ли он в 11.8, поиск не подтвердил (https://jira.mariadb.org/browse/MDEV-35256). Не проверено.
7. **`DatabaseCopier` и `tablePrefix`.** `siteDatabaseSettingsSchema` требует префикс, у Битрикса его нет: значение `''` при таблицах `b_*`, правила пишутся с полным именем.

### 6.4. Администратор в копии без браузера

Вывод для адаптера: администратор копии не создаётся без браузера и без кода CMS. Подробности устройства сняты из отчёта 01.11.2026 (замечание SEC-16): п. 3.2 EULA относит алгоритмы к коммерческой тайне.









### 6.5. CLI

`bitrix/bitrix.php` (из `main/install/bitrix/bitrix.php`) требует Symfony Console; в `main/vendor` его нет (`geoip2 maxmind-db nikic php-http phpmailer psr simshaun`), без Composer команда завершается сообщением, что Symfony Console нет (`main/cli/bitrix.php`). Команды только разработческие: `make:*`, `orm:annotate`, `update:*`, `messenger:consume` (`main/lib/cli/command`). Управления контентом и пользователями нет: **аналога WP-CLI нет**. Есть два полезных скрипта: `main/tools/cron_events.php` и `main/tools/backup.php`. Команды `update:*` в копии запускать нельзя.

## 7. Программный доступ

| Способ | Что даёт | Для Радити |
| --- | --- | --- |
| Файл, загружающий ядро | Всё API | Основной путь |
| REST-модуль `rest`, входящие вебхуки `/rest/<user>/<token>/<method>` (`rest/install/index.php:284`, таблица `b_rest_ap`) | Методы модулей; в коробке есть `sale/lib/rest`, `lists/lib/rest`, `main/lib/Rest`, каталог. REST-метода для произвольного элемента инфоблока в «Стандарте» не нашлось (не проверено) | Клиент сам создаёт вебхук, ставить нечего; но токен — постоянный секрет с широкими правами |
| AJAX-контроллеры | `/bitrix/services/main/ajax.php?action=<module>.<controller>.<action>` | Только то, что объявили модули |
| Админка браузером | Всё, что видит пользователь | План 57 |

Загрузка ядра из одного файла, без регистрации в базе; константы взяты из `main/cli/bootstrap.php`, вызовы — из `framework-docs/pages/modules/iblocks/api.md`. **Не запускалось:**

1. Задать константы `NO_KEEP_STATISTIC`, `NOT_CHECK_PERMISSIONS`, `BX_CRONTAB`, `STOP_STATISTICS`, `NO_AGENT_STATISTIC`, `DisableEventsCheck`, `NO_AGENT_CHECK`.
2. Задать `DOCUMENT_ROOT` и подключить `bitrix/modules/main/include/prolog_before.php`.
3. Подключить модуль `iblock` классом `Bitrix\Main\Loader`.
4. Читать элемент методом `GetList` класса `CIBlockElement`, менять — методом `Update` того же класса.















Прямой SQL к инфоблокам вендор запрещает (`how-customize.md`): обновление одной таблицы рассогласует данные (`iblocks/api.md`). Страница-файл меняется через файловую запись, а не через API.

**Модель расширений.**

| Вид | Где | Регистрация |
| --- | --- | --- |
| Модуль | `/local/modules/<vendor>.<name>/` или `/bitrix/modules/…`; `install/index.php` с классом-наследником `CModule`, `install/version.php`, `include.php`, `lib/` | `ModuleManager::registerModule` пишет `b_module`, обработчики — `b_module_to_module`. Установить без браузера можно своим скриптом, вызвав `DoInstall`. Не проверено |
| Компонент | `/local/components/<ns>/<name>/` | Не нужна, подключается по имени |
| `init.php` | `/local/php_interface/init.php` | Загружается на каждом хите. Единственный файл, и он занят клиентом |
| Отдельный файл | Любой `.php` в дереве с `prolog_before.php` | **Не нужна.** Это и есть аналог плагина «Радити» на проде: один файл, например `/local/tools/raditi.php`, с собственной проверкой токена. `/local/tools/` открыт из веба, в отличие от `local/modules` и `local/php_interface`, которые закрывает nginx вендора (`env-docker/confs/nginx/inc/static.conf:4`), поэтому проверка обязательна |
| Аналог mu-plugin | Нет. В предпросмотре — `auto_prepend_file` (раздел 4.3) | Не нужна |

## 8. Админка

### 8.1. Вход

Путь — `/bitrix/admin/`. **Переименовать нельзя:** `BX_ROOT` жёстко задан в `main/bx_root.php`, а `/bitrix/` прошит в коде и в конфигах. Ограничить можно по адресу: «Защита административного раздела» в модуле `security` (`security_iprule_admin.php`, `proactive-security.md:677`). Если клиент её включил, браузер задачи не войдёт, пока он не внесёт выходной адрес платформы.

| Элемент | Селектор | Источник |
| --- | --- | --- |
| Форма | `form[name="form_auth"]`, `method=post`, `target="auth_frame"`, `action=""` | `main/interface/auth/wrapper.php` |
| Признак | `input[name="AUTH_FORM"]` = `Y`, `input[name="TYPE"]` = `AUTH` | `wrapper.php:170`, `authorize.php:18` |
| Логин | `input[name="USER_LOGIN"]` | `authorize.php:26` |
| Пароль | `input[name="USER_PASSWORD"]` | `authorize.php:33` |
| Отправка | `input[type="submit"][name="Login"]`, значения нет, кнопка без текста | `authorize.php:36` |
| Запомнить | `input[name="USER_REMEMBER"]` | `authorize.php:62` |
| CSRF | `input[name="sessid"]`: хеш MD5 от `server_uniq_id` и идентификатора сессии, либо заголовок `X-Bitrix-Csrf-Token` | `main/tools.php` |
| Капча | `captcha_sid`, `captcha_word`, картинка `/bitrix/tools/captcha.php?captcha_sid=…`; появляется по `NeedCAPTHAForLogin` | `authorize.php:49-53` |
| Двухфакторка | Отдельный шаг: `TYPE=OTP`, `input[name="USER_OTP"]`, `OTP_REMEMBER` | `main/interface/auth/otp.php` |

**Две особенности ломают `BrowserSignInForm`.** Форма показывается на **любом** адресе `/bitrix/admin/*` при том же URL, и после входа URL не меняется; `cloud-browser.ts:1306` определяет форму только по пути, поэтому `isSignInPage(path)` здесь бессилен: вход всегда будет считаться отказом. Отправка идёт в скрытый iframe `auth_frame`, а успех — это `BX.reload` из `setAuthResult` (`main/install/js/main/core/core_admin_login.js:222-242`): при ошибке главный кадр не перейдёт вовсе. Порт нужно расширить признаком формы по селектору.

### 8.2. Адреса экранов

Все — от `/bitrix/admin/`, параметр `lang=ru`.

| Экран | Адрес | Агенту |
| --- | --- | --- |
| Список инфоблоков | `iblock_admin.php?type=<type>` | Да |
| Элементы инфоблока | `iblock_list_admin.php?IBLOCK_ID=<n>&type=<type>` (совмещённый) или `iblock_element_admin.php?…` (`iblock.php:4101-4103`) | Да |
| Редактор элемента | `iblock_element_edit.php?IBLOCK_ID=<n>&type=<type>&ID=<id>&WF=Y&find_section_section=<s>`; новый — без `ID` или `ID=0` (`iblock.php:3981-4001`) | Да |
| Разделы | `iblock_section_admin.php`, `iblock_section_edit.php?IBLOCK_ID=<n>&type=<type>&ID=<id>` | Да |
| Товары | `cat_product_list.php`, `cat_product_admin.php`, `cat_product_edit.php?IBLOCK_ID=<n>&type=<type>&ID=<id>`, `cat_section_admin.php` | Да, без цен по решению |
| Страницы | `fileman_admin.php?path=%2F`; визуальный редактор `fileman_html_edit.php?path=%2Fabout%2Findex.php&site=s1` | Да |
| Новая страница | `fileman_html_edit.php?path=%2Fabout&new=y&filename=<имя>` | Да |
| Меню | `fileman_menu_edit.php`, `public_menu_edit.php` | Да |
| Медиабиблиотека | `fileman_medialib_admin.php`, `fileman_file_upload.php` | Осторожно |
| **Исходный код файла** | `fileman_file_edit.php?path=…&full_src=Y`, `public_file_edit_src.php` | **Нет**: это запись PHP на живой сайт |
| Шаблоны сайта | `template_admin.php`, `template_edit.php`, `template_load.php`, `template_copy.php` | **Нет**: код сайта, план 57 Б1 |
| Пользователи | `user_admin.php`, `user_edit.php?ID=<id>`, `group_admin.php`, `task_admin.php`, `user_import.php` | **Нет** (правило 4) |
| Заказы | `sale_order.php`, `sale_order_view.php?ID=<id>`, `sale_order_edit.php?ID=<id>`, `sale_order_detail.php`, `sale_buyers.php`, `sale_basket.php`, `sale_account_admin.php`, `sale_ccards_admin.php` | **Нет** |
| Оплата | `sale_pay_system*.php`, `sale_business_value.php`, `sale_cashbox_list.php` | **Нет** |
| Формы | `form_list.php`, `form_result_list.php`, `form_result_view.php`, `form_result_edit.php` | **Нет**: заявки |
| Рассылки | `subscr_admin.php`, `posting_admin.php`, `sender_contacts.php`, `sender_letters.php` | **Нет** |
| Поддержка | `ticket_list.php`, `ticket_edit.php` | **Нет** |
| Настройки | `settings.php?mid=main`, `site_admin.php`, `site_edit.php?LID=s1`, `lang_admin.php`, `smtp_admin.php`, `message_admin.php`, `urlrewrite_list.php` | **Нет** |
| Модули и обновления | `module_admin.php`, `partner_modules.php`, `update_system.php`, `update_system_partner.php`, `update_system_market.php`, `wizard_install.php`, `wizard_list.php` | **Нет** |
| Бэкап | `dump.php`, `dump_auto.php`, `dump_list.php` | **Нет** |
| **Консоль** | `php_command_line.php`, `sql.php`, `perfmon_table.php`, `perfmon_tables.php`, `perfmon_row_edit.php`, `repair_db.php`, `phpinfo.php` | **Нет**: PHP и SQL прямо из браузера |
| Журналы и защита | `event_log.php`, `agent_list.php`, `security_*.php`, `xscan_*.php`, `clouds_*.php` | **Нет** |

Список закрытых экранов у WordPress — запретительный (`wordpress-browser-task.ts:200`). Здесь только в дистрибутиве «Бизнес» 697 файлов `*/install/admin/*.php`, и партнёрские модули добавляют свои в `/bitrix/admin/`: **нужен белый список** `iblock_*`, `cat_*` (часть), `fileman_*` (часть). Это меняет не только контент: действия идут и через `/bitrix/services/main/ajax.php?action=…`, `/bitrix/tools/*`, поэтому `requestDenied` тоже разрешающий.

### 8.3. Сохранение

Форма редактора — обычный POST на тот же адрес, с `sessid` и скрытым `Update=Y` (`iblock_element_edit.php:2237`).

| Кнопка | Атрибуты | ru | en | Итог |
| --- | --- | --- | --- | --- |
| Сохранить | `input[name="save"]`, класс `adm-btn-save`, `title` «Сохранить и вернуться» | Сохранить | Save | Редирект **в список**, ID потерян (`iblock_element_edit.php:1412-1473`) |
| Применить | `input[name="apply"]`, `title` «Сохранить и остаться в форме» | Применить | Apply | Редирект на редактор с `ID` (`:1534`) |
| Сохранить и добавить | `input[name="save_and_add"]` | Сохранить и добавить | Save and add | Новая форма |
| Отменить | `input[name="cancel"]`, `dontsave` | Отменить | Cancel | |

Тексты — `main/lang/{ru,en}/interface/admin_lib.php`, `iblock/lang/*/admin/iblock_element_edit.php`, код — `main/interface/admin_tabcontrol.php`, у форм в боковом окне это `type="button"`.

**Публикации как действия нет.** Видимость задаёт флажок «Активность» (`ACTIVE`, поле `IBLOCK_FIELD_ACTIVE`), даты `ACTIVE_FROM`, `ACTIVE_TO`, а при модуле `workflow` — статус `WF_STATUS_ID`, причём правка создаёт копию с `WF_PARENT_ELEMENT_ID`. Значит, `browserCommitAction` для Битрикса отвечает только `save`, а опубликовано ли, говорит чтение. У агента должна быть инструкция: новый объект сохранять «Применить», иначе его ID не узнать.

**Перепроверка GET.** REST-способа чтения элемента, как у WordPress, нет. Остаётся страница редактора: `GET iblock_element_edit.php?IBLOCK_ID=<n>&type=<type>&ID=<id>&lang=ru` с разбором `input[name="NAME"]`, `input[name="ACTIVE"]`. Предел `browserVerificationLimits.replyBytes` равен 1 МиБ; уместится ли страница с визуальным редактором, не проверено. Публичный адрес строится по шаблону `b_iblock.DETAIL_PAGE_URL`, по ID его не угадать.

### 8.4. Что опасно отдавать агенту

Кроме таблицы: удаление элемента **безвозвратно**, корзины нет (модуля `recyclebin` нет в дистрибутиве «Бизнес»), поэтому Б37 «перенести в корзину» здесь неприменимо; групповые действия идут POST-ом `action`, `ID[]`, `action_button` прямо на страницу списка (`main/interface/admin_list.php`, `iblock_list_admin.php`), закрывать их надо по телу запроса; проактивный фильтр (`security_filter.php`) может резать HTML в POST: сохранение вернётся успешно, а текст окажется изменён. Журнал вторжений покажет это только администратору.

## 9. Проверка сайта после выпуска

| Что | Значение |
| --- | --- |
| Страницы | `/`, плюс разделы из `urlrewrite.php`. `recordPages` с `{id}` не подходит: адрес записи строится шаблоном инфоблока и `CODE` |
| `failureMarkers` | `Error connecting to database. Please try again later.` (`main/classes/general/database.php`) |
| | `При выполнении скрипта возникла ошибка.` и `The script encountered an error and will be aborted.` (`main/lang/*/lib/diag/httpexceptionhandleroutput.php`) |
| | `A error occurred during execution of this script.` (`main/lib/diag/httpexceptionhandleroutput.php`, без локализации) |
| | `Site under construction.` (`main/include/site_closed.php`; клиент может заменить файлом `php_interface/include/site_closed.php`) |
| | `Срок работы пробной версии продукта истек.` и `Your free 30-day trial period is over.` (`expire_mess2`, вывод через `die` при ответе 200, `main/include/prolog_after.php`) |
| | `Срок действия текущей лицензии закончился.` и `Your license has expired.` (`expire_mess_timelicense2`) |
| | `<b>Fatal error</b>:`, `<b>Parse error</b>:` — как у WordPress |
| Своя страница ошибки | Клиент может положить `/error.php`, она подключается вместо текста (`httpexceptionhandleroutput.php`), ответ 500 останется. Метки её не увидят |
| Логи | `bitrix/modules/error.log`, только если задан `exception_handling.value.log`; `bitrix/modules/updater.log` (`main/classes/general/update_class.php`), `updater_partner.log`; `/mysql_debug.sql` при `$DBDebugToFile` |
| «Проверка системы» | `/bitrix/admin/site_checker.php?lang=ru`, только из браузера под администратором; для выпуска слишком тяжела |

**Кеш.** Здесь это не оптимизация, а часть выпуска.

| Слой | Где | Сброс |
| --- | --- | --- |
| Компоненты | `/bitrix/cache/`, `CACHE_TIME` на странице часто 36 000 000 | `BXClearCache` или `Cache::clearCache` (`main/tools.php`, `main/lib/data/cache.php`) |
| Управляемый | `/bitrix/managed_cache/` | Метод `CleanAll` менеджера `CACHE_MANAGER` (`cache_manager.php:73`), `ClearByTag` |
| Стековый | `/bitrix/stack_cache/` | Метод `CleanAll` менеджера `stackCacheManager` |
| Композит | `/bitrix/html_pages/<domain>/`, `.enabled`, `.config.php` | Класс `Composite\Page`, метод `deleteAll` (`main/lib/composite/page.php`), `main/tools/cron_html_pages.php`; руками папку не удалять (`composite-site.md:788`) |
| OPcache | | `Application::resetAccelerator` (`main/lib/application.php`) |

Правка шаблона компонента не сбрасывает его кеш: без явного сброса выпуск пройдёт, файл ляжет, а посетитель увидит старое. Запись через API инфоблока сбрасывает кеш по тегу сама, прямая запись в базу — нет. Кеш может жить в Memcached или Redis (`.settings.php`, ключ `cache`), файлами его тогда не убрать. Поэтому нужен серверный файл на проде, аналог `SiteCodeCacheGateway`.

## 10. Лицензия и право

Заключение юриста не получено. Ниже — чтение текста, а не правовая оценка. Действует редакция на сайте (п. 11.5): https://www.1c-bitrix.ru/download/law/eula_bus.pdf, от 27.05.2025; нумерация совпадает с редакцией 15.08.2024 из дистрибутива.

| Пункт | Пересказ | Что значит для Радити |
| --- | --- | --- |
| 1.8 | Демо-версия — только чтобы пользователь сам ознакомился с возможностями и проверил их | Базовый образ на демо-ядре для запуска сайтов клиентов не подходит |
| 1.11 | Ядро — файлы в `/bitrix/modules/` | Граница запрета |
| 2.1, 4.1 | Право на **одну копию** | Предпросмотр — вторая копия |
| 3.2 | Алгоритмы и исходные коды, вместе с их частями, — коммерческая тайна | **Ядро нельзя давать агенту:** рабочий набор ушёл бы модели на Z.ai, за рубеж. `/bitrix/modules` и копии из него вне рабочего набора |
| 3.7, 8.3 | Обфускация и ключ — средства защиты; ответственность за их устранение | Ядро не патчить, проверку не обходить |
| 4.2 | Временно на дополнительный компьютер, только разработка, тестирование, наполнение и только без внешнего доступа, ни из интернета, ни из-за пределов локальной сети пользователя; удалить после работ | **Предпросмотр по адресу `*.raditi-preview.ru` — внешний доступ по буквальному чтению.** Срок жизни предпросмотра 72 часа, удаление есть; условие о доступе — нет |
| 4.3 | Компоненты нельзя разделять и использовать на разных ЭВМ | Наложение «ядро отдельно, код отдельно» под вопросом |
| 4.7 | Адаптация можно, переработка нельзя | Менять `/bitrix/modules/` нельзя |
| 4.8 | Нельзя копировать и распространять Программу, её компоненты и созданные на ней Сайты в любой форме и любым способом, в том числе в исходном коде, в аренду или прокат | Хранение ядра в Gitea, S3 или образе; образ, общий на клиентов, — прямое попадание. Про «Сайты» — вопрос, распространяется ли запрет на файлы клиента в его же репозитории |
| 5.5 | Демо-версию нельзя отчуждать | |
| 6.4 | NFR-лицензия при согласии 1С-Битрикс — только самостоятельное использование для разработки и тестирования | Возможный путь для стендов Радити |
| 9.5 | Модули Маркетплейса — по отдельным соглашениям авторов | Копия каждого платного модуля — отдельный вопрос |
| 10 | Сбор телеметрии, в том числе о посетителях | Предпросмотр не должен звонить вендору |

Документация вендора звучит мягче, но не отменяет EULA:

- на ключ допускаются две установки: публичная и локальная для разработчика, закрытая от интернета (LESSON_ID=2697, COURSE_ID=32);
- «Установка для разработки»: для дополнительных копий закрыть сайт для посетителей, боевое использование запрещено, за грубые нарушения ключ могут заблокировать бессрочно (LESSON_ID=8471; пересказ WebFetch, сверить с источником);
- независимые копии с отдельным ядром или отдельной базой на одной лицензии не допускаются, даже на одном сервере (`advanced/multisite.md`).

**Риск для клиента, не только для Радити.** Система обновлений запоминает состояние установки; копия, которая обратится к серверу обновлений по ключу прода, может привести к `ERROR_WRONG_CODE` при обновлении боевого сайта (LESSON_ID=8471, 2697). У предпросмотра интернет открыт (план 58), поэтому ключ в копию не класть, хосты вендора закрыть, `update_autocheck` убрать, `update_devsrv='Y'` поставить. Как копия ведёт себя без ключа — раздел 13.

**Вопросы юристу и вендору.** Законна ли копия у исполнителя по поручению лицензиата. Считается ли доступ клиента по одноразовому билету к закрытому шлюзу «внешним». Можно ли хранить ядро у платформы, зашифрованным, отдельно на каждого клиента. Есть ли партнёрский статус, снимающий ограничение: письменный ответ 1С-Битрикс здесь важнее толкований.

## 11. Docker и стенд

| Что | Факт |
| --- | --- |
| Официальный проект | `bitrix-tools/env-docker`, GPL-3.0, 205 звёзд, последний коммит 22.10.2026, «поддерживается и развивается командой внутри компании»; для разработки: «не рекомендуется для использования в "боевом" режиме» |
| Образы | `quay.io/bitrix24/php:{8.2.35,8.3.36,8.4.27,8.5.12}-fpm-v1-alpine`, `percona-server:{8.0.46,8.4.11,9.7.2}-v1-rhel`, `nginx:1.30.6-v1-alpine`, `push:3.3-v1-alpine`, `sphinx:2.2.11-v3-alpine`, плюс официальные redis, memcached, postgres |
| Внутри | PHP-FPM на Alpine, uid и gid `bitrix` 979, корень `/opt/www`, `BX_TEMPORARY_FILES_DIRECTORY` → `/opt/.bx_temp`, `cap_drop: ALL`, `no-new-privileges`, tmpfs с `noexec` |
| **Ядра в образах нет** | Том `www_data` пуст; ставят `bitrixsetup.php` или `restore.php` браузером (README:439-516) |
| PHP 7.x | Нет. Старые сайты образы вендора не покрывают |
| Архитектура | `amd64`, `arm64`; сборка через Docker Desktop (README:3212) |
| Сторонние | `bitrixdock/bitrixdock` и другие: для демо, вендором не поддерживаются |
| ВМ | VMBitrix 9.0.9 на Alma, Rocky, Oracle, CentOS Stream 9; PHP 8.2 по умолчанию с 9.0.4, обновление до 8.5 с 9.0.9; какая версия по умолчанию сейчас, страница не говорит |

Образ предпросмотра Радити — `FROM wordpress@sha256:…` с MariaDB 11.8.9 и WP-CLI (`infra/preview/Dockerfile`). Для Битрикса подойдёт тот же приём от `php:<версия>-apache`: Apache mod_php остаётся единым с нынешним `web.command`, переход на FPM не нужен. Нужны расширения из раздела 1.2 и строки php.ini: их можно задать `php_admin_value` в `configFiles`. Образ FPM вендора в модель «один контейнер, Apache на 8081» не ложится.

**Как получить установленный сайт в стенде.**

| Способ | Статус |
| --- | --- |
| Тихая установка CMS | Официально не найдена. BitrixEnv тих только для окружения (`install-env.md`, `bitrix-env-9.sh -s`). Хабр упоминает обёртку над шагами мастера; это не первичный источник. Не проверено |
| `install.config` | Распознаны поля `productName`, `welcomeText`, `skipInstallModules`, `imageBoxSrc`, `LANGUAGE_ID`, `INSTALL_CHARSET`; ключа и пароля там нет; `wizard.php` обфусцирован |
| Мастер через Playwright | Реально: браузер проходит те же шаги, что и человек. Шаги: `install-distr.md`. Занимает минуты, требует сети к вендору |
| `restore.php` | Только веб-мастер: `php_sapi_name` и `argv` в нём нет. Требует `.tar.gz`, поэтому стенд сначала должен иметь бэкап |
| Снимок установленного сайта | Технически да, но демо живёт 30 дней и через две недели блокируется (`TRIAL_ATTENTION_TEXT4`, https://www.1c-bitrix.ru/download/cms.php). Хранить такой снимок в реестре и CI — тот же вопрос 4.8; в Git он не идёт |
| Источник дистрибутива | Отдаётся без входа: `https://www.1c-bitrix.ru/download/{start,standard,small_business,business}_encode.tar.gz` (313–398 МБ), `.zip` тоже. Установка принимает EULA. Ссылка на редакцию «Энтерпрайз» там же |

Для стенда разумнее скачивать дистрибутив в каждом прогоне и не публиковать результат. Использовать ли демо для стенда Радити — вопрос п. 1.8.

## 12. Что ломает WordPress-мышление

1. **Ядро нельзя взять.** `requiredPaths` проверяется по git (`preview-builder.ts:620`) → `no_core`. У WordPress ядро импортировано (`wordpress-preview.ts:87`). Для Битрикса этот контракт неверен.
2. **Ядро нельзя скачать заново.** `publicOriginals` здесь нет: публичного реестра файлов нет, версии модулей у каждого сайта свои (26.150.0 и `iblock` 25.300.0 в одном дистрибутиве), набор модулей зависит от редакции и покупок.
3. **Страницы — файлы, контент — база, и то и другое важно.** Нет единого `post`. `publishedObjectRefSchema = /^(post|page):…/` (`packages/domain/src/ports/published-content.ts:4`) и `browserCheckpointKinds = ['post']` (`packages/domain/src/browser/checkpoint.ts`) зашиты под WordPress. `browserObjectIdSchema` не пропустит путь файла `/about/index.php`.
4. **Нет одного редактора.** Элемент, товар, раздел, файл страницы, меню, включаемая область — разные экраны. `browserCheckpointOf` даст минимум три вида.
5. **`/local/` не единственное место кода.** См. раздел 0, п. 4.
6. **`.htaccess` важен.** Импорт его не берёт (`php-hosting.ts`); конфиг предпросмотра обязан нести правила; на проде он остаётся нетронутым. `.access.php`, `.section.php`, `.top.menu.php` — точечные файлы контента: списки игнора и FTP не должны их терять, без `.access.php` сайт закрыт для всех.
7. **Нет CLI и нет `wp eval`.** `previewContentRecipeSchema` описан под argv без оболочки: нужен свой файл PHP в дереве.
8. **`recordPages` по `{id}` невозможен.** Адрес — шаблон инфоблока с `#ELEMENT_CODE#`, `#SECTION_CODE_PATH#` и SEF-настройки компонента в файле страницы.
9. **Префикса таблиц нет, имена динамические, белый список на 64 имени не поместится.** Раздел 6.3.
10. **Кеш обязателен к сбросу.** Раздел 9.
11. **cp1251 жив.** Файлы, база, языковые файлы — в одной кодировке. `TextDecoder('utf-8', {fatal:true})` в `php-config.ts` даёт пустой результат; модель и `gitleaks` читают кракозябры; git хранит байты, а дифф и `client_message` — UTF-8. Такой сайт нельзя обновить, не конвертировав; конвертация сама по себе опасна и делается на копии (`encoding.md:221`). Рекомендация: сайт в cp1251 в первой версии не подключать, только задачи в браузере.
12. **`mbstring.func_overload` на старом ядре.** Сайту до main 20.100.0 в UTF-8 нужен PHP ≤ 7.4 с этой директивой. Директива уровня `php.ini`, для предпросмотра — `php_admin_value`; образов вендора для такого PHP нет.
13. **PHP не один.** `wordpressPhpVersions` берёт ближайшую версию; Битрикс строже: `short_open_tag`, `memory_limit`, `max_input_vars` и закодированные партнёрские файлы, чья совместимость с версией PHP неизвестна. Не проверено.
14. **`.settings.php` не `wp-config.php`.** Подключение в массиве, конфигурация в двух файлах, файл `/local/` заменяет файл `/bitrix/`, `.settings_extra.php` меняет ключ целиком, старые версии читают `dbconn.php`. Там же кеш и сессии на Redis, которых в копии нет: без замены сайт упадёт.
15. **`init.php` занят.** Подложить код нельзя, не отключив файл клиента. Только `auto_prepend_file`.
16. **События в базе.** Обработчики партнёров — в `b_module_to_module`, код агентов — строки в `b_agent`.
17. **Сайт сам шлёт письма и ходит в 1С.** Агенты запускаются на хитах посетителей (`framework/background-jobs.md`), почта уходит из `b_event` на хитах. Предпросмотр без `NO_AGENT_CHECK`, `DisableEventsCheck` и `custom_mail` разошлёт письма настоящим людям. Интернет предпросмотра открыт.
18. **`sessid` обязателен в каждом POST** и зависит от `server_uniq_id`.
19. **Демо-модули партнёров со своими сроками.** `CModule::IncludeModuleEx` возвращает `MODULE_DEMO`, `MODULE_DEMO_EXPIRED`, `include.php` и `install/index.php` обфусцированы (https://dev.1c-bitrix.ru/learning/course/index.php?COURSE_ID=101&LESSON_ID=3217, изм. 23.09.2021). В копии дата установки в базе, поведение не проверено.
20. **Обмен с 1С.** Цены и остатки перезаписываются внешней системой: то, что выпуск записал, сотрёт ближайшая выгрузка. Адаптер должен это говорить.
21. **Многосайтовость обычна**, а одна база и одно ядро на несколько сайтов — норма. `b_lang`, `site`-параметр в адресах редактора. Один `SiteFacts` на установку не описывает сайт.
22. **Символические ссылки в корне** при многосайтовости на разных доменах не проходятся (`tree-walk.ts:197`).
23. **`Сохранить` и `Опубликовать` не различаются.** Раздел 8.3.
24. **Корзины нет.** Раздел 8.4.
25. **`.gitignore` против частей бэкапа.** Раздел 3.

## 13. Что запускать в предпросмотре

Заглушка запрещает ядро: `bitrix.ts:13,18,44`, `bitrix.test.ts:62`, `spec.md:1452`. Причина там не записана. Проверка дала две самостоятельные причины: EULA (раздел 10) и размер. Даже без лицензии импорт бы не прошёл:

| Лимит Радити (`limits.ts`) | Значение | Ядро «Бизнес» |
| --- | --- | --- |
| `treeBytes`, `bundleBytes` | 1 ГиБ | ≈ 1,6 ГБ, оценка |
| `files` | 100 000 | ≈ 108 000, оценка |
| `directories` | 20 000 | ≈ 45 000; только дистрибутив — 25 194 |
| `stageMs` | 60 минут | По FTP (`ftpSessions: 2`) 108 000 файлов — один RETR на файл. Скорость не мерили; при 20 файлах в секунду это 90 минут |

| Вариант | Как | Законность | Техника | Вывод |
| --- | --- | --- | --- | --- |
| **А. Ядро в git сайта**, как WordPress | Импорт `/bitrix/` | Хуже всего: 4.8, копия в Gitea, вечная история | Не проходит лимиты; Gitea на сайт ≥ 1,6 ГБ | **Нет** |
| **Б. Кеш ядра вне git** | Скачать `/bitrix/modules` и производные с хостинга клиента в свой зашифрованный кеш; подмешивать при сборке предпросмотра; у каждого сайта свой | Копия та же, но только пока идёт работа, один клиент: шанс подпасть под 4.2, кроме условия о внешнем доступе | `requiredPaths` проверять по кешу, а не git; новый порт источника файлов; тома по 1,6 ГБ на предпросмотр; обновление при смене версии; ≈ 100 тысяч файлов через FTP | **Лучший технический путь**, только после ответа юриста |
| **Б1. Источник — бэкап клиента** | Клиент делает «только файлы» в `dump.php`, платформа забирает один архив | Как Б | Решает FTP: один файл вместо 100 тысяч. Архив без базы, режим задать явно; бэкап с дампом принимать нельзя: фильтр на источнике пропал бы | Сильное дополнение к Б |
| **В. Базовый образ с демо-ядром** + код клиента | Образ на версию | **Нет:** 1.8, 5.5, 4.8; срок 30 дней | Версия и редакция не совпадут с базой клиента; нет партнёрских модулей; при расхождении версий схема и код разойдутся | **Нет**, хотя именно это первым приходит в голову |
| **Г. Общий образ с ядром от лицензии** | Один образ на версию для всех клиентов | **Хуже В:** 4.8 и передача третьим лицам | Быстро, но нарушение прямое | **Нет** |
| **Д. Предпросмотр на хостинге клиента** | Вторая копия на поддомене с `update_devsrv=Y`, закрытая `site_stopped` | Самый близкий к документации вендора путь, но «внешний доступ» и там; лицензия клиента | Нужны SSH, диск, вторая база. Код агента исполняется на хостинге рядом с прод-паролем: **нарушает правило 5** | **Нет**, изоляция важнее |
| **Е. Без предпросмотра: браузер на живом сайте** | План 57, Б1 | **Копии нет.** Чисто | Готово: нужны методы адаптера. Отката нет, это уже принято | **Первый срез** |
| **Ж. Наложение на прод** | Шлюз проксирует живой сайт и подменяет статику: CSS, JS, картинки из кандидата | Копии нет | Только статика; PHP-шаблоны и база не видны; куки и CSP живого сайта | Узкий, но законный: можно вторым срезом для правок вёрстки |

**Рекомендация.** Первый срез — Е. Параллельно владелец спрашивает 1С-Битрикс письменно и юриста. Варианты Б и Б1 — только после ответа. А, В, Г — закрыть сразу.

**Что проверить опытом для варианта Б.** Только на своей законной лицензии, без вмешательства в обфусцированный код: сайт с копией БД и без `license_key.php`; без `admin_passwordh`, `crc_code`, `PARAM_*`; на другом домене; что уходит наружу с такой копии; сколько реально весит и занимает файлов установленное ядро.

## 14. Что поправить в адаптере и портах

| Где | Что |
| --- | --- |
| `bitrix.ts:58` | `rootMarkers = ['bitrix', '.access.php']` |
| `bitrix.ts:18,44` | Не `bitrix/` целиком: разрешить `bitrix/templates/` (кроме копий вендора), `bitrix/components/<не bitrix>/`, `bitrix/php_interface/init.php`, `include/`, `<SITE_ID>/`; исключить остальное и `bitrix/backup/`, `tmp/`, `updates/`, `license_key.php`, `.settings*.php`, `dbconn.php`, `after_connect*.php` |
| `bitrix.ts:21` | Те же защищённые пути в `/local/`: `local/.settings*.php`, `local/php_interface/dbconn.php` |
| `bitrix.ts:108` | `configSecrets`: добавить `/local/` и `.settings_extra.php`, `crypto_key`, `signature_key`, `$LICENSE_KEY`. Тест `bitrix.test.ts:151` закрепляет обратное, его менять |
| `bitrix.ts:43`, `php-hosting.ts` | Папки посетителей в `/upload/` из раздела 3; части бэкапов `*.tar.[0-9]*`, `*.tar.gz.[0-9]*`, `*.enc`, `*.enc.gz*` |
| `registry.ts:33`, `:37` | `connectableStacks` и контент-адаптер: сначала только путь «Без доступа к файлам» |
| `siteStacks` | Добавить проверку «это Битрикс24» при подключении |
| `BrowserSignInForm` | Признак формы по селектору, а не по пути |
| `browserCheckpointKinds`, `browserObjectIdSchema`, `publishedObjectRefSchema` | Виды: `iblock_element`, `page_file`; идентификатор файла закодировать |
| `databaseCopyPolicySchema` | Шаблоны имён таблиц, предел 64, список таблиц с источника, фильтр по `IBLOCK_ID` |
| `PreviewRecipe.requiredPaths` | Проверять по будущему источнику ядра, не только по git |
| `SiteContentAdapter`, `SiteCodeCacheGateway` | Свой файл на проде вместо плагина: `/local/tools/raditi.php`, сброс четырёх слоёв кеша |
| `infra/preview` | Отдельная база образа без WP-CLI, конфиг Apache с правилами раздела 1.3, `auto_prepend_file` |

## 15. Что осталось не проверено

Доля версий и кодировок в России. Сроки поддержки веток. Состав «Малого бизнеса» и «Старта» по модулям. Размер реальных сайтов и установленного ядра замером. Поведение копии без ключа и лицензионных строк. Поведение проверки лицензии вообще: обфусцированные файлы не читались сознательно. Кодирование модулей Маркетплейса средствами ionCube или Zend Guard: в дистрибутивах вендора ни того ни другого нет, требований Маркетплейса об этом не нашёл, официально описана только обфускация `include.php` и `install/index.php` у демо-модулей. Тихая установка CMS. Поддержка `utf8mb4_0900_ai_ci` в MariaDB 11.8. Минимальный набор таблиц запуска. Весь PHP этого отчёта не запускался.

## Источники

Первичные, проверены 01.11.2026.

- Дистрибутивы: https://www.1c-bitrix.ru/download/cms.php
- Требования: https://dev.1c-bitrix.ru/learning/course/index.php?COURSE_ID=135&LESSON_ID=2593 , https://www.1c-bitrix.ru/products/cms/requirements.php , https://dev.1c-bitrix.ru/user_help/reqintro.php , https://helpdesk.bitrix24.ru/open/5825131/
- История версий: https://dev.1c-bitrix.ru/docs/versions.php
- EULA: https://www.1c-bitrix.ru/download/law/eula_bus.pdf , https://www.1c-bitrix.ru/legal/ , https://www.1c-bitrix.ru/legal/limited_license.php
- Установка для разработки: https://dev.1c-bitrix.ru/learning/course/index.php?COURSE_ID=135&LESSON_ID=8471
- Типичные ошибки обновления: https://dev.1c-bitrix.ru/learning/course/index.php?COURSE_ID=32&LESSON_ID=2697
- Ошибки при переносе: https://dev.1c-bitrix.ru/learning/course/index.php?COURSE_ID=32&LESSON_ID=3293
- Демо-режим модулей: https://dev.1c-bitrix.ru/learning/course/index.php?COURSE_ID=101&LESSON_ID=3217
- Требования Маркетплейса: https://partners.1c-bitrix.ru/upload/marketplace/2.4.%20marketplace_module_requirements.pdf (из поиска, от 23.04.2024)
- Лицензии и цены: https://www.1c-bitrix.ru/products/cms/license.php
- VMBitrix: https://www.1c-bitrix.ru/download/vmbitrix.php
- Документация: https://github.com/bitrix-tools/framework-docs
- Контейнеры: https://github.com/bitrix-tools/env-docker
- Практики для агентов: https://github.com/bitrix-tools/best-practice
- Доли CMS: https://itrack.ru/research/cmsrate/
- PHP 8.0: https://www.php.net/manual/en/migration80.incompatible.php
- MariaDB: https://jira.mariadb.org/browse/MDEV-35256
