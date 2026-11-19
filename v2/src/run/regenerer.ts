// L781 : les commandes du projet qui appellent cadence (cadence news build, la régénération du plan publié) ne tournent pas dans la session d'un run
// (Bash(cadence:*) interdit, brief « n'utilise ni raf ni cadence ») : le 18-11, trois lots (finance L172, L173, warhammer L71) ont été intégrés avec les
// données Nouveautés non régénérées, rejouées à la main par le lead. Le run joue lui-même, dans le worktree, juste avant la porte, les commandes que le
// projet DÉCLARE sous `run.regenerate` de cadence.yaml (revue r1 : rien n'est deviné d'un nom de script), et commite leur sortie en un commit du lot :
// la porte juge le commit qui sera intégré, fichiers générés compris, et une commande en échec est rendue à la session comme une porte rouge.
// Choisi plutôt qu'autoriser cadence dans la session : un geste du programme ne s'oublie pas, et la session garde son interdiction de toucher au plan.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { lireRegeneration, type Regenere } from '../../../scripts/regeneration.mjs';

/** Trailer du commit de régénération : le run le reconnaît pour le retirer avant un rebase ou une reprise de session (rejoué ensuite sur l'arbre à jour). */
export const TRAILER_REGENERATION = 'Cadence-Run-Regeneration';
const REGENERATION_MS = 5 * 60_000;

/** `run.regenerate` du cadence.yaml du worktree (scripts/regeneration.mjs, le même code que la validation de cadence.yaml) ; absente : []. */
export function commandesDeRegeneration(wt: string): Regenere[] {
  const f = join(wt, 'cadence.yaml');
  return existsSync(f) ? lireRegeneration((parse(readFileSync(f, 'utf8')) as { run?: unknown } | null)?.run, 'cadence.yaml') : [];
}

const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'core.quotePath=false', ...a], { cwd, encoding: 'utf8' });
const contenu = (f: string) => (existsSync(f) && statSync(f).isFile() ? readFileSync(f) : null);
/** Chemin → code de git status et contenu (fichiers non suivis un par un) : un fichier déjà modifié que la commande réécrit change de contenu, pas de code (m1). */
function photo(wt: string): Map<string, { code: string; octets: Buffer | null }> {
  const champs = git(wt, 'status', '--porcelain=v1', '-z', '--untracked-files=all').stdout.split('\0');
  const m = new Map<string, { code: string; octets: Buffer | null }>();
  for (let i = 0; i < champs.length; i++) {
    const c = champs[i];
    if (c.length < 4) continue;
    m.set(c.slice(3), { code: c.slice(0, 2), octets: contenu(join(wt, c.slice(3))) });
    if (c[0] === 'R' || c[0] === 'C') i++; // l'ancien nom suit un renommage
  }
  return m;
}
type Photo = ReturnType<typeof photo>;
const meme = (x: Buffer | null | undefined, y: Buffer | null | undefined) => (x && y ? x.equals(y) : !x && !y);
const changes = (avant: Photo, apres: Photo) => [...new Set([...avant.keys(), ...apres.keys()])]
  .filter((f) => avant.get(f)?.code !== apres.get(f)?.code || !meme(avant.get(f)?.octets, apres.get(f)?.octets)).sort();
/** Remet les fichiers touchés comme avant la régénération : un fichier non commité retrouve son contenu, un autre celui de HEAD (un fichier neuf est retiré). */
function remettre(wt: string, fichiers: string[], avant: Photo): void {
  for (const f of fichiers) {
    const a = avant.get(f);
    if (a?.octets) writeFileSync(join(wt, f), a.octets);
    else if (!a && git(wt, 'cat-file', '-e', `HEAD:${f}`).status === 0) git(wt, 'checkout', '-q', 'HEAD', '--', f);
    else rmSync(join(wt, f), { force: true, recursive: true });
  }
}

/**
 * Avant un rebase ou une reprise de session : retire TOUS les commits de régénération du run `id` depuis `base` (revue r1, M2 : une correction commitée
 * par-dessus l'enterrait, et le rebase suivant butait sur le fichier généré). Le plus récent d'abord ; un retrait qui ne passe pas (rebase en conflit,
 * arbre sale) est annulé et le reste est gardé. Rien pendant un rebase en cours (une résolution de conflit). Rend le nombre de commits retirés.
 */
export function retirerRegenerations(wt: string, id: string, base: string): number {
  if (['rebase-merge', 'rebase-apply'].some((d) => existsSync(resolve(wt, git(wt, 'rev-parse', '--git-path', d).stdout.trim())))) return 0;
  const lignes = git(wt, 'log', `--format=%H%x09%(trailers:key=${TRAILER_REGENERATION},valueonly)`, `${base}..HEAD`).stdout.split('\n');
  let n = 0;
  for (const [sha] of lignes.map((l) => l.split('\t')).filter(([, v]) => v?.trim() === id)) {
    const tete = git(wt, 'rev-parse', 'HEAD').stdout.trim() === sha;
    const r = tete ? git(wt, 'reset', '-q', '--keep', 'HEAD~1') : git(wt, 'rebase', '-q', '--onto', `${sha}~1`, sha);
    if (r.status !== 0) { if (!tete) git(wt, 'rebase', '--abort'); break; }
    n++;
  }
  return n;
}

export interface Regeneration { ok: boolean; sortie: string; commit?: string; fichiers?: string[] }
const consigne = '(régénération jouée par cadence run avant la porte, run.regenerate de cadence.yaml, L781 : corrige la cause dans tes fichiers — une entrée '
  + 'Nouveautés mal formée, par exemple —, sans lancer cette commande toi-même ni commiter sa sortie)';
/** Joue les commandes de `run.regenerate` dans le worktree puis commite ce qu'elles ont changé (hooks du dépôt compris, jamais --no-verify).
 * null : rien de déclaré. Échec : `sortie` au format d'une porte rouge (« $ commande » puis la fin de la sortie), fichiers remis comme avant. */
export function regenerer(wt: string, id: string, lot: string | undefined): Regeneration | null {
  let cmds: Regenere[];
  try { cmds = commandesDeRegeneration(wt); } catch (e) { return { ok: false, sortie: `cadence.yaml du run : ${(e as Error).message}` }; } // jamais lue comme « rien à jouer »
  if (!cmds.length) return null;
  const dit = cmds.map((c) => (c.dir === '.' ? c.command : `(cd ${c.dir} && ${c.command})`));
  const avant = photo(wt);
  for (const [i, c] of cmds.entries()) {
    const cwd = join(wt, c.dir);
    const r = existsSync(cwd) ? spawnSync('bash', ['-c', c.command], { cwd, encoding: 'utf8', timeout: REGENERATION_MS, maxBuffer: 64 << 20 }) : null;
    if (r?.status !== 0) {
      remettre(wt, changes(avant, photo(wt)), avant);
      const sortie = r ? `${`${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000)}${r.error ? `\n${r.error.message}` : ''}` : `dossier absent du worktree : ${c.dir}`;
      return { ok: false, sortie: `$ ${dit[i]}\n${sortie}\n${consigne}` };
    }
  }
  const fichiers = changes(avant, photo(wt)), sales = fichiers.filter((f) => avant.has(f));
  if (sales.length) { // m1 : un fichier non commité réécrit par la régénération ne se commite pas avec elle (la porte jugerait l'arbre, pas le commit)
    remettre(wt, fichiers, avant);
    return { ok: false, sortie: `$ ${dit.join(' && ')}\nfichiers non commités réécrits par la régénération : ${sales.join(', ')}\n(commite ou retire ton travail sur ces fichiers ; ${consigne.slice(1)}` };
  }
  if (!fichiers.length) return { ok: true, sortie: '', fichiers: [] };
  const message = `chore${lot ? `(${lot})` : ''}: régénère les fichiers générés déclarés (cadence run ${id})\n\nrun.regenerate : ${dit.join(' puis ')}\n\n${TRAILER_REGENERATION}: ${id}`;
  const add = git(wt, 'add', '-A', '--', ...fichiers), commit = add.status === 0 ? git(wt, 'commit', '-q', '-m', message) : add;
  if (commit.status !== 0) { // m4 : le plus souvent un hook pre-commit du dépôt qui refuse les fichiers générés
    git(wt, 'reset', '-q', '--', ...fichiers); remettre(wt, fichiers, avant);
    return { ok: false, sortie: `$ git commit (régénération : ${dit.join(' puis ')})\n${`${commit.stdout}${commit.stderr}`.slice(-4000)}\n`
      + '(le commit des fichiers générés est refusé, souvent par un hook pre-commit du dépôt : corrige ce qu\'il reproche dans tes fichiers ou dans la commande déclarée)' };
  }
  return { ok: true, sortie: '', commit: git(wt, 'rev-parse', '--short', 'HEAD').stdout.trim(), fichiers };
}
