// Porte rapide de cadence run (L838, D-33, étude L835) : pendant le run, l'étape des tests ne joue que les tests touchés par le diff du lot ; la suite
// complète reste jouée une fois, à la porte de livraison (`cadence verify --gate`, que le hook pre-push exige pour le sha poussé). Le 25-11, la suite de
// cadence prenait 11 min sous charge (33 min sous CADENCE_TEST_WORKERS=4) à chaque porte de run, quand une porte rouge sur six seulement attrapait un défaut.
// Déclarée par projet (`run.fastGate` de cadence.yaml) : sans la clé, rien ne change. Repli sûr sur la suite complète dès que la sélection est incertaine :
// fichier supprimé ou déplacé, fichier de `full` touché (cadence.yaml toujours), fichier hors du dossier des tests, aucun test trouvé par la commande.
// Rien de propre à un dépôt : la commande liée vient du projet (`vitest related --run {files}`, `jest --findRelatedTests {files}`, …), dérivée seulement
// d'une porte `[npx ]vitest run[ options]`. JavaScript sans dépendance, comme scripts/regeneration.mjs : src et v2 l'importent hors de leur rootDir.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Le chemin de ce script : la porte de cadence run le lance pour jouer les tests touchés, puis la suite complète si aucun n'a tourné. */
export const SCRIPT = fileURLToPath(import.meta.url);
const CLES = ['command', 'dir', 'full'];
const FORME = 'run.fastGate : true, ou { command: <commande avec {files}>, dir: <dossier>, full: [<motifs>] }';
/** Toucher l'un de ces fichiers joue la suite complète, quoi que déclare le projet : cadence.yaml porte la porte elle-même. */
const TOUJOURS_COMPLETE = ['cadence.yaml'];
/** Ce qu'imprime, en tête de ligne, un lanceur qui n'a trouvé aucun test (vitest, jest, pytest) : la porte rapide n'a rien jugé, la suite complète est jouée. */
const AUCUN = ['no test files found', 'no test file found', 'no tests found', 'no test found', 'no tests ran'];
/** Vrai quand une ligne de la sortie dit qu'aucun test n'a été trouvé (ponctuation de tête ôtée : « === no tests ran in 0.01s === »). */
export const aucunTest = (sortie) => sortie.split('\n').some((l) => { const t = l.replace(/^\W+/, '').toLowerCase(); return AUCUN.some((a) => t.startsWith(a)); });
/** Un fichier de test (JS/TS, Python, Java, .NET) : il est passé tel quel à la commande liée quand le lot le touche. */
const TESTS = [/\.(?:test|spec)\.[cm]?[jt]sx?$/, /(?:^|\/)test_[^/]*\.py$/, /_test\.py$/, /Tests?\.(?:java|kt|cs)$/];
const estTest = (f) => TESTS.some((re) => re.test(f));
/** Un fichier de code : ses tests viennent du lien d'import (commande liée) ; un autre fichier (page, données) a pour tests ceux qui citent son nom. */
const CODE = /\.(?:[cm]?[jt]sx?|py|java|kt|cs|go|rs|rb|php|scala|vue|svelte)$/;
const VITEST_RUN = /^(npx\s+)?vitest\s+run((?:\s+-[^\s;|&<>`]+)*)$/;

const estObjet = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const texte = (v) => typeof v === 'string' && v.trim() !== '';
const argShell = (s) => (/^[\w./@+=,:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Motif de chemin (mêmes motifs que docs.sync et bounds) : `*` reste dans un dossier, `**` le traverse, `?` un caractère, un `/` final prend tout le dossier. */
export function motif(p) {
  const m = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const source = (m.endsWith('/') ? `${m}**` : m).split(/(\*\*\/?|\*|\?)/)
    .map((x) => ({ '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' })[x] ?? x.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
  const re = new RegExp(`^${source}$`);
  return (f) => re.test(f);
}
/** Liste de motifs : un fichier en fait partie s'il correspond à un motif et à aucun motif « !… ». */
export function ensemble(motifs) {
  const oui = motifs.filter((p) => !p.startsWith('!')).map(motif), non = motifs.filter((p) => p.startsWith('!')).map((p) => motif(p.slice(1)));
  return (f) => oui.some((m) => m(f)) && !non.some((m) => m(f));
}

/** La commande liée dérivée de `orchestrate.test` : seulement `[npx ]vitest run[ options à tiret]` ; null pour toute autre forme (à déclarer). */
export function commandeDerivee(test) {
  const m = typeof test === 'string' ? VITEST_RUN.exec(test.trim()) : null;
  if (!m) return null;
  const options = m[2].trim();
  return `${m[1] ?? ''}vitest related --run${options ? ` ${options}` : ''} {files}`;
}

function dossier(v) {
  if (v == null) return '.';
  const d = texte(v) ? posix.normalize(v.trim().replace(/\\/g, '/')).split('/').filter(Boolean).join('/') || '.' : null;
  if (d === null || v.trim().startsWith('/') || /^[A-Za-z]:/.test(d) || d.startsWith('~') || d.split('/').includes('..'))
    throw new Error(`run.fastGate.dir : « ${v} » : dossier relatif au dépôt attendu, sans « .. »`);
  return d;
}

/** Les clés de `run.fastGate` contrôlées : `{ command?, full? }` ; une forme refusée lève. */
function controler(o) {
  for (const k of Object.keys(o)) if (!CLES.includes(k)) throw new Error(`run.fastGate.${k} inconnu (attendu : ${CLES.join(', ')})`);
  if (o.command != null && (!texte(o.command) || !o.command.includes('{files}'))) throw new Error('run.fastGate.command : commande non vide contenant {files} attendue (remplacé par les fichiers touchés)');
  if (o.full != null && (!Array.isArray(o.full) || o.full.some((p) => !texte(p)))) throw new Error('run.fastGate.full : liste de motifs de chemin attendue');
}

/**
 * `run` : la valeur de la clé `run:` de cadence.yaml ; `orchestrate` : celle d'`orchestrate:` (la commande se dérive de `orchestrate.test`). Rend null sans
 * `run.fastGate` (ou `false`), sinon `{ command, dir, full }` ; une forme refusée lève une Error dont le message commence par `fichier : `.
 */
export function lirePorteRapide(run, orchestrate, fichier) {
  const v = estObjet(run) ? run.fastGate : undefined;
  if (v == null || v === false) return null;
  try {
    if (v !== true && !estObjet(v)) throw new Error(`${FORME}`);
    const o = v === true ? {} : v;
    controler(o);
    const command = o.command == null ? commandeDerivee(orchestrate?.test) : o.command.trim();
    if (!command) throw new Error('run.fastGate.command : à déclarer (elle ne se dérive que d\'un orchestrate.test « [npx ]vitest run[ options] »), par exemple « npx jest --findRelatedTests {files} »');
    return { command, dir: dossier(o.dir), full: [...TOUJOURS_COMPLETE, ...(o.full ?? []).map((p) => p.trim())] };
  } catch (e) {
    throw new Error(`${fichier} : ${e.message}`);
  }
}

/** Les tests déclarés par la clé `bounds` de cadence.yaml pour ces fichiers (faute de lien d'import, la commande liée ne les trouve pas) ; forme illisible : aucun. */
function testsDeclares(bounds, fichiers) {
  if (!Array.isArray(bounds)) return [];
  return bounds.filter((b) => estObjet(b) && Array.isArray(b.paths) && fichiers.some(ensemble(b.paths.filter(texte))))
    .flatMap((b) => (Array.isArray(b.tests) ? b.tests.filter(texte) : []));
}
/** Le texte cite ce nom en entier (« orchestrate-spec.md » ne cite pas « spec.md »). */
function cite(t, nom) {
  for (let i = t.indexOf(nom); i !== -1; i = t.indexOf(nom, i + 1)) if (i === 0 || !/[\w.-]/.test(t[i - 1])) return true;
  return false;
}
/** Les tests suivis par git sous `dir` qui citent le nom d'un fichier touché autre que du code (une page, des données : le test le lit, il ne l'importe pas). */
function lecteurs(racine, dir, fichiers) {
  const noms = [...new Set(fichiers.filter((f) => !CODE.test(f)).map((f) => basename(f)))];
  if (!noms.length) return [];
  const r = spawnSync('git', ['ls-files', '-z', '--', dir], { cwd: racine, encoding: 'utf8', maxBuffer: 256 << 20 });
  return r.stdout.split('\0').filter((f) => estTest(f) && existsSync(join(racine, f))).filter((f) => {
    const t = readFileSync(join(racine, f), 'utf8');
    return noms.some((n) => cite(t, n));
  });
}

/**
 * Les fichiers que la porte rapide vise, depuis `depart` (le commit où le lot a commencé, sur la cible) : `{ fichiers, commande }` — les fichiers touchés
 * (ajoutés ou modifiés), les tests que `bounds` déclare pour eux et ceux qui citent une page touchée, relatifs à `cfg.dir` — ou `{ motif }` quand la
 * sélection est incertaine et que la suite complète doit être jouée. `yaml` : cadence.yaml lu (clé `bounds`).
 */
export function selectionner(racine, depart, cfg, yaml = {}) {
  const r = spawnSync('git', ['diff', '--name-status', '-z', '--no-renames', `${depart}..HEAD`], { cwd: racine, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) return { motif: `diff du lot illisible (${r.stderr?.trim() || r.error?.message})` };
  const champs = r.stdout.split('\0').filter(Boolean), touches = [], retires = [];
  for (let i = 0; i < champs.length; i += 2) (champs[i] === 'D' ? retires : touches).push(champs[i + 1]);
  return choisir(racine, touches, retires, cfg, yaml);
}

/** La sélection pour ces fichiers touchés (ajoutés ou modifiés) et retirés : `{ fichiers, commande }` ou `{ motif }` (selectionner, et la mesure de L838). */
export function choisir(racine, touches, retires, cfg, yaml = {}) {
  if (retires.length) return { motif: `fichier supprimé ou déplacé (${retires.slice(0, 3).join(', ')}) : les tests qui l'importaient ne se trouvent plus par le diff` };
  if (!touches.length) return { motif: 'aucun fichier touché par le lot' };
  const complet = touches.find(ensemble(cfg.full));
  if (complet) return { motif: `${complet} touché (run.fastGate.full)` };
  const prefixe = cfg.dir === '.' ? '' : `${cfg.dir}/`, dehors = touches.find((f) => !f.startsWith(prefixe));
  if (dehors) return { motif: `${dehors} hors de run.fastGate.dir (${cfg.dir})` };
  const vises = [...new Set([...touches, ...testsDeclares(yaml?.bounds, touches), ...lecteurs(racine, cfg.dir, touches)])]
    .filter((f) => f.startsWith(prefixe) && existsSync(join(racine, f))).map((f) => f.slice(prefixe.length));
  const lie = cfg.command.replace('{files}', vises.map(argShell).join(' '));
  return { fichiers: vises, commande: cfg.dir === '.' ? lie : `cd ${argShell(cfg.dir)} && ${lie}` };
}

/**
 * L'étape des tests d'une porte de run : `complete` (les commandes de la suite, une par partie). Sans porte rapide déclarée : `{ commandes: complete }`.
 * Avec elle : `{ commandes, ciblee, ligne }` — une seule commande (ce script en `--jouer`) qui joue les tests touchés puis la suite complète s'ils n'ont
 * rien trouvé, `ciblee` vrai ; ou la suite complète quand la sélection est incertaine (`ciblee` faux), avec la ligne qui dit pourquoi.
 */
export function etapeTests(racine, depart, cfg, yaml, complete) {
  if (!cfg || !complete.length) return { commandes: complete, ciblee: false };
  const s = selectionner(racine, depart, cfg, yaml);
  if (s.motif) return { commandes: complete, ciblee: false, ligne: `porte rapide (run.fastGate) : suite complète jouée — ${s.motif}` };
  const cmd = [process.execPath, SCRIPT, '--jouer', s.commande, '--sinon', complete.join(' && ')].map(argShell).join(' ');
  return { commandes: [cmd], ciblee: true, ligne: `porte rapide (run.fastGate) : tests touchés par ${s.fichiers.length} fichier(s) du lot ; la suite complète se joue à la porte de livraison (cadence verify --gate)` };
}

/** `--jouer <commande liée> --sinon <suite complète>` : la commande liée ; si son lanceur n'a trouvé aucun test, la suite complète. Code : celui de la dernière jouée. */
export function jouer(liee, complete, io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }) {
  const r = spawnSync('bash', ['-c', liee], { encoding: 'utf8', maxBuffer: 256 << 20 });
  io.out(r.stdout ?? ''); io.err(r.stderr ?? '');
  if (!aucunTest(`${r.stdout}\n${r.stderr}`)) return r.status ?? 1;
  io.out('porte rapide : aucun test touché trouvé par la commande liée — suite complète jouée\n');
  return spawnSync('bash', ['-c', complete], { stdio: 'inherit' }).status ?? 1;
}

if (process.argv[1] === SCRIPT) {
  const [quoi, liee, sinon, complete] = process.argv.slice(2);
  if (quoi !== '--jouer' || !liee || sinon !== '--sinon' || !complete) { console.error('usage : porte-rapide.mjs --jouer <commande liée> --sinon <suite complète>'); process.exitCode = 2; } else process.exitCode = jouer(liee, complete);
}
