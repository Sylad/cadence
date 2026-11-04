import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { ESCALATION_RESERVE } from '../src/orchestrate/cycle.js';
import { lotBudget, lotBudgetBasis, type MeasuredBudgets } from '../src/orchestrate/lot-budget.js';
import { readMeasuredBudgets } from '../src/orchestrate/budget-mesure.js';
import { orchestrate, type OrchestrateIo } from '../src/orchestrate/command.js';
import { candidates } from '../src/orchestrate/continue.js';
import { percentile } from '../src/percentile.js';
import { AGENTS_DIR } from '../src/skills.js';
import { claudeOut, git, reviewReport } from './orchestrate-harness.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';
import { writeJournal, writeWave } from './perf-helpers.js';

// L501 : le budget par défaut d'un lot vient du p90 des tokens par estimate de `cadence perf` (14 jours glissants), borné, et le --dry-run dit d'où il vient.
const TODAY = '2026-10-16';
const at = (time: string, day = '2026-10-14') => `${day}T${time}`;
const measured = (key: string, p90: number, lots: number): MeasuredBudgets => new Map([[key, { p90, lots }]]);

/** Un dossier de projets avec runs : `alpha` porte `n` lots d'estimate `estimate`, chacun rendu avec les tokens donnés (jour par jour si `days` est donné). */
function folder(totals: number[], opts: { estimate?: number; days?: string[]; spec?: boolean } = {}): { dir: string; runs: string } {
  const dir = tempDir();
  const runs = join(dir, '.cadence', 'runs');
  mkdirSync(runs, { recursive: true });
  writeWave(runs, 'w1', at('08:00:00', '2026-10-01'));
  mkdirSync(join(dir, 'alpha', '.cadence'), { recursive: true });
  const body = totals.map((_, i) => `  - id: L${i + 1}\n    title: "t"\n    status: done\n    estimate: ${opts.estimate ?? 0.5}`).join('\n');
  writeFileSync(join(dir, 'alpha', '.cadence', 'raf.yaml'), `version: 1\nproject: "alpha"\nprefix: L\nlots:\n${body}\n`);
  totals.forEach((counted, i) => {
    const day = opts.days?.[i] ?? '2026-10-14';
    const steps = [...(opts.spec ? [{ kind: 'spec', ended: at('08:30:00', day), counted: 1 }] : []), { kind: 'implement', ended: at('09:00:00', day), counted: counted - (opts.spec ? 1 : 0) }];
    writeJournal(runs, 'w1', 'alpha', `L${i + 1}`, { status: 'ready', steps });
  });
  return { dir, runs };
}
async function perf(dir: string) {
  const out: string[] = [];
  await run(['perf', '--json'], { cwd: dir, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: () => {}, now: () => new Date(`${TODAY}T10:00:00`) });
  return JSON.parse(out.join('\n')) as any;
}
const tenTotals = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((k) => k * 1000);

describe('cadence perf — p90 des tokens par estimate (L501)', () => {
  it('R1 — chaque classe d’estimate porte le p90 (rang le plus proche) des tokens de ses lots rendus sur les 14 jours des deux fenêtres, et leur nombre', async () => {
    // 5 lots dans la fenêtre précédente (07-13-10), 5 dans la courante : le p90 les prend ensemble.
    const days = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-14', '2026-10-14', '2026-10-15', '2026-10-15', '2026-10-16'];
    const { dir } = folder(tenTotals, { days });
    const data = await perf(dir);
    expect(data.tokens.byEstimate['0.5'].p90).toBe(900_000);
    expect(data.tokens.byEstimate['0.5'].p90Lots).toBe(10);
  });

  it('R1 — un lot rendu avant les 14 jours n’entre pas dans le p90 (fenêtre glissante)', async () => {
    const { dir } = folder([5_000_000, ...tenTotals.slice(0, 5)], { days: ['2026-09-20', '2026-10-14', '2026-10-14', '2026-10-14', '2026-10-14', '2026-10-14'] });
    const data = await perf(dir);
    expect(data.tokens.byEstimate['0.5'].p90).toBe(500_000);
    expect(data.tokens.byEstimate['0.5'].p90Lots).toBe(5);
  });
});

describe('lotBudget calé sur la mesure (L501)', () => {
  it('R2 — sans mesure, le budget est celui de toujours', () => {
    expect(lotBudget(0.5)).toBe(600_000);
    expect(lotBudget(1)).toBe(750_000);
    expect(lotBudget(0.5, 'spec', false, new Map())).toBe(600_000 + 450_000);
  });

  it('R2 — avec au moins 5 lots mesurés, le budget est le p90 arrondi au 50 k supérieur', () => {
    expect(lotBudget(0.5, undefined, false, measured('0.5', 812_000, 14))).toBe(850_000);
    expect(lotBudget(0.5, undefined, false, measured('0.5', 850_000, 5))).toBe(850_000);
  });

  it('R3 — moins de 5 lots mesurés : le budget statique', () => {
    expect(lotBudget(0.5, undefined, false, measured('0.5', 1_100_000, 4))).toBe(600_000);
  });

  it('R4 — borné : jamais sous le budget statique, jamais au-dessus du double', () => {
    expect(lotBudget(0.5, undefined, false, measured('0.5', 300_000, 20))).toBe(600_000);
    expect(lotBudget(0.5, undefined, false, measured('0.5', 5_000_000, 20))).toBe(1_200_000);
    expect(lotBudget(1, undefined, false, measured('1', 5_000_000, 20))).toBe(1_500_000);
  });

  it('R5 — la classe est celle de la chaîne : un lot à étape spec lit « <estimate>+spec », un lot ordinaire « <estimate> »', () => {
    const m: MeasuredBudgets = new Map([['0.5', { p90: 700_000, lots: 9 }], ['0.5+spec', { p90: 1_300_000, lots: 9 }]]);
    expect(lotBudget(0.5, undefined, false, m)).toBe(700_000);
    expect(lotBudget(0.5, 'spec', false, m)).toBe(1_300_000);
    expect(lotBudget(0.5, 'light', false, m)).toBe(1_300_000);
    expect(lotBudget(0.5, 'screen', false, m)).toBe(1_300_000);
  });

  it('R5 — la mesure d’un lot à étape spec sans mesure de sa classe garde le statique, sans lire la classe ordinaire', () => {
    expect(lotBudget(0.5, 'spec', false, measured('0.5', 900_000, 9))).toBe(1_050_000);
  });

  it('R6 — la part d’escalade s’ajoute au budget mesuré', () => {
    expect(lotBudget(0.5, undefined, true, measured('0.5', 900_000, 9))).toBe(900_000 + ESCALATION_RESERVE);
  });

  it('R7 — la base dit le p90, le nombre de lots, la fenêtre, l’arrondi et les bornes', () => {
    const basis = lotBudgetBasis(0.5, undefined, undefined, measured('0.5', 812_000, 14));
    expect(basis).toContain('p90 mesuré 812000');
    expect(basis).toContain('14 lots');
    expect(basis).toContain('14 derniers jours');
    expect(basis).toContain('arrondi à 850000');
    expect(basis).toContain('borné à 600000–1200000');
  });

  it('R7 — la base dit quand la mesure est trop courte ou sous le plancher', () => {
    expect(lotBudgetBasis(0.5, undefined, undefined, measured('0.5', 1_100_000, 4))).toContain('4 lot(s) mesuré(s) sur 14 jours, il en faut 5');
    expect(lotBudgetBasis(0.5, undefined, undefined, measured('0.5', 300_000, 9))).toContain('sous le budget statique 600000');
    expect(lotBudgetBasis(0.5, undefined, undefined, measured('0.5', 9_000_000, 9))).toContain('plafonné à 1200000');
    expect(lotBudgetBasis(0.5)).toBe("plancher d'un lot jusqu'à 0,5 j");
  });
});

describe('lecture de la mesure (L501)', () => {
  it('R8 — readMeasuredBudgets lit le p90 de chaque classe dans <dossier>/.cadence/runs', () => {
    const { dir } = folder(tenTotals);
    const m = readMeasuredBudgets(dir, TODAY);
    expect(m.get('0.5')).toEqual({ p90: 900_000, lots: 10 });
  });

  it('R8 — pas de dossier .cadence/runs : une mesure vide, pas une erreur', () => {
    expect(readMeasuredBudgets(tempDir(), TODAY).size).toBe(0);
  });

  it('R8 — un journal illisible ou un plan absent ne casse pas la lecture : la classe est ignorée', () => {
    const { dir, runs } = folder(tenTotals);
    writeFileSync(join(runs, 'w1', 'alpha--L1.json'), '{pas du json');
    expect(() => readMeasuredBudgets(dir, TODAY)).not.toThrow();
  });
});

describe('orchestrate --dry-run dit d’où vient le budget (L501)', () => {
  async function dryRun(dir: string): Promise<string> {
    const out: string[] = [];
    const io: OrchestrateIo = { cwd: dir, env: { RAF_TODAY: TODAY, CADENCE_HOME: tempDir() }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date(`${TODAY}T10:00:00`) };
    const claude = async () => claudeOut(reviewReport());
    const code = await orchestrate(['alpha:L99', '--dry-run'], io, { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR });
    const text = out.join('\n');
    try {
      expect(code, text).toBe(0);
    } finally {
      removeDryRunBriefs(text);
    }
    return text;
  }
  function withLot99(dir: string): void {
    const repo = join(dir, 'alpha');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'commit.gpgsign', 'false');
    const file = join(repo, '.cadence', 'raf.yaml');
    const plan = readFileSync(file, 'utf8');
    writeFileSync(file, `${plan}  - id: L99\n    title: "le lot lancé"\n    status: todo\n    estimate: 0.5\n    created: 2026-10-01\n`);
    writeFileSync(join(repo, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
    git(repo, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
    git(repo, 'commit', '-q', '-m', 'chore: plan');
  }

  it('R9 — avec 10 lots mesurés, le budget affiché est le p90 arrondi et la base le dit', async () => {
    const { dir } = folder(tenTotals);
    withLot99(dir);
    const text = await dryRun(dir);
    expect(text).toContain('budget du lot : 900000 tokens comptés (base : p90 mesuré 900000 sur 10 lots');
  });

  it('R9 — sans mesure, le budget affiché est le statique et la base ne parle pas de mesure du p90', async () => {
    const { dir } = folder([1000]);
    withLot99(dir);
    const text = await dryRun(dir);
    expect(text).toContain('budget du lot : 600000 tokens comptés (base : ');
    expect(text).toContain('1 lot(s) mesuré(s) sur 14 jours, il en faut 5');
  });
});

describe('tirage --continue au budget mesuré (L501)', () => {
  it('R10 — candidates compte le budget mesuré d’un lot : un lot de 600 k statiques ne tient plus dans 700 k quand la classe mesure 900 k', () => {
    const { dir } = folder(tenTotals);
    const plan = join(dir, 'alpha', '.cadence', 'raf.yaml');
    writeFileSync(plan, `${readFileSync(plan, 'utf8')}  - id: L99\n    title: "le lot tiré"\n    status: todo\n    estimate: 0.5\n    created: 2026-10-01\n`);
    const ids = (o: Parameters<typeof candidates>[1]) => candidates(dir, o).map((c) => c.lot.id);
    const base = { priority: [], exclude: new Set<string>(), remaining: 700_000 };
    expect(ids(base)).toEqual(['L99']);
    expect(ids({ ...base, measured: readMeasuredBudgets(dir, TODAY) })).toEqual([]);
    expect(ids({ ...base, remaining: 900_000, measured: readMeasuredBudgets(dir, TODAY) })).toEqual(['L99']);
  });
});

describe('percentile (L501)', () => {
  it('R1 — rang le plus proche : vide → null, une valeur → elle-même, 10 valeurs → la 9e, 11 valeurs → la 10e, ordre d’entrée sans effet', () => {
    expect(percentile([], 0.9)).toBeNull();
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([10, 1, 9, 2, 8, 3, 7, 4, 6, 5], 0.9)).toBe(9);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 0.9)).toBe(10);
  });
});
