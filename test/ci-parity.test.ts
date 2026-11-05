import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { ciParityGaps, ciParityText } from '../src/orchestrate/ci-parity.js';
import { orchestrate, type OrchestrateIo } from '../src/orchestrate/command.js';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { verifyGate } from '../src/verify-gate.js';
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

const WF = (steps: string, extra = '') => `name: ci\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n${extra}    steps:\n${steps}`;
const GATE = 'orchestrate:\n  precheck: false\n  test: npx vitest run\n  build: npx tsc --noEmit\n';

/** Un dépôt git avec plan, cadence.yaml, et les fichiers donnés (workflows sous `.github/workflows/`). */
function project(files: Record<string, string>, config = GATE): string {
  const dir = join(tempDir(), 'p');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'p', 'L', '2026-09-01');
  plan.add('un', '2026-10-01', { estimate: 1 });
  plan.save();
  writeFileSync(join(dir, 'cadence.yaml'), config);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  git(dir, 'add', '--', '.');
  git(dir, 'commit', '-q', '-m', 'chore: plan');
  return dir;
}

const commands = (repo: string) => ciParityGaps(repo).map((g) => g.command);

describe('parité porte ↔ CI (L499)', () => {
  it('R1 — une commande de test de la CI que ni orchestrate.test ni orchestrate.build ne jouent est signalée, avec son workflow', () => {
    const repo = project({ '.github/workflows/ci.yml': WF('      - run: npx vitest run\n      - run: npx playwright test\n') });
    expect(ciParityGaps(repo)).toEqual([{ command: 'npx playwright test', workflow: 'ci.yml' }]);
  });

  it('R2 — la porte joue tout ce que la CI teste : rien à signaler ; sans dossier de workflows non plus', () => {
    expect(commands(project({ '.github/workflows/ci.yml': WF('      - run: npx vitest run\n') }))).toEqual([]);
    expect(commands(project({}))).toEqual([]);
  });

  it('R3 — une commande de build qui joue le test compte : npm test de la CI est couvert par la porte', () => {
    const repo = project({ 'package.json': '{"scripts":{"test":"vitest run"}}', '.github/workflows/ci.yml': WF('      - run: npm test\n') });
    expect(commands(repo)).toEqual([]);
  });

  it('R4 — npm run e2e se lit dans package.json : le script qui lance playwright est un test que la porte ne joue pas', () => {
    const repo = project({ 'package.json': '{"scripts":{"test":"vitest run","e2e":"playwright test"}}', '.github/workflows/ci.yml': WF('      - run: npm run e2e\n') });
    expect(commands(repo)).toEqual(['playwright test']);
  });

  it('R5 — un run sur plusieurs lignes, enchaîné par && ou ;, commenté ou avec continuation : chaque commande de test est lue seule', () => {
    const run = '      - run: |\n          # le e2e\n          npm ci && npx vitest run; CI=1 npx playwright test \\\n            --project=chromium\n          pytest -q\n';
    expect(commands(project({ '.github/workflows/ci.yml': WF(run) }))).toEqual(['CI=1 npx playwright test --project=chromium', 'pytest -q']);
  });

  it('R6 — les installations, le typecheck et les liens ne sont pas des tests', () => {
    const repo = project({ '.github/workflows/ci.yml': WF('      - run: npm ci\n      - run: npm run typecheck\n      - run: node scripts/check-links.mjs\n      - run: grep -E x <<< "$(npm run env)"\n') });
    expect(commands(repo)).toEqual([]);
  });

  it('R7 — les arguments ne font pas la différence : npx vitest run --coverage est couvert par npx vitest run', () => {
    expect(commands(project({ '.github/workflows/ci.yml': WF('      - run: npx vitest run --coverage\n      - run: vitest run\n') }))).toEqual([]);
  });

  it('R8 — working-directory : npm test de backend/ se lit dans backend/package.json, et la porte en parties qui le joue le couvre', () => {
    const files = { 'backend/package.json': '{"scripts":{"test":"jest"}}', '.github/workflows/ci.yml': WF('      - run: npm test\n        working-directory: backend\n') };
    expect(commands(project(files))).toEqual(['jest']);
    const parts = 'orchestrate:\n  test:\n    - { dir: backend, run: npx jest }\n';
    expect(commands(project(files, parts))).toEqual([]);
  });

  it('R9 — workflows illisibles, sans jobs, run qui n\'est pas une chaîne, .yaml : aucune erreur, le reste est lu', () => {
    const repo = project({
      '.github/workflows/casse.yml': 'jobs: [\n',
      '.github/workflows/vide.yml': 'name: x\n',
      '.github/workflows/mal.yml': 'jobs:\n  a: 3\n  b:\n    steps:\n      - run: 12\n      - 7\n',
      '.github/workflows/bon.yaml': WF('      - run: pytest\n'),
    });
    expect(ciParityGaps(repo)).toEqual([{ command: 'pytest', workflow: 'bon.yaml' }]);
  });

  it('R10 — une commande présente dans deux workflows n\'est signalée qu\'une fois', () => {
    const repo = project({ '.github/workflows/a.yml': WF('      - run: pytest\n'), '.github/workflows/b.yml': WF('      - run: pytest\n') });
    expect(commands(repo)).toEqual(['pytest']);
  });

  it('R11 — sans orchestrate.test ni build (ou cadence.yaml illisible) : aucune porte à comparer, l\'écart n\'est pas dit ici', () => {
    const wf = { '.github/workflows/ci.yml': WF('      - run: pytest\n') };
    expect(commands(project(wf, 'orchestrate:\n  precheck: false\n'))).toEqual([]);
    expect(commands(project(wf, 'orchestrate: [\n'))).toEqual([]);
  });

  it('R12 — la phrase nomme la commande, le workflow, et dit que le vert de la porte ne la couvre pas', () => {
    const text = ciParityText({ command: 'npx playwright test', workflow: 'ci.yml' });
    expect(text).toContain('npx playwright test');
    expect(text).toContain('ci.yml');
    expect(text).toContain('orchestrate.test');
    expect(text).toContain('orchestrate.build');
  });

  const E2E = { '.github/workflows/ci.yml': WF('      - run: npx playwright test\n') };

  it('R13 — verify --gate : la ligne est écrite avant les étapes, la porte est jouée quand même', async () => {
    const repo = project(E2E, 'orchestrate:\n  test: "true"\nverify:\n  inPlace: false\n');
    const cfg = join(repo, 'cadence.yaml');
    const lines: string[] = [];
    const code = await verifyGate({ repo, sha: git(repo, 'rev-parse', 'HEAD'), config: readOrchestrateConfig(cfg), verify: readVerifyConfig(cfg), planFile: '.cadence/raf.yaml', out: (l) => lines.push(l) });
    expect(code).toBe(0);
    const at = lines.findIndex((l) => l.includes('npx playwright test'));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(lines.findIndex((l) => l.startsWith('✓ tests')));
  });

  it('R14 — lead tour : une ligne par projet et par commande, après le tableau ; --json porte le champ ciGaps ; rien sans écart', async () => {
    const parent = tempDir();
    const a = project(E2E);
    const b = project({ '.github/workflows/ci.yml': WF('      - run: npx vitest run\n') });
    for (const [name, src] of [['alpha', a], ['beta', b]] as const) {
      mkdirSync(join(parent, name));
      git(parent, 'clone', '-q', src, join(parent, name, '.'));
    }
    const out: string[] = [];
    const io = { cwd: parent, env: { RAF_TODAY: '2026-10-25' }, out: (l: string) => out.push(l), err: () => {}, now: () => new Date('2026-10-25T10:00:00') };
    expect(await run(['lead', 'tour'], io)).toBe(0);
    const gap = out.filter((l) => l.includes('npx playwright test'));
    expect(gap).toHaveLength(1);
    expect(gap[0]).toMatch(/^alpha · /);
    out.length = 0;
    await run(['lead', 'tour', '--json'], io);
    const rows = JSON.parse(out.join('\n')) as { project: string; ciGaps?: unknown }[];
    expect(rows.find((r) => r.project === 'alpha')!.ciGaps).toEqual([{ command: 'npx playwright test', workflow: 'ci.yml' }]);
    expect(rows.find((r) => r.project === 'beta')!.ciGaps).toBeUndefined();
  });

  it('R15 — orchestrate --dry-run : la ligne est écrite une fois par dépôt, pas par lot', async () => {
    const repo = project(E2E);
    const plan = Plan.load(join(repo, '.cadence/raf.yaml'));
    plan.add('deux', '2026-10-01', { estimate: 1 });
    plan.save();
    git(repo, 'commit', '-q', '-am', 'plan');
    const out: string[] = [];
    const io: OrchestrateIo = { cwd: repo, env: { RAF_TODAY: '2026-10-25' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-10-25T10:00:00') };
    const deps = { claude: async () => claudeOut(reviewReport()), claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR };
    const code = await orchestrate(['L1', 'L2', '--dry-run'], io, deps);
    try {
      expect(code).toBe(0);
      expect(out.filter((l) => l.includes('npx playwright test'))).toHaveLength(1);
    } finally {
      removeDryRunBriefs(out.join('\n'));
    }
  });

  it('R16 — README/docs et CHANGELOG décrivent la parité porte ↔ CI', () => {
    for (const f of ['docs/orchestrate-gate.md', 'docs/lead.md', 'docs/deliver.md', 'CHANGELOG.md']) {
      const text = readFileSync(join(import.meta.dirname, '..', f), 'utf8');
      expect(text, f).toContain('L499');
    }
  });
});
