import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { tempDir } from './helpers.js';
import { writeJournal, writeWave } from './perf-helpers.js';

const TODAY = '2026-10-16';
const CUR = '2026-10-12';
const PREV = '2026-10-05';
const days = (n: number, day: string) => Array.from({ length: n }, () => day);

/** Dossier avec .cadence/runs et un projet « alpha » (dépôt git, plan) ; `red`/`green` : jours des journaux de livraison. */
function setup(o: { red?: string[]; green?: string[]; runs?: boolean; prices?: string; projects?: boolean } = {}) {
  const root = tempDir();
  if (o.runs !== false) {
    mkdirSync(join(root, '.cadence', 'runs'), { recursive: true });
    writeWave(join(root, '.cadence', 'runs'), 'w1', '2026-10-01T08:00:00');
  }
  if (o.prices !== undefined) writeFileSync(join(root, 'cadence.yaml'), o.prices);
  if (o.projects === false) return { root };
  const dir = join(root, 'alpha');
  mkdirSync(join(dir, 'docs', 'plan'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'docs', 'plan', 'raf.yaml'), 'version: 1\nproject: "alpha"\nprefix: L\nlots:\n  - id: L1\n    title: "t"\n    status: todo\n');
  mkdirSync(join(dir, '.git', 'cadence'), { recursive: true });
  if (o.green) writeFileSync(join(dir, '.git', 'cadence', 'deliveries.log'), o.green.map((d) => `${d} abc\n`).join(''));
  if (o.red) writeFileSync(join(dir, '.git', 'cadence', 'deliveries-failed.log'), o.red.map((d) => `${d} def CI en échec\n`).join(''));
  return { root, dir };
}
/** Le plan d'alpha : `n` lots terminés par fenêtre et un lot ancien qui porte 4 notes « QA 1 bloquant » dans la courante, 2 dans la précédente (n = 10 : ⚠). */
function qaPlan(dir: string, n = 10): void {
  const done = (prefix: string, day: string) => Array.from({ length: n }, (_, i) => `  - { id: ${prefix}${i}, title: t, status: done, finished: ${day} }`);
  const notes = [...days(4, CUR), ...days(2, PREV)].map((d) => `      - { date: ${d}, text: "QA 1 bloquant" }`);
  writeFileSync(join(dir, 'docs', 'plan', 'raf.yaml'), ['version: 1', 'project: "alpha"', 'prefix: L', 'lots:', ...done('C', CUR), ...done('P', PREV), '  - id: Q', '    title: t', '    status: done', '    finished: 2026-10-01', '    notes:', ...notes].join('\n') + '\n');
}
const twoRed = { red: [...days(4, CUR), ...days(2, PREV)], green: [...days(6, CUR), ...days(8, PREV)] };

async function tour(root: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(['lead', 'tour', ...args], { cwd: root, env: { RAF_TODAY: TODAY, OLLAMA_HOST: 'http://127.0.0.1:9' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${TODAY}T10:00:00`) });
  return { code, out, err, text: out.join('\n') };
}
const tree = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [`${e.name}:${statSync(join(dir, e.name)).mtimeMs}:${readFileSync(join(dir, e.name), 'utf8')}`]));

describe('cadence lead tour — en-tête perf (L227)', () => {
  it('R6 — deux ⚠ : deux lignes avant la première ligne de projet', async () => {
    const c = setup(twoRed);
    qaPlan(c.dir!);
    const r = await tour(c.root);
    expect(r.code).toBe(0);
    expect(r.out.findIndex((l) => l.startsWith('alpha'))).toBe(2);
    expect(r.out[0]).toMatch(/^⚠ livraisons rouges : 4 \(précédente 2, \+100 %\)/);
    expect(r.out[1]).toMatch(/^⚠ constats QA bloquants : 4/);
  });

  it('R6 — aucun ⚠ : sortie identique à celle d\'avant', async () => {
    const stable = await tour(setup({ red: days(2, CUR), green: [...days(8, CUR), ...days(8, PREV)] }).root);
    const before = await tour(setup({ runs: false }).root);
    expect(stable.out).toEqual(before.out);
  });

  it('R6 — un goulot net produit sa ligne ⚠ goulot', async () => {
    const c = setup();
    const entries: Record<string, { cause: string; by: string }> = {};
    for (let i = 0; i < 10; i++) {
      const lot = `G${i}`;
      writeJournal(join(c.root, '.cadence', 'runs'), 'w1', 'alpha', lot, { status: 'ready', steps: [{ kind: 'implement', ended: `${CUR}T09:00:00` }, { kind: 'review', constats: ['c'], ended: `${CUR}T10:00:00` }, { kind: 'fix', ended: `${CUR}T11:00:00` }] });
      entries[`w1/alpha--${lot}/3`] = { cause: 'bug-code', by: 'm' };
    }
    writeFileSync(join(c.root, '.cadence', 'corrections.json'), JSON.stringify(entries));
    const r = await tour(c.root);
    expect(r.out[0]).toBe('⚠ goulot : bug de code pèse 10 passes classées sur 10 → quel maillon corriger');
    expect(r.out[1]).toMatch(/alpha/);
  });

  it('R6 — une ligne d\'en-tête contient sa décision et la valeur du jumeau de qualité (VITE ET BIEN)', async () => {
    const c = setup();
    const done = (prefix: string, n: number, day: string) => Array.from({ length: n }, (_, i) => `  - { id: ${prefix}${i}, title: t, status: done, finished: ${day} }`);
    writeFileSync(join(c.dir!, 'docs', 'plan', 'raf.yaml'), ['version: 1', 'project: "alpha"', 'prefix: L', 'lots:', ...done('E', 10, PREV), ...done('F', 6, CUR)].join('\n') + '\n');
    const warn = (await tour(c.root)).out[0]!;
    expect(warn).toBe('⚠ livrés : 6 (précédente 10, −40 %) · défauts échappés : n/d (précédente n/d) → le flux baisse : chercher le goulot avant d\'ajouter des lots');
  });

  it('R6 — le ⚠ qaBlocking apparaît comme ligne d\'en-tête de cadence lead tour', async () => {
    const c = setup();
    qaPlan(c.dir!);
    const r = await tour(c.root);
    expect(r.out[0]).toBe('⚠ constats QA bloquants : 4 (précédente 2, +100 %) · défauts échappés : 1 (précédente 1, +0 %) → la revue laisse passer des défauts graves : durcir la revue avant de livrer davantage');
  });

  it('R7 — dossier sans .cadence/runs : tour identique à avant, code 0, rien sur stderr', async () => {
    const c = setup({ runs: false, ...twoRed });
    const r = await tour(c.root);
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.out.some((l) => l.startsWith('⚠'))).toBe(false);
  });

  it('R7 — grille de prix mal formée : tour identique à avant, code 0', async () => {
    const c = setup({ ...twoRed, prices: 'perf:\n  prices: [pas, une, grille]\n' });
    const r = await tour(c.root);
    expect(r.code).toBe(0);
    expect(r.out.some((l) => l.startsWith('⚠'))).toBe(false);
    expect(r.out.some((l) => l.includes('alpha'))).toBe(true);
  });

  it('R7 — dossier sans aucun projet : le message « aucun projet sous … » est inchangé et sans en-tête', async () => {
    const c = setup({ projects: false });
    const r = await tour(c.root);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([`aucun projet sous ${c.root} (docs/plan/raf.yaml ou cadence.yaml avec plan:)`]);
  });

  it('R8 — tour --json avec des ⚠ de perf : le JSON est le tableau de lignes, sans clé de perf', async () => {
    const c = setup(twoRed);
    const r = await tour(c.root, '--json');
    const rows = JSON.parse(r.text);
    expect(Array.isArray(rows)).toBe(true);
    expect(r.text).not.toContain('livraisons rouges');
    expect(r.text).not.toContain('⚠');
  });

  it('R8 — tour --json est identique octet pour octet à celui d\'avant L227', async () => {
    const withPerf = setup(twoRed);
    const without = setup({ runs: false, ...twoRed });
    const norm = (t: string, root: string) => t.replaceAll(root, '<root>');
    expect(norm((await tour(withPerf.root, '--json')).text, withPerf.root)).toBe(norm((await tour(without.root, '--json')).text, without.root));
  });

  it('R9 — le tour avec un modèle injoignable (OLLAMA_HOST injoignable) tourne sans erreur', async () => {
    const r = await tour(setup(twoRed).root);
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
  });

  it('R9 — le tour et perf n\'écrivent aucun fichier (arborescence identique avant/après)', async () => {
    const c = setup(twoRed);
    const before = tree(c.root);
    await tour(c.root);
    await run(['perf'], { cwd: c.root, env: { RAF_TODAY: TODAY }, out: () => {}, err: () => {}, now: () => new Date(`${TODAY}T10:00:00`) });
    expect(tree(c.root)).toEqual(before);
  });
});
