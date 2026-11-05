import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readOrchestrateConfig, type OrchestrateConfig } from '../src/config.js';
import { gateLabel, gateReplayable, gateUnnamed, partCommand, redAloneGate, redCandidates, replayGate, runGate, type GateRan, type GatePart } from '../src/orchestrate/gate-parts.js';
import { gateText } from '../src/orchestrate/briefs.js';
import { acceptText } from '../src/orchestrate/accept.js';
import { tempDir } from './helpers.js';

// L512 (fiche docs/specs/rejeu-porte-composee) : orchestrate.test en liste de parties [{ dir, run, replay? }] — lecture de la configuration (R1, R2), lancement, attribution et rejeu par partie (R3, R4, R5, R8), libellés des lecteurs (R9).

const read = (yaml: string) => {
  const f = join(tempDir(), 'cadence.yaml');
  writeFileSync(f, yaml);
  return readOrchestrateConfig(f);
};
const PARTS = 'orchestrate:\n  test:\n    - { dir: backend, run: npm test }\n    - { dir: frontend, run: "npx vitest run", replay: "npx vitest run {files}" }\n';

describe('L512 R1 — la forme chaîne de orchestrate.test et de testReplay reste acceptée telle quelle', () => {
  it('R1 — test en chaîne + testReplay en chaîne sur un lanceur unique : accepté, rejeu inchangé', () => {
    const c = read('orchestrate:\n  test: "npx vitest run"\n  testReplay: "npx vitest run {files}"\n');
    expect(c.test).toBe('npx vitest run');
    expect(c.testReplay).toBe('npx vitest run {files}');
    expect(gateReplayable(c.test, c.testReplay)).toBe(true);
  });
  it('R1 — test en chaîne composée + testReplay en chaîne : cadence.yaml refusé comme avant', () => {
    expect(() => read('orchestrate:\n  test: "cd back && npm test && cd ../front && npm test"\n  testReplay: "npx vitest run {files}"\n')).toThrow(/testReplay.*porte composée/);
  });
  it('R1 — porte en chaîne sans testReplay : lancée en un bloc comme avant, libellé tel quel', async () => {
    const c = read('orchestrate:\n  test: "cd back && npm test && cd ../front && npm test"\n');
    expect(c.test).toBe('cd back && npm test && cd ../front && npm test');
    expect(gateLabel(c.test!)).toBe(c.test);
    expect(gateReplayable(c.test, undefined)).toBe(false);
    const ran: string[] = [];
    const r = await runGate(async (cmd) => (ran.push(cmd), { code: 0, output: 'ok' }), c.test!);
    expect(ran).toEqual([c.test]);
    expect(r).toEqual({ code: 0, output: 'ok' });
    expect(r.parts).toBeUndefined();
  });
});

describe('L512 R2 — orchestrate.test en liste de parties { dir, run, replay? }', () => {
  it('R2 — liste valide : acceptée, dirs normalisés, replay facultatif', () => {
    expect(read(PARTS).test).toEqual([{ dir: 'backend', run: 'npm test' }, { dir: 'frontend', run: 'npx vitest run', replay: 'npx vitest run {files}' }]);
    expect(read('orchestrate:\n  test:\n    - { dir: "./front/", run: " npm test " }\n').test).toEqual([{ dir: 'front', run: 'npm test' }]);
    expect(read('orchestrate:\n  test:\n    - { dir: ., run: npm test }\n').test).toEqual([{ dir: '.', run: 'npm test' }]);
  });
  it('R2 — liste vide : refusée', () => {
    expect(() => read('orchestrate:\n  test: []\n')).toThrow(/orchestrate\.test : au moins une partie attendue/);
  });
  it('R2 — dir absolu, vide ou avec « .. » : refusé, le message nomme le dir fautif', () => {
    expect(() => read('orchestrate:\n  test:\n    - { dir: /tmp/x, run: npm test }\n')).toThrow(/dir invalide « \/tmp\/x » \(chemin relatif, sans « \.\. », unique\)/);
    expect(() => read('orchestrate:\n  test:\n    - { dir: "", run: npm test }\n')).toThrow(/dir invalide «  »/);
    expect(() => read('orchestrate:\n  test:\n    - { dir: ../autre, run: npm test }\n')).toThrow(/dir invalide « \.\.\/autre »/);
    expect(() => read('orchestrate:\n  test:\n    - { dir: back/../front, run: npm test }\n')).toThrow(/dir invalide « back\/\.\.\/front »/);
    expect(() => read('orchestrate:\n  test:\n    - { dir: 3, run: npm test }\n')).toThrow(/dir invalide « 3 »/);
    expect(() => read('orchestrate:\n  test:\n    - { run: npm test }\n')).toThrow(/dir invalide/);
  });
  it('R2 — dir en double (après normalisation) : refusé', () => {
    expect(() => read('orchestrate:\n  test:\n    - { dir: front, run: a }\n    - { dir: ./front/, run: b }\n')).toThrow(/dir invalide « \.\/front\/ »/);
  });
  it('R2 — run vide, absent ou non chaîne : refusé par le message « run de la partie »', () => {
    expect(() => read('orchestrate:\n  test:\n    - { dir: front, run: " " }\n')).toThrow(/la commande run de la partie « front » ne peut pas être vide/);
    expect(() => read('orchestrate:\n  test:\n    - { dir: front }\n')).toThrow(/la commande run de la partie « front » ne peut pas être vide/);
    expect(() => read('orchestrate:\n  test:\n    - { dir: front, run: [a] }\n')).toThrow(/la commande run de la partie « front » ne peut pas être vide/);
  });
  it('R2 — replay sans {files}, vide ou non chaîne : refusé', () => {
    expect(() => read('orchestrate:\n  test:\n    - { dir: front, run: a, replay: "npx vitest run" }\n')).toThrow(/le replay de la partie « front » doit être une commande non vide contenant \{files\}/);
    expect(() => read('orchestrate:\n  test:\n    - { dir: front, run: a, replay: "" }\n')).toThrow(/le replay de la partie « front »/);
    expect(() => read('orchestrate:\n  test:\n    - { dir: front, run: a, replay: 3 }\n')).toThrow(/le replay de la partie « front »/);
  });
  it('R2 — testReplay en chaîne avec une liste : refusé (le rejeu se déclare par partie)', () => {
    expect(() => read(`${PARTS}  testReplay: "npx vitest run {files}"\n`)).toThrow(/testReplay : refusé quand orchestrate\.test est une liste de parties : déclarer replay dans chaque partie/);
  });
  it('R2 — partie non objet ou clé inconnue dans une partie : refusé avec son message', () => {
    expect(() => read('orchestrate:\n  test:\n    - npm test\n')).toThrow(/chaque partie doit être un objet \{ dir, run, replay\? \}/);
    expect(() => read('orchestrate:\n  test:\n    - { dir: front, run: a, cwd: x }\n')).toThrow(/clé « cwd » inconnue dans une partie \(attendu : dir, run, replay\)/);
    expect(() => read('orchestrate:\n  test: 3\n')).toThrow(/test : commande non vide attendue \(chaîne ou liste de parties/);
  });
});

const back: GatePart = { dir: 'backend', run: 'npm test' };
const front: GatePart = { dir: 'frontend', run: 'npx vitest run', replay: 'npx vitest run {files}' };
const backR: GatePart = { ...back, replay: 'npx jest {files}' };
/** Un lanceur simulé : `outputs[commande]` → sortie (code 1 si elle contient FAIL, 0 sinon) ; les commandes reçues sont gardées. */
const fakeRun = (outputs: Record<string, string>) => {
  const calls: string[] = [];
  const run = async (cmd: string) => {
    calls.push(cmd);
    const output = outputs[cmd] ?? `inconnu: ${cmd}`;
    return { code: /FAIL/.test(output) || output.startsWith('inconnu') ? 1 : 0, output };
  };
  return { run, calls };
};

describe('L512 R3 — chaque partie est lancée dans son dossier et chaque rouge attribué à la partie qui l\'a imprimé', () => {
  it('R3 — deux parties : chaque partie est lancée dans son dossier avec sa commande, sorties fusionnées sous « [dir] », code de la première non nulle', async () => {
    const f = fakeRun({ 'cd backend && npm test': ' FAIL  src/b.spec.ts > bug\n', 'cd frontend && npx vitest run': ' ✓ src/x.spec.ts\n' });
    const r = await runGate(f.run, [back, front]);
    expect(f.calls).toEqual(['cd backend && npm test', 'cd frontend && npx vitest run']);
    expect(r.code).toBe(1);
    expect(r.output).toBe('[backend]\n FAIL  src/b.spec.ts > bug\n\n[frontend]\n ✓ src/x.spec.ts\n');
    expect(r.parts?.map((p) => [p.part.dir, p.code])).toEqual([['backend', 1], ['frontend', 0]]);
  });
  it('R3 — partCommand : un dossier à espaces est quoté ; la commande de rejeu remplace run', () => {
    expect(partCommand({ dir: 'mon front', run: 'npm test' })).toBe("cd 'mon front' && npm test");
    expect(partCommand(front, 'npx vitest run a.ts')).toBe('cd frontend && npx vitest run a.ts');
  });
  it('R3 — rouge imprimé par la partie frontend : rejoué dans frontend, jamais dans backend', async () => {
    const f = fakeRun({ 'cd frontend && npx vitest run src/x.spec.ts': ' ✓ src/x.spec.ts (1 test)\n' });
    const ran: GateRan = { code: 1, output: '', parts: [{ part: back, code: 0, output: ' ✓ ok\n' }, { part: front, code: 1, output: ' FAIL  src/x.spec.ts > charge\n' }] };
    const r = await replayGate(f.run, undefined, ['src/x.spec.ts > charge'], ran);
    expect(f.calls).toEqual(['cd frontend && npx vitest run src/x.spec.ts']);
    expect(r).toEqual({ red: [], unstable: ['src/x.spec.ts > charge'], tight: [] });
  });
  it('R3 — partie backend sans replay : son rouge est compté, aucun rejeu ; le rouge du frontend est jugé seul', async () => {
    const f = fakeRun({ 'cd frontend && npx vitest run src/x.spec.ts': ' ✓ src/x.spec.ts (1 test)\n' });
    const ran: GateRan = { code: 1, output: '', parts: [{ part: back, code: 1, output: ' FAIL  src/b.spec.ts > bug\n' }, { part: front, code: 1, output: ' FAIL  src/x.spec.ts > charge\n' }] };
    const r = await replayGate(f.run, undefined, ['src/b.spec.ts > bug', 'src/x.spec.ts > charge'], ran);
    expect(f.calls).toEqual(['cd frontend && npx vitest run src/x.spec.ts']);
    expect(r.red).toEqual(['src/b.spec.ts > bug']);
    expect(r.unstable).toEqual(['src/x.spec.ts > charge']);
  });
  it('R3 — nom sans fichier désignable : rouge d\'emblée, même dans une partie avec replay ; toutes les parties en 0 : porte verte', async () => {
    const f = fakeRun({});
    const ran: GateRan = { code: 1, output: '', parts: [{ part: front, code: 1, output: ' FAIL  cas sans fichier\n' }] };
    expect((await replayGate(f.run, undefined, ['cas sans fichier'], ran)).red).toEqual(['cas sans fichier']);
    expect(f.calls).toEqual([]);
    const g = fakeRun({ 'cd backend && npm test': 'ok\n', 'cd frontend && npx vitest run': 'ok\n' });
    expect((await runGate(g.run, [back, front])).code).toBe(0);
  });
  it('R3 — redCandidates : l\'échec sans nom d\'une partie rouge retire tout candidat (la porte reste rouge) ; en chaîne, tout ou rien comme avant', () => {
    const parts: GateRan = { code: 1, output: '', parts: [{ part: back, code: 1, output: 'Test suite failed to run\n' }, { part: front, code: 1, output: ' FAIL  src/x.spec.ts > charge\n' }] };
    parts.output = parts.parts!.map((p) => p.output).join('');
    expect(redCandidates(parts)).toEqual([]);
    expect(redCandidates({ code: 1, output: parts.output })).toEqual([]);
    expect(redCandidates({ code: 1, output: ' FAIL  src/x.spec.ts > charge\n' })).toEqual(['src/x.spec.ts > charge']);
  });
});

describe('L512 R4 — rejeu partie par partie, le verdict d\'un test ne dépend que du rejeu de sa partie', () => {
  const ran: GateRan = { code: 1, output: '', parts: [{ part: backR, code: 1, output: 'FAIL src/b.test.ts\n  ● B › bug\n' }, { part: front, code: 1, output: ' FAIL  src/x.spec.ts > charge\n' }] };
  const names = ['B › bug', 'src/b.test.ts', 'src/x.spec.ts > charge'];
  it('R4 — rouges de deux parties : une commande replay par partie, chacune avec ses seuls fichiers, dans son dossier', async () => {
    const f = fakeRun({ 'cd backend && npx jest src/b.test.ts': 'PASS src/b.test.ts\n', 'cd frontend && npx vitest run src/x.spec.ts': ' ✓ src/x.spec.ts (1 test)\n' });
    const r = await replayGate(f.run, undefined, names, ran);
    expect(f.calls).toEqual(['cd backend && npx jest src/b.test.ts', 'cd frontend && npx vitest run src/x.spec.ts']);
    expect(r.red).toEqual([]);
    expect(r.unstable.sort()).toEqual(names);
  });
  it('R4 — le rejeu d\'une partie échoue : ses tests restent rouges, ceux d\'une autre partie verts restent instables', async () => {
    const f = fakeRun({ 'cd backend && npx jest src/b.test.ts': 'FAIL src/b.test.ts\n  ● B › bug\n', 'cd frontend && npx vitest run src/x.spec.ts': ' ✓ src/x.spec.ts (1 test)\n' });
    const r = await replayGate(f.run, undefined, names, ran);
    expect(f.calls.filter((c) => c.startsWith('cd backend'))).toHaveLength(2); // deux rejeux au plus, dans son dossier
    expect(r.red).toEqual(['B › bug', 'src/b.test.ts']);
    expect(r.unstable).toEqual(['src/x.spec.ts > charge']);
  });
  it('R4 — rejeu sans le fichier dans la sortie : tests de la partie rouges ; rouge aux deux rejeux : reste rouge', async () => {
    const f = fakeRun({ 'cd frontend && npx vitest run src/x.spec.ts': 'No test files found, exiting with code 0\n' });
    const only: GateRan = { code: 1, output: '', parts: [{ part: front, code: 1, output: ' FAIL  src/x.spec.ts > charge\n' }] };
    expect((await replayGate(f.run, undefined, ['src/x.spec.ts > charge'], only)).red).toEqual(['src/x.spec.ts > charge']);
    const g = fakeRun({ 'cd frontend && npx vitest run src/x.spec.ts': ' FAIL  src/x.spec.ts > charge\n' });
    expect(await replayGate(g.run, undefined, ['src/x.spec.ts > charge'], only)).toEqual({ red: ['src/x.spec.ts > charge'], unstable: [], tight: [] });
    expect(g.calls).toHaveLength(2);
  });
  it('R4 — le délai trop juste (L510) est lu dans la partie : vert seul à 25 s pour 30 s', async () => {
    const f = fakeRun({ 'cd frontend && npx vitest run src/x.spec.ts': ' ✓ src/x.spec.ts > lent 25012ms\n' });
    const only: GateRan = { code: 1, output: '', parts: [{ part: front, code: 1, output: ' FAIL  src/x.spec.ts > lent\nError: Test timed out in 30000ms.\n' }] };
    const r = await replayGate(f.run, undefined, ['src/x.spec.ts > lent'], only);
    expect(r.unstable).toEqual(['src/x.spec.ts > lent']);
    expect(r.tight).toEqual([{ test: 'src/x.spec.ts > lent', ms: 25012, limit: 30000 }]);
  });
});

describe('L512 R5 — un nom imprimé rouge par plusieurs parties est rejoué dans chacune, vert seulement si toutes le voient vert', () => {
  const shared = (backOut: string): GateRan => ({ code: 1, output: '', parts: [{ part: backR, code: 1, output: backOut }, { part: front, code: 1, output: ' FAIL  src/a.spec.ts > same\n' }] });
  const name = 'src/a.spec.ts > same';
  it('R5 — même chemin rouge dans backend et frontend, vert seulement au rejeu de frontend : reste rouge, jamais instable', async () => {
    const f = fakeRun({ 'cd backend && npx jest src/a.spec.ts': ' FAIL  src/a.spec.ts > same\n', 'cd frontend && npx vitest run src/a.spec.ts': ' ✓ src/a.spec.ts (1 test)\n' });
    const r = await replayGate(f.run, undefined, [name], shared(' FAIL  src/a.spec.ts > same\n'));
    expect(new Set(f.calls)).toEqual(new Set(['cd backend && npx jest src/a.spec.ts', 'cd frontend && npx vitest run src/a.spec.ts']));
    expect(r).toEqual({ red: [name], unstable: [], tight: [] });
  });
  it('R5 — même chemin vert au rejeu des deux parties : instable, et les noms rendus sont ceux imprimés', async () => {
    const f = fakeRun({ 'cd backend && npx jest src/a.spec.ts': ' ✓ src/a.spec.ts (1 test)\n', 'cd frontend && npx vitest run src/a.spec.ts': ' ✓ src/a.spec.ts (1 test)\n' });
    expect(await replayGate(f.run, undefined, [name], shared(' FAIL  src/a.spec.ts > same\n'))).toEqual({ red: [], unstable: [name], tight: [] });
  });
  it('R5 — nom rouge dans backend (sans replay) et vert au rejeu de frontend : reste rouge, la partie sans replay garde son rouge', async () => {
    const f = fakeRun({ 'cd frontend && npx vitest run src/a.spec.ts': ' ✓ src/a.spec.ts (1 test)\n' });
    const ran: GateRan = { code: 1, output: '', parts: [{ part: back, code: 1, output: ' FAIL  src/a.spec.ts > same\n' }, { part: front, code: 1, output: ' FAIL  src/a.spec.ts > same\n' }] };
    const r = await replayGate(f.run, undefined, [name], ran);
    expect(f.calls).toEqual(['cd frontend && npx vitest run src/a.spec.ts']);
    expect(r.red).toEqual([name]);
    expect(r.unstable).toEqual([]);
  });
  it('R5 — redAlone par partie : « déjà rouge » seulement si chaque partie qui l\'a imprimé le nomme rouge à ses rejeux au départ', async () => {
    const lot = shared(' FAIL  src/a.spec.ts > same\n');
    const both = fakeRun({ 'cd backend && npx jest src/a.spec.ts': ' FAIL  src/a.spec.ts > same\n', 'cd frontend && npx vitest run src/a.spec.ts': ' FAIL  src/a.spec.ts > same\n' });
    expect(await redAloneGate(both.run, undefined, [name], lot)).toEqual([name]);
    expect(both.calls).toHaveLength(4); // deux rejeux par partie, dans son dossier
    const one = fakeRun({ 'cd backend && npx jest src/a.spec.ts': ' FAIL  src/a.spec.ts > same\n', 'cd frontend && npx vitest run src/a.spec.ts': ' ✓ src/a.spec.ts\n' });
    expect(await redAloneGate(one.run, undefined, [name], lot)).toEqual([]);
    const noReplay: GateRan = { code: 1, output: '', parts: [{ part: back, code: 1, output: ' FAIL  src/a.spec.ts > same\n' }] };
    const none = fakeRun({});
    expect(await redAloneGate(none.run, undefined, [name], noReplay)).toEqual([]);
    expect(none.calls).toEqual([]);
  });
});

describe('L512 R8 — les parties se lancent toutes même si l\'une est rouge', () => {
  it('R8 — backend rouge : la partie frontend est quand même lancée et ses rouges sont vus', async () => {
    const f = fakeRun({ 'cd backend && npm test': ' FAIL  src/b.spec.ts > bug\n', 'cd frontend && npx vitest run': ' FAIL  src/x.spec.ts > charge\n' });
    const r = await runGate(f.run, [back, front]);
    expect(f.calls).toHaveLength(2);
    expect(redCandidates(r)).toEqual(['src/b.spec.ts > bug', 'src/x.spec.ts > charge']);
  });
});

describe('L512 R9 — les lecteurs de orchestrate.test affichent la liste par partie, jamais « [object Object] »', () => {
  it('R9 — libellé : « dir : run » par partie, joint par « ; » ; la chaîne telle quelle', () => {
    expect(gateLabel([back, front])).toBe('backend : npm test ; frontend : npx vitest run');
    expect(gateLabel('npm test')).toBe('npm test');
  });
  it('R9 — gateText avec une liste : une ligne par partie avec son dossier ; forme chaîne inchangée', () => {
    const text = gateText({ test: [back, front], build: 'npx tsc --noEmit' });
    expect(text).toContain('- tests (run in `backend/`): `npm test`');
    expect(text).toContain('- tests (run in `frontend/`): `npx vitest run`');
    expect(text).toContain('- build: `npx tsc --noEmit`');
    expect(text).not.toContain('object Object');
    expect(gateText({ test: 'npx vitest run' })).toContain('- tests: `npx vitest run`');
  });
  it('R9 — prompt de la session accept : commande ordinaire décrite par partie, sans « [object Object] » ; forme chaîne inchangée', () => {
    const base = { fiche: 'f.yaml', maquette: 'm.html', acceptation: 'a.json', command: 'npx vitest run -c acc.ts' };
    const list = acceptText({ ...base, test: [back, front] });
    expect(list).toContain("The project's ordinary test commands, one per folder, are `npm test` (in `backend/`), `npx vitest run` (in `frontend/`): they must stay green with your red tests committed.");
    expect(list).not.toContain('object Object');
    const many = acceptText({ ...base, command: ['cd back && npm test', 'cd front && npm test'], test: [back, front] });
    expect(many).toContain('one per folder, are `npm test` (in `backend/`)');
    expect(acceptText({ ...base, test: 'npm test' })).toContain("The project's ordinary test command is `npm test`: it must stay green");
    expect(acceptText(base)).not.toContain('ordinary test command');
  });
  it('R9 — command.ts et gate-place : une liste non vide compte comme une porte déclarée (vérité de `config.test`)', () => {
    const c = read(PARTS) as OrchestrateConfig;
    expect(Boolean(c.test || c.build)).toBe(true);
    expect(gateReplayable(c.test, c.testReplay)).toBe(true);
    expect(gateReplayable([back], undefined)).toBe(false);
  });
});

describe('L512 R3 — une partie rouge sans test nommé garde la porte rouge (bloquant de la revue)', () => {
  const unstable = { part: front, code: 1, output: ' FAIL  src/x.spec.ts > charge\n' };
  it.each([
    ['erreur de compilation', 'Error: type error in src/foo.ts\n'],
    ['seuil de couverture', 'ERROR: Coverage for lines (50%) does not meet global threshold (80%)\n'],
    ['dossier introuvable', "sh: 1: cd: can't cd to backend\n"],
    ['fichier qui ne se charge pas', ' FAIL  src/a.spec.ts [ src/a.spec.ts ]\n'],
  ])('R3 — backend rouge (%s) : aucun candidat au rejeu, rien n\'excuse la porte', (_, out) => {
    const ran: GateRan = { code: 1, output: '', parts: [{ part: back, code: 1, output: out }, unstable] };
    expect(gateUnnamed(ran)).toBe(true);
    expect(redCandidates(ran)).toEqual([]);
  });
  it('R3 — backend vert et frontend rouge nommé : les candidats sont ceux du frontend ; forme chaîne : hasUnnamedFailure comme avant', () => {
    const ran: GateRan = { code: 1, output: `[backend]\nError: ignorée, la partie est verte\n\n[frontend]\n${unstable.output}`, parts: [{ part: back, code: 0, output: 'Error: ignorée, la partie est verte\n' }, unstable] };
    expect(gateUnnamed(ran)).toBe(false);
    expect(redCandidates(ran)).toEqual(['src/x.spec.ts > charge']);
    expect(gateUnnamed({ code: 1, output: 'Test suite failed to run\n' })).toBe(true);
    expect(gateUnnamed({ code: 1, output: 'Error: type error\n' })).toBe(false); // chaîne : inchangé, un échec sans nom non reconnu reste jugé par failedTests vide
  });
});

describe('L512 R7 — warhammer40k, docs/orchestrate-cycle.md, orchestrate-gate.md et evatosorus', () => {
  it('R7 — le YAML des deux parties de warhammer40k, tel que rendu au lead, est relu sans erreur par cadence', () => {
    const c = read(`orchestrate:\n  test:\n    - { dir: backend, run: npm test }\n    - { dir: frontend, run: "npx vitest run --exclude '**/*.e2e.spec.ts'", replay: "npx vitest run --minWorkers=1 --maxWorkers=$CADENCE_TEST_WORKERS {files}" }\n  build: (cd backend && npm run build) && (cd frontend && npm run build)\n`);
    expect(c.test).toEqual([{ dir: 'backend', run: 'npm test' }, { dir: 'frontend', run: "npx vitest run --exclude '**/*.e2e.spec.ts'", replay: 'npx vitest run --minWorkers=1 --maxWorkers=$CADENCE_TEST_WORKERS {files}' }]);
    expect(gateLabel(c.test!)).toBe("backend : npm test ; frontend : npx vitest run --exclude '**/*.e2e.spec.ts'");
    expect(partCommand((c.test as GatePart[])[1])).toBe("cd frontend && npx vitest run --exclude '**/*.e2e.spec.ts'");
  });
  const page = (n: string) => readFileSync(new URL(`../docs/${n}`, import.meta.url), 'utf8');
  const doc = () => page('orchestrate-gate.md');
  it('R7 — docs/orchestrate-cycle.md décrit la forme liste et la forme chaîne conservée', () => {
    const d = doc();
    expect(d).toContain('**A gate declared in parts: each part runs in its folder, each red is replayed by the part that printed it (L512)**');
    expect(d).toContain('`[{ dir, run, replay? }]`');
    expect(d).toContain('The string form of `orchestrate.test` is accepted unchanged');
    expect(page('orchestrate-cycle.md')).toMatch(/^  test:\s+# or a LIST of parts \(L512/m);
  });
  it('R7 — docs/orchestrate-gate.md indique qu\'evatosorus attend le lot L514', () => {
    expect(doc()).toMatch(/`node --test` \(evatosorus\)[^\n]*L514/);
  });
});
