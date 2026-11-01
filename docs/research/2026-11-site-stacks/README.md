# Исследования к плану 62: Битрикс, Joomla, MODX и OpenCart, 01.11.2026

Запрос владельца от 01.11.2026: добавить системы Битрикс, Joomla, MODX и OpenCart, сначала продумать онбординг платформ, собрать базовые образы, чтобы код сайта в изолированной оболочке давал предпросмотр, понять, как изменится архитектура, и пройти план, дизайн и ревью до реализации. Дословно запрос стоит в начале [проекта](../../plan/62-site-stacks.md).

Здесь лежит то, на чём построен план: разведка кода, чтение материалов четырёх CMS, замеры, разборы и ревью. Сами решения лежат не здесь. Каталог отвечает на вопрос «почему так решено» и позволяет перепроверить довод.

**Все данные в отчётах — на дату 01.11.2026.** Версии, доли рынка, тексты условий и ссылки могут устареть. Код читался на `main` `c811abf1`, а ветка `feat/chats-first` на её тогдашней голове: номера строк в ссылках на код относятся к этим состояниям.

## Где итог

| Что | Где |
| --- | --- |
| Проект: решения Т, этапы, гейт, лестница проверок, вопросы владельцу | [docs/plan/62-site-stacks.md](../../plan/62-site-stacks.md) |
| Договоры срезов, по файлу на этап | [docs/plan/62-slices/](../../plan/62-slices/) |
| Описание экранов онбординга | [docs/plan/62-onboarding.md](../../plan/62-onboarding.md) |

Где отчёт расходится с этими файлами, верны они. Отчёты писались по ходу работы и после неё не правились по существу: в них есть предложения, которые потом отклонены.

## Откуда взялись решения

| Шаг | Что вышло | Где здесь |
| --- | --- | --- |
| Изучение кода и CMS | Семь карт кода, пять исследований, выжимка | `map/{adapter-contract,stack-leaks,preview-pipeline,release-pipeline,onboarding,browser-mcp,tests-ci-env}.md`, `bitrix.md`, `joomla.md`, `modx.md`, `opencart.md`, `base-images.md`, `00-digest-maps.md` |
| Критика и пробелы | Критик нашёл, чего не хватает, десять отчётов закрыли пробелы замерами | `map/critic.md`, `map/gap-*.md`, `00-digest-gaps.md` |
| Разборы проекта | Три состязательных разбора, 79 замечаний и решения по ним | `attack-decisions.md` |
| Онбординг | Три варианта мастера, три судьи, три разбора досок | `onboarding/` |
| Ревью срезов | Четыре линзы, 96 замечаний и решения по ним | `review/` |

Выжимка `00-digest-gaps.md` новее `00-digest-maps.md`. Где они расходятся, верна она.

## Файлы

### Корень

| Файл | О чём |
| --- | --- |
| [00-digest-maps.md](00-digest-maps.md) | Выжимка 12 отчётов фазы изучения: итог, неожиданности, вопросы |
| [00-digest-gaps.md](00-digest-gaps.md) | Выжимка критика и 10 отчётов о пробелах |
| [attack-decisions.md](attack-decisions.md) | Решения по 79 замечаниям состязательных разборов проекта |
| [bitrix.md](bitrix.md) | 1С-Битрикс: версии, дерево, конфигурация, база, админка, чтение EULA, варианты предпросмотра |
| [joomla.md](joomla.md) | Joomla: сведения для адаптера стека |
| [modx.md](modx.md) | MODX Revolution 2.8 и 3.x: сведения для адаптера стека |
| [opencart.md](opencart.md) | OpenCart 2.3, 3.x, 4.x, ocStore, OPENCART.PRO: сведения для адаптера стека |
| [base-images.md](base-images.md) | Базовые образы предпросмотра: основа, расширения, замеры прототипа |

### map/

| Файл | О чём |
| --- | --- |
| [critic.md](map/critic.md) | Критика полноты: чего не хватало, чтобы писать проект |
| [adapter-contract.md](map/adapter-contract.md) | Договор адаптера стека |
| [stack-leaks.md](map/stack-leaks.md) | Где WordPress протекает из адаптера в остальной код |
| [preview-pipeline.md](map/preview-pipeline.md) | Конвейер предпросмотра и что нужно другим CMS |
| [release-pipeline.md](map/release-pipeline.md) | Выпуск `/release` и откат: что нейтрально к стеку, что требует плагина |
| [onboarding.md](map/onboarding.md) | Онбординг сайта: код, опыт клиента, что нужно для других CMS |
| [browser-mcp.md](map/browser-mcp.md) | Что в браузере задачи и в инструментах агента зависит от стека |
| [tests-ci-env.md](map/tests-ci-env.md) | Тесты, CI и окружение: что значит «доказано» для нового стека |
| [gap-plan-61-not-accounted.md](map/gap-plan-61-not-accounted.md) | Пробел 1: уровни поддержки и защита админки после слияния `feat/chats-first` |
| [gap-no-cms-ever-booted.md](map/gap-no-cms-ever-booted.md) | Пробел 2: стартуют ли CMS на копии предпросмотра, спайк семи сборок |
| [gap-site-facts-model.md](map/gap-site-facts-model.md) | Пробел 3: одна модель фактов о сайте |
| [gap-supported-versions.md](map/gap-supported-versions.md) | Пробел 4: какие версии поддерживаем и что говорим остальным |
| [gap-reports-contradict.md](map/gap-reports-contradict.md) | Пробел 5: какое значение верно там, где отчёты расходятся |
| [gap-generated-code-and-prod-php.md](map/gap-generated-code-and-prod-php.md) | Пробел 6: что исполняется, не равно тому, что в git; код платформы на проде |
| [gap-one-shot-full-import.md](map/gap-one-shot-full-import.md) | Пробел 7: разовый импорт целиком, магазины по FTP и обновления CMS |
| [gap-agent-quality-per-stack.md](map/gap-agent-quality-per-stack.md) | Пробел 8: справится ли `glm-5.3` с новыми CMS и сколько это стоит |
| [gap-live-store-rules.md](map/gap-live-store-rules.md) | Пробел 9: правила 3, 4 и 9 на живом магазине и страницах-файлах |
| [gap-site-sessions-in-preview-iframe.md](map/gap-site-sessions-in-preview-iframe.md) | Пробел 10: сессии сайта в кадре кабинета |

### review/

| Файл | О чём |
| --- | --- |
| [slices-coverage.md](review/slices-coverage.md) | Покрытие и порядок срезов |
| [slices-rules.md](review/slices-rules.md) | Правила 1–10, секреты, персональные данные, тексты клиенту |
| [slices-tests.md](review/slices-tests.md) | Ловит ли названный тест поломку, есть ли стенд, идёт ли он в CI |
| [slices-wordpress.md](review/slices-wordpress.md) | Регрессия WordPress |
| [slices-decisions.md](review/slices-decisions.md) | Решения по 96 замечаниям четырёх разборов |

### onboarding/

| Файл | О чём |
| --- | --- |
| [flow-a.md](onboarding/flow-a.md), [flow-b.md](onboarding/flow-b.md), [flow-c.md](onboarding/flow-c.md) | Три варианта мастера: итог внутри шага, свой шаг, сначала адрес |
| [judge-build.md](onboarding/judge-build.md) | Судья осуществимости |
| [judge-owner.md](onboarding/judge-owner.md) | Судья клиента |
| [judge-truth.md](onboarding/judge-truth.md) | Судья честности |
| [critic-copy.md](onboarding/critic-copy.md) | Вычитка текстов досок |
| [critic-coverage.md](onboarding/critic-coverage.md) | Покрытие: что на досках есть и чего нет |
| [critic-craft.md](onboarding/critic-craft.md) | Ремесло: разметка и стили досок |

### scripts/

| Каталог | Файлов | Что это |
| --- | --- | --- |
| `scripts/boot-spike/` | 68 | Спайк запуска семи сборок CMS и действий агента в их админках (`map/gap-no-cms-ever-booted.md`). `files-patched.mjs` — копия `infra/preview/files.mjs` с одной правкой под `runsc` |
| `scripts/base-images-proto/` | 11 | Прототип образа (`base-images.md`). Основа прототипа отклонена: Sury закрыт для российских адресов |
| `scripts/spike-gap6/` | 12 | Опыты с кешем, opcache и OCMOD (`map/gap-generated-code-and-prod-php.md`) |
| `scripts/iframe-cookie-stand/` | 8 | Стенд кук в кадре кабинета (`map/gap-site-sessions-in-preview-iframe.md`) |

Скрипты — запись того, как получены наблюдения, а не инструмент. Как есть они не запускаются: пути заменены на `<repo>` и `<work>`, пароли стендов — на `<hidden>`, а деревьев CMS, ключей TLS и образов, которые им нужны, здесь нет. Инструмент проверок нового стека — `verify:stack` из договора Э1.

Бриф фазы проектирования лежит здесь же: [`00-brief.md`](00-brief.md), «Факт N» проекта — пункт его §3. Ссылки на `design/00-brief.md` в отчётах ведут на него. Решения по замечаниям пяти линз к плану — [`review/plan-decisions.md`](review/plan-decisions.md), по кругу 1 проверки срезов — [`review/plan-decisions-2.md`](review/plan-decisions-2.md).

## Пути в отчётах

Отчёты писались в рабочей папке вне репозитория. Номера строк сохранены: очистка не меняет число строк ни в одном файле, поэтому ссылки вида `joomla.md:409` верны. Там, где цитата заменена пересказом, остаток места занят пустыми строками.

| В отчётах | Здесь |
| --- | --- |
| `research/bitrix.md`, `joomla`, `modx`, `opencart`, `base-images` | Корень каталога. Ссылки исправлены |
| `design/attack-decisions.md`, `design/00-digest-*.md` | Корень каталога. Ссылки исправлены |
| `research/boot-spike/scripts/…` | `scripts/boot-spike/…`. Ссылки в отчётах и договорах срезов исправлены |
| `research/boot-spike/cms/<стек>/{policy.mjs,rewrite.conf,platform/**.php}` | `scripts/boot-spike/cms/…`, только текстовые файлы платформы, без деревьев CMS |
| `research/base-images-proto`, `research/spike-gap6`, `research/iframe-cookie-stand` | `scripts/…`, только скрипты. Журналы и хеши, которые называют отчёты, не перенесены |
| `research/boot-spike/{work,snap,logs,abl,image}`, деревья из `research/boot-spike/cms`, `research/src`, `research/agent-quality-proto`, `research/version-sample` | Не перенесены |
| `scratchpad/…` | Временные папки сессий, их больше нет |
| `raditi-stacks`, `raditi-chats`, `raditi` | Рабочие деревья веток `feat/site-stacks` и `feat/chats-first` и основное дерево |
| `design/architecture.md`, `architecture.md` | Черновик проекта, итог — `docs/plan/62-site-stacks.md`. Номера строк к итогу не относятся |
| `plan/slices-<этап>.md`, `slices-<этап>.md`, `after`, `e3` | `docs/plan/62-slices/<этап>.md`. Номера строк — на дату ревью |
| `onboarding/flow.md`, `flow.md` | `docs/plan/62-onboarding.md` |
| `plan/…`, `boards/…`, `00-design-brief.md`, `attack-contract.md`, `attack-attack.md`, `attack-customer.md` | Рабочие файлы, не перенесены |

## Что намеренно не перенесено

| Что | Почему |
| --- | --- |
| `research/src` целиком | Скачанные дистрибутивы и материалы третьих лиц. У Битрикса это ещё и лицензия: копии ядра быть не должно (факт 14 задания, пп. 3.2, 4.8 EULA) |
| `research/boot-spike/{work,snap,logs,abl,image}` и деревья CMS | Деревья CMS, копии баз, снимки экранов агента, журналы и контекст образа. Текстовые файлы платформы, на которые ссылаются договоры Э1, Э3, Э4 и Э5, перенесены в `scripts/boot-spike/cms/` |
| `research/agent-quality-proto` | Выгрузки. Числа живут в `map/gap-agent-quality-per-stack.md` |
| `research/version-sample` | Сырые адреса сторонних сайтов. Числа живут в `map/gap-supported-versions.md` |
| Журналы и вывод запусков: `*.log`, `build-times.txt`, `prev-copies*.txt`, `prod-copies.txt` | Это результаты, а не скрипты. Числа живут в отчётах |
| Доски онбординга и файлы холста | Описание экранов — `docs/plan/62-onboarding.md` |
| Тексты лицензий и условий третьих лиц | Только пересказ с номером пункта и ссылка на источник |
| Рабочие файлы сборки: черновики проекта, предложения, разборы, сверки | Их итог — проект и договоры срезов |

## Как очищено

Перенос сделан одним скриптом, он писал только в этот каталог. Числа — один проход по 112 файлам: 40 отчётов и 72 скрипта.

| Что заменено | Сколько |
| --- | --- |
| Домашние и временные пути на относительные | 57 |
| Часть адреса почты владельца на `<hidden>` | 2 |
| Адрес почты на настоящем домене на `example.test`, значение было синтетическим | 3 |
| Сведения о выходе машины в сеть: город и сеть | 5 |
| Пароли стендов на `<hidden>`, все синтетические | 42 |
| Токены и хеши стендов на `<hidden>`, все синтетические | 3 |
| Фрагменты кода и конфигурации Битрикса: на пересказ или имя | 39, из них 3 блока кода |
| Блоки кода других CMS на пересказ | 6 |
| Цитаты лицензий, условий и писем третьих лиц на пересказ с номером пункта | 15 |
| Название бакета бэкапов на описание: строку запрещает контракт Э00 | 1 |
| Ссылки на файлы, переехавшие внутри каталога | 26 |

Настоящих ключей, токенов, паролей и адресов сайта владельца в материале не найдено. Домены производителей CMS, CDN и документации оставлены как источники, адреса сторонних сайтов из выборок в отчётах не встретились.

Поиск по шаблонам после переноса шёл по всем файлам каталога: домашние и временные пути, имя пользователя и части почты, адреса почты вне зарезервированных доменов, адреса IP, PEM, JWT, bearer, ключи AWS, GitHub, GitLab, Slack, Z.ai, токен MCP, DSN с паролем, присваивания паролей, длинные строки вида base64. Нашлись только контрольные суммы образов и пакетов и длинные пути файлов.

Чего такой поиск не видит: секрет без известной формы, значение, разрезанное переносом строки, закодированное значение, а также смысл текста. Код ядра Битрикса снят по шаблонам и чтением `bitrix.md`. В отчётах остались имена файлов, папок, классов, таблиц, настроек и констант, селекторы формы входа и тексты ошибок для меток проверки: это имена и то, что видит посетитель, а не строки кода.

В `modx.md` и `opencart.md` оставлены три своих образца на API этих CMS. Их писали авторы отчётов, это не цитаты: `modx.md:469`, `modx.md:527`, `opencart.md:479`.
