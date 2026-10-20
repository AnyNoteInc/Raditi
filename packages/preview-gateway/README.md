# @repo/preview-gateway

Сервер шлюза предпросмотров диалогов (план 53, Р19): точный `Host` предпросмотра → его upstream, одноразовые билеты кабинета (`preview-access`), собственная cookie (`preview-cookie`), заголовки ответа и `frame-ancestors` (`preview-headers`), страницы отказов (`preview-pages`), источники браузера агента для прямого прокси (`preview-relays`), кэш с временем жизни (`ttl-cache`). Без фреймворка: Nest-модуль и запуск — в `apps/preview`; тесты `core` гоняют сервер против настоящего предпросмотра.

## Что читает

Окружения не читает: конфигурацию (адрес предпросмотров, секрет cookie, `PREVIEW_BROWSER_RELAYS`, `APP_URL`) и клиент БД получает от `apps/preview`. Список источников разбирает `parsePreviewRelays`: в production диапазон должен целиком лежать в частном или loopback-блоке.

## Команды

- `pnpm --filter @repo/preview-gateway typecheck`, `lint`, `test`. Сборки нет: Node исполняет исходники сам.

## Чего не должно достигать

- Адрес upstream берётся только из строки `preview_environments`, не из запроса.
- Зависит только от `domain`, `db` и `ip-address`: ни песочницы, ни git, ни Vault, ни S3.
