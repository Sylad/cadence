// Précheck des fichiers partagés (L500) : avant l'implémentation, ce que le lot risque de heurter chez les autres, lu dans git, sans modèle. Inventaire des pertes du
// 31-10 : 19 questions sur 43 portaient sur un test scellé d'un autre lot, 16 des 28 intégrations refusées étaient des conflits.
import { posix } from 'node:path';
import { listAcceptations, parseAcceptation } from './accept.js';
import { git, keptTrees, tryGit } from './worktree.js';

/** Un fichier de test scellé par un autre lot que le lot risque de toucher, et le fichier d'acceptation qui le scelle. */
export interface SealedRisk {
  fichier: string;
  lot: string;
  acceptation: string;
}

/** Un fichier que le lot risque de toucher et que touche aussi `avec` (« projet:lot (vague en cours) » ou « projet:lot (worktree conservé) »). */
export interface SharedFile {
  fichier: string;
  avec: string;
}

/** Ce que le précheck de partage a trouvé pour un lot ; absent de l'état quand les deux listes sont vides. */
export interface Partage {
  scelles: SealedRisk[];
  fichiers: SharedFile[];
}

/** Les fichiers qu'un autre lot (vague en cours ou worktree conservé) a modifiés dans sa branche, depuis son départ. */
export interface OtherTouched {
  label: string;
  files: Set<string>;
}

/**
 * Les fichiers suivis que le texte du lot cite : un chemin exact, ou un nom de fichier sans dossier quand un seul fichier suivi le porte (deux fichiers du même
 * nom : on ne devine pas). Un `:ligne` ou une ponctuation finale ne comptent pas ; `./` initial est ôté.
 */
export function citedFiles(text: string, tracked: readonly string[]): string[] {
  const set = new Set(tracked);
  const byBase = new Map<string, string[]>();
  for (const f of tracked) byBase.set(posix.basename(f), [...(byBase.get(posix.basename(f)) ?? []), f]);
  const out = new Set<string>();
  for (const raw of text.split(/[^\w@./-]+/)) {
    const token = raw.replace(/^(\.\/)+/, '').replace(/[.,;]+$/, '');
    if (!token) continue;
    if (set.has(token)) out.add(token);
    else if (!token.includes('/')) {
      const same = byBase.get(token);
      if (same?.length === 1) out.add(same[0]!);
    }
  }
  return [...out];
}

/**
 * Les tests scellés d'un AUTRE lot (`acceptation-<lot>.json` à `rev`, avec empreintes) que `cited` touche : un de ses fichiers de tests, ou sa fiche, est cité.
 * Un fichier d'acceptation illisible ou sans empreinte (pas scellé) n'est pas listé ; celui du lot lui-même non plus.
 */
export function sealedAtRisk(repo: string, dir: string, lot: string, cited: readonly string[], rev = 'HEAD'): SealedRisk[] {
  const out: SealedRisk[] = [];
  for (const path of listAcceptations(repo, dir, rev)) {
    let text: string;
    try {
      text = git(repo, 'show', `${rev}:${path}`);
    } catch {
      continue;
    }
    const a = parseAcceptation(text);
    if (typeof a === 'string' || a.lot === lot || !a.empreintes || Object.keys(a.empreintes).length === 0) continue;
    for (const f of [...a.fichiers.map((x) => posix.normalize(x)), posix.normalize(a.fiche)]) {
      if (cited.includes(f)) out.push({ fichier: f, lot: a.lot, acceptation: path });
    }
  }
  return out;
}

/** Les fichiers cités que touche aussi un autre lot : un couple par fichier et par lot. */
export function sharedFiles(cited: readonly string[], others: readonly OtherTouched[]): SharedFile[] {
  return others.flatMap((o) => cited.filter((f) => o.files.has(f)).map((fichier) => ({ fichier, avec: o.label })));
}

/**
 * Les fichiers modifiés par les autres lots du dépôt qui ont un worktree : ceux d'une vague vivante (dont la nôtre) et les worktrees conservés, un lot à la fois,
 * sans le lot `own` (`projet:lot`, sa branche d'une vague passée comprise). Seuls les commits non intégrés comptent : `base...branche`.
 */
export function touchedByOthers(repo: string, own: string): OtherTouched[] {
  return keptTrees(repo, { includeActive: true })
    .filter((t) => t.lot !== own && t.unintegrated > 0)
    .map((t) => ({
      label: `${t.lot} (${t.active ? 'vague en cours' : 'worktree conservé'})`,
      files: new Set((tryGit(repo, 'diff', '--name-only', `refs/heads/${t.base}...refs/heads/${t.branch}`) ?? '').split('\n').filter(Boolean)),
    }));
}

/**
 * Le précheck de partage d'un lot : `text` (titre, goal, notes, sous-tâches) dit les fichiers qu'il risque de toucher ; `root` est le worktree du lot (à son départ),
 * `repo` le dépôt qui porte les branches des autres lots. Null quand il n'y a rien à dire. Lève si git ne lit pas le dépôt : l'appelant l'écrit au journal.
 */
export function partageOf(o: { root: string; repo: string; specDir: string; lot: string; key: string; text: string; others?: (repo: string, own: string) => OtherTouched[] }): Partage | null {
  const tracked = git(o.root, 'ls-files', '-z').split('\0').filter(Boolean);
  const cited = citedFiles(o.text, tracked);
  if (!cited.length) return null;
  const scelles = sealedAtRisk(o.root, o.specDir, o.lot, cited);
  const fichiers = sharedFiles(cited, (o.others ?? touchedByOthers)(o.repo, o.key));
  return scelles.length || fichiers.length ? { scelles, fichiers } : null;
}

/** Les lignes du brief implement (anglais, comme le brief) : les tests scellés à ne pas toucher et les fichiers que d'autres lots touchent. Vide sans partage. */
export function partageBrief(p: Partage | undefined): string {
  if (!p) return '';
  const lines: string[] = [];
  if (p.scelles.length) {
    lines.push(
      'Sealed acceptance tests of OTHER lots that this lot may touch (the program compares their fingerprints at the end of the session and hands the lot back, naming the first offending commit): do not modify, rewrite or reseal them. If your own sealed tests contradict one, stop and put the question to the lead naming both tests.',
      ...p.scelles.map((s) => `- ${s.fichier} (sealed by ${s.lot}, ${s.acceptation})`),
    );
  }
  if (p.fichiers.length) {
    lines.push(
      'Files this lot may touch that another lot of the wave or a kept worktree also modifies (an integration conflict is likely): keep your edits to them small and local, and name them under "choix".',
      ...p.fichiers.map((f) => `- ${f.fichier} (also touched by ${f.avec})`),
    );
  }
  return lines.join('\n');
}

/** Les lignes du tableau (français) d'un lot : un signal par test scellé et par fichier partagé. */
export function partageLines(p: Partage | undefined, who: string): string[] {
  if (!p) return [];
  return [
    ...p.scelles.map((s) => `${who} — ⚠ test scellé de ${s.lot} que le lot risque de toucher : ${s.fichier} (${s.acceptation})`),
    ...p.fichiers.map((f) => `${who} — ⚠ fichier que touche aussi ${f.avec} : ${f.fichier}`),
  ];
}
