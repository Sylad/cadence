import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { run } from '../src/cli.js';
import { planLoader } from '../src/config.js';
import { measure, readCache, readJournals, readRuns, type Classification } from '../src/corrections.js';
import { computePerf, isQaDefectNote, perfWindows, readPlans } from '../src/perf.js';
import { tempDir } from './helpers.js';
import { writeJournal, writeWave, type PStep } from './perf-helpers.js';

const TODAY = '2026-10-16';
const at = (day: string, time = '12:00:00') => `${day}T${time}`;
/** Jours des deux fenêtres de TODAY : courante 10-10 → 10-16, précédente 10-03 → 10-09. */
const CUR = '2026-10-12';
const PREV = '2026-10-05';

interface Ctx { root: string; runs: string }
function ctx(): Ctx {
  const root = tempDir();
  const runs = join(root, '.cadence', 'runs');
  mkdirSync(runs, { recursive: true });
  writeWave(runs, 'w1', at('2026-10-01', '08:00:00'));
  return { root, runs };
}

let seq = 0;
interface JOpts { project?: string; lot?: string; wave?: string; status?: string; budget?: number; visible?: boolean; passes?: number; ux?: number; counted?: number; constat?: string; fixDay?: string; implement?: boolean }
/** Un journal rendu le `day` : implement, `passes` couples revue + fix, `ux` sessions ux. */
function journal(c: Ctx, day: string, o: JOpts = {}): { project: string; lot: string; wave: string } {
  const project = o.project ?? 'alpha';
  const lot = o.lot ?? `L${++seq}`;
  const wave = o.wave ?? 'w1';
  const steps: PStep[] = [{ kind: 'implement', status: o.implement === false ? 'failed' : 'ok', ended: at(day, '09:00:00'), counted: o.counted }];
  for (let i = 0; i < (o.passes ?? 0); i++) {
    steps.push({ kind: 'review', constats: [o.constat ?? `constat ${i}`], ended: at(day, '10:00:00') });
    steps.push({ kind: 'fix', ended: at(o.fixDay ?? day, '11:00:00') });
  }
  for (let i = 0; i < (o.ux ?? 0); i++) steps.push({ kind: 'ux', ended: at(day, '12:00:00') });
  writeJournal(c.runs, wave, project, lot, { status: o.status ?? 'ready', budget: o.budget, visible: o.visible, steps });
  return { project, lot, wave };
}
const many = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

interface PLot { id: string; status?: string; finished?: string; notes?: [string, string][] }
function plan(root: string, name: string, lots: PLot[]): void {
  const dir = join(root, name);
  mkdirSync(join(dir, 'docs', 'plan'), { recursive: true });
  const body = lots.map((l) => [`  - id: ${l.id}`, '    title: "t"', `    status: ${l.status ?? 'done'}`, ...(l.finished ? [`    finished: ${l.finished}`] : []), ...(l.notes ? ['    notes:', ...l.notes.map(([d, t]) => `      - { date: ${d}, text: ${JSON.stringify(t)} }`)] : [])].join('\n')).join('\n');
  writeFileSync(join(dir, 'docs', 'plan', 'raf.yaml'), `version: 1\nproject: "${name}"\nprefix: L\nlots:\n${body}\n`);
}

async function cad(cwd: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(['perf', ...args], { cwd, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${TODAY}T10:00:00`) });
  return { code, out, err, text: out.join('\n') };
}
async function json(root: string, ...args: string[]) {
  const r = await cad(root, '--json', ...args);
  return { ...r, data: JSON.parse(r.text) as any };
}
const tree = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [`${e.name}:${statSync(join(dir, e.name)).mtimeMs}:${readFileSync(join(dir, e.name), 'utf8')}`]));

describe('cadence perf — fenêtres et débit', () => {
  it('R1 — deux fenêtres adjacentes de 7 jours : un lot rendu au 8e jour passé tombe dans la précédente, non dans la courante', async () => {
    const c = ctx();
    journal(c, '2026-10-09');
    journal(c, '2026-10-10');
    const { data } = await json(c.root);
    expect(data.windows.current).toMatchObject({ from: '2026-10-10', to: TODAY, days: 7 });
    expect(data.windows.previous).toMatchObject({ from: '2026-10-03', to: '2026-10-09', days: 7 });
    expect(data.throughput.rendered.current).toBeCloseTo(1 / 7);
    expect(data.throughput.rendered.previous).toBeCloseTo(1 / 7);
    expect(data.throughput.rendered.lots).toEqual({ current: 1, previous: 1 });
  });

  it('R2 — un lot rendu à 23:50 le jour J−6 est dans la courante, à 23:50 le jour J−7 dans la précédente', async () => {
    const c = ctx();
    writeJournal(c.runs, 'w1', 'alpha', 'A', { steps: [{ kind: 'implement', ended: at('2026-10-10', '23:50:00') }] });
    writeJournal(c.runs, 'w1', 'alpha', 'B', { steps: [{ kind: 'implement', ended: at('2026-10-09', '23:50:00') }] });
    const { data } = await json(c.root);
    expect(data.throughput.rendered.lots).toEqual({ current: 1, previous: 1 });
  });

  it('R2 — un jour de plan J−7 (finished) est dans la précédente', async () => {
    const c = ctx();
    journal(c, CUR);
    plan(c.root, 'alpha', [{ id: 'P1', finished: '2026-10-09' }, { id: 'P2', finished: '2026-10-10' }, { id: 'P3', finished: '2026-10-02' }]);
    const { data } = await json(c.root);
    expect(data.throughput.delivered).toMatchObject({ current: 1, previous: 1 });
  });

  it('R3 — --since au milieu de la précédente : les lots avant la date sont ignorés et la précédente est dite tronquée', async () => {
    const c = ctx();
    writeWave(c.runs, 'w2', at('2026-10-06', '08:00:00'));
    journal(c, '2026-10-04');
    journal(c, '2026-10-07', { wave: 'w2' });
    journal(c, '2026-10-08', { wave: 'w2' });
    const { data, code } = await json(c.root, '--since', '2026-10-06');
    expect(code).toBe(0);
    expect(data.windows.previous).toMatchObject({ from: '2026-10-06', to: '2026-10-09', days: 4, truncated: true });
    expect(data.windows.current.truncated).toBe(false);
    expect(data.throughput.rendered.previous).toBeCloseTo(2 / 4);
    expect((await cad(c.root, '--since', '2026-10-06')).text).toContain('tronquée par --since');
  });

  it('R3 — --since ignore une vague créée avant la date, même quand ses lots finissent après', async () => {
    const c = ctx();
    writeWave(c.runs, 'w2', at('2026-10-14', '08:00:00'));
    journal(c, '2026-10-15');
    journal(c, '2026-10-15', { wave: 'w2' });
    const { data } = await json(c.root, '--since', '2026-10-14');
    expect(data.throughput.rendered.lots.current).toBe(1);
    expect(data.throughput.ready.current).toBe(1);
  });

  it('R14 — une fenêtre sans lot rendu donne n/d pour prêts et livrés, jamais 0', async () => {
    const c = ctx();
    journal(c, CUR);
    plan(c.root, 'alpha', [{ id: 'P1', finished: CUR }]);
    const { data } = await json(c.root);
    expect(data.throughput.ready).toMatchObject({ current: 1, previous: null });
    expect(data.throughput.delivered).toMatchObject({ current: 1, previous: null });
    const early = (await json(c.root, '--since', '2026-10-12')).data;
    expect([early.throughput.ready.previous, early.throughput.delivered.previous]).toEqual([null, null]);
  });

  it('R3 — --since antérieur aux deux fenêtres : résultat identique au lancement sans option', async () => {
    const c = ctx();
    many(3, () => journal(c, CUR));
    many(2, () => journal(c, PREV));
    const plain = (await json(c.root)).data;
    const early = (await json(c.root, '--since', '2026-09-01')).data;
    expect({ ...early, since: null }).toEqual(plain);
    expect(early.since).toBe('2026-09-01');
  });

  it('R4 — rendus par jour : 7 lots ready+handed-back+failed sur 7 jours = 1/jour', async () => {
    const c = ctx();
    const days = ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
    const statuses = ['ready', 'ready', 'handed-back', 'failed', 'ready', 'handed-back', 'failed'];
    days.forEach((d, i) => journal(c, d, { status: statuses[i] }));
    journal(c, '2026-10-12', { status: 'fixing' });
    const { data } = await json(c.root);
    expect(data.throughput.rendered.current).toBe(1);
    expect(data.throughput.ready.current).toBe(3);
  });

  it('R4 — livrés compte le plan done daté dans la fenêtre, pas les journaux', async () => {
    const c = ctx();
    many(3, () => journal(c, CUR));
    plan(c.root, 'alpha', [{ id: 'P1', finished: CUR }, { id: 'P2', status: 'doing' }]);
    const { data } = await json(c.root);
    expect(data.throughput.delivered.current).toBe(1);
  });

  it('R4 — un journal sans ended utilise la création de la vague, sans date : écarté', async () => {
    const c = ctx();
    writeWave(c.runs, 'w2', at(CUR, '08:00:00'));
    writeJournal(c.runs, 'w2', 'alpha', 'A', { steps: [{ kind: 'implement' }] });
    writeWave(c.runs, 'w3', null);
    writeFileSync(join(c.runs, 'w3', 'wave.json'), '{}');
    writeJournal(c.runs, 'w3', 'alpha', 'B', { steps: [{ kind: 'implement' }] });
    const { data } = await json(c.root);
    expect(data.throughput.rendered.lots).toEqual({ current: 1, previous: 0 });
  });

  it('R5 — un lot à 450 k de budget et 460 k comptés n\'est pas sur budget', async () => {
    const c = ctx();
    writeJournal(c.runs, 'w1', 'alpha', 'A', { budget: 450_000, steps: [{ kind: 'implement', counted: 300_000, ended: at(CUR) }, { kind: 'fix', counted: 160_000, ended: at(CUR) }] });
    writeJournal(c.runs, 'w1', 'alpha', 'B', { budget: 450_000, steps: [{ kind: 'implement', counted: 450_000, ended: at(CUR) }] });
    const { data } = await json(c.root);
    expect(data.throughput.onBudget.current).toBe(0.5);
  });

  it('R5 — un journal sans budget n\'entre pas au dénominateur', async () => {
    const c = ctx();
    journal(c, CUR, { budget: 100, counted: 50 });
    journal(c, CUR, { counted: 5_000_000 });
    const { data } = await json(c.root);
    expect(data.throughput.onBudget.current).toBe(1);
    expect(data.throughput.onBudget.lots.current).toBe(1);
  });
});

describe('cadence perf — passes de correction', () => {
  it('R6 — médiane de 0,0,1,3 passes = 0,5 et part ≥ 2 = 50 %', async () => {
    const c = ctx();
    [0, 0, 1, 3].forEach((n) => journal(c, CUR, { passes: n }));
    const { data } = await json(c.root);
    expect(data.corrections.medianPasses.current).toBe(0.5);
    expect(data.corrections.atLeast2.current).toBe(0.25);
    journal(c, CUR, { passes: 2 });
    expect((await json(c.root)).data.corrections.atLeast2.current).toBe(0.4);
  });

  it('R6 — un lot sans implement abouti n\'entre pas', async () => {
    const c = ctx();
    journal(c, CUR, { passes: 4, implement: false });
    journal(c, CUR, { passes: 0 });
    const { data } = await json(c.root);
    expect(data.corrections.medianPasses.current).toBe(0);
    expect(data.corrections.medianPasses.lots.current).toBe(1);
  });

  it('R6 — la fonction de calcul reçoit les bornes en paramètre : posées sur toute l\'étendue des journaux, le total de passes égale celui de cadence corrections ; un lot non fini ou une passe hors des bornes fait la différence', () => {
    const c = ctx();
    journal(c, '2026-10-05', { passes: 2 });
    journal(c, CUR, { passes: 1 });
    journal(c, CUR, { passes: 0 });
    const windows = { current: { from: '2020-01-01', to: '2030-01-01', days: 3653, truncated: false }, previous: { from: '2010-01-01', to: '2019-12-31', days: 3652, truncated: false } };
    const total = (j = readJournals(c.runs)) => {
      const w = computePerf({ journals: j, plans: new Map(), cache: new Map(), windows, today: TODAY }).corrections.causes.current;
      return w.classified + w.unclassified + w.withoutFindings;
    };
    expect(total()).toBe(3);
    expect(measure(readRuns(c.runs), new Map()).total.passes).toBe(3);
    journal(c, CUR, { passes: 2, status: 'fixing' });
    journal(c, '2040-01-01', { passes: 1 });
    expect(total()).toBe(3);
    expect(measure(readRuns(c.runs), new Map()).total.passes).toBe(6);
  });

  const cache = (entries: Record<string, Classification>) => new Map(Object.entries(entries));

  it('R7 — trois causes en tête avec leur part, la part non classée affichée à part', async () => {
    const c = ctx();
    const refs = [
      ...many(4, () => journal(c, CUR, { passes: 1, lot: `B${++seq}` })),
      ...many(2, () => journal(c, CUR, { passes: 1, lot: `S${++seq}` })),
      journal(c, CUR, { passes: 1, lot: `T${++seq}` }),
      journal(c, CUR, { passes: 1, lot: `D${++seq}` }),
      journal(c, CUR, { passes: 1, lot: `U${++seq}` }),
    ];
    const causes = ['bug-code', 'bug-code', 'bug-code', 'bug-code', 'spec-floue', 'spec-floue', 'test-manquant', 'donnees-sql'] as const;
    const entries: Record<string, Classification> = {};
    refs.slice(0, 8).forEach((r, i) => (entries[`${r.wave}/${r.project}--${r.lot}/3`] = { cause: causes[i]!, by: 'm' }));
    writeFileSync(join(c.root, '.cadence', 'corrections.json'), JSON.stringify(entries));
    const { data, text } = await json(c.root).then(async (d) => ({ ...d, text: (await cad(c.root)).text }));
    const w = data.corrections.causes.current;
    expect(w.top.map((t: any) => [t.cause, t.passes, t.share])).toEqual([['bug-code', 4, 0.5], ['spec-floue', 2, 0.25], ['donnees-sql', 1, 0.125]]);
    expect(w.classified).toBe(8);
    expect(w.unclassified).toBe(1);
    expect(w.unclassifiedShare).toBeCloseTo(1 / 9);
    expect(text).toContain('1. bug de code 4 (50 %) · 2. spec floue ou critère absent 2 (25 %) · 3. données / SQL 1 (13 %)');
    expect(text).toContain('non classé : 11 %');
  });

  it('R7 — un lot rendu dans la fenêtre courante dont une passe fix date de la veille de la fenêtre : le lot compte dans R6 de la courante, la passe dans les passes de la précédente (date de fin de l\'étape fix, non date de rendu du lot)', async () => {
    const c = ctx();
    writeJournal(c.runs, 'w1', 'alpha', 'A', { steps: [{ kind: 'implement', ended: at('2026-10-08') }, { kind: 'review', constats: ['x'], ended: at('2026-10-08') }, { kind: 'fix', ended: at('2026-10-09') }, { kind: 'review', constats: [], ended: at('2026-10-10') }] });
    const { data } = await json(c.root);
    expect(data.corrections.medianPasses.current).toBe(1);
    expect(data.corrections.medianPasses.lots).toEqual({ current: 1, previous: 0 });
    expect(data.corrections.causes.previous).toMatchObject({ unclassified: 1 });
    expect(data.corrections.causes.current).toMatchObject({ unclassified: 0, classified: 0 });
  });

  it('R7 — aucun appel réseau : la commande tourne avec OLLAMA_HOST injoignable', async () => {
    const c = ctx();
    journal(c, CUR, { passes: 1 });
    const fetchSpy = vi.fn(() => { throw new Error('réseau interdit'); });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const out: string[] = [];
      const code = await run(['perf', '--json'], { cwd: c.root, env: { RAF_TODAY: TODAY, OLLAMA_HOST: 'http://127.0.0.1:1' }, out: (l) => out.push(l), err: () => {}, now: () => new Date() });
      expect(code).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('R7 — le cache absent donne 100 % non classé sans erreur', async () => {
    const c = ctx();
    many(3, () => journal(c, CUR, { passes: 1 }));
    const r = await json(c.root);
    expect(r.code).toBe(0);
    expect(r.data.corrections.causes.current).toMatchObject({ top: [], classified: 0, unclassified: 3, unclassifiedShare: 1 });
  });

  it('R8 — la ligne de débit contient la valeur de défauts échappés', async () => {
    const c = ctx();
    journal(c, CUR);
    plan(c.root, 'alpha', [{ id: 'P1', finished: '2026-10-01', notes: [[CUR, '12-10 : QA 2 bloquants']] }]);
    const line = (await cad(c.root)).out.find((l) => l.includes('rendus par jour'))!;
    expect(line).toMatch(/défauts échappés : 1 \(précédente 0/);
    for (const label of ['prêts', 'livrés', 'part des rendus sur budget']) expect((await cad(c.root)).out.find((l) => l.includes(label))).toMatch(/défauts échappés : /);
  });

  it('R8 — la ligne des passes contient la part conforme du premier coup', async () => {
    const c = ctx();
    [0, 0, 1].forEach((n) => journal(c, CUR, { passes: n }));
    const out = (await cad(c.root)).out;
    expect(out.find((l) => l.includes('médiane de passes'))).toMatch(/part conforme du premier coup : 67 %/);
    expect(out.find((l) => l.includes('au moins 2 passes'))).toMatch(/part conforme du premier coup : 67 %/);
  });

  it('R8 — la sortie --json lie chaque indicateur de vitesse à son jumeau', async () => {
    const c = ctx();
    journal(c, CUR);
    const { data } = await json(c.root);
    expect([data.throughput.ready.twin, data.throughput.rendered.twin, data.throughput.delivered.twin, data.throughput.onBudget.twin, data.interventions.handedOut.twin, data.interventions.ux.twin]).toEqual(Array(6).fill('throughput.escaped'));
    expect([data.corrections.medianPasses.twin, data.corrections.atLeast2.twin]).toEqual(['corrections.firstTime', 'corrections.firstTime']);
    expect([data.throughput.escaped.twin, data.corrections.firstTime.twin]).toEqual([null, null]);
  });
});

describe('cadence perf — défauts échappés (R9)', () => {
  const escaped = async (c: Ctx) => (await json(c.root)).data.throughput.escaped;

  it('R9 — une note « 16-10 : QA … 1 bloquant » datée dans la fenêtre sur un lot terminé compte un défaut', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'P1', finished: '2026-10-11', notes: [['2026-10-14', '14-10 : QA recette : 1 bloquant'], ['2026-10-15', '15-10 10:30 : QA : 1 majeur']] }, { id: 'P2', finished: '2026-10-01', notes: [['2026-10-05', '05-10 : QA 2 majeurs']] }]);
    const e = await escaped(c);
    expect(e.current).toBe(1);
    expect(e.previous).toBe(1);
  });

  it('R9 — « 0 défaut » et « aucun bloquant » ne comptent pas', () => {
    expect(isQaDefectNote('16-10 : QA : 0 défaut')).toBe(false);
    expect(isQaDefectNote('16-10 : QA : aucun bloquant')).toBe(false);
    expect(isQaDefectNote('16-10 : QA : 0 bloquant')).toBe(false);
    expect(isQaDefectNote('16-10 : QA : 0 bloquant, 2 majeurs')).toBe(true);
    expect(isQaDefectNote('16-10 : revue : 1 bloquant')).toBe(false);
    expect(isQaDefectNote('QA 1 bloquant')).toBe(true);
  });

  it('R9 — une note QA datée avant finished ne compte pas', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'P1', finished: '2026-10-14', notes: [['2026-10-13', '13-10 : QA : 3 bloquants']] }, { id: 'P2', finished: '2026-10-14', notes: [['2026-10-14', '14-10 : QA : 1 majeur']] }]);
    expect((await escaped(c)).current).toBe(1);
  });

  it('R9 — plans sans aucune note reconnue : valeur n/d (null) avec la mention, pas 0 et pas de ⚠', async () => {
    const c = ctx();
    many(6, () => journal(c, CUR));
    many(6, () => journal(c, PREV));
    plan(c.root, 'alpha', [{ id: 'P1', finished: CUR, notes: [[CUR, '12-10 revue sans constat']] }]);
    const r = await json(c.root);
    expect(r.data.throughput.escaped).toMatchObject({ current: null, previous: null, warn: false });
    expect(r.data.throughput.escaped.note).toContain('aucune note QA reconnue : convention à fixer (L227)');
    expect((await cad(c.root)).text).toContain('aucune note QA reconnue : convention à fixer (L227)');
  });

  it('R9 — sur docs/plan/raf.yaml réel du dépôt, le décompte égale celui d\'une expression indépendante sur le texte des notes (n/d si zéro)', () => {
    const repo = join(import.meta.dirname, '..');
    const raw = parse(readFileSync(join(repo, 'docs/plan/raf.yaml'), 'utf8')) as { lots: { notes?: { text: string }[] }[] };
    const independent = raw.lots.flatMap((l) => l.notes ?? []).filter((n) => /^(?:\d\d-\d\d(?: \d\d:\d\d)? ?:? ?)?QA\b(?!.*(?:^|\s)(?:0|aucun) (?:bloquant|majeur)).*(?:bloquant|majeur)/s.test(String(n.text))).length;
    const real = planLoader(repo)().lots();
    expect(real.length).toBeGreaterThan(100);
    expect(real.flatMap((l) => l.notes).filter((n) => isQaDefectNote(n.text)).length).toBe(independent);
    if (independent === 0) {
      const r = computePerf({ journals: [], plans: new Map([['cadence', real]]), cache: new Map(), windows: perfWindows(TODAY), today: TODAY });
      expect(r.throughput.escaped.current).toBeNull();
    }
  });
});

describe('cadence perf — interventions du lead (R10)', () => {
  const handed = async (c: Ctx) => (await json(c.root)).data.interventions.handedOut;

  it('R10 — handed-back dont le plan est done après le rendu = 1 intervention', async () => {
    const c = ctx();
    journal(c, CUR, { lot: 'P1', status: 'handed-back' });
    journal(c, CUR, { lot: 'P2', status: 'ready' });
    plan(c.root, 'alpha', [{ id: 'P1', finished: '2026-10-14' }, { id: 'P2', finished: '2026-10-14' }]);
    const h = await handed(c);
    expect(h.count.current).toBe(1);
    expect(h.current).toBe(0.5);
  });

  it('R10 — handed-back encore doing n\'est pas compté comme terminé', async () => {
    const c = ctx();
    journal(c, CUR, { lot: 'P1', status: 'handed-back' });
    plan(c.root, 'alpha', [{ id: 'P1', status: 'doing' }]);
    expect((await handed(c)).count.current).toBe(0);
  });

  it('R10 — 3 sessions ux sur 2 lots visibles = 1,5', async () => {
    const c = ctx();
    journal(c, CUR, { visible: true, ux: 2 });
    journal(c, CUR, { visible: true, ux: 1 });
    journal(c, CUR, { visible: false, ux: 5 });
    expect((await json(c.root)).data.interventions.ux.current).toBe(1.5);
  });

  it('R10 — un lot ready terminé par la vague n\'est pas une intervention', async () => {
    const c = ctx();
    journal(c, CUR, { lot: 'P1', status: 'ready' });
    plan(c.root, 'alpha', [{ id: 'P1', finished: '2026-10-13' }]);
    expect((await handed(c)).count.current).toBe(0);
  });

  it('R10 — lot rejoué : handed-back en vague 1 puis ready en vague 2, plan done : aucune intervention', async () => {
    const c = ctx();
    journal(c, '2026-10-11', { lot: 'P1', status: 'handed-back' });
    writeWave(c.runs, 'w2', at('2026-10-12', '08:00:00'));
    journal(c, '2026-10-13', { lot: 'P1', status: 'ready', wave: 'w2' });
    plan(c.root, 'alpha', [{ id: 'P1', finished: '2026-10-14' }]);
    expect((await handed(c)).count.current).toBe(0);
    journal(c, '2026-10-15', { lot: 'P1', status: 'implementing', wave: 'w2', project: 'alpha' });
    expect((await handed(c)).count.current).toBe(0);
  });

  it('R10 — un projet imbriqué « groupe/gamma » se joint à son plan ; un projet direct se joint par son nom', async () => {
    const c = ctx();
    journal(c, CUR, { project: 'groupe/gamma', lot: 'G1', status: 'handed-back' });
    journal(c, CUR, { project: 'alpha', lot: 'A1', status: 'failed' });
    plan(c.root, 'groupe/gamma', [{ id: 'G1', finished: CUR }]);
    plan(c.root, 'alpha', [{ id: 'A1', finished: CUR }]);
    const r = await json(c.root);
    expect(r.data.interventions.handedOut.count.current).toBe(2);
    expect(r.data.orphans).toBe(0);
  });

  it('R10 — un lot « Q4/accueil-4-ux12 » du journal se joint au lot Q4 du plan, l\'id lu dans le champ lot et non dans le nom de fichier', async () => {
    const c = ctx();
    journal(c, CUR, { lot: 'Q4/accueil-4-ux12', status: 'handed-back' });
    plan(c.root, 'alpha', [{ id: 'Q4', finished: CUR }]);
    const r = await json(c.root);
    expect(readdirSync(join(c.runs, 'w1'))).toContain('alpha--Q4__accueil-4-ux12.json');
    expect(r.data.interventions.handedOut.count.current).toBe(1);
  });
});

describe('cadence perf — jumeaux et ⚠', () => {
  /** n lots de la fenêtre, `passesOf(i)` passes chacun. */
  const lots = (c: Ctx, day: string, n: number, o: (i: number) => JOpts = () => ({})) => many(n, (i) => journal(c, day, o(i)));
  const warned = async (c: Ctx, label: string) => (await cad(c.root)).out.find((l) => l.includes(label))!;

  it('R12 — rendus par jour 1,0 → 0,7 : ⚠ ; 1,0 → 0,8 : pas de ⚠', async () => {
    const c = ctx();
    lots(c, PREV, 7);
    lots(c, CUR, 5);
    expect(await warned(c, 'rendus par jour')).toMatch(/^⚠ rendus par jour : 0,7 \(précédente 1, −29 %\)/);
    const d = ctx();
    lots(d, PREV, 7);
    lots(d, CUR, 6);
    expect(await warned(d, 'rendus par jour')).not.toContain('⚠');
  });

  it('R12 — médiane de passes 1 → 1,5 : ⚠ ; 1 → 0,5 : pas de ⚠', async () => {
    const up = ctx();
    lots(up, PREV, 6, () => ({ passes: 1 }));
    lots(up, CUR, 6, (i) => ({ passes: i < 3 ? 1 : 2 }));
    expect(await warned(up, 'médiane de passes')).toContain('⚠');
    const down = ctx();
    lots(down, PREV, 6, () => ({ passes: 1 }));
    lots(down, CUR, 6, (i) => ({ passes: i < 3 ? 0 : 1 }));
    expect(await warned(down, 'médiane de passes')).not.toContain('⚠');
  });

  it('R12 — pile 25 % : pas de ⚠', async () => {
    const c = ctx();
    lots(c, PREV, 5, (i) => ({ budget: 100, counted: i < 4 ? 50 : 500 }));
    lots(c, CUR, 5, (i) => ({ budget: 100, counted: i < 3 ? 50 : 500 }));
    const line = await warned(c, 'part des rendus sur budget');
    expect(line).toContain('60 % (précédente 80 %, −25 %)');
    expect(line).not.toContain('⚠');
  });

  it('R12 — la ligne ⚠ finit par la décision de l\'indicateur', async () => {
    const c = ctx();
    lots(c, PREV, 7);
    lots(c, CUR, 5);
    const line = await warned(c, 'rendus par jour');
    expect(line.endsWith('→ le flux baisse : chercher le goulot avant d\'ajouter des lots')).toBe(true);
    expect((await json(c.root)).data.warnings[0]).toContain('→ le flux baisse');
    // les lots prêts n'ont pas de ⚠ même en baisse
    expect(await warned(c, 'prêts')).not.toContain('⚠');
  });

  it('R12 — le jumeau de qualité porte son propre ⚠ quand il se dégrade', async () => {
    const c = ctx();
    lots(c, PREV, 6, () => ({ passes: 0 }));
    lots(c, CUR, 6, (i) => ({ passes: i < 3 ? 0 : 1 }));
    const line = (await cad(c.root)).out.find((l) => /^.\s?part conforme/.test(l.trimStart()) || l.trimStart().startsWith('⚠ part conforme'))!;
    expect(line).toMatch(/^⚠ part conforme du premier coup : 50 % \(précédente 100 %, −50 %\)/);
  });

  it('R13 — 4 lots dans la courante : pas de ⚠ malgré −50 %', async () => {
    const c = ctx();
    lots(c, PREV, 8);
    lots(c, CUR, 4);
    const line = await warned(c, 'rendus par jour');
    expect(line).not.toContain('⚠');
    expect(line).toContain('pas de tendance : échantillon');
  });

  it('R13 — valeur précédente 0 : pas de ⚠, pas de division par zéro', async () => {
    const c = ctx();
    lots(c, PREV, 5, () => ({ passes: 0 }));
    lots(c, CUR, 5, () => ({ passes: 1 }));
    const r = await json(c.root);
    expect(r.data.corrections.medianPasses).toMatchObject({ previous: 0, current: 1, change: null, warn: false });
    expect((await warned(c, 'médiane de passes'))).not.toContain('⚠');
    expect(JSON.stringify(r.data)).not.toMatch(/Infinity|NaN/);
  });

  it('R13 — fenêtre tronquée par --since : pas de ⚠ et mention', async () => {
    const c = ctx();
    writeWave(c.runs, 'w2', at('2026-10-08', '08:00:00'));
    lots(c, '2026-10-08', 7, () => ({ wave: 'w2' }));
    lots(c, CUR, 5, () => ({ wave: 'w2' }));
    const r = await cad(c.root, '--since', '2026-10-08');
    const line = r.out.find((l) => l.includes('rendus par jour'))!;
    expect(line).not.toContain('⚠');
    expect(line).toContain('fenêtre tronquée');
  });

  it('R14 — fenêtre précédente vide : n/d et pas de ⚠', async () => {
    const c = ctx();
    lots(c, CUR, 6);
    const r = await json(c.root);
    expect(r.data.throughput.rendered).toMatchObject({ previous: null, warn: false, change: null });
    expect((await cad(c.root)).out.find((l) => l.includes('rendus par jour'))).toContain('précédente n/d');
  });

  it('R14 — médiane de passes sans lot = null en JSON, jamais 0', async () => {
    const c = ctx();
    const r = await json(c.root);
    expect(r.data.corrections.medianPasses.current).toBeNull();
    expect(r.data.corrections.atLeast2.current).toBeNull();
    expect(r.data.throughput.rendered.current).toBeNull();
  });
});

describe('cadence perf — lecture des journaux et des plans', () => {
  it('R15 — un journal d\'un projet absent du dossier est compté orphelin, hors terminé hors vague', async () => {
    const c = ctx();
    journal(c, CUR, { project: 'fantome', lot: 'F1', status: 'handed-back' });
    journal(c, CUR, { lot: 'P1' });
    plan(c.root, 'alpha', [{ id: 'P1', finished: CUR }]);
    const r = await json(c.root);
    expect(r.data.orphans).toBe(1);
    expect(r.data.throughput.rendered.lots.current).toBe(2);
    expect(r.data.interventions.handedOut.count.current).toBe(0);
  });

  it('R15 — le compte d\'orphelins est imprimé', async () => {
    const c = ctx();
    journal(c, CUR, { project: 'fantome', lot: 'F1' });
    journal(c, CUR, { project: 'fantome', lot: 'F2' });
    plan(c.root, 'alpha', [{ id: 'P1' }]);
    expect((await cad(c.root)).text).toContain('2 lot(s) de journal sans plan');
  });

  it('R16 — un plan illisible : avertissement, autres projets lus', async () => {
    const c = ctx();
    journal(c, CUR);
    plan(c.root, 'alpha', [{ id: 'P1', finished: CUR }]);
    plan(c.root, 'cassé', []);
    writeFileSync(join(c.root, 'cassé', 'docs', 'plan', 'raf.yaml'), 'version: 1\nlots: [pas\n un: yaml');
    const r = await json(c.root);
    expect(r.code).toBe(0);
    expect(r.err).toContain('perf : plan illisible, projet cassé sauté');
    expect(r.data.throughput.delivered.current).toBe(1);
  });

  it('R16 — aucun plan : indicateurs de journal servis, ceux du plan n/d', async () => {
    const c = ctx();
    many(2, () => journal(c, CUR, { status: 'handed-back' }));
    const r = await json(c.root);
    expect(r.code).toBe(0);
    expect(r.err.length).toBeGreaterThan(0);
    expect(r.data.throughput.rendered.lots.current).toBe(2);
    expect([r.data.throughput.delivered.current, r.data.interventions.handedOut.current, r.data.throughput.escaped.current]).toEqual([null, null, null]);
  });

  it('R17 — un lot rejoué dans deux vagues est compté deux fois', async () => {
    const c = ctx();
    writeWave(c.runs, 'w2', at('2026-10-11', '08:00:00'));
    journal(c, '2026-10-11', { lot: 'P1', status: 'handed-back' });
    journal(c, '2026-10-12', { lot: 'P1', wave: 'w2' });
    expect((await json(c.root)).data.throughput.rendered.lots.current).toBe(2);
  });

  it('R17 — un wave.json illisible écarte la vague sans échec', async () => {
    const c = ctx();
    writeWave(c.runs, 'w2', null);
    journal(c, CUR, { wave: 'w2' });
    journal(c, CUR);
    const r = await json(c.root);
    expect(r.code).toBe(0);
    expect(r.data.throughput.rendered.lots.current).toBe(1);
  });

  it('R17 — un journal sans steps est ignoré', async () => {
    const c = ctx();
    writeFileSync(join(c.runs, 'w1', 'alpha--X.json'), JSON.stringify({ project: 'alpha', lot: 'X', status: 'ready' }));
    writeFileSync(join(c.runs, 'w1', 'alpha--Y.json'), '{illisible');
    journal(c, CUR);
    expect((await json(c.root)).data.throughput.rendered.lots.current).toBe(1);
  });

  it('R17 — un journal failed sans implement reste dans le débit (R4) et est écarté des passes', async () => {
    const c = ctx();
    journal(c, CUR, { status: 'failed', implement: false });
    const { data } = await json(c.root);
    expect(data.throughput.rendered.lots.current).toBe(1);
    expect(data.corrections.medianPasses.lots.current).toBe(0);
  });

  it('R23 — lot failed sans implement : compté dans rendus par jour, part sur budget et terminé hors vague, absent de R6 et R7', async () => {
    const c = ctx();
    journal(c, CUR, { lot: 'P1', status: 'failed', implement: false, budget: 100, counted: 10, passes: 1 });
    plan(c.root, 'alpha', [{ id: 'P1', finished: '2026-10-14' }]);
    const { data } = await json(c.root);
    expect(data.throughput.rendered.current).toBeCloseTo(1 / 7);
    expect(data.throughput.onBudget.current).toBe(1);
    expect(data.interventions.handedOut.count.current).toBe(1);
    expect(data.corrections.medianPasses.lots.current).toBe(0);
    expect(data.corrections.causes.current).toMatchObject({ classified: 0, unclassified: 0, withoutFindings: 0 });
  });
});

describe('cadence perf — goulot (R19)', () => {
  /** `n` passes à constats d'une même cause (au cache) dans la fenêtre courante, plus `others` passes d'une autre cause. */
  function causes(c: Ctx, spec: { cause: Classification['cause'] | null; n: number }[]): void {
    const entries: Record<string, Classification> = {};
    for (const { cause, n } of spec) {
      many(n, () => {
        const j = journal(c, CUR, { passes: 1 });
        if (cause) entries[`${j.wave}/${j.project}--${j.lot}/3`] = { cause, by: 'm' };
      });
    }
    writeFileSync(join(c.root, '.cadence', 'corrections.json'), JSON.stringify(entries));
  }

  it('R19 — 6 passes de bug-code sur 10 classées : ⚠ goulot', async () => {
    const c = ctx();
    causes(c, [{ cause: 'bug-code', n: 6 }, { cause: 'spec-floue', n: 4 }]);
    const r = await json(c.root);
    expect(r.data.warnings).toContain('⚠ goulot : bug de code pèse 6 passes classées sur 10 → quel maillon corriger');
    expect((await cad(c.root)).text).toContain('⚠ goulot : bug de code');
  });

  it('R19 — 5 sur 9 classées : pas de ⚠ (moins de 10)', async () => {
    const c = ctx();
    causes(c, [{ cause: 'bug-code', n: 5 }, { cause: 'spec-floue', n: 4 }]);
    expect((await json(c.root)).data.warnings).toEqual([]);
  });

  it('R19 — 4 sur 10 : pas de ⚠', async () => {
    const c = ctx();
    causes(c, [{ cause: 'bug-code', n: 4 }, { cause: 'spec-floue', n: 3 }, { cause: 'test-manquant', n: 3 }]);
    expect((await json(c.root)).data.warnings).toEqual([]);
  });

  it('R19 — fenêtre de 10 passes dont 5 tests rouges sans cache et 5 à constats classées bug-code au cache : les 5 tests rouges sont sans-constat (comme chez cadence corrections), 5 passes classées seulement : pas de ⚠ goulot', async () => {
    const c = ctx();
    causes(c, [{ cause: 'bug-code', n: 5 }]);
    many(5, () => {
      // deux passes fix de suite : la seconde (tests rouges) n'a pas de constat à lire
      writeJournal(c.runs, 'w1', 'alpha', `R${++seq}`, { steps: [{ kind: 'implement', ended: at(CUR) }, { kind: 'review', constats: ['x'], ended: at(CUR) }, { kind: 'fix', ended: at(CUR) }, { kind: 'fix', ended: at(CUR) }] });
    });
    const r = await json(c.root);
    const w = r.data.corrections.causes.current;
    expect(w.withoutFindings).toBe(5);
    expect(w.classified).toBe(5);
    expect(w.unclassified).toBe(5);
    expect(r.data.warnings).toEqual([]);
  });
});

describe('cadence perf — même classification que cadence corrections (R23)', () => {
  async function corrections(c: Ctx) {
    const out: string[] = [];
    await run(['corrections', '--json'], { cwd: c.root, env: {}, out: (l) => out.push(l), err: () => {}, now: () => new Date() });
    return JSON.parse(out.join('\n')).byCause as Record<string, number>;
  }

  it('R23 — une passe de tests rouges (fix juste après une autre passe fix, sans cache) est sans-constat pour perf comme pour cadence corrections', async () => {
    const c = ctx();
    writeJournal(c.runs, 'w1', 'alpha', 'A', { steps: [{ kind: 'implement', ended: at(CUR) }, { kind: 'review', constats: ['x'], ended: at(CUR) }, { kind: 'fix', ended: at(CUR) }, { kind: 'fix', ended: at(CUR) }] });
    const mine = (await json(c.root)).data.corrections.causes.current;
    const theirs = await corrections(c);
    expect([mine.withoutFindings, mine.unclassified]).toEqual([theirs['sans-constat'], theirs['non-classe']]);
    expect(mine.withoutFindings).toBe(1);
  });

  it('R23 — une passe à constats absente du cache est non-classe pour perf comme pour cadence corrections', async () => {
    const c = ctx();
    journal(c, CUR, { passes: 2 });
    const mine = (await json(c.root)).data.corrections.causes.current;
    const theirs = await corrections(c);
    expect(mine.unclassified).toBe(theirs['non-classe']);
    expect(mine.unclassified).toBe(2);
  });

  it('R23 — une passe sans revue précédente lisible est sans-constat pour perf comme pour cadence corrections', async () => {
    const c = ctx();
    writeJournal(c.runs, 'w1', 'alpha', 'A', { steps: [{ kind: 'implement', ended: at(CUR) }, { kind: 'fix', ended: at(CUR) }] });
    const mine = (await json(c.root)).data.corrections.causes.current;
    const theirs = await corrections(c);
    expect(mine.withoutFindings).toBe(theirs['sans-constat']);
    expect(mine.withoutFindings).toBe(1);
  });

  it('R23 — readRuns et cadence corrections donnent la même sortie qu\'avant sur les mêmes journaux', async () => {
    const c = ctx();
    journal(c, CUR, { passes: 1 });
    journal(c, CUR, { status: 'failed', implement: false });
    const runs = readRuns(c.runs);
    expect(runs.lots).toHaveLength(1);
    expect(runs.passes).toHaveLength(1);
    expect((await corrections(c))['non-classe']).toBe(1);
  });
});

describe('cadence perf — sortie, erreurs, lecture seule', () => {
  it('R18 — après la commande, l\'arbre du dossier est inchangé (aucun fichier créé ni modifié)', async () => {
    const c = ctx();
    journal(c, CUR, { passes: 1 });
    plan(c.root, 'alpha', [{ id: 'P1' }]);
    writeFileSync(join(c.root, '.cadence', 'corrections.json'), '{}');
    const before = tree(c.root);
    await cad(c.root);
    await cad(c.root, '--json');
    expect(tree(c.root)).toEqual(before);
  });

  it('R18 — un ⚠ imprimé et le code de sortie vaut 0', async () => {
    const c = ctx();
    many(7, () => journal(c, PREV));
    many(5, () => journal(c, CUR));
    const r = await cad(c.root);
    expect(r.text).toContain('⚠');
    expect(r.code).toBe(0);
  });

  it('R18 — aucun appel à fetch', async () => {
    const c = ctx();
    journal(c, CUR, { passes: 1 });
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    try {
      await cad(c.root);
      await cad(c.root, '--json');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('R11 — la sortie JSON n\'a aucune clé de lignes, de commits ni de tokens consommés au total', async () => {
    const c = ctx();
    journal(c, CUR, { passes: 1, budget: 1000, counted: 10 });
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
    };
    walk((await json(c.root)).data);
    expect(keys.filter((k) => /ligne|line|commit|token|consomm|consumed/i.test(k))).toEqual([]);
  });

  it('R11 — le texte n\'imprime aucun nombre de commits ni de lignes', async () => {
    const c = ctx();
    journal(c, CUR, { passes: 1, budget: 1000, counted: 10 });
    expect((await cad(c.root)).text).not.toMatch(/commit|lignes? de code|token/i);
  });

  it('R20 — --json imprime un seul objet JSON parsable avec les clés windows, throughput, corrections, interventions, warnings', async () => {
    const c = ctx();
    journal(c, CUR);
    const r = await cad(c.root, '--json');
    expect(r.out).toHaveLength(1);
    const data = JSON.parse(r.out[0]!);
    expect(Object.keys(data)).toEqual(['since', 'today', 'windows', 'throughput', 'corrections', 'interventions', 'orphans', 'warnings']);
    expect(data.today).toBe(TODAY);
  });

  it('R20 — chaque indicateur porte current, previous, change, warn, twin', async () => {
    const c = ctx();
    journal(c, CUR);
    const { data } = await json(c.root);
    const inds = [...Object.values(data.throughput), data.corrections.medianPasses, data.corrections.atLeast2, data.corrections.firstTime, data.interventions.handedOut, data.interventions.ux] as Record<string, unknown>[];
    expect(inds).toHaveLength(10);
    for (const i of inds) for (const k of ['current', 'previous', 'change', 'warn', 'twin']) expect(i).toHaveProperty(k);
  });

  it('R20 — les nombres du JSON égalent ceux du texte', async () => {
    const c = ctx();
    many(4, () => journal(c, PREV, { passes: 1 }));
    many(3, () => journal(c, CUR, { passes: 2 }));
    const { data } = await json(c.root);
    const text = (await cad(c.root)).text;
    expect(data.corrections.medianPasses.current).toBe(2);
    expect(text).toContain('médiane de passes de correction par lot : 2 (précédente 1, +100 %)');
    expect(text).toContain(`rendus par jour : ${String(data.throughput.rendered.current.toFixed(1)).replace('.', ',')} (précédente ${String(data.throughput.rendered.previous.toFixed(1)).replace('.', ',')}`);
  });

  it('R21 — deux dossiers : usage', async () => {
    const c = ctx();
    const r = await cad(c.root, 'a', 'b');
    expect(r.code).toBe(1);
    expect(r.err.join()).toContain('usage : cadence perf [dossier] [--since date] [--json]');
  });

  it('R21 — --since pas-une-date : message d\'invalidité', async () => {
    const c = ctx();
    const r = await cad(c.root, '--since', 'demain');
    expect(r.code).toBe(1);
    expect(r.err.join()).toContain('--since invalide : demain (une date ISO, ex. 2026-10-10T18:31Z)');
  });

  it('R21 — dossier sans .cadence/runs : « perf : aucun journal de vague dans … »', async () => {
    const root = tempDir();
    const r = await cad(root);
    expect(r.code).toBe(1);
    expect(r.err.join()).toContain(`perf : aucun journal de vague dans ${join(root, '.cadence', 'runs')}`);
    expect(r.out).toEqual([]);
  });

  it('R21 — corrections.json illisible : l\'erreur de readCache, rien sur la sortie', async () => {
    const c = ctx();
    journal(c, CUR);
    const file = join(c.root, '.cadence', 'corrections.json');
    writeFileSync(file, '[1,2');
    const r = await cad(c.root);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err.join()).toContain(`${file} : JSON illisible (un objet clé → classement est attendu), corrigez ou supprimez le fichier`);
    expect(() => readCache(file)).toThrow(/JSON illisible/);
  });

  it('R22 — cadence perf <dossier> lit les journaux de ce dossier', async () => {
    const c = ctx();
    journal(c, CUR);
    journal(c, CUR);
    const other = tempDir();
    const r = await json(other, c.root);
    expect(r.data.throughput.rendered.lots.current).toBe(2);
  });

  it('R22 — un projet à un niveau d\'imbrication est lu', () => {
    const c = ctx();
    plan(c.root, 'groupe/gamma', [{ id: 'G1' }]);
    plan(c.root, 'alpha', [{ id: 'A1' }]);
    expect([...readPlans(c.root, () => {}).keys()]).toEqual(['alpha', 'groupe/gamma']);
  });

  it('R22 — l\'aide liste « cadence perf [dossier] [--since date] [--json] »', async () => {
    const out: string[] = [];
    await run(['help'], { cwd: tempDir(), env: {}, out: (l) => out.push(l), err: () => {}, now: () => new Date() });
    expect(out.join('\n')).toContain('cadence perf [dossier] [--since date] [--json]');
    const bin = readFileSync(new URL('../bin/cadence.js', import.meta.url), 'utf8');
    expect(bin).toContain('cadence perf [dossier] [--since date] [--json]');
    expect(bin).toContain("'perf'");
  });
});
