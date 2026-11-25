// Le registre des demandes (L722) : raf demande lit .cadence/demandes/D-<n>.json et y écrit une précision datée, un état et sa preuve, ou un lot rattaché,
// sans retoucher le texte d'origine. Sur une branche tenue par un programme, l'écriture va dans le plan en attente comme raf note (attente-commands.ts).
// L841 (issue 74 du compte pro) : raf demande new "<texte>" crée l'entrée D-<n suivant> ; en attente, le D-n est réservé tout de suite.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { OPTIONS_RAF } from '../../scripts/options-raf.mjs';
import { isDay } from '../dates.js';
import { RafError } from '../plan.js';
import { deferPlanWrite, type Holder, type PendingWrite, readPending } from '../repo-held.js';
import type { EarlyCtx } from './context.js';

const DEMANDES = join('.cadence', 'demandes');
const STATES = ['ouverte', 'livrée', 'vérifiée', 'abandonnée'] as const;
// Les états tapés sans accent sont acceptés : « livree » est « livrée ».
const STATE_OF: Record<string, (typeof STATES)[number]> = Object.fromEntries(STATES.flatMap((s) => [[s, s], [s.normalize('NFD').replace(/\p{M}/gu, ''), s]]));
const USAGE = 'usage : raf demande [new "texte" | <D-n> [precision "texte" | etat ouverte|livrée|vérifiée|abandonnée ["preuve ou raison"] | lot <id>]]';

interface Entry { id: string; texte: string; date?: string; etat: string; preuve?: string | null; lots?: string[]; precisions?: { date: string; texte: string }[]; [k: string]: unknown }

const fileOf = (root: string, id: string) => join(root, DEMANDES, `${id}.json`);
const isId = (id: string) => /^D-\d+$/.test(id);

/** Le D-n qu'une `raf demande new` mise en attente a réservé (son `--id`), ou null. */
const reservedBy = (w: PendingWrite): string | null => {
  const at = w.argv.indexOf('--id');
  return w.argv[0] === 'demande' && w.argv[1] === 'new' && at > 0 ? (w.argv[at + 1] ?? null) : null;
};

/**
 * Revue L841 r1 : le D-n visé par une écriture `raf demande <D-n> precision|etat|lot …` en attente et sa place dans l'argv, ou null. L'argv est celui
 * que raf a reçu : il se lit avec la table d'options de raf, une option placée avant la commande ne se prend pas pour l'identifiant.
 */
function targetOf(argv: string[]): { at: number; id: string } | null {
  const { tokens } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS_RAF, strict: false, tokens: true });
  const [cmd, id] = tokens.filter((t) => t.kind === 'positional');
  return cmd?.value === 'demande' && id && id.value !== 'new' && isId(id.value) ? { at: id.index, id: id.value } : null;
}

/** Revue L841 r1 : les numéros réservés qu'une application de l'attente a dû renuméroter (réservé → créé), relevés par carryRenumbered. */
const renumbered = new Map<string, string>();

/**
 * Revue L841 r1 : après un `raf demande new` joué depuis l'attente dont le D-n réservé était pris (un run l'a intégré entre-temps), les écritures qui
 * suivent et visaient ce D-n (lot, précision, état mises en attente après le new) suivent l'entrée renumérotée : sans cela, elles s'appliqueraient à
 * la demande d'un autre. Réécrites en place, elles le restent dans l'attente si une écriture échoue avant elles. Rend les lignes qui le disent.
 */
export function carryRenumbered(later: PendingWrite[]): string[] {
  const lines: string[] = [];
  for (const [from, to] of renumbered) {
    const moved = later.filter((w) => {
      const t = targetOf(w.argv);
      if (t?.id !== from) return false;
      w.argv[t.at] = to;
      return true;
    });
    if (moved.length) lines.push(`${from} → ${to} : ${moved.length} écriture(s) en attente qui visaient ${from}, réservée, suivent l'entrée renumérotée`);
  }
  renumbered.clear();
  return lines;
}

/** Les numéros des fichiers D-<n>.json d'un dossier du registre. */
const numbersIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => /^D-\d+\.json$/.test(f)).map((f) => Number(f.slice(2, -5))) : []);

/**
 * Le D-n suivant : après les entrées du registre, celles qu'un cadence run qui tient la branche a inscrites dans son worktree (--demande-humaine, pas
 * encore intégrées) et celles que l'attente a réservées ; deux `new` de suite, même en attente, ne prennent jamais le même numéro.
 */
function nextId(root: string, pending: PendingWrite[], holder?: Holder | null): string {
  const taken = [...numbersIn(join(root, DEMANDES)), ...(holder?.worktree ? numbersIn(join(holder.worktree, DEMANDES)) : []),
    ...pending.flatMap((w) => { const id = reservedBy(w); return id && isId(id) ? [Number(id.slice(2))] : []; })];
  return `D-${Math.max(0, ...taken) + 1}`;
}

function read(root: string, id: string): Entry {
  if (!isId(id)) throw new RafError(`${id} n'est pas un identifiant du registre (D-<n>) — ${USAGE}`);
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

/** `raf demande new …` et `raf demande <D-n> precision|etat|lot …` écrivent le registre : mis en attente sur une branche tenue ; la lecture ne l'est pas. */
export const isRegistryWrite = (rest: string[]): boolean => rest[0] === 'new' || (rest.length > 1 && Object.hasOwn(WRITERS, rest[1]!));

/** Le texte d'une demande, tel que tapé (plusieurs mots sans guillemets : joints d'une espace) ; vide refusé. */
function newText(rest: string[]): string {
  const text = rest.slice(1).join(' ');
  if (!text.trim()) throw new RafError('texte vide — raf demande new "texte de la demande, mot pour mot"');
  return text;
}

/** La ligne « Noté D-n : … » : la première ligne du texte, « … » quand il en a d'autres. */
const noted = (id: string, text: string) => `Noté ${id} : ${text.split('\n')[0]}${text.includes('\n') ? ' …' : ''}`;

/**
 * Sur une branche tenue (L841) : le D-n est réservé tout de suite, sous le verrou de l'attente, et l'écriture jouée plus tard porte ce numéro et le jour
 * de la demande (`--id`, `--jour`, internes) ; le texte passe après « -- », mot pour mot, même s'il commence par « - ».
 */
export function deferNewDemande(c: EarlyCtx, holder: Holder): string {
  const text = newText(c.rest);
  let id = '';
  const line = deferPlanWrite(c.root, holder, (pending) => {
    id = nextId(c.root, pending, holder);
    return ['demande', 'new', '--id', id, '--jour', c.today, '--', text];
  }, c.io.now());
  return `${noted(id, text)} — ${line}`;
}

/**
 * raf demande new : crée D-<n suivant> (même forme que les entrées écrites à la main : id, texte, date, etat, preuve, precisions). Jouée depuis l'attente,
 * elle garde le D-n réservé et le jour de la demande ; un numéro pris entre-temps (un run qui l'a intégré) passe au suivant, et la ligne le dit.
 */
function createDemande(c: EarlyCtx): number {
  const text = newText(c.rest);
  const date = c.values.jour ?? c.today;
  if (!isDay(date)) throw new RafError(`--jour invalide : ${date} (attendu AAAA-MM-JJ)`);
  const reserved = c.values.id;
  if (reserved !== undefined && !isId(reserved)) throw new RafError(`--id invalide : ${reserved} (attendu D-<n>)`);
  mkdirSync(join(c.root, DEMANDES), { recursive: true });
  for (let id = reserved ?? nextId(c.root, readPending(c.root)); ; id = nextId(c.root, readPending(c.root))) {
    const e: Entry = { id, texte: text, date, etat: 'ouverte', preuve: null, precisions: [] };
    try {
      writeFileSync(fileOf(c.root, id), `${JSON.stringify(e, null, 1)}\n`, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    const moved = reserved && reserved !== id ? ` (${reserved}, réservée, a été prise entre-temps dans le registre)` : '';
    if (reserved && reserved !== id) renumbered.set(reserved, id);
    c.io.out(`${noted(id, text)}${moved} — ${DEMANDES}/${id}.json créé, à commiter`);
    return 0;
  }
}

/** L'écriture appliquée à l'entrée lue (en mémoire) : ce qu'elle dit, null si rien ne change ; une écriture invalide est refusée. */
function written(e: Entry, what: string, args: string[], today: string): string | null {
  if (!Object.hasOwn(WRITERS, what)) throw new RafError(USAGE);
  return WRITERS[what]!(e, args, today);
}

/** Valide une écriture sans rien écrire (revue L722 r1) : sur une branche tenue, une écriture invalide est refusée avant la mise en attente. */
export function checkRegistryWrite(c: EarlyCtx): void {
  if (c.rest[0] === 'new') {
    newText(c.rest);
    return;
  }
  const [id, what, ...args] = c.rest as [string, string, ...string[]];
  // L841 : une demande réservée par un new encore en attente reçoit déjà ses précisions, son état, ses lots (jouées après lui).
  const pendingNew = !existsSync(fileOf(c.root, id)) && readPending(c.root).some((w) => reservedBy(w) === id);
  written(pendingNew ? { id, texte: '', etat: 'ouverte' } : read(c.root, id), what, args, c.today);
}

/** raf demande : liste les demandes ouvertes, en crée une, montre une entrée, ou y écrit une précision, un état et sa preuve, un lot. */
export function cmdDemande(c: EarlyCtx): number {
  const { rest, root, io, today } = c;
  if (rest.length === 0) {
    list(root, io.out);
    return 0;
  }
  if (rest[0] === 'new') return createDemande(c);
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
