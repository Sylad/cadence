// L711 (issue #55 du compte pro) : un run --fond mort avec la session Claude Code lanceuse, journal vide, cause non reproduite sur Big-Blue.
// Ce module (racine de src/ : il sert run et bench) laisse dans le journal du run de quoi l'établir au prochain cas : l'identité du processus au lancement, le signal reçu et l'heure, sans rien
// changer à la façon dont le run s'arrête.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';

/** Les lignes qui disent pourquoi un run s'est arrêté commencent ainsi ; --liste montre la dernière d'un run interrompu. */
export const CAUSE = 'cause d\'arrêt';
const SIGNAUX = ['SIGHUP', 'SIGTERM', 'SIGINT'] as const;
const deux = (n: number) => String(n).padStart(2, '0');
/** Heure locale à la seconde, avec la date : le journal d'un run dure parfois plusieurs jours (attente de quota). */
export const horodatage = (d = new Date()) => `${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())} ${deux(d.getHours())}:${deux(d.getMinutes())}:${deux(d.getSeconds())}`;
export const ligneCause = (texte: string, d = new Date()) => `${CAUSE} (${horodatage(d)}) : ${texte}`;

/** Nom du signal d'un code de sortie de shell (128 + n), ou null. */
const signalDuCode = (code: number): string | null =>
  (code > 128 ? Object.entries(constants.signals).find(([, n]) => n === code - 128)?.[0] ?? null : null);

/** pid, pgid, sid, ppid et cgroup du processus courant ; pgid et sid par /proc, sinon par ps, sinon absents ; le cgroup seulement quand /proc le donne. */
export function identite(): string {
  let pgid = '?', sid = '?';
  try {
    const champs = readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' '); // après « (comm) » : état, ppid, pgrp, session
    [pgid, sid] = [champs[2], champs[3]];
  } catch {
    const r = spawnSync('ps', ['-o', 'pgid=,sess=', '-p', String(process.pid)], { encoding: 'utf8' });
    const v = (r.stdout ?? '').trim().split(/\s+/);
    if (r.status === 0 && v.length === 2) [pgid, sid] = v;
  }
  const cgroup = existsSync('/proc/self/cgroup') ? readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n').join(' ; ') : '';
  return `processus du run (${horodatage()}) : pid ${process.pid}, pgid ${pgid}, sid ${sid}, ppid ${process.ppid}${cgroup ? `, cgroup ${cgroup}` : ''}`;
}

/**
 * Le veilleur d'un run --fond : son parent, détaché à sa place. Le run est synchrone de bout en bout (spawnSync pendant toute la session claude) : un
 * gestionnaire de signal dans son processus ne jouerait qu'à la fin de la session, et le run ne s'arrêterait plus au signal. Le run garde donc l'arrêt par
 * défaut, et c'est le veilleur, dont la boucle d'événements est libre, qui écrit le signal reçu par le groupe et le signal qui a arrêté le run.
 * Il ne transmet rien, n'arrête rien, et rend le code du run.
 */
export function veiller(args: string[], env: NodeJS.ProcessEnv, cwd: string, out: (l: string) => void): Promise<number> {
  const run = spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], { cwd, env, stdio: 'inherit' });
  const recu = (s: string) => () => out(ligneCause(`${s} reçu par le groupe du run (veilleur pid ${process.pid}, run pid ${run.pid ?? '?'})`));
  const gestion = SIGNAUX.map((s) => [s, recu(s)] as const);
  for (const [s, g] of gestion) process.on(s, g);
  return new Promise((fini) => run.on('exit', (code, signal) => {
    for (const [s, g] of gestion) process.off(s, g);
    if (signal) out(ligneCause(`le processus du run (pid ${run.pid}) a reçu ${signal} et s'est arrêté (code ${128 + (constants.signals[signal] ?? 0)})`));
    else out(`fin du processus du run (pid ${run.pid}, ${horodatage()}) : code ${code}`);
    fini(signal ? 128 + (constants.signals[signal] ?? 0) : code ?? 1);
  }));
}

/** Pour --liste : « · » et la dernière ligne de cause du journal d'un run interrompu, ou rien (journal absent, ou sans cause). */
export function causeListe(journal: string | undefined): string {
  const c = journal && existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').filter((l) => l.startsWith(CAUSE)).pop() : undefined;
  return c ? `  · ${c}` : '';
}

/** Une session claude arrêtée par un signal : l'enveloppe tuée (signal rendu par spawnSync), ou claude mort sur 128 + n ; null sinon. */
export function causeSession(brut: { code: number; erreur?: string }): string | null {
  const sig = /^SIG[A-Z0-9]+$/.test(brut.erreur ?? '') ? brut.erreur! : signalDuCode(brut.code);
  return sig && ligneCause(sig === brut.erreur ? `l'enveloppe de la session claude a été tuée par ${sig}` : `la session claude s'est arrêtée sur ${sig} (code ${brut.code})`);
}
