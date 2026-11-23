# f1. Видит ли агент свои макеты: зрение GLM на Z.ai, картинки в OpenCode, рендер артбордов в песочнице

Дата: 19.11.2026. Только исследование, в репозитории ничего не менялось.

Метод:
- Код репозитория читался в дереве `feat/artifacts` (b1349f3b).
- Исходники OpenCode 1.18.34 скачаны с коммита тега `aec0b9a6d8898f68f923aaf08b7306d931fd9d76`. Это тег `v1.18.34`, выпуск 30.09.2026.
- Страницы Z.ai взяты в Markdown-версиях `docs.z.ai/…md`. Пакет `@z_ai/mcp-server` 0.1.6 распакован и прочитан, не запускался.
- Тип Design (Claude) прочитан инструментом Artifact: `read type_url`, выпуск `1795091701-efb7`.
- Сохранённые страницы: (локальные копии страниц сессии исследования; в репозиторий не входят).
- Расчёты: (локальные копии страниц сессии исследования; в репозиторий не входят).
- Коды источников ([Z1] и т. д.) — в конце отчёта. «Не подтверждено» — нет первоисточника или нет живого прогона.

Не повторяю того, что уже сказано:
- r7 §2.4 и §4.7 — «рисует вслепую», текстовый отчёт вёрстки как мера.
- c3 §11 — песочница артефактов не видит, `web_screenshot` уходит клиенту.
- r5 §3 — как снимки выбранного кадра прикладываются к сообщению: Replit, Lovable, v0, Figma Make, Base44.
- r1 §4.2–4.3 — холст Design и `artifact-view-context`.

---

## 0. Коротко

1. **Основная модель слепая, зрячая модель на плане есть.**
   - GLM-5.3 — только текст: «GLM-5.3 currently supports text-only inputs» [Z2]. В инструкции Z.ai для Cline сказано: «GLM-5.3 is a text-only model, so uncheck Support Images» [Z8].
   - Зрячая модель из того же семейства — **GLM-5.3-Flash**, выпуск 26.08.2026 [Z5].
     - Вход: видео, изображения, текст, файлы. Контекст 1M, выход 128K [Z3].
     - Есть на GLM Coding Plan для Lite, Pro и Max, «with 3× the available quota compared with GLM-5.3» [Z3, Z6].
     - API: $0.15 вход, $0.03 кэш, $0.50 выход за 1M [Z1].
   - Z.ai прямо учил её смотреть на собственный рендер: «data synthesis pipelines for visual coding, with a focus on self-visual judgment… inspect its own outputs, and refine them iteratively» [Z3].
2. **Пределы и счёт картинок.**
   - Картинка в API — блок `image_url` со ссылкой или Base64 Data URL: «under 5M per image, with pixels not exceeding 6000*6000… Supports jpg, png, jpeg» [Z7].
   - Как картинка переводится в токены, Z.ai не пишет (не подтверждено).
   - По `processor_config.json` открытых весов: патч 14 px, слияние 2×2, 16–8000 токенов на картинку [H1]. Отсюда моя оценка: 1 токен ≈ 28×28 px. Кадр 1440×900 ≈ 1,6 тыс. токенов, телефон 390×844 ≈ 0,4 тыс.
3. **OpenCode 1.18.34 умеет отдавать картинки модели.**
   - Источники картинок: встроенный `read` (PNG, JPEG, GIF, WebP), картинки в ответе инструмента MCP (`type: "image"`) и `opencode run --file`.
   - Для `@ai-sdk/openai-compatible` картинки результата инструмента переносятся в синтетическое сообщение пользователя «Attached media from tool result:».
   - Модель получает их только если у неё в конфиге `modalities.input` есть `"image"`. Иначе — текст «ERROR: Cannot read image (this model does not support image input). Inform the user.» [O3, O4, O5, O6].
   - Драйвер сейчас `modalities` не объявляет. Поэтому даже без `--image-responses omit` модель картинок не увидит.
4. **Роль `llm` картинки не пропускает.**
   - Схема тела Z.ai строгая: у `user` только строка или список `{type:'text'}` (`packages/llm-backends/src/zai-coding/body.ts:33-38`). Блок `image_url` даёт окончательный отказ `policy`, и ход кончается.
   - Модель запроса должна совпадать с моделью ключа хода (`body.ts:153`).
   - Тело запроса — не больше 16 МиБ.
   - Подсчёт токенов картинок в домене уже есть (`imagePaths`, 2000 токенов на картинку), но политика Z.ai его не вызывает.
5. **Chromium образа песочницы можно запустить из `bash` — живым прогоном не проверено.**
   - Это тот же бинарник `/opt/ms-playwright`, что у навыка Playwright. Навык уже работает в песочнице production: по замеру РА3 ход с навыком занимает до 850 МиБ, сам навык — около 300 МиБ.
   - OpenCode проверяет «внешние каталоги» только у файловых команд (`cd`, `rm`, `cp`, `cat`…); `node` и `chrome` под проверку не попадают.
   - Рендер в песочнице не равен виду клиента. Ассетов артефакта на адресах платформы нет: адреса платформы закрыты. Шрифты Google доступны только через прокси.
6. **Три пути, у каждого своя цена.**
   - **C — текстовый отчёт вёрстки.** Правил не меняет. Около 0,07–0,2 кредита и 2–6 с на проверку.
   - **A — рендер в песочнице, затем подагент GLM-5.3-Flash через ту же роль `llm`.**
     - При `low` — около 0,08 кредита и 25–70 с на проверку.
     - При `max` и 4 полосах — до 0,26 кредита и до 2–2,5 мин: по стороннему замеру первый токен ответа приходит через 90 с [AA].
     - Нужны профиль и ставка, второй ключ хода или пара моделей на ключ, правка политики тела в `llm` и драйвера.
   - **B — рендер в `apps/browser`.** Рендер такой же, как видит клиент. По MCP агенту приходит картинка или отчёт.
   - Платформа не может звать Z.ai сама в обход OpenCode на плане: условия запрещают «directly invoking model APIs from your own applications» [Z11]. Такой вызов возможен только на `zai-api`.
7. **Конкуренты (только новое к r1/r5).**
   - v0, Lovable и Replit проверяют свою работу браузером со снимками — выборочно и медленно.
   - tldraw на каждом запросе берёт свежий снимок вида и может запланировать запрос «review».
   - Figma `get_screenshot` даёт снимок как образец для кода.
   - Canva отдаёт миниатюру страницы внутри транзакции правки и велит показать её человеку.
   - Claude Design поступает наоборот: «NEVER VERIFY UNLESS THE USER ASKED… Do NOT… render, screenshot or open it». Вместо этого — правила в тексте и правки человека [F].
8. **Решения владельца.**
   - «фото отложим» (06.11.2026, `docs/spec.md:3289`).
   - N22, «пиксели модели»: по умолчанию нет, ждёт владельца и юриста (`docs/spec.md:2618`).
   - Б20, «скриншотов модели нет», — решение владельца (`docs/plan/57-browser-tasks.md:40`).
   - Вопрос владельцу: дать ли агенту зрение для проверки собственных макетов. Предлагаемое значение по умолчанию — **пока нет**: делать C, а при «да» — подагент GLM-5.3-Flash (§6).

---

## 1. Модели Z.ai со зрением на 19.11.2026

### 1.1 Перечень

| Модель | Выход | Вход | Контекст / выход | API, $ за 1M: вход / кэш / выход | GLM Coding Plan |
|---|---|---|---|---|---|
| **GLM-5.3** (основная у Радити) | 18.08.2026 [Z5] (models.dev — 14.08 [M1]) | только текст [Z2] | 1M / 128K [Z2] | 1.4 / 0.26 / 4.4 [Z1] | да, все уровни; множители кредитов плана 6.9 / 1.7 / 24 [Z6] |
| **GLM-5.3-Flash** | 26.08.2026 [Z5]; репозиторий HF создан 25.08.2026, MIT [H2] | видео, изображения, текст, файлы [Z3]; у models.dev — `image/jpeg`, `image/png`, видео, PDF [M1] | 1M / 128K [Z3] | 0.15 / 0.03 / 0.50 [Z1] | да, все уровни, «3× the available quota» [Z3, Z6]; множители 2.3 / 0.56 / 8, в ту же строку входит Vision MCP [Z6] |
| GLM-5.3-FlashX | вместе с Flash [Z3] | то же | 1M / 128K | 0.37 / 0.075 / 1.25 [Z1]; «200 tokens/s» [Z3] | **нет**: «GLM-5.3-FlashX is not yet available on the plan» [Z3] |
| GLM-5.3-FlashX-Legal | 21.10.2026 (дата картинки на странице, не подтверждено) | то же | — | 0.37 / 0.075 / 1.25 [Z1] | не подтверждено |
| GLM-5V-Turbo | 01.04.2026 [S-MT] | видео, изображения, текст, файлы [Z4] | 200K / 128K [Z4] | **в прайсе Z.ai на 19.11.2026 нет** [Z1]; у Vercel AI Gateway $1.20 / $4.00 [S-VG] | в списке моделей плана нет [Z6]; доступность не подтверждена |
| GLM-4.6V / -FlashX / -Flash | 08.12.2025 [S-OR]; HF 07.12.2025, MIT [H3] | видео, изображения, текст, файлы [Z12] | 128K [Z12] | 0.3 / 0.05 / 0.9; FlashX 0.04 / 0.004 / 0.4; Flash бесплатно [Z1] | в списке моделей плана нет |
| GLM-4.5V | HF 10.08.2025 [H3] | изображения, текст | — | 0.6 / 0.11 / 1.8 [Z1] | нет |
| GLM-OCR (0.9B) | HF 30.01.2026 [H3] | PDF, JPG/PNG ≤ 10 МБ, до 100 страниц [Z13] | — | 0.03 / — / 0.03 [Z1] | нет: только Layout Parsing API |

Состав плана:
- «All plans support GLM-5.3, GLM-5.3-Flash. Requests for GLM-5.2/GLM-5.1 will be automatically routed to GLM-5.3, requests for GLM-4.7 will automatically be routed to GLM-5.3-Flash» [Z6].
- Что ответит план на `glm-4.6v` или `glm-5v-turbo`, не подтверждено.

### 1.2 Картинка в запросе (OpenAI Chat Completions)

- **Формат.** Блок `{type:"image_url", image_url:{url}}` в `messages[].content[]`. Картинок может быть несколько. `url` — адрес («recommended») или Base64 Data URL [Z3].
- **Пределы.** «Image size limit is under 5M per image, with pixels not exceeding 6000*6000. GLM-5V are limited to 150 sheets. Supports jpg, png, jpeg formats» [Z7]. «150 sheets» читаю как 150 картинок на запрос (не подтверждено).
  - WebP и GIF в списке API нет, хотя OpenCode их читает.
  - Сервер Vision MCP Z.ai тоже принимает только `.jpg`, `.jpeg`, `.png` до 5 МБ (`build/core/file-service.js:25-38` пакета 0.1.6).
- **Сообщение `tool`.** В схеме Z.ai содержимое сообщения `tool` — только строка [Z7]. Картинка результата инструмента должна ехать в сообщении `user`; OpenCode так и делает (§2.2).
- **Инструменты.** Схема `ChatCompletionVisionRequest` говорит о `tools`: «Only supported by GLM-5.3-Flash series… max of 128 functions». Значит, у Flash вызовы инструментов есть [Z7].
- **Рассуждение.** `thinking.type` — только `enabled`; `reasoning_effort` — `low`, `high` или `max`, по умолчанию `max` [Z3, Z7]. Нормализатор `llm` выставляет ровно эти поля (`body.ts:158-167`), так что под Flash подходит.
- **Как считаются токены картинки — Z.ai не пишет** (не подтверждено). Прайс считает генерацию картинок поштучно, а ввод картинок не объясняет [Z1].
- **Оценка по открытым весам** [H1]: `patch_size: 14`, `merge_size: 2`, `min_image_tokens: 16`, `max_image_tokens: 8000`. Отсюда моя оценка: 1 токен ≈ 28×28 px.

  | Кадр | Токенов |
  |---|---|
  | 1440×900 | ≈ 1 632 |
  | 1280×800 | ≈ 1 334 |
  | 390×844 | ≈ 420 |
  | 1440×3600 (полная страница) | ≈ 6 579 |
  | 1440×6000 | 10 914 → потолок 8 000, картинка уменьшается |

  Как предобрабатывает API, не подтверждено. Нужен живой замер `usage.prompt_tokens` на синтетической картинке.
- **Цена картинки.** В API картинка, по-видимому, оплачивается как входные токены. На плане — как вход с множителем 2.3/10 000 кредита плана (не подтверждено для картинок).

### 1.3 План GLM Coding Plan и картинки

- **Квота.** Окна 5 ч и неделя: Lite 2 000 / 10 000, Pro 12 000 / 60 000, Max 28 000 / 140 000 кредитов плана [Z6].
- **Формула.** «Model credit usage = (Input tokens × Input multiplier + Cached Input tokens × Cached Input multiplier + Output tokens × Output multiplier) / 10,000».
  - Вне часов пик — 50 %. Пик — пн–пт 14:00–18:00 по Сингапуру [Z6].
- **Vision MCP Z.ai** входит во все планы и считается по строке GLM-5.3-Flash [Z6, Z9].
  - «Other than the resource package, we currently do not provide any other access solutions for calling these three MCP tools» [Z9].
- **Квота кончилась.** Ответ ждёт окна, деньги со счёта не списываются: «Users subscribed to the Coding Plan can only make calls via the plan's quota in supported tools. API calls outside the plan are not available» [Z9].
- **Задержка (сторонний замер).** Artificial Analysis для GLM-5.3-Flash на API Z.ai: 56 ток/с, «Time to first answer token: 90.16s» [AA]. Вероятно, это при `max`, где рассуждение идёт до ответа. Для `low` данных нет (не подтверждено).

### 1.4 Что условия Z.ai говорят о картинках

- **Отдельных правил о вводе картинок нет.**
  - В Terms of Use (Last Update April 14, 2026) есть запрет на «sexually explicit, suggestive, visually shocking» содержимое [Z10].
  - Пользовательский контент «индивидуальных пользователей» Z.ai вправе использовать по бессрочной лицензии [Z10]. Это та же развилка, что П91: картинки артефактов попадают туда же, куда текст.
- **Условия плана о сценарии использования** [Z11]:
  - «only used within officially supported tools… If the system detects usage through unauthorized or unsupported tools (such as SDK-based access or other third-party integrations), some subscription benefits may be restricted».
  - «You shall not use the GLM Coding Plan quota… directly invoking model APIs from your own applications, bots, websites, SaaS products…».
  - OpenCode в списке поддерживаемых инструментов есть [Z14].
  - Вывод: вызов Flash из OpenCode хода — та же позиция, что сейчас (риск принят, П86–П87). Вызов из кода платформы — новое нарушение условий плана, допустимо только на `zai-api`.

### 1.5 Vision MCP Z.ai изнутри (чтение кода 0.1.6 от 29.10.2026, Apache-2.0)

- **Модель.** По умолчанию `glm-5.3-flash` (`build/core/environment.js:108`).
- **Адрес.** `https://api.z.ai/api/paas/v4/chat/completions`: обычный путь API, не `/api/coding/…` (`environment.js:33-43`).
- **Запрос.** Ключ плана в `Authorization`, заголовок `X-Title: 4.5V MCP Local` (`build/core/chat-service.js:54-58`). Поля: `thinking: {type:'enabled'}`, `max_tokens` 131 072 (`chat-service.js:17-24`, `environment.js:108-114`).
- **Картинки.** До 5 МБ, только jpg/jpeg/png. Локальный файл кодируется в data URL (`build/core/base-image-service.js:12-28`).
- **Почему не в песочницу.** Серверу нужен ключ плана (`Z_AI_API_KEY`), а это нарушает правило 2. Запустить его на доверенной стороне (`apps/mcp`) — значит вынести ключ плана из роли `llm`, тоже против правила 2.
- **Что полезно.** Набор его инструментов — образец того, что Z.ai считает проверкой интерфейса: `ui_diff_check` («Compare two UI shots to flag visual or implementation drift»), `ui_to_artifact`, `diagnose_error_screenshot` [Z9].

---

## 2. OpenCode: как модель объявляет картинки и как они до неё доходят

### 2.1 Версия 1.18.34 (в образе песочницы)

- **Схема модели в конфиге** (`packages/core/src/v1/config/provider.ts:13-79` в коммите тега). Поля:
  - `attachment: boolean`;
  - `modalities: { input?: ("text"|"audio"|"image"|"video"|"pdf")[], output?: […] }`;
  - `reasoning`, `tool_call`, `interleaved`, `limit`;
  - своя пара `provider: { npm, api }` у модели — другой пакет или адрес для одной модели;
  - `options`, `headers`, `variants`.
- **Как конфиг становится возможностями** (`packages/opencode/src/provider/provider.ts:1571-1591`):
  - `capabilities.input.image = model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false`;
  - `attachment = model.attachment ?? existing ?? false`.
  - У провайдера `raditi` своей записи в каталоге нет. Каталог не грузится: `OPENCODE_DISABLE_MODELS_FETCH=1` (`packages/agent-drivers/src/opencode.ts:112`). Поэтому без `modalities` картинка = `false`.
- **Пределы картинок** (документация V1: опция `attachment.image` [O2]; код `packages/opencode/src/image/image.ts:10-14`):
  - по умолчанию 2000×2000 px и 5 242 880 байт Base64, сжатие JPEG качеством 80, 85, 70, 55, 40, ресайзер — photon WASM;
  - «If an image still cannot fit after resizing, OpenCode omits oversized tool-result images or fails oversized user-provided images with an image size error» [O2].

### 2.2 Ключевой вопрос: доходит ли картинка из инструмента до модели

Да, по коду 1.18.34 — при объявленном `image`. Путь:

1. **Встроенный `read`.** Определяет по байтам `image/jpeg|png|gif|webp` и возвращает «Image read successfully» с вложением `data:<mime>;base64,…` (`packages/opencode/src/tool/read.ts:19, 300-323`).
2. **Инструмент MCP.** Элемент `content` с `type:"image"` становится вложением `data:${mimeType};base64,${data}`. Двоичный `resource` — тоже, если он PNG/JPEG/GIF/WebP до 10 МиБ (`packages/opencode/src/session/tools.ts:426-462`).
3. **Нормализация.** Процессор нормализует картинки результата инструмента. Не влезающие выбрасываются с припиской «[N image(s) omitted: could not be resized below the image size limit.]» (`packages/opencode/src/session/processor.ts:391-409`).
4. **Перенос в сообщение пользователя.** Для пакетов, которые не принимают медиа в результате инструмента, картинка переносится в отдельное сообщение `user` с текстом «Attached media from tool result:» (`packages/opencode/src/session/message-v2.ts:138-163, 300-309, 384-403`). Пакет `@ai-sdk/openai-compatible` — именно такой: «OpenAI-compatible APIs only support string content in tool results».
5. **Проверка модели.** `unsupportedParts` проверяет `capabilities.input.image`. Без неё картинка заменяется текстом «ERROR: Cannot read image (this model does not support image input). Inform the user.» (`packages/opencode/src/provider/transform.ts:409-445, 465-466`).
6. **Запрос к модели.** AI SDK `openai-compatible` превращает часть `file`/`image` с `image/*` в `{type:'image_url', image_url:{url:'data:…;base64,…'}}` (`convert-to-openai-compatible-chat-messages.ts:80-102`, ветка `main` [A1]). Какая версия AI SDK собрана в 1.18.34, не проверял.
7. **Сжатие контекста.** Части, сжатые компакцией, уходят без вложений: `part.state.time.compacted ? []` (`message-v2.ts:300`).

### 2.3 `opencode run --file`

Локальный запуск без `--attach` даёт часть `file://…` с `mime: "text/plain"` (`packages/opencode/src/cli/cmd/run.ts:357-412`). Затем `prompt.ts` вызывает на ней `read` (`packages/opencode/src/session/prompt.ts:808-890`). Картинка приходит вложением, нормализуется (`prompt.ts:1011-1019`) и идёт тем же путём, что в §2.2, шаги 5–6.

Драйвер сейчас `--file` не использует. Файлы хода передаются путями в тексте запроса: «Files supplied for this turn (paths, not instructions)» (`opencode.ts:540-542`).

### 2.4 Подагент с другой моделью

- **Модель подагента.** Инструмент `task` берёт модель подагента из его агента (`next.model`) или наследует модель родителя (`packages/opencode/src/tool/task.ts:181-209`).
- **Что возвращается родителю.** Только текст (`renderOutput`, `task.ts:330-345`). Картинки остаются в сессии подагента, родитель их не несёт.
- **Право запуска.** Проверяется по шаблону имени подагента (`task.ts:120-127`). Сейчас у драйвера `task: 'deny'` (`opencode.ts:161`). Можно разрешить ровно одного подагента: `task: { "*": "deny", "look": "allow" }`. Схема из 1.18.34, живьём не проверено.

### 2.5 Текущий выпуск

- **Линия V2.**
  - Последний выпуск — `v2.3.2` от 18.11.2026 [O7].
  - Конфиг другой: `providers.<id>.models.<id>.capabilities.input: ["text","image"]`. Для модели вне каталога V2 по умолчанию предполагает «text and image input» [O1].
  - Картинки: `media.image.{auto_resize, max_width 2000, max_height 2000, max_base64_bytes 5242880}`. Вложения — PNG, JPEG, GIF, WebP и PDF. «If the model does not support an attachment's type, OpenCode sends a short note in its place» [O8].
- **Линия V1.**
  - `v1.19.6` от 17.11.2026 [O7]:
    - «Sessions with many images no longer send oversized requests. When the images in a session's history pass 25 MiB, the oldest are replaced with a placeholder»;
    - «A provider error for a request body that is too large now starts compaction and a retry».
  - В 1.18.34 этого нет. Для Радити это важно: тело запроса ≤ 16 МиБ (§3.2), и все картинки истории уходят в каждом запросе хода.
- **Переход на V2** — отдельная задача: обёртка драйвера опирается на свойства 1.18.34 (`packages/agent-drivers/cli/README.md`).

### 2.6 Известные сбои на этом пути (повод для живой проверки)

- **#15728** «Read tool cannot pass image data to vision-capable models». Закрыт ботом как `not_planned` 17.07.2026 [O9].
- **#20802** «Custom OpenAI-compatible providers: image file attachments do not reach vision-capable models correctly». Закрыт `not_planned` 09.08.2026 [O9].
  - Сопровождающий 16.10.2026: «I assume u tried `glm-5.3-flash` since that's the only model I could repro w/». Речь о DigitalOcean.
  - PR models.dev #10162 от 16.10.2026 пометил запись DigitalOcean текстовой: «Its standard serverless endpoint rejects any image or video: 400 "unsupported multimodal content: image_url"» [M2].
  - Это хостинг-посредник, не Z.ai, но вывод общий: поддержку картинок у конкретного адреса надо проверить вживую.
- **PR #21627, #23501, #26825, #26826, #15788** (поддержка картинок у `openai-compatible`) закрыты без слияния: по API GitHub `merged_at` пуст [O9].
- Код 1.18.34 по чтению путь проводит (§2.2). Работает ли это с Z.ai — **не подтверждено живым прогоном**.

### 2.7 Playwright MCP

- `--image-responses <mode>`: «"allow", "omit" or "only"… Defaults to "allow"».
- `--caps vision` — работа по координатам снимка [P1].
- Драйвер запускает навык с `--image-responses omit` (`opencode.ts:237-238`). С `allow` снимок `browser_take_screenshot` попал бы в путь из §2.2. Для GLM-5.3 он превратился бы в «ERROR: Cannot read image…».

---

## 3. Факты кода (только чтение)

### 3.1 Драйвер `packages/agent-drivers/src/opencode.ts`

- **Модель** — `modelSettings()`, строки 293–322.
  - Один провайдер `raditi`: `npm: '@ai-sdk/openai-compatible'`, `options: { baseURL, apiKey: '{file:<llmKey>}' }`.
  - Одна модель `{ name, reasoning: true, tool_call: true, interleaved: { field: 'reasoning_content' }, limit: MODEL_LIMIT }`.
  - **Нет `modalities` и `attachment`.** `MODEL_LIMIT = { context: 1_000_000, output: 131_072 }` (строка 71).
  - `small_model` — та же модель (297), `enabled_providers: ['raditi']` (299).
- **Конфиг хода** — `configuration()`, 329–357. Пишется в `~/.config/opencode/opencode.json` с режимом 0600 (419–423). Ключ хода читается один раз из именованного канала (комментарий 324–327).
- **MCP.**
  - Сервер платформы — `type: 'remote'` с `Authorization: Bearer {file:<mcpKey>}` (337–344).
  - Навыки — `skillServer()` (197–253): `remote`, `relayed` через ретранслятор `apps/mcp`, `local` — Playwright.
  - Локальный Playwright запускается так (220–238): `node …/@playwright/mcp/cli.js --headless --browser chromium --no-sandbox --isolated --proxy-server <прокси> --proxy-bypass <прямые> --output-dir <home>/playwright/output --viewport-size 1280x800 --image-responses omit`. Окружение: `HOME`, `TMPDIR` и `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` (239–243).
  - Комментарий 132–137: «Screenshots reach no model: it reads no pixels (N22)».
- **Права** — `permissionOf()`, 150–187.
  - `read`, `edit`, `bash` — `allow`; `task`, `skill`, `websearch` — `deny`.
  - `external_directory` открыт для `/workspace/inbox/*`, `/workspace/project`, `/workspace/out/*`, `/tmp` и `/tmp/*`, а при навыке — для каталога его снимков.
- **Возможности.** `capabilities.images: false` (401–409). Поле объявлено в порту (`packages/domain/src/ports/agent-driver.ts:30-31`), но в `apps/core` и `packages/domain` его никто не читает. Это справка, не переключатель.
- **Инструкция хода.**
  - `UNSEEN_IMAGES` (`apps/core/src/tasks/turn-instructions.ts:253-255`) добавляется, только когда во входящих есть файлы (398–403).
  - Про `web_screenshot` инструкция говорит «you never see it» (361–363).
  - Черновые файлы скриптов кладутся в `/tmp/opencode`, «never into /workspace/out» (131–133). Всё в `/workspace/out` уходит клиенту файлом, поэтому PNG для проверки там класть нельзя.

### 3.2 Роль `llm` и тело запроса `zai-coding`

- **Политика тела** — `packages/llm-backends/src/zai-coding/body.ts`.
  - `user.content` — строка или `[{type:'text', text}]`, комментарий «No images: the shell of this backend has no image input» (33–38).
  - `tool.content` — строка (53).
  - `requestSchema` — `strictObject` (56–72): лишний ключ или блок `image_url` → `refused(fieldOf(…))` (150–151).
  - Сервер отдаёт такой отказ как `policy` (`apps/llm/src/gateway/server.ts:678-700`). Это окончательный 400, и ход CLI кончается.
- **Модель ключа.** `if (request.model !== ctx.model) throw refused('model')` (`body.ts:153`). Один ключ хода — одна модель. Подагент на другой модели получит отказ, пока не будет второго ключа или пары моделей в профиле ключа.
- **Рассуждение.** Уровень задаёт профиль ключа, не запрос (`body.ts:154-167`). У подагента «на одном ключе» уровень был бы как у хода, например `max`, а значит медленная проверка (§1.3).
- **Оценка токенов.** `estimateLlmInputTokens(normalized)` без `imagePaths` (`body.ts:174`). Механизм для картинок есть: `imagePaths`, data URL `png|jpeg|webp|gif`, 2 000 токенов за картинку (`packages/domain/src/llm/json-policy.ts:9-15, 208-266`). Для Flash 2 000 — заниженная оценка: до 8 000 на картинку (§1.2).
- **Предел тела 16 МиБ.**
  - `llmJsonLimits.bytes` (`json-policy.ts:10`).
  - `readBody` отвечает 400 `raditi_body`, а не 413: «the pinned CLI reads every 413 as an overflow of its context» (`server.ts:205-240`).
  - Страховочный предел `sandbox-gw` — 16 МиБ (`infra/sandbox/gateway.mjs:45`).
- **Клиент.** Принимается только точный User-Agent закреплённого CLI: `opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` (`packages/llm-backends/src/zai-coding/backend.ts:119-131`). Подагент OpenCode проходит. Скрипт агента или код платформы — нет.
- **Адрес плана.** `/api/coding/paas/v4/chat/completions` (`backend.ts:63-68`). Документация Z.ai велит этот же адрес «Other OpenAI-compatible tools» и для Flash с «Support Images» [Z8]. Что адрес плана принимает `image_url`, **живьём не проверено**.
- **Профили.** Сиды — только `glm-5.3-{light,standard,heavy}` → `providerModelId: 'glm-5.3'` (`packages/db/prisma/seed/data.ts:236-248`). Ставки — только `glm-5.3` (`infra/billing/rates/2026-11-06-zai-coding.json`).

### 3.3 `web_screenshot` в `apps/browser` (куда уходит JPEG)

- **Ключ объекта.** `screenshots/<taskId>/<screenshotId>.jpg` в бакете входящих (`packages/domain/src/browser/tools.ts:70-75`).
- **Ответ модели.** `{tool:'web_screenshot', page, attached: true, number}`, «no pixel comes back» (`tools.ts:292-298`).
- **Пределы.** Качество JPEG 80 → 60 → 40, до 1 МиБ, 50 снимков на задачу (`packages/domain/src/browser/session.ts:223-234`).
- **Снимок.** Только видимая область страницы (`packages/domain/src/browser/ports.ts:158-166`). Снимается, только пока браузер держит агент (`apps/browser/src/sessions/worker-session.ts:1223-1241`).
- **Хранение.** `TaskScreenshots.save` кладёт JPEG в `raditi-inbox`, затем пишет строку ленты (`apps/browser/src/attachments/screenshots.ts`). Клиент видит снимок в чате, модель — нет (Б20, `docs/spec.md:845`).
- **Ресурсы сессии.** Контейнер браузерной сессии — 1 CPU, 1 536 МиБ, shm 256 МиБ (`packages/sandbox-providers/src/browser-session/kit.ts:58-59`).

### 3.4 Chromium образа из `bash`: рендер своего HTML в PNG без сети

- **Что лежит в образе.**
  - `npm ci` ставит `@playwright/mcp@0.0.83` с `playwright` и `playwright-core` `1.64.0-alpha-1790635538000` (`packages/agent-drivers/cli/package-lock.json:16-20, 218-237`).
  - Браузер ставится при сборке: `cli.js install-browser --with-deps --no-shell chromium` в `/opt/ms-playwright`, затем `chmod -R a+rX` (`infra/sandbox/Dockerfile:24-38`).
  - Node 26 — базовый образ (строка 3). Значит, у uid 10001 есть и `node`, и `playwright-core`, и Chromium.
  - axe-core в образе **нет**.
- **Права OpenCode.** `bash: allow`. Инструмент оболочки 1.18.34 проверяет внешние каталоги только для `cd`, `rm`, `cp`, `mv`, `mkdir`, `touch`, `chmod`, `chown`, `cat` и аналогов PowerShell (`packages/opencode/src/tool/shell.ts:28-45, 395-405`). Значит, `node /tmp/opencode/render.mjs` или `…/chrome --headless --screenshot` запрос права не вызывают. Живым прогоном не проверено.
- **Пределы песочницы.**
  - 2 vCPU, 4 096 МиБ, 512 процессов (`packages/domain/src/ports/sandbox-provider.ts:236-240`).
  - tmpfs: `/tmp` 64 МиБ, `/agent-home` 256 МиБ, `/workspace` 512 МиБ (`packages/sandbox-providers/src/docker.ts:56-63`).
  - `ShmSize` не задан, у Docker по умолчанию 64 МиБ (`docker.ts:464-482`). Playwright по умолчанию запускает Chromium с `--disable-dev-shm-usage` [P2]: общая память пишется во временный каталог, поэтому `TMPDIR` лучше направить в `/agent-home`, как делает навык.
- **Ресурсы.** Замер РА3 на сервере 09.11.2026: ход с навыком — до 850 МиБ и 1,6 ядра, «из них около 300 МиБ — Node навыка и его Chromium» (`docs/spec.md:3565`). Разовый рендер, видимо, даёт тот же порядок: около 300 МиБ на несколько секунд (оценка, не замер). Под `runsc` этот Chromium уже работает: навык идёт в production.
- **РА3** не выдаёт навык ходу с браузером платформы (`packages/domain/src/agent/skills.ts:300-318`), но бинарник лежит в образе у всех ходов. Запуск из `bash` технически возможен. Против него — довод РА3 о памяти и «втором браузере» чата, а не запрет.
- **Без сети.** `file://` или `page.setContent()` рендерятся, DNS не нужен. Но:
  - (а) шрифты Google доступны только через прокси выхода (`--proxy-server`);
  - (б) ассеты артефакта на адресах платформы (`/_blob/…`, домен страниц) из песочницы недоступны: адреса платформы закрыты;
  - (в) CSP показа (`/v/<token>`, без `allow-same-origin`, `connect-src 'none'` — c3 §11) в песочнице не повторяется.
  - Итог: рендер черновика агента ≈ вид клиента для HTML без чужих картинок и ≠ вид клиента для макета с загруженными фото.
- **Снимок сессии.** Картинки, прочитанные `read` или пришедшие из MCP, сохраняются в `opencode.db` как data URL во вложениях части инструмента. Процессор кладёт их туда (`processor.ts:391-409` 1.18.34), у `task` — так же (`prompt.ts:382-410`). База и WAL входят в снимок `home` (`opencode.ts:81`).
  - Пределы: архив ≤ 16 МиБ, файл в нём ≤ 32 МиБ (`packages/domain/src/sessions/session-state.ts:6-15`; `packages/snapshots/src/archive-validation.ts:118`).
  - 40 снимков по ~300 КБ Base64 дают около 12 МБ в базе (оценка). Это рядом с пределом архива уже через несколько ходов холста. Нужна чистка картинок из базы перед снимком или картинки вне сессии.

---

## 4. Конвейеры «агент проверяет свой артборд»

### 4.0 Допущения расчёта (`calc.py`)

- **Ставки.**
  - GLM-5.3 — ставки файла `2026-11-06-zai-coding.json`: 152,184 / 28,263 / 478,293 ₽ за 1M токенов входа / кэша / выхода.
  - GLM-5.3-Flash — по правилу П3 (публичная цена × курс ЦБ 83,6177 × 1,30): **16,306 / 3,261 / 54,352 ₽ за 1M**.
  - 1 кредит ≈ 6 ₽ учётной стоимости.
- **Одна проверка подагентом.**
  - `low`: 16 тыс. токенов входа без кэша, 24 тыс. кэша, 3 тыс. выхода. Сюда входят системная подсказка, 2 картинки ≈ 2 тыс. токенов и 2–3 запроса.
  - `max`, 4 полосы страницы и 2 круга: 40 тыс. / 80 тыс. / 12 тыс.
  - Сколько входа даёт подсказка OpenCode подагенту с урезанными инструментами, не замерено.
- **Типовой ход GLM-5.3:** 30 тыс. входа, 300 тыс. кэша, 15 тыс. выхода ≈ 20,2 ₽ ≈ **3,37 кредита**; на плане это 107,7 кредита плана.
- **Скорость.** GLM-5.3-Flash — 56 ток/с, первый токен ответа при `max` — около 90 с [AA]. Для `low` — оценка.
- Числа клиенту округляются вверх на проход. Добавка к проходу — меньше 1 кредита, по сумме — как в таблице ниже.

### A. Рендер в песочнице → PNG → GLM-5.3-Flash через ту же роль `llm` (ключ провайдера в песочнице не появляется)

**Как.**
1. Агент сохраняет HTML кадра в `/tmp/opencode/…`: черновик перед записью или копию записанного.
2. Готовый скрипт образа рендерит 1440 и 390 в JPEG качеством ≈70, по полосам высотой ≤2000 px. Скрипт — файл образа, а не текст, который агент пишет каждый раз: иначе он платит выход GLM-5.3 за сам скрипт.
3. Затем один из двух вариантов:
   - **A1.** Главная модель холстов — `glm-5.3-flash`. Агент сам делает `read` PNG.
   - **A2.** Главная модель — `glm-5.3`. Агент вызывает подагента `look` (`task`) с моделью `raditi/glm-5.3-flash`. У подагента только `read` в `/tmp/opencode` и уровень `low`; родителю он возвращает текст («шапка на 390 перекрывает…, кнопка 36 px…»).

**Что поменять.**
- Драйвер:
  - вторая модель провайдера с `modalities: { input: ["text","image"], output: ["text"] }`;
  - `attachment.image` с меньшими пределами (например 1440×2000 и ≤ 400 КБ Base64);
  - агент `look` и `task: { look: allow }`;
  - вторая труба ключа, если ключей два.
- `llm`:
  - политика тела принимает `image_url` с data URL `png|jpeg`, не больше N штук и M байт;
  - оценка токенов через `imagePaths` (до 8 000 на картинку);
  - модель запроса сверяется с парой «модель хода + модель зрения» профиля либо со своим ключом.
- `core`: выдача второго ключа или профиля `glm-5.3-flash-*`, сиды профилей, ставка `billing:rates` с подтверждением владельца (П3).
- Стенды: синтетический Z.ai `fake-zai.mjs` принимает картинки, живая проверка `--live` на синтетической картинке (как в `docs/spec.md:3282`).
- Инструкции хода: убрать «рисуешь вслепую» только для хода, где зрение включено.

**Правила.**
- **1.** Модель — GLM на Z.ai, путь тот же. Новое — пиксели: у агента и так есть HTML, но загруженные клиентом фото внутри макета уходят Z.ai картинкой. Гейт 152-ФЗ тот же, что для хода. Решение «пиксели модели» (N22) — за владельцем и юристом.
- **2.** Ключ провайдера остаётся в `llm`. Сервер Vision MCP Z.ai не нужен.
- **5.** Сеть не нужна. Память ~+300 МиБ на секунды в пределах 4 ГиБ. Снимок сессии растёт (§3.4).
- **Условия плана.** Вызов идёт из OpenCode — та же позиция, что сейчас.

**Кредиты.**
- A2: **≈ 0,08 кредита** за проверку при `low` и **≈ 0,26** при `max` с 4 полосами и 2 кругами, плюс ~0,04 за текст вердикта в главном контексте.
- На плане: 7,4 / 23,3 кредита плана. Это 0,37 % / 1,2 % окна 5 ч «Lite», 0,06 % / 0,19 % «Pro».
- A1: картинка в главном контексте Flash стоит меньше 0,01 кредита. Весь ход на Flash дешевле в ~9 раз: типовой ход 3,37 → 0,38 кредита.

**Задержка.**
- Рендер 2–5 с (оценка).
- A2 при `low`: 20–60 с (оценка; 1–3 тыс. токенов выхода при 56 ток/с, первый токен — не подтверждено).
- При `max` — до 2–2,5 мин [AA].
- A1 почти не добавляет к ходу: картинку читает модель, которая и так работает.

**Что теряем.**
- Точность вида: нет ассетов артефакта и CSP показа, шрифты — только через прокси.
- Риск «выглядит хорошо» от модели: проверка зрением — суждение, не измерение.
- A1 — слабее в коде: Z.ai Code Bench при `max` — 29,0 у Flash против 34,5 у GLM-5.3 [Z2, Z3]. Прогоны разные: у Flash — v1.0 на Claude Code 2.1.207. Сравнимость не подтверждена.
- A1 копит картинки в теле запросов (16 МиБ, в 1.18.34 нет предела в 25 МиБ) и в снимке сессии.

### B. Рендер на стороне платформы (`apps/browser`) → картинка или отчёт агенту инструментом MCP

**Как.**
- Инструмент `artifact_look` (`mcp` → `apps/browser`) рендерит сохранённый кадр в эфемерном контексте без сети: `page.setContent()`, ассеты `/_blob/…` подставляются перехватом запросов из S3, CSP показа повторяется. Агент получает:
  - **B1** — JPEG как `content: [{type:"image"}]`. OpenCode отдаёт его зрячей модели (A1 или A2), иначе подставит «ERROR: Cannot read image…».
  - **B2** — текстовый отчёт C (ниже). В черновике плана это была вторая очередь Ар26 (`docs/plan/88-artifacts.md (черновик назывался 87-artifacts.md):421-425`). Сейчас файл — `docs/plan/88-artifacts.md`, решение — Ар32, строки 527–533.
  - **B3** — `llm` сам зовёт GLM-5.3-Flash и возвращает вердикт текстом. **На плане нельзя**: «directly invoking model APIs from your own applications» [Z11]. Только на `zai-api` со своим ключом API и балансом (поправка к П83). Для `mcp` нужен новый доверенный путь в `llm`: сейчас роль принимает только ключ хода и UA CLI.

**Правила.**
- **1.** B1 и B3 — как A по пикселям. B2 ничего нового Z.ai не отдаёт.
- **2.** Ключ только в `llm`, в том числе для B3.
- **5.** Песочница не меняется.
- **8.** «Зрячесть» — свойство профиля или возможность драйвера, без `if (model === …)`.

**Кредиты.**
- B1 — как A1/A2.
- B2 — как C.
- B3 — те же ≈ 0,08–0,26 кредита. Деньги Z.ai: ≈ $0.005–0.014 (0,4–1,2 ₽) за проверку с баланса API.

**Задержка.** Рендер 3–8 с (оценка; новый контекст Chromium в живом процессе `browser`), плюс вызов модели у B1 и B3.

**Что теряем.**
- Объём работы: новый путь рендера в `apps/browser`, новый инструмент `mcp`, пределы ответа.
- Ёмкость: до 8 сессий на процесс и пространство.
- Плюс B перед A — рендер того, что видит клиент.

### C. Текстовые проверки, на которые может опереться текстовая модель

Проверки идут скриптом: в песочнице по A-рендеру или в `apps/browser` по B2. Модель — нынешняя GLM-5.3.

| Что | Инструмент (лицензия) | Что получает агент |
|---|---|---|
| Горизонтальная прокрутка на 390 | Playwright `page.setViewportSize` + `page.evaluate` (Apache-2.0) [P3] | `documentElement.scrollWidth` против `innerWidth` и виновные элементы (правый край > ширины) |
| Коробки элементов | Playwright `locator.boundingBox()`; CDP `DOMSnapshot.captureSnapshot` — раскладка и стили всех узлов одним вызовом [P4] | JSON: селектор, x, y, w, h; наложение текстовых блоков; выход за рамку артборда `w×h` |
| Переполнение и обрезка | `el.scrollWidth > el.clientWidth` при `overflow:hidden` или `text-overflow` (свой JS) | «Текст кнопки "Записаться" обрезан на 390: 212 px > 180 px» |
| Размер шрифта и строки | `getComputedStyle` | шрифт < 12 px; на телефоне < 14 px; строка > ~90 знаков |
| Контраст | axe-core 4.14.1 `color-contrast`, WCAG 2 AA 4.5:1 и 3:1 (MPL-2.0) [X1] | нарушения с селекторами и цветами; фон-картинка или градиент — в `incomplete` («проверить глазами») |
| Касание | axe `target-size`, WCAG 2.2 2.5.8, 24×24 CSS px; выключено по умолчанию — включать явно [X1]; свой порог 44×44, как в правилах Claude Design | список мелких целей |
| Доступность разметки | axe `meta-viewport`, `image-alt`, `button-name`, `link-name`, `heading-order`, `region`; `@axe-core/playwright` (MPL-2.0) [X2] | нарушения |
| Дерево для текста | Playwright `locator.ariaSnapshot()` (YAML) [P5] | структура кадра как текст, тот же вид данных, что `web_observe` |
| Валидность HTML | html-validate 11.21.1 (MIT) | ошибки разметки офлайн |
| Сравнение с прошлой ревизией | pixelmatch (ISC); agent-browser `diff screenshot` — доля несовпавших пикселей и картинка разницы; `diff snapshot` — построчный дифф дерева доступности (Apache-2.0) [X4] | «Изменилось 12 % кадра; новая область x=…» — проверка, что правка не задела соседей |
| Картинки | `img.naturalWidth === 0` (битая); показ > 1,5 × исходного размера (размыта) | список |
| Тяжелее и с повторами | Lighthouse (Apache-2.0); pa11y (LGPL-3.0) | не нужны: дублируют axe, тяжёлые, у pa11y лицензия LGPL |

**Правила.**
- **1.** Новых данных модели нет: отчёт выведен из того, что модель уже видела.
- **2** и **5.** Без изменений: в песочнице — тот же Chromium; в `apps/browser` — сессия платформы.
- В образе нет axe-core. Его нужно добавить в lock-файл `packages/agent-drivers/cli` или ставить из npm через прокси (сеть, медленно).

**Кредиты.**
- Отчёт ≤ 1 тыс. токенов в контексте GLM-5.3 с 10 повторами в кэше ≈ 0,44 ₽ ≈ **0,07 кредита**; 3 тыс. токенов ≈ **0,22**.
- Вывод: отчёт должен быть коротким — только нарушения, селектор и число. Длинный отчёт в дорогом главном контексте стоит больше, чем проверка зрением у дешёвого подагента.

**Задержка.** 2–6 с (оценка), вызова модели нет.

**Что теряем.** Вкус и композицию, равновесие и иерархию. Качество кадрирования фото и подходит ли фото по смыслу. Сходство с брендом и брифом. Всё, что не сводится к правилу. Контраст на фото и градиентах — только «проверить».

### 4.x Общие правила для любого пути (предложение)

- PNG и JPEG проверки — в `/tmp/opencode`, никогда в `/workspace/out`: оттуда файлы уходят клиенту (`turn-instructions.ts:126-133`).
- JPEG, а не PNG. Кадр ≤ 1440 px по ширине, полосы ≤ 2000 px. Не больше 4 картинок на проверку и 3 проверок на ход. Так держатся пределы тела (16 МиБ) и снимка сессии (16 МиБ архив, 32 МиБ файл).
- Сначала C (дёшево и быстро). Зрение — если C чист или клиент попросил «посмотри, как выглядит».
- Проверка зрением — суждение. Вердикт подагента идёт в ход как материал, а не как «проверено»: клиенту не обещаем «проверил, всё хорошо».

---

## 5. Петли конкурентов (только новое к r1 и r5)

- **v0.** «Browser use: v0 can open the apps it builds, use them, critique designs, debug complex flows, and fix things proactively. While it works, v0 sends you screenshots of what it sees» (страница «Agentic features», lastUpdated 2026-11-18) [V1].
  - Пользователь форума 24.08.2026: модель «preview[ed] its work visually with the agent-browser skill… a handful of screenshots… which the model would digest and use as feedback» [V2].
  - В 2025 году просили отключить вызов «screenshot» на предпросмотре, потому что он не работал (16.08.2025) [V3].
- **Lovable.** «Browser testing… verify real user behavior with screenshots instead of relying on code alone».
  - Запускается «selectively, after trying faster verification methods first»: по словам «verify it works», когда логов и кода мало, или при большой правке после согласия.
  - «Browser testing is slower»; совет: «build first, then test in a follow-up prompt» [L1].
- **Replit.**
  - Агент: «App Testing… Agent will periodically decide to test itself when it thinks enough has changed… doesn't test after 100% of user messages». Только Power и Max; есть видео-повтор и «Begin take over» для входа [R1].
  - Для кадров Replit Design своей проверки по снимку в документации не нашёл (не подтверждено). Известно только, что выбранный кадр прикладывается снимком (r5).
- **Claude Design.** `SKILL.md` типа Design, выпуск `1795091701-efb7`, прочитан 19.11.2026:
  - «**NEVER VERIFY UNLESS THE USER ASKED**, mid-run or after. Do NOT read it or your files back to check, re-check layout or sizes, render, screenshot or open it (no Playwright, browser, installs)… Need one? ASK first, and wait» [F].
  - Вместо проверки — правила в тексте: «Touch targets ≥44px», «Text 4.5:1… 4.3:1 still fails», «PAGEs work at phone width». Плюс правка человека: ручная правка отклоняет публикацию поверх неё.
  - Справка: «checks its own output against your design system, and makes corrections before you see them» [S3]. Как именно — не описано (не подтверждено).
- **Figma MCP `get_screenshot`.** «Takes a screenshot of your selection so your agent can see the design. This helps the generated code match the layout more closely. Screenshots use more tokens, so leave this on unless you're concerned about token limits» [FG1]. Снимок — образец для кода, а не проверка своей работы.
- **tldraw agent.** В контекст каждого запроса — «A screenshot of the agent's current view» и упрощённые фигуры. Агент может «Move its viewport» и «Schedule further work and reviews to be carried out in follow-up requests»: например, `schedule` в режим `reviewing` с «Review the new area thoroughly for any mistakes». Цикл «сделал → новый снимок → разбор» [T1].
- **Canva MCP.** `get-design-thumbnail` — в группе «Editing transactions», 100 запросов/мин [C1].
  - «Get the thumbnail for a particular page of the design in the specified editing transaction… IMPORTANT: ALWAYS ALWAYS ALWAYS show the preview to the user of EACH thumbnail» (описание инструмента в зеркале [C2]). Миниатюра предназначена человеку до `commit`.
  - Получает ли модель пиксели или ссылку, не подтверждено. У `generate-design` в ответе есть «preview thumbnail and url» кандидатов [C2].
- **Z.ai сам о себе.** Для Office и интерфейсов: «proactively identify issues such as overflow, misalignment, overlapping elements… through rendering and visual inspection». Рецепт: «launch the project and compare screenshots of each page against the reference images» [Z3].

---

## 6. Решения владельца об изображениях и вопрос владельцу

### 6.1 Что уже решено (цитаты)

- `docs/spec.md:3282` — **«Фото в чате»**:
  - «Картинку модель не видит: `glm-5.3` получает только текст хода… OpenCode передаёт его модели как путь, а не как изображение».
  - «…нужна модель с распознаванием изображений и путь картинки к ней, не выпуская ключ из роли `llm` (правило 2): профиль модели Z.ai с изображениями (семейство GLM-V) у провайдера `zai-coding` — проверить, отвечает ли она на пути плана, и записать её ставку; передача вложений-изображений ходу как изображений (`opencode run --file`, у модели в настройках драйвера — вход `image`), с тем же ограничением тела запроса `sandbox-gw` и роли (16 МиБ); живая проверка `--live` на синтетической картинке. Сервер Vision MCP от Z.ai (`@z_ai/mcp-server`) в песочницу не ставится: ему нужен ключ плана. Не сделано — ждёт владельца: выбор модели и её стоимость».
- `docs/spec.md:3287`: «Ждут владельца: модель с распознаванием изображений для фото в чате и её ставка…».
- `docs/spec.md:3289`, ответ владельца от 06.11.2026: «**фото отложим**»; `docs/spec.md:3293`: «**Фото в чате** — отложено (ответ владельца)».
- `docs/spec.md:2618`, N22: «Отдавать ли модели само изображение страницы: на нём могут быть имена и контакты, которых маскирование текста не скроет. По умолчанию — нет… Ждёт владельца и юриста». Довод о маскировании ослаблен ДС3 от 09.11.2026: тексты `web_*` идут без маскирования контактов (`docs/spec.md:3581`).
- `docs/plan/57-browser-tasks.md:40`, Б20, источник «Владелец»: «Произвольного `evaluate`, cookies, скриншотов модели нет». Повтор в `docs/spec.md:845`: «пиксели видит только клиент».
- `docs/spec.md:3704`, Р21: «пиксели скриншотов модели не отдаются (N22)».
- `docs/spec.md:3565`, РА3: ход с браузером платформы не получает навык Playwright. Источник — «Запрос владельца; значение по умолчанию».
- Черновик плана артефактов:
  - при чтении — `docs/plan/88-artifacts.md (черновик назывался 87-artifacts.md):421-425`, Ар26: «Модель не видит картинок… вопрос отложен владельцем. Как держим: шаблоны… булавки… во второй очереди — текстовый отчёт вёрстки кадра из `apps/browser`»;
  - к концу работы файл стал `docs/plan/88-artifacts.md`, решение — Ар32 «Агент не видит картинок — пока» (строки 527–533), со ссылкой на этот отчёт.

### 6.2 Вопрос владельцу (отдельно)

**Дать ли агенту зрение, чтобы он проверял свои макеты, холсты и картинки артефактов?** Тот же механизм закроет и «Фото в чате».

- **Значение по умолчанию: пока нет.**
  - Ответ «фото отложим» и N22 действуют.
  - Сразу делаем C: короткий текстовый отчёт вёрстки, сначала в `apps/browser` по сохранённому кадру (B2), для черновика — в песочнице.
  - Цена — ≈ 0,07–0,2 кредита и 2–6 с за проверку; правила 1, 2 и 5 не меняются.
- **Если «да» — по умолчанию A2.**
  - Подагент `look` на `glm-5.3-flash` по плану, уровень `low`, только `read` в `/tmp/opencode`. Главная модель хода остаётся `glm-5.3`.
  - Проверка — сама один раз в конце хода холста или по просьбе клиента; не больше 3 за ход и 4 картинок за проверку.
  - Позже — B1 для точного вида клиента.
  - **Стоимость**:
    - ≈ 0,08 кредита за проверку при `low`, до ≈ 0,26 при тяжёлой;
    - 7–23 кредита плана Z.ai (0,4–1,2 % окна 5 ч «Lite»);
    - +25–70 с вместе с рендером, до 2–2,5 мин при `max`;
    - ставка `glm-5.3-flash` по П3 — 16,306 / 3,261 / 54,352 ₽ за 1M, утверждает владелец;
    - работа: драйвер, политика тела `llm`, второй ключ или профиль, сиды, стенды, живая проверка на синтетике.
  - Включение — после живой проверки, что адрес плана принимает `image_url` у `glm-5.3-flash` и 1.18.34 доносит картинку (§2.6).

---

## Таблица вариантов

| Вариант | Что видит агент | Правила 1 / 2 / 5 | Что менять | Кредитов за проверку | Задержка | Что теряем |
|---|---|---|---|---|---|---|
| **C в песочнице** | Текст: нарушения вёрстки по рендеру черновика | 1 — нового нет; 2 — да; 5 — Chromium из `bash`, ~+300 МиБ на секунды | Скрипт и axe-core в образе; инструкции | ≈ 0,07–0,22 | 2–6 с | Вкус и композицию; вид ≠ клиентскому (ассеты, CSP, шрифты) |
| **C в `apps/browser` (B2)** | Текст по сохранённому кадру, как у клиента | 1 — нового нет; 2 — да; 5 — без изменений | Рендер в `apps/browser`, инструмент `mcp` | ≈ 0,07–0,22 | 3–8 с | Вкус и композицию |
| **A1: Flash — главная модель холстов** | Картинки сам (`read`) | 1 — пиксели к Z.ai, решение N22; 2 — да; 5 — рендер в песочнице | Модель с `modalities`, политика тела, профили и ставка, выбор модели по требованиям хода | < 0,01 на картинку; ход ~в 9 раз дешевле | +0–5 с на взгляд | Сила в коде (Code Bench 29,0 против 34,5); тело запроса и снимок пухнут |
| **A2: подагент Flash (рекомендую при «да»)** | Текст вердикта; картинки только в сессии подагента | 1 — пиксели к Z.ai, решение N22; 2 — да; 5 — рендер в песочнице | То же, что A1, + агент `look`, `task: look`, второй ключ или пара моделей, профиль `low` | ≈ 0,08 (`low`) … 0,26 | 25–70 с с рендером (`low`); до 2–2,5 мин (`max`) | Вид ≠ клиентскому; суждение модели; снимок сессии растёт |
| **B1: рендер `apps/browser` → картинка по MCP** | Картинка точно как у клиента; потребитель — A1/A2 | 1 — пиксели к Z.ai; 2 — да; 5 — без изменений | A2 + рендер в `apps/browser` + `image` в ответе `mcp` | как A2 | 25–70 с | Объём работы; ёмкость `browser` |
| **B3: платформа сама зовёт Flash** | Текст вердикта | 1 — да, только на `zai-api`; 2 — да, новый доверенный путь в `llm`; 5 — без изменений | Ключ API с балансом, путь `mcp`→`llm`, порт проверки | ≈ 0,08–0,26 (Z.ai: $0.005–0.014) | 25–70 с | На плане нельзя по условиям [Z11] |
| **Vision MCP Z.ai в песочнице** | Текст от Z.ai | 2 — **нарушено**: ключ плана в песочнице | — | — | — | Исключено |

---

## Вопросы владельцу (со значениями по умолчанию)

1. **Зрение для проверки своих макетов** (и «Фото в чате»). По умолчанию — нет до ответа, делаем C. При «да» — A2, цена из §6.2.
2. **Модель зрения.** По умолчанию — GLM-5.3-Flash по плану. Она есть у всех уровней, ×3 квоты, дешевле GLM-5.3 в ~9 раз.
   - GLM-5V-Turbo и GLM-4.6V в список моделей плана не входят. GLM-5V-Turbo нет и в прайсе Z.ai.
   - Ставку по П3 утверждает владелец: 16,306 / 3,261 / 54,352 ₽ за 1M.
3. **Пиксели клиентских фото внутри макета к Z.ai** (N22 для артефактов). По умолчанию — только там, где ход и так получает данные клиента: по гейту 152-ФЗ, класс `client` только с записью `cross_border_clearances`. Вопрос юристу — вместе с П1 и П91.
4. **Когда проверять.** По умолчанию:
   - C — всегда после записи кадра;
   - зрение — один раз в конце хода холста или по просьбе клиента;
   - не больше 3 проверок за ход и 4 картинок за проверку.
   - У Claude Design по умолчанию «никогда без просьбы», у Lovable — «выборочно, после быстрых проверок».
5. **Где рендерить.** По умолчанию — `apps/browser`, по сохранённому кадру (вид клиента). Песочница — только для черновика до записи. РА3 не запрещает Chromium из `bash`, но его довод о памяти учитываем.
6. **Вызовы модели не из OpenCode.** По умолчанию — нет на плане. Вариант B3 — только на `zai-api` со своим ключом и балансом.

---

## Источники

**Z.ai** (прочитаны 19.11.2026; даты страниц, где они есть):
- [Z1] https://docs.z.ai/guides/overview/pricing — даты на странице нет
- [Z2] https://docs.z.ai/guides/llm/glm-5.3 — «text-only inputs», 1M / 128K, Code Bench
- [Z3] https://docs.z.ai/guides/vlm/glm-5.3-flash — модальности, план ×3, FlashX нет на плане, `image_url`, self-visual judgment
- [Z4] https://docs.z.ai/guides/vlm/glm-5v-turbo
- [Z5] https://docs.z.ai/release-notes/new-released — записи 30.09.2025 … 26.08.2026
- [Z6] https://docs.z.ai/devpack/overview — модели плана, окна, формула, множители
- [Z7] https://docs.z.ai/api-reference/llm/chat-completion — `ChatCompletionVisionRequest`, пределы картинок, `tool` — строка
- [Z8] https://docs.z.ai/devpack/latest-model — Cline: «GLM-5.3 is a text-only model… GLM-5.3-FLASH is a multimodal model»
- [Z9] https://docs.z.ai/devpack/mcp/vision-mcp-server; https://docs.z.ai/devpack/faq
- [Z10] https://docs.z.ai/legal-agreement/terms-of-use — Last Update April 14, 2026
- [Z11] https://docs.z.ai/legal-agreement/subscription-terms, §4; https://docs.z.ai/devpack/usage-policy
- [Z12] https://docs.z.ai/guides/vlm/glm-4.6v
- [Z13] https://docs.z.ai/guides/vlm/glm-ocr
- [Z14] https://docs.z.ai/devpack/tool/others; https://docs.z.ai/devpack/tool/opencode
- https://docs.z.ai/devpack/notice/usage-revision — 30.07.2026, переход плана на кредиты
- Пакет `@z_ai/mcp-server` 0.1.6 (29.10.2026, Apache-2.0): https://registry.npmjs.org/@z_ai/mcp-server — код прочитан, не запускался

**Hugging Face и каталоги:**
- [H1] https://huggingface.co/zai-org/GLM-5.3-Flash/raw/main/processor_config.json
- [H2] https://huggingface.co/zai-org/GLM-5.3-Flash — README, MIT; репозиторий создан 25.08.2026 по API HF
- [H3] https://huggingface.co/api/models/zai-org/GLM-4.5V (создан 10.08.2025), …/GLM-4.6V (07.12.2025), …/GLM-OCR (30.01.2026)
- https://huggingface.co/docs/transformers/en/model_doc/glm46v — `patch_size` 14, `merge_size` 2
- [M1] https://github.com/anomalyco/models.dev — `models/zhipuai/glm-5.3-flash.toml`, `models/zhipuai/glm-5.3.toml`, `providers/zai*/models/glm-5.3*.toml`; источники в файлах датированы 19.10.2026
- [M2] https://github.com/anomalyco/models.dev/pull/10162 — 16.10.2026, DigitalOcean `glm-5.3-flash` только текст
- [AA] https://artificialanalysis.ai/models/glm-5-3-flash — 56 ток/с, первый токен ответа 90,16 с на API Z.ai; даты замера нет
- [S-VG] https://vercel.com/ai-gateway/models/zai/glm-5v-turbo — $1.20 / $4.00, 200K
- [S-MT] https://www.marktechpost.com/2026/04/01/z-ai-launches-glm-5v-turbo-a-native-multimodal-vision-coding-model-optimized-for-openclaw-and-high-capacity-agentic-engineering-workflows-everywhere/ — вторичный, дата выхода
- [S-OR] https://openrouter.ai/z-ai/glm-4.6v — вторичный, 08.12.2025

**OpenCode:**
- Исходники тега `v1.18.34` (выпуск 30.09.2026, коммит `aec0b9a6…`): https://github.com/anomalyco/opencode/tree/aec0b9a6d8898f68f923aaf08b7306d931fd9d76
  - [O3] `packages/opencode/src/tool/read.ts`
  - [O4] `packages/opencode/src/session/tools.ts`, `session/processor.ts`
  - [O5] `packages/opencode/src/session/message-v2.ts`
  - [O6] `packages/opencode/src/provider/transform.ts`, `provider/provider.ts`, `packages/core/src/v1/config/provider.ts`
  - также `cli/cmd/run.ts`, `session/prompt.ts`, `tool/task.ts`, `tool/shell.ts`, `image/image.ts`
- [O1] https://opencode.ai/docs/models/ — V2: `capabilities.input`, значения по умолчанию
- [O2] https://opencode.ai/v1/docs/config/ — V1: `attachment.image`
- [O7] https://opencode.ai/changelog — v2.3.2 от 18.11.2026, v1.19.6 от 17.11.2026; https://github.com/anomalyco/opencode/releases
- [O8] https://opencode.ai/docs/attachments/ — V2
- [O9] https://github.com/anomalyco/opencode/issues/15728, /issues/20802, /pull/21627, /pull/23501, /pull/26825, /pull/26826, /pull/15788 — состояние по API GitHub на 19.11.2026
- [A1] https://github.com/vercel/ai/blob/main/packages/openai-compatible/src/chat/convert-to-openai-compatible-chat-messages.ts

**Playwright, Chromium, проверки:**
- [P1] https://github.com/microsoft/playwright-mcp — README: `--image-responses`, `--caps`; Apache-2.0
- [P2] https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/chromiumSwitches.ts — `--disable-dev-shm-usage`
- [P3] https://playwright.dev/docs/api/class-page; https://playwright.dev/docs/api/class-locator
- [P4] https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/
- [P5] https://playwright.dev/docs/aria-snapshots
- https://developer.chrome.com/docs/automation-and-testing/headless-cli — `--screenshot`, `--window-size`, `--timeout`; https://developer.chrome.com/docs/chromium/headless
- [X1] https://github.com/dequelabs/axe-core — MPL-2.0; `doc/rule-descriptions.md`, 4.14.1 в npm; правила WCAG 2.2 выключены по умолчанию
- [X2] https://github.com/dequelabs/axe-core-npm — MPL-2.0, пакет `@axe-core/playwright`
- [X3] https://github.com/GoogleChrome/lighthouse (Apache-2.0); https://github.com/pa11y/pa11y (LGPL-3.0); html-validate 11.21.1 (MIT, npm); https://github.com/mapbox/pixelmatch (ISC); https://github.com/garris/BackstopJS (MIT)
- [X4] https://github.com/vercel-labs/agent-browser — Apache-2.0; https://agent-browser.dev/diffing
- https://www.w3.org/TR/WCAG22/

**Конкуренты:**
- [V1] https://v0.app/docs/agentic-features — lastUpdated 2026-11-18
- [V2] https://community.vercel.com/t/v0-unable-to-preview-its-own-work-in-sandbox/48292 — 24.08.2026, пользователь
- [V3] https://community.vercel.com/t/disable-screenshot-function-calling-for-preview-site/19053 — 16.08.2025
- [L1] https://docs.lovable.dev/features/browser-testing
- [R1] https://docs.replit.com/core-concepts/agent/app-testing
- [F] Тип Artifact «Design» (core), выпуск `1795091701-efb7`, `SKILL.md` — прочитан инструментом Artifact 19.11.2026
- [S3] https://support.claude.com/en/articles/14604416-get-started-with-claude-design — копия r1 от 19.11.2026
- [FG1] https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/
- [T1] https://tldraw.dev/starter-kits/agent
- [C1] https://www.canva.dev/docs/mcp/tools/
- [C2] https://docs.composio.dev/toolkits/canva_mcp — зеркало описаний инструментов Canva MCP, сторонний

**Репозиторий** (дерево `feat/artifacts`, b1349f3b): все пути с номерами строк приведены в §3. Ключевые:
- `packages/agent-drivers/src/opencode.ts`
- `packages/llm-backends/src/zai-coding/body.ts`, `backend.ts`
- `packages/domain/src/llm/json-policy.ts`
- `apps/llm/src/gateway/server.ts`
- `packages/domain/src/browser/tools.ts`, `session.ts`
- `apps/browser/src/sessions/worker-session.ts`, `apps/browser/src/attachments/screenshots.ts`
- `infra/sandbox/Dockerfile`
- `packages/sandbox-providers/src/docker.ts`
- `packages/domain/src/agent/skills.ts`
- `apps/core/src/tasks/turn-instructions.ts`
- `docs/spec.md` (2618, 3282–3293, 3565, 3704)
- `docs/plan/57-browser-tasks.md:40`
- `docs/plan/88-artifacts.md:527-533` (прежде — `87-artifacts.md:421-425`)
