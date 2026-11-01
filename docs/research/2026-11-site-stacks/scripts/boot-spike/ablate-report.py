import sys,re
for f,ref_admin in [('joomla','admin:in:200:rows=11:dash=200'),('modx',None),('opencart3',None)]:
    rows=[l.rstrip('\n').split('\t') for l in open(f'../abl/{f}.tsv',encoding='utf8')]
    base=next(l for l in open(f'../abl/{f}.tsv',encoding='utf8') if l.startswith('# base'))[7:].split()
    pages=[b for b in base if not b.startswith(('cli-user','admin:','login'))]
    groups={'front_fail':[], 'admin_fail':[], 'degraded':[], 'none':[], 'error':[]}
    detail={}
    for r in rows:
        if r[0].startswith('#'): continue
        t=r[0]
        if r[1]=='ERROR': groups['error'].append(t); detail[t]=r[2][:90]; continue
        res=r[2].split()
        front=res[:len(pages)]
        admin=res[len(pages):]
        codes=[x.split(':')[0] for x in front]; bcodes=[x.split(':')[0] for x in pages]
        lastisadmin = len(pages)-1
        ff=[i for i in range(lastisadmin) if codes[i]!=bcodes[i]]
        af = codes[lastisadmin]!=bcodes[lastisadmin] or (ref_admin and admin and admin[0]!=ref_admin)
        size=[abs(int(front[i].split(':')[1])-int(pages[i].split(':')[1]))>max(300,int(pages[i].split(':')[1])*0.03) for i in range(len(pages)) if front[i].split(':')[1].isdigit()]
        if ff: groups['front_fail'].append(t); detail[t]=' '.join(codes)+(' '+admin[0] if admin else '')
        elif af: groups['admin_fail'].append(t); detail[t]=' '.join(codes)+(' '+admin[0] if admin else '')
        elif any(size): groups['degraded'].append(t)
        else: groups['none'].append(t)
    print('==',f,{k:len(v) for k,v in groups.items()})
    for k in ['front_fail','admin_fail','error']:
        for t in groups[k]: print('  ',k,t,detail[t])
    print('   degraded:',' '.join(groups['degraded']))
    print('   none:',' '.join(groups['none']))
