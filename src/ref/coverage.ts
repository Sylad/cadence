import { resolve } from 'node:path';
import type { Io } from '../cli.js';
import { RafError, type Lot, type Plan } from '../plan.js';
import { isProgramNote } from '../orchestrate/decisions.js';
import { fichesDuDossier } from '../spec.js';
import { checkInventaire, readInventaire, TYPES } from './check.js';

type Obj = Record<string, unknown>;

/** Un id d'élément d'inventaire (`<slug>#<type>-<n>`, R9 de `ref check`) tel qu'un lot le cite dans son titre, son objectif ou ses notes. */
const ID_SOURCE = `[a-z0-9]+(?:-[a-z0-9]+)*#(?:${TYPES.join('|')})-[1-9]\\d*`;
const ID_PATTERN = new RegExp(ID_SOURCE, 'g');
/** Une ligne de `perimetre.hors_perimetre` d'une fiche qui justifie un élément non pris : `<id> : <raison>`. */
const JUSTIFICATION = new RegExp(`^\\s*(${ID_SOURCE})\\s*:\\s*(\\S.*)$`);

/** Les ids d'éléments d'inventaire cités dans un texte, sans doublon, dans l'ordre. */
export function idsInText(text: string): string[] {
  return [...new Set(text.match(ID_PATTERN) ?? [])];
}

/**
 * Les ids qu'un lot cite : son titre, son objectif (`goal:`) et les notes que le lead a écrites sur le lot. Les notes que le programme pose (titre remplacé,
 * mineur de revue, hypothèses…) et celles des sous-tâches ne comptent pas : elles citent ce que le lot ne couvre plus ou ne couvre pas, et c'est le lot qui est fait ou non.
 */
export function lotIds(lot: Pick<Lot, 'title' | 'goal' | 'notes'>): string[] {
  return idsInText([lot.title, lot.goal ?? '', ...lot.notes.map((n) => n.text).filter((t) => !isProgramNote(t))].join('\n'));
}

/** Les éléments que la fiche d'un lot justifie comme non pris (`<id> : <raison>` dans `sujet.perimetre.hors_perimetre`), par id. */
function nonPris(repo: string, specDir: string, lotId: string): Map<string, string> {
  const out = new Map<string, string>();
  const doc = fichesDuDossier(repo, specDir).find(({ doc }) => (doc.sujet as { lot?: unknown } | undefined)?.lot === lotId)?.doc;
  const sujet = doc?.sujet as { perimetre?: { hors_perimetre?: unknown } } | undefined;
  const lignes = sujet?.perimetre?.hors_perimetre;
  for (const l of Array.isArray(lignes) ? lignes : []) {
    const m = typeof l === 'string' ? JUSTIFICATION.exec(l) : null;
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

/** Consigne des briefs d'un lot qui cite des éléments d'un document de référence : le spec-writer les prend ou justifie, le ux-reviewer les vérifie sur l'écran fini. */
export function referenceIdsText(role: 'spec' | 'ux', ids: string[]): string {
  if (!ids.length) return '';
  const list = ids.map((id) => `- \`${id}\``).join('\n');
  if (role === 'spec') {
    return [
      'The lot covers these elements of a reference document (ids of its `inventaire.json`, `<slug>#<type>-<n>`):',
      list,
      'Take each one into the sheet: the field, rule or state that shows it quotes its id in its `source` (e.g. `source: "exemple#texte-3"`). An element you do not take is justified, one line `<id> : <reason>` — in the report under "choix", and in `perimetre.hors_perimetre` when the sheet has a back part. An id you leave out without a reason is a gap the review reads as a finding. `cadence ref coverage` reads the `hors_perimetre` lines: an element so justified is not covered by your lot, it stays a gap until the lead writes its exclusion or another lot takes it.',
    ].join('\n');
  }
  return [
    'The lot covers these elements of a reference document (ids of its `inventaire.json`):',
    list,
    'On the finished screen, verify each one: it is visible (or reachable) in the state where the sheet puts it, its text, role and place are those of the element, and it is in the captures you take. An element missing or different on the running screen is a finding naming its id; an element the sheet justified as not taken is not one.',
  ].join('\n');
}

/** Ce qui désigne un élément à l'œil : son libellé, sa question, son nom… (rien pour un jeton ou une table sans nom). */
function label(e: Obj): string {
  const text = [e.libelle, e.question, e.nom, e.contenu, e.figure, e.valeur].find((v) => typeof v === 'string' || typeof v === 'number');
  return text === undefined ? '' : ` « ${String(text).slice(0, 60)} »`;
}

function where(e: Obj): string {
  const source = e.source as { page: number; zone?: { x: number; y: number; l: number; h: number } };
  const zone = source.zone ? ` zone ${source.zone.x},${source.zone.y},${source.zone.l},${source.zone.h}` : '';
  return `p.${source.page}${zone}`;
}

interface Coverage {
  /** Un élément par ligne ✗ : aucun lot, ou des lots qui ne sont pas faits. */
  gaps: { id: string; text: string }[];
  /** Les écarts de la liste `exclusions` (id inconnu, raison absente) : jamais comptés comme une exclusion. */
  problems: string[];
  total: number;
  done: number;
  excluded: number;
}

/**
 * Calcule la couverture d'un inventaire valide par les lots du plan (fait, abandonné compté pour rien) et par ses exclusions écrites. Un lot fait dont la fiche
 * justifie un élément comme non pris (`justifies`) ne le couvre pas : l'élément reste un écart tant que le lead ne l'a pas exclu par écrit ou fait par un autre lot.
 */
function computeCoverage(inventaire: Obj, lots: Pick<Lot, 'id' | 'title' | 'goal' | 'notes' | 'status'>[], justifies: (lotId: string) => Map<string, string> = () => new Map()): Coverage {
  const elements = inventaire.elements as Obj[];
  const known = new Set(elements.map((e) => e.id as string));
  const byId = new Map<string, { id: string; status: string }[]>();
  for (const lot of lots) for (const id of lotIds(lot)) if (known.has(id)) byId.set(id, [...(byId.get(id) ?? []), { id: lot.id, status: lot.status }]);
  const problems: string[] = [];
  const excluded = new Set<string>();
  const raw = inventaire.exclusions;
  if (raw !== undefined && !Array.isArray(raw)) problems.push('exclusions : un tableau [{ id, raison }] est attendu');
  else
    (raw as unknown[] | undefined)?.forEach((x, i) => {
      const o = typeof x === 'object' && x !== null ? (x as Obj) : {};
      if (typeof o.id !== 'string' || !known.has(o.id)) problems.push(`exclusions[${i}].id : ${String(o.id)} ne désigne aucun élément de l'inventaire`);
      else if (typeof o.raison !== 'string' || o.raison.trim() === '') problems.push(`exclusions[${i}].raison : la raison de l'exclusion de ${o.id} est obligatoire`);
      else excluded.add(o.id);
    });
  const gaps: Coverage['gaps'] = [];
  let done = 0;
  for (const e of elements) {
    const id = e.id as string;
    const mine = (byId.get(id) ?? []).filter((l) => l.status !== 'dropped');
    const faits = mine.filter((l) => l.status === 'done');
    const pris = faits.filter((l) => !justifies(l.id).has(id));
    if (pris.length > 0) done++;
    else if (!excluded.has(id)) {
      const reason = faits.length
        ? `justifié non pris par la fiche de ${faits.map((l) => `${l.id} : ${justifies(l.id).get(id)}`).join(' ; ')}, sans exclusion écrite`
        : mine.length ? `lot non fait (${mine.map((l) => `${l.id} ${l.status}`).join(', ')})` : 'aucun lot, aucune exclusion écrite';
      gaps.push({ id, text: `${id} (${e.type} ${where(e)}${label(e)}) : ${reason}` });
    }
  }
  return { gaps, problems, total: elements.length, done, excluded: elements.length - done - gaps.length };
}

const USAGE = 'usage : cadence ref coverage <inventaire.json>';

/** `cadence ref coverage <inventaire.json>` : l'inventaire de `--double` ou la lecture de `lectures/a.json` (le défaut de `ref analyse`) ; 0 si tout élément a un lot fait ou une exclusion écrite, 1 sinon, 2 pour un appel mal formé ou un fichier qui n'est pas un inventaire ou une lecture valide. Sans modèle, sans outil système. */
export function coverageCommand(args: string[], loadPlan: () => Plan, io: Io, fiches: { repo: string; specDir: string }): number {
  if (args.length !== 1) throw new RafError(USAGE);
  const path = resolve(io.cwd, args[0]!);
  const inventaire = readInventaire(path);
  const invalid = checkInventaire(inventaire);
  if (invalid.length > 0) throw new RafError(`ref coverage : ${path} n'est ni un inventaire ni une lecture valide (${invalid.length} écart(s), voir cadence ref check) : ${invalid[0]}`);
  const cache = new Map<string, Map<string, string>>();
  const justifies = (lotId: string): Map<string, string> => {
    if (!cache.has(lotId)) cache.set(lotId, nonPris(fiches.repo, fiches.specDir, lotId));
    return cache.get(lotId)!;
  };
  const c = computeCoverage(inventaire as Obj, loadPlan().lots(), justifies);
  for (const p of c.problems) io.out(`✗ ${p}`);
  for (const g of c.gaps) io.out(`✗ ${g.text}`);
  const left = c.gaps.length + c.problems.length;
  if (left > 0) {
    io.out(`${c.gaps.length} élément(s) sans lot fait ni exclusion écrite${c.problems.length ? `, ${c.problems.length} exclusion(s) refusée(s)` : ''} sur ${c.total}`);
    return 1;
  }
  io.out(`couverture complète : ${c.total} éléments (${c.done} par un lot fait, ${c.excluded} exclus avec leur raison)`);
  return 0;
}
