// Définition unique de « lire » et « écrire » dans un transcript Claude Code (R30, R31), partagée par le hook
// lecture-obligatoire.mjs (bras candidat) et par la mesure lectureReferences (src/sequence/mesures.ts).
// Lire = COUVRIR le fichier avec des Read RÉUSSIS (tool_result sans is_error) : texte, l'union des [offset, offset+limit)
// couvre toutes ses lignes ; PDF, l'union des `pages` couvre toutes ses pages (un Read sans pages réussi couvre tout) ;
// image, un Read réussi. JavaScript sans dépendance : le hook tourne sous node nu.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Outils qui écrivent un fichier ; Bash : voir ecritureBash. */
export const ECRITURES = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const LIMITE_READ = 2000; // défauts de Read : offset 1, limit 2000
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

export const cheminOutil = (input) => { const f = input?.file_path ?? input?.notebook_path; return typeof f === 'string' ? f : undefined; };

/** Chemin réel (liens résolus) ; un chemin qui n'existe pas encore garde son nom sous l'ancêtre réel. */
export function reel(p) {
  const a = resolve(p);
  try { return realpathSync(a); } catch { const d = dirname(a); return d === a ? a : join(reel(d), basename(a)); }
}

export const dansClone = (p, clone) => {
  const r = relative(reel(clone), reel(p));
  return r !== '..' && !r.startsWith('../') && !isAbsolute(r);
};

/** Réglages de Claude Code (R32) : tout ce qui est sous ~/.claude/, et tout `.claude/settings*.json` (disableAllHooks y couperait le hook). */
export const reglageClaude = (p, home) => (!!home && dansClone(p, join(home, '.claude'))) || (basename(dirname(reel(p))) === '.claude' && /^settings.*\.json$/.test(basename(p)));
/** Contournement par un appel d'outil : écriture d'un réglage de Claude Code, ou commande Bash qui y touche. */
export const contournement = (name, input, home) => (ECRITURES.includes(name) && !!cheminOutil(input) && reglageClaude(cheminOutil(input), home))
  || (name === 'Bash' && /disableAllHooks|\.claude\/settings/.test(String(input?.command ?? '')));

/** Une commande Bash écrit-elle dans `clone` ? Redirection > >>, tee, rm, touch, patch, truncate, cp, mv, install, ln (cible), sed/perl -i,
 * git apply/checkout/restore/reset/merge/stash…, --write/--fix, ng/nest generate, python -c|- / node -e|- qui écrit (heredoc : oui). Cible dans le clone, ou relative depuis un dossier courant dans le clone. Dans le doute : oui. */
export function ecritureBash(cmd, clone, cwd = clone) {
  let dir = cwd;
  const dedans = (t) => !!t && t !== '/dev/null' && dansClone(resolve(dir, t.replace(/^(['"])(.*)\1$/, '$2')), clone);
  const texte = String(cmd).replace(/(<<-?\s*['"]?(\w+)['"]?[^\n]*)\n[\s\S]*?\n\s*\2(?=\n|$)/g, '$1') // corps des heredocs retirés
    .replace(/'[^']*'|"[^"]*"/g, (q) => (/[>|;&\n]/.test(q) ? '""' : q)); // guillemets qui cachent un opérateur
  for (const seg of texte.split(/&&|\|\|?|;|\n/)) {
    for (const m of seg.matchAll(/(?<![<>=-])(?:\d|&)?>>?\s*([^\s;&|<>()]+)/g)) if (dedans(m[1])) return true;
    const mots = seg.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
    while (/^\w+=/.test(mots[0] ?? '')) mots.shift();
    const [c, ...args] = mots, noms = args.filter((a) => !a.startsWith('-')), opts = args.filter((a) => a.startsWith('-'));
    if (c === 'cd' && noms[0]) dir = resolve(dir, noms[0].replace(/^(['"])(.*)\1$/, '$2'));
    else if (/^(tee|rm|touch|truncate)$/.test(c) ? noms.some(dedans) : /^(cp|mv|install|ln)$/.test(c) ? dedans(noms.at(-1)) : false) return true;
    else if (c === 'patch' && (dansClone(dir, clone) || noms.some(dedans))) return true;
    else if (/^(sed|perl)$/.test(c) && opts.some((o) => /^-[a-zA-Z]*i|^--in-place/.test(o)) && noms.filter((a) => !/^['"]/.test(a)).some(dedans)) return true;
    else if ((opts.some((o) => /^--(write|fix)(=|$)/.test(o)) || (/^(ng|nest)$/.test(c === 'npx' ? noms[0] : c) && noms.some((a) => /^(g|generate)$/.test(a)))) && (dansClone(dir, clone) || noms.some(dedans))) return true;
    else if (c === 'git') {
      const k = args.indexOf('-C'), g = k >= 0 ? resolve(dir, args[k + 1]) : dir, s = args.indexOf('stash');
      if ((args.some((a) => /^(apply|checkout|restore|reset|merge|pull|rebase|cherry-pick|revert|am|clean|switch|mv|rm)$/.test(a)) || (s >= 0 && !/^(list|show)$/.test(args[s + 1] ?? ''))) && dansClone(g, clone)) return true;
    } else if (/^(python3?|node)$/.test(c ?? '') && opts.some((o) => /^-[ce]?$/.test(o)) && /write|<</i.test(seg) && (dansClone(dir, clone) || seg.includes(clone))) return true;
  }
  return false;
}

/** Appels d'outils (assistant) et résultats (tool_result) d'une ligne de transcript, sous-agents compris.
 * Chemin rapide : une ligne de résultats sans `"is_error":true` n'est pas analysée, ses ids sont lus par motif. */
export function evenements(ligne) {
  if (!ligne.includes('"tool_use"') && ligne.includes('"tool_use_id"') && !ligne.includes('"is_error":true'))
    return { appels: [], resultats: [...ligne.matchAll(/"tool_use_id":"([^"]+)"/g)].map((m) => ({ id: m[1], erreur: false })) };
  let d;
  try { d = JSON.parse(ligne); } catch { return { appels: [], resultats: [] }; }
  const c = Array.isArray(d?.message?.content) ? d.message.content : [];
  return {
    appels: d?.type === 'assistant' ? c.filter((x) => x?.type === 'tool_use' && typeof x.name === 'string').map((x) => ({ id: x.id, name: x.name, input: x.input ?? {}, cwd: d.cwd })) : [],
    resultats: c.filter((x) => x?.type === 'tool_result' && typeof x.tool_use_id === 'string').map((x) => ({ id: x.tool_use_id, erreur: x.is_error === true })),
  };
}

const compte = new Map();
const memo = (cle, f) => { if (!compte.has(cle)) compte.set(cle, f()); return compte.get(cle); };
/** Nombre de lignes au sens de Read (un saut final ne compte pas). */
const lignesDe = (f) => memo(`l:${f}`, () => { const t = readFileSync(f, 'utf8'); return t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0); });
/** Pages d'un PDF : pdfinfo, sinon objets /Type /Page ; null si inconnu. */
export const pagesDe = (f) => memo(`p:${f}`, () => Number(/^Pages:\s+(\d+)/m.exec(spawnSync('pdfinfo', [f], { encoding: 'utf8' }).stdout ?? '')?.[1])
  || (readFileSync(f, 'latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length || null);
const plages = (pages) => String(pages).split(',').map((s) => s.trim().split('-').map(Number)).map(([a, b]) => [a, b ?? a]);
/** Les intervalles [a, b] couvrent-ils 1..n ? */
const couvre = (iv, n) => [...iv].sort((x, y) => x[0] - y[0]).reduce((j, [a, b]) => (a > j + 1 ? j : Math.max(j, b)), 0) >= n;

/** Couverture d'un fichier par ses Read réussis : { entiere, pages_inconnues }. */
export function couverture(f, inputs) {
  if (!inputs.length) return { entiere: false, pages_inconnues: false };
  if (IMAGE.test(f)) return { entiere: true, pages_inconnues: false };
  if (/\.pdf$/i.test(f)) {
    if (inputs.some((i) => i.pages === undefined)) return { entiere: true, pages_inconnues: false };
    const iv = inputs.flatMap((i) => plages(i.pages)).filter(([a, b]) => a > 0 && b >= a);
    const n = pagesDe(f);
    if (n !== null) return { entiere: couvre(iv, n), pages_inconnues: false };
    return { entiere: iv.length > 0 && couvre(iv, Math.max(...iv.map((x) => x[1]))), pages_inconnues: true };
  }
  const iv = inputs.map((i) => { const a = Math.max(1, Number(i.offset ?? 1)); return [a, a + Number(i.limit ?? LIMITE_READ) - 1]; });
  return { entiere: couvre(iv, lignesDe(f)), pages_inconnues: false };
}

/** Pour chaque pièce : lue (au moins un Read réussi), entière (couverte), nombre de pages inconnu.
 * `appels` : Read retenus (déjà filtrés par fenêtre) ; `ok` : ids des résultats sans erreur. */
export function lectures(appels, ok, pieces) {
  const parPiece = new Map(pieces.map((p) => [reel(p), []]));
  for (const a of appels) if (a.name === 'Read' && cheminOutil(a.input) && ok.has(a.id)) parPiece.get(reel(cheminOutil(a.input)))?.push(a.input);
  return new Map(pieces.map((p) => {
    const inputs = parPiece.get(reel(p));
    const c = (() => { try { return couverture(p, inputs); } catch { return { entiere: false, pages_inconnues: false }; } })(); // illisible : jamais entière
    return [p, { lue: inputs.length > 0, ...c }];
  }));
}

// ─── L808 : chemins cités par un appel d'outil et leur classement (fuites du banc, R21) ─────────────────────────────────────────────────────────
// Une seule définition, partagée par le détecteur de fuites (src/bench/fuites.ts, après coup) et par le hook du bras candidat (au banc, avant
// l'appel) : le hook refuse exactement ce que le détecteur compterait comme fuite certaine, avec les règles (zones) que la séquence lui passe.

/** Dossier des transcripts de Claude Code pour un dossier de travail. */
export const dossierTranscripts = (home, cwd) => join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

/** Zones dont toute mention est une fuite certaine : secrets, évaluations, rapports et bancs du banc, vrais dépôts, transcripts de Claude Code. */
export const zonesCertaines = (home, racine) => [join(racine, 'secrets'), join(racine, 'eval'), join(racine, 'rapports'), join(racine, 'bancs'),
  join(home, 'projects'), join(home, '.claude', 'projects')];

/** Toutes les chaînes d'une valeur JSON. */
export function* textes(v) {
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* textes(x);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) yield* textes(x);
}

const sousUn = (p, prefixes) => prefixes.some((x) => p === x || p.startsWith(`${x}/`));
const globale = (x) => { try { return new RegExp(`^${x.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`); } catch { return /./; } };
function accolades(t) {
  const m = /^(.*?)\{([^{}$]*,[^{}]*)\}(.*)$/s.exec(t);
  return m ? m[2].split(',').flatMap((x) => accolades(m[1] + x + m[3])) : [t];
}
// Chemin absolu du jeton (~, $HOME, absolu, « . » ou « .. », ou relatif à cwd s'il contient « / » ou « .. »), sinon null.
function resoudre(tok, cwd, home, rel, cd = false) {
  if (rel && /^\.\.?\/?$/.test(tok)) return resolve(cwd, tok); // revue L817 r1 : « .. » aussi, que le retrait du point final effacerait
  const t = tok.replace(/(?<![./])\.+$/, '').replace(/[,:]+$/, '');
  if (/^(~|\$HOME)(\/|$)/.test(t)) return resolve(home, t.replace(/^(~|\$HOME)\/?/, ''));
  if (t.startsWith('/')) return resolve(t);
  return rel && (cd || t.includes('/') || /^c\d+/.test(t)) ? resolve(cwd, t) : null;
}
/** L817 : commande qui lit récursivement ses dossiers (find ~ lit ~/projects) ; son dossier courant si elle n'en nomme aucun. */
const recursive = (nom, etape) => /^(find|fd|fdfind|tree|du|rg|ag|ack|tar|rsync)$/.test(nom)
  || (/^([ef]?grep|cp|scp|chmod|chown|diff|zip)$/.test(nom) && /\s(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)/.test(etape)) || (nom === 'ls' && /\s(-[a-zA-Z]*R[a-zA-Z]*|--recursive)(?=\s|$)/.test(etape));
const tout = (p) => p.replace(/\/?$/, '/**');

// Revue L808 r1 (M1) : seul ce qui est LU compte. Un texte écrit (content d'un Write, old_string d'un Edit, motif d'un Grep, message de commit, corps
// d'un heredoc donné à cat) qui cite un chemin n'ouvre pas ce chemin : 128 fichiers de maritime-atlas citent ~/projects, les éditer n'est pas une fuite.
const CHAMPS_CHEMIN = ['file_path', 'path', 'notebook_path'];
/** Filtres qui ne lisent pas comme chemin ou commande ce qu'un echo leur envoie (L817) : un echo écrit dans un fichier par eux reste un texte écrit. */
const FILTRE = /^(tee|cat|sort|uniq|head|tail|wc|tr|cut|column|fold|nl|[ef]?grep|rg|less|more)$/;
const INTERPRETE = /(^|[\s;&|(])(python[\d.]*|node|bash|sh|zsh|perl|ruby|deno|bun|tsx|ts-node|psql|sqlite3|awk|sed)(?![\w.-])/;

/** La commande Bash sans ses textes écrits (remplacés par des espaces) : corps d'un heredoc dont la ligne ne lance pas d'interprète (un script donné à
 * python, node, bash… est du code, gardé), message de `git commit|tag|merge|revert|notes|stash -m`, arguments entre guillemets de echo et printf dont la sortie
 * va à un fichier ou à un filtre qui ne lit pas (FILTRE ; L817 : sh, while read, xargs, parallel les lisent, et rien n'est effacé dans $(…) ni dans un sous-shell),
 * motif de grep et rg (premier nom qui n'est pas l'argument d'une option ; aucun avec --files ou --type-list). Un mot qui porte `$(` ou un accent grave est gardé. Dans le doute : gardé. */
const MARQUE = /<<-?\s*['"]?\w+['"]?/g; // « <<'EOF' » d'un heredoc au corps retiré : sans lui, ce marqueur ouvrirait un faux heredoc jusqu'au « EOF » suivant (cites, L872)
export function commandeLue(cmd) {
  const t = String(cmd).replace(/^([^\n]*<<-?\s*['"]?(\w+)['"]?[^\n]*)\n[\s\S]*?\n\s*\2(?=\n|$)/gm, (tout, tete) => (INTERPRETE.test(tete) ? tout : tete.replace(MARQUE, ' ')));
  const effaces = [], effacer = (m) => { if (m && !/\$\(|`/.test(m.s)) effaces.push(m); };
  let mots = [], echos = [], lu = false, prof = 0; // echos : arguments d'echo et de printf du tube, effacés à sa fin si rien ne les lit (lu) ; prof : ( et $( ouverts
  const finir = (tube) => {
    if (!mots.length) return;
    while (/^\w+=/.test(mots[0]?.s ?? '')) mots.shift();
    const [c, ...args] = mots, nom = c?.s.replace(/^.*\//, '') ?? '';
    mots = [];
    if (nom !== 'echo' && nom !== 'printf' && !FILTRE.test(nom)) lu = true; // revue r2 et L817 : xargs, sh, while read, parallel… lisent ce qu'on leur envoie
    if (nom === 'git' && args.some((a) => /^(commit|tag|merge|revert|notes|stash)$/.test(a.s)))
      args.forEach((a, k) => { if (/^--message=/.test(a.s)) effacer(a); else if (/^(-[a-zA-Z]*m|--message)$/.test(a.s)) effacer(args[k + 1]); });
    else if ((nom === 'echo' || nom === 'printf') && !prof) echos.push(...args.filter((a) => /^['"]/.test(a.s)));
    else if (/^([ef]?grep|rg)$/.test(nom)) {
      args.forEach((a, k) => { if (/^--regexp=/.test(a.s)) effacer(a); else if (/^(-[a-zA-Z]*e|--regexp)$/.test(a.s)) effacer(args[k + 1]); });
      // sans -e ni -f : le premier nom qui n'est pas l'argument d'une option (L817 : -m 1, -A 3, -g "*.md") est le motif ; avec --files ou --type-list (rg,
      // revue r2), aucun motif : « rg --files <dossier> » lit le dossier
      const opt = nom === 'rg' ? /^-[^-mABCgtTjMEref]*[mABCgtTjMEr]$|^--(max-count|context|after-context|before-context|glob|iglob|type|type-not|max-depth|replace|sort|threads)$/
        : /^-[^-mABCdDef]*[mABCdD]$|^--(max-count|context|after-context|before-context|include|exclude|exclude-dir|directories|devices|binary-files|label)$/;
      let k = 0;
      while (k < args.length && args[k].s.startsWith('-') && args[k].s !== '--') k += opt.test(args[k].s) ? 2 : 1;
      if (!args.some((a) => /^(-[a-zA-Z]*[ef]|--regexp|--file|--files|--type-list)$|^--(regexp|file)=/.test(a.s))) effacer(args[args[k]?.s === '--' ? k + 1 : k]);
    }
    if (tube) return;
    if (!lu) echos.forEach(effacer);
    echos = [];
    lu = false;
  };
  for (let i = 0; i < t.length;) {
    if (/[\n;|&()]/.test(t[i])) { finir(t[i] === '|' && t[i + 1] !== '|'); prof = Math.max(0, prof + (t[i] === '(') - (t[i] === ')')); i++; continue; }
    if (/\s/.test(t[i])) { i++; continue; }
    const d = i;
    for (let q = ''; i < t.length; i++) {
      const x = t[i];
      if (q) { if (x === '\\' && q === '"') i++; else if (x === q) q = ''; }
      else if (x === '\'' || x === '"') q = x;
      else if (x === '\\') i++;
      else if (/[\s;|&()]/.test(x)) break;
    }
    mots.push({ d, f: i, s: t.slice(d, i) });
  }
  finir();
  return effaces.reduce((r, m) => r.slice(0, m.d) + ' '.repeat(m.f - m.d) + r.slice(m.f), t);
}

/** L817 : le glob p (préfixe littéral pre) peut-il désigner la zone z, un chemin sous elle ou un ancêtre qui la contient (ls ~/proj*, ls ~/*\/x) ? */
function peutViser(p, pre, z) {
  const b = pre.replace(/\/$/, ''), g = p.slice(b.length + 1).split('/'), c = z.slice(b.length + 1).split('/');
  if (!z.startsWith(`${b}/`)) return false;
  for (let i = 0; i < Math.min(g.length, c.length); i++) { if (g[i].includes('**')) return true; if (!globale(g[i]).test(c[i])) return false; }
  return true;
}

/** L872 (revue r2) : ce qui lit un texte cité. Un interprète non shell ou sed le lit sans le développer ; un shell (`bash -c`, `eval`, heredoc donné
 * à sh) développe « /* » en chemins. Un nom de shell sur la même commande (`bash -c 'sed "…"'`) l'emporte : dans le doute, le texte reste lu. */
const NON_SHELL = /(^|[\s;&|(/])(python[\d.]*|node|perl|ruby|deno|bun|tsx|ts-node|awk|sed)(?![\w.-])/;
const SHELL = /(^|[\s;&|(/])((ba|z|da|k)?sh|eval|source)(?![\w.-])|(^|[\s;&|(])\.\s/;
const texteSeul = (tete) => NON_SHELL.test(tete) && !SHELL.test(tete);

/** L872 : positions de `t` lues comme TEXTE, que rien ne développe en chemins : corps d'un heredoc et texte entre guillemets dont la commande
 * (la ligne du heredoc, ou ce qui précède le guillemet depuis le dernier séparateur) est celle d'un interprète non shell ou de sed (texteSeul). */
function cites(t) {
  const dans = new Uint8Array(t.length);
  for (const m of t.matchAll(/^([^\n]*<<-?\s*['"]?(\w+)['"]?[^\n]*)\n[\s\S]*?\n\s*\2(?=\n|$)/gm)) {
    if (texteSeul(m[1])) dans.fill(1, m.index + m[1].length + 1, m.index + m[0].length);
  }
  let debut = 0; // début de la commande simple en cours
  let texte = false; // le guillemet ouvert est-il lu comme texte ?
  for (let i = 0, q = ''; i < t.length; i++) {
    if (dans[i] && !q) continue; // corps d'un heredoc de texte : ses guillemets sont ceux du script
    if (q && t[i] === q) q = '';
    else if (q) {
      if (texte) dans[i] = 1;
      if (q === '"' && t[i] === '\\') { i++; if (texte) dans[i] = 1; }
    } else if (t[i] === '\\') i++;
    else if (t[i] === "'" || t[i] === '"') {
      q = t[i];
      texte = texteSeul(t.slice(debut, i));
    } else if (/[\n;|&(]/.test(t[i])) debut = i + 1;
  }
  return dans;
}
/** L872 : ouverture d'un commentaire C, JS, TS, Java ou CSS : « /* R14 », « /** Texte », « /**\n * … » (saut réel ou « \n » écrit), ou « /** » seul
 * entre guillemets après une indentation (« "  /**" », ancre d'un script python). Un « /* » suivi d'un « ; », d'un « | », d'un chiffre (« /* 2>/dev/null »,
 * revue r2) ou d'un chemin n'en est pas un. */
const COMMENTAIRE = /\/\*\*?(?=[ \t]+[\p{L}«]|(?:\n|\\n)[ \t]*\*(?!\/))|(?<=(['"])[ \t]+)\/\*\*?(?=\1)/gu;
/** Ce qui garde tout : « /** » récursif (globstar, zsh, recursive=True), ou un texte qui redevient du shell (tube vers sh, system, subprocess…). */
const GARDE = /globstar|\bzsh\b|recursive\s*=\s*True|\|\s*(ba|da|k)?sh\b|\bsystem\s*\(|subprocess|popen|child_process|execSync|spawn/;
/** L872 : la commande sans les marqueurs de commentaire qu'elle cite comme TEXTE d'un interprète non shell ou de sed (`sed "s|… /* R14 *\/ …|"`,
 * heredoc python). Un « /* » ou « /** » argument du shell (`for f in /**`, `echo /* | xargs …`) ou cité dans un script shell (`bash -c 'grep -rl x /* Docs'`,
 * `eval`, heredoc donné à bash : revue r2) reste lu. Aux bancs du 25-11, les 47 appels relevés « / » étaient tous de ces marqueurs. */
/** L899 : dans un texte cité, « / », « /* » ou « /** » qui n'ouvre aucun chemin (suivi d'une espace, d'un guillemet, d'un chiffre, d'une fin) : prose
 * (« lettre / pression »), division, commentaire (« /* 2026-11-26 : … »), délimiteur de sed (« s/a/b/ »). Bancs du 26-11 : les 8 « / » certains. */
const BARRE = /\/\**(?![\w.~$/*-])/g;
/** L899 : spécificateur d'import TS ou JS cité comme texte (`from '../../services/x'`) : un nom de module, pas un fichier que la commande ouvre. */
const IMPORT = /(?<=\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])[^'"\n]*\1/g;
/** L899 : « '/' » seul dans une ligne qui parcourt des dossiers (os.walk('/'), glob('/*'), Path('/').iterdir()) reste lu. */
const PARCOURT = /\b(walk|listdir|scandir|iterdir|r?glob|iglob|readdirSync|readdir|opendir|chdir|Path)\s*\(/;
const ligneDe = (t, i) => t.slice(t.lastIndexOf('\n', i - 1) + 1, (t.indexOf('\n', i) + 1 || t.length + 1) - 1);
function sansCommentaires(t) {
  if (GARDE.test(t)) return t;
  const dans = cites(t), blanc = (m) => ' '.repeat(m.length);
  return t.replace(COMMENTAIRE, (m, _q, i) => (dans[i] ? blanc(m) : m)).replace(IMPORT, (m, _q, i) => (dans[i] ? blanc(m) : m))
    .replace(BARRE, (m, i) => (dans[i] && !(/['"]/.test(t[i - 1] ?? '') && t[i - 1] === t[i + m.length] && PARCOURT.test(ligneDe(t, i))) ? blanc(m) : m));
}

/** Chemins absolus (globs gardés) que LIT un appel d'outil : ses champs de chemin (file_path, path, notebook_path ; le motif d'un Glob, depuis son
 * `path`), relatifs au dossier courant, et pour Bash le dossier courant et la commande sans ses textes écrits (commandeLue), avec ses chemins relatifs,
 * ses `cd` et ses accolades. Jamais un contenu écrit ni un motif de recherche. `cwd` : dossier courant de l'appel ; `depart` : à défaut de cwd.
 * L817 : Grep et une commande récursive lisent aussi tout sous leurs dossiers (`<d>/**`) ; `cd` seul va dans ~ ; depuis un dossier qui contient une zone
 * de `certains` (après `cd ~`), tout nom est un chemin relatif (« ls projects »). L872 : sans les marqueurs de commentaire cités (sansCommentaires). */
export function* cheminsCites(name, input, cwd, depart, home, certains = []) {
  const abs = typeof cwd === 'string' && isAbsolute(cwd), base = abs ? cwd : depart;
  const absolu = (v, d) => (/^(~|\$HOME)(\/|$)/.test(v) ? resolve(home, v.replace(/^(~|\$HOME)\/?/, '')) : resolve(d, v));
  const champ = (k) => (typeof input?.[k] === 'string' && input[k] ? input[k] : null);
  for (const k of CHAMPS_CHEMIN) if (champ(k)) yield absolu(champ(k), base);
  if (name === 'Glob' && champ('pattern')) yield absolu(champ('pattern'), champ('path') ? absolu(champ('path'), base) : base);
  if (name === 'Grep') yield tout(champ('path') ? absolu(champ('path'), base) : base);
  if (name !== 'Bash') return;
  if (abs) yield resolve(cwd);
  if (typeof input?.command !== 'string') return;
  let dir = base;
  for (const seg of sansCommentaires(commandeLue(input.command)).replace(/\$\{HOME\}/g, '$HOME').split(/&&|\|\||;|\n/)) {
    for (const v of accolades(seg)) {
      const cd = /^\s*cd(?:\s+(\S+)|\s*$)/.exec(v), nu = certains.some((z) => z.startsWith(dir === '/' ? '/' : `${dir}/`));
      const cible = cd ? (cd[1] ? resoudre(cd[1].replace(/^['"]|['"]$/g, ''), dir, home, true, true) : home) : null;
      for (const etape of v.split('|')) {
        const brut = /^\s*(?:\w+=\S*\s+)*(\S+)/.exec(etape)?.[1] ?? '', nom = brut.replace(/^.*\//, ''), rec = recursive(nom, etape);
        let explicite = false;
        // L899 : depuis un dossier qui contient une zone, le nom de la commande (« ls », « head ») et le descripteur d'une redirection (« 2>/dev/null »,
        // « 2>&1 ») ne sont pas des chemins relatifs (banc du 26-11, cd <banc>/r1 && ls c1.captures/ 2>/dev/null | head -40).
        for (const tok of etape.replace(/(?<=^|\s)\d+(?=>)|(?<=>)&\d+/g, ' ').split(/[\s'"`&<>(){}=]+/)) {
          const e = resoudre(tok, dir, home, true), p = e ?? (nu && /^[^-$]/.test(tok) && tok !== brut ? resolve(dir, tok) : null);
          if (!p) continue;
          explicite ||= !!e;
          yield p;
          if (rec) yield tout(p);
        }
        if (rec && !explicite) yield tout(dir);
      }
      if (cible) { yield cible; dir = cible; }
    }
  }
}

/** Classement d'un chemin cité selon les règles d'un bras ({ autorises, certains, runs }) : null (permis), ou { chemin, classe } avec le préfixe
 * littéral du chemin (avant son premier glob) et la classe « certaine » (zone interdite, autre clone du banc, glob qui peut en désigner un) ou
 * « a_verifier » (reste du dossier des runs : ancêtres du clone ; L817 : ancêtre d'une zone, qui en montre les noms, pas le contenu). */
export function classer(p, r) {
  const g = p.search(/[*?[]/); // glob : préfixe littéral ; en cas de doute (composant pouvant désigner un clone voisin), certaine
  const pre = g >= 0 ? p.slice(0, p.lastIndexOf('/', g)) || '/' : p;
  if (sousUn(pre, r.autorises)) return null;
  const sousRuns = sousUn(pre, [r.runs]);
  const comps = sousRuns ? p.slice(r.runs.length + 1).split('/').slice(2) : [];
  const premier = comps.findIndex((x) => /[*?[]/.test(x)); // seul le premier composant à glob peut désigner un dossier de clone
  if (sousUn(pre, r.certains) || comps.some((x, i) => /^c\d+(\.|$)/.test(x) || (i === premier && globale(x).test('c2')))
    || (g >= 0 && r.certains.some((z) => peutViser(p, pre, z))) || (sousRuns && p.includes('**'))) return { chemin: pre, classe: 'certaine' };
  return sousRuns || (pre !== '/' && r.certains.some((z) => z.startsWith(`${pre}/`))) ? { chemin: pre, classe: 'a_verifier' } : null;
}
