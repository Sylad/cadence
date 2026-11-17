// La garde de revue au push (L766) : un commit de lot poussé sans verdict de revue de code postérieur est refusé par le hook pre-push.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { workCommits } from './audit.js';
import { fileAt, isAncestor, readCommits, tryGit, type Commit } from './git.js';
import { linkCommits } from './link.js';
import type { Lot, Plan } from './plan.js';

/** La variable qui passe outre la garde de revue au push (L766), comme `CADENCE_PUSH_UNGATED` pour la porte. */
export const UNREVIEWED_ENV = 'CADENCE_PUSH_UNREVIEWED';

const ZERO = /^0+$/;
/** Commits de la plage essayés, du plus récent au plus ancien, pour proposer le dernier sha poussable. */
const SAFE_SEARCH = 200;

export interface ReviewGuard {
  /** Le plan tel qu'il est maintenant dans le dépôt : le verdict noté après le commit poussé y est, même s'il n'est pas poussé (push du sha seul). */
  plan: Plan;
  root: string;
  /** Chemin du plan relatif à la racine du dépôt, lu à chaque commit pour un plan en lecture seule. */
  planFile: string;
  /** Charge un fichier de plan avec les réglages du projet (format d'un plan en lecture seule compris). */
  loadAt: (path: string) => Plan;
  /** `orchestrate.verdict` : la commande qui note le verdict d'un plan en lecture seule ; son texte fixe avant `{verdict}` est la clé du verdict. */
  verdictCommand?: string;
}

/**
 * Le texte fixe d'une note de verdict d'un plan en lecture seule, lu dans `orchestrate.verdict` : ce qui précède `{verdict}` dans son dernier argument entre guillemets
 * (`python3 scripts/raf.py note {lot} "revue de code : {verdict}"` → `revue de code :`). Null quand il n'y en a pas : aucune note ne se distingue alors d'un verdict.
 */
export function verdictKey(command: string | undefined): string | null {
  const at = command?.indexOf('{verdict}') ?? -1;
  if (!command || at < 0) return null;
  const before = command.slice(0, at);
  const quote = Math.max(before.lastIndexOf('"'), before.lastIndexOf("'"));
  const key = quote < 0 ? '' : before.slice(quote + 1).trim();
  return key === '' || key.includes('{lot}') ? null : key;
}

/** Les notes de verdict d'un lot : celles dont le texte commence par la clé. */
const verdictNotes = (lot: Lot | undefined, key: string): number => (lot?.notes ?? []).filter((n) => n.text.trim().startsWith(key)).length;

/** Les commits qu'un push emporte : `distant..local`, ou, pour une branche neuve ou un distant inconnu ici, ceux qu'aucune réf du distant n'a déjà. */
function pushedCommits(root: string, local: string, remote: string | null, remoteName: string): Commit[] {
  return readCommits(root, { range: remote ? [`${remote}..${local}`] : [local, '--not', `--remotes=${remoteName}`] });
}

/** Le sha distant de la ligne du hook, s'il est connu ici (un distant pas encore récupéré ne borne rien). */
const knownRemote = (root: string, sha: string | undefined): string | null => (sha && !ZERO.test(sha) && tryGit(root, ['cat-file', '-e', `${sha}^{commit}`]) !== null ? sha : null);

/**
 * Le juge d'un commit de lot : a-t-il un verdict de revue postérieur ? Plan natif : la revue du lot (`raf review`) a relu ce commit ou un descendant
 * (`review.commit`) ; un verdict écrit à la main sans commit relu vaut, comme pour `raf done`. Plan en lecture seule : le lot a, dans le plan d'aujourd'hui,
 * plus de notes de verdict (clé de `orchestrate.verdict`, champ `notes` mappé par `plan.fields`) qu'au commit — une note de verdict est donc venue après lui.
 */
function reviewJudge(g: ReviewGuard, key: string | null): (lot: Lot, c: Commit) => boolean {
  if (!g.plan.readonly) {
    return (lot, c) => {
      const at = lot.review?.commit;
      if (!lot.review || at === null) return false;
      return at === undefined || isAncestor(g.root, c.sha, at);
    };
  }
  const now = new Map(g.plan.lots().map((l) => [l.id, verdictNotes(l, key!)]));
  const past = new Map<string, Map<string, number>>();
  const dir = mkdtempSync(join(tmpdir(), 'cadence-push-review-'));
  const notesAt = (sha: string): Map<string, number> => {
    const text = fileAt(g.root, sha, g.planFile);
    if (text === null) return new Map();
    const file = join(dir, `${sha}-${basename(g.planFile)}`);
    writeFileSync(file, text);
    try {
      return new Map(g.loadAt(file).lots().map((l) => [l.id, verdictNotes(l, key!)]));
    } catch {
      // Un plan illisible à ce commit : rien n'y était noté de lisible, le verdict d'aujourd'hui compte.
      return new Map();
    }
  };
  const judge = (lot: Lot, c: Commit) => {
    if (!past.has(c.sha)) past.set(c.sha, notesAt(c.sha));
    return (now.get(lot.id) ?? 0) > (past.get(c.sha)!.get(lot.id) ?? 0);
  };
  return Object.assign(judge, { dispose: () => rmSync(dir, { recursive: true, force: true }) });
}

/** Le geste qui note le verdict d'un lot : `raf review` ou la commande `orchestrate.verdict` du projet. */
function verdictGesture(g: ReviewGuard, lot: string): string {
  if (!g.plan.readonly) return `raf review ${lot} "verdict"`;
  return g.verdictCommand!.replaceAll('{lot}', lot).replaceAll('{verdict}', '…');
}

/** Les commits de lots non relus parmi `commits`, groupés par lot (ordre du log). */
function unreviewedByLot(g: ReviewGuard, commits: Commit[], judge: (lot: Lot, c: Commit) => boolean): Map<string, Commit[]> {
  const since = g.plan.readonly ? undefined : g.plan.reviewSince;
  const lots = new Map(g.plan.lots().map((l) => [l.id, l]));
  const out = new Map<string, Commit[]>();
  for (const [id, linked] of linkCommits(g.plan.lots(), commits, g.plan.refs).byLot) {
    // Commits de plan, de version, acquittés, ignorés ou d'avant l'adoption du plan : rien à relire (`workCommits`, la même règle que `raf done`).
    const late = workCommits(g.plan, g.root, linked).filter((c) => (!since || c.day >= since) && !judge(lots.get(id)!, c));
    if (late.length) out.set(id, late);
  }
  return out;
}

/** Le plus récent commit de la plage (premier parent) dont l'histoire ne porte aucun commit non relu : ce qu'on peut pousser seul. */
function safeSha(root: string, local: string, remote: string | null, late: Commit[]): string | null {
  const range = tryGit(root, ['rev-list', '--first-parent', `-n${SAFE_SEARCH}`, remote ? `${remote}..${local}` : local]) ?? '';
  return range.split('\n').filter(Boolean).find((c) => late.every((u) => !isAncestor(root, u.sha, c))) ?? null;
}

/**
 * Le refus d'un push qui emporte un commit citant un lot sans verdict de revue postérieur à ce commit (L766), ou null. Pour chaque branche poussée
 * (`refs/heads/`, suppression exceptée), les commits de la plage sont rattachés à leurs lots ; les commits de plan, de version et sans lot passent.
 * La garde ne vaut que si le projet exige la revue : plan natif avec `reviewSince` (`raf review enable`), plan en lecture seule avec un `orchestrate.verdict`
 * dont on lit la clé. Le message nomme les lots et leurs commits, le geste qui note le verdict, le sha qu'on peut pousser seul et la variable qui passe outre.
 */
export function reviewRefusal(g: ReviewGuard, input: string, remoteName = 'origin'): string | null {
  const key = g.plan.readonly ? verdictKey(g.verdictCommand) : null;
  if (g.plan.readonly ? key === null : !g.plan.reviewSince) return null;
  const judge = reviewJudge(g, key);
  try {
    for (const entry of input.split('\n')) {
      const [ref, local, remoteRef, remoteSha] = entry.trim().split(/\s+/);
      if (!ref || !local || ZERO.test(local) || !/^[0-9a-f]{7,64}$/.test(local)) continue;
      const target = remoteRef || ref;
      if (!target.startsWith('refs/heads/')) continue;
      const remote = knownRemote(g.root, remoteSha);
      const byLot = unreviewedByLot(g, pushedCommits(g.root, local, remote, remoteName), judge);
      if (byLot.size === 0) continue;
      const named = [...byLot].map(([lot, cs]) => `${lot} (${cs.map((c) => c.sha.slice(0, 7)).join(', ')})`).join(', ');
      const gestures = [...byLot.keys()].map((lot) => verdictGesture(g, lot)).join(' ; ');
      const safe = safeSha(g.root, local, remote, [...byLot.values()].flat());
      const alone = safe ? ` ; ou pousser seulement le relu : git push ${remoteName} ${safe.slice(0, 7)}:${target.replace(/^refs\/heads\//, '')}` : '';
      return `push refusé — ${local.slice(0, 7)} emporte des commits de lots sans verdict de revue postérieur : ${named} ; relire puis noter le verdict : ${gestures}${alone} ; ${UNREVIEWED_ENV}=1 git push … pour passer outre`;
    }
    return null;
  } finally {
    (judge as { dispose?: () => void }).dispose?.();
  }
}
