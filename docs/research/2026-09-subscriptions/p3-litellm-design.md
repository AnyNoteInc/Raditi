# P3. LLM-шлюз: проектное решение, редакция 2

> **Заменён 28.09.2026; действуют §4.2–4.4.** Решение владельца от 28.09.2026 перевело доступ к моделям на подписки Codex и Kimi: LiteLLM, российские провайдеры моделей и GigaChat уходят. Новый проект — [p3-design.md](p3-design.md). Из этого документа в силе §4.2–4.4 (Vault `turns/`, `issue`, `recover` и `revoke`, окна сбоев и сборщик); что ещё берётся с поправками — p3-design.md §5.6. Остальное — история. Решением владельца от 30.09.2026 все подключения PostgreSQL используют одного `raditi`, владельца базы и схемы; описанные ниже отдельные роли и ACL не действуют. AppRole Vault и контракты §4.2–4.4 сохраняются. Текущий контракт — [spec.md, §16](../../spec.md#16-модель-данных), переход — [отчёт](../../plan/11-postgres-single-user.md).

Документ от 28.09.2026, ветка `codex/p3-llm-gateway`. Пути даны от корня репозитория на 28.09.2026.

Редакция 2 учитывает три ревью: безопасность (S1–S14), деньги (M1–M14) и эксплуатацию (O1–O17). Куда ушло каждое замечание — в разделе 19, отклонённые — в разделе 18. Утверждения о LiteLLM сверены с исходниками тега v1.103.0, об OpenBao — с `main`.

Требований с номером «A.15» в репозитории нет: искал в `docs`, `infra`, `apps` и `packages`, в том числе с кириллической «А». Требованиями к LiteLLM на app-ВМ считаю:
- `docs/spec.md:620-626`, `:1008-1009`, `:1025`;
- `docs/plan/roadmap.md:24`;
- `infra/app/docker-compose.yml:5`.

## 0. Решения коротко

1. **Версия.** `ghcr.io/berriai/litellm-non_root:v1.103.0@sha256:fda2894415d89350ca6a16195c935726382354d2194ebb1ce43e6bd5480b06ce` — в dev, в проверке и на app-ВМ.
   - Нижняя граница по advisories — 1.94.0.
   - 1.103.0 выбрана за исправления моста Responses (#36363, #41144, #41689), за `/key/info` для удалённых ключей (#41311) и за колонку `litellm_call_id` (#39068).
   - `request_id` есть и в 1.102.1, поэтому откат на 1.102.1 возможен, если ключом учёта сделать `request_id` (раздел 16).
   - Перед включением на app-ВМ (M10) — прогон под нагрузкой и переход на свежий патч 1.103.x, если он выйдет.
2. **Порт и адаптер.** Порт `LlmGateway` — в `packages/domain`. Деньги в нём — Decimal-строки, float LiteLLM переводится в Decimal на границе адаптера. Адаптер — новый пакет `@repo/llm-gateway`.
3. **Ключ хода.**
   - `core` генерирует значения `sk-rdt-…` и `rmcp_…`.
   - Запись: Vault (mount `turns/`, сначала данные с `cas=0`, потом метаданные) → `llm_keys` под fence аренды → LiteLLM `/key/generate`.
   - Отзыв: отметка `revoke_requested_at` → мягкое удаление в Vault → **`/key/block`** → `revoked_at` → уничтожение записи в Vault.
   - `/key/delete` вызывается только после закрытия учёта ключа.
   - Отзываем сразу, как только ключ больше не нужен агенту, и всегда до освобождения аренды. Повтор — раз в минуту.
4. **`recover`** возвращает ключ, только если его sha256 совпал с `llm_keys.key_hash`, ключ не отозван и `session_id` тот же.
5. **Бюджет — fail-closed.**
   - В `general_settings`: `fail_closed_budget_enforcement: true` и `disable_error_logs: false`.
   - У каждой модели в `model_info` заданы `max_input_tokens` и `max_output_tokens: 16384`.
   - Политика тела подставляет потолок вывода в каждый запрос, а запрос с потолком выше 16384 отклоняет.
   - Перерасход ключа — не больше ошибки оценки входа одного вызова. Недобор — не больше резерва одного вызова (раздел 4.1).
6. **Учёт — только опрос** `GET /spend/logs/v2`, без OFFSET: окна сужаются, пока ответ не станет меньше страницы.
   - Идемпотентность — по `litellm_call_id`. `request_id` хранится для сверки, повтор `call_id` с другим содержимым переводит ключ в `drift`.
   - У ключа есть конечное состояние учёта: `pending → synced | drift | lost`. Отклонённые строки попадают в карантин `token_usage_rejects`.
7. **Себестоимость** считает `core` в Decimal по `llm_model_prices`. Перед выдачей ключа `core` сверяет цены в LiteLLM с действующими ценами в базе; если они расходятся, ключ не выдаётся.
8. **Мост `/responses → chat`.**
   - Cloud.ru — `use_chat_completions_api: true`.
   - Yandex — Responses напрямую, `store:false` обязателен.
   - GigaChat в P3 не подключаем, это меняет `roadmap.md:24` (вопрос 4).
9. **Политика тела** — рекурсивная, общая для `sandbox-gw` и `llm-ingress`.
   - Белые списки полей, типов элементов `input` и частей сообщений.
   - Изображения — только `data:`.
   - Встроенные инструменты провайдеров запрещены.
   - Поля `client_metadata`, `service_tier` и `access_programs` вырезаются, `prompt_cache_key` заменяется значением от ключа хода.
10. **Выход LiteLLM в сеть.**
    - LiteLLM стоит только во внутренних сетях.
    - К провайдерам ходит через `llm-egress` — CONNECT-прокси с белым списком `ai.api.cloud.yandex.net:443` и `foundation-models.api.cloud.ru:443`.
    - У самого LiteLLM нет ни DNS внешних имён, ни маршрута наружу.
11. **Лимиты.**
    - `router_settings.disable_cooldowns: true` и `enforce_model_rate_limits`.
    - `upperbound_key_generate_params` равен `llmKeyLimits`.
    - LLM-запрос на `sandbox-gw` и `llm-ingress` длится не дольше 10 минут.
12. **app-ВМ.**
    - Сервисы `litellm`, `litellm-postgres`, `llm-ingress` и `llm-egress` стоят в профиле compose `llm`.
    - Профиль включается в M10, когда готовы vault-agent и DOCKER-USER. `preflight.sh` проверяет их при включённом профиле.
    - Секреты читает bash-цикл без `.`-исполнения файла.
    - `init: true`, `stop_grace_period: 90s`, миграции через `--use_v2_migration_resolver` и остановка при сбое миграции.
13. **Проверка без клиентских данных.**
    - `verify:llm-gateway` поднимает настоящий LiteLLM 1.103.0 в изолированном compose: внутренние сети, фейковый upstream, прокси выхода.
    - Шаг с настоящим Codex CLI (`codex exec` через `llm-ingress` и мост к фейку).
    - Сбои, отзыв во время потока, перезапуск LiteLLM, обрыв клиента.
    - Синтетическая проверка на реальных провайдерах запускает владелец — это условие закрытия P3 (вопрос 17).
14. **Сужение объёма.**
    - Служебные ключи (`purpose=service`) — M6.
    - Ночная сверка журнала — M5.
    - `turnBudgetOutcome` — P12.
    - В P3 остаются данные (`task_attempt`, состояние учёта) и формула бюджета в spec §17.

## 1. Границы этапа

| Что | Где |
| --- | --- |
| LiteLLM 1.103.0 в dev и в проверке, единый конфиг, мост для Cloud.ru, Yandex напрямую, явные цены в ₽, fail-closed бюджеты, лимиты | **P3** |
| `LlmGateway` и `@repo/llm-gateway` | **P3** |
| `TurnCredentialSource` поверх Vault `turns/` и LiteLLM: `issue` в супервизоре, ранний `revoke`, сборщик раз в минуту | **P3** |
| Клиент KV v2 в `@repo/vault` (mount `turns/`), политика `core`, mount в dev | **P3** |
| `llm_keys` (с `task_attempt` и состоянием учёта), `token_usage.key_id`, карантин, опрос журнала, себестоимость в Decimal, сверка со `spend` | **P3** |
| Рекурсивная политика тела в `sandbox-gw` и `llm-ingress`, CONNECT-прокси `llm-egress` | **P3** |
| Compose app-ВМ в профиле `llm`, секреты, preflight, права БД на таблицы учёта | **P3** пишет и тестирует; **M10** включает |
| `verify:llm-gateway` с фейком и Codex CLI, отчёт `docs/plan/05-p3-verification.md` | **P3** |
| Синтетическая проверка на реальных провайдерах: usage в потоке у Cloud.ru, CONNECT через прокси с настоящим TLS | **P3**, запускает владелец |
| Боевой конфиг Codex (`model_provider`, каталог моделей, ключ из файла), образ драйвера, ходы Codex на моделях | P4 |
| Kimi Code через `/v1/chat/completions`, новые поля в белом списке с тестами | P5 |
| Проверка токена MCP, его хеш для роли `mcp`, сверка эпохи | P6 |
| Остальной Vault: политики и AppRole в проде, SSH CA, wrapping, KV сайтов | P7 |
| `TurnSupervisor` и recovery в Nest; `task_turns` до `issue`; расчёт бюджета ключа по формуле §17; исчерпание бюджета → `awaiting_user`; снятие `credit_holds` | P12 |
| Какие поля теряет мост на настоящих провайдерах; gpt2giga | P14 |
| Списание при `done` только после закрытия учёта попытки; правила для `drift` и `lost`; «не выставлять» попытки, потерянные платформой (`spec.md:944`); ночная сверка журнала и детализации провайдеров | M5 |
| Служебные вызовы: схема ключей (`workspace_id`, ключ без задачи), кто платит за классификацию | M6 |
| Дашборды и алерты P3, Prometheus на app-ВМ | M9 |
| vault-agent, DOCKER-USER для `rd-llmout` и `rd-llmin`, зеркало образа, включение профиля `llm` | M10 |

## 2. Архитектура

### 2.1 Схема

```mermaid
flowchart LR
  subgraph sbx["Песочная ВМ"]
    agent["Контейнер хода<br/>CLI + ключ хода"] --> gw["sandbox-gw<br/>пути + политика тела"]
  end
  subgraph app["app-ВМ, профиль llm"]
    ing["llm-ingress<br/>APP_PRIVATE_IP:4000"]
    core["core<br/>issue, revoke, опрос журнала"]
    llm["LiteLLM 1.103.0<br/>non_root, read-only<br/>только internal-сети"]
    egr["llm-egress<br/>CONNECT, 2 хоста :443"]
    lpg[("litellm-postgres")]
    pg[("postgres платформы")]
  end
  vault["OpenBao<br/>mount turns/"]
  prov["Yandex AI Studio · Cloud.ru :443"]
  gw -->|POST /v1/responses, /v1/chat/completions| ing
  ing -->|llm-ingress, internal| llm
  core -->|llm-core, internal: /key/*, /spend/logs/v2, /model/info| llm
  llm -->|llm-data, internal| lpg
  llm -->|llm-egress, internal: HTTPS_PROXY| egr
  egr -->|rd-llmout: только :443 и DNS| prov
  core --> pg
  core --> vault
```

У LiteLLM нет ни одной сети с выходом наружу. Куда он может попасть:
- к провайдерам — только через `llm-egress`, который открывает туннель лишь к двум хостам из белого списка;
- к `core` по сети `llm-core`, где `:8081` публично отдаёт только `status`, а API раннеров `:8083` принимает токен ВМ только с адреса этой ВМ.

Этот риск принимаем. Взломанный LiteLLM не вынесет промпты ни через HTTP, ни через DNS: внешних имён во внутренней сети Docker не резолвит, это проверяет `verify`. Так закрыт класс S1, O7 и S2 даже до правил DOCKER-USER (M10).

### 2.2 LiteLLM: образ и настройки

- **Образ.** `litellm-non_root` работает под uid 65534. В нём есть bash, Python 3.13 и Prisma CLI в `/opt/prisma` ([Dockerfile.non_root](https://github.com/BerriAI/litellm/blob/v1.103.0/docker/Dockerfile.non_root)). Подпись проверяем так:
  `cosign verify --key https://raw.githubusercontent.com/BerriAI/litellm/0112e53046018d726492c814b3644b7d376029d0/cosign.pub ghcr.io/berriai/litellm-non_root@sha256:fda28944…`
- **Зеркало для app-ВМ** — `git.raditi.ru/mirror/litellm-non_root:v1.103.0@sha256:fda28944…`, копия через `crane copy`.
- **Процесс.** `--num_workers 1`: счётчики живут в памяти, Redis не нужен (`docs/spec.md:624`).
- **Миграции.** LiteLLM выполняет их сам при старте, в `LITELLM_MIGRATION_DIR` на tmpfs, с флагами `--use_v2_migration_resolver` и `ENFORCE_PRISMA_MIGRATION_CHECK=true`. Без этих флагов резолвер v1 применяет разницу схем напрямую, а при сбое миграции прокси всё равно стартует ([proxy_cli.py L1351-1385](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/proxy_cli.py#L1351-L1385)).
- **Остановка.**
  - `GRACEFUL_SHUTDOWN_TIMEOUT=60`, `stop_grace_period: 90s`, `init: true`. LiteLLM сбрасывает очередь журнала только после ожидания запросов (O5).
  - Смена образа — по runbook со сливом нагрузки (раздел 2.4).

`infra/app/litellm/config.yaml` — один конфиг для dev, проверки и app-ВМ. Ниже фрагмент, остальные модели — в разделе 7:

```yaml
model_list:
  - model_name: kimi-k2.6                      # = llm_models.slug
    litellm_params:
      model: openai/moonshotai/Kimi-K2.6       # only Cloud.ru's own models, case matters
      api_base: os.environ/CLOUDRU_API_BASE
      api_key: os.environ/CLOUDRU_API_KEY
      use_chat_completions_api: true           # /responses → chat bridge
      rpm: 240                                 # a real limit only with enforce_model_rate_limits
    model_info:                                # RUB incl. VAT per token = seed / 1e6, all five explicit
      input_cost_per_token: 0.00017568
      cache_read_input_token_cost: 0.00017568
      cache_creation_input_token_cost: 0.00017568
      output_cost_per_token: 0.0007259
      output_cost_per_reasoning_token: 0.0007259
      max_input_tokens: <context window from the Cloud.ru catalog>   # never an unknown reservation
      max_output_tokens: 16384                 # = llmKeyLimits.maxOutputTokens, enforced by the body policy
  - model_name: qwen3.6-35b
    litellm_params:
      model: os.environ/YANDEX_MODEL_QWEN3_6_35B
      api_base: os.environ/YANDEX_API_BASE
      api_key: os.environ/YANDEX_API_KEY
      extra_headers: { x-data-logging-enabled: 'false' }
      max_parallel_requests: 5                 # Yandex quota: 10 generations per cloud, 2 models; excess → 429 at once
    model_info: { … }
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL
  store_model_in_db: false
  store_prompts_in_spend_logs: false
  allow_client_side_credentials: false
  disable_error_logs: false                    # failure rows carry the partial cost of broken streams (M2)
  fail_closed_budget_enforcement: true         # an estimate that does not fit is refused, not shrunk (M1)
  proxy_batch_write_at: 5
  global_max_parallel_requests: 32
  maximum_spend_logs_retention_period: 45d
  maximum_spend_logs_retention_interval: 1d
router_settings:
  disable_cooldowns: true                      # one deployment per model: a cooldown only hurts (O13)
  optional_pre_call_checks: ['enforce_model_rate_limits']   # rpm/tpm as limits, not as parallelism (O6)
litellm_settings:
  drop_params: true
  turn_off_message_logging: true
  request_timeout: 600
  num_retries: 0
  callbacks: ['prometheus']
  prometheus_exclude_labels: [hashed_api_key, api_key_alias, user, user_email, user_alias,
                              end_user, team, team_alias, tag, client_ip, user_agent]
  upperbound_key_generate_params:              # == llmKeyLimits (config test)
    max_budget: 750
    duration: 20m
    max_parallel_requests: 2
    rpm_limit: 60
    tpm_limit: 4000000
```

Почему так:
- **`fail_closed_budget_enforcement`.** Без флага запрос, чья оценка не влезает в остаток бюджета, всё равно проходит: резерв урезается до остатка ([budget_reservation.py L122-158](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/spend_tracking/budget_reservation.py#L122-L158)). С флагом такой запрос отклоняется, и перерасход равен только ошибке оценки.
  - Оценка `/responses` считает одно поле `input`, без `instructions` и `tools` ([L1514-1539](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/spend_tracking/budget_reservation.py#L1514-L1539)).
  - Токенизатор общий, не тот, что у провайдера.
  - Итог для Kimi: около 10 ₽ на один вызов в худшем случае (20 тыс. токенов `instructions` и `tools` плюс 20% расхождения токенизатора на 200 тыс. входа). `verify` меряет это на фейке.
- **`max_output_tokens` в `model_info`** ограничивает только резерв, а не запрос к провайдеру ([L1563-1584](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/spend_tracking/budget_reservation.py#L1563-L1584)). Настоящий потолок ставит политика тела: подставляет `max_output_tokens` или `max_tokens`, равный 16384 (раздел 2.5).
- **`max_input_tokens`.** Если подсчёт входа не удался, LiteLLM берёт это значение, а не пропускает резерв ([L1542-1559](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/spend_tracking/budget_reservation.py#L1542-L1559)).
- **`disable_error_logs: false`.**
  - С `true` хук ошибок выходит раньше `update_database` ([proxy_track_cost_callback.py L155-161, L245-259](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/hooks/proxy_track_cost_callback.py#L155-L161)): оборванный поток не получает ни строки журнала, ни прироста `spend`.
  - CVE-2026-42208 закрыта версией не ниже 1.94.0.
  - Ввод в `error_information` LiteLLM вырезает (LIT-2992, там же L181-189). `verify` проверяет это сценарием «400 с эхом входа».
- **`rpm` у модели** без `enforce_model_rate_limits` превращается в `max_parallel_requests` ([utils.py L4993-5034](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/utils.py#L4993-L5034)).

Переменные среды LiteLLM (несекретные, `environment:`):

```yaml
LITELLM_MODE: PRODUCTION
LITELLM_LOG: ERROR
DISABLE_ADMIN_UI: 'True'
NO_DOCS: 'True'
NO_REDOC: 'True'
LITELLM_LOCAL_MODEL_COST_MAP: 'True'
LITELLM_MIGRATION_DIR: /app/migrations
ENFORCE_PRISMA_MIGRATION_CHECK: 'true'
GRACEFUL_SHUTDOWN_TIMEOUT: '60'
LITELLM_CORS_ORIGINS: https://cors.invalid   # never matches: no browser can call the gateway (S14)
HTTPS_PROXY: http://llm-egress:3128
HTTP_PROXY: http://llm-egress:3128
NO_PROXY: litellm-postgres,localhost,127.0.0.1
CLOUDRU_API_BASE: https://foundation-models.api.cloud.ru/v1
YANDEX_API_BASE: https://ai.api.cloud.yandex.net/v1
YANDEX_MODEL_QWEN3_6_35B: openai/gpt://${YANDEX_FOLDER_ID}/qwen3.6-35b-a3b/latest
YANDEX_MODEL_DEEPSEEK_V4_FLASH: openai/gpt://${YANDEX_FOLDER_ID}/deepseek-v4-flash/latest
```

`LITELLM_CORS_ORIGINS` разбирается в [proxy_server.py L1900-1904](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/proxy_server.py#L1900-L1904).

`os.environ/` подставляется в любые строковые `litellm_params`, в том числе в `model`. `verify` проверяет, что фейк получил `model: gpt://verifyfolder/qwen3.6-35b-a3b/latest`.

**Секреты.** `infra/app/litellm/entrypoint.sh` (bash, смонтирован только для чтения) построчно читает `/run/raditi/litellm.env`:

```bash
while IFS= read -r line || [ -n "$line" ]; do
  name=${line%%=*} value=${line#*=}
  case $name in
    LITELLM_MASTER_KEY|LITELLM_SALT_KEY|DATABASE_URL|YANDEX_API_KEY|CLOUDRU_API_KEY) export "$name=$value" ;;
    '') ;;
    *) echo "litellm.env: unexpected name" >&2; exit 64 ;;
  esac
done < /run/raditi/litellm.env
exec /app/docker/prod_entrypoint.sh "$@"
```

`export "$name=$value"` не раскрывает `$`, обратные кавычки и пробелы в значении (S11, O16). Тест `infra/app/litellm/entrypoint.test.mjs` запускает скрипт с такими значениями.

### 2.3 dev (`infra/dev`)

- **`litellm`** (сейчас `infra/dev/docker-compose.yml:144-167`, профиль `llm`):
  - non_root 1.103.0 по digest, `read_only`, tmpfs `/tmp`, `/app/.cache`, `/app/migrations`;
  - конфиг `../app/litellm/config.yaml:ro`, переменные раздела 2.2;
  - `LITELLM_SALT_KEY`;
  - сети: `llm` (internal: PostgreSQL и Prometheus) и `llm-egress` (internal, к прокси);
  - порт `${LITELLM_PUBLISH_ADDR:-127.0.0.1}:4000:4000` через отдельную сеть `llm-host`.
  - В dev LiteLLM сохраняет выход через `llm-host` — для песочниц в Colima и Lima (O16). Изоляцию проверяет изолированный стек `verify`, а не dev.
- **`llm-egress`** (профиль `llm`): образ шлюза песочницы (стадия `gateway` в `infra/sandbox/Dockerfile`), `LLM_EGRESS_ALLOW=ai.api.cloud.yandex.net:443,foundation-models.api.cloud.ru:443`. Через него же идёт синтетическая проверка владельца — так проверяется CONNECT с настоящим TLS.
- **`infra/dev/litellm.config.yaml` удаляется.**
- **`vault-init`** — одноразовый сервис на образе OpenBao 2.7.0:
  - `bao secrets enable -path=turns -version=2 kv` (повтор безопасен);
  - `bao write turns/config max_versions=1 cas_required=true delete_version_after=25m`;
  - `bao secrets enable transit`.
- **Песочница в dev:** `SANDBOX_LLM_UPSTREAM=http://host.docker.internal:4000` (Docker Desktop и OrbStack). В Linux-ВМ под `runsc` — адрес моста хоста ВМ и `LITELLM_PUBLISH_ADDR` на нём; путь описан в README.
- **Ключи провайдеров для dev** — в отдельном каталоге Yandex и отдельном проекте Cloud.ru, чтобы синтетические вызовы не смешивались со сверкой M5 (вопрос 19).

### 2.4 app-ВМ (`infra/app`, профиль `llm`)

| Сервис | uid | Сети | Порты | Секреты `/run/raditi/…` |
| --- | --- | --- | --- | --- |
| `litellm` | 65534 | `llm-core`, `llm-ingress`, `llm-data`, `llm-egress` — все internal | нет | `litellm/litellm.env` |
| `litellm-postgres` | 70 | `llm-data` | нет | `litellm-postgres/{superuser-password,litellm-password}` |
| `llm-ingress` | 10006 | `llm-edge` (`rd-llmin`), `llm-ingress` | `${APP_PRIVATE_IP}:${LLM_INGRESS_PUBLISH:-4000}:4000` | нет |
| `llm-egress` | 10007 | `llm-egress`, `llm-out` (`rd-llmout`) | нет | нет |
| `core` (правка) | 10002 | + `llm-core`; `LITELLM_URL=http://litellm:4000` | как было | `core/app.env` + `LITELLM_MASTER_KEY` |

```yaml
  litellm:
    <<: *hardened
    profiles: ['llm']
    image: ${LITELLM_IMAGE:?Set the digest-pinned LiteLLM image}
    user: '65534:65534'
    init: true
    stop_grace_period: 90s
    depends_on: { litellm-postgres: { condition: service_healthy }, llm-egress: { condition: service_started } }
    entrypoint: ['/bin/bash', '/etc/litellm/entrypoint.sh']
    command: ['--config', '/etc/litellm/config.yaml', '--port', '4000', '--num_workers', '1',
              '--prometheus_metrics_port', '4001', '--use_v2_migration_resolver']
    environment: { …раздел 2.2…, YANDEX_FOLDER_ID: '${YANDEX_FOLDER_ID:?Set YANDEX_FOLDER_ID}' }
    volumes:
      - { <<: *secrets, source: '${SECRETS_DIR:-/run/raditi}/litellm' }
      - ./litellm/config.yaml:/etc/litellm/config.yaml:ro
      - ./litellm/entrypoint.sh:/etc/litellm/entrypoint.sh:ro
    tmpfs: ['/tmp:size=64m,uid=65534,gid=65534,mode=0700', '/app/.cache:size=64m,uid=65534,gid=65534,mode=0700',
            '/app/migrations:size=32m,uid=65534,gid=65534,mode=0700']
    healthcheck:
      test: ['CMD', 'python', '-c', "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4000/health/liveliness', timeout=3)"]
    cpus: 1
    mem_limit: 2g
    pids_limit: 512
    networks: [llm-core, llm-ingress, llm-data, llm-egress]

  llm-egress:
    <<: *hardened
    profiles: ['llm']
    image: ${LLM_GATEWAY_IMAGE:?Set the digest-pinned gateway image}
    user: '10007:10007'
    command: ['node', '/app/llm-egress.mjs']
    environment:
      LLM_EGRESS_ALLOW: ai.api.cloud.yandex.net:443,foundation-models.api.cloud.ru:443
    networks: [llm-egress, llm-out]

networks:
  llm-core: { internal: true }      # core → LiteLLM: /key/*, /spend/logs/v2, /model/info, /health/readiness
  llm-ingress: { internal: true }   # llm-ingress → LiteLLM: two model paths
  llm-data: { internal: true }      # LiteLLM ↔ litellm-postgres
  llm-egress: { internal: true }    # LiteLLM → llm-egress:3128 only
  llm-out:                          # only llm-egress; DOCKER-USER: new connections only to :443 and the cloud resolver
    driver_opts: { com.docker.network.bridge.name: '${BRIDGE_PREFIX:-rd}-llmout' }
  llm-edge:                         # only llm-ingress: publishes 4000 on APP_PRIVATE_IP; no new outbound connections
    driver_opts: { com.docker.network.bridge.name: '${BRIDGE_PREFIX:-rd}-llmin' }
```

- **`volume-init`:** `chown 70:70 /v/litellm-pgdata && chmod 0700 /v/litellm-pgdata`. Том `${VOLUME_PREFIX}-litellm-pgdata` — external.
- **`litellm/postgres-init.sh`** устроен как `infra/app/postgres/init-roles.sh:8-39`: роль `litellm` владеет базой, у суперпользователя нет пароля по сети, CONNECT для PUBLIC отозван.
- **`preflight.sh`** проверяет всё ниже, если в `.env` в `COMPOSE_PROFILES` есть `llm` (S2, S11, O16):
  - `check_secrets litellm 65534 litellm.env` и `check_secrets litellm-postgres 70 superuser-password litellm-password` — рядом с `:65-69`;
  - том `litellm-pgdata` — в цикле `:78`;
  - `LITELLM_IMAGE` и `LLM_GATEWAY_IMAGE` по digest — в `:99`;
  - `iptables -S DOCKER-USER` содержит правила для `-i rd-llmout` и `-i rd-llmin`;
  - `LLM_EGRESS_ALLOW_HTTP` не задан, в `LLM_INGRESS_CLIENTS` нет `0.0.0.0/0`.
- **Правила DOCKER-USER** (текст — в README и spec §19, применяет M10):
  - `rd-llmout`: первым правилом пропускаются ответы; новые соединения — только TCP 443 и DNS 53 до резолвера облака; метаданные, частные сети, Vault и Gitea закрыты;
  - `rd-llmin`: новых исходящих соединений нет;
  - группа безопасности открывает 4000 только подсети песочных ВМ.
- **Runbook смены образа или конфига LiteLLM** (O5, M11):
  1. остановить выдачу ключей: до P12 ходов на app-ВМ нет, с P12 — пауза очереди ходов;
  2. дождаться, пока у всех `llm_keys` `usage_state` выйдет из `pending`;
  3. `pg_dump` базы `litellm`;
  4. сменить digest или конфиг;
  5. запустить синтетическую проверку;
  6. снять паузу.

  При смене цены новая строка `llm_model_prices` и новый `config.yaml` выкладываются в одно окно. Пока они расходятся, `core` не выдаёт ключи этой модели (раздел 4.3, шаг 0).
- **Резервные копии.** База LiteLLM — только дамп по runbook. Учёт после синхронизации живёт в `token_usage`.

### 2.5 Политика тела запроса

`infra/sandbox/llm-request-policy.mjs` — чистая функция без зависимостей:

`normalizeLlmRequest(path, body: Buffer, { bearer, maxOutputTokens }) → { ok: true, body: Buffer, model } | { ok: false, status: 400, field }`

Её используют `infra/sandbox/gateway.mjs` (только LLM-маршруты; тело до 16 МиБ читается в буфер, сейчас оно идёт потоком, `:89`) и `infra/sandbox/llm-ingress.mjs`. Функция идемпотентна: второй проход ничего не меняет.

**Общие правила:**
- Только `POST` на точные пути `/v1/responses` и `/v1/chat/completions`, `content-type: application/json`, JSON-объект в UTF-8.
- Неизвестное поле на любом уровне — 400. В `field` попадает путь вида `input[].content[].type`; имена вне словаря политики пишутся как `unknown`, путь не длиннее 64 символов (S12).

**`/v1/responses`:**

| Поле | Правило |
| --- | --- |
| `model`, `instructions`, `tool_choice`, `parallel_tool_calls`, `stream`, `temperature`, `top_p`, `truncation` | пропускаются |
| `store` | **обязательно `false`** (S7, O12) |
| `stream_options` | только `include_usage`, `include_obfuscation` |
| `include` | только `reasoning.encrypted_content` |
| `reasoning` | только `effort`, `summary` |
| `text` | `format` (`text`, `json_schema`, `json_object`), `verbosity` |
| `max_output_tokens` | нет — подставляется 16384; больше 16384 — 400 (M1, O3) |
| `prompt_cache_key` | заменяется на `rdt_` + первые 32 hex от sha256 значения `Authorization`: кэш не общий для клиентов (S13) |
| `client_metadata`, `service_tier`, `access_programs` | вырезаются молча: их всегда шлёт Codex ([common.rs](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/common.rs), O11) |
| `tools[].type` | `function`, `custom`, `namespace` (внутри только `function`) |
| `input` | строка или массив элементов: `message` (или элемент без `type`, но с `role`), `reasoning`, `function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output` |
| части `content` и `output` | `input_text`, `output_text`, `refusal`, `summary_text`, `input_image` — только если `image_url` начинается с `data:image/(png\|jpeg\|webp\|gif);base64,` |
| запрещено | `input_file`, `file_id`, `file_url`, `input_audio`, `item_reference`, `previous_response_id`, `conversation`, `background`, `prompt`, `metadata`, `user`, `api_base`, `base_url`, `api_key`, `extra_*`, `litellm_*`, `mock_response`, `fallbacks` |

**`/v1/chat/completions`:**

| Поле | Правило |
| --- | --- |
| `model`, `tool_choice`, `parallel_tool_calls`, `stream`, `temperature`, `top_p`, `response_format`, `reasoning_effort`, `stop`, `seed`, `presence_penalty`, `frequency_penalty` | пропускаются |
| `stream_options` | только `include_usage` |
| `n` | не больше 1 |
| `max_tokens`, `max_completion_tokens` | нет ни одного — подставляется `max_tokens: 16384`; больше — 400 |
| `messages[].role` | `system`, `developer`, `user`, `assistant`, `tool` |
| части `content` | `text` и `image_url` только с `data:`; у ассистента — `tool_calls[].type = function` и `reasoning_content` |
| `tools[].type` | `function` |
| запрещено | `store`, `user`, `metadata`, `audio`, `modalities`, `web_search_options`, `prediction` и всё, что не названо |

Так отсекаются:
- выход наружу по URL внутри тела: изображение по ссылке скачивает сам LiteLLM при подсчёте токенов ([token_counter.py L218-246, L695-704](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/litellm_core_utils/token_counter.py#L218-L246)) или провайдер через мост ([transformation.py L1607-1617](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/responses/litellm_completion_transformation/transformation.py#L1607-L1617));
- класс CVE-2026-84377;
- платные встроенные инструменты;
- хранение ответов у Yandex.

P4 и P5 добавляют поля своих CLI — каждое с тестом.

**Что `llm-ingress` проверяет сверх политики:**
- адрес источника входит в `LLM_INGRESS_CLIENTS` (CIDR-список; `userland-proxy: false`);
- `Host` равен `${APP_PRIVATE_IP}:4000`;
- вперёд уходят только `authorization`, `content-type` и `accept`, назад — только `content-type`. Любые `x-litellm-*`, включая `x-litellm-call-id`, не проходят: на этом держится уникальность `litellm_call_id` ([common_request_processing.py L246-249](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/common_request_processing.py#L246-L249)). Инвариант проверяют тесты обоих шлюзов (O10);
- без редиректов, `CONNECT` и `upgrade`;
- одновременно не больше 64 запросов, с одного адреса — не больше 16 (S12);
- LLM-запрос длится не больше 10 минут (O9). В `sandbox-gw` то же для LLM-маршрутов; у MCP остаются 20 минут (`gateway.mjs:49`).
- **Лог — JSON:** путь, код, модель (только slug из белого списка), отклонённое поле, `aborted` при обрыве клиентом. Тела нет.

### 2.6 Прокси выхода `llm-egress`

`infra/sandbox/llm-egress.mjs`, `node:net` без зависимостей, около 120 строк:
- **Какие запросы принимает.** Только `CONNECT host:port`, где пара есть в `LLM_EGRESS_ALLOW`. Остальное — 403 или 405.
- **Резолв.** Сам резолвит имя. Если хоть один адрес частный, loopback, link-local (включая 169.254.169.254) или CGNAT — отказ. Иначе туннель к первому публичному адресу.
- **Лимиты.** Не больше 64 туннелей, простой — 11 минут.
- **Лог.** Хост из белого списка, результат, длительность. Байтов нет.
- **Только для проверки** — `LLM_EGRESS_ALLOW_HTTP=fake-upstream:8080`: пересылка absolute-form HTTP к фейку. `compose.test.mjs` и `preflight.sh` запрещают эту переменную на app-ВМ.

Почему не Squid и не ipset:
- у провайдеров меняются адреса;
- Node уже есть в образе шлюза, а код проверяется тестами рядом с `gateway.mjs`.

Учитывает ли транспорт LiteLLM `HTTPS_PROXY` — проверка PoC: запрос через прокси с настоящим TLS выполняет синтетическая проверка владельца. В изолированной проверке этот вопрос закрыт иначе: без прокси у LiteLLM нет маршрута, и вызов просто не пройдёт. Если транспорт прокси не учитывает, запасной путь — `litellm_params.api_base` на локальный TLS-терминирующий прокси. Это решение владельца (раздел 16).

## 3. Порт `LlmGateway` и адаптер

`packages/domain/src/ports/llm-gateway.ts`:

```ts
/** Per-key limits; LiteLLM's upperbound_key_generate_params repeats them (config test). */
export const llmKeyLimits = Object.freeze({
  maxParallelRequests: 2,
  rpm: 60,
  /** Codex resends the whole history (store: false): 200k-token calls, several a minute. */
  tpm: 4_000_000,
  /** RUB of cost: the most one key may spend; ≥ the heavy attempt ceiling 735. */
  maxCostRub: '750.00',
  /** Below it a key is not worth issuing: P12 turns it into awaiting_user. */
  minCostRub: '1.00',
  minDurationS: 60,
  maxDurationS: 20 * 60,
  /** The body policy injects it and refuses more; model_info.max_output_tokens equals it. */
  maxOutputTokens: 16_384,
})

const decimalRub = z.string().regex(/^\d{1,8}(\.\d{1,10})?$/)

export interface LlmKeyRequest {
  /** sk-rdt-<base64url of 32 random bytes>, generated by core: a retry registers the same key. */
  key: string
  /** turn-<taskId>-<turn>-<firstEpoch>. */
  alias: string
  /** llm_models.slug = LiteLLM model_name; the key allows this model only. */
  model: string
  durationS: number
  /** Decimal string ≤ llmKeyLimits.maxCostRub; a float only inside the adapter's request body. */
  maxCostRub: string
}

export interface LlmKeyState {
  keyHash: string // sha256 hex
  alias: string
  models: readonly string[]
  allowedRoutes: readonly string[]
  expiresAt: Date
  /** The gateway's floats as Decimal strings (10 places): a fuse and a cross-check, never billed. */
  maxBudgetRub: string
  spendRub: string
  blocked: boolean
  deleted: boolean
}

export const gatewayCallSchema = z.object({
  callId: z.uuid(), // litellm_call_id: LiteLLM's uuid4; clients cannot set it (headers are stripped)
  requestId: z.string().min(1).max(256), // LiteLLM's primary key: the provider response id
  keyHash: z.string().regex(/^[0-9a-f]{64}$/),
  model: z.string().min(1).max(128), // model_group = slug
  startedAt: z.date(),
  succeeded: z.boolean(),
  tokens: z.object({
    prompt: tokenCount, // the whole input, cache reads and writes included
    cacheRead: tokenCount,
    cacheWrite: tokenCount,
    output: tokenCount, // reasoning included
    reasoning: tokenCount,
  }),
  gatewaySpendRub: decimalRub,
})
export type GatewayCall = z.infer<typeof gatewayCallSchema>

/** A row with tokens that failed the strict schema; zero-token rows never get here. */
export interface MalformedCall {
  requestId: string
  callId: string | null
  keyHash: string
  tokens: Record<string, number>
  gatewaySpendRub: string
  startedAt: Date
}

export interface LlmModelPrices {
  inputPer1m: string
  cacheReadPer1m: string
  cacheWritePer1m: string
  outputPer1m: string
}

export interface LlmGateway {
  /** Idempotent by the key: an existing key with the same hash and alias is returned as is. */
  issueKey(request: LlmKeyRequest): Promise<LlmKeyState>
  /** null when the gateway never saw the key or lost it. */
  keyState(keyHash: string): Promise<LlmKeyState | null>
  /** Stops the key at once; spend of in-flight calls still lands on its row. */
  blockKey(keyHash: string): Promise<'blocked' | 'absent'>
  /** After usage is closed only. Idempotent. */
  deleteKey(keyHash: string): Promise<void>
  /** Every row of one key in [from, to], oldest first; the adapter splits windows, never pages. */
  calls(query: { keyHash: string; from: Date; to: Date }): Promise<{ calls: GatewayCall[]; malformed: MalformedCall[]; zeroRows: number }>
  /** Per slug, from /model/info, converted to RUB per 1M as Decimal strings. */
  modelPrices(): Promise<ReadonlyMap<string, LlmModelPrices>>
  ready(): Promise<boolean>
}
```

**Новые ошибки домена** (`packages/domain/src/errors.ts`):
- `LLM_GATEWAY_UNAVAILABLE` (503);
- `LLM_KEY_REJECTED` (502) — шлюз выдал ключ не с теми сроком, моделью, маршрутами или бюджетом;
- `LLM_PRICE_MISMATCH` (503) — цены в LiteLLM не равны действующим в базе;
- `LLM_USAGE_INCONSISTENT` (500) — `prompt < cacheRead + cacheWrite` или `reasoning > output`.

В `secretLikeEnvValues` (`packages/domain/src/ports/sandbox-provider.ts:219-233`) добавить `/\brmcp_[A-Za-z0-9_-]{40,}/`.

**`@repo/llm-gateway`** (`packages/llm-gateway/src/`):

| Файл | Что делает |
| --- | --- |
| `config.ts` | `LITELLM_URL` — только origin; в проде `http:` допустим только на имя сервиса или частный IP. `LITELLM_MASTER_KEY`: префикс `sk-`, в проде от 32 символов и не `sk-raditi-dev` |
| `http.ts` | fetch по образцу `packages/vault/src/transit.ts:45-72`: таймаут, `redirect: 'error'`, ответ до 1 МиБ, ни тело, ни URL не попадают в ошибку |
| `schemas.ts` | zod-схемы ответов 1.103.0: `/key/generate`, `/key/info`, `/key/block`, `/spend/logs/v2`, `/model/info`, `/health/readiness` |
| `money.ts` | float → Decimal-строка: `new Decimal(String(x)).toDecimalPlaces(10, ROUND_HALF_UP)`; NaN и Infinity — ошибка |
| `usage.ts` | строка SpendLogs → `GatewayCall`, `MalformedCall` или нулевая |
| `litellm-gateway.ts` | `createLiteLlmGateway(config)` |
| `fixtures/v1.103.0/*.json` | очищенные ответы, записанные `verify:llm-gateway --record` |

Как адаптер работает с LiteLLM:
- **`issueKey`.**
  - Сначала `GET /key/info?key=<sha256>`. Хеш вместо ключа не секрет ([user_api_key_auth.py L2100-2108](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/auth/user_api_key_auth.py#L2100-L2108)).
  - Если ключа нет — `POST /key/generate` с телом `{key, key_alias, duration: "<N>s", models:[model], max_budget, max_parallel_requests, rpm_limit, tpm_limit, allowed_routes:["/v1/responses","/responses","/v1/chat/completions","/chat/completions"]}`.
  - **Без `key_type`**: `handle_key_type` с `llm_api` затирает `allowed_routes` на `["llm_api_routes"]` ([key_management_endpoints.py L845-860, L1378](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/management_endpoints/key_management_endpoints.py#L845-L860), O4).
  - «Алиас занят» → снова `/key/info`: хеш совпал — это наш ключ, иначе `CONFLICT`.
- **`blockKey`.** `POST /key/block {key: <hash>}` принимает хеш и сразу сбрасывает кэш ключа ([L7175-7288](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/management_endpoints/key_management_endpoints.py#L7175)). Ответ 404 означает `absent`.
- **`deleteKey`.** `POST /key/delete {keys:[<hash>]}`; 404 «No keys found» считается успехом.
- **`calls`** (M8, O8).
  - Запрос: `GET /spend/logs/v2?api_key=<hash>&start_date=…&end_date=…&page=1&page_size=1000&sort_by=startTime&sort_order=asc`.
  - Если пришло 1000 строк, окно делится пополам и оба запроса повторяются. OFFSET не используется: `ORDER BY` без второго ключа и срез по OFFSET могут терять строки с одинаковым `startTime` ([spend_management_endpoints.py L2881-2887](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/spend_tracking/spend_management_endpoints.py#L2881-L2887)), а `total` обрезан на 10 000 (L66).
  - Окно не уже одной секунды. 1000 строк за секунду у ключа невозможны: у него 60 запросов в минуту.
- **`usage.ts`.**
  1. Строка, где все токены равны 0, не разбирается дальше и считается в `zeroRows`: так отбрасываются отказы авторизации и доступа к модели ([PR #41291](https://github.com/BerriAI/litellm/pull/41291), O15).
  2. Строгая схема.
  3. `cacheRead = prompt_tokens_details.cached_tokens ?? cache_read_input_tokens ?? 0`.
  4. `cacheWrite = cache_creation_input_tokens ?? prompt_tokens_details.cache_creation_tokens ?? additional_usage_values.prompt_tokens_details.cache_write_tokens ?? 0` (M14).
  5. `reasoning = completion_tokens_details.reasoning_tokens ?? 0`.

  Строка с токенами, которая не прошла схему, попадает в `malformed`.
- **`modelPrices`.** `GET /model/info`, `model_info.*_cost_per_token × 1e6` → Decimal-строка с 6 знаками.

**Слои** (`.dependency-cruiser.cjs`):
- `llm-gateway` — в `ADAPTERS` (`:9-10`);
- в `runner-no-platform-access` (`:155-172`);
- в `web-no-sandbox` (`:174-179`).

**Роли процесса** (`apps/orchestrator/src/config/config.ts:193-196`):
- `LITELLM_*` допустимы только при роли `core`;
- в проде процесс `mcp` с любой `LITELLM_*` не стартует, как сейчас раннер (`:264`). Это часть S4.

## 4. Ключ хода

### 4.1 Параметры и бюджет

| Параметр | Значение |
| --- | --- |
| Значение | `sk-rdt-` + base64url(32 байта CSPRNG) |
| Алиас | `turn-<taskId>-<turn>-<firstEpoch>` |
| Модель | один slug хода |
| Маршруты | ровно 4 пути. LiteLLM сравнивает их по префиксу, поэтому `/v1/responses/{id}` он тоже пропустит ([route_checks.py L573-596](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/auth/route_checks.py#L573-L596)). Точные пути держат только `sandbox-gw` и `llm-ingress` (S9) |
| Срок в LiteLLM | `deadline_at − TURN_FINALIZE_RESERVE_MS`. Супервизор передаёт `ttlMs = guard.remainingBeforeReserveMs(…)`, `durationS = floor(ttlMs/1000) − 5`, не меньше 60 |
| Проверка после выдачи | `/key/info`: `expires ≤ deadline_at`, `models = [slug]`, `allowed_routes` — ровно 4 пути, `max_budget = max_cost_rub` (Decimal, 10 знаков). Иначе `blockKey`, `deleteKey`, `LLM_KEY_REJECTED` |
| Лимиты | `llmKeyLimits` |
| Жизнь записи в Vault | до `deadline_at + TURN_PUBLICATION_GRACE_MS`, потолок mount — 25 минут |
| Попытка | `llm_keys.task_attempt = tasks.attempt` на момент выдачи |

**Бюджет ключа — формула для spec §17.** Считают P12 и M5, P3 только хранит данные.
- **Потрачено попыткой** (себестоимость, не цена):
  - по ключам в `synced` и `drift` — сумма `token_usage.cost_rub`;
  - по ключам в `pending` — `max(Σ cost_rub уже записанных строк, keyState.spendRub)`. Заблокированный ключ продолжает получать `spend` (M4).
- **«Оплата за действие»:** `budget = min(750, (hold − fee) / markup − spent(attempt))`.
- **Тариф с квотой:** `budget = min(750, ceiling(class) − spent(attempt))`; потолки на попытку — light 135 ₽, standard 285 ₽, heavy 735 ₽ (M5).
- Округление вниз до копеек (`ROUND_DOWN`). Меньше `minCostRub` — ключ не выдаётся, P12 решает: `awaiting_user` на «Оплате за действие», правило квоты — вопрос 6.
- Уточнение и «Изменить» тратят потолок той же попытки. «Попробовать ещё» — новая попытка с новым резервом.
- M5 списывает при `done` только после того, как у всех ключей попытки `usage_state ≠ pending` (M4). `drift` и `lost` удерживают списание до решения оператора.
- **Когда ключ исчерпан (P12).**
  - Главный признак — строки ключа с `budget_exceeded` в журнале: при `disable_error_logs: false` LiteLLM их пишет, PoC это проверяет.
  - Запасной признак (M10) — `spendRub ≥ maxBudgetRub − (оценка входа × p_in + 16384 × p_out)`. Считается в Decimal по ценам модели.

**Точность.**
- Перерасход ключа не больше ошибки оценки входа одного вызова: для Kimi около 10 ₽ в худшем случае.
- Недобор не больше резерва одного вызова: на Kimi при 200 тыс. входа это около 35 + 16384 × 725,9/10⁶ ≈ 47 ₽. Это цена потолка вывода (вопрос 1).

### 4.2 Vault

- **Mount `turns/`** (KV v2) с настройками `max_versions=1`, `cas_required=true`, `delete_version_after=25m`.
  - Через 25 минут версия перестаёт читаться, но значение остаётся в хранилище и в снапшотах Raft до `kvDestroy` (S10).
  - `undelete` и `destroy` запрещены политикой.
  - Аудит хеширует значения через HMAC. `log_raw` и `audit_non_hmac_*` на этом mount не включаются.
- **Путь:** `turns/data/t_<taskId>_<turn>_<firstEpoch>`. С B11 данные — `{v:"1", llmApiKey, mcpToken, sessionId, accountId, grant}`, где `grant` — строка JSON исходной политики с `expiresAt` и `validUntil`; `alias` больше не используется. Метаданные — `custom_metadata = {sessionId, deadlineAt, validUntil}`. `expiresAt` закрывает admission в шлюзе, `validUntil = min(deadlineAt + TURN_PUBLICATION_GRACE_MS, firstIssueClock + 25 минут)` сохраняет значения для финализации.
- **Порядок записи** (S3). В OpenBao данные считаются существующими, если есть метаданные ([path_data.go L73-91](https://github.com/openbao/openbao/blob/main/internal/builtin/logical/kv/path_data.go#L73-L91)). Поэтому запись данных после метаданных — это `update`, и она получит 403.
  1. `POST turns/data/<name> {options:{cas:0}, data}` — операция `create`. На этом пути такая запись возможна один раз.
  2. `POST turns/metadata/<name> {custom_metadata}` — `update` на метаданных.

  `delete_version_after` на ключ не задаём: версия получает срок при записи ([path_data.go L326-345](https://github.com/openbao/openbao/blob/main/internal/builtin/logical/kv/path_data.go#L326-L345)), так что потолок mount и есть срок.
- **Политика `core`** (`infra/vault/policies/core-turns.hcl`):

  ```hcl
  path "turns/data/*"     { capabilities = ["create", "read", "delete"] }  # no update: write once
  path "turns/metadata/*" {
    capabilities = ["read", "update", "list", "delete"]
    allowed_parameters = { "custom_metadata" = [] }  # B5: runtime cannot change retention knobs
  }
  path "turns/metadata"   { capabilities = ["list"] }
  path "turns/undelete/*" { capabilities = ["deny"] }
  path "turns/destroy/*"  { capabilities = ["deny"] }  # kvDestroy = DELETE metadata: every version at once
  ```

  У web, mcp и runner путей к `turns/` нет. Чтение `kv/llm/*` у `core` убирается (`docs/spec.md:847`): ключи провайдеров рендерит vault-agent (M10).
- **Порт `SecretStore`** (`packages/domain/src/ports/secret-store.ts:22-26`):

  ```ts
  kvCreateOnce(path: string, data: Record<string, string>, metadata: Record<string, string>): Promise<'created' | 'exists'>
  kvRead(path: string): Promise<{ data: Record<string, string>; version: number } | null> // null: no data or a deleted version
  kvDelete(path: string): Promise<void>                          // soft delete of the latest version
  kvDestroyAll(path: string): Promise<void>                      // DELETE metadata: every version
  kvList(prefix: string, page?: { after?: string; limit: number }): Promise<string[]>
  kvMetadata(path: string): Promise<{ currentVersion: number; custom: Record<string, string>; createdTime: Date; deleted: boolean; destroyed: boolean } | null>
  kvWrite(path, data, options?: { cas?: number }): Promise<{ version: number }>   // for P7's sites
  ```

  - Реализация — `packages/vault/src/kv.ts`. Вход по AppRole выносится из `transit.ts:74-105` в `session.ts`.
  - B5 выполнен локально 30.09.2026: общий AppRole для KV и Transit, клиент KV v2 и реальные проверки политик на одноразовом OpenBao — [отчёт](../../plan/09-p3-vault-and-local-site.md). Пути включают mount, но не служебный сегмент `data`/`metadata`. Будущий срок `deletion_time` ещё не означает удаление; LIST — один снимок с сортировкой и курсором на клиенте.
  - `kvCreateOnce`: 403 или ошибка CAS на шаге 1 → `kvRead`. Запись есть — `'exists'`, записи нет — ошибка. Шаг 2 повторяется всегда: он идемпотентен.

### 4.3 Алгоритмы

Действующая реализация B11 — `GatewayTurnCredentials` в `apps/orchestrator/src/llm/turn-credentials.ts`. Полный локальный проверочный проход ещё ожидается; [отчёт](../../plan/18-p3-turn-keys.md). Прежние `gateway.issueKey`, `/key/info`, `/key/block` и `/key/delete` не используются. Порт:

```ts
interface TurnCredentialGrant {
  driverId: AgentDriverId
  backend: LlmBackendId
  modelSlug: string
  modelClass: ModelClass
  reasoningEffort: string | null
  ttlMs: number
  deadlineAt: Date
  budgetRub: string
  boundSource: string | null
}
issue(ref: TurnCredentialRef, grant: TurnCredentialGrant): Promise<TurnCredentialValues>
```

**`issue(ref, grant)`:**

1. Короткая SQL-транзакция блокирует строку аренды сайта, проверяет `holder_task_id`, epoch, operation `turn`, отсутствие held и живой срок по свежим часам БД. Событие `llm.revoke_requested` для `(taskId, sessionId, turn, firstEpoch)` запрещает повтор. Текущая строка `llm_keys` не может быть отозвана или принадлежать другой сессии. Новый профиль проверяется по драйверу, оболочке, модели, классу, действующей ставке и разрешению трансграничной передачи; дата разрешения — сегодняшний день Москвы. Затем замок `pool:<backend>` сериализует предварительный выбор аккаунта через `pickAccount`.
2. Все SQL-блокировки освобождаются. `kvRead` и write-once `kvCreateOnce` сохраняют ключ, MCP-токен, сессию, аккаунт и исходную политику со сроками. Данные с CAS=0 идут до метаданных; существующая версия читается обратно, metadata после частичного сбоя дописывается. Удалённая или несовместимая запись не возобновляется. `expiresAt = min(now + ttlMs, deadlineAt − TURN_FINALIZE_RESERVE_MS)`, а `validUntil` сохраняет значения до окончания публикации с потолком 25 минут.
3. Вторая SQL-транзакция заново проверяет живую аренду и marker, под тем же замком пула выбирает только аккаунт из Vault и атомарно создаёт привязку задачи и `llm_keys`. Гонка за слот даёт ожидание, не смену аккаунта в уже записанном Vault. Повтор берёт бюджет, профиль, адрес и сроки из сохранённой политики/строки; неудачное решение не расходует перепривязку. Hash, сессия и аккаунт должны совпасть. После ожиданий ещё раз проверяются fence и свежие часы.
4. Вызывающий проверяет свой `guard.assertFence()`; значения подставляются только в память и файлы секретов. Сетевых операций внутри SQL нет; `lock_timeout` и `statement_timeout` ограничивают ожидания и отменяют SQL на сервере.

Если выбору мешают неизвестные окна, `core` после освобождения SQL-блокировок однократно просит content-free probe через частный endpoint роли `llm`, затем читает новый снимок. Произвольный сбой пробы не создаёт доступность. Годного аккаунта нет — `SUBSCRIPTION_WAIT`/`SUBSCRIPTION_BUSY` до запуска контейнера; операторское решение и отсутствие ставки остаются отдельными отказами.

**`recover(ref)`:**

- `kvRead` + строгая схема + `sessionId`;
- `llm_keys.key_hash = sha256(llmApiKey)`, совпадение `subscription_account_id`, отсутствие `revoke_requested_at`/`revoked_at`, живой `validUntil` в Vault и SQL;
- `expiresAt` отдельно закрывает запросы модели; до `validUntil` значения ещё нужны фильтрации вывода и финализации;
- при несовпадении — `null`; здоровье и операторское состояние аккаунта здесь не меняют привязку;
- транспортная ошибка Vault/SQL — исключение с безопасным текстом, recovery откладывает ход. Ключевые данные и ответы провайдера не логируются.

**`revoke(ref)`:**

1. Под замком строки аренды сохраняется не клиентское событие `llm.revoke_requested` с `(sessionId, turn, firstEpoch)` и устанавливается `revoke_requested_at` имеющегося ключа. Marker действует и без строки ключа: поздний CAS прерванного `issue` не сможет затем создать admission, даже если lease ещё жива или metadata уже уничтожены. Повтор marker идемпотентен; бизнес-статус задачи не меняется.
2. `kvDelete` закрывает чтение записи Vault.
3. `revoked_at` фиксирует завершение отзыва; `usage_closed_at` ставится только при отсутствии открытых вызовов, под замком ключа.
4. `kvDestroyAll` удаляет все версии и metadata. Каждый шаг повторяем; ошибка Vault не открывает SQL admission обратно.

**Где вызывается.** `TurnSupervisor.run` (`apps/orchestrator/src/turns/turn-supervisor.ts:59`) принимает `UnkeyedTurnRequest` (`context.llm` без `apiKey`, `mcp` без `token`) и проверенную политику. После `assignments.open` он берёт сохранённый deadline; для раннера сначала ждёт доверенный claim ВМ и адрес из `RUNNER_TOKENS`, затем формирует полный `grant`.
- После `assignments.open` (`:87-99`) и `guard.assertFence()` он выставляет `attempt.credentialRef` и вызывает `issue` через `guard.interruptible`.
- Затем подставляет значения в контекст до `driver.prepare` (`:127`).
- Проверка «в env песочницы нет учётных данных» (`:191-194`) переезжает на подставленные значения.
- Ключи не попадают ни в `turn_assignments.plan`, ни в outbox, ни в BullMQ.

`TurnAttempt.#revoke()` = `withTimeout(credentials.revoke(ref), 5_000)`: ошибка идёт в метрику, повтор делает сборщик. Где вызывается (S6):

| Путь | Где отзываем | Почему можно |
| --- | --- | --- |
| `complete()` | сразу после `record('destroyed')` (`turn-attempt.ts:384-385`), до публикации | контейнера нет, публикации ключ не нужен |
| `settle()`, ветка `vacating` (`:445-454`) | до `return 'vacating'` | так требует `spec.md:503`; запоздавший контейнер больше не ходит к модели |
| `settle()`, ветки `failed` и `recovery` | после `#destroy`, до `release` или `holdForRecovery` | запись `recovery` исключает возобновление (`turn-exec-recovery.ts:239-241`), публикации ключ не нужен (`:581`) |
| `settle()`, `held` (`CORE_STOPPING`, `:458-463`) | не отзываем | следующий `core` возобновит агента |
| `#endVacating` (`:214-221`) | повтор, ничего не делает | — |
| recovery, `#continue` с `deferred` (`:400-404`) | не отзываем | шаг не `recovery`, ход возобновят |
| recovery, `#continue` и `#giveUp` | внутри `attempt.settle`; вызовы после `settle` (`:413`, `:427`) убираются | — |
| recovery, `lastPhase==='failed'` (`:217-219`) | до `#free` | было после |
| recovery, `#done` и `#close` (`:655-680`) | до `#free`, из `#close` убирается | было после |
| recovery, `#publish` (`:560-618`) | в начале, до `publication.recover` | публикация идёт без ключей (`recoveredRun(…, null)`) |
| recovery, `#vacate` (`:445`) и `#expire` (`:482`) | как было, до `#free` | — |
| recovery, `#park` (`:684-690`) | для всех причин, кроме `driver unavailable` | после рестарта с драйвером ход возобновим |

`spec.md:503` уточняется: «отзыв — как только ключ не нужен агенту, всегда до освобождения аренды; не ответил за 5 с — аренда освобождается, повтор раз в минуту; ключ в любом случае истекает до `deadline_at` − 3 мин».

### 4.4 Окна сбоев и сборщик

| Где упал `core` | Что осталось | Что дальше |
| --- | --- | --- |
| До записи в Vault | admission отсутствует | `revoke` сохраняет marker, чтобы поздняя запись не допускалась |
| Данные Vault есть, metadata нет | запись без custom metadata | повтор `issue` допишет metadata; сборщик берёт `createdTime + 25 минут` |
| Vault есть, `llm_keys` нет | write-once данные с аккаунтом и исходной политикой | повтор повторно проверит fence и тот же аккаунт; сборщик найдёт orphan через LIST |
| SQL commit прошёл, ответ потерян | Vault, ключ и привязка | повтор возвращает те же значения, бюджет, профиль и сроки |
| Отмена во время CAS Vault | marker отзыва, возможно ещё нет строки ключа | поздняя запись не создаёт admission; сборщик уничтожает запись по сроку |
| Между шагами отзыва | marker и/или `revoke_requested_at` | повтор `revoke` раз в минуту |
| Зомби на старой эпохе или lease истекла во время ожидания | новый admission отсутствует | свежая fenced проверка запрещает выдачу |
| При отзыве открыт допущенный вызов | ключ закрыт для новых вызовов, учёт открыт | после последнего вызова сборщик ставит `usage_closed_at` |

**Сборщик B11** подключён таймером `core` раз в 60 секунд, без наложения запусков:

- `revoke_requested_at IS NOT NULL AND revoked_at IS NULL` → повтор `revoke`;
- `revoked_at IS NULL AND valid_until <= clock_timestamp()` → `revoke` после окна финализации;
- каждый пятый запуск: страница `kvList('turns/', {after, limit: 100})`, metadata и удаление после `validUntil`, либо `createdTime + 25 минут` без срока; неудачная страница повторяется с прежним курсором;
- отозванные ключи без открытых вызовов → `usage_closed_at` под замком ключа;
- резервное восстановление открытых вызовов старше 30 минут через тот же алгоритм учёта, что в роли `llm`;
- аккаунт с `retire_requested_at`: под тем же замком пула, что `issue`, `enabled=false` после истечения/отзыва активных ключей и закрытия всех открытых вызовов. Затем роль `llm` отзывает токен; окончательное уничтожение `subs/` делает оператор B12.

Метрика — `raditi_llm_credentials_swept_total{kind}` с ограниченными агрегатными kind, без идентификаторов задач и аккаунтов. Очередь жизненного цикла задач относится к P12; текущий сборщик — локальный таймер роли `core`.

## 5. Журнал вызовов → `token_usage`

### 5.1 Опрос вместо callback

Только опрос `GET /spend/logs/v2`, это меняет `docs/spec.md:622`. Почему:
1. `generic_api` доставляет не больше одного раза: `max_retries=0`, `log_queue.clear()` в `finally` ([generic_api_callback.py L165, L406](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/integrations/generic_api/generic_api_callback.py)).
2. Callback требует маршрута из сегмента LiteLLM в `core`.
3. С опросом промпты не могут уйти из LiteLLM в наш endpoint.

**Задержка учёта влияет на деньги** (исправление M4). Поэтому:
- M5 списывает только после закрытия учёта попытки;
- бюджет следующего хода учитывает незакрытые ключи через `spendRub` (раздел 4.1).

### 5.2 Синхронизация и состояния

`LlmUsageSync` (`apps/orchestrator/src/llm/llm-usage-sync.ts`). Новая очередь `llm-gateway` в `queueNames` (`packages/domain/src/ports/job-queue.ts:7`), расписания `usage-sync` и `turn-credentials-sweep` — по 60 с.

```
pending ──(финализация: Σ строк = spend, карантина нет)──▶ synced
   │ └──(10 неудачных финализаций подряд, строки в карантине, повтор call_id)──▶ drift
   └──(keyState = null, или ключ старше 44 дней)──▶ lost
```

- **Опрос.** Каждые 60 с по ключам в `pending`: `calls({keyHash, from: issued_at − 1 мин, to: now})` → запись.
- **Финализация.**
  - Когда: `now > max(expires_at, revoked_at) + 11 мин`. 11 минут = 10 минут на LLM-запрос в шлюзах + 2 × до 10 с пакетной записи ([proxy_server.py L10062](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/proxy_server.py#L10062)) + 40 с запаса (O9).
  - Что: последний проход, затем `Σ gatewaySpendRub` всех строк ключа, включая карантин, сравнивается с `keyState.spendRub`. Допуск — `max(1e-6 × spend, 1e-8)`.
  - Совпало — `synced` и `gateway_spend_rub`. Нет — `usage_checks += 1` и повтор через 60 с; после 10 попыток — `drift`.
- **`lost`.**
  - `/key/info` вернул 404: пропал том `litellm-pgdata`.
  - Ключ в `pending` старше 44 дней: журнал LiteLLM хранится 45 дней.
- **`drift` сразу:**
  - строка ключа попала в карантин;
  - `litellm_call_id` повторился с другим содержимым;
  - модель строки не равна модели ключа.
- **Метрики и алерты** (M9): `raditi_llm_usage_keys{state}` (gauge), алерт на `drift` и `lost`, алерт на `pending` дольше часа после финализации.
- **Правило M5:** `synced` — списание по `token_usage`, но не больше резерва; `drift` и `lost` — списание ждёт оператора.

### 5.3 Строка журнала → строка `token_usage`

Порядок разбора (O15):
1. Нулевые строки отбрасываются в адаптере.
2. Строка не прошла схему → карантин `schema`.
3. Модель по `model_group` через уникальный `llm_models.slug`. Не найдена → `unknown_model`; не равна модели ключа → `model_mismatch`.
4. `price_id` — строка с наибольшим `effective_from ≤ startedAt`. Нет → `no_price`.
5. Согласованность: `prompt ≥ cacheRead + cacheWrite` и `reasoning ≤ output`. Нет → `inconsistent` (M9).
6. `INSERT … ON CONFLICT (gateway_call_id) DO NOTHING RETURNING id`. Для невставленных строк сверяются `gateway_request_id` и токены с уже записанной; расхождение → карантин `duplicate_call_id` (M7).

Поля:
- `key_id`, `task_id`, `driver_id` — из `llm_keys`;
- `turn_id` — `LEFT JOIN task_turns` по `(task_id, turn_no)`: в P3 `NULL`, с P12 заполнен;
- `input_uncached = prompt − cacheRead − cacheWrite`;
- `occurred_at = startedAt`, `gateway_request_id = requestId`.

**Карантин `token_usage_rejects`:**
- хранит числа токенов, причину, `gateway_spend_rub` и время — без содержимого;
- сверка M5 видит строки и после 45 дней журнала LiteLLM (M9);
- `resolved_at` ставит оператор.

### 5.4 Себестоимость в Decimal

`packages/domain/src/billing/llm-cost.ts`; `decimal.js: catalog:` (`pnpm-workspace.yaml:62`). Формула — `docs/spec.md:960-964`:

```ts
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })
export function llmCallCostRub(t: TokenSplit, p: PriceRow): string {
  if (t.prompt < t.cacheRead + t.cacheWrite || t.reasoning > t.output) throw usageInconsistent()
  const pin = new D(p.inputPer1m)
  const cost = new D(t.prompt - t.cacheRead - t.cacheWrite).mul(pin)
    .plus(new D(t.cacheRead).mul(p.cacheReadPer1m ?? pin))    // NULL = input price
    .plus(new D(t.cacheWrite).mul(p.cacheWritePer1m ?? pin))
    .plus(new D(t.output).mul(p.outputPer1m))                 // reasoning is inside output
    .div(1_000_000)
  return cost.toDecimalPlaces(10, D.ROUND_HALF_UP).toFixed(10)  // Decimal(18,10)
}
```

**Тестовые векторы:**
- Kimi-K2.6, вход 100 000, выход 2 000 → **19,0198000000**;
- Qwen3.6 35B, вход 250 000, из них 200 000 из кэша, выход 5 000 → **21,5000000000**;
- кэш по нулевой цене;
- `reasoning > output` → ошибка.

**Токены встроенных инструментов Yandex** в usage не видны: это недоучёт, а не завышение (M13). Политика тела запрещает встроенные инструменты, поэтому любая статья про инструменты в детализации Yandex при сверке M5 означает нарушение политики и даёт алерт.

**Расхождение Σ себестоимости и Σ `spend`** больше 0,01 ₽ или 0,1% — метрика `raditi_llm_cost_drift_total{model}`. После сверки цен при выдаче (раздел 4.3, шаг 0) это признак ошибки, а не смены цены.

### 5.5 Что не попадает в журнал

- **Обрыв со стороны клиента** (kill контейнера, отсечка шлюза, падение `sandbox-gw`).
  - LiteLLM не вызывает ни успешный callback, ни хук ошибки, а резерв сводит к цене входа только в счётчике ([budget_reservation.py L357-380](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/spend_tracking/budget_reservation.py#L357-L380), M3).
  - Потеря — не больше цены входа двух одновременных вызовов ключа.
  - `sandbox-gw` и `llm-ingress` пишут в лог `aborted` с моделью; счётчик для M5 и M9 — `raditi_llm_aborted_requests_total{model}` по логам.
  - `verify` фиксирует, пишется ли строка (шаг 13). Закрывает потерю сверка M5 с детализацией провайдера.
- **`kill -9` или перезапуск LiteLLM:** теряется очередь до 10 с и оборванные потоки. Ключ уходит в `drift`, а не молчит (шаг 12 `verify`).

## 6. Мост `/responses → chat`

### 6.1 Как идёт запрос у каждого провайдера

| Провайдер | Путь | Настройка |
| --- | --- | --- |
| Cloud.ru | `/v1/responses` → мост → `POST {api_base}/chat/completions`. В [OpenAPI Cloud.ru](https://cloud.ru/docs/api/specs/foundation-models/ug/_specs/openapi__foundation-models.yaml) есть только `/v1/models` и `/v1/chat/completions` | `use_chat_completions_api: true` |
| Yandex AI Studio | `/v1/responses` напрямую | `x-data-logging-enabled: false`; `store:false` обязателен |
| GigaChat | не в P3 | раздел 6.3 |
| `/v1/chat/completions` (P5, M6) | напрямую у всех | — |

### 6.2 Что шлёт Codex и что теряется

Codex по HTTP шлёт только `POST {base_url}/responses` (SSE) с `store:false`, всей историей в `input`, `client_metadata`, иногда с `stream_options` и `service_tier` ([common.rs L279-304](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/common.rs), [client.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs)).

| Поле или возможность | В мосту 1.103.0 | Что делаем |
| --- | --- | --- |
| `input`, `instructions`, `tools(function)`, `tool_choice`, `parallel_tool_calls`, `stream`, `temperature`, `top_p` | передаются | — |
| `max_output_tokens` | → `max_tokens` | подставляет политика, `verify` проверяет на фейке |
| `reasoning.effort` | → `reasoning_effort`; `summary` отбрасывается | сводок reasoning в интерфейсе не будет |
| Элементы `reasoning` в истории | → `reasoning_content` | нужно Kimi K2.6 и DeepSeek; проверяют фейк и P14 |
| `include`, `store`, `prompt_cache_key` | отбрасываются | у Cloud.ru кэша в тарифе нет |
| `client_metadata`, `service_tier`, `access_programs` | — | вырезает политика |
| `custom` (freeform `apply_patch`) | → function | в P4 возможен `apply_patch_tool_type=function` |
| `namespace` | → `ns__name` | проверка — P4 |
| `input_image` по URL, `file_url` | мост передал бы как есть | политика отклоняет, допускает только `data:` |
| `text.format json_schema` | → `response_format` | итог хода всё равно проверяет zod |
| id вызовов инструментов | сохраняются через `call_id` | фейк и Codex в `verify` |
| usage потока | `include_usage` мост запрашивает сам | без usage `spend = 0`, и бюджет не работает. Поэтому P3 закрывается после синтетической проверки владельца на Cloud.ru (вопрос 17) |

### 6.3 GigaChat

- Родной провайдер LiteLLM ходит в OAuth с `ssl_verify=False`, и в v1.103.0 тоже ([authenticator.py L61](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/llms/gigachat/authenticator.py#L61)). Из истории он берёт только `tool_calls[0]`.
- GigaChat-3-Ultra юрлицам недоступна ([страница модели](https://developers.sber.ru/docs/ru/gigachat/models/gigachat-3-ultra)), строку `docs/spec.md:614` нужно исправить.
- **По умолчанию (вопрос 4)** в P3 GigaChat не подключаем. Это сужает `roadmap.md:24` («мост для Cloud.ru и GigaChat») и требует решения владельца.
  - Через Cloud.ru — если Cloud.ru подтвердит, что `ai-sage/GigaChat3.5-432B-A28B` — их внутренняя модель с вызовом функций.
  - Или через gpt2giga в P14.
  - У GigaChat `cache_read_per_1m = 0` ([подсчёт токенов](https://developers.sber.ru/docs/ru/gigachat/guides/counting-tokens)).

### 6.4 Как проверяем мост

- **Фейк** записывает тело каждого запроса. Проверка утверждает:
  - в chat нет `store`, `include`, `prompt_cache_key`, `client_metadata`;
  - `max_tokens = 16384`;
  - `tools` — function;
  - `reasoning_content` возвращается на втором круге;
  - `tool_call_id` совпадает;
  - поток заканчивается `response.completed` с `usage`;
  - у потоков `spend > 0` ([#42161](https://github.com/BerriAI/litellm/issues/42161)).
- **Codex CLI** гоняется по мосту и напрямую (раздел 10, шаг 7).
- **Настоящие провайдеры** — синтетическая проверка владельца (P3) и P14.

## 7. Реестр моделей

Единый источник — `packages/db/prisma/seed/data.ts:240-297`. `LlmModelSeed` получает:
- `providerModelId` и `enabled` — задаются при создании;
- `prices: PriceSeed[]` — история цен. `apply.ts` добавляет недостающие строки по уникальному `(model_id, effective_from)`, существующие не трогает (M11);
- `gateway: { api: 'responses' | 'chat', maxInputTokens }`.

| slug | Провайдер | Модель в LiteLLM | Класс | Маршрут | ₽/1M вход / кэш / выход |
| --- | --- | --- | --- | --- | --- |
| `qwen3.6-35b` | Yandex | `openai/gpt://<folder>/qwen3.6-35b-a3b/latest` | light | Responses | 200 / 50 / 300 |
| `deepseek-v4-flash` | Yandex | `openai/gpt://<folder>/deepseek-v4-flash/latest` | light | Responses | 300 / 75 / 500 |
| `qwen3-235b` | Yandex | — | heavy | **выключена**: Yandex отключает её 30.09.2026 ([модели](https://aistudio.yandex.ru/docs/ru/ai-studio/concepts/generation/models)); из конфига убрать, в сидах `enabled:false` | — |
| `qwen3-coder-next` | Cloud.ru | `openai/Qwen/Qwen3-Coder-Next` | standard | мост | 122 / =вход / 244 |
| `kimi-k2.6` | Cloud.ru | `openai/moonshotai/Kimi-K2.6` | standard | мост | 175,68 / =вход / 725,9 |
| `glm-5.1` | Cloud.ru | `openai/zai-org/GLM-5.1` | heavy | мост | 198,86 / =вход / 829,6 |
| `deepseek-v4-pro` | Cloud.ru | `openai/deepseek-ai/DeepSeek-V4-Pro` | heavy | мост | 183 / =вход / 732 |
| `gpt-oss-120b` | Cloud.ru | `openai/openai/gpt-oss-120b` | service | chat (M6) | 15,86 / =вход / 61 |

Тариф Cloud.ru v260918 с 28.09.2026 цены этих моделей не изменил ([тариф](https://cloud.ru/documents/tariffs/evolution/foundation-models)).

`packages/db/prisma/seed/litellm-config.test.ts` читает YAML через `yaml` с `schema: 'failsafe'`: все скаляры — строки, float не появляется (M14). Правила:
1. `model_name` включённых сидов совпадают с конфигом, без повторов и без `*`.
2. У каждой модели:
   - пять цен равны последней цене сида, делённой на 1e6 (Decimal, точно);
   - кэш и запись в кэш — `cache_*_per_1m ?? input_per_1m`, reasoning — равен выходу;
   - `max_output_tokens = llmKeyLimits.maxOutputTokens`;
   - `max_input_tokens` равен `gateway.maxInputTokens`.
3. У Cloud.ru — `use_chat_completions_api: true` и точное совпадение id с белым списком внутренних моделей: `moonshotai/Kimi-K2.6`, `deepseek-ai/DeepSeek-V4-Pro`, `openai/gpt-oss-120b`, `Qwen/Qwen3-Coder-Next`, `Qwen/Qwen3.6-35B-A3B`, `zai-org/GLM-5.1`, `MiniMaxAI/MiniMax-M3` ([каталог](https://cloud.ru/docs/foundation-models/ug/topics/overview__available__models)).
4. У Yandex — заголовок `x-data-logging-enabled: 'false'`. Шаблоны `YANDEX_MODEL_*` в трёх compose (dev, проверка, app-ВМ) совпадают с `providerModelId`.
5. Обязательные значения:
   - `fail_closed_budget_enforcement: 'true'`, `disable_error_logs: 'false'`, `allow_client_side_credentials: 'false'`, `store_model_in_db: 'false'`, `store_prompts_in_spend_logs: 'false'`;
   - `callbacks` — ровно `['prometheus']`;
   - `router_settings` раздела 2.2;
   - `upperbound_key_generate_params` равен `llmKeyLimits` (M14, O14, S8).

Сиды меняют поля строки только при её создании (`apply.ts:8-9`). В существующих dev-базах `qwen3-235b` останется `enabled=true`, но ключ на него не выдаётся: модели нет в конфиге, и сверка цен (раздел 4.3, шаг 0) вернёт `LLM_PRICE_MISMATCH`.

## 8. Лимиты

| Уровень | Лимит | Где |
| --- | --- | --- |
| Ключ хода | 2 параллельных, 60 в минуту, 4 млн токенов в минуту, бюджет ≤ 750 ₽, срок ≤ 20 мин | `llmKeyLimits` → `/key/generate` |
| Потолок любого ключа | те же числа | `upperbound_key_generate_params` |
| Вывод одного запроса | 16384 токена | политика тела + `model_info` |
| Модель Cloud.ru | `rpm: 240` у каждой из пяти (20 запросов/с на ключ Cloud.ru) | `enforce_model_rate_limits` |
| Модель Yandex | 5 параллельных у каждой из двух; сверх — сразу 429 ([client_initalization_utils.py L16-46](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/router_utils/client_initalization_utils.py#L16-L46)), повторяет CLI | `max_parallel_requests` |
| Весь шлюз | 32 параллельных, `request_timeout: 600` | `general_settings` |
| `llm-ingress` | 64 одновременно, 16 с одного адреса, тело ≤ 16 МиБ, ответ ≤ 64 МиБ, 10 мин | `llm-ingress.mjs` |
| `sandbox-gw` | 8 одновременно (`gateway.mjs:41`), LLM — 10 мин, MCP — 20 мин | `gateway.mjs` |
| `llm-egress` | 64 туннеля, простой 11 мин | `llm-egress.mjs` |

Ответы LiteLLM, которые разбирают драйвер и P12:
- `429 budget_exceeded`;
- `429 throttling_error`;
- `401 expired_key`;
- `401` для заблокированного ключа;
- `403 key_model_access_denied`.

## 9. Наблюдаемость

Метрики `core` (`apps/orchestrator/src/metrics/metrics.module.ts:10`). В метках нет `task_id`, хешей и алиасов.

| Метрика | Тип | Метки |
| --- | --- | --- |
| `raditi_llm_keys_issued_total` | counter | `result` = ok \| gateway_error \| vault_error \| rejected \| conflict \| price_mismatch |
| `raditi_llm_key_issue_seconds` | histogram | — |
| `raditi_llm_keys_revoked_total` | counter | `result`, `stage` = db \| vault \| gateway |
| `raditi_llm_credentials_swept_total` | counter | `kind` = requested \| expired \| vault \| gateway_delete |
| `raditi_llm_usage_calls_ingested_total` | counter | `provider`, `model` |
| `raditi_llm_usage_rows_rejected_total` | counter | `reason` = schema \| unknown_model \| model_mismatch \| no_price \| inconsistent \| duplicate_call_id |
| `raditi_llm_usage_zero_rows_total` | counter | — |
| `raditi_llm_usage_lag_seconds` | histogram | — |
| `raditi_llm_usage_keys` | gauge | `state` = pending \| synced \| drift \| lost |
| `raditi_llm_cost_drift_total` | counter | `model` |
| `raditi_llm_price_mismatch` | gauge | `model` |

- **`llm-ingress`, `sandbox-gw` и `llm-egress`** пишут JSON-логи: код, модель, поле, `aborted`, хост. Счётчики по логам — M9.
- **LiteLLM** отдаёт метрики на `:4001` без авторизации, порт не публикуется. Prometheus на app-ВМ — M9.
- **`/health` `core`** с `METRICS_TOKEN` показывает `/health/readiness` LiteLLM и результат сверки цен.
- **Логи:** ни ключа, ни хеша, ни тела.

## 10. Проверка без клиентских данных

**Модульные тесты (Vitest):**

| Тест | Что проверяет |
| --- | --- |
| `packages/domain/src/billing/llm-cost.test.ts` | векторы, `NULL`-цены, reasoning, HALF_UP до 10 знаков, отказ при несогласованных токенах |
| `packages/domain/src/ports/llm-gateway.test.ts` | `gatewayCallSchema`, Decimal-строки, пределы, `llmKeyLimits` |
| `packages/vault/src/kv.test.ts` | порядок «данные с `cas=0`, затем метаданные»; 403 на существующем пути → чтение; мягкое удаление → `null`; LIST с `after`; `createdTime`; секреты не попадают в ошибки |
| `packages/llm-gateway/src/*.test.ts` | в теле `/key/generate` нет `key_type`; `/key/info` и `/key/block` по хешу; `/key/delete` 404 = успех; `sort_order=asc`, деление окна при 1000 строк, без `page>1`; нулевые строки до схемы; `cache_write_tokens`; float → Decimal; фикстуры 1.103.0 |
| `apps/orchestrator/src/llm/turn-credentials.test.ts` | все строки раздела 4.4 через `crashable()`; при повторе бюджет и срок берутся из строки; отозванный ход не воскресает; `recover` отвечает `null` при чужом хеше, отзыве или `revoke_requested_at`; зомби получает `LEASE_LOST`; `LLM_PRICE_MISMATCH` |
| `apps/orchestrator/src/llm/llm-usage-sync.test.ts` (с `DATABASE_URL`) | переходы `pending → synced / drift / lost`; повтор страниц не создаёт дублей; `duplicate_call_id`; карантин; `price_id` по дате; `turn_id` из `task_turns`; 10 попыток |
| `apps/orchestrator/src/llm/credential-sweeper.test.ts` | (a)–(d) раздела 4.4; `kvDestroy` при недоступном шлюзе после `expires_at` |
| `turn-supervisor.test.ts`, `turn-attempt.test.ts`, `turn-exec-recovery.test.ts` | каждая строка таблицы «Где вызывается»: `revoke` раньше `release`, `holdForRecovery` и `#free`; нет `revoke` при `held` и `deferred`; `#park` с `driver unavailable`. `MemoryTurnCredentials` пишет порядок вызовов |
| `packages/db/prisma/constraints.test.ts` | CHECK `llm_keys`, `token_usage`, `token_usage_rejects`; составной FK цены |
| `packages/db/prisma/seed/litellm-config.test.ts` | правила раздела 7 |
| `apps/orchestrator/src/config/config.test.ts` | `LITELLM_*` только у `core`; `mcp` в проде с ними не стартует; раннер по-прежнему отклоняет (`:536-548`) |

**Проверки инфраструктуры (`pnpm test:infra`):**
- `infra/sandbox/llm-request-policy.test.mjs`:
  - белые списки и рекурсия;
  - `store` отсутствует или `true`;
  - изображения по URL, `file_id`, `input_file`;
  - потолок вывода подставляется, выше — 400;
  - `client_metadata` вырезается;
  - замена `prompt_cache_key`;
  - повторный проход ничего не меняет;
  - имя `unknown` для неизвестного поля.
- `infra/sandbox/llm-ingress.test.mjs`:
  - чужой адрес или `Host`, `/key/*`, `/spend/*`, `/v1/models`, `/v1/responses/abc` → 403;
  - лимит на адрес;
  - `x-litellm-call-id` не проходит;
  - обрыв даёт `aborted` в логе;
  - 10 минут.
- `infra/sandbox/llm-egress.test.mjs`:
  - CONNECT к хосту из списка — туннель к локальному TCP-эху через подменённый резолвер;
  - чужой хост, чужой порт, частный адрес и 169.254.169.254 → 403;
  - GET → 405;
  - HTTP-режим только при `LLM_EGRESS_ALLOW_HTTP`.
- `infra/sandbox/gateway.test.mjs`: политика на LLM-маршрутах, 10 минут на LLM, `x-litellm-*`.
- `infra/app/litellm/entrypoint.test.mjs`: значения с `$`, обратными кавычками и пробелами доходят как есть; неизвестное имя → код 64.
- `infra/app/compose.test.mjs`:
  - uid;
  - профиль `llm` у четырёх сервисов;
  - у `litellm` только internal-сети;
  - `llm-out` и `llm-edge` — по одному участнику;
  - `llm-ingress` публикует только 4000 на `APP_PRIVATE_IP`;
  - нет `LLM_EGRESS_ALLOW_HTTP`, нет `0.0.0.0/0`;
  - `init`, `stop_grace_period`;
  - digest образов;
  - `LITELLM_URL` у `core`.
- `infra/app/images.test.mjs`: `LITELLM_IMAGE` — digest `fda28944…`.
- `infra/app/preflight.test.mjs` (новый, на подменённых `iptables`, `stat` и `docker`): проверки профиля `llm`.

**`pnpm --filter orchestrator verify:llm-gateway`** — `apps/orchestrator/scripts/verify-llm-gateway.mjs`. Только localhost и не прод, dev-токен Vault.

1. **Стек.** `infra/dev/llm-verify/compose.yml`, проект `raditi-p3verify`:
   - `litellm` — только internal-сети `v-core`, `v-ingress`, `v-data`, `v-egress`;
   - `litellm-db` на tmpfs;
   - `llm-ingress` и `llm-egress` из локально собранного образа шлюза. У `llm-egress` задано `LLM_EGRESS_ALLOW_HTTP=fake-upstream:8080`, у `llm-ingress` — `LLM_INGRESS_CLIENTS=0.0.0.0/0`, публикация `127.0.0.1:4100`;
   - `fake-upstream` — node-образ по digest: `:8080` — модель, `:9090` — «злой» приёмник, `:8081` — управление на `127.0.0.1:4101`;
   - `core-relay` — `tcp-relay.mjs`, `127.0.0.1:4102` → `litellm:4000` по `v-core`.

   Ключи провайдеров — литералы `fake-…`, ключи из `.env` сюда не попадают. Фейк работает в контейнере и не слушает сеть хоста (O16).
2. **Сеть** (S1, O7, O11):
   - в `litellm` `socket.getaddrinfo('example.com')` не резолвится;
   - TCP к `fake-upstream:9090` невозможен: у LiteLLM нет общей сети с фейком;
   - через прокси `CONNECT fake-upstream:9090` → 403.
3. **Vault.**
   - Настройки mount.
   - Временная AppRole с `core-turns.hcl`. Под ней запрещены: запись данных поверх существующих метаданных, `update` данных, `undelete`, `destroy`, чтение `kv/sites` — везде 403 (S3).
   - Аудит в файл на время проверки.
4. **База.** Синтетические workspace, site, task (`attempt = 1`) и лизинг.
5. **`issue`.** `/key/info`: `allowed_routes` ровно 4 (O4), модель, `expires ≤ deadline_at`, `max_budget`. Повтор с другим `grant` даёт прежний бюджет (M12).
6. **Вызовы через `llm-ingress`:**
   - `kimi-k2.6` `/v1/responses`, с потоком и без, сценарии `text`, `tool-call` (два круга), `cached-reasoning`;
   - `mid-stream-error`: строка `failure` с токенами и прирост `spend` (M2);
   - `echo-400`: маркер входа в ошибке провайдера;
   - `big-output`: фейк отдаёт ровно `max_tokens` токенов, а `max_tokens = 16384` есть и у моста, и в прямом `/responses` Yandex, и в chat (M1, O3);
   - `qwen3.6-35b` напрямую: `/v1/responses`, заголовок, `model: gpt://verifyfolder/…`, `store:false`;
   - `kimi-k2.6` через `/v1/chat/completions`.
7. **Codex CLI** (O11). `CODEX_VERSION` закреплена в скрипте и совпадает с плановой версией образа P4; ставится через `pnpm dlx @openai/codex@<версия>` во временный каталог.
   - `CODEX_HOME` временный: `model_provider` на `http://127.0.0.1:4100/v1`, `wire_api="responses"`, `supports_websockets=false`, минимальный каталог модели.
   - Сценарий фейка `codex-plan`: вызов `update_plan`, затем текст.
   - Утверждения: ни одного 400 от политики, `call_id` пережил круг, Codex завершился с кодом 0 и итоговым текстом.
   - То же на `qwen3.6-35b` напрямую.
   - Флаг `--skip-codex` — только для локальных итераций, для закрытия P3 шаг обязателен.
8. **Отказы:**
   - через `llm-ingress`: `api_base`, `web_search`, `store:true`, `store` отсутствует, изображение по `https://`, `file_id`, `max_output_tokens: 20000`, неизвестное поле → 400;
   - через `core-relay` с ключом хода (мимо шлюза): `/key/info`, `/v1/embeddings`, `/v1/models` → 403; чужая модель → 403; `api_base` в теле → «злой» приёмник ничего не получил;
   - `/v1/responses/abc` — результат записывается в отчёт как граница `allowed_routes` (S9).
9. **Лимиты:**
   - ключ на 30 ₽ до `429 budget_exceeded`. Перерасход не больше разницы между фактическим входом и оценкой LiteLLM: фейк отдаёт `prompt_tokens = 1,3 × оценка` и большие `instructions`, скрипт считает границу (M1). Недобор не больше резерва одного вызова;
   - 3 одновременных запроса → один 429;
   - ключ на 60 с → 401 после срока;
   - заблокированный ключ → 401.
10. **Сбои.** Дочерний процесс делает `issue` и получает `kill -9` в точках `after-kv-data`, `after-kv-meta`, `after-db`, `after-gateway` (`P3_VERIFY_CRASH_AT`). Родитель повторяет `issue` (те же значения), `recover` (те же), `revoke`. После этого:
    - `/key/info` → `blocked`;
    - данные и метаданные в Vault → 404;
    - `revoked_at` задан;
    - повторный `issue` → `CONFLICT`;
    - `recover` → `null`.
11. **Отзыв во время потока** (O1). Сценарий `slow`, `revoke` посреди потока. После финализации `Σ строк = spend` → `synced`.
12. **Перезапуск LiteLLM во время потока** (O5). `docker compose restart litellm`: ключ приходит в `synced` или `drift`, но не зависает в `pending` и не синхронизируется молча с потерей.
13. **Обрыв клиента** (M3). `slow` с разрывом соединения: в отчёт записывается, есть ли строка; в логе `llm-ingress` — `aborted`.
14. **Повтор `id` у провайдера** (O10). Фейк отдаёт одинаковый `id` двум ответам: строк столько же, сколько вызовов, или ключ в `drift`.
15. **Учёт.**
    - Ждать, пока число строк не перестанет меняться 20 с, но не дольше 90 с (O9).
    - `gateway_call_id` = заголовок `x-litellm-call-id` ответа.
    - Повтор не добавляет строк.
    - Себестоимость совпадает с векторами.
    - `synced`.
    - Сценарий `inconsistent` (кэш больше входа) → карантин и `drift`.
16. **Сверка цен.** Временная строка `llm_model_prices` с новой ценой → `issue` отвечает `LLM_PRICE_MISMATCH`; строка удаляется.
17. **Что не пишется.**
    - В `LiteLLM_SpendLogs` пусты `messages`, `response` и `proxy_server_request`.
    - Маркера промпта нет ни там (включая `metadata.error_information`), ни в логах LiteLLM, `llm-ingress` и `llm-egress`, ни в аудите OpenBao.
    - Ключа в открытом виде нет нигде (S12).
18. **Уборка:** синтетические строки, `kvDestroy`, отключение аудита, `compose down -v`.

Флаг `--record` сохраняет очищенные ответы в `packages/llm-gateway/src/fixtures/v1.103.0/`.

**Фейковый upstream** (`infra/dev/llm-verify/fake-llm-upstream.mjs`, `node:http`):
- `POST /v1/chat/completions` и `POST /v1/responses` — с потоком и без, `usage` с деталями кэша и reasoning;
- `GET /v1/models`;
- сценарий выбирается маркером `[[scenario:…]]`: `text`, `tool-call`, `cached-reasoning`, `codex-plan`, `mid-stream-error`, `echo-400`, `big-output`, `no-usage`, `slow`, `dup-id`, `inconsistent`;
- записывает метод, путь, разрешённые заголовки и JSON тела — только в память;
- `:9090` считает обращения.

**Синтетическая проверка на реальных провайдерах** — условие закрытия P3 (вопрос 17).
- Запускает владелец: `P3_LLM_SMOKE_MODELS=kimi-k2.6,qwen3.6-35b`.
- Идёт через dev-LiteLLM (профиль `llm`) и `llm-egress` с настоящим TLS.
- Выпускает ключ хода, отправляет один синтетический промпт «Ответьте одним словом: ок» с потоком и без, по одному вызову через мост и напрямую.
- Печатает только форму usage: есть ли usage в потоке, кэш, reasoning, `spend > 0`. Затем отзывает ключ.
- Агенты `.env` не читают; скрипт получает значения через `node --env-file` и их не печатает.

**CI.** `.github/workflows/llm-gateway.yml`, как `edge.yml`: не обязателен для merge, запускается по путям `infra/app/litellm/**`, `infra/sandbox/llm-*`, `packages/llm-gateway/**`, `apps/orchestrator/src/llm/**`, `infra/dev/llm-verify/**`. Прогоняет `verify:llm-gateway` вместе с Codex на ubuntu-latest: LiteLLM из GHCR по digest, OpenBao dev, PostgreSQL service. Данные синтетические.

## 11. Схема данных

Миграция `packages/db/prisma/migrations/20260929120000_llm_gateway_keys/migration.sql`. Применённые миграции не трогаем.

```sql
CREATE TYPE "LlmUsageState" AS ENUM ('pending', 'synced', 'drift', 'lost');
CREATE TYPE "TokenUsageRejectReason" AS ENUM ('schema', 'unknown_model', 'model_mismatch', 'no_price', 'inconsistent', 'duplicate_call_id');

CREATE TABLE "llm_keys" (
    "id" UUID NOT NULL,
    "key_hash" VARCHAR(64) NOT NULL,
    "alias" VARCHAR(128) NOT NULL,
    "task_id" UUID NOT NULL,
    "task_attempt" INTEGER NOT NULL,
    "session_id" VARCHAR(64) NOT NULL,
    "turn_no" INTEGER NOT NULL,
    "first_epoch" INTEGER NOT NULL,
    "driver_id" VARCHAR(32) NOT NULL,
    "model_id" UUID NOT NULL,
    "max_cost_rub" DECIMAL(18,10) NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "valid_until" TIMESTAMPTZ(6) NOT NULL,
    "revoke_requested_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "gateway_deleted_at" TIMESTAMPTZ(6),
    "usage_state" "LlmUsageState" NOT NULL DEFAULT 'pending',
    "usage_checks" INTEGER NOT NULL DEFAULT 0,
    "usage_checked_at" TIMESTAMPTZ(6),
    "gateway_spend_rub" DECIMAL(18,10),
    CONSTRAINT "llm_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "llm_keys_key_hash_key" ON "llm_keys"("key_hash");
CREATE UNIQUE INDEX "llm_keys_alias_key" ON "llm_keys"("alias");
CREATE UNIQUE INDEX "llm_keys_turn_key" ON "llm_keys"("task_id", "turn_no", "first_epoch");
CREATE INDEX "llm_keys_task_attempt_idx" ON "llm_keys"("task_id", "task_attempt");
CREATE INDEX "llm_keys_pending_idx" ON "llm_keys"("expires_at") WHERE "usage_state" = 'pending';
CREATE INDEX "llm_keys_unrevoked_idx" ON "llm_keys"("valid_until") WHERE "revoked_at" IS NULL;
CREATE INDEX "llm_keys_revoke_retry_idx" ON "llm_keys"("revoke_requested_at")
  WHERE "revoke_requested_at" IS NOT NULL AND "revoked_at" IS NULL;
ALTER TABLE "llm_keys" ADD CONSTRAINT "llm_keys_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "llm_keys" ADD CONSTRAINT "llm_keys_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "agent_drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "llm_keys" ADD CONSTRAINT "llm_keys_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "llm_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "llm_keys"
  ADD CONSTRAINT "llm_keys_key_hash_check" CHECK ("key_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "llm_keys_budget_check" CHECK ("max_cost_rub" >= 1 AND "max_cost_rub" <= 750),
  ADD CONSTRAINT "llm_keys_numbers_check" CHECK ("task_attempt" > 0 AND "turn_no" > 0 AND "first_epoch" > 0 AND "usage_checks" >= 0),
  ADD CONSTRAINT "llm_keys_spend_check" CHECK ("gateway_spend_rub" IS NULL OR "gateway_spend_rub" >= 0),
  ADD CONSTRAINT "llm_keys_times_check" CHECK ("expires_at" > "issued_at" AND "valid_until" >= "expires_at"),
  ADD CONSTRAINT "llm_keys_revoke_check" CHECK ("revoked_at" IS NULL OR "revoke_requested_at" IS NOT NULL),
  ADD CONSTRAINT "llm_keys_delete_check" CHECK ("gateway_deleted_at" IS NULL OR ("revoked_at" IS NOT NULL AND "usage_state" <> 'pending')),
  ADD CONSTRAINT "llm_keys_synced_check" CHECK ("usage_state" <> 'synced' OR "gateway_spend_rub" IS NOT NULL);

-- Before P3 nothing wrote token_usage; a non-empty table stops the migration instead of losing rows.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "token_usage") THEN RAISE EXCEPTION 'token_usage is not empty: backfill key_id first'; END IF;
END $$;
ALTER TABLE "token_usage"
  ADD COLUMN "key_id" UUID NOT NULL,
  ADD COLUMN "gateway_request_id" VARCHAR(256) NOT NULL,
  ALTER COLUMN "turn_id" DROP NOT NULL;  -- until P12 writes task_turns before issue
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "llm_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "token_usage_key_id_idx" ON "token_usage"("key_id");
CREATE INDEX "token_usage_gateway_request_id_idx" ON "token_usage"("gateway_request_id");
-- The price row must be of the row's own model (as credit_ledger's (account_id, unit)).
CREATE UNIQUE INDEX "llm_model_prices_id_model_id_key" ON "llm_model_prices"("id", "model_id");
ALTER TABLE "token_usage" DROP CONSTRAINT "token_usage_price_id_fkey";
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_price_id_model_id_fkey" FOREIGN KEY ("price_id", "model_id")
  REFERENCES "llm_model_prices"("id", "model_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_reasoning_check" CHECK ("reasoning_tokens" <= "output_tokens");

CREATE TABLE "token_usage_rejects" (
    "id" UUID NOT NULL,
    "key_id" UUID NOT NULL,
    "gateway_request_id" VARCHAR(256) NOT NULL,
    "gateway_call_id" VARCHAR(128),
    "reason" "TokenUsageRejectReason" NOT NULL,
    "model_group" VARCHAR(128),
    "tokens" JSONB NOT NULL,  -- token counts only, never content
    "gateway_spend_rub" DECIMAL(18,10) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    CONSTRAINT "token_usage_rejects_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "token_usage_rejects_row_key" ON "token_usage_rejects"("key_id", "gateway_request_id", "reason");
ALTER TABLE "token_usage_rejects" ADD CONSTRAINT "token_usage_rejects_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "llm_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "token_usage_rejects"
  ADD CONSTRAINT "token_usage_rejects_spend_check" CHECK ("gateway_spend_rub" >= 0),
  ADD CONSTRAINT "token_usage_rejects_tokens_check" CHECK (jsonb_typeof("tokens") = 'object');

-- LiteLLM model_name is global: one slug, one model.
CREATE UNIQUE INDEX "llm_models_slug_key" ON "llm_models"("slug");

-- A turn may hold several keys (each retry is a new epoch): llm_keys replaces the single hash.
DROP INDEX "task_turns_litellm_key_hash_key";
ALTER TABLE "task_turns" DROP COLUMN "litellm_key_hash";
```

Изменения в `packages/db/prisma/schema.prisma`:
- модель `LlmKey` и `TokenUsageReject`, enum-ы;
- у `TokenUsage` — `keyId`, `gatewayRequestId`, `turnId?`, связь с ценой через `[priceId, modelId]`;
- у `LlmModelPrice` — `@@unique([id, modelId])`;
- у `LlmModel` — `slug @unique` (сейчас `:851`);
- у `TaskTurn` нет `litellmKeyHash` (сейчас `:551-553`).

**Права в PostgreSQL на app-ВМ** (`infra/app/postgres/init-roles.sh`, после `:36`, по образцу `_prisma_migrations`; S5):

```sql
SELECT format('REVOKE ALL ON TABLE public.%I FROM raditi_app', t)
  FROM unnest(ARRAY['llm_keys','token_usage','token_usage_rejects']) t
  WHERE to_regclass('public.' || t) IS NOT NULL \gexec
SELECT 'GRANT SELECT, INSERT, UPDATE ON public.llm_keys, public.token_usage_rejects TO raditi_core'
  WHERE to_regclass('public.llm_keys') IS NOT NULL \gexec
SELECT 'GRANT SELECT, INSERT ON public.token_usage TO raditi_core'
  WHERE to_regclass('public.token_usage') IS NOT NULL \gexec
```

Web к этим таблицам доступа не имеет, `token_usage` для `core` — только добавление. Права на остальные таблицы хода (`turn_assignments`) — общая задача ролей §15 (M10). От подмены `turn_assignments` `recover` защищён сверкой с `llm_keys`.

## 12. Файлы

**Новые:**
- `packages/domain/src/ports/llm-gateway.ts`, `llm-gateway.test.ts`; `packages/domain/src/billing/llm-cost.ts`, `llm-cost.test.ts`
- `packages/llm-gateway/{package.json,tsconfig.json,eslint.config.js,vitest.config.ts}`
- `packages/llm-gateway/src/{index,config,http,schemas,money,usage,litellm-gateway}.ts` с тестами, `fixtures/v1.103.0/`
- `packages/vault/src/{kv,session}.ts`, `kv.test.ts`
- `packages/db/prisma/migrations/20260929120000_llm_gateway_keys/migration.sql`
- `apps/orchestrator/src/llm/{llm.module,turn-credentials,llm-key-store,llm-usage-sync,credential-sweeper,price-check,llm-gateway.processor,llm-metrics}.ts` и тесты
- `apps/orchestrator/scripts/verify-llm-gateway.mjs`
- `infra/dev/llm-verify/{compose.yml,fake-llm-upstream.mjs,tcp-relay.mjs}`
- `infra/app/litellm/{config.yaml,entrypoint.sh,entrypoint.test.mjs,postgres-init.sh}`
- `infra/app/secrets.example/litellm/litellm.env`, `infra/app/secrets.example/litellm-postgres/{superuser-password,litellm-password}`
- `infra/app/preflight.test.mjs`
- `infra/sandbox/{llm-request-policy,llm-ingress,llm-egress}.mjs` и `*.test.mjs`
- `infra/vault/policies/core-turns.hcl`
- `.github/workflows/llm-gateway.yml`
- `docs/research/2026-09-p3/{litellm,providers,credentials,repository}.md`, `docs/plan/05-p3-verification.md`

**Изменяются:**
- `packages/domain`: `src/ports/{turn-executor,secret-store,sandbox-provider,job-queue}.ts`, `src/errors.ts`, `src/index.ts`, `package.json`
- `packages/vault/src/{transit,vault-secret-store,index}.ts`
- `packages/db`: `prisma/schema.prisma`, `prisma/seed/{data,apply}.ts`, `prisma/seed/litellm-config.test.ts`, `prisma/constraints.test.ts`, `package.json` (`yaml`)
- `apps/orchestrator`:
  - `src/config/{config,config.test}.ts`, `src/core/core.module.ts`, `src/infra/tokens.ts`, `src/queue/queues.ts`, `src/health/health-checks.ts`;
  - `src/turns/{turn-supervisor,turn-attempt,turn-exec-recovery}.ts` и тесты, `src/testing/turn-credentials.ts`;
  - `package.json`.
- `infra/sandbox/{gateway.mjs,gateway.test.mjs,Dockerfile}`
- `infra/dev/docker-compose.yml`; `infra/dev/litellm.config.yaml` удаляется
- `infra/app/{docker-compose.yml,env.example,compose.test.mjs,images.test.mjs,preflight.sh,README.md}`, `infra/app/postgres/init-roles.sh`, `infra/app/secrets.example/core/app.env`
- `.dependency-cruiser.cjs`, `.env.example`, `turbo.json`, `package.json` (`test:infra`)
- `docs/spec.md`, `CLAUDE.md`, `docs/plan/roadmap.md`

`turn-budget.ts` из редакции 1 не создаётся: это P12.

## 13. Переменные окружения

| Переменная | Где | `.env.example` | turbo `globalEnv` |
| --- | --- | --- | --- |
| `LITELLM_URL` | `core` (`.env.example:80`) | `http://localhost:4000`; на app-ВМ — в `environment:` | есть |
| `LITELLM_MASTER_KEY` | `core` и LiteLLM (`:81`) | `sk-raditi-dev`, рядом совет `openssl rand`; в проде — из Vault `kv/platform/app/litellm` в два файла секретов | есть |
| `LITELLM_SALT_KEY` | dev-compose LiteLLM | `sk-raditi-dev-salt`; в проде не меняется | **добавить** |
| `LITELLM_PUBLISH_ADDR` | dev-compose | `127.0.0.1` | **добавить** |
| `CLOUDRU_API_BASE`, `YANDEX_API_BASE` | dev-compose | значения раздела 2.2 | **добавить** |
| `P3_LLM_SMOKE_MODELS` | `verify:llm-gateway` | пусто | **добавить** |
| `CODEX_VERSION` | не переменная, константа в скрипте | — | — |
| `YANDEX_FOLDER_ID`, `YANDEX_API_KEY`, `CLOUDRU_API_KEY` | compose LiteLLM (`:82-84`) | как сейчас | есть |
| `RADITI_DOCKER_TEST_UPSTREAM_HOST` | больше не нужен `verify` (фейк в compose) | — | оставить для P2 |

`infra/app/env.example`:
- `LITELLM_IMAGE=git.raditi.ru/mirror/litellm-non_root:v1.103.0@sha256:fda2894415d89350ca6a16195c935726382354d2194ebb1ce43e6bd5480b06ce`
- `LLM_GATEWAY_IMAGE=git.raditi.ru/raditi/gateway@sha256:<digest>`
- `LLM_INGRESS_PUBLISH=4000`
- `LLM_INGRESS_CLIENTS=10.10.1.11/32`
- `YANDEX_FOLDER_ID=<id каталога>`
- `# COMPOSE_PROFILES=llm — only after M10 (vault-agent, DOCKER-USER)`

## 14. Правки документов

**`docs/spec.md`:**
- `:170`, `:625`, `:978`, `:1056`: «LiteLLM 1.103.0 (`litellm-non_root`, по digest; по advisories не ниже 1.94.0: CVE-2026-59822 из KEV, CVE-2026-84377)».
- `:406`: ключ и токен хода лежат в Vault `turns/` до `deadline_at` + grace; в LiteLLM ключ живёт до конца работы агента.
- `:503`: текст из раздела 4.3 (ранний отзыв, блокировка, повтор раз в минуту, `/key/info`).
- `:536`: реализация — P3 (`GatewayTurnCredentials`), проверка токена MCP — P6.
- `:614`: GigaChat — «GigaChat-2-Max; GigaChat-3-Ultra юрлицам недоступна; в MVP — через Cloud.ru после их ответа или через gpt2giga (P14)».
- `:620`: мост и ключ; `:622`: учёт — опрос `/spend/logs/v2` по хешу ключа, состояния `pending/synced/drift/lost`, карантин, идемпотентность по `litellm_call_id` со сверкой `request_id`; callback не используем (раздел 5.1).
- `:626`: LiteLLM только во внутренних сетях, выход — через `llm-egress` с белым списком двух хостов, DOCKER-USER для `rd-llmout` и `rd-llmin`; `llm-ingress` с рекурсивной политикой тела; всё в профиле `llm` до M10.
- Таблица классов: из heavy убрать Qwen3 235B.
- **§15:**
  - `:831` — mount `turns/`;
  - `kv/llm/<provider>` читает vault-agent;
  - `:841` — клиент KV v2 и `turns/` в P3;
  - `:847` — `core`: `turns/` (create/read/delete данных, update метаданных, deny `undelete` и `destroy`), `kv/llm/*` не читает;
  - снапшоты Raft с `turns/` — хранение внутри Vault;
  - роли PostgreSQL: таблицы учёта только у `raditi_core`.
- **§16** `:880`, `:888`, `:890`: `llm_keys` с `task_attempt` и состоянием учёта, `token_usage.key_id` и `gateway_request_id`, `token_usage_rejects`, составной FK цены, `task_turns` без хеша.
- **§17** `:940`: формула бюджета на попытку (раздел 4.1); потолки на квоте; списание только после закрытия учёта попытки; `drift` и `lost` — к оператору; перерасход ключа — не больше ошибки оценки одного вызова, его берёт платформа.
- **§18** — отступление: выход LiteLLM через прокси, а не только DOCKER-USER.
- **§19** `:1008-1009`, `:1025`: сервисы, сети `rd-llmout` и `rd-llmin`, порт 4000, профиль `llm`, runbook смены LiteLLM.
- **§20:** `:1051` — меры раздела 6.2; `:1096` и `:1102` решены в P3; новый открытый вопрос — `HTTPS_PROXY` и транспорт LiteLLM до синтетической проверки.

**`CLAUDE.md`:**
- «Состояние» — абзац о P3;
- «Стек» — LiteLLM 1.103.0, `llm-gateway` в адаптерах;
- «Как писать код» — «`llm-gateway` — litellm»;
- «Команды» — `pnpm --filter orchestrator verify:llm-gateway`;
- «Структура» — `orchestrator/src/llm`, `infra/app/litellm`, `infra/vault/policies`, `infra/dev/llm-verify`;
- «Где что читать» — `docs/research/2026-09-p3/`;
- правило 5 — сеть LiteLLM.

**`docs/plan/roadmap.md`:**
- `:24` P3: «LiteLLM 1.103.0 … мост для Cloud.ru; GigaChat — через Cloud.ru или gpt2giga (P14); app-ВМ — в профиле `llm`, включение в M10». После проверки — `[x]` со ссылкой на `05-p3-verification.md`.
- `:28` P7: KV v2 и `turns/` сделаны в P3.
- P12: бюджет ключа по формуле §17, признак исчерпания, `task_turns` до `issue`.
- `:57` M5: списание после закрытия учёта попытки; `drift` и `lost`; ночная сверка; «не выставлять» потерянные попытки.
- M6: служебные ключи.
- M10: включить профиль `llm`, DOCKER-USER для `rd-llmout` и `rd-llmin`.

**`docs/plan/05-p3-verification.md`:** «Реализовано», «Проверки и повтор», «Мост: что увидели на фейке и в Codex», «Синтетическая проверка владельца», «Незакрытое».

## 15. Коммиты

Conventional Commits на английском, все — задача P3.

1. `docs: add P3 research on LiteLLM, providers and turn credentials`
2. `feat(domain): add LlmGateway port, turn credential grant and LLM call cost`
3. `feat(vault): add a write-once KV v2 client and the turns mount for per-turn credentials` — `kv.ts`, `session.ts`, `core-turns.hcl`, `vault-init` в dev
4. `feat(db): add llm_keys, usage states and the token_usage reject quarantine` — миграция, schema, сиды `prices[]`, CHECK-тесты
5. `feat(llm-gateway): add the LiteLLM adapter with Decimal amounts and windowed spend log reads`
6. `feat(sandbox): recursive LLM request policy, the LLM ingress and the LLM egress proxy` — политика, `gateway.mjs` (буфер, 10 мин), `llm-ingress`, `llm-egress`, Dockerfile
7. `feat(infra): pin LiteLLM 1.103.0 in dev with explicit RUB prices and fail-closed budgets` — `config.yaml`, dev compose, удаление `litellm.config.yaml`, тест конфига
8. `feat(orchestrator): issue, block and revoke per-turn credentials through Vault and LiteLLM` — `turn-credentials`, сборщик, сверка цен, супервизор, попытка, recovery, конфиг ролей
9. `feat(orchestrator): ingest the LiteLLM spend log into token_usage with usage states`
10. `test(orchestrator): verify the LLM gateway against a fake upstream and Codex CLI` — скрипт, `infra/dev/llm-verify`, CI
11. `feat(infra): run LiteLLM on the app VM behind the llm profile` — compose, `entrypoint.sh`, `postgres-init.sh`, `preflight.sh`, права в `init-roles.sh`, тесты compose и preflight, README
12. `docs: update spec, CLAUDE.md and roadmap for P3; add the verification report`

**Проверки перед каждым коммитом:**
- затронутые пакеты — `pnpm typecheck && pnpm lint && pnpm test`;
- `pnpm check-architecture`, `pnpm check-env`, `pnpm test:infra`;
- после коммитов 4, 8 и 9 — `DATABASE_URL=postgresql://raditi:raditi@localhost:5432/raditi pnpm --filter @repo/db test` и тесты orchestrator с базой;
- после 10 — `pnpm --filter orchestrator verify:llm-gateway`;
- перед 12 — синтетическая проверка владельца и `/spec-check`.

## 16. Риски и что проверить в PoC

- **1.103.0 вышла 28.09**, в один день с 1.104.0-rc.1. Стабильные ветки получают бэкпорты. Перед M10 — прогон под нагрузкой и свежий патч 1.103.x.
- **Откат на 1.102.1** возможен только с `gateway_call_id = request_id`: это одна строка адаптера и тест, заранее не делаем. `request_id` там — id ответа провайдера, при его повторе LiteLLM сам теряет строку ([spend_tracking_utils.py L258-270](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/spend_tracking/spend_tracking_utils.py#L258-L270)).
- **Проверяет `verify`:**
  - `os.environ/` в `model` и `extra_headers`;
  - `/key/info` отдаёт `allowed_routes`, `blocked` и удалённые ключи;
  - `fail_closed_budget_enforcement` без Redis;
  - `enforce_model_rate_limits` без Redis;
  - `disable_cooldowns`;
  - форма строк `/spend/logs/v2`, `sort_order=asc`, фильтр по секундам;
  - `spend > 0` у потоков (#42161);
  - цена кэша (#27191);
  - старт `non_root` с `read_only`, tmpfs и `--use_v2_migration_resolver`;
  - строки `budget_exceeded` в журнале;
  - `/model/info` с ценами.
- **`HTTPS_PROXY`.** Учитывает ли его транспорт LiteLLM (httpx и aiohttp), закрывает только синтетическая проверка владельца. Если нет — выход LiteLLM не работает вовсе, то есть отказ безопасный. Тогда нужен выбор владельца: локальный TLS-прокси или DOCKER-USER с ipset (вопрос 15).
- **Недобор бюджета** — до резерва одного вызова (около 47 ₽ на Kimi при 200 тыс. входа). Перерасход — до ошибки оценки входа (около 10 ₽).
- **Белый список ломает CLI.** Codex проверяется в `verify`. Kimi Code (P5) расширяет список с тестами. Отказ виден по полю в логе.
- **Потолок вывода 16384** может обрезать длинный reasoning у тяжёлых моделей. Если Codex получит `incomplete`, это будет видно в P4, а потолок — параметр `llmKeyLimits` (вопрос 1).
- **Обрыв клиента** не даёт строки журнала. Потеря — вход до двух вызовов, её закрывает сверка M5.
- **Ключ администратора с ограниченными маршрутами** невозможен при `upperbound_key_generate_params` (раздел 18, п. 1). Мастер-ключ живёт только у `core` в `llm-core`.

## 17. Открытые вопросы владельцу

1. **Потолок вывода и fail-closed бюджет.** 16384 токена на запрос. Ключ «кончается», когда остаток меньше резерва следующего вызова; перерасход — не больше ошибки оценки входа одного вызова. **По умолчанию — так, 16384.**
2. **Учёт.** Только опрос `/spend/logs/v2`, spec §9 меняется. **По умолчанию — да.**
3. **Хранение ключей хода.** Mount `turns/` с потолком 25 минут, запись один раз. **По умолчанию — да.**
4. **GigaChat.** В P3 не подключаем: это сужает `roadmap.md:24`. Позже — через Cloud.ru или gpt2giga (P14). **По умолчанию — не подключаем.**
5. **Модели.** Убрать Qwen3 235B и не добавлять новые до eval P15. **По умолчанию — да.**
6. **Потолок себестоимости на тарифе с квотой.** На попытку: 135 / 285 / 735 ₽; ключ — не больше 750 ₽. Когда потолок исчерпан — `awaiting_user` с предложением продолжить как новую правку. **По умолчанию — так**, окончательно решает P12 или M5.
7. **Служебные вызовы.** Схема ключей и кто платит за классификацию — M6. В P3 их нет. **По умолчанию — M6.**
8. **Мастер-ключ LiteLLM у `core`,** только в сети `llm-core`. Процесс `mcp` с `LITELLM_*` не стартует. **По умолчанию — да.**
9. **Отзыв при недоступном шлюзе.** Тайм-аут 5 с, аренда освобождается, повтор раз в минуту, ключ истекает до `deadline_at` − 3 мин. **По умолчанию — да.**
10. **Политика тела.** Встроенные инструменты запрещены, `store:false` обязателен, изображения только `data:`, Codex-метаданные вырезаются. **По умолчанию — да.**
11. **Срок хранения журнала LiteLLM** — 45 дней, промпты не хранятся. **По умолчанию — 45 дней.**
12. **`task_turns.litellm_key_hash`** удалить. **По умолчанию — удалить.**
13. **uid 70** у обоих PostgreSQL на app-ВМ. **По умолчанию — принять.**
14. **CI `llm-gateway.yml`** со скачиванием LiteLLM из GHCR и Codex из npm. **По умолчанию — включить, не обязательный для merge.**
15. **Выход LiteLLM через `llm-egress`,** а DOCKER-USER только для моста прокси. Это отступление от `spec.md:626`, записывается в §18. **По умолчанию — да.** Если `HTTPS_PROXY` не заработает — DOCKER-USER с ipset.
16. **app-ВМ в профиле `llm`,** включение в M10. **По умолчанию — да.**
17. **Закрытие P3** — после синтетической проверки владельца на Cloud.ru и Yandex (usage в потоке, `spend > 0`, CONNECT). **По умолчанию — да.**
18. **Списание при `done`** ждёт закрытия учёта попытки (до 11 мин после отзыва); `drift` и `lost` — к оператору. **По умолчанию — да, M5.**
19. **Ключи провайдеров для dev** — в отдельном каталоге Yandex и отдельном проекте Cloud.ru. **По умолчанию — да.**
20. **LLM-запрос в шлюзах** ограничен 10 минутами (было 20). **По умолчанию — да.**

## 18. Отклонённые замечания

1. **S4, ключ администратора с `allowed_routes` для `core` уже в P3.** Отклонено. `_enforce_upperbound_key_params` применяется к каждому `/key/generate`, включая вызов мастер-ключом ([key_management_endpoints.py L1103-1162, L1256](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/management_endpoints/key_management_endpoints.py#L1256)). Ключ администратора получил бы срок не больше 20 минут и бюджет не больше 750, то есть пришлось бы убрать предохранитель. Что закрывает риск:
   - сеть `llm-core`;
   - прокси выхода: callback, добавленный через `/config/update`, никуда не достучится;
   - `store_model_in_db: false`;
   - запрет `LITELLM_*` для `mcp`.
   Вторая часть S4 (`mcp`) принята.
2. **S1, закрыть `/v1/chat/completions` до P5.** Отклонено. Рекурсивная политика закрывает chat так же, как Responses. Путь уже есть в белом списке `sandbox-gw` P2, он нужен P5 и проверяется в `verify`, а флаг «chat выключен» добавил бы расхождение конфигов.
3. **S14, обязательный случайный мастер-ключ в dev.** Отклонено частично. Compose не умеет требовать переменную только для одного профиля: `${VAR:?}` ломает все команды. Путь из браузера закрывает `LITELLM_CORS_ORIGINS`: запрос с `Authorization` требует preflight, а preflight не пройдёт. Прод отвергает `sk-raditi-dev`. Совет `openssl rand` — в `.env.example`.
4. **M3, «останавливать агента до истечения ключа».** Отклонено. Остановка агента обрывает идущие вызовы так же, как истечение срока, и потеря входа остаётся. Принято: счёт обрывов и сверка M5.
5. **M4, ранняя финализация через `revoked_at + 2 × proxy_batch_write_at`.** Отклонено. Вызов без потока продолжается в LiteLLM и после ухода клиента, до `request_timeout`, а узнать, что таких вызовов нет, нельзя. Оставлено 11 минут при 10-минутном потолке запроса. Задержку списания закрывает правило «списывать после закрытия учёта».
6. **M7, уникальность по `request_id` или по паре.** Отклонено. `request_id` — id ответа провайдера: уникальность по нему молча отбросила бы законную строку при совпадении. Принято: уникален `litellm_call_id` (его ставит LiteLLM, заголовок режут шлюзы), `request_id` хранится, повтор с другим содержимым уходит в карантин и `drift`.
7. **M6, `workspace_id` и `task_id NULL` у служебных ключей.** Снято вместе со служебными ключами: схему делает M6.
8. **M10, порог `max_input_tokens × p_in + max_output_tokens × p_out` для `turnBudgetOutcome`.** Функция уходит в P12. В spec записаны главный признак (строки `budget_exceeded`) и запасной порог с оценкой входа вместо `max_input_tokens`. Порог по `max_input_tokens` объявлял бы ключ исчерпанным слишком рано.
9. **O17, отдельные этапы P3a и P3b.** Отклонено частично: новые ID в roadmap не вводим. app-ВМ — отдельный коммит 11 и профиль `llm`, включение в M10.
10. **O5, «каждый `up -d` теряет очередь».** Уточнено: compose пересоздаёт LiteLLM только при смене его образа, конфига или переменных. Runbook со сливом нагрузки и флаги остановки приняты.
11. **O1, вариант «источник истины — строки, проверять только `Σ строк ≥ spend`».** Не выбран. Блокировка вместо удаления сохраняет точную сверку, и потерю строки видно.
12. **S6, отзыв в `#park` для всех причин.** Отклонено частично: при `driver unavailable` следующий `core` может возобновить ход с драйвером. Для остальных причин принято.
13. **O16, «`172.17.0.1` откроет фейк в локальную сеть».** Снято: фейк работает в контейнере внутри стека проверки.

## 19. Как разрешены замечания

| Замечание | Решение | Раздел |
| --- | --- | --- |
| S1 выход через URL в теле, DNS | рекурсивная политика, только `data:`, LiteLLM без внешних сетей, `llm-egress` | 2.1, 2.5, 2.6, 10 п. 2, 8 |
| S2 LiteLLM без ограничений выхода до M10 | только internal-сети, профиль `llm`, preflight проверяет DOCKER-USER | 2.4 |
| S3 `kvCreateOnce` и 403 | данные с `cas=0`, потом метаданные; `createdTime` у сборщика; тест 403 | 4.2, 4.4, 10 п. 3 |
| S4 мастер-ключ | `mcp` без `LITELLM_*`; ключ администратора отклонён | 3, 18 п. 1 |
| S5 права web и привязка `recover` | права в `init-roles.sh`, сверка хеша и отзыва | 4.3, 11 |
| S6 поздний отзыв | таблица «Где вызывается», `revoke_requested_at`, повтор раз в минуту | 4.3, 4.4 |
| S7, O12 `store` | обязательно `false` | 2.5 |
| S8, M14, O14 лимиты | `upperbound` = `llmKeyLimits`, tpm 4 млн | 2.2, 3, 8 |
| S9 префиксы `allowed_routes` | зафиксировано, прямой вызов в `verify` | 4.1, 10 п. 8 |
| S10 «25 минут» и `kvDestroy` | формулировка, `kvDestroy` после `expires_at`, deny `undelete` и `destroy` | 4.2, 4.3 |
| S11, O16 секреты и preflight | bash-цикл без `.`, `check_secrets`, том, образы | 2.2, 2.4 |
| S12 логи и лимит на клиента | `unknown`, 16 с одного адреса, сценарий `echo-400` | 2.5, 10 п. 6 и 17 |
| S13 `prompt_cache_key` | замена значением от ключа | 2.5 |
| S14 CORS в dev | `LITELLM_CORS_ORIGINS` | 2.2, 18 п. 3 |
| M1, O3 «перерасхода нет» | fail-closed, потолок вывода в теле, `max_input_tokens`, честная оценка | 2.2, 2.5, 4.1 |
| M2 `disable_error_logs` | `false`, сценарии `mid-stream-error` и `echo-400` | 2.2, 10 п. 6 |
| M3 обрыв клиента | `aborted`, шаг 13, сверка M5 | 5.5 |
| M4 задержка учёта и деньги | списание после закрытия учёта, `spendRub` для `pending` | 4.1, 5.2 |
| M5 потолок на ключ, попытка | `task_attempt`, потолок на попытку, `ROUND_DOWN`, единицы — себестоимость | 4.1, 11 |
| M6 служебные ключи | в M6 | 1, 18 п. 7 |
| M7, O10 идемпотентность | `call_id` и `request_id`, карантин `duplicate_call_id`, инвариант заголовков | 3, 5.3 |
| M8, O8 пагинация | `asc`, окна без OFFSET | 3 |
| M9 отклонённые строки | `token_usage_rejects`, `reasoning ≤ output`, составной FK | 5.3, 11 |
| M10 `number` в домене | Decimal-строки на границе | 3 |
| M11 история цен | сверка `/model/info` при выдаче, `prices[]`, runbook | 2.4, 4.3, 7 |
| M12 повтор `issue` | бюджет и срок из строки, сверка `max_budget` | 4.3 |
| M13 инструменты Yandex | формулировка, алерт в M5 | 5.4 |
| O1 сверка после `/key/delete` | `/key/block`, удаление после закрытия учёта | 4.3 |
| O2 нет конечного состояния | `pending/synced/drift/lost` | 5.2 |
| O4 `key_type` | не передаётся, проверка `allowed_routes` | 3, 10 п. 5 |
| O5 перезапуски и миграции | флаги, `stop_grace_period`, `init`, runbook, шаг 12 | 2.2, 2.4 |
| O6 `rpm` | `enforce_model_rate_limits`, 429 у Yandex | 2.2, 8 |
| O7 выход шире spec | `llm-egress` | 2.6 |
| O9 окно финализации | 10 мин на запрос, ожидание стабильности | 2.5, 5.2, 10 п. 15 |
| O11 проверка честнее | Codex, изоляция сети, перезапуск, отзыв, `big-output`, `dup-id`, проверка владельца | 10 |
| O13 cooldown | `disable_cooldowns` | 2.2 |
| O15 строки отказов | нулевые строки раньше схемы | 3, 5.3 |
| O17 объём | служебные ключи — M6, сверка — M5, бюджет — P12, app-ВМ — профиль | 0, 1 |

## Источники

- **LiteLLM, выпуски и безопасность:** [releases](https://github.com/BerriAI/litellm/releases), [advisories](https://github.com/BerriAI/litellm/security/advisories), [GHSA-3cv6](https://github.com/BerriAI/litellm/security/advisories/GHSA-3cv6-jpf6-8222), [GHSA-4xpc](https://github.com/BerriAI/litellm/security/advisories/GHSA-4xpc-pv4p-pm3w), [CVE-2026-59822](https://advisories.gitlab.com/pypi/litellm/CVE-2026-59822/), [CVE-2026-42208](https://docs.litellm.ai/blog/cve-2026-42208-litellm-proxy-sql-injection), [безопасность образов](https://docs.litellm.ai/docs/proxy/docker_image_security).
- **LiteLLM v1.103.0, исходники:**
  - [budget_reservation.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/spend_tracking/budget_reservation.py), [proxy_track_cost_callback.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/hooks/proxy_track_cost_callback.py), [user_api_key_auth.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/auth/user_api_key_auth.py);
  - [key_management_endpoints.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/management_endpoints/key_management_endpoints.py), [spend_management_endpoints.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/spend_tracking/spend_management_endpoints.py), [spend_tracking_utils.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/spend_tracking/spend_tracking_utils.py), [db_spend_update_writer.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/db/db_spend_update_writer.py);
  - [route_checks.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/auth/route_checks.py), [common_request_processing.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/common_request_processing.py), [proxy_server.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/proxy_server.py), [proxy_cli.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/proxy_cli.py);
  - [utils.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/utils.py), [token_counter.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/litellm_core_utils/token_counter.py), [url_utils.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/litellm_core_utils/url_utils.py);
  - [мост Responses](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/responses/litellm_completion_transformation/transformation.py), [generic_api_callback.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/integrations/generic_api/generic_api_callback.py), [cooldown_handlers.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/router_utils/cooldown_handlers.py), [client_initalization_utils.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/router_utils/client_initalization_utils.py);
  - [gigachat/authenticator.py](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/llms/gigachat/authenticator.py), [schema.prisma](https://github.com/BerriAI/litellm/blob/v1.103.0/schema.prisma), [Dockerfile.non_root](https://github.com/BerriAI/litellm/blob/v1.103.0/docker/Dockerfile.non_root).
- **LiteLLM, issues и PR:** [#35524](https://github.com/BerriAI/litellm/issues/35524), [#42161](https://github.com/BerriAI/litellm/issues/42161), [#27191](https://github.com/BerriAI/litellm/issues/27191), [#41291](https://github.com/BerriAI/litellm/pull/41291).
- **LiteLLM, документация:** [virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys), [custom pricing](https://docs.litellm.ai/docs/proxy/custom_pricing), [spend logs deletion](https://docs.litellm.ai/docs/proxy/spend_logs_deletion), [/responses](https://docs.litellm.ai/docs/response_api), [prod](https://docs.litellm.ai/docs/proxy/prod), [health](https://docs.litellm.ai/docs/proxy/health).
- **Codex:** [codex-api/src/common.rs](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/common.rs), [core/src/client.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs).
- **OpenBao:** [path_data.go](https://github.com/openbao/openbao/blob/main/internal/builtin/logical/kv/path_data.go), [KV v2 API](https://github.com/openbao/openbao/blob/main/website/content/docs/api/secret/kv/kv-v2.mdx), [audit](https://openbao.org/docs/audit/), [policies](https://openbao.org/docs/concepts/policies/).
- **Провайдеры:**
  - Cloud.ru: [каталог](https://cloud.ru/docs/foundation-models/ug/topics/overview__available__models), [тариф](https://cloud.ru/documents/tariffs/evolution/foundation-models), [OpenAPI](https://cloud.ru/docs/api/specs/foundation-models/ug/_specs/openapi__foundation-models.yaml);
  - Yandex AI Studio: [модели](https://aistudio.yandex.ru/docs/ru/ai-studio/concepts/generation/models), [логирование](https://aistudio.yandex.ru/docs/en/ai-studio/operations/disable-logging.html), [цены](https://aistudio.yandex.ru/docs/ru/ai-studio/pricing);
  - GigaChat: [GigaChat-3-Ultra](https://developers.sber.ru/docs/ru/gigachat/models/gigachat-3-ultra), [подсчёт токенов](https://developers.sber.ru/docs/ru/gigachat/guides/counting-tokens), [gpt2giga](https://github.com/ai-forever/gpt2giga/blob/main/integrations/codex/README.md).
