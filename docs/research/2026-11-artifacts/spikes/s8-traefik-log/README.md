# s8. Строка запроса в журнале Traefik и фрагмент ссылки `/a#…`

Дата: 19.11.2026. Спайк этапа Э0а плана 88, нужен Э10 (решение Ар33). Код продукта не менялся. Исходники спайка — в этом каталоге: `harness/` (стенд и проверки), `nextapp/` (приложение Next.js для проверки журналов web) и `nextapp-headers/` (какой `Referrer-Policy` побеждает в Next.js).

---

## Вопрос

Ар33 выбрал адрес ссылки `https://raditi.ru/a#<токен>`. В §8.5 записан запасной адрес `/a?k=<токен>` с пометкой «проверить журнал Traefik на стенде». Отчёт c4 (§12.5) не знал, пишет ли поле `RequestPath` строку запроса до того, как её отбрасывает `--accesslog.fields.queryparameters.defaultmode=drop`.

Что проверялось:

1. Пишет ли Traefik с настройкой production строку запроса `GET /a?k=<токен>` в журнал запросов или в любой другой журнал. Настройка — `infra/app/docker-compose.yml`, `infra/app/traefik/dynamic/raditi.yml` и `pages.yml`, `infra/server/traefik/server.yml`.
2. Если пишет — чем её убрать: параметрами полей журнала (в том числе без `RequestPath`), посредником (middleware) до журнала, другим форматом. И что при этом теряет эксплуатация.
3. Пишет ли полные адреса кто-то ещё: `apps/web/src/proxy.ts` и другие журналы web, метки Prometheus, сам Next.js.
4. Доходит ли до сервера фрагмент `/a#<токен>`.

## Коротко

**Ответ: нет.** С настройкой production строка запроса не попадает ни в один журнал края, web и Next.js. Фрагмент до сервера не доходит. Запасной адрес `/a?k=…` всё же предлагаю убрать из плана.

- **Строку запроса убирает флаг, который уже стоит.** В Traefik 3.7.13 `--accesslog.fields.queryparameters.defaultmode=drop` собирает `RequestPath` без `RawQuery` (`pkg/middlewares/accesslog/logger.go:238–253`). Проверено 30 видов запроса: HTTP/1.1 и HTTP/2, `www`, 404, 413, 400, 502, страницы, панель, сырые цели запроса. Маркер не появился ни в журналах, ни в метриках. Путь, хост, код, маршрутизатор, адрес и порт клиента, время, размеры и длительности остаются. То же требует проверка 16 стенда `pnpm verify:edge`; спайк повторил её на закреплённом digest и расширил.
- **Флаг хрупкий.** Принимается только точное `drop`:
  - `redact`, `Drop` или второй флаг `=keep` после него молча возвращают строку запроса в журнал;
  - с `headers.defaultmode=keep` (или с `keep` для отдельных заголовков) токен уходит в журнал через `Referer`, `Cookie` и `Location`. Если флаг просто убрать, Traefik 3.7.13 заголовки не пишет: `drop` — его умолчание (исправлено проверкой);
  - на уровне `DEBUG` полный адрес пишет строка «Request has been aborted», когда клиент обрывает ответ; на `TRACE` буфер тела пишет весь запрос с заголовками.

  `infra/app/compose.test.mjs` проверяет только наличие флага. Уровень журнала не проверяет никто.
- **Другие способы хуже или не работают.** Посредник журнал не правит: журнал записывает адрес раньше, чем срабатывают посредники маршрутизатора. Форматы `common` и `genericCLF` берут то же поле. `RequestPath=drop` и маршрутизатор с `accessLogs: false` убирают больше, чем нужно эксплуатации. Next.js 16.3.6 в production запросы не пишет, ошибки печатает без адреса. Код web адресов не пишет, в метках Prometheus путей нет.
- **Фрагмент до сервера не доходит.** Chromium 153, WebKit 26.6 (macOS и Linux) и Firefox 155 (Linux), а также curl, `fetch` Node и `urllib` Python шлют `GET /a`. В `Referer` фрагмента нет даже с `unsafe-url`. Перенаправления края (`www` → корень, `http` → `https`) сохраняют фрагмент в адресе браузера. Сырой `#` в пути от другого клиента Traefik отклоняет кодом 400 до журнала. После `?` он — часть строки запроса: запрос доходит до заднего, а журнал отбрасывает `#…` вместе со строкой запроса (P21) (исправлено проверкой).
- **Где фрагмент всё-таки виден.** WebKit на macOS отдаёт фрагмент адреса `http://` обычному HTTP-прокси клиента в строке запроса. Обработчик `fetch` сервис-воркера видит фрагмент в `event.request.url`. У `apps/web/public/sw.js` такого обработчика нет, ссылки — только `https://`, HSTS включён.
- **Запасной адрес лучше убрать.** Строка запроса, в отличие от фрагмента, уходит в `Referer` каждого запроса страницы к кабинету: общая политика web — `strict-origin-when-cross-origin`. Ещё она уходит в `?next=` перенаправления на вход и в `Location`. В `Referer` — если на `/a` нет `Referrer-Policy: no-referrer` из Ар33, в `?next=` — если страница идёт через `requireSession`. С `no-referrer` строка запроса в `Referer` не уходит: проверка — 0 запросов из 10. Но токен всё равно доходит до процесса web (исправлено проверкой). Её защищают три настройки края, и тесты закрепляют не все. Выигрыша нет: странице `/a` всё равно нужен скрипт для POST «Открыть».

## Как проверено

- **Машина.** macOS 27.0.1, arm64, 10 ядер, 32 ГБ. Docker Desktop: Docker Engine 29.8.2, linux/arm64, ядро 7.0.14-linuxkit. Рядом шла другая работа, load average во время прогонов — от 5 до 48 (`uptime`). Время спайк не мерил: на результат (есть ли маркер в журнале) нагрузка не влияет.
- **Край.** Образ `ghcr.io/traefik/traefik:v3.7.13@sha256:f86a2cab1b5c649070c49f883c743dd32d8485a56e3368c5f93b9e91f1e91259`. Этот digest закреплён в `infra/server/env.example`, `infra/app/env.example` (через зеркало) и `infra/app/verify-edge.mjs`. Сборка 2026-09-04, go1.26.8.
- **Флаги.** `harness/prepare.mjs` берёт все 52 флага сервиса `traefik` из `infra/app/docker-compose.yml` и оставляет 40: без 12 флагов ACME, потому что удостоверяющего центра на стенде нет. `--api.dashboard=true` — как на одном сервере (`EDGE_DASHBOARD=true` в `infra/server/env.example`). Оверлей `infra/server/docker-compose.server.yml` флагов журнала не меняет.
- **Маршруты.** Файлы `raditi.yml`, `pages.yml` и `server.yml` — из репозитория. В них блок `tls: { certResolver, domains }` заменён на `tls: {}`. Сертификат синтетических имён лежит в отдельном `spike-tls.yml`, поэтому `sniStrict: true` остаётся в силе. Тест `infra/app/traefik.test.mjs` на этом дереве — 10 из 10.
- **Контейнер.** Как в compose: пользователь 65532, корень только для чтения, без capabilities, `no-new-privileges`, `/tmp` на 1 МиБ, 0,5 CPU, 256 МиБ, 256 процессов.
- **Имена.** `cabinet.example.test` — APP_DOMAIN и BROWSER_STREAM_HOST, `dash.example.test` — DASHBOARD_HOST, `pages.example.test` — PAGES_ROOT_HOST и PAGES_BASE_DOMAIN.
- **Задние.** `ghcr.io/traefik/whoami@sha256:c4717a8d1f0134a7444e24f881160e033991f23027c6c5a9a3f8fd22e70d1d44` (whoami 1.12.0) под именами `web:3000` и `preview:8092`. На `preview:8091` никого нет — это случай 502. whoami отвечает текстом запроса, который получил.
- **Что искали и где.** В каждом запросе — свой случайный маркер. Поиск подстрокой шёл по stdout и stderr Traefik (в production это journald, драйвер `journald` в compose), по журналам обоих whoami, по выводу `/metrics` (:9000) и, в варианте `file`, по файлу журнала.
- **Код Traefik.** v3.7.13 прочитан из архива модуля `proxy.golang.org` (sha256 архива `2165610ab0e3d4b4084ec3ee70ef87cccfd3ecd13720f38a3e0e776ac85a3325`, коммит тега `fc92cc11`), `vulcand/oxy` v2.1.0 — оттуда же. Скачанное не запускалось.
- **Браузеры.** `playwright-core` 1.63.0.
  - macOS: Chromium 153.0.8010.12 (headless shell, сборка 1243) и WebKit 26.6 (2359). Firefox 1543 на macOS не запустился: «Could not find profile folder».
  - Docker, образ `mcr.microsoft.com/playwright:v1.63.0-noble` (Node 24.20.0), Linux arm64: Firefox 155.0, Chromium 153.0.8010.12, WebKit 26.6.
  - Имена `*.example.test` нигде не резолвятся, поэтому браузеры идут через прокси `harness/proxy.mjs`. CONNECT на 443 он ведёт на https Traefik, адреса `http://` — на http Traefik. Каждую строку запроса прокси записывает.
  - Самоподписанный сертификат стенда браузеры принимают через `ignoreHTTPSErrors`, клиенты — через `ca` и `--cacert`.
- **Клиенты.** curl 8.7.1, `fetch` Node 26.10.0 (`NODE_USE_ENV_PROXY=1`), `urllib` Python 3.9.6.
- **Next.js.** Приложение `nextapp`: next 16.3.6, react и react-dom 19.3.0, `output: 'standalone'`, `proxy.js` устроен как `apps/web/src/proxy.ts`. Запуск — `node .next/standalone/server.js`, как у web в production. `nextapp-headers` — та же сборка с общим `Referrer-Policy` в `next.config.mjs`. Полный web не запускался: в дереве `feat/artifacts` нет `node_modules`.

Повторить (каталоги `harness` и `nextapp` скопировать в `<scratch>`, в репозитории ничего не ставить):

```sh
cd <scratch>/harness && pnpm install                # playwright-core 1.63.0
node prepare.mjs --repo <репозиторий> --out <scratch>/run
node edge.mjs --run <scratch>/run                   # все варианты; --only prod,keep,… — часть
node browsers.mjs --run <scratch>/run
cd <scratch>/nextapp && pnpm install && NEXT_TELEMETRY_DISABLED=1 ./node_modules/.bin/next build
cd <scratch>/harness && node next-logs.mjs --app <scratch>/nextapp --out <scratch>/run/results/next.json
cd <scratch>/nextapp-headers && pnpm install && NEXT_TELEMETRY_DISABLED=1 ./node_modules/.bin/next build
cd <scratch>/harness && node next-headers.mjs --app <scratch>/nextapp-headers --out <scratch>/run/results/next-headers.json
node sw-fragment.mjs --out <scratch>/run/results/sw.json
node summary.mjs --run <scratch>/run                # таблицы этого отчёта
```

Нужны `docker`, `openssl`, `htpasswd`, `curl`, `python3` и три образа выше. Контейнеры называются `spike88-s8-*`, сеть — `spike88-s8-net`, порты публикуются только как `127.0.0.1::<порт>`. Без `--keep` стенд удаляет всё за собой.

## Результаты

### 1. Настройка production, 30 видов запроса

Маркер строки запроса (`?k=<маркер>`) не нашёлся ни в одном журнале и ни в метриках ни в одном случае. `P01` шёл на `/a`, остальные — на `/a-pNN`, чтобы строку журнала можно было узнать по пути.

| Случай | Запрос | Код | Строка журнала | `RequestPath` |
| --- | --- | --- | --- | --- |
| P01 | `GET /a?k=…`, HTTP/1.1 | 200 | есть | `/a` |
| P02 | то же, HTTP/2 | 200 | есть | `/a-p02` |
| P03 | несколько параметров `?x=1&k=…&y=2` | 200 | есть | `/a-p03` |
| P04 | строка без `=`: `?<маркер>` | 200 | есть | `/a-p04` |
| P05 | точка с запятой: `?k=…;x=1` | 200 | есть | `/a-p05` |
| P06 | неверное `%ZZ` в строке запроса | 200 | есть | `/a-p06` |
| P07 | строка запроса на 8 КиБ | 200 | есть | `/a-p07` |
| P08 | `www` → корень (`www-to-apex`) | 301 | есть, `www@file` | `/a-p08` |
| P09 | вход http :8000 → https | 301 | нет: `web.observability.accesslogs=false` | — |
| P10 | `Host`, для которого нет маршрута | 404 | есть, без маршрутизатора | `/a-p10` |
| P11 | POST `/api/…` больше предела, с длиной | 413 | есть, `web-api-body@file` | `/api/a-p11` |
| P12 | то же без длины (chunked) | 413 | есть | `/api/a-p12` |
| P13 | `%2F` в пути | 400 | есть | `/a-p13%2Fb` |
| P14 | `/api/metrics` | 403 | есть, `web-metrics@file` | `/api/metrics` |
| P15 | `/api/auth/reset-password/<маркер>?k=…` | 200 | нет: `accessLogs: false` | — |
| P16 | `/v1/browser/stream?k=…`, задний недоступен | 502 | есть, `browser-stream@file` | `/v1/browser/stream` |
| P17 | хост страницы, `/v/<маркер пути>?k=…` | 200 | есть, `pages@file` | `/v/<маркер пути>` |
| P18 | корень страниц, `/v/<маркер пути>?k=…` | 200 | есть, `pages-root@file` | `/v/<маркер пути>` |
| P19 | панель `dash.…/api/rawdata?k=…` без входа | 401 | нет: `api@internal` не пишется без `accesslog.addinternals` | — |
| P20 | сырая цель `/a-p20#<маркер>` | 400 | нет: `denyFragment` до маршрутизатора | — |
| P21 | сырая цель `/a-p21?k=…#…` | 200 | есть | `/a-p21` |
| P22 | абсолютная цель `https://cabinet…/a-p22?k=…` | 200 | есть | `/a-p22` |
| P23 | HTTP/2, `:path` с `#` | 400 | нет: `denyFragment` | — |
| P24 | клиент оборвал длинный ответ `/data?…&k=…` | 200 | есть | `/data` |
| P25 | `HEAD /a?k=…` | 200 | есть | `/a-p25` |
| P26 | токен в `Referer`, `Cookie` и `User-Agent` | 200 | есть, заголовков нет | `/a-p26` |
| P27 | токен в теле POST `/api/trpc/artifact.share.open` | 200 | есть, тела нет | `/api/trpc/artifact.share.open` |
| P28 | заголовки на 40 КиБ, больше `maxheaderbytes` (32 КиБ) (исправлено проверкой) | 431 | нет: отказ Go до обработчика | — |
| P29 | `HTTP/9.9` | 505 | нет | — |
| P30 | пробел в цели запроса | 400 | нет | — |

- **Общий журнал на `INFO`** — 10 строк. Одна `warn` о кодированных символах и семь `info` пишутся при запуске. Две `error` — `vulcand/oxy/buffer: request body over limit…` (P11) и `…error when reading request body…` (P12): в них маршрутизатор и посредник, но не адрес.
- **Метки метрик Traefik:** `code`, `entrypoint`, `method`, `protocol`, `router`, `service`, `le` и метки сертификата: `cn`, `sans`, `serial`, `tls_cipher`, `tls_version`. Пути нет. У web в `/api/metrics` только метрики процесса по умолчанию (`packages/observability/src/metrics.ts`, `apps/web/src/server/metrics.ts`).
- **Строка журнала P01** (лишние поля опущены): `{"RouterName":"web@file","RequestPath":"/a","DownstreamStatus":200,"RequestProtocol":"HTTP/1.1","ClientHost":"…","ClientPort":"59154","StartUTC":"2026-11-19T14:29:50.908973375Z"}`.
- **Токены в пути пишутся.** P17 и P18 показывают: `/v/<токен>` попадает в журнал целиком. Это путь, а не строка запроса.

### 2. Варианты настройки края

Вариант меняет флаги или маршруты репозитория так, как сказано в столбце «Что изменено». Случаев девять: P01, P02, P03, P08, P10, P11, P13, P16, P26; в `debug` и `trace` — все 30.

| Вариант | Что изменено | Маркер в журнале | Где |
| --- | --- | --- | --- |
| `keep` | нет флага `queryparameters` (умолчание Traefik — `keep`) | 8 из 9 | все, кроме P26 |
| `redact` | `queryparameters.defaultmode=redact` | 8 из 9 | то же: значение не из списка — значит `keep` |
| `Drop` | `queryparameters.defaultmode=Drop` | 8 из 9 | то же: регистр важен |
| `dup` | флаги репозитория и после них второй `…=keep` | 8 из 9 | побеждает последний флаг |
| `dup-first` | `…=keep` перед флагами репозитория | 0 | — |
| `common` | `--accesslog.format=common`, `drop` | 0 | строка `"GET /a HTTP/1.1" 200 378 … "web@file" "http://web:3000" 2ms` |
| `genericCLF` | `--accesslog.format=genericCLF`, `drop` | 0 | `"GET /a HTTP/1.1" 200 378 "-" "-"` |
| `common-keep` | `common` без флага `queryparameters` | 8 из 9 | `"GET /a?k=<маркер> HTTP/1.1"` |
| `path-drop` | без флага, `fields.names.RequestPath=drop` | 0 | строки есть, но без пути: нельзя понять, что запрошено |
| `route-off` | без флага, маршрутизатор `Path(/a)` с `accessLogs: false` | 7 из 9 | `/a` не пишется совсем, любой другой путь — со строкой запроса |
| `rewrite` | без флага, `replacePathRegex` на `PathPrefix(/a)` | 8 из 9 | журнал пишет исходный адрес. P11 вернул 200: `PathPrefix(/a)` поймал и `/api/a-p11` и увёл его мимо `web-api-body` |
| `headers-keep` | `drop`, но `headers.defaultmode=keep` | 2 из 9 | P08 — `downstream_Location`, P26 — `request_Referer`, `request_Cookie`, `request_User-Agent` |
| `file` | `drop`, `--accesslog.filepath=…` | 0 | — |
| `debug` | `--log.level=DEBUG` | 3 из 30 | P20, P23, P24 — таблица 3 |
| `trace` | `--log.level=TRACE` | 6 из 30 | P11, P12, P15, P20, P23, P24 — таблица 3 |

Почему так, по коду v3.7.13:

- `KeepQueryParameters` и `checkFieldValue` (`pkg/observability/types/logs.go:145–162`) знают только `keep` и `drop`, любое другое значение означает `keep`.
- Документация (`docs/content/reference/install-configuration/observability/logs-and-accesslogs.md`) называет у `queryParameters` только `defaultMode` со значениями `keep` и `drop`, без `names` по параметрам. Отбросить один `k`, оставив остальные, нельзя.
- Форматы `common` и `genericCLF` печатают то же поле `RequestPath` (`pkg/middlewares/accesslog/logger_formatters.go`).

### 3. Что пишет общий журнал на `DEBUG` и `TRACE`

| Уровень | Случай | Строка (маркер заменён) |
| --- | --- | --- |
| `DEBUG` | P24 | `Request has been aborted [<адрес>:<порт> - /data?size=200&unit=MB&k=<маркер>]: net/http: abort Handler` |
| `DEBUG` | P20, P23 | `Rejecting request because it contains a fragment in the URL path: /a-p20#<маркер>` |
| `TRACE` | P11, P12, P15 | `vulcand/oxy/buffer: begin ServeHttp on request: {"Method":…,"URL":{…"RawQuery":"k=<маркер>"…},"Header":{…}}` |

- **P24.** `pkg/middlewares/recovery/recovery.go:45` пишет `req.URL` со строкой запроса, когда клиент обрывает ответ, — например, браузер закрыли посреди потоковой выдачи страницы. Рядом, в строке 49, «Recovered from panic in HTTP handler […]» пишет тот же адрес уровнем `ERROR`, то есть и на `INFO`. Но срабатывает он только при панике Traefik, спайк её не вызывал.
- **TRACE.** Буфер oxy в подробном режиме (`buffer/buffer.go:121–124`, `utils/dumpreq.go`) выводит весь запрос с заголовками, включая `Cookie`. Это касается любого маршрута с `api-body-limit`, в том числе маршрута сброса пароля, у которого `accessLogs: false`.

### 4. Фрагмент: браузеры и клиенты

Пять запусков браузеров по девять маркеров (семь — через край, два — на записывающий сервер) и три клиента — 48 маркеров. Из них 43 — во фрагменте и 5 — в строке запроса, для сравнения (исправлено проверкой). Ни один маркер фрагмента не нашёлся в журналах Traefik и whoami. Ни один не дошёл до заднего: whoami возвращает полученную строку запроса. Один дошёл до прокси стенда: WebKit на macOS, перенаправление `http` → `https` (ниже).

| Браузер | Платформа | Сервер получил | `location.hash` | После `history.replaceState` | `Referer` из `/a#…` (fetch, fetch `unsafe-url`, переход) | `www` → корень, `http` → `https` | `fetch('/d-frag#…')`, ссылка с `#` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Chromium 153.0.8010.12 | macOS | `GET /a HTTP/1.1` | `#<токен>` | `/a`, `hash` пуст | `https://cabinet.example.test/a` во всех трёх | фрагмент остался в адресе, сервер получил `GET /a` | `GET /d-frag`, `GET /e-link` |
| WebKit 26.6 | macOS | то же | то же | то же | то же | то же | то же |
| Firefox 155.0 | Linux | то же | то же | то же | то же | то же | то же |
| Chromium 153.0.8010.12 | Linux | то же | то же | то же | то же | то же | то же |
| WebKit 26.6 | Linux | то же | то же | то же | то же | то же | то же |

Для сравнения, `/a?k=<токен>` во всех пяти запусках: `fetch('/b-ref3')` уходит с `Referer: https://cabinet.example.test/a?k=<токен>`, с `referrerPolicy: 'no-referrer'` — без него.

Адрес `http://` с фрагментом: прямо к серверу и через обычный HTTP-прокси (`harness/proxy.mjs`, `startRecorder`). Ниже — строки запроса, какими их получил записывающий сервер.

| Браузер | Платформа | Прямо к `http://127.0.0.1:<порт>/a#…` | Через HTTP-прокси, `http://recorded.example.test/a#…` |
| --- | --- | --- | --- |
| Chromium | macOS | `GET /a HTTP/1.1` | `GET http://recorded.example.test/a HTTP/1.1` |
| WebKit | macOS | `GET /a HTTP/1.1` | `GET http://recorded.example.test/a#<токен> HTTP/1.1` |
| Firefox | Linux | `GET /a HTTP/1.1` | `GET http://recorded.example.test/a HTTP/1.1` |
| Chromium | Linux | `GET /a HTTP/1.1` | `GET http://recorded.example.test/a HTTP/1.1` |
| WebKit | Linux | `GET /a HTTP/1.1` | `GET http://recorded.example.test/a HTTP/1.1` |

То же повторилось в проверках края: на перенаправлении `http` → `https` WebKit на macOS отдал прокси `GET http://cabinet.example.test/a#<токен>`. Дальше прокси спайка передал Traefik только путь, поэтому край маркера не увидел. Через `https://` любой прокси видит только `CONNECT cabinet.example.test:443`.

| Клиент | Версия | Сервер получил |
| --- | --- | --- |
| curl | 8.7.1 (SecureTransport, LibreSSL 3.3.6, nghttp2 1.69.0) | `GET /a HTTP/1.1` |
| `fetch` Node | 26.10.0 | `GET /a HTTP/1.1` |
| `urllib` Python | 3.9.6 | `GET /a HTTP/1.1` |

Сервис-воркер (`harness/sw-fragment.mjs`, Chromium 153 и WebKit 26.6 на macOS): обработчик `fetch` получил `event.request.url` с фрагментом, на сеть запрос не ушёл. У `apps/web/public/sw.js` слушатели `install`, `activate`, `push`, `notificationclick` и `pushsubscriptionchange`, а `fetch` — нет.

### 5. Next.js и код web

`nextapp` на next 16.3.6, `node .next/standalone/server.js`:

| Случай | Запрос | Код | Маркер в stdout и stderr |
| --- | --- | --- | --- |
| N1 | страница `/a?k=…` читает `searchParams` | 200 | нет |
| N2 | страница бросает ошибку | 500 | нет |
| N3 | обработчик маршрута бросает ошибку | 500 | нет |
| N4 | нет такой страницы | 404 | нет |
| N5 | как `requireSession`: перенаправление на `/sign-in?next=<путь и строка запроса>` | 307 | нет, но токен — в `Location` |
| N6 | битое `%`-кодирование в строке запроса | 200 | нет |

- **Что печатает сервер.** stdout — пять строк запуска. stderr — `⨯ Error: spike: the page failed` со стеком и `digest`, затем `⨯ Error: spike: the route failed` со стеком. Адреса нет.
- **Журнал запросов Next.** Он есть только в режиме разработки: `next/dist/server/dev/log-requests.js`.
- **Строки с `req.url`.** Поиск по `next/dist/server` нашёл их вне режима разработки только у Pages Router, в `api-resolver` и в проверке `?dpl=` (`dist/server/lib/router-utils/resolve-routes.js:318`). Web на App Router, без каталога `pages` и без `deploymentId`.
- **`instrumentation.ts`.** Web определяет только `register`, `onRequestError` у него нет.

Код web (только чтение):

- `apps/web/src/proxy.ts` ничего не пишет. Он кладёт путь со строкой запроса в заголовок `x-raditi-path`. `requireSession` (`apps/web/src/lib/access.ts:37–38`) переносит этот заголовок в `/sign-in?next=…`: так строка запроса едет дальше, но в журнал не попадает.
- `[trpc] <type> <procedure> failed` (`apps/web/src/app/api/trpc/[trpc]/route.ts:56–59`) — имя процедуры, не адрес.
- Остальные `console.*` в `apps/web/src`: 28 файлов вне тестов, 29 — вместе с маршрутом tRPC (исправлено проверкой). Ни одна строка не печатает адрес запроса.
- `next.config.ts` в production ставит `Strict-Transport-Security: max-age=31536000; includeSubDomains` и общий `Referrer-Policy: strict-origin-when-cross-origin`.

Какой `Referrer-Policy` получает ответ, если общий задан в `next.config.mjs` (`nextapp-headers`, next 16.3.6):

| Путь | Кто ставит `no-referrer` | Что ушло клиенту |
| --- | --- | --- |
| `/a` | более поздняя запись `headers()` с `source: '/a'` | `no-referrer` |
| `/b` | `proxy.js` в ответе (`response.headers.set`) | `no-referrer` |
| `/c` | никто | `strict-origin-when-cross-origin` |
| `/r` | обработчик маршрута в своём `Response` | `strict-origin-when-cross-origin`: общий заголовок перебил ответ маршрута |

## Что это значит для плана 88

**Настройка, при которой строки запроса нет в журналах края.** Она уже стоит в `infra/app/docker-compose.yml`, менять её не нужно:

```text
--log.level=INFO
--accesslog=true
--accesslog.format=json                          # common и genericCLF ведут себя так же
--accesslog.fields.defaultmode=keep
--accesslog.fields.names.ClientUsername=drop
--accesslog.fields.headers.defaultmode=drop      # =keep отдаёт токен через Referer, Cookie, Location; drop — и умолчание Traefik (исправлено проверкой)
--accesslog.fields.queryparameters.defaultmode=drop
--entrypoints.web.observability.accesslogs=false
```

Условия: значение — ровно `drop`; после него нет второго флага `--accesslog.fields.queryparameters.defaultmode=`; уровень журнала — не `DEBUG` и не `TRACE`; нет статического файла и переменных `TRAEFIK_*`. Первое и последнее уже проверяет `infra/app/compose.test.mjs`, второе и третье — нет. Правило «побеждает последний флаг» действует и для `headers.defaultmode`: второй `=keep` после `drop` тест тоже пропустит. Статический файл, заданный флагом `--configfile`, тест не ловит: он ищет только тома и переменные (исправлено проверкой).

- **Ар33 — остаётся.** Предлагаю дописать:
  > Адрес — только `https://raditi.ru/a#<token>`, запасного адреса нет. Фрагмент не уходит на сервер ни из одного браузера, ни через перенаправления края, ни в `Referer` (спайк s8). Страница `/a` отвечает 200 на любой GET и сама не перенаправляет до того, как скрипт прочитал фрагмент и вызвал `history.replaceState`. Перенаправление уносит фрагмент дальше: он оказывается в адресе следующей страницы. Ссылку выдаём только с `https://` (HSTS web). `sw.js` не получает обработчика `fetch`, который пишет или отправляет `request.url`: сервис-воркер видит фрагмент.
- **Ар33, `Referrer-Policy: no-referrer` на `/a` — остаётся.** Для токена во фрагменте это запас: фрагмента в `Referer` нет даже с `unsafe-url`. Политика убирает `Referer` совсем, вместе с origin. Если строку запроса когда-нибудь вернут, без этой политики токен уйдёт в `Referer`. Ставить её — более поздней записью `headers()` в `next.config.ts` с `source: '/a'` или в `proxy.ts`, как там уже ставится CSP. Заголовок, который вернул обработчик маршрута, общий `Referrer-Policy` перебивает (таблица в разделе 5).
- **§8.5 «Адрес» — меняется.** Предлагаю:
  > Фрагмент `/a#…` (выбрано). `/a?k=…` — отклонён по спайку s8. Край строку запроса не пишет (`--accesslog.fields.queryparameters.defaultmode=drop`, точное значение). Но адрес держится на настройках Traefik: ровно один флаг `drop`, никакого `keep` для заголовков, `--log.level=INFO`. Токен доходит до процесса web. Без `Referrer-Policy: no-referrer` и при перенаправлении на вход он уходит в `Referer`, `?next=` и `Location`. Выгоды такой адрес не даёт. Путь `/a/…` попадает в журнал. (исправлено проверкой)
- **§10, Э0а, «Отдельно — запись журнала Traefik…» — закрыто.** Предлагаю: «Сделано, спайк s8: строки запроса в журналах края, web и Next.js нет; запасной адрес снят».
- **Э10, срез 88.16 — новое.** Даже без запасного адреса строку запроса используют другие токены: `/api/auth/verify-email?token=…`, а в будущем, возможно, подписи файлов. Предлагаю закрепить настройку края:
  - в `infra/app/compose.test.mjs` — ровно один флаг `--accesslog.fields.queryparameters.defaultmode=`, и его значение `drop`. Сейчас тест пройдёт и с `=keep` после `=drop`;
  - там же — ровно один флаг `--accesslog.fields.headers.defaultmode=` со значением `drop` и ни одного `--configfile`: второй `=keep` так же молча включает запись `Referer`, `Cookie` и `Location`, а файл отключает все флаги (исправлено проверкой);
  - там же — `--log.level=INFO`: на `DEBUG` обрыв ответа пишет адрес со строкой запроса, на `TRACE` пишется весь запрос с `Cookie`;
  - в проверку 16 `infra/app/verify-edge.mjs` добавить запрос по HTTP/2 и обрыв клиентом.
- **Э10, срез 88.16а, «журнал фактов на 3 года — порт и время пишет край» — остаётся, с оговоркой.** Строка журнала края для POST «Открыть» содержит `ClientHost`, `ClientPort`, `StartUTC` с наносекундами и путь `/api/trpc/…` без токена (P27). Строка запроса и заголовки эксплуатации для этого не нужны. Но journald хранит журнал 90 дней и не больше 10 ГБ (`MaxRetentionSec=90day`: `infra/server/host/install.sh:46`, `infra/app/preflight.sh:143`). Порт клиента Traefik в web не передаёт: `X-Forwarded-Port` — порт входа, `X-Forwarded-For` и `X-Real-Ip` — только адрес. Поэтому журналу на 3 года нужна своя копия этих строк края или ключ, связывающий их с записью web. Спайк это не проверял.
- **Ар12 и §7.7, `/v/<token>` и подписанные адреса файлов — остаются.** Токен в пути край пишет целиком (P17, P18). Это допустимо, пока токен живёт 5 минут и роль проверяется на каждый запрос, как записано в Ар12. Если подпись положат в строку запроса, край её не запишет.
- **Если край всё-таки получит маршрутизатор для `/a`** (заголовки или отключение журнала) — правило `Path(`/a`)`, не `PathPrefix(`/a`)`. Префикс ловит и `/api/…`, `/app/…`, `/artifacts/…` и уводит их мимо `web-api-body` с пределом тела (вариант `rewrite`, P11 — 200 вместо 413).
- **§9, риски — новая строка.** Предлагаю: «Токен ссылки в журналах | Фрагмент не уходит на сервер. Край не пишет строку запроса и заголовки, уровень журнала — `INFO`, это закрепит тест среза 88.16 (s8)» (исправлено проверкой: такого теста пока нет).

## Не подтверждено

- **Не production.** Production — amd64 на Ubuntu, Docker с драйвером `journald`. Спайк шёл на arm64 в Docker Desktop с драйвером `local`: так этот Docker Desktop настроен по умолчанию, `docker info` (исправлено проверкой). Код Traefik тот же, но хост и journald не проверялись.
- **Без ACME и Pebble.** Флаги удостоверяющего центра сняты, маршрутам дан `tls: {}`. На журнал запросов это, по коду, не влияет.
- **Не живые устройства.** Браузеры — сборки Playwright без окна. Safari, iOS, Android и Яндекс Браузер не проверялись. Firefox проверен только на Linux: на macOS сборка 1543 в этой среде не запустилась.
- **Фрагмент у HTTP-прокси.** Это WebKit Playwright на macOS. Ведёт ли себя так же Safari и что делают корпоративные прокси с такой строкой, не проверено.
- **Сторонние сервисы.** Превью ссылок в мессенджерах и почтовые сканеры не проверялись. Они получают текст ссылки целиком, с фрагментом или со строкой запроса.
- **Полный web.** Он не запускался: в дереве нет `node_modules`. Проверены отдельное приложение Next.js той же версии и код web при чтении. better-auth и tRPC не запускались.
- **Без воспроизведения.** «Recovered from panic» уровнем `ERROR` с полным адресом найден только в коде: паники спайк не вызывал. Трассировка Traefik в production выключена. По коду (`pkg/observability/tracing/tracing.go`) она заменяет значения параметров на `REDACTED`, но не запускалась.
- **Не включено.** HTTP/3 и `accesslog.otlp` в production выключены и не проверялись.
- **Сервис-воркер.** Проверен на синтетическом воркере в Chromium и WebKit, не на `sw.js` кабинета.

## Проверка

Независимая проверка, 19.11.2026. Код продукта не менялся. В репозитории добавлены только этот раздел, правки на месте с пометкой «(исправлено проверкой)» и каталог `verify/` с исходниками своих проверок. Load average во время прогонов — от 5 до 25 (`uptime`), до начала — до 106 от чужой работы. Время не сравнивалось.

### Что перезапущено

Стенд спайка целиком, на копии `harness/` с именами `spike88-s8v-*`:

- `prepare.mjs`: те же 40 флагов из 52, в файлах маршрутов изменены только блоки `tls`.
- `edge.mjs`: все 16 вариантов, 1 мин 19 с. Совпало случай в случай:
  - `prod` — 0 из 30, 8 случаев без строки журнала, коды и `RequestPath` таблицы 1, общий журнал `warn` 1, `info` 7, `error` 2, те же метки метрик;
  - `keep`, `redact`, `Drop`, `dup`, `common-keep` — по 8 из 9;
  - `dup-first`, `common`, `genericCLF`, `path-drop`, `file` — по 0;
  - `route-off` — 7 из 9, `rewrite` — 8 из 9 (P11 — 200), `headers-keep` — 2 из 9;
  - `debug` — 3 из 30, `trace` — 6 из 30.

  Отличие одно: строк `debug` при `TRACE` 206 против 256 у спайка. Оно зависит от времени и на вывод не влияет.
- `browsers.mjs`, 45 с: те же строки запроса, `Referer`, перенаправления и тот же единственный WebKit на macOS у HTTP-прокси. Клиенты — те же, в журналах края — тот же один маркер, у прокси стенда.
- `sw-fragment.mjs`, `next-logs.mjs` и `next-headers.mjs` на заново собранных `nextapp` и `nextapp-headers`: воркер видит фрагмент, сеть — нет; Next — 0 из 6; те же четыре значения `Referrer-Policy`.
- `node --test infra/app/traefik.test.mjs` — 10 из 10.

### Свои проверки, другим путём

Исходники — в `verify/`, `playwright-core` 1.63.0 и `yaml` 2.8.1 (`verify/package.json`), Next.js 16.3.6 и React 19.3.0 (`verify/ind-next/package.json`).

- **Край со всеми флагами** (`verify/ind-edge.mjs`, задний — `verify/echo.mjs`). Чем отличается от стенда спайка:
  - все 52 флага сервиса `traefik` так, как их читает парсер YAML, вместе с ACME. Удостоверяющий центр — закрытый порт внутри контейнера, наружу запросов нет;
  - файлы маршрутов репозитория без правок: `certResolver` на месте, свой сертификат — отдельным файлом;
  - свой задний вместо whoami, curl и Python вместо Node, другие имена.

  21 случай, в 17 из них токен — в строке запроса: HTTP/1.1, HTTP/2, `HEAD`, POST до предела и сверх него (413), `www` → корень и `http` → `https`, чужое имя, страница и корень страниц, панель без входа и со входом, WebSocket к недоступному заднему (502), сброс пароля, `verify-email?token=`, обрыв потока по HTTP/2 и `?…#…`. В остальных четырёх токен — в `Cookie`, `Referer`, `Authorization` и `x-raditi-path`, в `Cookie` на маршруте сброса пароля, после сырого `#` и в `%3F` пути.

  Итог — 0 маркеров из 17 в журнале Traefik, у заднего и в `/metrics`; токен в заголовках и после `#` — тоже 0. Задний строку запроса получал: его ответ — эхо запроса. Положительный контроль (флаг `queryparameters` убран): маркер в журнале в 12 случаях из 17. Остальные 5 не пишутся вовсе: вход `http`, чужое имя (его TLS не принимает `sniStrict`), панель дважды и сброс пароля. Общий журнал на `INFO` с ACME — 13 строк: `warn` 1, `info` 11 (на четыре больше, чем у спайка, — от двух распознавателей ACME), `error` 1 буфера тела. Адресов нет.
- **Заголовки.** Флаг `--accesslog.fields.headers.defaultmode=drop` убран совсем (вариант `noheaders`) → ни `Cookie`, ни `Referer`, ни `Authorization`, ни `x-raditi-path`, ни `Location` перенаправления в журнале нет. Контроль `headerskeep` (`=keep`) → все пять там: `request_Cookie`, `request_Referer`, `request_Authorization`, `request_X-Raditi-Path`, `downstream_Location`. По коду `AccessLogFields.SetDefaults` (`pkg/observability/types/logs.go:107–116`) ставит заголовкам `drop`. Утечку даёт явный `keep`, а не отсутствие флага.
- **`DEBUG` и `TRACE`.**
  - Обрыв потока по HTTP/2 (у спайка — HTTP/1.1) на `DEBUG` пишет «Request has been aborted [<адрес>:<порт> - /stream?k=<маркер>]».
  - Сырой `#` пишет «Rejecting request because it contains a fragment…».
  - На `TRACE` дамп oxy на маршруте сброса пароля содержит `Cookie: better-auth.session_token=<маркер>`.
  - Тело POST в дамп не попадает: P27 спайка на `TRACE` — без маркера, `utils.Clone` тело не копирует.
  - `%3F` в пути — это путь: 400, и маркер в журнале уже на `INFO`. К `/a?k=` это не относится, браузер шлёт `?` как есть.
- **Что край передаёт web** (`verify/fwd-headers.mjs`). Присланные клиентом `X-Forwarded-For` и `X-Forwarded-Port` заменены. Web получает `X-Forwarded-Port: 443`, а `X-Forwarded-For` и `X-Real-Ip` — только адрес. Порт клиента есть только в строке журнала края (`ClientPort`).
- **Фрагмент без края и без прокси для https** (`verify/ind-fragment.mjs`). Сырые серверы TLS и TCP записывают каждый байт заголовков запроса. Браузеры: Chromium 153 и WebKit 26.6 на macOS; Firefox 155, Chromium и WebKit в Docker на Linux. Сценарий:
  - переход на `/a#<токен>`;
  - со страницы — `fetch` с политикой по умолчанию и с `unsafe-url`, `fetch(location.href)`, `sendBeacon`, картинка, переход по ссылке, `document.referrer`;
  - 302 без своего фрагмента и со своим.

  Итог в 5 запусках из 5: фрагмента нет ни в одном заголовке запроса, `document.referrer` без него. 302 без своего фрагмента сохраняет фрагмент в адресе, 302 со своим его заменяет. Через записывающий HTTP-прокси фрагмент отдал только WebKit на macOS: `GET http://plain.ind.test/a#<токен>`. Для https все показали прокси только `CONNECT`. Firefox на macOS не запустился и у проверки: «Could not find profile folder», в том числе с `TMPDIR` в рабочем каталоге.
- **Сервис-воркер** (`verify/ind-sw.mjs`, Chromium и WebKit). Воркер, который пропускает переход через `fetch(event.request)`, фрагмент в сеть не отдаёт. Воркер, который отправляет `request.url`, отдаёт: `/sw-report?u=…%23<токен>`.
- **Next.js 16.3.6 standalone** (`verify/ind-next.mjs`, приложение `verify/ind-next/`).
  - Клиентский роутер после `/a#<токен>`, на статической и на динамической странице: предзагрузка `<Link>`, переход по ней и `router.push` — 4 запроса RSC. Токена нет ни в адресах, ни в одном заголовке, в том числе в `Next-Router-State-Tree` и `Next-Url`. Эти заголовки запросы RSC действительно несут, токена нет и в них — ни строки запроса, ни фрагмента (`verify/rsc-headers.mjs`).
  - После `/ad?k=<токен>` с общей политикой токен — в `Referer` всех 10 следующих запросов: чанков и RSC. После `/a?k=<токен>` с более поздней записью `no-referrer` — ни в одном.
  - Журнал, 0 из 7 с маркером: ошибка потока после оболочки, `generateMetadata`, `notFound()`, необработанный отказ промиса, битый путь, адрес на 20 КБ (431) и ошибка серверного действия. Ошибки — со стеком, без адреса.
  - `Referrer-Policy`: более поздняя запись `headers()` для `/a` даёт `no-referrer`. Запись для `/b`, стоящая раньше общей, проигрывает общей — важен именно порядок. Заголовок от proxy побеждает, заголовок обработчика маршрута проигрывает.
- **Код.**
  - Архив Traefik v3.7.13 скачан заново с `proxy.golang.org`: sha256 тот же, `2165610a…3325`, коммит `fc92cc11`. Строки подтверждены: `logger.go:238–253`, `logs.go:145–162`, `recovery.go:45` и `:49`, `buffering.go:36` (подробный режим oxy — только на `TRACE`), `server_entrypoint_tcp.go:844–855` (`denyFragment` смотрит только `RawPath`).
  - Поиск по `pkg/` и `cmd/` строк журнала выше `DEBUG` с адресом нашёл, кроме `recovery.go:49`, только `RawPath` в `replacePath`, `replacePathRegex` и `rewrite-target` — при ошибке разбора пути, без строки запроса. Этих посредников в маршрутах репозитория нет. Обработчик ошибок прокси пишет `ERROR` только для ошибок настройки TLS, без адреса.
  - paerser v0.2.2 (`flag/flagparser.go:104–121`): значение не-среза перезаписывается, имена флагов сравниваются без учёта регистра. oxy v2.1.0: `buffer.go:120–124`, `utils/dumpreq.go`.
  - Next: `server/dev/log-requests.js` подключает только `next-dev-server.js`. Строка `?dpl=` (`resolve-routes.js:318`) срабатывает только при `__NEXT_TEST_MODE` и `IS_TURBOPACK_TEST`.
  - Web: `proxy.ts:47`, `access.ts:37–38`; `safeRedirectTarget` сохраняет строку запроса и фрагмент в `next`. Маршрут tRPC пишет только внутренние ошибки. `console.*` — в 29 файлах вне тестов вместе с маршрутом tRPC; адреса запроса не печатает ни один (число в разделе 5 исправлено, на вывод не влияет). Метрики — только по умолчанию. `sw.js` слушает `install`, `activate`, `push`, `notificationclick` и `pushsubscriptionchange`.
  - Репозиторий: `compose.test.mjs:583–592` проверяет флаги через `command.includes`; `--log.level` есть только в `docker-compose.yml:112`; журнал хоста — `install.sh:46` и `preflight.sh:143`.
- **Версии.** `traefik version`: 3.7.13, go1.26.8, сборка 2026-09-04T12:32:12Z. whoami 1.12.0 — по метке образа. Docker Engine 29.8.2, ядро 7.0.14-linuxkit, macOS 27.0.1. Драйвер журнала Docker Desktop — `local`, не `json-file`: исправлено выше.

Повторить (каталог `verify` скопировать в `<scratch>`, в репозитории ничего не ставить; контейнеры — `spike88-s8v-*`, порты — `127.0.0.1::<порт>`):

```sh
cd <scratch>/verify && pnpm install                    # playwright-core 1.63.0, yaml 2.8.1
node ind-edge.mjs --repo <репозиторий> --work <scratch>/w   # все варианты; --variant all52,noheaders,… — часть
node fwd-headers.mjs <репозиторий> <scratch>/w         # после ind-edge: берёт его сертификат и маршруты
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout k.pem -out c.pem -days 1 \
  -subj /CN=127.0.0.1 -addext 'subjectAltName=IP:127.0.0.1,DNS:tls.ind.test' && chmod 644 k.pem
node ind-fragment.mjs --cert c.pem --key k.pem --browsers chromium,webkit --platform macos
docker run --rm --network none --ipc=host --init -v "$PWD:/ind:ro" -w /ind mcr.microsoft.com/playwright:v1.63.0-noble \
  node ind-fragment.mjs --cert c.pem --key k.pem --browsers firefox,chromium,webkit --platform linux
node ind-sw.mjs
cd ind-next && pnpm install && NEXT_TELEMETRY_DISABLED=1 ./node_modules/.bin/next build && cd ..
node ind-next.mjs --app ind-next && node rsc-headers.mjs ind-next
```

### Вердикты

| Утверждение | Вердикт | Чем проверено |
| --- | --- | --- |
| С настройкой production `GET /a?k=…` не попадает ни в журналы края и заднего, ни в метрики | подтверждено | Перезапуск, 0 из 30. Свой стенд со всеми 52 флагами и маршрутами без правок — 0 из 17, контроль — 12 из 17 |
| `RequestPath` при `drop` собирается без `RawQuery` | подтверждено | Код, архив с тем же sha256 |
| `redact`, `Drop` или второй `=keep` после `drop` возвращают строку запроса | подтверждено | Перезапуск, по 8 из 9; `checkFieldValue`, `setValue` paerser |
| Тест проверяет только наличие флага, `--log.level` не закреплён | подтверждено | `compose.test.mjs:583–592`, поиск. Дополнено: то же — для `headers.defaultmode` и `--configfile` |
| Без `headers.defaultmode=drop` токен уходит через `Location`, `Referer`, `Cookie`, `User-Agent` | исправлено | Только при `=keep`. Без флага — умолчание `drop`: вариант `noheaders`, контроль `headerskeep` |
| На `DEBUG` обрыв ответа пишет адрес со строкой запроса, на `TRACE` пишется весь запрос с `Cookie`, в том числе на маршруте сброса пароля | подтверждено | Перезапуск; свой обрыв по HTTP/2; `Cookie` в дампе. Дополнено: тело на `TRACE` не пишется |
| «Recovered from panic» уровнем `ERROR` пишет адрес | подтверждено по коду, на стенде — не проверить | `recovery.go:49`. Паника Traefik не вызывалась ни спайком, ни проверкой |
| Посредник журнал не правит; `common` и `genericCLF` — то же поле; `RequestPath=drop` и `accessLogs: false` убирают лишнее | подтверждено | Перезапуск вариантов; код строит копию адреса до посредников |
| `PathPrefix(/a)` ловит `/api/…` и уводит мимо предела тела | подтверждено | Перезапуск: P11 — 200; приоритеты 1000 и 900 в `raditi.yml` |
| Фрагмент не уходит на сервер, в `Referer` его нет даже с `unsafe-url` | подтверждено | Перезапуск; свой сервер без края: 5 запусков, `sendBeacon`, картинка, `fetch(location.href)`, `document.referrer`, клиентский роутер Next |
| Перенаправления края сохраняют фрагмент в адресе браузера | подтверждено | Перезапуск; 302 без фрагмента сохраняет его, 302 со своим — заменяет |
| Сырой `#` Traefik отклоняет кодом 400 до журнала | исправлено | Верно для `#` в пути. После `?` запрос проходит: P21, свой Q20 |
| «48 маркеров, 0 у сервера» | исправлено | 43 маркера фрагмента — 0 у сервера. 5 маркеров строки запроса доходят до сервера по замыслу. 1 маркер фрагмента — у прокси стенда (WebKit на macOS) |
| WebKit на macOS отдаёт фрагмент адреса `http://` HTTP-прокси, другие — нет | подтверждено | Перезапуск и свой записывающий прокси |
| Сервис-воркер с обработчиком `fetch` видит фрагмент; у `sw.js` такого обработчика нет | подтверждено | Перезапуск, свой воркер, чтение `sw.js` |
| Строка запроса уходит в `Referer`, `?next=` и `Location` | исправлено | Верно для общей политики и пути через `requireSession`: 10 из 10 запросов. С `no-referrer` из Ар33 — 0 из 10 |
| Общий `Referrer-Policy` перебивают более поздняя запись `headers()` и proxy, но не обработчик маршрута | подтверждено | Перезапуск и своё приложение. Дополнено: более ранняя запись проигрывает |
| Next.js 16.3.6 standalone не пишет запросы, ошибки печатает без адреса | подтверждено | Перезапуск, 0 из 6; свои 0 из 7; `log-requests.js` только в dev |
| В метриках Traefik путей нет, у web — только метрики процесса | подтверждено | `/metrics` во всех прогонах; `observability/src/metrics.ts` |
| journald хранит 90 дней и до 10 ГБ; порт клиента край в web не передаёт | подтверждено | `install.sh:46`, `preflight.sh:143`; `verify/fwd-headers.mjs` |
| Образ, digest, версии и 40 флагов из 52 | подтверждено | `docker image inspect`, `traefik version`, парсер YAML |
| Драйвер журнала стенда — `json-file` | исправлено | `local`, `docker info` |

### Предложения к плану

- **Ар33** — следует из данных. 302 со своим фрагментом заменяет фрагмент, без своего — переносит. Поэтому «`/a` не перенаправляет, пока не прочитала фрагмент» — нужное условие. `no-referrer` ставить более поздней записью `headers()` или в `proxy.ts`: более ранняя запись и заголовок обработчика маршрута не действуют.
- **§8.5** — следует, довод поправлен выше. Главное: токен в строке запроса доходит до процесса web и держится на нескольких флагах края, а утечку в `Referer` и `?next=` закрывают те же меры Ар33, что нужны и фрагменту.
- **§10 Э0а** — следует.
- **Э10, 88.16** — следует. Добавлено: ровно один флаг `headers.defaultmode=drop` и запрет `--configfile`. Всё это проверяется в `compose.test.mjs` без Docker.
- **88.16а** — следует: строка края с `ClientPort` и `StartUTC` есть, journald хранит её 90 дней.
- **Ар12 и §7.7** — следует: P17 и P18 повторены, путь `/v/<маркер>` в журнале.
- **`Path(/a)` вместо `PathPrefix(/a)`** — следует.
- **§9** — следует. «Закрепляет тест» заменено на «закрепит тест среза 88.16»: теста ещё нет.

Правила CLAUDE.md предложения не задевают. Журналы остаются на сервере в России (правило 1). Токен ссылки — не секрет Vault, в базе хранится только SHA-256 (Ар33, правило 2).

### Гигиена

В отчёте и файлах спайка нет абсолютных путей, имён и адресов почты. Нет `node_modules`, lock-файлов и двоичных файлов. В `verify/` — только исходники, почта ACME в них — заглушка без «@».

### Не проверено и проверкой

Всё из раздела «Не подтверждено» остаётся в силе. Добавлено: ACME в своём стенде до выпуска сертификата не дошёл (удостоверяющий центр — закрытый порт), поэтому его ошибок за время прогона в журнале не было. Клиентский роутер Next проверен на своём приложении, не на странице `/a` кабинета.
