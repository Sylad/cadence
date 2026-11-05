import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { lotBudget } from '../src/orchestrate/lot-budget.js';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { newLot } from '../src/orchestrate/state.js';
import { budgetStage, lightLot, lightMaquette, sealedAcceptation, stageScreen } from '../src/orchestrate/spec.js';
import { sealAcceptation } from '../src/orchestrate/accept.js';
import { Plan } from '../src/plan.js';
import { AGENTS_DIR } from '../src/skills.js';
import { acceptReport, claudeOut, commitFile, git, harness, reviewReport, specReport, workReport, type Handler } from './orchestrate-harness.js';
import { ecrit } from './spec-helpers.js';
import { ecritAcceptation } from './accept-helpers.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';
import { writeJournal, writeWave } from './perf-helpers.js';

// L459 (spec maquette-legere-lots-visibles) : la maquette légère des lots visibles sans `screen: page`.
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());
const major: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'docs/specs/prochain-match/maquette.html', ligne: 12, texte: 'le message de R3 n’est pas visible' }], verdict: 'non conforme : 1 majeur' }));
const spec: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }));
const cfg = { maquette: true };
const withUx = { ...cfg, ux: { url: 'http://localhost:4200' } };
/** État d'un lot léger tel que le lancement le pose : visible, `screen` du plan (ou `component` quand le plan n'en a pas). */
const light = { visible: true, screen: 'component' as const };
const lots = [{ title: 'Un composant', screen: 'component' as const, estimate: 0.6 }];

describe('R1 — quels lots entrent dans la chaîne légère', () => {
  it('R1 — lot visible screen: component d\'estimate 0,6 : étapes precheck, spec, maquette, implement, review, ux', async () => {
    const { parent } = parentWith([{ title: 'Un composant, suite du constat de revue', estimate: 0.6, screen: 'component', visible: true }], 'precheck: true\nux:\n  url: http://localhost:4200');
    const r = await dry(parent, ['a:L1']);
    try {
      expect(r.line).toMatch(/étapes : precheck \(\w+\) → spec \(sonnet\) → maquette \(opus\) → implement \(\w+\)(?: → probe \(\w+\))? → review \(\w+\) → ux \(opus\)/);
      expect(r.line).not.toContain('accept (');
    } finally {
      removeDryRunBriefs(r.text);
    }
  });

  it('R1 — lot visible d\'estimate 0,1 (express) : aucune étape spec ni maquette', async () => {
    const { parent } = parentWith([{ title: 'une retouche', estimate: 0.1, visible: true }, { title: 'un composant express', estimate: 0.1, screen: 'component' }]);
    const r = await dry(parent, ['a:L1', 'a:L2']);
    try {
      expect(r.text).not.toMatch(/spec \(|maquette \(/);
    } finally {
      removeDryRunBriefs(r.text);
    }
  });

  it('R1 — lot non visible ou spec: true : chemin ordinaire inchangé', async () => {
    const { parent } = parentWith([{ title: 'non visible', estimate: 0.6 }, { title: 'spec back', estimate: 0.6, visible: true, spec: true }]);
    const r = await dry(parent, ['a:L1', 'a:L2']);
    try {
      const [, plain, back] = r.text.split('étapes :');
      expect(plain).not.toMatch(/spec \(|maquette \(/);
      expect(back).toMatch(/spec \(sonnet\) → fiche \(sonnet\) → implement/);
      expect(back).not.toContain('maquette (');
    } finally {
      removeDryRunBriefs(r.text);
    }
  });

  it('R1 — lot screen: page : chaîne complète avec accept, inchangée', async () => {
    const { parent } = parentWith([{ title: 'une page', estimate: 0.6, screen: 'page' }], 'accept: npx vitest run acceptation');
    const r = await dry(parent, ['a:L1']);
    try {
      expect(r.line).toMatch(/étapes : spec \(sonnet\) → maquette \(opus\) → accept \(sonnet\) → implement/);
      expect(r.text).toContain('budget du lot : 1300000');
    } finally {
      removeDryRunBriefs(r.text);
    }
  });

  it('R1 — lot component après écriture de sa fiche à bloc ecran : toujours léger (sans accept), pas basculé en chaîne complète', async () => {
    const h = harness({ lots, script: { maquette: [ok], implement: [impl], review: [ok] } });
    ecrit(h.repo);
    expect(stageScreen(h.repo, 'docs/specs', h.plan().lot('L1'), true)).toBe('component');
    const c = h.lot('L1', light, { ...cfg, accept: 'true' });
    await runLot(c);
    expect(kinds(h)).toEqual(['maquette', 'implement', 'review']);
  });

  it('R1 — état de lot ancien sans nouveau champ, relu : classement identique, aucune erreur', async () => {
    const h = harness({ lots, script: { spec: [spec], maquette: [ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', light, cfg);
    const relu = JSON.parse(JSON.stringify(c.lot));
    const champs = Object.keys(newLot({ project: 'demo', repo: h.repo, lot: 'L1', title: 't', visible: false, small: false, model: 'sonnet', readOnlyPlan: false }));
    expect(Object.keys(relu).filter((k) => !champs.includes(k) && k !== 'screen' && k !== 'visible')).toEqual([]);
    c.lot = relu;
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'maquette', 'implement', 'review']);
  });

  it('R1 — lightMaquette : les bords du classement (page, journey, sans screen, estimate absent ou nul, non visible)', () => {
    const base = { visible: true, estimate: 0.3 };
    expect(lightMaquette({ ...base, screen: 'journey' }, true)).toBe(true);
    expect(lightMaquette({ ...base }, true)).toBe(false); // sans screen : correctif visible (L633)
    expect(lightMaquette({ ...base, screen: 'page' }, true)).toBe(false);
    expect(lightMaquette({ ...base, estimate: 0.1 }, true)).toBe(false);
    expect(lightMaquette({ ...base, estimate: 0 }, true)).toBe(false);
    expect(lightMaquette({ visible: true }, true)).toBe(false);
    expect(lightMaquette({ ...base, visible: false }, true)).toBe(false);
    expect(lightMaquette({ ...base, spec: true }, true)).toBe(false);
  });
});

describe('R1 — lot déjà entré dans la chaîne complète avec une acceptation scellée (L209, revue L459)', () => {
  it('L209 — lot visible component à acceptation-<lot>.json scellée : garde accept (l.accept posé, rouge scellé), pas la chaîne légère', async () => {
    const h = harness({ lots, script: { implement: [impl], review: [ok] } });
    ecrit(h.repo);
    const a = ecritAcceptation(h.repo, { sansFiche: true });
    sealAcceptation(h.repo, a.json);
    git(h.repo, 'add', '--', a.json);
    git(h.repo, 'commit', '-q', '-m', 'test(L1): acceptation scellée', '--', a.json);
    expect(sealedAcceptation(h.repo, 'docs/specs', 'L1')).toBe(true);
    expect(lightLot(light, h.plan().lot('L1'), true, h.repo, 'docs/specs')).toBe(false);
    expect(budgetStage(h.plan().lot('L1'), 'component', true, h.repo, 'docs/specs')).toBe('screen');
    const c = h.lot('L1', { ...light, maquette: { passes: 1, conforme: true, verdict: 'conforme' } }, { ...cfg, accept: 'true', test: 'true' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.accept?.acceptation).toBe(a.json);
    expect(c.lot.accept?.rouge).toMatch(/^[0-9a-f]{40}$/);
  });

  it('L209 — dry-run : lot visible component à acceptation scellée annonce accept et le budget d\'écran de 1,3 M', async () => {
    const { parent, dir } = parentWith([{ title: 'un composant', estimate: 0.6, screen: 'component', visible: true }], 'accept: npx vitest run acceptation');
    mkdirSync(join(dir, 'docs/specs/carte'), { recursive: true });
    writeFileSync(join(dir, 'docs/specs/carte/fiche.yaml'), 'ecran:\n  id: carte\n  lot: L1\n');
    writeFileSync(join(dir, 'docs/specs/carte/acceptation-L1.json'), '{}');
    const r = await dry(parent, ['a:L1']);
    try {
      expect(r.line).toMatch(/spec \(sonnet\) → maquette \(opus\) → accept \(sonnet\) → implement/);
      expect(r.text).toContain('budget du lot : 1300000');
    } finally {
      removeDryRunBriefs(r.text);
    }
  });
});

describe('R2 — orchestrate.maquette: false', () => {
  it('R2 — orchestrate.maquette: false : lot component sans étape spec ni maquette', async () => {
    const { parent } = parentWith([{ title: 'un composant', estimate: 0.4, screen: 'component', visible: true }, { title: 'sans screen', estimate: 0.4, visible: true }], 'maquette: false');
    const r = await dry(parent, ['a:L1', 'a:L2']);
    try {
      expect(r.text).not.toMatch(/spec \(|maquette \(/);
      expect(r.text.match(/budget du lot : 600000/g)).toHaveLength(2);
    } finally {
      removeDryRunBriefs(r.text);
    }
  });
});

describe('R3 — lot qui ne change aucun écran', () => {
  it('R3 — lot component sans changement d\'écran : sousSeuil, aucune fiche, étape suivante implement', async () => {
    const h = harness({ lots, script: { spec: [() => claudeOut(specReport({ sousSeuil: 'le lot ne change que le nom d\'une classe CSS interne' }))], implement: [impl], review: [ok] } });
    const c = h.lot('L1', light, cfg);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'implement', 'review']);
    expect(c.lot.spec).toEqual({ sousSeuil: 'le lot ne change que le nom d\'une classe CSS interne' });
    expect(c.lot.warnings.join('\n')).toContain('sous le seuil');
    expect(git(h.repo, 'ls-files', 'docs/specs').trim()).toBe('');
  });
});

describe('R3 — une retouche de composant n\'est pas sous le seuil (revue L459)', () => {
  it('R3 — le brief spec d\'un lot léger réserve sousSeuil au lot qui ne change rien de visible : une retouche de composant écrit sa maquette', async () => {
    const h = harness({ lots, script: { spec: [spec], maquette: [ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', light, cfg));
    const b = h.calls.find((c) => c.kind === 'spec')!.brief;
    expect(b).not.toContain('(no new page)');
    expect(b).toContain('changes nothing the user can see');
    expect(b).toContain('A change to a component, a state, a text or a style of an existing screen is NOT under the threshold');
    expect(b).toContain('only the states the lot touches');
  });
});

describe('R4/R10 — captures de l\'écran actuel et de la version visée', () => {
  const briefs = async () => {
    const h = harness({ lots, script: { spec: [spec], maquette: [ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', light, cfg));
    return { spec: h.calls.find((c) => c.kind === 'spec')!.brief, maquette: h.calls.find((c) => c.kind === 'maquette')!.brief };
  };

  it('R4 — le brief spec du lot léger nomme actuel-<état>-<largeur>.png et maquette-<état>-<largeur>.png pour chaque état touché', async () => {
    const { spec: b } = await briefs();
    expect(b).toContain('actuel-<état>-<largeur>.png');
    expect(b).toContain('maquette-<état>-<largeur>.png');
    expect(b).toContain('1440 and 390');
    expect(b).toContain('only the states the lot touches');
    expect(b).not.toMatch(/\{\{/);
  });

  it('R4 — écran actuel non capturable : nonVerifie renseigné et aucune capture actuelle fabriquée (consigne du brief)', async () => {
    const { spec: b } = await briefs();
    expect(b).toContain('say so under "nonVerifie"');
    expect(b).toContain('never invent a capture of the current screen');
  });

  it('R4 — le brief spec d\'un lot screen: page ne parle pas de captures actuelles', async () => {
    const h = harness({ lots: [{ title: 'Une page', screen: 'page' as const }], script: { spec: [spec], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', { visible: true, screen: 'page' }, { maquette: false }));
    expect(h.calls[0].brief).not.toContain('actuel-');
  });

  it('R10 — le brief maquette du lot léger nomme actuel-<état>-<largeur>.png', async () => {
    const { maquette: b } = await briefs();
    expect(b).toContain('actuel-<état>-<largeur>.png');
    expect(b).toContain('Light mockup');
  });

  it('R10 — le brief maquette d\'un lot screen: page ne parle pas de captures actuelles', async () => {
    const h = harness({ lots: [{ title: 'Une page', screen: 'page' as const }], script: { spec: [spec], maquette: [ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', { visible: true, screen: 'page' }, cfg));
    expect(h.calls.find((c) => c.kind === 'maquette')!.brief).not.toContain('actuel-');
  });
});

describe('R5 — contrôles du programme sur la fiche légère', () => {
  it('R5 — fiche légère sans capture visée à 390 px : renvoyée à une session spec avec le point nommé', async () => {
    const m: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd, { sansCapture: ['maquette-erreur-390.png'] }) }));
    const h = harness({ lots, script: { spec: [m, spec], maquette: [ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', light, cfg);
    await runLot(c);
    expect(kinds(h).slice(0, 3)).toEqual(['spec', 'spec', 'maquette']);
    expect(h.calls[1].brief).toContain('maquette-erreur-390.png');
  });

  it('R5 — fiche légère avec une hypothèse coûteuse : le lot passe en question', async () => {
    const m: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd, { fiche: (d) => { d.regles[2].si_faux = 'Si faux, une migration du stockage des rappels serait à écrire.'; } }) }));
    const h = harness({ lots, script: { spec: [m] } });
    const c = h.lot('L1', light, cfg);
    await runLot(c);
    expect(c.lot.status).toBe('question');
    expect(c.lot.questions[0]).toContain('R3');
    expect(kinds(h)).toEqual(['spec']);
  });

  it('R5 — absence des captures actuel-* : aucun renvoi', async () => {
    const h = harness({ lots, script: { spec: [spec], maquette: [ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', light, cfg);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'maquette', 'implement', 'review']);
    expect(c.lot.specProblems).toBeUndefined();
  });
});

describe('R6 — la boucle de revue de la maquette légère', () => {
  it('R6 — maquette légère non conforme à la 3e revue : lot rendu avec le message de maquette non conforme', async () => {
    const h = harness({ lots, script: { spec: [spec, spec, spec], maquette: [major, major, major] } });
    const c = h.lot('L1', light, cfg);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'maquette', 'spec', 'maquette', 'spec', 'maquette']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('maquette non conforme après 3 revues : ');
  });

  it('R6 — maquette légère conforme à la 1re revue : étape suivante implement sans session spec de plus', async () => {
    const h = harness({ lots, script: { spec: [spec], maquette: [ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', light, cfg);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'maquette', 'implement', 'review']);
    expect(c.lot.maquette).toMatchObject({ passes: 1, conforme: true });
  });

  it('R6 — maquetteReviews: 1 : la 1re revue non conforme rend le lot', async () => {
    const h = harness({ lots, script: { spec: [spec], maquette: [major] } });
    const c = h.lot('L1', light, { ...cfg, maquetteReviews: 1 });
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'maquette']);
    expect(c.lot.outcome).toContain('maquette non conforme après 1 revue : ');
  });

  it('R6 — lot component : la boucle va aussi jusqu\'à maquetteReviews revues, pas le plafond de 2', async () => {
    const h = harness({ lots: [{ title: 'Une retouche', screen: 'component', estimate: 0.6 }], script: { spec: [spec, spec, spec], maquette: [major, major, major] } });
    const c = h.lot('L1', light, cfg);
    await runLot(c);
    expect(kinds(h)).toHaveLength(6);
    expect(c.lot.outcome).toContain('maquette non conforme après 3 revues : ');
  });
});

describe('R7 — la passe ux de conformité', () => {
  it('R7 — lot léger : le brief ux contient la conformité à la maquette et ses captures', async () => {
    const h = harness({ lots, script: { spec: [spec], maquette: [ok], implement: [impl], review: [ok], ux: [ok] } });
    await runLot(h.lot('L1', light, withUx));
    const b = h.calls.find((c) => c.kind === 'ux')!.brief;
    expect(b).toContain('this pass is a conformity pass, not the full audit');
    expect(b).toContain('docs/specs/prochain-match/maquette-<état>-<largeur>.png');
  });

  it('R7 — petit lot visible léger : review-small avec le brief de conformité', async () => {
    const h = harness({ lots, script: { spec: [spec], maquette: [ok], implement: [impl], 'review-small': [ok] } });
    await runLot(h.lot('L1', { ...light, small: true }, withUx));
    expect(kinds(h)).toEqual(['spec', 'maquette', 'implement', 'review-small']);
    const b = h.calls.at(-1)!.brief;
    expect(b).toContain('this pass is a conformity pass, not the full audit');
    expect(b).toContain('docs/specs/prochain-match/maquette-<état>-<largeur>.png');
  });

  it('R7 — sans orchestrate.ux : aucune session ux et la note « UX à faire par le lead » est écrite', async () => {
    const h = harness({ lots, script: { spec: [spec], maquette: [ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', light, cfg);
    await runLot(c);
    expect(kinds(h)).not.toContain('ux');
    expect(c.lot.uxNote).toMatch(/UX à faire par le lead/);
  });
});

describe('R8 — la mesure « sessions ux par lot visible »', () => {
  const perf = async (c: { root: string }) => {
    const out: string[] = [];
    await run(['perf', '--json'], { cwd: c.root, env: { RAF_TODAY: '2026-10-16' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-10-16T10:00:00') });
    return JSON.parse(out.join('\n'));
  };
  const ctx = () => {
    const root = tempDir();
    const runs = join(root, '.cadence', 'runs');
    mkdirSync(runs, { recursive: true });
    writeWave(runs, 'w1', '2026-10-01T08:00:00');
    return { root, runs };
  };

  it('R8 — 3 sessions ux sur 2 lots visibles = 1,5 (formule inchangée)', async () => {
    const c = ctx();
    const day = '2026-10-12';
    const steps = (...k: string[]) => [{ kind: 'implement', ended: `${day}T09:00:00` }, ...k.map((kind) => ({ kind, ended: `${day}T10:00:00` }))];
    writeJournal(c.runs, 'w1', 'alpha', 'L1', { status: 'ready', visible: true, steps: steps('spec', 'maquette', 'review', 'ux') });
    writeJournal(c.runs, 'w1', 'alpha', 'L2', { status: 'ready', visible: true, steps: steps('review', 'ux', 'fix', 'review', 'ux') });
    expect((await perf(c)).interventions.ux.current).toBe(1.5);
  });

  it('R8 — fenêtre sans lot visible rendu : aucune valeur, pas de division par zéro', async () => {
    const c = ctx();
    writeJournal(c.runs, 'w1', 'alpha', 'L1', { status: 'ready', visible: false, steps: [{ kind: 'implement', ended: '2026-10-12T09:00:00' }, { kind: 'ux', ended: '2026-10-12T10:00:00' }] });
    const v = (await perf(c)).interventions.ux.current;
    expect(v === null || v === undefined).toBe(true);
  });
});

describe('R9 — reprise', () => {
  it('R9 — reprise d\'un lot léger avec fiche valide et maquette conforme : étape suivante implement', async () => {
    const h = harness({ lots, script: { implement: [impl], review: [ok] } });
    ecrit(h.repo);
    const c = h.lot('L1', { ...light, maquette: { passes: 1, conforme: true, verdict: 'conforme' } }, cfg);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('R9 — fiche valide et code déjà commité après elle : ni spec ni maquette rejouées', async () => {
    const h = harness({ lots, script: { review: [ok] } });
    ecrit(h.repo);
    commitFile(h.repo, 'a.txt', 'feat(L1): a');
    await runLot(h.lot('L1', light, cfg));
    expect(kinds(h)).not.toContain('spec');
    expect(kinds(h)).not.toContain('maquette');
  });
});

describe('R11 — pas d\'étape accept', () => {
  it('R11 — lot léger avec orchestrate.accept déclaré : la chaîne n\'a pas d\'étape accept', async () => {
    const accept: Handler = (call) => {
      ecritAcceptation(call.opts.cwd, { sansFiche: true });
      return claudeOut(acceptReport());
    };
    const h = harness({ lots, script: { spec: [spec], maquette: [ok], accept: [accept], implement: [impl], review: [ok] } });
    const c = h.lot('L1', light, { ...cfg, accept: 'true', test: 'true' });
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'maquette', 'implement', 'review']);
    expect(c.lot.warnings.join('\n')).not.toContain('étape accept');
  });
});

describe('R12 — budget', () => {
  it('R12 — budget d\'un lot léger d\'estimate 0,3 = ordinaire + 450 000', async () => {
    const { parent } = parentWith([{ title: 'un composant', estimate: 0.3, screen: 'component', visible: true }]);
    const r = await dry(parent, ['a:L1']);
    try {
      expect(r.text).toContain('budget du lot : 1050000 tokens comptés (base : 600000 dérivés de l\'estimate (plancher d\'un lot jusqu\'à 0,5 j), plus 450000 pour les étapes spec et maquette)');
    } finally {
      removeDryRunBriefs(r.text);
    }
    expect(lotBudget(0.3, 'light')).toBe(lotBudget(0.3) + 450_000);
    expect(budgetStage({ id: 'L1', visible: true, estimate: 0.3, screen: 'component' }, 'component', true, tempDir(), 'docs/specs')).toBe('light');
  });

  it('R12 — budget d\'un lot screen: page inchangé', () => {
    expect(budgetStage({ id: 'L1', visible: true, estimate: 0.3, screen: 'page' }, 'page', true, tempDir(), 'docs/specs')).toBe('screen');
    expect(lotBudget(0.3, 'screen')).toBe(1_300_000);
    expect(budgetStage({ id: 'L1', visible: true, spec: true, estimate: 0.3 }, undefined, true, tempDir(), 'docs/specs')).toBe('spec');
  });
});

describe('agents — la maquette légère est dite dans les deux agents', () => {
  it('R4/R10 — spec-writer.md et ux-reviewer.md décrivent les captures actuel-* d\'une maquette légère', () => {
    for (const a of ['spec-writer', 'ux-reviewer']) {
      const text = readFileSync(join(AGENTS_DIR, `${a}.md`), 'utf8');
      expect(text, a).toContain('actuel-<état>-<largeur>.png');
    }
  });
});

// ——— bancs ———

interface Lot { title: string; estimate?: number; visible?: boolean; screen?: 'page' | 'component' | 'journey'; spec?: boolean }

/** Un projet `a` (un dépôt git, un plan) ; `orch` : lignes de la section `orchestrate:` de cadence.yaml (le contrôle préalable est coupé sauf mention). */
function parentWith(lotsOf: Lot[], orch = ''): { parent: string; dir: string } {
  const parent = tempDir();
  const dir = join(parent, 'a');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'a', 'L', '2026-09-01');
  for (const l of lotsOf) plan.add(l.title, '2026-10-01', { estimate: l.estimate ?? 1, visible: l.visible || !!l.screen, screen: l.screen, spec: l.spec });
  plan.save();
  const lines = orch.split('\n').filter(Boolean);
  const withPrecheck = lines.some((x) => x.startsWith('precheck:'));
  writeFileSync(join(dir, 'cadence.yaml'), `orchestrate:\n${[...(withPrecheck ? [] : ['precheck: false']), ...lines].map((x) => `  ${x}`).join('\n')}\n`);
  git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
  git(dir, 'commit', '-qm', 'chore: plan');
  return { parent, dir };
}

async function dry(cwd: string, lotsArg: string[]): Promise<{ text: string; line: string }> {
  const out: string[] = [];
  const io: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-10-04', CADENCE_HOME: tempDir() }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date('2026-10-04T14:12:00') };
  const deps: OrchestrateDeps = { claude: async () => { throw new Error('pas de session en simulation'); }, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR };
  await orchestrate([...lotsArg, '--dry-run'], io, deps);
  const text = out.join('\n');
  return { text, line: text.split('\n').find((l) => l.includes('étapes :')) ?? '' };
}
