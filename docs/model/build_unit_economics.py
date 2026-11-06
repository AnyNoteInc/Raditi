#!/usr/bin/env python3
"""Файл модели юнит-экономики Радити на новой ценовой политике (план 63, 06.11.2026).

Собирает docs/model/Raditi_unit_economics.xlsx живыми формулами Excel: синие ячейки листа
«Допущения» (и синие рычаги сценариев на других листах) можно менять — остальное пересчитается.
Опорные числа берутся из расчётов отчёта «Конкуренты и новые тарифы Радити»
(docs/research/2026-11-pricing/calc.py — он загружается как модуль, его вывод не печатается);
числа, которых calc.py не печатает, считают функции этого файла (раздел «Числа, которых нет в calc.py»).

Запуск из корня репозитория:
  uv run --with openpyxl python -I docs/model/build_unit_economics.py          # собрать xlsx и напечатать опорные числа
  uv run --with openpyxl python -I docs/model/build_unit_economics.py --print  # только опорные числа
  uv run --with openpyxl python -I docs/model/build_unit_economics.py --check <пересчитанный.xlsx>
      # сверить значения формул (после пересчёта LibreOffice или Excel) с calc.py

openpyxl пишет формулы без вычисленных значений: Excel и LibreOffice считают их при открытии
(в файле стоит «пересчитать при загрузке»). Для --check файл сначала пересчитывают LibreOffice
(например, scripts/recalc.py навыка xlsx), затем передают сюда.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import sys
from decimal import Decimal as D, ROUND_FLOOR, ROUND_HALF_UP
from pathlib import Path

HERE = Path(__file__).resolve().parent
CALC_PATH = HERE.parent / 'research' / '2026-11-pricing' / 'calc.py'
OUT_PATH = HERE / 'Raditi_unit_economics.xlsx'


def load_calc():
    """calc.py печатает таблицы при загрузке; здесь нужен только его код и константы."""
    spec = importlib.util.spec_from_file_location('raditi_pricing_calc', CALC_PATH)
    mod = importlib.util.module_from_spec(spec)
    with contextlib.redirect_stdout(io.StringIO()):
        spec.loader.exec_module(mod)
    return mod


C = load_calc()


# ----------------------------------------------------------------------------------------------
# Числа, которых нет в calc.py (их называет docs/business.md)
# ----------------------------------------------------------------------------------------------

# Рынок (business.md §3): домены .RU с определённой CMS — 23,2 % из 5,47 млн (iTrack, январь 2024),
# доля WordPress — 42,9 %, доля бизнеса — 50 % (допущение), SOM — 1 % SAM за три года.
RU_DOMAINS = D('5470000')
CMS_DETECTED = D('0.232')
WORDPRESS_SHARE = D('0.429')
BUSINESS_SHARE = D('0.5')
SOM_SHARE = D('0.01')
DEV_WEEKS = D('14')            # PoC 6 недель + MVP 8 недель (business.md §1)
WEEKS_IN_MONTH = D('4.345')    # как в прежнем файле модели
MONTHS_IN_MINUS = 3            # выход в ноль на 4-м месяце продаж (прежний план business.md §7)
OLD_PACE = D('124')            # новых клиентов в месяц в прежнем плане business.md §7


def som_new_prices():
    """SOM business.md §3 по новому среднему чеку: сайтов и рублей в год."""
    arpu, _, _ = C.avg_client(C.VAR_R, C.YK_NPD, C.NPD_TAX)
    sites = RU_DOMAINS * CMS_DETECTED * WORDPRESS_SHARE * BUSINESS_SHARE * SOM_SHARE
    return sites, sites * arpu * 12, arpu


def model_per_client_api(tariffs=None):
    """Модель на API на среднего клиента в месяц: кредитов в месяц × модель на кредит (база)."""
    _, _, used = C.avg_client(tariffs or C.VAR_R, C.YK_NPD, C.NPD_TAX)
    return used, used * C.BASE_TYPICAL, used * (C.BASE_TYPICAL + C.COMPUTE_PER_CREDIT)


def ooo_plan(tariffs, months_in_minus=MONTHS_IN_MINUS, cac=None, churn=D('0.04')):
    """ООО или ИП на УСН с командой: сколько приводить в месяц, чтобы выйти в ноль на месяце
    months_in_minus + 1, и сколько денег на это нужно (та же модель, что прежний лист «Сценарии»)."""
    cac = C.CAC_BASE if cac is None else cac
    arpu, contrib, used = C.avg_client(tariffs, C.YK_LEGAL, C.USN)
    fixed = C.FIXED_TEAM
    m = months_in_minus
    k = (1 - (1 - churn) ** (m + 1)) / churn
    per_month = fixed / (k * contrib - cac)
    months_sum = per_month / churn * (m - (1 - churn) * (1 - (1 - churn) ** m) / churn)
    minus = contrib * months_sum - m * fixed - m * per_month * cac
    dev = DEV_WEEKS / WEEKS_IN_MONTH * fixed
    return dict(arpu=arpu, contrib=contrib, used=used, k=k, per_month=per_month,
                clients=per_month * k, minus=minus, ads=per_month * cac, dev=dev, need=dev - minus)


def ooo_months(tariffs, per_month, months=12, cac=None, churn=D('0.04')):
    """План по месяцам при постоянном числе новых клиентов: активные, результат, накоплено."""
    cac = C.CAC_BASE if cac is None else cac
    arpu, contrib, _ = C.avg_client(tariffs, C.YK_LEGAL, C.USN)
    active = D(0)
    total = D(0)
    rows = []
    for month in range(1, months + 1):
        active = active * (1 - churn) + per_month
        result = active * contrib - C.FIXED_TEAM - per_month * cac
        total += result
        rows.append((month, active, result, total))
    return rows


def first_profitable_month(rows):
    for month, _, result, _ in rows:
        if result >= 0:
            return month
    return None


def npd_cap(tariffs):
    """Потолок НПД: платящих, вклад, владельцу на API и на плане Pro (как calc.py, раздел 4.6)."""
    arpu, contrib, used = C.avg_client(tariffs, C.YK_NPD, C.NPD_TAX)
    clients = (C.NPD_CAP_YEAR / 12 / arpu).to_integral_value(rounding=ROUND_FLOOR)
    total = clients * contrib
    churn_cac = clients * D('0.04') * C.CAC_BASE
    owner_api = total - churn_cac - C.INFRA_BASE - C.NPD_SERVICES
    model_api = clients * used * C.BASE_TYPICAL
    owner_plan = owner_api + model_api - C.PLAN['Pro'][0] * C.FX
    return dict(arpu=arpu, contrib=contrib, clients=clients, credits=clients * used, total=total,
                churn_cac=churn_cac, owner_api=owner_api, model_api=model_api, owner_plan=owner_plan)


def q(x, places=0):
    if x is None:
        return '—'
    return f"{D(x).quantize(D(1).scaleb(-places), rounding=ROUND_HALF_UP):,}".replace(',', ' ')


def print_reference():
    print('# Опорные числа файла модели (calc.py + функции build_unit_economics.py)\n')
    for label, tariffs in [('Новая сетка', C.VAR_R), ('Прежняя сетка', C.CURRENT)]:
        rows = C.tariff_rows(tariffs, C.YK_NPD, C.NPD_TAX, extra_full=C.COST['limit'])
        print(f'## {label}: вклад обычно / вся квота / предел 100 % / предел 50 %, ₽ (маржа)')
        for r in rows:
            print(f"- {r['name']}: {q(r['contrib_t'])} ({q(r['contrib_t'] / r['price'] * 100, 1)} %) / "
                  f"{q(r['contrib_f'])} ({q(r['contrib_f'] / r['price'] * 100, 1)} %) / "
                  f"{q(r['contrib_x'])} ({q(r['contrib_x'] / r['price'] * 100, 1)} %) / "
                  f"{q(r['contrib_y'])} ({q(r['contrib_y'] / r['price'] * 100, 1)} %)")
        arpu, contrib, used = C.avg_client(tariffs, C.YK_NPD, C.NPD_TAX)
        print(f"- средний клиент: чек {q(arpu)}, кредитов {q(used, 1)}, вклад {q(contrib)} ({q(contrib / arpu * 100, 1)} %)")
        cap = npd_cap(tariffs)
        print(f"- НПД: {cap['clients']} платящих, владельцу {q(cap['owner_api'])} на API / {q(cap['owner_plan'])} на плане Pro")
        plan = ooo_plan(tariffs)
        print(f"- ООО: вклад {q(plan['contrib'])}, безубыточность {q(C.FIXED_TEAM / plan['contrib'])}, "
              f"с оттоком {q(C.FIXED_TEAM / (plan['contrib'] - D('0.04') * C.CAC_BASE))}")
        print(f"- ООО, выход в ноль на {MONTHS_IN_MINUS + 1}-м месяце: k = {q(plan['k'], 3)}, приводить "
              f"{q(plan['per_month'], 1)} в месяц, клиентов к {MONTHS_IN_MINUS + 1}-му месяцу {q(plan['clients'])}, "
              f"реклама {q(plan['ads'])} ₽ в месяц, минус за {MONTHS_IN_MINUS} мес {q(plan['minus'])} ₽, "
              f"разработка {q(plan['dev'])} ₽, всего нужно {q(plan['need'])} ₽")
        months = ooo_months(tariffs, plan['per_month'])
        print('  по месяцам (активных, результат, накоплено, тыс. ₽): ' + '; '.join(
            f"{m}: {q(a)}, {q(r / 1000)}, {q(t / 1000)}" for m, a, r, t in months))
        pace = ooo_months(tariffs, OLD_PACE)
        worst = min(t for _, _, _, t in pace)
        print(f"- ООО при {OLD_PACE} новых в месяц: первый месяц в плюсе — {first_profitable_month(pace)}, "
              f"наибольший накопленный минус {q(worst)} ₽, к 12-му месяцу {q(pace[-1][1])} клиентов и "
              f"{q(pace[-1][3])} ₽ накоплено")
        print()
    sites, rub, arpu = som_new_prices()
    print(f'## Рынок: SOM ≈ {q(sites)} сайтов × {q(arpu)} ₽ × 12 = {q(rub / 1000000, 1)} млн ₽ в год')
    used, model, with_compute = model_per_client_api()
    print(f'## Средний клиент новой сетки: {q(used, 1)} кредита в месяц, модель на API {q(model)} ₽, '
          f'с вычислениями {q(with_compute)} ₽')
    for tier, (usd, w5, week) in C.PLAN.items():
        cap = week * C.WEEKS_PER_MONTH / C.DEV_PLAN_PER_CREDIT
        print(f'- {tier}: держит {q(cap / used, 0)} средних клиентов в пик, {q(cap / used / C.OFF_PEAK, 0)} вне пика')
    max_cap = C.PLAN['Max'][2] * C.WEEKS_PER_MONTH / C.DEV_PLAN_PER_CREDIT
    print('## Масштаб (лист «Железо»): модель на API в месяц и аккаунтов Max при работе в пик')
    for n in (100, 300, 1000, 3000):
        print(f'- {n} клиентов: {q(n * model, 0)} ₽, аккаунтов Max {q(n * used / max_cap, 1)}')
    print(f"\nДопущения calc.py, которые файл модели считает из входов: база 5 ВМ {C.INFRA_BASE} ₽ "
          f"(по ВМ — 55 376,91 ₽, файл модели считает по ВМ); CAC {C.CAC_BASE} ₽ = 7 000 + онбординг 30 мин × 21,0884 ₽, до рубля — 633 ₽.")


# ----------------------------------------------------------------------------------------------
# Книга Excel
# ----------------------------------------------------------------------------------------------

def build_workbook(path: Path):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.properties import PageSetupProperties  # noqa: F401  (Excel-friendly import)

    FONT = 'Arial'
    BLUE, BLACK, GREEN, GREY, NAVY, WHITE = '0000FF', '000000', '008000', '595959', '1F3864', 'FFFFFF'
    F_INT = '#,##0;\\(#,##0\\);\\-'
    F_D1 = '#,##0.0;\\(#,##0.0\\);\\-'
    F_D2 = '#,##0.00;\\(#,##0.00\\);\\-'
    F_D3 = '#,##0.000;\\(#,##0.000\\);\\-'
    F_D4 = '0.0000'
    F_D5 = '0.00000'
    F_PCT = '0.0%;\\(0.0%\\);\\-'
    F_PCT2 = '0.00%;\\(0.00%\\);\\-'
    F_X = '0.00"×"'
    FILL_SECTION = PatternFill('solid', fgColor='DDE4F0')
    FILL_HEAD = PatternFill('solid', fgColor=NAVY)
    FILL_KEY = PatternFill('solid', fgColor='FFFF00')

    def font(color=BLACK, bold=False, italic=False, size=10):
        return Font(name=FONT, color=color, bold=bold, italic=italic, size=size)

    wb = Workbook()
    wb.remove(wb.active)
    sheets = {}
    for name in ['Допущения', 'Тарифы', 'Себестоимость', 'НПД', 'ООО', 'Чувствительность', 'Конкуренты', 'Железо']:
        sheets[name] = wb.create_sheet(name)

    R = {}        # ключ -> адрес «'Лист'!$B$5»
    CHECKS = []   # (лист, ячейка, ожидаемое, допуск, что это)

    def addr(sheet, col, row):
        return f"'{sheet}'!${get_column_letter(col)}${row}"

    def put(ws, row, col, value, fmt=None, color=None, bold=False, fill=None, wrap=False, italic=False):
        cell = ws.cell(row=row, column=col, value=value)
        if color is None:
            if isinstance(value, str) and value.startswith('='):
                color = GREEN if "'!" in value and _only_link(value) else BLACK
            elif isinstance(value, (int, float, D)):
                color = BLUE
            else:
                color = BLACK
        cell.font = font(color, bold=bold, italic=italic)
        if fmt:
            cell.number_format = fmt
        if fill:
            cell.fill = fill
        if wrap:
            cell.alignment = Alignment(wrap_text=True, vertical='top')
        return cell

    def title(ws, text, note=None):
        put(ws, 1, 1, text, bold=True).font = font(BLACK, bold=True, size=12)
        if note:
            put(ws, 2, 1, note, color=GREY)

    def section(ws, row, text, width=6):
        for col in range(1, width + 1):
            ws.cell(row=row, column=col).fill = FILL_SECTION
        put(ws, row, 1, text, color=NAVY, bold=True, fill=FILL_SECTION)

    def header(ws, row, labels, start=1):
        for i, label in enumerate(labels):
            c = put(ws, row, start + i, label, color=WHITE, bold=True, fill=FILL_HEAD, wrap=True)
            c.alignment = Alignment(wrap_text=True, vertical='center')

    def note(ws, row, text, col=1):
        put(ws, row, col, text, color=GREY)

    def check(ws, row, col, expected, tol, what):
        CHECKS.append((ws.title, f'{get_column_letter(col)}{row}', D(expected), D(tol), what))

    # ------------------------------------------------------------------------------------------
    # Допущения
    # ------------------------------------------------------------------------------------------
    ws = sheets['Допущения']
    S = 'Допущения'
    title(ws, 'Радити — допущения юнит-экономики (новая ценовая политика, 06.11.2026)',
          'Синие значения — входные данные, их можно менять; жёлтая заливка — ключевые допущения; чёрные — формулы; '
          'зелёные — ссылки на другие листы. Источник чисел — отчёт docs/research/2026-11-pricing и calc.py; '
          'файл собирает docs/model/build_unit_economics.py.')
    ws.column_dimensions['A'].width = 62
    ws.column_dimensions['B'].width = 14
    ws.column_dimensions['C'].width = 14
    for col in 'DEFGHIJ':
        ws.column_dimensions[col].width = 14
    ws.column_dimensions['K'].width = 70

    row = 4

    def inp(key, label, value, unit='', src='', fmt=F_D2, key_flag=False):
        nonlocal row
        put(ws, row, 1, label)
        put(ws, row, 2, value, fmt=fmt, fill=FILL_KEY if key_flag else None)
        put(ws, row, 3, unit)
        put(ws, row, 4, src, color=GREY)
        R[key] = addr(S, 2, row)
        row += 1

    def blank(n=1):
        nonlocal row
        row += n

    section(ws, row, 'Курс и учётные ставки'); row += 1
    inp('fx', 'Курс ЦБ РФ на 06.11.2026', float(C.FX), '₽/$', 'ЦБ РФ: https://www.cbr.ru/scripts/XML_daily.asp?date_req=06/11/2026', F_D4, True)
    inp('fx_rates', 'Курс файла учётных ставок (17.10.2026)', float(C.FX_RATES_FILE), '₽/$', 'infra/billing/rates/2026-10-17-zai-api.json; ЦБ РФ на 17.10.2026', F_D4)
    inp('markup', 'Маржа в учётных ставках к цене Z.ai', float(C.RATES_MARKUP), '×', 'Учётная ставка = цена Z.ai × курс 17.10 × 1,30 (spec §17, П85)', '0.00')
    inp('k', 'Курс кредита K: учётных ₽ работы в одном кредите', float(C.K), '₽', 'Решение владельца 17.10.2026 (П85); не меняется (Ц13)', F_D2, True)
    blank()

    section(ws, row, 'API Z.ai, $ за 1 млн токенов: ввод / кэш / вывод'); row += 1
    header(ws, row, ['Модель', 'Ввод', 'Кэш', 'Вывод', 'Статус'], 1); row += 1
    for key, name, prices, status in [
        ('glm', 'GLM-5.3', C.API, 'подтверждено, docs.z.ai/guides/overview/pricing'),
        ('flashx', 'GLM-5.3-FlashX', C.API_FLASHX, 'подтверждено, там же'),
        ('flash', 'GLM-5.3-Flash', C.API_FLASH, 'подтверждено, там же'),
    ]:
        put(ws, row, 1, name)
        for i, part in enumerate(['in', 'cache', 'out']):
            put(ws, row, 2 + i, float(prices[part]), fmt='0.000')
            R[f'api_{key}_{part}'] = addr(S, 2 + i, row)
        put(ws, row, 5, status, color=GREY)
        row += 1
    note(ws, row, 'Хранение кэша «временно бесплатно»; пакетного API и скидок за объём нет (zai_pricing.md §2).'); row += 2

    section(ws, row, 'План GLM Coding Plan'); row += 1
    header(ws, row, ['Уровень', '$ в месяц', 'Квота 5 ч, кредитов плана', 'Квота в неделю', 'Статус цены'], 1); row += 1
    plan_status = {'Lite': 'подтверждено «от 18 USD» (docs.z.ai/devpack/overview)',
                   'Pro': 'скрипт страницы покупки и сторонние снимки (не подтв.)',
                   'Max': 'скрипт страницы покупки и сторонние снимки (не подтв.)'}
    PLAN_ROWS = {}
    for tier, (usd, w5, week) in C.PLAN.items():
        put(ws, row, 1, tier)
        put(ws, row, 2, float(usd), fmt=F_D2)
        put(ws, row, 3, float(w5), fmt=F_INT)
        put(ws, row, 4, float(week), fmt=F_INT)
        put(ws, row, 5, plan_status[tier], color=GREY)
        R[f'plan_{tier}_usd'] = addr(S, 2, row)
        R[f'plan_{tier}_w5'] = addr(S, 3, row)
        R[f'plan_{tier}_week'] = addr(S, 4, row)
        PLAN_ROWS[tier] = row
        row += 1
    inp('plan_m_in', 'Кредитов плана на 10 000 токенов ввода без кэша', float(C.PLAN_MULT['in']), '', 'Формула Z.ai: (ввод × 6,9 + кэш × 1,7 + вывод × 24) / 10 000 (devpack/overview)', '0.0')
    inp('plan_m_cache', 'Кредитов плана на 10 000 токенов кэша', float(C.PLAN_MULT['cache']), '', 'Там же', '0.0')
    inp('plan_m_out', 'Кредитов плана на 10 000 токенов вывода', float(C.PLAN_MULT['out']), '', 'Там же', '0.0')
    inp('off_peak', 'Доля списания вне пика', float(C.OFF_PEAK), '', 'Пик — пн–пт 14:00–18:00 по Сингапуру = 09:00–13:00 по Москве; в выходные весь день вне пика', F_PCT)
    inp('year_disc', 'Скидка плана за год', float(C.YEAR_DISCOUNT), '', 'Скрипт страницы покупки (не подтв.); квартал −20 %', F_PCT)
    inp('weeks_month', 'Недель в месяце', float(C.WEEKS_PER_MONTH), '', '30,44 / 7, как в zai_pricing.md §6', '0.00')
    blank()

    section(ws, row, 'Задачи business.md (гипотеза до eval P15)'); row += 1
    header(ws, row, ['Тип задачи', 'Токенов ввода', 'Токенов вывода', 'Доля в смеси', 'Минут песочницы (для «Железа»)'], 1); row += 1
    TASK_KEYS = [('content', 'Контент', '3'), ('code', 'Код', '10'), ('complex', 'Сложная', '20')]
    for key, name, minutes in TASK_KEYS:
        inp_, out_, share = C.TASKS[name]
        put(ws, row, 1, name)
        put(ws, row, 2, float(inp_), fmt=F_INT, fill=FILL_KEY)
        put(ws, row, 3, float(out_), fmt=F_INT)
        if key == 'complex':
            put(ws, row, 4, f"=1-{addr(S, 4, row - 2)}-{addr(S, 4, row - 1)}", fmt=F_PCT)
        else:
            put(ws, row, 4, float(share), fmt=F_PCT, fill=FILL_KEY)
        put(ws, row, 5, float(minutes), fmt=F_D1)
        R[f'task_{key}_in'] = addr(S, 2, row)
        R[f'task_{key}_out'] = addr(S, 3, row)
        R[f'task_{key}_share'] = addr(S, 4, row)
        R[f'task_{key}_min'] = addr(S, 5, row)
        row += 1
    inp('cache_typ', 'Доля кэша во вводе — обычная работа', 0.80, '', 'База «обычного использования» отчёта (раздел 4); в dev — 95,3 %', F_PCT, True)
    inp('unpaid_docs', 'Неоплаченная работа к оплаченной — обычная работа', float(C.UNPAID_DOCS), '', 'Сбои, отмены, брошенные чаты: допущение документов; в dev — 58,8 %', F_PCT, True)
    inp('cpa', 'Кредитов на действие клиента', float(C.CREDITS_PER_ACTION), 'кредитов', 'dev: 166 кредитов на 24 задачи (6,92); прогон 27.10.2026 — «5 + 2 за проходы» (spec §20)', F_D1, True)
    inp('min_charge', 'Минимум за первое списание чата', 5, 'кредитов', 'Ц12: первое списание — 5, следующие проходы — не меньше 1', F_INT)
    inp('small_edit', 'Небольшая правка', 5, 'кредитов', 'Ц14: «небольшая правка — 66 ₽» на «Тарифах» и лендинге', F_INT)
    inp('synt_in', 'Синтетический запрос прежней оценки business.md: ввод', 4200, 'токенов', 'Отчёты 45, 46, 48: около 4,2 тыс. ввода и 100–200 вывода, кэш 92,2 %', F_INT)
    inp('synt_out', 'Синтетический запрос: вывод', 150, 'токенов', '', F_INT)
    inp('synt_cache', 'Синтетический запрос: доля кэша', 0.922, '', '', F_PCT)
    blank()

    section(ws, row, 'Замер dev-базы 25.10–06.11.2026 (тестовые чаты, класс synthetic; выборка мала и набрана при отладке)'); row += 1
    header(ws, row, ['Бэкенд', 'Вызовов', 'Ввод без кэша', 'Кэш', 'Вывод', 'Учётные ₽'], 1); row += 1
    first_dev = row
    for backend, (calls, inp_, cache, out_, acc) in C.DEV_CALLS.items():
        put(ws, row, 1, backend)
        for i, v in enumerate([calls, inp_, cache, out_]):
            put(ws, row, 2 + i, float(v), fmt=F_INT)
        put(ws, row, 6, float(acc), fmt=F_D2)
        row += 1
    for i, key in enumerate(['calls', 'in', 'cache', 'out', 'acc']):
        R[f'dev_{key}'] = f"SUM('{S}'!${get_column_letter(2 + i)}${first_dev}:${get_column_letter(2 + i)}${row - 1})"
    inp('dev_charged_acc', 'Учётные ₽ задач, у которых было списание', float(C.DEV_CHARGED_ACC), '₽', 'internal_costs.md §6 (выборки SELECT)', F_D2)
    inp('dev_charged_credits', 'Списано кредитов (credit_ledger)', float(C.DEV_CHARGED_CREDITS), 'кредитов', 'Там же', F_INT)
    inp('dev_charged_tasks', 'Задач со списанием', float(C.DEV_CHARGED_TASKS), 'задач', 'Там же: 12 + 4 + 6 + 2', F_INT)
    blank()
    header(ws, row, ['Ход по виду чата (dev)', 'Ходов', 'Ввод в среднем', 'Доля кэша', 'Вывод', 'Учётные ₽: среднее',
                     'Медиана', 'p90', 'Максимум', 'Минут в среднем'], 1); row += 1
    TURN_ROWS = {}
    for name, key in [('Код (repo)', 'code'), ('Браузер на сайте', 'browser'), ('Чат без проекта', 'noproj')]:
        n, inp_, cache, out_, avg, med, p90, mx, mins = C.DEV_TURNS[name]
        label = {'code': 'Чат с кодом', 'browser': 'Браузер на сайте проекта', 'noproj': 'Чат без проекта'}[key]
        put(ws, row, 1, label)
        for i, (v, fmt) in enumerate([(n, F_INT), (inp_, F_INT), (cache, F_PCT), (out_, F_INT), (avg, F_D2),
                                      (med, F_D2), (p90, F_D2), (mx, F_D2), (mins, F_D1)]):
            put(ws, row, 2 + i, float(v), fmt=fmt)
        TURN_ROWS[key] = row
        row += 1
    blank()
    header(ws, row, ['Проход (цепочка) в кредитах работы', 'Медиана', 'p90', 'Максимум'], 1); row += 1
    CHAIN_ROWS = {}
    for name, key, label in [('Код (repo)', 'code', 'Чат с кодом'), ('Браузер на сайте', 'browser', 'Браузер на сайте проекта')]:
        med, p90, mx = C.DEV_CHAINS[name]
        put(ws, row, 1, label)
        for i, v in enumerate([med, p90, mx]):
            put(ws, row, 2 + i, float(v), fmt=F_D2)
        CHAIN_ROWS[key] = row
        row += 1
    blank()

    section(ws, row, 'Вычисления (цены Cloud.ru из прежнего файла модели)'); row += 1
    inp('vcpu', 'vCPU, ₽ в час с НДС', float(C.VCPU_H), '₽/ч', 'Cloud.ru Evolution Compute: ВМ 12 vCPU/24 ГБ = 23,7534 ₽/ч и 16 vCPU/128 ГБ = 48,17 ₽/ч', F_D4)
    inp('ram', 'RAM, ₽ за ГБ в час с НДС', float(C.RAM_GB_H), '₽/ГБ·ч', 'Там же', F_D4)
    inp('load', 'Загрузка зарезервированных мощностей', float(C.LOAD), '', 'Оценка business.md', F_PCT)
    inp('sb_cpu', 'Песочница хода: vCPU', float(C.SANDBOX[0]), 'vCPU', 'spec §8', F_D1)
    inp('sb_ram', 'Песочница хода: RAM', float(C.SANDBOX[1]), 'ГБ', 'spec §8', F_D1)
    inp('turn_min', 'Ход: минут в среднем (dev, взвешено по ходам)', float(C.TURN_MIN), 'мин', 'internal_costs.md §6', F_D2)
    inp('passes', 'Проходов на действие', float(C.PASSES_PER_ACTION), '', '«5 + 2 кредита за проходы» (прогон 27.10.2026)', F_D1)
    inp('pv_cpu', 'Предпросмотр: vCPU', float(C.PREVIEW[0]), 'vCPU', 'План 58, один контейнер', F_D1)
    inp('pv_ram', 'Предпросмотр: RAM', float(C.PREVIEW[1]), 'ГБ', '', F_D1)
    inp('pv_min', 'Предпросмотр: минут на действие', float(C.PREVIEW_MIN_PER_ACTION), 'мин', '10 мин просмотра + 30 мин простоя до остановки', F_D1)
    inp('pv_share', 'Доля действий с предпросмотром', float(C.PREVIEW_SHARE), '', 'Допущение', F_PCT)
    inp('br_cpu', 'Облачный браузер: vCPU', float(C.BROWSER[0]), 'vCPU', '', F_D1)
    inp('br_ram', 'Облачный браузер: RAM', float(C.BROWSER[1]), 'ГБ', '', F_D1)
    inp('br_min', 'Облачный браузер: минут сессии', float(C.BROWSER_MIN), 'мин', 'dev, средняя сессия', F_D1)
    inp('br_share', 'Доля действий с браузером', float(C.BROWSER_SHARE), '', 'Допущение', F_PCT)
    inp('backup_gb', 'Бэкапы в S3 на один сайт', 4, 'ГБ', 'Оценка business.md', F_D1)
    inp('s3', 'S3, ₽ за ГБ в месяц', 2, '₽/ГБ', 'Timeweb Cloud: 2 ₽/ГБ сверх 250 ГБ', F_D2)
    blank()

    section(ws, row, 'Удержания с выручки'); row += 1
    inp('yk_npd', 'ЮKassa для самозанятой, без НДС', 0.035, '', 'https://yookassa.ru/platezhi-dlya-samozanyatyh/', F_PCT2)
    inp('vat_fee', 'НДС с комиссии эквайринга с 2026 года', 0.22, '', 'ppt.ru, Т—Ж: льгота по НДС на операции с картами отменена', F_PCT)
    inp('npd_tax', 'НПД с физлиц', float(C.NPD_TAX), '', 'https://npd.nalog.ru/', F_PCT)
    inp('npd_cap', 'Потолок дохода самозанятой в год', float(C.NPD_CAP_YEAR), '₽', 'КонсультантПлюс; законопроект о 4,3 млн ₽ не поддержан (ppt.ru)', F_INT, True)
    inp('yk_legal', 'ЮKassa для ООО или ИП, без НДС', 0.028, '', 'https://yookassa.ru/fees/', F_PCT2)
    inp('yk_receipt', '«Чеки от ЮKassa» для ООО или ИП, без НДС', 0.01, '', 'Там же', F_PCT2)
    inp('usn', 'УСН «доходы» (допущение; проверить с бухгалтером)', float(C.USN), '', 'Ставку и НДС при УСН проверить с бухгалтером', F_PCT)
    blank()

    section(ws, row, 'Оператор (эскалации и онбординг)'); row += 1
    inp('op_salary', 'Зарплата оператора', 120000, '₽/мес', 'Оценка business.md', F_INT)
    inp('tax_coef', 'Коэффициент НДФЛ и взносов', 1.24, '×', 'Оценка business.md', '0.00')
    inp('op_days', 'Рабочих дней в месяце', 21, 'дней', '', F_INT)
    inp('op_hours', 'Часов в день', 8, 'ч', '', F_INT)
    inp('op_prod', 'Доля продуктивного времени', 0.7, '', 'Оценка', F_PCT)
    inp('esc_share', 'Доля задач с эскалацией оператору (только ООО)', 0.05, '', 'Гипотеза до пилота; у самозанятой — её время, не деньги', F_PCT)
    inp('esc_min', 'Минут оператора на эскалацию', 15, 'мин', 'Оценка', F_INT)
    inp('onb_min', 'Минут оператора на онбординг клиента', 30, 'мин', 'Оценка', F_INT)
    blank()

    section(ws, row, 'Привлечение и отток (гипотезы до пилота)'); row += 1
    inp('ad_base', 'Реклама на платящего клиента, базовый сценарий', 7000, '₽', 'Клик в Директе 80–150 ₽ (vc.ru), лендинг → регистрация 5 %, регистрация → оплата 30 %', F_INT, True)
    inp('ad_low', 'Реклама на платящего, дешёвый сценарий (партнёрства)', 4000, '₽', 'calc.py: CAC 4 633 ₽', F_INT)
    inp('click', 'Клик в Яндекс Директе', 100, '₽', 'vc.ru, CPC 80–150 ₽ (09.06.2026)', F_INT)
    inp('conv_land', 'Конверсия лендинга в регистрацию', 0.05, '', 'Гипотеза business.md', F_PCT)
    inp('conv_pay', 'Конверсия регистрации в оплату — базовый сценарий', 0.30, '', 'Гипотеза business.md (это конверсия пробного периода с картой)', F_PCT)
    inp('conv_gift', 'Конверсия подарка без карты в оплату', 0.15, '', 'Userpilot: медианы opt-in 8–18 %', F_PCT, True)
    inp('churn', 'Отток в месяц', 0.04, '', 'Середина 3–7 % для SMB SaaS (UserJot)', F_PCT, True)
    inp('months_minus', 'Месяцев в минусе до выхода в ноль (план ООО)', MONTHS_IN_MINUS, 'мес', 'Как в прежнем плане: выход в ноль на 4-м месяце продаж', F_INT)
    inp('dev_weeks', 'Недель разработки до запуска продаж', float(DEV_WEEKS), 'нед', 'PoC 6 + MVP 8 недель (оценка)', F_INT)
    blank()

    section(ws, row, 'Постоянные расходы, ₽ в месяц'); row += 1
    inp('sal_lead', 'Техлид, бэкенд — зарплата', 251000, '₽/мес', 'Медиана бэкенда, Хабр Карьера, I пол. 2026', F_INT)
    inp('sal_full', 'Фулстек — зарплата', 208000, '₽/мес', 'Медиана фулстека, там же', F_INT)
    put(ws, row, 1, 'DevOps, 0,5 ставки'); put(ws, row, 2, f"=0.5*{R['sal_lead']}", fmt=F_INT); put(ws, row, 3, '₽/мес'); note(ws, row, 'Половина медианы бэкенда', 4)
    R['sal_devops'] = addr(S, 2, row); row += 1
    put(ws, row, 1, 'Оператор WordPress'); put(ws, row, 2, f"={R['op_salary']}", fmt=F_INT); put(ws, row, 3, '₽/мес')
    R['sal_op'] = addr(S, 2, row); row += 1
    inp('sal_mkt', 'Маркетинг и продажи — зарплата', 150000, '₽/мес', 'Оценка', F_INT)
    put(ws, row, 1, 'Команда с налогами и взносами (4,5 ставки; только ООО или ИП)')
    put(ws, row, 2, f"=({R['sal_lead']}+{R['sal_full']}+{R['sal_devops']}+{R['sal_op']}+{R['sal_mkt']})*{R['tax_coef']}", fmt=F_INT)
    put(ws, row, 3, '₽/мес'); note(ws, row, 'Основатель без зарплаты до безубыточности', 4)
    R['team'] = addr(S, 2, row); row += 1
    inp('vm_cpu', 'Базовые ВМ: vCPU (app 8, sandbox 16, gitea 4, ci 4, vault 2)', 34, 'vCPU', 'spec §19', F_INT)
    inp('vm_ram', 'Базовые ВМ: RAM (16 + 32 + 8 + 8 + 4)', 68, 'ГБ', 'spec §19 (песочной ВМ там 16/64 — не пересчитано)', F_INT)
    inp('ssd', 'Сетевые SSD-диски', 600, 'ГБ', 'Оценка', F_INT)
    inp('ssd_price', 'SSD, ₽ за ГБ в месяц', 8.99, '₽/ГБ', 'Selectel, от 8,99 ₽/ГБ', F_D2)
    inp('ips', 'Публичных IP', 3, 'шт', '', F_INT)
    inp('ip_price', 'Публичный IP, ₽ в час', 0.2074, '₽/ч', 'Cloud.ru Evolution Compute', F_D4)
    inp('s3_platform', 'S3 для бэкапов платформы', 200, 'ГБ', 'Оценка', F_INT)
    put(ws, row, 1, 'Инфраструктура, база (5 ВМ)')
    put(ws, row, 2, f"=({R['vm_cpu']}*{R['vcpu']}+{R['vm_ram']}*{R['ram']})*730+{R['ssd']}*{R['ssd_price']}+{R['ips']}*{R['ip_price']}*730+{R['s3_platform']}*{R['s3']}", fmt=F_INT)
    put(ws, row, 3, '₽/мес'); note(ws, row, '730 часов в месяце; calc.py и business.md берут 55 378 ₽ — расхождение 1 ₽', 4)
    R['infra'] = addr(S, 2, row); check(ws, row, 2, C.INFRA_BASE, 2, 'база 5 ВМ'); row += 1
    inp('services_ooo', 'Бухгалтерия, юрист, сервисы — ООО или ИП', 60000, '₽/мес', 'Оценка business.md', F_INT)
    inp('services_npd', 'Почта, домены, бухгалтер — самозанятая', float(C.NPD_SERVICES), '₽/мес', 'Допущение отчёта', F_INT)
    put(ws, row, 1, 'Постоянные расходы ООО или ИП с командой', bold=True)
    put(ws, row, 2, f"={R['team']}+{R['infra']}+{R['services_ooo']}", fmt=F_INT, bold=True)
    put(ws, row, 3, '₽/мес'); R['fixed'] = addr(S, 2, row); check(ws, row, 2, C.FIXED_TEAM, 2, 'постоянные расходы ООО'); row += 2

    section(ws, row, 'Тарифы (решения владельца 06.11.2026, план 63: Ц1–Ц9)', 7); row += 1
    header(ws, row, ['Тариф', 'Цена, ₽ в месяц', 'Кредитов в месяц', 'Сайтов', 'Действий в месяц обычно', 'Доля клиентов',
                     'Сайтов в работе (для «Железа»)'], 1); row += 1
    TAR = {'new': [], 'old': []}
    sites_work = {'Старт': 1, 'Бизнес': 1.5, 'Агентство': 8}
    put(ws, row, 1, 'Новая сетка', bold=True); row += 1
    for i, (name, price, credits, sites, actions) in enumerate(C.VAR_R):
        put(ws, row, 1, name)
        put(ws, row, 2, float(price), fmt=F_INT, fill=FILL_KEY)
        put(ws, row, 3, float(credits), fmt=F_INT, fill=FILL_KEY)
        put(ws, row, 4, sites, fmt=F_INT)
        put(ws, row, 5, float(actions), fmt=F_D1, fill=FILL_KEY)
        put(ws, row, 6, float(C.MIX[i]), fmt=F_PCT, fill=FILL_KEY)
        put(ws, row, 7, sites_work[name], fmt=F_D1)
        TAR['new'].append(row)
        row += 1
    put(ws, row, 1, 'Прежняя сетка (до 06.11.2026)', bold=True); row += 1
    for i, (name, price, credits, sites, actions) in enumerate(C.CURRENT):
        put(ws, row, 1, name)
        put(ws, row, 2, float(price), fmt=F_INT)
        put(ws, row, 3, float(credits), fmt=F_INT)
        put(ws, row, 4, sites, fmt=F_INT)
        put(ws, row, 5, f"={addr(S, 5, TAR['new'][i])}", fmt=F_D1)
        put(ws, row, 6, f"={addr(S, 6, TAR['new'][i])}", fmt=F_PCT)
        put(ws, row, 7, f"={addr(S, 7, TAR['new'][i])}", fmt=F_D1)
        TAR['old'].append(row)
        row += 1
    note(ws, row, 'Действий в месяц обычно — 12 / 40 / 150 по 7 кредитов (credits-design §2.4); смесь тарифов 70/25/5 % — business.md; '
                  'у прежней сетки те же. Сайтов — предел тарифа (на нём считаются бэкапы).'); row += 2
    inp('pack_new_price', 'Пакет новой сетки: цена', float(C.VAR_R_PACK[0]), '₽', 'Ц4: 100 кредитов за 1 490 ₽, не сгорают', F_INT, True)
    inp('pack_new_credits', 'Пакет новой сетки: кредитов', float(C.VAR_R_PACK[1]), 'кредитов', '', F_INT)
    inp('pack_old_price', 'Прежний пакет: цена', float(C.CURRENT_PACK[0]), '₽', '', F_INT)
    inp('pack_old_credits', 'Прежний пакет: кредитов', float(C.CURRENT_PACK[1]), 'кредитов', '', F_INT)
    inp('gift_new', 'Подарок при регистрации', float(C.GIFT_NEW), 'кредитов', 'Ц5: 50 кредитов разово (было 35)', F_INT, True)
    inp('gift_old', 'Прежний подарок', 35, 'кредитов', '', F_INT)
    inp('limit_new', 'Предел неоплаченной работы с тарифом — доля месячных кредитов', 0.5, '', 'Ц8: половина месячных кредитов (было 100 %)', F_PCT, True)
    inp('limit_old', 'Прежний предел неоплаченной работы', 1.0, '', '', F_PCT)
    note(ws, row, 'Дневного лимита нет (Ц6); остаток кредитов тарифа переходит на один следующий период, не больше начисления (Ц7); '
                  'годовой оплаты нет до конца пилота (Ц10).'); row += 1

    # ------------------------------------------------------------------------------------------
    # Себестоимость
    # ------------------------------------------------------------------------------------------
    ws = sheets['Себестоимость']
    S = 'Себестоимость'
    title(ws, 'Себестоимость: модель на API и на плане, вычисления, проход и задача',
          'Реальные ₽ — то, что платформа платит Z.ai по курсу ЦБ на 06.11.2026; учётные ₽ — по учётным ставкам (в них маржа 30 % к цене Z.ai по курсу 17.10.2026).')
    ws.column_dimensions['A'].width = 64
    for col in 'BCDEFGHIJ':
        ws.column_dimensions[col].width = 15
    row = 4

    def calc_row(key, label, formula, fmt=F_D2, unit='', expected=None, tol=None, bold=False, src=''):
        nonlocal row
        put(ws, row, 1, label, bold=bold)
        put(ws, row, 2, formula, fmt=fmt, bold=bold)
        if unit:
            put(ws, row, 3, unit)
        if src:
            note(ws, row, src, 4)
        if key:
            R[key] = addr(S, 2, row)
        if expected is not None:
            check(ws, row, 2, expected, tol, label)
        row += 1

    section(ws, row, 'Курс'); row += 1
    calc_row('real_per_acc', 'Реальный рубль Z.ai на рубль учётной стоимости', f"={R['fx']}/({R['fx_rates']}*{R['markup']})", F_D5, '', C.REAL_PER_ACC, '0.00001')
    calc_row('k_real', 'Кредит полной работы на API, реальные ₽', f"={R['k']}*{R['real_per_acc']}", F_D3, '₽', C.K_REAL, '0.001')
    calc_row('rates_margin', 'Маржа файла ставок к цене Z.ai по сегодняшнему курсу', f"={R['markup']}*{R['fx_rates']}/{R['fx']}-1", F_PCT, '', C.RATES_MARKUP * C.FX_RATES_FILE / C.FX - 1, '0.001')
    row += 1

    section(ws, row, 'API Z.ai, ₽ за 1 млн токенов'); row += 1
    header(ws, row, ['Модель', 'Ввод', 'Кэш', 'Вывод'], 1); row += 1
    for key, name in [('glm', 'GLM-5.3'), ('flashx', 'GLM-5.3-FlashX'), ('flash', 'GLM-5.3-Flash')]:
        put(ws, row, 1, name)
        for i, part in enumerate(['in', 'cache', 'out']):
            put(ws, row, 2 + i, f"={R[f'api_{key}_{part}']}*{R['fx']}", fmt=F_D2)
        if key == 'glm':
            check(ws, row, 2, C.API['in'] * C.FX, '0.01', 'GLM ввод ₽')
            check(ws, row, 4, C.API['out'] * C.FX, '0.01', 'GLM вывод ₽')
        row += 1
    row += 1

    section(ws, row, 'План GLM Coding Plan в рублях и мощность (мера dev — со всей работой)', 10); row += 1
    header(ws, row, ['Уровень', '₽ в месяц', '₽ в месяц при годовой', 'Кредитов плана в месяц', 'Кредитов клиента в месяц, всё в пик',
                     'Всё вне пика', '₽ на кредит клиента, пик', 'Вне пика', 'Кредитов клиента в окне 5 ч, пик',
                     'Месяц плана окупается при списанных кредитах'], 1); row += 1
    plan_block_first = row
    PLAN_S = {}
    for tier, (usd, w5, week) in C.PLAN.items():
        put(ws, row, 1, tier)
        put(ws, row, 2, f"={R[f'plan_{tier}_usd']}*{R['fx']}", fmt=F_D2)
        put(ws, row, 3, f"={R[f'plan_{tier}_usd']}*(1-{R['year_disc']})*{R['fx']}", fmt=F_D2)
        put(ws, row, 4, f"={R[f'plan_{tier}_week']}*{R['weeks_month']}", fmt=F_INT)
        put(ws, row, 5, f"=D{row}/__PLAN_PER_CREDIT__", fmt=F_INT)
        put(ws, row, 6, f"=E{row}/{R['off_peak']}", fmt=F_INT)
        put(ws, row, 7, f"=B{row}/E{row}", fmt=F_D2)
        put(ws, row, 8, f"=B{row}/F{row}", fmt=F_D2)
        put(ws, row, 9, f"={R[f'plan_{tier}_w5']}/__PLAN_PER_CREDIT__", fmt=F_INT)
        put(ws, row, 10, f"=B{row}/__DEV_PER_CREDIT__", fmt=F_INT)
        check(ws, row, 10, usd * C.FX / C.DEV_REAL_PER_CREDIT_ALL, '0.5', f'{tier}: окупается при кредитах')
        R[f'plan_{tier}_rub'] = addr(S, 2, row)
        R[f'plan_{tier}_cap'] = addr(S, 5, row)
        R[f'plan_{tier}_per_credit'] = addr(S, 7, row)
        cap = week * C.WEEKS_PER_MONTH / C.DEV_PLAN_PER_CREDIT
        check(ws, row, 2, usd * C.FX, '0.01', f'{tier} ₽ в месяц')
        check(ws, row, 5, cap, '0.5', f'{tier}: кредитов клиента в пик')
        check(ws, row, 7, usd * C.FX / cap, '0.005', f'{tier}: ₽ на кредит в пик')
        PLAN_S[tier] = row
        row += 1
    note(ws, row, 'Мера — 27,4 кредита плана в пик на списанный кредит клиента (замер dev вместе с неоплаченной работой, ниже). '
                  'Сколько ходов одновременно Z.ai пускает на аккаунт, не опубликовано.'); row += 2

    section(ws, row, 'Задача business.md: API (реальные ₽), кредиты работы, списание и кредиты плана', 7); row += 1
    put(ws, row, 1, 'Доля кэша →', bold=True)
    put(ws, row, 2, 'Доля в смеси', bold=True)
    put(ws, row, 3, f"={R['cache_typ']}", fmt=F_PCT)
    cache_cols = {3: None}
    for i, cval in enumerate([0, 0.80, 0.92, 0.95]):
        put(ws, row, 4 + i, cval, fmt=F_PCT)
        cache_cols[4 + i] = cval
    cache_row = row
    note(ws, row, 'C — обычная работа (Допущения); D–G — для чувствительности', 8)
    row += 1

    def task_block(label, cell_formula, fmt, mix_label, expected_col=None):
        nonlocal row
        put(ws, row, 1, label, bold=True); row += 1
        rows_ = []
        for key, name, _ in TASK_KEYS:
            put(ws, row, 1, name)
            put(ws, row, 2, f"={R[f'task_{key}_share']}", fmt=F_PCT)
            for col in range(3, 8):
                cl = get_column_letter(col)
                put(ws, row, col, cell_formula(key, f"{cl}${cache_row}", cl, row), fmt=fmt)
            rows_.append(row)
            row += 1
        put(ws, row, 1, mix_label, bold=True)
        for col in range(3, 8):
            cl = get_column_letter(col)
            put(ws, row, col, f"=SUMPRODUCT($B${rows_[0]}:$B${rows_[-1]},{cl}{rows_[0]}:{cl}{rows_[-1]})", fmt=fmt, bold=True)
        mix_row = row
        row += 1
        return rows_, mix_row

    def usd_expr(key, cache):
        return (f"((1-{cache})*{R[f'task_{key}_in']}*{R['api_glm_in']}+{cache}*{R[f'task_{key}_in']}*{R['api_glm_cache']}"
                f"+{R[f'task_{key}_out']}*{R['api_glm_out']})/1000000")

    api_rows, api_mix = task_block('API, реальные ₽ на задачу', lambda key, cache, cl, r: f"={usd_expr(key, cache)}*{R['fx']}", F_D2,
                                   'Средняя задача смеси, ₽')
    work_rows, work_mix = task_block('Кредитов работы (учётные ₽ / K)',
                                     lambda key, cache, cl, r: f"={usd_expr(key, cache)}*{R['fx_rates']}*{R['markup']}/{R['k']}", F_D2,
                                     'Средняя задача, кредитов работы')
    charged_rows, charged_mix = task_block('Списано кредитов (не меньше минимума, округление до целого)',
                                           lambda key, cache, cl, r: f"=MAX({R['min_charge']},ROUND({cl}{work_rows[[k for k, _, _ in TASK_KEYS].index(key)]},0))",
                                           F_D2, 'Средняя задача, списано кредитов')
    plan_rows, plan_mix = task_block('Кредитов плана в пик',
                                     lambda key, cache, cl, r: (f"=((1-{cache})*{R[f'task_{key}_in']}*{R['plan_m_in']}+{cache}*{R[f'task_{key}_in']}*{R['plan_m_cache']}"
                                                                f"+{R[f'task_{key}_out']}*{R['plan_m_out']})/10000"), F_D1,
                                     'Средняя задача, кредитов плана в пик')
    put(ws, row, 1, 'Средняя задача, кредитов плана вне пика')
    for col in range(3, 8):
        cl = get_column_letter(col)
        put(ws, row, col, f"={cl}{plan_mix}*{R['off_peak']}", fmt=F_D1)
    row += 1
    put(ws, row, 1, 'Доля работы в списанном кредите')
    for col in range(3, 8):
        cl = get_column_letter(col)
        put(ws, row, col, f"={cl}{work_mix}/{cl}{charged_mix}", fmt=F_D3)
    share_row = row; row += 1
    put(ws, row, 1, 'Реальные ₽ на списанный кредит (без неоплаченной работы)')
    for col in range(3, 8):
        cl = get_column_letter(col)
        put(ws, row, col, f"={cl}{api_mix}/{cl}{charged_mix}", fmt=F_D2)
    row += 1
    put(ws, row, 1, 'Модель на списанный кредит с неоплаченной работой (обычная)')
    for col in range(3, 8):
        cl = get_column_letter(col)
        put(ws, row, col, f"={R['k_real']}*{cl}{share_row}*(1+{R['unpaid_docs']})", fmt=F_D2)
    model_per_credit_row = row; row += 1
    put(ws, row, 1, 'Задача business.md (кэш обычный) на плане Lite / Max при полной загрузке, ₽ — контент, код, сложная', color=GREY)
    row += 1
    for i, (key, name, _) in enumerate(TASK_KEYS):
        put(ws, row, 1, f'{name}: Lite в пик / Max в пик / Max вне пика, ₽')
        put(ws, row, 2, f"=C{plan_rows[i]}*{R['plan_Lite_rub']}/'Себестоимость'!$D${PLAN_S['Lite']}", fmt=F_D2)
        put(ws, row, 3, f"=C{plan_rows[i]}*{R['plan_Max_rub']}/'Себестоимость'!$D${PLAN_S['Max']}", fmt=F_D2)
        put(ws, row, 4, f"=C{row}*{R['off_peak']}", fmt=F_D2)
        row += 1
    R['api_mix_typ'] = addr(S, 3, api_mix)
    R['w_typ'] = addr(S, 3, work_mix)
    R['c_typ'] = addr(S, 3, charged_mix)
    R['cache_cols'] = {col: (get_column_letter(col), charged_mix, model_per_credit_row, api_mix) for col in range(4, 8)}
    _, W80, C80 = C.mix_task(D('0.80'))
    for col, cval in [(4, '0'), (5, '0.80'), (6, '0.92'), (7, '0.95')]:
        rub, work, charged = C.mix_task(D(cval))
        check(ws, api_mix, col, rub, '0.01', f'средняя задача API, кэш {cval}')
        check(ws, charged_mix, col, charged, '0.01', f'средняя задача списано, кэш {cval}')
        check(ws, model_per_credit_row, col, C.K_REAL * (work / charged) * (1 + C.UNPAID_DOCS), '0.005', f'модель на кредит, кэш {cval}')
    row += 1

    section(ws, row, 'Замер dev-базы (620 вызовов)'); row += 1
    calc_row('dev_calls_total', 'Вызовов', f"={R['dev_calls']}", F_INT)
    calc_row('dev_acc_total', 'Учётная стоимость вызовов', f"={R['dev_acc']}", F_D2, '₽', C.DEV_TOTAL_ACC, '0.01')
    calc_row(None, 'Реальная стоимость на API сегодня', f"={R['dev_acc_total']}*{R['real_per_acc']}", F_D2, '₽', C.DEV_TOTAL_ACC * C.REAL_PER_ACC, '0.01')
    calc_row(None, 'На вызов, реальные ₽', f"={R['dev_acc_total']}*{R['real_per_acc']}/{R['dev_calls_total']}", F_D3, '₽')
    calc_row(None, 'Доля кэша во вводе', f"={R['dev_cache']}/({R['dev_in']}+{R['dev_cache']})", F_PCT)
    calc_row('dev_plan_total', 'Кредитов плана по формуле, в пик', f"=({R['dev_in']}*{R['plan_m_in']}+{R['dev_cache']}*{R['plan_m_cache']}+{R['dev_out']}*{R['plan_m_out']})/10000", F_INT)
    calc_row(None, 'Кредитов плана на вызов, в пик', f"={R['dev_plan_total']}/{R['dev_calls_total']}", F_D2)
    calc_row(None, 'Во сколько раз вызов dev дороже синтетического запроса прежней оценки (в кредитах плана)',
             f"={R['dev_plan_total']}/{R['dev_calls_total']}/((1-{R['synt_cache']})*{R['synt_in']}*{R['plan_m_in']}/10000+{R['synt_cache']}*{R['synt_in']}*{R['plan_m_cache']}/10000+{R['synt_out']}*{R['plan_m_out']}/10000)", F_D1, '×')
    calc_row(None, 'Списано кредитов на задачу', f"={R['dev_charged_credits']}/{R['dev_charged_tasks']}", F_D2, 'кредитов', C.DEV_CHARGED_CREDITS / C.DEV_CHARGED_TASKS, '0.005')
    calc_row(None, 'Кредитов работы у задач со списанием', f"={R['dev_charged_acc']}/{R['k']}", F_D2)
    calc_row(None, 'Во сколько раз минимум увеличил списания', f"={R['dev_charged_credits']}/({R['dev_charged_acc']}/{R['k']})", F_D2, '×', C.DEV_CHARGED_CREDITS / (C.DEV_CHARGED_ACC / C.K), '0.005')
    calc_row(None, 'Неоплаченная работа, учётные ₽', f"={R['dev_acc_total']}-{R['dev_charged_acc']}", F_D2, '₽')
    calc_row(None, 'Её доля во всей работе', f"=({R['dev_acc_total']}-{R['dev_charged_acc']})/{R['dev_acc_total']}", F_PCT)
    calc_row('unpaid_dev', 'Неоплаченная работа к оплаченной (dev)', f"=({R['dev_acc_total']}-{R['dev_charged_acc']})/{R['dev_charged_acc']}", F_PCT, '', C.UNPAID_DEV, '0.0005')
    calc_row('plan_per_credit', 'Кредитов плана в пик на списанный кредит клиента (со всей работой)', f"={R['dev_plan_total']}/{R['dev_charged_credits']}", F_D2, '', C.DEV_PLAN_PER_CREDIT, '0.01')
    calc_row(None, 'Кредитов плана в пик на кредит работы', f"={R['dev_plan_total']}/({R['dev_acc_total']}/{R['k']})", F_D1)
    row += 1

    section(ws, row, 'Модель на API: реальные ₽ на списанный кредит'); row += 1
    calc_row('dev_per_credit', 'Замер dev, со всей работой', f"={R['dev_acc_total']}/{R['dev_charged_credits']}*{R['real_per_acc']}", F_D2, '₽', C.DEV_REAL_PER_CREDIT_ALL, '0.005')
    calc_row(None, 'Замер dev, только оплаченная работа', f"={R['dev_charged_acc']}/{R['dev_charged_credits']}*{R['real_per_acc']}", F_D2, '₽', C.DEV_REAL_PER_CREDIT_CHARGED, '0.005')
    calc_row('base', 'Смесь токенов, кэш обычный, неоплаченная обычная — база обычного использования', f"={R['k_real']}*{R['w_typ']}/{R['c_typ']}*(1+{R['unpaid_docs']})", F_D2, '₽', C.BASE_TYPICAL, '0.005', bold=True)
    calc_row(None, 'Каждый кредит — полная работа, неоплаченная обычная', f"={R['k_real']}*(1+{R['unpaid_docs']})", F_D2, '₽', C.COST['full25'], '0.005')
    calc_row('stress', 'Стресс «вся квота»: каждый кредит — полная работа, неоплаченная как в dev', f"={R['k_real']}*(1+{R['unpaid_dev']})", F_D2, '₽', C.STRESS, '0.005', bold=True)
    calc_row('lim_new', 'Предел новых правил: неоплаченная работа — половина квоты (Ц8)', f"={R['k_real']}*(1+{R['limit_new']})", F_D2, '₽', C.COST['limit50'], '0.005')
    calc_row('lim_old', 'Предел прежних правил: неоплаченная работа — ещё раз квота', f"={R['k_real']}*(1+{R['limit_old']})", F_D2, '₽', C.COST['limit'], '0.005')
    for tier in C.PLAN:
        calc_row(None, f'План {tier} при полной загрузке, в пик (вне пика — вдвое меньше)', f"={R[f'plan_{tier}_per_credit']}", F_D2, '₽')
    row += 1

    section(ws, row, 'Ход и проход по видам чата (dev): реальные ₽ на API и на плане при полной загрузке', 10); row += 1
    header(ws, row, ['Вид', 'Ходов', 'Среднее, ₽', 'Медиана, ₽', 'p90, ₽', 'Максимум, ₽', 'Кредитов плана в пик, среднее',
                     'На плане Lite, ₽', 'На плане Max, ₽', 'Минут'], 1); row += 1
    turn_s = {}
    for key, label in [('code', 'Чат с кодом'), ('browser', 'Браузер на сайте проекта'), ('noproj', 'Чат без проекта')]:
        tr = TURN_ROWS[key]
        put(ws, row, 1, label)
        put(ws, row, 2, f"={addr('Допущения', 2, tr)}", fmt=F_INT)
        for i, col in enumerate([6, 7, 8, 9]):
            put(ws, row, 3 + i, f"={addr('Допущения', col, tr)}*{R['real_per_acc']}", fmt=F_D2)
        put(ws, row, 7, (f"=((1-{addr('Допущения', 4, tr)})*{addr('Допущения', 3, tr)}*{R['plan_m_in']}+{addr('Допущения', 4, tr)}*{addr('Допущения', 3, tr)}*{R['plan_m_cache']}"
                         f"+{addr('Допущения', 5, tr)}*{R['plan_m_out']})/10000"), fmt=F_D1)
        put(ws, row, 8, f"=G{row}*{R['plan_Lite_rub']}/'Себестоимость'!$D${PLAN_S['Lite']}", fmt=F_D2)
        put(ws, row, 9, f"=G{row}*{R['plan_Max_rub']}/'Себестоимость'!$D${PLAN_S['Max']}", fmt=F_D2)
        put(ws, row, 10, f"={addr('Допущения', 10, tr)}", fmt=F_D1)
        name = {'code': 'Код (repo)', 'browser': 'Браузер на сайте', 'noproj': 'Чат без проекта'}[key]
        check(ws, row, 3, C.DEV_TURNS[name][4] * C.REAL_PER_ACC, '0.005', f'{label}: среднее ₽')
        turn_s[key] = row
        row += 1
    R['turn_code_avg'] = addr(S, 3, turn_s['code'])
    R['turn_code_max'] = addr(S, 6, turn_s['code'])
    R['turn_browser_avg'] = addr(S, 3, turn_s['browser'])
    R['turn_browser_max'] = addr(S, 6, turn_s['browser'])
    R['turn_code_lite'] = addr(S, 8, turn_s['code'])
    R['turn_code_max_plan'] = addr(S, 9, turn_s['code'])
    header(ws, row, ['Проход (цепочка), реальные ₽ на API', 'Медиана', 'p90', 'Максимум'], 1); row += 1
    for key, label in [('code', 'Чат с кодом'), ('browser', 'Браузер на сайте проекта')]:
        cr = CHAIN_ROWS[key]
        put(ws, row, 1, label)
        for i in range(3):
            put(ws, row, 2 + i, f"={addr('Допущения', 2 + i, cr)}*{R['k_real']}", fmt=F_D2)
        row += 1
    row += 1

    section(ws, row, 'Вычисления на действие клиента'); row += 1
    calc_row('sb_minute', 'Песочница хода, ₽ в минуту', f"=({R['sb_cpu']}*{R['vcpu']}+{R['sb_ram']}*{R['ram']})/60", F_D4, '₽', C.SB_MIN, '0.0001')
    calc_row('pv_minute', 'Предпросмотр, ₽ в минуту', f"=({R['pv_cpu']}*{R['vcpu']}+{R['pv_ram']}*{R['ram']})/60", F_D4, '₽', C.PV_MIN, '0.0001')
    calc_row('br_minute', 'Облачный браузер, ₽ в минуту', f"=({R['br_cpu']}*{R['vcpu']}+{R['br_ram']}*{R['ram']})/60", F_D4, '₽', C.BR_MIN, '0.0001')
    calc_row('sb_act', 'Песочница на действие', f"={R['sb_minute']}*{R['turn_min']}*{R['passes']}/{R['load']}", F_D2, '₽', C.SB_ACT, '0.005')
    calc_row('pv_act', 'Предпросмотр на действие', f"={R['pv_minute']}*{R['pv_min']}/{R['load']}*{R['pv_share']}", F_D2, '₽', C.PV_ACT, '0.005')
    calc_row('br_act', 'Браузер на действие', f"={R['br_minute']}*{R['br_min']}/{R['load']}*{R['br_share']}", F_D2, '₽', C.BR_ACT, '0.005')
    calc_row('compute_action', 'Вычисления на действие', f"={R['sb_act']}+{R['pv_act']}+{R['br_act']}", F_D2, '₽', C.COMPUTE_PER_ACTION, '0.005', bold=True)
    calc_row('compute', 'Вычисления на кредит', f"={R['compute_action']}/{R['cpa']}", F_D3, '₽', C.COMPUTE_PER_CREDIT, '0.001', bold=True)
    calc_row('backup_site', 'Бэкапы в S3 на сайт в месяц', f"={R['backup_gb']}*{R['s3']}", F_D2, '₽', C.BACKUP_PER_SITE, '0.01')
    calc_row('op_minute', 'Минута оператора', f"={R['op_salary']}*{R['tax_coef']}/({R['op_days']}*{R['op_hours']}*60*{R['op_prod']})", F_D2, '₽')
    calc_row('escalation', 'Эскалации на задачу (только ООО; в вклад тарифов не входят — оператор в постоянных расходах)', f"={R['esc_share']}*{R['esc_min']}*{R['op_minute']}", F_D2, '₽', C.ESCALATION_PER_TASK, '0.01')
    calc_row('onboarding', 'Онбординг клиента (до рубля, как в CAC 7 633 ₽)', f"=ROUND({R['onb_min']}*{R['op_minute']},0)", F_D2, '₽', D('633'), '0')
    row += 1

    section(ws, row, 'Удержания и привлечение'); row += 1
    calc_row('fee_yk_npd', 'ЮKassa для самозанятой с НДС с комиссии', f"={R['yk_npd']}*(1+{R['vat_fee']})", F_PCT2, '', C.YK_NPD, '0.00001')
    calc_row('fees_npd', 'Удержания самозанятой: ЮKassa + НПД', f"={R['fee_yk_npd']}+{R['npd_tax']}", F_PCT2, '', C.YK_NPD + C.NPD_TAX, '0.00001', bold=True)
    calc_row('fee_yk_legal', 'ЮKassa для ООО или ИП с чеком и НДС с комиссии', f"=({R['yk_legal']}+{R['yk_receipt']})*(1+{R['vat_fee']})", F_PCT2, '', C.YK_LEGAL, '0.00001')
    calc_row('fees_legal', 'Удержания ООО или ИП: ЮKassa + УСН', f"={R['fee_yk_legal']}+{R['usn']}", F_PCT2, '', C.YK_LEGAL + C.USN, '0.00001', bold=True)
    calc_row('cac', 'CAC с онбордингом, базовый сценарий', f"={R['ad_base']}+{R['onboarding']}", F_INT, '₽', C.CAC_BASE, '0.5', bold=True)
    calc_row('cac_low', 'CAC с онбордингом, дешёвый сценарий', f"={R['ad_low']}+{R['onboarding']}", F_INT, '₽', C.CAC_LOW, '0.5')
    calc_row('cac_optin', 'CAC при конверсии подарка без карты', f"={R['click']}/({R['conv_land']}*{R['conv_gift']})+{R['onboarding']}", F_INT, '₽', C.CAC_OPTIN, '0.5')
    row += 1

    section(ws, row, 'Себестоимость прохода и задачи — сводка'); row += 1
    header(ws, row, ['Статья', 'На действие или задачу, ₽', 'Откуда'], 1); row += 1
    for label, formula, src in [
        ('Модель на API, проход с кодом — в среднем', f"={R['turn_code_avg']}", 'dev, 16 ходов'),
        ('Модель на API, проход с кодом — максимум', f"={R['turn_code_max']}", 'dev'),
        ('Модель на API, браузер на сайте — в среднем', f"={R['turn_browser_avg']}", 'dev, 18 ходов'),
        ('Модель на API, браузер на сайте — максимум', f"={R['turn_browser_max']}", 'dev'),
        ('Модель на API, средняя задача business.md, кэш обычный', f"={R['api_mix_typ']}", 'гипотеза токенов'),
        ('Модель на API, средняя задача business.md, кэш 92 %', f"=F{api_mix}", 'гипотеза токенов'),
        ('Модель на плане Max при полной загрузке, проход с кодом', f"={R['turn_code_max_plan']}", 'формула кредитов плана'),
        ('Модель на плане Lite при полной загрузке, проход с кодом', f"={R['turn_code_lite']}", 'формула кредитов плана'),
        ('Песочница: 2 прохода', f"={R['sb_act']}", 'вычисления'),
        ('Предпросмотр: 40 мин у половины действий', f"={R['pv_act']}", 'вычисления'),
        ('Облачный браузер у 40 % действий', f"={R['br_act']}", 'вычисления'),
        ('Вычисления всего на действие', f"={R['compute_action']}", 'при 7 кредитах на действие'),
        ('Бэкапы и S3 на сайт в месяц', f"={R['backup_site']}", 'business.md'),
        ('Эскалация оператору на задачу (только ООО)', f"={R['escalation']}", '5 % задач по 15 мин'),
    ]:
        put(ws, row, 1, label)
        put(ws, row, 2, formula, fmt=F_D2)
        note(ws, row, src, 3)
        row += 1

    # Подставить меру плана, которая появилась ниже по листу.
    for tier, prow in PLAN_S.items():
        for col in (5, 9, 10):
            cell = ws.cell(row=prow, column=col)
            cell.value = (cell.value.replace('__PLAN_PER_CREDIT__', R['plan_per_credit'])
                          .replace('__DEV_PER_CREDIT__', R['dev_per_credit']))

    # ------------------------------------------------------------------------------------------
    # Тарифы
    # ------------------------------------------------------------------------------------------
    ws = sheets['Тарифы']
    S = 'Тарифы'
    title(ws, 'Тарифы: новая сетка и прежняя, цена действия, вклад при обычном использовании и при всей квоте',
          'Самозанятая (НПД): удержания 8,27 %; модель на API. «Обычно» — 12 / 40 / 150 действий по 7 кредитов; «вся квота» — каждый кредит несёт полную работу, '
          'а неоплаченной работы столько же, сколько в dev; «предел» — клиент выбрал квоту и ещё столько неоплаченной работы, сколько пускают правила.')
    ws.column_dimensions['A'].width = 22
    for col in range(2, 27):
        ws.column_dimensions[get_column_letter(col)].width = 12
    heads = ['Тариф', 'Доля клиентов', 'Цена, ₽ в месяц', 'Кредитов в месяц', 'Сайтов', '₽ за кредит', 'Небольшая правка (5 кр.), ₽',
             'Обычное действие (7 кр.), ₽', 'Небольших правок в квоте', 'Обычных действий в квоте', 'Чистыми после удержаний, ₽',
             'Действий обычно', 'Кредитов обычно', 'Затраты обычно, ₽', 'Вклад обычно, ₽', 'Маржа обычно',
             'Затраты, вся квота, ₽', 'Вклад, вся квота, ₽', 'Маржа, вся квота', 'Вклад на пределе 100 % (прежние правила), ₽', 'Маржа',
             'Вклад на пределе 50 % (Ц8), ₽', 'Маржа', 'Запас кредита над стрессом, ₽', 'Цена кредита ÷ кредит полной работы']
    row = 4
    TROWS = {}
    for grid, label, tariffs, pack_price, pack_credits in [
        ('new', 'Новая сетка (06.11.2026)', C.VAR_R, 'pack_new_price', 'pack_new_credits'),
        ('old', 'Прежняя сетка (до 06.11.2026)', C.CURRENT, 'pack_old_price', 'pack_old_credits'),
    ]:
        section(ws, row, label, len(heads)); row += 1
        header(ws, row, heads, 1); ws.row_dimensions[row].height = 54; row += 1
        rows_ = []
        ref_rows = C.tariff_rows(tariffs, C.YK_NPD, C.NPD_TAX, extra_full=C.COST['limit'])
        for i, drow in enumerate(TAR[grid]):
            put(ws, row, 1, f"={addr('Допущения', 1, drow)}")
            put(ws, row, 2, f"={addr('Допущения', 6, drow)}", fmt=F_PCT)
            put(ws, row, 3, f"={addr('Допущения', 2, drow)}", fmt=F_INT)
            put(ws, row, 4, f"={addr('Допущения', 3, drow)}", fmt=F_INT)
            put(ws, row, 5, f"={addr('Допущения', 4, drow)}", fmt=F_INT)
            put(ws, row, 6, f"=C{row}/D{row}", fmt=F_D2)
            put(ws, row, 7, f"=F{row}*{R['small_edit']}", fmt=F_INT)
            put(ws, row, 8, f"=F{row}*{R['cpa']}", fmt=F_INT)
            put(ws, row, 9, f"=D{row}/{R['small_edit']}", fmt=F_INT)
            put(ws, row, 10, f"=D{row}/{R['cpa']}", fmt=F_INT)
            put(ws, row, 11, f"=C{row}*(1-{R['fees_npd']})", fmt=F_INT)
            put(ws, row, 12, f"={addr('Допущения', 5, drow)}", fmt=F_D1)
            put(ws, row, 13, f"=L{row}*{R['cpa']}", fmt=F_INT)
            put(ws, row, 14, f"=M{row}*({R['base']}+{R['compute']})+E{row}*{R['backup_site']}", fmt=F_INT)
            put(ws, row, 15, f"=K{row}-N{row}", fmt=F_INT)
            put(ws, row, 16, f"=IF(C{row}=0,0,O{row}/C{row})", fmt=F_PCT)
            put(ws, row, 17, f"=D{row}*({R['stress']}+{R['compute']})+E{row}*{R['backup_site']}", fmt=F_INT)
            put(ws, row, 18, f"=K{row}-Q{row}", fmt=F_INT)
            put(ws, row, 19, f"=IF(C{row}=0,0,R{row}/C{row})", fmt=F_PCT)
            put(ws, row, 20, f"=K{row}-(D{row}*({R['lim_old']}+{R['compute']})+E{row}*{R['backup_site']})", fmt=F_INT)
            put(ws, row, 21, f"=IF(C{row}=0,0,T{row}/C{row})", fmt=F_PCT)
            put(ws, row, 22, f"=K{row}-(D{row}*({R['lim_new']}+{R['compute']})+E{row}*{R['backup_site']})", fmt=F_INT)
            put(ws, row, 23, f"=IF(C{row}=0,0,V{row}/C{row})", fmt=F_PCT)
            put(ws, row, 24, f"=K{row}/D{row}-{R['stress']}-{R['compute']}", fmt=F_D2)
            put(ws, row, 25, f"=F{row}/{R['k_real']}", fmt=F_D2)
            r = ref_rows[i]
            check(ws, row, 15, r['contrib_t'], '0.5', f"{grid} {r['name']}: вклад обычно")
            check(ws, row, 16, r['contrib_t'] / r['price'], '0.0005', f"{grid} {r['name']}: маржа обычно")
            check(ws, row, 18, r['contrib_f'], '0.5', f"{grid} {r['name']}: вклад вся квота")
            check(ws, row, 19, r['contrib_f'] / r['price'], '0.0005', f"{grid} {r['name']}: маржа вся квота")
            check(ws, row, 20, r['contrib_x'], '0.5', f"{grid} {r['name']}: предел 100 %")
            check(ws, row, 22, r['contrib_y'], '0.5', f"{grid} {r['name']}: предел 50 %")
            check(ws, row, 7, r['per_credit'] * 5, '0.01', f"{grid} {r['name']}: небольшая правка")
            rows_.append(row)
            row += 1
        # Пакет
        put(ws, row, 1, 'Пакет (разово)')
        put(ws, row, 3, f"={R[pack_price]}", fmt=F_INT)
        put(ws, row, 4, f"={R[pack_credits]}", fmt=F_INT)
        put(ws, row, 6, f"=C{row}/D{row}", fmt=F_D2)
        put(ws, row, 7, f"=F{row}*{R['small_edit']}", fmt=F_INT)
        put(ws, row, 8, f"=F{row}*{R['cpa']}", fmt=F_INT)
        put(ws, row, 9, f"=D{row}/{R['small_edit']}", fmt=F_INT)
        put(ws, row, 10, f"=D{row}/{R['cpa']}", fmt=F_INT)
        put(ws, row, 11, f"=C{row}*(1-{R['fees_npd']})", fmt=F_INT)
        put(ws, row, 24, f"=K{row}/D{row}-{R['stress']}-{R['compute']}", fmt=F_D2)
        put(ws, row, 25, f"=F{row}/{R['k_real']}", fmt=F_D2)
        pack_row = row
        row += 1
        first, last = rows_[0], rows_[-1]
        put(ws, row, 1, 'Средний клиент', bold=True)
        put(ws, row, 2, f"=SUM(B{first}:B{last})", fmt=F_PCT, bold=True)
        for col in [3, 12, 13, 14, 15, 17, 18]:
            cl = get_column_letter(col)
            put(ws, row, col, f"=SUMPRODUCT($B${first}:$B${last},{cl}{first}:{cl}{last})", fmt=F_D1 if col in (12, 13) else F_INT, bold=True)
        put(ws, row, 16, f"=IF(C{row}=0,0,O{row}/C{row})", fmt=F_PCT, bold=True)
        put(ws, row, 19, f"=IF(C{row}=0,0,R{row}/C{row})", fmt=F_PCT, bold=True)
        arpu, contrib, used = C.avg_client(tariffs, C.YK_NPD, C.NPD_TAX)
        check(ws, row, 3, arpu, '0.5', f'{grid}: средний чек')
        check(ws, row, 13, used, '0.05', f'{grid}: кредитов в месяц')
        check(ws, row, 15, contrib, '0.5', f'{grid}: вклад среднего клиента')
        check(ws, row, 16, contrib / arpu, '0.0005', f'{grid}: маржа среднего клиента')
        TROWS[grid] = dict(rows=rows_, pack=pack_row, avg=row)
        row += 2

    def T(grid, col, which='avg'):
        r = TROWS[grid][which]
        return addr('Тарифы', col, r)

    R['arpu_new'] = T('new', 3); R['arpu_old'] = T('old', 3)
    R['contrib_new'] = T('new', 15); R['contrib_old'] = T('old', 15)
    R['used_new'] = T('new', 13); R['used_old'] = T('old', 13)
    R['actions_new'] = T('new', 12)

    section(ws, row, 'Подарок при регистрации (Ц5) и правила новой сетки', 8); row += 1
    put(ws, row, 1, 'Подарок, кредитов'); put(ws, row, 3, f"={R['gift_new']}", fmt=F_INT); row += 1
    put(ws, row, 1, 'Стоит платформе на регистрацию, обычная работа, ₽'); put(ws, row, 3, f"={R['gift_new']}*({R['base']}+{R['compute']})", fmt=F_INT)
    gift_row = row; check(ws, row, 3, C.GIFT_NEW * (C.BASE_TYPICAL + C.COMPUTE_PER_CREDIT), '0.5', 'подарок на регистрацию'); row += 1
    put(ws, row, 1, 'То же в стрессе (полная работа, неоплаченная как в dev), ₽'); put(ws, row, 3, f"={R['gift_new']}*({R['stress']}+{R['compute']})", fmt=F_INT); row += 1
    put(ws, row, 1, 'На платящего при конверсии базового сценария, ₽'); put(ws, row, 3, f"=C{gift_row}/{R['conv_pay']}", fmt=F_INT)
    put(ws, row, 4, f"=C{row}/{R['cac']}", fmt=F_PCT); note(ws, row, 'доля CAC базового сценария', 5); row += 1
    put(ws, row, 1, 'На платящего при конверсии подарка без карты, ₽'); put(ws, row, 3, f"=C{gift_row}/{R['conv_gift']}", fmt=F_INT)
    put(ws, row, 4, f"=C{row}/{R['cac_optin']}", fmt=F_PCT); note(ws, row, 'доля CAC opt-in', 5); row += 1
    for text in ['Ц6: дневного лимита кредитов тарифа нет; нагрузку держат шаг на проход, очередь и не больше двух чатов с браузером одновременно.',
                 'Ц7: неистраченные кредиты тарифа переходят на один следующий период — не больше начисления закончившегося периода; '
                 'в месяце с переносом клиент может потратить до двух квот, но предыдущий месяц тогда был недоиспользован.',
                 'Ц8–Ц9: предел неоплаченной работы — половина месячных кредитов тарифа (75 / 300 / 1 000), без тарифа — 50 кредитов, сам подарок.',
                 'Ц10: годовой оплаты нет до конца пилота. Ц12: минимум 5 кредитов за первое списание чата, следующие проходы — от 1. Ц13: K = 6,00 ₽.']:
        note(ws, row, text); row += 1

    # ------------------------------------------------------------------------------------------
    # НПД
    # ------------------------------------------------------------------------------------------
    ws = sheets['НПД']
    S = 'НПД'
    title(ws, 'Самозанятая (НПД): сколько платящих пускает потолок 2,4 млн ₽ и что остаётся владельцу',
          'Без работников; модель на API — базовый сценарий, план Pro — сценарий экономии. Замена оттока — привлечение новых клиентов вместо ушедших.')
    ws.column_dimensions['A'].width = 70
    ws.column_dimensions['B'].width = 16
    ws.column_dimensions['C'].width = 16
    row = 4
    header(ws, row, ['Показатель', 'Новая сетка', 'Прежняя сетка'], 1); row += 1
    NP = {}

    def npd_row(key, label, f_new, f_old, fmt=F_INT, exp=None, tol='0.5'):
        nonlocal row
        put(ws, row, 1, label)
        put(ws, row, 2, f_new, fmt=fmt)
        put(ws, row, 3, f_old, fmt=fmt)
        NP[key] = row
        if exp:
            check(ws, row, 2, exp[0], tol, f'НПД новая: {label}')
            check(ws, row, 3, exp[1], tol, f'НПД прежняя: {label}')
        row += 1

    cap_new, cap_old = npd_cap(C.VAR_R), npd_cap(C.CURRENT)
    npd_row('arpu', 'Средний чек, ₽ в месяц', f"={R['arpu_new']}", f"={R['arpu_old']}", exp=(cap_new['arpu'], cap_old['arpu']))
    npd_row('contrib', 'Вклад среднего клиента, ₽ в месяц', f"={R['contrib_new']}", f"={R['contrib_old']}", exp=(cap_new['contrib'], cap_old['contrib']))
    npd_row('used', 'Кредитов в месяц на клиента', f"={R['used_new']}", f"={R['used_old']}", fmt=F_D1)
    npd_row('cap', 'Потолок выручки в месяц, ₽', f"={R['npd_cap']}/12", f"={R['npd_cap']}/12")
    npd_row('clients', 'Платящих при потолке', f"=INT(B{row - 1}/B{NP['arpu']})", f"=INT(C{row - 1}/C{NP['arpu']})",
            exp=(cap_new['clients'], cap_old['clients']), tol='0')
    npd_row('only_start', 'Платящих, если все на «Старте»', f"=INT(B{NP['cap']}/'Тарифы'!$C${TROWS['new']['rows'][0]})",
            f"=INT(C{NP['cap']}/'Тарифы'!$C${TROWS['old']['rows'][0]})")
    npd_row('credits', 'Кредитов в месяц у потолка', f"=B{NP['clients']}*B{NP['used']}", f"=C{NP['clients']}*C{NP['used']}",
            exp=(cap_new['credits'], cap_old['credits']), tol='0.5')
    npd_row('total', 'Вклад всех клиентов, ₽ в месяц', f"=B{NP['clients']}*B{NP['contrib']}", f"=C{NP['clients']}*C{NP['contrib']}",
            exp=(cap_new['total'], cap_old['total']), tol='1')
    npd_row('churn', 'Замена оттока по CAC базового сценария, ₽ в месяц', f"=B{NP['clients']}*{R['churn']}*{R['cac']}",
            f"=C{NP['clients']}*{R['churn']}*{R['cac']}", exp=(cap_new['churn_cac'], cap_old['churn_cac']), tol='1')
    npd_row('infra', 'База 5 ВМ, ₽ в месяц', f"={R['infra']}", f"={R['infra']}")
    npd_row('services', 'Почта, домены, бухгалтер, ₽ в месяц', f"={R['services_npd']}", f"={R['services_npd']}")
    npd_row('owner_api', 'Остаётся владельцу, модель на API, ₽ в месяц', f"=B{NP['total']}-B{NP['churn']}-B{NP['infra']}-B{NP['services']}",
            f"=C{NP['total']}-C{NP['churn']}-C{NP['infra']}-C{NP['services']}", exp=(cap_new['owner_api'], cap_old['owner_api']), tol='3')
    npd_row('model_api', 'Модель на API у потолка, ₽ в месяц', f"=B{NP['credits']}*{R['base']}", f"=C{NP['credits']}*{R['base']}",
            exp=(cap_new['model_api'], cap_old['model_api']), tol='1')
    npd_row('pro', 'План Pro вместо API, ₽ в месяц', f"={R['plan_Pro_rub']}", f"={R['plan_Pro_rub']}")
    npd_row('owner_plan', 'Остаётся владельцу на плане Pro, ₽ в месяц', f"=B{NP['owner_api']}+B{NP['model_api']}-B{NP['pro']}",
            f"=C{NP['owner_api']}+C{NP['model_api']}-C{NP['pro']}", exp=(cap_new['owner_plan'], cap_old['owner_plan']), tol='3')
    npd_row('fixed_api', 'Постоянных расходов выдерживает без дохода владельца: на API', f"=B{NP['total']}-B{NP['churn']}",
            f"=C{NP['total']}-C{NP['churn']}")
    npd_row('fixed_plan', '…на плане Pro', f"=B{NP['fixed_api']}+B{NP['model_api']}-B{NP['pro']}", f"=C{NP['fixed_api']}+C{NP['model_api']}-C{NP['pro']}")
    row += 1
    put(ws, row, 1, 'Снижение цен стоит владельцу у потолка: на API / на плане Pro, ₽ в месяц')
    put(ws, row, 2, f"=C{NP['owner_api']}-B{NP['owner_api']}", fmt=F_INT)
    put(ws, row, 3, f"=C{NP['owner_plan']}-B{NP['owner_plan']}", fmt=F_INT)
    check(ws, row, 2, cap_old['owner_api'] - cap_new['owner_api'], '4', 'снижение цен на API')
    row += 1
    put(ws, row, 1, 'Новая сетка при вдвое меньшем CAC, план Pro: остаётся владельцу, ₽ в месяц')
    put(ws, row, 2, f"=B{NP['total']}-B{NP['clients']}*{R['churn']}*{R['cac']}/2-B{NP['infra']}-B{NP['services']}+B{NP['model_api']}-B{NP['pro']}", fmt=F_INT)
    row += 2
    section(ws, row, 'Загрузка недельной квоты плана у потолка (новая сетка)', 3); row += 1
    header(ws, row, ['Уровень', 'В пик', 'Вне пика'], 1); row += 1
    for tier in C.PLAN:
        put(ws, row, 1, f'План {tier}')
        put(ws, row, 2, f"=B{NP['credits']}/{R[f'plan_{tier}_cap']}", fmt=F_PCT)
        put(ws, row, 3, f"=B{row}*{R['off_peak']}", fmt=F_PCT)
        row += 1
    row += 1
    section(ws, row, 'Показатели клиента (НПД, модель на API, обычное использование)', 3); row += 1
    header(ws, row, ['Показатель', 'Новая сетка', 'Прежняя сетка'], 1); row += 1
    for label, fmt, f in [
        ('Окупаемость привлечения при CAC базового сценария, мес', F_D1, lambda c: f"={R['cac']}/{c}{NP['contrib']}"),
        ('Окупаемость при CAC opt-in, мес', F_D1, lambda c: f"={R['cac_optin']}/{c}{NP['contrib']}"),
        ('LTV (вклад / отток), ₽', F_INT, lambda c: f"={c}{NP['contrib']}/{R['churn']}"),
        ('LTV / CAC базового сценария', F_D1, lambda c: f"={c}{NP['contrib']}/{R['churn']}/{R['cac']}"),
        ('LTV / CAC opt-in', F_D1, lambda c: f"={c}{NP['contrib']}/{R['churn']}/{R['cac_optin']}"),
    ]:
        put(ws, row, 1, label)
        put(ws, row, 2, f('B'), fmt=fmt)
        put(ws, row, 3, f('C'), fmt=fmt)
        if label.startswith('LTV / CAC базового'):
            check(ws, row, 2, cap_new['contrib'] / D('0.04') / C.CAC_BASE, '0.05', 'LTV/CAC новая')
        if label.startswith('Окупаемость привлечения'):
            check(ws, row, 2, C.CAC_BASE / cap_new['contrib'], '0.05', 'окупаемость новая')
        row += 1

    # ------------------------------------------------------------------------------------------
    # ООО
    # ------------------------------------------------------------------------------------------
    ws = sheets['ООО']
    S = 'ООО'
    title(ws, 'ООО или ИП на УСН с командой: безубыточность и план на 12 месяцев',
          'Удержания 10,64 % (ЮKassa с чеком и НДС с комиссии плюс УСН 6 % «доходы» — проверить с бухгалтером); постоянные расходы — команда 4,5 ставки, база инфраструктуры, бухгалтерия и сервисы.')
    ws.column_dimensions['A'].width = 66
    for col in 'BCDEFGHI':
        ws.column_dimensions[col].width = 16
    row = 4
    header(ws, row, ['Показатель', 'Новая сетка', 'Прежняя сетка'], 1); row += 1
    OO = {}
    p_new, p_old = ooo_plan(C.VAR_R), ooo_plan(C.CURRENT)

    def ooo_row(key, label, f_new, f_old, fmt=F_INT, exp=None, tol='0.5'):
        nonlocal row
        put(ws, row, 1, label)
        put(ws, row, 2, f_new, fmt=fmt)
        put(ws, row, 3, f_old, fmt=fmt)
        OO[key] = row
        if exp:
            check(ws, row, 2, exp[0], tol, f'ООО новая: {label}')
            check(ws, row, 3, exp[1], tol, f'ООО прежняя: {label}')
        row += 1

    def legal_contrib(grid):
        rows_ = TROWS[grid]['rows']
        a, b = rows_[0], rows_[-1]
        return (f"=SUMPRODUCT('Тарифы'!$B${a}:$B${b},'Тарифы'!$C${a}:$C${b})*(1-{R['fees_legal']})"
                f"-SUMPRODUCT('Тарифы'!$B${a}:$B${b},'Тарифы'!$N${a}:$N${b})")

    ooo_row('fees', 'Удержания с выручки', f"={R['fees_legal']}", f"={R['fees_legal']}", fmt=F_PCT2)
    ooo_row('arpu', 'Средний чек, ₽ в месяц', f"={R['arpu_new']}", f"={R['arpu_old']}")
    ooo_row('contrib', 'Вклад среднего клиента, ₽ в месяц', legal_contrib('new'), legal_contrib('old'), exp=(p_new['contrib'], p_old['contrib']))
    ooo_row('used', 'Кредитов в месяц на клиента', f"={R['used_new']}", f"={R['used_old']}", fmt=F_D1)
    ooo_row('fixed', 'Постоянные расходы, ₽ в месяц', f"={R['fixed']}", f"={R['fixed']}")
    ooo_row('be', 'Безубыточность, платящих клиентов', f"=B{OO['fixed']}/B{OO['contrib']}", f"=C{OO['fixed']}/C{OO['contrib']}",
            exp=(C.FIXED_TEAM / p_new['contrib'], C.FIXED_TEAM / p_old['contrib']), tol='0.5')
    ooo_row('be_churn', 'С заменой оттока по CAC базового сценария', f"=B{OO['fixed']}/(B{OO['contrib']}-{R['churn']}*{R['cac']})",
            f"=C{OO['fixed']}/(C{OO['contrib']}-{R['churn']}*{R['cac']})",
            exp=(C.FIXED_TEAM / (p_new['contrib'] - D('0.04') * C.CAC_BASE), C.FIXED_TEAM / (p_old['contrib'] - D('0.04') * C.CAC_BASE)), tol='0.5')
    ooo_row('rev', 'Выручка в месяц при безубыточности, ₽', f"=B{OO['be']}*B{OO['arpu']}", f"=C{OO['be']}*C{OO['arpu']}")
    ooo_row('credits', 'Кредитов в месяц при безубыточности', f"=B{OO['be']}*B{OO['used']}", f"=C{OO['be']}*C{OO['used']}")
    ooo_row('contrib_plan', 'Вклад клиента на плане (модель — постоянный расход аккаунтов), ₽', f"=B{OO['contrib']}+B{OO['used']}*{R['base']}",
            f"=C{OO['contrib']}+C{OO['used']}*{R['base']}")
    ooo_row('be_plan', 'Безубыточность на плане, клиентов', f"=B{OO['fixed']}/B{OO['contrib_plan']}", f"=C{OO['fixed']}/C{OO['contrib_plan']}")
    ooo_row('max_peak', 'Аккаунтов Max на этот объём, в пик', f"=B{OO['be_plan']}*B{OO['used']}/{R['plan_Max_cap']}",
            f"=C{OO['be_plan']}*C{OO['used']}/{R['plan_Max_cap']}", fmt=F_D1)
    ooo_row('max_off', '…вне пика', f"=B{OO['max_peak']}*{R['off_peak']}", f"=C{OO['max_peak']}*{R['off_peak']}", fmt=F_D1)
    row += 1

    section(ws, row, 'Выход в ноль на месяце «месяцев в минусе» + 1 при постоянном привлечении', 3); row += 1
    ooo_row('k', 'Коэффициент накопления k = (1 − (1 − отток)^(m + 1)) / отток',
            f"=(1-(1-{R['churn']})^({R['months_minus']}+1))/{R['churn']}", f"=(1-(1-{R['churn']})^({R['months_minus']}+1))/{R['churn']}", fmt=F_D3)
    ooo_row('per_month', 'Приводить в месяц, клиентов',
            f"=IF(B{OO['k']}*B{OO['contrib']}-{R['cac']}<=0,\"не окупается\",B{OO['fixed']}/(B{OO['k']}*B{OO['contrib']}-{R['cac']}))",
            f"=IF(C{OO['k']}*C{OO['contrib']}-{R['cac']}<=0,\"не окупается\",C{OO['fixed']}/(C{OO['k']}*C{OO['contrib']}-{R['cac']}))",
            fmt=F_D1, exp=(p_new['per_month'], p_old['per_month']), tol='0.2')
    ooo_row('clients_be', 'Клиентов к месяцу выхода в ноль', f"=IF(ISNUMBER(B{OO['per_month']}),B{OO['per_month']}*B{OO['k']},\"—\")",
            f"=IF(ISNUMBER(C{OO['per_month']}),C{OO['per_month']}*C{OO['k']},\"—\")", exp=(p_new['clients'], p_old['clients']), tol='1')
    minus = lambda c: (f"=IF(ISNUMBER({c}{OO['per_month']}),{c}{OO['contrib']}*{c}{OO['per_month']}/{R['churn']}*({R['months_minus']}-(1-{R['churn']})*(1-(1-{R['churn']})^{R['months_minus']})/{R['churn']})"
                       f"-{R['months_minus']}*{c}{OO['fixed']}-{R['months_minus']}*{c}{OO['per_month']}*{R['cac']},\"—\")")
    ooo_row('minus', 'Минус за месяцы в минусе, ₽', minus('B'), minus('C'), exp=(p_new['minus'], p_old['minus']), tol='300')
    ooo_row('ads', 'Реклама и онбординг в месяц, ₽', f"=IF(ISNUMBER(B{OO['per_month']}),B{OO['per_month']}*{R['cac']},\"—\")",
            f"=IF(ISNUMBER(C{OO['per_month']}),C{OO['per_month']}*{R['cac']},\"—\")", exp=(p_new['ads'], p_old['ads']), tol='100')
    ooo_row('dev', 'Разработка до запуска продаж, ₽', f"={R['dev_weeks']}/4.345*B{OO['fixed']}", f"={R['dev_weeks']}/4.345*C{OO['fixed']}",
            exp=(p_new['dev'], p_old['dev']), tol='10')
    ooo_row('need', 'Нужно денег до выхода в ноль, ₽', f"=IF(ISNUMBER(B{OO['minus']}),B{OO['dev']}-B{OO['minus']},\"—\")",
            f"=IF(ISNUMBER(C{OO['minus']}),C{OO['dev']}-C{OO['minus']},\"—\")", exp=(p_new['need'], p_old['need']), tol='300')
    note(ws, row, 'k — сколько клиенто-месяцев к месяцу выхода в ноль даёт один месяц привлечения; реклама списывается в том же месяце.'); row += 2

    section(ws, row, 'План на 12 месяцев после запуска продаж', 9); row += 1
    put(ws, row, 1, 'Сетка: 1 — новая, 2 — прежняя'); put(ws, row, 2, 1, fmt=F_INT, fill=FILL_KEY); sel = row; row += 1
    put(ws, row, 1, 'Свои новые клиенты в месяц (пусто — из расчёта выше)'); put(ws, row, 2, None); own = row
    ws.cell(row=row, column=2).fill = FILL_KEY; row += 1
    put(ws, row, 1, 'Новых клиентов в месяц в расчёте')
    put(ws, row, 2, f"=IF(ISBLANK(B{own}),IF(ISNUMBER(INDEX(B{OO['per_month']}:C{OO['per_month']},1,B{sel})),INDEX(B{OO['per_month']}:C{OO['per_month']},1,B{sel}),0),B{own})", fmt=F_D1)
    pace = row; row += 1
    put(ws, row, 1, 'Средний чек, ₽'); put(ws, row, 2, f"=INDEX(B{OO['arpu']}:C{OO['arpu']},1,B{sel})", fmt=F_INT); arpu_c = row; row += 1
    put(ws, row, 1, 'Вклад клиента, ₽'); put(ws, row, 2, f"=INDEX(B{OO['contrib']}:C{OO['contrib']},1,B{sel})", fmt=F_INT); contrib_c = row; row += 2
    header(ws, row, ['Месяц', 'Новые клиенты', 'Активные клиенты', 'Выручка, ₽', 'Переменные расходы и удержания, ₽', 'Постоянные расходы, ₽',
                     'Реклама и онбординг, ₽', 'Результат месяца, ₽', 'Накоплено, ₽'], 1); ws.row_dimensions[row].height = 42; row += 1
    months_ref = ooo_months(C.VAR_R, p_new['per_month'])
    first_m = row
    for m in range(1, 13):
        put(ws, row, 1, m, fmt=F_INT, color=BLACK)
        put(ws, row, 2, f"=$B${pace}", fmt=F_D1)
        put(ws, row, 3, f"={'0' if m == 1 else f'C{row - 1}'}*(1-{R['churn']})+B{row}", fmt=F_D1)
        put(ws, row, 4, f"=C{row}*$B${arpu_c}", fmt=F_INT)
        put(ws, row, 5, f"=C{row}*($B${arpu_c}-$B${contrib_c})", fmt=F_INT)
        put(ws, row, 6, f"={R['fixed']}", fmt=F_INT)
        put(ws, row, 7, f"=B{row}*{R['cac']}", fmt=F_INT)
        put(ws, row, 8, f"=D{row}-E{row}-F{row}-G{row}", fmt=F_INT)
        put(ws, row, 9, f"={'0' if m == 1 else f'I{row - 1}'}+H{row}", fmt=F_INT)
        _, active, result, total = months_ref[m - 1]
        check(ws, row, 3, active, '0.5', f'план, месяц {m}: активных')
        check(ws, row, 9, total, '500', f'план, месяц {m}: накоплено')
        row += 1
    note(ws, row, 'Отток из «Допущений»; реклама списывается в том же месяце; затраты до запуска (разработка) в план не входят.'); row += 1

    # ------------------------------------------------------------------------------------------
    # Чувствительность
    # ------------------------------------------------------------------------------------------
    ws = sheets['Чувствительность']
    S = 'Чувствительность'
    title(ws, 'Чувствительность новой сетки (НПД, модель на API)', 'Синие значения в заголовках — рычаги: множитель цены модели, доля кэша, курс, отток и CAC.')
    ws.column_dimensions['A'].width = 34
    for col in 'BCDEFGH':
        ws.column_dimensions[col].width = 18
    row = 4
    new_rows = TROWS['new']['rows']
    names = ['Старт', 'Бизнес', 'Агентство']

    def trow(i, col):
        return addr('Тарифы', col, new_rows[i])

    section(ws, row, 'Цена модели (ставки и K не пересчитаны): маржа «обычно / вся квота»', 8); row += 1
    header(ws, row, ['Множитель цены модели', 'Старт: обычно', 'Старт: вся квота', 'Бизнес: обычно', 'Бизнес: вся квота',
                     'Агентство: обычно', 'Агентство: вся квота', 'Средний клиент: обычно'], 1); ws.row_dimensions[row].height = 30; row += 1
    for mult in ['0.5', '1', '2', '5']:
        put(ws, row, 1, float(mult), fmt=F_X)
        for i in range(3):
            # вклад = чистыми − кредиты × (модель × множитель + вычисления) − сайты × бэкап
            typ = f"({trow(i, 11)}-{trow(i, 13)}*({R['base']}*$A{row}+{R['compute']})-{trow(i, 5)}*{R['backup_site']})/{trow(i, 3)}"
            full = f"({trow(i, 11)}-{trow(i, 4)}*({R['stress']}*$A{row}+{R['compute']})-{trow(i, 5)}*{R['backup_site']})/{trow(i, 3)}"
            put(ws, row, 2 + 2 * i, f"={typ}", fmt=F_PCT)
            put(ws, row, 3 + 2 * i, f"={full}", fmt=F_PCT)
        avg = "+".join(
            f"{trow(i, 2)}*({trow(i, 11)}-{trow(i, 13)}*({R['base']}*$A{row}+{R['compute']})-{trow(i, 5)}*{R['backup_site']})" for i in range(3))
        put(ws, row, 8, f"=({avg})/{R['arpu_new']}", fmt=F_PCT)
        m = D(mult)
        rr = C.tariff_rows(C.VAR_R, C.YK_NPD, C.NPD_TAX, model_typ=C.BASE_TYPICAL * m, model_full=C.STRESS * m)
        for i, r in enumerate(rr):
            check(ws, row, 2 + 2 * i, r['contrib_t'] / r['price'], '0.0005', f'×{mult} {r["name"]} обычно')
            check(ws, row, 3 + 2 * i, r['contrib_f'] / r['price'], '0.0005', f'×{mult} {r["name"]} вся квота')
        arpu, contrib, _ = C.avg_client(C.VAR_R, C.YK_NPD, C.NPD_TAX, model_typ=C.BASE_TYPICAL * m)
        check(ws, row, 8, contrib / arpu, '0.0005', f'×{mult} средний клиент')
        row += 1
    row += 1

    section(ws, row, 'Доля кэша: средняя задача смеси в кредитах и модель на кредит', 4); row += 1
    header(ws, row, ['Доля кэша', 'Списано на задачу, кредитов', 'Задач в кредитах «Старта»', 'Модель на кредит, ₽'], 1); row += 1
    for col, (cl, charged_r, model_r, api_r) in R['cache_cols'].items():
        put(ws, row, 1, f"='Себестоимость'!${cl}${cache_row}", fmt=F_PCT)
        put(ws, row, 2, f"='Себестоимость'!${cl}${charged_r}", fmt=F_D2)
        put(ws, row, 3, f"={trow(0, 4)}/B{row}", fmt=F_D1)
        put(ws, row, 4, f"='Себестоимость'!${cl}${model_r}", fmt=F_D2)
        row += 1
    row += 1

    section(ws, row, 'Курс доллара: вклад «обычно / вся квота», ₽ (ставки и K не пересчитаны)', 9); row += 1
    header(ws, row, ['Множитель курса', 'Курс, ₽/$', 'Кредит полной работы, ₽', 'Старт: обычно', 'Старт: вся квота',
                     'Бизнес: обычно', 'Бизнес: вся квота', 'Агентство: обычно', 'Агентство: вся квота'], 1)
    ws.row_dimensions[row].height = 30; row += 1
    for f in ['0.85', '1', '1.15']:
        put(ws, row, 1, float(f), fmt=F_X)
        put(ws, row, 2, f"={R['fx']}*A{row}", fmt=F_D2)
        put(ws, row, 3, f"={R['k_real']}*A{row}", fmt=F_D3)
        rr = C.tariff_rows(C.VAR_R, C.YK_NPD, C.NPD_TAX, model_typ=C.BASE_TYPICAL * D(f), model_full=C.STRESS * D(f))
        for i in range(3):
            typ = f"{trow(i, 11)}-{trow(i, 13)}*({R['base']}*$A{row}+{R['compute']})-{trow(i, 5)}*{R['backup_site']}"
            full = f"{trow(i, 11)}-{trow(i, 4)}*({R['stress']}*$A{row}+{R['compute']})-{trow(i, 5)}*{R['backup_site']}"
            put(ws, row, 4 + 2 * i, f"={typ}", fmt=F_INT)
            put(ws, row, 5 + 2 * i, f"={full}", fmt=F_INT)
            check(ws, row, 4 + 2 * i, rr[i]['contrib_t'], '0.5', f'курс ×{f} {rr[i]["name"]} обычно')
            check(ws, row, 5 + 2 * i, rr[i]['contrib_f'], '0.5', f'курс ×{f} {rr[i]["name"]} вся квота')
        row += 1
    note(ws, row, 'Курс меняет реальную цену модели при неизменных учётных ставках и K.'); row += 2

    section(ws, row, 'LTV / CAC среднего клиента новой сетки и окупаемость привлечения', 4); row += 1
    put(ws, row, 1, 'Отток (строки) и CAC, ₽ (столбцы)', bold=True)
    put(ws, row, 2, f"={R['cac_low']}", fmt=F_INT)
    put(ws, row, 3, f"={R['cac']}", fmt=F_INT)
    put(ws, row, 4, f"={R['cac_optin']}", fmt=F_INT)
    cac_row_ = row; row += 1
    for churn in ['0.03', '0.04', '0.07']:
        put(ws, row, 1, float(churn), fmt=F_PCT)
        for col, cac_ref in ((2, C.CAC_LOW), (3, C.CAC_BASE), (4, C.CAC_OPTIN)):
            cl = get_column_letter(col)
            put(ws, row, col, f"={R['contrib_new']}/$A{row}/{cl}${cac_row_}", fmt=F_D1)
            check(ws, row, col, C.avg_client(C.VAR_R, C.YK_NPD, C.NPD_TAX)[1] / D(churn) / cac_ref, '0.06', f'LTV/CAC отток {churn}')
        row += 1
    put(ws, row, 1, 'Окупаемость привлечения, мес')
    for col in (2, 3, 4):
        cl = get_column_letter(col)
        put(ws, row, col, f"={cl}${cac_row_}/{R['contrib_new']}", fmt=F_D1)
    row += 2

    section(ws, row, 'Модель у потолка НПД: API против плана', 4); row += 1
    put(ws, row, 1, 'Модель на API в месяц, ₽'); put(ws, row, 2, f"='НПД'!$B${NP['model_api']}", fmt=F_INT); row += 1
    for tier in C.PLAN:
        put(ws, row, 1, f'План {tier}: ₽ в месяц / загрузка недельной квоты в пик')
        put(ws, row, 2, f"={R[f'plan_{tier}_rub']}", fmt=F_INT)
        put(ws, row, 3, f"='НПД'!$B${NP['credits']}/{R[f'plan_{tier}_cap']}", fmt=F_PCT)
        row += 1

    # ------------------------------------------------------------------------------------------
    # Конкуренты
    # ------------------------------------------------------------------------------------------
    ws = sheets['Конкуренты']
    S = 'Конкуренты'
    title(ws, 'Конкуренты: 15 ближайших, лестница цены правки, сравнение с новой сеткой',
          'Цены — на 06.11.2026 (отчёт «Конкуренты и новые тарифы Радити», раздел 3); долларовые цены переведены по курсу листа «Допущения». «Не подтв.» — число из выдачи поиска или от сторонних сайтов.')
    widths = [30, 9, 11, 11, 13, 13, 34, 26, 40, 40, 10, 48]
    for i, w in enumerate(widths):
        ws.column_dimensions[get_column_letter(i + 1)].width = w
    row = 4
    header(ws, row, ['Конкурент', 'Валюта', 'Цена от', 'Цена до', '₽ от', '₽ до', 'Как продаёт', '₽ за небольшую правку',
                     'Что делает с существующим сайтом', 'Безопасность: предпросмотр, бэкап, отмена, выпуск', 'Оплата в ₽', 'Источник'], 1)
    ws.row_dimensions[row].height = 42
    row += 1
    COMP = [
        ('Атум, Москва', '₽', 15000, 15000, '15 000 ₽ за 3 ч; разовый час 5 000 ₽', 'до 5 000 (минимум 1 ч)', 'правят люди на хостинге клиента', 'SLA только на старших тарифах', 'да', 'https://a-tum.ru/soprovozhdeniya-sajta/wordpress/'),
        ('OpenStart, Петербург', '₽', 8700, 8700, '8 700 ₽ за 3 ч, час 2 900 ₽; часы сгорают', '1 450–2 900', 'люди', 'бэкап раз в месяц, реакция до 24 ч', 'да', 'https://openstart.ru/support'),
        ('Adict, Иркутск, Tilda', '₽', 6900, 6900, '6 900 ₽ за 3 ч', '1 150–2 500', 'люди', 'реакция до 8 ч', 'да', 'https://support.adict.ru/tilda'),
        ('FL.ru, готовые услуги', '₽', 2990, 5500, '5 500 ₽ за до 5 задач; 2 990 ₽ за одну', '1 100–2 990', 'фрилансер', 'нет', 'да', 'https://www.fl.ru/uslugi-freelancera/wordpress/'),
        ('Kwork', '₽', 500, 2000, 'кворк от 500 ₽', '500–2 000', 'фрилансер', 'только возврат денег', 'да', 'https://kwork.ru/categories/website-repair/dorabotka-sayta'),
        ('Агент Пастухова (не подтв.)', '₽', 4900, None, 'подписка 4 900 ₽ в месяц или лицензия 19 700 ₽; с OpenCode Go, моделью и VDS — 8 249–10 249 ₽', 'модель за счёт клиента', 'агент на сервере владельца, WordPress', 'проверка перед публикацией, бэкапы, откат, git (со слов автора)', 'да', 'https://pastukhov.com/agents/wordpress'),
        ('Битрикс24 «Сайты AI»', '₽', 2990, 3490, 'тариф 2 490 ₽ + BitrixGPT 500 ₽ по акции / 1 000 ₽', 'нет данных', 'только сайты внутри Битрикс24', 'отмена в редакторе, автопубликация по умолчанию', 'да', 'https://helpdesk.bitrix24.ru/open/28394292/'),
        ('Архитект АИ', '₽', 899, 5990, '10 / 50 / 50 / 100 правок за 899 / 1 599 / 3 990 / 5 990 ₽', '32–90', 'переносит сайт на свою платформу', 'не описано', 'да', 'https://arkhitekt.ru/'),
        ('Tilda + свой агент через MCP', '₽', 750, 1250, 'Tilda 750–1 250 ₽ + подписка на агента', '—', 'только сайты Tilda', 'ключи с ограниченными правами и сроком; бета', 'Tilda — да', 'https://workspace.ru/blog/tilda-poluchila-mcp-server-kak-ii-agenty-menyayut-seo-prodvizhenie-saytov/'),
        ('SiteGround AI Agent', '$', 1.99, 17.99, 'в хостинге: первый год / продление; 20 тыс. токенов в месяц на сайт', '16–25 (оценка SiteGround, не подтв.)', 'любой WordPress через плагин', 'подтверждение опасного, журнал, ревизии; отмены нет', 'нет', 'https://www.siteground.com/ai-agent-wordpress'),
        ('Hostinger Agent Plus', '$', 6.99, 9.99, '1 000 кредитов', 'нет данных', 'сайты Hostinger', 'бэкапы и staging в hPanel', 'нет', 'https://www.hostinger.com/support/hostinger-agents-pricing/'),
        ('GoWP', '$', 39, 99, 'за сайт: 15 AI-правок / 50 AI-правок и 5 правок людьми', '162–245', 'любой WordPress', 'ежедневные бэкапы, 90 дней', 'нет', 'https://www.gowp.com/pricing/'),
        ('WP Buffs Protect (не подтв.)', '$', 147, 179, 'безлимит мелких правок, за сайт', '—', 'люди 24/7', 'бэкапы 2 раза в день', 'нет', 'https://www.wpkube.com/coupons/wp-buffs-coupon/'),
        ('Elementor Angie / One', '$', 0, 15, '0 с дневным лимитом; One — $15 (не подтв.); 25 000 кредитов, действие — 1–40', 'нет данных', 'любой WordPress, нужен аккаунт Elementor', 'тестовая среда только для кода', 'нет', 'https://elementor.com/products/angie-ai-for-wordpress/'),
        ('Lovable Pro', '$', 25, 25, '100 кредитов', '10–25', 'только новые проекты', 'не описано', 'нет', 'https://docs.lovable.dev/introduction/subscription-plans'),
    ]
    CROW = {}
    for name, cur, lo, hi, how, edit, what, safety, rub, src in COMP:
        put(ws, row, 1, name)
        put(ws, row, 2, cur)
        put(ws, row, 3, lo, fmt=F_D2 if cur == '$' else F_INT)
        if hi is not None:
            put(ws, row, 4, hi, fmt=F_D2 if cur == '$' else F_INT)
        if name.startswith('Агент Пастухова'):
            # Полная стоимость (не подтв.): подписка + OpenCode Go $5 + модель 1–3 тыс. ₽ + VDS Timeweb от 1 940 ₽.
            put(ws, row, 4, f"=4900+5*{R['fx']}+3000+1940", fmt=F_INT)
            put(ws, row, 5, f"=4900+5*{R['fx']}+1000+1940", fmt=F_INT)
            put(ws, row, 6, f"=D{row}", fmt=F_INT)
            check(ws, row, 5, C.PASTUKHOV_LOW, '0.5', 'Пастухов, полная стоимость от')
        else:
            put(ws, row, 5, f'=IF(B{row}="$",C{row}*{R["fx"]},C{row})', fmt=F_INT)
            put(ws, row, 6, f'=IF(B{row}="$",D{row}*{R["fx"]},D{row})', fmt=F_INT)
        for i, v in enumerate([how, edit, what, safety, rub, src]):
            put(ws, row, 7 + i, v, wrap=True, color=GREY if i == 5 else BLACK)
        CROW[name] = row
        row += 1
    note(ws, row, 'У Пастухова «₽ от / до» — полная стоимость в месяц: подписка 4 900 ₽ + OpenCode Go $5 + модель 1–3 тыс. ₽ (слова автора) + VDS от 1 940 ₽.'); row += 2

    section(ws, row, 'Лестница цены одной небольшой правки, ₽', 4); row += 1
    header(ws, row, ['Кто', '₽ от', '₽ до', 'Как посчитано'], 1); row += 1
    fx = R['fx']
    new_start, new_agency = new_rows[0], new_rows[2]
    old_agency = TROWS['old']['rows'][2]
    ladder = [
        ('Mocha Bronze: простая правка, 5–15 кредитов', f"=5*0.0133*{fx}", f"=15*0.0133*{fx}", 'кредит ≈ $0,0133'),
        ('Lovable Pro: правка 0,5–1,2 кредита по $0,25', f"=0.125*{fx}", f"=0.3*{fx}", 'docs.lovable.dev'),
        ('Base44: сообщение $0,16–0,20', f"=0.16*{fx}", f"=0.2*{fx}", 'base44.com/pricing'),
        ('SiteGround: запись в блог 2–3 тыс. токенов по $10 за 100 тыс. (не подтв.)', f"=0.2*{fx}", f"=0.3*{fx}", 'оценка SiteGround; для агентных задач занижена'),
        ('Архитект АИ: правка в чате', "=1599/50", "=899/10", '«Профи» … «Старт»'),
        ('Радити, новая сетка: небольшая правка (5 кредитов)', f"='Тарифы'!$G${new_agency}", f"='Тарифы'!$G${TROWS['new']['pack']}", '«Агентство» … пакет'),
        ('Радити, новая сетка: обычное действие (7 кредитов)', f"='Тарифы'!$H${new_agency}", f"='Тарифы'!$H${TROWS['new']['pack']}", '«Агентство» … пакет'),
        ('Радити, прежняя сетка: небольшая правка', f"='Тарифы'!$G${old_agency}", f"='Тарифы'!$G${TROWS['old']['pack']}", '«Агентство» … пакет'),
        ('GoWP: AI-правка', f"=99/50*{fx}", f"=3*{fx}", 'Business … сверх квоты ($30 за 10)'),
        ('Kwork, Workzilla: задание', 500, 2000, ''),
        ('FL.ru: правка', 1100, 2990, 'пакет из 5 … одна'),
        ('FixRunner: 30 минут человека', f"=69/90*30*{fx}", f"=69/90*30*{fx}", '$69 за 90 мин'),
        ('Студия: 0,5–1 ч по 2 200–5 000 ₽', 1100, 5000, ''),
        ('Codeable: 1 ч $80–120 и сбор 17,5 %', f"=80*1.175*{fx}", f"=120*1.175*{fx}", ''),
    ]
    for label, lo, hi, how in ladder:
        put(ws, row, 1, label)
        put(ws, row, 2, lo, fmt=F_INT)
        put(ws, row, 3, hi, fmt=F_INT)
        note(ws, row, how, 4)
        if label.startswith('Радити, новая сетка: небольшая'):
            check(ws, row, 2, D('50'), '0.5', 'правка «Агентство»')
            check(ws, row, 3, D('74.5'), '0.01', 'правка из пакета')
        row += 1
    row += 1

    section(ws, row, 'Насколько новая сетка ниже ближайших конкурентов (₽ в месяц)', 5); row += 1
    header(ws, row, ['Сравнение', 'Радити, ₽', 'Конкурент, ₽', 'Радити относительно', 'Как сравнено'], 1); row += 1
    T_ = lambda i: f"='Тарифы'!$C${new_rows[i]}"
    per_site = lambda i: f"='Тарифы'!$C${new_rows[i]}/'Тарифы'!$E${new_rows[i]}"
    comparisons = [
        ('Старт — Битрикс24 «Сайты AI», Базовый + BitrixGPT по акции', T_(0), "=2490+500", 'за тариф'),
        ('Старт — Битрикс24 «Сайты AI», без акции', T_(0), "=2490+1000", 'за тариф'),
        ('Старт — GoWP Pro, $39 за сайт', T_(0), f"=39*{fx}", 'за тариф'),
        ('Старт — агент Пастухова, подписка (не подтв.)', T_(0), "=4900", 'за тариф'),
        ('Старт — агент Пастухова, полная стоимость (не подтв.)', T_(0), f"='Конкуренты'!$E${CROW['Агент Пастухова (не подтв.)']}", 'за тариф'),
        ('Старт — LS-Studio, 4 ч контента (цены 2023)', T_(0), "=4000", 'за тариф'),
        ('Старт — FL.ru, до 5 задач', T_(0), "=5500", 'за тариф'),
        ('Старт — Adict, 3 ч', T_(0), "=6900", 'за тариф'),
        ('Старт — OpenStart, 3 ч', T_(0), "=8700", 'за тариф'),
        ('Старт — Lovable Pro, $25 (новые проекты)', T_(0), f"=25*{fx}", 'за тариф'),
        ('Старт — SiteGround, продление $17,99 (хостинг + агент)', T_(0), f"=17.99*{fx}", 'за тариф'),
        ('Старт — Архитект АИ «Профи» (сайт переезжает)', T_(0), "=1599", 'за тариф'),
        ('Бизнес — GoWP Pro × 3 сайта', T_(1), f"=3*39*{fx}", 'за тариф'),
        ('Бизнес — Битрикс24 Стандартный + BitrixGPT по акции', T_(1), "=6990+1500", 'за тариф'),
        ('Бизнес — агент Пастухова, подписка (не подтв.)', T_(1), "=4900", 'за тариф'),
        ('Бизнес — агент Пастухова, полная стоимость (не подтв.)', T_(1), f"='Конкуренты'!$D${CROW['Агент Пастухова (не подтв.)']}", 'за тариф'),
        ('Бизнес — студия, медиана входа за 1 сайт', per_site(1), "=14900", 'за сайт'),
        ('Бизнес — Атум «Бизнес», 10 ч, до 3 сайтов', T_(1), "=40000", 'за тариф'),
        ('Агентство — GoWP white label $49 + 15 × $39', T_(2), f"=(49+15*39)*{fx}", 'за тариф'),
        ('Агентство — полставки удалённого контент-менеджера', T_(2), "=36000", 'за тариф'),
        ('Агентство — WP Buffs Protect за сайт (не подтв.)', per_site(2), f"=147*{fx}", 'за сайт'),
        ('Агентство — студия, медиана входа за сайт', per_site(2), "=14900", 'за сайт'),
        ('Агентство — Архитект АИ «Агентство», 15 сайтов', T_(2), "=5990", 'за тариф'),
    ]
    for label, ours, theirs, how in comparisons:
        put(ws, row, 1, label)
        put(ws, row, 2, ours, fmt=F_INT)
        put(ws, row, 3, theirs, fmt=F_INT)
        put(ws, row, 4, f"=B{row}/C{row}-1", fmt=F_PCT)
        note(ws, row, how, 5)
        row += 1
    note(ws, row, 'Студии — медиана входа по 15 студиям 14 900 ₽; полставки контент-менеджера — 72 000 ₽ на руки / 2 (Pawetta, 06.11.2026).'); row += 1

    # ------------------------------------------------------------------------------------------
    # Железо
    # ------------------------------------------------------------------------------------------
    ws = sheets['Железо']
    S = 'Железо'
    title(ws, 'Железо и модель на разных масштабах',
          'Песочницы ходов по минутам задач business.md; предпросмотры и облачный браузер здесь не масштабируются — их стоимость на действие на листе «Себестоимость».')
    ws.column_dimensions['A'].width = 40
    for col in 'BCDE':
        ws.column_dimensions[col].width = 15
    row = 3
    hw = {}
    for key, label, val, fmt in [('days', 'Рабочих дней в месяце с задачами', 22, F_INT), ('hours', 'Рабочих часов в день', 10, F_INT),
                                 ('peak', 'Пик к среднему', 3, F_D1), ('gvisor', 'Надбавка gVisor', 1.2, '0.00'),
                                 ('vm_cpu', 'ВМ песочниц: vCPU', 16, F_INT), ('vm_ram', 'ВМ песочниц: RAM, ГБ', 32, F_INT),
                                 ('ssd100', 'Доп. SSD на 100 клиентов, ГБ', 50, F_INT)]:
        put(ws, row, 1, label); put(ws, row, 2, val, fmt=fmt); hw[key] = f"$B${row}"; row += 1
    row += 1
    header(ws, row, ['Показатель', '100 клиентов', '300 клиентов', '1000 клиентов', '3000 клиентов'], 1); row += 1
    hr = {}
    mins_expr = '+'.join(f"{R[f'task_{k}_share']}*{R[f'task_{k}_min']}" for k, _, _ in TASK_KEYS)
    nr = TROWS['new']['rows']
    sites_work_avg = '+'.join(f"{addr('Допущения', 6, TAR['new'][i])}*{addr('Допущения', 7, TAR['new'][i])}" for i in range(3))
    lines = [
        ('clients', 'Клиентов', lambda c: None),
        ('tasks', 'Действий в месяц', lambda c: f"={c}{hr['clients']}*{R['actions_new']}"),
        ('sandboxes', 'Песочниц в пик', lambda c: f"={c}{hr['tasks']}*({mins_expr})/({hw['days']}*{hw['hours']}*60)*{hw['peak']}"),
        ('vms', 'ВМ песочниц', lambda c: f"=MAX(1,ROUNDUP(MAX({c}{hr['sandboxes']}*{R['sb_cpu']}*{hw['gvisor']}/{hw['vm_cpu']},{c}{hr['sandboxes']}*{R['sb_ram']}*{hw['gvisor']}/{hw['vm_ram']}),0))"),
        ('app', 'Узлов app и ci', lambda c: f"=1+INT({c}{hr['clients']}/1000)"),
        ('gitea', 'Узлов gitea', lambda c: f"=1+INT({c}{hr['clients']}/3000)"),
        ('cpu', 'vCPU всего', lambda c: f"=8*{c}{hr['app']}+4*{c}{hr['app']}+4*{c}{hr['gitea']}+2+{hw['vm_cpu']}*{c}{hr['vms']}"),
        ('ramtot', 'RAM всего, ГБ', lambda c: f"=16*{c}{hr['app']}+8*{c}{hr['app']}+8*{c}{hr['gitea']}+4+{hw['vm_ram']}*{c}{hr['vms']}"),
        ('compute', 'Вычисления, ₽ в месяц', lambda c: f"=({c}{hr['cpu']}*{R['vcpu']}+{c}{hr['ramtot']}*{R['ram']})*730"),
        ('disks', 'Диски, ₽ в месяц', lambda c: f"=({R['ssd']}+{hw['ssd100']}*{c}{hr['clients']}/100)*{R['ssd_price']}"),
        ('ip', 'IP, ₽ в месяц', lambda c: f"={R['ips']}*{R['ip_price']}*730"),
        ('s3', 'S3, ₽ в месяц', lambda c: f"={c}{hr['clients']}*({sites_work_avg})*{R['backup_gb']}*{R['s3']}"),
        ('hw', 'Железо итого, ₽ в месяц', lambda c: f"={c}{hr['compute']}+{c}{hr['disks']}+{c}{hr['ip']}+{c}{hr['s3']}"),
        ('hw_client', 'Железо на клиента, ₽', lambda c: f"={c}{hr['hw']}/{c}{hr['clients']}"),
        ('model', 'Модель на API, ₽ в месяц', lambda c: f"={c}{hr['clients']}*{R['used_new']}*{R['base']}"),
        ('model_client', 'Модель на API на клиента, ₽', lambda c: f"={c}{hr['model']}/{c}{hr['clients']}"),
        ('max_acc', 'Аккаунтов плана Max при работе в пик', lambda c: f"={c}{hr['clients']}*{R['used_new']}/{R['plan_Max_cap']}"),
    ]
    for key, label, f in lines:
        hr[key] = row
        put(ws, row, 1, label, bold=key in ('hw', 'model'))
        for i, n in enumerate([100, 300, 1000, 3000]):
            c = get_column_letter(2 + i)
            if key == 'clients':
                put(ws, row, 2 + i, n, fmt=F_INT)
            else:
                fmt = F_D1 if key in ('tasks', 'sandboxes', 'max_acc') else F_INT
                put(ws, row, 2 + i, f(c), fmt=fmt, bold=key in ('hw', 'model'))
        row += 1
    for i, v in enumerate([56600, 83000, 204200, 554700]):
        check(ws, hr['hw'], 2 + i, D(v), '60', f'железо {i}')
    note(ws, row, 'На каждую 1 000 клиентов — ещё узел app (8 vCPU / 16 ГБ) и раннер ci (4 / 8); gitea — ещё узел на 3 000 клиентов. '
                  'Модель на API — 181,3 кредита среднего клиента × база обычного использования.'); row += 1

    # Ширина и закрепление
    for ws in wb.worksheets:
        ws.sheet_view.zoomScale = 100
    sheets['Тарифы'].freeze_panes = 'B4'
    wb.calculation.fullCalcOnLoad = True
    wb.save(path)
    return CHECKS


def _only_link(formula: str) -> bool:
    """Формула — чистая ссылка на ячейку другого листа (зелёный цвет)."""
    body = formula[1:]
    return body.count('!') == 1 and all(ch not in body for ch in '+-*/(),&') and body.startswith("'")


def run_check(path: Path, checks) -> int:
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True)
    bad = 0
    for sheet, coord, expected, tol, what in checks:
        value = wb[sheet][coord].value
        if not isinstance(value, (int, float)):
            print(f'НЕТ ЗНАЧЕНИЯ {sheet}!{coord} ({what}): {value!r}')
            bad += 1
            continue
        diff = abs(D(str(value)) - expected)
        status = 'ok ' if diff <= tol else 'РАЗНИЦА'
        if diff > tol:
            bad += 1
        print(f'{status} {sheet}!{coord}: {what}: файл {value:,.4f}, calc.py {float(expected):,.4f}, допуск {tol}')
    errors = 0
    for ws in wb.worksheets:
        for row_ in ws.iter_rows():
            for cell in row_:
                if isinstance(cell.value, str) and cell.value.startswith('#'):
                    print(f'ОШИБКА ФОРМУЛЫ {ws.title}!{cell.coordinate}: {cell.value}')
                    errors += 1
    print(f'\nПроверок: {len(checks)}, расхождений: {bad}, ошибок формул: {errors}')
    return 1 if bad or errors else 0


def main(argv):
    if '--print' in argv:
        print_reference()
        return 0
    if '--check' in argv:
        target = Path(argv[argv.index('--check') + 1])
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            checks = build_workbook(Path(tmp) / 'scratch.xlsx')
        return run_check(target, checks)
    checks = build_workbook(OUT_PATH)
    print(f'Собрано: {OUT_PATH} ({len(checks)} проверочных ячеек)\n')
    print_reference()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
