import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLot, type LotCtx } from '../src/orchestrate/cycle.js';
import { noteAnswer } from '../src/orchestrate/cycle/plan-writes.js';
import { INTEGRATION_LOCK, takeRepoWrite } from '../src/orchestrate/integrate.js';
import { sharedStateDir } from '../src/state.js';
import { claudeOut, git, harness, workReport, type Handler } from './orchestrate-harness.js';
import { gitRepo, tempDir } from './helpers.js';

// L670 — la réponse du lead est inscrite dans les notes du lot à sa prise, et toute attente de plus de 10 s dit au journal ce qu'elle attend.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean) => {
  for (let i = 0; i < 1000 && !f(); i++) await sleep(10);
  expect(f()).toBe(true);
};
const REPONSE = 'Garde le seuil à 10 s, ne change pas le défaut.';
const notes = (h: ReturnType<typeof harness>) => h.plan().lot('L1').notes.map((n) => n.text);
/** Un lot de la vague avec worktree « actif » (le dépôt lui-même) : ses écritures de plan passent par la file et le verrou du dépôt. */
const withTree = (h: ReturnType<typeof harness>, over: Partial<LotCtx['wave']> = {}, lot: object = {}): LotCtx => {
  const c = h.lot('L1', lot);
  const base = git(h.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  return { ...c, wave: { ...h.wave, ...over } as LotCtx['wave'], tree: { dir: h.repo, branch: base, base, active: true } };
};
const askAgain: Handler = () => claudeOut(workReport({ questions: ['Une autre question ?'] }));

describe('L670 — la réponse du lead est une note du lot', () => {
  it('R1 — la réponse prise est inscrite dans les notes du lot et commitée avant la session', async () => {
    const h = harness({ script: { implement: [askAgain] } });
    const c = h.lot('L1', { status: 'question', next: 'implement', pendingAnswer: REPONSE });
    await runLot(c);
    expect(notes(h).filter((t) => t.includes(REPONSE))).toEqual([`Réponse du lead (vague w1, 2026-10-04) — ${REPONSE}`]);
    expect(git(h.repo, 'log', '-1', '--format=%s', '--', '.cadence/raf.yaml')).toContain('L1');
    expect(h.calls[0].brief).toContain(REPONSE);
  });

  it('R2 — la même réponse reprise deux fois ne crée pas de seconde note', async () => {
    const h = harness();
    const c = h.lot('L1');
    await noteAnswer(c, REPONSE);
    await noteAnswer(c, `  ${REPONSE}\n`);
    expect(notes(h).filter((t) => t.includes('Réponse du lead'))).toHaveLength(1);
  });

  it('R3 — une réponse sur plusieurs lignes tient en une note d\'une ligne', async () => {
    const h = harness();
    await noteAnswer(h.lot('L1'), 'Oui.\n\nEt garde R2.');
    expect(notes(h).find((t) => t.startsWith('Réponse du lead'))).toBe('Réponse du lead (vague w1, 2026-10-04) — Oui. Et garde R2.');
  });

  it('R4 — le dépôt est tenu par une intégration : la session repart sans attendre le verrou, la note est écrite à sa libération', async () => {
    const h = harness({ script: { implement: [askAgain] } });
    const tenu = await takeRepoWrite(h.repo, { wave: 'autre' });
    if (!tenu.ok) throw new Error('verrou refusé');
    const c = withTree(h, { integrate: { slowMs: 10_000 } }, { status: 'question', next: 'implement', pendingAnswer: REPONSE });
    const fin = runLot(c);
    await until(() => h.calls.some((x) => x.kind === 'implement'));
    expect(notes(h).some((t) => t.includes(REPONSE))).toBe(false);
    tenu.release();
    await fin;
    expect(notes(h).some((t) => t.includes(REPONSE))).toBe(true);
  });

  it('R5 — plan refusé (fichier suivi modifié hors plan) : le lot repart quand même, la raison est un avertissement du lot', async () => {
    const h = harness();
    writeFileSync(join(h.repo, 'a.txt'), 'x\n');
    git(h.repo, 'add', '--', 'a.txt');
    git(h.repo, 'commit', '-q', '-m', 'chore: a');
    writeFileSync(join(h.repo, 'a.txt'), 'modifié\n');
    const c = withTree(h);
    await noteAnswer(c, REPONSE);
    expect(notes(h).some((t) => t.includes(REPONSE))).toBe(false);
    expect(c.lot.warnings.join('\n')).toMatch(/réponse du lead non notée.*a\.txt/);
  });
});

describe('L670 — toute attente de plus de 10 s dit au journal ce qu\'elle attend', () => {
  it('R6 — dépôt libre : aucune ligne d\'attente', async () => {
    const lines: string[] = [];
    const g = await takeRepoWrite(gitRepo(), { wave: 'w' }, { slowMs: 20, onSlow: (w) => lines.push(w) });
    if (g.ok) g.release();
    await sleep(60);
    expect(lines).toEqual([]);
  });

  it('R6 — file du dépôt tenue par un lot de la vague : la ligne le dit une fois, au bout du délai', async () => {
    const r = gitRepo();
    const first = await takeRepoWrite(r, { wave: 'w' });
    if (!first.ok) throw new Error('premier tour refusé');
    const lines: string[] = [];
    const second = takeRepoWrite(r, { wave: 'w' }, { slowMs: 30, onSlow: (w) => lines.push(w) });
    await sleep(10);
    expect(lines).toEqual([]);
    await until(() => lines.length > 0);
    await sleep(80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/file d'intégration du dépôt/);
    first.release();
    const g = await second;
    if (g.ok) g.release();
  });

  it('R6 — verrou fichier d\'une autre vague : la ligne nomme la vague et le pid qui le tiennent', async () => {
    const r = gitRepo();
    writeFileSync(join(sharedStateDir(r), INTEGRATION_LOCK), JSON.stringify({ pid: process.ppid, wave: 'autre', started: new Date().toISOString() }));
    const lines: string[] = [];
    const g = await takeRepoWrite(r, { wave: 'w' }, { waitMs: 120, pollMs: 10, slowMs: 30, onSlow: (w) => lines.push(w) });
    expect(g.ok).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`vague autre (pid ${process.ppid})`);
  });

  it('R6 — une écriture de plan du lot qui attend le dépôt l\'écrit au journal de la vague, avec le lot et ce qu\'elle écrit', async () => {
    const h = harness();
    const logs: string[] = [];
    const tenu = await takeRepoWrite(h.repo, { wave: 'autre' });
    if (!tenu.ok) throw new Error('verrou refusé');
    const c = withTree(h, { log: (l: string) => logs.push(l), integrate: { slowMs: 30 } });
    const fin = noteAnswer(c, REPONSE);
    await until(() => logs.some((l) => l.includes('attend')));
    expect(logs.find((l) => l.includes('attend'))).toMatch(/^demo:L1 · attend la file d'intégration du dépôt .* depuis plus de [\d.]+ s, pour : réponse du lead notée$/);
    tenu.release();
    await fin;
    expect(notes(h).some((t) => t.includes(REPONSE))).toBe(true);
  });
});
