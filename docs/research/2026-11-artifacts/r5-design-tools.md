# Холсты дизайна и совместная правка с ИИ: конструкторы сайтов, дизайн-инструменты и доски (на 19.11.2026)

Исследование r5 к разделу «Артефакты». Собрано 19.11.2026 по первоисточникам: справочные центры и документация (docs.lovable.dev, support.bolt.new, v0.app/docs, docs.replit.com, help.figma.com, developers.figma.com, canva.dev, canva.com/help, help.gamma.app, framer.com/help, docs.base44.com, support.wix.com, tldraw.dev, developers.notion.com, notion.com/help, support.airtable.com, plus.excalidraw.com), журналы изменений и блоги компаний. Вторичные источники (пресса, сторонние блоги, каталоги) помечены «вторичный». «Не подтверждено» — не нашёл в первоисточнике. Сохранённые страницы — (локальные копии страниц сессии исследования; в репозиторий не входят).

Что уже было в репозитории: `docs/research/2026-11-agent-features/features.md`, раздел «Артефакты» (OR-70…OR-158; для этой темы — OR-76, OR-79, OR-81, OR-82, OR-84, OR-89, OR-91, OR-93, OR-96, OR-101, OR-108, OR-113, OR-119, OR-146, а также IM-03, IM-25, IC-127, SF-131, SF-133, SF-143) и `products.md`, раздел «Конструкторы сайтов и приложений с агентом» (Lovable, Bolt, v0, Replit, Base44, Wix, Webflow, Framer, данные на 12–14.11.2026). Всё взятое оттуда для этих продуктов подтвердилось; ниже — глубже по холсту, комментариям, совместной работе, шерингу и MCP. Figma, Canva, Gamma, tldraw, Excalidraw, Miro, Notion и Airtable в репозитории как продукты не изучались — здесь они впервые.

---

## 0. Главное

1. **Рабочий объект и опубликованное — разные вещи почти у всех.** Bolt прямо: проект и сайт — «two different things», Share управляет проектом, Publish — сайтом ([Bolt](https://support.bolt.new/collaboration/collaborate.md)). Lovable разводит три уровня: приглашение в проект (роль), ссылка на предпросмотр незавершённой версии (анонимно, только просмотр, комментарии, пароль, срок) и публикация (постоянный адрес со своим доступом) ([Lovable](https://docs.lovable.dev/features/share-project.md)). Gamma: gamma (документ/презентация) и Site — её опубликованная версия, кнопка Present становится Publish ([Gamma](https://help.gamma.app/en/articles/8429268-how-do-i-create-publish-a-site-in-gamma)). Figma Make: файл и опубликованное приложение на `*.figma.site`, комментариев там нет, пароль — только на опубликованном ([Figma](https://help.figma.com/hc/en-us/articles/38701587731735-Add-comments-in-Figma-Make)). Replit: кадры дизайна не публикуются, публикуются «артефакты» проекта ([Replit](https://docs.replit.com/learn/projects-and-artifacts/projects-and-artifacts.md)). Base44 Superagent: публичная ссылка на артефакт — «read-only copy» ([Base44](https://docs.base44.com/superagents/artifacts.md)). Это прямое подтверждение требования владельца «отделяй страницы от артефактов».
2. **Слово «Artifacts» в 2026 используют Replit и Base44.** Replit: артефакт — публикуемый выход проекта (веб- и мобильное приложение, слайды, анимация, визуализация данных, 3D-игра, дизайн); артефакты проекта делят базу, бэкенд, хранилище и публикацию. Base44 Superagent: библиотека «Artifacts» из двух видов — интерактивные артефакты (правит только агент) и документы (правят и человек, и агент), с панелью рядом с чатом, папками, приглашением и публичной ссылкой. Остальные говорят «project», «design», «file», «gamma», «board», «page».
3. **Холст из нескольких дизайнов есть у Replit Design (самый полный), Base44 Canvas, Webflow (все брейкпоинты рядом), Figma (агент на холсте), Miro и tldraw (доски).** У Replit — бесконечная доска, кадры видов Website/Slides/Mobile app/Design/Image/Video/Graphic, предложения рядом с выбранным кадром, новый вариант ложится новым кадром рядом с исходным, смена модели — «другой дизайнер» ([Replit](https://docs.replit.com/design/core-components.md)).
4. **Указать ИИ на элемент — уже норма:** Lovable (S, Cmd+клик, элемент становится ссылкой в поле чата), Bolt (↑/↓ к родителю и потомку), v0 Design Mode, Replit Edit, Base44 Select, Figma Make edit tool, Gamma AI editing mode, Wix (элемент «тегается» в чате), Framer (выделенная секция ограничивает правку).
5. **Прямая правка без ИИ — бесплатна или почти:** Bolt — бесплатно до «Save changes»; Replit — «simple edits apply to source code instantly, without spending credits»; Lovable — 100 бесплатных правок текста с возвратом через 24 часа; Figma Make — правки копятся бесплатно, Apply тратит кредиты.
6. **Комментарии стали каналом к агенту:** Lovable (`@Lovable` или «Send to chat» отправляет весь тред с элементом), Bolt («Send comments to Bolt», только Editor и Co-owner), Base44 (каждый новый комментарий по умолчанию начинается с `@Base44`), Figma MCP `get_comments` (для Make — версия приложения, экран и место). tldraw в блоге 11.08.2026 сформулировал вывод: агенту нечем «показать пальцем», и комментарии как отдельные записи, привязанные к месту холста, лучше фигур и заметок, которые копятся анонимно ([tldraw](https://tldraw.dev/blog/agents-cant-point)).
7. **ИИ правит точечно, а не перегенерирует:** Canva Code — «diff-based editing»; Gamma — «Ask for a small change and the AI fixes just that», сравнение Original/Modified; Notion MCP — поиск-и-замена `old_str`/`new_str` и «предложенные правки» на одобрение; Canva MCP — транзакция start → perform → commit, коммит падает, если человек правил дизайн параллельно.
8. **Несколько агентов на одном объекте решают четырьмя способами:** изоляция и слияние (Replit — каждая задача в изолированной копии, Lovable drafts, ветки Base44 и Framer, где «teammates and AI agents can work on separate branches at the same time»); очередь (Bolt — один общий тред, один запрос за раз); оптимистичная проверка версии (Canva commit, Notion «stale suggestion»); видимость (Webflow Agent Presence от 21.10.2026 — блёстка и имя того, кто запустил агента, без блокировок; Figma — индикатор работы на кадре; tldraw Fairies — аватары агентов, вторичный).
9. **MCP-сервер есть у всех лидеров:** v0, Lovable, Replit, Figma (запись `use_figma`, бета), Canva (≈45 инструментов), Gamma, Framer (работает при закрытом редакторе), Webflow (companion app синхронизирует живой холст), Base44, Miro (19 млн вызовов к 07.10.2026), Notion. Общие черты: OAuth на пользователя и его права; ссылка «открыть и править» после каждого действия (Canva «design edit handoff»); двухфазное подтверждение разрушительного (Notion `user_confirmed`); предел ответа (Figma — 48 000 байт на вызов).
10. **Мост «дизайн → код/сайт» стал отдельной кнопкой:** Replit Build (кадр → новый артефакт или «применить к существующему»), Figma code-to-canvas и `html_to_figma` (живой UI или HTML → слои) и обратно, импорт дизайнов Claude в Replit, v0 и Base44 как самодостаточного HTML.
11. **Телефон урезан у всех:** v0 Design Mode не работает на мобильных вьюпортах, у Replit Edit скрыт на мобильном, Wix Aria правит только десктоп-вид, Gamma на мобильном начинает в Express; комментарии на телефоне работают (Lovable, Bolt).

---

## 1. Продукты

Пункты в каждом разделе: (1) понятие и название; (2) типы объектов; (3) где показ; (4) кто правит; (5) версии; (6) совместная работа; (7) шеринг; (8) привязка; (9) инструменты агента и API; (10) экспорт; (11) безопасность показа; (12) лимиты и цены; (13) рабочее против опубликованного.

### 1.1. v0 (Vercel)

Источники: [Design Mode](https://v0.app/docs/design-mode) (обновлено 18.11.2026), [changelog](https://v0.app/changelog), [Sharing](https://v0.app/docs/sharing), [MCP для агентов](https://v0.app/docs/api/v2/guides/integrating-v0-into-agents), [Security](https://v0.app/docs/security), [каталог коннекторов Claude](https://claude.com/connectors/v0).

1. Объект — чат с версиями, внутри — Next.js-приложение в песочнице Vercel. Слова «artifact» нет.
2. Веб-приложения; слайды и документы как отдельные типы — не подтверждено. Нативных вариантов A/B в интерфейсе не нашёл (не подтверждено); пример приложения на Platform API генерирует три варианта на запрос (вторичный).
3. Чат + предпросмотр с переключателем версий (16.10.2026: «Preview version picker lists every version in order»), Code tab. Design Mode открывается «beside your running app»; недоступен в чатах только для чтения и на мобильных вьюпортах.
4. Агент; пользователь — Design Mode: наведение подсвечивает, клик даёт ручки и панель (типографика, цвет текста, фон, внешние и внутренние отступы, рамка, прозрачность, скругление, тень, прямая правка текста); `Cmd+I` — переключение между выбором и работой с приложением. Структурное — словами, к сообщению прикладывается скриншот выбранного элемента. Правки висят в предпросмотре до Apply, Apply «produces a new chat version». 08.06.2026 — плавающая панель, просмотр слоёв, линейка отступов; 19.06.2026 — Annotations mode: клик по элементам ставит нумерованные комментарии, они уходят агенту пачкой. Code viewer — правка с Save/Discard и комментарии к строкам как контекст (products.md).
5. Каждая правка — версия; дифф; восстановление создаёт новую последнюю версию (products.md); дифф после Apply.
6. Совместная работа — в командах Vercel: 06.10.2026 личные аккаунты стали командными пространствами; 10.09.2026 новые чаты команды видны команде по умолчанию; 21.07.2026 — запрос доступа к закрытому чату. Живого присутствия на холсте — не подтверждено. 14.08.2026: «v0 can list, inspect, create, and continue your other chats».
7. Видимость чата: Private / Only people with access; Everyone at <команда> (с флажком View only); Anyone with the link («will not be indexed by search engines»); Anyone on the web («may be indexed… and appear in public galleries»). Личные роли Can View / Can Edit (редактор может менять видимость, архивировать и удалять). Владелец команды открывает любой чат команды по URL. Рекомендованный путь правки чужого: пригласить Can View → Duplicate → копия, при желании связанная с тем же проектом Vercel.
8. Чат принадлежит команде; связь с проектом Vercel и веткой GitHub.
9. MCP `https://v0.app/api/mcp`, OAuth (ключ API в конфиг не класть); группы: чаты (создать, импорт), файлы (читать и править), сообщения, задачи (`resolveTask` — одобрение плана), деплой, управление (MCP-серверы, вебхуки, расход, доверенные хосты предпросмотра), поиск и импорт из Claude Design. В каталоге Claude: `createChat`, `getChat`, `getPreview`, `import-claude-design-from-url`, `listChats`, `listMessages`, `resolveTask`, `sendChatMessage`. Platform API v2 (26.06.2026), `listMessages` (07.07.2026).
10. Скачивание кода (16.10.2026), GitHub-ветки и PR, деплой на Vercel.
11. «Code runs in isolated environments»; в браузер уходят только `NEXT_PUBLIC_`-переменные. Домен и изоляция предпросмотра не описаны.
12. До 100 MCP-серверов на область (28.08.2026). Цены не изучал.
13. Версия чата ≠ публикация на Vercel (у опубликованного — вход в команду или пароль, products.md).

### 1.2. Lovable

Источники: [Edit from the preview](https://docs.lovable.dev/features/preview-toolbar.md), [Project comments](https://docs.lovable.dev/features/project-comments.md), [Share a project](https://docs.lovable.dev/features/share-project.md), [Version history](https://docs.lovable.dev/features/projects/history.md), [Drafts](https://docs.lovable.dev/features/drafts.md), [Lovable MCP server](https://docs.lovable.dev/integrations/lovable-mcp-server.md), [Chats](https://docs.lovable.dev/features/chats.md), [Generate files](https://docs.lovable.dev/features/generate-files.md), [Project chat](https://docs.lovable.dev/features/projects/chat.md). Справка без дат на страницах; changelog от 12.11.2026 (products.md).

1. Проект (приложение) и сгенерированные файлы; «artifact» не используется.
2. Веб-приложения; файлы PDF, DOCX, PPTX, TXT, Markdown, CSV, XLSX, картинки, видео, аудио. Презентация — двумя путями: «as a web app» (слайды на весь экран в браузере, правка в чате, публикация как проекта) или «as a downloadable file». В Chats (вне проектов) — только текстовые файлы (Markdown, CSV, JSON), картинки и короткие видео; «PDF files, slide decks, spreadsheets with formulas, Word documents, and web pages… need a project».
3. Чат и предпросмотр; в Chats предпросмотр проекта «opens beside the conversation»; панель Context (Projects, Files, Chats); вкладка Files (сетка или список, предпросмотр PDF, документов, таблиц, презентаций). Телефон: комментарии и предпросмотр в мобильном браузере и приложении, переключатель «Click to add».
4. Агент; пользователь — панель предпросмотра (заменила Visual edits): **Select elements** (`S`, Cmd/Ctrl+клик — несколько; «Each selected element attaches to the project chat input as a reference»), **Edit text inline** (`T`), **Draw annotation** (`D`; линии, стрелки, прямоугольники, круги; «Rough shapes are recognized and cleaned up automatically»; агент получает сообщение и скриншот с пометкой), **Add a comment** (`C`). Code mode — ручная правка кода на платных тарифах. Пока агент работает, новые запросы с выбором или рисунком подхватываются «at its next natural stopping point», а правки текста и треды комментариев ставятся отдельным запросом с пометкой «Runs after the current task».
5. «Every change Lovable makes… creates a version automatically»; снимок без изменений, «Open preview in new tab», «View code changes» (дифф), «Go to message in chat», Revert (с датой; откатывает только код и функции, не данные базы), закладки, бейдж Published; «Revert and resend» — правка своего прошлого сообщения; частичного отката нет («all or nothing per version»).
6. Роли проекта Admin / Can edit / Can view; комментарии — пины на элементах, номера тредов (`#3`), перенос пина, ответы, реакции, Resolve/Reopen, панель с поиском и сортировкой, уведомления во входящих; `@Lovable` или «Send to chat» отправляет тред «including the page, the element, and all comments» как структурированную обратную связь. Если элемент перестроили, «the pin may lose its reference or attach to the wrong element», пин показывает признак потери. Drafts — копия проекта со своим чатом, предпросмотром и правками; «Update draft» подтягивает main; Accept показывает однострочную сводку; принятие может сразу менять живой бэкенд. Живые курсоры — не подтверждено.
7. Приглашение по почте или группе; ссылка-приглашение «Anyone with the link can edit / can view», срок 7 дней, «Only one active invite link», смена уровня выпускает новую ссылку. **Ссылка на предпросмотр**: «view-only URL for the latest in-progress version», без аккаунта, не даёт редактора, чата и кода; имя ссылки, «Allow comments» (гостевые комментарии с именем без регистрации; гости не видят ответов `@Lovable`); на Free/Pro срок 7 дней, на Business/Enterprise — пароль от 8 знаков и срок 24 часа / 7 / 30 дней / никогда; пароль «is not a login… does not identify who opened the link», разблокировка на 24 часа в браузере; удаление ссылки необратимо, до минуты на распространение. Публикация — `lovable.app` или свой домен, доступ публично / организация / приглашённые (products.md).
8. Проекты в пространстве и папках; Chats — личные, «you cannot share a chat or make it public»; **«Your files»** — файлы, созданные Lovable во всех чатах пользователя, подключаются к другому чату (до 10 в сообщении), правка файла сохраняется «as a new version»; «Files generated through a project stay in that project». `@` даёт проекты, коннекторы, файлы и дизайны Figma.
9. MCP `https://mcp.lovable.dev`, OAuth, все тарифы. Инструменты: `get_me`, `list_workspaces`, `get_workspace`, `list_projects`, `get_project` (с адресом редактора, предпросмотра и скриншотом), `create_project`, `deploy_project`, `remix_project`, `set_project_visibility`, `send_message` (`plan_mode`, `files`, `wait=false`, `draft_id`), `get_message`, `list_messages`, `create_draft`, `list_drafts`, `get_draft`, `rename_draft`, `accept_draft`, `reject_draft`, инструкции и навыки, `get_diff`, `list_files`, `read_file`, `list_edits`, база (`query_database` — «full database permissions»), коннекторы, аналитика. Пример из справки: «Build 3 versions of a landing page… Deploy all three and give me the live URLs».
10. ZIP кода, синхронизация с GitHub/GitLab/Bitbucket, файлы офисных форматов.
11. Файлы генерируются скриптами «in an isolated environment»; домен предпросмотра не изучал.
12. 100 бесплатных правок текста на аккаунт (каждая возвращается через 24 часа) и 2 000 в сутки на пространство; выбор и рисунок — кредиты; комментарии бесплатны, отправка треда агенту — кредиты; кредиты за откаченные правки не возвращаются.
13. Три уровня (пункт 7); drafts → Accept → «unpublished changes» → Publish.

### 1.3. Bolt (StackBlitz)

Источники: [Visual edits](https://support.bolt.new/building/visual-edits.md), [Comments](https://support.bolt.new/collaboration/comments.md), [Collaborate](https://support.bolt.new/collaboration/collaborate.md), [Sharing](https://support.bolt.new/collaboration/sharing.md), [Bolt Slides](https://support.bolt.new/use-cases/slides.md); release notes 2–8.11.2026 (products.md).

1. Project (рабочее) и Site (опубликованное); «Bolt Slides» — проект-презентация.
2. Сайты и веб-приложения, мобильные приложения (Expo), слайды с заметками докладчика и интерактивом (3D-модель, слайдер «до/после», кликабельная карта, «idea board» с совместными стикерами).
3. Чат, предпросмотр, Code view с терминалом; Responsive mode, тема, новое окно, полный экран. На телефоне Comments — в меню проекта, Share — рядом с названием.
4. Агент; пользователь — **Select tool**: наведение подсвечивает, «The up arrow moves to the element containing the one you're pointing at», Cmd+клик — вложенный; двойной клик — правка текста; панель свойств (alt, фон, размер шрифта 8–96, ссылка, список, object fit, прозрачность и др.); «Add changes» кладёт правку в пачку над полем ввода, маркер на элементе, «Save changes» отправляет пачку в код. «Making visual edits in the preview is free. Bolt uses tokens only when you save». Элемент внутри canvas или графика не выбирается — вставить скриншот.
5. История версий с переименованием и закладками, восстановление из истории чата (products.md).
6. **Multiplayer**: «Every project has a single shared chat thread. To prevent conflicting edits, Bolt processes one prompt at a time»; запросы соавторов встают в очередь; токены списываются с того, кто запросил. Комментарии: пин с аватаром, счётчиком и синей точкой непрочитанного, панель по страницам, `@`-упоминания; «Send comments to Bolt» — только Editor и Co-owner; Viewer комментирует и отвечает; удаление первого комментария удаляет тред; комментарии работают в предпросмотре, «not on a published site». GitHub и MCP-серверы подключает только владелец; правки соавторов уходят в GitHub, когда владелец откроет проект.
7. Роли Viewer / Editor / Co-owner (Co-owner — только своей команде); Free — до 3 соавторов на проект, платные — без предела; ссылка проекта работает только для принявших приглашение и команды, остальным — «Request access»; «To let anyone on the internet see your project, publish it as a live site»; Viewer не видит переменных окружения.
8. Дашборд проектов («shared with me», избранное), командные шаблоны.
9. Внешнего MCP-сервера Bolt не нашёл (не подтверждено); MCP-коннекторы внутрь — только владелец.
10. GitHub, публикация на bolt.host или Netlify; презентация — Present и Speaker view.
11. Не изучал.
12. Визуальные правки бесплатны до сохранения; 3 соавтора на Free.
13. Share ≠ Publish; «After publishing, updates you make in your project don't automatically appear on your site».

### 1.4. Replit (Agent и Replit Design)

Источники: [What is Replit Design](https://docs.replit.com/design/what-is-replit-design.md), [Components](https://docs.replit.com/design/core-components.md), [Canvas](https://docs.replit.com/design/canvas.md), [Frames](https://docs.replit.com/design/frames.md), [Elements](https://docs.replit.com/design/elements.md), [Toolbar](https://docs.replit.com/design/toolbar.md), [Explore suggestions](https://docs.replit.com/design/explore-suggestions.md), [Explore with different models](https://docs.replit.com/design/explore-with-different-models.md), [Projects & Artifacts](https://docs.replit.com/learn/projects-and-artifacts/projects-and-artifacts.md), [Invite teammates](https://docs.replit.com/build/invite-teammates.md), [Development URLs](https://docs.replit.com/core-concepts/project-editor/app-setup/development-urls.md), [Import Claude designs](https://docs.replit.com/design/import-claude-designs-into-replit-design.md); changelog 13.11.2026 (products.md).

1. **Project** — контейнер; **Artifacts** — «the publishable outputs inside it… Each one is a complete, standalone output that gets its own shareable URL when you publish»; файлы, картинки, CSV, код — опора артефактов, сами не публикуются. **Replit Design** — «an infinite canvas that displays frames».
2. Артефакты: web app, mobile app, slide deck, animation (MP4), data visualization, 3D game, design. Кадры холста: Artifact (Website, Slides — живые), Mobile app (в симуляторе), Design (мокап; «Convert to a real app» через Build), Image, Video, Vector graphic (SVG). Размеры для «покажи мобильную версию»: 390 × 844, 768 × 1024, 1280 × 720.
3. В проекте переключатель Design/Build в шапке, холст занимает панель; Focus mode — кадр во весь вид; «Read-only mode» — когда холст заблокирован фоновой задачей; на телефоне Edit скрыт, инструмент Chat — только на компьютере.
4. Агент: чат на холсте (выбранные кадры «attaches those frames to the next Agent message as snapshots»), «Cursor chat» (`/`) у курсора. Пользователь: **Interact** (`V`), **Pan** (`H`), **Draw** (стрелки, фигуры, стикеры; «Agent reads your markup»), **Edit** (выбор элемента в живом кадре, Visual Editor: Text, Layout — выравнивание 3×3, направление, gap, outer/inner space, Color, Border, Image; «Simple edits apply to source code instantly, without spending credits»), **Generate** (Image — Nano Banana, Nano Banana 2, Nano Banana Pro, ChatGPT Images 2.0; Video — Veo 3.1, Seedance 2.0; Graphic — Claude 4.6 Opus, Gemini 3.1 Pro Preview; ссылки-образцы с доски). Контекстное меню: Edit, Chat, Focus, Cursor chat, порядок, копировать, дублировать, удалить, «Export as…».
5. Чекпоинты с откатом кода, контекста чата, памяти и базы; File History (products.md). На холсте каждая итерация — новый кадр рядом, «nothing is lost by exploring».
6. Приглашение по почте или «Private join link»; «Each person can start new planning threads with Agent»; общая Kanban-доска задач Draft / Active / Ready / Done; «Active — Agent is building this task right now in its own isolated copy of the project»; Ready применяет любой; «Agent handles conflicts automatically when multiple tasks are applied». Core — 5 мест и 1 активная фоновая задача, Pro — 15 мест и 10 задач.
7. Development URL «private by default and require authentication»; переключатель «Private preview» делает его открытым всем по ссылке; external access tokens для вебхуков и API. Публикация — отдельно.
8. Артефакты одного проекта «automatically share: Database, Backend and API, File storage, Deployment… you can't publish one artifact without publishing the others». Отдельно — Chats и Projects.
9. Replit MCP Server для десктоп-клиентов; агент пишет в другие чаты и создаёт их (30.10.2026, products.md).
10. Кадр — PNG (Export, `Cmd+Shift+C`), анимация — MP4.
11. Не изучал.
12. Build из кадра — Core или Pro; режимы Free / Power / Max и уровень Effort.
13. Кадры Design — спецификация, публикуются артефакты; dev URL ≠ Publish.

Важное для холста: **предложения** («Ambient intelligence») появляются рядом с выбранным кадром — «A new look», «An extension» (раздел или страница, которых нет), «A new context» (мобильный вид); клик сразу строит новый кадр рядом, чат пишет, что изменилось. **Смена модели** — «Suggestions explore directions with the same designer; switching models changes the designer». **Build…** — «Build this design» (новый артефакт) или «Apply to an existing Artifact» («Agent rewrites the Artifact's code to match the design, leaving the Design frame on the Canvas for reference»). **Импорт**: Figma, сайт по адресу, скриншот, дизайн из Claude (Share → Send to → Replit, проект со статичным `index.html` и задачей «Turn this Claude design into a real app»).

### 1.5. Figma: Make, MCP-сервер и агент в файлах Design

Источники: [Explore Figma Make](https://help.figma.com/hc/en-us/articles/31304412302231-Explore-Figma-Make), [Make editing tools](https://help.figma.com/hc/en-us/articles/42009840449175), [блог 30.07.2026](https://www.figma.com/blog/properties-panel-and-annotations-now-in-figma-make/), [Comments in Make](https://help.figma.com/hc/en-us/articles/38701587731735-Add-comments-in-Figma-Make), [Figma agent in design files](https://help.figma.com/hc/en-us/articles/37998629035799), [MCP tools](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/), [Write to canvas](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas), [Code to canvas](https://developers.figma.com/docs/figma-mcp-server/code-to-canvas/), [Make → MCP](https://developers.figma.com/docs/figma-mcp-server/bringing-make-context-to-your-agent/), [Rate limits](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/); публикация Make — [статья](https://help.figma.com/hc/en-us/articles/31304586129559) и сводка поиска.

1. Make file — функциональный прототип или веб-приложение; в Figma Design — файл с кадрами, компонентами и переменными; Figma Sites (бета) — отдельный продукт публикации.
2. Make — веб-приложения и прототипы; Design — кадры, компоненты, варианты, переменные; FigJam — доски и диаграммы; Slides; Specs (открытая бета).
3. Make: чат и рабочая область с вкладками Browser (предпросмотр и правка), Files (код), Review (изменения кода); «You can also run several chats at once in one file». Агент в Design: поле запроса прямо на холсте у выбранного слоя (кнопка Agents или `Cmd/Ctrl+Enter`) или постоянная боковая панель.
4. Make: агент; edit tool с панелью свойств в стиле Figma Design (цвета, padding, margin, текст; несколько элементов — рамкой или Shift), draw tool (пометки попадают в запрос картинкой), «Annotate for agent» (заметки на точках интерфейса, можно с картинкой, сразу на несколько элементов). «The changes you make aren't committed until you click Apply»; «Edits stack up in the chat panel first, staged and credit-free, until you apply them»; Apply тратит кредиты и создаёт версию; «Teammates can work in the same conversations… and simultaneously modify the generated code». Агент в Design: раскладка, auto layout, перевод между размерами экрана, стили и переменные, экземпляры компонентов; `@` — компоненты, переменные, стили подключённой библиотеки; «Run multiple prompts at once… Each running prompt shows an animated loading indicator on the canvas».
5. Make: «A new version is created whenever you or Figma AI edits the file»; просмотр, избранное, имя, восстановление; восстановление оставляет поздние версии. Агент в Design: Undo в чате; сравнить — сначала дублировать.
6. Комментарии в Make: клик по элементу, Figma «captures a screenshot of the element's current state»; «You can only comment on the latest version», панель делит на Current version и Other versions; упоминания, картинки, Resolve, уведомления. Видимость чатов агента в Design (с 23.06.2026 видны редакторам по умолчанию) — встретил только в сводке поиска, не подтверждено.
7. Превью — делятся владельцы Full seat (сводка поиска); публикация «for your organization or to the public web», адрес вида `three-random-words.figma.site`, свой домен (Professional — 10, Organization и Enterprise — без предела, общий с Sites); пароль — Organization/Enterprise, «applies only to the published *.figma.site version; the preview is not protected»; «People who visit a published app on the public web don't have access to comments».
8. Файлы в командах и черновиках; Make-файлы отдаются внешнему агенту как MCP-ресурсы (выбор файлов проекта) — так прототип становится контекстом в чужой кодовой базе.
9. MCP (удалённый сервер рекомендован). Чтение: `get_design_context` (код React+Tailwind или другой каркас), `get_metadata` (лёгкий XML), `get_screenshot`, `get_variable_defs`, `get_comments` (в Make — версия приложения, экран и место в предпросмотре; чтение не помечает прочитанным), `search_design_system`, `download_assets`, `export_video`, `get_figjam`, `whoami` и др. Запись: `use_figma` (выполняет код Plugin API: страницы, кадры, компоненты, варианты, переменные, стили, текст; FigJam — стикеры, секции, коннекторы; Slides), `html_to_figma` (самодостаточный HTML до 50 МБ, «up to 20 per call» кадров, без компонентов библиотеки), `generate_figma_design` (живой UI в слои), `create_new_file`, `generate_diagram` (FigJam из описания или Mermaid), `upload_assets` (до 10 МБ, 60 файлов), `generate_image`, `generate_vector_illustration`, `send_code_to_figma` (проект в Make-файл). Запись — бета, «free to use during the beta period… will eventually become a usage-based paid feature»; «Output is beta quality and may need manual review»; советуют пробовать на копии.
10. Код Make — через MCP-ресурсы; MP4; исходные картинки.
11. Не изучал.
12. Лимиты MCP: Full/Dev на Professional — 200 вызовов в день и 10 в минуту, Organization — 200 и 15, Enterprise — 600 и 20, View/Collab — 20 в месяц; пишущие инструменты и действия с AI-кредитами в предел не входят; ответ инструмента — до 48 000 байт.
13. Make-файл ≠ опубликованное приложение (свой пароль, нет комментариев). Пользователь на форуме жалуется, что опубликованное отстаёт от предпросмотра на несколько итераций — это жалоба, не документ.

### 1.6. Canva (Canva AI 2.0, Canva Code 2.0, Canva MCP)

Источники: [Canva Code — справка](https://www.canva.com/help/canva-code/), [Canva Code 2.0 — newsroom](https://www.canva.com/newsroom/news/canva-code/) (14.07.2026 по [VentureBeat](https://venturebeat.com/ai/canva-launches-code-2-0-offering-ai-website-building-to-every-user-including-free-accounts/) и [Khaleej Times](https://www.khaleejtimes.com/tech/canva-code-20-explained-how-the-new-ai-tool-builds-websites-and-apps), вторичные), [Canva MCP](https://www.canva.dev/docs/apps/mcp.md), [Access](https://www.canva.dev/docs/apps/mcp/access.md), [Best practices](https://www.canva.dev/docs/apps/mcp/best-practices.md), [Design edit handoff](https://www.canva.dev/docs/apps/mcp/workflows/design-edit.md), [инструменты и лимиты](https://www.canva.dev/docs/apps/mcp/tools.md), [start-editing-transaction](https://www.canva.dev/docs/apps/mcp/tools/start-editing-transaction.md), [commit-editing-transaction](https://www.canva.dev/docs/apps/mcp/tools/commit-editing-transaction.md), [generate-design](https://www.canva.dev/docs/apps/mcp/tools/generate-design.md); Canva AI 2.0 — [SiliconANGLE 16.04.2026](https://siliconangle.com/2026/04/16/canva-unveils-canva-ai-2-0-recasting-platform-agentic-system-work/) (вторичный).

1. «Design» из страниц; Canva Code — тип дизайна «Code» и интерактивные элементы внутри других дизайнов.
2. Презентации, доски, документы, соцпосты, видео, сайты, Code-дизайны (сайты, приложения, викторины, калькуляторы, графики), Sheets.
3. Полный Code-дизайн открывается в редакторе после выбора Code на главной; уточнение интерактивного элемента — «side-panel chat»; Preview — работать с интерактивом.
4. Canva Code «now uses diff-based editing, so only the lines that need to change are updated»; 2.0: «select a specific element to refine with conversational AI», ручная правка — картинки из библиотеки, цвета и шрифты из панели, текст на месте; HTML import; код «can't be exported as a file or directly edited within Canva», есть «Show code» → «Copy code». Canva AI 2.0 (16.04.2026, исследовательский предпросмотр) — «object-based editing»: меняется один элемент без перегенерации (вторичный).
5. «Canva automatically saves a new version within the same chat thread» на каждый запрос; любую версию можно «Use in a design».
6. 2.0: «Teams can build, review and refine together in real time and comment right in the editor»; при этом «Only you can see your conversations with Canva Code». Присутствие ИИ на холсте — не подтверждено.
7. Ссылка совместной работы: по умолчанию «Only people added»; «Anyone with the link» с Can view / Can comment / Can edit (на одной из страниц справки — правка без входа в десктопном браузере, вторичная сводка); отдельно «Public view link» и «Template link», их можно удалить ([справка](https://www.canva.com/help/collaborate-with-anyone/)). Публикация сайта: бесплатный домен, свой домен, внутри организации по SSO; повторная публикация обновляет тот же адрес.
8. Папки проектов, бренд-кит; Code-элемент можно вставить в презентацию, доску и другие дизайны.
9. MCP (≈45 инструментов в [перечне canva.dev](https://www.canva.dev/docs/apps/llms.txt)): поиск и чтение (`search-designs`, `get-design`, `get-design-content`, `get-design-pages`), генерация (`generate-design` — «Present the candidates to the user to choose from rather than auto-selecting», → `create-design-from-candidate`; `create-design` — асинхронно), `copy-design`, `resize-design`, `merge-designs`, `import-design-from-url`, **транзакции** `start-editing-transaction` → `perform-editing-operations` (операции по `element_id` из старта, `replace_text`, `find_and_replace_text`) → `commit-editing-transaction` / `cancel-editing-transaction`, комментарии (`comment-on-design`, `reply-to-comment`, `list-comments`, `list-replies`), ассеты, бренд-шаблоны и автозаполнение, папки, `export-design`, `help`. Ключевое: «Commit can fail if the design is edited concurrently (for example, a person editing in the browser) during your transaction. Retrying the same transaction won't help, because its snapshot is stale. Cancel it, start a fresh transaction, re-apply, and commit». Правило «design edit handoff»: после любого действия с дизайном вернуть ссылку на правку в Canva и призыв «Open in Canva to edit»; «don't claim that a design was created or an edit was saved until the tool response confirms it». OAuth на каждого пользователя, права — его собственные. Адрес `https://mcp.canva.com/mcp` — по сторонним каталогам.
10. Экспорт через MCP — PDF, JPG, PNG, PPTX, GIF, MP4, CSV; Code — только копия кода.
11. Не изучал.
12. Лимиты на инструмент: `generate-design` 20/мин, `generate-image` 10/мин, `upload-asset-from-url` 30/мин; resize, autofill, бренд-киты и шаблоны — Pro и выше; слишком большой виджет мешает публикации.
13. Дизайн ≠ опубликованный сайт; интерактив работает «when the design is viewed on Canva or published as a website».

### 1.7. Gamma

Источники: [Create with Agent](https://help.gamma.app/en/articles/15002203-how-do-i-create-with-agent-in-gamma), [Edit content with AI](https://help.gamma.app/en/articles/8033284-how-do-i-edit-my-content-with-ai), [Sharing](https://help.gamma.app/en/articles/11047226-how-do-collaboration-and-sharing-settings-work-in-gamma), [Publish a site](https://help.gamma.app/en/articles/8429268-how-do-i-create-publish-a-site-in-gamma), [Embed](https://help.gamma.app/en/articles/11047806-can-i-embed-gamma-into-another-site), [Remix](https://help.gamma.app/en/articles/12601672-what-is-remix-and-how-do-i-use-it), [API](https://help.gamma.app/en/articles/11962420-does-gamma-have-an-api), [Connectors/MCP](https://help.gamma.app/en/articles/13943863-how-do-i-use-gamma-with-outbound-connectors-and-integrations), [Version history](https://help.gamma.app/en/articles/11048579-can-i-undo-a-change-or-restore-a-previous-version-in-gamma), [жалоба «AI clobbered my edits»](https://ideas.gamma.app/ideas/p/gamma-ai-clobbered-my-edits).

1. «gamma» — presentation, document, webpage, social post; Site — опубликованная версия gamma.
2. Презентации, документы, веб-страницы, соцпосты, Image slides (слайд — одна картинка с текстом), формы, инфографика, свой HTML-блок («Describe an interactive element… and Gamma builds it»).
3. Редактор с чатом агента слева; во время сборки «Slides appear in a live grid as they are created», полоса миниатюр; значок вкладки жёлтый, по готовности — зелёная галочка; Present/Spotlight. На мобильном браузере старт в Express.
4. Агент: Plan (вопросы с вариантами, план, ждёт «go-ahead»), Express (сразу черновик), Research (Pro+, только с Plan). Правка: «AI editing mode» — переключатель Agent и клик по элементам, «Edit with Agent» у слайда, `Cmd+E`; «Ask for a small change and the AI fixes just that, without reworking the rest»; быстрые правки в один клик; **Original / Modified** — сравнение до и после, в том числе по нескольким слайдам; «Changes from a single request are applied together, you cannot pick and choose individual edits»; можно править руками всегда.
5. Version History на всех планах: восстановить версию, отдельно — тему; undo/redo; глубина зависит от плана; именованных версий нет (запрос на доске идей).
6. Роли View / Comment / Edit, «Workspace settings override individual sharing settings», запрос доступа с одобрением по почте. Живая совместная правка — по сторонним обзорам (вторичный).
7. No access / View / Comment / Edit по ссылке; пароль — Pro и выше, «only available for Gamma documents», сайты — нет; «Make discoverable on the web» (Pro); embed — «only gamma docs or presentations», сайты встраивать нельзя.
8. Пространство и папки с правами.
9. MCP `https://mcp.gamma.app/mcp` (ChatGPT, Claude, Glean, Cursor, Grok, Atlassian…): создать, «Edit existing gammas — Ask a connector to change a gamma you have edit access to… Editing isn't available on Enterprise plans». API v1.0 GA с 05.11.2025: генерация, из шаблона, **`POST /v1.0/agent/gammas/{gammaId}/edits` — «applies a natural-language change to one page»**, `POST /v1.0/agent/generations`, чтение, комментарии, экспорт, аналитика, поиск; ввод до 100 000 токенов; `X-API-KEY` или OAuth.
10. PDF, PowerPoint, PNG (бейдж «Made with Gamma» на Free).
11. Не изучал (есть статья о cookies на опубликованном сайте).
12. Кредиты; Remix тратит кредиты.
13. gamma ≠ Site: «The Gamma 5 agent can't create webpage-format gammas or publish sites, so publishing is a step you take in the editor»; сайт нельзя вернуть в документ.

### 1.8. Framer

Источники: [How to use Agents](https://www.framer.com/help/articles/how-to-use-agents/), [Framer MCP](https://www.framer.com/help/articles/what-you-can-do-with-framer-mcp/), [Branches](https://www.framer.com/help/articles/how-to-use-branches-in-framer/), [Updates](https://www.framer.com/updates), [live collaboration](https://www.framer.com/help/articles/live-collaboration-in-framer/) (по сводке поиска).

1. Проект сайта; ветки; Staging и версии.
2. Страницы, разделы, CMS, код-компоненты; картинки, текстуры и шейдеры агентом (12.11.2026).
3. Agent — в правой панели Properties.
4. Агент «reads your current canvas, generates the necessary design and code, and places the result directly on your page»; выделенная секция включает context tool — «The Agent will focus its changes on the selected area rather than modifying the entire page»; Harness 2 (02.11.2026) — «whole workflows in a single program», то же для MCP; Convert — воронки и A/B-тесты агентом (03.11.2026).
5. Ветки: «isolated copy of your project», «Review Changes» с диффом, Apply; ветка от ветки; откат применённой ветки в истории версий «removes those changes from main and moves them back into a draft state».
6. Живые курсоры, «follow», видно, кто смотрит проект; «teammates and AI agents can work on separate branches at the same time»; «If two branches modify the same content, review the changes carefully before applying them».
7. Роли Editor / Viewer (и Admin); ссылка только для просмотра; ветку можно опубликовать на отдельный адрес для ревьюеров.
8. Пространство и проект.
9. MCP: удалённый Streamable HTTP с OAuth (Codex, Claude Code, Cursor, Pi, Windsurf, Warp, Grok); «your agent can work with projects… while the editor is closed»; агенты создают ветку, «Review the result in Framer before you merge the branch or publish»; локализации в MCP нет — локальный CLI `@framer/agent`.
10–12. Не изучал.
13. «Applying a branch updates main, but it does not publish your site».

### 1.9. Webflow

Источники: [MCP server and AI tools](https://developers.webflow.com/data/docs/ai-tools.md); Agent Presence — [appsrow](https://www.appsrow.com/blog/webflow-agent-presence-how-ai-agents-collaborate-on-the-canvas) (вторичный, со ссылками на справку) и сводка справки [Real-time collaboration](https://help.webflow.com/hc/en-us/articles/43232037920275) (страница закрыта проверкой браузера, текст — из сводки поиска); products.md (Webflow Conf 02.09.2026).

1. Сайт в Designer; страницы, компоненты, CMS; ветки страниц и публикация одной страницы (products.md).
2. Страницы, разделы в рамках дизайн-системы (AI Assistant, бета), AI code components, style guide на переменных.
3. Designer; холст всех брейкпоинтов рядом.
4. AI Assistant; внешние агенты через MCP: OAuth и companion app, которое «syncs your live canvas with your AI agent» (должно оставаться открытым в Designer).
5. Ветки, Releases (бета), журнал действий с атрибуцией агентов (вторичный).
6. Совместная работа в реальном времени до 25 человек, каждый отменяет свои действия. **Agent Presence** (21.10.2026): где работают агенты, подключённые через MCP, — блёстка и имя человека, запустившего агента; в верхней панели, Pages, Components и на холсте; «does not lock elements or prevent users from editing or publishing»; последняя правка, дошедшая до сервера, сохраняется; нет живых курсоров; текст синхронизируется после выхода из блока; не показывает AI Assistant; «does not currently distinguish between multiple agents run by the same person»; не работает в CMS, Ecommerce, Optimize, шаблонах.
7–12. Не изучал.
13. Правки сохраняются сами и отделены от публикации.

### 1.10. Wix (Harmony, Aria)

Источник: [Working with Aria](https://support.wix.com/en/article/wix-harmony-editor-working-with-aria) (обновлено 13.08.2026); products.md.

1. Сайт в редакторе Harmony (с января 2026). 3. «Ask Aria» внизу справа. 4. Выбранный элемент помечается в чате («Aria will know exactly what to update»); «Ask Aria» на панели действий — короче/длиннее, тон, раскладка раздела, отступы; «Anything Aria can do, you can also adjust or edit manually»; «Aria is only available when editing the desktop view», мобильный — руками. 9. Wix MCP и Site MCP каждого сайта (products.md). Остальное — не изучал.

### 1.11. Base44 (Wix): редактор приложений, Canvas и библиотека «Artifacts» у Superagent

Источники: [Superagent Artifacts](https://docs.base44.com/superagents/artifacts.md), [Canvas](https://docs.base44.com/Building-your-app/Canvas.md), [Comments](https://docs.base44.com/Building-your-app/Commenting-on-your-app.md), [Branches](https://docs.base44.com/Building-your-app/working-with-branches.md), [Base44 MCP server](https://docs.base44.com/developers/backend/overview/mcp-server.md); product changelog ноября 2026 (products.md).

1. Приложение (редактор: чат, предпросмотр, Select mode, Canvas, Dashboard, история, ветки, публикация) и **Superagent** с библиотекой **«Artifacts»** — «your Superagent's library for the work you do together».
2. Два вида в библиотеке: **Artifacts** — «interactive visuals, charts, or tools» (дашборд продаж, таймлайн поездки, калькулятор бюджета) и **Documents** — страницы из блоков (текст, заголовки, списки, медиа, таблицы, **Kanban board** — «A board is text underneath, where each column is a heading and each card is a list item»), заметки встреч. Files и Data — отдельно; память — отдельно.
3. Агент создаёт или обновляет объект → карточка в чате → «Open artifact» в панели рядом с разговором; переключение объектов в шапке панели; «Open full page»; «Present» — большое окно поверх страницы.
4. «You and your Superagent can both edit documents. To change an artifact, ask your Superagent». «Update with agent»: «The chat opens with that item attached to your message, and your Superagent edits the same item instead of making a new one».
5. У приложений — история с диффом и сравнением с main (products.md); у артефактов Superagent — не подтверждено.
6. Canvas приложения: «Each collaborator's cursor appears as a named pointer… Colored outlines show which elements each person has selected»; комментарии на элементах со скриншотом места; «Each new comment starts with an @Base44 mention, so it goes to the AI chat unless you remove it»; привязка к элементу переживает сборки; «Comments belong to the branch you add them on… When you merge or delete a branch, its comments are deleted». Ветки: своя копия чата, предпросмотра, дизайна и страниц; сборки идут параллельно; приватные ветки видны только автору; «Merge to main replaces the Publish button».
7. Артефакт: **Invite** (почта, view или edit; после принятия — в «Shared with you») и **Create public link** («read-only copy, without signing in», «Unpublish»); папка шарится целиком, включая будущие объекты; удаление — ссылки перестают работать, без отмены.
8. Библиотека Superagent с папками, поиском, фильтром по виду и «shared with you».
9. MCP `https://app.base44.com/mcp`, OAuth, пространство фиксируется на подключение, права — пользователя, проверка членства на каждый запрос. Проектные инструменты: `create_base44_app`, `edit_base44_app` (правку делает ИИ редактора), `list_branches`, сущности, коннекторы, `import-claude-design-from-url`. Песочница: `list_directory`, `read_file`, `grep`, `write_file`, `edit_file` («exact string replacements»), `run_command`, `start_checkpoint` → `create_checkpoint` (точка восстановления в истории).
10. Интерактивный артефакт — «Download… as an HTML file».
11–12. Не изучал.
13. Приложение: ветка → Merge to main → Publish; Superagent: публичная ссылка на копию только для чтения.

Холст приложения: каждая страница — живой кадр на бесконечной доске; у кадра — меню вида Desktop / Tablet / Phone, ручки размера, Refresh; страницы с холста не удаляются («ask the AI chat»); инструменты Select (`V`), Hand (`H`), Draw (`D`), Sticky note (`N`), Image (`I`); **стикер** со статусом To do / In progress / Done, связью-стрелкой с кадром страницы и кнопкой **«Send to chat»** («If the note is connected to a page frame, the AI applies the change to that specific page»).

### 1.12. tldraw

Источники: [Agent starter kit](https://tldraw.dev/starter-kits/agent), [AI integrations](https://tldraw.dev/docs/ai) (31.01.2026), [блог «Agents can't point»](https://tldraw.dev/blog/agents-cant-point) (11.08.2026); Fairies — [доклад AI Engineer Europe 2026](https://ai.engineer/talks/agents-on-the-canvas-in-tldraw) и [пересказ](https://ccm-design-engineer.netlify.app/summaries/fairies-ai-agents-as-canvas-collaborators-summary) (вторичные).

1. SDK бесконечного холста; Agent starter kit («a foundation to create diagram generators, drawing assistants, or visual AI applications»); комментарии `@tldraw/commenting` (SDK 5.3, `<CanvasComments>`); эксперименты Fairies, make real.
2. Фигуры, стрелки, заметки, встраивания, свои фигуры — например, предпросмотр кода, который модель написала по наброску («make real»).
4. Контекст агента: «A screenshot of the agent's current view», упрощённые фигуры в виде и кластеры вне его, выделение и недавние действия пользователя, история; действия — типизированные схемы с `_type` (создать, изменить, удалить, повернуть, выровнять, распределить…); система «validates, sanitizes, and applies actions» (исправляет несуществующие id, нормализует координаты); «Shapes get created, updated, and deleted incrementally as each action finishes streaming», недописанное действие не применяется; `schedule`/`interrupt`; `agent.prompt` с `bounds`.
6. Мультиплеер (отдельный starter kit). Блог 11.08.2026: «The agent can't point»; ранние демо писали заметки и фигуры прямо на холст — они анонимны и копятся; комментарий — «its own record, sitting parallel to the canvas and pointing into it», треды можно закрывать и подписывать; Claude, упомянутый в треде, отвечал в треде; комментарии — «a surprisingly nice surface» для координации нескольких агентов. Fairies (вторичный): каждый агент — видимый аватар на холсте с состоянием (думает, проверяет, работает), группа с оркестратором, раздающим задачи и проверяющим результат.
Остальное — SDK, к продукту не применимо.

### 1.13. Excalidraw+

Источник: [plus.excalidraw.com](https://plus.excalidraw.com/) (без дат). Text to diagram — «Generate and edit diagrams from chat or the editor» (есть и в бесплатном редакторе); Wireframe to code — «Generate interactive mockups»; MCP — «Let an agent draw into your workspace. On Excalidraw+»; совместная работа по ссылке в реальном времени; read-only ссылки «Share just content, not the scene access»; кадры как слайды, Live Presentations. Версии и комментарии — не подтверждено.

### 1.14. Miro

Источники: [Canvas 26](https://miro.com/blog/canvas-26-product-highlights/) (19.05.2026), [MCP server blog](https://miro.com/blog/miro-mcp-server/) (07.10.2026), [февраль 2026](https://miro.com/blog/whats-new-february-2026/).

Доска. Sidekicks — агенты на доске, с 19.05.2026 «from assistant to agent», генерируют «full board content from a single prompt» (документы, диаграммы, Kanban, стикеры, фреймы — по вторичным), Flows — повторяемые процессы на холсте с коннекторами (Slack, Atlassian, Notion, GitHub, Granola); Prototypes — контекст из Claude Code, Copilot, Cursor, Replit, варианты, бренд, передача кодовому агенту. MCP с февраля 2026 (бета): >19 млн вызовов, 15 клиентов, 85 000+ организаций в августе; агенты строят диаграммы, раскладки, слайды, кликабельные прототипы, таймлайны и «edit one part of a board while leaving the rest unchanged»; «Each result is visual, editable, and open to everyone working on the board… the next agent that reads the board picks up the team's edits and decisions». Присутствие агентов, комментарии к агенту — не подтверждено.

### 1.15. Notion (Notion Agent, Custom Agents, Notion MCP)

Источники: [Notion Agent](https://www.notion.com/help/notion-agent), [Custom Agents sharing and permissions](https://www.notion.com/en-gb/help/custom-agents-sharing-and-permissions), [MCP: Work together — reference](https://developers.notion.com/guides/mcp/tools-comments-reference.md), [MCP: Pages — reference](https://developers.notion.com/guides/mcp/tools-pages-reference.md), [MCP rate limits](https://developers.notion.com/guides/mcp/rate-limits.md); даты Custom Agents (24.02.2026) и кредитов (04.05.2026) — вторичные.

1. Страницы и базы. Notion Agent (личный) и Custom Agents (по триггерам и расписанию).
2. Страницы, базы и их виды (карты, формы), свойства.
3. Чат агента внизу экрана, боковая панель или плавающее окно.
4. Agent «works on the page you're on by default, or on blocks you select»; создаёт и правит страницы и базы; «If you can't view or edit specific content, your agent can't either»; **не может создавать и править комментарии**; читает историю версий.
5. Через MCP: `notion-view-version`, `notion-get-version-changes` — «what changed… and who made each change, including edits from Notion AI, Custom Agents, and MCP clients», `notion-restore-version` — сначала без `user_confirmed` (ответ говорит, что откатится), затем с подтверждением.
6. Custom Agents: доступ даётся на ресурс (Can view / Can comment / Can edit), «There are no inherited permissions from anyone» — агент может раскрыть то, чего пользователь не видит; агент шарится как страница: Can view and interact / Can edit / Full access; журнал аудита всех действий.
7–8. Права страниц Notion; перемещение страницы меняет доступ по новому родителю.
9. MCP: комментарии (`notion-create-comment` на страницу или блок, `notion-get-comments`, `notion-update-comment`, `notion-delete-comment`, `notion-set-discussion-resolved` — только когда попросит человек, реакции); **предложенные правки** (`notion-create-suggested-edit`: `old_text` «must appear exactly once», `new_text`, `mode` replace / insert_before / insert_after; «A suggestion doesn't change the page until someone accepts it»; создание — право комментировать, принятие — право правки; «One suggestion can't overlap another pending suggestion»; «If someone edits the text a suggestion covers, the suggestion becomes stale»; `notion-resolve-suggested-edit` помечен `destructiveHint`); `notion-update-page` с `update_content` — операции поиска-и-замены `old_str`/`new_str`, пропущенные — в `warnings` (`no_match`), или `replace_content`; `notion-delete-pages` требует `user_confirmed: true`; асинхронные задачи (`allow_async`, `notion-get-async-task`); лимиты — общие лимиты API, повтор, если ждать ≤2 с.
13. Публикацию Notion Sites не изучал.

### 1.16. Airtable (Omni); Coda

Источники: [Using Omni AI](https://support.airtable.com/docs/using-omni-ai-in-airtable), [AI-generated interface elements](https://support.airtable.com/docs/ai-generated-interface-elements-in-airtable) (2026). Omni строит таблицы, интерфейсы и автоматизации по описанию; сгенерированные интерфейсы правятся в обычном Interface Designer, исходного кода нет; элемент, построенный на одной странице, нельзя перенести на другую; дублирование страницы — форк, дальнейшие правки кода к копии не применяются; права: создатель настраивает, редактор пользуется, наблюдатель и комментатор смотрят; Omni действует с правами пользователя. Coda — не изучал.

---

## 2. Сравнительная таблица

| Продукт | Понятие, название | Типы | Где показ | Кто правит, как ИИ правит | Версии | Совместно и несколько агентов | Шеринг | Привязка | Агенту (MCP/API) | Рабочее vs опубликованное |
|---|---|---|---|---|---|---|---|---|---|---|
| v0 | chat + версии | Next.js-приложения | чат + предпросмотр, Design Mode рядом | Design Mode (панель, Apply), аннотации пачкой; правка кода | каждая правка, дифф, picker | команды, Can View/Edit, Duplicate; нет присутствия (н/п) | Private / команда / по ссылке (noindex) / весь веб | команда, проект Vercel | MCP чатов, файлов, деплоя, импорт Claude Design | версия ≠ Publish на Vercel |
| Lovable | project, files, drafts | приложения, офисные файлы, слайды как приложение | чат слева, предпросмотр, Files, Chats | S/T/D/C; 100 бесплатных правок текста; follow-ups на остановке | авто, дифф, закладки, revert кода | роли, комментарии с @Lovable, drafts с Accept | приглашение (7 дн.), ссылка предпросмотра (пароль, срок, гостевые комментарии), публикация | пространство, папки; «Your files» пользователя | MCP ≈40 инструментов (сообщения, drafts, файлы, дифф) | три уровня |
| Bolt | project vs site; Slides | сайты, мобильные, слайды | чат, предпросмотр, Code view | Select (↑/↓), пачка «Save changes», бесплатно до сохранения | история с именами | один общий тред, один запрос за раз, очередь; комментарии → Bolt | Viewer/Editor/Co-owner; Free — 3; Request access | дашборд, шаблоны | MCP внутрь; внешнего — н/п | Share ≠ Publish |
| Replit | Project → Artifacts; Design canvas | web, mobile, slides, MP4, data viz, 3D, design, image, video, SVG | Design/Build в шапке, Focus | Edit + Visual Editor (без кредитов), Draw, Generate, предложения | чекпоинты, кадры рядом | задачи в изолированных копиях, доска задач, автослияние | dev URL приватный, переключатель | артефакты проекта делят базу и деплой | MCP-сервер; агент пишет в чаты | кадры не публикуются; артефакт = URL |
| Figma | Make file; файлы Design | приложения, кадры, FigJam, Slides, Specs | чат + Browser/Files/Review; агент на холсте | edit tool, draw, аннотации; staged до Apply; параллельные запросы | версия на правку, имя, избранное | несколько чатов в файле; комментарии по версиям | Full seat; публикация в орг./веб | команды; Make как MCP-ресурс | MCP 30+ инструментов, `use_figma` (бета) | файл ≠ figma.site |
| Canva | design, Code | презентации, доски, сайты, интерактив | редактор, боковой чат | diff-based; выбор элемента + ИИ; код не правится | версии в треде | real-time + комментарии; чат личный | только добавленные / по ссылке view/comment/edit; public view; template | папки, бренд-кит | MCP ≈45: транзакции с конфликтом, кандидаты, комментарии | design ≠ сайт |
| Gamma | gamma; Site | презентации, документы, веб, соцпосты | редактор, чат слева, живая сетка | Plan/Express/Research; AI editing mode; Original/Modified | история на всех планах | роли; права пространства сильнее | No/View/Comment/Edit; пароль только doc | папки | MCP; API правки страницы словами | gamma ≠ Site (агент не публикует) |
| Framer | проект; ветки | сайты, CMS, код-компоненты | Agent в правой панели | context tool — правка секции | staging, версии, ветки | агенты и люди в разных ветках | Editor/Viewer; ссылка ветки | проект | MCP (редактор закрыт), CLI | Apply ≠ publish |
| Webflow | сайт в Designer | страницы, разделы, компоненты | Designer, все брейкпоинты | Assistant; MCP-агенты через companion app | ветки страниц, Releases | Agent Presence, без блокировок, last write wins, 25 человек | н/и | сайт | MCP 2.x | автосохранение ≠ публикация |
| Wix | сайт Harmony | страницы, разделы | Ask Aria | тег элемента; ручная правка рядом; только десктоп-вид | н/и | н/и | н/и | сайт | Wix MCP | н/и |
| Base44 | app; Superagent «Artifacts» | артефакты (интерактив), документы (блоки, Kanban) | панель рядом с чатом, full page, Present | документы — оба, артефакты — агент; «Update with agent» | приложения — да; артефакты — н/п | Canvas с курсорами; комментарии @Base44; ветки параллельно | invite view/edit; публичная копия; папки | библиотека, папки, shared with you | MCP: edit_base44_app, sandbox edit_file, checkpoints | ветка → main → publish |
| tldraw | SDK холста | фигуры, встраивания, свои фигуры | холст | типизированные действия, потоком | — | Fairies (аватары, оркестратор); комментарии как канал | — | — | starter kit | — |
| Excalidraw+ | сцена | диаграммы, мокапы, слайды | холст | text-to-diagram, wireframe-to-code | н/п | real-time | read-only ссылки | рабочее пространство | MCP «agent draws» | — |
| Miro | board | доски, документы, диаграммы, прототипы | доска | Sidekicks, Flows, точечная правка части доски | н/и | агенты видят правки команды | н/и | доска | MCP (19 млн вызовов) | — |
| Notion | page, database | страницы, базы, виды | чат-панель | правами пользователя; не пишет комментарии | история; атрибуция ИИ и MCP | Custom Agents со своими правами | права страниц | дерево страниц | MCP: suggested edits, search-replace, restore с подтверждением | н/и |
| Airtable | base, interface | таблицы, интерфейсы | Interface Designer | Omni; кода нет | н/и | права пользователя | роли | база | н/и | н/и |

н/п — не подтверждено; н/и — не изучал.

---

## 3. Холст дизайна: что работает у других

### 3.1. Доска и кадры
- **Бесконечная доска с кадрами разных видов** (Replit): живые кадры приложений, мокапы, картинки, видео, SVG. У кадра — шапка с видом, панель действий при выборе (Export PNG, Build…, Focus, «…»), правый клик — копировать, дублировать, удалить, порядок, экспорт. Выбранные кадры прикладываются к следующему сообщению снимками. [Replit Frames](https://docs.replit.com/design/frames.md)
- **Все страницы сайта — живыми кадрами** (Base44): у каждого кадра меню Desktop / Tablet / Phone и ручки размера — превью перестраивается и переключает вьюпорт; позиция и масштаб доски запоминаются на устройство. [Base44 Canvas](https://docs.base44.com/Building-your-app/Canvas.md)
- **Все брейкпоинты рядом** (Webflow) — удобно проверять правки агента (products.md).
- **Focus mode** — кадр во весь вид, «Exit focus» назад (Replit).
- **Размеры по просьбе**: «Show me the mobile version of this page» → кадр 390 × 844 (Replit).

### 3.2. Варианты и A/B
- **Предложения рядом с выбранным кадром** (Replit «Ambient intelligence»): «новый вид», «расширение» (раздел цен, контакты), «новый контекст» (мобильный); клик — новый кадр рядом, исходный не трогается, чат пишет, что изменилось. [Replit](https://docs.replit.com/design/explore-suggestions.md)
- **Другой дизайнер** — та же задача на другой модели даёт кадр рядом (Replit).
- **Кандидаты на выбор** (Canva `generate-design`): агент не выбирает сам, «Present the candidates to the user».
- **Три развёрнутых варианта** (Lovable MCP пример) — каждый со своей ссылкой.
- **Новый облик без перегенерации содержания** (Gamma: «ask for a new look instead of regenerating»).
- **Сохранить и попробовать другое направление** (Claude Design, products.md, [support.claude.com](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)).

### 3.3. Указать на элемент
- Наведение подсвечивает, клик выбирает, `Cmd/Ctrl+клик` — ещё элемент (Lovable, Bolt), ↑/↓ — родитель и потомок (Bolt), рамка или Shift (Figma Make), «Inspect» `Cmd+I` — переключить выбор и работу с приложением (v0).
- Выбранное становится **ссылкой-чипом в поле чата** (Lovable: «Each selected element attaches to the project chat input as a reference»; Replit — снимок кадра; Wix — тег элемента; Webflow — «drop element into Assistant»).
- Выделение **ограничивает зону правки** (Framer context tool; Gamma — «The more specific your selection, the more targeted the fix»).
- В кадр, который рисует canvas или график, выбор не попадает — честно сказать «вставьте скриншот» (Bolt).

### 3.4. Прямая правка без ИИ
- Двойной клик — текст на месте (Bolt; Lovable `T`; WordPress.com AI Edit).
- Панель свойств только с тем, что применимо к элементу (Bolt: «The toolbar shows only properties you can edit on that specific element»; Replit Layout скрывается для текста).
- **Пачка и одна отправка**: правки копятся маркерами над полем, «Save changes»/«Apply» отправляет всё разом (Bolt, Figma Make, v0); предупреждение при уходе с неприменёнными правками (v0).
- **Без кредитов**: Bolt (до сохранения), Replit (простые правки сразу в код), Lovable (100 правок текста); у Figma Make свойства тратят AI-кредиты при Apply.

### 3.5. Пометки и стикеры
- Рисовать поверх предпросмотра и отправить как картинку с текстом (Lovable `D`, с выпрямлением фигур; Figma Make draw; Replit Draw — «Agent reads your markup»).
- **Стикер-задача** (Base44): статус To do / In progress / Done, стрелка-связь с кадром страницы, «Send to chat» — ИИ правит именно эту страницу.
- **Аннотации пачкой** (v0 Annotations mode — номера на элементах; Figma «Annotate for agent» — сразу несколько элементов).

### 3.6. Комментарии как канал к агенту
- Пин на элементе + **скриншот места** (Base44, Figma Make), номер треда `#3` (Lovable), аватар и счётчик, синяя точка непрочитанного (Bolt).
- **Отправить тред агенту**: `@Lovable` или «Send to chat» — уходит «the page, the element, and all comments»; системное сообщение в треде подтверждает отправку (Lovable). Base44 — `@Base44` по умолчанию в каждом новом комментарии. Bolt — выбрать несколько комментариев галочками, «Select all», заметка и отправка; только Editor и Co-owner.
- **Потеря якоря**: при перестройке пин «may lose its reference», показывает признак; тред сохраняется (Lovable).
- **Комментарии и версии**: комментировать можно только последнюю версию, остальные — в «Other versions» (Figma Make).
- **Гостевые комментарии** по ссылке предпросмотра без аккаунта (Lovable); гости не видят ответов агента.
- **Агент читает комментарии** через MCP (Figma `get_comments` с местом в предпросмотре; Canva `list-comments`; Notion `notion-get-comments`) и отвечает в треде (tldraw — Claude в треде), а не новыми фигурами.

### 3.7. Как ИИ правит
- Точечно: Canva Code «diff-based editing»; Gamma «fixes just that»; Framer — в пределах выделенной секции; Miro MCP — «edit one part of a board while leaving the rest unchanged».
- **Правка как поиск-и-замена с проверкой**: Notion `update_content` (`old_str`/`new_str`, пропуски — в `warnings`), Base44 `edit_file` («exact string replacements»), Notion suggested edit (`old_text` ровно один раз).
- **Транзакция**: Canva start → perform → commit; коммит падает при параллельной правке, повторять ту же транзакцию бессмысленно.
- **Показать до и после**: Gamma Original / Modified; v0 и Lovable — дифф версии; Lovable drafts — однострочная сводка при Accept.
- **Предложение вместо правки**: Notion suggested edits — человек принимает или отклоняет.

### 3.8. Агент на холсте и несколько агентов
- **Индикатор работы на кадре** — клик открывает ход работы (Figma agent: «Each running prompt shows an animated loading indicator on the canvas»).
- **Присутствие агента как участника**: Webflow — блёстка и имя запустившего, рамка вокруг правимого элемента; tldraw Fairies — аватар с состоянием (вторичный); Base44/Framer — курсоры людей.
- **Изоляция**: Replit — задача в изолированной копии, Ready → применить, конфликты сводит агент; Lovable drafts; Base44 и Framer — ветки, агенты параллельно; «teammates and AI agents can work on separate branches at the same time» (Framer).
- **Очередь**: Bolt — один тред, один запрос за раз; Lovable — follow-ups на ближайшей остановке, отдельные запросы «Runs after the current task».
- **Проверка версии**: Canva commit; Notion «stale» предложение; v0 — «предупреждение о неприменённых правках».
- **Атрибуция**: Notion `notion-get-version-changes` называет правки Notion AI, Custom Agents и MCP-клиентов; Webflow — журнал действий.
- **Без блокировок**: Webflow Presence не блокирует, «the last change to reach its servers is the one saved».

### 3.9. От дизайна к коду и сайту
- Replit Build: кадр → новый артефакт или «применить к существующему», кадр остаётся на доске как справка.
- Figma: живой UI → слои (`generate_figma_design`), HTML → слои (`html_to_figma`), правка на холсте → ссылка на кадр агенту → код («round trip»).
- Импорт дизайнов Claude как самодостаточного HTML: Replit («static `index.html`»), v0 и Base44 (`import-claude-design-from-url`).
- Публикация презентации: Bolt Slides Publish, Lovable deck как приложение, Gamma Site.

### 3.10. Телефон
- v0 Design Mode — нет на мобильных вьюпортах; Replit Edit скрыт, Chat tool только на компьютере; Wix Aria — только десктоп-вид; Gamma — Express по умолчанию.
- Комментарии на телефоне — да: Lovable (кнопка с числом открытых тредов, «Click to add», список), Bolt (в меню проекта); Base44 — ветки с телефона.

---

## 4. Что взять Радити

Ниже — предложения под требования владельца, с привязкой к тому, что уже есть: «Документы» справа (план 67, 74), страницы и сайты страниц `<slug>.pages.raditi.ru` (планы 69, 73), инструменты `doc_*` (документ по разделам) и `page_*` (в том числе `page_edit` — поиск-и-замена с проверкой, что страницу не изменили), проекты (план 84).

### 4.1. Артефакт отдельно от страницы
- **Артефакт** — рабочий объект: приватный по умолчанию, с версиями, его правят пользователь и агенты, он живёт у пользователя или в проекте. **Страница** — опубликованная копия конкретной версии артефакта по постоянному адресу, с паролем и снятием (то, что уже есть). Так устроены Gamma (gamma → Site), Bolt (project → site), Figma Make (файл → figma.site), Base44 (артефакт → «read-only copy»).
- Кнопка у версии артефакта: **«Опубликовать как страницу»** (новая страница или новая версия уже связанной; связь «артефакт → страница» хранится, страница помечает, из какой версии она сделана). Публикация — только по нажатию клиента; агент может предложить (правило 3 «один прод»: страница — это «прод» артефакта).
- Ссылки «поделиться» (4.5) — для людей внутри Радити; анонимный просмотр — это страница. Так снимается путаница Lovable (три вида ссылок) — у нас два: приглашение в артефакт и публикация.

### 4.2. Типы артефактов
Обязательные по запросу владельца:
1. **Текст** — документ из разделов (`.md`), как сейчас `doc_*`, но с правкой пользователем в редакторе, комментариями и версиями.
2. **Страница HTML** — одна самодостаточная страница (как Документы-страницы), с видом исходника и прямой правкой текста.
3. **Холст дизайна** — доска с кадрами (4.8).

Предлагаю ещё (по нуждам малого бизнеса и по тому, что сделали другие):
4. **Презентация** — HTML-слайды с заметками докладчика, показом и видом докладчика, экспортом в PDF (Bolt Slides, Lovable deck as web app, Gamma).
5. **Таблица** — прайс, список товаров, клиенты, план публикаций: ячейки правят и человек, и агент, экспорт CSV/XLSX (Base44 документ с таблицами, Airtable).
6. **Доска задач (Kanban)** — текст внизу (колонки — заголовки, карточки — пункты, как Base44), поэтому агенту легко читать и править; статусы стикеров To do / In progress / Done.
7. **Чек-лист и план работ** — с отметками и сроками; агент отмечает сделанное в чатах проекта (связь с запланированными задачами плана 82).
8. **Схема** — блок-схема, путь клиента, оргструктура из Mermaid в SVG (Figma `generate_diagram`, Excalidraw, Miro).
9. **Отчёт и дашборд** — графики по выгрузке сайта или таблице, без сети (как сейчас страницы с графиками); позже — с данными артефакта.
10. **Форма и опрос** — собирает ответы в данные артефакта (Gamma, Canva Code); только после решения о ПДн (правило 1).
11. **Фирменный стиль** — живая страница стиля: цвета, шрифты, кнопки, логотип; её подключают к другим артефактам как контекст (Replit design system и DESIGN.md, Webflow style guide, Canva бренд-кит).
12. **Набор публикаций** — посты и баннеры для соцсетей из HTML/SVG в PNG по размерам площадок (Canva resize).
13. **Письмо и рассылка** — HTML письма с предпросмотром на телефоне и компьютере.
14. **Калькулятор или виджет** — интерактив для сайта (Canva Code, Gamma HTML-блок, Webflow code components) с выдачей кода для вставки.

Порядок: 1–3 сначала (их просил владелец и на них опираются остальные), затем 4, 5–7 (совместная работа), 8, 11; 10 — после ответа юриста.

### 4.3. Показ справа
- Вкладка **«Артефакты»** в инструментах справа (рядом с браузером и документами): список артефактов чата и проекта, открытие одного — с переключателем в шапке, «Открыть на всю страницу» (Base44), «Показать» поверх (Base44 Present, Bolt Present).
- Карточка в ленте при создании и правке («Агент изменил „Главная — варианты“: кадр 2, раздел цен») с кнопкой «Открыть» — как Base44 и Lovable; вкладка открывается сама один раз, как сейчас документы (план 59).
- В шапке открытого артефакта — **кто сейчас правит**: люди и чаты-агенты (Webflow Presence: имя запустившего, у нас — «Агент в чате „…“»), и индикатор на кадре, который агент правит (Figma).
- Телефон: на всю ширину поверх чата, просмотр, комментарии, «Попросить агента»; прямая правка — только текста; холст — список кадров с миниатюрами и Focus (как Replit и v0 прячут инструменты на телефоне).

### 4.4. Привязка к проекту и к пользователю
- Поле `project_id` пустое — артефакт пользователя (личная библиотека, как Lovable «Your files» и Base44 Artifacts); заполненное — артефакт проекта, его видят чаты проекта как контекст (`/workspace/project` уже есть для файлов). «Перенести в проект…» и «Сделать личным» — как перенос чата (`task.moveToProject`).
- Раздел **«Артефакты»** в кабинете: «Мои», «Проекты», «Поделились со мной», поиск, вид списком и плиткой, корзина 30 дней (как страницы плана 73).
- Подключить артефакт к чату: `@` в поле (Lovable `@`, IM-25), «Попросить агента» из артефакта открывает чат с прикреплённым артефактом, агент правит тот же объект, а не делает новый (Base44 «Update with agent»).

### 4.5. Шеринг по ссылке
- **Пригласить по ссылке** с ролью: «Смотреть», «Комментировать», «Править». Ссылка требует входа в Радити, после входа артефакт попадает в «Поделились со мной». Срок 7 дней, одна активная ссылка на роль, смена роли выпускает новую, отзыв мгновенный (Lovable). Кроме ссылки — приглашение по почте и список доступа со сменой роли и удалением.
- Пароль как замена входа — не делать (Lovable прямо пишет, что пароль не идентифицирует); анонимный просмотр — через публикацию страницы.
- «Запросить доступ» для того, кто открыл ссылку без прав (v0, Gamma, Bolt).
- Владелец может «Дублировать» чужой артефакт в свою библиотеку, если ему дали «Смотреть» (v0 Duplicate, SF-143 «ремикс»).
- Делится и отзывает только человек: инструмента `share` у агента нет (правило 4: опасное — через подтверждение клиента).

### 4.6. Инструменты MCP для артефактов
Семейство `artifact` (в стиле `doc_*` и `page_*`, все записи — с базовой версией):
- `artifact_list` (свои, проекта, поделившиеся; фильтр по виду), `artifact_read` (артефакт или его часть: раздел, кадр, диапазон; возвращает `revision`, ссылки «открыть», кто правит сейчас), `artifact_create` (вид, название, проект или личный, начальное содержимое; ответ — карточка и ссылка, как «design edit handoff» Canva).
- Правка текста: `artifact_section_write` (раздел целиком или после id, как `doc_section_write`), `artifact_edit` (операции `old`/`new`, каждая `old` ровно один раз, `base_revision`; при чужой правке — отказ со свежим текстом затронутого места, как `page_edit` и Canva commit).
- Холст: `artifact_frame_create` (самодостаточный HTML, размер 390 × 844 / 768 × 1024 / 1280 × 720 или «все три», место рядом с кадром), `artifact_frame_edit` (операции `old`/`new` по HTML кадра с `base_revision`), `artifact_frame_variant` (копия кадра с изменением — новый кадр рядом, исходный не трогать), `artifact_frame_remove`; стикеры — `artifact_note_add` / `artifact_note_status`.
- Комментарии: `artifact_comments` (открытые треды с местом и скриншотом), `artifact_comment_reply`, `artifact_comment_resolve` (только когда попросил человек — как у Notion). Ответ агента на комментарий — в треде, а не новым объектом на холсте (tldraw).
- Предложения: `artifact_suggest` — предложить правку чужого текста (раздела, который правил человек) на одобрение вместо прямой правки (Notion suggested edits: не перекрываются, устаревают при правке).
- Версии: `artifact_versions` (кто и что менял — человек, чат, агент; как Notion version changes), `artifact_restore` в два шага: сначала показать, что откатится, затем с подтверждением клиента (Notion `user_confirmed`).
- Экспорт и публикация: `artifact_export` (PDF, PNG кадра, CSV таблицы, `.md`, `.html`), `artifact_publish_page` — только предложение карточкой, публикует нажатие клиента.
- Удаление — в корзину с подтверждением клиента (`confirmedByClient`, как `page_delete`), не больше N за ход.
- Пределы: размер ответа (Figma — 48 000 байт; нам — чтение частями), число записей за ход, проверка секретов в содержимом (как `secretInContent` у файлов проекта).

### 4.7. Совместная работа человека и нескольких агентов
- **Ревизии и проверка базы**: у артефакта — счётчик ревизий; каждая запись (человека из редактора и агента из любого чата) идёт с `base_revision`. Совпала — запись; не совпала, но затронутые части не пересекаются (другой раздел, другой кадр) — запись без вопросов; пересекаются — отказ агенту со свежим содержимым места (Canva: перечитать и повторить). Ручная правка человека не может быть тихо перезаписана ИИ (жалоба Gamma).
- **Гранулярность**: текст — по разделам (уже есть у `doc_*`), холст — по кадрам и стикерам, таблица — по строкам и ячейкам; тогда два агента в разных чатах правят разные части без конфликтов.
- **Живой показ**: правки агента видны через мгновение (как разделы плана 74), с подсветкой изменённого и строкой «изменил агент в чате „…“».
- **Кто правит сейчас**: список участников в шапке (люди и чаты), рамка у правимого кадра или раздела; блокировок нет, но агент, начавший правку кадра, держит короткую аренду кадра на время хода — второй агент получает «кадр правит другой чат», а не конфликт в конце.
- **Изоляция для больших переделок**: «Черновик артефакта» (Lovable drafts, ветки Framer и Base44) — копия, где агент делает редизайн, затем «Принять» с однострочной сводкой и диффом; не обязательно в первой версии.
- **Атрибуция**: в истории каждая ревизия подписана: человек, чат, проход; восстановление любой версии.
- **Деньги** (правило 7): ход агента списывает кредиты пространства чата, из которого пришёл запрос (Bolt: «tokens from the prompter's account»); прямая правка человеком, комментарии и пачка визуальных правок без ИИ — бесплатно (Bolt, Replit, Lovable).

### 4.8. Холст дизайна для сайтов клиента
- Доска с кадрами: кадр — самодостаточная HTML-страница (тот же формат, что и страница), заголовок кадра, размер (телефон, планшет, компьютер) или «все три рядом» (Webflow, Base44).
- Панель действий выбранного кадра: «Открыть» (Focus), «Вариант» (новый кадр рядом), «Мобильная версия», «Комментировать», «PNG», «Опубликовать как страницу», «В чат» (прикрепить снимок к сообщению — Replit).
- Предложения рядом с выбранным кадром — 3–4 чипа: «Другой стиль», «Добавить раздел цен», «Версия для телефона», «Строже/ярче» (Replit «Ambient intelligence»); клик — ход агента, новый кадр рядом.
- Внутри кадра: выбор элемента (наведение, ↑/↓, Cmd+клик) → чип в поле чата; двойной клик — правка текста без ИИ; маленькая панель — цвет, размер шрифта, отступы — пачкой с «Применить» и без кредитов (детерминированная правка HTML).
- Пометки: рисовать поверх кадра, стикеры со статусом и стрелкой к кадру, «Отправить агенту» (Base44, Lovable).
- Комментарии: пин на элементе со скриншотом, номер треда, `@агент`, «Решено», признак потерянного якоря; агент читает и отвечает в треде.
- Мост: «Опубликовать как страницу» (выбранный кадр → страница сайта плана 73) и «Сделать сайт из кадров» (несколько кадров → дерево страниц).

### 4.9. Безопасность показа
- Кадры и HTML-артефакты показывать во фрейме с корня домена страниц, как сейчас документы и страницы (`PAGES_BASE_DOMAIN`, CSP `sandbox` без `allow-same-origin`, `connect-src 'none'`): чужой артефакт, которым поделились, не должен исполняться в источнике кабинета.
- Интерактив с данными (форма, Kanban, таблица в HTML) — позже, только через узкий мост сообщений к API артефакта, без сети страницы (то, что у Claude называют хранилищем артефакта, OR-119).
- Миниатюры неактивных кадров — картинкой, живой фрейм — только у выбранного или в Focus (иначе телефон не потянет десятки фреймов).

---

## 5. Чего избегать

1. **Тихий откат ручных правок ИИ-правкой.** Пользователь Gamma: «it somehow undid a whole bunch of my own manual edits on multiple other unrelated cards» ([ideas.gamma.app](https://ideas.gamma.app/ideas/p/gamma-ai-clobbered-my-edits)). Лекарство — правка частями с проверкой ревизии (4.7).
2. **Ссылка «правит кто угодно» без входа** (Canva «Anyone with the link… Can edit», по одной из страниц справки — без входа в десктопном браузере; вторичная сводка).
3. **Бессрочные ссылки-приглашения**; Lovable даёт 7 дней и одну активную ссылку.
4. **Пароль как замена личности** — Lovable: «does not identify who opened the link».
5. **Права агента шире прав человека** — Custom Agents Notion «may reveal information a user cannot see directly». У нас агент чата действует правами автора чата.
6. **Удаление обсуждений при слиянии** — Base44 удаляет комментарии ветки при слиянии или удалении.
7. **«Последняя правка побеждает» для агентов** — Webflow Presence не блокирует; для людей допустимо, для ИИ — только с проверкой ревизии.
8. **Разные возможности у рабочего и опубликованного без объяснения**: у Gamma пароль только для документов, сайты нельзя встраивать; у Figma пароль только на опубликованном, предпросмотр не защищён.
9. **Кредиты за детерминированную правку** — у Figma Make панель свойств тратит AI-кредиты при Apply, у Bolt и Replit такая правка бесплатна.
10. **Запертое содержимое** — Canva Code: «can't be exported as a file»; у нас всегда скачивание `.html`, `.md`, CSV.
11. **Индексация и публичные галереи по умолчанию** — v0 «Anyone on the web… may be indexed»; у нас страницы и артефакты — noindex, пока клиент не включит.
12. **Анонимные объекты агента на холсте**, которые копятся (вывод tldraw) — ответы агента — в комментариях и истории.
13. **Гостевые комментарии без входа** (Lovable) — у нас риск данных третьих лиц и спама; не делать для артефактов.
14. **Один общий тред и очередь для всей команды** (Bolt) — просто, но медленно; у нас у каждого свой чат, а конфликт решают ревизии.
15. **Обещать мобильную правку, которой нет**: у Wix Aria — только десктоп-вид; лучше честно: «на телефоне — просмотр и комментарии».

---

## 6. Риски для Радити

- **Правило 1.** Артефакт, комментарии приглашённых и их правки уходят модели при чтении агентом — как любой контент чата; гейт 152-ФЗ и класс данных пространства действуют и для чужих артефактов: агент читает артефакт другого пространства под ключом своего хода — нужно решить, чей класс данных проверять (владельца артефакта или чата) и показывать приглашённому предупреждение.
- **Правило 2.** Секреты в артефактах (ключи в HTML кадра, пароли в таблице) — проверка содержимого при записи, как для файлов проекта и страниц.
- **Правило 3/4.** Публикация, приглашение, удаление, восстановление версии — только нажатием клиента; агент — предложение карточкой.
- **Правило 7.** Несколько агентов в цикле правок друг за другом сжигают кредиты; нужен предел записей за ход и понятная строка «кто сколько потратил».
- **Безопасность показа.** HTML от другого пользователя — фишинг и XSS; только изолированный источник и CSP, как у страниц; жалоба и снятие — как `pages:take-down`.
- **Сложность конкурентной правки.** CRDT (Yjs) для текста — дорого; ревизии с гранулярностью по частям покрывают большинство случаев; вернуться к CRDT, если люди будут массово править один раздел одновременно.
- **Квоты хранилища.** Кадры, картинки, версии — нужны пределы на артефакт и пространство (как 5 МиБ / 50 МиБ у сайтов страниц).
- **Телефон.** Десятки живых фреймов на холсте — миниатюры вместо фреймов.

---

## 7. Что не подтверждено и не изучено

- v0: нативные варианты A/B, присутствие соавторов на холсте, изоляция домена предпросмотра — не подтверждено.
- Lovable: живые курсоры соавторов — не подтверждено; домен предпросмотра — не изучал.
- Bolt: внешний MCP-сервер — не нашёл.
- Figma: видимость чатов агента в Design с 23.06.2026 — только в сводке поиска; присутствие агента кроме индикатора — не подтверждено.
- Canva: присутствие ИИ на холсте, «object-based editing» Canva AI 2.0 — только вторичные; адрес MCP `mcp.canva.com/mcp` — из сторонних каталогов.
- Gamma: совместная правка в реальном времени и роли — частично вторичные.
- Webflow: текст справки Real-time collaboration не загрузился (проверка браузера), детали — по сторонней статье и сводке поиска.
- tldraw Fairies — только доклады и пересказы.
- Miro: инструменты MCP поимённо, комментарии к агентам, присутствие — не подтверждено.
- Notion: публикация Notion Sites, правка комментариев агентом в будущем — не изучал.
- Coda — не изучал; Airtable — только две статьи справки.
- Цены продуктов почти нигде не изучал, кроме лимитов, названных в справке.

---

## 8. Источники по продуктам

- **v0:** https://v0.app/docs/design-mode (18.11.2026) · https://v0.app/changelog (записи 08.06–16.10.2026) · https://v0.app/docs/sharing · https://v0.app/docs/api/v2/guides/integrating-v0-into-agents · https://v0.app/docs/security · https://claude.com/connectors/v0
- **Lovable:** https://docs.lovable.dev/features/preview-toolbar.md · https://docs.lovable.dev/features/project-comments.md · https://docs.lovable.dev/features/share-project.md · https://docs.lovable.dev/features/projects/history.md · https://docs.lovable.dev/features/drafts.md · https://docs.lovable.dev/integrations/lovable-mcp-server.md · https://docs.lovable.dev/features/chats.md · https://docs.lovable.dev/features/generate-files.md · https://docs.lovable.dev/features/projects/chat.md
- **Bolt:** https://support.bolt.new/building/visual-edits.md · https://support.bolt.new/collaboration/comments.md · https://support.bolt.new/collaboration/collaborate.md · https://support.bolt.new/collaboration/sharing.md · https://support.bolt.new/use-cases/slides.md
- **Replit:** https://docs.replit.com/design/what-is-replit-design.md · https://docs.replit.com/design/core-components.md · https://docs.replit.com/design/canvas.md · https://docs.replit.com/design/frames.md · https://docs.replit.com/design/elements.md · https://docs.replit.com/design/toolbar.md · https://docs.replit.com/design/explore-suggestions.md · https://docs.replit.com/design/explore-with-different-models.md · https://docs.replit.com/learn/projects-and-artifacts/projects-and-artifacts.md · https://docs.replit.com/build/invite-teammates.md · https://docs.replit.com/core-concepts/project-editor/app-setup/development-urls.md · https://docs.replit.com/design/import-claude-designs-into-replit-design.md
- **Figma:** https://help.figma.com/hc/en-us/articles/31304412302231-Explore-Figma-Make · https://help.figma.com/hc/en-us/articles/42009840449175 · https://www.figma.com/blog/properties-panel-and-annotations-now-in-figma-make/ (30.07.2026) · https://help.figma.com/hc/en-us/articles/38701587731735-Add-comments-in-Figma-Make · https://help.figma.com/hc/en-us/articles/37998629035799 · https://help.figma.com/hc/en-us/articles/31304586129559 · https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/ · https://developers.figma.com/docs/figma-mcp-server/write-to-canvas · https://developers.figma.com/docs/figma-mcp-server/code-to-canvas/ · https://developers.figma.com/docs/figma-mcp-server/bringing-make-context-to-your-agent/ · https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/
- **Canva:** https://www.canva.com/help/canva-code/ · https://www.canva.com/newsroom/news/canva-code/ · https://venturebeat.com/ai/canva-launches-code-2-0-offering-ai-website-building-to-every-user-including-free-accounts/ (вторичный) · https://www.canva.com/help/collaborate-with-anyone/ · https://www.canva.dev/docs/apps/llms.txt · https://www.canva.dev/docs/apps/mcp.md · https://www.canva.dev/docs/apps/mcp/access.md · https://www.canva.dev/docs/apps/mcp/best-practices.md · https://www.canva.dev/docs/apps/mcp/workflows/design-edit.md · https://www.canva.dev/docs/apps/mcp/tools.md · https://www.canva.dev/docs/apps/mcp/tools/start-editing-transaction.md · https://www.canva.dev/docs/apps/mcp/tools/perform-editing-operations.md · https://www.canva.dev/docs/apps/mcp/tools/commit-editing-transaction.md · https://www.canva.dev/docs/apps/mcp/tools/generate-design.md · https://siliconangle.com/2026/04/16/canva-unveils-canva-ai-2-0-recasting-platform-agentic-system-work/ (вторичный)
- **Gamma:** https://help.gamma.app/en/articles/15002203-how-do-i-create-with-agent-in-gamma · https://help.gamma.app/en/articles/8033284-how-do-i-edit-my-content-with-ai · https://help.gamma.app/en/articles/11047226-how-do-collaboration-and-sharing-settings-work-in-gamma · https://help.gamma.app/en/articles/8429268-how-do-i-create-publish-a-site-in-gamma · https://help.gamma.app/en/articles/11047806-can-i-embed-gamma-into-another-site · https://help.gamma.app/en/articles/12601672-what-is-remix-and-how-do-i-use-it · https://help.gamma.app/en/articles/11962420-does-gamma-have-an-api · https://help.gamma.app/en/articles/13943863-how-do-i-use-gamma-with-outbound-connectors-and-integrations · https://help.gamma.app/en/articles/11048579-can-i-undo-a-change-or-restore-a-previous-version-in-gamma · https://ideas.gamma.app/ideas/p/gamma-ai-clobbered-my-edits
- **Framer:** https://www.framer.com/help/articles/how-to-use-agents/ · https://www.framer.com/help/articles/what-you-can-do-with-framer-mcp/ · https://www.framer.com/help/articles/how-to-use-branches-in-framer/ · https://www.framer.com/updates · https://www.framer.com/help/articles/inviting-members-to-a-workspace-or-project/
- **Webflow:** https://developers.webflow.com/data/docs/ai-tools.md · https://help.webflow.com/hc/en-us/articles/43232037920275 (через сводку поиска) · https://www.appsrow.com/blog/webflow-agent-presence-how-ai-agents-collaborate-on-the-canvas (вторичный)
- **Wix:** https://support.wix.com/en/article/wix-harmony-editor-working-with-aria (13.08.2026)
- **Base44:** https://docs.base44.com/superagents/artifacts.md · https://docs.base44.com/Building-your-app/Canvas.md · https://docs.base44.com/Building-your-app/Commenting-on-your-app.md · https://docs.base44.com/Building-your-app/working-with-branches.md · https://docs.base44.com/developers/backend/overview/mcp-server.md
- **tldraw:** https://tldraw.dev/starter-kits/agent · https://tldraw.dev/docs/ai (31.01.2026) · https://tldraw.dev/blog/agents-cant-point (11.08.2026) · https://ai.engineer/talks/agents-on-the-canvas-in-tldraw (вторичный) · https://ccm-design-engineer.netlify.app/summaries/fairies-ai-agents-as-canvas-collaborators-summary (вторичный)
- **Excalidraw+:** https://plus.excalidraw.com/
- **Miro:** https://miro.com/blog/canvas-26-product-highlights/ (19.05.2026) · https://miro.com/blog/miro-mcp-server/ (07.10.2026) · https://miro.com/blog/whats-new-february-2026/
- **Notion:** https://www.notion.com/help/notion-agent · https://www.notion.com/en-gb/help/custom-agents-sharing-and-permissions · https://developers.notion.com/guides/mcp/tools-comments-reference.md · https://developers.notion.com/guides/mcp/tools-pages-reference.md · https://developers.notion.com/guides/mcp/rate-limits.md · https://matthiasfrank.de/en/notion-custom-agents/ (вторичный, даты)
- **Airtable:** https://support.airtable.com/docs/using-omni-ai-in-airtable · https://support.airtable.com/docs/ai-generated-interface-elements-in-airtable
- **Claude Design (для сравнения, из репозитория):** https://support.claude.com/en/articles/14604416-get-started-with-claude-design
