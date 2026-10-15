# Поддельная ЮKassa для локальных стендов

`fake-yookassa.mjs` — синтетический сервер вместо `https://api.yookassa.ru/v3`: настоящего магазина нет, деньги не списываются. Его будут поднимать стенды биллинга (`pnpm verify:billing` и браузерные проверки — срезы M5.7a и M5.15 [плана](../../../docs/plan/37-billing-plan.md)) и тесты. Пока здесь только сам сервер и его тесты.

Сервер слушает только `127.0.0.1`, всё хранит в памяти и сам обращается только по адресу уведомлений, который тоже должен быть на loopback. Учётные данные никуда не пишутся: запросы запоминаются без заголовка `Authorization`, в stdout попадает одна строка готовности.

## Запуск

Из сценария стенда или теста:

```js
import { startFakeYookassa } from './fake-yookassa.mjs'

const fake = await startFakeYookassa({
  shopId: '123456',
  secretKey: 'test_synthetic-key',
  webhookUrl: 'http://127.0.0.1:3100/api/webhooks/yookassa', // необязательно
})
// fake.apiUrl — значение YOOKASSA_API_URL; fake.controlUrl — команды стенда; fake.close()
```

Отдельным процессом — магазин берётся из окружения, как у web и `core`, в аргументах ключа нет:

```sh
YOOKASSA_SHOP_ID=123456 YOOKASSA_SECRET_KEY=test_synthetic-key \
  node infra/dev/billing-verify/fake-yookassa.mjs --port 4010 \
  --webhook-url http://127.0.0.1:3000/api/webhooks/yookassa
```

Процесс печатает `{"ready":true,"port":4010}` и останавливается по SIGINT или SIGTERM. `--port 0` выбирает свободный порт, `--forwarded-for <адрес>` задаёт адрес отправителя уведомлений (по умолчанию `127.0.0.1`).

Web и роль `core` смотрят на подделку через четыре переменные (вне production; в production две последние отклоняются при старте):

```sh
YOOKASSA_SHOP_ID=123456
YOOKASSA_SECRET_KEY=test_synthetic-key
YOOKASSA_API_URL=http://127.0.0.1:4010/v3
YOOKASSA_WEBHOOK_ALLOWLIST=127.0.0.1
```

## API

Basic-аутентификация магазином и ключом, заданными при старте; иначе 401 `invalid_credentials`.

| Запрос | Что делает |
| --- | --- |
| `POST /v3/payments` с `confirmation` | Платёж `pending` со ссылкой на страницу подделки `/pay/{id}` |
| `POST /v3/payments` с `payment_method_id` | Списание сохранённым способом оплаты: сразу `succeeded` |
| `GET /v3/payments/{id}` | Текущее состояние платежа |
| `POST /v3/payment_methods` | Привязка без платежа (`bank_card` или `sbp`): `pending` со ссылкой на `/pay/{id}` |
| `GET /v3/payment_methods/{id}` | Текущее состояние способа оплаты |
| `POST /v3/refunds` | Возврат: сразу `succeeded`, не больше остатка платежа |
| `GET /v3/refunds/{id}` | Возврат |

- **`Idempotence-Key`** обязателен у каждого POST. Повтор ключа возвращает первый ответ — и отказ 400 тоже; в журнале запросов у повтора `replayed: true` и `sameRequest` — совпало ли тело. Ключи живут до команды `forget-idempotence-keys` (настоящая ЮKassa хранит их 24 часа).
- **Способ оплаты сохраняется**, только если платёж создан с `save_payment_method: true`. Его идентификатор равен идентификатору платежа, как в документации ЮKassa.
- **Строже настоящей ЮKassa, намеренно:** объект `receipt` отклоняется (продавец — самозанятая), `capture` должен быть `true`, подтверждение — только `redirect`.

## Страница оплаты

`GET /pay/{id}` — страница с кнопками «Оплатить» и «Отказаться» (у привязки — «Привязать» и «Отказаться»). Нажатие меняет статус и отправляет покупателя на `return_url` ответом 303 — как настоящая ЮKassa, при любом исходе; результат магазин узнаёт через API. «Отказаться» отменяет платёж с причиной `expired_on_confirmation`, привязку переводит в `inactive`.

## Уведомления

После смены статуса подделка один раз отправляет `{type: "notification", event, object}` на адрес уведомлений: `payment.succeeded`, `payment.canceled`, `payment_method.active`, `refund.succeeded`. Повторов нет. У запроса заголовок `X-Forwarded-For` с одним адресом: web берёт адрес отправителя только оттуда и без заголовка уведомление отклоняет.

## Команды стенда

`GET /__control/state` — платежи, способы оплаты, возвраты, очередь поведений и журнал доставки уведомлений. `GET /__control/requests` — принятые запросы API. Остальные команды — `POST /__control/<команда>` с JSON.

| Команда | Тело | Что делает |
| --- | --- | --- |
| `behaviour` | `{target, behaviour, reason?, party?, processed?, times?}` | Ставит поведение в очередь: его получит следующий платёж (`times` — несколько следующих) |
| `complete` | `{paymentId \| paymentMethodId, outcome?, reason?, party?}` | Завершает ожидающий платёж или привязку: `succeed` (по умолчанию) или `cancel` |
| `webhooks` | `{enabled}` | Отправлять уведомления или придерживать |
| `notify` | `{paymentId \| paymentMethodId \| refundId, forwardedFor?, event?, object?}` | Отправляет уведомление сейчас; `forwardedFor` — «с» другого адреса, `event` и `object` — поддельное тело |
| `save-anyway` | `{enabled}` | `payment_method.saved: true` у платежа с `save_payment_method: false` (покупатель сам поставил галочку на форме ЮKassa) |
| `card` | `{last4?, card_type?, first6?, expiry_month?, expiry_year?, issuer_country?}` | Карта следующих оплат и привязок |
| `forget-idempotence-keys` | `{}` | Забывает ключи идемпотентности |
| `settle` | `{}` | Отвечает, когда все отправленные уведомления доставлены или не удались |
| `reset` | `{}` | Стирает всё, кроме магазина и адреса уведомлений |

`target` у `behaviour`: `saved` (по умолчанию) — платежи с `payment_method_id`, `payment` — платежи со страницей оплаты.

| Поведение | Платёж сохранённым способом | Платёж со страницей |
| --- | --- | --- |
| `succeed` | Сразу `succeeded` (так и без команды) | «Оплатить» → `succeeded` (так и без команды) |
| `cancel` | Сразу `canceled` с `cancellation_details` (`reason`, по умолчанию `general_decline`; `party`, по умолчанию `payment_network`) | «Оплатить» → `canceled` с этой причиной |
| `stay-pending` | Остаётся `pending`, пока не придёт `complete` | «Оплатить» возвращает покупателя, платёж остаётся `pending` |
| `http-500-once` | Запрос выполнен, ответ — HTTP 500; повтор с тем же ключом возвращает созданный платёж | То же |
| `timeout` | Запрос выполнен, ответа нет; повтор с тем же ключом возвращает созданный платёж | То же |

С `processed: false` запрос `http-500-once` и `timeout` не выполняется вовсе: платёж не создаётся, ключ не запоминается.

## Чего нет

Списков платежей и возвратов, двухстадийной оплаты и отмены платежа через API, чеков, виджета и QR-кода, повторной доставки уведомлений, ограничений частоты. Возврат всегда успешен. Подделка не заменяет сверку с настоящим тестовым магазином перед подключением боевого.

## Файлы

- `fake-yookassa.mjs` — сервер;
- `fake-yookassa.test.mjs` — тесты (`pnpm test:infra`): ответы и уведомления проверяются настоящим клиентом и разбором уведомлений из `packages/yookassa`.
