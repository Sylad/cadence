import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { CAUSES, classifyAll, measure, ollamaClassifier, parseCause, readRuns, renderReport, sampleKeys, type Classification } from '../src/corrections.js';
import { tempDir } from './helpers.js';

interface FakeStep { kind: string; status?: string; constats?: string[] }

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
    return { n, kind: s.kind, status: s.status ?? 'ok', report, commits: s.kind === 'fix' ? [`abc${n} fix(${id}): correctif ${n}`] : [] };
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

  it('la relecture manuelle prime sur le classement du modèle et donne un taux d\'accord', () => {
    const data = readRuns(fixture());
    const c = new Map<string, Classification>([['w1/alpha--L1/3', { cause: 'spec-floue', by: 'ollama:m', manual: 'bug-code' }], ['w2/beta--L3/3', { cause: 'test-manquant', by: 'ollama:m', manual: 'test-manquant' }]]);
    const m = measure(data, c);
    expect(m.byCause['bug-code']).toBe(1);
    expect(m.byCause['spec-floue']).toBe(0);
    expect(m.agreement).toEqual({ reviewed: 2, agree: 1 });
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
});

describe('cadence corrections', () => {
  async function cad(dir: string, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-10' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-10T10:00:00') });
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

  it('refuse un dossier sans journaux', async () => {
    const r = await cad(tempDir(), 'corrections');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('journal');
  });
});
