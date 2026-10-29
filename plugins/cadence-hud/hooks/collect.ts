import type { LeadHold, Wave } from '../types'

/**
 * Le collecteur des vagues `cadence orchestrate`, exécuté par python3 -I : il lit le registre
 * `~/.cadence/orchestrate/waves/<pid>.json`, garde celles dont le processus vit, puis l'état de la vague
 * (`<cwd>/.cadence/runs/<vague>/wave.json`) et de ses lots (`<projet>--<lot>.json`). Pour chaque étape
 * en cours il compte les processus `claude` descendants de la session (sessions filles, équipes).
 * Sans vague vivante, il rend la dernière vague terminée du dossier courant (`live: false`, `ended` = date
 * de son wave.json) pour que la bande garde son statut sous les yeux ; elle la masque 30 min après sa fin (WAVE_LINGER_MS).
 * Il rend aussi, avec les vagues, les sessions du lead inscrites par `cadence lead hold` (`<home>/holds/*.json`, sans
 * filtrer l'échéance : la bande le fait à chaque dessin) et le plafond de sessions (CADENCE_MAX_SESSIONS, 2 par défaut).
 * Sortie : `{waves, holds, cap}`.
 */
export const COLLECTOR = `
import json, os, glob, datetime

home = os.environ.get('CADENCE_HOME') or os.path.join(os.path.expanduser('~'), '.cadence', 'orchestrate')

def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except Exception:
        return False

def children():
    tree = {}
    for d in os.listdir('/proc'):
        if not d.isdigit():
            continue
        try:
            with open('/proc/%s/stat' % d) as f:
                s = f.read()
            name = s[s.index('(') + 1:s.rindex(')')]
            ppid = int(s[s.rindex(')') + 2:].split()[1])
        except Exception:
            continue
        tree.setdefault(ppid, []).append((int(d), name))
    return tree

def claude_descendants(tree, pid):
    n, stack = 0, [pid]
    while stack:
        for cpid, name in tree.get(stack.pop(), []):
            if name.startswith('claude'):
                n += 1
            stack.append(cpid)
    return n

def load(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None

tree = None

def read_lots(d, live):
    global tree
    lots = []
    for lf in sorted(glob.glob(os.path.join(d, '*--*.json'))):
        l = load(lf)
        if l is None:
            continue
        steps = l.get('steps') or []
        running = [s for s in steps if s.get('status') == 'running']
        step = None
        if live and running:
            cur = running[-1]
            spid = int(cur.get('pid') or 0)
            if tree is None:
                tree = children()
            step = {
                'kind': cur.get('kind'), 'model': cur.get('model'), 'started': cur.get('started'),
                'pid': spid, 'alive': bool(spid) and alive(spid),
                'sub': claude_descendants(tree, spid) if spid else 0,
            }
        lots.append({
            'project': l.get('project'), 'lot': l.get('lot'), 'title': l.get('title') or '', 'status': l.get('status'),
            'pass': l.get('pass') or 0, 'model': l.get('model'), 'next': l.get('next'),
            'steps': len(steps), 'step': step, 'gate': l.get('gate') if live else None,
            'questions': l.get('questions') or [], 'outcome': l.get('outcome'), 'uxVerdict': l.get('uxVerdict'), 'visible': bool(l.get('visible')),
        })
    return lots

out = []
for f in sorted(glob.glob(os.path.join(home, 'waves', '*.json'))):
    r = load(f)
    if r is None:
        continue
    pid = int(r.get('pid') or 0)
    if not pid or not alive(pid):
        continue
    d = os.path.join(r['cwd'], '.cadence', 'runs', r['wave'])
    w = load(os.path.join(d, 'wave.json')) or {}
    out.append({
        'id': r['wave'], 'pid': pid, 'cwd': r['cwd'], 'cap': r.get('cap'), 'started': r.get('started'),
        'status': w.get('status'), 'budget': w.get('budget'), 'consumed': w.get('consumed'),
        'live': True, 'repos': len(r.get('repos') or []), 'lots': read_lots(d, True),
    })

if not out:
    cwd = os.getcwd()
    last, last_mtime = None, 0
    for wf in glob.glob(os.path.join(cwd, '.cadence', 'runs', '*', 'wave.json')):
        try:
            m = os.stat(wf).st_mtime
        except Exception:
            continue
        if m > last_mtime:
            last, last_mtime = wf, m
    if last:
        w = load(last) or {}
        d = os.path.dirname(last)
        ended = datetime.datetime.fromtimestamp(last_mtime, datetime.timezone.utc).isoformat()
        out.append({
            'id': w.get('id') or os.path.basename(d), 'pid': int(w.get('pid') or 0), 'cwd': cwd, 'cap': None,
            'started': w.get('created'), 'status': w.get('status'), 'budget': w.get('budget'),
            'consumed': w.get('consumed'), 'live': False, 'ended': ended, 'lots': read_lots(d, False),
        })
holds = []
for hf in sorted(glob.glob(os.path.join(home, 'holds', '*.json'))):
    h = load(hf)
    if isinstance(h, dict) and isinstance(h.get('label'), str) and isinstance(h.get('expires'), str):
        holds.append({'label': h['label'], 'since': str(h.get('since')), 'expires': h['expires']})

raw_cap = (os.environ.get('CADENCE_MAX_SESSIONS') or '').strip()
cap = int(raw_cap) if raw_cap.isdigit() and int(raw_cap) >= 1 else 2
print(json.dumps({'waves': out, 'holds': holds, 'cap': cap}))
`

/** Plafond de sessions quand le collecteur n'en donne pas de valide (le défaut de cadence). */
export const DEFAULT_CAP = 2

export type Collected = { waves: Wave[]; holds: LeadHold[]; cap: number }

/**
 * Lit la sortie du collecteur : `{waves, holds, cap}`, ou l'ancienne liste de vagues seule. Une sortie illisible
 * (JSON invalide) lève ; une forme étrange vaut aucune vague, aucune session du lead et le plafond par défaut.
 * Sans champ `live`, la vague est vivante.
 */
export const parseCollected = (stdout: string): Collected => {
  const raw: unknown = JSON.parse(stdout)
  const obj = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const list: unknown = Array.isArray(raw) ? raw : obj.waves
  const waves = (Array.isArray(list) ? list : [])
    .filter((w): w is Wave => typeof w === 'object' && w !== null && typeof (w as Wave).id === 'string')
    .map(w => ({ ...w, live: w.live !== false }))
  const holds = (Array.isArray(obj.holds) ? obj.holds : []).filter(
    (h): h is LeadHold => typeof h === 'object' && h !== null && typeof (h as LeadHold).label === 'string' && typeof (h as LeadHold).expires === 'string',
  )
  const cap = typeof obj.cap === 'number' && Number.isInteger(obj.cap) && obj.cap >= 1 ? obj.cap : DEFAULT_CAP
  return { waves, holds, cap }
}

/**
 * Publie le contexte de la session dans `~/.cadence/orchestrate/hud-context/<id de session>.json` (python3 -I,
 * argv[1] = le JSON, qui porte `session`, `cwd`, `percent`, `tokens`, `window`, `at`) : un fichier PAR session, pour
 * que `cadence session context` lise celle du dossier où il est lancé et non le chiffre d'une autre session ouverte.
 * La bande n'est qu'un rendu, la session lead lit ce chiffre avec `cadence session context`. Écriture atomique.
 * Le nom du fichier est celui de l'id nettoyé comme src/hud-context.ts (hudContextFile).
 */
export const CONTEXT_WRITER = `
import os, re, sys, json
home = os.environ.get('CADENCE_HOME') or os.path.join(os.path.expanduser('~'), '.cadence', 'orchestrate')
body = json.loads(sys.argv[1])
folder = os.path.join(home, 'hud-context')
os.makedirs(folder, exist_ok=True)
name = re.sub(r'[^A-Za-z0-9_-]', '_', str(body['session'])) + '.json'
tmp = os.path.join(folder, name + '.%d' % os.getpid())
with open(tmp, 'w') as f:
    f.write(sys.argv[1])
os.replace(tmp, os.path.join(folder, name))
`

/**
 * Dossier de lancement de la session (python3 -I, argv[1] = le dossier courant) : le plus proche ancêtre, lui-même compris,
 * dont le `cadence.yaml` porte une clé `priority:` (le dossier parent des projets) ; sans un tel dossier, le dossier courant.
 * Écrit le chemin seul sur la sortie standard.
 */
export const LAUNCH_FOLDER = `
import os, re, sys
start = os.path.abspath(sys.argv[1])
d = start
while True:
    try:
        with open(os.path.join(d, 'cadence.yaml')) as f:
            if re.search(r'^priority\\s*:', f.read(), re.M):
                start = d
                break
    except OSError:
        pass
    up = os.path.dirname(d)
    if up == d:
        break
    d = up
print(start)
`

/**
 * Les dates de modification des plans d'un dossier de projets (python3 -I, argv[1] = le dossier) : un `stat` par fichier de plan
 * (`.cadence/raf.yaml`, `cadence.yaml`) du dossier lui-même et de chacun de ses sous-dossiers directs.
 * Sortie : `{chemin: mtime en ns}`. Lancé à chaque minuteur de 5 s tant que le panneau des lots est ouvert (L401) : un plan modifié
 * relance la lecture sans attendre la minute. Un plan tenu par un autre outil (chemin donné par cadence.yaml) n'est surveillé que par son cadence.yaml.
 */
export const PLAN_STAMPS = `
import os, sys, json
folder = sys.argv[1]
stamps = {}
try:
    names = sorted(n for n in os.listdir(folder) if not n.startswith('.') and n not in ('node_modules', 'tmp'))
except OSError:
    names = []
for d in [folder] + [os.path.join(folder, n) for n in names]:
    for rel in ('.cadence/raf.yaml', 'cadence.yaml'):
        path = os.path.join(d, rel)
        try:
            stamps[path] = os.stat(path).st_mtime_ns
        except OSError:
            pass
print(json.dumps(stamps))
`

/**
 * Les livraisons en échec d'un dossier de projets (python3 -I, argv[1] = le dossier, L412) : pour le dossier lui-même et chacun de ses sous-dossiers directs
 * qui est un dépôt git (`.git` dossier ; un worktree ou un sous-module, dont `.git` est un fichier, est ignoré), la dernière ligne de
 * `.git/cadence/deliveries-failed.log` quand ce journal a été écrit après `deliveries.log` (ou que celui-ci n'existe pas) : une livraison verte
 * qui suit l'échec l'efface. Le jour ne suffit pas à ordonner deux écritures du même jour, la date de modification des fichiers le fait.
 * Sortie : `[{project, day, sha, reason}]`, la raison sans sa classe `[ci]` ni la sortie de la commande en échec qui suit la raison. Lecture seule.
 */
export const DELIVERIES = `
import os, sys, json, re
folder = os.path.abspath(sys.argv[1])
try:
    names = sorted(n for n in os.listdir(folder) if not n.startswith('.') and n not in ('node_modules', 'tmp'))
except OSError:
    names = []
out = []
for d in [folder] + [os.path.join(folder, n) for n in names]:
    log = os.path.join(d, '.git', 'cadence')
    failed, green = os.path.join(log, 'deliveries-failed.log'), os.path.join(log, 'deliveries.log')
    try:
        mtime = os.stat(failed).st_mtime_ns
        with open(failed, encoding='utf-8') as fh:
            lines = [l for l in fh.read().split('\\n') if l.strip()]
    except OSError:
        continue
    try:
        if os.stat(green).st_mtime_ns >= mtime:
            continue
    except OSError:
        pass
    if not lines:
        continue
    m = re.match(r'^(\\S+) (\\S+) (?:\\[\\w+\\] ?)?(.*)$', lines[-1].split(' \u23ce ')[0])
    if m:
        out.append({'project': os.path.basename(d), 'day': m.group(1), 'sha': m.group(2), 'reason': m.group(3)})
print(json.dumps(out))
`
