// L781 : les commandes du projet qui appellent cadence (scripts.news → cadence news build, puis la régénération du plan publié) ne tournent pas dans la
// session d'un run (Bash(cadence:*) interdit, brief « n'utilise ni raf ni cadence ») : le 18-11, trois lots (finance L172, L173, warhammer L71) ont été
// intégrés avec les données Nouveautés non régénérées, rejouées à la main par le lead. Le run les joue lui-même, dans le worktree, juste avant la porte,
// et commite leur sortie en un commit du lot : la porte juge le commit qui sera intégré, données générées comprises, et une commande en échec est rendue à
// la session comme une porte rouge (une entrée Nouveautés mal formée se corrige dans la session). Choisi plutôt qu'autoriser cadence dans la session :
// un geste du programme ne s'oublie pas, et la session garde son interdiction de toucher au plan et aux vagues.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/** Trailer du commit de régénération : le run le reconnaît pour le retirer avant un rebase (le rejouer sur la nouvelle cible, sans conflit sur un fichier généré). */
export const TRAILER_REGENERATION = 'Cadence-Run-Regeneration';
const REGENERATION_MS = 5 * 60_000;

/** Les commandes à rejouer : `npm run news` quand package.json déclare scripts.news ; puis plan.onWrite.command de cadence.yaml (la régénération déclarée du
 * plan publié, qui peut lire les Nouveautés), seulement avec scripts.news. Rien d'autre n'est deviné d'un nom de script. */
export function commandesDeRegeneration(wt: string): string[] {
  const pkg = join(wt, 'package.json');
  let scripts: Record<string, unknown> = {};
  try { scripts = existsSync(pkg) ? (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, unknown> }).scripts ?? {} : {}; } catch { return []; }
  if (typeof scripts.news !== 'string' || !scripts.news.trim()) return [];
  const cmds = ['npm run news'];
  try {
    const y = existsSync(join(wt, 'cadence.yaml')) ? parse(readFileSync(join(wt, 'cadence.yaml'), 'utf8')) as { plan?: { onWrite?: { command?: unknown } } } | null : null;
    const plan = y?.plan?.onWrite?.command;
    if (typeof plan === 'string' && plan.trim() && plan.trim() !== 'npm run news') cmds.push(plan.trim());
  } catch { /* cadence.yaml illisible : la porte le dira */ }
  return cmds;
}

const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'core.quotePath=false', ...a], { cwd, encoding: 'utf8' });
/** Chemin → code de git status (fichiers non suivis un par un). */
function statut(wt: string): Map<string, string> {
  const champs = git(wt, 'status', '--porcelain=v1', '-z', '--untracked-files=all').stdout.split('\0');
  const m = new Map<string, string>();
  for (let i = 0; i < champs.length; i++) {
    const c = champs[i];
    if (c.length < 4) continue;
    m.set(c.slice(3), c.slice(0, 2));
    if (c[0] === 'R' || c[0] === 'C') i++; // l'ancien nom suit un renommage
  }
  return m;
}
const changes = (avant: Map<string, string>, apres: Map<string, string>) => [...new Set([...avant.keys(), ...apres.keys()])].filter((f) => avant.get(f) !== apres.get(f)).sort();
/** Remet les fichiers touchés par une commande en échec comme dans HEAD (un fichier neuf est retiré) : rien de demi-écrit ne reste à commiter. */
function remettre(wt: string, fichiers: string[]): void {
  for (const f of fichiers) {
    if (git(wt, 'cat-file', '-e', `HEAD:${f}`).status === 0) git(wt, 'checkout', '-q', 'HEAD', '--', f);
    else rmSync(join(wt, f), { force: true, recursive: true });
  }
}

/** Le commit de tête est-il la régénération du run `id` ? */
export function teteRegeneree(wt: string, id: string): boolean {
  const r = git(wt, 'log', '-1', `--format=%(trailers:key=${TRAILER_REGENERATION},valueonly)`);
  return r.status === 0 && r.stdout.trim() === id;
}

/** Avant un rebase : retire le commit de régénération du run quand il est en tête (il sera rejoué sur la cible à jour, avec les entrées des autres runs). */
export function retirerRegeneration(wt: string, id: string): boolean {
  return teteRegeneree(wt, id) && git(wt, 'reset', '-q', '--keep', 'HEAD~1').status === 0;
}

export interface Regeneration { ok: boolean; sortie: string; commit?: string; fichiers?: string[] }
/** Joue les commandes de régénération dans le worktree puis commite ce qu'elles ont changé (hooks du dépôt compris, jamais --no-verify).
 * null : rien à jouer. Échec : `sortie` au format d'une porte rouge (« $ commande » puis la fin de la sortie). */
export function regenerer(wt: string, id: string, lot: string | undefined, env: NodeJS.ProcessEnv = process.env): Regeneration | null {
  const cmds = commandesDeRegeneration(wt);
  if (!cmds.length) return null;
  const avant = statut(wt);
  for (const c of cmds) {
    const r = spawnSync('bash', ['-c', c], { cwd: wt, env, encoding: 'utf8', timeout: REGENERATION_MS, maxBuffer: 64 << 20 });
    if (r.status !== 0) {
      remettre(wt, changes(avant, statut(wt)));
      return { ok: false, sortie: `$ ${c}\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000)}${r.error ? `\n${r.error.message}` : ''}\n`
        + `(régénération jouée par cadence run avant la porte, L781 : corrige la cause dans tes fichiers — une entrée Nouveautés, par exemple —, `
        + `sans lancer cette commande toi-même ni commiter sa sortie)` };
    }
  }
  const fichiers = changes(avant, statut(wt));
  if (!fichiers.length) return { ok: true, sortie: '', fichiers: [] };
  const message = `chore${lot ? `(${lot})` : ''}: régénère les nouveautés (cadence run ${id})\n\nCommandes : ${cmds.join(' puis ')}\n\n${TRAILER_REGENERATION}: ${id}`;
  const add = git(wt, 'add', '-A', '--', ...fichiers), commit = add.status === 0 ? git(wt, 'commit', '-q', '-m', message) : add;
  if (commit.status !== 0) {
    git(wt, 'reset', '-q', '--', ...fichiers); remettre(wt, fichiers);
    return { ok: false, sortie: `$ git commit (régénération : ${cmds.join(' puis ')})\n${`${commit.stdout}${commit.stderr}`.slice(-4000)}` };
  }
  return { ok: true, sortie: '', commit: git(wt, 'rev-parse', '--short', 'HEAD').stdout.trim(), fichiers };
}
