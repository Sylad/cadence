import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RafError, type Lot } from '../plan.js';
import type { StepKind } from './launch.js';

/** Gabarits livrés avec le paquet (à la racine, à côté de dist/ et src/). */
export const TEMPLATES_DIR = fileURLToPath(new URL('../../templates/orchestrate', import.meta.url));

export interface BriefVars {
  chemin: string;
  lot: string;
  titre: string;
  objectif: string;
  commits: string;
  reponse: string;
  constats: string;
  ux: string;
  /** Choix d'interprétation faits par l'auteur, à relire par la revue (vide : aucune ligne). */
  choix: string;
  /** Résultat des tests et du build lancés par le programme au HEAD relu (vide : le relecteur les lance lui-même). */
  checks: string;
  /** Consigne de l'entrée Nouveautés : `newsText(lot)` pour un lot `visible` (avec le dossier Playwright de la vague quand une session orchestrée l'a), vide sinon. */
  news: string;
  /** Dossier de sortie Playwright de la vague (fix et fix-minors d'un lot `visible`, pour retrouver une capture) ; vide sinon. */
  captures: string;
  /** Dépôts voisins du lot (clé de lot `repos:`, L62) : `reposText(kind, …)` ; absent ou vide pour un lot du dépôt du projet seul. */
  repos?: string;
  /** Consigne docs.sync (L143) de la revue : les écarts calculés par le programme, à passer en constat majeur ; vide sans règle déclarée. */
  docs?: string;
  /** Consigne de l'étape spec (L171) : dossier, largeurs, commande de rendu, écarts de la passe précédente ; vide ailleurs. */
  spec?: string;
  /** Consigne de l'étape accept (L173) : fiche, maquette, commande dédiée, gabarit du lanceur, écarts de la passe précédente ; vide ailleurs. */
  accept?: string;
  /** Consigne de la fiche d'écran (L174) pour implement, fix, revue de code et UX de conformité d'un lot qui a une fiche ; vide ailleurs. */
  fiche?: string;
  /** Dossier temporaire de la session (L242) : `tmpText(dir)` ; vide sans vague (`--dry-run`, brief délégué à la main). */
  tmp?: string;
  /** Consigne de nommage des captures Playwright (L249) : `shotsText(dossier de la vague)` pour une étape qui charge le serveur ; vide ailleurs et sans vague (`--dry-run`). */
  shots?: string;
  /** Consigne de la revue de maquette (L172) : fiche, maquette, captures, passe en cours ; vide ailleurs. */
  maquette?: string;
}

/** Consigne sur les dépôts voisins d'un lot (L62) : les sessions d'écriture y travaillent, les relectures y lisent les commits qui citent le lot. */
export function reposText(role: 'write' | 'read', lot: string, repos: { rel: string; path: string; cite?: string }[]): string {
  if (!repos.length) return '';
  const list = repos.map((r) => `- \`${r.rel}\` (${r.path})`);
  const cited = repos.filter((r) => r.cite);
  if (role === 'write') {
    return [
      "The work of this lot is not only in the project's repository: it also lives in these neighbouring repositories, which are not cadence projects and are added to your directories:",
      ...list,
      `Work there as you do in the project's repository: test first, explicit paths, and every commit there cites the lot too (\`feat(${lot}): …\`) — the program and the review find the lot's work by those commits.${cited.map((r) => ` In \`${r.rel}\` every commit also contains \`${r.cite}\` (subject or body): the repository is shared with other projects, and a commit without it is not counted.`).join('')} Never push from any of them. Where the lot touches one, run that repository's own checks; leave it with no tracked file modified.`,
    ].join('\n');
  }
  return [
    'The work of this lot is also in these neighbouring repositories (not cadence projects); the commits that cite the lot live there as well as in the project:',
    ...list,
    ...cited.map((r) => `In \`${r.rel}\` only the commits that also contain \`${r.cite}\` count: the repository is shared with other projects.`),
    `\`raf commits ${lot}\` lists them all; read the diff of the neighbouring ones with \`git -C <path> log\` / \`git -C <path> show\` (${repos.map((r) => `git -C ${r.path} log`).join(' ; ')}), and review them like the rest. You are read-only there too.`,
  ].join('\n');
}

/** Consigne du dossier temporaire (L242) : les sessions y rangent journaux de tests, dumps et exports, jamais dans le dépôt (4 « dépôt sale » le 18-10). */
export function tmpText(dir: string): string {
  return `Temporary files: this session's \`TMPDIR\` is \`${dir}\` (short and outside the repository, never tracked by git, already created and exported; removed when the pass ends). Write test logs, dumps, exports and any scratch file there (\`> $TMPDIR/suite.txt\`), never inside the repository: not in its \`tmp/\`, not at its root. Leave the working tree with only the files of the lot.`;
}

/** Consigne d'implémentation d'un lot `visible` : son entrée Nouveautés (convention de `cadence news`, voir docs/news.md du paquet @sylad/cadence). */
export function newsText(lot: string, captureDir?: string): string {
  return [
    `This lot is visible: write its News entry. Run \`cadence news new ${lot}\` (it creates \`docs/nouveautes/<date>-<slug>.md\`), then write the text in terms of what changes for the user, factual (what the user sees or can now do, no implementation detail, no promise).`,
    `The entry's title is user-side: \`cadence news new\` takes the lot's public title when it has one; otherwise rewrite the title in the user's words with \`--title\` (never the internal title of the lot).`,
    captureDir
      ? `Add a screenshot of the result: copy it into \`docs/nouveautes/captures/\` and list it under \`captures:\` (a capture taken with the absolute path given above lands in the wave's output directory, outside the repository: \`${captureDir}\`, which this session may read; the file you keep for the entry is the one exception, copied into \`docs/nouveautes/captures/\`); if a screenshot makes no sense (or the app cannot be run), write \`nocapture: <reason>\` instead.`
      : `Add a screenshot of the result: save it under the OS temp directory (never inside the repository), then copy it into \`docs/nouveautes/captures/\` and list it under \`captures:\` (the file you keep for the entry is the one exception to "nothing inside the repository"); if a screenshot makes no sense (or the app cannot be run), write \`nocapture: <reason>\` instead.`,
    'Commit the entry with the lot (`cadence news check` must pass).',
  ].join('\n');
}

/** Consigne des briefs de correction d'un lot `visible` : où la vague range les captures Playwright (même dossier que l'étape implement). */
export function capturesText(captureDir: string): string {
  return `A Playwright capture taken with the absolute path given above lands in \`${captureDir}\` (outside the repository; this session may read it): a screenshot a finding asks for is copied from there into \`docs/nouveautes/captures/\`.`;
}

/**
 * Consigne de nommage des captures Playwright (L249). Mesuré sur @playwright/mcp 0.0.83 : `--output-dir` ne sert qu'aux fichiers que le serveur nomme lui-même ;
 * un nom donné par la session est résolu sur la racine de travail du serveur (le dépôt), d'où cinq lots sur cinq le 23-10 avec des captures à la racine. La session donne donc le chemin absolu du dossier de la vague, que le serveur autorise.
 */
export function shotsText(captureDir: string): string {
  return `The Playwright server resolves a file name you give it against the repository, not against its output directory: a bare name such as page-home.png lands at the repository root. Give every screenshot, snapshot and trace the absolute path of the wave's capture directory, \`${captureDir}/\`, followed by the name (e.g. \`${captureDir}/page-home.png\`): the server allows it, and the repository stays clean. Never the \`--output-dir\` option (the server's launch argument, which a session cannot set).`;
}

/** Un gabarit : un par étape, plus deux variantes (passe des mineurs, revue courte qui la suit). */
export type BriefName = StepKind | 'fix-minors' | 'review-recheck' | 'spec-back' | 'accept-back';

const FILES: Record<BriefName, string> = {
  precheck: 'precheck.md',
  spec: 'spec.md',
  'spec-back': 'spec-back.md',
  'accept-back': 'accept-back.md',
  fiche: 'fiche.md',
  accept: 'accept.md',
  maquette: 'maquette.md',
  implement: 'implement.md',
  fix: 'fix.md',
  'fix-minors': 'fix-minors.md',
  review: 'review.md',
  ux: 'ux.md',
  'review-small': 'review-small.md',
  'review-recheck': 'review-recheck.md',
};

/** Texte des gabarits, lu une fois : une vague rend tous ses briefs depuis le même instantané. */
export type Templates = Record<BriefName, string>;

/** Lit tous les gabarits du dossier. Un gabarit absent est une erreur, avant que quoi que ce soit ne parte. */
export function loadTemplates(dir = TEMPLATES_DIR): Templates {
  const out = {} as Templates;
  for (const [name, file] of Object.entries(FILES) as [BriefName, string][]) {
    try {
      out[name] = readFileSync(join(dir, file), 'utf8');
    } catch (e) {
      throw new RafError(`gabarit ${file} illisible dans ${dir} : ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * Rend le gabarit d'une étape par substitution de `{{nom}}`. Un nom sans valeur est une erreur.
 * `source` : un instantané (`loadTemplates`, ce que fait une vague) ou un dossier lu à l'appel.
 */
export function renderBrief(kind: BriefName, vars: BriefVars, source: Templates | string = TEMPLATES_DIR): string {
  const text = typeof source === 'string' ? loadTemplates(source)[kind] : source[kind];
  const out = text.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    const v = ({ ...vars, repos: vars.repos ?? '', docs: vars.docs ?? '', spec: vars.spec ?? '', accept: vars.accept ?? '', maquette: vars.maquette ?? '', tmp: vars.tmp ?? '', shots: vars.shots ?? '', fiche: vars.fiche ?? '' } as unknown as Record<string, string | undefined>)[name];
    if (v === undefined) throw new RafError(`gabarit ${FILES[kind]} : valeur manquante pour {{${name}}}`);
    return v;
  });
  // Un marqueur vide ne laisse pas de trou : lignes vides en double ramenées à une.
  return `${out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/**
 * L'objectif d'un lot (L258) : celui gardé dans l'état du lot (`LotState.goal`, fixé au lancement : `--goal`, sinon la clé `goal:` du plan),
 * sinon son titre. Une seule source pour les briefs, la simulation et le tableau : la clé `goal:` du plan n'est pas relue en cours de vague,
 * donc une reprise rejoue l'objectif du lancement.
 */
export const headline = (lot: Pick<Lot, 'title'>, goal?: string): string => goal ?? lot.title;

/** `{{objectif}}` : l'objectif du lot (`headline`, le titre faute d'autre), ses notes et ses sous-tâches — Sylvain n'écrit rien d'autre. */
export function objective(lot: Lot, goal?: string): string {
  const lines = [headline(lot, goal)];
  if (lot.notes.length) lines.push('', 'Notes of the lot (decisions included):', ...lot.notes.map((n) => `- ${n.date}: ${n.text}`));
  if (lot.tasks.length) lines.push('', 'Sub-tasks:', ...lot.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}`));
  return lines.join('\n');
}
