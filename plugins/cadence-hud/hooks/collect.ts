import type { Wave } from '../types'

/**
 * Le collecteur des vagues `cadence orchestrate` vivantes, exécuté par python3 -I : il lit le registre
 * `~/.cadence/orchestrate/waves/<pid>.json`, garde celles dont le processus vit, puis l'état de la vague
 * (`<cwd>/.cadence/runs/<vague>/wave.json`) et de ses lots (`<projet>--<lot>.json`). Pour chaque étape
 * en cours il compte les processus `claude` descendants de la session (sessions filles, équipes).
 */
export const COLLECTOR = `
import json, os, glob

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

tree = None
out = []
for f in sorted(glob.glob(os.path.join(home, 'waves', '*.json'))):
    try:
        with open(f) as fh:
            r = json.load(fh)
    except Exception:
        continue
    pid = int(r.get('pid') or 0)
    if not pid or not alive(pid):
        continue
    d = os.path.join(r['cwd'], '.cadence', 'runs', r['wave'])
    try:
        with open(os.path.join(d, 'wave.json')) as fh:
            w = json.load(fh)
    except Exception:
        w = {}
    lots = []
    for lf in sorted(glob.glob(os.path.join(d, '*--*.json'))):
        try:
            with open(lf) as fh:
                l = json.load(fh)
        except Exception:
            continue
        steps = l.get('steps') or []
        running = [s for s in steps if s.get('status') == 'running']
        step = None
        if running:
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
            'project': l.get('project'), 'lot': l.get('lot'), 'status': l.get('status'),
            'pass': l.get('pass') or 0, 'model': l.get('model'), 'next': l.get('next'),
            'steps': len(steps), 'step': step,
        })
    out.append({
        'id': r['wave'], 'pid': pid, 'cwd': r['cwd'], 'cap': r.get('cap'), 'started': r.get('started'),
        'status': w.get('status'), 'budget': w.get('budget'), 'consumed': w.get('consumed'), 'lots': lots,
    })
print(json.dumps(out))
`

/** Lit la sortie du collecteur ; une sortie illisible vaut aucune vague. */
export const parseWaves = (stdout: string): Wave[] => {
  const raw: unknown = JSON.parse(stdout)
  if (!Array.isArray(raw)) return []
  return raw.filter((w): w is Wave => typeof w === 'object' && w !== null && typeof (w as Wave).id === 'string')
}
