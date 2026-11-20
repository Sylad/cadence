// L792 (issue #68) : le brief rendu de cadence run nomme les commandes de vérification du projet quand la demande ou le dépôt a des fiches d'écran,
// et la session peut lancer `cadence spec check` (seule commande cadence permise). Testé sur le texte du brief rendu et les arguments de claude.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executerRun, repondreRun } from '../src/run/run.js';
import { OUTILS_CADENCE } from '../../scripts/commandes-du-brief.mjs';
import { commite, depot, fauxClaude, git } from './run-outils.js';

type Appel = { args: string[]; env: NodeJS.ProcessEnv };
const prompt = (a: Appel) => a.args[a.args.indexOf('-p') + 1];
const interdits = (a: Appel) => a.args[a.args.indexOf('--disallowedTools') + 1].split(',');
function avec(repo: string, fichiers: Record<string, string>): string {
  for (const [f, t] of Object.entries(fichiers)) { mkdirSync(join(repo, f, '..'), { recursive: true }); writeFileSync(join(repo, f), t); }
  git(repo, 'add', '-A'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fiches');
  return repo;
}
const YAML = 'orchestrate:\n  build: test -d docs\n  test: test -f fait.txt\n  accept: npx vitest run -c vitest.acceptation.config.ts\n';

describe('L792 : vérifications nommées dans le brief de cadence run', () => {
  it('un dossier de fiches : spec check, build, test et accept nommés ; « ni raf ni cadence » garde l exception ; cadence spec check permise', () => {
    const repo = avec(depot(), { 'cadence.yaml': YAML, 'docs/specs/accueil/fiche.yaml': 'ecran: {}\n', 'docs/specs/compte/fiche.yaml': 'ecran: {}\n' });
    const appels: Appel[] = [];
    const e = executerRun({ repo, demande: 'Corrige le libellé du bouton', lot: 'L9', exec: fauxClaude([commite('fait.txt')], appels), out: () => {} });
    expect(e).toMatchObject({ etat: 'integre', spec_check: true });
    const p = prompt(appels[0]);
    expect(p).toMatch(/Vérifications du projet \(lues dans cadence\.yaml\)/);
    expect(p).toContain('`docs/specs/<écran>/fiche.yaml`, 2 dans le dépôt) : `cadence spec check <fiche.yaml>`');
    expect(p).toContain('for f in docs/specs/*/fiche.yaml; do cadence spec check "$f"; done');
    expect(p).toContain('- Build (orchestrate.build) : `test -d docs`.');
    expect(p).toContain('- Tests (orchestrate.test) : `test -f fait.txt`.');
    expect(p).toContain('- Tests d\'acceptation (orchestrate.accept) : `npx vitest run -c vitest.acceptation.config.ts`');
    expect(p).toContain("N'utilise ni `raf` ni `cadence` (seule exception : `cadence spec check`, nommée dans les vérifications plus haut)");
    expect(p.indexOf('Lot du plan : L9')).toBeLessThan(p.indexOf('Vérifications du projet'));
    expect(p.indexOf('Vérifications du projet')).toBeLessThan(p.indexOf('\n---\n'));
    const d = interdits(appels[0]);
    expect(d).not.toContain('Bash(cadence:*)');
    expect(d).toEqual(expect.arrayContaining(['Bash(raf:*)', 'Bash(cadence run:*)', 'Bash(cadence orchestrate:*)', 'Bash(cadence deliver:*)', 'Bash(cadence spec reseal:*)', 'Bash(cadence spec green:*)']));
    expect(d.filter((x) => /cadence spec( check)?:/.test(x))).toEqual([]);
  });

  it('la demande parle de fiches d écran sans dossier : spec check nommée (aucune encore), dossier de orchestrate.spec.dir ; brief complet aussi', () => {
    const repo = avec(depot(), { 'cadence.yaml': 'orchestrate:\n  test: test -f fait.txt\n  spec:\n    dir: specs/ecrans/\n' });
    const appels: Appel[] = [];
    executerRun({ repo, demande: 'Amène les fiches d\'écran à « fiche valide »', pieces: ['cadence.yaml'], exec: fauxClaude([commite('fait.txt')], appels), out: () => {} });
    const p = prompt(appels[0]);
    expect(p).toContain('`specs/ecrans/<écran>/fiche.yaml`, aucune encore) : `cadence spec check <fiche.yaml>`');
    expect(p).not.toMatch(/orchestrate\.build|orchestrate\.accept/); // non déclarées : non nommées
    expect(p).toContain("N'utilise ni `raf` ni `cadence` (seule exception : `cadence spec check`"); // brief v2d (mode complet)
    expect(p).toMatch(/Tu es le responsable de cette demande/);
  });

  it('ni fiche ni demande qui en parle : brief inchangé, cadence entièrement interdite', () => {
    const appels: Appel[] = [];
    const e = executerRun({ repo: depot(), demande: 'Crée fait.txt', exec: fauxClaude([commite('fait.txt')], appels), out: () => {} });
    expect(e.spec_check).toBeUndefined();
    expect(prompt(appels[0])).not.toMatch(/Vérifications du projet|spec check/);
    expect(prompt(appels[0])).toContain("N'utilise ni `raf` ni `cadence`. Ignore");
    expect(interdits(appels[0])).toContain('Bash(cadence:*)');
  });

  it('reprise par --reponse : la session garde cadence spec check permise', () => {
    const repo = avec(depot(), { 'docs/specs/accueil/fiche.yaml': 'ecran: {}\n' });
    const appels: Appel[] = [];
    const exec = fauxClaude([(cwd) => writeFileSync(`${cwd}.question.md`, 'Laquelle ?'), commite('fait.txt')], appels);
    const e1 = executerRun({ repo, demande: 'x', exec, out: () => {} });
    expect(e1.etat).toBe('attente');
    expect(repondreRun(e1.id, repo, 'la première', { exec, out: () => {} }).etat).toBe('integre');
    expect(interdits(appels[1])).not.toContain('Bash(cadence:*)');
    expect(interdits(appels[1])).toContain('Bash(cadence run:*)');
  });

  it('chaque outil de bin/cadence.js sauf spec reste interdit (une commande ajoutée au bin sans ici échoue)', () => {
    const bin = readFileSync(join(import.meta.dirname, '..', '..', 'bin', 'cadence.js'), 'utf8');
    const outils = [...bin.matchAll(/tool === '([a-z][a-z-]*)'/g)].map((m) => m[1]);
    const liste = /\[((?:'[a-z-]+',?\s*)+)\]\.includes\(tool\)/.exec(bin)?.[1].match(/[a-z-]+/g) ?? [];
    expect(liste.length).toBeGreaterThan(10);
    for (const o of [...outils, ...liste].filter((x) => x !== 'spec')) expect(OUTILS_CADENCE).toContain(o);
  });
});
