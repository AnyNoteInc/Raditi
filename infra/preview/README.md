# Образы предпросмотра

Предпросмотр диалога ([план 53](../../docs/plan/53-chat-preview-release.md), Р18, Р21) запускает среда `createDockerPreviewRuntime` из `@repo/sandbox-providers` (`packages/sandbox-providers/src/preview`). Публичные образы — PHP (`PREVIEW_WEB_IMAGES`), MariaDB (`PREVIEW_DB_IMAGE`) и WP-CLI (`PREVIEW_CLI_IMAGE`) — берутся по digest, их значения для разработки — в `.env.example`. Два образа собираются из этой папки (`Dockerfile`, контекст — сама папка):

| Цель | Переменная | Что внутри |
| --- | --- | --- |
| `tools` | `PREVIEW_FORWARDER_IMAGE` | Node 26.10 и tini; `forward.mjs` — пересыльщик TCP (вход предпросмотра и пересыльщик браузера), `files.mjs` — запись дерева в том docroot |
| `browser` | `PREVIEW_BROWSER_IMAGE` | Chromium образа Playwright 1.63.0, `playwright-core` 1.63.0 из `browser/package-lock.json` (`npm ci`, без скриптов установки), `browser-server.mjs` |

```sh
for target in tools browser; do
  docker build -f infra/preview/Dockerfile --target "$target" -t "raditi-preview-${target}:local" infra/preview
done
docker image inspect --format '{{index .RepoDigests 0}}' raditi-preview-tools:local raditi-preview-browser:local
```

Digest локальной сборки есть только в хранилище образов containerd (Docker Desktop — по умолчанию, на Linux — `"features": {"containerd-snapshotter": true}`); на каждой машине он свой, поэтому в `.env.example` эти две переменные пусты. В переменные пишется вывод последней команды — `raditi-preview-tools@sha256:…`; ссылка с тегом (`имя:тег@sha256:…`) схемой не принимается. После правки скриптов образ пересобирается и digest переписывается: среда проверяет только digest, не содержимое. В zsh имя пишется `"raditi-preview-${target}:local"` — без скобок `$target:l` читается как модификатор.

## Что делает каждый скрипт

- `forward.mjs [--http-host=<имя>] <IPv4>:<порт>=<цель>:<порт> …` — до четырёх маршрутов, у каждого одна неизменная цель; не больше 256 соединений на маршрут, простой 10 минут. После того как слушают все маршруты, пишет `/run/raditi-forward/ready`. Пересыльщик браузера передаёт только байты. Пересыльщик входа (`--http-host=<hostname предпросмотра>`) читает ещё заголовок первого запроса соединения — он приходит от платформы (шлюз, роль `mcp`), не от предпросмотра: запрос к другому `Host` получает `421 Misdirected Request` и до PHP не доходит, искажённый — `400`; прошедший уходит с `Connection: close` вместо заголовков соединения, так что следующий запрос из пула шлюза приходит новым соединением и тоже проверяется (запрос `Upgrade` идёт как есть — туннель один). Ответ PHP не разбирается. Зачем: опубликованный порт принадлежит предпросмотру, только пока жив контейнер пересыльщика; остановленный — и после перезапуска dockerd — Docker отдаёт порт следующему, и вызывающий со старой строкой `upstream` получил бы чужой сайт.
- `files.mjs init <uid>:<gid>` — отдаёт том docroot пользователю PHP (запуск от root только с `CAP_CHOWN`). Среда зовёт его при каждой сборке: том этого пользователя остаётся как есть (владелец смотрится `lstat`, без открытия — PHP мог закрыть каталог и от root без `DAC_OVERRIDE`), пустой том root — отдаётся, том другого пользователя или с файлами — отказ `root_owner` (среда отвечает `CONFLICT`: предпросмотр уничтожают и собирают заново). Так сборка, упавшая между созданием тома и `init`, чинится следующей. `files.mjs write` — кадр `<u32 длина><JSON {replace, deletes}>` и tar на stdin: только обычные файлы и каталоги (ustar, pax `path`, GNU long name), отказ ссылкам, устройствам, `..`, абсолютным путям, не-UTF-8 и записи через существующую ссылку на любом участке пути (каждый каталог открыт без перехода по ссылкам, следующее имя — под его дескриптором). Права корня docroot, которые PHP отнял у себя же, возвращаются (`u+rwx`). Причина отказа — слово из фиксированного списка в stderr (`refused: path_conflict`), код 3; пути не печатаются.
- `browser-server.mjs` (в образе — `/usr/local/lib/raditi/browser/server.mjs`) — ждёт секретный путь в `/run/raditi/browser/ws-path` (его пишет среда после старта), запускает `chromium.launchServer` на адресе сети браузера, с `--proxy-server=<пересыльщик>`, `--proxy-bypass-list=<-loopback>`, `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, без `--remote-debugging-port`; затем пишет `/run/raditi/browser/ready`.

## Хост предпросмотров

- **Пулы адресов Docker.** Каждый предпросмотр занимает свою сеть `rpv…`, а пока работает браузер — ещё `rpb…`; живут они до 72 часов. Пулы Docker по умолчанию (пятнадцать `/16` в 172.17–31 и шестнадцать `/20` в 192.168) общие с compose и сетями попыток песочницы, и на них хост упирается примерно в 15–25 предпросмотров с браузером — дальше `ensure` падает общей ошибкой Docker. На машине, где работают предпросмотры (в облаке — песочная ВМ), в `/etc/docker/daemon.json` задаются мелкие подсети, как для сетей попыток (spec §8): `"default-address-pools": [{"base": "10.200.0.0/16", "size": 28}]` — 4096 сетей; `/28` — самая мелкая сеть, которую принимает среда (`subnetAddress`), адреса предпросмотра — `.2`–`.5`, браузера — `.2`–`.3`. Проверку этого в preflight песочной ВМ добавит M10.
- **gVisor и `PidsLimit`.** Под `runsc` предел pids хоста считает потоки ядра песочницы (sentry), а не процессы предпросмотра: среда поднимает его до 128 (`RUNSC_MIN_PIDS`). Замер 17.10.2026 (Colima, 4 vCPU): при 32 пять из восьми запусков Node в новом контейнере кончились `WaitPID failed: EOF`.
- **Где шлюз для браузера.** Пересыльщик браузера шлёт прокси-трафик на `host.docker.internal:PREVIEW_GATEWAY_PORT` (`host-gateway` демона — исполнитель `local`). Если `host-gateway` указывает на другую машину (Colima указывает на Mac) — и для исполнителя `runner` (M10) — среде передаётся адрес шлюза (`gatewayHost`, IPv4).
- **Мост по умолчанию.** Пересыльщики входа, прокси выхода и пересыльщик браузера стоят на мосту Docker по умолчанию (ICC включён) и слушают на нём `0.0.0.0`. Что прокси выхода (R10) не ходит на частные адреса — в том числе этого моста и хоста, — главная преграда между PHP одного предпросмотра и чужими пересыльщиками; вторая — пересыльщик входа пускает только `Host` своего предпросмотра. Отдельный мост с `enable_icc=false` закрыл бы адреса моста, но не порты, опубликованные на частном адресе хоста (`PREVIEW_UPSTREAM_HOST` в облаке: их через `docker-proxy` достаёт любой контейнер с путём к хосту), и потребовал бы сменить `PREVIEW_BROWSER_RELAYS` шлюза — отложено до M10 вместе с исполнителем `runner`.

## Проверки

- `pnpm test:infra` — разбор маршрутов, проверка `Host` и пересылка, разбор tar и кадра, подготовка тома, аргументы браузера; запись дерева проверяется только на Linux (`/proc/self/fd`).
- `RADITI_PREVIEW_DOCKER_TESTS=1 pnpm --filter @repo/sandbox-providers exec vitest run src/preview/runtime.integration.test.ts` — среда на настоящем Docker с образами `:local` выше; `PREVIEW_RUNTIME=runsc` и `SANDBOX_NETWORK_GUARD_IMAGE` — под gVisor, `SANDBOX_DOCKER_SOCKET` — другой демон (например, Colima: `~/.colima/<профиль>/docker.sock`).
- `pnpm verify:preview-network` — сеть предпросмотра со всех сторон ([README стенда](../dev/preview-verify/README.md)).
- В CI — `.github/workflows/preview.yml`.
