import { describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { needsPrecheck, runLot } from '../src/orchestrate/cycle.js';
import { commitFile, claudeOut, harness, precheckReport, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';
import { writeJournal, writeWave } from './perf-helpers.js';

const ok: Handler = () => claudeOut(reviewReport());
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L2): a')] }));
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const need = (titles: string[], lot: string, config = { precheck: true }) => {
  const h = harness({ lots: titles.map((title) => ({ title })) });
  return needsPrecheck(config, h.plan(), h.repo, lot);
};

describe('orchestrate — précheck conditionnel au titre du lot (L288)', () => {
  it('R1 — un lot sans commit dont le titre ne cite ni constat ni lot antérieur n\'a pas de précheck', async () => {
    const h = harness({ lots: [{ title: 'Premier' }, { title: 'orchestrate : afficher la durée des étapes' }], script: { implement: [impl], review: [ok] } });
    const c = h.lot('L2', {}, { precheck: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('R2 — le titre qui cite un lot antérieur (L1 pour L2) déclenche le précheck', () => {
    expect(need(['Premier', 'Suite de L1 : la mesure'], 'L2')).toBe(true);
  });

  it('R3 — un lot cité qui n\'est pas antérieur (le lot lui-même, un lot postérieur) ne déclenche rien', () => {
    expect(need(['Premier', 'Le lot L2 ajoute une mesure', 'Après'], 'L2')).toBe(false);
    expect(need(['Premier', 'Avant L3 : la mesure', 'Après'], 'L2')).toBe(false);
  });

  it('R4 — le titre qui cite un constat (constat, revue, audit) déclenche le précheck, sans tenir compte de la casse', () => {
    expect(need(['Corriger le Constat du relecteur'], 'L1')).toBe(true);
    expect(need(['Revue du 24-10 : trois défauts'], 'L1')).toBe(true);
    expect(need(['Audit des coûts'], 'L1')).toBe(true);
  });

  it('R5 — « L1 » ne se confond pas avec « L10 » ni avec un mot : seul un identifiant entier de lot compte', () => {
    expect(need(['Premier', 'Le MODEL12 et la ligne L10'], 'L2')).toBe(false);
  });

  it('R6 — orchestrate.precheck: false coupe le précheck même pour un titre qui cite un constat', () => {
    expect(need(['Corriger le constat'], 'L1', { precheck: false })).toBe(false);
  });

  it('R7 — un lot qui a déjà des commits n\'est pas pré-vérifié, même si son titre cite un constat', () => {
    const h = harness({ lots: [{ title: 'Corriger le constat' }] });
    commitFile(h.repo, 'pre.txt', 'feat(L1): déjà là');
    expect(needsPrecheck({ precheck: true }, h.plan(), h.repo, 'L1')).toBe(false);
  });

  it('R8 — un lot au titre qui cite un lot antérieur passe bien par le précheck dans le cycle', async () => {
    const h = harness({ lots: [{ title: 'Premier' }, { title: 'Suite de L1' }], script: { precheck: [() => claudeOut(precheckReport())], implement: [impl], review: [ok] } });
    await runLot(h.lot('L2', {}, { precheck: true }));
    expect(kinds(h)).toEqual(['precheck', 'implement', 'review']);
  });

  it('R9 — le verdict du précheck est enregistré dans l\'état du lot : oui, partiel, non', async () => {
    const verdict = async (dejaPresent: 'oui' | 'partiel' | 'non') => {
      const h = harness({ lots: [{ title: 'Revue de L0' }], script: { precheck: [() => claudeOut(precheckReport({ dejaPresent, preuves: ['a.ts:1'] }))], implement: [impl], review: [ok] } });
      const c = h.lot('L1', {}, { precheck: true });
      await runLot(c);
      return c.lot.precheckVerdict;
    };
    expect(await verdict('oui')).toBe('oui');
    expect(await verdict('partiel')).toBe('partiel');
    expect(await verdict('non')).toBe('non');
  });

  it('R10 — un « oui » sans preuve, traité comme partiel, s\'enregistre « partiel »', async () => {
    const h = harness({ lots: [{ title: 'Revue de L0' }], script: { precheck: [() => claudeOut(precheckReport({ dejaPresent: 'oui', preuves: [] }))], implement: [impl], review: [ok] } });
    const c = h.lot('L1', {}, { precheck: true });
    await runLot(c);
    expect(c.lot.precheckVerdict).toBe('partiel');
  });

  it('R11 — un lot sans précheck ne porte aucun verdict', async () => {
    const h = harness({ lots: [{ title: 'Simple' }], script: { implement: [impl], review: [ok] } });
    const c = h.lot('L1', {}, { precheck: true });
    await runLot(c);
    expect(c.lot.precheckVerdict).toBeUndefined();
  });
});

describe('cadence perf — part de « oui » du précheck (L288)', () => {
  const TODAY = '2026-10-16';
  const CUR = '2026-10-12';
  const PREV = '2026-10-05';
  let seq = 0;
  function ctx() {
    const root = tempDir();
    const runs = join(root, '.cadence', 'runs');
    mkdirSync(runs, { recursive: true });
    writeWave(runs, 'w1', '2026-10-01T08:00:00');
    return { root, runs };
  }
  const lot = (c: ReturnType<typeof ctx>, day: string, precheck?: string, status = 'ready') =>
    writeJournal(c.runs, 'w1', 'alpha', `L${++seq}`, { status, ...(precheck ? { precheck } : {}), steps: [{ kind: 'precheck', ended: `${day}T08:00:00` }, { kind: 'implement', ended: `${day}T09:00:00` }] });
  const json = async (root: string) => {
    const out: string[] = [];
    await run(['perf', '--json'], { cwd: root, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: () => {}, now: () => new Date(`${TODAY}T10:00:00`) });
    return JSON.parse(out.join('\n'));
  };

  it('R12 — la part de « oui » est comptée par fenêtre : 1 lot sur 4 avant, 0 sur 2 après', async () => {
    const c = ctx();
    lot(c, PREV, 'oui', 'handed-back');
    lot(c, PREV, 'partiel');
    lot(c, PREV, 'non');
    lot(c, PREV, 'non');
    lot(c, CUR, 'non');
    lot(c, CUR, 'partiel');
    const d = await json(c.root);
    expect(d.precheck.yes.previous).toBe(0.25);
    expect(d.precheck.yes.lots.previous).toBe(4);
    expect(d.precheck.yes.current).toBe(0);
    expect(d.precheck.yes.lots.current).toBe(2);
  });

  it('R13 — un lot sans verdict (précheck absent, journal ancien) n\'entre pas au dénominateur ; sans verdict, la part est n/d', async () => {
    const c = ctx();
    lot(c, CUR);
    lot(c, CUR, 'oui', 'handed-back');
    const d = await json(c.root);
    expect(d.precheck.yes.current).toBe(1);
    expect(d.precheck.yes.lots.current).toBe(1);
    expect(d.precheck.yes.previous).toBeNull();
  });

  it('R14 — l\'indicateur est une information : ni ⚠ ni jumeau, même quand la part de « oui » double', async () => {
    const c = ctx();
    for (let i = 0; i < 6; i++) lot(c, PREV, i === 0 ? 'oui' : 'non', i === 0 ? 'handed-back' : 'ready');
    for (let i = 0; i < 6; i++) lot(c, CUR, i < 4 ? 'oui' : 'non', i < 4 ? 'handed-back' : 'ready');
    const d = await json(c.root);
    expect(d.precheck.yes.warn).toBe(false);
    expect(d.precheck.yes.twin).toBeNull();
  });

  it('R15 — la ligne texte nomme l\'indicateur', async () => {
    const c = ctx();
    lot(c, CUR, 'oui', 'handed-back');
    const out: string[] = [];
    await run(['perf'], { cwd: c.root, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: () => {}, now: () => new Date(`${TODAY}T10:00:00`) });
    expect(out.join('\n')).toContain('part de « oui » du précheck');
  });
});
