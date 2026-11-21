// Analyse statique par techno (L801, D-23) : l'étape « analyse » de la porte de cadence run, déclarée par la clé `analyse:` de cadence.yaml.
// Une commande par outil (ESLint typé, tsc --noEmit, ruff, Checkstyle, PMD, CPD, SpotBugs, analyseurs .NET en SARIF…) ; son rapport est lu par un
// lecteur de format (`fichier|règle → nombre`), puis jugé par un cliquet générique : une ligne de base par outil, versionnée ; seules les nouvelles
// violations font échouer ; une baisse s'écrit (--ecrire), une hausse jamais. Le cliquet réutilise celui de scripts/qualite.mjs (L462 : comparer,
// comparerMigration, creerLien, lireRef), qui reste celui du code de cadence lui-même. Rien de propre à un dépôt : la recette est dans docs/analyse.md.
// JavaScript sans dépendance, comme scripts/regeneration.mjs : src et v2 l'importent hors de leur rootDir. Il lit la valeur déjà analysée (pas de yaml ici).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparer, comparerMigration, creerLien, lireEslint, lireRef, retardSurBranche, serialiser } from './qualite.mjs';

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
/** Par format : les fichiers lus (git ls-files sous le dossier de l'outil, filtrés par extension) et les motifs comptés, chacun sous `directive:<nom>`. */
const DIRECTIVES = {
  'eslint-json': [JS, { 'eslint-disable': /\/[/*][ \t]*eslint-disable/g }],
  tsc: [JS, { 'ts-ignore': /\/[/*][ \t]*@ts-(?:ignore|nocheck|expect-error)/g }],
  'ruff-json': [/\.pyi?$/, { noqa: /#[ \t]*(?:noqa|ruff:[ \t]*noqa)\b/gi }],
  'checkstyle-xml': [JAVA, { 'checkstyle-off': /CHECKSTYLE[ \t]*:?[ \t]*OFF|@SuppressWarnings\([^)]*checkstyle:/gi }],
  'pmd-xml': [JAVA, { nopmd: /\/\/[ \t]*NOPMD|@SuppressWarnings\([^)]*PMD/g }],
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
const ligne = ({ cle, avant, apres, note }) => `  ${cle} : ${avant} → ${apres}${note ? ` — ${note}` : ''}`;
// les clés d'un outil vues par le cliquet de scripts/qualite.mjs (`outil|fichier|règle`) : « analyse » n'est ni « eslint » ni « jscpd », aucune n'est un simple compteur
const versQualite = (m) => Object.fromEntries(Object.entries(m).map(([k, n]) => [`analyse|${k}`, n]));
const deQualite = (cle) => cle.replace(/^analyse\|/, '');
const lireJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const ecrire = (f, m) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, serialiser(m)); };

// Les commits qui ne citent que des lots déclarés `config: true` au plan du départ (L586, même lecture que scripts/qualite.mjs) peuvent changer une config.
const lotsCites = (sujet) => /^[^(:]*\(([^)]+)\)/.exec(sujet)?.[1].split(',').map((i) => i.trim()) ?? [];
function configsChangees(racine, outil, ref) {
  const commits = ref.commits();
  return outil.configs.filter((c) => {
    const ici = existsSync(join(racine, c)) ? readFileSync(join(racine, c), 'utf8') : null;
    if (ici === ref.config(c)) return false;
    const touchants = commits.filter((x) => x.fichiers.includes(c));
    return !(touchants.length && touchants.every((x) => lotsCites(x.sujet).length && lotsCites(x.sujet).every((id) => ref.lotsConfig.has(id))));
  });
}

/**
 * Juge un outil. mode : 'verifier' (la porte), 'init' (crée la base absente), 'ecrire' (fige une baisse, refuse si quoi que ce soit empire) ou 'migrer'
 * (fichiers déplacés ou découpés, exige `ref` : comparerMigration de scripts/qualite.mjs). `ref` (lireRef) : le départ du lot — sa base de l'outil ne peut pas
 * être dépassée par celle du lot, et les `configs` de l'outil (seuils, exclusions) doivent y être identiques. Rend { code, texte } : 0 vert, 1 refus, 2 erreur.
 */
export function jugerOutil(racine, outil, mode, mesure, ref = null) {
  const depart = ref ? ref.config(outil.baseline) : null;
  const j = { racine, outil, mesure, ref, fichier: join(racine, outil.baseline), baseDepart: depart === null ? null : JSON.parse(depart), nom: `${outil.name} (${outil.baseline})` };
  const changees = ref && j.baseDepart ? configsChangees(racine, outil, ref) : [];
  if (changees.length) return { code: 1, texte: `${j.nom} : ${changees.join(', ')} diffère(nt) de ${ref.nom} : un seuil ou une exclusion ne se change pas dans un lot jugé par eux (corriger le code ; changer une config est un lot « config: true » du plan, livré seul).` };
  if (mode === 'init') return initialiser(j);
  if (!existsSync(j.fichier)) return { code: 2, texte: `${j.nom} absente : lancer « cadence analyse --init --outil ${outil.name} » une fois, puis la versionner.` };
  j.base = lireJson(j.fichier);
  // un « fichier » déjà dans la base du départ existait (une erreur sans fichier, « (global) », un chemin de SpotBugs relatif aux sources) : sinon l'arbre du départ
  const connus = new Set(Object.keys(j.baseDepart ?? j.base).map((k) => k.split('|')[0]));
  j.existe = (c) => connus.has(c) || ref.existe(c);
  return remonte(j) ?? (mode === 'migrer' ? migrer(j) : comparerBase(j, mode));
}

/** `--init` : la base absente (ou, avec --contre, absente au départ du lot : re-mesurée après un rebase) est écrite. */
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
  const pires = comparerMigration(versQualite(j.baseDepart), versQualite(j.base), j.existe, lienDe(j, j.baseDepart));
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

/** La mesure contre la base : ce qui empire refuse ; en mode 'ecrire', une baisse est écrite. */
function comparerBase({ base, mesure, fichier, nom }, mode) {
  const { pires, mieux } = comparer(base, mesure);
  if (pires.length) return { code: 1, texte: `${nom} : ${pires.length} mesure(s) empirent (seules les violations gelées passent ; corriger le code, jamais la base) :\n${pires.map(ligne).join('\n')}` };
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
  let o, outils;
  try {
    o = options(argv);
    const y = join(io.cwd, 'cadence.yaml');
    const { parse } = await import('yaml');
    outils = lireAnalyse(existsSync(y) ? parse(readFileSync(y, 'utf8'))?.analyse : undefined, 'cadence.yaml');
    if (!outils.length) { io.err('analyse : cadence.yaml ne déclare aucun outil (clé analyse:, docs/analyse.md)'); return 2; }
    if (o.outil) {
      outils = outils.filter((x) => x.name === o.outil);
      if (!outils.length) { io.err(`analyse : outil « ${o.outil} » absent de la clé analyse: de cadence.yaml`); return 2; }
    }
  } catch (e) {
    io.err(`analyse : ${e.message}`);
    return 2;
  }
  let code = 0;
  try {
    const retard = o.contre ? retardSurBranche(io.cwd, o.contre) : null;
    if (retard) { io.err(`analyse : ${retard.texte.replace('node scripts/qualite.mjs', 'cadence analyse')}`); return 1; }
    const ref = o.contre ? lireRef(resolve(io.cwd), o.contre) : null;
    for (const outil of outils) {
      let r;
      try { r = jugerOutil(io.cwd, outil, o.mode, mesurerOutil(io.cwd, outil), ref); } catch (e) { r = { code: 2, texte: e.message }; }
      (r.code ? io.err : io.out)(`analyse : ${r.texte}`);
      code = Math.max(code, r.code);
    }
  } catch (e) {
    io.err(`analyse : ${e.message}`);
    return 2;
  }
  return code;
}

if (process.argv[1] === SCRIPT) {
  process.exitCode = await main(process.argv.slice(2), { cwd: process.cwd(), out: (l) => console.log(l), err: (l) => console.error(l) });
}
