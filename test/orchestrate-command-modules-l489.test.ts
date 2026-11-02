import { describe, expect, it } from 'vitest';
import * as command from '../src/orchestrate/command.js';
import { DEFAULT_MAX_SESSIONS, LOT_LIKE, parseBudget, parseMaxSessions, parseOrchestrateArgs } from '../src/orchestrate/command-args.js';
import { matchesNvmrc, notLoggedIn, resolveTargets } from '../src/orchestrate/preflight.js';
import { configuredCap, duration, maxSessions } from '../src/orchestrate/status.js';
import { priorityOf } from '../src/orchestrate/draw.js';
import { resumeArgv } from '../src/orchestrate/resume.js';
import type { OrchestrateIo } from '../src/orchestrate/command.js';

describe('L489 — command.ts découpé : chaque règle déplacée se teste dans son module', () => {
  it("command.ts réexporte les analyseurs d'arguments, sans les redéfinir", () => {
    expect(command.parseBudget).toBe(parseBudget);
    expect(command.parseMaxSessions).toBe(parseMaxSessions);
    expect(command.parseOrchestrateArgs).toBe(parseOrchestrateArgs);
    expect(command.DEFAULT_MAX_SESSIONS).toBe(DEFAULT_MAX_SESSIONS);
    expect(command.resumeArgv).toBe(resumeArgv);
    expect(command.configuredCap).toBe(configuredCap);
  });

  it('parseBudget lit 1500000, 1.5M, 800k et refuse le reste', () => {
    expect(parseBudget('1500000')).toBe(1_500_000);
    expect(parseBudget('1.5M')).toBe(1_500_000);
    expect(parseBudget('800k')).toBe(800_000);
    expect(() => parseBudget('0')).toThrow(/--budget invalide/);
    expect(() => parseBudget('beaucoup')).toThrow(/--budget invalide/);
  });

  it('parseMaxSessions exige un entier ≥ 1 et nomme l’option fautive', () => {
    expect(parseMaxSessions('3')).toBe(3);
    expect(() => parseMaxSessions('0')).toThrow(/--max-sessions invalide/);
    expect(() => parseMaxSessions('2.5', '--interval')).toThrow(/--interval invalide/);
  });

  it('parseOrchestrateArgs sépare projet, lot et modèle, et distingue --budget N de --budget lot=+N', () => {
    const a = parseOrchestrateArgs(['proj:L1@haiku', 'L2', '--budget', '2M', '--budget', 'proj:L1=+200k']);
    expect(a.lots).toEqual([{ project: 'proj', lot: 'L1', model: 'haiku' }, { project: undefined, lot: 'L2', model: undefined }]);
    expect(a.budget).toBe(2_000_000);
    expect(a.lotBudgets).toEqual([{ project: 'proj', lot: 'L1', raise: 200_000, text: '200k' }]);
  });

  it("parseOrchestrateArgs : --goal n'avale pas l'option suivante, une option inconnue est refusée", () => {
    expect(() => parseOrchestrateArgs(['L1', '--goal', '--dry-run'])).toThrow(/--goal attend un texte/);
    expect(() => parseOrchestrateArgs(['--nimporte'])).toThrow(/option inconnue/);
  });

  it('parseOrchestrateArgs : --resume sans valeur prend la vague de --wave, deux vagues différentes sont refusées', () => {
    expect(parseOrchestrateArgs(['--resume', '--wave', '2026-10-04-1412']).resume).toBe('2026-10-04-1412');
    expect(() => parseOrchestrateArgs(['--resume', '2026-10-04-1412', '--wave', '2026-10-05-0900'])).toThrow(/deux vagues/);
  });

  it('LOT_LIKE reconnaît un lot (« : », « / » ou lettres+chiffres) et pas une vague', () => {
    expect(LOT_LIKE.test('proj:L1')).toBe(true);
    expect(LOT_LIKE.test('L489')).toBe(true);
    expect(LOT_LIKE.test('2026-10-04-1412')).toBe(false);
  });

  it('resumeArgv remplace --wave par la vague choisie en clair après --resume', () => {
    expect(resumeArgv(['--resume', '--wave', 'W1', '--max-sessions', '3'], 'W1')).toEqual(['--resume', 'W1', '--max-sessions', '3']);
    expect(resumeArgv(['--resume', 'ancienne', 'proj:L1'], 'W9')).toEqual(['--resume', 'W9', 'proj:L1']);
  });

  it('matchesNvmrc accepte le préfixe de version, pas une version voisine', () => {
    expect(matchesNvmrc('v24.1.0', '24')).toBe(true);
    expect(matchesNvmrc('v24.1.0', 'v24.1')).toBe(true);
    expect(matchesNvmrc('v240.0.0', '24')).toBe(false);
  });

  it("notLoggedIn ne signale que l'état « non connecté » connu", () => {
    expect(notLoggedIn({ claudeAuth: () => ({ loggedIn: false }) } as never)).toMatch(/claude n'est pas connecté/);
    expect(notLoggedIn({ claudeAuth: () => ({ loggedIn: true }) } as never)).toBeNull();
    expect(notLoggedIn({ claudeAuth: () => null } as never)).toBeNull();
  });

  it('configuredCap : le drapeau prime, un réglage invalide retombe au défaut ; maxSessions, lui, le refuse', () => {
    expect(configuredCap({ CADENCE_MAX_SESSIONS: '5' })).toBe(5);
    expect(configuredCap({ CADENCE_MAX_SESSIONS: '5' }, 7)).toBe(7);
    expect(configuredCap({ CADENCE_MAX_SESSIONS: 'x' })).toBe(DEFAULT_MAX_SESSIONS);
    const io = { env: { CADENCE_MAX_SESSIONS: 'x' } } as unknown as OrchestrateIo;
    expect(() => maxSessions(parseOrchestrateArgs([]), io)).toThrow(/CADENCE_MAX_SESSIONS invalide/);
  });

  it('duration écrit les secondes sous la minute, minutes et secondes au-delà', () => {
    expect(duration(42_000)).toBe('42 s');
    expect(duration(125_000)).toBe('2 min 05 s');
  });

  it('priorityOf : --priority prime sur le cadence.yaml du dossier de lancement', () => {
    expect(priorityOf(parseOrchestrateArgs(['--priority', 'b,a']), '/nulle/part')).toEqual(['b', 'a']);
  });

  it('resolveTargets refuse un lot dont le projet est introuvable, sans lancer', () => {
    const refusals: string[] = [];
    const io = { cwd: '/nulle/part', env: {}, log: () => {}, err: () => {} } as unknown as OrchestrateIo;
    const targets = resolveTargets({ lots: [{ project: 'absent', lot: 'L1' }] }, io, refusals);
    expect(targets).toEqual([]);
    expect(refusals.length).toBe(1);
  });
});
