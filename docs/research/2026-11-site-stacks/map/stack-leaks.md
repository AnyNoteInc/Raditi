# Утечки WordPress из адаптера

Дерево: `raditi-stacks`, ветка `feat/site-stacks`, равна `main` (`c811abf1`). Код не менялся. Ссылки — `путь:строка` от корня дерева.

Сложность: **S** — правка текста или одной константы; **M** — несколько файлов одного приложения, порт не меняется или меняется добавлением; **L** — меняется договор между приложениями, данные, плагин на PHP или стенды; **0** — оставить как есть, упомянуто, чтобы не искать снова.

Что значит «как стать»: **порт** — новый метод `SiteAdapter`; **данные** — поле того, что адаптер уже отдаёт; **текст** — слова с подстановкой или нейтральные слова.

## Главное

1. **Прямых сравнений со стеком в продуктовом коде нет.** Поиск `stack ===|!==`, `switch (…stack` по `apps`, `packages` и `infra` дал одно срабатывание по делу — стендовую команду `infra/dev/site-verify/connect-local.mjs:461`. Выбор адаптера по реестру выдержан везде. Утечка идёт не через `if`, а через **словарь**: WordPress вписан в схемы домена.
2. **Самая дорогая утечка — словарь контента.** Инструмент `wp_rest` с маршрутами `/wp/v2/...` зашит в `apps/mcp`, `post|page` — в `publishedObjectRefSchema`, поля `title/content/excerpt` — в `dbContentFields` и в хеш, общий с PHP-плагином, `post_create`/`post_trash`/`option_update` — в enum базы и в манифест выкладки.
3. **Вторая по цене — образ предпросмотра.** `FROM ${BASE}` с `BASE=wordpress@sha256:…` (`infra/preview/Dockerfile:8,48`), ключ выбора образа — только версия PHP (`packages/domain/src/preview/preview-config.ts:167,176-198`), без стека.
4. **Файловый путь нейтрален и уже работает без модуля на проде.** Ни один продуктовый путь не пишет доступ `wp`: его создают только стенды и `connect-local.mjs`. Сайт из мастера идёт через предпросмотр и `/release` без него. Новый стек может стартовать в этом режиме. Но план БД такого сайта `/release` отклоняет (`db_plan_unsupported`, `apps/core/src/releases/release-skill.ts:625-633`), хотя предпросмотр даёт агенту правку текста (см. «Расхождения», 1).
5. **Шесть методов порта мертвы** (0 вызовов вне `packages/site-adapters`): `detect`, `deployVars`, `backup`, `mcpTools`, `agentGuide`, `snapshotExcludes`. А `verify`, `previewRecipe`, `agentWorkingSet`, `mediaRules` и `databaseCopyPolicy` заглушка Битрикс не реализует, и без них стек не поедет.

## Сводка по подсистемам

| # | Подсистема | Мест | L | M | S | 0 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| A | Домен: идентификаторы стеков, доступы, порт | 9 | 0 | 3 | 5 | 1 |
| B | Домен: словарь контента и плана БД | 12 | 4 | 5 | 2 | 1 |
| C | Prisma, миграции, сиды | 7 | 1 | 2 | 3 | 1 |
| D | Vault | 6 | 0 | 1 | 5 | 0 |
| E | MCP | 9 | 3 | 3 | 3 | 0 |
| F | Инструкции агенту | 8 | 0 | 3 | 4 | 1 |
| G | Предпросмотр: образы, контейнер, сборка | 13 | 3 | 5 | 4 | 1 |
| H | Копия БД и временная база дампа | 7 | 0 | 3 | 2 | 2 |
| I | Импорт и серверная часть мастера | 8 | 0 | 5 | 3 | 0 |
| J | Выпуск и `deploy-step` | 5 | 0 | 1 | 2 | 2 |
| K | Задача в браузере | 7 | 0 | 3 | 2 | 2 |
| L | Web: мастер, кабинет, чат | 14 | 0 | 5 | 8 | 1 |
| M | Лендинг, биллинг, юридические тексты | 13 | 0 | 1 | 11 | 1 |
| N | Песочница хода | 6 | 0 | 0 | 5 | 1 |
| | **Итого по продукту (A–N)** | **124** | **11** | **40** | **59** | **14** |
| O | Стенды, e2e, CI | 9 групп | | | | |
| P | Документы | 6 групп | | | | |

Вне таблицы: 2 565 строк в 257 тестовых файлах упоминают WordPress как образец; это не утечки (раздел O).

---

## A. Домен: идентификаторы стеков, доступы, порт

| Где | Что предполагается | Как должно стать | Сложн. |
| --- | --- | --- | --- |
| `packages/domain/src/ports/site-adapter.ts:26` | `siteStacks` без `joomla`, `modx`, `opencart`. Должен совпадать с enum Prisma (тест `packages/db/src/enums.test.ts:81`) | Добавить три значения; вместе с миграцией из раздела C | S |
| `packages/domain/src/ports/site-adapter.ts:95` | `siteAccessKinds` содержит `wp`; доступ модуля назван именем одной CMS | Нейтральный вид (`content`). Дёшево сейчас: продукт его не пишет, см. D | M |
| `packages/domain/src/ports/site-adapter.ts:36-49` | Поле `version` есть, но `detect` не вызывается, а `previewSiteFacts` и `siteFactsOf` кладут только `docroot: '/'` и `extras: {}` (`apps/core/src/previews/preview-builder.ts:186-193`, `apps/core/src/tasks/pass-facts.ts:63-66`). WordPress версия не нужна; Joomla 3/4/5, OpenCart 2/3/4 и MODX 2/3 различаются путями и админкой | Читать версию при импорте, хранить на сайте, заполнять `SiteFacts.version` всегда | M |
| `packages/domain/src/ports/site-adapter.ts:30-34,174` | `detect(probe)` с `ServerProbe.exec/readFile/httpGet`: по FTP `exec` невозможен. Остальные методы мастера берут `read(path)` | `detect(read)` тем же читателем, что `configSecrets` | M |
| `packages/domain/src/ports/site-adapter.ts:176,177,179,181,185` | Мёртвые `deployVars`, `backup`, `mcpTools`, `agentGuide`, `snapshotExcludes` обязательны в типе; заглушка бросает исключения (`packages/site-adapters/src/bitrix.ts:84-102`) | Удалить или сделать необязательными до написания трёх адаптеров | S |
| `packages/site-adapters/src/registry.ts:7-18` | `plannedStacks` знает Битрикс и этапы; новых стеков нет | Строки реестра; это внутри пакета адаптеров | S |
| `packages/site-adapters/src/registry.ts:33` | `connectableStacks = ['wordpress']` | Расширять по готовности стека: так и задумано | S |
| `packages/domain/src/release/env-vars.ts:28-35` | Запрещённые префиксы переменных клиента: `WP_`, `DB_`, `AUTH_`, `SECURE_`, `LOGGED_IN_`, `NONCE_` — константы `wp-config.php`. Нет `BX_`, `JPATH_`, `MODX_`, `DIR_` | `envVarNameSchema` не знает стека (`packages/domain/src/release/env-vars.ts:78`), поэтому проще единый расширенный список | S |
| `packages/domain/src/ports/sandbox-provider.ts:75`, `packages/domain/src/policies/site-address.ts:6`, комментарии порта `site-adapter.ts:3,182,193,267,302,327` | Примеры WordPress в комментариях | Оставить: примеры, не поведение | 0 |

## B. Домен: словарь контента и плана БД

Здесь главная переделка: схемы называются нейтрально, а значения — WordPress. Комментарий `packages/domain/src/release/db-objects.ts:13` «nothing here knows a stack» верен лишь отчасти.

| Где | Что предполагается | Как должно стать | Сложн. |
| --- | --- | --- | --- |
| `packages/domain/src/ports/published-content.ts:4` | `publishedObjectRefSchema` — только `post\|page`. Запись другого стека не проходит схему; у `dbRecordRefSchema` (`packages/domain/src/release/db-objects.ts:30-34`) правило уже общее `<type>:<id>` | Заменить на общее правило, типы объявляет адаптер | L |
| `packages/domain/src/ports/published-content.ts:10-14,23` | Поля `title/content/excerpt`, `kind: post\|page`. У карточки OpenCart главное — цена; страницы Битрикс — файлы, а не строки базы | Поля объявляет адаптер: тип записи и его поля | L |
| `packages/domain/src/ports/published-content.ts:42-56` | Порядок кадров хеша и пустой кадр пароля записи WordPress. Тот же расчёт в PHP (`infra/wordpress/raditi-content.php:72`) | Формат с версией; байты WordPress не меняются: журнал и снимки читают прежние хеши | L |
| `packages/domain/src/release/db-plan.ts:29-37,53,60-62` | Виды `post_create`, `post_trash`, `option_update`; `dbContentFields` | Либо считать их внутренними именами «запись» и «настройка», либо переименовать (`record_create`, `setting_update`) — тогда миграция enum (C) | L |
| `packages/domain/src/ports/site-db.ts:64-70,76-93` | `DbCreatedRecord` с теми же полями, статус `publish\|draft`, `post_trash` «в корзину». Корзины нет в OpenCart (из знаний о продукте) | Поля от адаптера; `dbOperationKinds` объявляет только то, что стек умеет | M |
| `packages/domain/src/release/db-objects.ts:27,36` | `option:<имя>`, имя `[a-z][a-z0-9_]*`. У Битрикс настройка — пара модуль и имя, у Joomla часть настроек в файле `configuration.php` (из знаний о продуктах, здесь не проверено) | Плоское имя в `dbSettings` подойдёт трём стекам; у Joomla закрытый список без файловых настроек | M |
| `packages/domain/src/release/db-objects.ts:18-24` | `DB_CREATED_ID_BASE` = 1 000 000 000: числовой автоинкремент | Оставить: вмещается в `INT` у всех четырёх | 0 |
| `packages/domain/src/release/candidate.ts:185-186` | Счётчики `option_update`, `post_create` | Следуют за переименованием | S |
| `packages/domain/src/release/deploy-manifest.ts:189-213,391` | Манифест выкладки с видами плана и `z.enum(siteStacks)`; образ `core` с `deploy-step` у раннера Gitea должен знать новые значения | Обновлять образ вместе с `core`; старый манифест читается | M |
| `packages/domain/src/tasks/client-feed.ts:139,267` | `feedObjectKinds = ['post','page']`: лента не назовёт товар | Подпись объекта от адаптера. Старые события читаются через `known(...)` (`:718`) | M |
| `packages/domain/src/tasks/client-feed-labels.ts:563-564,586-591,758-759` | «страница с адресом», «Страница или запись», `post: 'Запись'` | Слово с подстановкой от адаптера | S |
| `packages/domain/src/browser/checkpoint.ts:19,109-111` | `browserCheckpointKinds = ['post']`, `FEED_KIND` | Расширить список; колонка `browser_checkpoints.kind` — строка до 16 знаков с CHECK (C) | M |

## C. Prisma, миграции, сиды

| Где | Что предполагается | Как должно стать | Сложн. |
| --- | --- | --- | --- |
| `packages/db/prisma/schema.prisma:310-317`, `packages/db/prisma/migrations/20260926173557_init/migration.sql:14` | enum `SiteStack` без трёх стеков | Миграция `ALTER TYPE "SiteStack" ADD VALUE`. Значение нельзя использовать в той же транзакции: образец — `20261018100000_db_operation_kinds_enum` и отдельная вторая миграция | S |
| `packages/db/prisma/schema.prisma:462-471`, `packages/db/prisma/migrations/20261004200100_site_connection/migration.sql:139` | enum `CredentialKind.wp`; CHECK `kind NOT IN ('ssh','ftp','wp','browser','db') OR site_id IS NOT NULL` | Если вид переименован — миграция enum и CHECK, плюс значения `credential_refs.vault_path` | M |
| `packages/db/prisma/schema.prisma:437` | Комментарий с путями `{ssh,ftp,wp,…}` | Вместе с предыдущим | S |
| `packages/db/prisma/migrations/20261018100100_db_operation_kinds/migration.sql:22-28` | CHECK по видам плана; ветка `<type>:<id>` общая | Менять только при переименовании видов: `ALTER TYPE` и новый CHECK с `BEGIN/COMMIT` и остановкой перед ними | L |
| `packages/db/prisma/schema.prisma:2616`, CHECK `browser_checkpoints_object_check` | Вид чекпоинта из `browserCheckpointKinds` | Новая миграция CHECK при расширении списка | M |
| `packages/db/prisma/schema.prisma:251,2311`, `packages/db/prisma/migrations/20261017200000_chat_preview_release/migration.sql:598` | Комментарий `DISALLOW_FILE_MODS` у `drift_policy` (поле код не читает); CHECK `'php_lint'` | Комментарий поправить; все четыре стека на PHP, имя `php_lint` верно | S |
| Сиды `packages/db` | WordPress не упомянут: тарифы стек не называют | Оставить; текст «на WordPress» живёт в web (M) | 0 |

## D. Vault

**Находка.** Доступ `wp` пишут только `infra/dev/site-verify/connect-local.mjs:542-543` и стенды (`infra/dev/release-verify/setup.mjs:307`). Мастер активирует сайт с `requiredAccess: [source.kind]` (`apps/core/src/site-provisioning/stage-store.ts:464`). Записей `wp` в production нет, сам production не развёрнут (M10), значит переименование вида сейчас не требует переноса секретов.

| Где | Что предполагается | Как должно стать | Сложн. |
| --- | --- | --- | --- |
| `infra/vault/policies/mcp-content.hcl:1-2,6-8` | `read` на `kv/data/sites/+/wp` и `kv/data/previews/+/wp` | Один нейтральный вид на все стеки | S |
| `infra/vault/policies/core-release.hcl:2,5` | То же для выпуска | То же | S |
| `infra/vault/policies/core-site-import.hcl:2` | Комментарий «without the WordPress and browser kinds» | Текст | S |
| `infra/vault/bootstrap.test.mjs:85-90,120` | Контракт политик называет `wp` | Вместе с политиками | S |
| `infra/vault/verify-local.mjs:403,608-633,686,887-896,943-955,975,1040,1067,1368-1390,1482-1526` | Стенд проверяет `wp` как вид | Вместе с политиками, двадцать с лишним правок | M |
| `infra/vault/README.md:15,20,28,48,107-114` | Описание вида как WordPress. Отдельный вид на каждый стек потребовал бы новых строк в трёх политиках и не дал бы изоляции сверх `+` | Один вид на все стеки, текст | S |

## E. MCP

Инструменты объявлены статически декораторами `@Tool`; `SiteAdapter.mcpTools` мёртв. Модель видит один список инструментов на любой стек, а маршруты уже диктует адаптер через `dbPlanGuide` (`packages/site-adapters/src/wordpress-db.ts:82-84`).

| Где | Что предполагается | Как должно стать | Сложн. |
| --- | --- | --- | --- |
| `apps/mcp/src/content/mcp-content.controller.ts:50-52` | Имя `wp_rest`, описание с `/wp/v2/...`, «post or page» | Нейтральный `site_content`; общее описание, частности — из `dbPlanGuide` | L |
| `apps/mcp/src/content/content-arguments.ts:21-23,32,36-56,69,82` | Грамматика `/wp/v2/(posts\|pages)/ID`, `/wp/v2/settings`; схемы `wpRest*` | Аргументы по смыслу: операция, тип, id, поля; тип проверяет адаптер | L |
| `apps/mcp/src/content/mcp-content.ts:350-369,402,622,631-652` | Метод `wpRest`, разбор `parts[3] === 'posts'`, `tool: 'wp_rest'` в журнале, текст отказа | Сервис принимает нейтральные аргументы | L |
| `apps/mcp/src/content/mcp-content.ts:634`, `apps/mcp/src/content/mcp-journal.ts:109` | `type: 'post' \| 'page'` | Строка по `dbRecordRefSchema` | M |
| `apps/mcp/src/access/mcp-policy.ts:39,111` | Допуск `name: z.literal('wp_rest')` | Вместе с именем | S |
| `apps/mcp/src/access/mcp-policy.ts:167-172`, `apps/mcp/src/access/mcp-access.ts:116` | Семейство `content` открывается по `p.db_mode = 'copy'`, а не по наличию `recipe.content`. Стек с базой без модуля увидит инструмент, а вызов упадёт на шлюзе | Признак «у предпросмотра есть контент» в строке предпросмотра | M |
| `apps/mcp/src/site-info/mcp-tools.controller.ts:52` | `preview.dbKinds ?? ['content_update']`: агенту обещана правка текста, даже если стек её не умеет | По умолчанию `[]` при отсутствии контента | M |
| `apps/mcp/src/content/mcp-journal.ts:1461`, `apps/mcp/src/access/mcp-access.ts:44` | `z.enum(siteStacks)` | Следует за списком стеков | S |
| `apps/mcp/src/content/content-arguments.ts:13`, `apps/mcp/src/content/content.module.ts:34`, `apps/mcp/src/config/config.ts:29`, `packages/site-content/src/published-value.ts:4` | Комментарии с `wp_rest` | Текст | S |

Переименование ломает стенды: записанные обмены `packages/llm-backends/src/zai-coding/fixtures/*` и сценарий `infra/dev/llm-verify/fake-zai.mjs:101,533` ждут `raditi_wp_rest` (раздел O).

## F. Инструкции агенту

`apps/core/src/tasks/turn-instructions.ts` общий для всех стеков; адаптер добавляет только `dbPlanGuide` и `browserGuide`. `agentGuide` мёртв: о CMS агент узнаёт из `site_info.stack` и из знаний модели.

| Где | Что предполагается | Как должно стать | Сложн. |
| --- | --- | --- | --- |
| `apps/core/src/tasks/turn-instructions.ts:33-34` | «titles, texts and excerpts of published posts and pages» | «published content of the site» | S |
| `apps/core/src/tasks/turn-instructions.ts:36-37,296` | «switching the theme, installing plugins»; «plugins, themes» | «theme, extensions and modules» | S |
| `apps/core/src/tasks/turn-instructions.ts:45-47,52-53` | Перечень «existing post or page», «menus, widgets, theme or plugin settings» | Перечень из адаптера: новый метод или часть `dbPlanGuide` | M |
| `apps/core/src/tasks/turn-instructions.ts:48-49` | «A new page or post gets another ID», «slug» | «a new record» | S |
| `apps/core/src/tasks/turn-instructions.ts:191-192` | «not a file in its root (robots.txt, .htaccess…)»: верно для рабочего набора WordPress. У Битрикс публичные страницы лежат в корне и подпапках | Строка из адаптера вместе с `agentWorkingSet` | M |
| `apps/core/src/tasks/turn-instructions.ts:82-84` | Текст `no_core`: «core files of the site's engine» | Оставить: общий | 0 |
| `apps/core/src/tasks/turn-instructions.ts:154` | «curl, npm, composer»: подходит всем четырём PHP-стекам | Оставить до стека не на PHP | S |
| `packages/domain/src/ports/site-adapter.ts:181`, `apps/core/src/tasks/pass-facts.ts:317` | Руководства по стеку для диалога нет: только `dbPlanGuide`. У браузерной задачи есть `browserGuide` (`turn-instructions.ts:334`) | Раздел о сайте из адаптера: где код шаблона, как устроены модули | M |

## G. Предпросмотр: образы, контейнер, сборка

| Где | Что предполагается | Как должно стать | Сложн. |
| --- | --- | --- | --- |
| `infra/preview/Dockerfile:6-8,48` | Основа образа `site` — официальный образ `wordpress`. По памяти в нём нет `pdo_mysql` (нужен MODX 3); проверить сборкой | Нейтральная основа `php:<версия>-apache` со своим набором расширений | L |
| `infra/preview/Dockerfile:39,74-76` | В каждый образ кладётся WP-CLI; его зовёт только `recipe.content` (`packages/site-adapters/src/wordpress-preview.ts:75`) | CLI — дело стека; в рецепте уже свободный argv | M |
| `packages/domain/src/preview/preview-config.ts:167,176-198`, `apps/core/src/config/config.ts:292`, `apps/core/src/previews/preview-builder.ts:342-349` | `PREVIEW_SITE_IMAGES` — `версия=образ`, ключ без стека | Либо один образ на версию PHP для всех CMS (проще), либо ключ `стек:версия` при разных расширениях | L |
| `packages/domain/src/preview/recipe.ts:20` | Версия вида `8.3` | Подходит всем | 0 |
| `packages/domain/src/preview/recipe.ts:134` | `runtime: z.literal('php')` | Подходит всем четырём | S |
| `infra/preview/init.sh:24` | `WEB=33:33` жёстко, а договор даёт адаптеру `recipe.web.user` (`packages/sandbox-providers/src/preview/containers.ts:264`, `packages/sandbox-providers/src/preview/runtime.ts:662,748`). Другой uid оставит `wait_file` без файла | Передавать uid переменной окружения | M |
| `infra/preview/init.sh:2,193-196`, `packages/sandbox-providers/src/preview/containers.ts:52,259-267` | Всегда MariaDB с `utf8mb4` и без `sql_mode`. Битрикс требует особых настроек (по памяти; проверить) | Настройки сервера базы — данные рецепта | M |
| `packages/sandbox-providers/src/preview/runtime.ts:628-630` | Только `mysql`; иначе `badRequest` | Joomla на PostgreSQL — `unavailable`, а не сбой сборки | M |
| `infra/wordpress/preview-apache.conf:6,71` | `.htaccess` не читается, правила WordPress вписаны в конфиг; файл лежит в каталоге WordPress | Общий шаблон Apache плюс правила стека. `web.configFiles` позволяет уже сейчас | M |
| `infra/wordpress/*`, `packages/site-adapters/scripts/embed-wordpress-files.mjs:17-31`, `turbo.json:177-180`, `infra/app/ci.test.mjs:763-774` | Встраивание PHP-файлов и контракт CI зашиты на один каталог | Каталоги `infra/<стек>/` и общий генератор | L |
| `apps/core/src/previews/preview-builder.ts:288` | Литерал `charset: 'utf8mb4'` при запросе таблиц политики | Комментарий `:287` верен: имена таблиц от кодировки не зависят. Заменить на нейтральное значение при PostgreSQL | S |
| `apps/core/src/previews/preview-checks.ts:27-37,67`, `apps/core/src/deploy-step/deploy.ts:194` | Линтер и `FATAL` по языку, не по CMS («Languages, not stacks») | Подходит всем четырём | S |
| `infra/preview/forward.mjs:27`, `packages/sandbox-providers/src/preview/containers.ts:57` | WordPress и PHP в комментариях | Текст | S |

## H. Копия БД и временная база дампа

| Где | Что предполагается | Как должно стать | Сложн. |
| --- | --- | --- | --- |
| `apps/core/src/previews/previews.providers.ts:94,103` | Единственный копировщик `createMysqlDatabaseCopier` | Подходит четырём на MySQL; реестр по движку — только для PostgreSQL | 0 |
| `packages/site-connections/src/services.ts:24-25`, `apps/web/src/components/projects/wizard/database-fields.tsx:20-21` | Мастер предлагает PostgreSQL любому стеку, в том числе WordPress, а предпросмотр умеет только MySQL | Порт `databaseEngines()`; мастер фильтрует | M |
| `packages/domain/src/preview/recipe.ts:246,265` | Пределы `tables.max(64)`, `overrides.max(32)` рассчитаны на WordPress. У каталога Битрикс и OpenCart таблиц контента больше (оценка, не измерено) | Поднять после описи таблиц | S |
| `packages/domain/src/preview/recipe.ts:123` | Файл рецепта до 192 КиБ, подобрано под плагин WordPress | Поднять при необходимости | S |
| `packages/domain/src/preview/recipe.ts:203-222` | Синтетические значения считаются от числового ключа `<id>`, таблица с одной числовой колонкой ключа | Проверить на таблицах пользователей и покупателей четырёх стеков | M |
| `packages/site-connections/src/database-copy/sql.ts:13-21` | Кодировки `cp1251`, `koi8r` есть: важно для старых сайтов Битрикс | Оставить | 0 |
| `packages/site-connections/src/database-copy/wordpress-policy.fixture.json`, `turbo.json:181`, `infra/app/ci.test.mjs:825` | Образец политики WordPress лежит в пакете копировщика | Перенести к адаптеру или завести по образцу на стек | M |

## I. Импорт и серверная часть мастера

| Где | Что предполагается | Как должно стать | Сложн. |
| --- | --- | --- | --- |
| `packages/site-connections/src/sources/root-check.ts:43-53` | `LIKELY_ROOTS` содержит `wordpress`, `wp` | Убрать из общего кода или брать у адаптера | S |
| `packages/domain/src/site-connection/limits.ts:45-65`, `packages/domain/src/git/publication.ts:25-28` | 1 ГиБ дерева, 100 000 файлов: «A guess for WordPress». Ядро Битрикс с кешами может быть крупнее (оценка, не измерено) | Предел от адаптера или проверка на реальном дистрибутиве | M |
| `packages/site-adapters/src/bitrix.ts:18,44`, `packages/domain/src/preview/recipe.ts:139-140` | Импорт Битрикс исключает `bitrix/` и `upload/` (старое правило), а предпросмотр запускает полное дерево из репозитория; у WordPress ядро импортируется с 17.10.2026 | Решить, где лежит ядро: в репозитории или в образе стека | M |
| `packages/site-adapters/src/bitrix.ts:52-58` | TODO: маркер `bitrix` слаб, импорт уходит во вложенную папку | Усилить `rootMarkers` | S |
| `packages/domain/src/ports/site-adapter.ts:186-190`, `apps/web/src/components/projects/wizard/project-wizard.tsx:593-621` | Стек выбирает пользователь, `rootMarkers` проверяет выбор | Определять стек по маркерам и просить подтверждение | M |
| `packages/domain/src/ports/site-adapter.ts:199-229` | `configSecrets` и `databaseSettings` читают файлы корня; `php-config.ts` разбирает константы и присваивания. У `configuration.php` Joomla значения — свойства класса (из знаний о продукте) | Парсеры внутри адаптера; порт не меняется | M |
| `apps/core/src/site-provisioning/site-import.ts:484,538,550` | `importRules`, `configSecrets`, `rootMarkers` идут через порт | Только проверить адаптеры на стенде | S |
| `packages/site-adapters/src/php-hosting.ts:5,11` | `.htaccess`, `.user.ini`, `php.ini` защищены и не импортируются, а у Joomla и OpenCart в `.htaccess` правила адресов | Адаптер отдаёт правила в свой конфиг Apache (см. G) | M |

## J. Выпуск и `deploy-step`

| Где | Что предполагается | Как должно стать | Сложн. |
| --- | --- | --- | --- |
| `apps/core/src/release-api/release-api.service.ts:400-414` | Доступ модуля читается по `contentAdapter.accessKind`; `NOT_IMPLEMENTED` даёт `content: null` | Оставить: путь без модуля есть | 0 |
| `apps/core/src/deploy-step/deploy.ts:66,146-150,194-219` | Кеш кода PHP; `createCodeCache` необязателен (`packages/domain/src/ports/site-adapter.ts:169`) | Оставить: подходит всем четырём | 0 |
| `apps/core/src/deploy-step/deploy.ts:454,497` | `capabilities().plugin < 2`: номер версии плагина WordPress в общем коде | Перенести в возможности шлюза | M |
| `apps/core/src/deploy-step/backup.ts:33`, `apps/core/src/deploy-step/cli.ts:30,90` | «plugin» в комментариях | Текст | S |
| `ci/.gitea/scoped_workflows/check.yml:6`, `ci/README.md:10` | «PHP lint» в пометке спайка | Верно для всех четырёх | S |

## K. Задача в браузере

Порт покрывает политику целиком: `browserTaskPolicy`, `browserCheckpointOf`, `browserCommitAction`, `browserVerification`, `browserGuide`. Заглушка Битрикс бросает `NOT_IMPLEMENTED`. Остаётся словарь.

| Где | Что предполагается | Как должно стать | Сложн. |
| --- | --- | --- | --- |
| `packages/domain/src/browser/checkpoint.ts:19`, `apps/web/src/components/chat/chat-texts.ts:551` | Один вид `post`; товар OpenCart — тоже объект | Новые виды (B) | M |
| `packages/domain/src/browser/checkpoint.ts:26-35` | Статусы WordPress; есть `unknown` | Оставить: адаптер отдаёт `unknown` | 0 |
| `packages/domain/src/browser/addresses.ts:15-21` | Скрытие секретов в адресе по имени параметра. `sessid` Битрикс и `user_token` OpenCart попадают под правило. Токен Joomla — параметр со случайным hex-именем и значением `1` (из знаний о продукте, не проверено) и не попадёт | Правило для имён из 32 hex-знаков или метод адаптера | M |
| `packages/browser-providers/src/cloud/page-rules.ts:93-98` | Комментарий о WordPress, правило общее | Текст | S |
| `packages/browser-providers/src/cloud/verification.ts:33`, `apps/browser/src/sessions/worker-session.ts:201-202,331`, `packages/domain/src/browser/tools.ts:130`, `packages/domain/src/browser/observation.ts:20`, `packages/domain/src/browser/ports.ts:139`, `packages/browser-providers/src/cloud/cloud-browser.ts:1025`, `packages/browser-providers/src/cloud/editable-text.ts:7` | Блочный редактор и `/wp-json` в комментариях; логика `Ctrl+S` и `contenteditable` общая | Текст | S |
| `apps/core/src/tasks/turn-instructions.ts` `BROWSER_RULES` | Нейтральны, кроме строки из F | См. F | 0 |
| `apps/browser/src/sessions/worker-session.ts:1170-1171` | «Двойной клик» публикации описан на блочном редакторе, а держится на `browserCommitAction` | Проверить на админках новых стеков: у них обычная отправка формы | M |

## L. Web: мастер, кабинет, чат

| Где | Что предполагается | Как должно стать | Сложн. |
| --- | --- | --- | --- |
| `apps/web/src/components/projects/project-labels.ts:1-8` | Подписи шести стеков, тип `ProjectStack` выводится из них | Три строки; `Record<SiteStack, string>`, чтобы TS требовал подпись | S |
| `apps/web/src/components/projects/wizard/project-wizard.tsx:156` | `stacks[0] ?? 'wordpress'` | Убрать запасное значение | S |
| `apps/web/src/components/projects/wizard/project-wizard.tsx:593-621` | Один стек — подпись, несколько — `select` без подсказок | Новый шаг выбора: дизайн онбординга | M |
| `apps/web/src/components/projects/wizard/project-wizard.tsx:77,81` | «записи, страницы и медиафайлы», «Код, тему и плагины» | Слова стека | S |
| `apps/web/src/components/site/site-format.ts:5,15,25` | `wp: 'Вход в панель сайта'`, `['имя','пароль приложения']` | Вместе с видом доступа; поля — данные адаптера | S |
| `packages/trpc/src/routers/project.ts:118-124` | `SITE_ACCESS_KINDS` с `wp` | Вместе с видом доступа | S |
| `apps/web/src/components/chat/chat-texts.ts:99,102-105` | Только «Страница» или «Запись», «запись блога» | Подпись типа от адаптера | M |
| `apps/web/src/components/chat/chat-texts.ts:551-552`, `apps/web/src/components/chat/feed-list.tsx:606` | `kind: 'post' \| 'page' \| null` | Вместе с `feedObjectKinds` | M |
| `packages/trpc/src/services/chat/undo.ts:208-209,229` | «страница», «запись» | То же | M |
| `apps/web/src/components/chat/database-panel.tsx:137,153,156,235` | Карточки по `post_create` | Только при переименовании видов | M |
| `apps/web/src/components/chat/chat-texts.ts:121` | `php_lint: 'Файлы без ошибок в коде'` | Оставить: слова нейтральны | 0 |
| `apps/web/src/components/chat/chat-texts.ts:154,158` | «PHP», «расширения PHP»: верно для всех четырёх, но слово техническое (правило 10) | Текст | S |
| `apps/web/src/components/chat/chat-texts.ts:243-255`, `apps/web/src/components/site/site-database.tsx:128,206`, `apps/web/src/components/site/history-text.ts:78`, `apps/web/src/components/site/site-versions.tsx:183` | «записи сайта» подходят и товарам | Проверить вместе с подписью типа | S |
| `apps/web/src/components/site/site-overview.tsx:46` | Комментарий «access to WordPress» | Текст | S |

## M. Лендинг, биллинг, юридические тексты

| Где | Что предполагается | Как должно стать | Сложн. |
| --- | --- | --- | --- |
| `apps/web/src/components/billing/plan-format.ts:109-112,128` | «Один сайт на WordPress». Тянет ожидания в тестах и e2e (`apps/e2e/tests/billing/manage.spec.ts:281`, `apps/e2e/tests/billing/plans.spec.ts:157`, `apps/web/src/components/billing/plan-format.test.ts:67-135,904`, `apps/web/src/components/billing/checkout-dialog.test.tsx:89-92`) | «Один сайт», «До 3 сайтов» | S |
| Письма и условия тарифов (`packages/mail`, `packages/notifications`, сиды) | Слова WordPress нет | Оставить | 0 |
| `apps/web/src/components/landing/landing.tsx:65` | Вопрос «Для каких сайтов подойдёт Радити?» | Новый список систем | S |
| `apps/web/src/components/landing/landing.tsx:233` | «Начинаем с сайтов на WordPress» | То же | S |
| `apps/web/src/components/landing/landing.tsx:358-359` | «Сначала — WordPress», «например 1С-Битрикс, — в планах» | То же | S |
| `apps/web/src/components/landing/landing.tsx:469` | «пока для сайтов на WordPress» | То же | S |
| `apps/web/src/components/landing/landing.tsx:107`, `apps/web/src/components/landing/landing.test.tsx:61-63` | `UNBREAKABLE` с `/wp-admin`; тест считает вхождения | Обновить вместе с текстом | S |
| `apps/web/src/components/landing/pricing.tsx:228` | «на сайтах WordPress» | То же | S |
| `docs/landing/landing.dc.html:536,699,721,863,911-912,944` | Прототип, не код продукта | Обновить, если он ещё образец | S |
| `apps/web/content/legal/public-offer.md:80,158,208,422` | «темы оформления и плагины»; в OpenCart это модули, в Joomla — расширения | С юристом: «шаблоны и расширения»; новая редакция документа | M |
| `apps/web/content/legal/user-agreement.md:47,162,260` | То же | То же | S |
| `apps/web/content/legal/privacy-policy.md:185` | «смена темы, плагины» | То же | S |
| `apps/web/content/legal/README.md:169` | Заметка о скриншотах `wp-admin` | Обновить | S |

В оферте, соглашении и политике слово WordPress не названо: `apps/web/content/legal/consent.md:65` говорит «система управления сайтом». Юридическая правка небольшая.

## N. Песочница хода

| Где | Что предполагается | Как должно стать | Сложн. |
| --- | --- | --- | --- |
| `infra/sandbox/Dockerfile:1` | Комментарий «WordPress stack runtime» | Текст | S |
| `infra/sandbox/Dockerfile:22-24` | `php-cli composer`: один образ с PHP из Debian bookworm | Подходит четырём: образ общий | 0 |
| `apps/core/src/config/config.ts:72` | `raditi/sbx-wordpress@sha256:0…` | Имя образа без стека | S |
| `.env.example:272`, `infra/app/env.example:57` | То же | То же; проверка нулевого digest остаётся | S |
| `infra/app/README.md:20`, `infra/app/verify-edge.mjs:582` | То же | То же | S |
| `apps/core/src/config/config.test.ts:33,53,284` и другие | Имена в тестах | Вместе с остальными | S |

## O. Стенды, e2e, CI — 9 групп

Это не утечки: стенд на настоящем WordPress проверяет настоящий адаптер. Важен объём и то, что новым стекам стенда нет. Строки с `wp-`, `wp_`, `/wp/`, `WordPress`, `wordpress`:

| Группа | Строк | Файлов | Что делать |
| --- | ---: | ---: | --- |
| `infra/dev/site-verify` | 185 | 9 | Оставить; `connect-local.mjs:461` проверяет стек сознательно |
| `infra/dev/release-verify` | 107 | 7 | Оставить; другим стекам нужен параметр или свой стенд |
| `infra/dev/site-import-verify` | 103 | 7 | Фикстура и манифест на стек; сценарии мастера общие |
| `infra/dev/browser-task-verify` | 78 | 10 | Оставить; плагины стенда только для WordPress |
| `infra/dev/llm-verify` | 36 | 6 | `wp_rest` в сценарии (`content-scenario.mjs:2,43`, `fake-zai.mjs:101,480,533`) сломается при переименовании |
| `infra/dev/gitea-verify`, `pipeline-verify`, `billing-verify`, `preview-verify`, `db-verify` | 58 | 16 | В основном одна строка `stack: 'wordpress'` |
| `infra/dev/docker-compose.yml`, `infra/dev/monitoring` | 10 | 2 | Профиль `site`; оставить |
| `apps/e2e` | 14 | 7 | `apps/e2e/tests/site-import/wizard.spec.ts:108,114`, `apps/e2e/tests/billing/*`: тексты |
| `.github/workflows/*` и записи обменов | — | — | `wordpress-content.yml`, `agent-content.yml`, `ci.yml:104-123`, `preview.yml:125-151`, `release-deploy.yml:28,59`, `billing.yml:6`; `packages/llm-backends/src/zai-coding/fixtures/34-run-c-mcp`, `81-g6-live-content`. Записи — история: при переименовании инструмента нужен псевдоним или очищенная перезапись |

Контракт `infra/app/ci.test.mjs:581-599,760-825` не даёт CI отстать от `infra/wordpress`: новым каталогам нужны такие же правила.

## P. Документы — 6 групп

`docs/spec.md:13,63,92,113,269,1296,1413-1459,3348` (порядок стеков и §13), `README.md:9,58,120,143,156,193-209,218,226`, `infra/preview/README.md:9-15`, `infra/vault/README.md`, `CLAUDE.md` (правила 1, 3, 4, 8 и раздел стека), `docs/business.md`. Joomla, MODX и OpenCart в spec не упомянуты; цепочка «1С-Битрикс — следующим» ждёт решения владельца.

---

## Нарушения правила 8 CLAUDE.md

Правило запрещает знание о CMS вне адаптера. Прямых `if (cms === 'wordpress')` в продукте нет, но знание есть:

| # | Где | Вид нарушения |
| --- | --- | --- |
| 1 | `apps/mcp/src/content/content-arguments.ts:21-23`, `apps/mcp/src/content/mcp-content.ts:364-369`, `apps/mcp/src/content/mcp-content.controller.ts:50-52` | Формат REST WordPress разбирается в приложении. Самое серьёзное |
| 2 | `apps/mcp/src/access/mcp-policy.ts:39` | Имя инструмента CMS в допуске |
| 3 | `packages/domain/src/ports/published-content.ts:4,23`, `packages/domain/src/tasks/client-feed.ts:139`, `packages/domain/src/browser/checkpoint.ts:19` | Типы объектов одной CMS в ядре: порт нейтрален по форме, но не по значениям |
| 4 | `packages/domain/src/release/env-vars.ts:28-35` | Константы `wp-config.php` в домене |
| 5 | `packages/site-connections/src/sources/root-check.ts:51-52` | Имена папок WordPress в общем адаптере подключений |
| 6 | `packages/site-connections/src/database-copy/wordpress-policy.fixture.json` | Данные WordPress в чужом пакете (только тесты; мягкое) |
| 7 | `infra/preview/Dockerfile:8,74-76` | Образ всех предпросмотров на основе WordPress с WP-CLI |
| 8 | `apps/core/src/tasks/turn-instructions.ts:33-34,36-37,45-47,52-53` | Словарь WordPress в инструкции, а комментарий `:246-250` утверждает, что она «know no stack» |
| 9 | `apps/web/src/components/billing/plan-format.ts:110-112`, `apps/web/src/components/projects/wizard/project-wizard.tsx:156` | Стек в тексте тарифа и значение по умолчанию |

Не нарушение: `infra/dev/site-verify/connect-local.mjs:461` — комментарий `:458-460` объясняет, что это инструмент стенда.

## Расхождения с договором порта

Не слова, а поведение, которое поломает новый стек. Первое есть уже сейчас и у WordPress.

1. **`content_update` безусловен.** `previewDbRuntime` всегда начинает с него (`apps/core/src/previews/preview-builder.ts:231,238,240`, `packages/site-content/src/preview-db-runtime.ts:21-22`), хотя порт обещает «empty — none» (`packages/domain/src/ports/site-adapter.ts:237`). Адаптер не может отказаться от правки текста. На сайте мастера без доступа модуля агент правит текст в предпросмотре, а `/release` отказывает `db_plan_unsupported` (`apps/core/src/releases/release-skill.ts:625-633`, `apps/core/src/releases/release-row.ts:128-132`).
2. **Версия PHP известна только от модуля на проде.** `SiteFacts.runtimeVersion` приходит из шлюза (`apps/core/src/previews/preview-builder.ts:601-613`). У сайта мастера модуля нет, поэтому предпросмотр всегда берёт `DEFAULT_PHP` (`packages/site-adapters/src/wordpress-preview.ts:20`). Старый сайт на PHP 7.4 может не запуститься на 8.3; другим стекам нужен свой источник версии.
3. **`web.user` против `WEB=33:33`** — см. G.
4. **`recipe.content: null` не доходит до MCP** — см. E.

## Что уже нейтрально

Проверка — чтение кода и поиск; где указан тест, он это фиксирует.

| Подсистема | Что нейтрально | Доказательство |
| --- | --- | --- |
| Выбор адаптера | Везде реестр: `apps/core/src/previews/previews.providers.ts:118`, `apps/core/src/releases/releases.module.ts:68`, `apps/core/src/tasks/tasks.providers.ts:55,94,130`, `apps/core/src/release-api/release-api.module.ts:38`, `apps/core/src/site-provisioning/site-provisioning.module.ts:124`, `apps/core/src/deploy-step/cli.ts:69`, `apps/mcp/src/content/content.module.ts:63,81`, `apps/browser/src/worker/worker.module.ts:45` | Поиск сравнений со стеком дал только стенд |
| Стек без адаптера | Падает управляемо: `NOT_IMPLEMENTED` ловят `apps/core/src/release-api/release-api.service.ts:262,299,409`, `apps/core/src/releases/release-skill.ts:710`, `apps/core/src/releases/undo-planner.ts:229`, `apps/core/src/tasks/candidate-builder.ts:238,335`, `apps/core/src/tasks/pass-facts.ts:83`; предпросмотр отвечает `not_supported` (`apps/core/src/previews/preview-builder.ts:618`) | `apps/mcp/src/content/mcp-content.test.ts:264,301-323`, `apps/mcp/src/app.module.test.ts:435`, `apps/mcp/src/content/site-content-resolver.test.ts:159` ведут `bitrix` и `static` |
| Рабочая копия | Правила из `siteWorkspaceRules` (`packages/domain/src/git/working-set.ts:76`), без них — полное дерево (`apps/core/src/tasks/pass-facts.ts:79-88`) | Ответ владельца от 19.10.2026 |
| Рецепт предпросмотра | Сборка читает только `PreviewRecipe`: команду сервера, порт, docroot, файлы, настройки, проверки (`apps/core/src/previews/preview-builder.ts:616-720`) | Схема `previewRecipeSchema` |
| Шлюз предпросмотра | В `apps/preview/src` слов WordPress нет; `Host` и cookie общие | Поиск; упоминания только в тестах |
| Копировщик БД | Список разрешённого от адаптера, кодировки включая `cp1251`, любой префикс таблиц, в том числе пустой | `packages/domain/src/preview/recipe.ts:35,232-266`, `packages/site-connections/src/database-copy/sql.ts:13-21` |
| Настройки БД | Запасной путь по каталогу базы не знает стека | `apps/core/src/previews/database-settings.ts:7-16` |
| Импорт | Обход, скан секретов и публичные оригиналы идут через порт; `publicOriginals` необязателен | `apps/core/src/site-provisioning/public-originals.ts:7-10`, `packages/site-adapters/src/import-rules.test.ts:49,257` на Битрикс |
| Выпуск файлов | `deploy-step` пишет файлы, проверяет страницы из `SiteAdapter.verify`, откатывает; модуль необязателен | `apps/core/src/release-api/release-api.service.ts:405-414`; по записи о полном цикле 27.10.2026 сайт мастера прошёл его на настоящем хостинге (здесь не перепроверялось) |
| Шлюз контента | `SiteContentAdapter` выбирается по стеку, доступ по `accessKind`; секрет не покидает адаптер | `packages/site-content/src/site-content-resolver.ts:47,100-125` |
| План БД: таблицы | `db_schema` и словарь таблиц нейтральны; префикс ставит модуль | `packages/domain/src/release/db-objects.ts:38-42`, `apps/mcp/src/content/content-arguments.ts:88-130` |
| Браузер | Политика, вход, чекпоинт и чтение через порт; `web_*` без слов CMS | `apps/mcp/src/web/mcp-web.controller.ts:44`, `apps/browser/src/sessions/session-manager.ts:183` |
| Браузер агента на предпросмотре | Только `browserRequestDenied` | `apps/mcp/src/browser/mcp-browser.ts:148,590,638` |
| Мастер: доступы | SFTP, FTP, база, `project.create`; текст `not_site_root` подставляет платформу | `packages/trpc/src/services/site-basics.ts:218-231`, `apps/web/src/components/projects/wizard/reason-text.ts:45` |
| Схема базы | Кроме enum и CHECK выше, таблицы WordPress не знают; `object_ref` — общий формат | `packages/db/prisma/migrations/20261018100100_db_operation_kinds/migration.sql:28` |
| Вход в браузере | `siteSignInEnvVars` без CMS | `apps/core/src/site-env/site-env-values.ts:77` |
| LLM, раннер, биллинг, почта | Слова WordPress в продуктовом коде нет | Поиск по `apps/llm/src`, `apps/runner/src`, `packages/billing/src` (кроме `packages/billing/src/testing.ts:536,561`), `packages/mail`, `packages/notifications` |
| Границы | `site-adapters` зависит только от domain, а domain ни от кого | `.dependency-cruiser.cjs:10,423,445,488` |

Граница доказательства: исполнение на стеке не WordPress есть только в тестах `apps/mcp` и `import-rules`. Предпросмотр, кандидат и выпуск на другом стеке никогда не шли, поэтому нейтральность там установлена чтением, а не прогоном.

## Что осталось непроверенным

- Расширения официального образа `wordpress`, требования Битрикс к MariaDB, форма токена Joomla и хранение её настроек — из общих знаний, в этом репозитории не проверялись.
- Размеры ядра Битрикс и число таблиц контента Битрикс и OpenCart — оценка.
- `apps/web/src/components/**` просмотрен поиском по словарю (`запись`, `админка`, `плагин` и другие), а не файл за файлом.
- Незакоммиченные правки в `raditi` (`site-connection.tsx`, `site-overview.tsx` и другие) в этот клон не входят.
