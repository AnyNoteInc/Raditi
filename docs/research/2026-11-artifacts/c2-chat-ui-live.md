# C2. Чат, правая панель и живые обновления — опись кода под раздел «Артефакты»

Дата: 19.11.2026. Дерево: `feat/artifacts`, ветка `feat/artifacts`, `HEAD` = `b1349f3b` (после #150, #151). Только чтение: в репозитории ничего не менялось. Пути ниже — от корня репозитория, номера строк — на этом коммите.

Прочитано: планы 59, 64, 66, 67 (частично), 74, 75, 78, 80, 86; код `apps/web/src/components/chat/*` (модель инструментов, `dialog-view.tsx`, панель, меню, «Документы», браузер, поле, «@»), `components/application/*` (рейка, каркас, панель «]»), маршруты `apps/web/src/app/(protected)`, SSE и сигналы (`task.signals`, триггеры PostgreSQL, `TaskSignalRelay`, подписчик Redis в web), Telegram (`apps/core/src/telegram`, `feed-markdown.ts`), тема (`packages/ui/src/theme`), `apps/web/DESIGN.md`.

Внешние факты (Telegram Bot API, tRPC, PostgreSQL `NOTIFY`, MDN `EventSource`, Yjs) проверены 19.11.2026 по первоисточникам — ссылки в §11. Измерения ширины подписей — шрифтом Golos Text из `node_modules` (`@fontsource-variable/golos-text@5.3.0`) в headless Chrome; калибровка: «Расписание» дало ровно 65,0 px — столько же, сколько записано в комментарии `application-rail.tsx:27`.

---

## 0. Главное

1. **Правая панель — общая и почти готова принять новую вкладку.** Модель — чистый модуль `dialog-tools.ts` (список инструментов, метки плиток, редьюсер вкладок, точка на «+»), рисуют её `tools-menu.tsx` и `tools-panel.tsx`, содержимое вкладки отдаёт `toolContent()` в `dialog-view.tsx:1256-1317`. Сейчас инструментов два: `browser` и `documents` (`dialog-tools.ts:19`). Новая вкладка «Артефакты» — это одно значение в `dialogTools`, значок, названия, условие появления, ветка `toolContent` и тексты; полоса вкладок и меню обобщены и правок не требуют.
2. **«Документы» открываются сами** — это уже готовый образец для артефактов: первый ответ ленты — опора, документ, пришедший после неё, открывает вкладку от `lg` (1200 px) один раз за показ; ниже `lg` — только точка на «+» («есть новый документ»). Код: `use-document-arrivals.ts:33-52`, `agent-document.tsx:613-632`, `dialog-view.tsx:565-590`, редьюсер `documentArrived` — `dialog-tools.ts:251-261`. Найдено по чтению кода (не воспроизведено): у чата длиннее 200 видимых строк опора берётся с первой страницы ленты, и документ со второй страницы считается «пришедшим» — вкладка может открыться сама при загрузке (§2.3).
3. **Одна вкладка «Артефакты», а не вкладка на каждый артефакт.** Расчёт по коду и замерам шрифта: панель от `lg` — 440–760 px (`pane-layout.ts:7,33`); вкладка «Браузер» — ≈129 px, «Документы» — ≈150 px, «Артефакты» — ≈148 px; на полосе под вкладки остаётся ширина панели минус ≈110 px. Три вкладки помещаются только при панели от ≈550 px; вкладка с названием артефакта («Лендинг кофейни» — 122 px текста) — ≈194 px, и две такие с браузером и документами не помещаются ни при какой ширине панели (§2.4, §3.2).
4. **Пункт рейки.** Рейка — массив `sections` в `application-rail.tsx:24-33` (сейчас «Чаты», «Задачи», «Страницы», «Проекты»). Подпись «Артефакты» в 11 px/500 — **60,5 px при ширине пункта 60 px** (`application-rail.tsx:126`): не помещается, как когда-то «Расписание» (65 px → подпись «Задачи», доступное имя «Запланированные задачи»). Нужна короткая подпись, плотнее начертание или шире пункты — решение владельца (§4.1). Тесты, которые считают пункты рейки, — `application-rail.test.tsx:34` (ровно 4) и `apps/e2e/tests/site/chat.spec.ts:85` (`toHaveCount(4)`).
5. **Живые обновления сегодня привязаны к чату.** Цепочка: триггер PostgreSQL `pg_notify('raditi_task', '<task id>:feed|activity')` (миграция `20261118140000_task_signals`) → одно соединение `LISTEN` в `core` (`TaskSignalRelay`, склейка 50 мс) → Redis `raditi:task:<id>` → один подписчик Redis на процесс web → подписка tRPC `task.signals` по SSE (`httpSubscriptionLink`) → страница читает `task.feed` по курсору. Сигнал — только «прочитай сейчас»; опрос остаётся запасным (15 с в работе, 20 с в ожидании при живом потоке; 2 и 15 с без него).
6. **Документы агента живут на сигналах чата, который их пишет.** `core` пишет строку `feed.doc_touch` в ленту *пишущего* чата (`apps/core/src/tasks/doc-sections.ts:145-154`), страница по ней перечитывает `pages.doc` (`agent-document.tsx:86-111`). Зритель того же документа в другом чате, в «Страницах» или по ссылке ничего не узнает. Артефакту, который пишут несколько чатов и люди, нужен свой канал по id артефакта (§6).
7. **Зрителя «не из пространства» сейчас нет вовсе.** Все процедуры кабинета — `consentedProcedure` (вход + согласия), доступ к чату — членство в пространстве и автор проекта (`packages/trpc/src/services/chat/access.ts:10-18`); приглашений в пространство в коде нет. Для шеринга нужна своя модель прав (грант пользователю по ссылке) и своя проверка в каждой процедуре и в подписке с повторной проверкой (как `SIGNALS_RECHECK_MS` = 15 с).
8. **«@» в поле.** Механизм плана 78 жив в виде `ComposerMentions` (`composer.tsx:171-184`), источник — `useContextMentions` проекта (`apps/web/src/components/projects/use-context-mentions.ts:38-89`), он уже склеивает два источника (файлы контекста и пути репозитория) под корнем `/workspace/`. Поле — обычный `textarea` (`composer.tsx:799`): упоминание — только текст, «чипов» внутри текста нет. Варианты для артефакта — путь в песочнице, токен, который разбирает `core`, или вложение-чип через «+» (§7).
9. **Telegram сегодня не отдаёт ни файлов, ни ссылок на страницы.** Из строк прохода в Telegram идут только `feed.file` — «Файл «…»», `feed.page` — «Страница «…», версия vN» (без адреса) и `feed.doc_left`; `feed.doc` не идёт вовсе. В конце — кнопка «Открыть в кабинете» на `APP_URL/chats/<taskId>`. `sendDocument` в коде нет. Bot API с июня–ноября 2026 даёт Rich Messages (до 32 768 знаков, таблицы, код), потоковые черновики и HTML-виджеты в сообщении (только личные чаты) — это пути показать артефакт прямо в Telegram (§8).

---

## 1. Где что лежит (карта файлов)

| Что | Файл | Строки |
| --- | --- | --- |
| Модель инструментов: список, метки, редьюсер, точка | `apps/web/src/components/chat/dialog-tools.ts` | 19 (`dialogTools`), 25 (`toolOpeners`), 29-32 (значки), 35-40 (имена, id), 61-73 (`dialogToolsOf`), 97-110 (`toolMark`), 116-139 (`ToolsState`), 142-152 (`closedTools`, `toolsShown`), 154-175 (`ToolsAction`), 215-263 (`toolsReducer`), 273-285 (`toolTilesOf`), 298-306 (`toolsDot`, `toolsLabel`) |
| Чат целиком: состояние панели, открытия, содержимое вкладок | `apps/web/src/components/chat/dialog-view.tsx` | 410-413 (редьюсер, `wide`), 533-561 (поток браузера и самостоятельный запуск), 565-594 (документы и «Результаты»), 744-792 (`openTool`, `showTool`, `closeTool`, `closeTools`, `backToDialog`), 1063-1079 (действия ленты для документов), 1240-1253 (меню «+»), 1256-1317 (`toolContent`), 1336-1373 (шапка), 1375-1555 (лента и поле), 1566-1577 (`ToolsPanel`) |
| Панель справа (полоса вкладок, «К чату», «Скрыть панель») | `apps/web/src/components/chat/tools-panel.tsx` | 34-50 (вкладка), 53-60 (`usePaneMark`), 98-143 (`aside`), 144 (`PaneResizer`), 155-189 (строка «К чату»), 190-285 (полоса), 286-309 (панели вкладок) |
| «+» и меню «Инструменты» | `apps/web/src/components/chat/tools-menu.tsx` | 37 (`TOOLS_BUTTON_ID`), 44 (`TOOLS_MENU_MARK`), 48-107 (плитки, метка, карточка), 231-280 (кнопка и точка), 281-310 (лист снизу), 312-335 (карточка `Popover`) |
| Ширина панели, cookie, отметка «панель нарисована» | `apps/web/src/components/chat/pane-layout.ts` | 7, 8, 15, 17, 20-21, 26, 33, 36 |
| Край панели | `apps/web/src/components/chat/pane-resizer.tsx` | 28 (шаг 24 px), 67-73 (пишет переменную в `[data-chat-shell]`), 109-153 |
| «Документы» | `apps/web/src/components/chat/documents-pane.tsx` | 49-55 (`DocumentTarget`), 64-65 (адрес окна), 70-102 (история вкладки), 105-114 (`useWide` 600 px), 162-445, 617-673 (`PageFrame`), 721-896 (текст и оглавление), 899-945 (`documentSx`) |
| Документ агента по разделам | `apps/web/src/components/chat/agent-document.tsx` | 68-111 (id, ревизии, перечитывание), 169-200 (светлый лист), 221-294 (`LiveSections`), 433-463 (`PageVersion`), 471-594 (`AgentDocumentView`), 613-632 (`useAgentDocumentArrivals`) |
| Документы пришли | `apps/web/src/components/chat/use-document-arrivals.ts` | 16-52 |
| Документ в своей вкладке браузера | `apps/web/src/components/chat/document-window.tsx`; маршрут `apps/web/src/app/(protected)/chats/[taskId]/documents/[fileId]/page.tsx` | 14-53; 21-27 |
| «Результаты» справа вверху ленты | `apps/web/src/components/chat/results-card.tsx` | 22-28, 44-70, 183+ |
| Браузер чата | `apps/web/src/components/chat/browser-pane.tsx` (файл не переименовывать: по нему стенд браузера решает, водить ли кабинет — план 59, И20) | 406-423 (`usePhone`), 455-…, 941-1090 (панель управления), 1211-1294 (подсказка «Мобильная версия», полоса кнопок ниже `sm`) |
| Поле сообщения, «+», «@» | `apps/web/src/components/chat/composer.tsx` | 171-184 (`ComposerMentions`), 201-208 (порядок контролов), 382-397 (поиск «@»), 414-…(вставка), 703-704 (рамка поля), 799 (`textarea`), 860-920 («+» и «Загрузить файл») |
| Разбор «@» | `apps/web/src/components/chat/file-mentions.tsx` | 27-36, 39-46, 53-86, 89-102, 111-136, 139+ |
| Источник «@» в проекте | `apps/web/src/components/projects/use-context-mentions.ts` | 15, 21, 38-89 |
| Оболочка «Чатов» | `apps/web/src/components/chat/chats-shell.tsx`, `chats-frame.tsx` | 16, 46-94; 158-198, 305-331 |
| Каркас кабинета | `apps/web/src/components/application/cabinet-shell.tsx`, `cabinet-panel.tsx`, `panel-drawer.tsx`, `panel-resizer.tsx`, `application-shell.tsx`, `apps/web/src/lib/cabinet-panel.ts` | см. §4 |
| Рейка | `apps/web/src/components/application/application-rail.tsx` | 24-33, 39, 59-83, 118-158, 164-178 |
| Значки | `apps/web/src/components/application/app-icon.tsx` | 3-128 (пути 24×24), 132-161 |
| Чтение ленты и сигналы на странице | `apps/web/src/components/chat/use-dialog-feed.ts`, `feed-state.ts`, `task-signal-bus.ts` | 23-64, 84-133; 106-145; 12-34 |
| tRPC: клиент, SSE, процедуры ленты | `apps/web/src/trpc/client.tsx`; `packages/trpc/src/trpc.ts`; `packages/trpc/src/routers/task.ts`; `packages/trpc/src/services/chat/signals.ts`, `feed.ts`, `access.ts` | 24-35; 113-116; 409-470; 17, 25-69; 210-288; 10-18 |
| Сигналы: БД → core → Redis → web | `packages/db/prisma/migrations/20261118140000_task_signals/migration.sql`; `apps/core/src/task-signals/task-signal-relay.ts`, `task-signals.module.ts`; `apps/web/src/server/task-signals.ts`, `chat-services.ts`; `packages/domain/src/tasks/task-signals.ts` | 12-32; 51-146; 42-67; 32-90; 74; 9-44 |
| Telegram | `apps/core/src/telegram/telegram-jobs.ts`; `packages/domain/src/tasks/feed-markdown.ts`; `packages/domain/src/tasks/client-feed-labels.ts`; `packages/telegram/src/html.ts`; `apps/core/src/telegram/progress-text.ts` | 110-139, 171-173, 346-440; 71, 263-279, 346-348; 424, 439-440; 160; 9, 11 |
| Тема | `packages/ui/src/theme/tokens.ts`, `create-app-theme.ts`; `apps/web/DESIGN.md` | все |

---

## 2. Правая панель инструментов сегодня

### 2.1. Модель (`dialog-tools.ts`)

- **Инструменты** — `dialogTools = ['browser', 'documents'] as const` (строка 19). После плана 83 предпросмотра, файлов, базы и проверок нет.
- **Кто открывает** — `toolOpeners = ['menu', 'take']` (25): «+» и «Взять управление». Самостоятельный запуск браузера — отдельное действие `launch`, документы — `documentArrived`; открытия по тексту агента нет и быть не должно (план 59, И9, §3 п. 4).
- **Состав меню** — `dialogToolsOf(head, documents)` (61-73): «Браузер» — у чата с `requirements.browser` всегда, «Документы» — когда `documents > 0`. Пустое меню — «+» не рисуется (`dialog-view.tsx:1243`, план 61, К19).
- **Метка плитки** — `toolMark` (97-110): «Открыто»; у документов — число; у браузера — кто управляет («Управляете вы», «Ждём вас», «Работает агент», «пока нет», «нет», «Закрыт»).
- **Состояние** — `ToolsState { open, active, away, launchSpent, documentsSpent, documentsUnseen }` (116-139). Каждый показ чата начинается с закрытой панели (`closedTools`, 142-149; план 59, И1): ничего не хранится ни в адресе, ни в cookie.
- **Редьюсер** (215-263): `open` — в конец или сделать активной, без дубля; `show` — выбор вкладки на полосе, не просьба; `close` — активной становится соседняя справа, иначе слева; `closeAll` — «Скрыть панель»; `back` — «К чату» ниже `lg`: закрывает вкладку на экране, остальные остаются «за чатом» (`away`); `launch` — браузер; `documentArrived` — документ.
- **Точка на «+»** — `toolsDot` (298-302): «браузер ждёт вас» старше «есть новый документ»; при открытой панели точки нет. Имя кнопки — «Инструменты — …» (`toolsLabel`, 305-306; тексты `chat-texts.ts:768-812`).
- **id вкладок** — `dialog-pane-tab-<tool>` и `dialog-pane-panel-<tool>` (39-40): на них опираются стенды (план 59, И20).

### 2.2. Компоновка в `dialog-view.tsx`

- `const [tools, dispatchTools] = useReducer(toolsReducer, closedTools)` (410), `wide = useMediaQuery(theme.breakpoints.up('lg'))` (412-413; на первом рендере после гидратации — `false`).
- `openTool(tool, { by })` (744-749) — единственный путь открытия по нажатию; фокус — на вкладку (`focusSoon(toolTabId(tool))`), кроме «Взять управление» от `lg`. `closeTool` (765-771) и `closeTools` (777-781) ничего не шлют на сервер (просмотр ≠ выполнение, И8); фокус после последней вкладки — на «+» (`focusBackSoon`, 728-735).
- «+»: пока панель закрыта — в шапке чата (`DialogHead … tools={shown ? null : menu}`, 1368), пока открыта — в конце полосы вкладок (`menu={shown ? menu : null}`, 1571); ниже `lg` меню — лист снизу (`sheet={!wide}`, 1248).
- **Содержимое вкладки** — `toolContent(tool)` (1256-1317): `browser` → `BrowserPane`, `documents` → `DocRevisions.Provider` + `DocumentsPane` + окно публикации. Каждая открытая вкладка остаётся смонтированной и скрытой за другой (`tools-panel.tsx:286-309`, `hidden`, `display: none`): браузер хранит последний кадр, «Документы» — место. Поток браузера идёт только при активной вкладке (`visible: browserShown`, 533-540).
- **Ниже `lg`** открытый инструмент занимает место чата: шапка и лента скрыты `display: none`, но не размонтированы — черновик, файлы и место чтения сохраняются (`covered`, 1253; 1339, 1381).
- **Полный экран** (`fullscreen`, 431): панель на всю область содержимого (рейка остаётся), лента, шапка, список чатов и ссылка «К чатам» — `inert` (984-1006); любое закрытие сбрасывает режим.

### 2.3. Как «Документы» открываются сами (готовый образец для артефактов)

Путь — план 67, Д4 (файлы `.html`/`.md` из `/workspace/out`), план 74, Д5 (документ агента по разделам), дополнение 13.11.2026 к плану 59:

1. **Опора.** `useDocumentArrivals(rows, head !== null, onArrive)` (`use-document-arrivals.ts:33-52`): при первом ответе ленты запоминается самая новая строка документа (`latestDocumentRow`); затем каждая версия документа после опоры — «пришла» (`arrivedSince`). Для документов агента — то же по id из строк `feed.doc` (`useAgentDocumentArrivals`, `agent-document.tsx:613-632`).
2. **Что делает чат** (`dialog-view.tsx:570-590`): `openDocument(name, null)` — ставит вкладке цель (`DocumentTarget { name, fileId, seq }`, новое `seq` — открыть снова), затем `dispatchTools({ type: 'documentArrived', opens: wide })`.
3. **Редьюсер** (`dialog-tools.ts:251-261`): вкладка уже на экране — ничего; узкий экран (`opens: false`) или клиент в этом показе уже закрывал «Документы»/панель (`documentsSpent`) — только точка (`documentsUnseen`); на экране другой инструмент — «Документы» встают рядом без фокуса; иначе панель открывается на «Документах».
4. **Действия вручную**: карточка ленты «Открыть» (`actions.onOpenDocument` / `onOpenAgentDocument`, 1063-1079) и карточка «Результаты» (1424-1433) — `openDocument(...)` + `openTool('documents', { by: 'menu' })`. Пока вкладка показывает документ, карточка говорит «Открыт справа» (`shownAgentDocument`, 1076-1079; `feed-doc.tsx`).
5. **Открыть отдельно**: «Открыть в новой вкладке» → `/chats/<taskId>/documents/<fileId>` (`documentWindowHref`, `documents-pane.tsx:64-65`; страница `document-window.tsx` рисует ту же `DocumentsPane` с `standalone`).

**Найдено по чтению кода, не воспроизведено.** Лента читается по 200 строк по возрастанию id (`feedLimits.page = 200`, `packages/domain/src/tasks/client-feed.ts`; `packages/trpc/src/services/chat/feed.ts:220-244`); при `more` следующая страница читается сразу (`feed-state.ts`, `now`). Опора `useDocumentArrivals` и `useAgentDocumentArrivals` берётся после **первого** ответа (`ready = head !== null`), то есть по первой странице. У чата длиннее 200 видимых строк документ, чья строка лежит на второй странице, будет принят за «пришедший», и «Документы» откроются сами при загрузке (от `lg`) или загорится точка. Сейчас чаты production короче 50 строк ленты (план 86, §4), поэтому проблема скрыта. Для артефактов опору нужно брать, когда история прочитана целиком (ответ без `more`), или по отметке сервера.

### 2.4. Ширины и контрольные точки

Тема не переопределяет контрольные точки MUI (в `create-app-theme.ts` нет `breakpoints`): `xs` 0, `sm` 600, `md` 900, `lg` 1200, `xl` 1536 px.

| Порог | Что меняется |
| --- | --- |
| `sm` (600) | рейка 72 px вместо 56, подписи под значками (`application-rail.tsx:126-158`); у браузера кнопки управления в верхней строке, «Во весь экран» (`browser-pane.tsx:975-991`); ниже `sm` — полоса кнопок внизу (1271-1294) |
| `md` (900) | каркас «карточки на подложке»: рейка без фона, панель «]» 284 px и содержимое — карточки радиуса 18 px с зазором 10 px (`cabinet-shell.tsx`, план 64, Н1); список чатов — панель рядом с рейкой (`chats-frame.tsx:158-198`) |
| `lg` (1200) | панель инструментов — карточка справа (`position: fixed`), открытый чат — в высоту окна с лентой в своей области; ниже `lg` инструмент встаёт на место чата |
| 600 px ширины самой вкладки | у «Документов» — оглавление сбоку (`useWide(root, 600)`, `documents-pane.tsx:105-114, 199`) |
| 1008 px области ленты | «Результаты» помещаются справа в ленте (`RESULTS_MIN_AREA = 640 + 280 + 24 + 64`, `results-card.tsx:22-28`) |
| `(pointer: coarse) and (max-width: 599.95px)` | «телефон» для браузера: подсказка «Мобильная версия» (`browser-pane.tsx:406-423, 482-491`) |
| высота окна ≤ 420 px | шапка чата не прилипает (`dialog-view.tsx:1351`); ≤ 480 px — рейка без подписей (`application-rail.tsx:39`) |

**Ширина панели** (`pane-layout.ts:33`): `max(440px, min(var(--site-pane-width, clamp(440px, 46vw, 760px)), calc(100vw − 526px − var(--cabinet-panel-space, 0px))))`, где 526 = рейка 72 + 3 зазора по 10 + поля содержимого 2×32 + минимум чата 360; `--cabinet-panel-space` = 294 px, когда список чатов открыт (284 + 10). Своя ширина — cookie `raditi-pane-width` (`pane-layout.ts:36`), край тянется мышью и стрелками, шаг 24 px (×4 с Shift), Home/End (`pane-resizer.tsx:28, 77-88`). Панель — от `lg` `position: fixed; top/bottom/right: 10px`, рамка `divider`, радиус 18 px, `zIndex 1100` (`tools-panel.tsx:116-127`).

Расчёт по этим формулам (в браузере не мерил):

| Окно | Список чатов | Панель | Карточка чата | Колонка ленты (макс. 780) |
| --- | --- | --- | --- | --- |
| 1200 | открыт | 440 | 374 | 310 |
| 1200 | скрыт | 552 | 556 | 492 |
| 1280 | открыт | 460 | 434 | 370 |
| 1280 | скрыт | 589 | 599 | 535 |
| 1366 | открыт | 546 | 434 | 370 |
| 1440 | открыт | 620 | 434 | 370 |
| 1440 | скрыт | 662 | 686 | 622 |
| 1600 | открыт | 736 | 478 | 414 |
| 1920 | открыт | 760 | 774 | 710 |
| 1920 | скрыт | 760 | 1068 | 780 |

На 1200 со списком гарантия «чат не уже 360» не держится: `max(440px, …)` побеждает (колонка 310 px). Это существующее поведение.

**Полоса вкладок.** Вкладка (`tools-panel.tsx:34-50, 220-262`): 44 px высотой, радиус 12, поле слева 12 px, значок 18 + 8 px, название 14 px/400 (выбранная — 500, `action.selected`), × — 32 px шириной во всю высоту, 2 px до него. Ширина вкладки ≈ 72 px + название. Замер названий (Golos Text 14 px/400): «Браузер» 57,2, «Документы» 78,3, «Артефакты» 76,1 (500 — 76,9), «Холст» 39,9, «Лендинг кофейни» 122,4 px. Под вкладки на полосе от `lg` остаётся ≈ панель − 110 px (рамки 2, поля 10 + 6, «Скрыть панель» 44, «+» 44, промежутки 2×2).

| Панель | Место под вкладки | «Браузер» + «Документы» (≈284) | + «Артефакты» (≈437) | + одна вкладка-артефакт «Лендинг кофейни» (≈194) |
| --- | --- | --- | --- | --- |
| 440 | 330 | да | нет, прокрутка | нет |
| 460 | 350 | да | нет | нет |
| 552 | 442 | да | впритык | нет |
| 620–760 | 510–650 | да | да | только вместо «Артефактов» |

Полоса — `Tabs variant="scrollable" scrollButtons={false}` (`tools-panel.tsx:205-218`): лишняя вкладка уезжает за край без стрелок. Ниже `lg` полоса во всю ширину области без «Скрыть панель» и «+» (они в строке «К чату»): на телефоне 390 px остаётся ≈340 px — те же две вкладки.

### 2.5. Телефон и узкий экран (ниже `lg`)

- Меню «+» — лист снизу (`Drawer anchor="bottom"`), не шире 560 px, радиус 24 px сверху, плитки ≥ 92 px, своя кнопка «Закрыть меню» (`tools-menu.tsx:66-80, 281-310`).
- Инструмент — отдельная область на месте чата: сверху строка 56 px «← К чату» и «+», под ней полоса вкладок 56 px, ниже содержимое; область не ниже 480 px, оболочка передаёт ей высоту окна (`tools-panel.tsx:108-113, 155-189`; `chats-shell.tsx:88-92`).
- «К чату» закрывает только вкладку на экране; остальные открытые — «за чатом», в меню «+» с меткой «Открыто» (ответ владельца от 30.10.2026, И14; `dialog-tools.ts:233-237`). Прокрутка страницы при возврате восстанавливается (`use-feed-follow.ts`, И19).
- На странице чата ниже `sm` рейки нет (`railHiddenOnPhone={item}`, `chats-shell.tsx:53`); путь назад — ссылка «← К чатам» сверху (`chats-frame.tsx:305-331`).
- Документ, пришедший на узком экране, панель не открывает — только точка на «+». Браузер при запуске открывается на любой ширине (ответ владельца от 30.10.2026 на И3).
- Известное ограничение (план 59, §7): системный «Назад» на телефоне из области инструмента уходит со страницы чата — черновик и чипы файлов теряются; правильный возврат — «К чату».

### 2.6. «Результаты»

Карточка 280 px справа вверху ленты (`results-card.tsx:22-28`), видна от `lg`, когда в чате есть документы и область ленты не уже 1008 px; переключатель — значок `results` в шапке чата, выбор скрыть — `localStorage` `raditi.chat.results.hidden` (`results-card.tsx:30, 44-70`). Карточка называет документы и их ход («пишется · 3 из 7», «v2») и открывает их во вкладке. Артефакты чата естественно встают сюда же.

---

## 3. Шаги: вкладка «Артефакты» справа

### 3.1. Вариант А (рекомендую): один инструмент `artifacts`

Что поменять (по коду; имена новых файлов — предложение):

1. **Модель** `apps/web/src/components/chat/dialog-tools.ts`:
   - `dialogTools = ['browser', 'documents', 'artifacts'] as const` (строка 19) — порядок меню; тест `dialog-tools.test.ts:151` ждёт ровно `['browser', 'documents']`.
   - `toolIcons.artifacts` (29-32) — новый путь в `AppIcon` (`app-icon.tsx:3-128`, 24×24, линия 1,7): похожих нет — `pages`, `document`, `layers` заняты.
   - `dialogToolsOf(head, documents, artifacts)` (61-73): условие появления — «есть артефакт, связанный с чатом» (или всегда, если поле умеет «создать артефакт»).
   - `toolMark` (97-110): число артефактов или «Открыто»; живой «пишется» — как у документов агента.
   - Если вкладка открывается сама: в `ToolsState` — `artifactsSpent`, `artifactsUnseen`; действие `{ type: 'artifactArrived'; opens: boolean }` по образцу `documentArrived` (251-261); `closed()` (194-207) и `closeAll` ставят `artifactsSpent`; `toolsDot` (298-302) — причина `artifacts` после `browser`.
2. **Тексты** `chat-texts.ts:768-812`: `toolText.tab.artifacts`, `toolText.item.artifacts`, `toolText.dot.artifacts` («есть новый артефакт» или «агент изменил артефакт»), плюс `artifactText` по образцу `documentText` (820-857).
3. **Чат** `dialog-view.tsx`:
   - список артефактов чата и цель вкладки (`artifactTarget`, как `documentTarget`, 566-569);
   - приход — `useArtifactArrivals` по образцу `useAgentDocumentArrivals` (опора — после ответа без `more`, §2.3);
   - `toolContent` (1256-1317): ветка `case 'artifacts': return <ArtifactsPane …/>`;
   - `actions.onOpenArtifact` и признак «открыт справа» (1063-1079); пункт в «Результатах» (1402-1437); `documentCount` (591) → общий счёт для `useResultsCard`;
   - `leaveFullscreenFor` (752) пуст — менять не нужно; полноэкранный режим вкладке даётся пропсами `fullscreen`/`onFullscreen`, как «Документам».
4. **Панель и меню** — без правок: `tools-panel.tsx` и `tools-menu.tsx` обобщены по `tools.open` и `tiles` (меню при трёх плитках — сетка 2×2 с пустой клеткой, `tools-menu.tsx:171-175`).
5. **Новые компоненты**: `artifacts-pane.tsx` (шапка как у `DocumentsPane`, `documents-pane.tsx:277-375`: «Все артефакты (N)» — список в `Popover`, название в пилюле, версии, «Обновить», «На весь экран», «Открыть отдельно» → `/artifacts/<id>`, «Скачать», «Поделиться»); `feed-artifact.tsx` (одна строка в ленте, как `FeedDoc`).
6. **Строка ленты**: новый тип `feed.artifact` (или `feed.artifact_touch`) в `packages/domain/src/tasks/client-feed.ts` (`readFeedRow`), текст для `/export` и Telegram в `feed-markdown.ts:263-279`, решение «говорить ли в Telegram» — набор `TOLD` (`telegram-jobs.ts:110-130`).
7. **Тесты**: `dialog-tools.test.ts` (состав, метки, редьюсер), `tools-menu.test.tsx`, `tools-panel.test.tsx`, `dialog-view.test.tsx` (открытие, самостоятельное открытие, фокус, «К чату»), `apps/e2e/tests/site/dialog.spec.ts` (плитки «+», строки 138-176, 464; axe с открытым меню и двумя вкладками), `accessibility.spec.ts` (цели 44 px в портале меню).

### 3.2. Вариант Б: вкладка на каждый открытый артефакт

- `DialogTool` перестаёт быть перечислением: `type DialogTool = 'browser' | 'documents' | \`artifact:${string}\``; `toolIcons`, `toolTabNames`, `toolMenuNames` (29-36) — функции; `dialogTools` (19) больше не перечисляет всё; `toolTilesOf` — плитка на каждый артефакт (меню «+» растёт без предела).
- id вкладок `dialog-pane-tab-artifact:<uuid>` допустимы в HTML, но двоеточие требует `CSS.escape` в селекторах.
- Главное возражение — ширина (§2.4): вкладка с названием ≈190 px; при панели 440–760 px помещаются две-три. С 4–5 артефактами полоса прокручивается без стрелок, названия режутся. Если владельцу нужны «вкладки как у браузера», — потолок числа вкладок-артефактов (например, 3) и название с многоточием в 120 px.

### 3.3. Вариант В: «Документы» становятся «Артефактами»

Документы агента уже почти артефакт: `ChatDocument` принадлежит **пространству**, его может писать любой чат пространства, есть `revision`, версии, вид `page | text` (`packages/db/prisma/schema.prisma:2530-2557`, комментарий в строках 2541-2542); разделы с живой проверкой `core` (`ChatDocumentSection`, 2560-2583). Переименовать инструмент `documents` → «Артефакты» и добавить новые виды (холст, таблица, диаграмма…) дешевле, чем держать две похожие вкладки и две плитки «+». «Страницы» (опубликованные сайты `<slug>.pages.raditi.ru`) остаются отдельным слоем: «Опубликовать по ссылке» делает из артефакта страницу. Это решение владельца (§10).

---

## 4. Пункт рейки и маршруты

### 4.1. Рейка

- **Список** — `sections` в `application-rail.tsx:24-33`: `{ href, label, name?, icon }`. Текущий пункт — по `pathname === href || pathname.startsWith(href + '/')` (41-42). Подпись под значком: 11 px, высота строки 14 px, 500; пункт 60×56 от `sm` и 48×48 ниже (126-127); подпись ниже `sm` и в окне ≤ 480 px не видна, только доступное имя (152-158). Выбранный от `md` — `background.paper` с внутренней линией 1 px `divider`, значок `primary.main` (140-146).
- **Ширина подписи** (замер, Golos Text 11 px/500):

| Подпись | px | Влезает в 60? |
| --- | --- | --- |
| Расписание (калибровка) | 65,0 | нет (поэтому «Задачи») |
| Документы | 62,2 | нет |
| Материалы | 61,9 | нет |
| **Артефакты** | **60,5** | **нет, на 0,5 px** |
| Заготовки | 56,2 | да |
| Страницы | 54,6 | да |
| Наброски | 53,8 | да |
| Проекты | 48,0 | да |
| Макеты | 41,9 | да |
| Работы | 40,1 | да |
| Холсты | 40,0 | да |
| Задачи | 39,4 | да |
| Чаты | 27,2 | да |

  Варианты: подпись «Артефакты» с `letterSpacing: -0.02em` (≈58,5 px, вплотную к краям плашки выбранного пункта); пункты шире (64 px при рейке 72 — меняет все пункты); короткая подпись при доступном имени «Артефакты» (прецедент — «Задачи», план 82, Зп1). Решает владелец.
- **Порядок.** Сейчас «Чаты», «Задачи», «Страницы», «Проекты» (комментарии в коде ссылаются на решения владельца: Зп1 — «Задачи» после «Чатов», Ст30 — «Страницы» после «Чатов», «Проекты» — последний). Место нового пункта — решение владельца; логичное — рядом со «Страницами» (артефакт → публикация в страницу).
- **Высота рейки**: пять пунктов по 56 px с промежутком 6 px — 304 px, знак сверху 44 + 24, внизу кредиты и меню аккаунта; при высоте окна ≤ 480 px пункты 44 px без подписей и рейка прокручивается (`application-rail.tsx:39, 79-82, 147`).
- **Тесты**: `apps/web/src/components/application/application-rail.test.tsx:31-82` (ровно 4 ссылки, порядок, текущий раздел для путей), `apps/e2e/tests/site/chat.spec.ts:81-87` (`toHaveCount(4)`, имена по позициям); `scheduled.spec.ts:24`, `projects.spec.ts:45, 73` ищут пункты по имени — не ломаются.

### 4.2. Маршруты

Шаблоны оболочек:

- **Без левой панели** — `ApplicationShell user toolbar={false}` (как `/pages`, `/projects`, `/scheduled`: `apps/web/src/app/(protected)/pages/page.tsx:14-22`): поля содержимого 20/32/48 px (xs/sm/lg), сверху 32/40 px (`application-shell.tsx:38-51`); заголовок раздела — `SectionHeading` с «i» и подсказкой (`components/application/section-heading.tsx`).
- **С левой панелью «]»** — `CabinetShell panel={<CabinetPanel label="…">…</CabinetPanel>}` и `PanelDrawer` ниже `md`, как «Настройки» (`components/account/settings-shell.tsx:100-162`, layout читает cookie панели — `app/(protected)/settings/layout.tsx:14-27`).
- **Как «Чаты»** — список рисует себя сам (`panel` = `true`), ниже `md` корень раздела — список (`chats-shell.tsx`, `chats-frame.tsx`).

Предлагаемые файлы:

```
apps/web/src/app/(protected)/artifacts/page.tsx                 «Артефакты»: галерея / список, фильтры «Мои», «Проекта», «Доступные мне»
apps/web/src/app/(protected)/artifacts/[artifactId]/page.tsx    артефакт на всю область: просмотр и правка, версии, «Поделиться», «Обсудить в чате»
apps/web/src/app/(protected)/artifacts/[artifactId]/load-artifact.ts   по образцу chats/[taskId]/load-chat.ts:22-34 (cache, UUID, notFound)
apps/web/src/app/(protected)/artifacts/[artifactId]/not-found.tsx
apps/web/src/app/(protected)/artifacts/join/[token]/page.tsx    вход по ссылке шеринга: грант текущему пользователю, затем redirect
apps/web/src/components/artifacts/…                             вид, список, пустой экран (как components/pages, components/projects)
```

- `generateMetadata` — название артефакта, как у чата (`chats/[taskId]/page.tsx:13-16`).
- Ссылка шеринга под `(protected)` проходит через `requireSession` и согласия (`(protected)/layout.tsx:16-29`): новый человек сначала регистрируется и принимает документы — `consentRedirectLink` клиента tRPC отправит его на `/onboarding/consents`. Публичный просмотр без входа — только вне `(protected)` (см. §6.4).
- Путь `/artifacts/<id>` проходит проверку пути push и окна кабинета (`components/notifications/cabinet-messages.ts:18-26`, `CABINET_PATH`): уведомления и Telegram могут вести прямо туда.

### 4.3. Чат и проект как входы в артефакт

- **Новый чат по артефакту**: `newChatHref(projectId)` и `projectOfSearch` (`chat-address.ts:14-21`) — образец для `?artifact=<id>` («Обсудить в чате»: новый чат с артефактом во вложении и открытой вкладкой).
- **Проект**: колонка страницы проекта — `aside` 340 px от `lg` со строками «Инструкции», «Контекст», «Память», «Запланировано» (`components/projects/project-view.tsx:116-117, 223-300`). Строка «Артефакты» встаёт туда же (`ProjectArtifactsRow`). Правой панели инструментов на странице проекта нет: превью — переход на `/artifacts/<id>` или окно.
- **Связь панели с оболочкой «Чатов».** `usePaneMark` (`tools-panel.tsx:53-60`) и `PaneResizer.apply` (`pane-resizer.tsx:67-73`) ищут `[data-chat-shell]`, комната под панель — селектор `PANE_DRAWN` (`pane-layout.ts:17`). Чтобы та же панель справа жила на `/artifacts/<id>` или в проекте, отметку надо обобщить до `[data-cabinet-shell]` (его ставит каждый `CabinetShell`, `cabinet-shell.tsx:105`).

---

## 5. Живые обновления сегодня

### 5.1. Цепочка от строки в базе до экрана

1. **PostgreSQL** — миграция `packages/db/prisma/migrations/20261118140000_task_signals/migration.sql:12-32`: функции `raditi_task_signal` и `raditi_task_row_signal`, триггеры `AFTER INSERT ON task_events` (`client_visible` → `feed`, `type = 'turn.output'` → `activity`), `AFTER UPDATE ON tasks` (`OLD.* IS DISTINCT FROM NEW.*` → `feed`), `AFTER INSERT OR UPDATE ON browser_sessions` (→ `feed`). Канал `raditi_task`, полезная нагрузка `'<task id>:<kind>'`. PostgreSQL доставляет уведомление только после фиксации транзакции и склеивает одинаковые в одной транзакции; полезная нагрузка — короче 8000 байт (документация PostgreSQL, §11). Отдельно `20261118150000_outbox_wake` — `raditi_outbox` будит relay outbox.
2. **core** — `TaskSignalRelay` (`apps/core/src/task-signals/task-signal-relay.ts:51-146`): одно соединение `pg.Client` (таймаут 5 с, keepalive, `task-signals.module.ts:51-56`), `LISTEN raditi_task` и `LISTEN raditi_outbox` (96-97), склейка сигналов одной задачи и вида за 50 мс (127-132), публикация в Redis `raditi:task:<id>` (134-145); после каждого подключения — `resync` в `raditi:tasks:resync` (107-111). Переподключение 1→30 с вдвое (115-125). Модуль — только в процессе с воркерами (`task-signals.module.ts:37-41`).
3. **Контракт имён** — `packages/domain/src/tasks/task-signals.ts:9-44` (`TASK_SIGNAL_PG_CHANNEL`, `taskSignalKinds = ['feed', 'activity']`, `taskSignalChannel`, `TASK_SIGNALS_RESYNC_CHANNEL`, разбор).
4. **web, процесс** — `createTaskSignals` (`apps/web/src/server/task-signals.ts:32-70`): один `ioredis` в режиме подписчика на процесс, канал на задачу, которую смотрит хоть одна страница процесса, отписка при последнем слушателе; после потери соединения — `resync` всем. Без `REDIS_URL` — `null`, страницы только опрашивают (77-90). Передаётся в контекст tRPC: `signals: taskSignals()` (`apps/web/src/server/chat-services.ts:74`).
5. **tRPC** — подписка `task.signals` (`packages/trpc/src/routers/task.ts:428-438`) → `readTaskSignals` (`packages/trpc/src/services/chat/signals.ts:25-69`): проверка доступа (`accessibleTask`), первым — `resync`, очередь без повторов, **повторная проверка права каждые 15 с** (`SIGNALS_RECHECK_MS`, 17): удалённый участник, удалённый чат или проект закрывают поток. SSE: `ping` каждые 15 с, клиент переподключается после 40 с тишины (`packages/trpc/src/trpc.ts:113-116`). Клиент — `splitLink` → `httpSubscriptionLink` для подписок (`apps/web/src/trpc/client.tsx:24-35`); маршрут — `/api/trpc` (`app/api/trpc/[trpc]/route.ts:38-64`, `fetchRequestHandler`, предел тела, отказ POST с чужого origin).
6. **Страница** — `useDialogFeed` (`apps/web/src/components/chat/use-dialog-feed.ts`): один читатель за раз, чтение по курсору (`createFeedReader`, 23-64); сигнал `feed`/`resync` → `reader.read()`, `activity` → `taskSignalBus.activity` для «Хода работы» (84-112, `task-signal-bus.ts:12-34`); скрытая страница не читается, при показе — сразу читается (120-133).
7. **Опрос — запасной путь** (`feed-state.ts:106-145`): без потока — 2 с в работе или с живым браузером, 15 с в ожидании, «Ход работы» — 1 с; при живом потоке — 15, 20 и 5 с; после сбоя пауза удваивается до 30 с; закончившийся чат не читается. Чтение `task.feed` отмечает присутствие (`markPresence`, `task.ts:419`): клиенту, который смотрит чат, уведомления не идут (план 75, ВВ7).

Числа из плана 86, §5 (замер на одноразовой PostgreSQL): строка ленты от фиксации до публикации сигнала в Redis — p50 57 мс, p95 60 мс (из них 50 мс — склейка); строка outbox до постановки в очередь с пробуждением — p50 9 мс.

### 5.2. Документ агента — живой только в своём чате

- Агент пишет раздел через MCP (`apps/mcp/src/pages`), `core` проверяет его на ключи хода и значения переменных пространства, пока ход идёт, раз в 1,5 с (`LIVE_DOC_CHECK_MS`, `apps/core/src/tasks/pass-runner.ts:40`; значения переменных перечитываются раз в 15 с, 42); прошедший раздел получает `checked_turn`, и `core` пишет строку `feed.doc_touch { docId, revision }` **в ленту чата, который писал** (`apps/core/src/tasks/doc-sections.ts:145-154`).
- Страница собирает последние ревизии из своих строк (`docRevisionsOf`, `agent-document.tsx:89-97`) и перечитывает `pages.doc`, когда ревизия выросла (`useAgentDocument`, 100-111). Без строки в своей ленте — ничего не перечитывается, кроме обычного устаревания кеша react-query (`staleTime` 30 с, `apps/web/src/trpc/query-client.ts:13`) при новом монтировании.
- Следствие: документ, который пишет чат Б, в чате А (где его начали) и в «Страницах» вживую не обновляется. Для артефакта, который правят несколько чатов и люди, канал по id чата не годится.

### 5.3. Кто может читать

- Каждая процедура кабинета — `consentedProcedure` (пользователь вошёл и принял документы). Чат — `accessibleTask(userId, id)`: задача не удалена, пользователь — участник её пространства, и либо у чата нет проекта, либо проект не в корзине и пользователь — его автор (`packages/trpc/src/services/chat/access.ts:10-18`; план 84, ПР1). Документ агента — участник пространства (`packages/trpc/src/services/pages.ts:303`).
- Приглашений в пространство в коде нет (поиск `invit` по `packages/trpc/src` и `apps/web/src` — только слово в тексте `components/billing/task-notice.ts`); на деле у пользователя одно личное пространство. «Зрителя из другого пространства» нет ни для чата, ни для документа. Единственный путь к чужому зрителю — опубликованные страницы: анонимно, на домене страниц, с паролем по желанию (план 69, 73).

---

## 6. Живой канал на артефакт: что нужно

### 6.1. Сигналы (минимум, на готовых частях)

| Слой | Что добавить | Образец |
| --- | --- | --- |
| БД | триггеры `AFTER INSERT/UPDATE` на таблицах артефакта → `pg_notify('raditi_artifact', '<artifact id>:<kind>')`, виды: `content` (новая ревизия или операция), `meta` (название, вид, состояние), `access` (грант выдан или снят); полезная нагрузка — только id и вид (< 8000 байт) | `20261118140000_task_signals/migration.sql` |
| domain | `ARTIFACT_SIGNAL_PG_CHANNEL`, виды, `artifactSignalChannel(id) = 'raditi:artifact:<id>'`, разбор | `packages/domain/src/tasks/task-signals.ts` |
| core | `TaskSignalRelay` слушает третий канал на том же соединении (`LISTEN raditi_artifact`), склейка 50 мс, публикация в Redis; `resync` общий | `task-signal-relay.ts:83-145` |
| web | подписчик Redis — по имени канала, а не по задаче (обобщить `createTaskSignals`), в контекст tRPC — `artifactSignals` | `apps/web/src/server/task-signals.ts:32-70`, `chat-services.ts:74` |
| tRPC | `artifact.signals({ artifactId })` (SSE) с проверкой `accessibleArtifact(userId, id)` при подключении и каждые 15 с; `artifact.read({ artifactId, after })` — ревизия и операции после курсора, при большом отставании — целиком | `services/chat/signals.ts:25-69`, `task.feed` |
| Страница | `useArtifactLive(id)`: один читатель, чтение по сигналу, опрос 15/20 с при живом потоке, скрытая страница не читается | `use-dialog-feed.ts` |

**Предел соединений.** Каждая подписка `httpSubscriptionLink` — отдельный `EventSource`. Без HTTP/2 браузер держит не больше 6 SSE-соединений на домен на все вкладки (MDN, §11). Страница чата уже держит `task.signals`; два-три открытых артефакта, две вкладки кабинета — и под HTTP/1.1 (`next dev` на `http://localhost:3000`) запросы tRPC начнут ждать. Production за Traefik по TLS, скорее всего, на HTTP/2 (до 100 потоков) — **на сервере не проверял**. Надёжнее — один поток на страницу: `signals({ taskIds?, artifactIds[] })` или общий подписчик в `SharedWorker`.

### 6.2. Запись: несколько агентов и человек

- **Проверка содержимого агента до показа другим** — уже обязательна для документов: текст агента видят только после проверки `core` на ключи хода и значения переменных (правило 2; план 74, Д2). Для артефакта: MCP пишет операцию «на проверке», `core` её проверяет (живой цикл `PassRunner` раз в 1,5 с или проверка прямо при записи), прошедшая операция становится ревизией → `NOTIFY` → зрители. Задержка «агент написал → видно» ≈ 1,5 с + 50 мс склейки + чтение. Роль `mcp` новых прав на это не получала — так устроены документы.
- **Конфликты** — серверная ревизия и `expectedRevision` у каждой записи (так «Терминал» правил файлы — `candidate.edit` с CAS; так публикация страниц — `expectedVersion`). Гранулярность: разделы/блоки с ключом (как `ChatDocumentSection.section_key` + `position`) — агенты и человек правят разные блоки без конфликта; для одного HTML-файла холста — операции «заменить фрагмент» с ревизией.
- **Кто правит сейчас**: у раздела уже есть `writtenTaskId`, `writtenTurn` (`schema.prisma:2571-2573`); для артефакта — автор операции (пользователь, чат и ход агента) → строка «Агент чата «…» правит раздел «…»» в шапке вкладки. Присутствие людей (кто смотрит) — эфемерно, через Redis (TTL), не в PostgreSQL.
- **Посимвольная совместная правка** (как в Google Docs) — CRDT (Yjs: документ + awareness для курсоров, §11). SSE для этого мало: нужен двусторонний канал (WebSocket). Образец в репозитории — шлюз трансляции браузера: второй слушатель `apps/preview` на 8091, одноразовый билет первым сообщением, точный `Origin`, перепроверка членства каждые 15 с (`apps/preview/src/browser-stream/browser-stream.ts`, `packages/trpc/src/routers/browser.ts:17-25`). Но агенту CRDT не нужен: агент пишет блоками через MCP, а CRDT-сервер должен ещё и прогонять проверку секретов — это существенно сложнее. Для первой очереди — блоки + ревизии + SSE.

### 6.3. Зритель — не владелец чата и не участник пространства

| Кто смотрит | Что нужно |
| --- | --- |
| Участник того же пространства, другой чат | только канал по id артефакта (§6.1) и список артефактов чата из связи «артефакт ↔ чат», а не из строк ленты этого чата |
| Автор проекта vs другой участник | проект — только автора (ПР1): артефакт проекта по умолчанию виден только ему; шеринг — явный грант |
| Пользователь платформы по ссылке | таблица грантов (артефакт, пользователь, право чтения/правки, кто выдал, срок, отозван); ссылка `…/artifacts/join/<token>` превращает токен в грант после входа и согласий; `accessibleArtifact` = владелец ∨ участник пространства (с учётом ПР1) ∨ действующий грант; та же проверка — в каждой процедуре и в подписке с перепроверкой 15 с, чтобы отозванный доступ закрывал поток |
| Аноним по ссылке (если владелец захочет) | `consentedProcedure` не подходит; варианты: отдельный маршрут web вне `(protected)` с токеном в адресе и своим SSE (`connectionParams` tRPC тоже идут в адресе — документация tRPC прямо предупреждает); или слушатель страниц `apps/preview` (8092) — но ему разрешена только PostgreSQL (правило `preview-minimal-packages`), значит, без Redis: опрос или свой `LISTEN` |

**HTML-артефакт со скриптами** (холст, интерактивная страница) нельзя показывать с origin кабинета. Сейчас страница в рамке — с корня домена страниц, `sandbox` без `allow-same-origin` (`PAGE_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'`, `packages/domain/src/pages/headers.ts:45`; `documents-pane.tsx:617-673`), а документ агента — `srcDoc` без скриптов (`agent-document.tsx:433-463`). CSP кабинета пускает в `frame-src` только `'self'`, капчу и домен страниц (`apps/web/src/lib/content-security-policy.ts:18-27`). Домен страниц — тот же сайт, что кабинет (`raditi.ru`): маршрут tRPC поэтому отклоняет POST с чужого origin (`route.ts:36-42`). Для артефактов: рамка с непрозрачным origin, `connect-src 'none'`, сообщения рамке — только `postMessage` с проверкой источника.

### 6.4. Нагрузка и надёжность

- Транзакции с `NOTIFY` фиксируются по одной; при 70 задачах незаметно, перед несколькими репликами и тысячами записей — замер (план 86, §4). Частые правки артефакта (набор текста человеком) не должны давать `NOTIFY` на каждую букву: сохранять пачкой (раз в 0,5–1 с) или склеивать на стороне web.
- Сигнал — подсказка: потерянный стоит времени до следующего опроса, повторный — одного чтения. Правильность — в чтении по ревизии/курсору, как у ленты.

---

## 7. «@» и ссылка на артефакт в поле

**Как работает сейчас.** «@» в начале поля или после пробела (`mentionAt`, `file-mentions.tsx:27-36`; адрес почты — не упоминание) открывает над полем список (`MentionList`, 139+): до 8 строк (`MENTION_ROWS`), сначала имена с этих букв, потом пути, потом остальное (`mentionMatches`, 53-86); Enter/Tab вставляют `@<root><path>` (`withMention`, 89-102: после файла пробел, после папки — нет); Escape закрывает. Список читается при первом «@» (`onOpen`), не раньше. Источник в чате и на «Новом чате» — `useContextMentions(projectId)` (`use-context-mentions.ts:38-89`): файлы контекста проекта (`/workspace/project/<имя>`) и пути основной ветки репозитория (`/workspace/repo/<путь>`), вместе — под корнем `/workspace/`. Без проекта — `undefined`, «@» — просто буква. Слова уходят как написаны, ничего не прикрепляется (план 78, У3). Поле — `textarea` (`composer.tsx:799`): «чипов» внутри текста нет; вложения — чипы над текстом (`AttachmentChips`, `composer.tsx:788-795`).

**Варианты для артефакта:**

| Вариант | Как | За | Против |
| --- | --- | --- | --- |
| А. Путь в песочнице | артефакты пространства/проекта кладутся в ход только на чтение, `/workspace/artifacts/<имя>.<расш>` (как `/workspace/project`, ПР8); в `useContextMentions` — третий источник под тем же корнем `/workspace/` | ноль нового разбора: путь понятен агенту сам; механизм склейки источников уже есть (56-71) | снимок на начало хода устаревает, пока другие правят; правка всё равно через MCP |
| Б. Токен, который разбирает `core` | вставка `@артефакт:<короткое имя>` (или `@«Название»`); планировщик хода находит токены в словах клиента и дописывает в инструкции: «клиент называет артефакт «…» (id …) — прочитайте его `artifact_read`» | живое состояние, без копий в песочнице; работает в Telegram (те же слова) | новый разбор и правило экранирования; токен виден в тексте |
| В. Чип через «+» | в меню «+» поля (`composer.tsx:860-920`, сейчас один пункт «Загрузить файл») — пункт «Артефакт…»: выбор кладёт чип над полем, `task.message` получает `artifacts: [id]`, строка `feed.request` хранит их, ход получает в инструкциях | как файлы: видно, что приложено; без синтаксиса | новое поле в схеме сообщения, очереди и Telegram |

Рекомендация: В для «приложить к сообщению» (поведение файлов) и Б для «сослаться в тексте»; А — только если артефакты всё равно нужно отдавать агенту файлами (например, HTML-холст для правки командами).

`ComposerMentions` (`composer.tsx:171-184`) держит один источник: `paths`, `root`, `texts`. Для групп «Файлы проекта» и «Артефакты» в одном списке нужно расширение до групп с подписью и своей вставкой — сейчас группы различаются только префиксом пути.

---

## 8. Telegram: что сегодня и что можно с артефактами

### 8.1. Сегодня (план 80, код)

- **Какие строки прохода идут в Telegram** — набор `TOLD` (`apps/core/src/telegram/telegram-jobs.ts:110-130`): ответ, вопрос, сбой, кандидат, отмена, `feed.file`, `feed.file_left`, `feed.page`, `feed.page_left`, `feed.doc_left`, память, репозиторий. **`feed.doc` и `feed.doc_touch` не идут**: о документе по разделам Telegram не узнаёт, пока что-то не отклонено.
- **Как сказано** — словами `/export` без строки «кто и когда» (`feedRowMarkdown`, `packages/domain/src/tasks/feed-markdown.ts:346-348`): `feed.file` — «Файл «имя»» (71, 263-264), `feed.page` — «Страница «название», версия vN» **без адреса** (267-268; `feedPageText`, `client-feed-labels.ts:439-440`), `feed.doc` в `/export` — «Агент пишет документ» (269-270, `client-feed-labels.ts:424`).
- **Кнопки** — в конце сообщения «Открыть в кабинете» → `APP_URL/chats/<taskId>` (`#chatLink`, 171-173; `deliver`, 380-389), у готовых изменений — «Посмотреть и выпустить»; при вопросе о кредитах — «Продолжить» (`go:<taskId>`).
- **Файлы не отправляются**: `sendDocument`/`sendPhoto` в `packages/telegram/src` и `apps/core/src/telegram` нет (поиск по коду). Рекомендация плана 80, §4 («файлы `/workspace/out` — документом до 50 МБ», «страницы и документы — ссылкой в кабинет») не сделана: ссылка ведёт на чат, а не на страницу или документ.
- **Длинный текст** режется на части по 4096 знаков HTML Telegram (`markdownToTelegramParts`, `packages/telegram/src/html.ts:160`); сообщение о ходе работы правится раз в 6 с (`progress-text.ts:9`).
- **Приём** — `core` опрашивает `getUpdates` через прокси (до сервера Telegram не доходит, план 80, §7) и отдаёт обновления web; файлы клиента скачиваются `getFile` до 20 МБ (`packages/telegram/src/api.ts:161, 346`) и становятся вложениями по правилам кабинета.
- **Правило 1**: исключение Т1 (решение владельца от 15.11.2026) — задания, файлы и ответы чата, привязанного к Telegram, идут через серверы Telegram; копия — в PostgreSQL и S3 в России. Содержимое артефакта — те же данные клиента: отправлять его в Telegram — в рамках Т1 только для чата, привязанного к Telegram, и для артефакта этого чата (иначе — новое решение владельца).

### 8.2. Что сейчас умеет Bot API (проверено 19.11.2026, core.telegram.org)

| Возможность | Факт | Источник |
| --- | --- | --- |
| Версия | Bot API 10.4 от 9 ноября 2026 | changelog |
| `sendMessage` | текст 1–4096 знаков после разбора разметки | bots/api |
| `sendDocument` | «files of any type of up to 50 MB» | bots/api |
| Rich Messages (10.1, 11.06.2026; блоки — 10.2) | `sendRichMessage`, `InputRichMessage` — ровно одно из `html`, `markdown`, `blocks`; до 32 768 знаков, до 500 блоков, до 50 медиа, таблицы до 20 столбцов, заголовки h1–h6, код, списки с задачами, цитаты, свёрнутые блоки, формулы | bots/api, changelog |
| Потоковые черновики | `sendMessageDraft` (0–4096 знаков) и `sendRichMessageDraft` — временный показ ≈30 с, пока ответ пишется; `can_stop`, `keep_on_stop` (10.3, 24.08.2026) | bots/api, changelog |
| HTML-виджеты (10.4) | `sendWidget`: один самодостаточный HTML с инлайн CSS и JS, ≤ 32 768 байт и ≤ 4096 байт после сжатия, без сети (`fetch`/`WebSocket` бросают ошибку), без внешних шрифтов и картинок; состояние пишет только бот (`editMessageWidgetData`, ≤ 1024 байт), нажатие — `widget_query` до 64 байт, ответ за 15 с; в production — **только личный чат с ботом**, содержимое защищено от пересылки | bots/widgets, changelog |
| Mini App | кнопка `web_app` открывает HTTPS-страницу бота — только в личных чатах с ботом; страницу загружает устройство пользователя с нашего сервера | bots/api |
| Копирование | кнопка `copy_text`, 1–256 знаков | bots/api |
| Темы в личном чате | `has_topics_enabled`, `is_topic_message`; в 10.4 — ссылки на темы личного чата | bots/api, changelog |

Не подтверждено: заметка от 15.11.2026 (rootdata.com), что Telegram запретил обычным ботам отправлять HTML-виджеты, — в официальном changelog 10.4 такого нет, там только «в production — только личные чаты».

### 8.3. Что можно сделать с артефактами (по возрастанию затрат)

1. **Строка и прямая ссылка.** Новый тип строки ленты об артефакте → в `TOLD`, слова — «Артефакт «…», v3» и кнопка «Открыть артефакт» на `APP_URL/artifacts/<id>` вместо общей «Открыть в кабинете». Заодно — дать `feed.page` адрес страницы (сейчас его нет).
2. **Текстовый артефакт целиком** — Rich Message (до 32 768 знаков, таблицы и код сохраняются) вместо нарезки по 4096; живое написание — `sendRichMessageDraft`. Потребует нового пути в `packages/telegram` (сейчас только HTML-сообщения).
3. **Файл** — `sendDocument` (≤ 50 МБ): `.md`, `.html`, `.xlsx`, `.docx` артефакта; так же — файлы `/workspace/out`, которых в Telegram сейчас нет вовсе.
4. **Просмотр внутри Telegram** — кнопка `web_app` на страницу артефакта (только личный чат). Вход — по данным Mini App (`initData`), привязанным к `channel_identities`; страницу загружает устройство клиента, а не серверы Telegram.
5. **Маленький интерактив** — `sendWidget` для крошечных артефактов (карточка с цифрами, мини-таблица, опрос): 4 КБ сжатого HTML и 1 КБ состояния — для холстов и лендингов мало.
6. **Правка из Telegram** — ответ на сообщение артефакта словами → обычное сообщение чата, агент правит через MCP; команды `/artifacts` (последние кнопками), `/share` — по образцу `/chats` и `/usage` (`packages/trpc/src/services/telegram/intake.ts`).

---

## 9. Для дизайнера: токены, размеры, компоненты

Единственный источник цвета — `packages/ui/src/theme/tokens.ts`; MUI публикует его как `--raditi-*` и роли палитры (`create-app-theme.ts`). Своих цветов в компонентах не задавать (DESIGN.md, «Colors»). Исключение в коде — светлый лист документа агента в обеих темах (`agent-document.tsx:169-200`).

### 9.1. Палитра кабинета (роли MUI)

| Роль | Светлая | Тёмная |
| --- | --- | --- |
| `background.default` (поле поля ввода, фон страницы ниже `md`) | `#FFF8EC` paper | `#241710` ink |
| `background.paper` (карточки, панели, шапка) | `#FFFCF5` card | `#352217` ink2 |
| Подложка под карточками от `md` (`cabinetGround`) | `#F3E7D5` paper2 | `#241710` ink |
| `text.primary` | `#241710` ink | `#FFF1DE` snow |
| `text.secondary` | `#695547` graphite | `#C6AE95` onInk |
| `divider` | `#E1CDB6` rule | `#5A3C28` ruleInk |
| `primary.main` / текст на нём | `#A63D12` accentText / `#FFFFFF` | `#FFB86B` accentLight / `#241710` |
| Залитая кнопка `contained primary` (обе темы) | фон `#FF6B24` accent, текст `#241710`, рамка 1 px `#A63D12`, наведение `color-mix(accent 65%, marker #FFC547)` | то же |
| `success` / `error` / `warning` / `info` | `#79573B` / `#9C3D26` / `#92551E` / `#A63D12` | `#D6B495` / `#F09B7C` / `#E6BA7E` / `#FFB86B` |
| `action.hover` / `action.selected` | ink 4 % / 8 % | snow 8 % / 16 % |
| Точки статуса (`statusDotColors`) | ok `#2E9F62`, waiting `#C77F0A`, broken `#D9482B`, off `#8C8072` | те же |
| Лист документа (не токены) | фон `#FBF7F1`, текст `#2A1D14`, ссылки `#8A5A26`, код `#EFE5D8`, линии `#E0D2BF` | тот же светлый лист |
| Контур элемента на светлом (`ruleStrong`) | `color-mix(graphite 70%, rule)` | — |

### 9.2. Шрифты

- Golos Text — текст и управление (`fontFamilies.body`); Unbounded — заголовки MUI h1–h6, 600 (`create-app-theme.ts:54, 89-94`); JetBrains Mono — моно (`overline`, исходники).
- Кабинет: заголовок раздела (`SectionHeading`) — 22/26/30 px (xs/sm/md, `section-heading.tsx:16`), шрифт h2 темы; название чата в шапке — h1 15 px/500, одна строка с многоточием (`dialog-view.tsx:285-297`); заголовок карточки ленты — 16 px/600 со значком 18 px (`feed-list.tsx:228-241`); текст ленты — 16 px; подпись рейки — 11/14 px, 500; вкладка панели — 14 px/400 (выбранная 500); плитка меню — 15 px, метка — 12,5 px/500 табличными цифрами.
- Документ в панели: 16 px/1,7, ширина строки 72ch, h1 30/700, h2 23/650, h3 19/600 (`documentSx`, `documents-pane.tsx:899-945`); лист документа агента — ширина 760, h1 28 (`agent-document.tsx:178-200`).

### 9.3. Формы и размеры (из кода)

| Элемент | Значение | Где |
| --- | --- | --- |
| Радиус по умолчанию MUI | 14 | `create-app-theme.ts:85` |
| Кнопки | пилюля 999, высота ≥ 44 (большая 52) | `create-app-theme.ts:117-134` |
| `Card` | `outlined`, радиус 22 | `create-app-theme.ts:139-142` |
| Рейка | 72 px (≥ `sm`), 56 (телефон); пункт 60×56 / 48×48, радиус 14 | `cabinet-shell.tsx:186-189`, `application-rail.tsx:126-133` |
| Панель «]» | 284 px (240–440, cookie `raditi-panel-width`), радиус 18, зазор 10 | `lib/cabinet-panel.ts:50-53, 80`, `cabinet-shell.tsx:32` |
| Карточка содержимого | радиус 18 от `md`; поля «Чатов» 16/20/32 px, сверху 24/28 | `chats-shell.tsx:81-82` |
| Полоса крошек | 64 px | `application-toolbar.tsx:44` |
| Шапка чата | 44 px (56 от `lg`) | `dialog-view.tsx:213` |
| Лента | колонка ≤ 780 по центру, промежуток 24/32 | `dialog-view.tsx:1444-1449` |
| Пузырь клиента | радиус 24, `action.selected`, поля 20×10 | `feed-list.tsx:370-410` (`BubbleView`) |
| Ответ агента | без пузыря и рамки, кнопка «Копировать» под ним | `feed-list.tsx:181-210` (`AgentMessage`) |
| Поле сообщения | радиус 28, заливка `action.hover`, без рамки, фокус — внутренняя линия 1 px; в строке слева «+» (вложения), «/» команды, «Размышление», справа «Отправить»/«Остановить»; контролы 44 px с нарисованной формой 32/36 | `composer.tsx:201-208, 696-713` |
| Панель инструментов | 440–760, радиус 18 (14 ниже `lg`), рамка `divider`, отступы от краёв окна 10 | `tools-panel.tsx:112-127`, `pane-layout.ts` |
| Полоса вкладок | 56; вкладка 44, радиус 12; × 32; «Скрыть панель» 44×44 радиус 12 | `tools-panel.tsx:34-50, 190-285` |
| «+» инструментов | 44×44, радиус 12, внутренняя рамка (отступ 4, радиус 10, `divider`); точка 14 px `primary.main` с обводкой 2 px `background.paper` | `tools-menu.tsx:231-279` |
| Меню «Инструменты» | карточка 500 (2 столбца) / 300, радиус 18, поле 16; плитка ≥ 52, радиус 12, `action.hover`; метка — пилюля 24 px | `tools-menu.tsx:48-107, 312-335` |
| Лист меню (ниже `lg`) | ≤ 560, радиус 24 сверху; плитка ≥ 92, радиус 16 | `tools-menu.tsx:66-80, 294-305` |
| Край панели | область 24 px, ручка 6×44 пилюлей, при наведении/фокусе `primary.main` | `pane-resizer.tsx:123-151` |
| Шапка «Документов» | кнопки 44×44 (значок 18), название в пилюле `action.hover` 14 px; оглавление 220 px | `documents-pane.tsx:277-375, 848-860` |
| «Результаты» | 280 px, отступ 24 | `results-card.tsx:22-28` |
| Строка документа в ленте | рамка `divider`, радиус 14, поля 14×10, «Открыть» — контурная пилюля 40 px | `feed-doc.tsx` |

Движение (`motionTokens`): `easeOut cubic-bezier(0.16, 1, 0.3, 1)`, `easeInOut cubic-bezier(0.65, 0, 0.35, 1)`, нажатие 90 мс, наведение 160 мс, смена состояния 240 мс. Индикатор работы — `BrandProgress` (`@repo/ui/brand-progress`): варианты `orbits` (подготовка), `spiral` (работа), `counterflow` (план 66, В12); при «уменьшить движение» стоит.

Значки — `AppIcon` (`app-icon.tsx`): пути 24×24, линия 1,7, скругления; есть `chat`, `timer`, `pages`, `projects`, `document`, `file`, `globe`, `image`, `layers`, `instructions`, `memory`, `share`, `download`, `fullscreen`, `shrink`, `paneHide`, `results`, `plus`, `close`, `back`, `more`, `pencil`, `trash`, `restore`, `upload`, `text`, `contents`, `copy`, `eye`, `lock`, `info`, `star`, `archive`, `pin`, `search`, `filter`, `sort`, `group`. Значка «артефакт/холст» нет.

### 9.4. Компоненты оболочки (имена для макетов)

| Компонент | Файл | Роль |
| --- | --- | --- |
| `CabinetShell` | `components/application/cabinet-shell.tsx` | каркас любой страницы: рейка, панель «]», карточка содержимого, рамка поверх краёв |
| `CabinetPanel`, `CabinetPanelProvider`, `PanelToggle` | `cabinet-shell.tsx:72-85`, `cabinet-panel.tsx` | панель рядом с рейкой от `md`, состояние в cookie `raditi-panel`, клавиша «]», кнопка «Скрыть/Показать панель» |
| `PanelResizer`, `PanelDrawer` | `panel-resizer.tsx`, `panel-drawer.tsx` | край панели «]»; ниже `md` — кнопка раздела и выдвижная панель слева 300 px |
| `ApplicationRail` | `application-rail.tsx` | рейка: знак, разделы, `CreditRing`, `UserMenu` |
| `ApplicationShell`, `ApplicationToolbar` | `application-shell.tsx`, `application-toolbar.tsx` | страница без панели; полоса крошек |
| `SectionHeading`, `SectionTabs` | `section-heading.tsx`, `section-tabs.tsx` | заголовок раздела с «i»; вкладки третьего слоя (ссылки с `aria-current`) |
| `ChatsShell`, `ChatsFrame`, `DialogList` | `components/chat/chats-shell.tsx`, `chats-frame.tsx`, `dialog-list.tsx` | «Чаты»: список-панель, «Создать», поиск, группировка, «Архив» |
| `DialogView`, `DialogHead` | `dialog-view.tsx` | чат: шапка, лента, поле, панель |
| `FeedList`, `LiveBlock`, `QueueCards`, `TurnActivity` | `feed-list.tsx`, `queue-cards.tsx`, `turn-activity.tsx` | лента, живой блок, очередь, «Ход работы» |
| `Composer` | `composer.tsx` | поле сообщения |
| `ToolsMenu`, `ToolsPanel`, `PaneResizer` | `tools-menu.tsx`, `tools-panel.tsx`, `pane-resizer.tsx` | «+», меню, панель справа, её край |
| `BrowserPane` | `browser-pane.tsx` | вкладка «Браузер» |
| `DocumentsPane`, `AgentDocumentView`, `DocumentWindow` | `documents-pane.tsx`, `agent-document.tsx`, `document-window.tsx` | вкладка «Документы», документ по разделам, документ в своей вкладке |
| `ResultsCard`, `ResultsToggle` | `results-card.tsx` | «Результаты» |
| `FeedDoc`, `FeedFile`, `FeedPage` | `feed-doc.tsx`, `feed-file.tsx`, `feed-page.tsx` | строки ленты о документах, файлах, страницах |
| `PagesView`, `PageActionsMenu` | `components/pages/*` | «Страницы» |
| `ProjectsView`, `ProjectView` | `components/projects/*` | «Проекты», страница проекта с колонкой |
| `BrandMark`, `BrandProgress` | `@repo/ui` | знак, индикатор работы |

### 9.5. Где `DESIGN.md` отстаёт от кода (для макетов брать код)

| `apps/web/DESIGN.md` | Код |
| --- | --- |
| поле: рамка `ruleStrong`, радиус 22 px; «скрепка «Прикрепить файлы»» | радиус 28, без рамки, заливка `action.hover` (`composer.tsx:703-704`); «+» первым в строке (запрос владельца от 19.11.2026, `composer.tsx:201-208, 869`) |
| «Enter — новая строка, Ctrl+Enter — отправка» | Enter отправляет, Shift+Enter — новая строка (план 64, §6) |
| пузырь клиента — заливка `text.primary`, радиус 14 с острым углом 4 px | `action.selected`, радиус 24 (`feed-list.tsx:370-410`) |
| у карточек ленты «линия `divider` и радиус 14» | `Card` ленты без рамки (`feed-list.tsx:214-249`) |
| «К диалогу», «Назад к диалогам» | «К чату», «К чатам» (`chat-texts.ts:376, 787`) |

### 9.6. Схемы (по коду; размеры — §2.4, §9.3)

Чат с открытой вкладкой «Артефакты», окно 1440, список чатов открыт:

```
┌72┐┌──── 284 ────┐  ┌──────── 434 ─────────┐  ┌────────────── 620 ──────────────┐
│ ✳ ││ Чаты  ⌕ ⇵ ] ││ ] Название чата  ⋯   │  │[Браузер ×][Документы ×][Артеф.×] ⇥ +│ ← 56
│   ││ [ + Создать ]││                      │  ├─────────────────────────────────┤
│Чат││ ▸ чат 1      ││  лента ≤ 780 (370)   │  │ «Все (5)» [Лендинг кофейни v3 ▾]│ ← шапка 52
│Зад││ ▸ чат 2      ││  …                   │  │  ⟳  ⤢  ↗  ⤓  ⇪   ● Агент пишет │
│Стр││              ││                      │  ├─────────────────────────────────┤
│Арт││              ││  ┌────────────────┐  │  │                                 │
│Про││              ││  │ Сообщение…  ⏎ │  │  │   рамка артефакта / редактор    │
│ ◔ ││ Архив        ││  │ + /  🧠       │  │  │                                 │
│ ◯ │└─────────────┘│  └────────────────┘  │  └─────────────────────────────────┘
└───┘                └──────────────────────┘   ↑ край тянется (440…760)
```

Телефон 390, инструмент открыт (рейки нет):

```
┌────────────── 358 ──────────────┐
│ ← К чату                      + │ 56
├─────────────────────────────────┤
│ [Документы ×][Артефакты ×]      │ 56 (прокрутка вбок)
├─────────────────────────────────┤
│ «Все (5)»  Лендинг кофейни  ⋯   │
│                                 │
│   артефакт во всю ширину        │ ≥ 480 высоты
│                                 │
└─────────────────────────────────┘
```

Раздел `/artifacts` (вариант со списком в панели «]»), окно 1440:

```
┌72┐┌──── 284 ────┐┌────────────────────── содержимое ───────────────────────┐
│   ││ Артефакты ] ││ Лендинг кофейни   v3 ▾   Просмотр | Правка   Поделиться │
│   ││ ⌕ Найти      ││──────────────────────────────────────────────────────────│
│   ││ Мои  Проект  ││                                                          │
│   ││ Доступные    ││            артефакт: рамка / текст / таблица              │
│   ││ ▸ Лендинг    ││                                                          │
│   ││ ▸ Смета      ││──────────────────────────────────────────────────────────│
│   ││ ▸ Схема      ││ Обсудить в чате · Открыть в чате «…» · Версии · Доступ   │
└───┘└─────────────┘└──────────────────────────────────────────────────────────┘
```

---

## 10. Риски и вопросы владельцу

1. **Одна вкладка или вкладка на артефакт** (§3.1, §3.2) — по ширине рекомендую одну с переключателем внутри.
2. **«Документы» и «Артефакты» — одно или два** (§3.3): документы агента уже принадлежат пространству и пишутся из любого чата; две похожие вкладки и две плитки «+» путают.
3. **Подпись в рейке** — «Артефакты» не помещается в 60 px (60,5) (§4.1); место пункта в рейке.
4. **Открывается ли вкладка «Артефакты» сама**, как «Документы» (от `lg`, один раз за показ), или только по «+» (план 59: «только по явному запросу», исключения — браузер и документы).
5. **Шеринг — пользователям платформы (вход и согласия) или и анонимам** (§6.3); срок и отзыв ссылки; право «читать» и «править».
6. **Совместная правка: блоками с ревизиями (SSE) или посимвольно (CRDT, WebSocket)** (§6.2).
7. **Telegram**: какой из путей §8.3 нужен; отправка содержимого артефакта в Telegram — в рамках Т1 только для чата, привязанного к Telegram.
8. **Найденное по ходу (вне артефактов)**: опора «Документы пришли» по первой странице ленты (§2.3); `feed.page` в Telegram без адреса и файлы `/workspace/out` в Telegram не отправляются (§8.1); `DESIGN.md` отстаёт от кода (§9.5).

---

## 11. Источники (внешние, проверены 19.11.2026)

- Telegram Bot API — https://core.telegram.org/bots/api (Bot API 10.4; `sendMessage` 1–4096 знаков; `sendDocument` «up to 50 MB»; `web_app` — только личные чаты; `copy_text` 1–256; `sendMessageDraft`, `sendRichMessage`, `sendRichMessageDraft`, лимиты Rich Messages).
- Telegram Bot API changelog — https://core.telegram.org/bots/api-changelog (10.0 — 08.05.2026, 10.1 — 11.06.2026 Rich Messages, 10.2 — 14.07.2026, 10.3 — 24.08.2026, 10.4 — 09.11.2026 `sendWidget`: «Currently, in the production environment, widgets can be sent only to private chats»).
- Telegram Widgets — https://core.telegram.org/bots/widgets (32 768 байт HTML, 4096 байт сжатого, без сети, состояние ≤ 1024 байт, `widget_query` ≤ 64 байт, ответ за 15 с; дата на странице не указана).
- Сообщение об ограничении виджетов — https://www.rootdata.com/news/829936 (15.11.2026; **не подтверждено** официальными источниками).
- tRPC `httpSubscriptionLink` — https://trpc.io/docs/client/links/httpSubscriptionLink (SSE, cookies на том же домене, `connectionParams` идут в адресе, `reconnectAfterInactivityMs`, `ping`; ссылки страницы ведут на `/docs/v11/`).
- PostgreSQL `NOTIFY` — https://www.postgresql.org/docs/current/sql-notify.html (страница PostgreSQL 18.7; в проекте PostgreSQL 17 — текст о пределе 8000 байт, доставке после фиксации и склейке тот же, по моему знанию прежних версий; сверял только страницу 18.7).
- MDN `EventSource` — https://developer.mozilla.org/en-US/docs/Web/API/EventSource (без HTTP/2 — 6 SSE-соединений на браузер и домен; HTTP/2 — по умолчанию 100 потоков).
- Yjs awareness — https://docs.yjs.dev/api/about-awareness; y-websocket — https://github.com/yjs/y-websocket (версии не сверял: **не подтверждено**).

Внутренние источники — файлы и строки в тексте; поведение production (HTTP/2 за Traefik, длина чатов) — из плана 86 и CLAUDE.md, на сервере не проверял.
