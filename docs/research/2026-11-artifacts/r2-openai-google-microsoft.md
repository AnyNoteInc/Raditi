# Артефакты у OpenAI, Google и Microsoft — исследование на 19.11.2026

Исследование, а не решение. Охват — OpenAI (ChatGPT, Codex), Google (Gemini, Gemini Enterprise, Gemini Notebook, Stitch, Docs, Labs), Microsoft (Copilot Pages, Notebooks и Workspaces, Office in Copilot, Code, GitHub Copilot). Всё прочитано 19.11.2026. Первоисточники — справки, документация, release notes и официальные блоги. Чужие обзоры названы прямо, а то, что подтвердить не удалось, помечено «не подтверждено». `help.openai.com` отдаёт 403 машинам, поэтому его статьи цитируются по выдержкам поисковика или по зеркалу release notes `api.releases.sh` (369 записей, по 18.11.2026 включительно). Документация `learn.chatgpt.com` скачана напрямую, в Markdown.

## 0. Что проверено против `docs/research/2026-11-agent-features` и что изменилось

Строки OR-76, OR-84, OR-89, OR-91, OR-93, OR-96, OR-101, OR-108, OR-119, OR-146, SF-131, SF-133, SF-143, IC-127, IM-25 и IM-03 сверены с первоисточниками. Прежние утверждения о трёх компаниях подтверждаются. Новое, после 14–16.11.2026, и чего в перечне нет:

- **Google.** 16.11.2026 Gemini Notebook научился делать сайты из источников («make me a site»), с личным состоянием у каждого зрителя ([blog.google](https://blog.google/innovation-and-ai/products/gemini-notebook/interactive-sites/), [справка](https://support.google.com/gemininotebook/answer/18945748)). 19.10.2026 у слайдов и видео появилось согласование плана до генерации ([blog.google](https://blog.google/innovation-and-ai/products/gemini-notebook/co-create-slides-videos/)). 18.11.2026 вышел Stitch Loop ([blog.google](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-loop/)). 11.11.2026 вышел Tabletop — общие интерактивные пространства для группы ([blog.google](https://blog.google/innovation-and-ai/models-and-research/google-labs/tabletop/)). Холст Gemini Enterprise внутри называется `immersiveArtifacts` ([docs.cloud.google.com](https://docs.cloud.google.com/gemini/enterprise/docs/configure-canvas)).
- **Microsoft, Ignite 17.11.2026.** Workspaces названы «эволюцией Copilot Notebooks» и описаны как многопользовательское место для людей и агентов. Home и Office in Copilot стали GA, Copilot Managed Runtime — тоже GA, Code станет GA «в ближайшие недели» ([microsoft.com, 17.11.2026](https://www.microsoft.com/en-us/copilot/blog/2026/11/17/copilot-at-microsoft-ignite-expanding-whats-possible-with-intelligence-built-for-work/)).
- **Поправки к строкам перечня:**
  - OR-84 «Галерея»: добавить ChatGPT Space («All», «Shared with you») и Microsoft Copilot Library.
  - OR-96 «Общее состояние»: добавить приложения Gemini Canvas (данные общие для всех, у кого есть ссылка), сайты Gemini Notebook (у каждого зрителя своё) и Tabletop.
  - OR-108 «ИИ внутри артефакта»: добавить «Add Gemini features» и Sites с Sign in with ChatGPT.
  - OR-119 «Хранилище»: добавить ChatGPT Sites (D1, R2).
  - OR-146 «Комментарии, на которые отвечает ИИ»: добавить ChatGPT Pages и Slides (`@ChatGPT` и `@dot` в комментарии) и Microsoft Workspaces.
  - SF-131 «Кто видит»: добавить три уровня Gemini Notebook (Restricted, Anyone with a link, Public) и аудитории Sites. У Managed Runtime доступ только внутри организации.
  - SF-133 «Ссылка на артефакт»: добавить «Copy link to artifact» Gemini Notebook и issue artifacts GitHub.
  - SF-143 «Ремикс»: добавить «Copy Canvas» Gemini и «Allow copies» Gemini Notebook.
  - IC-127 и IM-25 «Артефакт как контекст»: добавить `@` на файлы, страницы и чаты в ChatGPT Pages, заметки как источники в Gemini Notebook, ссылки на файлы в Copilot Notebooks (они обновляются вместе с файлом) и деление «артефакты и ссылки» в панели VS Code.
  - IM-03 «Выбор элемента»: добавить браузерные аннотации ChatGPT с Annotation API и «Select & ask» Gemini Canvas и Gemini Enterprise.

## 1. Итог в десяти тезисах

1. Все три компании вынесли постоянный рабочий объект из ленты чата в отдельное место с собственным адресом и правами. У OpenAI это ChatGPT Space (Pages, Slides, таблицы), у Microsoft — Copilot Pages (файл `.page`) и Workspaces, у Google — студия блокнота Gemini Notebook, у GitHub — issue artifacts. OpenAI убрала canvas из новых моделей (28.05.2026) и поставила на его место блоки в ленте (writing blocks), а постоянное перенесла в Space (29.09.2026). Пользователи пишут, что блок в ленте канвасу не замена.
2. Рабочий объект и публикацию разделяют все, но по-разному. У OpenAI: Space — для приглашённых, Sites — опубликованный хостинг, у которого «сохранить версию» и «выложить версию» — два разных шага. У Microsoft: Pages — внутри организации, приложения Code — в Managed Runtime, снаружи доступа нет вообще. У Google Canvas и Notebook дают снимок по публичной ссылке, а настоящий деплой — в AI Studio и Cloud Run.
3. Правка выделенного фрагмента силами ИИ есть у всех: «Ask for change» (ChatGPT), «Select & ask» (Gemini), «Ask Copilot» (Copilot Pages), аннотации к файлам и сайтам (ChatGPT Work и Codex).
4. В общем объекте правка ИИ остаётся личной, пока автор её не подтвердит. У Google Docs: «suggested edits are only visible to you until you approve them». У ярлыков Copilot Pages на общей странице — предпросмотр правки с галочкой и переключатель «Original». У ChatGPT «Ask for change» показывает предложенную правку, её принимают.
5. Комментарий стал каналом к агенту. ChatGPT Pages и Slides: `@ChatGPT` или `@dot` в комментарии. Microsoft Workspaces: «You leave a comment, and an agent picks it up».
6. Готового решения для одновременной правки несколькими агентами нет ни у кого. ChatGPT предлагает людям договориться, кто что меняет. Microsoft признаёт, что ИИ может не увидеть одновременных правок без обновления страницы. Технические заготовки есть:
   - версия файла с `ifMatch` и исходом `conflict` в расширениях MCP у OpenAI;
   - точечные правки поиском и заменой у Gemini Enterprise;
   - API действий над общим состоянием (`get_board`, `add_card`) у canvases GitHub.
7. Версии понимают по-разному:
   - Copilot Pages: стрелки по версиям и «Restore version».
   - GitHub issue artifacts: восстановление записывается новой версией.
   - Gemini Canvas: «Previous Version» и «Next Version».
   - ChatGPT Sites: сохранённые версии и выкладки.
   - ChatGPT Pages: истории версий в документации нет.
   - Слайды Gemini Notebook и Gemini Enterprise: каждая правка создаёт новый объект без связи с прежним.
8. Шеринг собирается из одних кубиков:
   - приглашение по почте с ролями «просмотр», «комментарии», «правка»;
   - доступ, унаследованный от родительского объекта;
   - «всем в организации»;
   - «всем по ссылке», у Gemini Notebook — ещё и с поиском;
   - копия без данных и секретов («Remix», «Copy Canvas», «Allow copies»).
9. Интерактивные объекты по-разному хранят то, что вводит зритель:
   - Sites у OpenAI — данные на сервере (D1, R2), временное состояние окна — отдельно;
   - сайты Gemini Notebook — у каждого зрителя своё;
   - приложения Gemini Canvas — общие данные, которые может менять любой, у кого есть ссылка;
   - Tabletop и canvases GitHub — общая поверхность.
10. Рендер у всех одинаковый: свой origin, iframe-песочница, CSP, закрытый по умолчанию. Токены и коннекторы держит хост, а не код артефакта. Так устроены MCP Apps, расширения OpenAI и Copilot Managed Runtime.

---

## 2. OpenAI

### 2.1 ChatGPT Canvas (наследие) и блоки в ленте

- **Понятие.** Canvas — панель рядом с чатом для текста и кода. 10.12.2024 он стал доступен всем в 4o, вместе с canvas в GPTs, запуском Python и ярлыком вставки ([release notes, 10.12.2024](https://help.openai.com/en/articles/6825453-chatgpt-release-notes#canvas)).
- **Типы.** Документ, код, отрисованный React или HTML ([release notes, 06.02.2025](https://help.openai.com/en/articles/6825453-chatgpt-release-notes#canvas-sharing)).
- **Кто правит.** Человек — прямо в панели. ИИ — ярлыками:
  - для текста: «Suggest edits», «Adjust the length», «Reading level», «Add final polish», «Add emojis»;
  - для кода: «Review code», «Add logs», «Add comments», «Fix bugs», «Port to a language».
  Источники — [справка 9930697](https://help.openai.com/en/articles/9930697-what-is-the-canvas-feature-in-chatgpt-and-how-do-i-use-it) (по выдержке поисковика) и [анонс](https://openai.com/index/introducing-canvas/).
- **Версии.** В справке есть раздел «Version history and show changes»; кнопка «назад» возвращает прежнюю версию (по выдержке).
- **Совместная работа.** Нет, одна работа одного пользователя (не найдено ничего иного).
- **Шеринг.** С 06.02.2025 canvas можно открыть другому так же, как беседу, из панели инструментов canvas.
- **Привязка.** К чату; с 13.12.2024 работал в Projects. С 15.01.2025 — «Import from Chat into Canvas», только в вебе.
- **Судьба.** 28.05.2026: «Canvas is no longer available in GPT-5.5 Instant or GPT-5.5 Thinking; writing and coding functionality is now supported directly in chat through writing blocks and code blocks. Paid users can continue using canvas for a limited time through legacy models» ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes#gpt-5-5-instant-update)). 08.06.2026 writing blocks получили полноэкранный редактор, сохранение в Library, оглавление, скачивание и улучшенную отмену ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes#chatgpt-app-experience-updates)). Пользователь на форуме, 19.09.2026: «Writing Blocks are not an equivalent replacement… a persistent side-by-side workspace/document». Он пишет, что старые canvas видны, но нынешняя модель может не видеть их содержимого ([community.openai.com](https://community.openai.com/t/please-restore-canvas-as-a-persistent-workspace-writing-blocks-are-not-an-equivalent-replacement/1398999)). Что все legacy-модели с canvas уже сняты, утверждает один сторонний источник — не подтверждено.

### 2.2 ChatGPT Space: Pages, Slides, таблицы и Library

**Понятие.** «ChatGPT Space (formerly Library) brings together pages, slide decks, uploaded files, and shared content so people and agents can collaborate» ([learn.chatgpt.com, для админов](https://learn.chatgpt.com/docs/enterprise/chatgpt-space)). Запущен на DevDay, 29.09.2026. Space «replaces Library for accounts with access; your existing Projects remain separate», доступен Pro, Business и Enterprise в вебе и десктопе; для Enterprise шеринг — предпросмотр по согласию ([release notes, 29.09.2026](https://help.openai.com/en/articles/6825453-chatgpt-release-notes#organize-your-work-in-chatgpt-space)). Внутри Space есть пространства — группы страниц по теме или команде ([learn.chatgpt.com/docs/space](https://learn.chatgpt.com/docs/space)).

**Типы**
- **Page** — блочный документ ([learn.chatgpt.com/docs/space/pages](https://learn.chatgpt.com/docs/space/pages)). Блоки:
  - заголовки, списки, чек-листы, таблицы с шириной «Normal / Flexible / Full width», код, «Highlight»;
  - картинка (сгенерировать или вложить), файл для скачивания;
  - подстраница, ссылка на страницу, ссылки на файлы, страницы и чаты без копирования;
  - Visualize — калькуляторы, диаграммы, «screen designs»; заготовки app, screen design, widget, diagram;
  - Prompt, Task и Agent Instructions: запрос для читателя, действие для Codex, указания агенту.
- **ChatGPT Slides** (16.10.2026) — текст, картинки, фигуры, таблицы, графики. Колоду делают из разговора, файлов, плана или образца ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes#create-and-collaborate-on-slides-in-chatgpt)).
- **Spreadsheets** — «Create and edit tables and calculations with ChatGPT». Подробностей в документации нет.
- **Остальное:** Sites, Images, файлы. Конспекты встреч плагин Meetings сохраняет в Space (29.09.2026).

**Где показ.** Раздел Space: вкладка «All» (Suggested, Favorites, Your items, Shared with you, поиск, меню New), боковая панель (Pages, Sites, Images, Google Drive). Страница открывается вместе с разговором («Open the page and ChatGPT alongside it»).
- **Телефон.** Слайды на телефоне создаются через разговор и только просматриваются; править элементы можно в вебе и десктопе ([getting-started](https://learn.chatgpt.com/docs/space/getting-started)). Правка Pages на телефоне, по стороннему обзору, «позже» ([beri.net, 04.10.2026](https://www.beri.net/article/chatgpt-space-shared-pages-inherited-access-no-export-version-history-business-enterprise-admin)) — у OpenAI не подтверждено.

**Пользовательский путь (Page)**
1. Space → New page (или «создай страницу из этой беседы»).
2. Заголовок, текст, файлы, ссылки.
3. Открыть ChatGPT рядом и попросить, например, «Organize the notes on this page…».
4. Править прямо или просить новую правку.
5. Share → человек или команда → View или Edit → отправить ссылку.

**Кто правит**
- **Человек** — прямо: «/» для вставки блока, ручка у блока для перетаскивания, панель форматирования.
- **ИИ — точечно:** выделить текст → «Ask for change». Это предложенная правка: «Review the proposed edit before accepting it» ([agents](https://learn.chatgpt.com/docs/space/agents)).
- **ИИ — новым текстом:** «Generate» пишет черновик прямо на странице; его принимают, просят изменить или отменяют.
- **Агент через упоминание:** `@ChatGPT` или `@dot` с запросом — в тексте страницы или в комментарии.
- **Крупные правки** — в разговоре рядом со страницей.
- **Слайды:** выделить элемент → «Request edits»; строка запроса меняет всю колоду.

**Версии.** В документации OpenAI истории версий страниц нет. Сторонний обзор (04.10.2026, со ссылкой на eesel) пишет, что у Pages «no export or version history yet» — у OpenAI не подтверждено. Удалённая страница или пространство вместе со вложенными страницами уходит в корзину (Trash).

**Совместная работа**
- С доступом Edit пишут вместе в реальном времени, «with each person using their own ChatGPT» ([release notes, 29.09.2026](https://help.openai.com/en/articles/6825453-chatgpt-release-notes#create-and-collaborate-on-pages)).
- Комментарии к фрагменту, «Show attribution» — кто что внёс.
- Разные участники работают с разными агентами, инструментами и инструкциями: «Agree on who is changing what and review the result» ([agents](https://learn.chatgpt.com/docs/space/agents)). Системного разрешения конфликтов нет.
- Слайды правят одновременно, с общими комментариями и `@ChatGPT` или `@dot`.

**Шеринг** ([collaboration](https://learn.chatgpt.com/docs/space/collaboration))
- Делятся страницей, пространством или колодой — с людьми или командами (Teams).
- Роли: View, Comment, Edit. У Slides — только View и Edit.
- Доступ к пространству распространяется на его страницы, доступ к странице — на её подстраницы. «Removing a direct invitation doesn't remove access that someone still inherits», и окно шеринга показывает, откуда доступ — прямой он или унаследованный.
- Админ может выключить шеринг: новые выдачи закрываются, старые остаются.
- Публичной ссылки «всем» в документации нет.
- Шеринг файлов Library с 09.09.2026: Viewer или Editor, «вся рабочая область», папка «Shared with me». Файл, загруженный в чужую общую папку, принадлежит владельцу папки ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes#share-files-and-folders-from-your-library)).

**Привязка.** Объект принадлежит пользователю и рабочей области, не чату. Projects живут отдельно: «Sharing a project removes personal Space files from its sources». Личные чаты и память при шеринге страницы не раскрываются, а всё, что скопировано на страницу, видят её участники ([для админов](https://learn.chatgpt.com/docs/enterprise/chatgpt-space)).

**Инструменты агента и API.** В страницах работают ChatGPT и dots — через `@` и «/». «Keep Updated isn't available at launch» — страниц, которые обновляются сами, пока нет. Compliance API экспортирует и удаляет файлы Library в Enterprise. Публичного API или MCP для Pages не найдено.

**Экспорт.** Слайды: показ в ChatGPT с заметками докладчика, выгрузка в PPTX, PDF и Google Slides из веба; на десктопе — «открыть в PowerPoint или Keynote». Экспорт Pages не описан.

**Безопасность.** «Pages, files, and tool results may contain prompt injections that redirect ChatGPT or disclose information» ([для админов](https://learn.chatgpt.com/docs/enterprise/chatgpt-space)).

**Лимиты и цена.** Отдельной цены, по стороннему обзору, нет. Доступность — по тарифам выше.

**Рабочее и опубликованное.** Space — для приглашённых. В интернет выходят только через Sites (2.3).

### 2.3 ChatGPT Sites

**Понятие.** Хостинг сайтов и лёгких приложений, которые описывают словами в ChatGPT или Codex. Публичная бета с 09.07.2026 — Pro, Pro Lite, Edu, затем Plus. Business и Enterprise могут публиковать для всех. На Free и Go Sites нет; в ЕЭЗ, Швейцарии и Великобритании на старте не было ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes#introducing-chatgpt-sites-in-public-beta)).

**Типы.** Ресурсный хаб, дашборд, трекер, форма заявки, калькулятор, пошаговый процесс, игра, готовый совместимый проект. Работают HTTP, HTTPS и WebSockets; база D1 — до 10 ГБ на сайт, файлы R2 — без жёсткого предела ([learn.chatgpt.com/docs/sites](https://learn.chatgpt.com/docs/sites)).

**Путь** ([creating-a-site](https://learn.chatgpt.com/docs/sites/creating-a-site))
1. Слово «website» в запросе или `@Sites`.
2. Описать аудиторию, действия и данные.
3. Проверить первую версию.
4. Попросить правку, можно со скриншотом.
5. Вернуться в sites (`chatgpt.com/sites`, в вебе — More → sites).
6. В предпросмотре — «Edit» и поле «Describe website edits».
7. Проверить и опубликовать.

С 29.09.2026 на опубликованном сайте есть кнопка «Edit site», а у владельца — «Automations», облачное расписание обновлений ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes#creating-editing-and-scheduling-sites)).

**Кто правит.** Только ИИ по описанию. Локальный проект правят в коде.

**Версии и выкладки** ([managing-a-site](https://learn.chatgpt.com/docs/sites/managing-a-site)). Два шага:
1. Save a version — собранная версия-кандидат; у локального проекта она привязана к коммиту git.
2. Deploy a version — выкладка версии.

«Every sites deployment URL is a production deployment». Версии можно перечислить и посмотреть. С 20.08.2026 адрес меняется без новой выкладки, со старого идёт переадресация. Удаление необратимо. Чтобы снять сайт, не удаляя, сужают аудиторию.

**Совместная работа** ([publishing-and-sharing](https://learn.chatgpt.com/docs/sites/publishing-and-sharing))
- С 17–21.08.2026 владелец приглашает участников своей рабочей области редакторами.
- Редакторы не меняют аудиторию, не приглашают людей, не трогают настройки и не делают первую публикацию.
- Редакторы видят живые данные базы.

**Шеринг — аудитории**
- владелец и админы — по умолчанию;
- выбранные пользователи и группы;
- приглашённые внешние зрители (01.09.2026): по почте, со входом той учётной записью, которой дан доступ;
- вся рабочая область;
- весь интернет — если публичная публикация включена; в Enterprise по умолчанию выключена.

Remix делает копию чужого сайта: «Runtime settings, secrets, database records, and files in the Site's storage are not copied» ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes#remix-a-site-in-chat)). С 29.09.2026 профиль пользователя показывает выбранные сайты.

**Привязка.** «A site is separate from a ChatGPT Project», и сайт остаётся в списке, когда чат Work, который его создал, кончился.

**Инструменты агента.** Создание, сохранение, выкладка и осмотр — через Work и Codex. Например, агент генерирует токен `generate_siwc_bypass_token` для вызовов от сервисов ([data-and-connections](https://learn.chatgpt.com/docs/sites/data-and-connections)). Plugin Creator хостит MCP-сервер плагина на Sites.

**Данные и ИИ внутри**
- база D1, файлы R2, секреты в настройках сайта;
- Sign in with ChatGPT; заголовок `OAI-Sites-Authorization: Bearer …` для вызовов от сервисов;
- в закрытых сайтах рабочей области — приложения каждого зрителя, с его согласием;
- с DevDay приложения с SIWC могут тратить на запросы к ИИ план самого пользователя Plus или Pro — ограниченно ([DevDay 2026](https://learn.chatgpt.com/docs/whats-new/devday-2026)).

**Политика.** Нельзя: медицинские данные (PHI), дети до 13 лет, вредоносное ПО, фишинг, выдача себя за других. Платежи — только через процессора.

**Цена.**
- Хостинг бесплатен до 31.12.2026. С 01.01.2027 платится то, что сверх месячного запаса: Plus — 125 кредитов, Pro — 375, Business — 125 на место.
- Ставки:

  | Что | Кредитов |
  | --- | --- |
  | сайт с хранилищем | 25 в месяц |
  | 100 000 запросов | 16 |
  | ГиБ базы | 150 в месяц |
  | ГиБ файлов | 3,75 в месяц |
  | свой домен | 25 в месяц |

- Сборка и правка сайта тратят лимиты Codex.

**Рабочее и опубликованное.** Разделение явное: версия-кандидат отдельно от выкладки, Space отдельно от Sites. Visualizations советуют: «Use a Site when you need a durable hosted application with a shareable URL, permissions, or persistent data».

### 2.4 Готовые файлы ChatGPT Work, просмотрщик и Codex

- **ChatGPT Work** (09.07.2026) — агент для долгих задач. Он делает «finished documents, spreadsheets, presentations, reports, and Sites» ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes#introducing-chatgpt-work)). Прежний режим агента (agent mode): «ChatGPT agent is no longer available», справка отправляет в Work ([справка 11752874](https://help.openai.com/en/articles/11752874), по выдержке; по сторонним источникам — начало августа 2026).
- **Просмотрщик** ([artifacts-viewer](https://learn.chatgpt.com/docs/artifacts-viewer)).
  - На десктопе: документы, презентации, таблицы и PDF рядом с чатом, по желанию открываются сами после задачи. `.html` открывается живой страницей с переключением на исходник. `.tex` правится рядом с PDF, при ошибке сборки остаётся последний удачный PDF.
  - Аннотации: выделить место в документе, слайде, таблице, Markdown или на сайте и попросить правку только там.
  - Боковая панель задачи: план, источники, файлы, сводка.
  - В вебе: просмотр в чате и скачивание, правку просят словами — назвать страницу, слайд или лист.
  - В CLI превью нет.
- **Codex Cloud.** Изменённые файлы и проверки, повторная просьба, коммит или PR ([cloud](https://learn.chatgpt.com/docs/cloud)). Снимок треда для чтения ([use-chatgpt](https://learn.chatgpt.com/docs/use-chatgpt)):
  - личная учётная запись — «anyone with the link»;
  - рабочая область — только её участники или приглашённые;
  - известные шаблоны секретов вычищаются;
  - снимок не форкается, отзыв — в Data controls → Shared links.
- **Картинки.** С 30.07.2026 в Codex и ChatGPT есть «Focused view» и «Canvas view»: картинки чата на одном холсте, комментарии и выбор нескольких для следующей правки ([image-generation](https://learn.chatgpt.com/docs/image-generation)).
- **Аннотации сайтов** (DevDay). Browser Annotation API `document.oai.annotation`: сайт задаёт, что можно выделять, — карточки, фрагменты текста, объекты на `<canvas>` — какой контекст идёт с выделением и какие свои контролы показать, чтобы проверить вариант до отправки ([annotations-extensibility](https://learn.chatgpt.com/docs/annotations-extensibility)).
- **Офисные надстройки** — путь «ИИ внутри чужого редактора»: ChatGPT for Excel и Google Sheets (05.05.2026), ChatGPT for PowerPoint GA (07.08.2026) ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes#chatgpt-for-powerpoint-is-now-generally-available)).

### 2.5 Visualizations и Intelligent UI

- **Visualize** (`@Visualize`) — графики, карты, диаграммы, калькуляторы, симуляции ([visualizations](https://learn.chatgpt.com/docs/visualizations)). Где работает: веб — в Chat и Work; десктоп и телефоны — раскатывается; CLI и IDE — нет.
  - Правка: следующая просьба в том же чате. «A follow-up can create a replacement visualization instead of editing the original result in place».
  - Шеринг: общей ссылкой на чат. Визуализация — «a snapshot… not a live dashboard».
  - Экспорт: зависит от результата, иначе — «turn the visualization into a Site».
  - На странице: «/visualize» вставляет визуализацию в Page.
- **Intelligent UI** (GPT-6, 07.10.2026). Ответ сочетает текст, визуал и интерактив: сравнения, диаграммы, калькуляторы, деление счёта, игры. Формат выбирает модель. GPT-6 начинает отвечать, пока ещё думает ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes#gpt-6-and-intelligent-ui-in-chatgpt)). Это ответ в ленте, не постоянный объект.

### 2.6 Интерфейс плагинов: MCP Apps и OpenAI MCP Extensions (бывший Apps SDK)

**Основа — открытый стандарт MCP Apps** ([chatgpt-ui](https://developers.openai.com/plugins/build/chatgpt-ui))
- Компонент живёт в iframe и говорит с хостом через JSON-RPC по `postMessage`.
- `_meta.ui.resourceUri` связывает инструмент с интерфейсом.
- Из интерфейса доступны `tools/call`, `ui/message` (сообщение в беседу) и `ui/update-model-context` (что увидит модель).

**Состояние — три вида**
- бизнес-данные — на сервере;
- состояние окна (`window.openai.widgetState`, поля `modelContent`, `privateContent`, `imageIds`) — живёт только в этом экземпляре окна;
- долгое — в хранилище разработчика.

«Avoid `localStorage` for core state».

**Безопасность.** CSP задаётся списками `connectDomains`, `resourceDomains` и `frameDomains`; «Nested frames are blocked by default»; фрейм страниц своего домена — с обоснованием на проверке. По спецификации MCP Apps:
- origin хоста и iframe разные;
- у iframe флаги `allow-scripts` и `allow-same-origin`;
- документ отдаёт сервер хоста;
- CSP по умолчанию — `default-src 'none'`, `connect-src 'none'`.
([спецификация MCP Apps](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx)).

**Режимы показа.** В руководстве — inline-карточка, карусель, fullscreen и PiP. В спецификации расширений: «ChatGPT supports `inline` and `fullscreen`, but not `pip`» ([spec](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md)) — документы расходятся.

**Расширения** (29.09.2026, [extensions](https://developers.openai.com/plugins/build/extensions))
- приложения в боковой панели ChatGPT;
- панели в беседе (`thread` — «новая вкладка контента в треде»);
- просмотрщики и редакторы файлов (только десктоп);
- настройки, глубокие ссылки;
- упоминания в поле ввода (только десктоп);
- расширенные формы, онбординг.

Примеры: вкладки Canva в боковой панели, упоминания файлов Figma, редакторы Acrobat и Photoshop.

**Запись файла — образец оптимистической блокировки.** Метод `openai/resources/write` принимает `{uri, ifMatch?, text|blob}` и возвращает `saved`, `conflict` (с текущим ETag) или `too-large`. `resources/subscribe` даёт живые обновления ([spec](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md)).

### 2.7 Projects и общие ссылки

- **Projects.** Разделы «Chats» и «Sources», инструкции на все чаты; в одном проекте бывают и Chat, и Work ([projects](https://learn.chatgpt.com/docs/projects)). Шеринг проектов, по выдержкам справки:
  - роли «chat» и «edit»;
  - приглашение по почте или ссылке: «Only those invited» или «Anyone with a link»;
  - у общего проекта своя память;
  - лимиты по тарифу в выдержках расходятся (Plus и Go — 25 файлов и 10 участников, Pro — 40 и 100) ([справка 10169521](https://help.openai.com/en/articles/10169521-projects-in-ChatGPT)).
- **Общая ссылка на беседу.** Снимок на момент шеринга, «anyone with the link»; удаляется в Data Controls → Shared links; «продолжить беседу» убрано — получатель получает копию ([справка 7925741](https://help.openai.com/en/articles/7925741-chatgpt-shared-links-faq), по выдержке).
- **Групповые чаты.** С 09.07.2026 новых не создать ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes#retiring-group-chats-in-chatgpt)): общую работу людей OpenAI перенесла из ленты в объект — Page и Slides.

---

## 3. Google

### 3.1 Gemini Canvas (приложение Gemini)

Источник — [справка 16047321](https://support.google.com/gemini/answer/16047321), версии для компьютера и Android, прочитаны 19.11.2026.

**Понятие.** «Collaborate with Gemini in Canvas to create or edit a doc, app, slides, or code». Из готового можно сделать Audio Overview, тест или другой формат.

**Путь.**
1. Под полем ввода — «+» → Canvas, или попросить формат словами.
2. Документ или приложение открывается в панели Canvas справа.
3. Править прямо или запросом.
4. Share & export.

**Типы.** Документ (с LaTeX), приложение (HTML, JS, React), слайды, код. Через меню «Create» из документа делаются слайды, «custom visual», приложение, Audio Overview, тест, инфографика, веб-страница.

**Где показ.** Панель Canvas справа от чата, у приложений — вкладки Preview, Code и Show console.
- **Телефон.** Canvas работает в приложении: правка приложения запросом, предпросмотр, консоль, «Add to home screen». Форматирование текста — только в вебе на компьютере. Общая ссылка открывается только на gemini.google.com, в мобильном приложении — нет.

**Кто правит**
- **Документ:** человек прямо; выделить и спросить; «Suggest edits», «Change length», «Change tone»; панель форматирования.
- **Приложение:** правка запросом или прямо в коде; «Select & ask» — выделить область интерфейса; «Add Gemini features» — добавить в приложение ИИ (18+); «Show recent changes».
- Изменения сохраняются сами.

**Версии.** У документа — «Previous Version» и «Next Version». У приложения — «последние изменения» в коде.

**Совместная работа.** Одновременной правки нескольких людей нет (не найдено).

**Шеринг.** Публичная ссылка `g.co/gemini/share`.
- По ссылке на приложение «Anyone with that public link can view and edit data associated with the app»; общее приложение может делить данные между пользователями, хранить их между сессиями и устройствами и вызывать ИИ.
- По чужой ссылке — «Copy Canvas», своя копия.
- Общий чат — снимок со всеми «AI-generated artifacts from the conversation, including Canvas documents, images, and videos»; ссылки удаляются на странице «Your public links» и живут, пока чат хранится в истории ([справка 13743730](https://support.google.com/gemini/answer/13743730)).
- Пользователи Workspace (бизнес и образование) делиться содержимым Canvas не могли, по данным 05.2025 ([workspaceupdates](https://workspaceupdates.googleblog.com/2025/05/more-ways-to-create-with-canvas-gemini.html)); на 11.2026 не подтверждено.

**Привязка.** К чату. Файлы задач (Tasks): Markdown и текст открываются в Canvas, остальное — ссылками ([справка 17094507](https://support.google.com/gemini/answer/17094507)).

**Экспорт.** Docs, Slides (и PDF), Colab, копирование. Документ с LaTeX — в PDF с предпросмотром. Файлы задач: `.md`, `.txt`, Drive.

**Безопасность рендера.** В документации Gemini не описана. Спецификация MCP Apps называет одним из образцов «what Google Gemini does with its SafeContentFrame implementation»: содержимое передают в iframe-песочницу и рендерят как `blob:` ([спецификация](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx)). У Google не подтверждено.

**Цена.** Canvas есть и без подписки; на чьи лимиты идут ИИ-вызовы общего приложения у зрителя — не найдено.

**Рабочее и опубликованное.** Публикации нет, только снимок по ссылке. Настоящий деплой — в AI Studio (Build → Cloud Run, свой домен на платном проекте; по перечню в репозитории).

### 3.2 Gemini Enterprise Canvas («immersive artifacts»)

Источники — [assistant-canvas](https://docs.cloud.google.com/gemini/enterprise/docs/assistant-canvas) и [configure-canvas](https://docs.cloud.google.com/gemini/enterprise/docs/configure-canvas).

- **Типы.** Документы, слайды, одностраничные приложения — один самодостаточный HTML. Внутреннее имя ресурса — `discoveryengine.immersiveArtifacts.{create,delete,export,get,list,navigate,update}`.
- **Правка документа.** Прямо; ползунки «Change length» и «Change tone»; выделить и «Ask Gemini». Undo и redo ходят по сохранённым версиям. Документ правится только в той сессии, где его сделали; потом — только экспортом.
- **Слайды.** «Each update generates a completely new Canvas artifact. The existing artifact is not modified or versioned».
- **Приложение.**
  - правки «search-and-replace edits without regenerating the entire file»;
  - «Select and ask» по элементу;
  - код и навык — только на чтение;
  - история версий с переключателем;
  - шеринг «with anyone in your organization»;
  - скачивание HTML.
- **Пределы приложений.** Нет хранилища и базы, нет хостинга, нет секретов, только клиентские вычисления.
- **Где не работает.** В мобильном приложении нет. Общий чат не открывает содержимое Canvas — делятся экспортом в Docs или Slides.
- **Квота** общая с чатом.

### 3.3 Gemini Notebook (с 16.07.2026; бывший NotebookLM): студия

**Понятие.** «We’re renaming NotebookLM to Gemini Notebook… updated with a secure cloud computer», который пишет и исполняет код над источниками ([blog.google, 16.07.2026](https://blog.google/innovation-and-ai/products/gemini-notebook/notebooklm-gemini-notebook/)). Адрес — notebook.google.com. Блокноты синхронизируются с приложением Gemini ([справка 16972047](https://support.google.com/gemini/answer/16972047)). Google прямо называет результаты студии «artifact»: «Copy link to artifact», «produce a final artifact».

**Типы — панель Studio** (справка support.google.com/gemininotebook)
- **Audio Overview.**
- **Video Overview** — форматы, стили; генерация бывает дольше 30 минут ([16454555](https://support.google.com/gemininotebook/answer/16454555)).
- **Mind Map** — узел задаёт вопрос в чат; скачивается; в мобильном приложении нет ([16212283](https://support.google.com/gemininotebook/answer/16212283)).
- **Flashcards и Quizzes.**
- **Infographic** — PNG; детальность, ориентация, стиль ([16758265](https://support.google.com/gemininotebook/answer/16758265)).
- **Slide Deck** — PDF и PPTX, показ на весь экран ([16757456](https://support.google.com/gemininotebook/answer/16757456)).
- **Reports** — интерактивные, со встроенными артефактами студии («under any suggested artifacts that you want to embed, select Add»), или документные ([18323649](https://support.google.com/gemininotebook/answer/18323649)).
- **Sites** (16.11.2026) — дашборды, трекеры, визуальные объяснения ([18945748](https://support.google.com/gemininotebook/answer/18945748)).
- **Notes** — заметки, которые становятся источниками ([16262519](https://support.google.com/gemininotebook/answer/16262519)).

**Где показ.** Три колонки: Sources, Chat, Studio. Артефакт открывается в развёрнутом просмотре; сайт — ещё и «Open in new tab». Генерация идёт в фоне — «You can continue working in your notebook».

**Кто правит**
- **Слайды** правятся только через ИИ: «Revise» — указание к каждому слайду, указания копятся в «Pending Changes», затем «Generate revised deck», и это «creates an entirely new slide deck». Слайды можно удалять, возвращать и переставлять.
- **Согласование плана** (19.10.2026): перед генерацией слайдов — «Review outline notes», видео — «Review producer notes», правки одним пакетом, затем «Proceed» — после него план уже не поправить.
- **Заметки** правит человек; ответ из чата сохраняется заметкой.

**Версии.** У слайдов — «Load a previous Slide Deck», сохранённые прежние колоды. Сквозной истории версий нет.

**Совместная работа.** Общий блокнот. Создавать и удалять артефакты могут те, у кого есть право правки. На общем сайте «all users, including site owners, see only their own site inputs»: у каждого зрителя своё состояние, сайт помнит отметки и поля этого зрителя.

**Шеринг** ([16206563](https://support.google.com/gemininotebook/answer/16206563), [16322204](https://support.google.com/gemininotebook/answer/16322204))
- Viewer или Editor по почте; для Gmail — до 50 человек, без групп.
- Уровни доступа: «Restricted», «Anyone with a link», «Public» — с поиском, только на английском.
- «Copy link to chat view» прячет источники и артефакты, но «does not completely revoke a viewer's underlying access».
- Ссылка на артефакт работает, если блокнот открыт получателю или всем по ссылке и с полным доступом. В публичном блокноте артефакт видят «even if they are not signed in».
- Удаление артефакта или закрытие доступа гасит прежние ссылки.
- «Allow copies»: в копию идут студия и источники, но не чат и заметки.
- Аналитика — если блокнот открыт хотя бы 4 людям и в нём был чат.
- Для Workspace Enterprise и Education публичный шеринг выключен. Админ управляет внешним шерингом ([workspaceupdates, 10.09.2026](https://workspaceupdates.googleblog.com/2026/09/manage-external-sharing-for-gemini-notebook-in-the-Admin-console.html)).

**Привязка.** Артефакты принадлежат блокноту. Заметки — источники: «included in artifact generation», галочка включает и выключает источник.

**Инструменты агента и API**
- В приложении Gemini — подключённое приложение «Gemini Notebook»: создать, изменить, удалить блокнот, добавить источники, ответить по блокноту.
- NotebookLM Enterprise API v1alpha: блокноты, источники, `notebooks.audioOverviews.create` — один обзор на блокнот ([docs.cloud.google.com](https://docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/api-audio-overview)).

**Экспорт.** Слайды — PDF и PPTX, инфографика — PNG, видео, сайт (файл), карта, заметки в Google Docs без синхронизации и без переноса прав.

**Лимиты** ([16213268](https://support.google.com/gemininotebook/answer/16213268), «subject to change»)

| | Без плана | Plus | Pro | Ultra |
| --- | --- | --- | --- | --- |
| Блокнотов на пользователя | 100 | 200 | 500 | 500 |
| Источников на блокнот | 50 | 100 | 300 | 500–600 |

Сайты и карты — с отдельными лимитами использования; сайты — только для 18+.

**Рабочее и опубликованное.** Публикация — это открытие блокнота (по ссылке или публично) плюс ссылка на артефакт. Отдельного хостинга нет, кроме скачивания сайта.

### 3.4 Google Stitch (и Stitch Loop)

- **Понятие.** С 18.03.2026 — «AI-native software design canvas» ([blog.google](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-ai-ui-design/)):
  - бесконечный холст, на который кладут картинки, текст и код как контекст;
  - агент дизайна, который рассуждает по всему проекту;
  - «Agent manager» — несколько направлений параллельно;
  - `DESIGN.md` — правила дизайн-системы для экспорта и импорта, извлекаются из любого URL;
  - прототип — экраны сшиваются, «Play», следующие экраны генерируются по клику;
  - голос: критика в реальном времени, интервью, «three different menu options».
- **Выход.** MCP-сервер, SDK и навыки ([github.com/google-labs-code/stitch-skills](https://github.com/google-labs-code/stitch-skills)); экспорт в AI Studio и Antigravity. По `llms.txt` Stitch — ещё и редактируемые файлы Figma и HTML/CSS ([stitch.withgoogle.com/llms.txt](https://stitch.withgoogle.com/llms.txt)).
- **I/O 2026, только по сторонним источникам** — не подтверждено: поток работы прямо на холст, импорт дизайна и кода, ссылка через AI Studio, публикация на Netlify, «multiplayer».
- **Stitch Loop** (18.11.2026) — долгий продуктовый агент: подключается к коду и живым метрикам. Цикл: Suggestions → Solutions (варианты, с визуальными вариантами дизайна) → Build (код в песочнице, PR со скриншотами и видео) → Reflect (смотрит метрику). «Nothing merges until you review the PR»; `@stitch` в Slack; CLI и MCP; лист ожидания ([blog.google](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-loop/)).
- **Шеринг и права.** Первоисточника о ссылках и ролях не найдено.

### 3.5 Gemini в Google Docs

Отдельного холста нет: ИИ работает в самом документе. «Help me create» пишет черновик по файлам, почте, чатам и вебу. «Help me write» — из нижней строки или боковой панели, можно выделить текст. «Gemini’s suggested edits are only visible to you until you approve them». «Match writing style» и «Match doc format» держат стиль и формат ([workspaceupdates, 22.04.2026](https://workspaceupdates.googleblog.com/2026/04/new-gemini-capabilities-in-google-docs-help-you-go-from-blank-page-to-brilliance.html)).

### 3.6 Tabletop (Google Labs, 11.11.2026)

В пространство добавляют ссылки, файлы и идеи и просят `@tabletop` или берут шаблон. Получаются интерактивные маршруты, голосования, раздел расходов, турнирные сетки. «Drop the invite link in your group chat to let everyone jump in and use it at the same time, like in a Google Doc». Только США, 18+, по листу ожидания ([blog.google](https://blog.google/innovation-and-ai/models-and-research/google-labs/tabletop/)). Это образец общего интерактивного артефакта для группы.

---

## 4. Microsoft

### 4.1 Copilot Pages

**Понятие.** «A dynamic, persistent canvas in Copilot chat designed for AI-powered group collaboration… turn insightful Copilot responses into something durable with a side-by-side page» ([How Copilot Pages works](https://support.microsoft.com/topic/how-microsoft-365-copilot-pages-works-d155bd99-c3cc-4ef8-8da4-c0a92bfce29b)). Страница — файл `.page` (раньше `.loop`) «in a new user-owned SharePoint Embedded container»; у неё те же возможности, что у страниц Loop ([FAQ](https://support.microsoft.com/en-us/microsoft-365-copilot/frequently-asked-questions-about-microsoft-365-copilot-pages)).

**Типы.** Текст, а также «interactive charts, visuals, and dashboards». Вход в меню «Draft page or code» ([Get started](https://support.microsoft.com/en-us/topic/introducing-microsoft-365-copilot-pages-6674bd51-9ff5-42c4-9256-44d9428a726f)). Документы, презентации и приложения бывших Copilot Tasks перенесены в Pages ([Copilot app updates](https://support.microsoft.com/en-us/microsoft-365-copilot/learning/changes-microsoft-copilot-app)).

**Путь.**
1. Под ответом — карандаш или «Edit in Pages», в новую или уже существующую страницу.
2. Страница открывается рядом с чатом.
3. Просить правку или править самому.
4. Share.

Ответ можно добавить сразу на несколько страниц.

**Где показ.** Рядом с чатом. Все страницы — в Microsoft Copilot Library ([Library](https://support.microsoft.com/en-us/microsoft-365-copilot/get-started-with-microsoft-365-copilot-library)). Получатель ссылки открывает страницу в Loop. На телефоне — не подтверждено.

**Кто правит** ([Draft content](https://support.microsoft.com/en-us/microsoft-365-copilot/draft-content-with-microsoft-365-copilot-chat-and-copilot-pages))
- **Человек** — прямо, с панелью форматирования на выделенном.
- **ИИ по выделенному** — «Ask Copilot».
- **ИИ по запросу из чата** — меняет страницу. Предупреждение Microsoft: «some content from earlier conversations might be removed».
- **Ярлыки** «Copilot shortcuts» (Alt+U): «Adjust content», «Change tone», «Style page».
  - На неопубликованной странице правки применяются сразу и подсвечиваются.
  - На общей — «you can preview and edit revisions before they’re visible to others»; галочка принимает, есть переключатель «Original» ([shortcuts](https://support.microsoft.com/en-us/microsoft-365-copilot/use-copilot-shortcuts-to-edit-your-microsoft-365-copilot-page)).

**Версии.** Стрелки по версиям и «Restore version» ([version](https://support.microsoft.com/en-us/microsoft-365-copilot/view-or-restore-an-earlier-version-of-your-microsoft-365-copilot-page)).

**Совместная работа.** Правка в реальном времени и комментарии ([collaborate](https://support.microsoft.com/en-us/microsoft-365-copilot/collaborate-with-your-team-on-a-microsoft-365-copilot-page)). Признанное ограничение: «AI responses may not always reflect simultaneous edits by multiple users unless the page is refreshed or re-engaged».

**Шеринг** ([share](https://support.microsoft.com/en-us/microsoft-365-copilot/share-a-microsoft-365-copilot-page))
- «Copy link»: одна страница, без сеанса чата, открывается в Loop, вход рабочей учётной записью.
- «Copy component»: страница вставляется живым компонентом в Teams, Outlook или OneNote, и правки там «update the page in real time».
- Публикации наружу нет.

**Привязка.** Библиотека пользователя. Страницы бывают ссылками в Copilot Notebooks (4.2).

**Экспорт.** В Word и PowerPoint.

**Доступность.** Рабочие учётные записи Entra с хранилищем SharePoint или OneDrive, в том числе без лицензии Microsoft 365 Copilot; личные — Microsoft 365 Personal, Family, Premium, Pro.

### 4.2 Copilot Notebooks → Workspaces

**Copilot Notebooks** — обновление стало GA 12.03.2026 ([techcommunity](https://techcommunity.microsoft.com/t5/microsoft-365-copilot-blog/meet-the-updated-copilot-notebooks-experience-your-home-for/ba-p/4501383)).
- Три колонки: ссылки на материалы, содержимое Copilot Pages, чаты.
- Ссылки на облачные файлы «keeps it up to date even as changes are made to the referenced source file».
- Страница «Overview».
- «Quick create»: черновики, аудиообзоры, карточки, тесты, конспект.
- Блокнот можно открыть коллегам.
- Где: приложение Microsoft 365 Copilot (веб, Windows, Mac, телефон) и OneNote; обновлённый вид — по лицензии Microsoft 365 Copilot.
- **Mind map:** «Explain» в чате, экспорт PNG; «Maps stay private to you even in a shared notebook», хранится 30 дней ([support](https://support.microsoft.com/en-us/microsoft-365-copilot/mindmap-copilot-notebooks)).

**Workspaces** (Ignite, 17.11.2026). «Until now, AI interactions have mostly been single player. Workspaces makes it a truly multiplayer experience… As the evolution of Copilot Notebooks, it’s where people and agents build on each other’s work. An agent drafts a section of a document, and you review. You leave a comment, and an agent picks it up. Your Autopilot takes a task and checks with you before anything is final… the collaboration continues in Microsoft Teams. Workspaces is now available in Frontier» ([microsoft.com](https://www.microsoft.com/en-us/copilot/blog/2026/11/17/copilot-at-microsoft-ignite-expanding-whats-possible-with-intelligence-built-for-work/)).

По уведомлению MC1550540 (12.11.2026), с декабря 2026 Workspaces заменяют отдельный выбор агентов — Researcher, Analyst, Designer — «агентным чатом» ([mc.merill.net](https://mc.merill.net/message/MC1550540)); это зеркало Message Center, первоисточник не открыт.

### 4.3 Office in Copilot, Cowork, Researcher и Analyst, Code и Copilot Managed Runtime

- **Новый Copilot** (25.09.2026, [blogs.microsoft.com](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/)):
  - **Office in Copilot:** настоящие документы Word, книги Excel и презентации PowerPoint «live for your whole team», рядом с беседой; правки коллеги, упомянутого через `@`, «show up as they make them». В Excel «you can see exactly what changed and why».
  - **Code:** «To date, the unit of knowledge work has been the file… Code adds a fourth: small, purpose-built solutions» — виджеты рабочего стола, дашборды, внутренние облачные приложения; «runs in a sandboxed environment and can be hosted securely within your tenant».
  - **Autopilot:** своя Entra Agent ID, назначенный руководитель, журнал действий.
- **Ignite** (17.11.2026). Home и Office in Copilot — GA, Managed Runtime — GA. «Apps are the new knowledge worker artifact… Share them just as you would a Word document». Microsoft прямо спорит с подходом соседей: «More and more, AI companies are building their own documents, slides, or spreadsheets… knowledge work runs on Word, Excel, and PowerPoint».
- **Copilot Managed Runtime** ([learn.microsoft.com](https://learn.microsoft.com/en-us/microsoft-365/managed-apps/managed-runtime-security-governance)):
  - «App code runs inside a sandboxed iframe within the managed host… keeps host-managed authentication tokens out of the app code's reach»;
  - CSP по умолчанию закрыт: запросы только к своему origin, нет inline-скриптов и `eval`, встраивание проверяется;
  - запросы к сервисам идут через хост по коннекторам, по умолчанию подключением каждого пользователя;
  - исходники — в git платформы, сборка — в песочнице без сети;
  - «Publishing is an explicit deployment step», можно выложить прежний коммит;
  - приложение закрыто, пока им не поделились;
  - доступ только внутри организации: «There is no public or anonymous access» ([docs.lovable.dev](https://docs.lovable.dev/integrations/microsoft-copilot-managed-runtime), сторонний разработчик, который выкладывает туда приложения).
- **Cowork.** Создаёт и правит файлы Word, Excel, PowerPoint и PDF в OneDrive или SharePoint; предпросмотр в разговоре; «Download All» — ZIP (по перечню в репозитории).
- **Researcher.** Отчёт с разделами, визуалами и цитатами: «You can edit the report, share it, or use it to kick off a presentation or document» ([support](https://support.microsoft.com/en-us/microsoft-365-copilot/get-started-with-researcher-in-microsoft-365-copilot)). **Analyst** — отчёты с графиками и таблицами.
- **Потребительский Copilot.** 18.08.2026 убраны Group Chat, Podcasts и Deep Research. Copilot Tasks переходят в Cowork: «Documents, presentations, and apps will be converted to Copilot Pages… Existing shared links to Tasks responses and Tasks created content will stop working» ([Copilot app updates](https://support.microsoft.com/en-us/microsoft-365-copilot/learning/changes-microsoft-copilot-app)).

### 4.4 GitHub Copilot: панель артефактов, canvases и issue artifacts

**Панель артефактов VS Code** ([docs](https://code.visualstudio.com/docs/agents/run/artifacts), `chat.artifacts.enabled`). «Artifacts represent notable results… references provide supporting information». Источники артефактов:
- правила: тип MIME (`image/*` → «Screenshots»), шаблон пути (`**/*plan*.md` → «Plans»), записи памяти;
- сам агент — инструментом `#artifacts`, «each update replaces the previous agent artifact list»;
- субагенты — отдельной группой каждого.

`#artifactRules` меняет правила на сессию. Удаление убирает только запись, не файл.

**Canvases** ([VS Code](https://code.visualstudio.com/docs/agents/run/canvases), [Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions))
- «Shared, interactive surface for a work artifact, such as a plan, triage board, browser session, release checklist, dashboard, incident, or spreadsheet»; «bidirectional».
- Агент получает вызываемые возможности (`get_board`, `add_card`, `move_card`), человек — элементы управления на той же поверхности.
- `/create-canvas` создаёт расширение холста:
  - `.github/extensions` — общее, в репозитории;
  - `~/.copilot/extensions` — личное.
- Состояние хранится JSON-файлами (`artifacts`).
- Открывается в правой панели; «stays associated with the chat that opened it».
- Привилегированные возможности (hooks) — с подтверждением.
- Работает только в оболочке Copilot, не в браузерных клиентах.

**Issue artifacts** (предпросмотр с 28.10.2026, [changelog](https://github.blog/changelog/2026-10-28-issue-artifacts-are-now-in-public-preview/))
- Markdown, ссылки и HTML — с переключением «отрисовано / исходник».
- Сессии GitHub App прикрепляют артефакты к issue сами.
- На github.com: создать, изменить, удалить, у каждого — своя ссылка; «retaining its version history».
- CLI ([manual](https://cli.github.com/manual/gh_issue_artifact_edit)): `gh issue artifact create|edit|list|view|download|delete`, `--type generic|plan|embedded_html`, `--attach`; `--restore-version N` записывает прежнюю версию новой версией. Цель — «give coding agents richer context and teams a durable record».

**Прочее**
- **github.com:** «Copilot may generate files… which you can view, edit, and download from the side panel» (предпросмотр, [docs.github.com](https://docs.github.com/en/copilot/how-tos/copilot-on-github/chat-with-copilot/chat-in-github)).
- **Canvas in Teams** (06.11.2026): планы, изменения кода и предпросмотры рядом с беседой команды ([changelog](https://github.blog/changelog/2026-11-06-github-copilot-in-slack-and-teams-is-generally-available)).
- **GitHub Spark:** с 04.08.2026 новых приложений нет, экспорт — до 31.08.2026, выложенные продолжают работать ([changelog](https://github.blog/changelog/2026-08-04-upcoming-deprecation-of-github-spark-on-github-com)). По сторонним источникам, `llm()` в приложениях сломался, когда 30.07.2026 закрылись GitHub Models — не подтверждено.

---

## 5. Сводная таблица

| Продукт | Как называется | Типы | Где показ | Кто правит | Версии | Совместно | Шеринг | Привязка | Агенту | Рабочее и опубликованное |
|---|---|---|---|---|---|---|---|---|---|---|
| ChatGPT Canvas (наследие) | canvas | текст, код, React или HTML | панель рядом | человек, ИИ ярлыками | история, «show changes» | нет | как беседой | чат, проект | — | одно и то же; снят 28.05.2026 |
| ChatGPT Space | page, slide deck, spreadsheet | блочный документ с визуализациями, слайды, таблицы | раздел Space, чат рядом | человек прямо; ИИ — «Ask for change», Generate, `@ChatGPT` и `@dot` | не описаны, корзина | реальное время, комментарии, авторство | View, Comment, Edit; наследование; без публичной ссылки | пользователь и рабочая область, не чат | ChatGPT и dots в странице; API не найден | рабочее; публикация — Sites |
| ChatGPT Sites | site | веб-приложения, D1, R2 | sites, предпросмотр | ИИ по описанию | save version → deploy | редакторы рабочей области | 5 аудиторий, внешние по почте, Remix | отдельно от проектов | Work и Codex, MCP-хостинг | публикация, версия отдельно от выкладки |
| ChatGPT Work, Codex | files, artifacts viewer | docx, xlsx, pptx, pdf, html, tex | десктоп рядом, в вебе — в чате | ИИ, аннотации | по файлам | — | снимок треда | чат | — | файлы |
| Visualize, Intelligent UI | visualization | графики, карты, калькуляторы | в ответе | ИИ | новая вместо правки | — | снимок | чат | — | → «Turn into a Site» |
| Плагины ChatGPT | MCP App, extension | любой интерфейс, файловые редакторы | inline, fullscreen, панель треда, боковая панель | пользователь в интерфейсе, модель через инструменты | `ifMatch` и ETag | — | — | плагин | MCP Apps, `openai/resources/write` | — |
| Gemini Canvas | Canvas | документ, приложение, слайды, код, веб-страница, инфографика, тест, аудио | панель справа, есть на телефоне | человек прямо; ИИ — «Select & ask», ярлыки | Prev и Next | нет | публичная ссылка, Copy Canvas, общие данные приложения | чат | — | снимок по ссылке |
| Gemini Enterprise Canvas | immersive artifact | документ, слайды, HTML-приложение | панель справа, только веб | прямо; поиск и замена в приложениях | у приложений; слайды — каждый раз новый объект | — | приложение — в организации | сессия, чат | IAM `immersiveArtifacts` | экспорт в Docs и Slides |
| Gemini Notebook | artifact (Studio) | аудио, видео, карта, слайды, инфографика, отчёт, сайт, тест | колонка Studio, вкладка | ИИ; слайды — правка по слайдам, новая колода | прежние колоды | общий блокнот; у сайта своё состояние у каждого зрителя | Viewer и Editor, ссылка, Public, ссылка на артефакт, копии | блокнот | API v1alpha | ссылка на артефакт, скачивание |
| Google Stitch | canvas | экраны UI, прототипы, `DESIGN.md` | бесконечный холст | агент, голос, человек | — | «collaborate»; общая работа нескольких людей не подтверждена | через AI Studio (сторонние источники) | проект Stitch | MCP, SDK, навыки | экспорт в Figma, код, AI Studio |
| Copilot Pages | page | текст, графики, дашборды | рядом с чатом, Library, Loop | человек; ИИ — «Ask Copilot», ярлыки | стрелки, Restore | реальное время, комментарии | ссылка на страницу, живой компонент | библиотека пользователя | Copilot и агенты | внутри организации |
| Notebooks → Workspaces | notebook, workspace | ссылки, страницы, быстрые результаты | 3 колонки | люди и агенты | — | агент пишет раздел, человек смотрит; комментарий подхватывает агент | коллегам | блокнот | Autopilot (Entra Agent ID) | внутри организации |
| Code и Managed Runtime | app | приложения, виджеты, дашборды | Copilot | ИИ, код | git, явная публикация | как файлы | «как документ Word», только организация | тенант | SDK и CLI `ms` | рабочее в git, выкладка отдельно |
| GitHub Copilot | artifact, canvas, issue artifact | скриншоты, планы, md, html, ссылки, интерактивные холсты | правая панель, issue | человек и агент через возможности | у issue — с восстановлением новой версией | общее состояние холста | по правам репозитория | сессия, issue, репозиторий | `#artifacts`, `gh issue artifact` | артефакт issue — долговечный |

## 6. Сквозные закономерности

1. **Объект важнее ленты.** ChatGPT убрал canvas и групповые чаты, а общую работу людей и агентов перенёс в Page и Slides. Microsoft пишет: «Until now, AI interactions have mostly been single player». GitHub оформил «issue artifacts» как «durable record». Объект живёт без чата, а чат — средство его менять.
2. **Публикация — отдельный шаг с версией.** Sites: «Save a version» отдельно от «Deploy a version». Managed Runtime: «Publishing is an explicit deployment step». Gemini Notebook: удалённый артефакт гасит ссылку.
3. **Точечная правка ИИ по выделенному** — общая норма: текст, элемент интерфейса, слайд, объект на холсте (аннотации ChatGPT).
4. **Приватность правки ИИ в общем объекте.** Google Docs и ярлыки Copilot Pages показывают правку ИИ одному автору до подтверждения; ChatGPT «Ask for change» показывает предложенную правку.
5. **Агент — участник через упоминание.** `@ChatGPT` и `@dot` в тексте и комментариях, «comment → agent picks it up», Autopilot «@mention it like a colleague».
6. **Многоагентная правка не решена.** Есть заготовки: условная запись по версии (`ifMatch`), поиск и замена вместо перезаписи, вызываемые действия над общим состоянием (canvases), группировка результатов по субагентам (VS Code), собственная учётная запись агента с журналом (Autopilot).
7. **Шеринг — роли и наследование.** View, Comment, Edit (у слайдов ChatGPT — без Comment); доступ, унаследованный от родителя, надо показывать. «Скрытый вид» не граница доступа (chat view у Gemini Notebook).
8. **Копия без данных.** Remix и Copy копируют код и содержимое, но не секреты, записи и файлы.
9. **Состояние интерактива.** Три модели: у каждого зрителя своё (Gemini Notebook sites), общее для всех (Gemini Canvas apps, Tabletop, canvases), данные на сервере плюс временное состояние окна (OpenAI).
10. **Рендер.** Свой origin, iframe-песочница, CSP по умолчанию закрыт (`connect-src 'none'`); токены и коннекторы — у хоста.
11. **Дорогое — с планом заранее.** Gemini Notebook: «Review outline notes» и «Proceed».
12. **Телефон.** Просмотр и правка через разговор; полноценный редактор — в вебе и на десктопе (ChatGPT Slides, Gemini Canvas, mind map Gemini Notebook нет в мобильном).
13. **Артефакт — контекст.** Заметки — источники (Gemini Notebook), Pages — ссылки в Notebooks и обновляются вместе с файлом, `@` на страницы и чаты (ChatGPT), issue artifacts — контекст для агентов.

---

## 7. Что взять Радити

Привязано к тому, что уже есть у Радити:
- вкладка «Документы» справа;
- страницы `<slug>.pages.raditi.ru` с версиями, паролем и снятием (410);
- `page_edit` с `expectedVersion` и правкой поиском и заменой;
- разделы документа `raditi_doc_*` с проверкой, пока ход идёт (план 74);
- проекты плана 84: контекст, память, запланированные задачи.

### 7.1 Две сущности: артефакт и страница

- **Артефакт** — рабочий объект пространства:
  - версии, авторство (человек, агент и чат, в котором он работал), комментарии, роли доступа;
  - открывается справа рядом с чатом и в своём окне;
  - публичного адреса нет.
- **Страница** — публикация снимка выбранной версии артефакта на домене страниц, с паролем или для всех.
  - «Опубликовать» и «Обновить страницу до vN» — явные шаги, как «Save version» и «Deploy» у Sites.
  - Следующая правка артефакта страницу не меняет.
  - Нынешний `page_publish` из чата становится частным случаем: «создать артефакт и сразу опубликовать v1».
- **Дом артефакта:**
  - проект — артефакт виден в колонке проекта и служит его контекстом;
  - или «Мои артефакты» пользователя.

  Перенос между ними — как `task.moveToProject`. Чат, где артефакт родился, — только источник, а не владелец; так ChatGPT разводит Space и Projects, а Microsoft — Library и Notebooks.

### 7.2 Типы: что можно добавить

| Тип | Зачем малому бизнесу | Образец у других |
| --- | --- | --- |
| Документ (Markdown блоками с id разделов) | бриф, ТЗ сайта, политика, статья, отчёт | ChatGPT Pages, Copilot Pages |
| HTML-страница или прототип (один файл) | лендинг, акция, письмо | Gemini Enterprise apps, ChatGPT HTML preview |
| Холст дизайна: несколько фреймов-экранов и вариантов, `DESIGN.md` | 3 варианта главной, мобильный и десктопный вид, «Play» по экранам | Stitch, Claude Design (OR-93) |
| Таблица с формулами | прайс, план контента, импорт товаров | Space Spreadsheets, Office in Copilot |
| Презентация или КП (фреймы 16:9, PDF и PPTX) | предложение клиенту | ChatGPT Slides, Gemini Notebook Slide Deck |
| Схема: Mermaid или SVG, карта сайта, mind map | структура сайта, воронка, процесс | Gemini Notebook Mind Map, Copilot mind map |
| Интерактив: калькулятор, тест, форма | калькулятор стоимости, квиз-подбор | Visualize, Gemini Canvas apps, Notebook sites |
| Трекер или канбан с общим состоянием и действиями агента | чек-лист запуска, задачи по сайту | GitHub canvases, Tabletop |
| Отчёт с источниками и встроенными артефактами | SEO-аудит, анализ конкурентов | интерактивные отчёты Notebook, Researcher |
| Бренд-кит (`DESIGN.md`): цвета, шрифты, тон | общий контекст для всех агентов проекта | Stitch `DESIGN.md`, Brand Kit M365 (OR-158) |
| Обновляемый отчёт (артефакт плюс запланированная задача) | еженедельная сводка по сайту | ChatGPT Sites Automations, «Keep Updated» (ещё нет) |

Порядок MVP: документ → HTML-страница → холст дизайна → таблица; остальное позже. Аудио, видео и музыку не брать: дорого, и задача Радити не про это.

### 7.3 Где показ

Вкладка «Артефакты» в «+ Инструменты» рядом с «Браузером» и «Документами», или «Документы» становится «Артефактами».

**Состав вкладки.** Список артефактов чата и проекта с делением, как в VS Code: «артефакты» — то, что меняли, «ссылки» — то, что только читали. Ещё в ней предпросмотр, «На весь экран», выбор версии с диффом и комментарии.

**Где ещё.**
- **Своё окно:** `/artifacts/<id>`.
- **Галерея:** раздел «Артефакты» на рейке, как Space «All» и Copilot Library.
- **Телефон:** лист на весь экран для просмотра и комментариев; правка — запросом в чат, как в ChatGPT Slides и Gemini Canvas.

### 7.4 Правка, комментарии, версии

- **Человек правит прямо:**
  - блочный редактор для документа;
  - для HTML и холста — исходник и предпросмотр;
  - «Выделить и спросить» — по элементу превью, как «Select & ask», аннотации ChatGPT и IM-03.
- **Комментарии к фрагменту.** Якоря — id блока, диапазон текста, селектор элемента или фрейм холста. `@агент` в комментарии ставит ход в чате артефакта, агент отвечает в ветке и предлагает правку.
- **Версия на каждую правку.**
  - Список версий с автором: человек, агент или «агент из чата X».
  - Дифф — как во вкладке «Изменения».
  - «Восстановить» записывает новую версию (GitHub `--restore-version`), а не стирает историю.
  - Метка «опубликовано как vN» у версии, которая сейчас на странице.
- **Корзина на 30 дней**, как у страниц (план 73).

### 7.5 Совместная работа человека и агентов

- **Точечные правки, а не перезапись.** Поиск и замена и запись раздела по id — как `page_edit` и `doc_*`. У Gemini Enterprise — «search-and-replace edits without regenerating the entire file».
- **Условная запись.** Каждая запись идёт с `expectedVersion` или ETag. На чужую новую версию ответ — `ARTIFACT_CONFLICT` с текущей версией, как `conflict` у OpenAI; агент перечитывает и повторяет. Это закрывает правку несколькими агентами из разных чатов без глобальной блокировки.
- **Присутствие.** «Раздел правит агент из чата X» или «правит Мария» — видно в редакторе и в ответе `artifact_read`. Человек правит в реальном времени: на MVP — с блокировкой блока на время ввода, CRDT — позже, если понадобится.
- **Правка ИИ в общем артефакте — предложением.** Если артефакт открыт другим, правка агента по просьбе одного участника приходит предложением, которое принимают «Принять» и «Отклонить». Владелец может включить «правки агента сразу». Так у Google Docs и ярлыков Copilot Pages.
- **Проверки содержимого** (значения переменных клиента, ключи хода, секреты) — сразу при записи, как живая проверка разделов в плане 74, а не в конце хода. Иначе совместная работа ломается: правку видно лишь через минуты.
- **Кто платит за ход агента.** Тот, чей чат его запускает, в том числе по упоминанию в комментарии. У ChatGPT «each person using their own ChatGPT». Просмотр бесплатен.

### 7.6 Черновик набора MCP-инструментов (семейство `artifacts`)

| Инструмент | Что делает | Примечание |
| --- | --- | --- |
| `artifact_list` / `artifact_search` | артефакты проекта, пользователя и упомянутые в чате | как `page_list` |
| `artifact_read` | `{id, version?, range?\|sectionId?}` → содержимое, `version`, `etag`, кто сейчас правит | читать можно сразу |
| `artifact_create` | `{kind, title, content\|file, projectId?}` | документ и HTML — из `/workspace/out` |
| `artifact_edit` | `{id, expectedVersion, edits[{old,new,all?}]}` | ровно одно совпадение на `old`, как `page_edit` |
| `artifact_write_section` | `{id, expectedVersion, sectionId, content}` | для документов и слайдов |
| `artifact_suggest` | предложенная правка без применения | для общих артефактов |
| `artifact_comments` / `artifact_comment_reply` / `artifact_comment_resolve` | работа с ветками комментариев | ответ — от имени агента |
| `artifact_restore` | `{id, version}` → новая версия | как GitHub |
| `artifact_publish` | версия → страница (новая или новая версия страницы) | `confirmedByClient` |
| `artifact_export` | PDF, DOCX, PPTX, PNG в `/workspace/out` | — |

Чего агенту не давать:
- шеринг, изменение ролей, публичную публикацию без подтверждения клиента (правило 4 по духу);
- удаление — только по прямой просьбе и в корзину.

### 7.7 Шеринг по ссылке

- **Ссылка — приглашение.** Открывает только вошедший пользователь Радити. Роли — читатель, комментатор, редактор. Срок действия, отзыв, журнал доступа.
- **Наследование.** Участники проекта получают его артефакты. Окно шеринга показывает прямой и унаследованный доступ — ChatGPT это показывает, иначе отзыв вводит в заблуждение.
- **«Сделать копию»** — без данных, секретов и комментариев, как Remix и Copy Canvas.
- **Всем без входа** — только через «Страницу» на домене страниц, как разделили OpenAI (Space и Sites) и Microsoft (Pages и Runtime).
- **Нечестных режимов не делать.** Режим «показать только чат, но доступ остаётся» не вводить; Gemini Notebook честно предупреждает, что это не граница доступа.

### 7.8 Безопасность и данные

- **Рендер** HTML, холстов и интерактива — на отдельном origin, как домен страниц: iframe-песочница, CSP по умолчанию `connect-src 'none'`. Токенов в код артефакта не давать, как MCP Apps и Managed Runtime.
- **Данные и ИИ внутри артефакта** — позже, только через мост хоста (`postMessage` → API Радити) со входом зрителя, квотой и списанием. По умолчанию у каждого зрителя своё состояние (Gemini Notebook sites), общее — явным режимом.
- **Хранение.** Артефакты, версии и комментарии — PostgreSQL и S3 в России (правило 1); внешние участники — тоже пользователи Радити.
- **Персональные данные.** Формы и квизы, которые собирают данные посетителей, — отдельное решение (152-ФЗ, правило 1).
- **Prompt injection.** Комментарии и правки соавторов — недоверенный ввод для агента, как предупреждает OpenAI.

### 7.9 Ещё способы применения

- Бриф сайта, который ведут клиент и агент: агенты всех чатов проекта читают его как контекст.
- Три варианта главной на холсте → голосование или комментарии команды → выбранный вариант публикуется страницей или передаётся агенту на сайт клиента (через репозиторий проекта, ветку и карточку).
- План контента таблицей, которую заполняет запланированная задача, с правками людей.
- SEO-аудит или отчёт по конкурентам, который обновляет запланированная задача, со ссылкой «только для чтения» для подрядчика.
- КП или презентация для клиента клиента: шаблон бренд-кита и экспорт в PDF.
- Блоки-запросы в документе («Обсудить с агентом», как Prompt-блоки ChatGPT): читатель запускает чат с контекстом артефакта.
- Артефакт в Telegram: карточка со ссылкой, правка через бота.
- Встраивание артефакта в страницу (таблица или калькулятор внутри опубликованной страницы), как отчёты Notebook со встроенными артефактами и компоненты Loop.
- Аналитика просмотров опубликованной страницы (ChatGPT Sites, Gemini Notebook).

## 8. Чего избегать

1. **Убирать постоянный объект в пользу блоков в ленте.** Опыт ChatGPT: жалобы «not an equivalent replacement», старые canvas, которых не видит модель.
2. **Смешивать снимок и живой объект без пометки.** Общие ссылки Gemini и ChatGPT — снимок, а артефакт у получателя должен быть живым. В интерфейсе это надо называть.
3. **Каждая правка — новый объект без связи версий,** как слайды Gemini Notebook и Gemini Enterprise: копится мусор и теряется история.
4. **Правка «только в той сессии, где создан»** (документы Gemini Enterprise).
5. **Скрытый вид, который не ограничивает доступ** (chat view у Gemini Notebook), и наследуемый доступ, который не видно.
6. **Общий стор данных, который правит любой с публичной ссылкой** (Gemini Canvas apps): ведёт к утечке персональных данных и злоупотреблениям.
7. **Агент перезаписывает страницу целиком.** Microsoft предупреждает, что правка из чата «might remove content». Нужны точечные правки и условная запись.
8. **ИИ внутри артефакта через внешний API, который могут закрыть.** Spark и `llm()`; ссылки, сломанные при миграции (Copilot Tasks → Cowork). Ссылки на артефакты должны пережить смену продукта.
9. **Копия, которая уносит секреты или записи.** У Remix они явно исключены.
10. **Публичный HTML от имени платформы без защиты от фишинга.** У Sites запрещены фишинг и выдача себя за других; Gemini Notebook модерирует публичный поиск. Нужны жалоба и снятие — у страниц они уже есть (`pages:take-down`).

## 9. Не подтверждено и открытые вопросы

- История версий и экспорт ChatGPT Pages — только сторонний обзор.
- Правка Pages на телефоне — только сторонний обзор.
- Подробности Spreadsheets в Space — нет.
- Что все legacy-модели с canvas сняты — один сторонний источник.
- Рендер Gemini Canvas через SafeContentFrame — только ссылка в спецификации MCP Apps.
- Чей лимит тратят ИИ-вызовы общего приложения Gemini — не найдено.
- Шеринг и общая работа нескольких людей в Stitch, нововведения I/O 2026 — только сторонние источники.
- Copilot Pages на телефоне, внешние гости Loop — не проверено.
- Связь Workspaces с MC1550540 — зеркало Message Center.
- Поломка `llm()` в Spark — сторонние источники.
- PiP у ChatGPT: руководство и спецификация расширений расходятся.

## 10. Источники (прочитаны 19.11.2026; дата — дата публикации, где известна)

OpenAI:
- https://learn.chatgpt.com/llms.txt — указатель документации.
- https://learn.chatgpt.com/docs/space, /space/pages, /space/collaboration, /space/agents, /space/getting-started, /enterprise/chatgpt-space.
- https://learn.chatgpt.com/docs/sites, /sites/creating-a-site, /sites/publishing-and-sharing, /sites/managing-a-site, /sites/data-and-connections.
- https://learn.chatgpt.com/docs/artifacts-viewer, /visualizations, /projects, /use-chatgpt, /cloud, /image-generation, /annotations-extensibility.
- https://learn.chatgpt.com/docs/whats-new, /whats-new/devday-2026 (29.09.2026).
- https://help.openai.com/en/articles/6825453-chatgpt-release-notes, через https://api.releases.sh/v1/orgs/openai/sources/chatgpt-release-notes/releases:
  - 10.12.2024, 06.02.2025, 28.05.2026, 08.06.2026, 09.07.2026, 20.08.2026, 01.09.2026, 09.09.2026;
  - 29.09.2026, 07.10.2026, 16.10.2026, 07.08.2026, 05.05.2026.
- https://help.openai.com/en/articles/9930697 (canvas), /11752874 (агент), /10169521 (проекты), /7925741 (общие ссылки) — по выдержкам поисковика.
- https://openai.com/index/introducing-canvas/
- https://community.openai.com/t/please-restore-canvas-as-a-persistent-workspace-writing-blocks-are-not-an-equivalent-replacement/1398999 (19.09.2026).
- https://developers.openai.com/plugins/build/chatgpt-ui, /plugins/build/extensions.
- https://github.com/openai/mcp-extensions/blob/main/docs/spec.md
- https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx
- Сторонний: https://www.beri.net/article/chatgpt-space-shared-pages-inherited-access-no-export-version-history-business-enterprise-admin (04.10.2026).

Google:
- https://support.google.com/gemini/answer/16047321 (Canvas), /13743730 (общие чаты), /17094507 (задачи и файлы), /16972047 (блокноты в Gemini).
- https://support.google.com/gemininotebook/answer/18945748, /16757456, /16758265, /18323649, /16212283, /16454555, /16206563, /16322204, /16213268, /16262519.
- https://blog.google/innovation-and-ai/products/gemini-notebook/notebooklm-gemini-notebook/ (16.07.2026), /co-create-slides-videos/ (19.10.2026), /interactive-sites/ (16.11.2026).
- https://docs.cloud.google.com/gemini/enterprise/docs/assistant-canvas, /configure-canvas.
- https://docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/api-audio-overview
- https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-ai-ui-design/ (18.03.2026), /stitch-loop/ (18.11.2026), /tabletop/ (11.11.2026).
- https://stitch.withgoogle.com/llms.txt
- https://github.com/google-labs-code/stitch-skills
- https://workspaceupdates.googleblog.com/2026/04/new-gemini-capabilities-in-google-docs-help-you-go-from-blank-page-to-brilliance.html (22.04.2026).
- https://workspaceupdates.googleblog.com/2025/05/more-ways-to-create-with-canvas-gemini.html
- https://workspaceupdates.googleblog.com/2026/09/manage-external-sharing-for-gemini-notebook-in-the-Admin-console.html (10.09.2026).

Microsoft и GitHub:
- https://support.microsoft.com/topic/how-microsoft-365-copilot-pages-works-d155bd99-c3cc-4ef8-8da4-c0a92bfce29b
- https://support.microsoft.com/en-us/microsoft-365-copilot/share-a-microsoft-365-copilot-page, /collaborate-with-your-team-on-a-microsoft-365-copilot-page, /draft-content-with-microsoft-365-copilot-chat-and-copilot-pages, /view-or-restore-an-earlier-version-of-your-microsoft-365-copilot-page, /use-copilot-shortcuts-to-edit-your-microsoft-365-copilot-page, /frequently-asked-questions-about-microsoft-365-copilot-pages, /get-started-with-microsoft-365-copilot-library, /mindmap-copilot-notebooks, /get-started-with-researcher-in-microsoft-365-copilot, /learning/changes-microsoft-copilot-app.
- https://support.microsoft.com/en-us/topic/introducing-microsoft-365-copilot-pages-6674bd51-9ff5-42c4-9256-44d9428a726f
- https://techcommunity.microsoft.com/t5/microsoft-365-copilot-blog/meet-the-updated-copilot-notebooks-experience-your-home-for/ba-p/4501383 (12.03.2026).
- https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/ (25.09.2026).
- https://www.microsoft.com/en-us/copilot/blog/2026/11/17/copilot-at-microsoft-ignite-expanding-whats-possible-with-intelligence-built-for-work/ (17.11.2026).
- https://learn.microsoft.com/en-us/microsoft-365/managed-apps/, /managed-apps/managed-runtime-security-governance.
- https://docs.lovable.dev/integrations/microsoft-copilot-managed-runtime
- https://mc.merill.net/message/MC1550540 (12.11.2026, зеркало).
- https://code.visualstudio.com/docs/agents/run/artifacts, /docs/agents/run/canvases.
- https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions
- https://docs.github.com/en/copilot/how-tos/copilot-on-github/chat-with-copilot/chat-in-github
- https://github.blog/changelog/2026-10-28-issue-artifacts-are-now-in-public-preview/ (28.10.2026), /2026-11-06-github-copilot-in-slack-and-teams-is-generally-available (06.11.2026), /2026-08-04-upcoming-deprecation-of-github-spark-on-github-com (04.08.2026), /2026-11-17-github-copilot-app-microsoft-ignite-releases (17.11.2026).
- https://cli.github.com/manual/gh_issue_artifact_create, /gh_issue_artifact_edit.
