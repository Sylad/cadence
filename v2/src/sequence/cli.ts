import { chargerBras, executeurClaude, type Executeur } from '../bench/bras.js';
import { racineBanc } from '../bench/banc.js';
import { empreinte } from '../bench/cli.js';
import type { Io } from '../cli.js';
import type { preparer } from '../bench/preparer.js';
import { passageSequences } from './passage.js';
import { conclureSequence, echecRepetition } from './verdict.js';

export const USAGE_SEQUENCE = 'usage : cadence2 bench sequence <id> [--candidat c] [--reference r] [--repetitions N] [--juge modèle]';
const REFUS = /^(séquence refusée|un passage est déjà en cours|bras «)/;
const REPO = new URL('../../../', import.meta.url).pathname;

const option = (args: string[], nom: string): string | undefined => { const i = args.indexOf(`--${nom}`); return i >= 0 ? args[i + 1] : undefined; };

/** Substitutions des tests : faux claude, « prêt à passer », jscpd. */
export type Dep = { exec?: Executeur; prep?: typeof preparer; pret?: () => string | null; jscpd?: string[]; delaiMs?: number; empreinte?: string };

/** `cadence2 bench sequence` : N répétitions sous un seul run id ; 0 seulement si toutes sont vertes, 2 pour un refus ou un usage faux. */
export async function sequence(args: string[], io: Io, dep: Dep = {}): Promise<number> {
  const [id] = args, rep = option(args, 'repetitions'), ref = option(args, 'reference') ?? 'A', cand = option(args, 'candidat') ?? 'sequence-v2';
  const n = rep === undefined ? 1 : /^[1-9]\d*$/.test(rep) ? Number(rep) : 0;
  if (!id || id.startsWith('--') || n === 0) { io.err(USAGE_SEQUENCE + (n === 0 ? ' (--repetitions : entier ≥ 1)' : '')); return 2; }
  const racine = racineBanc(io.env), emp = dep.empreinte ?? empreinte(REPO), maintenant = io.now();
  if (ref === cand) { io.err(`sequence refusée : --candidat et --reference désignent le même bras (${ref})`); return 2; }
  if (emp === 'inconnue' || !io.env.HOME) { io.err(`sequence refusée : ${io.env.HOME ? 'empreinte inconnue (pas de dépôt git)' : 'HOME vide, les réglages utilisateur ne peuvent pas être contrôlés (R36)'}`); return 2; }
  let modele = '';
  try { modele = chargerBras(racine)[cand]?.modele ?? ''; } catch { /* bras.yaml illisible : passageSequences le dira */ }
  const verts: boolean[] = [];
  try {
    passageSequences({ racine, id, ref, cand, juge: option(args, 'juge') ?? 'opus', exec: dep.exec ?? executeurClaude, maintenant, empreinte: emp, home: io.env.HOME,
      out: io.out, ...(dep.pret && { pret: dep.pret }), jscpd: dep.jscpd, prep: dep.prep, delaiMs: dep.delaiMs, garderClones: args.includes('--garder-clones') }, n, (r, repetition) => {
      const v = conclureSequence(racine, r, ref, cand, { maintenant: io.now(), empreinte: emp, modele_candidat: modele, repetition, repetitions: n });
      verts.push(v.vert);
      io.out(`${v.vert ? 'VERT' : 'ROUGE'} — séquence ${id}, répétition ${repetition}/${n}, run ${r.run} : ${racine}/rapports/${r.run}-${r.sequence}-r${repetition}.md`);
    }, (message, repetition, run) => {
      verts.push(echecRepetition(racine, { message, run, sequence: id, repetition, repetitions: n, maintenant: io.now(), empreinte: emp, candidat: cand, reference: ref, modele_candidat: modele }).vert);
      io.err(`ROUGE — séquence ${id}, répétition ${repetition}/${n} non terminée : ${message}`);
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    io.err(`cadence2 bench sequence : ${m}`); return REFUS.test(m) ? 2 : 1;
  }
  return verts.length === n && verts.every(Boolean) ? 0 : 1;
}
