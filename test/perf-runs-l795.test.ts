// L795 (issue #69) : cadence perf lit les fichiers d'état de cadence run à côté des journaux de vague.
// Fixtures : états réels de cadence run (17-23-11), anonymisés (chemins, textes, sessions) ; fins.json garde la date de dernière écriture de chacun.
import { describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { tempDir } from './helpers.js';
import { writeJournal, writeWave } from './perf-helpers.js';

const TODAY = '2026-11-24';
const FIXTURES = join(import.meta.dirname, 'fixtures', 'run-etats-l795');
const FINS = JSON.parse(readFileSync(join(FIXTURES, 'fins.json'), 'utf8')) as Record<string, string>;
const GRID = 'perf:\n  prices:\n    sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 }\n    opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 30 }\n  currency: "$"\n';

interface PlanLot { id: string; finished: string; visible?: boolean; ux?: string }
function root(lots: PlanLot[], grid = GRID): string {
  const dir = tempDir();
  writeFileSync(join(dir, 'cadence.yaml'), grid);
  mkdirSync(join(dir, 'alpha', '.cadence'), { recursive: true });
  const body = lots.map((l) => `  - id: ${l.id}\n    title: "t"\n    status: done\n    estimate: 1\n    created: 2026-11-10\n    finished: ${l.finished}${l.visible ? '\n    visible: true' : ''}${l.ux ? `\n    ux:\n      date: ${l.finished}\n      verdict: "${l.ux}"` : ''}`).join('\n');
  writeFileSync(join(dir, 'alpha', '.cadence', 'raf.yaml'), `version: 1\nproject: "alpha"\nprefix: L\nlots:\n${body}\n`);
  return dir;
}
/** Copie les états réels anonymisés dont le lot est dans `lots` (tous sans filtre) sous <dir>/.cadence-run, à la date de dernière écriture qu'ils avaient. */
function states(dir: string, lots?: string[]): void {
  const runDir = join(dir, '.cadence-run');
  mkdirSync(runDir, { recursive: true });
  for (const f of readdirSync(FIXTURES).filter((x) => x.startsWith('alpha-'))) {
    const text = readFileSync(join(FIXTURES, f), 'utf8').replaceAll('@PARENT@', dir);
    if (lots && !lots.includes(JSON.parse(text).lot)) continue;
    writeFileSync(join(runDir, f), text);
    const t = new Date(FINS[f]);
    utimesSync(join(runDir, f), t, t);
  }
}
async function perf(dir: string, json = true) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(['perf', ...(json ? ['--json'] : [])], { cwd: dir, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${TODAY}T12:00:00`) });
  return { code, out, err, data: json && code === 0 ? (JSON.parse(out.join('\n')) as any) : null };
}

const ALL: PlanLot[] = [{ id: 'L805', finished: '2026-11-23' }, { id: 'L798', finished: '2026-11-20' }, { id: 'L765', finished: '2026-11-18' }, { id: 'L804', finished: '2026-11-23' }, { id: 'L900', finished: '2026-11-21' }];

describe('cadence perf — les états de cadence run comme source (L795)', () => {
  it('sans aucun journal de vague, les lots faits par cadence run remplissent passes, conformité du premier coup, durée et coût', async () => {
    const dir = root(ALL);
    states(dir);
    const { code, data } = await perf(dir);
    expect(code).toBe(0);
    // Fenêtre courante (18-24-11) : L805 (une passe, conforme), L798 (porte rouge corrigée + run de correction après revue), L804 (correction après revue)
    expect(data.throughput.ready.current).toBe(3);
    expect(data.corrections.medianPasses.current).toBe(1);
    expect(data.corrections.firstTime.current).toBeCloseTo(1 / 3);
    expect(data.corrections.atLeast2.current).toBeCloseTo(1 / 3);
    expect(data.sources.current).toEqual({ vague: 0, run: 3, both: 0 });
    // Durée de mur : une étape `run` par état fini, du début à la dernière écriture de l'état (L805 : 06:48:13 → 07:12:12)
    expect(data.durations.run.lots.current).toBe(5);
    expect(data.lotMinutes['1'].lots.current).toBe(3);
    // Coût : cout_usd des runs du lot, tel quel, pour les lots done de la fenêtre (L765 l'est le 18-11) ;
    // L805 1,40 $, L804 2,67 + 1,55, L765 4,51, L798 9,23 + 1,93 → médiane (4,22 + 4,51) / 2
    expect(data.cost.perDelivered.current).toBeCloseTo((2.6680098 + 1.5522262 + 4.5147872) / 2, 4);
    expect(data.cost.perDelivered.lots.current).toBe(4);
    // Les jetons ne sont pas dans l'état d'un run : pas de ligne de tokens inventée
    expect(data.tokens.byEstimate).toEqual({});
  });

  it('un lot rendu porte rouge est un lot rendu au lead, avec sa passe de correction ; un run clos n\'a pas de fin lue', async () => {
    const dir = root([{ id: 'L765', finished: '2026-11-18' }]);
    states(dir, ['L765']);
    const { data } = await perf(dir);
    // clos le 18-11 par --clore : la date de l'état n'est pas la fin du run, le lot est daté par son début (17-11, fenêtre précédente)
    expect(data.throughput.ready.previous).toBe(0);
    expect(data.sources.previous).toEqual({ vague: 0, run: 1, both: 0 });
    expect(data.corrections.medianPasses.previous).toBe(1);
    expect(data.corrections.firstTime.previous).toBe(0);
    expect(data.durations.run).toBeUndefined();
    // rendu par le run puis done au plan : terminé hors de l'outil
    expect(data.interventions.handedOut.count.previous).toBe(1);
  });

  it('les passes d\'un run ne sont pas des passes à classer : ni « à classer », ni « sans revue »', async () => {
    const dir = root(ALL);
    states(dir);
    const { data } = await perf(dir);
    expect(data.corrections.causes.current.unclassified).toBe(0);
    expect(data.corrections.causes.current.withoutFindings).toBe(0);
  });

  it('un lot fait en vague seulement est lu comme avant, à côté des lots faits par run', async () => {
    const dir = root(ALL);
    states(dir, ['L805']);
    const runs = join(dir, '.cadence', 'runs');
    writeWave(runs, 'w1', '2026-11-21T07:00:00.000Z');
    writeJournal(runs, 'w1', 'alpha', 'L900', { status: 'ready', steps: [{ kind: 'implement', started: '2026-11-21T07:00:00.000Z', ended: '2026-11-21T08:00:00.000Z', counted: 50_000 }, { kind: 'review', started: '2026-11-21T08:00:00.000Z', ended: '2026-11-21T08:20:00.000Z', counted: 20_000 }] });
    const { data } = await perf(dir);
    expect(data.throughput.ready.current).toBe(2);
    expect(data.sources.current).toEqual({ vague: 1, run: 1, both: 0 });
    expect(data.corrections.firstTime.current).toBe(1);
    expect(data.tokens.byEstimate['1'].current).toBe(70_000);
    expect(data.durations.implement.lots.current).toBe(1);
    expect(data.durations.run.lots.current).toBe(1);
  });

  it('un lot fait des deux façons (rendu par la vague, fini par run) n\'est compté qu\'une fois, avec les passes de ses runs', async () => {
    const dir = root(ALL);
    states(dir, ['L804']);
    const runs = join(dir, '.cadence', 'runs');
    writeWave(runs, 'w1', '2026-11-22T07:00:00.000Z');
    writeJournal(runs, 'w1', 'alpha', 'L804', { status: 'handed-back', steps: [{ kind: 'implement', started: '2026-11-22T07:00:00.000Z', ended: '2026-11-22T08:00:00.000Z', tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 100_000, counted: 100_000 } }] });
    const { data } = await perf(dir);
    expect(data.sources.current).toEqual({ vague: 0, run: 0, both: 1 });
    expect(data.throughput.ready.current).toBe(0);
    expect(data.throughput.rendered.lots.current).toBe(1);
    expect(data.corrections.medianPasses.current).toBe(1);
    expect(data.cost.perDelivered.current).toBeCloseTo(2.6680098 + 1.5522262 + (100_000 * 15) / 1e6, 4);
    expect(data.orphans).toBe(0);
  });

  it('un lot visible fait par run compte la revue d\'ergonomie que le plan a enregistrée', async () => {
    const dir = root([{ id: 'L805', finished: '2026-11-23', visible: true, ux: 'conforme' }, { id: 'L804', finished: '2026-11-23', visible: true }]);
    states(dir, ['L805', 'L804']);
    const { data } = await perf(dir);
    expect(data.interventions.dedicatedUx.current).toBe(0.5);
    expect(data.interventions.ux.current).toBe(0.5);
  });

  it('un run en cours, un run sans lot, un état illisible et un état d\'un dépôt hors du dossier ne comptent pas', async () => {
    const dir = root(ALL);
    states(dir, ['L805']);
    const runDir = join(dir, '.cadence-run');
    const base = JSON.parse(readFileSync(join(runDir, 'alpha-20261123064811-11288.json'), 'utf8'));
    writeFileSync(join(runDir, 'alpha-1.json'), JSON.stringify({ ...base, id: '1', lot: 'L798', etat: 'en-cours' }));
    writeFileSync(join(runDir, 'alpha-2.json'), JSON.stringify({ ...base, id: '2', lot: undefined }));
    writeFileSync(join(runDir, 'alpha-3.json'), '{pas du json');
    writeFileSync(join(runDir, 'beta-4.json'), JSON.stringify({ ...base, id: '4', repo: '/ailleurs/beta', lot: 'L900' }));
    const { data } = await perf(dir);
    expect(data.throughput.ready.current).toBe(1);
    expect(data.sources.current.run).toBe(1);
  });

  it('le texte dit d\'où viennent les lots rendus, et perf ne refuse plus un dossier qui n\'a que des runs', async () => {
    const dir = root(ALL);
    states(dir);
    const { code, out } = await perf(dir, false);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('sources des lots rendus : vague 0 · cadence run 3 · les deux 0');
    expect(out.join('\n')).toMatch(/durée de mur run : /);
  });

  it('sans journal de vague ni état de run, le refus nomme les deux sources', async () => {
    const dir = root(ALL);
    const { code, err } = await perf(dir);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/aucun journal de vague dans .* ni état de cadence run/);
  });

  it('sans grille de prix, un lot fait par cadence run seulement a quand même son coût (cout_usd)', async () => {
    const dir = root([{ id: 'L805', finished: '2026-11-23' }], '');
    states(dir, ['L805']);
    const { data, err } = await perf(dir);
    expect(data.cost.perDelivered.current).toBeCloseTo(1.398171, 4);
    expect(err.join('\n')).toContain('perf : aucune grille de prix (cadence.yaml perf.prices), coût n/d sauf pour les lots faits par cadence run seulement (cout_usd)');
    expect(err.filter((l) => l.includes('aucune grille'))).toHaveLength(1);
  });

  it('une grille dans une autre monnaie que le dollar avertit que le coût des runs est en dollars', async () => {
    const dir = root(ALL, GRID.replace('"$"', '"€"'));
    states(dir, ['L805']);
    const { err } = await perf(dir);
    expect(err.join('\n')).toContain("le coût d'un run est en dollars");
  });
});
