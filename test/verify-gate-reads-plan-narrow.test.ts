import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { verifyGate } from '../src/verify-gate.js';
import { cleanupTempDirs, gitRepo, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const PLAN = '.cadence/raf.yaml';

interface Opts {
  files?: Record<string, string>;
  gateYaml?: string;
  /** Commande de rejeu : écrit « replay » puis un fichier par ligne dans le journal ; absent : pas de testReplay. */
  replay?: boolean;
  /** Code de sortie du rejeu restreint (défaut 0). */
  replayCode?: number;
  /** Enregistrer la porte de la vague au sha du dessous (défaut : oui). */
  recorded?: boolean;
}

function project(o: Opts): { repo: string; sha: string; mark: string; launch: string } {
  const repo = gitRepo();
  const mark = join(tempDir(), 'ran.log');
  const replay = o.replay ? `  testReplay: printf '%s\\n' replay {files} >> ${mark}; exit ${o.replayCode ?? 0}\n` : '';
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  build: echo build >> ${mark}\n  test: echo tests >> ${mark}\n${replay}${o.gateYaml ?? ''}verify:\n  inPlace: false\n`);
  for (const [p, c] of Object.entries(o.files ?? {})) {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), c);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const launch = tempDir();
  if (o.recorded !== false) {
    const store = RunStore.reserve(launch, '2026-11-03-0830')!;
    store.writeWave({ created: '2026-11-03T08:30:00.000Z', lots: ['p:L9'] } as never);
    const l = newLot({ project: 'p', repo, lot: 'L9', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false });
    const checks: LotState['checks'] = { head: sha, tree: git(repo, 'rev-parse', `${sha}^{tree}`), runs: [{ label: 'build', command: `echo build >> ${mark}`, code: 0 }, { label: 'tests', command: `echo tests >> ${mark}`, code: 0 }] };
    store.writeLot({ ...l, status: 'ready', checks });
  }
  return { repo, sha, mark, launch };
}

function planCommit(repo: string): string {
  mkdirSync(join(repo, '.cadence'), { recursive: true });
  appendFileSync(join(repo, PLAN), 'raf done\n');
  git(repo, 'add', PLAN);
  git(repo, 'commit', '-qm', 'raf done');
  return git(repo, 'rev-parse', 'HEAD');
}

async function gateAbovePlan(o: Opts) {
  const { repo, mark, launch } = project(o);
  const top = planCommit(repo);
  const lines: string[] = [];
  const cfg = join(repo, 'cadence.yaml');
  const code = await verifyGate({ repo, sha: top, config: readOrchestrateConfig(cfg), verify: readVerifyConfig(cfg), launchDirs: [launch], planFile: PLAN, out: (l) => lines.push(l) });
  return { code, text: lines.join('\n'), log: existsSync(mark) ? readFileSync(mark, 'utf8') : '' };
}

const READER = { 'test/plan-page.test.ts': `readFileSync('${PLAN}')\n` };

describe('L566 — sous un commit de plan seul, la porte ne rejoue que les tests qui lisent le plan', () => {
  it('R1 — readsPlan : liste de tests + testReplay + porte enregistrée au sha dessous : seuls ces fichiers sont rejoués, ni build ni suite complète', async () => {
    const r = await gateAbovePlan({ gateYaml: '  gate:\n    readsPlan: [e2e/plan-page.e2e.ts, test/b.test.ts]\n', replay: true });
    expect(r.code).toBe(0);
    expect(r.log).toBe('replay\ne2e/plan-page.e2e.ts\ntest/b.test.ts\n');
    expect(r.text).toContain('verdict repris');
    expect(r.text).toContain('seuls les lecteurs du plan sont rejoués');
    expect(r.text).toContain('verify --gate');
    expect(r.text).toMatch(/: vert/);
  });

  it('R2 — sans déclaration, un test qui cite le plan est détecté : lui seul est rejoué', async () => {
    const r = await gateAbovePlan({ files: { ...READER, 'src/a.ts': 'export const a = 1;\n' }, replay: true });
    expect(r.code).toBe(0);
    expect(r.log).toBe('replay\ntest/plan-page.test.ts\n');
    expect(r.text).toContain('seuls les lecteurs du plan sont rejoués');
  });

  it('R3 — readsPlan: true : les tests détectés sont rejoués seuls', async () => {
    const r = await gateAbovePlan({ files: READER, gateYaml: '  gate:\n    readsPlan: true\n', replay: true });
    expect(r.log).toBe('replay\ntest/plan-page.test.ts\n');
  });

  it('R4 — sans testReplay : la porte entière est rejouée comme avant (L450)', async () => {
    const r = await gateAbovePlan({ files: READER });
    expect(r.log).toBe('build\ntests\n');
    expect(r.text).toContain('verdict rejoué');
  });

  it('R5 — aucune porte enregistrée au sha dessous : la porte entière est rejouée, rien n\'est repris', async () => {
    const r = await gateAbovePlan({ files: READER, replay: true, recorded: false });
    expect(r.log).toBe('build\ntests\n');
    expect(r.text).not.toContain('verdict repris');
  });

  it('R6 — le rejeu restreint rouge : la porte est rouge, même si le verdict du dessous est vert', async () => {
    const r = await gateAbovePlan({ files: READER, replay: true, replayCode: 1 });
    expect(r.code).toBe(1);
    expect(r.text).toContain('✗ tests');
    expect(r.text).toContain('rouge');
  });

  it('R7 — seuls des scripts (hors tests) citent le plan : verdict repris en entier, rien n\'est rejoué, les scripts sont nommés', async () => {
    const r = await gateAbovePlan({ files: { 'skills/reprise/scripts/faits.mjs': `'${PLAN}'\n`, 'scripts/cloture.sh': `cat ${PLAN}\n` } });
    expect(r.code).toBe(0);
    expect(r.log).toBe('');
    expect(r.text).toContain('verdict repris');
    expect(r.text).toContain('skills/reprise/scripts/faits.mjs');
    expect(r.text).toContain('pas un test');
  });

  it('R8 — readsPlan: true mais aucun test détecté (lecteur inconnu) : la porte entière est rejouée par prudence', async () => {
    const r = await gateAbovePlan({ files: { 'scripts/cloture.sh': `cat ${PLAN}\n` }, gateYaml: '  gate:\n    readsPlan: true\n', replay: true });
    expect(r.log).toBe('build\ntests\n');
  });

  it('R9 — un nom de fichier à espace ou apostrophe est cité pour le shell', async () => {
    const r = await gateAbovePlan({ gateYaml: "  gate:\n    readsPlan: [\"test/mon test.test.ts\", \"test/l'a.test.ts\"]\n", replay: true });
    expect(r.log).toBe("replay\ntest/mon test.test.ts\ntest/l'a.test.ts\n");
  });
  it('R10 — un test et un script d\'outillage citent le plan : le test est rejoué, le script est nommé comme non rejoué', async () => {
    const r = await gateAbovePlan({ files: { ...READER, 'skills/cloture/scripts/faits.mjs': `'${PLAN}'\n` }, replay: true });
    expect(r.log).toBe('replay\ntest/plan-page.test.ts\n');
    expect(r.text).toContain('skills/cloture/scripts/faits.mjs');
    expect(r.text).toContain('non rejoué');
  });

  it('R11 — un code applicatif (src) cite le plan en plus d\'un test : la porte entière est rejouée (L482)', async () => {
    const r = await gateAbovePlan({ files: { ...READER, 'src/lit-le-plan.ts': `'${PLAN}'\n` }, replay: true });
    expect(r.log).toBe('build\ntests\n');
  });
});
