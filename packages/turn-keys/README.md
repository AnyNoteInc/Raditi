# @repo/turn-keys

Ключи хода и пул подписок — то, что делят `core` (выдаёт ключи, подметает их, пробует пул), `llm` (проверяет и расходует) и `mcp` (проверяет формат пары и хеш). Без портов и без фреймворка: Nest-обвязка остаётся в приложениях.

## Что внутри

- `turn-key.ts` — формат и хеш ключа хода; `turn-credentials.ts` — выдача (`GatewayTurnCredentials`, правила `issue`, отзыв, вывод аккаунта).
- `credential-sweeper.ts` — сборщик ключей; `backends.ts` — реестр бэкендов и маршрут шлюза (`llmGatewayBaseUrl`).
- `gateway-store.ts`, `gateway-types.ts` — `PostgresGatewayStore` и типы хранилища шлюза; `site-env-values.ts` — значения переменных окружения клиента.
- `./testing` — образцовые id и сценарные фейки для тестов (`testing.ts` импортируют только тестовые файлы: `package-testing-only-in-tests`).

## Что читает

Окружения не читает: порты, пути и клиент БД приходят параметрами от приложения.

## Команды

- `pnpm --filter @repo/turn-keys typecheck`, `lint`, `test`. Сборки нет: Node исполняет исходники сам, поэтому код без синтаксиса, который он не вычищает (параметры-свойства конструктора, `enum`).

## Чего не должно достигать

Только `domain`, `db` и `llm-backends` (`turn-keys-tier`): ни песочницы, ни `trpc`, ни `ui`, ни других сервисов. Пакет не импортируют `web`, `trpc`, `ui`, `auth`, `billing` и `notifications` (`web-no-role-runtime`).
