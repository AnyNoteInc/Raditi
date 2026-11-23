# s2. Шрифты и скрипты платформы в непрозрачной рамке (19.11.2026)

Спайк 2 этапа Э0а плана 88 «Артефакты» (`docs/plan/88-artifacts.md`, §10, Э0а п. 2), нужен Э5 (срез 88.12). Проверяет решения Ар12, Ар28, Ар30 и §7.13 «Ловушки CSP». Код продукта не менялся. Стенд повторяет заголовки репозитория байт в байт: дерево `feat/artifacts`, коммит `b1349f3b`. Рабочий каталог стенда ниже называется `<scratch>`.

Обозначения: C — Chromium 153, F — Firefox 155, W — WebKit 26.6; ✓ — загрузилось и применилось; ✗ CSP — запрос не ушёл, его закрыла политика; ✗ CORS — ответ пришёл, браузер отказал по CORS; ✗ CORP — ответ пришёл, браузер отказал по `Cross-Origin-Resource-Policy`.

---

## Вопрос

**А.** Рамка кабинета `/v/<token>` живёт на корне домена страниц, у неё `sandbox` без `allow-same-origin`, её origin — непрозрачный `"null"`. Грузятся ли в неё с отдельного пути платформы на том же хосте (`/v/<метка>.<хеш>`):
- шрифт `@font-face` (woff2);
- классический `<script src>`;
- `<script type="module">` и модуль, который импортирует соседний модуль;
- для полноты — `<script crossorigin>`, `<link rel="stylesheet">` и картинка по адресу, похожему на подписанный.

Варианты: с `Access-Control-Allow-Origin: *` и без, с `Cross-Origin-Resource-Policy` `same-origin`, `same-site`, `cross-origin` и без него; в CSP — `'self'`, хост, точный путь, `https:`. Отдельно: совпадает ли `'self'` с origin адреса, когда сам документ непрозрачный. Движки — Chromium, WebKit, Firefox.

**Б.** Возможная ошибка в production. Опубликованная страница (план 69, `pagePolicy('html')` без `framedBy`) — песочница или нет? Грузится ли в неё шрифт из общих файлов сайта `/_files/` с теми заголовками, которые сегодня отдают `files.ts` и `pages-server.ts`?

---

## Коротко

**Ответ: А — да, Ар28 держится. Б — нет: шрифт из `/_files/` сегодня не грузится в Chromium и Firefox, это ошибка в production.**

1. **Рамка непрозрачна во всех трёх движках:** `self.origin === "null"`, сообщения в кабинет приходят с origin `"null"`, `document.cookie` бросает `SecurityError`. **`'self'` в CSP считается по адресу документа**, то есть это корень страниц: `'self'`, хост, точный путь каждого файла и префикс `/v/` работают одинаково в C, F и W.
2. **Нужны ровно два заголовка, как в Ар28:** `Access-Control-Allow-Origin: *` и `Cross-Origin-Resource-Policy: cross-origin`. Шрифты C и F просят CORS-запросом с `Origin: null` — без ACAO отказ. W просит шрифт без CORS, но тогда ему мешает CORP `same-origin` и `same-site`. Модули и `<script crossorigin>` везде идут CORS-запросом. Классические скрипты, стили и картинки идут без CORS: им мешает только CORP `same-origin` и `same-site`, потому что непрозрачная рамка всем чужой (`Sec-Fetch-Site: cross-site`). Все 5 096 ячеек непрозрачных рамок, где CSP пускает путь, легли в это правило без исключений; ещё 3 136 контрольных ячеек без песочницы загрузили всё — всего 8 232 (исправлено проверкой: прежде все 8 232 назывались ячейками этого правила).
3. **Кеш между рамками в Chromium не работает.** Каждая непрозрачная рамка — свой раздел HTTP-кеша: библиотека с `immutable` качается заново каждой рамкой и каждым открытием (3 запроса на 3 рамки, без песочницы — 1). W и F берут из кеша. Опубликованные страницы тоже непрозрачны: при каждом открытии C и F качают общие файлы `/_files/` заново (200 без `If-None-Match`), проверяет их (304) только W. Рамки артефактов в Chromium живут вне процесса кабинета: один общий процесс на все рамки корня страниц. Поэтому зациклившийся скрипт одного кадра в Chromium останавливает все остальные кадры, но не кабинет; в WebKit и в Firefox (и с Fission) кадры корня страниц живут в процессе кабинета, и такой скрипт подвешивает кабинет (исправлено проверкой: дописано, раздел «Проверка»).
4. **Б:** опубликованная страница — песочница (CSP `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox`), её origin тоже `"null"`. Шрифт из `/_files/` — и прямо, и из `/_files/style.css` — не грузится в C и F: у ответа нет ACAO. В W грузится. Модуль `.mjs` из `/_files/` не грузится нигде. CSS, классический скрипт и картинка работают. Исправление — `Access-Control-Allow-Origin: *` в `pageFileHeaders`: проверено во всех движках, публичным файлам ничего нового не открывает.
5. **Сайт с паролем хуже, и ACAO его не чинит.** CORS-запрос из непрозрачной страницы уходит без cookie, поэтому шрифты и модули получают 404 и с ACAO. В Firefox по умолчанию (Total Cookie Protection) и в Chromium с запретом сторонних cookie страница не получает cookie ни для одного файла: все `/_files/` — 404, сайт без стилей и картинок. Где сторонние cookie разрешены (Chromium по умолчанию), чужой сайт вставляет файлы закрытого сайта к себе и исполняет его скрипт. Надёжный путь — подписанные адреса файлов вместо cookie, как Ар12 делает для артефактов.
6. **Запасной путь есть:** шрифт `data:` и `new FontFace(name, bytes)` работают в сегодняшней политике рамки во всех движках, без расширения CSP.

---

## Как проверено

**Машина и браузеры.**
- macOS 27 (Darwin 27.0.0), arm64, 10 ядер. Docker Desktop: ВМ Linux 7.0.14-linuxkit, arm64.
- Сборки Playwright 1.63.0, из кеша, ничего не скачивалось:
  - Chromium 153.0.8010.12 — двумя способами: headless shell (`chromium.launch({ headless: true })`, сборка 1243) и полная сборка в новом headless (`channel: 'chromium'`, на Linux это Chrome for Testing);
  - WebKit 26.6 (сборка 2359);
  - Firefox 155.0 (сборка 1543).
- На macOS шли Chromium (обе сборки) и WebKit. Firefox на этой macOS не стартовал: «Could not find profile folder» и при запуске руками, с песочницей команды и без неё. Поэтому Firefox — только в контейнере `mcr.microsoft.com/playwright:v1.63.0-noble` (Linux arm64, Node 24.20.0). В контейнере ещё раз прошли все движки.
- Два варианта политики cookie, которые Playwright ослабляет:
  - `firefox-tcp` — Firefox с `network.cookie.cookieBehavior: 5`. Это Total Cookie Protection, умолчание настоящего Firefox. Сборка Playwright ставит 4 (`playwright.cfg` сборки: «Disable first-party-based cookie partitioning»), а при запуске — `cookieBehavior0` в `browser.contentblocking.features.standard`; ни 4, ни 0 cookie по сайтам не делят (исправлено проверкой: прежде — «Playwright ставит 0»).
  - `chromium-3pcb` — полный Chromium с управляемой политикой `{"BlockThirdPartyCookies": true}` в `/etc/opt/chrome_for_testing/policies/managed/` (только в контейнере). Ключ `--test-third-party-cookie-phaseout`, CDP `Network.setCookieControls` и настройка профиля `cookie_controls_mode: 2` сторонние cookie в этой сборке не закрыли: cookie всё равно уходила чужому сайту (`tpc-cdp-attempt.mjs`, `tpc-pref-attempt.mjs`).

**Пакеты** (точные версии — `package.json`): `playwright-core` 1.63.0, `@fontsource-variable/golos-text` 5.3.0 (каталог репозитория — `^5.3.0`). Шрифт — `golos-text-cyrillic-wght-normal.woff2`, 22 032 байта, сигнатура `wOF2`. Node 26.10.0 на macOS.

**Стенд** (`stand.mjs`) — один процесс Node, https (самоподписанный сертификат, `ignoreHTTPSErrors`) и http. Имена ведёт свой прокси, браузеры ходят только через него:
- `cabinet.spike.test` — кабинет;
- `pages.spike.test` — корень домена страниц;
- `s1…s5.pages.spike.test` — опубликованные сайты;
- `xsite.test` — чужой сайт.

Кабинет и страницы — один сайт, как `raditi.ru` и `pages.raditi.ru`. Прокси отказывает всем остальным именам. Полный Chromium в фоне просился к `clients2.google.com`, `update.googleapis.com`, `accounts.google.com`, `www.google.com` и `content-autofill.googleapis.com`, Firefox — к `aus5.mozilla.org`: всем отказано, наружу не ушло ничего.

**Заголовки — копии кода** (`headers.mjs`, у каждой константы — файл и строки):
- `packages/domain/src/pages/headers.ts:16-20, 27, 30, 33-38, 45-50, 58-75, 88-98, 101-109, 118-128`: политика страниц, `PAGE_SANDBOX`, `PAGE_PLATFORM_CSP`, `PAGE_COMMON_HEADERS`, `pageResponseHeaders`;
- `apps/web/src/server/page-response.ts:12-17, 20-29`: заголовки кадра `/v/` и короткие ответы;
- `apps/web/src/proxy.ts:36-44` и `apps/web/src/lib/pages-origin.ts:12`: корень страниц отвечает только `robots.txt` и GET/HEAD `/v/<token>` по `PAGES_PATHS`;
- `apps/web/src/lib/content-security-policy.ts:18-27` и `apps/web/next.config.ts:47-58, 98`: CSP кабинета и остальные его заголовки; `/v/` из `headers()` исключён;
- `packages/domain/src/pages/files.ts:33-48, 97-111`: типы и заголовки общих файлов;
- `apps/preview/src/pages/pages-server.ts:72-106, 271-290, 298-345, 362-437` и `page-cookie.ts:10-30`: страница, файл, 304, форма пароля, cookie `raditi_page`.

Политика рамки `c0` с `PAGE_SANDBOX` сверяется в коде стенда с `pagePolicy('html', кабинет)` строка в строку. HSTS кабинета не повторён: он идёт только при `NODE_ENV=production` и закрепил бы имена стенда за https для прохода по http.

**Что менялось** (`variants.mjs`):
- **Песочница рамки:** `art` — `ARTIFACT_SANDBOX = 'allow-scripts'` в атрибуте и в CSP (Ар28); `page` — сегодняшний `PAGE_SANDBOX`; `none` — без песочницы, контроль.
- **CSP рамки:**

  | | `script-src`, `style-src`, `img-src`, `font-src` получают |
  | --- | --- |
  | `c0` | ничего: сегодняшняя политика кадра (`data: blob:` и `'unsafe-inline'`) |
  | `c1` | `'self'` |
  | `c2` | хост `https://pages.spike.test` |
  | `c3` | точный адрес каждого файла: 64 адреса, заголовок 3 612 байт |
  | `c4` | `https:`, как у опубликованной страницы |
  | `c5` | префикс `https://pages.spike.test/v/` |

- **Заголовки ответа ресурса** — правила `/_files/` (Дер34: тип, `nosniff`, `sandbox`-CSP, `no-referrer`), меняются только CORP и ACAO, `Cache-Control: no-store`:

  | | CORP | ACAO |
  | --- | --- | --- |
  | `h1` | `cross-origin` | `*` (Ар28) |
  | `h2` | `cross-origin` | — (как `/_files/` сегодня) |
  | `h3` | `same-origin` | `*` |
  | `h4` | `same-origin` | — (как `PAGE_COMMON_HEADERS`) |
  | `h5` | — | `*` |
  | `h6` | — | — |
  | `h7` | `same-site` | `*` |
  | `h8` | `same-site` | — |

- **Пути ресурсов** — один сегмент `/v/<вид>-<hN>-<рамка>.a1b2c3d4`: их пропускает нынешний `PAGES_PATHS`. Модуль импортирует соседа относительным путём `./leaf-….a1b2c3d4`.
- **Схемы:** https (как production) и http (как dev, где `https:` в CSP не совпадает и всё держит `'self'`).

**Как измерено** (`probe.mjs`, встроенный скрипт в рамке и на странице):
- шрифт: `FontFace.status`, `document.fonts.check()` и ширина кириллической строки 32 px в этом семействе против `monospace`, а не только сетевые события;
- скрипты: флаг, который ставит каждый файл;
- стили: вычисленная ширина элемента, которую задаёт файл (37 px против 1 px);
- картинка: `naturalWidth` (3 px);
- события `securitypolicyviolation`.

Сервер пишет каждый запрос: `Origin`, `Sec-Fetch-Mode`, `-Dest`, `-Site`, есть ли cookie, `Referer`, `If-None-Match`. Тексты ошибок — из консоли и `requestfailed` Playwright.

**Объём.**
- 238 открытий кабинета с рамкой, 322 рамки: 34 на сборку, из них 6 — по три рамки подряд для кеша.
- 10 976 ячеек «вид × заголовки» (`check-pattern.mjs` сверил с правилом 8 232 ячейки, где CSP пускает путь: 5 096 непрозрачных рамок и 3 136 контрольных без песочницы, где ждётся «грузится всё» — исправлено проверкой).
- 61 проход опубликованных сайтов, 16 012 запросов к стенду: все GET, кроме 25 POST формы пароля. Ни одного `OPTIONS`: шрифты и модули — простые CORS-запросы без предварительного.
- Ошибок прогона — 0.

Время не измерялось. Загрузка: macOS 17:45–17:47, load average 8,4–12,0 (каждая сборка пишет свою в `meta`), внутри ВМ — 1–5; дополнительные проходы контейнера в 17:50–17:55 шли при load average хоста 10–68.

**Как повторить** (из `<scratch>`, куда скопирован этот каталог):

```sh
pnpm install && node make-cert.mjs
mkdir -p tmp   # без каталога TMPDIR=$PWD/tmp браузер не стартует: ENOENT в mkdtemp (исправлено проверкой)
node smoke.mjs https://pages.spike.test/v/font-h1-Fx.a1b2c3d4   # заголовки через прокси
TMPDIR=$PWD/tmp node run.mjs --platform macos --engines chromium-shell,chromium,webkit
TMPDIR=$PWD/tmp node run.mjs --platform macos --engines chromium,webkit --only-sites s5
IMG=mcr.microsoft.com/playwright:v1.63.0-noble
docker run --rm --name spike88-s2-linux --shm-size=1g -v "$PWD:/spike" -w /spike $IMG \
  node run.mjs --platform linux --engines chromium-shell,chromium,webkit,firefox,firefox-tcp
docker run --rm --name spike88-s2-linux --shm-size=1g -v "$PWD:/spike" -w /spike $IMG \
  node run.mjs --platform linux --engines chromium,webkit,firefox,firefox-tcp --only-sites s5
docker run --rm --name spike88-s2-linux --shm-size=1g -v "$PWD:/spike" -w /spike $IMG bash -c \
  'mkdir -p /etc/opt/chrome_for_testing/policies/managed &&
   echo "{\"BlockThirdPartyCookies\": true}" > /etc/opt/chrome_for_testing/policies/managed/spike.json &&
   node run.mjs --platform linux --engines chromium-3pcb &&
   node run.mjs --platform linux --engines chromium-3pcb --only-sites s5'
node report.mjs > raw-tables.md && node check-pattern.mjs && node process-debug.mjs
```

Полные таблицы прогона с текстами ошибок — `raw-tables.md` (собирает `report.mjs`).

---

## Результаты

### А1. Вид ресурса × заголовки ответа (рамка `allow-scripts`, CSP пускает путь)

Таблица одна для `c1`, `c2`, `c3`, `c5`, для `c4` по https, для https и http, для песочниц `art` и `page`. Сборки внутри семейства не расходятся: Chromium shell и полный, macOS и Linux — 4 704 сравнения, 0 различий; WebKit macOS и Linux — 1 568 и 0.

| Вид | h1 cross-origin + `*` | h2 cross-origin | h3 same-origin + `*` | h4 same-origin | h5 — + `*` | h6 — | h7 same-site + `*` | h8 same-site |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `@font-face` | ✓ | C F ✗ CORS, W ✓ | C F ✓, W ✗ CORP | C F ✗ CORS, W ✗ CORP | ✓ | C F ✗ CORS, W ✓ | C F ✓, W ✗ CORP | C F ✗ CORS, W ✗ CORP |
| `<script src>` | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| `<script src crossorigin>` | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| `<script type=module>` | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| модуль с `import './…'` | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| `<link rel=stylesheet>` | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| `<img>` | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |

Правило за таблицей. Вид, который браузер просит CORS-запросом (шрифт в C и F, модули, `crossorigin`), грузится тогда и только тогда, когда есть ACAO. Вид без CORS (классический скрипт, стиль, картинка, шрифт в W) грузится тогда и только тогда, когда CORP не `same-origin` и не `same-site`. Единственный столбец, где ✓ везде, — h1 и h5.

### А2. CSP рамки × вид (заголовки h1)

| CSP | шрифт | скрипт | `crossorigin` | модуль | модуль с `import` | стиль | картинка | шрифт `data:` | `FontFace` из байтов | нарушений CSP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `c0` сегодня | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 (F — 64 события) |
| `c1` `'self'` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| `c2` хост | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| `c3` точные пути | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| `c4` `https:`, по https | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| `c4` `https:`, по http | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 (F — 64) |
| `c5` префикс `/v/` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |

Одинаково в C, F и W. При `c0` ни один запрос до сервера не доходит. `'self'` в непрозрачном документе совпадает с хостом адреса документа во всех трёх движках — и по https, и по http. С заголовками h2 (как `/_files/` сегодня) в любой разрешающей CSP шрифт в C и F и все модули получают ✗ CORS (`raw-tables.md`, A2 h2).

### А3. Контроль: без песочницы и `PAGE_SANDBOX`

| Песочница | Что загрузилось при `c1`–`c5` |
| --- | --- |
| `none` (без `sandbox`) | 56 из 56 в каждой ячейке и каждом движке, в том числе с CORP `same-origin` и без ACAO: запросы своего origin |
| `page` (`PAGE_SANDBOX`) | то же, что `art`: 0 различий ни в одной ячейке (по https; по http `page` не гонялся) |
| `art` (`allow-scripts`) | таблица А1 |

Значит, мешает именно непрозрачный origin, а всплывающие окна песочницы на загрузку не влияют.

### А4. Что видит сервер (https, `art`, `c1`)

| Движок | шрифт: режим / `Origin` | модуль | классический скрипт | `Sec-Fetch-Site` ресурсов |
| --- | --- | --- | --- | --- |
| Chromium | `cors` / `"null"` | `cors` / `"null"` | `no-cors` / нет | `cross-site` |
| Firefox | `cors` / `"null"` | `cors` / `"null"` | `no-cors` / `"null"` | `cross-site` |
| WebKit | `no-cors` / нет | `cors` / `"null"` | `no-cors` / нет | `cross-site` |

У всех движков `self.origin` — `null`, origin сообщения в кабинет — `"null"`, `document.cookie` бросает `SecurityError`. Заголовки `Sec-Fetch-*` браузеры шлют только по https. Без песочницы те же запросы идут с `same-origin`.

### А5. Тексты ошибок (по одному на движок и класс)

| Класс | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| CSP | `Loading the font '<url>' violates the following Content Security Policy directive: "font-src data: blob:". The action has been blocked.` | `Content-Security-Policy: The page’s settings blocked the loading of a resource (font-src) at <url> because it violates the following directive: “font-src data: blob:”` | `Refused to load <url> because it does not appear in the font-src directive of the Content Security Policy.` |
| CORS | `Access to font at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.` и `net::ERR_FAILED` | `Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at <url>. (Reason: CORS header ‘Access-Control-Allow-Origin’ missing). Status code: 200.` и `downloadable font: download failed (…): bad URI or cross-site access not allowed` | (модуль) `Origin null is not allowed by Access-Control-Allow-Origin. Status code: 200` |
| CORP | `Failed to load resource: net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` (для `same-site` — `…NotSameSite`), без адреса и без слова CORP | `The resource at “<url>” was blocked due to its Cross-Origin-Resource-Policy header (or lack thereof).` | `Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header.` |

### А6. Шрифт действительно применился

| Сборка | Golos с хоста (h1, `c1`) | `monospace` | `data:` | `FontFace` из байтов |
| --- | --- | --- | --- | --- |
| Chromium, macOS | 979,53 px | 953,64 px | 979,53 | 979,53 |
| WebKit, macOS | 979,59 px | 1 078,88 px | 979,59 | 979,59 |
| Chromium полный, Linux | 976,33 px | 1 018,88 px | 976,33 | 976,33 |
| Firefox, Linux | 976,37 px | 1 018,90 px | 976,37 | 976,37 |

Ширина строки «Съешь же ещё этих мягких французских булок, да выпей чаю» в 32 px. Загруженный файл, `data:` и байты дают одну ширину. У отказавшего шрифта ширина ровно как у `monospace`, `FontFace.status` — `error`, `document.fonts.load()` отклоняется с `NetworkError`. А вот `document.fonts.check()` в WebKit для отказавшего шрифта отвечает `true` (в C и F — `false`). Стенду `verify:artifacts` верить можно ширине и `FontFace.status`, а не `check()`.

### А7. Кеш и процессы

**Библиотека с `Cache-Control: public, max-age=31536000, immutable` в трёх рамках подряд** (заголовки h1; сколько раз сервер отдал каждый файл):

| Сборка | рамка `allow-scripts` | без песочницы |
| --- | --- | --- |
| Chromium полный, macOS и Linux, http и https | 3 | 1 |
| Chromium headless shell, http | 1 | 1 |
| Chromium headless shell, https | 3 | 1 |
| WebKit, macOS и Linux, http и https | 1 | 1 |
| Firefox, http и https | 1 | 1 |

Во всех случаях шрифт применился в 3 рамках из 3: CORS-проверка ответа из кеша проходит. Так же ведут себя `c1` и `c3`. Firefox делит кеш рамок, потому что раздел у него — по сайту верхнего уровня, а это кабинет. Когда непрозрачна сама страница верхнего уровня (Б2), Firefox тоже качает файлы заново.

**Процессы полного Chromium** (новый headless, `SystemInfo.getProcessInfo` и цели CDP `iframe`, `process-debug.mjs`):

| Рамки корня страниц | процессов рендера | целей `iframe` (OOPIF) |
| --- | --- | --- |
| нет | 3 | 0 |
| 3 без песочницы | 3 | 0 |
| 1 с `allow-scripts` | 4 | 1 |
| 3 с `allow-scripts` | 4 | 3 |
| 6 с `allow-scripts` | 4 | 6 |

Рамки с песочницей уходят из процесса кабинета в один общий процесс. Headless shell изоляции сайтов не делает вовсе: у него в процессе кабинета и рамка другого сайта (`xsite.test`). Для процессов и кеша он не показатель.

Следствие общего процесса (исправлено проверкой: дописано, `verify/verify-process.mjs`): у рамок одного процесса один главный поток. Цикл 1,5 с в одной рамке корня страниц в полном Chromium останавливает таймеры второй такой рамки на 1,5 с, а кабинет, рамку того же сайта без песочницы и рамку другого сайта — нет. В WebKit 26.6 (macOS и Linux) тот же цикл останавливает и кабинет, и рамку другого сайта. В Firefox 155 сборки Playwright (в её `playwright.cfg` `fission.webContentIsolationStrategy: 0`) — тоже всё, а с `1` («изолировать все сайты»; по сведениям проверки это умолчание настольного Firefox, здесь не перепроверялось) останавливает кабинет и все рамки корня страниц, кроме рамки другого сайта.

### Б1. Опубликованная страница: что сегодня в коде

- Страница — песочница. `pagePolicy('html')` без `framedBy` начинается с `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox` (`packages/domain/src/pages/headers.ts:45-47, 58-60`). Её origin — `"null"`, это подтвердил каждый прогон.
- CSP пускает шрифты: `font-src 'self' data: blob: https:` (`headers.ts:16-20`).
- Файл `/_files/` отдаётся с `pageFileHeaders`: `Cross-Origin-Resource-Policy: cross-origin`, ACAO нет (`packages/domain/src/pages/files.ts:97-111`, `apps/preview/src/pages/pages-server.ts:335-344`). 304 — с теми же заголовками (`pages-server.ts:337-341`).
- Сайт с паролем отдаёт файл только с cookie `raditi_page` (`HttpOnly; Secure; SameSite=None; Path=/`, `apps/preview/src/pages/page-cookie.ts:14`), иначе 404 (`pages-server.ts:323-332`).
- Агенту шрифты в `/_files/` прямо предлагают: описание `page_file_put` (`apps/mcp/src/pages/mcp-pages.controller.ts:170`) и инструкции хода (`apps/core/src/tasks/turn-instructions.ts:66-71`).
- Стенд `verify:pages`, сценарий E, проверяет в `/_files/` только CSS и картинку и только в Chromium (`apps/preview/scripts/verify-pages.mjs:709-805`). Договор среза 73.15 обещал «CSS, картинка, шрифт и скрипт… в Chromium и WebKit» (`docs/plan/73-pages-sites.md:749`).

### Б2. Публичный сайт: сегодня и с `Access-Control-Allow-Origin: *`

| Файл | сегодня: C | сегодня: F | сегодня: W | с ACAO: C, F, W |
| --- | --- | --- | --- | --- |
| `@font-face` → `/_files/fonts/golos.woff2` | ✗ CORS | ✗ CORS | ✓ | ✓ |
| шрифт из `/_files/style.css` | ✗ CORS | ✗ CORS | ✓ | ✓ |
| `/_files/style.css` | ✓ | ✓ | ✓ | ✓ |
| `/_files/app.js` | ✓ | ✓ | ✓ | ✓ |
| `/_files/app.mjs` | ✗ CORS | ✗ CORS | ✗ CORS | ✓ |
| `/_files/img/logo.png` | ✓ | ✓ | ✓ | ✓ |
| шрифт `data:` | ✓ | ✓ | ✓ | ✓ |

По https и по http одинаково, в обеих сборках Chromium, в Firefox обоих режимов cookie. По http шрифт держит `'self'`: `https:` там не совпадает. После перезагрузки с ACAO шрифт применяется снова во всех движках. Как именно, зависит от движка:
- полный Chromium и Firefox качают все `/_files/` заново (200 без `If-None-Match`), проверяется только сама страница (304);
- WebKit по http проверяет каждый файл и получает 304 с теми же заголовками, CORS проходит; по https с самоподписанным сертификатом он качал все файлы заново, 200 без `If-None-Match` (исправлено проверкой);
- headless shell по http тоже получает 304, по https не проверяет ничего, но он не показатель (А7).

Значит, в Chromium и Firefox общие файлы сайта при каждом открытии страницы идут целиком: `private, no-cache` и `ETag` им не помогают.

### Б3. Сайт с паролем: файлы страницы после ввода пароля

| Файл | C, сторонние cookie разрешены | C, сторонние cookie закрыты | F по умолчанию (TCP) | F Playwright (cookie не разделены; исправлено проверкой) | W macOS и Linux |
| --- | --- | --- | --- | --- | --- |
| шрифт | ✗ 404, без cookie | ✗ 404 | ✗ 404 | ✗ 404, без cookie | ✓ с cookie |
| CSS | ✓ с cookie | ✗ 404 | ✗ 404 | ✓ | ✓ |
| классический скрипт | ✓ | ✗ 404 | ✗ 404 | ✓ | ✓ |
| модуль | ✗ 404, без cookie | ✗ 404 | ✗ 404 | ✗ 404 | ✗ 404, без cookie |
| картинка | ✓ | ✗ 404 | ✗ 404 | ✓ | ✓ |

С ACAO таблица та же. CORS-запрос из непрозрачного документа идёт с `credentials: same-origin`, а «свой origin» у него не совпадает ни с кем, поэтому cookie не уходит ни в одном движке. Без CORS cookie уходит, пока браузер её пропускает. WebKit считает такой запрос первой стороной: по адресу документа. Chromium и Firefox без разделения cookie считают его сторонним, но `SameSite=None` пропускают. Firefox с TCP и Chromium с запретом сторонних cookie не пропускают (исправлено проверкой: прежде Chromium был назван считающим запрос первой стороной; что он считает его сторонним, показывает запрет сторонних cookie, который этот запрос останавливает). Сама страница открывается: это переход верхнего уровня, cookie первой стороны.

### Б4. Чужой сайт вставляет файлы закрытого сайта (тот же браузер, пароль уже введён)

| Движок | скрипт закрытого сайта исполнился на чужом | CSS применился | картинка | `fetch` с `credentials: 'include'` | `fetch` |
| --- | --- | --- | --- | --- | --- |
| C, сторонние cookie разрешены | да | да | да | `TypeError` (cookie ушла, ответ закрыт) | `TypeError` (404 без cookie) |
| C, сторонние cookie закрыты | нет (404) | нет | нет | `TypeError` | `TypeError` |
| F по умолчанию (TCP) | нет (404) | нет | нет | `TypeError` | `TypeError` |
| F Playwright (cookie не разделены; исправлено проверкой) | да | да | да | `TypeError` | `TypeError` |
| W macOS (ITP) | нет (404) | нет | нет | `TypeError` | `TypeError` |
| W Linux | да | да | да | `TypeError` | `TypeError` |

С ACAO результат тот же: с `*` браузер не отдаёт ответ на запрос с cookie, а ответ 404 без cookie ACAO не несёт. Публичный сайт с ACAO чужой `fetch` читает (200), без ACAO — `TypeError`.

### Б5. Можно ли отличить свои запросы страницы по `Referer`

Сайт `s5` — пароль, ACAO и `Referrer-Policy: strict-origin` у страницы вместо `no-referrer`. Это проба, такого в коде нет.

| Движок | `Referer` у `/_files/` со своей страницы |
| --- | --- |
| Chromium | нет |
| Firefox | `https://s5.pages.spike.test/` |
| WebKit | `https://s5.pages.spike.test/` |

Chromium из непрозрачного документа `Referer` не шлёт у элементов и `@font-face`. У `import()` из встроенного скрипта он шлёт адрес документа, `https://<сайт>/`: проверка нашла это на своём стенде (исправлено проверкой). Проверкой `Referer` от вставки чужим сайтом всё равно не защититься: свои запросы страницы приходят без него, а чужой сайт может послать свои без `Referer` (`referrerpolicy="no-referrer"`).

---

## Что это значит для плана 88

- **Ар28 — держится.** Предлагаемое уточнение второго пункта: «Шрифты и библиотеки — отдельным путём `/v/<метка>.<хеш>` (его уже пропускает `PAGES_PATHS`, и `next.config.ts` не ставит на `/v/` своих заголовков) с `Cross-Origin-Resource-Policy: cross-origin` и `Access-Control-Allow-Origin: *`. `same-origin` и `same-site` нельзя ни одному ответу: непрозрачная рамка всем чужая (`Sec-Fetch-Site: cross-site`). CSP рамки называет точные адреса файлов; `'self'` работает во всех движках, но шире. Проверено спайком s2 в Chromium 153, WebKit 26.6 и Firefox 155». Отказ от `allow-popups` на загрузку не влияет (А3).
- **Минимум для рамки артефакта** (что проверено целиком):
  - атрибут кадра: `sandbox="allow-scripts" referrerpolicy="no-referrer"`;
  - CSP ответа `/v/<token>`: `sandbox allow-scripts; script-src 'unsafe-inline' <адреса библиотек>; default-src 'none'; style-src 'unsafe-inline' [<адреса стилей>]; img-src data: blob: <подписанные адреса файлов>; font-src data: blob: <адреса шрифтов>; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors <кабинет>; object-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'`, остальные заголовки — `PAGE_COMMON_HEADERS` и `no-store`, как сегодня;
  - ответ библиотеки или шрифта: `Content-Type` из реестра файлов платформы (в пути нет расширения), `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: cross-origin`, `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=31536000, immutable`, `Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`. CSP с `sandbox` и `nosniff` загрузке не мешают. Предварительных запросов нет: правило Traefik `pages-root` (только GET и HEAD) менять не нужно;
  - точные адреса весят мало: 64 адреса — заголовок 3 612 байт, работает во всех движках.
- **Ар12 — уточнить одну строку.** «Отдача… по правилам общих файлов сайта (Дер34)… `nosniff`, `CORP: cross-origin`» — дописать: «у шрифтов ещё `Access-Control-Allow-Origin: *`: Chromium и Firefox просят их CORS-запросом с `Origin: null`». Картинкам ACAO не нужен. Пункт «Публикация. Использованные файлы копируются в `page_files`» работает для шрифтов только после исправления `files.ts` (ниже). На опубликованном сайте с паролем шрифты и модули из `/_files/` не загрузятся и после него, а в Firefox по умолчанию и в Chromium без сторонних cookie — ни один файл, в том числе фото и CSS (Б3). Значит, мост «Опубликовать как страницу» (88.11б, 88.13, 88.15) до исправления Дер35 кладёт шрифт `data:` во встроенный `<style>` страницы, а не в CSS из `/_files/`, и фото на сайте с паролем в этих браузерах не покажет (исправлено проверкой: прежде — «переносит шрифт внутрь CSS как `data:`»).
- **Ар30 — держится.** Свои шрифты отдельным путём работают; `data:` и `FontFace` из байтов — проверенный запасной путь без расширения CSP. Цена `data:`: каждый ответ `/v/` (`no-store`) несёт шрифт заново и на треть тяжелее файла — 22 032 байта превращаются в 29 376 знаков base64.
- **§7.13 «Ловушки CSP» — заменить последнее предложение первого пункта** («Шрифтам и модульным скриптам… нужны `ACAO: *` и `CORP: cross-origin`») на: «Шрифтам (Chromium и Firefox), модулям и `import()` (все движки; `import()` — исправлено проверкой: дописано) нужен `ACAO: *`. Классическим скриптам, стилям, картинкам и шрифтам в WebKit — CORP не `same-origin` и не `same-site`. Ар28 даёт оба заголовка, этого достаточно (спайк s2)». Пункт «Вероятно, сломано и сейчас» — заменить на «Сломано (спайк s2): шрифты и модули из `/_files/` не грузятся в Chromium и Firefox; на сайте с паролем в Firefox и в Chromium без сторонних cookie не грузится ни один файл».
- **§7.7 Холст, «Живых рамок — не больше 12»** — дописать: «В Chromium кеш библиотек между рамками не работает: каждая непрозрачная рамка — свой раздел HTTP-кеша, и библиотеки качаются заново каждой рамкой и каждым открытием. Бюджет трафика холста — 12 × вес библиотек и шрифтов кадра. Рамки с песочницей Chromium держит в одном общем процессе вне кабинета: зациклившийся скрипт одного кадра останавливает все живые кадры, но не кабинет. В WebKit и Firefox кадры живут в процессе кабинета и останавливают его. Кабинет пингует живые кадры и заменяет миниатюрой тот, что не ответил» (исправлено проверкой: две последние фразы дописаны; пинг — предложение проверки, а не довод спайка).
- **§0 п. 10** — «Фото и шрифты — подписанными адресами по правилам общих файлов сайта (Дер34)» → «…(Дер34), у шрифтов — с `ACAO: *`».
- **§9 «Риски»** — три строки (третья — от проверки):
  - «Нет кеша библиотек в Chromium» → держим: живых рамок не больше 12, остальные — миниатюры, библиотеки малые;
  - «Файлы опубликованного сайта с паролем не грузятся (Firefox, Chromium без сторонних cookie) и вставляются чужим сайтом (Chromium)» → держим: подписанные адреса, как у артефактов;
  - «Тяжёлый или зациклившийся скрипт кадра подвешивает кабинет (WebKit, Firefox) и все живые кадры (Chromium)» → держим: живой — только выбранный или видимый кадр, не больше 12, пинг кабинета снимает молчащий кадр; отдельный регистрируемый домен рамок развёл бы кадры и кабинет в Firefox и Chromium, в WebKit 26.6 — нет (исправлено проверкой: строка дописана).
- **§10 Э0а п. 2 — сделан.** В срез 88.12 добавить:
  - маршрут `/v/<метка>.<хеш>` с реестром файлов платформы. Токен кадра тоже вида `a.b` и попадает в тот же маршрут `apps/web/src/app/v/[token]/route.ts`, поэтому метка библиотеки должна отличаться от токена (исправлено проверкой: дописано);
  - построитель CSP рамки с точными адресами; в список входит всё, что библиотека тянет сама: модули её `import` и `import()`, шрифты её CSS (исправлено проверкой: дописано);
  - стенд `verify:artifacts`: шрифт, классический скрипт, модуль с импортом, стиль, картинка по подписанному адресу — в Chromium (полная сборка, не shell), WebKit и Firefox, по https.
- **Отчёт f2** — открытый вопрос «включено ли по умолчанию `kIsolateSandboxedIframes`» закрыт для настольного Chromium 153: да, один общий процесс на рамки корня страниц. Гипотеза §3.3 п. 2 подтверждена. Опасение §2c п. 5 («кадры, вероятно, рендерятся в процессе кабинета») для Chromium снято, для WebKit 26.6 и Firefox 155 подтверждено (исправлено проверкой: дописано).
- **Вне плана 88 — план 73 (Дер34, Дер35), ошибка в production.** Предложения:
  1. **`pageFileHeaders`** (`packages/domain/src/pages/files.ts:97-111`): добавить `'Access-Control-Allow-Origin': '*'` всем типам. Это чинит шрифты и модули публичных сайтов во всех движках (Б2). Безопасность:
     - байты публичного файла становятся читаемыми для `fetch` любого сайта — они и так публичны;
     - фраза Дер34 «прочитать её байты не может (нет CORS)» перестаёт быть верной для публичных файлов, это нужно сказать владельцу;
     - для сайта с паролем ничего не открывается: запрос с cookie при `*` браузер не отдаёт (Б4), а ответ 404 без cookie ACAO не несёт.
  2. **Дер35 — заменить cookie на подписанные адреса файлов.** Сервер страниц, отдавая страницу сайта с паролем зрителю с верной cookie, дописывает к адресам `/_files/…` в HTML и в CSS из `/_files/` короткий токен: HMAC от дерева, эпохи пароля и срока. Файл открывается по cookie или по токену. Это чинит Б3 во всех движках, закрывает вставку чужим сайтом (Б4) и возвращает cookie `SameSite=Lax`. Адреса, которые собирает скрипт страницы, токена не получат: это предел. Простой вариант — отдавать `/_files/` сайта с паролем без cookie. Инструкция хода уже велит класть туда только оформление (`turn-instructions.ts:69-70`), но Дер35 тогда меняется по существу. Решает владелец.
  3. **Риск Дер35 записан уже, чем он есть.** Там сказано «чужой сайт может показать картинку… прочитать её не может». На деле чужой сайт исполняет у себя скрипт закрытого сайта и применяет его CSS (Б4): то, что скрипт кладёт в глобальные переменные, чужой сайт читает.
  4. **`verify:pages`, сценарий E:** шрифт и модуль из `/_files/`, Chromium, WebKit и Firefox, Firefox с `cookieBehavior: 5` и Chromium с политикой `BlockThirdPartyCookies` — как обещал срез 73.15.
  5. **До исправления:** в описании `page_file_put` (`mcp-pages.controller.ts:170`) и в инструкциях хода (`turn-instructions.ts:66`) сказать агенту, что шрифт сайта — `data:` во встроенном `<style>` страницы, а модули и `import()` из `/_files/` не используются. CSS из `/_files/` на сайте с паролем в Firefox по умолчанию не грузится вовсе (исправлено проверкой: прежде — «`data:` внутри CSS»).
  6. **Кеш общих файлов.** В Chromium и Firefox каждое открытие страницы сайта качает его `/_files/` целиком (Б2): страница непрозрачна, и раздел кеша у неё каждый раз новый. Заголовками это не лечится. Ошибкой это не считаю, но «общие файлы один раз на сайт» (Дер34) экономят место, а не трафик зрителя.
- **Чего ACAO `*` не делает с подписанными адресами файлов артефакта.** Адрес — это и есть ключ: 5 минут, привязан к зрителю, роль перепроверяется. С ACAO JS любого сайта прочитает байты по адресу, но держатель адреса и так скачает их или вставит без CORS (CORP `cross-origin`). У рамки `Referrer-Policy: no-referrer`, `connect-src 'none'` и нет всплывающих окон, так что новых путей утечки адреса нет. На HTML-ответах `/v/<token>` ACAO не ставится никогда. `Access-Control-Allow-Origin: null` нельзя: ему совпадает любой непрозрачный документ любого сайта, а с `Allow-Credentials` он открыл бы чтение с cookie.

---

## Не подтверждено

- **Только headless и эмуляция.** Настоящих Chrome, Яндекс Браузера, Safari, Firefox и телефонов не было. Сборки Playwright идут со своими настройками: у Firefox — `cookieBehavior 4` в `playwright.cfg` и `cookieBehavior0` в категории `standard` (исправлено проверкой; настоящий режим проверен отдельно, `firefox-tcp`) и `fission.webContentIsolationStrategy: 0` (рамки других сайтов в общем процессе), у Chromium — `--disable-field-trial-config` и выключенный `ThirdPartyStoragePartitioning`. Android Chrome изолирует процессы иначе, iOS — только WebKit; ни то, ни другое не мерилось.
- **Firefox — только Linux arm64 в контейнере**: на этой macOS он не запустился.
- **Запрет сторонних cookie в Chromium** снят только управляемой политикой в контейнере. Что инкогнито настоящего Chrome (там сторонние cookie закрыты по умолчанию) ведёт себя так же, — вывод, а не проверка. Яндекс Браузер не проверялся.
- **Сертификат самоподписанный** (`ignoreHTTPSErrors`). По https Chromium не перепроверял даже саму опубликованную страницу (200 без `If-None-Match`), а headless shell по https не делил кеш рамок. Поэтому выводы о кеше Chromium сделаны по http, где ошибки сертификата нет.
- **Один сайт кабинета и страниц** держат имена `.test` без записи в Public Suffix List; у `raditi.ru` и `pages.raditi.ru` устройство то же, но на настоящих именах не проверялось. HTTP/1.1 без Traefik; HTTP/2 production на CORS и CSP влиять не должен, это не проверено.
- **Корпус синтетический:** один шрифт (кириллица Golos, 22 КиБ), крошечные скрипты, стили и PNG 3×2. Настоящих библиотек (Chart.js, reveal.js) и их цепочек импортов не было.
- **Процессы** посчитаны через CDP `SystemInfo.getProcessInfo` в новом headless, память не мерилась. Модель процессов WebKit и Firefox спайк не смотрел; проверка посмотрела её по тому, кто кого останавливает, в сборках Playwright, не в Safari и не в настоящем Firefox (исправлено проверкой: раздел «Проверка»).
- **Маршрута `/v/<метка>.<хеш>` в web нет:** его поведение повторено стендом, а не проверено на коде `apps/web`.
- **Как ведёт себя `Origin: null`** у прокси, CDN или WAF перед production, не проверено: у сервера Радити их нет, Traefik заголовок не трогает.

---

## Проверка

Независимая проверка 19.11.2026, 22:02–22:32: другой исполнитель, тот же ноутбук и тот же Docker. Load average macOS 4–13, с пиком 31–33 около 22:14, внутри ВМ 0,1–1. Время не мерилось. Скрипты проверки — `verify/`; их рабочий каталог и сертификат лежат вне репозитория.

### Что перезапущено

- **Стенд спайка без правок**, копией этого каталога:
  - macOS — `chromium-shell`, `chromium`, `webkit`;
  - контейнер `mcr.microsoft.com/playwright:v1.63.0-noble` — `chromium-shell`, `chromium`, `webkit`, `firefox`, `firefox-tcp`, проходы `--only-sites s5` и `chromium-3pcb` с той же управляемой политикой.
  - `check-pattern.mjs` — 8 232 ячейки, 0 вне правила.
  - `report.mjs` собрал те же таблицы, что `raw-tables.md`. Расходятся только порядок запросов в строках Б2 и число `If-None-Match` у Firefox в Б: 2 или 3, потому что Firefox дважды просит упавший модуль.
  - `process-debug.mjs` — 3, 3, 4, 4, 4 процесса рендера, как в А7.
- **Firefox на этой macOS** не стартует и у проверки: «Failed to launch the browser process».
- **Команда «Как повторить»** без каталога `tmp` падает: `ENOENT … mkdtemp`. Строка `mkdir -p tmp` дописана.

### Своими средствами (`verify/`, другой путь кода)

- **`headers-match.mjs`** импортирует сами файлы репозитория: `packages/domain/src/pages/headers.ts`, `files.ts`, `limits.ts` и `apps/preview/src/pages/page-cookie.ts`, их исполняет Node без сборки. Сравнивает их с `headers.mjs` спайка: 22 значения совпали байт в байт, в том числе обе политики страниц, `PAGE_COMMON_HEADERS`, `pageFileHeaders` шести типов и атрибуты cookie.
- **`vstand.mjs`** — свой стенд, не `stand.mjs`:
  - другие имена: `example.test` — кабинет, `pages.example.test` — корень страниц, соседний хост того же сайта `sib.pages.example.test`, `other.test` — чужой сайт;
  - заголовки, политики и cookie дают функции самого продукта, а не копия;
  - по рамке на вариант заголовков, все рамки сразу, а не все варианты в одной рамке;
  - шрифт проверяется шириной текста на canvas (`measureText`) и `FontFace.status`, стиль — `getComputedStyle`, картинка — `img.decode()`;
  - добавлены динамический `import()` и отрицательные контроли `'self'`: шрифт с соседнего хоста и скрипт с хоста кабинета. Положительный контроль — те же адреса при `*`.
- **`verify-frames.mjs`** — вопрос А, 7 сборок: Chromium полный и shell на macOS и Linux, WebKit на macOS и Linux, Firefox на Linux. 1 568 ячеек, вне правила 0:
  - `today` — сегодняшняя политика кадра с `allow-scripts`;
  - `'self'` — все 8 вариантов заголовков;
  - хост, точные адреса, `*`;
  - `PAGE_SANDBOX`, без песочницы, http.
- **`verify-cache.mjs`** — кеш:
  - одна библиотека с `immutable` (скрипт, модуль с импортом, шрифт) в трёх рамках по очереди и сразу;
  - та же страница кабинета открыта второй раз в том же контексте.
- **`verify-process.mjs`** — процессы:
  - в одной рамке цикл на 1,5 с, у кабинета и остальных рамок пульс каждые 20 мс, мерится самая долгая пауза пульса;
  - в Chromium ещё и `ps`: процессы рендера под pid браузера (`launchServer`), а не по CDP.
- **`verify-sites.mjs`** — вопрос Б на коде продукта, 7 сборок и 49 проходов сайтов:
  - Chromium на macOS и Linux, в том числе с политикой `BlockThirdPartyCookies`;
  - WebKit на macOS и Linux;
  - Firefox сборки Playwright и Firefox с `cookieBehavior 5`.

### Вердикты

| # | Утверждение спайка | Вердикт | Чем проверено |
| --- | --- | --- | --- |
| 1 | Рамка `/v/<token>` с `allow-scripts` и с `PAGE_SANDBOX` непрозрачна: `self.origin` — `null`, сообщения — с `null`, `document.cookie` бросает `SecurityError` | подтверждено | своя рамка, 7 сборок |
| 2 | `'self'` непрозрачного документа считается по адресу документа; `'self'`, хост, точные адреса и префикс работают одинаково | подтверждено | при `'self'` соседний хост того же сайта и хост кабинета закрыты, с нарушением CSP; при `*` они же грузятся. Значит, `'self'` — ровно origin адреса документа, не «всё подряд» и не кабинет |
| 3 | Правило: виды с CORS (шрифт в C и F, модули, `crossorigin`) требуют ACAO, без CORS (классический скрипт, стиль, картинка, шрифт в W) — CORP не `same-origin` и не `same-site`; Ар28 даёт оба | подтверждено | 1 568 своих ячеек, 0 исключений. `import()` ведёт себя как модуль |
| 4 | «Все 8 232 ячейки легли в это правило» | исправлено | ячеек правила — 5 096, ещё 3 136 — контроль без песочницы, где ждётся «грузится всё» |
| 5 | Заголовки стенда — копия кода байт в байт | подтверждено | `headers-match.mjs`: 22 значения |
| 6 | Сегодняшняя политика кадра не пускает до сервера ни одного запроса; `data:` и `FontFace` из байтов работают | подтверждено | 0 запросов ресурсов, оба шрифта применились во всех сборках |
| 7 | В WebKit `document.fonts.check()` отвечает `true` для отказавшего шрифта | подтверждено | WebKit: `status: error`, ширина равна `monospace`, `check()` — `true`; C и F — `false` |
| 8 | Сервер видит: шрифт C и F — `cors`, `Origin: "null"`; модуль — `cors`; классика — `no-cors`; `Sec-Fetch-Site: cross-site`; без песочницы — `same-origin` | подтверждено | свой журнал. Firefox шлёт `Origin: "null"` и у `no-cors` стиля и картинки, не только скрипта |
| 9 | Полный Chromium не берёт библиотеку из кеша в непрозрачной рамке: 3 рамки — 3 запроса, без песочницы — 1; WebKit и Firefox — 1; shell не показатель | подтверждено | ещё и рамки сразу (3 запроса) и повторное открытие (ещё 3; без песочницы — 0). Подтверждено поведение; «свой раздел кеша» это или кеш не используется вовсе — механизм не проверить |
| 10 | Опубликованные страницы: C и F качают `/_files/` заново (200 без `If-None-Match`), 304 — только у страницы; W проверяет каждый файл (304) | исправлено | по http подтверждено; WebKit по https с самоподписанным сертификатом качал всё заново, 200 без `If-None-Match` |
| 11 | Рамки с песочницей в полном Chromium — OOPIF, один общий процесс вне кабинета; shell изоляции не делает | подтверждено | `ps`: 3, 3, 4, 4, 4 на macOS и Linux. Цикл в одной рамке останавливает вторую, но не кабинет |
| 12 | План: вопрос f2 о процессе кадров «закрыт»; в §7.7 — «Рамки с песочницей Chromium держит в одном общем процессе вне кабинета» | исправлено | закрыт только для Chromium, и там зависший кадр останавливает все живые кадры. В WebKit 26.6 цикл любой рамки останавливает кабинет и все рамки. В Firefox сборки Playwright — тоже; с `fission.webContentIsolationStrategy: 1` кабинет встаёт вместе с рамками корня страниц, рамка чужого сайта — нет. В отчёт дописано (А7, «Коротко», план) |
| 13 | Б: страница — песочница, origin `null`; шрифт из `/_files/` (прямо и из CSS) не грузится в C и F, грузится в W; `.mjs` — нигде; с ACAO грузится всё, и после перезагрузки | подтверждено | свой стенд на коде продукта, C, W, F, `firefox-tcp`, `chromium-3pcb`; `import()` из `/_files/` — как модуль |
| 14 | Сайт с паролем: CORS-запросы идут без cookie, 404 и с ACAO; в F с TCP и в C с запретом сторонних cookie — 404 все файлы | подтверждено | то же |
| 15 | Объяснение Б3: «Chromium считает такой запрос первой стороной» | исправлено | запрет сторонних cookie останавливает этот запрос, значит, Chromium считает его сторонним и шлёт `SameSite=None`, только пока сторонние разрешены. Первой стороной его считает WebKit |
| 16 | Чужой сайт вставляет файлы закрытого (C со сторонними cookie, F без разделения, W Linux): скрипт исполняется, CSS применяется; `fetch` закрыт | подтверждено | чужой сайт ещё и читает глобальную переменную, которую ставит скрипт закрытого сайта. `fetch` с `include`, `omit` и без — `TypeError` |
| 17 | ACAO `*` в `pageFileHeaders` безопасен для сайта с паролем | подтверждено | с ACAO: `include` — `TypeError` (`*` с cookie не отдаётся), `omit` — 404 без ACAO — `TypeError`. Публичный файл чужой `fetch` читает (200), это и предлагается |
| 18 | Б5: Chromium из непрозрачного документа `Referer` не шлёт | исправлено | у элементов и `@font-face` не шлёт, у `import()` из встроенного скрипта шлёт адрес документа. Вывод «по `Referer` своих не отличить» верен |
| 19 | Предварительных запросов нет; правило `pages-root` (GET и HEAD, `infra/server/traefik/server.yml:21-27`) менять не нужно | подтверждено | свои стенды: только GET и POST формы пароля |
| 20 | CSP с 64 точными адресами — 3 612 байт, работает везде | подтверждено | у стенда метки из 6 и 7 знаков дают 3 548 и 3 612 байт; порядок тот же для `https://pages.raditi.ru` |
| 21 | Числа объёма: 238 открытий и 322 рамки, 10 976 ячеек, 61 проход сайтов, 16 012 запросов, из них 25 POST, 0 `OPTIONS`, 0 ошибок прогона; 29 376 знаков base64 | подтверждено | по `results/*.json` спайка: 307 прогонов, 0 ошибок |
| 22 | Ширины А6 и тексты ошибок А5 | подтверждено | перезапуск дал те же числа; свои тексты ошибок тех же классов во всех движках |
| 23 | «Playwright ставит Firefox `cookieBehavior 0`» | исправлено | `playwright.cfg` сборки ставит 4, при запуске — `cookieBehavior0` в категории `standard`; вывод не меняется: ни 4, ни 0 cookie по сайтам не делят |
| 24 | Поведение настоящих Chrome, Яндекс Браузера, Safari, Firefox, телефонов, HTTP/2 и Traefik | не проверить | как и у спайка: только сборки Playwright 1.63.0 в headless |

### Метод

- **Версии** те же, что у спайка, и подтверждены выводом браузеров: Chromium 153.0.8010.12 (shell и полная сборка 1243), WebKit 26.6 (2359), Firefox 155.0 (1543), `playwright-core` 1.63.0, Node 26.10.0, в контейнере 24.20.0. Всё в headless, без настоящих устройств.
- **Контроли.** Положительный контроль у спайка есть (без песочницы). Отрицательного контроля `'self'` у него не было: все ресурсы лежали на том же хосте, и неверное «`'self'` пускает всё» спайк бы не заметил. Проверка его добавила.
- **Процессы** спайк считал только через CDP. Проверка посчитала их `ps` и функционально: кто кого останавливает.
- **Числа таблиц** сверены с `results/*.json` спайка.

### Предложения для плана 88

- **Ар28, Ар30, §0 п. 10, §7.13** следуют из доводов. Добавлено: `import()` требует ACAO, как модуль.
- **Ар12** — верно для шрифтов. Публикация на сайт с паролем исправлена: в Firefox по умолчанию и в Chromium без сторонних cookie там не грузится ни один файл `/_files/`. Поэтому шрифт `data:` кладётся во встроенный `<style>` страницы, а фото там не покажутся.
- **§7.7 и §9** дописаны: общий процесс в Chromium, процесс кабинета в WebKit и Firefox. Пинг кадров — предложение проверки, а не довод спайка.
- **88.12** дописан: метка библиотеки делит маршрут `v/[token]` с токеном вида `a.b`; в точный список CSP входит всё, что библиотека тянет сама.
- **f2:** вопрос `kIsolateSandboxedIframes` закрыт только для Chromium. Опасение §2c п. 5 для WebKit и Firefox подтвердилось.
- **План 73.** Пункты 1, 3, 4 и 6 следуют из доводов, пункт 5 исправлен: CSS из `/_files/` на сайте с паролем в Firefox не грузится. Пункт 2 — решение владельца. Две оговорки проверки. У варианта с токеном ETag страницы должен зависеть от токена: иначе 304 вернёт в HTML просроченные адреса. При простом варианте файлы сайта с паролем откроет без cookie любой, кто знает адрес, а своё имя сайта и пути вида `/_files/img/logo.png` угадываются.
- **Правила CLAUDE.md** предложения не задевают. Свои шрифты без CDN — правило 1; подпись адресов файлов — секретом страниц, правило 2. Код продукта проверка не меняла.

### Гигиена

- В отчёте и файлах каталога нет локальных путей, имён и почты.
- Нет `node_modules`, lock-файлов, двоичных файлов, сертификатов и ключей.
- В `verify/` — только скрипты и `package.json` с точными версиями: `@fontsource-variable/golos-text` 5.3.0, `playwright-core` 1.63.0, `zod` 4.6.7.

### Как повторить проверку

Из рабочего каталога вне репозитория, куда скопирован этот каталог целиком; `<repo>` — корень дерева `feat/artifacts`:

```sh
cd verify && pnpm install && mkdir -p product certs tmp
cp <repo>/packages/domain/src/pages/headers.ts <repo>/packages/domain/src/pages/files.ts \
   <repo>/packages/domain/src/pages/limits.ts <repo>/apps/preview/src/pages/page-cookie.ts product/
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -keyout certs/key.pem -out certs/cert.pem -subj /CN=example.test \
  -addext "subjectAltName=DNS:example.test,DNS:*.example.test,DNS:*.pages.example.test,DNS:other.test"
node headers-match.mjs
node verify-frames.mjs --engines chromium,chromium-shell,webkit && node analyze-frames.mjs
node verify-cache.mjs --engines chromium,chromium-shell,webkit
node verify-process.mjs && node verify-process.mjs --engine webkit
node verify-sites.mjs --engines chromium,webkit
IMG=mcr.microsoft.com/playwright:v1.63.0-noble
docker run --rm --name spike88-s2v-linux --shm-size=1g -v "$PWD:$PWD" -w "$PWD" $IMG bash -c '
  node verify-frames.mjs --platform linux --engines firefox,chromium,webkit,chromium-shell &&
  node verify-cache.mjs --engines firefox,chromium &&
  node verify-process.mjs && node verify-process.mjs --engine firefox &&
  node verify-process.mjs --engine firefox-fission && node verify-process.mjs --engine webkit &&
  node verify-sites.mjs --engines firefox,firefox-tcp,webkit &&
  node verify-sites.mjs --engines chromium --label chromium-linux &&
  mkdir -p /etc/opt/chrome_for_testing/policies/managed &&
  echo "{\"BlockThirdPartyCookies\": true}" > /etc/opt/chrome_for_testing/policies/managed/v.json &&
  node verify-sites.mjs --engines chromium --label chromium-3pcb'
```
