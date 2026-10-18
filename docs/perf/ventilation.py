#!/usr/bin/env python3
"""Ventile les journaux de vague des fenêtres 05–11 et 12–18-10 (L240) : par sorte d'étape, effort, modèle, projet, charge de la machine,
heure, taille de diff, classe de lot, estimate et budget. Rejoue les tables de docs/perf/goulot-2026-10-18.md, sauf l'état de la classification
des passes (§ « Causes des passes » : `cadence perf --json` et `cadence corrections`).

    python3 -I docs/perf/ventilation.py <dossier des projets> [instant de gel]

<dossier des projets> porte `.cadence/runs` (le chemin `.../.cadence/runs` lui-même est accepté) et les dépôts des projets : le script lit le plan
de chacun (`docs/plan/raf.yaml`, ou le `plan.path` de son `cadence.yaml`) pour l'estimate des lots et les livrés, et lance `git diff --shortstat`
dans le dépôt de chaque journal. Lecture seule : ni journal ni plan ni dépôt n'est écrit. Dépend de PyYAML (paquet système python3-yaml).

L'instant de gel (ISO, UTC) écarte tout journal qui a une étape terminée après lui : la vague 2026-10-18-l240 (première étape à 06:54 UTC) tournait
encore pendant la mesure et ses journaux auraient changé les chiffres à chaque relance. Par défaut : FREEZE ci-dessous, juste avant elle ; la
fenêtre courante s'arrête donc le 18-10 à 08:50 (Paris) au lieu d'un jour entier.

Mêmes définitions que `cadence perf` (src/perf.ts) : un lot « rendu » est un journal `ready`, `handed-back` ou `failed`, daté par la fin de sa
dernière étape ; une durée de mur est celle d'une étape `ok` d'un journal rendu, rangée par le jour de sa fin ; les jetons d'un lot sont la somme
des `tokens.counted` de ses étapes ; la classe d'estimate d'un lot est l'estimate de son lot de plan, suivi de `+spec` s'il a une étape de la chaîne
spec. Les jours sont ceux d'Europe/Paris (UTC+2 sur toute la période). Tous les projets sont lus, maritime-atlas compris."""
import datetime as dt
import glob
import json
import os
import statistics as st
import subprocess
import sys
from collections import Counter, defaultdict

import yaml

FREEZE = '2026-10-18T06:50:00Z'
WIN = {'prev': ('2026-10-05', '2026-10-11'), 'cur': ('2026-10-12', '2026-10-18')}
CHAIN = {'spec', 'fiche', 'maquette', 'accept'}  # SPEC_CHAIN de src/perf.ts
KINDS = ('precheck', 'spec', 'maquette', 'fiche', 'accept', 'implement', 'review', 'review-small', 'ux', 'fix')
FINISHED = {'ready', 'handed-back', 'failed'}

folder = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')
if os.path.basename(folder) == 'runs' and os.path.basename(os.path.dirname(folder)) == '.cadence':
    folder = os.path.dirname(os.path.dirname(folder))
freeze = dt.datetime.fromisoformat((sys.argv[2] if len(sys.argv) > 2 else FREEZE).replace('Z', '+00:00'))


def instant(s):
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00')) if s else None


def day_of(t):
    return (t + dt.timedelta(hours=2)).date().isoformat()


def window(day):
    return next((w for w, (a, b) in WIN.items() if a <= day <= b), None)


def med(x):
    x = [v for v in x if v is not None]
    return round(st.median(x), 1) if x else None


def p90(v):
    v = sorted(v)
    return v[int(0.9 * (len(v) - 1))] if v else None


def k(v):
    return '   n/d' if v is None else f'{v / 1000:5.0f}k'


def pct(a, b):
    return '' if not a or b is None else f'{(b - a) / a * 100:+.0f} %'


# ---------------------------------------------------------------- plans (estimate des lots, livrés)
def read_plan(project):
    """{id: (estimate, statut, jour de fin)} ; None si le projet n'a pas de plan. Reprend src/plan.ts : estimate absent ou ≤ 0 → 1,
    `effort` S/M/L et états du plan d'un autre outil mappés par le `plan:` du cadence.yaml, une sous-tâche (parent) n'est pas un lot."""
    root = os.path.join(folder, project)
    try:
        conf = (yaml.safe_load(open(os.path.join(root, 'cadence.yaml'))) or {}).get('plan') or {}
    except OSError:
        conf = {}
    try:
        doc = yaml.safe_load(open(os.path.join(root, conf.get('path', 'docs/plan/raf.yaml'))))
    except OSError:
        return None
    f = conf.get('fields') or {}
    est_map = conf.get('estimates') or {}
    stat_map = {s: to for to, froms in (conf.get('statuses') or {}).items() for s in (froms if isinstance(froms, list) else [froms])}
    out = {}
    for e in doc.get(conf.get('lots', 'lots')) or []:
        parent = e.get(f.get('parent', 'parent'))
        if parent and str(e['id']).startswith(str(parent) + '/'):
            continue
        est = e.get(f.get('estimate', 'estimate'))
        est = est_map.get(est) if isinstance(est, str) else est
        est = est if isinstance(est, (int, float)) and est > 0 else 1
        status = e.get(f.get('status', 'status'))
        status = stat_map.get(status) if stat_map else status
        fin = f.get('finished', 'finished')
        fin = next((e[c] for c in (fin if isinstance(fin, list) else [fin]) if e.get(c)), None)
        out[str(e['id'])] = (est, status, str(fin)[:10] if fin else None)
    return out


plans = {}


def plan_of(project):
    if project not in plans:
        plans[project] = read_plan(project)
    return plans[project]


def plan_id(project, lot):
    """L'id du lot de plan d'un journal : l'id lui-même, à défaut le parent d'un id « <lot>/<sous-tâche> »."""
    p = plan_of(project)
    if p is None:
        return None
    return lot if lot in p else (lot.split('/')[0] if '/' in lot and lot.split('/')[0] in p else None)


# ---------------------------------------------------------------- journaux
lots = []  # journaux rendus
loads = []  # étapes terminées de tous les journaux, dans les fenêtres (charge de la machine)
walls = []  # étapes ok des journaux rendus, dans les fenêtres
journaled = set()  # lots de plan qui ont un journal, de n'importe quelle vague
for f in sorted(glob.glob(os.path.join(folder, '.cadence/runs/*/*--*.json'))):
    try:  # comme `cadence perf` : une vague sans wave.json lisible est écartée
        wave = json.load(open(os.path.join(os.path.dirname(f), 'wave.json')))
        created = instant(wave['created'])
    except (OSError, ValueError, KeyError, TypeError):
        continue
    d = json.load(open(f))
    steps = []
    ended = 0
    for s in d['steps']:
        a, b = instant(s.get('started')), instant(s.get('ended'))
        if not a or not b:
            continue
        ended += 1
        if b > freeze:
            continue
        t = s.get('tokens') or {}
        steps.append(dict(kind=s['kind'], model=s.get('model'), effort=s.get('effort'), status=s.get('status'), start=a, end=b, day=day_of(b),
                          dur=(b - a).total_seconds() / 60, counted=t.get('counted'), peak=s.get('peakContext'),
                          before=s.get('headBefore'), after=s.get('headAfter'), proj=d['project']))
    pid = plan_id(d['project'], d['lot'])
    if pid:
        journaled.add((d['project'], pid))
    loads += [s for s in steps if window(s['day'])]
    # un journal daté par la fin de sa dernière étape, à défaut par la création de sa vague (journal sans étape)
    if d['status'] not in FINISHED or len(steps) < ended or (not steps and (ended or created > freeze)):
        continue
    end = max((s['end'] for s in steps), default=created)
    L = dict(proj=d['project'], lot=d['lot'], budget=d.get('budget'), steps=steps, day=day_of(end), repo=d['repo'], start_sha=d.get('startedSha'))
    L['win'] = window(L['day'])
    counted = [s['counted'] for s in steps if s['counted'] is not None]
    L['tokens'] = sum(counted) if counted else None
    L['chain'] = any(s['kind'] in CHAIN for s in steps)
    L['fixes'] = sum(1 for s in steps if s['kind'] == 'fix')
    L['review_tokens'] = sum(s['counted'] or 0 for s in steps if s['kind'].startswith('review') or s['kind'] == 'ux')
    L['effort'] = any(s['effort'] for s in steps)
    L['estimate'] = plan_of(d['project'])[pid][0] if pid else None
    lots.append(L)
    if L['win']:
        walls += [s for s in steps if s['status'] == 'ok' and window(s['day'])]
lots_in = [L for L in lots if L['win']]
rendered = {w: [L for L in lots_in if L['win'] == w] for w in WIN}
for s in walls:
    s['win'] = window(s['day'])
    # effort : « sans effort » = étape d'avant L137 (09-10 12:56 UTC, orchestrate.effort) ; sinon l'ère est la fenêtre de l'étape
    s['era'] = 'sans effort' if not s['effort'] else f'effort {s["win"]}'
ERAS = ('sans effort', 'effort prev', 'effort cur')
projects = sorted({L['proj'] for L in lots_in})

print(f'dossier {folder}  gel {freeze:%Y-%m-%dT%H:%MZ}')
print(f'lots rendus : fenêtre précédente {len(rendered["prev"])}, courante {len(rendered["cur"])}')
print(f'étapes ok de ces lots : {sum(1 for s in walls if s["win"] == "prev")} puis {sum(1 for s in walls if s["win"] == "cur")} ; '
      f'étapes terminées de tous les journaux (charge) : {sum(1 for s in loads if window(s["day"]) == "prev")} puis {sum(1 for s in loads if window(s["day"]) == "cur")}')
DAYS = {'prev': 7.0, 'cur': min((freeze + dt.timedelta(hours=2) - dt.datetime(2026, 10, 12, tzinfo=dt.timezone.utc)).total_seconds() / 86400, 7.0)}
print(f'jours couverts : {DAYS["prev"]:g} puis {DAYS["cur"]:.2f} ; lots rendus par jour : ' + ' puis '.join(f'{len(rendered[w]) / DAYS[w]:.1f}' for w in WIN)
      + ' ; heures d\'étapes ok par jour : ' + ' puis '.join(f'{sum(s["dur"] for s in walls if s["win"] == w) / 60 / DAYS[w]:.1f}' for w in WIN))
print('lots rendus par projet (préc. puis cour.) :', ' · '.join(f'{p} {sum(1 for L in rendered["prev"] if L["proj"] == p)} → {sum(1 for L in rendered["cur"] if L["proj"] == p)}' for p in projects))


# ---------------------------------------------------------------- étapes
def cols(rows):
    return f'n={len(rows):3} dur={str(med([r["dur"] for r in rows])):>5} jetons={k(med([r["counted"] for r in rows]))} pointe={k(med([r["peak"] for r in rows]))}'


def compare(title, key, kinds, order=None):
    print(f'\n--- {title}')
    for kind in kinds:
        g = defaultdict(list)
        for r in walls:
            if r['kind'] == kind:
                g[(r['win'], key(r))].append(r)
        keys = sorted({kk[1] for kk in g}, key=order or str)
        if not keys:
            continue
        print(f'== {kind}')
        for kk in keys:
            p, c = g.get(('prev', kk), []), g.get(('cur', kk), [])
            dp, dc = med([r['dur'] for r in p]), med([r['dur'] for r in c])
            print(f'  {str(kk):20} préc {cols(p)} | cour {cols(c)}  {pct(dp, dc)}')


compare('A. durée de mur par sorte d\'étape (tous projets)', lambda r: 'tous', KINDS)
def eras(title, rows):
    print(f'\n--- {title}')
    for kind in ('implement', 'review', 'review-small', 'fix', 'ux', 'maquette'):
        cells, vals = [], {}
        for e in ERAS:
            x = [r for r in rows if r['kind'] == kind and r['era'] == e]
            vals[e] = (med([r['dur'] for r in x]), med([r['counted'] for r in x]), med([r['peak'] for r in x]))
            cells.append(f'{e:12} n={len(x):3} {str(vals[e][0]):>5} min {k(vals[e][1])} pointe {k(vals[e][2])}')
        eff = pct(vals['effort prev'][0], vals['effort cur'][0])
        tok = pct(vals['effort prev'][1], vals['effort cur'][1])
        gain = pct(vals['sans effort'][0], vals['effort prev'][0])
        print(f'  {kind:13}', ' | '.join(cells), f'| effort seul {gain or "n/a"} · dérive durée {eff or "n/a"} jetons {tok or "n/a"} pointe {pct(vals["effort prev"][2], vals["effort cur"][2]) or "n/a"}')


eras('B. par effort : sans effort (avant L137), effort dans la fenêtre précédente, effort dans la courante ; dérive à effort égal = courante / précédente avec effort', walls)
eras('B2. idem sans maritime-atlas', [r for r in walls if r['proj'] != 'maritime-atlas'])
compare('C. par modèle', lambda r: r['model'], ('implement', 'review', 'review-small', 'ux', 'maquette', 'fix'))
effort_only = [r for r in walls if r['effort']]
_walls = walls
walls = effort_only
compare('D. par projet, étapes avec effort seulement (à effort égal)', lambda r: r['proj'], ('implement', 'review', 'review-small', 'ux', 'fix'))
walls = _walls

# charge : étapes en cours (de tous les journaux) à l'instant où une étape démarre, la sienne comprise
intervals = [(s['start'], s['end']) for s in loads]
for s in walls:
    s['conc'] = sum(1 for a, b in intervals if a <= s['start'] < b)
print('\n--- E. charge : étapes qui démarrent avec au plus une autre étape en cours')
for kind in ('implement', 'review', 'review-small'):
    row = []
    for w in ('prev', 'cur'):
        x = [s for s in walls if s['kind'] == kind and s['win'] == w]
        row.append(f'{w} {sum(1 for s in x if s["conc"] <= 2)}/{len(x)}')
    print(f'  {kind:13}', ' | '.join(row))
print('  durée médiane selon la charge, fenêtre courante (au plus une autre étape | deux autres ou plus) :', ' ; '.join(
    f'{kind} {med([s["dur"] for s in walls if s["kind"] == kind and s["win"] == "cur" and s["conc"] <= 2])} min (n={sum(1 for s in walls if s["kind"] == kind and s["win"] == "cur" and s["conc"] <= 2)}) | '
    f'{med([s["dur"] for s in walls if s["kind"] == kind and s["win"] == "cur" and s["conc"] > 2])} min (n={sum(1 for s in walls if s["kind"] == kind and s["win"] == "cur" and s["conc"] > 2)})' for kind in ('implement', 'review', 'review-small')))
print('\n--- F. heure de Paris (tranches de 4 h)')
for kind in ('review-small', 'ux'):
    for h in range(0, 24, 4):
        row = []
        for w in ('prev', 'cur'):
            x = [s for s in walls if s['kind'] == kind and s['win'] == w and (s['start'].hour + 2) % 24 // 4 * 4 == h]
            row.append(f'{w} n={len(x):3} dur={med([s["dur"] for s in x])}')
        print(f'  {kind:13} {h:02d}h  ' + ' | '.join(row))

# ---------------------------------------------------------------- taille de diff
cache = {}


def diff(repo, a, b):
    """Lignes ajoutées + supprimées entre deux commits (git diff --shortstat) ; None si illisible. Les fichiers générés (plan, verrous) comptent."""
    if not a or not b:
        return None
    if a == b:
        return 0
    key = (repo, a, b)
    if key not in cache:
        r = subprocess.run(['git', '-C', repo, 'diff', '--shortstat', a, b], capture_output=True, text=True)
        cache[key] = None if r.returncode != 0 else sum(int(part.split()[0]) for part in r.stdout.split(',') if 'insert' in part or 'delet' in part)
    return cache[key]


for L in lots_in:
    for s in L['steps']:
        if s['kind'] == 'implement':
            s['lines'] = diff(L['repo'], s['before'], s['after'])
    last = next((s['after'] for s in reversed(L['steps']) if s['after']), None)
    L['lines'] = diff(L['repo'], L['start_sha'], last)
imp = [s for s in walls if s['kind'] == 'implement']
print('\n--- G. taille de diff de l\'étape implement (lignes ajoutées + supprimées, headBefore → headAfter)')
print(f'  lisible : {sum(1 for s in imp if s.get("lines") is not None)}/{len(imp)} étapes')
for label, key in (('tous', lambda s: 'tous'), ('effort', lambda s: s['era']), ('projet', lambda s: s['proj'])):
    for g in sorted({key(s) for s in imp}, key=lambda v: ERAS.index(v) if v in ERAS else str(v)):
        row = []
        for w in ('prev', 'cur'):
            x = [s for s in imp if s['win'] == w and key(s) == g and s.get('lines') is not None]
            big = [s for s in x if s['lines'] >= 100]
            row.append(f'{w} n={len(x):3} lignes méd={str(med([s["lines"] for s in x])):>6} p90={p90([s["lines"] for s in x])} dur={med([s["dur"] for s in x])} (≥100 l. : n={len(big)} dur={med([s["dur"] for s in big])})')
        print(f'  {str(g):16}', ' | '.join(row))
# L236 (auto-vérification en fin d'implement et de fix) est en service depuis le commit 1985595, le 17-10 à 14:08 (Paris) = 12:08 UTC
L236_SERVICE = dt.datetime(2026, 10, 17, 12, 8, tzinfo=dt.timezone.utc)
print('\n--- G2. implement et fix de la fenêtre courante avant et après la mise en service de L236 (17-10 12:08 UTC)')
for kind in ('implement', 'fix'):
    for label, x in (('avant', [s for s in walls if s['kind'] == kind and s['win'] == 'cur' and s['start'] < L236_SERVICE]),
                     ('après', [s for s in walls if s['kind'] == kind and s['win'] == 'cur' and s['start'] >= L236_SERVICE])):
        print(f'  {kind:9} {label}: n={len(x):3} dur={med([s["dur"] for s in x])} min jetons={k(med([s["counted"] for s in x]))} pointe={k(med([s["peak"] for s in x]))}'
              + (f' lignes méd={med([s["lines"] for s in x if s.get("lines") is not None])}' if kind == 'implement' else ''))

print('\n--- H. taille de diff du lot (startedSha → dernier headAfter), lots rendus')
for w in ('prev', 'cur'):
    x = [L for L in rendered[w] if L['lines'] is not None]
    print(f'  {w}: lisible {len(x)}/{len(rendered[w])} lignes méd={med([L["lines"] for L in x])} p90={p90([L["lines"] for L in x])} '
          f'total={sum(L["lines"] for L in x)} soit {sum(L["lines"] for L in x) / DAYS[w]:.0f} par jour')

# ---------------------------------------------------------------- lots
print('  lignes de diff des lots rendus par jour, par projet :', ' · '.join(
    f'{pr} {sum(L["lines"] or 0 for L in rendered["prev"] if L["proj"] == pr) / DAYS["prev"]:.0f} → {sum(L["lines"] or 0 for L in rendered["cur"] if L["proj"] == pr) / DAYS["cur"]:.0f}' for pr in projects))
print('\n--- I. lots rendus')
for w in ('prev', 'cur'):
    x = rendered[w]
    withb = [L for L in x if L['budget']]
    print(f'  {w}: lots={len(x)} jetons méd={k(med([L["tokens"] for L in x]))} étapes méd={med([len(L["steps"]) for L in x])} passes fix moy={sum(L["fixes"] for L in x) / len(x):.2f} '
          f'≥2 passes={sum(1 for L in x if L["fixes"] >= 2) / len(x) * 100:.0f} % revue={sum(L["review_tokens"] for L in x) / sum(L["tokens"] or 0 for L in x) * 100:.0f} % '
          f'sur budget={sum(1 for L in withb if (L["tokens"] or 0) <= L["budget"]) / len(withb) * 100:.0f} % (de {len(withb)})')
    for e in (False, True):
        y = [L for L in x if L['effort'] == e]
        if y:
            print(f'      {"avec" if e else "sans"} effort : lots={len(y)} jetons méd={k(med([L["tokens"] for L in y]))} fix moy={sum(L["fixes"] for L in y) / len(y):.2f}')

print('\n--- I2. temps de mur des étapes ok par lot (somme des durées) et heures d\'étapes de la fenêtre')
for w in ('prev', 'cur'):
    for label, keep in (('tous', lambda L: True), ('ordinaires', lambda L: not L['chain']), ('chaîne spec', lambda L: L['chain'])):
        x = [L for L in rendered[w] if keep(L) and L['steps']]
        walls_l = [sum(s['dur'] for s in L['steps'] if s['status'] == 'ok') for L in x]
        print(f'  {w} {label:12} lots={len(x):3} mur par lot méd={med(walls_l)} min moy={sum(walls_l) / len(x):.1f} min étapes méd={med([len(L["steps"]) for L in x])}')
    print(f'  {w} heures d\'étapes ok des lots rendus : {sum(s["dur"] for s in walls if s["win"] == w) / 60:.0f} h')

print('\n--- J. budget : lots avec effort ; jetons n, médiane, p90, dépassements')
for name, key in (('tous projets', lambda L: 'tous'), ('par projet (≥ 8 lots)', lambda L: L['proj'])):
    print(f' {name}')
    rows = defaultdict(lambda: {'prev': [], 'cur': []})
    for w in ('prev', 'cur'):
        for L in rendered[w]:
            if L['effort'] and L['tokens'] is not None and L['budget']:
                rows[(L['budget'], key(L))][w].append(L)
    for (b, g), v in sorted(rows.items(), key=lambda t: (t[0][0], str(t[0][1]))):
        if name != 'tous projets' and len(v['prev']) + len(v['cur']) < 8:
            continue
        def cell(x):
            return f'n={len(x):3} méd={k(med([L["tokens"] for L in x]))} p90={k(p90([L["tokens"] for L in x]))} max={k(max([L["tokens"] for L in x], default=None))} dép={sum(1 for L in x if L["tokens"] > b):2}'
        print(f'  {b / 1000:5.0f}k {str(g):15} préc {cell(v["prev"])} | cour {cell(v["cur"])}')

print('\n--- K. chaîne spec (une étape spec, fiche, maquette ou accept) : part des lots rendus et étapes ok')
for w in ('prev', 'cur'):
    c = Counter(s['kind'] for s in walls if s['win'] == w)
    print(f'  {w}: {sum(1 for L in rendered[w] if L["chain"])} lots sur {len(rendered[w])} ; ' + ' '.join(f'{kd} {c[kd]}' for kd in ('spec', 'maquette', 'fiche', 'accept', 'ux')))


# ---------------------------------------------------------------- estimate (plans)
def cls(L):
    return f'{L["estimate"]:g}' + ('+spec' if L['chain'] else '')


usable = {w: [L for L in rendered[w] if L['estimate'] is not None and L['tokens'] is not None] for w in WIN}
print('\n--- L. jetons par classe d\'estimate : médianes de `cadence perf` (lots rendus qui joignent un lot de plan)')
by = defaultdict(lambda: {'prev': [], 'cur': []})
for w in WIN:
    for L in usable[w]:
        by[cls(L)][w].append(L['tokens'])
for c in sorted(by, key=lambda c: (float(c.split('+')[0]), len(c))):
    p, q = by[c]['prev'], by[c]['cur']
    print(f'  estimate {c:9} préc n={len(p):3} {k(med(p))} | cour n={len(q):3} {k(med(q))}  {pct(med(p), med(q))}')
print(f'  lots rendus sans lot de plan : {sum(1 for L in lots_in if L["estimate"] is None)}')

def cls2(L):
    """Classe de lot pour cette ventilation : chaîne spec (comme perf), sinon revue UX sans chaîne, sinon ordinaire."""
    return 'chaîne spec' if L['chain'] else 'ux sans chaîne' if any(s['kind'] == 'ux' for s in L['steps']) else 'ordinaire'


print('\n--- M. estimate 0.5 et 1 : classe de lot (ordinaire, ux sans chaîne spec, chaîne spec) par budget puis par budget et projet ; n, médiane, p90, dép. = lots au-dessus de leur budget')
for est in (0.5, 1):
    for c in ('ordinaire', 'ux sans chaîne', 'chaîne spec'):
        for name, key in (('budget', lambda L: L['budget']), ('budget et projet', lambda L: (L['budget'], L['proj']))):
            g = defaultdict(lambda: {'prev': [], 'cur': []})
            for w in WIN:
                for L in usable[w]:
                    if L['estimate'] == est and cls2(L) == c:
                        g[key(L)][w].append(L)
            if not g:
                continue
            tot = {w: [L for v in g.values() for L in v[w]] for w in WIN}
            def cell(x):
                return f'n={len(x):3} méd={k(med([L["tokens"] for L in x]))} p90={k(p90([L["tokens"] for L in x]))} max={k(max((L["tokens"] for L in x), default=None))} dép={sum(1 for L in x if L["budget"] and L["tokens"] > L["budget"]):2}'
            if name == 'budget':
                print(f' == estimate {est:g}, {c} : toutes budgets  préc {cell(tot["prev"])} | cour {cell(tot["cur"])}')
            for kk, v in sorted(g.items(), key=lambda t: str(t[0])):
                print(f'   par {name:16} {str(kk):34} préc {cell(v["prev"])} | cour {cell(v["cur"])}')

print('\n--- M2. estimate 0.5 et 1, classe ordinaire (ni chaîne spec ni ux) avec et sans maritime-atlas ; diff = taille de diff du lot (H)')
for est in (0.5, 1):
    for label, keep in (('tous projets', lambda L: True), ('sans maritime-atlas', lambda L: L['proj'] != 'maritime-atlas'), ('maritime-atlas seul', lambda L: L['proj'] == 'maritime-atlas')):
        row = []
        for w in WIN:
            x = [L for L in usable[w] if L['estimate'] == est and cls2(L) == 'ordinaire' and keep(L)]
            row.append(f'{w} n={len(x):3} méd={k(med([L["tokens"] for L in x]))} p90={k(p90([L["tokens"] for L in x]))} max={k(max((L["tokens"] for L in x), default=None))} diff méd={med([L["lines"] for L in x])} l.')
        print(f'  estimate {est:g} {label:20}', ' | '.join(row))

def discover(parent, depth=2):
    """Les projets du dossier comme `cadence perf` (findProjects, src/lead.ts) : un dossier avec un plan, sur deux niveaux, sans descendre dans un projet."""
    found = []
    for e in sorted(os.listdir(parent)):
        d = os.path.join(parent, e)
        if e.startswith('.') or e == 'node_modules' or not os.path.isdir(d):
            continue
        name = os.path.relpath(d, folder)
        if plan_of(name) is not None:
            found.append(name)
        elif depth > 1:
            found += discover(d, depth - 1)
    return found


print('\n--- N. livrés : lots done du plan dont finished tombe dans la fenêtre, par estimate (entre parenthèses : avec au moins un journal de vague)')
seen = discover(folder)
copies = [p for p in seen if p.startswith('tmp/')]
print(f'  projets lus par cadence perf : {len(seen)} dont {len(copies)} copies de travail sous tmp/ ({", ".join(c[4:] for c in copies)})')
band = lambda lo, hi, x: sum(v for e, v in x.items() if lo < e <= hi)
for label, names in (('cadence perf (tous les projets lus)', seen), ('sans les copies de tmp/', [p for p in seen if p not in copies])):
    print(f' {label}')
    for w, (a, b) in WIN.items():
        c, j = Counter(), Counter()
        for proj in names:
            for lid, (est, status, fin) in plans[proj].items():
                if status == 'done' and fin and a <= fin <= b:
                    c[est] += 1
                    j[est] += (proj, lid) in journaled
        days = sum(e * v for e, v in c.items())
        print(f'  {w}: livrés={sum(c.values())} (journal {sum(j.values())}) soit {sum(c.values()) / DAYS[w]:.1f} par jour et {days:.0f} jours d\'estimate ; par estimate ≤0.25: {band(0, 0.25, c)} ({band(0, 0.25, j)}) · 0.5: {band(0.25, 0.5, c)} ({band(0.25, 0.5, j)}) · 0.75–1: {band(0.5, 1, c)} ({band(0.5, 1, j)}) · >1: {band(1, 99, c)} ({band(1, 99, j)})')
