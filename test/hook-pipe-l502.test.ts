import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { run } from '../src/cli.js';

// L502 — le hook « pipe » : PreToolUse Bash refuse une commande de porte, de test, de push ou de livraison suivie de | tail/head/grep sans pipefail ni PIPESTATUS.
async function pipe(stdin: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(['claude-hook', 'pipe'], { cwd: process.cwd(), env: {}, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(), stdin: () => stdin });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const pre = (command: string, extra: Record<string, unknown> = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });
const silent = { code: 0, out: '', err: '' };
const reason = (out: string): string => {
  const o = (JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
  expect(o.hookEventName).toBe('PreToolUse');
  expect(o.permissionDecision).toBe('deny');
  return o.permissionDecisionReason;
};

describe('L502 — le pipe qui masque le code de sortie', () => {
  it.each([
    'cadence verify 2>&1 | tail -20',
    'raf done L1 | head',
    'cadence orchestrate a:L1 | grep -v x',
    'git push origin main | tail -3',
    'git -C ../x push | tail',
    'npm test | grep fail',
    'npm run test -- foo | tail',
    'npx vitest run | tail -30',
    'vitest run --reporter=dot 2>&1 | head -50',
    'FOO=1 npx jest | tail',
    'cd x && cadence deliver --sha abc | tail',
    'false || cadence verify | tail',
    'tsc --noEmit | head',
    'pytest -q | tail',
  ])('R1 — refuse « %s » : la porte est suivie de tail/head/grep sans pipefail', async (command) => {
    const r = await pipe(pre(command));
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    const text = reason(r.out);
    expect(text).toContain('set -o pipefail');
    expect(text).toContain('PIPESTATUS');
  });

  it('R2 — le message nomme la commande de porte et dit quoi écrire', async () => {
    const text = reason((await pipe(pre('cd x && npx vitest run | tail'))).out);
    expect(text).toContain('vitest run');
    expect(text).toContain('set -o pipefail; ');
  });

  it.each([
    'set -o pipefail; cadence verify | tail',
    'set -eo pipefail && npm test | tail',
    'npm test | tail; echo ${PIPESTATUS[0]}',
    'cadence verify | tail; test ${PIPESTATUS[0]} -eq 0',
  ])('R3 — laisse passer « %s » : pipefail ou PIPESTATUS écrit', async (command) => {
    expect(await pipe(pre(command))).toEqual(silent);
  });

  it.each([
    'cadence verify > $TMPDIR/v.txt 2>&1; tail $TMPDIR/v.txt',
    'git push && echo ok | tail',
    'git status | head',
    'cat f | grep x',
    'grep x f | npm test',
    'npm test | tee out.txt',
    'cadence orchestrate --status | tail',
    'cadence orchestrate a:L1 --dry-run | head',
    'raf show L1 | head',
    'raf list | grep doing',
    'git commit -m "npm test | tail"',
    "echo 'cadence verify | tail'",
    'git pushover | tail',
    'npm testing | tail',
    '',
  ])('R4 — laisse passer « %s » : pas de porte suivie d’un filtre', async (command) => {
    expect(await pipe(pre(command))).toEqual(silent);
  });

  it('R5 — ne dit rien à un sous-agent, sur une entrée illisible, sans commande ou sans champ', async () => {
    expect(await pipe(pre('npm test | tail', { agent_id: 'a1' }))).toEqual(silent);
    expect(await pipe('')).toEqual(silent);
    expect(await pipe('pas du json')).toEqual(silent);
    expect(await pipe('{}')).toEqual(silent);
    expect(await pipe(JSON.stringify({ tool_input: { command: 42 } }))).toEqual(silent);
  });

  it('R6 — hooks/hooks.json lance « cadence claude-hook pipe » avant la commande Bash, sans retirer « attente »', () => {
    const hooks = JSON.parse(readFileSync('hooks/hooks.json', 'utf8')) as { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } };
    const commands = hooks.hooks.PreToolUse.filter((g) => g.matcher === 'Bash').flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands.some((c) => c.includes('cadence claude-hook pipe') && c.includes('command -v cadence'))).toBe(true);
    expect(commands.some((c) => c.includes('cadence claude-hook attente'))).toBe(true);
  });
});
