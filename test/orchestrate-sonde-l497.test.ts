import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig } from '../src/config.js';
import { runLot, lotSpent } from '../src/orchestrate/cycle.js';
import { renderBrief } from '../src/orchestrate/briefs.js';
import { probeVars } from '../src/orchestrate/probe.js';
import { schemaFor, checkShape } from '../src/orchestrate/schemas.js';
import { readJournals } from '../src/corrections.js';
import { tempDir } from './helpers.js';
import { claudeOut, commitFile, git, harness, probeReport, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { writeJournal, writeWave } from './perf-helpers.js';
import { docText } from './docs-text.js';
import { run } from '../src/cli.js';

const root = join(import.meta.dirname, '..');
const GATE = { code: ['*.ts'], tests: ['*.spec.ts'], except: [] as string[], threshold: 1 };
const impl = (...files: string[]): Handler => (call) => claudeOut(workReport({ commits: files.map((f) => commitFile(call.opts.cwd, f, `feat(L1): ${f}`)) }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const probe = (file = 'p.spec.ts', over: Record<string, unknown> = {}, tokens = {}): Handler => (call) => claudeOut(probeReport({ commits: [commitFile(call.opts.cwd, file, `probe(L1): ${file}`)], ...over }), tokens);
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const warnings = (c: { lot: { warnings: string[] } }) => c.lot.warnings.join('\n');
/** Porte de tests du programme : rouge, avec un test nommé, dès que le fichier de la sonde existe, jusqu'à ce qu'une correction pose fixed.flag. */
const REDGATE = 'if [ -f p.spec.ts ] && [ ! -f fixed.flag ]; then echo "FAIL  p.spec.ts > vide > rejette"; exit 1; fi';
const SYNC = 'docs:\n  sync:\n    - paths: [src-*.txt]\n      docs: [README.md]\n';

function configFile(yaml: string): string {
  const file = join(tempDir(), 'cadence.yaml');
  writeFileSync(file, yaml);
  return file;
}

describe('sonde de cas limites (L497)', () => {
  it('R1 — sans orchestrate.probe, le lot passe de implement à review sans session probe', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(JSON.stringify(c.lot)).not.toContain('probe');
    expect(warnings(c)).not.toContain('sonde');
  });

  it('R1 — probe: false se lit comme la clé absente', async () => {
    expect(readOrchestrateConfig(configFile('orchestrate:\n  probe: false\n')).probe).toBeFalsy();
    const h = harness({ script: { implement: [impl('a.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: false });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(JSON.stringify(c.lot)).not.toContain('probe');
  });

  it('R2 — probe: true est lu, une autre valeur est refusée avec le message exact', () => {
    const file = configFile('orchestrate:\n  probe: true\n');
    expect(readOrchestrateConfig(file).probe).toBe(true);
    for (const bad of ['"oui"', '1', '"true"', '[]', '{}']) {
      const f = configFile(`orchestrate:\n  probe: ${bad}\n`);
      expect(() => readOrchestrateConfig(f), bad).toThrow(`${f} : orchestrate.probe : true ou false attendu`);
    }
    expect(readOrchestrateConfig(configFile('orchestrate:\n  precheck: true\n')).probe).toBeUndefined();
    expect(readOrchestrateConfig(configFile('orchestrate:\n  probe:\n')).probe).toBeUndefined(); // clé vide = absente, comme les autres clés
  });

  it('R2 — le cadence.yaml de cadence pose orchestrate.probe: true', () => {
    expect(readOrchestrateConfig(join(root, 'cadence.yaml')).probe).toBe(true);
  });

  it('R2 — effort.probe vaut medium par défaut et se règle comme les autres étapes', () => {
    expect(readOrchestrateConfig('/nope').effort.probe).toBe('medium');
    expect(readOrchestrateConfig(configFile('orchestrate:\n  effort: { probe: high }\n')).effort.probe).toBe('high');
    const f = configFile('orchestrate:\n  effort: { probe: enorme }\n');
    expect(() => readOrchestrateConfig(f)).toThrow('effort.probe');
  });

  it("R2 — la session probe reçoit le délai de l'écriture (timeouts.work) et n'est pas en lecture seule : coupée, elle n'est pas relancée", async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe()], review: [ok] } });
    await runLot(h.lot('L1', {}, { probe: true }));
    const [i, p] = [h.calls[0], h.calls[1]];
    expect(p.kind).toBe('probe');
    expect(p.opts.timeoutMs).toBe(i.opts.timeoutMs);
    expect(p.args).not.toContain('--agent');
    const cut: Handler = () => ({ code: 143, stdout: '', stderr: 'Terminated', timedOut: false });
    const h2 = harness({ script: { implement: [impl('a.ts')], probe: [cut], review: [ok] } });
    await runLot(h2.lot('L1', {}, { probe: true }));
    expect(h2.calls.filter((c) => c.kind === 'probe')).toHaveLength(1);
  });

  it('R3 — la sonde joue après la porte « code sans test » et avant la revue', async () => {
    const h = harness({ script: { implement: [impl('a.ts', 'a.spec.ts')], probe: [probe()], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, testGate: GATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(c.lot.probe).toBe(true);
    // la porte passe avant : du code sans test part en correction, la sonde ne joue pas sur cette passe
    const h2 = harness({ script: { implement: [impl('a.ts')], fix: [fix('a.spec.ts')], review: [ok] } });
    const c2 = h2.lot('L1', {}, { probe: true, testGate: GATE });
    await runLot(c2);
    expect(kinds(h2)).toEqual(['implement', 'fix', 'review']);
  });

  it('R3 — un lot sans commit ou en passe des mineurs ne joue pas la sonde', async () => {
    const none: Handler = () => claudeOut(workReport());
    const h = harness({ script: { implement: [none] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(kinds(h)).toEqual(['implement']);
    const h2 = harness({ script: { fix: [fix('b.ts')], 'review-small': [ok] } });
    const c2 = h2.lot('L1', {}, { probe: true });
    commitFile(h2.repo, 'a.ts', 'feat(L1): a');
    c2.lot.minorPass = true;
    c2.lot.minorFix = true;
    c2.lot.constats = [{ source: 'code', gravite: 'mineur', fichier: 'a.ts', ligne: 1, texte: 'nommage' }];
    c2.lot.next = 'fix';
    await runLot(c2);
    expect(kinds(h2)).toEqual(['fix', 'review-small']);
    expect(warnings(c2)).not.toContain('sonde');
  });

  it('R3 — une reprise après la sonde ne la rejoue pas', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe()], fix: [fix('fixed.flag')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, test: REDGATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'fix', 'review']);
    expect(c.lot.probe).toBe(true);
    const h2 = harness({ script: { implement: [impl('a.ts')], review: [ok] } });
    await runLot(h2.lot('L1', { probe: true }, { probe: true }));
    expect(kinds(h2)).toEqual(['implement', 'review']);
  });

  it('R4 — un test rouge de la sonde produit une passe fix avec un constat « sonde de cas limites : »', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe('p.spec.ts', { echecs: ['p.spec.ts > vide > rejette — borne : entrée vide — attendu : une erreur'] })], fix: [fix('fixed.flag')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, test: REDGATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'fix', 'review']);
    const brief = h.calls[2].brief;
    expect(brief).toContain('sonde de cas limites : ');
    expect(brief).toContain('p.spec.ts > vide > rejette');
    expect(brief).toContain('borne : entrée vide');
    expect(brief).toContain('[majeur / tests]');
    expect(c.lot.pass).toBe(1);
    expect(c.lot.status).toBe('ready');
  });

  it('R4 — tous les tests de la sonde verts : la revue part sans passe fix', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe('q.spec.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, test: REDGATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(c.lot.pass).toBe(0);
    expect(git(h.repo, 'log', '--format=%s')).toContain('probe(L1): q.spec.ts');
  });

  it("R4 — un échec déjà rouge à la ligne de base n'est pas un constat de la sonde", async () => {
    const old = 'echo "FAIL  old.spec.ts > ancien"; exit 1';
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe('q.spec.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, test: old });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(c.lot.pass).toBe(0);
  });

  it('R5 — avec orchestrate.test, les rouges viennent de la porte et non du rapport', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe('q.spec.ts', { echecs: ['fantôme.spec.ts > inventé'] })], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, test: REDGATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(warnings(c)).not.toContain('non vérifié par le programme (orchestrate.test absent)');
  });

  it('R5 — sans orchestrate.test, les échecs annoncés partent en correction avec le warning exact', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe('p.spec.ts', { echecs: ['p.spec.ts > vide > rejette'] })], fix: [fix('b.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'fix', 'review']);
    expect(h.calls[2].brief).toContain('sonde de cas limites : p.spec.ts > vide > rejette');
    expect(c.lot.warnings).toContain('sonde de cas limites : échecs annoncés par la session, non vérifié par le programme (orchestrate.test absent)');
  });

  it('R6 — la sonde déclenche une passe comptée dans l.pass', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe()], fix: [fix('fixed.flag')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, test: REDGATE });
    await runLot(c);
    expect(c.lot.pass).toBe(1);
  });

  it('R6 — avec une passe déjà faite, la sonde n\'est pas jouée et un warning le dit', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], review: [ok] } });
    const c = h.lot('L1', { pass: 1 }, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.warnings.some((w) => w.startsWith('sonde de cas limites non jouée : 1 passe(s) de correction déjà faite(s) ou budget du lot ('))).toBe(true);
    expect(c.lot.probe).toBe(true);
  });

  it('R6 — un budget trop court pour la sonde, la correction et la revue : pas de sonde, un warning', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], review: [ok] } });
    const c = h.lot('L1', { budget: 200_000 }, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(warnings(c)).toContain('sonde de cas limites non jouée : 0 passe(s) de correction déjà faite(s) ou budget du lot (');
    // un budget qui paie les trois : la sonde joue
    const h2 = harness({ script: { implement: [impl('a.ts')], probe: [probe('q.spec.ts')], review: [ok] } });
    await runLot(h2.lot('L1', { budget: 400_000 }, { probe: true }));
    expect(kinds(h2)).toEqual(['implement', 'probe', 'review']);
  });

  it('R6 — les tokens de la session probe entrent dans la dépense du lot', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe('q.spec.ts', {}, { cacheWrite: 7000 })], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    const step = c.lot.steps.find((s) => s.kind === 'probe')!;
    expect(step.tokens?.counted).toBe(100 + 7000 + 400);
    expect(lotSpent(c.lot)).toBe(1500 + 7500 + 1500);
  });

  it('R6 — après une passe sonde, le bibliothécaire n\'est pas appelé et le warning le dit', async () => {
    const h = harness({ script: { implement: [impl('src-a.txt')], probe: [probe()], fix: [fix('fixed.flag')], review: [ok] } });
    writeFileSync(join(h.repo, 'cadence.yaml'), SYNC);
    git(h.repo, 'add', '--', 'cadence.yaml');
    git(h.repo, 'commit', '-q', '-m', 'chore(L1): docs.sync', '--', 'cadence.yaml');
    const c = h.lot('L1', {}, { probe: true, test: REDGATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'fix', 'review']);
    expect(warnings(c)).toContain('bibliothécaire non appelé : 1 passe(s) de correction déjà faite(s)');
  });

  it('R4 — une sonde qui ne commite rien ne rejoue pas la porte du programme ; avec un commit, elle la rejoue', async () => {
    const count = join(tempDir(), 'runs.txt');
    const gate = `echo x >> ${count}`;
    const none: Handler = () => claudeOut(probeReport());
    const h = harness({ script: { implement: [impl('a.ts')], probe: [none], review: [ok] } });
    await runLot(h.lot('L1', {}, { probe: true, test: gate }));
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(1);
    const count2 = join(tempDir(), 'runs.txt');
    const h2 = harness({ script: { implement: [impl('a.ts')], probe: [probe('q.spec.ts')], review: [ok] } });
    await runLot(h2.lot('L1', {}, { probe: true, test: `echo x >> ${count2}` }));
    expect(readFileSync(count2, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('R4 — la passe de correction déclenchée par la sonde laisse une trace au journal du lot', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe()], fix: [fix('fixed.flag')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, test: REDGATE });
    await runLot(c);
    expect(c.lot.warnings).toContain('sonde de cas limites : 1 constat(s), passe de correction avant la revue');
  });

  it('R5 — sans orchestrate.test et sans échec annoncé, la sonde ne produit ni warning de porte ni correction', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe('q.spec.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(warnings(c)).not.toContain('non vérifié');
  });

  it('R6 — un budget qui paie la sonde mais plus la correction après elle : la revue part avec un warning qui liste les rouges', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe('p.spec.ts', {}, { cacheWrite: 100_000 })], review: [ok] } });
    const c = h.lot('L1', { budget: 250_000 }, { probe: true, test: REDGATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.warnings.some((w) => w.startsWith('sonde de cas limites : correction non jouée (budget du lot') && w.includes('p.spec.ts > vide > rejette'))).toBe(true);
  });

  it('R8 — sans testGate déclaré, un commit de la sonde ne déclenche pas le warning « hors tests »', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe('app.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(warnings(c)).not.toContain('hors tests');
  });

  it("R8 — un lot qui a une fiche : le brief probe la nomme ; sans fiche, aucune mention", async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe('q.spec.ts')], review: [ok] } });
    mkdirSync(join(h.repo, 'docs/specs/sujet'), { recursive: true });
    writeFileSync(join(h.repo, 'docs/specs/sujet/fiche.yaml'), 'sujet:\n  id: sujet\n  lot: L1\n');
    git(h.repo, 'add', '--', 'docs/specs/sujet/fiche.yaml');
    git(h.repo, 'commit', '-q', '-m', 'spec(L1): fiche', '--', 'docs/specs/sujet/fiche.yaml');
    await runLot(h.lot('L1', {}, { probe: true }));
    expect(h.calls[1].brief).toContain('docs/specs/sujet/fiche.yaml');
    const sans = harness({ script: { implement: [impl('a.ts')], probe: [probe('q.spec.ts')], review: [ok] } });
    await runLot(sans.lot('L1', {}, { probe: true }));
    expect(sans.calls[1].brief).not.toContain('spec sheet');
    expect(probeVars(null, '', undefined, 'L1').diff).toContain('git log -p');
    expect(probeVars('f.yaml', 'c', 'abc', 'L1')).toMatchObject({ diff: 'git diff abc..HEAD', commits: 'c' });
  });

  it('R7 — la session probe tourne sur Sonnet même pour un lot Opus', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe('q.spec.ts')], review: [ok] } });
    const c = h.lot('L1', { model: 'opus' }, { probe: true });
    await runLot(c);
    expect(h.calls[0].model).toBe('opus');
    expect(h.calls[1].kind).toBe('probe');
    expect(h.calls[1].model).toBe('sonnet');
    expect(h.calls[1].effort).toBe('medium');
  });

  it('R7 — le rapport probe sans champ echecs est refusé par le schéma', async () => {
    const schema = schemaFor('probe') as { required: readonly string[]; properties: Record<string, { type: string }> };
    expect(schema.required).toEqual(expect.arrayContaining(['commits', 'echecs', 'nonVerifie', 'questions', 'resume']));
    const { echecs: _e, ...sans } = probeReport();
    expect(() => checkShape(sans, schema)).toThrow('champ « echecs » absent');
    const h = harness({ script: { implement: [impl('a.ts')], probe: [() => claudeOut(sans)], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(warnings(c)).toContain('sonde de cas limites non jouée : sortie structurée : champ « echecs » absent');
  });

  it('R7 — le journal du lot garde l\'étape probe avec ses tokens', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe('q.spec.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    const saved = h.store.readLot('demo', 'L1')!;
    const step = saved.steps.find((s) => s.kind === 'probe')!;
    expect(step).toMatchObject({ kind: 'probe', model: 'sonnet', status: 'ok' });
    expect(step.tokens?.counted).toBeGreaterThan(0);
    expect(step.commits).toHaveLength(1);
  });

  it('R7 — cadence corrections lit une passe fix issue de la sonde (texte « sonde de cas limites : ») et la classe sans erreur', () => {
    const runs = join(tempDir(), 'runs');
    writeWave(runs, 'w1');
    writeJournal(runs, 'w1', 'alpha', 'L1', { steps: [{ kind: 'implement' }, { kind: 'probe' }, { kind: 'fix', constats: undefined }, { kind: 'review' }] });
    const [j] = readJournals(runs);
    expect(j.steps.map((s) => s.kind)).toEqual(['implement', 'probe', 'fix', 'review']);
    expect(j.passes).toHaveLength(1);
    expect(j.passes[0].findings).toEqual([]);
  });

  it('R7 — cadence corrections ne casse pas sur un journal contenant steps[].kind = probe', () => {
    const runs = join(tempDir(), 'runs');
    writeWave(runs, 'w1');
    writeJournal(runs, 'w1', 'alpha', 'L1', { steps: [{ kind: 'implement' }, { kind: 'probe', counted: 7000 }, { kind: 'review', constats: ['x'] }, { kind: 'fix' }] });
    const [j] = readJournals(runs);
    expect(j.steps.find((s) => s.kind === 'probe')?.counted).toBe(7000);
    expect(j.passes[0].findings).toEqual(['x']);
  });

  it("R7 — cadence perf compte l'étape probe à part", async () => {
    const dir = tempDir();
    const runs = join(dir, '.cadence', 'runs');
    writeWave(runs, 'w1', '2026-10-01T08:00:00.000Z');
    const at = (d: string, t: string) => `${d}T${t}.000Z`;
    for (const lot of ['L1', 'L2', 'L3', 'L4', 'L5']) {
      writeJournal(runs, 'w1', 'alpha', lot, { steps: [
        { kind: 'implement', status: 'ok', started: at('2026-10-14', '08:00:00'), ended: at('2026-10-14', '08:10:00'), counted: 40_000 },
        { kind: 'probe', status: 'ok', started: at('2026-10-14', '08:10:00'), ended: at('2026-10-14', '08:14:00'), counted: 12_000 },
        { kind: 'review', status: 'ok', started: at('2026-10-14', '08:14:00'), ended: at('2026-10-14', '08:20:00'), counted: 30_000 },
      ] });
    }
    const out: string[] = [];
    await run(['perf', '--json'], { cwd: dir, env: { RAF_TODAY: '2026-10-16' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-10-16T10:00:00') });
    const data = JSON.parse(out.join('\n'));
    expect(Object.keys(data.durations)).toEqual(expect.arrayContaining(['implement', 'probe', 'review']));
    expect(data.durations.probe.current).toBeCloseTo(4);
    expect(data.durations.implement.current).toBeCloseTo(10);
  });

  it('R8 — le brief probe cite les sept bornes et la fiche', () => {
    const text = readFileSync(join(root, 'templates/orchestrate/probe.md'), 'utf8');
    for (const b of ['empty', 'absent', 'twice', 'wrong type', 'refused', 'real shape of the data', 'other callers']) expect(text, b).toContain(b);
    expect(text).toContain('{{fiche}}');
  });

  it('R8 — le brief probe interdit de modifier le code applicatif et les tests scellés', () => {
    const text = readFileSync(join(root, 'templates/orchestrate/probe.md'), 'utf8');
    expect(text).toMatch(/do not modify the application code/i);
    expect(text).toContain('acceptation-<lot>.json');
  });

  it('R8 — un commit de la sonde sur un fichier hors tests écrit un warning nommé', async () => {
    const h = harness({ script: { implement: [impl('a.ts', 'a.spec.ts')], probe: [probe('app.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true, testGate: GATE });
    await runLot(c);
    expect(c.lot.warnings).toContain('sonde de cas limites : la session a modifié du code hors tests (app.ts)');
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(git(h.repo, 'log', '--format=%s')).toContain('probe(L1): app.ts');
    // un test de la sonde ne déclenche pas le warning
    const h2 = harness({ script: { implement: [impl('a.ts', 'a.spec.ts')], probe: [probe('p.spec.ts')], review: [ok] } });
    const c2 = h2.lot('L1', {}, { probe: true, testGate: GATE });
    await runLot(c2);
    expect(warnings(c2)).not.toContain('hors tests');
  });

  it('R8 — le brief probe se rend sans accolade restante, avec et sans fiche', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe('q.spec.ts')], review: [ok] } });
    await runLot(h.lot('L1', {}, { probe: true }));
    const brief = h.calls[1].brief;
    expect(brief).not.toMatch(/\{\{/);
    expect(brief).toContain('L1');
    const vars = { chemin: '/r', lot: 'L1', titre: 't', objectif: 'o', commits: '', reponse: '', constats: '', ux: '', choix: '', checks: '', news: '', captures: '', diff: 'git diff abc..HEAD' };
    expect(renderBrief('probe', vars)).not.toMatch(/\{\{/);
    expect(() => renderBrief('probe', { ...vars, diff: undefined })).toThrow('valeur manquante pour {{diff}}');
  });

  it('R8 — le brief probe renvoie au diff par commande et ne le colle pas', async () => {
    const big: Handler = (call) => {
      writeFileSync(join(call.opts.cwd, 'gros.ts'), `// MARQUEUR_UNIQUE_DU_DIFF\n${'const x = 1;\n'.repeat(500)}`);
      git(call.opts.cwd, 'add', '--', 'gros.ts');
      git(call.opts.cwd, 'commit', '-q', '-m', 'feat(L1): gros', '--', 'gros.ts');
      return claudeOut(workReport({ commits: [{ sha: git(call.opts.cwd, 'rev-parse', 'HEAD'), sujet: 'feat(L1): gros' }] }));
    };
    const h = harness({ script: { implement: [big], probe: [probe('q.spec.ts')], review: [ok] } });
    await runLot(h.lot('L1', {}, { probe: true }));
    const brief = h.calls[1].brief;
    expect(brief).toMatch(/git diff [0-9a-f]{7,40}\.\.HEAD/);
    expect(brief).not.toContain('MARQUEUR_UNIQUE_DU_DIFF');
    expect(brief.length).toBeLessThan(12_000);
  });

  it('R9 — une session probe en échec laisse partir la revue avec le warning exact', async () => {
    const fail: Handler = () => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false });
    const h = harness({ script: { implement: [impl('a.ts')], probe: [fail], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(c.lot.status).toBe('ready');
    const step = c.lot.steps.find((s) => s.kind === 'probe')!;
    expect(step.status).toBe('failed');
    expect(c.lot.warnings).toContain(`sonde de cas limites non jouée : ${step.cause}`);
  });

  it('R9 — un quota pendant la sonde suspend la vague et la reprise la rejoue', async () => {
    const quota: Handler = () => ({ code: 1, stdout: JSON.stringify({ is_error: true, subtype: 'success', result: 'Claude AI usage limit reached|1759600000', session_id: 's', num_turns: 1, duration_ms: 1, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } }), stderr: '', timedOut: false });
    const h = harness({ script: { implement: [impl('a.ts')], probe: [quota, probe('q.spec.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(c.lot.status).toBe('suspended');
    expect(c.lot.next).toBe('probe');
    h.wave.quota = { hit: false };
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'probe', 'review']);
    expect(c.lot.status).toBe('ready');
  });

  it('R9 — une question du rapport probe devient un warning, aucune attente', async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe('q.spec.ts', { questions: ['Faut-il refuser le vide ?'] })], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(c.lot.warnings.some((w) => w.startsWith('sonde de cas limites : question sans réponse') && w.includes('Faut-il refuser le vide ?'))).toBe(true);
  });

  it('R10 — docs/orchestrate.md et README.md citent orchestrate.probe', () => {
    expect(readFileSync(join(root, 'docs/orchestrate.md'), 'utf8')).toContain('orchestrate.probe');
    // le README est une page d'accueil sans clé de configuration (test L232) : il renvoie à la section de la page docs/ qui la décrit
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('docs/orchestrate.md#the-edge-case-probe-orchestrateprobe-l497');
    expect(readFileSync(join(root, 'docs/orchestrate.md'), 'utf8')).toContain('## The edge-case probe (`orchestrate.probe`, L497)');
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain('orchestrate.probe');
    expect(docText()).toContain('L430');
  });
});
