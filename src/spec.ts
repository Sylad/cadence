import { parse } from 'yaml';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

const APPEL_BACK = /^((GET|POST|PUT|PATCH|DELETE) \/\S*|job \S+|commande \S+( \S+)*)$/;
const CODE_ERREUR = /^(HTTP \d{3}|log (debug|log|warn|error))$/;
const MODIFICATIONS = ['aucune', 'ajout', 'changement'];

const liste = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Les ids d'une liste d'objets, dans l'ordre. */
const idsDe = (v: unknown): string[] => liste(v).filter(isObj).map((x) => x.id).filter(texte);
/** Un appel d'action : le sien, ou celui du contrat auquel elle renvoie (`contrat: Ax`, fiche mixte). */
export function appelDe(action: Obj, contrats: unknown): string {
  if (texte(action.appel)) return action.appel;
  const c = liste(contrats).filter(isObj).find((x) => x.id === action.contrat);
  return c && texte(c.appel) ? c.appel : '';
}

/**
 * Les écarts d'une fiche aux invariants de la spec de l'étape spec (une phrase par écart ; vide = valide). Une fiche a une partie
 * écran (`ecran`, `etats`, `champs`, `actions`), une partie back (`sujet`, `cas`, `contrats`, `donnees`), ou les deux (lot mixte) ;
 * `regles` est commun. Écran : ids de champs uniques, états connus, citations d'ids existants (actions, règles, masque).
 * Back : cas C1… et contrats A1… sans trou, règles rattachées à un cas, alternatives qui citent des règles, erreurs de contrat,
 * décision du lead sur une donnée existante modifiée. Les deux : règles R1… sans trou, statut et justification, tests « Rn — … ».
 */
export function checkFiche(doc: unknown): string[] {
  if (!isObj(doc)) return ["ce n'est pas une fiche : un document YAML à clés est attendu (ecran, etats, champs, regles, actions pour un écran ; sujet, cas, regles, contrats, donnees pour un lot sans écran)"];
  const p: string[] = [];
  const back = 'sujet' in doc;
  const ecranPart = !back || 'ecran' in doc;
  if (!back && !('ecran' in doc)) p.push('ecran ou sujet : bloc manquant (ecran pour un lot à écran, sujet pour un lot sans écran, les deux pour un lot mixte)');

  const ecran = isObj(doc.ecran) ? doc.ecran : {};
  if (ecranPart) {
    if (!isObj(doc.ecran)) p.push('ecran : bloc manquant');
    for (const k of ['id', 'titre', 'route', 'lot', 'maquette']) if (!texte(ecran[k])) p.push(`ecran.${k} : texte attendu`);
    if (texte(ecran.route) && !ecran.route.startsWith('/')) p.push(`ecran.route : « ${ecran.route} » doit commencer par /`);
    if (!Array.isArray(ecran.largeurs) || LARGEURS.some((w) => !(ecran.largeurs as unknown[]).includes(w))) p.push(`ecran.largeurs : [${LARGEURS.join(', ')}] attendu`);
  }
  const sujet = isObj(doc.sujet) ? doc.sujet : {};
  if (back) {
    if (!isObj(doc.sujet)) p.push('sujet : bloc manquant');
    for (const k of ['id', 'titre', 'lot']) if (!texte(sujet[k])) p.push(`sujet.${k} : texte attendu`);
    if (texte(sujet.id) && !KEBAB.test(sujet.id)) p.push(`sujet.id : « ${sujet.id} » doit être en kebab-case (c'est le nom du dossier docs/specs/<sujet>/)`);
    const per = sujet.perimetre;
    if (!isObj(per)) p.push('sujet.perimetre : bloc attendu (modules, endpoints, jobs)');
    else {
      for (const k of ['modules', 'endpoints', 'jobs']) if (!Array.isArray(per[k]) || (per[k] as unknown[]).some((x) => !texte(x))) p.push(`sujet.perimetre.${k} : liste de textes attendue`);
      if (['modules', 'endpoints', 'jobs'].every((k) => liste(per[k]).length === 0)) p.push('sujet.perimetre : au moins un module, un endpoint ou un job attendu');
      if ('hors_perimetre' in per && per.hors_perimetre !== null && (!Array.isArray(per.hors_perimetre) || per.hors_perimetre.some((x) => !texte(x)))) p.push('sujet.perimetre.hors_perimetre : liste de textes attendue');
    }
    if (ecranPart && isObj(doc.ecran) && isObj(doc.sujet)) {
      if (texte(sujet.id) && texte(ecran.id) && sujet.id !== ecran.id) p.push(`sujet.id « ${sujet.id} » et ecran.id « ${ecran.id} » diffèrent (dans une fiche mixte, l'un et l'autre sont le nom du dossier)`);
      if (texte(sujet.lot) && texte(ecran.lot) && sujet.lot !== ecran.lot) p.push(`sujet.lot « ${sujet.lot} » et ecran.lot « ${ecran.lot} » diffèrent (c'est le lot d'implémentation)`);
    }
  }

  let etats: string[] = [];
  let champs: unknown[] = [];
  const ids = new Set<string>();
  if (ecranPart) {
    etats = Array.isArray(doc.etats) ? doc.etats.filter(texte) : [];
    if (!Array.isArray(doc.etats)) p.push('etats : liste attendue');
    else {
      for (const [i, e] of doc.etats.entries()) if (!texte(e)) p.push(`état n° ${i + 1} : texte attendu`);
      const manquants = ETATS_REQUIS.filter((e) => !etats.includes(e));
      if (manquants.length) p.push(`états : ${manquants.map((e) => `« ${e} »`).join(', ')} manquant(s) (vide, chargement et erreur sont requis)`);
      for (const e of new Set(etats.filter((x, i) => etats.indexOf(x) !== i))) p.push(`états : « ${e} » en double`);
    }

    champs = Array.isArray(doc.champs) ? doc.champs : [];
    if (champs.length === 0) p.push('champs : liste non vide attendue');
    for (const [i, c] of champs.entries()) {
      if (!isObj(c)) {
        p.push(`champ n° ${i + 1} : objet attendu`);
        continue;
      }
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
  }

  // Les ids des cas, des règles et des contrats, relevés avant les contrôles croisés (une alternative cite des règles, une règle des cas).
  const regles: unknown[] = Array.isArray(doc.regles) ? doc.regles : [];
  const ruleIds = new Set(regles.map((r, i) => (isObj(r) && texte(r.id) ? r.id : `R${i + 1}`)));
  const casIds = new Set(liste(doc.cas).map((c, i) => (isObj(c) && texte(c.id) ? c.id : `C${i + 1}`)));
  const contratIds = new Set(idsDe(doc.contrats));

  if (back) {
    const cas: unknown[] = Array.isArray(doc.cas) ? doc.cas : [];
    if (cas.length === 0) p.push('cas : liste non vide attendue');
    for (const [i, c] of cas.entries()) {
      const attendu = `C${i + 1}`;
      if (!isObj(c)) {
        p.push(`cas n° ${i + 1} : objet attendu`);
        continue;
      }
      const id = texte(c.id) ? c.id : attendu;
      if (c.id !== attendu) p.push(`cas n° ${i + 1} : l'id doit être ${attendu} (C1, C2… dans l'ordre, sans trou), pas ${texte(c.id) ? c.id : 'absent'}`);
      for (const k of ['titre', 'acteur', 'declencheur', 'resultat']) if (!texte(c[k])) p.push(`${id} : ${k} manquant`);
      if (!Array.isArray(c.preconditions) || c.preconditions.some((x) => !texte(x))) p.push(`${id} : preconditions doit être une liste de textes`);
      if (!Array.isArray(c.nominal) || c.nominal.length === 0 || c.nominal.some((x) => !texte(x))) p.push(`${id} : nominal doit être une liste non vide d'étapes (textes)`);
      if (!Array.isArray(c.alternatives)) p.push(`${id} : alternatives doit être une liste ([] avec sans_alternative si le cas n'en a aucune)`);
      else if (c.alternatives.length === 0 && !texte(c.sans_alternative)) p.push(`${id} : au moins une alternative ou un cas d'erreur, ou « alternatives: [] » avec sa raison dans sans_alternative`);
      for (const [j, a] of liste(c.alternatives).entries()) {
        const nom = `${id} : alternative n° ${j + 1}`;
        if (!isObj(a)) {
          p.push(`${nom} : objet attendu`);
          continue;
        }
        for (const k of ['si', 'alors']) if (!texte(a[k])) p.push(`${nom} : ${k} manquant`);
        const rs = liste(a.regles);
        if (!Array.isArray(a.regles) || rs.length === 0) p.push(`${nom} : au moins une règle citée (regles)`);
        for (const r of rs) if (!ruleIds.has(String(r))) p.push(`${nom} : règle « ${String(r)} » absente de la fiche`);
      }
      if (!regles.some((r) => isObj(r) && liste(r.cas).includes(id))) p.push(`${id} : aucune règle ne le cite (chaque cas est cité par au moins une règle)`);
    }
  }

  if (regles.length === 0) p.push('regles : liste non vide attendue');
  for (const [i, r] of regles.entries()) {
    const attendu = `R${i + 1}`;
    if (!isObj(r)) {
      p.push(`règle n° ${i + 1} : objet attendu`);
      continue;
    }
    const id = texte(r.id) ? r.id : attendu;
    if (r.id !== attendu) p.push(`règle n° ${i + 1} : l'id doit être ${attendu} (R1, R2… dans l'ordre, sans trou), pas ${texte(r.id) ? r.id : 'absent'}`);
    // Une règle d'écran est rattachée à un état, une règle back à des cas ; dans une fiche mixte, à l'un des deux au moins.
    const aUnEtat = 'etat' in r && r.etat !== undefined && r.etat !== null;
    const aDesCas = 'cas' in r && r.cas !== undefined && r.cas !== null;
    if (ecranPart && (aUnEtat || !back)) {
      if (!texte(r.etat) || !etats.includes(r.etat)) p.push(`${id} : état « ${String(r.etat ?? '')} » inconnu (états : ${etats.join(', ')})`);
    } else if (aUnEtat) p.push(`${id} : etat n'a de sens que dans une fiche qui a une partie écran (ecran)`);
    if (back && !aUnEtat && (!Array.isArray(r.cas) || r.cas.length === 0)) p.push(`${id} : une règle est rattachée à au moins un cas (cas: [C1, …])${ecranPart ? ' ou à un état (etat)' : ''}`);
    if (aDesCas) {
      if (!Array.isArray(r.cas)) p.push(`${id} : cas doit être une liste d'ids de cas`);
      else for (const c of r.cas) if (!casIds.has(String(c)) || !back) p.push(`${id} : cas « ${String(c)} » absent de la fiche`);
    }
    if (!texte(r.enonce)) p.push(`${id} : enonce manquant`);
    const rattachee = !back || aUnEtat;
    if (rattachee) {
      if (!('message' in r) || !(r.message === null || typeof r.message === 'string')) p.push(`${id} : message attendu (le texte exact à l'écran, ou null)`);
    } else {
      for (const k of ['message', 'champs', 'masque']) if (r[k] !== undefined && r[k] !== null) p.push(`${id} : ${k} n'a de sens que pour une règle rattachée à un état`);
    }
    if (r.statut !== 'sourcee' && r.statut !== 'hypothese') p.push(`${id} : statut « ${String(r.statut ?? '')} » inconnu (sourcee ou hypothese)`);
    else if (r.statut === 'sourcee' && !texte(r.source)) p.push(`${id} : une règle sourcée dit d'où elle vient (source)`);
    else if (r.statut === 'hypothese' && !texte(r.si_faux)) p.push(`${id} : une hypothèse dit ce qui changerait si elle était fausse (si_faux)`);
    if (rattachee) {
      if ('champs' in r && r.champs !== undefined && r.champs !== null && !Array.isArray(r.champs)) p.push(`${id} : champs doit être une liste d'ids de champs`);
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
    }
    const tests = Array.isArray(r.tests) ? r.tests : [];
    if (tests.length === 0) p.push(`${id} : au moins un test prévu, nommé « ${id} — … »`);
    for (const t of tests) if (typeof t !== 'string' || !t.startsWith(`${id} — `)) p.push(`${id} : le test « ${String(t)} » doit être nommé « ${id} — … »`);
  }

  const actions: unknown[] = Array.isArray(doc.actions) ? doc.actions : [];
  if (ecranPart && !Array.isArray(doc.actions)) p.push('actions : liste attendue');
  const contrats: unknown[] = Array.isArray(doc.contrats) ? doc.contrats : [];
  // Les ids A sont communs aux actions de l'écran et aux contrats : sans trou sur l'ensemble (une fiche d'écran seule : dans l'ordre des actions).
  const commun = back && ecranPart;
  for (const [i, a] of actions.entries()) {
    const attendu = `A${i + 1}`;
    if (!isObj(a)) {
      p.push(`action n° ${i + 1} : objet attendu`);
      continue;
    }
    const id = texte(a.id) ? a.id : attendu;
    if (!commun && a.id !== attendu) p.push(`action n° ${i + 1} : l'id doit être ${attendu} (A1, A2… dans l'ordre), pas ${texte(a.id) ? a.id : 'absent'}`);
    if (commun && !texte(a.id)) p.push(`action n° ${i + 1} : id manquant`);
    if (a.declencheur !== null && a.declencheur !== undefined && !(texte(a.declencheur) && ids.has(a.declencheur))) p.push(`${id} : déclencheur « ${String(a.declencheur)} » absent de la fiche (un id de champ, ou null pour le chargement)`);
    if (commun && texte(a.contrat)) {
      if (!contratIds.has(a.contrat)) p.push(`${id} : contrat « ${a.contrat} » absent de la fiche (un id de contrats)`);
      if ('appel' in a && a.appel !== undefined && a.appel !== null) p.push(`${id} : une action qui renvoie à un contrat ne répète pas son appel (contrat ${a.contrat})`);
    } else if (!texte(a.appel) || !APPEL.test(a.appel)) p.push(`${id} : appel « ${String(a.appel ?? '')} » invalide (VERBE /chemin)`);
    if ('regles' in a && a.regles !== undefined && a.regles !== null && !Array.isArray(a.regles)) p.push(`${id} : regles doit être une liste d'ids de règles`);
    for (const r of Array.isArray(a.regles) ? a.regles : []) if (!ruleIds.has(String(r))) p.push(`${id} : règle « ${String(r)} » absente de la fiche`);
  }

  if (back) {
    if (!Array.isArray(doc.contrats) || contrats.length === 0) p.push('contrats : liste non vide attendue');
    for (const [i, a] of contrats.entries()) {
      const attendu = `A${i + 1}`;
      if (!isObj(a)) {
        p.push(`contrat n° ${i + 1} : objet attendu`);
        continue;
      }
      const id = texte(a.id) ? a.id : attendu;
      if (!commun && a.id !== attendu) p.push(`contrat n° ${i + 1} : l'id doit être ${attendu} (A1, A2… dans l'ordre, sans trou), pas ${texte(a.id) ? a.id : 'absent'}`);
      if (commun && !(texte(a.id) && /^A\d+$/.test(a.id))) p.push(`contrat n° ${i + 1} : l'id doit être de la forme A<n>`);
      if (!texte(a.appel) || !APPEL_BACK.test(a.appel)) p.push(`${id} : appel « ${String(a.appel ?? '')} » invalide (VERBE /chemin, job <nom> ou commande <nom>)`);
      for (const k of ['entree', 'sortie']) if (!texte(a[k])) p.push(`${id} : ${k} manquant`);
      if (!Array.isArray(a.erreurs)) p.push(`${id} : erreurs doit être une liste ([] avec sans_erreur si le contrat n'en a aucune)`);
      else if (a.erreurs.length === 0 && !texte(a.sans_erreur)) p.push(`${id} : au moins une erreur, ou « erreurs: [] » avec sa raison dans sans_erreur`);
      for (const [j, e] of liste(a.erreurs).entries()) {
        if (!isObj(e)) {
          p.push(`${id} : erreur n° ${j + 1} : objet { code, message } attendu`);
          continue;
        }
        if (!texte(e.code) || !CODE_ERREUR.test(e.code)) p.push(`${id} : erreur n° ${j + 1} : code « ${String(e.code ?? '')} » invalide (HTTP <n> ou log debug|log|warn|error)`);
        if (!texte(e.message)) p.push(`${id} : erreur n° ${j + 1} : message manquant (le texte exact)`);
      }
      if ('regles' in a && a.regles !== undefined && a.regles !== null && !Array.isArray(a.regles)) p.push(`${id} : regles doit être une liste d'ids de règles`);
      for (const r of liste(a.regles)) if (!ruleIds.has(String(r))) p.push(`${id} : règle « ${String(r)} » absente de la fiche`);
    }
    if (commun) {
      // ids A communs : uniques, et A1…An sans trou sur l'ensemble des actions et des contrats
      const tous = [...idsDe(doc.actions), ...idsDe(doc.contrats)];
      for (const d of new Set(tous.filter((x, i) => tous.indexOf(x) !== i))) p.push(`ids A : « ${d} » en double (les actions de l'écran et les contrats partagent A1…An)`);
      const manque = tous.length > 0 ? Array.from({ length: tous.length }, (_, i) => `A${i + 1}`).filter((x) => !tous.includes(x)) : [];
      if (manque.length) p.push(`ids A : A1…A${tous.length} sans trou attendu sur les actions et les contrats, ${manque.join(', ')} manquant(s)`);
    }

    const donnees: unknown[] = Array.isArray(doc.donnees) ? doc.donnees : [];
    if (!Array.isArray(doc.donnees)) p.push('donnees : liste attendue ([] si le lot ne touche aucune donnée)');
    for (const [i, d] of donnees.entries()) {
      const attendu = `D${i + 1}`;
      if (!isObj(d)) {
        p.push(`donnée n° ${i + 1} : objet attendu`);
        continue;
      }
      const id = texte(d.id) ? d.id : attendu;
      if (d.id !== attendu) p.push(`donnée n° ${i + 1} : l'id doit être ${attendu} (D1, D2… dans l'ordre), pas ${texte(d.id) ? d.id : 'absent'}`);
      for (const k of ['objet', 'note']) if (!texte(d[k])) p.push(`${id} : ${k} manquant`);
      if (typeof d.existant !== 'boolean') p.push(`${id} : existant doit valoir true ou false`);
      if (!MODIFICATIONS.includes(String(d.modification))) p.push(`${id} : modification « ${String(d.modification ?? '')} » inconnue (${MODIFICATIONS.join(', ')})`);
      else if (d.existant === true && d.modification !== 'aucune' && !texte(d.decision)) p.push(`${id} : une donnée existante modifiée porte la decision du lead (sa réponse à la question ciblée)`);
    }
  }
  return p;
}

/** Résumé d'une fiche valide, pour la sortie de `cadence spec check`. */
export function summary(doc: Obj): string {
  const n = (k: string) => (Array.isArray(doc[k]) ? (doc[k] as unknown[]).length : 0);
  const hyp = (Array.isArray(doc.regles) ? (doc.regles as Obj[]) : []).filter((r) => r.statut === 'hypothese').length;
  const ecran = isObj(doc.ecran);
  const back = isObj(doc.sujet);
  const partieBack = `${n('cas')} cas, ${n('contrats')} contrats, ${n('donnees')} données`;
  if (ecran && back) return `fiche valide : ${n('champs')} champs, ${n('regles')} règles (${hyp} hypothèses), ${n('actions')} actions ; ${partieBack}`;
  if (back) return `fiche valide : ${n('cas')} cas, ${n('regles')} règles (${hyp} hypothèses), ${n('contrats')} contrats, ${n('donnees')} données`;
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
  if (!isObj((doc as Obj).ecran)) throw new RafError("spec qa : la fiche n'a pas de partie écran (ecran) : rien à dériver pour docs/qa/expectations.md");
  const f = doc as { ecran: Obj; champs: Obj[]; regles: Obj[]; actions: Obj[]; contrats?: Obj[] };
  const vides = f.regles.filter((r) => r.etat === 'vide' && r.statut === 'sourcee');
  const propres = new Set(f.regles.filter((r) => r.etat === 'vide' || r.etat === 'erreur').flatMap((r) => (r.champs as string[] | undefined) ?? []));
  const out = [`## ${f.ecran.route as string}`];
  for (const c of f.champs.filter((x) => x.obligatoire === true && !propres.has(x.id as string))) {
    const unless = vides.filter((r) => ((r.masque as string[] | undefined) ?? []).includes(c.id as string)).map((r) => condition(r.enonce as string));
    out.push(`- shows: ${c.libelle as string}${unless.length ? ` — unless ${unless.join(' ; ')}` : ''}`);
  }
  const messages = f.regles.filter((r) => r.etat === 'erreur' && typeof r.message === 'string' && r.message !== '').map((r) => `"${r.message as string}"`);
  if (messages.length) out.push(`- never: ${messages.join(', ')}`);
  for (const a of f.actions.filter((x) => (x.declencheur === null || x.declencheur === undefined) && appelDe(x, f.contrats).startsWith('GET '))) {
    const peut = vides.filter((r) => ((a.regles as string[] | undefined) ?? []).includes(r.id as string)).map((r) => condition(r.enonce as string));
    out.push(`- api: ${appelDe(a, f.contrats).slice(4)}${peut.length ? ` — may be empty when ${peut.join(' ; ')}` : ''}`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * Les règles `hypothese` des fiches du dossier des specs (`<dir>/<écran>/fiche.yaml`), par lot (`ecran.lot`) — L174.
 * Un lot sans hypothèse n'y figure pas ; un dossier absent ou une fiche illisible ne donnent rien (le contrôle des fiches est `cadence spec check`).
 */
export function ficheHypotheses(root: string, dir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { doc } of fichesDuDossier(root, dir)) {
    if (!isObj(doc.ecran) || !texte(doc.ecran.lot)) continue;
    const ids = (Array.isArray(doc.regles) ? doc.regles : []).filter(isObj).filter((r) => r.statut === 'hypothese' && texte(r.id)).map((r) => String(r.id));
    if (ids.length) out.set(doc.ecran.lot, [...(out.get(doc.ecran.lot) ?? []), ...ids]);
  }
  return out;
}

/** Les fiches lisibles de `<dir>/<écran>/fiche.yaml` (écrans triés), avec le nom du dossier : une fiche absente ou illisible est sautée. */
export function fichesDuDossier(root: string, dir: string): { name: string; doc: Record<string, unknown> }[] {
  const base = join(root, dir);
  const out: { name: string; doc: Record<string, unknown> }[] = [];
  if (!existsSync(base)) return out;
  for (const name of readdirSync(base).sort()) {
    const file = join(base, name, 'fiche.yaml');
    if (!existsSync(file)) continue;
    try {
      const doc: unknown = parse(readFileSync(file, 'utf8'));
      if (isObj(doc)) out.push({ name, doc });
    } catch {
      // fiche illisible : le contrôle des fiches est `cadence spec check`
    }
  }
  return out;
}
