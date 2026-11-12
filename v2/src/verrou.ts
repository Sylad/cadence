// Verrou de processus dans un fichier (revue L700 r1, D-18) : { pid, start, role, depuis }. Le porteur est vivant si son pid existe et que son heure de
// démarrage est la même (un pid se réutilise) ; un verrou laissé par un mort (PC éteint, kill) ne tient rien. Pose atomique par lien vers un fichier
// complet, verrou mort écarté seulement s'il est encore celui qu'on a lu : comme takeLock de src/orchestrate/lock.ts (v2 ne lit pas src/).
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface Porteur { pid: number; start?: string; role: string; depuis: string }

/** Heure de démarrage du processus (champ 22 de /proc/<pid>/stat, sinon lstart de ps), comme processStart de src/proc.ts : avec le pid, l'identité du porteur. */
export function debutProcessus(pid: number): string | undefined {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return st.slice(st.lastIndexOf(')') + 2).split(' ')[19] || undefined;
  } catch {
    return spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout?.trim() || undefined;
  }
}
function vivant(pid: number, start?: string): boolean {
  try { process.kill(pid, 0); } catch (x) { if ((x as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  return !start || debutProcessus(pid) === start;
}
const lire = (f: string): Porteur | null => { try { return JSON.parse(readFileSync(f, 'utf8')) as Porteur; } catch { return null; } };

/** Le processus vivant qui tient le verrou, ou null (pas de verrou, illisible, porteur mort ou pid repris). */
export function occupantVivant(f: string): Porteur | null {
  const v = lire(f);
  return v && Number.isInteger(v.pid) && vivant(v.pid, v.start) ? v : null;
}

/** Pose le verrou au nom de ce processus ; rend null quand c'est fait, sinon le porteur vivant qui le tient (ou un porteur inconnu si la pose reste disputée). */
export function prendreVerrou(f: string, role: string): Porteur | null {
  const moi: Porteur = { pid: process.pid, start: debutProcessus(process.pid), role, depuis: new Date().toISOString() };
  for (let essai = 0; essai < 3; essai++) {
    const tmp = `${f}.${process.pid}.${essai}.tmp`;
    writeFileSync(tmp, JSON.stringify(moi));
    try { linkSync(tmp, f); return null; } catch { /* déjà là */ } finally { rmSync(tmp, { force: true }); }
    const vu = lire(f), p = occupantVivant(f), aside = `${f}.mort.${process.pid}`;
    if (p) return p;
    try { renameSync(f, aside); } catch { continue; }
    if (JSON.stringify(lire(aside)) !== JSON.stringify(vu)) try { linkSync(aside, f); } catch { /* repris par un tiers */ }
    rmSync(aside, { force: true });
  }
  return lire(f) ?? { pid: 0, role: 'inconnu', depuis: '' };
}

/** Change le rôle du verrou s'il est à ce processus. */
export function roleVerrou(f: string, role: string): void {
  const v = lire(f);
  if (v?.pid === process.pid) writeFileSync(f, JSON.stringify({ ...v, role }));
}
/** Retire le verrou s'il est à ce processus. */
export function rendreVerrou(f: string): void {
  if (lire(f)?.pid === process.pid) rmSync(f, { force: true });
}

// L710 (issue #55) : un run vivant de cadence run prend un créneau de sessions, comme une vague. Il s'inscrit dans le registre commun des créneaux
// (CADENCE_HOME, défaut ~/.cadence/orchestrate, comme cadenceHome de src/orchestrate/registry.ts, qui le lit : liveRuns) le temps de sa session, de sa porte
// et de son intégration. Format partagé : runs/<id>.json = { id, repo, fichier } ; le lecteur compte le run quand son état est en-cours et qu'un porteur
// vivant tient son verrou `<run>.verrou` (le contrôle de « interrompu » de --liste, L709).
/** Inscrit le run ; rend son retrait (à appeler à la fin du run, quelle qu'elle soit). */
export function inscrireCreneau(r: { id: string; repo: string; fichier: string }): () => void {
  const dossier = join(process.env.CADENCE_HOME || join(homedir(), '.cadence', 'orchestrate'), 'runs'), f = join(dossier, `${r.id}.json`);
  mkdirSync(dossier, { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify({ id: r.id, repo: r.repo, fichier: r.fichier }));
  renameSync(`${f}.tmp`, f);
  return () => rmSync(f, { force: true });
}
