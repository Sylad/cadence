// Lecture du dossier pour `cadence inspect` (L627) : la dernière vague (ou celle nommée) et les lots des plans du dossier.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { inspectWave, parseRetakes, renderInspection, tourSummary, type Inspection, type PlanLot, type Retake } from './inspect.js';
import { planLoader } from './config.js';
import { findProjects, isProject } from './lead.js';
import { RafError } from './plan.js';

/** Les projets du dossier (nom tel que le journal le cite, dossier). Lancé depuis un projet (`cadence orchestrate L18` de l'intérieur) : aucun sous-dossier n'est un projet, le dossier l'est lui-même, comme pour `lead tour`. */
function projectsOf(parent: string): Array<{ name: string; dir: string }> {
  const dirs = findProjects(parent, 2);
  return (dirs.length === 0 && isProject(parent) ? [parent] : dirs).map((dir) => ({ dir, name: dir === parent ? basename(parent) : relative(parent, dir).split(sep).join('/') }));
}

/** Les lots des plans du dossier ; un plan illisible n'ôte rien au reste (la proposition le saura moins bien). */
function planLotsOf(projects: Array<{ name: string; dir: string }>): PlanLot[] {
  const out: PlanLot[] = [];
  for (const { name, dir } of projects) {
    try {
      for (const l of planLoader(dir)().lots()) out.push({ project: name, id: l.id, title: l.title, status: l.status });
    } catch {
      // plan illisible : ses lots ne comptent pas parmi ceux qui traitent une cause
    }
  }
  return out;
}

/** Les reprises à la main du lead, lues dans le git de chaque projet (commits « correctif du lead », « rebase du lead ») ; un dossier sans git, ou un git qui refuse, n'en donne aucune. */
function retakesOf(projects: Array<{ name: string; dir: string }>): Retake[] {
  return projects.flatMap(({ name, dir }) => {
    try {
      return parseRetakes(execFileSync('git', ['log', '--format=%aI %s', '--grep=correctif du lead', '--grep=rebase du lead'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }), name);
    } catch {
      return [];
    }
  });
}

/** La dernière vague datée (AAAA-MM-JJ-HHMM[-suffixe], l'ordre des noms est celui des dates) qui a un journal ; un dossier à nom libre n'est jamais « la dernière ». */
function lastWave(runsDir: string): string | null {
  if (!existsSync(runsDir)) return null;
  const waves = readdirSync(runsDir).filter((w) => /^\d{4}-\d{2}-\d{2}-\d{4}/.test(w) && existsSync(join(runsDir, w, 'journal.log'))).sort();
  return waves[waves.length - 1] ?? null;
}

export function inspectFolder(parent: string, wave?: string): Inspection {
  const runsDir = join(parent, '.cadence', 'runs');
  if (!existsSync(runsDir)) throw new RafError(`inspect : aucun journal de vague dans ${runsDir}`);
  const name = wave ?? lastWave(runsDir);
  if (name === null) throw new RafError(`inspect : aucune vague avec un journal dans ${runsDir}`);
  if (!existsSync(join(runsDir, name, 'journal.log'))) throw new RafError(`inspect : la vague ${name} n'a pas de journal dans ${runsDir}`);
  const projects = projectsOf(parent);
  return inspectWave(runsDir, name, planLotsOf(projects), retakesOf(projects));
}

/**
 * Le tableau de fin de vague (L627) : `waveDir` est `<dossier>/.cadence/runs/<vague>`. Une lecture qui échoue ne change ni la sortie ni le code de la vague : la raison part dans `warn`.
 */
export function endOfWaveLines(waveDir: string, warn: (line: string) => void): string[] {
  try {
    const parent = dirname(dirname(dirname(waveDir)));
    return renderInspection(inspectFolder(parent, basename(waveDir)));
  } catch (e) {
    warn(`orchestrate : inspect : ${(e instanceof Error ? e.message : String(e)).replace(/^inspect : /, '')}`);
    return [];
  }
}

/** La ligne du tour du lead (L627) : la première récidive de la dernière vague ; vide sans récidive, sans journal de vague ou sur une lecture qui échoue (le tour ne change pas). */
export function tourInspectLines(parent: string): string[] {
  try {
    const line = tourSummary(inspectFolder(parent));
    return line ? [line] : [];
  } catch {
    return [];
  }
}
