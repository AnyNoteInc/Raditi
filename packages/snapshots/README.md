# @repo/snapshots

Снимки сессии хода: шифрование и разбиение на части (`snapshot-crypto`, `snapshot-parts`), проверка архива (`archive-validation`), перенос по временным ссылкам S3 (`presigned-transfer`), снимок песочницы (`sandbox-snapshot`) и ограниченный по времени и выводу запуск команд (`execBounded`, `exec.ts`). Общий для `core`, раннера (через `local-turns`) и `mcp` (запечатывает артефакты тем же ключом данных). Хранение в S3 и ключи Transit — на стороне приложений (`snapshot.service` остался в `core`).

## Что читает

Окружения не читает: ключ данных, ссылки и песочница приходят параметрами.

## Команды

- `pnpm --filter @repo/snapshots typecheck`, `lint`, `test`. Сборки нет: Node исполняет исходники сам.
- `./testing` — S3 в памяти и Transit для тестов; его импортируют только тестовые файлы (`package-testing-only-in-tests`).

## Чего не должно достигать

- БД, Redis, Vault, S3 как клиентов и биллинга — даже транзитивно (`runner-no-platform-access`): пакет работает на песочной ВМ, где нет платформенных секретов.
- Зависит только от `domain` (`adapters-depend-on-domain-only`) и `tar-stream`.
- Пакет не импортируют `web`, `trpc`, `ui`, `auth`, `billing` и `notifications` (`web-no-role-runtime`).
