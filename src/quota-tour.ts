// Le quota dans le tour du lead (L700, D-15) : la jauge hebdo que publie la bande cadence-hud, et les runs de cadence run en état quota.
// Doc officielle lue le 11-11 : la status line reçoit rate_limits.seven_day (used_percentage, resets_at), sans détail par modèle ; la limite hebdo bloque tous les modèles.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { holderAlive } from './orchestrate/lock.js';
import { cadenceHome } from './orchestrate/registry.js';

/** Fichier que la bande écrit dans CADENCE_HOME à chaque rafraîchissement : { percent, resetsAt, at }. */
export const QUOTA_FILE = 'hud-quota.json';
/** Au-delà, le lead ne lance pas un banc coûteux sans y penser : la ligne prend un ⚠. */
const QUOTA_WARN_PERCENT = 80;
/** La bande rafraîchit toutes les 5 s quand une session est ouverte ; un relevé plus vieux que cela dit son âge. */
const QUOTA_FRESH_MS = 15 * 60_000;

/** Durée lisible : 3 h 30, 1 j 16 h, 12 min. */
function span(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ${String(min % 60).padStart(2, '0')}` : `${Math.floor(h / 24)} j ${h % 24} h`;
}

/** La ligne de la jauge hebdo. Aucune valeur affirmée sans relevé, ni une valeur d'avant la remise à zéro. */
export function tourQuotaLine(env: NodeJS.ProcessEnv, now: number): string {
  const unknown = 'quota hebdo : inconnu (la bande cadence-hud ne l\'a pas publié)';
  let q: { percent?: unknown; resetsAt?: unknown; at?: unknown };
  try {
    q = JSON.parse(readFileSync(join(cadenceHome(env), QUOTA_FILE), 'utf8')) as typeof q;
  } catch {
    return unknown;
  }
  if (typeof q?.percent !== 'number' || !Number.isFinite(q.percent)) return unknown;
  const reset = typeof q.resetsAt === 'string' ? Date.parse(q.resetsAt) : NaN, at = typeof q.at === 'number' ? q.at : NaN;
  if (Number.isFinite(reset) && reset <= now) return 'quota hebdo : relevé périmé (remise à zéro passée depuis), la bande cadence-hud ne l\'a pas encore republié';
  const pct = Math.round(q.percent), warn = q.percent > QUOTA_WARN_PERCENT;
  const parts = [`${warn ? '⚠ ' : ''}quota hebdo : ${pct} %${warn ? ` (au-delà de ${QUOTA_WARN_PERCENT} %)` : ''}`];
  if (Number.isFinite(reset)) parts.push(`remise à zéro dans ${span(reset - now)}`);
  if (Number.isFinite(at) && now - at > QUOTA_FRESH_MS) parts.push(`relevé il y a ${span(now - at)}`);
  return parts.join(' · ');
}

interface RunState { id?: string; repo?: string; etat?: string; quota?: { limite?: string; reprise?: string | null }; verrou?: string }

/** Revue L700 r1 (D-18) : le pid du processus vivant qui attend le run (verrou `<run>.verrou` qu'écrit v2/src/run/run.ts), ou null. */
function waitingPid(lockFile: string | undefined): number | null {
  try {
    const v = JSON.parse(readFileSync(lockFile ?? '', 'utf8')) as { pid?: unknown; start?: unknown };
    const pid = Number(v.pid);
    return Number.isInteger(pid) && holderAlive(pid, typeof v.start === 'string' ? v.start : undefined) ? pid : null;
  } catch {
    return null;
  }
}

const localTime = (iso: string): string => {
  const d = new Date(iso), z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
};

/** Les états de run d'un dossier `.cadence-run`, illisibles passés (cadence run --liste les montre déjà). */
function runStates(dir: string): RunState[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((x) => x.endsWith('.json')).sort().flatMap((f) => {
    try {
      return [{ ...(JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunState), verrou: join(dir, f.replace(/\.json$/, '.verrou')) }];
    } catch {
      return [];
    }
  });
}

function quotaRunLine(e: RunState): string {
  const limit = e.quota?.limite === 'opus' ? 'limite Opus' : 'limite hebdo', resume = `cadence run --reponse ${e.id} "reprends"`;
  const pid = e.quota?.reprise ? waitingPid(e.verrou) : null;
  const when = !e.quota?.reprise ? `heure de reprise illisible · reprendre : ${resume}`
    : pid ? `reprise seule après ${localTime(e.quota.reprise)} (processus ${pid} en attente) · avant : kill ${pid}, puis ${resume}`
      : `attente arrêtée (aucun processus n'attend ; reprise prévue ${localTime(e.quota.reprise)}) · reprendre : ${resume}`;
  return `run en quota : ${basename(e.repo ?? '')} ${e.id} · ${limit} · ${when}`;
}

/** Une ligne par run de cadence run en quota, lus dans le dossier `.cadence-run` voisin de chaque projet du tour (là où cadence run les écrit). */
export function tourQuotaRunLines(roots: string[]): string[] {
  const wanted = new Set(roots);
  return [...new Set(roots.map((r) => join(dirname(r), '.cadence-run')))].flatMap(runStates)
    .filter((e) => e?.etat === 'quota' && !!e.repo && wanted.has(e.repo)).map(quotaRunLine);
}

/** Les lignes du quota dans le tour : la jauge hebdo, puis les runs en quota. La jauge se lit dans le CADENCE_HOME de l'appel, sinon celui du processus. */
export const tourQuotaLines = (env: NodeJS.ProcessEnv, roots: string[], now: number): string[] =>
  [tourQuotaLine(env.CADENCE_HOME ? env : process.env, now), ...tourQuotaRunLines(roots)];
