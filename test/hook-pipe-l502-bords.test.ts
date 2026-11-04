import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

// L502 (sonde) — les bords du hook « pipe » : formes de shell valides qui masquent le code de sortie, et faux positifs.
async function pipe(stdin: string) {
  const out: string[] = [];
  const code = await run(['claude-hook', 'pipe'], { cwd: process.cwd(), env: {}, out: (l) => out.push(l), err: () => {}, now: () => new Date(), stdin: () => stdin });
  return { code, out: out.join('\n') };
}
const pre = (command: string, extra: Record<string, unknown> = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });
const denied = async (command: string) => {
  const r = await pipe(pre(command));
  expect(r.code).toBe(0);
  expect(r.out).not.toBe('');
  expect((JSON.parse(r.out) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision).toBe('deny');
};
const silent = async (command: string) => expect(await pipe(pre(command))).toEqual({ code: 0, out: '' });

describe('L502 sonde — formes de shell qui masquent le code de sortie', () => {
  it.each([
    'npm test |& tail',
    'cadence verify |& head -5',
    '(npm test) | tail',
    '{ npm test; } | tail',
    'time npm test | tail',
    'env CI=1 npm test | tail',
    'npx -y vitest run | tail',
    'pnpm exec vitest run | tail',
    'npm test |\ntail -5',
    'npm test | \\\n tail',
    'if npm test | tail; then echo ok; fi',
    '! npm test | tail',
    'npm test | /usr/bin/tail',
    'npm test | command tail',
    'x=$(npm test | tail -3)',
    'git -c core.x=1 push | tail',
    'npm run test:unit | tail',
    'cadence verify | tee $TMPDIR/v.txt | tail',
    'npm test --silent | rg fail',
    'npm test | egrep fail',
    'npm test | tail',
  ])('refuse « %s »', async (c) => denied(c));

  it.each([
    'npm test | tail # pipefail',
    'echo pipefail; npm test | tail',
    'git commit -m "pipefail"; npm test | tail',
  ])('pipefail seulement cité, pas posé : refuse « %s »', async (c) => denied(c));

  it.each([
    'set +o pipefail; npm test | tail',
    'npm test | tail; echo $?',
  ])('pipefail désarmé ou $? du filtre : refuse « %s »', async (c) => denied(c));

  it.each([
    'npm test > $TMPDIR/o.txt 2>&1; tail $TMPDIR/o.txt',
    'cadence verify || tail',
    'npm test; ls | tail',
    'ls | tail; npm test',
    'npm test &\nls | tail',
    'echo "a | b"; npm test',
    'npm test "|" tail',
  ])('laisse passer « %s »', async (c) => silent(c));

  it('deux appels identiques donnent la même réponse', async () => {
    const a = await pipe(pre('npm test | tail'));
    const b = await pipe(pre('npm test | tail'));
    expect(a).toEqual(b);
    expect(a.out).not.toBe('');
  });

  it('entrées de forme inattendue : silence, code 0', async () => {
    for (const s of ['null', '[]', '"x"', '42', JSON.stringify({ tool_input: null }), JSON.stringify({ tool_input: { command: null } }), JSON.stringify({ tool_input: { command: ['npm test | tail'] } }), JSON.stringify({ tool_input: { command: 'npm test | tail' }, agent_id: '' })]) {
      const r = await pipe(s);
      expect(r.code).toBe(0);
    }
    expect(await pipe(JSON.stringify({ tool_input: { command: ['npm test | tail'] } }))).toEqual({ code: 0, out: '' });
  });

  it('commande très longue : rapide et sans exception', async () => {
    const c = 'echo a | tail; '.repeat(5000) + 'npm test | tail';
    const t = Date.now();
    const r = await pipe(pre(c));
    expect(r.out).not.toBe('');
    expect(Date.now() - t).toBeLessThan(3000);
  });
});
