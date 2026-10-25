import { writeFileSync } from 'node:fs';
import { RafError } from '../plan.js';
import { TYPES, checkInventaire, readInventaire } from './check.js';
import { affirmation, identite } from './evaluate.js';

type Obj = Record<string, any>;

/** Au-delà de cette part d'éléments non appariés, les deux lectures ne décrivent pas le même document : pas de réconciliation (design §3, hypothèse H3). */
export const SEUIL_NON_APPARIES = 0.3;

/** Recouvrement minimal (intersection sur union) de deux zones du même type et de la même page pour que deux lectures parlent du même élément lu autrement. */
const RECOUVREMENT_MIN = 0.5;

export interface Decision {
  verdict: 'confirme' | 'ecarte';
  raison: string;
}

export interface Item {
  /** `concordant` : les deux lectures disent la même chose ; `divergent` : le même élément, lu autrement ; `seul` : une seule lecture le porte ; `silence` : une question, réunie sans troisième regard. */
  statut: 'concordant' | 'divergent' | 'seul' | 'silence';
  /** L'élément de la lecture A, sinon celui de la lecture B : la base de l'élément réconcilié. */
  element: Obj;
  a?: Obj;
  b?: Obj;
  /** La lecture qui porte seule l'élément (`seul`). */
  lecture?: 'a' | 'b';
  /** Ce qui diffère entre les deux lectures (`divergent`). */
  detail?: string;
  /** La réponse du troisième regard (`seul`), posée par l'appelant avant `assembler`. */
  decision?: Decision;
}

export interface Reconciliation {
  items: Item[];
  concordants: number;
  divergents: number;
  seuls: number;
  silences: number;
  /** Éléments d'une seule lecture, silences exclus (une question n'est pas une lecture contredite). */
  nonApparies: number;
  /** `nonApparies` sur les éléments distincts hors silences ; null sans aucun élément. */
  ratio: number | null;
  refuse: boolean;
}

const zoneOf = (e: Obj): { x: number; y: number; l: number; h: number } | undefined => e.source?.zone;

/** Intersection sur union de deux zones ; 0 quand l'une manque. */
function recouvrement(a: Obj, b: Obj): number {
  const p = zoneOf(a);
  const q = zoneOf(b);
  if (!p || !q) return 0;
  const l = Math.min(p.x + p.l, q.x + q.l) - Math.max(p.x, q.x);
  const h = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
  if (l <= 0 || h <= 0) return 0;
  const inter = l * h;
  return inter / (p.l * p.h + q.l * q.h - inter);
}

const SKIP = new Set(['id', 'type', 'source', 'confiance', 'cause', 'ocr', 'citations', 'ecran', 'cible', 'couvre', 'usage']);
const show = (v: unknown): string => {
  const s = v === undefined ? 'absent' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
};

/** Les champs qui diffèrent, « champ : A « … » ≠ B « … » » : les ids et les renvois sont numérotés par chaque lecture, ils ne comptent pas. */
function detailDivergence(a: Obj, b: Obj): string {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (SKIP.has(k) || JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    out.push(`${k} : A « ${show(a[k])} » ≠ B « ${show(b[k])} »`);
  }
  return out.length > 0 ? out.join(' ; ') : 'affirmations différentes';
}

/**
 * Apparie deux lectures du même document, par type, page, identité (ce qui désigne l'élément, comme `ref eval`) et recouvrement de zone :
 * concordant (même identité, même affirmation), divergent (même identité et affirmation différente, ou même zone et identité différente), seul.
 * Les silences sont réunis, une même question une seule fois. `seuil` : part de non appariés au-delà de laquelle `refuse` est vrai.
 */
export function reconcilier(a: Obj, b: Obj, seuil: number = SEUIL_NON_APPARIES): Reconciliation {
  const parIdA = new Map<string, Obj>((a.elements as Obj[]).map((e) => [e.id, e]));
  const parIdB = new Map<string, Obj>((b.elements as Obj[]).map((e) => [e.id, e]));
  const cle = (e: Obj, par: Map<string, Obj>) => `${e.source?.page}\u0000${identite(e, par)}`;
  const items = new Map<Obj, Item>();
  const pairedB = new Set<Obj>();

  for (const type of TYPES.filter((t) => t !== 'silence')) {
    const as = (a.elements as Obj[]).filter((e) => e.type === type);
    const bs = (b.elements as Obj[]).filter((e) => e.type === type);
    const libresB = () => bs.filter((e) => !pairedB.has(e));
    const lier = (ea: Obj, eb: Obj, statut: 'concordant' | 'divergent') => {
      pairedB.add(eb);
      items.set(ea, { statut, element: ea, a: ea, b: eb, ...(statut === 'divergent' ? { detail: detailDivergence(ea, eb) } : {}) });
    };
    const meilleur = (ea: Obj, candidats: Obj[]): Obj | undefined => candidats.reduce<Obj | undefined>((best, c) => (best === undefined || recouvrement(ea, c) > recouvrement(ea, best) ? c : best), undefined);
    // 1. même identité et même affirmation ; 2. même identité, affirmation différente ; 3. identité différente mais même zone
    for (const ea of as) {
      const eb = meilleur(ea, libresB().filter((c) => cle(c, parIdB) === cle(ea, parIdA) && affirmation(c, parIdB) === affirmation(ea, parIdA)));
      if (eb) lier(ea, eb, 'concordant');
    }
    for (const ea of as.filter((e) => !items.has(e))) {
      const eb = meilleur(ea, libresB().filter((c) => cle(c, parIdB) === cle(ea, parIdA)));
      if (eb) lier(ea, eb, 'divergent');
    }
    for (const ea of as.filter((e) => !items.has(e))) {
      const eb = meilleur(ea, libresB().filter((c) => c.source?.page === ea.source?.page && recouvrement(ea, c) >= RECOUVREMENT_MIN));
      if (eb) lier(ea, eb, 'divergent');
    }
    for (const ea of as.filter((e) => !items.has(e))) items.set(ea, { statut: 'seul', element: ea, a: ea, lecture: 'a' });
  }

  // l'ordre de l'inventaire : la lecture A dans son ordre, puis ce que B seule porte dans son ordre
  const ordered: Item[] = [];
  for (const e of a.elements as Obj[]) if (e.type !== 'silence') ordered.push(items.get(e)!);
  for (const e of b.elements as Obj[]) if (e.type !== 'silence' && !pairedB.has(e)) ordered.push({ statut: 'seul', element: e, b: e, lecture: 'b' });
  const vues = new Set<string>();
  for (const [e, lecture] of [...(a.elements as Obj[]).map((e) => [e, 'a'] as const), ...(b.elements as Obj[]).map((e) => [e, 'b'] as const)]) {
    if (e.type !== 'silence') continue;
    const k = identite(e, new Map());
    if (vues.has(k)) continue;
    vues.add(k);
    ordered.push({ statut: 'silence', element: e, ...(lecture === 'a' ? { a: e } : { b: e }) });
  }

  const compte = (s: Item['statut']) => ordered.filter((i) => i.statut === s).length;
  const concordants = compte('concordant');
  const divergents = compte('divergent');
  const seuls = compte('seul');
  const total = concordants + divergents + seuls;
  const ratio = total === 0 ? null : seuls / total;
  return { items: ordered, concordants, divergents, seuls, silences: compte('silence'), nonApparies: seuls, ratio, refuse: ratio !== null && ratio > seuil };
}

/** Les renvois d'un élément à d'autres éléments de sa lecture : (champ, ids). `ecran` et `cible` sont obligatoires, `couvre` se réduit. */
const renvois = (e: Obj): string[] => (e.type === 'composant' ? [e.ecran] : e.type === 'etat' ? [e.cible] : e.type === 'statut' ? (e.couvre as string[]) : []);

const lectureLabel = (l: 'a' | 'b'): string => l.toUpperCase();

/** La confiance d'un élément concordant : un doute d'une lecture est un doute ; sinon `mesure` si l'une des deux a mesuré, `lu` sinon. */
function confianceConcordant(ea: Obj, eb: Obj): { confiance: string; cause?: string } {
  if (ea.confiance === 'incertain' || eb.confiance === 'incertain') {
    const causes = [ea, eb].filter((e) => e.confiance === 'incertain').map((e) => e.cause as string);
    return { confiance: 'incertain', cause: [...new Set(causes)].join(' ; ') };
  }
  return { confiance: ea.confiance === 'mesure' || eb.confiance === 'mesure' ? 'mesure' : 'lu' };
}

/**
 * L'inventaire réconcilié (genre « inventaire »), ids renumérotés `<slug>#<type>-<n>` et renvois suivis. Un divergent est `incertain` avec les deux
 * versions ; un seul écarté par le troisième regard disparaît (avec ce qui ne tient plus sans lui), un seul confirmé garde sa confiance (un doute
 * reste un doute), un seul sans décision reste `incertain` : `regard` dit si le troisième regard a eu lieu (sa cause le dit).
 * Un élément apparié tient tant que l'une de ses deux versions renvoie à des éléments gardés (la lecture A d'abord) : quand l'autre version renvoyait à un
 * élément écarté, il est gardé, rattaché d'après la version qui tient, et `incertain` avec la cause du rattachement ; il disparaît quand aucune ne tient.
 */
export function assembler(a: Obj, b: Obj, rec: Reconciliation, regard = false): Obj {
  /** `version` : la lecture dont les renvois sont suivis (la lecture A d'abord) ; absente quand l'élément disparaît. */
  type Entree = { item: Item; supprimee: boolean; version?: 'a' | 'b' };
  const entrees: Entree[] = rec.items.map((item) => ({ item, supprimee: item.statut === 'seul' && item.decision?.verdict === 'ecarte' }));
  const proprietaire = new Map<string, Entree>();
  for (const en of entrees) {
    if (en.item.a) proprietaire.set(`a:${en.item.a.id}`, en);
    if (en.item.b) proprietaire.set(`b:${en.item.b.id}`, en);
  }
  const versionsDe = (en: Entree): ('a' | 'b')[] => (['a', 'b'] as const).filter((v) => en.item[v] !== undefined);
  const cible = (v: 'a' | 'b', id: string): Entree | undefined => proprietaire.get(`${v}:${id}`);
  const vivant = (v: 'a' | 'b', id: string): boolean => {
    const t = cible(v, id);
    return t !== undefined && !t.supprimee;
  };
  /** Une version tient quand ses renvois tiennent : tous pour un composant ou un état, au moins un pour un statut. */
  const tient = (en: Entree, v: 'a' | 'b'): boolean => {
    const element = en.item[v]!;
    const ids = renvois(element);
    const vivants = ids.filter((id) => vivant(v, id)).length;
    return ids.length === 0 || (element.type === 'statut' ? vivants > 0 : vivants === ids.length);
  };
  // ce qui renvoie à un élément écarté ne tient plus : un point fixe, un écarté pouvant en entraîner d'autres. Un élément apparié tient dès que l'une de
  // ses deux versions tient (la lecture A d'abord) : la lecture B peut le rattacher à un écran conservé quand A le rattache à un écran écarté.
  for (let change = true; change; ) {
    change = false;
    for (const en of entrees) {
      if (en.supprimee) continue;
      const v = versionsDe(en).find((x) => tient(en, x));
      if (v === undefined) {
        en.supprimee = true;
        change = true;
      } else en.version = v;
    }
  }
  const compteur = new Map<string, number>();
  const nouvelId = new Map<Entree, string>();
  for (const en of entrees) {
    if (en.supprimee) continue;
    const type = en.item.element.type as string;
    const n = (compteur.get(type) ?? 0) + 1;
    compteur.set(type, n);
    nouvelId.set(en, `${a.document.slug}#${type}-${n}`);
  }
  const elements = entrees.filter((en) => !en.supprimee).map((en) => {
    const { item } = en;
    const v = en.version!;
    const e: Obj = { ...item.element, id: nouvelId.get(en)! };
    const id = (ancien: string): string => nouvelId.get(cible(v, ancien)!)!;
    // les renvois sont ceux de la version qui tient (pour un élément apparié, parfois celle de la lecture B)
    const source = item[v]!;
    if (e.type === 'composant') e.ecran = id(source.ecran);
    if (e.type === 'etat') e.cible = id(source.cible);
    if (e.type === 'statut') e.couvre = (source.couvre as string[]).filter((x) => vivant(v, x)).map(id);
    const doute = (cause: string) => {
      e.confiance = 'incertain';
      e.cause = cause;
    };
    if (item.statut === 'concordant') {
      const { confiance, cause } = confianceConcordant(item.a!, item.b!);
      e.confiance = confiance;
      if (cause === undefined) delete e.cause;
      else e.cause = cause;
    } else if (item.statut === 'divergent') {
      doute(`lectures divergentes — ${item.detail}`);
    } else if (item.statut === 'seul' && item.decision?.verdict !== 'confirme') {
      const base = `lu dans la lecture ${lectureLabel(item.lecture!)} seulement, troisième regard ${regard ? 'sans réponse' : 'non fait'}`;
      doute(item.element.confiance === 'incertain' ? `${base} ; ${item.element.cause}` : base);
    }
    // les deux lectures ne le rattachent plus au même élément : l'une renvoyait à un élément écarté par le troisième regard, l'élément est gardé
    // par l'autre (il est lu, ou mesuré, par les deux) mais son rattachement n'est plus qu'une lecture : un doute, avec sa cause
    const autre = v === 'a' ? 'b' : 'a';
    if (item.a && item.b && !tient(en, autre)) {
      const note = `rattachement : la lecture ${lectureLabel(autre)} le rattachait à un élément écarté par le troisième regard, rattaché d'après la lecture ${lectureLabel(v)}`;
      doute(e.confiance === 'incertain' ? `${e.cause} ; ${note}` : note);
    }
    return e;
  });
  return { version: 1, genre: 'inventaire', document: { slug: a.document.slug, sha256: a.document.sha256 }, elements };
}

function lireLecture(path: string): Obj {
  const doc = readInventaire(path) as Obj;
  const problems = checkInventaire(doc);
  if (problems.length > 0) throw new RafError(`ref diff : ${path} n'est pas valide (${problems.length} écart(s), voir cadence ref check) : ${problems[0]}`);
  if (doc.genre !== 'lecture') throw new RafError(`ref diff : ${path} doit être une lecture, pas un « ${doc.genre} »`);
  return doc;
}

/** `--seuil` : une part en pour cent (0 à 100) rendue en fraction ; absent, le seuil de la conception. */
export function parseSeuil(text: string | undefined, commande: string): number {
  if (text === undefined) return SEUIL_NON_APPARIES;
  if (!/^\d+(\.\d+)?$/.test(text) || Number(text) > 100) throw new RafError(`${commande} : --seuil invalide : « ${text} » (une part en pour cent, de 0 à 100)`);
  return Number(text) / 100;
}

/** `ref diff <a> <b> [--out inventaire.json] [--seuil 30]` : 0 réconcilié, 1 trop d'éléments non appariés (rien d'écrit), 2 fichier ou appel refusé. */
export function diffLectures(o: { a: string; b: string; seuil?: string; out?: string; log: (line: string) => void }): number {
  const seuil = parseSeuil(o.seuil, 'ref diff');
  const a = lireLecture(o.a);
  const b = lireLecture(o.b);
  if (a.document.slug !== b.document.slug) throw new RafError(`ref diff : les deux lectures ne sont pas du même document : slug ${a.document.slug} et ${b.document.slug}`);
  if (a.document.sha256 !== b.document.sha256) throw new RafError(`ref diff : l'empreinte des deux lectures diffère pour ${a.document.slug} : pas la même version du document (jamais deux versions mêlées)`);
  const rec = reconcilier(a, b, seuil);
  const sa = rec.items.filter((i) => i.statut === 'seul' && i.lecture === 'a').length;
  const pct = (x: number) => `${Number((x * 100).toFixed(1))} %`;
  o.log(`concordants : ${rec.concordants} · divergents : ${rec.divergents} · seuls : ${rec.seuls} (A : ${sa}, B : ${rec.seuls - sa}) · silences : ${rec.silences}`);
  o.log(`non appariés : ${rec.ratio === null ? 'n/a' : pct(rec.ratio)} (seuil ${pct(seuil)})`);
  for (const i of rec.items) {
    if (i.statut === 'divergent') o.log(`divergent : ${i.element.type} p.${i.element.source.page} : ${i.detail}`);
    if (i.statut === 'seul') o.log(`seul (${lectureLabel(i.lecture!)}) : ${i.element.type} p.${i.element.source.page} : ${identite(i.element, new Map())}`);
  }
  if (rec.refuse) {
    o.log(`plus de ${pct(seuil)} d'éléments non appariés (${rec.nonApparies} sur ${rec.concordants + rec.divergents + rec.seuls}) : les deux lectures ne décrivent pas le même document — question au lead, aucune réconciliation`);
    return 1;
  }
  if (o.out !== undefined) writeFileSync(o.out, `${JSON.stringify(assembler(a, b, rec), null, 2)}\n`);
  return 0;
}
