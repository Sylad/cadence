import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { ecritAcceptation } from './accept-helpers.js';
import { sealAcceptation, setVert } from '../src/orchestrate/accept.js';
import { acceptReport, claudeOut, commitFile, git, harness, reviewReport, specReport, workReport, type Handler } from './orchestrate-harness.js';
import { EXEMPLE_BACK, ecrit, ecritBack, ficheBack } from './spec-helpers.js';
import { checkSpec, findFiche, hypothesisLines } from '../src/orchestrate/spec.js';
import { readAgents } from '../src/orchestrate/launch.js';
import { AGENTS_DIR } from '../src/skills.js';
import { lotBudget, SPEC_STAGE_ALLOCATION } from '../src/orchestrate/command.js';

// L188 (spec etape-spec-back, B3) : l'étape spec d'un lot sans écran (`spec: true`) — spec → revue de la fiche → accept → implement.
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());
const lots = [{ title: 'Un comportement', spec: true }];
const back = { specLot: true as const };
const config = { fiche: true };
const spec: Handler = (call) => claudeOut(specReport({ fiche: ecritBack(call.opts.cwd) }));
const major = (texte = 'R5 : la source citée ne dit pas cela') => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'lineup.service.ts', ligne: 42, texte }], verdict: 'non conforme' }));

describe('étape spec back : où elle s’insère', () => {
  it('spec → revue de fiche → implement → revue, la revue de fiche est mémorisée', async () => {
    const h = harness({ lots, script: { spec: [spec], fiche: [ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'fiche', 'implement', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.fiche).toMatchObject({ passes: 1, conforme: true });
    expect(c.lot.spec).toMatchObject({ fiche: 'docs/specs/cache-de-secours-365scores/fiche.yaml' });
  });

  it('la revue de fiche est faite par code-reviewer en Sonnet, avec la fiche dans le brief', async () => {
    const h = harness({ lots, script: { spec: [spec], fiche: [ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', back, config));
    const call = h.calls.find((x) => x.kind === 'fiche')!;
    expect(call.args[call.args.indexOf('--agent') + 1]).toBe('code-reviewer');
    expect(call.model).toBe('sonnet');
    expect(call.brief).toContain('docs/specs/cache-de-secours-365scores/fiche.yaml');
    expect(call.brief).toMatch(/first review/);
  });

  it('le brief de la spec back ne parle ni de maquette ni de captures, et joint le gabarit de la fiche back', async () => {
    const h = harness({ lots, script: { spec: [spec], fiche: [ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', back, config));
    const brief = h.calls.find((x) => x.kind === 'spec')!.brief;
    expect(brief).toContain('sujet:');
    expect(brief).toContain('contrats:');
    expect(brief).not.toMatch(/maquette|mockup|1440/i);
    expect(brief).toContain('docs/specs/<sujet>/fiche.yaml');
  });

  it('avec orchestrate.accept : spec → fiche → accept → implement, et le brief d’accept n’a pas de maquette', async () => {
    const accept: Handler = (call) => {
      ecritAcceptation(call.opts.cwd, { sansFiche: true, ecran: 'cache-de-secours-365scores', exemple: EXEMPLE_BACK });
      return claudeOut(acceptReport());
    };
    const h = harness({ lots, script: { spec: [spec], fiche: [ok], accept: [accept], implement: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'done.flag', 'feat(L1): a')] }))], review: [ok] } });
    await runLot(h.lot('L1', back, { ...config, accept: 'test -f done.flag', test: 'true' }));
    expect(kinds(h)).toEqual(['spec', 'fiche', 'accept', 'implement', 'review']);
    const brief = h.calls.find((x) => x.kind === 'accept')!.brief;
    expect(brief).not.toMatch(/maquette|mockup|data-testid/i);
    expect(brief).toMatch(/contrats/);
  });

  it('orchestrate.fiche: false : la revue de la fiche n’a pas lieu', async () => {
    const h = harness({ lots, script: { spec: [spec], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', back, { fiche: false }));
    expect(kinds(h)).toEqual(['spec', 'implement', 'review']);
  });

  it('un lot sans screen: ni spec: garde le chemin actuel', async () => {
    const h = harness({ script: { implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', {}, config));
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('une fiche déjà commitée (reprise) est relue avant implement, sans rejouer la spec', async () => {
    const h = harness({ lots, script: { fiche: [ok], implement: [impl], review: [ok] } });
    ecritBack(h.repo);
    await runLot(h.lot('L1', back, config));
    expect(kinds(h)).toEqual(['fiche', 'implement', 'review']);
  });

  it('une sortie sous le seuil (le lot ne change aucun comportement) rend le lot au chemin actuel', async () => {
    const h = harness({ lots, script: { spec: [() => claudeOut(specReport({ sousSeuil: 'renommage sans effet observable' }))], implement: [impl], review: [ok] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'implement', 'review']);
    expect(c.lot.warnings.join('\n')).toMatch(/sous le seuil.*renommage/);
    expect(c.lot.warnings.join('\n')).not.toMatch(/maquette/);
  });
});

describe('étape spec back : conformité de la fiche écrite', () => {
  it('une fiche d’un autre lot est un écart, rendu à une seconde passe puis au lead', async () => {
    const mauvaise: Handler = (call) => claudeOut(specReport({ fiche: ecritBack(call.opts.cwd, { fiche: (d) => (d.sujet.lot = 'L99') }) }));
    const h = harness({ lots, script: { spec: [mauvaise, mauvaise] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'spec']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/sujet\.lot.*L99/);
    expect(h.calls[1].brief).toMatch(/sujet\.lot/);
  });

  it('une fiche sans bloc sujet est un écart', async () => {
    const h = harness({ lots, script: { spec: [(call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) })), (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }))] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(c.lot.outcome).toMatch(/sujet : bloc manquant/);
  });

  it('une fiche écrite mais non commitée est un écart de checkSpec', () => {
    const h = harness({ lots });
    const fiche = ecritBack(h.repo, { sansCommit: true });
    expect(checkSpec(h.repo, fiche, 'L1', { screen: false, back: true }).join('\n')).toMatch(/fiche non commité/);
  });
});

describe('étape spec back : messages d\'un lot sans écran', () => {
  it('une fiche hors du dossier des specs parle de <sujet>, jamais de <écran>', async () => {
    const hors: Handler = () => claudeOut(specReport({ fiche: 'autre/dossier/fiche.yaml' }));
    const h = harness({ lots, script: { spec: [hors, hors] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(c.lot.outcome).toMatch(/<sujet>/);
    expect(c.lot.outcome).not.toMatch(/<écran>/);
    expect(h.calls[1].brief).not.toMatch(/<écran>/);
  });
});

describe('étape spec back : revue de la fiche, deux passes au plus', () => {
  it('un majeur renvoie à la spec avec les constats, puis la fiche est relue', async () => {
    const h = harness({ lots, script: { spec: [spec, () => claudeOut(specReport({ fiche: 'docs/specs/cache-de-secours-365scores/fiche.yaml' }))], fiche: [() => major(), ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'fiche', 'spec', 'fiche', 'implement', 'review']);
    expect(h.calls[2].brief).toContain('R5 : la source citée ne dit pas cela');
    expect(h.calls[2].brief).toContain('lineup.service.ts:42');
    expect(h.calls[3].brief).toMatch(/second and last review/);
    expect(h.calls[3].brief).toContain('Points of the first review that the spec writer had to fix:');
    expect(h.calls[3].brief).toContain('- [majeur] lineup.service.ts:42 — R5 : la source citée ne dit pas cela');
    expect(h.calls[1].brief).not.toContain('Points of the first review');
    expect(c.lot.fiche).toMatchObject({ passes: 2, conforme: true });
  });

  it('non conforme après deux revues : rendu au lead avec les constats', async () => {
    const h = harness({ lots, script: { spec: [spec, () => claudeOut(specReport({ fiche: 'docs/specs/cache-de-secours-365scores/fiche.yaml' }))], fiche: [() => major(), () => major('R5 : toujours pas sourcée')] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'fiche', 'spec', 'fiche']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/fiche non conforme après 2 revues/);
    expect(c.lot.outcome).toContain('R5 : toujours pas sourcée');
  });

  it('les mineurs vont en notes du lot, sans renvoyer à la spec ni devenir des propositions du tableau final', async () => {
    const minor = () => claudeOut(reviewReport({ mineurs: 1, constats: [{ gravite: 'mineur', fichier: 'x.ts', ligne: 3, texte: 'un test au nom vague' }] }));
    const h = harness({ lots, script: { spec: [spec], fiche: [minor], implement: [impl], review: [ok] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'fiche', 'implement', 'review']);
    const notes = h.plan().lot('L1').notes.map((n) => n.text).filter((t) => t.startsWith('Revue de la fiche'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/mineur.*x\.ts:3.*un test au nom vague/);
    expect(c.lot.proposals.join('\n')).not.toMatch(/un test au nom vague/);
  });

  it('un mineur déjà noté n\'est pas noté deux fois (reprise)', async () => {
    const minor = () => claudeOut(reviewReport({ mineurs: 1, constats: [{ gravite: 'mineur', texte: 'nom vague' }] }));
    const h = harness({ lots, script: { spec: [spec], fiche: [minor, minor], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', back, config));
    const again = h.lot('L1', back, config);
    again.lot.spec = undefined;
    again.lot.next = null;
    again.lot.status = 'queued';
    again.lot.fiche = undefined;
    await runLot(again);
    expect(h.plan().lot('L1').notes.filter((n) => n.text.startsWith('Revue de la fiche'))).toHaveLength(1);
  });
});

describe('étape spec back : hypothèses', () => {
  it('une ligne de note du lot par hypothèse, avec son si_faux, posée par le programme et commitée', async () => {
    const h = harness({ lots, script: { spec: [spec], fiche: [ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    const notes = h.plan().lot('L1').notes.map((n) => n.text);
    expect(notes.some((t) => /^Hypothèses \(fiche cache-de-secours-365scores\) — R3 : .*cacheAgeSeconds/.test(t))).toBe(true);
    expect(c.lot.hypotheses?.[0]).toMatch(/^R3 : /);
  });

  it('une reprise ne pose pas la note deux fois', async () => {
    const h = harness({ lots, script: { spec: [spec], fiche: [ok, ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', back, config));
    const again = h.lot('L1', back, config);
    again.lot.spec = undefined;
    again.lot.next = null;
    again.lot.status = 'queued';
    again.lot.fiche = undefined;
    await runLot(again);
    const n = h.plan().lot('L1').notes.filter((x) => x.text.startsWith('Hypothèses (fiche')).length;
    expect(n).toBe(3); // R3, R5 et R8 de l'exemple, une fois chacune
  });

  it('une seconde passe qui change ou retire une hypothèse : les notes disent la fiche finale, pas celle de la passe 1', async () => {
    const pass2: Handler = (call) => claudeOut(specReport({ fiche: ecritBack(call.opts.cwd, { fiche: (d) => { d.regles.find((r: any) => r.id === 'R3').enonce = 'Énoncé réécrit en passe deux'; d.regles.find((r: any) => r.id === 'R5').statut = 'sourcee'; d.regles.find((r: any) => r.id === 'R5').source = 'lineup.service.ts:42'; delete d.regles.find((r: any) => r.id === 'R5').si_faux; } }) }));
    const h = harness({ lots, script: { spec: [spec, pass2], fiche: [() => major(), ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    const notes = h.plan().lot('L1').notes.map((n) => n.text).filter((t) => t.startsWith('Hypothèses (fiche'));
    expect(notes.join('\n')).toContain('Énoncé réécrit en passe deux');
    expect(notes.join('\n')).not.toMatch(/R5 : /);
    expect(notes).toHaveLength(2);
    expect(c.lot.hypotheses).toHaveLength(2);
  });

  it('une fiche déjà présente à la reprise donne ses notes et ses lignes du tableau', async () => {
    const h = harness({ lots, script: { fiche: [ok], implement: [impl], review: [ok] } });
    ecritBack(h.repo);
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(h.plan().lot('L1').notes.filter((n) => n.text.startsWith('Hypothèses (fiche cache-de-secours-365scores)'))).toHaveLength(3);
    expect(c.lot.hypotheses).toHaveLength(3);
  });

  it('une fiche rendue au lead (non conforme après 2 revues) ne laisse aucune note d\'hypothèse', async () => {
    const h = harness({ lots, script: { spec: [spec, () => claudeOut(specReport({ fiche: 'docs/specs/cache-de-secours-365scores/fiche.yaml' }))], fiche: [() => major(), () => major()] } });
    await runLot(h.lot('L1', back, config));
    expect(h.plan().lot('L1').notes.filter((n) => n.text.startsWith('Hypothèses (fiche'))).toEqual([]);
  });

  it('plan en lecture seule : les hypothèses deviennent des propositions « [note à poser] », le plan n\'est pas touché', async () => {
    const h = harness({ lots, script: { fiche: [ok], implement: [impl], review: [ok] } });
    ecritBack(h.repo);
    const c = h.lot('L1', { ...back, readOnlyPlan: true }, { ...config, start: 'true' });
    const plan = c.loadPlan;
    c.loadPlan = () => {
      const p = plan();
      Object.defineProperty(p, 'readonly', { get: () => true });
      return p;
    };
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(h.plan().lot('L1').notes.filter((n) => n.text.startsWith('Hypothèses (fiche'))).toEqual([]);
    expect(c.lot.proposals.filter((p) => p.startsWith('[note à poser] Hypothèses (fiche cache-de-secours-365scores)'))).toHaveLength(3);
  });

  it('un arbre sale hors plan au moment de commiter les notes rend le lot', async () => {
    const h = harness({ lots, script: { fiche: [ok], implement: [impl], review: [ok] } });
    ecritBack(h.repo);
    writeFileSync(join(h.repo, 'stray.txt'), 'a');
    git(h.repo, 'add', 'stray.txt');
    git(h.repo, 'commit', '-q', '-m', 'chore: stray');
    const c = h.lot('L1', back, config);
    const plan = c.loadPlan;
    c.loadPlan = () => {
      const p = plan();
      const save = p.save.bind(p);
      p.save = () => {
        save();
        if (h.calls.length) writeFileSync(join(h.repo, 'stray.txt'), 'b'); // un outil du projet touche un autre fichier suivi pendant la pose des notes
      };
      return p;
    };
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/notes des hypothèses de la fiche : arbre sale.*stray\.txt/);
  });

  it('un lot à écran garde ses hypothèses pour la Nouveauté : pas de note', async () => {
    const h = harness({ lots: [{ title: 'Un écran', screen: 'page' }], script: { spec: [(call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }))], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', { screen: 'page', visible: true }, { maquette: false }));
    expect(h.plan().lot('L1').notes.filter((n) => n.text.startsWith('Hypothèses'))).toEqual([]);
  });
});

describe('étape spec back : lot mixte', () => {
  const mixte: Handler = (call) => claudeOut(specReport({ fiche: ecritBack(call.opts.cwd, { mixte: true }) }));
  const mixteLots = [{ title: 'Un écran et son API', screen: 'page' as const }];
  // Un lot mixte est un lot `screen:` dont la fiche a une partie sujet : jamais un champ `spec: true` à côté de `screen:` (décision du lead, 11-10).
  const over = { screen: 'page' as const, visible: true };

  it('spec → revue de fiche → revue de maquette → implement', async () => {
    const h = harness({ lots: mixteLots, script: { spec: [mixte], fiche: [ok], maquette: [ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', over, { fiche: true, maquette: true }));
    expect(kinds(h)).toEqual(['spec', 'fiche', 'maquette', 'implement', 'review']);
  });

  it('les constats des deux revues partent ensemble à une seule passe 2', async () => {
    const again: Handler = (call) => claudeOut(specReport({ fiche: ecritBack(call.opts.cwd, { mixte: true, fiche: () => undefined }) }));
    const h = harness({ lots: mixteLots, script: { spec: [mixte, again], fiche: [() => major('R5 : source introuvable'), ok], maquette: [() => major('le message de R12 n’est pas visible'), ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', over, { fiche: true, maquette: true }));
    expect(kinds(h)).toEqual(['spec', 'fiche', 'maquette', 'spec', 'fiche', 'maquette', 'implement', 'review']);
    const second = h.calls[3].brief;
    expect(second).toContain('R5 : source introuvable');
    expect(second).toContain('le message de R12 n’est pas visible');
  });
  it('une passe 2 qui retire la partie back : les constats de fiche ne rebouclent pas sur la spec', async () => {
    const again: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }));
    const h = harness({ lots: mixteLots, script: { spec: [mixte, again], fiche: [() => major('R5 : source introuvable')], maquette: [ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', over, { fiche: true, maquette: true }));
    expect(kinds(h)).toEqual(['spec', 'fiche', 'maquette', 'spec', 'implement', 'review']);
    expect(h.calls.filter((x) => x.kind === 'spec')).toHaveLength(2);
  });
});

describe('étape spec back : lot mixte jugé sur le contenu de la fiche', () => {
  const ecran: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }));
  const over = { screen: 'page' as const, visible: true };

  it('un lot à écran dont la fiche n\'a pas de sujet n\'a pas de revue de fiche', async () => {
    const h = harness({ lots: [{ title: 'Un écran', screen: 'page' }], script: { spec: [ecran], maquette: [ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', over, { fiche: true, maquette: true }));
    expect(kinds(h)).toEqual(['spec', 'maquette', 'implement', 'review']);
  });

  it('une fiche d\'écran qui contient des contrats (bloc sujet) est revue, puis la maquette', async () => {
    const mixte: Handler = (call) => claudeOut(specReport({ fiche: ecritBack(call.opts.cwd, { mixte: true }) }));
    const h = harness({ lots: [{ title: 'Un écran', screen: 'page' }], script: { spec: [mixte], fiche: [ok], maquette: [ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', over, { fiche: true, maquette: true }));
    expect(kinds(h)).toEqual(['spec', 'fiche', 'maquette', 'implement', 'review']);
  });

  it('une fiche mixte déjà commitée (reprise) est revue avant la maquette, sans rejouer la spec', async () => {
    const h = harness({ lots: [{ title: 'Un écran', screen: 'page' }], script: { fiche: [ok], maquette: [ok], implement: [impl], review: [ok] } });
    ecritBack(h.repo, { mixte: true });
    await runLot(h.lot('L1', over, { fiche: true, maquette: true }));
    expect(kinds(h)).toEqual(['fiche', 'maquette', 'implement', 'review']);
  });

  it('le brief de la spec d\'un lot à écran propose la partie back (gabarit joint), sans la dire obligatoire', async () => {
    const h = harness({ lots: [{ title: 'Un écran', screen: 'page' }], script: { spec: [ecran], maquette: [ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', over, { fiche: true, maquette: true }));
    const brief = h.calls[0].brief;
    expect(brief).toContain('contrats:');
    expect(brief).toMatch(/also changes a behaviour|also exposes/i);
    expect(brief).not.toContain('spec: true');
  });
});

describe('étape spec back : la fiche vue en aval', () => {
  it('l’implémenteur et la revue de code reçoivent la fiche back (cas, règles, contrats), sans maquette', async () => {
    const h = harness({ lots, script: { spec: [spec], fiche: [ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', back, config));
    const i = h.calls.find((x) => x.kind === 'implement')!.brief;
    expect(i).toContain('docs/specs/cache-de-secours-365scores/fiche.yaml');
    expect(i).toMatch(/R1 \[C1, C2, sourcee\]/);
    expect(i).not.toMatch(/undefined|maquette|mockup/i);
    const r = h.calls.find((x) => x.kind === 'review')!.brief;
    expect(r).toMatch(/contract|contrat/i);
    expect(r).not.toMatch(/undefined|maquette|mockup/i);
  });
});

describe('étape spec back : briques', () => {
  it('findFiche retrouve la fiche d\'un lot back par sujet.lot, et celle d\'un lot mixte par l\'un ou l\'autre', () => {
    const h = harness({ lots });
    ecritBack(h.repo);
    expect(findFiche(h.repo, 'docs/specs', 'L1')).toBe('docs/specs/cache-de-secours-365scores/fiche.yaml');
    expect(findFiche(h.repo, 'docs/specs', 'L2')).toBeNull();
  });

  it('checkSpec d\'un lot back : fiche valide sans écart, fiche mixte sans sujet pour un lot spec: true', () => {
    const h = harness({ lots });
    const ok = ecritBack(h.repo);
    expect(checkSpec(h.repo, ok, 'L1', { screen: false, back: true })).toEqual([]);
    const screenOnly = ecrit(h.repo);
    expect(checkSpec(h.repo, screenOnly, 'L1', { screen: false, back: true }).join('\n')).toMatch(/sujet : bloc manquant/);
    expect(checkSpec(h.repo, screenOnly, 'L1', { screen: true, back: true }).join('\n')).toMatch(/sujet : bloc manquant/);
    expect(checkSpec(h.repo, screenOnly, 'L1')).toEqual([]);
  });

  it('checkSpec d\'un lot back : sujet.id qui ne correspond pas au dossier de la fiche est un écart', () => {
    const h = harness({ lots });
    const ok = ecritBack(h.repo);
    const autre = 'docs/specs/un-autre-dossier/fiche.yaml';
    mkdirSync(join(h.repo, 'docs/specs/un-autre-dossier'), { recursive: true });
    copyFileSync(join(h.repo, ok), join(h.repo, autre));
    const problems = checkSpec(h.repo, autre, 'L1', { screen: false, back: true });
    expect(problems.join('\n')).toMatch(/sujet\.id : « cache-de-secours-365scores » ne correspond pas au dossier docs\/specs\/un-autre-dossier/);
    expect(checkSpec(h.repo, ok, 'L1', { screen: false, back: true }).join('\n')).not.toMatch(/sujet\.id/);
  });

  it('hypothesisLines : une ligne par hypothèse, R + énoncé + si faux', () => {
    const lines = hypothesisLines(ficheBack());
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^R3 : .*cacheAgeSeconds.* ; si faux : /);
    expect(hypothesisLines(null)).toEqual([]);
  });

  it('un lot à étape spec back reçoit l\'allocation de l\'étape dans son budget', () => {
    expect(lotBudget(1, 'spec')).toBe(lotBudget(1) + SPEC_STAGE_ALLOCATION);
  });
});

describe('étape spec back : agents', () => {
  it('code-reviewer décrit le mode fiche : lecture seule, quatre vérifications, constats mesurés, pas raf review', () => {
    const a = readAgents(AGENTS_DIR)['code-reviewer'];
    expect(a.prompt).toContain('Sheet mode');
    const mode = a.prompt.slice(a.prompt.indexOf('Sheet mode'));
    expect(mode).toMatch(/sourced or hypothesis/i);
    expect(mode).toMatch(/contradiction/i);
    expect(mode).toMatch(/errors and limits/i);
    expect(mode).toMatch(/one test per rule/i);
    expect(mode).toMatch(/`raf review`/);
  });

  it('spec-writer décrit la fiche back : sujet, cas, contrats, sousSeuil sans comportement ; acceptance-writer, les contrats', () => {
    const w = readAgents(AGENTS_DIR)['spec-writer'];
    expect(w.prompt).toMatch(/back|behaviour/i);
    expect(w.prompt).toContain('sujet');
    expect(w.prompt).toContain('contrats');
    const a = readAgents(AGENTS_DIR)['acceptance-writer'];
    expect(a.prompt).toContain('contrats[]');
  });
});

// Critère de fin de L188 : TERMINAISON. Quel que soit le chemin, l'agent spec joue au plus 2 sessions (3 pour un lot à écran, L230) et la chaîne atteint l'implémentation (ready) ou rend le lot.
describe('étape spec : terminaison de la chaîne, tous les chemins', () => {
  type Kind = 'ecran' | 'back' | 'mixte';
  const writes = (kind: Kind, sujet: boolean): Handler => (call) =>
    claudeOut(specReport({ fiche: kind === 'back' ? ecritBack(call.opts.cwd) : sujet ? ecritBack(call.opts.cwd, { mixte: true }) : ecrit(call.opts.cwd) }));
  const cases: { kind: Kind; pass1: boolean; pass2: boolean; ficheVerdict: 'ok' | 'major'; maquetteVerdict: 'ok' | 'major'; accept: boolean }[] = [];
  for (const kind of ['ecran', 'back', 'mixte'] as Kind[])
    for (const pass1 of [false, true])
      for (const pass2 of [false, true])
        for (const ficheVerdict of ['ok', 'major'] as const)
          for (const maquetteVerdict of ['ok', 'major'] as const)
            for (const accept of [false, true]) {
              if (kind === 'back' && (!pass1 || !pass2)) continue; // un lot back garde son sujet
              if (kind === 'mixte' && !pass1 && !pass2) continue;
              if (kind === 'ecran' && (pass1 || pass2)) continue;
              if (kind === 'back' && maquetteVerdict === 'major') continue; // pas de maquette
              cases.push({ kind, pass1, pass2, ficheVerdict, maquetteVerdict, accept });
            }

  it.each(cases)('%j : au plus 2 sessions spec (3 avec un écran), et le lot est prêt ou rendu', async (k) => {
    const never = () => claudeOut(reviewReport());
    const acceptHandler: Handler = (call) => {
      ecritAcceptation(call.opts.cwd, { sansFiche: k.kind === 'back', ecran: k.kind === 'back' ? 'cache-de-secours-365scores' : undefined, exemple: k.kind === 'back' ? EXEMPLE_BACK : undefined });
      return claudeOut(acceptReport());
    };
    const verdict = (v: 'ok' | 'major'): Handler => (v === 'ok' ? never : () => major());
    const h = harness({
      lots: k.kind === 'back' ? lots : [{ title: 'Un écran', screen: 'page' }],
      script: {
        spec: [writes(k.kind, k.pass1), writes(k.kind, k.pass2), writes(k.kind, k.pass2)],
        fiche: [verdict(k.ficheVerdict), verdict(k.ficheVerdict), verdict(k.ficheVerdict)],
        maquette: [verdict(k.maquetteVerdict), verdict(k.maquetteVerdict), verdict(k.maquetteVerdict)],
        accept: [acceptHandler, acceptHandler],
        implement: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'done.flag', 'feat(L1): a')] }))],
        review: [never],
      },
    });
    const over = k.kind === 'back' ? back : { screen: 'page' as const, visible: true };
    const c = h.lot('L1', over, { fiche: true, maquette: true, ...(k.accept ? { accept: 'test -f done.flag', test: 'true' } : {}) });
    await runLot(c);
    expect(kinds(h).filter((x) => x === 'spec').length).toBeLessThanOrEqual(k.kind === 'back' ? 2 : 3);
    expect(['ready', 'handed-back']).toContain(c.lot.status);
    if (c.lot.status === 'ready') {
      expect(kinds(h)).toContain('implement');
      expect(c.lot.ficheConstats ?? []).toEqual([]); // plus de revue de fiche à venir : rien ne reste à renvoyer à la spec
    }
  });
});

// L188, 2ᵉ revue : les deux bornes de l'étape spec (contrôle du programme, revues) partagent UN budget de deux sessions spec.
describe('étape spec : deux sessions spec au plus, chemins asymétriques', () => {
  const none: Handler = () => claudeOut(specReport({ fiche: '' }));
  const specCount = (h: ReturnType<typeof harness>) => kinds(h).filter((x) => x === 'spec').length;

  it('lot mixte dont le sujet n\'apparaît qu\'en passe 2 : fiche majeure puis maquette conforme ne rouvre pas la spec', async () => {
    const mixte: Handler = (call) => claudeOut(specReport({ fiche: ecritBack(call.opts.cwd, { mixte: true }) }));
    const screenOnly: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }));
    const h = harness({
      lots: [{ title: 'Un écran', screen: 'page' }],
      script: { spec: [screenOnly, mixte, mixte], maquette: [() => major(), ok, ok], fiche: [() => major(), () => major()], implement: [impl], review: [ok] },
    });
    const c = h.lot('L1', { screen: 'page' as const, visible: true }, { fiche: true, maquette: true });
    await runLot(c);
    expect(specCount(h)).toBeLessThanOrEqual(3);
    expect(['ready', 'handed-back']).toContain(c.lot.status);
  });

  it('fiche refusée par le contrôle puis valide mais majeure : pas de 3ᵉ session spec', async () => {
    const h = harness({ lots, script: { spec: [none, spec, spec], fiche: [() => major(), () => major()], implement: [impl], review: [ok] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(specCount(h)).toBe(2);
    expect(c.lot.status).toBe('handed-back');
  });

  it('refusée, valide, majeure : jamais de 4ᵉ session même si la suite échoue au contrôle', async () => {
    const h = harness({ lots, script: { spec: [none, spec, none, spec], fiche: [() => major(), () => major()], implement: [impl], review: [ok] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(specCount(h)).toBeLessThanOrEqual(2);
    expect(c.lot.status).toBe('handed-back');
  });
});

// L188, 3ᵉ revue : une hypothèse coûteuse levée en question au lead ouvre un nouveau budget de deux sessions spec, comme une question de la session.
describe('étape spec : la réponse à une hypothèse coûteuse remet le budget à zéro', () => {
  const cout: Handler = (call) => claudeOut(specReport({ fiche: ecritBack(call.opts.cwd, { fiche: (d) => { d.regles[2].si_faux = 'Si faux, une migration du stockage des rappels serait à écrire.'; } }) }));
  const answer = async (c: ReturnType<ReturnType<typeof harness>['lot']>) => {
    expect(c.lot.status).toBe('question');
    c.lot.questions = [];
    c.lot.pendingAnswer = 'confirmé';
  };

  it('back : spec coûteuse → réponse → spec → fiche majeure → seconde spec → seconde fiche', async () => {
    const h = harness({ lots, script: { spec: [cout, spec, spec], fiche: [() => major(), ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    await answer(c);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'spec', 'fiche', 'spec', 'fiche', 'implement', 'review']);
    expect(c.lot.status).toBe('ready');
  });

  it('écran : la maquette garde sa seconde revue après la réponse', async () => {
    const screenSpec: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }));
    const screenCout: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd, { fiche: (d) => { d.regles[2].si_faux = 'Si faux, une migration du stockage des rappels serait à écrire.'; } }) }));
    const h = harness({ lots: [{ title: 'Un écran', screen: 'page' }], script: { spec: [screenCout, screenSpec, screenSpec], maquette: [() => major(), ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', { screen: 'page' as const, visible: true }, { maquette: true });
    await runLot(c);
    await answer(c);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'spec', 'maquette', 'spec', 'maquette', 'implement', 'review']);
  });
});

// L188, 3ᵉ revue : la revue de fiche est sautée sur une preuve (code déjà commité après la fiche, acceptation scellée), rejouée sans preuve.
describe('étape spec back : reprise d\'un lot dont la fiche est déjà commitée', () => {
  const commite = (repo: string, json: string, msg: string) => {
    git(repo, 'add', '--', json);
    git(repo, 'commit', '-q', '-m', msg, '--', json);
  };
  const acceptation = (repo: string) => ecritAcceptation(repo, { sansFiche: true, ecran: 'cache-de-secours-365scores', exemple: EXEMPLE_BACK });

  it('du code du lot déjà commité après la fiche : pas de revue de fiche, sans orchestrate.accept', async () => {
    const h = harness({ lots, script: { implement: [impl], review: [ok] } });
    ecritBack(h.repo);
    commitFile(h.repo, 'a.txt', 'feat(L1): a');
    await runLot(h.lot('L1', back, config));
    expect(kinds(h)).not.toContain('fiche');
    expect(kinds(h)).not.toContain('spec');
  });

  it('une acceptation scellée : pas de revue de fiche', async () => {
    const h = harness({ lots, script: { implement: [impl], review: [ok] } });
    ecritBack(h.repo);
    const a = acceptation(h.repo);
    sealAcceptation(h.repo, a.json);
    commite(h.repo, a.json, 'test(L1): acceptation scellée');
    await runLot(h.lot('L1', back, { ...config, accept: 'true', test: 'true' }));
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('une acceptation verte (nouvelle vague) : pas de revue de fiche non plus', async () => {
    const h = harness({ lots, script: { implement: [impl], review: [ok] } });
    ecritBack(h.repo);
    const a = acceptation(h.repo);
    sealAcceptation(h.repo, a.json);
    commite(h.repo, a.json, 'test(L1): acceptation scellée');
    setVert(h.repo, a.json);
    commite(h.repo, a.json, 'chore(L1): acceptation verte');
    await runLot(h.lot('L1', back, { ...config, accept: 'true', test: 'true' }));
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('L233 — une acceptation verte et scellée dont le scellé ne tient plus (le test ne porte plus le nom prévu par la fiche) prouve encore la revue : pas de revue de fiche', async () => {
    const h = harness({ lots, script: { implement: [impl], review: [ok] } });
    ecritBack(h.repo);
    const a = ecritAcceptation(h.repo, { sansFiche: true, ecran: 'cache-de-secours-365scores', exemple: EXEMPLE_BACK, tests: "it('autre', () => { throw new Error('rouge'); });" });
    sealAcceptation(h.repo, a.json);
    commite(h.repo, a.json, 'test(L1): acceptation scellée');
    setVert(h.repo, a.json);
    commite(h.repo, a.json, 'chore(L1): acceptation verte');
    await runLot(h.lot('L1', back, { ...config, accept: 'true', test: 'true' }));
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('L233 — une acceptation verte et scellée dont un test a été modifié après le scellé (empreinte qui ne tient plus) prouve encore la revue : pas de revue de fiche', async () => {
    const h = harness({ lots, script: { implement: [impl], review: [ok] } });
    ecritBack(h.repo);
    const a = ecritAcceptation(h.repo, { sansFiche: true, ecran: 'cache-de-secours-365scores', exemple: EXEMPLE_BACK });
    sealAcceptation(h.repo, a.json);
    commite(h.repo, a.json, 'test(L1): acceptation scellée');
    setVert(h.repo, a.json);
    commite(h.repo, a.json, 'chore(L1): acceptation verte');
    writeFileSync(join(h.repo, a.test), `${readFileSync(join(h.repo, a.test), 'utf8')}// modifié après le scellé\n`);
    commite(h.repo, a.test, 'test(L1): test modifié après le scellé');
    await runLot(h.lot('L1', back, { ...config, accept: 'true', test: 'true' }));
    // Le verrou rend ensuite le lot (le test de son propre lot a bougé) : seul compte ici que ni la revue de fiche ni accept ne soient rejouées avant implement.
    expect(kinds(h)[0]).toBe('implement');
    expect(kinds(h)).not.toContain('fiche');
    expect(kinds(h)).not.toContain('accept');
  });

  it('une acceptation non scellée ne prouve rien : la fiche est relue', async () => {
    const h = harness({ lots, script: { fiche: [ok], accept: [() => claudeOut(acceptReport())], implement: [impl], review: [ok] } });
    ecritBack(h.repo);
    acceptation(h.repo);
    await runLot(h.lot('L1', back, { ...config, accept: 'true', test: 'true' }));
    expect(kinds(h)[0]).toBe('fiche');
  });

  it('sans preuve, une fiche majeure à la reprise : une session spec, puis la seconde revue de fiche', async () => {
    const h = harness({ lots, script: { fiche: [() => major(), ok], spec: [spec], implement: [impl], review: [ok] } });
    ecritBack(h.repo);
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['fiche', 'spec', 'fiche', 'implement', 'review']);
    expect(c.lot.specRuns).toBe(1);
  });
});
