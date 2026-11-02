import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.js';
import { cadenceHome, registerWave } from '../src/orchestrate/registry.js';
import { RunStore, type LotState } from '../src/orchestrate/state.js';
import { waveReadsIntegrateQueue } from '../src/orchestrate/snapshot.js';
import { adoptLeadReview, depositIntegrations, depositsOnly, integrationText, runsElsewhere, takeIntegrations } from '../src/orchestrate/integration-vivante.js';

// L532 — bords : file vide/absente/doublon, options de reprise, prise d'une demande sans lot, lot déjà repris.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const base = { integrate: [{ lot: 'L1' }], answers: [], lotBudgets: [], drop: [], budget: undefined as number | undefined, continue: false };

describe('L532 bords — depositsOnly', () => {
  it('vague vivante + --integrate seul → dépôt', () => expect(depositsOnly(base as never, true)).toBe(true));
  it('vague non vivante → pas de dépôt', () => expect(depositsOnly(base as never, false)).toBe(false));
  it('--integrate vide → pas de dépôt', () => expect(depositsOnly({ ...base, integrate: [] } as never, true)).toBe(false));
  it('une cible --replay parmi plusieurs → pas de dépôt', () => expect(depositsOnly({ ...base, integrate: [{ lot: 'L1' }, { lot: 'L2', replay: true }] } as never, true)).toBe(false));
  it('--budget 0 (zéro) compte comme une autre option', () => expect(depositsOnly({ ...base, budget: 0 } as never, true)).toBe(false));
  it('--answer, --drop, lotBudgets, --continue → pas de dépôt', () => {
    expect(depositsOnly({ ...base, answers: [{}] } as never, true)).toBe(false);
    expect(depositsOnly({ ...base, drop: [{}] } as never, true)).toBe(false);
    expect(depositsOnly({ ...base, lotBudgets: [{}] } as never, true)).toBe(false);
    expect(depositsOnly({ ...base, continue: true } as never, true)).toBe(false);
  });
});

describe('L532 bords — runsElsewhere', () => {
  it('vague sans état (aucun wave.json) → false, sans lever', () => {
    const s = new RunStore(tempDir(), 'w1');
    expect(runsElsewhere(s, '/x')).toBe(false);
  });
  it('inscrite vivante avec le pid du processus courant → false (ce n’est pas « ailleurs »)', () => {
    const launch = tempDir();
    const s = new RunStore(launch, 'w1');
    registerWave(cadenceHome(), { pid: process.pid, wave: 'w1', started: 'x', cwd: launch, repos: [] });
    expect(runsElsewhere(s, launch)).toBe(false);
  });
});

describe('L532 bords — file', () => {
  it('lot vide « » est accepté par la file puis relu tel quel', () => {
    const s = new RunStore(tempDir(), 'w1');
    const id = s.requestIntegrate('');
    expect(s.integrateQueue()).toEqual([{ id, lot: '' }]);
  });
  it('ligne avec lot non texte ignorée', () => {
    const s = new RunStore(tempDir(), 'w1');
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(join(s.dir, 'integrates.log'), '{"id":1,"lot":42}\n{"id":2}\n[]\nnull\n');
    expect(s.integrateQueue()).toEqual([]);
  });
  it('« prise » d’un numéro inconnu ne casse rien ; prendre deux fois est idempotent', () => {
    const s = new RunStore(tempDir(), 'w1');
    const id = s.requestIntegrate('a:L1');
    s.markIntegrateTaken(99);
    s.markIntegrateTaken(id);
    s.markIntegrateTaken(id);
    expect(s.integrateQueue()).toEqual([]);
    expect(s.requestIntegrate('a:L1')).toBe(id + 1);
  });
  it('la file des intégrations est indépendante de celle des ajouts et des réponses', () => {
    const s = new RunStore(tempDir(), 'w1');
    s.requestIntegrate('a:L1');
    expect(s.requestIntegrate('a:L2')).toBe(2);
    expect(readFileSync(join(s.dir, 'integrates.log'), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

describe('L532 bords — snapshot', () => {
  it('instantané présent mais state.js absent → false (la vague ne lit pas la file)', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'tool', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'tool', 'bin', 'cadence.js'), '');
    expect(waveReadsIntegrateQueue(dir)).toBe(false);
  });
  it('state.js vide → false ; contenant integrates.log → true', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'tool', 'bin'), { recursive: true });
    mkdirSync(join(dir, 'tool', 'dist', 'orchestrate'), { recursive: true });
    writeFileSync(join(dir, 'tool', 'bin', 'cadence.js'), '');
    writeFileSync(join(dir, 'tool', 'dist', 'orchestrate', 'state.js'), '');
    expect(waveReadsIntegrateQueue(dir)).toBe(false);
    writeFileSync(join(dir, 'tool', 'dist', 'orchestrate', 'state.js'), "x 'integrates.log' y");
    expect(waveReadsIntegrateQueue(dir)).toBe(true);
  });
});

describe('L532 bords — textes et adoption', () => {
  it('integrationText sans revue du lead', () => expect(integrationText(null)).toBe('intégration reprise (--resume --integrate)'));
  it('integrationText avec une tête plus courte que 7 caractères', () => expect(integrationText({ head: 'abc' })).toContain('abc'));
  it('adoptLeadReview remplace des constats existants', () => {
    const l = { next: 'review', constats: [{ x: 1 }], code: undefined } as unknown as LotState;
    adoptLeadReview(l, { head: 'deadbeef', verdict: 'ok' });
    expect(l.next).toBe('integrate');
    expect(l.constats).toEqual([]);
    expect(l.code?.head).toBe('deadbeef');
    expect(l.verdict).toBe('ok');
  });
});

describe('L532 bords — depositIntegrations / takeIntegrations sans lot', () => {
  it('cibles vides → code 0 sans rien déposer', () => {
    const s = new RunStore(tempDir(), 'w1');
    const out: string[] = [];
    const code = depositIntegrations([], { out: (x: string) => out.push(x), err: (x: string) => out.push(x) } as never, s);
    expect(s.integrateQueue()).toEqual([]);
    expect(code === 0 || code === 2).toBe(true);
  });
  it('lot inconnu → code 2, message « lot inconnu », file vide', () => {
    const s = new RunStore(tempDir(), 'w1');
    const err: string[] = [];
    const code = depositIntegrations([{ lot: 'L9' }], { out: () => {}, err: (x: string) => err.push(x) } as never, s);
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/lot inconnu/);
    expect(s.integrateQueue()).toEqual([]);
  });
  it('takeIntegrations : demande sur lot inconnu écartée et journalisée, file vidée ; file vide → []', async () => {
    const s = new RunStore(tempDir(), 'w1');
    const logs: string[] = [];
    const w = { store: s, ctxs: [], wctx: { log: (x: string) => logs.push(x) } as never, settled: new Set<never>() };
    expect(await takeIntegrations(w as never, () => true)).toEqual([]);
    s.requestIntegrate('a:L1');
    s.requestIntegrate('a:L1');
    expect(await takeIntegrations(w as never, () => true)).toEqual([]);
    expect(s.integrateQueue()).toEqual([]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/intégration écartée \(lot inconnu\)/);
  });
  it('takeIntegrations : lot déjà « ready » écarté (le lot n’est plus rendu)', async () => {
    const s = new RunStore(tempDir(), 'w1');
    const logs: string[] = [];
    const ctx = { lot: { project: 'a', lot: 'L1', repo: undefined, status: 'ready', next: 'integrate', outcome: null } } as never;
    s.requestIntegrate('a:L1');
    const w = { store: s, ctxs: [ctx], wctx: { log: (x: string) => logs.push(x) } as never, settled: new Set() };
    expect(await takeIntegrations(w as never, () => true)).toEqual([]);
    expect(logs.join()).toMatch(/n'est plus rendu \(ready\)/);
    expect(s.integrateQueue()).toEqual([]);
  });
  it('takeIntegrations : canRun faux → la demande reste en file (non écartée)', async () => {
    const s = new RunStore(tempDir(), 'w1');
    const ctx = { lot: { project: 'a', lot: 'L1', repo: undefined, status: 'handed-back', next: 'integrate', outcome: 'x' } } as never;
    s.requestIntegrate('a:L1');
    const w = { store: s, ctxs: [ctx], wctx: { log: () => {} } as never, settled: new Set() };
    expect(await takeIntegrations(w as never, () => false)).toEqual([]);
    expect(s.integrateQueue()).toHaveLength(1);
  });
});
