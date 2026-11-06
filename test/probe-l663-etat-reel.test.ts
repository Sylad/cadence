import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scheduleProbe, touchesCycle } from '../src/orchestrate/probe.js';
import { EXPRESS_BRIEF } from '../src/orchestrate/briefs.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, harness, probeReport, workReport, type Handler } from './orchestrate-harness.js';
import type { LotState } from '../src/orchestrate/state.js';

const root = join(import.meta.dirname, '..');
const lot = (over: Partial<LotState> = {}): LotState => ({ project: 'a', lot: 'L1', status: 'implementing', next: null, outcome: null, steps: [], pass: 0, answers: [], questions: [], warnings: [], constats: [], proposals: [], ...over }) as LotState;
const moment = (over = {}) => ({ skip: false, late: false, pays: true, reached: true, count: '0', cycle: false, ...over });
const cfg = { probe: true } as never;

describe('L663 — le brief exige un test qui appelle l’étape réelle', () => {
  const text = readFileSync(join(root, 'templates/orchestrate/implement.md'), 'utf8');
  it('R1 — implement.md : un lot qui lit un état écrit par une étape du cycle appelle l’étape réelle dans son test', () => {
    expect(text).toMatch(/\[L663\][^\n]*(written by|state)[^\n]*step[^\n]*real step/i);
    expect(text).toMatch(/never (build|forge|hand-write)[^\n]*state/i);
  });
  it('R1 — la ligne L663 de implement.md ne cite pas « maquette » : le brief d’un lot sans écran n’en parle pas', () => {
    const ligne = text.split('\n').find((l) => l.includes('[L663]'))!;
    expect(ligne).not.toMatch(/maquette|mockup/i);
  });
});

describe('L663 — la sonde joue aussi sur un lot express qui touche src/orchestrate/cycle/', () => {
  it('R2 — express qui touche le cycle : la sonde est la prochaine étape', () => {
    const l = lot({ express: true });
    expect(scheduleProbe(cfg, l, moment({ cycle: true }))).toBe(true);
    expect(l.next).toBe('probe');
  });
  it('R2 — express qui ne touche pas le cycle : pas de sonde, ni champ ni warning', () => {
    const l = lot({ express: true });
    expect(scheduleProbe(cfg, l, moment())).toBe(false);
    expect(l.probe).toBeUndefined();
    expect(l.warnings).toEqual([]);
  });
  it('R2 — lot ordinaire : inchangé, la sonde joue que le cycle soit touché ou non', () => {
    expect(scheduleProbe(cfg, lot(), moment())).toBe(true);
    expect(scheduleProbe(cfg, lot(), moment({ cycle: true }))).toBe(true);
  });
  it('R2 — sans orchestrate.probe, rien même pour un express qui touche le cycle', () => {
    expect(scheduleProbe({ probe: undefined } as never, lot({ express: true }), moment({ cycle: true }))).toBe(false);
  });
  it('R2 — touchesCycle : fichier du dossier du cycle oui, voisin ou préfixe trompeur non, ensemble vide non', () => {
    expect(touchesCycle(new Set(['src/orchestrate/cycle/brief.ts']))).toBe(true);
    expect(touchesCycle(new Set(['README.md', 'src/orchestrate/cycle/x/y.ts']))).toBe(true);
    expect(touchesCycle(new Set(['src/orchestrate/cycle.ts', 'src/orchestrate/cycle-x/a.ts', 'src/orchestrate/probe.ts']))).toBe(false);
    expect(touchesCycle(new Set())).toBe(false);
  });
  it('R2 — le brief express ne promet plus « no edge-case probe » sans réserve', () => {
    expect(EXPRESS_BRIEF).toContain('src/orchestrate/cycle/');
  });
});

describe('L663 — sur le chemin réel (runLot)', () => {
  const impl = (file: string): Handler => (call) => (mkdirSync(dirname(join(call.opts.cwd, file)), { recursive: true }), claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `feat(L1): ${file}`)] })));
  const sonde: Handler = () => claudeOut(probeReport({ commits: [] }));
  const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
  it('R2 — un lot express qui commite sous src/orchestrate/cycle/ : implement, probe, puis prêt (pas de revue)', async () => {
    const h = harness({ lots: [{ title: 'un', estimate: 0.1 }], script: { implement: [impl('src/orchestrate/cycle/a.ts')], probe: [sonde] } });
    const c = h.lot('L1', { express: true }, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe']);
    expect(c.lot.status).toBe('ready');
  });
  it('R2 — un lot express qui commite ailleurs : implement seul', async () => {
    const h = harness({ lots: [{ title: 'un', estimate: 0.1 }], script: { implement: [impl('src/orchestrate/autre.ts')], probe: [sonde] } });
    const c = h.lot('L1', { express: true }, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement']);
  });
});
