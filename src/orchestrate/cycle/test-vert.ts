import { type LotCtx, workDir as wd, startSha, MAX_PASSES } from './ctx.js';
import { type Plan } from '../../plan.js';
import { lotWork } from '../../audit.js';
import { filesOf } from '../../docsync.js';
import { repoWork } from '../../repos.js';
import { testGateMissing } from '../../testgate.js';
import { docSyncSet } from '../../docsync.js';
import { isParts } from '../gate-parts.js';
import { testsVertsSansCode } from '../../test-sans-code.js';
import { fixAffordable, budgetCount } from './budget.js';
import { toFix } from './review.js';
import { sh } from './sh.js';

/**
 * Porte « test vert sans le code du lot » (L646), une fois par lot, après la porte « code sans test » : un test ajouté par les commits du lot qui est vert aussi avec le code du lot retiré
 * (`testsVertsSansCode`) ne peut pas échouer ; il repart en correction directe, sans session de revue. Jouée seulement avec `orchestrate.testGate` (ses motifs disent code et tests)
 * et `orchestrate.testReplay` en chaîne (sa commande rejoue un fichier seul) ; ni en voie express, ni à la passe des mineurs, ni quand la correction ne serait pas payée (mêmes conditions que la porte « code sans test »).
 * Rend vrai quand le lot part en correction.
 */
async function testVertGate(c: LotCtx, minorsPass: boolean): Promise<boolean> {
  const l = c.lot;
  const gate = c.config.testGate;
  const replay = c.config.testReplay;
  const start = startSha(c);
  if (!gate || typeof replay !== 'string' || isParts(c.config.test) || !start || l.testVert || minorsPass || l.express) return false;
  l.testVert = true;
  const isTest = docSyncSet(gate.tests);
  const isCode = docSyncSet(gate.code);
  const isException = gate.except.length ? docSyncSet(gate.except) : () => false;
  const { refuses, ignores } = await testsVertsSansCode({ dir: wd(c), start, isTest, isCode: (f) => isCode(f) && !isException(f), replay, run: (command, cwd) => sh(c, command, 5 * 60_000, {}, cwd) });
  if (ignores.length) l.warnings.push(`porte « test vert sans le code » : ${ignores.length} test(s) ajouté(s) non joué(s), au-delà de la borne (${ignores.join(', ')})`);
  if (!refuses.length) return false;
  if (l.pass >= MAX_PASSES - 1) l.warnings.push(`porte « test vert sans le code » non jouée en correction : ${l.pass} passe(s) déjà faite(s), la revue arriverait sans passe pour ses majeurs (${refuses.join(', ')})`);
  else if (!fixAffordable(l)) l.warnings.push(`porte « test vert sans le code » non jouée en correction : budget du lot (${budgetCount(l)}) (${refuses.join(', ')})`);
  else {
    toFix(c, [{ source: 'code', gravite: 'majeur', classe: 'test', fichier: refuses[0], texte: `test ajouté qui ne peut pas échouer (vert avec et sans le code du lot, vérifié par le programme en rejouant chaque test dans un arbre où le code du lot est retiré) : ${refuses.join(', ')}. Un test doit être rouge sans le code qu'il garde : fais-le asserter la règle du lot (entrée aux bornes comprise), vois-le échouer sans le code, ou supprime-le s'il ne garde rien.` }], 'test vert sans le code');
    return true;
  }
  return false;
}

/** Porte « code modifié sans test » (L287) : le diff du lot touche du code sans fichier de test → correction directe. Rend vrai quand le lot part en correction. Une fois par lot. */
async function codeSansTestGate(c: LotCtx, plan: Plan, minorsPass: boolean): Promise<boolean> {
  const l = c.lot;
  const gate = c.config.testGate;
  if (gate && !l.testGate && !minorsPass && !l.express) {
    // Le diff du lot : son dépôt et ses dépôts voisins (comme hasWork), sans les fichiers que le lot supprime (du code mort supprimé n'a pas de test à écrire).
    const touched = new Set([
      ...filesOf(wd(c), lotWork(plan, wd(c), l.lot), { withoutDeleted: true }),
      ...(l.repos ?? []).flatMap((r) => [...filesOf(r.path, repoWork(plan, r, l.lot), { withoutDeleted: true })]),
    ]);
    const missing = testGateMissing(gate, touched);
    if (missing.length) {
      l.testGate = true;
      if (l.pass >= MAX_PASSES - 1) l.warnings.push(`porte « code sans test » non jouée : ${l.pass} passe(s) de correction déjà faite(s), la correction prendrait la dernière et la revue arriverait sans passe pour ses majeurs (${missing.join(', ')})`);
      else if (!fixAffordable(l)) l.warnings.push(`porte « code sans test » non jouée : budget du lot (${budgetCount(l)}), il ne reste pas de quoi payer la correction et la revue qui la suit (${missing.join(', ')})`);
      else {
        toFix(c, [{ source: 'code', gravite: 'majeur', fichier: missing[0], texte: `code modifié sans test (orchestrate.testGate, vérifié par le programme) : ${missing.join(', ')} — aucun fichier de test touché par les commits du lot. Écris les tests de chaque règle modifiée, nommés d'après la règle (test d'abord), puis commite avec le lot cité.` }], 'code sans test');
        return true;
      }
    }
  }
  return false;
}

/** Les portes de tests d'après une écriture, dans l'ordre : « code sans test » (L287), puis « test vert sans le code du lot » (L646). Rend vrai quand le lot part en correction. */
export async function testGates(c: LotCtx, plan: Plan, minorsPass: boolean): Promise<boolean> {
  return (await codeSansTestGate(c, plan, minorsPass)) || (await testVertGate(c, minorsPass));
}
