// L781 : dans un cadence run, la session ne peut pas jouer les commandes du projet qui appellent cadence (npm run news → cadence news build, puis la
// régénération du plan publié) : le 18-11, trois lots (finance L172, L173, warhammer L71) ont été intégrés avec nouveautes-data non régénéré, rejoué à la
// main par le lead. Le run les joue lui-même avant la porte et commite leur sortie en un commit du lot.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executerRun } from '../src/run/run.js';
import { depot, fauxClaude, git, io } from './run-outils.js';

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const DONNEES = 'public/nouveautes-data/nouveautes.json';
// Générateur du projet (le rôle de `cadence news build`) : la liste des entrées ; échoue sur une entrée marquée MAUVAISE, comme un en-tête invalide.
const GEN = `import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
const d = 'docs/nouveautes', e = readdirSync(d).filter((f) => f.endsWith('.md')).sort();
mkdirSync('public/nouveautes-data', { recursive: true });
writeFileSync('${DONNEES}', JSON.stringify(e) + '\\n');
if (e.some((f) => readFileSync(d + '/' + f, 'utf8').includes('MAUVAISE'))) { console.error('entrée invalide'); process.exit(3); }
`;
// plan.onWrite.command : la régénération déclarée du plan publié, qui lit aussi les Nouveautés.
const PLAN = `import { readdirSync, writeFileSync } from 'node:fs';
writeFileSync('public/plan.json', JSON.stringify({ nouveautes: readdirSync('docs/nouveautes').length }) + '\\n');
`;

/** Un dépôt de projet avec scripts.news, ses données générées commitées et à jour ; la porte exige l'entrée du run dans les données. */
function projet(porte = 'grep -q fait.md ' + DONNEES, planOnWrite = true): string {
  const repo = depot(porte);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'p', private: true, scripts: { news: 'node gen.mjs', plan: 'node plan.mjs' } }));
  writeFileSync(join(repo, 'gen.mjs'), GEN); writeFileSync(join(repo, 'plan.mjs'), PLAN);
  if (planOnWrite) writeFileSync(join(repo, 'cadence.yaml'), `${readFileSync(join(repo, 'cadence.yaml'), 'utf8')}plan:\n  onWrite: { command: npm run plan, files: [public/plan.json] }\n`);
  mkdirSync(join(repo, 'docs', 'nouveautes'), { recursive: true }); writeFileSync(join(repo, 'docs', 'nouveautes', 'ancienne.md'), 'ancienne');
  git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'projet');
  execNode(repo, 'gen.mjs'); execNode(repo, 'plan.mjs');
  git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'données');
  return repo;
}
const execNode = (cwd: string, f: string) => execFileSync(process.execPath, [f], { cwd });
/** La session écrit une entrée Nouveautés (texte libre) et la commite, sans toucher aux données générées : elle ne peut pas lancer cadence. */
const entree = (nom: string, texte = 'ok') => (cwd: string) => {
  writeFileSync(join(cwd, 'docs', 'nouveautes', nom), texte); git(cwd, 'add', '-A'); git(cwd, ...ID, 'commit', '-qm', `feat(L9): entrée ${nom}`);
};
const donnees = (repo: string) => JSON.parse(readFileSync(join(repo, DONNEES), 'utf8')) as string[];

describe('cadence run : les commandes de projet qui appellent cadence sont jouées par le run (L781)', () => {
  it('scripts.news : données Nouveautés et plan publié régénérés avant la porte, en un commit du lot, intégrés', () => {
    const repo = projet(), { l, out } = io();
    const e = executerRun({ repo, demande: 'Écris l\'entrée', lot: 'L9', exec: fauxClaude([entree('fait.md')]), out });
    expect(e.etat).toBe('integre'); // la porte (grep fait.md dans les données) a vu les données régénérées
    expect(donnees(repo)).toEqual(['ancienne.md', 'fait.md']);
    expect(JSON.parse(readFileSync(join(repo, 'public', 'plan.json'), 'utf8'))).toEqual({ nouveautes: 2 });
    expect(git(repo, 'log', '--format=%s', '-2')).toBe(`chore(L9): régénère les nouveautés (cadence run ${e.id})\nfeat(L9): entrée fait.md`);
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([DONNEES, 'public/plan.json']);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(l.join('\n')).toMatch(/nouveautés régénérées avant la porte \(L781\) : commit [0-9a-f]{7}/);
    expect(e.detail).toMatch(/nouveautés régénérées par le run avant la porte \(L781\) : commit [0-9a-f]{7}/);
  });

  it('données déjà à jour : aucun commit de régénération', () => {
    const repo = projet('test -d docs'), e = executerRun({ repo, demande: 'x', exec: fauxClaude([(cwd) => { writeFileSync(join(cwd, 'autre.txt'), 'x'); git(cwd, 'add', '-A'); git(cwd, ...ID, 'commit', '-qm', 'autre'); }]), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(git(repo, 'log', '--format=%s', '-1')).toBe('autre');
    expect(e.detail).not.toMatch(/régénérées/);
  });

  it('sans scripts.news : rien n\'est joué, le run est celui d\'avant', () => {
    const repo = depot('test -f fait.txt');
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([(cwd) => { writeFileSync(join(cwd, 'fait.txt'), 'x'); git(cwd, 'add', '-A'); git(cwd, ...ID, 'commit', '-qm', 'fait'); }]), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(git(repo, 'log', '--format=%s', '-1')).toBe('fait');
  });

  it('régénération en échec : rendue à la session comme une porte rouge, rien de demi-écrit, puis intégrée une fois l\'entrée corrigée', () => {
    const repo = projet(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const e = executerRun({ repo, demande: 'x', lot: 'L9', exec: fauxClaude([entree('fait.md', 'MAUVAISE'), entree('fait.md', 'bonne')], appels), out: () => {} });
    const prompt = appels[1].args[appels[1].args.indexOf('-p') + 1];
    expect(prompt).toMatch(/porte complète est rouge[\s\S]*\$ npm run news[\s\S]*entrée invalide[\s\S]*sans lancer cette commande toi-même/);
    expect(e.etat).toBe('integre');
    expect(e.corrections?.[0].verte).toBe(true);
    expect(donnees(repo)).toEqual(['ancienne.md', 'fait.md']);
    expect(git(repo, 'log', '--format=%s', '-3')).toBe(`chore(L9): régénère les nouveautés (cadence run ${e.id})\nfeat(L9): entrée fait.md\nfeat(L9): entrée fait.md`);
  });

  it('la cible avance pendant la porte avec l\'entrée d\'un autre run : la régénération est retirée avant le rebase et rejouée, sans conflit', () => {
    const repo = projet();
    // Un autre run, parti de la même base : son entrée et ses données régénérées (sans fait.md), intégré pendant la porte de celui-ci.
    git(repo, 'checkout', '-qb', 'cadence/run-autre');
    writeFileSync(join(repo, 'docs', 'nouveautes', 'autre.md'), 'autre'); execNode(repo, 'gen.mjs'); execNode(repo, 'plan.mjs');
    git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'feat(L8): entrée autre.md et données');
    git(repo, 'checkout', '-q', 'main');
    const compte = join(repo, '..', 'porte.compte');
    writeFileSync(join(repo, 'cadence.yaml'), readFileSync(join(repo, 'cadence.yaml'), 'utf8').replace(/test: .*/, `test: grep -q fait.md ${DONNEES} && echo x >> ${compte} && git -C ${repo} merge -q --ff-only cadence/run-autre 2>/dev/null; true`));
    git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'porte');
    git(repo, 'checkout', '-q', 'cadence/run-autre'); git(repo, 'rebase', '-q', 'main'); git(repo, 'checkout', '-q', 'main');
    const { l, out } = io();
    const e = executerRun({ repo, demande: 'x', lot: 'L9', exec: fauxClaude([entree('fait.md')]), out });
    expect(e.etat).toBe('integre');
    expect(l.join('\n')).toMatch(/main a avancé pendant la porte : rebase et porte rejouée/);
    expect(e.conflits ?? []).toEqual([]);
    expect(donnees(repo)).toEqual(['ancienne.md', 'autre.md', 'fait.md']);
    expect(git(repo, 'log', '--format=%s', '-4').split('\n')).toEqual([`chore(L9): régénère les nouveautés (cadence run ${e.id})`, 'feat(L9): entrée fait.md', 'feat(L8): entrée autre.md et données', 'porte']);
    expect(existsSync(e.worktree)).toBe(false);
  });
});
