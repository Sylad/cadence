// L781 : dans un cadence run, la session ne peut pas jouer les commandes du projet qui appellent cadence (cadence news build, la régénération du plan
// publié) : le 18-11, trois lots (finance L172, L173, warhammer L71) ont été intégrés avec nouveautes-data non régénéré, rejoué à la main par le lead.
// Le run joue lui-même, avant la porte, les commandes que le projet déclare sous run.regenerate de cadence.yaml, et commite leur sortie en un commit du lot.
// Revue r1 : rien n'est deviné d'un nom de script (M1, M3), tous les commits de régénération sont retirés avant un rebase ou une reprise (M2).
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executerRun, repondreRun } from '../src/run/run.js';
import { regenerer, retirerRegenerations, TRAILER_REGENERATION } from '../src/run/regenerer.js';
import { depot, fauxClaude, git, io } from './run-outils.js';
import { dossierTemp } from './temp.js';

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const RACINE = join(import.meta.dirname, '..', '..');
// Générateur du projet (le rôle de `cadence news build`) : la liste des entrées de ../docs/nouveautes ; échoue sur une entrée marquée MAUVAISE.
const GEN = `import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
const d = process.env.NEWS_DIR ?? 'docs/nouveautes', e = readdirSync(d).filter((f) => f.endsWith('.md')).sort();
mkdirSync('public/nouveautes-data', { recursive: true });
writeFileSync('public/nouveautes-data/nouveautes.json', JSON.stringify(e) + '\\n');
if (e.some((f) => readFileSync(d + '/' + f, 'utf8').includes('MAUVAISE'))) { console.error('entrée invalide'); process.exit(3); }
`;
// La régénération du plan publié, qui lit aussi les Nouveautés.
const PLAN = `import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
mkdirSync('public', { recursive: true });
writeFileSync('public/plan.json', JSON.stringify({ nouveautes: readdirSync('docs/nouveautes').length }) + '\\n');
`;

/**
 * Un dépôt de projet dont les données générées sont commitées et à jour. `sous` : le dossier du package.json qui déclare `news` (frontend/ chez
 * warhammer40k et cinq autres dépôts, la racine chez finance-tracker) ; `regenerate` : le bloc run.regenerate de cadence.yaml, absent quand null.
 */
function projet(o: { porte?: string; sous?: string; regenerate?: string | null } = {}): { repo: string; donnees: string } {
  const sous = o.sous ?? '.', donnees = join(sous, 'public/nouveautes-data/nouveautes.json').replace(/^\.\//, '');
  const repo = depot(o.porte ?? `grep -q fait.md ${donnees}`), pkg = join(repo, sous);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'p', private: true, scripts: { news: 'node gen.mjs', plan: 'node plan.mjs' } }));
  writeFileSync(join(pkg, 'gen.mjs'), GEN.replace("process.env.NEWS_DIR ?? 'docs/nouveautes'", sous === '.' ? "'docs/nouveautes'" : "'../docs/nouveautes'"));
  writeFileSync(join(repo, 'plan.mjs'), PLAN);
  const regenerate = o.regenerate === undefined ? `  regenerate:\n    - { command: npm run news${sous === '.' ? '' : `, dir: ${sous}`} }\n    - { command: node plan.mjs }\n` : o.regenerate;
  if (regenerate !== null) writeFileSync(join(repo, 'cadence.yaml'), `${readFileSync(join(repo, 'cadence.yaml'), 'utf8')}run:\n${regenerate}`);
  mkdirSync(join(repo, 'docs', 'nouveautes'), { recursive: true }); writeFileSync(join(repo, 'docs', 'nouveautes', 'ancienne.md'), 'ancienne');
  git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'projet');
  execFileSync(process.execPath, ['gen.mjs'], { cwd: pkg }); execFileSync(process.execPath, ['plan.mjs'], { cwd: repo });
  git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'données');
  return { repo, donnees };
}
/** La session écrit une entrée Nouveautés (texte libre) et la commite, sans toucher aux données générées : elle ne peut pas lancer cadence. */
const entree = (nom: string, texte = 'ok') => (cwd: string) => {
  writeFileSync(join(cwd, 'docs', 'nouveautes', nom), texte); git(cwd, 'add', '-A'); git(cwd, ...ID, 'commit', '-qm', `feat(L9): entrée ${nom}`);
};
const lire = (repo: string, f: string) => JSON.parse(readFileSync(join(repo, f), 'utf8')) as unknown;
const regeneres = (cwd: string, depuis: string) => git(cwd, 'log', `--format=%(trailers:key=${TRAILER_REGENERATION},valueonly)`, `${depuis}..HEAD`).split('\n').filter(Boolean);
const MESSAGE = (id: string) => `chore(L9): régénère les fichiers générés déclarés (cadence run ${id})`;

describe('cadence run : run.regenerate de cadence.yaml, joué par le run avant la porte (L781)', () => {
  it('commandes déclarées : données Nouveautés et plan publié régénérés avant la porte, en un commit du lot au message neutre, intégrés', () => {
    const { repo, donnees } = projet(), { l, out } = io();
    const e = executerRun({ repo, demande: 'Écris l\'entrée', lot: 'L9', exec: fauxClaude([entree('fait.md')]), out });
    expect(e.etat).toBe('integre'); // la porte (grep fait.md dans les données) a vu les données régénérées
    expect(lire(repo, donnees)).toEqual(['ancienne.md', 'fait.md']);
    expect(lire(repo, 'public/plan.json')).toEqual({ nouveautes: 2 });
    expect(git(repo, 'log', '--format=%s', '-2')).toBe(`${MESSAGE(e.id)}\nfeat(L9): entrée fait.md`);
    expect(git(repo, 'log', '-1', '--format=%b')).toContain('run.regenerate : npm run news puis node plan.mjs');
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([donnees, 'public/plan.json']);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(l.join('\n')).toMatch(/fichiers générés régénérés avant la porte \(run\.regenerate, L781\) : commit [0-9a-f]{7}/);
    expect(e.detail).toMatch(/fichiers générés régénérés par le run avant la porte \(run\.regenerate, L781\) : commit [0-9a-f]{7}/);
  });

  it('M1 : la commande déclarée avec dir: frontend (news dans frontend/package.json, comme warhammer40k) est jouée dans ce dossier', () => {
    const { repo, donnees } = projet({ sous: 'frontend' });
    const e = executerRun({ repo, demande: 'x', lot: 'L9', exec: fauxClaude([entree('fait.md')]), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(donnees).toBe('frontend/public/nouveautes-data/nouveautes.json');
    expect(lire(repo, donnees)).toEqual(['ancienne.md', 'fait.md']);
    expect(git(repo, 'log', '-1', '--format=%b')).toContain('(cd frontend && npm run news) puis node plan.mjs');
  });

  it('M3 : sans run.regenerate, rien n\'est joué, même avec un scripts.news dans package.json (le run est celui d\'avant)', () => {
    const { repo, donnees } = projet({ porte: 'test -d docs', regenerate: null });
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([entree('fait.md')]), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(git(repo, 'log', '--format=%s', '-1')).toBe('feat(L9): entrée fait.md');
    expect(lire(repo, donnees)).toEqual(['ancienne.md']);
    expect(e.detail).not.toMatch(/régénérés/);
  });

  it('données déjà à jour : aucun commit de régénération', () => {
    const { repo } = projet({ porte: 'test -d docs' });
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([(cwd) => { writeFileSync(join(cwd, 'autre.txt'), 'x'); git(cwd, 'add', '-A'); git(cwd, ...ID, 'commit', '-qm', 'autre'); }]), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(git(repo, 'log', '--format=%s', '-1')).toBe('autre');
    expect(e.detail).not.toMatch(/régénérés/);
  });

  it('run.regenerate mal formé dans le cadence.yaml du run : rendu à la session comme une porte rouge, jamais lu comme « rien à jouer »', () => {
    const { repo } = projet({ porte: 'test -d docs', regenerate: '  regenerate:\n    - { command: npm run news, dir: ../ailleurs }\n' });
    const appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([entree('fait.md'), () => {}], appels), out: () => {} });
    expect(appels[1].args[appels[1].args.indexOf('-p') + 1]).toMatch(/run\.regenerate\[0\]\.dir : « \.\.\/ailleurs » sort du dépôt/);
    expect(e.etat).toBe('porte-rouge');
  });

  it('régénération en échec : rendue à la session comme une porte rouge, rien de demi-écrit, puis intégrée une fois l\'entrée corrigée', () => {
    const { repo, donnees } = projet(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const e = executerRun({ repo, demande: 'x', lot: 'L9', exec: fauxClaude([entree('fait.md', 'MAUVAISE'), (cwd) => {
      expect(git(cwd, 'status', '--porcelain')).toBe(''); // rien de demi-écrit : les données de l'essai raté sont remises
      entree('fait.md', 'bonne')(cwd);
    }], appels), out: () => {} });
    const prompt = appels[1].args[appels[1].args.indexOf('-p') + 1];
    expect(prompt).toMatch(/porte complète est rouge[\s\S]*\$ npm run news[\s\S]*entrée invalide[\s\S]*sans lancer cette commande toi-même/);
    expect(e.etat).toBe('integre');
    expect(e.corrections?.[0].verte).toBe(true);
    expect(lire(repo, donnees)).toEqual(['ancienne.md', 'fait.md']);
    expect(git(repo, 'log', '--format=%s', '-3')).toBe(`${MESSAGE(e.id)}\nfeat(L9): entrée fait.md\nfeat(L9): entrée fait.md`);
  });

  it('m3 : un échec de régénération ne prend pas l\'unique correction de la porte (entrée corrigée, puis un test rouge corrigé à son tour)', () => {
    const { repo } = projet({ porte: `grep -q fait.md public/nouveautes-data/nouveautes.json && test -f ok.txt` });
    const e = executerRun({ repo, demande: 'x', lot: 'L9', exec: fauxClaude([entree('fait.md', 'MAUVAISE'), entree('fait.md', 'bonne'),
      (cwd) => { writeFileSync(join(cwd, 'ok.txt'), 'ok'); git(cwd, 'add', '-A'); git(cwd, ...ID, 'commit', '-qm', 'fix(L9): ok'); }]), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(e.corrections?.map((c) => c.verte)).toEqual([false, true]);
  });

  it('M2 : régénération, porte rouge, correction commitée, cible qui avance : la régénération ne reste jamais sous la correction, intégré sans conflit', () => {
    const { repo, donnees } = projet();
    // Un autre run, parti de la même base : son entrée et ses données régénérées (sans fait.md), intégré quand la porte de celui-ci passe au vert.
    git(repo, 'checkout', '-qb', 'cadence/run-autre');
    writeFileSync(join(repo, 'docs', 'nouveautes', 'autre.md'), 'autre'); execFileSync(process.execPath, ['gen.mjs'], { cwd: repo }); execFileSync(process.execPath, ['plan.mjs'], { cwd: repo });
    git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'feat(L8): entrée autre.md et données');
    git(repo, 'checkout', '-q', 'main');
    writeFileSync(join(repo, 'cadence.yaml'), readFileSync(join(repo, 'cadence.yaml'), 'utf8')
      .replace(/test: .*/, `test: grep -q fait.md ${donnees} && test -f ok.txt && { git -C ${repo} merge -q --ff-only cadence/run-autre 2>/dev/null; true; }`));
    git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'porte');
    git(repo, 'checkout', '-q', 'cadence/run-autre'); git(repo, 'rebase', '-q', 'main'); git(repo, 'checkout', '-q', 'main');
    const base = git(repo, 'rev-parse', 'HEAD'), vus: string[][] = [];
    const { l, out } = io();
    const e = executerRun({ repo, demande: 'x', lot: 'L9', exec: fauxClaude([entree('fait.md'), (cwd) => {
      vus.push(regeneres(cwd, base)); // la session de correction ne travaille pas par-dessus la régénération
      writeFileSync(join(cwd, 'ok.txt'), 'ok'); git(cwd, 'add', '-A'); git(cwd, ...ID, 'commit', '-qm', 'fix(L9): ok.txt');
    }]), out });
    expect(vus).toEqual([[]]);
    expect(e.etat).toBe('integre');
    expect(l.join('\n')).toMatch(/main a avancé pendant la porte : rebase et porte rejouée/);
    expect(e.conflits ?? []).toEqual([]);
    expect(lire(repo, donnees)).toEqual(['ancienne.md', 'autre.md', 'fait.md']);
    expect(git(repo, 'log', '--format=%s', '-5').split('\n')).toEqual([MESSAGE(e.id), 'fix(L9): ok.txt', 'feat(L9): entrée fait.md', 'feat(L8): entrée autre.md et données', 'porte']);
  });

  it('M2 : --reponse après une porte rouge reprend la session sans le commit de régénération en tête', () => {
    const { repo } = projet({ porte: 'grep -q fait.md public/nouveautes-data/nouveautes.json && test -f ok.txt' });
    const e = executerRun({ repo, demande: 'x', lot: 'L9', exec: fauxClaude([entree('fait.md'), () => {}]), out: () => {} });
    expect(e.etat).toBe('porte-rouge');
    expect(regeneres(e.worktree, e.base)).toEqual([e.id]); // la régénération reste dans le worktree gardé
    const vus: string[][] = [];
    const r = repondreRun(e.id, repo, 'ajoute ok.txt', { out: () => {}, attendre: null, exec: fauxClaude([(cwd) => {
      vus.push(regeneres(cwd, e.base));
      writeFileSync(join(cwd, 'ok.txt'), 'ok'); git(cwd, 'add', '-A'); git(cwd, ...ID, 'commit', '-qm', 'fix(L9): ok.txt');
    }]) });
    expect(vus).toEqual([[]]);
    expect(r.etat).toBe('integre');
    expect(git(repo, 'log', '--format=%s', '-2')).toBe(`${MESSAGE(e.id)}\nfix(L9): ok.txt`);
  });

  it('retirerRegenerations : tous les commits de régénération du run, enfouis ou en tête, et seulement les siens', () => {
    const { repo } = projet({ porte: 'true' }), base = git(repo, 'rev-parse', 'HEAD');
    const c = (f: string, trailer?: string) => { writeFileSync(join(repo, f), f); git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', `${f}${trailer ? `\n\n${TRAILER_REGENERATION}: ${trailer}` : ''}`); };
    c('a'); c('r1', 'run-x'); c('b'); c('r-autre', 'run-y'); c('r2', 'run-x');
    expect(retirerRegenerations(repo, 'run-x', base)).toBe(2);
    expect(git(repo, 'log', '--format=%s', `${base}..HEAD`).split('\n')).toEqual(['r-autre', 'b', 'a']);
  });

  it('m1 : un fichier non commité que la régénération réécrit n\'est ni commité avec elle ni perdu', () => {
    const { repo, donnees } = projet({ porte: 'true' });
    writeFileSync(join(repo, 'docs', 'nouveautes', 'fait.md'), 'ok'); git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'entrée');
    writeFileSync(join(repo, donnees), '["à la main"]\n');
    const g = regenerer(repo, 'run-x', 'L9');
    expect(g?.ok).toBe(false);
    expect(g?.sortie).toMatch(/fichiers non commités réécrits par la régénération : public\/nouveautes-data\/nouveautes\.json/);
    expect(readFileSync(join(repo, donnees), 'utf8')).toBe('["à la main"]\n');
    expect(git(repo, 'log', '--format=%s', '-1')).toBe('entrée');
    expect(git(repo, 'status', '--porcelain')).toBe('M public/nouveautes-data/nouveautes.json');
  });

  it('vrai cadence news build (CLI du dépôt) dans frontend/, comme warhammer40k : nouveautes.json régénéré avec l\'entrée du run', () => {
    // `cadence` du PATH : la CLI de ce dépôt, lancée depuis ses sources (vite-node), sans réseau.
    const bin = dossierTemp('cadence-bin-');
    writeFileSync(join(bin, 'cli.mts'), `import { run } from '${join(RACINE, 'src', 'cli.js')}';\nprocess.exitCode = run(process.argv.slice(2), `
      + `{ cwd: process.cwd(), env: process.env, out: (l) => console.log(l), err: (l) => console.error(l), now: () => new Date('2026-11-19T10:00:00') });\n`);
    writeFileSync(join(bin, 'cadence'), `#!/bin/sh\nexec '${join(RACINE, 'node_modules', '.bin', 'vite-node')}' '${join(bin, 'cli.mts')}' -- "$@"\n`); chmodSync(join(bin, 'cadence'), 0o755);
    const donnees = 'frontend/public/nouveautes-data/nouveautes.json';
    const repo = depot(`grep -q 2026-11-19-ecran ${donnees}`);
    writeFileSync(join(repo, 'cadence.yaml'), `${readFileSync(join(repo, 'cadence.yaml'), 'utf8')}run:\n  regenerate:\n    - { command: npm run news, dir: frontend }\n`);
    mkdirSync(join(repo, '.cadence'), { recursive: true });
    writeFileSync(join(repo, '.cadence', 'raf.yaml'), 'project: demo\nlots:\n  - id: L1\n    title: Écran\n    status: todo\n    visible: true\n');
    mkdirSync(join(repo, 'frontend'), { recursive: true }); mkdirSync(join(repo, 'docs', 'nouveautes'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'nouveautes', '.gitkeep'), '');
    writeFileSync(join(repo, 'frontend', 'package.json'), JSON.stringify({ name: 'front', private: true, scripts: { news: 'cadence news build -o public/nouveautes-data' } }));
    git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'projet');
    const ecrire = (cwd: string) => {
      writeFileSync(join(cwd, 'docs', 'nouveautes', '2026-11-19-ecran.md'), '---\ntitle: Écran\ndate: 2026-11-19\ncreated: 2026-11-19T10:12+01:00\nlots: [L1]\nnocapture: test\n---\nTexte.\n');
      git(cwd, 'add', '-A'); git(cwd, ...ID, 'commit', '-qm', 'feat(L1): entrée');
    };
    const avant = process.env.PATH;
    process.env.PATH = `${bin}:${avant ?? ''}`;
    try {
      const e = executerRun({ repo, demande: 'x', lot: 'L1', exec: fauxClaude([ecrire]), out: () => {} });
      expect(e.etat, e.detail).toBe('integre');
    } finally { process.env.PATH = avant; }
    const json = lire(repo, donnees) as { entries: { slug: string; title: string; lots: string[] }[] };
    expect(json.entries.map((x) => [x.slug, x.title, x.lots])).toEqual([['2026-11-19-ecran', 'Écran', ['L1']]]);
    expect(existsSync(join(repo, 'frontend', 'public', 'nouveautes-data', 'index.html'))).toBe(true);
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['frontend/public/nouveautes-data/index.html', donnees]);
  }, 60_000);
});
