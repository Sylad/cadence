import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readPlanConfig } from '../src/config.js';
import { Plan } from '../src/plan.js';
import { planFileSet } from '../src/orchestrate/worktree.js';
import { gitRepo, tempDir, NO_BACKGROUND_GIT } from './helpers.js';
import { fake, run as orchestrate, setup, store, subjects } from './orchestrate-worktree-harness.js';
import { git as gitIn } from './orchestrate-harness.js';

// L346 — plan.onWrite : une commande du projet lancée après chaque écriture du plan, ses fichiers commités avec le plan.
const PLAN = '.cadence/raf.yaml';
const OUT = 'public/plan.json';
/** Une commande qui « publie » le plan : copie le nombre de lignes du plan dans OUT. */
const GENERATE = `mkdir -p public && wc -l < ${PLAN} > ${OUT}`;
const config = (command: string, files = `[${OUT}]`) => `plan:\n  onWrite: { command: '${command}', files: ${files} }\n`;

function cadence(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd, env: { RAF_TODAY: '2026-10-26' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-26T09:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un dépôt avec plan raf et le cadence.yaml donné, tout commité. */
function project(yaml: string) {
  const dir = gitRepo();
  writeFileSync(join(dir, 'cadence.yaml'), yaml);
  cadence(dir, 'init', '--project', 'demo', '--no-hook');
  execFileSync('git', [...NO_BACKGROUND_GIT, 'add', '-A'], { cwd: dir });
  execFileSync('git', [...NO_BACKGROUND_GIT, 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('R1 — la clé plan.onWrite se lit et se valide', () => {
  const read = (yaml: string) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), yaml);
    return () => readPlanConfig(join(dir, 'cadence.yaml'));
  };
  it('R1 — command et files lus, la commande tourne à la racine du dépôt (le dossier de cadence.yaml)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), config('npm run plan'));
    expect(readPlanConfig(join(dir, 'cadence.yaml'))?.settings.onWrite).toEqual({ command: 'npm run plan', files: [OUT], cwd: dir });
  });
  it('R1 — files absent : aucun fichier produit déclaré', () => {
    expect(read("plan:\n  onWrite: { command: 'make' }\n")()?.settings.onWrite?.files).toEqual([]);
  });
  it('R1 — sans command, command vide, sous-clé inconnue, files qui sort du dépôt : refusés en disant la clé', () => {
    expect(read('plan:\n  onWrite: { files: [a.json] }\n')).toThrow(/plan\.onWrite\.command/);
    expect(read("plan:\n  onWrite: { command: '  ' }\n")).toThrow(/plan\.onWrite\.command/);
    expect(read("plan:\n  onWrite: { command: make, cwd: / }\n")).toThrow(/plan\.onWrite\.cwd inconnu/);
    expect(read("plan:\n  onWrite: { command: make, files: ['../hors.json'] }\n")).toThrow(/plan\.onWrite\.files.*hors du dépôt/);
    expect(read('plan:\n  onWrite: make\n')).toThrow(/plan\.onWrite doit être un objet/);
  });
  it('R1 — un dossier déclaré dans files est refusé en nommant la clé, raf add ne plante plus en EISDIR', () => {
    const dir = project(config('mkdir -p pub', '[pub]'));
    mkdirSync(join(dir, 'pub'));
    expect(() => readPlanConfig(join(dir, 'cadence.yaml'))).toThrow(/plan\.onWrite\.files « pub » est un dossier/);
    const r = cadence(dir, 'add', 'x');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('plan.onWrite.files « pub » est un dossier');
    expect(r.err).not.toContain('EISDIR');
  });
  it('R1 — les fichiers produits sont tenus avec le plan (maintained), sans doublon avec plan.files', () => {
    const dir = project(`plan:\n  files: [${OUT}]\n  onWrite: { command: 'true', files: [${OUT}, public/autre.json] }\n`);
    const plan = Plan.load(join(dir, PLAN), readPlanConfig(join(dir, 'cadence.yaml'))!.settings);
    expect(plan.maintained.filter((f) => f === OUT)).toHaveLength(1);
    expect(plan.maintained).toContain('public/autre.json');
  });
});

describe('R2 — raf lance la commande après chaque écriture du plan', () => {
  it('R2 — add, start, note, public, done : la commande tourne à chaque écriture, le fichier produit suit le plan', () => {
    const dir = project(config(GENERATE));
    const lines = () => Number(readFileSync(join(dir, OUT), 'utf8'));
    expect(cadence(dir, 'add', 'un lot').code).toBe(0);
    const afterAdd = lines();
    expect(afterAdd).toBeGreaterThan(0);
    for (const argv of [['start', 'L1'], ['note', 'L1', 'une note'], ['public', 'L1', 'titre public'], ['done', 'L1', '--force']]) {
      const before = lines();
      expect(cadence(dir, ...argv).code, argv.join(' ')).toBe(0);
      expect(lines(), argv.join(' ')).toBeGreaterThanOrEqual(before);
    }
    expect(lines()).toBe(readFileSync(join(dir, PLAN), 'utf8').split('\n').length - 1);
    expect(lines()).toBeGreaterThan(afterAdd);
  });
  it('R2 — la commande reçoit le dossier du projet comme répertoire courant, même lancée d\'un sous-dossier', () => {
    const dir = project(config(GENERATE));
    execFileSync('mkdir', ['-p', join(dir, 'sous/dossier')]);
    expect(cadence(join(dir, 'sous/dossier'), 'add', 'depuis un sous-dossier').code).toBe(0);
    expect(existsSync(join(dir, OUT))).toBe(true);
  });
  it('R2 — sans plan.onWrite, rien ne change : aucun fichier produit', () => {
    const dir = project('');
    expect(cadence(dir, 'add', 'un lot').code).toBe(0);
    expect(existsSync(join(dir, OUT))).toBe(false);
  });
});

describe('R3 — une commande en échec refuse l\'écriture et le dit', () => {
  it('R3 — code non nul : exit 2, message qui nomme la commande, le code et la sortie, plan et fichier produit inchangés', () => {
    const dir = project(config(`${GENERATE} && echo boum >&2 && exit 7`));
    mkdirSync(join(dir, 'public'));
    writeFileSync(join(dir, OUT), 'ancien\n');
    const planBefore = readFileSync(join(dir, PLAN), 'utf8');
    const r = cadence(dir, 'add', 'refusé');
    expect(r.code).toBe(2);
    expect(r.err).toContain('plan.onWrite');
    expect(r.err).toContain('code 7');
    expect(r.err).toContain('boum');
    expect(r.err).toContain('écriture refusée, plan inchangé');
    expect(readFileSync(join(dir, PLAN), 'utf8')).toBe(planBefore);
    expect(readFileSync(join(dir, OUT), 'utf8')).toBe('ancien\n');
  });
  it('R3 — un fichier produit qui n\'existait pas avant est retiré', () => {
    const dir = project(config(`${GENERATE} && exit 1`));
    expect(existsSync(join(dir, OUT))).toBe(false);
    expect(cadence(dir, 'add', 'refusé').code).toBe(2);
    expect(existsSync(join(dir, OUT))).toBe(false);
  });
  it('R3 — le refus vaut pour toutes les commandes qui écrivent le plan (start, note, done)', () => {
    const dir = project(config('true'));
    cadence(dir, 'add', 'un lot');
    writeFileSync(join(dir, 'cadence.yaml'), config('exit 3'));
    const planBefore = readFileSync(join(dir, PLAN), 'utf8');
    for (const argv of [['start', 'L1'], ['note', 'L1', 'x'], ['done', 'L1', '--force']]) {
      expect(cadence(dir, ...argv).code, argv.join(' ')).toBe(2);
      expect(readFileSync(join(dir, PLAN), 'utf8'), argv.join(' ')).toBe(planBefore);
    }
  });
});

describe('R3 bis — chemin mal déclaré et commande qui ne finit pas', () => {
  it('R3 bis — une commande qui réussit sans produire le fichier déclaré : l\'écriture passe, l\'avertissement nomme le chemin', () => {
    const dir = project(config(GENERATE, '[public/plan-data/plan.json]'));
    const r = cadence(dir, 'add', 'chemin faux');
    expect(r.code).toBe(0);
    expect(r.err).toContain('plan.onWrite');
    expect(r.err).toContain('public/plan-data/plan.json');
    expect(r.err).toContain('absent');
  });
  it('R3 bis — un fichier déclaré bien produit : aucun avertissement', () => {
    const dir = project(config(GENERATE));
    expect(cadence(dir, 'add', 'chemin juste').err).toBe('');
  });
  it('R3 bis — délai dépassé : écriture refusée, le message dit le délai, plan inchangé', () => {
    const dir = project('');
    const path = join(dir, PLAN);
    const before = readFileSync(path, 'utf8');
    const plan = Plan.load(path, { onWrite: { command: 'sleep 5', files: [], cwd: dir, timeoutMs: 200 } });
    plan.add('lent', '2026-10-26');
    expect(() => plan.save()).toThrow(/délai de 0\.2 s dépassé.*plan inchangé/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
  it('R3 bis — commande qui ne démarre pas (cwd absent) : écriture refusée, la cause système est dite', () => {
    const dir = project('');
    const path = join(dir, PLAN);
    const before = readFileSync(path, 'utf8');
    const plan = Plan.load(path, { onWrite: { command: 'true', files: [], cwd: join(dir, 'nulle-part') } });
    plan.add('x', '2026-10-26');
    expect(() => plan.save()).toThrow(/plan\.onWrite en échec.*ENOENT.*plan inchangé/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

describe('R4 — orchestrate lance la commande et commite ses fichiers avec le plan', () => {
  const withOnWrite = (command: string | ((parent: string) => string), worktrees = false) => {
    const { parent, repo } = setup([{ title: 'un' }], `worktrees: ${worktrees}\n`);
    writeFileSync(join(repo, 'cadence.yaml'), `${config(typeof command === 'string' ? command : command(parent))}orchestrate:\n  precheck: false\n`);
    gitIn(repo, 'add', '--', 'cadence.yaml');
    gitIn(repo, 'commit', '-q', '-m', 'chore: onWrite');
    return { parent, repo };
  };
  it('R4 — « plan: L1 démarré » contient le plan ET le fichier produit, dans le même commit', async () => {
    const { parent, repo } = withOnWrite(GENERATE);
    const r = await orchestrate(parent, ['a:L1'], fake());
    expect(r.code).toBe(0);
    const started = gitIn(repo, 'log', '--format=%H', '--grep=^plan: L1 démarré', '-1').trim();
    expect(gitIn(repo, 'show', '--name-only', '--format=', started).trim().split('\n').sort()).toEqual([PLAN, OUT]);
    expect(gitIn(repo, 'status', '--porcelain', '--untracked-files=no').trim()).toBe('');
  });
  it('R4 — commande en échec au démarrage : le lot est rendu en disant le refus, le plan reste inchangé', async () => {
    const { parent, repo } = withOnWrite('echo nope >&2; exit 5');
    const before = readFileSync(join(repo, PLAN), 'utf8');
    const r = await orchestrate(parent, ['a:L1'], fake());
    expect(`${r.out}\n${r.err}`).toContain('plan.onWrite');
    expect(readFileSync(join(repo, PLAN), 'utf8')).toBe(before);
    expect(subjects(repo).some((s) => s.startsWith('plan: L1 démarré'))).toBe(false);
  });
  for (const worktrees of [false, true]) {
    it(`R4 — échec au démarrage (worktrees: ${worktrees}) : le lot est rendu (handed-back), pas en échec`, async () => {
      const { parent } = withOnWrite('echo nope >&2; exit 5', worktrees);
      await orchestrate(parent, ['a:L1'], fake());
      const lot = store(parent).readLot('a', 'L1')!;
      expect(lot.status).toBe('handed-back');
      expect(lot.outcome).toContain('plan.onWrite');
    });
    it(`R4 — échec à l'enregistrement de la revue (worktrees: ${worktrees}) : le lot est rendu (handed-back), pas en échec`, async () => {
      const { parent } = withOnWrite((p) => `test -e ${p}/marqueur && exit 5; touch ${p}/marqueur`, worktrees);
      await orchestrate(parent, ['a:L1'], fake());
      const lot = store(parent).readLot('a', 'L1')!;
      expect(lot.status).toBe('handed-back');
      expect(lot.outcome).toContain('plan.onWrite');
    });
  }
});

describe('R9 — une session qui touche un fichier de plan.onWrite dans son worktree voit son lot rendu', () => {
  it('R9 — planFileSet compte les fichiers produits par plan.onWrite avec le plan et plan.files', () => {
    const dir = project(config(GENERATE));
    const plan = Plan.load(join(dir, PLAN), { files: ['docs/gen.md'], onWrite: { command: GENERATE, files: [OUT], cwd: dir } });
    const set = planFileSet(plan, dir);
    expect(set.has(OUT)).toBe(true);
    expect(set.has('docs/gen.md')).toBe(true);
    expect(set.has(PLAN)).toBe(true);
  });
});
