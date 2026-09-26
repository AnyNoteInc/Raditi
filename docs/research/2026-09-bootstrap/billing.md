# Деньги в Decimal, тариф с оплатой за действие и расчёт по токенам

## Коротко

- **Откуда брать токены для счёта.** Считать деньги нужно по вызовам, которые прошли через LiteLLM, а не по событиям CLI-агентов. LiteLLM видит каждый вызов любого агента и отдаёт usage в одном формате. Агенты отчитываются по-разному: Kimi в `stream-json` usage не выдаёт вовсе, у Qwen Code и OpenCode смысл полей плавает. События `usage` от драйверов идут только на живой прогресс и сверку.
- **Кто считает стоимость.** Её считаем мы сами: токены × наша версионная цена, в Decimal. Посчитанное LiteLLM (`response_cost`, float) годится только как предохранитель: лимит на ключ задачи или хода. В LiteLLM можно задать цены в рублях за токен, числа ему безразличны, но интерфейс подписывает их как USD. Есть открытые баги с ценой кэша, а при нескольких репликах LiteLLM лимиты расходятся.
- **Как хранить цены.** Рубли за 1 млн токенов, Decimal(14,6), с НДС и ставкой НДС, в отдельной таблице истории с `effective_from`. В каждую строку расхода кладём `price_id`, поэтому старые расходы не пересчитываются при смене цены.
- **Как хранить деньги.** Деньги клиента — Decimal(12,2) и Decimal(14,2). Себестоимость — Decimal(18,10). Округляем один раз на действие, до копеек, по правилу ROUND_HALF_UP: так же округляют decimal.js по умолчанию и PostgreSQL (`round(numeric)`).
- **Журнал списаний.** Предлагаю один `credit_ledger` для правок и рублей. Счета `billing_accounts` с полем `unit` = `EDIT | RUB`, резервы — в отдельной таблице `credit_holds`.
- **Оплата за действие.** Предоплаченный рублёвый кошелёк плюс по желанию автопополнение с сохранённой карты. Автоплатёж на каждое действие не советую.
- **Касса.** «Чеки от ЮKassa» не поддерживают признак расчёта «аванс». Порядок чеков при пополнении баланса должен решить бухгалтер, см. раздел 5.

---

## 1. Какие категории токенов отдают агенты и LiteLLM

| Источник (версия) | Где usage | Поля | Как понимать |
|---|---|---|---|
| Codex CLI 0.157.1 | `turn.completed.usage` в `codex exec --json` | `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens` (новое поле, `serde(default)`), `output_tokens`, `reasoning_output_tokens` | `cached` входит в `input`: в коде `non_cached_input = input − cached`. Reasoning по логике Responses API входит в `output`, повторно его не прибавляем |
| Kimi Code CLI (kimi-cli 1.52.0 на PyPI, нужно проверить, что это тот же дистрибутив, что в spec) | В `stream-json` usage **нет**. Он есть в режиме `kimi --wire` (JSON-RPC 2.0) в событии `StatusUpdate.token_usage` и в файле сессии `wire.jsonl` | `input_other`, `input_cache_read`, `input_cache_creation`, `output` | `input_other` уже **без** кэша, смысл не такой, как у OpenAI |
| Qwen Code 0.24.6 | `result.usage` и `result.stats.models[*].tokens` | `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `total_tokens`; `prompt`, `candidates`, `cached`, `thoughts` | Примеры в документации противоречат друг другу: в одном кэш входит в input, в другом нет. **Проверить в PoC** |
| OpenCode 1.18.32 | `step_finish.part.tokens` и `part.cost` | `input`, `output`, `reasoning`, `cache.read`, `cache.write` | `cost` считается в USD по каталогу самого OpenCode, его игнорируем. Есть баги, когда последний `step_finish` теряется (#26855, #31435, #38661) |
| LiteLLM 1.102.1 | Ответ, `StandardLoggingPayload`, `LiteLLM_SpendLogs` | Формат OpenAI: `prompt_tokens` (с кэшем), `completion_tokens` (с reasoning), `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`; в payload ещё `usage_object`, `cost_breakdown`, `response_cost` | `LiteLLM_SpendLogs.spend` имеет тип **Float**, отдельных колонок кэша там нет. В дневной таблице `LiteLLM_DailyUserSpend` колонки `cache_read_input_tokens` и `cache_creation_input_tokens` есть |

**Общая форма usage в ядре** (правило 8). Каждый драйвер в `parseEvent` приводит свои поля к ней, а биллинг строит её из LiteLLM:

```ts
type NormalizedUsage = {
  inputUncached: number   // prompt_tokens − cached − cache_write
  cacheRead: number
  cacheWrite: number
  output: number          // reasoning included
  reasoning: number       // informational, already inside output
}
// cost = (inputUncached·p_in + cacheRead·p_cache + cacheWrite·p_cwrite + output·p_out) / 1e6
```

**Что LiteLLM может, а что нет**

- **Свои цены.** В `model_info` задаются `input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`, `cache_creation_input_token_cost`, `output_cost_per_reasoning_token`. Валюта не указана, считается, что это USD. Если положить туда рубли за токен (цена за 1 млн / 1e6), то `spend` и `max_budget` будут численно в рублях, а интерфейс и метрики Prometheus всё равно подпишут их как USD.
- **Риски LiteLLM:**
  - У модели нет своих цен, а имя совпало со встроенной картой LiteLLM. Тогда посчитается в USD, и валюты смешаются. Нужна проверка в CI, что у каждого деплоймента цены заданы явно.
  - Цены 0/0 отключают проверку бюджета.
  - Баг #27191 открыт: цена кэша при своих ценах и usage OpenAI-совместимых провайдеров учитывается неверно.
  - Баг #26806 закрыт без исправления: цена кэша теряется в резервной ветке, когда цены берутся из БД.
- **Ключ на ход.** `/key/generate` принимает `max_budget`, `budget_duration`, `duration`, `metadata`, `models`, ключи и бюджеты есть в бесплатной версии. Предлагаю выдавать ключ **на ход, а не на задачу**: `duration` ≈ 25 минут, `max_budget` = остаток резерва / наценка. Внутри песочницы тогда нет долгоживущих секретов (правило 5), а ожидание в `awaiting_user` может длиться сколько угодно. Связь «хэш ключа → задача и ход» храним у себя. Учёт по тегам и `spend_logs_metadata` есть только в Enterprise.
- **Лимит пропускает перерасход.** Бюджет проверяется до запроса, поэтому последний вызов может выйти за лимит. При нескольких репликах LiteLLM расход синхронизируется через Redis, и в этом есть баги (#30460, #33325, #20886). Это касается и вопроса «зачем нам Redis»: для MVP хватит одной реплики LiteLLM.
- **Доставка вызовов к нам.** Callback `generic_api` (`GENERIC_LOGGER_ENDPOINT`, пакеты, `flush_interval` по умолчанию 60 с) шлёт `StandardLoggingPayload`. Принимаем идемпотентно по id вызова. Тексты промптов в эти логи писать не нужно: параметр `turn_off_message_logging` нужно проверить в PoC.

## 2. Цены провайдеров сейчас

**Yandex AI Studio** ([pricing](https://aistudio.yandex.ru/docs/ru/ai-studio/pricing.html))

- Цена указана **за 1 000 токенов**. Рубли — с НДС, доллары — без НДС.
- Кэшированный вход — отдельная цена. Кэш включается автоматически, но не гарантирован и к выходу не применяется.
- Отдельной цены для reasoning нет. Есть категория «токены инструментов»: судя по странице, это некэшированная история на момент результата инструмента, и она идёт по цене входа.
- Цены с НДС сходятся с business.md §5:

| Модель | Вход, ₽/1K | Кэш, ₽/1K | Выход, ₽/1K | То же, ₽/1M |
|---|---|---|---|---|
| Qwen3.6 35B | 0,2 | 0,05 | 0,3 | 200 / 50 / 300 |
| DeepSeek V4 Flash | 0,3 | 0,075 | 0,5 | 300 / 75 / 500 |
| Qwen3 235B | 0,5 | 0,5 | 0,5 | 500 / 500 / 500 (скидки на кэш нет) |
| gpt-oss-120b | 0,3 | 0,3 | 0,3 | 300 (в Cloud.ru — 15,86 / 61) |

**Cloud.ru Evolution Foundation Models**

- [Тариф](https://cloud.ru/documents/tariffs/evolution/foundation-models) действует с 15.09.2026. Единица — «млн шт» токенов, колонки с НДС и без, НДС 22%, оплата pay-as-you-go ([тарификация](https://cloud.ru/docs/foundation-models/ug/topics/pricing)).
- Строки с кэшем в выдержке тарифа есть только у внешних моделей Claude. Для открытых моделей цены кэша нет, значит, кэш идёт по цене входа. Это вывод, а не прямой текст тарифа.
- В [каталоге](https://cloud.ru/products/evolution-ai-factory/catalog-foundation-models) цены с НДС (без НДС × 1,22) и до 4 знаков после запятой, в ₽ за 1 млн:

| Модель | Вход | Выход |
|---|---|---|
| Qwen3-Coder-Next | 122 | 244 |
| Kimi-K2.6 | 175,68 | 725,9 |
| GLM-5.1 | 198,86 | 829,6 |
| DeepSeek-V4-Pro | 183 | 732 |
| gpt-oss-120b | 15,86 | 61 |
| MiniMax-M3 | 240,218 | 1008,8546 |

- В business.md эти цены округлены. В сидах нужны точные.
- **Не проверено:** отдают ли Yandex и Cloud.ru `cached_tokens` и `reasoning_tokens` в usage OpenAI-совместимого API и как округляют в биллинге. PDF будущей версии тарифа не прочитался, распознать его было нечем. Проверим в PoC одним реальным запросом и сверкой с детализацией счёта.

## 3. Decimal в Prisma 7 и PostgreSQL

**Версии (`npm view`):** `@prisma/client` 7.10.0, `decimal.js` 10.6.0, `superjson` 2.2.6, `zod` 4.6.5, `@trpc/server` 11.19.0.

У npm-пакета `prisma` тег `latest` сейчас указывает на **8.0.0-rc.17**. Пакет CLI нужно закрепить явно: `prisma@7.10.0`.

- **Стандартный тип опасен.** Prisma `Decimal` без `@db` в PostgreSQL даёт `decimal(65,30)` ([types](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql)). Точность задаём всегда.
- **Какие точности брать:**

| Что | Тип | Почему |
|---|---|---|
| Деньги клиента: цены тарифов, заказы, списания | `Decimal(12,2)` | Копейки, как в чеке и в ЮKassa (`"4900.00"`) |
| Баланс, резерв, записи журнала | `Decimal(14,2)` | Запас для сумм |
| Цена провайдера **за 1 млн токенов** | `Decimal(14,6)` | У Cloud.ru до 4 знаков, у Yandex за 1K ×1000, числа читаемые |
| Себестоимость вызова, хода, задачи | `Decimal(18,10)` | tokens × price / 1e6 без потерь |
| Наценка | `Decimal(8,4)` | Например, `2.2000` |
| Ставка НДС | `Decimal(5,4)` | `0.2200` |
| Токены в строке | `Int`, суммы в SQL — `bigint` | — |

- **За 1 млн или за токен.** Храним за 1 млн, как в прайсах провайдеров. Цена за токен (0,00001586) плохо читается и легко теряет нули. Для LiteLLM делим на 1e6 при генерации `model_info`: там float допустим, это лишь предохранитель.
- **Арифметика.**
  - `Prisma.Decimal` — это decimal.js ([docs](https://www.prisma.io/docs/orm/v7/prisma-client/special-fields-and-types)), но своя встроенная копия, поэтому `instanceof` между копиями не срабатывает.
  - В `packages/domain` (порты и адаптеры) держим свой value object `Money` на `decimal.js` через `Decimal.clone({ precision: 34, rounding: ROUND_HALF_UP })`. У стандартных 20 значащих цифр запаса мало.
  - Адаптер БД переводит значения через строку: `new D(prismaDec.toString())`.
  - Баланс меняем в SQL (`{ decrement: … }` или `UPDATE … SET balance = balance - $1`) в той же транзакции, где пишем запись журнала.
- **Округление.** ROUND_HALF_UP до 2 знаков **один раз на действие**, от суммы в полной точности, а не на каждом вызове.
  - decimal.js по умолчанию: `rounding: 4` = HALF_UP, «от нуля».
  - PostgreSQL `round(numeric)` при равенстве тоже округляет от нуля ([docs](https://www.postgresql.org/docs/17/functions-math.html)), так что JS и SQL сходятся.
  - Банковское округление (HALF_EVEN) нужно, когда складывают много округлённых сумм, а у нас округление одно. Для чеков в России привычно «математическое».
  - НДС в чеке считает касса по `vat_code`.
- **tRPC.**
  - В AnyNote у браузерного tRPC-клиента нет transformer'а. Decimal уходит через `toJSON` строкой, но decimal.js для малых чисел даёт экспоненту (`"1.586e-5"`).
  - Поэтому в DTO отдаём **явные строки** через `toFixed(2)` или `toFixed(6)` и описываем их zod-схемами выхода.
  - superjson не нужен. Если всё же понадобится, Decimal надо регистрировать вручную через `registerCustom` и `Prisma.Decimal.isDecimal`, а это тянет рантайм Prisma в клиентский бандл.
- **zod 4.** Для строк:
  - `z.stringFormat('money', /^-?\d{1,12}(\.\d{1,2})?$/)`
  - `z.stringFormat('price1m', /^\d{1,8}(\.\d{1,6})?$/)`
  - Только на сервере: `z.codec(moneyString, z.instanceof(D), { decode: s => new D(s), encode: d => d.toFixed(2) })`.
  - Токены в событиях драйверов: `z.number().int().nonnegative()`.

## 4. Схема

### Цена для клиента на тарифе «оплата за действие»

| Вариант | Плюсы | Минусы |
|---|---|---|
| Своя цена для клиента по каждой модели (₽ за 1 млн) | Круглые цифры, разная ценность моделей | Ручные правки при каждой смене прайса. Маржа уходит в минус, если провайдер поднял цену. Клиенту приходится объяснять токены (правило 10) |
| Наценка на уровне тарифа × себестоимость | Маржа держится сама, одно число на тариф и класс моделей, прямо ложится в юнит-экономику. Одинаковый НДС 22% с обеих сторон не меняет соотношения | Цена действия плавает вместе с прайсом провайдера, это надо прописать в оферте |

**Рекомендация.** Наценка по тарифу и классу моделей, плюс фикса за действие (песочница, CI, в среднем 15,8 ₽ на эскалации оператору — одни токены их не покрывают), плюс минимум и потолок. Правило версионное, на задаче сохраняем `pricing_rule_id` в момент постановки.

Клиенту показываем только рубли: оценку до старта и итог.

Прикидка при наценке 2,0 и фиксе 30 ₽ — гипотеза на цифрах business.md §5:

| Тип задачи | Цена для клиента |
|---|---|
| Контент | ≈ 93 ₽ |
| Код | ≈ 333 ₽ |
| Сложная | ≈ 892 ₽ |
| Пакет «10 правок» для сравнения | 199 ₽ за правку |

### Журнал списаний

Один `credit_ledger` для правок и рублей: счета `billing_accounts(unit)` и отдельные резервы `credit_holds`. Получается один путь кода для резерва, списания и возврата и одна идемпотентность. Два отдельных журнала дублировали бы логику и сверку.

### Порядок резерва и списания для оплаты за действие

Итоговая цена известна только после задачи, поэтому:

1. **Постановка в очередь.** `hold = pricing_rule.hold_amount` для класса модели. Условие: `balance − held ≥ hold`, иначе «пополните баланс». Создаём `credit_holds` со статусом ACTIVE и увеличиваем `held`.
2. **Каждый ход.** Ключ LiteLLM с `max_budget = (hold − уже начислено) / markup`. Если LiteLLM ответил BudgetExceeded (в issue это HTTP 429), переводим задачу в `awaiting_user`: «нужно ещё до N ₽, продолжаем?». Если клиент согласен, резерв добираем.
3. **Уточнение и «Изменить».** Это та же задача, токены копятся в неё.
4. **`done`.** Считаем `billed = clamp(round_half_up(fee + Σcost × markup, 2), min, hold)`. Потолок равен hold, перерасход последнего вызова берём на себя, поэтому баланс не уходит в минус. Пишем в журнал `CHARGE(−billed)`, резерв переводим в CAPTURED.
5. **`failed`, `cancelled`** (и, скорее всего, `rolled_back` — вопрос 4 ниже). Резерв RELEASED. Себестоимость остаётся в `token_usage`, а `tasks.billable` = false.
6. **Резерв с `expires_at`.** Задачу, зависшую в `awaiting_user`, cron отменяет и освобождает резерв.
7. **«Отменить».** Задача с `billable = false`, без резерва.

**Для тарифов с квотой** механизм тот же, только в правках:

- Счёт `EDIT`, резерв = 1.
- Раз в период `GRANT` на 30, 80 или 250 правок, в конце периода `EXPIRE` остатка.
- Пакет из 10 правок — `GRANT` по оплаченному заказу.
- Дневной лимит считается по резервам и списаниям за сутки.

### Фрагмент Prisma-схемы

Стиль — как в AnyNote.

```prisma
enum PlanKind    { QUOTA  PAYG  PACK }
enum ModelClass  { LIGHT  STANDARD  HEAVY }
enum BillingUnit { EDIT  RUB }
enum LedgerKind  { GRANT  TOPUP  CHARGE  REFUND  EXPIRE  ADJUST }
enum HoldStatus  { ACTIVE  CAPTURED  RELEASED  EXPIRED }

model LlmModel {
  id         String     @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  providerId String     @map("provider_id") @db.Uuid
  slug       String     @db.VarChar(100) // LiteLLM model_name
  modelClass ModelClass @map("model_class")
  isActive   Boolean    @default(true) @map("is_active")

  provider LlmProvider     @relation(fields: [providerId], references: [id])
  prices   LlmModelPrice[]
  usage    TokenUsage[]

  @@unique([providerId, slug])
  @@map("llm_models")
}

/// Provider cost price, RUB per 1M tokens incl. VAT. Append-only history.
model LlmModelPrice {
  id               String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  modelId          String   @map("model_id") @db.Uuid
  effectiveFrom    DateTime @map("effective_from") @db.Timestamptz(6)
  inputPer1m       Decimal  @map("input_per_1m") @db.Decimal(14, 6)
  cachedInputPer1m Decimal? @map("cached_input_per_1m") @db.Decimal(14, 6) // null = input
  cacheWritePer1m  Decimal? @map("cache_write_per_1m") @db.Decimal(14, 6)  // null = input
  outputPer1m      Decimal  @map("output_per_1m") @db.Decimal(14, 6)       // reasoning included
  vatRate          Decimal  @map("vat_rate") @db.Decimal(5, 4)             // 0.2200
  sourceUrl        String   @map("source_url")
  createdAt        DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  model LlmModel     @relation(fields: [modelId], references: [id])
  usage TokenUsage[]

  @@unique([modelId, effectiveFrom])
  @@map("llm_model_prices")
}

model Plan {
  id            String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  slug          String   @unique @db.VarChar(50)
  name          String   @db.VarChar(100)
  kind          PlanKind
  price         Decimal  @db.Decimal(12, 2) // RUB incl. VAT; 4900.00; 0 for PAYG
  editsPerMonth Int?     @map("edits_per_month")
  editsPerDay   Int?     @map("edits_per_day")
  maxSites      Int      @map("max_sites")
  isActive      Boolean  @default(true) @map("is_active")

  pricingRules PricingRule[]

  @@map("plans")
}

/// PAYG action price = clamp(feePerAction + Σ cost × markup, minCharge, holdAmount)
model PricingRule {
  id            String     @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  planId        String     @map("plan_id") @db.Uuid
  modelClass    ModelClass @map("model_class")
  effectiveFrom DateTime   @map("effective_from") @db.Timestamptz(6)
  markup        Decimal    @db.Decimal(8, 4)
  feePerAction  Decimal    @map("fee_per_action") @db.Decimal(12, 2)
  minCharge     Decimal    @map("min_charge") @db.Decimal(12, 2)
  holdAmount    Decimal    @map("hold_amount") @db.Decimal(12, 2)

  plan Plan @relation(fields: [planId], references: [id])

  @@unique([planId, modelClass, effectiveFrom])
  @@map("pricing_rules")
}

/// One LLM call via LiteLLM; idempotent ingest by gatewayCallId.
model TokenUsage {
  id                String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  gatewayCallId     String   @unique @map("gateway_call_id") @db.VarChar(100)
  taskId            String   @map("task_id") @db.Uuid
  turnNo            Int      @map("turn_no")
  driver            String   @db.VarChar(32)
  modelId           String   @map("model_id") @db.Uuid
  priceId           String   @map("price_id") @db.Uuid
  inputTokens       Int      @map("input_tokens")                 // uncached
  cachedInputTokens Int      @default(0) @map("cached_input_tokens")
  cacheWriteTokens  Int      @default(0) @map("cache_write_tokens")
  outputTokens      Int      @map("output_tokens")                // incl. reasoning
  reasoningTokens   Int      @default(0) @map("reasoning_tokens") // info only
  costRub           Decimal  @map("cost_rub") @db.Decimal(18, 10)
  occurredAt        DateTime @map("occurred_at") @db.Timestamptz(6)

  task  Task          @relation(fields: [taskId], references: [id])
  model LlmModel      @relation(fields: [modelId], references: [id])
  price LlmModelPrice @relation(fields: [priceId], references: [id])

  @@index([taskId, turnNo])
  @@map("token_usage")
}

// Task additions:
//   pricingRuleId String?  @map("pricing_rule_id") @db.Uuid
//   costRub       Decimal? @map("cost_rub")   @db.Decimal(18, 10)
//   billedRub     Decimal? @map("billed_rub") @db.Decimal(12, 2)
//   billable      Boolean  @default(true)     // false: undo, operator retry

model BillingAccount {
  id          String      @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  workspaceId String      @map("workspace_id") @db.Uuid
  unit        BillingUnit
  balance     Decimal     @default(0) @db.Decimal(14, 2) // CHECK (balance >= 0) in SQL
  held        Decimal     @default(0) @db.Decimal(14, 2) // Σ ACTIVE holds

  holds   CreditHold[]
  entries CreditLedger[]

  @@unique([workspaceId, unit])
  @@map("billing_accounts")
}

model CreditHold {
  id        String     @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  accountId String     @map("account_id") @db.Uuid
  taskId    String     @unique @map("task_id") @db.Uuid
  amount    Decimal    @db.Decimal(14, 2)
  status    HoldStatus @default(ACTIVE)
  expiresAt DateTime   @map("expires_at") @db.Timestamptz(6)
  createdAt DateTime   @default(now()) @map("created_at") @db.Timestamptz(6)
  settledAt DateTime?  @map("settled_at") @db.Timestamptz(6)

  account BillingAccount @relation(fields: [accountId], references: [id])

  @@index([accountId, status])
  @@map("credit_holds")
}

model CreditLedger {
  id             String      @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  accountId      String      @map("account_id") @db.Uuid
  unit           BillingUnit // copy for CHECK: unit <> 'EDIT' OR amount = trunc(amount)
  kind           LedgerKind
  amount         Decimal     @db.Decimal(14, 2) // signed
  balanceAfter   Decimal     @map("balance_after") @db.Decimal(14, 2)
  taskId         String?     @map("task_id") @db.Uuid
  orderId        String?     @map("order_id") @db.Uuid
  idempotencyKey String      @unique @map("idempotency_key") @db.VarChar(120) // "task:<id>:charge"
  createdAt      DateTime    @default(now()) @map("created_at") @db.Timestamptz(6)

  account BillingAccount @relation(fields: [accountId], references: [id])

  @@index([accountId, createdAt])
  @@index([taskId])
  @@map("credit_ledger")
}
// Order: amount Decimal(12,2), kind SUBSCRIPTION | PACK | TOPUP, receipt fields.
```

CHECK-ограничения добавляем вручную в SQL миграции, Prisma их не описывает. Ночная сверка проверяет, что Σ записей журнала = `balance`, а Σ `token_usage` сходится с детализацией провайдеров.

## 5. ЮKassa и 54-ФЗ

- **Автоплатёж на каждое действие не советую.**
  - Комиссия процентная (2,8% за платёж + 1% за чек по business.md), так что дело не в ней.
  - Проблема в десятках мелких списаний: отказы банков и антифрод, чек на каждое, возврат на каждый `rolled_back`, асинхронные вебхуки на пути задачи.
  - Автоплатежи в боевом магазине включает менеджер ЮKassa.
- **Рекомендация.**
  - Пополнение кошелька с минимальной суммой, например 1 000 ₽.
  - По желанию автопополнение с сохранённой карты при балансе ниже порога.
  - Один платёж покрывает много действий.
- **Чеки.**
  - По позиции ФНС предоплата — за конкретный товар или услугу, а аванс — это пополнение баланса без предмета расчёта.
  - В справочнике «Чеков от ЮKassa» есть только `full_prepayment` и `full_payment`. Там же сказано, что аванс, частичная предоплата и кредит не поддерживаются ([parameters](https://yookassa.ru/developers/payment-acceptance/receipts/54fz/yoomoney/parameters-values)).
  - Чек зачёта: `POST /v3/receipts`, `type: payment`, позиции с `full_payment`, `settlements: [{type: prepayment}]`.
  - Коды НДС с 2026 года: 11 = 22%, 12 = 22/122. Расчётная ставка обычно нужна для предоплаты.
- **Варианты для кошелька**, выбирает бухгалтер:
  - (а) Онлайн-касса с поддержкой `advance` (АТОЛ Онлайн, Orange Data), подключённая к ЮKassa. Чек зачёта — на каждое действие или сводный за период.
  - (б) «Чеки от ЮKassa» с `full_prepayment` на услугу «правки сайта» и последующие чеки зачёта.
  - Сама ЮKassa пишет, что чек зачёта нужен при предоплате «за товары». Про услуги это нужно подтвердить у бухгалтера. **Не решено.**

## Что придётся обновить в документах

Файлы я не менял. Новое решение противоречит:

- CLAUDE.md, правило 9: «Деньги — целые копейки».
- spec §16: `llm_models`, «цена за 1 млн токенов в копейках».
- spec §17: тарифы, формула — добавить `cacheWrite` и тариф с оплатой за действие.
- roadmap B4 («цены в копейках») и M5.
- business.md §6: новый тариф.

## Открытые вопросы владельцу

1. **«Действие» — это задача (правка), как в квотах, или каждый ход?** Предлагаю задачу.
2. **Показываем клиенту только рубли** (оценку до старта и итог) без слова «токены», по правилу 10? Нужен ли потолок с подтверждением?
3. **Наценка, фикса за действие, минимум и размер резерва** по классам моделей. Будет ли у «Агентства» наценка ниже?
4. **Платит ли клиент за `rolled_back`?** Предлагаю нет, как за `failed`. Сейчас правило 7 про этот статус молчит.
5. **Нужен ли на тарифах с квотой лимит себестоимости одной правки?** Например, правка дороже X ₽ считается за две или идёт к оператору.
6. **Можно ли после исчерпания квоты платить из кошелька** вместо пакета из 10 правок или вместе с ним?
7. **Налоговый режим** (ОСНО с НДС 22% или УСН) — от него зависят `vat_code` в чеке и учёт входящего НДС. Храним цены провайдеров с НДС и ставкой, как предложено?
8. **54-ФЗ:** касса с `advance` или «Чеки от ЮKassa» с `full_prepayment`, чек зачёта на действие или за период. Решает бухгалтер.
9. **Сгорает ли остаток кошелька и пакетов?** Как возвращаем неиспользованный аванс? Для физлиц действует закон о защите прав потребителей.
10. **Минимальное пополнение и порог автопополнения.**
11. **Подписи USD в интерфейсе LiteLLM при рублёвых числах — приемлемо?** Альтернатива — задавать бюджет только в токенах через `tpm`-лимиты.

## Источники

- Codex: https://learn.chatgpt.com/docs/non-interactive-mode, https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/exec/src/exec_events.rs
- Kimi: https://moonshotai.github.io/kimi-cli/en/customization/wire-mode.html, https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html
- Qwen Code: https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/
- OpenCode: https://takopi.dev/reference/runners/opencode/stream-json-cheatsheet/, https://github.com/anomalyco/opencode/issues/26855
- LiteLLM:
  - https://docs.litellm.ai/docs/proxy/custom_pricing
  - https://docs.litellm.ai/docs/proxy/virtual_keys
  - https://docs.litellm.ai/docs/proxy/cost_tracking
  - https://docs.litellm.ai/docs/proxy/logging_spec
  - https://docs.litellm.ai/docs/observability/generic_api
  - https://docs.litellm.ai/docs/completion/prompt_caching
  - https://raw.githubusercontent.com/BerriAI/litellm/main/schema.prisma
  - Issues: https://github.com/BerriAI/litellm/issues/27191, https://github.com/BerriAI/litellm/issues/26806, https://github.com/BerriAI/litellm/issues/30460, https://github.com/BerriAI/litellm/issues/33325
- Yandex AI Studio: https://aistudio.yandex.ru/docs/ru/ai-studio/pricing.html
- Cloud.ru: https://cloud.ru/documents/tariffs/evolution/foundation-models, https://cloud.ru/products/evolution-ai-factory/catalog-foundation-models, https://cloud.ru/docs/foundation-models/ug/topics/pricing
- Prisma: https://www.prisma.io/docs/orm/v7/prisma-client/special-fields-and-types, https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql, https://github.com/prisma/orm/discussions/19983
- tRPC и superjson: https://trpc.io/docs/server/data-transformers, https://github.com/icflorescu/trpc-transformer
- PostgreSQL: https://www.postgresql.org/docs/17/functions-math.html
- decimal.js: https://mikemcl.github.io/decimal.js/
- ЮKassa: https://yookassa.ru/developers/payment-acceptance/receipts/54fz/yoomoney/parameters-values, https://yookassa.ru/developers/payment-acceptance/receipts/54fz/yoomoney/payments, https://yookassa.ru/developers/payment-acceptance/receipts/54fz/other-services/payments
- 54-ФЗ: https://www.garant.ru/news/1137877/

Файлы в репозитории: docs/business.md, docs/spec.md, docs/plan/roadmap.md, CLAUDE.md; для сравнения — ../AnyNote/packages/db/prisma/schema.prisma.