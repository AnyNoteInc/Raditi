# Артефакты у агентов для кода и на российском рынке (исследование r4)

Дата: 19.11.2026. Охват: (а) агенты для кода — Google Antigravity, Cursor, Kiro, Devin и Devin Desktop (бывший Windsurf), Amp, Qoder, OpenCode, OpenClaw и Hermes Agent, протоколы A2A и AG-UI; (б) российский рынок — Яндекс (Алиса AI, Алиса AI для бизнеса, Алиса Про и Нейроэксперт, Яндекс Документы, Яндекс Директ), Сбер (ГигаЧат, ГигаЧат Бизнес, GigaPlatform AI Studio), VK, МТС (MWS AI), Tilda, Craftum, uKit.

Метод. Сначала прочитано то, что уже знает репозиторий: `docs/research/2026-11-agent-features/features.md` (раздел «Артефакты», строки OR-70…OR-158; SF-131, SF-133, SF-143, IC-127, IM-25, IM-03) и строки `products.md` по каждому продукту. Затем каждый факт об артефактах перепроверен в первоисточниках (документация, справка, журналы изменений, официальные блоги) и дополнен. Страницы скачивались в (локальные копии страниц сессии исследования; в репозиторий не входят) и читались как данные. Российские продукты в `products.md` не изучались — они изучены здесь впервые.

Обозначения: ✓ — первоисточник продукта; ◐ — вторичный источник (СМИ, обзор, сторонний разбор); ✗ — не подтверждено или документация молчит. Даты — дата публикации источника, если она известна; иначе — «прочитано 19.11.2026».

---

## 1. Главное

1. Слово «артефакт» в интерфейсах российских продуктов не встречено ни разу: ни в справке Алисы AI и Яндекс Документов, ни в строках веб-приложения ГигаЧата, ни у Tilda, Craftum, uKit. Русские продукты говорят «Проекты», «Документы и презентации», «Умный редактор», «Блокнот», «База знаний», «Задачи», «рабочее пространство», «рабочая поверхность». По-русски «артефакт» и «холст» встречены только в переводе западного продукта (GitHub Copilot app: «холст», «рабочий артефакт», «общая интерактивная поверхность»). Для клиента малого бизнеса «артефакт» — жаргон (правило 10 CLAUDE.md).
2. У агентов для кода артефакт почти везде — отдельный объект рядом с чатом, а не сообщение: вкладка боковой панели (Antigravity, Cursor, Devin, Amp, Kiro), со своим списком, карточкой в ленте и (у части) ссылкой. С ноября 2026 тренд — панель не открывается сама: Devin 13.11.2026 убрал самооткрывающиеся вкладки и сделал «рейку» артефактов справа, которая стартует закрытой; Cursor открывает панель по пилюле над полем. Это совпадает с планом 59 Радити.
3. Совместную правку человеком и агентом с ревизиями и разрешением конфликтов по-настоящему описал только Amp (с 02.11.2026): каждое сохранение — новая ревизия; если пока агент работал, человек сохранил новее, правки агента, которые ещё совпадают, применяются, иначе обновление отклоняется и агент сам вливает изменение в новую версию. Агент другого треда может править артефакт и обязан написать в тред артефакта, что и зачем изменил. Это самый близкий образец к запросу владельца.
4. Комментарий к месту как способ управлять агентом — общий приём: Antigravity (комментарии в духе Google Docs к плану, диффу, картинке; уходят со следующим сообщением), Kiro (Markdown Review: «Send N to Kiro»), Cursor и Qoder (выделить элемент на холсте или обвести, написать, отправить). Яндекс Документы дают русскую модель того же: комментарии с «Решенные/Нерешенные» и «Режим рецензирования» с предложенными правками «Принять/Отклонить».
5. Шеринг у агентов для кода почти всегда внутри команды или организации (Cursor, Qoder, Devin, Windsurf Codemaps), публичная ссылка — у Amp («Anyone with the Link»), OpenClaw (публичная беседа), Hermes (гостевые ссылки со сроком). Russian-ready образец ролей и ссылок — Яндекс: «Владелец / Редактор / Участник», «Доступ по ссылке — Все, у кого есть ссылка», «Персональный доступ», «С вами поделились», «Закрыть доступ»; у Алисы AI ссылка на чат живёт 14 дней (90 с Алиса Плюс) и показывает снимок на момент создания.
6. Рабочий объект и публикацию разделяют все, у кого публикация есть: Cursor и Qoder публикуют снимок и обновляют его отдельным действием («Publish» / «Sync»), Kiro Crew публикует веб-приложение в AWS клиента за отдельным разрешением, Tilda — правки в редакторе, публикация страницы отдельно («публикуйте, когда будете довольны результатом»). Это прямо подтверждает требование владельца «страницы и артефакты — разное».
7. Инструменты агента для артефактов, где они названы: OpenCode V2 (30.10.2026, эксперимент) — `artifact_create`, `artifact_read`, `artifact_update`, `artifact_delete` и провайдеры хранения; Hermes — `artifact_publish`, `artifact_list`, `artifact_get`, `artifact_download`, `artifact_share`, `artifact_revoke_share`; Amp — «artifact tool» (Markdown); Antigravity — обычные файловые инструменты с метаданными артефакта; Tilda — MCP-сервер для внешних агентов с ключами на проект, модули, действия и срок.
8. Безопасность HTML-артефактов везде строже обычной страницы: изолированный кадр без доступа к приложению (Antigravity, OpenClaw — opaque origin, без `allow-same-origin`, CSP), без скриптов вовсе (Kiro IDE), без `fetch` — данные вшиты при сборке (Cursor, вторичный источник). Обратный канал «виджет → агент» ограничивают: только по жесту пользователя, до 4 000 знаков, 10 в минуту, без команд «/» (OpenClaw); Antigravity с 22.09.2026 не отправляет запрос из виджета сам, а только заполняет поле.
9. Несколько агентов на одном объекте: Amp (агенты других тредов правят и отчитываются), Kiro (задачи спецификации идут волнами параллельно), Antigravity (субагенты и /teamwork пишут свои артефакты), A2A (уточнение — новая задача в том же `contextId`, версия артефакта — то же имя и новый `artifactId`, историю ведёт клиент), AG-UI (общее состояние снимком и JSON Patch; разрешение конфликтов — забота приложения).
10. На российском рынке артефактов как объекта рядом с чатом нет ни у Алисы AI, ни у ГигаЧата для частных лиц: Алиса собирает презентацию в чате и советует «перенести текст в редактор», ответ «скачать не получится». Ближе всего — «Проекты» ГигаЧата («Документы и презентации», «Умный редактор», правка слайдов, PPTX и PDF) и «Задачи» Алисы AI для бизнеса (DOCX, PDF, XLSX, PPTX). У Tilda «Вайб-блок» — фактически артефакт внутри страницы: чат в блоке, версии, «История изменений» со сравнением и восстановлением, правка выделенного элемента ИИ.

---

## 2. Агенты для кода

### 2.1. Google Antigravity (App v2.33.0 от 17.11.2026, CLI `agy`, IDE)

- **Понятие.** «Artifacts» — «structured deliverable created by the agent», которым агент сообщает ход работы и мысли; нужны для асинхронного ревью на вехах вместо чтения каждого вызова инструмента ✓ [docs/artifacts](https://antigravity.google/docs/artifacts). Блог запуска (20.11.2025): «tangible deliverables like task lists, implementation plans, screenshots, and browser recordings»; «leave feedback directly on the Artifact», и агент учтёт его «without stopping its execution flow» ✓ [блог](https://developers.googleblog.com/en/build-with-google-antigravity-our-new-agentic-development-platform/).
- **Типы.**
  - Implementation plan — Markdown: цель, предлагаемые изменения, дифф ✓ [implementation-plan](https://antigravity.google/docs/implementation-plan/).
  - Task list — чек-лист шагов с прогрессом ✓ [codelab](https://codelabs.developers.google.com/getting-started-agy-ide); имя файла `task.md` и каталог `~/.gemini/antigravity/brain/<id>/` — только вторичные источники ◐ ([разбор](https://justin.poehnelt.com/posts/extracting-gold-from-antigravitys-brain/), [antigravity-cli](https://github.com/michaelw9999/antigravity-cli)).
  - Walkthrough — итог задачи: «Changes Made», «Validation Results», скриншоты и записи браузера ✓ [walkthrough](https://antigravity.google/docs/walkthrough/).
  - Диффы кода, архитектурные схемы (Mermaid), картинки (генерация через субагента), записи браузера WebM, интерактивные HTML-виджеты `/generative_ui` ✓ [artifacts](https://antigravity.google/docs/artifacts).
  - PDF-артефакт — встроенный просмотрщик (v2.28.0, 27.10.2026); Word, Excel, PowerPoint — сообщение со ссылкой на скачивание (v2.21.1, 07.10.2026); SQL и JSONL — виртуализированный просмотрщик с комментариями (v2.13.0, 09.09.2026); «URL artifact cards» для Google Docs, Sheets, Slides, Drive и локального сервера — превью в панели (v2.10.0, 24.08.2026) ✓ [changelog](https://antigravity.google/docs/changelog/).
  - Внешние документы (ссылки Drive, PDF, Office) — отдельный раздел «Documents» над «Artifacts» (v2.13.0) ✓ там же.
- **Где показан.** Боковая панель справа от разговора, каждая вещь — своя вкладка: артефакты, файлы, диффы, терминалы, разговоры субагентов, веб-страницы. «Toggle Side Panel» (Cmd+Shift+B), «Maximize Pane» (Cmd+Shift+M) — панель поверх разговора, «Restore Pane»; закрытие последней вкладки закрывает панель; «Pin Tab»; вернуть вкладку Cmd+Shift+T ✓ [side-panel](https://antigravity.google/docs/side-panel/).
  - «Overview panel» вверху справа: строки Review, Files, Terminal, Extensions; разделы Subagents, Background Tasks, Goals, Documents, Artifacts, Links, Modified Files, Uploads; до четырёх элементов и «See all»; «Customize Sections»; в раскладке «Knowledge Work» (v2.30.0, 09.11.2026) панель скрыта, пока нет результата ✓ там же.
  - Новая вкладка показывает разделы обзора «with documents and artifacts first» (v2.27.0, 26.10.2026) ✓ [changelog](https://antigravity.google/docs/changelog/).
  - Виджет `/generative_ui` по умолчанию — отдельный артефакт в панели; компактный — прямо в ответе, до 500 px высоты ✓ [generative-ui](https://antigravity.google/docs/commands/generative-ui).
  - Телефон: Remote Control — antigravity.google.com в любом браузере под тем же Google-аккаунтом; можно «review implementation plans, and inspect artifacts»; веб-приложение на экран «Домой» с пушами ✓ [remote-control](https://antigravity.google/docs/remote-control/). В CLI v1.5.11 (18.11.2026) вкладки файла и артефакта в Remote Control открываются на всю ширину панели ✓ [changelog](https://antigravity.google/docs/changelog/).
- **Кто правит.** Пишет агент. Человек: выделяет место и пишет комментарий (план, дифф, артефакт, картинка — выделение области и «Add Comment»), жмёт «Proceed» или пишет сообщение без «Proceed» ✓ [implementation-plan](https://antigravity.google/docs/implementation-plan/), [screenshots](https://antigravity.google/docs/screenshots/). С v2.17.0 (22.09.2026) `/plan` даёт «a plan you can read and edit before it writes any code» ✓ [changelog](https://antigravity.google/docs/changelog/). CLI: комментарий к строке — `c`, одобрить или отклонить — `y`/`n`, всё сразу — Shift+A / Shift+R, Esc отправляет решения агенту ✓ [cli/artifacts](https://antigravity.google/docs/cli/artifacts/).
- **Версии.** История и восстановление версий артефакта не описаны ✗. Есть «Refresh» для открытых файлов и артефактов (v2.31.0) и «Undo changes up to this point» в чате (codelab).
- **Совместная работа.** Люди — нет: Remote Control только для своего аккаунта ✓. Агенты — субагенты, `/teamwork`, `/swarm` пишут свои артефакты; комментарии копятся как «pending» и уходят со следующим сообщением или кнопкой «Review» в шапке артефакта ✓ [screenshots](https://antigravity.google/docs/screenshots/); черновики комментариев сохраняются между сессиями (v2.4.3, 28.07.2026) ✓.
- **Шеринг.** В меню разговора с v2.14.0 (15.09.2026) есть «Share» ✓, но что именно он делает, документация не говорит ✗. Ссылка `/remote-control` открывается только на устройстве того же аккаунта ✓.
- **Привязка.** К разговору (раздел «Artifacts» обзора); разговор — к проекту (набору папок) или в CLI к `default-cli-project` ✓ [projects](https://antigravity.google/docs/projects/). Артефакты разговора ищутся через @ (в репозитории, IM-25). База знаний агента — «save useful context and code snippets to a knowledge base» (блог).
- **Инструменты агента.** Обычные файловые инструменты (`write_to_file`, `replace_file_content` и др.) с «artifact details»; рядом с артефактом пишется `.metadata.json` — это видно по исправлениям CLI («... is not a valid artifact path when the model sent blank artifact details»; файлы субагентов «treated as artifacts, which demanded artifact metadata») ✓ [changelog](https://antigravity.google/docs/changelog/). MCP для артефактов нет ✗.
- **Экспорт.** «More actions → Export Artifact» (без цветов темы) ✓ [generative-ui](https://antigravity.google/docs/commands/generative-ui); Markdown артефакта → PDF с таблицами, кодом и Mermaid (v2.19.1, 30.09.2026) ✓; «Copy Image».
- **Безопасность.** Виджет — «isolated frame»: нет доступа к файлам и приложению, нельзя встраивать другие страницы, внешние скрипты запрещены, кроме Tailwind ✓ [generative-ui](https://antigravity.google/docs/commands/generative-ui). Кнопки внутри виджета агенту не пишут; «prompt actions» с v2.16.0 (22.09.2026) только заполняют поле ввода и ставят в него курсор, а не отправляют ✓ [changelog](https://antigravity.google/docs/changelog/).
- **Лимиты, цена.** Встроенный виджет — до 500 px; другие пределы артефактов не найдены ✗.
- **Рабочее и опубликованное.** Публикации нет; есть экспорт.
- **Сценарий ревью плана** ✓ [implementation-plan](https://antigravity.google/docs/implementation-plan/), [artifact-review](https://antigravity.google/docs/artifact-review/):
  1. Режим Planning или `/plan`.
  2. Агент пишет Implementation plan и ждёт ревью при любой политике.
  3. Пользователь выделяет места, пишет комментарии; над полем — чип «2 Comments», наведение показывает все.
  4. «Proceed» с комментариями или сообщение без «Proceed».
  5. Агент правит план и просит ревью снова — или начинает работу.
  6. В ленте: «Proceeded with 2 Comments», сводка, карточка «Walkthrough», строка «3 files changed» с «Review».
  7. Политика: Settings → General → «Plan Review Policy»: «Request review (recommended)» («Always Ask») или «Always proceed» (план после `/plan` всё равно ждёт).

### 2.2. Cursor (Agents Window 3.x; холсты с 3.1 от 15.04.2026)

- **Понятие.** «Canvases let Cursor create interactive artifacts that render next to the chat… you can reopen, edit, and iterate on» ✓ [docs/canvas](https://cursor.com/docs/agent/tools/canvas); в Agents Window холсты — «durable artifacts that live alongside your other tools like the terminal, browser, and source control» ✓ [блог 15.04.2026](https://cursor.com/blog/canvas).
- **Формат.** React: «a React-based UI library with first-party components like tables, boxes, diagrams, and charts», агенту даны и компоненты Cursor «like diffs and to-do lists» ✓ [блог](https://cursor.com/blog/canvas). 3.7 (04.06.2026): «Improved the agent's ability to fix canvas type errors» ✓ [3.7](https://cursor.com/changelog/canvas-improvements) — то есть TypeScript. Один файл `.canvas.tsx` с экспортом по умолчанию, импорт из `cursor/canvas`, каталог `~/.cursor/projects/<workspace>/canvases/`, не в git, рантайм без `fetch()` — сторонний разбор (09.2026) ◐ [mer.vin](https://mer.vin/2026/09/cursor-canvas-live-charts-and-tables-beside-the-chat/). Что холсты лежат в `~/.cursor/projects/…/canvases`, косвенно подтверждает журнал Cursor (ноябрь 2026, правка записи холстов в режиме Plan) ✓ [release-notes](https://cursor.com/docs/release-notes).
- **Типы.** Дашборды, отчёты, аудит, анализ, интерфейс ревью PR, разбор оценок, архитектурная схема (навык Docs Canvas) ✓ [блог](https://cursor.com/blog/canvas); отчёт о расходе контекста (3.7) ✓; с 3.28 (03.11.2026) — страничная раскладка: разделы, диффы, списки задач, полосы расхода, графики, ключевые числа сеткой до четырёх колонок ✓ [release-notes](https://cursor.com/docs/release-notes).
- **Где показан.** Карточка в конце ответа → клик; «Open Canvas» в палитре; вкладка Canvas в Agents Window из меню новой вкладки ✓ [docs/canvas](https://cursor.com/docs/agent/tools/canvas). С 3.24 (09.10.2026) — пилюля «Canvas» над полем открывает и сворачивает панель; панель «opens by itself when there is something new» ✓. Переключатель «Rendered / Source» запоминается (3.27, 22.10.2026); Cmd/Ctrl+F внутри холста (3.25, 14.10.2026); пункт «Canvas» в боковой рейке (3.30, 12.11.2026) ✓ [release-notes](https://cursor.com/docs/release-notes). Телефон — не описано ✗.
- **Кто правит.** Агент; пользователь — правка исходника руками («For small tweaks, you can also manually edit the source code») ✓. Design Mode в холсте (3.7): «Select and annotate UI elements directly in a canvas to guide Cursor's edits» ✓ [3.7](https://cursor.com/changelog/canvas-improvements). Агент может встроить в холст кнопки, которые запускают заданный запрос (3.7) ✓.
- **Версии.** «revert and prompt Cursor again» — механизм отката не детализирован ✗. Список холстов рабочего пространства — «jump back to past ones without rerunning them» ✓.
- **Совместная работа.** Холсты облачных агентов сохраняются в облаке и открываются как превью только на чтение (3.24) ✓. В командном проекте меню «Share» холста показывает проект как «read-only Viewer» (3.28) ✓. Одновременной правки людьми нет ✗.
- **Шеринг.** «Publish» на панели холста → «live snapshot» (раскладка, графики, таблицы) → скопировать ссылку; «Anyone on your team can open the link in the browser with read-only access»; повторный «Publish» обновляет ✓ [docs/canvas](https://cursor.com/docs/agent/tools/canvas). Страница «Shared Canvases» — только свои публикации: открыть, скопировать, удалить ✓. Платные тарифы и членство в команде; режим приватности должен разрешать хранение; админ может выключить ✓. Опубликованный холст — своя страница с «Copy link», «Download as PDF», «Open in full screen» (3.28); печать на белом без колонтитулов браузера (3.25) ✓ [release-notes](https://cursor.com/docs/release-notes).
- **Привязка.** Список холстов рабочего пространства; командный проект; правый клик по ссылке на холст в ленте → «Add to Chat» — чип в поле (3.25) ✓.
- **Инструменты агента.** Встроенный инструмент холста и навык `/canvas`; типовые холсты упаковывают в навыки: триггер, раскладка, источники данных и запросы, правила оформления — «a short prompt is enough to regenerate the canvas with fresh data» ✓ [docs/canvas](https://cursor.com/docs/agent/tools/canvas).
- **Экспорт.** PDF и печать опубликованного холста ✓.
- **Безопасность.** Опубликованное — снимок без перезапуска агента ✓; запрет `fetch()` в рантайме — ◐.
- **Лимиты, цена.** Шеринг — только на платных тарифах и в команде ✓.
- **Рабочее и опубликованное.** Холст (живой, перезапускается со свежими данными) отдельно от опубликованного снимка по ссылке (обновляется повторным «Publish») ✓.

### 2.3. Kiro (AWS): артефакты IDE, спецификации, артефакты и виджеты Kiro Crew

- **Артефакты IDE** ✓ [kiro.dev/docs/ide/chat/artifacts.md](https://kiro.dev/docs/ide/chat/artifacts.md):
  - понятие — «durable outputs that Kiro creates during an IDE chat session», живут, пока живёт сессия;
  - типы — Markdown, Mermaid, код, SVG, HTML, картинки, PDF, документы Office; `.pptx` — текстовым планом; до 12 МБ на артефакт;
  - показ — компактное превью в ленте; в Agent Focus Mode превью раскрывает панель сведений сессии со списком всех артефактов; «Open in IDE»;
  - безопасность — «HTML artifacts do not run scripts»;
  - хранение — в глобальном хранилище приложения по сессиям, вне `.kiro`; это не файлы проекта, в git не попадают; «Save important material somewhere durable»;
  - правка, версии, шеринг, экспорт — не описаны ✗.
- **Спецификации (Specs)** ✓ [kiro.dev/docs/specs.md](https://kiro.dev/docs/specs.md):
  - файлы `requirements.md` (или `bugfix.md`), `design.md`, `tasks.md` в `.kiro/specs/<name>/` — то есть в репозитории; фазы «требования или разбор ошибки → дизайн → задачи»;
  - задачи показывают статус «in-progress / completed»; «run all tasks» строит граф зависимостей и запускает независимые задачи волнами параллельно — несколько агентов на одной спецификации;
  - Kiro Web — чат обновляет файлы спецификации на месте, «Download» отдаёт `.md`; мобильное приложение показывает три документа; контекст `#spec` (IM-25).
- **Markdown Review** ✓ [markdown-review.md](https://kiro.dev/docs/ide/editor/markdown-review.md):
  1. «Review Markdown» в заголовке редактора, команда «Kiro: Review Markdown» или плавающая кнопка «Review» на документе спецификации.
  2. Выделить текст → «Comment» → поле «Comment for Kiro…» → Enter; комментарии видны в панели «Comments» под ближайшим заголовком.
  3. «Send N to Kiro» (Cmd/Ctrl+Enter) — все одной просьбой; в каждом — цитата и место.
  4. Пока агент работает — «Kiro is reviewing...»; панель перерисовывается по мере правки файла.
  5. При успехе отправленные комментарии очищаются; комментарий, чьего текста больше нет, помечается «document updated»; при ошибке комментарии остаются с текстом ошибки.
  6. Неотправленные комментарии пропадают при перезагрузке окна.
- **Kiro Crew** ✓ [kiro.dev/docs/crew/chat/artifacts.md](https://kiro.dev/docs/crew/chat/artifacts.md):
  - виджеты — HTML в сообщении (iframe, Tailwind, переменные темы `var(--bg)`, `var(--text)`, `var(--accent)`); кнопки и формы шлют агенту `[Widget action event]` с данными; агент отвечает, обновляет виджет, вызывает инструменты, запускает субагентов; песочница — «no access to parent origin state, cookies, or storage»;
  - артефакты — «persist beyond the chat session in a dedicated library with version history, folders, and comments»; сохраняются фразой «save this as an artifact» или `kirocrew artifact save --slug <slug>` (занятый slug — отказ, без переименования); «update the artifact» — итерация; у веб-приложений — живое локальное превью на карточке; панель «Artifacts» в дашборде;
  - публикация — «Publish» в меню артефакта на публичный HTTPS-адрес в AWS клиента; нужны профиль AWS, разрешение `capabilities.publish` и адрес из `publish.allowed_destinations`; «Publishing is never a default destination»;
  - выкладка (Artifact Deploy, 04.08.2026) — агент предлагает план (ресурсы, регион, оценка стоимости), клиент подтверждает в консоли; раздел с адресом, сроком жизни (TTL) и сносом ◐ [поиск по docs/crew/features/artifact-deploy](https://kiro.dev/docs/crew/features/artifact-deploy/).
- **Рабочее и опубликованное.** IDE — артефакт сессии отдельно от файлов проекта; Crew — библиотека отдельно от публикации в AWS.

### 2.4. Devin (веб) и Devin Desktop (бывший Windsurf)

- **Devin, веб** ✓ [release-notes/2026](https://docs.devin.ai/release-notes/2026):
  - «Open HTML, PDF and SVG Attachments in a New Tab» (05.10.2026) — вложение открывается своей страницей вместо скачивания;
  - «Richer Artifacts, Shown Inline» (26.10.2026) — HTML-артефакты (отчёты, дашборды, таблицы, графики) на наборе компонентов в стиле приложения, агент встраивает артефакт прямо в сообщение;
  - «Redesigned Share Artifact Dialog» (06.11.2026) — задать имя ссылки и опубликовать, затем имя и адрес с кнопкой копирования, варианты доступа и строка «General access» — кто в организации может смотреть;
  - «Session Sharing: Account Defaults and an Organization Cap» (06.11.2026) — видимость новых сессий «Account, read-only» или «Account, read and write», запрет делиться вне организации;
  - «Artifacts Rail Beside the Chat» (13.11.2026) — вкладки рабочей области больше не открываются сами; PR, «Changes», превью, виды Desktop и Agents, «Plan», цитаты и вложения — компактная рейка справа от чата (подписи по наведению, клик открывает); панель запоминает своё состояние по сессии и стартует закрытой; вкладки, которые не артефакты (Findings, Inbox, Todo), — в меню добавления вкладки;
  - Markdown и `.patch` открываются отрисованными с переключением на исходник (в репозитории, OR-102);
  - версии артефактов, совместная правка, рендер и его песочница — не описаны ✗; страницы документации об артефактах нет ✗ ([devin-session-tools](https://docs.devin.ai/work-with-devin/devin-session-tools) о них молчит).
- **Devin Desktop: планы** ✓ [devin-local/modes](https://docs.devin.ai/desktop/devin-local/modes.md), [cascade/modes](https://docs.devin.ai/desktop/cascade/modes.md), [windsurf planning-mode](https://docs.windsurf.com/windsurf/cascade/planning-mode):
  - режим Plan пишет Markdown-план в `~/.windsurf/plans` или `~/.devin/plans` — вне репозитория, на время сессии, в git не попадает;
  - план правят и человек, и агент в любой момент; «Implement» на файле плана переключает в режим кода; план можно упомянуть через @ и продолжить с ним в новом контексте.
- **Devin Desktop: Codemaps** ✓ [codemaps](https://docs.devin.ai/desktop/codemaps):
  - «shareable artifacts that bridge the gap between human comprehension and AI reasoning» — иерархическая карта хода выполнения и связей кода;
  - строит «Codemap agent» по предложенной теме (из недавней навигации) или по запросу; открывается во вкладке редактора, узел ведёт к файлу и функции; @-упоминание в поле агента;
  - шеринг — ссылка для коллег в браузере, «only available within your Team and require authentication»; для корпоративных команд выключено по умолчанию, потому что шеринг хранит карту на серверах Devin;
  - правка и версии — не описаны ✗.

### 2.5. Amp (артефакты с 02.11.2026)

- **Понятие.** «An artifact is a document attached to a thread that you, your teammates, and the agent edit together» — для того, «what people will read: a plan, a report, notes from a call, or findings gathered from several threads» ✓ [docs/threads#artifacts](https://ampcode.com/docs/threads). Агент пишет артефакт сам, когда есть что почитать, вместо длинного ответа ✓ [news 02.11.2026](https://ampcode.com/news/artifacts).
- **Типы.** Заголовки, списки, чек-листы, таблицы, код, картинки, «interactive views»; в тред можно встраивать «visuals» ✓. «Visualize This» (29.10.2026): графики, хронологии, схемы, кликабельные макеты прямо в треде ✓ [news](https://ampcode.com/news/visualize-this). Для идей интерфейса — сравниваемые интерактивные прототипы (в репозитории, OR-93).
- **Где показан.** «Views → Artifacts» в любом треде; артефакт открывается рядом с тредом; ссылка в ленте открывает его во вкладке «Artifacts», даже если его написал другой тред; переключатель артефактов группирует по тредам; на широком экране рядом с заголовком — ссылка «from» на тред-источник ✓. На телефоне тред продолжается (приложения iOS, Android); как выглядит артефакт — ✗.
- **Кто правит.** Человек — как обычный документ: отметить пункт, поправить таблицу, переписать абзац ✓ [news](https://ampcode.com/news/artifacts). Агент — «artifact tool», читает и пишет Markdown, есть во всех режимах и в Spaces; «Ask Amp» внутри артефакта — правка открытого артефакта ✓. Агент, вернувшись, «reads your edits first and works them in instead of writing over them» ✓.
- **Версии и конфликты.** «Each save makes a new revision. If someone saved a newer revision while the agent worked, edits that still match are applied to it; otherwise the agent's update is refused and it merges its change into the newer version instead of overwriting it» ✓ [docs/threads](https://ampcode.com/docs/threads).
- **Несколько агентов.** «The agent of another thread, such as a child thread, can also edit an artifact when you could edit it yourself, and it then sends the artifact's thread a message saying what it changed and why. Share shows which thread's agent made the last edit» ✓. Агент может скопировать артефакт в свой тред — новый артефакт без комментариев оригинала; удалить артефакт может только его тред ✓.
- **Шеринг артефакта** ✓:
  - «Share → General Access»: «Same as the thread» (по умолчанию: все, кто может открыть тред, со входом или без, и дальше следует за доступом треда), «Your workspace» (каждый участник пространства — читать, но не править, даже без доступа к треду), «Anyone with the Link» (без входа);
  - меню предлагает только варианты шире доступа треда; менять доступ могут только владелец треда и создатель артефакта; править могут все участники пространства, кому открыт тред, включая Viewer'ов;
  - админ выключает публичные ссылки настройкой «Allow Sharing Outside the Workspace» — тогда такие артефакты переходят на доступ пространства и остаются так после обратного включения;
  - «Copy Link»; «Download» — Markdown, HTML или печать в PDF;
  - «You can also ask the agent to share an artifact. It asks you to approve in a dialog before more people can open it».
- **Привязка.** К треду: удаление треда удаляет его артефакты; папки внутри треда; картинки хранятся с тредом ✓.
- **Совместная работа людей (Spaces).** Роли «Contributor» и «Viewer», «Request to Contribute»; «Comment on a message to discuss it among people; Amp does not read comments until someone mentions @amp in one» ✓ [docs/spaces](https://ampcode.com/docs/spaces). В треде — «Multiplayer», роли «Viewer / Contributor» ✓ [docs/threads](https://ampcode.com/docs/threads).
- **Лимиты.** До 2 МБ на артефакт ✓; вложения до 100 МБ (до 512 МБ на повышенном пределе) ✓ [files-and-attachments](https://ampcode.com/docs/orbs/files-and-attachments).
- **Рабочее и опубликованное.** Файл можно «опубликовать» по публичному адресу (метка «Public»), отдельно от артефакта: «Only publish a file when it is safe for anyone with the URL to access it» ✓ [files-and-attachments](https://ampcode.com/docs/orbs/files-and-attachments).
- **Рендер и безопасность** интерактивных видов — не описаны ✗.

### 2.6. Qoder: холст

✓ [docs.qoder.com/extensions/canvas.md](https://docs.qoder.com/extensions/canvas.md):

- **Понятие и формат.** Стандартный файл `.canvas.tsx`: агент создаёт и правит его, каждая правка сразу видна в превью холста; команда `/canvas`.
- **Два вида.** «Inline visualization» — снимок внутри ответа, без интерактивного состояния и дальнейших действий агента; «Standalone Canvas» — артефакт для повторных правок, пометок и интерактива.
- **Пометки.** Войти в режим пометок → щёлкнуть элемент или обвести область от руки → написать, что изменить → отправить: пометка прикрепляется к беседе, агент меняет исходник и перерисовывает.
- **Шеринг** — только Teams и Enterprise, только внутри организации, не публично:
  1. «Publish» → подтверждение «All team members can view» → кнопка становится «Published».
  2. Меню «Published»: «Sync» (обновить опубликованное до текущего, «Last synced just now»), «Copy link», «Unpublish» (ссылка перестаёт работать), «View published Canvas».
  3. «My Shares» в консоли администратора: имя, время публикации или синхронизации, «Copy link», «Delete».
- **Повторное использование.** Холст оформляется навыком: триггер, раскладка, источники данных, правила оформления.
- **Не описано** ✗: где лежат файлы, версии, роли кроме «смотреть», безопасность рендера, лимиты, экспорт. В репозитории: DOCX, XLSX и PPT с ручной правкой в просмотрщике, Markdown с правкой (OR-73).

### 2.7. OpenCode (V2)

- **Артефакты** ✓ [v2.2.4, 30.10.2026](https://github.com/anomalyco/opencode/releases/tag/v2.2.4):
  - включаются флагом `"experimental": { "artifacts": true }` в `opencode.json` — «to let agents publish, update, and serve HTML or static artifacts»;
  - инструменты `artifact_create`, `artifact_read`, `artifact_update`, `artifact_delete`;
  - встроенный локальный провайдер статических файлов и провайдеры плагинов через `ctx.experimental.artifact.transform(...)`: провайдеры, возможности, подсказки агенту, провайдер по умолчанию;
  - SDK: `client.experimental.artifacts.providers`, `list`, `create`, `get`, `update`, `delete`, `view`.
- **Шеринг.** Встроенный провайдер отдаёт артефакты с сервера OpenCode — это не публичный сайт ◐ [rohitai.com](https://rohitai.com/blog/opencode-interactive-reports-artifacts-hosting). Кто может открыть — не описано ✗.
- **Шеринг бесед прекращён** в 1.19.1 (15.10.2026): «Session sharing has been discontinued. Existing share links and session-sharing commands are no longer available», причина не названа ✓ [v1.19.1](https://github.com/anomalyco/opencode/releases/tag/v1.19.1).

### 2.8. OpenClaw и Hermes Agent

- **OpenClaw, `show_widget`** ✓ [tools/show-widget](https://docs.openclaw.ai/tools/show-widget):
  - что рисует — самодостаточный HTML- или SVG-виджет (`widget_code`) или структурный «report» на родных компонентах; в веб-панели и приложениях iOS, Android, macOS, Linux; в Discord — кнопка «Open widget»;
  - безопасность — opaque origin, строгая CSP, кадр без `allow-same-origin`; CDN-скрипты, стили и шрифты — только из закрытого списка; `fetch`, WebSocket, произвольные картинки, вложенные кадры и `unsafe-eval` закрыты; синтаксис встроенного JS проверяется до показа;
  - обратный канал `sendPrompt(text)` — только по жесту пользователя, непустой, до 4 000 знаков, без «/», не больше 10 в минуту, ответа виджет не получает; в нативных приложениях моста нет;
  - хранение — встроенные виджеты сохраняются и восстанавливаются; «Canvas» держит до 32 виджетов на сессию (новый вытесняет старейший);
  - доска — `pin: true` кладёт виджет на дашборд сессии со своей личностью и разрешениями (`capabilityState`: `none`, `pending`, `rejected`, `granted`);
  - экспорт — копия или PNG; на телефоне — изолированные непостоянные web view;
  - лимиты — HTML и SVG до 10 МиБ, отчёт до 8 КБ JSON и 1–24 блоков.
- **OpenClaw, дашборды** ✓ [web/dashboards](https://docs.openclaw.ai/web/dashboards):
  - закрепить — «Pin to dashboard» или просьбой; виджеты с устойчивыми именами, обновление по имени заменяет содержимое (версий нет);
  - разрешения — `net` (объявленные HTTPS-адреса), `data` (только чтение данных шлюза, токен виджету не даётся), `actions`, `prompt`; решает режим прав сессии («Full access», «Auto-review», «Ask me», «Read only»); разрешение привязано к точным байтам виджета — изменённый HTML требует нового решения;
  - правка — человек двигает и меняет размер, агент — инструмент `dashboard` (создать, обновить, переместить, удалить, вкладки); учёт `contentOwner`.
- **OpenClaw, публичная беседа** ✓ [sessions-and-sidebar](https://docs.openclaw.ai/web/control-ui/sessions-and-sidebar):
  1. «Session sharing» → «Anyone with the link» → «Make public» → «Copy public link», QR-код, метка «Public».
  2. Видно: текст, картинки, сохранённые встроенные виджеты, сводки шагов; скрыто: сырой вывод инструментов, мысли, закреплённые виджеты дашборда.
  3. Новые сообщения появляются у читателей сами; «Disable public access» закрывает доступ, но «cannot recall saved copies»; секреты не маскируются.
- **Hermes Agent.** Вид «Artifacts» на десктопе — картинки, файлы и ссылки всех сессий в одной галерее с поиском (в репозитории, OR-84). Плагин «Artifacts» v0.1.0 (ранний доступ, Hermes ≥ 0.21.5) ✓ [docs/plugins/artifacts](https://hermes-agent.nousresearch.com/docs/plugins/artifacts):
  - «Private library for the finished documents agents make»: HTML, Markdown, SVG, PNG, WebP;
  - инструменты `artifact_publish`, `artifact_list`, `artifact_get`, `artifact_download`, `artifact_share`, `artifact_revoke_share`;
  - данные — в отдельной службе «Artifacts» (`HERMES_ARTIFACTS_URL`, `HERMES_ARTIFACTS_TOKEN`; токен — только на сервере);
  - гостевые ссылки «explicit, expiring, revocable», по одной на артефакт; «Sharing creates a public bearer link…; revocation cannot recall copies»;
  - версии — не описаны ✗.

### 2.9. Протоколы

- **A2A 1.0.0** ✓ [спецификация](https://a2a-protocol.org/latest/specification/), [Life of a Task](https://a2a-protocol.org/latest/topics/life-of-a-task/):
  - `Artifact`: `artifactId` (уникален в задаче), `name`, `description`, `parts` (хотя бы одна), `metadata`, `extensions`;
  - `Part` — ровно одно из `text`, `raw`, `url`, `data`, плюс `filename`, `mediaType`, `metadata`;
  - `TaskArtifactUpdateEvent`: `taskId`, `contextId`, `artifact`, `append` («appended to a previously sent artifact with the same ID»), `lastChunk`, `metadata`;
  - «Messages SHOULD NOT be used to deliver task outputs. Results SHOULD BE returned using Artifacts»;
  - уточнение — новая задача в том же `contextId`;
  - «Tracking Artifact Mutation»: агент сохраняет то же `artifact-name` и даёт новый `artifactId` каждой версии; историю версий ведёт клиент, он же принимает или отклоняет версии и называет, какой артефакт уточнять; связь версий в протокол не входит.
- **AG-UI** ✓ [concepts/state](https://docs.ag-ui.com/concepts/state):
  - общее состояние агента и приложения; `STATE_SNAPSHOT` заменяет состояние целиком (старт, ресинхронизация, новая база);
  - `STATE_DELTA` — массив операций JSON Patch (RFC 6902: add, remove, replace, move, copy, test); при несостыковке клиент просит свежий снимок;
  - менять состояние могут обе стороны; разрешение конфликтов протокол не задаёт («Implement strategies for resolving conflicting updates»);
  - человек исправляет агента правкой полей состояния (пример — предлагаемое письмо, которое одобряют, отклоняют или правят); пример CopilotKit `useCoAgent`.
- **MCP Apps** (в репозитории, OR-80, OR-135): UI-ресурс `ui://` в песочнице iframe, режимы показа (встроенно, во весь экран, картинка в картинке), `ui/open-link`, `ui/download-file`, контекст хоста, размер и закрытие.

### 2.10. Для словаря: GitHub Copilot app (русская локализация)

Вне охвата r4, но это единственное найденное место, где «холст» и «артефакт» стоят в русском интерфейсе ✓ [docs.github.com/ru](https://docs.github.com/ru/copilot/how-tos/github-copilot-app/working-with-canvas-extensions):

- «Расширение Canvas — это общая, интерактивная поверхность для рабочего артефакта, такого как план, доска сортировки, сессия браузера, чек-лист релиза, панель управления, инцидент или таблица»;
- «Холсты двусторонние: агент может обновлять холст во время работы, а вы можете редактировать на той же поверхности»; холст открывается в правой боковой панели;
- холст с общим доступом команды лежит в `.github/extensions` репозитория, личный — в `~/.copilot/extensions`; навык `/create-canvas`.

---

## 3. Российский рынок

### 3.1. Яндекс

**Алиса AI — чат** (alice.yandex.ru; приложения «Алиса AI», «Яндекс — с Алисой», Яндекс Браузер; MAX и Telegram) ✓ [chat-alice.md](https://alice.yandex.ru/support/ru/assistant/chat-alice.md):

- Артефактов и холста нет ✗ (в справке нет ни раздела, ни слова). Ответ — сообщение: «Скачать ответ не получится. Но вы можете скопировать его» ✓ [files.md](https://alice.yandex.ru/support/ru/assistant/chat/files.md).
- Файлы на вход — DOC, DOCX, PDF, TXT до 100 МБ, один файл в сообщении ✓ там же.
- Презентация собирается в чате: план, тексты, картинки для слайдов; «Готовый текст перенесите в редактор и дополните картинками»; в чат — только один документ ✓ [create-presentations](https://alice.yandex.ru/skills/create-presentations).
- **Шеринг чата** ✓ [share.md](https://alice.yandex.ru/support/ru/assistant/chat/share.md):
  1. Компьютер: в списке чатов «⋯» → «Поделиться чатом» или в открытом чате «Поделиться»; телефон: удержать значок «Поделиться» → окно «Поделиться чатом» → «Создать ссылку и поделиться».
  2. Отдельный ответ — значок «Поделиться» под сообщением; по ссылке откроются только этот запрос и ответ.
  3. «Получатель ссылки сможет не только прочитать ваш диалог, но и продолжить общение с Алисой AI, опираясь на ваш контекст».
  4. По ссылке виден диалог до момента её создания; последующие сообщения — нет; фото и файлы не видны.
  5. Ссылка действует 14 дней, с Алиса Плюс — 90; открыть может «любой человек, у которого есть эта ссылка»; делиться могут только вошедшие.
  6. Настройки → «Управление ссылками»: перейти в чат, скопировать или удалить ссылку — удаление закрывает доступ всем.
- **Хранение** ✓ [storage.md](https://alice.yandex.ru/support/ru/assistant/chat/storage.md): без Алиса Плюс чат хранится 90 дней от создания (картинки — 14), с ней — бессрочно (картинки — 30).
- **ИИ-агенты** (бета, набор закрыт) — в том числе заметки: «Превратит поток дел, идей и задач в удобные заметки» ✓ [agents.md](https://alice.yandex.ru/support/ru/assistant/chat/agents.md).

**Алиса AI для бизнеса** (Яндекс 360) ✓ [index](https://alice.yandex.ru/support/ru/assistant/alice-business/index.md), [tasks](https://alice.yandex.ru/support/ru/assistant/alice-business/tasks.md), [knowledge-bases](https://alice.yandex.ru/support/ru/assistant/alice-business/knowledge-bases.md):

- Режимы «Чаты» и «Задачи». В «Задачах» (боковое меню → «Задачи» → «Новая задача») ассистент «готовит отчеты, сводки, черновики ответов и презентации (в том числе в формате PPTX)».
- Раздел «Работать вместе с Алисой AI над файлами»: на выходе — DOCX, PDF, TXT, MD, XLSX, PPTX; на входе — тексты, таблицы, презентации, картинки, аудио и видео до 300 МБ.
- «Плагины» с режимами «Всегда спрашивать», «Включить», «Отключить».
- **«База знаний»** — «пространство для долгосрочной работы над задачей или материалами по одной теме»:
  - до 25 файлов или ссылок (у ссылки — поиск по всем подстраницам); блок «Инструкции»; несколько чатов по одним источникам («Чаты» → «Создать чат»);
  - шеринг — «Поделиться базой знаний»: «Доступ по ссылке» → «Все, у кого есть ссылка» (смотреть источники и спрашивать; чужие диалоги и настройки закрыты) или «Персональный доступ» по Яндекс Почте с ролью и письмом-приглашением;
  - роли «Владелец» (создаёт, управляет, выдаёт доступ; сменить нельзя), «Редактор» (меняет источники, настраивает, управляет доступом), «Участник» (задаёт вопросы);
  - приглашённым база видна в «С вами поделились»; закрыть доступ — «Настройки базы знаний» → «Доступ к базе знаний» → «Закрыть доступ»;
  - генерации файлов и плагинов в базе знаний нет — это место для ответов по источникам.
- Тарификация для платных тарифов Яндекс 360 — со 02.12.2026 ◐ [ppc.world](https://ppc.world/articles/alisa-ai-dlya-biznesa-chto-umeet-ii-assistent-yandeksa-360-instrukciya-po-podklyucheniyu/).

**Алиса Про и Нейроэксперт** (личное пользование):

- Адрес Нейроэксперта (expert.ya.ru) сейчас ведёт на `alicepro.yandex.ru/expert` (проверено 19.11.2026).
- «Проекты» — «Новый проект»; до 25 источников (файлы и ссылки, «Добавить ссылку» с поиском по одной странице или всему сайту); инструкция проекта ✓ [creation](https://yandex.ru/support/yandex-360/customers/alice-pro/ru/projects/creation.md).
- Роли «Владелец / Редактор / Участник»; «Поделиться проектом»; «Доступ по ссылке» (строка «Участники» → «Все, у кого есть ссылка») или «Персональный доступ» по почте с ролью; чаты участника «видны только ему»; чужие проекты — в «С вами поделились» ✓ [collaboration](https://yandex.ru/support/yandex-360/customers/alice-pro/ru/projects/collaboration.md).
- Для организаций Алису Про заменила Алиса AI для бизнеса; старые проекты «доступны в режиме просмотра по ссылке» ✓ [alice-business/faq](https://alice.yandex.ru/support/ru/assistant/alice-business/faq.md).

**Яндекс Документы** (Яндекс 360):

- **«ИИ-редактор»** (бывший «Редактор с Алисой Про») ✓ [ai-editor.md](https://yandex.ru/support/yandex-360/customers/documents/editor/ru/ai-editor.md):
  - «Помочь с текстом» — новый текст или переделка выделенного по свободной просьбе (перевод, примеры, адаптация, списки и таблицы);
  - на выделенное — «Другими словами», смена стиля («Проще»), «Исправить ошибки», «Улучшить текст»;
  - без тарифа Яндекс 360 — 30 запросов в месяц; «При совместной работе над документом каждый пользователь расходует собственный лимит»; неуспешный запрос лимит не тратит.
- **Доступ** ✓ [sharing/share.md](https://yandex.ru/support/yandex-360/customers/documents/editor/ru/sharing/share.md):
  1. Контекстное меню → «Поделиться».
  2. «Просмотр» или «Редактирование» (разные права разным людям — «пока нельзя»).
  3. На платных тарифах — «Установить пароль», «Запретить скачивание» (у получателя пропадают «Скачать», «Сохранить на Яндекс Диск», «Напечатать»), срок ссылки — «Бессрочно» или дата.
  4. «Скопировать».
  5. Одновременно — до 100 человек.
- **Комментарии** ✓ [sharing/comments.md](https://yandex.ru/support/yandex-360/customers/documents/editor/ru/sharing/comments.md): выделить → значок (или «Добавить комментарий» в меню) → текст; править — автор, удалять — автор и владелец; ✓ — решено; «Вид» → «Показать комментарии» → панель «Комментарии» с фильтром «Все», «Нерешенные», «Решенные»; комментировать могут только те, у кого есть право редактирования.
- **«Режим рецензирования»** ✓ [llms-full.txt](https://yandex.ru/support/yandex-360/customers/documents/editor/ru/llms-full.txt): предложить добавление, замену («Заменить: … На: …»), удаление, форматирование и смену стиля, не меняя оригинала; «Включить для себя» или «Включить для всех»; каждую правку — принять ✓ или отклонить ✗; рядом — автор и суть правки.
- **Конфликт сохранений** ✓ [sharing/deadlock.md](https://yandex.ru/support/yandex-360/customers/documents/editor/ru/sharing/deadlock.md): сохраняются изменения, первыми попавшие на сервер; остальным предлагают сохранить копию «Имя файла (копия от ДД.ММ.ГГГГ ЧЧ:ММ:СС)».
- **Версии.** Автосохранение и «восстановить одну из предыдущих версий» через Диск ✓ (там же).

**Яндекс Директ — генератор лендингов** (16.09.2025) ◐ [postium](https://postium.ru/yandeks-direkt-zapustil-generator-sajtov/): лендинг за 10 минут в веб-версии Директа, можно добавить блоки и поменять структуру; после публикации — аналитика, формы заявок и реклама; ссылкой делятся как сайтом. Артефакта нет — сразу сайт.

**YandexGPT** — семейство моделей (сейчас — модели Alice AI) и API; своего интерфейса артефактов нет, глубже не изучалось ✗.

### 3.2. Сбер: ГигаЧат

**Веб-приложение ГигаЧата** (сборка gigachat-neo 0.15.5; строки интерфейса прочитаны в публичных скриптах giga.chat 19.11.2026 ✓ — прочитаны, не исполнялись):

- **Боковое меню:** «Новый чат», «Мои чаты», «Блокнот», «Мои заказы», «Проекты» (подпись «Документы и презентации»), «Инструменты», «Маркетплейс агентов», «Видео», «Идеи», «Подкасты», «Задачи», «Персонажи», «Умный редактор»; до входа: «Создавайте и редактируйте тексты и презентации с помощью умных команд». Модули — отдельные подключаемые приложения `giga-editor`, `giga-editor-text`, `giga-editor-presentation`, `giga-projects`.
- **«GIGA Проекты» — презентации** ✓ [vc.ru, блог Сбера, 14.10.2025](https://vc.ru/sber/2274339-gigachat-ot-sbera-sozdaet-prezentatsii):
  1. Веб-версия → «GIGA Проекты».
  2. «Создать презентацию».
  3. Задать тему, прикрепить документы или ссылку.
  4. ГигаЧат строит структуру, тезисы и идеи картинок (картинки рисует Kandinsky).
  5. «Готовый результат можно отредактировать сразу или скачать в формате pptx (PowerPoint) или pdf». На 14.10.2025 — бета.
- **Урок Сбера для предпринимателей** ✓ [sberbusiness.live](https://sberbusiness.live/kursy/tsifrovizatsia-urok-3-ii-funktsii-v-gigachate-poleznie-predprinimatelyu) (без даты):
  - «Проекты — создание презентаций и улучшение текстов»;
  - «Редактор» — новый текст или существующий: «выделить главную мысль, переписать текст в другом стиле, сократить или расписать подробнее, исправить ошибки, а также перевести»;
  - презентации — число слайдов, тон, графики и диаграммы, «редактировать слайды после генерации», PPTX и PDF;
  - «Исследование» — документ с классической структурой и источниками; «Память».
- **Шеринг** (строки интерфейса) ✓: «Поделиться чатом», «Поделиться ответом», «Ссылка на чат скопирована», «Ссылка на сообщение скопирована», «Не удалось получить ссылку», «Поделиться можно после получения полного ответа», «Доступно после сохранения чата на сервере», «Функция недоступна для вашего аккаунта», «Поделиться в Telegram». Срок ссылки, роли и отзыв — не найдены ✗.
- **«Блокнот»** (эксперимент, модуль `plugin-notebook` 0.2.0 для части пользователей, флаг `exp-web-notebook-test`) ✓ [манифест](https://giga.chat/static-configs/api/v0/common/config-ui?key=PLUGINS_MANIFEST_WEB_V0): кнопка у сообщения — «Сохранить в блокнот», «Ответ сохранен в блокнот», «Фрагмент сохранен в блокнот».
- **Исследование** скачивается в DOCX (ключ `deepresearch.download-docx`) ✓.
- Версии, совместная работа, шеринг проектов — не найдены ✗.

**ГигаЧат Бизнес (GigaChat Enterprise)** ✓ [sber.pro, 03.03.2026](https://sber.pro/publication/shtat-ii-sotrudnikov-vnutri-kompanii-sber-predstavil-gigachat-biznes-gigachat-enterprise/); ◐ [Инк., партнёрский материал, 20.03.2026](https://incrussia.ru/pnews/sber-predstavil-ii-rabochee-mesto-na-baze-gigachat-biznes-vse-zadachi-v-odnom-okne/):

- конструктор агентов, «Сотрудники могут делиться ИИ-агентами с другими коллегами», ролевая модель доступа, файлы до 5 ГБ;
- «единое рабочее пространство»; «Универсальная рабочая поверхность „ГигаЧат Бизнес“ сохраняет единый контекст: все рабочие материалы — тексты, таблицы, изображения и ссылки — хранятся в рамках одного диалога или проекта»; презентация по корпоративному шаблону из прикреплённого файла.

**GigaPlatform AI Studio** (13.10.2026) ✓ [sber.pro](https://sber.pro/publication/sber-predstavil-servis-v-kotorom-chastnie-polzovateli-mogut-sozdavat-ii-agentov/): визуальный конструктор агентов из блоков (модель, база знаний, голос, сценарий), вход по Сбер ID. Артефактов нет.

### 3.3. VK

- **VK WorkSpace** (23.09.2026) ◐ [anti-malware.ru](https://www.anti-malware.ru/news/2026-09-23-111332/51515):
  - единый «ИИ-Ассистент»: сначала по перепискам Мессенджера (ответ со ссылками на исходные сообщения), позже Почта, Диск и Календарь; доступ — в пределах прав сотрудника;
  - MCP-сервер, через который ИИ-агенты ищут информацию, готовят материалы к встречам и действуют внутри сервисов: On-Premise 26.3, облако — с октября; сначала Мессенджер, до конца года — Почта, Диск, Календарь.
- **VK AI Space** (30.04.2026) ◐ [Рамблер](https://finance.rambler.ru/business/56384371-vk-tech-predstavil-platformu-dlya-razrabotki-i-zapuska-ii-agentov/): платформа агентов с изолированным контуром на агента; библиотека агентов — суммаризация, перевод, поиск, подготовка документов, протоколы встреч.
- Потребительского ассистента с холстом или артефактами не найдено ✗; «Маруся» с 2024 года не в приоритете ◐ [Sostav](https://www.sostav.ru/blogs/284069/102095).

### 3.4. МТС: MWS AI

- **MWS AI Cowork** (27.10.2026) ✓ [Sostav, со слов компании](https://www.sostav.ru/publication/mws-ai-zapustila-ii-agenta-dlya-resheniya-ofisnykh-zadach-88073.html):
  - агент с чатом, который ищет и анализирует данные и «создает документы, таблицы, презентации и отчеты»;
  - подключается к почте, календарям, мессенджерам, хранилищам, CRM и СЭД, действует от имени пользователя в пределах его прав;
  - «Пользователи могут создавать и передавать коллегам собственные инструкции — так называемые навыки»; память можно смотреть, менять и удалять;
  - закрытый контур в России; лицензия — 6–20 млн ₽ в год.
- **MWS AI Agents Platform 4.0** (17.10.2026) ◐ [www1.ru](https://www1.ru/news/2026/10/17/mws-ai-uprostila-sozdanie-korporativnyx-ii-agentov-i-dobavila-poisk-po-skanam.html): модуль «ИИ-команда» (AI Force) — агента описывают в чате, конфигурацию правят вручную. Интерфейса артефактов не найдено ✗.

### 3.5. Tilda

- **«Вайб-блок»** ✓ [help-ru.tilda.cc/tilda-ai/vibe-block](https://help-ru.tilda.cc/tilda-ai/vibe-block); ◐ запуск 13.05.2026 [Postium](https://postium.ru/tilda-dobavila-instrument-vajb-blok/). Это блок в библиотеке, который «генерирует свой контент с помощью ИИ по вашему запросу» — по сути артефакт внутри страницы:
  1. Добавить вайб-блок из «Библиотеки блоков» → ввести запрос в поле чата блока → «Отправить».
  2. Выбрать модель ИИ; прикрепить картинку, файл или видео (как содержимое или образец); примеры промптов: «Взять код», «Применить промпт».
  3. Ответ «блок готов»; у запроса — кнопки копирования, повтора и удаления.
  4. «Код» в верхней панели — редактор кода блока.
  5. Версии: по умолчанию показана последняя; значок глаза — предыдущая, «Применить» — вернуть её; чтобы сохранить, достаточно закрыть чат; снова открыть — «Редактировать c AI».
  6. Щелчок по элементу — панель стиля и контента; панель слоёв; «Редактировать с ИИ» у элемента подставляет в запрос путь к нему; поле «Контент»; брейкпоинты.
  7. «История изменений» (значок часов): список версий → «⋯» → посмотреть изменения, сравнить текущую и предыдущую или восстановить.

  Ещё: «Создание вайб-блока с DESIGN.md», «Конвертация вайб-блока в Zero», подключение Каталога и CMS «Потоки». Сгенерированные блоки берут глобальные стили сайта ✓ [tilda.cc/ru/lp/ai](https://tilda.cc/ru/lp/ai/). Лимиты: Personal и Business — до 50 запросов за 12 часов и 100 в месяц ✓; бесплатно — 5 за 12 часов и 20 в месяц ◐ (Postium).
- **MCP-сервер Тильды** ✓ [tilda.cc/ru/lp/mcp](https://tilda.cc/ru/lp/mcp/), [help-ru.tilda.cc/mcp](https://help-ru.tilda.cc/mcp) — «Управляйте Тильдой через AI-агентов: Claude, Cursor, Codex»:
  1. «Профиль» → «MCP-сервер» → «Новый ключ».
  2. Название, тип доступа (полный или ограниченный — с выбором модулей и действий), проект, срок от 1 часа до бессрочного (менять потом нельзя).
  3. «Создать ключ» — ключ показывается один раз → «Готово»; столбец «Использован»; «Редактировать» доступ можно в любой момент.
  4. Скопировать готовый промпт в приложение агента (только десктопные приложения, не браузерные).
  5. Агент правит страницы и блоки, Zero Block (дизайн, анимация, адаптивы), Каталог, «Потоки», переносит готовый HTML, работает с CRM, Members, курсами.
  6. «Всё, что сделал агент, видно в редакторе Тильды. Проверьте, поправьте вручную, если нужно, и публикуйте, когда будете довольны результатом».
  7. Тарифы Personal и Business.
- **Рабочее и опубликованное.** Правки (свои, ИИ, агента) живут в редакторе; публикация страницы — отдельный шаг.

### 3.6. Craftum AI и uKit AI

- **Craftum AI** ✓ [ai.craftum.com](https://ai.craftum.com/): «Создайте сайт за 3 минуты с помощью нейросети»; шаги «Напишите запрос» → «Запустите генерацию сайта» → «Внесите последние штрихи» (поправить текст, заменить картинки); заявлены «ChatGPT-4o» и картинки Unsplash; дальше — обычный визуальный редактор. Артефактов нет.
- **uKit AI** ✓ [ukit.com/ru/ai](https://ukit.com/ru/ai): «Перенесите сайт с любой платформы или опишите, какой сайт нужен, — uKit AI подготовит дизайн, тексты и структуру за 10 минут. Дальше редактируйте всё в конструкторе uKit без кода». Артефактов нет.

---

## 4. Сравнительная таблица

### 4.1. Агенты для кода

| Продукт | Как называется объект | Типы | Где показан | Кто правит | Версии | Несколько людей или агентов | Шеринг | Привязка | Инструменты агента | Рабочее и опубликованное |
|---|---|---|---|---|---|---|---|---|---|---|
| Antigravity | Artifacts | план, список задач, итоги, дифф, схемы, картинки, записи, HTML-виджеты, PDF/Office, карточки URL | вкладки справа, Overview, карточки в ленте; Remote Control в браузере телефона | агент; человек — комментарии, Proceed, правка плана | ✗ | субагенты, /teamwork; люди — нет | «Share» в меню разговора ✗ | разговор → проект | файловые инструменты + `.metadata.json`, `/generative_ui` | публикации нет, экспорт PDF |
| Cursor | Canvases | React (`.canvas.tsx` ◐): дашборд, отчёт, аудит, схемы, задачи | вкладка Canvas, пилюля над полем, Rendered/Source | агент; человек — исходник, Design Mode | revert ✗ | облачные агенты; проект — Viewer | Publish → снимок, только команда, платно | рабочее пространство, проект | инструмент холста, `/canvas`, навыки | снимок по ссылке отдельно от живого холста |
| Kiro IDE | Agent Artifacts | MD, Mermaid, код, SVG, HTML без JS, картинки, PDF, Office | превью в ленте, панель сессии | агент | ✗ | — | ✗ | сессия (не проект) | ✗ | — |
| Kiro Specs | Specs | requirements, design, tasks | редактор, Markdown Review | агент и человек | git | задачи волнами параллельно | через репозиторий | `.kiro/specs/` | процесс Spec | — |
| Kiro Crew | Artifacts, Widgets | документы, код, веб-приложения, виджеты | библиотека «Artifacts», виджеты в ленте | агент | история версий, папки, комментарии | виджет → агент | Publish в AWS клиента | библиотека | `kirocrew artifact save` | библиотека отдельно от публикации |
| Devin | Artifacts | HTML-отчёты и дашборды, HTML/PDF/SVG, MD, патчи | в сообщении, рейка справа (закрыта по умолчанию) | агент | ✗ | сессии на чтение или запись | Share artifact — организация, «General access» | сессия | ✗ | ссылка-публикация в организации |
| Devin Desktop | Plans, Codemaps | план MD; карта кода | вкладки редактора | план — оба; карта — агент | ✗ | — | Codemaps — команда, со входом | `~/.devin/plans`; сервер Devin | Codemap agent | — |
| Amp | Artifacts | документ: таблицы, чек-листы, код, картинки, интерактивные виды | вкладка Artifacts рядом с тредом | человек и агент («Ask Amp») | ревизии; агент не перезаписывает, а вливает | агенты других тредов правят и отчитываются | как тред / пространство / все по ссылке; агент спрашивает разрешения | тред, папки | artifact tool (Markdown) | файлы — отдельный «Publish» |
| Qoder | Canvas | `.canvas.tsx`: карточки, таблицы, графики | превью холста | агент; человек — пометки | ✗ | — | Publish — организация; Sync, Unpublish | беседа | `/canvas`, навыки | Sync опубликованного |
| OpenCode | experimental.artifacts | HTML и статика | ✗ | агент | ✗ | — | провайдер ✗ | ✗ | `artifact_create/read/update/delete` | — |
| OpenClaw | Widgets, Dashboards | HTML/SVG, отчёты | в ленте, дашборд, панель Mac | агент; человек — раскладка | замена по имени | — | публичная беседа | сессия | `show_widget`, `dashboard` | закреплённый виджет с разрешениями |
| Hermes | Artifacts | HTML, MD, SVG, PNG, WebP | галерея | агент | ✗ | — | гостевые ссылки со сроком | библиотека | `artifact_publish/list/get/download/share/revoke_share` | библиотека отдельно от гостевой ссылки |
| A2A | Artifact | части text/raw/url/data | — | агент | на стороне клиента | новая задача в том же контексте | — | задача, контекст | `TaskArtifactUpdateEvent` append/lastChunk | — |
| AG-UI | Shared state | любой JSON | — | агент и приложение | — | обе стороны; конфликты на приложении | — | прогон | STATE_SNAPSHOT, STATE_DELTA | — |

### 4.2. Российский рынок

| Продукт | Объект | Типы | Где | Кто правит | Версии | Совместная работа | Шеринг | Привязка | Агент и API | Рабочее и опубликованное |
|---|---|---|---|---|---|---|---|---|---|---|
| Алиса AI (чат) | нет (сообщение) | текст, картинки, план презентации | лента чата | — | — | — | ссылка на чат или ответ: снимок, 14/90 дней, «Управление ссылками» | чат | агенты (бета) | — |
| Алиса AI для бизнеса | «Задачи», «База знаний» | DOCX, PDF, TXT, MD, XLSX, PPTX | чат задачи | агент | ✗ | роли Владелец/Редактор/Участник | «Доступ по ссылке», «Персональный доступ» | пространство организации | плагины, MCP ✗ | — |
| Алиса Про / Нейроэксперт | «Проекты» | источники, ответы | страница проекта | агент | — | роли, чаты видны только себе | как у базы знаний | личный кабинет | — | — |
| Яндекс Документы | документ | текст, таблицы | редактор | человек + «ИИ-редактор» на выделенное | версии через Диск | до 100 человек, комментарии, рецензирование | «Просмотр / Редактирование», пароль, срок, запрет скачивания | Диск | — | — |
| ГигаЧат | «Проекты», «Умный редактор», «Блокнот» | тексты, презентации | раздел «Проекты» | агент; правка слайдов и текста | ✗ | ✗ | ссылка на чат или ответ | аккаунт | — | скачать PPTX, PDF |
| ГигаЧат Бизнес | «рабочая поверхность» | тексты, таблицы, картинки, ссылки | диалог или проект | агенты | ✗ | агентами делятся с коллегами | ролевая модель | проект | конструктор агентов | — |
| VK WorkSpace | нет | — | — | — | — | — | — | — | MCP-сервер для агентов | — |
| MWS AI Cowork | нет (файлы) | документы, таблицы, презентации, отчёты | чат | агент | ✗ | навыки — коллегам | ✗ | — | подключения к системам | — |
| Tilda | «Вайб-блок» | HTML/CSS/JS-блок | на странице в редакторе | человек и ИИ, правка элемента ИИ | версии, «История изменений» со сравнением | команда в проекте | — | страница, проект | MCP-сервер (ключи: проект, модули, действия, срок) | публикация страницы — отдельно |
| Craftum AI, uKit AI | нет | сайт | конструктор | генератор, затем человек | — | — | — | сайт | — | сайт сразу |

---

## 5. Словарь русских слов интерфейса

Слова, которые продукты реально показывают. «Артефакт» в российских продуктах не встречен.

| Слово | Где встречено | Что значит | Источник |
|---|---|---|---|
| Поделиться | Алиса AI, ГигаЧат, Яндекс Документы | открыть окно доступа или создать ссылку | [share.md](https://alice.yandex.ru/support/ru/assistant/chat/share.md), строки giga.chat, [share.md Документов](https://yandex.ru/support/yandex-360/customers/documents/editor/ru/sharing/share.md) |
| Поделиться чатом / Поделиться ответом | Алиса AI, ГигаЧат | ссылка на весь чат или на один ответ | там же |
| Создать ссылку и поделиться | Алиса AI (телефон) | создать ссылку-снимок | [share.md](https://alice.yandex.ru/support/ru/assistant/chat/share.md) |
| Управление ссылками | Алиса AI (настройки) | список своих ссылок: открыть, скопировать, удалить | там же |
| Ссылка на чат скопирована / Ссылка на сообщение скопирована | ГигаЧат | уведомление | строки giga.chat |
| Поделиться можно после получения полного ответа | ГигаЧат | ссылку нельзя создать, пока идёт ответ | строки giga.chat |
| Доступно после сохранения чата на сервере | ГигаЧат | гость или несохранённый чат | строки giga.chat |
| Поделиться базой знаний / Поделиться проектом | Алиса AI для бизнеса, Алиса Про | окно доступа к объекту | [knowledge-bases](https://alice.yandex.ru/support/ru/assistant/alice-business/knowledge-bases.md), [collaboration](https://yandex.ru/support/yandex-360/customers/alice-pro/ru/projects/collaboration.md) |
| Доступ по ссылке — Все, у кого есть ссылка | там же | любой со ссылкой, с ограниченными правами | там же |
| Персональный доступ | там же | приглашение по почте с ролью | там же |
| Пригласить / Участники | Алиса AI для бизнеса | добавить человека | там же |
| С вами поделились | Алиса AI для бизнеса, Алиса Про | раздел чужих объектов, открытых вам | там же |
| Закрыть доступ / Доступ к базе знаний | Алиса AI для бизнеса | отозвать доступ | там же |
| Владелец / Редактор / Участник | Алиса AI для бизнеса, Алиса Про | роли: создатель; правит и управляет доступом; только спрашивает | там же |
| Просмотр / Редактирование | Яндекс Документы | права по ссылке | [share.md](https://yandex.ru/support/yandex-360/customers/documents/editor/ru/sharing/share.md) |
| Установить пароль / Запретить скачивание / Бессрочно / Скопировать | Яндекс Документы | настройки ссылки | там же |
| Добавить комментарий / Показать комментарии / Все — Нерешенные — Решенные | Яндекс Документы | комментарии к фрагменту | [comments.md](https://yandex.ru/support/yandex-360/customers/documents/editor/ru/sharing/comments.md) |
| Режим рецензирования / Рецензирование — Включить для себя / Включить для всех | Яндекс Документы | предложенные правки | [llms-full.txt](https://yandex.ru/support/yandex-360/customers/documents/editor/ru/llms-full.txt) |
| Заменить: … На: … / Добавить / Форматировать | Яндекс Документы | подпись предложенной правки | там же |
| ИИ-редактор / Помочь с текстом / Другими словами / Проще / Исправить ошибки / Улучшить текст | Яндекс Документы | правка выделенного ИИ | [ai-editor.md](https://yandex.ru/support/yandex-360/customers/documents/editor/ru/ai-editor.md) |
| Задачи / Новая задача / Чаты | Алиса AI для бизнеса | режим долгой работы с файлами | [tasks](https://alice.yandex.ru/support/ru/assistant/alice-business/tasks.md) |
| Работать вместе с Алисой AI над файлами | Алиса AI для бизнеса | раздел справки о файлах на входе и выходе | там же |
| База знаний / Источники / Инструкции / Добавить источники | Алиса AI для бизнеса, Алиса Про | контекст проекта | [knowledge-bases](https://alice.yandex.ru/support/ru/assistant/alice-business/knowledge-bases.md) |
| Плагины — Всегда спрашивать / Включить / Отключить | Алиса AI для бизнеса | доступ ассистента к сервисам | [tasks](https://alice.yandex.ru/support/ru/assistant/alice-business/tasks.md) |
| Проекты — «Документы и презентации» | ГигаЧат | раздел готовых документов | строки giga.chat |
| Умный редактор | ГигаЧат | редактор текстов и презентаций с ИИ | строки giga.chat |
| Создать презентацию / GIGA Проекты | ГигаЧат | запуск генерации презентации | [vc.ru](https://vc.ru/sber/2274339-gigachat-ot-sbera-sozdaet-prezentatsii) |
| Блокнот / Сохранить в блокнот / Фрагмент сохранен в блокнот | ГигаЧат (эксперимент) | собрать ответы и фрагменты | модуль plugin-notebook |
| Мои чаты / Добавить в Избранное | ГигаЧат | список чатов | строки giga.chat |
| единое рабочее пространство / универсальная рабочая поверхность | ГигаЧат Бизнес (СМИ) | место, где лежат материалы диалога или проекта | [Инк.](https://incrussia.ru/pnews/sber-predstavil-ii-rabochee-mesto-na-baze-gigachat-biznes-vse-zadachi-v-odnom-okne/) |
| навыки | MWS AI Cowork | инструкции для агента, которыми делятся | [Sostav](https://www.sostav.ru/publication/mws-ai-zapustila-ii-agenta-dlya-resheniya-ofisnykh-zadach-88073.html) |
| Вайб-блок / Взять код / Применить промпт / Код / Применить / Редактировать c AI | Tilda | генерируемый блок и действия с ним | [vibe-block](https://help-ru.tilda.cc/tilda-ai/vibe-block) |
| Редактировать с ИИ (у элемента) / Контент / Брейкпоинты | Tilda | точечная правка | там же |
| История изменений | Tilda | список версий, сравнение, восстановление | там же |
| MCP-сервер / Новый ключ / Создать ключ / Использован / полный и ограниченный доступ / срок действия ключа | Tilda | доступ внешних агентов | [mcp](https://help-ru.tilda.cc/mcp) |
| Напишите запрос / Запустите генерацию сайта / Внесите последние штрихи | Craftum AI | шаги генератора | [ai.craftum.com](https://ai.craftum.com/) |
| холст / расширения холста / рабочий артефакт / общая интерактивная поверхность | GitHub Copilot app (русская локализация) | Canvas | [docs.github.com/ru](https://docs.github.com/ru/copilot/how-tos/github-copilot-app/working-with-canvas-extensions) |

---

## 6. Что взять Радити

Привязка к тому, что уже есть: вкладка «Документы» справа (планы 67, 74: страницы `.html` и тексты `.md`, версии по имени файла, документ по разделам `doc_*` с проверкой `core`), раздел «Страницы» и сайты из страниц (планы 69, 73: `page_*`, версии v1, v2…, пароль, корзина, 410), проекты (план 84: инструкции, контекст, память), правая панель по «+» (план 59), Telegram (план 80), запланированные задачи (план 82).

1. **Граница «артефакт — страница».** Артефакт — рабочий объект: по умолчанию личный, с ревизиями, комментариями, доступом людям с ролями; может быть черновиком, холстом из нескольких макетов, таблицей. Страница — публикация на `<slug>.pages.raditi.ru`: публичный адрес, пароль, снятие (410), сайт из страниц. Мостик — действие «Опубликовать как страницу»: выбранная ревизия HTML-артефакта становится версией страницы. На артефакте — метка «Опубликовано: версия 7 из 9» и «Обновить публикацию» (как «Sync» у Qoder и повторный «Publish» у Cursor). Обратный путь — «Сделать черновик из страницы» для переделки. Так поступают Cursor, Qoder, Kiro Crew и Tilda.
2. **Ревизии и конфликты — как у Amp.** Каждое сохранение (человека или агента) — новая ревизия с автором («вы», «агент чата «…»», «задача «…»») и строкой «что и зачем». Агент правит с указанием ревизии, от которой отталкивался: точечные замены, которые всё ещё совпадают, применяются к новой ревизии; иначе — отказ с текущим текстом, и агент сам вливает свою правку. Это продолжает уже существующий `expectedVersion` у страниц.
3. **История — как у Tilda.** «История изменений»: список ревизий с автором и временем → «Посмотреть изменения» (текстовый дифф или два макета рядом) → «Восстановить» (новая ревизия, ничего не удаляется).
4. **Комментарии к месту вместо описания словами.** Привязка комментария к фрагменту текста, элементу HTML (селектор) или области макета (кадр и прямоугольник) — как у Antigravity, Qoder и Cursor Design Mode. Пачка уходит агенту кнопкой «Отправить агенту (N)» (Kiro «Send N to Kiro») или упоминанием агента в комментарии (Amp читает комментарии людей только при @amp). Статусы «Решено / Не решено» и фильтр — как в Яндекс Документах. Это закрывает строки OR-79 и IM-03 репозитория.
5. **Предложенные правки.** Когда документ правит кто-то ещё или им поделились с редакторами, агент пишет не поверх, а «предложенными правками» с «Принять / Отклонить» по каждой — модель «Режима рецензирования» Яндекс Документов и одобрения в CLI Antigravity.
6. **Несколько агентов.** Любой чат пользователя (и проекта) читает и правит артефакты, которые может править сам пользователь. Правка из другого чата оставляет строку в чате, где артефакт родился: «Агент чата «Цены» изменил раздел «Доставка»: …» (Amp). Плюс замок на раздел длинного документа, пока агент его пишет (уже есть `doc_*`). Запланированная задача может обновлять «отчёт» свежими данными — как перезапуск холста у Cursor; в проходе без надзора — только новой ревизией с меткой «Обновлено задачей «…»» или предложенными правками.
7. **Семейство MCP `artifacts`** (имена — по образцу OpenCode и Hermes и в духе наших `page_*`):
   - `artifact_list(project?, kind?, shared?)`;
   - `artifact_read(id, revision?, range? | frame?)`;
   - `artifact_create(kind, title, content, project?)`;
   - `artifact_edit(id, base_revision, edits[{old, new}])` и `artifact_write(id, base_revision, content)`;
   - `artifact_section_write` (длинный текст) и `artifact_frame_put` (макет на холсте);
   - `artifact_comments(id, status?)`, `artifact_comment_reply`, `artifact_comment_resolve`;
   - `artifact_share_propose` — только карточка подтверждения клиенту: Amp спрашивает разрешения, прежде чем открыть доступ шире;
   - `artifact_publish_page` — мостик к `page_publish`;
   - `artifact_copy(id, to_project?)`, `artifact_delete` и `artifact_restore` (корзина 30 дней, как у страниц);
   - каждый ответ возвращает номер ревизии.
8. **Потоковое заполнение.** Артефакт появляется сразу, части дописываются по ходу (`append` / `lastChunk` у A2A); для длинного текста это уже частично есть (план 74, проверка раздела во время хода). Для холста — макет за макетом.
9. **Шеринг по-русски, по образцу Яндекса.** Окно «Поделиться»:
   - «Только вы» / «Все, у кого есть ссылка» / «Персональный доступ» (по почте);
   - роли «Просмотр», «Комментирование», «Редактирование» (комментировать и править — только после входа);
   - срок ссылки («Бессрочно» или дата; у Алисы по умолчанию 14 дней), «Установить пароль», «Запретить скачивание»;
   - «Управление ссылками» и «Закрыть доступ»; раздел «С вами поделились»;
   - внешнему человеку — снимок (как у Алисы: «по ссылке виден диалог до момента её создания»), приглашённому — живой артефакт;
   - получатель может «Скопировать к себе» — копия в своё пространство без комментариев (Amp, ремикс SF-143).
10. **Привязка к проекту или к пользователю.** `project_id` необязателен; «Перенести в проект…» — как у чатов. Артефакты проекта видны в его колонке и могут быть отмечены «Использовать как контекст» — как источники базы знаний Алисы и проекта Алисы Про (до 25 источников). В поле ввода — упоминание артефакта через «@» (Antigravity, Windsurf, Kiro `#spec`, Cursor «Add to Chat»).
11. **Где показывать.** Вкладка справа рядом с «Браузером» и «Документами», открывается по клику; сама — только при первом создании в текущем чате, если панель закрыта, иначе точка на «+». Это правило плана 59 и подход Devin (рейка, стартует закрытой). В кабинете — раздел-библиотека с фильтрами «Все», «Мои», «С вами поделились», «По проектам», «Корзина» и поиском (Hermes Artifacts view, Cursor canvas list, Kiro Crew library). На телефоне — артефакт на весь экран с «Назад» (Antigravity Remote Control открывает артефакт на всю ширину). В Telegram — ссылка и картинка-превью.
12. **Типы первой очереди** — те, что владелец назвал:
    - «Документ» — Markdown, разделы, оглавление;
    - «Страница» — HTML-прототип;
    - «Холст» — доска из нескольких макетов: экраны сайта, варианты А/Б/В рядом, переключатель «компьютер — планшет — телефон», комментарии на макетах. Аналоги: Amp «Visualize This» с вариантами, Cursor и Qoder `.canvas.tsx`, Tilda «Вайб-блок».
13. **Типы второй очереди для малого бизнеса:**
    - «Таблица» (CSV с графиком; прайс, меню, остатки);
    - «Схема» (Mermaid или SVG: путь клиента, структура сайта);
    - «Презентация» (HTML-слайды с PDF; паритет с ГигаЧатом и Алисой для бизнеса, где есть PPTX);
    - «Форма или опрос» (ответы копятся в базе артефакта);
    - «План работ» (чек-лист со статусами, агент отмечает — Antigravity task list, Kiro tasks);
    - «Бриф сайта» (требования → дизайн → задачи, как спецификации Kiro);
    - «Фирменный стиль» (DESIGN.md: цвета, шрифты, тон — его читают все макеты и страницы проекта; у Tilda есть «Создание вайб-блока с DESIGN.md»);
    - «Письмо или рассылка», «Пост для VK и Telegram» (превью ленты), «Коммерческое предложение» (документ → PDF или DOCX), «Карта сайта» (из дерева страниц), «Отчёт по заявкам» (обновляется задачей по расписанию).
14. **Внешние агенты через MCP — как у Tilda.** Ключ на проект (или артефакт) с типом доступа «полный / ограниченный» (виды и действия), сроком от часа до бессрочного, показом один раз и столбцом «Использован». Так «несколько агентов» включает и Claude, Codex, Cursor самого клиента.
15. **Безопасность рендера — как у страниц, но строже для интерактива.** Отдельный origin в песочнице без `allow-same-origin`, CSP с `connect-src 'none'` по умолчанию. Мост «виджет → агент» только заполняет поле ввода (Antigravity с v2.16.0) по жесту пользователя, до 4 000 знаков, с пределом частоты и без команд «/» (OpenClaw). Доступ к данным (база формы, данные проекта) — разрешением на конкретную ревизию: OpenClaw привязывает разрешение к байтам виджета.
16. **Экспорт.** MD, HTML, PDF (печать, как у Amp и Cursor), DOCX для текста (`python-docx` уже есть в образе песочницы), PNG макета (OpenClaw).
17. **Деньги.** Правку агентом оплачивает тот, кто попросил (как в Яндекс Документах «каждый пользователь расходует собственный лимит»); просмотр и комментарий по ссылке — бесплатны; обновление по расписанию — из кредитов владельца задачи.

## 7. Чего избегать

1. **Слово «артефакт» в интерфейсе клиента.** Ни один российский продукт его не использует, для малого бизнеса это жаргон (правило 10). Варианты: раздел «Материалы» или «Наработки», виды «Документ», «Страница», «Холст» или «Макет», «Таблица», «Схема», «Презентация», «Форма»; во внутреннем коде — `artifact`. Решает владелец.
2. **Самооткрывающиеся панели.** Devin 13.11.2026 их убрал; у Радити это уже правило плана 59.
3. **Перезапись правок человека агентом.** Нужны ревизии и правило Amp «применить, что совпадает, иначе отказ и слияние». Вариант Яндекс Документов «первый, кто сохранил, побеждает, остальным — копия» годится людям, но не агенту.
4. **Автоотправка запросов из HTML.** Antigravity отказался от неё 22.09.2026, OpenClaw требует жеста и ставит пределы.
5. **Публичные ссылки без срока и без предупреждения.** OpenClaw и Hermes прямо пишут, что отзыв не возвращает скопированное. Алиса не показывает по ссылке файлы и фото, OpenClaw — вывод инструментов и мысли. Значит, нужен срок по умолчанию, предупреждение «копии не отозвать» и правило, чего ссылка не показывает.
6. **Хранить артефакт только в сессии.** Kiro IDE хранит по сессиям и советует «Save important material somewhere durable»; планы Windsurf — вне репозитория на время сессии. Радити нужна постоянная библиотека.
7. **Сеть из артефакта к данным клиента без явного разрешения.** Kiro не исполняет скрипты в HTML, Cursor вшивает данные при сборке, OpenClaw выдаёт разрешения по одному.
8. **Один объект для черновика и публикации.** Все, у кого есть публикация, разделяют их: снимок и «Sync».
9. **Две линии продукта с разной моделью доступа.** Яндекс перевёл организации с Алисы Про на Алису AI для бизнеса, и старые проекты остались «в режиме просмотра по ссылке». Модель ролей и ссылок нужна одна сразу для личных и проектных артефактов.
10. **Шеринг, который потом приходится закрывать.** OpenCode 15.10.2026 прекратил шеринг сессий без объяснения. До запуска ссылок нужны жалобы, снятие поддержкой (у страниц уже есть `pages:take-down`) и запрет внешних ссылок для пространства.
11. **Агент, который читает все комментарии людей.** Это стоимость и приватность: Amp читает комментарий, только когда к нему обратились.
12. **Неясная оплата совместной работы.** Кто платит за правку агентом общего артефакта — правило нужно записать заранее (правило 7).

## 8. Не подтверждено и открыто

- Antigravity: что делает «Share» в меню разговора; есть ли история версий артефактов; путь `~/.gemini/antigravity/brain` и имя `task.md` — только вторичные источники.
- Cursor: формат `.canvas.tsx`, каталог и запрет `fetch` — вторичный источник (09.2026); поведение на телефоне.
- Kiro IDE: можно ли править артефакт и есть ли версии; Kiro Crew: как нумеруются и сравниваются версии.
- Devin: версии артефактов и безопасность рендера HTML.
- Amp: безопасность рендера «interactive views»; вид артефакта на телефоне.
- Qoder: где лежат файлы, версии, экспорт.
- OpenCode: кто открывает артефакт встроенного провайдера.
- ГигаЧат: срок и отзыв ссылок, история версий в «Проектах», совместная работа; «Блокнот» — эксперимент для части пользователей.
- Нейроэксперт: роли по ссылке (закрытый, частично открытый, публичный) — из СМИ ◐ [3DNews](https://3dnews.ru/1125432/yandeks-obnovil-neyroeksperta-ii-nauchilsya-rassugdat-i-analizirovat-sayti-tselikom); справка Алисы Про подтверждает роли проекта, но не варианты «закрытый / публичный».
- Tilda: справка о «Вайб-блок странице» ответила 403; бесплатные лимиты вайб-блока — из Postium.
- ГигаЧат в «МойОфис Документах» (июль 2026, тест) — только СМИ, не проверялось.

## 9. Источники

Агенты для кода:

- Antigravity: [docs/artifacts](https://antigravity.google/docs/artifacts), [implementation-plan](https://antigravity.google/docs/implementation-plan/), [artifact-review](https://antigravity.google/docs/artifact-review/), [walkthrough](https://antigravity.google/docs/walkthrough/), [cli/artifacts](https://antigravity.google/docs/cli/artifacts/), [side-panel](https://antigravity.google/docs/side-panel/), [generative-ui](https://antigravity.google/docs/commands/generative-ui), [screenshots](https://antigravity.google/docs/screenshots/), [plan](https://antigravity.google/docs/plan/), [projects](https://antigravity.google/docs/projects/), [remote-control](https://antigravity.google/docs/remote-control/), [changelog](https://antigravity.google/docs/changelog/) (до v2.33.0 от 17.11.2026), [блог 20.11.2025](https://developers.googleblog.com/en/build-with-google-antigravity-our-new-agentic-development-platform/), [codelab](https://codelabs.developers.google.com/getting-started-agy-ide); ◐ [Poehnelt](https://justin.poehnelt.com/posts/extracting-gold-from-antigravitys-brain/), [antigravity-cli](https://github.com/michaelw9999/antigravity-cli).
- Cursor: [docs/canvas](https://cursor.com/docs/agent/tools/canvas), [блог 15.04.2026](https://cursor.com/blog/canvas), [3.7 от 04.06.2026](https://cursor.com/changelog/canvas-improvements), [release-notes](https://cursor.com/docs/release-notes) (3.24–3.30, 09.10–12.11.2026); ◐ [mer.vin 09.2026](https://mer.vin/2026/09/cursor-canvas-live-charts-and-tables-beside-the-chat/).
- Kiro: [ide/chat/artifacts](https://kiro.dev/docs/ide/chat/artifacts.md), [specs](https://kiro.dev/docs/specs.md), [markdown-review](https://kiro.dev/docs/ide/editor/markdown-review.md), [crew/chat/artifacts](https://kiro.dev/docs/crew/chat/artifacts.md); ◐ [artifact-deploy](https://kiro.dev/docs/crew/features/artifact-deploy/).
- Devin: [release-notes/2026](https://docs.devin.ai/release-notes/2026), [release-notes/overview](https://docs.devin.ai/release-notes/overview), [devin-session-tools](https://docs.devin.ai/work-with-devin/devin-session-tools), [codemaps](https://docs.devin.ai/desktop/codemaps), [devin-local/modes](https://docs.devin.ai/desktop/devin-local/modes.md), [cascade/modes](https://docs.devin.ai/desktop/cascade/modes.md), [windsurf planning-mode](https://docs.windsurf.com/windsurf/cascade/planning-mode).
- Amp: [docs/threads](https://ampcode.com/docs/threads), [news/artifacts 02.11.2026](https://ampcode.com/news/artifacts), [news/visualize-this 29.10.2026](https://ampcode.com/news/visualize-this), [files-and-attachments](https://ampcode.com/docs/orbs/files-and-attachments), [spaces](https://ampcode.com/docs/spaces), [agent-to-agent](https://ampcode.com/docs/orbs/agent-to-agent).
- Qoder: [extensions/canvas](https://docs.qoder.com/extensions/canvas.md).
- OpenCode: [v2.2.4](https://github.com/anomalyco/opencode/releases/tag/v2.2.4), [v1.19.1](https://github.com/anomalyco/opencode/releases/tag/v1.19.1); ◐ [rohitai.com](https://rohitai.com/blog/opencode-interactive-reports-artifacts-hosting).
- OpenClaw: [show-widget](https://docs.openclaw.ai/tools/show-widget), [dashboards](https://docs.openclaw.ai/web/dashboards), [sessions-and-sidebar](https://docs.openclaw.ai/web/control-ui/sessions-and-sidebar). Hermes: [plugins/artifacts](https://hermes-agent.nousresearch.com/docs/plugins/artifacts).
- A2A: [specification](https://a2a-protocol.org/latest/specification/), [life-of-a-task](https://a2a-protocol.org/latest/topics/life-of-a-task/). AG-UI: [concepts/state](https://docs.ag-ui.com/concepts/state).
- GitHub Copilot app (ru): [working-with-canvas-extensions](https://docs.github.com/ru/copilot/how-tos/github-copilot-app/working-with-canvas-extensions).

Российский рынок:

- Алиса AI: [chat-alice](https://alice.yandex.ru/support/ru/assistant/chat-alice.md), [share](https://alice.yandex.ru/support/ru/assistant/chat/share.md), [storage](https://alice.yandex.ru/support/ru/assistant/chat/storage.md), [files](https://alice.yandex.ru/support/ru/assistant/chat/files.md), [agents](https://alice.yandex.ru/support/ru/assistant/chat/agents.md), [create-presentations](https://alice.yandex.ru/skills/create-presentations).
- Алиса AI для бизнеса: [index](https://alice.yandex.ru/support/ru/assistant/alice-business/index.md), [tasks](https://alice.yandex.ru/support/ru/assistant/alice-business/tasks.md), [knowledge-bases](https://alice.yandex.ru/support/ru/assistant/alice-business/knowledge-bases.md), [faq](https://alice.yandex.ru/support/ru/assistant/alice-business/faq.md); ◐ [ppc.world](https://ppc.world/articles/alisa-ai-dlya-biznesa-chto-umeet-ii-assistent-yandeksa-360-instrukciya-po-podklyucheniyu/).
- Алиса Про: [projects/collaboration](https://yandex.ru/support/yandex-360/customers/alice-pro/ru/projects/collaboration.md), [projects/creation](https://yandex.ru/support/yandex-360/customers/alice-pro/ru/projects/creation.md); ◐ [3DNews](https://3dnews.ru/1125432/yandeks-obnovil-neyroeksperta-ii-nauchilsya-rassugdat-i-analizirovat-sayti-tselikom).
- Яндекс Документы: [ai-editor](https://yandex.ru/support/yandex-360/customers/documents/editor/ru/ai-editor.md), [sharing/share](https://yandex.ru/support/yandex-360/customers/documents/editor/ru/sharing/share.md), [sharing/comments](https://yandex.ru/support/yandex-360/customers/documents/editor/ru/sharing/comments.md), [sharing/deadlock](https://yandex.ru/support/yandex-360/customers/documents/editor/ru/sharing/deadlock.md), [llms-full.txt](https://yandex.ru/support/yandex-360/customers/documents/editor/ru/llms-full.txt). Яндекс Директ: ◐ [Postium 16.09.2025](https://postium.ru/yandeks-direkt-zapustil-generator-sajtov/).
- Сбер: [vc.ru 14.10.2025](https://vc.ru/sber/2274339-gigachat-ot-sbera-sozdaet-prezentatsii), [sberbusiness.live](https://sberbusiness.live/kursy/tsifrovizatsia-urok-3-ii-funktsii-v-gigachate-poleznie-predprinimatelyu), [giga.chat](https://giga.chat/) (строки сборки 0.15.5), [манифест модулей](https://giga.chat/static-configs/api/v0/common/config-ui?key=PLUGINS_MANIFEST_WEB_V0), [sber.pro 03.03.2026](https://sber.pro/publication/shtat-ii-sotrudnikov-vnutri-kompanii-sber-predstavil-gigachat-biznes-gigachat-enterprise/), [sber.pro 13.10.2026](https://sber.pro/publication/sber-predstavil-servis-v-kotorom-chastnie-polzovateli-mogut-sozdavat-ii-agentov/); ◐ [Инк. 20.03.2026](https://incrussia.ru/pnews/sber-predstavil-ii-rabochee-mesto-na-baze-gigachat-biznes-vse-zadachi-v-odnom-okne/).
- VK: ◐ [anti-malware.ru 23.09.2026](https://www.anti-malware.ru/news/2026-09-23-111332/51515), ◐ [Рамблер 30.04.2026](https://finance.rambler.ru/business/56384371-vk-tech-predstavil-platformu-dlya-razrabotki-i-zapuska-ii-agentov/), ◐ [Sostav](https://www.sostav.ru/blogs/284069/102095).
- МТС: [Sostav 27.10.2026](https://www.sostav.ru/publication/mws-ai-zapustila-ii-agenta-dlya-resheniya-ofisnykh-zadach-88073.html); ◐ [www1.ru 17.10.2026](https://www1.ru/news/2026/10/17/mws-ai-uprostila-sozdanie-korporativnyx-ii-agentov-i-dobavila-poisk-po-skanam.html).
- Tilda: [vibe-block](https://help-ru.tilda.cc/tilda-ai/vibe-block), [mcp](https://help-ru.tilda.cc/mcp), [lp/mcp](https://tilda.cc/ru/lp/mcp/), [lp/ai](https://tilda.cc/ru/lp/ai/); ◐ [Postium 13.05.2026](https://postium.ru/tilda-dobavila-instrument-vajb-blok/).
- Craftum и uKit: [ai.craftum.com](https://ai.craftum.com/), [ukit.com/ru/ai](https://ukit.com/ru/ai).
