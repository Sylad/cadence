import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { needsPrecheck, runLot } from '../src/orchestrate/cycle.js';
import { commitFile, claudeOut, harness, precheckReport, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { gitRepo, tempDir } from './helpers.js';
import { lotSlug } from '../src/orchestrate/state.js';
import { Plan } from '../src/plan.js';
import { writeJournal, writeWave } from './perf-helpers.js';

const ok: Handler = () => claudeOut(reviewReport());
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L2): a')] }));
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const planOf = (lots: { id: string; title: string; goal?: string }[]) => {
  const repo = gitRepo();
  const file = join(repo, 'plan.yaml');
  writeFileSync(file, `version: 1\nproject: demo\nprefix: L\nlots:\n${lots.map((l) => `  - id: ${JSON.stringify(l.id)}\n    title: ${JSON.stringify(l.title)}\n${l.goal ? `    goal: ${JSON.stringify(l.goal)}\n` : ''}    status: todo\n    estimate: 1\n    created: 2026-10-01\n`).join('')}`);
  return { repo, plan: Plan.load(file) };
};
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

  it('R5 bis — un lot L<n> cité en plage ou suffixé (« L1-L2 », « L1-bis », « L1.3 ») compte toujours : seul un mot collé le défait', () => {
    expect(need(['Premier', 'x', 'Un mot collé : ML1 et L1x'], 'L3')).toBe(false);
    expect(need(['Premier', 'x', 'Suite de L1-bis : la mesure'], 'L3')).toBe(true);
    expect(need(['Premier', 'x', 'Suite de L1-2 : la mesure'], 'L3')).toBe(true);
    expect(need(['Premier', 'x', 'Voir L1.3 : la mesure'], 'L3')).toBe(true);
    expect(need(['Premier', 'x', 'Suite de L1-L2 : la mesure'], 'L3')).toBe(true);
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

  it('R16 — pour un lot dont l\'id n\'est pas L<n>, tout autre lot cité (Q-1, B28.1) déclenche le précheck, pas le lot lui-même', () => {
    const repo = gitRepo();
    const plan = Plan.create(join(repo, 'plan.yaml'), 'demo', 'Q-', '2026-09-01');
    const a = plan.add('Le contrat', '2026-10-01', { estimate: 1 });
    const b = plan.add(`Suite du contrat ${a} : la mesure`, '2026-10-01', { estimate: 1 });
    const c = plan.add(`Le lot ${'Q-3'} seul`, '2026-10-01', { estimate: 1 });
    plan.save();
    expect(needsPrecheck({ precheck: true }, plan, repo, b)).toBe(true);
    expect(needsPrecheck({ precheck: true }, plan, repo, c)).toBe(false);
  });

  it('R17 — un lot L<n> dont le titre cite un lot du plan d\'un autre format (Q-CAN5, B28.1, Q4/qa-expectations) déclenche le précheck', () => {
    for (const id of ['Q-CAN5', 'B28.1', 'Q4/qa-expectations']) {
      const { repo, plan } = planOf([{ id, title: 'Autre' }, { id: 'L9', title: `Suite de ${id} : la mesure` }]);
      expect(needsPrecheck({ precheck: true }, plan, repo, 'L9'), id).toBe(true);
    }
    const { repo, plan } = planOf([{ id: 'Q-CAN5', title: 'Autre' }, { id: 'L9', title: 'Une mesure sans rapport' }]);
    expect(needsPrecheck({ precheck: true }, plan, repo, 'L9')).toBe(false);
  });

  it('R18 — B28.1 cité ne vaut pas pour B28.10 ni B28.100 : seul l\'identifiant entier compte (le point final d\'une phrase n\'est pas une extension)', () => {
    const lots = (title: string) => planOf([{ id: 'B28.1', title: 'a' }, { id: 'B28.10', title: 'b' }, { id: 'B29', title }]);
    const needs = (title: string) => { const { repo, plan } = lots(title); return needsPrecheck({ precheck: true }, plan, repo, 'B29'); };
    expect(needs('Le lot B28.10 seul')).toBe(true);
    expect(needs('Le lot B28.100 seul')).toBe(false);
    expect(needs('Fin de B28.1.')).toBe(true);
    expect(needs('Le lot B28.1x seul')).toBe(false);
  });

  it('R19 — le goal: du lot (ou l\'objectif donné au lancement) est lu comme le titre : un lot antérieur ou un constat cité compte', () => {
    const { repo, plan } = planOf([{ id: 'L1', title: 'Premier' }, { id: 'L2', title: 'Titre périmé', goal: 'Suite de L1 : la mesure' }, { id: 'L3', title: 'Autre' }]);
    expect(needsPrecheck({ precheck: true }, plan, repo, 'L2')).toBe(true);
    expect(needsPrecheck({ precheck: true }, plan, repo, 'L3')).toBe(false);
    expect(needsPrecheck({ precheck: true }, plan, repo, 'L3', [], 'Corriger le constat')).toBe(true);
  });

  it('R20 — « review » compte comme mot, pas dans qa-reviewer ni review-small ; revues, audits, constats comptent', () => {
    expect(need(['Ajouter un qa-reviewer au lot'], 'L1')).toBe(false);
    expect(need(['Le pas review-small voit l\'app'], 'L1')).toBe(false);
    expect(need(['Corriger la review du lot'], 'L1')).toBe(true);
    expect(need(['Suite des revues'], 'L1')).toBe(true);
    expect(need(['Les constats du relecteur'], 'L1')).toBe(true);
  });

  it('R21 — un lot d\'un autre projet cité (cadence:L68) compte comme un lot antérieur, quel que soit le numéro', () => {
    expect(need(['Premier', 'Reprendre cadence:L68 : la mesure'], 'L2')).toBe(true);
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

  it('R13 — un lot sans précheck (aucune étape precheck, donc aucun verdict) n\'entre pas au dénominateur ; sans verdict, la part est n/d', async () => {
    const c = ctx();
    writeJournal(c.runs, 'w1', 'alpha', `L${++seq}`, { status: 'ready', steps: [{ kind: 'implement', ended: `${CUR}T09:00:00` }] });
    lot(c, CUR, 'oui', 'handed-back');
    const d = await json(c.root);
    expect(d.precheck.yes.current).toBe(1);
    expect(d.precheck.yes.lots.current).toBe(1);
    expect(d.precheck.yes.previous).toBeNull();
  });

  it('R17 — un journal d\'avant L288 (sans precheckVerdict) rend son verdict : « oui » si le lot a été rendu « livrable déjà présent », « partiel » s\'il porte un constat de précheck, « non » sinon', async () => {
    const c = ctx();
    const old = (day: string, extra: Record<string, unknown>) => {
      const slug = `L${++seq}`;
      writeJournal(c.runs, 'w1', 'alpha', slug, { status: 'ready', steps: [{ kind: 'precheck', ended: `${day}T08:00:00` }, { kind: 'implement', ended: `${day}T09:00:00` }] });
      const file = join(c.runs, 'w1', `${lotSlug('alpha', slug)}.json`);
      const rec = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify({ ...rec, ...extra }));
    };
    old(CUR, { status: 'handed-back', outcome: 'livrable déjà présent : tout est là (a.ts:1)' });
    old(CUR, { precheck: 'A pre-check found part of the deliverable' });
    old(CUR, {});
    old(CUR, { status: 'handed-back', outcome: 'revue non conforme après 2 passes' });
    const d = await json(c.root);
    expect(d.precheck.yes.lots.current).toBe(4);
    expect(d.precheck.yes.current).toBe(0.25);
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
