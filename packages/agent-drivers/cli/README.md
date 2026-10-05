# CLI агентов в образе песочницы

`package.json` и `package-lock.json` этого каталога задают, что именно попадает в stage `runtime` образа песочницы (`infra/sandbox/Dockerfile`): Codex CLI и Kimi Code CLI с точными версиями всех пакетов, включая транзитивные. Сборка выполняет `npm ci --ignore-scripts`: каждый архив сверяется с `integrity` (sha512) из lock-файла, скрипты установки от root не запускаются. Каталог не входит в рабочее пространство pnpm и в приложение не импортируется.

Скрипты установки не нужны: `postinstall` у Kimi только заменяет shim прежнего Python-CLI при глобальной установке, а `node-pty` (необязательная зависимость Kimi для интерактивного терминала) без сборки остаётся неиспользуемым — в режиме `-p` CLI его не загружает.

## Смена версии

1. Изменить версию в `package.json` (только точные версии, без диапазонов).
2. Пересоздать lock-файл тем же npm, что в базовом образе, без установки и без скриптов, и отформатировать его:

   ```sh
   cd packages/agent-drivers/cli
   npm install --package-lock-only --ignore-scripts --no-audit --no-fund
   pnpm exec prettier --write package-lock.json
   ```

3. Поправить проверки версий: строки `npm ls …` в `infra/sandbox/Dockerfile`, версию в `infra/dev/llm-verify/cli.Dockerfile` и ожидаемые версии в стендах (`scripts/verify-codex.mjs`, `apps/orchestrator/scripts/*-runner-fixture.mjs`).
4. Пересобрать образ и пройти `pnpm verify:codex`, `pnpm verify:codex-supervisor`, `pnpm verify:kimi-supervisor`.

`src/cli-lock.test.ts` проверяет, что версии точные, у каждого пакета lock-файла есть архив реестра и sha512, а Dockerfile ставит CLI только из этого lock-файла.
