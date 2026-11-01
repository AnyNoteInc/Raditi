# Пробел 10: сессии сайта в межсайтовом iframe предпросмотра

Дата: 01.11.2026. Статус: готово. Код репозитория не менялся. Пути без префикса — от корня `raditi-stacks`.

## 1. Ответ

**Сейчас любая CMS с сессией в кадре кабинета сломана, и ломается тихо.** Настоящий OpenCart 4 пишет «Success: You have added iPhone to your shopping cart!», а корзина пуста. Настоящая Joomla 5 на отправке формы уходит в петлю: `ERR_TOO_MANY_REDIRECTS` в Chromium, в WebKit кадр остаётся на форме без единого сообщения. Причина: браузер отбрасывает такие куки ещё при записи, а не только не отправляет их.

**Решение:** шлюз переписывает каждый `Set-Cookie` сайта на `Secure; SameSite=None; Partitioned`, безусловно и без знания о стеке. Правка на десяток строк в `siteSetCookie`. На настоящих OpenCart и Joomla она вылечила оба сценария в Chromium 153, в Chromium с заблокированными сторонними куками и в WebKit 26.6.

- `session.cookie_samesite` в базовый ini **не добавлять**. Он закрывает только часть кук, без `Partitioned` не работает в WebKit, а на схеме MODX даёт `SameSite=None` без `Secure`, и такая кука отклоняется Chromium и в обычной вкладке.
- `SameSite=None; Secure` **без** `Partitioned` не подходит: WebKit её не держит, а Chromium отправляет с POST со стороннего сайта.
- «Открыть в новой вкладке» остаётся запасным путём и единственным полным для кук из JavaScript и для Safari младше 26.2. Кнопка уже есть (`apps/web/src/components/chat/preview-pane.tsx:173-182`).
- Шлюз после правки остаётся нейтральным к стеку, контракт адаптера не меняется. Строка `config_session_samesite` у OpenCart (`opencart.md:400`) становится не нужна.

Заодно нашлись три вещи рядом, раздел 6. Главная: заявка `raditi-preview.ru` в Public Suffix List отключит защиту шлюза от соседних предпросмотров, поэтому `fromSiblingSite` надо заменить до заявки.

## 2. Замеры

Стенд: Chromium 153 и Playwright WebKit 26.6, точная строка `PREVIEW_SANDBOX` (`apps/web/src/components/chat/preview-frame.tsx:37-38`), имена `raditi.ru` и `site-…-chat-….raditi-preview.ru`, TLS. Вместо шлюза — прокси с той же логикой `Set-Cookie`, настоящий шлюз в проходе не участвовал. OpenCart 4.1.0.4 и Joomla 5.4.10 подняты тем же `preview-up.sh`, что у спайка, настройка OpenCart возвращена к штатной `Strict`. Сторонние куки блокировал `Network.setCookieControls`, контроль подтвердил: обычная `None; Secure` отброшена, `Partitioned` живёт. Настройки профиля и флаг `--test-third-party-cookie-phaseout` блокировку не включили.

### Настоящие CMS в кадре кабинета

| Браузер | Как сейчас (снят только `Domain`) | `None; Secure` | `None; Secure; Partitioned` |
| --- | --- | --- | --- |
| Chromium 153 | OpenCart: корзина пуста. Joomla: `ERR_TOO_MANY_REDIRECTS` | работает | **работает** |
| Chromium 153, сторонние заблокированы | то же | то же, что сейчас | **работает** |
| WebKit 26.6 | OpenCart: корзина пуста. Joomla: петля 303, на экране прежняя форма | то же, что сейчас | **работает** |

«Работает» здесь значит: товар в корзине, Joomla приняла форму и отказала по паролю («Username and password do not match»). Во вкладке всё работает и как сейчас, и с переписанными куками (проверено на `http://*.localhost` в Chromium).

Настоящие строки до правки:

```
OCSESSID=…;  expires=…; Max-Age=86400; path=/; secure; HttpOnly; SameSite=None   (None подставил спайк, штатно Strict)
currency=USD; expires=…; Max-Age=2592000; path=/; secure; HttpOnly; SameSite=Lax
<hidden>=…; path=/; HttpOnly                             (Joomla, без SameSite и Secure)
```

### Какие куки выживают в кадре

| Запись | Chromium 153 | WebKit 26.6 |
| --- | --- | --- |
| `Set-Cookie` без атрибута, `Lax`, `Strict` | отброшена | отброшена |
| `Set-Cookie` с `SameSite=None` без `Secure` | отброшена | отброшена |
| `Set-Cookie` с `SameSite=Lax; Secure; Partitioned` | отброшена | не мерил |
| `Set-Cookie` с `None; Secure` | живёт | отброшена |
| `Set-Cookie` с `None; Secure; Partitioned` | живёт | живёт |
| `document.cookie` без атрибута или с `Lax` | отброшена | отброшена |
| `document.cookie` с `None; Secure` | живёт | отброшена |
| `document.cookie` с `None; Secure; Partitioned` | живёт | живёт |

Навигация кадра, `fetch` и POST формы ведут себя одинаково. Выводы:

- `Partitioned` нужен не «для Safari», а для всех: он один проходит и WebKit, и блокировку сторонних.
- Важен и `SameSite=None`: `Lax; Secure; Partitioned` Chromium отбрасывает. Поэтому шлюз обязан заменять `SameSite`, а не дописывать `Partitioned`.
- `dev` воспроизводит прод: `http://localhost` и `http://site-a-chat-b.localhost` межсайтовы для Chromium, кука без атрибута там так же отброшена, а `Secure` на `*.localhost` принимается. Для приёмки не нужны ни TLS, ни подмена имён.

### Банки кук

- Кадр и вкладка — разные банки: вкладка не видит разделённые куки кадра. Вошедший в админку в кадре во вкладке входит заново, корзины разные. Вреда нет, но поддержке и приёмке это надо знать.
- Страница чужого сайта (`evil.example`): кадр и POST с `credentials: 'include'` несут `SameSite=None; Secure` и не несут `Partitioned`. WebKit не отправляет ни ту, ни другую. Значит, переписывание с `Partitioned` не расширяет CSRF за пределы кабинета, а без него расширяет.

## 3. Варианты

| Вариант | Что закрывает | Что не закрывает | Вердикт |
| --- | --- | --- | --- |
| Шлюз: `Secure; SameSite=None; Partitioned` всем | Все CMS, все версии PHP, куки с `setcookie` и сессий, ответы WebSocket (`tunnels.ts:104,138` идут через ту же функцию). Без кода стека | JavaScript, Safari младше 26.2 | **Брать** |
| `session.cookie_samesite` в ini | Только куку PHP-сессии: Joomla, MODX, `PHPSESSID` Битрикса | Раздел ниже | Нет |
| Настройки самой CMS в `overrides` | Что объявит адаптер | На стек своя правка, `currency` и `policy` OpenCart зашиты в код | Нет |
| `SameSite=None; Secure` в шлюзе | Chromium без блокировки | WebKit, блокировка, CSRF со стороннего сайта | Нет |
| Только отдельная вкладка | Всё, в том числе JavaScript и старый Safari | Кадр рядом с чатом, вокруг которого построены планы 53 и 59 | Запасной путь |
| Поддомен кабинета | Куки стали бы своими | Нарушает решение владельца от 18.10.2026 (`docs/spec.md:3066`) | Нет |

### Почему ini не годится

1. **OpenCart его не читает.** OC 4 сам зовёт `setcookie` с `samesite` из своей настройки (`catalog/controller/startup/session.php:68,71`, штатно `Strict`, `system/config/default.php:49`), а `currency`, `policy`, `language` зашиты как `Lax` (`startup/currency.php:45`, `common/cookie.php:60`, `admin/controller/common/language.php:98`). Поэтому override `config_session_samesite=None` из `opencart.md:400` тоже не спасает: `currency` остаётся `Lax` (видно в строках выше). OC 3 зовёт `setcookie` с пятью аргументами, без `SameSite` вовсе ([`framework.php`](https://raw.githubusercontent.com/opencart/opencart/3.0.x.x_Maintenance/upload/system/framework.php)). WordPress свои куки тоже ставит сам.
2. **Нет `Partitioned`.** `partitioned` появился в PHP 8.5 ([`UPGRADING`](https://raw.githubusercontent.com/php/php-src/PHP-8.5/UPGRADING), [RFC](https://wiki.php.net/rfc/CHIPS)), а основа образов — 7.4–8.5 (`tests-ci-env.md:254`). Без него ini-вариант падает в WebKit и при блокировке.
3. **Ловушка синтаксиса.** В ini слово `None` без кавычек — пустое значение. Замер на PHP 8.3.36: `-d session.cookie_samesite=None` даёт `string(0) ""`, в кавычках — `"None"`. Настройка молча не сработает.
4. **Может ухудшить.** MODX передаёт `secure` массивом из своей настройки, по умолчанию `false`, а `samesite` — только если настройка не пуста ([`modX.php`, `configureSession`](https://raw.githubusercontent.com/modxcms/revolution/3.x/core/src/Revolution/modX.php)). Замер той же схемы при ini `"None"` и `session.cookie_secure=1`: `secure=false samesite=None`. Такую куку Chromium отбрасывает и во вкладке, то есть и в браузере агента. Тот же эффект спайк поймал на OpenCart: `BLOCKED SameSiteNoneInsecure`, сессия теряется. Joomla с пятью аргументами (`libraries/src/Session/Storage/JoomlaStorage.php:260`) наследует ini правильно: `secure=true samesite=None`.

Битрикс: куки `Bitrix\Main\Web\Cookie` берут `SameSite` из `setSameSite` или настройки `cookies.samesite`, и `None` не включает `Secure` сам ([документация](https://dev.1c-bitrix.ru/api_d7/bitrix/main/web/cookie/getsamesite.php)). Для шлюза это не важно. Настоящим ядром не проверял.

## 4. Договор правки шлюза

`apps/preview/src/gateway/headers.ts:123-131`, логика прогнана на стенде:

```ts
/** What the gateway decides for every cookie of the site: the cabinet's frame is cross-site. */
const GATEWAY_COOKIE_ATTRIBUTE = /^\s*(domain|secure|samesite|partitioned)\s*(=|$)/i

export function siteSetCookie(line: string): string | null {
  const [pair = '', ...attributes] = line.split(';')
  const at = pair.indexOf('=')
  const name = (at < 0 ? pair : pair.slice(0, at)).trim()
  if (name === '' || isGatewayCookieName(name)) return null
  const kept = attributes.filter((attribute) => !GATEWAY_COOKIE_ATTRIBUTE.test(attribute))
  return [pair, ...kept, ' Secure', ' SameSite=None', ' Partitioned'].join(';')
}
```

Правила:

- **Без условий.** Ни по `Sec-Fetch-Dest`, ни по вкладке, ни по стеку. Ответ на XHR тоже ставит куки, а во вкладке `Partitioned` просто ключуется своим сайтом (замер: OpenCart и Joomla работают).
- **`Path`, `Expires`, `Max-Age`, `HttpOnly` остаются.** Удаление куки сайтом проходит той же функцией и попадает в ту же партицию.
- **Браузер агента.** Заходит верхним окном на `http://*.localhost` (`preview-gateway.server.ts:246`), `Secure` там принимается: на этом уже держится кука шлюза (`apps/preview/src/cookie/preview-cookie.ts:12-13`). Куки он нигде не читает: `addCookies`, `storageState` и `.cookies(` в `browser-providers`, `apps/mcp/src/browser`, `apps/core/src/previews` нет.
- **`http://` на другом имени.** Сломался бы, но там нет и куки шлюза, так что нового ограничения нет. В production схема только `https` (`packages/domain/src/preview/preview-config.ts:134`).
- **Тесты.** Поправить ожидания `apps/preview/src/gateway/headers.test.ts:116-117,154` и `preview-gateway.server.test.ts:472`. Добавить: замена `SameSite=Strict` и `lax`, дубль `Partitioned`, удаляющая кука с `Max-Age=0`, имя `__Host-`, отброс куки шлюза.

Документы: `docs/spec.md:790` и план 53, Р19 (`docs/plan/53-chat-preview-release.md:38`) говорят «снимается `Domain`»; `docs/spec.md:3100` и `docs/plan/54-chat-preview-release-report.md:367` закрываются в части входа в админку WordPress; в `opencart.md` пункты `:269,400,792`.

## 5. Куки из JavaScript и Safari

### JavaScript

Шлюз их не перепишет: он не трогает тело ответа (`apps/preview/src/gateway/proxy.ts:132`). В кадре запись без атрибутов молча отбрасывается, ошибки нет. То же с правкой и удалением куки, которую поставил сервер: запись без `Partitioned` не попадёт в её партицию.

Что это задевает, по коду:

- **OpenCart 4.1.0.4:** в своих шаблонах и скриптах `document.cookie` нет.
- **Joomla 5.4.10:** на витрине нет, в админке три куки шаблона Atum (`media/templates/administrator/atum/js/template.js:227,247,275`): цветовая схема и боковая панель.
- **Темы и виджеты клиента:** типичный случай — баннер согласия покажется на каждой странице.
- **Битрикс и MODX:** ядра не читал, сессии у обоих серверные.

Сессия, корзина и токены форм держатся на куках сервера, поэтому это косметика, а не поломка. Предлагаю не лечить. Перехват сеттера `document.cookie` со стенда работает в Chromium и WebKit (`extra.mjs`), но его надо вставить в HTML: либо разбором тела в шлюзе, со сжатием и CSP, либо через `auto_prepend_file` в базовом ini. Обе вставки меняют то, что клиент видит в предпросмотре, ради баннера. Вернуться к нему, только если приёмка (раздел 7) покажет функцию CMS на такой куке.

### Safari

- **26.2 и новее: работает.** WebKit: CHIPS появился в 18.4, убран в 18.5, вернулся в 26.2; без `Partitioned` Safari блокирует межсайтовые куки ([WebKit, Safari 26.2](https://webkit.org/blog/17640/webkit-features-for-safari-26-2/)). [MDN](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Privacy_sandbox/Partitioned_cookies) считает возможность общедоступной с декабря 2025. Замер на сборке WebKit 26.6 совпал.
- **18.5–26.1 и младше 18.4:** атрибут неизвестен, куки отброшены. Это касается не только сессий сайта: кука шлюза тоже не сохраняется, поэтому **предпросмотр в кадре не открывается вообще**, на любой CMS, с WordPress включительно. Цепочка по коду:
  1. `#enter` ставит куку и шлёт на `/` (`apps/preview/src/gateway/entry.ts:133-136`).
  2. Куки нет, `noSession` при `sec-fetch-dest: iframe` шлёт на `frame-ticket` (`entry.ts:87-90`).
  3. Страница просит билет, кабинет отвечает новым кадром (`preview-frame.tsx:128-144`).
  4. Второй запрос приходит быстрее 10 с и молча отбрасывается (`preview-frame.tsx:66-68,138`).
  5. Через 15 с кадр пишет «Обновите страницу кабинета» (`pages.ts:176`). Совет бесполезен: обновление повторит тот же круг, по сессии на круг.
- **Вкладка работает в любой версии:** там куки первого лица.
- **Storage Access API не нужен.** В `PREVIEW_SANDBOX` нет `allow-storage-access-by-user-activation`, нужен жест пользователя и `Partitioned` закрывает задачу проще.

Правка для старых браузеров маленькая. В `PreviewFrame` запрос билета, пришедший быстрее 10 с после ответа, сегодня только отбрасывается. Он означает, что браузер не держит куку шлюза. На этом запросе показать вместо кадра сообщение со ссылкой на вкладку и исправить текст `pages.ts:176`. Определять по `User-Agent` не надо.

## 6. Что нашлось рядом

### Заявка в Public Suffix List отключает защиту от соседей

Шлюз отличает соседний предпросмотр по `Sec-Fetch-Site: same-site` и отвечает 403 (`apps/preview/src/gateway/preview-gateway.server.ts:43-49,187-190,281-284`). Замер, Chromium и WebKit одинаково, кадр соседа внутри кабинета:

| Откуда запрос | `Sec-Fetch-Site` | Кука жертвы |
| --- | --- | --- |
| Сосед на `raditi-preview.ru`, как сегодня | `same-site`, шлюз отказывает | отправлена |
| Сосед на другом регистрируемом домене, как будет после PSL | `cross-site`, шлюз пропустит | отправлена, и с `fetch`, и с POST |
| Вход из кабинета в кадр | `cross-site`, `navigate`, `iframe`, `GET` | отправлена |

Партиция общая, потому что верхний сайт один — кабинет. Сегодня это закрыто ответом 403. После PSL страница одного предпросмотра сможет слать запросы с сессией другого, если клиент открывал оба. `docs/spec.md:3066` называет заявку «позже, к запуску не обязательна» и этого не учитывает. Кука шлюза после PSL будет открыта так же, переписывание добавляет к ней куки сайта.

**Что сделать до заявки:** пропускать межсайтовое только как `GET` с `Sec-Fetch-Mode: navigate`, остальное — 403. POST формы и `fetch` закроются, это проверяемо теми же тремя строками. Останется только GET-навигация своего кадра на чужой предпросмотр: отличить её от входа из кабинета шлюз не может, `Referer` там нет.

### Предел 10 КиБ — один на все предпросмотры

Chromium держит разделённые куки в пределе 10 КиБ на партицию и регистрируемый домен ([Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/JNOQvsTxecI/m/V-OewM3lAwAJ), предел на домен подтверждён замером). До PSL все предпросмотры клиента в кабинете — один домен:

- 6 КиБ в предпросмотре A, потом 6 КиБ в соседнем B: у A осталось 4 куки из 6.
- Тот же объём на другом регистрируемом домене ничего не вытеснил.

Вытесняются самые давние, поэтому страдает старый предпросмотр: теряет сессию сайта или проходит круг нового билета. Две куки шлюза занимают около 130 байт на предпросмотр, кука ревизии живёт 31 день (`apps/preview/src/cookie/preview-cookie.ts:99`). Сейчас делать нечего, это ещё один довод за PSL после замены защиты выше. На WebKit не мерил.

### `confirm()` в кадре молча отвечает «нет»

В `PREVIEW_SANDBOX` нет `allow-modals`. Замер в обоих браузерах: `confirm` даёт `false`, `prompt` — `null`, во вкладке работают; с `allow-modals` работают и в кадре. В OpenCart 4 `confirm(` есть в 66 шаблонах админки, удаление там не сделает ничего и ничего не скажет. Joomla: `libraries/src/Toolbar/Button/ConfirmButton.php:87`. Браузер агента этого не увидит, он работает не в кадре.

## 7. Приёмка: дополнить М2

М2 (`tests-ci-env.md:232`) проверяет копию без браузера и кадра, поэтому пробел там не виден. `verify:release` кадр открывает, но читает только его содержимое (`infra/dev/release-verify/scenarios.mjs:2360-2367`) и пройдёт при сломанных сессиях.

Новая строка таблицы:

| № | Проверка | Файл (новый) | Что ловит | Joomla, OpenCart, MODX | Битрикс |
| --- | --- | --- | --- | --- | --- |
| М2к | **Сессия в кадре кабинета** | `<cms>-preview-frame.integration.test.ts` | Настоящий шлюз процессом (`apps/core/src/testing/preview-app.ts`), верхняя страница `http://localhost:<порт>`, кадр с `PREVIEW_SANDBOX`, вход по билету. Действие на сессии стека проходит, куки сервера возвращаются | CI | Локально |

Что проверяет стек:

| Стек | Действие в кадре | Правильный исход |
| --- | --- | --- |
| OpenCart | `#button-cart`, затем страница корзины | Товар в корзине, а не только уведомление об успехе |
| Joomla | `/login`, неверный пароль | «do not match», нет цепочки 303 |
| MODX | Вход в менеджер или форма с токеном | Отказ по паролю, а не потеря сессии |
| Битрикс | Форма с `sessid` | То же, локально |
| WordPress | Вход на `wp-login.php` синтетическим пользователем | Вход выполнен: регрессии нет, вход в кадре заработал впервые |

Обязательные части:

- **Контроль, что кадр межсайтовый.** Страница пишет `document.cookie='probe=1; path=/'`. В кадре куки нет, во вкладке есть. Если стенд случайно станет same-site, проверка упадёт, а не пройдёт впустую.
- **Сверка кук.** Список имён в кадре и во вкладке после одного сценария печатается строкой `NOTE`: так видно куки из JavaScript каждого стека.
- **Источник `sandbox`.** Строка из `PREVIEW_SANDBOX`, не копия: от неё зависит результат. Приложения друг друга не импортируют, поэтому константу придётся перенести из `preview-frame.tsx:37` в `packages/domain/src/preview/`.

В CI идёт Chromium. Перед M10 вручную: настоящий Safari на Mac и iPhone, версии 26.2+ и 18.5–26.1, с той же корзиной и сообщением о вкладке.

## 8. Не проверено

- **Настоящий шлюз** с этой правкой не запускался, только прокси с той же логикой заголовков. Куки шлюза с атрибутами продукта в кадре живут в обоих браузерах.
- **Настоящий Safari и iPhone.** Сборка Playwright WebKit 26.6 на macOS не то же самое, что Safari: эвристики ITP могут отличаться. Версии младше 26.2 только по документам и коду.
- **Firefox.** Playwright Firefox 155 не запустился на этой машине («Could not find profile folder»). По документам CHIPS есть с 141 ([Mozilla](https://attackanddefense.dev/2025/07/17/firefox-security-privacy-newsletter-2025-q2.html)), сторонние куки там разделены по умолчанию, так что `None; Secure; Partitioned` должна работать в обоих случаях. Яндекс Браузер не мерил.
- **MODX, Битрикс, OpenCart 3, WordPress** не запускались: MODX и OC 3 по исходникам, Битрикс по документации. Вывод им не нужен, шлюз не зависит от стека, но приёмка обязательна.
- `session.cookie_partitioned` как имя настройки — по [php.watch](https://php.watch/codex/session.cookie_partitioned); `UPGRADING` называет ключ `partitioned`. На выводы не влияет.

Скрипты и журналы: `scripts/iframe-cookie-stand/` (`prodlike.mjs` — главная таблица, `sibling.mjs` — соседи, `stand.mjs` — матрица и предел 10 КиБ, `extra.mjs` — перехват и `confirm`). Контейнеры стенда удалены.

## 9. Вопросы владельцу

1. **Переписывать `Set-Cookie` в шлюзе.** По умолчанию да, как в разделе 4.
2. **Куки из JavaScript.** По умолчанию не лечим: в кадре такие куки не живут, полный режим — «Открыть в новой вкладке».
3. **Safari младше 26.2.** По умолчанию предпросмотр только во вкладке, кадр показывает сообщение со ссылкой.
4. **`allow-modals` в кадре.** По умолчанию оставить закрытым: страница не должна показывать окна поверх кабинета, в том числе `prompt` с просьбой ввести пароль. Цена: удаление в админках OpenCart и Joomla в кадре молча не срабатывает, работает во вкладке.
5. **PSL.** По умолчанию заявка подаётся только после замены `fromSiblingSite`.
