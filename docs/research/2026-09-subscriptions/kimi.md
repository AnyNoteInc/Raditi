# Kimi Code CLI на подписке Kimi Code

Исследование от 28.09.2026 к этапу P3. Код Kimi Code CLI смотрели на теге `@moonshot-ai/kimi-code@2.1.1` (коммит `f67e639`, 24.09.2026) — это текущая `latest` в npm; ветка main ушла дальше, к `a940f2f`. `K/` — сокращение для `https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/`; пути без `K/` — от корня нашего репозитория на 28.09.2026. Все ссылки проверены 28.09.2026.

Итоговые решения — в [p3-design.md](p3-design.md), `CLAUDE.md` и `docs/spec.md`. Где заметка с ними расходится, верны решения; расхождения собраны в конце.

## Коротко

- **Технически схема работает.** CLI направляется на наш шлюз переменными `KIMI_MODEL_*`, шлюз подставляет ключ подписки из Vault, в песочнице секрета нет.
- **Условия Kimi Code прямо запрещают все четыре элемента схемы:** перепродажу, неинтерактивную автоматизацию, подмену клиента и раздачу аккаунта через обратный прокси. Это риск блокировки, владелец его принял.
- **Все адреса Kimi — за Cloudflare**, а Cloudflare из России режут. Выход к Kimi — только из-за рубежа.
- **Расход** есть только в потоке ответа (`usage` в последнем чанке), в выводе CLI его нет.
- **Лимиты в числах не опубликованы.** Продажа подписок приостанавливалась 21.07.2026; открыта ли она сейчас, неизвестно.

## 1. Вход и где лежат учётные данные

- **Два способа входа.** Команда `/login` в интерфейсе или `kimi login` без интерфейса (`K/docs/en/reference/kimi-command.md:136-146`):
  - OAuth Kimi Code с кодом устройства (RFC 8628);
  - API-ключ Kimi Open Platform.
- **Флаг региона.** В исходниках у `kimi login` есть `--region mainland-cn|global` (`K/apps/kimi-code/src/cli/sub/login.ts#L18-L23`), в документации его нет.
- **Запросы входа** — три POST с данными формы к хосту входа (`K/packages/oauth/src/oauth.ts#L1-L11`, `#L119-L290`):
  - `/api/oauth/device_authorization`;
  - `/api/oauth/token` с `grant_type=urn:ietf:params:oauth:grant-type:device_code`;
  - `/api/oauth/token` с `grant_type=refresh_token`.
- **`client_id`** — `17e5f671-d194-4dfb-9706-5516cb48c098` (`K/packages/oauth/src/constants.ts#L3-L21`).
- **Регионы** (`K/packages/oauth/src/region.ts#L61-L77`):

  | Регион | Хост входа | Адрес API |
  | --- | --- | --- |
  | `mainland-cn` | `auth.kimi.com` | `https://api.kimi.com/coding/v1` |
  | `global` | `auth.kimi.ai` | `https://api.kimi.ai/coding/v1` |

- **Где лежат токены.** `$KIMI_CODE_HOME/credentials/<name>.json` (по умолчанию `~/.kimi-code`), права 0600, каталог 0700 (`K/packages/oauth/src/storage.ts#L1-L13`, `K/packages/oauth/src/toolkit.ts#L125-L127`):
  - для Китая файл называется `kimi-code.json`, для других хостов — `kimi-code-env-<16hex>.json` (`toolkit.ts#L465-L485`, `managed-kimi-code.ts#L324`);
  - поля: `access_token`, `refresh_token`, `expires_at`, `expires_in`, `scope`, `token_type`.
- **Идентификатор устройства** — случайный UUID в `$KIMI_CODE_HOME/device_id`. Он уходит в заголовках `X-Msh-Device-Id`, `X-Msh-Platform: kimi_code_cli`, `X-Msh-Version`, `X-Msh-Device-Name` (имя хоста) и других (`K/packages/oauth/src/identity.ts#L41-L91`).

## 2. Время жизни токенов и обновление

- **Access-токен живёт 15 минут.** Срок отдаёт сервер в `expires_in`; реальные значения `expires_in: 900`, `scope: kimi-code` — в отчёте пользователя [kimi-code#3410](https://github.com/MoonshotAI/kimi-code/issues/3410) (31.08.2026).
- **Когда CLI обновляет токен.** Лениво, перед запросом, если до истечения меньше `max(300 с, 50% × expires_in)` (`K/packages/oauth/src/oauth-manager.ts#L27-L36`). Между процессами — блокировка `$KIMI_CODE_HOME/oauth/<name>.lock` (`#L176-L235`), на Windows её нет.
- **Refresh-токен одноразовый.** При обновлении сервер выдаёт новый, старый перестаёт работать; гонка двух обновлений разлогинивает ([kimi-code#3186](https://github.com/MoonshotAI/kimi-code/issues/3186)). Ответы 401, 403 и `invalid_grant` значат «войти заново».
- **Срок refresh-токена неизвестен.** Известно только, что устройство, неактивное больше 30 дней, отвязывается ([membership](https://www.kimi.com/code/docs/en/kimi-code/membership.html)).

## 3. Адреса и формат запросов

Сервер понимает три протокола ([models](https://www.kimi.com/code/docs/en/kimi-code/models.html), [Codex guide](https://www.kimi.com/code/docs/en/third-party-tools/codex.html)):
- **OpenAI Chat Completions** — `https://api.kimi.ai/coding/v1/chat/completions` (для Китая — `api.kimi.com`);
- **OpenAI Responses** — `…/coding/v1/responses`. Заявлен для Codex CLI с `wire_api="responses"`: Codex тоже может работать на этой подписке;
- **Anthropic** — базовый адрес `https://api.kimi.ai/coding/`.

Служебные пути: `/models`, `/usages`, `/me`, `/feedback`, `/search`, `/fetch` (`K/packages/oauth/src/managed-kimi-code.ts#L498`, `#L633-L638`).

Модели: `k3`, `k3-256k`, `kimi-for-coding` (K2.8 Preview), `kimi-for-coding-highspeed`. Уровень рассуждения — `low`, `high`, `max`; неизвестное значение даёт 400.

Тип провайдера `kimi` в CLI — Chat Completions с расширениями Moonshot (`K/packages/agent-core-v2/src/human/llm-kimi/trait.ts#L15-L89`):
- `thinking: {type, effort, keep}`;
- `reasoning_content` в сообщениях ассистента обязателен при включённом рассуждении, иначе 400;
- `prompt_cache_key`, `max_completion_tokens`;
- инструменты типа `builtin_function` (имена на `$`);
- `tools` внутри системного сообщения, `tool_calls[].extras`;
- `stream_options.include_usage: true` (`…/requester/bases/openai/format.ts#L193`).

## 4. Подстановка ключа подписки на шлюзе

- **Через переменные `KIMI_MODEL_*`.** В песочнице задаются `KIMI_MODEL_NAME`, `KIMI_MODEL_PROVIDER_TYPE=kimi`, `KIMI_MODEL_BASE_URL=<sandbox-gw>` и `KIMI_MODEL_API_KEY=<ключ хода>` (`K/docs/en/configuration/env-vars.md:104-133`). Шлюз меняет `Authorization` на ключ подписки из Vault и отправляет запрос на `api.kimi.ai/coding/v1`. Это совпадает с нашим драйвером (`packages/agent-drivers/src/kimi.ts:13-17`).
- **Какой ключ хранить в Vault.** API-ключ из консоли Kimi Code: до 5 ключей на аккаунт, каждый показывается один раз ([документация Kimi Code](https://www.kimi.com/code/docs/en/)). Это официальный путь для сторонних инструментов, квота та же, что при входе через OAuth.
  - С OAuth шлюзу пришлось бы самому обновлять одноразовый refresh-токен каждые 15 минут от имени чужого `client_id`.
  - Вариант с `KIMI_CODE_BASE_URL` требует файла токенов внутри песочницы — нарушение правила 2.
- **Заголовки клиента шлюз пропускает.** Для провайдера `kimi` CLI шлёт `User-Agent: kimi-code-cli/2.1.1` и все `X-Msh-*` (`K/packages/agent-core-v2/src/llm-adapter/provider/provider-definition.ts#L224-L254`, `…/model/catalog-service.ts#L493-L502`).
  - Сейчас `infra/sandbox/gateway.mjs:51-58` пропускает только `authorization`, `content-type` и `accept`. Kimi запрещает менять User-Agent и считает это нарушением ([benefits](https://www.kimi.com/en/help/kimi-code/benefits)).
  - По той же причине опасен LiteLLM как промежуточное звено: он шлёт свой User-Agent. Пропускает ли он заголовки клиента, не проверяли.
- **`device_id` в песочнице каждый ход новый.** Файл лежит в корне `KIMI_CODE_HOME`, а он не входит в снимок сессии (`packages/agent-drivers/src/kimi.ts:37-45`). Лучше закрепить свой `device_id` за каждым аккаунтом пула — секретом он не является.
- **Что поменять в проекте P3 на LiteLLM** ([p3-litellm-design.md](p3-litellm-design.md)):
  - §2.5: добавить в белый список поля Kimi из раздела 3, запретить `builtin_function`;
  - там же: `prompt_cache_key` выводить из id задачи, а не из ключа хода — иначе кэш между ходами пропадает и квота тратится быстрее;
  - §2.6: разрешить `api.kimi.ai:443` в белом списке прокси выхода;
  - `/models` с нашим базовым адресом CLI, по коду, не вызывает (`K/packages/oauth/src/managed-usage.ts#L25-L35`) — проверить на настоящем аккаунте.

## 5. Тарифы и лимиты

- **Тарифы.** Новые — Go, Plus, Pro, Max, Ultra; у Go квоты на Kimi Code нет. Старые — Andante, Moderato, Allegretto, Allegro. K3 и Kimi Code — с Plus, окно 1M и HighSpeed — с Pro ([membership](https://www.kimi.com/code/docs/en/kimi-code/membership.html), [error reference](https://www.kimi.com/code/docs/en/kimi-code/error-reference.html)).
- **Цены** официально известны для старых тарифов:
  - международные: Moderato $19, Allegretto $39, Allegro $99, Vivace $199 ([kimi.ai help](https://www.kimi.ai/help/membership/membership-overview));
  - китайские: ¥49, ¥99, ¥199, ¥699 ([help](https://www.kimi.com/en/help/membership/membership-pricing)).
  - О новых тарифах сказано «цены не меняются». Оценка: Plus ≈ $19, Pro ≈ $39, Max ≈ $99, Ultra ≈ $199. Это вывод, не подтверждено.
- **Лимиты.** Скользящее окно 5 часов плюс месячная квота, общая со всей подпиской Kimi. Недельная квота осталась только у старых тарифов. Все устройства и ключи делят одну квоту. После исчерпания можно докупать Extra Usage в юанях, примерно по цене Open Platform.
- **Коды ошибок:**

  | Код | Что значит |
  | --- | --- |
  | 403 | исчерпано окно 5 часов, неделя или месяц |
  | 403 «concurrent request limit» | ограничение службы риска, снимается только обжалованием |
  | 429 | слишком много запросов или перегрузка, в пик 14:00–17:00 по будням |
  | 402 | подписку не удалось проверить |

- **Чисел нет.** Сколько запросов в окне и сколько одновременных запросов разрешено, официально не раскрыто. `/usages` отдаёт проценты.
- **Остаток квоты.** `GET {base}/usages` возвращает `usages.limit_5h|limit_7d|limit_month_total|limit_month_code.{used_ratio,reset_time}` и `boosterWallet` (`K/packages/oauth/src/managed-usage.ts#L60-L125`). Известен баг: `limit_7d.used_ratio=0`, хотя неделя исчерпана ([kimi-code#3951](https://github.com/MoonshotAI/kimi-code/issues/3951)). Опираться только на 403.
- **Продажа приостанавливалась.** 21.07.2026 Moonshot остановила новые подписки из-за нехватки мощностей и обещала открывать места партиями ([Korea Times / SCMP, 21.07.2026](https://www.koreatimes.co.kr/world/20260721/kimi-k3-developer-suspends-new-subscriptions-amid-compute-constraints)). Открыта ли покупка сейчас, неизвестно.

## 6. Расход токенов для учёта

- **Что есть в ответе.** Chat Completions: `prompt_tokens`, `completion_tokens` и `cached_tokens` — в корне (поле Moonshot) или в `prompt_tokens_details.cached_tokens`.
- **Где в потоке.** В последнем чанке — `usage` в корне или `choices[0].usage` (`…/requester/bases/openai/format.ts#L125-L135`, `extractUsage` в `llm-kimi/trait.ts`).
- **В выводе CLI расхода нет.** Режим `stream-json` его не печатает (`K/apps/kimi-code/src/cli/prompt-render.ts#L149`): считаем только на шлюзе.
- **Токены не равны квоте.** HighSpeed тратит квоту в 3 раза быстрее, `k3` с окном 1M — примерно в 2 раза быстрее `k3-256k`. Потолки попытки придётся считать через условную цену токена и сверять с изменением `used_ratio`.

## 7. Доступ из России и оплата

- **Сеть.** `api.kimi.ai`, `auth.kimi.ai`, `api.kimi.com` и `auth.kimi.com` указывают на Cloudflare (`dig`, 28.09.2026). Российские провайдеры режут соединения с Cloudflare после 16 КБ ([Cloudflare, 26.06.2025](https://blog.cloudflare.com/russian-internet-users-are-unable-to-access-the-open-internet/)). Жалобы пользователей из России, без ответа Moonshot:
  - [Kimi-K2#46](https://github.com/MoonshotAI/Kimi-K2/issues/46): сайт не работает без VPN, кода +7 при регистрации нет;
  - [kimi-cli#1201](https://github.com/MoonshotAI/kimi-cli/discussions/1201) (02.2026): сбои соединения с API.

  Вывод: выход к Kimi — из-за пределов России. Прямой прокси (VPN) правила Kimi разрешают.
- **Оплата.** Российские карты не проходят, пользуются посредниками ([DTF, 31.07.2026](https://dtf.ru/howto/5215807-kak-kupit-podpisku-kimi-code-i-kimi-k3-api-iz-rossii) — вторичный источник). Договор платных услуг (редакция от 31.08.2026, п. 61): при оплате через неофициальный канал баланс могут заморозить, а аккаунт — заблокировать; деньги не возвращают (п. 64, 70).

## 8. Условия использования

- **Правила Kimi Code** ([community guidelines](https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html)):
  - подписка — «for interactive use only»;
  - не перепродавать аккаунт или доступ к API;
  - не перепродавать возможности Kimi как услугу;
  - не подменять данные клиента;
  - «Don't use Kimi Code for non-interactive automation»;
  - раздача аккаунта через обратный прокси — нарушение;
  - покупка через посредников — возможная блокировка.
- **Страница [benefits](https://www.kimi.com/en/help/kimi-code/benefits):** только для личной разработки, не для бизнеса.
- **Как выявляют.** Служба риска смотрит на IP, поведение в диалогах и объём использования. Пул аккаунтов с одного выходного IP — заметный сигнал.
- **Пользовательское соглашение** ([CN v2, с 31.08.2026](https://www.kimi.com/user/agreement/modelUse?version=v2)):
  - §2.2 и §4.1(4): нельзя передавать, одалживать или сдавать аккаунт;
  - §4.6(5): нельзя использовать скрипты для автоматической пакетной работы;
  - §4.6(8): нельзя перепродавать или сублицензировать сервис.
  - Английская редакция условий датирована 05.01.2024 и запрещает коммерческое использование без письменного согласия.
- **Санкции Kimi** — ограничение одновременных запросов (403) или блокировка без компенсации.

## 9. Неинтерактивный режим и файлы сессии

- **Запуск.** `kimi -p "<задача>" --output-format stream-json [--session <id>]`. С `-p` нельзя `--yolo`, `--auto` и `--plan`: режим по умолчанию — `auto` (`K/docs/en/reference/kimi-command.md:16-44,112-132`).
- **Вывод.** Сообщения Assistant и Tool; рассуждения не выводятся, служебное уходит в stderr.
- **Файлы сессии.** `KIMI_CODE_HOME/sessions/<wd_slug_sha12>/<id>/{state.json,agents/main/wire.jsonl}` и `session_index.jsonl` (`K/docs/en/configuration/data-locations.md`). Совпадает с `packages/agent-drivers/src/kimi.ts:37-45`.
- **Переменные для песочницы:**
  - `KIMI_DISABLE_TELEMETRY=1`, `KIMI_CODE_NO_AUTO_UPDATE=1` — телеметрия и обновления;
  - `KIMI_CODE_BUILTIN_PRODUCT_SKILLS=0`;
  - `auto_session_title=false` — иначе тратятся лишние вызовы;
  - `[secondary_model]` позволяет подагентам ходить к другим моделям, поэтому на шлюзе нужен белый список моделей.

## 10. Что устарело в репозитории

Строки — на 28.09.2026:
- `docs/spec.md:58`, `:600`, `:647`, `:1052`, `:1137` — «Kimi-K2.6 в Cloud.ru», «подписку не используем»;
- `docs/plan/roadmap.md:26` — P5 на Cloud.ru;
- `packages/agent-drivers/src/kimi.ts:8-19` — ключ LiteLLM и Cloud.ru;
- `infra/sandbox/gateway.mjs:51-58` — белый список заголовков.

## Не проверено

Проверяют разведка P3.0 и P14:
- срок жизни refresh-токена и API-ключа из консоли;
- число запросов в окне 5 часов и предел одновременных запросов по тарифам;
- работает ли `/usages` с API-ключом;
- открыта ли сейчас покупка новых подписок;
- как регистрироваться из России в регионе global;
- входят ли токены рассуждения в `completion_tokens`;
- отличает ли Kimi вход по API-ключу от OAuth в учёте устройств.

## Что в проекте решено иначе

- **Кто подставляет ключ.** Заметка опирается на `docs/spec.md:406` («ключ подставляет `sandbox-gw`»). Решение — роль оркестратора `llm` на app-ВМ; формулировка spec исправляется ([p3-design.md](p3-design.md) §0, §2.2).
- **Учётные данные.** По умолчанию — API-ключ из консоли, перевыпуск раз в 90 дней; OAuth — запасной вариант (§2.4, вопрос 6). Регион — global, `api.kimi.ai` (вопрос 7).
- **Идентичность клиента.** `device_id` и имя устройства закреплены за аккаунтом и хранятся в базе (`client_identity`), шлюз ставит `X-Msh-Device-Id` и `X-Msh-Device-Name` аккаунта (§2.4, §3.4).
- **`prompt_cache_key`** заменяется на значение от id задачи: кэш общий для ходов задачи и не общий для клиентов (§3.5).
- **Сигналы.** 401 «план не даёт модель» — ошибка задачи, а не аккаунта; 402 — временная пауза; 403 «concurrent request limit» понижает аккаунт только после проверочного запроса (§2.5).
- **Получатель данных.** Юрлицо Moonshot, которое получает данные, не установлено; до заключения юриста `kimi-code` на реальных данных выключен (§6.2, [legal-152fz.md](legal-152fz.md)).

## Источники

Проверены 28.09.2026.

- Исходники: [MoonshotAI/kimi-code, `@moonshot-ai/kimi-code@2.1.1`](https://github.com/MoonshotAI/kimi-code/tree/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f), коммит f67e639 (24.09.2026).
- Документация Kimi Code: [обзор](https://www.kimi.com/code/docs/en/), [membership](https://www.kimi.com/code/docs/en/kimi-code/membership.html), [models](https://www.kimi.com/code/docs/en/kimi-code/models.html), [error reference](https://www.kimi.com/code/docs/en/kimi-code/error-reference.html), [community guidelines](https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html), [Codex guide](https://www.kimi.com/code/docs/en/third-party-tools/codex.html), [benefits](https://www.kimi.com/en/help/kimi-code/benefits).
- Цены: [kimi.ai membership overview](https://www.kimi.ai/help/membership/membership-overview), [kimi.com membership pricing](https://www.kimi.com/en/help/membership/membership-pricing).
- Соглашения: [пользовательское соглашение v2](https://www.kimi.com/user/agreement/modelUse?version=v2) (с 31.08.2026), договор платных услуг (редакция от 31.08.2026).
- Issues: [kimi-code#3186](https://github.com/MoonshotAI/kimi-code/issues/3186), [kimi-code#3410](https://github.com/MoonshotAI/kimi-code/issues/3410) (31.08.2026), [kimi-code#3951](https://github.com/MoonshotAI/kimi-code/issues/3951), [Kimi-K2#46](https://github.com/MoonshotAI/Kimi-K2/issues/46), [kimi-cli#1201](https://github.com/MoonshotAI/kimi-cli/discussions/1201) (02.2026).
- Продажи и оплата: [Korea Times / SCMP, 21.07.2026](https://www.koreatimes.co.kr/world/20260721/kimi-k3-developer-suspends-new-subscriptions-amid-compute-constraints), [DTF, 31.07.2026](https://dtf.ru/howto/5215807-kak-kupit-podpisku-kimi-code-i-kimi-k3-api-iz-rossii).
- Сеть: [Cloudflare, 26.06.2025](https://blog.cloudflare.com/russian-internet-users-are-unable-to-access-the-open-internet/).
