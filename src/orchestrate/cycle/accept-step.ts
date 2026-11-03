import { type LotCtx, workDir as wd, save, stop, transition } from './ctx.js';
import { findAcceptation, acceptationFile, type Acceptation, parseAcceptation, checkAcceptation, planAcceptRuns, acceptCommands, isAcceptList, lockViolations, redSha, sealAcceptation, setVert } from '../accept.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { git } from '../worktree.js';
import { sh } from './sh.js';
import { runGate } from '../gate-parts.js';
import { waveCommits, takeReport, dirtAfter } from './shared.js';
import { ficheOf } from './brief.js';
import { session, badReport } from './session.js';
import { type AcceptReport, checkShape, ACCEPT_SCHEMA } from '../schemas.js';
import { commitPlan } from './plan-writes.js';
import { type Constat } from '../state.js';
const NO_TEST_ACCEPT = 'étape accept : orchestrate.test absent, rien ne prouve que les tests rouges sont exclus du lanceur de tests et de la CI (vérifier à la main la config du lanceur avant de livrer)';export const NO_ACCEPT = 'étape accept ignorée : orchestrate.accept absent (commande dédiée aux tests d\'acceptation), le lot passe de spec à implement sans tests rouges';/** L'acceptation du lot : celle que git suit déjà pour lui (même un ancien `acceptation.json`), sinon `acceptation-<lot>.json` à côté de la fiche. */
export const lotAcceptation = (c: LotCtx, fiche: string): string => findAcceptation(wd(c), c.config.spec.dir, c.lot.lot) ?? acceptationFile(fiche, c.lot.lot);export const listed = (c: LotCtx, json: string): boolean => existsSync(join(wd(c), json));/** Une acceptation porte-t-elle une empreinte par fichier listé ? Le contenu n'est pas comparé (L233) : `empreintes: {}` ou celles d'un autre fichier ne scellent rien. */
const hasSeals = (doc: Acceptation): boolean => !!doc.empreintes && doc.fichiers.every((f) => !!(doc.empreintes as Record<string, string>)[posix.normalize(f)]);/**
 * Une acceptation conforme et SCELLÉE par le programme (empreintes posées), rouge ou verte (`vert: true`, lot relancé dans une nouvelle vague ; une verte et scellée vaut
 * preuve même si son scellé ne tient plus, L233) : elle n'a pu être écrite qu'après la revue de la maquette et les tests rouges, qui ne sont donc pas rejoués. Sans `orchestrate.accept`, aucune preuve.
 */
export function acceptationProof(c: LotCtx, fiche: string): boolean {
  const l = c.lot;
  const json = lotAcceptation(c, fiche);
  if (!c.config.accept || !listed(c, json)) return false;
  const doc = parseAcceptation(readFileSync(join(wd(c), json), 'utf8'));
  if (typeof doc === 'string') return false;
  // Un lot déjà vert (L233) n'a plus d'oracle à écrire : le cycle seul a pu poser `vert: true`, après le scellé et les tests rouges. Même une preuve qui ne tient plus
  // (test rescellé ou corrigé depuis, fiche amendée) ne renvoie jamais à accept, qui réécrirait un oracle vert et exigerait des tests rouges : le lot part à implement ou à la revue.
  // Une verte porte une empreinte par fichier listé, sinon elle n'a jamais été scellée (`empreintes: {}` ou celles d'un autre fichier ne prouvent rien).
  if (!hasSeals(doc)) return false;
  if (doc.vert) return true;
  // Le scellé n'est posé que par le programme : chaque fichier listé doit porter l'empreinte git de son contenu actuel (une clé `empreintes` vide ou copiée d'un autre lot ne prouve rien).
  const emp = doc.empreintes ?? {};
  const sealed = doc.fichiers.every((f) => {
    const norm = posix.normalize(f);
    return existsSync(join(wd(c), norm)) && emp[norm] === git(wd(c), 'hash-object', '--', norm).trim();
  });
  if (!sealed) return false;
  return checkAcceptation(wd(c), json, l.lot, fiche, undefined, { dir: c.config.spec.dir, refsOf: c.loadPlan().refs }).length === 0;
}/** Résultat d'une commande de `orchestrate.accept` lancée pour le lot. */
interface AcceptRun { command: string; code: number; output: string }/**
 * Commandes dédiées aux tests d'acceptation du lot (une chaîne ou une liste, L189) : `{acceptation}` y est remplacé, `CADENCE_ACCEPTATION` (chemin absolu
 * dans les deux cas) et `CADENCE_ACCEPTATION_ROOT` (sa racine) posés. Une commande sans fichier listé sous sa racine n'est pas lancée ; les fichiers
 * listés sous aucune racine sont rendus (`orphans`) sans rien lancer.
 */
async function runAccept(c: LotCtx, json: string): Promise<{ runs: AcceptRun[]; orphans: string[] }> {
  const abs = join(wd(c), json);
  const doc = parseAcceptation(readFileSync(abs, 'utf8'));
  const plan = planAcceptRuns(acceptCommands(c.config.accept), typeof doc === 'string' ? [] : doc.fichiers, !isAcceptList(c.config.accept));
  if (plan.orphans.length) return { runs: [], orphans: plan.orphans };
  const runs: AcceptRun[] = [];
  for (const r of plan.runs) runs.push({ command: r.command, ...(await sh(c, r.command.replaceAll('{acceptation}', abs), 30 * 60_000, { CADENCE_ACCEPTATION: abs, CADENCE_ACCEPTATION_ROOT: r.root || '.' })) });
  return { runs, orphans: [] };
}const tail = (output: string, n = 40): string => output.trim().split('\n').slice(-n).join('\n');/** Écarts des tests d'acceptation écrits par la session (vide = acceptés) : autres lots intacts, acceptation.json conforme, tests rouges, config.test toujours verte. */
async function acceptProblems(c: LotCtx, fiche: string, json: string, headBefore: string | undefined): Promise<string[]> {
  const l = c.lot;
  const out = headBefore ? lockViolations(wd(c), c.config.spec.dir, headBefore, { skip: json }) : [];
  out.push(...checkAcceptation(wd(c), json, l.lot, fiche, l.steps.find((s) => s.kind === 'accept')?.headBefore, { dir: c.config.spec.dir, refsOf: c.loadPlan().refs }));
  if (out.length) return out;
  const red = await runAccept(c, json);
  if (red.orphans.length) out.push(`fichiers listés dans ${json} sous la racine d'aucune commande de orchestrate.accept (le dossier de son « cd <dossier> && » initial, sinon le dépôt) : ${red.orphans.join(', ')} — aucun lanceur ne les prendrait`);
  for (const r of red.runs) if (r.code === 0) out.push(`la commande dédiée « ${r.command} » (orchestrate.accept) passe alors que le code n'existe pas : des tests verts avant le code ne prouvent rien — chaque test doit échouer parce que la fonctionnalité manque\n${tail(r.output, 15)}`);
  if (!c.config.test) {
    if (!l.warnings.includes(NO_TEST_ACCEPT)) l.warnings.push(NO_TEST_ACCEPT);
  } else {
    const ordinary = await runGate((cmd) => sh(c, cmd), c.config.test); // porte en parties (L512) : chaque partie dans son dossier, sortie fusionnée
    if (ordinary.code !== 0) out.push(`orchestrate.test échoue (code ${ordinary.code}) avec les tests rouges commités : les fichiers listés dans ${json} ne sont pas exclus de la config du lanceur (partagée avec la CI) tant que vert est false\n${tail(ordinary.output, 15)}`);
  }
  return out;
}/**
 * Écart de l'acceptation verte et scellée `json` par rapport à ce qu'elle était à `first` (tête d'avant la première session accept du lot), ou null.
 * Admis : le même contenu, ou un rescellé du lead (`cadence spec reseal`, L200) : `vert` et `empreintes` toujours posés, journal `resceaux` allongé, aucun commit
 * du fichier dans une session de la vague, fichier propre. Tout le reste (vert: false, journal effacé, réécriture commitée par la session) est rendu au lead (L233).
 */
function greenDrift(c: LotCtx, json: string, first: string, before: string, was: Acceptation): string | null {
  const l = c.lot;
  if (!listed(c, json)) return 'acceptation.json supprimé depuis la première session accept (verrou des tests d\'acceptation)';
  const text = readFileSync(join(wd(c), json), 'utf8');
  // `before` vient de git() qui rogne les blancs de fin, le fichier écrit par le programme finit par un saut de ligne : les deux se comparent rognés.
  if (text.trim() === before.trim()) return null;
  const now = parseAcceptation(text);
  const dirty = git(wd(c), 'status', '--porcelain', '--', json).trim() !== '';
  let bySession = false;
  try {
    const mine = waveCommits(c, c.lot.repo);
    bySession = git(wd(c), 'log', '--format=%H', `${first}..HEAD`, '--', json).split('\n').some((sha) => sha && mine(sha));
  } catch {
    bySession = true;
  }
  const journal = (a: Acceptation): number => a.resceaux?.length ?? 0;
  if (typeof now !== 'string' && now.vert && now.empreintes && journal(now) > journal(was) && !bySession && !dirty) return null;
  return 'acceptation verte réécrite depuis la première session accept (vert, empreintes ou resceaux changés ; seul un rescellé du lead, `cadence spec reseal`, est admis) : remettre le fichier comme avant la session, par exemple `git checkout <commit vert> -- <fichier>` puis `--resume`';
}/**
 * Étape accept (L173, spec etape-spec S5) : une session distincte de l'implémenteur écrit, depuis la fiche et la maquette seules, les tests
 * d'acceptation rouges. Le programme vérifie (acceptation.json conforme, autres lots intacts, commande dédiée rouge, config.test verte),
 * accorde une seconde passe, puis SCELLE le fichier (empreintes) dans un commit du cycle : c'est le commit rouge du verrou.
 */
export async function acceptStep(c: LotCtx): Promise<void> {
  const l = c.lot;
  const fiche = ficheOf(c);
  if (!fiche || !c.config.accept) {
    l.next = 'implement';
    save(c);
    return;
  }
  const json = lotAcceptation(c, fiche);
  // Un lot déjà vert et scellé (L233) n'a plus d'oracle à écrire, même quand `next` vaut encore accept (question posée pendant accept, puis réponse du lead) : jamais de session accept.
  // Le fichier est lu tel qu'il était avant la première session accept du lot : la seconde passe voit le fichier écrit par la session, qui ne doit pas être vert (checkAcceptation).
  const first = l.steps.find((s) => s.kind === 'accept')?.headBefore;
  let text: string | null = null;
  try {
    text = first ? git(wd(c), 'show', `${first}:${json}`) : listed(c, json) ? readFileSync(join(wd(c), json), 'utf8') : null;
  } catch {
    text = null;
  }
  const doc = text === null ? null : parseAcceptation(text);
  if (doc && typeof doc !== 'string' && doc.vert && hasSeals(doc)) {
    // Le fichier actuel doit être celui de `first` : une session accept qui a réécrit puis commité l'oracle avant de poser sa question (le verrou ne s'applique pas à l'étape accept, `skip`)
    // ne se fait pas adopter comme nouveau commit rouge. Seul un rescellé du lead (journal `resceaux` allongé, commit hors de toute session, fichier propre) est une différence admise.
    const drift = first ? greenDrift(c, json, first, text as string, doc) : null;
    if (drift) {
      stop(c, 'handed-back', `verrou des tests d'acceptation : ${json} : ${drift}`);
      return;
    }
    l.accept = { acceptation: json, rouge: redSha(wd(c), json) ?? '' };
    l.next = 'implement';
    // Un lot en question n'a plus rien à demander : la réponse du lead (« ne réécris rien ») est prise en compte par ce choix, elle ne repart pas dans le brief d'implement.
    l.pendingAnswer = null;
    transition(c, 'implementing', 'acceptation déjà verte : accept ignoré');
    return;
  }
  const done = await session(c, 'accept');
  if (!done) return;
  let rep: AcceptReport;
  try {
    rep = checkShape<AcceptReport>(done.report, ACCEPT_SCHEMA);
  } catch (e) {
    badReport(c, done.step, e);
    return;
  }
  const questions = takeReport(c, done, rep);
  if (questions.length) {
    l.questions = questions;
    l.next = 'accept';
    transition(c, 'question', questions[0]);
    return;
  }
  const dirt = dirtAfter(done);
  if (dirt.length) {
    stop(c, 'handed-back', `dépôt sale après accept : ${dirt.join(', ')}`);
    return;
  }
  const problems = await acceptProblems(c, fiche, json, done.step.headBefore);
  if (problems.length) {
    if (l.acceptProblems) {
      stop(c, 'handed-back', `accept non conforme après 2 passes : ${problems.join(' ; ')}`);
      return;
    }
    l.acceptProblems = problems;
    l.next = 'accept';
    save(c);
    return;
  }
  l.acceptProblems = undefined;
  sealAcceptation(wd(c), json);
  const dirty = await commitPlan(c, `test(${l.lot}): acceptation scellée, empreintes des tests rouges (orchestrate ${c.wave.id})`, wd(c));
  if (dirty) {
    stop(c, 'handed-back', `scellé de ${json} : ${dirty}`);
    return;
  }
  l.accept = { acceptation: json, rouge: git(wd(c), 'rev-parse', 'HEAD') };
  l.next = 'implement';
  save(c);
}/**
 * Retour au vert (S5) : à la fin de chaque implement/fix, quand la commande dédiée passe, le CYCLE (jamais une session) pose `vert: true`
 * dans l'acceptation.json du lot et le commite ; les fichiers rejoignent alors config.test et la CI. Rend un constat quand elle échoue.
 */
export async function acceptGreen(c: LotCtx): Promise<Constat | null> {
  const l = c.lot;
  if (!c.config.accept) return null;
  const json = l.accept?.acceptation ?? findAcceptation(wd(c), c.config.spec.dir, l.lot);
  if (!json || !existsSync(join(wd(c), json))) return null;
  const a = parseAcceptation(readFileSync(join(wd(c), json), 'utf8'));
  if (typeof a === 'string' || a.vert) return null;
  const { runs, orphans } = await runAccept(c, json);
  if (orphans.length) return { source: 'tests', gravite: 'bloquant', texte: `fichiers listés dans ${json} sous la racine d'aucune commande de orchestrate.accept : ${orphans.join(', ')}` };
  const failed = runs.filter((r) => r.code !== 0);
  if (failed.length) return { source: 'tests', gravite: 'bloquant', texte: `tests d'acceptation encore rouges (${failed.map((r) => `${r.command}, code ${r.code}`).join(' ; ')}) : à rendre verts sans modifier les fichiers listés dans ${json} :\n${failed.map((r) => (failed.length > 1 ? `$ ${r.command}\n` : '') + tail(r.output)).join('\n')}` };
  setVert(wd(c), json);
  const dirty = await commitPlan(c, `chore(${l.lot}): acceptation verte, vert: true posé par le cycle (orchestrate ${c.wave.id})`, wd(c));
  if (dirty) return { source: 'tests', gravite: 'bloquant', texte: `vert: true de ${json} : ${dirty}` };
  return null;
}