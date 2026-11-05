import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { orchestrate, type OrchestrateIo } from '../src/orchestrate/command.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { leadLine } from '../src/orchestrate/follow.js';
import { clusterAlert, gateCovers, unverifiedGoal } from '../src/orchestrate/objectif.js';
import { newLot, type WaveState } from '../src/orchestrate/state.js';
import { renderTable } from '../src/orchestrate/table.js';
import { AGENTS_DIR } from '../src/skills.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { gitRepo, removeDryRunBriefs, tempDir } from './helpers.js';

// L632 (issue #42) : un lot dont l'objectif n'a pas pu être vérifié ne ressort pas « prêt » en silence.

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const lire = (f: string) => readFileSync(join(import.meta.dirname, '..', f), 'utf8');
const lot = (over: { title?: string; goal?: string } = {}) => ({ project: 'demo', lot: 'L1', title: 'Un titre ordinaire', ...over });

describe('L632 R1 — alerte : le lot nomme un accès cluster et orchestrate.prodAccess est faux', () => {
  it.each([
    ['kubectl', 'Vérifier avec kubectl get pods'],
    ['port-forward', 'Ouvrir un port-forward vers le service'],
    ['KUBECONFIG', 'Lire KUBECONFIG avant de lancer'],
    ['cluster', 'Contrôler le cluster dark-blue'],
    ['une URL de banc', 'Ouvrir https://banc.example.dev/api et comparer'],
  ])('le titre nomme %s : l\'alerte dit que les sessions démarrent sans accès cluster et le geste', (_nom, title) => {
    const alert = clusterAlert(lot({ title }), false);
    expect(alert).toContain('demo:L1');
    expect(alert).toContain('sans accès cluster');
    expect(alert).toContain('orchestrate.prodAccess: true');
    expect(alert).toContain('à la main');
  });

  it("l'objectif seul (--goal, clé goal:) suffit, et un titre ordinaire ne déclenche rien", () => {
    expect(clusterAlert(lot({ goal: 'Rejouer la sonde puis kubectl rollout status' }), false)).toContain('sans accès cluster');
    expect(clusterAlert(lot(), false)).toBeNull();
    expect(clusterAlert(lot({ title: 'Clusterisation des couleurs' }), false)).toBeNull();
  });

  it('orchestrate.prodAccess vrai : aucune alerte', () => {
    expect(clusterAlert(lot({ title: 'kubectl get pods' }), true)).toBeNull();
  });

  /** Un dépôt de projet `demo` dont le lot L1 porte ce titre ; cadence.yaml déclare prodAccess. */
  function depot(title: string, prodAccess: boolean) {
    const parent = tempDir();
    const repo = gitRepo(parent);
    const cli = (...argv: string[]) => run(argv, { cwd: repo, env: { RAF_TODAY: '2026-10-26' }, out: () => {}, err: () => {}, now: () => new Date('2026-10-26T10:00:00') });
    cli('init', '--project', 'demo');
    cli('add', title);
    writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  precheck: false\n  prodAccess: ${prodAccess}\n`);
    git(repo, 'add', '--', '.cadence/raf.yaml', '.cadence/notes/.gitkeep', '.gitignore', 'cadence.yaml');
    git(repo, 'commit', '-q', '-m', 'plan: L1');
    return parent;
  }
  const deps = { claude: async () => ({ code: 1, stdout: '', stderr: 'x', timedOut: false }), claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), claudeAuth: () => ({ loggedIn: true }), agentsDir: AGENTS_DIR };
  const io = (parent: string, out: string[], err: string[]): OrchestrateIo => ({ cwd: parent, env: { RAF_TODAY: '2026-10-26' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-26T10:00:00') });

  it('--dry-run : l\'alerte est dite sous le lot', async () => {
    const parent = depot('Contrôler le cluster avec kubectl', false);
    const out: string[] = [];
    expect(await orchestrate(['depot:L1', '--dry-run'], io(parent, out, []), deps)).toBe(0);
    const text = out.join('\n');
    const briefs = [...text.matchAll(/^\s*brief : (.+?)\s*$/gm)].map((m) => readFileSync(m[1]!, 'utf8'));
    removeDryRunBriefs(text);
    expect(text).toContain('⚠ depot:L1');
    expect(text).toContain('sans accès cluster');
    // le brief écrit par --dry-run, base d'une délégation à la main, porte la ligne lui aussi
    expect(briefs.length).toBeGreaterThan(0);
    for (const b of briefs) expect(b).toContain('This session has no cluster access');
  });

  it('--dry-run avec prodAccess vrai : aucune alerte', async () => {
    const parent = depot('Contrôler le cluster avec kubectl', true);
    const out: string[] = [];
    await orchestrate(['depot:L1', '--dry-run'], io(parent, out, []), deps);
    const text = out.join('\n');
    removeDryRunBriefs(text);
    expect(text).not.toContain('sans accès cluster');
  });

  it('au lancement : l\'alerte part sur la sortie d\'erreur avant la vague, et le journal de la vague la garde', async () => {
    const parent = depot('Contrôler le cluster avec kubectl', false);
    const err: string[] = [];
    await orchestrate(['depot:L1'], io(parent, [], err), deps);
    expect(err.join('\n')).toContain('sans accès cluster');
    const runs = join(parent, '.cadence/runs');
    const journals = readdirSync(runs).map((w) => join(runs, w, 'journal.log'));
    expect(journals.map((j) => readFileSync(j, 'utf8')).join('\n')).toContain('sans accès cluster');
  });

  it('au lancement avec un titre ordinaire : aucune alerte', async () => {
    const parent = depot('Renommer une variable', false);
    const err: string[] = [];
    await orchestrate(['depot:L1'], io(parent, [], err), deps);
    expect(err.join('\n')).not.toContain('sans accès cluster');
  });
});

describe('L632 R2 — objectif non vérifié : couverture de la porte', () => {
  it('une commande que la porte contient, ou qui la contient, est couverte ; une autre non ; sans porte, rien n\'est couvert', () => {
    expect(gateCovers('npx vitest run', 'npx vitest run')).toBe(true);
    expect(gateCovers('npx vitest run', 'npx  vitest   run test/a.test.ts')).toBe(true);
    expect(gateCovers('npx vitest run test/a.test.ts', 'vitest run')).toBe(false);
    expect(gateCovers('npx vitest run', 'kubectl get pods')).toBe(false);
    expect(gateCovers('npx vitest run', '')).toBe(false);
    expect(gateCovers(undefined, 'npm test')).toBe(false);
    expect(gateCovers([{ dir: 'api', run: 'npm test' }, { dir: 'web', run: 'npx vitest run' }], 'cd web && npx vitest run')).toBe(true);
    expect(gateCovers([{ dir: 'api', run: 'npm test' }], 'kubectl get pods')).toBe(false);
  });

  it('la première ligne de l\'objectif donné, à défaut celle du titre', () => {
    const l = newLot({ project: 'demo', repo: '/r', lot: 'L1', title: 'Titre', goal: 'Première ligne\nsuite', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
    l.testsHorsPorte = 'kubectl get pods';
    expect(unverifiedGoal(l)).toBe('objectif non vérifié : Première ligne');
    delete l.goal;
    expect(unverifiedGoal(l)).toBe('objectif non vérifié : Titre');
  });

  it('un état sans objectif ni titre (écrit avant ce lot) ne plante pas', () => {
    const l = { testsHorsPorte: 'kubectl get pods' } as never;
    expect(unverifiedGoal(l)).toBe('objectif non vérifié : ');
    expect(unverifiedGoal({} as never)).toBeNull();
  });
});

const impl = (over: Record<string, unknown> = {}): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')], ...over }));
const fixOk: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'b.txt', 'fix(L1): b')] }));
const ok: Handler = () => claudeOut(reviewReport());
const rouge = { tests: { commande: 'kubectl get pods', resultat: 'connection refused', vert: false } };

describe('L632 R3 — le rapport d\'implémentation : tests.vert faux avec une commande que la porte ne couvre pas', () => {
  it('porte verte, annonce rouge hors porte : le lot est prêt mais « objectif non vérifié » (tableau, journal, note raf review)', async () => {
    const h = harness({ script: { implement: [impl(rouge)], review: [ok] } });
    const lines: string[] = [];
    h.wave.log = (l) => lines.push(l);
    const c = h.lot('L1', {}, { test: 'true' });
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    const note = 'objectif non vérifié : Un lot, suite du constat de revue';
    expect(c.lot.outcome).toBe(`prêt à livrer — ${note}`);
    expect(lines.find((l) => l.includes('→ ready'))).toContain(note);
    expect(leadLine(lines.find((l) => l.includes('→ ready'))!)).toBe(true);
    expect(h.plan().lot('L1').review?.verdict).toContain(note);
    const wave: WaveState = { id: 'w1', created: '2026-10-04T10:00:00Z', cwd: '/x', budget: 2_000_000, consumed: 0, cacheRead: 0, status: 'done', pid: 1, lots: ['demo:L1'] };
    const table = renderTable(wave, [c.lot]).join('\n');
    expect(table).toContain(`prêt à livrer — ${note}`);
    expect(table).toContain('1 prêt(s) (dont 1 objectif non vérifié)');
  });

  it('annonce rouge MAIS commande de la porte (porte verte) : l\'annonce n\'est pas crue, le lot est prêt tout simplement', async () => {
    const h = harness({ script: { implement: [impl({ tests: { commande: 'true', resultat: 'rouge ?', vert: false } })], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'true' });
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.outcome).toBe('prêt à livrer');
    expect(h.plan().lot('L1').review?.verdict).not.toContain('objectif non vérifié');
  });

  it('tests.vert vrai : aucune mention, même avec une commande hors porte', async () => {
    const h = harness({ script: { implement: [impl({ tests: { commande: 'kubectl get pods', resultat: 'ok', vert: true } })], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'true' });
    await runLot(c);
    expect(c.lot.outcome).toBe('prêt à livrer');
    const wave: WaveState = { id: 'w1', created: '2026-10-04T10:00:00Z', cwd: '/x', budget: 2_000_000, consumed: 0, cacheRead: 0, status: 'done', pid: 1, lots: ['demo:L1'] };
    const table = renderTable(wave, [c.lot]).join('\n');
    expect(table).not.toContain('objectif non vérifié');
    expect(table).toContain('1 prêt(s)');
    expect(table).not.toContain('dont');
  });

  it('sans orchestrate.test, l\'annonce rouge part en correction ; la correction verte lève la mention', async () => {
    const h = harness({ script: { implement: [impl(rouge)], fix: [fixOk], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.outcome).toBe('prêt à livrer');
    expect(c.lot.testsHorsPorte).toBeUndefined();
  });
});

describe('L632 R4 — la dernière revue nomme l\'objectif dans nonVerifie', () => {
  const avec = (nonVerifie: string[]) => harness({ script: { implement: [impl()], review: [() => claudeOut(reviewReport({ nonVerifie }))] } });

  it.each([
    ["objectif : la sonde kubectl n'a pas été jouée"],
    ['goal not checked: no cluster'],
    ["Un lot, suite du constat de revue : jamais joué"],
  ])('« %s » : le lot est prêt mais « objectif non vérifié »', async (entree) => {
    const h = avec([entree]);
    const c = h.lot('L1', {}, { test: 'true' });
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.outcome).toBe('prêt à livrer — objectif non vérifié : Un lot, suite du constat de revue');
    expect(h.plan().lot('L1').review?.verdict).toContain('objectif non vérifié : Un lot, suite du constat de revue');
  });

  it('un nonVerifie qui ne nomme pas l\'objectif, ou une liste vide : prêt tout simplement', async () => {
    for (const nonVerifie of [[], ['le rendu à 390 px'], ['objectivement lent']]) {
      const h = avec(nonVerifie);
      const c = h.lot('L1', {}, { test: 'true' });
      await runLot(c);
      expect(c.lot.outcome, JSON.stringify(nonVerifie)).toBe('prêt à livrer');
    }
  });
});

describe('L632 R5 — chaque brief dit que la session n\'a pas d\'accès cluster', () => {
  it('une session de la vague : le brief porte la ligne, pour chacune des étapes', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'true' });
    await runLot(c);
    for (const call of h.calls) {
      expect(call.brief, call.kind).toContain('This session has no cluster access');
      expect(call.brief, call.kind).toContain('a question to the lead');
    }
  });

  it('avec prodAccess vrai, la ligne n\'y est pas (elle serait fausse)', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'true', prodAccess: true });
    await runLot(c);
    for (const call of h.calls) expect(call.brief, call.kind).not.toContain('no cluster access');
  });
});

describe('L632 — documentation', () => {
  it('README / docs et CHANGELOG décrivent l\'alerte, la mention et la ligne des briefs', () => {
    const docs = lire('docs/orchestrate-cycle.md');
    expect(docs).toContain('objectif non vérifié');
    expect(docs).toContain('sans accès cluster');
    expect(lire('CHANGELOG.md')).toContain('L632');
  });
});
