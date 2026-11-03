import { describe, expect, it } from 'vitest';
import { buildArgs, buildRetryArgs, buildLocalArgs, readAgents, PLAYWRIGHT_TOOLS, type StepSpec } from '../src/orchestrate/launch.js';
import { AGENTS_DIR } from '../src/skills.js';

const base = {
  kind: 'review', brief: 'b', schema: { type: 'object' }, model: 'sonnet', sessionId: 'sid', permissionMode: 'default', addDirs: [], agent: undefined,
} as unknown as StepSpec;
const agentsOf = (args: string[]) => JSON.parse(args[args.indexOf('--agents') + 1]) as Record<string, { tools?: string[]; prompt: string }>;

describe('L560 sonde — --agents ne porte que l\'agent de l\'étape', () => {
  it('sans agent : ni --agents ni --agent, lancement et relance', () => {
    for (const a of [buildArgs(base, { x: { description: 'd', prompt: 'p' } }), buildRetryArgs(base, 'sid', { x: { description: 'd', prompt: 'p' } })]) {
      expect(a).not.toContain('--agents');
      expect(a).not.toContain('--agent');
    }
  });

  it('agent absent du paquet : erreur nommée (lancement et relance)', () => {
    const s = { ...base, agent: 'fantome' } as StepSpec;
    expect(() => buildArgs(s, {})).toThrow(/agent introuvable.*fantome/);
    expect(() => buildRetryArgs(s, 'sid', { autre: { description: 'd', prompt: 'p' } })).toThrow(/fantome/);
  });

  it('nom hérité d\'Object.prototype (constructor, __proto__, toString) : refusé comme absent', () => {
    for (const n of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(() => buildArgs({ ...base, agent: n } as StepSpec, { x: { description: 'd', prompt: 'p' } }), n).toThrow(/agent introuvable/);
    }
  });

  it('playwright : ajoute les outils du serveur à l\'agent seul, sans doublon, sans muter le paquet', () => {
    const pkg = { a: { description: 'd', prompt: 'p', tools: ['Read'] }, b: { description: 'd', prompt: 'q', tools: ['Read'] } };
    const out = agentsOf(buildArgs({ ...base, agent: 'a', playwright: true } as StepSpec, pkg));
    expect(Object.keys(out)).toEqual(['a']);
    expect(out.a.tools).toEqual(['Read', PLAYWRIGHT_TOOLS]);
    expect(pkg.a.tools).toEqual(['Read']);
    const twice = { a: { description: 'd', prompt: 'p', tools: ['Read', PLAYWRIGHT_TOOLS] } };
    expect(agentsOf(buildArgs({ ...base, agent: 'a', playwright: true } as StepSpec, twice)).a.tools).toEqual(['Read', PLAYWRIGHT_TOOLS]);
  });

  it('playwright sur un agent sans liste d\'outils : aucune liste inventée', () => {
    const out = agentsOf(buildArgs({ ...base, agent: 'a', playwright: true } as StepSpec, { a: { description: 'd', prompt: 'p' } }));
    expect(out.a).not.toHaveProperty('tools');
  });

  it('playwright sans agent : rien de plus', () => {
    expect(buildArgs({ ...base, playwright: true } as StepSpec, { a: { description: 'd', prompt: 'p' } })).not.toContain('--agents');
  });

  it('paquet réel : chaque agent × playwright reste sous 128 Kio et ne porte que lui-même ; --agents n\'apparaît qu\'une fois', () => {
    const pkg = readAgents(AGENTS_DIR);
    expect(Object.keys(pkg).length).toBeGreaterThan(1);
    for (const n of Object.keys(pkg)) for (const playwright of [false, true]) {
      const args = buildRetryArgs({ ...base, agent: n, playwright } as StepSpec, 'sid', pkg);
      expect(args.filter((x) => x === '--agents')).toHaveLength(1);
      expect(Object.keys(agentsOf(args))).toEqual([n]);
      for (const x of args) expect(Buffer.byteLength(x)).toBeLessThan(131_072);
    }
  });

  it('un paquet énorme (agents voisins de 300 Ko) ne change pas l\'argument de l\'étape', () => {
    const pkg = { a: { description: 'd', prompt: 'p' }, ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`g${i}`, { description: 'd', prompt: 'x'.repeat(60_000) }])) };
    const args = buildArgs({ ...base, agent: 'a' } as StepSpec, pkg);
    expect(Buffer.byteLength(args[args.indexOf('--agents') + 1])).toBeLessThan(200);
  });

  it('l\'agent de l\'étape lui-même énorme (> 128 Kio) : la borne le détecte', () => {
    const args = buildArgs({ ...base, agent: 'a' } as StepSpec, { a: { description: 'd', prompt: 'x'.repeat(140_000) } });
    // attendu : refus nommé plutôt qu'un spawn E2BIG
    expect(Buffer.byteLength(args[args.indexOf('--agents') + 1])).toBeLessThan(131_072);
  });

  it('étape locale : le prompt de l\'agent suivi du brief, pas de --agents', () => {
    const a = buildLocalArgs({ ...base, agent: 'a', local: true } as StepSpec, { a: { description: 'd', prompt: 'PROMPT' }, b: { description: 'd', prompt: 'AUTRE' } });
    expect(a[0]).toBe('PROMPT\n\nb');
    expect(a).not.toContain('--agents');
  });
});
