import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { checkShape, REVIEW_SCHEMA, type ReviewReport } from '../src/orchestrate/schemas.js';
import { readAgents } from '../src/orchestrate/launch.js';
import { AGENTS_DIR } from '../src/skills.js';
import { claudeOut, commitFile, harness, reviewReport, specReport, workReport, type Handler } from './orchestrate-harness.js';
import { ecrit, ecritBack } from './spec-helpers.js';

// L562 (spec revue-maquette-suite-inchange) : dès la revue 2, un majeur marqué `inchange: true` va au tableau en suite pour le lead et ne compte plus pour la non-conformité.
type K = { gravite: string; texte: string; fichier?: string; ligne?: number; inchange?: unknown };
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());
const screen = { visible: true, screen: 'page' as const };
const lots = [{ title: 'Un écran', screen: 'page' as const }];
const spec: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }));
const cfg = { maquette: true, maquetteReviews: 3 };
const rev = (constats: K[], extra: Partial<ReviewReport> = {}, verdict = 'non conforme'): Handler => () => {
  const n = (g: string) => constats.filter((k) => k.gravite === g).length;
  return claudeOut(reviewReport({ bloquants: n('bloquant'), majeurs: n('majeur'), mineurs: n('mineur'), constats, verdict, ...extra }));
};
const maj = (texte: string, extra: Partial<K> = {}): K => ({ gravite: 'majeur', texte, ...extra });
const first = rev([maj('contraste')]);
const run = async (second: Handler, opts: { first?: Handler; third?: Handler; logs?: string[] } = {}) => {
  const h = harness({ lots, script: { spec: [spec, spec, spec], maquette: [opts.first ?? first, second, opts.third ?? ok], implement: [impl], review: [ok] } });
  if (opts.logs) h.wave.log = (line) => opts.logs!.push(line);
  const c = h.lot('L1', screen, cfg);
  await runLot(c);
  return { h, c };
};
const suite = (c: { lot: { proposals: string[] } }) => c.lot.proposals.filter((p) => p.startsWith('[suite ux]'));

describe('R1 — un majeur marqué ne compte plus à partir de la revue 2', () => {
  it('R1 — revue 2, un seul majeur marqué inchange: true : la revue est conforme, le lot passe à l’étape suivante sans session spec', async () => {
    const { h, c } = await run(rev([maj('panneaux étirés', { inchange: true })]));
    expect(kinds(h)).toEqual(['spec', 'maquette', 'spec', 'maquette', 'implement', 'review']);
    expect(c.lot.maquette?.conforme).toBe(true);
    expect(c.lot.maquetteConstats).toBeUndefined();
    expect(c.lot.status).toBe('ready');
  });
  it('R1 — revue 2, majeur marqué et totaux annoncés majeurs: 1 : conforme quand même', async () => {
    const { c } = await run(rev([maj('x', { inchange: true })], { majeurs: 1 }));
    expect(c.lot.maquette?.conforme).toBe(true);
  });
  it('R1 — revue 2, un majeur marqué et un majeur non marqué : non conforme, seul le non marqué est renvoyé à la spec', async () => {
    const { h, c } = await run(rev([maj('marqué', { inchange: true }), maj('non marqué')]), { third: rev([maj('encore')]) });
    expect(kinds(h).slice(0, 5)).toEqual(['spec', 'maquette', 'spec', 'maquette', 'spec']);
    const brief = h.calls.filter((x) => x.kind === 'spec')[2].brief;
    expect(brief).toContain('- [majeur] non marqué');
    expect(brief).not.toContain('- [majeur] marqué');
    expect(c.lot.maquette?.conforme).toBe(false);
  });
  it('R1 — revue 2, bloquant marqué inchange: true : non conforme', async () => {
    const { c } = await run(rev([{ gravite: 'bloquant', texte: 'bloc', inchange: true }]), { third: rev([maj('encore')]) });
    expect(c.lot.maquette?.conforme).toBe(false);
    expect(c.lot.maquette?.passes).toBe(3);
  });
  it('R1 — revue 1, majeur marqué inchange: true : non conforme comme avant', async () => {
    const { h } = await run(ok, { first: rev([maj('contraste', { inchange: true })]) });
    expect(kinds(h).slice(0, 3)).toEqual(['spec', 'maquette', 'spec']);
  });
  it("R1 — revue 2, majeur avec inchange 'true' (texte) ou null : non conforme", async () => {
    for (const inchange of ['true', null, 1]) {
      const { c } = await run(rev([maj('x', { inchange })]));
      expect(c.lot.maquette?.passes).toBe(3);
      expect(suite(c)).toEqual([]);
    }
  });
  it('R1 — revue de la fiche, majeur marqué inchange: true : non conforme (la fiche ne lit pas la marque)', async () => {
    const back: Handler = (call) => claudeOut(specReport({ fiche: ecritBack(call.opts.cwd) }));
    const h = harness({ lots: [{ title: 'Un comportement', spec: true }], script: { spec: [back, back], fiche: [rev([maj('R5 : x', { inchange: true })]), rev([maj('R5 : x', { inchange: true })])] } });
    const c = h.lot('L1', { specLot: true }, { fiche: true, ...cfg });
    await runLot(c);
    expect(c.lot.outcome).toContain('fiche non conforme après 2 revues');
    expect(c.lot.proposals.filter((p) => p.startsWith('[suite ux]'))).toEqual([]);
  });
});

describe('R2 — le majeur mis de côté va au tableau en suite', () => {
  it('R2 — revue 2, majeur marqué : lot.proposals contient « [suite ux] fichier:ligne — texte »', async () => {
    const { c } = await run(rev([maj('panneaux étirés', { inchange: true, fichier: 'maquette.html', ligne: 42 })]));
    expect(suite(c)).toEqual(['[suite ux] maquette.html:42 — panneaux étirés']);
  });
  it('R2 — revue 2, majeur marqué sans ligne : « [suite ux] fichier — texte »', async () => {
    const { c } = await run(rev([maj('panneaux étirés', { inchange: true, fichier: 'maquette.html' })]));
    expect(suite(c)).toEqual(['[suite ux] maquette.html — panneaux étirés']);
  });
  it('R2 — revue 2, majeur marqué sans fichier : la ligne est « [suite ux] <texte> »', async () => {
    const { c } = await run(rev([maj('panneaux étirés', { inchange: true })]));
    expect(suite(c)).toEqual(['[suite ux] panneaux étirés']);
  });
  it('R2 — revue 2 non conforme pour un autre majeur : le majeur marqué est quand même dans lot.proposals', async () => {
    const { c } = await run(rev([maj('marqué', { inchange: true }), maj('non marqué')]));
    expect(suite(c)).toEqual(['[suite ux] marqué']);
  });
  it('R2 — le même majeur marqué redit en revue 3 : une seule entrée dans lot.proposals', async () => {
    const { c } = await run(rev([maj('marqué', { inchange: true }), maj('non marqué')]), { third: rev([maj('marqué', { inchange: true })]) });
    expect(suite(c)).toEqual(['[suite ux] marqué']);
  });
  it('R2 — revue 1, majeur marqué : rien dans lot.proposals au titre de « [suite ux] »', async () => {
    const { c } = await run(ok, { first: rev([maj('contraste', { inchange: true })]) });
    expect(suite(c)).toEqual([]);
  });
});

describe('R3 — le verdict dit les majeurs laissés en suite', () => {
  it('R3 — un majeur mis de côté : l.maquette.verdict se termine par « — conforme, 1 majeur sur un point inchangé en suite pour le lead : <texte> »', async () => {
    const { c } = await run(rev([maj('panneaux étirés', { inchange: true })], {}, 'non conforme : 1 majeur'));
    expect(c.lot.maquette?.verdict).toBe('non conforme : 1 majeur — conforme, 1 majeur sur un point inchangé en suite pour le lead : panneaux étirés');
  });
  it('R3 — deux majeurs mis de côté : « 2 majeurs », textes séparés par « ; »', async () => {
    const { c } = await run(rev([maj('a', { inchange: true }), maj('b', { inchange: true })], {}, 'v'));
    expect(c.lot.maquette?.verdict).toBe('v — conforme, 2 majeurs sur un point inchangé en suite pour le lead : a ; b');
  });
  it('R3 — aucun majeur mis de côté : l.maquette.verdict égale le verdict de l’agent', async () => {
    const { c } = await run(rev([], {}, 'conforme'));
    expect(c.lot.maquette?.verdict).toBe('conforme');
  });
  it('R3 — revue non conforme : le verdict gardé est celui de l’agent, sans ajout', async () => {
    const { c } = await run(rev([maj('marqué', { inchange: true }), maj('non marqué')], {}, 'non conforme'));
    expect(c.lot.maquette?.verdict).not.toContain('en suite pour le lead');
  });
});

describe('R4 — rendu et renvoi ne listent que les constats qui comptent', () => {
  it('R4 — revue 3 non conforme avec un majeur marqué et un non marqué : le rendu liste le non marqué seul', async () => {
    const { c } = await run(rev([maj('contraste 2')]), { third: rev([maj('marqué', { inchange: true }), maj('non marqué')], {}, 'non conforme') });
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('maquette non conforme après 3 revues : non conforme');
    expect(c.lot.outcome).toContain('- [majeur] non marqué');
    expect(c.lot.outcome).not.toContain('- [majeur] marqué');
  });
  it('R4 — revue 2 non conforme : maquetteConstats ne contient pas le majeur marqué', async () => {
    const h = harness({ lots, script: { spec: [spec, spec], maquette: [first, rev([maj('marqué', { inchange: true }), maj('non marqué')])] } });
    const c = h.lot('L1', screen, { ...cfg, maquetteReviews: 3 });
    await runLot(c);
    expect(c.lot.maquetteConstats?.map((k) => k.texte)).toEqual(['non marqué']);
  });
});

describe('R5 — la revue 1 balaie les tailles de la fiche', () => {
  it('R5 — le brief maquette.md rendu mentionne les tailles de la fiche dans le balayage de la revue 1', async () => {
    const { h } = await run(ok);
    const brief = h.calls.find((x) => x.kind === 'maquette')!.brief;
    expect(brief).toContain('every size the sheet gives');
    expect(brief).toContain('nonVerifie');
  });
  it('R5 — agents/ux-reviewer.md (mode maquette) a la ligne « tailles » dans la liste à cocher de la première revue', () => {
    const prompt = readAgents(AGENTS_DIR)['ux-reviewer'].prompt;
    const mockup = prompt.slice(prompt.indexOf('## Mockup mode'), prompt.indexOf('## Conformity mode'));
    expect(mockup).toContain('every size the sheet gives');
  });
});

describe('R6 — le brief dit ce qui ne bloque pas', () => {
  const briefs = async () => {
    const { h } = await run(first);
    return h.calls.filter((x) => x.kind === 'maquette').map((x) => x.brief);
  };
  it('R6 — brief de la revue 2 : « ne bloque pas » et « lead » présents près de inchange', async () => {
    const [, second] = await briefs();
    const at = second.indexOf('`inchange: true`');
    expect(at).toBeGreaterThan(-1);
    const near = second.slice(at, at + 400);
    expect(near).toContain('does not block');
    expect(near).toContain('lead');
  });
  it('R6 — brief de la revue 1 : aucune consigne sur ce qui ne bloque pas', async () => {
    const [firstBrief] = await briefs();
    expect(firstBrief).not.toContain('does not block');
    expect(firstBrief).not.toContain('inchange');
  });
  it('R6 — l’agent ux-reviewer et la description de inchange disent la même chose', () => {
    const prompt = readAgents(AGENTS_DIR)['ux-reviewer'].prompt;
    expect(prompt).toContain('does not block');
    const desc = (REVIEW_SCHEMA.properties.constats.items.properties as Record<string, { description?: string }>).inchange.description;
    expect(desc).toContain('does not block');
  });
  it('R6 — rapport sans inchange ou avec inchange non booléen : accepté, comme avant', () => {
    for (const inchange of [undefined, 'oui', null]) {
      const rep = reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', texte: 'a', ...(inchange === undefined ? {} : { inchange }) }] });
      expect(checkShape<ReviewReport>(rep, REVIEW_SCHEMA).constats).toHaveLength(1);
    }
  });
});

describe('R7 — la ligne de journal est conservée, l’état du lot change', () => {
  it('R7 — revue 2, majeur marqué : c.wave.log reçoit toujours exactement la ligne « défaut de revue : maquette, revue 2, … » et l.warnings ne la contient pas', async () => {
    const logs: string[] = [];
    const { c } = await run(rev([maj('panneaux étirés', { inchange: true })]), { logs });
    expect(logs.filter((l) => l.includes('défaut de revue'))).toEqual(['demo:L1 · défaut de revue : maquette, revue 2, majeur sur un point inchangé absent de la revue 1 : panneaux étirés']);
    expect(c.lot.warnings.join('\n')).not.toContain('défaut de revue');
  });
  it('R7 — revue 1 avec inchange: true, ou revue 2 avec mineur marqué ou marque non booléenne : aucune ligne de journal', async () => {
    const cases: { second: Handler; first?: Handler }[] = [
      { second: ok, first: rev([maj('c', { inchange: true })]) },
      { second: rev([{ gravite: 'mineur', texte: 'm', inchange: true }]) },
      { second: rev([maj('x', { inchange: 'true' })]) },
      { second: rev([maj('x', { inchange: null })]) },
    ];
    for (const { second, first: f } of cases) {
      const logs: string[] = [];
      await run(second, { first: f, logs });
      expect(logs.filter((l) => l.includes('défaut de revue'))).toEqual([]);
    }
  });
});
