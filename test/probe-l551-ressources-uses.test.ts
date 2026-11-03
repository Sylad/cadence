import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runPool } from '../src/orchestrate/pool.js';
import type { LotCtx } from '../src/orchestrate/cycle.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { claudeOut, commitFile, git, harness, kindOf, reviewReport, workReport } from './orchestrate-harness.js';

/** Quatre dépôts (un lot chacun) ; mesure, par dépôt, les intervalles où une session joue. */
function setup(n = 4) {
  const hs = Array.from({ length: n }, () => harness());
  const active = new Map<string, number>();
  const spans: { repo: number; start: number; end: number }[] = [];
  let clock = 0;
  const open = new Map<string, number>();
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    const i = hs.findIndex((h) => o.cwd.startsWith(h.repo));
    if (!open.has(o.cwd)) open.set(o.cwd, clock++);
    const t0 = open.get(o.cwd)!;
    await new Promise((r) => setTimeout(r, 5));
    let out;
    if (kind === 'implement') out = claudeOut(workReport({ commits: [commitFile(o.cwd, `L1-${Math.random()}.txt`, 'feat(L1): x')] }));
    else out = claudeOut(reviewReport());
    spans.push({ repo: i, start: t0, end: clock++ });
    return out;
  };
  const wave = { ...hs[0].wave, claude };
  const ctxs: LotCtx[] = hs.map((h, i) => {
    const c: LotCtx = { ...h.lot('L1'), wave };
    c.lot.project = `p${i}`;
    return c;
  });
  return { ctxs, hs, spans };
}
const uses = (h: ReturnType<typeof harness>, names: string[], declared = ['r1', 'r2', 'r3']) => {
  writeFileSync(join(dirname(h.repo), 'cadence.yaml'), `resources: [${declared.join(', ')}]\n`);
  const plan = h.plan();
  plan.setUses('L1', names);
  plan.save();
  git(h.repo, 'add', '--', '.cadence/raf.yaml');
  git(h.repo, 'commit', '-q', '-m', 'chore: uses');
};
/** Span global d'un dépôt : première session → dernière. */
const span = (s: ReturnType<typeof setup>, repo: number) => {
  const m = s.spans.filter((x) => x.repo === repo);
  return { start: Math.min(...m.map((x) => x.start)), end: Math.max(...m.map((x) => x.end)) };
};
const disjoint = (s: ReturnType<typeof setup>, a: number, b: number) => {
  const x = span(s, a), y = span(s, b);
  return x.end <= y.start || y.end <= x.start;
};

describe('probe L551 — ressources uses: tenues dans la vague', () => {
  it('trois lots portant la même ressource ne se chevauchent jamais deux à deux', async () => {
    const s = setup(4);
    for (const i of [0, 1, 2]) uses(s.hs[i], ['r1']);
    await runPool(s.ctxs, 4);
    expect(s.ctxs.map((c) => c.lot.status)).toEqual(['ready', 'ready', 'ready', 'ready']);
    expect(disjoint(s, 0, 1) && disjoint(s, 0, 2) && disjoint(s, 1, 2)).toBe(true);
  });

  it('ressource partagée en chaîne (r1 | r1+r2 | r2) : le lot du milieu ne chevauche aucun des deux autres', async () => {
    const s = setup(3);
    uses(s.hs[0], ['r1']);
    uses(s.hs[1], ['r1', 'r2']);
    uses(s.hs[2], ['r2']);
    await runPool(s.ctxs, 3);
    expect(s.ctxs.every((c) => c.lot.status === 'ready')).toBe(true);
    expect(disjoint(s, 0, 1) && disjoint(s, 1, 2)).toBe(true);
  });

  it('une ressource déclarée deux fois sur le même lot ne le bloque pas contre lui-même', async () => {
    const s = setup(2);
    uses(s.hs[0], ['r1', 'r1']);
    uses(s.hs[1], ['r2']);
    await runPool(s.ctxs, 2);
    expect(s.ctxs.map((c) => c.lot.status)).toEqual(['ready', 'ready']);
  });

  it('en mode parallèle (worktrees), deux lots d\'un même groupe qui portent la même ressource se suivent', async () => {
    const s = setup(2);
    uses(s.hs[0], ['r1']);
    uses(s.hs[1], ['r1']);
    await runPool(s.ctxs, 2, [], () => {}, () => true);
    expect(disjoint(s, 0, 1)).toBe(true);
  });

  it('un lot ajouté en cours de vague (answers) qui porte la ressource tenue attend la fin du lot qui la tient', async () => {
    const s = setup(2);
    uses(s.hs[0], ['r1']);
    uses(s.hs[1], ['r1']);
    const late = s.ctxs[1];
    let given = false;
    await runPool([s.ctxs[0]], 2, [], () => {}, () => true, {
      pollMs: 5,
      take: () => {
        if (given) return [];
        given = true;
        return [late];
      },
    });
    expect(s.ctxs.map((c) => c.lot.status)).toEqual(['ready', 'ready']);
    expect(disjoint(s, 0, 1)).toBe(true);
  });

  it('un lot sans entrée dans le plan (id inconnu) n\'est pas retenu et ne fait pas échouer le pool', async () => {
    const s = setup(2);
    uses(s.hs[1], ['r1']);
    const real = s.ctxs[0].loadPlan;
    s.ctxs[0].loadPlan = () => {
      const p = real();
      const lots = p.lots.bind(p);
      p.lots = () => lots().filter((l) => l.id !== 'L1');
      return p;
    };
    await expect(runPool(s.ctxs, 2)).resolves.toBeUndefined();
  });

  it('une seule file, un seul créneau : aucune ressource ne bloque le départ forcé (pas de boucle infinie)', async () => {
    const s = setup(2);
    uses(s.hs[0], ['r1']);
    uses(s.hs[1], ['r1']);
    await runPool(s.ctxs, 1);
    expect(s.ctxs.map((c) => c.lot.status)).toEqual(['ready', 'ready']);
  });
});
