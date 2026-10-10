import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { checkFiche, LARGEURS } from '../spec.js';

// Étape spec d'orchestrate (L171, spec etape-spec S3) : ce que le programme sait de la sortie de la session `spec`.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** Chemin (relatif au dépôt) de la fiche du lot sous `<dir>/<écran>/fiche.yaml`, ou null : sert à ne pas rejouer une spec déjà écrite. */
export function findFiche(repo: string, dir: string, lot: string): string | null {
  const root = join(repo, dir);
  if (!existsSync(root)) return null;
  for (const name of readdirSync(root).sort()) {
    const file = join(root, name, 'fiche.yaml');
    if (!existsSync(file)) continue;
    try {
      const doc = parse(readFileSync(file, 'utf8')) as unknown;
      if (isObj(doc) && isObj(doc.ecran) && doc.ecran.lot === lot) return `${dir}/${name}/fiche.yaml`;
    } catch {
      // fiche illisible : elle n'est pas « déjà écrite », la session la reprendra
    }
  }
  return null;
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

/** Règles `hypothese` dont `si_faux` relève d'un choix coûteux à défaire : une question, pas une hypothèse. */
export function costlyHypotheses(doc: unknown): { id: string; categorie: string; siFaux: string }[] {
  if (!isObj(doc)) return [];
  const out: { id: string; categorie: string; siFaux: string }[] = [];
  for (const r of list(doc.regles)) {
    if (r.statut !== 'hypothese' || typeof r.si_faux !== 'string') continue;
    const text = plain(r.si_faux).replace(/[’‘]/g, "'");
    const hit = COSTLY.find(([, re]) => re.test(text));
    if (hit) out.push({ id: String(r.id), categorie: hit[0], siFaux: r.si_faux.trim() });
  }
  return out;
}

/** Une fiche déjà écrite ne dispense de la spec que si elle passe les contrôles du programme et ne porte aucune hypothèse coûteuse. */
export function ficheReady(repo: string, fiche: string, lot: string): boolean {
  if (checkSpec(repo, fiche, lot).length) return false;
  try {
    return costlyHypotheses(parse(readFileSync(join(repo, fiche), 'utf8'))).length === 0;
  } catch {
    return false;
  }
}

/** Consigne de reprise après la réponse du lead à des hypothèses coûteuses : la règle confirmée n'est plus une hypothèse. */
export function answeredText(asked: string[], answer: string): string {
  return [
    'The program asked the lead about expensive-to-undo hypotheses of your sheet:',
    ...asked.map((q) => `- ${q}`),
    `Answer from the lead: ${answer}`,
    'Apply it to the sheet: a rule the lead confirms becomes `statut: sourcee` with `source: réponse du lead` (no `si_faux`); a rule the lead corrects is rewritten as they say (`sourcee`, same source). Do not leave it as `hypothese`, or the program asks the same question again.',
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

/**
 * Les écarts de la spec écrite par la session, relevés par le programme (vide = acceptée) : la fiche passe `cadence spec check`,
 * elle est celle du lot et de son dossier, la maquette existe avec une section `#etat-<état>` par état et un
 * `data-testid` par champ, et chaque état a sa capture à chaque largeur — le tout commité.
 */
export function checkSpec(repo: string, fiche: string, lot: string): string[] {
  const file = join(repo, fiche);
  if (!existsSync(file)) return [`${fiche} : fiche absente (écrire docs/specs/<écran>/fiche.yaml et la commiter)`];
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return [`${fiche} : YAML illisible (${(e as Error).message.split('\n')[0]})`];
  }
  const problems = checkFiche(doc).map((p) => `fiche : ${p}`);
  if (!isObj(doc) || !isObj(doc.ecran)) return problems;
  const folder = fiche.replace(/\/fiche\.yaml$/, '');
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

/** Consigne propre à l'étape spec dans le brief : dossier, largeurs, commande de rendu, et les écarts de la passe précédente. */
export function specText(o: { dir: string; render?: string; screen?: string; problems?: string[]; template?: string }): string {
  const lines = [
    `The lot declares \`screen: ${o.screen ?? 'page'}\`. The specs of this project live in \`${o.dir}/<écran>/\` (one folder per screen, \`<écran>\` = the kebab-case \`ecran.id\` of the sheet).`,
    `Render each state of the mockup at ${LARGEURS.map((w) => `${w}`).join(' and ')} px width: one capture per state and per width, named \`maquette-<état>-<largeur>.png\` (e.g. \`maquette-vide-1440.png\`).`,
    o.render
      ? `The project declares how to render mockups (\`orchestrate.spec.render\`): \`${o.render}\` (from the repository root). Use it; fall back on Playwright only if it cannot run, and say so under "nonVerifie".`
      : 'No render command is declared (`orchestrate.spec.render`): render with Playwright (open `maquette.html` as a local file, resize to each width, open each `#etat-<état>`).',
  ];
  if (o.template) lines.push('', 'Template of the sheet (`templates/fiche.yaml` of cadence; every key and invariant is checked by `cadence spec check`):', '```yaml', o.template.trimEnd(), '```');
  if (o.problems?.length) lines.push('', 'The program checked your previous spec and it did not pass; fix exactly these points (one more pass only, then the lot goes back to the lead):', ...o.problems.map((p) => `- ${p}`));
  return lines.join('\n');
}
