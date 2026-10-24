import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { isQaBlockingNote } from '../src/perf.js';
import { tempDir } from './helpers.js';
import { writeWave } from './perf-helpers.js';

const TODAY = '2026-10-16';
const CUR = '2026-10-12';
const PREV = '2026-10-05';

interface PLot { id: string; status?: string; finished?: string; created?: string; notes?: [string, string][] }

/** Dossier avec un .cadence/runs, un projet « alpha » (dépôt git, plan) et ses journaux de livraison. */
function setup(o: { lots?: PLot[]; green?: string[]; red?: string[]; failedRaw?: string } = {}) {
  const root = tempDir();
  const runs = join(root, '.cadence', 'runs');
  mkdirSync(runs, { recursive: true });
  writeWave(runs, 'w1', '2026-10-01T08:00:00');
  const dir = join(root, 'alpha');
  mkdirSync(join(dir, '.cadence'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const body = (o.lots ?? []).map((l) => [`  - id: ${l.id}`, '    title: "t"', `    status: ${l.status ?? 'done'}`, ...(l.created ? [`    created: ${l.created}`] : []), ...(l.finished ? [`    finished: ${l.finished}`] : []), ...(l.notes ? ['    notes:', ...l.notes.map(([d, t]) => `      - { date: ${d}, text: ${JSON.stringify(t)} }`)] : [])].join('\n')).join('\n');
  writeFileSync(join(dir, '.cadence', 'raf.yaml'), `version: 1\nproject: "alpha"\nprefix: L\nlots:\n${body || '  []'}\n`);
  mkdirSync(join(dir, '.git', 'cadence'), { recursive: true });
  if (o.green) writeFileSync(join(dir, '.git', 'cadence', 'deliveries.log'), o.green.map((d) => `${d} abc\n`).join(''));
  const failed = o.failedRaw ?? (o.red ? o.red.map((d) => `${d} def CI en échec\n`).join('') : undefined);
  if (failed !== undefined) writeFileSync(join(dir, '.git', 'cadence', 'deliveries-failed.log'), failed);
  return { root, dir };
}
const many = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
const days = (n: number, day: string) => many(n, () => day);
const dones = (n: number, finished: string, prefix: string): PLot[] => many(n, (i) => ({ id: `${prefix}${i}`, finished, created: '2026-10-01' }));

async function perf(root: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(['perf', ...args], { cwd: root, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${TODAY}T10:00:00`) });
  return { code, out, err, text: out.join('\n') };
}
async function json(root: string, ...args: string[]) {
  const r = await perf(root, '--json', ...args);
  return { ...r, data: JSON.parse(r.text) as any };
}
const red = async (o: Parameters<typeof setup>[0], ...args: string[]) => (await json(setup(o).root, ...args)).data.quality.redDeliveries;

describe('cadence perf — livraisons rouges (L227)', () => {
  it('R2 — aucun deliveries-failed.log : 0 rouge, pas n/d', async () => {
    const r = await red({ green: [CUR] });
    expect(r.current).toBe(0);
    expect(r.previous).toBe(0);
  });

  it('R2 — fichier présent sans ligne dans la fenêtre : 0', async () => {
    const r = await red({ red: ['2026-08-01'] });
    expect([r.current, r.previous]).toEqual([0, 0]);
  });

  it('R2 — trois lignes dans la fenêtre courante, deux dans la précédente : 3 et 2', async () => {
    const r = await red({ red: [...days(3, CUR), ...days(2, PREV)] });
    expect([r.current, r.previous]).toEqual([3, 2]);
  });

  it('R2 — une ligne illisible du fichier est ignorée sans erreur', async () => {
    const c = setup({ failedRaw: `${CUR} def CI en échec\nn'importe quoi\n\n${CUR} ghi x\n` });
    const r = await json(c.root);
    expect(r.code).toBe(0);
    expect(r.data.quality.redDeliveries.current).toBe(2);
    expect(r.err.join('\n')).not.toContain('deliveries-failed');
  });

  it('R2 — deliveries.log toujours lu pour les livrés', async () => {
    const c = setup({ lots: [{ id: 'L1', finished: CUR, created: '2026-10-01' }], green: [CUR], red: [CUR] });
    const { data } = await json(c.root);
    expect(data.delays.doneToDelivered.current).toBe(0);
    expect(data.delays.doneToDelivered.lots.current).toBe(1);
  });

  it('R3 — rouges 2 → 4 sur 10 livraisons par fenêtre : ⚠', async () => {
    const c = setup({ red: [...days(4, CUR), ...days(2, PREV)], green: [...days(6, CUR), ...days(8, PREV)] });
    const { data } = await json(c.root);
    expect(data.quality.redDeliveries).toMatchObject({ current: 4, previous: 2, warn: true, twin: 'throughput.delivered', lots: { current: 10, previous: 10 } });
    expect(data.warnings.find((w: string) => w.includes('livraisons rouges'))).toMatch(/→ la livraison casse : corriger CI, déploiement ou vérification avant d'ajouter des lots$/);
  });

  it('R3 — 5 → 6 (20 %) : pas de ⚠', async () => {
    const c = setup({ red: [...days(6, CUR), ...days(5, PREV)], green: [...days(6, CUR), ...days(6, PREV)] });
    const { data } = await json(c.root);
    expect(data.quality.redDeliveries).toMatchObject({ current: 6, previous: 5, warn: false });
  });

  it('R3 — moins de 5 livraisons dans une fenêtre : pas de ⚠, la ligne dit l\'échantillon', async () => {
    const c = setup({ red: [...days(3, CUR), ...days(1, PREV)], green: [...days(1, CUR), ...days(8, PREV)] });
    const r = await json(c.root);
    expect(r.data.quality.redDeliveries.warn).toBe(false);
    expect(r.data.quality.redDeliveries.note).toBe('pas de tendance : échantillon');
    expect((await perf(c.root)).out.find((l) => l.includes('livrés'))).toContain('pas de tendance : échantillon');
  });

  it('R3 — précédente à 0 : pas de ⚠', async () => {
    const c = setup({ red: days(4, CUR), green: [...days(6, CUR), ...days(10, PREV)] });
    const { data } = await json(c.root);
    expect(data.quality.redDeliveries).toMatchObject({ current: 4, previous: 0, warn: false, note: 'pas de tendance : précédente nulle' });
  });

  it('R3 — la ligne « livrés » contient la valeur des livraisons rouges', async () => {
    const c = setup({ lots: dones(2, CUR, 'A'), red: [...days(4, CUR), ...days(2, PREV)], green: [...days(6, CUR), ...days(8, PREV)] });
    const line = (await perf(c.root)).out.find((l) => l.includes('livrés'))!;
    expect(line).toMatch(/livrés : 2/);
    expect(line).toContain('livraisons rouges : 4 (précédente 2, +100 %)');
    expect(line).toContain('⚠');
    expect(line).toContain('défauts échappés');
  });

  it('R3 — --since qui tronque : pas de ⚠', async () => {
    const c = setup({ red: [...days(4, CUR), ...days(2, PREV)], green: [...days(6, CUR), ...days(8, PREV)] });
    const { data } = await json(c.root, '--since', '2026-10-08');
    expect(data.quality.redDeliveries.warn).toBe(false);
    expect(data.quality.redDeliveries.note).toBe('fenêtre tronquée');
  });
});

describe('cadence perf — constats QA bloquants (L227)', () => {
  const qa = async (lots: PLot[], ...args: string[]) => (await json(setup({ lots }).root, ...args)).data;

  it('R4 — la note est reconnue : « QA » en tête hors date, « bloquant » non précédé de 0 ou aucun', () => {
    expect(isQaBlockingNote('16-10 : QA fiche 2 bloquants')).toBe(true);
    expect(isQaBlockingNote('QA 1 majeur')).toBe(false);
    expect(isQaBlockingNote('16-10 : QA aucun bloquant')).toBe(false);
    expect(isQaBlockingNote('QA 0 bloquant')).toBe(false);
    expect(isQaBlockingNote('Revue : 1 bloquant')).toBe(false);
  });

  it('R4 — « 16-10 : QA … 2 bloquants » sur un lot terminé compte une note', async () => {
    const d = await qa([{ id: 'L1', finished: '2026-10-01', notes: [[CUR, '12-10 : QA 2 bloquants']] }]);
    expect(d.quality.qaBlocking.current).toBe(1);
    expect(d.quality.qaBlocking.twin).toBe('throughput.escaped');
  });

  it('R4 — « QA … 1 majeur » seul ne compte pas', async () => {
    const d = await qa([{ id: 'L1', finished: '2026-10-01', notes: [[CUR, '12-10 : QA 1 majeur'], [CUR, '12-10 : QA 1 bloquant']] }]);
    expect(d.quality.qaBlocking.current).toBe(1);
    const e = await qa([{ id: 'L1', finished: '2026-10-01', notes: [[CUR, '12-10 : QA 1 majeur']] }]);
    expect(e.quality.qaBlocking.current).toBeNull();
  });

  it('R4 — « QA … aucun bloquant » et « QA … 0 bloquant » ne comptent pas', async () => {
    const d = await qa([{ id: 'L1', finished: '2026-10-01', notes: [[CUR, '12-10 : QA aucun bloquant'], [CUR, '12-10 : QA 0 bloquant'], [CUR, '12-10 : QA 3 bloquants']] }]);
    expect(d.quality.qaBlocking.current).toBe(1);
  });

  it('R4 — une note QA datée avant finished ne compte pas', async () => {
    const d = await qa([{ id: 'L1', finished: CUR, notes: [['2026-10-11', '11-10 : QA 2 bloquants'], ['2026-10-13', '13-10 : QA 1 bloquant']] }]);
    expect(d.quality.qaBlocking.current).toBe(1);
  });

  it('R4 — deux notes bloquantes sur un même lot comptent 2, les défauts échappés comptent 1', async () => {
    const d = await qa([{ id: 'L1', finished: '2026-10-01', notes: [[CUR, '12-10 : QA 1 bloquant'], ['2026-10-13', '13-10 : QA 2 bloquants']] }]);
    expect(d.quality.qaBlocking.current).toBe(2);
    expect(d.throughput.escaped.current).toBe(1);
  });

  it('R4 — aucune note reconnue : n/d et pas de ⚠', async () => {
    const d = await qa([{ id: 'L1', finished: '2026-10-01', notes: [[CUR, '12-10 : fait']] }]);
    expect(d.quality.qaBlocking).toMatchObject({ current: null, previous: null, warn: false });
    expect(d.warnings.filter((w: string) => w.includes('constats QA'))).toEqual([]);
  });

  const trend = (finishedPerWindow: number): PLot[] => [
    ...dones(finishedPerWindow, CUR, 'C'),
    ...dones(finishedPerWindow, PREV, 'P'),
    { id: 'Q', finished: '2026-10-01', notes: [...days(4, CUR).map((d): [string, string] => [d, '12-10 : QA 1 bloquant']), ...days(2, PREV).map((d): [string, string] => [d, '05-10 : QA 1 bloquant'])] },
  ];

  it('R4 — constats bloquants 2 → 4 sur 10 lots terminés par fenêtre : ⚠ qaBlocking dans result.warnings avec sa décision « durcir la revue avant de livrer davantage »', async () => {
    const d = await qa(trend(10));
    expect(d.quality.qaBlocking).toMatchObject({ current: 4, previous: 2, warn: true, lots: { current: 10, previous: 10 } });
    expect(d.warnings.find((w: string) => w.includes('constats QA bloquants'))).toMatch(/→ la revue laisse passer des défauts graves : durcir la revue avant de livrer davantage$/);
  });

  it('R4 — même hausse sur moins de 5 lots terminés : pas de ⚠', async () => {
    const d = await qa(trend(3));
    expect(d.quality.qaBlocking).toMatchObject({ current: 4, previous: 2, warn: false });
  });

  it('R5 — --json contient quality.redDeliveries et quality.qaBlocking au format Indicator', async () => {
    const { data } = await json(setup().root);
    for (const k of ['redDeliveries', 'qaBlocking']) expect(Object.keys(data.quality[k]).sort()).toEqual(['change', 'current', 'lots', 'note', 'previous', 'twin', 'warn']);
  });

  it('R5 — redDeliveries.twin vaut « throughput.delivered » et qaBlocking.twin « throughput.escaped »', async () => {
    const { data } = await json(setup().root);
    expect(data.quality.redDeliveries.twin).toBe('throughput.delivered');
    expect(data.quality.qaBlocking.twin).toBe('throughput.escaped');
  });

  it('R5 — throughput.delivered.twin vaut toujours « throughput.escaped »', async () => {
    const { data } = await json(setup().root);
    expect(data.throughput.delivered.twin).toBe('throughput.escaped');
  });

  it('R5 — les clés throughput, corrections, interventions, tokens, delays, cost sont identiques avant et après (jeu de données fixe)', async () => {
    const lots = [...dones(2, CUR, 'A')];
    const before = (await json(setup({ lots, green: [CUR] }).root)).data;
    const after = (await json(setup({ lots, green: [CUR], red: [...days(3, CUR), ...days(2, PREV)] }).root)).data;
    for (const k of ['throughput', 'corrections', 'interventions', 'tokens', 'delays', 'durations', 'cost']) expect(after[k], k).toEqual(before[k]);
  });

  it('R5 — le texte de la ligne « livrés » contient le jumeau défauts échappés et « livraisons rouges : » avec la valeur', async () => {
    const c = setup({ lots: [{ id: 'L1', finished: '2026-10-01', notes: [[CUR, '12-10 : QA 1 bloquant']] }], red: days(2, CUR) });
    const out = (await perf(c.root)).out;
    const line = out.find((l) => l.includes('livrés'))!;
    expect(line).toMatch(/défauts échappés : 1/);
    expect(line).toMatch(/livraisons rouges : 2 /);
    expect(out.find((l) => l.includes('défauts échappés') && !l.includes('livrés') && !l.includes('prêts') && !l.includes('rendus') && !l.includes('budget'))).toMatch(/constats QA bloquants : 1 /);
  });
});
