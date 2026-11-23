// L804 : un banc complet qui ne mesure pas (refus, construction de v2 en échec, erreur) laisse une trace que `bench statut` montre en ⚠, avec sa cause.
// Le 21-11, le minuteur du samedi a refusé le banc pour un v2/dist périmé ; seul complet.log le disait, et le tour du lead n'en a rien vu.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Le fichier de la trace, sous la racine du banc : 1re ligne la date ISO, le reste la cause. Les ExecStartPre du service l'écrivent au même format. */
export const FICHIER_REFUS = 'complet-refus.txt';

export function noterRefus(racine: string, quand: Date, cause: string): void {
  try { mkdirSync(racine, { recursive: true }); writeFileSync(join(racine, FICHIER_REFUS), `${quand.toISOString()}\n${cause.trim()}\n`); } catch { /* racine illisible : complet.log garde la cause */ }
}
export const effacerRefus = (racine: string): void => rmSync(join(racine, FICHIER_REFUS), { force: true });

/** La ligne ⚠ du dernier banc complet refusé, ou null ; elle contient « banc complet » pour que le tour du lead la reprenne (bench-tour.ts). */
export function ligneRefus(racine: string): string | null {
  const f = join(racine, FICHIER_REFUS);
  if (!existsSync(f)) return null;
  const [date = '?', ...cause] = readFileSync(f, 'utf8').trim().split('\n');
  return `⚠ banc complet du ${date} non joué : ${cause.join(' ').trim() || 'cause inconnue'} ; corriger puis relancer « cadence2 bench complet » (journal : ~/bench-cadence/complet.log)`;
}

const plusRecent = (dir: string, t: number): string | null => {
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, f.name), r = f.isDirectory() ? plusRecent(p, t) : statSync(p).mtimeMs > t ? p : null; if (r) return r; }
  return null;
};

/** null si v2/dist/cli.js existe et qu'aucun fichier de v2/src n'est plus récent ; sinon la raison. */
export function distPerime(repo: string): string | null {
  const cli = join(repo, 'v2', 'dist', 'cli.js');
  if (!existsSync(cli)) return 'v2/dist/cli.js absent : lancer « npm run build » dans v2';
  const neuf = plusRecent(join(repo, 'v2', 'src'), statSync(cli).mtimeMs);
  return neuf ? `${neuf} est plus récent que v2/dist/cli.js : lancer « npm run build » dans v2` : null;
}

/** null si rien n'est non commité sous v2/src, v2/briefs et v2/hooks ; sinon la raison. Contrôlé avant toute construction (revue L804 M1) : du travail
 * en cours ne doit jamais être compilé dans le v2/dist lié par npm link, celui qui sert au hook de démarrage, au tour du lead et aux runs. */
export function nonCommite(repo: string): string | null {
  const sale = execFileSync('git', ['status', '--porcelain', '--', 'v2/src', 'v2/briefs', 'v2/hooks'], { cwd: repo, encoding: 'utf8' }).trim();
  return sale ? `v2/src, v2/briefs ou v2/hooks a des changements non commités (l'empreinte ne les voit pas) :\n${sale}` : null;
}

/** `npm run build` dans v2 : null si la construction réussit, sinon la fin de sa sortie d'erreur. En échec, rien n'est écrit dans dist (noEmitOnError de
 * v2/tsconfig.json, revue L804 m1) : un dist plus récent que src après un échec ferait mesurer au banc suivant du code qui ne compile pas. */
export function construireV2(repo: string): string | null {
  try { execFileSync('npm', ['run', 'build'], { cwd: join(repo, 'v2'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60_000 }); return null; }
  catch (e) {
    const x = e as { stdout?: string; stderr?: string; message?: string };
    return `${x.stdout ?? ''}\n${x.stderr ?? ''}`.trim().split('\n').slice(-5).join(' ').trim() || (x.message ?? String(e));
  }
}

/** Relance `cadence2 <args>` avec le v2 qu'on vient de construire : le processus courant tourne encore l'ancien dist. Code de sortie de l'enfant.
 * Une relance qui ne démarre pas (2) ou qu'un signal arrête (1) n'a rien pu écrire : sa cause passe par `noter` (revue L804 m2). `exe` : substituable en test. */
export function relancerV2(repo: string, args: string[], env: NodeJS.ProcessEnv, noter: (cause: string) => void, exe = process.execPath): Promise<number> {
  return new Promise((ok) => {
    const p = spawn(exe, [join(repo, 'v2', 'bin', 'cadence2.js'), ...args], { stdio: 'inherit', env });
    p.on('error', (e) => { noter(`la relance sur le dist neuf n'a pas démarré : ${e.message}`); ok(2); });
    p.on('exit', (c, sig) => { if (c === null) noter(`la relance sur le dist neuf a été arrêtée par le signal ${sig ?? 'inconnu'}`); ok(c ?? 1); });
  });
}

/** Variable posée sur la relance : elle ne reconstruit pas une seconde fois (pas de boucle si la construction laisse dist périmé). */
export const ENV_CONSTRUIT = 'CADENCE_BANC_CONSTRUIT';
