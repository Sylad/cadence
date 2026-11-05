import { type LotCtx, workDir as wd, histPlan, propose, short, save, stop, transition, startSha, MAX_PASSES } from './ctx.js';
import { lockViolations, lotStartHead } from '../accept.js';
import { lotWork, lotCommits, isPlanOnly } from '../../audit.js';
import { session, badReport, type Done } from './session.js';
import { type WorkReport, checkShape, WORK_SCHEMA } from '../schemas.js';
import { type Commit, readCommits, resolveCommit, restoreWorktree, tryGit, unquotePath } from '../../git.js';
import { citedRefs } from '../../link.js';
import { isNonQuestion } from './questions.js';
import { dirtAfter, minorLine, hasWork, takeReport } from './shared.js';
import { git } from '../worktree.js';
import { uxAfterReview, toFix, firstReview } from './review.js';
import { conclude } from './integrate-lot.js';
import { openDocGap, docGaps } from './brief.js';
import { type Constat, expressSummary } from '../state.js';
import { type CheckRun, programChecks } from './checks.js';
import { porteApresEcriture } from './porte-ciblee.js';
import { acceptGreen } from './accept-step.js';
import { gateLabel } from '../gate-parts.js';
import { filesOf, gapMessage } from '../../docsync.js';
import { repoWork } from '../../repos.js';
import { testGateMissing } from '../../testgate.js';
import { fixAffordable, budgetCount } from './budget.js';
import { scheduleProbe, PROBE_RESERVE, type ProbeIo } from '../probe.js';
/** Violations du verrou des tests d'acceptation (L173) par les commits faits depuis `head` ; aucune sans HEAD de départ. */
const sealedViolations = (c: LotCtx, head: string | undefined): string[] => (head ? lockViolations(wd(c), c.config.spec.dir, head, { rouge: c.lot.accept?.rouge ? { [c.lot.accept.acceptation]: c.lot.accept.rouge } : {}, lot: c.lot.lot, lotBase: c.lot.steps.find((s) => s.headBefore)?.headBefore, lotStart: lotStartHead(wd(c), lotWork(histPlan(c), wd(c), c.lot.lot).map((k) => k.sha)), lotCommits: lotCommits(histPlan(c), wd(c), c.lot.lot).map((k) => k.sha) }) : []);

/** Étape d'écriture (implémentation, correction) : contrôles, puis étape suivante décidée. */
export async function work(c: LotCtx, kind: 'implement' | 'fix'): Promise<void> {
  const l = c.lot;
  const minorsPass = kind === 'fix' && l.minorFix === true;
  const docsPass = kind === 'fix' && l.docsFix === true;
  const done = await session(c, kind);
  if (!done) return;
  l.minorFix = false; // la passe des mineurs est jouée : la suite se décide sur son rapport
  let rep: WorkReport;
  try {
    rep = checkShape<WorkReport>(done.report, WORK_SCHEMA);
  } catch (e) {
    badReport(c, done.step, e);
    return;
  }
  // Le lot proposé du bibliothécaire (L306, document hors dépôt) est dans son resume : il devient une proposition du lot, donc une ligne du tableau de fin de vague.
  if (docsPass && /^lot propos/i.test(rep.resume.trim())) propose(c, rep.resume.trim());
  // L'écriture a changé le code (L221) : le verdict et les constats de la revue UX d'avant ne valent plus, l'UX est rejouée après la prochaine revue de code conforme.
  if (!l.small) {
    l.ux = undefined;
    l.uxVerdict = null;
    l.constats = l.constats.filter((k) => k.source !== 'ux');
  }
  const plan = histPlan(c);
  const range = done.step.headBefore ? `${done.step.headBefore}..HEAD` : undefined;
  const commits: Commit[] = readCommits(wd(c), { range });
  // Commits de la session dans chaque dépôt voisin (L62) : de la tête d'avant la session à la tête d'après.
  const theirs = done.others.map((o) => ({ repo: o.repo, commits: o.before.head ? readCommits(o.repo.path, { range: `${o.before.head}..HEAD` }) : [] }));
  const made = commits.length + theirs.reduce((n, t) => n + t.commits.length, 0);
  done.step.commits = [...commits.map(short).reverse(), ...theirs.flatMap((t) => t.commits.map((k) => `[${t.repo.rel}] ${short(k)}`).reverse())];
  // La liste de git fait foi ; l'écart avec celle du rapport est signalé.
  const real = new Set([...commits, ...theirs.flatMap((t) => t.commits)].map((k) => k.sha));
  for (const a of rep.commits) {
    if ([...real].some((s) => s.startsWith(a.sha) || a.sha.startsWith(s.slice(0, 7)))) continue;
    // Reprise : le rapport cite aussi les commits d'une session précédente du lot, hors de la plage de celle-ci.
    const full = /^[0-9a-f]{4,40}$/i.test(a.sha) ? resolveCommit(wd(c), a.sha) : null;
    if (full && lotCommits(plan, wd(c), l.lot).some((k) => k.sha === full)) continue;
    l.warnings.push(full ? `commit annoncé n'appartient pas à ${l.lot} : ${a.sha} ${a.sujet}` : `commit annoncé absent de git : ${a.sha} ${a.sujet}`);
  }
  for (const k of commits) {
    if (isPlanOnly(k.sha, plan, wd(c))) continue;
    if (!citedRefs(k, plan.refs).some((r) => r.lot === l.lot)) l.warnings.push(`commit qui ne cite pas ${l.lot} : ${short(k)}`);
  }
  for (const t of theirs) {
    for (const k of t.commits) if (!citedRefs(k, plan.refs).some((r) => r.lot === l.lot)) l.warnings.push(`commit qui ne cite pas ${l.lot} dans ${t.repo.rel} : ${short(k)}`);
  }
  save(c);

  for (const x of rep.choix ?? []) if (!(l.choix ??= []).includes(x)) l.choix.push(x);
  save(c);

  // Verrou des tests d'acceptation (L173) : ceux de TOUS les lots du dépôt, pas seulement du lot courant ; une modification est une question au lead. Contrôlé à CHAQUE fin de session, une question comprise (L200) :
  // une session qui remplace un test scellé puis pose une question ne passe pas par la reprise du lead pour se faire adopter.
  const locked = sealedViolations(c, done.step.headBefore);
  if (locked.length) {
    stop(c, 'handed-back', `verrou des tests d'acceptation : ${locked.join(' ; ')}`);
    return;
  }
  // La passe des mineurs ne bloque jamais le lot (revue conforme déjà acquise) : une question est rendue en proposition.
  const questions = rep.questions.filter((q) => !isNonQuestion(q));
  // Une entrée filtrée reste visible (avertissement du lot, donc tableau de fin de vague) ; l'entrée vide n'a rien à montrer.
  for (const q of rep.questions) if (q.trim() && isNonQuestion(q)) l.warnings.push(`question ignorée (non-question) : « ${q.trim()} »`);
  if (minorsPass) for (const q of questions) propose(c, `[question passe des mineurs] ${q}`);
  if (!minorsPass && questions.length) {
    l.questions = questions;
    l.next = kind;
    transition(c, 'question', questions[0]);
    return;
  }
  l.docsFix = false; // la passe du bibliothécaire est jouée (une question la garde : la reprise rejoue son brief) : la suite se décide sur son rapport
  const dirt = dirtAfter(done);
  if (dirt.length) {
    stop(c, 'handed-back', `dépôt sale après ${kind} : ${dirt.join(', ')}`);
    return;
  }
  // Reprise : une session précédente de l'étape (correction ordinaire ou passe des mineurs) a pu commiter avant d'être coupée ; la revue d'origine ne vaut alors plus.
  // Référence : le HEAD de départ de la première session coupée de la série qui précède celle-ci (pas la revue, qui peut ne pas exister encore).
  let interruptedAt: string | undefined;
  for (const s of l.steps.slice(0, -1).reverse()) {
    if (s.kind !== 'fix' || s.status !== 'interrupted') break;
    interruptedAt = s.headBefore;
  }
  const headMoved = kind === 'fix' && made === 0 && !!interruptedAt && git(wd(c), 'rev-parse', 'HEAD') !== interruptedAt;
  if (minorsPass && made === 0 && !headMoved) {
    // Rien à corriger (mineurs jugés faux, listés en « choix ») : la revue conforme d'origine vaut, HEAD n'a pas bougé.
    for (const k of l.constats.filter((k) => k.gravite === 'mineur')) propose(c, minorLine('code', k));
    l.constats = [];
    l.warnings.push('passe des mineurs sans commit : le lot conclut sur la revue conforme d\'origine, mineurs rendus en propositions');
    if (l.code && uxAfterReview(c)) {
      // L221 : l'UX finale suit la dernière revue de code conforme, y compris quand la passe des mineurs n'a rien commité.
      l.next = 'ux';
      save(c);
    } else if (l.code) await conclude(c, l.code, ' sans commit');
    else stop(c, 'handed-back', 'passe des mineurs sans commit, mais aucune revue conforme gardée');
    return;
  }
  // La session peut n'avoir plus rien à commiter (réponse du lead, lot commité avant la vague) : le travail du lot est déjà dans git.
  // Même règle côté fix (L56) : la passe n'avait rien à ajouter, le lot a déjà ses commits de travail → revue neuve, à condition que la session donne sa raison (L406, plus bas) ; la passe reste consommée, MAX_PASSES borne la boucle.
  const alreadyDone = hasWork(plan, wd(c), l);
  if (made === 0 && !alreadyDone && !headMoved) {
    stop(c, 'handed-back', `${kind} sans commit`);
    return;
  }
  // L406 : une correction qui ne commite rien doit dire pourquoi (« choix », lu par la revue). Sans raison, la revue relirait les mêmes commits et rendrait les mêmes constats : la passe ne compte pas (toFix l'avait comptée), le lot est rendu.
  const reason = (rep.choix ?? []).some((x) => x.trim()) || !!done.step.answered; // la réponse du lead, que la session a lue dans son brief, vaut raison
  if (kind === 'fix' && made === 0 && !headMoved && !docsPass && !reason) {
    l.pass = Math.max(0, l.pass - 1);
    stop(c, 'handed-back', 'fix sans commit ni raison (choix vide) : la revue aurait relu les mêmes commits');
    return;
  }
  // L317 : la passe du bibliothécaire qui laisse l'écart ouvert (rien commité, ou autre chose que la documentation) ne passe pas à la revue : le lot ne finirait pas prêt, `raf check` resterait rouge.
  if (docsPass) {
    const open = openDocGap(c);
    if (open) {
      stop(c, 'handed-back', open);
      return;
    }
  }
  if (headMoved) l.warnings.push(`${minorsPass ? 'passe des mineurs' : 'correction'} reprise sans nouveau commit : un commit d'une session précédente est relu par la revue`);
  else if (made === 0) l.warnings.push(kind === 'fix' ? 'fix sans nouveau commit : revue lancée sur les commits du lot, avec la raison de la session (choix)' : `${kind} sans nouveau commit : revue lancée sur les commits déjà faits du lot`);

  const red: Constat[] = [];
  // Tests annoncés rouges (L213) : avec orchestrate.test, le programme rejoue et compare à la ligne de base, la session n'est crue que si les tests y sont rouges autrement que par des échecs de départ, et jamais quand sa porte, jouée en suite complète, est verte (L522, quels que soient echecsDeBase et nouveauxEchecs) ; sans, la liste des échecs de base de la session, non vérifiée.
  const claimed: Constat = { source: 'tests', gravite: 'bloquant', texte: `tests annoncés rouges par la session : ${rep.tests.commande} — ${rep.tests.resultat}` };
  let deferred = false;
  const declared = (rep.echecsDeBase ?? []).map((t) => t.trim()).filter(Boolean);
  const newFailures = rep.nouveauxEchecs?.map((t) => t.trim()).filter(Boolean);
  if (!c.config.test && declared.length) {
    l.baseline = { sha: startSha(c) ?? '', failures: declared, verified: false };
    l.warnings.push(`échecs déjà présents au sha de départ selon la session (${declared.length}) : non vérifié par le programme (orchestrate.test absent)`);
  }
  if (!rep.tests.vert) {
    if (c.config.test) deferred = true;
    // Sans orchestrate.test (L215) : champ structuré, pas de lecture de la prose. vert:false + echecsDeBase + nouveauxEchecs présent et vide → pas de correction (non vérifié, signalé à la revue) ; nouveauxEchecs non vide → correction.
    else if (declared.length && newFailures && !newFailures.length) l.warnings.push(`tests annoncés rouges par la session, aucun nouvel échec déclaré (nouveauxEchecs vide) : les échecs sont ceux de la base qu'elle déclare (${declared.length}) ; pas de correction, non vérifié par le programme (orchestrate.test absent)`);
    else if (newFailures?.length) red.push({ ...claimed, texte: `${claimed.texte} — nouveaux échecs déclarés par la session : ${newFailures.join(' ; ')}` });
    else red.push(claimed);
  }
  if (rep.tests.vert && !c.config.test && newFailures?.length) l.warnings.push(`rapport incohérent : tests annoncés verts mais nouveaux échecs déclarés (${newFailures.join(' ; ')}) ; pas de correction, non vérifié par le programme (orchestrate.test absent)`);
  if (!rep.build.vert) red.push({ source: 'tests', gravite: 'bloquant', texte: `build annoncé rouge par la session : ${rep.build.commande} — ${rep.build.resultat}` });
  const runs: CheckRun[] = [];
  if (red.length === 0) {
    const green = await acceptGreen(c);
    if (green) red.push(green);
  }
  // Une annonce de tests rouges (L590, R16) ne se juge que sur la suite complète : la porte ciblée ne joue pas le test annoncé, elle n'a ni ligne de base ni verdict à opposer à l'annonce (L213, L522).
  if (red.length === 0) await programChecks(c, red, runs, porteApresEcriture(deferred));
  if (deferred && red.length === 0 && runs.some((r) => r.label === 'tests' && r.code === 0 && !r.instables?.length)) l.warnings.push(`tests annoncés rouges par la session, mais la porte du programme verte (${gateLabel(c.config.test ?? '')}, code 0) : l'annonce n'est pas crue, pas de correction`);
  else if (deferred && red.length === 0 && !runs.some((r) => r.label === 'tests' && (r.dejaRouges || r.instables?.length))) red.push(claimed);
  if (red.length) {
    toFix(c, red, 'tests rouges');
    return;
  }
  // Porte « code modifié sans test » (L287) : le diff du lot (son dépôt et ses voisins, fichiers supprimés exclus), toutes sessions comprises, touche du code sans fichier de test → correction directe, sans session de revue. Une seule fois par lot, jamais pendant la passe des mineurs, ni quand la correction prendrait la dernière passe (la revue n'en aurait plus), ni quand le budget du lot ne paie plus la correction (la revue, elle, part toujours).
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
        return;
      }
    }
  }
  // Sonde de cas limites (L497) : une fois par lot, après la porte « code sans test », avant le bibliothécaire et la revue.
  if (scheduleProbe(c.config, l, { skip: minorsPass || !alreadyDone, late: l.pass >= MAX_PASSES - 1, pays: fixAffordable(l, false, PROBE_RESERVE), count: budgetCount(l) })) {
    // Les contrôles de la porte restent au lot pendant la sonde : sans nouveau commit de sa part, la revue les reprend pour ce HEAD.
    l.checks = runs.length ? { head: git(wd(c), 'rev-parse', 'HEAD'), tree: git(wd(c), 'rev-parse', 'HEAD^{tree}'), runs } : undefined;
    return save(c);
  }
  await toReview(c, runs, minorsPass);
}

/** Fin d'une écriture dont les portes sont passées : le bibliothécaire (L306), puis la première revue. Aussi la suite d'une sonde (L497) qui n'a rien à corriger. */
async function toReview(c: LotCtx, runs: CheckRun[], minorsPass: boolean): Promise<void> {
  const l = c.lot;
  // Bibliothécaire (L306) : docs.sync signale un document en retard sur les commits du lot → une passe doc-keeper avant la revue, une seule fois par lot, aux mêmes conditions de passe et de budget que la porte « code sans test ». Si elle ne touche pas le document, la revue part et porte l'écart (brief docs.sync, constat majeur).
  if (!l.docsGate && !minorsPass) {
    const { gaps } = docGaps(c);
    if (gaps.length) {
      l.docsGate = true;
      const late = gaps.flatMap((g) => g.touched).join(', ');
      if (l.pass >= MAX_PASSES - 1) l.warnings.push(`bibliothécaire non appelé : ${l.pass} passe(s) de correction déjà faite(s), sa passe prendrait la dernière et la revue arriverait sans passe pour ses majeurs (${late})`);
      else if (!fixAffordable(l)) l.warnings.push(`bibliothécaire non appelé : budget du lot (${budgetCount(l)}), il ne reste pas de quoi payer sa passe et la revue qui la suit (${late})`);
      else {
        l.docsFix = true;
        toFix(c, gaps.map((g) => ({ source: 'code', gravite: 'majeur', fichier: g.touched[0], texte: gapMessage(l.lot, g) })), 'documentation en retard');
        return;
      }
    }
  }
  l.constats = [];
  // Les contrôles du HEAD que la porte vient de jouer restent au lot, express ou non : l'intégration n'y rejoue pas une suite complète verte pour cet arbre (L590, R5).
  l.checks = runs.length ? { head: git(wd(c), 'rev-parse', 'HEAD'), tree: git(wd(c), 'rev-parse', 'HEAD^{tree}'), runs } : undefined;
  // Voie express (L519) : pas de revue séparée, le lead lit le diff ; le lot conclut sur le HEAD que la porte du programme vient de jouer.
  if (l.express) return conclude(c, expressSummary(git(wd(c), 'rev-parse', 'HEAD')));
  l.next = firstReview(c);
  save(c);
}

/** Retire de l'index, un fichier à la fois (un chemin inconnu de l'index fait refuser toute la commande), puis de l'arbre de travail : un fichier que HEAD ne connaît pas est supprimé (L614, issue #39). */
function unstageAndRemove(root: string, files: string[]): string[] {
  for (const f of files) tryGit(root, ['restore', '--staged', '--', f]);
  return restoreWorktree(root, files);
}

/** Ce que la sonde (probe.ts) emprunte au cycle. */
export const probeIo = (c: LotCtx): ProbeIo<Done> => ({
  lot: c.lot, config: c.config, cwd: wd(c), play: () => session(c, 'probe'), take: (step, rep) => takeReport(c, { step }, rep), sealed: (head) => sealedViolations(c, head), dirt: dirtAfter, left: (done) => [...done.after.untracked.filter((f) => !done.before.untracked.includes(f)), ...done.after.tracked.filter((l) => l.startsWith('A') && !done.before.tracked.includes(l)).map((l) => l.slice(3))].map(unquotePath), remove: (files) => unstageAndRemove(wd(c), files), gate: (red, runs) => programChecks(c, red, runs),
  fix: (constats) => toFix(c, constats, 'sonde de cas limites'), review: (runs) => toReview(c, runs, false), handBack: (why) => void stop(c, 'handed-back', why), pays: () => fixAffordable(c.lot), head: () => git(wd(c), 'rev-parse', 'HEAD').trim(),
});