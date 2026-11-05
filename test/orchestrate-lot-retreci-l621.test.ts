import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { countReview } from '../src/orchestrate/cycle/converge.js';
import { readShrunk } from '../src/orchestrate/cycle/retreci.js';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { parseOrchestrateArgs } from '../src/orchestrate/command-args.js';
import { preflight } from '../src/orchestrate/preflight.js';
import { sealAcceptation } from '../src/orchestrate/accept.js';
import { lotBudget } from '../src/orchestrate/lot-budget.js';
import { Plan } from '../src/plan.js';
import { AGENTS_DIR } from '../src/skills.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { ecritAcceptation } from './accept-helpers.js';
import { tempDir } from './helpers.js';
import type { StepState } from '../src/orchestrate/state.js';

// L621 (issue #40, spec goal-lot-retreci) : un objectif qui rétrécit un lot aux commits déjà intégrés saute la maquette sauf mise en page,
// et les revues jugent le diff de l'objectif contre l'objectif ; un constat hors objectif revient en suite proposée, sans passe de correction.
type K = { gravite: string; texte: string; fichier?: string; ligne?: number; inchange?: unknown };
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const rev = (constats: K[]): Handler => () => {
  const n = (g: string) => constats.filter((k) => k.gravite === g).length;
  return claudeOut(reviewReport({ bloquants: n('bloquant'), majeurs: n('majeur'), mineurs: n('mineur'), constats, verdict: 'non conforme' }));
};
const maj = (texte: string, extra: Partial<K> = {}): K => ({ gravite: 'majeur', texte, ...extra });
const away = maj('hors objectif', { fichier: 'z.txt', ligne: 3, inchange: true });
const suiteCode = (c: { lot: { proposals: string[] } }) => c.lot.proposals.filter((p) => p.startsWith('[suite code]'));
type Script = NonNullable<Parameters<typeof harness>[0]>['script'];
type Lots = NonNullable<Parameters<typeof harness>[0]>['lots'];
const GOAL = 'corriger quatre erreurs de calcul';

/** Un lot dont `old` commits citant L1 sont déjà dans la base avant la première session, comme après une vague précédente intégrée. */
function shrunk(script: Script, over: Record<string, unknown> = {}, o: { old?: number; goal?: string | null; lots?: Lots } = {}) {
  const h = harness({ script, lots: o.lots });
  for (let i = 0; i < (o.old ?? 1); i++) commitFile(h.repo, `old${i}.txt`, 'feat(L1): déjà intégré');
  const c = h.lot('L1', { ...(o.goal === null ? {} : { goal: o.goal ?? GOAL }), ...over });
  return { h, c };
}

const step = (n: number, headBefore?: string): StepState => ({ n, kind: 'implement', model: 'sonnet', status: 'ok', started: '2026-10-04T10:00:00', ...(headBefore ? { headBefore } : {}) });

// ——— Lancement : préflight ———

interface Lot { title: string; estimate?: number; visible?: boolean; screen?: 'page' | 'component' | 'journey'; spec?: boolean; goal?: string }
function project(lots: Lot[], opts: { commits?: number; neighbour?: boolean } = {}): { dir: string } {
  const parent = tempDir();
  const dir = join(parent, 'a');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'a', 'L', '2026-09-01');
  for (const l of lots) plan.add(l.title, '2026-10-01', { estimate: l.estimate ?? 1, visible: l.visible || !!l.screen, screen: l.screen, spec: l.spec });
  if (opts.neighbour) {
    const other = join(parent, 'b');
    mkdirSync(other, { recursive: true });
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'config', 'user.email', 't@example.com');
    git(other, 'config', 'user.name', 'T');
    git(other, 'config', 'commit.gpgsign', 'false');
    commitFile(other, 'n.txt', 'feat(L1): travail du voisin');
    plan.setRepos('L1', [{ path: '../b' }]);
  }
  plan.save();
  const goalLot = lots.find((l) => l.goal);
  if (goalLot) writeFileSync(join(dir, '.cadence/raf.yaml'), readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8').replace('\n    title:', `\n    goal: ${goalLot.goal}\n    title:`));
  writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
  git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
  git(dir, 'commit', '-qm', 'chore: plan');
  for (let i = 0; i < (opts.commits ?? 0); i++) commitFile(dir, `old${i}.txt`, 'feat(L1): déjà intégré');
  return { dir };
}

async function launch(dir: string, goal?: string) {
  const io: OrchestrateIo = { cwd: dir, env: { RAF_TODAY: '2026-10-04', CADENCE_HOME: tempDir() }, out: () => {}, err: () => {}, now: () => new Date('2026-10-04T14:12:00') };
  const deps: OrchestrateDeps = { claude: async () => { throw new Error('pas de session en simulation'); }, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR };
  const r = await preflight({ dryRun: true, ...(goal ? { goal } : {}) }, [{ project: 'a', projectDir: dir, repo: dir, lot: 'L1', model: 'sonnet' }], io, deps, tempDir());
  expect(r.refusals).toEqual([]);
  return r.lots[0]!;
}
const visible: Lot = { title: 'Un composant, suite du constat de revue', estimate: 0.6, visible: true };

describe('R1 — un lot est rétréci par un objectif et un commit déjà intégré', () => {
  it('R1 — objectif donné et un commit du lot dans la base : lot rétréci', async () => {
    const { dir } = project([visible], { commits: 1 });
    const s = await launch(dir, GOAL);
    expect(s.screen).toBeUndefined();
    expect(s.goal).toBe(GOAL);
  });
  it('R1 — goal: du plan sans --goal : même résultat', async () => {
    const { dir } = project([{ ...visible, goal: GOAL }], { commits: 1 });
    const s = await launch(dir);
    expect(s.screen).toBeUndefined();
  });
  it('R1 — objectif sans aucun commit du lot : lot non rétréci', async () => {
    const { dir } = project([visible]);
    const s = await launch(dir, GOAL);
    expect(s.screen).toBe('component');
  });
  it('R1 — commits intégrés seulement dans un dépôt voisin : lot non rétréci', async () => {
    const { dir } = project([visible], { neighbour: true });
    const s = await launch(dir, GOAL);
    expect(s.repos?.length).toBe(1);
    expect(s.screen).toBe('component');
  });
  it('R1 — N du journal compté avant la première session', async () => {
    const { dir } = project([visible], { commits: 3 });
    const s = await launch(dir, GOAL);
    expect(s.screen).toBeUndefined();
    expect(s.steps).toEqual([]);
  });
  it('R1 — lot non visible avec objectif et commit intégré : rétréci (revue R7 applicable), sans étape spec dans les deux cas', async () => {
    const { h, c } = shrunk({ implement: [impl], review: [rev([away])] });
    expect(h.plan().lot('L1').visible).toBeFalsy();
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.code?.conforme).toBe(true);
    expect(suiteCode(c)).toEqual(['[suite code] z.txt:3 — hors objectif']);
  });
});

describe('R2 — un lot rétréci sans mise en page est lancé sans spec ni maquette', () => {
  it('R2 — lot visible rétréci, objectif sans mise en page : aucune session spec ni maquette, première session implement', async () => {
    const { dir } = project([visible], { commits: 1 });
    const s = await launch(dir, GOAL);
    expect(s.screen).toBeUndefined();
    const { h, c } = shrunk({ implement: [impl], 'review-small': [ok], review: [ok] }, { visible: true, small: true }, { lots: [{ title: 'x', visible: true, estimate: 0.6 }] });
    await runLot(c);
    expect(kinds(h)[0]).toBe('implement');
    expect(kinds(h)).not.toContain('spec');
    expect(kinds(h)).not.toContain('maquette');
  });
  it('R2 — la ligne « maquette sautée » est au journal avec le nombre de commits intégrés', async () => {
    const h = harness({ script: { implement: [impl], review: [ok] }, lots: [{ title: 'x', visible: true, estimate: 0.6 }] });
    for (let i = 0; i < 2; i++) commitFile(h.repo, `old${i}.txt`, 'feat(L1): déjà intégré');
    const c = h.lot('L1', { goal: GOAL, visible: true }, { maquette: true });
    const lines: string[] = [];
    h.wave.log = (l) => lines.push(l);
    await runLot(c);
    expect(lines.filter((l) => l.includes('maquette sautée'))).toEqual([expect.stringContaining("maquette sautée : l'objectif rétrécit le lot à 2 commit(s) déjà intégré(s) et ne change pas la mise en page")]);
  });
  it('R2 — sans maquette sautée, aucune ligne au journal', async () => {
    const { h, c } = shrunk({ implement: [impl], review: [ok] });
    const lines: string[] = [];
    h.wave.log = (l) => lines.push(l);
    await runLot(c);
    expect(lines.some((l) => l.includes('maquette sautée'))).toBe(false);
  });
  it('R2 — le budget du lot est celui d\'un lot sans étape spec', async () => {
    const { dir } = project([visible], { commits: 1 });
    const skipped = await launch(dir, GOAL);
    const { dir: dir2 } = project([visible]);
    const ordinary = await launch(dir2, GOAL);
    expect(skipped.budget).toBe(lotBudget(0.6, undefined, false, undefined));
    expect(ordinary.budget).toBeGreaterThan(skipped.budget!);
  });
});

describe('R3 — l\'objectif qui change la mise en page garde la maquette', () => {
  it('R3 — objectif « changer la disposition de la liste » : maquette jouée', async () => {
    const { dir } = project([visible], { commits: 1 });
    const s = await launch(dir, 'changer la disposition de la liste');
    expect(s.screen).toBe('component');
  });
  it('R3 — objectif « corriger quatre erreurs de calcul » : maquette sautée', async () => {
    const { dir } = project([visible], { commits: 1 });
    expect((await launch(dir, GOAL)).screen).toBeUndefined();
  });
  it('R3 — mot de mise en page avec accent ou majuscule (« Écran », « Mise en page ») reconnu', async () => {
    for (const goal of ['Revoir l’Écran des scores', 'Refaire la Mise en page', 'Grille RESPONSIVE', 'Un LAYOUT neuf', 'Nouvelle colonne', 'Affichage du total', 'Maquette à jour']) {
      const { dir } = project([visible], { commits: 1 });
      expect((await launch(dir, goal)).screen, goal).toBe('component');
    }
  });
});

describe('R4 — une acceptation scellée garde la chaîne complète', () => {
  it('R4 — lot rétréci avec acceptation scellée : étape spec conservée', async () => {
    const { dir } = project([{ title: 'Une page', estimate: 0.6, screen: 'component' }], { commits: 1 });
    ecritAcceptation(dir, { lot: 'L1' });
    sealAcceptation(dir, 'docs/specs/prochain-match/acceptation-L1.json');
    git(dir, 'add', '-A', '--', 'docs', 'test');
    git(dir, 'commit', '-qm', 'test(L1): acceptation');
    const s = await launch(dir, GOAL);
    expect(s.screen).toBe('component');
  });
});

describe('R5 — sans objectif, sans commit intégré ou lot spec: true, le choix est celui d\'aujourd\'hui', () => {
  it('R5 — lot visible sans objectif : maquette jouée comme avant', async () => {
    const { dir } = project([visible], { commits: 1 });
    const s = await launch(dir);
    expect(s.screen).toBe('component');
  });
  it('R5 — lot spec: true rétréci : session spec de la fiche back conservée', async () => {
    const { dir } = project([{ title: 'Fiche back', estimate: 0.6, visible: true, spec: true }], { commits: 1 });
    const s = await launch(dir, GOAL);
    expect(s.specLot).toBe(true);
  });
});

describe('R2 — un lot spec: true avec écran suit R2', () => {
  it('R2 — lot spec: true avec écran rétréci, objectif sans mise en page : maquette sautée', async () => {
    const { dir } = project([{ title: 'Page mixte', estimate: 0.6, screen: 'page', spec: true }], { commits: 1 });
    const s = await launch(dir, GOAL);
    expect(s.screen).toBeUndefined();
    expect(s.budget).toBe(lotBudget(0.6, undefined, false, undefined));
  });
});

// ——— Revue ———

describe('R6 — le brief des revues d\'un lot rétréci', () => {
  it('R6 — brief review de rang 1 d\'un lot rétréci : plage de commits, objectif et consigne de marquer inchange: true présents', async () => {
    const { h, c } = shrunk({ implement: [impl], review: [ok] });
    await runLot(c);
    const before = c.lot.steps[0]!.headBefore!;
    const brief = h.calls.find((x) => x.kind === 'review')!.brief;
    expect(brief).toContain(`${before}..HEAD`);
    expect(brief).toContain(GOAL);
    expect(brief).toContain('inchange: true');
  });
  it('R6 — brief review-small de rang 1 d\'un lot rétréci : même consigne', async () => {
    const { h, c } = shrunk({ implement: [impl], 'review-small': [ok] }, { small: true, visible: true });
    await runLot(c);
    const brief = h.calls.find((x) => x.kind === 'review-small')!.brief;
    expect(brief).toContain(`${c.lot.steps[0]!.headBefore}..HEAD`);
    expect(brief).toContain('inchange: true');
  });
  it('R6 — brief d\'un lot non rétréci au rang 1 : aucune consigne (reste vide)', async () => {
    const { h, c } = shrunk({ implement: [impl], review: [ok] }, {}, { old: 0 });
    await runLot(c);
    expect(h.calls.find((x) => x.kind === 'review')!.brief).not.toContain('inchange: true');
  });
  it('R6 — brief de rang 2 d\'un lot rétréci : consigne de marquage de L622 conservée, sans doublon', async () => {
    const { h, c } = shrunk({ implement: [impl], review: [rev([maj('défaut', { fichier: 'a.txt', ligne: 1 })]), ok], fix: [fix('b.txt')] });
    await runLot(c);
    const brief = h.calls.filter((x) => x.kind === 'review')[1]!.brief;
    expect(brief.split('Mark `inchange: true` on every major').length - 1).toBe(1);
    expect(brief).toContain(`${c.lot.steps[0]!.headBefore}..HEAD`);
    expect(brief).toContain('défaut');
  });
});

describe('R7 — la marque vaut dès la revue 1 d\'un lot rétréci', () => {
  it('R7 — lot rétréci, revue 1 avec un majeur inchange: true : lot conforme, aucune passe de correction', async () => {
    const { h, c } = shrunk({ implement: [impl], review: [rev([away])] });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.pass).toBe(0);
    expect(c.lot.code?.conforme).toBe(true);
    expect(c.lot.code?.verdict).toContain('1 majeur sur un point inchangé en suite pour le lead');
  });
  it('R7 — lot rétréci, majeur sans marque : il compte et ouvre la passe', async () => {
    const { h, c } = shrunk({ implement: [impl], review: [rev([maj('sans marque')]), ok], fix: [fix('b.txt')] });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review']);
    expect(suiteCode(c)).toEqual([]);
  });
  it('R7 — lot rétréci, revue de rang 2 : un majeur marqué déjà signalé par la revue 1 compte (fausse marque, converge.ts exige un rang >= 2 : elle ne se joue pas au rang 1, où il n\'y a pas de revue précédente)', async () => {
    const first = maj('premier défaut', { fichier: 'a.txt', ligne: 1 });
    const { h, c } = shrunk({ implement: [impl], review: [rev([first]), rev([{ ...first, inchange: true }]), ok], fix: [fix('b.txt'), fix('c.txt')] });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review']);
    expect(suiteCode(c)).toEqual([]);
    expect(c.lot.warnings.some((w) => w.includes('premier défaut') && w.includes('revue précédente'))).toBe(true);
  });
});

describe('R8 — un bloquant achète toujours une passe', () => {
  it('R8 — lot rétréci, bloquant marqué inchange: true : la passe de correction s\'ouvre', async () => {
    const { h, c } = shrunk({ implement: [impl], review: [rev([{ gravite: 'bloquant', texte: 'perte de données', inchange: true }]), ok], fix: [fix('b.txt')] });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review']);
    expect(suiteCode(c)).toEqual([]);
  });
});

describe('R9 — un majeur mis de côté devient une suite, un majeur dans l\'objectif compte', () => {
  it('R9 — majeur mis de côté d\'un lot rétréci : proposition « [suite code] … » et verdict conforme avec la note', async () => {
    const { c } = shrunk({ implement: [impl], review: [rev([away])] });
    await runLot(c);
    expect(suiteCode(c)).toEqual(['[suite code] z.txt:3 — hors objectif']);
    expect(c.lot.code?.verdict).toMatch(/^conforme, 1 majeur sur un point inchangé en suite pour le lead : hors objectif/);
  });
  it('R9 — majeur dans l\'objectif : il compte', async () => {
    const { h, c } = shrunk({ implement: [impl], review: [rev([maj('une erreur de calcul reste', { fichier: 'a.txt', ligne: 2 })]), ok], fix: [fix('b.txt')] });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review']);
    expect(suiteCode(c)).toEqual([]);
  });
});

describe('R10 — un lot non rétréci garde le comportement de L622', () => {
  it('R10 — lot non rétréci, revue 1 avec un majeur inchange: true : il compte', async () => {
    const { h, c } = shrunk({ implement: [impl], review: [rev([away]), ok], fix: [fix('b.txt')] }, {}, { old: 0 });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review']);
    expect(suiteCode(c)).toEqual([]);
  });
  it('R10 — lot non rétréci, revue 2 : marque valable comme avant', async () => {
    const { h, c } = shrunk({ implement: [impl], review: [rev([maj('premier', { fichier: 'a.txt', ligne: 1 })]), rev([away])], fix: [fix('b.txt')] }, {}, { old: 0 });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review']);
    expect(c.lot.code?.conforme).toBe(true);
    expect(suiteCode(c)).toHaveLength(1);
  });
  it('R10 — lot sans objectif mais avec vieux commits : non rétréci', async () => {
    const { h, c } = shrunk({ implement: [impl], review: [rev([away]), ok], fix: [fix('b.txt')] }, {}, { goal: null });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review']);
  });
});

describe('R11 — les refus de --goal restent ceux de L258', () => {
  it('R11 — --goal sans texte : « --goal attend un texte non vide »', () => {
    expect(() => parseOrchestrateArgs(['a:L1', '--goal', '  '])).toThrow('--goal attend un texte non vide');
  });
  it('R11 — --goal suivi d\'une option : « --goal attend un texte, pas l\'option … »', () => {
    expect(() => parseOrchestrateArgs(['a:L1', '--goal', '--dry-run'])).toThrow("--goal attend un texte, pas l'option --dry-run");
  });
  it('R11 — --goal avec deux lots : refus « --goal s\'applique à un seul lot lancé … »', async () => {
    const io: OrchestrateIo = { cwd: tempDir(), env: {}, out: () => {}, err: () => {}, now: () => new Date('2026-10-04T14:12:00') };
    const deps: OrchestrateDeps = { claude: async () => { throw new Error('non'); }, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR };
    await expect(orchestrate(['a:L1', 'a:L2', '--goal', 'x'], io, deps)).rejects.toThrow('--goal s\'applique à un seul lot lancé : <projet>:<lot> --goal "…" (plusieurs lots : la clé goal: de chacun)');
  });
});

describe('R12 — le rétrécissement est relu dans git, sans champ d\'état', () => {
  it('R12 — lot visible rétréci avec objectif de mise en page (étape spec gardée) : lu rétréci, revue de rang 1 avec marque valable', () => {
    const { h, c } = shrunk({}, { visible: true, screen: 'component' }, { goal: 'changer la disposition de la liste' });
    c.lot.steps.push({ ...step(1, git(h.repo, 'rev-parse', 'HEAD')), kind: 'spec' });
    const s = readShrunk(c);
    expect(s).toEqual({ goal: 'changer la disposition de la liste', from: c.lot.steps[0]!.headBefore });
    const { aside, summary } = countReview(JSON.parse(JSON.stringify(reviewReport({ majeurs: 1, constats: [away], verdict: 'non conforme' }))), 'review', c.lot, 'abc', { shrunk: s });
    expect(aside).toHaveLength(1);
    expect(summary.conforme).toBe(true);
  });
  it('R12 — lot non visible avec goal: et vieux commits : lu rétréci comme par R1', () => {
    const { h, c } = shrunk({});
    c.lot.steps.push(step(1, git(h.repo, 'rev-parse', 'HEAD')));
    expect(readShrunk(c)).toEqual({ goal: GOAL, from: c.lot.steps[0]!.headBefore });
  });
  it('R12 — lot avec goal: sans commit antérieur à headBefore : non rétréci', () => {
    const { h, c } = shrunk({}, {}, { old: 0 });
    c.lot.steps.push(step(1, git(h.repo, 'rev-parse', 'HEAD')));
    expect(readShrunk(c)).toBeUndefined();
  });
  it('R12 — reprise d\'une vague : un lot rétréci le reste, un lot non rétréci ne le devient pas avec les commits de la vague', () => {
    const a = shrunk({});
    a.c.lot.steps.push(step(1, git(a.h.repo, 'rev-parse', 'HEAD')));
    commitFile(a.h.repo, 'w1.txt', 'feat(L1): écrit par la vague');
    expect(readShrunk(a.c)).toBeDefined();
    const b = shrunk({}, {}, { old: 0 });
    b.c.lot.steps.push(step(1, git(b.h.repo, 'rev-parse', 'HEAD')));
    commitFile(b.h.repo, 'w1.txt', 'feat(L1): écrit par la vague');
    commitFile(b.h.repo, 'w2.txt', 'feat(L1): écrit par la vague');
    expect(readShrunk(b.c)).toBeUndefined();
  });
  it('R12 — branche reprise (L311) : des commits non intégrés, ancêtres de headBefore, ne rendent pas le lot rétréci', () => {
    const { h, c } = shrunk({}, {}, { old: 0 });
    git(h.repo, 'checkout', '-q', '-b', 'cadence/w1/a--L1');
    commitFile(h.repo, 'kept.txt', 'feat(L1): vague passée, non intégré');
    c.lot.steps.push(step(1, git(h.repo, 'rev-parse', 'HEAD')));
    c.tree = { dir: h.repo, branch: 'cadence/w1/a--L1', base: 'main', active: false };
    expect(readShrunk(c)).toBeUndefined();
    c.tree.base = 'cadence/w1/a--L1';
    expect(readShrunk(c)).toBeDefined();
  });
  it('R12 — première étape sans headBefore : lu non rétréci', () => {
    const { c } = shrunk({});
    c.lot.steps.push(step(1));
    expect(readShrunk(c)).toBeUndefined();
  });
  it('R12 — lecture git impossible (headBefore absent du dépôt) ou aucune étape : lu non rétréci, sans erreur', () => {
    const { c } = shrunk({});
    expect(readShrunk(c)).toBeUndefined();
    c.lot.steps.push(step(1, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'));
    expect(readShrunk(c)).toBeUndefined();
  });
  it('R12 — sans objectif dans l\'état : lu non rétréci même avec de vieux commits', () => {
    const { h, c } = shrunk({}, {}, { goal: null });
    c.lot.steps.push(step(1, git(h.repo, 'rev-parse', 'HEAD')));
    expect(readShrunk(c)).toBeUndefined();
  });
});
