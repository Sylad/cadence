import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSession, isQuotaMessage } from '../src/orchestrate/result.js';
import { buildArgs, peakContext, projectLogDir, readAgents, runSession, type StepSpec } from '../src/orchestrate/launch.js';
import { AGENTS_DIR } from '../src/skills.js';
import { tempDir } from './helpers.js';

const sample = readFileSync(new URL('./fixtures/claude-result.sample.json', import.meta.url), 'utf8');

describe('parseSession (échantillon réel de claude -p --output-format json)', () => {
  it('lit les compteurs, la sortie structurée et le budget compté', () => {
    const r = parseSession(sample, { structured: true });
    expect(r.isError).toBe(false);
    expect(r.sessionId).toBe('da084ba4-3269-4b06-8e8a-a66ea38a728f');
    expect(r.numTurns).toBe(2);
    expect(r.durationMs).toBe(4979);
    expect(r.tokens).toEqual({ input: 10, cacheWrite: 30431, cacheRead: 0, output: 417, counted: 10 + 30431 + 417 });
    expect(r.structured).toEqual({ resume: 'ok', n: 1 });
  });

  it('la lecture de cache ne compte pas dans le budget', () => {
    const raw = JSON.parse(sample);
    raw.usage.cache_read_input_tokens = 2_000_000;
    const r = parseSession(JSON.stringify(raw), { structured: true });
    expect(r.tokens.cacheRead).toBe(2_000_000);
    expect(r.tokens.counted).toBe(10 + 30431 + 417);
  });

  it('un champ absent est une erreur nommée, jamais un zéro', () => {
    for (const path of ['usage', 'usage.output_tokens', 'usage.cache_read_input_tokens', 'session_id', 'is_error']) {
      const raw = JSON.parse(sample);
      const keys = path.split('.');
      const last = keys.pop()!;
      const holder = keys.reduce((o, k) => o[k], raw);
      delete holder[last];
      expect(() => parseSession(JSON.stringify(raw), { structured: true }), path).toThrow(new RegExp(path.replace('.', '\\.')));
    }
    const raw = JSON.parse(sample);
    delete raw.structured_output;
    expect(() => parseSession(JSON.stringify(raw), { structured: true })).toThrow(/structured_output/);
  });

  it('une sortie illisible est une erreur', () => {
    expect(() => parseSession('pas du json', { structured: false })).toThrow(/illisible/);
    expect(() => parseSession('', { structured: false })).toThrow(/vide/);
  });

  it('is_error : le message de limite d\'usage est reconnu', () => {
    const raw = JSON.parse(sample);
    raw.is_error = true;
    raw.subtype = 'error_during_execution';
    raw.result = 'Claude AI usage limit reached|1759600000';
    delete raw.structured_output;
    const r = parseSession(JSON.stringify(raw), { structured: true });
    expect(r.isError).toBe(true);
    expect(isQuotaMessage(r.result)).toBe(true);
    expect(isQuotaMessage('autre erreur')).toBe(false);
  });
});

const spec: StepSpec = {
  kind: 'review',
  sessionId: '11111111-2222-4333-8444-555555555555',
  brief: 'BRIEF',
  model: 'opus',
  schema: { type: 'object' },
  agent: 'code-reviewer',
  cwd: '/repo',
  wave: '2026-10-04-1412',
  permissionMode: 'auto',
  addDirs: ['/tmp/x'],
  timeoutMs: 1000,
};

describe('buildArgs', () => {
  it('modèle, agent, schéma, interdits et dossiers additionnels', () => {
    const agents = { 'code-reviewer': { description: 'd', prompt: 'p', tools: ['Read'] } };
    const args = buildArgs(spec, agents);
    expect(args.slice(0, 2)).toEqual(['-p', 'BRIEF']);
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at('--output-format')).toBe('json');
    expect(JSON.parse(at('--json-schema'))).toEqual({ type: 'object' });
    expect(at('--model')).toBe('opus');
    expect(at('--agent')).toBe('code-reviewer');
    expect(JSON.parse(at('--agents'))).toEqual(agents);
    expect(at('--permission-mode')).toBe('auto');
    const dis = args.slice(args.indexOf('--disallowedTools') + 1);
    expect(dis).toEqual(expect.arrayContaining(['Agent', 'Bash(git push:*)', 'Bash(cadence deliver:*)', 'Bash(raf done:*)', 'Bash(raf review:*)', 'Bash(raf ux:*)']));
    expect(at('--add-dir')).toBe('/tmp/x');
    expect(at('--session-id')).toBe('11111111-2222-4333-8444-555555555555');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('-r');
  });

  it('une implémentation n\'a ni --agent ni --agents', () => {
    const args = buildArgs({ ...spec, kind: 'implement', agent: undefined, model: 'sonnet', addDirs: [] }, {});
    expect(args).not.toContain('--agent');
    expect(args).not.toContain('--agents');
    expect(args).not.toContain('--add-dir');
  });
});

describe('agents du paquet', () => {
  it('les définitions de agents/*.md deviennent le JSON de --agents', () => {
    const agents = readAgents(AGENTS_DIR);
    expect(Object.keys(agents)).toEqual(expect.arrayContaining(['code-reviewer', 'ux-reviewer']));
    expect(agents['code-reviewer'].prompt).toContain('You review the code of one lot');
    expect(agents['code-reviewer'].tools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(agents['code-reviewer'].description).toMatch(/Code reviewer/);
  });
});

describe('runSession (lanceur injecté)', () => {
  it('passe cwd, environnement de garde, délai ; lit le résultat', async () => {
    const calls: { args: string[]; cwd: string; env: Record<string, string>; timeoutMs: number }[] = [];
    const out = await runSession(
      { ...spec, kind: 'implement', agent: undefined },
      {
        claude: async (args, opts) => {
          calls.push({ args, ...opts });
          return { code: 0, stdout: sample, stderr: '', timedOut: false };
        },
        agents: {},
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe('/repo');
    expect(calls[0].env.CADENCE_ORCHESTRATED).toBe('2026-10-04-1412');
    expect(calls[0].timeoutMs).toBe(1000);
    // jamais de pushurl ni de GIT_CONFIG_* : le hook pre-push est le garde (amendement du 04-10)
    expect(Object.keys(calls[0].env).filter((k) => k.startsWith('GIT_CONFIG'))).toEqual([]);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.result.tokens.counted).toBe(30858);
  });

  it('code ≠ 0, délai, sortie illisible, quota : échecs nommés', async () => {
    const mk = (r: { code: number; stdout: string; stderr?: string; timedOut?: boolean }) =>
      runSession({ ...spec, agent: undefined }, { claude: async () => ({ stderr: '', timedOut: false, ...r }), agents: {} });
    expect(await mk({ code: 1, stdout: '', stderr: 'boom' })).toMatchObject({ kind: 'failed', cause: expect.stringContaining('code 1') });
    expect(await mk({ code: 0, stdout: '', timedOut: true })).toMatchObject({ kind: 'failed', cause: 'délai dépassé' });
    expect(await mk({ code: 0, stdout: 'x' })).toMatchObject({ kind: 'failed', cause: expect.stringContaining('illisible') });
    const raw = JSON.parse(sample);
    raw.is_error = true;
    raw.result = 'Claude AI usage limit reached|1759600000';
    delete raw.structured_output;
    expect(await mk({ code: 1, stdout: JSON.stringify(raw) })).toMatchObject({ kind: 'quota' });
    raw.result = 'autre';
    expect(await mk({ code: 1, stdout: JSON.stringify(raw) })).toMatchObject({ kind: 'failed', cause: expect.stringContaining('autre') });
  });
});

describe('pic de contexte', () => {
  it('relu dans le journal .jsonl de la session', () => {
    const home = tempDir();
    const dir = projectLogDir(home, '/home/a_b/projects/x');
    expect(dir).toBe(join(home, 'projects', '-home-a-b-projects-x'));
    mkdirSync(dir, { recursive: true });
    const line = (i: number, c: number, r: number) => JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: i, cache_creation_input_tokens: c, cache_read_input_tokens: r, output_tokens: 5 } } });
    writeFileSync(join(dir, 'sess.jsonl'), [line(10, 100, 0), 'pas json', line(5, 20, 900), JSON.stringify({ type: 'user' })].join('\n'));
    expect(peakContext(home, '/home/a_b/projects/x', 'sess')).toBe(925);
    expect(peakContext(home, '/home/a_b/projects/x', 'absente')).toBeNull();
  });
});
