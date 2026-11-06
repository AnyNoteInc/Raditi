#!/usr/bin/env python3
"""Расчёты к отчёту «Конкуренты и новые тарифы Радити» (06.11.2026).

Запуск: python3 -I docs/research/2026-11-pricing/calc.py
Только стандартная библиотека, деньги — Decimal. Все входы — именованные константы ниже,
у каждой — откуда она взята (заметки каталога research_notes/«Конкуренты и новые тарифы
Радити», business.md, credits-design.md). Скрипт печатает таблицы, числа отчёта взяты из них.
"""
from decimal import Decimal as D, ROUND_HALF_UP, ROUND_FLOOR, getcontext

getcontext().prec = 40

# ----------------------------------------------------------------------------------------------
# Входы
# ----------------------------------------------------------------------------------------------

# Курс ЦБ РФ на 06.11.2026 (zai_pricing.md §5) и курс файла ставок 17.10.2026.
FX = D('81.7947')
FX_RATES_FILE = D('83.6177')
# Учётные ставки = цена Z.ai × курс 17.10 × 1,30 (internal_costs.md §4).
RATES_MARKUP = D('1.30')
# Курс кредита: 6,00 ₽ учётной стоимости (решение владельца 17.10.2026, П85).
K = D('6.00')

# API GLM-5.3, $ за 1 млн токенов: ввод / кэш / вывод (zai_pricing.md §2, docs.z.ai pricing).
API = {'in': D('1.40'), 'cache': D('0.26'), 'out': D('4.40')}
API_FLASH = {'in': D('0.15'), 'cache': D('0.03'), 'out': D('0.50')}
API_FLASHX = {'in': D('0.37'), 'cache': D('0.075'), 'out': D('1.25')}

# План GLM Coding Plan: множители кредитов плана на 10 000 токенов (devpack/overview),
# цены V3 по скрипту страницы и двум сторонним снимкам (не подтверждены текстом страницы,
# кроме «от 18 USD»), квоты 5 ч / неделя (подтверждены). Квартал −20 %, год −30 % (скрипт).
PLAN_MULT = {'in': D('6.9'), 'cache': D('1.7'), 'out': D('24')}
PLAN = {  # уровень: (USD в месяц, квота 5 ч, квота в неделю)
    'Lite': (D('18'), D('2000'), D('10000')),
    'Pro': (D('80'), D('12000'), D('60000')),
    'Max': (D('168'), D('28000'), D('140000')),
}
QUARTER_DISCOUNT = D('0.20')
YEAR_DISCOUNT = D('0.30')
OFF_PEAK = D('0.5')                  # вне пика кредиты плана списываются вдвое меньше
WEEKS_PER_MONTH = D('4.35')          # 30,44 / 7, как в zai_pricing.md §6
WINDOWS_PER_MONTH = D('44')          # 22 рабочих дня × 2 окна по 5 ч (допущение business.md)

# Задачи business.md §5 (гипотеза до eval P15): ввод, вывод, доля в смеси.
TASKS = {
    'Контент': (D('250000'), D('5000'), D('0.60')),
    'Код': (D('1200000'), D('20000'), D('0.32')),
    'Сложная': (D('2000000'), D('40000'), D('0.08')),
}
CACHES = [D('0'), D('0.80'), D('0.92'), D('0.95')]

# Замер dev-базы 25.10–06.11.2026 (internal_costs.md §6): тестовые чаты, класс synthetic.
DEV_CALLS = {  # бэкенд: (вызовов, ввод без кэша, кэш, вывод с рассуждением, учётные ₽)
    'zai-api': (D('510'), D('879657'), D('17642769'), D('92202'), D('676.60')),
    'zai-coding': (D('110'), D('137885'), D('3122466'), D('39997'), D('128.36')),
}
DEV_TOTAL_ACC = D('804.96')          # вся учётная стоимость
DEV_CHARGED_ACC = D('506.79')        # учётная стоимость задач, у которых было списание
DEV_CHARGED_CREDITS = D('166')       # списано кредитов (credit_ledger)
DEV_CHARGED_TASKS = D('24')          # задач со списанием: 12 + 4 + 6 + 2
DEV_TURNS = {  # вид: (ходов, ввод в среднем, доля кэша, вывод, учётные ₽: среднее, медиана, p90, макс, мин. в среднем)
    'Код (repo)': (16, D('171320'), D('0.851'), D('1821'), D('8.87'), D('7.65'), D('13.14'), D('27.55'), D('1.7')),
    'Браузер на сайте': (18, D('875154'), D('0.971'), D('3497'), D('29.55'), D('4.47'), D('86.81'), D('247.89'), D('3.1')),
    'Чат без проекта': (21, D('143315'), D('0.961'), D('1750'), D('5.58'), D('0.83'), D('5.00'), D('77.41'), D('1.2')),
    'Код и браузер': (2, None, None, None, D('6.90'), None, None, D('12.65'), D('1.1')),
}
DEV_CHAINS = {  # кредиты работы на цепочку (проход) до округления: медиана, p90, макс
    'Код (repo)': (D('1.87'), D('2.73'), D('4.59')),
    'Браузер на сайте': (D('0.83'), D('19.35'), D('41.32')),
    'Чат без проекта': (D('0.14'), None, D('12.90')),
}

# Вычисления по ценам Cloud.ru из xlsx (internal_costs.md §1, §8): ₽ за vCPU·ч и ГБ·ч.
VCPU_H = D('1.6358')
RAM_GB_H = D('0.1718')
LOAD = D('0.35')                     # загрузка железа (business.md)
SANDBOX = (D('2'), D('4'))           # vCPU, ГБ
PREVIEW = (D('2'), D('2'))
BROWSER = (D('1.5'), D('1.9'))
TURN_MIN = D('1.94')                 # средняя длительность хода dev, взвешенная по ходам
PASSES_PER_ACTION = D('2')           # «5 + 2 кредита за проходы» (spec, прогон 27.10.2026)
PREVIEW_MIN_PER_ACTION = D('40')     # 10 мин просмотра + 30 мин простоя до остановки
PREVIEW_SHARE = D('0.5')             # доля действий с предпросмотром (допущение)
BROWSER_MIN = D('10.2')              # средняя сессия браузера dev
BROWSER_SHARE = D('0.4')             # доля действий с браузером (допущение)
BACKUP_PER_SITE = D('8')             # ₽ за сайт в месяц (business.md)
ESCALATION_PER_TASK = D('0.05') * D('15') * D('21.09')   # 5 % задач × 15 мин × 21,09 ₽ (ООО)

# Действие клиента: 7 кредитов (dev: 166 кредитов на 24 списанные задачи; «5 + 2»).
CREDITS_PER_ACTION = D('7')
# Неоплаченная работа как доля оплаченной: документы 25 %, dev 298,17 / 506,79.
UNPAID_DOCS = D('0.25')
UNPAID_DEV = (DEV_TOTAL_ACC - DEV_CHARGED_ACC) / DEV_CHARGED_ACC

# Удержания с выручки. НПД: ЮKassa 3,5 % + НДС 22 % с комиссии, НПД 4 % (internal_costs.md §9).
YK_NPD = D('0.035') * D('1.22')
NPD_TAX = D('0.04')
NPD_CAP_YEAR = D('2400000')
# ООО/ИП: ЮKassa 2,8 % + 1 % за чек, ставки без НДС → × 1,22; УСН «доходы» 6 % — допущение.
YK_LEGAL = (D('0.028') + D('0.01')) * D('1.22')
USN = D('0.06')
FIXED_TEAM = D('1174958')            # постоянные расходы business.md §7 (команда, база, сервисы)
INFRA_BASE = D('55378')              # 5 ВМ (business.md §5)
NPD_SERVICES = D('10000')            # почта, домены, бухгалтер для НПД — допущение

# Привлечение и отток (business.md §6; internal_costs.md §10).
CAC_BASE = D('7633')                 # 7 000 рекламы + 30 мин оператора
CAC_LOW = D('4633')
CAC_OPTIN = D('100') / (D('0.05') * D('0.15')) + D('633')  # клик 100 ₽, 5 %, opt-in 15 %
CHURNS = [D('0.03'), D('0.04'), D('0.07')]

# Тарифы: (название, ₽ в месяц, кредитов в месяц, сайтов, действий при обычном использовании)
CURRENT = [('Старт', D('4900'), D('300'), 1, D('12')), ('Бизнес', D('12900'), D('800'), 3, D('40')),
           ('Агентство', D('39900'), D('2500'), 15, D('150'))]
CURRENT_PACK = (D('1990'), D('100'))
# Рекомендуемый вариант (Р) и альтернатива «ниже всех» (А).
VAR_R = [('Старт', D('1990'), D('150'), 1, D('12')), ('Бизнес', D('6990'), D('600'), 3, D('40')),
         ('Агентство', D('19990'), D('2000'), 15, D('150'))]
VAR_R_PACK = (D('1490'), D('100'))
VAR_A = [('Старт', D('1990'), D('150'), 1, D('12')), ('Бизнес', D('4490'), D('400'), 3, D('40')),
         ('Агентство', D('14990'), D('1500'), 15, D('150'))]
VAR_A_PACK = (D('1490'), D('100'))
# Полная стоимость агента Пастухова в месяц (не подтверждено): подписка 4 900 ₽ + OpenCode Go $5
# + модель 1–3 тыс. ₽ (слова автора) + VDS Timeweb от 1 940 ₽ (ru_ai_alternatives.md §1, ru_human_services.md §2).
PASTUKHOV_LOW = D('4900') + D('5') * FX + D('1000') + D('1940')
PASTUKHOV_HIGH = D('4900') + D('5') * FX + D('3000') + D('1940')
MIX = [D('0.70'), D('0.25'), D('0.05')]   # доли клиентов по тарифам (business.md)
GIFT_NEW = D('50')
YEAR_MONTHS_PAID = D('10')                # год = 10 месяцев («два месяца в подарок»)


# ----------------------------------------------------------------------------------------------
# Помощники
# ----------------------------------------------------------------------------------------------

def q(x, places=2):
    if x is None:
        return '—'
    exp = D(1).scaleb(-places)
    return f"{x.quantize(exp, rounding=ROUND_HALF_UP):,}".replace(',', ' ')


def pc(x, places=1):
    return q(x * 100, places) + ' %'


def table(title, headers, rows):
    print(f"\n### {title}\n")
    print('| ' + ' | '.join(headers) + ' |')
    print('|' + '|'.join(['---'] * len(headers)) + '|')
    for r in rows:
        print('| ' + ' | '.join(str(c) for c in r) + ' |')


def api_usd(inp, out, cache, prices=API):
    return ((1 - cache) * inp * prices['in'] + cache * inp * prices['cache'] + out * prices['out']) / D(10) ** 6


def plan_credits(inp, out, cache):
    return ((1 - cache) * inp * PLAN_MULT['in'] + cache * inp * PLAN_MULT['cache'] + out * PLAN_MULT['out']) / D(10000)


def round_half_up(x):
    return x.quantize(D(1), rounding=ROUND_HALF_UP)


# Реальный рубль Z.ai на рубль учётной стоимости и реальная стоимость кредита работы на API.
REAL_PER_ACC = FX / (FX_RATES_FILE * RATES_MARKUP)
K_REAL = K * REAL_PER_ACC


def compute_per_action():
    minute = lambda cpu, ram: (cpu * VCPU_H + ram * RAM_GB_H) / 60
    sandbox = minute(*SANDBOX) * TURN_MIN * PASSES_PER_ACTION / LOAD
    preview = minute(*PREVIEW) * PREVIEW_MIN_PER_ACTION / LOAD * PREVIEW_SHARE
    browser = minute(*BROWSER) * BROWSER_MIN / LOAD * BROWSER_SHARE
    return minute(*SANDBOX), minute(*PREVIEW), minute(*BROWSER), sandbox, preview, browser


SB_MIN, PV_MIN, BR_MIN, SB_ACT, PV_ACT, BR_ACT = compute_per_action()
COMPUTE_PER_ACTION = SB_ACT + PV_ACT + BR_ACT
COMPUTE_PER_CREDIT = COMPUTE_PER_ACTION / CREDITS_PER_ACTION


def mix_task(cache):
    """Средняя задача смеси: учётные ₽, кредиты работы, списанные кредиты (минимум 5)."""
    usd = D(0); work = D(0); charged = D(0)
    for inp, out, share in TASKS.values():
        u = api_usd(inp, out, cache)
        w = u * FX / REAL_PER_ACC / K          # кредиты работы
        usd += share * u
        work += share * w
        charged += share * max(D(5), round_half_up(w))
    return usd * FX, work, charged


# Стоимость модели на списанный кредит на API (реальные ₽), по сценариям.
_, W80, C80 = mix_task(D('0.80'))
_, W92, C92 = mix_task(D('0.92'))
DEV_REAL_PER_CREDIT_CHARGED = DEV_CHARGED_ACC / DEV_CHARGED_CREDITS * REAL_PER_ACC
DEV_REAL_PER_CREDIT_ALL = DEV_TOTAL_ACC / DEV_CHARGED_CREDITS * REAL_PER_ACC
COST = {
    'dev': DEV_REAL_PER_CREDIT_ALL,                            # замер, с неоплаченной работой
    'mix80': K_REAL * (W80 / C80) * (1 + UNPAID_DOCS),         # база «обычного использования»
    'full25': K_REAL * (1 + UNPAID_DOCS),
    'full_dev': K_REAL * (1 + UNPAID_DEV),                     # стресс «вся квота»
    'limit': K_REAL * 2,                                       # предел правил: ещё раз квота
    'limit50': K_REAL * D('1.5'),                              # если предел сузить до 50 %
}
BASE_TYPICAL = COST['mix80']
STRESS = COST['full_dev']


def tariff_rows(tariffs, fee, tax, model_typ=BASE_TYPICAL, model_full=STRESS, compute=COMPUTE_PER_CREDIT,
                extra_full=None):
    rows = []
    for name, price, credits, sites, actions in tariffs:
        net = price * (1 - fee - tax)
        used = actions * CREDITS_PER_ACTION
        cost_t = used * (model_typ + compute) + sites * BACKUP_PER_SITE
        cost_f = credits * (model_full + compute) + sites * BACKUP_PER_SITE
        row = dict(name=name, price=price, credits=credits, sites=sites, per_credit=price / credits,
                   net=net, used=used, cost_t=cost_t, contrib_t=net - cost_t, cost_f=cost_f,
                   contrib_f=net - cost_f)
        if extra_full is not None:
            cost_x = credits * (extra_full + compute) + sites * BACKUP_PER_SITE
            row['contrib_x'] = net - cost_x
            cost_y = credits * (COST['limit50'] + compute) + sites * BACKUP_PER_SITE
            row['contrib_y'] = net - cost_y
        rows.append(row)
    return rows


def avg_client(tariffs, fee, tax, model_typ=BASE_TYPICAL):
    rows = tariff_rows(tariffs, fee, tax, model_typ=model_typ)
    arpu = sum(m * r['price'] for m, r in zip(MIX, rows))
    contrib = sum(m * r['contrib_t'] for m, r in zip(MIX, rows))
    credits_used = sum(m * r['used'] for m, r in zip(MIX, rows))
    return arpu, contrib, credits_used


# ----------------------------------------------------------------------------------------------
# Раздел 2. Z.ai сегодня
# ----------------------------------------------------------------------------------------------

print('# Расчёты к отчёту «Конкуренты и новые тарифы Радити», 06.11.2026')
print(f"\nКурс {FX} ₽/$; реальный рубль Z.ai на рубль учётной стоимости — {q(REAL_PER_ACC, 5)}; "
      f"кредит работы (K = {K} учётных ₽) на API стоит {q(K_REAL, 3)} ₽ платежа Z.ai.")

rows = []
for tier, (usd, w5, week) in PLAN.items():
    m = usd * FX
    rows.append([tier, q(usd), q(m), q(usd * 3 * (1 - QUARTER_DISCOUNT) * FX),
                 q(usd * 12 * (1 - YEAR_DISCOUNT) * FX), q(usd * (1 - YEAR_DISCOUNT) * FX),
                 f"{q(w5, 0)} / {q(week, 0)}"])
table('2.1 План GLM Coding Plan в рублях', ['Уровень', '$ в месяц', '₽ в месяц', '₽ квартал', '₽ год',
      '₽ в месяц при годовой', 'Квота 5 ч / неделя'], rows)

rows = []
for name, p in [('GLM-5.3', API), ('GLM-5.3-FlashX', API_FLASHX), ('GLM-5.3-Flash', API_FLASH)]:
    rows.append([name, f"{p['in']} / {p['cache']} / {p['out']}",
                 f"{q(p['in'] * FX)} / {q(p['cache'] * FX)} / {q(p['out'] * FX)}"])
table('2.2 API Z.ai за 1 млн токенов', ['Модель', '$ ввод / кэш / вывод', '₽ ввод / кэш / вывод'], rows)

rows = []
for name, (inp, out, share) in list(TASKS.items()) + [('Средняя 60/32/8', (None, None, None))]:
    cells = [name]
    for c in [D('0'), D('0.80'), D('0.92')]:
        if inp is None:
            rub, work, charged = mix_task(c)
            cells.append(f"{q(rub)} ₽")
        else:
            cells.append(f"{q(api_usd(inp, out, c) * FX)} ₽")
    for c in [D('0.80'), D('0.92')]:
        if inp is None:
            k_ = sum(s * plan_credits(i, o, c) for i, o, s in TASKS.values())
        else:
            k_ = plan_credits(inp, out, c)
        cells.append(f"{q(k_, 1)} / {q(k_ * OFF_PEAK, 1)}")
    rows.append(cells)
table('2.3 Задача business.md на API (реальные ₽) и в кредитах плана (пик / вне пика)',
      ['Задача', 'API, кэш 0 %', 'API, кэш 80 %', 'API, кэш 92 %', 'План, кэш 80 %', 'План, кэш 92 %'], rows)

rows = []
for c in [D('0'), D('0.80'), D('0.92'), D('0.95')]:
    rub, work, charged = mix_task(c)
    rows.append([pc(c, 0), q(rub), q(work), q(charged), q(rub / charged), q(work / charged, 3)])
table('2.4 Средняя задача смеси: кредиты работы и списания при K = 6,00 (минимум 5)',
      ['Кэш', 'API, ₽', 'Кредитов работы', 'Списано кредитов', 'Реальные ₽ на списанный кредит',
       'Доля работы в списанном кредите'], rows)

tot_calls = sum(v[0] for v in DEV_CALLS.values())
tot_in = sum(v[1] for v in DEV_CALLS.values())
tot_cache = sum(v[2] for v in DEV_CALLS.values())
tot_out = sum(v[3] for v in DEV_CALLS.values())
tot_acc = sum(v[4] for v in DEV_CALLS.values())
dev_plan_credits = (tot_in * PLAN_MULT['in'] + tot_cache * PLAN_MULT['cache'] + tot_out * PLAN_MULT['out']) / 10000
print(f"\n### 2.5 Замер dev-базы (620 вызовов)\n")
print(f"- Учётная стоимость вызовов {q(tot_acc)} ₽, реальная на API сегодня {q(tot_acc * REAL_PER_ACC)} ₽; "
      f"на вызов {q(tot_acc / tot_calls, 3)} / {q(tot_acc * REAL_PER_ACC / tot_calls, 3)} ₽.")
print(f"- Доля кэша {pc(tot_cache / (tot_in + tot_cache))}; кредитов плана по формуле: всего {q(dev_plan_credits, 0)} "
      f"в пик, {q(dev_plan_credits / tot_calls, 2)} на вызов (вне пика вдвое меньше).")
print(f"- Проверка: API-цена тех же токенов zai-api по ставкам файла = "
      f"{q((DEV_CALLS['zai-api'][1] * API['in'] + DEV_CALLS['zai-api'][2] * API['cache'] + DEV_CALLS['zai-api'][3] * API['out']) / 10**6 * FX_RATES_FILE * RATES_MARKUP)} ₽ (в базе 676,60).")
print(f"- Списано {DEV_CHARGED_CREDITS} кредитов за {DEV_CHARGED_TASKS} задач: {q(DEV_CHARGED_CREDITS / DEV_CHARGED_TASKS)} кредита на задачу; "
      f"работы у этих задач — {q(DEV_CHARGED_ACC / K)} кредитов: минимум увеличил списания в {q(DEV_CHARGED_CREDITS / (DEV_CHARGED_ACC / K))} раза.")
print(f"- Неоплаченная работа {q(DEV_TOTAL_ACC - DEV_CHARGED_ACC)} ₽ = {pc((DEV_TOTAL_ACC - DEV_CHARGED_ACC) / DEV_TOTAL_ACC)} всей работы = "
      f"{pc(UNPAID_DEV)} оплаченной.")
print(f"- Реальные ₽ API на списанный кредит: только оплаченная работа {q(DEV_REAL_PER_CREDIT_CHARGED)}, со всей работой "
      f"{q(DEV_REAL_PER_CREDIT_ALL)}; кредитов плана (пик) на списанный кредит со всей работой {q(dev_plan_credits / DEV_CHARGED_CREDITS, 1)}.")
DEV_PLAN_PER_CREDIT = dev_plan_credits / DEV_CHARGED_CREDITS

# Рубль кредита плана при полной загрузке недели (пик): месяц уровня ÷ кредитов плана в месяц.
PLAN_RUB_PER_PCREDIT = {t: usd * FX / (week * WEEKS_PER_MONTH) for t, (usd, w5, week) in PLAN.items()}
rows = []
for name, (n, inp, cache, out, avg, med, p90, mx, mins) in DEV_TURNS.items():
    pcred = plan_credits(inp, out, cache) if inp is not None else None
    rows.append([name, n, q(avg * REAL_PER_ACC), q(med * REAL_PER_ACC) if med else '—',
                 q(p90 * REAL_PER_ACC) if p90 else '—', q(mx * REAL_PER_ACC),
                 q(pcred, 1) if pcred else '—',
                 f"{q(pcred * PLAN_RUB_PER_PCREDIT['Lite'])} / {q(pcred * PLAN_RUB_PER_PCREDIT['Max'])}" if pcred else '—',
                 q(mins, 1)])
table('2.6 Ход по видам чата: реальные ₽ на API (среднее, медиана, p90, максимум), кредиты плана (пик) '
      'и ₽ на плане Lite / Max при полной загрузке недели',
      ['Вид', 'Ходов', 'Среднее ₽', 'Медиана ₽', 'p90 ₽', 'Макс ₽', 'Кредитов плана, среднее',
       '₽ на плане Lite / Max', 'Мин'], rows)

rows = []
for name, (inp, out, share) in TASKS.items():
    k80 = plan_credits(inp, out, D('0.80'))
    rows.append([name, q(api_usd(inp, out, D('0.80')) * FX), q(k80 * PLAN_RUB_PER_PCREDIT['Lite']),
                 q(k80 * PLAN_RUB_PER_PCREDIT['Max']), q(k80 * PLAN_RUB_PER_PCREDIT['Max'] * OFF_PEAK)])
table('2.6а Задача business.md (кэш 80 %): API против плана при полной загрузке недели, ₽',
      ['Задача', 'API', 'Lite, пик', 'Max, пик', 'Max, вне пика'], rows)
print(f"\nРеальный вызов dev ({q(DEV_CALLS['zai-api'][0] + DEV_CALLS['zai-coding'][0], 0)} вызовов) против синтетического "
      f"запроса 4,2 тыс. / 150 (1,24 кредита плана в пик): в {q((sum(v[1] for v in DEV_CALLS.values()) * PLAN_MULT['in'] + sum(v[2] for v in DEV_CALLS.values()) * PLAN_MULT['cache'] + sum(v[3] for v in DEV_CALLS.values()) * PLAN_MULT['out']) / 10000 / sum(v[0] for v in DEV_CALLS.values()) / plan_credits(D('4200'), D('150'), D('0.922')), 1)} раза дороже в кредитах плана.")

rows = []
for name, (med, p90, mx) in DEV_CHAINS.items():
    rows.append([name, f"{q(med)} кр. = {q(med * K_REAL)} ₽", f"{q(p90)} кр. = {q(p90 * K_REAL)} ₽" if p90 else '—',
                 f"{q(mx)} кр. = {q(mx * K_REAL)} ₽"])
table('2.7 Проход (цепочка) в кредитах работы и реальных ₽ API', ['Вид', 'Медиана', 'p90', 'Максимум'], rows)

rows = []
for tier, (usd, w5, week) in PLAN.items():
    month = usd * FX
    cap_peak = week * WEEKS_PER_MONTH / DEV_PLAN_PER_CREDIT
    cap_off = cap_peak / OFF_PEAK
    rows.append([tier, q(month), q(week * WEEKS_PER_MONTH, 0), q(cap_peak, 0), q(cap_off, 0),
                 q(month / cap_peak), q(month / cap_off), q(w5 / DEV_PLAN_PER_CREDIT, 0)])
table('2.8 Сколько списанных кредитов клиента выдерживает аккаунт плана в месяц (мера dev, со всей работой)',
      ['Уровень', '₽ в месяц', 'Кредитов плана в месяц', 'Кредитов клиента, всё в пик', 'Всё вне пика',
       '₽ на кредит клиента, пик', 'Вне пика', 'Кредитов клиента в окне 5 ч, пик'], rows)
print(f"\nДля сравнения: на API списанный кредит стоит {q(DEV_REAL_PER_CREDIT_ALL)} ₽ (замер) или "
      f"{q(BASE_TYPICAL)} ₽ (смесь токенов, кэш 80 %, неоплаченная работа 25 %).")

rows = []
for tier, (usd, w5, week) in PLAN.items():
    month = usd * FX
    content = api_usd(*TASKS['Контент'][:2], D('0.92')) * FX
    mix = mix_task(D('0.92'))[0]
    rows.append([tier, q(month / content, 0), q(month / mix, 0), q(month / DEV_REAL_PER_CREDIT_ALL, 0)])
table('2.9 Когда план дешевле API: число задач или кредитов в месяц, при котором месяц плана = API',
      ['Уровень', 'Контентных задач (кэш 92 %)', 'Средних задач (кэш 92 %)', 'Списанных кредитов (замер dev)'], rows)

# ----------------------------------------------------------------------------------------------
# Раздел 4. Юнит-экономика
# ----------------------------------------------------------------------------------------------

print('\n## 4. Юнит-экономика')
print(f"\n- Вычисления: минута песочницы {q(SB_MIN, 4)} ₽, предпросмотра {q(PV_MIN, 4)} ₽, браузера {q(BR_MIN, 4)} ₽; "
      f"на действие при загрузке 35 %: песочница {q(SB_ACT)}, предпросмотр {q(PV_ACT)}, браузер {q(BR_ACT)}; "
      f"итого {q(COMPUTE_PER_ACTION)} ₽ на действие = {q(COMPUTE_PER_CREDIT)} ₽ на кредит.")
print(f"- Эскалация (ООО): {q(ESCALATION_PER_TASK)} ₽ на задачу = {q(ESCALATION_PER_TASK / CREDITS_PER_ACTION)} ₽ на кредит; бэкапы {BACKUP_PER_SITE} ₽ на сайт.")
print(f"- Удержания НПД: ЮKassa {pc(YK_NPD, 2)} + НПД {pc(NPD_TAX, 0)} = {pc(YK_NPD + NPD_TAX, 2)}; "
      f"ООО/ИП: ЮKassa {pc(YK_LEGAL, 2)} + УСН {pc(USN, 0)} = {pc(YK_LEGAL + USN, 2)}.")

rows = [
    ['Замер dev, со всей работой', q(COST['dev'])],
    ['Смесь токенов, кэш 80 %, неоплаченная 25 % (база обычного использования)', q(COST['mix80'])],
    ['Каждый кредит — полная работа, неоплаченная 25 %', q(COST['full25'])],
    ['Каждый кредит — полная работа, неоплаченная как в dev (стресс «вся квота»)', q(COST['full_dev'])],
    ['Предел правил: неоплаченная = ещё раз квота', q(COST['limit'])],
    ['Если предел неоплаченной сузить до 50 % квоты', q(COST['limit50'])],
]
table('4.1 Модель на API: реальные ₽ на списанный кредит', ['Сценарий', '₽'], rows)
print(f"\nДоля работы в списанном кредите: смесь 80 % — {q(W80 / C80, 3)}, 92 % — {q(W92 / C92, 3)}, "
      f"dev (только оплаченные) — {q(DEV_CHARGED_ACC / K / DEV_CHARGED_CREDITS, 3)}.")

rows = []
for label, tariffs, pack in [('Сейчас', CURRENT, CURRENT_PACK), ('Вариант Р', VAR_R, VAR_R_PACK),
                             ('Вариант А', VAR_A, VAR_A_PACK)]:
    for name, price, credits, sites, _ in tariffs:
        net = price / credits * (1 - YK_NPD - NPD_TAX)
        rows.append([label, name, q(price / credits), q(net), q(net - STRESS - COMPUTE_PER_CREDIT),
                     q(price / credits / K_REAL, 2)])
    net = pack[0] / pack[1] * (1 - YK_NPD - NPD_TAX)
    rows.append([label, 'Пакет', q(pack[0] / pack[1]), q(net), q(net - STRESS - COMPUTE_PER_CREDIT),
                 q(pack[0] / pack[1] / K_REAL, 2)])
table('4.2 Кредит: цена клиенту, чистыми после 8,27 %, запас над стрессом (модель 7,17 + вычисления), '
      'цена ÷ реальная стоимость кредита работы',
      ['Цены', 'Тариф', '₽ за кредит', 'Чистыми', 'Запас при стрессе', 'Цена / K реальный'], rows)

for label, tariffs in [('Сейчас', CURRENT), ('Вариант Р', VAR_R), ('Вариант А', VAR_A)]:
    rr = tariff_rows(tariffs, YK_NPD, NPD_TAX, extra_full=COST['limit'])
    rows = []
    for r in rr:
        rows.append([r['name'], q(r['price'], 0), q(r['credits'], 0), q(r['used'], 0), q(r['net'], 0),
                     q(r['cost_t'], 0), f"{q(r['contrib_t'], 0)} ({pc(r['contrib_t'] / r['price'])})",
                     q(r['cost_f'], 0), f"{q(r['contrib_f'], 0)} ({pc(r['contrib_f'] / r['price'])})",
                     f"{q(r['contrib_x'], 0)} ({pc(r['contrib_x'] / r['price'])})",
                     f"{q(r['contrib_y'], 0)} ({pc(r['contrib_y'] / r['price'])})"])
    table(f'4.3 {label}: тариф при обычном использовании и при всей квоте (НПД, модель на API)',
          ['Тариф', 'Цена', 'Кредитов', 'Обычно тратит', 'Чистыми', 'Затраты обычно', 'Вклад обычно',
           'Затраты, вся квота (стресс)', 'Вклад, вся квота', 'Вклад на пределе правил (100 %)',
           'Вклад при пределе 50 %'], rows)

# План как верхняя граница экономии: модель — постоянный расход аккаунта.
print("\n### 4.4 План вместо API: модель на кредит при полной загрузке аккаунта")
for tier, (usd, w5, week) in PLAN.items():
    cap = week * WEEKS_PER_MONTH / DEV_PLAN_PER_CREDIT
    print(f"- {tier}: {q(usd * FX / cap)} ₽ на списанный кредит в пик, {q(usd * FX / cap * OFF_PEAK)} вне пика "
          f"(против {q(DEV_REAL_PER_CREDIT_ALL)}–{q(BASE_TYPICAL)} ₽ на API).")

# Средний клиент, CAC, LTV, окупаемость.
rows = []
for label, tariffs in [('Сейчас', CURRENT), ('Вариант Р', VAR_R), ('Вариант А', VAR_A)]:
    arpu, contrib, used = avg_client(tariffs, YK_NPD, NPD_TAX)
    rows.append([label, q(arpu, 0), q(used, 1), q(contrib, 0), pc(contrib / arpu),
                 q(CAC_BASE / contrib, 1), q(CAC_OPTIN / contrib, 1),
                 q(contrib / D('0.04') / CAC_BASE, 1), q(contrib / D('0.04') / CAC_OPTIN, 1)])
table('4.5 Средний клиент (70/25/5 %), НПД, модель на API, обычное использование',
      ['Цены', 'Средний чек', 'Кредитов в месяц', 'Вклад', 'Маржа', 'Окупаемость, мес (CAC 7 633)',
       f'Окупаемость (CAC {q(CAC_OPTIN, 0)})', 'LTV/CAC при оттоке 4 % (7 633)', f'LTV/CAC (CAC {q(CAC_OPTIN, 0)})'], rows)

gift_cost = GIFT_NEW * (BASE_TYPICAL + COMPUTE_PER_CREDIT)
print(f"\nПодарок {GIFT_NEW} кредитов: до {q(gift_cost, 0)} ₽ на зарегистрированного; на платящего — "
      f"{q(gift_cost / D('0.15'), 0)} ₽ при конверсии 15 %, {q(gift_cost / D('0.30'), 0)} ₽ при 30 %; "
      f"при полной работе в кредите и неоплаченной как в dev — {q(GIFT_NEW * (STRESS + COMPUTE_PER_CREDIT), 0)} ₽.")
print(f"CAC при opt-in 15 %: {q(CAC_OPTIN, 0)} ₽ (100 ₽ клик / (5 % × 15 %) + 633 ₽ онбординга).")

# Безубыточность (а): НПД, потолок 2,4 млн ₽ в год.
print("\n### 4.6 Безубыточность (а): самозанятая, потолок 2,4 млн ₽ в год")
cap_month = NPD_CAP_YEAR / 12
for label, tariffs in [('Сейчас', CURRENT), ('Вариант Р', VAR_R), ('Вариант А', VAR_A)]:
    arpu, contrib, used = avg_client(tariffs, YK_NPD, NPD_TAX)
    clients = (cap_month / arpu).to_integral_value(rounding=ROUND_FLOOR)
    total_contrib = clients * contrib
    churn_cac = clients * D('0.04') * CAC_BASE
    plan_pro = PLAN['Pro'][0] * FX
    model_api = clients * used * BASE_TYPICAL
    owner = total_contrib - churn_cac - INFRA_BASE - NPD_SERVICES
    owner_plan = owner + model_api - plan_pro
    only_start = (cap_month / tariffs[0][1]).to_integral_value(rounding=ROUND_FLOOR)
    print(f"- {label}: средний чек {q(arpu, 0)} ₽ → не больше {clients} платящих (только «Старт» — {only_start}); "
          f"кредитов в месяц {q(clients * used, 0)}; вклад {q(total_contrib, 0)} ₽; замена оттока 4 % по CAC 7 633 — "
          f"{q(churn_cac, 0)} ₽; база 5 ВМ {q(INFRA_BASE, 0)} ₽ и сервисы {q(NPD_SERVICES, 0)} ₽ → остаётся владельцу "
          f"{q(owner, 0)} ₽ в месяц на API; на плане Pro (модель {q(model_api, 0)} ₽ → {q(plan_pro, 0)} ₽) — {q(owner_plan, 0)} ₽.")
    print(f"  Постоянные расходы, которые выдерживает потолок без дохода владельца: {q(total_contrib - churn_cac, 0)} ₽ "
          f"(на плане Pro — {q(total_contrib - churn_cac + model_api - plan_pro, 0)} ₽).")

# Безубыточность (б): ООО/ИП на УСН с командой business.md.
print("\n### 4.7 Безубыточность (б): ООО или ИП на УСН с командой business.md (1 174 958 ₽ в месяц)")
rows = []
for label, tariffs in [('Сейчас', CURRENT), ('Вариант Р', VAR_R), ('Вариант А', VAR_A)]:
    arpu, contrib, used = avg_client(tariffs, YK_LEGAL, USN)
    clients = FIXED_TEAM / contrib
    with_churn = FIXED_TEAM / (contrib - D('0.04') * CAC_BASE)
    arpu_p, contrib_p, used_p = avg_client(tariffs, YK_LEGAL, USN, model_typ=D('0'))
    plan_clients = FIXED_TEAM / contrib_p
    max_cap = PLAN['Max'][2] * WEEKS_PER_MONTH / DEV_PLAN_PER_CREDIT
    accounts = plan_clients * used / max_cap
    rows.append([label, q(arpu, 0), q(contrib, 0), q(clients, 0), q(with_churn, 0), q(clients * arpu, 0),
                 q(clients * used, 0), f"{q(plan_clients, 0)} (аккаунтов Max: {q(accounts, 1)} в пик, {q(accounts * OFF_PEAK, 1)} вне пика)"])
table('4.7 Сколько платящих нужно', ['Цены', 'Средний чек', 'Вклад клиента', 'Безубыточность, клиентов',
      'С заменой оттока 4 % по CAC 7 633', 'Выручка в месяц при безубыточности, ₽',
      'Кредитов в месяц при безубыточности', 'На плане: клиентов (модель ≈ 0) и аккаунтов Max'], rows)

# ----------------------------------------------------------------------------------------------
# Чувствительность
# ----------------------------------------------------------------------------------------------

print('\n## 4.8 Чувствительность (вариант Р, НПД)')
rows = []
for mult in [D('0.5'), D('1'), D('2'), D('5')]:
    rr = tariff_rows(VAR_R, YK_NPD, NPD_TAX, model_typ=BASE_TYPICAL * mult, model_full=STRESS * mult)
    arpu, contrib, used = avg_client(VAR_R, YK_NPD, NPD_TAX, model_typ=BASE_TYPICAL * mult)
    rows.append([f"×{mult}"] + [f"{pc(r['contrib_t'] / r['price'], 0)} / {pc(r['contrib_f'] / r['price'], 0)}" for r in rr]
                + [pc(contrib / arpu, 0)])
table('4.8.1 Цена модели (ничего не пересчитано): маржа «обычно / вся квота»',
      ['Модель', 'Старт', 'Бизнес', 'Агентство', 'Средний клиент'], rows)

rows = []
for c in CACHES:
    rub, work, charged = mix_task(c)
    per_credit = K_REAL * (work / charged) * (1 + UNPAID_DOCS)
    rows.append([pc(c, 0), q(charged, 2), q(D(150) / charged, 1), q(per_credit)])
table('4.8.2 Доля кэша: средняя задача смеси в кредитах, задач в «Старте» Р (150), ₽ модели на кредит',
      ['Кэш', 'Списано на задачу', 'Задач в 150 кредитах', '₽ на кредит (неопл. 25 %)'], rows)

rows = []
for f in [D('0.85'), D('1'), D('1.15')]:
    rr = tariff_rows(VAR_R, YK_NPD, NPD_TAX, model_typ=BASE_TYPICAL * f, model_full=STRESS * f)
    rows.append([f"{q(FX * f, 2)} ₽/$", q(K_REAL * f, 3)] + [f"{q(r['contrib_t'], 0)} / {q(r['contrib_f'], 0)}" for r in rr])
table('4.8.3 Курс ±15 %: реальный K и вклад «обычно / вся квота», ₽',
      ['Курс', 'K реальный', 'Старт', 'Бизнес', 'Агентство'], rows)

arpu, contrib, used = avg_client(VAR_R, YK_NPD, NPD_TAX)
rows = []
for churn in CHURNS:
    cells = [pc(churn, 0)]
    for cac in [CAC_LOW, CAC_BASE, CAC_OPTIN]:
        cells.append(f"{q(contrib / churn / cac, 1)} ({q(cac / contrib, 1)} мес)")
    rows.append(cells)
table(f'4.8.4 Средний клиент Р (вклад {q(contrib, 0)} ₽): LTV/CAC (окупаемость)',
      ['Отток', f'CAC {q(CAC_LOW, 0)}', f'CAC {q(CAC_BASE, 0)}', f'CAC {q(CAC_OPTIN, 0)}'], rows)

clients_cap = (cap_month / arpu).to_integral_value(rounding=ROUND_FLOOR)
credits_month = clients_cap * used
rows = [['API (база)', q(credits_month * BASE_TYPICAL, 0), '—']]
for tier, (usd, w5, week) in PLAN.items():
    cap_peak = week * WEEKS_PER_MONTH / DEV_PLAN_PER_CREDIT
    rows.append([f"План {tier}", q(usd * FX, 0), f"{pc(credits_month / cap_peak, 0)} в пик, {pc(credits_month / cap_peak * OFF_PEAK, 0)} вне пика"])
table(f'4.8.5 План против API при потолке НПД ({clients_cap} клиентов Р, {q(credits_month, 0)} кредитов в месяц)',
      ['Путь', 'Модель в месяц, ₽', 'Загрузка недельной квоты'], rows)

# ----------------------------------------------------------------------------------------------
# Раздел 5. Цены действий и сравнение с конкурентами
# ----------------------------------------------------------------------------------------------

print('\n## 5. Новые тарифы')
rows = []
for label, tariffs, pack in [('Сейчас', CURRENT, CURRENT_PACK), ('Вариант Р', VAR_R, VAR_R_PACK),
                             ('Вариант А', VAR_A, VAR_A_PACK)]:
    for name, price, credits, sites, _ in tariffs + [('Пакет', pack[0], pack[1], 0, 0)]:
        pcr = price / credits
        rows.append([label, name, q(pcr), q(pcr * 5, 0), q(pcr * 7, 0), q(pcr * 11, 0), q(pcr * 29, 0),
                     q(credits / 5, 0), q(credits / CREDITS_PER_ACTION, 0)])
table('5.1 Цена действия для клиента, ₽', ['Цены', 'Тариф', '₽ за кредит', 'Небольшая правка (5)',
      'Обычное действие (7)', 'Прежнее среднее (11)', 'Большая задача (29)', 'Небольших правок в квоте',
      'Обычных действий в квоте'], rows)

rows = []
for label, tariffs in [('Вариант Р', VAR_R), ('Вариант А', VAR_A)]:
    for name, price, credits, sites, _ in tariffs:
        rows.append([label, name, q(price, 0), q(price * YEAR_MONTHS_PAID, 0), q(price * YEAR_MONTHS_PAID / 12, 0),
                     pc(1 - YEAR_MONTHS_PAID / 12)])
table('5.2 Годовая оплата «два месяца в подарок»', ['Цены', 'Тариф', 'Месяц', 'Год', 'В месяц при годовой', 'Скидка'], rows)

usd = lambda x: x * FX
competitors = {  # (конкурент, ₽ в месяц, сколько сайтов покрывает цена)
    'Старт': [
        ('Агент Пастухова, подписка «Бизнес» (не подтв.)', D('4900'), 1),
        ('Агент Пастухова, полная стоимость: подписка + OpenCode Go + модель + VDS (не подтв.)', PASTUKHOV_LOW, 1),
        ('Битрикс24 «Сайты AI»: Базовый + BitrixGPT, акция', D('2490') + D('500'), 1),
        ('Битрикс24 «Сайты AI»: Базовый + BitrixGPT', D('2490') + D('1000'), 1),
        ('GoWP Pro, $39 за сайт', usd(D('39')), 1),
        ('LS-Studio, 4 ч контента (цены 2023)', D('4000'), 1),
        ('Adict, 3 ч (Tilda)', D('6900'), 1),
        ('FL.ru, до 5 задач', D('5500'), 1),
        ('OpenStart, 3 ч', D('8700'), 1),
        ('Lovable Pro, $25 (новые проекты)', usd(D('25')), 1),
        ('SiteGround StartUp, продление $17,99 (хостинг + агент)', usd(D('17.99')), 1),
        ('Архитект АИ «Профи» (сайт переезжает)', D('1599'), 3),
    ],
    'Бизнес': [
        ('Атум «Бизнес», 10 ч, до 3 сайтов', D('40000'), 3),
        ('GoWP Pro × 3 сайта', usd(D('39')) * 3, 3),
        ('GoWP Business, $99 за сайт', usd(D('99')), 1),
        ('Битрикс24 Стандартный + BitrixGPT, акция', D('6990') + D('1500'), 3),
        ('Агент Пастухова, подписка (не подтв.)', D('4900'), 3),
        ('Агент Пастухова, полная стоимость (не подтв.)', PASTUKHOV_HIGH, 3),
        ('Студия, медиана входа × 1 сайт', D('14900'), 1),
        ('Архитект АИ «Магазин», 3 сайта', D('3990'), 3),
    ],
    'Агентство': [
        ('GoWP white label $49 + 15 × $39', usd(D('49') + 15 * D('39')), 15),
        ('Атум «Корпоративный», от', D('120000'), 15),
        ('Полставки удалённого контент-менеджера на руки', D('36000'), 15),
        ('WP Buffs Protect, $147 за сайт (не подтв.)', usd(D('147')), 1),
        ('Студия, медиана входа за сайт', D('14900'), 1),
        ('Архитект АИ «Агентство», 15 сайтов', D('5990'), 15),
    ],
}
for label, tariffs in [('Вариант Р', VAR_R), ('Вариант А', VAR_A)]:
    rows = []
    for name, price, credits, sites, _ in tariffs:
        for cname, cprice, csites in competitors[name]:
            # сравнение за сайт, если конкурент продаёт один сайт, а тариф — несколько
            ours = price / sites if csites == 1 and sites > 1 else price
            basis = 'за сайт' if csites == 1 and sites > 1 else 'за тариф'
            rows.append([name, q(ours, 0), basis, cname, q(cprice, 0), pc(ours / cprice - 1, 0)])
    table(f'5.3 {label}: насколько ниже ближайших конкурентов (₽ в месяц)',
          ['Тариф', 'Радити', 'Как сравнено', 'Конкурент', 'Цена конкурента', 'Радити относительно'], rows)

ladder = [
    ('Mocha Bronze: простая правка, 5–15 кр.', usd(D('5') * D('0.0133')), usd(D('15') * D('0.0133'))),
    ('Lovable Pro: правка 0,5–1,2 кр. × $0,25', usd(D('0.125')), usd(D('0.30'))),
    ('Base44: сообщение $0,16–0,20', usd(D('0.16')), usd(D('0.20'))),
    ('SiteGround: запись в блог 2–3 тыс. токенов по $10 за 100 тыс. (не подтв.)', usd(D('0.20')), usd(D('0.30'))),
    ('Архитект АИ: правка в чате (Профи … Старт)', D('1599') / 50, D('899') / 10),
    ('Радити, вариант Р: небольшая правка (5 кр.)', D('19990') / 2000 * 5, D('1490') / 100 * 5),
    ('Радити, вариант Р: обычное действие (7 кр.)', D('19990') / 2000 * 7, D('1490') / 100 * 7),
    ('Радити сейчас: небольшая правка (5 кр.)', D('39900') / 2500 * 5, D('1990') / 100 * 5),
    ('GoWP: AI-правка (Business … сверх квоты)', usd(D('99') / 50), usd(D('3'))),
    ('Kwork / Workzilla: задание', D('500'), D('2000')),
    ('FL.ru: правка (пакет из 5 … одна)', D('1100'), D('2990')),
    ('FixRunner: 30 минут человека', usd(D('69') / 90 * 30), usd(D('69') / 90 * 30)),
    ('Студия: 0,5–1 ч по 2 200–5 000 ₽', D('1100'), D('5000')),
    ('Codeable: 1 ч $80–120 + 17,5 %', usd(D('80') * D('1.175')), usd(D('120') * D('1.175'))),
]
table('3. Лестница цены одной небольшой правки, ₽', ['Кто', 'От', 'До'],
      [[n, q(a, 0), q(b, 0)] for n, a, b in ladder])

for label, tariffs in [('Р', VAR_R), ('А', VAR_A)]:
    rr = tariff_rows(tariffs, YK_NPD, NPD_TAX, extra_full=COST['limit'])
    worst = min(r['contrib_f'] for r in rr)
    worst50 = min(r['contrib_y'] for r in rr)
    print(f"\nПроверка варианта {label}: наименьший вклад при всей квоте (стресс) — {q(worst, 0)} ₽, "
          f"все ≥ 0: {all(r['contrib_f'] >= 0 for r in rr)}; при пределе неоплаченной 50 % — {q(worst50, 0)} ₽, "
          f"все ≥ 0: {all(r['contrib_y'] >= 0 for r in rr)}.")
print(f"Полная стоимость агента Пастухова в месяц (не подтв.): {q(PASTUKHOV_LOW, 0)}–{q(PASTUKHOV_HIGH, 0)} ₽.")

# Цены зарубежных конкурентов в рублях по курсу ЦБ 06.11.2026 (intl_direct_analogs.md,
# intl_credit_builders.md; там пересчёт шёл по 83 ₽/$, здесь — по 81,7947).
USD_PRICES = [
    ('SiteGround StartUp, промо / продление', D('1.99'), D('17.99')),
    ('SiteGround GrowBig, промо / продление', D('3.99'), D('29.99')),
    ('SiteGround: +100 тыс. токенов в месяц (не подтв.)', D('10'), D('10')),
    ('Hostinger Agent Plus, годовая / помесячно', D('6.99'), D('9.99')),
    ('GoWP Pro / Business, за сайт', D('39'), D('99')),
    ('GoWP: 10 AI-правок сверх квоты', D('30'), D('30')),
    ('WP Buffs Protect (не подтв.)', D('147'), D('179')),
    ('SiteCare Gold', D('435'), D('435')),
    ('FixRunner Premium, 90 мин', D('69'), D('69')),
    ('Elementor One, первый год / продление в месяц (не подтв.)', D('15'), D('19')),
    ('WordPress.com Personal / Business, помесячно', D('9'), D('40')),
    ('10Web AI Starter (годовая)', D('10'), D('10')),
    ('Lovable Pro / Bolt Pro / Durable Launch', D('25'), D('25')),
    ('Replit Core / Manus / Claude Pro', D('20'), D('20')),
    ('v0 Plus', D('30'), D('30')),
    ('Z.ai Team Standard / Premium, место', D('88'), D('188')),
    ('OpenCode Go', D('5'), D('5')),
]
table('3.1 Зарубежные цены в рублях (81,7947 ₽/$)', ['Что', '$ от', '$ до', '₽ от', '₽ до'],
      [[n, q(a), q(b), q(a * FX, 0), q(b * FX, 0)] for n, a, b in USD_PRICES])

# Производные числа, которые отчёт называет в тексте.
print('\n### Производные числа для текста отчёта')
r_pack = VAR_R_PACK[0] / VAR_R_PACK[1]
print(f"- Пакет Р дороже кредита тарифа: на {pc(r_pack / (VAR_R[0][1] / VAR_R[0][2]) - 1, 0)} («Старт») … "
      f"{pc(r_pack / (VAR_R[2][1] / VAR_R[2][2]) - 1, 0)} («Агентство»).")
plan_peak = [PLAN[t][0] * FX / (PLAN[t][2] * WEEKS_PER_MONTH / DEV_PLAN_PER_CREDIT) for t in PLAN]
print(f"- API (замер dev, {q(DEV_REAL_PER_CREDIT_ALL)} ₽) дороже загруженного плана: в {q(DEV_REAL_PER_CREDIT_ALL / max(plan_peak), 1)}–"
      f"{q(DEV_REAL_PER_CREDIT_ALL / min(plan_peak), 1)} раза в пик, в {q(DEV_REAL_PER_CREDIT_ALL / max(plan_peak) / OFF_PEAK, 1)}–"
      f"{q(DEV_REAL_PER_CREDIT_ALL / min(plan_peak) / OFF_PEAK, 1)} раза вне пика.")
for conv, cac in [(D('0.30'), CAC_BASE), (D('0.15'), CAC_OPTIN)]:
    print(f"- Подарок на платящего при конверсии {pc(conv, 0)}: {q(gift_cost / conv, 0)} ₽ = {pc(gift_cost / conv / cac)} CAC {q(cac, 0)} ₽.")
owner = {}
for label, tariffs in [('Сейчас', CURRENT), ('Р', VAR_R)]:
    arpu, contrib, used = avg_client(tariffs, YK_NPD, NPD_TAX)
    n = (cap_month / arpu).to_integral_value(rounding=ROUND_FLOOR)
    api = n * contrib - n * D('0.04') * CAC_BASE - INFRA_BASE - NPD_SERVICES
    owner[label] = (api, api + n * used * BASE_TYPICAL - PLAN['Pro'][0] * FX)
print(f"- Снижение цен у потолка НПД стоит владельцу {q(owner['Сейчас'][0] - owner['Р'][0], 0)} ₽ в месяц на API и "
      f"{q(owner['Сейчас'][1] - owner['Р'][1], 0)} ₽ на плане Pro.")
work_credits_dev = DEV_TOTAL_ACC / K
pc_per_work = dev_plan_credits / work_credits_dev
print(f"- Кредит работы = {q(pc_per_work, 1)} кредита плана в пик; проход браузера 41,32 кредита работы = "
      f"{q(D('41.32') * pc_per_work, 0)} кредитов плана = {pc(D('41.32') * pc_per_work / PLAN['Lite'][1], 0)} окна 5 ч Lite.")
print(f"- Маржа файла ставок к цене Z.ai по сегодняшнему курсу: {pc(RATES_MARKUP * FX_RATES_FILE / FX - 1)}.")
_, cr, _ = avg_client(VAR_R, YK_LEGAL, USN)
_, ca, _ = avg_client(VAR_A, YK_LEGAL, USN)
print(f"- ООО: рекомендуемой сетке нужно на {pc(1 - ca / cr, 0)} меньше клиентов, чем альтернативе.")
r_small = (D('19990') / 2000 * 5, D('1490') / 100 * 5)
print(f"- Небольшая правка Р ({q(r_small[0], 0)}–{q(r_small[1], 0)} ₽) дешевле людей в {q(D('500') / r_small[1], 1)}–"
      f"{q(D('5000') / r_small[0], 0)} раза и дороже конструкторов в {q(r_small[0] / usd(D('0.30')), 1)}–"
      f"{q(r_small[1] / usd(D('5') * D('0.0133')), 0)} раза.")
arpu_r, contrib_r, used_r = avg_client(VAR_R, YK_NPD, NPD_TAX)
n_r = (cap_month / arpu_r).to_integral_value(rounding=ROUND_FLOOR)
owner_half_cac = n_r * contrib_r - n_r * D('0.04') * CAC_BASE / 2 - INFRA_BASE - NPD_SERVICES + n_r * used_r * BASE_TYPICAL - PLAN['Pro'][0] * FX
print(f"- Если для Р CAC вдвое ниже ({q(CAC_BASE / 2, 0)} ₽), владельцу у потолка на плане Pro остаётся {q(owner_half_cac, 0)} ₽ "
      f"против {q(owner['Сейчас'][1], 0)} ₽ при нынешних ценах: разница {q(owner['Сейчас'][1] - owner_half_cac, 0)} ₽.")
