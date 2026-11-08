# Решения по замечаниям круга 1 к плану 62

Дата: 01.11.2026. Каждое замечание проверено чтением документа и кода. Значения, которых не было в проекте, в документах помечены «по умолчанию». Нумерация не менялась, нового среза нет. Новых вопросов владельцу нет: у каждого решения есть значение по умолчанию. Итог: принято 68, другая правка 3, отклонено 0.

| id | линза | важность | где | решение | что изменено |
| --- | --- | --- | --- | --- | --- |
| F1 | landed | blocker | Э00, modx.md, critic-copy.md | принято, вместе с P1 | Шаблон с границей слова, контракт сверяет число строк с доменом снятого примера по файлу, без номеров строк: onboarding 4, проект 1, plan-decisions 1. В двух отчётах домен заменён вымышленным или фраза переписана |
| P1 | executor | blocker | Э00 | принято, та же правка, что F1 | Строки договора `site.runtimeVersion` больше не совпадают; разрешение задано файлом и числом строк |
| B-1 | contradictions | blocker | Э8.9, Э8.5 | другая правка: порта не вводим, берём L1 | Предложение добавить `isWrite` в порт отклонено: `#judge` читает только метод, запись методом GET закрывает политика новой строкой таблицы, это закрывает и страницу другого сайта |
| L1 | holes | blocker | Э8.5, Э8.9 | принято | Строка `isWrite` в таблице раньше открытого экрана, `list` убран из псевдокода `#judge`, тест 9 на Chromium, поломка `get-write` снимает эту строку |
| L2 | holes | blocker | Э8.19, Т39, Э8.4 | принято, значение судится дважды | `modxStoredValue`, `tv<id>_prefix` — `fixed`, `\0` в значении нечитаем, сайт стенда с TV типа `url`, тесты. Проверено по `update.class.php` и `Update.php` |
| L3 | holes | blocker | Э8.4, Э8.15, Э8.18, Т54 | принято | Часть `filename=` даёт `null` без исключений, запасной `PhpRead.files` описан, Э8.15 проверяет настоящим Chromium. Проверено по `modConnectorResponse.php` и `coreBundle.js`, Chromium не запускался |
| F2 | landed | serious | Э13.4, Э11.6, Э11.4 | принято, вместе с S-7 | Таблица из Э13.4 снята, шаблон строится из §5.4, контракт сверяет тексты |
| S-7 | contradictions | serious | Э13.4, Э11.6, Э11.4 | принято | Перечень З5 в Э11.4 заменён ссылкой на §5.4, правило 7 контракта |
| F3 | landed | serious | §5.4 З14, Э13.3, Э7.5 | принято | Вопрос 30 в З14, в «Зависит» Э13.3 и в столбце «Заперт» Э7.5 |
| F4 | landed | serious | Э7.5 | принято | Блок кода закрыт, пометка вынесена, редакция «да» отдельным блоком, тест на `clear yes` |
| F5 | landed | serious | Э7.5 | принято | В файлах среза `CLAUDE.md` правило 3 и `docs/spec.md` §8 |
| F6 | landed | serious | Э9.6, Т32, §7, доски | принято | Шесть мест говорят «вопрос 9б» |
| F7 | landed | serious | Э9.2, §7 | принято | Он0 в столбце и цели среза, исключения §7: Он0, Он8, О5 в части демо |
| F8 | landed | serious | Э9.1, Э9.3, Э9.6 | принято, вместе с S-4 | `pricesGuarded` в `siteFoundSchema`, `abilities`, `browserStacks` |
| S-4 | contradictions | serious | Э9.1, Э9.3, Э9.6 | принято | Тесты на обе редакции при `open` |
| F9 | landed | serious | Э9.5 | принято, вместе с S-2 | Сборка из семени пишет `seedSyncId`, тест `project.get.drift` |
| S-2 | contradictions | serious | Э9.5 | принято | Условие `readsHosting` со сменой `code_sync_id`, запись `drift` при нём, тест выхода из тупика |
| S-1 | contradictions | serious | Э9.5 | принято, тест заменён | Колонка в SQL и CHECK, четыре колонки в `refresh`, одним условным `UPDATE`; вместо теста «семя без версии» — тест CHECK, такой строки быть не может |
| F10 | landed | minor | Э9.5 | принято, та же правка, что S-1 | См. S-1 |
| S-3 | contradictions | serious | Э7.5 | принято | `findSiteContentAdapter`, тип с `null`, тест |
| S-5 | contradictions | serious | Э12.2 | принято | Третий том, `files.mjs init 10002:10002`, `RADITI_MEDIA_*`, модули `proxy`, файлы и тесты. Проверено по `containers.ts`, `init.sh`, `runtime.ts` |
| S-6 | contradictions | serious | Э3.10, Э3.15, Э4, Э5, Э8.16 | принято, вариант 1 | `groupsOf(stand, build)` одной функцией, литералы сняты, `standOptions` отказывает на пустой группе, Э8.23 называет `walks` |
| S-8 | contradictions | serious | Э11.4, Т65 | принято | Проверки разделены условием `panelScreen !== null`, `unknownWrite | null`, плоский файл WordPress |
| S-9 | contradictions | serious | Э9.6, Э7.2, Т7, Т18 | другая правка | Автопересборка отвергнута: `/reset` закрыт под работающим агентом, и данные копии пропали бы молча. Запись хранит `phpSeen`, новая причина `php_changed` (по умолчанию), кнопка `/reset`, сценарий R13, правки доски `O-passport-release-stop` |
| S-10 | contradictions | serious | Э9.5 | принято, с новым ключом объекта | Сначала `requestSiteProbe`, `SITE_PROBE_BUSY`, объект удаляется после коммита; ключ семени с `seedId`: постоянный ключ дал бы гонку удаления с новой пробой |
| F13 | landed | minor | Э9.5 | принято, обе части | Отказ при открытой пробе и условие `site_database_dumps.updated_at` для сборки стека без пробы; вид «Идёт проверка» на `O-dump-replace` |
| S-11 | contradictions | serious | Э7.2 | принято | Предел 512 байт, `shadowedMore`, тест всех полей в максимуме |
| S-12 | contradictions | serious | Э3.3, Э4.2, Э6а.10, Э2 | принято, с `importPolicyOf` | Срез-владелец Э3.3, `ImportConfigCopies`, третий параметр и обёртка: необязательный параметр компилятор не проверит |
| S-13 | contradictions | serious | Э11.4, Э3.10, Э3.13, §5.5, З5 | принято, вариант 1 | Новая группа `safety-browser`, локально |
| S-14 | contradictions | serious | Э11.4, З4 | принято | `schedulerBuilds`, строка неприменима на остальных. Проверено: cron MODX, `cron.php` OpenCart 3.0, плагин Joomla 3.10 |
| P2 | executor | serious | Э1.4, Р9, §5.1 | принято | Зависимость от Э0в, хук спайка в договор не идёт |
| P3 | executor | serious | Э2.8, Э6а.1, Э6а.3, Э6а.7 | принято | `SiteImportDeps.closedRoots`, передача в обход и в сравнение, тест |
| P4 | executor | serious | Э0з | принято | `gates()` читает `runIf`, массив `missing` |
| P5 | executor | serious | Э9.4, Э9.5, §2.6 | принято, с дополнением | `dumpFound.insideRoot`, `site_database_dumps.inside_root`; шагу базы нужен ответ до `project.create`, поэтому `checkSource` отдаёт `rootFromLogin` (по умолчанию). Текст и доска не меняются |
| L4 | holes | serious | Э8.5, Э8.17–Э8.19, Т52, Т65 | принято, с глубиной | Первая строка таблицы, `directScriptDenied`, точка входа первым или вторым сегментом (по умолчанию), `publicScripts`, поломка `public-script` |
| L5 | holes | serious | Э8.17, Э8.18, Э11.4 | принято | `isWrite`, `sentFrom`, контракт на непустой `writesByGet`, `get-write` на трёх стеках |
| L5a | holes | serious | Э8.18 | принято | Точные маршруты, предел сегментов, строки `disable`, обход `closed-mass`, поломка `route-prefix` |
| L6 | holes | serious | Э8.4 | принято, с оговоркой | Повтор с разными значениями нечитаем, `valuesOf` не выбирает, сверка значений с PHP; настоящая форма со скрытым полем и флажком получает строку договора. Поломка `repeat-field` |
| L7 | holes | serious | Э8.5, Э8.17 | принято | `controlFields`, ключ массива даёт `null`, а `cid[]` с пустым ключом проходит; поломка `control-array` |
| L8 | holes | serious | Э8.19, Т54 | принято | Два точных ключа, поля `id` и `dir`, корень медиа назван, `mediaEscapes` дополнен |
| L9 | holes | serious | Э8.15, Э8.17, Э8.19, Т54, правило 4 | принято | `uploadRequest` с `null`, `existing`, `com_media` только POST файла, Р22, поломка `media-replace` |
| L10 | holes | serious | Э8.16–Э8.19, Т52, Т39 | принято | Поле журнала без строки — `same`; `resource_groups`, `pub_date`, `unpub_date`, `alias`, `ta`, поля Joomla и OpenCart; поломка `field-default` |
| L11 | holes | serious | Э8.19, Э8.6, Т39 | принято | Проверка `current.class_key`, `executable` получает `current`, сайт стенда с тремя типами, поломка `resource-class` |
| L12 | holes | serious | Э8.17 | принято | `save2copy`, `save2new`, `save2menu` закрыты при любом `id`, поломка `save-copy` |
| L14 | holes | serious | Э11.4, §5.2 | принято, в Э11.4 | Закрытие `post_status=trash` и маршрутов `…/batch`, поломка `trash-field`. Нового среза нет: не блокер. Исходников WordPress и WooCommerce нет, это записано как граница |
| F11 | landed | minor | e8.md, Договор типов | принято, вместе с M-3, P10, L15 | `fixed` в `FieldRule` |
| M-3 | contradictions | minor | e8.md, Договор типов | принято | `fixed` и комментарий `read` |
| P10 | executor | minor | e8.md, Договор типов | принято, та же правка | См. F11 |
| L15 | holes | minor | e8.md, Э8.6 | принято, та же правка | Тест `fixed` в таблице отказов |
| F12 | landed | minor | Э7.7 | принято | Вид «Предел» при `unproved`, кнопка выгрузки при `no_database`, вариант «Не проверили, предел» на `O-probe-retry` |
| F14 | landed | minor | Э7.10, Э7.6, Э12.1, Э12.2, Э6б.2, Э9.7, Э10.3, Э4б.2, Э12.4, Э13.4 | принято | Файлы и spec §20 дописаны, тест WordPress с обычным `.php` |
| F15 | landed | minor | Э9.2 | принято | `attachTo: z.uuid().optional()`, `siteNotFound`, тест |
| F16 | landed | minor | e3.md | другая правка: id, как P9 | Везде `--build=<id>`, в `verify:stack` и `colima-m7.sh`; форма с версией отвергнута: версия не уникальна среди стеков |
| M-1 | contradictions | minor | Э3.13, Э3.14, Э3.16 | принято, форма id | `verify-stack.mjs` в файлах, переменная в тесте `vm`, строка о зеркале снята, «дополняется» |
| P9 | executor | minor | Э3.10, Э3.16, Э8.16 | принято | См. F16, тест `standOptions` |
| F17 | landed | minor | Т29, Э9.3 | принято | `version_closed`, четыре отказа |
| F18 | landed | minor | Э1.4, bitrix.md | принято | Условие снято, номера строк сняты |
| F19 | landed | minor | §1, Э7.5, Э0, Э11.6 | принято | Фраза §1, «вопрос Он21, значение условия» и в Р1 договора Э0, столбец «Прогон CI» |
| M-2 | contradictions | minor | Э8.16 | принято | Цель `BROWSER_LOCAL_SITES` при `vm`, порт в пересыльщике, тест |
| M-4 | contradictions | minor | Э3.2, Э4.1, Э5.1, Э8.23, Э9.3, Т29 | принято | `pricesGuarded: false` в трёх литералах, `wordpress.ts` в Э8.23 |
| M-5 | contradictions | minor | §6 правило 3, §7 вопрос 30, Э7.5 | принято, первый вариант | Слова сужены до чата с рабочей копией: клиент чата только с панелью слышал это при подключении и над полем |
| M-6 | contradictions | minor | Э9.7, письмо юристу | принято | Пункты 6.4 и 7.9, проверено по оферте |
| M-7 | contradictions | minor | Э12.1, Э1.4 | принято | `mediaOnHosting` во входе `compareWithMain`, `export FILES_MJS` снимается |
| P6 | executor | minor | Э0з | принято | `dockerSocket` в обоих местах |
| P7 | executor | minor | Э1.4 | принято | Столбцы `import.sh` и экспорт политики, правка `runsc-matrix.sh` |
| P8 | executor | minor | Э3.1 | принято | Удаление теста Э1.2, `stack-files.d.mts` |
| P11 | executor | minor | Э8.5 | принято | Свойство: ни одно написание не даёт `open` |
| P12 | executor | minor | Э9.1 | принято, второй вариант | Слова «`readVersion` не зовётся» сняты: файл версии секрета не несёт |
| P13 | executor | minor | Э6а.4, Э6а.7 | принято | `bytes` в обоих типах, `hashBatches` с `Pick` |
| P14 | executor | minor | Э3.12 | принято | `TEMPLATE_PATHS`, настоящая проверка в R1, файлы названы |
| L16 | holes | minor | Э8.6, правило 4 | принято | Нормализация и новые теги, поломка `active-html` |

## Что меняется для следующего круга

- Новые поломки Э11.4: `public-script`, `file-part`, `repeat-field`, `control-array`, `route-prefix`, `field-default`, `resource-class`, `save-copy`, `active-html`, `media-replace`, `trash-field`.
- Новая группа стенда `safety-browser`, новый сценарий R13, новая причина `php_changed`, новый вид «Идёт проверка» на `O-dump-replace`, вид «Версия PHP изменилась» на `O-passport-release-stop`, вид «Не проверили, предел» на `O-probe-retry`.
- Доски изменились только внутри: размеры прежние, `boards.json` не менялся.

# Решения по замечаниям круга 2 к плану 62

Дата: 01.11.2026. Каждое замечание проверено чтением документа, кода и исходников CMS. Битрикс не открывался, стенды и тесты не запускались. Значения, которых не было в проекте, в документах помечены «по умолчанию». Нумерация не менялась, нового среза нет. Новых вопросов владельцу нет: у каждого решения есть значение по умолчанию. Итог: принято 39, другая правка 7, отклонено 0.

| id | линза | важность | где | решение | что изменено |
| --- | --- | --- | --- | --- | --- |
| r2-landed-SEC10-policy-hash-per-preview | landed | blocker | Э9.5, Т28 | другая правка, вместе с N1 | Постоянная цель принята: `dumpSeedTarget` для семени и sha. Предложение «сайту со строкой доступа к плагину разовое семя» отвергнуто: плагин лежит в каждой копии WordPress (`generatedFiles`), шлюз всегда шлёт `siteId: previewId`, поэтому любой сайт WordPress с общим семенем получил бы отказ плагина. Вместо этого `content.bind`: привязка после загрузки, у всех сборок из семени. Тест на настоящей политике, контрактное нарушение, Docker-проверка `wp` |
| r2-contradictions-N1 | contradictions | serious | Э9.5 | принято, та же правка | См. выше. Подтверждено по `preview-builder.ts`, `wordpress-db-copy.ts`, `preview-content-gateway.ts`, `raditi-content.php` |
| r2-holes-M1 | holes | blocker | Э8.19, Т65, З5, Э11.4 | принято | `modxStoredValue`: чистка запроса, массив с выброшенными пустыми элементами, сигнатура `string \| readonly string[]`, `executable` получает все значения поля. Вторая линия: поле адреса у `Resource/*` — `unknown_write`, прежний тест `executable_value` на этом случае заменён. Поломка `tv-sanitize`, `get-write` снимает и вторую линию. Проверено по `modRequest.php`, `modX.php`, `Update.php`, `update.class.php` обеих версий |
| r2-landed-C04-abilities-phpBelow-no-source | landed | serious | Э9.1, Э9.6 | принято | Одна функция `sitePhpBelow`, новое поле `chat.stackHoldsServerCode(site)`: `agentWorkingSet` читает факты сайта, поэтому функция берёт сайт, а не стек. Тест MODX и Joomla |
| r2-landed-C10-s11-before-field | landed | serious | Э6а.10, Э7.2 | принято | Шаг Э6а.10 сверяет `seed_sync_id` с `code_sync_id`; `project.get.drift`, `project.test.ts` и шаг S11 в Э7.2 |
| r2-landed-S9-r13-hits-hourly-limit | landed | serious | Э9.6, R13 | принято, первый вариант | Стенд старит строки проб на 2 часа, отступление названо |
| r2-landed-S10-deleteSite-no-list | landed | serious | Э9.5, Э7.6, §2.6 | принято, вариант с очередью | Таблица `dump_seed_deletions` (по умолчанию), сборщик `core`; строка, а не событие outbox: задание BullMQ кончается после попыток, а строка ждёт. Слова «снимает всё под…» сняты, `list` не вводится |
| r2-contradictions-N2 | contradictions | serious | Э9.5 | принято | `inside_root` пишется `$executeRaw` в транзакции условного `UPDATE`, условие сравнивает ещё `path`, `site-sources.ts` и источники в файлах, тест |
| r2-contradictions-N3 | contradictions | serious | Э9.5 | принято, с уточнением | `set` с путём у сайта без живой базы отказывает, форма зовёт `refresh`, `refresh` принимает сайт без строки дампа. `set(null)` закрыт только там, где дамп — единственная база обязательного шага; при живой базе запасной файл снимается как раньше. Слово «только» снято в Э7.6 и Э9.5 |
| r2-contradictions-N4 | contradictions | serious | Э9.5, Э7.2, Э11.3 | другая правка | Вместо `dump_seed_summary` одна колонка `dump_seed_facts`: она же закрывает `r2-landed-E95` |
| r2-landed-E95-settings-read-dump | landed | minor | Э9.5 | другая правка, та же колонка | Настройки базы и числа итога живут и очищаются с семенем, CHECK на пять колонок, тест `databaseSettings` отвечает `null` |
| r2-contradictions-N5 | contradictions | serious | Э8.6, Э8.17–Э8.19, шаг 4 срезов стеков, Т52, Договор типов | принято | `new_object.guard.read` — чтение формы добавления, `same` со значением формы, поля выбора `fixed` через `fixedValues(field, current)`, варианты под ключом `<поле>#options`. Строки в Э8.17 и Э8.18, тест на журнальной форме. Формы нет в журнале — срез останавливается, как при чтении `same`-полей |
| r2-contradictions-N6 | contradictions | serious | Э12.2, Э12.3 | принято, с дополнением | Второе правило Apache до `!-f`, `always` раньше `except`: у OpenCart `except` держит `image/cache/`. Добавлено `alwaysExcept` (по умолчанию): иначе «кроме папки агента» из Т49 некуда записать. Файлы и тест в Э12.3 |
| r2-contradictions-N7 | contradictions | serious | Э12.2 | принято | Docker-тест с источником на loopback контейнера, положительный контроль, отказ считается только вместе с ним |
| r2-contradictions-N8 | contradictions | serious | Э0ж, Э3.3, Э2.3, Э6а | принято | `importPolicyOf` в Э0ж двумя параметрами, Э3.3 добавляет третий, контракт `ci.test.mjs`, вызов в контракте Э2.3 |
| r2-contradictions-N9 | contradictions | serious | §6 правило 4, Э11.4 | принято | Оговорка «у стека с разрешённым списком» у исполняемых значений, активного HTML, корзины полем, загрузки. Отдельная дописка для WordPress вписывается в Э11.4 |
| r2-executor-PX-1 | executor | serious | Э3.12, R4 | принято | Проверено по S5 `verify:release`: `captured`, `chargesOf` не пуст, выпуск ничего не вернул |
| r2-executor-PX-2 | executor | serious | Э9.1, Т2 | принято | Шаг 6 отказывает только стеку с `releaseNeedsChecks`, остальным успех с `found.panel: false` (по умолчанию), тесты |
| r2-holes-X2 | holes | serious | Э8.6, Э8.18, Э8.21, Т52, Т65, З5, Э11.4 | принято | `resetWhenAbsent`, шаг 3 `violation`, многозначное поле в `current` через `\n`, поля OpenCart и Joomla, фикстура `absentFields`, поломка `absent-field`, обход `closed-store-flag`. Проверено по моделям OpenCart и `ModuleModel.php`. У MODX полей нет: `setCheckbox` без `force` при отсутствии поля значения не меняет |
| r2-holes-X1 | holes | serious | Э8.5, Э8.17–Э8.19, Т52, Т54, Т65, З5, Э11.4 | принято | `outOfBounds` на всех методах, строка таблицы, контракт «GET закрыт только по `requestDenied`», `media-root` и на GET, тесты |
| r2-holes-J1 | holes | serious | Э8.17, Т65, З5, Э11.4 | принято | Первый сегмент `api` закрыт целиком, тесты, обход `closed-api` с контролем. Сайт в подпапке адреса — Э15, поэтому первый сегмент достаточен |
| r2-holes-W1 | holes | serious | Э11.4, §5.2, Т65 | другая правка | Не `CLOSED_ACTIONS`: он закрыл бы и клиенту откат версии, а сегодня клиент его делает. Отдельный список только агенту, `by` без значения считается агентом, поломка `trash-field` снимает и его, граница записана |
| r2-landed-C01-order-already-open | landed | minor | Э7.6, Э9.6 | принято | Открытая строка первой, `SITE_PROBE_BUSY` у `recheckPhp` с откатом, новый текст, доска |
| r2-contradictions-N10 | contradictions | minor | Э7.6, Э9.6 | принято, та же правка | См. выше |
| r2-landed-S9-sitePhpSeen-callers | landed | minor | Э9.6, §2.3 | принято | Три файла, поле обязательное |
| r2-contradictions-N11 | contradictions | minor | Э9.6, §2.3, Э7.9 | принято, с зависимостью | Те же файлы, Э7.9 зависит от Э9.6 |
| r2-landed-SEC10-e12-2-deps | landed | minor | Э12.2, §5.1, §9 | другая правка | Э8.15 в зависимостях. Строка группы `safety` снята: её заменил Docker-тест N7, поэтому зависимость от Э11.4 не нужна и параллельность с Э10 цела |
| r2-contradictions-N14 | contradictions | minor | Э12.2 | другая правка, та же | См. выше |
| r2-landed-L02-e79-old-phrase | landed | minor | Э7.9, О3 | принято | Поручение дописывать снято, О3 ссылается на значение |
| r2-landed-P2-section9-e1-deps | landed | minor | §9, e1 | принято | «Э0а, Э0в, Э0д», схема |
| r2-contradictions-N17 | contradictions | minor | §9 | принято, та же правка | См. выше |
| r2-landed-R1-onboarding-item10 | landed | minor | onboarding §8 | принято | Фраза заменена |
| r2-landed-C05-abilities-no-database-view | landed | minor | Э9.6, onboarding, доска | принято | `no_database` во второй строке таблицы, новый текст, `unproved` назван явно, вид «Файла выгрузки нет» на `O-boot-failed` |
| r2-landed-defaults-unlabeled | landed | minor | Э9.1, §2.3, Э7.5 | принято, первый вариант | Метки, имя вне усечённого списка — шаг пропущен, тест. Отдельное чтение панели не нужно: исход тот же, что у переименованной папки |
| r2-contradictions-N12 | contradictions | minor | Э7.7, Э9.5, Э9.6 | принято | Строка и тест перенесены, файл карточки назван, источник `phpBelow` — C04 |
| r2-contradictions-N13 | contradictions | minor | Э11.4 | принято | `static-file` только при Э8.22, запись «неприменимо, вопрос 4» |
| r2-contradictions-N15 | contradictions | minor | Э3.16, Э3.14 | принято | Фраза перенесена, тест `stand.test.mjs` |
| r2-contradictions-N16 | contradictions | minor | Э9.4, Э9.1 | принято | Три файла, поле успеха |
| r2-executor-PX-3 | executor | minor | Э1.1 | принято | Команда с `PHP_PECL_PINS` и `PHP_EXTENSIONS_SKIP`, порядок первого прохода. Проверено: при пустых значениях цикл `Dockerfile` ставит расширение без версии |
| r2-executor-PX-4 | executor | minor | Э9.4 | принято | Листинг внутри `inspectRoot` до `readOneFile`, тест |
| r2-executor-PX-5 | executor | minor | Э9.4 | принято | Третья форма `DEFINER`, Docker-тест с `INSERT` |
| r2-executor-PX-6 | executor | minor | Э6а.7 | принято | `git_repositories.default_branch`, чтение после `claim`, отказ `repository_mismatch` |
| r2-executor-PX-7 | executor | minor | Э6а.7 | принято | `change` снимается в шаге 8 |
| r2-executor-PX-8 | executor | minor | Э9.1 | другая правка | Шаги 4–6 и `stack_differs` только у стека с `releaseNeedsChecks`: у WordPress смена пароля FTP не должна упираться в чтение адреса, а чужой `yes` на его главной иначе закрыл бы смену доступа. Файл и тест добавлены |
| r2-holes-J2 | holes | minor | Э8.17, Т65, Э11.4 | принято | Только точные `task` с точкой, `controller` в `controlFields`, тесты, поломка `task-exact`. Проверено по `ComponentDispatcher.php` |
| r2-holes-X3 | holes | minor | Э8.5, Э8.17–Э8.19, Т52, Т65, З5, Э11.4 | принято, закрыть | `publicDenied` отдаёт вид закрытия, а не признак: иначе ответ `people` не выразить. Папки `secretFiles` закрыты, контракт на GET, поломка `secret-path` |

## Что меняется для следующего круга

- Новые поломки Э11.4: `tv-sanitize`, `absent-field`, `task-exact`, `secret-path`. Шире стали `get-write`, `public-script`, `media-root`, `trash-field`. `static-file` и `absent-field` у Joomla идут только с запертыми срезами.
- Новая таблица `dump_seed_deletions`, колонка `sites.dump_seed_facts`, экспорт `dumpSeedTarget`, поле рецепта `content.bind`, поле `mediaOnHosting.alwaysExcept`, методы `outOfBounds` и `resetWhenAbsent`, функция `sitePhpBelow`, поле контекста `chat.stackHoldsServerCode`, фикстура `absentFields`, отказ `SITE_DUMP_REFRESH_REQUIRED`.
- `publicDenied` теперь отдаёт вид закрытия или `null`, `fixedValues` и `executable` получили новые параметры: это правки договора типов Э8, новых Р они не требуют, блок типов и есть договор.
- Доски изменились только внутри: `O-boot-failed` получил вид «Файла выгрузки нет», `O-passport-release-stop` вид «Другая версия PHP, идёт проверка». Размеры прежние, `boards.json` не менялся.
- Группа `safety` больше не несёт строки о PDF с прода: её роль у Docker-теста Э12.2. Канарейка PDF в `assets/files/` Э11.4 остаётся.
