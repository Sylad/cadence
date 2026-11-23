// L792 (issue #68) : le brief de cadence run (v2/src/run/run.ts) nomme les commandes de vérification du projet quand le travail touche des fiches d'écran.
// Le 19-11, une session chargée d'amener des fiches à « fiche valide » n'a jamais lancé `cadence spec check` (le brief n'en disait rien et interdisait
// `cadence`), a reconstruit les règles depuis git et s'est crue à 0 écart : 97 restaient. Cause : découverte. Le brief nomme donc la commande, et la session
// peut la lancer (interdiction de `cadence` levée pour `cadence spec check|qa` seules). Générique : tout est lu dans la clé `orchestrate` de cadence.yaml
// (spec.dir, build, test, accept), rien n'est propre à un projet. Le run ne juge rien contre une fiche : il dit à la session quelle commande le fait.
// Revue r1 (M1) : les motifs de --disallowedTools ne savent pas dire « cadence spec sauf check|qa » (un deny `cadence spec:*` l'emporterait sur tout) ;
// le hook PreToolUse v2/hooks/seul-spec-check.mjs (posé par avecRefusCadence) refuse donc tout appel de cadence ou de raf autre que `cadence spec check|qa`.
// JavaScript, comme scripts/etapes-porte.mjs : v2 l'importe hors de son rootDir.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { lireEtapes } from './etapes-porte.mjs';
import { lotDuPlan } from './nouveautes-du-run.mjs';

/** Les outils de bin/cadence.js qu'une session de run ne lance jamais ; `spec` n'y est pas : ses verbes autres que check|qa sont refusés par le hook. */
export const OUTILS_CADENCE = ['run', 'sondes', 'analyse', 'ecriture', 'raf', 'news', 'session', 'deliver', 'verify', 'eval', 'skills', 'orchestrate', 'lead', 'corrections', 'perf',
  'cost', 'inspect', 'ref', 'config', 'release', 'local', 'claude-hook'];
const SPEC_DU_LEAD = ['green', 'reseal'];

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
 * `orchestrate` : la clé de cadence.yaml du worktree du run, déjà lue ; `lot` : le lot du plan du run, s'il en a un.
 */
export function commandesNommees(repo, orchestrate, demande, lot) {
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

/** La ligne « N'utilise ni raf ni cadence » des briefs, avec l'exception de `cadence spec check`. */
export const leverPourSpec = (brief) =>
  brief.replaceAll("N'utilise ni `raf` ni `cadence`", "N'utilise ni `raf` ni `cadence` (seule exception : `cadence spec check`, nommée dans les vérifications plus haut)");

/** Les interdits de la session : `Bash(cadence:*)` remplacé par chaque outil de cadence sauf `spec` (ses verbes du lead restent interdits) ; le reste de
 * `cadence spec` (`<lot> on|off`, qui écrit le plan) est refusé par le hook seul-spec-check.mjs (avecRefusCadence). */
export const interditsPourSpec = (interdits) => interdits.flatMap((x) => (x === 'Bash(cadence:*)'
  ? [...OUTILS_CADENCE.map((t) => `Bash(cadence ${t}:*)`), ...SPEC_DU_LEAD.map((v) => `Bash(cadence spec ${v}:*)`)] : [x]));

/** Les réglages de la session avec le hook PreToolUse qui refuse tout cadence ou raf hors `cadence spec check|qa` (`hooks` : le dossier v2/hooks). */
export const avecRefusCadence = (reglages, hooks) => ({ ...reglages, hooks: { ...reglages.hooks, PreToolUse: [...(reglages.hooks?.PreToolUse ?? []),
  { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${join(hooks, 'seul-spec-check.mjs')}"`, timeout: 10 }] }] } });

/** Les morceaux d'une commande shell : texte entre guillemets, caractère échappé, heredoc (`<<[-]MOT`, dont le corps est sauté), séparateur (&& || ; | &
 * retour à la ligne, `$(`, `(`, `)`, `` ` ``), texte. */
const MORCEAU = /"(?:\\[\s\S]|[^"\\])*"?|'[^']*'?|\\[\s\S]|<<<|<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;|&<>()`'"]+))|&&|\|\||\|&|\$\(|[;|&\n()`]|[^"'\\;|&\n()`$<]+|[$<]/gy;
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

/** Le premier segment de `commande` qui lance cadence ou raf autrement que `cadence spec check|qa`, ou null. `cwd` : le dossier de la session (chemins
 * relatifs de `node …/dist/cli.js`). Lecture du texte : variables, `eval`, `xargs`, `sh -c '…'` / `bash -c '…'` ne sont pas ouverts. */
export function cadenceHorsSpecCheck(commande, cwd) {
  for (const segment of segmentsDe(String(commande))) {
    const mots = segment.trim().replace(/(?:npm|pnpm|yarn)\s+(?:exec|dlx)\b/g, 'npx').split(/\s+/).map((w) => w.replace(/^["']|["']$/g, ''));
    let avant = '';
    while (mots.length && PREFIXE.test(mots[0]) && !programmeDe(mots[0], cwd)) {
      const mot = mots.shift();
      if (!mot.startsWith('-')) avant = mot.replace(/^\S*\//, '');
      else if (AVEC_VALEUR[avant]?.has(mot)) mots.shift();
    }
    const programme = programmeDe(mots[0] ?? '', cwd);
    const specCheck = programme === 'cadence' && mots[1] === 'spec' && (mots[2] === 'check' || mots[2] === 'qa');
    if (programme && !specCheck) return segment.trim();
  }
  return null;
}
