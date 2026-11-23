# Спайк 1. Рамка правки без скриптов: `sandbox="allow-same-origin"` в Chromium, WebKit и Firefox

Дата: 19.11.2026. Этап Э0а плана 88, нужен этапу Э5. Решения: Ар9, Ар27, Ар28, Ар29, §7.7, §7.9. Код продукта не менялся. Время в этом спайке не замерялось.

---

## Вопрос

Может ли кабинет — родительская страница того же origin — вести рамку `sandbox="allow-same-origin"` без `allow-scripts` в Chromium, WebKit и Firefox так, чтобы работали «Выбрать элемент» и «Править текст»? И при этом ни один скрипт артефакта не выполнился никогда?

## Коротко

**Частично.** Защита держится: ни один скрипт артефакта не выполнился. Управлять рамкой кабинет может во всех трёх движках, но не через обработчики событий: WebKit (движок Safari и всех браузеров iPhone) их на узлах такой рамки не вызывает.

- **Скрипты артефакта не выполняются ни в одном движке.** Проверено 40 векторов: 24 на загрузке документа, 4 по клику, 2 навигацией, 9 — код, который кабинет сам вставляет в рамку, и маршрут, открытый отдельной вкладкой. В контроле без песочницы выполнились все, кроме двух, которых не исполняет ни один из трёх движков: `<marquee onstart>` и `meta refresh` на `javascript:`. В рамке правки — ни один, во всех четырёх вариантах доставки. Исключение — `contentWindow.eval` и `Function`, которые вызывает сам кабинет: песочница их не запрещает, запрещает только CSP рамки (`script-src 'none'`) — во всех трёх движках. В таблицах Firefox выполнял их и с этой CSP, но только потому, что вызов начинался в `page.evaluate` Playwright: вызов из собственного скрипта кабинета Firefox отклоняет, как Chromium и WebKit (исправлено проверкой). Без такой CSP (`srcdoc` без meta CSP) их выполняют все три движка, а Firefox — ещё и `setTimeout(строка)`, поэтому правило «кабинет не вызывает `eval`, `Function` и `setTimeout(строка)` рамки» остаётся правилом кода.
- **Chromium и Firefox вызывают обработчики кабинета** на `contentDocument` в фазах capture и bubble: указатель, клик, клавиатура, `beforeinput` и `input`, вставка, выделение, фокус, composition (в Chromium — через CDP, в Firefox — при вводе кириллицы), прокрутка, `resize`. `preventDefault` в capture-обработчике `click` и `auxclick` останавливает любой переход по ссылке.
- **WebKit не вызывает ни одного обработчика кабинета на узлах рамки**, а также `setTimeout` и `requestAnimationFrame` рамки. В консоли — «Blocked script execution … because the document's frame is sandboxed and the 'allow-scripts' permission is not set». Работают вызовы из кабинета: чтение и запись DOM, геометрия, `elementFromPoint`, `caretPositionFromPoint`, `contenteditable`, `execCommand`, Selection, а также MutationObserver и ResizeObserver. Отменить переход по ссылке обработчиком в WebKit нельзя.
- **Путь, который работает во всех трёх движках.** Мышь и касания кабинет берёт на своём слое над рамкой (у рамки `pointer-events: none`) и находит элемент `elementFromPoint`. Правку ведёт родной `contenteditable="plaintext-only"` с кареткой из точки клика. Изменения читает MutationObserver кабинета, конец правки кабинет видит на своих узлах. Ссылки в копии для правки обезвреживает сервер — кроме `xlink:href` у `<a>` в SVG и `href` у элементов MathML: их `editCopy` спайка не трогает, и такая ссылка уводит рамку (исправлено проверкой). Весь круг проверен в трёх движках: выбор, ввод, фиксация, правка исходника по смещениям `parse5`, новая загрузка. Своё поле кабинета поверх элемента — тоже, это путь для телефона.
- **Доставка — маршрут на origin кабинета**, вне `headers()` `next.config.ts`, с CSP `sandbox allow-same-origin; default-src 'none'; script-src 'none'; … frame-ancestors 'self'`. Cookie сессии до него доходит, открытый вкладкой он ничего не выполняет, а CSP-песочница держит даже случайный `allow-scripts` в атрибуте. `srcdoc` тоже грузится, но хуже. Без meta CSP первой в `head` наружу уходят `@import`, `@font-face`, `<link rel="stylesheet">` и `<audio>`, к кабинету — GET с cookie сессии; Chromium ещё и скачивает `<script src>`, Chromium и Firefox — `prefetch`, все три движка — вложенный `<iframe src>` (исправлено проверкой). Даже с meta CSP ссылка `#якорь` в `srcdoc` уводит рамку на адрес кабинета.
- **Вывод по Ар9:** держится с поправкой. «Кабинет работает с DOM рамки сам» — да. «Слушает события внутри рамки» — нет: это не работает в Safari. Запасной путь (миниатюра и карта рамок с сервера) не нужен.

---

## Как проверено

- **Машина.** macOS 27 (Darwin 27.0.0), arm64, 10 ядер, 32 ГБ; Node 26.10.0, pnpm 12.6.0. Рядом шла другая работа: `uptime` на начало и конец прогонов — в конце «Результатов».
- **Linux.** Docker Desktop (ВМ Linux arm64, 10 vCPU), образ `mcr.microsoft.com/playwright:v1.63.0-noble`: Ubuntu 24.04.4, Node 24.20.0. Контейнер `spike88-s1-linux`, без опубликованных портов, удалён после прогона.
- **Браузеры** — сборки Playwright 1.63.0 из кэша, без докачки, все без окна (headless):
  - Chromium 153.0.8010.12 — headless shell, сборка 1243;
  - WebKit 26.6 — сборка 2359;
  - Firefox 155.0 — сборка 1543, **только в Linux**: на macOS 27 она не запустилась («Could not find profile folder», в том числе без песочницы оболочки).
- **Пакеты** (точные версии — `package.json`): `playwright-core` 1.63.0, `parse5` 8.1.1, `react` и `react-dom` 19.3.1, `esbuild` 0.28.2.
- **Стенд** — один процесс Node (`run.mjs`), без Next.js:
  - два origin на loopback: кабинет `http://127.0.0.1:<порт>` и «чужой» `http://localhost:<порт>`, который записывает каждый запрос (`server.mjs`);
  - страница кабинета отдаёт заголовки `apps/web/next.config.ts` и CSP `apps/web/src/lib/content-security-policy.ts` с доменом страниц, как `proxy.ts`: `frame-ancestors 'none'`, `X-Frame-Options: DENY`, без `script-src`. Роль домена страниц играет «чужой» origin;
  - рамку ставит скрипт кабинета `harness.js`: `sandbox` — до `src` или `srcdoc` и до вставки в документ;
  - корпус синтетический (`corpus.mjs`): лендинг «Кофейня «Колос»» на русском, документ векторов, документ на каждый вектор клика и навигации, документ с DOM clobbering;
  - каждый вектор ставит метку всеми путями сразу: `postMessage` наверх, массив кабинета, атрибут на `<html>` рамки, `fetch`, картинка и `sendBeacon` на «чужой» origin. Контроль — тот же документ без песочницы и без CSP;
  - ввод настоящий, от Playwright: `mouse`, `keyboard`, `touchscreen`; IME — `Input.imeSetComposition` протокола CDP, есть только в Chromium. Раскладки кириллицы у Playwright нет: русский текст он вводит через `insertText`, по символу;
  - обводка проверена по пикселям снимка экрана (`png.mjs`);
  - серверная часть Ар9 — `stamp.mjs`: штампы `data-rid` и правка исходника по смещениям `parse5`;
  - React — `react-app.jsx`, собран `esbuild` (`build.mjs`);
  - отдельные пробы: `probe-slip.mjs` — `allow-scripts`, попавший в атрибут; `probe-srcdoc-anchor.mjs` — якоря страницы для чтения в `srcdoc` кабинета и правка `about:srcdoc#…`; `probe-wpe.mjs` — поиск вектора, который вешает WebKit для Linux.
- **Одна поправка по ходу.** В WebKit для Linux (WPE, GStreamer) `<audio preload="auto">`, которому сервер отдал картинку, занимал процессор на 100 % и вешал страницу кабинета вместе с рамкой. С тех пор «чужой» origin отдаёт этому вектору настоящий WAV, и прогон macOS для группы векторов повторён с ним; ответы не изменились.
- **Как повторить** — в копии этой папки вне репозитория (`<scratch>`):

  ```sh
  cp pnpm-workspace.example.yaml pnpm-workspace.yaml   # разрешает сборку esbuild
  pnpm install
  node build.mjs          # dist/react.js
  node run.mjs --engines=chromium,webkit --platform=darwin --out=results/darwin.json
  docker run --rm --name spike88-s1-linux -v "$PWD":/spike -w /spike \
    mcr.microsoft.com/playwright:v1.63.0-noble \
    node run.mjs --engines=chromium,webkit,firefox --platform=linux --out=results/linux.json
  node tables.mjs results/darwin.json results/linux.json   # таблицы ниже
  node probe-slip.mjs chromium,webkit                       # в Linux — chromium,webkit,firefox
  node probe-srcdoc-anchor.mjs chromium,webkit
  ```

  `--only=vectors,click` запускает отдельные группы. На macOS Playwright ищет браузеры в `~/Library/Caches/ms-playwright`. Сырые ответы обоих прогонов и проб — `results/`.

---

## Результаты

| Движок | macOS | Linux |
| --- | --- | --- |
| Chromium | 153.0.8010.12 | 153.0.8010.12 |
| WebKit | 26.6 | 26.6 |
| Firefox | не запускался | 155.0 |

Где ответы macOS и Linux расходятся, в ячейке указаны оба; в остальных ячейках они одинаковы.

### Таблица 1. Векторы × движки

В ячейке: контроль без песочницы → рамка правки. «Рамка правки» — четыре варианта с `sandbox="allow-same-origin"` или CSP `sandbox allow-same-origin` без `allow-scripts`: `srcdoc` без meta CSP, `srcdoc` с meta CSP, маршрут с атрибутом, маршрут только с CSP. Если вектор выполнился хотя бы в одном, он назван. Строки «(кабинет)» — код, который кабинет сам вставляет в рамку или вызывает в её окне; «(клик)» — клик пользователя по элементу артефакта. У строки «маршрут открыт вкладкой» — число выполнившихся векторов документа.

| Вектор | Chromium | WebKit | Firefox |
| --- | --- | --- | --- |
| `inline-script` | да → нет | да → нет | да → нет |
| `script-module` | да → нет | да → нет | да → нет |
| `script-src-ext` | да → нет | да → нет | да → нет |
| `script-src-same` | да → нет | да → нет | да → нет |
| `script-src-data` | да → нет | да → нет | да → нет |
| `body-onload` | да → нет | да → нет | да → нет |
| `img-onerror` | да → нет | да → нет | да → нет |
| `img-onload` | да → нет | да → нет | да → нет |
| `svg-onload` | да → нет | да → нет | да → нет |
| `svg-script` | да → нет | да → нет | да → нет |
| `svg-animate-onbegin` | да → нет | да → нет | да → нет |
| `style-onload` | да → нет | да → нет | да → нет |
| `link-css-onload` | да → нет | да → нет | да → нет |
| `details-ontoggle` | да → нет | да → нет | да → нет |
| `input-autofocus-onfocus` | да → нет | да → нет | да → нет |
| `video-source-onerror` | да → нет | да → нет | да → нет |
| `marquee-onstart` | нет → нет | нет → нет | нет → нет |
| `iframe-srcdoc-script` | да → нет | да → нет | да → нет |
| `iframe-src-ext` | да → нет | да → нет | да → нет |
| `iframe-javascript-src` | да → нет | да → нет | да → нет |
| `iframe-onload` | да → нет | да → нет | да → нет |
| `object-html` | да → нет | да → нет | да → нет |
| `embed-html` | да → нет | да → нет | да → нет |
| `object-data-url` | да → нет | да → нет | да → нет |
| `parent-created-script` (кабинет) | да → нет | да → нет | да → нет |
| `parent-created-script-src` (кабинет) | да → нет | да → нет | да → нет |
| `parent-innerhtml-onerror` (кабинет) | да → нет | да → нет | да → нет |
| `parent-setattribute-onclick` (кабинет) | да → нет | да → нет | да → нет |
| `parent-eval` (кабинет) | да → **да** (srcdoc+sandbox) | да → **да** (srcdoc+sandbox) | да → **да** (srcdoc+sandbox, srcdoc+sandbox+meta, route+sandbox, route-csp-sandbox-only) |
| `parent-function` (кабинет) | да → **да** (srcdoc+sandbox) | да → **да** (srcdoc+sandbox) | да → **да** (srcdoc+sandbox, srcdoc+sandbox+meta, route+sandbox, route-csp-sandbox-only) |
| `parent-settimeout-string` (кабинет) | да → нет | да → нет | да → **да** (srcdoc+sandbox) |
| `parent-document-write` (кабинет) | да → нет | да → нет | да → нет |
| `parent-location-javascript` (кабинет) | да → нет | да → нет | да → нет |
| `javascript-link` (клик) | да → нет | да → нет | да → нет |
| `onclick-button` (клик) | да → нет | да → нет | да → нет |
| `onclick-link` (клик) | да → нет | да → нет | да → нет |
| `form-javascript-action` (клик) | да → нет | да → нет | да → нет |
| `meta-refresh` на чужой адрес | да → нет | да → нет | да → нет |
| `meta-refresh` на `javascript:` | нет → нет | нет → нет | нет → нет |
| маршрут открыт вкладкой | 23 → 0 | 23 → 0 | 23 → 0 |

*(Исправлено проверкой.)* Строки `parent-eval` и `parent-function` у Firefox в вариантах с CSP `script-src 'none'` (`srcdoc+sandbox+meta`, `route+sandbox`, `route-csp-sandbox-only`) — следствие стенда: `H.parentVectors` вызывался из `page.evaluate` Playwright. Тот же вызов из собственного скрипта кабинета по клику Firefox отклоняет (`EvalError: call to eval() blocked by CSP`), как Chromium и WebKit (`verify/`, группа `feval3`). Без CSP рамки (`srcdoc+sandbox`) `eval` и `Function` выполняют все три движка — эти ячейки верны.

### Таблица 2. Клик по ссылке × движки

Рамка — маршрут с CSP правки. В ячейке пять ответов через «·»: контроль без песочницы · рамка без обработчика кабинета · рамка с `preventDefault` в capture-обработчике `click` и `auxclick` · ссылки в копии переписаны сервером · клик пришёлся на слой кабинета над рамкой. «ушла» — рамка перешла на другой адрес (её документ потерян), «нет» — ничего не произошло.

| Вектор | Chromium | WebKit | Firefox |
| --- | --- | --- | --- |
| `link-self` | ушла · ушла · нет · нет · нет | ушла · ушла · ушла · нет · нет | ушла · ушла · нет · нет · нет |
| `link-same-origin` | ушла · ушла · нет · нет · нет | ушла · ушла · ушла · нет · нет | ушла · ушла · нет · нет · нет |
| `link-blank` | **окно** · нет · нет · нет · нет | **окно** · нет · нет · нет · нет | **окно** · нет · нет · нет · нет |
| `link-blank-opener` | **окно** · нет · нет · нет · нет | **окно** · нет · нет · нет · нет | **окно** · нет · нет · нет · нет |
| `link-top` | **вкладка ушла** · нет · нет · нет · нет | **вкладка ушла** · нет · нет · нет · нет | **вкладка ушла** · нет · нет · нет · нет |
| `link-parent` | **вкладка ушла** · нет · нет · нет · нет | **вкладка ушла** · нет · нет · нет · нет | **вкладка ушла** · нет · нет · нет · нет |
| `link-ping` | ушла · ушла · нет · нет · нет | ушла · ушла · ушла · нет · нет | ушла · ушла · нет · нет · нет |
| `link-download` | ушла · ушла · нет · нет · нет | ушла · ушла · ушла · нет · нет | ушла · ушла · нет · нет · нет |
| `base-target-top` | **вкладка ушла** · нет · нет · нет · нет | **вкладка ушла** · нет · нет · нет · нет | **вкладка ушла** · нет · нет · нет · нет |
| `area-link` | ушла · ушла · нет · нет · нет | ушла · ушла · ушла · нет · нет | ушла · ушла · нет · нет · нет |
| `onclick-link` | **скрипт** · нет · нет · нет · нет | **скрипт** · нет · нет · нет · нет | **скрипт** · нет · нет · нет · нет |
| `form-submit` | ушла · нет · нет · нет · нет | ушла · нет · нет · нет · нет | ушла · нет · нет · нет · нет |

**`srcdoc` с meta CSP вместо маршрута** — четыре ответа: контроль · рамка · отмена · адреса переписаны. В `srcdoc` переписанный адрес `#…` тоже уводит рамку: его база — адрес кабинета.

| Вектор | Chromium | WebKit | Firefox |
| --- | --- | --- | --- |
| `link-self` | ушла · ушла · нет · ушла | ушла · ушла · ушла · ушла | ушла · ушла · нет · ушла |
| `link-blank` | **окно** · нет · нет · ушла | **окно** · нет · нет · ушла | **окно** · нет · нет · ушла |
| `onclick-link` | **скрипт** · ушла · нет · ушла | **скрипт** · ушла · ушла · ушла | **скрипт** · ушла · нет · ушла |
| `area-link` | ушла · ушла · нет · ушла | ушла · ушла · ушла · ушла | ушла · ушла · нет · ушла |

**Другие способы перейти по ссылке** (обработчик кабинета на `click` и `auxclick`, если не сказано иначе):

| Случай | Chromium | WebKit | Firefox |
| --- | --- | --- | --- |
| route+sandbox: `link-self`, Enter с клавиатуры | ничего | рамка ушла + запрос | ничего |
| route+sandbox: `link-self`, средняя кнопка | ничего | macOS: рамка ушла + запрос; Linux: **новое окно** + запрос | ничего |
| route+sandbox: `link-self`, Cmd/Ctrl+click | ничего | рамка ушла + запрос | ничего |
| route+sandbox: `link-blank`, средняя кнопка | ничего | ничего | ничего |
| route+sandbox: `link-blank`, Cmd/Ctrl+click | ничего | ничего | ничего |
| route+sandbox: `link-self`, средняя кнопка, обработчик только на click | **новое окно** + запрос | macOS: рамка ушла + запрос; Linux: **новое окно** + запрос | **новое окно** + запрос |
| srcdoc+sandbox+meta: `link-self`, Enter с клавиатуры | ничего | рамка ушла + запрос | ничего |
| srcdoc+sandbox+meta: `link-self`, средняя кнопка | ничего | macOS: рамка ушла + запрос; Linux: **новое окно** + запрос | ничего |
| srcdoc+sandbox+meta: `link-self`, Cmd/Ctrl+click | ничего | рамка ушла + запрос | ничего |
| srcdoc+sandbox+meta: `link-blank`, средняя кнопка | ничего | ничего | ничего |
| srcdoc+sandbox+meta: `link-blank`, Cmd/Ctrl+click | ничего | ничего | ничего |
| srcdoc+sandbox+meta: `link-self`, средняя кнопка, обработчик только на click | **новое окно** + запрос | macOS: рамка ушла + запрос; Linux: **новое окно** + запрос | **новое окно** + запрос |

*(Исправлено проверкой.)* «Ушла» и «запрос» в таблице 2 и в двух таблицах под ней — переход на «чужой» origin стенда. Он играл домен страниц и поэтому стоял в `frame-src` кабинета. Ссылку на любой другой сайт рамка правки не открывает: переход блокирует `frame-src` кабинета, запрос не уходит. Chromium при этом показывает в рамке страницу ошибки (документ потерян), WebKit и Firefox оставляют документ. Уводят рамку переходы на домен страниц и на origin кабинета (`verify/`, группа `cancel`). Новое окно (средняя кнопка, Cmd/Ctrl+click) — уже не рамка: `frame-src` его по устройству CSP не ограничивает (не проверялось).

### Таблица 3. Запросы без скриптов × способ доставки

Колонки: без песочницы / `srcdoc` без песочницы / `srcdoc` с песочницей без meta CSP / `srcdoc` с песочницей и meta CSP / маршрут. «да» — запрос ушёл (наружу или, у `same-origin-*`, к кабинету).

| Вектор | Chromium | WebKit | Firefox |
| --- | --- | --- | --- |
| `css-background` | да / нет / нет / нет / нет | да / нет / нет / нет / нет | да / нет / нет / нет / нет |
| `css-import` | да / да / да / нет / нет | да / да / да / нет / нет | да / да / да / нет / нет |
| `css-font-face` | да / да / да / нет / нет | да / да / да / нет / нет | да / да / да / нет / нет |
| `css-list-image` | да / нет / нет / нет / нет | да / нет / нет / нет / нет | да / нет / нет / нет / нет |
| `css-image-set` | да / нет / нет / нет / нет | да / нет / нет / нет / нет | да / нет / нет / нет / нет |
| `link-stylesheet` | да / да / да / нет / нет | да / да / да / нет / нет | да / да / да / нет / нет |
| `link-prefetch` | да / да / да / нет / нет | нет / нет / нет / нет / нет | нет / да / да / нет / нет |
| `link-preload` | да / нет / нет / нет / нет | да / нет / нет / нет / нет | да / нет / нет / нет / нет |
| `img-ext` | да / нет / нет / нет / нет | да / нет / нет / нет / нет | да / нет / нет / нет / нет |
| `img-srcset` | да / нет / нет / нет / нет | да / нет / нет / нет / нет | да / нет / нет / нет / нет |
| `picture-source` | да / нет / нет / нет / нет | да / нет / нет / нет / нет | да / нет / нет / нет / нет |
| `video-poster` | да / нет / нет / нет / нет | да / нет / нет / нет / нет | да / нет / нет / нет / нет |
| `audio-src` | да / да / да / нет / нет | да / да / да / нет / нет | да / да / да / нет / нет |
| `input-image` | да / нет / нет / нет / нет | да / нет / нет / нет / нет | да / нет / нет / нет / нет |
| `svg-image` | да / нет / нет / нет / нет | да / нет / нет / нет / нет | да / нет / нет / нет / нет |
| `svg-use` | нет / нет / нет / нет / нет | нет / нет / нет / нет / нет | нет / нет / нет / нет / нет |
| `object-image` | да / нет / нет / нет / нет | да / нет / нет / нет / нет | да / нет / нет / нет / нет |
| `embed-image` | да / нет / нет / нет / нет | да / нет / нет / нет / нет | да / нет / нет / нет / нет |
| `table-background` | да / нет / нет / нет / нет | да / нет / нет / нет / нет | да / нет / нет / нет / нет |
| `base-href` | да / нет / нет / нет / нет | да / нет / нет / нет / нет | да / нет / нет / нет / нет |
| `noscript-img` | нет / нет / нет / нет / нет | нет / нет / нет / нет / нет | нет / нет / нет / нет / нет |
| `same-origin-img` | да, с cookie / да, с cookie / да, с cookie / нет / нет | да, с cookie / да, с cookie / да, с cookie / нет / нет | да, с cookie / да, с cookie / да, с cookie / нет / нет |
| `same-origin-css` | да, с cookie / да, с cookie / да, с cookie / нет / нет | да, с cookie / да, с cookie / да, с cookie / нет / нет | да, с cookie / да, с cookie / да, с cookie / нет / нет |
| `noscript-same-origin-img` | нет / нет / да, с cookie / нет / нет | нет / нет / да, с cookie / нет / нет | нет / нет / да, с cookie / нет / нет |

### Таблица 4. Способ доставки × движки

| Вариант | Chromium | WebKit | Firefox |
| --- | --- | --- | --- |
| `srcdoc` + `sandbox="allow-same-origin"` | загружен, origin кабинета, обработчики: да | загружен, origin кабинета, обработчики: **нет** | загружен, origin кабинета, обработчики: да |
| то же + meta CSP первой в head | загружен, origin кабинета, обработчики: да | загружен, origin кабинета, обработчики: **нет** | загружен, origin кабинета, обработчики: да |
| маршрут, CSP правки + атрибут | загружен, origin кабинета, обработчики: да, cookie: да | загружен, origin кабинета, обработчики: **нет**, cookie: да | загружен, origin кабинета, обработчики: да, cookie: да |
| маршрут, только CSP `sandbox allow-same-origin` | загружен, origin кабинета, обработчики: да, cookie: да | загружен, origin кабинета, обработчики: **нет**, cookie: да | загружен, origin кабинета, обработчики: да, cookie: да |
| маршрут без `X-Frame-Options` | загружен, origin кабинета, обработчики: да, cookie: да | загружен, origin кабинета, обработчики: **нет**, cookie: да | загружен, origin кабинета, обработчики: да, cookie: да |
| маршрут с `X-Frame-Options: DENY` и `frame-ancestors 'self'` | загружен, origin кабинета, обработчики: да, cookie: да | загружен, origin кабинета, обработчики: **нет**, cookie: да | загружен, origin кабинета, обработчики: да, cookie: да |
| маршрут с заголовками кабинета (не исключён из `headers()`) | **не загружен** | **не загружен** | **не загружен** |
| маршрут: CSP кабинета + своя CSP | **не загружен** | **не загружен** | **не загружен** |
| для сравнения: `allow-same-origin allow-scripts` + `script-src 'none'` | загружен, origin кабинета, обработчики: да, cookie: да | загружен, origin кабинета, обработчики: да, cookie: да | загружен, origin кабинета, обработчики: да, cookie: да |
| для сравнения: без песочницы, только CSP | загружен, origin кабинета, обработчики: да, cookie: да | загружен, origin кабинета, обработчики: да, cookie: да | загружен, origin кабинета, обработчики: да, cookie: да |
| для сравнения: `srcdoc` без песочницы | загружен, origin кабинета, обработчики: да | загружен, origin кабинета, обработчики: да | загружен, origin кабинета, обработчики: да |
| контроль: маршрут без политики, без песочницы | загружен, origin кабинета, обработчики: да, cookie: да | загружен, origin кабинета, обработчики: да, cookie: да | загружен, origin кабинета, обработчики: да, cookie: да |

**Если кабинет пошлёт `Cross-Origin-Embedder-Policy: require-corp`:**

| Вариант | Chromium | WebKit | Firefox |
| --- | --- | --- | --- |
| `srcdoc` + meta | загружен | загружен | загружен |
| маршрут без COEP | **не загружен** | **не загружен** | **не загружен** |
| маршрут с COEP | загружен | загружен | загружен |

### Таблица 5. Возможности × движки

Рамка правки — маршрут с CSP правки и `sandbox="allow-same-origin"`; `srcdoc` с meta CSP дал те же ответы (сырые данные — `results/`).

| Возможность | Chromium | WebKit | Firefox |
| --- | --- | --- | --- |
| **Обработчики кабинета на `contentDocument`** |  |  |  |
| pointerover/out/move/down/up | да, capture и bubble | **нет** | да, capture и bubble |
| mouseover/out/move/down/up | да, capture и bubble | **нет** | да, capture и bubble |
| click, dblclick, auxclick, contextmenu | да, capture и bubble | **нет** | да, capture и bubble |
| keydown, keyup | да, capture и bubble | **нет** | да, capture и bubble |
| beforeinput, input | да, capture и bubble | **нет** | да, capture и bubble |
| paste, copy, cut | да, capture и bubble | **нет** | да, capture и bubble |
| selectionchange | да, capture и bubble | **нет** | да, capture и bubble |
| focus, blur, focusin, focusout | да, capture и bubble | **нет** | да, capture и bubble |
| compositionstart/update/end | да (CDP `Input.imeSetComposition`) | **нет** | да (Playwright вводит кириллицу через composition) |
| wheel, scroll | да, capture и bubble | **нет** | да, capture и bubble |
| resize и scroll на window рамки | да | **нет** | да |
| то же при `allow-scripts` + `script-src 'none'` | да, capture и bubble | да, capture и bubble | да, capture и bubble |
| **Колбэки кабинета через API рамки** |  |  |  |
| setTimeout(fn) рамки | **нет** | **нет** | да |
| requestAnimationFrame рамки | да | **нет** | да |
| queueMicrotask рамки | да | да | да |
| Promise рамки | да | да | да |
| MutationObserver рамки | да | да | да |
| MutationObserver кабинета на узлах рамки | да | да | да |
| ResizeObserver рамки | да | да | да |
| ResizeObserver кабинета | да | да | да |
| IntersectionObserver рамки | да | да | да |
| `el.onclick = fn` + `el.click()` | да | **нет** | да |
| `addEventListener` + `dispatchEvent` | да | **нет** | да |
| **Правка** |  |  |  |
| каретка одним кликом: `contenteditable` заранее | да | да | да |
| каретка: `contenteditable` в `pointerdown` кабинета | да | **нет** | да |
| каретка: в `click` кабинета + `caretPositionFromPoint` | да | **нет** | да |
| каретка: из точки, без обработчиков в рамке | да | да | да |
| ввод кириллицы `keyboard.type` (plaintext-only) | да, keydown виден: 9 | да, keydown не виден | да, keydown виден: 9 |
| `keyboard.insertText` | да | да | да |
| Enter в plaintext-only | `\n` в тексте | `<br>` | `<br>` |
| Enter в `true` | `<div>` | `<div>` | `<br>` |
| Backspace | да | да | да |
| отмена с клавиатуры (Cmd/Ctrl+Z) | нажатия: 2 из 2 убраны, insertText: да | нажатия: 2 из 2 убраны, insertText: да | нажатия: 2 из 2 убраны, insertText: да |
| `execCommand("undo")` из кабинета | да | да | да |
| `execCommand("insertText")` из кабинета | да | да | да |
| вставка богатого HTML в plaintext-only | простой текст, событие: text/plain + text/html | простой текст, события нет | простой текст, событие: text/html + text/plain |
| вставка в `true` без перехвата | **HTML вставлен** | **HTML вставлен** | **HTML вставлен** |
| вставка в `true` с перехватом кабинета | простой текст | **HTML вставлен** | простой текст |
| Cmd/Ctrl+B в `true` | да | macOS: **нет**; Linux: да | **нет** |
| отмена `beforeinput` (formatBold, insertParagraph) | отменены: formatBold, insertParagraph | **не отменить** | отменены: insertParagraph |
| пробелы → NBSP, `white-space: normal` (plaintext-only) | +0 | +2 | +2 |
| пробелы → NBSP, `white-space: normal` (`true`) | +2 | +2 | +2 |
| пробелы → NBSP, `white-space: pre-wrap` | +0 | +0 | +0 |
| IME: `Input.imeSetComposition` (CDP) | да, start 1, update 3, end 1 | нет API в Playwright | нет API в Playwright |
| **Геометрия и обводка** |  |  |  |
| `getBoundingClientRect` → кабинет (цвет пикселя в центре) | да | да | да |
| рамка Playwright совпала | да (Δ 0, 0) | да (Δ 0, 0) | да (Δ 0, 0) |
| `elementFromPoint` | да | да | да |
| `Range.getClientRects` | да | да | да |
| `caretPositionFromPoint` / `caretRangeFromPoint` | да / да | да / да | да / да |
| `scrollTo` кабинетом, сдвиг рамок | да | да | да |
| прокрутка колесом над рамкой | да | да | да |
| ширина 390: `innerWidth`, медиазапрос | да | да | да |
| обводка слоем кабинета (пиксель) | да | да | да |
| обводка `<style>` внутри рамки (пиксель) | да | да | да |
| `adoptedStyleSheets` рамки | да | да | да |
| **Без обработчиков в рамке: слой кабинета поверх неё** |  |  |  |
| наведение: элемент и обводка | да | да | да |
| выбор кликом | да | да | да |
| колесо | кабинет пересылает `scrollBy` | macOS: рамка прокручивается сама; Linux: кабинет пересылает `scrollBy` | кабинет пересылает `scrollBy` |
| каретка из точки клика, ввод | да | да | да |
| MutationObserver кабинета видит правку | да | да | да |
| Enter без обработчика | `\n` | `<br>` | `<br>` |
| конец правки виден на узлах кабинета | да | да | да |
| фиксация → сервер → новая загрузка | да | да | да |
| своё поле кабинета поверх элемента → сервер | да | да | да |
| касание выбирает элемент через слой | да | да | да |
| **Сервер: правка исходника по смещениям parse5** |  |  |  |
| заголовок целиком, с `&` и `<` (экранированы) | да | да | да |
| одна щель текста смешанного абзаца, ссылка цела | да | да | да |
| пустой элемент | да | да | да |
| клон алгоритма adoption agency | отказ `AMBIGUOUS_ID` | отказ `AMBIGUOUS_ID` | отказ `AMBIGUOUS_ID` |
| `<p>` внутри `<noscript>` получил id | да | да | да |
| **Прочее** |  |  |  |
| DOM clobbering: `doc.addEventListener` | **падает** (`<img name>`) | **падает** (`<img name>`) | **падает** (`<img name>`) |
| DOM clobbering: вызовы через прототипы кабинета | да | да | да |
| касание: события у кабинета | да (touchstart, touchend, pointerdown, pointerup, click) | **нет** | да (touchstart, touchend, pointerdown, pointerup, click) |
| касание: каретка и ввод | да | да | да |

*(Исправлено проверкой.)* В Chromium `focus` и `blur` пришли только в фазе capture: эти события не всплывают. «34 типа» в выводах — 32 типа на документе рамки и `resize`, `scroll` её окна. Строки «колбэки кабинета» у Firefox (`setTimeout(fn)`, `el.onclick`, `dispatchEvent`) снимались из `page.evaluate`; обработчики на настоящий ввод Firefox вызывает и без него (`verify/`, группа `listeners`).

### Таблица 6. React 19.3.1

| Проверка | Chromium | WebKit | Firefox |
| --- | --- | --- | --- |
| `onClick` и `onClickCapture` React на обёртке рамки | 0 и 0 из 1 клика | 0 и 0 из 1 клика | 0 и 0 из 1 клика |
| `onLoad` React на `<iframe>` | 2 из 2 загрузок | 2 из 2 загрузок | 2 из 2 загрузок |
| свой слушатель на `contentDocument` после `load` | 2 из 2 кликов | 0 из 2 кликов | 2 из 2 кликов |
| переподключение после смены `srcDoc`, `abort()` прежнего | подключён 2, снят 1 | подключён 2, снят 1 | подключён 2, снят 1 |
| снятие при размонтировании | снят 1 | снят 1 | снят 1 |
| `createPortal` в `body` рамки: `onClick` | 1 из 1 | 0 из 1 | 1 из 1 |
| один `<iframe>` переключают «просмотр ↔ правка»: `sandbox` раньше источника, тот же элемент | флаги верные | флаги верные | флаги верные |
| один `<iframe>` переключают «просмотр ↔ правка»: источник раньше `sandbox`, тот же элемент | **правка загрузилась со старыми флагами**: скрипт выполнен, доступа нет | флаги верные | **правка загрузилась со старыми флагами**: скрипт выполнен, доступа нет |
| один `<iframe>` переключают «просмотр ↔ правка»: `sandbox` раньше источника, `key` по режиму | флаги верные | флаги верные | флаги верные |
| один `<iframe>` переключают «просмотр ↔ правка»: источник раньше `sandbox`, `key` по режиму | флаги верные | флаги верные | флаги верные |

Сервер (без браузера): штампов в синтетическом лендинге — 49; повторяющийся id после разбора — e28; текст, чьё смещение не совпадает со значением, — «фостер»; `<p>` в `<noscript>` получает id при `scriptingEnabled: false` — да, при `true` — **нет**.

- macOS: Darwin 27.0.0 arm64, Node v26.10.0; начало 2026-11-19T14:58:14.342Z, `uptime`: 17:58  up 1 day,  9:24, 2 users, load averages: 7.38 16.88 16.11; конец 2026-11-19T15:07:53.506Z, `uptime`: 18:07  up 1 day,  9:34, 2 users, load averages: 5.42 7.55 11.27.
- Linux: Linux 7.0.14-linuxkit arm64, Node v24.20.0; начало 2026-11-19T15:44:37.724Z, `uptime`: 15:44:37 up 1 day, 2 min,  0 user,  load average: 0.15, 0.43, 0.74; конец 2026-11-19T15:59:23.646Z, `uptime`: 15:59:23 up 1 day, 17 min,  0 user,  load average: 0.69, 0.34, 0.45.

### Шаблон для кабинета (React)

React вешает свои обработчики на корень приложения, а события рамки до документа кабинета не всплывают: `onClick` и `onClickCapture` на обёртке рамки не сработали ни разу (таблица 6). `createPortal` в `body` рамки подключает React к узлу рамки, но это снова обработчики внутри рамки — WebKit их не вызывает. Рабочий шаблон, проверенный в `react-app.jsx`:

```tsx
// Документ рамки — на каждую загрузку: прежний снимается, при размонтировании — тоже.
function useFrameDocument(
  ref: RefObject<HTMLIFrameElement | null>,
  onDocument: (doc: Document, signal: AbortSignal) => void,
) {
  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    let ac: AbortController | null = null
    const attach = () => {
      ac?.abort()
      ac = null
      const doc = frame.contentDocument
      // Первая загрузка бывает пустым about:blank; документ артефакта помечен сервером.
      if (doc?.documentElement?.getAttribute('data-artifact') !== '1') return
      ac = new AbortController()
      onDocument(doc, ac.signal)
    }
    frame.addEventListener('load', attach)
    attach()
    return () => {
      frame.removeEventListener('load', attach)
      ac?.abort()
    }
  }, [ref, onDocument])
}
```

- В `onDocument` — только то, что работает во всех трёх движках: MutationObserver кабинета (`signal` его отключает), чтение геометрии, `contenteditable` и выделение. Ввод мыши и касаний — на своём слое над рамкой, не в рамке.
- Методы документа рамки — через прототипы окна кабинета: `Document.prototype.elementFromPoint.call(doc, x, y)`, `EventTarget.prototype.addEventListener.call(…)`. Имя элемента может подменить метод документа (DOM clobbering, таблица 5).
- `<iframe>` правки — свой элемент с постоянным `sandbox="allow-same-origin"` и `key` по режиму и версии блока. Переключать `sandbox` и источник у одного элемента нельзя: в Chromium и Firefox документ правки загрузился со старыми флагами просмотра, и его скрипт выполнился (таблица 6). Скрипт выполнился потому, что документ правки в тесте был `srcdoc` без CSP; маршрут с CSP правки при старых флагах скрипт не запускает, но рамка получает непрозрачный origin и кабинет теряет к ней доступ (исправлено проверкой, `verify/`, группа `toggle`).

### Что видно сверх таблиц

- **WebKit и обработчики.** На каждый обработчик кабинета, который должен был сработать на узле рамки, WebKit пишет в консоль «Blocked script execution in '<адрес рамки>' because the document's frame is sandboxed and the 'allow-scripts' permission is not set». Так же — для `el.onclick = fn` и для `setTimeout(fn)` и `requestAnimationFrame(fn)` окна рамки. Колбэки MutationObserver, ResizeObserver, IntersectionObserver и микрозадачи выполняются. Chromium тоже не выполняет `setTimeout(fn)` окна такой рамки (а `requestAnimationFrame` — выполняет), Firefox выполняет всё: таймеры кабинет ставит только на своё окно. Проверить это заранее можно без признака браузера: обработчик на элементе рамки и `dispatchEvent` (`probeListeners` в `harness.js`) — в WebKit он не срабатывает. macOS и Linux ведут себя одинаково.
- **`eval` из кабинета.** `contentWindow.eval(код)` и `new contentWindow.Function(код)()` выполняют код кабинета в окне рамки. Песочница этого не запрещает ни в одном движке. Запрещает CSP рамки (`script-src 'none'`) — во всех трёх движках, если вызов делает скрипт кабинета. В Firefox код в стенде выполнился во всех четырёх вариантах, и с маршрутом, и с meta CSP, только потому, что вызов шёл из `page.evaluate` Playwright (исправлено проверкой). Это код кабинета, а не артефакта, но строка артефакта, переданная туда, выполнилась бы с правами кабинета.
- **Когда песочница разрешает скрипты** (`allow-scripts allow-same-origin`, а скрипты запрещает только CSP маршрута), WebKit вызывает обработчики кабинета, и все векторы по-прежнему не выполняются. Но `<meta http-equiv="refresh">` тогда уводит рамку на чужой сайт: в песочнице без `allow-scripts` его держит флаг автоматических действий, CSP его не держит. Если `allow-scripts` случайно попадёт в атрибут, а маршрут шлёт CSP `sandbox allow-same-origin`, ничего не выполняется и не уходит ни в одном движке: CSP-песочница ложится поверх атрибута (`probe-slip.mjs`). У `srcdoc` с meta CSP в том же случае скрипты не выполняются, но `meta refresh` уводит рамку: meta CSP не умеет `sandbox`.
- **`srcdoc` и якоря.** Базовый адрес документа `srcdoc` — адрес кабинета. Поэтому ссылка `#x` в рамке `srcdoc` с `allow-same-origin` во всех трёх движках ведёт не на якорь, а на `<страница кабинета>#x`: рамка уходит и показывает ошибку, потому что кабинет запрещает себя встраивать. В маршруте `#x` — переход внутри документа.
- **Средняя кнопка.** Если кабинет отменяет только `click`, средняя кнопка в Chromium и Firefox открывает ссылку рамки в новой вкладке, хотя у песочницы нет `allow-popups`. Нужен ещё `auxclick`. WebKit для Linux открывает новую вкладку и так — отменить это в нём нечем; WebKit для macOS уводит саму рамку.
- **`srcdoc` без meta CSP.** Chromium скачивает `<script src>`, а вложенный `<iframe src>` скачивают все три движка, хотя не выполняют их: адрес зрителя уходит наружу (исправлено проверкой: было «только Chromium»). В стенде «чужой» origin стоял в `frame-src` кабинета; вложенную рамку на другой сайт `frame-src` кабинета не пустит.
- **`<noscript>`.** В рамке без скриптов содержимое `<noscript>` разбирается как разметка и показывается: `<img>` внутри него в `srcdoc` без meta CSP загрузился с cookie кабинета. `parse5` по умолчанию (`scriptingEnabled: true`) разбирает `<noscript>` как текст и id внутрь не ставит; с `scriptingEnabled: false` — ставит, как и видит браузер.
- **adoption agency и foster parenting.** В синтетическом лендинге `<b>жирный<p>абзац</b>хвост</p>` дал клон `<b>` с тем же id; правка клона получила отказ `AMBIGUOUS_ID`. Текст «фостер», вынесенный из таблицы, лежит в разборе со смещениями, которые накрывают и разметку таблицы; его правка на сервере получает отказ `TEXT_NOT_IN_PLACE`.
- **DOM clobbering.** `<img name="addEventListener">`, `<img name="body">`, `<form name="documentElement">` и подобные подменяют методы и свойства документа рамки: `doc.addEventListener` падает, `doc.body` — это `<img>`. Вызовы через `EventTarget.prototype.addEventListener.call(doc, …)` и `Document.prototype` окна кабинета работают.
- **Пробелы.** WebKit и Firefox в `plaintext-only` при `white-space: normal` превращают набранные пробелы в неразрывные; Chromium — только в `contenteditable="true"`. С `white-space: pre-wrap` на время правки неразрывных не появилось ни в одном движке.
- **Enter.** В `plaintext-only` Chromium вставляет `\n` в текст, WebKit и Firefox — `<br>`. Отменить нажатие (`beforeinput`) можно только там, где работают обработчики.
- **Сочетания клавиш без окна.** Cmd+B у headless WebKit на macOS ничего не делает (нет меню «Формат»), Ctrl+B у Firefox тоже. В настоящих браузерах это не проверено.
- **COEP.** Если кабинет начнёт слать `Cross-Origin-Embedder-Policy: require-corp`, маршрут без COEP перестанет грузиться во всех движках; `srcdoc` его наследует.

### Ошибка продукта, найденная по дороге

Страница для чтения документа (`readingPage`, вид `page` плана 74) показывается в кабинете в `<iframe srcDoc sandbox="allow-popups allow-popups-to-escape-sandbox">` (`apps/web/src/components/chat/agent-document.tsx:322-326` и `:453-457`).

- Её якоря `#doc-…` (`packages/doc-render/src/rules.ts:137-138`) и ссылки от корня сайта (`treeLinks: true`, `packages/doc-render/src/reading-page.ts:64`) разрешаются от адреса кабинета: у документа `srcdoc` базовый адрес — адрес родителя.
- Клик уводит рамку на страницу кабинета, а кабинет запрещает встраивать себя (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). В стенде с заголовками кабинета (`probe-srcdoc-anchor.mjs`, macOS и Linux):

  | Ссылка | Chromium | WebKit | Firefox |
  | --- | --- | --- | --- |
  | `#doc-razdel` | `chrome-error://chromewebdata/` — документ потерян | `<кабинет>/cabinet#doc-razdel` — документ потерян | адрес остаётся `about:srcdoc`, но в рамке страница ошибки Firefox «Nightly Can’t Open This Page … will not allow Nightly to display the page if another site has embedded it» — документ потерян (исправлено проверкой: проба смотрела только адрес) |
  | `/uslugi/remont` | `<кабинет>/uslugi/remont` | `<кабинет>/uslugi/remont` | `<кабинет>/uslugi/remont` |
  | `about:srcdoc#doc-razdel` | остаётся, `about:srcdoc#doc-razdel` | остаётся | остаётся |

- Возможная правка: в копии для `srcdoc` писать якорь как `about:srcdoc#doc-…` — рамка остаётся на месте во всех трёх движках (проверка: и прокручивается к заголовку — по пикселям снимка, `verify/`, группа `anchor2`). Ссылкам от корня в кабинете вести некуда — у документа там нет сайта, их лучше показывать словами, как при `treeLinks: false`.

Код продукта не менялся.

---

## Что это значит для плана 88

- **Ар9 — меняется.** Рамка правки подтверждена, запасной путь (миниатюра и карта рамок с сервера) не нужен. Меняется то, как кабинет с ней работает: обработчиков внутри рамки нет. Предлагаемый текст пунктов:
  - «Кадр открывается в рамке правки без скриптов. Это маршрут кабинета `/api/artifact-frame/<токен>` вне `headers()` `next.config.ts`: `sandbox="allow-same-origin"` без `allow-scripts` в атрибуте и в CSP, `script-src 'none'`, `default-src 'none'`, `frame-ancestors 'self'`. Скрипты артефакта в ней не выполняются ни в одном движке, подделать правку нечем (спайк 1).»
  - «Кабинет не опирается на обработчики внутри рамки: WebKit (Safari, браузеры iPhone) их не вызывает. Мышь и касания кабинет берёт на своём слое над рамкой (у рамки `pointer-events: none`), элемент находит `elementFromPoint`, обводку рисует сам поверх рамки и пересчитывает её на своём `requestAnimationFrame`: о прокрутке рамки WebKit кабинету не сообщает. В Chromium и Firefox обработчики на `contentDocument` работают, но второго пути под них не делаем.»
  - «Правка — родной `contenteditable="plaintext-only"` на одном элементе. Каретка ставится из точки клика (`caretPositionFromPoint`), изменения читает MutationObserver кабинета, конец правки — клик по узлу кабинета или «Готово». Перевод строки (`<br>` в WebKit и Firefox, `\n` в Chromium) кабинет приводит к тексту при фиксации. На телефоне — своё поле кабинета поверх элемента.»
  - «Сервер ставит id и правит исходник по смещениям `parse5` (`sourceCodeLocationInfo`, `scriptingEnabled: false` — как разбирает браузер без скриптов). Правка — замена «щелей текста» элемента между его дочерними элементами. Если id повторяется (клон adoption agency), смещение текста не совпадает с его значением или состав элемента изменился — отказ. Живой DOM не сериализуется.»
  - «Копия для правки отличается от хранимой только тем, что ссылки ведут на фрагмент без цели, без `target`, `ping` и `download`, и в ней нет `<base>` и `<meta http-equiv="refresh">`: отменить переход по ссылке в WebKit нечем.» Ссылками считаются и `xlink:href` у `<a>` в SVG, и `href` у элементов MathML: `editCopy` спайка их не трогает, и они уводят рамку — SVG во всех трёх движках, MathML в WebKit и Firefox (исправлено проверкой).
- **Ар27 — держится.** Из рамки правки кабинет берёт только `data-rid`, который поставил сервер. Текст элемента сервер берёт из проверенного блока.
- **Ар28 — дополняется** пунктом о рамке правки: «Рамка правки (Ар9) — отдельный элемент `<iframe>` с постоянным `sandbox`. Режимы «Просмотр» и «Править текст» — разные элементы (в React — `key` по режиму): Chromium и Firefox грузят новый документ со старыми флагами, если источник поменяли раньше `sandbox`» (исправлено проверкой: было «Chromium»; с маршрутом и его CSP старые флаги отнимают у кабинета доступ к рамке, скрипт не запускают). Правило «Никогда — `srcdoc` со скриптами и origin кабинета» держится.
- **Ар29 — держится.** Добавить: «В рамке правки моста нет: кабинет читает её DOM сам и вызывает методы через прототипы своего окна — имена элементов (`<img name="addEventListener">`) подменяют методы документа рамки».
- **Ар49 — уточняется:** «Править текст» на телефоне — полем кабинета поверх элемента.
- **§7.7 «Макет»** — «Выбрать элемент» и «Править текст» показывают рамку правки вместо `/v/` с `ARTIFACT_SANDBOX`. В ней скрипты макета не работают: нет того, что строит JS, виден `<noscript>`. Подпись в кабинете: «В режиме правки скрипты макета выключены».
- **§7.9 — добавить:**
  - маршрут `app/api/artifact-frame/[token]/route.ts`: роль зрителя при каждом GET (cookie сессии до маршрута доходит), заголовки — ниже;
  - `next.config.ts`: `source: '/((?!v/|api/artifact-frame/).*)'` и контракт `next-config.test.ts`. Путь под `/api/` `proxy.ts` не трогает (`UNTOUCHED`), поэтому его CSP маршрут не заменит;
  - компонент рамки правки: слой кабинета, `useFrameDocument` (подключение на `load`, `AbortController`, снятие при размонтировании), MutationObserver, фиксация;
  - e2e: корпус векторов этого спайка на рамке правки в Chromium, WebKit и Firefox.
- **Заголовки маршрута рамки правки:**

  ```text
  Content-Type: text/html; charset=utf-8
  Content-Security-Policy: sandbox allow-same-origin; default-src 'none'; script-src 'none';
    style-src 'unsafe-inline'; img-src data: blob: <корень страниц>; font-src data: <корень страниц>;
    media-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none';
    object-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; frame-ancestors 'self'
  X-Frame-Options: SAMEORIGIN        (при frame-ancestors браузеры его не читают)
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Cache-Control: no-store
  Cross-Origin-Resource-Policy: same-origin
  X-Robots-Tag: noindex, nofollow, noarchive
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()
  ```

  `<корень страниц>` — для подписанных адресов файлов артефакта (Ар12); шрифтам с него нужен ещё `Access-Control-Allow-Origin` (спайк 2). Если кабинет начнёт слать `Cross-Origin-Embedder-Policy: require-corp`, маршрут должен слать его тоже.
- **§7.13, строка «Правка HTML»** — дописать: `scriptingEnabled: false`, «щели текста», отказы `AMBIGUOUS_ID`, `TEXT_NOT_IN_PLACE`, `SHAPE_CHANGED`; копия для правки без адресов ссылок.
- **§8.4 — добавить вариант (е):** «Рамка правки на origin кабинета без скриптов — выбрана для «Выбрать элемент» и «Править текст». `srcdoc` для неё хуже маршрута: нужна meta CSP первой в `head`, якорные ссылки уводят рамку на адрес кабинета, HTML идёт через tRPC».
- **§9 — новые строки рисков:**

  | Риск | Чем держим |
  | --- | --- |
  | Safari не вызывает обработчики кабинета в рамке правки | Слой кабинета над рамкой, `elementFromPoint`, MutationObserver; обработчики в рамке не нужны (Ар9) |
  | В атрибут рамки правки попал `allow-scripts` | CSP маршрута `sandbox allow-same-origin` ложится поверх атрибута: в спайке ничего не выполнилось и `meta refresh` не увёл рамку. У `srcdoc` с meta CSP в том же случае `meta refresh` уводит рамку на чужой сайт. Плюс тест-контракт атрибута и e2e векторов |
  | Один `<iframe>` переключают между просмотром и правкой | Разные элементы (`key` по режиму), `sandbox` не меняется у живого элемента |
  | Имена элементов подменяют методы документа рамки | Вызовы через `Document.prototype` и `EventTarget.prototype` кабинета |
  | Переход по ссылке рамки правки: WebKit не даёт отменить, средняя кнопка открывает вкладку (Chromium и Firefox — без `auxclick`, WebKit для Linux — всегда) | Копия для правки без адресов ссылок, в том числе `xlink:href` SVG и `href` MathML (исправлено проверкой), слой кабинета вне правки, `auxclick`. Переход рамки на сторонний сайт блокирует `frame-src` кабинета; уводят её только адреса домена страниц и кабинета. Во время правки WebKit для Linux средней кнопкой всё равно откроет вкладку — с переписанным адресом в ней будет та же копия без скриптов (не проверено) |
  | Кабинет вызвал `contentWindow.eval`, `Function` или `setTimeout(строка)` рамки | Правило кода и проверка в ревью: никогда. CSP `script-src 'none'` маршрута запрещает их во всех трёх движках (исправлено проверкой: было «кроме Firefox»); в `srcdoc` без meta CSP их выполняют все три |
  | Рамка правки на origin кабинета — любая ошибка даёт доступ ко всему кабинету | Три независимые линии: атрибут, CSP `sandbox`, `script-src 'none'`; при открытии вкладкой ничего не выполняется |
  | Тяжёлый документ рамки правки вешает кабинет: у них один origin и один процесс | Только выбранный кадр в режиме правки; в WebKit для Linux `<audio>` с картинкой вместо звука занял процессор на 100 % и повесил страницу — CSP `media-src data:` такой запрос не пускает |
- **§10, Э0а, п. 1 — сделан**, итог — этот отчёт. В Э5 (88.12, 88.13) — маршрут рамки правки, слой кабинета, MutationObserver и фиксация, «щели текста», копия без адресов ссылок, e2e корпуса векторов в трёх движках.

---

## Не подтверждено

- **Не настоящие Safari, Chrome и Firefox.** Сборки Playwright без окна: WebKit 26.6 — не выпуск Safari, Chromium — headless shell. Причина отказа WebKit выведена из сообщения консоли («Blocked script execution … the 'allow-scripts' permission is not set»), исходный код WebKit не читался.
- **Firefox — только Linux** (ВМ Docker, arm64). На macOS 27 сборка 1543 не запустилась.
- **Телефонов не было.** Касания — эмуляция Playwright: `isMobile` и `hasTouch` у Chromium, только `hasTouch` у WebKit и Firefox. Покажет ли iPhone клавиатуру, когда кабинет ставит фокус в рамку программно, не проверено; поэтому на телефоне предложено своё поле кабинета.
- **Ввод.** У Playwright нет кириллической раскладки: русский текст шёл через `insertText`, по символу. Настоящий русский IME — только через `Input.imeSetComposition` CDP и только в Chromium. Сочетания клавиш macOS (Cmd+Z, Cmd+B) Playwright переводит в команды правки сам; в обычном Safari они могут вести себя иначе.
- **Вставка.** Богатый HTML клал в буфер обработчик `copy` кабинета, а не Google Docs или Word.
- **Next.js не запускался.** Заголовки кабинета повторены сервером стенда. Что `headers()` нельзя перекрыть из маршрута, а ответ `proxy.ts` перекрывает их, — из c1 §17 и плана 67, здесь не перепроверено.
- **Снимки экрана** — только при масштабе 1 (`deviceScaleFactor` по умолчанию); экраны с плотностью 2–3 не проверялись.
- **WebKit для Linux** — это WPE с GStreamer, а не Safari и не GNOME Web; зависание на `<audio>` с картинкой проверено только там.
- **Корпус синтетический.** Векторы и лендинг написаны вручную; макеты GLM могут содержать конструкции, которых здесь нет.
- **Не проверялись:** враждебный CSS артефакта против правки (`user-select: none`, `pointer-events`, `-webkit-user-modify`), перетаскивание в редактируемый элемент, читалки экрана, нагрузка и память.

---

## Проверка

Независимая проверка 19.11.2026 (скептик этапа Э0а). Код продукта не менялся. Время не замерялось. На машине шли проверки других спайков: `uptime` в начале работы — load average 113.68 за минуту, во время прогонов на macOS — от 1.76 до 9.04, в ВМ Docker — от 0.00 до 1.89.

### Что перезапущено

- **Таблицы 1–6** заново собраны `tables.mjs` из `results/*.json`: все 221 строка совпали с README. Ручных правок в таблицах не было.
- **Числа сервера** (`stamp.mjs` на лендинге): 49 штампов, повтор `e28`, неверное смещение у «фостер» — совпали.
- **Firefox 1543 на macOS 27** — та же ошибка: «Could not find profile folder» (`verify/ffmac.mjs`).
- **Next.js 16.3.6.** В его `server/send-response.js` заголовок ответа маршрута добавляется, только если такого ещё нет (кроме `set-cookie` и ещё трёх). Поэтому `headers()` из `next.config.ts` маршрут не перекроет, а его CSP просто отбросится. Вариант стенда «две CSP» в настоящем Next.js был бы «только CSP кабинета» — рамка не грузится и так. Исключать маршрут из `headers()` нужно, вывод верен.

### Своя проверка

Свой стенд в `verify/`: сервер `vserver.mjs`, проверки в браузерах `vcheck.mjs` и `vnested.mjs`, серверная правка `vparse.mjs`. Отличия от стенда спайка:

- три origin: кабинет, корень страниц и сторонний сайт; сторонний сайт, в отличие от стенда спайка, не входит в `frame-src` кабинета;
- свой корпус векторов, метки — через `localStorage` кабинета, маяки на два других origin и `postMessage`;
- рамку ставит `page.evaluate` без `harness.js`; `eval` кабинета вызывается ещё и из собственного скрипта кабинета по настоящему клику.

Браузеры — те же сборки Playwright 1.63.0 без окна: Chromium 153.0.8010.12 и WebKit 26.6 — на macOS и в Linux (Docker, arm64), Firefox 155.0 — только в Linux. Сводные ответы — `verify/results/darwin.json`, `linux.json`, `parse5.json`.

**Новые векторы** (ни одного из корпуса спайка). Все, кроме одного, выполнились в контроле без песочницы во всех трёх движках. В рамке правки не выполнился ни один — в маршруте с CSP правки, в `srcdoc` с meta CSP и в маршруте с попавшим в атрибут `allow-scripts`:

- 14 на загрузке: вложенная рамка с `sandbox="allow-scripts allow-same-origin"`, рамка `data:`, SVG в `<object>` (`onload` и `<script>`) и в `<embed>`, `onanimationstart`, `<video onerror>`, `<input type="image" onerror>`, `<link rel="preload" onload>`, `<select autofocus onfocus>`, `<set onbegin>`, `<img onerror>` в декларативном shadow DOM, `<body onpageshow>`, `<script>`;
- 4 по клику: `<svg><a xlink:href="javascript:…">`, `formaction="javascript:…"`, `javascript:` с `target="_top"`, `<details ontoggle>`;
- 4 разметкой, которую кладёт кабинет: `execCommand("insertHTML")`, `createContextualFragment`, `insertAdjacentHTML`, `setHTMLUnsafe`. В контроле выполнились все, кроме `insertHTML` в WebKit.

Вставка из буфера богатого HTML с `<img onerror>` в `contenteditable="true"` не выполнилась нигде, даже в контроле: движки сами вырезают обработчики при вставке. Положительного контроля у этого вектора нет.

**Сеть с предложенной CSP.** Корень страниц добавлен в `img-src` и `font-src`; в стенде спайка его не было. Из маршрута уходят только картинка и шрифт с корня страниц. Не уходят: сторонний `@import`, картинка, фон и `prefetch`, стили с корня страниц (`style-src` их не пускает), `<audio>` и картинка с origin кабинета. В `srcdoc` с meta CSP картинка с корня страниц не грузится: `srcdoc` наследует `img-src` кабинета.

### Вердикты

| Утверждение | Вердикт | Чем проверено |
| --- | --- | --- |
| В рамке правки не выполнился ни один из 40 векторов («0 из 40») | исправлено | По `results/*.json`: 0 из 31 строки артефакта и 0 из 6 строк разметки кабинета. Строки `parent-eval` и `parent-function` выполнились в `srcdoc` без meta CSP во всех движках, `parent-settimeout-string` — в Firefox там же. Отчёт называет это исключением, но число «0 из 40» неверно |
| В контроле выполнились 38 из 40, кроме `marquee onstart` и `meta refresh` на `javascript:` | подтверждено | `results/*.json` |
| Маршрут, открытый вкладкой: 23 → 0 | подтверждено | Свой документ: 2 метки и 4 маяка в контроле → 0 |
| Firefox выполняет `eval` и `Function` кабинета и при CSP `script-src 'none'` | опровергнуто | Группа `feval3`: вызов из скрипта кабинета по клику Firefox отклоняет (`EvalError: call to eval() blocked by CSP`) — в маршруте и в `srcdoc` с meta CSP. Выполняет, только если вызов начат в `page.evaluate` Playwright, а стенд спайка вызывал `H.parentVectors` именно так. Chromium и WebKit отклоняют при любом вызове. CSP кабинета решения не меняет (группа `feval2`): решает CSP рамки |
| `srcdoc` без meta CSP: `eval` и `Function` выполняются, Firefox выполняет и `setTimeout(строка)` | подтверждено | `feval3`: так при любом вызове. Правило «кабинет не вызывает…» остаётся |
| WebKit не вызывает обработчики кабинета на узлах рамки; MutationObserver и ResizeObserver работают | подтверждено | Группа `listeners`, macOS и Linux: три способа подписки (через прототип, свой метод документа, `onmousedown`) и `scroll` окна — 0; наблюдатели срабатывают. В консоли — то же «Blocked script execution …» |
| Chromium и Firefox вызывают обработчики; `preventDefault` в capture `click` и `auxclick` останавливает переход; WebKit — нет | подтверждено | Группы `listeners` и `cancel`. Уточнение: «34 типа» — это 32 типа на документе и 2 на окне; `focus` и `blur` в Chromium — только capture |
| Ссылки уводят рамку, «ушла + запрос» | исправлено | «Чужой» origin стенда был доменом страниц из `frame-src` кабинета. На сторонний сайт `frame-src` рамку не пускает, запроса нет: в Chromium — страница ошибки, в WebKit и Firefox документ остаётся. Уводят адреса домена страниц и кабинета |
| Путь без обработчиков (слой кабинета, `elementFromPoint`, каретка из точки, родной ввод, MutationObserver, конец правки на узлах кабинета) | подтверждено | Группа `overlay`, своя реализация: отдельный слой над рамкой, точка по Range текста, `caretPositionFromPoint`, `keyboard.type` и `insertText`. Три движка, текст встал ровно в точку клика. Фиксацию на сервер не повторял, её покрывает `vparse.mjs` |
| Копия для правки: ни одна ссылка не уводит рамку | опровергнуто | Группа `editcopy` и `parse5.json`: `editCopy` не трогает `xlink:href` у SVG `<a>` (уводит рамку во всех трёх движках) и `href` у MathML (уводит в WebKit и Firefox). `form action` и `formaction` тоже остаются, но их держат CSP `form-action 'none'` и песочница |
| Доставка: заголовки кабинета — не грузится; вне `headers()` — грузится; `frame-ancestors 'self'` перекрывает `X-Frame-Options: DENY`; cookie доходит | подтверждено | Группа `delivery`, три движка; исходник Next.js 16.3.6 |
| CSP `sandbox` маршрута держит попавший в атрибут `allow-scripts`; у `srcdoc` с meta CSP тогда уводит `meta refresh` | подтверждено | Группы `safety` (`routeSlip`) и `slip` |
| `srcdoc` без meta CSP: «в Chromium ещё `prefetch`, `<script src>` и `<iframe src>`» | исправлено | `results/*.json`: `prefetch` уходит и в Firefox. Вложенный `<iframe src>` скачивают все три движка, `<script src>` — только Chromium. Наружу вложенная рамка идёт лишь на домен страниц: `srcdoc` наследует `frame-src` кабинета (`vnested.mjs`, три движка) |
| Один `<iframe>` «просмотр ↔ правка»: при источнике раньше `sandbox` Chromium и Firefox грузят правку со старыми флагами и выполняют её скрипт | исправлено | Группа `toggle`, чистый DOM: скрипт выполняется, только если у документа правки нет своей CSP. В тесте спайка это был `srcdoc` без CSP. С маршрутом и CSP правки скрипт не выполняется, но кабинет теряет доступ к рамке. WebKit применяет новые флаги при любом порядке. Вывод «свой элемент, `key` по режиму» верен |
| React: `onClick` на обёртке рамки не срабатывает; шаблон `useFrameDocument` | не проверить | React не перезапускал. События документа рамки в документ кабинета не всплывают — это следует из DOM |
| parse5: `scriptingEnabled: false`, `AMBIGUOUS_ID`, `TEXT_NOT_IN_PLACE`, байты вне диапазонов целы | подтверждено с уточнением | `vparse.mjs`. Клон adoption agency делает неправимым и оригинал. `TEXT_NOT_IN_PLACE` при foster parenting — только когда вынесенный текст слился с соседним; одинокий вынесенный текст правится верно. Новые входы правятся верно: `<pre>` с переводом строки, CRLF, `&amp` без `;`, неявные `</li>`, ВЕРХНИЙ РЕГИСТР, `<svg><text>`, разметка в новом тексте, `&nbsp;`. Вставка в пустую щель после элемента с неявным концом — `CHECK_FAILED`. Стенд спайка проверяет байты только до первого и после последнего диапазона |
| DOM clobbering ломает `doc.addEventListener`; вызовы через прототипы кабинета работают | подтверждено | Группа `clobber`, три движка |
| Enter: `\n` в Chromium, `<br>` в WebKit и Firefox; неразрывные пробелы при `normal` и их отсутствие при `pre-wrap`; вставка в `plaintext-only` — простым текстом | подтверждено | Группа `typing`, три движка: неразрывных 0, 2, 2 при `normal` и 0 при `pre-wrap` |
| COEP `require-corp` у кабинета: маршрут без COEP не грузится | подтверждено | Группа `coep`, три движка |
| WPE зависает на `<audio>` с картинкой | не проверить | Не воспроизводил: мой сервер отдавал на `<audio>` 404 |
| Ошибка продукта: якоря и ссылки от корня в `srcdoc` страницы для чтения уводят рамку; правка — `about:srcdoc#…` | подтверждено и исправлено | Группы `anchor` и `anchor2`, атрибут как в продукте, проверка по пикселям. В Firefox документ теряется тоже: адрес остаётся `about:srcdoc`, но в рамке страница ошибки, а проба спайка смотрела только адрес. `about:srcdoc#doc-…` в трёх движках не только оставляет документ, но и прокручивает к заголовку |

### Для плана 88

- **Ар9 — держится с поправками.**
  - Копия для правки убирает и `xlink:href` у SVG, и `href` у MathML.
  - «Перевод строки кабинет приводит к тексту при фиксации» спайк не проверял. Его фиксация с `<br>` получила бы `SHAPE_CHANGED_IN_FRAME`, а в тестах перевод строки стирали до фиксации. Это нужно сделать и проверить в Э5.
  - Прокрутка касанием при `pointer-events: none` у рамки не проверялась: на телефоне слою кабинета, вероятно, придётся пересылать её самому.
  - Ещё одна линия, проверенная во всех трёх движках. Запрос рамки приходит с `Sec-Fetch-Dest: iframe` и `Sec-Fetch-Site: same-origin`, открытие вкладкой — с `document` и `none`. Маршрут может отказывать всему, кроме рамки того же origin. Это защита на случай потери CSP: при открытии вкладкой атрибута `sandbox` нет, и обе оставшиеся линии сидят в одном заголовке.
- **Ар27, §7.7, §7.13, §10 — держатся.** В §7.13 — уточнение про foster parenting.
- **Ар28 — держится.** Старые флаги после смены источника — в Chromium и Firefox. С маршрутом они отнимают у кабинета доступ к рамке, скрипт не запускают.
- **Ар29 — исправить.** Фраза «Firefox выполняет их даже при CSP `script-src 'none'`» неверна. Правило «кабинет не вызывает `eval`, `Function` и `setTimeout(строка)` рамки» остаётся.
- **Ар49 — частично.** «Своё поле поверх элемента» проверено только в окне компьютера с клавиатурой. На эмуляции телефона проверялись касание, каретка, `insertText` и выбор через слой.
- **§7.9 — держится с поправками.**
  - Заголовки с корнем страниц проверены этой проверкой: уходят только картинки и шрифты корня страниц.
  - `style-src 'unsafe-inline'` не пустит стили с корня страниц. Если макеты подключают стили платформы, корень страниц нужен и там.
  - e2e в WebKit и Firefox: CI ставит только Chromium (`browser.yml`), а Firefox 1543 на macOS 27 не запускается. Прогон Firefox возможен только в Linux и CI.
- **§8.4 — держится.** Четвёртый довод против `srcdoc`: он наследует `img-src` и `frame-src` кабинета, картинки корня страниц в нём не показываются.
- **§9 — исправить.** Строка про `eval`: CSP маршрута держит во всех трёх движках. Строка про переходы: добавить `xlink:href` и MathML и то, что `frame-src` кабинета не пускает рамку на сторонние сайты.

### Метод и гигиена

- Версии браузеров и пакетов совпадают с отчётом. Все браузеры без окна, Chromium — headless shell, касания — эмуляция. Память не замерялась.
- Положительный контроль есть у всех векторов скрипта. Не выполнились нигде два вектора спайка и мой вектор вставки — они в счёт защиты не идут.
- Подброшенных ошибок спайк не делал. Ошибки стенда нашлись проверкой: `eval` через `page.evaluate` в Firefox, проба якоря только по адресу, «чужой» origin внутри `frame-src` кабинета.
- В папке нет абсолютных путей, имён, почты, `node_modules`, lock-файлов и двоичных файлов. С `verify/` она занимает 880 КиБ.
