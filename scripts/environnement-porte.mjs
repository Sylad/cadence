// L764 : l'environnement où une porte va jouer, lu AVANT de la jouer. Le 17-11, cinq portes rouges trompeuses : node_modules installé avant le
// dernier package-lock.json (assets reconstruits avec l'ancien Tailwind, tests sautés), Node du PATH refusé par .nvmrc ou engines.node (Astro 7 refuse
// Node 22.22.3 ; la porte d'un cadence run hérite du PATH figé de la session du lead). Une seule lecture pour `cadence verify --gate` (src/verify-gate.ts)
// et la porte d'un `cadence run` (v2/src/run/run.ts). JavaScript sans dépendance, comme arbre-non-commite.mjs ; sa déclaration est environnement-porte.d.mts.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** La variable qui fait jouer la porte malgré un environnement périmé (un faux positif ne bloque jamais une porte). */
export const JOUER_QUAND_MEME = 'CADENCE_PORTE_ENV';

/** Profondeur des dossiers lus sous la racine de la porte (backend/, frontend/, packages/x/). */
const PROFONDEUR = 3;
const SAUTES = new Set(['node_modules', '.git', '.cadence-run', '.venv', 'dist']);
/** Écarts nommés par dossier ; au-delà, leur compte. */
const NOMMES = 5;

const lireJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

/** La racine et ses sous-dossiers jusqu'à PROFONDEUR, hors dépendances et dossiers de cadence. */
function dossiers(racine) {
  const vus = [racine];
  const descendre = (d, n) => {
    if (n >= PROFONDEUR) return;
    let entrees;
    try {
      entrees = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const x of entrees) {
      if (!x.isDirectory() || SAUTES.has(x.name) || x.name.startsWith('.')) continue;
      vus.push(join(d, x.name));
      descendre(join(d, x.name), n + 1);
    }
  };
  descendre(racine, 0);
  return vus;
}

const nomDe = (cle) => cle.slice(cle.lastIndexOf('node_modules/') + 'node_modules/'.length);

/**
 * (a) Les paquets dont la version installée (node_modules/.package-lock.json, écrit par npm à chaque installation) n'est pas celle de package-lock.json,
 * et ceux que le lockfile demande sans qu'ils soient installés (hors optionnels). [] quand node_modules est à jour ou qu'on ne peut rien en dire
 * (pas de node_modules, pas de lockfile v2+, pas de lockfile caché : installé par un autre outil).
 */
export function ecartsLockfile(dossier) {
  const verrou = lireJson(join(dossier, 'package-lock.json'));
  const cache = lireJson(join(dossier, 'node_modules', '.package-lock.json'));
  if (!verrou?.packages || !cache?.packages) return [];
  return Object.entries(verrou.packages).map(([cle, voulu]) => ecart(cle, voulu, cache.packages[cle])).filter(Boolean);
}

/** L'écart d'un paquet du lockfile (`voulu`) à ce qui est installé ; null s'il n'y en a pas, ou si le paquet n'est pas une dépendance installée par npm. */
function ecart(cle, voulu, installe) {
  if (!cle.includes('node_modules/') || voulu.link || voulu.inBundle) return null;
  if (!installe) return voulu.optional || voulu.devOptional ? null : `${nomDe(cle)} absent (${voulu.version ?? '?'} au lockfile)`;
  return voulu.version && installe.version !== voulu.version ? `${nomDe(cle)} ${installe.version ?? '?'} installé, ${voulu.version} au lockfile` : null;
}

// --- (b) versions de Node : .nvmrc, .node-version et engines.node (plages semver usuelles ; une syntaxe inconnue ne juge rien) ---

const PARTIELLE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+][0-9A-Za-z.+-]*)?$/;
/** Une version, éventuellement partielle (« 22 », « 22.12 », « 20.x ») : ses nombres jusqu'au premier joker ; null si ce n'en est pas une. */
function partielle(t) {
  const m = PARTIELLE.exec(t);
  if (!m) return null;
  const n = [];
  for (const p of m.slice(1, 4)) {
    if (p === undefined || /[xX*]/.test(p)) break;
    n.push(Number(p));
  }
  return n;
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const pleine = (n) => [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0];
/** La version qui suit une partielle au rang de son dernier nombre (22.12 → 22.13.0, 22 → 23.0.0). */
const suivante = (n) => (n.length === 1 ? [n[0] + 1, 0, 0] : [n[0], n[1] + 1, 0]);

/** Le haut exclu d'un « ^ » : la première version qui change le premier nombre non nul (^1.2 → 2.0.0, ^0.2.3 → 0.3.0, ^0.0.3 → 0.0.4). */
function hautCaret(n, bas) {
  if (bas[0] > 0 || n.length === 1) return [bas[0] + 1, 0, 0];
  return bas[1] > 0 || n.length === 2 ? [0, bas[1] + 1, 0] : [0, 0, bas[2] + 1];
}
const tilde = (n, bas) => [['>=', bas], ['<', n.length === 1 ? [bas[0] + 1, 0, 0] : [bas[0], bas[1] + 1, 0]]];
/** Par opérateur, les bornes d'une version partielle `n` non vide (`bas` : n complété de zéros). */
const OPERATEURS = {
  '>=': (n, bas) => [['>=', bas]],
  '<': (n, bas) => [['<', bas]],
  '>': (n, bas) => [n.length === 3 ? ['>', bas] : ['>=', suivante(n)]],
  '<=': (n, bas) => [n.length === 3 ? ['<=', bas] : ['<', suivante(n)]],
  '^': (n, bas) => [['>=', bas], ['<', hautCaret(n, bas)]],
  '~': tilde,
  '~>': tilde,
  '': (n, bas) => (n.length === 3 ? [['=', bas]] : [['>=', bas], ['<', suivante(n)]]),
};
OPERATEURS['='] = OPERATEURS[''];

/** Un comparateur (« >=22.12 », « ^20.19.0 », « ~1.2 », « 20.x ») en bornes [op, version pleine] ; null si illisible. */
function bornes(tok) {
  const m = /^(>=|<=|>|<|=|\^|~>?|)\s*(.*)$/.exec(tok);
  const op = m[1], n = partielle(m[2]);
  if (!n) return null;
  if (n.length === 0) return op === '<' || op === '>' ? [['<', [0, 0, 0]]] : [];
  return OPERATEURS[op](n, pleine(n));
}
const tient = (v, [op, b]) => ({ '>=': cmp(v, b) >= 0, '>': cmp(v, b) > 0, '<=': cmp(v, b) <= 0, '<': cmp(v, b) < 0, '=': cmp(v, b) === 0 })[op];

/** `version` (« v22.22.3 ») satisfait-elle `plage` (engines.node) ? null quand la plage n'est pas lisible : rien n'est jugé. */
export function satisfait(version, plage) {
  const v = partielle(version.trim());
  if (!v || v.length < 3) return null;
  const ensembles = String(plage).split('||').map((s) => s.trim());
  let lisible = true;
  for (const ens of ensembles) {
    // « 1.2.3 - 2.3.4 » : plage à trait d'union ; les opérateurs séparés de leur version (« >= 18 ») sont recollés.
    const toks = ens.replace(/(>=|<=|>|<|=|\^|~>?)\s+/g, '$1').split(/\s+/).filter(Boolean);
    const cmps = toks.length === 3 && toks[1] === '-' ? [`>=${toks[0]}`, `<=${toks[2]}`] : toks;
    const b = cmps.map(bornes);
    if (b.some((x) => x === null)) {
      lisible = false;
      continue;
    }
    if (b.flat().every((c) => tient(v, c))) return true;
  }
  return lisible ? false : null;
}

/**
 * La version de .nvmrc ou .node-version (« 22 », « v22.12.0 ») tenue par `version` ? null pour un alias (lts/*, node) : rien n'est jugé.
 * Revue L764 r1 (M1) : jamais au patch près. Toujours le même majeur ; quand une engines.node est déclarée, c'est elle qui dit le minimum (warhammer40k :
 * .nvmrc 22.23.5, engines >=22.12.0, Node 22.22.3 accepté) ; sans engines, la version de .nvmrc est un minimum dans son majeur (22.23.6 la tient).
 */
function tientNvmrc(version, voulu, auMajeur) {
  const n = partielle(voulu.trim()), v = partielle(version.trim());
  if (!n || !n.length || !v || v.length < 3) return null;
  if (v[0] !== n[0]) return false;
  return auMajeur || cmp(v, pleine(n)) >= 0;
}

/** La version de `node` que trouve le PATH de `env` (celui des commandes de la porte), ou null s'il n'y en a pas. */
export function nodeDuPath(env = process.env) {
  const r = spawnSync('node', ['--version'], { env, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

const RELANCER = 'puis relancer la porte depuis un shell où « node --version » la donne (la porte d\'un cadence run hérite du PATH de la session qui l\'a lancé : relancer cette session)';

/**
 * Ce qui rendrait la porte jouée dans `racine` trompeuse, chaque problème avec la commande qui remet à niveau : { probleme, remede }[] ; [] si rien.
 * `env` : l'environnement des commandes de la porte (son PATH trouve le Node qu'elles lanceront). `node` : la version déjà lue (tests), sinon `nodeDuPath(env)`.
 */
// `arbre` (revue L764 r1, M2) : le dossier qui fournit les dépendances de `racine` et que nomment les remises à niveau — l'arbre principal quand la porte
// joue dans une copie jetable, retirée à la fin de la porte (src/verify-gate.ts) ; `racine` elle-même sinon.
export function environnementPerime(racine, env = process.env, node, { arbre = racine } = {}) {
  const dirs = dossiers(racine);
  return [...perimesLockfile(racine, dirs, arbre), ...perimesNode(racine, dirs, env, node, arbre)];
}

const nomRelatif = (racine, d) => relative(racine, d) || '.';

const lireTexte = (f) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};

/** Le dossier de `arbre` qui correspond à `d` (un dossier de `racine`). */
const dansArbre = (racine, arbre, d) => (arbre === racine ? d : join(arbre, relative(racine, d)));

/**
 * La remise à niveau de node_modules de `d`. Dans une copie, ses node_modules viennent de l'arbre principal : `npm ci` y remet la copie à niveau à la porte
 * suivante seulement si son package-lock.json est celui de la copie ; sinon (arbre principal à un autre commit, ou lockfile modifié) aucune commande ne le peut.
 */
function remiseLockfile(racine, arbre, d) {
  const cible = dansArbre(racine, arbre, d);
  if (cible === d || lireTexte(join(cible, 'package-lock.json')) === lireTexte(join(d, 'package-lock.json'))) return `cd ${cible} && npm ci`;
  return `aucune possible depuis l'arbre principal ${arbre} : son ${nomRelatif(racine, d)}/package-lock.json n'est pas celui du commit joué, dont la copie reprend les node_modules`
    + ` (HEAD à un autre commit, ou lockfile modifié) — ${JOUER_QUAND_MEME}=jouer joue la porte quand même ; sinon la rejouer une fois l'arbre principal au sha et « cd ${cible} && npm ci » fait`;
}

/** (a) Les dossiers dont node_modules est en retard sur package-lock.json. */
function perimesLockfile(racine, dirs, arbre) {
  const problemes = [];
  for (const d of dirs.filter((x) => existsSync(join(x, 'package-lock.json')) && existsSync(join(x, 'node_modules')))) {
    const e = ecartsLockfile(d), nom = nomRelatif(racine, d);
    if (!e.length) continue;
    const dits = e.slice(0, NOMMES).join(' ; ') + (e.length > NOMMES ? ` ; et ${e.length - NOMMES} autre(s)` : '');
    problemes.push({ probleme: `${nom}/node_modules n'est pas à jour de ${nom}/package-lock.json (${e.length} écart(s) : ${dits})`, remede: remiseLockfile(racine, arbre, d) });
  }
  return problemes;
}

/** Les versions de Node demandées : .nvmrc et .node-version de la racine, engines.node de la racine et des projets installés
 * (un package.json de fixture de test ne dit rien du Node de la porte). */
function exigencesNode(racine, dirs, arbre) {
  const engines = [];
  for (const d of dirs.filter((x) => x === racine || existsSync(join(x, 'package-lock.json')))) {
    const plage = lireJson(join(d, 'package.json'))?.engines?.node, nom = nomRelatif(racine, d);
    if (typeof plage !== 'string' || !plage.trim()) continue;
    engines.push({ ou: `${nom === '.' ? '' : `${nom}/`}package.json (engines.node)`, voulu: plage.trim(), juge: (v) => satisfait(v, plage), installer: `installer et activer un Node dans « ${plage.trim()} » (nvm install <version> && nvm use <version>)` });
  }
  const nvmrc = [];
  for (const f of ['.nvmrc', '.node-version'].filter((x) => existsSync(join(racine, x)))) {
    const voulu = readFileSync(join(racine, f), 'utf8').split('\n')[0].trim();
    if (voulu) nvmrc.push({ ou: f, voulu, juge: (v) => tientNvmrc(v, voulu, engines.length > 0), installer: `cd ${arbre} && nvm install ${voulu} && nvm use ${voulu}` });
  }
  return [...nvmrc, ...engines];
}

/** (b) Le Node du PATH de la porte hors des versions demandées ; `node` : la version déjà lue (tests), sinon lue sur le PATH de `env`. */
function perimesNode(racine, dirs, env, node, arbre) {
  const exigences = exigencesNode(racine, dirs, arbre);
  if (!exigences.length) return [];
  const v = node === undefined ? nodeDuPath(env) : node;
  if (v === null) return [{ probleme: `aucun node sur le PATH de la porte, alors que ${exigences.map((x) => `${x.ou} demande ${x.voulu}`).join(', ')}`, remede: `${exigences[0].installer}, ${RELANCER}` }];
  return exigences.filter((x) => x.juge(v) === false).map((x) => ({ probleme: `le Node du PATH de la porte est ${v}, ${x.ou} demande ${x.voulu}`, remede: `${x.installer}, ${RELANCER}` }));
}

/** Les lignes qui disent l'environnement périmé et sa remise à niveau, préfixées par `qui` (« verify --gate abc1234 », « porte du run »). */
export function lignesPerime(qui, problemes) {
  return [
    `${qui} : environnement périmé, rien n'est joué (ses rouges seraient trompeurs) :`,
    ...problemes.flatMap((p) => [`  - ${p.probleme}`, `    remise à niveau : ${p.remede}`]),
    `  (faux positif : ${JOUER_QUAND_MEME}=jouer joue la porte quand même)`,
  ];
}

/** L'environnement est-il à ignorer (CADENCE_PORTE_ENV=jouer) ? */
export const ignorerPerime = (env = process.env) => env[JOUER_QUAND_MEME] === 'jouer';
