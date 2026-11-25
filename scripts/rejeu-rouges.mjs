// Rejeu seul des tests rouges de la porte d'un `cadence run`, avant toute correction (L842, D-33). L'étude du 25-11
// (docs/etudes/2026-11-25-temps-lot-prod-et-tests.md, §5 P3) : 22 des 54 corrections « porte rouge » venaient de tests sensibles à la charge de la
// machine. Chaque test rouge est rejoué SEUL (la même commande, filtrée sur ce test) ; vert seul, il est « sensible à la charge » et ne coûte aucune passe.
// La façon de filtrer se déclare (orchestrate.testReplay, le replay d'une partie : {files}, comme les vagues, L354) ou se déduit du lanceur
// (vitest, jest, pytest, dotnet test, directement ou par un script npm) ; sinon rien n'est rejoué et la porte le dit.
// JavaScript sans dépendance, comme scripts/etapes-porte.mjs : v2 l'importe hors de son rootDir.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { commandeDePartie, lirePorteTest } from './etapes-porte.mjs';
import { lirePorteJouee } from './porte-rapide.mjs';
import { failedTests, hasUnnamedFailure, isComposedGate, jestTestFiles, NO_TEST_RAN, nodeTestFiles, nodeTestRan, replayFile, replayRanFile, shellArg, stripAnsi } from './rouges-porte.mjs';

/** Au-delà de ce nombre de rouges dans une commande, rien n'est rejoué : la charge fait rougir quelques tests, pas une suite entière. */
export const REJEUX_MAX = 10;
/** Délai d'un rejeu seul (le test seul, pas la suite). */
export const REJEU_MS = 5 * 60_000;

const LANCEURS = [['vitest', /\bvitest\b/], ['jest', /\bjest\b/], ['pytest', /\bpy\.?test\b/], ['dotnet', /\bdotnet\s+test\b/]];
const SCRIPT_NPM = /^npm\s+(?:t|test|run(?:-script)?\s+(\S+))(\s.*)?$/;

/** Une commande qui enchaîne plusieurs commandes (&&, ||, ;, tube, sous-shell) : rejouer un de ses tests ne dirait rien du reste. */
const composee = (c) => isComposedGate(c) || c.includes(';') || c.includes('|');

const echapperRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Le lanceur d'une commande seule, ou celui du script npm qu'elle lance (`npm test`, `npm run x`, lu dans le package.json de `dossier`). */
function lanceur(commande, dossier) {
  const direct = LANCEURS.find(([, re]) => re.test(commande));
  if (direct) return { nom: direct[0], args: (a) => `${commande} ${a}` };
  const npm = SCRIPT_NPM.exec(commande.trim());
  if (!npm || !existsSync(join(dossier, 'package.json'))) return null;
  let scripts;
  try { scripts = JSON.parse(readFileSync(join(dossier, 'package.json'), 'utf8')).scripts ?? {}; } catch { return null; }
  const script = scripts[npm[1] ?? 'test'];
  if (typeof script !== 'string' || composee(script)) return null;
  const vise = LANCEURS.find(([, re]) => re.test(script));
  if (!vise) return null;
  return { nom: vise[0], args: (a) => `${commande}${/\s--(\s|$)/.test(commande) ? '' : ' --'} ${a}` };
}

/** Le dernier segment d'un nom de test (« fichier > suite > cas », « Suite › cas ») : ce que `-t` de vitest et de jest retrouve dans le nom complet. */
const feuille = (nom) => nom.split(/ > | › /).pop().trim();

/** Ce que la porte déduite rejoue pour un rouge : le fichier, et le filtre sur le test quand le nom le désigne dans le fichier. */
function cibleDeduite(nom, sortie, lance) {
  if (lance.nom === 'dotnet') {
    const sansParam = nom.includes('(') ? nom.slice(0, nom.indexOf('(')) : nom;
    return { fichier: null, commande: lance.args(`--filter ${shellArg(`FullyQualifiedName${sansParam === nom ? '=' : '~'}${sansParam}`)}`) };
  }
  if (lance.nom === 'pytest') {
    const fichier = replayFile(nom);
    return fichier ? { fichier, commande: lance.args(shellArg(nom.includes('::') ? nom : fichier)) } : null;
  }
  const fichier = lance.nom === 'jest' ? jestTestFiles(sortie).get(nom) ?? replayFile(nom) : replayFile(nom);
  if (!fichier) return null;
  // Revue L842 (M1) : vitest rejoue le fichier ENTIER, jamais `-t` : un rouge qui dépend d'un test précédent du même fichier (cache, singleton, mock non
  // restauré) passerait vert seul. Jest garde `-t` : sa ligne « FAIL fichier » est aussi un rouge nommé, qui rejoue le fichier entier.
  const seul = lance.nom === 'vitest' || nom === fichier || nom.endsWith(` ${fichier}`); // « FAIL fichier » : le fichier entier est rouge
  // `filtre` : la preuve exige un test réussi ; vitest aussi sur un fichier entier (un fichier dont tout est sauté sort en 0 et s'affiche)
  return { fichier, commande: lance.args(`${shellArg(fichier)}${seul ? '' : ` -t ${shellArg(echapperRegex(feuille(nom)))}`}`), filtre: !seul || lance.nom === 'vitest' };
}

/** Ce que le replay déclaré ({files}) rejoue pour un rouge : son fichier, lu comme les vagues (node --test, puis le nom, puis jest). */
function cibleDeclaree(nom, sortie, gabarit) {
  const titreNode = nodeTestFiles(sortie).get(nom);
  const fichier = titreNode ?? replayFile(nom) ?? jestTestFiles(sortie).get(nom) ?? null;
  return fichier ? { fichier, commande: gabarit.replaceAll('{files}', () => shellArg(fichier)), titreNode: !!titreNode } : null;
}

/**
 * Comment rejouer seul un rouge de la commande de test `run` (jouée dans `dossier`) : `declare` (testReplay, replay d'une partie, avec {files}) d'abord, sinon
 * la déduction du lanceur. `{ forme, cible(nom, sortie) }`, ou `{ raison }` quand rien ne peut être rejoué. `partie` : la commande est jouée depuis ce dossier.
 */
export function rejeuDeLaCommande(run, declare, dossier, partie) {
  const dans = (c) => (partie ? commandeDePartie(partie, c) : c);
  if (declare) {
    if (!partie && composee(run)) return { raison: `orchestrate.test est une commande composée : testReplay ne vaut que pour un lanceur unique (L354)` };
    return { forme: `${declare} (déclaré)`, cible: (nom, sortie) => { const c = cibleDeclaree(nom, sortie, declare); return c && { ...c, commande: dans(c.commande) }; } };
  }
  if (composee(run)) return { raison: `« ${run} » enchaîne plusieurs commandes : déclarer orchestrate.testReplay (ou le replay de la partie) avec {files}` };
  const lance = lanceur(run, dossier);
  if (!lance) return { raison: `« ${run} » : lanceur non reconnu (vitest, jest, pytest, dotnet test, ou un script npm qui en lance un) ; déclarer orchestrate.testReplay (ou le replay de la partie) avec {files}` };
  return { forme: `${lance.nom}, déduit de « ${run} »`, cible: (nom, sortie) => { const c = cibleDeduite(nom, sortie, lance); return c && { ...c, commande: dans(c.commande), filtre: c.filtre ?? true }; } };
}

/**
 * Le rejeu de chaque commande de test de la porte (clé `orchestrate` de cadence.yaml, au commit du run) : une Map de la commande jouée par la porte
 * (scripts/etapes-porte.mjs) vers son rejeu. Vide sans `orchestrate.test` lisible.
 */
export function rejeuxDesTests(orchestrate, racine) {
  const o = orchestrate ?? {}, t = lirePorteTest(o.test), rejeux = new Map();
  if (t.refus) return rejeux;
  if (!Array.isArray(t.porte)) rejeux.set(t.porte, rejeuDeLaCommande(t.porte, typeof o.testReplay === 'string' ? o.testReplay.trim() : undefined, racine));
  else for (const p of t.porte) rejeux.set(commandeDePartie(p), rejeuDeLaCommande(p.run, p.replay, join(racine, p.dir), p));
  return rejeux;
}

/**
 * Le rejeu d'une commande jouée par la porte (`rejeux` : rejeuxDesTests). Revue L838 (M1) : la porte rapide (run.fastGate) joue `porte-rapide.mjs --jouer
 * <liée> --sinon <suite>` ; ses rouges se rejouent seuls par le rejeu de la suite qu'elle remplace — orchestrate.test, ou la partie dont le dossier est celui
 * de la commande liée (« cd <dir> && … ») — comme ceux de la porte complète. undefined : commande inconnue de la porte.
 */
export function rejeuDeCommandeJouee(rejeux, commande) {
  if (rejeux.has(commande)) return rejeux.get(commande);
  const rapide = lirePorteJouee(commande);
  if (!rapide) return undefined;
  const suite = [...rejeux.keys()], dans = /^cd \S+ && /.exec(rapide.liee)?.[0];
  if (suite.length === 1 && suite[0] === rapide.complete) return rejeux.get(suite[0]);
  const partie = dans && suite.length > 1 && suite.join(' && ') === rapide.complete ? suite.find((c) => c.startsWith(dans)) : undefined;
  if (partie) return rejeux.get(partie);
  return { raison: `porte rapide (run.fastGate) : sa suite (« ${rapide.complete} ») ne désigne pas une commande de test de la porte dont rejouer les rouges seuls` };
}

/** Le nombre écrit juste avant `mot` dans la ligne `t` (« 1 passed »), ou juste après (« Passed: 1 ») ; null sans nombre. */
function nombre(t, mot, apres = false) {
  const i = t.indexOf(mot);
  if (i < 0) return null;
  const mots = (apres ? t.slice(i + mot.length) : t.slice(0, i)).replaceAll(',', ' ').split(' ').filter(Boolean);
  const n = apres ? mots[0] : mots.at(-1);
  return /^\d+$/.test(n ?? '') ? Number(n) : null;
}

/** Le nombre de tests réussis que la ligne de fin du lanceur annonce (vitest, jest, pytest, dotnet, node --test) ; 0 sans ligne lisible. */
export function testsReussis(sortie) {
  let n = 0;
  for (const l of stripAnsi(sortie).split('\n')) {
    const t = l.trim();
    // vitest « Tests  1 passed | 3 skipped (4) », jest « Tests:       1 passed, 1 total », pytest « ==== 1 passed, 3 deselected in 0.1s ==== » et -q « 1 passed in 0.1s »
    const m = t.startsWith('Tests') || t.startsWith('=') || /^\d+ passed/.test(t) ? nombre(t, ' passed')
      : t.startsWith('Passed!') || t.startsWith('Failed!') ? nombre(t, 'Passed:', true) // dotnet « Passed!  - Failed: 0, Passed: 1, … »
        : t.startsWith('# pass ') ? nombre(t, '# pass', true) : null; // node --test
    n = Math.max(n, m ?? 0);
  }
  return n;
}

/** dotnet test : « Failed Espace.Classe.Methode [12 ms] » (le lanceur ne dit pas le fichier ; le nom complet suffit à filtrer). */
export function rougesDotnet(sortie) {
  const noms = new Set();
  for (const l of stripAnsi(sortie).split('\n')) {
    const [mot, nom, duree] = l.trim().split(' ');
    if (mot === 'Failed' && nom && duree?.startsWith('[')) noms.add(nom);
  }
  return [...noms].sort();
}

/**
 * Le rejeu a-t-il prouvé le test vert ? Code 0, au moins un test joué, et : un titre node --test, sa ligne « ok » ; un fichier, son nom sur une ligne du
 * lanceur (hors écho de npm) ; un filtre sur le test ou un fichier vitest, au moins un test RÉUSSI (vitest -t sans correspondance, ou un fichier tout sauté, sort en 0).
 */
function prouveVert(r, nom, c) {
  if (r.code !== 0 || NO_TEST_RAN.test(r.sortie)) return false;
  if (c.titreNode) return nodeTestRan(r.sortie, nom);
  if (c.filtre && testsReussis(r.sortie) < 1) return false;
  return c.fichier ? replayRanFile(r.sortie, c.fichier) : true;
}

const entierPositif = (v) => (/^\d+$/.test(v?.trim() ?? '') && Number(v) >= 1 ? Number(v) : null);
/** `CADENCE_TEST_WORKERS` du rejeu, comme verify --gate (L387) : celui de l'environnement s'il est un entier positif, sinon cœurs ÷ CADENCE_MAX_SESSIONS (2 par
 * défaut) ; un testReplay qui écrit `--maxWorkers=$CADENCE_TEST_WORKERS` (celui de cadence) ne sort pas en erreur dans un run. */
export function envRejeu(env, coeurs = availableParallelism()) {
  const part = entierPositif(env.CADENCE_TEST_WORKERS) ?? Math.max(1, Math.floor(coeurs / (entierPositif(env.CADENCE_MAX_SESSIONS) ?? 2)));
  return { ...env, CADENCE_TEST_WORKERS: String(part) };
}

/** Joue une commande de rejeu dans `cwd` ; son code, sa sortie et sa durée. */
export function jouerRejeu(commande, cwd) {
  const debut = Date.now(), r = spawnSync('bash', ['-c', commande], { cwd, env: envRejeu(process.env), encoding: 'utf8', timeout: REJEU_MS, maxBuffer: 64 << 20 });
  return { code: r.status ?? 1, sortie: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`, ms: Date.now() - debut };
}

/**
 * Rejoue SEUL chaque test rouge de `sortie` (la sortie entière d'une commande de test rouge de la porte), par `rejeu` (rejeuDeLaCommande) et `jouer`.
 * Rend `{ sensibles: [{ test, ms }], rouges: [noms encore rouges], raison? }` : `raison` dit pourquoi rien n'a été rejoué (la commande reste rouge) ; une sortie
 * sans test rouge nommé rend deux listes vides, sans raison : la commande reste rouge (seul un rouge nommé et vert seul l'excuse).
 * Un échec que la sortie ne rattache à aucun test (erreur non gérée, fichier qui ne se charge pas, seuil de couverture) n'est jamais rejoué.
 */
export function rejouerRouges(sortie, rejeu, jouer) {
  const noms = [...new Set([...failedTests(sortie), ...rougesDotnet(sortie)])];
  const sans = (raison) => ({ sensibles: [], rouges: noms, raison });
  if (hasUnnamedFailure(sortie)) return sans('un échec que la sortie ne rattache à aucun test (erreur non gérée, fichier qui ne se charge pas, seuil de couverture)');
  if (!noms.length) return { sensibles: [], rouges: [] }; // aucun test nommé (build, commande introuvable) : rien à rejouer, rien à dire
  if (!rejeu) return sans('commande de test inconnue de la porte');
  if (rejeu.raison) return sans(rejeu.raison);
  if (noms.length > REJEUX_MAX) return sans(`${noms.length} tests rouges, plus de ${REJEUX_MAX} : ce n'est pas la charge`);
  const sensibles = [], rouges = [], joues = new Map(); // une même commande (plusieurs rouges d'un fichier rejoué entier) n'est jouée qu'une fois
  for (const nom of noms) {
    const c = rejeu.cible(nom, sortie);
    if (c && !joues.has(c.commande)) joues.set(c.commande, jouer(c.commande));
    const r = c ? joues.get(c.commande) : null;
    if (r && prouveVert(r, nom, c)) sensibles.push({ test: nom, ms: r.ms });
    else rouges.push(nom);
  }
  return { sensibles, rouges };
}
