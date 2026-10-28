import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { gitRepo } from './helpers.js';

/**
 * Un dépôt avec un plan : L1 done 2025, L2 dropped 2026-03, L3 done 2026-09, L4 doing, L5 todo.
 * `parent` : le dépôt est `<parent>/depot`, pour poser un dépôt voisin à côté (clé de lot `repos:`).
 */
export function repoWithPlan(today = '2026-10-28', parent?: string) {
  const dir = gitRepo(parent);
  const lines: string[] = [];
  const errs: string[] = [];
  const io = () => ({ cwd: dir, env: { RAF_TODAY: today }, out: (l: string) => lines.push(l), err: (l: string) => errs.push(l), now: () => new Date(`${today}T10:00:00`) });
  const raf = async (...args: string[]) => {
    lines.length = 0;
    errs.length = 0;
    const code = await run(args, io());
    return { code, out: lines.join('\n'), err: errs.join('\n') };
  };
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'demo', 'L', '2025-01-01');
  for (const t of ['premier', 'deuxième', 'troisième', 'quatrième', 'cinquième']) plan.add(t, '2025-01-01');
  plan.setStatus('L1', 'done', '2025-06-10', { force: true });
  plan.setStatus('L2', 'dropped', '2026-03-05', { force: true });
  plan.setStatus('L3', 'done', '2026-09-20', { force: true });
  plan.setStatus('L4', 'doing', '2026-10-01');
  plan.save();
  return { dir, raf, plan: join(dir, '.cadence/raf.yaml'), archive: (year: string) => join(dir, '.cadence/archive', `${year}.yaml`) };
}
