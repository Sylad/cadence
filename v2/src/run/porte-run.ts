// L838 : la porte jouée par cadence run, sortie de run.ts (cliquet de qualité : taille du fichier, complexité de jouerPorte).
// L786 : un verdict n'est noté que pour un arbre égal au commit jugé, avant et après, au même HEAD ; L838 : jamais après la porte rapide (tests touchés seulement).
import { execFileSync } from 'node:child_process';
import { fichiersNonCommites } from '../../../scripts/arbre-non-commite.mjs';
import { noterVerdict } from '../../../scripts/verdicts-porte.mjs'; // L786 : même écriture que src/gate-verdict.ts (verify --gate)
import { PORTE_MS } from '../socle.js';
import { jouerCommandes, type Sensible } from './rejeu.js'; // L842 : une commande de test rouge rejoue seuls ses rouges

/** Ce que la porte lit et écrit de l'état du run. */
export interface EtatPorte { worktree: string; analyse_dite?: string[]; sensibles_charge?: Sensible[]; porte_rapide?: string; portes?: { ciblee: boolean; ok: boolean; duree_s: number }[] }

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** L786 (revue r1, M2) : les fichiers du worktree hors du commit (modifiés, indexés, non suivis même cachés ; les ignorés exceptés), '' s'il est propre ; git muet : sale. */
const horsCommit = (cwd: string) => (fichiersNonCommites(cwd, { tous: true }) ?? ['(git status illisible)']).join('\n');
const compte = (t: string) => t.split('\n').length;

/** L838 : la porte nommée dans la demande de correction, et la ligne de la porte rapide reprise au détail de l'état integre. */
export const quelleSuite = (e: EtatPorte) => (e.porte_rapide ? 'rapide (tests touchés)' : 'complète');
export const ligneTestsTouches = (e: EtatPorte) => (e.porte_rapide ? [e.porte_rapide] : []);

/** Pourquoi la porte n'a pas jugé le commit `sha` seul (vide : le verdict peut être noté). */
function sansVerdict(cwd: string, sha: string, avant: string, rapide: boolean, excuses: string[]): string[] {
  const apres = horsCommit(cwd), tete = git(cwd, 'rev-parse', 'HEAD'), raisons: string[] = [];
  if (avant) raisons.push(`avant la porte, l'arbre portait des fichiers hors du commit (${compte(avant)})`);
  if (apres) raisons.push(`après la porte, l'arbre porte des fichiers hors du commit (${compte(apres)})`);
  if (tete !== sha) raisons.push(`HEAD est passé à ${tete.slice(0, 7)}`);
  if (rapide) raisons.push('la porte rapide (run.fastGate, L838) n\'a joué que les tests touchés');
  return [...raisons, ...excuses]; // revue L842 (B1) : un rouge excusé ne vaut pas une suite verte
}

/** Joue la porte du run dans son worktree, garde sa mesure (L838 : `portes`) et note le verdict du commit jugé quand il le peut. */
export function jouerPorte(cmds: string[], e: EtatPorte, out: (l: string) => void): { ok: boolean; sortie: string } {
  const cwd = e.worktree, sha = git(cwd, 'rev-parse', 'HEAD'), avant = horsCommit(cwd), t0 = Date.now();
  const { p: { ok, sortie }, dites, excuses } = jouerCommandes(cmds, e, out, PORTE_MS); // L842 : verts seuls, une commande rouge compte verte
  if (!cmds.length) return { ok, sortie }; // --sans-porte : aucune porte n'a jugé, rien n'est noté
  // Revue L801 r3 (M2) : une porte verte n'est pas muette — dit une fois par changement (comme porte_changee), gardé pour le détail de l'état integre.
  if (ok) {
    for (const l of dites) if (!e.analyse_dite?.includes(l)) out(l);
    e.analyse_dite = dites.length ? dites : undefined;
  }
  e.portes = [...(e.portes ?? []), { ciblee: !!e.porte_rapide, ok, duree_s: Math.round((Date.now() - t0) / 100) / 10 }];
  const raisons = sansVerdict(cwd, sha, avant, !!e.porte_rapide, excuses);
  if (!raisons.length) noterVerdict(cwd, sha, ok ? 0 : 1, new Date());
  else out(`porte du run : aucun verdict noté pour ${sha.slice(0, 7)} — ${raisons.join(' ; ')} : la porte n'a pas jugé ce commit seul, le hook pre-push exigera une porte de verify à ce sha`);
  return { ok, sortie };
}
