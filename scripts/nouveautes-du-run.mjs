// L794 : un lot visible rendu par cadence run sans entrée Nouveautés (finance L182 et warhammer L67 le 20-11, 2e occurrence). Le brief disait d'ignorer
// les « Nouveautés imposées par l'outil » : certaines sessions l'ont lu « pas d'entrée ». Pour un lot visible du plan (`visible: true`, ou un `screen:`),
// le brief demande donc l'entrée écrite à la main (sans commande cadence), et la fin du run dit « Nouveautés manquante » quand aucune entrée du commit du
// run ne cite le lot, sans bloquer l'intégration. Générique : le plan est lu comme src/config.ts le décrit (`plan`, `plan.lots`, `plan.fields`), le
// dossier des entrées est celui de `cadence news` (docs/nouveautes, src/cli/context.ts). JavaScript, comme scripts/commandes-du-brief.mjs : v2 l'importe.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/** Le dossier des entrées Nouveautés, relatif au dépôt (défaut de `cadence news`, src/cli/context.ts). */
export const DOSSIER_NOUVEAUTES = 'docs/nouveautes';
const liste = (v) => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

/** Où est le plan et comment le lire : `plan` de cadence.yaml (chaîne ou `plan.path`, sinon .cadence/raf.yaml), `plan.lots` et `plan.fields.<champ>`. */
function formatDuPlan(repo) {
  const cfg = existsSync(join(repo, 'cadence.yaml')) ? parse(readFileSync(join(repo, 'cadence.yaml'), 'utf8')) ?? {} : {};
  const p = typeof cfg.plan === 'object' && cfg.plan !== null ? cfg.plan : {};
  const nomme = typeof cfg.plan === 'string' ? cfg.plan : typeof p.path === 'string' ? p.path : undefined;
  return { fichier: join(repo, nomme ?? '.cadence/raf.yaml'), lots: typeof p.lots === 'string' ? p.lots : 'lots', cles: (champ) => [champ, ...liste(p.fields?.[champ])] };
}

/**
 * Le lot `lot` du plan du dépôt (sous-tâche comprise), ou undefined. Un plan au format mappé (`plan.lots`, `plan.fields.<champ>` : les clés du projet)
 * est lu avec ses clés. Absent ou illisible : undefined.
 */
export function lotDuPlan(repo, lot) {
  if (!lot) return undefined;
  try {
    const f = formatDuPlan(repo);
    const champ = (l, nom) => f.cles(nom).map((k) => l?.[k]).find((v) => v !== undefined);
    const lots = (existsSync(f.fichier) ? parse(readFileSync(f.fichier, 'utf8'))?.[f.lots] : undefined) ?? [];
    const tous = (Array.isArray(lots) ? lots : []).flatMap((l) => [l, ...(Array.isArray(l?.tasks) ? l.tasks : [])]);
    const trouve = tous.find((l) => String(champ(l, 'id')) === lot);
    return trouve ? { ...trouve, id: lot, visible: champ(trouve, 'visible'), screen: champ(trouve, 'screen'), spec: champ(trouve, 'spec') } : undefined;
  } catch {
    return undefined;
  }
}

/** Le lot du plan est visible : `visible: true` (ou « oui », « yes ») ou un écran (`screen:` non vide). */
export function lotVisible(repo, lot) {
  const l = lotDuPlan(repo, lot);
  if (!l) return false;
  const v = typeof l.visible === 'string' ? ['true', 'oui', 'yes'].includes(l.visible.trim().toLowerCase()) : l.visible === true;
  return v || (typeof l.screen === 'string' ? l.screen.trim() !== '' : !!l.screen);
}

const jour = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function heure(d) {
  const o = -d.getTimezoneOffset(), s = o < 0 ? '-' : '+', a = Math.abs(o);
  return `${jour(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/**
 * Le paragraphe du brief pour le lot visible `lot` : l'entrée Nouveautés écrite à la main, au format des entrées voisines, capture comprise, sans
 * commande cadence. `regenere` : le projet déclare run.regenerate (cadence run reconstruit les fichiers générés après la session).
 */
export function consigneNouveautes(lot, { maintenant = new Date(), regenere = false, dossier = DOSSIER_NOUVEAUTES } = {}) {
  const lignes = [
    `Entrée Nouveautés (obligatoire) : le lot ${lot} est visible dans le plan, son entrée Nouveautés fait partie du travail. Écris-la toi-même, à la main, `
    + `sans commande \`cadence\` : l'interdiction de \`cadence\` plus bas porte sur l'outil, pas sur l'entrée.`,
    `- Un fichier \`${dossier}/${jour(maintenant)}-<titre-en-minuscules-avec-tirets>.md\`, au format des entrées voisines de \`${dossier}/\` (lis-en une ou deux) : `
    + `en-tête YAML entre deux lignes \`---\` avec \`title\` (ce qui change, dit côté utilisateur, jamais le titre interne du lot), \`date: ${jour(maintenant)}\`, `
    + `\`created: ${heure(maintenant)}\` (heure avec fuseau), \`lots: [${lot}]\` et \`captures\` ; puis le texte : ce que l'utilisateur voit ou peut faire `
    + 'désormais, factuel, sans détail d\'implémentation ni promesse.',
    `- Une capture du résultat, rangée comme celles des entrées voisines (chemin relatif à \`${dossier}/\`, par exemple \`captures/<nom>.png\`) et citée dans `
    + '`captures:` ; c\'est la seule capture qui va dans le dépôt. Sans capture qui ait un sens : `nocapture: <raison>` à la place.',
    `- Commite l'entrée et sa capture avec le travail du lot.${regenere ? ' Les fichiers que le projet génère à partir des entrées sont reconstruits par '
      + 'cadence run après toi (run.regenerate de cadence.yaml) : ne les régénère pas toi-même.' : ''}`,
  ];
  return `${lignes.join('\n')}\n\n`;
}

const git = (cwd, ...a) => spawnSync('git', ['-c', 'core.quotePath=false', ...a], { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Les entrées Nouveautés du commit `ref` (HEAD par défaut) qui citent `lot` dans `lots:` : chemins relatifs au dépôt. Lu dans git, pas sur le disque :
 * une entrée non commitée n'est pas intégrée. null : git illisible (jamais lu comme « aucune entrée »).
 */
export function entreesQuiCitent(repo, lot, { ref = 'HEAD', dossier = DOSSIER_NOUVEAUTES } = {}) {
  const ls = git(repo, 'ls-tree', '-r', '-z', '--name-only', ref, '--', `${dossier}/`);
  if (ls.status !== 0) return null;
  const md = ls.stdout.split('\0').filter((f) => f.endsWith('.md') && !/(^|\/)readme\.md$/i.test(f));
  return md.filter((f) => {
    const t = git(repo, 'show', `${ref}:${f}`);
    const m = t.status === 0 ? FRONT.exec(t.stdout.replace(/^﻿/, '')) : null;
    if (!m) return false;
    try { return liste(parse(m[1])?.lots).includes(lot); } catch { return false; }
  });
}

/** La ligne de fin de run pour un lot visible : « Nouveautés manquante » sans entrée qui le cite, sinon les entrées trouvées. */
export function ligneNouveautes(lot, entrees, dossier = DOSSIER_NOUVEAUTES) {
  if (entrees === null) return `Nouveautés : le lot ${lot} est visible, ses entrées n'ont pas pu être lues (git) : à vérifier dans ${dossier}/`;
  return entrees.length ? `Nouveautés : ${entrees.join(', ')} (lot visible ${lot})`
    : `Nouveautés manquante : le lot ${lot} est visible et aucune entrée de ${dossier}/ ne le cite au commit du run — à écrire avant la livraison`;
}
