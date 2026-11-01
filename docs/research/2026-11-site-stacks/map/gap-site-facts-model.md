# Пробел 3: одна модель фактов о сайте

Дата: 01.11.2026. Код: клон `raditi-stacks` (`c811abf1`, равен `main`); совместимость с планом 61 проверена по дереву `raditi-chats` (`1036ec9b`). Код продукта не менялся, CMS не запускались. Запускались два прогона: чтение версий по скачанным деревьям и настоящая политика браузера WordPress (раздел 13).

Закрывает `map/critic.md`, пробел 3, и строку `detect` из его таблицы противоречий.

## 1. Решение

1. **Одно хранилище.** JSON-колонка `sites.facts`, схема в `@repo/domain`, внутри пять частей: `code`, `live`, `database`, `config`, `runtime` (раздел 3). `SiteFacts` собирает одна чистая функция, восемь литералов и два конструктора уходят.
2. **Один читатель.** Файлы сайта читает только `core`, новым методом `readFacts(tree)`, в своём сеансе к хостингу. Мастер в web читает только `readVersion(read)`: версию без файлов конфигурации, для показа и раннего отказа.
3. **`detect` удаляется.** Спор «удалить или использовать» шёл о двух разных работах. Опознание корня — `isSiteRoot(names)`, чтение фактов — `readFacts(tree)`. `ServerProbe` уходит с ним.
4. **Порядок импорта:** сеанс, `readFacts`, `importRules`, `configSecrets`, обход. Запись — вместе с `recordPlan`. Правка короткая.
5. **Перечитывание** — в том сеансе, который предпросмотр и так открывает на каждую свежую копию базы, и перед `/release`. Крона нет.
6. **Главный инвариант: без файлов работают только браузерные методы, и версии они не получают по типу.** Им передаётся `{ url, adminPath? }`. Запрет судится по параметрам запроса точным разрешённым списком, общим для всех поколений стека. На маршрутах OpenCart проверено по исходникам: формы разных поколений не пересекаются (раздел 7).
7. **Факт только сужает работу.** Отсутствующий или неверный факт не открывает экран, не пропускает файл в git и не отдаёт секрет.
8. **Манифест ядра на версию не нужен.** Замер: границу дают папки, у Joomla — список на поколение из самой поставки (раздел 8).

Новая находка, которой нет в картах: неверно названный стек в «Без доступа» нарушает правило 1 даже при обязательном выборе платформы. Проверено запуском (раздел 7.3).

## 2. Что меняет постановку

Всё проверено по коду.

| Факт | Где | Следствие |
| --- | --- | --- |
| Из семи полей `SiteFacts` адаптеры читают три: `url`, `database`, `runtimeVersion`. `stack`, `docroot`, `version`, `extras` не читает никто | `packages/domain/src/ports/site-adapter.ts:36-49`, `wordpress-verify.ts:35`, `wordpress-preview.ts:85`, `wordpress-db-copy.ts:259`, поиск по `packages/site-adapters/src` | Поля можно менять без оглядки на поведение. `docroot` и `extras` удаляются |
| `SiteFacts` собирается в десяти местах: восемь литералов и два конструктора | Литералы: `release-skill.ts:701,724,960`, `undo-planner.ts:224`, `release-api.service.ts:258,276`, `site-import.ts:484`, `apps/mcp/src/content/content.module.ts:131`. Конструкторы: `pass-facts.ts:63`, `preview-builder.ts:186` | `mcp` не может импортировать `core`, поэтому функция сборки — в `@repo/domain` |
| Обещание «версии придут с подключением (план 39)» не выполнено | `pass-facts.ts:59-62`, `docs/spec.md:1372` («Разведка… определяет стек, версии») | Шаг разведки есть только в тексте |
| `sites.installed_version` — тег выпуска `vX.Y.Z`, не версия CMS | `packages/db/prisma/schema.prisma:267-269` | Имя `stack_version` рядом с ним путало бы |
| Без файлов адаптер получают только браузерные методы: правила и рабочий набор считаются при `requirements.repository` | `pass-facts.ts:274-275` | Это и есть инвариант п. 6 |
| Соглашение об отказе уже есть: «a stack with a database refuses… rather than guess» | `site-adapter.ts:42-46`, `preview-builder.ts:614-618`, `release-skill.ts:718-730` | Новая обработка неизвестного почти не нужна |
| `NOT_IMPLEMENTED` у `agentWorkingSet` включает полное дерево | `pass-facts.ts:79-87` | Адаптер не должен бросать его из-за неизвестной версии: `publicationLimits.bundleBytes` 64 МиБ, ход не стартует |
| Сеанс к хостингу на свежую копию уже открывается | `preview-builder.ts:279`, `site-sources.ts:205-221` | Перечитывание не добавляет соединений |
| `read` бывает двух видов. У `publicOriginals` — по скачанным копиям, у `configSecrets` — по хостингу | `public-originals.ts:58-63`, `site-import.ts:538` | Факты нельзя брать из скачанного: конфигурация не импортируется, ядро Битрикса тоже |
| `read` не выходит из корня и не умеет список | `tree-walk.ts:276-285`, `FileSourceSession.list` в `packages/domain/src/site-connection/ports.ts:122` | Папку админки OpenCart одним `read` не найти. Нужен читатель со списком |

## 3. Модель

### Что хранится

Новый файл `packages/domain/src/site-connection/site-facts.ts`, эскиз:

```ts
const version = z.string().regex(/^[0-9][0-9A-Za-z.+-]{0,31}$/) // как VERSION в wordpress-public-code.ts:9
const token = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,15}$/)    // 'oc3', 'j4', 'modx2', 'ocstore'
const layoutKey = z.string().regex(/^[a-z][A-Za-z]{0,31}$/)
/** Путь от корня сайта; абсолютных путей хостинга здесь нет. */
const layoutValue = z.string().regex(/^\/(?!\/)[A-Za-z0-9._~\/-]{0,127}$/).refine(noDotDot)

const siteCodeFactsSchema = z.strictObject({
  version: version.nullable(),
  generation: token.nullable(),   // на что ветвятся методы адаптера
  edition: token.nullable(),      // форк или редакция
  layout: z.record(layoutKey, layoutValue),      // adminPath, coreDir, connectorsPath, assetsPath…
  outsideRoot: z.array(layoutKey).max(8),        // части сайта вне подключённой папки
})

export const siteStoredFactsSchema = z.strictObject({
  v: z.literal(1),
  code: siteCodeFactsSchema.nullable(),          // что лежит в репозитории: пишет только импорт
  live: siteCodeFactsSchema.extend({             // что на сайте при последнем чтении
    source: z.enum(['files', 'client']),
    readAt: z.iso.datetime(),
  }).nullable(),
  database: siteDatabaseSettingsSchema.nullable(),
  config: z.record(layoutKey, z.string().max(128)), // настройки предпросмотра, закрытый список адаптера
  runtime: z.strictObject({
    version: z.string().regex(/^\d{1,2}\.\d{1,2}$/),
    source: z.enum(['plugin', 'header', 'preview']),
    readAt: z.iso.datetime(),
  }).nullable(),
})
```

`sites.facts JSONB NULL` с CHECK `octet_length(facts::text) <= 8192`. Строка другой формы читается как пустая: так же, как `previewRecordOf` (`preview-record.ts:62-65`).

### Что получает адаптер

```ts
export interface SiteFacts {
  stack: SiteStack
  url: string
  version?: string
  generation?: string
  edition?: string
  layout: Readonly<Record<string, string>>
  outsideRoot: readonly string[]
  runtimeVersion?: string
  database?: SiteDatabaseSettings
  config: Readonly<Record<string, string>>
}

export interface BrowserTaskSite { url: string; adminPath?: string }
```

Эти значения собирают `siteFactsFromRow(row)` и `browserSiteFromRow(row)`. Первая берёт `code`: метод описывает дерево из `main`. Вторая берёт `live ?? code`: браузер работает с живым сайтом.

### Зачем и `code`, и `live`

`agentWorkingSet`, `protectedPaths` и `previewRecipe` говорят о дереве `main`, а оно приходит из импорта. Адрес браузера и сверка говорят о хостинге. Владелец обновил CMS или переименовал админку — значения разошлись, это и есть дрейф (раздел 5). Если хранить одно значение, перечитывание либо ломает рецепт старого дерева, либо молча скрывает дрейф.

### Почему JSON на `sites`

- `stack_version` закрывает одно предложение из семи, `admin_path` — второе. Остальное снова уехало бы в новые колонки.
- По этим полям никто не фильтрует в SQL.
- Строку `sites` читают пять процессов, отдельная таблица добавила бы связь без пользы: истории не нужно, внешних ключей нет. `apps/browser` добавит одно поле в `worker-store.ts:136-139`.
- Образец уже есть: `preview_environments.runtime` со схемой и пределом 8 КиБ.

### Значения с хостинга недоверенные

Сайт клиента может быть взломан, а факты идут в кабинет, в `site_info` и в `startPath`. Поэтому:

- только короткие значения по регулярным выражениям, свободного текста нет;
- абсолютных путей нет: `DIR_STORAGE` и `MODX_CORE_PATH` дают `outsideRoot` или относительное имя;
- `config` — закрытый список имён у адаптера. Перед записью `core` сверяет значения с точными значениями скана импорта;
- `startPath` не начинается с `//`, иначе `new URL(policy.startPath, site.origin)` (`session-manager.ts:203`) уйдёт на чужой хост. Это держит `layoutValue`.

## 4. Кто читает и в каком порядке

| Когда | Процесс | Метод | Результат |
| --- | --- | --- | --- |
| Мастер, шаг 2 | web | `isSiteRoot(names)`, `readVersion(read)` в бюджете `checkMs` 15 с | Показать и отказать. Не пишется |
| `project.create`, вариант без файлов | web | Поля мастера | `live.layout.adminPath`, `source: 'client'` |
| Импорт | `core` | `readFacts(tree)` | `code`, `live`, `database`, `config` — вместе с `recordPlan` |
| Сборка со свежей копией базы | `core` | `readFacts(tree)` | `live`, `database`, `config` |
| Каждая сборка | `core` | `gateway.runtime()`, где есть | `runtime` |
| `/release`, до аренды | `core` | `readFacts(tree)` | Сверка `live` |

**Почему web не зовёт `readFacts`.** Он прочитал бы файл с паролем базы в процессе web. `readVersion` читает только файлы поставки без секретов. Замер: не больше двух чтений, файлы до 1,8 КиБ (раздел 9). `CheckBrowser.readHead` сейчас отбрасывает байты (`packages/site-connections/src/sources/root-check.ts:34`), для `readVersion` он должен их вернуть.

**Порядок в `fetchTree`.** Сейчас `importRules` стоит до открытия сеанса (`site-import.ts:482-486`), сеанс открывается ниже (`:516`). Перестановка:

```ts
opened = await checked.adapter.open(checked.access, { address, signal: walkSignal })
// ...
const reading = await rules.readFacts(treeOf(session, walkSignal))
if (reading.kind === 'refused') throw refuse(reading.reason)
const facts = siteFactsOfReading(stage, reading)
const policy = createImportPathPolicy(rules.importRules(facts).exclude)
configValues = await rules.configSecrets((path) => readRootFile(session, path, walkSignal))
walk = await walkSiteTree({ session, policy, /* ... */ })
```

`fetchTree` возвращает чтение наверх, и `recordPlan` (`site-import.ts:457`) пишет факты одной транзакцией с планом. Прогон, который только дописывает тег, к хостингу не ходит, как и сейчас (`:486` и `:172-177`): факты записаны при плане.

**Читатель.**

```ts
export interface SiteTree {
  /** Записи папки ниже корня; null — папки нет или она не читается. */
  list(path: string): Promise<readonly { name: string; type: 'file' | 'directory' | 'link' }[] | null>
  /** Как `read` у `configSecrets`: файл ниже корня, не больше configFileBytes, иначе null. */
  read(path: string): Promise<Uint8Array | null>
}
```

Чтения идут по одному: у читателя может быть одно соединение (`bitrix.ts:109`). `site-sources.ts` получает `withTree` вместо `withRoot`.

**Правило для `importRules`.** Шаблоны, защищающие секреты, от фактов не зависят: `/config.php`, `/*/config.php`, `configuration*`. Факт только уточняет остальное. Ошибка разбора не должна вести секрет в git. Точные значения и `gitleaks` остаются второй и третьей линией.

## 5. Когда перечитывается

| Момент | Что | Цена | Если значения разошлись |
| --- | --- | --- | --- |
| Импорт | Всё файловое | Часть импорта | Первая запись `code` и `live` |
| Свежая копия базы (`freshSeed`, `preview-builder.ts:568,596`) | `live`, `database`, `config` | Тот же сеанс плюс 1–3 чтения | Сверка `siteDrift` |
| Каждая сборка (`preview-builder.ts:598-611`) | `runtime` | Как сейчас | Записать |
| `/release`, в `#start` рядом с `#productionCheck` (`release-skill.ts:386-403`), до аренды | `live` | Один сеанс, до 60 с | Сверка `siteDrift` |
| «Изменить доступ» | Ничего сразу | 0 | Перечитает следующая сборка |
| Задача в браузере | Ничего | 0 | Файлов нет или хватает сохранённого |
| Крон | Нет | — | Хостинг не нагружается ради того, что понадобится только при сборке |

Хостинг не ответил — остаётся сохранённое и пробуем при следующей сборке, как сейчас у `runtime` (`preview-builder.ts:598-600`).

**Сверка нейтральна к стеку и живёт в домене:**

```ts
siteDrift(code, live): 'none' | 'version' | 'code'
```

| Итог | Условие | Предпросмотр | `/release` | Браузер |
| --- | --- | --- | --- | --- |
| `none` | Всё совпало | Как обычно | Как обычно | Как обычно |
| `version` | Отличается только `version` | Собирается, строка в «Проверках» рядом с `runtimeMatchText` | Идёт | Как обычно |
| `code` | Отличается `generation`, `edition`, `layout` или `outsideRoot` | `unavailable`, новая причина `site_updated` | Отказ | Как обычно, по `live` |

Выход из `code` — повторный импорт, а его нет (`site-import.ts:173-177`). Это пробел 7 критики, и до него клиенту остаётся оператор. Модель даёт сверку и причину, сам повторный импорт — отдельная работа.

Гарантии сверка не даёт: обновление между сверкой и заданием выкладки она не увидит. `deploy-step` смотрит только пути диффа (`deploy.ts:778-816`). Это принято: сверка ловит состояние, а не гонку.

## 6. Методы адаптера

### Удаляются и добавляются

| Что | Изменение |
| --- | --- |
| `detect`, `ServerProbe` | Удаляются. Реализаций нет, по FTP `exec` невозможен, вызовов нет |
| `databaseSettings(read)` | Входит в `readFacts`. Отбор по каталогу базы (`preview-builder.ts:283-297`) остаётся запасным путём |
| `SiteFacts.docroot`, `.extras` | Удаляются |
| `isSiteRoot(names)` | Новый, чистый: опознание по именам. Нужен для автоопределения и для MODX, где `rootMarkers` не хватает (`modx.md:127`) |
| `readVersion(read)` | Новый: только файлы поставки, не больше двух чтений |
| `readFacts(tree)` | Новый. Ответ: `{ kind: 'read', code, database, config }` или `{ kind: 'refused', reason }` |
| `browserAdminAddress()` | Новый: адрес по умолчанию и можно ли его сменить. Для поля мастера |

### Что получают остальные

| Группа | Метод | Вход | Если факта нет |
| --- | --- | --- | --- |
| Нужны файлы | `importRules` | `SiteFacts` | Шаблоны шире, исключается больше |
| | `protectedPaths` | `SiteFacts` | Никогда не бросает, шаблоны шире |
| | `agentWorkingSet` | `SiteFacts` | Узкий набор: только темы и шаблоны. Не `NOT_IMPLEMENTED` |
| | `mediaRules` | `SiteFacts` | Значение по умолчанию стека |
| | `previewRecipe`, `databaseCopyPolicy` | `SiteFacts` | Бросает, предпросмотр `unavailable`. Так же при непустом `outsideRoot` |
| | `dbOperationKinds`, `dbSettings`, `dbPlanGuide` | `SiteFacts` | Пусто: плана БД нет |
| | `verify` | `SiteFacts` | Главная страница, общие метки сбоя |
| Файлы без фактов | `rootMarkers`, `configSecrets`, `publicOriginals` | Без изменений | Как сейчас |
| Без файлов | `browserTaskPolicy` | `BrowserTaskSite` | Старт с `browserAdminAddress`, иначе `/`; запреты те же |
| | `browserGuide`, `browserVerification` | Появляется `BrowserTaskSite` | Адрес берётся из `ref.editUrl`. У MODX папка коннекторов отдельная, поэтому нужен `site` |
| | `browserCheckpointOf`, `browserCommitAction`, `browserRequestDenied` | Без изменений | Судят по параметрам и имени |

Вызовы `BrowserTaskSite` меняются в четырёх местах: `session-manager.ts:183`, `worker-store.ts:136-139`, `apps/mcp/src/site-info/browser-tasks.ts:26`, `pass-facts.ts:381`. Если версия понадобится браузерному методу, это потребует сменить тип: инвариант держит компилятор.

## 7. Неизвестное значение и сайт без файлов

### 7.1. Сайт с файлами

| Случай | Что происходит |
| --- | --- |
| Файл версии не прочитан | Импорт идёт: копия сайта от версии не зависит. `version: null`, `generation` по форме дерева, если получится. Предпросмотра и плана БД нет, рабочий набор узкий, браузер работает |
| Версия вне поддержки | `refused`, `version_unsupported`; в мастере раньше, на шаге 2 |
| Другой продукт или сайт не установлен (Битрикс24, Evolution CMS, распакованный дистрибутив) | `refused`, `other_product` или `not_installed`: основание есть в файлах (`bitrix.md:124,132`, `modx.md:155`) |
| Часть сайта вне папки | Импорт идёт, `outsideRoot`, предпросмотра нет. Браузер работает |
| Конфигурация не разобрана (cp1251, `const`, скобки) | `database: null`, дальше каталог базы, как сейчас |
| PHP неизвестен | `runtimeVersions` строится от версии CMS. Для новых стеков это обычное состояние: плагина нет, а обещание «на сервер не пишем» остаётся (`onboarding.md:475`) |
| Сайт подключён раньше, `facts` NULL | WordPress работает как сегодня: версию он не читает. Факты появятся при следующей свежей сборке |
| Хостинг молчит при перечитывании | Остаётся сохранённое |

Отказ — только при положительном основании. Отсутствие сведений импорт не останавливает.

`outsideRoot` — обычное состояние, а не редкость. OpenCart 3 и 4 на панели управления сами просят вынести `storage` за веб-корень: «It is very important that you move the storage directory outside of the web directory» (`oc-3.0.5.1/upload/admin/language/en-gb/common/security.php:8`, показ `admin/controller/common/dashboard.php:83-84`; `oc-4.1.0.4/upload/admin/language/en-gb/common/security.php:10`, `admin/controller/common/security.php:55`). Там же OpenCart 4 предлагает переименовать `admin` (`security.php:16-17`). В `storage` лежит `vendor` с Twig (`oc-3.0.5.1/upload/system/startup.php:70-71`, `oc-4.1.0.4/upload/system/framework.php:12-13`), и `read` туда не дойдёт. Доля таких сайтов неизвестна.

Кодировка: `SiteDatabaseSettings` описывает соединение. Файлы cp1251 у Битрикса до 24.0 (`bitrix.md:534`) — отдельный вопрос этой CMS. `utf_mode` читается как ASCII, значит, разбор конфигурации нельзя вести через строгий UTF-8 (`bitrix.md:222`).

### 7.2. Сайт без файлов: версия не нужна

Что браузеру нужно от сайта, и откуда это берётся:

| Что нужно | Откуда без файлов |
| --- | --- |
| Стек | Клиент выбирает, обязательное поле |
| `adminPath` | Поле «Адрес панели управления» только у OpenCart и MODX, заполнено по умолчанию (`/admin/`, `/manager/`). У Битрикса и Joomla адрес постоянный (`bitrix.md:368`, `joomla.md:550`) |
| Запрет экрана | Параметр запроса, а не папка (`browser-mcp.md:259-261`). Без версии |
| Селекторы входа | CSS-объединение: `#btn-login-submit, #form-login button.login-button`. Без версии |
| Объект редактора | Параметры адреса. Без версии |
| Адрес проверки объекта | Форма адреса редактора из `ref.editUrl` |

Критика считала, что политика ветвится по версии. Проверка показывает, что ветвления можно избежать: разрешённые списки поколений объединяются, если их формы не конфликтуют. На OpenCart это подтверждено по исходникам:

- 3.0 вычищает из маршрута всё, кроме букв, цифр, `_` и `/` (`oc-3.0.5.1/upload/admin/controller/startup/router.php:14`, `system/engine/action.php:26`). Маршрут вида `catalog/product.form` становится несуществующим контроллером.
- 4.1 делит по последней точке (`oc-4.1.0.4/upload/system/engine/action.php:41-50`). `catalog/product/edit` становится контроллером без файла.
- Параметр сессии: `token` в 2.3 и `user_token` в 3.0 и 4.1 (`admin/controller/startup/login.php`, строки 29, 29 и 52). Это перечисление, а не ветвление.

У Joomla адреса редактирования одни на ветках 3–6, у MODX `a=resource/update` одинаков, имена действий коннектора приводятся к нижнему регистру (`modx.md`, раздел 13). Это чтение исходников отчётами, а не прогон; для Joomla и MODX объединение списков перепроверяется при написании политики.

Если переименованный адрес неизвестен, запрет не страдает: старт с главной, клиент берёт управление и входит сам, политика судит по параметру. Страдает только удобство.

### 7.3. Неверный стек — вопрос правила 1

Запущена настоящая `wordpressBrowserTaskPolicy` на адресах чужих админок:

| Адрес | `pageDenied` |
| --- | --- |
| `/admin/index.php?route=sale/order&user_token=abc` | разрешён |
| `/admin/index.php?route=customer/customer&user_token=abc` | разрешён |
| `/mgr7f/?a=security/user` | разрешён |
| `/administrator/index.php?option=com_users&view=users` | разрешён |
| `/bitrix/admin/sale_order.php?lang=ru` | разрешён |
| `/wp-admin/users.php` | запрещён |

Запретительный список WordPress не знает чужих экранов. Значит, обязательный выбор платформы (`onboarding.md:468`) снимает только умолчание, а ошибка клиента остаётся: выбрал WordPress для магазина на OpenCart, вошёл сам — и агент читает заказы.

Значение по умолчанию: проверка при `project.create` для варианта без файлов. `GET /` идёт через закреплённый транспорт, который у web уже есть (`apps/web/src/server/site-favicon-runtime.ts:22`), а чистый метод адаптера смотрит на тело: `wp-content/`, `/bitrix/`, `catalog/view/`, `generator` Joomla, `/assets/components/`. Если признаки указывают на другой известный стек, создание отказывает и предлагает выбрать его. Заголовков в `SiteHttpResponse` нет (`site-adapter.ts:125-133`), поэтому хватает тела. Сайт без признаков эта проверка не защищает. Вариант сильнее — запрет агенту, пока стартовая страница не ответила как админка заявленного стека. У него есть ложные срабатывания: скрытый вход WordPress у плагинов вроде WPS Hide Login. Он остаётся на проект браузера.

### 7.4. План 61

Совместимо. На ветке `feat/chats-first` политика строится там же (`raditi-chats/apps/browser/src/sessions/session-manager.ts:234`), а чат без проекта идёт мимо адаптера (`:203`): нет сайта — нет фактов. К10 (код и браузер в одном чате) не мешает: групп методов две, и в таком чате работают обе.

## 8. Манифест ядра: замер

Критика: `agentWorkingSet(site)` не видит дерева, значит, нужен манифест на версию. Проверено по деревьям поставки: дереву видеть не нужно.

| Стек | Граница своего и чужого | Замер | Что нужно |
| --- | --- | --- | --- |
| WordPress | Папки | Уже работает (`wordpress-working-set.ts:32`) | Ничего |
| Битрикс | Ядро не в git | — | Ничего |
| MODX | `core/components/`, `assets/` | `core/` в 3.x не переносится (`modx/docs/en/getting-started/directory-structure.md:22`) | Имена папок из `layout` |
| OpenCart 4 | `extension/opencart/` против `extension/<код>/` | 439 из 441 файла поставки, 0,82 МиБ | Одна строка `exclude` |
| OpenCart 2.3, 3.0, ocStore | Вперемешку | Папки рабочего набора из `opencart.md:820` вместе — 5,6 МиБ у 3.0.5.1, 6,5 МиБ у ocStore 3.0.3.7 | Включать папки целиком. Предел бандла 64 МиБ не грозит. Поставочные расширения агенту видны, оплата закрывается статически в `protectedPaths` |
| Joomla | По имени расширения | См. ниже | Список на поколение |

Joomla: `ExtensionHelper::$coreExtensions` даёт 184, 233, 248 и 251 строку на 3.10.12, 4.4.14, 5.4.10 и 6.2.0. Список покрывает все 193, 245, 259 и 263 каталога поставки. Вне списка только `templates/system`, `administrator/templates/system` и `plugins/sampledata/testing` в git-теге 4.4.14. Изменчивость мала: 5.4.10 → 6.2.0 плюс 4 и минус 1 каталог.

Значит, список — константа адаптера на поколение, собранная скриптом из тега. Устаревший список даёт безобидный исход: новое расширение ядра окажется видно агенту. Рабочий набор остаётся исключающим: `include` — `/components/`, `/modules/`, `/plugins/`, `/templates/`, `exclude` — ядро. Включающий список на сайт не дал бы агенту добавить новое расширение.

Одна правка домена неизбежна: `agentWorkingSetSchema.exclude.max(256)` (`packages/domain/src/git/working-set.ts:34`) меньше 263 каталогов Joomla 6.2.0. Поднять до 512. `compilePathPatterns` проверяет шаблоны по одному (`path-patterns.ts:79-85`); скорость на дереве в десятки тысяч файлов не мерилась, запасной вариант — один общий шаблон.

Манифест по файлам стал бы новой подсистемой: архивы всех версий всех форков, обновление, хранилище. У WordPress контрольные суммы есть в публичном API (раздел 14), у остальных такого источника отчёты не нашли. Точность до файла нигде не требуется: `publicOriginals` берёт оригинал по запросу. Причина вернуться к манифесту появится, если понадобится показывать клиенту изменённые файлы ядра.

Ограничение: стороннее расширение OpenCart вне папок `extension`, например `catalog/controller/module/` у старых пакетов, в рабочий набор не войдёт. Агент скажет, что не может это менять. Сколько таких расширений, неизвестно, платные не замерялись.

## 9. Факты по стекам

Чтение версии проверено на 19 деревьях поставки: версия прочитана в 19 из 19, ни одного ложного срабатывания чтения другого стека, не больше двух чтений, файлы до 1,8 КиБ при пределе `configFileBytes` 256 КиБ. Установленных сайтов нет, поэтому поля из конфигурации не проверялись на настоящих файлах.

| | Версия | В git | Поколение | Адрес админки | Прочая раскладка | База |
| --- | --- | --- | --- | --- | --- | --- |
| WordPress | `wp-includes/version.php`, `$wp_version` | Да | Нет | `/wp-admin/` | Нет | `wp-config.php` |
| Битрикс | `bitrix/modules/main/classes/general/version.php`, `SM_VERSION` | **Нет** | Пока не нужно | `/bitrix/admin/`, постоянный | Редакция по `bitrix/modules/*` (49 и 26 у проверенных), Битрикс24 — отказ | `.settings.php`, `dbconn.php`, `tablePrefix: ''` |
| Joomla | `administrator/manifests/files/joomla.xml`, `<version>` | Да | `j3`, `j4`, `j5`, `j6` | `/administrator/`, постоянный | Форк UTD — по `3.11+` (`joomla.md:124`); публичная папка | `configuration.php`, кодировка всегда `utf8mb4` |
| MODX | `config.core.php`, затем `core/docs/version.inc.php` | Да | `modx2`, `modx3` | `$modx_manager_url` | `$modx_connectors_url`, `$modx_assets_url`, ключ конфигурации, `core` вне корня у 2.x | `core/config/<ключ>.inc.php` |
| OpenCart | `index.php`, `VERSION` | Да | `oc2`, `oc3`, `oc4` по дереву | Обход папок корня | `storage`, `vqmod`; форк — `VERSION_CORE`, у ocStore 2.3 — форма `2.3.0.2.N` | `config.php`; кодировка из `system/library/db/mysqli.php` |

Папка админки OpenCart: кандидаты — папки корня вне поставочных имён, не больше `rootSuggestionDirectories` (12). Признак — по `opencart.md:139-140`. На каждый кандидат одно чтение, поэтому метод только для `core`, не для мастера.

Снаружи, без файлов. В модели это нужно только для проверки стека:

| Стек | Что видно | Основание |
| --- | --- | --- |
| Joomla | Точная версия: `/administrator/manifests/files/joomla.xml`. `htaccess.txt` статические `.xml` не закрывает, `.htaccess` в `administrator/` нет. `generator` с версией только при `MetaVersion`, по умолчанию выключено | `pkg-6.2.0/htaccess.txt`, `SiteApplication.php:205`, `com_config/forms/application.xml:743-748`. На живых сайтах не проверено: хостинг и плагины могут закрыть |
| OpenCart | Поколение: `/extension/opencart/install.json` есть только у 4.x, `/catalog/view/theme/default/stylesheet/stylesheet.css` только у 2.x и 3.x. 2.3 от 3.0 надёжно не отличить. `.htaccess.txt:13` закрывает `.tpl`, `.twig`, `.ini`, `.log`, `.txt`, но не `.json` | Деревья поставки. Подтверждает `opencart.md:133`: версию снаружи не узнать |
| MODX | Заголовок `X-Powered-By` выключен: код по умолчанию `true` (`modRequest.php:77`), а настройка установщика `false` (`_build/data/transport.core.system_settings.php:1687`). `core/` закрыт, только если владелец применил `ht.access` | Исходники 3.2.4 |
| Битрикс | Заголовок `X-Powered-CMS`, пути `/bitrix/` в HTML | `bitrix.md:126` |

PHP: только плагин WordPress (`wordpress-content.ts:323`). `X-Powered-By` по умолчанию включён (`expose_php=1`, раздел 14), но `SiteHttpResponse` заголовков не несёт, и Битрикс советует его выключать (`base-images.md:377`). Значит, основной путь для новых стеков — диапазон от версии CMS. `siteImage` берёт первую версию, для которой есть образ, без повторов (`preview-builder.ts:342-349`), поэтому перебор версий из `base-images.md:382` — отдельная работа.

## 10. Семь предложений

| Предложение | Судьба |
| --- | --- |
| `sites.stack_version` или JSON публичных фактов (`onboarding.md:336`) | Принят JSON. «Факты пишет импорт, не мастер» — принято |
| `sites.stack_version` и подстановка «в трёх местах» (`release-pipeline.md:315`) | Заменено. Мест десять, не три |
| `sites.admin_path` (`browser-mcp.md:331`) | Вошло как `layout.adminPath`. Обязательное пустое поле заменено заполненным значением по умолчанию |
| `extras.adminDir`, `storageDir`, `generation`, `vqmod` (`opencart.md:815`) | `generation` стал полем, `adminDir` — `layout.adminPath`, `storageDir` — `outsideRoot`. `extras` удалён |
| Раскладка рядом со строкой `sites` (`modx.md:902`) | Принято, это `layout` |
| `previewSettings(read)` в `preview_environments.runtime` (`preview-pipeline.md:255`) | Вошло в `readFacts`, поле `config`. Хранится в `sites.facts`: запись предпросмотра уже тратит до 6 КиБ из 8 на пути синхронизации (`preview-record.ts:18`) |
| Версия PHP в строке сайта (`base-images.md:398`) | Принято, часть `runtime` с источником |
| Удалить `detect` или сделать `detect(read)` (`adapter-contract.md:68`, `stack-leaks.md:50`, `onboarding.md:337`, `preview-pipeline.md:295`, `modx.md:875`) | Удаляется. «Опознать» и «прочитать факты» — два метода с разными входами и разными процессами |

## 11. Как это ложится на критику

| Вопрос пробела 3 | Ответ |
| --- | --- |
| Порядок | Сеанс открывается раньше `importRules`, раздел 4 |
| Без файлов | Версия браузеру не нужна, раздел 7.2. Адрес — поле мастера. Новый риск — неверный стек, раздел 7.3 |
| Без списка файлов | Манифест не нужен, раздел 8. `SiteTree.list` нужен только для раскладки |
| Устаревание | Перечитывание при свежей копии и перед `/release`, `siteDrift`, раздел 5. Выход из дрейфа зависит от пробела 7 |
| Неизвестное значение | Адаптер отказывает только при положительном основании, иначе метод сужается, разделы 6 и 7.1 |

## 12. Срезы и вопросы владельцу

| № | Срез | Поведение |
| --- | --- | --- |
| 1 | Схема, колонка, `siteFactsFromRow`, замена десяти мест, удаление `docroot` и `extras` | Не меняется. В тестах шесть строк с литералом |
| 2 | Порт: `SiteTree`, `readFacts`, `readVersion`, `isSiteRoot`; удаление `detect`; реализация для WordPress | Не меняется |
| 3 | Импорт: порядок, запись с планом, коды отказа | Новые отказы только у новых стеков |
| 4 | Предпросмотр: `withTree`, сверка, `site_updated`, запись `runtime` | Для WordPress появляется сверка версии |
| 5 | Браузер: `BrowserTaskSite`, поле мастера, `site_info` с версией | Без изменений для WordPress |
| 6 | Сверка перед `/release` | Новый отказ при дрейфе `code` |
| 7 | Проверка стека при создании сайта без файлов | Закрывает раздел 7.3. Логично сделать вместе с первым срезом `onboarding.md:468` |

Срезы 1–3 и 7 нужны до первого нового адаптера. В spec меняются §12 («Разведка», «Сайт без доступа к файлам») и §13 (`docs/spec.md:1418`, `:1445`).

Значения по умолчанию, которые стоит показать владельцу:

| Вопрос | Значение по умолчанию |
| --- | --- |
| Что закрывать при дрейфе поколения, пока нет повторного импорта | Предпросмотр и `/release` закрыты, браузер работает |
| Создание сайта без файлов, когда признаки указывают на другой стек | Отказ с предложением выбрать найденный стек |
| OpenCart со `storage` вне папки | Импорт идёт, предпросмотра нет, браузер работает. Папку выше не просим: потянется весь домашний каталог |
| Поставочные расширения OpenCart 2.3 и 3.0 видны агенту | Да, кроме оплаты |
| Сообщать ли версию CMS модели в `site_info` | Да |

## 13. Что проверено и что нет

**Запускалось:**

- `facts/probe.py`: чтение версий по 19 деревьям, скрипт `scratchpad/facts/probe.py`;
- `facts/wrong-stack.mjs`: настоящая политика WordPress на чужих адресах, скрипт там же;
- сверка `$coreExtensions` с каталогами Joomla и размеры папок OpenCart — разовые скрипты, числа в разделе 8.

**Прочитано:** код из раздела 2, порт, импорт, предпросмотр, выпуск, браузерный worker; исходники CMS по указанным строкам.

**Не проверено:**

- ни одна CMS не запускалась, чтение раскладки и настроек из установленных конфигураций не прогонялось;
- объединение разрешённых списков подтверждено по маршрутам OpenCart, у Joomla и MODX — только по отчётам;
- разрешённых списков в коде ещё нет, раздел 7.2 описывает договор, а не работающую политику;
- размеры и находки — по деревьям поставки: платные темы и настоящие магазины могут дать другие числа;
- доступность `joomla.xml` и файлов OpenCart снаружи выведена из правил поставки, не из живых сайтов;
- доли сайтов со `storage` вне корня и переименованной админкой неизвестны;
- скорость `compilePathPatterns` на 300 шаблонах и большом дереве не мерилась.

## 14. Источники

- [PHP manual, core ini directives](https://www.php.net/manual/en/ini.core.php): `expose_php`, значение по умолчанию `1`, заголовок `X-Powered-By`.
- [WordPress core checksums API](https://api.wordpress.org/core/checksums/1.0/?version=6.8&locale=en_US): ключ `checksums`, суммы по файлам релиза.
- [Joomla Tips, определение версии без входа](https://joomla-tips.org/developer-tools/how-to-detect-joomla-version-withouth-having-access-to-admin.html): вторичный источник о `administrator/manifests/files/joomla.xml`; основание в отчёте — поставка Joomla. По OWASP JoomScan подтвердить это поиском не удалось.
- Исходники CMS: `research/src/{bitrix,joomla,modx,opencart}`, пути указаны в тексте.
