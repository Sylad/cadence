import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { runLot } from '../src/orchestrate/cycle.js';
import { mcpServersFor, readAgents } from '../src/orchestrate/launch.js';
import { costlyHypotheses, specScreen } from '../src/orchestrate/spec.js';
import { AGENTS_DIR } from '../src/skills.js';
import { gitRepo, tempDir } from './helpers.js';
import { ecrit, EXEMPLE, type Écrit } from './spec-helpers.js';
import { claudeOut, commitFile, git, harness, reviewReport, specReport, workReport, type Handler } from './orchestrate-harness.js';

// L171 (spec etape-spec, S3) : l'étape spec d'orchestrate, avant l'implémentation d'un lot qui déclare screen:.
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());
const screen = { visible: true, screen: 'page' as const };
const lots = [{ title: 'Un écran', screen: 'page' as const }];

const spec = (o: Écrit = {}, over: Record<string, unknown> = {}): Handler => (call) => {
  const fiche = ecrit(call.opts.cwd, o);
  return claudeOut(specReport({ fiche, ...over }));
};

describe('étape spec : où elle s’insère', () => {
  it('un lot avec screen: joue spec avant implement, puis la revue', async () => {
    const h = harness({ lots, script: { spec: [spec()], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'implement', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.spec).toMatchObject({ fiche: 'docs/specs/prochain-match/fiche.yaml', hypotheses: 2 });
  });

  it('un lot sans screen: garde le chemin actuel, sans spec', async () => {
    const h = harness({ lots: [{ title: 'Un écran', visible: true }], script: { implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', { visible: true }));
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('le contrôle préalable passe avant la spec', async () => {
    const h = harness({ lots: [{ title: 'Un écran, suite du constat de revue', screen: 'page' as const }], script: { precheck: [() => claudeOut({ dejaPresent: 'non', preuves: [], resume: 'rien' })], spec: [spec()], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', screen, { precheck: true }));
    expect(kinds(h)).toEqual(['precheck', 'spec', 'implement', 'review']);
  });

  it('une fiche déjà commitée pour le lot (reprise) évite de rejouer la spec', async () => {
    const h = harness({ lots, script: { implement: [impl], review: [ok] } });
    ecrit(h.repo);
    await runLot(h.lot('L1', screen));
    expect(kinds(h)).toEqual(['implement', 'review']);
  });
});

describe('étape spec : une fiche déjà là ne vaut que si elle est conforme', () => {
  it('une fiche non conforme laissée par un lot rendu : la spec est rejouée, pas l’implémentation', async () => {
    const h = harness({ lots, script: { spec: [spec()], implement: [impl], review: [ok] } });
    ecrit(h.repo, { fiche: (d) => { d.regles[1].id = 'R9'; } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'implement', 'review']);
  });

  it('une fiche avec hypothèse coûteuse non tranchée : la spec est rejouée', async () => {
    const h = harness({ lots, script: { spec: [spec()], implement: [impl], review: [ok] } });
    ecrit(h.repo, { fiche: (d) => { d.regles[2].si_faux = 'Si faux, une migration du stockage des rappels serait à écrire.'; } });
    await runLot(h.lot('L1', screen));
    expect(kinds(h)).toEqual(['spec', 'implement', 'review']);
  });
});

describe('étape spec : la session', () => {
  it('Sonnet, agent spec-writer, Playwright chargé, captures dans les dossiers de la session, brief complet', async () => {
    const h = harness({ lots, script: { spec: [spec()], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen, { spec: { dir: 'docs/specs', render: 'npm run maquette:rendu' } });
    await runLot(c);
    const call = h.calls[0];
    expect(call.model).toBe('sonnet');
    expect(call.args[call.args.indexOf('--agent') + 1]).toBe('spec-writer');
    expect(call.args).toContain('--mcp-config');
    expect(call.args.filter((a) => a === '--add-dir').length).toBeGreaterThan(0);
    for (const attendu of ['L1', '1440', '390', 'docs/specs/<écran>/', 'maquette.html', 'fiche.yaml', 'data-testid', 'etat-vide', 'cadence spec check', 'page', 'npm run maquette:rendu', 'templates/fiche.yaml', 'hypothese', 'sousSeuil']) {
      expect(call.brief, attendu).toContain(attendu);
    }
    expect(call.brief).toMatch(/maquette-<état>-<largeur>\.png/);
  });

  it('brief : chaque date d\'exemple de la maquette est vérifiée, le jour de la semaine calculé et non écrit de tête (L181)', async () => {
    const h = harness({ lots, script: { spec: [spec()], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', screen, { spec: { dir: 'docs/specs', render: 'npm run maquette:rendu' } }));
    expect(h.calls[0].brief).toMatch(/every (example )?date/i);
    expect(h.calls[0].brief).toMatch(/weekday/i);
    expect(h.calls[0].brief).toMatch(/compute/i);
  });

  it('mcpServersFor charge Playwright pour spec sur un lot visible, pas sans écran', () => {
    expect(Object.keys(mcpServersFor('spec', true, '/run/p--L1/playwright'))).toEqual(['playwright']);
    expect(mcpServersFor('spec', false, '/run/p--L1/playwright')).toEqual({});
  });

  it('l’agent spec-writer du paquet existe, écrit, et ne lance ni sous-agent ni push', () => {
    const a = readAgents(AGENTS_DIR)['spec-writer'];
    expect(a).toBeDefined();
    expect(a.tools).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Bash', 'StructuredOutput']));
    expect(a.prompt).toMatch(/1440/);
    expect(a.prompt).toMatch(/hypothese/);
  });

  it('l’effort de spec suit orchestrate.effort.spec', async () => {
    const h = harness({ lots, script: { spec: [spec()], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', screen, { effort: { precheck: 'low', implement: 'medium', fix: 'medium', review: 'high', ux: 'high', spec: 'high', maquette: 'high', fiche: 'medium', accept: 'medium' } }));
    expect(h.calls[0].effort).toBe('high');
  });
});

describe('étape spec : sortie sous le seuil', () => {
  it('une raison dans sousSeuil : pas de maquette exigée, le lot reprend le chemin actuel, la raison est notée', async () => {
    const h = harness({ lots, script: { spec: [() => claudeOut(specReport({ sousSeuil: 'le lot ne change aucun écran : un export CSV côté serveur' }))], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'implement', 'review']);
    expect(c.lot.spec).toEqual({ sousSeuil: 'le lot ne change aucun écran : un export CSV côté serveur' });
    expect(c.lot.warnings.join('\n')).toContain('sous le seuil');
    expect(c.lot.status).toBe('ready');
  });
});

describe('étape spec : contrôles du programme', () => {
  it('une fiche invalide : une seconde passe reçoit les écarts, puis le lot est rendu', async () => {
    const mauvaise = spec({ fiche: (d) => { d.regles[1].id = 'R9'; } });
    const h = harness({ lots, script: { spec: [mauvaise, mauvaise] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'spec']);
    expect(h.calls[1].brief).toMatch(/R9|R2/);
    expect(h.calls[1].brief).toContain('did not pass');
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/spec/);
  });

  it('une fiche sans bloc ecran (sujet seul) est refusée pour un lot à écran', async () => {
    const back = spec({ dossier: 'prochain-match', fiche: (d) => { d.sujet = { id: 'cache', titre: 'Cache', lot: 'L1' }; delete d.ecran; } });
    const h = harness({ lots, script: { spec: [back, back] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'spec']);
    expect(h.calls[1].brief).toContain('ecran : bloc manquant');
    expect(c.lot.status).toBe('handed-back');
  });

  it('le chemin de fiche du rapport est normalisé : absolu ou préfixé ./, le lot passe', async () => {
    const absolu: Handler = (call) => claudeOut(specReport({ fiche: join(call.opts.cwd, ecrit(call.opts.cwd)) }));
    const pointe: Handler = (call) => claudeOut(specReport({ fiche: `./${ecrit(call.opts.cwd)}` }));
    for (const handler of [absolu, pointe]) {
      const h = harness({ lots, script: { spec: [handler], implement: [impl], review: [ok] } });
      const c = h.lot('L1', screen);
      await runLot(c);
      expect(kinds(h)).toEqual(['spec', 'implement', 'review']);
      expect(c.lot.spec).toMatchObject({ fiche: 'docs/specs/prochain-match/fiche.yaml' });
    }
  });

  it('un chemin de fiche hors du dépôt est un écart, pas une exception', async () => {
    const dehors: Handler = (call) => {
      ecrit(call.opts.cwd);
      return claudeOut(specReport({ fiche: '../ailleurs/fiche.yaml' }));
    };
    const h = harness({ lots, script: { spec: [dehors, dehors] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'spec']);
    expect(h.calls[1].brief).toContain('hors du dépôt');
    expect(c.lot.status).toBe('handed-back');
  });

  it('une fiche rangée hors de orchestrate.spec.dir est un écart', async () => {
    const ailleurs = spec({ racine: 'docs/spec' });
    const h = harness({ lots, script: { spec: [ailleurs, spec()], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'spec', 'implement', 'review']);
    expect(h.calls[1].brief).toContain('docs/spec/prochain-match/fiche.yaml');
    expect(h.calls[1].brief).toContain('hors de docs/specs');
    expect(c.lot.spec).toMatchObject({ fiche: 'docs/specs/prochain-match/fiche.yaml' });
  });

  it('la seconde passe peut corriger : le lot continue', async () => {
    const h = harness({ lots, script: { spec: [spec({ fiche: (d) => { d.regles[1].id = 'R9'; } }), spec()], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'spec', 'implement', 'review']);
  });

  it('une capture manquante (état × largeur) est un écart', async () => {
    const m = spec({ sansCapture: ['maquette-erreur-390.png'] });
    const h = harness({ lots, script: { spec: [m, m] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(h.calls[1].brief).toContain('maquette-erreur-390.png');
    expect(c.lot.status).toBe('handed-back');
  });

  it('un champ sans data-testid dans la maquette est un écart', async () => {
    const m = spec({ sansTestid: 'score' });
    const h = harness({ lots, script: { spec: [m, m] } });
    await runLot(h.lot('L1', screen));
    expect(h.calls[1].brief).toContain('data-testid="score"');
  });

  it('un état sans section #etat-… dans la maquette est un écart', async () => {
    const m = spec({ sansSection: 'erreur' });
    const h = harness({ lots, script: { spec: [m, m] } });
    await runLot(h.lot('L1', screen));
    expect(h.calls[1].brief).toContain('etat-erreur');
  });

  it('aucune fiche écrite est un écart', async () => {
    const rien: Handler = () => claudeOut(specReport());
    const h = harness({ lots, script: { spec: [rien, rien] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(h.calls[1].brief).toContain('fiche.yaml');
  });

  it('la fiche d’un autre lot (ecran.lot différent) est un écart', async () => {
    const m = spec({ fiche: (d) => { d.ecran.lot = 'L9'; } });
    const h = harness({ lots, script: { spec: [m, m] } });
    await runLot(h.lot('L1', screen));
    expect(h.calls[1].brief).toContain('L9');
  });

  it('un ecran.id qui ne correspond pas au dossier est un écart', async () => {
    const m = spec({ dossier: 'autre-dossier' });
    const h = harness({ lots, script: { spec: [m, m] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(h.calls[1].brief).toContain('ne correspond pas au dossier docs/specs/autre-dossier');
    expect(c.lot.status).toBe('handed-back');
  });

  it('un ecran.maquette différent de <dossier>/maquette.html est un écart', async () => {
    const m = spec({ fiche: (d) => { d.ecran.maquette = 'docs/ailleurs/maquette.html'; } });
    const h = harness({ lots, script: { spec: [m, m] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(h.calls[1].brief).toContain('ecran.maquette');
    expect(h.calls[1].brief).toContain('docs/ailleurs/maquette.html');
    expect(c.lot.status).toBe('handed-back');
  });

  it('un fichier de la spec resté hors de git rend le lot (dépôt sale)', async () => {
    const sale: Handler = (call) => {
      const fiche = ecrit(call.opts.cwd);
      writeFileSync(join(call.opts.cwd, 'brouillon.txt'), 'x');
      return claudeOut(specReport({ fiche }));
    };
    const h = harness({ lots, script: { spec: [sale] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('brouillon.txt');
  });
  it('un fichier laissé dans un dépôt voisin par la session spec rend le lot (dépôt sale)', async () => {
    const nb = gitRepo();
    commitFile(nb, 'README.md', 'init');
    const sale: Handler = (call) => {
      const fiche = ecrit(call.opts.cwd);
      writeFileSync(join(nb, 'brouillon.txt'), 'x');
      return claudeOut(specReport({ fiche }));
    };
    const h = harness({ lots, script: { spec: [sale] } });
    const c = h.lot('L1', { ...screen, repos: [{ rel: '../gitops', path: nb }] });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('../gitops: brouillon.txt');
  });
});

describe('étape spec : question ciblée', () => {
  it('une hypothèse dont si_faux touche un stockage de données devient une question, pas une hypothèse', async () => {
    const m = spec({ fiche: (d) => { d.regles[2].si_faux = 'Si faux, une migration du stockage des rappels serait à écrire.'; } });
    const h = harness({ lots, script: { spec: [m] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(c.lot.status).toBe('question');
    expect(c.lot.next).toBe('spec');
    expect(c.lot.questions[0]).toContain('R3');
    expect(kinds(h)).toEqual(['spec']);
  });

  it('la réponse du lead est donnée à la session spec reprise', async () => {
    const m = spec({ fiche: (d) => { d.regles[2].si_faux = 'Si faux, une migration du stockage des rappels serait à écrire.'; } });
    const h = harness({ lots, script: { spec: [m, spec()], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    c.lot.pendingAnswer = 'les rappels restent côté client';
    await runLot(c);
    expect(h.calls[1].brief).toContain('les rappels restent côté client');
    expect(kinds(h)).toEqual(['spec', 'spec', 'implement', 'review']);
  });

  it('la reprise rappelle la règle posée en question et dit de la passer en sourcee avec la réponse du lead', async () => {
    const m = spec({ fiche: (d) => { d.regles[2].si_faux = 'Si faux, une migration du stockage des rappels serait à écrire.'; } });
    const confirme = spec({ fiche: (d) => { d.regles[2].statut = 'sourcee'; d.regles[2].source = 'réponse du lead'; delete d.regles[2].si_faux; } });
    const h = harness({ lots, script: { spec: [m, confirme], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    c.lot.questions = []; // --answer vide les questions
    c.lot.pendingAnswer = 'confirmé, garder R3';
    await runLot(c);
    expect(h.calls[1].brief).toContain('R3');
    expect(h.calls[1].brief).toContain('migration du stockage');
    expect(h.calls[1].brief).toContain('source: réponse du lead');
    expect(kinds(h)).toEqual(['spec', 'spec', 'implement', 'review']);
  });

  it('une question de la session après une hypothèse coûteuse tranchée : sa réponse n’est pas présentée comme celle des hypothèses', async () => {
    const m = spec({ fiche: (d) => { d.regles[2].si_faux = 'Si faux, une migration du stockage des rappels serait à écrire.'; } });
    const demande: Handler = () => claudeOut(specReport({ questions: ['Quelle route pour cet écran ?'] }));
    const h = harness({ lots, script: { spec: [m, demande, spec()], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    c.lot.questions = [];
    c.lot.pendingAnswer = 'confirmé, garder R3';
    await runLot(c);
    expect(c.lot.status).toBe('question');
    c.lot.questions = [];
    c.lot.pendingAnswer = '/matchs';
    await runLot(c);
    expect(h.calls[2].brief).toContain('/matchs');
    expect(h.calls[2].brief).not.toContain('The program asked the lead');
    expect(kinds(h)).toEqual(['spec', 'spec', 'spec', 'implement', 'review']);
  });

  it('les écarts corrigés à la passe 2 ne sont pas redits quand la reprise suit une hypothèse coûteuse', async () => {
    const m = spec({ sansCapture: ['maquette-vide-1440.png'] });
    const cout = spec({ fiche: (d) => { d.regles[2].si_faux = 'Si faux, une migration du stockage des rappels serait à écrire.'; } });
    const h = harness({ lots, script: { spec: [m, cout, spec()], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    await runLot(c);
    expect(c.lot.status).toBe('question');
    c.lot.questions = [];
    c.lot.pendingAnswer = 'confirmé, garder R3';
    await runLot(c);
    expect(h.calls[2].brief).not.toContain('fix exactly these points');
  });

  it('une question du rapport arrête le lot en question, l’étape suivante reste spec', async () => {
    const h = harness({ lots, script: { spec: [() => claudeOut(specReport({ questions: ['Faut-il garder l’URL /match déjà publiée ?'] }))] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(c.lot.status).toBe('question');
    expect(c.lot.next).toBe('spec');
    expect(kinds(h)).toEqual(['spec']);
  });

  it('une hypothèse banale (libellé, ordre) reste une hypothèse écrite', () => {
    const doc = parse(readFileSync(EXEMPLE, 'utf8')) as any;
    expect(costlyHypotheses(doc)).toEqual([]);
  });

  it.each([
    ['Si faux, le modèle de données change.', true],
    ['Si le contrat d’API public doit changer.', true],
    ['La route déjà publiée /match serait renommée.', true],
    ['Une suppression irréversible des rappels.', true],
    ['Un paiement serait déclenché.', true],
    ['Cette règle contredit R4 du lot L12.', true],
    ['Si le club veut un autre libellé, seul ce bloc change.', false],
    ['Rien d’irréversible : le bouton Réessayer relit simplement la liste.', false],
    ['Aucune suppression, pas de paiement, sans envoi.', false],
    ['Rien d’irréversible, mais une suppression des rappels.', true],
    ['Pas de migration ; le paiement est déclenché.', true],
  ])('costlyHypotheses : %s', (siFaux, coûteux) => {
    const doc = { regles: [{ id: 'R1', statut: 'hypothese', si_faux: siFaux }, { id: 'R2', statut: 'sourcee', si_faux: 'une migration' }] };
    expect(costlyHypotheses(doc).map((x) => x.id)).toEqual(coûteux ? ['R1'] : []);
  });
});

describe('specScreen (L209) : un lot component déjà entré dans la chaîne', () => {
  const repoWith = (files: Record<string, string>): string => {
    const repo = tempDir();
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(repo, 'docs/specs', f.split('/')[0]), { recursive: true });
      writeFileSync(join(repo, 'docs/specs', f), text);
    }
    return repo;
  };

  it('une fiche back (bloc sujet seul) ou son acceptation ne fait pas entrer un lot component : c\'est la spec back d\'un lot spec: true', () => {
    const repo = repoWith({ 'import/fiche.yaml': 'sujet:\n  id: import\n  lot: L3\n', 'import/acceptation-L3.json': '{}' });
    expect(specScreen(repo, 'docs/specs', { id: 'L3', screen: 'component' })).toBeUndefined();
    expect(specScreen(repo, 'docs/specs', { id: 'L3', screen: 'journey' })).toBeUndefined();
  });

  it('une fiche avec un bloc ecran du lot, ou une acceptation voisine d\'une fiche à ecran, le fait entrer', () => {
    const repo = repoWith({ 'carte/fiche.yaml': 'ecran:\n  id: carte\n  lot: L1\n', 'carte/acceptation-L2.json': '{}' });
    expect(specScreen(repo, 'docs/specs', { id: 'L1', screen: 'component' })).toBe('component');
    expect(specScreen(repo, 'docs/specs', { id: 'L2', screen: 'journey' })).toBe('journey');
  });
});
