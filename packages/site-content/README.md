# @repo/site-content

Общее для `core` и `mcp` о содержимом предпросмотра диалога и подключённого сайта: запись предпросмотра (`preview-record`), транспорт к его копии плагина «Радити» (`preview-transport`), значения плана БД (`db-plan-values`, `preview-db-values`), проверка публикуемого значения (`published-value`), пределы размера (`content-limits`) и резолвер шлюза содержимого сайта (`createSiteContentResolver`: `credential_refs` → Vault → адаптер по стеку). Без фреймворка. Реализация доверенного отката остаётся в `apps/mcp`.

## Что читает

Окружения не читает: клиент БД, хранилище секретов и адрес предпросмотров приходят параметрами от приложения.

## Команды

- `pnpm --filter @repo/site-content typecheck`, `lint`, `test`. Сборки нет: Node исполняет исходники сам.

## Чего не должно достигать

Только `domain`, `db`, `snapshots` и `turn-keys` (`site-content-tier`): ни `trpc`, ни `ui`, ни кода агентов и песочницы. Резолвер зависит от узкого структурного типа области вызова, а не от журнала `mcp`. Пакет не импортируют `web`, `trpc`, `ui`, `auth`, `billing` и `notifications` (`web-no-role-runtime`); `llm` до него не дотягивается (`llm-minimal-packages`).
