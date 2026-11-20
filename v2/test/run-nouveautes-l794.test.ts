// L794 : un lot visible rendu par cadence run sans entrée Nouveautés (finance L182, warhammer L67, 20-11). Le brief rendu demande, pour un lot visible du
// plan (`visible: true` ou `screen:`), l'entrée écrite à la main sans commande cadence ; la fin du run et --liste disent « Nouveautés manquante » quand aucune
// entrée du commit du run ne cite le lot, sans bloquer l'intégration. Testé sur le texte du brief rendu, l'état, le journal et --liste.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdRun } from '../src/run/cli.js';
import { executerRun, type Etat } from '../src/run/run.js';
import { entreesQuiCitent, lotVisible } from '../../scripts/nouveautes-du-run.mjs';
import { depot, fauxClaude, git, io } from './run-outils.js';

type Appel = { args: string[]; env: NodeJS.ProcessEnv };
const prompt = (a: Appel) => a.args[a.args.indexOf('-p') + 1];
const MAINTENANT = new Date(2026, 10, 20, 9, 30);
const plan = (champs: string) => `version: 1\nproject: x\nprefix: L\nlots:\n  - id: L1\n    title: Bouton\n    status: todo\n${champs}`;
function avec(repo: string, fichiers: Record<string, string>): string {
  for (const [f, t] of Object.entries(fichiers)) { mkdirSync(join(repo, f, '..'), { recursive: true }); writeFileSync(join(repo, f), t); }
  git(repo, 'add', '-A'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'plan');
  return repo;
}
/** La session : fait.txt (la porte) et, si demandé, des fichiers du dépôt, commités ensemble. */
const travail = (fichiers: Record<string, string> = {}) => (cwd: string) => {
  writeFileSync(join(cwd, 'fait.txt'), 'ok');
  for (const [f, t] of Object.entries(fichiers)) { mkdirSync(join(cwd, f, '..'), { recursive: true }); writeFileSync(join(cwd, f), t); }
  git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'feat(L1): bouton');
};
const entree = (lots: string) => `---\ntitle: Le bouton est plus clair\ndate: 2026-11-20\ncreated: 2026-11-20T09:30+01:00\nlots: ${lots}\ncaptures: [captures/bouton.png]\n---\nLe bouton dit ce qu'il fait.\n`;
async function lancer(repo: string, actions: ((cwd: string) => void)[]) {
  const appels: Appel[] = [], o = io();
  const e = executerRun({ repo, demande: 'Rends le bouton plus clair', lot: 'L1', exec: fauxClaude(actions, appels), out: o.out, maintenant: () => MAINTENANT, attendre: null });
  const liste: string[] = [];
  await cmdRun(['--liste'], { cwd: repo, env: {}, out: (x) => liste.push(x), err: () => {}, now: () => new Date() });
  return { e, p: prompt(appels[0]), journal: o.l.join('\n'), liste: liste.join('\n'), etat: JSON.parse(readFileSync(e.fichier, 'utf8')) as Etat };
}

describe('L794 : entrée Nouveautés d un lot visible dans cadence run', () => {
  it('lot visible sans entrée : le brief rendu la demande à la main, le run s intègre et dit « Nouveautés manquante » (journal, état, --liste)', async () => {
    const r = await lancer(avec(depot(), { '.cadence/raf.yaml': plan('    visible: true\n') }), [travail()]);
    expect(r.p).toContain('Entrée Nouveautés (obligatoire) : le lot L1 est visible dans le plan');
    expect(r.p).toContain('Écris-la toi-même, à la main, sans commande `cadence`');
    expect(r.p).toContain('`docs/nouveautes/2026-11-20-<titre-en-minuscules-avec-tirets>.md`, au format des entrées voisines');
    expect(r.p).toContain('`date: 2026-11-20`');
    expect(r.p).toMatch(/`created: 2026-11-20T09:30[+-]\d{2}:\d{2}`/);
    expect(r.p).toContain('`lots: [L1]`');
    expect(r.p).toContain('Une capture du résultat');
    expect(r.p).toContain('c\'est la seule capture qui va dans le dépôt');
    expect(r.p).not.toContain('run.regenerate'); // rien de déclaré : rien n'est promis
    // la consigne vient avec la demande, avant la ligne qui interdit cadence ; cette ligne ne dit plus d'ignorer les Nouveautés
    expect(r.p.indexOf('Entrée Nouveautés (obligatoire)')).toBeLessThan(r.p.indexOf('\n---\n'));
    expect(r.p).not.toContain('Nouveautés imposées par l\'outil');
    expect(r.p).toContain("N'utilise ni `raf` ni `cadence`. Ignore les parties du CLAUDE.md qui en parlent (plan, lots, vagues, commandes `cadence news`) ; "
      + 'une entrée Nouveautés demandée plus haut s\'écrit quand même, à la main.');
    expect(r.e.etat).toBe('integre'); // sans bloquer l'intégration
    expect(r.journal).toContain('Nouveautés manquante : le lot L1 est visible et aucune entrée de docs/nouveautes/ ne le cite au commit du run — à écrire avant la livraison');
    expect(r.etat).toMatchObject({ lot_visible: true, nouveautes: { entrees: [], manquante: true } });
    expect(r.liste).toContain('  · Nouveautés manquante (lot visible L1)');
  });

  it('lot avec écran (screen sans visible) et entrée commitée qui le cite : pas de « manquante », l entrée est nommée', async () => {
    const r = await lancer(avec(depot(), { '.cadence/raf.yaml': plan('    screen: component\n') }), [
      travail({ 'docs/nouveautes/2026-11-20-le-bouton-est-plus-clair.md': entree('[L1]'), 'docs/nouveautes/captures/bouton.png': 'png' })]);
    expect(r.p).toContain('Entrée Nouveautés (obligatoire) : le lot L1');
    expect(r.e.etat).toBe('integre');
    expect(r.journal).not.toContain('Nouveautés manquante');
    expect(r.journal).toContain('Nouveautés : docs/nouveautes/2026-11-20-le-bouton-est-plus-clair.md (lot visible L1)');
    expect(r.etat.nouveautes).toEqual({ entrees: ['docs/nouveautes/2026-11-20-le-bouton-est-plus-clair.md'], manquante: false });
    expect(r.liste).not.toContain('Nouveautés manquante');
  });

  it('une entrée qui cite un autre lot, ou laissée hors du commit, ne compte pas', async () => {
    const r = await lancer(avec(depot(), { '.cadence/raf.yaml': plan('    visible: true\n') }), [(cwd) => {
      travail({ 'docs/nouveautes/autre.md': entree('[L2]') })(cwd);
      writeFileSync(join(cwd, 'docs/nouveautes/non-commitee.md'), entree('[L1]'));
    }]);
    expect(r.e.etat).toBe('integre'); // le fichier non commité n'empêche pas l'intégration : il n'y arrive pas
    expect(r.journal).toContain('Nouveautés manquante : le lot L1');
  });

  it('lot non visible : ni consigne, ni ligne, ni champ d état', async () => {
    const r = await lancer(avec(depot(), { '.cadence/raf.yaml': plan('') }), [travail()]);
    expect(r.p).not.toContain('Entrée Nouveautés');
    expect(r.journal).not.toMatch(/Nouveautés/);
    expect(r.etat.lot_visible).toBeUndefined();
    expect(r.etat.nouveautes).toBeUndefined();
  });

  it('run sans commit d un lot visible : la fin le dit aussi (worktree gardé)', async () => {
    const r = await lancer(avec(depot(), { '.cadence/raf.yaml': plan('    visible: true\n') }), [() => {}]);
    expect(r.e.etat).toBe('sans-commit');
    expect(r.journal).toContain('Nouveautés manquante : le lot L1');
  });

  it('run.regenerate déclarée : la consigne dit que cadence run reconstruit les fichiers générés', async () => {
    const repo = avec(depot(), { '.cadence/raf.yaml': plan('    visible: true\n'),
      'cadence.yaml': 'orchestrate:\n  test: test -f fait.txt\nrun:\n  regenerate:\n    - command: "true"\n' });
    const r = await lancer(repo, [travail()]);
    expect(r.p).toContain('Les fichiers que le projet génère à partir des entrées sont reconstruits par cadence run après toi (run.regenerate de cadence.yaml) : ne les régénère pas toi-même.');
  });
});

describe('L794 : lecture du plan et des entrées', () => {
  it('lotVisible : visible: true, screen, format mappé (plan.path, plan.lots, plan.fields), sous-tâche ; sinon non', () => {
    expect(lotVisible(avec(depot(), { '.cadence/raf.yaml': plan('    visible: true\n') }), 'L1')).toBe(true);
    expect(lotVisible(avec(depot(), { '.cadence/raf.yaml': plan('    screen: page\n') }), 'L1')).toBe(true);
    expect(lotVisible(avec(depot(), { '.cadence/raf.yaml': plan('    visible: false\n') }), 'L1')).toBe(false);
    expect(lotVisible(avec(depot(), { '.cadence/raf.yaml': plan('    tasks:\n      - id: L1.1\n        title: t\n        visible: true\n') }), 'L1.1')).toBe(true);
    expect(lotVisible(depot(), 'L1')).toBe(false); // pas de plan
    expect(lotVisible(avec(depot(), { '.cadence/raf.yaml': 'lots: [' }), 'L1')).toBe(false); // illisible
    const mappe = avec(depot(), {
      'cadence.yaml': 'orchestrate:\n  test: test -f fait.txt\nplan:\n  path: plan/lots.yaml\n  lots: items\n  fields:\n    id: code\n    visible: affiche\n',
      'plan/lots.yaml': 'items:\n  - code: UX-1\n    affiche: true\n  - code: UX-2\n',
    });
    expect(lotVisible(mappe, 'UX-1')).toBe(true);
    expect(lotVisible(mappe, 'UX-2')).toBe(false);
  });

  it('entreesQuiCitent : lit le commit (pas le disque), lots en liste ou en valeur seule, README et en-tête illisible ignorés', () => {
    const repo = avec(depot(), {
      'docs/nouveautes/a.md': entree('[L1, L2]'), 'docs/nouveautes/b.md': entree('L1'), 'docs/nouveautes/c.md': entree('[L3]'),
      'docs/nouveautes/README.md': entree('[L1]'), 'docs/nouveautes/d.md': '---\nlots: [\n---\n',
    });
    writeFileSync(join(repo, 'docs/nouveautes/e.md'), entree('[L1]')); // non commitée
    expect(entreesQuiCitent(repo, 'L1')).toEqual(['docs/nouveautes/a.md', 'docs/nouveautes/b.md']);
    expect(entreesQuiCitent(repo, 'L9')).toEqual([]);
    expect(entreesQuiCitent(join(repo, '..'), 'L1')).toBeNull(); // pas un dépôt git : illisible, jamais « aucune »
  });
});
