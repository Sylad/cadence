import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../orchestrate/snapshot.js';
import type { Model } from '../orchestrate/launch.js';
import type { Decision, Item } from './diff.js';
import { decodePng, encodePng, type Raster } from './png.js';
import { sessionDeRef, type SessionRef } from './session.js';

type Obj = Record<string, any>;

/** Marge (pixels de la page rendue) ajoutée de chaque côté de la zone d'un élément dans sa découpe : de quoi lire ce qui l'entoure. */
const MARGE_DECOUPE = 24;

/** Sortie structurée du troisième regard : un verdict par numéro d'élément ; le programme ne retient que les verdicts valides. */
const REGARD_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          numero: { type: 'integer', description: 'The number of the element in the brief.' },
          verdict: { type: 'string', enum: ['confirme', 'ecarte'] },
          raison: { type: 'string', description: 'One sentence: what the crop shows.' },
        },
        required: ['numero', 'verdict', 'raison'],
        additionalProperties: false,
      },
    },
    questions: { type: 'array', items: { type: 'string' }, description: 'What a human must settle.' },
  },
  required: ['decisions', 'questions'],
  additionalProperties: false,
};

/** Découpe la zone d'un élément (marge comprise, bornée à la page) dans `crops/regard-<numero>.png` ; null quand la page n'est pas rendue ou que la zone est hors d'elle. */
function decouper(docDir: string, e: Obj, numero: number, pages: Map<number, Raster>): string | null {
  const page = join(docDir, 'pages', `page-${e.source.page}.png`);
  const z = e.source.zone as { x: number; y: number; l: number; h: number } | undefined;
  if (!existsSync(page) || !z) return null;
  if (!pages.has(e.source.page)) pages.set(e.source.page, decodePng(readFileSync(page), `page ${e.source.page}`)); // une page se décode une fois, quel que soit le nombre de ses éléments
  const r = pages.get(e.source.page)!;
  const x0 = Math.max(0, z.x - MARGE_DECOUPE);
  const y0 = Math.max(0, z.y - MARGE_DECOUPE);
  const x1 = Math.min(r.width, z.x + z.l + MARGE_DECOUPE);
  const y1 = Math.min(r.height, z.y + z.h + MARGE_DECOUPE);
  if (x1 <= x0 || y1 <= y0) return null;
  const rgba = Buffer.alloc((x1 - x0) * (y1 - y0) * 4);
  for (let y = y0; y < y1; y++) r.data.copy(rgba, (y - y0) * (x1 - x0) * 4, (y * r.width + x0) * 4, (y * r.width + x1) * 4);
  const dir = join(docDir, 'crops');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `regard-${numero}.png`);
  writeFileSync(file, encodePng(x1 - x0, y1 - y0, rgba));
  return file;
}

/** Ce qu'une lecture a écrit d'un élément, sans ce qui renvoie à sa propre numérotation ni à sa confiance : le troisième regard juge ce qui est dit, pas qui le dit. */
const POSE = (e: Obj): string => JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['id', 'confiance', 'cause', 'ocr', 'usage', 'ecran', 'cible', 'couvre'].includes(k))));

interface RegardOptions extends Omit<SessionRef, 'agent' | 'brief' | 'schema' | 'model' | 'echec'> {
  seuls: Item[];
  model: Model;
}

type ResultatRegard = { kind: 'ok'; decisions: (Decision | undefined)[]; tokens: number; session: string; questions: string[] } | { kind: 'quota'; message: string };

/**
 * Le troisième regard : une session de `reference-verifier` qui ne voit que les éléments d'une seule lecture et leur découpe, et dit pour chacun
 * s'il est confirmé ou écarté. Rend une décision par élément (dans l'ordre de `seuls`) ; un verdict sans raison ou inconnu, ou un numéro
 * hors de la liste, vaut une absence de réponse (`undefined`) ; un numéro répété garde son premier verdict. Un silence du troisième regard n'est jamais un `lu`.
 */
export async function troisiemeRegard(o: RegardOptions): Promise<ResultatRegard> {
  for (const f of existsSync(join(o.docDir, 'crops')) ? readdirSync(join(o.docDir, 'crops')) : []) if (/^regard-\d+\.png$/.test(f)) rmSync(join(o.docDir, 'crops', f));
  const cadence = `node ${join(PACKAGE_ROOT, 'bin', 'cadence.js')}`;
  const pages = new Map<number, Raster>();
  const blocs = o.seuls.map((item, i) => {
    const e = item.element;
    const crop = decouper(o.docDir, e, i + 1, pages);
    return [
      `${i + 1}. ${POSE(e)}`,
      `   page : ${join(o.docDir, 'pages', `page-${e.source.page}.png`)}`,
      crop ? `   découpe : ${crop}` : '   pas de découpe : la page n\'est pas rendue ou la zone est hors d\'elle, regarde la page entière',
    ].join('\n');
  });
  const brief = [
    `Troisième regard sur le document de référence « ${o.slug} » : ${o.seuls.length} élément${o.seuls.length > 1 ? 's' : ''} qu'un seul des deux lecteurs a écrit${o.seuls.length > 1 ? 's' : ''}.`,
    '',
    `Dossier du document : ${o.docDir}`,
    '',
    ...blocs,
    '',
    `Pour chacun : confirme, ou ecarte, avec la raison. Mesurer une zone (pixels de la page rendue) : ${cadence} ref measure ${o.slug} <page> <page | x,y | x,y,l,h> --quoi couleurs|contraste|boites|texte --config ${o.configPath}`,
    `Ne lis que les découpes et les pages ci-dessus ; n'écris aucun fichier.`,
  ].join('\n');
  const r = await sessionDeRef({ ...o, agent: 'reference-verifier', brief, schema: REGARD_SCHEMA, echec: 'la session du troisième regard a échoué' });
  if (r.kind === 'quota') return r;
  const structured = r.structured as { decisions?: unknown; questions?: unknown } | undefined;
  const decisions: (Decision | undefined)[] = o.seuls.map(() => undefined);
  for (const d of Array.isArray(structured?.decisions) ? (structured.decisions as Obj[]) : []) {
    const i = Number(d?.numero) - 1;
    const raison = typeof d?.raison === 'string' ? d.raison.trim() : '';
    if (!Number.isInteger(i) || i < 0 || i >= decisions.length || decisions[i] !== undefined) continue;
    if ((d.verdict !== 'confirme' && d.verdict !== 'ecarte') || raison === '') continue;
    decisions[i] = { verdict: d.verdict, raison };
  }
  const questions = Array.isArray(structured?.questions) ? structured.questions.map(String) : [];
  return { kind: 'ok', decisions, tokens: r.tokens, session: r.session, questions };
}
