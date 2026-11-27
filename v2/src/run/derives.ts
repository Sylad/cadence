// L923 : le plan et ses fichiers dérivés (`plan.onWrite.files` de cadence.yaml, ce que `raf` régénère après chaque écriture du plan, par exemple
// frontend/public/plan-data/plan.json chez warhammer) dans l'arbre principal d'un run. Vécu 27-11 (warhammer L133) : `raf start` les régénère dans l'arbre
// principal, le run les change aussi (un build qui republie le plan), et l'intégration était refusée après 40 min pour un fichier que le plan suffit à reproduire.
// Le commit au lancement d'un `raf start` laissé non commité (L796) vit ici aussi : il emporte désormais ces fichiers avec le plan.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { parse } from 'yaml';
import { fichiersNonCommites } from '../../../scripts/arbre-non-commite.mjs';

/** Délai de `plan.onWrite` : le même que celui de raf (src/plan-onwrite.ts, ON_WRITE_TIMEOUT_MS), une republication du plan, pas un build. */
const DELAI_MS = 120_000;
const essaiGit = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const suivi = (repo: string, f: string) => essaiGit(repo, 'cat-file', '-e', `HEAD:${f}`).status === 0;

interface ClePlan { path?: unknown; commit?: unknown; onWrite?: { command?: unknown; files?: unknown } }
export interface DerivesDuPlan { plan: string; commit: string; commande?: string; fichiers: string[] }

/** La clé `plan` du cadence.yaml de l'arbre de `repo` ; vide sans fichier, sans clé ou illisible. */
function clePlan(repo: string): ClePlan {
  try {
    const conf = existsSync(join(repo, 'cadence.yaml')) ? parse(readFileSync(join(repo, 'cadence.yaml'), 'utf8')) as { plan?: ClePlan } | null : null;
    return conf?.plan ?? {};
  } catch {
    return {};
  }
}
const texte = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);

/** Les chemins de `plan.onWrite.files` normalisés comme src/config-onwrite.ts ; un chemin hors du dépôt est écarté. */
function fichiersDeclares(brut: unknown): string[] {
  const liste = Array.isArray(brut) ? brut : [brut];
  return liste.filter((f): f is string => !!texte(f)).map((f) => posix.normalize(f.trim().replace(/\\/g, '/')))
    .filter((f) => f !== '.' && f !== '..' && !f.startsWith('../') && !isAbsolute(f));
}

/** Le plan, le modèle de son commit, la commande et les fichiers de `plan.onWrite`, lus dans le cadence.yaml de l'arbre de `repo`. */
export function derivesDuPlan(repo: string): DerivesDuPlan {
  const p = clePlan(repo), plan = texte(p.path)?.trim() ?? '.cadence/raf.yaml', commande = texte(p.onWrite?.command);
  const fichiers = fichiersDeclares(p.onWrite?.files).filter((f) => f !== plan);
  return { plan, commit: texte(p.commit) ?? 'plan: {lot} {action}', ...(commande ? { commande } : {}), fichiers };
}

/** Rejoue `plan.onWrite` dans `repo` (sa racine, comme raf) : les fichiers dérivés suivent le plan de l'arbre. La raison d'un échec en une ligne. */
export function regenererDerives(repo: string, commande: string): { ok: true } | { ok: false; raison: string } {
  const r = spawnSync('sh', ['-c', commande], { cwd: repo, encoding: 'utf8', timeout: DELAI_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!r.error && r.status === 0) return { ok: true };
  const delai = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const pourquoi = r.error ? (delai ? `délai de ${DELAI_MS / 1000} s dépassé` : r.error.message) : `code ${r.status ?? r.signal}`;
  const ligne = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.split('\n').map((l) => l.trim()).find(Boolean);
  return { ok: false, raison: `${commande}, ${pourquoi}${ligne ? ` : ${ligne}` : ''}` };
}

/** Le contenu de chaque fichier de `repo` (null : absent), pour le remettre tel quel si l'avance rapide échoue. */
const garder = (repo: string, fichiers: string[]) => new Map(fichiers.map((f) => [f, existsSync(join(repo, f)) ? readFileSync(join(repo, f)) : null] as const));
/** Remet chaque fichier au commit HEAD ; un fichier que HEAD ne suit pas est retiré de l'index puis de l'arbre. */
function remettre(repo: string, fichiers: string[]): void {
  for (const f of fichiers) {
    if (suivi(repo, f)) essaiGit(repo, 'checkout', '-q', 'HEAD', '--', f);
    else { essaiGit(repo, 'reset', '-q', '--', f); rmSync(join(repo, f), { force: true }); }
  }
}
function restaurer(repo: string, avant: Map<string, Buffer | null>): void {
  for (const [f, contenu] of avant) if (contenu) { mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), contenu); }
}

export interface Refus { avance: boolean; raison: string }
/** `avancer` : l'avance rapide, vraie si elle a réussi ; `aAvance` : la cible a bougé ; `refus` : celui de L723 ; `dire` : la ligne du détail. */
export interface AvanceSurDerives { avancer: () => boolean; aAvance: () => boolean; refus: () => Refus; dire: (ligne: string) => void }

/**
 * L923 : `sales`, les fichiers non commités de l'arbre principal que le run modifie aussi. S'ils ne sont pas tous dérivés du plan (ou sans `plan.onWrite.command`),
 * le refus de L723. Sinon ils sont remis au commit de la cible, l'avance rapide est jouée, puis `plan.onWrite` les régénère depuis le plan de l'arbre : le fichier
 * final suit le plan, comme après un `raf start`. Une avance rapide refusée remet leurs contenus tels quels. Null : intégré.
 */
export function avancerSurDerives(repo: string, sales: string[], o: AvanceSurDerives): Refus | null {
  const d = derivesDuPlan(repo);
  if (!d.commande || !sales.every((f) => d.fichiers.includes(f))) return o.refus();
  const avant = garder(repo, sales);
  remettre(repo, sales);
  if (!o.avancer()) { restaurer(repo, avant); return { avance: o.aAvance(), raison: 'avance rapide impossible' }; }
  const r = regenererDerives(repo, d.commande), debut = `fichier dérivé du plan modifié dans l'arbre principal et par le run (${sales.join(', ')})`;
  o.dire(r.ok ? `${debut} : régénéré par plan.onWrite après l'avance rapide (L923)`
    : `${debut} : plan.onWrite en échec après l'avance rapide (${r.raison}) — le fichier est celui du run ; le régénérer (une écriture du plan par raf) (L923)`);
  return null;
}
/** La ligne du détail de fin d'un run intégré malgré des fichiers dérivés du plan modifiés dans l'arbre principal. */
export const lignesDerives = (e: { derives?: string }): string[] => (e.derives ? [e.derives] : []);

type Plan = { lots?: Record<string, unknown>[] };
const duLot = (p: Plan, lot: string) => (Array.isArray(p?.lots) ? p.lots.find((l) => l?.id === lot) : undefined);
/** Le plan de l'arbre ne diffère de celui de HEAD que par le statut du lot (et `started`) : un `raf start` seul. */
function startSeul(repo: string, plan: string, lot: string): boolean {
  const tete = essaiGit(repo, 'show', `HEAD:${plan}`);
  if (tete.status !== 0) return false;
  let avant: Plan, apres: Plan;
  try { avant = parse(tete.stdout); apres = parse(readFileSync(join(repo, plan), 'utf8')); } catch { return false; }
  const l0 = duLot(avant, lot), l1 = duLot(apres, lot);
  if (!l0 || !l1 || l0.status === l1.status) return false;
  l1.status = l0.status;
  if ('started' in l0) l1.started = l0.started; else delete l1.started;
  return JSON.stringify(avant) === JSON.stringify(apres);
}

/** L796 (3, issue #70) : un `raf start` laissé non commité faisait rendre son lot refus-integration (~50 min). Un plan qui ne diffère de HEAD QUE par le statut
 * du lot (et `started`) est commité par le run, hooks compris, au modèle `plan.commit` du projet ; sinon rien, l'avertissement des fichiers non commités reste.
 * L923 : les fichiers dérivés du plan que raf start vient de régénérer partent avec lui, comme au commit de raf done (L509). */
export function commiterStart(repo: string, lot: string, id: string, out: (l: string) => void): void {
  const d = derivesDuPlan(repo), sales = fichiersNonCommites(repo) ?? [];
  if (!sales.includes(d.plan) || !startSeul(repo, d.plan, lot)) return;
  const derives = d.fichiers.filter((f) => sales.includes(f) && suivi(repo, f));
  const titre = d.commit.replaceAll('{lot}', lot).replaceAll('{action}', 'démarré').replaceAll('{vague}', `run ${id}`);
  const r = essaiGit(repo, 'commit', '-q', '-m', titre, '-m', `raf start ${lot} laissé non commité au lancement de cadence run ${id} : commité par le run (L796).`, '--', d.plan, ...derives);
  const sha = essaiGit(repo, 'rev-parse', '--short', 'HEAD').stdout.trim(), cause = `${r.stderr}${r.stdout}`.trim().split('\n').at(-1) || `code ${r.status}`;
  out(r.status === 0 ? `raf start ${lot} laissé non commité : commité par le run (${titre}, ${sha})` : `raf start ${lot} laissé non commité : commit refusé (${cause}), le run part sans lui`);
}
