# CLI агентов в образе песочницы

`package.json` и `package-lock.json` этого каталога задают, что именно попадает в stage `runtime` образа песочницы (`infra/sandbox/Dockerfile`): Codex CLI, Kimi Code CLI и OpenCode CLI с точными версиями всех пакетов, включая транзитивные. Сборка выполняет `npm ci --ignore-scripts`: каждый архив сверяется с `integrity` (sha512) из lock-файла, скрипты установки от root не запускаются. Каталог не входит в рабочее пространство pnpm и в приложение не импортируется.

Скрипты установки не нужны: `postinstall` у Kimi только заменяет shim прежнего Python-CLI при глобальной установке, а `node-pty` (необязательная зависимость Kimi для интерактивного терминала) без сборки остаётся неиспользуемым — в режиме `-p` CLI его не загружает.

У OpenCode пакет `opencode-ai` — пусковой: в нём заглушка `bin/opencode.exe`, которую `postinstall` заменяет исполняемым файлом пакета платформы. Скрипт не запускается, поэтому заглушку запускать нельзя: Dockerfile сам ставит ссылку `/usr/local/bin/opencode` на файл пакета платформы по архитектуре образа — `opencode-linux-arm64` либо `opencode-linux-x64-baseline` (сборка без AVX2; пакет `opencode-linux-x64`, который npm ставит рядом, из слоя удаляется). Целостность по lock-файлу: `opencode-ai` — `sha512-9WUS2T0t…QYnySA==`, `opencode-linux-arm64` — `sha512-ZSjqcH0M…JhouvA==`, `opencode-linux-x64-baseline` — `sha512-StWC81sq…92sHBA==`.

## Смена версии

1. Изменить версию в `package.json` (только точные версии, без диапазонов).
2. Пересоздать lock-файл тем же npm, что в базовом образе, без установки и без скриптов, и отформатировать его:

   ```sh
   cd packages/agent-drivers/cli
   npm install --package-lock-only --ignore-scripts --no-audit --no-fund
   pnpm exec prettier --write package-lock.json
   ```

3. Поправить проверки версий: строки `npm ls …` в `infra/sandbox/Dockerfile`, версию в `infra/dev/llm-verify/cli.Dockerfile` и ожидаемые версии в стендах (`scripts/verify-codex.mjs`, `scripts/verify-opencode.mjs`, `apps/orchestrator/scripts/*-runner-fixture.mjs`, `apps/orchestrator/scripts/verify-runner.mjs`).
4. Пересобрать образ и пройти `pnpm verify:codex`, `pnpm verify:opencode`, `pnpm verify:codex-supervisor`, `pnpm verify:kimi-supervisor`, `pnpm verify:opencode-supervisor`.

Новая версия OpenCode — отдельная задача: обёртка драйвера опирается на свойства 1.18.34 (строка лога об отказе MCP, формат экспорта сессии, имена выключателей, места, откуда CLI импортирует код: три имени рабочей копии, каталог конфигурации и `~/.opencode`), поэтому сначала повторяется разведка `docs/plan/40-opencode-spike.md`, а после — сценарии 9–12 стенда `pnpm verify:opencode`.

`src/cli-lock.test.ts` проверяет, что версии точные, у каждого пакета lock-файла есть архив реестра и sha512, а Dockerfile ставит CLI только из этого lock-файла.
