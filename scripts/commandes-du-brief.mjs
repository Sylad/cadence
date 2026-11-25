// L792 (issue #68) : le brief de cadence run (v2/src/run/run.ts) nomme les commandes de vérification du projet quand le travail touche des fiches d'écran.
// Le 19-11, une session chargée d'amener des fiches à « fiche valide » n'a jamais lancé `cadence spec check` (le brief n'en disait rien et interdisait
// `cadence`), a reconstruit les règles depuis git et s'est crue à 0 écart : 97 restaient. Cause : découverte. Le brief nomme donc la commande, et la session
// peut la lancer (interdiction de `cadence` levée pour `cadence spec check|qa` seules). Générique : tout est lu dans la clé `orchestrate` de cadence.yaml
// (spec.dir, build, test, accept), rien n'est propre à un projet. Le run ne juge rien contre une fiche : il dit à la session quelle commande le fait.
// Revue r1 (M1) : les motifs de --disallowedTools ne savent pas dire « cadence spec sauf check|qa » (un deny `cadence spec:*` l'emporterait sur tout) ;
// le hook PreToolUse v2/hooks/seul-spec-check.mjs (posé par avecRefusCadence) refuse donc tout appel de cadence ou de raf autre que `cadence spec check|qa`.
// L840 : `cadence analyse` (--help, --init, sans option, --contre <ref>, filtrée par --outil <nom>) est permise dans TOUTE session de run : 5 runs
// d'adoption sur 6 du 25-11 s'arrêtaient sur une question, la session ayant vu `cadence analyse --init` et même `--help` refusées (deny `Bash(cadence:*)`).
// Ses autres modes (--ecrire, --migrer) réécrivent une ligne de base : refusés par le hook. Une demande ou un lot qui cite l'analyse reçoit docs/analyse.md.
// JavaScript, comme scripts/etapes-porte.mjs : v2 l'importe hors de son rootDir.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { lireEtapes } from './etapes-porte.mjs';
import { lotDuPlan } from './nouveautes-du-run.mjs';

/** Les outils de bin/cadence.js hors `spec` (ses verbes autres que check|qa sont refusés par le hook) ; une session de run n'en lance aucun, sauf ceux
 * d'OUTILS_PERMIS dans les limites du hook. */
export const OUTILS_CADENCE = ['run', 'sondes', 'analyse', 'ecriture', 'raf', 'news', 'session', 'deliver', 'verify', 'eval', 'skills', 'orchestrate', 'lead', 'corrections', 'perf',
  'cost', 'inspect', 'ref', 'config', 'release', 'local', 'claude-hook'];
const SPEC_DU_LEAD = ['green', 'reseal'];
/** L840 : les outils de cadence qu'une session de run peut lancer, options bornées par le hook (cadence-permise.mjs). */
export const OUTILS_PERMIS = ['analyse'];
/** La documentation de `cadence analyse`, publiée avec le paquet (files de package.json), jointe comme pièce quand la demande ou le lot la cite. */
export const DOC_ANALYSE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'analyse.md');
const OPTIONS_ANALYSE = new Set(['--help', '-h', '--init']), OPTIONS_ANALYSE_VALEUR = new Set(['--contre', '--outil']);

/** orchestrate.spec.dir (défaut docs/specs, comme src/config.ts) ; une valeur que src/config.ts refuserait garde le défaut. */
function dossierSpecs(o) {
  const d = typeof o.spec?.dir === 'string' ? o.spec.dir.trim().replace(/\/+$/, '') : '';
  return d && !isAbsolute(d) && !d.split(/[\\/]/).includes('..') ? d : 'docs/specs';
}
/** Le nombre de fiches `<dir>/<écran>/fiche.yaml` présentes. */
const fichesPresentes = (repo, dir) => (existsSync(join(repo, dir))
  ? readdirSync(join(repo, dir), { withFileTypes: true }).filter((x) => x.isDirectory() && existsSync(join(repo, dir, x.name, 'fiche.yaml'))).length
  : 0);
const plat = (t) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** La demande parle de fiches (d'écran, back, mixtes, valides, fiche.yaml, spec check). */
export const demandeToucheFiches = (demande) => /fiches? (d['’]ecrans?|back|mixtes?|valides?)|fiche\.yaml|spec check/.test(plat(demande));
const code = (cs) => cs.map((c) => `\`${c}\``).join(', puis ');

/** Revue r1 (m1) : le lot du plan (`lot`, sous-tâche comprise) a la spec (`spec: true`) ou un écran (`screen: page`, qui l'implique). Plan lu par
 * lotDuPlan (scripts/nouveautes-du-run.mjs, L794) ; un plan absent ou illisible vaut non. */
export function lotAFiches(repo, lot) {
  const trouve = lotDuPlan(repo, lot);
  return trouve?.spec === true || trouve?.screen === 'page';
}

/**
 * Le paragraphe du brief (`texte`, vide quand ni la demande, ni le dépôt, ni le lot du plan n'ont de fiches) et s'il nomme `cadence spec check` (`nommeSpec`).
 * `orchestrate` : la clé de cadence.yaml du worktree du run, déjà lue ; `lot` : le lot du plan du run, s'il en a un. L840 : suivi du paragraphe sur
 * `cadence analyse` (consigneAnalyse) ; `analyse` : le brief la nomme ; `pieces` : celles du run, docs/analyse.md ajoutée quand la demande ou le lot la cite.
 */
export function commandesNommees(repo, orchestrate, demande, lot, pieces = []) {
  const a = consigneAnalyse(repo, demande, lot, analyseDeclaree(repo)); // L840
  const analyse = { analyse: a.nomme, pieces: a.piece && !pieces.includes(a.piece) ? [...pieces, a.piece] : pieces };
  const spec = verificationsSpec(repo, orchestrate, demande, lot);
  return { texte: `${spec.texte}${a.texte}`, nommeSpec: spec.nommeSpec, ...analyse };
}
function verificationsSpec(repo, orchestrate, demande, lot) {
  const o = orchestrate ?? {}, dir = dossierSpecs(o), n = fichesPresentes(repo, dir);
  if (!n && !demandeToucheFiches(demande) && !lotAFiches(repo, lot)) return { texte: '', nommeSpec: false };
  const lignes = [
    `- Fiches d'écran (\`${dir}/<écran>/fiche.yaml\`, ${n ? `${n} dans le dépôt` : 'aucune encore'}) : \`cadence spec check <fiche.yaml>\`, une fiche par appel ; `
    + 'code 0 et son résumé quand elle est valide, sinon une ligne « ✗ … » par écart et code 1. '
    + `Toutes : \`for f in ${dir}/*/fiche.yaml; do cadence spec check "$f"; done\`. C'est la seule commande \`cadence\` permise dans cette session.`,
  ];
  const etapes = lireEtapes(o);
  for (const e of etapes.etapes ?? []) lignes.push(`- ${e.nom === 'build' ? 'Build (orchestrate.build)' : 'Tests (orchestrate.test)'} : ${code(e.commandes)}.`);
  const accept = (typeof o.accept === 'string' ? [o.accept] : Array.isArray(o.accept) ? o.accept : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  if (accept.length) lignes.push(`- Tests d'acceptation (orchestrate.accept) : ${code(accept)} ; ils ne lancent que les tests listés par \`CADENCE_ACCEPTATION\` `
    + `(chemin de \`${dir}/<écran>/acceptation-<lot>.json\`, aussi substitué à \`{acceptation}\`).`);
  const tete = 'Vérifications du projet (lues dans cadence.yaml) : lance-les toi-même et fie-toi à leur sortie, jamais à une relecture des règles '
    + '(code, historique git) ; ne dis pas qu\'une fiche est valide tant que `cadence spec check` ne l\'a pas dit.';
  return { texte: `${[tete, ...lignes].join('\n')}\n\n`, nommeSpec: true };
}

const ANALYSE_DITE = '`cadence analyse` (sans option, `--init`, `--contre <ref>`, `--outil <nom>`, `--help`)';
/** La ligne « N'utilise ni raf ni cadence » des briefs, avec ses exceptions : `cadence spec check` (`specCheck`), `cadence analyse` (`analyse`). */
export function leverPourCadence(brief, { specCheck = false, analyse = false } = {}) {
  const ex = [...(specCheck ? ['`cadence spec check`, nommée dans les vérifications plus haut'] : []), ...(analyse ? [`${ANALYSE_DITE}, nommée plus haut`] : [])];
  if (!ex.length) return brief;
  return brief.replaceAll("N'utilise ni `raf` ni `cadence`", `N'utilise ni \`raf\` ni \`cadence\` (${ex.length > 1 ? 'seules exceptions' : 'seule exception'} : ${ex.join(' ; ')})`);
}
export const leverPourSpec = (brief) => leverPourCadence(brief, { specCheck: true });

/** cadence.yaml du dépôt déclare une clé analyse: ; illisible : non. */
function analyseDeclaree(repo) {
  try {
    return parse(readFileSync(join(repo, 'cadence.yaml'), 'utf8'))?.analyse !== undefined;
  } catch {
    return false;
  }
}
/** La demande ou le lot du plan (titre, notes) cite l'analyse : `cadence analyse`, la clé `analyse:` ou « analyse statique ». Revue r1 (M2) : aucun identifiant
 * de demande (chaque dépôt a son registre, ses D-<n> n'ont pas le même sens ailleurs). */
const CITE_ANALYSE = /cadence analyse|(^|[^\w-])analyse:|analyse statique/;
export function analyseCitee(repo, demande, lot) {
  const l = lotDuPlan(repo, lot), texte = `${demande}\n${l ? JSON.stringify({ ...l, tasks: undefined }) : ''}`;
  return CITE_ANALYSE.test(plat(texte));
}
/**
 * L840 : le paragraphe du brief sur `cadence analyse` (vide quand ni la demande, ni le lot, ni la clé analyse: du dépôt n'en parlent) et la pièce à joindre
 * (`piece` : DOC_ANALYSE quand la demande ou le lot la cite et qu'elle existe). `declare` : cadence.yaml du worktree a une clé analyse:.
 */
export function consigneAnalyse(repo, demande, lot, declare) {
  const cite = analyseCitee(repo, demande, lot), piece = cite && existsSync(DOC_ANALYSE) ? DOC_ANALYSE : undefined;
  if (!cite && !declare) return { texte: '', nomme: false };
  const texte = `Analyse statique : ${ANALYSE_DITE} est permise dans cette session (les autres modes, --ecrire et --migrer, restent au lead) ; `
    + 'elle joue les outils de la clé analyse: de cadence.yaml contre leur ligne de base (.cadence/analyse/<outil>.json).'
    + `${piece ? ` Pièce jointe : ${piece} (la documentation de cadence analyse), à lire en entier avant d'écrire.` : ''}\n\n`;
  return { texte, nomme: true, ...(piece ? { piece } : {}) };
}

/** Les interdits de la session : `Bash(cadence:*)` remplacé par chaque outil de cadence sauf ceux d'OUTILS_PERMIS (L840) ; `spec` (fiches nommées au
 * brief, `specCheck`) : `cadence spec` permise sauf ses verbes du lead, le reste (`<lot> on|off`, qui écrit le plan) refusé par le hook ; sinon `cadence spec` interdite. */
export const interditsDuRun = (interdits, { specCheck = false } = {}) => interdits.flatMap((x) => (x === 'Bash(cadence:*)'
  ? [...OUTILS_CADENCE.filter((t) => !OUTILS_PERMIS.includes(t)).map((t) => `Bash(cadence ${t}:*)`),
    ...(specCheck ? SPEC_DU_LEAD.map((v) => `Bash(cadence spec ${v}:*)`) : ['Bash(cadence spec:*)'])] : [x]));

/** Les réglages de la session avec le hook PreToolUse qui refuse tout cadence ou raf hors `cadence analyse` bornée et, avec `specCheck`, `cadence spec check|qa`
 * (`hooks` : le dossier v2/hooks). */
export const avecRefusCadence = (reglages, hooks, { specCheck = false } = {}) => ({ ...reglages, hooks: { ...reglages.hooks, PreToolUse: [...(reglages.hooks?.PreToolUse ?? []),
  { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${join(hooks, 'cadence-permise.mjs')}"${specCheck ? ' --spec' : ''}`, timeout: 10 }] }] } });

/** Les morceaux d'une commande shell : texte entre guillemets, caractère échappé, heredoc (`<<[-]MOT`, dont le corps est sauté), opérateur de redirection
 * (`&>`, `&>>`, `>&`, `<&`, `>|`, `>>`, `<>`, `>`, `<` : revue r1 de L840, M1, son `&` ou son `|` ne sépare pas), séparateur (&& || ; | & retour à la ligne,
 * `$(`, `(`, `)`, `` ` ``), texte. */
const MORCEAU = /"(?:\\[\s\S]|[^"\\])*"?|'[^']*'?|\\[\s\S]|<<<|<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;|&<>()`'"]+))|&>>?|[<>]&|>\||>>|<>|[<>]|&&|\|\||\|&|\$\(|[;|&\n()`]|[^"'\\;|&\n()`$<>]+|\$/gy;
const SEPARE = /^(?:&&|\|\||\|&|\$\(|[;|&\n()`])$/;
/** Ce qui précède le programme sans le changer : affectation, `!`, `{`, mot-clé, env/command/exec/time/nohup/sudo (chemin compris : `/usr/bin/env`), npx et
 * npm|pnpm|yarn exec|dlx, node, et leurs options. */
const PREFIXE = /^(?:[A-Za-z_]\w*=\S*|[!{]|if|then|elif|else|do|while|until|(?:\S*\/)?(?:time|command|exec|sudo|nohup|env)|npx|node|(?:npm|pnpm|yarn)\s+(?:exec|dlx)|-\S*)$/;
/** Revue r2 (m1) : les options de sudo et de env suivies d'une valeur (`sudo -u x cadence`, `env -u VAR cadence`) : la valeur n'est pas le programme. */
const AVEC_VALEUR = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '-R', '--user', '--group', '--close-from', '--chdir', '--host', '--prompt', '--role',
    '--type', '--other-user', '--command-timeout', '--chroot']),
  env: new Set(['-u', '-C', '--unset', '--chdir']),
};
/** cadence ou raf : nom, chemin, `.js|.cjs|.mjs` (bin/cadence.js, bin/raf.js) et version de npx (`cadence@latest`, `@sylad/cadence@2.0.12`). */
const PROGRAMME = /^(?:\S*\/)?(cadence|raf)(?:\.[cm]?js)?(?:@[^\s/]+)?$/;
const PAQUETS_CADENCE = new Set(['@sylad/cadence', '@sylad/cadence-v2']);

/** Revue r2 (m1) : `node …/dist/cli.js` est le CLI de raf (`bin/raf.js` l'importe ; `v2/dist/cli.js`, celui de cadence v2) quand le paquet qui porte ce `dist`
 * est cadence : son package.json (lu depuis `cwd`), ou un chemin qui nomme cadence (`node_modules/@sylad/cadence/dist/cli.js`, paquet absent compris). */
function cliDeCadence(mot, cwd) {
  if (!/(?:^|\/)dist\/cli\.[cm]?js$/.test(mot)) return false;
  if (/(?:^|\/)(?:@sylad\/)?cadence(?:-v2)?\/(?:v2\/)?dist\//.test(mot)) return true;
  try {
    return PAQUETS_CADENCE.has(JSON.parse(readFileSync(join(dirname(dirname(resolve(cwd ?? process.cwd(), mot))), 'package.json'), 'utf8')).name);
  } catch {
    return false;
  }
}
const programmeDe = (mot, cwd) => PROGRAMME.exec(mot)?.[1] ?? (cliDeCadence(mot, cwd) ? 'raf' : undefined);

/** L'indice qui suit la ligne de fin du heredoc `fin` dont le corps commence en `i` (`tabs` : `<<-`, tabulations de tête ôtées) ; jamais fermé : la fin. */
function apresHeredoc(commande, i, { fin, tabs }) {
  while (i < commande.length) {
    const j = commande.indexOf('\n', i), bout = j < 0 ? commande.length : j;
    const ligne = commande.slice(i, bout);
    i = j < 0 ? bout : j + 1;
    if ((tabs ? ligne.replace(/^\t+/, '') : ligne) === fin) return i;
  }
  return i;
}

/** Les segments d'une commande ; le corps d'un heredoc (`<<MOT` … `MOT`, `<<-` : tabulations de tête ôtées) est du texte, pas une commande (revue r2, m2). */
function segmentsDe(commande) {
  const segments = [''], attendus = [];
  MORCEAU.lastIndex = 0;
  for (let m; MORCEAU.lastIndex < commande.length && (m = MORCEAU.exec(commande));) {
    const heredoc = m[0].startsWith('<<') && m[0] !== '<<<';
    if (heredoc) attendus.push({ fin: m[2] ?? m[3] ?? m[4], tabs: m[1] === '-' });
    if (heredoc || !SEPARE.test(m[0])) { segments[segments.length - 1] += heredoc ? ' ' : m[0]; continue; }
    segments.push('');
    if (m[0] === '\n') MORCEAU.lastIndex = attendus.splice(0).reduce((i, h) => apresHeredoc(commande, i, h), MORCEAU.lastIndex);
  }
  return segments;
}

/** Une redirection en tête de mot : descripteur facultatif (`2`, `{fd}`) puis `&>`, `&>>`, `>&`, `<&`, `>|`, `>>`, `<>`, `>` ou `<`. */
const REDIRECTION = /^(?:\d+|\{\w+\})?(?:&>>?|[<>]&|>\||>>|<>|[<>])/;
/** Revue r1 de L840 (M1) : les mots d'une commande sans ses redirections (`2>&1`, `>&2`, `&>/dev/null`, `2>&-`, `> f`, `&> f` : un opérateur seul a sa cible
 * dans le mot suivant) ; ni une redirection ni sa cible ne sont des arguments du programme. */
function sansRedirections(mots) {
  const reste = [];
  for (let i = 0; i < mots.length; i++) {
    const r = REDIRECTION.exec(mots[i]);
    if (!r) reste.push(mots[i]);
    else if (r[0] === mots[i]) i++;
  }
  return reste;
}
/** L840 : les arguments de `cadence analyse` permis : --help, -h, --init, --contre <ref>, --outil <nom> (chacun une fois), rien d'autre ; `args` est déjà
 * sans redirections (sansRedirections). */
function analysePermise(args) {
  const vus = new Set();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (vus.has(a)) return false;
    vus.add(a);
    if (OPTIONS_ANALYSE.has(a)) continue;
    if (!OPTIONS_ANALYSE_VALEUR.has(a) || !args[i + 1] || args[i + 1].startsWith('-')) return false;
    i++;
  }
  return true;
}
/** `cadence analyse` bornée (L840), ou `cadence spec check|qa` quand le brief nomme les fiches ; `args` : les mots après le programme. */
function permise(programme, args, specCheck) {
  if (programme !== 'cadence') return false;
  if (args[0] === 'analyse') return analysePermise(args.slice(1));
  return specCheck && args[0] === 'spec' && (args[1] === 'check' || args[1] === 'qa');
}

/** Le premier segment de `commande` qui lance cadence ou raf autrement que `cadence analyse` bornée (L840) ou, avec `specCheck`, `cadence spec check|qa`, ou
 * null. `cwd` : le dossier de la session (chemins relatifs de `node …/dist/cli.js`). Lecture du texte : variables, `eval`, `xargs`, `sh -c '…'` /
 * `bash -c '…'` ne sont pas ouverts. */
export function cadenceHorsPermises(commande, cwd, { specCheck = false } = {}) {
  for (const segment of segmentsDe(String(commande))) {
    const mots = sansRedirections(segment.trim().replace(/(?:npm|pnpm|yarn)\s+(?:exec|dlx)\b/g, 'npx').split(/\s+/).filter(Boolean))
      .map((w) => w.replace(/^["']|["']$/g, ''));
    let avant = '';
    while (mots.length && PREFIXE.test(mots[0]) && !programmeDe(mots[0], cwd)) {
      const mot = mots.shift();
      if (!mot.startsWith('-')) avant = mot.replace(/^\S*\//, '');
      else if (AVEC_VALEUR[avant]?.has(mot)) mots.shift();
    }
    const programme = programmeDe(mots[0] ?? '', cwd);
    if (programme && !permise(programme, mots.slice(1), specCheck)) return segment.trim();
  }
  return null;
}
/** L792 : la session dont le brief nomme `cadence spec check`. */
export const cadenceHorsSpecCheck = (commande, cwd) => cadenceHorsPermises(commande, cwd, { specCheck: true });
