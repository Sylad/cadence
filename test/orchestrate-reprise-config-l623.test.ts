import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { toolDirOf } from '../src/orchestrate/snapshot.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import { tempDir } from './helpers.js';

const THROWS = "export function readOrchestrateConfig() { throw new Error('orchestrate.gate.refs inconnu'); }\n";
const ACCEPTS = 'export function readOrchestrateConfig() { return {}; }\n';

function setup(frozenConfig: string | null, yaml: string) {
  const launch = tempDir();
  writeFileSync(join(launch, 'cadence.yaml'), yaml);
  const store = new RunStore(launch, 'vague-x');
  store.writeWave({ id: 'vague-x', created: '2026-11-05T10:00:00', cwd: launch, budget: 1_000_000, consumed: 0, cacheRead: 0, status: 'interrupted', pid: 1, lots: [] });
  const tool = toolDirOf(store.dir);
  mkdirSync(join(tool, 'bin'), { recursive: true });
  mkdirSync(join(tool, 'dist'), { recursive: true });
  writeFileSync(join(tool, 'bin', 'cadence.js'), '');
  writeFileSync(join(tool, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(tool, 'node_modules', 'yaml'), { recursive: true });
  writeFileSync(join(tool, 'node_modules', 'yaml', 'package.json'), '{}');
  if (frozenConfig !== null) writeFileSync(join(tool, 'dist', 'config.js'), frozenConfig);
  // Le paquet en service : sa copie à jour du code.
  const pkg = tempDir();
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'dist', 'config.js'), ACCEPTS);
  writeFileSync(join(pkg, 'package.json'), '{"type":"module"}\n');
  const err: string[] = [];
  const io: OrchestrateIo = { cwd: launch, env: { RAF_TODAY: '2026-11-05' }, out: () => {}, err: (l) => err.push(l), now: () => new Date('2026-11-05T14:00:00') };
  const reexec: string[] = [];
  const deps: OrchestrateDeps = { claude: async () => { throw new Error('aucune session'); }, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, snapshot: { packageRoot: pkg, reexec: async (t) => (reexec.push(t), 0) } };
  return { store, tool, io, err, deps, reexec };
}

const VALID = 'orchestrate:\n  worktrees: true\n';

describe('L623 — la reprise ne refuse pas une clé de cadence.yaml ajoutée depuis la copie figée', () => {
  it("R1 — la copie figée refuse le cadence.yaml que la copie en service accepte : la copie avance, la reprise le dit et relance sur elle", async () => {
    const s = setup(THROWS, VALID);
    expect(await orchestrate(['--resume', 'vague-x'], s.io, s.deps)).toBe(0);
    expect(readFileSync(join(s.tool, 'dist', 'config.js'), 'utf8')).toBe(ACCEPTS);
    expect(s.err.join('\n')).toMatch(/instantané avancé[^]*orchestrate\.gate\.refs inconnu/);
    expect(s.reexec).toEqual([s.tool]);
    expect(readFileSync(join(s.store.dir, 'journal.log'), 'utf8')).toContain('instantané avancé');
  });

  it("R2 — la copie figée accepte le cadence.yaml : rien n'est touché, rien n'est dit", async () => {
    const s = setup(ACCEPTS, VALID);
    await orchestrate(['--resume', 'vague-x'], s.io, s.deps);
    expect(readFileSync(join(s.tool, 'dist', 'config.js'), 'utf8')).toBe(ACCEPTS);
    expect(s.err.join('\n')).not.toContain('avancé');
    expect(s.reexec).toEqual([s.tool]);
  });

  it("R3 — un cadence.yaml invalide pour la copie en service aussi : la copie figée n'avance pas (la vraie erreur est celle du fils)", async () => {
    const s = setup(THROWS, 'orchestrate:\n  clé_fausse: 1\n');
    await orchestrate(['--resume', 'vague-x'], s.io, s.deps);
    expect(readFileSync(join(s.tool, 'dist', 'config.js'), 'utf8')).toBe(THROWS);
    expect(s.err.join('\n')).not.toContain('avancé');
  });

  it("R4 — une copie figée sans dist/config.js (illisible) : on ne devine rien, elle n'avance pas", async () => {
    const s = setup(null, VALID);
    await orchestrate(['--resume', 'vague-x'], s.io, s.deps);
    expect(s.err.join('\n')).not.toContain('avancé');
    expect(s.reexec).toEqual([s.tool]);
  });
});
