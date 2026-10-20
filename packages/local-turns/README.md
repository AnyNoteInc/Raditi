# @repo/local-turns

Сторона песочницы в ходе агента над локальным `SandboxProvider`: `LocalTurnExecutor`, разбор вывода хода (`turn-output`), экспорт рабочего дерева (`working-tree-export`) и базовый бандл (`base-bundle`). Общий для `core` при `TURN_EXECUTOR=local` и для раннера песочной ВМ (`@repo/runner-engine`).

## Что читает

Окружения не читает: песочницу, драйвер, снимки и ключи хода получает параметрами. Значения переменных окружения клиента маскирует в выводе агента до разбора и отказывает архиву home, в котором значение осталось.

## Команды

- `pnpm --filter @repo/local-turns typecheck`, `lint`, `test`. Сборки нет: Node исполняет исходники сам, поэтому код без параметров-свойств конструктора и `enum`.

## Чего не должно достигать

- БД, Redis, Vault, S3 и биллинга — даже транзитивно (`runner-no-platform-access`): на песочной ВМ нет платформенных секретов.
- Из пакетов платформы берёт только `domain` и `snapshots` (`local-turns-tier`).
- Пакет не импортируют `web`, `trpc`, `ui`, `auth`, `billing` и `notifications` (`web-no-role-runtime`); `llm` до него не дотягивается (`llm-minimal-packages`).
