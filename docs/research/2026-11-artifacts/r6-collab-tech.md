# Совместная правка артефакта человеком и несколькими агентами — технологии на 19.11.2026

*Исследование r6 к разделу «Артефакты». Только исследование: файлы репозитория не менялись. У каждого внешнего факта — ссылка и дата источника, когда она известна; «не подтверждено» — где первоисточник не найден. Описания инструментов Claude Code (`Artifact`, `ArtifactData`, `ArtifactComments`), навыка `artifact-capabilities` (контракт 0.2.47) и сервера MCP Claude Docs (`guide`: `topic.index`, `topic.editing`) прочитаны в этой сессии 19.11.2026 — это первоисточник Anthropic без публичного адреса; ниже он помечен «описание инструмента, 19.11.2026».*

## Коротко

- **Агенту нужна точечная правка с проверкой ревизии на сервере.** Все зрелые инструменты правки 2026 года адресуют стабильный id блока или цитату текста и отказывают, если объект изменился после чтения: Claude Docs (`ifHash` + `ifRev`, цели `find`), Tiptap Server AI Toolkit (`_hash` узла), Notion MCP (`old_str` — ровно одно вхождение), `ArtifactData` Claude Code (`if_version` обязателен), Google Docs API (`requiredRevisionId`), Canva MCP (транзакция правки), черновик расширения MCP Filesystems (`ifMatch` обязателен, `revisionMismatch`). Перепись целого документа ChatGPT canvas выбирает, только когда пользователь ничего не выделил (OpenAI, 03.10.2024).
- **CRDT решают другую задачу.** Yjs, Automerge и Loro сливают посимвольную печать людей и работают офлайн, но сервер в них пересылает непрозрачные обновления: проверить правку до того, как её увидят другие, трудно (WordPress sync: сервер «treats Yjs updates as opaque base64 strings» и «can't validate content»), готового обратного обновления нет (форум Yjs). Агента подключают к CRDT серверным клиентом (Hocuspocus `openDirectConnection`, Liveblocks `mutateStorage`), а id узлов и ревизии для инструментов строят поверх (Tiptap `_hash`, id блоков BlockNote).
- **Серверная власть с операциями над записями** — так устроены Notion, Figma, tldraw sync, ProseMirror collab, Replicache/Zero и Claude Docs: сервер применяет операцию на копии, проверяет права и связность, фиксирует, рассылает «версия выросла», клиенты дочитывают. Это ровно то, что уже есть в Радити: PostgreSQL, `NOTIFY` → `LISTEN` в `core` → Redis → SSE `task.signals` → дочитывание по курсору (план 86).
- **Предложение.** Артефакт — упорядоченное дерево блоков со стабильными короткими id; ревизия блока — номер последней операции артефакта, которая его тронула; запись в существующий блок несёт `ifRev` либо цитату, которая сама служит проверкой; короткая аренда блока с жетоном ограждения показывает «агент пишет здесь» ещё до вызова и даёт человеку приоритет; журнал операций в PostgreSQL — история, атрибуция и отмена своих правок; живой канал — существующие сигналы SSE, без нового сервиса WebSocket; правку агента видят после проверки `core` (секреты, ключи хода, значения переменных), как разделы документа с плана 74. Yjs — позже и только для текста внутри одного блока, если двое людей станут печатать в одном месте одновременно.
- **Показ.** HTML агента — только в непрозрачном источнике (`sandbox` без `allow-same-origin`, CSP `sandbox`, `connect-src 'none'`), как страницы Радити сейчас. Мост `postMessage` — с проверкой `event.source`, схемой сообщений и белым списком методов: HTML-превью ChatGPT дали увести данные через обработчик родителя с `innerHTML` (Parameter Labs, разбор Simon Willison 31.10.2026). Отдельный регистрируемый домен на Public Suffix List нужен, только если артефакту понадобится свой источник (хранилище, OAuth, service worker).
- **Шеринг.** Ссылка-возможность по W3C TAG: ≥128 бит из CSPRNG, в базе — только хеш, `Referrer-Policy: no-referrer`, `noindex`, срок, отзыв, перевыпуск, несколько ссылок на артефакт. Просмотр — по ссылке; комментарий и правка — только после входа, с ролью и атрибуцией; агент действует с правами того, кто его попросил (так Claude Docs).
- **Данные в России.** Облака Liveblocks, Tiptap Cloud, y-sweet/Jamsocket, PartyKit (Cloudflare) отпадают. Самохостинг под разрешительной лицензией: Yjs, y-websocket, Hocuspocus, Automerge, Loro, ShareDB, sharedb-postgres, ProseMirror, Lexical, Tiptap core (MIT), fractional-indexing (CC0), node-diff3 (MIT), diff-match-patch (Apache-2.0). Копилефт или платное: сервер Liveblocks (AGPL-3.0), y/hub (AGPL-3.0 или проприетарная), BlockNote xl-ai (GPL-3.0 или проприетарная), tldraw (своя лицензия: в продакшене — по ключу), Tiptap AI Toolkit и Collaboration on-prem (Enterprise).

---

## 0. Что уже есть в Радити и что поправить в перечне `2026-11-agent-features`

### 0.1 Основа в коде (прочитано в репозитории 19.11.2026)

| Что | Где | Что даёт артефактам |
|---|---|---|
| Документ по разделам: `doc_create` (скелет: заголовок, id и намерение каждого раздела), `doc_section_write` (раздел целиком по id, `after` — новый раздел), `doc_section_remove`, `doc_section_move`, `doc_read` (частями, `more`, `cut: true`), `doc_finish` | `apps/mcp/src/pages/mcp-docs.controller.ts`; таблицы `chat_documents` (`revision`, `current_version`; «документ принадлежит рабочему пространству, писать его может любой его чат») и `chat_document_sections` (`section_key`, `position`, `state` pending/written, `written_task_id`/`written_turn`, `checked_turn`, `refusal`) | Готовая блочная модель для текста. Ревизии раздела нет: два чата, пишущих один раздел, молча перезапишут друг друга |
| Живая проверка раздела в `core` раз в 1,5 с (`LIVE_DOC_CHECK_MS`) тем же сканером, что и конец хода; до проверки кабинет видит намерение и «Проверяем раздел…» | `DocSections.checkLive`, `TurnAttempt.liveRefusal`; план 74, Д2–Д3 | Правило показа правок агента (правило 2) |
| `page_edit`: замена по цитате «на версии, которую дал `page_read`», все правки страницы одним вызовом; «если кто-то изменил страницу — ничего не меняется» | `mcp-pages.controller.ts`, `packages/domain/src/pages/edit.ts` | CAS целого объекта |
| `MemoryEntry.version`: правка на другой версии — отказ `MEMORY_VERSION_CHANGED` | `packages/db/prisma/schema.prisma` | Тот же приём на строке |
| Сигналы: триггеры → `NOTIFY raditi_task '<id>:feed\|activity'` → одно соединение `LISTEN` в `core` (склейка 50 мс, переподключение 1–30 с) → Redis `raditi:task:<id>` → один подписчик Redis на процесс web → подписка tRPC `task.signals` по SSE (ping 15 с, права — при подключении и каждые 15 с) → чтение по курсору; «правильность от сигналов не зависит» | `apps/core/src/task-signals`, `apps/web/src/server/task-signals.ts`; план 86, §2 | Живой канал без нового сервиса |
| Страница агента: CSP `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox` без `allow-same-origin`, `default-src 'none'`, `connect-src 'none'`, `form-action 'none'`, `frame-src 'none'`, `worker-src 'none'`; `<slug>.pages.raditi.ru` — тот же сайт, что кабинет (Ст3); утечка через адрес картинки `https:` принята владельцем (Ст9); страница чата в кадре — `/v/<token>` на 5 минут | `packages/domain/src/pages/headers.ts`; планы 67, 69 | Показ HTML-артефакта |
| Обёртка драйвера OpenCode стоит между CLI и `sandbox-gw` и из дельт потока печатает черновик текста и мысли (`raditi_draft`, не чаще раза в 400 мс) | spec §20, РА5 | Технически можно показывать и аргументы вызова инструмента по мере генерации (не проверено) |
| WebSocket есть только у трансляции браузера (`apps/preview`, :8091) | CLAUDE.md, «Стек» | Сервиса документов по WebSocket нет |

### 0.2 Строки перечня: что подтвердилось и что устарело (проверено 19.11.2026)

| Строка | Что в перечне | Что нашлось |
|---|---|---|
| OR-76 | Артефакты у Claude Code и др.; у Радити «есть» | У Claude Code артефакт — опубликованная страница: приватна по умолчанию, каждая публикация — новая неизменяемая версия, есть комментарии, своя база, «возможности» (`artifact`, `assets`, `comments`, `db`, `downloads`, `mcp`, `room`, `sample`, `user`) и готовые типы (слайды, документ, дизайн, дизайн-система, дашборд, таблица) — описание инструмента `Artifact` и навыка `artifact-capabilities`, 19.11.2026. У Радити «есть» только просмотр; совместной правки нет |
| OR-84 | Галерея | Claude Code: `/artifacts` в терминале и галерея `claude.ai/code/artifacts` (описание инструмента `Artifact`) |
| OR-87 | Claude Docs — вкладки, графики | Правки людей и Claude «appear in real time», каждая правка подписана автором, Claude действует только с правами того, кто попросил; роли «читатель — комментатор — редактор» ([support.claude.com](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs), прочитано 19.11.2026) |
| OR-89 | У Радити текст раздела «появляется только в конце хода» | Устарело: с 14.11.2026 раздел виден через мгновение после записи, после живой проверки `core` (план 74, Д2) |
| OR-91, SF-133 | Claude Code: каждая публикация — версия; «Claude.ai: документы открываются только вошедшим и только на чтение» | Первое подтверждено. Второе для Claude Docs неверно: бесплатный план делится ссылкой «anyone who has the link», роли есть (support, 19.11.2026). Ссылки Claude Code `claude.ai/code/artifact/<uuid>` идут с `x-robots-tag: none`, публичные артефакты бесплатного плана `claude.ai/public/artifacts/<uuid>` — без него и индексируются ([Pluto Security](https://pluto.security/blog/inside-claude-artifacts-how-your-agent-publishes-to-the-web/), 06.08.2026, вторичный) |
| OR-96 | Виджет делит состояние с агентом | `db` страницы Claude Code: JSON-документы, last-writer-wins, `onSnapshot`, кооперативная аренда `acquire`; агент пишет туда через `ArtifactData` с `if_version` (навык, 19.11.2026). MCP Apps: `tools/call` из приложения, `ui/update-model-context` (§4) |
| OR-101, OR-108, OR-119 | Живые данные, вызов модели, хранилище | Подтверждено: `mcp` (коннекторы зрителя), `sample` (вопрос Claude, платит зритель), `db` с личным поддеревом `data/users/<id>` (навык, 19.11.2026) |
| OR-146 | Комментарии, ИИ отвечает | `ArtifactComments`: ответ только в тредах, которые человек «отправил Claude» (Send to Claude или @claude), ответ ≤ 4096 байт, `resolve`; комментарий на отслеживаемом артефакте будит сессию |
| OR-80 | MCP Apps у 10 клиентов | Расширение `io.modelcontextprotocol/ui` стабильно с 2026-01-26; хосты — §4 |
| IC-127 | Артефакт в сессию | Подтверждено: `Artifact read` + `ArtifactComments watch` |
| IM-03, IM-25 | Выбор элемента; упоминание артефакта | Для холста HTML нужен мост `postMessage` из кадра (§5, §8.8) |

---

## 1. Модели одновременной правки

### 1.1 Целый объект и оптимистичный CAS

**Как работает.** У объекта одна версия (число или непрозрачная строка, как сильный ETag). Запись передаёт версию, на которой читали; сервер сравнивает и пишет одним атомарным шагом (`UPDATE … WHERE version = $v`), иначе отказ с текущей версией. В HTTP это `If-Match` → `412 Precondition Failed` ([RFC 9110 §13.1.1](https://www.rfc-editor.org/rfc/rfc9110#name-if-match)). Черновик рабочей группы MCP Filesystems (журнал решений 2026-10-09): `revision` сравнивается «byte-for-byte like a strong HTTP ETag», `ifMatch` обязателен на `update` и `delete` («a lost update cannot happen by omission»), отказ `revisionMismatch` с `currentRevision`, «The server MUST compare the revision and apply the write as one atomic step» ([experimental-ext-filesystems](https://github.com/modelcontextprotocol/experimental-ext-filesystems/blob/main/docs/proposals/resource-operations.md)).

**Где применено.** Claude Code: публикация поверх чужой новой версии отклоняется и отдаёт живую версию; Claude перечитывает, сливает и публикует снова; `force` выбрасывает чужую версию «только когда человек явно сказал» (описание инструмента `Artifact`, 19.11.2026). Страница с возможностью `artifact` публикует себя целиком; одновременное сохранение получает `conflict`, все открытые виды перезагружаются к победителю, «no retry» (навык, контракт 0.2.47). `ArtifactData`: `if_version` обязателен на каждую запись в существующий документ, «a pinned write fails, writes nothing and names the current version». Радити: `page_edit`, `MemoryEntry.version`.

| Свойство | Оценка |
|---|---|
| Серверу Радити | Тривиально: Nest + PostgreSQL; Redis и SSE — только для сигнала «версия выросла» |
| Хранение в PostgreSQL | Строка с `version` и история версий (как `chat_document_versions`) |
| Размер | Весь объект в каждой записи. Агенту дорого: перепись HTML-страницы — это токены за всю страницу |
| Отмена по участнику | Только откат всего объекта к версии |
| Присутствие, офлайн | Нет |
| Агенту | Отлично при одном писателе (цитата `old`/`new` поверх версии — дешёвый патч). При нескольких писателях любой чужой символ где угодно рвёт запись → цикл «перечитать — повторить» |
| Проверка операции | Полная: сервер видит весь результат |
| «Агент пишет здесь» | Только «агент пишет этот объект» |

### 1.2 Операции над блоками, ревизия блока, короткая аренда

**Как работает.** Объект — упорядоченное дерево блоков со стабильными id. У блока своя ревизия и/или хеш содержимого. Операция адресует блок (`replace`, `insert after`, `move`, `delete`, `set props`) и несёт ожидаемую ревизию; правки разных блоков не конфликтуют. Внутри блока — замена по цитате без отдельной проверки: цитата, найденная ровно один раз, сама и есть проверка. Порядок детей — дробные индексы, как у Figma («a fraction between 0 and 1 exclusive», родитель и позиция — одно свойство, меняются атомарно) ([Figma, 16.10.2019](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)). Аренда — запись «держатель, до, жетон» на блоке; запись проходит, только если аренда своя или истекла. Аренда без жетона небезопасна: процесс может замереть (сборка мусора), аренда истечёт, другой запишет, а замерший очнётся и тоже запишет; жетон — растущее число, и хранилище отвергает запись с меньшим жетоном ([Kleppmann, 08.02.2016](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)).

**Где применено.**
- **Notion** ([18.05.2021](https://www.notion.com/blog/data-model-behind-notion)): блок — UUID, `properties`, `type`, `content` (упорядоченные id детей), `parent` (только для прав). «operations are batched into transactions that are committed (or rejected) by the server as a group»; клиент применяет транзакцию у себя сразу и держит её в `TransactionQueue`; сервер на `/saveTransactions` грузит «до», применяет операции на копии, проверяет права и связность, фиксирует. Каждый клиент держит WebSocket к MessageStore, подписан на записи, которые рисует; узнав новую версию, дочитывает `syncRecordValues`. С 11.12.2025 страницы, отмеченные для офлайна, переводятся на «new CRDT data model» — алгоритм не назван ([Notion](https://www.notion.com/blog/how-we-made-notion-available-offline)).
- **Claude Docs** (описание инструмента MCP, 19.11.2026): id блока `<session>.<clock>`, у каждого блока в чтении `h` (8 hex); `replace`/`delete` целого блока требует `ifHash` и `ifRev` (ревизию того чтения), без них — `missing_guard`; цели `find` по цитате (`nth` при повторе) проверки не требуют — не нашлось → `find_none`; `guard_mismatch` = «their edit wins … never resend with force»; дельты `sinceRev` (неизменённое сворачивается в `<gap/>`, удалённое — `<gone/>`), история `atRev`, `restore` всей вкладки «only when nothing else changed since»; `opId` у пакета; режим предложений `<ins>`/`<del>`.
- **Google Docs API** ([batchUpdate](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate)): пакет атомарен («If any request is not valid, then the entire request will fail»); `requiredRevisionId` — 400, если документ изменился; `targetRevisionId` — правки применяются «against the collaborator changes» (сервер трансформирует, клиент — «another collaborator»); ревизия годна «for several minutes after it's read». Индексы — в кодовых единицах UTF-16 ([structure](https://developers.google.com/workspace/docs/api/concepts/structure)).
- **Canva MCP**: транзакция `start-editing-transaction` → `perform-editing-operations` → `commit-editing-transaction` (или `cancel`); id элементов дают только из `start`; «Edits stay in draft until commit»; «Concurrent browser edits can stale the transaction» — тогда cancel, новый start, повторить, commit ([verify](https://www.canva.dev/docs/mcp/verify-integration/), [tools](https://www.canva.dev/docs/mcp/tools/)).
- **Figma**: последний записавший побеждает по свойству объекта; клиент отбрасывает входящие значения свойств, которые он сам изменил и сервер ещё не подтвердил; сервер отвергает смену родителя с циклом.
- **Claude Code `db`** (навык, 0.2.47): last-writer-wins без транзакций, `acquire({holder, ttlMs})` — кооперативная аренда «set-if-not-busy», по умолчанию 30 000 мс, ограничена 1 000–600 000 мс, «NOT a security boundary»; документ ≤ 256 КиБ, ≤ 5 000 документов на артефакт.

| Свойство | Оценка |
|---|---|
| Серверу Радити | Транзакция PostgreSQL на вызов; Redis — для присутствия и сигналов; SSE хватает: сигнал + дочитывание изменённых блоков по `sinceVersion` |
| Хранение в PostgreSQL | Таблица блоков (текущее состояние), журнал операций (история, атрибуция, отмена), снимки именованных версий |
| Размер | Запись — один блок; чтение порциями (Tiptap — 32 000 знаков на вызов, Figma MCP — 48 000 байт, Notion MCP — ≈20 000 записей на страницу) |
| Отмена по участнику | Обратная операция по образу «до», если блок не менялся после; иначе — показ разницы. Так `restore` у Claude Docs |
| Присутствие | Аренда = «кто пишет какой блок»; курсоры и «кто смотрит» — эфемерно (Redis с TTL) |
| Офлайн | Нет. Можно копить операции с `ifRev` и разбирать конфликты при возврате |
| Агенту | Лучшее из найденного: короткие id, явная проверка, при конфликте перечитывается один блок; «одна секция за вызов» совпадает с тем, что вызов MCP приходит одним куском («a call streams nothing», Claude Docs) |
| Проверка операции | Каждая: схема, права, размер, сканер секретов — до показа другим |
| «Агент пишет здесь» | Аренда с намерением, взятая до длинного вызова; pending-блок с намерением (Claude Docs, `doc_create` Радити) |
| Слабость | Двое людей в одном блоке: второй ждёт или забирает аренду; посимвольного слияния нет, его можно добавить трёхсторонним слиянием текста блока (node-diff3, MIT; diff-match-patch, Apache-2.0) |

### 1.3 CRDT: Yjs, Automerge, Loro; агент как серверный клиент

**Yjs** (13.6.33, MIT). Документ — набор общих типов; правки — бинарные обновления, сливаются в любом порядке; сервер не обязателен. Транспорт: y-websocket (3.1.0, MIT); **Hocuspocus** 4 (стабилен с 08.05.2026, 4.8.0, MIT, Node 22+, Bun, Deno, Cloudflare Workers через crossws; хуки `onAuthenticate`, `onChange`, `onStoreDocument`, `beforeHandleMessage`; с 4.0 «Store hooks fire on every document change, not just WebSocket-originated ones») ([Tiptap](https://tiptap.dev/blog/release-notes/hocuspocus-4-stable-release)). Серверный писатель: `openDirectConnection(documentName, context)` → `transact(fn)` с происхождением `{source: "local", context}` (исходник `@hocuspocus/server@4.8.0`, `Hocuspocus.ts`, `DirectConnection.ts`). Присутствие — awareness, запись устаревает через 30 000 мс (`outdatedTimeout`, y-protocols). Отмена — `Y.UndoManager`: отслеживает транзакции из `trackedOrigins`, склеивает правки в окне `captureTimeout` 500 мс ([docs.yjs.dev](https://docs.yjs.dev/api/undo-manager)); своя отмена агента — свой UndoManager на происхождение агента. `gc = false` нужен, чтобы восстанавливать старое содержимое ([Y.Doc](https://docs.yjs.dev/api/y.doc)). Yjs 14 (`@y/y`) — только кандидаты (`14.0.0-rc.*`) с версиями, атрибуцией и «blame»; **y/hub** (0.11.0, AGPL-3.0 или проприетарная, «beta software»): комнаты — потоки Redis, слитое состояние — в S3, метаданные — в PostgreSQL, сервер не держит Y.Doc в памяти ([README](https://cdn.jsdelivr.net/npm/@y/hub@0.3.0/README.md)). Транспорт без WebSocket: y-sse (0.2.1, MIT, экспериментальный), `@durable-streams/y-durable-streams` (0.2.9, Apache-2.0; SSE или long polling, клиент шлёт сырые байты обновлений POST), WordPress `@wordpress/sync` (GPL-2.0-or-later): один `POST /wp-sync/v1/updates`, опрос раз в 1 000 мс в одиночку и 250 мс при соавторах, обновления хранятся в post meta, при > 50 обновлениях сервер просит клиента прислать сжатие ([README 1.44.0](https://cdn.jsdelivr.net/npm/@wordpress/sync@1.44.0/src/providers/http-polling/README.md)).

**Automerge** (3.5.0, MIT). 3.0 (июль 2025): память меньше «by over 10x»; Moby Dick в документе — 700 МБ в 2.x против 1,3 МБ в 3.0 ([automerge.org](https://automerge.org/blog/automerge-3/)). automerge-repo 2.x и `@automerge/automerge-repo-sync-server` 0.3.0 (MIT, 30.09.2026). Официального адаптера хранения PostgreSQL не нашёл (не подтверждено). Встроенная отмена в анонсе 3.0 не упомянута (не подтверждено). Предостережение: Cinapse ушла с Automerge на серверную модель — потолок памяти WASM 4 ГБ, «around $1,000/month on Automerge sync servers» для клиентов с большими файлами, посимвольная точность не нужна; после перехода — минус 89 % обращений в поддержку и минус 66 % расходов на хостинг ([PowerSync, 02.10.2025](https://www.powersync.com/blog/why-cinapse-moved-away-from-crdts-for-sync)).

**Loro** (1.18.0, MIT). Текст на алгоритме Eg-walker (Gentle, Kleppmann, EuroSys 2025: на порядок меньше памяти, чем у CRDT, загрузка «orders of magnitude faster», слияние долгих веток на порядки быстрее OT — [arXiv 2409.14252](https://arxiv.org/abs/2409.14252)); `UndoManager` — локальная отмена своих правок, курсоры сдвигаются при чужих ([loro.dev](https://www.loro.dev/docs/advanced/undo)); `EphemeralStore` для присутствия, по умолчанию 30 000 мс; «shallow snapshot» обрезает историю, если все стороны дошли до версии среза ([loro.dev](https://loro.dev/docs/advanced/shallow_snapshot)). Готового сервера синхронизации у Loro не нашёл (не подтверждено).

| Свойство | Оценка |
|---|---|
| Серверу Радити | Новый сервис документов по WebSocket (Hocuspocus) или экспериментальный HTTP-транспорт; рост памяти процесса с числом открытых документов |
| Хранение в PostgreSQL | `bytea` с обновлениями/снимком на документ (у Hocuspocus — расширение Database: `fetch` и `store`); SQL по содержимому невозможен без зеркала |
| Размер | Растёт история и надгробия; лечится сжатием или срезом (Loro), но тогда отмена и история укорачиваются |
| Отмена по участнику | Есть (UndoManager по происхождению) |
| Присутствие, офлайн | Есть, есть |
| Агенту | Только серверным клиентом. Агент мыслит текстом и цитатами, а CRDT молча сливает: два агента, переписавшие один абзац, оставят обе вставки; отказа «перечитай» нет. Id для инструментов — надстройка (Tiptap `_hash`) |
| Проверка операции | Сервер получает непрозрачные обновления; «validate it on the server anyway», read-only — фильтром сообщений, а готового обратного обновления нет ([форум Yjs](https://discuss.yjs.dev/t/validation-security-and-middleware/2229), [inverse update](https://discuss.yjs.dev/t/generate-an-inverse-update/2765)). Правку агента проверить можно до `transact`, человека — только постфактум |
| «Агент пишет здесь» | Awareness серверного клиента (Liveblocks `setPresence`, курсор агента BlockNote) |

### 1.4 OT: Google Docs, ShareDB, «центральная власть» ProseMirror

**Как работает.** Клиент сразу применяет свою правку; сервер упорядочивает правки; клиент трансформирует свои неподтверждённые против пришедших — в примере Google сдвинул ожидающую правку на 5 позиций ([Google Drive Blog, 23.09.2010](https://drive.googleblog.com/2010/09/whats-different-about-new-google-docs.html); тело поста прочитано по выдаче поиска). **ShareDB** (8.0.0, MIT): JSON и текст через типы OT (json0; ot-json1 1.0.2 — ISC; rich-text 4.1.0 — MIT; лицензию json0 не проверял), хранилище PostgreSQL — `sharedb-postgres` (6.0.2, MIT, 12.11.2026); middleware `submit`, `apply`, `commit` выполняются до записи ([ShareDB](https://share.github.io/sharedb/middleware/actions)); как отказать операции в них, на странице не описано (не подтверждено). **ProseMirror collab** (MIT; с 01.04.2026 разработка — Forgejo `code.haverbeke.berlin`, репозитории GitHub в архиве): власть принимает шаги, только если версия клиента равна числу принятых шагов; отвергнутый клиент получает чужие шаги, перебазирует свои (`receiveTransaction`) и шлёт снова (`sendableSteps`) ([guide](https://prosemirror.net/docs/guide/#collab)); история `prosemirror-history` локальна и перебазируется поверх удалённых шагов, `newGroupDelay` — 500 мс (исходник `history.ts`).

| Свойство | Оценка |
|---|---|
| Серверу Радити | Один упорядочивающий процесс на документ или блокировка строки в PostgreSQL; POST + SSE подходят |
| Хранение | Журнал шагов + снимок |
| Агенту | Сам OT-операции с индексами не породит (Google — индексы UTF-16); нужен слой «замени цитату X на Y» → шаги на текущей версии. Тогда это 1.2 с другим ядром |
| Проверка операции | Полная: шаги применяются к схеме (ProseMirror schema) |
| Офлайн | Ограниченно: долгие ветки в OT сливаются дорого (Eg-walker) |
| Отмена по участнику | Есть (локальная история с перебазированием) |

### 1.5 Журнал операций и «server reconciliation»

**Как работает.** Сервер хранит упорядоченный журнал (`seq`); состояние — свёртка журнала. Matthew Weidner (21.05.2025): у каждого знака глобально уникальный id, клиент шлёт «insert after id»; сервер применяет «literally, in the order it receives them», надгробия хранит; клиент откатывает свои ожидающие операции, применяет пришедшую и повторяет свои. Сервер волен игнорировать операцию, пометить вставку удалённой, отправить на проверку или превратить правку в предложение ([mattweidner.com](https://mattweidner.com/2025/05/21/text-without-crdts.html)). Так же устроены мутаторы Zero (Rocicorp, Apache-2.0): клиент выполняет мутатор оптимистично, сервер — авторитетно в транзакции PostgreSQL; «the server mutator always takes precedence», отвергнутое откатывается ([Zero](https://zero.rocicorp.dev/docs/custom-mutators); цитата — по выдаче поиска, при чтении 19.11.2026 страница отдала 404). У tldraw sync сервер тоже авторитетен: один `TLSocketRoom` на комнату хранит «the authoritative copy», проверяет записи по схеме, `SQLiteSyncStorage` — «recommended approach for production» ([tldraw](https://tldraw.dev/docs/sync)).

Для Радити это не отдельный путь, а хранение операций модели 1.2: журнал даёт историю, атрибуцию, дельты `sinceVersion` и отмену.

---

## 2. Что делают продукты для ИИ и людей

| Продукт | Модель | Как работает агент | Лицензия и самохостинг | Для Радити |
|---|---|---|---|---|
| **Liveblocks Sync** (бывш. Storage; пост от 1 сентября, год 2026 — по выдаче поиска; LiveText — «alternative to the popular Yjs library») | CRDT-подобное хранилище с сервером-источником истины; Yjs рядом | Бэкенд вызывает `setPresence` (имя, аватар, данные, TTL) и `mutateStorage`; JSON Patch `PATCH /v2/rooms/{roomId}/storage/json-patch`; Feeds — журнал активности агента («Thinking…», «Writing…») ([Sync](https://liveblocks.io/blog/introducing-liveblocks-sync-the-sync-engine-for-the-agentic-web), [Feeds](https://liveblocks.io/blog/introducing-feeds-and-apis-for-agent-workflows)). Engine 2: сообщение WebSocket до 32 МБ вместо 1 МБ ([февраль 2026](https://liveblocks.io/blog/whats-new-in-liveblocks-february-2026)) | Сервер открыт в феврале 2026 под AGPL-3.0, клиенты — Apache-2.0 (3.25.1); dev-сервер — SQLite на комнату, «not every endpoint is implemented yet», продакшн-самохостинг не описан ([open source](https://liveblocks.io/blog/open-sourcing-the-liveblocks-sync-engine-and-dev-server.md)) | Облако — нельзя (зарубежный SaaS). Приёмы — взять: присутствие агента с TTL, журнал активности, JSON Patch с `test` ([RFC 6902 §4.6](https://www.rfc-editor.org/rfc/rfc6902#section-4.6)) как предусловие |
| **Tiptap** 3.34 + Hocuspocus 4.8 | Yjs | Server AI Toolkit: `tiptapRead` (с `from` — индекса верхнего узла, `chunkSize` по умолчанию 32 000 знаков), `tiptapEdit` (операции `replace`/`insertBefore`/`insertAfter`, цель — `_hash` узла или `"doc"`, пустой фрагмент = удаление, результат по каждой операции), `editThreads`, `tiptapQuery` (1–50 операций), доска (`readBoard`, `createShapes`, alpha); `409 concurrent_edit_conflict` — документ изменился во время выполнения ([tools](https://tiptap.dev/docs/content-ai/capabilities/server-ai-toolkit/api-reference/tools)); формат Shorthand «reduces AI token costs by up to 80%»; правки сервера — tracked changes (экспериментально), Track Changes «in development» ([Q1 2026](https://tiptap.dev/blog/release-notes/recap-q1-2026)) | Редактор, `@tiptap/extension-collaboration` и Hocuspocus — MIT: совместная правка работает без облака Tiptap. Server AI Toolkit — hosted REST или on-prem, пилот для Enterprise/Business; комментарии и история документов Tiptap — в Tiptap Platform или Enterprise on-prem (по выдаче поиска, первоисточник не прочитан: [обсуждение](https://github.com/ueberdosis/tiptap/discussions/7321), [pricing](https://tiptap.dev/pricing)) | Платные части — нет. Взять: адресацию узлов хешем, чтение кусками, результат по операции |
| **BlockNote** 0.57 | Yjs | ИИ: отдельные инструменты добавить/изменить/удалить блок, применение во время потока (`withDelays`), курсор агента `agentCursor` `{name: "AI", color}`, `acceptChanges`/`rejectChanges` ([reference](https://www.blocknotejs.org/docs/features/ai/reference)); ForkYDoc и Suggestions на Yjs 14 — черновик PR #2739 | core — MPL-2.0, `@blocknote/xl-ai` — «GPL-3.0 OR PROPRIETARY» (package.json) | ИИ-пакет — нет (копилефт). Взять: курсор агента, принять/отклонить |
| **Lexical** 0.53 (`meta/lexical`, MIT) | Yjs через `@lexical/yjs` (не проверено в этой работе) | Серверного ИИ-набора уровня Tiptap не нашёл | MIT | Нейтрально |
| **ProseMirror** (MIT) | Центральная власть, шаги и версия | — | MIT; y-prosemirror 1.3.7, `@y/prosemirror` 2.0.0-0 | Ядро редактора кабинета при желании |
| **tldraw** 5.6.1 | Сервер авторитетен | Агент получает скриншот видимой области, упрощённые фигуры, сводки кластеров вне вида, выделение и недавние действия; действия — типизированные схемы, «validates, sanitizes, and applies»; санитайзинг чинит несуществующие и повторные id, нормализует координаты; результат идёт на холст потоком ([tldraw AI](https://tldraw.dev/docs/ai)); где выполняется агент — не сказано | Своя лицензия: без ключа — «Not to use the Software in Production Environments» (LICENSE.md) | Нет (лицензия). Взять: «скриншот + структура», санитайзинг id |
| **Figma** | Сервер — власть, LWW по свойству, дробные индексы | MCP `use_figma`: «run code in your Figma file through the Figma Plugin API», ответ ≤ 48 000 байт UTF-8, бета, бесплатно до конца беты ([write to canvas](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas)) | — | Модель свойств кадра холста — взять; «код как правка» — нет |
| **Notion** | Транзакции операций, сервер проверяет «до/после»; офлайн-страницы — CRDT (12.2025) | MCP `notion-update-page` `update_content`: пары `old_str`/`new_str`, «exactly one location, unless `replace_all_matches: true`», несовпавшие — в `warnings` (`no_match`, `indentation_mismatch`), ни одного совпадения — ошибка без изменений; ≈20 000 записей, незагруженное — `<unknown>`; `allow_async` + `notion-get-async-task` ([reference](https://developers.notion.com/guides/mcp/tools-pages-reference.md)); проверки версии не описано | — | Взять: замену по цитате и частичные предупреждения |
| **Google Docs** | OT (2010) | API batchUpdate + WriteControl; MCP `docsmcp.googleapis.com/mcp/v1` — `read_doc`, `update_doc`, Developer Preview, схемы на странице не опубликованы ([MCP reference](https://developers.google.com/workspace/docs/api/reference/mcp)) | — | Взять: атомарный пакет, два режима проверки ревизии |
| **Microsoft Fluid / Loop** | Полный порядок от сервиса, SharedTree | `@fluidframework/tree-agent` (alpha): агент генерирует строку JavaScript против API дерева (`AsynchronousEditor`, `SynchronousEditor`) ([tree-agent](https://fluidframework.com/docs/api/tree-agent/)); `ai-collab` (alpha): ветка SharedTree и слияние; PR #26655 (05.03.2026, черновик): ошибка правки LLM в под-ветке портила родительскую | fluid-framework 3.13.0, MIT; Routerlicious «not formally supported as a production-quality service» ([service options](https://fluidframework.com/docs/deployment/service-options)); Loop и Copilot Pages на Fluid | Нет (нет продакшн-сервера без Azure) |
| **Claude Docs** | Живая совместная правка людей и Claude; атрибуция | MCP: `batch`/`update`/`read`; блоки с id, `ifHash`+`ifRev`, `find`, pending-блоки с намерением, `sinceRev`, `atRev`, `restore`, `opId`, предложения, комментарии с якорем-цитатой (описание инструмента, 19.11.2026) | Продукт Anthropic | Образец инструментов (§3) |
| **Claude Code: артефакты** | Страница — CAS целиком; `db` — LWW + аренда; агент — `if_version` | `Artifact publish` (конфликт → перечитать, слить, опубликовать; `force`), `ArtifactData` (`str_replace` в поле, `batch` ≤ 50 записей и ≤ 1 МиБ, всё или ничего), `ArtifactComments`; `room` — эфемерное присутствие, `kind: "agent"` у публикующей сессии; хостинг `<uuid>.frame.claudeusercontent.com`; серверной проверки секретов нет: в тесте 10 из 85 попыток агент выложил содержимое `.env.local` в скрытом `<script>` (Pluto Security, 06.08.2026, вторичный) | Продукт Anthropic | Взять: CAS для агента, аренду, комментарии «отправить агенту». Не повторять: публикацию без серверной проверки |
| **WordPress sync** | Yjs поверх HTTP-опроса | — | GPL-2.0-or-later | Доказывает, что CRDT живёт без WebSocket, и что сервер-ретранслятор содержимое не проверяет |

Общий вывод раздела: продукты, где ИИ правит вместе с людьми, либо держат сервер властью и дают агенту id с проверкой (Notion, Claude Docs, Figma, Canva, Google API), либо ставят агента серверным клиентом CRDT и строят id поверх (Tiptap, Liveblocks, BlockNote). Второе требует сервиса документов по WebSocket и платных или копилефтных частей; первое ложится на то, что у Радити уже работает.

---

## 3. Инструменты агента для правки документов

| Инструмент | Операции | Цель | Проверка версии | Идемпотентность | Размер ответа |
|---|---|---|---|---|---|
| Claude `text_editor_20250728` (`str_replace_based_edit_tool`) | `view` (`view_range`, номера строк), `create`, `str_replace`, `insert` (после строки, 0 — начало); `undo_edit` в текущей версии нет | Путь + точная цитата / номер строки | Нет; уникальность `old_str` — «Replace exactly one occurrence; error if 0 or >1 matches» | Нет | `max_characters` для `view` ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool.md)) |
| OpenAI `apply_patch` | `create_file` (V4A — весь файл), `update_file` (V4A diff), `delete_file` | Путь + контекстные строки | Нет; сбой — `status: "failed"` и `output` («Patch conflict», «Invalid Context»), модель перечитывает | «all-or-nothing» или по файлу — решает хост | — ([guide](https://developers.openai.com/api/docs/guides/tools-apply-patch.md)) |
| Aider | `whole`, `diff` (SEARCH/REPLACE), `diff-fenced` (для Gemini), `udiff` (против «lazy coding» GPT-4 Turbo), `editor-diff`/`editor-whole` (режим architect) | Путь + цитата | Нет | Нет | — ([edit formats](https://aider.chat/docs/more/edit-formats.html)) |
| Notion MCP | `update_content`, `replace_content`, `update_properties` | Цитата `old_str` | Нет | Нет | ≈20 000 записей |
| Google Docs API | `insertText`, `deleteContentRange` … в `batchUpdate` | Индекс UTF-16 | `requiredRevisionId` / `targetRevisionId` | — | — |
| Canva MCP | `replace_text`, `find_and_replace_text` в транзакции | `element_id` из `start` | Транзакция «протухает» от правки в браузере | — | 20/50/20/20 запросов в минуту на start/perform/commit/cancel |
| Figma MCP `use_figma` | Код Plugin API | Узлы файла | Нет | Нет | 48 000 байт |
| Tiptap Server AI Toolkit | `replace`, `insertBefore`, `insertAfter` | `_hash` узла | Неявно (хеш меняется); `409` при изменении во время выполнения | — | 32 000 знаков на чтение |
| Claude Docs MCP | `replace`, `insert`, `delete`, `move`, `set`, `join`, `wrap`, `restore`, строки и столбцы таблиц | id блока или `find` по цитате | `ifHash` + `ifRev`, без них — отказ | `opId` | Чтение `outline` → `view parentId` → `search`; частичное чтение с `next` |
| `ArtifactData` (Claude Code) | `set`, `update`, `str_replace` в строковом поле, `delete`, `batch` | Путь документа + поле | `if_version` обязателен для существующего | `opId` нет; повтор с прежним `if_version` отклоняется — двойной записи нет | Документ ≤ 256 КиБ, `batch` ≤ 1 МиБ |
| Liveblocks REST | JSON Patch | Путь JSON | Через `test` | — | — |
| Радити сейчас | `doc_section_write` целиком, `page_edit` по цитатам | id раздела / цитата | `page_edit` — на версии `page_read`; разделы — нет | Нет | `doc_read` частями с `more` |

**Выводы для проектирования:**

1. **Адресация** — короткий стабильный id блока или цитата. Индексы (UTF-16 у Google) и номера строк ломаются от любой чужой правки и для HTML бессмысленны.
2. **Проверка по умолчанию обязательна**: пропуск — отказ, а не «запись на авось» (`ArtifactData`, `ifMatch` MCP Filesystems, `missing_guard` Claude Docs).
3. **Отказ лечится одним блоком**: ответ несёт текущую ревизию и короткий фрагмент, агент перечитывает только этот блок.
4. **Пакет атомарен** (Google `batchUpdate`, `ArtifactData batch`): агенту проще «всё или ничего», чем частичный успех с предупреждениями (Notion).
5. **Идемпотентность** — `opId` от агента (Claude Docs); повтор после таймаута не удваивает правку.
6. **Малые ответы**: чтение по порциям (32 000 знаков; 48 000 байт), «оглавление → блок → поиск».
7. **Вызов не стримится**: длинную запись предваряет дешёвый плейсхолдер — pending-блок или аренда с намерением.
8. **Человек побеждает агента**: «their edit wins … never resend with force» (Claude Docs).
9. **Код как правка** (Figma `use_figma`, Fluid `tree-agent`) мощен, но операцию нельзя проверить до выполнения и показать по частям — не для Радити.
10. **Полная перепись — исключение**: ChatGPT canvas обучен «targeted edits when users explicitly select text … otherwise favoring rewrites»; точечные правки модели canvas лучше базовой GPT-4o на 18 % ([OpenAI, 03.10.2024](https://openai.com/index/introducing-canvas/), по выдаче поиска: страница отвечает 403).

---

## 4. MCP: факты протокола для артефактов

**2025-06-18** ([changelog](https://modelcontextprotocol.io/specification/2025-06-18/changelog)): убран пакетный JSON-RPC; структурный вывод инструментов; elicitation; **ссылки на ресурсы в результатах инструментов** (`resource_link`); заголовок `MCP-Protocol-Version`; поле `title`; `_meta`.

**2025-11-25** ([changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)): иконки; elicitation в режиме URL; инструменты в sampling; Client ID Metadata Documents; экспериментальные tasks; JSON Schema 2020-12 по умолчанию; ошибки проверки входа — ошибки выполнения инструмента (`isError: true`), «to enable model self-correction» (SEP-1303).
- **Ресурсы**: `resources/subscribe` → `notifications/resources/updated` с одним `uri` («might be a sub-resource of the one that the client actually subscribed to»), клиент перечитывает (schema 2025-11-25). `resource_link` в результате инструмента — URI, который клиент «can be subscribed to or fetched», и он «not guaranteed to appear in the results of a `resources/list`»; есть встроенные ресурсы и аннотации `audience`, `priority`, `lastModified` ([tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)).
- **Аннотации инструментов**: `readOnlyHint` (по умолчанию false), `destructiveHint` (true; смысл — только при `readOnlyHint == false`), `idempotentHint` (false), `openWorldHint` (true). Это «hints … Clients should never make tool use decisions based on ToolAnnotations received from untrusted servers».

**2026-07-28** ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)): протокол без состояния — нет `initialize` и `Mcp-Session-Id`; состояние между вызовами — «explicit, server-minted handles passed as ordinary tool arguments» (для артефакта это id и ревизия в аргументах); `server/discover`; **`subscriptions/listen`** — один долгий поток вместо HTTP GET и `resources/subscribe`, клиент подписывается на `resourceSubscriptions` и другие виды; убраны `ping`, `logging/setLevel`; tasks — расширение (`tasks/get`, `tasks/update`); Multi Round-Trip Requests (`InputRequiredResult`) вместо серверных запросов elicitation и sampling; `resultType` в каждом результате; нет возобновления SSE (`Last-Event-ID`); `CacheableResult` (`ttlMs`, `cacheScope`); ресурс не найден — `-32602`; заголовки `Mcp-Method`, `Mcp-Name`; Roots, Sampling, Logging — устаревшие.

**MCP Apps** — официальное расширение `io.modelcontextprotocol/ui`, стабильно с 2026-01-26 ([спецификация](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), [обзор](https://modelcontextprotocol.io/extensions/overview)): инструмент указывает `_meta.ui.resourceUri` на ресурс `ui://` с MIME `text/html;profile=mcp-app`, хост может загрузить его заранее; `_meta.ui.csp` (`connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`) и `permissions` (камера, микрофон, запись в буфер); без `csp` хост обязан ставить `default-src 'none'; script-src 'self' 'unsafe-inline'; … connect-src 'none'` и «MUST NOT allow undeclared domains». Веб-хост обязан завернуть вид в «Sandbox proxy»: «The Host and the Sandbox MUST have different origins», у песочницы `allow-scripts` и `allow-same-origin`, вид грузится во внутренний кадр с CSP. Связь — JSON-RPC через `postMessage`: `ui/initialize`, `tools/call` (видимость `["model","app"]` по умолчанию; `["app"]` — инструмент только для приложения, хост не показывает его модели), `ui/message`, `ui/update-model-context`, `ui/notifications/tool-input-partial` (аргументы по мере генерации), режимы показа, `size-changed`. Домены песочниц хостов — например `{hash}.claudemcpcontent.com`, `www-example-com.oaiusercontent.com`. Хосты по [modelcontextprotocol.io](https://modelcontextprotocol.io/extensions/apps/overview.md) (19.11.2026): Claude, Claude Desktop, VS Code GitHub Copilot, Microsoft 365 Copilot, Goose, Postman, MCPJam, Archestra.AI; Apps SDK ChatGPT (ноябрь 2025) спецификация называет предшественником; в перечне репозитория MCP Apps у Codex, ChatGPT, Cursor, Kilo Code. `@modelcontextprotocol/ext-apps` 2.0.4 (в npm — MIT; репозиторий переходит на Apache-2.0).

**Экспериментальные расширения**: filesystems (запись ресурсов с ревизией, см. 1.1), file-uploads, interceptors, tool-annotations ([обзор](https://modelcontextprotocol.io/extensions/overview)).

**Агент Радити.** OpenCode (в продукте 1.18.34) по документации v2 даёт модели инструменты, промпты и ресурсы ([opencode.ai](https://opencode.ai/v2/docs/mcp-servers/)); подписки на ресурсы — только экспериментальный PR, вошёл ли он в выпуск — не подтверждено.

**Что из этого следует:**
- Не полагаться на подписки: каждый результат инструмента артефакта несёт `version` и список блоков, изменённых с прошлого чтения этим чатом.
- Ресурс `raditi-artifact://<id>` и `resource_link` в результатах — дёшево и правильно, но агент OpenCode прочтёт их только инструментом `resources/read`; основной путь — инструменты.
- Аннотации ставить честно (`readOnlyHint` у чтения), но права и подтверждения держит сервер, а не подсказка.
- MCP Apps нужен, только если артефакт Радити понадобится показывать внутри чужого хоста (Claude, ChatGPT). В кабинете хост — сам Радити, и протокол там необязателен; но его правила песочницы (разные источники хоста и песочницы, ограничительный CSP, белый список методов) — готовый образец моста.

---

## 5. Показ недоверенного HTML агента

**Песочница.** `<iframe sandbox>` без `allow-same-origin` даёт документу непрозрачный источник (`null`): ни cookie, ни хранилища, ни доступа к DOM родителя; `postMessage` работает. Заголовок `Content-Security-Policy: sandbox` делает то же для URL, открытого напрямую: «Sandboxes the content as if it was served on a separate domain» ([web.dev](https://web.dev/articles/securely-hosting-user-data)). По Google, CSP `sandbox` «is likely a sufficient solution», если Spectre и взлом рендерера вне модели угроз; иначе — отдельный домен песочницы на Public Suffix List и кадр `$RANDOM_VALUE.exampleusercontent.com/shim`, в который приложение передаёт содержимое через `postMessage`, а shim рисует его как Blob в песочном iframe; для изолированных поддоменов — `Cross-Origin-Opener-Policy: same-origin` и `Cross-Origin-Embedder-Policy: require-corp`.

**Поддомен против отдельного регистрируемого домена.** Поддомен — тот же сайт: страница с собственным источником на `x.example.com` может ставить cookie на `example.com`, и их получит основной сайт («cookie tossing»: заголовок `Cookie` несёт только имя и значение, без `Domain` и `Path`). GitHub в 2013 году перенёс Pages на `github.io` против фишинга и этой атаки ([GitHub, 09.04.2013](https://github.blog/2013-04-09-yummy-cookies-across-domains/)); `github.io` — в PSL. `SameSite` от атак с того же сайта не защищает. У Радити `<slug>.pages.raditi.ru` — тот же сайт, что кабинет (Ст3), и держится это только на непрозрачном источнике: скрипт страницы cookie не читает и не ставит. Добавить `allow-same-origin` артефакту на этом домене нельзя.

**`srcdoc` наследует CSP родителя** (тесты WPT; у Firefox открыт баг 1803475 о сопоставлении источников в `srcdoc`) ([bugzilla](https://bugzilla.mozilla.org/show_bug.cgi?id=1803475)). Для артефакта со скриптами надёжнее отдельный URL со своим заголовком CSP (как `/v/<token>` Радити), чем `srcdoc` в кабинете.

**Как делают другие.**
- Claude: у каждого артефакта свой источник `<uuid>.frame.claudeusercontent.com`; CSP начинается `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:`, `connect-src 'self'`, `frame-ancestors 'self' https://claude.ai https://*.claude.ai`; проба `fetch`, XHR, WebSocket, маячков-картинок и `sendBeacon` наружу не прошла (Pluto Security, 06.08.2026, вторичный). Приложения MCP в Claude — `{hash}.claudemcpcontent.com` (спецификация MCP Apps).
- ChatGPT: «HTML previews» в песочном iframe. Разбор Parameter Labs (31.10.2026): виртуальную клавиатуру MathLive в родителе можно вызвать `postMessage` из любого песочного кадра, обработчик родителя кладёт данные в `innerHTML` — так вставлялся iframe без песочницы, а разрешённый в CSP endpoint oEmbed YouTube исполнял JavaScript; итог — чтение личных данных и действия от имени открывшего ссылку, премия $5 000 ([Simon Willison](https://simonwillison.net/2026/Oct/31/how-we-took-over-chatgpt-accounts/)).
- Gemini: домен песочницы `*.usercontent.goog` — не подтверждено.

**Правила моста `postMessage` для Радити:**
1. Родитель принимает сообщение, только если `event.source === frame.contentWindow` и `event.origin === "null"` (непрозрачный кадр) или ожидаемый источник песочницы.
2. Схема каждого сообщения (zod) и белый список методов: «выбран элемент» (селектор, текст, рамка), «размер изменился», «скачать файл» (через подтверждение), «открыть ссылку» (через подтверждение). Ничего из сообщения не уходит в `innerHTML`, `eval`, атрибуты `href`/`src` без проверки.
3. Кадр не ходит в API платформы (`connect-src 'none'`); всё, что ему нужно, приносит родитель после проверки прав.
4. Предел частоты сообщений и размера.
5. `frame-ancestors` — только кабинет; ответы — `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-site` для файлов.

**Когда нужен отдельный домен** (решение владельца: покупка, DNS, сертификат, заявка в PSL): если артефакту понадобится свой источник — `localStorage`, IndexedDB, service worker, OAuth-возврат, загрузка с CDN под своим источником. Тогда — регистрируемый домен песочницы на PSL и поддомен на артефакт, как `claudeusercontent.com`. Пока артефакт живёт в непрозрачном источнике, этого не нужно.

---

## 6. Ссылки для шеринга

**W3C TAG, «Good Practices for Capability URLs»** (First Public Working Draft, 18.02.2014, «not expected to become a Recommendation») ([w3.org](https://www.w3.org/TR/capability-urls/)): не делать по умолчанию — сначала доступ по учётной записи; только `https`; неугадываемый идентификатор; на странице — никаких сторонних ссылок и скриптов, иначе `rel="noreferrer"`; путь ссылок — в `robots.txt`, сами ссылки — нет; ссылки должны истекать (пример — неделя), истёкшая — `410 Gone` или `404`; владелец может отозвать; несколько ссылок на ресурс, чтобы отозвать одну; `GET` без побочных эффектов; `302` на каноничный адрес и `replaceState()`, чтобы токен не жил в адресной строке; объяснять пользователю последствия пересылки; ресурс стал публичным — `301` на публичный адрес.

**Энтропия.** OWASP: идентификатор сессии — «at least 64 bits of entropy», CSPRNG, при своём генераторе — «a size of at least 128 bits» ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)). Для ссылки, которая живёт месяцами, — 128 бит и больше.

**Утечка через Referer.** Политика по умолчанию — `strict-origin-when-cross-origin`: полный адрес уходит только на тот же источник, на чужой — только источник ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy)). Ссылка с токеном в пути всё равно попадает в журналы своего сервера, историю браузера, скриншоты; на странице ставить `Referrer-Policy: no-referrer`, токен в журналах маскировать.

**Как у других.**
- Google Drive: «Anyone with the link» без входа, роль Viewer/Commenter/Editor; срок доступа — только у отдельного человека (рабочие и учебные аккаунты, до года), не у ссылки ([support](https://support.google.com/drive/answer/2494822)). В 2021 году Google добавила «resource key» в старые ссылки (с 13.09.2021): их можно было подобрать ([9to5google, 28.07.2021](https://9to5google.com/2021/07/28/google-drive-security-update/)).
- Claude Docs: роли читатель/комментатор/редактор; ссылка «anyone with the link», где разрешает план и организация; приглашения по почте и группе; вне организации — если разрешил владелец организации; Claude правит только с правами того, кто попросил.
- Claude Code: артефакт приватен по умолчанию; внешний шеринг — настройка организации; ссылки с `x-robots-tag: none`; публичные ссылки бесплатного плана индексируются (Pluto Security).

**Отзыв, перевыпуск, вход, роли** — решения для Радити в §8.7.

---

## 7. Сравнение моделей

| Модель | Сервер Радити (Node 26/Nest, PG, Redis, SSE) | Хранение в PG | Размер и рост | Отмена по участнику | Присутствие | Офлайн | Агенту (цитаты, id, перечитать при конфликте) | Проверка каждой операции на сервере | «Агент пишет здесь» | Библиотеки и лицензии |
|---|---|---|---|---|---|---|---|---|---|---|
| Целый объект + CAS | Есть всё | Строка + версии | Весь объект в записи | Только откат версии | Нет | Нет | Хорошо при одном писателе, плохо при нескольких | Полная | Только «весь объект» | Свой код |
| **Блоки + ревизия блока + аренда** | Есть всё; SSE + POST | Блоки + журнал + снимки | Запись — блок | Обратная операция, если блок не менялся | Аренда + эфемерные курсоры | Нет | Лучше всех: короткие id, явная проверка, перечитать блок | Полная, до показа | Аренда с намерением до вызова, pending-блок | fractional-indexing (CC0), node-diff3 (MIT) |
| CRDT Yjs + Hocuspocus, агент — серверный клиент | Новый сервис WebSocket | `bytea` снимок + обновления | История и надгробия растут | UndoManager по происхождению | Awareness | Да | Через надстройку id; слияние без отказа — логические конфликты | Агента — до `transact`; человека — только после | Awareness агента | Yjs, Hocuspocus (MIT); y/hub (AGPL) |
| CRDT Automerge / Loro | Свой сервер синхронизации или automerge-repo-sync-server | `bytea` | Automerge 3 — в 10 раз меньше памяти; Loro — срез истории | Loro — локальная; Automerge — не подтверждено | Loro EphemeralStore | Да | Как у Yjs | Как у Yjs | Как у Yjs | MIT |
| OT (ShareDB, ProseMirror collab) | Упорядочивающий процесс или блокировка строки; POST + SSE | Журнал шагов + снимок | Журнал | Локальная история с перебазированием | Свой | Ограниченно | Нужен слой «цитата → шаги» | Полная (схема) | Свой | ShareDB, sharedb-postgres, ProseMirror (MIT) |
| Журнал операций + server reconciliation | Есть всё | Журнал + свёртка | Журнал, нужно сжатие | Через журнал | Свой | Частично (очередь) | Хорошо, если операции блочные | Полная; можно превратить в предложение | Свой | Zero (Apache-2.0), свой код |
| Гибрид: блоки + Y.Text внутри блока | Сервис WebSocket только для «живых» блоков | Блоки + `bytea` у живых | Растёт только у живых блоков | UndoManager внутри блока | Awareness внутри блока | Внутри блока | Как у блоков: id и ревизия снаружи | Агента — до `transact`; человека — после | Аренда + курсор | Yjs, Hocuspocus (MIT) |

---

## 8. Рекомендация для Радити

### 8.1 Решение одной фразой

Артефакт — дерево блоков в PostgreSQL под серверной властью: каждая операция идёт через одну функцию домена (из `apps/mcp` для агента и из tRPC для кабинета), проверяется (права, схема, размер, ревизия, аренда), пишется в журнал и меняет блок; изменения расходятся существующими сигналами SSE и дочитываются по номеру версии; правку агента видят после проверки `core`. CRDT не вводить, пока данные не покажут, что люди часто печатают в одном блоке одновременно.

Почему: (1) агенту нужна проверка ревизии и короткий отказ «перечитай», а не молчаливое слияние; (2) правило 2 требует проверять написанное агентом до показа — у CRDT сервер этого не умеет; (3) без нового сервиса WebSocket, без копилефта и без зарубежного SaaS; (4) это обобщение уже работающих `chat_documents` (разделы по id, живая проверка) и `page_edit` (цитата на версии).

**Страница и артефакт — разные сущности** (запрос владельца): артефакт — рабочий объект в кабинете (приватен по умолчанию, совместная правка, ревизии, комментарии, роли, привязан к проекту или к пользователю); страница — опубликованный снимок версии артефакта на `<slug>.pages.raditi.ru` со своим адресом, паролем, версиями v1, v2 и снятием 410. Публикация = копия версии артефакта в страницу (`page_publish` с `artifactId`, как сейчас `docId`); ссылка шеринга даёт доступ к рабочему объекту, а не публикует его.

### 8.2 Модель данных (предложение)

```text
artifacts
  id uuid v7 (от клиента или сервера), workspace_id, owner_user_id,
  project_id uuid NULL            -- NULL: артефакт пользователя, иначе — проекта
  kind  text|page|canvas|table    -- §8.8; список растёт
  title varchar(200), version bigint  -- = seq последней применённой операции
  created_task_id NULL, archived_at, deleted_at, purge_after  -- корзина 30 дней, как у страниц и проектов
  size_bytes, created_at, updated_at

artifact_blocks                   -- текущее состояние
  artifact_id, block_id varchar(12)   -- короткий id сервера: b1, b2, f3 …; не переиспользуется
  parent_id NULL, position text       -- дробный индекс (fractional-indexing)
  kind  section|frame|row|asset|…
  heading/intent varchar(200), content text, props jsonb   -- props: x, y, w, h, viewport, ширины столбцов …
  rev bigint                          -- seq последней операции над блоком
  state pending|written|checking|refused
  pending_content text NULL           -- черновик агента до проверки core
  lease_holder, lease_kind human|agent|check, lease_intent varchar(120),
  lease_until timestamptz, lease_token bigint   -- жетон растёт при каждой выдаче
  updated_by_kind user|agent, updated_by_user_id, updated_task_id, updated_turn
  deleted_rev bigint NULL             -- надгробие для дельт `gone`
  secret_flag bool                    -- человек вставил похожее на секрет: агенту блок не отдаётся

artifact_ops                      -- журнал: история, атрибуция, отмена, дельты
  artifact_id, seq bigint (уникален в артефакте), op_id uuid (уникален в артефакте)
  actor_kind, actor_user_id, task_id NULL, turn_no NULL
  block_id, op jsonb, before jsonb (образ блока до), after_rev, result jsonb, created_at

artifact_versions                 -- именованные снимки v1, v2: «Сохранить версию», публикация, шеринг на версию
artifact_members                  -- user_id, role view|comment|edit, granted_via_share_id
artifact_shares                   -- §8.7
artifact_comments                 -- треды с якорем: block_id + цитата/селектор; to_agent
```

Файлы холста (картинки, шрифты) — S3 `raditi-artifacts` под ключом артефакта, отдаются с домена страниц. Присутствие («кто смотрит», курсоры) — только Redis с TTL 30 с, не база.

Пределы (значения по умолчанию, предложение): блок текста ≤ 64 КиБ Markdown, кадр холста ≤ 512 КиБ HTML, артефакт ≤ 8 МиБ без файлов, файлы ≤ 50 МиБ на артефакт (как сайт страниц), вызов ≤ 50 операций и ≤ 256 КиБ, журнал — 90 дней, именованные версии — без срока.

### 8.3 Формат операции

Один формат у агента и у кабинета:

```json
{
  "artifactId": "0193…",
  "opId": "0193…",
  "ops": [
    {"op": "replace", "block": "b7", "ifRev": 41, "as": "markdown",
     "content": "## Цены\n\n| Услуга | Цена |\n|---|---|\n| Стрижка | 1 200 ₽ |"},
    {"op": "str_replace", "block": "b9", "old": "1 990 ₽", "new": "2 490 ₽"},
    {"op": "insert", "after": "b9", "kind": "section", "intent": "Отзывы: три коротких",
     "as": "markdown", "content": "## Отзывы\n\n…"},
    {"op": "move", "block": "b3", "after": "b1", "ifRev": 12},
    {"op": "delete", "block": "b4", "ifRev": 8},
    {"op": "set_props", "block": "f2", "props": {"x": 1520, "y": 0}}
  ]
}
```

Ответ: `{"version": 44, "results": [{"block": "b7", "rev": 44, "state": "checking"}, …], "changedSinceYourRead": ["b2"]}`; отказ всего вызова — код и данные одной операции: `guard_mismatch {block, rev, excerpt}`, `find_none`, `find_many {count}`, `block_busy {holder, intent, until}`, `block_gone`, `too_large {limit}`, `missing_guard`.

Правила: все операции вызова применяются в одной транзакции или ни одна (как Google `batchUpdate`); повтор с тем же `opId` возвращает сохранённый результат; `str_replace` ищет `old` ровно один раз (`all: true` — каждое вхождение) в видимом содержимом блока; `set_props` — последний записавший побеждает по свойству, без проверки (Figma).

### 8.4 Правило конфликтов

1. **Запись в существующий блок** несёт `ifRev` или цитату `old`; иначе `missing_guard`.
2. **Несовпадение** — ничего не меняется, ответ несёт текущую ревизию и фрагмент. Агент перечитывает блок (`artifact_read` с `sinceVersion`) и делает заново; принудительной записи у агента нет.
3. **Человек побеждает агента.** Когда человек начинает править блок, кабинет берёт аренду `human` (TTL 30 с, продление каждые 10 с); агент получает `block_busy` с именем и временем и идёт к другому блоку. Аренду агента человек может забрать: жетон растёт, и ещё не применённая запись агента получает `guard_mismatch` (ограждение Kleppmann). Агент у агента аренду не отбирает: первый держит до истечения (агенту — 60 с, продлевается каждой операцией, не дольше 10 минут подряд).
4. **Два человека в одном блоке**: при `guard_mismatch` кабинет делает трёхстороннее слияние текста (база — содержимое на `ifRev`, «их» — текущее, «моё» — черновик; node-diff3 или diff-match-patch); непересекающиеся правки сливаются сами, пересекающиеся — показываются.
5. **Структура**: позиции — дробные индексы, вставки по месту не конфликтуют; `delete` и `move` требуют `ifRev`; удалить блок под чужой арендой нельзя; удаление артефакта, восстановление версии и снятие доступа — только человеком или по словам клиента (`confirmedByClient: true`, как у `page_delete`).
6. **Проверка правки агента**: `mcp` пишет черновик в `pending_content`, блок — `checking` под арендой `check`, ревизия уже растёт (другие писатели получают `block_busy` на 1–3 с); `core` проверяет тем же сканером, что раздел документа (секреты, ключи хода, значения переменных; цикл 1,5 с), и переносит черновик в `content` отдельной записью журнала `checked` с новой ревизией — так дельта `sinceVersion` видит и появление текста; отказ — образ «до» возвращается (тоже запись журнала), агенту и клиенту — строка с причиной. До проверки другие читатели получают прежнее проверенное содержимое с `state: checking`; черновик видит только писавший агент.
7. **Правка человека** проходит проверку секретов на сохранении (`secretInContent`, как текст проекта); нашлось — блок сохраняется с `secret_flag`, человеку — предупреждение, агенту при чтении — заглушка «[скрыто: похоже на секрет]».
8. **Отмена своего**: «Отменить» в кабинете и `artifact_undo({opId})` у агента применяют образ «до», только если `rev` блока всё ещё равен `after_rev` операции; иначе — «изменено после, показать разницу». «Отменить всё, что сделал этот ход» — по `task_id` + `turn_no`, с тем же условием на каждый блок.

### 8.5 Живой канал

- **Запись**: кабинет — мутация tRPC `artifact.edit` (HTTP POST); агент — инструменты `apps/mcp`; обе вызывают одну функцию `@repo/db` под `SELECT … FOR UPDATE` строки артефакта (порядок `seq` без гонок).
- **Сигнал**: триггер после фиксации на `artifact_ops` и смене аренды → `NOTIFY raditi_artifact '<artifactId>:<version>'` (полезная нагрузка короче 8 000 байт — [PostgreSQL NOTIFY](https://www.postgresql.org/docs/17/sql-notify.html)) → то же соединение `LISTEN` в `core` (канал добавить в `apps/core/src/task-signals`), склейка 50 мс → Redis `raditi:artifact:<id>` → подписчик web → подписка tRPC `artifact.signals({artifactId})` по SSE (ping 15 с, права при подключении и каждые 15 с — как `task.signals`).
- **Дочитывание**: клиент по сигналу вызывает `artifact.changes({sinceVersion})` → изменённые блоки (`rev > sinceVersion`), надгробия (`deleted_rev > sinceVersion`), аренды. Без потока — опрос раз в 20 с; правильность от сигналов не зависит.
- **Присутствие**: мутация `artifact.presence` раз в 10 с пишет в Redis хеш с TTL 30 с (кто, какой блок, курсор), сигнал — тем же путём; в базу не пишется.
- **Агенты**: подписок нет; каждый результат `artifact_*` несёт `version` и блоки, изменённые с прошлого чтения этим чатом (закладка на чат хранится сервером).
- **Потом, если понадобится**: Hocuspocus только для блоков в режиме «живой текст» (`content_ydoc bytea`), когда двое людей правят один блок; инструменты агента не меняются — сервер переводит `str_replace` в транзакцию Y.Text через `openDirectConnection`.

### 8.6 Инструменты агента — семейство MCP `artifact` (`apps/mcp/src/artifacts`)

| Инструмент | Что делает | Аннотации |
|---|---|---|
| `artifact_list` | Артефакты пользователя и проекта этого чата: id, вид, название, версия, кто менял последним | `readOnlyHint` |
| `artifact_read` | `mode: outline` (id, вид, ревизия, состояние, заголовок или намерение, аренда), `blocks` (содержимое выбранных), `search` (цитата → блоки); `sinceVersion` → только изменённое и `gone`; порции до 32 000 знаков с `more` | `readOnlyHint` |
| `artifact_create` | Скелет: вид, название, блоки с намерениями (pending), проект — `this_chat` или без; сразу виден справа, как `doc_create` | — |
| `artifact_edit` | Пакет операций §8.3 с `opId` | `destructiveHint` (есть `delete`), `idempotentHint` (с `opId`) |
| `artifact_claim` | Аренда блоков или места `after:<id>` с намерением («пишу раздел «Цены»») до длинной записи; `seconds: 0` — отпустить | `idempotentHint` |
| `artifact_version` | Именованная версия vN с короткой заметкой, как `doc_finish` | — |
| `artifact_comments` / `artifact_reply` | Треды, которые человек отправил агенту; ответ и «решено» | чтение — `readOnlyHint` |
| `artifact_undo` | Отмена своих операций (§8.4, п. 8) | `destructiveHint` |
| `artifact_delete`, `artifact_restore` | В корзину и восстановление версии — только по словам клиента (`confirmedByClient: true`) | `destructiveHint` |

Создавать ссылки, менять роли и открывать доступ агент не может: это решение человека в кабинете (агент может только сказать, где кнопка). Описания учат: читать оглавление, потом блок; один блок — один вызов; никогда не переписывать артефакт по памяти; при `guard_mismatch` перечитать блок; перед длинной записью — `artifact_claim` или pending-блок; не трогать блок под арендой человека. Права: агент действует с ролью автора чата (как Claude Docs). В проходе по расписанию без надзора — только чтение, кроме артефакта, который назван в задаче (значение по умолчанию, вопрос владельцу).

«Агент пишет здесь» по мере генерации: технически обёртка драйвера видит дельты аргументов вызова в потоке модели (как у РА5) и могла бы показывать черновик блока ещё до вызова — с той же маскировкой значений переменных; не проверено, отдельный срез.

**Несколько агентов и человек — как это выглядит.** Лендинг кофейни (`canvas`, версия 40) открыт у владельца; чат A делает главный экран, чат B — страницу для телефона, запуск по расписанию C раз в день читает цены.

1. A: `artifact_claim(blocks: ["f1"], intent: "Главная 1440: первый экран")` → аренда до 12:01:30; у владельца на кадре f1 — «Агент чата «Главная» пишет: первый экран».
2. B: `artifact_read(mode: "outline")` → видит у f1 аренду A и пишет в f2; его `artifact_edit` с `ifRev: 38` проходит, версия 41, f2 — `checking`, через ≈1,5 с `core` проверил — f2 у всех.
3. Владелец перетаскивает f2 (`set_props`, без проверки) — версия 42; B об этом узнает из `changedSinceYourRead` следующего ответа.
4. A: `artifact_edit(ops: [{op: "str_replace", block: "f1", old: "Кофе с собой", new: "Кофе навынос"}])` — цитата найдена один раз, версия 43.
5. Владелец ставит курсор в текст f1 — кабинет забирает аренду (`human`, жетон 7). Следующая запись A с жетоном 6 → `guard_mismatch`; A читает f1 заново и пишет в другой кадр или ждёт.
6. C: `artifact_read(mode: "search", query: "₽")` — только чтение, черновиков чужих чатов не видит.

Пример ответа `artifact_read(mode: "outline")` (текстом рядом со `structuredContent`):

```text
artifact 0193… «Лендинг кофейни» canvas v43 · изменено с твоего чтения: f2
f1 «Главная 1440» frame 1440×2400 rev 43 · аренда: человек (владелец) до 12:02:10
f2 «Главная 390» frame 390×1800 rev 42 · props от человека
f3 «Меню 1440» frame pending · «Меню: три колонки с ценами»
```

### 8.7 Шеринг по ссылке

- **Адрес**: `https://raditi.ru/a/<token>` (кабинет), токен — 24 байта CSPRNG (192 бита, 32 знака base64url); в базе — SHA-256, сам токен — один раз в ответе создания; в журналах web путь `/a/*` маскируется.
- **Таблица `artifact_shares`**: `token_hash`, `role` (`view` | `comment` | `edit`), `requires_sign_in`, `version_pin` (NULL — живой артефакт), `expires_at` (нет | 7 | 30 дней), `revoked_at`, `created_by`, `last_used_at`, `uses`.
- **Роли**: `view` — можно без входа, если владелец выбрал «любой, у кого есть ссылка»; `comment` и `edit` — только после входа: первое открытие создаёт строку `artifact_members` (правка подписана человеком). Отзыв ссылки закрывает новые входы, участники убираются отдельно («Убрать доступ»).
- **Заголовки страницы ссылки**: `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store`; в `robots.txt` — `Disallow: /a/`; после первого открытия — `302` на каноничный адрес, токен меняется на cookie, привязанную к ссылке (как `raditi_page` у страниц с паролем), и `replaceState`.
- **Перевыпуск** — новая ссылка, старая сразу 410; несколько ссылок на артефакт; журнал открытий для владельца.
- **Показ** у получателя: Markdown рисует кабинет, HTML и кадры — домен страниц с CSP `sandbox` (§5); у получателя без входа — только чтение, без агента.
- **Агент получателя**: участник с ролью `edit` прикрепляет артефакт к своему чату; его агент правит в пределах этой роли. Содержимое владельца уходит модели под пространством получателя — гейт 152-ФЗ надо проверять по классу данных обоих пространств (строже — побеждает); вопрос владельцу.

### 8.8 Виды артефактов на этой модели

| Вид | Блок | Правка агентом | Правка человеком | Показ |
|---|---|---|---|---|
| `text` | Раздел (заголовок + Markdown), как `chat_document_sections` | `replace`/`str_replace`/`insert` | Редактор раздела (Tiptap 3, MIT, или textarea + предпросмотр), аренда на фокусе, сохранение с `ifRev` раз в 1 с | `@repo/doc-render`, без сырого HTML |
| `page` | Одна страница HTML целиком или по секциям `<section data-block>` | `str_replace` по цитате с `ifRev` | Правка кода; правка текста в предпросмотре — позже | Домен страниц, CSP `sandbox` |
| `canvas` (дизайн сайта) | Кадр = HTML на свой экран (1440×900, 390×844 …), `props` — положение и размер | `str_replace` в HTML кадра с `ifRev`; `set_props` | Перетаскивание (LWW), комментарий к кадру, выбор элемента в кадре — мост `postMessage` (селектор + текст в запрос агенту) | Кадр — iframe с `/v/<token>`, масштаб CSS; миниатюры — `apps/browser` |
| `table` | Строка таблицы; ячейки — `props.cells` с LWW по ячейке | `set_props` ячеек и `replace` строки с `ifRev` | Ячейка за ячейкой | Сетка кабинета |

Для холста tldraw не подходит по лицензии; хватит своей доски (кадры-iframe на трансформируемом поле).

### 8.9 Этапы

1. **Э1**: таблицы §8.2 и вид `text` — обобщение `chat_documents` (инструменты `doc_*` остаются обёрткой над `artifact_*`); операции с `ifRev`, аренды, журнал, живая проверка `core`, сигналы SSE, вкладка справа; отмена своего.
2. **Э2**: `canvas` и `page`: кадры, свойства LWW, мост выбора элемента, комментарии «отправить агенту».
3. **Э3**: шеринг, участники, роли, журнал открытий.
4. **Э4**: `table`; режим «живой текст» на Yjs внутри блока — только если журнал покажет частые `guard_mismatch` между людьми; MCP Apps — если понадобится показывать артефакты в чужих хостах.

### 8.10 Риски и вопросы владельцу (со значениями по умолчанию)

| Вопрос | Значение по умолчанию |
|---|---|
| Размер блока текста: раздел или абзац | Раздел (как сейчас); абзацы — внутри раздела цитатами |
| Кто побеждает при одновременной правке | Человек |
| Просмотр по ссылке без входа | Можно для `view`; `comment` и `edit` — только со входом |
| Отдельный домен песочницы | Не покупать, пока артефакту не нужен свой источник |
| Агент получателя читает артефакт владельца | Можно в пределах роли; гейт 152-ФЗ — по обоим пространствам |
| Запуск по расписанию пишет в артефакт | Только читает, кроме артефакта, названного в задаче |
| Хранение журнала | 90 дней; именованные версии — без срока |
| Пределы | §8.2 |

Риски: (1) длинные HTML-кадры дороги в токенах — цитаты и `outline` обязательны; (2) аренда без жетона даёт потерянные записи — жетон обязателен; (3) мост `postMessage` — главный вектор атаки на кабинет (§5); (4) правка человеком в CRDT-стиле «как в Google Docs» здесь не получится — второй человек в том же разделе ждёт или сливает; если владелец считает это обязательным с первого дня, тогда — гибрид с Yjs внутри блока и новый сервис Hocuspocus.

---

## Источники

**Модели и библиотеки**
- RFC 9110, If-Match — https://www.rfc-editor.org/rfc/rfc9110#name-if-match
- RFC 6902, JSON Patch `test` — https://www.rfc-editor.org/rfc/rfc6902#section-4.6
- MCP experimental-ext-filesystems, resource operations (2026-10-09) — https://github.com/modelcontextprotocol/experimental-ext-filesystems/blob/main/docs/proposals/resource-operations.md
- Kleppmann, How to do distributed locking (08.02.2016) — https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html
- Figma, How Figma’s multiplayer technology works (16.10.2019) — https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- Notion, The data model behind Notion’s flexibility (18.05.2021) — https://www.notion.com/blog/data-model-behind-notion
- Notion, How we made Notion available offline (11.12.2025) — https://www.notion.com/blog/how-we-made-notion-available-offline
- Google Docs API batchUpdate (WriteControl) — https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate
- Google Docs API structure (UTF-16) — https://developers.google.com/workspace/docs/api/concepts/structure
- Google Drive Blog, Making collaboration fast (23.09.2010) — https://drive.googleblog.com/2010/09/whats-different-about-new-google-docs.html
- Hocuspocus 4 stable (08.05.2026) — https://tiptap.dev/blog/release-notes/hocuspocus-4-stable-release
- Hocuspocus 4.8.0 source — https://cdn.jsdelivr.net/npm/@hocuspocus/server@4.8.0/src/Hocuspocus.ts
- Yjs UndoManager — https://docs.yjs.dev/api/undo-manager ; Y.Doc — https://docs.yjs.dev/api/y.doc
- y-protocols awareness 1.0.6 — https://cdn.jsdelivr.net/npm/y-protocols@1.0.6/awareness.js
- y/hub README — https://cdn.jsdelivr.net/npm/@y/hub@0.3.0/README.md
- Форум Yjs: validation — https://discuss.yjs.dev/t/validation-security-and-middleware/2229 ; inverse update — https://discuss.yjs.dev/t/generate-an-inverse-update/2765
- WordPress sync HTTP polling — https://cdn.jsdelivr.net/npm/@wordpress/sync@1.44.0/src/providers/http-polling/README.md
- y-sse — https://github.com/shishkin/y-sse ; y-durable-streams — https://unpkg.com/@durable-streams/y-durable-streams@0.2.4/README.md
- Automerge 3.0 (июль 2025) — https://automerge.org/blog/automerge-3/
- PowerSync, Why Cinapse moved away from CRDTs (02.10.2025) — https://www.powersync.com/blog/why-cinapse-moved-away-from-crdts-for-sync
- Loro undo — https://www.loro.dev/docs/advanced/undo ; shallow snapshot — https://loro.dev/docs/advanced/shallow_snapshot
- Eg-walker (arXiv 2409.14252, EuroSys 2025) — https://arxiv.org/abs/2409.14252
- ShareDB middleware — https://share.github.io/sharedb/middleware/actions
- ProseMirror guide, collab — https://prosemirror.net/docs/guide/#collab ; переезд на Forgejo — https://discuss.prosemirror.net/t/prosemirrors-migration-to-forgejo/8974
- prosemirror-history source — https://cdn.jsdelivr.net/npm/prosemirror-history@1/src/history.ts
- Weidner, Collaborative Text Editing without CRDTs or OT (21.05.2025) — https://mattweidner.com/2025/05/21/text-without-crdts.html
- Zero custom mutators — https://zero.rocicorp.dev/docs/custom-mutators
- tldraw sync — https://tldraw.dev/docs/sync ; tldraw AI — https://tldraw.dev/docs/ai ; лицензия — https://raw.githubusercontent.com/tldraw/tldraw/main/LICENSE.md
- Лицензии и версии — реестр npm (`registry.npmjs.org/<пакет>/latest`, 19.11.2026), GitHub API и LICENSE-файлы: yjs, sharedb, y-sweet, BlockNote `packages/xl-ai/package.json`, ext-apps

**Продукты**
- Liveblocks Sync (01.09) — https://liveblocks.io/blog/introducing-liveblocks-sync-the-sync-engine-for-the-agentic-web
- Liveblocks, февраль 2026 — https://liveblocks.io/blog/whats-new-in-liveblocks-february-2026
- Liveblocks, open source — https://liveblocks.io/blog/open-sourcing-the-liveblocks-sync-engine-and-dev-server.md
- Liveblocks, Feeds and APIs for agent workflows — https://liveblocks.io/blog/introducing-feeds-and-apis-for-agent-workflows
- Liveblocks, How humans and AI will work together — https://liveblocks.io/blog/how-humans-and-ai-will-work-together-in-the-next-generation-of-apps
- Tiptap Q1 2026 (10.03.2026) — https://tiptap.dev/blog/release-notes/recap-q1-2026
- Tiptap Server AI Toolkit tools — https://tiptap.dev/docs/content-ai/capabilities/server-ai-toolkit/api-reference/tools
- Tiptap licensing discussion — https://github.com/ueberdosis/tiptap/discussions/7321 ; pricing — https://tiptap.dev/pricing
- BlockNote AI reference — https://www.blocknotejs.org/docs/features/ai/reference
- Figma write to canvas — https://developers.figma.com/docs/figma-mcp-server/write-to-canvas
- Fluid tree-agent — https://fluidframework.com/docs/api/tree-agent/ ; service options — https://fluidframework.com/docs/deployment/service-options
- Claude Docs — https://support.claude.com/en/articles/16923645-get-started-with-claude-docs
- Pluto Security, Inside Claude artifacts (06.08.2026) — https://pluto.security/blog/inside-claude-artifacts-how-your-agent-publishes-to-the-web/
- Описания инструментов Claude Code `Artifact`, `ArtifactData`, `ArtifactComments`, навык `artifact-capabilities` (контракт 0.2.47), сервер MCP Claude Docs — в сессии 19.11.2026, публичного адреса нет

**Инструменты агента**
- Claude text editor tool — https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool.md
- OpenAI apply_patch — https://developers.openai.com/api/docs/guides/tools-apply-patch.md
- Aider edit formats — https://aider.chat/docs/more/edit-formats.html
- Notion MCP pages reference — https://developers.notion.com/guides/mcp/tools-pages-reference.md
- Google Docs MCP reference — https://developers.google.com/workspace/docs/api/reference/mcp
- Canva MCP tools — https://www.canva.dev/docs/mcp/tools/ ; perform editing operations — https://www.canva.dev/docs/mcp/tools/perform-editing-operations/ ; verify — https://www.canva.dev/docs/mcp/verify-integration/
- OpenAI, Introducing canvas (03.10.2024) — https://openai.com/index/introducing-canvas/

**MCP**
- 2025-06-18 changelog — https://modelcontextprotocol.io/specification/2025-06-18/changelog
- 2025-11-25 changelog — https://modelcontextprotocol.io/specification/2025-11-25/changelog ; tools — https://modelcontextprotocol.io/specification/2025-11-25/server/tools ; schema — https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-11-25/schema.ts
- 2026-07-28 changelog — https://modelcontextprotocol.io/specification/2026-07-28/changelog
- Extensions overview — https://modelcontextprotocol.io/extensions/overview
- MCP Apps overview — https://modelcontextprotocol.io/extensions/apps/overview.md ; спецификация (Stable 2026-01-26) — https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- OpenCode MCP servers — https://opencode.ai/v2/docs/mcp-servers/

**Недоверенный HTML и шеринг**
- web.dev, Securely hosting user data — https://web.dev/articles/securely-hosting-user-data
- GitHub, Yummy cookies across domains (09.04.2013) — https://github.blog/2013-04-09-yummy-cookies-across-domains/
- Simon Willison о Parameter Labs (31.10.2026) — https://simonwillison.net/2026/Oct/31/how-we-took-over-chatgpt-accounts/
- Mozilla bug 1803475 (srcdoc и CSP) — https://bugzilla.mozilla.org/show_bug.cgi?id=1803475
- W3C TAG, Good Practices for Capability URLs (18.02.2014) — https://www.w3.org/TR/capability-urls/
- OWASP Session Management — https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- MDN Referrer-Policy — https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy
- Google Drive sharing — https://support.google.com/drive/answer/2494822 ; resource key (28.07.2021) — https://9to5google.com/2021/07/28/google-drive-security-update/
- PostgreSQL NOTIFY — https://www.postgresql.org/docs/17/sql-notify.html
