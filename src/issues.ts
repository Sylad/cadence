import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planLoader } from './config.js';
import { gitRoot } from './git.js';
import { TITLE_MAX, truncate } from './lead.js';
import type { Lot } from './plan.js';

/** Au-delà de ce délai, `gh` est tenu pour injoignable : le tour ne l'attend pas. */
const GH_TIMEOUT = 15_000;
/** Issues ouvertes lues d'un coup ; au-delà, les plus anciennes ne sont pas vues. */
const ISSUES_LIMIT = 200;

interface OpenIssue {
  number: number;
  title: string;
}

/**
 * Les numéros que le texte cite par « issue #n » (casse libre, espaces ou saut de ligne entre les deux, numéro terminé), chacun une fois, dans l'ordre : « issues #20 et #21 » et « issues #20, #21 »
 * donnent les deux. Un « #20 » sans le mot, « issue 20 » ou « reissue #3 » ne citent rien.
 */
export function issueNumbers(text: string): number[] {
  const found: number[] = [];
  for (const m of text.matchAll(/\bissues?\s+#(\d+)(?!\w)((?:(?:,\s*|\s+(?:et|and)\s+|\s*&\s*)#\d+(?!\w))*)/gi)) {
    for (const n of [m[1]!, ...(m[2]!.match(/\d+/g) ?? [])]) if (!found.includes(Number(n))) found.push(Number(n));
  }
  return found;
}

/** Les numéros d'issue que le plan fait citer à un lot, dans son titre et ses notes. */
const lotIssues = (lot: Lot): number[] => issueNumbers([lot.title, ...lot.notes.map((n) => n.text)].join('\n'));

/** Les issues ouvertes du dépôt, par `gh issue list` lancé dans `cwd` ; null quand `gh` manque, échoue, tarde ou ne rend pas la liste attendue (le tour s'en passe). */
function openIssues(cwd: string, env: NodeJS.ProcessEnv): OpenIssue[] | null {
  let raw: string;
  try {
    raw = execFileSync('gh', ['issue', 'list', '--state', 'open', '--limit', String(ISSUES_LIMIT), '--json', 'number,title'], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GH_TIMEOUT });
  } catch {
    return null;
  }
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return null;
    const seen = new Set<number>();
    return list
      .filter((i): i is OpenIssue => typeof i?.number === 'number' && typeof i?.title === 'string')
      .filter((i) => !seen.has(i.number) && seen.add(i.number))
      .map((i) => ({ number: i.number, title: i.title.replace(/\s+/g, ' ').trim() }));
  } catch {
    return null;
  }
}

/** Les projets frères dont le CHANGELOG rappelle les lots (« finance L130 of the wave … ») : leur numéro n'est pas celui du plan courant. */
const OTHER_PROJECTS = 'finance|warhammer|ol|maritime|aetherwx|jobmail|evatosorus|eywa';

const hasLot = (text: string, id: string) => new RegExp(`(?<![\\w/])(?<!\\b(?:${OTHER_PROJECTS})\\s+)${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/])`).test(text);

/** Les lots que le CHANGELOG cite dans une version publiée (toute section « ## [x] » autre que [Unreleased]). */
function publishedLots(root: string, lots: Lot[]): Set<string> {
  const file = join(root, 'CHANGELOG.md');
  if (!existsSync(file)) return new Set();
  const sections = readFileSync(file, 'utf8').split(/^## /m).slice(1).filter((s) => !/^\[Unreleased\]/i.test(s));
  const text = sections.join('\n');
  return new Set(lots.filter((l) => hasLot(text, l.id)).map((l) => l.id));
}

/**
 * Les lignes d'issues du tour pour un projet (L548) : chaque issue ouverte qu'aucun lot du plan ne cite, puis chacune dont tous les lots qui la citent (hors lots abandonnés) sont clos et
 * cités dans une version publiée du CHANGELOG (la fermer revient au lead). Vide sans `gh`, sans plan lisible ou sans issue concernée.
 */
export function issueLines(dir: string, project: string, env: NodeJS.ProcessEnv): string[] {
  let lots: Lot[];
  const root = gitRoot(dir) ?? dir;
  try {
    lots = planLoader(root)().lots();
  } catch {
    return [];
  }
  const open = openIssues(root, env);
  if (!open?.length) return [];
  const published = publishedLots(root, lots);
  const citing = new Map<number, Lot[]>();
  for (const l of lots) if (l.status !== 'dropped') for (const n of lotIssues(l)) citing.set(n, [...(citing.get(n) ?? []), l]);
  const lines: string[] = [];
  for (const i of open) {
    const by = citing.get(i.number) ?? [];
    const head = `${project} · issue #${i.number} « ${truncate(i.title, TITLE_MAX)} » · ouverte`;
    if (by.length === 0) lines.push(`${head}, aucun lot du plan ne la cite`);
    else if (by.every((l) => l.status === 'done' && published.has(l.id))) lines.push(`${head}, mais ${by.map((l) => l.id).join(', ')} ${by.length > 1 ? 'sont publiés' : 'est publié'} — la fermer : gh issue close ${i.number}`);
  }
  return lines;
}

/** Les commandes `gh issue close` d'une version (L548) : une par issue citée par un lot que `changelog` (la section qui sort) cite, avec en commentaire les lots et la version. Rien sans plan lisible. */
function releaseIssueCommands(root: string, changelog: string, version: string): string[] {
  let lots: Lot[];
  try {
    lots = planLoader(root)().lots();
  } catch {
    return [];
  }
  const byIssue = new Map<number, string[]>();
  for (const l of lots) {
    if (!hasLot(changelog, l.id)) continue;
    for (const n of lotIssues(l)) byIssue.set(n, [...(byIssue.get(n) ?? []), l.id]);
  }
  return [...byIssue].sort(([a], [b]) => a - b).map(([n, ids]) => `gh issue close ${n} --comment "Réglée par ${ids.join(', ')}, publiée en ${version}"`);
}

/** Les lignes que `cadence release` imprime après ses étapes (L548) : le titre puis une commande par issue ; rien quand aucun lot de la version n'en cite. */
export function releaseIssueLines(root: string, changelog: string, version: string): string[] {
  const closes = releaseIssueCommands(root, changelog, version);
  return closes.length === 0 ? [] : ['issues à fermer, une fois la publication vérifiée (le lead décide ; la commande n\'en ferme aucune) :', ...closes.map((c) => `  ${c}`)];
}
