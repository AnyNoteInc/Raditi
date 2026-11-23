// Spike 7 of plan 88: 30 diagrams written the way an LLM agent writes them for a small business,
// plus a few hostile probes. All text is synthetic, except three samples copied from the repo docs
// (written by an agent for the project itself).
//
// valid:
//   true   — valid by the Mermaid documentation;
//   false  — a deliberate mistake that Mermaid's grammar rejects (classic model errors);
//   'unicode' — valid by the docs, but uses Cyrillic identifiers (entity, class, state or point names),
//               which is how a model writes for a Russian client; whether each engine accepts it is a finding.
// labels: texts that must be visible in the picture (one line of a multi-line label per item).

const NBSP = ' '
const BT = '`'

export const corpus = [
  {
    id: 'F01', type: 'flowchart', valid: true, title: 'Заявка с сайта (TD, решения, подписи рёбер)',
    source: `flowchart TD
    A[Заявка с сайта] --> B{Клиент оставил телефон?}
    B -->|Да| C[Звонок менеджера в течение 15 минут]
    B -->|Нет| D[Письмо на почту]
    C --> E{Клиент готов купить?}
    D --> E
    E -->|Да| F[Счёт и предоплата 50%]
    E -->|Нет| G[Напоминание через 3 дня]
    G --> E
    F --> H[Выполнение заказа]
    H --> I([Отзыв клиента])`,
    labels: ['Заявка с сайта', 'Клиент оставил телефон?', 'Звонок менеджера в течение 15 минут', 'Письмо на почту', 'Клиент готов купить?', 'Счёт и предоплата 50%', 'Напоминание через 3 дня', 'Выполнение заказа', 'Отзыв клиента', 'Да', 'Нет'],
  },
  {
    id: 'F02', type: 'flowchart', valid: true, title: 'Путь покупателя (LR, «кавычки», скобки в кавычках, <br>)',
    source: `flowchart LR
    ad["Реклама во «ВКонтакте»"] --> site["Сайт магазина"]
    seo["Поиск (Яндекс)"] --> site
    site --> cart["Корзина<br>«Мои покупки»"]
    cart --> pay{"Оплата (картой или СБП)"}
    pay -->|успешно| ok["Заказ принят<br/>№ 1024"]
    pay -->|ошибка| retry["Повторить оплату"]
    retry --> pay
    ok --> ship[["Доставка СДЭК (2–3 дня)"]]
    ship --> done(("Получено"))`,
    labels: ['Реклама во «ВКонтакте»', 'Сайт магазина', 'Поиск (Яндекс)', 'Корзина', '«Мои покупки»', 'Оплата (картой или СБП)', 'Заказ принят', '№ 1024', 'Повторить оплату', 'Доставка СДЭК (2–3 дня)', 'Получено', 'успешно', 'ошибка'],
  },
  {
    id: 'F03', type: 'flowchart', valid: true, title: 'Автосервис (подграфы, classDef, style)',
    source: `flowchart TD
    subgraph priem["Приёмка автомобиля"]
        A[Клиент приезжает] --> B[Мастер-приёмщик осматривает авто]
        B --> C[Заказ-наряд]
    end
    subgraph repair["Ремонтная зона"]
        D[Диагностика] --> E{Нужны запчасти?}
        E -->|Да| F[Заказ запчастей у поставщика]
        E -->|Нет| G[Ремонт]
        F --> G
    end
    subgraph out["Выдача"]
        H[Проверка качества] --> I[Оплата и выдача ключей]
    end
    C --> D
    G --> H
    classDef important fill:#fff3cd,stroke:#d39e00,stroke-width:2px
    class E,H important
    style I fill:#d4edda,stroke:#28a745`,
    labels: ['Приёмка автомобиля', 'Ремонтная зона', 'Выдача', 'Клиент приезжает', 'Мастер-приёмщик осматривает авто', 'Заказ-наряд', 'Диагностика', 'Нужны запчасти?', 'Заказ запчастей у поставщика', 'Ремонт', 'Проверка качества', 'Оплата и выдача ключей'],
  },
  {
    id: 'F04', type: 'flowchart', valid: true, title: 'Оргструктура пекарни (TB, эмодзи, <br/>)',
    source: `flowchart TB
    dir["👩‍💼 Директор<br/>Анна Петрова"]
    dir --> sales["📞 Отдел продаж<br/>3 менеджера"]
    dir --> prod["🧁 Производство<br/>кондитерский цех"]
    dir --> acc["🧾 Бухгалтерия<br/>на аутсорсе"]
    sales --> s1["Менеджер по B2B"]
    sales --> s2["Менеджер по рознице"]
    prod --> p1["Пекарь"]
    prod --> p2["Кондитер"]
    prod --> p3["Упаковщик"]`,
    labels: ['Директор', 'Анна Петрова', 'Отдел продаж', '3 менеджера', 'Производство', 'кондитерский цех', 'Бухгалтерия', 'на аутсорсе', 'Менеджер по B2B', 'Менеджер по рознице', 'Пекарь', 'Кондитер', 'Упаковщик'],
  },
  {
    id: 'F05', type: 'flowchart', valid: true, title: 'Схема платформы из docs/spec.md (TB, 8 подграфов узлов, <-->, -.->)',
    origin: 'docs/spec.md:155-210',
    source: `flowchart TB
    client["Веб-чат, кабинет<br/>браузер или PWA"]
    bot["Telegram-бот<br/>через egress-прокси"]
    pay["ЮKassa<br/>платежи"]
    web["apps/web · Next.js 16<br/>кабинет, веб-чат, API, вебхуки, админка"]
    subgraph srv["Серверные приложения · NestJS 12, образ на приложение"]
        core["core<br/>задачи, BullMQ, cron, ключи хода,<br/>публикация в git"]
        mcp["mcp<br/>MCP-шлюз к сайтам"]
        llm["llm<br/>шлюз подписок, одна реплика"]
        preview["preview<br/>шлюз предпросмотров,<br/>шлюз трансляции браузера :8091"]
        browserw["browser :8086<br/>облачный браузер задач,<br/>размещение — M10"]
    end
    chromium["Браузерная сессия задачи<br/>контейнер Chromium, прокси выхода"]
    subgraph sbx["Песочная ВМ — секретов нет"]
        runner["runner<br/>забирает ходы, владеет контейнерами"]
        turn["Контейнер хода<br/>gVisor, OpenCode CLI"]
        gw["sandbox-gw<br/>белый список путей"]
    end
    git["Git-провайдер<br/>Gitea · GitHub · GitLab"]
    egress1["egress-1 за рубежом, если задан<br/>HTTPS CONNECT, mTLS"]
    prov["Z.ai: GLM<br/>план GLM Coding Plan"]
    site["Сервер сайта<br/>WordPress, SSH/FTP, админка"]
    pv["Предпросмотры диалогов<br/>PHP, копия БД, браузер агента"]
    client <-->|HTTPS, SSE| web
    client <-->|iframe, билет| preview
    client <-->|WSS, билет: кадры и ввод| preview
    preview <-->|WebSocket, токен| browserw
    mcp -->|web_*, токен| browserw
    core -->|reclaim, ensure по заданию, verify, close| browserw
    browserw -->|Playwright| chromium
    chromium -->|HTTPS к хостам сайта и другим сайтам| site
    preview --> pv
    core -->|сборка, синхронизация| pv
    bot <-->|вебхук, Bot API| web
    pay <-->|API, вебхук| web
    web -->|задача и outbox| core
    core -.->|события, Redis pub/sub| web
    runner -->|забирает ход| core
    runner -->|exec| turn
    turn --> gw
    gw -->|/zai| llm
    llm -->|TLS напрямую| prov
    llm -.->|TLS внутри CONNECT, если задан прокси| egress1
    egress1 -.-> prov
    gw -->|MCP| mcp
    mcp -->|контент, браузер| pv
    core -->|push main, тег| git
    git -->|выкладка по тегу| site
    subgraph infra["Инфраструктура — общая для всех сервисов"]
        vault["Vault · OpenBao или Stronghold"]
        s3["S3 · файлы, сессии, логи"]
        pg["PostgreSQL · задачи, аренды, outbox"]
        redis["Redis · BullMQ, pub/sub"]
        mon["Prometheus, Grafana"]
        egress["Egress-прокси · к Telegram и API"]
    end`,
    labels: ['Веб-чат, кабинет', 'браузер или PWA', 'Серверные приложения · NestJS 12, образ на приложение', 'Песочная ВМ — секретов нет', 'Инфраструктура — общая для всех сервисов', 'шлюз подписок, одна реплика', 'Vault · OpenBao или Stronghold', 'HTTPS, SSE', 'reclaim, ensure по заданию, verify, close', 'TLS внутри CONNECT, если задан прокси', 'выкладка по тегу'],
  },
  {
    id: 'F06', type: 'flowchart', valid: true, title: 'Шлюз подписок из p3-design.md (LR, цилиндры, ==>, подписи в кавычках)',
    origin: 'docs/research/2026-09-subscriptions/p3-design.md:187-207',
    source: `flowchart LR
  subgraph sbx["Песочная ВМ, Россия — секретов нет"]
    agent["Контейнер хода<br/>Codex CLI или Kimi Code CLI<br/>ключ хода sk-rdt-…"] -->|HTTP| sgw["sandbox-gw<br/>/codex/responses<br/>/kimi/v1/chat/completions<br/>/mcp"]
  end
  subgraph app["app-ВМ, Россия"]
    llm["роль llm :8084, одна реплика<br/>ключ → аккаунт, политика тела,<br/>потолок, учёт, ответы под CLI,<br/>обновление токенов, здоровье пула"]
    core["роль core<br/>issue / recover / revoke,<br/>выбор аккаунта, гейт, очередь"]
    pg[("PostgreSQL<br/>llm_keys, llm_calls, token_usage,<br/>subscription_accounts,<br/>cross_border_clearances")]
  end
  vault[("Vault<br/>subs/ (max_versions=1)<br/>turns/")]
  egress["egress-1, Казахстан<br/>HTTPS CONNECT + mTLS<br/>3 хоста :443, /probe"]
  oai["chatgpt.com<br/>auth.openai.com"]
  kimi["api.kimi.ai"]
  sgw -->|"HTTP, частная сеть"| llm
  core --> pg
  core -->|turns/| vault
  llm --> pg
  llm -->|subs/| vault
  llm ==>|"TLS до провайдера внутри CONNECT"| egress
  egress --> oai
  egress --> kimi`,
    labels: ['Песочная ВМ, Россия — секретов нет', 'app-ВМ, Россия', 'Контейнер хода', 'ключ хода sk-rdt-…', 'роль llm :8084, одна реплика', 'subs/ (max_versions=1)', 'egress-1, Казахстан', 'HTTP, частная сеть', 'TLS до провайдера внутри CONNECT', 'api.kimi.ai'],
  },
  {
    id: 'F07', type: 'flowchart', valid: false, title: 'Ошибка: скобки в подписи без кавычек',
    mistake: 'unquoted label with parentheses',
    source: `flowchart TD
    A[Клиент пишет в WhatsApp] --> B[Администратор (Мария) проверяет график]
    B --> C{Есть свободное окно?}
    C -->|Да| D[Запись в CRM (YCLIENTS)]
    C -->|Нет| E[Предложить другое время]
    D --> F[Напоминание за 24 часа (SMS)]`,
    labels: ['Клиент пишет в WhatsApp', 'Администратор (Мария) проверяет график', 'Есть свободное окно?', 'Запись в CRM (YCLIENTS)', 'Предложить другое время', 'Напоминание за 24 часа (SMS)'],
  },
  {
    id: 'F08', type: 'flowchart', valid: false, title: 'Ошибка: end как id узла',
    mistake: '"end" used as a node id',
    source: `flowchart LR
    start[Регистрация] --> lesson[Пробный урок]
    lesson --> pay{Оплатил курс?}
    pay -->|Да| course[Обучение 3 месяца]
    pay -->|Нет| end
    course --> cert[Сертификат]
    cert --> end`,
    labels: ['Регистрация', 'Пробный урок', 'Оплатил курс?', 'Обучение 3 месяца', 'Сертификат'],
  },
  {
    id: 'F09', type: 'flowchart', valid: true, title: 'Точки с запятой, graph TD;, %%{init}%%, подпись -- текст -->',
    mistake: 'model habits that Mermaid accepts: semicolons, init directive, old edge-text syntax',
    source: `%%{init: {"theme": "forest", "flowchart": {"curve": "basis"}}}%%
graph TD;
    A[Заказ букета]-->B[Сборка флористом];
    B-->C{Курьер свободен?};
    C-- Да -->D[Доставка за 2 часа];
    C-- Нет -->E[Доставка ко времени];
    D-->F[Фото букета клиенту];
    E-->F;`,
    labels: ['Заказ букета', 'Сборка флористом', 'Курьер свободен?', 'Доставка за 2 часа', 'Доставка ко времени', 'Фото букета клиенту', 'Да', 'Нет'],
  },
  {
    id: 'F10', type: 'flowchart', valid: true, title: 'HTML в подписях, неразрывный пробел, Markdown-строка',
    mistake: 'HTML tags and a markdown string inside labels',
    source: `flowchart TD
    A["<b>Консультация</b><br>бесплатно"] --> B["Лечение кариеса<br><i>от 3${NBSP}500 ₽</i>"]
    A --> C["<span style='color:red'>Срочно:</span> острая боль"]
    C --> D["Приём в день обращения"]
    B --> E["${BT}**Гарантия** 1 год${BT}"]
    D --> E`,
    labels: ['Консультация', 'бесплатно', 'Лечение кариеса', 'от 3 500 ₽', 'Срочно:', 'острая боль', 'Приём в день обращения', 'Гарантия', '1 год'],
  },
  {
    id: 'F11', type: 'flowchart', valid: false, title: 'Ошибка: кавычки внутри кавычек',
    mistake: 'straight quotes inside a quoted label',
    source: `flowchart LR
    A["Тариф "Бизнес""] --> B["Оплата"]
    B --> C["Доступ открыт"]`,
    labels: ['Тариф "Бизнес"', 'Оплата', 'Доступ открыт'],
  },
  {
    id: 'F12', type: 'flowchart', valid: false, title: 'Ошибка: ограждение ```mermaid внутри текста схемы',
    mistake: 'the code fence is part of the diagram text',
    source: `${BT}${BT}${BT}mermaid
flowchart TD
    A[Кофе навынос] --> B[Оплата по QR]
    B --> C[Чек на почту]
${BT}${BT}${BT}`,
    labels: ['Кофе навынос', 'Оплата по QR', 'Чек на почту'],
  },
  {
    id: 'F13', type: 'flowchart', valid: true, title: 'click со ссылками и linkStyle',
    mistake: 'clickable nodes, which strict mode must disable',
    source: `flowchart LR
    home[Главная] --> menu[Меню]
    home --> contacts[Контакты]
    menu --> order[Заказ онлайн]
    click order "https://example.com/order" "Открыть заказ" _blank
    click contacts href "https://example.com/contacts"
    linkStyle 0 stroke:#ff6600,stroke-width:3px`,
    labels: ['Главная', 'Меню', 'Контакты', 'Заказ онлайн'],
  },
  {
    id: 'S01', type: 'sequence', valid: true, title: 'Онлайн-запись в барбершоп (alt, Note, autonumber, activate)',
    source: `sequenceDiagram
    autonumber
    actor C as Клиент
    participant W as Сайт
    participant A as Администратор
    participant M as Мастер
    C->>W: Выбирает услугу «Стрижка + борода»
    W->>A: Новая запись на 18:30
    activate A
    A->>M: Свободно ли окно?
    alt Мастер свободен
        M-->>A: Да, записываю
        A-->>C: Подтверждение по SMS
    else Мастер занят
        M-->>A: Нет, могу в 19:30
        A-->>C: Предлагаем 19:30
    end
    deactivate A
    Note over C,W: Напоминание за 2 часа до визита`,
    labels: ['Клиент', 'Сайт', 'Администратор', 'Мастер', 'Выбирает услугу «Стрижка + борода»', 'Новая запись на 18:30', 'Свободно ли окно?', 'Мастер свободен', 'Подтверждение по SMS', 'Предлагаем 19:30', 'Напоминание за 2 часа до визита'],
  },
  {
    id: 'S02', type: 'sequence', valid: false, title: 'Ход агента из sandbox.md (alt/else, «;» в сообщении)',
    origin: 'docs/research/2026-09-bootstrap/sandbox.md:307-329',
    mistake: 'a semicolon inside a message ends the statement in Mermaid (#59; is the escape); found only by running it',
    source: `sequenceDiagram
  participant O as Оркестратор
  participant T as TurnRunner
  participant P as SandboxProvider
  participant S as S3
  participant G as GitProvider
  O->>T: runTurn(task, ход n), аренда в PostgreSQL
  T->>P: create(образ стека, 2 vCPU/4 ГБ, сеть gateway)
  alt есть снимок хода n−1
    T->>S: presigned GET workspace и home
    T->>P: restore: распаковка внутри песочницы от uid 10001
  else первый ход
    T->>G: короткий токен только на чтение
    T->>P: клон base в /workspace/repo (служебный контейнер)
  end
  T->>P: fs.write: конфиг драйвера, AGENTS.md, файлы клиента; секреты хода в tmpfs
  T->>P: run(driver.command), таймаут 20 мин
  P-->>T: JSONL → AgentEvent → БД, S3-чанки, шина → SSE
  T->>P: exec git diff --binary base → патч (недоверенный)
  T->>P: snapshot → S3 turns/n
  T->>P: destroy (или pause на тёплое окно)
  T->>G: чистый клон base, git apply, DiffPolicy, gitleaks, коммит и push от бота, PR
  T-->>O: итог хода (zod), новый статус`,
    labels: ['Оркестратор', 'TurnRunner', 'runTurn(task, ход n), аренда в PostgreSQL', 'есть снимок хода n−1', 'первый ход', 'run(driver.command), таймаут 20 мин', 'JSONL → AgentEvent → БД, S3-чанки, шина → SSE', 'итог хода (zod), новый статус'],
  },
  {
    id: 'S03', type: 'sequence', valid: false, title: 'Ошибка: loop без end, ; в сообщении',
    mistake: 'missing end of a loop block; a semicolon inside a message',
    source: `sequenceDiagram
    participant Клиент
    participant Бот
    participant Менеджер
    Клиент->>Бот: Здравствуйте; сколько стоит доставка?
    Бот->>Клиент: Доставка 300 ₽, бесплатно от 3000 ₽
    loop Каждые 10 минут
        Бот->>Менеджер: Есть необработанные вопросы
    Менеджер->>Клиент: Добрый день! Уточню адрес`,
    labels: ['Клиент', 'Бот', 'Менеджер', 'Доставка 300 ₽, бесплатно от 3000 ₽', 'Есть необработанные вопросы'],
  },
  {
    id: 'G01', type: 'gantt', valid: true, title: 'План запуска сайта пекарни (русские даты DD.MM.YYYY)',
    source: `gantt
    title План запуска сайта пекарни
    dateFormat DD.MM.YYYY
    axisFormat %d.%m
    excludes weekends
    section Подготовка
    Бриф и смета            :done,    brief, 02.11.2026, 3d
    Фотосессия продукции    :active,  photo, after brief, 4d
    section Разработка
    Дизайн главной          :         design, after brief, 5d
    Тексты для сайта        :         texts, after photo, 3d
    Вёрстка и наполнение    :crit,    dev, after design texts, 7d
    section Запуск
    Проверка и правки       :         qa, after dev, 2d
    Запуск сайта            :milestone, launch, after qa, 0d`,
    labels: ['План запуска сайта пекарни', 'Подготовка', 'Разработка', 'Запуск', 'Бриф и смета', 'Фотосессия продукции', 'Вёрстка и наполнение', 'Запуск сайта'],
  },
  {
    id: 'G02', type: 'gantt', valid: false, title: 'Ошибка: даты словами и excludes выходные',
    mistake: 'dates in Russian words and a dateFormat mismatch',
    source: `gantt
    title Ремонт кухни
    dateFormat YYYY-MM-DD
    excludes выходные
    section Работы
    Демонтаж        : 20 ноября 2026, 2d
    Электрика       : 23.11.2026, 3d
    Сборка мебели   : после электрики, 2d`,
    labels: ['Ремонт кухни', 'Работы', 'Демонтаж', 'Электрика', 'Сборка мебели'],
  },
  {
    id: 'P01', type: 'pie', valid: true, title: 'Откуда приходят клиенты кофейни (pie showData)',
    source: `pie showData
    title Откуда приходят клиенты кофейни
    "Сарафанное радио" : 35
    "Яндекс Карты" : 25
    "Instagram" : 20
    "Листовки у метро" : 12
    "Другое" : 8`,
    labels: ['Откуда приходят клиенты кофейни', 'Сарафанное радио', 'Яндекс Карты', 'Листовки у метро', 'Другое'],
  },
  {
    id: 'P02', type: 'pie', valid: false, title: 'Ошибка: проценты, запятая в дроби, подпись без кавычек',
    mistake: 'percent signs, a decimal comma and an unquoted label',
    source: `pie title Расходы салона за октябрь
    Аренда : 45%
    "Зарплата мастеров" : 30,5
    "Материалы" : 15.5
    "Реклама" : 9`,
    labels: ['Расходы салона за октябрь', 'Аренда', 'Зарплата мастеров', 'Материалы', 'Реклама'],
  },
  {
    id: 'ST01', type: 'state', valid: true, title: 'Статусы заказа (state … as …, note)',
    source: `stateDiagram-v2
    [*] --> new
    state "Новый заказ" as new
    state "Оплачен" as paid
    state "Собирается на складе" as packing
    state "Передан курьеру" as shipping
    state "Доставлен" as done
    state "Отменён" as cancelled
    new --> paid : оплата онлайн
    new --> cancelled : клиент отказался
    paid --> packing
    packing --> shipping : трек-номер
    shipping --> done
    done --> [*]
    cancelled --> [*]
    note right of paid : Чек уходит на почту`,
    labels: ['Новый заказ', 'Оплачен', 'Собирается на складе', 'Передан курьеру', 'Доставлен', 'Отменён', 'оплата онлайн', 'клиент отказался', 'трек-номер', 'Чек уходит на почту'],
  },
  {
    id: 'ST02', type: 'state', valid: 'unicode', title: 'Рассрочка: кириллические id, составное состояние, <<choice>>',
    source: `stateDiagram-v2
    [*] --> Заявка
    Заявка --> Проверка : менеджер звонит
    state Проверка {
        [*] --> Документы
        Документы --> Скоринг
        Скоринг --> [*]
    }
    state решение <<choice>>
    Проверка --> решение
    решение --> Одобрено : скоринг выше 600
    решение --> Отказ : скоринг ниже 600
    Одобрено --> [*]
    Отказ --> [*]`,
    labels: ['Заявка', 'Проверка', 'менеджер звонит', 'Документы', 'Скоринг', 'Одобрено', 'Отказ', 'скоринг выше 600', 'скоринг ниже 600'],
  },
  {
    id: 'C01', type: 'class', valid: 'unicode', title: 'Модель интернет-магазина (кириллические имена классов)',
    source: `classDiagram
    class Клиент {
        +String имя
        +String телефон
        +оформитьЗаказ() Заказ
    }
    class Заказ {
        +int номер
        +Date дата
        +Decimal сумма
        +оплатить() bool
    }
    class Товар {
        +String название
        +Decimal цена
        +int остаток
    }
    Клиент "1" --> "*" Заказ : оформляет
    Заказ "*" o-- "*" Товар : содержит`,
    labels: ['Клиент', 'Заказ', 'Товар', 'имя', 'телефон', 'сумма', 'остаток', 'оформитьЗаказ()', 'оформляет', 'содержит'],
  },
  {
    id: 'E01', type: 'er', valid: 'unicode', title: 'Заказы (кириллические сущности и атрибуты)',
    source: `erDiagram
    КЛИЕНТ ||--o{ ЗАКАЗ : оформляет
    ЗАКАЗ ||--|{ ПОЗИЦИЯ : содержит
    ТОВАР ||--o{ ПОЗИЦИЯ : "входит в"
    КЛИЕНТ {
        int id PK
        string имя
        string телефон "только мобильный"
    }
    ЗАКАЗ {
        int id PK
        int клиент_id FK
        date дата
        decimal сумма
    }`,
    labels: ['КЛИЕНТ', 'ЗАКАЗ', 'ПОЗИЦИЯ', 'ТОВАР', 'оформляет', 'содержит', 'входит в', 'имя', 'телефон', 'только мобильный', 'клиент_id'],
  },
  {
    id: 'E02', type: 'er', valid: true, title: 'Запись в салон (латинские сущности, русские подписи)',
    source: `erDiagram
    CUSTOMER ||--o{ BOOKING : "делает"
    MASTER ||--o{ BOOKING : "принимает"
    SERVICE ||--o{ BOOKING : "входит в"
    CUSTOMER {
        int id PK
        string name "Имя клиента"
        string phone "Телефон"
    }
    SERVICE {
        int id PK
        string title "Название услуги"
        decimal price "Цена, ₽"
        int minutes "Длительность, мин"
    }`,
    labels: ['CUSTOMER', 'BOOKING', 'MASTER', 'SERVICE', 'делает', 'принимает', 'входит в', 'Имя клиента', 'Название услуги', 'Цена, ₽', 'Длительность, мин'],
  },
  {
    id: 'J01', type: 'journey', valid: true, title: 'Путь гостя в кофейне (journey)',
    source: `journey
    title Путь гостя в кофейне
    section Дорога
      Увидел вывеску: 3: Гость
      Нашёл на Яндекс Картах: 4: Гость
    section В кофейне
      Очередь у кассы: 2: Гость, Бариста
      Заказ капучино: 5: Гость
      Оплата по QR: 4: Гость, Бариста
    section После
      Отзыв на картах: 3: Гость`,
    labels: ['Путь гостя в кофейне', 'Дорога', 'В кофейне', 'После', 'Увидел вывеску', 'Нашёл на Яндекс Картах', 'Очередь у кассы', 'Оплата по QR', 'Отзыв на картах', 'Бариста'],
  },
  {
    id: 'M01', type: 'mindmap', valid: true, title: 'Продвижение салона (mindmap, ::icon)',
    source: `mindmap
  root((Продвижение салона))
    Соцсети
      ВКонтакте
      Telegram-канал
      Reels с работами мастеров
    Карты
      Яндекс Карты
      2ГИС
      ::icon(fa fa-map)
    Акции
      Скидка 15% в день рождения
      Приведи подругу
    Сайт
      Онлайн-запись
      Портфолио`,
    labels: ['Продвижение салона', 'Соцсети', 'ВКонтакте', 'Telegram-канал', 'Reels с работами мастеров', 'Яндекс Карты', '2ГИС', 'Скидка 15% в день рождения', 'Приведи подругу', 'Онлайн-запись', 'Портфолио'],
  },
  {
    id: 'T01', type: 'timeline', valid: true, title: 'История пекарни «Колосок» (timeline)',
    source: `timeline
    title История пекарни «Колосок»
    2019 : Открыли первую точку
         : Хлеб на закваске
    2021 : Запустили доставку
    2023 : Вторая пекарня в центре
         : Сайт с онлайн-заказом
    2026 : 12 сотрудников`,
    labels: ['История пекарни «Колосок»', '2019', 'Открыли первую точку', 'Хлеб на закваске', 'Запустили доставку', 'Вторая пекарня в центре', 'Сайт с онлайн-заказом', '12 сотрудников'],
  },
  {
    id: 'Q01', type: 'quadrant', valid: 'unicode', title: 'Задачи на неделю (quadrantChart, кириллические точки)',
    source: `quadrantChart
    title Задачи на неделю
    x-axis Низкая срочность --> Высокая срочность
    y-axis Низкая важность --> Высокая важность
    quadrant-1 Сделать сейчас
    quadrant-2 Запланировать
    quadrant-3 Отложить
    quadrant-4 Поручить
    Ответить на отзывы: [0.8, 0.7]
    Обновить прайс: [0.3, 0.8]
    Заказать визитки: [0.2, 0.3]
    Позвонить поставщику: [0.9, 0.35]`,
    labels: ['Задачи на неделю', 'Низкая срочность', 'Высокая срочность', 'Сделать сейчас', 'Запланировать', 'Отложить', 'Поручить', 'Ответить на отзывы', 'Обновить прайс', 'Заказать визитки', 'Позвонить поставщику'],
  },
  {
    id: 'X01', type: 'xychart', valid: 'unicode', title: 'Выручка кофейни (xychart-beta, кириллические категории)',
    source: `xychart-beta
    title "Выручка кофейни, тыс. ₽"
    x-axis [Янв, Фев, Мар, Апр, Май, Июн]
    y-axis "Выручка" 0 --> 900
    bar [420, 480, 610, 590, 720, 810]
    line [400, 450, 560, 600, 690, 780]`,
    labels: ['Выручка кофейни, тыс. ₽', 'Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Выручка'],
  },
]

// Hostile probes: not counted among the 30. Each one tries to make the renderer or the sanitized SVG
// run script, load something from the network or escape the strict mode. A probe "wins" if
// window.__pwned changes in the render page, if a request leaves the render page, or if the sanitized
// SVG still carries script, event handlers, javascript: URLs, foreignObject, external URLs or @import.
export const hostile = [
  {
    id: 'H01', type: 'flowchart', title: 'HTML-обработчики и <script> в подписях',
    source: `flowchart LR
    A["<img src=x onerror=window.__pwned='H01-img'>Фото"] --> B["<script>window.__pwned='H01-script'</script>Скрипт"]
    B --> C["<svg onload=window.__pwned='H01-svg'>Свг</svg>"]`,
  },
  {
    id: 'H02', type: 'flowchart', title: '%%{init: securityLevel loose}%% и click javascript:',
    source: `%%{init: {"securityLevel": "loose", "secure": []}}%%
flowchart LR
    A[Нажми] --> B[Ещё]
    click A call alert(1)
    click B "javascript:window.__pwned='H02'"`,
  },
  {
    id: 'H03', type: 'flowchart', title: 'themeCSS с url() и @import',
    source: `%%{init: {"themeCSS": ".node rect { fill: url(https://attacker.example/h03.png) } @import url('https://attacker.example/h03.css');"}}%%
flowchart LR
    A[Узел] --> B[Узел 2]`,
  },
  {
    id: 'H04', type: 'flowchart', title: 'classDef и style с url()',
    source: `flowchart LR
    A[Узел] --> B[Узел 2]
    classDef evil fill:url(https://attacker.example/h04a.png),stroke:#f00
    class A evil
    style B fill:#fff,background-image:url(https://attacker.example/h04b.png)`,
  },
  {
    id: 'H05', type: 'flowchart', title: 'Markdown-ссылка и <a href=javascript:>',
    source: `flowchart LR
    A["${BT}[ссылка](javascript:window.__pwned='H05-md')${BT}"] --> B["<a href='javascript:window.__pwned=1'>жми</a>"]`,
  },
  {
    id: 'H06', type: 'sequence', title: 'Ссылки участника sequence с javascript:',
    source: `sequenceDiagram
    participant A as Склад
    participant B as Касса
    link A: Открыть @ javascript:window.__pwned='H06'
    links B: {"Отчёт": "javascript:window.__pwned='H06b'"}
    A->>B: Остатки`,
  },
  {
    id: 'H07', type: 'flowchart', title: 'Коды #lt; #gt; вместо < >',
    source: `flowchart LR
    A["#lt;img src=x onerror=window.__pwned='H07'#gt;"] --> B["#lt;script#gt;window.__pwned='H07b'#lt;/script#gt;"]`,
  },
  {
    id: 'H08', type: 'gantt', title: 'Нагрузка: диаграмма Ганта на 8 000 лет с шагом в день',
    dos: true,
    source: `gantt
    dateFormat YYYY-MM-DD
    tickInterval 1day
    section Вечность
    Долгая задача : a1, 0001-01-01, 9999-12-31`,
  },
]
