import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LotCtx } from './cycle.js';
import { lotKey, RunStore } from './state.js';
import { branchStaleness, rebaseLotBranch, rebaseRefusal, stalenessText, trackedDirty, tryGit, type recoverTree } from './worktree.js';

/**
 * L676 : des commits du lot existent sur une branche que la reprise ne peut pas mener plus loin (rebase raté, worktree modifié, plan touché) : jamais de session, ni sur cette branche ni sur une
 * branche neuve. Le lot est rendu au lead, état écrit sur disque comme tout rendu (`runLot` ne joue pas un lot rendu, `--status` le montre rendu avec sa cause), et la branche reste intacte ; il garde
 * son arbre planifié, la vague ne passe en mode multi-créneaux que si tous ses lots en ont un.
 */
export function handBackKept(c: LotCtx, outcome: string): void {
  const key = lotKey(c.lot.project, c.lot.lot);
  c.lot.status = 'handed-back';
  c.lot.outcome = `${outcome} ; lot rendu sans session, branche intacte`;
  c.wave.store.writeLot(c.lot);
  c.wave.log(`orchestrate : ${key} : ${c.lot.outcome} (rebaser à la main puis relancer le lot, ou retirer la branche : cadence orchestrate --remove-worktree ${key} --abandon-commits)`);
}

/**
 * Ce que la vague fait de la branche d'une vague passée que `recoverTree` a examinée : refusée, le lot est rendu sans session (`handBackKept`) ; reprise, le journal dit ce que le rebase a rattrapé
 * (L665, L676) et chaque résolution faite à la place de git. L311 : le lot repris ne repasse pas par le contrôle préalable. Il reprend les constats de sa dernière revue (état de la vague qui l'a rendu)
 * et repart à leur correction, ou à la revue quand il en a déjà passé une sans constat ; rendu avant sa première revue (ou état illisible ; les constats `tests` d'un lot rendu pour tests rouges ne
 * font pas une revue, L318), il repart à l'écriture.
 */
export function settleRecovered(c: LotCtx, r: ReturnType<typeof recoverTree>, base: string | null, launchDir: string): void {
  if (!r) return;
  if ('refused' in r) return handBackKept(c, `branche ${r.from} d'une vague précédente non reprise : ${r.refused}`);
  c.wave.log(`orchestrate : ${lotKey(c.lot.project, c.lot.lot)} : branche ${r.from} d'une vague précédente reprise (${r.unintegrated} commit(s) non intégré(s), rebasée sur ${base} : ${r.caughtUp} commit(s) rattrapé(s), ${stalenessText(r)}) : le lot repart de son travail`);
  for (const n of r.notes) c.wave.log(n);
  const old = new RunStore(launchDir, r.from.split('/')[1]).readLot(c.lot.project, c.lot.lot);
  c.lot.resumedFrom = r.from.split('/')[1];
  c.lot.constats = old?.constats ?? [];
  c.lot.resumedReviewed = !!old && (old.constats.some((k) => k.source === 'code') || old.steps.some((s) => s.kind.startsWith('review')));
}

/**
 * L676 : la reprise (`--resume`) d'un lot qui retrouve la branche de SA vague la rebase sur sa base avant toute session, par la même règle que la branche d'une vague passée
 * (`rebaseLotBranch`, celle de l'intégration) ; échoué, le lot est rendu sans session (`handBackKept`). Un lot fini, en attente d'intégration (son rebase est celui de l'intégration) ou dont le
 * worktree porte des fichiers suivis modifiés (R11 : la reprise le refuse déjà, avec sa cause) n'est pas touché, ni une branche que `recoverTree` vient de reprendre (déjà rebasée) ou une branche absente (`base` null).
 */
export function rebaseOwnBranch(c: LotCtx, t: { repo: string; branch: string; dir: string; base: string | null; recovered: boolean }): void {
  if (!t.base || t.recovered || c.lot.next === 'integrate' || ['ready', 'handed-back', 'failed'].includes(c.lot.status)) return;
  const own = existsSync(join(t.dir, '.git')) ? t.dir : null;
  if (own && trackedDirty(own).length) return;
  const key = lotKey(c.lot.project, c.lot.lot);
  const before = branchStaleness(t.repo, t.branch, t.base);
  const tip = tryGit(t.repo, 'rev-parse', `refs/heads/${t.branch}`);
  const old = lotRange(t.repo, t.base, t.branch);
  const r = rebaseLotBranch(t.repo, t.branch, own, t.base, key);
  if (!r.ok) return handBackKept(c, `branche ${t.branch} de la vague non rebasée : ${rebaseRefusal(before, t.base, r.cause)}`);
  if (r.caughtUp === 0) return;
  const carried = carryShas(c, old, lotRange(t.repo, t.base, t.branch), r.tail);
  if (carried === null && tip) {
    // Report impossible (un commit du lot absorbé par la base, ou réordonné) : la branche revient à son sommet d'avant, rien n'est joué sur des shas que l'état ne connaît pas.
    if (own) tryGit(own, 'reset', '--hard', '--quiet', tip);
    else tryGit(t.repo, 'update-ref', `refs/heads/${t.branch}`, tip);
    return handBackKept(c, `branche ${t.branch} de la vague rebasée sur ${t.base} puis remise à son sommet ${tip.slice(0, 7)} : ses commits ne se retrouvent pas un à un après le rebase, la revue gardée et l'ancre du commit rouge ne peuvent pas être reportées`);
  }
  c.wave.log(`orchestrate : ${key} : branche ${t.branch} rebasée sur ${t.base} avant la reprise (${r.caughtUp} commit(s) de ${t.base} rattrapé(s)) : le lot repart de ses commits`);
  for (const n of [...r.notes, ...(carried ?? []).map((f) => `${key} ${f}`)]) c.wave.log(n);
}

/** Les commits du lot sur sa branche (absents de `base`), du plus ancien au plus récent : sha et sujet. */
function lotRange(repo: string, base: string, branch: string): { sha: string; subject: string }[] {
  const out = tryGit(repo, 'log', '--reverse', '--format=%H %s', `refs/heads/${base}..refs/heads/${branch}`) ?? '';
  return out.split('\n').filter(Boolean).map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) }));
}

/**
 * L676 : reporte sur les commits rebasés les shas que l'état du lot garde : `code.head` et `ux.head` (la revue conforme gardée, que `conclude` et l'étape UX comparent au HEAD) et `accept.rouge`
 * (l'ancre du commit rouge des tests d'acceptation, que le verrou compare au dernier commit d'acceptation.json). Le rebase garde l'ordre : quand les commits du lot ont même nombre et mêmes sujets,
 * le n-ième d'avant est le n-ième d'après. Les `tail` derniers commits sont ceux que `rebaseOnto` a ajoutés (`tailCommits`) : aucun sha gardé n'y est reporté. Comme l'intégration, qui reporte
 * un verdict sur le dernier commit de travail du lot (`lotWork`) et non sur ces commits, la revue reste sur le dernier commit du lot ; ces commits sont notés (`rebaseTail`), et `reviewedHead`
 * ne les compte pas comme postérieurs à la revue. Rend les lignes de journal, ou null quand un sha gardé ne peut pas être reporté sûrement ; un sha gardé hors des commits du lot reste tel quel.
 */
function carryShas(c: LotCtx, old: { sha: string; subject: string }[], all: { sha: string; subject: string }[], tail: number): string[] | null {
  const kept = [c.lot.code, c.lot.ux].filter((s) => !!s?.head).map((s) => s!.head as string).concat(c.lot.accept?.rouge ?? []);
  if (!kept.some((sha) => old.some((o) => o.sha === sha))) return [];
  const now = all.slice(0, all.length - tail);
  if (old.length !== now.length || old.some((o, i) => o.subject !== now[i].subject)) return null;
  const map = new Map(old.map((o, i) => [o.sha, now[i].sha]));
  const lines: string[] = [];
  const move = (what: string, sha: string): string => {
    const to = map.get(sha);
    if (!to) return sha;
    lines.push(`${what} reporté(e) sur le commit rebasé : ${sha.slice(0, 7)} → ${to.slice(0, 7)}`);
    return to;
  };
  if (c.lot.code?.head) c.lot.code.head = move('revue de code gardée', c.lot.code.head);
  if (c.lot.ux?.head) c.lot.ux.head = move('revue UX gardée', c.lot.ux.head);
  if (c.lot.accept?.rouge) c.lot.accept.rouge = move('ancre du commit rouge d\'acceptation', c.lot.accept.rouge);
  c.lot.rebaseTail = all.slice(all.length - tail).map((x) => x.sha);
  if (tail) lines.push(`${tail} commit(s) ajouté(s) en queue par le rebase (CHANGELOG, base du cliquet) : la revue gardée reste sur le dernier commit du lot, comme l'intégration reporte un verdict sur le dernier commit de travail et non sur ces commits`);
  c.wave.store.writeLot(c.lot);
  return lines;
}

/** Vrai quand HEAD est le sommet que la revue gardée a relu, ou ne s'en écarte que par les commits que le rebase de `--resume` a ajoutés en queue (`rebaseTail`, L676). */
export function reviewedHead(dir: string, l: { code?: { head: string }; rebaseTail?: string[] }): boolean {
  if (!l.code?.head) return false;
  const after = (tryGit(dir, 'rev-list', `${l.code.head}..HEAD`) ?? '?').split('\n').filter(Boolean);
  return after.every((sha) => l.rebaseTail?.includes(sha));
}
