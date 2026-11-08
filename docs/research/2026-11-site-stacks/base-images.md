# Базовые образы предпросмотра для WordPress, 1С-Битрикс, Joomla, MODX и OpenCart

Дата: 01.11.2026. Дерево: `raditi-stacks`, ветка `feat/site-stacks` (`c811abf1`). Код продукта не менялся.

Что значат пометки: **замер** — сделано здесь на прототипе; **документ** — первичный источник; **вывод** — моё заключение, проверкой не подтверждено. Замеры шли на arm64 (Colima, 4 vCPU, Docker 29.5.2, `runc` и `runsc`). amd64 не запускался: проверено только наличие пакетов.

Файлы прототипа и журнал матрицы — `scripts/base-images-proto/`. Образы, контейнеры и тома прогона удалены из Colima; в кеше сборки Colima осталось около 1,2 ГБ, чистить его целиком я не стал, чтобы не задеть чужой кеш.

## 0. Итог

1. **Базовый образ — `debian:trixie-slim` с PHP из репозитория Sury, а не `php:*-apache`.** Один Debian на все версии PHP с 5.6 по 8.5, amd64 и arm64, сборка без компиляции. Официальные образы 5.6–7.2 с нынешним `site` несовместимы: под их Debian нет MariaDB 11.8.9, на stretch не запускается Node 26, а `apt` на stretch и buster мёртв.
2. **Один универсальный образ на версию PHP.** 12 образов вместо 60. Различия стеков уходят в рецепт адаптера: Apache — через `configFiles`, PHP — через `PHP_INI_SCAN_DIR`. Менять формат `PREVIEW_SITE_IMAGES` и схему `configFiles` не нужно.
3. **Размер падает примерно втрое:** 550–562 МБ без Node и WP-CLI (с ними около 700 МБ, оценка) против 1,5 ГБ у нынешнего (план 58, §6). В реестре на 12 версий — около 0,7 ГБ сжатого, общие слои переиспользуются.
4. **Прототип прошёл матрицу:** PHP 5.6, 7.4, 8.3 и 8.5 × `runc` и `runsc` — 50 расширений, ionCube, OPcache, System V IPC, `flock`, MariaDB 11.8.9, локали, read-only корень. Падений под gVisor нет.
5. **Настройки базы могут быть общими на все пять CMS.** Глобальные `sql_mode=''` и `innodb_strict_mode=0` безопасны для WordPress, Joomla и OpenCart (для MODX не проверено). Но сегодня их некуда передать: `init.sh` держит аргументы `mariadbd` жёстко (`infra/preview/init.sh:193-196`).

Что требует отдельного решения (подробно — §6, §9, §12):

- **Почта.** `sendmail_path` закрывает только `mail()`. Интернет предпросмотра открыт, поэтому SMTP из настроек CMS уходит наружу.
- **Версия PHP чужой CMS.** Сегодня её знает только плагин WordPress. Единственный точный способ при FTP — временная проба на хостинге, а это запись на прод вне `/release`.

## 1. Какой базовый образ

### Что есть на сегодня

Статус по php.net: поддерживаются 8.2 (до 31.12.2026), 8.3 (до 31.12.2027), 8.4 (до 31.12.2028), 8.5 (до 31.12.2029). Всё, что старше 8.2, снято с поддержки. PHP 8.6 — RC; выход намечен на 19.11.2026 (дату я подтвердил только по вторичным пересказам страницы подготовки).

Даты и архитектуры — API Docker Hub, 01.11.2026; Sury — индекс `packages.sury.org/php`, trixie, 26.10.2026.

| PHP | Тег Hub | Debian | Последняя сборка Hub | arm64 | MariaDB 11.8.9 под этот Debian | Node 26 | `apt` | Sury (trixie) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5.6 | `5.6-apache` | stretch | 25.01.2019 | да | нет | **не запускается (замер)** | 404 (замер) | 5.6.40-105 |
| 7.0 | `7.0-apache` | stretch | 31.12.2018 | да | нет | не запускается (тот же Debian) | 404 (вывод) | 7.0.33-93 |
| 7.1 | `7.1-apache` | buster | 28.11.2019 | да | нет | по документу да (glibc 2.28) | нет Release (замер) | 7.1.33-81 |
| 7.2 | `7.2-apache` | buster | 11.12.2020 | да | нет | по документу да | нет Release (вывод) | 7.2.34-66 |
| 7.3 | `7.3-apache` | bullseye | 18.03.2022 | да | да | да (вывод) | не проверял | 7.3.33-35 |
| 7.4 | `7.4-apache` | bullseye | 15.11.2022 | да | да | **да (замер)** | не проверял | 7.4.33-31 |
| 8.0 | `8.0-apache` | bullseye | 22.11.2023 | да | да | да (вывод) | не проверял | 8.0.30-25 |
| 8.1 | `8.1-apache` | trixie | 31.12.2025 | да | да | да | живой | 8.1.34-9 |
| 8.2 | `8.2-apache` | trixie | 31.10.2026 | да | да | да | живой | 8.2.35 |
| 8.3 | `8.3-apache` | trixie | 31.10.2026 | да | да | да | живой | 8.3.36 |
| 8.4 | `8.4-apache-trixie` | trixie | 31.10.2026 | да | да | да | живой | 8.4.27 |
| 8.5 | `8.5-apache-trixie` | trixie | 31.10.2026 | да | да | да | живой | 8.5.12 |
| 8.6 | `8.6-rc-apache-trixie` | trixie | 31.10.2026 | да | да | да | живой | 8.6.0~rc3 |

Проверено запросами к `archive.mariadb.org`: для 11.8.9 есть bullseye, bookworm и trixie; нет buster и stretch. Бинарный архив — только x86_64, поэтому arm64 он не спасает. Node: в `BUILDING.md` ветки 26 — glibc ≥ 2.28. На stretch (glibc 2.24) бинарник отказывает с `GLIBC_2.27 not found` (замер).

Отсюда главное: **`FROM ${BASE}` с `infra/preview/Dockerfile:48` не собирается для PHP 5.6–7.2.** Сборка падает уже в `infra/preview/Dockerfile:53-56`: buster и stretch там нет. На stretch в базе нет ни `setpriv`, ни `tini`, на buster нет `tini` (замер), а поставить их нечем: `apt` не работает.

Сам образ `wordpress` к этому не приведёт. План 58, §11 уже отметил, что у `wordpress:7.1.2` нет тегов PHP 7.4–8.1. Значит, часть версий из `packages/site-adapters/src/wordpress-preview.ts:18` сегодня собрать не из чего.

### Два пути

| | А. `debian:trixie-slim` + Sury | Б. `php:<v>-apache` + сборка расширений |
| --- | --- | --- |
| Версии | 5.6–8.5 одним способом | 8.1+ просто; 5.6–7.2 требуют своего Debian, своей MariaDB и обхода Node |
| ОС | одна на всех, общие слои | своя у каждой версии, слои не делятся |
| Исправления EOL | **есть**: у 5.6 — 264 патча, в журнале бэкпорт CVE-2026-109618 и -109619 от 21.10.2026 | образ заморожен на дате сборки: 5.6 — январь 2019 |
| arm64 | готовые пакеты | компиляция под эмуляцией или на arm-раннере |
| Сборка одной версии | 36–96 с (замер) | минуты компиляции на версию и архитектуру (вывод) |
| Поставщик | один мейнтейнер, сторонний репозиторий | Docker Official, но только для живых версий |
| Откат к прежней сборке | репозиторий держит только свежую версию: стабильность даёт наш digest | теги перезаписываются, digest остаётся |

**Рекомендация — путь А.** Его цена — зависимость от репозитория Sury (Ondřej Surý, Debian Developer, упаковщик PHP в Debian). На deb.sury.org условий коммерческого использования нет; сказано о пожертвованиях и о платном LTS вместе с Freexian. Риск снижает то, что собранные образы хранятся у нас по digest: если репозиторий исчезнет, работающие образы останутся. Для 8.x запасной вариант — путь Б.

Ключ репозитория закрепляется так же, как ключ MariaDB: отпечаток `15058500A0235D97F5D10063B188E2B695BD4743` (поле `Signed-By` в `Release`), проверка — в `infra/preview/site.test.mjs`.

### Какие версии собирать

Источники о хостингах:

- REG.RU: 5.2–8.5, плюс сборки `-bx-optimized` (5.3–7.4) и `-ioncube` (8.1–8.4).
- Timeweb: на Ubuntu 18.04 — 5.3–8.3, на Ubuntu 22.04 — 7.4–8.5.
- Beget: выбор версии на сайт, упоминается 8.5; полного списка в справке я не нашёл.
- W3Techs, 01.11.2026, все сайты мира: PHP 8 — 66,0%, 7 — 26,3%, 5 — 7,6%. Разбивки по младшим версиям на странице нет, российских чисел тоже.

**Список: 5.6, 7.0, 7.1, 7.2, 7.3, 7.4, 8.0, 8.1, 8.2, 8.3, 8.4, 8.5 — 12 образов.**

- **8.6** — после выхода и появления расширений: в Sury для 8.6 пока нет `apcu`, `imagick`, `memcached`, `redis`, `mcrypt`, `xmlrpc`, `imap`. ionCube для 8.5 вышел 12.03.2026, почти через 4 месяца после выхода 8.5.
- **5.2–5.5** не собираем. На Hub есть только 5.3–5.5 и только amd64, сборки 2015–2016 годов; в Sury их нет. Такой сайт идёт на 5.6 по ближайшей версии (логика — `wordpress-preview.ts:32-38`) и получает предупреждение `previewRuntimeDiffers`.

Требования CMS показывают, что старые версии нужны всем, кроме свежих установок:

| CMS | Минимум PHP по версиям CMS |
| --- | --- |
| Битрикс | 8.2 с 01.02.2026, рекомендуется 8.4+ (урок 2593). Старые установки держатся на старом PHP |
| Joomla | 6.x — 8.3; 5.4 — 8.1; 4.4 — 7.2.5, 3.x — 5.3.10 (две последние — только по стороннему справочнику) |
| MODX | 3.2+ — 8.1; 3.0 — 7.2; 2.x — 5.6 (`composer.json` ветки 2.x, документация) |
| OpenCart | master — 8.2 (`system/startup.php`); 4.0.2.3 — 8.0; 3.0.3.8 — 7.3; 2.3.0.2 — 5.4 (нужен `mcrypt`); 1.5.6.4 — 5.0 (нужен `mcrypt`) |

### Безопасность EOL в изоляции

Вывод: старый PHP в предпросмотре расширяет риск мало. Код сайта и так произвольный PHP от uid 33, уязвимость интерпретатора не даёт ему новых прав внутри контейнера. Граница — gVisor, uid и правила моста, а они от версии PHP не зависят. Снаружи предпросмотр закрыт шлюзом с билетом и проверкой `Host` (план 58, §10), анонимный посетитель к PHP не доходит.

Остаётся открытый интернет PHP (ответ владельца от 26.10.2026): старый `curl` или OpenSSL мог бы быть слабее. На пути А этого нет: PHP 5.6 под trixie работает с OpenSSL 3.5.7 и ходит на `https://example.com` (замер, код 200).

Свежий пример. 21.10.2026 Beget сообщил о двух критических уязвимостях PHP (оценка 9,2) в разборе `multipart/form-data` и `session.upload_progress`. В журнале Sury для 5.6 — бэкпорт из 8.2.35 от 21.10.2026 и `CVE-2023-0662` от 22.10.2026. Официальный образ 5.6 таких правок не получит. Что бэкпорт закрывает именно уязвимости из сообщения Beget, я не проверял: их номеров там нет.

## 2. Расширения и настройки PHP

### Что уже есть и чего не хватает

`wordpress:php8.3-apache` по точному Dockerfile `docker-library/wordpress`: `bcmath`, `exif`, `gd` (avif, freetype, jpeg, webp), `intl`, `mysqli`, `zip`, `imagick` и настройки OPcache; Apache — `rewrite`, `expires`, `remoteip`; ещё `ghostscript` и `libheif`.

Ключевая находка: **в нынешнем образе нет `pdo_mysql`**, а он обязателен для MODX. Нет и `soap`, `ldap`, `bz2`, `gmp`, `apcu`, `memcached`, `redis`, ionCube, `mcrypt`, `xmlrpc`, `sockets`, `gettext`, `calendar`, `xsl` и System V IPC (по Dockerfile).

Т — требует, Р — рекомендует или предлагает, О — есть в официальном образе CMS.

| Расширение | WordPress | Joomla | MODX | OpenCart | Битрикс | В прототипе |
| --- | --- | --- | --- | --- | --- | --- |
| `gd` с FreeType | О | Т | Т | Т | Т | да |
| `imagick` | О | О | Р | — | — | да |
| `mbstring` | база PHP | Р | Р | Т или `iconv` | Т | да |
| `iconv` | база PHP | — | Р | Т или `mbstring` | — | да |
| `intl` | О | О | Р | — | — | да |
| `mysqli` | О | Т (или `pdo_mysql`) | — | Т | Т | да |
| `pdo_mysql` | **нет** | О | **Т** | можно | — | да |
| `zip` | О | О | Т | Т | Т | да |
| `curl` | база PHP | — | Т | Т | сокеты | да |
| `dom`, `xml`, `simplexml`, `xmlwriter` | база PHP | Т | Т | Т | Т | да |
| `fileinfo`, `json`, `zlib`, `hash`, `openssl` | база PHP | Т | Т | Т | Т | да |
| `ldap` | — | О | — | — | Т (модуль AD/LDAP) | да |
| `amqp` | — | — | — | — | Т (сервер конвертации) | **не ставил** |
| `opcache` | О | О | — | — | Р | да |
| `apcu`, `memcached`, `redis` | — | О | — | — | кеш | да |
| `memcache` | — | — | — | — | кеш | не ставил |
| `bcmath`, `exif` | О | О | — | — | — | да |
| `bz2`, `gmp` | — | О | — | — | — | да |
| `soap`, `xmlrpc` | — | — | — | модули | модули | да |
| `mcrypt` | — | — | — | Т до 2.x | — | да |
| `sysvsem`, `sysvshm`, `sysvmsg`, `shmop`, `sockets` | — | — | — | — | — | да |
| `mysql` (старый) | — | — | — | — | старый Битрикс | да, только 5.6 |
| ionCube Loader | — | — | — | платные модули (вывод) | — | да |

Колонки сводят разные источники: для WordPress — Dockerfile образа, для Joomla — требования и Dockerfile образа, для MODX — документация и `composer.json`, для OpenCart — проверки инсталлятора, для Битрикса — урок 2593 и тест сервера.

Набор пакетов Sury на версию: `libapache2-mod-php${V}` и `php${V}-{cli,common,apcu,bcmath,bz2,curl,gd,gmp,imagick,intl,ldap,mbstring,mcrypt,memcache,memcached,mysql,redis,soap,xml,xmlrpc,zip,amqp}`.

Особые случаи:

- `php${V}-opcache` — кроме **8.5**: в 8.5 OPcache встроен, такого пакета нет, и установка падает (замер). OPcache при этом работает.
- `php${V}-json` — только для 5.6–7.4.
- `php${V}-mysql` у 5.6 несёт и `mysql_*`.

Весь этот список есть для всех 12 версий на trixie, amd64 и arm64: сверено по индексам Sury, пропусков нет.

### ionCube Loader

- **Версия:** 15.5.1 от 18.09.2026, Linux x86-64 и aarch64.
- **Файлы в архивах (проверено):** 5.6, 7.0, 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3, 8.4, 8.5. **Для 8.0 нет ни на одной архитектуре.**
- **Лицензия:** п. 2.1 и 2.3 разрешают распространять, в том числе в коммерческом продукте, если приложен текст лицензии. П. 2.2 запрещает выдавать за другой продукт, п. 3.1–3.2 запрещают анализ. Значит, `LICENSE.txt` кладём в образ.
- **Порядок:** README требует, чтобы Loader был первым расширением движка. `00-ioncube.ini` идёт раньше `opcache.ini` по алфавиту; в выводе `php -v` Loader стоит первым (замер на 8.3; загрузка подтверждена на всех четырёх версиях).
- **JIT:** с Loader JIT не включается: `JIT is incompatible with third party extensions that setup user opcode handlers. JIT disabled.` (замер). Для предпросмотра это не потеря: `opcache.jit` оставляем выключенным, иначе предупреждение пишется при каждом старте.
- **Загрузка:** адрес `downloads.ioncube.com/.../ioncube_loaders_lin_{x86-64,aarch64}.tar.gz` без версии, содержимое меняется с выпуском. Архив надо положить в своё хранилище и проверять по sha256. На 01.11.2026: x86-64 `739962bd012e77ee82bf01f77a9641f050e4be057f0a5d1a95fe59ce11fd62ba`, aarch64 `b091974aa80a76bd798d71fd5209797d93749b0be13eaff978a3dbe0106b9e1f`.
- **Вывод о совместимости:** сайтам с закодированными модулями близкой версии PHP мало. Файлы кодируются под линейки PHP (release notes: Loader для 8.4 читает файлы энкодеров 8.2 и 8.3). Сайт с ionCube на 8.0 в предпросмотре нужно вести на другую версию и предупреждать.

### Zend Guard

**Не включать.** Официальной страницы загрузки я не нашёл; по сторонним инструкциям файл `zend-loader-php5.6-linux-x86_64.tar.gz` выдаётся после входа в аккаунт Zend. Сборка только x86-64, поэтому образ 5.6 на arm64 разошёлся бы с amd64. PHP 7+ не поддерживается. Если такие сайты найдутся, адаптер отвечает `not_supported`, а Loader можно добавить отдельным образом только для amd64.

### Настройки: один базовый ini и файл стека

Настройки делятся на две части, и **для второй не нужно менять схему рецепта**:

1. **Базовый `raditi.ini` в образе** — то, что нужно всем.
2. **`raditi-stack.ini` из рецепта:** файл в `web.configFiles` (`packages/domain/src/preview/recipe.ts:63-70` — имя подходит под regex) и переменная `web.env.PHP_INI_SCAN_DIR=:/run/raditi/preview` (`recipe.ts:50`).

Пустой первый элемент значит «сначала каталог сборки, потом этот» (документ php.net). Переменная из `Env` контейнера доходит и до Apache, и до `docker exec` команд платформы, поэтому настройки одинаковы у веба и CLI. Проверено на 5.6, 8.3 и 8.5 под `runsc`: файл стоит в `php_ini_scanned_files()`, а на 5.6 `mbstring.func_overload=2` даёт `strlen("я") == 1`. Значение из `Env` до `docker exec` я проверил только на старте контейнера, не через `run-as.sh`.

Этот путь закрывает и настройки `PHP_INI_SYSTEM`, недоступные `php_value`. Опции `php_admin_*` из `preview-apache.conf:39-46` можно перенести в ini: блока для `php5_module` там всё равно нет.

Базовый ini. Строки с пометкой `*` в прототипе не стояли или стояли с другим значением:

```ini
; /etc/php/${V}/mods-available/raditi.ini, включается в apache2 и cli
; priority=10
short_open_tag = On                ; как сейчас: у образа wordpress нет php.ini, встроенное значение — On
date.timezone = Europe/Moscow      ; по умолчанию, файл стека задаёт значение сайта
default_charset = UTF-8
memory_limit = 512M
max_execution_time = 300
max_input_vars = 10000             ; проверка Битрикса
post_max_size = 32M                ; * не больше LimitRequestBody 33554432 (preview-apache.conf:21)
upload_max_filesize = 32M          ; *
upload_tmp_dir = /tmp
sys_temp_dir = /tmp
session.save_path = /tmp           ; у Debian /var/lib/php/sessions, а корень только на чтение
session.gc_probability = 1         ; * у Debian 0: там чистит cron
session.use_trans_sid = 0
output_buffering = 0               ; * у Debian 4096; Joomla рекомендует выключить
sendmail_path = /usr/local/lib/raditi/no-sendmail
expose_php = Off
display_errors = Off
log_errors = On
error_log = /dev/stderr            ; * в прототипе /proc/self/fd/2
pcre.backtrack_limit = 1000000     ; * урок Битрикса
pcre.recursion_limit = 14000       ; * урок Битрикса
realpath_cache_size = 4096k        ; * урок Битрикса
opcache.enable = 1
opcache.enable_cli = 0
opcache.memory_consumption = 128
opcache.validate_timestamps = 1
opcache.revalidate_freq = 0        ; preview-apache.conf:35-38
opcache.lockfile_path = /tmp
```

Осторожно с миграцией: Debian поставляет `php.ini` из `php.ini-production` с `short_open_tag = Off`, `output_buffering = 4096`, `session.gc_probability = 0` (замер), а `docker-library` не ставит `php.ini` вовсе. Без строк выше темы WordPress на коротких тегах сломаются сразу после перехода.

Файл стека:

| Стек | Что пишет `raditi-stack.ini` |
| --- | --- |
| Битрикс | PHP < 8 и `main` < 20.100.0: `mbstring.func_overload=2`, `mbstring.internal_encoding=UTF-8` (урок 2593); сайт в cp1251: `default_charset=windows-1251` (вывод). Новый Битрикс — ничего сверх базового |
| Joomla, MODX, OpenCart | по умолчанию ничего |
| Все | `date.timezone` сайта и `short_open_tag`, если они известны от пробы (§9) |

## 3. Один образ на версию или стек × версия

| | Универсальный | Стек × версия |
| --- | --- | --- |
| Образов | 12 | 5 × 12 = 60, часть комбинаций бессмысленна |
| Размер одного | 550–562 МБ (замер, без Node и WP-CLI) | столько же: расширения весят единицы МБ |
| Сжато | 122–126 МБ (замер) | столько же |
| Общие слои | 77,2 МБ сжатых (замер, 5.6 и 8.3); на версию около 45 МБ сверху | те же |
| Реестр | около 0,7 ГБ на 12 версий (вывод: 77 + 40 на Node + 12 × 45) | заметно больше, сильно зависит от общих слоёв |
| Диск хоста предпросмотров | около 2,1 ГБ на все версии (вывод, без сжатия) | заметно больше |
| Сборка | 96 с первая, 36–58 с следующие (замер); 12 версий подряд — 8–12 минут | кратно больше |
| Что меняется при добавлении CMS | только рецепт адаптера | новые образы и правка матрицы |

Сравнение с нынешним: `wordpress:7.1.2-php8.3-apache` — 1,12 ГБ без сжатия и 267–275 МБ сжатым; с MariaDB и Node — около 1,5 ГБ (план 58, §6). Основной прирост там, видимо, библиотеки ImageMagick, `ghostscript` и `libheif` (вывод). `ghostscript` нужен только для превью PDF, в прототипе его нет: если он понадобится, это отдельный пункт.

**Выбор — универсальный.** Разница между стеками оказалась только в настройках, а они приходят рецептом. Стоимость хранения близка к нулю: контейнерный реестр GitHub пока бесплатен (документ), а в своём реестре это меньше 1 ГБ. Довод против — большая поверхность расширений — в предпросмотре ничего не стоит: неиспользуемые `.so` безвредны.

Матрица публикации — раздел 10.

## 4. Apache или nginx

**Apache, `mpm_prefork`, `mod_php`.** Урок Битрикса называет Apache основным, nginx требует ручной настройки. Joomla, MODX и OpenCart поставляют файлы `.htaccess`. nginx потребовал бы отдельной конфигурации на каждую CMS и не прочитал бы правил сайта.

**Хватит ли модулей.** Да: `rewrite`, `headers`, `expires`, `deflate`, `env`, `setenvif`, `mime`, `dir`, `alias`, `filter`, `access_compat`, `authz_*`. Прототип поднимает их на Apache 2.4.69 из Debian (замер).

Debian по умолчанию включает ещё `status`, `autoindex` и `negotiation` (замер). **`status` нужно выключить.** `preview-apache.conf:29-30` подключает `mods-enabled/*.conf`, а доступ к `/server-status` в Debian открыт через `Require local`. Шлюз входа ходит к Apache с loopback, и такая проверка всегда пройдёт (вывод: страницу я не запрашивал, на нынешнем образе не проверял).

**Настоящая проблема не в модулях, а в том, что `.htaccess` не читается.** `AllowOverride None` стоит в `infra/wordpress/preview-apache.conf:68`, а `.htaccess`, `.user.ini` и `php.ini` не импортируются (`packages/site-adapters/src/php-hosting.ts:5`). Официальный тест Битрикса на прототипе дал как раз это: «Обработка .htaccess: Нет» (замер на 8.5 под `runsc`).

Поэтому рецепт каждой CMS несёт правила сам, как уже сделано для WordPress (`preview-apache.conf:71-78`):

| CMS | Что писать в `<Directory /var/www/html>` |
| --- | --- |
| Битрикс | `ErrorDocument 404 /404.php`; условия `!-f`, `!-l`, `!-d`, `!/bitrix/urlrewrite.php$`; `RewriteRule ^(.*)$ /bitrix/urlrewrite.php [L]`; `RewriteRule .* - [E=REMOTE_USER:%{HTTP:Authorization}]` (текст из `restore.php` вендора) |
| Joomla | `HTTP_AUTHORIZATION`; `/api/` → `api/index.php`; остальное при `!-f`, `!-d` → `index.php` (`htaccess.txt`) |
| MODX | `!-f`, `!-d`; `RewriteRule ^(.*)$ index.php?q=$1 [L,QSA]` (`ht.access`); нужна и настройка `friendly_urls` в базе |
| OpenCart 3 | закрытие `system/storage/`; `!-f`, `!-d`, не статика; `RewriteRule ^([^?]*) index.php?_route_=$1 [L,QSA]` |
| OpenCart 4 | другой набор, с `REWRITE_PATH` и кешем `catalog/view/html`: нужен рецепт по версии |

`bitrix/urlrewrite.php` читает `/urlrewrite.php` сайта, поэтому маршруты компонентов Битрикса заработают сами, если эти файлы есть в дереве (вывод по устройству `.htaccess` Битрикса). Но сам `/bitrix/` из импорта исключён (`packages/site-adapters/src/bitrix.ts:18,43-44`), и без него предпросмотр Битрикса не запустится. Образом это не лечится — вопрос адаптера и импорта.

Свои правила сайта (редиректы, SEO-модули OpenCart) стандартным блоком не покрыть. Второй шаг, отдельным решением: перенести корневой `.htaccess` с хостинга в дерево предпросмотра и включить `AllowOverride FileInfo Indexes Limit Options=Indexes,MultiViews Nonfatal=All`. `Nonfatal=All` нужен, чтобы директивы хостинга (`suPHP_*`, неизвестные модули) не давали 500 (документ Apache). `AllowOverrideList` не подходит: всё, чего нет в списке, даёт 500.

Комментарий в `preview-apache.conf:5` предостерегает, что PHP сайта может записать `.htaccess`. Вывод: новой дыры это не открывает, PHP и так работает от того же uid. Но решение стоит принять явно.

**`mod_php` или PHP-FPM.** `mod_php`: один проверенный процесс, простая схема под `init.sh`, его рекомендует и тест Битрикса. FPM дал бы чтение `.user.ini` (его читают только CGI и FastCGI — документ php.net), но такие файлы не импортируются, а FPM добавляет лишнюю службу.

## 5. MariaDB или MySQL в образе

**Остаётся MariaDB 11.8.9.** Менять на MySQL незачем.

### Совместимость

- **Битрикс:** урок 2593 от 21.10.2026 прямо называет «MariaDB 10.x и MariaDB 11.x: кодировка — utf8mb4, сортировка — utf8mb4_unicode_ci». Строка «MySQL 8.0 и выше» на странице продукта MariaDB не исключает. Тест сервера сравнивает `version_compare('11.8.9-…', '8.0')` и пройдёт (чтение кода).
- **Joomla:** MariaDB 10.4+, рекомендована 12.0 для 6.x и 11.1 для 5.4.
- **MODX 3:** рекомендована MariaDB 10.6+.
- **Вход старых клиентов:** PHP 5.6 подключается к MariaDB 11.8.9 через `mysql_*`, `mysqli` и PDO (замер под `runc` и `runsc`), и при сортировке сервера `utf8mb4_uca1400_ai_ci`, и при `utf8mb4_unicode_ci`. Ошибки `Server sent charset unknown` (MDEV-32975, php-src #13470) я не получил. `mysql_native_password` остаётся рабочим: именно им шёл этот вход.
- **Дампы MySQL 8:** `utf8mb4_0900_ai_ci` принимается: MDEV-20912 сделала такие сортировки псевдонимами, начиная с 11.4.5. Значит, подходят и 11.8.9, и временная база 11.4.13 (`.env.example:192-193`). Языковые сортировки вида `utf8mb4_ru_0900_ai_ci` я не проверял.
- **Старые таблицы:** `ENGINE=MyISAM` и `aria` разрешены (`packages/site-connections/src/database-copy/sql.ts:82`). Таблица cp1251 с `DATETIME DEFAULT '0000-00-00 00:00:00'` создаётся и читается, байты «Тест» сохраняются (`D2E5F1F2`, замер). Кодировки сида — `utf8mb4`, `utf8mb3`, `latin1`, `cp1251`, `koi8r`, `ascii` (`sql.ts:13-21`).

### Настройки сервера

Сегодня `mariadbd` идёт с `--no-defaults` и жёстким списком аргументов (`init.sh:193-196`). Отдельный механизм настроек на стек не нужен: одинаковые значения подходят всем.

| Настройка | Сейчас | Предлагается | Почему |
| --- | --- | --- | --- |
| `sql_mode` | `STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION` (замер) | `''` | Тест Битрикса: «Режимы STRICT* не поддерживаются». `restore.php`: `SET SQL_MODE=''`. Вставка `''` в `INT` при текущем режиме падает, при пустом проходит (замер) |
| `innodb_strict_mode` | `1` | `0` | `restore.php`: `SET innodb_strict_mode=0`. Широкая таблица COMPACT при `1` — `Row size too large (> 8126)`, при `0` создаётся (замер) |
| `collation_server` | `utf8mb4_uca1400_ai_ci` | `utf8mb4_unicode_ci` | Урок Битрикса 2593 |
| `innodb_flush_log_at_trx_commit` | 1 | 2 | Скорость; данные предпросмотра не ценны (проверен запуск) |
| `explicit_defaults_for_timestamp` | ON (с 10.10) | `0` | Поведение MySQL 5.5–5.7 и MariaDB до 10.10 для старого кода; **не проверялось** |
| `default_time_zone` | `SYSTEM` = UTC | смещение сайта, например `+03:00` | см. §6; **не проверялось** |

Пустой глобальный `sql_mode` безопасен для остальных (чтение кода):

- WordPress сам убирает несовместимые режимы (`$incompatible_modes` в `class-wpdb.php`).
- Joomla задаёт сессионный режим в `MysqliDriver`.
- OpenCart 3 и 4 — `SET SESSION sql_mode = 'NO_ZERO_IN_DATE,NO_ENGINE_SUBSTITUTION'`.
- OpenCart 2.3.0.2 режим не задаёт и как раз получит мягкий.
- MODX я не проверял: сверить на установке.

`mysqli` в PHP 8.1+ по умолчанию бросает исключения (видно в матрице у 8.3 и 8.5), старый код CMS на этих версиях поведёт себя иначе. Это свойство PHP, настройками образа оно не меняется, и адаптеру стоит учитывать его при выборе версии.

## 6. Дополнительные службы

**Почта — самая важная часть.** Без заглушки `mail()` вернёт `false` (вывод: `sendmail` в образе нет). У WordPress почту перекрывает mu-плагин (`infra/wordpress/raditi-preview.php:13-24`). Для всех стеков предлагается три слоя:

1. **`sendmail_path`** на заглушку `/usr/local/lib/raditi/no-sendmail`: `cat >/dev/null; exit 0`. `mail()` возвращает `true` (замер), тест Битрикса «Отправка почты» проходит, письмо никуда не уходит.
2. **Порты SMTP на мосту.** Интернет PHP открыт (план 58), и цепочка `RADITI-<мост>` закрывает только адреса (`infra/sandbox/host-firewall.mjs:33,110`). PHPMailer у Joomla и MODX, Битрикс и OpenCart умеют SMTP из настроек, и одной заглушки здесь мало. Нужны правила TCP 25, 465, 587, 2525 → `DROP`. Это расходится с буквальным «выходы наружу закрывать не нужно», поэтому вопрос владельцу (§12).
3. **Настройки CMS в копии базы.** Поле `overrides` политики копии (`recipe.ts:256-265`) выключает почту стека, а доступ к сервисам рассылки не попадает в список разрешённого. Отправка через HTTPS-API сервисов рассылки по портам не закрывается: её держит только этот слой и маскирование секретов.

**cron не нужен.** Службы в образе нет: она требует прав и ведёт к побочным эффектам. У Битрикса агенты и почта идут на хитах, поэтому в копии базы нужны `agents_use_crontab=N` и `check_agents=N`, а в сгенерированном `dbconn.php` — `BX_CRONTAB_SUPPORT` (документация Битрикса «Агенты и фоновые задачи»). У Joomla 4.1+ надо отключить ленивый планировщик (вывод, по коду не проверял). WordPress уже закрыт (`raditi-preview.php:25-29`).

**Время.** PHP на Europe/Moscow и база на UTC расходятся на 3 часа (замер: `NOW()` 08:22, `date()` 11:22). Сайт, сравнивающий эти часы, увидит ошибку. Нужны одинаковые значения: `date.timezone` в файле стека и `--default-time-zone=<смещение>`. Часовой пояс брать с хостинга, по умолчанию — Москва.

Именованные зоны (`SET time_zone='Europe/Moscow'` на некоторых сайтах) потребуют таблиц: `mariadb-tzinfo-to-sql` в `mariadb-server-core` нет, `tzdata` есть (замер). Начать стоит со смещения, а загрузку таблиц добавить, если такие сайты встретятся.

**Локали.** `ru_RU.UTF-8` и `ru_RU.CP1251` в образе: `locales` и `locale-gen` при сборке, 3,7 МБ, `setlocale` работает на всех версиях (замер).

**memcached, redis.** Службы не нужны. Сгенерированная конфигурация стека ставит файловый кеш и сессии (вывод). Расширения в образе нужны, чтобы код с `class_exists('Memcached')` не падал.

**Проверки окружения CMS.** Тест Битрикса на прототипе 8.5 под `runsc` (блок MySQL не выполнялся: я передал не те имена параметров): интерфейс `apache2handler`, PHP 8.5.12, `short_open_tag` да, OPcache да, `max_input_vars` 10000, почта да, сокеты да, система обновлений да, GD и FreeType да, SSL да, `mbstring` да, 1000 файлов — 0,15 с. Отрицательно только `.htaccess`. «Версия веб-сервера: Не определено» — следствие `ServerTokens Prod` (`preview-apache.conf:18`). «Включен режим UTF для mbstring: Нет» при современном `main` ожидаемо.

## 7. gVisor и read-only

Замер: `runsc` с настройками по умолчанию, read-only корень, `cap-drop ALL` плюс `SETUID`, `SETGID`, `SETPCAP`, `/tmp` как tmpfs `noexec` (`packages/sandbox-providers/src/preview/containers.ts:263`), тома дерева и базы.

| Предмет | Документ gVisor | Замер |
| --- | --- | --- |
| `sysvsem` | `semop`: SEM_UNDO не поддерживается | `sem_get`, `sem_acquire`, `sem_release` прошли на всех версиях |
| `sysvshm`, `shmop`, `sysvmsg` | частично: флаги HUGETLB, RND, LOCK | прошли |
| `flock` | полная | прошёл на tmpfs и на томе |
| Mutex Apache | `fcntl` полная | `Mutex file:/tmp/apache2/lock` работает |
| OPcache в shm | `mmap`, `mprotect` полные | включён, попадания на втором запросе |
| APCu | — | работает |
| `inotify` | события только внутри песочницы | не нужен |
| `io_uring` | частично | `--innodb-use-native-aio=0` уже стоит в `init.sh:195` |
| Память в простое | — | 117 МиБ под `runc`, 156 МиБ под `runsc` (PHP 8.3, база, Apache) |
| Процессы | — | 23 под `runc`, 60 под `runsc`: минимума `RUNSC_MIN_PIDS` 128 хватает |
| Старт до порта Apache с `mariadb-install-db` | — | 1,0–1,7 с (одиночный замер на прогрев 2,5 с) |

Подвох с `SEM_UNDO`: блокировка не упала, но при аварийном завершении процесса семафор может остаться занятым (вывод: я не проверял отмену). Для кода сайта в предпросмотре это мелочь.

**`opcache.file_cache` не включать.** На отсутствующем каталоге PHP 8.5 падает при старте Apache: `Fatal Error opcache.file_cache must be a full path of an accessible directory` (замер); 8.3 продолжает молча и кеш не создаёт. Выгоды нет: контейнер живёт сутками, а shm достаточно.

**`opcache.huge_code_pages` и JIT** — оставить выключенными.

**Что ещё пишет на диск.** Все записи прототипа попали в `/tmp`, `/run/mysqld` и тома. Из Debian-путей `session.save_path` переносим (§2), а `/var/log/apache2` и `/var/run/apache2` не используются благодаря полной конфигурации (`preview-apache.conf:9-11,23,26`). Лог идёт через ту же трубу, что в `init.sh:219`: без неё Apache даёт `Permission denied: could not open error log file /proc/self/fd/2` (ошибка воспроизвелась на прототипе).

**PHP-FPM под gVisor** я не проверял: он не нужен.

## 8. Digest и `PREVIEW_SITE_IMAGES`

Ключ расширять **не нужно**. `parsePreviewSiteImages` принимает `<версия>=<image@sha256:…>` с regex `^\d{1,2}\.\d{1,2}$` (`packages/domain/src/preview/preview-config.ts:167,180-200`), а `siteImage` берёт первую подходящую версию рецепта (`apps/core/src/previews/preview-builder.ts:342-349`). `5.6=…,7.0=…,…,8.5=…` проходит уже сейчас.

Нужны две маленькие правки:

- `runtimeVersions.max(8)` в `recipe.ts:136` → `max(16)`: версий будет 12–13.
- Список версий из `wordpress-preview.ts:18` выносится в общий помощник, а адаптер задаёт диапазон своей CMS и версии.

Если потом понадобится вариант образа той же версии (например, с Zend Guard), ключ расширяется до `5.6-zg=…`: править regex в `preview-config.ts:167` и `recipe.ts:20`. Сейчас это преждевременно.

Закрепление:

- `debian:trixie-slim` — `sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4` (01.11.2026).
- Версии Apache, PHP и расширений в `apt` закрепить нельзя: Sury хранит только свежую. Воспроизводимость здесь не по сборке, а по результату: собрали один раз, используем по digest. Манифест версий (`dpkg-query -W`) стоит хранить рядом с образом.
- MariaDB — как сейчас, точной версией. WP-CLI — `ADD --checksum`, как сейчас.

Обновление образов (вывод): раз в месяц и при критической уязвимости PHP. Новый digest подхватывается при следующей сборке предпросмотра.

В `.github/workflows/publish-images.yml:76-109` матрица только по приложениям. Образы `site`, `tools` и `browser` не публикуются вовсе, `infra/app/env.example` их не называет. Для M10 это пробел уже сегодня.

## 9. Как узнать версию PHP сайта без exec

Сейчас: только `gateway.runtime()` плагина WordPress (`infra/wordpress/raditi-content.php:476-486`, `preview-builder.ts:196-204,612-613`). `ServerProbe.exec` в порту есть (`packages/domain/src/ports/site-adapter.ts:30-34`), но при FTP его нет. У новых стеков плагина нет.

Способы от дешёвых к надёжным:

| Шаг | Способ | Надёжность | Запись на хостинг |
| --- | --- | --- | --- |
| 1 | Заголовок `X-Powered-By: PHP/7.4.33` и `Server` на `GET /` | Точно, если есть. Часто скрыт: Битрикс рекомендует `expose_php = Off` | нет |
| 2 | Файлы хостинга через FTP: `.htaccess` (`AddHandler …php74`, блок cPanel), `.user.ini`, `php.ini`, путь `zend_extension` с номером версии, каталог `php-bin-php74` (справка REG.RU: `/var/www/php-bin-php(номер-версии)/php.ini`) | Средняя, зависит от панели; образцы, кроме REG.RU, по памяти — нужна проверка на настоящих аккаунтах | нет |
| 3 | Журнал `error_log` на хостинге: пути вроде `/opt/php74/` (справка Timeweb о путях). Читать только regex, не хранить: там данные посетителей (`php-hosting.ts:81-84`) | Средняя | нет |
| 4 | Нижняя граница из кода: `vendor/composer/platform_check.php`, `composer.json` (`require.php`, `config.platform.php`) и версия CMS | Только нижняя граница | нет |
| 5 | **Проба:** файл со случайным именем в корне, запрос по HTTP, удаление | Точно, отдаёт версию, расширения и настройки | **да** |
| 6 | Проба кодом в предпросмотре: `php -l` по дереву, запуск и `healthPath`, при фатальной ошибке — следующая версия из `runtimeVersions` | Косвенная, но работает всегда | нет |

Где взять версию CMS:

| CMS | Файл | Что читать |
| --- | --- | --- |
| WordPress | `wp-includes/version.php` | `$wp_version`, `$required_php_version` |
| Битрикс | `bitrix/modules/main/classes/general/version.php` (путь по памяти, проверить) | `SM_VERSION`; `bitrix/php_interface/dbconn.php` — `BX_UTF` |
| Joomla | `libraries/src/Version.php` | `MAJOR_VERSION`, `MINOR_VERSION`, `PATCH_VERSION`; `includes/app.php` — `JOOMLA_MINIMUM_PHP` (путь зависит от версии) |
| MODX | `core/docs/version.inc.php` | `$v['version']`, `major_version`, `minor_version`, `patch_level` |
| OpenCart | `index.php` | `define('VERSION', '3.0.3.8')`; у новых веток — проверка в `system/startup.php` |

Проба (шаг 5) ценнее всего: она заполняет готовую схему `siteRuntimeSchema` — версия и расширения, — и `previewRuntimeMatch` начинает работать для всех стеков без изменений. Она должна отдавать JSON: `PHP_VERSION`, `get_loaded_extensions()`, значения `short_open_tag`, `date.timezone`, `default_charset`, `mbstring.func_overload`, `php_sapi_name()`, `ioncube_loader_version()`. Никакого `phpinfo()`: там окружение. Это та же идея, что официальный `bitrix_server_test.php`.

Запись идёт через `HostingWriter` или доступ мастера. Это правка прода вне `/release`, и правило 3 надо к ней применить явно (вопрос владельцу). Риск — файл останется при обрыве, поэтому имя случайное, а тело проверяет срок и подпись.

Предлагаемый порядок: шаги 1–4 молча, 5 — только с согласия в мастере, 6 — запасной всегда. Результат сохранять в строке сайта: сейчас поля версии PHP в `packages/db/prisma/schema.prisma` нет, и версия читается при каждой сборке.

## 10. План образов

### Цели Dockerfile

Цели `tools` и `browser` не меняются. `site` разбивается на две, и всё общее идёт раньше PHP, чтобы слои делились. Build args: `PHP` (5.6…8.5) и `MARIADB_VERSION`; `BASE` уходит.

Это эскиз, целиком он не собирался. Собирался более простой `scripts/base-images-proto/Dockerfile`: без Node, WP-CLI, скриптов платформы, `apache2-foreground`, `memcache`, `amqp`, с другим способом включения ini и ionCube.

```dockerfile
ARG TARGETARCH
FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS site-os
ARG MARIADB_VERSION=11.8.9
COPY mariadb-release-signing-key.asc /usr/share/keyrings/mariadb-release.asc
COPY sury-php-signing-key.gpg /usr/share/keyrings/sury-php.gpg
RUN set -eu; \
    . /etc/os-release; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates locales tini; \
    printf 'ru_RU.UTF-8 UTF-8\nru_RU.CP1251 CP1251\nen_US.UTF-8 UTF-8\n' > /etc/locale.gen; \
    locale-gen; \
    groupadd --system --gid 999 mysql; \
    useradd --system --uid 999 --gid 999 --home-dir /nonexistent --no-create-home \
      --shell /usr/sbin/nologin mysql; \
    echo "deb [signed-by=/usr/share/keyrings/mariadb-release.asc] https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/repo/debian ${VERSION_CODENAME} main" \
      > /etc/apt/sources.list.d/mariadb.list; \
    echo "deb [signed-by=/usr/share/keyrings/sury-php.gpg] https://packages.sury.org/php/ ${VERSION_CODENAME} main" \
      > /etc/apt/sources.list.d/sury.list; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends apache2 \
      "mariadb-server-core=1:${MARIADB_VERSION}+maria~deb13" \
      "mariadb-client-core=1:${MARIADB_VERSION}+maria~deb13"; \
    a2dismod -f mpm_event status autoindex negotiation; \
    a2enmod mpm_prefork rewrite headers expires deflate env setenvif mime dir alias; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/lib/mysql; \
    install -d -o 999 -g 999 -m 0700 /var/lib/mysql; \
    install -d -o 999 -g 999 -m 0755 /run/mysqld; \
    install -d -m 0755 /usr/local/lib/raditi
ADD --checksum=sha256:ce34ddd838f7351d6759068d09793f26755463b4a4610a5a5c0a97b68220d85c \
    https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar /usr/local/bin/wp
RUN chmod 0755 /usr/local/bin/wp
COPY --from=tools /usr/local/bin/node /usr/local/bin/node
COPY --chmod=0644 forward.mjs dns.mjs /usr/local/lib/raditi/
COPY --chmod=0755 init.sh run-as.sh no-sendmail /usr/local/lib/raditi/
COPY --chmod=0755 apache2-foreground /usr/local/bin/apache2-foreground

# ionCube: архив из своего хранилища; стадия на архитектуру из-за разных sha256.
FROM debian:trixie-slim@sha256:f6b08b09… AS ioncube-amd64
ADD --checksum=sha256:739962bd… <наше-хранилище>/ioncube_loaders_15.5.1_lin_x86-64.tar.gz /tmp/ioncube.tgz
FROM debian:trixie-slim@sha256:f6b08b09… AS ioncube-arm64
ADD --checksum=sha256:b091974a… <наше-хранилище>/ioncube_loaders_15.5.1_lin_aarch64.tar.gz /tmp/ioncube.tgz
FROM ioncube-${TARGETARCH} AS ioncube
RUN mkdir /opt/ioncube; tar xzf /tmp/ioncube.tgz -C /opt/ioncube --strip-components=1 \
      --wildcards 'ioncube/ioncube_loader_lin_*[0-9].so' ioncube/LICENSE.txt

FROM site-os AS site
ARG PHP=8.3
COPY raditi.ini /etc/php/${PHP}/mods-available/raditi.ini
COPY --from=ioncube /opt/ioncube/ /usr/local/lib/raditi/ioncube/
RUN set -eu; apt-get update; \
    pk=; for e in cli common apcu bcmath bz2 curl gd gmp imagick intl ldap mbstring mcrypt \
      memcache memcached mysql redis soap xml xmlrpc zip amqp; do pk="$pk php${PHP}-$e"; done; \
    case "$PHP" in \
      5.*|7.*) pk="$pk php${PHP}-json php${PHP}-opcache" ;; \
      8.5) ;; \
      *) pk="$pk php${PHP}-opcache" ;; \
    esac; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      "libapache2-mod-php${PHP}" $pk; \
    a2enmod "php${PHP}"; \
    phpenmod -v "$PHP" raditi; \
    if [ "$PHP" != 8.0 ]; then \
      printf 'zend_extension=/usr/local/lib/raditi/ioncube/ioncube_loader_lin_%s.so\n' "$PHP" \
        | tee /etc/php/${PHP}/apache2/conf.d/00-ioncube.ini /etc/php/${PHP}/cli/conf.d/00-ioncube.ini >/dev/null; \
    fi; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/www/html/*; \
    install -d -o 33 -g 33 /var/www/html
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/lib/raditi/init.sh"]
CMD ["apache2-foreground"]
```

`apache2-foreground` — короткий скрипт на замену одноимённого из `docker-library`: создаёт `/tmp/apache2/{run,lock}`, удаляет `pid` и делает `exec /usr/sbin/apache2 -DFOREGROUND "$@"`. Тогда `recipe.web.command` в `wordpress-preview.ts:108` не меняется.

### Сборка и публикация

```sh
docker build -f infra/preview/Dockerfile --target site --build-arg PHP=8.3 \
  -t raditi-preview-site:8.3-local infra/preview
```

Новый `.github/workflows/publish-preview-images.yml` (вывод):

```yaml
strategy:
  fail-fast: false
  matrix:
    php: ['5.6','7.0','7.1','7.2','7.3','7.4','8.0','8.1','8.2','8.3','8.4','8.5']
# build-args: PHP=${{ matrix.php }}; target: site; platforms: linux/amd64
# cache-to: общая область для слоёв site-os
```

Итог задания — строка `PREVIEW_SITE_IMAGES=5.6=…@sha256:…,…` в `images.env`. Запуск — при изменении `infra/preview/**`, раз в месяц и вручную. Сейчас `publish-images.yml:158-168` пишет по одной строке на образ, для списка версий нужна сборка строки.

arm64 публиковать не обязательно: разработчик на Mac собирает 2–3 нужные версии за 2–3 минуты локально, как и сейчас (`infra/preview/README.md:13-17`).

### Правки вокруг образа

| Что | Где |
| --- | --- |
| Контракт образа | `infra/preview/site.test.mjs` (сейчас требует `ARG BASE=wordpress@…`), новый отпечаток Sury |
| Запуск базы | `infra/preview/init.sh:193-196`: `--collation-server`, `--sql-mode=`, `--innodb-strict-mode=0`, `--innodb-flush-log-at-trx-commit=2`, смещение времени из новой переменной `RADITI_DB_TIME_ZONE` |
| Конфигурация Apache | `infra/wordpress/preview-apache.conf` → общий шаблон и блок правил стека; opcache в ini |
| Рецепт | `recipe.ts:136` — `max(16)`; `web.env.PHP_INI_SCAN_DIR`; файл стека в `configFiles` |
| Версии | общий список PHP вместо `wordpress-preview.ts:18`; для WordPress — с 5.6 для старых сайтов |
| Сеть | `infra/sandbox/host-firewall.mjs:110`: порты SMTP, если владелец согласится; тесты правил |
| Стенды | `infra/dev/preview-verify/verify-preview-network.mjs:27,264`, `.github/workflows/preview.yml:125,136` — сейчас с `BASE=wordpress…` |
| Документы | `infra/preview/README.md`, `.env.example:188-191`, spec §8, план 58 |
| Интеграция | `wordpress-preview.integration.test.ts:23` и `wordpress-db.integration.test.ts:28` — проверить, что идут на новом образе |

### Новая проверка образа

`pnpm verify:site-images`: на каждую версию запускать пробу (основа — `scripts/base-images-proto/ctx/t.php`, `entry.sh`) под read-only корнем и без возможностей; в `images.yml` — `runc`, локально в Colima — `runsc`. Сверять: версия, список расширений, ionCube (кроме 8.0), `opcache_enabled`, IPC, `flock`, `mail() === true`, локали, запись в базу, правило перезаписи.

### Срезы

| Срез | Что | Оценка (вывод) |
| --- | --- | --- |
| 1 | `site-os` и `site`, `raditi.ini`, `no-sendmail`, `apache2-foreground`, контракт; 8.3 проходит `verify:preview-network` и `verify:release` | 1–1,5 дня |
| 2 | Флаги базы, время, шаблон Apache, `PHP_INI_SCAN_DIR`, регрессия WordPress | 1 день |
| 3 | Все 12 версий, `verify:site-images`, ionCube в своём хранилище | 1 день |
| 4 | Публикация, `images.env`, манифест версий | 0,5 дня |
| 5 | SMTP на мосту и почта адаптеров | 0,5 дня + работа по адаптерам |
| 6 | Определение версии: шаги 1–4, 6; проба — после ответа владельца | 1–2 дня |

Первый срез меняет основу работающего WordPress, поэтому начинать надо с него и отдельно от стеков.

## 11. Что не доказано

- **amd64 не запускался.** Прогон — за CI.
- **В матрице 4 версии из 12:** 5.6, 7.4, 8.3, 8.5. Нет 7.0–7.3, 8.0–8.2, 8.4 и `php-memcache`, `php-amqp`. Закодированный ionCube-файл я не исполнял: проверена загрузка Loader, а не выполнение, энкодера нет.
- **Настоящие CMS на прототипе не поднимались.** Требования взяты из документов и инсталляторов, запускался только тест Битрикса, и без блока MySQL. Установки Joomla, MODX и OpenCart могут показать ещё что-то.
- **Прототип не шёл через настоящие `init.sh`, `dns.mjs`, `forward.mjs` и Node.** `entry.sh` повторяет запуск служб.
- `explicit_defaults_for_timestamp=0`, `--default-time-zone`, загрузка `mariadb-tzinfo-to-sql`, `/server-status` и строки ini с `*` не проверены.
- Шаги 2–3 из §9 не опробованы на реальных аккаунтах хостинга.
- `opcache.file_cache` проверялся только с отсутствующим каталогом.
- Условия использования репозитория Sury явно нигде не изложены. Требования Joomla 3.x и 4.4 — из стороннего справочника.
- Для Битрикса с версией `main` до 24.0.0 и кодировкой cp1251 полный сценарий не проверялся; проверены только таблица cp1251 и `func_overload` на 5.6.

## 12. Вопросы владельцу

У каждого есть значение по умолчанию.

1. **Брать PHP из Sury вместо официальных образов?** По умолчанию — да: это единственный путь с одной базой и обновлениями для 5.6–8.0. Риск — один сторонний мейнтейнер.
2. **Список: 5.6–8.5, 12 версий.** PHP 5.2–5.5 ведём на 5.6 с предупреждением, 8.6 — после выхода. По умолчанию — да.
3. **Закрыть TCP 25, 465, 587 и 2525 на мосту предпросмотра?** Это сужает ответ «выходы наружу закрывать не нужно», но без этого письма настоящим адресатам могут уйти из предпросмотра. По умолчанию — закрыть.
4. **Разрешить пробный PHP-файл на хостинге в мастере?** Это запись на прод вне `/release`. По умолчанию — только с явной отметкой клиента, иначе версия по шагам 1–4 и 6.
5. **Читать `.htaccess` сайта в предпросмотре?** По умолчанию — нет на первом этапе: стандартные правила в рецепте.
6. **Zend Guard не поддерживать.** По умолчанию — да, такой сайт получает `not_supported`.
7. **ionCube в каждом образе.** По умолчанию — да, с `LICENSE.txt`.

## Источники

Docker и PHP:

- [php.net: поддерживаемые версии](https://www.php.net/supported-versions.php)
- [docker-library/php versions.json](https://raw.githubusercontent.com/docker-library/php/master/versions.json)
- [docker-library/wordpress Dockerfile](https://raw.githubusercontent.com/docker-library/wordpress/master/latest/php8.3/apache/Dockerfile)
- [Docker Hub: php](https://hub.docker.com/_/php) (API `v2/repositories/library/php/tags`)
- [Sury: репозиторий](https://packages.sury.org/php/), [deb.sury.org](https://deb.sury.org/)
- [PHP: файл конфигурации, `PHP_INI_SCAN_DIR`](https://www.php.net/manual/en/configuration.file.php)
- [PHP: `.user.ini`](https://www.php.net/manual/en/configuration.file.per-user.php)
- [PHP: настройки OPcache](https://www.php.net/manual/en/opcache.configuration.php)
- [PHP 8.6: подготовка](https://wiki.php.net/todo/php86)
- [Node: BUILDING.md ветки 26](https://raw.githubusercontent.com/nodejs/node/v26.x/BUILDING.md)
- [docker-php-extension-installer](https://github.com/mlocati/docker-php-extension-installer)

ionCube и Zend:

- [ionCube: загрузка](https://www.ioncube.com/loaders.php), [EULA](https://www.ioncube.com/legal/loaders/eula)
- [Zend Guard: установка](https://help.zend.com/zendguard/current/content/install.htm)

CMS:

- [Битрикс: требования к серверному ПО, урок 2593](https://dev.1c-bitrix.ru/learning/course/?COURSE_ID=32&LESSON_ID=2593)
- [Битрикс: требования продукта](https://www.1c-bitrix.ru/products/cms/requirements.php)
- [Битрикс: `bitrix_server_test.php`](https://www.1c-bitrix.ru/download/scripts/bitrix_server_test.php), [`restore.php`](https://www.1c-bitrix.ru/download/scripts/restore.php)
- [Битрикс: агенты и фоновые задачи](https://docs.1c-bitrix.ru/pages/framework/background-jobs.html)
- [Битрикс24: требования, справка](https://helpdesk.bitrix24.ru/open/5825131)
- [Joomla: технические требования 6.x](https://manual.joomla.org/docs/next/get-started/technical-requirements/), [5.4](https://manual.joomla.org/docs/5.4/get-started/technical-requirements/)
- [Joomla: Docker-образ](https://github.com/joomla-docker/docker-joomla), [`htaccess.txt`](https://raw.githubusercontent.com/joomla/joomla-cms/5.4-dev/htaccess.txt)
- [MODX: требования](https://raw.githubusercontent.com/modxorg/Docs/3.x/en/getting-started/server-requirements.md), [`ht.access`](https://raw.githubusercontent.com/modxcms/revolution/3.x/ht.access)
- [OpenCart: требования](https://docs.opencart.com/getting-started/system-requirements.md), [исходники](https://github.com/opencart/opencart)
- [WordPress: `class-wpdb.php`](https://raw.githubusercontent.com/WordPress/WordPress/master/wp-includes/class-wpdb.php)

База, сервер, изоляция:

- [MariaDB: `sql_mode`](https://mariadb.com/docs/server/server-management/variables-and-modes/sql-mode)
- [MariaDB: `innodb_strict_mode`](https://mariadb.com/docs/server/server-usage/storage-engines/innodb/innodb-strict-mode)
- [MariaDB: системные переменные](https://mariadb.com/docs/server/server-management/variables-and-modes/server-system-variables)
- [MDEV-32975](https://jira.mariadb.org/browse/MDEV-32975), [MDEV-20912](https://jira.mariadb.org/browse/MDEV-20912), [php-src #13470](https://github.com/php/php-src/pull/13470)
- [archive.mariadb.org](https://archive.mariadb.org/)
- [gVisor: совместимость системных вызовов](https://gvisor.dev/docs/user_guide/compatibility/linux/amd64/)
- [Apache: `AllowOverride`](https://httpd.apache.org/docs/2.4/mod/core.html)

Хостинги и прочее:

- [REG.RU: смена версии PHP](https://help.reg.ru/support/hosting/php-asp-net-i-skripty/kak-smenit-versiyu-php-na-hostinge)
- [Timeweb: смена версии PHP](https://timeweb.com/ru/support/faq/hosting/technical/kak-izmenit-versiyu-php-dlya-sayta/)
- [Beget: управление сайтами](https://beget.com/ru/kb/manual/sajty), [уязвимость PHP от 21.10.2026](https://beget.com/ru/news/2026/uyazvimost-v-php-ot-21-10-2026)
- [W3Techs: версии PHP](https://w3techs.com/technologies/details/pl-php)
- [GitHub Packages: оплата](https://docs.github.com/en/billing/concepts/product-billing/github-packages)
