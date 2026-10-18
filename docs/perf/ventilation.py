#!/usr/bin/env python3
"""Ventile les journaux de vague (<dossier>/.cadence/runs) des fenêtres 05–11 et 12–18-10 par étape, modèle, effort, projet,
heure et classe de lot (L240) : python3 docs/perf/ventilation.py ~/projects/developpeur/.cadence/runs
Lecture seule. Les jours sont ceux d'Europe/Paris en octobre (UTC+2) ; « effort » absent = journal d'avant L137 (09-10 12:58 UTC)."""
import os, sys
os.chdir(sys.argv[1])
import json,glob,statistics as st,collections,datetime as dt
rows=[]
for f in glob.glob('20*/*--L*.json'):
    d=json.load(open(f))
    for s in d['steps']:
        if not s.get('ended') or not s.get('started'):continue
        a=dt.datetime.fromisoformat(s['started'].replace('Z','+00:00'));b=dt.datetime.fromisoformat(s['ended'].replace('Z','+00:00'))
        day=(b+dt.timedelta(hours=2)).date().isoformat()
        win='cur' if '2026-10-12'<=day<='2026-10-18' else 'prev' if '2026-10-05'<=day<='2026-10-11' else None
        if not win:continue
        t=s.get('tokens') or {}
        rows.append(dict(win=win,kind=s['kind'],model=s.get('model'),effort=s.get('effort'),dur=(b-a).total_seconds()/60,counted=t.get('counted'),out=t.get('output'),cr=t.get('cacheRead'),peak=s.get('peakContext'),proj=d['project'],lot=d['lot'],start=a,end=b,small=d.get('small'),vis=d.get('visible'),n=s['n'],wave=f.split('/')[0]))
print(len(rows))
def med(x):
    x=[v for v in x if v is not None];return round(st.median(x),1) if x else None
def tab(key,kinds=('implement','review','review-small','ux','maquette','fix')):
    for k in kinds:
        print('==',k)
        g=collections.defaultdict(list)
        for r in rows:
            if r['kind']==k:g[(r['win'],key(r))].append(r)
        ks=sorted({kk[1] for kk in g},key=str)
        for kk in ks:
            p=g.get(('prev',kk),[]);c=g.get(('cur',kk),[])
            print(f'  {str(kk):28} prev n={len(p):3} dur={med([r["dur"] for r in p])} cnt={med([r["counted"] for r in p])} peak={med([r["peak"] for r in p])} | cur n={len(c):3} dur={med([r["dur"] for r in c])} cnt={med([r["counted"] for r in c])} peak={med([r["peak"] for r in c])}')
print('--- model');tab(lambda r:r['model'])
print('--- effort');tab(lambda r:r['effort'])
print('--- project');tab(lambda r:r['proj'],('implement','review-small','ux'))
print('--- N concurrent steps at start')
ev=[(r['start'],r['end']) for r in rows]
def conc(r):
    n=sum(1 for a,b in ev if a<=r['start']<b);return min(n//3*3,15)
tab(conc,('implement','review','review-small','ux'))
print('--- hour');tab(lambda r:(r['start'].hour+2)//4*4%24,('review-small','ux'))
print('=========== PART 2')
eff=[r['end'] for r in rows if r['effort']]
print('first effort row',min(eff),'n None by day:')
c=collections.Counter((r['end']+dt.timedelta(hours=2)).date().isoformat() for r in rows if not r['effort'] and r['kind'] in('implement','review'))
print(sorted(c.items()))
c=collections.Counter((r['end']+dt.timedelta(hours=2)).date().isoformat() for r in rows if r['effort'] and r['kind'] in('implement','review'))
print(sorted(c.items()))
print('=========== PART 3 like-for-like')
for r in rows:
    r['day']=(r['end']+dt.timedelta(hours=2)).date().isoformat()
    r['era']='prev-no-effort' if r['day']<'2026-10-09' or (r['win']=='prev' and not r['effort']) else 'prev-effort' if r['win']=='prev' else 'cur'
for k in ('implement','review','review-small','fix','ux','maquette','accept','spec'):
    out=[]
    for e in ('prev-no-effort','prev-effort','cur'):
        x=[r for r in rows if r['kind']==k and r['era']==e]
        out.append(f'{e}: n={len(x)} dur={med([r["dur"] for r in x])} cnt={med([r["counted"] for r in x])}')
    print(k,' | '.join(out))
# lot-level
lots=collections.defaultdict(lambda:dict(cnt=0,steps=0,fixes=0,end=None,win=None,eff=False,budget=None,rev=0))
import glob
for f in glob.glob('20*/*--L*.json'):
    d=json.load(open(f))
    key=f
    L=lots[key]
    L['budget']=d.get('budget');L['proj']=d['project'];L['small']=d.get('small')
    for s in d['steps']:
        if not s.get('ended'):continue
        L['cnt']+=(s.get('tokens') or {}).get('counted') or 0;L['steps']+=1
        if s['kind']=='fix':L['fixes']+=1
        if s['kind'].startswith('review') or s['kind']=='ux':L['rev']+=(s.get('tokens') or {}).get('counted') or 0
        L['end']=s['ended']
        if s.get('effort'):L['eff']=True
for L in lots.values():
    if L['end']:
        day=(dt.datetime.fromisoformat(L['end'].replace('Z','+00:00'))+dt.timedelta(hours=2)).date().isoformat()
        L['day']=day;L['win']='cur' if '2026-10-12'<=day<='2026-10-18' else 'prev' if '2026-10-05'<=day<='2026-10-11' else None
for w in ('prev','cur'):
  for b in (None,):
    x=[L for L in lots.values() if L.get('win')==w]
    print(w,'lots',len(x),'median tokens',med([L['cnt'] for L in x]),'steps',med([L['steps'] for L in x]),'fixes mean',round(sum(L['fixes'] for L in x)/len(x),2),'review share',round(sum(L['rev'] for L in x)/sum(L['cnt'] for L in x),2))
  for e in (False,True):
    x=[L for L in lots.values() if L.get('win')==w and L['eff']==e]
    if x:print('  effort',e,len(x),med([L['cnt'] for L in x]),'fixes mean',round(sum(L['fixes'] for L in x)/len(x),2))
  # by budget
  g=collections.defaultdict(list)
  for L in lots.values():
    if L.get('win')==w and L['eff']:g[L['budget']].append(L['cnt'])
  print('  by budget(effort only)',{b:(len(v),med(v)) for b,v in sorted(g.items(),key=str)})
print('=========== PART 4 p90 vs budget')
def p90(v):
    v=sorted(v);return v[int(0.9*(len(v)-1))] if v else None
for w in ('prev','cur'):
    g=collections.defaultdict(list)
    for L in lots.values():
        if L.get('win')==w and L['eff']:g[L['budget']].append(L['cnt'])
    print(w,{b:(len(v),med(v),p90(v),sum(1 for x in v if x>b)) for b,v in sorted(g.items(),key=lambda t:str(t[0]))})
# kinds of steps per lot class
kc=collections.Counter()
for r in rows:
    if r['kind'] in('spec','fiche','maquette','accept'):kc[(r['win'],r['kind'])]+=1
print(sorted(kc.items()))
print('lots with spec chain share:')
sp=collections.defaultdict(set);al=collections.defaultdict(set)
for r in rows:
    al[r['win']].add((r['wave'],r['proj'],r['lot']))
    if r['kind'] in('spec','fiche','maquette','accept'):sp[r['win']].add((r['wave'],r['proj'],r['lot']))
print({w:(len(sp[w]),len(al[w])) for w in al})
# ux detail: warhammer vs ol and peak, turns?
