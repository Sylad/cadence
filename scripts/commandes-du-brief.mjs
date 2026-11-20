// L792 (issue #68) : le brief de cadence run (v2/src/run/run.ts) nomme les commandes de vérification du projet quand le travail touche des fiches d'écran.
// Le 19-11, une session chargée d'amener des fiches à « fiche valide » n'a jamais lancé `cadence spec check` (le brief n'en disait rien et interdisait
// `cadence`), a reconstruit les règles depuis git et s'est crue à 0 écart : 97 restaient. Cause : découverte. Le brief nomme donc la commande, et la session
// peut la lancer (interdiction de `cadence` levée pour `cadence spec check|qa` seules). Générique : tout est lu dans la clé `orchestrate` de cadence.yaml
// (spec.dir, build, test, accept), rien n'est propre à un projet. Le run ne juge rien contre une fiche : il dit à la session quelle commande le fait.
// Revue r1 (M1) : les motifs de --disallowedTools ne savent pas dire « cadence spec sauf check|qa » (un deny `cadence spec:*` l'emporterait sur tout) ;
// le hook PreToolUse v2/hooks/seul-spec-check.mjs (posé par avecRefusCadence) refuse donc tout appel de cadence ou de raf autre que `cadence spec check|qa`.
// JavaScript, comme scripts/etapes-porte.mjs : v2 l'importe hors de son rootDir.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse } from 'yaml';
import { lireEtapes } from './etapes-porte.mjs';

/** Les outils de bin/cadence.js qu'une session de run ne lance jamais ; `spec` n'y est pas : ses verbes autres que check|qa sont refusés par le hook. */
export const OUTILS_CADENCE = ['run', 'sondes', 'raf', 'news', 'session', 'deliver', 'verify', 'eval', 'skills', 'orchestrate', 'lead', 'corrections', 'perf',
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

/** Revue r1 (m1) : le lot du plan (`lot`, sous-tâche comprise) a la spec (`spec: true`) ou un écran (`screen: page`, qui l'implique). Plan : `plan` de
 * cadence.yaml, sinon .cadence/raf.yaml (PLAN_DEFAULT de src/config.ts) ; un plan absent ou illisible vaut non. */
export function lotAFiches(repo, lot) {
  if (!lot) return false;
  try {
    const cfg = existsSync(join(repo, 'cadence.yaml')) ? parse(readFileSync(join(repo, 'cadence.yaml'), 'utf8')) ?? {} : {};
    const nomme = typeof cfg.plan === 'string' ? cfg.plan : typeof cfg.plan?.path === 'string' ? cfg.plan.path : undefined;
    const fichier = join(repo, nomme ?? '.cadence/raf.yaml');
    const lots = (existsSync(fichier) ? parse(readFileSync(fichier, 'utf8'))?.lots : undefined) ?? [];
    const trouve = lots.flatMap((l) => [l, ...(Array.isArray(l?.tasks) ? l.tasks : [])]).find((l) => String(l?.id) === lot);
    return trouve?.spec === true || trouve?.screen === 'page';
  } catch {
    return false;
  }
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

/** Les morceaux d'une commande shell : texte entre guillemets, caractère échappé, séparateur (&& || ; | & retour à la ligne, `$(`, `(`, `)`, `` ` ``), texte. */
const MORCEAU = /"(?:\\[\s\S]|[^"\\])*"?|'[^']*'?|\\[\s\S]|&&|\|\||\|&|\$\(|[;|&\n()`]|[^"'\\;|&\n()`$]+|\$/g;
const SEPARE = /^(?:&&|\|\||\|&|\$\(|[;|&\n()`])$/;
/** Ce qui précède le programme sans le changer : affectation, `!`, `{`, mot-clé, env/command/exec/time/nohup/sudo, npx et npm|pnpm|yarn exec|dlx, node, et leurs options. */
const PREFIXE = /^(?:[A-Za-z_]\w*=\S*|[!{]|if|then|elif|else|do|while|until|time|command|exec|sudo|nohup|env|npx|node|(?:npm|pnpm|yarn)\s+(?:exec|dlx)|-\S*)$/;
const PROGRAMME = /^(?:\S*\/)?(cadence(?:\.[cm]?js)?|raf)$/;

/** Le premier segment de `commande` qui lance cadence ou raf autrement que `cadence spec check|qa`, ou null. Lecture du texte : `bash -c '…'` n'est pas ouvert. */
export function cadenceHorsSpecCheck(commande) {
  const segments = [''];
  for (const [m] of String(commande).matchAll(MORCEAU)) if (SEPARE.test(m)) segments.push(''); else segments[segments.length - 1] += m;
  for (const segment of segments) {
    const mots = segment.trim().replace(/(?:npm|pnpm|yarn)\s+(?:exec|dlx)\b/g, 'npx').split(/\s+/).map((w) => w.replace(/^["']|["']$/g, ''));
    while (mots.length && PREFIXE.test(mots[0]) && !PROGRAMME.test(mots[0])) mots.shift();
    const programme = PROGRAMME.exec(mots[0] ?? '')?.[1];
    const specCheck = programme?.startsWith('cadence') && mots[1] === 'spec' && (mots[2] === 'check' || mots[2] === 'qa');
    if (programme && !specCheck) return segment.trim();
  }
  return null;
}
