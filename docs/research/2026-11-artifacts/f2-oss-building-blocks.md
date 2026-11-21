# f2. Строительные блоки и эталонные реализации видов артефактов (19.11.2026)

*Исследование-продолжение к разделу «Артефакты». Файлы репозитория не менялись. Версии, лицензии и зависимости — реестр npm (`registry.npmjs.org/<пакет>/latest`); даты выпусков — deps.dev (`api.deps.dev/v3/systems/npm/packages/<пакет>`); размеры — bundlephobia (`bundlephobia.com/api/size?package=<пакет>@<версия>`: gzip всей точки входа вместе с зависимостями, без вычета общих с кабинетом React и MUI); размеры файлов сборок и наличие локалей — список файлов jsDelivr (`data.jsdelivr.com/v1/packages/npm/<пакет>@<версия>?structure=flat`); даты коммитов и выпусков GitHub — ленты `github.com/<репо>/commits.atom` и `/releases.atom`. Всё прочитано 19.11.2026. Код эталонных приложений и пакетов читался как текст (raw.githubusercontent.com и тарболы npm), ничего скачанного не запускалось. Одна локальная проверка — круг Markdown → mdast → Markdown на пакетах, уже установленных в `node_modules` основной копии репозитория (§2a, скрипт — (локальные копии сессии исследования)). Под конец работы исчерпан лимит веб-поиска сессии: пункты, которые остались без проверки, собраны в разделе «Не подтверждено». Не повторяю r6 §1–§3 (Yjs, Hocuspocus, Automerge, Loro, ShareDB, ProseMirror collab, Tiptap AI Toolkit, BlockNote AI, tldraw), r7 §2 (описание видов), r5 §3 (UX холстов) и c1 §6, §17 (CSP) — ссылаюсь на них.*

Обозначения в таблицах: ✓ — да; ✗ — нет; н/п — не подтверждено; «каб.» — компонент работает в кабинете, песочный кадр ему не нужен; «Размер» — gzip по bundlephobia; «Кадр» — работает ли внутри непрозрачного `sandbox`-кадра с политикой кадра кабинета (`script-src 'unsafe-inline'` без `'self'`, `connect-src 'none'`, `worker-src 'none'`, картинки и шрифты только `data:`/`blob:` — `packages/domain/src/pages/headers.ts:27,30,33-38,63-67`); «Ревизии» — можно ли сохранять правки операциями с ревизией блока, без CRDT.

---

## 0. Коротко

- **Готовой реализации под нашу модель нет.** Vercel Chatbot (Apache-2.0) хранит версию документа строкой целиком и правит по первому вхождению без проверки ревизии; LibreChat (MIT) и Open WebUI держат артефакт внутри текста сообщения; Open Canvas — массив целых версий. Брать — реестр видов «серверный обработчик + клиентское описание», предложения правок, привязанные к версии и цитате, MIME-типы с алиасами, окно «Открыть отдельно». Избегать — Sandpack и любой внешний сборщик или CDN, `srcdoc` с `allow-same-origin` (у Open WebUI в 2026 году серия CVE ровно об этом), Pyodide в окне приложения (Vercel), историю, которую ручная правка перезаписывает на месте.
- **Документ:** Tiptap 3.34.0 (MIT, 13.11.2026) + `@tiptap/markdown` + `@tiptap/extension-unique-id` + `mui-tiptap` 1.31.0 (MIT, MUI ^9). Редактор на раздел, хранение — Markdown, канонизированный на сервере тем же remark, что рисует `@repo/doc-render`. Локальная проверка: круг через mdast сохраняет «», „“, —, …, NBSP и ё, но перерисовывает таблицы, меняет маркер `-` на `*` и экранирует `_` и `*`; с `bullet: '-'` и `tablePipeAlign: false` остаются экранирование и нормализация строки разделителя. Запасной вариант — Milkdown 7.23.0 (сам на remark, есть `@milkdown/plugin-diff` «принять/отклонить»), но готовый Crepe тянет Vue.
- **Таблица:** MUI X Data Grid 9.18.0 MIT — единственная сетка с родной темой MUI 9 и `ruRU`. Ограничения MIT проверены в коде пакета: страница не больше 100 строк (исключение), одна сортировка и один фильтр, перестановки столбцов нет; вставка из буфера, Excel и формулы (только синтаксис en-US) — Premium. Запасные — TanStack Table 9.3.1 + Virtual (MIT, без пределов, но вёрстка наша) или AG Grid Community 36.3.0 (MIT, своя тема). Формул в v1 нет: HyperFormula — GPL-3.0 или проприетарная лицензия; деньги считать `decimal.js` на сервере (правило 9). exceljs не выпускался в npm с 19.10.2023, SheetJS CE 0.20.3 раздаётся только с `cdn.sheetjs.com`, живые — `write-excel-file` и `read-excel-file`.
- **Холст:** доска `@xyflow/react` 13.0.2 (MIT, 17.11.2026; на ней же доска кадров Onlook 2.0) или простой CSS-трансформ. Живой кадр — только выбранный, остальные — PNG-миниатюры от Chromium на сервере (он уже есть в `apps/browser`). Прямые правки — сервер ставит элементам `data-…`-id и правит исходник по смещениям `parse5` (`sourceCodeLocationInfo`), живой DOM обратно не сериализуется. Так устроены и «теггеры» Lovable и Dyad, только для JSX. GrapesJS, Puck и VvvebJs не подходят: у них своя модель документа, и редактор работает с DOM кадра того же источника.
- **Схема:** Mermaid 12.3.0 (MIT; с 12.0.0 от 10.09.2026 раскладка ELK по умолчанию, IIFE — 5,5 МБ) нельзя исполнять в кабинете: на странице бюллетеней проекта 10 записей 2025–2026 годов (XSS, HTML- и CSS-инъекции, загрязнение прототипа, зависания). Вписать его в кадр тоже нельзя. Рисовать на сервере: `beautiful-mermaid` 1.1.3 (MIT, без DOM, 6 видов диаграмм), иначе Mermaid в Chromium с таймаутом; SVG пропускать через DOMPurify и показывать как `<img>`.
- **Презентация:** слайд — кадр 1280×720, механика Холста; показ — reveal.js 6.0.2 (MIT, с 6.0 есть официальная обёртка React); PDF — Chromium; PPTX — картинкой на слайд через `pptxgenjs` 4.0.1. Marp даёт PPTX тоже картинками, а правимый — только экспериментально, через LibreOffice. Slidev — сервер разработки на Vue, не встраивается.
- **Отчёт с графиками:** графики — JSON-спецификация (подмножество опций ECharts, схема zod), SVG рисует сервер: ECharts 6.1.0 (Apache-2.0, `renderToSVGString` без DOM, `langRU`). Запасной — Vega-Lite 6.5.0: под нашим CSP ему нужен `vega-interpreter`, потому что по умолчанию Vega строит функции через `Function`.
- **Экспорт:** PDF, PNG и миниатюры — один серверный рендер на Chromium (Playwright 1.63.0 в каталоге репозитория; с Chrome 131 есть поля страницы `@top-center`). DOCX — `docx` 9.16.0 (MIT, выпуск 19.11.2026) из mdast. PPTX — `pptxgenjs`. XLSX — `write-excel-file` (или SheetJS CE с переносом файлов к себе). Клиентские снимки (`html-to-image`, `modern-screenshot`, `snapdom`) видят только свой документ: в нашем кадре сеть закрыта, скачивание запрещено (нет `allow-downloads`), а кабинет не видит содержимого непрозрачного кадра. Paged.js стоит на 0.4.3 от 06.07.2023.
- **Ловушки CSP и источника, которые меняют выбор:**
  1. Кадр кабинета сейчас пускает только встроенные скрипты (`headers.ts:63-67`). Библиотека из списка платформы требует `'self'` и фиксированного пути на хосте страниц, а там сейчас отвечает только `/v/<token>` (`apps/web/src/lib/pages-origin.ts:12`).
  2. Из непрозрачного источника шрифты `@font-face` и модульные скрипты идут CORS-запросом (MDN): нужен `Access-Control-Allow-Origin` и `Cross-Origin-Resource-Policy: cross-origin`. Общие файлы сайтов страниц ставят CORP `cross-origin` (`packages/domain/src/pages/files.ts:91-110`), а ACAO — нет. Отсюда гипотеза: шрифт из `/_files/` на опубликованной странице не загрузится.
  3. Хост страниц — тот же сайт, что кабинет, поэтому кадры, вероятно, живут в процессе кабинета. Десяток живых макетов или зависший скрипт тормозят сам кабинет (не измерено).
- **В коде репозитория** нет ни одной сетки, графика, диаграммы, редактора или экспортёра. `@repo/doc-render` — это `react-markdown` 10.1.0 и `remark-gfm` 4.0.1, график «Использования» нарисован на `Box` MUI. Chromium есть в трёх местах: `apps/browser`, образ песочницы и браузерный образ предпросмотра. `python3-docx` и `python3-openpyxl` есть в образе песочницы, `sharp` (растеризация SVG) — в web.

---

## 1. Эталонные реализации

### 1.0 Сводка

| Проект | Лицензия | Выпуск / коммит | Виды | Модель данных | Инструменты агента | Взять | Избегать |
|---|---|---|---|---|---|---|---|
| Vercel Chatbot (бывший `vercel/ai-chatbot`, теперь `vercel/chatbot`) | Apache-2.0 | v3.1.0 — 03.07.2025; последний коммит — 03.11.2026 | `text`, `code`, `sheet`; `image` есть в перечне БД и на клиенте | `Document` с ключом `(id, createdAt)`: версия — строка с целым содержимым; `Suggestion` ссылается на `(documentId, documentCreatedAt)` | `createDocument {title, kind}`, `updateDocument {id, description}` (полная перепись вложенным вызовом модели), `editDocument {id, old_string, new_string, replace_all?}`, `requestSuggestions {documentId}` | реестр видов (серверный обработчик + клиентское описание: `content`, `actions`, `toolbar`, `initialize`, `onStreamPart`), переключатель версий и вид «разница», предложения с `originalText`/`suggestedText`, ответ модели без содержимого («now visible to the user»), проверка владельца в каждом инструменте | замену первого вхождения без проверки ревизии, перезапись последней версии при ручной правке, полную перепись, CSV как хранилище таблицы, Pyodide с CDN в окне приложения |
| LibreChat (`LibreChat-AI/LibreChat`) | MIT | v0.8.9 — 17.11.2026 | `text/html`, `application/vnd.react`, `image/svg+xml`, `application/vnd.mermaid`, `text/markdown`, `application/vnd.code`, `text/plain`, просмотр Office-файлов | артефакт — фрагмент текста сообщения; ключ `identifier_type_title_messageId` | инструмент Artifacts в конструкторе агента (режимы default, shadcn/ui, custom); директива `:::artifact{identifier type title}` | реестр MIME-типов с алиасами (`application/vnd.ant.react` → React), вкладки «Просмотр/Код», окно «Открыть отдельно» с живым потоком, пометка `.preview` у правленых загрузок | Sandpack: сборщик с `*.codesandbox.io` с телеметрией, React-превью тянут `cdn.tailwindcss.com`; артефакт внутри сообщения |
| Open WebUI | Open WebUI License (BSD-3 с запретом менять бренд при >50 пользователях за 30 дней) | v0.13.4 — 17.11.2026 | HTML/CSS/JS из блоков кода, SVG | версии — последовательные блоки кода в разговоре («Version N of M») | нет | шаг по версиям, полноэкранный режим | `srcdoc` с CSP через `<meta>`; флажок `allow-same-origin` у пользователя; серия CVE 2026 года о кадрах с `allow-scripts` + `allow-same-origin` |
| bolt.diy | MIT | v1.0.3 — 15.11.2026 | файлы проекта, команды | `<boltArtifact id title>` с `<boltAction type="file" filePath>`, `shell`, `start`, `build`, `supabase` в тексте ответа | разметка в потоке, не вызовы | потоковый разбор тегов: «пишется файл …» видно до конца ответа | WebContainers, артефакт как список файлов |
| Open Canvas (LangChain) | MIT | последний коммит — 25.02.2026 | `text` (Markdown), `code` | `ArtifactV3 {currentIndex, contents[]}` — массив целых версий | узлы графа LangGraph: переписать выделенное, быстрые действия | правка выделенного (`TextHighlight {fullMarkdown, markdownBlock, selectedText}`), пользовательские быстрые действия, память стиля `Reflections {styleRules, content}` | целые версии, отсутствие блоков; проект почти не развивается |
| LobeHub | LobeHub Community License (Apache-2.0 + производные только с коммерческой лицензией) | коммиты — 19.11.2026 | React, HTML, SVG, Mermaid | тег `<lobeArtifact identifier type title>` в ответе (по сторонней копии системного промпта — н/п) | — | только идеи | код брать нельзя |

### 1.1 Vercel Chatbot — как устроено (код ветки `main` на 03.11.2026)

- **Имя и состав.** README: «Chatbot (formerly AI Chatbot) is a free, open-source template built with Next.js and the AI SDK». `package.json` — версия 3.1.0; зависимости: `ai` 7.0.15, `@ai-sdk/react` 4.0.16, `next` 16.2.10, `react` 19.2.7, ProseMirror (`prosemirror-markdown` ^1.13.4 и другие), CodeMirror 6, `react-data-grid` 7.0.0-beta.47, `papaparse` ^5.5.4, `diff-match-patch` ^1.0.5, `drizzle-orm` ^0.45.2.
- **Виды.** `artifactKinds = ["text", "code", "sheet"]` (`lib/artifacts/server.ts:95`); перечень в БД — `text | code | image | sheet` (`lib/db/schema.ts:79`). Клиент `artifacts/image/client.tsx` есть, серверного обработчика у него нет.
- **Хранение версий.**
  - `Document` с первичным ключом `(id, createdAt)` (`schema.ts:73-90`): каждая версия — новая строка с целым `content`.
  - `saveDocument` делает `INSERT` новой версии (`lib/db/queries.ts:310-340`).
  - Ручная правка с `isManualEdit` идёт в `updateDocumentContent` — `UPDATE` последней строки на месте (`queries.ts:342-375`, `app/(chat)/api/document/route.ts:94-97`): история ручных правок не хранится.
  - «Вернуться к версии» — `DELETE ?timestamp`, удаляет все более поздние версии и их предложения (`queries.ts:405-429`).
- **Предложения.** `Suggestion {originalText, suggestedText, description, isResolved}`; внешний ключ — `(documentId, documentCreatedAt)`, то есть предложение привязано к версии (`schema.ts:94-116`).
  - `requestSuggestions` вызывает модель со структурированным выводом — до 5 элементов `{originalSentence, suggestedSentence, description}` (`lib/ai/tools/request-suggestions.ts:42-56`). Каждое готовое предложение уходит частью потока `data-suggestion` (83-87), все сохраняются пакетом в конце (97-104).
  - В редакторе предложение находится по `indexOf(originalText)` в текстовых узлах ProseMirror (`lib/editor/suggestions.tsx:16-37`) — по первому вхождению.
  - Исправление от 03.11.2026: «Check document ownership before returning suggestions (#1562)».
- **Инструменты.**
  - `createDocument` (`lib/ai/tools/create-document.ts:22-89`): `inputSchema {kind, title}`. Содержимое пишет вложенный `streamText` обработчика вида (`artifacts/text/server.ts:6-31`), основная модель его не видит. Ответ модели — `{id, title, kind, content: "A document was created and is now visible to the user."}`.
  - `editDocument` (`edit-document.ts:12-100`): `{id, old_string, new_string, replace_all?}`. Проверка — только `includes`, замена — `String.replace` первого вхождения (35-37). Ревизии нет; уникальность цитаты не проверяется, хотя описание просит «Include 3-5 surrounding lines for uniqueness».
  - `updateDocument` (`update-document.ts:14-77`) — полная перепись по `description`; старое содержимое уходит в системный промпт вложенного вызова.
- **Поток в правую панель.** Части потока UI с `transient: true`, то есть не в истории сообщения:
  - служебные: `data-kind`, `data-id`, `data-title`, `data-clear`, `data-finish` (`create-document.ts:28-50, 69`);
  - содержимое: `data-textDelta` дописывается к тексту (`artifacts/text/server.ts:19-27`, клиент `artifacts/text/client.tsx:136-140`), `data-sheetDelta` каждый раз несёт весь CSV целиком (`artifacts/sheet/server.ts:17-25`);
  - разбор на клиенте: `DataStreamHandler` раздаёт части `onStreamPart` нужного вида (`components/chat/data-stream-handler.tsx:25-87`).
  - Документация шаблона описывает старый API `dataStream.writeData({type: 'content-update'})` ([chatbot.ai-sdk.dev](https://chatbot.ai-sdk.dev/docs/customization/artifacts)) — она отстаёт от кода.
- **Клиентское описание вида.** Класс `Artifact` (`components/chat/create-artifact.tsx:56-110`): `kind`, `description`, `content` (компонент с `mode: "edit" | "diff"`, `currentVersionIndex`, `onSaveContent(content, debounce)`, `getDocumentContentById`), `actions` (кнопки шапки, контекст `handleVersionChange("next" | "prev" | "toggle" | "latest")`), `toolbar` (может `sendMessage`), `initialize`, `onStreamPart`.
- **Код.** Кнопка «Run» вызывает `loadPyodide({indexURL: "https://cdn.jsdelivr.net/pyodide/v0.23.4/full/"})` в окне приложения (`artifacts/code/client.tsx:118-120`); скрипт подключён `next/script` в `app/(chat)/layout.tsx:15-16`. Python модели исполняется с правами страницы: у Pyodide есть мост к JS страницы, модуль `js` (общеизвестное свойство Pyodide, в этой работе не перепроверено).

### 1.2 LibreChat

- **Как модель создаёт артефакт** ([docs](https://www.librechat.ai/docs/features/artifacts)). Инструмент Artifacts добавляют агенту в Agent Builder; режимы — Normal, shadcn/ui и Custom. В режиме Custom модель обёртывает блок кода в `:::artifact{identifier="…" type="…" title="…"}`; клиент разбирает это плагином remark-directive (`client/src/components/Artifacts/Artifact.tsx:14-37`).
- **Ключ и правка.** Ключ артефакта — `${identifier}_${type}_${title}_${messageId}` (`Artifact.tsx:71-73`). Правка пользователя во вкладке «Код» сохраняется обратно в сообщение (docs).
- **Показ.**
  - Sandpack: шаблон `static` для HTML, SVG, Markdown, кода и Office-превью, `react-ts` — для React (`client/src/utils/artifacts.ts:24-71`).
  - Адреса сборщиков — `bundlerURL` и `staticBundlerURL` (336-349). По умолчанию сборщик берётся с публичного CDN CodeSandbox, который шлёт телеметрию.
  - Своя копия — форк `LibreChat-AI/codesandbox-client` и переменные `SANDPACK_BUNDLER_URL`, `SANDPACK_STATIC_BUNDLER_URL`. Если задана одна, остальные виды идут с публичного CDN.
  - React-превью нужен `cdn.tailwindcss.com`; в `frame-src` — `https://*.codesandbox.io` ([config](https://www.librechat.ai/docs/configuration/artifacts)).
  - Mermaid по документации рисуется в самой странице, хотя в коде остался и путь через Sandpack с `mermaid ^11.4.1` (`artifacts.ts:274-291`).
- **Типы.** Список `TOOL_ARTIFACT_TYPES` (`artifacts.ts:436-452`) и алиасы `application/vnd.ant.react`, `application/vnd.code-html`, `image/svg`, `mermaid` (554-566) — похоже на совместимость с форматом артефактов Claude.
- **Чего нет.** Ссылки для шеринга артефакта в документации нет.
- **Для нас.** Sandpack не подходит:
  - внешний сборщик и CDN запрещены условием задачи;
  - сборщик ходит в сеть за пакетами npm и, по устройству CodeSandbox, работает через воркеры (н/п), а у нас `connect-src 'none'` и `worker-src 'none'`.

### 1.3 Open WebUI

- **Модель.** Артефакты — это блоки HTML, CSS и JS из сообщений, собранные в один кадр; версии — следующие блоки («Version {{selectedVersion}} of {{totalVersions}}», `src/lib/components/chat/Artifacts.svelte:108-128`).
- **Кадр.** `<iframe srcdoc={injectCsp(…, $config?.ui?.iframe_csp)}>`, флажки песочницы — из настроек пользователя (`Artifacts.svelte:174-192`):
  - `allow-scripts`, `allow-downloads`, `allow-forms` — по умолчанию включены;
  - `allow-same-origin` — по умолчанию выключен, но доступен пользователю.
  - Скачивание — Blob `text/html` (89-99).
- **Чем закончилось.** Бюллетени 2026 года: кадры с `allow-scripts` + `allow-same-origin` давали XSS с захватом учётной записи. CVE-2026-70486 — просмотр файла терминала, исправлено в 0.11.0 ([GitLab advisory](https://advisories.gitlab.com/pypi/open-webui/CVE-2026-70486/)); CVE-2026-87995 — просмотр порта, 0.8.11–0.11.1 ([corgea](https://corgea.com/advisories/vulnerabilities/CVE-2026-87995)); CVE-2026-26193 — встроенные объекты чата, исправлено в 0.6.44, и там админская настройка игнорировалась ([GitLab advisory](https://advisories.gitlab.com/pypi/open-webui/CVE-2026-26193/)); CVE-2026-45303 — HTML-просмотр ([SentinelOne](https://www.sentinelone.com/vulnerability-database/cve-2026-45303/)). Детали взяты из выдержек бюллетеней; сами бюллетени целиком не читались.
- **Урок.** Правило «без `allow-same-origin` у HTML агента» нужно держать в одном месте кода, а не в каждом компоненте кадра: у Open WebUI исправления шли по одному пути за раз.

### 1.4 Другие

- **bolt.diy.** Потоковый разбор `<boltArtifact` и `<boltAction` (`app/lib/runtime/message-parser.ts:6-9`). Типы действий — `file`, `shell`, `start`, `build`, `supabase` (`app/types/actions.ts:10-27`). Нам полезна только идея показывать «агент пишет файл/блок» по ходу потока: r6 §8.6 называет то же самое для аргументов вызова.
- **Open Canvas.** Типы `ArtifactMarkdownV3 {index, type: "text", title, fullMarkdown}`, `ArtifactCodeV3 {…, language, code}`, `ArtifactV3 {currentIndex, contents[]}`, `CodeHighlight {startCharIndex, endCharIndex}`, `CustomQuickAction {title, prompt, includeReflections, includePrefix, includeRecentHistory}`, `Reflections {styleRules[], content[]}` (`packages/shared/src/types.ts:101-170`).
- **Onlook 2.0** (Apache-2.0; 17.11.2026 — «the desktop editor replaces v1»). Приложение на Electron; доска живых кадров на React Flow, «Mobile, tablet, and desktop frames side by side». Экспорт — HTML, PNG и JPEG через Electron `capturePage`, PDF через `printToPDF` и `pdf-lib` (README, «Our Tech Stack»). Это подтверждает связку «React Flow + живые кадры + рендер браузером».
- **e2b fragments** (Apache-2.0, коммит 13.10.2026) запускает сгенерированное в облачных песочницах E2B: внешний SaaS, нам не подходит по правилу 1.

### 1.5 Что из этого следует для модели данных

У всех четырёх «живых» проектов версия — это целое содержимое (строка БД, элемент массива или блок кода сообщения). Правка агента — либо полная перепись, либо замена по цитате без проверки ревизии. Блоки с ревизией, аренда и журнал операций (r6 §8) — шаг дальше любого из них. Взять стоит только интерфейсные договорённости: реестр видов, части потока на каждый вид, режим «разница», предложение как пару «было → стало» с привязкой к версии.

---

## 2. Блоки по видам

### 2a. Редактор Markdown с точным кругом

| Пакет | Версия, дата | Лицензия | React 19.3 | MUI 9 | Размер | SSR | Касание | Доступность | RU | Кадр | Ревизии |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Tiptap 3 + `@tiptap/markdown` + `mui-tiptap` | 3.34.0 (13.11.2026); `@tiptap/markdown` появился в 3.7.0 (14.10.2025); `mui-tiptap` 1.31.0 (01.06.2026) | MIT (все три; `extension-unique-id`, `static-renderer`, `extension-drag-handle-react` — тоже MIT) | ✓ (peer ^17–^19) | ✓ через `mui-tiptap` (peer `@mui/material` ^9, `@tiptap/*` ^3) | core 36 K + react 9 K + starter-kit 105 K + markdown 19 K (сам `marked`) + table 5 K + `mui-tiptap` 25 K | показ без редактора — `@tiptap/static-renderer` (JSON → HTML/React); редактор — клиент | ProseMirror, н/п | зависит от нашей панели, н/п | headless — тексты наши | каб. | ✓ JSON/Markdown на правку; id узлов — `@tiptap/extension-unique-id` |
| Milkdown (`@milkdown/kit`, `@milkdown/react`, Crepe) | 7.23.0 (27.10.2026) | MIT | ✓ (peer `react: *`) | ✗: ядро без интерфейса; Crepe — своя тема, зависит от `vue` | core 95 K + preset-gfm 129 K; Crepe 453 K (Vue, CodeMirror, KaTeX, DOMPurify) | клиент | н/п | н/п | тексты Crepe задаются в конфигурации, н/п | каб. | ✓ Markdown строкой; `@milkdown/plugin-diff` (`startDiffReviewCmd`, `acceptDiffChunkCmd`, `rejectDiffChunkCmd`, `acceptAllDiffsCmd`, `computeDocDiff`) |
| MDXEditor | 4.5.0 (02.11.2026) | MIT | ✓ | ✗ (Radix UI, свой CSS) | 569 K | клиент, н/п | н/п | Radix, н/п | н/п | каб. | ✓ Markdown через mdast |
| BlockNote | 0.57.0 (30.10.2026) | MPL-2.0 (core, react, mantine, shadcn, ariakit, server-util); `@blocknote/xl-docx-exporter`, `xl-pdf-exporter`, `xl-ai` — «GPL-3.0 OR PROPRIETARY» | ✓ | ✗ (только Mantine, shadcn, Ariakit; `@blocknote/mui` в npm нет) | core 186 K + mantine 247 K | `@blocknote/server-util` (зависит от jsdom) | н/п | н/п | ✓ локаль `ru` в сборке | каб. | ✓ JSON блоков с собственными id; Markdown — «lossy» |
| Lexical + `@lexical/markdown` | 0.53.0 (28.10.2026), ночные сборки ежедневно | MIT | ✓ (peer >=18) | ✗ (headless) | 68 K + 81 K (+ `@lexical/table` 91 K) | `@lexical/headless` | н/п | н/п | headless | каб. | ✓; преобразователя таблиц в пакете нет |
| CodeMirror 6 (`@uiw/react-codemirror`) — правка исходника | view 6.43.15 (19.10.2026); обёртка 4.25.12 (24.09.2026); `@codemirror/merge` 6.12.3 (19.10.2026) | MIT | ✓ | ✗ (своя тема) | 52 K (+ языки; merge 91 K) | — | н/п | н/п | своё | каб. | ✓ текст как есть, без потерь круга |

**Таблицы GFM.**
- **Tiptap.** Документация Markdown-расширения: «Markdown tables are supported, but only one child node per cell is allowed»; расширение — «a early release and can be subject to change»; «Comments are not supported yet» ([tiptap.dev](https://tiptap.dev/docs/editor/markdown)). Разбирает Markdown библиотека `marked` (единственная зависимость `@tiptap/markdown` 3.34.0), обратно в Markdown переводит каждое расширение само.
- **MDXEditor** собран на Lexical и mdast. В зависимостях 4.5.0 — `mdast-util-from-markdown`, `mdast-util-to-markdown`, `mdast-util-gfm-table`, `…-strikethrough`, `…-task-list-item` и `@codemirror/merge` для вида «разница». Его круг — это круг mdast (см. проверку ниже) плюс то, что Lexical способен представить.
- **Milkdown** переводит через remark (`@milkdown/transformer` зависит от `remark` и `unified`); GFM — в `@milkdown/preset-gfm`.
- **BlockNote**: `blocksToMarkdownLossy` — «The output is simplified as Markdown does not support all features of BlockNote… children of blocks which aren't list items are un-nested»; без потерь — только JSON `editor.document` ([blocknotejs.org](https://www.blocknotejs.org/docs/features/export/markdown)).
- **Lexical**: `@lexical/markdown` экспортирует преобразователи заголовков, списков, цитат, кода и ссылок и `isTableRowDivider`, но не `TABLE` (`packages/lexical-markdown/src/index.ts:243-275`); таблица Markdown есть только в примере playground.

**Проверка круга Markdown → mdast → Markdown** (локально, 19.11.2026). Пакеты из `node_modules` основной копии репозитория: `mdast-util-from-markdown` 2.0.3, `mdast-util-to-markdown` 2.1.2 (в npm уже 2.2.3 от 06.11.2026), `micromark-extension-gfm` 3.0.0, `mdast-util-gfm` 3.1.0. На этом сериализаторе стоят Milkdown, MDXEditor и экспорт BlockNote.
- **Сохраняется без изменений:** `«Кофейня»`, `„лапки“`, тире `—`, многоточие `…`, неразрывные пробелы в `250 ₽` и `1 200 ₽`, `ё`, `\|` внутри ячейки.
- **Меняется по умолчанию:**
  - таблица выравнивается пробелами (`| Напиток                | Цена, ₽ |`, `| :--------------------- | ------: |`);
  - маркер `-` становится `*`;
  - между соседними маркированным и нумерованным списками появляется пустая строка;
  - `Файл_имя_тест` → `Файл\_имя\_тест`, `5*3` → `5\*3`.
- **С `bullet: '-'` и `gfmToMarkdown({tablePipeAlign: false})`** остаются три изменения: строка разделителя `|:--|--:|` → `| :- | -: |`, пустая строка между списками и экранирование `\_` и `\*`.
- **Вывод.** Хранить канонический Markdown: после каждой записи прогонять его через один сериализатор с этими настройками. Агент тогда цитирует то, что лежит в базе, а правка человека в визуальном редакторе не даёт шума по всему разделу. Цитата агента со строкой `Файл_имя` должна совпадать и с формой `Файл\_имя` — сравнивать цитату по видимому тексту, а не по исходнику (r6 §8.3 так и предлагает: «в видимом содержимом блока»).

**Вставка из Google Docs и Word.**
- **Google Docs** оборачивает вставку в `<b style="font-weight:normal">`.
  - ProseMirror обрабатывает это правилом `{tag: "b", getAttrs: node => node.style.fontWeight != "normal" && null}` с комментарием «This works around a Google Docs misbehavior» (`prosemirror-schema-basic/src/schema-basic.ts:141-146`); у Tiptap то же правило в `extension-bold/src/bold.tsx:70-77`.
  - Lexical разбирает спаны Google Docs отдельно: «Google Docs wraps all copied HTML in a <b> with font-weight normal», жирный, курсив, зачёркивание и индексы — через стили (`packages/lexical/src/nodes/LexicalTextNode.ts:1576, 1762-1770`).
- **Word.** Отдельной очистки вставки из Word (классы `Mso*`, `<o:p>`, условные комментарии) ни в одном из открытых редакторов не нашёл (н/п).
  - Импорт DOCX у Tiptap — Pro-пакет `@tiptap-pro/extension-import-docx`, который отправляет файл в облачный «Conversion service» с `appId` и JWT ([tiptap.dev](https://tiptap.dev/docs/conversion/import/docx/editor-extension)). Нам не подходит: облако и платная лицензия.
  - Для файла `.docx` подойдёт `mammoth` 1.13.0 (BSD-2-Clause, 26.09.2026; DOCX → смысловой HTML), затем `turndown` 7.2.5 (MIT, 04.11.2026) с `@joplin/turndown-plugin-gfm` 1.0.71 (MIT, 12.11.2026; таблицы). Старый `turndown-plugin-gfm` не выпускался с 2018 года.

**Русская типографика.**
- Расширение Typography у Tiptap заменяет кавычки на английские «“ ”» и меняет `--`. Правила отключаются (`oneHalf: false`) и переопределяются строкой; `laquo`/`raquo` превращают `<<`/`>>` в « и » ([tiptap.dev](https://tiptap.dev/docs/editor/extensions/functionality/typography)). Задать `openDoubleQuote: '«'` документация прямо не описывает (н/п).
- В кабинете уже есть свой расстановщик неразрывных пробелов для интерфейса (`apps/web/src/lib/nbsp.ts:1-30`). Редактор должен их не терять — remark сохраняет (проверено выше).

**Разные разборщики Markdown.** `@repo/doc-render` рисует через remark (micromark), а Tiptap разбирает через `marked`. В пограничных случаях (вложенное выделение, HTML-блоки, `|` в коде таблицы) они могут разойтись (н/п). Ещё одна причина канонизировать на сервере тем же remark, который рисует.

**Режим предложений.** `@handlewithcare/prosemirror-suggest-changes` 0.1.8 (MIT, 18.11.2025 — выпусков год нет), `prosemirror-changeset` 2.4.6 (MIT, 02.11.2026; набор изменений между версиями — подсветка того, что поменял агент), `@milkdown/plugin-diff` 7.23.0 (MIT).

### 2b. Сетка и таблица

| Пакет | Версия, дата | Лицензия | React 19.3 | MUI 9 | Размер | SSR | Касание | Доступность | RU | Кадр | Ревизии |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MUI X Data Grid (`@mui/x-data-grid`) | 9.18.0 (13.11.2026) | MIT; Pro и Premium — коммерческие, $299 и $599 на разработчика в год ([mui.com/pricing](https://mui.com/pricing/)) | ✓ | ✓ родная (peer `@mui/material` ^7.3.0 или ^9.0.0) | 126 K | н/п | н/п | клавиатура — `useGridKeyboardNavigation` в MIT-сборке | ✓ `locales/ruRU` | каб. | ✓ правка ячейки и строки → операция |
| AG Grid Community | 36.3.0 (04.11.2026) | MIT; Enterprise — коммерческая EULA (без ключа — водяной знак) | ✓ (peer ^16.8–^19) | ✗ (своя Theming API) | 383 K + `ag-grid-react` 204 K (через модули меньше) | н/п | н/п | «Accessibility Support» в списке Community | ✓ `@ag-grid-community/locale` (`ru-RU`) | каб. | ✓ |
| Glide Data Grid | 6.0.3 (03.02.2024); alpha 6.0.4-alpha24 (08.10.2025) | MIT | ✗ (peer до 18.x) | ✗ | 62 K | ✗ (canvas) | н/п | canvas, н/п | н/п | каб. | ✓ |
| TanStack Table + Virtual | 9.3.1 (12.10.2026; 9.0.0 — 04.08.2026); Virtual 3.14.26 (03.11.2026) | MIT | ✓ (peer >=18) | ✓ — рисуем таблицей MUI сами | 31 K + 10 K | ✓ (headless) | наше | наше | наше | каб. | ✓ |
| `react-data-grid` | 7.0.0-beta.64 (05.11.2026); beta с 22.07.2021 | MIT | ✓ (peer ^19.2) | ✗ | 26 K | н/п | н/п | н/п | ✗ (своих текстов почти нет) | каб. | ✓ (так у Vercel Chatbot) |
| Univer (`@univerjs/presets`) | 1.5.2 (16.11.2026; 1.0.0 — 23.09.2026) | Apache-2.0 ядро; Pro-функции — коммерческая лицензия | ✓ | ✗ | `preset-sheets-core` 1 446 K; `engine-formula` 333 K | — | н/п | н/п | н/п | каб. | мутации, н/п |
| Jspreadsheet CE | 5.0.4 (25.08.2025; за год выпусков нет); пакет `jspreadsheet` 13.1.0 (02.11.2026) — платная версия (н/п) | MIT | обёртки, н/п | ✗ | 122 K + jsuites 76 K | — | н/п | н/п | н/п | каб. | ✓ |
| FortuneSheet | 1.0.4 (06.11.2025; за год выпусков нет) | MIT | ✓ (peer >=18.2) | ✗ | 546 K | — | н/п | н/п | н/п | каб. | ✓ |
| RevoGrid | 4.31.5 (11.11.2026) | MIT | обёртка `@revolist/react-datagrid` 4.31.6 | ✗ (веб-компонент) | 62 K | н/п | н/п | н/п | н/п | каб. | ✓ |
| Handsontable | 18.1.2 (07.10.2026) | «SEE LICENSE IN LICENSE.txt»: бесплатный ключ `non-commercial-and-evaluation` — только для использования без денежной выгоды ([docs](https://handsontable.com/docs/javascript-data-grid/license-key/)) | — | — | 335 K | — | — | — | — | — | ✗ по лицензии |

**MUI X Data Grid: что в MIT, проверено по тарболу 9.18.0.**
- Принудительные свойства (`DataGrid/useDataGridProps.js:17-28`): `disableMultipleColumnsFiltering: true`, `disableMultipleColumnsSorting: true`, `pagination: true`, `disableColumnReorder: true`, `listView: false`.
- В `hooks/features/pagination/gridPaginationUtils.js` — `MAX_PAGE_SIZE = 100` и ошибка «MUI X: `pageSize` cannot exceed 100 in the MIT version of the DataGrid».
- В MIT-компоненте подключены (`DataGrid/useDataGridComponent.js`): копирование в буфер, группы и объединение заголовков столбцов, меню столбца, изменение ширины, источник данных на сервере, плотность, правка ячейки и строки, клавиатура, экспорт CSV и печать, выбор строк, объединение строк, сохранение состояния, виртуализация. Хук вида списком тоже подключён, но `listView` принудительно выключен.
- Нет в MIT: вид списком (карточки на телефоне), закрепление столбцов, перестановка строк, дерево, группировка, агрегация, сводные таблицы, Excel, вставка из буфера.
- Формулы — Premium, «Syntax is en-US only, and function metadata isn't localized» ([mui.com](https://mui.com/x/react-data-grid/formulas/)).

**AG Grid.** Enterprise-функции по странице «Community vs Enterprise»: «Row Grouping & Multi-Column Sorting», «Range Selection», «Clipboard Operations», «Excel Export», «Pivot Tables & Aggregations», «Master/Detail View», «Server-Side Row Model», «Integrated Charts», «Tool Panels» ([ag-grid.com](https://www.ag-grid.com/react-data-grid/community-vs-enterprise/)). То, что многостолбцовая сортировка — Enterprise, взято из выдержки страницы, по коду не проверено (н/п).

**Univer.** Работа только в браузере не требует серверной части; совместная правка и импорт или экспорт офисных файлов требуют сервисов Server SDK ([docs.univer.ai](https://docs.univer.ai/guides/sheets/pro-features/introduction), v1.5.2). Что импорт и экспорт XLSX — Pro с бесплатными пределами (файл до 1 МБ, экспорт до 10 тыс. ячеек), — из выдержки поиска, н/п.

**Формулы.**

| Движок | Версия, дата | Лицензия | Что даёт | Вывод |
|---|---|---|---|---|
| HyperFormula | 3.5.0 (09.10.2026) | двойная: GPL-3.0 или проприетарная; какая действует, решает ключ лицензии (`LICENSE.txt`) | полный движок с графом зависимостей | ✗ для ядра |
| Formula.js (`@formulajs/formulajs`) | 4.6.1 (28.07.2026) | MIT | только функции Excel, без разбора формул и зависимостей; 43 K | годится как библиотека функций |
| `fast-formula-parser` | 1.0.19 (26.11.2020) | MIT | разбор формул | заброшен |
| `@univerjs/engine-formula` | 1.5.2 (16.11.2026) | Apache-2.0 | движок Univer, 333 K | тяжёлый |
| MUI X Premium formulas | 9.18.0 | коммерческая | только синтаксис en-US | ✗ |

Все движки считают в `number`. Для прайсов и смет это противоречит правилу 9: деньги — Decimal, округление HALF_UP один раз. Итоги и «вычисляемые столбцы» (Количество × Цена) считать на сервере `decimal.js` (уже в каталоге, `pnpm-workspace.yaml:62`), а не формулой в сетке.

**Чтение и запись файлов.**

| Пакет | Версия, дата | Лицензия | Состояние |
|---|---|---|---|
| `exceljs` | npm 4.4.0 (19.10.2023); на GitHub v4.4.1 (21.01.2025) в npm не вышла; последний коммит — 12.01.2024 | MIT | не развивается; 250 K |
| SheetJS CE (`xlsx`) | 0.20.3 — только на `cdn.sheetjs.com` (`xlsx.lst`, `xlsx-latest/package/package.json`); в npm застыла 0.18.5 от 24.03.2022 | Apache-2.0 («permissive license with certain attribution requirements») | ставить из тарбола CDN и хранить у себя («Vendoring … reduces the software supply chain attack surface»); дата 0.20.3 — н/п |
| `write-excel-file` / `read-excel-file` | 4.1.1 (08.06.2026) / 9.3.17 (13.11.2026) | MIT | живые; запись XLSX со стилями, чтение |
| `papaparse` | 5.7.1 (11.11.2026) | MIT | CSV, 7 K |
| `openpyxl` в образе песочницы | Debian | MIT (не проверено в этой работе) | агент уже собирает `.xlsx` (`infra/sandbox/Dockerfile:19-20,28`) |

### 2c. Доска кадров и прямые правки

**Библиотеки доски.**

| Пакет | Версия, дата | Лицензия | React 19.3 | MUI 9 | Размер | SSR | Касание | Доступность | RU | Кадр | Ревизии |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `@xyflow/react` (React Flow) | 13.0.2 (17.11.2026); 13.0.0 — 16.11.2026; последняя 12.x — 12.12.1 (02.11.2026) | MIT | ✓ (с 13.0 — React 18+) | ✓ стилями: CSS-переменные, с 13.0 стили в `@layer xyflow` | 86 K | ✓ с v12 (у узлов заданы размеры) ([reactflow.dev](https://reactflow.dev/learn/advanced-use/ssr-ssg-configuration)) | в документации есть раздел «Touch Device», н/п | клавиатура, `aria-live` (исправление a11y — в коммитах 13.0.2), н/п | тексты подписей наши, н/п | каб.; узел — DOM, в нём `<iframe>` | ✓ свойства узла, «кто последний записал» |
| Excalidraw | 0.18.1 (20.04.2026; ветка `next` — 17.11.2026) | MIT | ✓ (peer ^17.0.2, ^18.2 или ^19) | ✗ | 344 K | клиент | н/п | canvas | ✓ `ru-RU` в сборке | шрифты по умолчанию с CDN `esm.run` (переносятся к себе через `EXCALIDRAW_ASSET_PATH`, 482 файла шрифтов); воркер `subset-worker` | ✓ элементы с `version` (по схеме Excalidraw, здесь не перепроверено) |
| Konva + `react-konva` | 10.9.1 (31.10.2026) / 19.3.2 (15.10.2026) | MIT | ✓ (peer ^19.3.0) | ✗ | 56 K + 44 K | — | н/п | canvas | — | живой HTML в canvas не помещается | — |
| `react-zoom-pan-pinch` | 4.4.0 (19.11.2026) | MIT | ✓ (peer `*`) | ✓ (обёртка) | н/п | — | щипок, н/п | — | — | для доски на CSS-трансформе | — |
| `@panzoom/panzoom` | 4.6.2 (02.04.2026) | MIT | — | — | 3,6 K | — | н/п | — | — | то же | — |
| tldraw | 5.6.1 (16.11.2026) | своя лицензия, в продакшене нужен ключ (r6 §1) | — | — | 541 K | — | — | — | — | — | ✗ по лицензии |

**Доска на CSS-трансформе — как показывать много живых кадров.**
1. Поле `transform: translate(x, y) scale(z)`. Кадр — обёртка 1440×H или 390×H с `<iframe width=1440>` внутри. Медиазапросы видят полную ширину, масштаб уменьшает картинку целиком.
2. **Живой кадр — только выбранный** и, по желанию, видимые при масштабе от 0,5. Остальные — `<img>` миниатюры, снятой на сервере по ревизии блока. Кадр без режима «Interactive frames» Replit описывает так: «a snapshot you can iterate on but not click through» ([docs.replit.com](https://docs.replit.com/design/frames.md)). У Base44, наоборот, «Every page appears as a live-preview frame on an infinite board», о производительности ни слова ([docs.base44.com](https://docs.base44.com/Building-your-app/Canvas.md)).
3. Пока доску двигают, у кадров `pointer-events: none`: иначе `<iframe>` перехватывает мышь. Клик по кадру — «работать с кадром» (режим фокуса).
4. **Что делает браузер сам.** Chrome и Edge глушат невидимые и `display:none` кадры другого источника: у них останавливаются `requestAnimationFrame` и `ResizeObserver`. Edge описывает это для версий 116+ ([learn.microsoft.com](https://learn.microsoft.com/en-us/deployedge/edge-learnmore-iframe-throttling-display); [blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/op-z7fMMmWY)). Непрозрачный кадр — тоже другой источник, но память это не освобождает: снять кадр с доски может только кабинет.
5. **Процесс.** Хост страниц `*.pages.raditi.ru` — тот же сайт, что кабинет, а изоляция Chrome — по сайту. Значит, кадры, вероятно, рендерятся в процессе кабинета: тяжёлый или зациклившийся скрипт макета подвешивает интерфейс кабинета. Флаг `kIsolateSandboxedIframes` в Chromium существует, включён ли он по умолчанию — н/п. Если это подтвердится стендом, это довод в пользу отдельного регистрируемого домена песочницы (r6 §5) — уже не ради безопасности, а ради отзывчивости.

**Открытые визуальные редакторы HTML.**

| Проект | Версия, дата | Лицензия | Модель | Подходит ли для HTML агента |
|---|---|---|---|---|
| GrapesJS | 0.23.9 (03.11.2026); Studio SDK 1.2.1 — своя лицензия | BSD-3-Clause | собирает HTML/CSS в дерево компонентов («compile a simple string (HTML/CSS) into structured nodes»); встроенные стили уходят в правила (`avoidInlineStyle` устарел, «doesn't support inline styling anymore» — по комментарию конфигурации, н/п для 0.23.9); API холста — `getWindow()`, `getDocument()`, `getBody()` кадра ([grapesjs.com](https://grapesjs.com/docs/api/canvas.html), обновлено 03.11.2026) | ✗: переписывает исходник агента, и цитаты `str_replace` перестают совпадать; редактору нужен доступ к DOM кадра, то есть тот же источник |
| Puck (`@puckeditor/core`; `@measured/puck` объявлен устаревшим) | 0.24.1 (18.11.2026) | MIT | JSON из ваших React-компонентов; Puck AI — в облаке Puck Cloud | только если «Холст» собирать из наших блоков с пропсами вместо свободного HTML (позже) |
| Craft.js | 0.2.12 (14.02.2025) | MIT | дерево React-узлов | не развивается |
| VvvebJs | 2.0.9 (01.07.2026) | Apache-2.0 | правит DOM HTML-страницы в кадре того же источника | ✗: сохраняет сериализацию живого DOM |
| Onlook 2.0 | 17.11.2026 | Apache-2.0 | приложение Electron, код правит агент | только идеи |

**Клик по элементу → место в исходнике.**
- **Dyad** — `@dyad-sh/react-vite-component-tagger` 0.9.0 (Apache-2.0). Плагин Vite разбирает JSX через `@babel/parser` и вставляет `magic-string`-ом ` data-dyad-id="${файл}:${строка}:${столбец}" data-dyad-name="${тег}"` в каждый открывающий тег (README и `dist/index.mjs` пакета).
- **Lovable** — `lovable-tagger` 1.3.5 (MIT, 25.09.2026). Атрибутов уже не ставит: подменяет `react/jsx-dev-runtime`, кладёт `{fileName, lineNumber, columnNumber, displayName}` в DOM-узел под `Symbol.for("__jsxSource__")` и в `window.sourceElementMap` (WeakRef), работает только в разработке (на SSR пропускает) (`dist/index.js` пакета).
- **v0 Design Mode** ([v0.app](https://v0.app/docs/design-mode), обновлено 18.11.2026). Правит шрифт (семейство, размер, насыщенность, интерлиньяж, разрядка, выравнивание, оформление), цвет текста и фона, внешние и внутренние отступы, рамку, прозрачность, скругление, тень и текст. «Apply» создаёт новую версию чата; неприменённые правки держатся до «Apply», при уходе v0 предупреждает. Работает только на последней версии, «Not available on read-only chats or mobile viewports». Как клик сопоставляется с исходником — не описано.
- **Подходит ли это HTML агента, который хранится блоками.** Подходит, если id ставит сервер:
  1. На каждой записи блока (агента или человека) сервер разбирает HTML через `parse5` с `sourceCodeLocationInfo: true`: «each node (except the root node) will have a `sourceCodeLocation` property» ([parse5.js.org](https://parse5.js.org/interfaces/parse5.ParserOptions.html); 8.1.1, MIT, 07.11.2026).
  2. Элементам без `data-…`-id сервер вставляет короткий id, уникальный в блоке; дубликаты перенумеровывает. Результат — каноническое содержимое новой ревизии.
  3. Прямая правка человека приходит операцией `{op: 'set_text' | 'set_style' | 'set_attr', block, el, ifRev, …}`. Сервер находит элемент по id, правит текст между концом открывающего и началом закрывающего тега или значение атрибута `style` по смещениям, разбирает заново для проверки и пишет ревизию. Живой DOM кадра обратно не сериализуется никогда.
  4. Свойства — по белому списку: цвет, фон, размер и насыщенность шрифта, отступы, `gap`, скругление, выравнивание; `src` — только из файлов артефакта, `href` — после проверки.
  5. Агенту инструкции велят сохранять эти атрибуты. Потерянный id — как у Lovable: булавка комментария «потеряла место».
- **Где выбирать элемент.** Три способа, по убыванию удобства:
  1. **Кадр правки без скриптов:** `sandbox="allow-same-origin"` без `allow-scripts`, HTML очищен сервером, у ответа своя строгая CSP. MDN: «When `allow-same-origin` is present, a same-origin parent document can still access and interact with the iframe's DOM even if `allow-scripts` is not set» ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)). Кабинет сам подсвечивает элементы, ставит `contenteditable` и читает рамки; скрипт агента не исполняется, подделать сообщения некому. Минусы: не видно того, что строит JS агента. Срабатывают ли обработчики кабинета на узлах такого кадра в Chromium, WebKit и Firefox — н/п, это первый спайк. Маршрут на хосте кабинета нужно исключить из общих заголовков `next.config.ts`: это ловушка c1 §17 п. 1.
  2. **Миниатюра + карта вёрстки:** серверный рендер отдаёт PNG и рамки всех `[data-…]`. Клик по картинке → элемент → панель свойств → операция → новая миниатюра. Медленнее (рендер на каждую правку), зато безопасно и годится для телефона.
  3. **Скрипт платформы внутри живого непрозрачного кадра.** Только для подсказок: сообщения из кадра может подделать скрипт агента (c1 §17 п. 6).

### 2d. Схемы

| Пакет | Версия, дата | Лицензия | Размер | Где рисует | Заметки |
|---|---|---|---|---|---|
| Mermaid | 12.3.0 (03.11.2026); 12.0.0 — 10.09.2026; метка `v13-alpha` — 13.0.0-alpha.3 (11.11.2026) | MIT; в зависимостях `elkjs` (EPL-2.0 или GPL-3.0-or-later), `dompurify` (MPL-2.0 или Apache-2.0), `cytoscape`, `d3`, `katex` | вход 155 K + ленивые части; `dist/mermaid.min.js` — 5 537 838 байт, `@mermaid-js/tiny` — 2 852 578 байт | нужен DOM (размеры текста); на сервере — `@mermaid-js/mermaid-cli` 12.2.0 (02.11.2026, Puppeteer) или `mermaid-isomorphic` 3.1.0 (19.02.2026, Playwright) | 12.0.0: «ES2024, Safari 17.4+, Node 22.12+», ELK — раскладка по умолчанию, IIFE «grows by roughly 500 kB gzipped», tiny без ELK ([release](https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.0.0)) |
| `beautiful-mermaid` (Craft) | 1.1.3 (26.02.2026) | MIT; зависимости `elkjs` ^0.11.0 (EPL-2.0 или GPL) и `entities` | 471 K | без DOM, синхронно, SVG или ASCII | 6 видов: блок-схемы, состояния, последовательности, классы, ER, XY-графики; 15 тем; синтаксис Mermaid разбирает сам — совпадение с Mermaid н/п |
| `@mermaid-js/parser` | 2.0.1 (02.10.2026) | MIT | 129 K | разбор без рендера | грамматики Langium: architecture, gitGraph, info, packet, pie, radar, treemap, cynefin, eventmodeling, railroad, treeView, wardley; **блок-схем нет** |
| D2 (`@terrastruct/d2`) | 0.1.33 (17.08.2025) | MPL-2.0 | 5 849 K (WASM) | браузер или CLI на Go | для браузера слишком тяжёл |
| ELK.js | 0.12.1 (28.10.2026) | EPL-2.0 или GPL-3.0-or-later | 437 K | раскладка | слабое копилефтное условие на уровне файлов, как у MPL: «с осторожностью» |
| `@dagrejs/dagre` | 3.1.3 (24.10.2026) | MIT | 16 K | раскладка | для узлов React Flow |
| Kroki | v0.36.0 (09.11.2026) | MIT | — | сервер: `yuzutech/kroki` (около 30 библиотек, PlantUML, GraphViz) + спутники `kroki-mermaid`, `kroki-bpmn`, `kroki-excalidraw`, `kroki-diagramsnet` (экспериментальный) ([docs.kroki.io](https://docs.kroki.io/kroki/setup/install/)) | ещё несколько контейнеров; режим безопасности не проверен (н/п) |
| `@excalidraw/mermaid-to-excalidraw` | 3.6.0 (04.11.2026) | MIT | 20 K | браузер | Mermaid → элементы Excalidraw для «Карты идей»; обратного пути нет |
| DOMPurify / `isomorphic-dompurify` | 3.4.18 (14.11.2026) / 4.8.0 (18.11.2026) | MPL-2.0 или Apache-2.0 / MIT | 11 K | браузер / Node (jsdom) | очистка SVG перед показом |

**Безопасность Mermaid.**
- `securityLevel` ([mermaid.js.org](https://mermaid.js.org/config/usage.html), 12.3.0):
  - `strict` (по умолчанию) — «HTML tags in the text are encoded and click functionality is disabled»;
  - `antiscript` — HTML разрешён, удаляются только `script`;
  - `loose` — HTML и клики;
  - `sandbox` — «all rendering takes place in a sandboxed iframe».
- **Что на деле делает `sandbox`** (`packages/mermaid/src/mermaidAPI.ts`). Код Mermaid работает в странице-хозяине и рисует во временном `<iframe sandbox="">`, у которого обращается к `contentDocument` (540-550). Готовый SVG вставляется в `<iframe src="data:text/html;base64,…" sandbox="allow-top-navigation-by-user-activation allow-popups">` (67, 382-389). Режим защищает от исполнения вывода, но не от ошибок разборщика в странице.
- **Бюллетени** ([advisories](https://github.com/mermaid-js/mermaid/security/advisories)): XSS через `iconText` в диаграммах architecture (19.08.2025); HTML-инъекция через `classDef` в диаграммах состояний; CSS-инъекции через `classDefs`, конфигурацию и соседние элементы; загрязнение прототипа через architecture и API конфигурации; бесконечные циклы и отказ в обслуживании в Gantt, XY и radar. Даты публикаций — 19.08.2025, 11.05.2026 (4) и 04.08.2026 (5); соответствие дат конкретным бюллетеням не сверялось.
- **Вывод.** Не исполнять Mermaid в кабинете (XSS и зависания бьют по самому кабинету) и не вписывать в кадр. Рисовать в отдельном процессе с таймаутом:
  - `beautiful-mermaid` в `core` или web, без DOM;
  - для неподдерживаемых видов — Mermaid в серверном Chromium.
  - SVG — через DOMPurify (SVG-профиль) и показывать как `<img src="data:image/svg+xml,…">` или файлом артефакта: картинка внутри `<img>` скрипты не исполняет. PNG — `sharp` (уже в web, `pnpm-workspace.yaml:133`), если на сервере есть шрифты, или тот же Chromium.

### 2e. Слайды

| Пакет | Версия, дата | Лицензия | Хранение | PDF и PPTX | Встраивание |
|---|---|---|---|---|---|
| reveal.js | 6.0.2 (10.09.2026); 6.0.0 — 11.03.2026 | MIT | HTML: `<section>` на слайд — ложится на блоки | PDF — `?print-pdf` и печать, «only been confirmed to work in Google Chrome and Chromium»; `pdfMaxPagesPerSlide`, `pdfSeparateFragments`, `showNotes: "separate-page"` ([revealjs.com](https://revealjs.com/pdf-export/)) | 6.0: сборка на Vite, типы в пакете, официальная обёртка `@revealjs/react` (0.2.2, MIT, 10.09.2026: `<Deck>`, `<Slide>`, `<Stack>`, `<Fragment>`, `<Code>`), пути плагинов изменились ([release](https://github.com/hakimel/reveal.js/releases/tag/6.0.0)); `dist/reveal.js` — 118 912 байт, 30 K gz |
| Marp (`@marp-team/marp-core`, `marp-cli`) | core: `latest` 4.4.0 (17.07.2026), `next` 5.0.2 (04.09.2026); cli 4.5.1 (06.09.2026) | MIT | Markdown, слайды через `---` | CLI — PDF, PPTX и PNG через Chrome, Edge или Firefox; PPTX «consists of pre-rendered background images, … contents cannot to modify»; `--pptx-editable` — экспериментальный, нужен LibreOffice Impress, «lower slide reproducibility», без заметок докладчика (README marp-cli) | ядро по bundlephobia — 1 130 K (в зависимостях `mathjax-full`), поэтому только на сервере |
| Slidev | 53.1.0 (05.11.2026) | MIT | Markdown + Vue | экспорт через Playwright; в зависимостях `monaco-editor`, `pptxgenjs`, `pdf-lib`, `vite`, `vue` | ✗: сервер разработки, не компонент |
| Spectacle | 10.2.4 (27.10.2026) | MIT | JSX | — | 397 K, один выпуск за год |
| `pptxgenjs` | 4.0.1 (26.06.2025) | MIT | — | PPTX в браузере и в Node, 120 K | выпусков 17 месяцев |

### 2f. Графики для отчётов

| Пакет | Версия, дата | Лицензия | Размер | Сервер без DOM | В кадре (без eval, воркеров и сети) | RU |
|---|---|---|---|---|---|---|
| Apache ECharts | 6.1.0 (npm — 19.05.2026, выпуск на GitHub — 28.05.2026) | Apache-2.0 | 359 K; `echarts.min.js` — 1 121 883 байт, `echarts.simple.min.js` — 500 315 | ✓ строка SVG с 5.3.0: `init(null, null, {renderer: 'svg', ssr: true, width, height})` → `renderToSVGString()`, анимация — CSS внутри SVG; лёгкая клиентская среда меньше 4 KB с 5.5.0 ([echarts.apache.org](https://echarts.apache.org/handbook/en/how-to/cross-platform/server/)) | ✓, но тяжело вписывать | ✓ `i18n/langRU.js` |
| Chart.js | 4.6.1 (22.10.2026) | MIT | 68 K; `chart.umd.min.js` — 210 082 байт | ✗ без `node-canvas` (н/п) | ✓ (canvas, без eval) | через Intl и адаптеры дат, н/п |
| Recharts | 3.11.0 (17.11.2026) | MIT | 173 K | React SVG с фиксированными размерами, н/п | ✗ (нужен React) | — |
| MUI X Charts | 9.18.1 (16.11.2026) | MIT (Pro — коммерческая) | 124 K | н/п | — | файла локали `ruRU` в пакете нет |
| Vega-Lite + Vega | 6.5.0 (08.10.2026) + 6.4.0 (14.08.2026) | BSD-3-Clause | 88 K + 178 K | н/п | только с `vega-interpreter` 2.3.2: по умолчанию «Vega uses the Function constructor», интерпретатор «compliant with Content Security Policy», в среднем на 10 % медленнее ([vega.github.io](https://vega.github.io/vega/usage/interpreter/)) | н/п |
| Observable Plot / uPlot | 0.6.19 (05.11.2026, ISC) / 1.6.32 (14.03.2025, MIT) | — | 124 K / 21 K | н/п | ✓ / ✓ | — |

Для агента лучше всего подходит декларативный JSON без функций: опции ECharts с запретом функций (`formatter` — только строковые шаблоны) или Vega-Lite. Схему проверять zod на сервере, рисовать доверенным кодом (r7 §2.14: «Агент описывает график данными, рисует его доверенный код»).

### 2g. Экспорт

| Путь | Версия, дата | Лицензия | Что умеет | Ограничения у нас |
|---|---|---|---|---|
| Chromium на сервере (Playwright) | в каталоге `playwright-core` 1.63.0 (`pnpm-workspace.yaml:148`); в npm 1.65.1 (13.11.2026) | Apache-2.0 | `page.pdf()` (только Chromium), снимки целой страницы, `setContent` без сети; поля страницы `@top-center` и другие — с Chrome 131 ([developer.chrome.com](https://developer.chrome.com/blog/print-margins)) | нужна очередь и пределы; шрифты — встроенные или установленные в образ; готовый снимок экрана в коде есть только для браузера агента (`packages/browser-providers/src/cloud/cloud-browser.ts:943-972`, JPEG видимой области) |
| Печать браузера из кадра | — | — | `window.print()` | в песочнице без `allow-modals` печать запрещена («Allows … `Window.print()`», MDN); из кабинета непрозрачный кадр не печатается |
| Paged.js | 0.4.3 (06.07.2023); 0.5.0-beta.2 (04.10.2024); объявлен «paged.js 2.0» ([pagedjs.org](https://pagedjs.org/posts/en/kickstarting-the-next-iteration-of-paged.js), 17.05.2025 по выдержке) | MIT | разбивка на страницы в браузере, 91 K | стоит; с полями страницы Chrome 131 нужен редко |
| `html-to-image` | 1.11.13 (14.02.2025; коммиты идут, последний — 18.11.2026) | MIT | DOM → SVG `foreignObject` → PNG, 5 K | кадр копируется, только если доступен `iframe.contentDocument`, иначе пустой (`clone-node.js:27-37`); не-`data:` адреса и CSS шрифтов загружаются через `fetch` (`dataurl.js:11`, `embed-webfonts.js:10`) — у нас `connect-src 'none'`; есть `skipFonts`, `fontEmbedCSS` |
| `modern-screenshot` / `dom-to-image-more` / `@zumer/snapdom` | 4.7.0 (16.04.2026) / 3.11.0 (24.09.2026) / 3.8.1 (18.11.2026, выпуски каждые несколько дней) | MIT | то же семейство, 10 K / 10 K / 109 K | то же; `html2canvas` 1.4.1 не обновлялся с 22.01.2022, живой форк — `html2canvas-pro` 2.6.4 (11.11.2026) |
| DOCX: `docx` | 9.16.0 (19.11.2026) | MIT | программная сборка документа, браузер и Node, 81 K | своё сопоставление mdast → docx (заголовки, списки, таблицы, ссылки, картинки) |
| DOCX из HTML | `@turbodocx/html-to-docx` 1.23.3 (30.10.2026); `html-to-docx` 1.8.0 (26.03.2023) | MIT | HTML → DOCX | 471 K; старый пакет не развивается |
| PPTX: `pptxgenjs` | 4.0.1 (26.06.2025) | MIT | слайды, картинки, таблицы | см. 2e |
| PDF программно | `pdfmake` 0.3.14 (08.11.2026), `jspdf` 4.2.1 (17.03.2026), `@react-pdf/renderer` 4.9.0 (27.08.2026), `pdf-lib` 1.17.1 (06.11.2021) | MIT | — | при серверном Chromium не нужны; `pdf-lib` — для склейки (так у Onlook) |

**Ограничения клиентского снимка в нашей модели.** Они вытекают из спецификаций; в браузере не проверялись.
- Кабинет не видит DOM непрозрачного кадра, поэтому снимок кадра «снаружи» невозможен.
- Внутри кадра:
  - `fetch` закрыт, значит все ресурсы должны быть `data:`;
  - правила чужих по источнику таблиц стилей не читаются (а из непрозрачного источника чужие все);
  - скачать файл нельзя — нет `allow-downloads` («Allows downloading files through an `<a>` … with the `download` attribute», MDN). Файл придётся передавать кабинету через `postMessage`, а такое сообщение может подделать скрипт агента.
- Вывод: PNG и PDF кадров — только серверный рендер; клиентские библиотеки — для DOM самого кабинета (документ, графики MUI).

---

## 3. Рекомендации

### 3.1 По видам

| Вид | Выбор | Запасной | Почему | Риски (лицензия, размер, поддержка, телефон) | Объём |
|---|---|---|---|---|---|
| **Документ** | Tiptap 3.34 + `@tiptap/markdown` + `@tiptap/extension-unique-id` + `mui-tiptap` 1.31; редактор на раздел (блок); при записи — канонизация remark (`mdast-util-to-markdown`, `bullet: '-'`, `tablePipeAlign: false`); показ — `@repo/doc-render` как сейчас | Milkdown kit 7.23 без Crepe (remark-native, `plugin-diff`); или CodeMirror 6 с предпросмотром («Исходник») | MIT, родная тема MUI 9, React 19, таблицы GFM, правило вставки из Google Docs, id узлов, показ на сервере без редактора | `marked` против micromark; «early release»; в ячейке таблицы один узел; шум экранирования; вставка из Word без очистки; на телефоне — ProseMirror, н/п | M |
| **Макет** | существующий кадр `/v/<token>` (`PAGE_SANDBOX`), просмотр «Исходник» на CodeMirror (`@codemirror/lang-html`), форма «Настройки» из JSON-блока (MUI + zod) | — | уже работает; новые зависимости — только редактор кода | библиотекам нужен `'self'` в политике кадра и путь на хосте страниц (§3.3) | S |
| **Холст** | доска `@xyflow/react` 13 (узел — кадр 1440 или 390); живой кадр — выбранный, остальные — миниатюры серверного рендера по ревизии; прямые правки — штампы id + `parse5` + операции `set_text` / `set_style` / `set_attr`; кадр правки без скриптов (§2c); булавки — к id элемента со смещением; токены «Фирменного стиля» — CSS-переменными в каждый кадр | доска на CSS-трансформе + `react-zoom-pan-pinch`; без прямых правок — только комментарии и правка агентом | MIT, узлы — DOM, есть SSR, тот же выбор у Onlook 2.0; патч исходника сохраняет цитаты агента | 13.0 вышел 16.11.2026 с ломающими изменениями (можно начать с 12.12.1); память и процесс живых кадров (§2c п. 5); агент теряет id; кадр правки обязан остаться без скриптов; на телефоне — список миниатюр и полноэкранный кадр, правки — через миниатюру | L (без прямых правок — M) |
| **Таблица** | MUI X Data Grid 9.18 MIT: столбцы с видами (текст, число, ₽, дата, выбор, ссылка, флажок), правка ячейки → операция с `ifRev`; итоги и вычисляемые столбцы — `decimal.js` на сервере; экспорт CSV — сетка, XLSX — `write-excel-file`, импорт — `read-excel-file` и `papaparse` | TanStack Table 9.3 + Virtual, вёрстка MUI (без пределов MIT); AG Grid Community 36.3 (без пределов, своя тема) | родные тема, `ruRU`, доступность и правка; MIT | 100 строк на страницу, одна сортировка и фильтр, нет перестановки столбцов, вставки из буфера и Excel (Premium); соблазн докупить Premium; на телефоне сетка тесная, а вид карточками в MIT выключен (`listView: false`) — свой список карточек | M; формулы — L |
| **Схема** | текст Mermaid в блоке; SVG на сервере: `beautiful-mermaid` для 6 видов, остальное — Mermaid 12 в серверном Chromium с таймаутом; DOMPurify; показ `<img>`; PNG — `sharp` или Chromium | Kroki в своих контейнерах | Mermaid не исполняется в кабинете (10 бюллетеней) и не вписывается в кадр (5,5 МБ) | два рендера рисуют по-разному; EPL-2.0 у `elkjs` (с осторожностью); выпуски `beautiful-mermaid` — последний 26.02.2026; агент рисует вслепую | M |
| **Презентация** | слайд — кадр 1280×720 (механика Холста); показ — полноэкранный листатель или `@revealjs/react`; PDF — серверный Chromium с `@page { size: 1280px 720px }`; PPTX — картинка на слайд через `pptxgenjs` | Marp: Markdown-слайды, HTML рисует сервер | переиспользует Холст и рендер | PPTX не правится; `pptxgenjs` без выпусков 17 месяцев; правимый PPTX требует строгой модели слайда (шаблоны), это L | M |
| **Отчёт с графиками** | разделы «Документа» + блоки графиков: JSON-подмножество опций ECharts (схема zod, без функций) → `renderToSVGString` на сервере → `<img>` в кабинете и в PDF | Vega-Lite + `vega-interpreter`; интерактив позже — лёгкая среда ECharts в кадре или MUI X Charts в кабинете | рисует без DOM, Apache-2.0, `langRU`, один SVG для экрана и PDF | шрифты внутри SVG; числа в графике — `number` (только показ); 359 K в клиент не тянуть | M |
| **Фирменный стиль** | токены JSON (цвета, шрифты, скругления, отступы, тон) → CSS-переменные `:root` в каждый HTML-кадр; форма MUI + `react-colorful` 5.8.1 + контраст через `colorjs.io` 0.7.1; шрифты — набор `@fontsource-variable/*` (OFL) с хоста страниц | шрифты как `data:` в каждом кадре (Golos Text: cyrillic — 22 032 байт, latin — 37 916 байт woff2) | одна правка перекрашивает все кадры и слайды | шрифты из непрозрачного источника требуют CORS (§3.3); `data:` раздувает каждый кадр | S–M |
| **Экспорт** | серверный рендер Chromium (PDF, PNG, миниатюры, карта вёрстки); DOCX — `docx` из mdast; PPTX — `pptxgenjs`; XLSX — `write-excel-file` (или SheetJS CE из тарбола CDN); CSV — `papaparse`; файлы «по просьбе» агента — `python-docx` и `openpyxl` в песочнице | клиентские снимки — только для DOM кабинета | одно место, правильные шрифты, работает и для телефона | очередь, таймауты, рендер без сети, размер ответов | M |

### 3.2 Что общего у видов

1. **Серверный рендер** — Chromium без сети и с таймаутом. На входе HTML блока (или страница чтения документа) и размеры 1440, 390 или 1280×720. На выходе:
   - PNG-миниатюра (ключ — артефакт, блок и ревизия), PDF;
   - **карта вёрстки** — рамки `[data-…]`, переполнение, наложения, контраст, горизонтальная прокрутка на 390 px.
   Карта нужна для булавок и выбора по миниатюре, а агенту — как текстовый отчёт вместо зрения (r7 §2.4). Место — `apps/browser`: там уже есть контейнеры Chromium, Playwright и снимки экрана. Нужен новый маршрут без прокси выхода — подробно в §3.3.
2. **Хост кадров и мост `postMessage`.** Один компонент кабинета для Макета, Холста и Презентации: флажки песочницы — константа `PAGE_SANDBOX`, сообщения проверяются схемами zod, правила моста — r6 §5. Сюда же — список библиотек платформы для кадров (Chart.js, ECharts simple, reveal.js) по закреплённым путям.
3. **Штамповщик и патчер HTML** на `parse5` (MIT) в `@repo/domain` или в отдельном пакете: id элементов, операции `set_text` / `set_style` / `set_attr`, очистка для кадра правки.
4. **Канонизатор Markdown** на `mdast-util-to-markdown` для Документа, Отчёта и разделов любого вида; плюс сравнение цитат по видимому тексту.
5. **Вид «разница»:** `@codemirror/merge` 6.12.3 для исходников, `prosemirror-changeset` для документа; Vercel показывает разницу между соседними версиями (`mode: "diff"`).
6. **Очистка SVG** (DOMPurify): Схема, Отчёт, загруженные картинки.
7. **Деньги** — `decimal.js` в Таблице, Бланке (r7 §2.8) и Отчёте.
8. **Токены** «Фирменного стиля» — один источник CSS-переменных для всех HTML-видов.

### 3.3 Что придётся поменять в CSP и инфраструктуре

1. **Политика кадра кабинета.** Сейчас `script-src 'unsafe-inline'`, а картинки и шрифты — только `data:` и `blob:` (`headers.ts:27, 63-67`). Для библиотек платформы нужно `script-src 'self' 'unsafe-inline'` (или хеши) и путь на хосте страниц. Там сейчас отвечает только `/v/<token>` (`apps/web/src/lib/pages-origin.ts:12`, `apps/web/src/proxy.ts:42-44`); новый путь — это четыре правки из c1 §17 п. 1. Проще дать библиотекам адрес вида `/v/<метка>.<хеш>`.
2. **Ответы с библиотеками и шрифтами** для непрозрачного кадра. Нужен `Cross-Origin-Resource-Policy: cross-origin`: общие файлы уже так делают — «a sandboxed page asks from an opaque origin, which `same-origin` would refuse» (`packages/domain/src/pages/files.ts:91-110`). Для `@font-face` и `<script type="module">` нужен ещё `Access-Control-Allow-Origin: *`: оба идут CORS-запросом ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)), а Origin у непрозрачного документа — `null`. Классические скрипты без `type="module"` CORS не требуют.
   - **Побочная находка.** Общие файлы сайтов страниц допускают `font/woff2` (`files.ts:45-46`), но ACAO не ставят, а стенд `verify:pages` загрузку шрифта не проверяет. Гипотеза: шрифт из `/_files/` на опубликованной странице не загрузится. Проверить отдельно (н/п).
3. **Серверный рендер.** В `apps/browser` есть сессии с прокси выхода и снимок видимой области (JPEG, `cloud-browser.ts:943-972`). Нужен отдельный путь: Chromium без сети, `setContent`, снимок целой страницы в PNG и `page.pdf()`, карта рамок, таймаут и предел размера ответа. Каталог закрепляет `playwright-core` 1.63.0, в npm — 1.65.1.
4. **Отдельный регистрируемый домен песочницы** снял бы и вопрос процесса (§2c п. 5), и вопрос `'self'` для библиотек. Это решение владельца (r6 §5); пока оно не принято, живых кадров на экране держать мало.
5. **Будущий полный CSP кабинета (TODO M8, `content-security-policy.ts:15-16`).** Когда в кабинете появятся `script-src`, `worker-src` и `connect-src`, проверить компоненты: Excalidraw (воркер `subset-worker`), CodeMirror (ленивые языки — динамические импорты своего origin) и Tiptap (без воркеров, н/п).

### 3.4 Что проверить спайками до плана (по порядку)

1. Кадр правки `sandbox="allow-same-origin"` без скриптов: срабатывают ли в Chromium, WebKit и Firefox обработчики кабинета, `contenteditable` и чтение рамок.
2. Шрифт и классический скрипт с хоста страниц в непрозрачном кадре с CORP `cross-origin` и ACAO `*`, в Chromium и WebKit. Заодно — гипотеза о шрифтах `/_files/` (§3.3 п. 2).
3. Серверный рендер в `apps/browser`: 1440 и 390, PNG, PDF и карта рамок для 10 типичных макетов агента; время и память.
4. `beautiful-mermaid` против Mermaid 12 на 30 диаграммах, которые пишет GLM: доля несовпадений и отказов разбора.
5. Круг Tiptap `@tiptap/markdown` ↔ канонический remark на русском корпусе (документы агента из `chat_documents`, только синтетика).
6. React Flow 13 с 10 узлами-кадрами на ноутбуке и телефоне: память, FPS панорамы, `pointer-events`.
7. MUI X Data Grid MIT на прайсе из 300 строк с пагинацией по 100 против TanStack + Virtual: удобство на компьютере и телефоне.

### 3.5 Чего не брать

Sandpack и любой сборщик или CDN снаружи; Pyodide в окне кабинета; HyperFormula, Handsontable, BlockNote XL, tldraw, AG Grid Enterprise, MUI X Pro и Premium, Univer Pro — по лицензии; Glide Data Grid — без React 19; Slidev — сервер разработки на Vue; Paged.js — стоит с 2023 года; `exceljs` и `html2canvas` — не развиваются; GrapesJS и VvvebJs для HTML агента — переписывают исходник; Mermaid в контексте кабинета.

---

## 4. Факты кода (только чтение, дерево `feat/artifacts`, коммит `b1349f3b`)

- **Каталог версий** — `pnpm-workspace.yaml`: `next: 16.3.6` (82; в npm 16.4.6 от 09.11.2026), `react: ^19.3.0` и `react-dom` (83-84; в npm 19.3.1 от 14.10.2026), `@mui/material: ^9.4.0`, `@mui/icons-material`, `@mui/material-nextjs` (87-89; в npm 9.5.0 от 09.10.2026), `@emotion/*` (90-92), `zod: ^4.6.5` (61), `decimal.js: ^10.6.0` (62), `sharp: 0.35.4` (133), `remark-gfm: ^4.0.1` (138), `rehype-highlight: ^7.0.2` (139), `highlight.js: ^11.12.0` (140), `react-markdown: ^10.1.0` (142), `@playwright/test: ^1.63.0` (146), `playwright-core: 1.63.0` (148), шрифты `@fontsource-variable/golos-text`, `unbounded`, `jetbrains-mono` ^5.3.0 (151-153).
- **`apps/web/package.json:15-59`** — зависимости: `@mui/material` (23), `@repo/doc-render` (30), `highlight.js` (47), `react-markdown` (52), `rehype-highlight` (53), `remark-gfm` (54), `sharp` (56). Ни `@mui/x-*`, ни редактора, сетки, графиков, диаграмм или экспортёров.
- **`packages/ui/package.json:24-35`** — MUI, Emotion, `react-hook-form`, `@hookform/resolvers`, `@yandex/smart-captcha`, `zod`; peer `react` ^19.0.0, `next` ^16.0.0 (36-40).
- **`packages/doc-render/package.json:16-22`** — `@repo/domain`, `react`, `react-dom`, `react-markdown`, `remark-gfm`. Показ — `packages/doc-render/src/document-markdown.ts:2-3, 76-81`: `remarkPlugins: [remarkGfm]`, `rehypePlugins: [[rehypeDocumentRules, …]]`, `skipHtml: true`. Блок `mermaid` рисуется кодом: «Mermaid и формулы не рисуются» (`docs/plan/67-agent-documents.md:102`).
- **Поиск по всем `package.json` дерева** (кроме `node_modules`): нет `@mui/x-*`, Tiptap, ProseMirror, Lexical, BlockNote, Milkdown, MDXEditor, CodeMirror, сеток, Chart.js, ECharts, Recharts, Vega, Mermaid, Excalidraw, xyflow, Konva, `docx`, `pptxgenjs`, `exceljs`, `xlsx`, `papaparse`, `html-to-image`, DOMPurify, `parse5`. Из близкого есть `jsdom` (dev в web и ui), `sharp` (web), `playwright-core` (`packages/browser-providers`, `infra/preview/browser`), `@playwright/mcp` (`packages/agent-drivers/cli`).
- **График «Использования»** нарисован на `Box` MUI без библиотеки (`apps/web/src/components/billing/usage-activity.tsx:3-10`).
- **Неразрывные пробелы интерфейса** — `apps/web/src/lib/nbsp.ts:1-30`.
- **CSP кабинета** — `apps/web/src/lib/content-security-policy.ts:18-27`: `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `img-src 'self' data: blob: smartcaptcha`, `frame-src 'self' smartcaptcha <страницы>`. Нет `script-src` и `connect-src` (TODO M8 — 15-16).
- **Политика страниц** — `packages/domain/src/pages/headers.ts`:
  - опубликованная страница грузит `https:` картинки, шрифты и медиа (16-20); кадр кабинета — только `data:` и `blob:` (27);
  - `connect-src`, `form-action` и `frame-src` — `'none'` (30); `object-src`, `worker-src`, `manifest-src` и `base-uri` — `'none'` (33-38);
  - `PAGE_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'` (45);
  - `pagePolicy`: `script-src 'unsafe-inline'` для кадра кабинета и `'self' 'unsafe-inline'` для опубликованной страницы (58-75, ветка 63-67);
  - общие заголовки с COOP и CORP `same-origin` и `Permissions-Policy` (101-109).
- **Общие файлы сайтов** — `packages/domain/src/pages/files.ts:91-111`: CORP `cross-origin`, ACAO нет; типы шрифтов `woff2` и `woff` (45-46).
- **Хост страниц** у web отвечает только на `/v/<token>` и `robots.txt` (`apps/web/src/lib/pages-origin.ts:12`, `apps/web/src/proxy.ts:42-44`).
- **Chromium в репозитории.**
  - Образ песочницы: Playwright MCP 0.0.83 и его Chromium, а также `python3-docx`, `python3-openpyxl` и `poppler-utils` (`infra/sandbox/Dockerfile:15-22, 28, 34-36`).
  - Браузерный образ предпросмотра — `mcr.microsoft.com/playwright:v1.63.0-noble` (`infra/preview/Dockerfile:17-29`).
  - Снимок экрана облачного браузера — `packages/browser-providers/src/cloud/cloud-browser.ts:943-972`, вызов `web_screenshot` — `apps/browser/src/sessions/worker-session.ts:1223-1240`.

---

## Не подтверждено

- Срабатывают ли обработчики кабинета и `contenteditable` в кадре `sandbox="allow-same-origin"` без `allow-scripts` во всех трёх движках — спайк §3.4 п. 1.
- Не загрузится ли шрифт с хоста страниц в непрозрачном документе без ACAO; то же для `/_files/` опубликованных страниц.
- Включено ли по умолчанию `kIsolateSandboxedIframes` в Chrome, то есть отдельный ли процесс у песочного кадра; поиск по этому вопросу не дал версии.
- Номера CVE бюллетеней Mermaid и соответствие дат бюллетеням: лимит поиска исчерпан, названия взяты со страницы бюллетеней проекта.
- Будет ли `openDoubleQuote: '«'` у Tiptap Typography; специальной обработки вставки из Word в открытых редакторах не нашёл.
- Пределы бесплатного Pro у Univer, многостолбцовая сортировка в AG Grid Community.
- Дата выпуска SheetJS CE 0.20.3; работа Chart.js и Vega на сервере без DOM; SSR MUI X Data Grid и Recharts; касание и доступность у редакторов и доски — по документации не сверялись.
- Насколько `beautiful-mermaid` совпадает с синтаксисом Mermaid.
- Мост `js` у Pyodide — общеизвестное свойство, в этой работе не перепроверено.

---

## Источники

Реестры и метаданные (читалось 19.11.2026):
- npm: `https://registry.npmjs.org/<пакет>/latest` и `/-/package/<пакет>/dist-tags` — все версии, лицензии, peer-зависимости в таблицах §2.
- deps.dev: `https://api.deps.dev/v3/systems/npm/packages/<пакет>` — даты выпусков.
- bundlephobia: `https://bundlephobia.com/api/size?package=<пакет>@<версия>` — размеры gzip.
- jsDelivr: `https://data.jsdelivr.com/v1/packages/npm/<пакет>@<версия>?structure=flat` — размеры `mermaid.min.js`, `mermaid.tiny.js`, `chart.umd.min.js`, `echarts.min.js`, `reveal.js`, локали ECharts, Excalidraw, AG Grid, MUI X, шрифты Golos Text.
- Ленты GitHub `commits.atom` и `releases.atom` для `vercel/chatbot`, `LibreChat-AI/LibreChat`, `open-webui/open-webui`, `lobehub/lobehub`, `langchain-ai/open-canvas`, `e2b-dev/fragments`, `stackblitz-labs/bolt.diy`, `dyad-sh/dyad`, `onlook-dev/onlook`, `givanz/VvvebJs`, `yuzutech/kroki`, `xyflow/xyflow`, `excalidraw/excalidraw`, `GrapesJS/grapesjs`, `puckeditor/puck`, `mermaid-js/mermaid`, `hakimel/reveal.js`, `marp-team/marp-core`, `slidevjs/slidev`, `apache/echarts`, `recharts/recharts`, `chartjs/Chart.js`, `vega/vega-lite`, `bubkoo/html-to-image`, `qq15725/modern-screenshot`, `zumerlab/snapdom`, `dolanmiu/docx`, `gitbrent/PptxGenJS`, `exceljs/exceljs`, `mholt/PapaParse`.

Эталонные реализации:
- Vercel Chatbot — https://github.com/vercel/chatbot (LICENSE, README, `package.json`, `lib/db/schema.ts`, `lib/db/queries.ts`, `lib/ai/tools/{create,edit,update}-document.ts`, `lib/ai/tools/request-suggestions.ts`, `lib/artifacts/server.ts`, `artifacts/{text,sheet,code,image}/*`, `components/chat/{create-artifact,data-stream-handler}.tsx`, `app/(chat)/api/document/route.ts`, `app/(chat)/layout.tsx`, `lib/editor/suggestions.tsx`); документация — https://chatbot.ai-sdk.dev/docs/customization/artifacts
- LibreChat — https://www.librechat.ai/docs/features/artifacts ; https://www.librechat.ai/docs/configuration/artifacts ; код: `client/src/utils/artifacts.ts`, `client/src/components/Artifacts/{Artifact,ArtifactPreview}.tsx`, LICENSE (https://github.com/LibreChat-AI/LibreChat)
- Open WebUI — https://github.com/open-webui/open-webui (LICENSE, `src/lib/components/chat/Artifacts.svelte`, `src/lib/components/common/FullHeightIframe.svelte`); бюллетени: https://advisories.gitlab.com/pypi/open-webui/CVE-2026-70486/ , https://corgea.com/advisories/vulnerabilities/CVE-2026-87995 , https://advisories.gitlab.com/pypi/open-webui/CVE-2026-26193/ , https://www.sentinelone.com/vulnerability-database/cve-2026-45303/
- LobeHub — LICENSE https://github.com/lobehub/lobehub ; https://lobehub.com/docs/usage/features/artifacts ; копия промпта (сторонняя) https://huggingface.co/spaces/K00B404/HugChatWrap/blob/main/system_prompts.py
- bolt.diy — `app/lib/runtime/message-parser.ts`, `app/types/actions.ts` (https://github.com/stackblitz-labs/bolt.diy)
- Open Canvas — `packages/shared/src/types.ts` (https://github.com/langchain-ai/open-canvas)
- Onlook — README https://github.com/onlook-dev/onlook
- Dyad — LICENSE https://github.com/dyad-sh/dyad ; `@dyad-sh/react-vite-component-tagger` 0.9.0 (тарбол npm)
- `lovable-tagger` 1.3.5 (тарбол npm, `dist/index.js`)
- v0 Design Mode — https://v0.app/docs/design-mode (обновлено 18.11.2026)

Блоки:
- Tiptap Markdown — https://tiptap.dev/docs/editor/markdown ; Typography — https://tiptap.dev/docs/editor/extensions/functionality/typography ; DOCX — https://tiptap.dev/docs/conversion/import/docx/editor-extension ; правило Bold — https://raw.githubusercontent.com/ueberdosis/tiptap/main/packages/extension-bold/src/bold.tsx
- ProseMirror — https://raw.githubusercontent.com/ProseMirror/prosemirror-schema-basic/master/src/schema-basic.ts
- Lexical — https://raw.githubusercontent.com/facebook/lexical/main/packages/lexical/src/nodes/LexicalTextNode.ts ; https://raw.githubusercontent.com/facebook/lexical/main/packages/lexical-markdown/src/index.ts
- BlockNote — https://www.blocknotejs.org/docs/features/export/markdown
- Milkdown `plugin-diff` 7.23.0 (тарбол npm, `lib/*.d.ts`)
- MDXEditor — readme и зависимости `@mdxeditor/editor` 4.5.0 (npm)
- MUI X — https://mui.com/pricing/ ; https://mui.com/x/react-data-grid/formulas/ ; тарбол `@mui/x-data-grid` 9.18.0 (`DataGrid/useDataGridProps.js`, `DataGrid/useDataGridComponent.js`, `hooks/features/pagination/gridPaginationUtils.js`)
- AG Grid — https://www.ag-grid.com/react-data-grid/community-vs-enterprise/
- Univer — https://docs.univer.ai/guides/sheets/pro-features/introduction
- Handsontable — https://handsontable.com/docs/javascript-data-grid/license-key/ ; HyperFormula — https://raw.githubusercontent.com/handsontable/hyperformula/master/LICENSE.txt ; Jspreadsheet CE — https://raw.githubusercontent.com/jspreadsheet/ce/master/LICENSE
- SheetJS — https://cdn.sheetjs.com/ , https://cdn.sheetjs.com/xlsx.lst , https://cdn.sheetjs.com/xlsx-latest/package/package.json
- React Flow — https://github.com/xyflow/xyflow/releases/tag/%40xyflow%2Freact%4013.0.0 ; https://reactflow.dev/learn/advanced-use/ssr-ssg-configuration
- Excalidraw — https://plus.excalidraw.com/docs/sdk/excalidraw/installation ; https://plus.excalidraw.com/docs/sdk/excalidraw/api/props
- GrapesJS — https://grapesjs.com/docs/api/canvas.html ; https://grapesjs.com/docs/getting-started.html
- Puck — https://raw.githubusercontent.com/puckeditor/puck/main/README.md
- Replit frames — https://docs.replit.com/design/frames.md ; Base44 Canvas — https://docs.base44.com/Building-your-app/Canvas.md
- Троттлинг кадров — https://learn.microsoft.com/en-us/deployedge/edge-learnmore-iframe-throttling-display ; https://groups.google.com/a/chromium.org/g/blink-dev/c/op-z7fMMmWY
- parse5 — https://parse5.js.org/interfaces/parse5.ParserOptions.html
- Mermaid — https://mermaid.js.org/config/usage.html ; https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.0.0 ; https://raw.githubusercontent.com/mermaid-js/mermaid/develop/packages/mermaid/src/mermaidAPI.ts ; https://github.com/mermaid-js/mermaid/security/advisories
- `beautiful-mermaid` — readme пакета 1.1.3 (npm), https://github.com/lukilabs/beautiful-mermaid
- Kroki — https://docs.kroki.io/kroki/setup/install/
- reveal.js — https://github.com/hakimel/reveal.js/releases/tag/6.0.0 ; https://revealjs.com/pdf-export/
- Marp CLI — readme `@marp-team/marp-cli` 4.5.1 (npm)
- Vega — https://vega.github.io/vega/usage/interpreter/
- ECharts — https://echarts.apache.org/handbook/en/how-to/cross-platform/server/
- Chrome 131, поля страницы — https://developer.chrome.com/blog/print-margins
- Paged.js — https://pagedjs.org/posts/en/kickstarting-the-next-iteration-of-paged.js
- `html-to-image` 1.11.13 — тарбол npm (`es/clone-node.js`, `es/dataurl.js`, `es/embed-webfonts.js`)
- MDN — https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe ; https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS

Отчёты этой фазы: (локальные копии сессии исследования) (§1–§3, §5, §8), `r7-ideas.md` (§2), `r5-design-tools.md` (§3), `c1-docs-pages.md` (§6, §17).
