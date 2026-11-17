// L767 : purge du dossier des runs (../.cadence-run) et signalement, dans --liste, d'un run qui se reprend dont la tête est déjà sur la cible.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdRun } from '../src/run/cli.js';
import { joursPurge, purger } from '../src/run/purger.js';
import { executerRun, type Etat } from '../src/run/run.js';
import { commite, depot, fauxClaude, git } from './run-outils.js';

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const lancer = async (repo: string, ...a: string[]) => {
  const sortie: string[] = [], code = await cmdRun(a, { cwd: repo, env: {}, now: () => new Date(), out: (l: string) => sortie.push(l), err: (l: string) => sortie.push(l) });
  return { code, texte: sortie.join('\n') };
};
const dossier = (repo: string) => join(dirname(repo), '.cadence-run');
const dansDossier = (repo: string) => readdirSync(dossier(repo)).sort();
const dans = (jours: number) => () => new Date(Date.now() + jours * 86_400_000);
const reecrire = (e: Etat, x: Partial<Etat>) => writeFileSync(e.fichier, JSON.stringify({ ...JSON.parse(readFileSync(e.fichier, 'utf8')), ...x }));
const porte = (repo: string, yaml: string) => { writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test: test -f fait.txt\n${yaml}`); git(repo, 'add', '.'); git(repo, ...ID, 'commit', '-qm', 'cadence.yaml'); };

/** Un run intégré, avec ce qu'une session laisse à côté du worktree : captures et réglages. */
function runIntegre(repo = depot()): { repo: string; e: Etat } {
  const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([(cwd) => { mkdirSync(`${cwd}.captures`); writeFileSync(join(`${cwd}.captures`, 'a.png'), 'x'); commite('fait.txt')(cwd); }]), out: () => {}, attendre: null });
  expect(e.etat).toBe('integre');
  return { repo, e };
}
/** Un run rendu au lead (porte rouge) : worktree et branche gardés. */
function runRendu(repo = depot()): { repo: string; e: Etat } {
  const e = executerRun({ repo, demande: 'Travaille', exec: fauxClaude([commite('a.txt')]), out: () => {}, attendre: null });
  expect(e.etat).toBe('porte-rouge');
  return { repo, e };
}

describe('cadence run --purger (L767)', () => {
  it('--dry-run liste sans rien retirer ; sans lui, état, verrou, captures et réglages d\'un run intégré ancien sont retirés', () => {
    const { repo, e } = runIntegre(), nom = basename(e.fichier, '.json');
    writeFileSync(`${e.worktree}.question.md`, 'q'); mkdirSync(`${e.worktree}.reglages`); writeFileSync(join(`${e.worktree}.reglages`, 'settings.json'), '{}');
    const avant = dansDossier(repo), l: string[] = [];
    expect(avant).toEqual(expect.arrayContaining([`${nom}.json`, `${nom}.captures`, `${nom}.question.md`, `${nom}.reglages`]));
    expect(purger(repo, dossier(repo), { dryRun: true, out: (x) => l.push(x), maintenant: dans(15) })).toBe(0);
    expect(l[0]).toMatch(new RegExp(`^à purger ${e.id} \\(intégré le \\d{4}-\\d\\d-\\d\\d\\) : ${nom}\\.captures, ${nom}\\.json`));
    expect(l.at(-1)).toBe('1 run à purger (fini depuis plus de 14 j, run.purgeAfterDays) ; pour retirer : cadence run --purger');
    expect(dansDossier(repo)).toEqual(avant);
    l.length = 0;
    expect(purger(repo, dossier(repo), { dryRun: false, out: (x) => l.push(x), maintenant: dans(15) })).toBe(0);
    expect(l.at(-1)).toBe('1 run purgé (fini depuis plus de 14 j, run.purgeAfterDays)');
    expect(dansDossier(repo).filter((f) => f.startsWith(nom))).toEqual([]);
    expect(git(repo, 'log', '--format=%s', '-1')).toBe('ajoute fait.txt'); // le travail est sur la cible, intact
  });

  it('un run fini depuis moins de N jours reste ; run.purgeAfterDays règle N (0 : tout run fini) ; une valeur invalide est refusée sans rien retirer', async () => {
    const { repo, e } = runIntegre();
    expect(await lancer(repo, '--purger')).toEqual({ code: 0, texte: 'aucun run à purger (fini depuis plus de 14 j, run.purgeAfterDays)' });
    expect(existsSync(e.fichier)).toBe(true);
    for (const v of ['-1', '1.5', 'deux']) {
      porte(repo, `run:\n  purgeAfterDays: ${v}\n`);
      expect(() => joursPurge(repo)).toThrow(/run\.purgeAfterDays : un nombre entier de jours/);
      expect((await lancer(repo, '--purger')).code).toBe(1);
      expect(existsSync(e.fichier)).toBe(true);
    }
    porte(repo, 'run:\n  purgeAfterDays: 0\n');
    expect(await lancer(repo, '--purger', '--dry-run')).toMatchObject({ code: 0, texte: expect.stringContaining('1 run à purger (fini depuis plus de 0 j') });
    expect(existsSync(e.fichier)).toBe(true);
    expect((await lancer(repo, '--purger')).code).toBe(0);
    expect(existsSync(e.fichier)).toBe(false);
    expect(await lancer(repo, '--purger', '--force')).toMatchObject({ code: 2, texte: 'usage : cadence run --purger [--dry-run]' });
  });

  it('jamais touchés : un run rendu au lead, en attente (question), interrompu, en quota, ni le run d\'un autre dépôt du même dossier', () => {
    const { repo, e } = runRendu();
    writeFileSync(`${e.worktree}.question.md`, 'q');
    const autre = join(dossier(repo), 'autre-20260101000000-1.json');
    writeFileSync(autre, JSON.stringify({ id: '20260101000000-1', repo: '/ailleurs/autre', etat: 'integre', worktree: '/ailleurs/x', fichier: autre }));
    const avant = dansDossier(repo), l: string[] = [];
    for (const etat of ['porte-rouge', 'attente', 'en-cours', 'quota', 'conflit', 'sans-commit'] as const) {
      reecrire(e, { etat });
      rmSync(e.worktree, { recursive: true, force: true }); // même worktree disparu : pas fini, donc gardé
      expect(purger(repo, dossier(repo), { dryRun: false, out: (x) => l.push(x), maintenant: dans(365) })).toBe(0);
      expect(dansDossier(repo)).toEqual(avant.filter((f) => f !== basename(e.worktree)));
    }
    expect(l.every((x) => x.startsWith('aucun run à purger'))).toBe(true);
  });

  it('un run clos dont le worktree est gardé reste, et la purge le nomme ; worktree retiré, il se purge', async () => {
    const { repo, e } = runRendu();
    writeFileSync(join(e.worktree, 'brouillon.txt'), 'non commité');
    expect((await lancer(repo, '--clore', e.id)).texte).toContain('gardé');
    const l: string[] = [];
    purger(repo, dossier(repo), { dryRun: false, out: (x) => l.push(x), maintenant: dans(30) });
    expect(l).toEqual([`gardé ${e.id} : worktree gardé : ${e.worktree}`, 'aucun run à purger (fini depuis plus de 14 j, run.purgeAfterDays)']);
    expect(existsSync(e.fichier)).toBe(true);
    git(repo, 'worktree', 'remove', '--force', e.worktree);
    l.length = 0;
    purger(repo, dossier(repo), { dryRun: false, out: (x) => l.push(x), maintenant: dans(30) });
    expect(l[0]).toMatch(new RegExp(`^purgé ${e.id} \\(clos le `));
    expect(existsSync(e.fichier)).toBe(false);
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/cadence/archive/')).toContain(e.id); // l'archive git reste
  });

  it('le journal --fond part avec le dernier run qui le cite, pas avant', () => {
    const { repo, e: a } = runIntegre(), journal = join(dossier(repo), 'fond-20260101000000.log');
    const fb = join(dossier(repo), 'projet-20260101000000-2.json'), wt = join(dossier(repo), 'projet-20260101000000-2'); // un second run, rendu au lead
    const b = { ...a, id: '20260101000000-2', fichier: fb, worktree: wt, etat: 'porte-rouge' } as Etat;
    mkdirSync(wt); writeFileSync(fb, JSON.stringify(b)); writeFileSync(journal, 'journal');
    reecrire(a, { journal }); reecrire(b, { journal });
    purger(repo, dossier(repo), { dryRun: false, out: () => {}, maintenant: dans(30) });
    expect(existsSync(a.fichier)).toBe(false);
    expect(existsSync(journal)).toBe(true); // b le cite encore
    reecrire(b, { etat: 'integre' }); rmSync(wt, { recursive: true });
    const l: string[] = [];
    purger(repo, dossier(repo), { dryRun: false, out: (x) => l.push(x), maintenant: dans(30) });
    expect(l[0]).toContain('fond-20260101000000.log');
    expect(existsSync(journal)).toBe(false);
  });
});

describe('cadence run --liste et --clore : run qui se reprend, tête déjà sur la cible (L767)', () => {
  it.each(['interrompu', 'attente', 'quota'])('%s sans processus, intégré à la main : --liste le dit, --clore le clôt', async (vu) => {
    const { repo, e } = runRendu();
    git(repo, 'merge', '-q', '--ff-only', e.branche);
    reecrire(e, { etat: vu === 'interrompu' ? 'en-cours' : vu as Etat['etat'] }); // en-cours sans verrou tenu : interrompu (L709)
    const l = (await lancer(repo, '--liste')).texte;
    expect(l).toMatch(new RegExp(`^${e.id}  ${vu}, sa tête est sur main \\([0-9a-f]{7}\\) : intégré à la main \\? worktree et branche : cadence run --clore ${e.id}`, 'm'));
    const c = await lancer(repo, '--clore', e.id);
    expect(c).toMatchObject({ code: 0, texte: expect.stringContaining('clos — sa tête est sur main') });
    expect(existsSync(e.worktree)).toBe(false);
  });

  it('pas sur la cible : --liste garde l\'état seul, --clore refuse', async () => {
    const { repo, e } = runRendu();
    reecrire(e, { etat: 'attente' });
    expect((await lancer(repo, '--liste')).texte).toMatch(new RegExp(`^${e.id}  attente  `, 'm'));
    expect(await lancer(repo, '--clore', e.id)).toMatchObject({ code: 1, texte: expect.stringContaining('il se reprend') });
    expect(existsSync(e.worktree)).toBe(true);
  });
});
