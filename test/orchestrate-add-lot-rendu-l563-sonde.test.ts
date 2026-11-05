import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resumeNext, resumeRefusal } from '../src/orchestrate/ajout.js';
import type { LotCtx } from '../src/orchestrate/cycle.js';
import { firstReview, toFix } from '../src/orchestrate/cycle/review.js';
import { firstWrite } from '../src/orchestrate/cycle/spec-steps.js';
import { addableHandBack, lotGesture } from '../src/orchestrate/geste.js';
import { RunStore, type LotState } from '../src/orchestrate/state.js';
import { lotBranch, lotTreeDir, prepareTree } from '../src/orchestrate/worktree.js';
import { git } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

// L563 — sondes de cas limites : R2, R4, R6, R11, R13 (sonde, pas la suite du lot).
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const lot = (over: Partial<LotState> = {}): LotState =>
  ({ project: 'a', lot: 'L1', repo: '/x/a', status: 'handed-back', next: 'fix', outcome: 'revue non conforme après 2 passe(s) de correction', steps: [], pass: 2, answers: [], questions: [], warnings: [], constats: [], proposals: [], budget: 100, ...over }) as unknown as LotState;
const step = (kind: string, counted: number) => ({ kind, status: 'done', tokens: { counted, cacheRead: 0 } }) as unknown as LotState['steps'][number];
const constat = (source: 'code' | 'tests' | 'ux') => ({ source, gravite: 'bloquant', fichier: 'f.ts', ligne: 1, texte: 'à corriger' }) as unknown as LotState['constats'][number];
const ctxOf = (l: LotState): LotCtx =>
  ({ wave: { id: 'W2', store: { writeLot: () => {} }, log: () => {} }, lot: l, config: { timeouts: { work: 45 * 60_000 } }, loadPlan: () => ({ lot: () => ({ visible: false }) }) }) as unknown as LotCtx;
const pair = (old: Partial<LotState>) => ({ fresh: ctxOf(lot({ status: 'queued', next: null, outcome: null, pass: 0, steps: [], constats: [], budget: 100 })), old: ctxOf(lot(old)) });

describe('L563 sonde — R13 addableHandBack aux bords', () => {
  it('R13 — outcome de type faux (nombre, objet) : faux, sans lever', () => {
    expect(() => addableHandBack({ status: 'handed-back', next: 'fix', outcome: 42 as unknown as string })).not.toThrow();
    expect(addableHandBack({ status: 'handed-back', next: 'fix', outcome: { x: 1 } as unknown as string })).toBe(false);
  });
  it('R13 — préfixe seul sans « après » ni espace, casse différente, espace en tête : faux', () => {
    for (const o of ['revue non conforme après', 'Revue non conforme après 2 passe(s)', ' revue non conforme après 2 passe(s)', 'REVUE NON CONFORME après 2']) {
      expect(addableHandBack({ status: 'handed-back', next: 'fix', outcome: o }), o).toBe(false);
    }
  });
  it("R13 — l'écart docs.sync (« documentation en retard (docs.sync) … ») n'est jamais ajoutable, geste inchangé", () => {
    const l = lot({ outcome: 'documentation en retard (docs.sync) : a.md' });
    expect(addableHandBack(l)).toBe(false);
    expect(lotGesture({ id: 'W', status: 'running' }, l)).toContain('raf docs-ok');
    expect(lotGesture({ id: 'W', status: 'running' }, l)).not.toContain('--add');
  });
  it('R13 — status suspended / failed / done avec un outcome de fin de cycle : faux', () => {
    for (const status of ['suspended', 'failed', 'done', 'queued', 'running', 'ready'] as const) {
      expect(addableHandBack({ status, next: 'fix', outcome: 'tests rouges après 2 passe(s) de correction' }), status).toBe(false);
    }
  });
  it('R13 — lotGesture : lot rendu ajoutable sur vague terminée (completed, failed, suspended) : jamais de --add', () => {
    for (const status of ['completed', 'failed', 'suspended', 'stopped']) {
      expect(lotGesture({ id: 'W', status }, lot()), status).not.toContain('--add');
    }
  });
});

describe('L563 sonde — resumeNext aux bords', () => {
  it('R2 — constats mixtes code + tests : reprise à la correction, tous les constats gardés', () => {
    const { fresh, old } = pair({ constats: [constat('tests'), constat('code')], steps: [step('review', 5)] });
    expect(resumeNext(fresh, old)).toBe('correction');
    expect(fresh.lot.next).toBe('fix');
    expect(fresh.lot.constats).toHaveLength(2);
  });
  it('R2 — constats ux seuls avec une étape de revue : pas de correction, repart à la revue', () => {
    const { fresh, old } = pair({ constats: [constat('ux')], steps: [step('review', 5)] });
    expect(resumeNext(fresh, old)).toBe('revue');
    expect(fresh.lot.next).toBe(firstReview(fresh));
  });
  it('R2 — étape « review-light » (kind commençant par review) sans constat : revue', () => {
    const { fresh, old } = pair({ constats: [], steps: [step('review-light', 5)] });
    expect(fresh.lot.resumedReviewed).toBeFalsy();
    expect(resumeNext(fresh, old)).toBe('revue');
    expect(fresh.lot.resumedReviewed).toBe(true);
  });
  it('R11 — un lot déjà repris (resumedReviewed vrai hérité, aucune étape de revue dans cette vague) garde sa revue : revue, pas écriture', () => {
    const { fresh, old } = pair({ constats: [], steps: [step('implement', 5), step('fix', 5)], resumedFrom: 'W1', resumedReviewed: true, outcome: 'tests rouges après 2 passe(s) de correction' });
    resumeNext(fresh, old);
    expect(fresh.lot.resumedReviewed).toBe(true);
    expect(fresh.lot.next).toBe(firstReview(fresh));
  });
  it('R6 — ancien lot sans aucune étape et pass au plafond : budget = budget neuf, aucun NaN', () => {
    const { fresh, old } = pair({ steps: [], pass: 9, constats: [] });
    resumeNext(fresh, old);
    expect(fresh.lot.budget).toBe(100);
    expect(fresh.lot.next).toBe(firstWrite(fresh));
    expect(fresh.lot.pass).toBe(0);
  });
  it("R6 — ancien lot sans champ budget ni constats (JSON d'un vieil état) : pas de plantage, budget fini", () => {
    const { fresh, old } = pair({ steps: [step('review', 7)] });
    delete (old.lot as Partial<LotState>).budget;
    delete (old.lot as Partial<LotState>).constats;
    expect(() => resumeNext(fresh, old)).not.toThrow();
    expect(Number.isFinite(fresh.lot.budget as number)).toBe(true);
    expect(Array.isArray(fresh.lot.constats)).toBe(true);
  });
  it('R6 — la reprise rejouée deux fois de suite (prise d\'un lot déjà repris) ne cumule pas le budget deux fois', () => {
    const { fresh, old } = pair({ steps: [step('review', 40)], constats: [constat('code')] });
    resumeNext(fresh, old);
    const fresh2 = ctxOf(lot({ status: 'queued', next: null, outcome: null, steps: [], constats: [], budget: 100 }));
    resumeNext(fresh2, fresh);
    expect(fresh2.lot.budget).toBe(40 + 100);
  });
  it('R11 — reviewCounts absent de l\'ancien lot : reste absent ou vide, pas de plantage de toFix', () => {
    const { fresh, old } = pair({ constats: [constat('code')], steps: [step('review', 1)] });
    delete (old.lot as Partial<LotState>).reviewCounts;
    expect(() => resumeNext(fresh, old)).not.toThrow();
    expect(fresh.lot.next).toBe('fix');
  });
  it('R6 — toFix avec escalation héritée vidée : le plafond de passes n\'escalade pas à la première passe', () => {
    const { fresh, old } = pair({ constats: [constat('code')], steps: [step('review', 1)], pass: 5, escalation: { model: 'fable', stage: 'done', issue: 'rendu' } as LotState['escalation'] });
    resumeNext(fresh, old);
    expect(fresh.lot.status).not.toBe('handed-back');
    expect(fresh.lot.escalation).toBeUndefined();
    expect(fresh.lot.outcome).toBeNull();
    void toFix;
  });
});

describe('L563 sonde — resumeRefusal sur un vrai dépôt git', () => {
  function scene() {
    const parent = tempDir();
    const repo = join(parent, 'a');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'commit.gpgsign', 'false');
    for (const f of ['base.txt', 'fichier é.ts', 'sp ace.ts']) writeFileSync(join(repo, f), 'base\n');
    git(repo, 'add', '--', 'base.txt', 'fichier é.ts', 'sp ace.ts');
    git(repo, 'commit', '-q', '-m', 'chore: base');
    const st = new RunStore(parent, 'W2');
    mkdirSync(st.dir, { recursive: true });
    const dir = lotTreeDir(st.dir, 'a', 'L1', repo);
    expect(prepareTree({ repo, dir, branch: lotBranch('W2', 'a', 'L1'), base: 'main', lot: 'a:L1' }).ok).toBe(true);
    return { repo, st, dir, parent, l: lot({ repo }) };
  }
  it('R4 — fichier à accent modifié : le refus le nomme lisiblement (« fichier é.ts »), pas en octal entre guillemets', () => {
    const s = scene();
    writeFileSync(join(s.dir, 'fichier é.ts'), 'x\n');
    expect(resumeRefusal(s.st, s.l, s.parent)).toContain('fichier é.ts');
  });
  it('R4 — fichier avec espace modifié : le refus nomme le fichier sans guillemets', () => {
    const s = scene();
    writeFileSync(join(s.dir, 'sp ace.ts'), 'x\n');
    const why = resumeRefusal(s.st, s.l, s.parent)!;
    expect(why).toContain('sp ace.ts');
    expect(why).not.toContain('"sp ace.ts"');
  });
  it('R4 — correctif indexé (git add) mais non commité : refusé', () => {
    const s = scene();
    writeFileSync(join(s.dir, 'base.txt'), 'x\n');
    git(s.dir, 'add', '--', 'base.txt');
    expect(resumeRefusal(s.st, s.l, s.parent)).toContain('base.txt');
  });
  it('R4 — fichier suivi supprimé non commité : refusé', () => {
    const s = scene();
    rmSync(join(s.dir, 'base.txt'));
    expect(resumeRefusal(s.st, s.l, s.parent)).toContain('base.txt');
  });
  it('R4 — fichier suivi renommé (git mv) non commité : refusé, nouveau nom cité', () => {
    const s = scene();
    git(s.dir, 'mv', 'base.txt', 'autre.txt');
    expect(resumeRefusal(s.st, s.l, s.parent)).toContain('autre.txt');
  });
  it('R4 — fichier non suivi seul : pas un arbre sale (fiche : fichier suivi), reprise permise', () => {
    const s = scene();
    writeFileSync(join(s.dir, 'neuf.txt'), 'x\n');
    expect(resumeRefusal(s.st, s.l, s.parent)).toBeNull();
  });
  it("R4 — dossier du worktree remplacé par un dossier vide (plus un worktree git) alors que la branche existe : refusé, pas « arbre propre »", () => {
    const s = scene();
    git(s.repo, 'worktree', 'remove', '--force', s.dir);
    mkdirSync(s.dir, { recursive: true });
    expect(resumeRefusal(s.st, s.l, s.parent)).not.toBeNull();
  });
  it('R4 — lot sans repo dans son état (undefined) : refus ou null, mais pas de plantage', () => {
    const s = scene();
    expect(() => resumeRefusal(s.st, { project: 'a', lot: 'L1', repo: undefined as unknown as string }, s.parent)).not.toThrow();
  });
});
