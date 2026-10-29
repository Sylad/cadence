import type { LeadHold, Wave } from '../types'

/**
 * Le collecteur des vagues `cadence orchestrate`, exécuté par python3 -I : il lit le registre
 * `~/.cadence/orchestrate/waves/<pid>.json`, garde celles dont le processus vit, puis l'état de la vague
 * (`<cwd>/.cadence/runs/<vague>/wave.json`) et de ses lots (`<projet>--<lot>.json`). Pour chaque étape
 * en cours il compte les processus `claude` descendants de la session (sessions filles, équipes).
 * Sans vague vivante, il rend la dernière vague terminée du dossier courant (`live: false`, `ended` = date
 * de son wave.json) pour que la bande garde son statut sous les yeux ; elle la masque 30 min après sa fin (WAVE_LINGER_MS).
 * Les vagues terminées du dossier sont rendues à part dans `ended` (liste, vide sans vague finie), qu'une vague vive ou non : toutes celles dont l'id
 * n'est pas vivant (le wave.json d'une vague vivante est toujours le plus récent, orchestrate y réécrit `consumed` ; il ne compte pas), de la plus
 * récente à la plus ancienne par la date de leur wave.json, bornées aux ENDED_DAYS derniers jours (un garde-fou de ENDED_GUARD vagues protège le coût du collecteur, très au-dessus du rythme mesuré, sans être une règle ; le coût :
 * un wave.json et ses états de lots par vague, toutes les 5 s) ; les décisions en attente du panneau des lots (L412 : questions, lots rendus, verdicts UX)
 * les lisent par là, sans toucher à ce que la bande dessine — avant, seule la dernière finie était lue, et toute vague qui finissait dans le dossier
 * effaçait les questions et les lots rendus non tranchés des vagues d'avant. Chaque état de lot porte `repo` (le chemin absolu du dépôt du lot) et
 * chaque vague `cwd` (son dossier de lancement) : les commandes à copier du panneau commencent par `cd` là.
 * Il rend aussi, avec les vagues, les sessions du lead inscrites par `cadence lead hold` (`<home>/holds/*.json`, sans
 * filtrer l'échéance : la bande le fait à chaque dessin) et le plafond de sessions (CADENCE_MAX_SESSIONS, 2 par défaut).
 * Chaque lot porte `trail`, la liste de ses pas (genre, statut, début, fin ; L413) d'où la frise du panneau des lots tire ses étapes.
 * Chaque lot porte aussi ce que le panneau lit de sa dépense (L414) : `budget`, `escalationReserve`, `estimate`, `escalated`, `spec`, les tokens comptés par ses étapes (`consumed`), le début de sa première étape (`since`) ; la durée écoulée court jusqu'à maintenant (le panneau n'en lit pas la fin).
 * Sortie : `{waves, holds, cap, ended}`.
 */
export const COLLECTOR = `
import json, os, glob, datetime, time

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

# copie de SPEC_CHAIN de src/perf.ts (la classe « +spec » de cadence perf) ; test/hud-classe-l414.test.ts les relie
SPEC_CHAIN = ('spec', 'fiche', 'maquette', 'accept')

def counted_of(step):
    tokens = step.get('tokens')
    n = tokens.get('counted') if isinstance(tokens, dict) else 0
    return n if isinstance(n, (int, float)) and not isinstance(n, bool) else 0

def number(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None

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
        # les pas du lot (L413) : la frise du panneau des lots en tire ses étapes, leurs durées et leurs passes
        trail = [
            dict((k, s[k]) for k in ('kind', 'status', 'started', 'ended') if isinstance(s.get(k), str))
            for s in steps if isinstance(s, dict) and isinstance(s.get('kind'), str) and isinstance(s.get('started'), str)
        ]
        starts = [x['started'] for x in steps if isinstance(x.get('started'), str)]
        lots.append({
            'budget': number(l.get('budget')), 'escalationReserve': number(l.get('escalationReserve')), 'estimate': number(l.get('estimate')),
            'escalated': bool(l.get('escalation')), 'spec': any(x.get('kind') in SPEC_CHAIN for x in steps),
            'consumed': sum(counted_of(x) for x in steps), 'since': min(starts) if starts else None,
            'project': l.get('project'), 'repo': l.get('repo'), 'lot': l.get('lot'), 'title': l.get('title') or '', 'status': l.get('status'),
            'pass': l.get('pass') or 0, 'model': l.get('model'), 'next': l.get('next'),
            'steps': len(steps), 'trail': trail, 'step': step, 'gate': l.get('gate') if live else None,
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

cwd = os.getcwd()
live_ids = set(w['id'] for w in out)
# la règle est la seule borne de 7 jours ; ENDED_GUARD n'est qu'un garde-fou de coût, très au-dessus du rythme mesuré (162 vagues en 7 jours)
ENDED_DAYS, ENDED_GUARD = 7, 500
finished = []
for wf in glob.glob(os.path.join(cwd, '.cadence', 'runs', '*', 'wave.json')):
    # le wave.json d'une vague vivante est toujours le plus récent du dossier (orchestrate y réécrit consumed en continu) :
    # on cherche les vagues FINIES, les vivantes sont sautées
    if os.path.basename(os.path.dirname(wf)) in live_ids:
        continue
    try:
        m = os.stat(wf).st_mtime
    except Exception:
        continue
    finished.append((m, wf))
finished.sort(reverse=True)
ended = []
for m, wf in finished[:ENDED_GUARD]:
    if m < time.time() - ENDED_DAYS * 86400:
        break
    w = load(wf) or {}
    d = os.path.dirname(wf)
    wid = w.get('id') or os.path.basename(d)
    if wid in live_ids:
        continue
    ended.append({
        'id': wid, 'pid': int(w.get('pid') or 0), 'cwd': w.get('cwd') or cwd, 'cap': None,
        'started': w.get('created'), 'status': w.get('status'), 'budget': w.get('budget'), 'consumed': w.get('consumed'),
        'live': False, 'ended': datetime.datetime.fromtimestamp(m, datetime.timezone.utc).isoformat(), 'lots': read_lots(d, False),
    })
if not out and ended:
    out.append(ended[0])
holds = []
for hf in sorted(glob.glob(os.path.join(home, 'holds', '*.json'))):
    h = load(hf)
    if isinstance(h, dict) and isinstance(h.get('label'), str) and isinstance(h.get('expires'), str):
        holds.append({'label': h['label'], 'since': str(h.get('since')), 'expires': h['expires']})

raw_cap = (os.environ.get('CADENCE_MAX_SESSIONS') or '').strip()
cap = int(raw_cap) if raw_cap.isdigit() and int(raw_cap) >= 1 else 2
print(json.dumps({'waves': out, 'holds': holds, 'cap': cap, 'ended': ended}))
`

/** Plafond de sessions quand le collecteur n'en donne pas de valide (le défaut de cadence). */
export const DEFAULT_CAP = 2

export type Collected = { waves: Wave[]; holds: LeadHold[]; cap: number; /** les vagues finies du dossier, la plus récente d'abord, qu'une vague vive ou non (L412) ; vide sans */ ended: Wave[] }

const isWave = (w: unknown): w is Wave => typeof w === 'object' && w !== null && typeof (w as Wave).id === 'string'

/**
 * Lit la sortie du collecteur : `{waves, holds, cap, ended}`, ou l'ancienne liste de vagues seule. Une sortie illisible
 * (JSON invalide) lève ; une forme étrange vaut aucune vague, aucune session du lead, le plafond par défaut et aucune vague finie.
 * Sans champ `live`, la vague est vivante ; les vagues d'`ended` sont toujours finies (`live: false`), dans l'ordre du collecteur (la plus récente
 * d'abord) ; une vague seule (le collecteur d'avant la liste) en vaut une, une entrée étrange est sautée.
 */
export const parseCollected = (stdout: string): Collected => {
  const raw: unknown = JSON.parse(stdout)
  const obj = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const list: unknown = Array.isArray(raw) ? raw : obj.waves
  const waves = (Array.isArray(list) ? list : []).filter(isWave).map(w => ({ ...w, live: w.live !== false }))
  const ended = (Array.isArray(obj.ended) ? obj.ended : [obj.ended]).filter(isWave).map(w => ({ ...w, live: false }))
  const holds = (Array.isArray(obj.holds) ? obj.holds : []).filter(
    (h): h is LeadHold => typeof h === 'object' && h !== null && typeof (h as LeadHold).label === 'string' && typeof (h as LeadHold).expires === 'string',
  )
  const cap = typeof obj.cap === 'number' && Number.isInteger(obj.cap) && obj.cap >= 1 ? obj.cap : DEFAULT_CAP
  return { waves, holds, cap, ended }
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
