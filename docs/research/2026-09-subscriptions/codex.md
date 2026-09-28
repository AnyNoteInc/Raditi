# Codex CLI на подписке ChatGPT

Исследование от 28.09.2026 к этапу P3. Главный источник — исходники openai/codex на теге [`rust-v0.158.0`](https://github.com/openai/codex/releases/tag/rust-v0.158.0) (релиз 28.09.2026, коммит 064c6b8). Пути вида `login/src/server.rs:76` даны от `codex-rs/` на этом теге, полная ссылка — `https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/<путь>#L…`. Для сравнения смотрели LiteLLM `v1.103.0` (28.09.2026). Все ссылки проверены 28.09.2026.

Итоговые решения — в [p3-design.md](p3-design.md), `CLAUDE.md` и `docs/spec.md`. Где заметка с ними расходится, верны решения; расхождения собраны в конце.

## Коротко

- **Токен подписки можно не пускать в песочницу.** Свой провайдер Codex с `requires_openai_auth = false` берёт ключ хода из переменной окружения, а доверенный шлюз подставляет токен подписки (схема A). Примет ли бэкенд такой запрос, не проверено — это первая задача разведки P3.0.
- **Refresh-токен одноразовый.** Повторное предъявление отзывает доступ у всех клиентов аккаунта. У каждого аккаунта должен быть ровно один процесс, который обновляет токены.
- **`max_output_tokens` бэкенд подписки отклоняет.** Потолок попытки держит сам шлюз по накопленному расходу.
- **Расход** приходит в `response.completed.response.usage` потока SSE.
- **Россия не входит в список стран ChatGPT.** Выход к `chatgpt.com` и `auth.openai.com` — только через узел в поддерживаемой стране.
- **Условия OpenAI** запрещают передавать аккаунт и использовать ChatGPT «to power third-party services». Это риск блокировки, владелец его принял.
- **Лимиты в числах не опубликованы:** ни недельные, ни на одновременные запросы.

## 1. Вход и `auth.json`

- **Вход через браузер.** OAuth с PKCE на `https://auth.openai.com/oauth/authorize`, `client_id=app_EMoamEEZ73f0CkXaXp7hrann`, redirect на `http://127.0.0.1:1455/auth/callback`. Scope: `openid profile email offline_access api.connectors.read api.connectors.invoke`. Дополнительные параметры: `id_token_add_organizations`, `codex_cli_simplified_flow`, `originator`, `allowed_workspace_id` — `login/src/server.rs:76-77,193,592-613`, `login/src/auth/manager.rs:1717`.
- **Второй секрет в `auth.json`.** После входа Codex меняет `id_token` на токен вида API-ключа (token-exchange, `requested_token=openai-api-key`) и кладёт его в `auth.json` как `OPENAI_API_KEY` — `server.rs:440-447,1013-1045`. Секретов в файле два, а не один.
- **Вход по коду устройства.** `codex login --device-auth` → `auth.openai.com/api/accounts/deviceauth/usercode`, код вводится на `/codex/device` и живёт 15 минут — `login/src/device_code_auth.rs:68,108,155,166-175`. У личного аккаунта вход по коду сначала включают в настройках безопасности ChatGPT ([auth](https://learn.chatgpt.com/docs/auth)).
- **Другие режимы входа:**
  - API-ключ — `--with-api-key`;
  - Codex access token `at-…` — `--with-access-token` или переменная `CODEX_ACCESS_TOKEN`, проверка через `auth.openai.com/api/accounts/v1/user-auth-credential/whoami` (`login/src/auth/personal_access_token.rs:11-13`, `login/src/auth/access_token.rs`). Только для Business и Enterprise, срок 7–90 дней ([access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)). Личным подпискам не подходит;
  - режим `chatgptAuthTokens` в app-server помечен в коде «FOR OPENAI INTERNAL USE ONLY» — `app-server-protocol/src/protocol/v2/account.rs:85-101`.
- **Формат `auth.json`** — `login/src/auth/storage.rs:39-65`, `login/src/token_data.rs:10-42,71-99`:
  - `{auth_mode, OPENAI_API_KEY, tokens:{id_token, access_token, refresh_token, account_id}, last_refresh}`;
  - в `id_token`, в пространстве `https://api.openai.com/auth`, лежат `chatgpt_plan_type`, `chatgpt_user_id`, `chatgpt_account_id`;
  - где хранить, задаёт `cli_auth_credentials_store`: `file`, `keyring`, `auto` или `ephemeral`.

## 2. Время жизни и обновление токенов

- **Когда Codex обновляет токены:** до истечения `exp` у access-токена меньше 5 минут. Если `exp` в токене нет — когда `last_refresh` старше 8 дней. На ответ 401 Codex сначала перечитывает файл с диска, потом обновляет — `manager.rs:203-204,2390-2407,2844-2880,3004-3026`.
- **Как обновляет.** `POST https://auth.openai.com/oauth/token`, JSON `{grant_type:"refresh_token", client_id, refresh_token}`. В ответе `id_token`, `access_token` и `refresh_token` (каждый может отсутствовать), всё записывается обратно в `auth.json` — `login/src/oauth/client.rs:76-88`, `manager.rs:1598-1622,1710-1714`. Адрес переопределяет `CODEX_REFRESH_TOKEN_URL_OVERRIDE` (`manager.rs:214`).
- **Refresh-токен ротируется и одноразовый.** Бэкенд различает коды `refresh_token_expired`, `refresh_token_reused` и `refresh_token_invalidated` — `manager.rs:1679-1706`.
  - Документация: «Do not share the same file across concurrent jobs or multiple machines… one auth.json per runner» ([CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth)).
  - По отчёту пользователя [openai/codex-plugin-cc#789](https://github.com/openai/codex-plugin-cc/issues/789) (27.09.2026), повторное использование refresh-токена отзывает доступ у всех клиентов до нового входа.
  - Вывод для пула: у аккаунта — ровно один процесс, который обновляет токены.
- **Сроки жизни:**
  - access-токен живёт около 10 дней по отчётам пользователей; документация говорит только «about 8 days»;
  - сроки refresh-токена и `id_token` **неизвестны**.
- **Отзыв.** При `codex logout` Codex отзывает токены: `POST https://auth.openai.com/oauth/revoke` — `login/src/auth/revoke.rs:55-66`, `manager.rs:213`.

## 3. Бэкенд и формат запроса

- **Адрес.** База — `https://chatgpt.com/backend-api/codex` (`model-provider-info/src/lib.rs:77,414-432`), запрос — `POST {base}/responses` с SSE.
  - Встроенный провайдер по умолчанию ходит по WebSocket (`lib.rs:548`, `core/src/client.rs:1033-1041`) и переходит на HTTP, только исчерпав повторы (`client.rs:2274-2284`).
  - В этом режиме тело сжимается zstd: флаг `enable_request_compression` включён по умолчанию (`features/src/lib.rs:1272-1276`, `client.rs:1627-1636`).
- **Заголовки:**
  - `Authorization: Bearer <access_token>` и `ChatGPT-Account-ID` — `model-provider/src/bearer_auth_provider.rs:31-46`;
  - `originator` (`codex_cli_rs`, у `exec` — `codex_exec`) и `User-Agent` — `login/src/auth/default_client.rs:42,456-460`, `exec/src/lib.rs:260`;
  - `session-id`, `thread-id`, `x-client-request-id`, `x-openai-subagent` — `codex-api/src/requests/headers.rs:5-14`, `codex-api/src/endpoint/responses.rs:86-93`;
  - `x-codex-installation-id`, `x-codex-window-id`, `x-codex-turn-metadata`, `x-codex-routing-hint`, `x-codex-turn-state` (липкая маршрутизация, приходит в ответе) — `client.rs:160-178`;
  - `installation_id` хранится в `$CODEX_HOME/installation_id`: каждый новый контейнер даёт новый id.
- **Тело:** `model, instructions, input, tools, tool_choice, parallel_tool_calls, reasoning, store:false, stream:true, include:["reasoning.encrypted_content"], service_tier, prompt_cache_key, text, client_metadata` — `client.rs:999-1016`.
  - `max_output_tokens` Codex не шлёт.
  - По документации LiteLLM, бэкенд подписки **отклоняет** `max_output_tokens` и `metadata` ([LiteLLM, провайдер chatgpt](https://docs.litellm.ai/docs/providers/chatgpt)).
- **Другие адреса:**
  - `GET {base}/models?client_version=…`;
  - `GET https://chatgpt.com/backend-api/wham/usage` — лимиты аккаунта без расхода токенов (`backend-client/src/client/rate_limit_resets.rs:127`);
  - `chatgpt_base_url` по умолчанию — `https://chatgpt.com/backend-api/` (`core/src/config/mod.rs:4394`).

## 4. Как не пустить токен подписки в песочницу

- **Настройки Codex:**
  - `openai_base_url` переопределяет адрес встроенного провайдера, `chatgpt_base_url` — адрес ChatGPT (`config/src/config_toml.rs:408-409,423-424`);
  - у `model_providers.<id>` есть `base_url, env_key, wire_api, http_headers, env_http_headers, requires_openai_auth, supports_websockets, auth{command}, model_catalog_url` (`lib.rs:135-196`);
  - эти ключи запрещены в конфиге проекта (`config/src/loader/mod.rs:85-91`): репозиторий в песочнице не может перенаправить трафик;
  - переменную `OPENAI_BASE_URL` ядро Codex не читает.
- **`requires_openai_auth = true`** значит, что токен берётся из `auth.json` (`lib.rs:183-188`) — ровно то, что уносит подписку в песочницу. Нам нужно `false`.
- **Схема A (рекомендуется).** Свой провайдер: ключ хода вместо подписки, без WebSocket:

  ```toml
  model_provider = "raditi"
  [model_providers.raditi]
  name = "Raditi"
  base_url = "http://sandbox-gw:8080/codex"
  wire_api = "responses"
  env_key = "RADITI_LLM_TOKEN"   # ключ хода, а не подписка
  requires_openai_auth = false
  supports_websockets = false
  ```

  - Доверенный шлюз проверяет ключ хода, выбирает аккаунт, заменяет `Authorization`, добавляет `ChatGPT-Account-ID` и пересылает запрос на `chatgpt.com/backend-api/codex/responses`. Остальные заголовки и `x-codex-turn-state` проходят насквозь.
  - Режим «codex backend» (`client.rs:1124-1133`) при этом выключен: нет WebSocket, zstd и побочных вызовов ChatGPT. Тело остаётся в формате Responses.
  - Примет ли бэкенд такой запрос, **не проверено**. Косвенный довод «да»: LiteLLM ходит туда с минимальным набором заголовков (`common_utils.py:228-245`). Нужна проверка на настоящем аккаунте, отдельно — `GET /models`.
- **Схема B.** Встроенный провайдер, `openai_base_url=http://sandbox-gw/backend-api/codex` и поддельный `auth.json`. Даёт полное поведение codex backend: `supports_codex_backend_routes` срабатывает на адресе, который кончается на `/backend-api/codex` (`lib.rs:603-610`). Но придётся проксировать WebSocket, распаковывать zstd для учёта, гасить собственное обновление токенов Codex и закрывать побочные вызовы к ChatGPT. Схема хрупкая.
- **Не подходят:** официальный `codex-responses-api-proxy` (только статический API-ключ, без заголовка аккаунта) и режим `chatgptAuthTokens`.

## 5. Лимиты по планам

- **Цены планов:** Plus — $20, Pro — $100 (5x) и $200 (20x), Business — $25 в месяц ($20 при годовой оплате) ([pricing](https://learn.chatgpt.com/docs/pricing)). Новые подписки Pro $200 приостановлены с 10.09.2026 ([Pro](https://help.openai.com/en/articles/9793128)).
- **Оценка «локальных сообщений за 5 часов» на Plus и Business:**

  | Модель | Сообщений за 5 часов |
  | --- | --- |
  | GPT-6 Astra | 5–45 |
  | GPT-6 Sol | 15–150 |
  | GPT-6 Luna | 350–3000 |
  | GPT-5.6 Luna | 250–2000 |

  - У Pro — примерно в 5 и 20 раз больше.
  - О неделе сказано только «Weekly limits may also apply» — **чисел нет**.
  - Codex делит одну квоту с ChatGPT Work, Excel, PowerPoint и Word.
  - После лимита тратятся кредиты; тарифы в кредитах за 1 млн токенов — в [rate card](https://help.openai.com/en/articles/20001106-codex-rate-card). Fast mode для GPT-6 в 2,5 раза дороже.
- **Как бэкенд сообщает остаток:**
  - заголовки `x-codex-primary-{used-percent,window-minutes,reset-at}`, `x-codex-secondary-*`, отдельные семейства `x-codex-<limit>-*` с `-limit-name`, `x-codex-credits-{has-credits,unlimited,balance}`, `x-codex-active-limit`, `x-codex-rate-limit-reached-type` — `codex-api/src/rate_limits.rs:57-99,181-222`;
  - по WebSocket — событие `codex.rate_limits` (`rate_limits.rs:135-165`);
  - окна длиной 300 и 10 080 минут (видно в тестах TUI).
- **Ошибки** (`codex-api/src/api_bridge.rs:99-115,179-230`):
  - 429 с `error.type=usage_limit_reached`, `plan_type` и `resets_at`;
  - `usage_not_included`, `insufficient_quota`;
  - 503 `server_is_overloaded` или `slow_down`.

## 6. Сколько запросов одновременно выдерживает аккаунт

- В документации ничего нет. Поддержка OpenAI в тикете подтвердила, что «no per-plan concurrency limit is documented» и что подагенты входят в тот же лимит.
- По отчётам пользователей, с 29.08.2026 на Pro больше 2–3 одновременных потоков дают 429 «exceeded retry limit» во всех сессиях аккаунта ([#42685](https://github.com/openai/codex/issues/42685) → [#41702](https://github.com/openai/codex/issues/41702)).
- Предел нужно измерить на настоящем аккаунте.

## 7. Учёт токенов на шлюзе

- **Источник.** В `response.completed` приходит `response.usage`: `input_tokens`, `input_tokens_details.{cached_tokens,cache_write_tokens}`, `output_tokens`, `output_tokens_details.reasoning_tokens`, `total_tokens` — `codex-api/src/sse/responses.rs:130-167`. `usage` из вывода CLI для счёта не нужен.
- **Потолок попытки (135, 285 и 735 ₽) держит шлюз.** `max_output_tokens` бэкенд отклоняет, поэтому обрезать вывод нельзя: шлюз считает накопленный расход и отказывает следующему запросу.
- **Перевод токенов в ₽.** Токены × тариф в кредитах × цена кредита в ₽. Цену кредита для подписки задаёт владелец.
- **Аккаунт закрепляется за задачей.** Зашифрованные рассуждения привязаны к аккаунту: при смене аккаунта посреди сессии бэкенд отвечает «encrypted content … could not be verified» ([openai/codex#3942](https://github.com/openai/codex/issues/3942), [CLIProxyAPI#3189](https://github.com/router-for-me/CLIProxyAPI/issues/3189)). Если аккаунт исчерпан — ждать сброса окна или начинать новый тред.

## 8. География и выход в сеть

- **Страны.** России, Беларуси, Китая и Гонконга нет в [списке стран ChatGPT](https://help.openai.com/en/articles/7947663-chatgpt-supported-countries). Казахстан, Армения, Грузия и Сербия есть.
- **Последствия** ([неподдерживаемые страны](https://help.openai.com/en/articles/9131992-chatgpt-and-api-services-in-unsupported-countries-and-territories)):
  - «Accessing or offering access … from an unsupported country may result in your account being blocked or suspended»;
  - «Using payment methods outside … will result in you being blocked».
- **Как проверяют:**
  - по IP: в Codex есть сообщение о блокировке Cloudflare «connecting from a restricted region» (`api_bridge.rs:283`), `/oauth/token` отвечает 403 `unsupported_country_region_territory` ([#14215](https://github.com/openai/codex/issues/14215));
  - по стране карты — цитата выше;
  - учитываются ли телефон, разброс IP и адреса дата-центров — **неизвестно**.
- **Какой выход нужен.** Только доверенному шлюзу: `chatgpt.com:443` (SSE; для схемы B — ещё WSS) и `auth.openai.com:443`, через узел в поддерживаемой стране, желательно с постоянным IP на аккаунт. Песочнице внешний выход не нужен.

## 9. Условия использования

- [Terms of Use](https://openai.com/policies/row-terms-of-use/) действуют с 01.01.2026. Прямой запрос отвечает 403, текст взят из копии от 28.09.2026. Запрещено:
  - «share your account credentials or make your account available to anyone else»;
  - «lease, sell or distribute»;
  - «Automatically or programmatically extract data or Output»;
  - «circumvent any rate limits» — пул аккаунтов может под это подпасть;
  - OpenAI вправе заблокировать аккаунт при «risk or harm».
- Справка о Pro ([9793128](https://help.openai.com/en/articles/9793128)) прямо запрещает «Reselling access or using ChatGPT to power third-party services». Это и есть наша модель.
- **Обучение на данных.** На Plus и Pro разговоры идут в обучение, пока его не выключили в Data Controls ([Codex на плане ChatGPT](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)). Выключать на каждом аккаунте пула.
- **Против нас:** документация прямо называет API-ключ правильным способом для автоматизации.
- **В нашу пользу, но слабо:** представитель OpenAI около июня 2026 года разрешил пользоваться подпиской в сторонних оболочках. Источник вторичный ([manifest.build, 01.07.2026](https://manifest.build/blog/chatgpt-plus-tokens-third-party-harnesses/)), и речь о личном использовании, а не о перепродаже.

## 10. Готовые прокси

- **LiteLLM `v1.103.0`, провайдер `chatgpt/`.** Прозрачным прокси для Codex CLI не подходит:
  - один аккаунт на процесс (`CHATGPT_TOKEN_DIR`, `authenticator.py:44-49`);
  - дописывает свои инструкции в начало `instructions`;
  - пропускает только белый список полей и выбрасывает `text`, `prompt_cache_key` и `parallel_tool_calls` (`responses/transformation.py:79-106`). Без `text` ломается `--output-schema`.
- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** — MIT, Go, v8.0.3 от 28.09.2026, около 53 тыс. звёзд. Умеет Codex OAuth, раздачу запросов по кругу между аккаунтами и WebSocket. Но держит токены на своём диске (против правила 2), а спонсоры проекта — серые перепродавцы доступа.
- **[sub2api](https://github.com/Wei-Shaw/sub2api)** (около 43 тыс. звёзд) прямо сделан под совместное пользование подписками вскладчину.
- **Вывод:** тонкий свой шлюз, токены в Vault, один процесс, который их обновляет.

## 11. Что взять из проекта P3 на LiteLLM

Прежний проект — [p3-litellm-design.md](p3-litellm-design.md).

- **Оставить:**
  - белый список путей в `sandbox-gw`;
  - ключ хода в Vault и его отзыв;
  - прокси выхода `llm-egress` с CONNECT по белому списку — теперь к `chatgpt.com` и `auth.openai.com` через узел не в России;
  - в политике тела: `store:false`, `include`, замену `prompt_cache_key`, вырезание `service_tier` (иначе Fast mode тратит больше);
  - Decimal в `token_usage`.
- **Изменить:**
  - Codex идёт мимо LiteLLM;
  - подстановку `max_output_tokens` убрать — иначе 400;
  - аккаунт закрепляется за задачей;
  - потолок попытки считает сам шлюз;
  - рубли считаются через кредиты.

## Не проверено

Проверяет разведка P3.0 на настоящем аккаунте, остальное — P14:
- примет ли бэкенд запросы по схеме A и нужен ли `/models`;
- принимает ли бэкенд запрос без `client_metadata`;
- сроки жизни refresh-токена и `id_token`;
- недельные лимиты в числах и реальный предел одновременных потоков на аккаунт;
- как OpenAI сопоставляет аккаунты с IP, телефоном и множеством `installation_id`.

## Что в проекте решено иначе

- **Где подставлять токен.** Заметка говорит о шлюзе в `sandbox-gw` или `llm-ingress`. Решение — отдельная роль оркестратора `llm` на app-ВМ, одна реплика: `sandbox-gw` работает на песочной ВМ, где секретов платформы нет ([p3-design.md](p3-design.md) §2.2).
- **Одновременность.** Вместо «не больше 2 ходов на аккаунт» по умолчанию у Codex 1 ход и 2 запроса на аккаунт, на ключ хода — 2 запроса (§2.5, вопрос 15).
- **Рубли.** Вместо «цены кредита, которую задаёт владелец», — учётная ставка платформы в ₽ за 1 млн токенов: владелец выводит её из цены кредита и утверждает раз в квартал (§4.2).
- **Выход.** `llm-egress` переезжает на зарубежную ВМ `egress-1`: HTTPS CONNECT с mTLS и точным белым списком хостов (§3.7).

## Источники

Проверены 28.09.2026.

- Исходники: [openai/codex, тег `rust-v0.158.0`](https://github.com/openai/codex/tree/rust-v0.158.0/codex-rs), коммит 064c6b8.
- Документация Codex: [auth](https://learn.chatgpt.com/docs/auth), [CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth), [access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens), [pricing](https://learn.chatgpt.com/docs/pricing).
- Справка OpenAI: [rate card](https://help.openai.com/en/articles/20001106-codex-rate-card), [Pro, 9793128](https://help.openai.com/en/articles/9793128), [Codex на плане ChatGPT, 11369540](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan), [страны ChatGPT, 7947663](https://help.openai.com/en/articles/7947663-chatgpt-supported-countries), [неподдерживаемые страны, 9131992](https://help.openai.com/en/articles/9131992-chatgpt-and-api-services-in-unsupported-countries-and-territories).
- Условия: [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/) (действуют с 01.01.2026).
- Issues: [openai/codex#3942](https://github.com/openai/codex/issues/3942), [#14215](https://github.com/openai/codex/issues/14215), [#41702](https://github.com/openai/codex/issues/41702), [#42685](https://github.com/openai/codex/issues/42685) (с 29.08.2026), [openai/codex-plugin-cc#789](https://github.com/openai/codex-plugin-cc/issues/789) (27.09.2026), [CLIProxyAPI#3189](https://github.com/router-for-me/CLIProxyAPI/issues/3189).
- LiteLLM: [провайдер chatgpt](https://docs.litellm.ai/docs/providers/chatgpt), исходники `v1.103.0`.
- Прокси: [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (v8.0.3, 28.09.2026), [sub2api](https://github.com/Wei-Shaw/sub2api).
- Вторичный источник: [manifest.build о подписках в сторонних оболочках](https://manifest.build/blog/chatgpt-plus-tokens-third-party-harnesses/) (01.07.2026).
