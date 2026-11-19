# c1. Документы агента и страницы сегодня: что взять в «Артефакты», что оставить страницам

Дата: 19.11.2026. Основа — рабочее дерево репозитория, ветка `feat/projects-purge-now` на `b1349f3b`
(незакоммиченные правки в нём — только в коде проектов: `project-trash.ts`, `projects.ts`, `project.ts`, кабинет
проектов; на документы и страницы они не влияют). Номера строк — по этому дереву. Прочитаны планы 67, 69, 73, 74
(решения и «Результат»), блоки spec §20 «Страницы, документы и публикации — решения 13.11.2026», «Сайты из страниц —
решения 14.11.2026», «Документ агента справа, по разделам — решения 14.11.2026», «Документы агента — решения
13.11.2026», «Вид работы агента и „Результаты“», spec §18 «Документы агента: домен страниц» и код ниже. Внешние факты
о браузерах — со ссылками и датами в конце; что не проверено — «не подтверждено».

## 0. Коротко

1. Сегодня три сущности, а не две:
   - **файл чата** `.html`/`.md` из `/workspace/out` (план 67) — неизменяемые версии в S3, «документ» = все строки
     `feed.file` одного имени в чате;
   - **документ агента по разделам** (`chat_documents*`, планы 69 и 74) — живой, в PostgreSQL, вид `page|text`;
   - **страница / сайт из страниц** (`page_trees`, `pages*`, планы 69 и 73) — анонимная публикация на
     `<метка>.pages.raditi.ru`, отдаёт `apps/preview` из PostgreSQL.
2. «Превью ≠ страница» владелец уже решил 13.11.2026 (Ст27, ответ сессии плана 67): вкладка «Документы» показывает
   файлы и документы, страницы — отдельно, «Опубликовать как страницу» — мост. Новая фраза «отделяй страницы от
   артефактов» ложится на это без спора: **артефакт = обобщённый документ агента (+ файл чата как вход), страница =
   опубликованный снимок артефакта**.
3. Живой путь (запись видна клиенту во время хода) есть только у документа: MCP пишет раздел сразу в PG, `core`
   проверяет его ключами хода и значениями переменных пространства раз в 1,5 с (план 74, Д2), кабинет перечитывает
   документ по `revision`. У страниц и файлов всё видимое появляется только в конце хода.
4. Документ пишет любой ход любого чата пространства — без проверки роли и без проверки версии. Клиент в кабинете не
   правит ни текст документа, ни содержимое страницы: ни одной мутации разделов или содержимого нет.
5. Документ показывается только в чате, где есть его строка `feed.doc`; сигнал правки идёт в ленту **пишущего** чата.
   Два чата над одним документом друг друга не видят. Общего списка документов нет ни в кабинете (`/pages` — только
   страницы), ни у агента (инструмента `doc_list` нет).
6. Доступ к документу — членство в пространстве (`readableDocument`); приватность проектов (ПР1: проект — только его
   автора) не учитывается. Шаринга документов нет (срез 67.5 снят 13.11.2026).
7. HTML агента со скриптами показывается безопасно только через `/v/<token>` на корне домена страниц с собственной CSP
   (`connect-src 'none'`, без `https:` в картинках). `srcdoc` в кабинете допустим только для HTML, который нарисовала
   платформа без скриптов: у CSP кабинета нет ни `script-src`, ни `connect-src`.
8. Рекомендация для движка: расширить `chat_documents*` на месте аддитивной миграцией (имена таблиц не менять, В7),
   разделы обобщить до «блоков» с видом, добавить таблицы доступов, ссылок, связей с чатами и комментариев, новый канал
   сигналов артефакта по образцу `task-signals`. Страницы не трогать, кроме моста публикации снимка.
9. Три названные ловушки подтверждены кодом, и к ним есть две новые находки:
   - контракт «платформа нигде не ставит cookie с `Domain=raditi.ru`», который обещал Ст3, в коде не найден;
   - стенд общих файлов закрытого сайта гоняется только в Chromium, а в Safari такие файлы, вероятно, не грузятся
     (не подтверждено).

## 1. Три сущности — сводная таблица

| | Файл чата (план 67) | Документ агента (планы 69, 74) | Страница / сайт (планы 69, 73) |
|---|---|---|---|
| Где байты | S3 `raditi-artifacts`, `chat-files/<taskId>/<fileId>` | PG: текст разделов, текст каждой версии, Markdown текущей версии | PG: `page_contents.bytes` — только текущая версия, `source` — её Markdown |
| Кто создаёт | outbox законченного хода (`ChatFiles.deliver`) | MCP `doc_create` и `doc_section_*` во время хода | MCP `page_publish` (резерв), версию делает `core` в конце хода; клиент — `pages.publishDoc` и `pages.publishFile` |
| Когда видно | после ответа хода (`feed.file`) | название и намерения — сразу; текст раздела — после проверки `core` (≈1,5 с); версия — в конце хода с `doc_finish` | адрес — сразу, в ответе агента; содержимое — в конце хода (`feed.page`) |
| Где показ | вкладка «Документы»: `.md` — `DocumentMarkdown`, `.html` — фрейм `/v/<token>` | вкладка «Документы»: пока пишется — разделы; готов — Markdown кабинета (`text`) или `srcdoc` с `readingPage` (`page`) | `https://<метка>.pages.raditi.ru/<путь>` без входа; раздел «Страницы» `/pages` |
| Версии | строки `feed.file` одного имени | v1, v2… по `doc_finish`; с 14.11.2026 хранится текст каждой версии | v1, v2…; хранится только текущая (Ст16) |
| Правка | нет: новая версия — новый файл | разделами, из любого чата пространства | агент — `page_edit` (поиск и замена), в конце хода; клиент — только метаданные |
| Шеринг | нет | нет | публичная ссылка, пароль, снятие, корзина |

## 2. Модель данных

### 2.1 Документ агента

- `ChatDocument` → `chat_documents` (`packages/db/prisma/schema.prisma:2530-2558`):
  - `workspace_id` — CASCADE; `task_id` — чат создания, SET NULL;
  - `title` — до 200 знаков;
  - `view` `page|text` (строка 2536; миграция `20261114100000_doc_view`, CHECK `chat_documents_view_check`; документы
    до неё — `text`);
  - `revision` (2538) растёт с каждой правкой — это сигнал карточке;
  - `current_version` — 0 до первого `doc_finish`;
  - `finish_task_id` и `finish_turn_no` (2543) — `doc_finish`, который ждёт конца хода (CHECK пары —
    `migrations/20261113130000_pages/migration.sql:253-259`).

  Комментарий схемы прямо говорит: «a document belongs to the workspace, any chat of it may write it» (2541-2542).
- `ChatDocumentSection` (2560-2585):
  - `section_key` по `^[a-z0-9][a-z0-9-]{0,39}$`, `position`, `heading`, `markdown` до 32 КиБ, `intent`;
  - `state` `pending|written`, `written_task_id` и `written_turn`;
  - `checked_turn` (2575): NULL — кабинет текста не получает;
  - `refusal` — одна из `pageRefusalReasons`.

  CHECK `chat_document_sections_check` (`migration.sql:263-276`): у `pending` нет текста и хода записи, у `written`
  есть заголовок, текст и ход, `checked_turn ≥ written_turn`, отказ бывает только у `pending`.
- `ChatDocumentVersion` (2588-2605): `no`, `size_bytes` до 512 КиБ, `sha256`, `task_id`, `turn_no`, `markdown` (2597;
  миграция `20261114160000_chat_document_version_text`). У версий до 14.11.2026 текста нет, кроме текущей.
- `ChatDocumentContent` (2607-2618) — Markdown текущей версии, составной FK на её строку истории.
- Следов значений переменных в базе нет (ответ владельца 13.11.2026, Ст19). Проверенность раздела — `checked_turn` и
  сумма того, что прочитал `core` (`sectionDigest`, `packages/db/src/pages.ts:80-81`): раздел, переписанный после
  проверки, проверенным не помечается.

### 2.2 Страницы и сайты

- `PageTree` → `page_trees` (2324-2350) — сайт, то есть хост:
  - `slug` char(26) unique; `name` — своё имя от 3 до 25 знаков (только «Бизнес» и выше);
  - пароль сайта: `password_hash` (scrypt) и `password_epoch`;
  - снятие хоста; `created_task_id` — только история.

  После очистки строка остаётся надгробием адреса: он навсегда отвечает 410.
- `PageFile` (2353-2369) — общие файлы `/_files/…`, байты в PG. `PageTreeName` (2372-2382) — все выданные когда-либо
  имена. `PageRedirect` (2385-2397) — 308 со старых путей.
- `Page` (2399-2459) — узел сайта:
  - место: `tree_id`, `parent_id`, `segment`, `path`, `position`;
  - `kind` `html|markdown|doc`, `title`, `state` `pending|live|taken_down`, `current_version`, `taken_down_*`;
  - `document_id` **unique** (2429): одна страница на документ;
  - `source_file_name`; корзина — `deleted_at`, `deleted_by`, `purge_after`.

  Уникальны путь в сайте и главная сайта (2452-2453).
- `PageVersion` (2463-2481) — только история: номер, размер, sha256, источник `outbox|doc|file`. Байтов прежних версий
  нет.
- `PageContent` (2484-2498) — байты текущей версии и `source` с Markdown (2489).
- `PageReservation` (2502-2526) — резерв хода:
  - при `kind='version'` — файл или документ, ровно одно из двух;
  - `kind` (2511) — `version`, `edit`, `update`, `delete`, `restore` или `asset`;
  - `payload` JSON, `outcome`.

### 2.3 Файл чата

- Своей таблицы нет. Файл — строка `task_events` `feed.file` v1 (`fileId`, `name`, `sizeBytes`) и объект S3
  `chat-files/<taskId>/<fileId>`. `fileId` — UUID v8 от чата, хода и имени (`apps/core/src/tasks/chat-files.ts:36-46`).
- Модель «документа» из файлов — чистые функции `packages/domain/src/tasks/chat-documents.ts`:
  - `documentKindOf` (10-15): `.html` и `.htm` — `page`, `.md` и `.markdown` — `markdown`;
  - `chatDocumentsOf` (86-113): документ — файлы одного имени, версии — по порядку строк.

  Схема `feed.file` планом 67 не менялась.

## 3. Жизненный цикл

### 3.1 Документ по разделам

1. **`doc_create {title, view, sections[{id, intent}]}`.** Роль `mcp` проверяет `checkSectionText` название и
   намерения (`apps/mcp/src/pages/docs-service.ts:165-185`), затем вызывает `createChatDocument`
   (`packages/db/src/pages.ts:2227-2250`):
   - строку пространства блокирует `FOR NO KEY UPDATE` и проверяет, что чат принадлежит этому пространству;
   - пускает не больше 500 документов на пространство и 40 разделов в документе.

   В ленту идёт `feed.doc` v1 — только `docId`, без названия (`packages/domain/src/pages/feed.ts:111-117`): название
   `core` проверяет в конце хода, а строку ленты переписать нельзя.
2. **`doc_section_write {docId, id, heading, markdown, after?}`.** Роль разбирает аргументы полной схемой, считает
   записи — не больше 120 за ход (`apps/mcp/src/pages/docs-store.ts:26-32`, ключ `doc-writes:<task>:<turn>`, окно
   24 ч), проверяет `checkSectionText` заголовок и текст. Затем `writeDocSection` (`pages.ts:2296-2343`):
   - берёт замок документа `FOR UPDATE`;
   - держит весь документ в пределах 512 КиБ;
   - заменяет раздел целиком: `state=written`, `checked_turn=NULL`;
   - увеличивает `revision`.

   В ленту **пишущего** чата идёт `feed.doc_touch {docId, revision}` (`docs-service.ts:290-295`).
3. **Живая проверка** (план 74, Д2):
   - `TurnSupervisor.run(…, { onArmed })` (`apps/core/src/turns/turn-supervisor.ts:73-80`, вызов — строка 249) отдаёт
     `PassRunner` функцию `attempt.liveRefusal()` (`turn-attempt.ts:649-651`): ключи хода и значения переменных;
   - `#liveDocs` (`apps/core/src/tasks/pass-runner.ts:259-297`) раз в `LIVE_DOC_CHECK_MS` = 1,5 с (строка 40) зовёт
     `DocSections.checkLive` (`doc-sections.ts:111-133`);
   - значения из Vault перечитываются не реже раза в `LIVE_DOC_VALUES_MS` = 15 с (строка 42); Vault не ответил — тик
     пропускается;
   - прошедший раздел получает `checked_turn`, отклонённый снова становится заглушкой с причиной; в ленту идут
     `feed.doc_touch` и `feed.doc_left` (`doc-sections.ts:144-170`);
   - `settleTurnSections({ final: false })` версий не делает.
4. **`doc_read {docId, from?}`.** Агент видит свой непроверенный текст и только проверенный текст других чатов
   (`readChatDocument`, `pages.ts:2432-2446`). Ответ — частями до 48 КиБ, со ссылкой `more.from` на следующую часть
   (`docs-service.ts:106, 120-141`).
5. **`doc_finish {docId, view?}`.** Пока есть `pending`, отказ `DOC_PENDING_SECTIONS`; иначе запоминаются
   `finish_task_id` и `finish_turn_no` (`pages.ts:2452-2478`).
6. **Конец хода.** `DocSections.settle` (`doc-sections.ts:56-105`) вызывается до ответа клиенту и только когда
   `refusesText` не null (`pass-runner.ts:391-392`):
   - проверяет все непроверенные разделы чата, в том числе оставленные упавшими ходами;
   - проверяет названия и намерения; найденное заменяется на «Документ» и «Раздел» (`pages.ts:54-55, 2608-2623`);
   - `settleTurnSections` делает версию N+1, когда все разделы проверены (`pages.ts:2626-2662`); `doc_finish` другого
     чата ждёт конца его хода (`turnEnded`, 64-71);
   - затем `PagePublications.publishDocuments` публикует документы, которые просили опубликовать.
7. **Сборщик.** Непроверенный текст в документах, которых не трогали сутки, стирается
   (`clearStaleUncheckedSections`, `pages.ts:2847-2862`; `apps/core/src/tasks/task-sweep.ts:76, 637`).
8. **Удаления документа нет** — ответ владельца 13.11.2026 (план 69, §8): «оставляй предел до 500 документов».

### 3.2 Файл чата

- Агент пишет файл в `/workspace/out`. Захват законченного хода собирает outbox (ustar и zstd, с манифестом). Пределы:
  30 файлов за ход, 20 МиБ на файл, 16 МиБ на сжатый архив, 200 знаков в имени
  (`packages/domain/src/tasks/chat-files.ts:12-28`).
- `core` читает архив с `refused` = ключи хода и `envValueForms` значений, **выданных ходу**
  (`turn-attempt.ts:530-544`). Любая находка отклоняет архив целиком, клиент получает `feed.file_left refused`.
- `ChatFiles.deliver` (`chat-files.ts:60-149`) после ответа хода кладёт каждый файл в S3 и пишет `feed.file`. Файлы,
  названные резервом страницы, становятся страницами — в порядке резервов, а не архива.

### 3.3 Страница

- **`page_publish`** (семейство `pages_changes`) → `reservePagePublication` (`pages.ts:343-421`):
  - блокирует строку пространства и держит предел: 120 публикаций в час на пространство, у агента и клиента общий
    (`publishesOfLastHour`, 132-146);
  - делает новый сайт (предел тарифа `plans.page_sites`, без тарифа — 1), новый узел по пути или версию `pageId` при
    совпавшем `expectedVersion`;
  - адрес возвращает сразу, страница — `pending`.
- **Конец хода:** `PagePublications.publish` (`apps/core/src/tasks/page-publications.ts:101-170`):
  - проверяет файл `checkPageContent`;
  - `.md` рисует `readingPage` и проверяет `checkPageContent` ещё раз;
  - `applyPageVersion` (`pages.ts:465-518`) пишет версию: номер только растёт, байты прежней заменяются;
  - клиенту — `feed.page` с предупреждениями о битых ссылках (`page-links.ts`), а если не вышло — `feed.page_left`.
- **Изменения** (`page_edit`, `update`, `delete`, `restore`, `file_*`) ход резервирует `reservePageChange`
  (`pages.ts:1363-1432`). Разрешено только чату, чей автор — владелец или администратор (`chatAuthorManages`,
  1290-1302). Применяет `PageChanges.apply` после файлов, по одному в порядке вызовов (`pass-runner.ts:421-422`).
- **Только у людей.** Снятие, пароль, корзина и очистка, имя сайта — у клиента (владелец или администратор) в
  кабинете. Поддержка снимает и возвращает командами `pages:take-down` и `pages:return`.

## 4. Что проверяется и кем

| Где | Что | Чем | Код |
|---|---|---|---|
| `mcp`: раздел, название, намерение | 32 КиБ; форма ключа хода; токены (JWT, `sk-`, `ghp_`, `github_pat_`, `glpat-`, `xox*`, `AKIA`, `AIza`, `y0_`, `AQVN`, `PRIVATE KEY`); поле пароля с формой наружу; заголовки `#` и `##` вне кода | `checkSectionText`, `sectionMarkdownProblem` | `content-check.ts:22-44, 119-126`; `doc.ts:39-53` |
| `mcp`: документ | 512 КиБ целиком, 40 разделов, 500 документов на пространство, 120 записей за ход | `writeDocSection`, `createChatDocument`, `admitInWindow` | `pages.ts:2228-2232, 2304-2309`; `docs-store.ts:26-32` |
| `core`: разделы, живо и в конце хода | точные ключи хода; значения переменных пространства во всех написаниях — как есть, JSON один и два раза, кавычки shell; затем проверки роли по каждой части | `textRefusal`, `checkSectionText` | `apps/core/src/turns/text-refusal.ts:9-21`; `doc-sections.ts:38-46`; `packages/domain/src/release/env-masking.ts:33-41` |
| `core`: outbox | ключи хода и значения, **выданные ходу** (не текущие из Vault) | `readOutboxArchive({ refused })` | `turn-attempt.ts:533-535` |
| `core`: версия страницы | UTF-8, 2 МиБ, ключ хода, токены, форма пароля наружу; у `.md` и документа — и нарисованный HTML | `checkPageContent` | `content-check.ts:101-113`; `page-publications.ts:118, 133, 224` |
| `core`: изменения страниц | текст правки — как страница и значениями; заголовок и сегмент — значениями | `PageChanges` | `page-changes.ts:101, 154` |
| web: публикация клиентом | `checkPageContent` файла и нарисованного; значений нет — файл прошёл outbox своего хода, документ — проверку разделов | `checked()` | `packages/trpc/src/services/pages.ts:529-533, 556-576, 610-620` |

Пределы проверки значений:

- значения короче 8 байт не ищутся (`envVarLimits.maskMinBytes = 8`, `packages/domain/src/release/env-vars.ts:60`;
  решение владельца 25.10.2026);
- формы base64 и URL не ищутся (`env-masking.ts:26-32`);
- значения ищутся среди текущих значений переменных пространства (`siteValues`,
  `apps/core/src/llm/turn-credentials.ts:447-466` — Vault `kv/workspaces/<ws>/env/*`) и среди выданных ходу
  (`turn-attempt.ts:658-665`);
- Vault не ответил в конце хода — `refusesText = null`: разделы ждут следующего конца хода, а изменения страниц этого
  хода не применяются (`pass-runner.ts:391, 421`) и через сутки их закрывает сборщик.

## 5. Когда клиент что видит

- **`doc_create`:** карточка и вкладка показывают название, намерения и «пишется · 0 из M». Название `pages.doc` отдаёт
  сразу: `readChatDocument` отдаёт `title` без условий.
- **Сразу после записи раздела:** в месте раздела — намерение и «Проверяем раздел…» (`state: 'unchecked'`,
  `packages/trpc/src/services/pages.ts:356-366`). «Разделы: N из M» считает написанные (Д3).
- **Через 1,5 с и время проверки:** текст раздела. Не раньше, чем ход «взведён» после `prepare` драйвера.
- **Конец хода:** версия vN (если был `doc_finish` и всё проверено), публикация документа, `feed.file` и `feed.page`,
  изменения страниц.
- **Панель** открывается сама, когда при открытом чате пришла `feed.doc` после первого ответа ленты, — от ширины `lg`
  (план 74, Д5); у́же — только точка на «+».
- **Telegram** узнаёт `feed.file`, `feed.page`, `feed.page_left` и `feed.doc_left`, но не `feed.doc`
  (`apps/core/src/telegram/telegram-jobs.ts:110-131`): о новом документе в Telegram не говорится.

## 6. Отрисовка, CSP и origin

- **`pagesOriginOf(env)`** (`packages/domain/src/pages/origin.ts:12-18`): `https://<PAGES_BASE_DOMAIN>` в production,
  `http://<домен>:<порт APP_URL>` вне его; неверный домен — null, и страниц нет. Хост даёт `pagesHostOf`
  (`apps/web/src/lib/pages-origin.ts:6-9`).
- **`proxy.ts`** (`apps/web/src/proxy.ts:31-51`, `matcher` на все пути — 53-56):
  - на хосте страниц отвечают только `GET`/`HEAD` `/v/<token>` (`PAGES_PATHS = /^\/v\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/`,
    `pages-origin.ts:12`) и `/robots.txt`; остальное — 404 без `Set-Cookie`;
  - на хосте кабинета `/v/` и `/s/` — 404 (строка 44).
- **Токен `/v/`** (`packages/trpc/src/services/chat/page-tokens.ts:11-25, 59-89`):
  - вид `base64url(JSON{t,f,u,e}).base64url(HMAC)`; ключ — HKDF-SHA256 от `PAGES_SIGNING_SECRET` с `info`
    `raditi-page-view-v1`, метка подписи `view\0`; живёт 5 минут;
  - выдаёт мутация `document.pageView` — только участнику чата и только для строки `feed.file` с `.html`
    (`packages/trpc/src/services/chat/documents.ts:53-73`);
  - id пользователя в токене лежит открытым base64 — риск, записанный планом 67, §3.
- **Маршрут** `apps/web/src/app/v/[token]/route.ts:11-16` → `getPageView` (`apps/web/src/server/page-response.ts:50-72`):
  - ещё раз сверяет `Host`; истёкший токен — 410;
  - читает файл `readTaskFile` (с проверкой членства);
  - отвечает заголовками `pageResponseHeaders('html', { framedBy: appOrigin })` (`page-response.ts:12-17`).
- **Политики** (`packages/domain/src/pages/headers.ts`):
  - `PAGE_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'` (45);
  - `pagePolicy(kind, framedBy?)` (58-75), вид `html`:
    - `sandbox …`; `script-src 'unsafe-inline'`, у опубликованной — `'self' 'unsafe-inline'`;
    - `default-src 'none'`, `style-src`;
    - картинки, шрифты и медиа: в кадре кабинета — только `data: blob:` (27); у опубликованной — `'self' data: blob:
      https:` (16-20). Утечку адресом картинки владелец принял только для опубликованных (Ст9);
    - `connect-src`, `form-action` и `frame-src` — `'none'`; `frame-ancestors` — origin кабинета или `'none'`;
    - `object-src`, `worker-src`, `manifest-src` — `'none'`, `base-uri 'none'`;
  - вид `reading` — то же без скриптов (`script-src 'none'`);
  - `PAGE_PLATFORM_CSP` (88-98) — свои ответы платформы: без sandbox, без скриптов, `form-action 'self'`;
  - общие заголовки (101-109): `nosniff`, `no-referrer`, `noindex`, COOP и CORP `same-origin`, `Permissions-Policy`;
  - кэш (118-128): страница — `private, no-cache`; кадр кабинета и ответы платформы — `no-store`.
- **Фрейм вкладки:** `<iframe src=/v/… sandbox={PAGE_SANDBOX} referrerPolicy="no-referrer">`
  (`apps/web/src/components/chat/documents-pane.tsx:617-672`, атрибуты — 660-666). Новый адрес — новый фрейм
  (`key={url}`).
- **Документ вида `page`:** `pages.docPage` → `readingPage` (`packages/doc-render/src/reading-page.ts:56-90`) →
  `<iframe srcDoc sandbox="allow-popups allow-popups-to-escape-sandbox">` (`agent-document.tsx:433-461`; прежние версии —
  `EarlierVersion`, 297-338).
  - `readingPage` рисует с `skipHtml` и `rehypeDocumentRules`, с `documentLinks: false` и `treeLinks: true`, со
    встроенным CSS и `noindex`;
  - скриптов во фрейме нет; HTML — платформы, а не агента.
- **CSP кабинета** (`apps/web/src/lib/content-security-policy.ts:18-27`):
  - `frame-ancestors 'none'`, `frame-src 'self' smartcaptcha <origin страниц>`, `img-src 'self' data: blob:
    smartcaptcha`;
  - **нет ни `script-src`, ни `connect-src`** (TODO M8).

  Поэтому HTML агента со скриптами класть в `srcdoc` кабинета нельзя.
- **Опубликованные страницы:** `apps/preview/src/pages/pages-server.ts`, `#handle` — 181-292. Порядок ответа:
  1. строгий хост (`slugOfPageHost`);
  2. `/robots.txt`, затем `/_files/`;
  3. путь — только по схеме (`pageRequestPath`);
  4. сайт снят или в корзине — 410;
  5. своё имя сайта — 308;
  6. пароль — раньше любого узла;
  7. канон и переадресация — 308;
  8. узел: 404 или 410;
  9. документ без версии — «Документ ещё пишется» (200);
  10. ETag и 304;
  11. 200 с политикой `html` или `reading`.

  Источник — только PostgreSQL: правило `pages-request-path` (`.dependency-cruiser.cjs:509-523`).

## 7. Версии

- **Документ.**
  - `revision` растёт с каждой правкой; это не версия;
  - версия появляется только по `doc_finish` в конце хода; номер только растёт;
  - с 14.11.2026 текст каждой версии хранится (`docVersions`, `docVersionMarkdown` — `pages.ts:2704-2740`; переключатель
    версий в шапке — `VersionSwitch`, `agent-document.tsx:345-412`);
  - предела числа версий нет;
  - «правка готового» открывает рабочее состояние поверх версии: флаг `draft` (`services/pages.ts:374`, сравнение
    собранного Markdown с текущей версией).
- **Страница.**
  - одна ссылка, номер версии — только подпись;
  - байты хранятся только у текущей версии, «Вернуть версию» нет (Ст16; ответы владельца 13.11.2026, второй и
    третий раз);
  - в `page_contents.source` лежит исходный Markdown — `page_read` отдаёт его агенту (Дер26).
- **Файл чата.** Каждая версия — отдельный объект S3 со своим `fileId`; номер — порядок строк ленты; чужие версии
  неизменны.

## 8. Квоты и лимиты

| Что | Значение | Где |
|---|---|---|
| Документов на пространство | 500, удаления нет | `packages/domain/src/pages/limits.ts:33` |
| Разделов в документе | 40 | `limits.ts:35` |
| Раздел | 32 КиБ | `limits.ts:37` |
| Документ целиком | 512 КиБ | `limits.ts:39` |
| Записей разделов за ход | 120 | `limits.ts:41` |
| Название, заголовок, намерение | 200 знаков, одна строка | `limits.ts:43`, `doc.ts:13-28` |
| Страница (байты версии) | 2 МиБ | `limits.ts:7` |
| Страниц на пространство | 2 000 (с 16.11.2026); корзина не считается | `limits.ts:13` |
| Страниц в сайте; глубина; путь | 100; 8 уровней; 512 знаков | `limits.ts:15-19` |
| Сайт; общий файл | 50 МиБ; 5 МиБ | `limits.ts:21-23` |
| Сайтов | по тарифу `plans.page_sites`: 20, 100, 200; без тарифа — 1 | `sites.ts:10-12`, миграция `20261117170000_plans_page_sites_more` |
| Публикаций в час | 120, у агента и клиента общие | `limits.ts:31` |
| Корзина | 30 дней | `limits.ts:29` |
| Удалений агентом за ход | 20 | `pages.ts:1283` |
| Пароль; попытки | 4–128 знаков; 10 за 15 мин с адреса, 100 в час на страницу; cookie на 12 ч | `limits.ts:45-55` |
| Outbox | 30 файлов, 20 МиБ на файл, 16 МиБ на архив | `chat-files.ts:12-28` |
| Markdown во вкладке | 2 МиБ, дальше — текстом | `chat-documents.ts:22-28` |
| Тело запроса MCP; JSON ответа; часть `doc_read` | 100 КиБ; 64 КиБ; 48 КиБ | `apps/mcp/src/access/mcp-policy.ts:59`; `apps/mcp/src/common/canonical-json.ts`; `docs-service.ts:106` |
| Токен `/v/` | 5 минут | `page-tokens.ts:11` |
| Деньги | публикация и хранение бесплатны (Ст17, Дер31); проход агента — по токенам | план 69, план 73 |

Неиспользуемые константы шаринга, оставшиеся от снятого среза 67.5: `documentViewLimits.sharedImages` = 30 и
`sharedImageBytes` = 8 МиБ (`chat-documents.ts:26-27`); их не читает ни один модуль.

## 9. Кто может писать и читать

- **Документ — агент.** Пишет любой ход любого чата пространства. `lockDocument` сверяет только `workspace_id`
  (`pages.ts:103-110`): ни роли автора чата, ни проекта, ни ожидаемой ревизии. Читает тоже любой ход пространства, но
  непроверенный текст — только того чата, что его написал (`pages.ts:2433-2437`). В проходе без надзора семейство
  `docs` остаётся: из прохода скрываются только `pages_changes` и `schedule_changes` (`mcp-policy.ts:142-146`).
- **Документ — кабинет.** Читает любой участник пространства (`readableDocument`, `services/pages.ts:301-308`), в том
  числе документ из чата чужого приватного проекта, — а чаты проекта открывает только автор проекта (`accessibleTask`,
  `packages/trpc/src/services/chat/access.ts:11-19`). Публикует владелец или администратор (`publishDocumentPage`,
  `services/pages.ts:540-577`). Правки текста нет.
- **Страница — агент.** Читать и публиковать новую страницу или версию может любой ход пространства, где страницы
  настроены. Правка, перенос, удаление и возврат — только из чата, чей автор сейчас владелец или администратор (Дер24).
  Без надзора — только чтение.
- **Страница — кабинет.** Участник видит список и копирует ссылку. Владелец и администратор ставят пароль, снимают,
  удаляют, переносят, дают имя и удаляют файлы сайта.
- **Файл чата.** Пишет только outbox хода. Читает участник чата (`readTaskFile`).

## 10. MCP-инструменты: имена, семейства, аргументы

Модель видит имена с префиксом `raditi_`. Схемы — `packages/domain/src/pages/tools.ts`. Объявление в политике —
`apps/mcp/src/access/mcp-policy.ts`: `docsCall` — 88-96, `pagesCall` — 101-106, `pagesChangeCall` — 107-115, семейства —
235-268.

| Инструмент | Семейство | Аргументы (строгий объект) | Аннотации | Код |
|---|---|---|---|---|
| `doc_create` | `docs`: любой ход, и без надзора | `{title: 1–200, одна строка; view: 'page' \| 'text'; sections: [{id: /^[a-z0-9][a-z0-9-]{0,39}$/, intent: 1–200}] — от 1 до 40, id уникальны}` | запись, idempotent | `tools.ts:138-149`; `mcp-docs.controller.ts:57-68` |
| `doc_section_write` | `docs` | объявлено: `{docId: uuid; id; heading; markdown: string; after?: string \| null}` (форма `docSectionWriteShapeSchema`); внутри — `heading` 1–200, `markdown` до 32 КиБ без `#` и `##` | запись | `tools.ts:153-174`; `mcp-docs.controller.ts:70-82` |
| `doc_section_remove` | `docs` | `{docId, id}` | destructive | `tools.ts:177-180` |
| `doc_section_move` | `docs` | `{docId, id, after: id \| null}` | запись | `tools.ts:183-187` |
| `doc_read` | `docs` | `{docId, from?: id}` | только чтение | `tools.ts:190-193` |
| `doc_finish` | `docs` | `{docId, view?: 'page' \| 'text'}` | запись | `tools.ts:196-199` |
| `page_list` | `pages`: при `PAGES_BASE_DOMAIN` | `{query?: до 200; offset?: 0–10000; limit?: 1–100}` | чтение | `tools.ts:55-59` |
| `page_tree` | `pages` | `{treeId}` | чтение | `tools.ts:62` |
| `page_read` | `pages` | `{pageId; offset?; limit?: 1–65536}` | чтение | `tools.ts:65-69` |
| `page_files` | `pages` | `{treeId}` | чтение | `tools.ts:131` |
| `page_publish` | `pages_changes`: не без надзора | инструмент: `{file?; docId?; title?; pageId?; expectedVersion?; treeId?; path?}`, правило домена — объединение `{file, title, pageId?, expectedVersion?, treeId?, path?}` (`pageId` исключает `treeId` и `path`; `treeId` только вместе с `path`) или `{docId, title?}` | idempotent | `tools.ts:31-51`; `apps/mcp/src/pages/pages-arguments.ts:26-58` |
| `page_edit` | `pages_changes` | `{pageId; expectedVersion; edits: [{old: 1–20000; new: до 20000; all?}] — от 1 до 20}` | запись | `tools.ts:72-85` |
| `page_update` | `pages_changes` | `{pageId; expectedVersion; title?; segment?; parentId?; position?: 0–1000}` — хотя бы одно поле | запись | `tools.ts:88-104` |
| `page_delete` | `pages_changes` | `{pageIds: uuid, от 1 до 20; withChildren?; confirmedByClient: true}` | destructive | `tools.ts:110-114` |
| `page_restore` | `pages_changes` | `{pageIds: uuid, от 1 до 20}` | запись | `tools.ts:134-136` |
| `page_file_put` | `pages_changes` | `{treeId; file: имя outbox; path: /_files/…}` | idempotent | `tools.ts:117-121` |
| `page_file_delete` | `pages_changes` | `{treeId; path; confirmedByClient: true}` | destructive | `tools.ts:124-128` |

- Отказы домена приходят результатом с `isError` и `{code, message}`, а не ошибкой протокола
  (`mcp-docs.controller.ts:23-31`).
- Пространство, чат и ход берутся из допуска хода (`McpTurnAccess`), никогда из аргументов.
- Описания `doc_*` уходят модели в каждом ходе: «цена „объявлены всегда“» (план 69, 69.8). Владелец велел их не
  сокращать (итог 69.10).

## 11. Как документ становится страницей (Ст32, `publishDoc`)

1. **Агент.** `page_publish({ docId, title? })` → `reservePagePublication` с целью `documentId` (`pages.ts:398-403`):
   страница документа создаётся с `kind: 'doc'` и `pending` или берётся уже существующая (`document_id` unique).
   - Зритель до версии получает «Документ ещё пишется» — 200 и `noindex` (Ст25).
   - В конце хода, после разделов, `PagePublications.publishDocuments` (`page-publications.ts:178-255`): если этот
     конец хода вернул разделы документа в заглушки — `feed.page_left refused`; иначе, если есть версия, —
     `readingPage(title, markdown)`, `checkPageContent`, `applyPageVersion(source: 'doc', markdown)` и `feed.page`
     с `kind: 'doc'`; версии нет — резерв ждёт следующего конца хода. Сборщик такие резервы не трогает
     (`stalePageReservations`, `pages.ts:2785-2802`).
2. **Клиент, «Опубликовать по ссылке».** `pages.publishDoc({ docId })` (`packages/trpc/src/routers/pages.ts:227-238`) →
   `publishDocumentPage` (`services/pages.ts:540-577`):
   - участник пространства и роль владельца или администратора; чат документа не удалён;
   - нет версии — `DOC_NOT_READY`;
   - `readingPage`, затем `checked()`, затем `publishClientPage(target: { documentId })` (`pages.ts:551-650`): следующая
     версия страницы документа или новый сайт в пределах тарифа; источник версии — `doc`, хода нет.
3. **Клиент, «Опубликовать как страницу» у файла `.html` или `.md`** (Ст32, изменён Дер9). `pages.publishFile({ taskId,
   fileId, target })` (`routers/pages.ts:241-257`) → `publishChatFilePage` (`services/pages.ts:596-645`):
   - `accessibleTask` и роль владельца или администратора; файл из `raditi-artifacts`; только `.html` и `.md`
     (`PAGE_NOT_PUBLISHABLE`);
   - проверка `checkPageContent`; `.md` — `readingPage` с заголовком из самого файла и повторная проверка;
   - цель — `{ new: { title? } }` или `{ pageId, expectedVersion }`; цели «в сайт по адресу» в роутере нет, хотя
     `publishClientPage` умеет `place` (план 73, 73.4 — «со срезом 73.8»);
   - повторного поиска значений переменных нет (Ст6).

Страница — снимок: новая версия документа сама страницу не меняет. Нужен ещё один `page_publish({ docId })` или
«Опубликовать по ссылке».

## 12. Сигналы и живость

- Строки ленты `feed.doc`, `feed.doc_touch` и `feed.doc_left` пишутся прямо в `task_events` (`insertFeedEvent`,
  `packages/db/src/feed-events.ts:23-36`): роль `mcp` пишет их сама, как `apps/browser` пишет `feed.screenshot`.
- Путь сигнала (план 86): триггер миграции `20261118140000_task_signals` (`pg_notify('raditi_task', …)` на `task_events`,
  `tasks`, `browser_sessions`) → `LISTEN` в `core` (`apps/core/src/task-signals/task-signal-relay.ts`) → Redis
  `raditi:task:<id>` → web (`apps/web/src/server/task-signals.ts`) → SSE `task.signals`. Права проверяются при
  подключении и раз в 15 с.
- Кабинет перечитывает документ, когда в ленте **этого** чата появилась `feed.doc_touch` с ревизией новее прочитанной:
  `docRevisionsOf` и `DocRevisions` (`apps/web/src/components/chat/agent-document.tsx:86-97`), `useAgentDocument`
  (100-110). Таймера нет.
- Список документов вкладки берётся из строк `feed.doc` этого чата (`agentDocumentIdsOf`, `agent-document.tsx:74-80`);
  список файлов — из `feed.file` (`chatDocumentsOf`).

## 13. Пробелы по запросу владельца

1. Клиент не правит текст — ни раздела, ни страницы. Совместной работы «агент и пользователь» нет.
2. Нет общего списка документов: ни раздела кабинета, ни tRPC-списка, ни инструмента `doc_list`. Чужой документ агент
   находит, только зная `docId` или через `page_read` опубликованной страницы.
3. Сигналы привязаны к ленте чата. Правка из чата Б не обновляет вкладку чата А, а в чате Б документа нет в списке
   (`agentDocumentIdsOf` читает только `feed.doc`).
4. Нет оптимистической проверки у записи разделов: нет `expectedRevision`, последняя запись побеждает; агент Б не видит
   непроверенный раздел агента А и может его переписать.
5. Документ нельзя удалить; предел 500 считает все документы.
6. Нет шаринга пользователям и ролей просмотра, комментария и правки. Приватность проектов (ПР1) документы не
   соблюдают.
7. Нет привязки к проекту: в `chat_documents` нет `project_id`; проект плана 84 виден только через `tasks.project_id`
   чата создания.
8. HTML-артефакт с живой правкой отсутствует: `.html` — неизменяемый файл outbox, страница меняется только в конце хода.
9. Только Markdown-разделы; Mermaid и формулы не рисуются (план 67, §4, п. 3).
10. Комментариев и пометок нет (Ст28).
11. Telegram о новом документе не говорит.

## 14. Движок артефактов: что обобщать

### 14.1 Три варианта

| | А. Расширить `chat_documents*` на месте | Б. Новые таблицы `artifacts*` и перенос | В. Зонтичная `artifacts` и тела по видам |
|---|---|---|---|
| Выкладка (`deploy.sh` применяет `migrate` при работающем старом коде — план 73, §1, §4.2) | только аддитивные столбцы со значениями по умолчанию: старый код работает | окно двойной записи: старый `core` пишет в `chat_documents` между `migrate` и `up` | нужен триггер `AFTER INSERT` на окно выкладки |
| FK `pages.document_id` | остаётся | перенацеливать | остаётся |
| Решение В7 («не переименовывать `chat_documents*`», значение по умолчанию плана 73) | соблюдено; модели Prisma можно назвать `Artifact*` через `@@map` без DDL | нарушено | соблюдено |
| Новые виды | блоки с видом в той же таблице разделов | свободно | у каждого вида своё тело |
| Объём и риск | наименьшие | наибольшие | средние |

Рекомендация — **А**. Документ уже содержит то, что нужно артефакту: блоки с состоянием, проверку `core` по сумме
прочитанного, живую проверку, `revision` для сигналов, версии с текстом, `doc_finish` с ожиданием чужих ходов и мост
публикации в страницу.

### 14.2 Аддитивная миграция (предложение)

- **`chat_documents`:**
  - `kind varchar(16) NOT NULL DEFAULT 'doc'` — CHECK `doc|html|canvas|…`;
  - `project_id uuid NULL REFERENCES projects ON DELETE SET NULL`;
  - `created_by_id uuid NULL REFERENCES users ON DELETE SET NULL`;
  - корзина: `deleted_at`, `deleted_by`, `purge_after` — как у страниц (Дер2).

  Бэкфилл `project_id` и `created_by_id` из `tasks` чата создания: `UPDATE … FROM tasks`, повторяемо.
- **`chat_document_sections` → «блоки»:**
  - `kind varchar(16) NOT NULL DEFAULT 'markdown'` — `markdown|html|csv|json|mermaid`;
  - `meta jsonb NULL` — размер доски, координаты;
  - `written_by_id uuid NULL` — правка клиента.

  CHECK переписать в одной транзакции (`DROP` и `ADD` внутри `BEGIN … COMMIT`, правило CLAUDE.md): `written` — либо
  ход (`written_task_id`, `written_turn`), либо пользователь. Строки старого кода остаются верными.
- **`artifact_chats (artifact_id, task_id, first_turn, last_turn)`** — список вкладки по связи, а не по строкам ленты.
  Бэкфилл из `chat_documents.task_id`, `chat_document_sections.written_task_id` и строк `feed.doc`/`feed.doc_touch`.
- **`artifact_grants (artifact_id, user_id, role viewer|commenter|editor, granted_by_id, created_at, revoked_at)`.**
- **`artifact_links (id, artifact_id, token_hash char(64) unique, role, created_by_id, expires_at, revoked_at, opens)`** —
  ссылка открывает артефакт только вошедшему пользователю; токен хранится хешем.
- **`artifact_comments (id, artifact_id, section_id NULL, anchor jsonb NULL, author_user_id NULL, author_task_id NULL,
  author_turn NULL, body, state open|resolved, created_at)`.**
- **Канал `raditi_artifact`:** `pg_notify` по `UPDATE OF revision` в `chat_documents` и по вставке комментария → relay
  в `core` (по образцу `task-signal-relay.ts`) → Redis `raditi:artifact:<id>` → SSE `artifact.signals` с проверкой
  доступа раз в 15 с.

### 14.3 Слои

- **Домен** (`@repo/domain/artifacts`): виды, схемы блоков, `assembleArtifact(kind)` вместо `assembleDocMarkdown`,
  пределы по видам; проверки — прежние `checkSectionText` и `checkPageContent`.
- **MCP.** Одно семейство `artifacts` вместо `docs`, чтобы не платить токенами за два набора описаний:
  - `artifact_list` — нового пока нет;
  - `artifact_create`, `artifact_read` (части по 48 КиБ, как `readPart`);
  - `artifact_block_write` с `expectedRevision`; `artifact_block_edit` — поиск и замена в духе `page_edit`, для HTML
    больше 100 КиБ тела MCP;
  - `artifact_block_remove`, `artifact_block_move`, `artifact_finish`;
  - `artifact_comments`, `artifact_comment_reply`.

  Права агента — не шире прав автора чата (как Дер24), по новому `artifact_grants`. Публикация остаётся
  `page_publish({ docId })`.
- **Core.** `DocSections` обобщается до блоков. Алгоритм прежний: сумма прочитанного, `checkLive` раз в 1,5 с, конец
  хода. HTML-блоки проверяются `checkPageContent` и `refusesText`. `PagePublications.publishDocuments` рисует снимок по
  виду: doc — `readingPage`, html — как есть, доска холста — одна страница сайта.
- **Web.**
  - раздел «Артефакты» в кабинете;
  - вкладка панели — переименованная «Документы»;
  - просмотр по видам: doc — нынешний `AgentDocumentView`; html и доски — фрейм `/v/` с новой меткой токена,
    например `artifact\0` и полезной нагрузкой `{a, v|r, b, u, e}`, чтобы старый и новый токен не путались;
  - правка Markdown-блока клиентом с `expectedRevision`; окно «Поделиться»; комментарии.

### 14.4 Что переиспользуется как есть

| Что | Где | Как |
|---|---|---|
| Проверка содержимого без значений | `content-check.ts:101-126` | для каждого блока и при публикации |
| Проверка значениями и ключами хода | `text-refusal.ts:9-21`, `turn-attempt.ts:649-665`, `turn-supervisor.ts:73-80, 249` | живая проверка блоков любого вида |
| Цикл живой проверки | `pass-runner.ts:259-297`, `doc-sections.ts:111-133` | без изменений |
| Состояния разделов, сумма прочитанного, CHECK | `pages.ts:80-81, 2541-2683`; `migration.sql:263-276` | обобщить вид блока |
| Версии с текстом | `pages.ts:2704-2740`; миграция `20261114160000…` | все виды |
| Части `doc_read` | `docs-service.ts:106-141` | `artifact_read` |
| Счётчик записей за ход | `docs-store.ts:26-32` | все записи блоков |
| Отказ результатом, `@ToolScopes`, политика тела | `mcp-docs.controller.ts:23-41`; `mcp-policy.ts:88-115` | семейство `artifacts` |
| Просмотр HTML в чужом origin | `page-tokens.ts`; `page-response.ts`; `proxy.ts:36-43`; `documents-pane.tsx:617-672` | новая метка токена |
| Отрисовка Markdown | `@repo/doc-render` — `DocumentMarkdown`, `rehypeDocumentRules`, `readingPage` | без изменений |
| Вкладка, история «Назад/Вперёд», версии, «На весь экран», «Скачать», «Опубликовать» | `documents-pane.tsx:162-…`; `agent-document.tsx:471-…` | вкладка «Артефакты» |
| Автооткрытие от `lg` | `use-document-arrivals.ts`; `dialog-view.tsx:570-591` | событие прихода артефакта |
| «Результаты» | `results-card.tsx` | «Артефакты чата» |
| Сигналы | `apps/core/src/task-signals/*`, `apps/web/src/server/task-signals.ts` | канал `raditi_artifact` |
| Мост в страницу | `publishDocumentPage`, `publishDocuments`, `page_publish({ docId })` | снимок артефакта |

### 14.5 Виды и ограничения движка (кратко; перечень видов — у других исследований)

| Вид | Тело | Показ | Публикация | Чего нет сегодня |
|---|---|---|---|---|
| Текст (`doc`) | Markdown-блоки | кабинет или `readingPage` | `readingPage` | Mermaid, формулы |
| HTML-страница | 1 HTML-блок | `/v/` с `PAGE_SANDBOX`: скрипты есть, сети нет | как есть, под `PAGE_CSP` | превью не грузит `https:`-картинки и шрифты, опубликованная — грузит |
| Холст (доски дизайна) | HTML-блоки-доски и `meta` | кабинет раскладывает доски, у каждой свой фрейм `/v/` | доска — страница сайта, ассеты — `page_files` | моста `postMessage`, хранилища ассетов артефакта |
| Таблица | CSV или JSON | таблица кабинета | Markdown-таблица | — |
| Диаграмма | текст Mermaid | фрейм с рендером платформы — новая зависимость | не SVG: SVG в документах запрещён | рендера |

## 15. Что должно остаться только у страниц

- Анонимная отдача на `<метка>.pages.raditi.ru` процессом `apps/preview` только из PostgreSQL (`pages-request-path`).
  Строгий хост, 404 и 410, ETag, `noindex`.
- Сайт: дерево и пути, переадресации, общие файлы `/_files/`, своё имя и надгробия имён, предел сайтов по тарифу.
- Пароль сайта, cookie `raditi_page`, окно попыток, снятие поддержкой (`pages:take-down`, `pages:return`), корзина
  страниц.
- Политика `PAGE_CSP` с `https:` в картинках, шрифтах и медиа: утечку адресом картинки владелец принял только для
  опубликованного (Ст9). Приватный артефакт держит узкую политику кадра.
- «Одна ссылка — текущая версия», байты только последней версии (Ст16). У артефакта — вся история.
- Строки `feed.page*` и раздел «Страницы».
- Вывод: артефакт не получает публичного адреса сам по себе. Публично — только «Опубликовать как страницу». Ссылка
  «Поделиться» артефактом — только для вошедших пользователей, иначе рядом со страницами появилась бы вторая система
  отзыва, пароля и пределов (довод Ст2).

## 16. Путь миграции

1. **Миграция.** Аддитивная, по §14.2: новые столбцы со значениями по умолчанию, новые таблицы, бэкфилл. Старый код в
   окне выкладки новых столбцов не видит и пишет строки со значениями по умолчанию; повторяемый бэкфилл при старте
   `core` их добирает.
2. **Документы.** Все `chat_documents` становятся артефактами вида `doc` без переноса байтов. `pages.document_id`,
   версии и текст версий остаются.
3. **Файлы `.html` и `.md` плана 67.** Остаются файлами чата в той же вкладке: S3 и до 20 МиБ. Массового переноса нет.
   Кнопка «Сделать артефактом»:
   - `.md` — документ, разделы режутся по `##`;
   - `.html` — HTML-артефакт.

   Файл уже прошёл outbox своего хода, поэтому проверка — как у `publishFile`.
4. **Вкладка «Документы».** Подпись меняется на «Артефакты». Внутренний id `documents` можно оставить: его называют
   только модульные тесты (`tools-panel.test.tsx:46, 54`, `dialog-tools.test.ts:156`). Список строится по
   `artifact_chats` (плюс файлы по `feed.file`), живость — по `artifact.signals`. Строки `feed.doc*` остаются историей
   чата.
5. **Стенды.** Имена инструментов называют сценарные программы `verify:browser-task`
   (`infra/dev/browser-task-verify/scenarios.mjs`, `programs.mjs`, `model.mjs`). `verify:mcp-content` сверяет список
   инструментов целиком. Переименование `doc_*` правит их в том же коммите.
6. **`/pages`.** Не меняется. У опубликованного артефакта — ссылка на его страницу и подпись «опубликовано vN, артефакт
   vM».
7. **Позже.** Модели Prisma можно переименовать (`ChatDocument` → `Artifact` с `@@map`) без DDL. Удаление столбцов —
   только двумя выпусками: сначала `@ignore`, потом `DROP` (план 73, §4.3).

## 17. Ловушки

1. **Заголовки `next.config.ts`.**
   - Next ставит заголовки `headers()` раньше маршрута, и обработчик маршрута их не перекрывает. Это проверено планом 67
     на `next start`; документация Next 16.3.6: «Headers are checked before the filesystem…»
     (`apps/web/node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/headers.md:43`). Ответ
     proxy перекрывает (`content-security-policy.ts:5`).
   - Сегодня это закрыто так: `source: '/((?!v/).*)'` (`apps/web/next.config.ts:98`), контракт —
     `apps/web/src/next-config.test.ts:97-102`.
   - Любой новый путь на корне домена страниц нужно править в четырёх местах:
     - исключить из регулярки `headers()`;
     - добавить в `PAGES_PATHS` (`pages-origin.ts:12`);
     - отдать 404 на хосте кабинета (`proxy.ts:44`);
     - перепроверять `Host` в самом маршруте (`page-response.ts:58-59`).

     Иначе кадр получит `X-Frame-Options: DENY` и `frame-ancestors 'none'`.
   - Проще не заводить новых путей, а взять `/v/` с новой меткой токена.
2. **Cookie tossing на `*.pages.raditi.ru`.**
   - `pages.raditi.ru` и `<метка>.pages.raditi.ru` — один сайт с кабинетом `raditi.ru`.
   - Cookie кабинета better-auth 1.7.6 по умолчанию: имя `__Secure-better-auth.*` при https-адресе, `SameSite=Lax`,
     без `Domain` (`node_modules/.pnpm/better-auth@1.7.6…/dist/cookies/index.mjs:23-35`). Своих настроек cookie в
     `packages/auth/src/auth.ts:125-129` нет. На сервере это не проверялось.
   - `__Secure-` не запрещает `Domain` — это делает только `__Host-` (MDN). `getSessionCookie` better-auth ещё и падает
     на имя без префикса (`index.mjs:266`).
   - Что держит сегодня:
     - всё содержимое агента на этих хостах — в CSP `sandbox` без `allow-same-origin`, у непрозрачного origin нет
       `document.cookie`;
     - сервер ставит только `raditi_page`, и только своему хосту;
     - `<meta http-equiv="set-cookie">` браузеры не исполняют примерно с 2018 года;
     - `POST` к tRPC проверяет `Origin` и `Sec-Fetch-Site` (`apps/web/src/server/trpc-origin.ts`);
     - заявка в Public Suffix List сейчас невозможна (план 69, §8).
   - **Пробел.** Ст3 обещал контракт «`Set-Cookie` с `Domain=raditi.ru` платформа не ставит нигде — контракт в
     `infra/app/ci.test.mjs`». В этом файле нет ни одной проверки cookie. README стенда страниц числит пункт
     непроверенным (`infra/dev/pages-verify/README.md:74`).
   - Для артефактов: не отдавать под `*.raditi.ru` ничего со скриптами и same-origin — `localStorage`, IndexedDB,
     WebSocket, `connect-src`, service worker. Живая правка — через кабинет и мост `postMessage`. Если нужен «живой»
     интерактив, нужен отдельный регистрируемый домен, как у предпросмотров с `raditi-preview.ru` (довод плана 67, §3).
3. **`SameSite=None` у `raditi_page`** (`apps/preview/src/pages/page-cookie.ts:11-14`). Её ввели потому, что страница в
   sandbox — непрозрачный origin: её запросы к своему же хосту межсайтовые, и `Lax` с ними не уходит (Дер35).
   - **Следствие 1** — остаточный риск плана 73, §12; вопрос владельцу открыт. Чужой сайт подключает
     `/_files/*.js` или `.css` закрытого сайта у зрителя, который уже ввёл пароль; скрипт исполняется у чужого сайта.
     Подпись `?k=` в адресах файлов не сделана. Инструкции хода: в общие файлы — только оформление
     (`apps/core/src/tasks/turn-instructions.ts:55-`).
   - **Следствие 2.** Safari по умолчанию блокирует cookie межсайтовых ресурсов (WebKit, 24.03.2020). Chrome при
     заблокированных cookie третьих сторон считает межсайтовыми и запросы sandbox-документа к своему сайту, поэтому
     ввёл токен `allow-same-site-none-cookies` (Chrome 135). Отсюда вероятное поведение: в Safari, а в Chrome — при
     заблокированных cookie третьих сторон и в режиме инкогнито, файлы закрытого сайта не грузятся. **Не
     подтверждено**: сценарий E стенда `verify:pages` идёт только в Chromium (`apps/preview/scripts/verify-pages.mjs:494,
     647, 754`), хотя Дер34 называет «Chromium и WebKit». Chrome по умолчанию cookie третьих сторон оставляет (Google,
     22.04.2025).
   - Для артефактов: внутри sandbox-фрейма не опираться на cookie совсем. Каждый подресурс — подписанный короткий
     адрес, как `/v/`, или встроенный `data:`.
4. **`srcdoc` в кабинете.** У CSP кабинета нет `script-src` и `connect-src`
   (`content-security-policy.ts:18-27`), а наследование CSP в sandbox-`srcdoc` в браузерах различается (не
   подтверждено). HTML агента со скриптами — только через `/v/` со своей CSP, `srcdoc` — только для HTML платформы без
   скриптов (как `readingPage`).
5. **Превью ≠ опубликованное.** В кадре кабинета `https:`-картинки, шрифты и медиа закрыты (`headers.ts:22-27`), у
   опубликованной страницы открыты (16-20). Дизайн с внешними картинками и шрифтами в артефакте будет выглядеть сломанным
   и при этом в странице — целым. Нужны встроенные `data:` или ассеты артефакта по подписанным адресам; узкую политику
   приватного артефакта не расширять (Ст9).
6. **`connect-src`, `frame-src`, `form-action`, `worker-src` — `'none'` в кадре.** Интерактив артефакта — только
   встроенный JS, без сети, вложенных фреймов и форм. Несколько досок раскладывает кабинет, у каждой свой фрейм. Мост
   выбора элемента доски для просьбы агенту — `postMessage` из фрейма: кабинет сверяет `event.source`, а сообщения
   считает данными, не командами — скрипт агента в том же фрейме может их подделать.
7. **Сигналы и поиск по ленте чата.** §12–§13: без канала артефакта несколько агентов не видят правок друг друга.
8. **Права.** Документы игнорируют ПР1 (`services/pages.ts:301-308` против `access.ts:11-19`). Проектный артефакт
   должен наследовать видимость проекта.
9. **Конкурентность.** У записи раздела нет `expectedRevision`; непроверенный раздел другого чата агенту не виден
   (`pages.ts:2435-2437`). Нужна проверка ревизии блока и понятный отказ «блок изменился, перечитайте».
10. **Проверка значений есть только внутри хода.** `core` держит значения переменных только у идущего хода.
    - Текст клиента — его собственный, проверять его не нужно.
    - Внешний MCP-клиент без хода проверить нечем.
    - Запись редактора из чужого пространства проверяется значениями **его** пространства.
11. **Размеры MCP.**
    - Пределы: тело запроса 100 КиБ, JSON ответа 64 КиБ, раздел 32 КиБ.
    - У `mcp` в production нет S3 (план 69, §3, п. 7), и `doc-render` ему недоступен (`.dependency-cruiser.cjs`,
      `mcp-minimal-packages`). Поэтому двоичные ассеты идут только через outbox в конце хода, а рисует только
      `core` или web.
    - Большой HTML правится патчами, не переотправкой целиком.
12. **Токены описаний.** Семейство `docs` объявляется каждому ходу. Второе семейство рядом удвоит цену, поэтому
    `doc_*` лучше заменить, а не дополнить.
13. **Выкладка.** Миграции идут при работающих старых сервисах: только аддитивно, удаление столбцов — двумя выпусками.
14. **Проход без надзора.** `docs` в нём доступен (`mcp-policy.ts:142-146`). Артефакт, которым поделились, без надзора
    менять, вероятно, нельзя — по образцу `pages_changes`.
15. **Рост хранения.** Предел 500 документов считает все; версий без предела, у каждой — полный Markdown до 512 КиБ.
16. **Снимок публикации.** `pages.document_id` unique (`schema.prisma:2429`): одна страница на артефакт, и она не
    обновляется сама.
17. **Токен `/v/`.** Пропуск на 5 минут с id пользователя в открытом виде; для приглашённых `u` — сам зритель. Адрес
    наружу не выдаётся.
18. **Значения переменных.**
    - Значения короче 8 байт и закодированные формы не ищутся.
    - Outbox проверяется значениями, выданными ходу.
    - `publishFile` повторно не проверяет: переменная, заведённая позже со значением из старого файла, не найдётся.
19. **Восстановленный ход.** У него живой проверки не было: конец хода проверяет его через `recoveredTextRefusal`,
    который отклоняет любой текст в форме ключа хода (`text-refusal.ts:29-35`).
20. **Очистка проекта.** По коду рабочего дерева чаты проекта при очистке остаются удалёнными
    (`apps/core/src/projects/project-trash.ts:52`). Его документы — сироты: считаются в пределе и читаются по id. Файл
    правится в параллельной ветке.

## 18. Вопросы владельцу (с предлагаемым значением по умолчанию)

1. Артефакт — обобщённый документ агента любого вида, страница — опубликованный снимок артефакта. По умолчанию — да.
2. «Поделиться» — ссылка только для вошедших пользователей Радити; без входа — только публикация страницей. По
   умолчанию — да.
3. Роли: просмотр, комментарий, правка. Ссылка даёт просмотр; правка — только явным приглашением пользователя.
4. Проектный артефакт виден как проект: автору проекта (ПР1) и приглашённым. По умолчанию — да.
5. Агент приглашённого редактора из другого пространства пишет в артефакт с правами автора своего чата; его текст
   проверяется значениями его пространства. По умолчанию — да.
6. Проход запланированной задачи без надзора не меняет артефакты, которыми поделились, — по образцу `pages_changes`. По
   умолчанию — да.
7. Вкладка «Документы» → «Артефакты»; пункт «Артефакты» в рейке рядом со «Страницами». По умолчанию — да.
8. Файлы `.html` и `.md` плана 67 остаются файлами, «Сделать артефактом» — по кнопке. По умолчанию — да.
9. Удаление артефакта — в корзину на 30 дней; предел 500 — без корзины. По умолчанию — да.
10. Версии: хранить все, без предела в первой версии, с алертом роста таблицы. По умолчанию — да.
11. Интерактивные HTML-артефакты — без сети и хранилища браузера (непрозрачный origin). Отдельный регистрируемый домен —
    только если понадобятся «живые приложения». По умолчанию — да.
12. Одно семейство `artifact_*` вместо `doc_*`. По умолчанию — да.
13. Отдельно от артефактов, но попутно найдено: дописать обещанный Ст3 контракт «нет `Set-Cookie` с
    `Domain=raditi.ru`» и прогнать сценарий E `verify:pages` в WebKit.

## Источники (внешние)

- Next.js 16.3.6, документация `headers` в пакете: `apps/web/node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/headers.md`, строка 43 — локальная копия документации установленной версии.
- Chromium, Intent to Prototype «Allow SameSite=None Cookies in First-Party Sandboxed Contexts», 21.10.2024: https://groups.google.com/a/chromium.org/g/blink-dev/c/PfTbJ2Qi1Jk
- Chromium, Intent to Ship того же, по поиску — 12.02.2025 (дата не проверена): https://groups.google.com/a/chromium.org/g/blink-dev/c/TO4in4jqGdI
- Privacy Sandbox, «New sandbox allow-same-site-none-cookies value from Chrome 135», по поиску — март 2025 (точная дата не проверена): https://privacysandbox.google.com/blog/sandbox-allow-same-site-none-cookies
- Google, «Next steps for Privacy Sandbox and tracking protections in Chrome», 22.04.2025 — cookie третьих сторон в Chrome остаются, инкогнито их блокирует: https://privacysandbox.google.com/blog/privacy-sandbox-next-steps
- WebKit, «Full Third-Party Cookie Blocking and More», 24.03.2020 — «Cookies for cross-site resources are now blocked by default across the board»: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- MDN, `Set-Cookie`, префиксы `__Secure-` и `__Host-` — `__Host-` запрещает `Domain`; страница изменена 01.09.2026: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie
- WebKit, changeset r239342 — `<meta http-equiv=set-cookie>` больше не поддерживается, 2018: https://trac.webkit.org/r239342
- Mozilla, bug 1457503 — то же в Firefox 68: https://bugzilla.mozilla.org/show_bug.cgi?id=1457503
- Наследование CSP в `srcdoc` с sandbox — источники расходятся, вывод не подтверждён: https://bugzilla.mozilla.org/show_bug.cgi?id=1803475 и https://lists.whatwg.org/pipermail/whatwg-whatwg.org/2012-June/078745.html
