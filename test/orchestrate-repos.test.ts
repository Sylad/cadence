import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run as cadence } from '../src/cli.js';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { liveWaves, cadenceHome } from '../src/orchestrate/registry.js';
import { RunStore } from '../src/orchestrate/state.js';
import { Plan } from '../src/plan.js';
import { AGENTS_DIR } from '../src/skills.js';
import { claudeOut, commitFile, git, kindOf, reviewReport, workReport } from './orchestrate-harness.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

/**
 * Un dossier parent avec des projets cadence (lot L1 chacun) et des dépôts voisins non cadence ; `repos` donne, par projet,
 * les chemins déclarés par la clé de lot `repos:` (relatifs au dépôt du projet).
 */
function world(projects: Record<string, string[]>, neighbours: string[] = ['voisin']) {
  const parent = tempDir();
  const dirs: Record<string, string> = {};
  for (const name of neighbours) {
    initRepo(join(parent, name));
    writeFileSync(join(parent, name, 'README.md'), `# ${name}\n`);
    git(join(parent, name), 'add', '--', 'README.md');
    git(join(parent, name), 'commit', '-q', '-m', 'init');
    dirs[name] = join(parent, name);
  }
  for (const [name, repos] of Object.entries(projects)) {
    const dir = join(parent, name);
    initRepo(dir);
    const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), name, 'L', '2026-09-01');
    plan.add('un lot', '2026-10-01', { estimate: 1 });
    plan.setStatus('L1', 'doing', '2026-10-01');
    plan.save();
    const file = join(dir, 'docs/plan/raf.yaml');
    if (repos.length) writeFileSync(file, readFileSync(file, 'utf8').replace(/- id: L1\n/, `- id: L1\n    repos: [${repos.map((r) => JSON.stringify(r)).join(', ')}]\n`));
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
    git(dir, 'add', '--', 'docs/plan/raf.yaml', 'cadence.yaml');
    git(dir, 'commit', '-q', '-m', 'chore: plan');
    dirs[name] = dir;
  }
  return { parent, dirs };
}

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const i: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-10-08' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-08T14:12:00') };
  return { io: i, out, err };
}

type Hook = (call: { cwd: string; kind: string; args: string[] }) => void | Promise<void>;

/** Un claude scénarisé : implémentation qui commite dans le dépôt du projet, revue conforme ; `onCall` espionne chaque session. */
function deps(onCall: Hook = () => {}, tweak: Partial<OrchestrateDeps> = {}): OrchestrateDeps {
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    await onCall({ cwd: o.cwd, kind, args });
    if (kind === 'implement' || kind === 'fix') {
      const lot = /on lot `([^`]+)`/.exec(args[1])![1];
      return claudeOut(workReport({ commits: [commitFile(o.cwd, `${kind}-${Math.random()}.txt`, `feat(${lot}): travail`)] }));
    }
    return claudeOut(reviewReport());
  };
  return { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, ...tweak };
}

describe('lot à dépôt voisin : préconditions, refus avant d\'agir (L62)', () => {
  it('un dépôt voisin introuvable, ou qui n\'est pas un dépôt git, est refusé en code 2, nommé, avant tout verrou', async () => {
    const { parent, dirs } = world({ a: ['../nulle-part'] });
    let r = io(parent);
    expect(await orchestrate(['a:L1'], r.io, deps())).toBe(2);
    expect(r.err.join('\n')).toMatch(/a:L1 : dépôt voisin \.\.\/nulle-part : dossier introuvable/);

    const w = world({ b: ['../plat'] });
    mkdirSync(join(w.parent, 'plat'));
    r = io(w.parent);
    expect(await orchestrate(['b:L1'], r.io, deps())).toBe(2);
    expect(r.err.join('\n')).toContain("dépôt voisin ../plat : ");
    expect(r.err.join('\n')).toContain("n'est pas dans un dépôt git");
    for (const d of [dirs.a, w.dirs.b]) {
      expect(existsSync(join(d, '.git/cadence/orchestrate.lock'))).toBe(false);
      expect(existsSync(join(d, '.git/hooks/pre-push'))).toBe(false);
    }
    expect(existsSync(join(parent, '.cadence/runs'))).toBe(false);
  });

  it('un voisin à fichier suivi modifié est refusé comme le dépôt du projet : arbre sale', async () => {
    const { parent, dirs } = world({ a: ['../voisin'] });
    writeFileSync(join(dirs.voisin, 'README.md'), 'modifié\n');
    const r = io(parent);
    expect(await orchestrate(['a:L1'], r.io, deps())).toBe(2);
    expect(r.err.join('\n')).toMatch(/voisin : arbre sale, 1 fichier\(s\) suivi\(s\) modifié\(s\) : README\.md/);
  });

  it('un fichier non suivi dans le voisin ne bloque pas', async () => {
    const { parent, dirs } = world({ a: ['../voisin'] });
    writeFileSync(join(dirs.voisin, 'brouillon.txt'), 'x\n');
    expect(await orchestrate(['a:L1'], io(parent).io, deps())).toBe(0);
  });

  it('un hook pre-push existant dans le voisin est refusé (la garde ne le remplace pas)', async () => {
    const { parent, dirs } = world({ a: ['../voisin'] });
    writeFileSync(join(dirs.voisin, '.git/hooks/pre-push'), '#!/bin/sh\nexit 0\n');
    const r = io(parent);
    expect(await orchestrate(['a:L1'], r.io, deps())).toBe(2);
    expect(r.err.join('\n')).toContain('voisin : un hook pre-push existe déjà');
  });

  it('une orchestration vivante qui tient le voisin fait refuser la vague, sans rien poser nulle part', async () => {
    const { parent, dirs } = world({ a: ['../voisin'] });
    mkdirSync(join(dirs.voisin, '.git/cadence'), { recursive: true });
    writeFileSync(join(dirs.voisin, '.git/cadence/orchestrate.lock'), JSON.stringify({ pid: process.ppid, wave: 'autre', started: 'x' }));
    const r = io(parent);
    expect(await orchestrate(['a:L1'], r.io, deps())).toBe(2);
    expect(r.err.join('\n')).toContain('voisin : une orchestration y est déjà en cours (autre');
    expect(existsSync(join(dirs.a, '.git/cadence/orchestrate.lock'))).toBe(false);
    expect(existsSync(join(dirs.a, '.git/hooks/pre-push'))).toBe(false);
  });

  it('--dry-run applique les mêmes refus', async () => {
    const { parent } = world({ a: ['../nulle-part'] });
    const r = io(parent);
    expect(await orchestrate(['a:L1', '--dry-run'], r.io, deps())).toBe(2);
    expect(r.err.join('\n')).toContain('dossier introuvable');
  });
});

describe('lot à dépôt voisin : --dry-run', () => {
  it('nomme le voisin et passe son dossier en --add-dir à chaque étape', async () => {
    const { parent, dirs } = world({ a: ['../voisin'] });
    const r = io(parent);
    const code = await orchestrate(['a:L1', '--dry-run'], r.io, deps());
    const text = r.out.join('\n');
    try {
      expect(code).toBe(0);
      expect(text).toContain('dépôts voisins : ../voisin');
      const lines = text.split('\n').filter((l) => /^ {2}(implement|review) : claude /.test(l));
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const l of lines) expect(l).toContain(`--add-dir ${dirs.voisin}`);
    } finally {
      removeDryRunBriefs(text);
    }
  });

  it('sans clé repos, aucune ligne de dépôts voisins', async () => {
    const { parent } = world({ a: [] });
    const r = io(parent);
    await orchestrate(['a:L1', '--dry-run'], r.io, deps());
    const text = r.out.join('\n');
    try {
      expect(text).not.toContain('dépôts voisins');
    } finally {
      removeDryRunBriefs(text);
    }
  });
});

describe('lot à dépôt voisin : verrou, garde et file de la vague', () => {
  it('pendant la vague le voisin porte verrou et hook pre-push, cadence deliver y refuse ; tout est libéré à la fin', async () => {
    const { parent, dirs } = world({ a: ['../voisin'] });
    let seen: { hook: boolean; lock: boolean; registered: boolean; deliver?: { code: number; err: string } } | null = null;
    const d = deps(async ({ kind }) => {
      if (kind !== 'implement') return;
      const out: string[] = [];
      const err: string[] = [];
      const code = await cadence(['deliver', '--dry-run'], { cwd: dirs.voisin, env: { RAF_TODAY: '2026-10-08' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-08T14:12:00') });
      seen = {
        hook: existsSync(join(dirs.voisin, '.git/hooks/pre-push')),
        lock: existsSync(join(dirs.voisin, '.git/cadence/orchestrate.lock')),
        registered: liveWaves(cadenceHome()).some((w) => w.pid === process.pid && w.repos.includes(dirs.voisin) && w.repos.includes(dirs.a)),
        deliver: { code, err: err.join('\n') },
      };
    });
    expect(await orchestrate(['a:L1'], io(parent).io, d)).toBe(0);
    expect(seen).toMatchObject({ hook: true, lock: true, registered: true });
    expect(seen!.deliver!.code).toBe(2);
    expect(seen!.deliver!.err).toMatch(/orchestration en cours \(vague 2026-10-08-1412, pid \d+\)/);
    expect(existsSync(join(dirs.voisin, '.git/hooks/pre-push'))).toBe(false);
    expect(existsSync(join(dirs.voisin, '.git/cadence/orchestrate.lock'))).toBe(false);
    expect(liveWaves(cadenceHome())).toEqual([]);
  });

  it('deux lots de deux projets qui partagent un voisin ne tournent jamais en même temps (une seule session à la fois)', async () => {
    const { parent } = world({ a: ['../voisin'], b: ['../voisin'] });
    let inFlight = 0;
    let max = 0;
    const d = deps(async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 25));
      inFlight--;
    });
    const code = await orchestrate(['a:L1', 'b:L1', '--max-sessions', '4'], io(parent).io, d);
    expect(code).toBe(0);
    expect(max).toBe(1);
  });

  it('sans voisin partagé, deux projets tournent ensemble (la file n\'est pas serrée pour rien)', async () => {
    const { parent } = world({ a: [], b: [] });
    let inFlight = 0;
    let max = 0;
    const d = deps(async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 25));
      inFlight--;
    });
    await orchestrate(['a:L1', 'b:L1', '--max-sessions', '4'], io(parent).io, d);
    expect(max).toBe(2);
  });

  it('--resume refuse un voisin tenu par une autre orchestration vivante, sans rien poser', async () => {
    const { parent, dirs } = world({ a: ['../voisin'] });
    // une vague qui s'arrête en question : reprenable
    const asking: OrchestrateDeps = { ...deps(), claude: async () => claudeOut(workReport({ questions: ['Quelle clé ?'] })) };
    expect(await orchestrate(['a:L1'], io(parent).io, asking)).toBe(1);
    const store = RunStore.last(parent)!;
    expect(store).not.toBeNull();
    const lot = store.readLot('a', 'L1')!;
    expect(lot.repos?.map((r) => r.rel)).toEqual(['../voisin']);
    mkdirSync(join(dirs.voisin, '.git/cadence'), { recursive: true });
    writeFileSync(join(dirs.voisin, '.git/cadence/orchestrate.lock'), JSON.stringify({ pid: process.ppid, wave: 'autre', started: 'x' }));
    const r = io(parent);
    expect(await orchestrate(['--resume'], r.io, deps())).toBe(2);
    expect(r.err.join('\n')).toContain('voisin : une orchestration y est déjà en cours (autre');
    expect(existsSync(join(dirs.a, '.git/hooks/pre-push'))).toBe(false);
  });
});
