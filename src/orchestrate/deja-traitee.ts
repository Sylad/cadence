import { changedFiles, isAncestor, resolveCommit } from '../git.js';
import type { LotState } from './state.js';

/** Début d'une proposition de sous-tâche d'une revue (`addProposals`) : les seules marquées, un mineur étant déjà une ligne de fichier précise. */
const SUBTASK = '[sous-tâche ';

/** Lecture du fichier : le sha (7 caractères) du premier commit du lot postérieur à la revue `head` qui le modifie, null si aucun. */
export type TouchedSince = (l: LotState, head: string, file: string) => string | null;

/** Les fichiers que le texte d'une proposition cite (`src/a.ts`, `src/a.ts:42`, `` `docs/z.md` ``), dans l'ordre, sans doublon ; les adresses web et les nombres (`1.5`) n'en sont pas. */
export function citedFiles(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s`'"“”«»(),;*[\]<>]+/)) {
    const tok = raw.replace(/(:\d+(-\d+)?)+$/, '').replace(/[.:!?]+$/, '').replace(/^(\.\/)+/, '');
    if (!tok || tok.includes('://') || !/^[\p{L}\p{N}_@.\-/]+\.[A-Za-z][A-Za-z0-9]+$/u.test(tok) || out.includes(tok)) continue;
    out.push(tok);
  }
  return out;
}

/**
 * La lecture de git : parmi `commits` (sha du lot, du plus ancien au plus récent), ceux qui ne sont pas dans l'histoire de la revue
 * `head`, puis le premier qui modifie `file` (chemin entier ou fin de chemin). Un `head` que le dépôt ne connaît pas, ou une
 * lecture impossible, ne marque rien : mieux vaut une proposition sans marque qu'une marque fausse.
 */
export function touchedByLotCommits(commits: (l: LotState) => string[]): TouchedSince {
  return (l, head, file) => {
    if (!resolveCommit(l.repo, head)) return null;
    for (const c of commits(l)) {
      if (isAncestor(l.repo, c, head)) continue;
      try {
        if (changedFiles(l.repo, c).some((f) => f === file || f.endsWith(`/${file}`))) return c.slice(0, 7);
      } catch {
        return null;
      }
    }
    return null;
  };
}

/**
 * La ligne de proposition rendue au lead (L422) : une sous-tâche proposée dont un fichier cité a été modifié par un commit du lot
 * postérieur à la revue qui l'a émise (`l.proposalHeads`) porte « — peut-être déjà traitée (<sha>) » ; les autres lignes sont inchangées.
 * 28-10 : L230 ouvert sur des propositions déjà corrigées par la passe de correction, 5 passes perdues.
 */
export function proposalLine(l: LotState, proposal: string, touched: TouchedSince): string {
  const head = l.proposalHeads?.[proposal];
  if (!proposal.startsWith(SUBTASK) || !head) return proposal;
  for (const file of citedFiles(proposal)) {
    let sha: string | null = null;
    try {
      sha = touched(l, head, file);
    } catch {
      continue;
    }
    if (sha) return `${proposal} — peut-être déjà traitée (${sha})`;
  }
  return proposal;
}

/** La lecture à employer : celle que l'appelant donne (tests), sinon git sur les commits du lot (`lotCommits` de l'appelant, sinon `fromGit`). */
export const touchedReader = (deps: { touchedSince?: TouchedSince; lotCommits?: (l: LotState) => string[] }, fromGit: (l: LotState) => string[]): TouchedSince => deps.touchedSince ?? touchedByLotCommits(deps.lotCommits ?? fromGit);
