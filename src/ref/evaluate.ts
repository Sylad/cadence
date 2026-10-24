import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RafError } from '../plan.js';
import { TYPES, checkInventaire, readInventaire } from './check.js';

type Obj = Record<string, any>;

export interface Compte {
  attendus: number;
  lus: number;
  /** Lus qui retrouvent un attendu par son identité ET disent la même chose (la mesure de rappel et de précision). */
  justes: number;
  /** Lus marqués `mesure` ou `lu` : ce que la lecture donne pour sûr. */
  sures: number;
  /** Sûrs qui ne sont pas justes : le faux lu, la métrique la plus grave. */
  faux_lu: number;
}

export interface Taux extends Compte {
  rappel: number | null;
  precision: number | null;
  taux_faux_lu: number | null;
}

export interface Piege {
  piege: string;
  attendus: number;
  trouves: number;
}

export interface Tokens {
  total: number | null;
  pages: number | null;
  par_page: number | null;
  /** Les cas lus avec un `usage` mais dont l'attendu n'a pas de `pages` : exclus des tokens par page (ni leurs tokens ni un zéro page ne comptent). */
  exclus: string[];
}

export interface ResultatCas {
  cas: string;
  /** Faux quand aucune lecture n'existe pour ce cas : tout l'attendu est alors manqué. */
  lecture: boolean;
  /** Le `pages` de l'attendu ; `null` quand l'attendu n'en porte pas. */
  pages: number | null;
  tokens: number | null;
  types: Record<string, Compte>;
  pieges: Piege[];
}

export interface Evaluation {
  total: Taux;
  types: Record<string, Taux>;
  pieges: Piege[];
  tokens: Tokens;
  cas: ResultatCas[];
}

const norm = (v: unknown): string => {
  const s = String(v ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? String(Number(s)) : s;
};
/** Le libellé d'un `texte` est verbatim : seuls les blancs sont normalisés, la casse compte (`120 KT` n'est pas `120 kt`). */
const normTexte = (v: unknown): string => String(v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
const noms = (xs: unknown, cle: string): string[] => (Array.isArray(xs) ? xs.map((x) => norm((x as Obj)?.[cle])) : []);

/** Ce qui désigne un élément, indépendamment de son id, de sa zone et de sa confiance : deux lectures indépendantes numérotent à leur façon. */
function identite(e: Obj, parId: Map<string, Obj>): string {
  const cible = (id: unknown): string => {
    const t = typeof id === 'string' ? parId.get(id) : undefined;
    return t ? `${t.type}:${identite(t, new Map())}` : '?';
  };
  switch (e.type) {
    case 'ecran':
      return 'ecran';
    case 'composant':
      return `${norm(e.role)}|${norm(e.contenu)}`;
    case 'etat':
      return `${norm(e.nom)}>${cible(e.cible)}`;
    case 'texte':
      return normTexte(e.libelle);
    case 'statut':
      return norm(e.libelle);
    case 'jeton':
      return `${norm(e.categorie)}=${norm(e.valeur)}`;
    case 'table':
      return (e.colonnes as unknown[]).map(norm).join('|');
    case 'gabarit':
      return norm(e.nom);
    case 'schema':
      return noms(e.noeuds, 'libelle').sort().join('|');
    case 'lien':
      return norm(e.figure);
    default:
      return norm(e.question);
  }
}

/** Ce que l'élément affirme une fois retrouvé : une identité juste avec une affirmation fausse est un faux lu, pas un rappel. */
function affirmation(e: Obj, parId: Map<string, Obj>): string {
  switch (e.type) {
    case 'ecran':
      return String(e.largeur_reference);
    case 'texte':
      return norm(e.role);
    case 'table':
      return JSON.stringify((e.lignes as unknown[][]).map((l) => l.map(norm)));
    case 'gabarit':
      return JSON.stringify((e.champs as Obj[]).map((c) => [norm(c.nom), c.obligatoire, norm(c.format), c.min ?? null, c.max ?? null]));
    case 'schema': {
      const libelle = new Map<string, string>((e.noeuds as Obj[]).map((n) => [n.id, norm(n.libelle)]));
      return JSON.stringify((e.flux as Obj[]).map((f) => `${libelle.get(f.de)}>${libelle.get(f.vers)}:${norm(f.libelle)}:${f.direction}`).sort());
    }
    case 'lien':
      return String(e.constat);
    case 'statut':
      return JSON.stringify((e.couvre as string[]).map((id) => {
        const t = parId.get(id);
        return t ? `${t.type}:${identite(t, new Map())}` : '?';
      }).sort());
    default:
      return '';
  }
}

const compteVide = (): Compte => ({ attendus: 0, lus: 0, justes: 0, sures: 0, faux_lu: 0 });
const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

/** Apparie lus et attendus par type et identité, un attendu une seule fois ; les appariements à l'affirmation exacte passent d'abord. */
export function evaluerCas(nom: string, attendu: Obj, lecture: Obj | null): ResultatCas {
  const types: Record<string, Compte> = {};
  const compte = (t: string): Compte => (types[t] ??= compteVide());
  const parIdAttendu = new Map<string, Obj>((attendu.elements as Obj[]).map((e) => [e.id, e]));
  const lus: Obj[] = lecture ? (lecture.elements as Obj[]) : [];
  const parIdLu = new Map<string, Obj>(lus.map((e) => [e.id, e]));
  const trouve = new Set<Obj>();
  const juste = new Set<Obj>();
  const justeAtt = new Set<Obj>();
  const libre = new Set<Obj>(attendu.elements as Obj[]);
  const cle = (e: Obj, par: Map<string, Obj>) => `${e.type}\u0000${identite(e, par)}`;
  const apparier = (exact: boolean) => {
    for (const lu of lus) {
      if (juste.has(lu) || trouve.has(lu)) continue;
      for (const att of libre) {
        if (cle(att, parIdAttendu) !== cle(lu, parIdLu)) continue;
        const pareil = affirmation(att, parIdAttendu) === affirmation(lu, parIdLu);
        if (exact && !pareil) continue;
        libre.delete(att);
        trouve.add(lu);
        if (pareil) {
          juste.add(lu);
          justeAtt.add(att);
        }
        break;
      }
    }
  };
  apparier(true);
  apparier(false);
  for (const e of attendu.elements as Obj[]) compte(e.type).attendus++;
  for (const lu of lus) {
    const c = compte(lu.type);
    c.lus++;
    if (lu.confiance !== 'incertain') c.sures++;
    if (juste.has(lu)) c.justes++;
    else if (lu.confiance !== 'incertain') c.faux_lu++;
  }
  const parPiege = new Map<string, Piege>();
  for (const e of attendu.elements as Obj[]) {
    if (typeof e.piege !== 'string') continue;
    const p = parPiege.get(e.piege) ?? { piege: e.piege, attendus: 0, trouves: 0 };
    p.attendus++;
    if (justeAtt.has(e)) p.trouves++;
    parPiege.set(e.piege, p);
  }
  const tokens = typeof lecture?.usage?.tokens === 'number' && lecture.usage.tokens >= 0 ? lecture.usage.tokens : null;
  return { cas: nom, lecture: lecture !== null, pages: Number.isInteger(attendu.pages) && attendu.pages > 0 ? attendu.pages : null, tokens, types, pieges: [...parPiege.values()] };
}

function taux(c: Compte): Taux {
  return { ...c, rappel: ratio(c.justes, c.attendus), precision: ratio(c.justes, c.lus), taux_faux_lu: ratio(c.faux_lu, c.sures) };
}

/** Additionne les cas : par type, au total, par piège (même nom d'un cas à l'autre) et en tokens par page (cas qui ont une mesure seulement). */
export function agreger(cas: ResultatCas[]): Evaluation {
  const types: Record<string, Compte> = {};
  const total = compteVide();
  const pieges = new Map<string, Piege>();
  let tokens: number | null = null;
  let pages = 0;
  const exclus: string[] = [];
  for (const r of cas) {
    for (const [t, c] of Object.entries(r.types)) {
      const a = (types[t] ??= compteVide());
      for (const k of Object.keys(a) as (keyof Compte)[]) {
        a[k] += c[k];
        total[k] += c[k];
      }
    }
    for (const p of r.pieges) {
      const a = pieges.get(p.piege) ?? { piege: p.piege, attendus: 0, trouves: 0 };
      a.attendus += p.attendus;
      a.trouves += p.trouves;
      pieges.set(p.piege, a);
    }
    if (r.tokens !== null && r.pages === null) exclus.push(r.cas);
    else if (r.tokens !== null && r.pages !== null) {
      tokens = (tokens ?? 0) + r.tokens;
      pages += r.pages;
    }
  }
  const ordre = (t: string) => TYPES.indexOf(t as (typeof TYPES)[number]);
  const triee = Object.fromEntries(Object.entries(types).sort(([a], [b]) => ordre(a) - ordre(b)).map(([t, c]) => [t, taux(c)]));
  return {
    total: taux(total),
    types: triee,
    pieges: [...pieges.values()],
    tokens: tokens === null || pages === 0 ? { total: null, pages: null, par_page: null, exclus } : { total: tokens, pages, par_page: tokens / pages, exclus },
    cas,
  };
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${Number((x * 100).toFixed(1))} %`);

export function formatEvaluation(ev: Evaluation): string[] {
  const t = ev.total;
  const lignes = [
    `${ev.cas.length} cas · ${t.attendus} éléments attendus · ${t.lus} lus`,
    `rappel : ${pct(t.rappel)} (${t.justes}/${t.attendus}) · précision : ${pct(t.precision)} (${t.justes}/${t.lus})`,
    `faux lu : ${pct(t.taux_faux_lu)} (${t.faux_lu}/${t.sures} sûrs)`,
    ev.tokens.par_page === null ? 'tokens par page : non mesurés' : `tokens par page : ${Number(ev.tokens.par_page.toFixed(1))} (${ev.tokens.total} sur ${ev.tokens.pages} pages)`,
  ];
  if (ev.tokens.exclus.length > 0) lignes.push(`tokens par page : ${ev.tokens.exclus.length} cas sans \`pages\` exclus (${ev.tokens.exclus.join(', ')})`);
  lignes.push('par type :');
  for (const [type, c] of Object.entries(ev.types)) lignes.push(`  ${type.padEnd(10)} rappel ${pct(c.rappel)} (${c.justes}/${c.attendus}) · précision ${pct(c.precision)} (${c.justes}/${c.lus}) · faux lu ${c.faux_lu}/${c.sures}`);
  if (ev.pieges.length > 0) {
    lignes.push('pièges :');
    for (const p of ev.pieges) lignes.push(`  ${p.trouves === p.attendus ? '✓' : '✗'} ${p.piege} : ${p.trouves}/${p.attendus}`);
  }
  const sans = ev.cas.filter((c) => !c.lecture).map((c) => c.cas);
  if (sans.length > 0) lignes.push(`sans lecture : ${sans.join(', ')}`);
  return lignes;
}

function charger(path: string, genres: string[], role: string): Obj {
  const doc = readInventaire(path);
  const problems = checkInventaire(doc);
  if (problems.length > 0) throw new RafError(`ref eval : ${role} ${path} n'est pas valide (${problems.length} écart(s), voir cadence ref check) : ${problems[0]}`);
  if (!genres.includes((doc as Obj).genre)) throw new RafError(`ref eval : ${role} ${path} doit être ${genres.length === 1 ? `un ${genres[0]}` : `une lecture ou un inventaire`}, pas « ${(doc as Obj).genre} »`);
  return doc as Obj;
}

/** Les cas d'un chemin : un fichier est un cas, un dossier en a un par sous-dossier qui porte `fichier` (ordre alphabétique). */
function cheminsDeCas(chemin: string, fichier: string): { nom: string; fichier: string }[] {
  if (!existsSync(chemin)) throw new RafError(`ref : fichier introuvable : ${chemin}`);
  if (!statSync(chemin).isDirectory()) return [{ nom: 'document', fichier: chemin }];
  return readdirSync(chemin)
    .sort()
    .filter((n) => existsSync(join(chemin, n, fichier)))
    .map((n) => ({ nom: n, fichier: join(chemin, n, fichier) }));
}

/** `ref eval <attendu> <lecture>` : deux fichiers, ou deux dossiers (`<cas>/attendu.json`, `<cas>/lecture.json`). */
export function evaluer(attendu: string, lecture: string): Evaluation {
  const attendus = cheminsDeCas(attendu, 'attendu.json');
  const lecturesTrouvees = cheminsDeCas(lecture, 'lecture.json');
  const dossier = statSync(attendu).isDirectory();
  // un fichier contre un dossier ne s'apparie à aucun cas : la lecture serait ignorée, la mesure fausse
  if (dossier !== statSync(lecture).isDirectory()) {
    throw new RafError(`ref eval : combinaisons acceptées : deux fichiers (attendu.json lecture.json) ou deux dossiers (<cas>/attendu.json, <cas>/lecture.json) ; reçu ${dossier ? 'un dossier et un fichier' : 'un fichier et un dossier'}`);
  }
  if (dossier && attendus.length === 0) throw new RafError(`ref eval : aucun attendu.json dans les sous-dossiers de ${attendu}`);
  const lectures = new Map(lecturesTrouvees.map((c) => [c.nom, c.fichier]));
  const cas = attendus.map((a) => {
    const att = charger(a.fichier, ['inventaire'], "l'attendu");
    const fichier = dossier ? lectures.get(a.nom) : lecture;
    if (fichier === undefined) return evaluerCas(a.nom, att, null);
    const lu = charger(fichier, ['lecture', 'inventaire'], 'la lecture');
    if (lu.document.slug !== att.document.slug) throw new RafError(`ref eval : le slug de la lecture (${lu.document.slug}) n'est pas celui de l'attendu (${att.document.slug})`);
    if (lu.document.sha256 !== att.document.sha256) throw new RafError(`ref eval : l'empreinte de la lecture n'est pas celle de l'attendu pour ${att.document.slug} : pas la même version du document`);
    return evaluerCas(a.nom, att, lu);
  });
  return agreger(cas);
}
