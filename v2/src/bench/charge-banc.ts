// L911 (D-40) : la charge de la machine autour d'un passage du banc — avant de lancer (refus ou attente) et pendant (pic, temps non mesurables).
// Vécu : 27-11 08:01, charge de fin 23,6 sur 32 cœurs, banc mécanique ROUGE en « temps des retouches » (247 s contre 188) sans aucune régression.
import type { Io } from '../cli.js';
import { chargeHaute, chargeMachine, nombreCoeurs, nommer, occupants, refusCharge, refusChargeMachine, registreCreneaux, seuilCharge, type Charge } from './charge.js';

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
 * L762, L911 : `--malgre-charge` et `--attendre [min]` d'un passage de niveau `niveau`. Le banc mécanique ne part pas sous la charge (runs, sessions du lead,
 * vagues d'orchestrate, charge > cœurs ÷ 2) : refus, attente avec --attendre, ou départ forcé avec --malgre-charge (occupants nommés, notés au rapport).
 */
export async function avantLeBanc(reste: string[], niveau: string | undefined, io: Io, m: Machine): Promise<{ refus: string } | { malgreCharge?: string[] }> {
  const forcer = reste.includes('--malgre-charge'), iA = reste.indexOf('--attendre');
  const attendreMin = iA < 0 ? null : /^[1-9]\d*$/.test(reste[iA + 1] ?? '') ? Number(reste[iA + 1]) : ATTENTE_MAX_MIN;
  if (forcer && niveau !== 'mecanique') return { refus: '--malgre-charge ne va qu\'avec mecanique' };
  if (attendreMin !== null && (niveau !== 'mecanique' || forcer)) return { refus: '--attendre ne va qu\'avec mecanique, et pas avec --malgre-charge' };
  if (niveau !== 'mecanique') return {};
  if (!forcer) { const raison = await attendreLeCalme(io, m, attendreMin); return raison ? { refus: raison } : {}; }
  const malgreCharge = nommer(occupants(registreCreneaux(io.env), io.now()));
  io.out(`banc mécanique forcé malgré la charge (--malgre-charge) : ${malgreCharge.length ? malgreCharge.join(' ; ') : 'aucun run ni session du lead'} ; noté au rapport`);
  return { malgreCharge };
}

/** Réglages de la mesure de charge d'un passage, remplacés par les tests : cœurs, seuil, période du relevé (défaut 60 s). */
export type ReglagesCharge = { coeurs?: number; seuil?: number; releve_ms?: number };

/**
 * L762, L911 : suit la charge d'un passage. Départ lu tout de suite ; `pendant` relève la charge à 1 min chaque minute tant que `f` tourne, si `releve`
 * (bancs dans des enfants : le fil principal attend ; joués en ligne, le fil est pris et seuls départ et fin comptent) ; `finir` lit la fin, garde le pic
 * et rend la charge du rapport, plus `marque` ({ charge_haute } quand le pic dépasse le seuil, pour la barre du verdict et l'historique).
 */
export function suivreCharge(lire: () => number[] = chargeMachine, releve: boolean, r: ReglagesCharge = {}) {
  const depart = lire();
  let pic = depart[0] ?? 0;
  const noter = () => { try { pic = Math.max(pic, lire()[0] ?? 0); } catch { /* relevé manqué : départ et fin restent */ } };
  return {
    async pendant<T>(f: () => Promise<T> | T): Promise<T> {
      const t = releve ? setInterval(noter, r.releve_ms ?? 60_000) : undefined;
      t?.unref();
      try { return await f(); } finally { clearInterval(t); }
    },
    finir(malgreCharge: string[] | undefined, out: (l: string) => void): { ch: Charge; marque: { charge_haute?: string } } {
      const fin = lire(); pic = Math.max(pic, fin[0] ?? 0);
      const coeurs = r.coeurs ?? nombreCoeurs();
      const ch: Charge = { coeurs, depart, fin, pic, seuil: r.seuil ?? seuilCharge(coeurs), ...(malgreCharge && { malgre_charge: malgreCharge }) };
      const haute = chargeHaute(ch);
      if (haute) out(`⚠ ${haute} pendant le passage : critères de temps non mesurables au lieu de rouges (L911)`);
      return { ch, marque: haute ? { charge_haute: haute } : {} };
    },
  };
}
