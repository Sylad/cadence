// L762 : le banc mécanique mesure des temps ; la charge que le lead ajoute les fausse (16 et 17-11 : deux bancs perdus, le second ROUGE en temps,
// 2269 s contre 1490 s, avec cinq cadence run en parallèle). Il refuse donc de partir tant qu'un cadence run ou une session du lead vit, et chaque
// rapport note la charge au départ et à la fin. Registre commun (CADENCE_HOME, défaut ~/.cadence/orchestrate), lu sans rien retirer :
// runs/<id>.json = { id, repo, fichier } (inscrireCreneau, verrou.ts) ; holds/<étiquette>.json = { label, since, expires } (addHold de src/orchestrate/registry.ts).
import { cpus, homedir, loadavg } from 'node:os';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { occupantVivant, vivant } from '../verrou.js';

/** `vagues` (L911) : vagues de `cadence orchestrate` vivantes (waves/<pid>.json = { pid, wave, repos, start }, registerWave de src/orchestrate/registry.ts). */
export interface Occupants { runs: { id: string; repo: string; lot?: string }[]; sessions: { label: string; expires: string }[]; vagues?: { wave: string; repos: string[] }[] }
/** `malgre_charge` : les occupants nommés au départ quand --malgre-charge a forcé le banc.
 * L911 : `pic`, la plus haute charge à 1 min lue pendant le passage (départ, relevés de chaque minute, fin) ; `seuil`, la charge au-delà de laquelle
 * les temps ne se mesurent plus (`seuilCharge`). */
/** Revue L911 (M1) : `externe`, le pic de la charge EXTERNE au banc — fils actifs (R ou D, ce que compte le load average) hors de l'arbre de processus
 * du banc, lissés sur 1 min comme le load average — seul comparé au seuil : la charge que le banc produit lui-même (10,7 à 15,1 en fin de passage au calme
 * sur Big-Blue) ne rend plus ses temps non mesurables. Absent (/proc illisible, rapports d'avant) : le pic total est comparé, comme avant. */
export interface Charge { coeurs: number; depart: number[]; fin: number[]; malgre_charge?: string[]; pic?: number; seuil?: number; externe?: number }

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
  const vagues = lister(join(home, 'waves')).flatMap((n) => {
    const w = json(join(home, 'waves', n));
    return w && Number.isInteger(w.pid) && vivant(Number(w.pid), typeof w.start === 'string' ? w.start : undefined)
      ? [{ wave: String(w.wave), repos: Array.isArray(w.repos) ? w.repos.map(String) : [] }] : [];
  });
  return { runs, sessions, ...(vagues.length && { vagues }) };
}

export const nommer = (o: Occupants): string[] => [...o.runs.map((r) => `cadence run ${r.id} (${r.lot ? `lot ${r.lot}, ` : ''}${basename(r.repo)})`),
  ...o.sessions.map((s) => `session du lead « ${s.label} » (jusqu'à ${s.expires})`),
  ...(o.vagues ?? []).map((v) => `vague orchestrate ${v.wave}${v.repos.length ? ` (${v.repos.map((r) => basename(r)).join(', ')})` : ''}`)];

/** Le refus de `bench mecanique` quand le lead charge la machine, ou null. */
export const refusCharge = (o: Occupants): string | null => (nommer(o).length === 0 ? null
  : `le banc mécanique mesure des temps et le lead charge la machine : ${nommer(o).join(' ; ')}. Attendre leur fin (cadence run --liste, cadence lead release <étiquette> ; --attendre [min] le fait, L911), ou forcer avec --malgre-charge, noté au rapport (L762 : le 17-11, banc ROUGE en temps, 2269 s contre 1490 s, avec 5 runs en parallèle)`);

/** Load average à 1, 5 et 15 min, au centième. */
export const chargeMachine = (): number[] => loadavg().map((x) => Math.round(x * 100) / 100);
export const nombreCoeurs = (): number => cpus().length;
const nb = (x: number) => x.toFixed(2).replace('.', ',');
const fr = (l: number[]) => l.map(nb).join(' · ');

/**
 * L911 : la charge (load average à 1 min) au-delà de laquelle les temps d'un passage ne se mesurent plus : nombre de cœurs ÷ 2.
 * Vécu : au banc mécanique sur Big-Blue (32 cœurs, seuil 16), verts à 10,7 et 14,3 le 26-11 ; rouges en « temps des retouches » à 23,6
 * (27-11 08:01, 247 s contre 188) et 38,7 (26-11 11:21, 296 contre 180). `CADENCE_BANC_CHARGE_MAX` le remplace (machine dont le banc seul dépasse la moitié).
 */
export function seuilCharge(coeurs: number, env: NodeJS.ProcessEnv): number { // revue L911 (m2) : une seule source, l'environnement de la commande (io.env)
  const v = Number(env.CADENCE_BANC_CHARGE_MAX);
  return env.CADENCE_BANC_CHARGE_MAX && Number.isFinite(v) && v > 0 ? v : coeurs / 2;
}

/** L911 : la raison pour laquelle les temps du passage ne se mesurent pas (charge externe au banc, à défaut pic total, au-dessus du seuil), ou null. */
export const chargeHaute = (c: Charge): string | null => {
  const seuil = c.seuil ?? c.coeurs / 2, pic = c.externe ?? c.pic ?? Math.max(c.depart[0] ?? 0, c.fin[0] ?? 0);
  return pic > seuil ? `charge${c.externe !== undefined ? ' externe au banc' : ''} ${nb(pic)} au-dessus de ${nb(seuil)} (${c.seuil !== undefined && c.seuil !== c.coeurs / 2 ? 'CADENCE_BANC_CHARGE_MAX' : `${c.coeurs} cœurs ÷ 2`})` : null;
};

/** Un processus vu dans /proc : son parent et le nombre de ses fils actifs (état R ou D, ce que compte le load average). */
export type Tache = { pid: number; ppid: number; actifs: number };

/** Revue L911 (M1) : les fils actifs hors de l'arbre de `racine` (elle comprise) — la charge que d'autres travaux mettent sur la machine à cet instant. */
export function actifsHorsArbre(taches: Tache[], racine: number): number {
  const enfants = new Map<number, number[]>();
  for (const t of taches) enfants.set(t.ppid, [...(enfants.get(t.ppid) ?? []), t.pid]);
  const arbre = new Set<number>(), pile = [racine];
  while (pile.length) { const p = pile.pop()!; if (!arbre.has(p)) { arbre.add(p); pile.push(...(enfants.get(p) ?? [])); } }
  return taches.reduce((n, t) => n + (arbre.has(t.pid) ? 0 : t.actifs), 0);
}

/** Les processus de /proc (Linux, WSL), ou null quand /proc ne se lit pas. Champs après la dernière « ) » du stat : état, ppid. */
export function tachesProc(): Tache[] | null {
  let pids: string[];
  try { pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return null; }
  const champs = (f: string): string[] | null => { try { const s = readFileSync(f, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' '); } catch { return null; } };
  const taches = pids.flatMap((p) => {
    const st = champs(`/proc/${p}/stat`);
    if (!st) return [];
    let fils: string[];
    try { fils = readdirSync(`/proc/${p}/task`); } catch { fils = []; }
    const actifs = fils.filter((t) => ['R', 'D'].includes(champs(`/proc/${p}/task/${t}/stat`)?.[0] ?? '')).length;
    return [{ pid: Number(p), ppid: Number(st[1]), actifs }];
  });
  return taches.length ? taches : null;
}

/** La charge externe au banc lancé par ce processus, à cet instant (fils actifs hors de son arbre), ou null sans /proc. */
export const chargeExterne = (racine = process.pid): number | null => { const t = tachesProc(); return t ? actifsHorsArbre(t, racine) : null; };

/** L911 : refus au départ du banc mécanique quand la machine est déjà chargée (load average à 1 min au-dessus du seuil), même sans run inscrit. */
export const refusChargeMachine = (charge1: number, coeurs: number, seuil: number): string | null => (charge1 <= seuil ? null
  : `la machine est chargée (load average à 1 min ${nb(charge1)}, au-dessus de ${nb(seuil)} pour ${coeurs} cœurs) : les temps du passage seraient non mesurables (L911 : 27-11 08:01, charge 23,6, « temps des retouches » 247 s contre 188). Relancer avec --attendre, ou forcer avec --malgre-charge, noté au rapport`);

/** Les lignes du rapport : charge au départ et à la fin ; si le banc a été forcé, ce qui tournait. */
export const lignesCharge = (c: Charge): string[] => [`Charge de la machine (load average 1 · 5 · 15 min, ${c.coeurs} cœurs) : départ ${fr(c.depart)} ; fin ${fr(c.fin)}${c.pic !== undefined ? ` ; pic à 1 min ${nb(c.pic)}${c.externe !== undefined ? ` ; pic externe au banc ${nb(c.externe)}` : ''} (seuil ${nb(c.seuil ?? c.coeurs / 2)})` : ''}`,
  ...(chargeHaute(c) ? [`⚠ Temps non mesurables : ${chargeHaute(c)} pendant le passage ; les critères de temps sont marqués « non mesurable » au lieu de rouge (L911), le passage est à rejouer au calme s'ils l'auraient été`] : []),
  ...(c.malgre_charge ? [`⚠ Forcé malgré la charge (--malgre-charge) : ${c.malgre_charge.length ? c.malgre_charge.join(' ; ') : 'aucun run ni session du lead au départ'} ; les temps de ce passage ne valent pas une mesure au calme`] : [])];
