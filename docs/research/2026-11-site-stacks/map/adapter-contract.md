# Договор адаптера стека

Дерево чтения: `raditi-stacks`, ветка `feat/site-stacks`, `c811abf1` (равна `main`). Код не менялся. Пути в ссылках — от корня дерева.

Сведения о самих CMS (имена файлов, таблиц, экранов) — знания о них, а не чтение их кода и не живая проверка. В тексте такие места отмечены «(CMS)». Всё остальное прочитано в репозитории.

## 1. Итоги

1. **Договор шире, чем продукт.** Из 26 методов `SiteAdapter` шесть не вызываются в продукте вообще: `detect`, `deployVars`, `backup`, `mcpTools`, `agentGuide`, `snapshotExcludes`. У WordPress четыре из них — `notImplemented`, значит, продукт работает без них. Для новых CMS их можно не писать и убрать из порта. В `importRules` не читается поле `gitignore`, в `VerifyPlan` — `logFiles` и `screenshots`, в `SiteFacts` — `version`, `docroot`, `extras`.
2. **Рабочий договор — 20 методов, и они делятся на независимые группы:** импорт (4), дерево агента (3), предпросмотр (3 метода плюс файлы рецепта), браузер (1 + 5), БД (3) и `verify` для выпуска. Выпуск файлов стеку почти ничего не стоит: `deploy-step` общий, ему нужны только `verify` и `mediaRules().addOnlyPaths`.
3. **Самый дешёвый полезный уровень — «только браузер»:** пять методов `browser*` и ничего больше, а мастер уже умеет `access: 'browser'`. Он закрывает контент всех четырёх CMS без плагина на сайте. Но это и самый опасный уровень: задача работает на живом сайте, а на правила 1 и 4 там отвечает только `browserTaskPolicy`. У WordPress это 847 строк и ещё 402 строки политики. В OpenCart и Битриксе в админке лежат заказы и клиенты, поэтому им нужен список разрешённого, а не закрытый список.
4. **Уровень «контент через плагин» в production закрыт и у WordPress.** `MCP_CONTENT_PROFILE` в production допускает только `off` (`apps/mcp/src/config/config.ts:195`). Доступ `wp` к сайту пишет только стендовый `infra/dev/site-verify/connect-local.mjs`, а активация требует лишь доступ к файлам (`apps/core/src/site-provisioning/stage-store.ts:464`). На настоящем сайте `production`-шлюз пуст, все объекты предпросмотра считаются несовпавшими (`apps/core/src/previews/preview-builder.ts:782`), и запись в них отклоняется (`apps/mcp/src/content/mcp-journal.ts:397`). Копировать плагин на новые CMS сейчас незачем: первая итерация без `SiteContentAdapter` возможна при `recipe.content: null`.
5. **Заглушки `notImplemented` ведут себя по-разному.** Девять мест их ловят и молча переходят на запасное поведение, остальные падают. Самые неприятные исходы:
   - `agentWorkingSet` → ход получает **полное дерево** с ядром (`apps/core/src/tasks/pass-facts.ts:79`);
   - `verify` → проверка выпуска только по главной и без маркеров (`apps/core/src/release-api/release-api.service.ts:299`);
   - `importRules` → импорт не отказывает, а остаётся в `running` до сборщика (`apps/core/src/site-provisioning/site-import.runner.ts:215`);
   - `browserTaskPolicy` → три повтора с паузами 2, 8 и 35 с и потом `unavailable` (`apps/core/src/browser/browser-sessions.ts:79`, `:149`).
6. **Уровни сейчас нельзя включать по отдельности.** `connectableStacks` — один список на всё (`packages/site-adapters/src/registry.ts:33`), а `siteCapabilities` не знает стек (`packages/trpc/src/services/site-capabilities.ts:70`). Сразу после импорта `repository: 'ready'`, и ходы открыты. `candidateRefusalsOf` смотрит только на `failed` (`packages/domain/src/release/candidate.ts:273`), поэтому без предпросмотра проверки остаются `pending`, а `/release` доступен. Для `no_core` это задумано (`apps/core/src/tasks/turn-instructions.ts:75`: «checked when the client releases them»), но для новой CMS значит выпуск кода, который ни разу не запускался. Нужен объявленный уровень поддержки на стек.
7. **`bitrix.ts` придётся переписать, а не дописать.** Он не импортирует ядро и медиа (`packages/site-adapters/src/bitrix.ts:13`, `:18`), а предпросмотр требует ядро в репозитории (`requiredPaths`, отказ `no_core`; решение владельца от 17.10.2026 о полном импорте). `rootMarkers = ['bitrix']` слаб: обход не войдёт в `local/components`, потому что в ней есть папка `bitrix` (TODO в `bitrix.ts:54`). Тесты `bitrix.test.ts` (299 строк) закрепляют старое поведение.
8. **WordPress прошит вне адаптера в шести крупных местах и нескольких мелких** (раздел 6): `publishedObjectRefSchema` `^(post|page):`, инструмент `wp_rest` с маршрутами `/wp/v2/…`, `browserCheckpointKinds = ['post']`, вид доступа `wp` с политиками Vault, базовый образ `wordpress` с WP-CLI при одной карте «версия PHP → образ», одноязычные поля `title`, `content`, `excerpt`.
9. **В договоре нет того, без чего новые CMS не поедут** (раздел 8). Главное: адрес админки (OpenCart и MODX его переименовывают, а методы получают только `url` или вовсе один запрос), сброс кеша CMS после выпуска, код в базе у MODX, папки, которые нужно создать в предпросмотре.
10. **Общего для PHP-CMS уже три файла, а вынести можно ещё примерно столько же.** Разбор запроса «как его читает PHP», таблица медиа, выбор версии PHP, Apache-конфигурация, переписывание адресов в предпросмотре и весь `WordpressPublishedContentGateway`: кроме трёх мелочей он не про WordPress, а про протокол `/raditi/v1`.

Объём WordPress для сравнения: 3 123 строки TypeScript без тестов, 1 830 строк PHP и конфигурации, 4 731 строка тестов.

## 2. Как устроен договор

### Три порта и реестр

- `SiteAdapter` — `packages/domain/src/ports/site-adapter.ts:172`. Нужен всякому стеку, который проходит через `getSiteAdapter`.
- `SiteContentAdapter` — `site-adapter.ts:158`; шлюзы — `packages/domain/src/ports/published-content.ts:134`, `:199`, `packages/domain/src/ports/site-db.ts:154`.
- Реестр — `packages/site-adapters/src/registry.ts`. `getSiteAdapter` бросает `notImplemented` для `static`, `laravel`, `node`, `python` и `badRequest` для неизвестного. `getSiteContentAdapter` знает только `wordpress`.
- `connectableStacks = ['wordpress']` читают мастер (`apps/web/src/app/(protected)/projects/(list)/new/page.tsx:26`) и `assertSiteAccepted` (`packages/trpc/src/services/site-basics.ts:236`) — и для доступа к файлам, и для `access: 'browser'` (`packages/trpc/src/routers/project.ts:505`).
- `SiteStack` — enum PostgreSQL (`packages/db/prisma/migrations/20260926173557_init/migration.sql:14`) и `siteStacks` в домене; его читают ещё `apps/mcp/src/access/mcp-access.ts:44`, `apps/mcp/src/content/mcp-journal.ts:1461`, `packages/domain/src/release/deploy-manifest.ts:391`. Для `joomla`, `modx`, `opencart` нужна миграция `ALTER TYPE … ADD VALUE`, и новое значение нельзя использовать в той же транзакции. Подписи — `apps/web/src/components/projects/project-labels.ts:1`.

### Что адаптер получает на входе

Почти все вызовы передают `{ stack, url, docroot: '/', extras: {} }` (`siteFactsOf`, `apps/core/src/tasks/pass-facts.ts:63`; то же вручную в `release-skill.ts:701`, `release-api.service.ts:276`, `content.module.ts:128`). `database` и `runtimeVersion` есть только в `previewSiteFacts` (`apps/core/src/previews/preview-builder.ts:182`). `version` не заполняется нигде, `docroot` и `extras` никто не читает, а в модели `Site` для них нет полей (`packages/db/prisma/schema.prisma:243`).

Вывод: метод не может знать о сайте ничего, кроме адреса. Всё, что зависит от установки, берётся только через функции `read` (`configSecrets`, `publicOriginals`, `databaseSettings`).

### Кто ловит `notImplemented`

| Место | Метод | Запасное поведение |
| --- | --- | --- |
| `apps/core/src/tasks/pass-facts.ts:83` | `agentWorkingSet`, `mediaRules` | полное дерево с `protectedPaths` |
| `apps/core/src/tasks/pass-facts.ts:383` | `browserGuide` | ход без указаний по админке |
| `apps/core/src/tasks/candidate-builder.ts:238` | `mediaRules` | нет папок «только добавлять» |
| `apps/core/src/tasks/candidate-builder.ts:335` | `dbSettings` | карточка плана без настроек |
| `apps/core/src/releases/release-skill.ts:710` | `mediaRules` | нет папок «только добавлять» |
| `apps/core/src/releases/undo-planner.ts:229` | `mediaRules` | отмена не оставляет добавленные медиа |
| `apps/core/src/release-api/release-api.service.ts:262` | `mediaRules` | нет папок «только добавлять» |
| `apps/core/src/release-api/release-api.service.ts:299` | `verify` | главная без маркеров |
| `apps/core/src/release-api/release-api.service.ts:409` | `getSiteContentAdapter` | выпуск без плагина |

Ловят **всё подряд**: выбор настроек базы и `previewRecipe` → `not_supported` (`preview-builder.ts:291`, `:618`), `#recipeOf` (`preview-manager.ts:344`), `previewDbRuntime` (`preview-builder.ts:237`), `release-skill.ts:721` и `:957`, `apps/mcp/src/site-info/browser-tasks.ts:27`, `browserCheckpointOf` (`apps/browser/src/sessions/worker-session.ts:583`). Эти места скрывают и настоящую ошибку адаптера, а не только заглушку.

Не ловят: `importRules`, `rootMarkers`, `protectedPaths`, `dbPlanGuide`, `browserTaskPolicy`, `browserCommitAction`, `databaseCopyPolicy` на `preview-builder.ts:645`, `dbSettings` у роли `mcp` (`apps/mcp/src/content/content.module.ts:128`).

## 3. `SiteAdapter`: метод за методом

Колонки: кто вызывает; что делает WordPress и объём; что зависит от CMS и что общее; что будет без метода.

### 3.1. Не вызываются

| Метод | Вызовы | WordPress | Нужно ли другой CMS | Без метода |
| --- | --- | --- | --- | --- |
| `detect` | нет; порт `ServerProbe` никто не реализует | `notImplemented` (`wordpress.ts:272`) | Нет. Определить стек дешевле в `root-check`: сверить листинг корня с `rootMarkers` всех подключаемых стеков | ничего |
| `deployVars` | нет | `notImplemented` (`wordpress.ts:284`) | Нет: выкладка идёт командой `deploy-step` по манифесту | ничего |
| `backup` | нет; бэкап выпуска считает `deploy-step` по манифесту | `notImplemented` (`wordpress.ts:287`) | Нет | ничего |
| `mcpTools` | нет; инструменты объявлены декораторами в `apps/mcp/src/content/mcp-content.controller.ts:50` и рядом | 15 описаний (`wordpress.ts:186`), часть инструментов (`wp_cli`, `snapshot`, `media_upload`, `wp_delete`) в роли `mcp` не существует | Нет | ничего |
| `agentGuide` | нет | `notImplemented` (`wordpress.ts:294`) | Пока нет: то, что агенту нужно знать о стеке, идёт через `dbPlanGuide` и `browserGuide` | ничего |
| `snapshotExcludes` | только тесты (`import-rules.test.ts:81`, `bitrix.test.ts:52`) | списки (`wordpress.ts:133`) | Нет | ничего |

Заглушки этих методов закреплены тестом `bitrix.test.ts:273`. Если их убирают из порта, тест уходит вместе с ними.

### 3.2. Импорт

| Метод | Вызовы | WordPress | Общее и своё | Без метода |
| --- | --- | --- | --- | --- |
| `rootMarkers` | мастер: `apps/web/src/server/site-connections.ts:43` → `packages/site-connections/src/services.ts:47` → `packages/trpc/src/services/site-access.ts:141` → `packages/site-connections/src/sources/root-check.ts`; импорт: `apps/core/src/site-provisioning/site-import.ts:550` → `tree-walk.ts:214` | `['wp-content','wp-includes']` (`wordpress.ts:167`), 1 строка | Целиком своё. Метка играет две роли: мастер отказывает папке без всех меток, обход **не входит** во вложенную папку со всеми метками. Набор должен быть и общим для всех установок, и редким внутри дерева | метод обязателен; падает проверка в мастере или импорт |
| `importRules` | `site-import.ts:484`, только `.exclude`; поле `.gitignore` не читает никто | `wordpress.ts:146`–`:164` и списки `:45`–`:114`, около 120 строк | Общее — `php-hosting.ts`. Своё — конфигурация, кеши, папки бэкапов, папки с файлами посетителей | вне `try`: не `ImportFailure` → `site_import_unsettled` (`site-import.runner.ts:215`), этап висит в `running` до сборщика, клиент видит «Настраиваем сайт» |
| `configSecrets` | `site-import.ts:538`, в наборе точных значений для поиска в каждом файле | `wordpress.ts:306`, regex `:172`–`:176`, 8 строк + `php-config.ts` | Механика общая (`phpConfigStrings`, `secretValues`), своё — файл и шаблоны | через `sessionFailure`; импорт падает. Вернуть `[]` можно, но это снимает защиту: пароль базы останется искать только gitleaks |
| `publicOriginals?` | `apps/core/src/site-provisioning/public-originals.ts:67`, необязательный | `wordpress-public-code.ts`, 90 строк | Своё полностью: где публикуется релиз ядра и расширений. Для Joomla, MODX и OpenCart есть теги GitHub (CMS), для Битрикса открытого источника нет | файл с находкой сканера просто не импортируется. Но предел `flaggedFiles: 200` срабатывает раньше (`import-scan.ts:123`, `source_has_secrets`), и сверка с оригиналами от него не спасает |

Чем отличаются CMS (CMS):

| | Метки корня | Конфигурация | Чего не импортировать |
| --- | --- | --- | --- |
| Битрикс | `bitrix`, `upload`, `index.php` или `urlrewrite.php`; нужен признак, которого нет в `local/components` | `bitrix/.settings.php`, `bitrix/php_interface/dbconn.php`, `bitrix/license_key.php` | `bitrix/backup/`, `bitrix/cache/`, `bitrix/managed_cache/`, `bitrix/stack_cache/`, `bitrix/html_pages/`, `upload/tmp/`, `upload/resize_cache/`, файлы форм и заказов в `upload/` |
| Joomla | `administrator`, `libraries`, `components` | `configuration.php`: `public $password`, `$secret`, `$smtppass`, `$dbprefix` | `cache/`, `administrator/cache/`, `tmp/`, `administrator/logs/`, папки Akeeba |
| MODX | `core` и `manager` могут лежать вне корня или называться иначе; надёжна пара `config.core.php` и `index.php` | `core/config/config.inc.php`: `$database_password`, `$table_prefix`, `$database_dsn` | `core/cache/`, `core/packages/*.zip`, `core/export/` |
| OpenCart | `catalog`, `system`, `image`; `admin` переименовывают | `config.php` и `<admin>/config.php`: `define('DB_PASSWORD', …)`, `DB_PREFIX` | `system/storage/*`, `image/cache/`, `system/storage/download/` с файлами покупателей |

Предупреждение по объёму. `repositoryFiles` — 100 000 файлов (`packages/domain/src/git/publication.ts:28`), дерево — 1 ГиБ, `directories` — 20 000 (`packages/domain/src/site-connection/limits.ts`). У Битрикса с `bitrix/modules` эти пределы достижимы, и отказ `source_too_large` тогда будет у обычного сайта, а не у исключения. Цифру нужно измерить на настоящей установке.

### 3.3. Дерево агента

| Метод | Вызовы | WordPress | Общее и своё | Без метода |
| --- | --- | --- | --- | --- |
| `protectedPaths` | `packages/domain/src/git/working-set.ts:88` ← `pass-facts.ts:81` ← `:275` и `candidate-rebase.ts:238`; запасной путь `pass-facts.ts:84`; выпуск `release-skill.ts:704` (проверки `:684`, `:1154`) | `wordpress.ts:118`, 14 строк и списки | Общее — `phpServerConfigProtected`. Своё — ядро, конфигурация, медиа, файлы платформы | обязателен. Запасной путь зовёт его же и падает; в выпуске `#pathRules` вернёт `null`, и изменения считаются запрещёнными (`forbidden_path`) |
| `agentWorkingSet` | только `working-set.ts:89` | `wordpress-working-set.ts:32`, include три папки | Общее — весь `exclude`, кроме `wp-config*` и файлов платформы. Своё — `include`, то есть где живёт код клиента | `NOT_IMPLEMENTED` → **полное дерево** (ответ владельца от 19.10.2026). Для стека с полным импортом это ядро, медиа и упор в `working_set_too_large`. Уровень с импортом без этого метода выпускать нельзя |
| `mediaRules` | `working-set.ts:86`; `addOnlyPaths`: `release-skill.ts:707`, `undo-planner.ts:227`, `candidate-builder.ts:235`, `release-api.service.ts:260` | `wordpress-working-set.ts:53`: 10 расширений с сигнатурами, `refusedNameParts`, предел | Всё общее, кроме `addOnlyPaths` | `NOT_IMPLEMENTED` ловят все четыре места: медиа нельзя добавить, отмена выпуска удаляет то, что выпуск добавил |

Где код клиента (CMS): Битрикс — `local/`, `bitrix/templates/`, `bitrix/php_interface/init.php` и **страницы-файлы** в корне (`/about/index.php`), поэтому `include` нельзя задать только папками; Joomla — `templates/`, `components/com_*`, `modules/mod_*`, `plugins/`, `media/`; MODX — `assets/`, `core/components/`, но см. раздел 8 о коде в базе; OpenCart — `catalog/view/theme/`, `extension/` (4.x), `catalog/controller/`.

### 3.4. Выпуск

| Метод | Вызовы | WordPress | Общее и своё | Без метода |
| --- | --- | --- | --- | --- |
| `verify` | `release-api.service.ts:276`; в манифест идут `pages`, `failureMarkers`, `recordPages`; `logFiles` и `screenshots` не читает никто | `wordpress-verify.ts`, 48 строк | Общее — расчёт пути главной и маркеры `<b>Fatal error</b>:`, `<b>Parse error</b>:`. Своё — страницы ошибки CMS и `recordPages` | `NOT_IMPLEMENTED` → `pages: ['/']` и пустые маркеры: сайт, который отдаёт 200 со страницей ошибки CMS, пройдёт проверку и выпуск не вернётся. Для уровня с выпуском метод обязателен |

Остальной выпуск адаптера не касается: `deploy-step` работает по манифесту и `HostingWriter`, плагин нужен только для плана БД и сброса кеша опкодов (`apps/core/src/deploy-step/deploy.ts:227`).

### 3.5. Предпросмотр

Порядок сборки `buildPreviewOn` (`apps/core/src/previews/preview-builder.ts:561`): `facts.hasDatabase` → `no_database` (`:573`), затем `databaseSettings` (`:597`), `previewRecipe` (`:616`), `requiredPaths` → `no_core` (`:621`), образ (`:622`), копия базы по политике (`:645`), контейнер, файлы, загрузка копии, `recipe.content` (`:749`).

Следствие: `recipe.database: null` в схеме есть, но сборка до него не дойдёт. Стек без строки `site_databases` получает `no_database` раньше. Значит, для всех четырёх CMS база в мастере обязательна, если нужен предпросмотр, хотя мастер считает её необязательной.

| Метод | Вызовы | WordPress | Общее и своё | Без метода |
| --- | --- | --- | --- | --- |
| `databaseSettings` | `preview-builder.ts:280` внутри `withRoot`; исключения глотает `apps/core/src/previews/site-sources.ts:215` | `wordpress-db-copy.ts:59`, 17 строк + `:43` кодировка | Своё — файл и шаблоны. Общее — `phpStringsAfter`, `single()`, запасной путь по каталогу базы `databaseSettingsFromCatalog` | `null` → каталог базы. Запасной путь зовёт `databaseCopyPolicy`; если и там заглушка → `not_supported`. Так работает Битрикс сейчас (`bitrix.ts:132`) |
| `previewRecipe` | `preview-builder.ts:616`, `preview-manager.ts:349` | `wordpress-preview.ts:81`, 128 строк; файлы `infra/wordpress`: `preview-wp-config.php` 111, `raditi-preview.php` 208, `preview-apache.conf` 91 | Общее — выбор версии PHP, почти вся конфигурация Apache, переписывание адресов. Своё — `requiredPaths`, `generatedFiles`, `settings`, правила перезаписи URL, `content` | любое исключение → `not_supported`, текст клиенту «Для сайтов этого типа предпросмотр пока не работает.» (`client-feed-labels.ts:716`), агенту «Change files only.» (`turn-instructions.ts:78`) |
| `databaseCopyPolicy` | `preview-builder.ts:286`, `:645` | `wordpress-db-copy.ts:268`, с списками 358 строк | Механика общая (`mysql-copier`, `policy-sql`, `nested-secrets`). Своё — весь список таблиц и строк | на `:286` → `not_supported`; на `:645` не пойман: при заданном `databaseSettings` сборка кончится `failed` вместо понятного `unavailable` |

Что обязан сделать рецепт и чего договор не называет. Эти требования живут только в `raditi-preview.php` и нигде не проверяются для другого стека:

- не отправлять почту, в том числе через SMTP-расширения: интернет предпросмотра открыт (план 58);
- не запускать планировщик CMS;
- закрыть индексацию;
- подставить адрес предпросмотра вместо адреса сайта в теле, заголовках `Location`, `Link`, `Refresh`, в JSON и в URL-кодированном виде (`raditi-preview.php:90`–`:205`), но не в данных, которые потом сохранятся;
- отключить копию плагина платформы, если он установлен как обычное расширение;
- привязать учётную запись платформы и `site_id` плагина к предпросмотру через `overrides` политики.

Чем отличаются CMS (CMS):

| | Генерируемая конфигурация | Почта и планировщик | Перезапись URL | Люди в базе |
| --- | --- | --- | --- | --- |
| Битрикс | `bitrix/.settings.php`, `bitrix/php_interface/dbconn.php`, плюс лицензия | `b_event`, агенты `b_agent` на хитах | `urlrewrite.php`, 404 → `bitrix/urlrewrite.php` | `b_user`, `b_sale_*`, инфоблоки с формами, таблицы `b_form_*` |
| Joomla | класс `JConfig` в `configuration.php`: значения можно брать в конструкторе | `mailonline = false`, ленивый планировщик | `RewriteRule .* index.php` | `#__users`, `#__session`, `#__contact_details`, расширения |
| MODX | `core/config/config.inc.php`, `config.core.php` в корне, `manager/`, `connectors/` | настройка `mail_use_smtp`, `emailsender` | `index.php?q=$1` | `users`, `user_attributes`, `manager_log` |
| OpenCart | `config.php` и `<admin>/config.php` с абсолютными `DIR_*` и `HTTP_SERVER` | `config_mail_engine` в `oc_setting`, `oc_cron` | `index.php?_route_=$1` | `oc_customer*`, `oc_order*`, `oc_address`, `oc_return` |

Схема `databaseCopyPolicySchema` держит 64 таблицы и точные имена без шаблонов (`packages/domain/src/preview/recipe.ts:238`). OpenCart и Joomla в это укладываются. У Битрикса свойства инфоблоков в отдельных таблицах называются по номеру инфоблока (`b_iblock_element_prop_s<N>`, CMS): такие таблицы политика заранее не назовёт, и данные в них не скопируются.

### 3.6. Операции БД

| Метод | Вызовы | WordPress | Общее и своё | Без метода |
| --- | --- | --- | --- | --- |
| `dbOperationKinds` | `release-skill.ts:721`, `preview-builder.ts:235` | `wordpress-db.ts:10`, 3 строки | Своё. Новой CMS в первой итерации — `[]` | заглушка ловится всюду → план отклоняется. Правильно вернуть `[]`, как `bitrix.ts:142` |
| `dbSettings` | `release-skill.ts:957`, `candidate-builder.ts:333`, `preview-builder.ts:236`, `apps/mcp/src/content/content.module.ts:128` | `wordpress-db.ts:14`, 6 настроек | Своё: закрытый список. Новой CMS — `[]` | у `mcp` не пойман; вернуть `[]` |
| `dbPlanGuide` | `pass-facts.ts:317` → `turn-instructions.ts` (`{{database}}`) | `wordpress-db.ts:81`, текст | Своё. Новой CMS — `''` | **не пойман**: падает подготовка прохода. Вернуть `''` |

Эти три метода безопасно отвечать пустым значением, как уже делает `bitrix.ts:142`–`:150`. Заметьте: общий текст инструкций в `turn-instructions.ts:33`–`:53` всё равно говорит агенту про `posts and pages`, `theme`, `plugins`, `options`. Для другой CMS эти строки надо переписать словами стека или вынести.

### 3.7. Браузер агента на предпросмотре

| Метод | Вызовы | WordPress | Общее и своё | Без метода |
| --- | --- | --- | --- | --- |
| `browserRequestDenied` | `apps/mcp/src/browser/mcp-browser.ts:590` (каждый запрос страницы), `:638` (навигация) | `wordpress-browser.ts:83`, 108 строк + `wordpress-mcp-policy.ts` | Общее — `segmentsOf`, отказ на всё нечитаемое, правило для медиа. Своё — пути админки и AJAX | заглушка `true` (`bitrix.ts:152`): браузер агента не откроет ничего, `BROWSER_PATH_DENIED`; семейство `browser` при этом предлагается (`apps/mcp/src/access/mcp-policy.ts:162`) |

В копии нет людей, поэтому политика здесь проще живой: можно закрыть админку целиком плюс медиа, кроме того, чем рисует страница. Метод получает только запрос и не получает сайт, поэтому переименованную админку он не увидит.

### 3.8. Браузер задачи на живом сайте

Все вызовы — в `apps/browser`, кроме гида и `startPath`. Этот набор — полный минимум уровня «только браузер».

| Метод | Вызовы | WordPress | Общее и своё | Без метода |
| --- | --- | --- | --- | --- |
| `browserTaskPolicy` | `apps/browser/src/sessions/session-manager.ts:183`, `apps/mcp/src/site-info/browser-tasks.ts:26` | `wordpress-browser-task.ts:527`; политика занимает строки 95–505 и опирается на `wordpress-mcp-policy.ts` (402) | Общее — чтение запроса как PHP (`phpName`, `multipartFields`, `jsonFields`, `bodyFields`, `readRequest`, строки 95–190), отказ на всё нечитаемое. Своё — `startPath`, `extraHosts`, закрытые экраны и действия, `signIn` | 501 от `apps/browser` → три повтора (2, 8, 35 с) → `BROWSER_SESSION_UNAVAILABLE` → проход закрыт кодом `unavailable` (`apps/core/src/tasks/pass-runner.ts:269`). `site_info` только теряет `startPath` |
| `browserCheckpointOf` | `worker-session.ts:582` | `wordpress-browser-task.ts:564`, 20 строк | Своё: адрес редактора объекта → `{kind, objectId, editUrl}` | исключение → `null`. Объект не записывается, повторная публикация и предел в 20 объектов не работают для него (`#overChangeLimit`) |
| `browserCommitAction` | `worker-session.ts:1201`, `:1219` | `wordpress-browser-task.ts:622`, таблица кнопок RU и EN, 40 строк | Общее — `commitName`. Своё — названия кнопок | **не пойман**: падает каждый клик. Ответ `null` на всё ещё хуже: сохранения не считаются, защита от дубликата и предел правила 4 молча выключены |
| `browserVerification` | `worker-session.ts:1368` | `wordpress-browser-task.ts:765`, с разбором 130 строк | Своё: как прочитать объект куками сессии, до 4 GET, разбор чистой функцией | план без шагов → `unreadable` (`packages/browser-providers/src/cloud/verification.ts:102`); объект остаётся `unverified`, и следующие сохранения блокирует `BROWSER_CHECKPOINT_UNVERIFIED`. С ответа владельца от 26.10.2026 подтверждение не условие завершения, но лента не скажет, что сделано |
| `browserGuide` | `pass-facts.ts:381` | `wordpress-browser-task.ts:794`, 53 строки текста | Своё целиком | `NOT_IMPLEMENTED` → `null`, агент получает только общие правила `BROWSER_RULES` |

Вывод: `browserCommitAction` и `browserCheckpointOf` — не удобство, а носители правила 4 в задаче браузера. Заглушка с `null` выглядит безопасной, а на деле снимает предел. Этого не поймает ни один текущий тест, потому что второго стека нет. Нужен общий контрактный тест.

Особенности (CMS):

| | Старт и вход | Редактор объекта | Чтение объекта |
| --- | --- | --- | --- |
| Битрикс | `/bitrix/admin/`; `USER_LOGIN`, `USER_PASSWORD`; форма входа открывается **на любом** адресе админки | `iblock_element_edit.php?IBLOCK_ID=…&ID=…`; страницы-файлы — `fileman_html_edit.php` | только HTML редактора или публичная страница |
| Joomla | `/administrator/index.php`; `#mod-login-username`; вход на том же адресе, что и панель | `option=com_content&view=article&layout=edit&id=N`, открытие через `task=article.edit` блокирует статью | HTML формы; API требует токен, а не куки |
| MODX | `/manager/`, папку переименовывают; `#modx-login-username` | `?a=resource/update&id=N` | коннекторы менеджера с `HTTP_MODAUTH` из страницы (подходит `fromStep`) |
| OpenCart | `/admin/`, папку переименовывают; `input[name=username]` | `route=catalog/product.form&user_token=…&product_id=N`: **токен сессии в адресе** | публичная страница `route=product/product&product_id=N` |

Требования к закрытым экранам — раздел 8, пункт 9; токен OpenCart — там же, пункт 8.

## 4. `SiteContentAdapter` и шлюзы

### `SiteContentAdapter`

| Член | Вызовы | WordPress | Общее и своё | Без него |
| --- | --- | --- | --- | --- |
| `stack` | никто не читает | `'wordpress'` | — | ничего |
| `accessKind` | `packages/site-content/src/site-content-resolver.ts:107`, `:116`; `apps/mcp/src/content/preview-content.ts:121`; `apps/core/src/previews/preview-builder.ts:757`; `apps/core/src/release-api/release-api.service.ts:407`; `apps/core/src/releases/releases.module.ts:69` | `'wp'` | Вид доступа в Vault, см. раздел 6 | адаптер не найден → см. ниже |
| `accessSchema` | `site-content-resolver.ts:162`; `packages/site-content/src/preview-content-gateway.ts:21`; `apps/core/src/previews/preview-content.ts:83`; `apps/mcp/src/content/preview-content.ts:138`; `apps/core/src/deploy-step/cli.ts:70` | `{v, origin, username, applicationPassword}` (`wordpress-content.ts:591`) | Своё: у других CMS нет паролей приложений. Логичнее общая схема `{v, origin, token}` с проверкой на стороне плагина | — |
| `createGateway` | `site-content-resolver.ts:175`; `preview-content-gateway.ts:22`; `deploy-step/cli.ts:88` | класс на 400 строк | См. ниже: почти всё общее | `refused('adapter')` |
| `createCodeCache?` | `deploy-step/cli.ts:94` → `deploy.ts:231` | тот же класс | Общее для PHP: кеш опкодов читается одинаково | исключение ловит `codeCachePlan` → обычная пауза (`deploy.ts:233`) |

Что будет без адаптера вовсе (`getSiteContentAdapter` бросает `NOT_IMPLEMENTED`):

| Место | Исход |
| --- | --- |
| резолвер `site-content-resolver.ts:100` | `refused('stack')`; шлюз сайта недоступен |
| сборка предпросмотра, `production` (`preview-builder.ts:602`) | пойман: `production = null`, версия PHP по умолчанию, только тексты |
| сборка предпросмотра, `recipe.content` (`preview-builder.ts:750`) | **не пойман**: при непустом `recipe.content` сборка `failed`. Пока адаптера нет, рецепт обязан давать `content: null` |
| `release-api.service.ts:407` | пойман: `content: null`, выпуск файлов идёт, кеш опкодов — обычная пауза |
| `release-skill.ts` `#contentAccessKind` | `null`; выпуск с планом БД отказывает, без плана идёт |
| `mcp` | семейство `content` стек не проверяет (`mcp-policy.ts:162`): инструмент объявлен и отказывает при вызове. В production закрыто профилем `off` |

### `PublishedContentGateway`

| Метод | Вызовы | WordPress | Что от CMS | Без него |
| --- | --- | --- | --- | --- |
| `read` | `apps/mcp/src/content/mcp-content.ts:381`, `:738`, `:774`, `:778`, `:1091`, `:1102`; `apps/core/src/previews/preview-content.ts:127`; `release-skill.ts:938`; `undo-planner.ts:379`; `deploy.ts:1013`, `:1399` | GET `/raditi/v1/content/<id>`, сверка хеша | Плагин: прочитать запись и собрать те же байты хеша, что `publishedContentHashMaterial` (`published-content.ts:42`) | весь контент |
| `conditionalWrite` | `mcp-content.ts:978`; `preview-content.ts:184`; `deploy-step/content.ts:217` | POST, квитанция | Плагин: сравнить состояние и записать квитанцию **атомарно**, вне хуков CMS, в режимах `edit`, `restore`, `release` | весь контент |
| `operation` | **нет вызовов** в продукте | GET `/operations/<id>` | Можно не делать | ничего |
| `reconcileOperation` | `mcp-content.ts:262`; `deploy-step/content.ts:233` | POST `…/reconcile` | Плагин: долговременное «не закоммичено» под той же блокировкой | неизвестный исход не закрывается, сайт удерживается |
| `forgetOperation` | `apps/mcp/src/content/mcp-content-maintenance.ts:176` | POST `…/forget` | Плагин | квитанции копятся, сборщик считает `failed` |
| `runtime?` | `preview-builder.ts:199` | GET `/runtime` | Плагин: версия PHP и расширения | версия PHP неизвестна → значение по умолчанию рецепта |

### `SiteDbGateway`

Есть только у стека, чей плагин умеет план БД (`gateway.db`). Новой CMS в первой итерации не нужен: при `db === undefined` выпуск отказывает `plugin_outdated` только для плана не из `content_update` (`deploy.ts:469`), а `previewDbRuntime` даёт «только тексты».

| Метод | Вызовы | Что от CMS |
| --- | --- | --- |
| `capabilities` | `preview-builder.ts:211`; `release-skill.ts:913`; `deploy.ts:472`, `:497`; `mcp-content.ts:648` | права учётной записи плагина, `maxRecordId` |
| `readObject` | `release-skill.ts:939`; `undo-planner.ts:323`, `:381`; `deploy.ts:1014`, `:1422`, `:1462`, `:1491`, `:1543`; `deploy-step/content.ts:353`; `preview-content.ts:126`; `mcp-content.ts:597`, `:670`, `:729`, `:1120` | запись, настройка, таблица, «отсутствует», каждый со своим хешем (`db-objects.ts`) |
| `slugTaken` | `release-skill.ts:932`; `deploy.ts:1106` | адрес записи занят. В Битриксе и OpenCart адрес живёт иначе |
| `dependents` | `undo-planner.ts:326`; `deploy.ts:1017` | сколько объектов стоит на записи: комментарии, дочерние, пункты меню |
| `writeObject` | `deploy-step/content.ts:327`; `preview-content.ts:217`; `mcp-content.ts:982`, `:988`, `:998`, `:1004` | вид изменения `option_update`, `post_create`, `post_trash`, `post_untrash`, `schema_migration` |
| `operation` | `undo-planner.ts:314`; `deploy.ts:1534` | квитанция по `callId` |
| `reconcile` | `deploy-step/content.ts:363`; `deploy.ts:1533` | как у контента |
| `fence` | `deploy.ts:498` | поднять ограду эпохи, больше ничего не писать |

### `SiteCodeCacheGateway`

`codeCache` — `deploy.ts:232`, `refreshCode` — `deploy.ts:266`. Поля `opcache`, от CMS не зависит. Если плагина нет, `codeCachePlan` даёт `defaultPlan` с `timesTrusted: true` (`deploy.ts:209`). Значит, на сайте без плагина и с `opcache.validate_timestamps=0` проверка выпуска может смотреть старый код. Эта дыра есть уже у WordPress.

### Что в шлюзе WordPress на самом деле WordPress

`WordpressPublishedContentGateway` (`packages/site-adapters/src/wordpress-content.ts:177`) — протокол `/raditi/v1`, схемы и проверка квитанций. От WordPress в нём три вещи:

1. адрес: `?rest_route=<маршрут>` (`:556`);
2. авторизация: `Basic` с паролем приложения (`:227`) и код `rest_no_route` для старого плагина (`:574`);
3. `['post', 'page']` в `#slugTaken` (`:412`) и `recordRefSchema = publishedObjectRefSchema` (`:128`).

Если плагины других CMS отвечают тем же протоколом, класс переносится почти целиком. Параметры: как построить URL, какой заголовок авторизации, как узнать «маршрута нет».

Со стороны PHP: `infra/wordpress/raditi-content.php` — 1 420 строк. По оглавлению функций журнал операций, ограда, код-кеш, runtime, словарь таблиц и DDL (`:162`–`:298`, `:433`–`:498`, `:977`–`:1365`) работают через `mysqli` и опции, а не через модель записей WordPress. Их можно вынести в общее PHP-ядро с тонким мостом к CMS: база, хранение состояния, права. Запись контента и создание записей (`:298`–`:433`, `:692`–`:905`) пишутся для каждой CMS заново. Это оценка по оглавлению, тела функций прочитаны выборочно.

## 5. Общий код

### Уже общее

| Файл | Что даёт | Границы |
| --- | --- | --- |
| `packages/site-adapters/src/php-config.ts` | `phpStringsAfter`, `phpConfigStrings`, `secretValues`: чтение постоянных строк PHP без запуска | Подходит всем четырём: `define('DB_PASSWORD', '…')` (OpenCart), `$database_password = '…';` (MODX), `public $password = '…';` (Joomla), ключ `password` в массиве настроек (Битрикс). Значение не в UTF-8 отбрасывается (`fromByteString`, `:35`): пароль в cp1251 не попадёт в точный поиск. Предел файла 256 КиБ, строка до 4 КиБ |
| `packages/site-adapters/src/php-hosting.ts` | `phpServerConfigFiles`, `phpServerConfigProtected`, `archivesAndDumps`, `secretFiles`, `dataFiles`, `serverLogs` | Общие для PHP-хостинга. В `archivesAndDumps` есть метка WordPress `*.wpress` и Akeeba `*.jpa`: Akeeba как раз Joomla, так что список уже межстековый |
| `packages/site-adapters/src/http-transport.ts` | `fetchSiteTransport`: один запрос, без редиректов, пределы времени и размера | Полностью общий. Адреса не проверяет: роли, которые ходят к сайтам клиентов, подставляют свой транспорт (`createPinnedSiteTransport` в `deploy-step/cli.ts:41`) |

### Что вынести из `wordpress*.ts`

| Откуда | Что | Куда |
| --- | --- | --- |
| `wordpress.ts:74`, `bitrix.ts:23` | `buildOutput` и `anchored`: дублируются | `php-hosting.ts` |
| `wordpress-working-set.ts:51`–`:78` | таблица сигнатур медиа, `refusedNameParts`, `maxFileBytes` | общие `phpMediaRules(addOnlyPaths)` |
| `wordpress-working-set.ts:34` | `exclude` без `wp-config*` | `phpWorkingSetExcludes` |
| `wordpress-preview.ts:18`–`:38` | `versionNumber`, сортировка версий по близости | `php-runtime.ts`, список и значение по умолчанию на стек |
| `wordpress-verify.ts:17`, `:33` | маркеры PHP, расчёт пути главной | `php-verify.ts` |
| `wordpress-db-copy.ts:32`, `:78`, `:80` | `single`, `literal`, `fromGlob` | `sql-patterns.ts` |
| `wordpress-db-copy.ts:86` | ключи секретов: `*credential*`, `*license*`, `*session*`, `*nonce*`, `*pwd*`, `*pass` и паттерны из политики | общий список |
| `wordpress-browser.ts:29`, `:45` | `segmentsOf`, шаблон «медиа, кроме того, чем рисует страница» | `browser-paths.ts` |
| `wordpress-browser-task.ts:95`–`:190` | чтение запроса как его читает PHP: `phpName`, `multipartFields`, `jsonFields`, `bodyFields`, `readRequest`; `lastValue`, `plainSegment`, `commitName` | `php-request.ts`. Это нужно всем четырём, и ошибка здесь — обход политики |
| `infra/wordpress/preview-apache.conf` | всё, кроме блока `RewriteRule` | шаблон с подстановкой правил стека |
| `infra/wordpress/raditi-preview.php:90`–`:205` | переписывание адресов; от WordPress там только `wp_redirect`, `rest_pre_dispatch`, `is_admin`, `wp_doing_ajax`, `wp_load_alloptions` | общий PHP-файл через `php_admin_value auto_prepend_file` в конфигурации Apache, которую платформа и так пишет сама. Тогда это не файл в дереве сайта, и агент его не трогает |
| `packages/site-adapters/scripts/embed-wordpress-files.mjs` | вложение файлов в строковые константы | общий скрипт на все стеки |

Отдельно: `wordpress-mcp-policy.ts` в продукте нужен только браузеру (`isAdminUrlDenied`, `isAdminAjaxActionDenied`, `isRestRequestDenied`) и копии базы (`protectedOptions`). `isWpCliCommandDenied` читает лишь стенд `infra/dev/site-verify/verify-site.mjs`. Часть про `wp_cli` образцом для других стеков не служит.

## 6. WordPress вне адаптера

| Где | Что прошито | Что нужно другой CMS |
| --- | --- | --- |
| `packages/domain/src/ports/published-content.ts:4` | `publishedObjectRefSchema` `^(post\|page):…`, `kind: z.enum(['post','page'])` (`:23`); `apps/core/src/previews/preview-content.ts:100` разбирает объекты этой схемой | Расширить. `dbRecordRefSchema` (`db-objects.ts:30`) уже общий: `<тип>:<id>`. Комментарий там говорит «nothing here knows a stack», а схема контента знает |
| `published-content.ts:10` | поля `title`, `content`, `excerpt`, одна запись — один язык | У OpenCart описание товара по строке на язык (`oc_product_description`), у Joomla — ассоциации языков, у Битрикса `PREVIEW_TEXT` и `DETAIL_TEXT` (CMS) |
| `apps/mcp/src/content/content-arguments.ts:22`, `apps/mcp/src/access/mcp-policy.ts:39`, `apps/mcp/src/content/mcp-content.ts:368`, `apps/mcp/src/content/mcp-content.controller.ts:50` | инструмент `wp_rest`, маршруты `/wp/v2/(posts\|pages)`, разбор `parts[3]`, описание для модели | Либо общий инструмент `site_content` с `objectRef`, либо описание инструмента от адаптера |
| `apps/core/src/tasks/turn-instructions.ts:33`–`:53` | слова `posts and pages`, `theme`, `plugins`, `options` | Подстановка из адаптера |
| `packages/domain/src/browser/checkpoint.ts:19` | `browserCheckpointKinds = ['post']`; статусы `publish`, `draft`, `pending`, `private`, `future`, `trash` | Новый вид, например `product`, и слово в ленте (`FEED_KIND`, `:109`). Статусы адаптер может отображать в эти |
| `packages/domain/src/ports/site-adapter.ts:95`, enum `CredentialKind` (`packages/db/prisma/schema.prisma:465`), `packages/trpc/src/routers/project.ts:121`, `infra/vault/policies/mcp-content.hcl:2`, `:8`, `infra/vault/policies/core-release.hcl:5` | вид доступа `wp` | Либо новый вид (`cms`): миграция enum и три места политик и кода, либо оставить `wp` с вводящим в заблуждение именем. Решить до первого плагина |
| `infra/preview/Dockerfile:8` и `apps/core/src/previews/preview-builder.ts:343` | база `wordpress@sha256`, WP-CLI, одна карта `PREVIEW_SITE_IMAGES` версия → образ на все стеки | Нейтральная база PHP с полным набором расширений либо `recipe.imageFamily` и карта по семействам. У образа `wordpress` нет `pdo_mysql` (CMS), а MODX он нужен |
| `infra/sandbox/Dockerfile:1`, `apps/core/src/config/config.ts:72` | образ песочницы `sbx-wordpress` | Только имя: песочница от стека не зависит, проверить в карте образов |
| `packages/domain/src/release/env-vars.ts:28` | `WP_` среди запрещённых префиксов | Добавить свои префиксы, если генерируемая конфигурация читает переменные |
| `packages/site-connections/src/sources/root-check.ts:51` | `wordpress`, `wp` в `LIKELY_ROOTS` | Только порядок подсказки, безвредно |
| `apps/web/src/components/projects/project-labels.ts:1` | подписи стеков | Добавить новые |

Что **не** прошито и уже годится: `recordPages` и `content.pages` с `{id}`, `DatabaseCopier` и `scrub_secrets` (сериализация PHP и JSON), `HostingWriter`, `deploy-step`, `verifyRecordPageSchema`, `php_lint` (`.php`, `.phtml`, `.inc`; шаблоны `.twig` и `.tpl` не проверяет, их ловит только `preview_smoke`), `activateSite` (стек не сравнивает).

## 7. Уровни поддержки

Уровни складываются снизу вверх, но первый от остальных независим.

| Уровень | Что получает клиент | Методы `SiteAdapter` | Вне адаптера | Объём у WordPress |
| --- | --- | --- | --- | --- |
| **0. Стек известен** | ничего | `stack`, заглушки | enum, `siteStacks`, подпись, запись в реестре | — |
| **1. Только браузер** | задачи в админке живого сайта, без кода и `/release` | `browserTaskPolicy`, `browserCheckpointOf`, `browserCommitAction`, `browserVerification`, `browserGuide` | мастер пускает `access: 'browser'` по стеку, вид объекта в ленте, контрактный тест политики | ~1 300 строк: 847 + 402 + часть из 108 |
| **2. Импорт и ходы** | копия сайта в git, агент меняет файлы; `/release` сейчас открыт сразу, его надо закрыть до уровня 3 | + `rootMarkers`, `importRules`, `configSecrets`, `publicOriginals?`, `protectedPaths`, `agentWorkingSet`, `mediaRules`, `dbOperationKinds: []`, `dbSettings: []`, `dbPlanGuide: ''`, `verify` | объявленный уровень, который запрещает `/release` без предпросмотра | ~300 строк |
| **3. Предпросмотр** | клиент видит результат до выпуска | + `databaseSettings`, `previewRecipe` с `content: null`, `databaseCopyPolicy`, `browserRequestDenied` | образ, рецепт Apache, генерируемая конфигурация, база обязательна в мастере | ~1 000 строк, из них 410 PHP и конфигурация |
| **4. Выпуск файлов** | `/release` с проверкой и возвратом | ничего нового, если `verify` готов | сброс кеша CMS (раздел 8), стенд выпуска по стеку | 48 строк |
| **5. Контент через плагин** | правки записей с журналом и откатом | `SiteContentAdapter`, `PublishedContentGateway`, `recipe.content` | плагин на сайте, путь его установки, вид доступа, обобщение `wp_rest` и `publishedObjectRefSchema`, снятие запрета `off` | ~2 000 строк, из них 1 420 PHP |
| **6. Операции БД** | настройки, новые записи, таблицы в `/release` | `dbOperationKinds`, `dbSettings`, `dbPlanGuide`, `SiteDbGateway`, `createCodeCache` | обратные операции, стенд S8 и S9 по стеку | часть уровня 5 |

Какие методы **не нужны** на минимальном уровне 1: все, кроме пяти `browser*`. Это проверено по коду: `adapter` для задачи без репозитория не запрашивается (`pass-facts.ts:274`), сайт `access: 'browser'` не проходит импорт (`project.ts:520`), а политика читается только в `apps/browser` и `site_info`.

Порядок, который следует из этого:

1. Уровень 1 для всех четырёх: это весь контент, а в Joomla, OpenCart и MODX контент и живёт в базе.
2. Уровни 2–4 одним блоком на стек. По отдельности они не включаются без объявленного уровня. Выгоднее всего Битрикс и OpenCart: код у них в файлах, хотя у Битрикса есть оговорки по размеру и лицензии. Хуже всего MODX (раздел 8, пункт 4).
3. Уровни 5 и 6 отложить, пока владелец не решит, как плагин попадает на сайт. У WordPress этого пути тоже нет.

Оценка объёма на одну CMS при вынесенном общем коде (оценка, не замер): уровень 1 — 500–800 строк TypeScript и столько же тестов; уровни 2–4 — 400–600 строк TypeScript и 200–300 строк PHP и конфигурации.

## 8. Чего нет в договоре

1. **Объявленный уровень поддержки.** Сейчас его заменяют `connectableStacks` и исключения. Нужно одно значение на стек, которое читают мастер (`assertSiteAccepted`), `siteCapabilities`, `/release` и инструкции хода. Это же заменит девять мест с ловлей `NOT_IMPLEMENTED`: разделы договора станут необязательными полями адаптера.
2. **Адрес админки.** `BrowserTaskSite` — только `url`, `browserRequestDenied` — только запрос, поля в `Site` нет. OpenCart и MODX часто переименовывают папку (CMS). Варианты: поле `sites.admin_path` из мастера или адрес по `agent_notes`. Без него `startPath` неверен, а политика, построенная по пути, не закрывает ничего. Опасный случай: админка под другим именем проходит мимо закрытого списка; список разрешённого здесь надёжнее.
3. **Сброс кеша CMS после выпуска.** `SiteCodeCacheGateway` знает только опкоды, а `CODE_PATH` — только PHP (`deploy.ts:194`). MODX держит собранные элементы в `core/cache`, OpenCart — модификации в `system/storage/modification` и кеш Twig, Битрикс — `bitrix/managed_cache` и композит, Joomla — `cache/` (CMS). После записи файлов сайт покажет старое, и проверка выпуска пройдёт по старому. Нужен метод вроде `postDeployPaths`: что удалить на хостинге по SFTP. Он работает без плагина.
4. **Код в базе у MODX.** Шаблоны, чанки, сниппеты и плагины лежат в таблицах `site_templates`, `site_htmlsnippets`, `site_snippets`, `site_plugins`, пока их не вынесли статическими файлами (CMS). Рабочий набор из файлов на таком сайте почти пуст, а `dbOperationKinds` этого не переносят. Для MODX уровни 2–4 без нового вида операции дают мало. То же в меньшей мере у OpenCart: модификации OCMOD лежат в `oc_modification`.
5. **Папки предпросмотра.** `importRules` исключает кеши, а `writePreviewTree` пишет только файлы. Joomla (`tmp/`, `administrator/logs/`) и OpenCart (`system/storage/cache/`, `session/`, `logs/`) рассчитывают, что эти папки есть (CMS), и без них могут отдавать ошибки. Обойти можно пустыми файлами в `generatedFiles`, но там всего 16 путей (`recipe.ts:149`). Лучше поле `writableFolders` в рецепте.
6. **Версия PHP без плагина.** `runtimeVersion` приходит только от `gateway.runtime()` на проде (`preview-builder.ts:613`). На настоящем сайте плагина нет, и рецепт берёт значение по умолчанию. `siteImage` перебирает версии только по наличию образа, а не по тому, запустилось ли. Старая установка на PHP 8.3 может не подняться (CMS), и узнаем мы об этом только по сбою `preview_smoke` или сборки. Нужно читать версию CMS через `read` (`libraries/src/Version.php`, `core/docs/version.inc.php`, `index.php` с `VERSION`, `bitrix/modules/main/classes/general/version.php`) и выводить из неё диапазон PHP.
7. **Определение входа.** `isSignInPage(path)` решает только по адресу (`cloud-browser.ts:1306`). У Битрикса и Joomla форма входа открывается на тех же адресах, что и рабочие экраны (CMS): проверка даёт `true` и после входа, и заполнение ждёт поля до таймаута. Нужно решать по наличию поля формы.
8. **Токен в адресе OpenCart.** `user_token` стоит в каждой ссылке админки (CMS). `BrowserCheckpointRef.editUrl` — «адрес, который откроет редактор снова», а `BrowserVerificationStep.path` статичен: `fromStep` подставляется только в заголовки (`checkpoint.ts:189`). `redact` скроет токен от модели, но адрес без него не откроется. Для OpenCart нужны `editUrl` без токена с подстановкой при открытии либо чтение по публичной странице.
9. **Закрытые экраны.** Вопрос плана 57 «закрытый список или список разрешённого» для WordPress открыт (`docs/plan/57-browser-tasks.md:379`). Для OpenCart и Битрикса ответ почти вынужденный: разрешать маршруты редакторов контента, а остальное закрывать. Заказы, клиенты, письма, платёжные настройки и резервные копии лежат в тех же разделах, а закрытый список их не удержит.
10. **Кодировка.** Старые сайты Битрикса в cp1251 (`BX_UTF` не задан, CMS). Копия базы это выдержит (`charset`), но `php-config` такие значения отбрасывает, а поток событий, диффы и текст модели рассчитаны на UTF-8. Нужен отказ `encoding_unsupported` в мастере, а не сбой посреди хода.
11. **Лицензия и домен.** Битрикс проверяет лицензионный ключ (`bitrix/license_key.php`), а копия запускается на другом домене. Можно ли держать копию ядра в нашем репозитории и запускать предпросмотр — вопрос владельцу и юристу.
12. **Контрактный тест.** Общего набора «любой адаптер обязан» нет: свойства проверены только на WordPress. Нужны проверки: политика отказывает на нечитаемом, рабочий набор не включает конфигурацию, рецепт проходит схему, `browserCommitAction` узнаёт хотя бы одну кнопку, `importRules` и `protectedPaths` покрывают файлы конфигурации из `configSecrets`, `verify` даёт хотя бы один маркер.

## 9. Границы этого отчёта

- Читался код, ничего не запускалось.
- Путь отказа по заглушке `importRules` выведен из чтения `site-import.runner.ts`, стендом не проверен.
- Вывод о пустом `production`-шлюзе на настоящем сайте сделан по коду резолвера и поиску записи доступа `wp`; живая проверка не делалась.
- Тела функций `raditi-content.php` прочитаны выборочно; деление на переносимое и своё — по оглавлению.
- Сведения «(CMS)» о Битриксе, Joomla, MODX и OpenCart не сверены с их исходниками; пределы импорта для Битрикса нужно измерить на настоящей установке.
- Отмечено мимоходом и не разбиралось: `CLAUDE.md` говорит, что `activateSite` никто не вызывает, а вызов есть в `apps/core/src/site-provisioning/stage-store.ts:464`. Абзац о мастере устарел.
