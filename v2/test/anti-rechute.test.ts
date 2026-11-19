// Tests anti-rechute (Task 14) : une règle par cause de l'échec du 07-11 (spec §0), sans IA, en quelques secondes.
// Chaque règle est une fonction PURE sur le contenu des fichiers (Record chemin -> texte) qui renvoie ses violations.
// 1. les vrais fichiers donnent [] ; 2. une table de mutations applique chaque régression connue à une copie EN MÉMOIRE
// des vrais contenus et exige au moins une violation (rien n'est écrit sur disque). Le budget de lignes (C4) vit dans budget.test.ts ; ses plafonds de R29, dans reglesBudget ci-dessous.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lancerBras, type Executeur } from '../src/bench/bras.js';
import { BARRE_SPEC, ligneHistorique, rapport, statut, verdict, type ResultatBanc } from '../src/bench/verdict.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Banc } from '../src/bench/banc.js';
import { dossierTemp } from './temp.js';

const v2 = join(import.meta.dirname, '..');
const depot = join(v2, '..');
type Fichiers = Record<string, string>;

function chemins(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? chemins(p, ext) : ext.test(e) ? [p] : [];
  });
}
function chargerReel(): Fichiers {
  const f: Fichiers = {};
  for (const p of chemins(join(v2, 'src'), /\.ts$/)) f[`src/${p.slice(join(v2, 'src').length + 1)}`] = readFileSync(p, 'utf8');
  for (const p of chemins(join(v2, 'briefs'), /\.md$/)) f[`briefs/${p.slice(join(v2, 'briefs').length + 1)}`] = readFileSync(p, 'utf8');
  f['budget.json'] = readFileSync(join(v2, 'budget.json'), 'utf8');
  f['options.json'] = readFileSync(join(v2, 'options.json'), 'utf8');
  f['docs/banc.md'] = readFileSync(join(depot, 'docs', 'v2', 'banc.md'), 'utf8');
  return f;
}
const reel = chargerReel();
const sources = (f: Fichiers) => Object.keys(f).filter((k) => k.startsWith('src/'));
const briefsDe = (f: Fichiers) => Object.keys(f).filter((k) => k.startsWith('briefs/'));
const BRIEF_CAND = 'briefs/bras-equipe-legere.md';

/** Sans commentaires (les `//` précédés de `:` sont ceux des URL). */
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\w])\/\/.*$/gm, '$1');
const sansChaines = (s: string) => s.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");

// ---------------------------------------------------------------------------------------------------------------------
// C1, conformité à une fiche figée
// Légitimes : « Conformité » est un titre de mesure.md dans ajouter.ts ; « gabarit » est un paramètre de juges.ts (fichier modèle de brief).
// Nombre EXACT d'occurrences tolérées par fichier et par mot : une de plus est une violation.
const AUTORISES_C1: Record<string, Record<string, number>> = { 'src/bench/ajouter.ts': { conformit: 1 }, 'src/bench/juges.ts': { gabarit: 2 }, 'src/sequence/mesures.ts': { snapshot: 3 } }; // mesures.ts : dossier __snapshots__ des tests cachés
const MOTS_C1: [string, RegExp][] = [['scell', /scell/i], ['acceptation', /acceptation/i], ['fiche', /fiche/i], ['maquette', /maquette/i],
  ['spec:', /(?<![\w])spec:/i], ['contrat', /contrat/i], ['gabarit', /gabarit/i], ['seal', /seal/i], ['golden', /golden/i],
  ['snapshot', /snapshot/i], ['conformit', /conformit/i]]; // `spec:` = clé de fiche, pas BARRE_SPEC:
const PHRASE_RELECTEUR = /Donne-lui seulement le texte de la demande ci-dessus et la sortie de `git -C \{\{CLONE\}\} diff \{\{BASE\}\}\.\.HEAD`/;
const MODELE_RELECTEUR = /subagent_type general-purpose, model opus\)/;

function reglesC1(f: Fichiers): string[] {
  const v: string[] = [];
  for (const k of [...sources(f), ...briefsDe(f)])
    for (const [mot, re] of MOTS_C1) {
      const n = (f[k].match(new RegExp(re.source, 'gi')) ?? []).length;
      if (n > (AUTORISES_C1[k]?.[mot] ?? 0)) v.push(`C1 : « ${mot} » ×${n} dans ${k}`);
    }
  const b = f[BRIEF_CAND] ?? '';
  if (!b.includes('{{DEMANDE}}')) v.push('C1 : le brief candidat ne contient pas {{DEMANDE}}');
  if (!b.includes('le texte de la demande') || !b.includes('git -C {{CLONE}} diff')) v.push('C1 : le relecteur ne reçoit pas demande + diff');
  // le brief candidat doit avoir son relecteur ; tout autre brief de bras qui en a un suit la même phrase (S5 : bras-sequence-v2)
  for (const k of briefsDe(f).filter((x) => x.startsWith('briefs/bras-'))) {
    const para = f[k].split('\n').find((l) => l.startsWith('- Relecture'));
    if (para === undefined && k !== BRIEF_CAND) continue;
    if (!PHRASE_RELECTEUR.test(para ?? '')) v.push(`C1 : phrase exacte du relecteur absente de ${k}`);
    if (!MODELE_RELECTEUR.test(para ?? '')) v.push(`C1 : le relecteur n'est plus pinné sur model opus dans ${k}`);
    const intrus = (para ?? '').match(/\b(plan|lot|raf\.yaml|carte|description)\b/i);
    if (intrus) v.push(`C1 : « ${intrus[0]} » dans le paragraphe du relecteur de ${k}`);
  }
  for (const n of ['sequence-v2', 'sequence-v2b', 'sequence-v2c', 'sequence-v2d']) { // v2b (S7) : sequence-v2 sans relecture ; v2c (plan n°4) : v2b + sorties attendues ; v2d (09-11) : v2b + registre des demandes
    const seq = f[`briefs/bras-${n}.md`];
    if (seq !== undefined && !seq.includes('Taille fixée par le gardien : {{TAILLE}}')) v.push(`C1 : bras-${n} ne reçoit plus la taille du gardien`);
  }
  return v;
}

// ---------------------------------------------------------------------------------------------------------------------
// C2, contexte découpé : une session par bras, Opus partout (sonnet et haiku interdits sous toutes leurs formes)
const ALLOWLIST_MODELES_SRC: string[] = []; // vide aujourd'hui : aucun fichier de src n'a le droit de nommer sonnet ou haiku
function reglesC2(f: Fichiers): string[] {
  const v: string[] = [];
  for (const k of briefsDe(f)) for (const m of ['nouvelle session', 'claude -p']) if (f[k].toLowerCase().includes(m)) v.push(`C2 : « ${m} » dans ${k}`);
  for (const k of [...briefsDe(f), 'docs/banc.md', ...sources(f).filter((s) => !ALLOWLIST_MODELES_SRC.includes(s))])
    if (/sonnet|haiku/i.test(f[k] ?? '')) v.push(`C2 : sonnet ou haiku dans ${k}`);
  for (const k of briefsDe(f).filter((b) => b.startsWith('briefs/bras-'))) {
    const lignes = f[k].split('\n').filter((l) => l.includes('subagent_type'));
    if (lignes.length > 1 || lignes.some((l) => !l.startsWith('- Relecture'))) v.push(`C2 : sous-agent hors de la relecture dans ${k}`);
  }
  if (!/option\(reste, 'juge'\) \?\? 'opus'/.test(f['src/bench/cli.ts'] ?? '')) v.push('C2 : le juge par défaut n\'est pas opus');
  if (!/'--resume'/.test(f['src/bench/bras.ts'] ?? '')) v.push('C2 : bras.ts ne reprend plus la session (--resume)');
  return v;
}

// ---------------------------------------------------------------------------------------------------------------------
// C3, portes empilées. Spec §0 C3 : « Deux portes au plus : ciblée par le responsable, complète une fois à l'intégration. »
// Sites (09-11) : controlesEclair (banc éclair) et jouerPorte de cadence run (porte complète, une fois, plus une reprise après correction).
const MAX_SITES_PORTE = 2;
function reglesC3(f: Fichiers): string[] {
  const v: string[] = [];
  const sites = sources(f).flatMap((k) => {
    const t = sansChaines(sansCommentaires(f[k])).replace(/\bfunction\s+\w+\s*\(/g, '');
    return (t.match(/\b\w*(?:porte|gate|verif|verify|controle|check)\w*\s*\(/gi) ?? []).map((m) => `${k}: ${m}`);
  });
  if (sites.length > MAX_SITES_PORTE) v.push(`C3 : ${sites.length} sites de porte (${sites.join(' ; ')})`);
  const b = JSON.parse(f['budget.json']) as { noyau: { modules: Record<string, number> } };
  if (!(b.noyau?.modules?.porte <= 250)) v.push(`C3 : budget porte ${b.noyau?.modules?.porte} > 250`);
  return v;
}

// ---------------------------------------------------------------------------------------------------------------------
// C4, mécanismes sans mesure : toute option lue (littéral --xxx, option(x,'xxx'), env, argv) est justifiée dans options.json
// Flags des CLI claude et git, par fichier (liste exacte ; aucune autre valeur n'est tolérée).
const FLAGS_CLI: Record<string, string[]> = {
  'src/bench/bras.ts': ['output-format', 'verbose', 'model', 'permission-mode', 'disallowedTools', 'resume'], // --verbose : exigé par claude -p avec stream-json (issue #57)
  'src/bench/juges.ts': ['output-format', 'verbose', 'model', 'permission-mode', 'disallowedTools', 'resume', 'porcelain'], // + git status --porcelain ; --verbose : stream-json des juges (revue L756, system/init)
  'src/bench/preparer.ts': ['no-hardlinks', 'format', 'is-ancestor', 'all', 'expire', 'prune', 'not'],
  'src/bench/ajouter.ts': ['format', 'reverse', 'grep', 'verify', 'name-only'],
  'src/sequence/mesures.ts': ['porcelain', 'others', 'exclude-standard', 'reporter', 'outputFile', 'yes', 'reporters', 'output', 'silent', 'ignore', 'name-only', 'gitignore'], // flags git, vitest et jscpd (S2, S7 : --gitignore), aucune option de cadence2
  'src/run/run.ts': ['verify', 'show-toplevel', 'count', 'abort', 'abbrev-ref', 'short', 'ff-only', 'force', 'resume', 'session-id', 'git-path', 'continue', 'skip', 'name-only', 'diff-filter', 'is-ancestor', 'format'], // git, claude --resume (reprise de la même session) et --session-id (L709 : id écrit dès le lancement) ; L722 : git status au départ du run lu par scripts/arbre-non-commite.mjs
  // L723 : rebase seul (--git-path, --diff-filter=U, --is-ancestor ; --continue et --skip dans la consigne de résolution), fichiers que le run modifie (--name-only)
  'src/run/cli.ts': ['show-toplevel'],
  // L745 (5e passe) : rev-parse --verify, worktree list --porcelain, status --porcelain --untracked-files --ignore-submodules, merge-base --is-ancestor,
  // rev-list --count --not, checkout --detach, for-each-ref --format ; git worktree remove est lancé sans --force
  'src/run/clore.ts': ['verify', 'porcelain', 'untracked-files', 'ignore-submodules', 'is-ancestor', 'count', 'not', 'detach', 'format'],
  // L781 : git log --format (commits de régénération du run, à l'intégration) ; regenerer.ts : git status --porcelain --untracked-files, git log --format (trailer),
  // git reset --keep (retirer la régénération avant un rebase), git rev-parse --short ; revue r1 : rev-parse --git-path (rebase en cours), rebase --onto / --abort (retirer une régénération enfouie)
  'src/run/regenerer.ts': ['porcelain', 'untracked-files', 'format', 'keep', 'short', 'git-path', 'onto', 'abort'],
  'src/run/escalade.ts': ['json'], // L726 : raf list --json, la revue de code du lot dans le plan
  'src/registre.ts': ['name-only', 'diff-filter'], // git diff --name-only, --diff-filter=A (L701 : le registre touché sans option, entrée neuve avec --registre)
  'src/bench/sans-juge.ts': ['name-only'], // L733 : git diff --name-only base..HEAD, les fichiers que le bras a livrés
  'src/bench/environnement.ts': ['version'], // L742 : claude --version au lancement du passage
  'src/bench/cli.ts': ['porcelain', 'oneline', 'reverse', 'format', 'binary'], // git status --porcelain, git log --oneline, git log --reverse --format=%s (Taille déclarée)
};
const prefixe = (k: string) => (k.startsWith('src/bench/') || k === 'src/sequence/cli.ts' || k === 'src/cli.ts' ? 'bench' : 'cadence2'); // l'aide de cli.ts et le banc séquence décrivent les options de « bench »
// Budgets de R29 : relever un total ou un module (même sous le total) est une violation ; le baisser est permis.
const BUDGET_R29: Record<string, { total: number; modules: Record<string, number> }> = {
  noyau: { total: 3000, modules: { plan: 350, accueil: 200, run: 1156, porte: 250, deliver: 450, hooks: 215 } }, // R32 : hooks, mécanisme du bras candidat ; issue #57 : run 455, run.ts détassé, messages gardés à toute fin ; L722 : run 466 (+11), le départ nomme les fichiers non commités de l'arbre principal (pas de ligne tassée)
  // L723 : run 520, rebase seul quand la cible avance pendant la porte (conflit rendu à la session, porte rejouée, arbre principal sale nommé), sans ligne tassée
  // L723 (revue, M1) : run 539, un conflit de rebase résolu est ajouté à l'état (conflits, détail de fin) et au journal sans remplacer le rapport du travail, sans ligne tassée
  // L722 (revue r1) : run 532 (-7), la lecture des fichiers non commités vient de scripts/arbre-non-commite.mjs, partagée avec src (copie retirée de run.ts)
  // L724 : run 557, la correction après porte rouge est ajoutée à l'état (corrections, détail de fin) et au journal sans remplacer le rapport du travail, sans ligne tassée
  // L724 (revue) : run 561 (+4), la reprise après quota pendant un conflit de rebase garde le rapport ; un seul mécanisme pour le dernier mot d'une session à sujet
  // L728 (issue #58) : run 562 (+1), --liste dit de quel tour vient le rapport (import de origineRapport dans run/cli.ts)
  // L728 (revue) : run 569 (+7), --liste sur cinq lignes et la ligne de fin sur deux au lieu d'une chacune (lignes détassées), Etat étend EtatRapport
  // L726 : run 670 (+101), aiguillage de modèle : escalade.ts (passes de correction et revues non conformes du lot, Fable d'office) et la ligne des modèles de chaque passe, sans ligne tassée
  // L726 (revue) : run 695 (+25), correction après revue seulement sur une revue non conforme neuve (revueApresIntegre), lignes à deux instructions détassées (run.ts, escalade.ts)
  // L745 (issue #62) : run 777 (+82), clore.ts : --liste dit « integre a la main » un run fini dont tous les commits sont sur la cible, --clore retire son worktree et sa branche, sans ligne tassée
  // L745 (revue, M1 et M2) : run 800 (+23), un conflit résolu à la main est reconnu par le contenu de ses fichiers, --clore --force, --reponse refuse un run clos ;
  // fichierRun et retirerRun (run.ts) partagés avec cli.ts et clore.ts au lieu de deux copies, sans ligne tassée
  // L745 (revue r2) : run 802 (+2), noms des fichiers du run lus avec -z et comparés en JS (plus de pathspec), un git diff qui échoue = non intégré, sans ligne tassée
  // L745 (4e passe) : run 846 (+44), clore.ts réécrit en contrat (une fonction par ligne du tableau de docs/v2/2026-11-09-cadence-run.md), reconnaissance par contenu
  // et git cherry retirés, patch-id calculés sans ignorer les sous-modules, sans ligne tassée
  // L745 (5e passe, changement de conception) : run 845 (-1), --clore archive chaque tête du run sous refs/cadence/archive/ avant de retirer quoi que ce soit, --liste
  // ne fait qu'afficher (merge-base --is-ancestor), cadence run --archives ; patch-id, tableau de reconnaissance et --force retirés, sans ligne tassée
  // L748 : run 881 (+36), escalade.ts lit aussi les revues du lot mises en attente (.cadence/plan-en-attente.yaml), sans ligne tassée
  mesure: { total: 2410, modules: { bench: 1693, sequence: 717 } }, // L689 : bench relevé de 800 à 984 plutôt que tassé (décision de Sylvain du 13-11) ; issue #57 : 998, bras.ts détassé, erreur nommée
  // L730 (D-22) : bench 1080, garde proportionnée (banc mécanique avant publication, alerte du banc complet du samedi) et complet.ts, sans ligne tassée
  // L730 (revue) : bench 1090, l'alerte ne tombe que sur un banc complet vert qui rejoue chaque rouge en attente (même séquence)
  // L730 (revue 2) : bench 1100, la garde en quatre règles (le banc rouge rejoué sur l'empreinte à publier, refus nommant les bancs à rejouer)
  // L730 (revue 3) : règle 2 bornée, un rejeu vert après le rouge (version corrigée ou suivante) lève l'alerte pour les empreintes suivantes
  // L730 (décision de Sylvain du 15-11) : bench 1104 (+4), règle 1 bornée par GARDE_DEPUIS (les rouges d'avant la mise en service sont déjà arbitrés)
  // L733 : bench 1134 (+30), un bras qui ne livre que du plan ou de la doc rend le banc mécanique non mesurable (sansLivrable, verdict, garde), sans ligne tassée
  // L734 : bench 1164 (+30), une suite rouge sous la charge des autres bancs est rejouée seule après eux (rejouerSuites), sans ligne tassée
  // L733 (revue 2) : bench 1167 (+3), les cinq règles du banc non livré écrites en tête de verdictSansJuge, seule fonction qui les porte
  // L736 : bench 1171 (+4), le banc court donne ses pièces au bras (piecesBanc) et le bras aiguillé garde le modèle de bras.yaml
  // L737 : bench 1240 (+69), le temps tient compte du bruit de chaque banc (bruitParBanc, criteresTemps, lirePassages, empreinte du bras), l'ordre des bras alterne d'un passage à l'autre, sans ligne tassée
  // L738 : bench 1320 (+80), le bruit d'un banc expire 14 jours après sa dernière paire A contre A et le banc complet du samedi le remesure (bench bruit, A contre son jumeau), sans ligne tassée
  // L738 (revue 1) : bench 1340 (+20), seules les paires A contre A du banc complet comptent pour le bruit (bruitDuSamedi, ecartPaire) et le seuil est la médiane des 3 dernières, sans ligne tassée
  // L739 : bench 1343 (+3), les bancs du court (1, 3 et 7) dans une seule constante, BANCS_COURT
  // L742 (D-23 B) : bench 1493 (+150), sequence 702 (+2), l'environnement de chaque rapport (Claude Code, modèle exact, réglages) comparé au précédent, sans ligne tassée
  // L752 : bench 1500 (+7), horlogeAPas exportée et Enfants.pas_horloge_ms passée aux bras des enfants (tests indépendants de la charge machine), sans ligne tassée
  // L756 (issue #61) : bench 1517 (+17), mesure 2219, run 885 (+4) : id exact du modèle dans l'historique, pour les juges et pour chaque passe de cadence run, sans ligne tassée
  // L756 (revue) : bench 1526 (+9), sequence 715 (+13), mesure 2241 : juges lus en stream-json (juge à part des auxiliaires), répétition interrompue avec ses étapes (modeles_exacts), sans ligne tassée
  // L762 : bench 1588 (+62), mesure 2303 : banc mécanique refusé sous la charge du lead (runs vivants, lead hold ; --malgre-charge noté au rapport), charge au départ et à la fin de chaque rapport, sans ligne tassée
  // L760 : run 888 (+3), la clé references: lue par scripts/references.mjs comme cadence ref (ancienne liste avec migration dite, forme mal formée refusée avant le worktree), sans ligne tassée
  // L763 (issue #63) : run 895 (+7), hooks 215 (+15) : premier-plan.mjs refuse run_in_background dans les sessions du run, --liste signale une session bloquée (--inactif), sans ligne tassée
  // L764 : run 917 (+22) : porte lue dans le cadence.yaml du run (différence avec l'arbre principal dite), environnement périmé détecté avant la porte (état environnement-perime), sans ligne tassée
  // L764 (revue r1) : run 923 (+6) : la porte changée par le run reprise au détail et sous la ligne de fin de l'état integre (porte_changee, comme L723), dite une fois par changement, sans ligne tassée
  // L767 : run 1027 (+104) : cadence run --purger [--dry-run] (purger.ts, délai run.purgeAfterDays) et --liste / --clore d'un run qui se reprend dont la tête est déjà sur la cible, sans ligne tassée
  // L773 (issue #64) : run 1032 (+5) : un journal par run --fond, nommé d'après l'id du run (nouvelIdRun, ID_RUN), sans ligne tassée.
  // L781 : run 1137 (+105) : regenerer.ts, les commandes du projet qui appellent cadence (scripts.news, plan.onWrite) jouées par le run avant la porte et commitées, retirées puis rejouées avant un rebase, sans ligne tassée.
  // L781 (revue r1) : run 1152 (+15) : run.regenerate déclaré dans cadence.yaml (scripts/regeneration.mjs) au lieu de scripts.news, tous les commits de régénération retirés avant un rebase ou une reprise de session, échec de régénération à correction propre, fichier non commité réécrit refusé, sans ligne tassée.
  // L784 : run 1156 (+4) : la porte du run note son verdict (scripts/verdicts-porte.mjs) là où le hook pre-push le lit, comme verify --gate (L786), sans ligne tassée.
  // L775 : bench 1609 (+21), sequence 717 (+2), mesure 2326 : un appel refusé par le hook du bras n'est plus compté en fuite (refusParHook), sans ligne tassée.
  // L777 : bench 1672 (+63), mesure 2389 : « tests d'origine verts » compte les tests d'origine réussis par bras, marge de bruit (MARGE_CACHES, retirée en revue r1), sans ligne tassée.
  // L777 (revue r1) : bench 1693 (+21), mesure 2410 : marge retirée (candidat ≥ A test par test), lanceur compté seulement s'il a un bilan dans les deux journaux
  // et aucun rouge dans la suite seule (cachesReussis, caches_hors_compte), banc non mesurable sinon, sans ligne tassée.
};
function reglesBudget(f: Fichiers): string[] {
  const b = JSON.parse(f['budget.json']) as Record<string, { total: number; modules: Record<string, number> }>;
  const v: string[] = [];
  if (Object.keys(b).sort().join(',') !== 'mesure,noyau') v.push(`C4 : groupes de budget ${Object.keys(b).join(', ')} (R29 : noyau, mesure)`);
  for (const [g, r] of Object.entries(BUDGET_R29)) {
    if (!(b[g]?.total <= r.total)) v.push(`C4 : total ${g} ${b[g]?.total} > ${r.total}`);
    for (const [m, n] of Object.entries(b[g]?.modules ?? {})) if (!(n <= (r.modules[m] ?? 0))) v.push(`C4 : budget ${g}.${m} ${n} > ${r.modules[m] ?? 0}`);
  }
  return v;
}
function reglesC4(f: Fichiers, existe: (chemin: string) => boolean): string[] {
  const opts = (JSON.parse(f['options.json']) as { options: Record<string, string> }).options;
  const v: string[] = reglesBudget(f);
  const exige = (cle: string) => {
    if (!(cle in opts)) v.push(`C4 : « ${cle} » sans justification dans options.json`);
    else if (!existe(opts[cle])) v.push(`C4 : ${opts[cle]} (pour « ${cle} ») n'existe pas`);
  };
  for (const k of sources(f)) {
    const t = sansCommentaires(f[k]);
    const flags = new Set([...t.matchAll(/(?<![\w-])--([A-Za-z][\w-]*)/g)].map((m) => m[1]));
    for (const m of t.matchAll(/option\(\s*\w+,\s*'([\w-]+)'\s*\)/g)) flags.add(m[1]);
    for (const fl of flags) if (!(FLAGS_CLI[k] ?? []).includes(fl)) exige(`${prefixe(k)} --${fl}`);
    for (const m of t.matchAll(/\b(?:process\.)?env\.(\w+)/g)) exige(`${prefixe(k)} env ${m[1]}`);
    if (/\bargv\b/.test(t)) exige(`${prefixe(k)} argv`);
  }
  return v;
}

// ---------------------------------------------------------------------------------------------------------------------
// C5, rattrapages du lead : les critères bloquants restent bloquants (le comportement est testé plus bas, ici la forme du code)
function reglesC5(f: Fichiers): string[] {
  const t = f['src/bench/verdict.ts'] ?? '';
  const v: string[] = [];
  if (!/c\('questions inutiles', [^\n]*, inutiles === 0\),/.test(t)) v.push('C5 : « questions inutiles » n\'est plus un critère bloquant simple');
  if (!/c\('aucun bras en échec', [^\n]*, echecs\.length === 0\),/.test(t)) v.push('C5 : « aucun bras en échec » n\'est plus un critère bloquant simple');
  if (!/bloquant = true\)/.test(t)) v.push('C5 : bloquant n\'est plus vrai par défaut');
  if (/\bc\('[^\n]*', [^\n]*, true(, (?:true|false))?\),/.test(t)) v.push('C5 : un critère a un ok constant (true)');
  if (!/vert: criteres\.every\(\(x\) => x\.ok \|\| !x\.bloquant\)/.test(t)) v.push('C5 : la formule du vert a changé');
  if (!/export const BANCS_COURT = \['1', '3', '7'\];/.test(t) || !/BANCS_COURT\.every/.test(t)) v.push('C5 : statut ne demande plus 1, 3 et 7 (L739)');
  if (!/m\.candidat !== m\.reference/.test(t)) v.push('C5 : la publication accepte un candidat égal à la référence (A contre A)');
  if (!/\n\s*&& seqOk\(seqs, \(s\) => reel\(s\) && s\.vert && s\.candidat === m\.candidat && s\.modele_candidat === m\.modele_candidat\)[,;]/.test(t))
    v.push('C5 : la publication ne demande plus une séquence verte (R30)');
  // L730 (D-22, garde en quatre règles, docs/v2/banc.md) : tant qu'une alerte tient, rien ne publie, ni le mécanique ni un banc complet vert
  if (!/enAttente\.length === 0 && \(mecaOk \|\| completOk\)/.test(t)) v.push('C5 : une alerte du banc complet n\'empêche plus la publication (L730)');
  // L730 (revues) : une alerte ne tombe que si CE banc est rejoué vert : la même séquence (même id), écrite APRÈS le rouge (revue 3 : sur toute
  // empreinte postérieure, pas seulement celle à publier)
  if (!/y\.type === 'sequence' && \(y\.sequence \?\? ''\) === \(rg\.sequence \?\? ''\)/.test(t)) v.push('C5 : une séquence rouge est levée par une autre séquence (L730, revue)');
  if (!/h\.slice\(h\.indexOf\(rg\) \+ 1\)\.filter\(duComplet\)/.test(t)) v.push('C5 : un banc rouge est levé par un vert d\'avant lui, ou par un banc hors du complet (L730, revue 3)');
  // banc séquence (S4, R30) : mêmes garde-fous sur sequence/verdict.ts
  const q = f['src/sequence/verdict.ts'] ?? '';
  if (!/return \{ vert: criteres\.every\(\(x\) => x\.ok \|\| !x\.bloquant\), criteres \};/.test(q)) v.push('C5 : séquence, la formule du vert a changé');
  if (!/ok, bloquant: true \}\);/.test(q)) v.push('C5 : séquence, un critère n\'est plus bloquant');
  if (!/c\(nom, 'non mesuré', [^\n]*?, false\)/.test(q)) v.push('C5 : séquence, une pente non mesurée n\'est plus rouge');
  if (!/lc\.absents\.length === 0 && lc\.entieres === lc\.t\),/.test(q)) v.push('C5 : séquence, « pièces lues avant le code » n\'exige plus 100 % en entier');
  if (/\|\|\s*true\b/.test(sansCommentaires(t) + sansCommentaires(q))) v.push('C5 : « || true » dans un verdict');
  return v;
}

// Barre de la spec §1 : temps au plus 1,5 × la référence (1,2 × sur les retouches).
function reglesBarre(b: { temps_max: number; temps_max_retouche: number }): string[] {
  return b.temps_max === 1.5 && b.temps_max_retouche === 1.2 ? [] : ['C5 : BARRE_SPEC a bougé (spec §1 : 1,5 et 1,2)'];
}

const existeReel = (p: string) => existsSync(join(depot, p));

describe('les vrais fichiers respectent les règles', () => {
  it('C1', () => expect(reglesC1(reel)).toEqual([]));
  it('C2', () => expect(reglesC2(reel)).toEqual([]));
  it('C3', () => expect(reglesC3(reel)).toEqual([]));
  it('C4', () => expect(reglesC4(reel, existeReel)).toEqual([]));
  it('C5', () => expect(reglesC5(reel)).toEqual([]));
  it('barre §1 exacte', () => expect(reglesBarre(BARRE_SPEC)).toEqual([]));
  it('au moins une option est lue (la règle C4 ne tourne pas à vide)', () =>
    expect(Object.keys(JSON.parse(reel['options.json']).options).length).toBeGreaterThan(5));
});

// ---------------------------------------------------------------------------------------------------------------------
// Table de mutations : chaque régression connue, appliquée à une copie en mémoire, doit lever au moins une violation.
type Regle = (f: Fichiers) => string[];
const regles: Record<string, Regle> = { C1: reglesC1, C2: reglesC2, C3: reglesC3, C4: (f) => reglesC4(f, existeReel), C5: reglesC5 };
const ajout = (s: string) => (t: string) => `${t}\n${s}\n`;
const remplace = (de: string | RegExp, par: string) => (t: string) => t.replace(de, par);
const mutations: [string, string, string, (t: string) => string][] = [
  // les 14 sondes du premier passage
  ['C1', 'scellé dans un brief', 'briefs/bras-A.md', ajout('le scellé')],
  ['C1', 'spec: dans src', 'src/bench/banc.ts', ajout('// spec: x')],
  ['C1', '{{DEMANDE}} retiré', BRIEF_CAND, remplace('{{DEMANDE}}', '')],
  ['C1', 'relecteur sans diff', BRIEF_CAND, remplace('git -C {{CLONE}} diff', 'git log')],
  ['C2', 'nouvelle session', 'briefs/bras-A.md', ajout('ouvre une nouvelle session')],
  ['C2', 'juge par défaut sonnet', 'src/bench/cli.ts', remplace("?? 'opus'", "?? 'sonnet'")],
  ['C2', "modele: 'sonnet'", 'src/bench/bras.ts', ajout("const d = { modele: 'sonnet' };")],
  ['C3', 'trois portes', 'src/bench/banc.ts', ajout('porte(1);\ngate(2);\nverifyAll(3);')],
  ['C3', 'budget porte 400', 'budget.json', remplace('"porte": 250', '"porte": 400')],
  ['C4', 'total mesure relevé', 'budget.json', remplace('"total": 2410', '"total": 2450')],
  ['C4', 'total noyau relevé', 'budget.json', remplace('"total": 3000', '"total": 3500')],
  ['C4', 'budget sequence relevé', 'budget.json', remplace('"sequence": 717', '"sequence": 900')],
  ['C4', 'budget plan relevé sous le total', 'budget.json', remplace('"plan": 350', '"plan": 1000')],
  ['C4', 'budget hooks relevé (R32)', 'budget.json', remplace('"hooks": 215', '"hooks": 300')],
  ['C4', 'hooks déplacé dans la mesure', 'budget.json', (t) => t.replace('"deliver": 450, "hooks": 215', '"deliver": 450').replace('"sequence": 717', '"sequence": 717, "hooks": 215')],
  ['C4', 'module sans budget R29', 'budget.json', remplace('"bench": 1693', '"bench": 1693, "outil": 100')],
  ['C4', 'groupe de budget ajouté', 'budget.json', remplace(/\n}\s*$/, ',\n  "autre": { "total": 900, "modules": {} }\n}')],
  ['C4', "option(reste,'zzz') sans entrée", 'src/bench/cli.ts', remplace("option(reste, 'taille')", "option(reste, 'zzz')")],
  ['C4', 'chemin options.json inexistant', 'options.json', remplace('"bench --juge": "docs/v2/2026-11-07-cadence-2-design.md"', '"bench --juge": "docs/v2/mesures/rien.md"')],
  ['C5', 'questions inutiles non bloquant', 'src/bench/verdict.ts', remplace('inutiles === 0)', 'inutiles === 0, false)')],
  ['C5', 'aucun bras en échec non bloquant', 'src/bench/verdict.ts', remplace('echecs.length === 0)', 'echecs.length === 0, false)')],
  ['C5', 'publication sur A contre A', 'src/bench/verdict.ts', remplace('m.candidat !== m.reference', 'true')],
  ['C5', 'statut sans le banc 7', 'src/bench/verdict.ts', remplace("BANCS_COURT = ['1', '3', '7']", "BANCS_COURT = ['1', '3']")],
  ['C5', 'statut ne lit plus les bancs du court', 'src/bench/verdict.ts', remplace('BANCS_COURT.every', "['1', '3'].every")],
  // déguisements essayés par le relecteur Opus
  ['C5', 'critère neutralisé par || true', 'src/bench/verdict.ts', remplace('inutiles === 0)', 'inutiles === 0 || true)')],
  ['C5', 'bloquant faux par défaut', 'src/bench/verdict.ts', remplace('bloquant = true)', 'bloquant = false)')],
  ['C2', '--model sonnet dans un brief', 'briefs/bras-A.md', ajout('lance claude --model sonnet')],
  ['C2', '"model": "Haiku" dans src', 'src/bench/juges.ts', ajout('const j = { "model": "Haiku" };')],
  ['C2', 'doc du banc en sonnet', 'docs/banc.md', ajout('modele: sonnet')],
  ['C2', 'le bras ne reprend plus la session', 'src/bench/bras.ts', remplace(/'--resume'/g, "'--continue'")],
  ['C4', 'option entre guillemets doubles', 'src/bench/cli.ts', ajout('const x = ["--zzz"];')],
  ['C4', 'option dans un gabarit', 'src/bench/preparer.ts', ajout('const y = `--yyy`;')],
  ['C4', 'variable d\'environnement lue', 'src/bench/banc.ts', ajout('const z = process.env.CADENCE_TRUC;')],
  ['C4', 'lecture de argv', 'src/cli.ts', ajout('const a = process.argv.slice(2);')],
  ['C4', 'clé options.json au suffixe seulement', 'options.json', remplace('"bench --juge"', '"xbench --juge"')],
  ['C1', 'plan dans le paragraphe du relecteur', BRIEF_CAND, remplace('Donne-lui seulement', 'Donne-lui le plan du lot, puis seulement')],
  ['C1', 'phrase du relecteur modifiée', BRIEF_CAND, remplace('la sortie de `git -C', 'le résumé de `git -C')],
  ['C1', 'snapshot dans src', 'src/bench/fuites.ts', ajout('// snapshot de référence')],
  ['C1', 'contrat dans un brief', 'briefs/juge-aveugle.md', ajout('Respecte le contrat.')],
  ['C1', 'relecteur sur tout le dépôt', BRIEF_CAND, remplace('{{BASE}}..HEAD', '4b825dc..HEAD')],
  ['C1', 'relecteur sans model opus', BRIEF_CAND, remplace(', model opus', '')],
  ['C2', 'sous-agent qui écrit le code', BRIEF_CAND, ajout("Délègue l'implémentation à un sous-agent, subagent_type general-purpose")],
  ['C5', 'critère ok constant', 'src/bench/verdict.ts', remplace("'0', fuites.length === 0)", "'0', true)")],
  ['C1', 'second gabarit toléré par erreur', 'src/bench/juges.ts', ajout('// un gabarit de plus')],
  ['C1', 'seconde conformité', 'src/bench/ajouter.ts', ajout('// conformité')],
  // banc séquence (R30)
  ['C5', 'séquence : pièces lues neutralisé', 'src/sequence/verdict.ts', remplace('lc.entieres === lc.t)', 'lc.entieres >= 0)')],
  ['C5', 'séquence : pente non mesurée verte', 'src/sequence/verdict.ts', remplace("'non mesuré', `≤ ${ref}`, false)", "'non mesuré', `≤ ${ref}`, true)")],
  ['C5', 'publication sans séquence', 'src/bench/verdict.ts', remplace(/\n\s*&& seqOk\([^\n]*\);/, ';')],
  ['C5', 'alerte du banc complet ignorée (L730)', 'src/bench/verdict.ts', remplace('enAttente.length === 0 && (mecaOk || completOk)', '(mecaOk || completOk)')],
  ['C5', 'banc complet vert sans le banc rouge pendant une alerte (L730, revue 2)', 'src/bench/verdict.ts', remplace('enAttente.length === 0 && (mecaOk || completOk)', '(enAttente.length === 0 && mecaOk) || completOk')],
  ['C5', 'séquence rouge levée par une autre séquence (L730, revue)', 'src/bench/verdict.ts', remplace(" && (y.sequence ?? '') === (rg.sequence ?? '')", '')],
  ['C5', 'banc rouge levé par un vert d\'avant lui (L730, revue 3)', 'src/bench/verdict.ts', remplace('h.slice(h.indexOf(rg) + 1).filter(duComplet)', 'h.filter(duComplet)')],
  ['C5', 'séquence : || true sur le every final', 'src/sequence/verdict.ts', remplace('x.ok || !x.bloquant)', 'x.ok || !x.bloquant || true)')],
  ['C3', 'porte déguisée en controle', 'src/bench/banc.ts', ajout('controle(a);\ncheckAll(b);\nverif(c);')],
  // bras candidat de la séquence (S5)
  ['C1', 'séquence : carte donnée au relecteur', 'briefs/bras-sequence-v2.md', remplace('Donne-lui seulement', 'Donne-lui la carte, puis seulement')],
  ['C1', 'séquence : relecteur sans model opus', 'briefs/bras-sequence-v2.md', remplace(', model opus', '')],
  ['C1', 'séquence : le bras reclasse la taille', 'briefs/bras-sequence-v2.md', remplace('Taille fixée par le gardien : {{TAILLE}}', 'Classe la demande')],
  ['C2', 'séquence : sous-agent qui écrit le code', 'briefs/bras-sequence-v2.md', ajout("- Délègue l'implémentation (subagent_type general-purpose)")],
  ['C1', 'séquence : fiche dans le brief', 'briefs/bras-sequence-v2.md', ajout('Respecte la fiche.')],
  ['C1', 'séquence v2b : le bras reclasse la taille', 'briefs/bras-sequence-v2b.md', remplace('Taille fixée par le gardien : {{TAILLE}}', 'Classe la demande')],
  ['C1', 'séquence v2c : le bras reclasse la taille', 'briefs/bras-sequence-v2c.md', remplace('Taille fixée par le gardien : {{TAILLE}}', 'Classe la demande')],
  ['C1', 'séquence v2d : le bras reclasse la taille', 'briefs/bras-sequence-v2d.md', remplace('Taille fixée par le gardien : {{TAILLE}}', 'Classe la demande')],
];
describe('mutation : chaque régression connue est détectée', () => {
  it.each(mutations)('%s : %s', (cause, _nom, fichier, muter) => {
    expect(reel[fichier], `${fichier} absent`).toBeDefined();
    const copie = { ...reel, [fichier]: muter(reel[fichier]) };
    expect(copie[fichier]).not.toBe(reel[fichier]);
    expect(regles[cause](copie).length, `${cause} : la régression n'est pas vue`).toBeGreaterThan(0);
  });
});

it('mutation : BARRE_SPEC.temps_max à 3 serait vu', () => {
  expect(reglesBarre({ ...BARRE_SPEC, temps_max: 3 }).length).toBeGreaterThan(0);
  expect(reglesBarre({ ...BARRE_SPEC, temps_max_retouche: 2 }).length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------------------------------------------------
// C5 par le comportement : une régression déguisée dans verdict.ts ne doit pas passer
describe('C5, comportement de verdict, rapport et historique', () => {
  const mes = (bras: string, questions: number, echec: string | null) =>
    ({ bras, banc: 'b', debut: '', fin: '', duree_s: 100, tokens: 1, cout_usd: 1, questions, questions_texte: [], sessions: [], echec });
  const banc = (o: { questionsC?: number; echecC?: string }): ResultatBanc => ({
    banc: 'b', taille: 'fonction', visible: false, reponses: false, frais: false,
    mesures: { A: mes('A', 0, null), C: mes('C', o.questionsC ?? 0, o.echecC ?? null) }, jugement: null, fuites: { A: [], C: [] } });
  const cas: [string, ResultatBanc][] = [['questions inutiles', banc({ questionsC: 1 })], ['aucun bras en échec', banc({ echecC: 'code 1' })]];

  it.each(cas)('« %s » : bloquant, rouge, vert faux, nommé dans le rapport et dans l\'historique', (nom, b) => {
    const v = verdict([b], 'A', 'C', BARRE_SPEC);
    expect(v.criteres.find((c) => c.nom === nom)).toMatchObject({ bloquant: true, ok: false });
    expect(v.vert).toBe(false);
    const md = rapport([b], 'A', 'C', v, { date: '2026-11-07', empreinte: 'e1' });
    for (const c of v.criteres) expect(md, `critère « ${c.nom} » absent du rapport`).toContain(c.nom);
    expect(md).toContain('**ROUGE**');
    const h = JSON.parse(ligneHistorique(v, { date: '2026-11-07T10:00:00Z', empreinte: 'e1', candidat: 'C', reference: 'A', modele_candidat: 'opus', bancs: ['b'], hebdo: false, frais: 0 }));
    expect(h.vert).toBe(false);
    expect(h.rouges).toContain(nom);
  });
  it('statut refuse la publication sans passage couvrant 1, 3 et 7 (L739)', () => {
    const ligne = (bancs: string[]) => JSON.stringify({ date: '2026-11-07T10:00:00Z', empreinte: 'e1', candidat: 'C', reference: 'A', modele_candidat: 'opus', vert: true, hebdo: false, frais: 0, bancs });
    const now = new Date('2026-11-07T12:00:00Z');
    expect(statut([ligne(['1-a', '3-b'])], now, 'e1', { C: 'opus' }).publication_ok).toBe(false);
    const seq = JSON.stringify({ ...JSON.parse(ligne(['s'])), type: 'sequence', sequence: 's', run: 'r1', repetition: 1, repetitions: 1 });
    expect(statut([ligne(['1-a', '3-b', '7-c'])], now, 'e1', { C: 'opus' }).publication_ok).toBe(false); // sans séquence verte
    expect(statut([ligne(['1-a', '3-b', '7-c']), seq], now, 'e1', { C: 'opus' }).publication_ok).toBe(true);
    expect(statut([ligne(['1-a', '3-b', '6-c']), seq], now, 'e1', { C: 'opus' }).publication_ok).toBe(false); // L739 : le banc 6 ne fait plus le court
  });
});

describe('C2, une seule session par bras', () => {
  it('les appels suivants reprennent la session du premier (--resume), sans nouvelle session', () => {
    const r = dossierTemp('rechute-');
    const dir = join(r, 'bancs', '1-t'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'demande.md'), 'Ajoute un séparateur.'); writeFileSync(join(dir, 'reponses.md'), 'Oui.');
    const clone = join(r, 'runs', 'A'); mkdirSync(clone, { recursive: true });
    const b: Banc = { id: '1-t', dir, secrets: join(r, 's'), projet: 't', source: '/s', base: 'abc1234', install: 'true', tests: 'true',
      visible: false, taille: 'retouche', frais: false, reponses: true };
    const appels: string[][] = [];
    const exec: Executeur = (args) => {
      appels.push(args);
      if (appels.length <= 2) writeFileSync(`${clone}.question.md`, '?');
      return { stdout: JSON.stringify({ session_id: 's1', total_cost_usd: 0, modelUsage: {} }), code: 0 };
    };
    const m = lancerBras(b, { nom: 'A', modele: 'opus', brief: join(v2, 'briefs', 'bras-A.md') }, clone, exec);
    expect(appels.length).toBe(3);
    expect(appels[0]).not.toContain('--resume');
    for (const a of appels.slice(1)) expect(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 2)).toEqual(['--resume', 's1']);
    expect(m.sessions).toEqual(['s1']);
  });
});
