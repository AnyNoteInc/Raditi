# OpenCart 2.3 / 3.x / 4.x, ocStore, OPENCART.PRO — сведения для адаптера стека Радити

Дата проверки всего ниже, если не сказано иное: **01.11.2026**.
Код скачан и только прочитан (ничего не запускалось) в `research/src/opencart/`:
`oc-3.0.5.1` (тег, 04.08.2026), `oc-4.1.0.4` (тег, 29.07.2026), `oc-4.2.x` (ветка, 14.10.2026), `oc-2.3.0.2`, `ocstore-3.0.3.7`, `ocstore-3.0.4.1b`, `ocstore-3.0.x.x`, `ocstore-3.0.5.0-Beta`, `ocstore-4.1.0.4-Beta`, `ocstore-2.3.0.2.4`, `vqmod`.
Ссылки вида `oc-3.0.5.1/upload/…:N` — на эти файлы; `packages/…`, `apps/…`, `infra/…` — на `raditi-stacks`.
Источники (URL и дата) — в конце. **«не проверено»** — утверждение без первичного источника или выведенное чтением кода без запуска.

## Главное

1. Живых веток четыре, и они несовместимы по коду: **2.3** (`.tpl`, `token`, `oc_url_alias`, PHP ≥ 5.4), **3.0** (Twig, `user_token`, `oc_seo_url`, классы без пространств имён, MyISAM), **4.0** (пространства имён, маршрут `catalog/product|form`, без OCMOD), **4.1** (маршрут `catalog/product.form`, OCMOD вернулся в `extension/ocmod/`, InnoDB). Один адаптер должен ветвиться по версии.
2. То, что исполняется, — не то, что лежит в дереве: `system/storage/modification/` (OC 2.3, 3.0), `extension/ocmod/` (OC 4.1), `vqmod/vqcache/`. Копии порождаются из `oc_modification.xml` и перекрывают исходники. Правка агентом исходного `.twig` может не дать эффекта, а пересборка есть только как метод контроллера админки.
3. В базе лежит код и разметка: `oc_theme.code` (Twig из редактора шаблонов, перекрывает файл), `oc_translation`, `oc_modification.xml`, `oc_event`, `oc_startup`, `oc_module.setting`, а HTML текстов хранится экранированным (`&lt;p&gt;`).
4. Адрес админки несёт секрет сессии: `user_token` в каждом URL. Форма входа показывается на любом маршруте без редиректа, OC 4 после входа всегда ведёт на `common/dashboard` с персональными данными, кнопка «Сохранить» — значок без текста. Порт браузера (`isSignInPage(path)`, `editUrl`, `browserVerification`, `browserCommitAction(role, name)`) на это не рассчитан.
5. Обезличенная копия: разрешающий список OC 3 — около 87 таблиц, а схема `databaseCopyPolicySchema.tables` — `.max(64)` (`packages/domain/src/preview/recipe.ts:246`). Секреты лежат в `oc_setting` открытым текстом, в том числе под произвольными `code` (`yoomoney` → `yoomoney_kassa_password`), поэтому список — только разрешающий.
6. Образ с ядром не нужен: ядро и так в дереве сайта (GPLv3, лицензионного ключа нет). Официального образа нет. Базовому образу нужны PHP, Apache и, по желанию, ionCube Loader; для стенда есть `install/cli_install.php`.

---

## 1. Версии, среда, перезапись адресов

### 1.1. Ветки

| Ветка | Последний выпуск | Статус на 01.11.2026 | PHP снизу (`system/startup.php`) | Шаблоны | Токен админки | Таблица ЧПУ | Движок таблиц | Кодировка соединения |
|---|---|---|---|---|---|---|---|---|
| OpenCart 4.2.x.x | `VERSION 4.2.0.0`, не выпущена | ветка разработки, таблицы равны 4.1.0.4, `login.php`, `setting.php`, `cli_install.php` без отличий | 8.1 | Twig | `user_token` | `oc_seo_url` | InnoDB | utf8mb4 |
| OpenCart 4.1 | **4.1.0.4**, 11.08.2026 | текущая; единственная на странице загрузки opencart.com | 8.1 (4.1.0.0–4.1.0.3: 8.0) | Twig, FilesystemLoader | `user_token` | `oc_seo_url` | InnoDB | `utf8mb4` (`system/library/db/mysqli.php:78`) |
| OpenCart 4.0 | 4.0.2.3 | вытеснена 4.1 | 8.0 | Twig | `user_token` | `oc_seo_url` | InnoDB (не проверено) | utf8mb4 (не проверено) |
| OpenCart 3.0 | **3.0.5.1**, 11.08.2026 | поддерживается параллельно: в CHANGELOG 3.0.5.1 правки под PHP 8.5 | 8.1 с 3.0.5.0; 7.3 в 3.0.3.6–3.0.4.1; 5.4 в 3.0.3.2 и раньше | Twig, ArrayLoader | `user_token` | `oc_seo_url` | MyISAM (132 из 134 в 3.0.5.1) | `utf8` (`oc-3.0.5.1/upload/system/library/db/mysqli.php:17`), при таблицах utf8mb4 |
| OpenCart 2.3 | 2.3.0.2 (2016) | снята | 5.4 | `.tpl` | `token` | `oc_url_alias` | MyISAM | `utf8` (`oc-2.3.0.2/upload/system/library/db/mysqli.php:13`) |
| ocStore 3.0 | **3.0.4.1**, 19–20.10.2025 (`ocstore.com`, opencartforum) | актуальная стабильная форка | 7.3 в коде (на ocstore.com для 3.0.3.7 указано 7.1+) | Twig | `user_token` | `oc_seo_url` | MyISAM, `utf8_general_ci` в 3.0.3.7 | `utf8` (`ocstore-3.0.3.7/upload/system/library/db/mysqli.php:13`) |
| ocStore 3.0.5.0b, 4.1.0.4b | ветки `3.0.5.0-Beta` (27.05.2026), `4.1.0.4-Beta` (27.08.2026, ветка по умолчанию) | бета, не выпущены | 8.1 | Twig | `user_token` | `oc_seo_url` | как у базы | как у базы |
| ocStore 2.3 | 2.3.0.2.4 (07.03.2021; карточка обновлена 30.07.2022) | снята | 5.6 по `ocstore.com` | `.tpl` | `token` | `oc_url_alias` | MyISAM | utf8 |
| OPENCART.PRO | 2.3.0.2.5, 20.09.2018 (`opencart.pro/reliz/`); 2.3.0.2.6 — репозиторий `BuslikDrev/OpenCart.CMS-2.3.0.2.6`, изменён 21.10.2026 | только линия 2.x; сборка CMS бесплатна, PRO продаётся на opencartforum | 5.4, в README значок «8.5 >= 5.4» | `.tpl` | `token` (не проверено) | `oc_url_alias` (не проверено) | не проверено | не проверено |

Верхняя граница PHP не задана нигде. Для 3.0.3.x и 2.3 совместимость с PHP 8 не проверена; `oc-2.3.0.2/upload/system/library/encryption.php:10` вызывает `mcrypt_encrypt` (нет с PHP 7.2), но только при шифровании платёжными модулями (не проверено запуском).

Смена `require` в `composer.json` по тегам (проверено чтением raw с GitHub): 3.0.3.6–3.0.3.8 — Twig `^2.4.8`, scssphp 1.1.1; 3.0.3.9–3.0.4.1 — Twig `^3.3`, scssphp `^1.11`; 3.0.5.0 — Twig `^3.21.1`, scssphp `^2.0.1`; 3.0.5.1 и 4.1.0.4 — Twig `^3.24.0`, scssphp `^2.1.0`.

Маршруты OC 4: разделитель метода `|` в 4.0.0.0–4.0.1.1, `.` с 4.0.2.0; `oc-4.1.0.4/upload/system/framework.php` заменяет `|` на `.`, поэтому старые ссылки работают.

OCMOD в OC 4: `admin/controller/marketplace/modification.php` — 404 на тегах 4.0.0.0–4.0.2.3, есть с 4.1.0.0.

### 1.2. Что живёт в России

| Источник | Что говорит | Оговорка |
|---|---|---|
| iTrack, рейтинг CMS зоны .RU | OpenCart 1,76 %, 22 300 установок; WordPress 42,87 %; 1С-Битрикс 11,79 %; Joomla 7,13 %; MODX Revolution 1,85 %. ocStore на странице нет | данные января 2024; сводка страницы, 5,47 млн доменов |
| W3Techs | OpenCart — 0,3 % всех сайтов, 0,5 % сайтов с известной CMS, 1,9 % e-commerce (ноябрь 2026) | мир, не Россия; в топ-3 .ru (WordPress 33,3 %, Tilda 27,4 %, Bitrix 16,0 %) его нет |
| 2ip.io, ocStore | 23 726 сайтов в 385 зонах | из сниппета поиска; страница отдала 503, дата среза неизвестна — не проверено |
| ocstore.com | демо работает на 3.0.3.7, заявлены украинский, английский, русский | |

Распределение по версиям внутри России: **не проверено**, первичных данных нет. Косвенно: на ocstore.com и opencartforum в ходу 3.0.3.7, 3.0.4.1 и 2.3.0.2.4; OPENCART.PRO живёт только на 2.x.

ocStore сейчас ведётся по-украински: README, коммиты и язык `uk-ua`; в 3.0.3.7 был `ru-ru`, с 3.0.4.1b в репозитории `ru-ru` нет, `VERSION_LANGPACK = 'UK-EN'`. Русская сборка 3.0.3.7 — отдельная на opencartforum; есть ли русская 3.0.4.1 — не проверено. В админке возможны три языка: en-gb, ru-ru, uk-ua.

### 1.3. Расширения и настройки PHP

Источник: `upload/install/controller/install/step_2.php` обеих веток, `docs.opencart.com/getting-started/system-requirements.md`.

| Требование | OC 4.1.0.4 | OC 3.0.5.1 |
|---|---|---|
| Обязательные расширения | `gd`, `curl`, `zlib`, `zip`, `openssl_encrypt`, `iconv` или `mbstring`, драйвер БД из `mysqli`, `pdo`, `pgsql` | те же и `dom`, `hash`, `xmlwriter`, `json` |
| Настройки ini | `file_uploads` вкл., `session.auto_start` выкл., проверка `open_basedir` (`step_2.php:58,157`) | `file_uploads` вкл., `session.auto_start` выкл. |
| Файл `php.ini` в корне архива | `memory_limit 128M`, `upload_max_filesize 20M`, `allow_url_fopen On` | `memory_limit 64M`, `max_execution_time 36000`, `upload_max_filesize 999M`, `session.gc_maxlifetime 3600` |
| Веб-сервер | документация: «Apache рекомендуется»; страницы про nginx нет | то же |
| Версии MySQL и MariaDB | в документации нет; стенд самого проекта — `mysql:5.7` (`oc-4.1.0.4/docker-compose.yml`) | нет |
| `sql_mode` | драйвер ставит `NO_ZERO_IN_DATE,NO_ENGINE_SUBSTITUTION` и `FOREIGN_KEY_CHECKS = 0` (`mysqli.php:80`) | `NO_ZERO_IN_DATE,NO_ENGINE_SUBSTITUTION` (`mysqli.php:18`) |

Базовому образу предпросмотра хватает (`infra/preview/Dockerfile:8` — от `wordpress@sha256`, в нём есть `gd`, `mysqli`, `zip`; не проверено только наличие `xmlwriter` и `dom` в конкретном digest, они в сборке `php` по умолчанию).

### 1.4. Перезапись адресов

Файл поставляется как **`.htaccess.txt`** и не действует, пока его не переименуют; `config_seo_url` по умолчанию `0`. Правила OC 4.1.0.4 (`upload/.htaccess.txt`):

Пересказ:

- `Options -Indexes` закрывает список папок;
- файлы `.tpl`, `.twig`, `.ini`, `.log` и `.txt`, кроме `robots.txt`, закрыты;
- включён `RewriteEngine`, база `/`;
- `system/storage/` уходит на маршрут `error/not_found`;
- запрос без файла и папки, кроме статики по расширению (ico, gif, jpg, jpeg, png, webp, js, css, svg), уходит в `index.php` с параметром `_route_`.







| Отличие | Где |
|---|---|
| 3.0.5.1 добавляет `RewriteRule ^sitemap.xml$ index.php?route=extension/feed/google_sitemap [L]` и `^googlebase.xml$ …google_base` | `oc-3.0.5.1/upload/.htaccess.txt` |
| ocStore 3.0.3.7 добавляет снятие `page=1` редиректом 301 | `ocstore-3.0.3.7/upload/.htaccess.txt` |
| `RewriteBase /` в подкаталоге — `/shop/`; задаётся вручную | комментарий в файле |
| OC 3 несёт `system/.htaccess` (запрет всего, кроме `.js` и `.css`) и `system/storage/session/.htaccess`; в OC 4.1.0.4 их нет | `find` по дереву |
| Без `.htaccess` на OC 4 `system/storage/` доступен с веба, если он в docroot | вывод из отсутствия файла, не проверено запуском |

nginx: правила в поставке нет. Эквивалент `location / { try_files $uri $uri/ /index.php?_route_=$uri&$args; }` и запрет `system/storage` — **не проверено**.

---

## 2. Распознавание

### 2.1. Метки корня

`rootMarkers` сравниваются по именам записей каталога, файл это или папка, без учёта типа (`packages/site-connections/src/sources/root-check.ts:55`), поэтому файл годится в метку. Папка ниже корня, где есть все метки, импортом не обходится (`apps/core/src/site-provisioning/tree-walk.ts:53`).

| Запись | Есть всегда | Есть у вложенных папок | Вывод |
|---|---|---|---|
| `catalog/` | да, все ветки | да: `admin/controller/catalog`, `admin/model/catalog`, `image/catalog`, `extension/opencart/catalog` (4.x) | метка, одной мало |
| `system/` | да | у расширений 4.x: `extension/<code>/system/` | метка |
| `image/` | да | `admin/view/image`, `install/view/image`; `extension/<code>/image/` быть не должно: установщик переносит `image/` в `DIR_IMAGE` (`oc-4.1.0.4/upload/admin/controller/marketplace/installer.php:444`) | метка |
| `index.php` | да | `admin/index.php`, `install/index.php`, сторонние папки | не отличает |
| `config.php` | да у установленного сайта | `admin/config.php` (но там нет `catalog/`) | хорошая метка |
| `admin/` | **нет**: папку переименовывают | — | не метка |

Предложение: `rootMarkers() = ['catalog', 'system', 'image', 'config.php']`. Вложенной папки со всеми четырьмя в поставке нет. Отпечаток стека, для `detect` и мастера — файлы, а не только имена: `system/startup.php`, `system/engine/action.php`, `catalog/controller/common/home.php`.

### 2.2. Версия без выполнения кода

| Что | Файл и синтаксис | Заметка |
|---|---|---|
| Версия ядра | `index.php:3` `define('VERSION', '3.0.5.1');` и то же в `<admin>/index.php:3` | шаблон `/\bdefine\(\s*'VERSION'\s*,\s*'([^']+)'/`; у ocStore-бет суффикс `b` (`3.0.4.1b`) |
| Форк ocStore 3.x, 4.x | `index.php:4–6` `define('VERSION_CORE', 'ocStore');`, `VERSION_BUILD`, `VERSION_LANGPACK` | в `ocstore-3.0.3.7` нет `VERSION_LANGPACK`, в 2.3.0.2.4 нет ни одной из трёх |
| Форк ocStore 2.3 и OPENCART.PRO | пятичастная версия `2.3.0.2.N` | у обоих одна форма: 2.3.0.2.4 у ocStore, 2.3.0.2.5–6 у PRO |
| Признаки ocStore в файлах | `system/library/seopro.php`, `admin/controller/blog/article.php`, `admin/controller/marketplace/opencartforum.php`, таблицы `article`, `blog_category`, `manufacturer_description`, `modification_backup` | сверка с `oc-3.0.5.1` |
| Отличие OPENCART.PRO | заголовок `README.md` репозитория и каталог `localization/`; в рабочем дереве признак не найден | не проверено на настоящей установке |
| Поколение | 4.x: `extension/` в корне, `system/framework.php`, `namespace Opencart\…`, `cron.php`, `error.html`. 3.x: `catalog/view/theme/*/template/**/*.twig`, `system/modification.xml`. 2.x: `*.tpl`, нет `system/storage/vendor/` | |
| Закодированный файл | строка `ionCube Loader` в начале `.php` | признак по памяти, образца в поставке нет — **не проверено**; `publicOriginals` такой файл не подтвердит |
| vQmod | `vqmod/vqmod.php`; в `index.php` строки `require_once('./vqmod/vqmod.php');`, `VQMod::bootup();`, `VQMod::modCheck(DIR_SYSTEM . 'startup.php')` | установщик правит `index.php` и `<admin>/index.php`, поэтому они не равны поставке |
| Кодировка соединения | `system/library/db/mysqli.php`: `set_charset('utf8')` или `set_charset("utf8")`, `set_charset('utf8mb4')` | в `config.php` кодировки нет |

Через `httpGet` без файлов: `catalog/view/javascript/common.js`, подвал `Powered By <a href="http://www.opencart.com">OpenCart</a>` (`text_powered`, темы его часто убирают — не проверено), cookie `OCSESSID`. Версию по HTTP не узнать: номер выводится только в подвале админки вошедшему (`admin/controller/common/footer.php`).

### 2.3. Папка админки

`config.php` каталога о ней ничего не знает. Найти можно только обходом папок первого уровня:

1. Кандидат — папка с `config.php`, где есть `HTTP_CATALOG` и `DIR_CATALOG` (OC 3) или `define('APPLICATION', 'Admin');` (OC 4), и файлом `controller/common/login.php`.
2. Кандидатов бывает два: OC 4 копирует `admin/` в новую папку, а старую удаляет отдельным действием (`oc-4.1.0.4/upload/admin/controller/common/security.php:371`, `:96`). Выбирать ту, чей `HTTP_SERVER` оканчивается её же именем.
3. Правила имени в OC 4: только `[a-zA-Z0-9]`, запрещены `admin`, `catalog`, `extension`, `image`, `install`, `system`.
4. В OC 2.3, 3.0 переименование ручное: папка и правка `HTTP_SERVER`, `HTTPS_SERVER`, `DIR_APPLICATION` в её `config.php`. OCMOD ищет пути с префиксом `admin/` буквально (`oc-3.0.5.1/upload/admin/controller/marketplace/modification.php:170–175`: `admin` переводится в `DIR_APPLICATION`, поэтому работает); vQmod требует правки `vqmod/pathReplaces.php`.

### 2.4. Похожие системы

| Система | Отличие | Источник |
|---|---|---|
| ocStore | см. 2.2 | код |
| OPENCART.PRO | см. 2.2 | README форка |
| AbanteCart, Arastta, TomatoCart | другие папки либо своя константа — **не проверено** | |
| CodeIgniter и др. с `system/` | нет `catalog/`, `image/`, `config.php` в связке | вывод |

---

## 3. Дерево

Размеры поставки: 3.0.5.1 — 84 МБ, 5 309 файлов (`system/storage/vendor` 9,2 МБ, `image` 5,6, `catalog` 15, `admin` 25, `install` 3,8); 4.1.0.4 — 58 МБ, 4 053 файла (`vendor` 4,5, `image` 5,3, `extension` 1,9, `catalog` 7,2, `admin` 27, `install` 11). Типичный магазин: не проверено; основной вес — `image/catalog` и `image/cache`.

| Путь | Ветки | Что это | Скачать заново | В импорт | Агенту | Заметка |
|---|---|---|---|---|---|---|
| `index.php`, `cron.php`, `error.html`, `robots.txt` | все / 4.x | точка входа | да | да | нет | `index.php` бывает правлен vQmod |
| `config.php`, `<admin>/config.php` | все | секреты, абсолютные пути | нет | **нет** | нет | |
| `config-dist.php`, `admin/config-dist.php` | все | пустые, 0 байт | да | да | нет | |
| `install/` | все | установщик; после установки удаляют | да | **нет** | нет | при непустом `config.php` открывает без входа мастер обновления схемы `upgrade/upgrade` (`install/controller/startup/upgrade.php`) |
| `admin/` (`<admin>/`) | все | ядро админки + файлы расширений OC 3 | частично | да | частично | ядро и код клиента вперемешку |
| `catalog/controller`, `model`, `language` | все | ядро витрины + расширения OC 3 | частично | да | частично | |
| `catalog/view/theme/<тема>/` | 2.x, 3.x | тема | нет для платных | да | **да** | Twig или `.tpl`, стили, картинки |
| `catalog/view/theme/*/stylesheet/*.css` рядом с `*.scss` | 3.x | порождается при запросе (`catalog/controller/startup/sass.php`) | генерат | да | осторожно | писать в дерево может сам сайт |
| `catalog/view/template`, `catalog/view/stylesheet` | 4.x | шаблоны ядра | да | да | нет | правка — через тему-расширение, OCMOD или `oc_theme` |
| `extension/opencart/` | 4.x | встроенные расширения | да | да | нет | |
| `extension/<код>/` | 4.x | расширения и темы клиента, чистая папка | платные нет | да | **да** | свои `admin`, `catalog`, `system` |
| `extension/ocmod/` | 4.1 | **генерат OCMOD, исполняется** | генерат | да, как есть | нет | `.../marketplace/modification.php:205,546` |
| `system/engine`, `system/library`, `system/helper`, `system/config` | все | ядро; в `system/library` бывают файлы расширений | частично | да | нет | |
| `system/modification.xml`, `system/*.ocmod.xml` | 3.x | правила OCMOD из файлов, читаются при пересборке (`modification.php:114,117`) | первое да | да | нет | |
| `system/storage/vendor/` | 3.x, 4.x | Composer: Twig, scssphp | да, по версии | **да**, иначе сайт не стартует | нет | внутри storage |
| `system/storage/modification/` | 2.3, 3.x | **генерат OCMOD, исполняется** | генерат | да, как есть | нет | `oc-3.0.5.1/upload/system/startup.php:49` |
| `system/storage/cache/` | все | `cache.*`, `template/` | генерат | нет | нет | |
| `system/storage/logs/` | все | `error.log`, `ocmod.log`, логи модулей | нет | **нет** | нет | могут содержать данные заказов (не проверено) |
| `system/storage/session/` | 3.x, 4.x | файлы сессий, только при `session_engine=file` | нет | **нет** | нет | по умолчанию сессии в базе |
| `system/storage/upload/` | все | **файлы посетителей** (опции товара, заявки), `oc_upload` | нет | **нет** | нет | + `tmp-*`, `*.tmp` установщика OC 3 |
| `system/storage/download/` | все | **цифровые товары**, `oc_download.filename` | нет | **нет** | нет | платный контент клиента |
| `system/storage/backup/` | 4.x | **полные дампы БД `*.sql`** (`tool/backup`) | нет | **нет** | нет | внутри дерева |
| `system/storage/marketplace/` | 4.x | `*.ocmod.zip` установленных расширений | платные нет | нет | нет | маска `*.zip` и так отсекает |
| `image/catalog/` | все | медиа | нет | да (решение по WP) | только добавление | менеджер файлов работает только здесь |
| `image/cache/` | все | ресайзы `имя-WxH.ext` | генерат | **нет** | нет | может быть очень большим |
| `image/payment/`, `*.png` в корне `image/` | все | служебные картинки | да | да | нет | |
| `vqmod/vqcache/`, `mods.cache`, `checked.cache`, `logs/` | при vQmod | генерат, пересобирается сам | генерат | нет | нет | |
| `vqmod/xml/*.xml` | при vQmod | правила | нет | да | осторожно | база не участвует |
| `.htaccess`, `.user.ini`, `php.ini` | все | настройки сервера | нет | по `phpServerConfigFiles` нет | нет | см. раздел 12, п. 16 |
| `*.sql`, `*.zip`, `*.tar.gz` в корне | часто | ручные бэкапы | нет | нет (`archivesAndDumps`) | нет | |

Каталог хранилища может лежать **вне docroot**: кнопка в админке переносит его и переписывает `DIR_STORAGE` абсолютным путём (`oc-3.0.5.1/upload/admin/controller/common/security.php:31`, `oc-4.1.0.4/upload/admin/controller/common/security.php:182,344`). В OC 4 имя начинается со `storage`, путь — не внутри `DOCUMENT_ROOT`. Тогда в папке сайта нет `vendor/` и `modification/`. Как быть: `vendor` брать из архива той же версии, `modification` пересобирать; при доступе FTP только к docroot до них не дотянуться.

---

## 4. Конфигурация

### 4.1. Файлы и константы

Два файла: `config.php` и `<admin>/config.php`. Пишутся установщиком, формат — однострочные `define` в одинарных кавычках, значения через `addslashes` (`oc-3.0.5.1/upload/install/controller/install/step_3.php:14–43`, `oc-4.1.0.4/upload/install/controller/install/step_3.php:155–200`).

| Константа | 2.3 | 3.0 | 4.x | Заметка |
|---|---|---|---|---|
| `APPLICATION` | — | — | `'Catalog'`, `'Admin'` | |
| `HTTP_SERVER` | да | да | да | адрес; в админке с `admin/` на конце |
| `HTTPS_SERVER` | да | да | **нет** | |
| `HTTP_CATALOG`, `HTTPS_CATALOG` | админка | админка | `HTTP_CATALOG` | |
| `DIR_OPENCART` | — | — | абсолютный путь | единственный абсолютный в OC 4 |
| `DIR_APPLICATION`, `DIR_SYSTEM`, `DIR_IMAGE` | абсолютные | абсолютные | от `DIR_OPENCART` | |
| `DIR_STORAGE` | — | `DIR_SYSTEM . 'storage/'` или абсолютный | то же | |
| `DIR_EXTENSION` | — | — | `DIR_OPENCART . 'extension/'` | |
| `DIR_MODIFICATION` | абсолютный | `DIR_STORAGE . 'modification/'` | — | |
| `DIR_CACHE`, `DIR_DOWNLOAD`, `DIR_LOGS`, `DIR_SESSION`, `DIR_UPLOAD` | абсолютные, без `DIR_SESSION` | от `DIR_STORAGE` | от `DIR_STORAGE` | |
| `DB_DRIVER` | да | `mysqli` | `mysqli` | есть `mpdo`, `pdo`, `pgsql` |
| `DB_HOSTNAME`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE`, `DB_PORT`, `DB_PREFIX` | да | да | да | префикс по умолчанию `oc_` |
| `DB_SSL_KEY`, `DB_SSL_CERT`, `DB_SSL_CA` | — | — | да, тело ключа строкой | секрет; могут быть пустыми |
| `CACHE_ENGINE`, `CACHE_HOSTNAME`, `CACHE_PORT`, `CACHE_PREFIX`, `CACHE_PASSWORD` | — | — | `CACHE_ENGINE`, остальные закомментированы | `CACHE_PASSWORD` раскомментированный — секрет |
| `OPENCART_SERVER` | — | админка | админка | не секрет; ocStore 4.1 добавляет `OPENCARTFORUM_SERVER` |

Кодировки и collation в конфиге нет: они в коде драйвера (1.1). Для `SiteAdapter.databaseSettings`: `DB_PREFIX` читать из `config.php`, `charset` — регуляркой из `system/library/db/mysqli.php`, `collation: null`.

### 4.2. Секреты в файлах

| Значение | Где | Как разобрать |
|---|---|---|
| Пароль БД | `DB_PASSWORD` в обоих файлах | `phpStringsAfter(file, defineOf('DB_PASSWORD'), defineEnd)` из `packages/site-adapters/src/php-config.ts` подходит без изменений |
| TLS-ключ БД | `DB_SSL_KEY`, `DB_SSL_CERT`, `DB_SSL_CA` | то же; пустые значения отсеивает `MIN_SECRET_CHARS` |
| Пароль Redis, Memcached | `CACHE_PASSWORD` | то же; строка `//define(...)` в комментарии — шаблон её найдёт, значение `secret` безвредно |
| Секретов вроде солей WordPress в файлах нет | — | соль шифрования — в базе: `oc_setting.config_encryption` |
| Лицензионные ключи ядра | нет | у модулей — в `oc_setting` или своих файлах, единого места нет |

Все остальные секреты лежат в базе (раздел 6.4). Пароль в `DB_PASSWORD` пишется после `html_entity_decode` веб-установщика и `addslashes`; значение с `'` экранировано — `php-config.ts` читает по правилам PHP.

### 4.3. Запуск с другой конфигурацией

| Способ | Работает | Заметка |
|---|---|---|
| Переменные окружения | нет | ядро не читает env; `Dockerfile` в корне OC 4 задаёт `DIR_*` как ENV, но кода, читающего их, нет — `COPY configs` ссылается на отсутствующий каталог |
| Перекрывающий файл, include | нет | `index.php` делает `require_once('config.php')` относительно cwd |
| `auto_prepend_file` с `define` | технически да | повторный `define` в настоящем `config.php` даст E_WARNING (PHP 8) — не проверено |
| **Замена файлов** | да | как `wp-config.php`: `generatedFiles` пишет `config.php` и `<admin>/config.php`, читающие файл настроек `PREVIEW_SETTINGS_PATH` |

Генерируемые файлы отличаются по веткам (набор констант из 4.1) и зависят от имени папки админки, значит `previewRecipe(site)` берёт её из `SiteFacts.extras`. `PreviewRecipe.generatedFiles` документирован как «одинаковые для всех предпросмотров стека» (`packages/domain/src/preview/recipe.ts:143`); путь `<admin>/config.php` это нарушает.

`DIR_STORAGE` в предпросмотре — внутри дерева, `vendor` обязан там быть, иначе `requiredPaths` отдаёт `no_core`.

### 4.4. Адрес сайта

| Где | Что | Как перекрыть |
|---|---|---|
| `config.php` | `HTTP_SERVER`, `HTTPS_SERVER` — база всех ссылок витрины магазина 0 | генерируемый файл |
| `<admin>/config.php` | `HTTP_SERVER`, `HTTP_CATALOG` — редиректы админки, `<base>`, менеджер файлов | генерируемый файл |
| `oc_store.url`, `oc_store.ssl` (3.x), `url` (4.x) | адреса магазинов 1…N; выбор магазина по `HTTP_HOST` + каталогу (`oc-3.0.5.1/upload/catalog/controller/startup/startup.php:18,20`; `oc-4.1.0.4/upload/catalog/controller/startup/setting.php:15,20`) | на чужом хосте совпадения нет — показывается магазин 0 |
| `oc_setting.config_url`, `config_ssl` у `store_id > 0` | то же в настройках магазина | предпросмотр показывает только магазин 0 |
| `oc_setting.config_secure` (3.x) | ссылки по https | читается только в формах настроек (`admin/controller/setting/*`), на витрине нет |
| Тексты `*_description.description` | абсолютные URL `https://прод/image/catalog/…`: менеджер файлов строит `href` от `HTTPS_CATALOG` (`oc-3.0.5.1/upload/admin/controller/common/filemanager.php:8`), Summernote вставляет его как есть (`admin/view/javascript/summernote/opencart.js:76`) | картинки в копии ходят на прод; менять только фильтром вывода |
| `Host` запроса | используется для выбора магазина, ссылки строятся не от него | |
| `<base href>` | от `config_url` или `config_ssl` (`catalog/controller/common/header.php:18–29`) | генерируемый файл |

Ни редиректа на канонический адрес, ни `home`/`siteurl` как в WordPress в ядре нет: копия открывается на чужом адресе без правок базы. Редиректы на www или https живут только в `.htaccess` и в модулях (не проверено).

| Условие копии | Что нужно |
|---|---|
| https за шлюзом | `system/startup.php` принимает `X-Forwarded-Proto: https` (`oc-3.0.5.1/upload/system/startup.php:42`, тоже в 4.1); проверено чтением только для 3.0.5.1 и 4.1.0.4 |
| Подкаталог на проде (`/shop/`) | в копии — корень; абсолютные ссылки в текстах останутся |
| ЧПУ | правила из 1.4 в `web.configFiles`: `infra/wordpress/preview-apache.conf:5` не читает `.htaccess` |
| Запрет отдачи | `system/storage`, `*.twig`, `*.tpl`, `*.ini`, `*.log` — там же |
| Кеш | чистый `system/storage/cache/`; `image/cache/` создаётся сам, нужна запись в `image/` |
| cookie | `OCSESSID` OC 4 — `SameSite=Strict` (`config_session_samesite`, `opencart-en-gb.sql:2268`), OC 3 без атрибута; шлюз снимает только `Domain` (`apps/preview/src/gateway/headers.ts:124`). В межсайтовом iframe кабинета cookie не вернётся, корзина и вход в копии не работают. Лечится в копии: `config_session_samesite=None` + Secure, а для OC 3 — шлюзом (раздел 12, п. 15) |
| почта | см. 6.5 |

Префикс таблиц произвольный: `DB_PREFIX`; установщик заменяет `oc_` только при загрузке дампа, сторонние модули обязаны брать его из константы. `DB_PREFIX` пустым бывает (`siteDatabaseSettingsSchema` пустую строку принимает).

---

## 5. Где живёт то, что клиент хочет менять

| Что меняет клиент | Где живёт | Файлы или база | Как менять агенту |
|---|---|---|---|
| Товар: название, описание, SEO-поля | `oc_product_description` (`name`, `description`, `tag`, `meta_title`, `meta_description`, `meta_keyword`) по `language_id` | база | только база; на каждый язык своя строка |
| Товар: цена, остаток, артикул | `oc_product` (`model`, `quantity`, `price`, `status`, `image`, `sort_order`, `date_available`…; в OC 3 ещё `sku`, `upc`, `ean`, `jan`, `isbn`, `mpn`, в OC 4.1 они в `oc_product_code`), `oc_product_discount`, в OC 3 `oc_product_special` | база | база |
| Варианты, опции | `oc_product_option`, `oc_product_option_value`; 4.x `oc_product.master_id`, `variant`, `override`, `oc_product_code` | база | база, сложная связность |
| Атрибуты, фильтры | `oc_attribute*`, `oc_product_attribute`, `oc_filter*`, `oc_product_filter` | база | база |
| Категории | `oc_category`, `oc_category_description`, `oc_category_path` (денормализованный путь), `oc_category_to_store`, `oc_category_to_layout`, `oc_category_filter` | база | база; `category_path` пересчитывать |
| Страницы «О нас», «Доставка» | `oc_information`, `oc_information_description` (`title`, `description`, `meta_*`), `oc_information_to_store`, `oc_information_to_layout` | база | база |
| Статьи | 4.1: `oc_article`, `oc_article_description`, `oc_topic*`; ocStore: `oc_article*`, `oc_blog_category*`; в чистом OC 3 блога нет | база | база |
| Адреса ЧПУ | `oc_seo_url` (`store_id`, `language_id`, `query`, `keyword`; в 4.x `key`, `value`, `keyword`, `sort_order`), 2.3: `oc_url_alias` | база | база |
| Настройки магазина | `oc_setting` (`store_id`, `code`, `key`, `value`, `serialized`; JSON при `serialized=1`) | база | закрытый список `dbSettings` |
| Расстановка блоков | `oc_layout`, `oc_layout_route`, `oc_layout_module` | база | база |
| Настройки модулей | `oc_module.setting` — JSON (`module_id`, `name`, `code`, `setting`) и `oc_setting` с кодом `module_*` | база | база; HTML-модули хранят текст здесь |
| Баннеры, слайдер | `oc_banner`, `oc_banner_image` | база | база |
| Тексты интерфейса | файлы `catalog/language/<код>/**.php`, поверх них `oc_translation` | **и то и другое** | файл; но строка `oc_translation` важнее файла |
| Шаблон страницы | файл темы; поверх него `oc_theme.code` из «Дизайн → Редактор темы» | **и то и другое** | см. ниже |
| Логика | контроллеры, модели, OCMOD, события | файлы и база | см. ниже |
| Стили | `catalog/view/theme/<тема>/stylesheet/*`, `scss` | файлы | файл, скомпилированный CSS появится сам |
| Картинки | `image/catalog/**` | файлы, путь — в базе (`oc_product.image`) | добавить файл + запись в базе |

Порядок чтения шаблона (OC 3, `oc-3.0.5.1/upload/catalog/controller/event/theme.php`):

1. Для любой темы нужен `theme_<config_theme>_status`, иначе `exit('Error: A theme has not been assigned to this store!')` (`:6`). Папка: `config_theme`, при `default` — `theme_default_directory`.
2. Шаблон ищется в `DIR_TEMPLATE . <папка>/template/<route>.twig`, запасной — `default/template/`.
3. Если есть строка `oc_theme` для `(store_id, theme, route)`, её `code` **подменяет файл** (`:25`), через `html_entity_decode`. В OC 4 столбца `theme` нет: ключ `(store_id, route)`, есть `status`.
4. OCMOD: `system/library/template/twig.php` патчится `system/modification.xml` и берёт `DIR_MODIFICATION . 'catalog/view/theme/' . $filename . '.twig'`, если он есть.

В OC 4 — `oc_theme` тоже (`oc-4.1.0.4/upload/catalog/controller/event/theme.php:22`), плюс тема-расширение (`extension/<код>/catalog/view/template`), плюс OCMOD (`event/modification.view`).

Выгрузить `oc_theme` и `oc_translation` в файлы штатно нельзя. Статических шаблонов-элементов, как в MODX, нет. Правка темы агентом должна начинаться с проверки: нет ли строки в `oc_theme` для этого `route` и нет ли файла в `system/storage/modification/`.

Что менять кодом, а что базой:

| Код (git, `/release`) | База (план БД) |
|---|---|
| тема, стили, скрипты; контроллеры и модели расширений; файлы языка; `*.ocmod.xml` | товары, категории, страницы, ЧПУ, настройки, модули, раскладки, `oc_theme`, `oc_translation`, `oc_modification`, `oc_event` |

Текст в базе экранирован: `Request::clean` делает `htmlspecialchars(…, ENT_COMPAT, 'UTF-8')` для всего `$_POST` (`oc-3.0.5.1/upload/system/library/request.php:46`), модель пишет как есть, витрина выводит через `html_entity_decode` (`catalog/controller/product/product.php:259`). Значит `description` в базе — `&lt;p&gt;Текст&lt;/p&gt;`. Прямая запись без экранирования испортит страницы только частично: `html_entity_decode` пропустит сырой HTML, зато форма админки покажет его иначе. Модели сбрасывают кеш (`$this->cache->delete('product')`, `oc-3.0.5.1/upload/admin/model/catalog/product.php:137`); прямой SQL — нет, старые данные держатся до `cache_expire` = 3600 с.

---

## 6. База

### 6.1. Таблицы для запуска

Выведено чтением `startup/*`, `system/library/cart/*` и моделей, вызываемых на главной; запуском не проверено.

| Назначение | OC 3 | OC 4 — дополнительно или иначе |
|---|---|---|
| Запуск, адрес, настройки | `store`, `setting`, `language`, `currency`, `event`, `extension`, `seo_url`, `session` (структура), `api`, `api_ip`, `api_session` (структура) | `startup`, `cron`, `extension_install`, `extension_path`, `api_history` (структура) |
| Единицы | `length_class`, `length_class_description`, `weight_class`, `weight_class_description` | |
| Налоги, гео | `tax_class`, `tax_rate`, `tax_rate_to_customer_group`, `tax_rule`, `geo_zone`, `zone`, `zone_to_geo_zone`, `country` | `country_description`, `zone_description`, `address_format` |
| Клиентский каркас | `customer_group`, `customer_group_description`, `custom_field`, `custom_field_customer_group`, `custom_field_description`, `custom_field_value`, `custom_field_value_description`, `cart` (структура: `Cart\Cart` при создании выполняет `DELETE`), `customer_online` (структура) | |
| Вид | `layout`, `layout_route`, `layout_module`, `module`, `banner`, `banner_image`, `theme`, `translation` | |
| Статусы | `stock_status`, `order_status`, `return_action`, `return_reason`, `return_status`, `location` | `subscription_status` |

Если `oc_setting` без `theme_<тема>_status` — OC 3 падает на `exit` (раздел 5). Если нет `config_language`, `config_currency`, `config_layout_id`, `config_customer_group_id`, `config_theme`, витрина не собирается (вывод). Если `oc_event` пуст — расширения на событиях молча не работают; копировать.

### 6.2. Контент (строки копировать)

| Группа | Таблицы |
|---|---|
| Товары | `product`, `product_attribute`, `product_description`, `product_discount`, `product_filter`, `product_image`, `product_option`, `product_option_value`, `product_recurring`, `product_related`, `product_reward`, `product_special`, `product_to_category`, `product_to_download`, `product_to_layout`, `product_to_store` |
| OC 4 вместо и сверх | `product_subscription` вместо `product_recurring`; `product_code`, `identifier`; `oc_product_special` нет в 4.1.0.4 (скидки в `product_discount`) |
| Справочники | `attribute`, `attribute_description`, `attribute_group`, `attribute_group_description`, `filter`, `filter_description`, `filter_group`, `filter_group_description`, `option`, `option_description`, `option_value`, `option_value_description`, `manufacturer`, `manufacturer_to_store`, `recurring`, `recurring_description` |
| Категории | `category`, `category_description`, `category_filter`, `category_path`, `category_to_layout`, `category_to_store` |
| Страницы | `information`, `information_description`, `information_to_layout`, `information_to_store` |
| OC 4 CMS | `article`, `article_description`, `article_to_layout`, `article_to_store`, `topic`, `topic_description`, `topic_to_layout`, `topic_to_store`, `manufacturer_to_layout`, `subscription_plan`, `subscription_plan_description` |
| ocStore | `article`, `article_description`, `article_image`, `article_related`, `article_related_mn`, `article_related_product`, `article_related_wb`, `article_to_blog_category`, `article_to_download`, `article_to_layout`, `article_to_store`, `blog_category`, `blog_category_description`, `blog_category_path`, `blog_category_to_layout`, `blog_category_to_store`, `manufacturer_description`, `manufacturer_to_layout`, `product_related_article`, `product_related_mn`, `product_related_wb`, `shipping_courier`; в 4.1.0.4-Beta: `article_to_category`, `article_to_manufacturer`, `article_to_product`, `article_to_topic`, `topic_path` |

Всего для OC 3 около **87** таблиц со строками, для OC 4 и ocStore больше. Таблицы сторонних модулей и тем не перечислить: по умолчанию только структура, поэтому модули с собственным контентом в копии будут пустыми.

### 6.3. Персональные данные и журналы (только структура)

| Группа | OC 3 | OC 4 — сверх |
|---|---|---|
| Покупатели | `customer` (`email`, `telephone`, `password`, `salt`, `cart`, `wishlist`, `ip`, `token`, `code`), `address`, `customer_activity`, `customer_affiliate`, `customer_approval`, `customer_history`, `customer_ip`, `customer_login`, `customer_online`, `customer_reward`, `customer_search`, `customer_transaction`, `customer_wishlist` | `customer_affiliate_report`, `customer_authorize`, `customer_token`, `gdpr` |
| Заказы | `order` (ФИО, адреса, телефон, `ip`, `user_agent`, `comment`, `payment_custom_field`), `order_history`, `order_option`, `order_product`, `order_total`, `order_voucher`, `order_recurring`, `order_recurring_transaction` | `order_subscription`, `subscription`, `subscription_history`, `subscription_log`, `subscription_option`, `subscription_product` |
| Возвраты, отзывы | `return`, `return_history`, `review` (`author`, `text`) | `article_comment`, `article_rating`, `antispam` |
| Сессии, корзины | `session` (JSON сессии, в нём и данные покупателя), `cart`, `api_session` | |
| Коды | `coupon`, `coupon_category`, `coupon_product`, `coupon_history`, `voucher` (`to_email`, `from_email`, `code`), `voucher_history`, `voucher_theme` | |
| Файлы | `upload` (`name`, `filename`, `code`), `download`, `download_description` | |
| Администраторы | `user` (`email`, `password`, `salt`, `code`, `ip`) | `user_authorize`, `user_login`, `user_token` |
| Статистика, отчёты | `statistics`, `marketing`, `googleshopping_*` | `marketing_report`, `product_report`, `product_viewed`, `download_report`, `notification` |
| ocStore | `review_article`, `order_shipment`, `modification_backup` | |

### 6.4. Секреты

| Где | Ключи | Заметка |
|---|---|---|
| `oc_setting.config_encryption` | 1024 символа, `token(1024)` | ключ `Encryption` для платёжных модулей; `oc-3.0.5.1/upload/install/cli_install.php:222` |
| `oc_setting.config_mail_smtp_password` | + `config_mail_smtp_hostname`, `config_mail_smtp_username` | открытым текстом |
| `oc_setting.config_ftp_password` | + `config_ftp_hostname`, `config_ftp_username`, `config_ftp_port`, `config_ftp_root`, `config_ftp_status` | **OC 3**: доступ FTP сайта в базе (`opencart.sql:3309`); в OC 4 ключей нет |
| `oc_setting` с `code` `payment_*`, `shipping_*`, `fraud_*`, `captcha_*`, `advertise_*`, `feed_*`, `analytics_*` | в поставке 3.0.5.1 — 129 полей, похожих на секрет: `captcha_google_secret`, `fraud_maxmind_key`, `payment_alipay_merchant_private_key`, `payment_amazon_login_pay_access_secret`, `advertise_google_app_secret`, `advertise_google_cron_token`; в ocStore `payment_webmoney_wmr_secret_key`, `feed_yandex_market_secret_key`, `feed_unisender_key` | открытым текстом |
| `oc_setting` с произвольным `code` | **`yoomoney_kassa_password`**, `yoomoney_kassa_shop_id`, `yoomoney_wallet_password`, `yoomoney_wallet_account_id` (официальный модуль `yoomoney/cms-opencart3`, в архиве с 2022) | без префикса `payment_`: запрещающий список пропустил бы |
| `oc_api.key` | 256 символов + `oc_setting.config_api_id` | |
| `oc_module.setting`, `oc_event` | JSON модулей могут нести ключи | `scrub_secrets` нужен |
| `oc_modification.xml` | сторонний XML; бывают адреса и ключи проверки лицензий (не проверено) | |
| `oc_user.code`, `oc_customer.token`, `oc_customer.code`, `oc_user_token.code`, `oc_customer_token.code` | коды сброса | |

### 6.5. Как обезличить копию

Разрешающий список в формате `databaseCopyPolicySchema`:

| Таблица | Условие | Столбцы |
|---|---|---|
| Контент 6.2 и каркас 6.1 | все строки | по умолчанию `keep` |
| `setting` | `store_id` = `0`; `code` в списке `config`, `theme_*`, `module_*` (без секретов), `total_*`, `shipping_*` (по желанию), `dashboard_*`, `report_*`, `developer`, `currency_*`; `key` не `LIKE` секретным шаблонам и не в списке ниже | `value`: `scrub_secrets` |
| `user_group` | все | `keep`: нужны права пользователя платформы |
| `extension`, `extension_install`, `extension_path`, `event`, `startup`, `modification` | все | `modification.xml` по решению: без неё нет пересборки OCMOD |
| `user` | нет строк | пользователя платформы создаёт `content.access` |
| всё из 6.3 | структура | |

Ключи `config_*`, которые нельзя копировать: `config_encryption`, `config_mail_smtp_hostname`, `config_mail_smtp_username`, `config_mail_smtp_password`, `config_mail_alert_email`, `config_ftp_hostname`, `config_ftp_username`, `config_ftp_password`, `config_ftp_port`, `config_ftp_root`, `config_ftp_status`, `config_api_id`, `config_google_analytics`.

`overrides` копии:

| Ключ | Значение | Зачем |
|---|---|---|
| `config_email` | `admin@preview.invalid` | адрес владельца |
| `config_mail_engine` | OC 4: `''` — письма выключены (`catalog/controller/mail/order.php:347`); OC 3: оставить `mail` | OC 3 зовёт `new Mail(config_mail_engine)` без проверки, пустое значение ломает (`oc-3.0.5.1/upload/catalog/controller/mail/order.php:262`; выведено чтением) |
| `config_maintenance` | `0` | застрявшая пересборка на проде не должна закрыть копию |
| `config_session_samesite` | `None` (4.x) | cookie в iframe, раздел 12, п. 15 |
| `config_error_display` | `1` | ошибки видны агенту |
| `config_compression` | `0` | |

Нюансы копировщика:

- `random_password_hash` даёт 35 символов (`packages/site-connections/src/database-copy/mysql-copier.ts:457`), `oc_user.password` в OC 3 — `varchar(40)`, влезает; но `user` копировать и не нужно: товары не ссылаются на людей. `oc_review` пуста, средняя оценка считается подзапросом и даёт `NULL`.
- Статьи: `oc_article.author` (4.x) — текстовое имя автора, третье лицо; столбец `synthetic_name`, но он собирается из числового ключа, ключ есть (`article_id`).
- `oc_order`, `oc_customer` не нужны для запуска: корзина и оформление заказа в копии работают без них (не проверено запуском).
- Снимок: копировщик открывает `START TRANSACTION WITH CONSISTENT SNAPSHOT` (`mysql-copier.ts:564`); на MyISAM он ничего не даёт, таблицы OC 3 читаются без согласованности.
- Соединение копировщика читает `SET NAMES <charset>` из `SiteDatabaseSettings`: для OC 3 это `utf8`, при `utf8mb4`-таблицах 4-байтные символы, если они попали другим путём, потеряются.

### 6.6. Администратор в копии

| Ветка | `oc_user` | Хеш | Группа |
|---|---|---|---|
| OC 2.3, 3.0 | `user_id`, `user_group_id`, `username` (3–20), `password varchar(40)`, `salt varchar(9)`, `firstname`, `lastname`, `email`, `image`, `code`, `ip`, `status`, `date_added` | `sha1($salt . sha1($salt . sha1($password)))` (`oc-3.0.5.1/upload/install/cli_install.php:216`); вход сверяет SQL `SHA1(CONCAT(salt, SHA1(CONCAT(salt, SHA1('…')))))` или `md5` (`system/library/cart/user.php:43`) | `user_group_id = 1` (Administrator), `oc_user_group.permission` — JSON со списками `access` и `modify` |
| OC 4.x | без `salt`, `password varchar(255)` | `password_hash($password, PASSWORD_DEFAULT)` (`oc-4.1.0.4/upload/install/cli_install.php:375`); вход принимает также старый SHA1 с солью и `md5` с пересчётом (`system/library/cart/user.php:99`) | то же |

Пароль в OC 3.0.5.1 сверяется по значению из `Request::clean`, то есть экранированному (`oc-3.0.5.1/upload/admin/controller/common/login.php`, вызов `$this->user->login(...)` без `html_entity_decode`): хеш, посчитанный от сырого пароля с `& < > "`, не совпадёт. Паролю платформы — только `[A-Za-z0-9]`.

Вход платформы в копию — собственным файлом, запускаемым в контейнере (6.8): создать строку `oc_user`, напечатать `{ v, username, password }`.

### 6.7. Сессии

| Что | OC 3 | OC 4 |
|---|---|---|
| Движок | `session_engine = 'db'` (`system/config/default.php`, `catalog.php`) | `'db'` в `catalog.php`, `admin.php`; в `default.php` `'file'` |
| Таблица | `oc_session`: `session_id varchar(32)`, `data text`, `expire`; одна из двух таблиц InnoDB в поставке | то же, `data mediumtext` |
| Формат | JSON (`system/library/session/db.php`), не PHP-сериализация | то же |
| Что внутри | `user_id`, `user_token`, `customer_id`, `api_id`, корзина гостя, адреса оформления | то же |
| Cookie | `OCSESSID`, общая для витрины и админки на одном хосте | то же, плюс `admin_authorize`, `customer_authorize` |
| Чистка | `gc()` при создании: `session.gc_probability`, `session.gc_divisor`; срок `session.gc_maxlifetime` | `session_probability`, `session_divisor`, `config_session_expire` = 86400 |

Строки `oc_session` в копию не идут, таблица нужна пустая. API-сессии: `oc_api_session` (3.x); в 4.1 их нет, запрос подписывается.

### 6.8. CLI

Своей CLI, как WP-CLI, нет. Есть три файла:

| Файл | Что делает | Заметка |
|---|---|---|
| `install/cli_install.php` | установка | только при наличии `install/`; раздел 11 |
| `install/cli_cloud.php` (4.x) | установка облачной версии | |
| `cron.php` (4.x) | поднимает реестр, `config_store_id = 0`, предзапуски, затем контроллер `cron/cron` (задания `oc_cron`) | готовый образец запуска ядра из CLI (`oc-4.1.0.4/upload/cron.php:40`) |

Команды `recipe.content.access` и `objects` придётся делать собственным PHP-файлом, запускаемым `php /var/www/html/<файл>.php`: образ предпросмотра несёт только `wp` (`infra/preview/Dockerfile:76`).

---

## 7. Программный доступ

### 7.1. API ядра

| Ветка | Вход | Что умеет | Заметка |
|---|---|---|---|
| OC 3 | `POST index.php?route=api/login` с `username`, `key`, IP из `oc_api_ip`; ответ `api_token` — id сессии (`catalog/controller/api/login.php:21`) | `cart`, `coupon`, `currency`, `customer`, `order`, `payment`, `reward`, `shipping`, `voucher`: только оформление заказа из админки | товаров и страниц **нет** |
| OC 4.1 | запросы к `api/order`, `api/subscription` с `call`, `username`, `store_id`, `language`, `currency`, `time`, `signature` = base64 HMAC-SHA1 от строки маршрута, вызова, имени, `HTTP_HOST`, пути, магазина, языка, валюты, md5 тела, времени (±450 с); IP из `oc_api_ip` (`catalog/controller/startup/api.php:21`) | заказы и подписки | товаров и страниц **нет** |

Страница документации API называет инвентарь и ERP как примеры, но ресурсы не перечисляет; в коде контроллеров товаров в `catalog/controller/api/` нет. REST для контента нужно писать самим.

### 7.2. Маршрут вместо плагина

Любой файл контроллера вызываем по маршруту **без регистрации**: это главный аналог mu-плагина.

| Ветка | Файл | Класс | URL | Почему работает |
|---|---|---|---|---|
| OC 3 | `catalog/controller/raditi/content.php` | `ControllerRaditiContent` | `index.php?route=raditi/content/apply` | `Action` ищет файл по частям маршрута (`oc-3.0.5.1/upload/system/engine/action.php:23`) |
| OC 4.x | `catalog/controller/raditi/content.php` | `Opencart\Catalog\Controller\Raditi\Content` | `index.php?route=raditi/content.apply` | `Factory::controller` строит имя класса, `Opencart\Catalog` указывает на `DIR_APPLICATION` (`oc-4.1.0.4/upload/system/engine/factory.php:37–44`) |

Ограничения:

- `extension/<код>/…` в OC 4 **без** строки `oc_extension` (витрина) и `oc_extension_install` (админка) не загрузится: пространство имён регистрируется из базы (`catalog/controller/startup/extension.php`, `admin/controller/startup/extension.php`), поэтому кладём в `catalog/controller/`, а не в `extension/`.
- В режиме обслуживания OC 3 маршрут отсекается `startup/maintenance`, кроме `extension/payment*` и `api*`.
- Авторизацию пишем сами: подпись запроса, как `raditi-content.php`. Доступ к `$this->db`, `$this->cache`, моделям `catalog/` есть; админские модели (`admin/model/catalog/product.php`) в контексте витрины не загружаются.
- Проверки стороннего кода (firewall-модули) могут закрывать незнакомые маршруты — не проверено.

Отдельный файл, поднимающий ядро (образец, **не запускалось**):

```php
<?php // OC 3: raditi-cli.php в корне
define('VERSION', 'x');
require __DIR__ . '/config.php';
require DIR_SYSTEM . 'startup.php';          // без start(): без диспетчера
$db = new DB(DB_DRIVER, DB_HOSTNAME, DB_USERNAME, DB_PASSWORD, DB_DATABASE, DB_PORT);
$q  = $db->query("SELECT name FROM `" . DB_PREFIX . "product_description` WHERE product_id = 42");
$cache = new Cache('file', 3600);
$cache->delete('product');
```

Для OC 4 — образец `cron.php`: `Autoloader`, регистрация `Opencart\Catalog`, `Opencart\System`, `Registry`, `Config`, затем `new \Opencart\System\Library\DB(...)`. `system/startup.php` требует уже определённого `DIR_SYSTEM`, поэтому `config.php` нужен первым. `index.php` использует относительный `config.php` — вызывать из корня сайта.

Изменение через ядро, а не SQL: модели `admin/model/catalog/product.php` (`editProduct($product_id, $data)`) ожидают весь набор полей формы, а частичная правка стирает связанные строки: `editProduct` удаляет и вставляет заново `product_description`, `product_to_store`, `product_option`, `product_image`… (`oc-3.0.5.1/upload/admin/model/catalog/product.php:142–302`, `oc-4.1.0.4/…:245`). Для узких правок безопаснее прямой SQL с `html`-экранированием и `$cache->delete()`.

### 7.3. Модель расширений

| Механизм | Ветка | Где код | Где регистрация | Без браузера |
|---|---|---|---|---|
| Контроллер по маршруту | все | `catalog/controller`, `admin/controller` | нет | файл по FTP |
| Модуль | 2.x, 3.x | файлы вперемешку с ядром: `admin/controller/extension/module/x.php`, `catalog/controller/extension/module/x.php`, `…/view/…`, `…/language/…` | `oc_extension` (`type`, `code`), `oc_setting`, `oc_module`, `oc_user_group.permission` | файлы + SQL |
| Установочный пакет | 3.x | `*.ocmod.zip`: `upload/` → дерево, `install.xml` → `oc_modification` | `oc_extension_install`, `oc_extension_path`, `oc_modification` (`admin/controller/marketplace/install.php:82,237`) | файлы + SQL + пересборка |
| OCMOD | 2.x, 3.x, 4.1+ | XML: поиск и замена по файлам | `oc_modification.xml`, `system/*.ocmod.xml` | SQL или файл + пересборка |
| vQmod | все, отдельно | `vqmod/xml/*.xml` | нет | файл; кеш обновится сам при записи в `vqmod/` |
| События | 3.x, 4.x | любой контроллер | `oc_event` (`trigger`, `action`, `status`) | SQL |
| Автозапуск | 4.x | любой контроллер | `oc_startup`, `action` с префиксом `catalog/` или `admin/` (`catalog/controller/startup/startup.php`) | SQL |
| Расширение | 4.x | `extension/<код>/…`, `install.json` | `oc_extension_install`, `oc_extension_path`, `oc_extension` | файлы + SQL |
| Тема | 2.x, 3.x | `catalog/view/theme/<код>/`, настройки `theme_<код>_*` | `oc_extension`, `oc_setting` | файлы + SQL |
| Тема | 4.x | расширение типа `theme` | как расширение | файлы + SQL |

OCMOD правит файлы при **пересборке**, а не на лету. Пересборка: `ControllerMarketplaceModification::refresh()` (`oc-3.0.5.1/upload/admin/controller/marketplace/modification.php:54`), `Opencart\Admin\Controller\Marketplace\Modification::refresh` (`oc-4.1.0.4/…:183`): требует права `modify`, включает `config_maintenance`, стирает `system/storage/modification/*`, применяет `system/modification.xml`, `system/*.ocmod.xml`, все `oc_modification.xml` со `status=1`, пишет файлы, возвращает прежний `config_maintenance` (строки 63–67, 440). Запуска из CLI нет. Сбой в середине оставляет магазин закрытым.

### 7.4. ionCube и закрытые модули

| Что | Сведение | Источник |
|---|---|---|
| Распространённость | модули под ionCube на рынке есть: страница модуля LiqPay на opencartforum говорит о закодированном файле админки «для лицензирования»; форум opencart.com обсуждает Loader и установку. Доля — не проверено | поиск, 01.11.2026 |
| Правило marketplace | опубликованного запрета не найдено, только мнения на форуме | forum.opencart.com |
| Loader | 15.5.1 от 18.09.2026; PHP 8.5 с 15.5.0; PHP 8.4 с 14.4.0; Linux x86-64, aarch64, musl | ioncube.com/loaders.php |
| Привязка | `--allowed-server [домены][@[IP]][{MAC}]`; при нарушении событие `no-permissions`; автор может заменить текст `--loader-event` | ionCube Encoder User Guide (через поиск) |
| Срок и файл лицензии | есть опции лицензирования; конкретные модули не проверены | там же, не проверено |
| Совместимость | Loader для PHP 8.4 исполняет файлы кодировщиков 8.2, 8.3 и 8.4; на другой версии PHP файл может не пойти (не проверено), поэтому `runtimeVersions` сайта с такими модулями надо держать как на хостинге | ioncube.com/loaders.php |
| ocStore | панель `domovoy` показывает версию Loader (`ocstore-3.0.3.7/upload/admin/controller/extension/dashboard/domovoy.php:239`) | код |

Что делать адаптеру:

| Шаг | Как |
|---|---|
| Узнать при импорте | искать признак в `.php` при обходе и записывать в `extras`; без образца признак не утверждён |
| Запуск в предпросмотре | Loader в образе нужной версии PHP; EULA прочитать до этого |
| Привязка к домену | адрес копии другой, модуль упадёт; лечится только продавцом; в предпросмотре показать понятную причину вместо `Site error` |
| Модель | закодированный файл агенту бесполезен и не должен идти в рабочий набор |
| Сканер секретов | закодированный файл даст ложные срабатывания `gitleaks` высокой энтропии (не проверено), а `publicOriginals` его не снимет |

---

## 8. Админка

### 8.1. Вход

| Что | OC 2.3, 3.0 | OC 4.1 |
|---|---|---|
| Путь | `/admin/`, переименовывается вручную (2.3 этого отчёта) | то же; в OC 4 кнопкой `common/security.admin` |
| Точка | `admin/index.php`; маршрут `common/login` | то же; отправка на `common/login.login&login_token=<token>` |
| Форма | `<form action="…route=common/login" method="post" enctype="multipart/form-data">`, **без id** (`admin/view/template/common/login.twig:22`) | `#form-login`, `data-oc-toggle="ajax"` (`login.twig:11`) |
| Логин | `#input-username`, `name="username"` | то же |
| Пароль | `#input-password`, `name="password"` | то же |
| Кнопка | `button[type="submit"]`, текст `Login` / `Войти` / `Вхід` | то же |
| CSRF | нет; токен появляется после входа | `login_token` в query, живёт в сессии (`login.php:46`) |
| Перенаправление | `<input type="hidden" name="redirect">` из запрошенного маршрута, значение должно начинаться с `HTTP_SERVER` (`login.php:17`) | **нет**: всегда `common/dashboard` (`login.php:109`) |
| Успех | 302 на `…&user_token=<32 символа>` | JSON `{"redirect": "…"}`, переход делает JS |
| Ошибка | `.alert-danger` | JSON `{"error": "…"}`, `.alert-danger` |
| Попытки | `config_login_attempts` = 5, блокировка на час (`login.php:96`); счётчик админов лежит в `oc_customer_login`, `email` = логин (`admin/model/user/user.php:109,119`) | счётчика в `common/login.php` нет |
| Капча | в ядре нет | в ядре нет |
| Двухфакторная | в ядре нет | `config_user_2fa`: код на почту, `common/authorize`, cookie `admin_authorize`, `oc_user_authorize`, срок `config_2fa_expire` = 90 дней (`startup/authorize.php:35,39`) |

Селекторы для `BrowserSignInForm`: логин `#input-username`, пароль `#input-password`, кнопка `#form-login button[type="submit"]` (OC 4), `form[action*="common/login"] button[type="submit"]` (OC 3). На OC 3 единого `#form-*` нет, и тема админки может подменять шаблон (не проверено).

Без входа **любой** маршрут отдаёт форму входа с кодом 200 **по тому же адресу**: `startup/login.php` делает `return new Action('common/login')` (`oc-3.0.5.1/upload/admin/controller/startup/login.php:16,21`; `oc-4.1.0.4/…:39,53`), редиректа нет. При просроченном токене — то же, с `error_token`. Проверка `isSignInPage(path)` по адресу здесь не работает: признак — наличие формы на странице либо отсутствие `user_token` в адресе.

### 8.2. `user_token`

Всё после входа требует `user_token=<32 символа>` в query и равенства значению в сессии (`startup/login.php`). Токен:

- попадает в каждый адрес админки, в `href` всех ссылок страницы, в `Referer`, в логи, в наблюдение агента;
- живёт в сессии, не в cookie, поэтому GET без него не вернёт ничего, кроме формы входа;
- заменяет CSRF: форм с отдельным токеном нет;
- `editUrl` с ним нельзя сохранять (`BrowserCheckpointRef.editUrl`, `feed.result.objects`): это секрет и он протухает с сессией; без него адрес не открывается.

В OC 2.3 тот же параметр называется `token`.

### 8.3. Экраны

Формат: `/<admin>/index.php?route=<маршрут>&user_token=<t>[&id]`. В OC 4.0.0–4.0.1 вместо `.` — `|`. Форма редактирования OC 4 создаёт новый объект тем же маршрутом без id.

| Объект | Список | Редактор OC 2.3, 3.0 | Редактор OC 4.0.2+ | Сохранение OC 3 | Сохранение OC 4 |
|---|---|---|---|---|---|
| Товар | `catalog/product` | `catalog/product/edit&product_id={id}`, новый `catalog/product/add` | `catalog/product.form&product_id={id}` | POST на тот же адрес, 302 в список | XHR POST `catalog/product.save`, JSON `{"success"}` |
| Категория | `catalog/category` | `catalog/category/edit&category_id={id}` | `catalog/category.form&category_id={id}` | так же | `catalog/category.save` |
| Страница | `catalog/information` | `catalog/information/edit&information_id={id}` | `catalog/information.form&information_id={id}` | так же | `catalog/information.save` |
| Производитель | `catalog/manufacturer` | `catalog/manufacturer/edit&manufacturer_id={id}` | `catalog/manufacturer.form&manufacturer_id={id}` | так же | `.save` |
| Статья | ocStore: `blog/article`; 4.1: `cms/article` | ocStore: `blog/article/edit&article_id={id}` | `cms/article.form&article_id={id}` | так же | `cms/article.save` |
| Баннер | `design/banner` | `design/banner/edit&banner_id={id}` | `design/banner.form&banner_id={id}` | так же | `.save` |
| Раскладка | `design/layout` | `design/layout/edit&layout_id={id}` | `design/layout.form&layout_id={id}` | так же | `.save` |
| Модуль | `marketplace/extension&type=module` | `extension/module/<код>&module_id={id}` | `extension/opencart/module/<код>&module_id={id}` | так же | `.save` |
| Медиа | кнопка в редакторе | `common/filemanager`, загрузка XHR `common/filemanager/upload&directory=` | `common/filemanager.upload` | | |

Закрыть и агенту, и вводу клиента (правила 1 и 4):

| Группа | Маршруты (префиксы, в OC 4 с методом через `.`) |
|---|---|
| Сводка | `common/dashboard`: виджеты `activity`, `customer`, `map`, `online`, `order`, `recent`, `sale`, `chart`; в `recent` имена покупателей |
| Заказы | `sale/order`, `sale/recurring`, `sale/return`, `sale/returns`, `sale/subscription`, `sale/voucher`, `sale/voucher_theme` |
| Покупатели | `customer/customer`, `customer/customer_approval`, `customer/customer_group`, `customer/custom_field`, `customer/gdpr`, `customer/address` |
| Отзывы и комментарии | `catalog/review`, `cms/comment`, `cms/antispam` |
| Пользователи | `user/user`, `user/user_permission`, `user/api`, `user/profile`, `common/profile` |
| Настройки | `setting/setting`, `setting/store`, `localisation/*` |
| Расширения | `marketplace/extension`, `marketplace/marketplace`, `marketplace/installer`, `marketplace/install`, `marketplace/modification`, `marketplace/event`, `marketplace/startup`, `marketplace/cron`, `marketplace/api`, `marketplace/opencartforum` (ocStore), `extension/payment/*`, `extension/shipping/*`, `extension/fraud/*`, `extension/opencart/payment/*`… |
| Код | `design/theme` (редактор пишет Twig в базу), `design/translation`, `design/seo_url` |
| Инструменты | `tool/backup` (скачивание всей БД), `tool/log`, `tool/upload`, `tool/upgrade`, `tool/notification`, `common/developer`, `common/security`, `search/search` (ocStore) |
| Отчёты, рассылка | `report/*`, `marketing/contact`, `marketing/marketing`, `marketing/coupon`, `marketing/affiliate` |
| Удаление и копирование | `*/delete`, `*.delete`, `*/copy`, `*.copy` |

Политика читает маршрут так же, как ядро: только из query; OC 3 перед вызовом выкидывает всё вне `[a-zA-Z0-9_/]` (`admin/controller/startup/router.php`, `sale/or.der` станет `sale/order`), OC 4 заменяет `|` и `%7C` на `.` (`system/framework.php`), метод отделяется по последней точке. `startup/permission` сверяет права по сырому маршруту и закрыт для мусорного адреса, но `requestDenied` не должен на это полагаться. Вход под покупателем — `customer/customer/login`, `customer/customer.login`, входит в группу покупателей.

Запрос `common/filemanager` открывает `image/catalog`, удаление — `common/filemanager/delete`, `common/filemanager.delete`.

Шапка OC 4 показывает `notification_total` и ссылки `tool/notification.info`; левое меню в 2.3–3.0 выводит доли заказов (без персональных данных, не проверено).

### 8.4. Кнопки

| Кнопка | Разметка OC 3 | Разметка OC 4 |
|---|---|---|
| Сохранить | `<button type="submit" form="form-product" data-toggle="tooltip" title="Save" class="btn btn-primary"><i class="fa fa-save"></i></button>` (`product_form.twig:6`) | `<button type="submit" form="form-product" data-bs-toggle="tooltip" title="Save" class="btn btn-primary"><i class="fa-solid fa-floppy-disk"></i></button>` |
| Назад | `<a title="Cancel" class="btn btn-default"><i class="fa fa-reply">` | `<a title="Back" class="btn btn-light">` |
| Удалить в списке | `<button type="button" form="form-product" formaction="{{ delete }}" title="Delete" class="btn btn-danger" onclick="confirm('…') ? …">`; нативный `confirm` (`product_list.twig:9`) | `<button type="submit" form="form-product" formaction="{{ delete }}" title="Delete" onclick="return confirm('…')" class="btn btn-danger">` |
| Копировать в списке | `form="form-product" formaction="{{ copy }}"` | то же |

| Текст `button_save` | Значение |
|---|---|
| en-gb | `Save` |
| ru-ru (ocStore 3.0.3.7) | `Сохранить` |
| uk-ua (ocStore 3.0.4.1b) | `Зберегти` |

**Доступное имя кнопки сохранения на OC 3 пусто.** Текста нет, только значок; Bootstrap 3.4.1 `fixTitle` переносит `title` в `data-original-title` и ставит `title=""`, а `admin/view/javascript/common.js:41` вызывает `.tooltip()` на готовности страницы. На OC 4 (Bootstrap 5.3.8) подсказка создаётся при наведении (`common.js:32`), до этого имя — `title`, после — `aria-label` (`bootstrap.bundle.js:5378`). `browserCommitAction(role, name)` на OC 3 получит `('button', '')`. Нужен иной признак: страница редактора и `button[type=submit][form^="form-"]:not([formaction])`; одного `form=` мало, им же помечены «Копировать» и «Удалить» в списке.

Кнопки публикации нет: у товара и страницы только `status` (`Enabled`/`Включено`), поле на вкладке «Данные»: `select#input-status` (OC 3), `input#input-status[type=checkbox]` (OC 4). Значит `browserCommitAction` возвращает только `save`.

Подтверждение успеха: `.alert-success`, `text_success` = `Success: You have modified products!`, `Настройки успешно изменены!`.

Редактор текста: Summernote (OC 3, `data-toggle="summernote"`), CKEditor (OC 4.1, `data-oc-toggle="ckeditor"`). Вкладки языков: `#language<id>` (OC 3), `#language-<id>` (OC 4). Вкладки формы OC 3: `#tab-general`, `#tab-data`, `#tab-links`, `#tab-attribute`, `#tab-option`, `#tab-recurring`, `#tab-discount`, `#tab-special`, `#tab-image`, `#tab-reward`, `#tab-seo`, `#tab-design`; OC 4: без `recurring` и `special`, с `#tab-subscription`, `#tab-report`. Поле скрыто, пока не открыта вкладка.

Сверять адресом id нельзя при создании: новый товар в OC 3 после сохранения уводит в список, новый id виден только в ссылке `edit` или в поиске; в OC 4 JSON ответа заполняет скрытое `#input-product-id`.

### 8.5. Проверка GET-запросом

| Способ | Запрос | Что видно | Изъян |
|---|---|---|---|
| Витрина | `/index.php?route=product/product&product_id={id}`, `…route=information/information&information_id={id}`, `…route=product/category&path={id}` | опубликованный объект; название в `<h1>` | `status=0` и удалённый — оба 404 (`catalog/controller/error/not_found.php:45`); тема может менять разметку |
| Форма админки | `/<admin>/index.php?route=catalog/product.form&user_token=<t>&product_id={id}`, HTML | `name="product_description[<язык>][name]" value="…"`, статус | нужен текущий `user_token`; разбор HTML; значение в `value` экранировано |
| Автодополнение | `catalog/product.autocomplete&user_token=<t>&filter_name=…` (OC 3: `catalog/product/autocomplete`), JSON | `product_id`, `name`, `model` | только по имени, без статуса, нужен токен |

`BrowserVerificationStep.path` статичен и строится из `ref`, а токена в `ref` быть не должно. REST и nonce, которыми пользуется WordPress (`admin-ajax.php?action=rest-nonce`, `rest_route`), здесь нет; получить токен GET-запросом нельзя. Нужна подстановка из адреса текущей страницы сессии.

### 8.6. Что опасно давать агенту сверх закрытия экранов

| Опасность | Почему |
|---|---|
| `design/theme` | запись произвольного Twig в базу на живом сайте; `autoescape` выключен (`twig.php`) |
| `common/filemanager` | загрузка в `image/catalog`; `config_file_ext_allowed` у клиента настраивается |
| `marketplace/installer` | установка произвольного кода |
| `tool/backup` | выгрузка всей базы одной кнопкой |
| Вход под покупателем | `customer/customer/login`, `customer/customer.login` открывают витрину от имени покупателя (`admin/controller/customer/customer.php:1162`, OC 4 `:860`) |
| Удаление | необратимо: корзины нет, ни у товара, ни у страницы; правило Б37 («в корзину») нечем исполнить, только `status = 0` |

---

## 9. Проверка сайта после выпуска

Страницы: `/`, по одной `product/category`, `product/product`, `information/information`; `recordPages` для созданных объектов:

```ts
{ product: `${front}index.php?route=product/product&product_id={id}`,
  category: `${front}index.php?route=product/category&path={id}`,
  information: `${front}index.php?route=information/information&information_id={id}` }
```

Схема `previewContentRecipe.pages` такие адреса принимает: `PATH` разрешает `?`, `&`, `=` (`packages/domain/src/preview/hostname.ts:123`). Работают при выключенном и включённом ЧПУ; с ЧПУ редиректа на красивый адрес нет.

`failureMarkers` (побайтово). Ядро `config_error_display = 1` по умолчанию (`opencart.sql:3380`, `opencart-en-gb.sql:2379`), поэтому `<b>Notice</b>:`, `<b>Warning</b>:`, `<b>Deprecated</b>:` на живых сайтах — обычное дело и маркером быть **не могут**.

| Маркер | Откуда |
|---|---|
| `<b>Fatal error</b>:` | PHP, при `display_errors` и `html_errors` |
| `<b>Parse error</b>:` | PHP |
| `<b>Fatal Error</b>:` | обработчик ядра: регистр `Error` другой (`system/framework.php`, `startup/error.php`) |
| `Error: Could not make a database link using` | `system/library/db/mysqli.php`; на OC 3 необработанное исключение |
| `Error: Could not load template ` | `system/library/template/twig.php:17` |
| `Error: Could not load model ` | `system/engine/loader.php:89` |
| `Error: Could not load controller ` | `system/engine/action.php` (OC 4) |
| `Error: Could not call ` | `system/engine/action.php` |
| `Error: A theme has not been assigned to this store!` | `catalog/controller/event/theme.php:6` |
| `Error: Invalid session ID!` | `system/library/session.php:69` |
| `500 - INTERNAL ERROR` | `<title>` страницы `error.html`, OC 4 при `config_error_display = 0` |
| `Internal Server Error!` | там же, `<h5>` |
| `PHP8.1+ Required`, `PHP8+ Required`, `PHP7.3+ Required`, `PH7.3+ Required`, `PHP5.4+ Required` | `exit` в `system/startup.php`; опечатка `PH7.3+` — ocStore 3.0.3.7 |
| `We are currently performing some scheduled maintenance` | режим обслуживания, статус 503; `Магазин временно закрыт` в русской сборке |
| `Site error: the ` | ionCube Loader — **не проверено** дословно |

На OC 4 при выключенном показе ошибка фатальна так: `header('Location: error.html')` (`oc-4.1.0.4/upload/catalog/controller/startup/error.php:67`), затем 200 — поэтому проверка выпуска должна идти за редиректом и читать тело (`SiteHttpResponse.location` есть).

| Файлы логов | Откуда имя |
|---|---|
| `system/storage/logs/error.log` | `config_error_filename` в базе; у OC 4 есть и `error_filename` в `system/config/default.php` |
| `system/storage/logs/ocmod.log` | пересборка OCMOD |
| `vqmod/logs/<день>.log` | vQmod |

При `DIR_STORAGE` вне дерева пути другие.

Кеш кода и как его сбросить:

| Кеш | Что держит | Сброс |
|---|---|---|
| OPcache | байткод | `opcache_invalidate`/`opcache_reset` из веб-контекста — через маршрут Радити (`SiteCodeCacheGateway`) |
| `system/storage/modification/` (OC 3), `extension/ocmod/` (OC 4.1) | копии файлов с правками OCMOD | **не сбрасывается, а пересобирается**: `marketplace/modification.refresh`; после выпуска файла, имеющего копию, код на сайте остаётся старым до пересборки |
| `vqmod/vqcache/`, `vqmod/mods.cache`, `checked.cache` | копии vQmod | пересобираются сами по `filemtime`; удаление `mods.cache` безопасно |
| `system/storage/cache/template/` | Twig | OC 3: ключ включает текст шаблона (`ArrayLoader::getCacheKey`, `vendor/twig/twig/src/Loader/ArrayLoader.php:64`), устаревания нет; OC 4: `auto_reload` true. Кнопка `common/developer.theme`, `common/developer/theme` |
| `system/storage/cache/cache.*` | данные: категории, валюты, языки, 1 час | удаление файлов или `$cache->delete('<ключ>')`; OC 4 `common/developer.cache` |
| `image/cache/` | ресайзы | по `filemtime` исходника сами (`catalog/model/tool/image.php`) |
| CSS из SCSS | `catalog/view/theme/<тема>/stylesheet/*.css`, `admin/view/stylesheet/*.css` | при `developer_sass = 1` только если файла нет; иначе на каждый запрос |
| Сторонние страничные кеши | модули | не проверено |

---

## 10. Лицензия и право

| Вопрос | Ответ | Источник |
|---|---|---|
| Ядро OpenCart | GPLv3 (`LICENSE.md`), `composer.json`: 4.1 `GPL-3.0-or-later`, 3.0 `GPL-3.0+`; автор — OpenCart Ltd | код |
| Хранить ядро, запускать копию | GPL не ограничивает запуск и хранение. Ядро и так часть дерева клиента. | текст GPLv3 |
| Базовый образ с ядром | можно, но не нужен: дерево несёт ядро. При раздаче образа третьим лицам — условия GPL об исходниках | вывод, юристу |
| Товарный знак | клаузул на странице Terms нет; не проверено | `opencart.com/index.php?route=cms/terms`, «Last Updated on 24 May, 2018» |
| ocStore | GPLv3 (`LICENSE.md` — неофициальный перевод на украинский); `SOURCE.txt` | код |
| OPENCART.PRO | условия на сайте не названы; PRO продаётся на opencartforum | opencart.pro |
| Платные расширения marketplace | Одна покупка — один сайт, поддомен считается отдельным сайтом, если автор не сказал иного; перепродавать скачанное нельзя | Terms |
| Копия на `site-…raditi-preview.ru` | про тестовые копии Terms не говорит; поддомен считается отдельным сайтом, значит предпросмотр с платным модулем формально второй сайт. **Вопрос юристу** | Terms |
| Запрет шифрованного кода на marketplace | только мнения на форуме, опубликованного правила не найдено — не проверено | forum.opencart.com |
| ionCube Loader | EULA на странице загрузки — ссылка, текст не прочитан; не проверено | ioncube.com/loaders.php |
| Передача кода расширений модели | платный код клиента уходит на Z.ai; лицензия конкретного модуля может запрещать. Вопрос юристу | вывод |
| Данные | заказы и покупатели магазина — ПД третьих лиц; правило 1 закрывает их полнее, чем у блога | CLAUDE.md |

---

## 11. Docker

| Образ | Состояние на 01.11.2026 | Заметка |
|---|---|---|
| `opencart/opencart` на Docker Hub | 404 | официального нет |
| `bitnami/opencart` | 404 (контроль: `bitnami/wordpress` — 200); каталога нет в `bitnami/containers` | снят |
| `bitnamilegacy/opencart` | 404 | |
| Прочие | `aamservices/opencart` (409 716 скачиваний), `vimagick/opencart`, `chrisss404/opencart`, `webkul/opencart`, `turnkeylinux/opencart` — сторонние, состав не проверен | не брать |
| `Dockerfile` в корне репозитория 4.1.0.4 | `php:8.2.11-apache`; **не собирается**: `docker-php-ext-install zip && && docker-php-ext-enable zip`, `COPY configs` на отсутствующий каталог, `COPY php.ini` | чтением |
| `tools/Dockerfile` | `php:8.2-apache`, `gd zip mysqli curl`, `a2enmod rewrite`, `wait-for-it` | рабочий образец набора |
| `docker-compose.yml` | сервисы `opencart`, `mysql:5.7`, `adminer`, `redis`, `memcached`, `postgres`; установка `cli_install.php` при первом старте, метка `install.lock` | рецепт стенда |

Наш образ: базовый `infra/preview/Dockerfile` (`wordpress@sha256`, MariaDB 11.8.9) для PHP 8.x годится; `wp-cli` не нужен. Для 2.3 и старых 3.0 нужен PHP 7.x: цель `site` с `BASE=wordpress:…php7.4-apache` — список `phpVersions` адаптера уже от 7.4. ionCube: `ioncube_loader_lin_<ver>.so` по одному на версию PHP, подключается через `php.ini` (точная строка на странице загрузки не показана; не проверено); поддержка PHP 8.5 с 15.5.0, сборки для x86-64, aarch64 и musl (15.5.1, 18.09.2026).

Автоматическая установка для стенда:

```sh
# OC 4.x: файлы конфигурации обязаны существовать и быть записываемыми
cp config-dist.php config.php; cp admin/config-dist.php admin/config.php
php install/cli_install.php install --username admin --password <hidden> \
  --email a@example.test --http_server http://site.test/ --language en-gb \
  --db_driver mysqli --db_hostname db --db_username root --db_password <hidden> \
  --db_database opencart --db_port 3306 --db_prefix oc_
# OC 3.0: php install/cli_install.php install --db_hostname … --db_prefix oc_ \
#         --db_driver mysqli --db_port 3306 --username admin --password … \
#         --email … --http_server http://site.test/
```

| Заметка | Где |
|---|---|
| Все таблицы удаляются и создаются заново | 4.x `cli_install.php`, `oc_db_schema()` |
| В 4.x пароль проверяется на 5–20 символов только при непустом `db_password` (логика «облако») | `cli_install.php` |
| В 3.0.5.1 `handleError` объявлен с пятью обязательными параметрами (`:50`); PHP 8 передаёт четыре, любое предупреждение даст `ArgumentCountError` | чтением, **запуском не проверено** |
| 3.0.5.1 `exec('chmod o+w -R …')` | `dir_permissions` |
| Демо-данные грузятся всегда: `opencart.sql`, `opencart-en-gb.sql` | |
| Языки установки 4.1: `en-gb`, `fr-fr`; русского нет | `upload/install/` |
| ocStore: `cli_install.php` есть в 3.0.3.7 и 4.1.0.4-Beta; 4.1 дописывает `OPENCARTFORUM_SERVER` | `diff` |
| Снимок: `mysqldump` после установки + архив дерева → фикстура, как `verify:site-import` | предложение |
| Русская админка на стенде: `ru-ru` брать из `ocstore-3.0.3.7/upload/admin/language/ru-ru` | |

---

## 12. Что сломает допущения, рождённые WordPress

| № | Допущение | На деле | Что трогает |
|---|---|---|---|
| 1 | Один `stack`, одна разметка | 2.3, 3.0, 4.0, 4.1 различаются маршрутами, классами, таблицами, токеном, формами, шаблонами | `siteStacks` (`packages/domain/src/ports/site-adapter.ts:26`) получает `opencart`, внутри ветвление по `SiteFacts.version`; форки — по `extras` |
| 2 | Код клиента лежит отдельно (`wp-content/`) | OC 2.3, 3.0: файлы расширений вперемешку с ядром в `admin/`, `catalog/`, `system/`; отличить можно только сверкой с поставкой | `agentWorkingSet`, `protectedPaths`, `publicOriginals` |
| 3 | Что в файле, то и исполняется | OCMOD и vQmod подменяют файл копией. Правка исходника без пересборки не видна, а копия порождается из базы | предпросмотр, `/release`, инструкции агенту; нужна операция «пересобрать модификации» |
| 4 | База — это контент, код — файлы | `oc_theme`, `oc_translation`, `oc_modification.xml`, `oc_event`, `oc_startup` — код в базе | план БД, дифф, «Отменить выпуск»: шаблон в `oc_theme` git не видит |
| 5 | Конфигурация одна (`wp-config.php`) | два файла, второй в переименуемой папке; абсолютные пути; набор констант зависит от ветки | `generatedFiles` не «одинаковы для всех предпросмотров стека» (`recipe.ts:143`) |
| 6 | Кодировка в конфиге | нет, она в драйвере | `databaseSettings(read)`: читать `system/library/db/mysqli.php` |
| 7 | Транзакции | MyISAM в OC 2.3, 3.0, в ocStore: `CONSISTENT SNAPSHOT` и откат не работают | копировщик, плагин записи, сравнение-и-запись на проде; нужен `GET_LOCK` или `LOCK TABLES` |
| 8 | Разрешающий список короткий | около 87 таблиц в OC 3, больше в OC 4 и ocStore | `databaseCopyPolicySchema.tables.max(64)` (`recipe.ts:246`), `requiredPaths.max(64)` хватает |
| 9 | Адрес редактора — постоянная ссылка | `user_token` в адресе: секрет и живёт в сессии | `BrowserCheckpointRef.editUrl`, `browser_checkpoints`, лента, журналы, наблюдение агента. Нужна чистка адресов на границе и `editUrl` без токена с подстановкой при открытии |
| 10 | Вход узнаётся по адресу | форма показывается на любом маршруте с кодом 200 | `BrowserSignInForm.isSignInPage(path)` (`site-adapter.ts:319`): нужен признак по странице |
| 11 | После входа можно уйти куда надо | OC 4 ведёт на `common/dashboard` с заказами, диплинка нет; без адреса с токеном агенту некуда идти | `pageDenied` + `startPath`: нужна подмена цели редиректа с сохранением токена либо редирект в воркере |
| 12 | Есть REST и nonce | нет ни того, ни другого, токена GET-ом не получить | `browserVerification`: шаг не может взять токен; нужен `{ fromSessionUrl: 'user_token' }` или разбор публичной страницы |
| 13 | Кнопка имеет имя | значок без текста; OC 3 обнуляет `title` | `browserCommitAction(role, name)` |
| 14 | Есть публикация, черновик, корзина | только `status`; удаление окончательное; ревизий нет | `browserObjectStatuses` пригоден частично, `browserCheckpointKinds = ['post']` (`checkpoint.ts:19`) нужны `product`, `information`, `category`; `dbJournalKinds` `post_trash`; `FeedObjectKind`; Б37 |
| 15 | cookie сайта в iframe не важны | корзина и вход живут на `OCSESSID`: OC 4 `SameSite=Strict`, OC 3 без атрибута (браузер считает Lax). В межсайтовом iframe кабинета они не отправятся. Шлюз снимает только `Domain` (`apps/preview/src/gateway/headers.ts:124`) | шлюз должен переписывать `SameSite=None; Secure; Partitioned` сайту или предпросмотр открывать вне iframe |
| 16 | `.htaccess` не нужен | ЧПУ, запрет `system/storage`, `*.twig`; редиректы клиента. Импорт его отбрасывает (`phpServerConfigFiles`), Apache предпросмотра его не читает (`infra/wordpress/preview-apache.conf:5`) | свой `preview-apache.conf`; файл `.htaccess` клиента читать как данные и показывать отличия |
| 17 | Всё нужное лежит в папке сайта | `DIR_STORAGE` может быть вне docroot, а внутри него Twig | импорт по FTP, `requiredPaths`, выпуск |
| 18 | Экран админки один на сайт | несколько магазинов (`oc_store`), языков (`oc_language`), `*_to_store`, ЧПУ на магазин и язык | `content_update` — «заголовок, текст, отрывок» одной записи (`db-plan.ts`); у товара N строк описаний и десятки полей |
| 19 | Текст в базе — HTML | HTML экранирован (`&lt;p&gt;`) | плагин записи, показ значений в окне `/release`, `display` в `DbSetting` |
| 20 | Секреты узнаются по имени настройки | `code` произвольный, значения открыты, есть FTP-доступ в `oc_setting` | только разрешающий список по `code` и `key` |
| 21 | Прод не надо закрывать | пересборка OCMOD сама включает `config_maintenance`; сбой оставит закрытым | откат выпуска, проверка 503 |
| 22 | Ошибки на странице — авария | `config_error_display = 1` по умолчанию, `Notice` и `Warning` в HTML обычны | `failureMarkers` без них; фатальная ошибка OC 4 — редирект на `error.html` с 200 |
| 23 | Есть CLI (`wp eval`) | нет | `recipe.content.access`, `objects`: свой PHP-файл, `php` есть в образе |
| 24 | Сайт не пишет в свои исходники | `startup/sass` пишет `*.css` рядом со `*.scss` при запросе | `git status` предпросмотра даст изменения, которых агент не делал; поля `refreshCode` |
| 25 | Код можно прочитать | модули под ionCube нечитаемы и могут быть привязаны к домену (7.4) | предпросмотр на чужом домене, образ с Loader, `gitleaks`, агент не видит код |
| 26 | У расширения есть публичный оригинал | платные модули есть только у продавца; публичны лишь ядро (`github.com/opencart/opencart`, `ocStore/ocStore`) | `publicOriginals` — только ядро по версии |
| 27 | Импорт не трогает коммерческое | `system/storage/download/` — платные файлы клиента, `system/storage/upload/` — файлы покупателей, `system/storage/backup/` — дампы | `importRules` |
| 28 | Медиа — папка с датами | `image/catalog/` с ручными папками, ссылка на файл — в базе; `image/cache/` большой | `mediaRules.addOnlyPaths` → `image/catalog/raditi/`, `previewRecipe` |
| 29 | Просьбы клиента — про контент | владелец магазина чаще спрашивает о заказах и покупателях; правило 4 и §11 их закрывают, значит «сколько заказов за неделю» агенту не исполнить | ожидания клиента, тексты отказа |
| 30 | Доступ — логин и пароль | вход Б36 подходит; но 5 неудач на OC 3 закрывают вход на час для всех | Б36: не повторять ввод |

---

## 13. Что вернёт адаптер (сводка по порту `SiteAdapter`)

| Метод | OC 3 / ocStore 3 | OC 4 | Требует правки вне адаптера |
|---|---|---|---|
| `detect` | `index.php` → `VERSION`, `VERSION_CORE`; `extras.adminDir`, `extras.storageDir`, `extras.generation`, `extras.vqmod` | то же | нет |
| `importRules` | `exclude`: `/config.php`, `/*/config.php` (имя папки админки импорт не знает: он зовёт метод с `extras: {}`, `apps/core/src/site-provisioning/site-import.ts:484`), `/install/`, `/image/cache/`, `/system/storage/cache/`, `/system/storage/logs/`, `/system/storage/session/`, `/system/storage/upload/`, `/system/storage/download/`, `/vqmod/vqcache/`, `/vqmod/logs/`, `/vqmod/*.cache`, копии `config*.php` в корне и `<admin>/`; **не** `system/storage/vendor/`, **не** `system/storage/modification/` | то же плюс `/system/storage/backup/`, `/system/storage/marketplace/`; **не** `extension/ocmod/` | нет |
| `rootMarkers` | `['catalog', 'system', 'image', 'config.php']` | то же | |
| `configSecrets` | `DB_PASSWORD` из `config.php` | + `DB_SSL_*`, `CACHE_PASSWORD` | нет |
| `publicOriginals` | ядро: `raw.githubusercontent.com/opencart/opencart/<VERSION>/upload/<path>`, для ocStore — тег `ocStore/ocStore` | то же | нет |
| `agentWorkingSet` | `include`: `/catalog/view/theme/`, `/catalog/controller/extension/`, `/catalog/model/extension/`, `/catalog/language/`, `/admin/controller/extension/`, `/admin/model/extension/`, `/admin/view/template/extension/` | `/extension/` без `/extension/opencart/`, `/extension/ocmod/` | нет |
| `protectedPaths` | `config.php`, `<admin>/config.php`, `index.php`, `install/`, `system/engine/`, `system/framework.php`, `system/startup.php`, `system/storage/`, `image/cache/`, `vqmod/vqcache/`, `.htaccess` | `extension/ocmod/`, `extension/opencart/`, `catalog/view/template/` | нет |
| `mediaRules` | `addOnlyPaths: ['image/catalog/raditi/']`; расширения: `jpg`, `jpeg`, `png`, `gif`, `webp` — столько принимает менеджер файлов (`admin/controller/common/filemanager.php`) | то же плюс то, что разрешено в его списке (`:315`) | нет |
| `databaseSettings` | `DB_PREFIX`; `charset` из `mysqli.php`: `utf8`; `collation: null` | `utf8mb4` | нет |
| `previewRecipe` | `requiredPaths`: `index.php`, `system/startup.php`, `system/framework.php`, `system/storage/vendor/autoload.php`, `catalog/controller/common/home.php`; `runtimeVersions` по `VERSION`: 3.0.5.x — 8.1+, 3.0.3.6–3.0.4.1 — 7.4…; `web` с конфигом Apache; `content.pages` | OC 4: 8.1+ | `recipe.ts`: комментарий о `generatedFiles`, образ с ionCube |
| `databaseCopyPolicy` | 6.5 | 6.5 | `tables.max(64)` → поднять; обработка `user` не нужна |
| `dbOperationKinds` | `content_update`, `option_update`, `post_create`; `schema_migration` только по новому плагину | то же | схема операции: мультиязычные поля, не один «заголовок» |
| `dbSettings` | `config_name`, `config_meta_title`, `config_meta_description`, `config_telephone`… | то же | `DbSetting.option` — ключ `oc_setting.key` |
| `browserRequestDenied`, `browserTaskPolicy` | 8.3 | 8.3 | `startPath` с `user_token` невозможен; `isSignInPage` |
| `browserCheckpointOf` | `route=catalog/product/edit&product_id=`, `catalog/information/edit`, `catalog/category/edit` | `.form` | `browserCheckpointKinds`, `editUrl` без токена |
| `browserCommitAction` | по селектору, не по имени | `name` ∈ `Save`, `Сохранить`, `Зберегти` | порт |
| `browserVerification` | витрина + форма админки | то же | подстановка токена |
| `browserGuide` | вкладки, языки, значок без подписи, `confirm()` | то же | нет |
| `verify` | раздел 9 | раздел 9 | нет |
| `createCodeCache` | маршрут Радити: `opcache_invalidate`, удаление `cache.*`, пересборка модификаций | то же | порт `SiteCodeCacheGateway` не знает пересборку |

Вход в контент: нового вида доступа `wp` нет, `siteAccessKinds` (`site-adapter.ts:95`) нужен `opencart` или общий `site_plugin`.

---

## Источники

Все проверены 01.11.2026.

| Что | URL |
|---|---|
| Код OpenCart, теги и ветки | https://github.com/opencart/opencart (3.0.5.1, 4.1.0.4, 4.2.x.x, 2.3.0.2) |
| Выпуски OpenCart | https://github.com/opencart/opencart/releases |
| Загрузка OpenCart | https://www.opencart.com/index.php?route=cms/download |
| Документация, требования | https://docs.opencart.com/getting-started/system-requirements.md |
| Документация, API | https://docs.opencart.com/admin-interface/system/users/api.md |
| Условия opencart.com | https://www.opencart.com/index.php?route=cms%2Fterms |
| Код ocStore | https://github.com/ocStore/ocStore (v3.0.3.7, v3.0.4.1b, 3.0.x.x, 3.0.5.0-Beta, 4.1.0.4-Beta), https://github.com/myopencart/ocStore (v2.3.0.2.4) |
| Сайт и загрузки ocStore | https://ocstore.com/, https://ocstore.com/downloads/ |
| Файлы ocStore на форуме | https://opencartforum.com/en/files/category/88-ocstore |
| OPENCART.PRO | https://opencart.pro/, https://opencart.pro/reliz/, https://github.com/BuslikDrev/OpenCart.CMS-2.3.0.2.6, https://github.com/ocshop/ocshop |
| vQmod | https://github.com/vqmod/vqmod (тег v2.6.6-opencart) |
| Модуль ЮKassa | https://github.com/yoomoney/cms-opencart3 |
| Доля | https://w3techs.com/technologies/details/cm-opencart, https://w3techs.com/technologies/segmentation/tld-ru-/content_management, https://itrack.ru/research/cmsrate/, https://2ip.io/analytics/top-cms/ocstore/ (503 при прямом запросе) |
| ionCube | https://www.ioncube.com/loaders.php, https://www.ioncube.com/sa/USER-GUIDE.pdf (через поиск) |
| Docker Hub | https://hub.docker.com/v2/repositories/bitnami/opencart/ (404), https://hub.docker.com/v2/repositories/bitnami/wordpress/ (200, контроль), https://hub.docker.com/v2/repositories/opencart/opencart/ (404) |
| Споры о шифрованных модулях | https://forum.opencart.com/viewtopic.php?t=226085 (мнения, не правило) |

Не удалось подтвердить: распределение версий в России; верхнюю границу PHP для 3.0.3.x и 2.3; версии MySQL и MariaDB в документации; русскую сборку ocStore 3.0.4.1; дословный текст ошибок ionCube; поведение любых команд и страниц запуском — ничего не запускалось.
