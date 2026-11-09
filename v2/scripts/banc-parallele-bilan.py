#!/usr/bin/env python3
"""Bilan d'un lot de répétitions parallèles (banc-parallele.sh) : une ligne par répétition, puis les cumuls.
Usage : banc-parallele-bilan.py <dossier du lot>"""
import glob, json, os, statistics, sys

lot = sys.argv[1]
lignes = []
for w in sorted(glob.glob(os.path.join(lot, 'w*'))):
    res = glob.glob(os.path.join(w, 'runs', '*', '*', 'resultat.json'))
    if not res:
        print(f'{os.path.basename(w)} : pas de résultat ({open(os.path.join(w, "journal.log")).read().strip().splitlines()[-1:] if os.path.exists(os.path.join(w, "journal.log")) else "pas de journal"})')
        continue
    d = json.load(open(res[0])); j = d.get('jugement') or {}
    bras = list(d['etapes'].keys())
    duree = {b: sum(e['mesure'].get('duree_s', 0) for e in d['etapes'][b]) for b in bras}
    regs = {b: sum(len(e.get('regressions', {}).get('rouges', [])) + len(e.get('regressions', {}).get('disparus', [])) for e in d['etapes'][b]) for b in bras}
    echecs = {b: [e['mesure'].get('echec') for e in d['etapes'][b] if e['mesure'].get('echec')] for b in bras}
    sorties = {b: sum(s['verdict'] == 'oui' for s in (j.get('meca', {}).get(b, {}).get('sorties') or [])) for b in bras}
    incertains = {b: sum(s['verdict'] == 'incertain' for s in (j.get('meca', {}).get(b, {}).get('sorties') or [])) for b in bras}
    majeurs = {b: (j.get('defauts', {}).get(b) or {}).get('majeurs') for b in bras}
    lignes.append(dict(w=os.path.basename(w), duree=duree, regs=regs, echecs=echecs, sorties=sorties, incertains=incertains, majeurs=majeurs, prefere=j.get('prefere', 'non jugé'), ui=j.get('ui')))

if not lignes:
    sys.exit('aucun résultat')
bras = list(lignes[0]['duree'].keys())
print(f"{'rép.':5} " + ' | '.join(f'{b:>18}' for b in bras) + ' | préféré')
for l in lignes:
    cells = [f"{l['duree'][b]:5.0f} s {l['sorties'][b]:2d} sort. {l['majeurs'][b] if l['majeurs'][b] is not None else '–'} maj." for b in bras]
    print(f"{l['w']:5} " + ' | '.join(f'{c:>18}' for c in cells) + f" | {l['prefere']}" + (f"  échecs {l['echecs']}" if any(l['echecs'].values()) else ''))
print()
for b in bras:
    d = [l['duree'][b] for l in lignes]
    print(f"{b} : temps médian {statistics.median(d):.0f} s (min {min(d):.0f}, max {max(d):.0f}) ; sorties {sum(l['sorties'][b] for l in lignes)} (incertaines {sum(l['incertains'][b] for l in lignes)}) ; "
          f"majeurs {sum(l['majeurs'][b] or 0 for l in lignes)} ; régressions {sum(l['regs'][b] for l in lignes)} ; préféré {sum(l['prefere'] == b for l in lignes)}/{len(lignes)}")
print(f"indécis ou égal : {sum(l['prefere'] not in bras for l in lignes)}/{len(lignes)}")
