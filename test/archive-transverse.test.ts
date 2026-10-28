import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { planLoader } from '../src/config.js';
import { deliver, parseDeliverConfig, type DeliverDeps } from '../src/deliver.js';
import { appendDelivery } from '../src/state.js';
import { fileIds, repoWithPlan } from './archive-helpers.js';
import { commit, tempDir } from './helpers.js';
import { writeJournal, writeWave } from './perf-helpers.js';

/*
 * L396, conception retenue : l'archive est un détail de STOCKAGE. Tout lecteur du plan (`plan.lots()`) voit les lots actifs ET
 * archivés ; `raf archive` ne change que les fichiers. Ce test le mesure de bout en bout : les commandes principales rendent la
 * même sortie avant et après l'archivage, seule la taille du fichier du plan change.
 */

const TODAY = '2026-10-28';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const sha = (cwd: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();

const INVENTAIRE = {
  version: 1,
  genre: 'inventaire',
  document: { slug: 'doc', sha256: 'a'.repeat(64) },
  elements: [
    { type: 'texte', id: 'doc#texte-1', libelle: 'Valider', role: 'bouton', source: { page: 1, zone: { x: 10, y: 20, l: 100, h: 40 } }, confiance: 'lu' },
    { type: 'texte', id: 'doc#texte-2', libelle: 'Annuler', role: 'bouton', source: { page: 1, zone: { x: 10, y: 20, l: 100, h: 40 } }, confiance: 'lu' },
  ],
};

/** `cadence` lancé depuis `cwd` avec la date figée ; `now` figé aussi pour l'horodatage du gantt. */
async function cadence(cwd: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { cwd, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${TODAY}T10:00:00`) });
  return `code ${code}\n${out.join('\n')}\n--\n${err.join('\n')}`;
}

/**
 * Un dépôt poussé : L1 (done 2025) et L4 (doing) citent un élément du document de référence, une Nouveauté cite L1, trois commits de
 * code citent L1, L3 et L4. `origin` et la config `deliver:` servent à la livraison, `parent` à perf et lead tour.
 */
async function depot() {
  const parent = tempDir();
  const r = repoWithPlan(TODAY, parent);
  const origin = tempDir();
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  // L3 fini dans la fenêtre courante de perf (7 jours avant TODAY), et une vague qui l'a rendu : perf a de quoi compter un lot livré.
  writeFileSync(r.plan, readFileSync(r.plan, 'utf8').replace('finished: 2026-09-20', 'finished: 2026-10-25'));
  const runs = join(parent, '.cadence', 'runs');
  writeWave(runs, 'w1', '2026-10-24T08:00:00.000Z');
  writeJournal(runs, 'w1', 'depot', 'L3', { status: 'ready', steps: [{ kind: 'implement', status: 'ok', ended: '2026-10-25T09:00:00' }] });
  await cadence(r.dir, 'note', 'L1', 'couvre doc#texte-1');
  await cadence(r.dir, 'note', 'L4', 'couvre doc#texte-2');
  await cadence(r.dir, 'news', 'new', 'L1', '--title', 'Un titre', '--dir', join(r.dir, 'docs/nouveautes'));
  writeFileSync(join(r.dir, 'inventaire.json'), JSON.stringify(INVENTAIRE));
  writeFileSync(join(r.dir, 'cadence.yaml'), 'deliver:\n  verify:\n    - command: "true"\n');
  git(r.dir, 'add', '.');
  execFileSync('git', ['commit', '-q', '-m', 'chore: plan et références'], { cwd: r.dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: '2025-01-01T09:00:00', GIT_COMMITTER_DATE: '2025-01-01T09:00:00' } });
  const first = sha(r.dir);
  commit(r.dir, 'feat(L1): travail ancien', '2025-06-01T10:00:00');
  commit(r.dir, 'feat(L3): travail de septembre', '2026-09-10T10:00:00');
  commit(r.dir, 'feat(L4): en cours', '2026-10-27T10:00:00');
  git(r.dir, 'remote', 'add', 'origin', origin);
  git(r.dir, 'push', '-q', '-u', 'origin', 'main');
  return { ...r, parent, first };
}

/** La ligne « livré : … » d'une livraison depuis `first` (journal neuf à chaque appel : la livraison ne dépend que de l'historique et du plan). */
async function livre(dir: string, first: string): Promise<string> {
  const state = tempDir();
  appendDelivery(state, '2025-01-01', first);
  const out: string[] = [];
  const deps: DeliverDeps = { exec: () => 0, gh: () => [], ghReady: () => null, fetch: async () => ({ status: 200, text: 'ok' }), sleep: async () => {}, now: () => 0 };
  const config = parseDeliverConfig(readFileSync(join(dir, 'cadence.yaml'), 'utf8'), join(dir, 'cadence.yaml'));
  const code = await deliver({ root: dir, state, plan: planLoader(dir)(), config, today: TODAY, dryRun: false, args: [], out: (l) => out.push(l), err: (l) => out.push(`! ${l}`) }, deps);
  return `code ${code} ${out.find((l) => l.includes('livré :')) ?? out.join(' | ')}`;
}

/**
 * « Fait depuis » liste les lots dans l'ordre de leur commit le plus récent ; le commit du plan que propose `raf archive` cite les lots
 * archivés et passe donc L1 en tête après coup. C'est l'historique qui change, pas la lecture du plan : les lignes sont comparées triées.
 */
function faitDepuisTrie(text: string): string {
  const lines = text.split('\n');
  const isLot = (l: string) => /^ {2}L\d+ — \d+ commit\(s\) : /.test(l);
  const sorted = lines.filter(isLot).sort();
  return lines.map((l) => (isLot(l) ? sorted.shift()! : l)).join('\n');
}

/** Les sorties à comparer, par commande. */
async function snapshot(r: { dir: string; parent: string; first: string }): Promise<Record<string, string>> {
  const gantt = join(tempDir(), 'gantt.html');
  const s: Record<string, string> = {
    'raf check': await cadence(r.dir, 'check', '--since', '2025-01-01'),
    'raf show L1': await cadence(r.dir, 'show', 'L1'),
    'raf show L1 --notes': await cadence(r.dir, 'show', 'L1', '--notes'),
    'raf show L4': await cadence(r.dir, 'show', 'L4'),
    'raf commits L1': await cadence(r.dir, 'commits', 'L1'),
    'raf commits L3': await cadence(r.dir, 'commits', 'L3'),
    'raf now': await cadence(r.dir, 'now'),
    'raf list': await cadence(r.dir, 'list'),
    'raf list --status done': await cadence(r.dir, 'list', '--status', 'done'),
    'raf gantt': (await cadence(r.dir, 'gantt', '-o', gantt)).replace(gantt, '<gantt>'),
    'session start': faitDepuisTrie(await cadence(r.dir, 'session', 'start', '--since', '2025-01-01')),
    'lead tour': await cadence(r.parent, 'lead', 'tour', r.parent),
    'ref coverage': await cadence(r.dir, 'ref', 'coverage', 'inventaire.json'),
    'news check': await cadence(r.dir, 'news', 'check', '--dir', join(r.dir, 'docs/nouveautes')),
    'perf --json': await cadence(r.parent, 'perf', '--json'),
    deliver: await livre(r.dir, r.first),
  };
  s['gantt.html'] = readFileSync(gantt, 'utf8');
  return s;
}

describe('L396 — l’archive est invisible pour les lecteurs du plan', () => {
  it('T1 — raf check, show, commits, now, list, gantt, session start, lead tour, ref coverage, news check, perf et deliver rendent la même sortie avant et après raf archive ; seul le fichier du plan rétrécit', async () => {
    const r = await depot();
    const avant = await snapshot(r);
    // Le jeu d'essai mesure quelque chose : les lots archivés et leurs commits sont bien dans les sorties d'avant.
    expect(avant['raf show L1']).toContain('travail ancien');
    expect(avant['raf check']).not.toContain('inconnu');
    expect(avant['session start']).toMatch(/L1 — 1 commit\(s\)/);
    expect(avant['ref coverage']).toContain('doc#texte-2');
    expect(avant['ref coverage']).not.toContain('doc#texte-1');
    expect(avant['news check']).not.toContain('absent du plan');
    expect(avant.deliver).toContain('livré : L1, L3, L4');
    expect(avant['raf list']).toContain('L1     done');
    expect(avant['perf --json']).toMatch(/^code 0\n\{/);
    expect(JSON.parse(avant['perf --json'].replace(/^code 0\n/, '').split('\n--\n')[0]).throughput.delivered.current).toBe(1); // L3, fini dans la fenêtre : lu dans le plan
    expect(avant['lead tour']).toContain('depot · en cours L4 (1 commit');
    const sizeBefore = statSync(r.plan).size;

    const archive = await cadence(r.dir, 'archive');
    expect(archive).toContain('archivé dans .cadence/archive/2025.yaml : L1');
    expect(archive).toContain('archivé dans .cadence/archive/2026.yaml : L2, L3');
    expect(fileIds(r.plan)).toEqual(['L4', 'L5']);
    expect(statSync(r.plan).size).toBeLessThan(sizeBefore);
    // La commande de commit proposée emporte le plan ET les fichiers d'archive, à chemins explicites ; jouée telle quelle, elle laisse l'arbre propre.
    const proposed = /^ {2}(git add -- .* && git commit -m .* -- .*)$/m.exec(archive)?.[1];
    expect(proposed).toBeDefined();
    expect(proposed).toContain('.cadence/raf.yaml');
    expect(proposed).toContain('.cadence/archive/2025.yaml');
    expect(proposed).toContain('.cadence/archive/2026.yaml');
    expect(proposed).toContain("'plan: L1 3 lot(s) archivé(s)'");
    execFileSync('sh', ['-c', proposed!], { cwd: r.dir, stdio: 'ignore' });
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: r.dir, encoding: 'utf8' }).trim()).toBe('');
    git(r.dir, 'push', '-q');

    const apres = await snapshot(r);
    for (const key of Object.keys(avant)) expect(apres[key], key).toBe(avant[key]);
    expect(existsSync(join(r.dir, '.cadence/archive/2025.yaml'))).toBe(true);
  });

  it("T2 — le commit proposé par raf archive se rejoue sans doublon : un second tour qui n'archive rien ne propose rien", async () => {
    const r = await depot();
    await cadence(r.dir, 'archive');
    const again = await cadence(r.dir, 'archive');
    expect(again).toContain('rien à archiver');
    expect(again).not.toContain('git add');
  });
});
