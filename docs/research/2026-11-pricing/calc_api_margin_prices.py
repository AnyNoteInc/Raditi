# Цены тарифов 13.11.2026 при марже 10 % на API (docs/plan/72-pricing-api-margin.md): python3 -I calc_api_margin_prices.py
import importlib.util, io, contextlib
from decimal import Decimal as D, ROUND_HALF_UP, ROUND_CEILING
spec = importlib.util.spec_from_file_location('m', __import__('os').path.join(__import__('os').path.dirname(__file__), 'calc_api_margin.py'))
m = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(m)
NEW = [('Старт', 200, 1, D('1990')), ('Бизнес', 1000, 3, D('9990')), ('Агентство', 2000, 15, D('19990'))]
CUR = {'Старт': (D('1990'), 150), 'Бизнес': (D('6990'), 600), 'Агентство': (D('19990'), 2000)}
def price_for(n, sites, c): return (n * c + sites * m.BACKUP_PER_SITE) / (1 - m.DEDUCT - m.MARGIN)
print('Затраты на кредит:', {k: m.q(m.cost(s)[0], 3) for k, s in m.SCEN.items()})
print('\n| Тариф | Кредитов | Цена для 10 %: оптимистично / база / стресс | Предложение | ₽ за кредит | Маржа при всей квоте | 10 % держится до | 0 % при |')
print('|---|---|---|---|---|---|---|---|')
c_b, m_b = m.cost(m.SCEN['Базовый'])
for name, n, sites, offer in NEW:
    ps = [price_for(D(n), sites, m.cost(s)[0]) for s in m.SCEN.values()]
    mg = m.margin_at(offer, sites, D(n), c_b)
    fx10 = m.FX * (1 + (mg - m.MARGIN) * offer / n / m_b)
    fx0 = m.FX * (1 + mg * offer / n / m_b)
    cp, cn = CUR[name]
    print(f"| {name} | {cn} → {n} | {' / '.join(m.q(p, 0) for p in ps)} | {m.q(cp,0)} → {m.q(offer,0)} | {m.q(offer/n)} | {m.pc(mg)} | {m.q(fx10,1)} ₽/$ | {m.q(fx0,1)} ₽/$ |")
print('\nПакет 1 490 ₽ / 100: 14,90 ₽ за кредит —', ', '.join(f"{n}: на {m.pc(D('14.90')/(o/k) - 1, 0)} дороже" for n, k, _, o in NEW))
print('Окна недели плана 71 × 4,35:', 'Старт 55 → 239, Бизнес 210 → 914, Агентство 700 → 3 045 кредитов в месяц')
