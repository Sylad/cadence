import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { noTestGate, noTestText } from '../src/orchestrate/no-test.js';
import { orchestrate, type OrchestrateIo } from '../src/orchestrate/command.js';
import { AGENTS_DIR } from '../src/skills.js';
import { git, claudeOut, reviewReport } from './orchestrate-harness.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

/** Un dossier parent avec un projet par nom : dépôt git, plan d'un lot, et le cadence.yaml donné (precheck coupé). */
function parentWith(projects: Record<string, { config?: string; files?: Record<string, string> }>) {
  const parent = tempDir();
  const dirs: Record<string, string> = {};
  for (const [name, p] of Object.entries(projects)) {
    const dir = join(parent, name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const plan = Plan.create(join(dir, '.cadence/raf.yaml'), name, 'L', '2026-09-01');
    plan.add('un', '2026-10-01', { estimate: 1 });
    plan.add('deux', '2026-10-01', { estimate: 1 });
    plan.save();
    writeFileSync(join(dir, 'cadence.yaml'), p.config ?? 'orchestrate:\n  precheck: false\n');
    const extra = Object.entries(p.files ?? {});
    for (const [f, text] of extra) writeFileSync(join(dir, f), text);
    git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml', ...extra.map(([f]) => f));
    git(dir, 'commit', '-q', '-m', 'chore: plan');
    dirs[name] = dir;
  }
  return { parent, dirs };
}

const PKG = (test?: string) => JSON.stringify({ name: 'x', scripts: test === undefined ? {} : { test } });

async function tour(cwd: string, ...args: string[]) {
  const out: string[] = [];
  const code = await run(['lead', 'tour', ...args], { cwd, env: { RAF_TODAY: '2026-10-25' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-10-25T10:00:00') });
  return { code, out: out.join('\n') };
}

describe('porte de tests absente : signalée par le tour et le dry-run (L327)', () => {
  it('R1 — package.json avec scripts.test : la commande probable est « npm test »', () => {
    const { dirs } = parentWith({ a: { files: { 'package.json': PKG('vitest run') } } });
    expect(noTestGate(dirs.a)).toEqual({ probable: 'npm test' });
  });

  it('R2 — le script de remplissage de npm init (« no test specified ») n\'est pas une commande probable', () => {
    const { dirs } = parentWith({ a: { files: { 'package.json': PKG('echo "Error: no test specified" && exit 1') } } });
    expect(noTestGate(dirs.a)).toEqual({ probable: null });
  });

  it('R3 — pyproject.toml qui nomme pytest : « pytest » ; pom.xml : « mvn test » ; rien : pas de commande', () => {
    expect(noTestGate(parentWith({ a: { files: { 'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n' } } }).dirs.a)).toEqual({ probable: 'pytest' });
    expect(noTestGate(parentWith({ a: { files: { 'pom.xml': '<project/>' } } }).dirs.a)).toEqual({ probable: 'mvn test' });
    expect(noTestGate(parentWith({ a: {} }).dirs.a)).toEqual({ probable: null });
  });

  it('R4 — orchestrate.test déclaré : rien à signaler', () => {
    const { dirs } = parentWith({ a: { config: 'orchestrate:\n  test: npx vitest run\n', files: { 'package.json': PKG('vitest run') } } });
    expect(noTestGate(dirs.a)).toBeNull();
  });

  it('R5 — un cadence.yaml illisible ne fait pas signaler la porte (l\'erreur a sa propre ligne)', () => {
    const { dirs } = parentWith({ a: { config: 'orchestrate: [\n' } });
    expect(noTestGate(dirs.a)).toBeNull();
  });

  it('R6 — la phrase dit que la vague ne lancera pas la suite et que seule la revue le fera si elle le décide, avec la commande probable', () => {
    const avec = noTestText({ probable: 'npm test' });
    expect(avec).toContain('orchestrate.test');
    expect(avec).toContain('la vague ne lancera pas la suite');
    expect(avec).toContain('seule la revue le fera si elle le décide');
    expect(avec).toContain('commande probable : npm test');
    expect(noTestText({ probable: null })).not.toContain('commande probable');
  });

  it('R7 — lead tour : une ligne par projet sans orchestrate.test, après le tableau ; rien pour un projet qui le déclare', async () => {
    const { parent } = parentWith({
      alpha: { files: { 'package.json': PKG('vitest run') } },
      beta: { config: 'orchestrate:\n  precheck: false\n  test: npm test\n' },
      gamma: {},
    });
    const r = await tour(parent);
    const lines = r.out.split('\n');
    const gate = lines.filter((l) => l.includes('porte de tests absente'));
    expect(gate).toHaveLength(2);
    expect(gate[0]).toMatch(/^alpha · porte de tests absente/);
    expect(gate[0]).toContain('commande probable : npm test');
    expect(gate[1]).toMatch(/^gamma · porte de tests absente/);
    expect(gate[1]).not.toContain('commande probable');
    // après les lignes du tableau, jamais dans la ligne du projet
    expect(lines.findIndex((l) => l.startsWith('gamma · en cours'))).toBeLessThan(lines.indexOf(gate[0]));
    expect(lines.find((l) => l.startsWith('alpha · en cours'))).not.toContain('porte de tests');
  });

  it('R8 — lead tour --json : le champ noTest de la ligne du projet, absent quand la porte est déclarée', async () => {
    const { parent } = parentWith({ alpha: { files: { 'package.json': PKG('vitest run') } }, beta: { config: 'orchestrate:\n  test: npm test\n' } });
    const rows = JSON.parse((await tour(parent, '--json')).out) as { project: string; noTest?: { probable: string | null } }[];
    expect(rows.find((x) => x.project === 'alpha')!.noTest).toEqual({ probable: 'npm test' });
    expect(rows.find((x) => x.project === 'beta')!.noTest).toBeUndefined();
  });

  it('R9 — orchestrate --dry-run : la ligne est écrite une fois par dépôt (pas par lot), rien quand la porte est déclarée', async () => {
    const { parent } = parentWith({ a: { files: { 'package.json': PKG('vitest run') } }, b: { config: 'orchestrate:\n  precheck: false\n  test: npm test\n' } });
    const out: string[] = [];
    const io: OrchestrateIo = { cwd: parent, env: { RAF_TODAY: '2026-10-25' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-10-25T10:00:00') };
    const deps = { claude: async () => claudeOut(reviewReport()), claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR };
    const code = await orchestrate(['a:L1', 'a:L2', 'b:L1', '--dry-run'], io, deps);
    const text = out.join('\n');
    try {
      expect(code).toBe(0);
      const gate = out.filter((l) => l.includes('porte de tests absente'));
      expect(gate).toHaveLength(1);
      expect(gate[0]).toContain('a');
      expect(gate[0]).toContain('commande probable : npm test');
    } finally {
      removeDryRunBriefs(text);
    }
  });

  it('R10 — docs/orchestrate.md, docs/lead.md et le CHANGELOG décrivent la ligne', () => {
    for (const f of ['docs/orchestrate.md', 'docs/lead.md', 'CHANGELOG.md']) {
      const text = readFileSync(join(import.meta.dirname, '..', f), 'utf8');
      expect(text, f).toContain('porte de tests absente');
      expect(text, f).toContain('L327');
    }
  });
});
