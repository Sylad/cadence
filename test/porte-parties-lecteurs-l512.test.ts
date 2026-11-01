import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { verifyGate } from '../src/verify-gate.js';
import { ecritAcceptation } from './accept-helpers.js';
import { fakeRemote } from './fake-ssh.js';
import { acceptReport, claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { ecrit } from './spec-helpers.js';
import { cleanupTempDirs, gitRepo, tempDir } from './helpers.js';

// L512 (fiche docs/specs/rejeu-porte-composee) : les lecteurs de orchestrate.test en liste de parties — la porte du lot et sa ligne de base (R3–R6, R8), le contrôle de la session accept et le message de porte verte (R9),
// cadence verify --gate (R6, R9) et la porte déportée (R9). Les lanceurs sont des `gate.sh` dans `backend/` et `frontend/`, joués par « cd <dir> && sh gate.sh », donc depuis leur dossier (« ../a.txt » est le fichier commité par le lot).

afterEach(cleanupTempDirs);

const impl = (over: Record<string, unknown> = {}): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')], ...over }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const LABEL = 'backend : sh gate.sh ; frontend : sh gate.sh';
const lines = (log: string): string[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);

/** Les deux parties déclarées : backend sans replay (sauf `backReplay`), frontend avec. */
const parts = (o: { backReplay?: boolean } = {}) => ({ test: [{ dir: 'backend', run: 'sh gate.sh', ...(o.backReplay ? { replay: 'sh gate.sh {files}' } : {}) }, { dir: 'frontend', run: 'sh gate.sh', replay: 'sh gate.sh {files}' }] });

/** Pose et commite `backend/gate.sh` et `frontend/gate.sh` dans le dépôt du harnais (le sha de départ les a donc aussi). */
function scripts(repo: string, s: { backend: string; frontend: string }): void {
  for (const [dir, text] of Object.entries(s)) {
    mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, dir, 'gate.sh'), `${text}\n`);
  }
  git(repo, 'add', '--', 'backend/gate.sh', 'frontend/gate.sh');
  git(repo, 'commit', '-q', '-m', 'chore: portes par partie');
}

/** Un lanceur : vert avant le lot (pas de ../a.txt), rouge sur `fail` dans la suite entière, `alone` décide du rejeu (vert avec le fichier dans la sortie, ou rouge) ; chaque appel écrit son dossier et ses arguments dans `log`. */
const launcher = (log: string, fail: string, alone: 'vert' | 'rouge' | 'aucun' = 'vert', fixed = '') =>
  `echo "$PWD $@" >> ${log}; [ -f ../a.txt ] || exit 0; ${fixed ? `[ -f ../${fixed} ] && exit 0; ` : ''}if [ -n "$1" ]; then ${alone === 'vert' ? 'echo " ✓ $@ (1 test)"; exit 0' : `echo " FAIL  ${fail}"; exit 1`}; fi; echo " FAIL  ${fail}"; exit 1`;

describe('L512 R3/R4 — la porte du lot en parties : chaque partie dans son dossier, chaque rouge rejoué par sa partie', () => {
  it('R3/R4 — rouge du frontend vert rejoué seul dans frontend : instable, pas de correction ; le CheckRun porte le libellé « dir : run ; … » (R9)', async () => {
    const log = join(tempDir(), 'rejeux.log');
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    scripts(h.repo, { backend: 'exit 0', frontend: launcher(log, 'src/x.spec.ts > charge') });
    const c = h.lot('L1', {}, parts());
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.instables).toEqual(['src/x.spec.ts > charge']);
    const replays = lines(log).filter((l) => / src\/x\.spec\.ts$/.test(l));
    expect(replays).toHaveLength(1); // un seul rejeu, vert, dans le dossier de la partie
    expect(replays[0]).toMatch(/\/frontend src\/x\.spec\.ts$/);
    expect(c.lot.checks?.runs.map((r) => [r.label, r.command, r.code])).toContainEqual(['tests', LABEL, 0]);
  });
  it('R3/R8 — backend rouge SANS replay : son rouge est compté, jamais rejoué ; le frontend est quand même lancé et son rouge de charge est instable', async () => {
    const log = join(tempDir(), 'rejeux.log');
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    scripts(h.repo, { backend: launcher(log, 'src/b.spec.ts > bug', 'aucun', 'b.txt'), frontend: launcher(log, 'src/x.spec.ts > charge') });
    const c = h.lot('L1', {}, parts());
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(h.calls[1].brief).toContain('src/b.spec.ts > bug');
    expect(h.calls[1].brief).not.toMatch(/^- src\/x\.spec\.ts > charge/m);
    expect(h.calls[1].brief).toContain(`${LABEL} en échec (code 1)`);
    expect(c.lot.instables).toEqual(['src/x.spec.ts > charge']);
    const all = lines(log);
    expect(all.filter((l) => /\/backend /.test(l) && !/\/backend $/.test(l))).toEqual([]); // backend : jamais d'argument, donc jamais rejoué
    expect(all.some((l) => /\/frontend src\/x\.spec\.ts$/.test(l))).toBe(true); // R8 : lancé malgré le backend rouge, et rejoué chez lui
    // R6 (D2) : la ligne de base en parties garde le libellé comme clé de cache, et a joué chaque partie une fois dans le worktree du sha de départ
    expect(c.lot.baseline).toMatchObject({ command: LABEL, verified: true, failures: [] });
    expect(all.filter((l) => /cadence-baseline-[^ ]*\/backend $/.test(l))).toHaveLength(1);
    expect(all.filter((l) => /cadence-baseline-[^ ]*\/frontend $/.test(l))).toHaveLength(1);
  });
  it('R3 — dossier d\'une partie introuvable : porte rouge, le constat nomme le dossier, rien n\'est rejoué', async () => {
    const log = join(tempDir(), 'rejeux.log');
    const mk: Handler = (call) => {
      mkdirSync(join(call.opts.cwd, 'nope'), { recursive: true });
      return fix('nope/.keep')(call);
    };
    const h = harness({ script: { implement: [impl()], fix: [mk], review: [ok] } });
    const c = h.lot('L1', {}, { test: [{ dir: 'nope', run: 'true', replay: `echo rejoue >> ${log}; true {files}` }] });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'review']);
    expect(h.calls[1].brief).toMatch(/nope : true en échec \(code [1-9]\d*\)/);
    expect(h.calls[1].brief).toContain('nope');
    expect(existsSync(log)).toBe(false);
    expect(c.lot.instables ?? []).toEqual([]);
  });
  it('R3 — BLOQUANT revue : une partie rouge SANS test nommé (erreur de compilation) n\'est jamais excusée par les instables d\'une autre partie', async () => {
    const log = join(tempDir(), 'rejeux.log');
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    scripts(h.repo, { backend: `[ -f ../a.txt ] || exit 0; [ -f ../b.txt ] && exit 0; echo "Error: type error in src/foo.ts"; exit 1`, frontend: launcher(log, 'src/x.spec.ts > charge') });
    const c = h.lot('L1', {}, parts());
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(h.calls[1].brief).toContain('type error in src/foo.ts');
    expect(h.calls[1].brief).not.toMatch(/instables, à ne pas corriger/); // rien n'est tenu pour instable tant qu'une partie échoue sans nommer de test
  });
});

describe('L512 R5 — nom imprimé rouge par deux parties : rejoué dans chacune, vert seulement si toutes le voient vert', () => {
  const SAME = 'src/a.spec.ts > same';
  it('R5 — backend (replay) rouge au rejeu, frontend vert au rejeu : reste rouge, la correction a lieu, jamais instable', async () => {
    const log = join(tempDir(), 'rejeux.log');
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    scripts(h.repo, { backend: launcher(log, SAME, 'rouge', 'b.txt'), frontend: launcher(log, SAME, 'vert', 'b.txt') });
    const c = h.lot('L1', {}, parts({ backReplay: true }));
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(h.calls[1].brief).toContain(SAME);
    expect(c.lot.instables ?? []).toEqual([]);
    const replays = lines(log).filter((l) => / src\/a\.spec\.ts$/.test(l) && !/cadence-baseline/.test(l));
    expect(replays.some((l) => /\/backend src/.test(l))).toBe(true);
    expect(replays.some((l) => /\/frontend src/.test(l))).toBe(true);
  });
  it('R5 — vert au rejeu des deux parties : instable, pas de correction', async () => {
    const log = join(tempDir(), 'rejeux.log');
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    scripts(h.repo, { backend: launcher(log, SAME), frontend: launcher(log, SAME) });
    const c = h.lot('L1', {}, parts({ backReplay: true }));
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.instables).toEqual([SAME]);
  });
  it('R5 — backend SANS replay imprime le même nom, frontend le voit vert au rejeu : reste rouge (le faux vert guetté)', async () => {
    const log = join(tempDir(), 'rejeux.log');
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    scripts(h.repo, { backend: launcher(log, SAME, 'aucun', 'b.txt'), frontend: launcher(log, SAME, 'vert', 'b.txt') });
    const c = h.lot('L1', {}, parts());
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(h.calls[1].brief).toContain(SAME);
    expect(c.lot.instables ?? []).toEqual([]);
  });
});

describe('L512 R6 — délai trop juste et rouge au départ (L510) par partie', () => {
  it('R6 — porte en parties, test vert seul à 25 s pour 30 s : délai trop juste, pas de correction', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    scripts(h.repo, { backend: 'exit 0', frontend: `[ -f ../a.txt ] || exit 0; if [ -n "$1" ]; then echo " ✓ $1 > plan-data 25012ms"; exit 0; fi; echo ' FAIL  src/x.spec.ts > plan-data'; echo 'Error: Test timed out in 30000ms.'; exit 1` });
    const c = h.lot('L1', {}, parts());
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.delaisJustes).toEqual([{ test: 'src/x.spec.ts > plan-data', ms: 25012, limit: 30000 }]);
    expect(c.lot.instables ?? []).toEqual([]);
  });
  it('R6 — rouge seul au sha de départ dans sa partie : déjà rouge, ni correction ni escalade, rejoué dans le dossier de la partie du worktree de départ', async () => {
    const log = join(tempDir(), 'base.log');
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    scripts(h.repo, { backend: 'exit 0', frontend: `case "$PWD" in *cadence-baseline*) if [ -n "$1" ]; then echo "$PWD $@" >> ${log}; echo ' FAIL  src/x.spec.ts > tiroir'; exit 1; fi; exit 0;; esac; [ -f ../a.txt ] || exit 0; echo ' FAIL  src/x.spec.ts > tiroir'; exit 1` });
    const c = h.lot('L1', {}, parts());
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.warnings.some((w) => /déjà rouge\(s\) au sha de départ/.test(w))).toBe(true);
    expect(c.lot.escalation).toBeUndefined();
    const base = lines(log);
    expect(base).toHaveLength(2);
    for (const l of base) expect(l).toMatch(/cadence-baseline-[^ ]*\/frontend src\/x\.spec\.ts$/);
  });
  it('R6 — build du départ rouge : rien n\'est excusé, la correction a lieu', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    scripts(h.repo, { backend: 'exit 0', frontend: `[ -f ../b.txt ] && exit 0; case "$PWD" in *cadence-baseline*) if [ -n "$1" ]; then echo ' FAIL  src/x.spec.ts > tiroir'; exit 1; fi; exit 0;; esac; [ -f ../a.txt ] || exit 0; echo ' FAIL  src/x.spec.ts > tiroir'; exit 1` });
    await runLot(h.lot('L1', {}, { ...parts(), build: 'test -f a.txt' }));
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
  });
});

describe('L512 R9 — contrôle de la session accept et message de porte verte', () => {
  const screen = { visible: true, screen: 'page' as const };
  const accept: Handler = (call) => {
    ecritAcceptation(call.opts.cwd, { sansFiche: true });
    return claudeOut(acceptReport());
  };
  const green: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'done.flag', 'feat(L1): a')] }));
  it('R9 — contrôle accept avec une liste : chaque partie lancée dans son dossier, toutes vertes, aucun constat', async () => {
    const log = join(tempDir(), 'accept.log');
    const h = harness({ lots: [{ title: 'Un écran', screen: 'page' }], script: { accept: [accept], implement: [green], review: [ok] } });
    ecrit(h.repo);
    scripts(h.repo, { backend: `echo "$PWD" >> ${log}`, frontend: `echo "$PWD" >> ${log}` });
    const c = h.lot('L1', screen, { accept: 'test -f done.flag', ...parts() });
    await runLot(c);
    expect(kinds(h)).toEqual(['accept', 'implement', 'review']);
    expect(c.lot.acceptProblems).toBeUndefined();
    const where = lines(log);
    expect(where.some((l) => l.endsWith('/backend'))).toBe(true);
    expect(where.some((l) => l.endsWith('/frontend'))).toBe(true);
    expect(where.every((l) => !l.includes('object Object'))).toBe(true);
  });
  it('R9 — contrôle accept : une partie rouge donne le constat « orchestrate.test échoue » avec le code de la première partie non nulle et la sortie fusionnée en-têtée', async () => {
    const h = harness({ lots: [{ title: 'Un écran', screen: 'page' }], script: { accept: [accept, accept], implement: [green], review: [ok] } });
    ecrit(h.repo);
    scripts(h.repo, { backend: 'echo boum; exit 3', frontend: 'echo bing; exit 5' });
    const c = h.lot('L1', screen, { accept: 'test -f done.flag', ...parts() });
    await runLot(c);
    expect(kinds(h)).toEqual(['accept', 'accept']); // le constat est rendu à une seconde session accept, puis le lot est rendu
    expect(h.calls[1].brief).toContain('orchestrate.test échoue (code 3)');
    expect(h.calls[1].brief).toContain('[backend]\nboum');
    expect(h.calls[1].brief).toContain('[frontend]\nbing');
    expect(h.calls[1].brief).not.toContain('object Object');
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('orchestrate.test échoue (code 3)');
  });
  it('R9 — message de porte verte : la session annonce des échecs de base, la porte en parties est verte : le libellé « dir : run ; … » est dans l\'avertissement', async () => {
    const h = harness({ script: { implement: [impl({ tests: { commande: 'npm test', resultat: '1 failed', vert: false }, echecsDeBase: ['autre-lot > cas ancien'], nouveauxEchecs: [] })], review: [ok] } });
    scripts(h.repo, { backend: 'exit 0', frontend: 'exit 0' });
    const c = h.lot('L1', {}, parts());
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.warnings.some((w) => w.includes(`mais la porte du programme verte (${LABEL}, code 0)`))).toBe(true);
  });
});

/** Dépôt de `cadence verify --gate` : la porte en parties (`backend/gate.sh`, `frontend/gate.sh`), `.gitignore` sur node_modules, copie jetable imposée. */
function gateProject(s: { backend: string; frontend: string }, extra = ''): { repo: string; sha: string } {
  const repo = gitRepo();
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test:\n    - { dir: backend, run: sh gate.sh }\n    - { dir: frontend, run: sh gate.sh, replay: "sh gate.sh {files}" }\n${extra}verify:\n  inPlace: false\n`);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  for (const [dir, text] of Object.entries(s)) {
    mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, dir, 'gate.sh'), `${text}\n`);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return { repo, sha: git(repo, 'rev-parse', 'HEAD') };
}

async function gate(repo: string, sha: string, env?: Record<string, string | undefined>) {
  const out: string[] = [];
  const cfg = join(repo, 'cadence.yaml');
  const code = await verifyGate({ repo, sha, config: readOrchestrateConfig(cfg), verify: readVerifyConfig(cfg), out: (l) => out.push(l), ...(env ? { env } : {}) });
  return { code, text: out.join('\n') };
}
const FRONT_RED = (log: string) => `echo "$PWD $@" >> ${log}; if [ -n "$1" ]; then echo " ✓ $@ (1 test)"; exit 0; fi; echo " FAIL  src/x.spec.ts > charge"; exit 1`;

describe('L512 R6/R9 — cadence verify --gate joue la porte en parties et rejoue chaque rouge dans sa partie', () => {
  it('R9 — toutes les parties jouées, rouge de charge du frontend rejoué chez lui : porte verte qui le dit instable, étape libellée « dir : run ; … »', async () => {
    const log = join(tempDir(), 'gate.log');
    const { repo, sha } = gateProject({ backend: `echo "$PWD $@" >> ${log}; exit 0`, frontend: FRONT_RED(log) });
    const r = await gate(repo, sha);
    expect(r.code).toBe(0);
    expect(r.text).toContain(`✓ tests (${LABEL}) — 1 test(s) rouge(s) sous charge, verts rejoués seuls (instables sous charge) :`);
    expect(r.text).toContain('  - src/x.spec.ts > charge');
    const all = lines(log);
    expect(all.some((l) => /\/backend $/.test(l))).toBe(true);
    expect(all.filter((l) => /\/frontend src\/x\.spec\.ts$/.test(l))).toHaveLength(1);
  });
  it('R9 — backend rouge sans replay et frontend instable : porte rouge, parties rouges nommées, seul le rouge du backend listé', async () => {
    const log = join(tempDir(), 'gate.log');
    const { repo, sha } = gateProject({ backend: 'echo " FAIL  src/b.spec.ts > bug"; exit 1', frontend: FRONT_RED(log) });
    const r = await gate(repo, sha);
    expect(r.code).toBe(1);
    expect(r.text).toContain(`✗ tests (${LABEL}) — code 1`);
    expect(r.text).toContain('  parties rouges : backend (code 1), frontend (code 1)');
    expect(r.text).toContain('  - src/b.spec.ts > bug');
    expect(r.text).not.toMatch(/^  - src\/x\.spec\.ts > charge$/m);
    expect(r.text).toMatch(/^    - src\/x\.spec\.ts > charge$/m); // dit instable, à part
    expect(r.text).toMatch(/verify --gate \w+ : rouge \(1 étape sur 1\)/);
  });
  it('R5/R9 — même nom rouge dans les deux parties, vert seulement au rejeu du frontend : la porte reste rouge sur ce nom', async () => {
    const log = join(tempDir(), 'gate.log');
    const { repo, sha } = gateProject({ backend: `echo "$PWD $@" >> ${log}; echo " FAIL  src/a.spec.ts > same"; exit 1`, frontend: `echo "$PWD $@" >> ${log}; if [ -n "$1" ]; then echo " ✓ $@ (1 test)"; exit 0; fi; echo " FAIL  src/a.spec.ts > same"; exit 1` }, '');
    writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test:\n    - { dir: backend, run: sh gate.sh, replay: "sh gate.sh {files}" }\n    - { dir: frontend, run: sh gate.sh, replay: "sh gate.sh {files}" }\nverify:\n  inPlace: false\n`);
    git(repo, 'commit', '-qam', 'parties avec replay');
    const r = await gate(repo, git(repo, 'rev-parse', 'HEAD'));
    expect(r.code).toBe(1);
    expect(r.text).toContain('  - src/a.spec.ts > same');
    expect(r.text).not.toContain('instable');
    expect(lines(log).filter((l) => /\/backend src\/a\.spec\.ts$/.test(l))).toHaveLength(2);
    expect(lines(log).filter((l) => /\/frontend src\/a\.spec\.ts$/.test(l))).toHaveLength(1);
  });
  it.each([
    ['erreur de compilation', 'echo "Error: type error in src/foo.ts"; exit 1'],
    ['seuil de couverture', 'echo "ERROR: Coverage for lines (50%) does not meet global threshold (80%)"; exit 1'],
    ['dossier introuvable', null],
  ])('R3 — BLOQUANT revue : partie rouge sans test nommé (%s) + instables d\'une autre partie : la porte reste rouge, jamais 0', async (_, backend) => {
    const log = join(tempDir(), 'gate.log');
    const { repo, sha } = gateProject({ backend: backend ?? 'exit 0', frontend: FRONT_RED(log) }, '');
    let at = sha;
    if (backend === null) {
      writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test:\n    - { dir: nope, run: sh gate.sh }\n    - { dir: frontend, run: sh gate.sh, replay: "sh gate.sh {files}" }\nverify:\n  inPlace: false\n`);
      git(repo, 'commit', '-qam', 'dossier introuvable');
      at = git(repo, 'rev-parse', 'HEAD');
    }
    const r = await gate(repo, at);
    expect(r.code).toBe(1);
    expect(r.text).not.toContain(': vert');
    expect(r.text).toMatch(/parties rouges : (backend|nope) \(code [1-9]\d*\)/);
  });
  it('R9 — forme chaîne : libellé et lancement inchangés', async () => {
    const repo = gitRepo();
    writeFileSync(join(repo, 'cadence.yaml'), 'orchestrate:\n  test: "echo ok"\nverify:\n  inPlace: false\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    const r = await gate(repo, git(repo, 'rev-parse', 'HEAD'));
    expect(r.code).toBe(0);
    expect(r.text).toContain('✓ tests (echo ok)');
  });
});

describe('L512 R9 — porte déportée : chaque partie jouée dans son dossier du worktree de l\'hôte', () => {
  it('R9 — la partie et son rejeu tournent dans <worktree de l\'hôte>/frontend', async () => {
    const remote = fakeRemote();
    const mark = join(tempDir(), 'ran.log');
    const parent = tempDir();
    const repo = join(parent, 'depot');
    mkdirSync(repo);
    for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) git(repo, ...a);
    writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test:\n    - { dir: frontend, run: "pwd >> ${mark}; echo ' FAIL  a.test.ts > suite > cas'; exit 1", replay: "pwd >> ${mark}; echo ran {files}" }\n  gate:\n    host: machine\n    install: mkdir -p node_modules\nverify:\n  inPlace: false\n`);
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(repo, 'package-lock.json'), '{"v":1}\n');
    mkdirSync(join(repo, 'frontend'));
    writeFileSync(join(repo, 'frontend', '.keep'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'local');
    const r = await gate(repo, git(repo, 'rev-parse', 'HEAD'), remote.env);
    expect(r.text).toContain('porte jouée sur');
    expect(r.code).toBe(0);
    expect(r.text).toContain('instables sous charge');
    const where = lines(mark);
    expect(where).toHaveLength(2);
    const work = join(remote.home, '.cadence-gate', 'depot', 'wt');
    for (const w of where) expect(w).toMatch(new RegExp(`^${work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+/frontend$`));
  });
});
