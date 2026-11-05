import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll } from 'vitest';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cadenceHome, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { toolDirOf } from '../src/orchestrate/snapshot.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import { tempDir } from './helpers.js';

const THROWS = "export function readOrchestrateConfig() { throw new Error('orchestrate.gate.refs inconnu'); }\n";
const ACCEPTS = 'export function readOrchestrateConfig() { return {}; }\n';
/** Une copie figée qui ne connaît pas la clé marquée `# nouvelle` : elle refuse le fichier qui la porte, accepte les autres (le vrai cas : `orchestrate.gate.refs` dans le dépôt du lot, rien dans le parent). */
const THROWS_ON_MARK = "import { readFileSync } from 'node:fs';\nexport function readOrchestrateConfig(file) { if (readFileSync(file, 'utf8').includes('# nouvelle')) throw new Error('orchestrate.gate.refs inconnu'); return {}; }\n";
const NEW_KEY = 'orchestrate:\n  worktrees: true # nouvelle\n';

const fileHome = process.env.CADENCE_HOME;
beforeAll(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterAll(() => {
  process.env.CADENCE_HOME = fileHome;
});

function setup(frozenConfig: string | null, yaml: string, frozenConfigSet?: string) {
  const launch = tempDir();
  writeFileSync(join(launch, 'cadence.yaml'), yaml);
  const store = new RunStore(launch, 'vague-x');
  store.writeWave({ id: 'vague-x', created: '2026-11-05T10:00:00', cwd: launch, budget: 1_000_000, consumed: 0, cacheRead: 0, status: 'interrupted', pid: 1, lots: [] });
  // Un lot de la vague dans son propre dépôt (la vague lancée depuis le dossier parent des projets, comme docs/quickstart.md le décrit) : c'est SON cadence.yaml que le fils figé lit.
  const repo = join(launch, 'proj');
  mkdirSync(repo);
  const lot: LotState = { ...newLot({ project: 'proj', repo, lot: 'L1', title: 'un', visible: false, small: false, model: 'sonnet', readOnlyPlan: false }), status: 'suspended' };
  store.writeLot(lot);
  const tool = toolDirOf(store.dir);
  mkdirSync(join(tool, 'bin'), { recursive: true });
  mkdirSync(join(tool, 'dist', 'orchestrate'), { recursive: true });
  writeFileSync(join(tool, 'bin', 'cadence.js'), '');
  // Une copie figée qui connaît --integrate et --budget projet:lot=+N (L279, L223) : la reprise la relance au lieu de passer sur le dist/ courant.
  writeFileSync(join(tool, 'dist', 'orchestrate', 'command.js'), '// lotBudgets abandonCommits\n');
  writeFileSync(join(tool, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(tool, 'node_modules', 'yaml'), { recursive: true });
  writeFileSync(join(tool, 'node_modules', 'yaml', 'package.json'), '{}');
  if (frozenConfig !== null) writeFileSync(join(tool, 'dist', 'config.js'), frozenConfig);
  if (frozenConfigSet !== undefined) writeFileSync(join(tool, 'dist', 'config-set.js'), frozenConfigSet);
  // Le paquet en service : sa copie à jour du code.
  const pkg = tempDir();
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'dist', 'config.js'), ACCEPTS);
  writeFileSync(join(pkg, 'package.json'), '{"type":"module"}\n');
  const err: string[] = [];
  const io: OrchestrateIo = { cwd: launch, env: { RAF_TODAY: '2026-11-05' }, out: () => {}, err: (l) => err.push(l), now: () => new Date('2026-11-05T14:00:00') };
  const reexec: string[] = [];
  const deps: OrchestrateDeps = { claude: async () => { throw new Error('aucune session'); }, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, snapshot: { packageRoot: pkg, reexec: async (t) => (reexec.push(t), 0) } };
  return { store, tool, repo, lot, io, err, deps, reexec };
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

  it("R5 — la copie figée refuse une clé hors orchestrate: (docs:) par un autre chargeur : la copie avance aussi", async () => {
    const s = setup(ACCEPTS, 'docs:\n  sync: []\n', "export function validateConfig() { throw new Error('docs.sync inconnu'); }\n");
    expect(await orchestrate(['--resume', 'vague-x'], s.io, s.deps)).toBe(0);
    expect(readFileSync(join(s.tool, 'dist', 'config.js'), 'utf8')).toBe(ACCEPTS);
    expect(s.err.join('\n')).toMatch(/instantané avancé[^]*docs\.sync inconnu/);
    expect(s.reexec).toEqual([s.tool]);
  });

  it("R6 — lancée depuis le dossier parent : la clé ajoutée est dans le cadence.yaml du dépôt du lot, le parent est sain : la copie avance, le message nomme le fichier du dépôt", async () => {
    const s = setup(THROWS_ON_MARK, 'lead: {}\n');
    writeFileSync(join(s.repo, 'cadence.yaml'), NEW_KEY);
    expect(await orchestrate(['--resume', 'vague-x'], s.io, s.deps)).toBe(0);
    expect(readFileSync(join(s.tool, 'dist', 'config.js'), 'utf8')).toBe(ACCEPTS);
    expect(s.err.join('\n')).toContain(`refusait ${join(s.repo, 'cadence.yaml')} (orchestrate.gate.refs inconnu)`);
    expect(s.reexec).toEqual([s.tool]);
  });

  it("R6 — la clé est dans le cadence.yaml du dépôt du lot et la copie en service le refuse aussi : rien n'avance", async () => {
    const s = setup(THROWS_ON_MARK, 'lead: {}\n');
    writeFileSync(join(s.repo, 'cadence.yaml'), 'orchestrate:\n  clé_fausse: 1 # nouvelle\n');
    await orchestrate(['--resume', 'vague-x'], s.io, s.deps);
    expect(readFileSync(join(s.tool, 'dist', 'config.js'), 'utf8')).toBe(THROWS_ON_MARK);
    expect(s.err.join('\n')).not.toContain('avancé');
  });

  it("R7 — la vague tourne encore : la copie figée n'avance pas, ni sur un --resume refusé ni sur une réponse déposée dans sa file", async () => {
    for (const argv of [['--resume', 'vague-x'], ['--resume', 'vague-x', '--answer', 'L1', 'oui']]) {
      const s = setup(THROWS, VALID);
      s.store.writeLot({ ...s.lot, status: 'question' });
      registerWave(cadenceHome(), { pid: process.ppid, wave: 'vague-x', started: '2026-11-05T10:00:00Z', cwd: s.io.cwd, repos: [s.repo] });
      try {
        await orchestrate(argv, s.io, s.deps);
      } finally {
        unregisterWave(cadenceHome(), process.ppid);
      }
      expect(readFileSync(join(s.tool, 'dist', 'config.js'), 'utf8')).toBe(THROWS);
      expect(s.err.join('\n')).not.toContain('avancé');
    }
  });

  it("R8 — un lot inconnu parmi ceux que nomme la reprise (--answer, --integrate) : la reprise sera refusée, la copie figée n'avance pas", async () => {
    for (const argv of [['--resume', 'vague-x', '--answer', 'L9', 'oui'], ['--resume', 'vague-x', '--integrate', 'proj:L9']]) {
      const s = setup(THROWS, VALID);
      await orchestrate(argv, s.io, s.deps);
      expect(readFileSync(join(s.tool, 'dist', 'config.js'), 'utf8')).toBe(THROWS);
      expect(s.err.join('\n')).not.toContain('avancé');
    }
  });

  it("R9 — la vague est terminée et rien ne la rejoue : la copie figée n'avance pas ; --integrate d'un lot connu la rejoue, elle avance", async () => {
    const done = setup(THROWS, VALID);
    done.store.writeWave({ ...done.store.readWave()!, status: 'done' });
    await orchestrate(['--resume', 'vague-x'], done.io, done.deps);
    expect(readFileSync(join(done.tool, 'dist', 'config.js'), 'utf8')).toBe(THROWS);
    expect(done.err.join('\n')).not.toContain('avancé');
    const integ = setup(THROWS, VALID);
    integ.store.writeWave({ ...integ.store.readWave()!, status: 'done' });
    integ.store.writeLot({ ...integ.lot, status: 'handed-back', next: 'integrate' });
    expect(await orchestrate(['--resume', 'vague-x', '--integrate', 'proj:L1'], integ.io, integ.deps)).toBe(0);
    expect(readFileSync(join(integ.tool, 'dist', 'config.js'), 'utf8')).toBe(ACCEPTS);
    expect(integ.err.join('\n')).toContain('instantané avancé');
  });
});
