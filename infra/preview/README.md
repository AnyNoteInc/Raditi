# Образы сессии облачного браузера

Каталог называется `preview` по истории: до [плана 83](../../docs/plan/83-remove-projects.md) здесь собирались образы предпросмотров сайтов (PHP, MariaDB, WP-CLI). Предпросмотров больше нет; остались два образа, из которых `@repo/sandbox-providers` (`src/browser-session`) собирает сессию облачного браузера чата ([план 57](../../docs/plan/57-browser-tasks.md)). Контекст сборки — сама папка (`Dockerfile`, `.dockerignore` пускает только то, что копируется).

| Цель | Переменная | Что внутри |
| --- | --- | --- |
| `tools` | `BROWSER_FORWARDER_IMAGE` | Node 26.10 и tini; `forward.mjs` — пересыльщик управляющего порта браузера |
| `browser` | `BROWSER_IMAGE` | Chromium образа Playwright 1.63.0, `playwright-core` 1.63.0 из `browser/package-lock.json` (`npm ci`, без скриптов установки), `browser-server.mjs` |

Третий образ сессии — прокси выхода (`BROWSER_EGRESS_IMAGE`, цель `client-egress` в `infra/sandbox/Dockerfile`).

```sh
for target in tools browser; do
  docker build -f infra/preview/Dockerfile --target "$target" -t "raditi-preview-${target}:local" infra/preview
done
docker image inspect --format '{{index .RepoDigests 0}}' raditi-preview-tools:local raditi-preview-browser:local
```

Среда принимает образы только по digest (`имя@sha256:…`, без тега). Digest локальной сборки есть только в хранилище образов containerd (Docker Desktop — по умолчанию, на Linux — `"features": {"containerd-snapshotter": true}`) и на каждой машине свой, поэтому в `.env.example` переменные пусты. После правки скриптов образ пересобирается и digest переписывается: среда проверяет только digest. В production образы публикует `.github/workflows/publish-images.yml`. В zsh имя пишется `"raditi-preview-${target}:local"` — без скобок `$target:l` читается как модификатор.

## Скрипты

- `forward.mjs <IPv4>:<порт>=<цель>:<порт> …` — до четырёх маршрутов, у каждого одна неизменная цель; не больше 256 соединений на маршрут, простой 10 минут. Цель никогда не берётся из соединения. Когда слушают все маршруты, пишет `/run/raditi-forward/ready`. Передаёт только байты. Режим `--http-host` (проверка `Host` первого запроса) остался от шлюза входа предпросмотра; сессия браузера его не включает.
- `browser-server.mjs` (в образе — `/usr/local/lib/raditi/browser/server.mjs`) — ждёт секретный путь в `/run/raditi/browser/ws-path` (его пишет среда после старта), запускает `chromium.launchServer` на адресе сети браузера, с `--proxy-server=<прокси выхода>`, `--proxy-bypass-list=<-loopback>`, `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, без `--remote-debugging-port`; затем пишет `/run/raditi/browser/ready`.

## Проверки

- `pnpm test:infra` — разбор маршрутов и пересылка (`forward.test.mjs`), аргументы браузера (`browser-server.test.mjs`).
- `.github/workflows/browser.yml` — сборка обоих образов и сессия браузера на настоящем Docker; `pnpm verify:browser-task` — задача с браузером целиком ([README стенда](../dev/browser-task-verify/README.md)).
