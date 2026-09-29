# Разведка P3.0: записывающий проход

`record-proxy.mjs` — инструмент разведки P3.0 ([p3-design.md](../../../docs/research/2026-09-subscriptions/p3-design.md) §0.1, шаг 4; roadmap, P3). Разведка отвечает до кода шлюза на вопрос, принимает ли бэкенд ChatGPT схему A. Схема A — свой провайдер `raditi` в Codex CLI, `requires_openai_auth=false`, наш `Authorization` и `ChatGPT-Account-ID`.

Где и на чём:
- только на одноразовой ВМ `spike-1` у того же провайдера и в той же стране, что `egress-1`;
- только синтетические промпты и репозиторий;
- не на `egress-1` и не на ВМ платформы.

После разведки ВМ удаляется.

Это отдельный проход на синтетических данных: временный файл входа и очищенный журнал живут только на `spike-1` до уборки. Они не являются хранилищами платформы. Данные клиентов и рабочие токены платформы здесь не используются. Гейт P3.0 проверяется через `egress-1`; прямой запрос допустим только для сравнения при диагностике и не закрывает гейт.

## Что делает

CLI обращается к прокси с локальным ключом, как песочница — с ключом хода. Прокси подставляет токен подписки и отправляет запрос провайдеру. Заголовки и поля он обрабатывает так же, как шлюз (p3-design.md §3.4). Каждый обмен, в том числе отказанный, записывается в журнал.

| Путь на прокси | Куда | Кто вызывает |
| --- | --- | --- |
| `POST /codex/responses` | `https://chatgpt.com/backend-api/codex/responses` | Codex CLI |
| `GET /codex/models` | `https://chatgpt.com/backend-api/codex/models` | Codex CLI, если спросит |
| `GET /wham/usage` | `https://chatgpt.com/backend-api/wham/usage` | `curl`: лимиты без расхода токенов |
| `POST /kimi/v1/chat/completions` | `https://api.kimi.ai/coding/v1/chat/completions` | Kimi Code CLI |
| `GET /kimi/v1/usages`, `GET /kimi/v1/models` | `https://api.kimi.ai/coding/v1/…` | `curl` |

- **Остальное** — 403 и запись в журнал. Так видно, куда ещё ходит CLI. Например, `/disabled/…` — побочные вызовы ChatGPT через `chatgpt_base_url`.
- **Как шлюз:**
  - к провайдеру уходят только разрешённые заголовки клиента;
  - вырезаются `x-codex-turn-metadata`, `x-codex-window-id`, `x-codex-routing-hint`, а в теле — `client_metadata` и `service_tier`;
  - сжатое тело (gzip, br, deflate, zstd) распаковывается до удаления полей; размер после распаковки — не больше 16 МиБ, неизвестное или повреждённое сжатие отклоняется;
  - ставятся `Authorization`, `ChatGPT-Account-ID`, `accept: text/event-stream` и `accept-encoding: identity`;
  - назад уходят только `content-type`, `content-encoding`, `x-codex-turn-state` и `retry-after`.
- **Не как шлюз:**
  - `x-codex-installation-id` приходит от CLI, а шлюз поставит свой для аккаунта;
  - тело не проверяется;
  - бюджета и учёта нет;
  - `x-msh-*` от Kimi CLI проходят как есть: не больше 8, до 256 символов.
- **`RECORD_KEEP`** пропускает вырезанное по одному, например `RECORD_KEEP=client_metadata`. Так видно, без чего бэкенд не работает.
- **Журнал** — `RECORD_DIR/exchanges.jsonl` с правами 0600:
  - заголовки запроса и тело; значения `authorization`, `proxy-authorization`, `cookie`, `x-api-key` и `chatgpt-account-id` скрыты;
  - что ушло к провайдеру;
  - статус, заголовки ответа без `set-cookie`, события SSE.

  `encrypted_content` и data URL заменены длиной. Токены, id аккаунта, JWT и адреса почты заменены метками. В stdout — строка на обмен с usage, если он пришёл.
  Очистка известных токенов обоих настроенных аккаунтов работает и при отказе до маршрутизации (401/403); структурные поля токенов и аккаунтов заменяются метками независимо от их значения.
  Ответ записывается целиком только до 32 МиБ, в том числе после распаковки. Для большего или повреждённого ответа сохраняются статус, заголовки и отметка об ограничении или ошибке разбора; передача ответа CLI продолжается. Обрыв читателя прерывает запрос к провайдеру.
- **Выход** — прямо с `spike-1`. С `RECORD_EGRESS` — через `egress-1`, как у шлюза:
  - внутри mTLS идёт `CONNECT`, внутри туннеля — TLS до провайдера;
  - провайдер видит адрес узла, узел не видит токенов;
  - нужен каталог `RECORD_EGRESS_TLS_DIR` с `root.pem`, `client.pem` и `client-key.pem` — например, копии `op-1`;
  - адрес `spike-1` добавляется в `PROXY_CLIENTS` на `egress-1` на время разведки ([infra/egress/README.md](../../egress/README.md)).
  Установка соединения (TLS к узлу, CONNECT, TLS к провайдеру) ограничена 10 секундами.
- **Слушает** только `127.0.0.1` (`RECORD_PORT`, по умолчанию 8090). Без локального ключа — 401.

## Порядок

**0. До начала.**
- Поднята `egress-1`, выданы сертификаты клиента для `spike-1`, проверена проба канала из России по runbook узла.
- Куплен 1 аккаунт Codex Plus.
- В настройках безопасности ChatGPT включён вход по коду устройства.
- Пройден чек-лист аккаунта (spec §18): обучение выключено, кредитов нет.

**1. `spike-1`.**
- Ubuntu 24.04, Node 26.10 — как в [infra/egress/README.md](../../egress/README.md), шаг 3.
- `npm install -g @openai/codex@0.158.0`; если куплен Kimi — ещё `@moonshot-ai/kimi-code@2.1.1`.
- Из репозитория нужен только `record-proxy.mjs`.

**2. Вход Codex** — во временный `CODEX_HOME`, отдельный от того, где запускается CLI:

```sh
export LOGIN_HOME=$(mktemp -d)
CODEX_HOME=$LOGIN_HOME codex login --device-auth
RECORD_CODEX_AUTH=$LOGIN_HOME/auth.json node record-proxy.mjs inspect
```

`inspect` показывает срок жизни токена доступа и `chatgpt_plan_type`. Токены, id и почту он не печатает.

**3. Прокси** — в отдельном окне (`tmux`):

```sh
export LOGIN_HOME=/путь/из/шага/2
export RECORD_EGRESS=IP_УЗЛА_EGRESS_1
export RECORD_EGRESS_TLS_DIR=$HOME/egress-client
RECORD_CODEX_AUTH=$LOGIN_HOME/auth.json RECORD_DIR=$HOME/spike node record-proxy.mjs
# печатает: export RADITI_LLM_TOKEN=… KIMI_MODEL_API_KEY=…
```

В `RECORD_EGRESS_TLS_DIR` нужны `root.pem`, `client.pem`, `client-key.pem` из runbook. Если для диагностики убрали `RECORD_EGRESS`, повторите успешный сценарий через узел до закрытия P3.0.

**4. Codex на провайдере `raditi`.** Конфиг — из p3-design.md §3.6, адреса — на прокси, `auth.json` в этом `CODEX_HOME` нет:

```sh
export CODEX_HOME=$(mktemp -d)
cat >"$CODEX_HOME/config.toml" <<'EOF'
model = "gpt-6-sol"
model_provider = "raditi"
model_reasoning_effort = "medium"
check_for_update_on_startup = false
chatgpt_base_url = "http://127.0.0.1:8090/disabled/"
cli_auth_credentials_store = "ephemeral"
[analytics]
enabled = false
[model_providers.raditi]
name = "Raditi"
base_url = "http://127.0.0.1:8090/codex"
wire_api = "responses"
env_key = "RADITI_LLM_TOKEN"
requires_openai_auth = false
supports_websockets = false
EOF
export RADITI_LLM_TOKEN=…            # из вывода прокси
mkdir -p ~/work && cd ~/work && git init -q
codex exec "Создайте файл ok.txt со словом ок"
codex exec resume --last "Допишите в ok.txt слово готово"
```

Порядок флагов у `codex exec resume` в документации и SDK расходится (spec §21) — сверьтесь с `codex exec resume --help`.

**5. Что проверить** — вопросы разведки (roadmap P3.0, spec §21):

| Вопрос | Где смотреть |
| --- | --- |
| Принимает ли бэкенд схему A | `POST /codex/responses → 200` в stdout, `ok.txt` создан. 401 или 403 — схема A не принята, гейт «схема A» — стоп |
| Работает ли без `client_metadata` и `x-codex-turn-metadata` | По умолчанию они вырезаны. Если запрос не проходит — повторить с `RECORD_KEEP` по одному |
| Нужен ли `/codex/models` | Есть ли в журнале `GET /codex/models` и что ответил бэкенд |
| usage в потоке, форма `response.failed` | Событие `response.completed` с `usage` в `response.events`; `response.failed` — если встретится |
| Форма 429 и 503 | Только если встретятся сами. Выбивать лимит нарочно нельзя: это похоже на злоупотребление. Не встретились — форма из исходников Codex, проверка на настоящих лимитах в P14 |
| Заголовки `x-codex-*`, кредиты | `response.headers` в журнале, в том числе `x-codex-credits-*` |
| Срок токена доступа, `chatgpt_plan_type` | `inspect` из шага 2 |
| `/wham/usage` без расхода | `curl -s -H "Authorization: Bearer $RADITI_LLM_TOKEN" http://127.0.0.1:8090/wham/usage` дважды подряд: проценты окна не растут от самого вызова |
| Путь через `egress-1` | Повторить шаг 4 с `RECORD_EGRESS`: ответы те же, в журнале `egress-1` — `connect` к `chatgpt.com:443` |

**Kimi**, если подписка куплена:
- ключ из консоли Kimi Code — в файл с правами 0600, прокси запускается с `RECORD_KIMI_KEY_FILE`;
- переменные — из p3-design.md §3.6, адрес — на прокси:

```sh
export KIMI_CODE_HOME=$(mktemp -d) KIMI_MODEL_NAME=k3-256k KIMI_MODEL_PROVIDER_TYPE=kimi \
  KIMI_MODEL_BASE_URL=http://127.0.0.1:8090/kimi/v1 KIMI_MODEL_API_KEY=$RADITI_LLM_TOKEN \
  KIMI_DISABLE_TELEMETRY=1 KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_BUILTIN_PRODUCT_SKILLS=0
kimi -p "Создайте файл ok.txt со словом ок"
curl -s -H "Authorization: Bearer $RADITI_LLM_TOKEN" http://127.0.0.1:8090/kimi/v1/usages
```

Что проверить:
- usage в последнем чанке;
- входит ли reasoning в `completion_tokens`;
- `User-Agent` дошёл без изменений (`request.sent` в журнале);
- что отвечает `/usages`.

**Канал из России** проверяется отдельно, с машины владельца: [infra/egress/README.md](../../egress/README.md), шаг 5.

**6. Уборка:**

```sh
CODEX_HOME=$LOGIN_HOME codex logout        # отзывает токены
rm -rf "$LOGIN_HOME" "$CODEX_HOME" "$KIMI_CODE_HOME"
```

- Ключ Kimi удаляется в консоли.
- Журнал перед копированием с ВМ стоит просмотреть: `grep -c eyJ $HOME/spike/exchanges.jsonl` → `0`.
- Затем ВМ `spike-1` удаляется, а адрес `spike-1` убирается из `PROXY_CLIENTS` на `egress-1`.

**7. Итог** — `docs/research/2026-09-subscriptions/spike.md` (коммит A8). В нём только формы: статусы, типы событий, имена заголовков, поля usage, срок токена. Без id, токенов и содержимого.

## Проверки

`pnpm test:infra` запускает `record-proxy.test.mjs`. Он проверяет:
- подстановку токена, вырезанные заголовки и поля, `RECORD_KEEP`;
- удаление полей в gzip/zstd-запросах, отказы на неверное сжатие и превышение размера после распаковки;
- повреждённые и слишком большие сжатые ответы без остановки прокси, таймаут установки соединения;
- отказы без ключа, вне таблицы путей и с чужим `Host`;
- что в журнале нет секретов;
- Kimi, редирект и `inspect`;
- путь через настоящий `llm-egress.mjs` с синтетическим CA.
