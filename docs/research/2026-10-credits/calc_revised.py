from decimal import Decimal as D, ROUND_HALF_UP, ROUND_FLOOR, getcontext
getcontext().prec = 40
def hu(x, q='1'): return D(x).quantize(D(q), rounding=ROUND_HALF_UP)
def fl(x): return D(x).quantize(D('1'), rounding=ROUND_FLOOR)

IN, CA, OUT = D(50), D(5), D(250)          # Sol, Codex credits per 1M (spec 1307)
C = D('4.65')                              # RUB per Codex credit, midpoint of 4.4-4.9
def cc(inp, out, rho=D('0.8')): return (inp*(1-rho)*IN + inp*rho*CA + out*OUT)/D(10**6)
types = {'small': (D(250000), D(5000)), 'block': (D(1200000), D(20000)), 'big': (D(2000000), D(40000))}
share = {'small': D('0.60'), 'block': D('0.32'), 'big': D('0.08')}
codex = {k: cc(*v) for k, v in types.items()}
acc = {k: v*C for k, v in codex.items()}
mix_done = sum(acc[k]*share[k] for k in acc)
print('accounting cost', {k: hu(v,'0.01') for k,v in acc.items()}, 'mix done', hu(mix_done,'0.0001'), 'with 25%', hu(mix_done*D('1.25'),'0.0001'))
tok_in = sum(types[k][0]*share[k] for k in types); tok_out = sum(types[k][1]*share[k] for k in types)
print('basket tokens done work: input', tok_in, 'new', tok_in*D('0.2'), 'cache', tok_in*D('0.8'), 'out', tok_out)
print('K exact = C_done/10 =', mix_done/10)
K = D('6.00'); FLOOR = 5
for c in (D('4.4'), D('4.9')):
    print('  K at c', c, hu(sum(codex[k]*share[k] for k in codex)*c/10,'0.0001'))
def charge(cost, k=K, floor=FLOOR): return max(D(floor), hu(cost/k))
raw = {k: v/K for k,v in acc.items()}
ch = {k: charge(v) for k,v in acc.items()}
ch25 = {k: charge(v*D('1.25')) for k,v in acc.items()}
mixc = sum(ch[k]*share[k] for k in ch); mixc25 = sum(ch25[k]*share[k] for k in ch25)
print('raw', {k: hu(v,'0.001') for k,v in raw.items()}, 'raw mix', hu(sum(raw[k]*share[k] for k in raw),'0.001'))
print('charged', ch, 'mix', mixc, '| with +25% inside', {k: hu(acc[k]*D('1.25')/K,'0.01') for k in acc}, ch25, 'mix', mixc25)
nofloor = sum(hu(raw[k])*share[k] for k in raw); print('mix without floor', nofloor, 'floor share %', hu((mixc-nofloor)/mixc*100,'0.1'), 'small surcharge %', hu((5-raw['small'])/raw['small']*100,'0.1'))
AVG = 11
plans = {'start': (D(4900), 300, 1, 30, 5), 'business': (D(12900), 800, 3, 80, 10), 'agency': (D(39900), 2500, 15, 250, 30)}
PACK = (D(1990), 100); GIFT = 35
print('--- price per credit and typical tasks')
for p,(price,cr,s,old,day) in plans.items():
    pc = price/cr
    print(p, hu(pc,'0.01'), [hu(pc*x) for x in (5, AVG, 17, 29)], 'tasks: small', cr/5, 'block', hu(D(cr)/17,'0.1'), 'big', hu(D(cr)/29,'0.1'), 'mix10.76', hu(D(cr)/mixc,'0.1'), 'mix12.68', hu(D(cr)/mixc25,'0.1'), 'avg11', hu(D(cr)/AVG,'0.1'))
pc = PACK[0]/PACK[1]; print('pack', pc, [hu(pc*x) for x in (5, AVG, 17, 29)], 'small', 100/5, 'block', hu(D(100)/17,'0.1'), 'big', hu(D(100)/29,'0.1'), 'mix', hu(D(100)/mixc,'0.1'), hu(D(100)/mixc25,'0.1'), 'avg11', hu(D(100)/AVG,'0.1'))
print('gift', GIFT, 'small', GIFT/5, 'block', hu(D(GIFT)/17,'0.01'), 'big', hu(D(GIFT)/29,'0.01'), 'mix', hu(D(GIFT)/mixc,'0.01'), hu(D(GIFT)/mixc25,'0.01'), 'acc cost', GIFT*K)
print('avg price start', hu(mixc*4900/300,'0.1'), 'today', hu(D(4900)/30,'0.1'), '%', hu((mixc/10-1)*100,'0.1'))
print('--- exposure (charged work at accounting cost)')
for p,(price,cr,s,old,day) in plans.items(): print(p, cr*K, hu(cr*K/price*100,'0.1'), 'today worst', old*285)
print('pack', 100*K, hu(100*K/1990*100,'0.1'), 'gift', GIFT*K)
PLAN = D('127.8')/D('75'); OVER = D('17.5'); COMM = D('0.035'); NPD = D('0.04')
def left(price, sites, n, cost): return price - n*(cost*PLAN + OVER) - 8*sites - price*COMM
print('--- margin table, plan money; (tasks, left, %, % after NPD 4%)')
def row(price, s, n, cost):
    l = left(price, s, n, cost); return (hu(n,'0.1'), hu(l), hu(l/price*100,'0.1'), hu((l-price*NPD)/price*100,'0.1'))
batch = acc['small']*3; chb = charge(batch); chb25 = charge(batch*D('1.25'))
print('batch of 3 small: cost', hu(batch,'0.01'), 'raw', hu(batch/K,'0.01'), 'charged', chb, 'with 25% inside', chb25)
for p,(price,cr,s,old,day) in plans.items():
    print(p)
    r = {}
    r['mix, no repeats'] = row(price,s,D(cr)/mixc, mix_done)
    r['mix, repeats inside the task, charged'] = row(price,s,D(cr)/mixc25, mix_done*D('1.25'))
    r['mix, repeats are failed attempts, free'] = row(price,s,D(cr)/mixc, mix_done*D('1.25'))
    r['small only, no repeats'] = row(price,s,D(cr)/5, acc['small'])
    r['small only, repeats free'] = row(price,s,D(cr)/5, acc['small']*D('1.25'))
    r['small batched x3, no repeats'] = row(price,s,D(cr)/chb, batch)
    r['small batched x3, repeats free'] = row(price,s,D(cr)/chb, batch*D('1.25'))
    r['block only, no repeats'] = row(price,s,D(cr)/17, acc['block'])
    r['block only, repeats free'] = row(price,s,D(cr)/17, acc['block']*D('1.25'))
    r['block only, repeats inside (21)'] = row(price,s,D(cr)/ch25['block'], acc['block']*D('1.25'))
    r['big only, no repeats'] = row(price,s,D(cr)/29, acc['big'])
    r['big only, repeats free'] = row(price,s,D(cr)/29, acc['big']*D('1.25'))
    r['big only, repeats inside (37)'] = row(price,s,D(cr)/ch25['big'], acc['big']*D('1.25'))
    t = price - old*D('145.3') - 8*s - price*COMM
    r['today: old quota x 145.3'] = (old, hu(t), hu(t/price*100,'0.1'), hu((t-price*NPD)/price*100,'0.1'))
    tb = left(price,s,D(old),acc['block']*D('1.25')); r['today, block only, repeats free'] = (old, hu(tb), hu(tb/price*100,'0.1'))
    for k,v in r.items(): print('   ', k, v)
# K = 7.50 runner-up rows
print('--- runner-up K=7.50 (5/14/24, mix 9.4)')
K75 = D('7.5'); ch75 = {k: max(D(5), hu(acc[k]/K75)) for k in acc}; mix75 = sum(ch75[k]*share[k] for k in ch75)
for p,(price,cr,s,old,day) in plans.items():
    print(p, 'mix free', row(price,s,D(cr)/mix75, mix_done*D('1.25')), 'block free', row(price,s,D(cr)/ch75['block'], acc['block']*D('1.25')), 'big free', row(price,s,D(cr)/ch75['big'], acc['big']*D('1.25')), 'exposure', cr*K75)
print('--- per-credit economics, worst reading (repeats free)')
for p,(price,cr,s,old,day) in plans.items():
    net = price/cr*(1-COMM); cost = K*PLAN*D('1.25')
    print(p, 'net per credit', hu(net,'0.01'), 'plan cost per raw credit', hu(cost,'0.01'), 'margin', hu(net-cost,'0.01'), '| K max for zero block-only:', hu((price*(1-COMM)-8*s)/( (D(cr)/ (acc['block'])) * (acc['block']*D('1.25')*PLAN+OVER)),'0.001'))
    for t in acc:
        rev = ch[t]*net; c1 = acc[t]*D('1.25')*PLAN+OVER; print('    ', t, 'p&l per task', hu(rev-c1,'0.1'))
print('breakeven small, credits:', hu((acc['small']*PLAN+OVER)/(D(4900)/300*(1-COMM)),'0.01'), hu((acc['small']*D('1.25')*PLAN+OVER)/(D(4900)/300*(1-COMM)),'0.01'), 'agency', hu((acc['small']*D('1.25')*PLAN+OVER)/(D(39900)/2500*(1-COMM)),'0.01'))
print('--- average use 12/40/150')
for (p,(price,cr,s,old,day)), n in zip(plans.items(), (12,40,150)):
    used = n*mixc; l = left(price,s,D(n),mix_done*D('1.25'))
    print(p, 'credits used', used, 'expire', cr-used, 'left', hu(l), hu(l/price*100,'0.1'), '| small only uses', n*5)
print('--- pack')
for k in acc:
    n = D(100)/ch[k]; print(k, hu(n,'0.01'), 'no rep', hu(D(1990)-n*(acc[k]*PLAN+OVER)-D(1990)*COMM), 'rep free', hu(D(1990)-n*(acc[k]*D('1.25')*PLAN+OVER)-D(1990)*COMM))
n = D(100)/mixc; print('mix', hu(n,'0.01'), hu(D(1990)-n*(mix_done*PLAN+OVER)-D(1990)*COMM), 'rep free', hu(D(1990)-n*(mix_done*D('1.25')*PLAN+OVER)-D(1990)*COMM))
print('--- gift plan money')
n = D(GIFT)/5; print('small', n, hu(n*(acc['small']*PLAN+OVER)), hu(n*(acc['small']*D('1.25')*PLAN+OVER)))
n = D(GIFT)/mixc; print('mix', hu(n,'0.01'), hu(n*(mix_done*PLAN+OVER)), hu(n*(mix_done*D('1.25')*PLAN+OVER)))
print('per paying customer at 30%:', hu(D(GIFT)/5*(acc['small']*PLAN+OVER)/D('0.3')), hu(D(GIFT)/mixc*(mix_done*D('1.25')*PLAN+OVER)/D('0.3')), 'of CAC 7633 %', hu(D(GIFT)/5*(acc['small']*PLAN+OVER)/D('0.3')/7633*100,'0.1'), hu(D(GIFT)/mixc*(mix_done*D('1.25')*PLAN+OVER)/D('0.3')/7633*100,'0.1'))
print('--- steps')
steps = {'light': 20, 'standard': 45, 'heavy': 120}
print({k: (v, v*K) for k,v in steps.items()}, 'ceilings 135/285/735 -> credits', [hu(D(x)/K,'0.01') for x in (135,285,735)])
print('K max so that step*K <= ceiling:', [hu(D(c)/v,'0.001') for c,v in zip((135,285,735),(20,45,120))], 'K max for 750 cap heavy', hu(D(750)/120,'0.001'), '% above', hu((D(750)/120/K-1)*100,'0.1'))
fc = (D(40000)*IN + D(32000)*OUT)/D(10**6); print('first call reserve codex', fc, 'rub', fc*D('4.4'), fc*C, fc*D('4.9'), 'credits', hu(fc*D('4.4')/K,'0.01'), hu(fc*C/K,'0.01'), hu(fc*D('4.9')/K,'0.01'))
for est in (100000, 200000, 400000):
    for rho in (D(0), D('0.8')):
        R = (D(est)*(rho*CA+(1-rho)*IN) + D(32000)*OUT)/D(10**6); print('R', est, 'rho', rho, R, 'rub', hu(R*C,'0.01'), 'credits', hu(R*C/K,'0.01'), 'above finish by rub', hu(R*C-fc*C,'0.01'), 'credits', hu((R*C-fc*C)/K,'0.01'))
print('admission stop in a whole standard step: spent >', [hu(270-x,'0.1') for x in (D('43.71'), D('60.45'))], 'credits', [hu((270-x)/K,'0.1') for x in (D('43.71'), D('60.45'))])
print('min reserve 5: budget', 5*K + fc*C, 'max est_in of first call at rho 0:', hu(((5*K + fc*C)/C - 8)/50*10**6))
print('overrun one 128k output call', hu((D(128000)-32000)*OUT/D(10**6)*D('4.4'),'0.1'), hu((D(128000)-32000)*OUT/D(10**6)*D('4.9'),'0.1'))
print('--- unpaid work bounds')
per_task = (45 + 120 + 120)*K; print('per task 3 attempts', per_task)
for p,(price,cr,s,old,day) in plans.items():
    print(p, 'day by rules (launch slots x heavy step)', day*120*K, '30 days', day*120*K*30, 'money bound unpaid', cr*K, 'total period bound', 2*cr*K, hu(2*cr*K/price*100,'0.1'), '% of price; plan money', hu(2*cr*K*PLAN), 'plus in flight')
TRIAL_UNPAID = 70
print('trial: gift charged', GIFT*K, 'unpaid bound', TRIAL_UNPAID*K, 'one attempt in flight', GIFT*K + fc*C, 'total', GIFT*K + TRIAL_UNPAID*K + GIFT*K + fc*C, 'plan money', hu((GIFT*K + TRIAL_UNPAID*K + GIFT*K + fc*C)*PLAN))
print('--- rates half/double with K following')
for f in (D('0.5'), D(1), D(2)):
    k = K*f
    print('f', f, 'K', k, {p: (v[1]*k, hu(v[1]*k/v[0]*100,'0.1')) for p,v in plans.items()}, 'pack', 100*k, hu(100*k/1990*100,'0.1'), 'gift', GIFT*k, 'steps', [x*k for x in (20,45,120)])
# double, cash follows: start mix
n = D(300)/mixc; l = D(4900) - n*(mix_done*D('1.25')*2*PLAN+OVER) - 8 - D(4900)*COMM; print('double, start mix repeats free left', hu(l), hu(l/4900*100,'0.1'))
n = D(150)/mixc; l = D(4900) - n*(mix_done*D('1.25')*2*PLAN+OVER) - 8 - D(4900)*COMM; print('double, start halved credits left', hu(l), hu(l/4900*100,'0.1'), 'tasks', hu(n,'0.1'))
print('--- K left at 6.00 while real cost half/double')
for f in (D('0.5'), D(1), D(2)):
    c2 = {t: charge(acc[t]*f) for t in acc}; m2 = sum(c2[t]*share[t] for t in c2)
    print('x', f, c2, 'mix', m2, 'start holds mix', fl(300/m2), 'small', fl(D(300)/c2['small']), 'block', fl(D(300)/c2['block']), 'big', fl(D(300)/c2['big']))
print('--- published table per 1M tokens in credits', IN*C/K, CA*C/K, OUT*C/K)
tbl = (hu(IN*C/K,'0.01'), hu(CA*C/K,'0.01'), hu(OUT*C/K,'0.01')); print('2 decimals', tbl)
for k,(inp,out) in types.items():
    v = inp*D('0.2')/10**6*tbl[0] + inp*D('0.8')/10**6*tbl[1] + out/10**6*tbl[2]; print('  ', k, 'by table', hu(v,'0.001'), '->', max(D(5),hu(v)), 'exact', hu(raw[k],'0.001'), ch[k])
print('--- calculator at 11 credits per task')
def rec(tasks):
    need = tasks*AVG; best=None
    for p,(price,cr,s,old,day) in plans.items():
        extra = max(0, need-cr); packs = -(-extra//100) if extra>0 else 0
        total = price + 1990*packs
        if best is None or total<best[1]: best=(p,total,packs)
    return best, hu(D(best[1])/tasks)
for t in (10,12,20,27,30,36,45,50,72,80,100): print('  ', t, rec(t))
print('--- stranded: blocks only', 300 % 17, hu(D(300 % 17)*4900/300), 'big only', 300 % 29, hu(D(300 % 29)*4900/300), 'below 5: 4 credits', hu(D(4)*4900/300))
print('--- declared price change example: K 6.00 -> 5.00: avg', hu(mixc*6/5,'0.1'), 'pack holds', hu(100/(mixc*6/5),'0.1'), 'was', hu(100/mixc,'0.1'), 'value lost rub', hu((1-D(5)/6)*1990))
ch5 = {t: max(D(5), hu(acc[t]/5)) for t in acc}; print('  charges at K=5', ch5, [hu(acc[t]/5,'0.01') for t in acc])
print('--- guard thresholds: K at 50% share', {p: (hu(v[0]/2/v[1],'0.001'), hu((v[0]/2/v[1]/K-1)*100,'0.1')) for p,v in plans.items()})
print('--- examples §1.5')
for name,cost in (('clarified block +25%', acc['block']*D('1.25')), ('297 rub', D(297)), ('74 rub of 12 reserved', D(74)), ('continued 45+12', D(342)), ('small x3', batch)):
    print('  ', name, hu(cost,'0.01'), hu(cost/K,'0.01'), charge(cost))
print('--- defect 3 example: tariff 40, pack 100; A small, B block')
print('  A reserve 45 = 40 tariff + 5 pack; B reserve 45 pack; A done 5 from tariff -> tariff 35; B done 17 from tariff free -> tariff 18, pack 100')
print('--- day share of month: start', 5*45, 'of 300; agency', 30*45, 'of 2500')
