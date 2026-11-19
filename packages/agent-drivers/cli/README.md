# CLI агента в образе песочницы

`package.json` и `package-lock.json` этого каталога задают, что именно попадает в stage `runtime` образа песочницы (`infra/sandbox/Dockerfile`): OpenCode CLI, сервер MCP навыка «Playwright» и pnpm с точными версиями всех пакетов. Сборка выполняет `npm ci --ignore-scripts`: каждый архив сверяется с `integrity` (sha512) из lock-файла, скрипты установки от root не запускаются. Каталог не входит в рабочее пространство pnpm и в приложение не импортируется.

Пакет `opencode-ai` — пусковой: в нём заглушка `bin/opencode.exe`, которую `postinstall` заменяет исполняемым файлом пакета платформы. Скрипт не запускается, поэтому заглушку запускать нельзя: Dockerfile сам ставит ссылку `/usr/local/bin/opencode` на файл пакета платформы по архитектуре образа — `opencode-linux-arm64` либо `opencode-linux-x64-baseline` (сборка без AVX2; пакет `opencode-linux-x64`, который npm ставит рядом, из слоя удаляется). Целостность по lock-файлу: `opencode-ai` — `sha512-9WUS2T0t…QYnySA==`, `opencode-linux-arm64` — `sha512-ZSjqcH0M…JhouvA==`, `opencode-linux-x64-baseline` — `sha512-StWC81sq…92sHBA==`.

Кроме OpenCode, в lock-файле — сервер MCP навыка «Playwright» (запрос владельца от 26.10.2026): `@playwright/mcp` 0.0.83 с его `playwright` и `playwright-core` той версии, которую он называет. Dockerfile ставит его тем же `npm ci --ignore-scripts`, сверяет `npm ls @playwright/mcp@…` и при сборке скачивает Chromium его Playwright с системными библиотеками (`cli.js install-browser --with-deps --no-shell chromium`, каталог `/opt/ms-playwright`): ход ничего не скачивает. Пути сервера и браузеров называет драйвер (`src/opencode.ts`), `src/cli-lock.test.ts` сверяет их с Dockerfile. CLI прежних оболочек с их зависимостями удалены в G8 (`docs/plan/48-removal.md`), записи OpenCode при этом не менялись.

Для проверок агента в репозитории клиента — `pnpm` 12.6.0 (spec §20, «Инструменты песочницы — решения 19.11.2026», ИП3): та версия, которую закрепляет этот репозиторий (`devEngines.packageManager` корневого `package.json`, `packageManagerDependencies` в `pnpm-lock.yaml`); репозиторию, который закрепляет другую, этот pnpm сам скачивает и запускает её. Пакет `pnpm` тоже пусковой: в нём заглушки `pnpm`, `pn`, `pnpx` и `pnx`, и его `install.js` (`preinstall` и `postinstall`) ставит на место заглушки `pnpm` исполняемый файл пакета платформы `@pnpm/exe.<платформа>`. Скрипт не запускается, поэтому Dockerfile делает то же, что он: жёсткая ссылка файла `@pnpm/exe.linux-arm64` либо `@pnpm/exe.linux-x64` по архитектуре образа на место заглушки `node_modules/pnpm/pnpm` — рядом с ней исполняемый файл находит `dist/` пускового пакета (node-gyp); сборка для musl той же архитектуры, если npm её поставил, из слоя удаляется, и другого исполняемого файла pnpm в слое нет. Ссылки — `/usr/local/bin/pnpm` и `/usr/local/bin/pnpx` (скрипт оболочки, он запускает `pnpm` рядом с собой). Целостность по lock-файлу: `pnpm` — `sha512-PvaPlRyx…AP0g7A==`, `@pnpm/exe.linux-arm64` — `sha512-8h2sNoIh…LWvrYg==`, `@pnpm/exe.linux-x64` — `sha512-qFWBneHJ…00Jabw==`. Corepack и yarn в образе нет. Где команды агента держат кэши, хранилище pnpm и глобальные пакеты, называет `SANDBOX_TOOLS_HOME` домена (`/workspace/.cache`, ИП4), а переменные, которые их туда ведут, задаёт драйвер (`src/opencode.ts`).

## Смена версии

1. Изменить версию в `package.json` (только точные версии, без диапазонов).
2. Пересоздать lock-файл тем же npm, что в базовом образе (строка `FROM` в `infra/sandbox/Dockerfile`), без установки и без скриптов, и отформатировать его:

   ```sh
   cd packages/agent-drivers/cli
   docker run --rm -v "$PWD:/cli" -w /cli \
     node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 \
     npm install --package-lock-only --ignore-scripts --no-audit --no-fund
   pnpm exec prettier --write package-lock.json
   ```

3. Поправить проверки версии: строку `npm ls …` в `infra/sandbox/Dockerfile`, версию в `infra/dev/llm-verify/cli.Dockerfile` и ожидаемую версию в стендах (`scripts/verify-opencode.mjs`, `apps/core/scripts/opencode-runner-fixture.mjs`, `apps/core/scripts/verify-runner.mjs`, `infra/dev/llm-verify/cli.mjs`). У pnpm — строку `npm ls pnpm@…` в Dockerfile и `PNPM_VERSION` в `scripts/verify-opencode.mjs`; пакеты `@pnpm/exe.*` новой версии lock-файл получает сам, а их имена в Dockerfile меняются, только если pnpm переименует пакеты платформы (`native-binary.mjs` пускового пакета).
4. Пересобрать образ и пройти `pnpm verify:opencode` и `pnpm verify:opencode-supervisor`.

Новая версия OpenCode — отдельная задача: обёртка драйвера опирается на свойства 1.18.34 (строка лога об отказе MCP, формат экспорта сессии, имена выключателей, места, откуда CLI импортирует код: три имени рабочей копии, каталог конфигурации и `~/.opencode`; папка `tool-output` каталога данных, куда CLI кладёт слишком длинный вывод инструмента; предел `timeout` инструмента bash — 600 000 мс при 120 000 по умолчанию, его называет `SANDBOX_SHELL_TIMEOUT_MAX_MS` в `@repo/domain`), поэтому сначала повторяется разведка `docs/plan/40-opencode-spike.md`, а после — сценарии 9–12 стенда `pnpm verify:opencode`.

`src/cli-lock.test.ts` проверяет, что версия точная, у каждого пакета lock-файла есть архив реестра и sha512, а Dockerfile ставит CLI только из этого lock-файла — ни npm, ни pnpm, ни yarn ничего не ставят в stage `runtime` мимо него (`install`, `i`, `add`, `exec`, `dlx`, `npx`, `pnpx`), — и ставит ссылки на исполняемые файлы OpenCode и pnpm архитектуры образа.
