// L911 (D-40) : la charge de la machine autour d'un passage du banc — avant de lancer (refus ou attente) et pendant (pic, temps non mesurables).
// Vécu : 27-11 08:01, charge de fin 23,6 sur 32 cœurs, banc mécanique ROUGE en « temps des retouches » (247 s contre 188) sans aucune régression.
import type { Io } from '../cli.js';
import { chargeExterne, chargeHaute, chargeMachine, nombreCoeurs, nommer, occupants, refusCharge, refusChargeMachine, registreCreneaux, seuilCharge, type Charge } from './charge.js';

/** Ce que `bench` lit de la machine avant de lancer, remplacé par les tests : charge (load average), cœurs, attente entre deux lectures. */
export type Machine = { charge?: () => number[]; coeurs?: number; dormir?: (ms: number) => Promise<void> };
/** Attente maximale par défaut de `--attendre` (minutes) et période de relecture (ms). */
export const ATTENTE_MAX_MIN = 60;
export const ATTENTE_PAS_MS = 60_000;

/**
 * L762, L911 : ce qui empêche le banc mécanique de partir — un cadence run, une session du lead ou une vague d'orchestrate vivants (tous dépôts,
 * registre commun), ou une charge à 1 min au-dessus du seuil (cœurs ÷ 2) — ou null. Avec `attendreMin`, relit chaque minute jusqu'à la fin de l'attente.
 */
async function attendreLeCalme(io: Io, m: Machine, attendreMin: number | null): Promise<string | null> {
  const coeurs = m.coeurs ?? nombreCoeurs(), seuil = seuilCharge(coeurs, io.env), lireCharge = m.charge ?? chargeMachine;
  const lire = () => refusCharge(occupants(registreCreneaux(io.env), io.now())) ?? refusChargeMachine(lireCharge()[0] ?? 0, coeurs, seuil);
  let raison = lire();
  if (!raison || attendreMin === null) return raison;
  const dormir = m.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  io.out(`banc mécanique en attente (--attendre ${attendreMin} min) : ${raison.split(' : ')[0]}`);
  for (let reste = attendreMin * 60_000; raison && reste > 0; reste -= ATTENTE_PAS_MS) { await dormir(ATTENTE_PAS_MS); raison = lire(); }
  if (raison) return `toujours occupée après ${attendreMin} min d'attente : ${raison}`;
  io.out('banc mécanique : la machine est libre, départ');
  return null;
}

/**
 * L911 : les minutes de `--attendre`, null sans l'option, ou le refus. Revue L911 (m1) : sans nombre (fin de ligne ou option suivante), 60 min ;
 * un nombre qui n'est pas un entier ≥ 1 (0, -5, abc) est refusé au lieu d'attendre une heure en silence.
 */
function optionAttendre(reste: string[]): number | null | string {
  const i = reste.indexOf('--attendre');
  if (i < 0) return null;
  const arg = reste[i + 1];
  if (arg === undefined || arg.startsWith('--')) return ATTENTE_MAX_MIN;
  return /^[1-9]\d*$/.test(arg) ? Number(arg) : `--attendre attend un nombre entier de minutes ≥ 1 (reçu « ${arg} »), ou rien pour ${ATTENTE_MAX_MIN} min`;
}

/**
 * L762, L911 : `--malgre-charge` et `--attendre [min]` d'un passage de niveau `niveau`. Le banc mécanique ne part pas sous la charge (runs, sessions du lead,
 * vagues d'orchestrate, charge > cœurs ÷ 2) : refus, attente avec --attendre, ou départ forcé avec --malgre-charge (occupants nommés, notés au rapport).
 */
export async function avantLeBanc(reste: string[], niveau: string | undefined, io: Io, m: Machine): Promise<{ refus: string } | { malgreCharge?: string[] }> {
  const forcer = reste.includes('--malgre-charge'), attendreMin = optionAttendre(reste);
  if (typeof attendreMin === 'string') return { refus: attendreMin };
  if (forcer && niveau !== 'mecanique') return { refus: '--malgre-charge ne va qu\'avec mecanique' };
  if (attendreMin !== null && (niveau !== 'mecanique' || forcer)) return { refus: '--attendre ne va qu\'avec mecanique, et pas avec --malgre-charge' };
  if (niveau !== 'mecanique') return {};
  if (!forcer) { const raison = await attendreLeCalme(io, m, attendreMin); return raison ? { refus: raison } : {}; }
  const malgreCharge = nommer(occupants(registreCreneaux(io.env), io.now()));
  io.out(`banc mécanique forcé malgré la charge (--malgre-charge) : ${malgreCharge.length ? malgreCharge.join(' ; ') : 'aucun run ni session du lead'} ; noté au rapport`);
  return { malgreCharge };
}

/**
 * Réglages de la mesure de charge d'un passage : cœurs, seuil (lu par `bench` dans io.env, revue L911 m2 ; défaut cœurs ÷ 2), période du relevé (défaut
 * 5 s), constante de lissage de la charge externe (défaut 60 s, celle du load average à 1 min) et lecture de la charge externe au banc (défaut `chargeExterne`, /proc), remplacés par les tests.
 */
export type ReglagesCharge = { coeurs?: number; seuil?: number; releve_ms?: number; lissage_ms?: number; externe?: () => number | null };
export const RELEVE_MS = 5_000;

/**
 * L762, L911 : suit la charge d'un passage. Départ lu tout de suite ; `pendant` relève, toutes les `releve_ms` tant que `f` tourne et si `releve` (bancs dans
 * des enfants : le fil principal attend ; joués en ligne, le fil est pris et seuls départ et fin comptent), le load average à 1 min (pic total, pour le
 * rapport) et les fils actifs hors de l'arbre du banc, lissés sur 1 min comme le load average (pic externe, revue L911 M1). `finir` lit la fin et rend la
 * charge du rapport, plus `marque` ({ charge_haute } quand le pic externe — à défaut de /proc, le pic total — dépasse le seuil).
 */
export function suivreCharge(lire: () => number[] = chargeMachine, releve: boolean, r: ReglagesCharge = {}) {
  const depart = lire(), lireExterne = r.externe ?? chargeExterne, pas = r.releve_ms ?? RELEVE_MS, k = Math.exp(-pas / (r.lissage_ms ?? 60_000));
  let pic = depart[0] ?? 0;
  // Au départ, rien du banc ne tourne encore : la charge à 1 min est toute externe. Sans /proc (null), externe reste indéfinie et le pic total compte.
  let lisse = depart[0] ?? 0, externe: number | undefined = depart[0] ?? 0, sansProc = false;
  const noterExterne = (poids: number) => {
    const n = lireExterne();
    if (n === null) { sansProc = true; return; }
    lisse = lisse * poids + n * (1 - poids); externe = Math.max(externe ?? 0, lisse);
  };
  const noter = () => { try { pic = Math.max(pic, lire()[0] ?? 0); noterExterne(k); } catch { /* relevé manqué : départ et fin restent */ } };
  return {
    async pendant<T>(f: () => Promise<T> | T): Promise<T> {
      const t = releve ? setInterval(noter, pas) : undefined;
      t?.unref();
      try { return await f(); } finally { clearInterval(t); }
    },
    finir(malgreCharge: string[] | undefined, out: (l: string) => void): { ch: Charge; marque: { charge_haute?: string } } {
      const fin = lire(); pic = Math.max(pic, fin[0] ?? 0);
      // Joués en ligne, aucun relevé pendant : la lecture de fin, instantanée, est la seule mesure externe.
      try { noterExterne(releve ? k : 0); } catch { sansProc = true; }
      const coeurs = r.coeurs ?? nombreCoeurs();
      const ch: Charge = { coeurs, depart, fin, pic, seuil: r.seuil ?? seuilCharge(coeurs, {}), ...(!sansProc && externe !== undefined && { externe: Math.round(externe * 100) / 100 }),
        ...(malgreCharge && { malgre_charge: malgreCharge }) };
      const haute = chargeHaute(ch);
      if (haute) out(`⚠ ${haute} pendant le passage : critères de temps non mesurables au lieu de rouges (L911)`);
      return { ch, marque: haute ? { charge_haute: haute } : {} };
    },
  };
}
