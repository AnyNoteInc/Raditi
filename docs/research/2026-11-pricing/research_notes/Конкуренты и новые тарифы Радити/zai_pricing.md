# Цены Z.ai на GLM на 06.11.2026: план GLM Coding Plan, API с оплатой за токены, условия, курс и стоимость задачи

Собрано 06.11.2026. Страницы docs.z.ai читались в сыром виде (`<адрес>.md`), отрисованная страница z.ai/subscribe не открывалась (сервер Playwright MCP не подключился), её цены взяты из клиентских скриптов и сверены с двумя сторонними снимками. Живой список цен страница покупки берёт запросом к `https://api.z.ai/api/biz/pay/coding-plan/batch-preview`: этот адрес на хосте API Z.ai не вызывался (ограничение задачи и отказ в разрешении). Метки: **[подтв.]** — текст страницы провайдера, регулятора; **[скрипт]** — значение из клиентского скрипта страницы, не из отрисованного текста; **[3-е лицо]** — сторонний источник; **[расчёт]** — вычислено в этой заметке. Курс для рублей — 81,7947 ₽ за 1 USD (ЦБ РФ на 06.11.2026), если не сказано иное. `.env` и API модели Z.ai не трогались.

## 1. GLM Coding Plan: тарифы, цены, квоты, модели, параллельность, командный план; что изменилось с 05.10.2026

### Takeaway
Индивидуальный план — три уровня с той же квотой, что и 05.10.2026 (Lite 2 000 / 10 000, Pro 12 000 / 60 000, Max 28 000 / 140 000 кредитов за 5 часов / неделю), цена по скриптам и двум сторонним снимкам — 18, 80 и 168 USD в месяц, квартал −20 %, год −30 % (в документации подтверждено только «от 18 USD»). Новое с 05.10.2026 (или впервые прочитано): опубликованная формула кредитов от токенов, скидка 50 % вне пиковых часов (пик — Пн–Пт 09:00–13:00 по Москве), разделение ключей плана и API с 16.10.2026 и цены командного плана 88 и 188 USD за место.

### Cited Findings
**Уровни и цены индивидуального плана (с 30.07.2026 — «credits-based», версия V3 в скриптах)**
- План перешёл на кредиты 30.07.2026: «The new credits-based plan is now available. Previous plans are no longer sold to new users»; цены и квоты нового плана страница отсылает к z.ai/subscribe. Действующие подписки до конца оплаченного периода сохраняют прежние условия; «usage on weekends will be deducted at off-peak rates all day» **[подтв.]** — [Plan Update Announcement, 30.07.2026](https://docs.z.ai/devpack/notice/usage-revision)
- Документация: «Starting at just 18 USD per month, with Pro and Max plans designed for high-frequency, complex projects» — цены Pro и Max в тексте нет **[подтв.]** — [devpack/overview](https://docs.z.ai/devpack/overview); мета-описание z.ai/subscribe — «Plans from 18/month» **[подтв.]** — [z.ai/subscribe](https://z.ai/subscribe)
- Значения по умолчанию V3 в скрипте страницы покупки (`codePlansV3`): месяц — Lite 18, Pro 80, Max 168 USD; квартал — 43,20, 192, 403,20 USD; год — 151,20, 672, 1 411,20 USD **[скрипт]** — [z.ai/subscribe, чанк `1n82lfmz_txws.js`](https://static.bigmodel.cn/z-ai-website/_next/static/chunks/1n82lfmz_txws.js)
- Подписи переключателя периода в том же скрипте: «Quarterly … -20% … Continuous quarterly subscriptions enjoy a 20% discount», «Yearly … -30% … Continuous annual subscription enjoys a 30% discount» (скидка — для непрерывной подписки с автопродлением, режим `CONTINUOUS`) **[скрипт]** — [там же](https://static.bigmodel.cn/z-ai-website/_next/static/chunks/1n82lfmz_txws.js)
- Снимок z.ai/subscribe от 07.09.2026: Lite 18, Pro 80 «(up from $72)», Max 168 «(up from $160)» USD в месяц; на вкладке «Monthly» скидки больше нет, квартал −20 %, год −30 % **[3-е лицо]** — [usagepricing.com, 07.09.2026](https://www.usagepricing.com/blueprint/activity/zhipu-ai-2026-09-07-coding-plan-team-pricing)
- «from $18/mo», Pro «~$80», Max «~$168», квоты 2k/10k, 12k/60k, 28k/140k; проверено 21.09.2026 **[3-е лицо]** — [aicoolies.com](https://aicoolies.com/pricing/zai-coding-plan)
- Страница от 15.10.2026 (по выдаче поиска; сама страница вернула 429): 18 / 80 / 168 USD, квартал −20 %, год −30 %, Lite в годовом пересчёте 12,60 USD в месяц; там же утверждение, что Lite перестал приниматься у новых подписчиков 20.03.2026 — не подтверждено ничем другим **[3-е лицо, непроверено]** — [morphllm.com](https://www.morphllm.com/coding-plan)
- В рублях **[расчёт]**: месяц — Lite 1 472,30 ₽, Pro 6 543,58 ₽, Max 13 741,51 ₽; квартал — 3 533,53, 15 704,58, 32 979,62 ₽; год — 12 367,36, 54 966,04, 115 428,68 ₽ (по 81,7947 ₽/USD — [ЦБ РФ](https://www.cbr.ru/scripts/XML_daily.asp?date_req=06/11/2026)).

**Прежний план (V2, продавался до 30.07.2026) — для сравнения**
- На 21.04.2026 «Current Standard Price» месяца — Lite 18, Pro 72, Max 160 USD; квартал (со скидкой) — 48,60, 194,40, 432 USD (−10 %); год — 172,80, 691,20, 1 536 USD (−20 %). В колонке «50% off» той же таблицы есть арифметические ошибки: годовой Lite 96 (а не 86,40), годовой Pro 288 (а не 345,60) **[подтв.]** — [Legacy Plan Migration Notice, 21.04.2026](https://docs.z.ai/devpack/transition)
- Квота V2 — в «prompts»: Lite до ~80 за 5 ч и ~400 в неделю, Pro ~400 / 2 000, Max ~1 600 / 8 000; «Each prompt is estimated to invoke the model 15–20 times»; GLM-5.3 расходует квоту «1× during off-peak hours and 3× during peak hours» **[подтв.]** — [Plan Update Announcement](https://docs.z.ai/devpack/notice/usage-revision)
- То есть 30.07.2026 Pro подорожал с 72 до 80 USD (+11 %), Max — с 160 до 168 USD (+5 %), Lite остался 18 USD; квартальная скидка выросла с 10 до 20 %, годовая — с 20 до 30 % **[расчёт по подтв. V2 и скрипту/3-м лицам для V3]**.

**Квоты и формула кредитов**
- 5 часов / неделя: Lite 2 000 / 10 000, Pro 12 000 / 60 000, Max 28 000 / 140 000; 5-часовая квота «resets 5 hours after consumption», недельная «Activated upon subscription; resets every 7 days» **[подтв.]** — [devpack/overview](https://docs.z.ai/devpack/overview)
- «Model credit usage = (Input tokens × Input multiplier + Cached Input tokens × Cached Input multiplier + Output tokens × Output multiplier) / 10,000»; множители GLM-5.3 — 6,9 / 1,7 / 24, GLM-5.3-Flash — 2,3 / 0,56 / 8; MCP Web Search, Web Reader, Zread — 1,2 кредита за вызов **[подтв.]** — [devpack/overview](https://docs.z.ai/devpack/overview)
- «During off-peak hours, model usage is charged at 50% of the standard credit rate»; «Peak hours: Monday to Friday, 14:00–18:00 Singapore Standard Time (UTC+8)» **[подтв.]** — [devpack/overview](https://docs.z.ai/devpack/overview)
- Оценка Z.ai в токенах в неделю: при доле кэша 95 % GLM-5.3 — Lite 48–97, Pro 290–580, Max 676–1 352 млн токенов; при 98 % — 52–104, 313–627, 731–1 463; нижняя граница — всё в пик, верхняя — всё вне пика; «you can save up to 92% compared with pay-as-you-go calls to the GLM-5.3 standard API» **[подтв.]** — [devpack/overview](https://docs.z.ai/devpack/overview)
- Карты сброса квоты («Quota Reset Card») выдаются эпизодически в акциях; квота плана не списывает баланс счёта: «Once the quota is used up, you’ll need to wait until the next 5-hour cycle» **[подтв.]** — [devpack/faq](https://docs.z.ai/devpack/faq)

**Модели**
- «All plans support GLM-5.3, GLM-5.3-Flash. Requests for GLM-5.2/GLM-5.1 will be automatically routed to GLM-5.3, requests for GLM-4.7 will automatically be routed to GLM-5.3-Flash.» Во всех планах — MCP Vision, Web Search, Web Reader, Zread **[подтв.]** — [devpack/overview](https://docs.z.ai/devpack/overview)
- Адреса плана: `https://api.z.ai/api/coding/paas/v4` (OpenAI-совместимые инструменты) и `https://api.z.ai/api/anthropic` (Claude Code, Goose) **[подтв.]** — [devpack/faq](https://docs.z.ai/devpack/faq)

**Параллельность**
- «Rate (concurrency) limits are tied to your plan tier. The platform dynamically adjusts these limits … Max > Pro > Lite»; рекомендации — Lite один проект, Pro 1–2, Max 2 и больше; вне пика лимит параллельности «dynamically increased». Чисел нет **[подтв.]** — [devpack/usage-policy](https://docs.z.ai/devpack/usage-policy)

**Командный план (Team)**
- Места Standard и Premium; квота на место 15 000 / 66 000 и 35 000 / 155 000 кредитов (5 ч / неделя); минимум 2 места, смешивать виды мест нельзя; «on-demand usage overage … billed at a 10% discount from the model API list price» (ограниченное предложение); «Data is not used for model training by default»; Premium — приоритет в пиковые часы; «Verified enterprises can request special VAT invoices» **[подтв.]** — [devpack/teamplan](https://docs.z.ai/devpack/teamplan)
- Цены мест по снимку z.ai/subscribe 07.09.2026: Standard 88 USD в месяц («From $79.2/month» при годовой оплате), Premium 188 USD («From $169.2/month») — в рублях 7 197,93 и 15 377,40 ₽ в месяц **[3-е лицо; рубли — расчёт]** — [usagepricing.com, 07.09.2026](https://www.usagepricing.com/blueprint/activity/zhipu-ai-2026-09-07-coding-plan-team-pricing)
- Цены мест страница грузит открытым запросом `/biz/overseas/team/subscribe/product/public_pricing` (не вызывался) **[скрипт]** — [чанк `1n82lfmz_txws.js`](https://static.bigmodel.cn/z-ai-website/_next/static/chunks/1n82lfmz_txws.js)

**Ключи с 16.10.2026 (новое после 05.10.2026)**
- «Starting October 16, 2026, API keys for the standard model API (pay-as-you-go or usage bundles) and GLM Coding Plan are managed separately»; «For Standard and Coding Plan keys created from October 16 onward, the key type determines how calls are billed … Changing the endpoint does not change the key's billing type» **[подтв.]** — [API Key Management Guide, 16.10.2026](https://docs.z.ai/devpack/notice/api-key-management)
- Старые ключи аккаунта, у которого был план, — «Compatible»: на `https://api.z.ai/api/paas/v4` они идут по цене API и «may deduct from your account balance even while plan quota remains», на адресах плана — по квоте плана; после окончания плана сами на оплату за токены не переходят **[подтв.]** — [там же](https://docs.z.ai/devpack/notice/api-key-management)
- «Some existing keys for dedicated enterprise services or partner channels retain their previous compatibility behavior» — признак того, что выделенные корпоративные и партнёрские каналы существуют **[подтв.]** — [там же](https://docs.z.ai/devpack/notice/api-key-management)

**Продление, отмена, возвраты**
- Автопродление по цене, действующей в день списания: «the price for automatic renewal shall be the price … displayed on the page and actually applied by the system on the date the charge is made, rather than the original price at the time of your initial subscription» **[подтв.]** — [subscription-terms §3](https://docs.z.ai/legal-agreement/subscription-terms)
- Возвратов нет; отмена — за 24 часа (условия §2, FAQ плана) или за 3 дня (Usage Policy) до списания — расхождение сохраняется с 05.10.2026 **[подтв.]** — [subscription-terms](https://docs.z.ai/legal-agreement/subscription-terms); [devpack/usage-policy](https://docs.z.ai/devpack/usage-policy); [devpack/faq](https://docs.z.ai/devpack/faq)
- Повышение уровня — сразу, остаток прежнего плана засчитывается пропорционально; продление того же уровня (месяц → год) суммирует сроки **[подтв.]** — [devpack/faq](https://docs.z.ai/devpack/faq)

**Первые периоды и акции**
- Реферальная программа: скидка новому подписчику по ссылке, пригласившему — до 20 % от оплаты кредитами; пример FAQ упоминает «50% first-order discount» как возможную скидку **[подтв. как пример, не как действующая цена]** — [devpack/faq](https://docs.z.ai/devpack/faq)
- В скрипте страницы есть поля `campaignDiscountDetails`, `discountBadgeText`, состояние `SOLD_OUT` и очередь ожидания (`/biz/subscription/waitlist/…`) — действующие акции и наличие уровней приходят с сервера **[скрипт]** — [чанк `2m4p4q35495l2.js`](https://static.bigmodel.cn/z-ai-website/_next/static/chunks/2m4p4q35495l2.js)

### Inferences
- Пиковые часы Z.ai — Пн–Пт 09:00–13:00 по Москве (UTC+3 против UTC+8): это утро рабочего дня клиентов Радити, то есть 4 из 9 рабочих часов идут по двойной цене в кредитах; выходные — вне пика целиком (по объявлению 30.07.2026).
- Формула кредитов объясняет измеренные 10–11.10.2026 числа ([business.md](../../../../business.md), §5): запрос ~4,2 тыс. токенов ввода, 92,2 % из кэша, ~150 токенов вывода стоит по формуле 1,24 кредита в пик и 0,62 вне пика. 10.10.2026 и 11.10.2026 — суббота и воскресенье; замер 11.10 (~0,7 на генерацию) совпадает с ценой вне пика, разброс 10.10 (0,4–2,1) формулой без дополнительных данных не объясняется. Вывод осторожный: на каком варианте плана (V2 или V3) был аккаунт замеров, здесь не проверено.
- Цена кредита в долларах по списку API (1 кредит = 10 000 / множитель токенов): ввод 0,00203, кэш 0,00153, вывод 0,00183 USD за кредит в пик **[расчёт]**. Плата за кредит-месяц при полном использовании недельной квоты (неделя × 4,35): Lite 0,000414, Pro 0,000307, Max 0,000276 USD (−30 % при годовой оплате) **[расчёт]**. Значит, полностью загруженный план дешевле API в 3,7–4,9 раза (Lite) и в 5,5–7,3 раза (Max) в пик и вдвое больше того вне пика.
- Max — самый дешёвый уровень на кредит; Pro по цене на кредит ближе к Max, чем к Lite.
- После 16.10.2026 утверждение П83 «один ключ Z.ai работает на обоих путях» верно только для старого ключа «Compatible»: новый ключ плана и новый ключ API различаются по месту создания, и запасной путь `zai-api` потребует отдельного стандартного ключа и баланса.

### Gaps
- Действующие сегодня цены Pro и Max и наличие акций первого периода не подтверждены текстом страницы: отрисованная z.ai/subscribe не открылась, живой список цен приходит запросом на хосте API Z.ai, который не вызывался.
- Утверждение morphllm.com о закрытии Lite для новых подписчиков 20.03.2026 ничем первичным не подтверждено; страница вернула 429.
- Числовых лимитов параллельности плана Z.ai не публикует.
- Цена «отдельного письменного соглашения» и корпоративных каналов в открытых источниках отсутствует.

## 2. API с оплатой за токены: цены всех GLM, кэш, пакетные скидки, лимиты, пополнение; изменения с 16.10.2026

### Takeaway
GLM-5.3 на API стоит 1,40 / 0,26 / 4,40 USD за 1 млн токенов ввода / кэша / вывода — так же, как 16.10.2026; хранение кэша «Limited-time Free». Дешевле — GLM-5.3-FlashX (0,37 / 0,075 / 1,25) и GLM-5.3-Flash (0,15 / 0,03 / 0,50); пакетной скидки, ступеней по длине контекста и опубликованных лимитов по уровням нет.

### Cited Findings
- «All prices are in USD»; за 1 млн токенов (ввод / кэшированный ввод / хранение кэша / вывод) **[подтв.]** — [docs.z.ai/guides/overview/pricing](https://docs.z.ai/guides/overview/pricing):
  - GLM-5.3 — 1,4 / 0,26 / Limited-time Free / 4,4 USD (114,51 / 21,27 / — / 359,90 ₽ **[расчёт]**)
  - GLM-5.3-Flash — 0,15 / 0,03 / Free / 0,50 USD (12,27 / 2,45 / 40,90 ₽)
  - GLM-5.3-FlashX — 0,37 / 0,075 / Free / 1,25 USD (30,26 / 6,13 / 102,24 ₽); GLM-5.3-FlashX-Legal — те же цены
  - GLM-5.2 и GLM-5.1 — 1,4 / 0,26 / 4,4 USD; GLM-5 — 1 / 0,2 / 3,2 USD (81,79 / 16,36 / 261,74 ₽)
  - GLM-4.7 и GLM-4.6 — 0,6 / 0,11 / 2,2 USD (49,08 / 9,00 / 179,95 ₽)
  - «Other Pricing»: GLM-4.7-FlashX — 0,07 / 0,01 / 0,4; GLM-4.5 — 0,6 / 0,11 / 2,2; GLM-4.5-X — 2,2 / 0,45 / 8,9; GLM-4.5-Air — 0,2 / 0,03 / 1,1; GLM-4.5-AirX — 1,1 / 0,22 / 4,5; GLM-4-32B-0414-128K — 0,1 / — / 0,1; GLM-4.7-Flash и GLM-4.5-Flash — бесплатно
  - Встроенный Web Search — 0,01 USD за вызов
- Цены GLM-5.3 совпадают с прочитанными 16.10.2026 и записанными в файл ставок (1.40, 0.26, 4.40) — изменений с 16.10.2026 нет **[подтв. сравнением]** — [docs.z.ai/guides/overview/pricing](https://docs.z.ai/guides/overview/pricing); `infra/billing/rates/2026-10-17-zai-api.json` (локальный файл)
- Кэш: механизм «currently undergoing open beta testing», правила попадания и срок хранения не объявлены, хранение «currently completely free», попадание стоит «approximately 1/5 of the original price» **[подтв.]** — [docs.z.ai/help/faq](https://docs.z.ai/help/faq)
- Лимиты API: FAQ отсылает в консоль «https://z.ai/manage-apikey/rate-limits»; страница docs.z.ai/api-reference/rate-limit отдаёт оболочку сайта z.ai без таблицы **[подтв.]** — [docs.z.ai/help/faq](https://docs.z.ai/help/faq); [api-reference/rate-limit](https://docs.z.ai/api-reference/rate-limit)
- Пакетного API (batch) и ступеней цены по длине контекста в указателе документации и на странице цен нет **[подтв. отсутствием]** — [docs.z.ai/llms.txt](https://docs.z.ai/llms.txt); [pricing](https://docs.z.ai/guides/overview/pricing)
- Пополнение — на странице billing консоли; списание показывается с задержкой (история — за день n−1); 3-D Secure для карт не поддерживается **[подтв.]** — [docs.z.ai/help/faq](https://docs.z.ai/help/faq)
- Существуют «usage bundles» (пакеты использования) для стандартных ключей; цен пакетов в документации нет **[подтв.]** — [API Key Management Guide](https://docs.z.ai/devpack/notice/api-key-management)
- Бесплатные модели (GLM-4.7-Flash, GLM-4.5-Flash, GLM-4.6V-Flash) — единственное «бесплатное» в открытом прайсе; стартового бесплатного баланса на API документация не обещает **[подтв.]** — [pricing](https://docs.z.ai/guides/overview/pricing)

### Inferences
- GLM-5.3-Flash в 9,3 раза дешевле GLM-5.3 по вводу и в 8,8 раза по выводу; FlashX — в 3,5–3,8 раза. Для контентных задач это главный рычаг себестоимости на API.
- Цена GLM-5.3 в рублях с 17.10.2026 упала на 2,18 % только из-за курса (83,6177 → 81,7947 ₽/USD).

### Gaps
- Лимиты RPM/TPM/параллельности по уровням API и минимальное пополнение видны только в консоли под входом — не установлены.
- Цены «usage bundles» и есть ли скидка за объём — не найдены.
- Сколько хранится кэш и какова реальная доля попаданий у задач Радити — не объявлено и не измерено (замер 10.10.2026 — 92,2 % на синтетике).

## 3. Условия, важные для перепродавца: план против API (цитаты)

### Takeaway
Тексты не изменились с 05.10.2026: условия плана прямо запрещают вызывать квоту из своих SaaS, проксировать план третьим лицам и давать квоту клиентам и организациям (исключение — отдельное письменное соглашение), а условия API прямо разрешают встраивать сервис в свои приложения для конечных пользователей.

### Cited Findings
- План, §4.2: «You shall not use the GLM Coding Plan quota for general-purpose API access or any scenarios outside such tools, including but not limited to directly invoking model APIs from your own applications, bots, websites, SaaS products or other systems, unless you have entered into a separate written agreement with Z.ai.» **[подтв.]** — [subscription-terms](https://docs.z.ai/legal-agreement/subscription-terms)
- План, §4.2: «Unless otherwise agreed in writing, you may not resell, sub-resell, repackage, aggregate, proxy or otherwise provide the GLM Coding Plan to any third party, whether on a paid or free basis, nor may you use the GLM Coding Plan to provide model capabilities as a service to third parties.» **[подтв.]** — [там же](https://docs.z.ai/legal-agreement/subscription-terms)
- План, §4.2: при использовании через «unauthorized or unsupported tools (such as SDK-based access or other third-party integrations), some subscription benefits may be restricted» **[подтв.]** — [там же](https://docs.z.ai/legal-agreement/subscription-terms)
- План, §4.3: «licensed only to the individual natural person associated with such account»; нельзя позволять пользоваться квотой «colleagues, friends, customers or any organization»; при подозрении на «bulk or automated usage on behalf of others» Z.ai вправе урезать квоту, приостановить или прекратить услугу и «reclaiming any remaining quota» **[подтв.]** — [там же](https://docs.z.ai/legal-agreement/subscription-terms)
- Usage Policy: «Account sharing or multi-user access is prohibited»; «Accounts with more than three violations may be banned»; «refunds are not supported» **[подтв.]** — [devpack/usage-policy](https://docs.z.ai/devpack/usage-policy)
- Ответственность Z.ai по подписке ограничена суммой, уплаченной за последний календарный месяц (§5) **[подтв.]** — [subscription-terms](https://docs.z.ai/legal-agreement/subscription-terms)
- Командный план подчиняется тем же условиям подписки; «multiple people sharing the same seat, use in unsupported tools, or abnormally high-frequency calls may trigger platform risk control rules» **[подтв.]** — [devpack/teamplan](https://docs.z.ai/devpack/teamplan)
- API, Additional Terms §1(a): «We grant you a non-exclusive right to access and use the API Services during the valid term, which includes the right to use Z.ai’s API to integrate the Services into your applications or to develop downstream systems, applications or functions to your end users (“End Users”).» §1(b): разработчик отвечает за свои системы и заключает соглашения с конечными пользователями **[подтв.]** — [terms-of-use, ред. 14.04.2026](https://docs.z.ai/legal-agreement/terms-of-use)
- Terms of Use «Last Update: April 14, 2026» — редакция та же, что 05.10.2026; закрытые регионы — «Iran, North Korea, Cuba, Crimea, Donetsk, or Zaporizhzhia», России в перечне нет **[подтв.]** — [terms-of-use](https://docs.z.ai/legal-agreement/terms-of-use)

### Inferences
- Для SaaS с клиентами чистый путь по текстам — API с оплатой за токены (или письменное соглашение). Production на плане (решение владельца 06.11.2026, П86–П87) остаётся прямым противоречием §4.2–§4.3; экономия плана (п. 1, п. 6) — это плата за принятый риск изъятия квоты без возврата.
- Командный план не снимает запрета: место — один участник-человек, условия те же.

### Gaps
- Условия, цена и сама доступность письменного соглашения для российской компании — не опубликованы.
- Как Z.ai отличает «поддерживаемый инструмент» за собственным шлюзом — не раскрыто.

## 4. Как платить: способы, валюта, платежи из России

### Takeaway
Z.ai берёт только USD: баланс бонусов, денежный баланс, затем привязанная банковская карта или PayPal; 3-D Secure не поддерживается. Прямой оплаты российскими картами нет по сторонним источникам; криптовалюту Z.ai напрямую не принимает (только сторонние «крипто-карты»).

### Cited Findings
- Порядок списания подписки: «bonus balance» → «cash balance» → «linked third-party payment method (e.g., bank card or PayPal)» **[подтв.]** — [devpack/usage-policy](https://docs.z.ai/devpack/usage-policy); «a small minimum applies when charging your credit card. If the remaining amount is less, we will round up the deduction to meet this minimum» **[подтв.]** — [devpack/faq](https://docs.z.ai/devpack/faq)
- «3DS verification is not supported in our platform at this moment» **[подтв.]** — [docs.z.ai/help/faq](https://docs.z.ai/help/faq)
- Все цены — в USD **[подтв.]** — [pricing](https://docs.z.ai/guides/overview/pricing)
- По скриптам страницы оплаты платёж идёт через Stripe и PayPal (прочитано 05.10.2026) **[скрипт]** — [zai-terms.md, §2 «Оплата»](../../../2026-10-opencode-glm/zai-terms.md)
- Криптовалюту z.ai напрямую не принимает, вариант — карта, пополняемая криптовалютой; источник продаёт такую карту **[3-е лицо, заинтересованное]** — [solcard.cc](https://www.solcard.cc/blog/pay-z-ai-with-crypto)
- Материалы vc.ru и DTF описывают оплату через посредников (рубли или СБП, платёж за рубежом проводит сервис-посредник) и иностранные или виртуальные карты с иностранным BIN **[3-е лицо, рекламные]** — [vc.ru, «Как оплатить GLM из России»](https://vc.ru/services/3045731-kak-oplatit-glm-iz-rossii); [vc.ru, Z.AI Coding Plan](https://vc.ru/services/3015458-zai-coding-plan-glm-dlya-claude-code-i-vs-code-oplata-iz-rossii)
- Командному плану обещаны «centralized billing and invoicing» и для «verified enterprises» — «special VAT invoices» **[подтв.]** — [devpack/teamplan](https://docs.z.ai/devpack/teamplan)

### Inferences
- Для Радити реалистичны: иностранная корпоративная или виртуальная карта без 3-D Secure, PayPal иностранного лица или посредник; каждый добавляет комиссию и курсовую разницу сверх курса ЦБ (business.md закладывает K = 100–130 ₽/USD).
- Автопродление по «цене на дату списания» плюс карта без 3-D Secure — операционный риск: отказ карты в день продления останавливает production на плане до ручной оплаты.

### Gaps
- Первичного заявления Z.ai о приёме платежей из России нет; работает ли инвойс или банковский перевод для юрлица — не найдено.
- Минимальное пополнение баланса API и размер «small minimum» по карте — не опубликованы.

## 5. Официальный курс ЦБ РФ на 06.11.2026

### Takeaway
ЦБ РФ установил на 06.11.2026 курс 81,7947 ₽ за 1 USD (EUR — 92,1581 ₽); это на 2,18 % ниже курса 83,6177 ₽ на 17.10.2026, по которому рассчитан файл ставок `zai-api`.

### Cited Findings
- `<ValCurs Date="06.11.2026">` … USD «Доллар США» — 81,7947; EUR — 92,1581 **[подтв.]** — [cbr.ru XML_daily, 06.11.2026](https://www.cbr.ru/scripts/XML_daily.asp?date_req=06/11/2026)
- Курс на 17.10.2026 — 83,6177 ₽/USD (основание файла ставок) — `infra/billing/rates/2026-10-17-zai-api.json` (локальный файл; источник в нём — [cbr.ru, 17.10.2026](https://www.cbr.ru/scripts/XML_daily.asp?date_req=17/10/2026))

### Inferences
- По курсу 06.11.2026 опубликованные ставки `zai-api` (152,18 / 28,26 / 478,29 ₽ за 1 млн с маржой 30 %) дают маржу около 32,9 % над ценой Z.ai вместо 30 %.

### Gaps
- Курс с комиссиями банка или посредника (фактический K) — за бухгалтером.

## 6. Расчёты: стоимость задач на API и мощность плана

### Takeaway
На API (GLM-5.3, 81,7947 ₽/USD) контентная задача 250 тыс. / 5 тыс. токенов стоит 30,43 ₽ без кэша, 11,78 ₽ при 80 % и 8,98 ₽ при 92 %; средняя задача смеси 60/32/8 — 84,01 / 32,24 / 24,47 ₽. Мощность плана резко зависит от того, какой мерой считать задачу: по замеру синтетики (3 запроса × 1,2 кредита = 3,6) Lite выполняет ~12 000 контентных задач в месяц, а по токенам business.md и официальной формуле (64,9 кредита в пик) — ~670, Pro — ~4 000, Max — ~9 400.

### Cited Findings
- Цены GLM-5.3, Flash, FlashX — [pricing](https://docs.z.ai/guides/overview/pricing); множители кредитов, пик и скидка 50 % — [devpack/overview](https://docs.z.ai/devpack/overview); квоты — там же; курс — [ЦБ РФ](https://www.cbr.ru/scripts/XML_daily.asp?date_req=06/11/2026); токены задач (контент 250 тыс. / 5 тыс., код 1,2 млн / 20 тыс., сложная 2 млн / 40 тыс., доли 60 / 32 / 8 %) и замер 1,2 кредита на запрос, 3 запроса на правку страницы, 92,2 % кэша — [business.md, §5](../../../../business.md).

**Формулы [расчёт]**
- Стоимость API, USD: `C = ((1 − h) × I × p_in + h × I × p_cache + O × p_out) / 10⁶`, где I — токены ввода, h — доля кэша, O — токены вывода; рубли = C × 81,7947.
- Кредиты плана: `k = ((1 − h) × I × 6,9 + h × I × 1,7 + O × 24) / 10 000` в пик; вне пика k / 2.
- Мощность в месяц: `T = min(неделя / k × 4,35, окно 5 ч / k × 44)`; 4,35 = 30,44 / 7 недель в месяце; 44 окна — 22 рабочих дня по 10 часов (допущение business.md).

**(a) 1 млн токенов ввода при 92 % кэша и выводе 2 % от ввода (20 тыс.; доля вывода во всех трёх типах задач business.md — 1,7–2 %)** — 0,08 × 1,40 + 0,92 × 0,26 + 0,02 × 4,40 = 0,4392 USD = **35,92 ₽**; Flash — 0,0496 USD = 4,06 ₽; FlashX — 0,1236 USD = 10,11 ₽. Для справки: при 0 % — 1,488 USD = 121,71 ₽, при 80 % — 0,576 USD = 47,11 ₽ **[расчёт]**.

**(b)–(d) Задачи на API GLM-5.3 [расчёт]**

| Задача (ввод / вывод) | 0 % кэша | 80 % кэша | 92 % кэша |
| --- | --- | --- | --- |
| (b) Контент, 250 тыс. / 5 тыс. | 0,3720 USD = 30,43 ₽ | 0,1440 USD = 11,78 ₽ | 0,1098 USD = 8,98 ₽ |
| (c) Код, 1,2 млн / 20 тыс. | 1,7680 USD = 144,61 ₽ | 0,6736 USD = 55,10 ₽ | 0,5094 USD = 41,67 ₽ |
| (d) Сложная, 2 млн / 40 тыс. | 2,9760 USD = 243,42 ₽ | 1,1520 USD = 94,23 ₽ | 0,8784 USD = 71,85 ₽ |
| Средняя (60 / 32 / 8 %) | 1,0270 USD = 84,01 ₽ | 0,3941 USD = 32,24 ₽ | 0,2992 USD = 24,47 ₽ |

Тот же расчёт на GLM-5.3-Flash при 92 % кэша: контент 1,01 ₽, код 4,70 ₽, сложная 8,11 ₽; на FlashX — 2,53, 11,72, 20,22 ₽ **[расчёт]**.

**Кредиты плана на задачу по официальной формуле, GLM-5.3 [расчёт]**

| Задача | 0 % кэша, пик | 80 %, пик | 92 %, пик | 92 %, вне пика |
| --- | --- | --- | --- | --- |
| Контент | 184,5 | 80,5 | 64,9 | 32,5 |
| Код | 876,0 | 376,8 | 301,9 | 151,0 |
| Сложная | 1 476,0 | 644,0 | 519,2 | 259,6 |
| Средняя 60/32/8 | 509,1 | 220,4 | 177,1 | 88,5 |
| Синтетический запрос 4,2 тыс. / 150, 92,2 % | — | — | 1,24 | 0,62 |

**Мощность плана в месяц (задач) и плата за задачу при полной загрузке, месячная цена [расчёт]**

| Мера задачи | Lite (18 USD) | Pro (80 USD) | Max (168 USD) |
| --- | --- | --- | --- |
| k = 3,6 (допущение задания: контент = 3 запроса × 1,2) | 12 078 (неделя; окна дали бы 24 444); 0,12 ₽ | 72 470; 0,09 ₽ | 169 097; 0,08 ₽ |
| Контент 250 тыс./5 тыс., 92 %, всё в пик (k = 64,9) | 670; 2,20 ₽ | 4 020; 1,63 ₽ | 9 380; 1,47 ₽ |
| То же, всё вне пика (k = 32,5) | 1 340; 1,10 ₽ | 8 040; 0,81 ₽ | 18 760; 0,73 ₽ |
| Средняя задача, 92 %, пик (k = 177,1) | 246; 6,00 ₽ | 1 473; 4,44 ₽ | 3 438; 4,00 ₽ |
| Средняя задача, 92 %, вне пика (k = 88,5) | 491; 3,00 ₽ | 2 946; 2,22 ₽ | 6 875; 2,00 ₽ |

- Во всех строках ограничивает недельная квота, а не окно 5 часов (окна при 44 в месяц дают вдвое больше) **[расчёт]**.
- Окно 5 часов: Lite вмещает 31 контентную задачу в пик (62 вне пика), Pro — 185 (370), Max — 431 (863) **[расчёт]**.

### Inferences
- Мера k = 3,6 соответствует синтетической правке страницы (~12,6 тыс. токенов ввода на задачу), а не задаче business.md в 250 тыс. токенов: между ними 20 раз. Пока eval P15 не измерил задачу клиента, для модели юнит-экономики разумно держать обе границы: 3,6 и 64,9 кредита на контентную задачу.
- API против плана на одной контентной задаче (92 % кэша): 8,98 ₽ на API против 1,1–2,2 ₽ на полностью загруженном Lite — план выгоднее в 4–8 раз, но только при полной загрузке недели; при 130 задачах пилота в месяц Lite загружен на 1–19 % (по двум мерам), и цена задачи на плане — 11,3 ₽ (1 472 ₽ / 130), то есть выше API.
- Точка равенства API и Lite: 1 472,30 ₽ / 8,98 ₽ ≈ 164 контентных задачи в месяц или 1 472,30 / 24,47 ≈ 60 средних задач; Pro — ~729 контентных или ~267 средних; Max — ~1 530 контентных или ~562 средних.
- При одном ходе на аккаунт (П4) и 3 минутах на контентную задачу аккаунт в рабочие часы выполняет не больше ~4 400 задач в месяц (22 × 10 × 20). При k = 3,6 это ограничение строже квоты на всех трёх уровнях; при k = 64,9 в пик квота строже у Lite (670) и Pro (4 020), а у Max (9 380) — снова параллельность; вне пика параллельность ограничивает уже и Pro (8 040).
- Доля кэша — самый сильный рычаг: от 0 % до 92 % задача на API дешевеет в 3,4 раза, а в кредитах плана — в 2,8 раза.

### Gaps
- Реальная доля пиковых часов в нагрузке Радити, доля кэша и токены задачи клиента не измерены (eval P15).
- Сколько ходов одновременно Z.ai допускает на аккаунт плана — не опубликовано; расчёт мощности по параллельности опирается на П4.
- Стоит ли учитывать НДС или иные налоги на покупку зарубежного сервиса при продавце-самозанятой — вопрос бухгалтеру, в расчёт не включено.

## 7. Альтернативные API для проверки чувствительности

### Takeaway
Из сопоставимых по классу: DeepSeek V4-Pro дешевле GLM-5.3 на API (контентная задача при 92 % кэша — 4,61 ₽ в пик, 2,30 ₽ вне пика), Kimi K3.1 Pro и Qwen3.8-max — на уровне GLM (11,12 и ~9,49 ₽), российские площадки дороже без кэша: Yandex AI Studio с DeepSeek V4.1 Flash — 25,75 ₽, GigaChat Max — 165,75 ₽ с НДС (у GigaChat нет скидки за кэш).

### Cited Findings
- **DeepSeek** (за 1 млн, USD): `deepseek-v4-pro` (DeepSeek-V4-Pro-0813) — кэш 0,044 пик / 0,022 вне пика, ввод 1,32 / 0,66, вывод 3,96 / 1,98; `deepseek-flash` (DeepSeek-V4.1-Flash-1017) — 0,006 / 0,003, 0,30 / 0,15, 1,20 / 0,60; контекст 1M, вывод до 384K; параллельность 2 500 (Flash) и 500 (Pro); «Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday» **[подтв.]** — [api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing)
- **Kimi (Moonshot)** (за 1 млн, USD, без налогов): `kimi-k3.1-pro` — ввод 2,00, вывод 10,00, кэш 0,20, запись кэша 5 мин 2,00, 1 ч 4,00; `kimi-k3.1-pro-highspeed` — 4 / 20 / 0,20; `kimi-k3` — 3 / 15 / 0,30; `kimi-k2.7-code` — 0,95 / 4,00 / 0,19; контекст K3 — 1 048 576; batch — 60 % цены; K2 недоступны новым пользователям с 31.10.2026 и снимаются к концу декабря 2026 **[подтв., таблица из исходника страницы]** — [platform.kimi.ai/docs/pricing/chat](https://platform.kimi.ai/docs/pricing/chat)
- **Qwen (Alibaba Model Studio, Сингапур)**, «Last Updated: Nov 06, 2026», за 1 млн, USD: `qwen3.8-max` — 2 / 6 (0–1M); `qwen3.7-max` — 2,5 / 7,5; `qwen3.7-plus` — 0,4 / 1,6 до 256K (ограниченная скидка 20 %); `qwen3-coder-flash` — от 0,3 / 1,5 до 1,6 / 9,6 по ступеням контекста; цена кэша для Сингапура в таблице не дана, пример страницы — попадание 10 % цены ввода, создание явного кэша 125 % **[подтв. частично; пересказ инструмента чтения]** — [alibabacloud.com/help/en/model-studio/model-pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing)
- **Yandex AI Studio** (синхронно, ₽ за 1 000 токенов с НДС; ввод / кэш / инструменты / вывод): DeepSeek V4.1 Flash — 0,3 / 0,075 / 0,075 / 0,5; Qwen3.6 35B — 0,2 / 0,05 / 0,05 / 0,3; gpt-oss-120b — 0,3 за всё; Alice AI LLM — 0,5 / 0,5 / 0,13 / 1,2; YandexGPT Pro 5.1 — 0,8 за всё; YandexGPT Pro 5 — 1,2; YandexGPT Lite — 0,2; дата обновления на странице не указана **[подтв.]** — [aistudio.yandex.ru/docs/ru/ai-studio/pricing](https://aistudio.yandex.ru/docs/ru/ai-studio/pricing)
- **GigaChat API для юрлиц** (₽ за 1 млн с НДС, синхронно; асинхронно вдвое дешевле): Lite 65, Pro 500, Max 650; минимальный платёж 600 ₽ в месяц; с 01.09.2026 новые клиенты оплачивают модели через cloud.ru **[подтв.]** — [developers.sber.ru, тарифы для юрлиц](https://developers.sber.ru/docs/ru/gigachat/tariffs/legal-tariffs)

**Контентная задача 250 тыс. / 5 тыс. на альтернативах [расчёт, 81,7947 ₽/USD]**

| Модель | 0 % кэша | 92 % кэша |
| --- | --- | --- |
| GLM-5.3 (Z.ai) | 30,43 ₽ | 8,98 ₽ |
| DeepSeek V4-Pro, пик / вне пика | 28,61 / 14,31 ₽ | 4,61 / 2,30 ₽ |
| DeepSeek Flash, пик | 6,63 ₽ | 1,09 ₽ |
| Kimi K3.1 Pro | 44,99 ₽ | 11,12 ₽ |
| Kimi K3 | 67,48 ₽ | 16,69 ₽ |
| Qwen3.8-max (кэш по примеру 10 %) | 43,35 ₽ | ~9,49 ₽ |
| Yandex AI Studio: DeepSeek V4.1 Flash, с НДС | 77,50 ₽ | 25,75 ₽ |
| Yandex AI Studio: Qwen3.6 35B, с НДС | 51,50 ₽ | 17,00 ₽ |
| Yandex AI Studio: Alice AI LLM, с НДС | 131,00 ₽ | 131,00 ₽ (кэш по цене ввода) |
| GigaChat Max, с НДС | 165,75 ₽ | 165,75 ₽ (кэша нет) |

### Inferences
- Долларовая колонка Yandex AI Studio выводится из рублёвой по 100 ₽/USD и НДС 22 % (0,3 / 1,22 / 0,002459 = 100,0): площадка считает в долларах по своему внутреннему курсу.
- Российские площадки (Yandex, GigaChat) — единственный путь без трансграничной передачи, но на агентной задаче с длинным контекстом они в 1,9–18 раз дороже GLM-5.3 на API при 92 % кэша (Qwen3.6 35B — 1,9, DeepSeek V4.1 Flash — 2,9, GigaChat Max — 18,5); без скидки за кэш (GigaChat, Alice AI LLM, YandexGPT) разница максимальна.
- DeepSeek V4-Pro — самая дешёвая из сопоставимых по классу; у него тоже есть пиковые часы (04:00–07:00 и 09:00–13:00 по Москве).

### Gaps
- Сопоставимость качества моделей на задачах Радити не оценивалась; цифры — только для проверки чувствительности цены.
- Доступность оплаты DeepSeek, Kimi и Alibaba Cloud International российской компании не проверялась.
- Цены cloud.ru для GigaChat (путь новых клиентов с 01.09.2026) не открывались.
