# Чат Радити: что уже есть

Перечень собран 14.11.2026 по коду и планам на `main` (`ce947861`). Он — основа колонки «Радити» в [features.md](features.md).

Чат Радити — веб-чат в кабинете (/chats), где клиент пишет агенту по-русски одной строкой ввода. Рядом с полем стоят палитра из 19 команд «/», скрепка (до 10 файлов по 20 МиБ, вставка из буфера), выбор проекта и уровень размышления. Проходы агента идут на сервере в песочнице gVisor на одной модели GLM-5.3 (OpenCode). Пока агент работает, поле закрыто и вместо «Отправить» стоит «Остановить»; ход управляется командами /undo, /redo, /retry, «Продолжить», «Взять управление» браузером. На выходе: Markdown-ответ, живой «Ход работы» (команды IN/OUT, инструменты, файлы, мысли, черновик ответа), карточки итога и сбоя, панель «Инструменты» справа. В панели — предпросмотр, диффы, «База данных», «Проверки», «Изменения», облачный браузер с трансляцией и перехватом управления, «Документы». Результат уходит наружу выпуском /release с бэкапом и откатом, правкой живого сайта через браузер или публикацией страниц агента. Учёт — кредиты и недельные лимиты. Каналов, кроме веба, нет: нет Telegram, голоса, уведомлений и ветвления.

## Набор запроса

- ✅ **Многострочное поле ввода** — Поле растёт с текстом до 30–40 % высоты окна, Enter отправляет, Shift+Enter переносит строку, Enter метода ввода (IME) не отправляет. (`apps/web/src/components/chat/composer.tsx`)
- ✅ **Предел длины сообщения** — Сообщение длиннее 4000 знаков не отправляется, под полем — предупреждение «сократите его до 4000 знаков». (`packages/domain/src/tasks/client-feed-text.ts (FEED_REQUEST_TEXT_LIMIT)`)
- ✅ **Защита от паролей в сообщении** — Сервер отклоняет сообщение, похожее на пароль или ключ (TASK_TEXT_HAS_SECRET), текст остаётся в поле, а под полем для экранного чтеца — напоминание не отправлять пароли. (`packages/domain/src/tasks/client-feed-text.ts (looksLikeSecret); packages/trpc/src/services/chat/refusals.ts`)
- ✅ **Черновик нового чата** — Слова нового чата сохраняются в sessionStorage вкладки, пока клиент уходит добавлять проект, и возвращаются только этому пользователю. (`apps/web/src/components/chat/chat-draft.ts`)
- ✅ **Текст не теряется до приёма сервером** — Поле очищается только после ответа сервера, а id запроса придумывает браузер, поэтому повтор после потерянного ответа находит тот же чат. (`apps/web/src/components/chat/composer.tsx; apps/web/src/components/chat/new-chat.tsx`)
- ✅ **Возврат слов отменённого запроса** — После /undo слова последнего запроса возвращаются в поле, и их можно поправить и отправить заново — замена правке отправленного сообщения. (`apps/web/src/components/chat/dialog-view.tsx (undoneWords)`)
- ✅ **Приветствие нового чата** — Новый чат открывается приветствием по времени суток с именем клиента или одной из фраз агента. (`apps/web/src/components/chat/chat-greeting.ts; docs/plan/66-chat-visuals.md (В2, В13)`)
- ✅ **Ответ агенту словами** — Когда агент спросил, поле меняет подсказку и кнопку на «Ответить», и слова уходят ответом на вопрос, на вопрос о кредитах или после сбоя. (`apps/web/src/components/chat/dialog-view.tsx (answering)`)
- ✅ **Уточнение к готовым изменениям** — Слова чату, который ждёт с изменениями, запускают новый проход поверх кандидата (запрос вида revision). (`packages/domain/src/tasks/client-feed.ts (kind: 'revision')`)
- ✅ **Название чата из первого запроса** — Название чата сервер берёт из первой читаемой строки первого запроса. (`packages/trpc/src/services/chat/request-text.ts`)

## Вложения

- ✅ **Загрузка файлов скрепкой** — «Прикрепить файлы» → «Загрузить файл» открывает системный выбор: до 10 файлов на сообщение, до 20 МиБ каждый. (`apps/web/src/components/chat/composer.tsx; packages/domain/src/attachments/rules.ts`)
- ✅ **Типы вложений и проверка содержимого** — Принимаются JPEG, PNG, WebP, GIF, PDF, DOCX, XLSX, PPTX, ODT, ODS, TXT и CSV; тип проверяется по расширению и первым байтам, текст — на UTF-8. (`packages/domain/src/attachments/rules.ts (attachmentTypes, attachmentRefusals)`)
- ✅ **Вставка файлов и скриншотов из буфера** — Скриншот, картинка со страницы или файлы из файлового менеджера по ⌘V/Ctrl+V прикрепляются как выбранные, а копия из документа остаётся текстом. (`apps/web/src/components/chat/composer.tsx (pastedFiles)`)
- ✅ **Вложения до отправки** — У каждого файла видны прогресс загрузки в процентах и кнопки «Повторить», «Убрать», «Отменить загрузку»; фото открывается по нажатию на миниатюру, а отправка ждёт загрузки. (`apps/web/src/components/chat/attachment-chips.tsx; apps/web/src/components/chat/chat-texts.ts (attachmentText)`)
- ✅ **Файлы закрепляют проект** — Пока к сообщению прикреплены файлы, проект чата не сменить: файл привязан к сайту. (`apps/web/src/components/chat/chat-texts.ts (chatsText.lockedProject)`)
- ✅ **Файлы клиента у агента** — Агент получает файлы в /workspace/inbox: может читать их, скопировать в медиа сайта или загрузить на сайт через браузер. (`apps/core/src/tasks/turn-instructions.ts (inboxSection)`)
- 🟡 **Картинки модели** — Драйвер не передаёт модели изображения: агент знает о картинке только имя и слова клиента. (`apps/core/src/tasks/turn-instructions.ts (UNSEEN_IMAGES)`)
- ✅ **Файл на сайт из браузера** — Когда страница сайта просит файл, клиент или агент (web_upload) выбирает его из вложений задачи или загружает новый. (`apps/web/src/components/chat/chat-texts.ts (browserText.chooser); apps/mcp/src/web/mcp-web.controller.ts (web_upload)`)

## Упоминания и выбор контекста

- ✅ **Выбор проекта у поля** — Пилюля у поля выбирает проект нового чата или «Без проекта» (по умолчанию), а от проекта зависит, что умеет агент: код с предпросмотром, браузер на сайте или любой публичный сайт. (`apps/web/src/components/chat/project-picker.tsx; docs/plan/61-chats-first.md (К6–К8)`)
- ✅ **Чат с проектом по ссылке** — Адрес /chats/new?project=<id> открывает новый чат с выбранным проектом, а чужой или закрытый проект становится «Без проекта». (`apps/web/src/components/chat/new-chat.tsx`)

## Команды

- ✅ **Палитра команд «/»** — «/» в начале поля или кнопка открывают список из 19 команд; навигация стрелками, Enter, Escape, фильтр по набранному. (`packages/domain/src/release/chat-commands.ts; apps/web/src/components/chat/command-palette.tsx`)
- ✅ **Группы команд по виду чата** — Команды разбиты на группы «Сайт», «Агент» и «Чат»; команды сайта в чате без репозитория не показываются. (`packages/domain/src/release/chat-commands.ts (chatCommandGroupLabel, needs)`)
- ✅ **Доступность команд решает сервер** — Сервер даёт вердикт по каждой команде (task.commands), и недоступная команда говорит причину словами клиенту. (`packages/domain/src/release/chat-commands.ts (chatCommandAvailability, chatCommandRefusalText)`)
- ✅ **Псевдонимы команд как в OpenCode** — Принимаются /clear, /resume, /continue, /summarize и /mo вместо основных команд. (`packages/domain/src/release/chat-commands.ts (aliases)`)
- ✅ **Команда никогда не уходит агенту** — Текст, который целиком — команда, выполняется и не отправляется ни агенту, ни сообщением. (`apps/web/src/components/chat/composer.tsx (parseChatCommand в send)`)
- ✅ **/help — справка** — /help открывает весь список команд с описаниями. (`apps/web/src/components/chat/composer.tsx (choose, id === 'help')`)
- ✅ **Меню «+» «Инструменты»** — «+» в шапке чата открывает меню инструментов (браузер, предпросмотр, файлы, база, проверки, изменения, документы) с отметками состояния; на узком экране — лист снизу. (`apps/web/src/components/chat/tools-menu.tsx; apps/web/src/components/chat/dialog-tools.ts`)
- ✅ **Горячая клавиша «]»** — «]» скрывает и показывает панель кабинета со списком чатов; край панели тянется мышью и клавишами. (`apps/web/src/components/application/cabinet-panel.tsx; docs/plan/64-cabinet-navigation.md`)

## Управление ходом

- ✅ **«Остановить»** — Пока агент работает, вместо «Отправить» стоит «Остановить», которое делает то же, что /cancel. (`apps/web/src/components/chat/composer.tsx (stop); apps/web/src/components/chat/dialog-view.tsx`)
- ✅ **/cancel — отменить чат** — Команда с подтверждением завершает чат и останавливает агента; лента говорит, что осталось на сайте. (`packages/domain/src/release/chat-commands.ts (cancel); packages/trpc/src/routers/task.ts (cancel)`)
- ✅ **«Попробовать ещё» (/retry)** — Повтор прохода, на котором работа оборвалась: в классе heavy, с новым резервом, кандидат и предпросмотр сохраняются; кнопка есть и на карточке сбоя. (`packages/trpc/src/routers/task.ts (retry); docs/plan/53-chat-preview-release.md («Попробовать ещё»)`)
- ✅ **Чат не закрывается после сбоя** — После сбоя чат остаётся открытым, и слово «продолжи» начинает следующий проход с новым резервом. (`apps/web/src/components/chat/feed-list.tsx (feedFailureOpenText); CLAUDE.md, «Чат, предпросмотр и /release»`)
- ✅ **/undo — отменить последний запрос** — Последний запрос забывается, а файлы рабочей копии возвращаются; сделанное через браузер на сайте остаётся, кредиты не возвращаются. (`packages/domain/src/release/chat-commands.ts (turn_undo); apps/core/src/tasks/candidate-rewind.ts`)
- ✅ **/redo — вернуть отменённый запрос** — Снова применяет запрос и файлы, которые сняла /undo, пока чат с тех пор не сдвинулся. (`packages/domain/src/release/chat-commands.ts (turn_redo); packages/trpc/src/routers/task.ts (redoTurn)`)
- ✅ **«Продолжить» на вопрос о кредитах** — Когда платформа останавливается на шаге или кредитах, карточка предлагает «Продолжить» с новым резервом или путь к покупке кредитов. (`apps/web/src/components/chat/feed-list.tsx (ceilingButtons); packages/domain/src/tasks/client-feed.ts (feedCeilingReasons)`)
- 🟡 **Вопросы агента с вариантами** — Агент может задать несколько вопросов с вариантами, но варианты показываются списком, а не кнопками: клиент отвечает словами. (`apps/web/src/components/chat/feed-list.tsx (карточка feed.question); packages/domain/src/tasks/client-feed.ts`)

## Настройки запроса

- ✅ **Уровень размышления** — Кнопка «Размышление» выбирает «Низкое», «Высокое» или «Максимальное» (low/high/max одной модели); в идущем чате уровень меняется, пока чат ждёт, и действует со следующего шага. (`apps/web/src/components/chat/effort-menu.tsx; packages/trpc/src/routers/task.ts (setEffort)`)
- ✅ **Запоминание уровня размышления** — Последний выбранный уровень хранится в localStorage браузера и становится уровнем следующего нового чата. (`apps/web/src/components/chat/chat-effort.ts`)
- 🟡 **/models** — Команда обещает показать модель и уровень, но открывает только меню уровня: название модели в нём не показывается. (`apps/web/src/components/chat/effort-menu.tsx; packages/domain/src/release/chat-commands.ts (models)`)
- ✅ **/themes — оформление** — Светлая, тёмная тема или как в системе — меню над полем. (`apps/web/src/components/chat/client-commands.tsx (ThemeMenu)`)

## Каналы

- ✅ **Веб-кабинет** — Чаты — первый раздел кабинета: /chats, /chats/new и /chats/{taskId}; другого входа для задач нет. (`apps/web/src/app/(protected)/chats; docs/plan/61-chats-first.md`)
- ✅ **Телефон и планшет** — Ниже lg открытый инструмент занимает место чата с кнопкой «К чату», меню инструментов выезжает снизу, черновик и место чтения сохраняются. (`docs/plan/59-dialog-tools-panel.md (И14, И19); apps/web/src/components/chat/tools-panel.tsx`)

## Ответ

- ✅ **Markdown в ответе** — Ответ агента рисуется как GFM (абзацы, списки, код, таблицы с прокруткой, ссылки); сырой HTML отбрасывается, картинки заменяются подписью. (`apps/web/src/components/chat/agent-markdown.tsx`)
- ✅ **Безопасные ссылки** — Ссылкой остаются только адреса http(s) и mailto; они открываются в новой вкладке и называют хост, если слова ссылки его скрывают. (`apps/web/src/components/chat/agent-markdown.tsx (linkUrl, hiddenHost)`)
- ✅ **Переносы строк и деревья папок** — Переносы строк агента сохраняются, а текстовое дерево папок (├──) само становится блоком кода. (`apps/web/src/components/chat/agent-markdown.tsx (remarkSoftBreaks, fenceTextTrees)`)
- ✅ **Ответ по мере написания** — Живой ход показывает текст, который агент пишет сейчас («Агент пишет ответ…»), черновиком из журнала, а лента обновляется опросом сервера. (`apps/web/src/components/chat/turn-activity.tsx (draft); apps/web/src/components/chat/feed-state.ts (pollDelay)`)
- ✅ **Карточка итога хода** — Итог показывает сообщение агента, что стало с сайтом, число изменённых файлов и куда перешёл чат. (`packages/domain/src/tasks/client-feed.ts (feed.result); apps/web/src/components/chat/feed-list.tsx`)
- ✅ **Объекты сайта в итоге** — Работа в браузере называет записи и страницы сайта с их состоянием, прочитанным на сайте, и ссылками «Открыть запись» и «Изменить в админке». (`apps/web/src/components/chat/chat-texts.ts (objectLinkText); docs/plan/57-browser-tasks.md (Б23, Б24)`)
- ✅ **Карточки сбоя и отмены** — Сбой и отмена объясняются словами каталога: что осталось на сайте, вернулись ли кредиты и что делать дальше. (`apps/web/src/components/chat/feed-list.tsx (feed.failure, feed.cancelled); packages/domain/src/tasks/client-feed-labels.ts`)

## Мысли

- ✅ **Живые размышления** — Пока ход идёт, мысли модели видны строкой «Агент размышляет…», которая следует за новыми словами и по нажатию раскрывается до трёх строк. (`apps/web/src/components/chat/turn-activity.tsx (Thought)`)
- ✅ **/thinking — мысли законченных ходов** — Команда показывает и скрывает сырые (часто английские) размышления агента в законченных ходах. (`apps/web/src/components/chat/client-commands.tsx; docs/plan/61-chats-first.md (К32)`)

## Работа агента на виду

- ✅ **«Ход работы» в ленте** — Всё, что агент написал, запустил и изменил, идёт в ленте по порядку, а законченный ход сворачивается в блок под «Агент работал …». (`apps/web/src/components/chat/turn-activity.tsx`)
- ✅ **Команды IN/OUT** — Каждая команда агента видна с кодом выхода и первыми тремя строками вывода; полный вывод (начало и конец длинного) открывается в окне. (`apps/web/src/components/chat/command-block.tsx`)
- ✅ **Вызовы инструментов** — Строка с именем инструмента и исходом «выполнен» или «ошибка». (`apps/web/src/components/chat/turn-activity.tsx (tool_call)`)
- ✅ **Изменения файлов в ходе** — «Добавлен», «Изменён» и «Удалён файл» с путём в моноширинном шрифте. (`apps/web/src/components/chat/turn-activity.tsx (file_change)`)
- ✅ **Этапы работы** — Строки этапов «Загружаем код проекта», «Работа над задачей», «Сохранение работы», «Работа с содержимым сайта», «Правки в файлах сайта». (`packages/domain/src/tasks/client-feed.ts (feedSteps); packages/domain/src/tasks/client-feed-labels.ts`)
- ✅ **Статусы чата и очередь** — Шапка называет состояние («Подготовка агента», «Нужен ваш ответ», «Ждёт вашего решения»), а ожидание в очереди — с причиной: заняты мощности агента или на сайте идёт другая работа. (`packages/domain/src/tasks/client-feed-labels.ts (feedWaitingText, feedQueuedText)`)
- ✅ **Длительность хода** — Законченный ход подписан «Агент работал N», а его подробности раскрываются. (`packages/domain/src/tasks/client-feed-labels.ts (feedDurationText)`)
- ✅ **/details — подробности работы** — Показывать или скрывать команды и инструменты агента в законченных ходах. (`apps/web/src/components/chat/client-commands.tsx; apps/web/src/components/chat/chat-details.ts`)
- ✅ **Анимированный знак работы** — Пока агент работает, знак Радити проигрывает свою траекторию (BrandProgress). (`docs/plan/66-chat-visuals.md (В5, В12); packages/ui (brand-progress)`)
- ✅ **Следование за лентой** — Чат открывается на последних словах и прокручивается за новыми, если клиент внизу, а место чтения выше конца сохраняется. (`apps/web/src/components/chat/use-feed-follow.ts`)

## Планы

- ✅ **Скелет документа сразу** — Длинный документ появляется у клиента сразу заголовком и намерением каждого раздела, а разделы заполняются по ходу работы. (`apps/mcp/src/pages/mcp-docs.controller.ts (doc_create); apps/web/src/components/chat/feed-doc.tsx`)

## Изменения

- ✅ **Карточка изменений** — Кандидат (коммит в ветку чата) показывается карточкой с кнопкой «Посмотреть изменения», которая открывает первый непустой инструмент изменений. (`apps/web/src/components/chat/dialog-view.tsx (onShowChanges); docs/plan/53-chat-preview-release.md`)
- ✅ **«Файлы» с диффами** — Список добавленных, изменённых и удалённых файлов и медиа с диффом каждого файла; код сайта показывается только текстом. (`apps/web/src/components/chat/candidate-panels.tsx (FilesPanel, FileDiff)`)
- ✅ **«База данных»** — Каждая операция плана БД со значениями: текст — разницей слов, настройка — «было → станет», новая страница — заголовком и адресом, таблица — колонками. (`apps/web/src/components/chat/database-panel.tsx`)
- ✅ **«Проверки»** — Декларативные проверки предпросмотра, которые запустил агент, с итогом и скриншотами страниц. (`apps/web/src/components/chat/candidate-panels.tsx (ChecksPanel); apps/mcp/src/browser/mcp-browser.controller.ts (browser_run_checks)`)
- ✅ **«Изменения»: файлы рабочей копии и правка** — Дерево файлов рабочей копии агента для просмотра; текстовый файл клиент правит сам, правка коммитится в ветку чата и попадает на сайт через /release. (`apps/web/src/components/site/site-files.tsx; apps/core/src/tasks/candidate-edit.ts`)
- ✅ **/update — обновить рабочую копию** — Переносит изменения чата на текущую версию сайта; конфликт и итог пишутся в ленту, а /release устаревших изменений сам запускает «Обновить». (`apps/core/src/tasks/candidate-rebase.ts; apps/web/src/components/chat/dialog-view.tsx (runCommand 'release')`)

## Артефакты

- ✅ **Файлы агента для клиента** — Файлы, которые агент положил в /workspace/out (до 30 за ход), приходят карточками с именем, размером и «Скачать». (`apps/web/src/components/chat/feed-file.tsx; packages/domain/src/tasks/chat-files.ts`)
- ✅ **Word и Excel по просьбе** — По умолчанию агент делает страницу или текстовый документ, а .docx и .xlsx — только когда клиент их назвал; в песочнице есть python-docx и openpyxl. (`packages/domain/src/tasks/chat-documents.ts (requestedFileFormats); docs/plan/66-chat-visuals.md (В11)`)
- ✅ **Вкладка «Документы»** — Страницы и тексты агента открываются справа как в браузере: список, «Назад» и «Вперёд», выбор версии, оглавление .md, «Обновить», «На весь экран», новая вкладка и «Скачать». (`apps/web/src/components/chat/documents-pane.tsx; docs/plan/67-agent-documents.md`)
- 🟡 **Страница .html во фрейме** — Страница агента показывается в изолированном фрейме с домена страниц (CSP sandbox без allow-same-origin); на сервере этот путь не проверен. (`docs/plan/67-agent-documents.md (§5, §6); apps/web/src/proxy.ts`)
- ✅ **Длинный документ по разделам** — Карточка документа в ленте показывает прогресс разделов и версию, кнопки «Открыть» и «Скачать .md». (`apps/web/src/components/chat/feed-doc.tsx; docs/plan/69-pages.md (69.8, 69.9)`)
- ✅ **Документ в своём окне** — Документ открывается отдельной страницей кабинета по своему адресу. (`apps/web/src/app/(protected)/chats/[taskId]/documents/[fileId]/page.tsx`)
- ✅ **Предпросмотр сайта** — Рабочая копия сайта с изменениями чата открывается во фрейме по одноразовому билету или в новой вкладке; без просмотра через 30 минут засыпает, по запросу собирается снова. (`apps/web/src/components/chat/preview-pane.tsx; apps/web/src/components/chat/preview-frame.tsx`)
- ✅ **/preview и /reset** — /preview открывает вкладку предпросмотра, /reset возвращает данные предпросмотра к последним изменениям агента и пересобирает сломанный. (`packages/domain/src/release/chat-commands.ts (preview, reset)`)
- 🟡 **«Опубликовать как страницу» из «Документов»** — Кнопка публикации документа есть в компоненте вкладки, но экран чата её не подключает: опубликовать может только агент. (`apps/web/src/components/chat/documents-pane.tsx (onPublish)`)

## Браузер и компьютер на виду

- ✅ **Живой вид облачного браузера** — Вкладка «Браузер» показывает Chromium задачи на canvas — кадры JPEG через шлюз трансляции по WebSocket. (`apps/web/src/components/chat/browser-pane.tsx; apps/web/src/components/chat/browser-stream.ts; docs/plan/57-browser-tasks.md (Б12–Б17)`)
- ✅ **«Взять управление» и «Продолжить работу агента»** — Клиент перехватывает браузер (агент ждёт и страницу не видит), а затем возвращает его агенту; управление держится по эпохе. (`packages/domain/src/tasks/client-feed-labels.ts (take, resume); packages/trpc/src/routers/task.ts (resumeAgent)`)
- ✅ **Ручное управление браузером** — Мышь, клавиатура, вставка текста, вкладки, строка адреса, «Обновить страницу», размер окна, во весь экран; выход к кнопкам — двойной Esc. (`apps/web/src/components/chat/browser-pane.tsx; apps/web/src/components/chat/browser-input.ts`)
- ✅ **Просьбы агента о помощи** — web_help просит клиента войти, пройти капчу, подтвердить или сделать другое — карточка в ленте и плашка в браузере. (`apps/mcp/src/web/mcp-web.controller.ts (web_help); apps/web/src/components/chat/chat-texts.ts (browserText.help)`)
- ✅ **Диалоги страницы** — Когда управляет клиент, он сам отвечает на alert, confirm, prompt и «Покинуть страницу?», а когда работает агент — агент (web_dialog). (`apps/web/src/components/chat/browser-page-dialogs.tsx`)
- ✅ **Состояние браузера** — Подписи «Работает агент», «Ждём вас», «Управляете вы», «Переподключение», «Закрыт: 30 минут без действий», «Только просмотр» и «Управление в другой вкладке». (`apps/web/src/components/chat/chat-texts.ts (browserText.status)`)
- ✅ **Скриншоты для клиента** — web_screenshot и browser_screenshot кладут снимок страницы в ленту с полноразмерной ссылкой; модель пикселей не видит. (`apps/web/src/components/chat/feed-screenshot.tsx; apps/mcp/src/web/mcp-web.controller.ts`)
- ✅ **Браузер по первому вызову** — Браузер запускается первым вызовом web_*, и панель чата один раз открывается сама; открытый чат держит браузер от простоя. (`docs/plan/61-chats-first.md (К11); docs/plan/59-dialog-tools-panel.md (§9); apps/web/src/components/chat/use-browser-watching.ts`)

## Уведомления

- ✅ **Точка на «+»** — Точка на кнопке инструментов говорит, что браузер ждёт клиента, появились изменения или пришёл документ. (`apps/web/src/components/chat/chat-texts.ts (toolText.dot)`)
- ✅ **Знаки в списке чатов** — У каждого чата — знак и слово статуса, ошибка — цветом сбоя; закрытая папка проекта помечена «Есть чаты, которые ждут вас». (`apps/web/src/components/chat/status-mark.tsx; apps/web/src/components/chat/dialog-list.tsx`)
- ✅ **Автооткрытие «Документов»** — Документ, пришедший при открытом чате, сам открывает вкладку от ширины lg, а ниже — карточка и точка на «+». (`apps/web/src/components/chat/use-document-arrivals.ts; docs/plan/67-agent-documents.md`)
- ✅ **Подсказка о лимите недели** — Под полем с 80 % недельного окна — сколько осталось и когда сброс. (`apps/web/src/components/billing/usage-window-hint.tsx; docs/plan/71-usage-limits.md (Л21)`)

## Сведения о работе

- ✅ **Кольцо кредитов** — Кольцо над аватаром на рейке показывает остаток кредитов и ведёт на «Использование». (`apps/web/src/components/billing/credit-ring.tsx`)
- ✅ **«Использование»** — Шкала кредитов периода, перенос остатка, история по задачам с суммами и счетами списания и блок «Лимиты» с окнами. (`apps/web/src/components/billing/usage-view.tsx; /settings/usage`)
- ✅ **Вопрос «Продолжить?» о кредитах** — Платформа останавливает работу на шаге, кредитах, подарке или попытках и называет потрачено, отложено и осталось. (`packages/domain/src/tasks/client-feed.ts (feed.question kind ceiling)`)
- ✅ **Строка исчерпанного лимита** — Проход, упёршийся в недельное окно, кончается строкой usage_limit с окном и временем сброса, а чат остаётся открытым. (`apps/web/src/components/chat/feed-list.tsx (usageLimitText); docs/plan/71-usage-limits.md`)
- ✅ **Источники ответа** — Инструкции требуют давать клиенту адреса источников поиска, а последний раздел документа — «Источники». (`apps/core/src/tasks/turn-instructions.ts (WEB_SEARCH, DOCUMENTS_AND_PAGES)`)

## Инструменты

- ✅ **Shell и файлы в песочнице** — Агент OpenCode читает, правит, ищет (glob, grep, list) и запускает bash в рабочей копии; todowrite разрешён. (`packages/agent-drivers/src/opencode.ts (permissionOf)`)
- ✅ **Интернет агента** — webfetch, а также curl, npm и composer из команд ходят через прокси песочницы к любому публичному сайту по HTTP и HTTPS; приватные адреса и платформа закрыты. (`apps/core/src/tasks/turn-instructions.ts (internetSection); CLAUDE.md, правило 5`)
- ✅ **raditi_search_web** — Веб-поиск через Yandex Search API: до 5 результатов, фраза до 200 знаков только из публичных слов, лимиты на ход и на сервис. (`apps/mcp/src/search/mcp-search.controller.ts; apps/mcp/src/search/web-search.ts`)
- ✅ **Облачный браузер web_*** — 15 инструментов: open, observe (дерево доступности с ref), click, fill, type, press, scroll, tab, upload, dialog, wait, help, verify, screenshot, download. (`apps/mcp/src/web/mcp-web.controller.ts`)
- ✅ **web_download** — Агент читает экспорт сайта (CSV, Excel по листам) частями; файлы живут только в браузерной сессии, а для клиента агент собирает свой файл. (`apps/mcp/src/web/mcp-web.controller.ts (web_download); spec §20, «Данные сайта клиента»`)
- ✅ **web_verify** — После «Сохранить» или «Опубликовать» агент перечитывает через сайт каждый сохранённый объект: дубликат после неясного сохранения закрыт. (`apps/mcp/src/web/mcp-web.controller.ts (web_verify); packages/domain/src/browser/checkpoint.ts`)
- ✅ **wp_rest и restore** — Чтение и правка заголовка, текста и описания записей и страниц WordPress, создание страниц и записей, настройки — в предпросмотре чата; restore возвращает снимок правки хода. (`apps/mcp/src/content/mcp-content.controller.ts; infra/server/docker-compose.server.yml (MCP_CONTENT_PROFILE: local)`)
- ✅ **db_schema** — Чтение, создание и расширение таблиц платформы в базе предпросмотра — единственный путь структуры базы в выпуск. (`apps/mcp/src/content/mcp-content.controller.ts (db_schema)`)
- ✅ **Браузер агента на предпросмотре** — browser_navigate, click, fill, expect, snapshot, screenshot, console, network и run_checks (до 10 проверок) на рабочей копии сайта; админка закрыта. (`apps/mcp/src/browser/mcp-browser.controller.ts; infra/server/docker-compose.server.yml (MCP_BROWSER_PROFILE: local)`)
- ✅ **site_info** — Агент узнаёт стек сайта, адреса предпросмотра и сайта, разрешённые операции БД и стартовую страницу браузера. (`apps/mcp/src/site-info/mcp-tools.controller.ts`)

## Контекст и память

- ✅ **Сессия агента между ходами** — Сессия OpenCode сохраняется зашифрованным снимком в raditi-sessions и продолжается следующим ходом, в том числе после правки клиента и «Обновить». (`apps/core/src/sessions; CLAUDE.md, «Правки чата и раздел „Терминал“»`)
- ✅ **/compact — сжать переписку** — Платный проход заменяет длинную историю кратким пересказом через opencode serve и продолжает с ним; /summarize — псевдоним. (`packages/domain/src/release/chat-commands.ts (compact); apps/core/src/tasks/turn-instructions.ts (AGENT_COMMANDS)`)
- ✅ **/init и «Подсказки агенту»** — Агент изучает код и пишет подсказки до 1800 знаков, а клиент сохраняет их кнопкой «Сохранить в подсказки агенту», поправив текст. (`apps/core/src/tasks/turn-instructions.ts (INIT_PROMPT); apps/web/src/components/chat/agent-notes-dialog.tsx`)
- ✅ **Подсказки проекта в каждом ходе** — sites.agent_notes проекта (из /init или мастера «Без доступа к файлам») читаются каждым ходом проекта как сведения о проекте. (`packages/trpc/src/routers/project.ts (agentNotes, setAgentNotes); docs/plan/57-browser-tasks.md (Б8)`)
- ✅ **Инструкции платформы по стеку** — Каждый проход получает правила: рабочий набор адаптера, папки медиа, операции БД стека, предпросмотр, интернет, документы и страницы, имена переменных. (`apps/core/src/tasks/turn-instructions.ts (turnInstructions)`)
- ✅ **Переменные окружения клиента агенту** — Значения из раздела «Переменные» (Vault) получают только команды bash агента и предпросмотр — с согласием «передавать агенту», с маскированием в событиях и без доступов хостинга. (`apps/core/src/site-env; CLAUDE.md, правило 2`)

## Расширяемость

- ✅ **Навыки агента (MCP)** — Context7 и Playwright включены по умолчанию; владелец проекта выключает их и добавляет до 8 удалённых MCP-серверов по https без ключей. (`packages/domain/src/agent/skills.ts; apps/web/src/components/site/site-agent-skills.tsx`)

## Многоагентность и фон

- ✅ **Параллельные чаты** — Рабочее пространство ведёт до 8 ходов сразу, чаты одного проекта идут одновременно, а ход без места ждёт в очереди. (`docs/plan/70-turn-without-time-limit.md (ВР26); CLAUDE.md, «Ход без предела времени и 8 песочниц»`)
- ✅ **Ход без предела времени** — Аренду, ключи и контейнер хода продлевает пульс раз в 30 секунд, а ход кончается сам, по кредитам или по «Остановить». (`docs/plan/70-turn-without-time-limit.md`)
- ✅ **Фоновая работа на сервере** — Ход идёт в очереди на сервере, клиент может закрыть страницу, а результат появится в чате. (`apps/core/src/tasks/turns.processor.ts; packages/domain/src/tasks/client-feed-labels.ts (feedWaitingText)`)
- ✅ **Запасной путь модели** — Когда квота плана Z.ai кончилась, ход идёт через API Z.ai, клиенту ничего не меняется. (`docs/plan/70-turn-without-time-limit.md (ВР23–ВР25)`)

## Безопасность

- ✅ **Песочница хода** — Контейнер на ход под gVisor: uid 10001, read-only rootfs, cap-drop ALL, пределы CPU, памяти и процессов, без долгоживущих секретов. (`CLAUDE.md, правило 5; packages/sandbox-providers`)
- ✅ **Сеть песочницы и браузера** — Единственный выход — шлюз и прокси: непубличные адреса, IP и подсети платформы закрыты, имена платформы браузер не открывает (BROWSER_PLATFORM_HOSTS). (`CLAUDE.md, правило 5; docs/plan/61-chats-first.md (К37)`)
- ✅ **Сохранённый вход в админку** — SITE_ADMIN_LOGIN и SITE_ADMIN_PASSWORD из Vault вводит в форму сам браузер задачи: модели, командам и предпросмотру они не идут. (`CLAUDE.md, правило 2 (Б36)`)
- ✅ **Политика стека в браузере** — У WordPress закрыты консоль, пользователи, плагины, темы, настройки и удаление; больше 20 изменённых объектов за задачу агенту отказаны. (`docs/plan/57-browser-tasks.md (Б21, Б31, Б34)`)
- ✅ **Пароли не попадают модели** — В наблюдении страницы значения полей паролей и кодов и секретные части адресов показаны как [hidden], а пароль агент просит ввести клиента через web_help. (`apps/mcp/src/web/mcp-web.controller.ts (web_observe, web_fill)`)
- ✅ **Проверка диффа агента** — Дифф с путями CI, .gitmodules или защищёнными путями адаптера отклоняется, секреты ищет gitleaks. (`CLAUDE.md, правило 6; apps/core/src/git-workspace`)
- ✅ **Права и подтверждение выпуска** — Выпускать и отменять версии могут только владелец и администраторы; подтверждение привязано к показанному описанию, а массовый план требует отметки «Я посмотрел(а)». (`apps/web/src/components/chat/release-dialog.tsx; packages/domain/src/release/chat-commands.ts (not_allowed)`)

## Сессии

- ✅ **Список чатов** — Чаты одним списком или папками по проектам («Без проекта» последней), со статусом, временем и «Показать ещё». (`apps/web/src/components/chat/dialog-list.tsx; docs/plan/61-chats-first.md (К23)`)
- ✅ **Переименовать и удалить чат** — Меню чата переименовывает его на месте; «Удалить» с подтверждением останавливает агента и возвращает отложенные кредиты. (`apps/web/src/components/chat/chat-texts.ts (dialogMenuText); packages/trpc/src/routers/task.ts (rename, remove)`)
- ✅ **/new и /sessions** — Новый чат с тем же проектом (/clear) и переход к списку чатов (/resume, /continue). (`apps/web/src/components/chat/client-commands.tsx`)
- ✅ **/export — скачать переписку** — Сервер собирает чат в Markdown, а браузер сохраняет файл. (`apps/web/src/components/chat/dialog-view.tsx (exportChat); packages/trpc/src/routers/task.ts (export)`)
- ✅ **Чат без проекта** — Чат без сайта — с браузером на любом публичном https-сайте, файлами в /workspace/inbox и личным пространством с подарком. (`docs/plan/61-chats-first.md (К12, К15, К16)`)
- ✅ **Закрытый проект — только чтение** — Чат проекта на паузе или отключённого читается, но не продолжается; «Остановить» остаётся. (`packages/domain/src/release/chat-commands.ts (project_closed, CLOSED_PROJECT_TEXT)`)

## Интеграции и команда

- ✅ **WordPress** — Код, медиа и контент в предпросмотре, операции БД выпуска и браузер в админке с политикой стека. (`packages/site-adapters (wordpress); infra/wordpress`)
- 🟡 **Joomla** — Адаптер с импортом, предпросмотром и выпуском только файлов; работает только вне production. (`docs/plan/62-site-stacks.md (Э3); packages/site-adapters/src/joomla`)
- 🟡 **1С-Битрикс** — Только опознание стека и честный отказ, файловой оси нет. (`docs/plan/62-site-stacks.md (Т40)`)
- ✅ **Git-репозиторий сайта на Gitea** — Ветка agent/<taskId> на чат, коммиты от бота, теги выпусков vX.Y.Z, выкладка по тегу обязательным пайплайном. (`packages/git-providers; ci/; CLAUDE.md, правило 6`)
- 🟡 **Оплата и тарифы** — Тарифы в кредитах и пакет через ЮKassa; на настоящем магазине не проверено. (`packages/billing; docs/plan/72-pricing-api-margin.md`)
- 🟡 **Роли рабочего пространства** — Роли owner, admin и member в коде есть, но приглашений участников нет. (`packages/domain/src/release/chat-commands.ts (role); docs/plan/roadmap.md (M1)`)

## Результат наружу

- ✅ **/release — выпуск новой версии** — Коммит в main, тег, бэкап, файлы по SFTP/FTP(S), записи БД плагином, проверка сайта и автооткат; номер версии — предложенный или соседний. (`apps/web/src/components/chat/release-dialog.tsx; apps/core/src/releases; apps/core/src/deploy-step`)
- ✅ **Операции БД в выпуске** — Тексты записей, настройки закрытого списка, новые записи и таблицы платформы (только добавлением) — со сверкой с продом, предусловиями и обратной операцией. (`packages/domain/src/release/db-plan.ts; docs/plan/53-chat-preview-release.md («Операции БД»)`)
- ✅ **/rollback — отменить выпуск** — В течение 7 дней — новый выпуск с прежними файлами и значениями; окно показывает план отмены и что останется на сайте. (`apps/web/src/components/chat/undo-dialog.tsx; packages/domain/src/release/undo.ts`)
- 🟡 **Публикация страниц агента** — page_publish выкладывает .html, .md или готовый документ по адресу https://<slug>.pages.raditi.ru/, у страницы версии v1, v2… под одной ссылкой; работает только при PAGES_BASE_DOMAIN. (`apps/mcp/src/pages/mcp-pages.controller.ts; docs/plan/69-pages.md`)
- ✅ **Страница в ленте и раздел «Страницы»** — Карточка страницы с «Открыть», «Скопировать ссылку» и паролем, снятием (410) и восстановлением; все страницы — в разделе /pages. (`apps/web/src/components/chat/feed-page.tsx; apps/web/src/app/(protected)/pages/page.tsx; packages/trpc/src/routers/pages.ts`)
- ✅ **Правка живого сайта через браузер** — По явной просьбе клиента агент меняет контент через админку сайта сразу, мимо предпросмотра и выпуска, без отката; лента говорит «проверьте сайт». (`CLAUDE.md, правило 3 (Б1); docs/plan/61-chats-first.md (К10)`)

## Чего нет (проверено поиском по коду)

- Голосовой ввод, диктовка, камера и демонстрация экрана: в apps/web/src нет SpeechRecognition, getUserMedia и MediaRecorder
- Озвучка ответов: speechSynthesis нигде не используется
- Перетаскивание файлов в поле: у поля и ленты нет onDrop и onDragOver, файлы только скрепкой или вставкой
- Папки и архивы во вложениях: zip и другие архивы не входят в attachmentTypes
- @-упоминания файлов, папок и URL: у composer нет такого разбора, контекст выбирается только пилюлей проекта
- Правка отправленного сообщения и ветвление чата: процедур нет в task-роутере, остаётся только /undo, который возвращает слова в поле
- Очередь сообщений и «направить» агента во время работы: поле закрыто («Написать можно будет, когда агент закончит…»), доступно только «Остановить»
- Выбор модели: одна GLM-5.3, /models открывает только меню уровня размышления
- Подсветка синтаксиса кода, формулы и диаграммы: в web только react-markdown и remark-gfm, без shiki, prism, katex и mermaid
- Картинки в ответе агента: img заменяется подписью alt
- Модель не видит изображений: драйвер не передаёт картинки (UNSEEN_IMAGES)
- Кнопка «Скопировать ответ» и оценка ответа: в feed-list нет clipboard и feedback
- Поиск по чатам: в списке чатов поиска нет
- Ссылка на чат для других: в task-роутере нет процедуры шаринга
- Уведомления о задачах — системные, звук, push и письма: каталог писем содержит только вход и оплату, Notification API не используется
- Telegram и другие каналы ввода: задачи P13 и M3 открыты, Telegram используется только для заявок
- Публичный API, вебхуки и расписание для запуска чатов: в схеме задач нет расписания, в /api нет создания задач
- Субагенты, LSP и веб-поиск самого OpenCode: в permissionOf стоят task, lsp и websearch: deny
- Показ todo-списка агента: todowrite разрешён, но интерфейс его не рисует
- Свои слэш-команды, хуки и плагины: chatCommandIds закрыт, OpenCode запускается с plugin: [] и OPENCODE_PURE
- Принятие и отклонение изменений по частям: кандидат выпускается только целиком
- Токены и контекстное окно в чате: не показываются, только кредиты
- AGENTS.md проекта: CLI его не читает, вместо него подсказки агенту (К31)
- Согласование опасных действий (request_approval): не построено, опасное закрыто отказом
- Выкладка в GitHub или GitLab клиента: открытый вопрос spec §20, есть только Gitea
