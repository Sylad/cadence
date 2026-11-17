// L762 : le banc mécanique mesure des temps ; la charge que le lead ajoute les fausse (16 et 17-11 : deux bancs perdus, le second ROUGE en temps,
// 2269 s contre 1490 s, avec cinq cadence run en parallèle). Il refuse donc de partir tant qu'un cadence run ou une session du lead vit, et chaque
// rapport note la charge au départ et à la fin. Registre commun (CADENCE_HOME, défaut ~/.cadence/orchestrate), lu sans rien retirer :
// runs/<id>.json = { id, repo, fichier } (inscrireCreneau, verrou.ts) ; holds/<étiquette>.json = { label, since, expires } (addHold de src/orchestrate/registry.ts).
import { cpus, homedir, loadavg } from 'node:os';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { occupantVivant } from '../verrou.js';

export interface Occupants { runs: { id: string; repo: string; lot?: string }[]; sessions: { label: string; expires: string }[] }
/** `malgre_charge` : les occupants nommés au départ quand --malgre-charge a forcé le banc. */
export interface Charge { coeurs: number; depart: number[]; fin: number[]; malgre_charge?: string[] }

/** Le registre, lu dans l'environnement de la commande (les tests le posent). */
export const registreCreneaux = (env: NodeJS.ProcessEnv): string => env.CADENCE_HOME || join(env.HOME || homedir(), '.cadence', 'orchestrate');
const json = (f: string): Record<string, unknown> | null => { try { const x = JSON.parse(readFileSync(f, 'utf8')); return x && typeof x === 'object' ? x : null; } catch { return null; } };
const lister = (d: string): string[] => { try { return readdirSync(d).filter((n) => n.endsWith('.json')).sort(); } catch { return []; } };

/** Runs en cours tenus par un processus vivant (comme liveRuns de src/orchestrate/registry.ts) et sessions du lead non échues à `maintenant` (comme liveHolds). */
export function occupants(home: string, maintenant: Date): Occupants {
  const runs = lister(join(home, 'runs')).flatMap((n) => {
    const r = json(join(home, 'runs', n));
    if (!r || typeof r.fichier !== 'string' || !occupantVivant(r.fichier.replace(/\.json$/, '.verrou'))) return [];
    const e = json(r.fichier);
    return e?.etat === 'en-cours' ? [{ id: String(r.id), repo: String(r.repo), ...(typeof e.lot === 'string' && e.lot ? { lot: e.lot } : {}) }] : [];
  });
  const sessions = lister(join(home, 'holds')).flatMap((n) => {
    const h = json(join(home, 'holds', n));
    return h && typeof h.label === 'string' && Date.parse(String(h.expires)) > maintenant.getTime() ? [{ label: h.label, expires: String(h.expires) }] : [];
  });
  return { runs, sessions };
}

export const nommer = (o: Occupants): string[] => [...o.runs.map((r) => `cadence run ${r.id} (${r.lot ? `lot ${r.lot}, ` : ''}${basename(r.repo)})`),
  ...o.sessions.map((s) => `session du lead « ${s.label} » (jusqu'à ${s.expires})`)];

/** Le refus de `bench mecanique` quand le lead charge la machine, ou null. */
export const refusCharge = (o: Occupants): string | null => (o.runs.length + o.sessions.length === 0 ? null
  : `le banc mécanique mesure des temps et le lead charge la machine : ${nommer(o).join(' ; ')}. Attendre leur fin (cadence run --liste, cadence lead release <étiquette>), ou forcer avec --malgre-charge, noté au rapport (L762 : le 17-11, banc ROUGE en temps, 2269 s contre 1490 s, avec 5 runs en parallèle)`);

/** Load average à 1, 5 et 15 min, au centième. */
export const chargeMachine = (): number[] => loadavg().map((x) => Math.round(x * 100) / 100);
export const nombreCoeurs = (): number => cpus().length;
const fr = (l: number[]) => l.map((x) => x.toFixed(2).replace('.', ',')).join(' · ');

/** Les lignes du rapport : charge au départ et à la fin ; si le banc a été forcé, ce qui tournait. */
export const lignesCharge = (c: Charge): string[] => [`Charge de la machine (load average 1 · 5 · 15 min, ${c.coeurs} cœurs) : départ ${fr(c.depart)} ; fin ${fr(c.fin)}`,
  ...(c.malgre_charge ? [`⚠ Forcé malgré la charge (--malgre-charge) : ${c.malgre_charge.length ? c.malgre_charge.join(' ; ') : 'aucun run ni session du lead au départ'} ; les temps de ce passage ne valent pas une mesure au calme`] : [])];
