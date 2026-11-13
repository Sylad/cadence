// Le registre des demandes (L722) : raf demande lit .cadence/demandes/D-<n>.json et y écrit une précision datée, un état et sa preuve, ou un lot rattaché,
// sans retoucher le texte d'origine. Sur une branche tenue par un programme, l'écriture va dans le plan en attente comme raf note (attente-commands.ts).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RafError } from '../plan.js';
import type { EarlyCtx } from './context.js';

const DEMANDES = join('.cadence', 'demandes');
const STATES = ['ouverte', 'livrée', 'vérifiée', 'abandonnée'] as const;
// Les états tapés sans accent sont acceptés : « livree » est « livrée ».
const STATE_OF: Record<string, (typeof STATES)[number]> = Object.fromEntries(STATES.flatMap((s) => [[s, s], [s.normalize('NFD').replace(/\p{M}/gu, ''), s]]));
const USAGE = 'usage : raf demande [<D-n> [precision "texte" | etat ouverte|livrée|vérifiée|abandonnée ["preuve ou raison"] | lot <id>]]';

interface Entry { id: string; texte: string; date?: string; etat: string; preuve?: string; lots?: string[]; precisions?: { date: string; texte: string }[]; [k: string]: unknown }

const fileOf = (root: string, id: string) => join(root, DEMANDES, `${id}.json`);

function read(root: string, id: string): Entry {
  if (!/^D-\d+$/.test(id)) throw new RafError(`${id} n'est pas un identifiant du registre (D-<n>) — ${USAGE}`);
  const f = fileOf(root, id);
  if (!existsSync(f)) throw new RafError(`${id} absente du registre (${DEMANDES}/${id}.json)`);
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as Entry;
  } catch (e) {
    throw new RafError(`${DEMANDES}/${id}.json illisible : ${(e as Error).message}`);
  }
}

/** Même forme que les entrées écrites par cadence run (v2/src/registre.ts) : JSON indenté d'un espace, ordre des clés gardé. */
const write = (root: string, e: Entry) => writeFileSync(fileOf(root, e.id), `${JSON.stringify(e, null, 1)}\n`);

/** Les entrées du registre, dans l'ordre de leur numéro ; une entrée illisible est dite, pas tue. */
function list(root: string, out: (l: string) => void): void {
  const dir = join(root, DEMANDES);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^D-\d+\.json$/.test(f)).sort((a, b) => Number(a.slice(2, -5)) - Number(b.slice(2, -5))) : [];
  const open = files.flatMap((f) => {
    try {
      const e = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Entry;
      return e.etat === 'ouverte' ? [`${e.id}  ouverte  ${(e.texte ?? '').split('\n')[0]!.slice(0, 100)}${e.lots?.length ? `  (lots : ${e.lots.join(', ')})` : ''}`] : [];
    } catch {
      return [`${f.slice(0, -5)}  illisible`];
    }
  });
  if (open.length === 0) out(`aucune demande ouverte (${files.length} entrée(s) dans ${DEMANDES})`);
  for (const l of open) out(l);
}

type Write = (e: Entry, args: string[], today: string) => string | null;

/** Le texte d'origine n'est jamais réécrit : une précision s'ajoute, datée. */
const addPrecision: Write = (e, args, today) => {
  const text = args.join(' ').trim();
  if (!text) throw new RafError(`précision vide — ${USAGE}`);
  e.precisions = [...(e.precisions ?? []), { date: today, texte: text }];
  return `précision ajoutée (${today})`;
};

/**
 * Livrée et vérifiée se prouvent, la preuve s'ajoute à la précédente (« · ») ; abandonnée dit sa raison (le geste est celui de Sylvain), rangée comme
 * dans le registre (revue L722 r1) : `raison`, `abandon` (la date) et `etat_avant_abandon`, la preuve d'une livraison d'avant restant telle quelle.
 */
const setState: Write = (e, args, today) => {
  const state = STATE_OF[args[0] ?? ''];
  if (!state) throw new RafError(`état inconnu : ${args[0] ?? '(aucun)'} (ouverte, livrée, vérifiée ou abandonnée) — ${USAGE}`);
  const proof = args.slice(1).join(' ').trim();
  const word = state === 'abandonnée' ? 'raison' : 'preuve';
  if (state !== 'ouverte' && !proof) throw new RafError(`${state} sans ${word} — raf demande ${e.id} etat ${state} "${state === 'abandonnée' ? 'raison' : 'commit, test, ou commande et sa sortie'}"`);
  if (state === 'abandonnée') Object.assign(e, { etat_avant_abandon: e.etat, raison: proof, abandon: today });
  else if (proof) e.preuve = e.preuve ? `${e.preuve} · ${proof}` : proof;
  e.etat = state;
  return `état ${state}${proof ? `, ${word} ajoutée` : ''}`;
};

/** Rend null quand le lot est déjà rattaché : rien à écrire. */
const attachLot: Write = (e, args) => {
  if (args.length !== 1 || !args[0]) throw new RafError(`un seul lot à rattacher — ${USAGE}`);
  if (e.lots?.includes(args[0])) return null;
  e.lots = [...(e.lots ?? []), args[0]];
  return `lot ${args[0]} rattaché`;
};

const WRITERS: Record<string, Write> = { precision: addPrecision, 'précision': addPrecision, etat: setState, 'état': setState, lot: attachLot };

/** `raf demande <D-n> precision|etat|lot …` écrit le registre : mis en attente sur une branche tenue ; la lecture (`raf demande [D-n]`) ne l'est pas. */
export const isRegistryWrite = (rest: string[]): boolean => rest.length > 1 && Object.hasOwn(WRITERS, rest[1]!);

/** L'écriture appliquée à l'entrée lue (en mémoire) : ce qu'elle dit, null si rien ne change ; une écriture invalide est refusée. */
function written(e: Entry, what: string, args: string[], today: string): string | null {
  if (!Object.hasOwn(WRITERS, what)) throw new RafError(USAGE);
  return WRITERS[what]!(e, args, today);
}

/** Valide une écriture sans rien écrire (revue L722 r1) : sur une branche tenue, une écriture invalide est refusée avant la mise en attente. */
export function checkRegistryWrite(c: EarlyCtx): void {
  const [id, what, ...args] = c.rest as [string, string, ...string[]];
  written(read(c.root, id), what, args, c.today);
}

/** raf demande : liste les demandes ouvertes, montre une entrée, ou y écrit une précision, un état et sa preuve, un lot. */
export function cmdDemande(c: EarlyCtx): number {
  const { rest, root, io, today } = c;
  if (rest.length === 0) {
    list(root, io.out);
    return 0;
  }
  const [id, what, ...args] = rest as [string, string | undefined, ...string[]];
  const e = read(root, id);
  if (what === undefined) {
    io.out(JSON.stringify(e, null, 1));
    return 0;
  }
  const said = written(e, what, args, today);
  if (said === null) {
    io.out(`${id} : ${args[0]} déjà rattaché`);
    return 0;
  }
  write(root, e);
  io.out(`${id} : ${said} — ${DEMANDES}/${id}.json modifié, à commiter`);
  return 0;
}
