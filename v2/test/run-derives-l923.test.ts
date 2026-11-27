// L923 : vécu 27-11 sur warhammer L133 — `raf start` régénère dans l'arbre principal un fichier dérivé du plan suivi par git
// (frontend/public/plan-data/plan.json, `plan.onWrite.files`), le run change le même fichier, et l'intégration était refusée après 40 min
// (geste du lead : checkout du fichier puis --reponse). Le fichier dérivé est traité comme le plan : régénéré à l'intégration, pas un conflit.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executerRun } from '../src/run/run.js';
import { depot, git } from './run-outils.js';

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const DERIVE = 'public/plan-data/plan.json';
/** La commande plan.onWrite : le fichier dérivé est la liste « id statut » du plan ; échoue quand `casse` existe à la racine. */
const COMMANDE = `test ! -f casse && mkdir -p public/plan-data && sed -n 's/^ *- id: //p; s/^ *status: //p' .cadence/raf.yaml | paste -d' ' - - > ${DERIVE}`;
const plan = (l1: string, l2: string) => `lots:\n  - id: L1\n    status: ${l1}\n  - id: L2\n    status: ${l2}\n`;
/** Ce que `raf` fait à chaque écriture du plan : l'écrire, puis rejouer plan.onWrite. */
function ecrirePlan(repo: string, texte: string): void {
  mkdirSync(join(repo, '.cadence'), { recursive: true });
  writeFileSync(join(repo, '.cadence', 'raf.yaml'), texte);
  execFileSync('sh', ['-c', COMMANDE], { cwd: repo });
}
function depotAvecDerive(onWrite = `  onWrite:\n    command: "${COMMANDE.replaceAll('"', '\\"')}"\n    files: [${DERIVE}]\n`): string {
  const repo = depot();
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test: test -f fait.txt\nplan:\n${onWrite}`);
  ecrirePlan(repo, plan('todo', 'todo'));
  git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-qm', 'plan');
  return repo;
}
/** La session du run : fait.txt, et le fichier dérivé republié par son build (contenu du run). */
const session = (avant?: (cwd: string) => void) => (args: string[], o: { cwd: string }) => {
  avant?.(o.cwd);
  writeFileSync(join(o.cwd, 'fait.txt'), 'ok');
  writeFileSync(join(o.cwd, DERIVE), 'L1 todo\nL2 todo\nbuild du run\n');
  git(o.cwd, 'add', '-A'); git(o.cwd, ...ID, 'commit', '-qm', 'ajoute fait.txt');
  return { stdout: JSON.stringify({ session_id: 's1', total_cost_usd: 0, result: 'fini', subtype: 'success' }), code: 0 };
};
const lire = (repo: string, f: string) => readFileSync(join(repo, f), 'utf8');

describe('cadence run : fichier dérivé du plan modifié dans l\'arbre principal et par le run (L923)', () => {
  it('raf start pendant le run (plan et dérivé non commités) : intégré, le dérivé final suit le plan de l\'arbre, le détail le dit', () => {
    const repo = depotAvecDerive();
    const e = executerRun({ repo, demande: 'x', exec: session(() => ecrirePlan(repo, plan('todo', 'doing'))), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(git(repo, 'log', '--format=%s', '-1')).toBe('ajoute fait.txt');
    expect(lire(repo, DERIVE)).toBe('L1 todo\nL2 doing\n'); // cohérent avec le plan de l'arbre (raf start L2 non commité), pas la sortie du build du run
    expect(lire(repo, '.cadence/raf.yaml')).toBe(plan('todo', 'doing')); // le plan non commité du lead est intact
    expect(e.detail).toMatch(/fichier dérivé du plan modifié dans l'arbre principal et par le run \(public\/plan-data\/plan\.json\) : régénéré par plan\.onWrite après l'avance rapide \(L923\)/);
  });

  it('raf start laissé non commité au lancement (cas warhammer) : le plan et son dérivé partent dans le commit du run, intégré, arbre propre', () => {
    const repo = depotAvecDerive();
    ecrirePlan(repo, plan('doing', 'todo'));
    const e = executerRun({ repo, demande: 'x', lot: 'L1', exec: session(), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(git(repo, 'show', '--name-only', '--format=%s', 'HEAD~1').split('\n').filter(Boolean)).toEqual(['plan: L1 démarré', '.cadence/raf.yaml', DERIVE]);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(e.detail).not.toMatch(/L923/); // l'arbre était propre à l'intégration
  });

  it('dérivé du plan avec un autre fichier modifié que le run touche : refus de L723 inchangé, contenus de l\'arbre gardés', () => {
    const repo = depotAvecDerive();
    writeFileSync(join(repo, 'notes.txt'), 'v1'); git(repo, 'add', '.'); git(repo, ...ID, 'commit', '-qm', 'notes');
    const exec = session((cwd) => { writeFileSync(join(cwd, 'notes.txt'), 'v2'); writeFileSync(join(repo, 'notes.txt'), 'en cours'); ecrirePlan(repo, plan('todo', 'doing')); });
    const e = executerRun({ repo, demande: 'x', exec, out: () => {} });
    expect(e.etat).toBe('refus-integration');
    expect(e.detail).toMatch(/modifications non commitées dans l'arbre principal .* : notes\.txt, public\/plan-data\/plan\.json|: public\/plan-data\/plan\.json, notes\.txt/);
    expect(lire(repo, DERIVE)).toBe('L1 todo\nL2 doing\n');
  });

  it('sans plan.onWrite.command, le fichier n\'est pas dérivé : refus de L723 inchangé', () => {
    const repo = depotAvecDerive(`  path: .cadence/raf.yaml\n`);
    const e = executerRun({ repo, demande: 'x', exec: session(() => ecrirePlan(repo, plan('todo', 'doing'))), out: () => {} });
    expect(e.etat).toBe('refus-integration');
    expect(e.detail).toMatch(/: public\/plan-data\/plan\.json\./);
  });

  it('plan.onWrite en échec après l\'avance rapide : intégré quand même (rien de perdu), le fichier est celui du run et le détail dit de le régénérer', () => {
    const repo = depotAvecDerive();
    const e = executerRun({ repo, demande: 'x', exec: session(() => { ecrirePlan(repo, plan('todo', 'doing')); writeFileSync(join(repo, 'casse'), ''); }), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(lire(repo, DERIVE)).toBe('L1 todo\nL2 todo\nbuild du run\n');
    expect(e.detail).toMatch(/plan\.onWrite en échec après l'avance rapide \(.*code 1\) — le fichier est celui du run ; le régénérer/);
  });
});
