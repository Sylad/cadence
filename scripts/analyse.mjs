// Analyse statique par techno (L801, D-23) : l'étape « analyse » de la porte de cadence run, déclarée par la clé `analyse:` de cadence.yaml.
// Une commande par outil (ESLint typé, tsc --noEmit, ruff, Checkstyle, PMD, CPD, SpotBugs, analyseurs .NET en SARIF…) ; son rapport est lu par un
// lecteur de format (`fichier|règle → nombre`), puis jugé par un cliquet générique : une ligne de base par outil, versionnée ; seules les nouvelles
// violations font échouer ; une baisse s'écrit (--ecrire), une hausse jamais. Le cliquet réutilise celui de scripts/qualite.mjs (L462 : comparer,
// comparerMigration, creerLien, lireRef, remontees, neufsAuDessus), qui reste celui du code de cadence lui-même, et la règle des lots « config: true » de
// scripts/lot-de-config.mjs (configChangee), commune aux deux. Rien de propre à un dépôt : la recette est dans docs/analyse.md.
// JavaScript sans dépendance, comme scripts/regeneration.mjs : src et v2 l'importent hors de leur rootDir. Il lit la valeur déjà analysée (pas de yaml ici).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configChangee, differences, fichiersDifferents, planNatif } from './lot-de-config.mjs';
import { comparer, comparerMigration, creerLien, ligne, lireEslint, lireRef, neufsAuDessus, remontees, retardSurBranche, serialiser } from './qualite.mjs';

/** Le chemin de ce script : la porte de cadence run le lance par lui (`node <script> --contre <cible>`). */
export const SCRIPT = fileURLToPath(import.meta.url);
export const DOSSIER_BASES = '.cadence/analyse';
const DELAI_OUTIL = 20 * 60_000;

// ── la clé analyse: de cadence.yaml ─────────────────────────────────────────────────────────────────────────────────────────────

const CLES = ['name', 'command', 'format', 'dir', 'report', 'baseline', 'configs'];
const estObjet = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const texte = (v) => typeof v === 'string' && v.trim() !== '';

/** Un chemin relatif au dépôt, sans sortie par « .. » ; « . » est la racine. */
function relatif(v, ou) {
  if (!texte(v)) throw new Error(`${ou} : chemin relatif au dépôt attendu`);
  const d = v.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '.';
  if (d.startsWith('/') || /^[A-Za-z]:/.test(d) || d.startsWith('~') || d.split('/').includes('..'))
    throw new Error(`${ou} : « ${v} » sort du dépôt (chemin relatif au dépôt attendu, sans « .. »)`);
  return posix.normalize(d);
}

/**
 * `valeur` : ce que le YAML donne sous `analyse:` (undefined ou null quand la clé manque). Rend la liste des outils
 * `{ name, command, format, dir, report?, baseline, configs }`, vide sans la clé ; une forme mal formée lève une Error dont le message commence par
 * `fichier : ` et nomme la clé fautive (cadence run et la validation de cadence.yaml, src/config-set.ts, lisent par ce même code).
 */
export function lireAnalyse(valeur, fichier) {
  if (valeur == null) return [];
  try {
    if (!Array.isArray(valeur) || !valeur.length) throw new Error('analyse : liste non vide de { name, command, format } attendue');
    const noms = new Set();
    return valeur.map((e, i) => lireOutil(e, `analyse[${i}]`, noms));
  } catch (e) {
    throw new Error(`${fichier} : ${e.message}`);
  }
}

/** Les clés obligatoires d'une entrée (`ou` : « analyse[i] ») ; `noms` : ceux des entrées déjà lues. */
function controler(e, ou, noms) {
  if (!estObjet(e)) throw new Error(`${ou} : objet { name, command, format } attendu`);
  for (const k of Object.keys(e)) if (!CLES.includes(k)) throw new Error(`${ou}.${k} inconnu (attendu : ${CLES.join(', ')})`);
  if (typeof e.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(e.name)) throw new Error(`${ou}.name : nom en minuscules, chiffres et tirets attendu (il nomme la ligne de base)`);
  if (noms.has(e.name)) throw new Error(`${ou}.name : « ${e.name} » déjà pris par un autre outil`);
  noms.add(e.name);
  if (!texte(e.command)) throw new Error(`${ou}.command : commande non vide attendue`);
  if (!Object.hasOwn(LECTEURS, e.format)) throw new Error(`${ou}.format : « ${e.format} » inconnu (attendu : ${Object.keys(LECTEURS).join(', ')})`);
  if (e.configs != null && (!Array.isArray(e.configs) || !e.configs.length)) throw new Error(`${ou}.configs : liste non vide de chemins attendue`);
}

/** Une entrée de `analyse:`, contrôlée, avec ses défauts. */
function lireOutil(e, ou, noms) {
  controler(e, ou, noms);
  return {
    name: e.name, command: e.command.trim(), format: e.format,
    dir: e.dir == null ? '.' : relatif(e.dir, `${ou}.dir`),
    ...(e.report == null ? {} : { report: relatif(e.report, `${ou}.report`) }),
    baseline: e.baseline == null ? `${DOSSIER_BASES}/${e.name}.json` : relatif(e.baseline, `${ou}.baseline`),
    configs: (e.configs ?? []).map((c, j) => relatif(c, `${ou}.configs[${j}]`)),
  };
}

// ── les lecteurs de rapport : texte du rapport → `fichier|règle` → nombre ──────────────────────────────────────────────────────

const ajouter = (m, cle, n = 1) => { m[cle] = (m[cle] ?? 0) + n; };
/** Un chemin du rapport, relatif à la racine du dépôt : URL file:, absolu, ou relatif au dossier de l'outil. */
function cheminDuRapport(racine, dir, p) {
  const brut = p.startsWith('file:') ? fileURLToPath(p) : p;
  const abs = isAbsolute(brut) ? brut : join(racine, dir, brut);
  return relative(racine, abs).split('\\').join('/');
}
const entites = (s) => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (_, n, d, h) => (d ? String.fromCodePoint(Number(d)) : h ? String.fromCodePoint(parseInt(h, 16))
  : { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[n.toLowerCase()]));
const attribut = (balise, nom) => { const m = new RegExp(`\\b${nom}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(balise); return m ? entites(m[1] ?? m[2]) : undefined; };
/** Exige un rapport XML dont la racine est `racineXml` : un rapport tronqué ou d'un autre outil n'est jamais lu comme « zéro violation ». */
function xml(texteXml, racineXml) {
  if (!new RegExp(`<${racineXml}\\b`).test(texteXml) || !new RegExp(`(</${racineXml}>|<${racineXml}\\b[^>]*/>)\\s*$`).test(texteXml.trim()))
    throw new Error(`rapport XML illisible (élément <${racineXml}> absent ou non fermé)`);
  return texteXml;
}
/** Les blocs `<file name="…">…</file>` (Checkstyle, PMD) : chaque élément `enfant` du bloc compte sous l'attribut `regle`. */
function parFichier(texteXml, racine, dir, enfant, regle) {
  const m = {};
  for (const [, ouvre, corps] of texteXml.matchAll(/<file\b([^>]*?)(?:\/>|>([\s\S]*?)<\/file>)/g)) {
    const f = cheminDuRapport(racine, dir, attribut(ouvre, 'name') ?? '');
    for (const [b] of (corps ?? '').matchAll(new RegExp(`<${enfant}\\b[^>]*>`, 'g'))) ajouter(m, `${f}|${regle(b)}`);
  }
  return m;
}
const json = (t) => { try { return JSON.parse(t); } catch (e) { throw new Error(`rapport JSON illisible (${e.message.split('\n')[0]})`); } };

/** Chaque lecteur : (texte du rapport, racine du dépôt, dossier de l'outil, code de sortie) → mesure. Une forme inattendue lève : jamais « zéro ». */
export const LECTEURS = {
  // ESLint (`-f json`) : le lecteur de scripts/qualite.mjs, avec la somme des chiffres mesurés (`|total`) : une fonction qui grossit sans nouvelle violation se voit
  'eslint-json': (t, racine) => {
    const j = json(t);
    if (!Array.isArray(j)) throw new Error('rapport ESLint illisible (liste attendue : eslint -f json)');
    return Object.fromEntries(Object.entries(lireEslint(j, racine)).map(([k, n]) => [k.slice('eslint|'.length), n]));
  },
  // tsc --noEmit --pretty false : « fichier(l,c): error TS1234: … » ; une erreur sans fichier (TS5023…) compte sous « (global) »
  tsc: (t, racine, dir, code) => {
    const m = {};
    for (const l of t.split('\n')) {
      const f = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/.exec(l) ?? /^(.+?):(\d+):(\d+) - error (TS\d+):/.exec(l);
      const g = f ? null : /^error (TS\d+):/.exec(l.trim());
      if (f) ajouter(m, `${cheminDuRapport(racine, dir, f[1])}|${f[4]}`);
      else if (g) ajouter(m, `(global)|${g[1]}`);
    }
    if (code !== 0 && !Object.keys(m).length) throw new Error(`tsc a échoué (code ${code}) sans erreur lisible : ${t.slice(0, 300)}`);
    return m;
  },
  // ruff check --output-format json : [{ filename, code }] (code nul : erreur de syntaxe)
  'ruff-json': (t, racine, dir) => {
    const j = json(t);
    if (!Array.isArray(j)) throw new Error('rapport ruff illisible (liste attendue : ruff check --output-format json)');
    const m = {};
    for (const v of j) ajouter(m, `${cheminDuRapport(racine, dir, v.filename)}|${v.code ?? 'syntax-error'}`);
    return m;
  },
  // Checkstyle (target/checkstyle-result.xml, et tout outil au format checkstyle) : la règle est le dernier segment de `source`, sans « Check »
  'checkstyle-xml': (t, racine, dir) => parFichier(xml(t, 'checkstyle'), racine, dir, 'error', (b) => (attribut(b, 'source') ?? 'inconnue').split('.').at(-1).replace(/Check$/, '')),
  // PMD (target/pmd.xml) : <violation rule="…">
  'pmd-xml': (t, racine, dir) => parFichier(xml(t, 'pmd'), racine, dir, 'violation', (b) => attribut(b, 'rule') ?? 'inconnue'),
  // CPD (target/cpd.xml) : par fichier, les blocs dupliqués qui le touchent et leurs lignes (`|lignes`), comme jscpd dans scripts/qualite.mjs
  'cpd-xml': (t, racine, dir) => {
    const m = {};
    for (const [, ouvre, corps] of xml(t, 'pmd-cpd').matchAll(/<duplication\b([^>]*)>([\s\S]*?)<\/duplication>/g)) {
      for (const [b] of corps.matchAll(/<file\b[^>]*>/g)) {
        const f = cheminDuRapport(racine, dir, attribut(b, 'path') ?? '');
        ajouter(m, `${f}|duplication`);
        ajouter(m, `${f}|duplication|lignes`, Number(attribut(ouvre, 'lines') ?? 0));
      }
    }
    return m;
  },
  // SpotBugs (target/spotbugsXml.xml) : <BugInstance type="…"> et son premier <SourceLine sourcepath="…"> (chemin relatif à la racine des sources, gardé tel quel)
  'spotbugs-xml': (t) => {
    const m = {};
    for (const [, ouvre, corps] of xml(t, 'BugCollection').matchAll(/<BugInstance\b([^>]*)>([\s\S]*?)<\/BugInstance>/g)) {
      const ligne = /<SourceLine\b[^>]*>/.exec(corps)?.[0];
      ajouter(m, `${(ligne && attribut(ligne, 'sourcepath')) ?? '(inconnu)'}|${attribut(ouvre, 'type') ?? 'inconnue'}`);
    }
    return m;
  },
  // SARIF 2.1 (analyseurs .NET : dotnet build -p:ErrorLog=…,version=2.1 ; Semgrep, CodeQL…) : chaque résultat, supprimé ou non (une suppression ne fait pas baisser)
  sarif: (t, racine, dir) => {
    const j = json(t);
    if (!Array.isArray(j?.runs)) throw new Error('rapport SARIF illisible (runs absent)');
    const m = {};
    for (const run of j.runs) {
      for (const r of run.results ?? []) {
        const uri = r.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
        ajouter(m, `${uri ? cheminDuRapport(racine, dir, decodeURI(uri)) : '(global)'}|${r.ruleId ?? r.rule?.id ?? 'inconnue'}`);
      }
    }
    return m;
  },
};

// ── les directives qui éteignent une règle au lieu de corriger : comptées par fichier, une de plus empire comme une violation ──────────────

const JS = /\.(?:[cm]?[jt]sx?)$/;
const JAVA = /\.java$/;
// `@SuppressWarnings("all")` éteint toutes les règles de PMD et de Checkstyle (SuppressWarningsHolder) : il compte pour l'un comme pour l'autre
const TOUT = String.raw`@SuppressWarnings\([^)]*"[aA][lL][lL]"`;
/**
 * Par format : les fichiers lus (git ls-files sous le dossier de l'outil, filtrés par extension) et les motifs comptés, chacun sous `directive:<nom>`.
 * Chaque motif suit la façon dont l'outil lui-même reconnaît sa directive, quelle que soit la mise en forme du commentaire (revue L801 r2, M3'), et compte
 * plutôt trop que pas assez (un `/** … *\/` que l'outil n'honore pas compte aussi) :
 * - ESLint (shared/directives.js, plugin-kit parseDirective) : le texte du commentaire, blancs et sauts de ligne de tête ôtés, commence par la directive ;
 *   sous `//`, seules -line et -next-line valent. Donc `/*`, puis blancs, sauts de ligne ou `*`, puis la directive.
 * - tsc (scanner : commentDirectiveRegExSingleLine et …MultiLine) : `//` puis la directive, ou la DERNIÈRE ligne d'un commentaire bloc, qui commence par elle
 *   après des `/`, des `*` et des blancs — quel que soit le texte des lignes d'avant. Donc toute ligne qui commence ainsi, et tout `//` ou `/*` qui la porte.
 */
const DIRECTIVES = {
  'eslint-json': [JS, {
    'eslint-disable': /\/(?:\/[ \t]*|\*[\s*]*)eslint-disable/g,
    // la config en ligne, `/* eslint règle: off */` (ou un seuil relevé, un nom de règle entre guillemets), éteint une règle sans dire « disable »
    'eslint-config': /\/\*[\s*]*eslint\s+[^\s*]/g,
    // `/* global x */` éteint no-undef pour x, `/* exported x */` no-unused-vars : des extinctions par déclaration
    'eslint-global': /\/\*[\s*]*(?:globals?|exported)\s+[^\s*]/g,
  }],
  tsc: [JS, { 'ts-ignore': /(?:^|\/[/*])[\s/*]*@ts-(?:ignore|nocheck|expect-error)/gm }],
  // `# noqa`, et les formes de fichier ou de plage : `# ruff: noqa`, `# flake8: noqa` (que ruff honore), `# ruff: disable[…]`
  'ruff-json': [/\.pyi?$/, { noqa: /#[ \t]*(?:noqa|(?:ruff|flake8):[ \t]*(?:noqa|disable))\b/gi }],
  'checkstyle-xml': [JAVA, { 'checkstyle-off': new RegExp(String.raw`CHECKSTYLE[ \t]*:?[ \t]*OFF|@SuppressWarnings\([^)]*checkstyle:|${TOUT}`, 'gi') }],
  // NOPMD : le marqueur de PMD, dans un commentaire `//` ou `/* */`, où qu'il soit sur la ligne
  'pmd-xml': [JAVA, { nopmd: new RegExp(String.raw`\bNOPMD\b|@SuppressWarnings\([^)]*PMD|${TOUT}`, 'g') }],
  'cpd-xml': [JAVA, { 'cpd-off': /CPD-OFF/g }],
  'spotbugs-xml': [JAVA, { 'suppress-fb': /@SuppressFBWarnings\b/g }],
  sarif: [/\.(?:cs|vb)$/, { 'pragma-warning': /#pragma[ \t]+warning[ \t]+disable|\[(?:assembly:[ \t]*)?SuppressMessage\b/g }],
};

/** Les directives du format dans les fichiers suivis par git sous `dir` : `fichier|directive:<nom>` → occurrences. */
export function lireDirectives(racine, dir, format) {
  const [extension, motifs] = DIRECTIVES[format];
  const r = spawnSync('git', ['ls-files', '-z', '--', dir], { cwd: racine, encoding: 'utf8', maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(`git ls-files a échoué dans ${racine} : ${r.stderr?.trim() || r.error?.message}`);
  const m = {};
  for (const f of r.stdout.split('\0').filter((x) => extension.test(x) && existsSync(join(racine, x)))) {
    const t = readFileSync(join(racine, f), 'utf8');
    for (const [nom, re] of Object.entries(motifs)) { const n = t.match(re)?.length ?? 0; if (n) ajouter(m, `${f}|directive:${nom}`, n); }
  }
  return m;
}

// ── mesure : joue l'outil, lit son rapport ─────────────────────────────────────────────────────────────────────────────────────

const trier = (m) => Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Joue l'outil dans son dossier et rend sa mesure (violations et directives). Lève si l'outil ne rend aucun rapport lisible : jamais « zéro violation ». */
export function mesurerOutil(racine, outil) {
  const cwd = join(racine, outil.dir);
  if (!existsSync(cwd)) throw new Error(`${outil.name} : dossier absent : ${outil.dir}`);
  const rapport = outil.report && join(cwd, outil.report);
  if (rapport) rmSync(rapport, { force: true }); // un rapport d'une passe précédente ne compte jamais pour celle-ci
  const r = spawnSync('bash', ['-c', outil.command], { cwd, encoding: 'utf8', timeout: DELAI_OUTIL, maxBuffer: 256 << 20 });
  if (r.error || r.status === null) throw new Error(`${outil.name} : « ${outil.command} » n'a pas fini (${r.error?.message ?? `signal ${r.signal}`})`);
  if (rapport && !existsSync(rapport)) throw new Error(`${outil.name} : « ${outil.command} » (code ${r.status}) n'a pas écrit son rapport ${join(outil.dir, outil.report)} : ${`${r.stderr}${r.stdout}`.trim().slice(-500)}`);
  const t = rapport ? readFileSync(rapport, 'utf8') : r.stdout;
  try {
    return trier({ ...LECTEURS[outil.format](t, racine, outil.dir, r.status), ...lireDirectives(racine, outil.dir, outil.format) });
  } catch (e) {
    throw new Error(`${outil.name} : ${e.message} — « ${outil.command} » (code ${r.status}) ; stderr : ${r.stderr.trim().slice(-300) || '(vide)'}`);
  }
}

// ── le cliquet ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const total = (m) => Object.entries(m).filter(([k]) => !k.endsWith('|total') && !k.endsWith('|lignes')).reduce((a, [, n]) => a + n, 0);
// les clés d'un outil vues par le cliquet de scripts/qualite.mjs (`outil|fichier|règle`) : « analyse » n'est ni « eslint » ni « jscpd », aucune n'est un simple compteur
const versQualite = (m) => Object.fromEntries(Object.entries(m).map(([k, n]) => [`analyse|${k}`, n]));
const deQualite = (cle) => cle.replace(/^analyse\|/, '');
const lireJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const ecrire = (f, m) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, serialiser(m)); };

/**
 * Ce que les commits du lot déclarent par une ligne `<cle>: <outil>[, <outil>…]` de leur message, depuis le départ (`contre..HEAD`) : nom d'outil → sha court
 * du commit qui le déclare. Le message reste dans l'historique (un run intègre en fast-forward) : `git log --grep '^Analyse-adoption:'` liste les adoptions
 * d'un dépôt, `--grep '^Analyse-config:'` ses changements de config déclarés.
 */
function declarations(racine, contre, cle) {
  const r = spawnSync('git', ['log', '--format=%h%x00%B%x01', `${contre}..HEAD`], { cwd: racine, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`git log ${contre}..HEAD a échoué : ${r.stderr?.trim() || r.error?.message}`);
  const m = new Map();
  for (const bloc of r.stdout.split('\x01')) {
    const [sha, message = ''] = bloc.trim().split('\0');
    for (const [, noms] of message.matchAll(new RegExp(`^${cle}:[ \\t]*(.+)$`, 'gim'))) for (const n of noms.split(/[\s,]+/).filter(Boolean)) if (!m.has(n)) m.set(n, sha);
  }
  return m;
}
/**
 * Ce que les commits du lot déclarent : `adoptions` (revue L801 r2, M1' : `Analyse-adoption: <outil>`, une ligne de base qui naît dans un lot ordinaire) et
 * `configs` (revue L801 r3, M3 : `Analyse-config: <outil>`, la voie d'un projet sans plan natif, où aucun lot n'est `config: true`).
 */
export const declarationsDuLot = (racine, contre) => ({ adoptions: declarations(racine, contre, 'Analyse-adoption'), configs: declarations(racine, contre, 'Analyse-config') });

/**
 * Ce que l'analyse juge au départ du lot, pour configChangee de scripts/lot-de-config.mjs (L586 : la même règle « config: true », la même lecture des commits) :
 * l'identité d'un outil (son entrée sous `analyse:` : nom, commande, format, dossier, rapport, chemin de la base, configs — retirée ou modifiée) et ses
 * `configs` ne changent pas hors d'un lot déclaré `config: true`. Sans cette garde, renommer l'outil (ou sa base) donnerait une base « neuve », donc libre, et
 * la hausse passerait. `departs` : les outils de cadence.yaml au départ.
 * Une ligne de base est NEUVE quand elle n'était pas celle du MÊME outil au départ (baseNeuve, revue L801 r4 : même nom, même chemin, fichier présent) : un
 * fichier absent, mais aussi un fichier orphelin laissé par un outil retiré, ou déposé d'avance par un lot ordinaire, que personne ne jugeait. Elle est tenue
 * à sa mesure (jugerOutil) et passe par deux voies, toutes deux dites par la porte (`neuves`) : le lot `config: true`, ou l'ADOPTION
 * déclarée (`declare.adoptions`, declarationsDuLot) d'un lot ordinaire, qui touche ce qu'il veut (manifeste de dépendances compris) et ne dépend d'aucun plan.
 * Une adoption est un ajout pur : l'outil n'existait pas au départ (ou y était sans base, entrée inchangée), sa base n'est celle d'aucun outil du départ ;
 * ses `configs` sont libres dans ce lot, sauf celles qu'un outil du départ déclare déjà. Rien de ce que le départ jugeait n'y perd son juge : retirer ou
 * modifier un outil reste refusé, donc renommer (tsc → tsc2 : « tsc » retiré) aussi, adoption déclarée ou non.
 * SANS PLAN NATIF au départ (revue L801 r3, M3 : aucun lot ne peut y être `config: true`), un outil du départ change de config par un CHANGEMENT DÉCLARÉ
 * (`declare.configs` : la ligne `Analyse-config: <outil>` d'un commit du lot) : son entrée peut être modifiée (même nom, même chemin de base : ni
 * retrait, ni renommage, ni base déplacée — jamais une base neuve) et ses fichiers de `configs` (ceux du départ et ceux d'aujourd'hui) changer, sauf un
 * fichier qu'un autre outil du départ, non déclaré, lit aussi. La porte dit chaque changement (`dites`). Avec un plan natif la ligne ne vaut rien : seul le
 * lot `config: true`, que le plan du départ déclare, change une config.
 */
/**
 * Revue L801 r4, M1 : une ligne de base est NEUVE quand elle n'était pas celle du même outil au départ du lot — pas d'outil de ce nom au départ, ou sous un
 * autre chemin de base, ou fichier absent. Un fichier présent au départ ne suffit pas : orphelin (outil retiré, base laissée) ou déposé par un lot ordinaire,
 * aucun cliquet ne le jugeait, et son contenu n'est pas un plafond. `departs` : les outils de cadence.yaml au départ (outilsAuDepart).
 */
export function baseNeuve(ref, departs, outil) {
  return !departs.some((d) => d.name === outil.name && d.baseline === outil.baseline) || ref.config(outil.baseline) === null;
}

const valeurDe = (v) => (v === undefined || (Array.isArray(v) && !v.length) ? '(rien)' : `« ${Array.isArray(v) ? v.join(', ') : v} »`);
/** Les champs d'une entrée d'outil qui diffèrent, ancienne et nouvelle valeur : `command « a » → « b » ; configs …` (une commande neutralisée se lit à la porte). */
const champsChanges = (depart, actuel) => CLES.filter((k) => JSON.stringify(depart[k]) !== JSON.stringify(actuel[k])).map((k) => `${k} ${valeurDe(depart[k])} → ${valeurDe(actuel[k])}`).join(' ; ');

function jeuAnalyse(racine, ref, outils, departs, { adoptions: declarees = new Map(), configs = new Map() }) {
  const tous = [...departs, ...outils];
  const auDepart = (n) => departs.find((o) => o.name === n);
  const actuel = (n) => outils.find((o) => o.name === n);
  const identite = (o) => (o ? JSON.stringify(o) : null);
  const neuve = (o) => baseNeuve(ref, departs, o);
  const absente = (o) => ref.config(o.baseline) === null;
  const adoptable = (o) => neuve(o) && (!auDepart(o.name) || identite(auDepart(o.name)) === identite(o)) && !departs.some((d) => d.name !== o.name && d.baseline === o.baseline);
  const adoptes = outils.filter((o) => adoptable(o) && declarees.has(o.name));
  const aDeclarer = outils.filter((o) => adoptable(o) && !declarees.has(o.name)).map((o) => o.name);
  // sans plan natif : les outils du départ gardés sous leur nom et leur base, dont la config peut changer par déclaration
  const declarables = planNatif(ref.config) ? [] : departs.filter((d) => actuel(d.name)?.baseline === d.baseline);
  const declares = declarables.filter((d) => configs.has(d.name));
  const fichiersDe = (d) => [...new Set([...d.configs, ...actuel(d.name).configs])];
  const tenues = new Set(departs.filter((d) => !declares.includes(d)).flatMap((o) => o.configs));
  const figees = new Set(departs.flatMap((o) => o.configs));
  const libres = new Set([...adoptes.flatMap((o) => o.configs).filter((c) => !figees.has(c)), ...declares.flatMap(fichiersDe).filter((c) => !tenues.has(c))]);
  const toutes = new Set(tous.flatMap((o) => o.configs));
  const bases = new Set(tous.map((o) => o.baseline));
  const exemptes = new Set([...adoptes, ...declares].map((o) => o.name));
  const changees = () => [
    ...differences([...new Set(tous.map((o) => o.name))].filter((n) => !exemptes.has(n)).map((n) => [`cadence.yaml#analyse.${n}`, identite(auDepart(n)), identite(actuel(n))])),
    // une base reprise (fichier présent au départ) vient toujours avec une entrée d'outil nouvelle ou modifiée, déjà dite ci-dessus
    ...outils.filter((o) => absente(o) && !adoptes.includes(o)).map((o) => `${o.baseline} (nouveau)`),
    ...fichiersDifferents(racine, ref, [...toutes].filter((c) => !libres.has(c))),
  ];
  // ce qu'un outil du départ a changé : son entrée, ses fichiers de configs
  const entree = (d) => (identite(d) === identite(actuel(d.name)) ? [] : [`cadence.yaml#analyse.${d.name} (modifié : ${champsChanges(d, actuel(d.name))})`]);
  const change = (d) => [...entree(d), ...fichiersDifferents(racine, ref, fichiersDe(d))];
  const aDire = declarables.filter((d) => !declares.includes(d) && change(d).length).map((d) => d.name);
  // un outil du départ retiré (un renommage : lint → lint2) reste refusé quoi qu'on déclare : ne pas proposer une adoption qui n'y changerait rien
  const retires = departs.filter((d) => !actuel(d.name)).map((d) => d.name);
  const retrait = retires.length ? ` ; ${retires.map((n) => `« ${n} »`).join(', ')} : retirer ou renommer un outil du départ n'est pas une adoption, aucune déclaration ne l'ouvre` : '';
  const adoption = retires.length ? retrait : aDeclarer.length ? ` ; un outil neuf s'adopte dans un lot ordinaire, par la ligne « Analyse-adoption: ${aDeclarer.join(', ')} » dans le message d'un commit du lot (docs/analyse.md)` : '';
  const config = aDire.length ? ` ; ce dépôt n'a pas de plan natif : la config d'un outil s'y change par la ligne « Analyse-config: ${aDire.join(', ')} » dans le message d'un commit du lot, que la porte affiche (docs/analyse.md)` : '';
  return {
    actif: true, changees, estConfig: (f) => f === 'cadence.yaml' || toutes.has(f) || bases.has(f),
    raison: `l'identité d'un outil (nom, commande, format, dossier, rapport, chemin, configs), un seuil ou une exclusion ne se change pas hors d'un lot « config: true » du plan, livré seul (corriger le code, pas l'outil), et une ligne de base ne naît pas sans être déclarée${adoption}${config}`,
    neuves: outils.filter(neuve).map((o) => `${o.name} (${o.baseline}) — ${adoptes.includes(o) ? `adoption déclarée par le commit ${declarees.get(o.name)} (Analyse-adoption: ${o.name})` : 'lot « config: true » du plan'}${absente(o) ? '' : ` — fichier repris de ${ref.nom}, où il n'était pas la base de cet outil : tenu à sa mesure`}`),
    dites: declares.filter((d) => change(d).length).map((d) => `${d.name} — ${change(d).join(', ')} — changement déclaré par le commit ${configs.get(d.name)} (Analyse-config: ${d.name})`),
  };
}

/** Les outils de cadence.yaml au départ du lot ; vide sans fichier ou sans clé, et pour une clé mal formée (chaque outil d'aujourd'hui y est alors « nouveau »). */
export function outilsAuDepart(ref, parse) {
  const t = ref.config('cadence.yaml');
  try { return t === null ? [] : lireAnalyse(parse(t)?.analyse, 'cadence.yaml'); } catch { return []; }
}

/**
 * La garde d'identité, de naissance et de configs de l'analyse (jeuAnalyse) contre le départ du lot : `refus` ({ code: 1, texte } ou null) et, sans refus,
 * ce que la porte affiche (jamais en silence) : `neuves` — chaque ligne de base née dans le lot avec ce qui l'autorise — et `configs` — chaque outil dont la
 * config a changé par un changement déclaré (projet sans plan natif). `declare` : declarationsDuLot.
 */
export function gardeIdentite(racine, ref, outils, parse, declare = {}) {
  const jeu = jeuAnalyse(racine, ref, outils, outilsAuDepart(ref, parse), declare);
  const refus = configChangee(racine, ref, jeu);
  return { refus, neuves: refus ? [] : jeu.neuves, configs: refus ? [] : jeu.dites };
}

/**
 * Juge un outil. mode : 'verifier' (la porte), 'init' (crée la base absente), 'ecrire' (fige une baisse, refuse si quoi que ce soit empire) ou 'migrer'
 * (fichiers déplacés ou découpés, exige `ref` : comparerMigration de scripts/qualite.mjs). `ref` (lireRef) : le départ du lot — sa base de l'outil ne peut pas
 * être dépassée par celle du lot (remontees, neufsAuDessus : les gardes de scripts/qualite.mjs). L'identité de l'outil et ses `configs` se jugent avant, pour
 * tous les outils (gardeIdentite). Rend { code, texte } : 0 vert, 1 refus, 2 erreur.
 * `ref.analyse` : les outils de cadence.yaml au départ (outilsAuDepart). La base du départ n'est un plafond que si elle y était celle du même outil
 * (baseNeuve) ; sinon elle est neuve, tenue à la mesure, et `--init --contre` la re-mesure. Sans `ref.analyse`, toute base est neuve : le défaut est le plus strict.
 */
export function jugerOutil(racine, outil, mode, mesure, ref = null) {
  const fichierDepart = ref ? ref.config(outil.baseline) : null;
  const depart = ref && baseNeuve(ref, ref.analyse ?? [], outil) ? null : fichierDepart;
  const j = { racine, outil, mesure, ref, fichier: join(racine, outil.baseline), baseDepart: depart === null ? null : JSON.parse(depart), reprise: fichierDepart !== null && depart === null, nom: `${outil.name} (${outil.baseline})` };
  if (mode === 'init') return initialiser(j);
  if (!existsSync(j.fichier)) return { code: 2, texte: `${j.nom} absente : lancer « cadence analyse --init --outil ${outil.name} » une fois, puis la versionner.` };
  j.base = lireJson(j.fichier);
  // un « fichier » déjà dans la base du départ existait (une erreur sans fichier, « (global) », un chemin de SpotBugs relatif aux sources) : sinon l'arbre du départ
  const connus = new Set(Object.keys(j.baseDepart ?? j.base).map((k) => k.split('|')[0]));
  j.existe = (c) => connus.has(c) || ref.existe(c);
  return remonte(j) ?? (mode === 'migrer' ? migrer(j) : comparerBase(j, mode));
}

/**
 * Revue L801 r3, M1, et r4, M1 : une base neuve (baseNeuve : absente au départ du lot, ou fichier qui n'y était pas la base de cet outil) n'a rien au-dessus d'elle à ne pas dépasser ; elle est
 * donc tenue à la mesure du commit jugé — aucune clé au-dessus de sa mesure, aucune clé que la mesure n'a pas (un fichier absent, une règle jamais violée).
 * Sinon une base gonflée à la main s'adopterait, et la hausse passerait aux lots suivants jusqu'au plafond inventé. `comparer` a déjà refusé ce qui dépasse.
 */
function neuveHorsMesure({ base, mesure, nom, outil, ref, reprise }) {
  const hors = Object.entries(base).filter(([k, n]) => !Object.hasOwn(mesure, k) || n > mesure[k]).map(([cle, avant]) => ({ cle, avant, apres: mesure[cle] ?? 0 }));
  if (!hors.length) return null;
  return { code: 1, texte: `${nom} : ligne de base neuve (${reprise ? `dans ${ref.nom}, ce fichier n'était pas la base de l'outil « ${outil.name} »` : `absente de ${ref.nom}`}) différente de la mesure : ${hors.length} clé(s) au-dessus de la mesure ou absente(s) d'elle. Une base neuve est la mesure, rien de plus : « cadence analyse --init --outil ${outil.name} --contre ${ref.nom.split(' ')[0]} » la re-mesure (ne pas l'écrire à la main).\n${hors.map(ligne).join('\n')}` };
}

/** `--init` : la base absente (ou, avec --contre, neuve au départ du lot : re-mesurée après un rebase, ou à la reprise d'un fichier orphelin) est écrite. */
function initialiser({ fichier, baseDepart, nom, ref, mesure }) {
  if (baseDepart) return { code: 2, texte: `${nom} existe déjà dans ${ref.nom} : --init ne la recrée pas (elle ne peut que baisser : --ecrire).` };
  if (existsSync(fichier) && !ref) return { code: 2, texte: `${nom} existe déjà : --init ne la recrée pas (elle ne peut que baisser : --ecrire).` };
  ecrire(fichier, mesure);
  return { code: 0, texte: `${nom} créée : ${total(mesure)} violation(s) gelée(s), ${Object.keys(mesure).length} clés.` };
}

const lienDe = (j, base) => creerLien(versQualite(base), { depart: j.ref.contenu, courant: (c) => lireLocal(j.racine, c), neuf: (c) => lireLocal(j.racine, c) });
const lignes = (pires) => pires.map((p) => ligne({ ...p, cle: deQualite(p.cle) })).join('\n');

/** La base du lot ne remonte pas au-dessus de celle du départ (un fichier neuf n'y entre que crédité par sa source, comme --migrer) ; null si elle tient. */
function remonte(j) {
  if (!j.baseDepart) return null;
  const pires = remontees(versQualite(j.baseDepart), versQualite(j.base), versQualite(j.mesure), j.existe, lienDe(j, j.baseDepart));
  return pires.length ? { code: 1, texte: `${j.nom} remonte par rapport à ${j.ref.nom} (elle ne peut que baisser : corriger le code, pas la base) :\n${lignes(pires)}` } : null;
}

/** `--migrer` : fichiers déplacés ou découpés ; la règle de scripts/qualite.mjs (aucun fichier qui existait ni aucun total ne monte, un fichier neuf crédité par sa source). */
function migrer(j) {
  if (!j.ref) return { code: 2, texte: '--migrer exige --contre <ref> : les fichiers « qui existaient » sont ceux du point de départ du lot.' };
  const depart = j.baseDepart ?? j.base;
  const pires = comparerMigration(versQualite(j.base), versQualite(j.mesure), j.existe, lienDe(j, depart), versQualite(depart));
  if (pires.length) return { code: 1, texte: `${j.nom} : la migration empire ${pires.length} mesure(s) (ni un fichier qui existait ni le total ne peuvent monter) :\n${lignes(pires)}` };
  ecrire(j.fichier, j.mesure);
  return { code: 0, texte: `${j.nom} migrée : ${total(j.mesure)} violation(s), aucun total en hausse.` };
}

/**
 * La mesure contre la base : ce qui empire refuse ; en mode 'ecrire', une baisse est écrite. À la porte (`--contre`), une clé d'un fichier neuf au-dessus
 * de sa mesure est refusée (L707, neufsAuDessus) : intégrée, elle deviendrait au lot suivant la clé d'un fichier « qui existait » et le laisserait regrossir.
 */
function comparerBase(j, mode) {
  const { base, mesure, fichier, nom, baseDepart, existe, ref } = j;
  const { pires, mieux } = comparer(base, mesure);
  if (pires.length) return { code: 1, texte: `${nom} : ${pires.length} mesure(s) empirent (seules les violations gelées passent ; corriger le code, jamais la base) :\n${pires.map(ligne).join('\n')}` };
  const hautes = mode === 'verifier' && baseDepart ? neufsAuDessus(versQualite(base), versQualite(mesure), existe) : [];
  if (hautes.length) return { code: 1, texte: `${nom} : ${hautes.length} clé(s) de fichier neuf au-dessus de la mesure (gain non figé) : un fichier neuf entre dans ${ref.nom} à sa mesure. Figer : « cadence analyse --ecrire » (ou --migrer --contre si des fichiers ont été déplacés).\n${lignes(hautes)}` };
  const gonflee = mode === 'verifier' && ref && !baseDepart ? neuveHorsMesure(j) : null;
  if (gonflee) return gonflee;
  if (mode === 'ecrire') { ecrire(fichier, mesure); return { code: 0, texte: `${nom} baissée : ${total(base)} → ${total(mesure)} violation(s) gelée(s).` }; }
  const reste = mieux.length ? ` ; ${mieux.length} mesure(s) ont baissé : « cadence analyse --ecrire » fige le gain` : '';
  return { code: 0, texte: `${nom} : rien n'empire (${total(mesure)} violation(s), ${total(base)} gelée(s))${reste}.` };
}
const lireLocal = (racine, c) => (existsSync(join(racine, c)) ? readFileSync(join(racine, c), 'utf8') : null);

// ── la commande : cadence analyse [--init | --ecrire | --migrer] [--contre <ref>] [--outil <nom>] ───────────────────────────────

/** La commande de l'étape « analyse » de la porte de cadence run : ce script, contre la branche cible du run. */
export const commandePorte = (cible) => [process.execPath, SCRIPT, '--contre', cible].map((s) => (/^[\w./@+=,:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)).join(' ');

/** L'étape « analyse » de la porte d'un run : `{ commandes }` (une seule, tous les outils, vide sans la clé) ou `{ refus }` (clé mal formée : rien n'est joué). */
export function etapeAnalyse(valeur, cible) {
  try { return { commandes: lireAnalyse(valeur, 'cadence.yaml').length ? [commandePorte(cible)] : [] }; } catch (e) { return { commandes: [], refus: e.message }; }
}

// Ce que l'analyse dit d'une porte VERTE et qui se relit : une base née dans le lot, une config changée par déclaration. La porte de cadence run reprend ces
// lignes au journal et au détail de l'état integre (revue L801 r3, M2 : elle ne gardait que la sortie d'une porte rouge).
const A_RELIRE = ['analyse : ligne de base neuve : ', 'analyse : config changée : '];
/** Les lignes à relire de la sortie d'une commande de porte (vide pour toute autre commande que l'analyse). */
export const lignesARelire = (sortie) => sortie.split('\n').filter((l) => A_RELIRE.some((p) => l.startsWith(p)));

const USAGE = 'usage : cadence analyse [--init | --ecrire | --migrer] [--contre <ref>] [--outil <nom>] (clé analyse: de cadence.yaml, docs/analyse.md)';

function options(argv) {
  const o = { mode: 'verifier' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const mode = { '--init': 'init', '--ecrire': 'ecrire', '--migrer': 'migrer' }[a];
    if (mode && o.mode === 'verifier') o.mode = mode;
    else if ((a === '--contre' || a === '--outil') && argv[i + 1] && !argv[i + 1].startsWith('--') && !o[a.slice(2)]) o[a.slice(2)] = argv[++i];
    else throw new Error(USAGE);
  }
  return o;
}

/** `cadence analyse` : joue chaque outil déclaré (ou `--outil`) depuis la racine `io.cwd` ; code 0 vert, 1 au moins un refus, 2 erreur. */
export async function main(argv, io) {
  let o, tous, parse;
  try {
    o = options(argv);
    const y = join(io.cwd, 'cadence.yaml');
    ({ parse } = await import('yaml'));
    tous = lireAnalyse(existsSync(y) ? parse(readFileSync(y, 'utf8'))?.analyse : undefined, 'cadence.yaml');
    if (!tous.length) { io.err('analyse : cadence.yaml ne déclare aucun outil (clé analyse:, docs/analyse.md)'); return 2; }
    if (o.outil && !tous.some((x) => x.name === o.outil)) { io.err(`analyse : outil « ${o.outil} » absent de la clé analyse: de cadence.yaml`); return 2; }
  } catch (e) {
    io.err(`analyse : ${e.message}`);
    return 2;
  }
  try {
    return jugerTout(io, o, tous, parse);
  } catch (e) {
    io.err(`analyse : ${e.message}`);
    return 2;
  }
}

/** La garde d'identité contre le départ : faux, refus dit ; vrai, et chaque base neuve et chaque config changée par déclaration est dite (A_RELIRE). */
function garder(io, o, tous, parse, ref) {
  const garde = gardeIdentite(io.cwd, ref, tous, parse, declarationsDuLot(io.cwd, o.contre));
  if (garde.refus) { io.err(`analyse : ${garde.refus.texte}`); return false; }
  for (const n of garde.neuves) io.out(`${A_RELIRE[0]}${n}`);
  for (const n of garde.configs) io.out(`${A_RELIRE[1]}${n}`);
  return true;
}

/** Contre le départ (`--contre`), d'abord l'identité de TOUS les outils déclarés (même avec --outil) et les bases neuves, dites ; puis chaque outil joué et jugé. */
function jugerTout(io, o, tous, parse) {
  const retard = o.contre ? retardSurBranche(io.cwd, o.contre) : null;
  if (retard) { io.err(`analyse : ${retard.texte.replace('node scripts/qualite.mjs', 'cadence analyse')}`); return 1; }
  const ref = o.contre ? lireRef(resolve(io.cwd), o.contre) : null;
  if (ref && !garder(io, o, tous, parse, ref)) return 1;
  const depart = ref && { ...ref, analyse: outilsAuDepart(ref, parse) };
  let code = 0;
  for (const outil of tous.filter((x) => !o.outil || x.name === o.outil)) {
    let r;
    try { r = jugerOutil(io.cwd, outil, o.mode, mesurerOutil(io.cwd, outil), depart); } catch (e) { r = { code: 2, texte: e.message }; }
    (r.code ? io.err : io.out)(`analyse : ${r.texte}`);
    code = Math.max(code, r.code);
  }
  return code;
}

if (process.argv[1] === SCRIPT) {
  process.exitCode = await main(process.argv.slice(2), { cwd: process.cwd(), out: (l) => console.log(l), err: (l) => console.error(l) });
}
