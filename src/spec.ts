import { parse } from 'yaml';
import { existsSync, readFileSync } from 'node:fs';
import { RafError } from './plan.js';

/** Les largeurs de rendu d'une fiche (L170, spec etape-spec S2). */
export const LARGEURS = [1440, 390];
/** Les états qu'une fiche porte au moins. */
export const ETATS_REQUIS = ['vide', 'chargement', 'erreur'];

const KEBAB = /^[a-z][a-z0-9-]*$/;
const APPEL = /^(GET|POST|PUT|PATCH|DELETE) \/\S*$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const texte = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Les écarts d'une fiche d'écran aux invariants de la spec de l'étape spec (une phrase par écart ; vide = valide) :
 * ids de champs uniques, règles R1… sans trou, statut et justification, états connus, tests « Rn — … »,
 * citations d'ids existants (actions, règles, masque).
 */
export function checkFiche(doc: unknown): string[] {
  if (!isObj(doc)) return ["ce n'est pas une fiche : un document YAML à clés (ecran, etats, champs, regles, actions) est attendu"];
  const p: string[] = [];

  const ecran = isObj(doc.ecran) ? doc.ecran : {};
  if (!isObj(doc.ecran)) p.push('ecran : bloc manquant');
  for (const k of ['id', 'titre', 'route', 'lot', 'maquette']) if (!texte(ecran[k])) p.push(`ecran.${k} : texte attendu`);
  if (texte(ecran.route) && !ecran.route.startsWith('/')) p.push(`ecran.route : « ${ecran.route} » doit commencer par /`);
  if (!Array.isArray(ecran.largeurs) || LARGEURS.some((w) => !(ecran.largeurs as unknown[]).includes(w))) p.push(`ecran.largeurs : [${LARGEURS.join(', ')}] attendu`);

  const etats: string[] = Array.isArray(doc.etats) ? doc.etats.filter(texte) : [];
  if (!Array.isArray(doc.etats)) p.push('etats : liste attendue');
  else {
    const manquants = ETATS_REQUIS.filter((e) => !etats.includes(e));
    if (manquants.length) p.push(`états : ${manquants.map((e) => `« ${e} »`).join(', ')} manquant(s) (vide, chargement et erreur sont requis)`);
    for (const e of new Set(etats.filter((x, i) => etats.indexOf(x) !== i))) p.push(`états : « ${e} » en double`);
  }

  const champs: Obj[] = Array.isArray(doc.champs) ? doc.champs.filter(isObj) : [];
  if (!Array.isArray(doc.champs) || champs.length === 0) p.push('champs : liste non vide attendue');
  const ids = new Set<string>();
  for (const [i, c] of champs.entries()) {
    const nom = texte(c.id) ? `« ${c.id} »` : `n° ${i + 1}`;
    if (!texte(c.id)) p.push(`champ ${nom} : id manquant`);
    else {
      if (!KEBAB.test(c.id)) p.push(`champ ${nom} : l'id doit être en kebab-case (c'est aussi le data-testid)`);
      if (ids.has(c.id)) p.push(`champ ${nom} en double`);
      ids.add(c.id);
    }
    for (const k of ['libelle', 'type', 'source']) if (!texte(c[k])) p.push(`champ ${nom} : ${k} manquant`);
    if (typeof c.obligatoire !== 'boolean') p.push(`champ ${nom} : obligatoire doit valoir true ou false`);
  }

  const regles: Obj[] = Array.isArray(doc.regles) ? doc.regles.filter(isObj) : [];
  if (!Array.isArray(doc.regles) || regles.length === 0) p.push('regles : liste non vide attendue');
  const ruleIds = new Set<string>();
  for (const [i, r] of regles.entries()) {
    const attendu = `R${i + 1}`;
    const id = texte(r.id) ? r.id : attendu;
    if (r.id !== attendu) p.push(`règle n° ${i + 1} : l'id doit être ${attendu} (R1, R2… dans l'ordre, sans trou), pas ${texte(r.id) ? r.id : 'absent'}`);
    ruleIds.add(id);
    if (!texte(r.etat) || !etats.includes(r.etat)) p.push(`${id} : état « ${String(r.etat ?? '')} » inconnu (états : ${etats.join(', ')})`);
    if (!texte(r.enonce)) p.push(`${id} : enonce manquant`);
    if (!('message' in r) || !(r.message === null || typeof r.message === 'string')) p.push(`${id} : message attendu (le texte exact à l'écran, ou null)`);
    if (r.statut !== 'sourcee' && r.statut !== 'hypothese') p.push(`${id} : statut « ${String(r.statut ?? '')} » inconnu (sourcee ou hypothese)`);
    else if (r.statut === 'sourcee' && !texte(r.source)) p.push(`${id} : une règle sourcée dit d'où elle vient (source)`);
    else if (r.statut === 'hypothese' && !texte(r.si_faux)) p.push(`${id} : une hypothèse dit ce qui changerait si elle était fausse (si_faux)`);
    const cites = Array.isArray(r.champs) ? r.champs : [];
    for (const c of cites) if (!ids.has(String(c))) p.push(`${id} : champ « ${String(c)} » absent de la fiche`);
    if ('masque' in r && r.masque !== undefined && r.masque !== null) {
      if (!Array.isArray(r.masque)) p.push(`${id} : masque doit être une liste d'ids de champs`);
      else {
        if (r.etat !== 'vide') p.push(`${id} : masque n'a de sens que pour une règle d'état « vide » (état « ${String(r.etat)} »)`);
        for (const m of r.masque) {
          if (!ids.has(String(m))) p.push(`${id} : masque cite le champ « ${String(m)} » absent de la fiche`);
          else if (cites.includes(m)) p.push(`${id} : masque cite « ${String(m)} » que la règle fait apparaître dans champs`);
        }
      }
    }
    const tests = Array.isArray(r.tests) ? r.tests : [];
    if (tests.length === 0) p.push(`${id} : au moins un test prévu, nommé « ${id} — … »`);
    for (const t of tests) if (typeof t !== 'string' || !t.startsWith(`${id} — `)) p.push(`${id} : le test « ${String(t)} » doit être nommé « ${id} — … »`);
  }

  const actions: Obj[] = Array.isArray(doc.actions) ? doc.actions.filter(isObj) : [];
  if (!Array.isArray(doc.actions)) p.push('actions : liste attendue');
  for (const [i, a] of actions.entries()) {
    const attendu = `A${i + 1}`;
    const id = texte(a.id) ? a.id : attendu;
    if (a.id !== attendu) p.push(`action n° ${i + 1} : l'id doit être ${attendu} (A1, A2… dans l'ordre), pas ${texte(a.id) ? a.id : 'absent'}`);
    if (a.declencheur !== null && a.declencheur !== undefined && !(texte(a.declencheur) && ids.has(a.declencheur))) p.push(`${id} : déclencheur « ${String(a.declencheur)} » absent de la fiche (un id de champ, ou null pour le chargement)`);
    if (!texte(a.appel) || !APPEL.test(a.appel)) p.push(`${id} : appel « ${String(a.appel ?? '')} » invalide (VERBE /chemin)`);
    for (const r of Array.isArray(a.regles) ? a.regles : []) if (!ruleIds.has(String(r))) p.push(`${id} : règle « ${String(r)} » absente de la fiche`);
  }
  return p;
}

/** Résumé d'une fiche valide, pour la sortie de `cadence spec check`. */
export function summary(doc: Obj): string {
  const n = (k: string) => (Array.isArray(doc[k]) ? (doc[k] as unknown[]).length : 0);
  const hyp = (Array.isArray(doc.regles) ? (doc.regles as Obj[]) : []).filter((r) => r.statut === 'hypothese').length;
  return `fiche valide : ${n('champs')} champs, ${n('regles')} règles (${hyp} hypothèses), ${n('actions')} actions`;
}

/** Lit une fiche YAML ; un fichier absent ou illisible est une erreur d'usage (code 2), pas un écart de la fiche. */
export function readFiche(path: string): unknown {
  if (!existsSync(path)) throw new RafError(`spec : fiche introuvable : ${path}`);
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new RafError(`spec : ${path} n'est pas du YAML lisible : ${(e as Error).message.split('\n')[0]}`);
  }
}

/** Une phrase sans point final, pour la suite d'un « unless » ou d'un « may be empty when ». */
const condition = (enonce: string) => enonce.trim().replace(/[.\s]+$/, '');

/**
 * La section `docs/qa/expectations.md` de l'écran, dérivée de la fiche (spec etape-spec § 5). Une fiche invalide est refusée.
 * - `shows:` un champ obligatoire par ligne, sauf les champs propres à un état (cités par une règle d'état vide ou erreur) ;
 *   la ligne d'un champ du `masque` d'une règle sourcée d'état vide se termine par `— unless <énoncé>`.
 * - `never:` les messages des règles d'état erreur (jamais celui d'une règle vide : c'est un affichage prévu).
 * - `api:` les actions de chargement (sans déclencheur) en GET ; `— may be empty when <énoncé>` si une règle sourcée d'état vide la porte.
 */
export function deriveQa(doc: unknown): string {
  const problems = checkFiche(doc);
  if (problems.length > 0) throw new RafError(`fiche invalide :\n${problems.map((m) => `✗ ${m}`).join('\n')}`);
  const f = doc as { ecran: Obj; champs: Obj[]; regles: Obj[]; actions: Obj[] };
  const vides = f.regles.filter((r) => r.etat === 'vide' && r.statut === 'sourcee');
  const propres = new Set(f.regles.filter((r) => r.etat === 'vide' || r.etat === 'erreur').flatMap((r) => (r.champs as string[] | undefined) ?? []));
  const out = [`## ${f.ecran.route as string}`];
  for (const c of f.champs.filter((x) => x.obligatoire === true && !propres.has(x.id as string))) {
    const unless = vides.filter((r) => ((r.masque as string[] | undefined) ?? []).includes(c.id as string)).map((r) => condition(r.enonce as string));
    out.push(`- shows: ${c.libelle as string}${unless.length ? ` — unless ${unless.join(' ; ')}` : ''}`);
  }
  const messages = f.regles.filter((r) => r.etat === 'erreur' && typeof r.message === 'string' && r.message !== '').map((r) => `"${r.message as string}"`);
  if (messages.length) out.push(`- never: ${messages.join(', ')}`);
  for (const a of f.actions.filter((x) => (x.declencheur === null || x.declencheur === undefined) && (x.appel as string).startsWith('GET '))) {
    const peut = vides.filter((r) => ((a.regles as string[] | undefined) ?? []).includes(r.id as string)).map((r) => condition(r.enonce as string));
    out.push(`- api: ${(a.appel as string).slice(4)}${peut.length ? ` — may be empty when ${peut.join(' ; ')}` : ''}`);
  }
  return `${out.join('\n')}\n`;
}
