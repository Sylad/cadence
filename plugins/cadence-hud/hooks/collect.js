"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseWaves = exports.COLLECTOR = void 0;
/**
 * Le collecteur des vagues `cadence orchestrate`, exécuté par python3 -I : il lit le registre
 * `~/.cadence/orchestrate/waves/<pid>.json`, garde celles dont le processus vit, puis l'état de la vague
 * (`<cwd>/.cadence/runs/<vague>/wave.json`) et de ses lots (`<projet>--<lot>.json`). Pour chaque étape
 * en cours il compte les processus `claude` descendants de la session (sessions filles, équipes).
 * Sans vague vivante, il rend la dernière vague terminée du dossier courant (`live: false`, `ended` = date
 * de son wave.json) pour que la bande garde son statut sous les yeux jusqu'à la vague suivante.
 */
exports.COLLECTOR = "\nimport json, os, glob, datetime\n\nhome = os.environ.get('CADENCE_HOME') or os.path.join(os.path.expanduser('~'), '.cadence', 'orchestrate')\n\ndef alive(pid):\n    try:\n        os.kill(int(pid), 0)\n        return True\n    except Exception:\n        return False\n\ndef children():\n    tree = {}\n    for d in os.listdir('/proc'):\n        if not d.isdigit():\n            continue\n        try:\n            with open('/proc/%s/stat' % d) as f:\n                s = f.read()\n            name = s[s.index('(') + 1:s.rindex(')')]\n            ppid = int(s[s.rindex(')') + 2:].split()[1])\n        except Exception:\n            continue\n        tree.setdefault(ppid, []).append((int(d), name))\n    return tree\n\ndef claude_descendants(tree, pid):\n    n, stack = 0, [pid]\n    while stack:\n        for cpid, name in tree.get(stack.pop(), []):\n            if name.startswith('claude'):\n                n += 1\n            stack.append(cpid)\n    return n\n\ndef load(path):\n    try:\n        with open(path) as fh:\n            return json.load(fh)\n    except Exception:\n        return None\n\ntree = None\n\ndef read_lots(d, live):\n    global tree\n    lots = []\n    for lf in sorted(glob.glob(os.path.join(d, '*--*.json'))):\n        l = load(lf)\n        if l is None:\n            continue\n        steps = l.get('steps') or []\n        running = [s for s in steps if s.get('status') == 'running']\n        step = None\n        if live and running:\n            cur = running[-1]\n            spid = int(cur.get('pid') or 0)\n            if tree is None:\n                tree = children()\n            step = {\n                'kind': cur.get('kind'), 'model': cur.get('model'), 'started': cur.get('started'),\n                'pid': spid, 'alive': bool(spid) and alive(spid),\n                'sub': claude_descendants(tree, spid) if spid else 0,\n            }\n        lots.append({\n            'project': l.get('project'), 'lot': l.get('lot'), 'title': l.get('title') or '', 'status': l.get('status'),\n            'pass': l.get('pass') or 0, 'model': l.get('model'), 'next': l.get('next'),\n            'steps': len(steps), 'step': step,\n        })\n    return lots\n\nout = []\nfor f in sorted(glob.glob(os.path.join(home, 'waves', '*.json'))):\n    r = load(f)\n    if r is None:\n        continue\n    pid = int(r.get('pid') or 0)\n    if not pid or not alive(pid):\n        continue\n    d = os.path.join(r['cwd'], '.cadence', 'runs', r['wave'])\n    w = load(os.path.join(d, 'wave.json')) or {}\n    out.append({\n        'id': r['wave'], 'pid': pid, 'cwd': r['cwd'], 'cap': r.get('cap'), 'started': r.get('started'),\n        'status': w.get('status'), 'budget': w.get('budget'), 'consumed': w.get('consumed'),\n        'live': True, 'lots': read_lots(d, True),\n    })\n\nif not out:\n    cwd = os.getcwd()\n    last, last_mtime = None, 0\n    for wf in glob.glob(os.path.join(cwd, '.cadence', 'runs', '*', 'wave.json')):\n        try:\n            m = os.stat(wf).st_mtime\n        except Exception:\n            continue\n        if m > last_mtime:\n            last, last_mtime = wf, m\n    if last:\n        w = load(last) or {}\n        d = os.path.dirname(last)\n        ended = datetime.datetime.fromtimestamp(last_mtime, datetime.timezone.utc).isoformat()\n        out.append({\n            'id': w.get('id') or os.path.basename(d), 'pid': int(w.get('pid') or 0), 'cwd': cwd, 'cap': None,\n            'started': w.get('created'), 'status': w.get('status'), 'budget': w.get('budget'),\n            'consumed': w.get('consumed'), 'live': False, 'ended': ended, 'lots': read_lots(d, False),\n        })\nprint(json.dumps(out))\n";
/** Lit la sortie du collecteur ; une sortie illisible vaut aucune vague. Sans champ \`live\`, la vague est vivante. */
var parseWaves = function (stdout) {
    var raw = JSON.parse(stdout);
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter(function (w) { return typeof w === 'object' && w !== null && typeof w.id === 'string'; })
        .map(function (w) { return (__assign(__assign({}, w), { live: w.live !== false })); });
};
exports.parseWaves = parseWaves;
