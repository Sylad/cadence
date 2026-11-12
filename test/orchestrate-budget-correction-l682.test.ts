import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { ESCALATION_RESERVE, REVIEW_RESERVE, runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { gitRepo } from './helpers.js';

const fix: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'b.txt', 'fix(L1): b.txt')] }));
const conforme: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const majeur = (n: number) => ({ source: 'code' as const, gravite: 'majeur', fichier: 'a.txt', ligne: n, texte: `constat ${n}` });

/** Le lot L676 (vague du 07-11) : 559 676 tokens comptés sur 600 000 hors escalade, 175 000 retenus pour l'escalade Fable, trois majeurs qui ne baissent pas. */
const L676_SPENT = 559_676;
const L676_BUDGET = 600_000 + ESCALATION_RESERVE;
const spentStep = (counted: number) => ({ n: 1, kind: 'implement', model: 'sonnet', status: 'done', tokens: { counted } }) as never;
const l676 = (over: Record<string, unknown> = {}) => ({
  budget: L676_BUDGET,
  escalationReserve: ESCALATION_RESERVE,
  pass: 2,
  next: 'fix' as const,
  reviewCounts: [3, 3],
  steps: [spentStep(L676_SPENT)],
  constats: [majeur(1), majeur(2), majeur(3)],
  ...over,
});

describe("budget de lot : la correction passe avant l'escalade (L682)", () => {
  it("R1 — cas L676 : la correction refusée par les passes ordinaires est payée sur la part de l'escalade, et jouée", async () => {
    const h = harness({ script: { fix: [fix], review: [conforme] } });
    const c = h.lot('L1', l676(), { escalation: { model: 'fable' } });
    await runLot(c);
    expect(kinds(h)[0]).toBe('fix');
    expect(c.lot.outcome ?? '').not.toContain('correction non jouée (budget)');
    const taken = L676_SPENT + REVIEW_RESERVE + ESCALATION_RESERVE + 1 - L676_BUDGET;
    expect(c.lot.escalationReserve).toBe(ESCALATION_RESERVE - taken);
    expect(c.lot.budget).toBe(L676_BUDGET);
    expect(c.lot.budgetTopUp).toBeUndefined();
    expect(c.lot.warnings.join('\n')).toContain(`correction payée sur la part de l'escalade : ${taken} token(s) pris`);
  });

  it("R2 — la part de l'escalade ne couvre pas le manque : rien n'est pris, le lot est rendu « correction non jouée (budget) »", async () => {
    const h = harness({ script: { fix: [fix], review: [conforme] } });
    const c = h.lot('L1', l676({ steps: [spentStep(L676_BUDGET - REVIEW_RESERVE)] }), { escalation: { model: 'fable' } });
    await runLot(c);
    expect(kinds(h)).toEqual([]);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('correction non jouée (budget)');
    expect(c.lot.escalationReserve).toBe(ESCALATION_RESERVE);
  });

  it("R3 — la passe des mineurs ne prend pas sur la part de l'escalade", async () => {
    const h = harness({ script: { fix: [fix], review: [conforme] } });
    const c = h.lot('L1', l676({ minorFix: true, minorPass: true, constats: [{ source: 'code', gravite: 'mineur', texte: 'nom' }] }), { escalation: { model: 'fable' } });
    await runLot(c);
    expect(kinds(h)).toEqual([]);
    expect(c.lot.escalationReserve).toBe(ESCALATION_RESERVE);
  });

  it("R4 — sans escalade déclarée, rien n'est retenu : le lot est rendu comme avant", async () => {
    const h = harness({ script: { fix: [fix], review: [conforme] } });
    const c = h.lot('L1', l676({ budget: 600_000, escalationReserve: undefined }));
    await runLot(c);
    expect(c.lot.outcome).toContain('correction non jouée (budget)');
  });
});

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-12' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-12T10:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un dépôt avec un plan et le dossier du cycle. */
function depot(): string {
  const dir = gitRepo();
  mkdirSync(join(dir, 'src/orchestrate/cycle'), { recursive: true });
  raf(dir, 'init', '--project', 'demo', '--no-hook');
  return dir;
}
const estimateOf = (dir: string, id: string) => Number(new RegExp(`id: ${id}\\n(?:.*\\n)*?\\s+estimate: ([\\d.]+)`).exec(readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8'))?.[1]);

describe("raf add : l'estimate d'un lot qui cite le cycle n'est plus doublée (L708, retire le doublement de L682)", () => {
  it("R5 — un titre qui cite src/orchestrate/cycle/ garde l'estimate donnée, ou celle par défaut, et rien n'est dit sur stderr", () => {
    const dir = depot();
    const a = raf(dir, 'add', 'Budget : réserve prise dans src/orchestrate/cycle/budget.ts', '--estimate', '0.25');
    expect(a.code).toBe(0);
    expect(estimateOf(dir, 'L1')).toBe(0.25);
    expect(a.err).not.toContain('estimate doublée');
    raf(dir, 'add', 'src/orchestrate/cycle/review.ts');
    expect(estimateOf(dir, 'L2')).toBe(1);
  });
});
