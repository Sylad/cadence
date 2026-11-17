// L763 (issue #63) : une session de cadence run (claude -p) qui a lancé une commande en arrière-plan n'est jamais réveillée par sa fin : elle attend sans
// fin (deux runs bloqués le 17-11, 21 et 55 min). Le hook premier-plan.mjs refuse ce lancement (../hooks, posé par socle.ts) ; `cadence run --liste`
// signale en plus une session vivante qui n'a aucune commande en cours (aucun shell enfant de claude) et n'a rien écrit dans son transcript depuis N minutes.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Le seuil par défaut de --liste (--inactif <minutes> le change) : au-dessus d'un long tour de réflexion, bien en dessous des 21 min du premier cas. */
export const SEUIL_INACTIF_MIN = 15;
export interface Proc { pid: number; ppid: number; comm: string; cmdline: string }
/** Un outil Bash de Claude Code tourne dans un shell enfant direct de claude ; un serveur MCP (node, npx) n'est pas une commande en cours. */
const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh']);

/** Les processus de la machine, lus dans /proc (aucun ailleurs : rien n'est alors signalé). */
export function processus(): Proc[] {
  if (!existsSync('/proc')) return [];
  return readdirSync('/proc').filter((d) => /^\d+$/.test(d)).flatMap((d) => {
    try {
      const st = readFileSync(`/proc/${d}/stat`, 'utf8'), fin = st.lastIndexOf(')');
      const cmdline = readFileSync(`/proc/${d}/cmdline`, 'utf8').replaceAll('\0', ' ');
      return [{ pid: Number(d), ppid: Number(st.slice(fin + 2).split(' ')[1]), comm: st.slice(st.indexOf('(') + 1, fin), cmdline }];
    } catch { return []; } // processus fini pendant la lecture
  });
}

/** Dernière écriture du transcript de la session, sous-agents compris (ms), ou undefined s'il est introuvable. Même dossier que le banc (bench/fuites.ts). */
export function derniereEcriture(worktree: string, session: string, env: NodeJS.ProcessEnv): number | undefined {
  const d = join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude'), 'projects', worktree.replace(/[^A-Za-z0-9]/g, '-'));
  const sous = join(d, session, 'subagents'), fichiers = [join(d, `${session}.jsonl`), ...(existsSync(sous) ? readdirSync(sous).map((f) => join(sous, f)) : [])];
  const t = fichiers.filter((f) => existsSync(f)).map((f) => statSync(f).mtimeMs);
  return t.length ? Math.max(...t) : undefined;
}

export interface Bloquee { claude: number; depuis: number; minutes: number }
interface Run { id: string; session: string; worktree: string; fichier: string }
interface Opts { seuilMin: number; maintenant?: number; procs?: Proc[]; env?: NodeJS.ProcessEnv }

/**
 * La session du run dont le processus est `pid` (porteur du verrou) est bloquée quand : claude tourne sous lui (un descendant, hors shell, dont la ligne de
 * commande porte l'id de session), aucun shell n'est enfant direct de claude (aucune commande en cours), et rien n'est écrit dans son transcript depuis le
 * seuil (sans transcript : l'état du run, écrit au départ de chaque session). Pendant la porte ou l'intégration, claude ne tourne pas : rien n'est signalé.
 */
export function sessionBloquee(r: Run, pid: number | undefined, o: Opts): Bloquee | null {
  if (!pid || !r.session) return null;
  const procs = o.procs ?? processus(), enfants = (p: number) => procs.filter((x) => x.ppid === p);
  const sous = (p: number): Proc[] => enfants(p).flatMap((x) => [x, ...sous(x.pid)]);
  const claude = sous(pid).find((x) => !SHELLS.has(x.comm) && x.cmdline.includes(r.session));
  if (!claude || enfants(claude.pid).some((x) => SHELLS.has(x.comm))) return null;
  const depuis = derniereEcriture(r.worktree, r.session, o.env ?? process.env) ?? statSync(r.fichier).mtimeMs;
  const minutes = Math.floor(((o.maintenant ?? Date.now()) - depuis) / 60_000);
  return minutes >= o.seuilMin ? { claude: claude.pid, depuis, minutes } : null;
}

/** La note de --liste pour une session bloquée, avec la commande de reprise : arrêter claude rend le run en échec, puis --reponse reprend la même session. */
export function noteBloquee(r: Run, pid: number | undefined, o: Opts): string {
  const b = sessionBloquee(r, pid, o);
  return b ? `session bloquée ? aucune commande en cours et rien d'écrit depuis ${b.minutes} min (seuil ${o.seuilMin} min) ; `
    + `reprendre : kill ${b.claude} (la session claude), puis cadence run --reponse ${r.id} "reprends"` : '';
}
