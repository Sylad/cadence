import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { orchestrate, parseAuthStatus, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { AGENTS_DIR } from '../src/skills.js';
import { Plan } from '../src/plan.js';
import { git } from './orchestrate-harness.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';

// L378 (accroc A7) — claude installé mais non connecté : refus avant toute écriture dans le plan, jamais un lot laissé « doing ».

function projet(parent = tempDir(), name = 'alpha') {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), name, 'L', '2026-09-01');
  plan.add('un lot', '2026-10-01', { estimate: 1 });
  plan.save();
  writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
  git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
  git(dir, 'commit', '-q', '-m', 'chore: plan');
  return { parent, dir };
}

async function lancer(parent: string, argv: string[], auth: OrchestrateDeps['claudeAuth']) {
  const sessions: string[] = [];
  const claude: ClaudeFn = async (args) => {
    sessions.push(args.join(' '));
    throw new Error('aucune session ne doit s\'ouvrir');
  };
  const deps: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), claudeAuth: auth, agentsDir: AGENTS_DIR };
  const out: string[] = [];
  const err: string[] = [];
  const io: OrchestrateIo = { cwd: parent, env: { RAF_TODAY: '2026-10-04' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-04T14:12:00') };
  const code = await orchestrate(argv, io, deps);
  return { code, out, err, sessions };
}

describe('claude connecté avant de démarrer un lot (L378)', () => {
  it('R1 — claude non connecté : refus (2) avant toute écriture, le message dit /login', async () => {
    const { parent, dir } = projet();
    const head = git(dir, 'rev-parse', 'HEAD');
    const plan = readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');
    const r = await lancer(parent, ['alpha:L1'], () => ({ loggedIn: false }));
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/claude n'est pas connecté.*\/login.*claude auth status/);
    expect(r.sessions).toEqual([]);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head); // pas de commit « plan: L1 démarré »
    expect(readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8')).toBe(plan); // lot toujours « todo »
    expect(git(dir, 'status', '--porcelain', '--', '.cadence')).toBe('');
  });

  it('R2 — la simulation le signale, sans refuser ni écrire', async () => {
    const { parent, dir } = projet();
    const r = await lancer(parent, ['alpha:L1', '--dry-run'], () => ({ loggedIn: false }));
    try {
      expect(r.code).toBe(0);
      expect(r.out.join('\n')).toMatch(/⚠ claude n'est pas connecté.*\/login/);
      expect(r.err).toEqual([]);
    } finally {
      removeDryRunBriefs(r.out.join('\n'));
    }
    expect(git(dir, 'status', '--porcelain')).not.toContain('raf.yaml');
  });

  it('R3 — connecté, ou état illisible (claudeAuth absent ou null) : aucun refus pour ce motif', async () => {
    const { parent } = projet();
    for (const auth of [() => ({ loggedIn: true }), () => null, undefined]) {
      const r = await lancer(parent, ['alpha:L1', '--dry-run'], auth);
      try {
        expect(r.code).toBe(0);
        expect(r.out.join('\n')).not.toContain('pas connecté');
      } finally {
        removeDryRunBriefs(r.out.join('\n'));
      }
    }
  });
});

describe('lecture de `claude auth status` (L378)', () => {
  it('R4 — loggedIn lu dans le JSON ; texte illisible : null, jamais un refus', () => {
    expect(parseAuthStatus('{\n "loggedIn": false,\n "authMethod": "none"\n}')).toEqual({ loggedIn: false });
    expect(parseAuthStatus('{"loggedIn": true}')).toEqual({ loggedIn: true });
    expect(parseAuthStatus('')).toBeNull();
    expect(parseAuthStatus('error: unknown command auth')).toBeNull();
    expect(parseAuthStatus('{"autre": 1}')).toBeNull();
  });
});

describe('une seule vérification par vague (L382)', () => {
  it('R5 — --continue, claude connecté, plusieurs lots candidats sur plusieurs tours : `claude auth status` n\'est lancé qu\'une fois', async () => {
    const parent = tempDir();
    for (const n of ['a', 'b', 'c']) projet(parent, n);
    let appels = 0;
    const r = await lancer(parent, ['--continue', '--max-sessions', '1'], () => {
      appels++;
      return { loggedIn: true };
    });
    expect(r.sessions.length + appels).toBeGreaterThan(1); // la session factice échoue : plusieurs tirages ont eu lieu
    expect(appels).toBe(1);
  });

  it('R6 — le refus « non connecté » reste vu à chaque tirage de la vague avec une seule vérification', async () => {
    const parent = tempDir();
    for (const n of ['a', 'b', 'c']) projet(parent, n);
    let appels = 0;
    const r = await lancer(parent, ['--continue', '--max-sessions', '1'], () => {
      appels++;
      return { loggedIn: false };
    });
    expect(appels).toBe(1);
    expect(r.code).toBe(2);
    expect(r.sessions).toEqual([]);
  });
});
