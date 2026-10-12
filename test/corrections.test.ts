import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { CAUSES, classifyAll, measure, ollamaClassifier, parseCause, readCache, readRuns, renderReport, sampleKeys, type Classification } from '../src/corrections.js';
import { tempDir } from './helpers.js';

interface FakeStep { kind: string; status?: string; constats?: string[]; ended?: string }

/** Un enregistrement de lot dans <runs>/<vague>/<projet>--<lot>.json, avec le rapport de chaque revue. */
function lot(runs: string, wave: string, project: string, id: string, steps: FakeStep[], visible = false) {
  const dir = join(runs, wave);
  mkdirSync(join(dir, `${project}--${id}`), { recursive: true });
  const rec = steps.map((s, i) => {
    const n = i + 1;
    const report = `${n}-${s.kind}.json`;
    if (s.constats) {
      const structured = { bloquants: 0, majeurs: s.constats.length, mineurs: 0, constats: s.constats.map((texte) => ({ gravite: 'majeur', fichier: 'src/a.ts', ligne: 1, texte })) };
      writeFileSync(join(dir, `${project}--${id}`, report), JSON.stringify({ structured }));
    }
    return { n, kind: s.kind, status: s.status ?? 'ok', ended: s.ended ?? '2026-10-10T08:00:00.000Z', report, commits: s.kind === 'fix' ? [`abc${n} fix(${id}): correctif ${n}`] : [] };
  });
  writeFileSync(join(dir, `${project}--${id}.json`), JSON.stringify({ project, lot: id, visible, status: 'ready', steps: rec }));
  writeFileSync(join(dir, 'wave.json'), '{}');
}

function fixture() {
  const runs = tempDir();
  lot(runs, 'w1', 'alpha', 'L1', [{ kind: 'implement' }, { kind: 'review', constats: ['le comportement attendu n\'est pas décrit'] }, { kind: 'fix' }, { kind: 'review-small', constats: [] }]);
  lot(runs, 'w1', 'alpha', 'L2', [{ kind: 'implement' }, { kind: 'review', constats: [] }]);
  lot(runs, 'w2', 'beta', 'L3', [{ kind: 'implement' }, { kind: 'review', constats: ['test absent'] }, { kind: 'fix' }, { kind: 'review', constats: ['requête SQL fausse'] }, { kind: 'fix' }, { kind: 'review', constats: [] }], true);
  lot(runs, 'w2', 'beta', 'L4', [{ kind: 'implement', status: 'failed' }]);
  return runs;
}

describe('readRuns', () => {
  it('lit les lots implémentés et rattache chaque passe fix aux constats de la revue qui la précède', () => {
    const { lots, passes } = readRuns(fixture());
    expect(lots.map((l) => `${l.project}:${l.lot}`)).toEqual(['alpha:L1', 'alpha:L2', 'beta:L3']); // L4 jamais implémenté : hors dénominateur
    expect(passes.map((p) => [p.key, p.findings])).toEqual([
      ['w1/alpha--L1/3', ["le comportement attendu n'est pas décrit"]],
      ['w2/beta--L3/3', ['test absent']],
      ['w2/beta--L3/5', ['requête SQL fausse']],
    ]);
    expect(passes[2]!.commits).toEqual(['abc5 fix(L3): correctif 5']);
  });

  it('ignore un dossier de vague absent et un rapport illisible', () => {
    expect(readRuns(join(tempDir(), 'rien')).passes).toEqual([]);
    const runs = fixture();
    writeFileSync(join(runs, 'w1', 'alpha--L1', '2-review.json'), '{pas du json');
    expect(readRuns(runs).passes[0]!.findings).toEqual([]);
  });
});

describe('fix enchaînés', () => {
  it('une passe qui suit directement une autre passe fix n\'est pas rattachée à la revue déjà traitée', () => {
    const runs = tempDir();
    lot(runs, 'w1', 'alpha', 'L1', [{ kind: 'implement' }, { kind: 'review', constats: ['constat A'] }, { kind: 'fix' }, { kind: 'fix' }, { kind: 'review', constats: ['constat B'] }, { kind: 'fix' }]);
    const { passes } = readRuns(runs);
    expect(passes.map((p) => [p.key, p.findings])).toEqual([
      ['w1/alpha--L1/3', ['constat A']],
      ['w1/alpha--L1/4', []],
      ['w1/alpha--L1/6', ['constat B']],
    ]);
  });
});

describe('measure', () => {
  const cls = (key: string, cause: Classification['cause']): [string, Classification] => [key, { cause, by: 'ollama:m' }];
  it('compte les lots à ≥1 et ≥2 corrections, par projet et visible/non visible, et les passes par cause', () => {
    const data = readRuns(fixture());
    const m = measure(data, new Map([cls('w1/alpha--L1/3', 'spec-floue'), cls('w2/beta--L3/3', 'test-manquant')]));
    expect(m.total).toEqual({ lots: 3, atLeast1: 2, atLeast2: 1, passes: 3 });
    expect(m.byProject.alpha).toEqual({ lots: 2, atLeast1: 1, atLeast2: 0, passes: 1 });
    expect(m.byProject.beta).toEqual({ lots: 1, atLeast1: 1, atLeast2: 1, passes: 2 });
    expect(m.byVisibility.visible.lots).toBe(1);
    expect(m.byVisibility.hidden.lots).toBe(2);
    expect(m.byCause['spec-floue']).toBe(1);
    expect(m.byCause['test-manquant']).toBe(1);
    expect(m.byCause['non-classe']).toBe(1);
    expect(m.byProjectCause.beta!['test-manquant']).toBe(1);
  });

  it('sort les causes par visibilité (L176) : les passes d\'un lot visible ne se mêlent pas à celles des autres', () => {
    const data = readRuns(fixture());
    const m = measure(data, new Map([cls('w1/alpha--L1/3', 'spec-floue'), cls('w2/beta--L3/3', 'test-manquant'), cls('w2/beta--L3/5', 'bug-code')]));
    expect(m.byVisibilityCause.visible['test-manquant']).toBe(1);
    expect(m.byVisibilityCause.visible['bug-code']).toBe(1);
    expect(m.byVisibilityCause.visible['spec-floue']).toBe(0);
    expect(m.byVisibilityCause.hidden['spec-floue']).toBe(1);
    expect(m.byVisibilityCause.hidden['test-manquant']).toBe(0);
    for (const c of CAUSES) expect(m.byVisibilityCause.visible[c] + m.byVisibilityCause.hidden[c]).toBe(m.byCause[c]);
  });

  it('la relecture manuelle prime sur le classement du modèle et donne un taux d\'accord', () => {
    const data = readRuns(fixture());
    const c = new Map<string, Classification>([['w1/alpha--L1/3', { cause: 'spec-floue', by: 'ollama:m', manual: 'bug-code' }], ['w2/beta--L3/3', { cause: 'test-manquant', by: 'ollama:m', manual: 'test-manquant' }]]);
    const m = measure(data, c);
    expect(m.byCause['bug-code']).toBe(1);
    expect(m.byCause['spec-floue']).toBe(0);
    expect(m.agreement).toEqual({ reviewed: 2, agree: 1 });
  });
});

describe('passe sans constat (tests rouges)', () => {
  function withRed() {
    const runs = fixture();
    lot(runs, 'w3', 'gamma', 'L5', [{ kind: 'implement' }, { kind: 'fix' }, { kind: 'review', constats: [] }]);
    return runs;
  }

  it('est comptée à part, sans appeler le modèle ni fausser « faux constat »', async () => {
    const data = readRuns(withRed());
    const red = data.passes.find((p) => p.key === 'w3/gamma--L5/2')!;
    expect(red.findings).toEqual([]);
    const cache = new Map<string, Classification>();
    const asked: string[] = [];
    await classifyAll(data.passes, cache, async (p) => { asked.push(p.key); return 'faux-constat'; }, 'm');
    expect(asked).not.toContain(red.key);
    expect(cache.has(red.key)).toBe(false);
    // même une classification déjà au cache (modèle sans donnée) ne compte pas comme cause de revue
    const m = measure(data, new Map([[red.key, { cause: 'faux-constat', by: 'ollama:m' }]]));
    expect(m.byCause['faux-constat']).toBe(0);
    expect(m.byCause['sans-constat']).toBe(1);
    expect(m.byProjectCause.gamma!['sans-constat']).toBe(1);
    expect(renderReport(m)).toContain('tests rouges');
  });
});

describe('readCache fichier illisible', () => {
  it('refuse un cache dont le JSON est invalide au lieu de le lire vide', () => {
    const file = join(tempDir(), 'c.json');
    writeFileSync(file, '{"w1/a--L1/3": {"cause":"bug-code","by":"ollama:m","manual":"test-manquant"},}');
    expect(() => readCache(file)).toThrow(/c\.json/);
  });
  it('un fichier absent reste un cache vide', () => {
    expect(readCache(join(tempDir(), 'rien.json')).size).toBe(0);
  });
});

describe('readCache', () => {
  it('refuse une cause ou une relecture inconnue, en nommant la passe et le fichier', () => {
    const file = join(tempDir(), 'c.json');
    writeFileSync(file, JSON.stringify({ 'w1/a--L1/3': { cause: 'bug-code', by: 'ollama:m', manual: 'bug_code' } }));
    expect(() => readCache(file)).toThrow(/w1\/a--L1\/3.*bug_code/);
    writeFileSync(file, JSON.stringify({ 'w1/a--L1/3': { cause: 'nimporte', by: 'ollama:m' } }));
    expect(() => readCache(file)).toThrow(/nimporte/);
    writeFileSync(file, JSON.stringify({ 'w1/a--L1/3': { cause: 'bug-code', by: 'ollama:m', manual: 'test-manquant' } }));
    expect(readCache(file).get('w1/a--L1/3')!.manual).toBe('test-manquant');
  });
});

describe('parseCause', () => {
  it('accepte une cause connue, dans un JSON ou en texte, et refuse le reste', () => {
    expect(parseCause('{"cause":"bug-code","raison":"x"}')).toBe('bug-code');
    expect(parseCause('Je dirais test-manquant.')).toBe('test-manquant');
    expect(parseCause('{"cause":"autre"}')).toBeNull();
    expect(CAUSES).toHaveLength(7);
  });
});

describe('ollamaClassifier', () => {
  it('interroge /api/chat à température 0 avec un schéma contraint, le texte des constats dans le prompt', async () => {
    const calls: { url: string; body: any }[] = [];
    const fakeFetch = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ message: { content: '{"cause":"derive-architecture","raison":"r"}' } }) };
    }) as never;
    const classify = ollamaClassifier({ url: 'http://h:1', model: 'm1', fetch: fakeFetch });
    const pass = readRuns(fixture()).passes[0]!;
    expect(await classify(pass)).toBe('derive-architecture');
    expect(calls[0]!.url).toBe('http://h:1/api/chat');
    expect(calls[0]!.body.model).toBe('m1');
    expect(calls[0]!.body.options.temperature).toBe(0);
    expect(calls[0]!.body.format.properties.cause.enum).toEqual([...CAUSES]);
    expect(JSON.stringify(calls[0]!.body.messages)).toContain("le comportement attendu n'est pas décrit");
  });

  it('une réponse hors liste ou une erreur HTTP donne null, sans lever', async () => {
    const bad = ollamaClassifier({ url: 'http://h', model: 'm', fetch: (async () => ({ ok: true, json: async () => ({ message: { content: 'bof' } }) })) as never });
    const down = ollamaClassifier({ url: 'http://h', model: 'm', fetch: (async () => { throw new Error('ECONNREFUSED'); }) as never });
    const pass = readRuns(fixture()).passes[0]!;
    expect(await bad(pass)).toBeNull();
    expect(await down(pass)).toBeNull();
  });
});

describe('classifyAll', () => {
  it('ne reclasse pas une passe déjà dans le cache et n\'y inscrit pas un échec', async () => {
    const { passes } = readRuns(fixture());
    const cache = new Map<string, Classification>([[passes[0]!.key, { cause: 'bug-code', by: 'ollama:m' }]]);
    const asked: string[] = [];
    await classifyAll(passes, cache, async (p) => { asked.push(p.key); return p.key.endsWith('/5') ? null : 'donnees-sql'; }, 'm');
    expect(asked).toEqual(['w2/beta--L3/3', 'w2/beta--L3/5']);
    expect(cache.get('w2/beta--L3/3')).toEqual({ cause: 'donnees-sql', by: 'ollama:m' });
    expect(cache.has('w2/beta--L3/5')).toBe(false);
  });

  it('appelle checkpoint tous les n classements et à la fin, de sorte qu\'une interruption garde le travail fait', async () => {
    const { passes } = readRuns(fixture());
    const cache = new Map<string, Classification>();
    const saved: number[] = [];
    let calls = 0;
    const boom = async () => { if (++calls === 3) throw new Error('interrompu'); return 'bug-code' as const; };
    await expect(classifyAll(passes, cache, boom, 'm', undefined, { every: 2, save: () => saved.push(cache.size) })).rejects.toThrow('interrompu');
    expect(saved).toEqual([2]);
    saved.length = 0;
    await classifyAll(passes, cache, async () => 'bug-code', 'm', undefined, { every: 2, save: () => saved.push(cache.size) });
    expect(saved.at(-1)).toBe(cache.size);
  });
});

describe('sampleKeys', () => {
  it('prend n passes réparties, de façon déterministe', () => {
    const keys = Array.from({ length: 100 }, (_, i) => `k${String(i).padStart(3, '0')}`);
    const s = sampleKeys(keys, 10);
    expect(s).toHaveLength(10);
    expect(sampleKeys([...keys].reverse(), 10)).toEqual(s);
    expect(sampleKeys(keys.slice(0, 3), 10)).toHaveLength(3);
  });
});

describe('renderReport', () => {
  it('donne le tableau par cause et par projet, les taux et le visible/non visible', () => {
    const data = readRuns(fixture());
    const md = renderReport(measure(data, new Map([['w1/alpha--L1/3', { cause: 'spec-floue', by: 'ollama:m' }]])));
    expect(md).toContain('| Cause | Passes |');
    expect(md).toContain('| alpha |');
    expect(md).toContain('67 %'); // 2 lots sur 3 à ≥1 correction
    expect(md).toContain('33 %'); // 1 lot sur 3 à ≥2
    expect(md).toContain('visibles');
    expect(md).toContain('non classé');
  });

  it('donne les causes des lots visibles à part, avec la part « spec floue + règle inventée + test manquant » de leurs passes (L176)', () => {
    const data = readRuns(fixture());
    const md = renderReport(measure(data, new Map([['w1/alpha--L1/3', { cause: 'spec-floue', by: 'ollama:m' }], ['w2/beta--L3/3', { cause: 'test-manquant', by: 'ollama:m' }], ['w2/beta--L3/5', { cause: 'bug-code', by: 'ollama:m' }]])));
    const section = md.split('### Par cause et par visibilité')[1]!;
    expect(section).toBeDefined();
    expect(section).toContain('| Lots | Passes | spec floue ou critère absent |');
    expect(section).toContain('| visibles | 1 | 2 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 1 (50 %) |'); // 1 passe sur 2 : test manquant
    expect(section).toContain('| non visibles | 2 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 (100 %) |'); // 1 passe sur 1 : spec floue
  });
});

describe('cadence corrections', () => {
  async function cad(dir: string, ...argv: string[]) {
    return cadEnv(dir, {}, ...argv);
  }
  async function cadEnv(dir: string, env: Record<string, string>, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-10', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-10T10:00:00') });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('lit <dossier>/.cadence/runs et affiche le rapport, sans appeler de modèle sans --classify', async () => {
    const parent = tempDir();
    const runs = join(parent, '.cadence', 'runs');
    mkdirSync(runs, { recursive: true });
    cpSync(fixture(), runs, { recursive: true });
    const r = await cad(parent, 'corrections', parent);
    expect(r.code).toBe(0);
    expect(r.out).toContain('| alpha |');
    const j = await cad(parent, 'corrections', parent, '--json');
    expect(JSON.parse(j.out).total).toEqual({ lots: 3, atLeast1: 2, atLeast2: 1, passes: 3 });
    expect(readFileSync(join(runs, 'w1', 'wave.json'), 'utf8')).toBe('{}'); // lecture seule
  });

  function parentWithRuns() {
    const parent = tempDir();
    const runs = join(parent, '.cadence', 'runs');
    mkdirSync(runs, { recursive: true });
    cpSync(fixture(), runs, { recursive: true });
    return parent;
  }

  it('--classify appelle Ollama, écrit le cache (--cache fichier) puis le rapport le relit ; --sample affiche modèle et relecture', async () => {
    const models: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        models.push(JSON.parse(body).model);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: { content: '{"cause":"test-manquant","raison":"r"}' } }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const parent = parentWithRuns();
      const cacheFile = join(parent, 'mon-cache.json');
      const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const r = await cadEnv(parent, { OLLAMA_HOST: host }, 'corrections', parent, '--classify', '--model', 'm-test', '--cache', 'mon-cache.json');
      expect(r.code).toBe(0);
      expect(models).toEqual(['m-test', 'm-test', 'm-test']);
      expect(existsSync(join(parent, '.cadence', 'corrections.json'))).toBe(false); // --cache résolu depuis le dossier courant
      const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
      expect(Object.keys(cache)).toEqual(['w1/alpha--L1/3', 'w2/beta--L3/3', 'w2/beta--L3/5']);
      expect(cache['w1/alpha--L1/3']).toEqual({ cause: 'test-manquant', by: 'ollama:m-test' });
      // relance : rien à reclasser, le cache est relu
      await cadEnv(parent, { OLLAMA_HOST: host }, 'corrections', parent, '--classify', '--model', 'm-test', '--cache', 'mon-cache.json');
      expect(models).toHaveLength(3);
      const rep = await cad(parent, 'corrections', parent, '--cache', 'mon-cache.json', '--json');
      expect(JSON.parse(rep.out).byCause['test-manquant']).toBe(3);
      cache['w2/beta--L3/3'].manual = 'bug-code';
      writeFileSync(cacheFile, JSON.stringify(cache));
      const s = await cad(parent, 'corrections', parent, '--cache', 'mon-cache.json', '--sample', '3');
      expect(s.out).toContain('## w1/alpha--L1/3 (alpha L1) · modèle : test-manquant');
      expect(s.out).toContain('## w2/beta--L3/3 (beta L3) · modèle : test-manquant · relu : bug-code');
      expect(s.out).toContain("- le comportement attendu n'est pas décrit");
      expect(s.out).toContain('commit : abc3 fix(L1): correctif 3');
    } finally {
      server.close();
    }
  });

  it('--classify sans Ollama ne crée pas d\'entrée au cache ; --sample invalide est refusé', async () => {
    const parent = parentWithRuns();
    const r = await cadEnv(parent, { OLLAMA_HOST: 'http://127.0.0.1:1' }, 'corrections', parent, '--classify');
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(parent, '.cadence', 'corrections.json'), 'utf8'))).toEqual({});
    for (const bad of ['0', 'x', '1.5']) {
      const e = await cad(parent, 'corrections', parent, '--sample', bad);
      expect(e.code).not.toBe(0);
      expect(e.err).toContain('--sample invalide');
    }
  });

  it('--sample ne tire que des passes qui ont des constats à relire (pas les passes sans revue)', async () => {
    const parent = parentWithRuns();
    lot(join(parent, '.cadence', 'runs'), 'w3', 'gamma', 'L5', [{ kind: 'implement' }, { kind: 'fix' }, { kind: 'review', constats: [] }]);
    const s = await cad(parent, 'corrections', parent, '--sample', '10');
    expect(s.out).toContain('## w1/alpha--L1/3');
    expect(s.out).not.toContain('gamma--L5');
  });

  it('--until borne la mesure aux vagues créées jusque-là (wave.json) : les vagues suivantes ne changent plus les chiffres', async () => {
    const parent = parentWithRuns();
    const runs = join(parent, '.cadence', 'runs');
    writeFileSync(join(runs, 'w1', 'wave.json'), JSON.stringify({ id: 'w1', created: '2026-10-10T10:00:00.000Z' }));
    writeFileSync(join(runs, 'w2', 'wave.json'), JSON.stringify({ id: 'w2', created: '2026-10-10T12:00:00.000Z' }));
    const all = JSON.parse((await cad(parent, 'corrections', parent, '--json')).out);
    const w1 = JSON.parse((await cad(parent, 'corrections', parent, '--until', '2026-10-10T10:00:00Z', '--json')).out);
    expect(all.total.lots).toBe(3);
    expect(w1.total.lots).toBe(2);
    expect(w1.total.passes).toBe(1);
    expect(readRuns(runs, '2026-10-10T09:00:00Z').lots).toEqual([]);
    const e = await cad(parent, 'corrections', parent, '--until', 'hier');
    expect(e.code).not.toBe(0);
    expect(e.err).toContain('--until invalide');
  });

  it('--until ne compte que les étapes terminées avant la date : une vague créée avant mais encore en cours ne gonfle pas le relevé', () => {
    const runs = tempDir();
    lot(runs, 'w1', 'alpha', 'L1', [{ kind: 'implement' }, { kind: 'review', constats: ['x'] }, { kind: 'fix' }, { kind: 'fix', ended: '2026-10-10T11:00:00.000Z' }]);
    lot(runs, 'w1', 'alpha', 'L2', [{ kind: 'implement', ended: '2026-10-10T11:00:00.000Z' }, { kind: 'fix', ended: '2026-10-10T11:30:00.000Z' }]);
    lot(runs, 'w1', 'alpha', 'L3', [{ kind: 'implement', ended: 'pas une date' }, { kind: 'fix' }]);
    writeFileSync(join(runs, 'w1', 'wave.json'), JSON.stringify({ created: '2026-10-10T07:00:00.000Z' }));
    const r = readRuns(runs, '2026-10-10T10:00:00Z');
    expect(r.lots.map((l) => `${l.lot}:${l.fixes}`)).toEqual(['L1:1']); // L2 écrit après la date, L3 sans date lisible
    expect(r.passes).toHaveLength(1);
    expect(readRuns(runs).lots.map((l) => `${l.lot}:${l.fixes}`)).toEqual(['L1:2', 'L2:1', 'L3:1']);
  });

  it('--until écarte une vague sans date lisible', () => {
    const runs = tempDir();
    lot(runs, 'w1', 'alpha', 'L1', [{ kind: 'implement' }, { kind: 'fix' }]);
    writeFileSync(join(runs, 'w1', 'wave.json'), '{}');
    expect(readRuns(runs, '2026-10-10T10:00:00Z').lots).toEqual([]);
    expect(readRuns(runs).lots).toHaveLength(1);
  });

  it('refuse un dossier sans journaux', async () => {
    const r = await cad(tempDir(), 'corrections');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('journal');
  });
});
