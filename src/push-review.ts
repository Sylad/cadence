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

/**
 * Les notes de verdict d'un lot, texte → nombre : celles qui contiennent la clé (un outil peut préfixer la note, d'une date par exemple). Un multiensemble, pas un
 * compte : un plan à note unique (maritime, `fields.notes: note`, que `raf.py note` remplace) n'en a jamais plus d'une, et une seconde revue la remplace.
 */
function verdictNotes(plan: Plan, key: string): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const lot of plan.lots()) {
    const texts = new Map<string, number>();
    for (const n of lot.notes ?? []) if (n.text.includes(key)) texts.set(n.text.trim(), (texts.get(n.text.trim()) ?? 0) + 1);
    out.set(lot.id, texts);
  }
  return out;
}

/** Une note de verdict du lot apparaît-elle de `before` à `after` (un texte plus fréquent qu'avant) ? */
function verdictAdded(before: Map<string, Map<string, number>>, after: Map<string, Map<string, number>>, lot: string): boolean {
  const was = before.get(lot) ?? new Map<string, number>();
  return [...(after.get(lot) ?? new Map<string, number>())].some(([text, n]) => n > (was.get(text) ?? 0));
}

/** Les commits qu'un push emporte : `distant..local`, ou, pour une branche neuve ou un distant inconnu ici, ceux qu'aucune réf du distant n'a déjà. */
function pushedCommits(root: string, local: string, remote: string | null, remoteName: string): Commit[] {
  return readCommits(root, { range: remote ? [`${remote}..${local}`] : [local, '--not', `--remotes=${remoteName}`] });
}

/** Le sha distant de la ligne du hook, s'il est connu ici (un distant pas encore récupéré ne borne rien). */
const knownRemote = (root: string, sha: string | undefined): string | null => (sha && !ZERO.test(sha) && tryGit(root, ['cat-file', '-e', `${sha}^{commit}`]) !== null ? sha : null);

/** Le juge : le commit `c` du lot, emporté par un push dont la tête locale est `tip`, a-t-il un verdict de revue postérieur ? */
type Judge = (lot: Lot, c: Commit, tip: string) => boolean;

/**
 * Le juge d'un commit de lot : a-t-il un verdict de revue postérieur ? Plan natif : la revue du lot (`raf review`) a relu ce commit ou un descendant
 * (`review.commit`) ; un verdict écrit à la main sans commit relu vaut, comme pour `raf done`. Plan en lecture seule (revue r1) : un commit du plan
 * descendant du commit (vers HEAD ou la tête poussée), ou l'arbre de travail au-dessus de HEAD, ajoute au lot une note de verdict (texte qui contient la clé de
 * `orchestrate.verdict`, champ `notes` mappé par `plan.fields`) absente de son parent. L'historique du plan, pas son état d'aujourd'hui : une seconde revue
 * qui remplace la note unique compte, et une autre note posée ensuite n'efface pas la revue.
 */
function reviewJudge(g: ReviewGuard, key: string | null): Judge {
  if (!g.plan.readonly) {
    return (lot, c) => {
      const at = lot.review?.commit;
      if (!lot.review || at === null) return false;
      return at === undefined || isAncestor(g.root, c.sha, at);
    };
  }
  const now = verdictNotes(g.plan, key!);
  const head = tryGit(g.root, ['rev-parse', '--verify', '-q', 'HEAD']);
  const dir = mkdtempSync(join(tmpdir(), 'cadence-push-review-'));
  const cache = new Map<string, Map<string, Map<string, number>>>();
  /** Les notes de verdict du plan à une révision (un plan absent ou illisible n'en a aucune). */
  const notesAt = (rev: string): Map<string, Map<string, number>> => {
    if (cache.has(rev)) return cache.get(rev)!;
    const text = fileAt(g.root, rev, g.planFile);
    let notes = new Map<string, Map<string, number>>();
    if (text !== null) {
      const file = join(dir, `${cache.size}-${basename(g.planFile)}`);
      writeFileSync(file, text);
      try {
        notes = verdictNotes(g.loadAt(file), key!);
      } catch {
        // Un plan illisible à cette révision : rien n'y est lisible, le commit qui le suit dit seul ce qu'il ajoute.
      }
    }
    cache.set(rev, notes);
    return notes;
  };
  /** Les commits de plan descendants de `sha` (HEAD et la tête poussée), du plus ancien au plus récent. */
  const planCommits = (sha: string, tips: string[]): string[] =>
    (tryGit(g.root, ['log', '--format=%H', '--ancestry-path', '--reverse', `^${sha}`, ...tips, '--', g.planFile]) ?? '').split('\n').filter(Boolean);
  const judge = (lot: Lot, c: Commit, tip: string) => {
    // Le verdict noté dans l'arbre de travail, pas encore commité, au-dessus de HEAD.
    if (head && (head === c.sha || isAncestor(g.root, c.sha, head)) && verdictAdded(notesAt(head), now, lot.id)) return true;
    return planCommits(c.sha, [...new Set([tip, head ?? tip])]).some((p) => verdictAdded(notesAt(`${p}^`), notesAt(p), lot.id));
  };
  return Object.assign(judge, { dispose: () => rmSync(dir, { recursive: true, force: true }) });
}

/** Le geste qui note le verdict d'un lot : `raf review` ou la commande `orchestrate.verdict` du projet. */
function verdictGesture(g: ReviewGuard, lot: string): string {
  if (!g.plan.readonly) return `raf review ${lot} "verdict"`;
  return g.verdictCommand!.replaceAll('{lot}', lot).replaceAll('{verdict}', '…');
}

/**
 * Les commits de lots non relus parmi `commits`, groupés par lot (ordre du log). Les lots d'un commit sont ceux de son SUJET (L771) : la portée
 * « fix(L770): … » quand elle en cite, sinon les identifiants du sujet (« L770 : … », « … (L769) ») ; les lots cités dans le corps n'y comptent pas.
 */
function unreviewedByLot(g: ReviewGuard, commits: Commit[], judge: Judge, tip: string): Map<string, Commit[]> {
  const since = g.plan.readonly ? undefined : g.plan.reviewSince;
  const lots = new Map(g.plan.lots().map((l) => [l.id, l]));
  const out = new Map<string, Commit[]>();
  // Le corps ne désigne pas les lots du commit (L771) : « depuis L679 », « règle L586 » y sont des renvois, pas des lots relus avec lui.
  const subjects = commits.map((c) => ({ ...c, body: '' }));
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  for (const [id, linkedSubjects] of linkCommits(g.plan.lots(), subjects, g.plan.refs).byLot) {
    const linked = linkedSubjects.map((c) => bySha.get(c.sha) ?? c);
    // Commits de plan, de version, acquittés, ignorés ou d'avant l'adoption du plan : rien à relire (`workCommits`, la même règle que `raf done`).
    const late = workCommits(g.plan, g.root, linked).filter((c) => (!since || c.day >= since) && !judge(lots.get(id)!, c, tip));
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
      const byLot = unreviewedByLot(g, pushedCommits(g.root, local, remote, remoteName), judge, local);
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
