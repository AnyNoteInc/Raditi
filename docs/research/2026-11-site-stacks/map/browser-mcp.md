# Карта: что в браузере задачи и в инструментах агента зависит от стека

Дерево: `raditi-stacks`, ветка `feat/site-stacks` (`c811abf1`). Все пути — от корня этого дерева. Главное — в разделе 0; дальше — разбор. Сведения о чужих CMS помечены: [и] — прочитано в исходниках 01.11.2026 (Joomla `6.2-dev`, релиз 6.2.0; OpenCart `4.1.x.x` и `3.0.x.x`, релиз 4.1.0.4; MODX `3.x`), [с] — сторонний источник, [п] — по памяти, проверить на установке. Битрикс закрыт, поэтому о нём только [с] и [п].

## 0. Главное

1. **Задача в браузере — самый дешёвый путь к четырём CMS: плагин и доступ к файлам ей не нужны.** Агент получает те же `site_info` и 14 `web_*`: `apps/mcp/src/web` стека не знает. Нужны пять методов адаптера и правки общего кода (раздел 11).
2. **Договор повторяет WordPress в четырёх местах, и каждое ломает работу при правильном адаптере** (раздел 10): форма входа определяется по адресу, объект — по адресу, проверка рассчитана на голый nonce, а политика знает только адрес сайта.
3. **OpenCart 4.1 в текущем договоре невозможен.** `user_token` обязателен в каждом адресе, а вход всегда ведёт на консоль с именами покупателей. Закрыть её нельзя (тупик), открыть — нарушить правило 1. Нужен новый механизм `sessionParameter` (раздел 10, п. 2).
4. **Разрешённый список возможен без правки договора и нужен всем четырём** (раздел 9). Закрытый список на переименованной админке открывает всё молча; разрешённый судит по `route=` и `a=`, а не по имени папки.
5. **Контентные инструменты привязаны к WordPress:** `wp_rest` — маршруты в схеме, `post|page` в домене, плагин на сайте. Без плагина стека их нет, а `SiteAdapter.mcpTools()` никто не вызывает (раздел 4).

## 1. Договор стека с браузером задачи

Все точки — методы `SiteAdapter` (`packages/domain/src/ports/site-adapter.ts:258-286`). Ядро стека не знает: `apps/browser` получает адаптер по `stored.stack` (`apps/browser/src/sessions/session-manager.ts:182`) и держит его в `SessionSpec` (`worker-session.ts:144`).

| Метод | Кто вызывает | Когда | Что будет, если метод бросит |
| --- | --- | --- | --- |
| `browserTaskPolicy(site)` | `SessionManager.#create` (`session-manager.ts:183`) | один раз на сессию | сессии нет; у `bitrixAdapter` сейчас `throw todo` (`bitrix.ts:156-158`) |
| `policy.requestDenied(req, by)` | `requestVerdict` (`packages/browser-providers/src/cloud/page-rules.ts:140`) | каждый запрос каждой страницы, для каждого метода из заголовков override | `denies()` читает исключение как отказ (`page-rules.ts:32-38`) |
| `policy.pageDenied(path, by)` | `requestVerdict`, `committedAllowed`, `openAllowed`, `WorkerSession.#mayOpen` | каждая навигация и каждый коммит кадра (редирект не маршрутизируется Playwright) | отказ; в `#mayOpen` — тоже (`worker-session.ts:892-905`) |
| `policy.signIn` | `CloudBrowserSession.signIn` (`cloud-browser.ts:1312`) | старт сессии и перед каждым действием агента (`worker-session.ts:359, 980`) | необязательное поле: без него `'absent'` |
| `browserCheckpointOf(url)` | `WorkerSession.#checkpointRef` (`worker-session.ts:579-586`) | каждая навигация, каждый коммит, каждый `#waiting` | `null`: «объекта нет» — исключение проглатывается |
| `browserCommitAction(role, name)` | `#commitOf` и `#pressCommit` (`worker-session.ts:1199-1220`) | каждый клик и нажатие Enter/пробела | не обёрнут: бросок идёт в `act` как отказ действия |
| `browserVerification(ref)` | `#verifyAll` (`worker-session.ts:1368`) | `web_verify` и `POST …/verify` из `core` | ловится `catch` в `#verifyAll`: `browser_checkpoint_read_failed`, состояние не меняется |
| `browserGuide()` | `browserFactsOf` в `core` (`apps/core/src/tasks/pass-facts.ts:381`) | сборка каждого прохода | `NOT_IMPLEMENTED` — `guide: null`, задача отклонена `not_accepted` (`turn-planner.ts:525`); другая ошибка летит наружу |
| `browserRequestDenied(req)` | браузер агента **на предпросмотре**, не браузер задачи (`apps/mcp/src/browser/mcp-browser.ts:590, 638`) | каждый запрос страницы предпросмотра и каждый `browser_navigate` | у Битрикса заглушка «закрыто всё» (`bitrix.ts:152-154`) |

Важное о форме договора:

- `BrowserTaskSite` — только `{ url }` (`site-adapter.ts:290-292`). Политика **не знает ничего, кроме адреса сайта**: ни префикса таблиц, ни имени каталога админки, ни заметок агенту. Для MODX и OpenCart это главный разрыв (разделы 7–9).
- `browserCheckpointOf`, `browserCommitAction`, `browserVerification`, `browserGuide` вообще не получают `site` — чистые функции стека. Адаптер не может узнать каталог админки конкретного сайта через них; но `browserCheckpointOf` читает это из самого адреса, а `editUrl` возвращается в `browserVerification` — так уже сделано у WordPress с подкаталогом (`siteFolderOf`, `wordpress-browser-task.ts:642-646`). Этот приём переносится на переименованную админку только если адрес сам называет каталог, то есть адаптер должен распознать каталог без конфигурации.
- `requestDenied` получает `path` с query, `method`, `postData`. Заголовков нет; единственное, что браузер из них извлекает, — override метода (`METHOD_OVERRIDE_HEADERS`, `page-rules.ts:98`). Cookie, `Referer`, тело не-текстовое — не видны. `postData === null` значит «нет тела **или не текст**» (`site-adapter.ts:330`, `cloud-browser.ts:424-428`). Это значит: multipart с файлом Playwright, скорее всего, отдаёт как `null` или ломаный текст — у WP из-за этого есть ветка «POST на медиа без тела — можно» (`wordpress-browser-task.ts:409-411`).
- Домен знает только `browserCheckpointKinds = ['post']` (`packages/domain/src/browser/checkpoint.ts:19`). Товара, инфоблока, статьи Joomla, ресурса MODX — нет. См. раздел 5.

## 2. Как WordPress-политика устроена: что надо будет воспроизвести

`wordpressBrowserTaskRequestDenied` (`packages/site-adapters/src/wordpress-browser-task.ts:492-505`) — **закрытый список** поверх открытого по умолчанию: `return restDenied(read) ?? false`. Всё, что не названо, открыто. Порядок проверки:

1. `readRequest` (`:166-188`) — путь с одним `/`, тот же origin, декодированные сегменты в нижнем регистре, поля query и тела **под именем PHP** (`phpName`, `:101-107`: `action[]` → `action`, пробел и точка → `_`). Тело разбирается как JSON, multipart или urlencoded (`bodyFields`, `:148-154`). Нечитаемое → отказ. Это общая для всех PHP-CMS часть, но лежит она внутри файла WordPress и не экспортируется.
2. Исключение `clientTrash` для `by === 'user'` (Б37, `:461-483`, `:498`) — корзина записи и страницы.
3. Любой `DELETE` закрыт (`:499`).
4. `isAdminUrlDenied` — список страниц из `wordpressMcpPolicy.admin.deniedPages` (`wordpress-mcp-policy.ts:197-243`), через сегмент `wp-admin` (`:381`).
5. `uploadDenied` — документы медиатеки, `siteScriptDenied` — `xmlrpc.php`, `wp-comments-post.php`, `wp-trackback.php`, `wp-signup.php`, `wp-activate.php`, `wp-login.php?action=register` (`:328-342`).
6. `adminDenied` (`:303-318`) — дашборд (`''`, `index.php`), папки `maint`, `network`, `user`; страницы `CLOSED_PAGES`; `options*.php`; `ms-*.php`; импортёры; **слова в `page=`/`route=`** (`CLOSED_SCREEN_WORDS`, `:241-252`: `entr`, `submission`, `subscriber`, `lead`, `inbox`, `message`, `cfdb`, `user`, `customer`, `order`); типы записей; **слова в `action=`** (`CLOSED_ACTION_WORDS`, `:262-281`: 18 слов).
7. `restDenied` (`:434-442`) — маршруты REST, `_method`, `force`, `_embed`, `status=trash`, POST без тела к объекту.

Сегменты-якоря, на которых держится всё: `wp-admin`, `wp-content`, `wp-json`, параметр `rest_route`. Смена этих якорей — это и есть смена стека; ни один из них не вынесен в параметр.

**Известные пределы, записанные в самом файле** (`:32-43`): заказ по номеру через `post.php` не отличить от записи; настройки плагина `admin.php?page=…` не известны по имени; плагин с одним экраном и маршрутом после `#` открывается. Это пределы закрытого списка, и все они станут хуже на CMS с другими расширениями — см. раздел 7.

Вход в браузерной политике: `SIGN_IN_FORM` (`:520-525`) — селекторы `#loginform #user_login`, `#loginform #user_pass`, `#loginform #wp-submit` и `isWordpressSignInPage` (`:512-517`). Дополнительные хосты: `EXTRA_HOSTS = []` (`:75`) — это проверенное решение Б31: у WP всё с самого сайта. У CMS, чья админка грузит что-то с CDN (см. раздел 8), это поменяется.

## 3. Что общее, а что WordPress в коде браузера

Вне адаптера о WordPress осталось только то, что перечислено ниже; это надо либо вынести, либо это и есть правда для всех стеков.

- `METHOD_OVERRIDE_HEADERS` (`page-rules.ts:94-98`) — комментарий о WordPress, но список общий и безвреден.
- `SAVE_COMBO` Ctrl/Cmd+S (`worker-session.ts:205-208`) считается сохранением на любом стеке; для админки, где Ctrl+S ничего не значит, это лишний commit-барьер, безопасная сторона.
- `PRESSING_KEYS` — общие.
- `#site()` в `cloud-browser.ts:1419-1428` — `www.`-близнец. Общее.
- Комментарий `cloud-browser.ts:1025` и порт `ports.ts:139` («block editor's canvas») — только слова: `#wait` смотрит все кадры.
- `withEditableText` (`packages/browser-providers/src/cloud/editable-text.ts`) — проверить отдельно: читает ли он TinyMCE и CKEditor (раздел 10, п. 9).

## 4. MCP: какие инструменты есть и что в них WordPress

Что объявляется, решает `mcpToolFamiliesOf` (`apps/mcp/src/access/mcp-policy.ts:162-182`): `site_info` — всем; `content` — задаче с репозиторием при профиле контента и предпросмотре с базой; `schema` — при `schema_migration` в `dbKinds`; `browser` — при открытом предпросмотре; `web` — задаче с `needs_browser` при настроенном `BROWSER_WORKER_URL`.

**Находка: `SiteAdapter.mcpTools()` никто не вызывает.** Поиск `\.mcpTools(` по `apps` и `packages` вне `site-adapters` пуст; перечень на 15 инструментов (`wordpress.ts:186-266`: `wp_cli`, `snapshot`, `media_upload`, `wp_delete`…) — декларация проекта, которой в продукте нет. Настоящий список инструментов задан декораторами контроллеров Nest и знать о стеке не может. То есть для другой CMS менять `mcpTools` бесполезно, а точка расширения по стеку в MCP сейчас отсутствует.

Инструменты, которые на самом деле есть:

| Инструмент | Файл | Зависит от стека | На другой CMS |
| --- | --- | --- | --- |
| `site_info` | `apps/mcp/src/site-info/mcp-tools.controller.ts:64-93` | нет: `stack`, адреса, `browser.startPath` из адаптера. Для стека без браузера `startPath` — `null`, ошибка глотается (`browser-tasks.ts:24-31`) | работает как есть, если адаптер стека даёт `browserTaskPolicy` |
| `wp_rest` | `apps/mcp/src/content/mcp-content.controller.ts:49-63` | **имя, описание, схема** — WordPress; реализация общая | см. ниже |
| `restore` | там же, `:82-97` | нет в имени; `objectRef` через журнал | будет работать, когда есть шлюз стека |
| `db_schema` | там же, `:65-80` | формулировка общая, но `dbKinds` даёт плагин | только при плагине стека, умеющем `schema_migration` |
| `browser_*` | `apps/mcp/src/browser/mcp-browser.controller.ts`, браузер агента на предпросмотре | только `browserRequestDenied` и путеводитель | сразу работает на любом предпросмотре, если у адаптера есть `browserRequestDenied`; у `bitrixAdapter` — «всё закрыто» (`bitrix.ts:152-154`) |
| `web_*` (14 штук, `browserToolNames`, `packages/domain/src/browser/tools.ts:36-51`) | `apps/mcp/src/web/mcp-web.controller.ts` | контроллер и сервис стека **не знают**; `mcp-web.ts` без единого условия по стеку. Описания говорят «Save, Publish, Update or Schedule» — слова Gutenberg, но как примеры | работают как есть |

### `wp_rest`: что здесь WordPress, а что нет

Как идёт вызов. GET: шлюз предпросмотра или сайта → `gateway.read(objectRef)` → контакты маскируются → ответ до 64 КиБ (`mcp-content.ts:373-392`). POST: схема → отказ значениям с ключом хода и адресом предпросмотра (`#refuseValues`) → контакты обратно из маркеров → `#mutate` (`:797`): `journal.reserve` с идемпотентностью и пределом 20 объектов за ход (`mcp-journal.ts:464-477`) → `#plan` читает состояние «до» → зашифрованный снимок в S3 → запись на сайт с ожидаемым хешем состояния → квитанция плагина, которую сверяет `verifyContentProof`. `restore` проходит тот же `#mutate` из снимка своего хода; доверенный откат — тем же путём, по ограждению аренды. В предпросмотре запись ещё становится операцией плана БД выпуска. `site_info` ничего не пишет и не ходит на сайт: это поля строки допуска, а для задачи в браузере — `startPath` и держатель управления.

Этот сервис общий. WordPress-специфичны только три слоя:

1. **Маршрутные литералы** — `recordRoute`, `collectionRoute`, `settingsRoute` (`apps/mcp/src/content/content-arguments.ts:21-23`) и разбор `args.route.split('/')` (`mcp-content.ts:364-372`, `type = parts[3] === 'posts' ? 'post' : 'page'`). Это псевдо-REST: **запрос не идёт в REST WordPress**, агент лишь называет объект так, как в WP. Настоящий вызов — `gateway.read(objectRef)` и `conditionalWrite` к плагину «Радити» (`wordpress-content.ts`).
2. **Домен объектов**: `publishedObjectRefSchema = ^(post|page):[1-9][0-9]{0,9}$` (`packages/domain/src/ports/published-content.ts:4`), `kind: z.enum(['post','page'])` (`:23`), поля `title/content/excerpt` (`:10-14`), хеш с этими рамками (`:42-56`). `DbCreatedRecord` — `status, slug, title, content, excerpt` (`site-db.ts:64-70`), `DbWriteChange.post_create|post_trash|post_untrash` (`:74-102`). Новых полей (`цена`, `SKU`, TV MODX, свойства инфоблока) здесь нет.
3. **Плагин на сайте**: `infra/wordpress/raditi-content.php` — транзакция, квитанция, ограждение эпохи, снимок состояния. `SiteContentAdapter` на стек есть только у WP (`contentAdapters`, `packages/site-adapters/src/registry.ts:35-37`); `getSiteContentAdapter` для прочих бросает `NOT_IMPLEMENTED`, резолвер превращает это в `CONTENT_PREVIEW_UNAVAILABLE`/`stack` (`preview-content.ts:112-117`).

`SiteAccessKind` включает `'wp'` (`site-adapter.ts:95`) — вид доступа в Vault назван по стеку; новый стек либо добавляет свой вид, либо (лучше) общий `plugin`/`site_api`.

Итог: на сайте другой CMS задача с репозиторием сейчас получит из контентных инструментов **только `site_info`**, если не появится плагин стека. Вне production (`MCP_CONTENT_PROFILE=local`; в production и этот профиль, и `MCP_BROWSER_PROFILE` разрешены только как `off`, `apps/mcp/src/config/config.ts:191-200`) `mcpToolFamiliesOf` откроет семейство `content`, как только у предпросмотра `database=true`, — и агент увидит `wp_rest` с описанием про `/wp/v2/posts`, а каждый вызов кончится `CONTENT_PREVIEW_UNAVAILABLE`. `mcpToolFamiliesOf` стек не читает. Что с этим делать — раздел 10.

### `restore` и доверенный откат

Работают по `objectRef` журнала и `gateway.conditionalWrite(mode: 'restore')`; стек виден только через схему `objectRef`. Снимок объекта ограничен 32 КиБ текстовых полей (`published-content.ts:8`). Для `client_message`/undo важно: `TurnContentRollback` чисто журнальный.

### Предпросмотр и `wp_rest`

В `local` запись идёт в копию предпросмотра с доступом `kv/previews/<previewId>/<kind>` — это создаёт сборка предпросмотра (`previewAccessPath`, `preview-content.ts:121`); поэтому на другой CMS контент-инструмент появляется вместе с установкой плагина в копию (`preview-sync`), и это та же работа, что операции БД выпуска.

## 5. Домен задачи в браузере, который написан под запись WordPress

| Место | Что сейчас | Что сломается на другой CMS |
| --- | --- | --- |
| `browserCheckpointKinds = ['post']` (`checkpoint.ts:19`) | один вид | товар, статья, ресурс, элемент инфоблока пишутся как `post`, либо надо расширять перечень. В БД ограничение мягче: `kind ~ '^[a-z][a-z_]{0,15}$'` (миграция `20261022100100`, `:109-111`), менять схему не надо — но `taskBrowserCheckpoints` отбросит строку вида, которого код не знает (`packages/db/src/browser-checkpoints.test.ts:178`) |
| `FEED_KIND` (`checkpoint.ts:109-111`), `feedObjectKinds = ['post','page']` (`packages/domain/src/tasks/client-feed.ts:139`), `feedTexts.open` (`apps/web/src/components/chat/chat-texts.ts:551-552`) | лента говорит «запись» или «страница» | клиенту OpenCart надо «товар», Joomla — «материал», MODX — «ресурс/страница», Битрикса — «элемент». Известное открытое — план 57 §6 «Открыто»: «Checkpoint знает только вид `post`» |
| `browserObjectStatuses` (`checkpoint.ts:26-34`) | `publish, draft, pending, private, future, trash, unknown` | статусы других CMS отображаются на эти; `unknown` даёт в ленте `unconfirmed`, а `web_verify` с `expect: 'publish'` — `matched: false`. Joomla: 1/0/2/-2; MODX: `published`, `deleted`; OpenCart: `status` 0 или 1; Битрикс: `ACTIVE` Y или N и `WF_STATUS_ID` [п] |
| `BrowserVerifiedObject`: `images`, `files`, `featuredImage` (`checkpoint.ts:84-96`) | поля схемы обязательные | нужно считать по-своему; `featuredImage` у Joomla — `images.image_intro`, OpenCart — `image` [п] |
| `browserObjectIdSchema` (`checkpoint.ts:67-71`) | `[A-Za-z0-9_-]{1,64}` | годится всем; для Битрикса нужна пара `IBLOCK_ID`+`ID` — кладётся в `objectId` через дефис или в `editUrl` |
| `editUrl` — `siteAddress` (`checkpoint.ts:52-64`), хранится в `browser_checkpoints.edit_url`, уходит в ленту и `web_verify` | адрес редактора без секрета | **OpenCart держит `user_token` в адресе**: см. раздел 8 |
| `savedObjectOf`: `editPath: new URL(editUrl).pathname` (`apps/core/src/tasks/pass-facts.ts:350`) | только путь, query всегда отброшен | у WP агент получает `/wp-admin/post.php` и `objectId`, остальное знает из путеводителя. У Joomla, MODX, OpenCart и Битрикса путь один и тот же для всех экранов (`/administrator/index.php`, `/manager/`, `/admin/index.php`, `/bitrix/admin/…`), идентификатор объекта — только в query. Строка «editor …» в промпте (`turn-planner.ts:422`) становится бессмысленной; нужен метод адаптера «как назвать редактор агенту» |
| `#commitOr`/`#pendingCommit` | «новый объект — адрес ещё не называет его, потом называет» (`worker-session.ts:166-177`, `:594-610`) | держится на том, что **адрес после сохранения называет объект**. Joomla: «Сохранить» (`article.apply`) ведёт на `view=article&layout=edit&id=12`, а «Сохранить и закрыть» (`article.save`) — в список [и]. MODX: сохранение идёт AJAX-ом, адрес `?a=resource/update&id=12` уже называет объект [и]; что после сохранения нового ресурса — проверить [п]. OpenCart 4.1: форма `data-oc-toggle="ajax"`, ответ JSON, адрес `catalog/product.form` без `product_id` не меняется [и]. OpenCart 3 и «Сохранить» Битрикса уводят в список, «Применить» Битрикса остаётся [п]. Если адрес ресурса не появился, срабатывает «страница ушла из редактора» (`pending.moved = true`), и запрет снимает только клиент: задача застрянет после **первой же успешной записи** нового объекта. Сравнение с WordPress — раздел 10, пункт 3 |
| `#blocked` + `web_open` | пока не проверено, открыть можно только объект задачи | то же |
| `#manualWrite` (`worker-session.ts:884-890`) | любая запись клиента в редакторе объекта делает его `unverified` | стек-нейтрально, но смотрит только адрес **главного кадра** показанной вкладки. Редактор в дочернем кадре (боковая панель Битрикса [п], модальный редактор Joomla [п]) объекта не даст: событие `navigation` идёт лишь из главного кадра (`cloud-browser.ts:552`) |

Предел 20 объектов (`#overChangeLimit`, `worker-session.ts:1188-1196`) считается **только по checkpoint'ам** и **только по кнопке, которую опознал адаптер**. На другой CMS всё, что сохраняется не опознанной кнопкой, ни в счёт, ни под барьер дубликата не идёт: кнопка «Сохранить и закрыть», «Save & New», выпадающий список действий с массовым применением — это обход правила 4, если адаптер их не опознал. У WP такой ход закрыт политикой (`inline-save`, `bulk_edit`, `post-quickdraft-save`, `wordpress-browser-task.ts:290-297`); на других стеках это надо находить отдельно.

## 6. Инструкции агенту: что говорится о WordPress

`packages/agent-drivers` о WordPress **не говорит ничего**: поиск по исходникам без тестов пуст, только тестовые строки. В `apps/core/src/turns` тоже. Имя MCP-сервера `raditi` (`packages/agent-drivers/src/opencode-mcp.ts:2`), отсюда `raditi_<инструмент>`.

`apps/core/src/tasks/turn-instructions.ts`:

- `PLATFORM_RULES` (`:22-61`) — стек-нейтрален по именам, но описывает модель WP: «titles, texts and excerpts of published posts and pages», «a new page or post», «menus, widgets, theme or plugin settings». Для интернет-магазина OpenCart эти фразы неверны: товар не «post». Инструмент контента не назван по имени. Настоящие имена инструментов говорит `dbPlanGuide` стека (`wordpress-db.ts`).
- `BROWSER_RULES` (`:270-330`) — нейтральны: `web_*`, «objects», Save/Publish как обобщение. Стек подставляется только через `browserGuide` (`:340`) разделом `## The admin pages of this site`.
- `browserTaskInstructions` и `turnInstructions` выбираются по требованиям, а не по стеку (`turn-planner.ts:642-652`). Правило 8 соблюдено.
- `previewSection`, `unavailable.not_supported` (`:78`) — готовый текст для стека без предпросмотра.
- `sites.agent_notes` (`pass-facts.ts:388`, Б8) и `browserContextOf` (`turn-planner.ts:440-452`) кладут заметку клиента в запрос: это единственный канал, по которому сейчас можно сказать агенту, где на этом сайте админка (Б8: «вход по адресу /login»). Важно для раздела 7.

`wordpressBrowserGuide()` (`wordpress-browser-task.ts:794-847`): 50 строк английского со словами интерфейса по-русски и по-английски. Разделы: вход, новый объект, редактор, картинки, избранное изображение, публикация, Classic Editor, уведомления, удаление, права, checkpoint, финал, снимок экрана. Около половины переносимы дословно (вход, удаление, права, checkpoint, снимок); остальное стек пишет сам. Метод нужен планировщику: `guide` `null` или пусто — задача отклонена `not_accepted` (`turn-planner.ts:525`), а `browserFactsOf` ловит только `NOT_IMPLEMENTED` (`pass-facts.ts:382-385`).

Рассогласование: `siteCapabilities` не знает стека — браузер `ready` у любого (`packages/trpc/src/services/site-capabilities.ts:70-85`), а `core` отклонит задачу (`план 57, §6, «Открыто»`, «у Битрикса браузер в возможностях — `ready`, а `core` его задачу отклоняет `not_accepted`»). При четырёх новых стеках разрыв станет видимым: нужен признак стека в `siteCapabilities`, общий с `connectableStacks` (`registry.ts:33`).

## 7. Метод за методом: что значит, что нужно адаптеру, что узнать про админку

### `startPath`

Первая страница сессии. Проверяется при открытии: `checkedConnection` кидает `Invalid cloud browser connection`, если `openAllowed` её не пускает (`cloud-browser.ts:246-253`), поэтому закрытый политикой старт — это «сессии нет». Отдаётся и в `site_info.browser.startPath`.

- Данные: путь к админке этого сайта.
- Узнать: страница без персональных данных, куда сайт вернёт после входа. Консоль у всех четырёх показывает людей: Joomla — `mod_logged`, `mod_latestactions`, `mod_privacy_dashboard` [и]; OpenCart — `dashboard/recent.php` отдаёт имена покупателей, рядом `activity`, `online`, `customer`, `order` [и]; MODX и Битрикс — виджеты [п].
- Joomla: `/administrator/index.php?option=com_content&view=articles` [п: возврат после входа — поле `return` формы [и]].
- OpenCart: **глубокой ссылки нет.** Без `user_token` любой маршрут отвечает формой входа (`startup/login.php:52`), а `common/login.login` в 4.1 всегда шлёт на `common/dashboard` (`common/login.php:109`), поля `redirect` нет; у 3.0 скрытое поле `redirect` есть [и]. Разбор — раздел 10, пункт 2.
- MODX: в менеджере нет экрана-списка: дерево ресурсов живёт слева на каждом экране. Нейтральный старт надо выбрать на установке: кандидат — `?a=resource/site_schedule` (контроллер есть [и]).
- Битрикс: `/bitrix/admin/iblock_admin.php?lang=ru` или `iblock_list_admin.php?IBLOCK_ID=…` [с, п].

### `extraHosts`

Хосты, с которых админка грузит нужное. С плана 60 страница сайта не грузит ничего с другого сайта без этого списка (`page-rules.ts:85-88`). Значение попадает и в egress (`browserAllowedHosts`, `hosts.ts:41-54`), публичное имя обязательно, предел 256.

- Данные: константа стека. Настройки на сайт нет: `BROWSER_EXTRA_HOSTS` общий на процесс. Если у сайта админка на отдельном поддомене (контексты MODX [п]), ни `startUrl`, ни `allowedHosts` этого не выразят: разрешены только хост и его `www.`-близнец.
- Узнать: журнал запросов админки на чистой установке каждой версии. Что не загрузилось молча, ломает виджет молча.

### `requestDenied(request, by)` и `pageDenied(path, by)`

Первая и вторая линия правил 1 и 4. `pageDenied` — это `requestDenied` на GET без тела: так сделано у WP (`wordpress-browser-task.ts:532-533`), и так следует делать у всех. Метод вызывается по разу на каждый метод из заголовков override.

- Данные: путь с query, метод, текстовое тело, `by`. Заголовков и cookie нет.
- Что переносится: разбор `readRequest` с именами полей PHP (`:95-193`), `segmentsOf`, `pageAsset`. Эти функции надо вынести из файла WP в общий модуль PHP-админок (рядом с `php-config.ts`, `php-hosting.ts`).
- Узнать по стеку: чем адресуется экран; чем адресуется действие; какие XHR нужны редактору; какие страницы показывают людей; какие действия меняют объект мимо редактора; что считается удалением; какие скрипты выполняют код на сервере.
- Экраны и действия по стекам — раздел 8. Режим списка — раздел 9.

`by === 'user'` (Б37): клиент у управления может перенести запись в корзину. Каждому стеку нужно своё `clientTrash`: Joomla `articles.trash`, MODX `Resource/Delete` и `Resource/Undelete` (мягкое удаление) и запрет `Resource/EmptyRecycleBin` [и: процессоры есть], OpenCart — **корзины нет**, `deleteProduct` сразу выполняет `DELETE` (`model/catalog/product.php:474-475`) [и], Битрикс — корзина опциональна [п]. Значит, Б37 («в корзину, откуда можно вернуть») на OpenCart и части Битрикса исполнить нельзя: `clientTrash` там `false`, и путеводитель не должен обещать «взять управление и удалить».

### `signIn` (`BrowserSignInForm`, Б36)

Три селектора и `isSignInPage(path)`. Необязательное поле. Если его нет, сохранённый вход не работает, клиент входит руками, агент зовёт `web_help`.

- Данные: константы стека.
- Узнать: селекторы; `autocomplete`; форма обычная или AJAX; капча и 2FA; что происходит после входа.
- **Договор не подходит ни одной из четырёх CMS: форма живёт не по своему адресу** — раздел 10, пункт 1.

### `browserCheckpointOf(url)`

Адрес → объект задачи. На этом держатся запрет дубликата (Б22), предел 20 (Б34), `web_verify`, строка «объект» ленты. Если метод молчит, задача не видит своей работы.

- Данные: только адрес. Метод не получает сайта.
- Узнать: адрес редактора существующего объекта и что в нём называет объект; адрес нового объекта; куда уводит каждая кнопка; какой адрес **открывает редактор снова**; есть ли у открытия побочное действие; есть ли в адресе токен.
- Joomla: открывать надо `task=article.edit&id=12`, не тот адрес, на котором редактор стоит: `view=article&layout=edit&id=12` без удержанного id отказывает (`DisplayController.php:54-57`) [и]. Значит, `editUrl` ≠ `url`, метод обязан пересобрать адрес. Открытие ставит блокировку, снимает её только «Закрыть» (`article.cancel`) [и: `FormController::edit`, `holdEditId`; `FormController` строки 347-387]. Агент, бросивший редактор, оставит материал заблокированным от других; путеводитель должен это сказать.
- MODX: `?a=resource/update&id=12`, GET ставит блокировку `addLock` (`update.class.php:214`) с истекающим сроком [и; срок — п].
- OpenCart: `route=catalog/product.form&product_id=12&user_token=…` [и]. `user_token` в `editUrl` нельзя: строка уходит в `browser_checkpoints.edit_url` (правило 2). В 4.0 разделитель `|` вместо `.` [п]; в 3.0 — `catalog/product/edit` [п].
- Битрикс: `iblock_element_edit.php?IBLOCK_ID=…&type=…&ID=…&lang=ru` [п]. Объект — пара `IBLOCK_ID:ID`, в `objectId` это `2-12` по схеме `[A-Za-z0-9_-]`.

### `browserCommitAction(role, name)`

Роль и имя элемента → `save` | `publish` | `null`. Только это делает клик сохранением. Сравнивается то, что написано на кнопке на языке админки (`COMMIT_BUTTONS`, `:587-612`).

- Данные: константа стека. Метод не знает, где находится страница: кнопка «Сохранить» на любом экране — commit. У WP это безвредно, потому что закрытые экраны недоступны, а на открытых кнопка почти всегда про объект. На разрешённом списке то же.
- Узнать: все кнопки сохранения на двух языках: Joomla — «Сохранить», «Сохранить и закрыть», «Сохранить и создать», «Сохранить как копию» [и: `article.apply`, `article.save`; остальные — п]; MODX — кнопка `Сохранить` `#modx-abtn-save` [п]; OpenCart 4 — кнопка только с иконкой и `title="{{ button_save }}"` (`product_form.twig:6`) [и]: доступное имя у неё из `title` или `aria-label`, Bootstrap 5 может подменить атрибут, проверить на странице; Битрикс — `Сохранить`, `Применить`, `Сохранить и добавить` [п].
- Отдельно: что **не** выглядит как кнопка: значок статуса в списке, контекстное меню дерева MODX (ExtJS), перетаскивание в дереве (`Resource/Sort` [и]), правка в списке (`Resource/UpdateFromGrid` [и], `action=edit` списков Битрикса [п]). Их надо закрыть политикой, как `inline-save` у WP (`:290-295`), иначе они мимо предела 20.

### `browserVerification(ref)`

План до 4 GET-запросов с cookie сессии (`browserVerificationLimits`, `checkpoint.ts:216-221`), разбор чистый; тело не покидает `read`. Редирект — только между адресом сайта и его `www.`-близнецом, 3 шага; тело до 1 МиБ, таймаут шага 10 с.

- Данные: только `ref`; подкаталог берётся из `editUrl`.
- Узнать: есть ли чтение без побочных действий; как получить токен; что отвечает разлогиненная сессия. **`200` с формой входа — не `missing`**: у всех четырёх форма живёт на том же адресе, поэтому `read` обязан отличать её, иначе разлогинившийся браузер скажет «объект исчез».
- Варианты по стекам и поломки договора — раздел 8 и раздел 10, пункт 4.

### `browserGuide()`

Markdown на английском со словами интерфейса на русском и английском. Пустая строка — отказ задаче. Метод без `site`, поэтому не может назвать переименованную админку. Общий текст инструментов CMS не называет, это держит тест `apps/mcp/src/web/mcp-web-tools.test.ts`.

- Узнать: всё то же, что у человека в первый день: где список, как создать, какие поля обязательны (у товара OpenCart — модель, название, SEO-адрес [п]), какой редактор, как загружается картинка, как удалить руками, что значит блокировка.

### `browserRequestDenied(request)`

Браузер агента на предпросмотре. Закрытый список мягче: это копия. Копия при этом держит медиа и настоящие файлы (`wordpress-browser.ts:13-19`), поэтому те же экраны людей закрыты. Для стека проще всего взять `browserTaskPolicy(...).requestDenied` с `by = 'agent'` плюс отдельную обработку загрузки.

## 8. Админки четырёх CMS

| | Joomla 6 | OpenCart 4.1 | MODX 3 | 1С-Битрикс |
| --- | --- | --- | --- | --- |
| Вход в админку | `/administrator/index.php` | `/admin/index.php`; **папка переименовывается штатно**: `common/security.admin` предлагает это в панели, `common/security.php:86-92, 371-414` [и] | `/manager/`; **путь задан при установке**, `MODX_MANAGER_URL`, `MODX_CONNECTORS_URL` в `core/config/config.inc.php` (`config.inc.tpl:37-49`) [и] | `/bitrix/admin/` [с] |
| Чем адресуется экран | `option=com_*`, `view=`, `task=` | `route=` | `a=`, `namespace=` у дополнений | имя скрипта `*.php` [п] |
| Чем адресуется действие | POST `task=` с токеном | `route=…​.метод`; токен в адресе | POST `connectors/index.php`, `action=`, `HTTP_MODAUTH` или заголовок `modAuth` (`modConnectorResponse.php:111-124`) [и] | POST на тот же скрипт, `sessid`; `/bitrix/services/main/ajax.php?action=` с `X-Bitrix-Csrf-Token` [с] |
| Форма входа | `#form-login`, `#mod-login-username`, `#mod-login-password`, `#btn-login-submit`; адрес тот же [и] | `#form-login` (4.x, AJAX), `#input-username`, `#input-password`, `button[type=submit]`; появляется **на любом маршруте** без токена [и] | `#modx-login-form`, `#modx-login-username`, `#modx-login-password`, `#modx-login-btn`; адрес тот же; режим без пароля — другая форма [и] | поля `USER_LOGIN`, `USER_PASSWORD`, `AUTH_FORM=Y`, `TYPE=AUTH`, на `/bitrix/admin/`, капча по настройке [с]; селекторы и способ отправки — проверить [п] |
| Второй фактор | `com_users&view=captive` — живёт в компоненте, который иначе закрыт (`CaptiveController.php`) [и] | `common/authorize` (`startup/login.php`, список исключений) [и] | ядро — нет, дополнения [п] | OTP [п] |
| Токен сессии | в форме | **`user_token` в query каждого адреса** [и] | `MODx.siteId`, в разметке страницы (`header.tpl:24`) [и] | `sessid`, `BX.bitrix_sessid` [с] |
| Редактор | TinyMCE в iframe по умолчанию, `com_media` [п] | CKEditor (`data-oc-toggle="ckeditor"`) [и], менеджер `common/filemanager` [п] | textarea без RTE; дополнения дают TinyMCE, ACE [п]; интерфейс ExtJS 3 | свой визуальный редактор в iframe [п] |
| Чтение JSON под сессией | **нет**: `api-authentication` только `basic` и `token` [и], в `com_content` админки только `HtmlView` [и] | нет [п] | есть: `connectors/index.php?action=Resource/Get&id=12` (`Processors/Resource/Get.php`) [и] | D7-контроллеры `ajax.php`; нужное действие iblock не подтверждено [с] |
| Чтение HTML без следа | список с `filter[search]=id:12` (`ArticlesModel.php:469`) [и]; фильтр оседает в сессии [п]; `layout=modal` упомянут в `HtmlView.php:163` [и] | форма `catalog/product.form` без блокировки, нужен токен [и]; публичная `route=product/product` только для включённых [п] | `?a=resource/update` ставит блокировку [и] | `iblock_list_admin.php` с фильтром [с, п]; `iblock_element_edit.php` может ставить блокировку при документообороте [п] |
| Открытие редактора с побочным действием | да, checkout [и] | нет [п] | да, `addLock` [и] | зависит от модуля [п] |

### Что закрывать (правила 1 и 4)

**Joomla.** Перечень `administrator/components` [и]. Форма входа появляется на любом адресе админки: гостю разрешён только список компонентов с `com_login` (`AdministratorApplication.php:43-54`) [и]. Открыть: `com_content`, `com_categories` (`extension=com_content`), `com_media`, `com_tags`, `com_fields`, `com_contenthistory`, `com_ajax` (keepalive) [п: список XHR редактора снять на установке]. Закрыть всё остальное, прежде всего: `com_users` (кроме `captive`), `com_privacy`, `com_actionlogs`, `com_messages`, `com_cpanel`, `com_installer`, `com_joomlaupdate`, `com_plugins`, `com_modules`, `com_templates`, `com_menus`, `com_config`, `com_contact`, `com_banners`, `com_mails`, `com_scheduler`, `com_checkin`, `com_cache`. Действия мимо редактора: `task=articles.publish|unpublish|archive|trash|report|featured|unfeatured|delete|reorder|saveorder|checkin` (`ArticlesController.php:56`, `AdminController.php:88-99, 134-332`) [и], `articles.batch` [п]. Сторонние: VirtueMart, HikaShop, JoomShopping, RSForm, Akeeba [п] — их `option=` заранее не перечислить.

**OpenCart.** Маршруты меню 4.1 [и]. Открыть: `catalog/product`, `catalog/category`, `catalog/information`, `catalog/manufacturer`, `catalog/attribute*`, `catalog/option`, `catalog/filter*`, `cms/article`, `cms/topic`, `common/filemanager`, `common/login`, `common/forgotten`?, `common/authorize`. Закрыть: `common/dashboard`, `sale/*`, `customer/*`, `marketing/*`, `report/*`, `user/*`, `catalog/review` и `cms/comment` (имена посетителей), `tool/*` (`tool/backup` — вся база, `tool/log`, `tool/upload` — файлы покупателей), `setting/*`, `marketplace/*`, `extension/*`, `design/*` (`design/theme` — код шаблонов), `localisation/*`, `mail/*`. Методы: `catalog/product.delete`, `.copy` [и]. Сторонние модули — `extension/<вендор>/…`.

**MODX.** Контроллеры менеджера [и]. Открыть: `resource/update`, `resource/create`, `resource/site_schedule`?, `browser`, `media`. Закрыть: `welcome`, `dashboard`, `security/*`, `system/*` (`system/file`, `system/settings`, `system/logs`, `system/info`), `workspaces/*`, `element/*` (сниппеты и плагины — PHP на сервере), `source`, `context`, `search`?, `resource/trash`, любой `namespace=`. Процессоры: разрешить `Resource/Get`, `GetNodes`, `Update`, `Create`, `Locks/*`, `Translit`, `Browser/*`, чтение TV и шаблонов; закрыть `Delete`, `EmptyRecycleBin`, `Duplicate`, `Publish`/`Unpublish` мимо редактора, `Sort`, `UpdateFromGrid`, `Trash/*`. Регистр зависит от версии: `Resource/Update` в 3.x, `resource/update` в 2.x [п]. Сторонние: miniShop2, FormIt, Tickets [п].

**Битрикс.** Только [с, п]. Открыть: `iblock_admin.php`, `iblock_list_admin.php`, `iblock_element_admin.php`, `iblock_element_edit.php`, `iblock_section_edit.php`, `medialib_admin.php`, инструменты загрузки. Закрыть всё прочее, прежде всего `php_command_line.php` — выполняет PHP на сервере, это задокументировано [с], — `sql.php`, `fileman_*`, `user_*`, `sale_*`, `form_*`, `subscr_*`, `posting_*`, `settings.php`, `module_admin.php`, `update_system.php`, `dump.php`, `event_log.php`, `security_*`, `perfmon_*`, `agent_list.php`, `index.php`. Параметры на **публичных** адресах у вошедшего администратора: `?clear_cache=Y`, `?bitrix_include_areas=Y`, `?logout=yes`. Заявки часто лежат в инфоблоках, поэтому разрешение инфоблоков как класса открывает персональные данные: нужен перечень запрещённых `IBLOCK_ID` на сайт или разрешённых типов. Это знает только владелец сайта.

Общее: `/bitrix/admin/` часто закрывают по IP [с], а админку других CMS — HTTP Basic или плагином. Браузер задачи ходит с адреса платформы, а окна Basic Auth в протоколе потока нет [п: Playwright без `httpCredentials` даст 401]. Для таких сайтов задача не начнётся; вход клиент пройти не сможет.

## 9. Разрешённый список вместо закрытого

**Возможно ли в текущем договоре.** Да, без единой правки типов. `requestDenied` и `pageDenied` — произвольные предикаты, `page-rules.ts` не знает, как адаптер принял решение, а исключение читается как отказ (`:32-38`). Адаптер пишет `return !allowed(read)`.

**Как выглядит у WP сейчас и почему это не переносится.** Закрытый список у WP открыт по умолчанию (`:504`) и держится на якоре: `isAdminUrlDenied` при отсутствии сегмента `wp-admin` отвечает `false` (`wordpress-mcp-policy.ts:381-382`). Для WP это терпимо: папка `wp-admin` не переименовывается штатно, экраны плагинов идут через `page=` и ловятся словами. Известные дыры записаны прямо в файле (`:32-43`) и в плане 57 («Открыто»: FluentCRM).

**Что случится с закрытым списком на переименованной админке.** Сегмент не найден, запрос считается публичной страницей, **открыто всё**: `/x7k2/index.php?route=sale/order&user_token=…` проходит, покупатели идут модели. Ошибки при этом нет. Значит, закрытый список, привязанный к имени папки, для OpenCart и MODX недопустим: он отказывает в опасную сторону и молча. У OpenCart 4 переименование — штатная рекомендация панели, поэтому это обычный случай, а не экзотика.

**Что решает разрешённый список.**

- Экран определяется параметром, а не папкой: `route=` у OpenCart и `a=`, `namespace=`, `action=` у MODX работают на любой папке. Сторож смотрит параметр на каждом запросе к сайту. Публичные страницы OpenCart тоже ходят через `route=` (`product/product`, `checkout/*`, `account/*` [п]), их список короткий и отделим; ЧПУ-страницы параметра не имеют.
- Неизвестное закрыто: сторонние экраны заказов (`option=com_virtuemart`, `namespace=minishop2`, `/bitrix/admin/sale_*.php`) закрываются без перечисления. Для закрытого списка по словам они — та же дыра, что у FluentCRM, только на других CMS такие экраны не в `page=`, а в `view=`, `namespace=` или в имени скрипта.
- Смена версии ломает в безопасную сторону: новый экран закрыт, а не открыт.

**Цена.**

- Каждый XHR редактора надо перечислить. Неразрешённый XHR обрывается молча (`route.abort`), агент не видит причины: виджет просто не работает. Журнала отказов по адресам нет и быть не должно: инвариант порта запрещает адрес в ошибке. Значит, инвентаризация — стендом на настоящей установке каждой поддерживаемой версии, с журналом стенда.
- Клиент у управления тоже внутри списка (Б21): он не откроет в браузере платформы ничего, кроме разрешённого. Это сужение продукта по сравнению с WP. Свой браузер у клиента остаётся.
- Нужно разрешить вход и его шаги: `com_users&view=captive`, `common/authorize`, смену пароля. Иначе 2FA упирается в отказ.
- Сторонние редакторы (JCE: `option=com_jce`; дополнения MODX; TinyMCE-плагины) сломаются, пока их не внесли [п].

**Нужен ли `adminPath`.** Для решения «можно или нельзя» — нет, если судить по параметру. Для остального — да: `startPath`, старт `signIn`, путеводитель, адрес проверки. Если он неизвестен, старт — главная сайта, клиент входит руками, агент не знает, где админка. Источники: при доступе к файлам — `core/config/config.inc.php` MODX и `<admin>/config.php` OpenCart (тот же `read`, что у `configSecrets` и `databaseSettings`); без файлов — поле мастера.

**Рекомендация.** Разрешённый список для всех четырёх новых стеков, не только для MODX и OpenCart: у Joomla и Битрикса причина та же — сторонние экраны с людьми. WP не менять: это отдельный вопрос плана 57 §6, вопрос 3. Вместе с этим — правило для адаптера: стек с разрешённым списком судит по параметру и не зависит от имени папки.

## 10. Что сломается, даже если адаптер написан правильно

Это места, где договор повторяет устройство WordPress. Порядок — по тяжести.

### 1. Форма входа определяется по адресу

`BrowserSignInForm.isSignInPage(path)` (`site-adapter.ts:319`). У WP форма — отдельный скрипт `wp-login.php`. У Joomla, MODX и OpenCart форма показывается **на том же адресе**, что и запрошенный экран [и], у Битрикса — тоже [с]. Адрес не говорит, вошёл ли браузер.

Что будет, если адаптер ответит `true` на адрес админки у сессии, которая **уже вошла**, с сохранённым входом (Б36):

1. Перед каждым действием агента вызывается `#signInIfAsked` (`worker-session.ts:980`).
2. `signIn` ждёт поля (`cloud-browser.ts:1327-1331`) весь срок действия, 10 с (`agentActionTimeoutMs`), и падает по таймауту.
3. `#forgetSignIn` (`:1374-1384`) ещё 10 с пробует очистить поля, которых нет, и уводит страницу на `about:blank`.
4. `#signInRefused` запоминает пару значений: сохранённый вход больше не повторяется, даже когда сессия на сайте действительно истечёт (`worker-session.ts:927-935`).

При **удачном** входе то же: `signedIn = !#onSignInPage` (`cloud-browser.ts:1360`) на том же адресе даёт `refused`, вошедшая страница уходит на `about:blank`, оператор видит `browser_sign_in_refused`.

Правка общая и для WP безопасна: страница считается формой, только если на ней есть поле пароля формы (`page.locator(form.password).count()`), и успех — это отсутствие этого поля. `isSignInPage` остаётся необязательным сужением. Тогда сохранённый вход не зависит и от имени папки.

### 2. Токен сессии в адресе: OpenCart

`user_token` обязателен в query каждого адреса админки (`startup/login.php:52`) [и]. Следствия в коде Радити:

- Агент токена не знает: `redactBrowserAddress` скрывает его по слову `token` (проверено на регулярном выражении `addresses.ts:19-20`). Так и должно быть. Но `web_open('/admin/index.php?route=catalog/product')` тогда откроет форму входа. Агент ходит только кликами по меню.
- `startPath` не может быть рабочей страницей, а `common/login.login` в 4.1 всегда ведёт на `common/dashboard`.
- Консоль закрыта (имена покупателей). `signIn` ловит `denied` и идёт на `startUrl` (`cloud-browser.ts:1356-1358`), а там без токена снова форма: `refused`, хотя вход удался. Клиент, который входит руками, получает `committedAllowed` → `about:blank` (`cloud-browser.ts:539-551`). **Тупик: в текущем договоре задача в браузере на OpenCart 4.1 с закрытой консолью невозможна.**
- `browserVerification(ref)` не знает токена, а получить его запросом нельзя: без токена сервер отдаёт форму.
- В `editUrl` токен нельзя: он уходит в `browser_checkpoints.edit_url` и в ленту. Без него адрес не открывает редактор. Поэтому «откройте редактор снова» (`BROWSER_RULES`, `savedObjectLine`) на OpenCart означает «найдите товар через меню и список».
- Токен есть в `BrowserSessionState.url` и `tabs`, которые идут в кабинет клиента (`worker-session.ts:419-437`). Это токен самого клиента, в журналы состояние не пишется, но это надо проговорить.

Правка: `BrowserTaskPolicy.sessionParameter?: string`. Браузер запоминает значение из адреса запроса главного кадра сайта, держит только в памяти (как `#signIn`), подставляет в `web_open`, `navigate`, в уход с закрытой страницы на `startUrl` и в шаги проверки. Агенту и в БД не идёт. Отказанный главный кадр у клиента ведёт на `startUrl`, а не на пустую страницу.

Альтернатива без правки платформы — оставить консоль открытой. Это нарушает правило 1: `dashboard/recent.php` кладёт имена покупателей в страницу, текст идёт модели.

OpenCart 3.0 проще: поле `redirect` есть [и]. Но токен тот же.

### 3. Объект определяется по адресу

`browserCheckpointOf(url)` — единственный источник. Запрет дубликата устроен так: нажатие сохранения на новом объекте ставит `#pendingCommit`, и пока адрес не назовёт объект, агенту закрыты `web_open` и новые сохранения, а снимает это только взятие управления клиентом (`worker-session.ts:1173-1181`, `:786-788`).

У WP блочный редактор меняет адрес на `post.php?post=12` сам. У других:

- **OpenCart 4.1**: `$json['product_id'] = addProduct(…)` (`product.php:1295`), `common.js:212-214` кладёт его в скрытое поле формы. Адрес остаётся без `product_id` [и]. После **первого же нового товара** агент заперт: `web_verify` ничего не находит, в счёт предела 20 товар не попадает, лента объекта не показывает. На сайте товар есть.
- **Joomla**: «Сохранить» даёт id в адресе, «Сохранить и закрыть» уводит в список и id теряется [и].
- **Битрикс**: аналогично с «Применить» и «Сохранить» [п].
- **Дочерний кадр**: событие `navigation` идёт только из главного кадра (`cloud-browser.ts:552`).

Правки на выбор адаптера: (а) необязательный `BrowserTaskPolicy.objectField` — селектор поля, откуда worker читает id после сохранения, если адрес его не дал (OpenCart); (б) закрыть политикой кнопки, которые теряют адрес: `task=article.save|save2new|save2copy` у Joomla, поле `save` у Битрикса на новом объекте — остаётся кнопка, сохраняющая адрес. Второй способ не требует правки договора.

### 4. Проверка объекта устроена как `admin-ajax.php?action=rest-nonce`

`BrowserVerificationStep.headers` принимает `{ fromStep }`: **всё тело** предыдущего шага целиком, как значение заголовка (`verification.ts:52-68`, `HEADER_VALUE`). Это точный слепок WP: отдельный адрес отдаёт голый nonce.

- MODX: токен есть только внутри HTML страницы; заголовок `modAuth` сервер примет [и], вытащить значение нечем.
- Битрикс: то же с `sessid` [с].
- OpenCart: токен нужен в **query**, а `path` — статическая строка (`isBrowserVerificationPlan`, `checkpoint.ts:238-241`), источник — адрес страницы, а не шаг.
- Joomla: JSON под сессией нет вовсе; читать только HTML списка.

Нужно: `{ fromStep, pattern }` с проверяемым шаблоном и значения в query, в том числе из `sessionParameter`. `read` остаётся чистым и уже может разбирать HTML: `readAs: 'text'`. Но тогда у адаптера появляется разбор чужой вёрстки, чего у WP сознательно нет (`:762-763`), и предел тела 1 МиБ.

Чтение обязательно. `unreadable` оставляет объект `unverified` (`browserCheckpointAfterRead`), и `browserCheckpointsBlock` закрывает любое следующее сохранение **того же** объекта (`worker-session.ts:1238-1239`). Стек без чтения — это задача из одного сохранения.

Побочные действия: GET `task=article.edit` (Joomla) и `?a=resource/update` (MODX) ставят блокировку [и], поэтому редактор как источник чтения не годится.

### 5. Политика знает только адрес сайта

`BrowserTaskSite = { url }`, `browserGuide()` и прочие без `site`. Чтобы передать `adminPath`, меняются тип, `worker-store.ts:136-139` (читает только `stack`, `url`), `apps/mcp/src/site-info/browser-tasks.ts:26`, `pass-facts.ts:381`, `SiteFacts`. Хранение — новая колонка `sites.admin_path` или поле настроек стека. Подкаталог сайта при этом не закрывается: мастер принимает только origin (`wizard-model.ts:311-325`), `mcpAccessSchema.url` требует `pathname === '/'` (`mcp-access.ts:45-55`). OpenCart в `/shop/` и Joomla в `/site/` не подключатся, поддержка папки в `startPathOf` WP не используется.

### 6. Виды объектов и слова клиенту

`browserCheckpointKinds`, `FEED_KIND`, `feedObjectKinds`, `chat-texts.ts:551`, метки `client-feed-labels.ts`. Для товара нужен новый вид вдоль всей цепочки. `checkpointOf` молча отбрасывает вид, которого код не знает (`browser-checkpoints.ts:110-122`), поэтому вид добавляется раньше, чем его начнёт писать worker: при выкладке вразнобой счёт предела занижается.

Строка промпта `editor <путь>` (`pass-facts.ts:350`, `turn-planner.ts:422`) у CMS с единой точкой входа не несёт смысла: отдаёт `/administrator/index.php`. Запрос там отброшен намеренно: в нём может быть секрет. Нужно поле, которое даёт адаптер: подсказка без параметров токена.

### 7. Состав инструментов не знает стека

- `SiteAdapter.mcpTools()` не вызывается (раздел 4). Либо удалить, либо сделать настоящим источником.
- `mcpToolFamiliesOf` объявит `wp_rest` стеку без шлюза контента вне production.
- `siteInfoOf`: `database: { operations: preview.dbKinds ?? ['content_update'] }` (`mcp-tools.controller.ts:52`) обещает правку текстов стеку, где её нет.
- `PLATFORM_RULES`: «Content of the site … changes only through the platform MCP tools» (`turn-instructions.ts:33-34`) при отсутствии инструментов оставляет агента без пути; секцию нужно собирать из `dbOperationKinds` стека.
- `mcpBodyAllowed` пропускает только именованные формы вызова (`mcp-policy.ts:37-48, 231-238`): новый инструмент надо вносить туда и в `agentCodes` контроллера.

### 8. `siteCapabilities` и `connectableStacks`

`siteCapabilities` стека не читает (`site-capabilities.ts:70-85`), а `connectableStacks` один на все способы подключения: `assertSiteAccepted` применяется и к `access: 'browser'` (`site-basics.ts:236-247`). Стек нельзя включить «только браузер». Нужны два признака: подключается без файлов (браузер) и подключается с импортом.

### 9. Что могут показать только установки

- Дерево доступности ExtJS 3 (MODX) и Битрикса: роли кнопок, вкладок, дерева, таблиц. `browserCommitAction` требует `role === 'button'` у WP; решение стека. Предел дерева 16 000 знаков (`observation.ts:36`).
- `withEditableText` читает только строку `textbox` без значения (`editable-text.ts:14`). Тело TinyMCE или CKEditor в кадре может иметь другую роль, и агент не прочтёт написанное.
- Карта контактов: 11-значные числа с 7 или 8 и подходящей следующей цифрой считаются телефонами (`content-contacts.ts:258-271`). Артикулы списка товаров могут заполнить карту на 32 КиБ (`content-privacy.ts:25`), и агент получит `CONTENT_PRIVACY_LIMIT`.

## 11. Какие инструменты получит агент на сайте другой CMS

| Вид задачи | Что есть сразу | Что нужно | Чего не будет без плагина стека |
| --- | --- | --- | --- |
| Задача в браузере, в том числе сайт без доступа к файлам (`access: 'browser'`) | `site_info`, 14 `web_*`, навыки и интернет | адаптер: `browserTaskPolicy`, `browserCheckpointOf`, `browserCommitAction`, `browserVerification`, `browserGuide`; правки раздела 10, пп. 1, 3, 4, а для OpenCart ещё п. 2; включение стека | ничего: **плагин не нужен** |
| Диалог с репозиторием, production сегодня | `site_info`, файлы рабочей копии | остальной адаптер; `content` и `browser_*` в production закрыты конфигурацией | правка записей БД инструментом |
| Диалог с репозиторием вне production | + `browser_*` на предпросмотре, при `browserRequestDenied` стека | предпросмотр стека | `wp_rest`, `restore`, `db_schema`; операции БД выпуска |

Варианты контентного инструмента, когда появится шлюз стека:

- **Оставить имя `wp_rest` и схему адреса.** Дешевле всего и неверно: модель другой CMS получит описание про `/wp/v2/`.
- **Общий инструмент `site_content`:** `objectRef` вида `<вид>:<id>`, поля из описания стека. Сервис уже общий: нужно снять литералы `content-arguments.ts:21-23`, разбор `mcp-content.ts:364-372`, расширить `publishedObjectRefSchema` (схема `dbRecordRefSchema` уже принимает любой вид, `db-objects.ts:30-33`) и формат хеша. Поля `title/content/excerpt` не покрывают цену и свойства товара: контентный инструмент этим не займётся, товар правится в браузере.
- **Шлюз без плагина для стека с готовым API** (Joomla Web Services, `/api/index.php/v1/content/articles` [и]) не даёт атомарного сравнения и квитанции, которых требует `PublishedContentGateway` (`published-content.ts:133`). Договор остаётся за плагином стека.

`wp_rest` идёт в журнале `mcp_calls.tool` и в стендах: при переименовании история остаётся читаемой, а стенды правятся вместе с кодом.

Откат: `restore` и «Отменить» — только через шлюз. Задача в браузере отката не имеет (Б1), это одинаково на всех стеках, и обещание в путеводителе «из корзины можно вернуть» верно не везде (раздел 7).

## 12. Перечень правок

Общие, до первого адаптера:

1. Вынести разбор запроса из `wordpress-browser-task.ts:95-193` и помощники `:549-557`, `:669-687` в общий модуль PHP-админок.
2. Форма входа по наличию поля (раздел 10, п. 1): `cloud-browser.ts`, договор `BrowserSignInForm`.
3. `fromStep` с шаблоном и подстановка в query (п. 4): `checkpoint.ts`, `verification.ts`.
4. Необязательный `objectField` (п. 3): `BrowserTaskPolicy`, `CloudBrowserActResult`, `#committed`.
5. `adminPath` (п. 5).
6. Виды объектов и слова ленты, подсказка редактора (п. 6).
7. Признаки стека: `siteCapabilities`, браузер отдельно от импорта (п. 8).
8. Семейство `content` и `database.operations` по стеку, текст `PLATFORM_RULES` (п. 7).
9. Стенд: `verify:browser-task` сейчас знает только WordPress (`infra/dev/browser-task-verify/fixture`, `site.mjs`, `programs.mjs`); нужен прогон на каждый стек и журнал отказанных запросов стенда для инвентаризации списка.

Для OpenCart дополнительно: `sessionParameter` (п. 2).

Адаптер стека: файл политики со списком, чтение объекта, путеводитель, таблица тестов `requestDenied` на закрытых экранах. Образец — 904 строки тестов `wordpress-browser-task.test.ts`.

Порядок по тяжести договора: Joomla и MODX, затем Битрикс (исходников нет, нужна установка с лицензией или демоверсией [п]), затем OpenCart.

## 13. Вопросы владельцу

| Вопрос | Значение по умолчанию |
| --- | --- |
| Разрешённый список для новых стеков (план 57 §6, вопрос 3, решён не был) | да, для всех четырёх; WordPress не менять |
| Клиент у управления ограничен тем же списком (Б21) | да |
| Поддерживаемые версии: Joomla 4–6, OpenCart 3 и 4, MODX 2 и 3 | только текущие ветки: Joomla 5–6, OpenCart 4.1, MODX 3; иначе удваивается список |
| Сайт с переименованной админкой без доступа к файлам | поле «Адрес панели управления» в мастере, обязательное для MODX и OpenCart |
| OpenCart: корзины нет. Удаление клиентом у управления (Б37) | закрыто: удаляет клиент вне браузера платформы |
| Битрикс: инфоблоки с заявками | закрыть всё, что клиент не отметил; нужна настройка сайта. Вопрос касается правила 1 |
| Скрытие токена в `state.url` кабинета (OpenCart) | не скрывать: это токен самого клиента; журналы его не получают |
| Сайты с защитой админки по IP или HTTP Basic | отказ с объяснением клиенту |

## 14. Что не проверено

- Ни одна установка не запускалась. Всё о поведении чужих админок выведено из исходников или помечено [п]; об устройстве дерева доступности — только предположения.
- Битрикс: официальная документация почти не нашлась поиском; действие D7 для чтения инфоблока не подтверждено. Источники: поля формы — [qna.habr.com/q/386983](https://qna.habr.com/q/386983), `iblock_list_admin.php` и `?login=yes` — [qna.habr.com/q/1353368](https://qna.habr.com/q/1353368), токен — [класс Csrf](https://docs.1c-bitrix.ru/api/classes/Bitrix-Main-Engine-ActionFilter-Csrf.html) и [check_bitrix_sessid](https://dev.1c-bitrix.ru/api_help/main/functions/other/check_bitrix_sessid.php), `ajax.php` с заголовком — [qna.habr.com/q/1406578](https://qna.habr.com/q/1406578), командная строка PHP — [документация](https://dev.1c-bitrix.ru/user_help/settings/utilities/php_command_line.php).
- Разбор сбоя входа (раздел 10, п. 1) выполнен чтением кода, а не прогоном.
- Сведения об OpenCart 3.0 проверены только для входа. MODX 2.x не читался.
