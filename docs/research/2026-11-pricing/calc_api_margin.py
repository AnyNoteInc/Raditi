#!/usr/bin/env python3
"""Радити: сколько кредитов могут дать тарифы при марже 10 %, если вся модель идёт через API Z.ai.

Запуск: python3 -I docs/research/2026-11-pricing/calc_api_margin.py (план 72)
Только стандартная библиотека, деньги — Decimal. Входы — константы ниже, у каждой — источник
(проверены 13.11.2026).

Маржа — доля цены тарифа, которая остаётся после всех переменных затрат:
    маржа = (P × (1 − d) − N × c − S × бэкап) / P
откуда наибольшее число кредитов при марже m (клиент выбрал всю квоту):
    N_max = (P × (1 − d − m) − S × бэкап) / c
c — затраты на один списанный кредит:
    c = K_usd × курс × (1 + доплата) × доля работы × (1 + бесплатная работа) + вычисления + поиск
"""
from decimal import Decimal as D, ROUND_HALF_UP, ROUND_FLOOR, getcontext

getcontext().prec = 40

# --- Цены на сайте: packages/db/prisma/seed/data.ts, миграция 20261106100000 (план 63, Ц1–Ц4) ---
TARIFFS = [  # название, ₽ в месяц, кредитов в месяц, сайтов, окно недели (план 71, Л4)
    ('Старт', D('1990'), 150, 1, 55),
    ('Бизнес', D('6990'), 600, 3, 210),
    ('Агентство', D('19990'), 2000, 15, 700),
]
PACK = D('1490')                      # 100 кредитов к тарифу; без тарифа ×2 (credit-numbers.ts)
GIFT = 50                             # signupGiftCredits

# --- Кредит в долларах API: infra/billing/rates/2026-10-17-zai-api.json (П85) ---
K = D('6.00')                         # кредит = 6,00 ₽ учётной стоимости
FX_FILE = D('83.6177')                # курс ЦБ 17.10.2026 в файле ставок
RATES_MARKUP = D('1.30')              # учётная ставка = цена API × курс × 1,30
K_USD = K / (FX_FILE * RATES_MARKUP)  # $ API на кредит полной работы: 0,055196
# Цена API GLM-5.3 $1,40 / $0,26 / $4,40 за 1 млн — docs.z.ai/guides/overview/pricing, 13.11.2026, без изменений.

FX = D('82.9803')                     # ЦБ на 13.11.2026 (на 14.11 — 82,1516)
DEDUCT = D('0.035') * D('1.22') + D('0.04')   # ЮKassa 3,5 % + НДС 22 % с комиссии (карта, SberPay) + НПД 4 %
DEDUCT_SBP = D('0.004') + D('0.04')           # СБП: предел ЦБ 0,4 % (решение от 17.03.2023) + НПД 4 %
BACKUP_PER_SITE = D('16')             # 4 ГБ × 4 ₽ (Timeweb S3 сверх 250 ГБ, 13.11.2026)
SEARCH_RUB = D('0.488')               # Yandex Search API, день, с НДС; кредиты его не оплачивают (spec §20, ВЯ6)
MARGIN = D('0.10')

# Сценарии. Во всех: клиент выбрал всю квоту, каждый списанный кредит несёт полный кредит работы
# (округление прохода вверх только уменьшает работу в кредите — запас, который здесь не считается).
SCEN = {
    'Оптимистичный': dict(surcharge=D('0.04'), unpaid=D('0.25'), compute=D('3.30') / D('4.5'), searches=D('0.2')),
    'Базовый': dict(surcharge=D('0.12'), unpaid=D('0.25'), compute=D('4.71') / D('3.52'), searches=D('0.5')),
    'Стресс': dict(surcharge=D('0.25'), unpaid=D('0.588'), compute=D('4.71') / D('2.5'), searches=D('1.5')),
}
# surcharge — доплата сверх курса ЦБ за пополнение USD-баланса Z.ai из России: 4 / 12 / 25 %;
# unpaid — бесплатная работа на рубль оплаченной (упавшие и остановленные проходы, сбои платформы):
#   25 % — допущение документов, 58,8 % — dev 25.10–06.11 при прежних правилах (замера после 10.11 нет);
# compute — вычисления на кредит = ₽ на действие ÷ кредитов на действие. Минимума 5 нет с 10.11.2026,
#   поэтому действие списывается в свою работу: 3,52 кредита в dev (84,47 кредита работы на 24 задачи).
#   3,30 ₽ (малые ВМ Cloud.ru) ÷ 4,5; 4,71 ₽ (business.md §6) ÷ 3,52; 4,71 ÷ 2,5;
# searches — запросов поиска на списанный кредит (замера нет; предел — 3 на ход).


def q(x, places=2):
    exp = D(1).scaleb(-places)
    return f"{x.quantize(exp, rounding=ROUND_HALF_UP):,}".replace(',', ' ')


def pc(x, places=1):
    return q(x * 100, places) + ' %'


def floor(x):
    return int(x.to_integral_value(rounding=ROUND_FLOOR))


def cost(s, fx=FX):
    model = K_USD * fx * (1 + s['surcharge']) * (1 + s['unpaid'])
    return model + s['compute'] + s['searches'] * SEARCH_RUB, model


def n_max(price, sites, c, deduct=DEDUCT, margin=MARGIN):
    return (price * (1 - deduct - margin) - sites * BACKUP_PER_SITE) / c


def margin_at(price, sites, credits, c, deduct=DEDUCT):
    return (price * (1 - deduct) - credits * c - sites * BACKUP_PER_SITE) / price


def table(title, headers, rows):
    print(f"\n### {title}\n")
    print('| ' + ' | '.join(headers) + ' |')
    print('|' + '|'.join(['---'] * len(headers)) + '|')
    for r in rows:
        print('| ' + ' | '.join(str(c) for c in r) + ' |')


print(f"Курс {FX} ₽/$; кредит полной работы = ${q(K_USD, 6)} API = {q(K_USD * FX, 4)} ₽ по курсу ЦБ; "
      f"удержания {pc(DEDUCT, 2)} (СБП — {pc(DEDUCT_SBP, 2)}).")
rows = []
for name, s in SCEN.items():
    c, model = cost(s)
    rows.append([name, q(model, 3), q(s['compute'], 2), q(s['searches'] * SEARCH_RUB, 3), q(c, 3)])
table('0. Затраты на списанный кредит, ₽', ['Сценарий', 'Модель на API', 'Вычисления', 'Поиск', 'Всего'], rows)

# 1. Нынешние тарифы на API, вся квота.
rows = []
for name, price, credits, sites, _ in TARIFFS:
    rows.append([name, q(price, 0), credits, q(price / credits)] +
                [pc(margin_at(price, sites, credits, cost(s)[0])) for s in SCEN.values()])
table('1. Нынешние тарифы на API, клиент выбрал всю квоту: маржа', ['Тариф', 'Цена', 'Кредитов', '₽ за кредит'] + list(SCEN), rows)

# 2. Главное: N_max при марже 10 %.
rows = []
NMAX = {}
for label, s in SCEN.items():
    c, _ = cost(s)
    cells = [label]
    for name, price, credits, sites, _ in TARIFFS:
        n = floor(n_max(price, sites, c))
        NMAX[(label, name)] = n
        cells.append(f"{n} (×{q(D(n) / credits, 2)}; {q(price / n)} ₽/кр.)")
    rows.append(cells)
table('2. Сколько кредитов можно дать при марже 10 %, вся квота на API', ['Сценарий'] + [t[0] for t in TARIFFS], rows)

# 2а. То же, если все платят по СБП.
rows = []
for label, s in SCEN.items():
    c, _ = cost(s)
    rows.append([label] + [floor(n_max(p, st, c, deduct=DEDUCT_SBP)) for _, p, _, st, _ in TARIFFS])
table('2а. То же, если все платят через СБП (удержания 4,4 %)', ['Сценарий'] + [t[0] for t in TARIFFS], rows)

# 3. Курс: где кончается маржа 10 % базового сценария.
base = SCEN['Базовый']
rows = []
for fx in [D('75'), FX, D('90'), D('95'), D('100'), D('110')]:
    c_f, _ = cost(base, fx=fx)
    cells = [f"{q(fx)} ₽/$"]
    for name, price, credits, sites, _ in TARIFFS:
        cells.append(pc(margin_at(price, sites, NMAX[('Базовый', name)], c_f)))
    rows.append(cells)
table('3. Базовые N_max при всей квоте: маржа, если курс изменится', ['Курс ЦБ'] + [t[0] for t in TARIFFS], rows)
c_b, m_b = cost(base)
# маржа = 0.10 − N × Δc / P → курс, где маржа 0: Δmodel = 0,10·P / N
for name, price, credits, sites, _ in TARIFFS:
    n = NMAX[('Базовый', name)]
    fx0 = FX * (1 + margin_at(price, sites, n, c_b) * price / n / m_b)
    print(f"- {name}: маржа 10 % обнуляется при курсе ЦБ ≈ {q(fx0)} ₽/$ (+{pc(fx0 / FX - 1)}).")

# 4. Средний клиент тратит не всю квоту.
rows = []
for util in [D('1'), D('0.75'), D('0.5')]:
    cells = [pc(util, 0)]
    for name, price, credits, sites, _ in TARIFFS:
        n = NMAX[('Базовый', name)]
        cells.append(pc(margin_at(price, sites, n * util, c_b), 0))
    rows.append(cells)
table('4. Базовые N_max: маржа клиента, который тратит долю квоты (только чувствительность: перенос остатка даёт выбрать всю квоту за два периода)',
      ['Тратит'] + [t[0] for t in TARIFFS], rows)

# 4а. Кандидаты: сколько маржи и запаса по курсу у круглых чисел.
CANDIDATES = [('Сейчас', [150, 600, 2000]), ('Максимум базы, округлено', [200, 700, 2000]),
              ('С лестницей цены кредита', [180, 650, 2000]), ('С запасом по курсу +5 %', [190, 670, 1900])]
rows = []
for label, ns in CANDIDATES:
    cells = [label]
    for (name, price, credits, sites, _), n in zip(TARIFFS, ns):
        m0 = margin_at(price, sites, n, c_b)
        fx0 = FX * (1 + (m0 - MARGIN) * price / n / m_b)   # курс, при котором маржа опускается до 10 %
        cells.append(f"{n}: {q(price / n)} ₽/кр., маржа {pc(m0)} (10 % до {q(fx0, 1)} ₽/$)")
    rows.append(cells)
table('4а. Круглые числа в базовом сценарии: цена кредита, маржа при всей квоте и курс, до которого держится 10 %',
      ['Вариант'] + [t[0] for t in TARIFFS], rows)

# 5. Что покрывают 10 %.
CAC = D('7633')
CHURN = D('0.04')
print('\n### 5. Что остаётся при марже 10 %\n')
for name, price, credits, sites, week in TARIFFS:
    left = price * MARGIN
    print(f"- {name}: {q(left, 0)} ₽ в месяц; окупаемость привлечения 7 633 ₽ — {q(CAC / left, 1)} мес; "
          f"LTV/CAC при оттоке 4 % — {q(left / CHURN / CAC, 2)}.")
cap = D('2400000') / 12
print(f"- Потолок НПД: {q(cap, 0)} ₽ выручки в месяц → не больше {q(cap * MARGIN, 0)} ₽ маржи в месяц на сервер, сервисы, привлечение и доход.")

# 6. Окна 5 ч / неделя плана 71 — только для вызовов плана.
print('\n### 6. Окна недели (план 71) — ограничивают только вызовы плана, на API их нет\n')
for name, price, credits, sites, week in TARIFFS:
    n = NMAX[('Базовый', name)]
    print(f"- {name}: окно недели {week} × 4,35 = {q(D(week) * D('4.35'), 0)} кредитов в месяц; базовый N_max {n}.")

# 7. Пакет и подарок.
print('\n### 7. Пакет и подарок\n')
for start_n in [180, 200]:
    per = D('1990') / start_n
    pack_n = floor(PACK / (per * D('1.12')))
    print(f"- «Старт» {start_n} кредитов ({q(per)} ₽/кр.): пакет за 1 490 ₽, на 12 % дороже кредита «Старта», — до {pack_n} кредитов; "
          f"маржа такого пакета в базе — {pc(margin_at(PACK, 0, pack_n, c_b))}.")
for label, s in SCEN.items():
    c, _ = cost(s)
    print(f"- {label}: подарок {GIFT} кредитов — {q(GIFT * c, 0)} ₽ на регистрацию, если тратится ровно подарок; "
          f"8 параллельных чатов, каждому — весь остаток и резерв первого вызова: 8 × (1 + {GIFT - 8} + 3,565) = 372,5 кредита — до {q(D('372.52') * c, 0)} ₽ (долг не гасится, если клиент не платит).")

# 8. План вместо API.
print('\n### 8. План (подписка) против API\n')
print("- Модель на плане при полной загрузке — 0,62–0,93 ₽ на кредит (business.md §5) против "
      f"{q(cost(base)[1], 2)} ₽ на API: маржу на плане ограничивает не цена, а мощность пула и окна.")
print("- С планами 70 и 71 работа сверх квоты плана уходит на API, поэтому безопасная граница на любом пути — числа API.")

# 9. Потолок НПД.
print('\n### 9. Потолок НПД при марже 10 % у всех клиентов\n')
fixed = {'сервер (оценка, счёта нет)': D('5000'), 'почта, домены, бухгалтер': D('10000'),
         'замена оттока 4 % у 48 клиентов по CAC 7 633': D('48') * D('0.04') * CAC}
tot = sum(fixed.values())
print(f"- 10 % от 200 000 ₽ = 20 000 ₽; постоянные расходы: " + ', '.join(f"{k} {q(v, 0)}" for k, v in fixed.items()) +
      f" = {q(tot, 0)} ₽ → {q(D('20000') - tot, 0)} ₽ в месяц, если все выбирают квоту целиком.")
