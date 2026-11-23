// Écriture courte contrôlée (L803, D-31) : les principes de l'ASD-STE100 transposés au français, pour les textes qu'on lit sans la conversation
// (entrées Nouveautés, rapports de revue, bilan du jour). Le contrôle SIGNALE, il ne réécrit rien : une phrase de plus de 25 mots (20 pour une
// consigne), une voix passive, un point-virgule qui lie deux idées. Il mesure aussi la longueur moyenne des phrases, la mesure avant/après du lot.
// Seuils réglables par projet (clé `ecriture:` de cadence.yaml). Rien de propre à un dépôt : la recette est dans docs/ecriture.md.
// JavaScript sans dépendance (le yaml n'est importé que par main), comme scripts/analyse.mjs : src l'importe hors de son rootDir.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT = fileURLToPath(import.meta.url);
export const DEFAUTS = Object.freeze({ phrase: 25, consigne: 20, passif: true, pointVirgule: true });
const CLES = ['phrase', 'consigne', 'passif', 'pointVirgule', 'depuis'];
const JOUR = /^\d{4}-\d{2}-\d{2}$/;

// ── la clé ecriture: de cadence.yaml ────────────────────────────────────────────────────────────────────────────────────────────

const entier = (v) => Number.isInteger(v) && v > 0;
const jour = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

/**
 * `valeur` : ce que le YAML donne sous `ecriture:` (undefined ou null sans la clé). Rend les réglages, défauts compris ; une forme mal formée lève une
 * Error dont le message commence par `fichier : ` et nomme la clé fautive (la validation de cadence.yaml, src/config-set.ts, lit par ce même code).
 */
export function lireEcriture(valeur, fichier) {
  if (valeur == null) return { ...DEFAUTS };
  const depuis = controlerEcriture(valeur, (m) => { throw new Error(`${fichier} : ecriture${m}`); });
  const r = { ...DEFAUTS };
  for (const k of ['phrase', 'consigne', 'passif', 'pointVirgule']) if (valeur[k] != null) r[k] = valeur[k];
  return depuis ? { ...r, depuis } : r;
}

/** Les contrôles de la clé `ecriture:` ; `ko` lève avec la fin du message. Rend `depuis` en AAAA-MM-JJ (le YAML peut donner une date). */
function controlerEcriture(valeur, ko) {
  if (typeof valeur !== 'object' || Array.isArray(valeur)) ko(' : objet { phrase, consigne, passif, pointVirgule, depuis } attendu');
  const inconnue = Object.keys(valeur).find((k) => !CLES.includes(k));
  if (inconnue) ko(`.${inconnue} inconnu (attendu : ${CLES.join(', ')})`);
  const mauvais = (ks, ok) => ks.find((k) => valeur[k] != null && !ok(valeur[k]));
  const n = mauvais(['phrase', 'consigne'], entier);
  if (n) ko(`.${n} : nombre de mots entier positif attendu`);
  const b = mauvais(['passif', 'pointVirgule'], (v) => typeof v === 'boolean');
  if (b) ko(`.${b} : true ou false attendu`);
  const depuis = jour(valeur.depuis);
  if (depuis != null && !(typeof depuis === 'string' && JOUR.test(depuis))) ko('.depuis : date AAAA-MM-JJ attendue');
  return depuis;
}

// ── du markdown aux phrases ─────────────────────────────────────────────────────────────────────────────────────────────────────

// Un code en ligne compte pour un mot : il devient un jeton sans blanc (`\uE000<n>\uE001`) pour la mesure, puis est rendu tel quel dans l'extrait.
const JETON = /\uE000(\d+)\uE001/g;
const estJeton = (t) => /^\uE000\d+\uE001/.test(t);
/** Le texte lisible d'une ligne : code en ligne → un jeton, lien → son texte, image, URL et balises retirées ou réduites, emphase ôtée. */
function nettoyer(l, codes) {
  return l
    .replace(/`[^`]*`/g, (c) => `\uE000${codes.push(c) - 1}\uE001`)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'URL')
    .replace(/<[^>]+>/g, ' ')
    .replace(/(\*\*|__|\*|~~)/g, '')
    .replace(/\s+/g, ' ');
}

/** Le marqueur de bloc d'une ligne (titre, puce, numéro, citation, tableau), ou null pour une ligne qui continue le paragraphe. */
function marqueur(l) {
  if (/^#{1,6}\s/.test(l)) return 'titre';
  if (/^\|/.test(l)) return 'tableau';
  if (/^([-*+]|\d+[.)])\s/.test(l) || /^>/.test(l)) return 'puce';
  return null;
}

/** Le début d'un texte après son front matter (`---` … `---` en tête), en index de ligne. */
function apresFrontMatter(lignes) {
  if (lignes[0] !== '---') return 0;
  const fin = lignes.indexOf('---', 1);
  return fin > 0 ? fin + 1 : 0;
}

/** Une ligne lue dans l'état `e` (`r` : blocs rendus, `cur` : bloc ouvert, `barriere` : clôture de code attendue). */
function lireLigne(e, l, n) {
  const clotureCode = /^(```|~~~)/.exec(l);
  if (e.barriere || clotureCode) {
    if (!e.barriere) e.barriere = clotureCode[1];
    else if (l.startsWith(e.barriere)) e.barriere = null;
    return e.fermer();
  }
  if (!l || /^<!--.*-->$/.test(l) || /^\|?\s*:?-{3,}/.test(l)) return e.fermer();
  const m = marqueur(l);
  if (m) e.fermer();
  if (m === 'tableau') for (const c of l.split('|')) if (c.trim()) e.r.push({ ligne: n, texte: c.trim() });
  if (m === 'puce') e.cur = { ligne: n, texte: l.replace(/^([-*+]|\d+[.)]|>+)\s*/, '') };
  if (m) return;
  e.cur ??= { ligne: n, texte: '' };
  e.cur.texte += ` ${l}`;
}

/** Les blocs d'un texte markdown `{ ligne, texte }` : paragraphe, élément de liste, cellule de tableau. Front matter, code, titres et commentaires ôtés. */
export function blocs(texte) {
  const lignes = texte.replace(/\r\n?/g, '\n').split('\n');
  const e = { r: [], cur: null, barriere: null };
  e.fermer = () => { if (e.cur?.texte.trim()) e.r.push({ ligne: e.cur.ligne, texte: e.cur.texte.trim() }); e.cur = null; };
  for (let i = apresFrontMatter(lignes); i < lignes.length; i++) lireLigne(e, lignes[i].trim(), i + 1);
  e.fermer();
  return e.r;
}

const MOT = /[\p{L}\p{N}]/u;
/** Les mots d'une phrase : suites séparées par des blancs qui portent une lettre ou un chiffre (« l'appel », « mini-blue » et un code comptent pour un). */
export const mots = (phrase) => phrase.split(/\s+/).filter((t) => MOT.test(t));

/**
 * Les phrases d'un bloc nettoyé : coupure après « . ! ? … » suivis d'un blanc puis d'une majuscule, d'un chiffre ou d'un guillemet ouvrant ;
 * « p. ex. la » ou « etc. et » ne coupent donc pas. La fin du bloc termine la phrase.
 */
function decouper(texte) {
  const codes = [];
  return nettoyer(texte, codes).split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{N}«"“(\uE000])/u).map((p) => p.trim()).filter((p) => mots(p).length)
    .map((brut) => ({ brut, texte: brut.replace(JETON, (_, i) => codes[Number(i)]) }));
}
/** Les phrases d'un bloc, telles qu'on les lit (le code en ligne rendu tel quel). */
export const phrasesDuBloc = (texte) => decouper(texte).map((p) => p.texte);

// ── les signaux ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const minuscules = (p) => mots(p).map((t) => t.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’]+$/gu, ''));
const PAS_INFINITIFS = new Set(['hier', 'premier', 'dernier', 'entier', 'dossier', 'fichier', 'calendrier', 'chantier', 'courrier', 'atelier', 'métier',
  'palier', 'papier', 'particulier', 'janvier', 'février', 'cher', 'fer', 'mer', 'hiver', 'leur', 'pour', 'sur', 'par', 'plusieurs', 'entre', 'autre',
  'notre', 'votre', 'contre', 'quatre', 'titre', 'chapitre', 'ordre', 'nombre', 'membre', 'lettre', 'mètre', 'soir', 'noir', 'espoir', 'chez', 'assez']);
const APRES_VERBE = new Set(['le', 'la', 'les', "l'", 'un', 'une', 'des', 'du', 'de', "d'", 'ce', 'cet', 'cette', 'ces', 'son', 'sa', 'ses', 'leurs', 'chaque',
  'tout', 'tous', 'toute', 'toutes', 'que', "qu'", 'à', 'au', 'aux', 'en', 'y', 'dans', 'avec', 'sans', 'ici', 'puis', 'ensuite', 'aussi', 'seulement',
  'toujours', 'jamais', 'rien', 'pas', 'me', 'se', 'nous', 'vous', 'lui', 'cela', 'ceci', 'code']);

/**
 * Vrai pour une consigne en français : impératif en « -ez » en tête (« Lancez »), infinitif d'instruction en tête suivi d'un déterminant ou d'un
 * complément (« Vérifier que… », « Ajouter un test »), « Ne pas… », ou « il faut », « vous devez », « on doit ». Une heuristique, dite dans docs/ecriture.md.
 */
export function estConsigne(phrase) {
  const t = minuscules(phrase).map((x) => x.replace(/’/g, "'"));
  const [a = '', b0 = ''] = t;
  const b = estJeton(mots(phrase)[1] ?? '') ? 'code' : b0;
  if (/^(ne|n')$/.test(a) || /^n'/.test(a)) return true;
  if (/\b(il (ne )?faut|vous devez|tu dois|on doit)\b/i.test(phrase)) return true;
  if (PAS_INFINITIFS.has(a) || a.length < 4) return false;
  if (/ez$/.test(a)) return true;
  const elide = /^(l|d|qu)'/.test(b) ? `${b.split("'")[0]}'` : b;
  return /(er|ir|re|oir)$/.test(a) && (APRES_VERBE.has(b) || APRES_VERBE.has(elide));
}

const AUX = new Set(['est', 'sont', 'était', 'étaient', 'sera', 'seront', 'serait', 'seraient', 'soit', 'soient', 'fut', 'furent', 'été', 'être', 'étant']);
const ADVERBES = new Set(['pas', 'plus', 'jamais', 'bien', 'déjà', 'toujours', 'encore', 'aussi', 'souvent', 'ensuite', 'alors', 'donc', 'rien', 'très',
  'tout', 'mal', 'seulement', 'désormais', 'enfin', 'simplement', 'également', 'automatiquement', 'ici', 'été', 'ne', "n'"]);
const PARTICIPE = /(é|ée|és|ées|i|ie|is|ies|u|ue|us|ues|it|ite|its|ites|ert|erte|erts|ertes|int|inte|ints|intes|ait|aite|aits|aites)$/;
const PAS_PARTICIPES = new Set(['aussi', 'ainsi', 'ici', 'parmi', 'lui', 'oui', 'celui', 'autrui', 'midi', 'demi', 'vrai', 'vraie', 'vrais', 'vraies', 'joli',
  'ceci', 'voici', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', "aujourd'hui", 'petit', 'petite', 'petits', 'petites', 'gratuit', 'gratuite',
  'nuit', 'bruit', 'fruit', 'huit', 'circuit', 'droit', 'droite', 'étroit', 'endroit', 'parfait', 'parfaite', 'vert', 'verte', 'point', 'prêt', 'vu', 'du',
  'tu', 'su', 'lu', 'nu', 'plus', 'tous', 'sous', 'nous', 'vous', 'jamais', 'mais', 'tout', 'toute', 'conforme', 'tôt', 'debout', 'partout', 'surtout']);
// passé composé des verbes de mouvement ou d'état conjugués avec « être » : « est arrivé » n'est pas une voix passive
const ETRE_ACTIF = /^(allé|arrivé|parti|venu|revenu|devenu|parvenu|intervenu|survenu|apparu|entré|rentré|sorti|resté|tombé|né|mort|monté|descendu|passé|retourné)(e|s|es)?$/;

/** La forme passive d'une phrase (« est écrit », « a été lancée », « sont pas relus »), ou null. Une heuristique : elle signale, elle ne prouve pas. */
export function passif(phrase) {
  const t = minuscules(phrase);
  for (let i = 0; i < t.length; i++) {
    if (!AUX.has(t[i])) continue;
    let j = i + 1;
    while (j < t.length && ADVERBES.has(t[j]) && !(t[j] === 'été' && j + 1 >= t.length)) j++;
    const p = t[j];
    if (p && p.length >= 3 && PARTICIPE.test(p) && !PAS_PARTICIPES.has(p) && !ETRE_ACTIF.test(p)) return `${t.slice(i, j + 1).join(' ')}`;
  }
  return null;
}

/** Les signaux d'une phrase selon les réglages : `longue` (au-delà du seuil, consigne ou non), `passif`, `point-virgule`. */
export function signaux(phrase, reglages = DEFAUTS) {
  const n = mots(phrase).length;
  const consigne = estConsigne(phrase);
  const seuil = consigne ? reglages.consigne : reglages.phrase;
  const r = [];
  if (n > seuil) r.push({ type: consigne ? 'consigne-longue' : 'longue', mots: n, seuil });
  const pv = reglages.passif ? passif(phrase) : null;
  if (pv) r.push({ type: 'passif', forme: pv });
  if (reglages.pointVirgule && phrase.includes(';')) r.push({ type: 'point-virgule' });
  return r;
}

// ── un texte, un fichier ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Les phrases d'un texte markdown avec leur ligne et leurs signaux : `{ phrases: [{ ligne, mots, consigne, texte, signaux }] }`. */
export function analyser(texte, reglages = DEFAUTS) {
  const phrases = [];
  for (const b of blocs(texte)) {
    for (const { brut, texte: lu } of decouper(b.texte)) phrases.push({ ligne: b.ligne, mots: mots(brut).length, consigne: estConsigne(brut), texte: lu, signaux: signaux(brut, reglages) });
  }
  return { phrases };
}

/** Les chaînes d'un rapport JSON, chacune un bloc avec son chemin (`constats[2].texte`) à la place de la ligne. */
function chainesJson(v, chemin = '', r = []) {
  if (typeof v === 'string') { if (/\s/.test(v.trim())) r.push({ chemin: chemin || '(racine)', texte: v }); }
  else if (Array.isArray(v)) v.forEach((x, i) => chainesJson(x, `${chemin}[${i}]`, r));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) chainesJson(x, chemin ? `${chemin}.${k}` : k, r);
  return r;
}

/** Les phrases d'un fichier : markdown ou texte, ou rapport JSON (ses chaînes). Une ligne vaut `fichier:ligne`, un chemin JSON `fichier#chemin`. */
export function analyserFichier(chemin, nom, reglages = DEFAUTS) {
  const texte = readFileSync(chemin, 'utf8');
  if (!chemin.endsWith('.json')) return analyser(texte, reglages).phrases.map((p) => ({ ...p, ou: `${nom}:${p.ligne}` }));
  let j;
  try { j = JSON.parse(texte); } catch (e) { throw new Error(`${nom} : JSON illisible (${e.message.split('\n')[0]})`); }
  return chainesJson(j).flatMap((c) => analyser(c.texte, reglages).phrases.map((p) => ({ ...p, ou: `${nom}#${c.chemin}` })));
}

/** Le jour d'un front matter (`date: AAAA-MM-JJ`), ou null. */
export function jourDuFrontMatter(texte) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(texte);
  const d = m && /^date:\s*['"]?(\d{4}-\d{2}-\d{2})/m.exec(m[1]);
  return d ? d[1] : null;
}

// ── le bilan : nombres et moyenne ───────────────────────────────────────────────────────────────────────────────────────────────

const arrondi = (x) => Math.round(x * 10) / 10;
/** Les nombres d'une liste de phrases : phrases, mots, moyenne (mots par phrase, au dixième), longues, consignes longues, passives, points-virgules. */
export function bilan(phrases) {
  const compte = (t) => phrases.filter((p) => p.signaux.some((s) => s.type === t)).length;
  const n = phrases.length;
  const m = phrases.reduce((s, p) => s + p.mots, 0);
  return { phrases: n, mots: m, moyenne: n ? arrondi(m / n) : 0, longues: compte('longue'), consignesLongues: compte('consigne-longue'),
    passives: compte('passif'), pointsVirgules: compte('point-virgule') };
}

const nombre = (x) => String(x).replace('.', ',');
/** La ligne d'un bilan (« Nouveautés : 3 fichiers, 42 phrases, moyenne 17,3 mots par phrase, 5 au-delà du seuil (11,9 %), … »). */
export function ligneBilan(titre, fichiers, b) {
  const longues = b.longues + b.consignesLongues;
  const part = b.phrases ? ` (${nombre(arrondi((100 * longues) / b.phrases))} %)` : '';
  return `${titre} : ${fichiers} fichier${fichiers > 1 ? 's' : ''}, ${b.phrases} phrases, ${b.mots} mots, moyenne ${nombre(b.moyenne)} mots par phrase, `
    + `${longues} au-delà du seuil${part}, ${b.passives} passive${b.passives > 1 ? 's' : ''}, ${b.pointsVirgules} point${b.pointsVirgules > 1 ? 's' : ''}-virgule${b.pointsVirgules > 1 ? 's' : ''}`;
}

/** Le texte d'un signal pour la sortie : `où  32 mots (seuil 25) : « … »`. */
export function ligneSignal(p, s) {
  const extrait = p.texte.length > 140 ? `${p.texte.slice(0, 137)}…` : p.texte;
  const quoi = s.type === 'longue' ? `${s.mots} mots (seuil ${s.seuil})` : s.type === 'consigne-longue' ? `consigne de ${s.mots} mots (seuil ${s.seuil})`
    : s.type === 'passif' ? `voix passive ? (« ${s.forme} »)` : 'point-virgule : deux idées ?';
  return `${p.ou}  ${quoi} : « ${extrait} »`;
}

// ── la commande : cadence ecriture ──────────────────────────────────────────────────────────────────────────────────────────────

/** Les fichiers .md, .txt et .json d'un chemin (dossier parcouru, sans .git ni node_modules), triés. */
export function fichiersDe(racine, chemin) {
  const abs = resolve(racine, chemin);
  if (!existsSync(abs)) throw new Error(`${chemin} : introuvable`);
  if (!statSync(abs).isDirectory()) return [abs];
  return readdirSync(abs, { withFileTypes: true }).filter((e) => !['.git', 'node_modules'].includes(e.name))
    .flatMap((e) => (e.isDirectory() ? fichiersDe(racine, join(abs, e.name)) : /\.(md|txt|json)$/.test(e.name) ? [join(abs, e.name)] : []))
    .sort();
}

/** Le nom d'un fichier dans la sortie : relatif au dossier courant quand il y est, sinon absolu. */
export const nomDe = (racine, abs) => { const r = relative(racine, abs); return r.startsWith('..') ? abs : r; };

export const AIDE = `cadence ecriture [chemin…] [--nouveautes] [--dir docs/nouveautes] [--jour J | --depuis J] [--seuil n] [--seuil-consigne n] [--json | --resume] [--strict]
  Signale, sans rien réécrire, les phrases longues (plus de 25 mots, 20 pour une consigne), la voix passive et le point-virgule, et donne la moyenne
  de mots par phrase. Sans chemin : les entrées Nouveautés du dépôt. Un chemin : fichier ou dossier (.md, .txt, .json), un rapport de revue par exemple.
  --jour / --depuis gardent les fichiers dont le front matter date de ce jour (ou après) ; --resume n'écrit que les lignes de bilan ; --json pour un script ;
  --strict sort en 1 s'il y a un signal. Réglages : clé ecriture: de cadence.yaml (docs/ecriture.md).`;

const OPTIONS = { nouveautes: { type: 'boolean' }, dir: { type: 'string' }, jour: { type: 'string' }, depuis: { type: 'string' }, seuil: { type: 'string' },
  'seuil-consigne': { type: 'string' }, json: { type: 'boolean' }, resume: { type: 'boolean' }, strict: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } };

/** Les options lues et contrôlées, et les réglages : cadence.yaml du dossier courant, puis --seuil et --seuil-consigne. */
async function lireOptions(argv, cwd) {
  const { parseArgs } = await import('node:util');
  const { values: o, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  for (const k of ['jour', 'depuis']) if (o[k] != null && !JOUR.test(o[k])) throw new Error(`--${k} : date AAAA-MM-JJ attendue`);
  if (o.jour && o.depuis) throw new Error('--jour et --depuis s’excluent');
  if (o.json && o.resume) throw new Error('--json et --resume s’excluent');
  const y = join(cwd, 'cadence.yaml');
  const { parse } = await import('yaml');
  const reglages = lireEcriture(existsSync(y) ? parse(readFileSync(y, 'utf8'))?.ecriture : undefined, 'cadence.yaml');
  for (const [opt, cle] of [['seuil', 'phrase'], ['seuil-consigne', 'consigne']]) {
    if (o[opt] == null) continue;
    if (!/^[1-9]\d*$/.test(o[opt])) throw new Error(`--${opt} : nombre de mots entier positif attendu`);
    reglages[cle] = Number(o[opt]);
  }
  return { o, chemins: positionals, reglages };
}

/** Les fichiers à lire, avec leur groupe : les Nouveautés (sans chemin, ou avec --nouveautes) puis les chemins donnés, filtrés par --jour / --depuis. */
function aLire(cwd, o, chemins) {
  const r = [];
  if (!chemins.length || o.nouveautes) {
    const dir = resolve(cwd, o.dir ?? 'docs/nouveautes');
    const entrees = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md') && e.name.toLowerCase() !== 'readme.md') : [];
    for (const e of entrees.map((x) => x.name).sort()) r.push({ abs: join(dir, e), groupe: 'nouveautes' });
  }
  for (const c of chemins) for (const abs of fichiersDe(cwd, c)) r.push({ abs, groupe: 'fichiers' });
  if (!o.jour && !o.depuis) return r;
  return r.filter((f) => {
    const d = f.abs.endsWith('.json') ? null : jourDuFrontMatter(readFileSync(f.abs, 'utf8'));
    return d == null ? f.groupe === 'fichiers' : o.jour ? d === o.jour : d >= o.depuis;
  });
}

const TITRES = { nouveautes: 'Nouveautés', fichiers: 'Autres fichiers' };

/** Le résultat complet (celui de --json) : réglages, un bilan par fichier, par groupe et au total, et les signalements. */
export function mesurer(cwd, fichiers, reglages) {
  const parFichier = fichiers.map((f) => ({ ...f, nom: nomDe(cwd, f.abs), phrases: analyserFichier(f.abs, nomDe(cwd, f.abs), reglages) }));
  const groupes = {};
  for (const g of Object.keys(TITRES)) {
    const de = parFichier.filter((f) => f.groupe === g);
    if (de.length) groupes[g] = { fichiers: de.length, ...bilan(de.flatMap((f) => f.phrases)) };
  }
  const toutes = parFichier.flatMap((f) => f.phrases);
  return {
    reglages,
    total: { fichiers: parFichier.length, ...bilan(toutes) },
    groupes,
    fichiers: parFichier.map((f) => ({ fichier: f.nom, groupe: f.groupe, ...bilan(f.phrases) })),
    signalements: toutes.flatMap((p) => p.signaux.map((s) => ({ ou: p.ou, ...s, texte: p.texte }))),
    lignes: toutes.flatMap((p) => p.signaux.map((s) => ligneSignal(p, s))),
  };
}

/** La sortie : le JSON (--json), ou les signaux (sauf --resume) puis une ligne de bilan par groupe et le total quand il y en a deux. */
function ecrire(io, o, res) {
  const { lignes, ...sansLignes } = res;
  if (o.json) return io.out(JSON.stringify(sansLignes, null, 2));
  if (!o.resume) for (const l of lignes) io.out(l);
  for (const [g, b] of Object.entries(res.groupes)) io.out(ligneBilan(TITRES[g], b.fichiers, b));
  if (Object.keys(res.groupes).length > 1) io.out(ligneBilan('Total', res.total.fichiers, res.total));
  if (!res.total.fichiers) io.out('ecriture : aucun fichier à lire');
}

/** `cadence ecriture` : 0, ou 1 avec --strict quand un signal est levé ; 2 pour une option, un réglage ou un fichier illisible. */
export async function main(argv, io) {
  let opts, res;
  try {
    opts = await lireOptions(argv, io.cwd);
    if (opts.o.help) { io.out(AIDE); return 0; }
    res = mesurer(io.cwd, aLire(io.cwd, opts.o, opts.chemins), opts.reglages);
  } catch (e) {
    io.err(`ecriture : ${e.message}`);
    return 2;
  }
  ecrire(io, opts.o, res);
  return opts.o.strict && res.signalements.length ? 1 : 0;
}

if (process.argv[1] === SCRIPT) {
  process.exitCode = await main(process.argv.slice(2), { cwd: process.cwd(), out: (l) => console.log(l), err: (l) => console.error(l) });
}
