import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { run } from '../src/cli.js';
import { planLoader, readPerfConfig } from '../src/config.js';
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

interface PLot { id: string; status?: string; finished?: string; created?: string; estimate?: number; notes?: [string, string][] }
function plan(root: string, name: string, lots: PLot[]): void {
  const dir = join(root, name);
  mkdirSync(join(dir, 'docs', 'plan'), { recursive: true });
  const body = lots.map((l) => [`  - id: ${l.id}`, '    title: "t"', `    status: ${l.status ?? 'done'}`, ...(l.estimate === undefined ? [] : [`    estimate: ${l.estimate}`]), ...(l.created ? [`    created: ${l.created}`] : []), ...(l.finished ? [`    finished: ${l.finished}`] : []), ...(l.notes ? ['    notes:', ...l.notes.map(([d, t]) => `      - { date: ${d}, text: ${JSON.stringify(t)} }`)] : [])].join('\n')).join('\n');
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

  it('R11 — la sortie JSON n\'a aucune clé de lignes, de commits ni de tokens consommés au total (précisée par R13 de L226 : seules des médianes par lot sont admises)', async () => {
    const c = ctx();
    journal(c, CUR, { passes: 1, budget: 1000, counted: 10 });
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
    };
    walk((await json(c.root)).data);
    expect(keys.filter((k) => /ligne|line|commit|consomm|consumed|total/i.test(k))).toEqual([]);
  });

  it('R11 — le texte n\'imprime aucun nombre de commits ni de lignes', async () => {
    const c = ctx();
    journal(c, CUR, { passes: 1, budget: 1000, counted: 10 });
    expect((await cad(c.root)).text).not.toMatch(/commit|lignes? de code|total/i);
  });

  it('R20 — --json imprime un seul objet JSON parsable avec les clés windows, throughput, corrections, interventions, warnings', async () => {
    const c = ctx();
    journal(c, CUR);
    const r = await cad(c.root, '--json');
    expect(r.out).toHaveLength(1);
    const data = JSON.parse(r.out[0]!);
    expect(Object.keys(data)).toEqual(['since', 'today', 'windows', 'throughput', 'corrections', 'interventions', 'tokens', 'delays', 'durations', 'cost', 'orphans', 'warnings']);
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

// ── L226 : tokens, délais, durées, coût ─────────────────────────────────────────────────────────

/** Un journal d'un lot du plan, rendu le `d` : une étape implement (ou les étapes données). */
function lotJournal(c: Ctx, d: string, id: string, o: { counted?: number; steps?: PStep[]; status?: string; project?: string; wave?: string } = {}) {
  const steps = o.steps ?? [{ kind: 'implement', ended: at(d, '09:00:00'), ...(o.counted === undefined ? {} : { counted: o.counted }) }];
  writeJournal(c.runs, o.wave ?? 'w1', o.project ?? 'alpha', id, { status: o.status ?? 'ready', steps });
}
/** n lots done (L<prefix>0…) finis le `finished`, créés le `created`, avec le journal de chaque lot si `counted` est donné. */
function doneLots(c: Ctx, prefix: string, n: number, finished: string, created: string, estimate = 1, counted?: number): PLot[] {
  return many(n, (i) => {
    const id = `${prefix}${i}`;
    if (counted !== undefined) lotJournal(c, finished, id, { counted });
    return { id, finished, created, estimate };
  });
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
function initRepo(dir: string, deliveries?: string[]): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  if (deliveries) {
    mkdirSync(join(dir, '.git', 'cadence'));
    writeFileSync(join(dir, '.git', 'cadence', 'deliveries.log'), deliveries.map((l) => `${l}\n`).join(''));
  }
}

describe('cadence perf — tokens par estimate et part de revue (R2, R3)', () => {
  it('R2 — trois lots d\'estimate 0.5 à 100 k, 200 k, 300 k : médiane 200 k pour la classe 0.5', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [...doneLots(c, 'A', 1, CUR, '2026-10-01', 0.5, 100_000), ...doneLots(c, 'B', 1, CUR, '2026-10-01', 0.5, 200_000), ...doneLots(c, 'C', 1, CUR, '2026-10-01', 0.5, 300_000)]);
    const { data } = await json(c.root);
    expect(data.tokens.byEstimate['0.5'].current).toBe(200_000);
    expect(data.tokens.byEstimate['0.5'].lots.current).toBe(3);
  });

  it('R2 — deux estimates (0.5 et 1) donnent deux classes séparées', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [...doneLots(c, 'A', 1, CUR, '2026-10-01', 0.5, 100_000), ...doneLots(c, 'B', 1, CUR, '2026-10-01', 1, 400_000)]);
    const { data } = await json(c.root);
    expect(Object.keys(data.tokens.byEstimate).sort()).toEqual(['0.5', '1']);
    expect([data.tokens.byEstimate['0.5'].current, data.tokens.byEstimate['1'].current]).toEqual([100_000, 400_000]);
  });

  it('R2 — les classes d\'estimate s\'impriment par estimate croissant, 0.5 avant 1', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [...doneLots(c, 'A', 1, CUR, '2026-10-01', 2, 100_000), ...doneLots(c, 'B', 1, CUR, '2026-10-01', 0.5, 100_000), ...doneLots(c, 'C', 1, CUR, '2026-10-01', 1, 100_000)]);
    const { text } = await cad(c.root);
    const at = (k: string) => text.indexOf(`tokens par lot (estimate ${k})`);
    expect(at('0.5')).toBeGreaterThan(-1);
    expect(at('0.5')).toBeLessThan(at('1'));
    expect(at('1')).toBeLessThan(at('2'));
  });

  it('R2 — un orphelin et un journal sans jetons lisibles n\'entrent pas', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [...doneLots(c, 'A', 1, CUR, '2026-10-01', 0.5, 100_000), ...doneLots(c, 'B', 1, CUR, '2026-10-01', 0.5)]);
    lotJournal(c, CUR, 'B0', { steps: [{ kind: 'implement', ended: at(CUR), tokens: null }] });
    lotJournal(c, CUR, 'Z9', { counted: 900_000 });
    const { data } = await json(c.root);
    expect(data.tokens.byEstimate['0.5'].current).toBe(100_000);
    expect(data.tokens.byEstimate['0.5'].lots.current).toBe(1);
  });

  it('R2 — un lot failed compte (il a dépensé)', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A0', status: 'todo', estimate: 1 }]);
    lotJournal(c, CUR, 'A0', { counted: 250_000, status: 'failed' });
    const { data } = await json(c.root);
    expect(data.tokens.byEstimate['1'].current).toBe(250_000);
  });

  it('R3 — 300 k en implement, 100 k en review, 100 k en ux : part 40 %', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A0' }]);
    lotJournal(c, CUR, 'A0', { steps: [{ kind: 'implement', counted: 300_000, ended: at(CUR, '09:00:00') }, { kind: 'review', counted: 100_000, ended: at(CUR, '10:00:00') }, { kind: 'ux', counted: 100_000, ended: at(CUR, '11:00:00') }] });
    const { data, text } = await json(c.root).then(async (r) => ({ data: r.data, text: (await cad(c.root)).text }));
    expect(data.tokens.reviewShare.current).toBeCloseTo(0.4, 9);
    expect(text).toContain('part des tokens de revue : 40 %');
  });

  it('R3 — une étape review-small compte, une étape fiche ne compte pas dans la revue', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A0' }]);
    lotJournal(c, CUR, 'A0', { steps: [{ kind: 'implement', counted: 100_000, ended: at(CUR, '09:00:00') }, { kind: 'review-small', counted: 50_000, ended: at(CUR, '10:00:00') }, { kind: 'fiche', counted: 50_000, ended: at(CUR, '11:00:00') }] });
    const { data } = await json(c.root);
    expect(data.tokens.reviewShare.current).toBeCloseTo(0.25, 9);
  });

  it('R3 — aucun journal rendu : n/d, pas 0 %', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A0' }]);
    lotJournal(c, PREV, 'A0', { steps: [{ kind: 'review', counted: 10, ended: at(PREV) }, { kind: 'implement', counted: 10, ended: at(PREV) }] });
    const { data } = await json(c.root);
    expect(data.tokens.reviewShare.current).toBeNull();
    expect(data.tokens.reviewShare.previous).toBeCloseTo(0.5, 9);
    expect(data.tokens.reviewShare.warn).toBe(false);
  });
});

describe('cadence perf — délais création → done et done → livraison (R4, R5)', () => {
  it('R4 — created 05-10, finished 09-10 : 4 jours', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A0', created: '2026-10-05', finished: '2026-10-09' }]);
    const { data } = await json(c.root);
    expect(data.delays.createdToDone.previous).toBe(4);
  });

  it('R4 — médiane de 1, 2, 10 jours = 2', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A', created: '2026-10-11', finished: '2026-10-12' }, { id: 'B', created: '2026-10-10', finished: '2026-10-12' }, { id: 'C', created: '2026-10-02', finished: '2026-10-12' }]);
    const { data } = await json(c.root);
    expect(data.delays.createdToDone.current).toBe(2);
    expect(data.delays.createdToDone.lots.current).toBe(3);
  });

  it('R4 — un lot sans created lisible est écarté, sans erreur', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A', created: '2026-10-10', finished: '2026-10-12' }, { id: 'B', finished: '2026-10-12' }]);
    const r = await json(c.root);
    expect(r.code).toBe(0);
    expect(r.data.delays.createdToDone.current).toBe(2);
    expect(r.data.delays.createdToDone.lots.current).toBe(1);
  });

  it('R4 — un lot done daté hors fenêtre n\'entre pas', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A', created: '2026-09-01', finished: '2026-09-20' }]);
    const { data } = await json(c.root);
    expect([data.delays.createdToDone.current, data.delays.createdToDone.previous]).toEqual([null, null]);
  });

  it('R5 — done le 10-10, livraisons les 09-10 et 12-10 : 2 jours', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A', created: '2026-10-01', finished: '2026-10-10' }]);
    initRepo(join(c.root, 'alpha'), ['2026-10-09 aaa', '2026-10-12 bbb', '2026-10-14 ccc']);
    const { data } = await json(c.root);
    expect(data.delays.doneToDelivered.current).toBe(2);
  });

  it('R5 — livraison le jour même du done : 0 jour (et non n/d)', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A', created: '2026-10-01', finished: '2026-10-10' }]);
    initRepo(join(c.root, 'alpha'), ['2026-10-10 aaa']);
    const { data } = await json(c.root);
    expect(data.delays.doneToDelivered.current).toBe(0);
  });

  it('R5 — aucune livraison après le done : lot écarté, valeur n/d si aucun autre', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A', created: '2026-10-01', finished: '2026-10-12' }]);
    initRepo(join(c.root, 'alpha'), ['2026-10-09 aaa']);
    const { data } = await json(c.root);
    expect(data.delays.doneToDelivered.current).toBeNull();
    expect(data.delays.createdToDone.current).toBe(11);
  });

  it('R5 — deliveries.log absent : n/d sans erreur ni ⚠', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A', created: '2026-10-01', finished: '2026-10-12' }]);
    initRepo(join(c.root, 'alpha'));
    const r = await json(c.root);
    expect(r.code).toBe(0);
    expect(r.err.filter((l) => !l.includes('grille de prix'))).toEqual([]);
    expect(r.data.delays.doneToDelivered).toMatchObject({ current: null, warn: false });
  });

  it('R5 — projet qui n\'est pas un dépôt git : n/d sans erreur', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A', created: '2026-10-01', finished: '2026-10-12' }]);
    const r = await json(c.root);
    expect(r.code).toBe(0);
    expect(r.err.filter((l) => !l.includes('grille de prix'))).toEqual([]);
    expect(r.data.delays.doneToDelivered.current).toBeNull();
  });

  it('R5 — la lecture ne crée pas .git/cadence/ (arbre du dépôt identique)', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A', created: '2026-10-01', finished: '2026-10-12' }]);
    initRepo(join(c.root, 'alpha'));
    const before = tree(join(c.root, 'alpha', '.git'));
    await cad(c.root);
    expect(tree(join(c.root, 'alpha', '.git'))).toEqual(before);
    expect(existsSync(join(c.root, 'alpha', '.git', 'cadence'))).toBe(false);
  });

  it('R5 — deux projets, deux dépôts : chaque lot est rapproché des livraisons de SON dépôt', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A', created: '2026-10-01', finished: '2026-10-10' }]);
    plan(c.root, 'beta', [{ id: 'B', created: '2026-10-01', finished: '2026-10-10' }]);
    initRepo(join(c.root, 'alpha'), ['2026-10-11 a']);
    initRepo(join(c.root, 'beta'), ['2026-10-15 b']);
    const { data } = await json(c.root);
    // médiane de 1 jour (alpha) et 5 jours (beta) = 3
    expect(data.delays.doneToDelivered.current).toBe(3);
    expect(data.delays.doneToDelivered.lots.current).toBe(2);
  });

  it('R5 — projet en worktree : lit le deliveries.log du dépôt commun', async () => {
    const c = ctx();
    const main = join(c.root, 'main');
    initRepo(main, ['2026-10-13 a']);
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '--detach', join(c.root, 'wt'));
    plan(c.root, 'wt', [{ id: 'A', created: '2026-10-01', finished: '2026-10-10' }]);
    const { data } = await json(c.root);
    expect(data.delays.doneToDelivered.current).toBe(3);
  });
});

describe('cadence perf — durée de mur par étape (R6)', () => {
  const stepAt = (kind: string, d: string, from: string, to: string, status = 'ok'): PStep => ({ kind, status, started: at(d, from), ended: at(d, to) });
  async function durations(steps: PStep[]) {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A0' }]);
    lotJournal(c, CUR, 'A0', { steps });
    return json(c.root);
  }

  it('R6 — implement du 16-10 10:00 à 10:30 : 30 minutes', async () => {
    const { data } = await durations([stepAt('implement', '2026-10-16', '10:00:00', '10:30:00')]);
    expect(data.durations.implement.current).toBe(30);
  });

  it('R6 — médiane de 10, 20, 90 minutes = 20', async () => {
    const { data } = await durations([stepAt('review', CUR, '10:00:00', '10:10:00'), stepAt('review', CUR, '11:00:00', '11:20:00'), stepAt('review', CUR, '12:00:00', '13:30:00')]);
    expect(data.durations.review.current).toBe(20);
    expect(data.durations.review.lots.current).toBe(3);
  });

  it('R6 — une étape failed ou running est écartée', async () => {
    const { data } = await durations([stepAt('implement', CUR, '10:00:00', '10:30:00', 'failed'), stepAt('fix', CUR, '10:00:00', '10:30:00', 'running'), stepAt('review', CUR, '10:00:00', '10:15:00')]);
    expect(Object.keys(data.durations)).toEqual(['review']);
  });

  it('R6 — une étape sans started lisible est écartée sans erreur', async () => {
    const r = await durations([{ kind: 'implement', ended: at(CUR), started: 'pas une date' }, { kind: 'fix', ended: at(CUR) }, stepAt('review', CUR, '10:00:00', '10:15:00')]);
    expect(r.code).toBe(0);
    expect(Object.keys(r.data.durations)).toEqual(['review']);
  });

  it('R6 — une étape terminée à 23:50 le jour J−6 est dans la courante, à 23:50 le jour J−7 dans la précédente', async () => {
    const { data } = await durations([stepAt('implement', '2026-10-10', '23:20:00', '23:50:00'), stepAt('fix', '2026-10-09', '23:40:00', '23:50:00')]);
    expect([data.durations.implement.current, data.durations.implement.previous]).toEqual([30, null]);
    expect([data.durations.fix.current, data.durations.fix.previous]).toEqual([null, 10]);
  });
});

describe('cadence perf — fenêtres, ⚠ et décisions des nouveaux indicateurs (R1, R12)', () => {
  const delayCase = (c: Ctx, prev: number, cur: number, nPrev = 5, nCur = 5) => {
    const lot = (prefix: string, n: number, finished: string, days: number) => many(n, (i) => ({ id: `${prefix}${i}`, finished, created: addDay(finished, -days) }));
    plan(c.root, 'alpha', [...lot('P', nPrev, '2026-10-07', prev), ...lot('C', nCur, '2026-10-14', cur)]);
  };
  const addDay = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  it('R1 — délai création → done 4 j → 6 j sur 5 lots par fenêtre : ⚠ ; 4 j → 5 j : pas de ⚠', async () => {
    const a = ctx();
    delayCase(a, 4, 6);
    const worse = await cad(a.root);
    expect(worse.text).toMatch(/^⚠ délai création → done : 6 j \(précédente 4 j, \+50 %\)/m);
    const b = ctx();
    delayCase(b, 4, 5);
    expect((await json(b.root)).data.delays.createdToDone.warn).toBe(false);
  });

  it('R1 — 4 lots dans la courante : pas de ⚠ et la ligne dit « pas de tendance : échantillon »', async () => {
    const c = ctx();
    delayCase(c, 4, 6, 5, 4);
    const r = await cad(c.root);
    expect(r.text).not.toMatch(/^⚠ délai création/m);
    expect(r.text).toMatch(/^ {2}délai création → done .*pas de tendance : échantillon/m);
  });

  it('R1 — fenêtre tronquée par --since : pas de ⚠ sur les nouvelles lignes', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [...many(5, (i) => ({ id: `P${i}`, finished: '2026-10-09', created: '2026-10-05' })), ...many(5, (i) => ({ id: `C${i}`, finished: '2026-10-14', created: '2026-10-08' }))]);
    const { data } = await json(c.root, '--since', '2026-10-08');
    expect(data.delays.createdToDone).toMatchObject({ current: 6, previous: 4, warn: false, note: 'fenêtre tronquée' });
  });

  it('R1 — les fonctions de fenêtre et de ⚠ sont celles de L225 (un lot rendu au 8e jour passé est dans la précédente)', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A', created: '2026-10-08', finished: '2026-10-09' }, { id: 'B', created: '2026-10-01', finished: '2026-10-10' }]);
    const { data } = await json(c.root);
    expect([data.delays.createdToDone.previous, data.delays.createdToDone.current]).toEqual([1, 9]);
    expect(data.windows.current.from).toBe('2026-10-10');
  });

  const tokensCase = (c: Ctx, prev: number, cur: number, estimate = 0.5, prefix = 'T') => ({
    lots: [...doneLots(c, `${prefix}P`, 5, PREV, '2026-10-01', estimate, prev), ...doneLots(c, `${prefix}C`, 5, CUR, '2026-10-01', estimate, cur)],
  });

  it('R12 — tokens médians 100 k → 140 k sur 5 lots par fenêtre : ⚠ ; 100 k → 120 k : pas de ⚠', async () => {
    const a = ctx();
    plan(a.root, 'alpha', tokensCase(a, 100_000, 140_000).lots);
    expect((await json(a.root)).data.tokens.byEstimate['0.5'].warn).toBe(true);
    const b = ctx();
    plan(b.root, 'alpha', tokensCase(b, 100_000, 120_000).lots);
    expect((await json(b.root)).data.tokens.byEstimate['0.5'].warn).toBe(false);
  });

  it('R12 — pile 25 % : pas de ⚠', async () => {
    const c = ctx();
    plan(c.root, 'alpha', tokensCase(c, 100_000, 125_000).lots);
    expect((await json(c.root)).data.tokens.byEstimate['0.5']).toMatchObject({ warn: false, change: 0.25 });
  });

  it('R12 — la ligne ⚠ finit par la décision de l\'indicateur', async () => {
    const c = ctx();
    plan(c.root, 'alpha', tokensCase(c, 100_000, 140_000).lots);
    const line = (await cad(c.root)).out.find((l) => l.startsWith('⚠ tokens par lot'))!;
    expect(line).toContain('100 k');
    expect(line).toMatch(/→ l'estimate est mal calibrée : redécouper le lot ou recaler l'estimate et les budgets$/);
  });

  it('R12 — ⚠ sur la classe 0.5 sans ⚠ sur la classe 1', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [...tokensCase(c, 100_000, 140_000, 0.5, 'H').lots, ...tokensCase(c, 100_000, 100_000, 1, 'U').lots]);
    const { data } = await json(c.root);
    expect([data.tokens.byEstimate['0.5'].warn, data.tokens.byEstimate['1'].warn]).toEqual([true, false]);
  });
});

describe('cadence perf — jumeau de qualité, volume et JSON (R11, R13, R14, R17)', () => {
  /** Un plan à un lot done avec journal (3 passes de lignes) pour que tous les indicateurs aient une valeur. */
  function full(): Ctx {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A0', created: '2026-10-05', finished: CUR, estimate: 1 }]);
    lotJournal(c, CUR, 'A0', { steps: [{ kind: 'implement', counted: 100_000, started: at(CUR, '08:00:00'), ended: at(CUR, '09:00:00') }, { kind: 'review', counted: 50_000, started: at(CUR, '09:00:00'), ended: at(CUR, '09:30:00') }] });
    return c;
  }

  it('R11 — chaque nouvelle ligne contient la part conforme du premier coup', async () => {
    const lines = (await cad(full().root)).out;
    for (const label of ['tokens par lot (estimate 1)', 'part des tokens de revue', 'délai création → done', 'durée de mur implement']) {
      const l = lines.find((x) => x.includes(label));
      expect(l, label).toBeDefined();
      expect(l).toContain('part conforme du premier coup : 100 %');
    }
  });

  it('R11 — le JSON lie chaque nouvel indicateur à corrections.firstTime par le champ twin', async () => {
    const { data } = await json(full().root);
    for (const ind of [data.tokens.byEstimate['1'], data.tokens.reviewShare, data.delays.createdToDone, data.delays.doneToDelivered, data.durations.implement]) expect(ind.twin).toBe('corrections.firstTime');
  });

  it('R11 — part conforme du premier coup n/d : la ligne l\'écrit n/d, sans ⚠ de ce chef', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A0', created: '2026-10-05', finished: CUR }]);
    const r = await cad(c.root);
    const line = r.out.find((l) => l.includes('délai création → done'))!;
    expect(line).toContain('part conforme du premier coup : n/d');
    expect(line.startsWith('⚠')).toBe(false);
  });

  it('R13 — la sortie JSON n\'a aucune clé de total de tokens ni d\'euros d\'une fenêtre', async () => {
    const { text } = await json(full().root);
    const keys: string[] = [];
    JSON.parse(text, function (k) { keys.push(k); return this[k]; });
    expect(keys.filter((k) => /total|sum|spent|consumed/i.test(k))).toEqual([]);
  });

  it('R13 — le texte n\'imprime aucun total en tokens ni en euros d\'une fenêtre, seulement des médianes par lot', async () => {
    const c = full();
    // un second lot : le total serait 250 k, la médiane par lot 125 k
    plan(c.root, 'alpha', [{ id: 'A0', created: '2026-10-05', finished: CUR, estimate: 1 }, ...doneLots(c, 'B', 1, CUR, '2026-10-05', 1, 100_000)]);
    const { text } = await cad(c.root);
    expect(text).not.toMatch(/250 k|total/);
    expect(text).toContain('tokens par lot (estimate 1) : 125 k');
  });

  it('R13 — aucun nombre de commits ni de lignes', async () => {
    const { text } = await cad(full().root);
    expect(text).not.toMatch(/commits? :|lignes? de code/i);
  });

  it('R14 — le JSON porte tokens, delays, durations et cost en plus des clés de L225', async () => {
    const { data } = await json(full().root);
    for (const k of ['since', 'today', 'windows', 'throughput', 'corrections', 'interventions', 'orphans', 'warnings', 'tokens', 'delays', 'durations', 'cost']) expect(data).toHaveProperty(k);
    expect(Object.keys(data.tokens).sort()).toEqual(['byEstimate', 'reviewShare']);
    expect(Object.keys(data.delays).sort()).toEqual(['createdToDone', 'doneToDelivered']);
  });

  it('R14 — chaque nouvel indicateur porte current, previous, change, warn, twin', async () => {
    const { data } = await json(full().root);
    for (const ind of [data.tokens.byEstimate['1'], data.tokens.reviewShare, data.delays.createdToDone, data.delays.doneToDelivered, data.durations.implement]) expect(Object.keys(ind)).toEqual(expect.arrayContaining(['current', 'previous', 'change', 'warn', 'twin']));
  });

  it('R14 — les nombres du JSON égalent ceux du texte', async () => {
    const c = full();
    const { data } = await json(c.root);
    const text = (await cad(c.root)).text;
    expect(data.tokens.byEstimate['1'].current).toBe(150_000);
    expect(text).toContain('tokens par lot (estimate 1) : 150 k');
    expect(data.delays.createdToDone.current).toBe(7);
    expect(text).toContain('délai création → done : 7 j');
    expect(data.durations.implement.current).toBe(60);
    expect(text).toContain('durée de mur implement : 60 min');
  });

  it('R14 — sur les mêmes journaux, les clés de L225 sont identiques avant et après le lot', async () => {
    const c = ctx();
    journal(c, CUR, { lot: 'A0', passes: 1 });
    plan(c.root, 'alpha', [{ id: 'A0', finished: CUR }]);
    const { data } = await json(c.root);
    expect(data.throughput.ready).toMatchObject({ current: 1, previous: null, change: null, warn: false, twin: 'throughput.escaped' });
    expect(data.throughput.delivered.current).toBe(1);
    expect(data.corrections.medianPasses.current).toBe(1);
    expect(data.corrections.firstTime.current).toBe(0);
    expect(data.interventions.ux.current).toBeNull();
    expect(data.orphans).toBe(0);
  });

  it('R17 — fenêtre précédente vide : n/d et pas de ⚠ sur chaque nouvel indicateur', async () => {
    const { data } = await json(full().root);
    for (const ind of [data.tokens.byEstimate['1'], data.tokens.reviewShare, data.delays.createdToDone, data.durations.implement]) expect(ind).toMatchObject({ previous: null, warn: false });
  });

  it('R17 — médiane de durée sans étape = null, jamais 0', async () => {
    const { data } = await json(full().root);
    expect(data.durations.implement.previous).toBeNull();
    expect(data.delays.doneToDelivered.current).toBeNull();
  });

  it('R17 — plan illisible : délais et coût n/d, tokens par estimate n/d, durées par étape servies', async () => {
    const c = full();
    writeFileSync(join(c.root, 'alpha', 'docs', 'plan', 'raf.yaml'), 'version: [pas du yaml');
    const r = await json(c.root);
    expect(r.err.some((l) => l.includes('plan illisible'))).toBe(true);
    expect(r.data.delays.createdToDone.current).toBeNull();
    expect(r.data.tokens.byEstimate).toEqual({});
    expect(r.data.durations.implement.current).toBe(60);
  });
});

describe('cadence perf — lecture seule des nouveaux indicateurs (R15)', () => {
  it('R15 — l\'arbre du dossier est inchangé après la commande', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A0', created: '2026-10-05', finished: CUR }]);
    initRepo(join(c.root, 'alpha'), ['2026-10-13 a']);
    lotJournal(c, CUR, 'A0', { counted: 10 });
    const before = tree(c.root);
    await cad(c.root);
    expect(tree(c.root)).toEqual(before);
  });

  it('R15 — un ⚠ imprimé et le code de sortie vaut 0', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [...many(5, (i) => ({ id: `P${i}`, finished: '2026-10-07', created: '2026-10-03' })), ...many(5, (i) => ({ id: `C${i}`, finished: '2026-10-14', created: '2026-10-08' }))]);
    const r = await cad(c.root);
    expect(r.text).toMatch(/^⚠ délai création/m);
    expect(r.code).toBe(0);
  });

  it('R15 — aucun appel à fetch', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A0', created: '2026-10-05', finished: CUR }]);
    const spy = vi.spyOn(globalThis, 'fetch');
    await cad(c.root);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('R15 — .git/cadence/ n\'est pas créé dans un projet qui n\'en avait pas', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A0', created: '2026-10-05', finished: CUR }]);
    initRepo(join(c.root, 'alpha'));
    await cad(c.root);
    expect(existsSync(join(c.root, 'alpha', '.git', 'cadence'))).toBe(false);
  });
});

// ── L226 : grille de prix et coût par lot livré (R7 à R10) ──────────────────────────────────────

const GRID = 'perf:\n  prices:\n    sonnet: { input: 3, output: 15, cacheRead: 0.3 }\n    opus: { input: 15, output: 75, cacheRead: 1.5 }\n    haiku: { input: 1, output: 5, cacheRead: 0.1 }\n';
const M = 1_000_000;
const usage = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({ input, cacheWrite, cacheRead, output, counted: input + cacheWrite + output });

describe('cadence perf — grille de prix (R7)', () => {
  const withGrid = (yaml: string | null): Ctx => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A0', created: '2026-10-05', finished: CUR }]);
    if (yaml !== null) writeFileSync(join(c.root, 'cadence.yaml'), yaml);
    return c;
  };

  it('R7 — grille complète lue : prix de sonnet, opus et haiku', () => {
    const c = withGrid(GRID);
    expect(readPerfConfig(join(c.root, 'cadence.yaml'))).toEqual({ sonnet: { input: 3, output: 15, cacheRead: 0.3 }, opus: { input: 15, output: 75, cacheRead: 1.5 }, haiku: { input: 1, output: 5, cacheRead: 0.1 } });
  });

  it('R7 — perf absent : pas de grille, pas d\'erreur', async () => {
    const c = withGrid('docs:\n  since: 2026-10-09\n');
    expect(readPerfConfig(join(c.root, 'cadence.yaml'))).toBeNull();
    expect(readPerfConfig(join(c.root, 'absent.yaml'))).toBeNull();
    const r = await cad(c.root);
    expect(r.code).toBe(0);
  });

  it('R7 — perf.prices vide : comme une grille absente', () => {
    const c = withGrid('perf:\n  prices: {}\n');
    expect(readPerfConfig(join(c.root, 'cadence.yaml'))).toBeNull();
  });

  async function refused(yaml: string, message: RegExp) {
    const c = withGrid(yaml);
    const r = await cad(c.root);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toMatch(message);
  }

  it('R7 — modèle hors sonnet/opus/haiku : refus nommé, code 1', () => refused('perf:\n  prices:\n    gpt: { input: 1, output: 1, cacheRead: 1 }\n', /^raf: .*cadence\.yaml : perf\.prices\.gpt inconnu \(attendu : sonnet, opus, haiku\)$/));
  it('R7 — prix négatif ou texte : refus nommé', async () => {
    await refused('perf:\n  prices:\n    sonnet: { input: -1, output: 1, cacheRead: 1 }\n', /perf\.prices\.sonnet\.input : nombre ≥ 0 attendu \(€ par million de tokens\)$/);
    await refused('perf:\n  prices:\n    sonnet: { input: 1, output: "cher", cacheRead: 1 }\n', /perf\.prices\.sonnet\.output : nombre ≥ 0 attendu/);
  });
  it('R7 — modèle sans cacheRead : refus nommé', () => refused('perf:\n  prices:\n    opus: { input: 1, output: 1 }\n', /perf\.prices\.opus\.cacheRead : nombre ≥ 0 attendu/));
  it('R7 — clé inconnue sous un modèle : refus nommé', () => refused('perf:\n  prices:\n    opus: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }\n', /perf\.prices\.opus\.cacheWrite inconnu \(attendu : input, output, cacheRead\)$/));
  it('R7 — clé perf.xxx inconnue : refus nommé', () => refused('perf:\n  xxx: 1\n', /perf\.xxx inconnu \(attendu : prices\)$/));
  it('R7 — cadence.yaml illisible : refus avec l\'erreur du fichier, aucune sortie', () => refused('perf: [pas du yaml', /^raf: .*cadence\.yaml illisible : /));

  it('R15 — une grille mal formée : « raf: … » sur la sortie d\'erreur, code 1', () => refused('perf:\n  prices: 5\n', /^raf: .*cadence\.yaml : perf\.prices doit être un objet/));

  it('R7 — la grille mal formée refuse avant toute lecture de journal (aucun dossier de journaux requis)', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'cadence.yaml'), 'perf:\n  xxx: 1\n');
    const r = await cad(root);
    expect(r.err[0]).toMatch(/perf\.xxx inconnu/);
    expect(r.err[0]).not.toMatch(/aucun journal de vague/);
  });
});

describe('cadence perf — coût par lot livré (R8, R9, R10, R12)', () => {
  /** Des lots done dans la courante, chacun avec les étapes données ; la grille GRID (null : pas de cadence.yaml). */
  async function cost(lots: Record<string, PStep[]>, grid: string | null = GRID, extra: PLot[] = []) {
    const c = ctx();
    writeWave(c.runs, 'w2', at('2026-10-02', '08:00:00'));
    plan(c.root, 'alpha', [...Object.keys(lots).map((id) => ({ id, created: '2026-10-05', finished: CUR })), ...extra]);
    for (const [id, steps] of Object.entries(lots)) lotJournal(c, CUR, id, { steps: steps.map((s) => ({ ended: at(CUR, '09:00:00'), ...s })) });
    if (grid !== null) writeFileSync(join(c.root, 'cadence.yaml'), grid);
    return { c, ...(await json(c.root)), plain: (await cad(c.root)).text };
  }
  const impl = (tokens: Record<string, number> | null, model = 'sonnet', extra: Partial<PStep> = {}): PStep => ({ kind: 'implement', model, tokens, ...extra });

  it('R8 — 1 M en entrée à 3 €, 100 k en sortie à 15 € : 3 + 1,5 = 4,5 €', async () => {
    const { data, plain: text } = await cost({ A0: [impl(usage(M, 100_000))] });
    expect(data.cost.perDelivered.current).toBeCloseTo(4.5, 9);
    expect(text).toContain('coût par lot livré : 4,50 €');
  });

  it('R8 — cacheWrite facturé au prix input', async () => {
    const { data } = await cost({ A0: [impl(usage(0, 0, 0, M))] });
    expect(data.cost.perDelivered.current).toBeCloseTo(3, 9);
  });

  it('R8 — cacheRead 2 M à 0,3 € : 0,6 €', async () => {
    const { data } = await cost({ A0: [impl(usage(0, 0, 2 * M))] });
    expect(data.cost.perDelivered.current).toBeCloseTo(0.6, 9);
  });

  it('R8 — étape avec counted seul à 1 M : 0,9 M entrée et 0,1 M sortie, cacheRead 0', async () => {
    const { data } = await cost({ A0: [impl({ counted: M })] });
    expect(data.cost.perDelivered.current).toBeCloseTo(0.9 * 3 + 0.1 * 15, 9);
  });

  it('R8 — étape aux quatre compteurs : le compteur counted n\'est pas réparti', async () => {
    const { data } = await cost({ A0: [impl({ input: M, cacheWrite: 0, cacheRead: 0, output: 0, counted: 5 * M })] });
    expect(data.cost.perDelivered.current).toBeCloseTo(3, 9);
  });

  it('R8 — étape sans tokens (interrompue) : 0 €, le lot reste calculé, aucun avertissement', async () => {
    const { data, err } = await cost({ A0: [impl(null, 'sonnet', { status: 'interrupted' })] });
    expect(data.cost.perDelivered.current).toBe(0);
    expect(data.cost.perDelivered.lots.current).toBe(1);
    expect(err).toEqual([]);
  });

  it('R8 — étape local aux quatre compteurs non nuls (1 M, 1 M, 1 M, 1 M) : 0 €, sans avertissement « modèle sans prix » même sans prix local', async () => {
    const { data, err } = await cost({ A0: [impl({ input: M, cacheWrite: M, cacheRead: M, output: M, counted: 0 }, 'local')] });
    expect(data.cost.perDelivered.current).toBe(0);
    expect(err.join('\n')).not.toContain('modèle sans prix');
  });

  it('R9 — un lot à deux journaux (vague 1 et rejeu) : coûts additionnés', async () => {
    const c = ctx();
    writeWave(c.runs, 'w2', at('2026-10-02', '08:00:00'));
    plan(c.root, 'alpha', [{ id: 'A0', created: '2026-10-05', finished: CUR }]);
    lotJournal(c, CUR, 'A0', { steps: [{ ...impl(usage(M)), ended: at(CUR) }], status: 'handed-back' });
    lotJournal(c, CUR, 'A0', { steps: [{ ...impl(usage(M)), ended: at(CUR) }], wave: 'w2' });
    writeFileSync(join(c.root, 'cadence.yaml'), GRID);
    expect((await json(c.root)).data.cost.perDelivered.current).toBeCloseTo(6, 9);
  });

  it('R9 — un lot dont une session interrompue n\'a pas de jetons reste dans la population du coût, valorisé sur ses autres étapes', async () => {
    const { data } = await cost({ A0: [impl(usage(M)), { kind: 'review', model: 'opus', status: 'interrupted', tokens: null }] });
    expect(data.cost.perDelivered.current).toBeCloseTo(3, 9);
  });

  it('R9 — médiane de 2, 3, 10 € = 3 €', async () => {
    const eur = (e: number) => [impl({ input: (e / 3) * M, cacheWrite: 0, cacheRead: 0, output: 0, counted: 0 })];
    const { data } = await cost({ A0: eur(2), A1: eur(3), A2: eur(10) });
    expect(data.cost.perDelivered.current).toBeCloseTo(3, 9);
    expect(data.cost.perDelivered.lots.current).toBe(3);
  });

  it('R9 — un lot done sans journal est écarté et compté à part', async () => {
    const { data, plain: text } = await cost({ A0: [impl(usage(M))] }, GRID, [{ id: 'B0', created: '2026-10-05', finished: CUR }]);
    expect(data.cost.perDelivered.current).toBeCloseTo(3, 9);
    expect(data.cost.withoutJournal).toEqual({ current: 1, previous: 0 });
    expect(text).toContain('1 lot(s) livré(s) sans journal');
  });

  it('R9 — un journal d\'un lot non done n\'entre pas', async () => {
    const c = ctx();
    plan(c.root, 'alpha', [{ id: 'A0', created: '2026-10-05', finished: CUR }, { id: 'B0', status: 'doing' }]);
    lotJournal(c, CUR, 'A0', { steps: [{ ...impl(usage(M)), ended: at(CUR) }] });
    lotJournal(c, CUR, 'B0', { steps: [{ ...impl(usage(10 * M)), ended: at(CUR) }] });
    writeFileSync(join(c.root, 'cadence.yaml'), GRID);
    const { data } = await json(c.root);
    expect(data.cost.perDelivered.current).toBeCloseTo(3, 9);
    expect(data.cost.perDelivered.lots.current).toBe(1);
  });

  it('R9 — chaque étape est valorisée au prix du modèle de SON étape (implement sonnet, review opus)', async () => {
    const { data } = await cost({ A0: [impl(usage(M)), { kind: 'review', model: 'opus', tokens: usage(M) }] });
    expect(data.cost.perDelivered.current).toBeCloseTo(3 + 15, 9);
  });

  it('R10 — sans grille : coût n/d, avertissement, autres indicateurs servis', async () => {
    const { data, err } = await cost({ A0: [impl(usage(M))] }, null);
    expect(data.cost.perDelivered.current).toBeNull();
    expect(err).toContain('perf : aucune grille de prix (cadence.yaml perf.prices), coût en euros n/d');
    expect(data.tokens.byEstimate['1'].current).toBe(M);
  });

  it('R10 — une étape opus sans prix opus : lot écarté, avertissement nommant opus', async () => {
    const grid = 'perf:\n  prices:\n    sonnet: { input: 3, output: 15, cacheRead: 0.3 }\n';
    const { data, err } = await cost({ A0: [impl(usage(M)), { kind: 'review', model: 'opus', tokens: usage(M) }], A1: [impl(usage(M))] }, grid);
    expect(data.cost.perDelivered.current).toBeCloseTo(3, 9);
    expect(data.cost.perDelivered.lots.current).toBe(1);
    expect(data.cost.withoutPrice).toEqual({ opus: 1 });
    expect(err).toContain('perf : modèle sans prix dans perf.prices : opus, coût n/d pour 1 lot(s)');
  });

  it('R10 — étape sans champ model : lot écarté, avertissement nommant « inconnu »', async () => {
    const { data, err } = await cost({ A0: [{ ...impl(usage(M)), noModel: true }] });
    expect(data.cost.perDelivered.current).toBeNull();
    expect(err).toContain('perf : modèle sans prix dans perf.prices : inconnu, coût n/d pour 1 lot(s)');
  });

  it('R10 — coût n/d : pas de ⚠', async () => {
    const c = ctx();
    const grid = 'perf:\n  prices:\n    sonnet: { input: 3, output: 15, cacheRead: 0.3 }\n';
    plan(c.root, 'alpha', [...many(5, (i) => ({ id: `P${i}`, created: '2026-10-01', finished: PREV })), ...many(5, (i) => ({ id: `C${i}`, created: '2026-10-01', finished: CUR }))]);
    for (let i = 0; i < 5; i++) {
      lotJournal(c, PREV, `P${i}`, { steps: [{ ...impl(usage(M)), ended: at(PREV) }] });
      lotJournal(c, CUR, `C${i}`, { steps: [{ ...impl(usage(M), 'opus'), ended: at(CUR) }] });
    }
    writeFileSync(join(c.root, 'cadence.yaml'), grid);
    const { data } = await json(c.root);
    expect(data.cost.perDelivered).toMatchObject({ current: null, warn: false });
    expect(data.warnings.filter((w: string) => w.includes('coût'))).toEqual([]);
  });

  const fiveAndFive = async (prev: number, cur: number) => {
    const c = ctx();
    plan(c.root, 'alpha', [...many(5, (i) => ({ id: `P${i}`, created: '2026-10-01', finished: PREV })), ...many(5, (i) => ({ id: `C${i}`, created: '2026-10-01', finished: CUR }))]);
    for (let i = 0; i < 5; i++) {
      lotJournal(c, PREV, `P${i}`, { steps: [{ ...impl(usage((prev / 3) * M)), ended: at(PREV) }] });
      lotJournal(c, CUR, `C${i}`, { steps: [{ ...impl(usage((cur / 3) * M)), ended: at(CUR) }] });
    }
    writeFileSync(join(c.root, 'cadence.yaml'), GRID);
    return { c, ...(await json(c.root)) };
  };

  it('R12 — une baisse du coût ne donne pas de ⚠', async () => {
    const { data } = await fiveAndFive(6, 3);
    expect(data.cost.perDelivered).toMatchObject({ warn: false, change: -0.5 });
  });

  it('R12 — la ligne ⚠ du coût finit par sa décision', async () => {
    const { c, data } = await fiveAndFive(3, 6);
    expect(data.cost.perDelivered.warn).toBe(true);
    const line = (await cad(c.root)).out.find((l) => l.startsWith('⚠ coût par lot livré'))!;
    expect(line).toMatch(/6,00 € \(précédente 3,00 €, \+100 %\)/);
    expect(line).toMatch(/→ le modèle ou l'effort d'une étape est-il juste \? changer le modèle de cette étape$/);
  });

  it('R14 — le JSON porte cost { perDelivered, withoutPrice, withoutJournal } avec le jumeau corrections.firstTime', async () => {
    const { data } = await cost({ A0: [impl(usage(M))] });
    expect(Object.keys(data.cost).sort()).toEqual(['perDelivered', 'withoutJournal', 'withoutPrice']);
    expect(data.cost.perDelivered.twin).toBe('corrections.firstTime');
  });

  it('R13 — ni le texte ni le JSON n\'exposent de total en euros', async () => {
    const { data, plain: text } = await cost({ A0: [impl(usage(M))], A1: [impl(usage(M))] });
    expect(text).not.toMatch(/6,00 €/);
    expect(JSON.stringify(data)).not.toMatch(/total/i);
  });

  it('R17 — plan illisible : coût n/d', async () => {
    const { c } = await cost({ A0: [impl(usage(M))] });
    writeFileSync(join(c.root, 'alpha', 'docs', 'plan', 'raf.yaml'), 'version: [pas du yaml');
    const r = await json(c.root);
    expect(r.data.cost.perDelivered.current).toBeNull();
  });

  it('R15 — le coût ne modifie ni cadence.yaml ni le dossier', async () => {
    const { c } = await cost({ A0: [impl(usage(M))] });
    const before = tree(c.root);
    await cad(c.root);
    expect(tree(c.root)).toEqual(before);
  });
});
