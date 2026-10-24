import { existsSync, readFileSync } from 'node:fs';
import { RafError } from '../plan.js';

type Obj = Record<string, unknown>;

/** Les onze types d'élément d'un inventaire (design §2), dans l'ordre du résumé. */
export const TYPES = ['ecran', 'composant', 'etat', 'texte', 'jeton', 'table', 'gabarit', 'schema', 'lien', 'statut', 'silence'] as const;
const CONFIANCES = ['mesure', 'lu', 'incertain'];
const CATEGORIES = ['couleur', 'taille_police', 'espacement', 'rayon', 'opacite'];
const DIRECTIONS = ['de_vers', 'bidirectionnel'];
const CONSTATS = ['confirme', 'precise', 'contredit'];

/** Le vocabulaire fermé des rôles d'un `texte` et d'un `composant` : le rôle décide de l'identité et de la justesse d'un élément, donc il est écrit ici, une ligne par rôle (repris dans templates/inventaire.json et docs/ref.md). */
export const ROLES: Record<string, string> = {
  titre: "titre d'un document, d'une page ou d'une section",
  paragraphe: 'phrase ou bloc de texte courant',
  'etiquette-figure': "mot ou valeur écrit dans une figure (flèche, axe, courbe, seuil)",
  legende: 'texte qui désigne une figure ou un tableau (« Figure 1 — … »)',
  exigence: "énoncé d'une exigence dans une liste d'exigences",
  ligne: "ligne d'un relevé ou d'un formulaire, sans autre fonction",
  'titre-panneau': "titre d'un panneau ou d'une fenêtre d'interface",
  bouton: "contrôle sur lequel on agit (composant), ou son libellé (texte)",
  panneau: "zone d'interface qui regroupe des contrôles (composant)",
};

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isList = (v: unknown): v is unknown[] => Array.isArray(v) && v.length > 0;
const isPct = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
const zoneOk = (z: unknown): boolean => isObj(z) && isInt(z.x, 0) && isInt(z.y, 0) && isInt(z.l, 1) && isInt(z.h, 1);

/** Lit un fichier JSON ; absent, dossier, vide ou illisible (BOM compris) est une erreur d'usage (code 2), pas un écart. */
export function readInventaire(path: string): unknown {
  if (!existsSync(path)) throw new RafError(`ref : fichier introuvable : ${path}`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new RafError(`ref : ${path} n'est pas un fichier lisible`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new RafError(`ref : ${path} n'est pas du JSON lisible : ${(e as Error).message.split('\n')[0]}`);
  }
}

/** Valide un inventaire ou une lecture (schéma version 1) : une ligne par écart, « chemin : raison ». Forme seulement, jamais la justesse des mesures. */
export function checkInventaire(root: unknown): string[] {
  if (!isObj(root)) return ['racine : un objet est attendu'];
  const problems: string[] = [];
  const bad = (path: string, reason: string) => problems.push(`${path} : ${reason}`);
  if (root.version !== 1) bad('version', '1 attendu');
  if (root.genre !== 'inventaire' && root.genre !== 'lecture') bad('genre', '« inventaire » ou « lecture » attendu');
  const document = isObj(root.document) ? root.document : {};
  const slug = document.slug;
  if (typeof slug !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) bad('document.slug', 'kebab-case attendu');
  if (typeof document.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(document.sha256)) bad('document.sha256', '64 caractères hexadécimaux minuscules attendus');
  if (!isList(root.elements)) {
    bad('elements', 'un tableau non vide est attendu');
    return problems;
  }
  const elements = root.elements;
  const typeOf = new Map<string, string>();
  const firstWith = new Map<string, number>();
  elements.forEach((e, i) => {
    if (!isObj(e) || typeof e.id !== 'string') return;
    if (!firstWith.has(e.id)) {
      firstWith.set(e.id, i);
      if (typeof e.type === 'string') typeOf.set(e.id, e.type);
    }
  });
  elements.forEach((e, i) => {
    const at = `elements[${i}]`;
    if (!isObj(e)) return bad(`${at}.type`, "l'un des onze types attendu");
    const type = typeof e.type === 'string' && (TYPES as readonly string[]).includes(e.type) ? e.type : undefined;
    if (type === undefined) bad(`${at}.type`, "l'un des onze types attendu");
    checkId(e, i, type, typeof slug === 'string' ? slug : undefined, firstWith, bad);
    const champ = (path: string) => bad(path, `champ du type ${type ?? 'inconnu'} manquant ou invalide`);
    checkSource(e, at, type, bad, champ);
    checkConfiance(e, at, root.genre === 'lecture', bad, champ);
    if (type !== undefined) checkFields(e, at, type, (field) => bad(`${at}.${field}`, `champ du type ${type} manquant ou invalide`), bad);
  });
  elements.forEach((e, i) => {
    if (isObj(e)) checkRefs(e, `elements[${i}]`, typeOf, firstWith, bad);
  });
  return problems;
}

type Bad = (path: string, reason: string) => void;

function checkId(e: Obj, i: number, type: string | undefined, slug: string | undefined, firstWith: Map<string, number>, bad: Bad): void {
  const at = `elements[${i}].id`;
  const id = e.id;
  // le slug attendu est celui de document tel quel : invalide, il donne un écart de plus, pas un masquage
  const ok = typeof id === 'string' && (slug !== undefined && type !== undefined ? id.startsWith(`${slug}#${type}-`) && /^[1-9]\d*$/.test(id.slice(`${slug}#${type}-`.length)) : /^[^#]+#[a-z]+-[1-9]\d*$/.test(id));
  if (!ok) bad(at, '<slug>#<type>-<n> attendu');
  const first = typeof id === 'string' ? firstWith.get(id) : undefined;
  if (first !== undefined && first !== i) bad(at, `déjà porté par elements[${first}]`);
}

function checkSource(e: Obj, at: string, type: string | undefined, bad: Bad, champ: (path: string) => void): void {
  const source = isObj(e.source) ? e.source : {};
  if (!isInt(source.page, 1)) champ(`${at}.source.page`);
  // seul un silence peut n'avoir pas de zone ; s'il en porte une, elle est validée
  if (!(type === 'silence' && source.zone === undefined) && !zoneOk(source.zone)) bad(`${at}.source.zone`, 'x, y, l, h entiers attendus (l et h ≥ 1)');
  if (e.citations !== undefined) {
    if (!Array.isArray(e.citations)) return champ(`${at}.citations`);
    e.citations.forEach((c, j) => {
      const o = isObj(c) ? c : {};
      if (!isInt(o.page, 1)) champ(`${at}.citations[${j}].page`);
      if (!isInt(o.ligne, 1)) champ(`${at}.citations[${j}].ligne`);
      if (!isText(o.extrait)) champ(`${at}.citations[${j}].extrait`);
    });
  }
}

function checkConfiance(e: Obj, at: string, lecture: boolean, bad: Bad, champ: (path: string) => void): void {
  const confiance = e.confiance;
  if (typeof confiance !== 'string' || !CONFIANCES.includes(confiance)) bad(`${at}.confiance`, 'mesure, lu ou incertain attendu');
  if (e.ocr !== undefined && typeof e.ocr !== 'boolean') champ(`${at}.ocr`);
  if (confiance === 'incertain') {
    if (!isText(e.cause)) bad(`${at}.cause`, 'obligatoire pour un élément incertain');
  } else if (e.cause !== undefined && CONFIANCES.includes(confiance as string)) {
    champ(`${at}.cause`);
  }
  if (lecture && e.ocr === true && confiance === 'lu') bad(`${at}.confiance`, "un texte ocr n'est jamais lu dans une lecture");
}

/** Les champs propres au type : `fail(chemin)` écrit l'écart « champ du type … manquant ou invalide » ; `bad` sert aux raisons propres. */
function checkFields(e: Obj, at: string, type: string, fail: (field: string) => void, bad: Bad): void {
  const need = (field: string, ok: boolean) => {
    if (!ok) fail(field);
  };
  const sub = (v: unknown): Obj => (isObj(v) ? v : {});
  switch (type) {
    case 'ecran': {
      need('largeur_reference', isInt(e.largeur_reference, 1));
      if (!isList(e.zones)) return fail('zones');
      e.zones.forEach((z, j) => {
        const o = sub(z);
        const p = `zones[${j}]`;
        need(`${p}.nom`, isText(o.nom));
        for (const k of ['x', 'y']) need(`${p}.${k}`, isInt(o[k], 0));
        for (const k of ['l', 'h']) need(`${p}.${k}`, isInt(o[k], 1));
        if (!isObj(o.pct)) return fail(`${p}.pct`);
        for (const k of ['x', 'y', 'l', 'h']) need(`${p}.pct.${k}`, isPct(o.pct[k]));
      });
      return;
    }
    case 'composant': {
      need('role', isText(e.role));
      checkRole(e, at, bad);
      const position = sub(e.position);
      const taille = sub(e.taille);
      for (const k of ['x', 'y']) need(`position.${k}`, isInt(position[k], 0));
      for (const k of ['l', 'h']) need(`taille.${k}`, isInt(taille[k], 1));
      need('contenu', typeof e.contenu === 'string');
      need('ecran', typeof e.ecran === 'string');
      return;
    }
    case 'etat':
      need('nom', isText(e.nom));
      need('cible', typeof e.cible === 'string');
      return;
    case 'texte':
      // un libellé recopié tel quel n'a ni blanc en tête ni blanc en fin (R33)
      need('libelle', isText(e.libelle) && e.libelle === e.libelle.trim());
      need('role', isText(e.role));
      checkRole(e, at, bad);
      return;
    case 'jeton': {
      need('categorie', typeof e.categorie === 'string' && CATEGORIES.includes(e.categorie));
      need('valeur', isText(e.valeur) || (typeof e.valeur === 'number' && Number.isFinite(e.valeur)));
      const point = e.point;
      if (e.confiance === 'mesure' || point !== undefined) {
        const carre = isObj(point) && isInt(point.x, 0) && isInt(point.y, 0);
        need('point', carre && (point.l === undefined && point.h === undefined ? true : zoneOk(point)));
      }
      if (e.contraste !== undefined) {
        const c = sub(e.contraste);
        need('contraste.texte', isText(c.texte));
        need('contraste.fond', isText(c.fond));
        need('contraste.ratio', typeof c.ratio === 'number' && c.ratio >= 1 && c.ratio <= 21);
      }
      return;
    }
    case 'table': {
      need('colonnes', isList(e.colonnes) && e.colonnes.every((c) => typeof c === 'string'));
      if (!isList(e.lignes)) return fail('lignes');
      const largeur = Array.isArray(e.colonnes) ? e.colonnes.length : -1;
      e.lignes.forEach((l, j) => need(`lignes[${j}]`, Array.isArray(l) && l.length === largeur && l.every((c) => typeof c === 'string')));
      return;
    }
    case 'gabarit': {
      need('nom', isText(e.nom));
      if (!isList(e.champs)) return fail('champs');
      e.champs.forEach((c, j) => {
        const o = sub(c);
        const p = `champs[${j}]`;
        need(`${p}.nom`, isText(o.nom));
        need(`${p}.obligatoire`, typeof o.obligatoire === 'boolean');
        need(`${p}.format`, isText(o.format));
        const num = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
        need(`${p}.min`, num(o.min) && !(typeof o.min === 'number' && typeof o.max === 'number' && o.min > o.max));
        need(`${p}.max`, num(o.max));
      });
      return;
    }
    case 'schema': {
      const ids = new Set<string>();
      if (!isList(e.noeuds)) fail('noeuds');
      else
        e.noeuds.forEach((n, j) => {
          const o = sub(n);
          need(`noeuds[${j}].id`, isText(o.id) && !ids.has(o.id));
          if (isText(o.id)) ids.add(o.id);
          need(`noeuds[${j}].libelle`, isText(o.libelle));
        });
      if (!Array.isArray(e.flux)) return fail('flux');
      e.flux.forEach((f, j) => {
        const o = sub(f);
        need(`flux[${j}].de`, typeof o.de === 'string');
        need(`flux[${j}].vers`, typeof o.vers === 'string');
        need(`flux[${j}].libelle`, isText(o.libelle));
        need(`flux[${j}].direction`, typeof o.direction === 'string' && DIRECTIONS.includes(o.direction));
      });
      return;
    }
    case 'lien': {
      need('figure', isText(e.figure));
      if (!isObj(e.passage)) fail('passage');
      else {
        need('passage.page', isInt(e.passage.page, 1));
        need('passage.ligne', isInt(e.passage.ligne, 1));
        need('passage.extrait', isText(e.passage.extrait));
      }
      if (typeof e.constat !== 'string' || !CONSTATS.includes(e.constat)) return fail('constat');
      if (e.constat === 'precise') for (const k of ['lecture_ambigue', 'interpretation', 'raison']) need(k, isText(e[k]));
      if (e.constat === 'contredit') {
        need('enonces', Array.isArray(e.enonces) && e.enonces.length === 2 && e.enonces.every(isText));
        if (e.interpretation !== undefined) bad(`${at}.interpretation`, 'un lien contredit ne tranche pas');
      }
      return;
    }
    case 'statut':
      need('libelle', isText(e.libelle));
      need('couvre', isList(e.couvre) && e.couvre.every((c) => typeof c === 'string'));
      return;
    case 'silence':
      // rédigée en question : elle se termine par « ? » (R35)
      need('question', isText(e.question) && e.question.trimEnd().endsWith('?'));
      return;
  }
}

/** Un rôle non vide hors de la liste est un écart de schéma, jamais une erreur de lecture mesurée plus tard. */
function checkRole(e: Obj, at: string, bad: Bad): void {
  if (isText(e.role) && !Object.hasOwn(ROLES, e.role)) bad(`${at}.role`, `« ${e.role} » n'est pas un rôle de la liste : ${Object.keys(ROLES).join(', ')}`);
}

/** Les références d'un élément, résolues sur la liste complète des ids (R27) et sur les noeuds du schéma (R23). */
function checkRefs(e: Obj, at: string, typeOf: Map<string, string>, ids: Map<string, number>, bad: Bad): void {
  const expect = (path: string, id: unknown, types: string[]) => {
    if (typeof id === 'string' && !types.includes(typeOf.get(id) ?? '')) bad(path, `${id} ne désigne aucun élément de type ${types.join(' ou ')}`);
  };
  if (e.type === 'composant') expect(`${at}.ecran`, e.ecran, ['ecran']);
  if (e.type === 'etat') expect(`${at}.cible`, e.cible, ['composant', 'ecran']);
  if (e.type === 'statut' && Array.isArray(e.couvre)) {
    e.couvre.forEach((id, j) => {
      if (typeof id === 'string' && !ids.has(id)) bad(`${at}.couvre[${j}]`, `${id} ne désigne aucun élément de type ${TYPES.slice(0, -1).join(', ')} ou ${TYPES[TYPES.length - 1]}`);
    });
  }
  if (e.type === 'schema' && Array.isArray(e.noeuds) && Array.isArray(e.flux)) {
    const noeuds = new Set(e.noeuds.map((n) => (isObj(n) ? n.id : undefined)));
    e.flux.forEach((f, j) => {
      if (!isObj(f)) return;
      for (const k of ['de', 'vers']) if (typeof f[k] === 'string' && !noeuds.has(f[k])) bad(`${at}.flux[${j}].${k}`, `${f[k]} ne désigne aucun élément de type noeud`);
    });
  }
}

/** « inventaire valide : N éléments (ecran: n, …) », les types présents dans l'ordre des onze ; le genre dit « inventaire » ou « lecture ». */
export function summaryInventaire(root: Obj): string {
  const elements = root.elements as Obj[];
  const parts = TYPES.map((t) => [t, elements.filter((e) => e.type === t).length] as const).filter(([, n]) => n > 0).map(([t, n]) => `${t}: ${n}`);
  return `${root.genre} valide : ${elements.length} éléments (${parts.join(', ')})`;
}
