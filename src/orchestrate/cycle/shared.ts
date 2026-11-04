import { type Plan } from '../../plan.js';
import { type LotState, type Constat, lotKey } from '../state.js';
import { lotWork } from '../../audit.js';
import { repoWork } from '../../repos.js';
import { type LotCtx, propose, workDir as wd, short, save } from './ctx.js';
import { type ReviewReport } from '../schemas.js';
import { type Done, dirtBetween } from './session.js';
import { type Commit, readCommits } from '../../git.js';
import { citedRefs } from '../../link.js';
import { isNonQuestion } from './questions.js';
import { git } from '../worktree.js';
/** Le lot a déjà du travail (commits citant le lot) dans son dépôt ou dans un dépôt voisin. */
export function hasWork(plan: Plan, root: string, l: Pick<LotState, 'repos' | 'lot'>): boolean {
  return lotWork(plan, root, l.lot).length > 0 || (l.repos ?? []).some((r) => repoWork(plan, r, l.lot).length > 0);
}

export const minorLine = (source: string, k: { fichier?: string; ligne?: number; texte: string }) => `[mineur ${source}] ${k.fichier ? `${k.fichier}${k.ligne ? `:${k.ligne}` : ''} — ` : ''}${k.texte}`;

export const withoutLine = (line: string) => line.replace(/^(\[mineur \w+\] .*?):\d+ — /, '$1 — ');

export function addProposals(c: LotCtx, rep: ReviewReport, source: string, head: string, withMinors = true): void {
  if (withMinors) for (const k of rep.constats.filter((k) => k.gravite === 'mineur')) propose(c, minorLine(source, k));
  // La première revue qui émet la proposition en garde la date : une revue suivante qui la redit ne la rajeunit pas.
  for (const t of rep.sousTaches.map((t) => `[sous-tâche ${source}] ${t}`)) propose(c, t, head);
}

export function minorConstats(rep: ReviewReport): Constat[] {
  return rep.constats.filter((k) => k.gravite === 'mineur').map((k) => ({ source: 'code', gravite: k.gravite, fichier: k.fichier, ligne: k.ligne, texte: k.texte }));
}

export function blockingConstats(rep: ReviewReport, source: 'code' | 'ux'): Constat[] {
  return rep.constats.filter((k) => k.gravite === 'bloquant' || k.gravite === 'majeur').map((k) => ({ source, gravite: k.gravite, fichier: k.fichier, ligne: k.ligne, texte: k.texte }));
}

/**
 * Revue de maquette de rang 2 ou plus (L562) : les majeurs marqués strictement `inchange: true` ne comptent pas pour la non-conformité.
 * Rend le rapport sans eux (constats et total annoncé de majeurs) et leurs lignes pour le tableau en suite du lead ; en revue 1 le rapport est rendu tel quel.
 */
export function setAsideUnchanged(rep: ReviewReport, rank: number): { rep: ReviewReport; aside: { line: string; texte: string }[] } {
  const marked = (k: ReviewReport['constats'][number]) => rank >= 2 && k.gravite === 'majeur' && k.inchange === true;
  const aside = rep.constats.filter(marked).map((k) => ({ line: `[suite ux] ${k.fichier ? `${k.fichier}${k.ligne ? `:${k.ligne}` : ''} — ` : ''}${k.texte}`, texte: k.texte }));
  if (!aside.length) return { rep, aside };
  return { rep: { ...rep, majeurs: Math.max(0, rep.majeurs - aside.length), constats: rep.constats.filter((k) => !marked(k)) }, aside };
}

/** Verdict gardé d'une revue conforme (R3) : celui de l'agent, suivi des majeurs laissés en suite pour le lead quand il y en a. */
export function asideVerdict(verdict: string, aside: { texte: string }[]): string {
  if (!aside.length) return verdict;
  return `${verdict} — conforme, ${aside.length} majeur${aside.length > 1 ? 's' : ''} sur un point inchangé en suite pour le lead : ${aside.map((a) => a.texte).join(' ; ')}`;
}

/** Chemins salis par une session : suivis modifiés, nouveaux fichiers non suivis, et ceux des dépôts voisins. */
export function dirtAfter(done: Done): string[] {
  return [...dirtBetween(done.before, done.after), ...done.others.flatMap((o) => dirtBetween(o.before, o.after).map((f) => `${o.repo.rel}: ${f}`))];
}

/** Suite commune des étapes spec et accept : commits de la session (avertis s'ils ne citent pas le lot), choix reportés, vraies questions (les non-questions deviennent un avertissement). */
export function takeReport(c: LotCtx, done: Pick<Done, 'step'>, rep: { choix?: string[]; questions: string[] }): string[] {
  const l = c.lot;
  const commits: Commit[] = readCommits(wd(c), { range: done.step.headBefore ? `${done.step.headBefore}..HEAD` : undefined });
  done.step.commits = commits.map(short).reverse();
  for (const k of commits) if (!citedRefs(k, c.loadPlan().refs).some((r) => r.lot === l.lot)) l.warnings.push(`commit qui ne cite pas ${l.lot} : ${short(k)}`);
  for (const x of rep.choix ?? []) if (!(l.choix ??= []).includes(x)) l.choix.push(x);
  save(c);
  for (const q of rep.questions) if (q.trim() && isNonQuestion(q)) l.warnings.push(`question ignorée (non-question) : « ${q.trim()} »`);
  return rep.questions.filter((q) => !isNonQuestion(q));
}

/**
 * Prédicat « ce commit est l'œuvre d'une session de la vague » (L200) : les commits connus des étapes de TOUS les lots de la vague
 * (`steps[].commits`) et ceux de `headBefore..headAfter` de chaque session terminée. Un rescellé du lead se fait entre deux sessions, hors de ces plages.
 */
export function waveCommits(c: LotCtx, repo: string): (sha: string) => boolean {
  const known = new Set<string>();
  const prefixes: string[] = [];
  for (const l of [c.lot, ...c.wave.store.lots().filter((x) => lotKey(x.project, x.lot) !== lotKey(c.lot.project, c.lot.lot))]) {
    for (const s of l.steps) {
      for (const k of s.commits ?? []) if (/^[0-9a-f]{7,40}\b/i.test(k)) prefixes.push(k.split(' ')[0]!.toLowerCase());
      if (!s.headBefore || !s.headAfter || l.repo !== repo) continue;
      try {
        for (const sha of git(repo, 'rev-list', `${s.headBefore}..${s.headAfter}`).split('\n')) if (sha) known.add(sha);
      } catch {
        // plage illisible (historique réécrit) : les commits connus de l'étape restent comptés
      }
    }
  }
  return (sha) => known.has(sha) || prefixes.some((p) => sha.startsWith(p));
}