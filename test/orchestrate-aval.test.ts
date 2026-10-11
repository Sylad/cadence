import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { renderBrief } from '../src/orchestrate/briefs.js';
import { avalFicheText, ficheRules } from '../src/orchestrate/aval.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { readAgents } from '../src/orchestrate/launch.js';
import { AGENTS_DIR } from '../src/skills.js';
import { ecritAcceptation } from './accept-helpers.js';
import { acceptReport, claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { ecrit, EXEMPLE } from './spec-helpers.js';

// L174 (spec etape-spec, S6) : les briefs en aval de la fiche — implement/fix, revue de code (règle → test → vert), conformité UX légère.
const FICHE = 'docs/specs/prochain-match/fiche.yaml';
const screen = { visible: true, screen: 'page' as const };
const lots = [{ title: 'Un écran', screen: 'page' as const }];
const ux = { url: 'http://localhost:4200' };
const ok: Handler = () => claudeOut(reviewReport());
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const brief = (h: ReturnType<typeof harness>, kind: string) => h.calls.find((c) => c.kind === kind)!.brief;

describe('ficheRules : les règles de la fiche, une ligne chacune', () => {
  const doc = parse(readFileSync(EXEMPLE, 'utf8'));

  it('id, état, statut, énoncé et tests prévus de chaque règle', () => {
    const lines = ficheRules(doc);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('R1');
    expect(lines[0]).toContain('[charge, sourcee]');
    expect(lines[2]).toContain('R3');
    expect(lines[2]).toContain('hypothese');
    expect(lines[2]).toContain('R3 — erreur : message et bouton Réessayer');
    expect(lines[2]).toContain('Impossible de charger le prochain match.');
  });

  it('un document qui n\'est pas une fiche ne donne aucune ligne', () => {
    expect(ficheRules(null)).toEqual([]);
    expect(ficheRules({ regles: 3 })).toEqual([]);
  });
});

describe('avalFicheText', () => {
  const rules = ['- R1 [charge, sourcee] énoncé'];
  const base = { fiche: FICHE, rules };

  it('implement : fiche, maquette, règles, tests verts sans les modifier, tests écrits qui citent la règle, pas de règle inventée, Hypothèses', () => {
    const t = avalFicheText('implement', { ...base, acceptation: 'docs/specs/prochain-match/acceptation-L1.json' });
    for (const attendu of [FICHE, 'docs/specs/prochain-match/maquette.html', '- R1 [charge, sourcee] énoncé', 'without modifying', 'acceptation-L1.json', 'cite the rule', '`R2 — …`', 'do not invent', 'not coded', '## Hypothèses']) {
      expect(t, attendu).toContain(attendu);
    }
  });

  it('implement sans acceptation : pas de consigne sur des tests que personne n\'a écrits', () => {
    const t = avalFicheText('implement', base);
    expect(t).not.toContain('without modifying');
    expect(t).toContain('cite the rule');
  });

  it('fix : la fiche reste la référence, les tests d\'acceptation ne se modifient pas', () => {
    const t = avalFicheText('fix', { ...base, acceptation: 'a.json' });
    expect(t).toContain(FICHE);
    expect(t).toContain('without modifying');
  });

  it('review : règle → test → vert, test inchangé depuis le commit rouge, règle codée hors fiche = majeur', () => {
    const t = avalFicheText('review', { ...base, acceptation: 'a.json', rouge: 'abcdef0123456789' });
    for (const attendu of ['rule → test → green', FICHE, '- R1 [charge, sourcee] énoncé', 'a.json', 'abcdef0', 'unchanged since the red commit', 'major', 'not in the sheet', 'does not rebuild the cases', '`R2 — …`']) {
      expect(t, attendu).toContain(attendu);
    }
  });

  it('ux : conformité légère à la maquette, mêmes états et largeurs, pas l\'audit complet', () => {
    const t = avalFicheText('ux', base);
    for (const attendu of ['conformity', 'docs/specs/prochain-match/maquette.html', 'maquette-<état>-<largeur>.png', '1440', '390', 'not the full audit', 'raf ux']) {
      expect(t, attendu).toContain(attendu);
    }
    expect(t).not.toContain('UX review of the mockup'); // l'étape maquette se reconnaît à cette phrase
  });
});

describe('gabarits : {{fiche}}', () => {
  const vars = { chemin: '/r/p', lot: 'L9', titre: 'T', objectif: 'x', commits: '', reponse: '', constats: '', ux: '', choix: '', checks: '', news: '', captures: '' };

  it('implement, fix, fix-minors, review, review-small et ux portent la consigne de la fiche, rien quand elle est vide', () => {
    for (const kind of ['implement', 'fix', 'fix-minors', 'review', 'review-small', 'ux'] as const) {
      expect(renderBrief(kind, { ...vars, fiche: 'CONSIGNE-FICHE' }), kind).toContain('CONSIGNE-FICHE');
      expect(renderBrief(kind, vars), kind).not.toContain('{{');
    }
  });
});

describe('cycle : un lot avec fiche', () => {
  it('implement reçoit la fiche (chemin, maquette, règles) et la consigne Hypothèses', async () => {
    const h = harness({ lots, script: { implement: [impl], ux: [ok], review: [ok] } });
    ecrit(h.repo);
    await runLot(h.lot('L1', screen, { ux }));
    const b = brief(h, 'implement');
    expect(b).toContain(FICHE);
    expect(b).toContain('R3');
    expect(b).toContain('## Hypothèses');
    expect(b).toContain('cite the rule');
  });

  it('avec une acceptation scellée, implement et la revue la nomment ; la revue reçoit le commit rouge', async () => {
    const h = harness({ lots, script: { accept: [(call) => { ecritAcceptation(call.opts.cwd, { sansFiche: true }); return claudeOut(acceptReport()); }], implement: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'done.flag', 'feat(L1): a')] }))], ux: [ok], review: [ok] } });
    ecrit(h.repo);
    const c = h.lot('L1', screen, { ux, accept: 'test -f done.flag', test: 'true' });
    await runLot(c);
    expect(kinds(h)).toContain('accept');
    expect(brief(h, 'implement')).toContain('acceptation-L1.json');
    const review = brief(h, 'review');
    expect(review).toContain('acceptation-L1.json');
    expect(review).toContain((c.lot.accept?.rouge ?? 'absent').slice(0, 7));
  });

  it('la revue de code vérifie règle → test → vert', async () => {
    const h = harness({ lots, script: { implement: [impl], ux: [ok], review: [ok] } });
    ecrit(h.repo);
    await runLot(h.lot('L1', screen, { ux }));
    const b = brief(h, 'review');
    expect(b).toContain('rule → test → green');
    expect(b).toContain('R1');
    expect(b).toContain('R4');
  });

  it('la passe UX remplace l\'audit complet : conformité à la maquette, l\'application reste jointe', async () => {
    const h = harness({ lots, script: { implement: [impl], ux: [ok], review: [ok] } });
    ecrit(h.repo);
    await runLot(h.lot('L1', screen, { ux }));
    const b = brief(h, 'ux');
    expect(b).toContain('conformity');
    expect(b).toContain('maquette-<état>-<largeur>.png');
    expect(b).toContain('not the full audit');
    expect(b).toContain('http://localhost:4200');
  });

  it('une passe de correction garde la fiche', async () => {
    const bad: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'a.txt', texte: 'R3 sans test' }], verdict: 'non conforme' }));
    const h = harness({ lots, script: { implement: [impl], ux: [ok, ok], review: [bad, ok], fix: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'b.txt', 'fix(L1): b')] }))] } });
    ecrit(h.repo);
    await runLot(h.lot('L1', screen, { ux }));
    expect(brief(h, 'fix')).toContain(FICHE);
    expect(brief(h, 'fix')).toContain('R3');
  });

  it('un lot visible sans fiche (pas de screen) garde les briefs d\'avant', async () => {
    const h = harness({ lots: [{ title: 'Un lot', visible: true }], script: { implement: [impl], ux: [ok], review: [ok] } });
    await runLot(h.lot('L1', { visible: true }, { ux }));
    for (const kind of ['implement', 'ux', 'review']) {
      expect(brief(h, kind), kind).not.toContain('sheet');
      expect(brief(h, kind), kind).not.toContain('## Hypothèses');
    }
  });

  it('un lot avec screen mais sans fiche (sous le seuil) ne reçoit pas de consigne de fiche', async () => {
    const h = harness({ lots, script: { spec: [() => claudeOut({ commits: [], nonVerifie: [], questions: [], choix: [], sousSeuil: 'aucun écran', fiche: '', resume: 'rien' })], implement: [impl], ux: [ok], review: [ok] } });
    await runLot(h.lot('L1', screen, { ux }));
    expect(brief(h, 'implement')).not.toContain('sheet');
  });
});

describe('agents', () => {
  it('code-reviewer décrit la vérification règle → test → vert d\'un lot avec fiche', () => {
    const a = readAgents(AGENTS_DIR)['code-reviewer'];
    expect(a.prompt).toContain('rule → test → green');
    expect(a.prompt).toMatch(/sheet/);
    expect(a.prompt).toMatch(/major/);
  });

  it('ux-reviewer décrit le mode conformité : même maquette, mêmes états, écarts de rendu, pas l\'audit complet, pas raf ux', () => {
    const a = readAgents(AGENTS_DIR)['ux-reviewer'];
    expect(a.prompt).toContain('Conformity mode');
    expect(a.prompt).toContain('not the full audit');
    expect(a.prompt).toMatch(/Conformity mode[\s\S]*`raf ux`/);
  });
});

describe('docs', () => {
  it('le README décrit les briefs aval et la section Hypothèses', () => {
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).toContain('règle → test → vert');
    expect(readme).toContain('## Hypothèses');
  });
});
