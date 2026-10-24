import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, isNode, isScalar, isSeq, parse, parseDocument, stringify, type Node } from 'yaml';
import type { Screen } from '../plan.js';
import { acceptationFile } from './accept.js';
import { checkFiche, fichesDuDossier, LARGEURS } from '../spec.js';

// Étape spec d'orchestrate (L171, spec etape-spec S3) : ce que le programme sait de la sortie de la session `spec`.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** Chemin (relatif au dépôt) de la fiche du lot sous `<dir>/<écran ou sujet>/fiche.yaml` (`ecran.lot` ou `sujet.lot`), ou null : sert à ne pas rejouer une spec déjà écrite. */
export function findFiche(repo: string, dir: string, lot: string): string | null {
  const hit = fichesDuDossier(repo, dir).find(({ doc }) => (isObj(doc.ecran) && doc.ecran.lot === lot) || (isObj(doc.sujet) && doc.sujet.lot === lot));
  return hit ? `${dir}/${hit.name}/fiche.yaml` : null;
}

/**
 * L'écran qui fait entrer un lot dans la chaîne spec → maquette → accept (L209) : `page` seul. `component` et `journey` restent des valeurs
 * valides du plan mais le lot suit le chemin ordinaire, sauf s'il est déjà entré dans la chaîne (une fiche à bloc `ecran` du lot, ou son
 * `acceptation-<lot>.json` à côté d'une fiche à bloc `ecran`, existent dans `dir`) : il garde alors sa fiche et son verrou.
 */
export function specScreen(repo: string, dir: string, lot: { id: string; screen?: Screen }): Screen | undefined {
  if (!lot.screen || lot.screen === 'page') return lot.screen;
  // Seul un bloc `ecran` compte : la fiche back (bloc `sujet`) et son acceptation sont ce qu'écrit la spec d'un lot `spec: true`.
  const acceptation = acceptationFile('fiche.yaml', lot.id);
  const entered = fichesDuDossier(repo, dir).some(({ name, doc }) => isObj(doc.ecran) && (doc.ecran.lot === lot.id || existsSync(join(repo, dir, name, acceptation))));
  return entered ? lot.screen : undefined;
}

/** Texte sans accents ni majuscules, pour les mots-clés. */
const plain = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Les quatre catégories de choix coûteux à défaire (spec etape-spec § 4), en mots-clés : modèle ou stockage de données,
 * contrat d'API ou route publiée, action destructive ou irréversible, règle qui en contredit une autre.
 * Garde-fou du programme : le jugement reste à l'agent, qui doit déjà avoir posé la question.
 */
const COSTLY: [string, RegExp][] = [
  ['modèle ou stockage de données', /modele de donnees|schema de donnees|stockage|migration|base de donnees|donnees? (utilisateur|creees?)/],
  ["contrat d'API ou route publiée", /contrat d'?api|api (publique?|partagee?)|endpoint (public|partage)|(route|url) (deja )?publiee?/],
  ['action destructive ou irréversible', /supprim|suppression|irreversible|destructi|paiement|(envoi|envoie)\b/],
  ['règle sourcée contredite', /contredit|contradiction/],
];

/** Un mot de négation, ses articles éventuels et le mot qu'il nie (« rien d'irréversible », « sans suppression », « pas de paiement »). */
const NEGATED = /\b(?:rien|aucune?|pas|sans|jamais)\s+(?:(?:d'|l'|de |du |des |d'un |d'une |un |une |le |la |les )\s*)*[\p{L}-]+/gu;

/** Règles `hypothese` dont `si_faux` relève d'un choix coûteux à défaire : une question, pas une hypothèse. */
export function costlyHypotheses(doc: unknown): { id: string; categorie: string; siFaux: string }[] {
  if (!isObj(doc)) return [];
  const out: { id: string; categorie: string; siFaux: string }[] = [];
  for (const r of list(doc.regles)) {
    if (r.statut !== 'hypothese' || typeof r.si_faux !== 'string') continue;
    const text = plain(r.si_faux).replace(/[’‘]/g, "'").replace(NEGATED, ' ');
    const hit = COSTLY.find(([, re]) => re.test(text));
    if (hit) out.push({ id: String(r.id), categorie: hit[0], siFaux: r.si_faux.trim() });
  }
  return out;
}

/** La fiche écrite porte une partie back (un bloc `sujet`) : c'est ce qui fait d'un lot à `screen:` un lot mixte (L188), jamais un champ `spec: true` à côté de `screen:`. */
export function ficheHasBack(repo: string, fiche: string): boolean {
  try {
    const doc = parse(readFileSync(join(repo, fiche), 'utf8'));
    return isObj(doc) && 'sujet' in doc;
  } catch {
    return false;
  }
}

/** Une fiche déjà écrite ne dispense de la spec que si elle passe les contrôles du programme et ne porte aucune hypothèse coûteuse. */
export function ficheReady(repo: string, fiche: string, lot: string, parts: FicheParts = { screen: true, back: false }): boolean {
  if (checkSpec(repo, fiche, lot, parts).length) return false;
  try {
    return costlyHypotheses(parse(readFileSync(join(repo, fiche), 'utf8'))).length === 0;
  } catch {
    return false;
  }
}

/** Une édition du texte de la fiche : les octets `[start, end[` deviennent `text`. */
type Edit = { start: number; end: number; text: string };

/** Début de la ligne qui contient l'offset. */
const lineStart = (text: string, at: number): number => text.lastIndexOf('\n', at - 1) + 1;

/** Fin de la ligne qui contient l'offset, saut de ligne compris (ou la fin du texte). */
const lineEnd = (text: string, at: number): number => {
  if (at > 0 && text[at - 1] === '\n') return at; // un scalaire bloc finit déjà en début de ligne
  const nl = text.indexOf('\n', at);
  return nl === -1 ? text.length : nl + 1;
};

/**
 * Passe en `sourcee` les règles `hypothese` nommées (L297) : `source` dit d'où vient la réponse, `si_faux` disparaît. Seules les lignes `statut`,
 * `source` et `si_faux` de ces règles sont éditées dans le texte (L302) : le reste de la fiche — ordre, commentaires, style de flux `[R2]` — est conservé
 * à l'octet près, ce qu'une réécriture du document (`doc.toString`) ne garantit pas. Une règle écrite en style de flux (`{id: R1, …}`) n'est pas éditée : erreur.
 * Rend les ids effectivement changés ; une règle absente ou déjà sourcée n'est pas touchée.
 */
export function sourceRules(repo: string, fiche: string, ids: string[], source: string): string[] {
  const file = join(repo, fiche);
  const text = readFileSync(file, 'utf8');
  const regles = parseDocument(text).get('regles');
  if (!isSeq(regles)) return [];
  const changed: string[] = [];
  const edits: Edit[] = [];
  const sourceValue = stringify(source).trimEnd();
  for (const r of regles.items) {
    if (!isMap(r)) continue;
    const id = String(r.get('id'));
    if (!ids.includes(id) || r.get('statut') !== 'hypothese') continue;
    if (r.flow) throw new Error(`${id} est écrite en style de flux (${fiche}) : à passer en sourcée à la main`);
    const pair = (key: string) => r.items.find((p) => isScalar(p.key) && p.key.value === key);
    const statut = pair('statut');
    const valueEnd = (p: NonNullable<typeof statut>) => (isNode(p.value) && p.value.range ? p.value.range[1] : (p.key as Node).range![1]);
    if (!statut || !isNode(statut.value) || !statut.value.range || !isNode(statut.key) || !statut.key.range) continue;
    edits.push({ start: statut.value.range[0], end: statut.value.range[1], text: 'sourcee' });
    const src = pair('source');
    if (src && isNode(src.value) && src.value.range) edits.push({ start: src.value.range[0], end: src.value.range[1], text: sourceValue });
    else {
      const at = lineEnd(text, valueEnd(statut));
      const indent = ' '.repeat(statut.key.range[0] - lineStart(text, statut.key.range[0]));
      edits.push({ start: at, end: at, text: `${at > 0 && text[at - 1] !== '\n' ? '\n' : ''}${indent}source: ${sourceValue}\n` });
    }
    const siFaux = pair('si_faux');
    if (siFaux && isNode(siFaux.key) && siFaux.key.range) edits.push({ start: lineStart(text, siFaux.key.range[0]), end: lineEnd(text, valueEnd(siFaux)), text: '' });
    changed.push(id);
  }
  if (!changed.length) return changed;
  let out = text;
  for (const e of edits.sort((x, y) => y.start - x.start || y.end - x.end)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  writeFileSync(file, out);
  return changed;
}

/**
 * La réponse du lead corrige-t-elle la règle (la supprime, la change, la remplace) au lieu de la confirmer ? Une lecture prudente (L302) : au moindre
 * mot de correction ou de refus, la règle n'est pas passée en `sourcee` telle quelle, la session spec reprise l'applique. Se tromper dans ce sens
 * ne coûte qu'une session ; l'autre sens source une règle que le lead vient de refuser.
 */
export function answerAltersRule(answer: string): boolean {
  return /(?<![\p{L}])(non|no|pas|supprim\p{L}*|retir\p{L}*|enl[eè]v\p{L}*|abandonn\p{L}*|chang\p{L}*|modifi\p{L}*|remplac\p{L}*|corrig\p{L}*|plut[oô]t|à la place|sauf|remove|delet\p{L}*|drop|change|replace\p{L}*|instead|rather|except)(?![\p{L}])/iu.test(answer);
}

/** Les règles nommées que la fiche donne déjà pour sourcées par la réponse du lead (ce que `sourceRules` a posé). */
export function ruleIdsSourcedByLead(repo: string, fiche: string, ids: string[]): string[] {
  try {
    const doc = parse(readFileSync(join(repo, fiche), 'utf8'));
    return list(isObj(doc) ? doc.regles : []).filter((r) => ids.includes(String(r.id)) && r.statut === 'sourcee' && String(r.source).startsWith(LEAD_SOURCE)).map((r) => String(r.id));
  } catch {
    return [];
  }
}

/** Début de la source d'une règle tranchée par le lead : `réponse du lead, <date>, vague <id>`. */
export const LEAD_SOURCE = 'réponse du lead';

/**
 * Consigne de reprise après la réponse du lead à des hypothèses coûteuses. Les règles que le programme a déjà passées en `sourcee` (`sourced`) ne sont plus à
 * réécrire que si le lead les a corrigées ; les autres, l'agent les passe lui-même.
 */
export function answeredText(asked: string[], answer: string, sourced: string[] = []): string {
  return [
    'The program asked the lead about expensive-to-undo hypotheses of your sheet:',
    ...asked.map((q) => `- ${q}`),
    `Answer from the lead: ${answer}`,
    sourced.length
      ? `The program already set ${sourced.join(', ')} to \`statut: sourcee\` with the lead's answer as its \`source\` (no \`si_faux\`). Touch the sheet only if the lead corrected a rule: rewrite its \`enonce\` as they say and keep the \`sourcee\` status and the \`source\`. Do not turn it back into a \`hypothese\`.`
      : 'Apply it to the sheet: a rule the lead confirms becomes `statut: sourcee` with `source: réponse du lead` (no `si_faux`); a rule the lead corrects is rewritten as they say (`sourcee`, same source). Do not leave it as `hypothese`, or the program asks the same question again.',
  ].join('\n');
}

/** Fichiers suivis par git sous un dossier (chemins relatifs au dépôt). */
function tracked(repo: string, dir: string): Set<string> {
  try {
    return new Set(execFileSync('git', ['ls-files', '-z', '--', dir], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Les parties que la fiche du lot doit avoir : `screen` (lot à `screen:`) et `back` (lot à `spec: true`, ou mixte). */
export interface FicheParts {
  screen: boolean;
  back: boolean;
}

/**
 * Les écarts de la spec écrite par la session, relevés par le programme (vide = acceptée) : la fiche passe `cadence spec check`,
 * elle est celle du lot et de son dossier, la maquette existe avec une section `#etat-<état>` par état et un
 * `data-testid` par champ, et chaque état a sa capture à chaque largeur — le tout commité.
 */
export function checkSpec(repo: string, fiche: string, lot: string, parts: FicheParts = { screen: true, back: false }): string[] {
  const file = join(repo, fiche);
  if (!existsSync(file)) return [`${fiche} : fiche absente (écrire ${fiche.replace(/[^/]+\/fiche\.yaml$/, parts.screen ? '<écran>' : '<sujet>')}/fiche.yaml et la commiter)`];
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return [`${fiche} : YAML illisible (${(e as Error).message.split('\n')[0]})`];
  }
  const problems = checkFiche(doc).map((p) => `fiche : ${p}`);
  if (!isObj(doc)) return problems;
  const folder = fiche.replace(/\/fiche\.yaml$/, '');
  // un lot back (`spec: true`, avec ou sans écran) écrit la partie sujet : sans elle, ni lot ni dossier ne seraient contrôlés
  if (parts.back) {
    if (!isObj(doc.sujet)) {
      if (!('sujet' in doc) && 'ecran' in doc) problems.push('fiche : sujet : bloc manquant (un lot qui change un comportement écrit la partie sujet, même si la fiche a aussi un écran)');
    } else {
      const sujet = doc.sujet;
      if (typeof sujet.lot === 'string' && sujet.lot !== lot) problems.push(`sujet.lot : « ${sujet.lot} » au lieu de ${lot} (la fiche est celle du lot qui implémente le comportement)`);
      if (typeof sujet.id === 'string' && !folder.endsWith(`/${sujet.id}`)) problems.push(`sujet.id : « ${sujet.id} » ne correspond pas au dossier ${folder}`);
      if (!parts.screen && !tracked(repo, folder).has(fiche)) problems.push(`${fiche} : fiche non commité`);
    }
  }
  if (!parts.screen) return problems;
  // un lot à écran écrit la partie écran : sans elle, ni lot, ni dossier, ni maquette, ni captures ne seraient contrôlés
  if (!isObj(doc.ecran)) return [...problems.filter((p) => p !== 'fiche : ecran : bloc manquant'), 'fiche : ecran : bloc manquant (un lot à écran écrit la partie écran, même si la fiche a aussi un sujet)'];
  const ecran = doc.ecran;
  if (typeof ecran.lot === 'string' && ecran.lot !== lot) problems.push(`ecran.lot : « ${ecran.lot} » au lieu de ${lot} (la fiche est celle du lot qui implémente l'écran)`);
  if (typeof ecran.id === 'string' && !folder.endsWith(`/${ecran.id}`)) problems.push(`ecran.id : « ${ecran.id} » ne correspond pas au dossier ${folder}`);
  const maquette = `${folder}/maquette.html`;
  if (typeof ecran.maquette === 'string' && ecran.maquette !== maquette) problems.push(`ecran.maquette : « ${ecran.maquette} » au lieu de ${maquette}`);
  const git = tracked(repo, folder);
  const need = (path: string, what: string) => {
    if (!existsSync(join(repo, path))) problems.push(`${path} : ${what} absent`);
    else if (!git.has(path)) problems.push(`${path} : ${what} non commité`);
  };
  need(fiche, 'fiche');
  need(maquette, 'maquette');
  const html = existsSync(join(repo, maquette)) ? readFileSync(join(repo, maquette), 'utf8') : '';
  const etats = Array.isArray(doc.etats) ? doc.etats.filter((e): e is string => typeof e === 'string' && e.trim() !== '') : [];
  if (html) {
    for (const e of etats) if (!new RegExp(`\\bid=["']etat-${e}["']`).test(html)) problems.push(`maquette.html : section id="etat-${e}" absente`);
    for (const c of list(doc.champs)) if (typeof c.id === 'string' && !new RegExp(`data-testid=["']${c.id}["']`).test(html)) problems.push(`maquette.html : data-testid="${c.id}" absent (chaque champ de la fiche le porte)`);
  }
  for (const e of etats) for (const w of LARGEURS) need(`${folder}/maquette-${e}-${w}.png`, 'capture');
  return problems;
}

/** Première phrase d'un texte, ramenée à une longueur lisible dans une note. */
const sentence = (t: string, max = 160): string => {
  const flat = t.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const first = end > 0 ? flat.slice(0, end) : flat;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
};

/** Une ligne par règle `hypothese` de la fiche (`R3 : ce que la règle dit ; si faux : ce qui changerait`), pour la note du lot et le tableau de fin de vague (spec etape-spec-back § 7). */
export function hypothesisLines(doc: unknown): string[] {
  if (!isObj(doc)) return [];
  return list(doc.regles)
    .filter((r) => r.statut === 'hypothese' && typeof r.id === 'string')
    .map((r) => `${String(r.id)} : ${sentence(String(r.enonce ?? ''))} ; si faux : ${sentence(String(r.si_faux ?? ''))}`);
}

/** Texte de la note du lot pour une hypothèse (une note par règle). */
export const hypothesisNote = (sujet: string, line: string): string => `Hypothèses (fiche ${sujet}) — ${line}`;

/** Consigne propre à l'étape spec dans le brief : dossier, largeurs, commande de rendu, et les écarts de la passe précédente. */
export function specText(o: { dir: string; render?: string; screen?: string; back?: boolean; problems?: string[]; review?: string; template?: string; templateBack?: string }): string {
  const lines: string[] = [];
  if (o.screen) {
    lines.push(
      `The lot declares \`screen: ${o.screen}\`. The specs of this project live in \`${o.dir}/<écran>/\` (one folder per screen, \`<écran>\` = the kebab-case \`ecran.id\` of the sheet).`,
      `Render each state of the mockup at ${LARGEURS.map((w) => `${w}`).join(' and ')} px width: one capture per state and per width, named \`maquette-<état>-<largeur>.png\` (e.g. \`maquette-vide-1440.png\`).`,
      o.render
        ? `The project declares how to render mockups (\`orchestrate.spec.render\`): \`${o.render}\` (from the repository root). Use it; fall back on Playwright only if it cannot run, and say so under "nonVerifie".`
        : 'No render command is declared (`orchestrate.spec.render`): render with Playwright (open `maquette.html` as a local file, resize to each width, open each `#etat-<état>`).',
    );
  }
  if (o.back) {
    lines.push(
      o.screen
        ? `The sheet has both parts, \`sujet\`, \`cas\`, \`contrats\`, \`donnees\` next to \`ecran\`, in the same folder (\`sujet.id\` = \`ecran.id\` = the folder name, \`sujet.lot\` = \`ecran.lot\`); the API calls of the screen are listed once in \`contrats\`, and the actions point to them with \`contrat: Ax\`.`
        : `The lot declares \`spec: true\` (it changes a behaviour, with no screen). The specs of this project live in \`${o.dir}/<sujet>/\` (one folder per subject, \`<sujet>\` = the kebab-case \`sujet.id\` of the sheet); the sheet has no screen part.`,
    );
  }
  if (o.screen && !o.back) {
    lines.push(
      `If the lot also changes a behaviour (an API call, a stored datum, a contract), add the back part to the same sheet: \`sujet\`, \`cas\`, \`contrats\`, \`donnees\` next to \`ecran\` (\`sujet.id\` = \`ecran.id\` = the folder name, \`sujet.lot\` = \`ecran.lot\`); the program then also has the sheet reviewed (rules sourced, contradictions, errors and limits, one test per rule), before the mockup. A lot that only draws a screen keeps a sheet without \`sujet\`.`,
    );
  }
  if (o.template) lines.push('', 'Template of the screen part of the sheet (`templates/fiche.yaml` of cadence; every key and invariant is checked by `cadence spec check`):', '```yaml', o.template.trimEnd(), '```');
  if (o.templateBack) lines.push('', 'Template of the back part of the sheet (`templates/fiche-back.yaml` of cadence; every key and invariant is checked by `cadence spec check`):', '```yaml', o.templateBack.trimEnd(), '```');
  if (o.problems?.length) lines.push('', 'The program checked your previous spec and it did not pass; fix exactly these points (one more pass only, then the lot goes back to the lead):', ...o.problems.map((p) => `- ${p}`));
  if (o.review) lines.push('', o.review);
  return lines.join('\n');
}
