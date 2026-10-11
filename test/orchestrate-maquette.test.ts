import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig } from '../src/config.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { mcpServersFor, readAgents } from '../src/orchestrate/launch.js';
import { AGENTS_DIR } from '../src/skills.js';
import { DIR, ecritAcceptation } from './accept-helpers.js';
import { sealAcceptation, setVert } from '../src/orchestrate/accept.js';
import { acceptReport, claudeOut, commitFile, git, harness, reviewReport, specReport, workReport, type Handler } from './orchestrate-harness.js';
import { ecrit } from './spec-helpers.js';
import { tempDir } from './helpers.js';

// L172 (spec etape-spec, S4) : la revue UX de la maquette, entre spec et accept, par l'agent ux-reviewer en mode « maquette ».
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());
const screen = { visible: true, screen: 'page' as const };
const lots = [{ title: 'Un écran', screen: 'page' as const }];
const config = { maquette: true };
const spec: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }));
const major = (texte = 'le message de R3 n’est pas visible dans #etat-erreur') => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'docs/specs/prochain-match/maquette.html', ligne: 12, texte }], verdict: 'non conforme : 1 majeur' }));

describe('revue de la maquette : où elle s’insère', () => {
  it('spec → maquette → implement → revue, la revue est mémorisée', async () => {
    const h = harness({ lots, script: { spec: [spec], maquette: [ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'maquette', 'implement', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.maquette).toMatchObject({ passes: 1, conforme: true });
  });

  it('avec orchestrate.accept : spec → maquette → accept → implement', async () => {
    const accept: Handler = (call) => {
      ecritAcceptation(call.opts.cwd, { sansFiche: true });
      return claudeOut(acceptReport());
    };
    const h = harness({ lots, script: { spec: [spec], maquette: [ok], accept: [accept], implement: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'done.flag', 'feat(L1): a')] }))], review: [ok] } });
    await runLot(h.lot('L1', screen, { ...config, accept: 'test -f done.flag', test: 'true' }));
    expect(kinds(h)).toEqual(['spec', 'maquette', 'accept', 'implement', 'review']);
  });

  it('orchestrate.maquette: false : la revue n’a pas lieu', async () => {
    const h = harness({ lots, script: { spec: [spec], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', screen, { maquette: false }));
    expect(kinds(h)).toEqual(['spec', 'implement', 'review']);
  });

  it('une fiche déjà commitée (reprise) est relue avant implement', async () => {
    const h = harness({ lots, script: { maquette: [ok], implement: [impl], review: [ok] } });
    ecrit(h.repo);
    await runLot(h.lot('L1', screen, config));
    expect(kinds(h)).toEqual(['maquette', 'implement', 'review']);
  });

  it('sans orchestrate.accept, un lot dont le code est déjà commité après la fiche ne rejoue pas la revue', async () => {
    const h = harness({ lots, script: { review: [ok] } });
    ecrit(h.repo);
    commitFile(h.repo, 'a.txt', 'feat(L1): a');
    await runLot(h.lot('L1', screen, config));
    expect(kinds(h)).not.toContain('maquette');
    expect(kinds(h)).not.toContain('spec');
  });

  it('sans orchestrate.accept, un commit du lot limité au dossier de la fiche après le code ne masque pas ce code', async () => {
    const h = harness({ lots, script: { review: [ok] } });
    ecrit(h.repo);
    commitFile(h.repo, 'a.txt', 'feat(L1): a');
    commitFile(h.repo, 'docs/specs/prochain-match/maquette-erreur-390.png', 'fix(L1): capture à jour');
    await runLot(h.lot('L1', screen, config));
    expect(kinds(h)).not.toContain('maquette');
    expect(kinds(h)).not.toContain('spec');
  });

  const commite = (repo: string, json: string, msg: string) => {
    git(repo, 'add', '--', json);
    git(repo, 'commit', '-q', '-m', msg, '--', json);
  };

  it('une acceptation scellée (reprise) prouve la maquette relue : pas de nouvelle revue', async () => {
    const h = harness({ lots, script: { implement: [impl], review: [ok] } });
    ecrit(h.repo);
    const a = ecritAcceptation(h.repo, { sansFiche: true });
    sealAcceptation(h.repo, a.json);
    commite(h.repo, a.json, 'test(L1): acceptation scellée');
    await runLot(h.lot('L1', screen, { ...config, accept: 'true', test: 'true' }));
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('une acceptation verte (vert: true, lot relancé dans une nouvelle vague) prouve aussi la revue', async () => {
    const h = harness({ lots, script: { implement: [impl], review: [ok] } });
    ecrit(h.repo);
    const a = ecritAcceptation(h.repo, { sansFiche: true });
    sealAcceptation(h.repo, a.json);
    commite(h.repo, a.json, 'test(L1): acceptation scellée');
    setVert(h.repo, a.json);
    commite(h.repo, a.json, 'chore(L1): acceptation verte');
    await runLot(h.lot('L1', screen, { ...config, accept: 'true', test: 'true' }));
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('une acceptation aux empreintes vides ou fausses ne prouve rien : la maquette est relue', async () => {
    const h = harness({ lots, script: { maquette: [ok], accept: [() => claudeOut(acceptReport())], implement: [impl], review: [ok] } });
    ecrit(h.repo);
    const a = ecritAcceptation(h.repo, { sansFiche: true });
    const doc = JSON.parse(readFileSync(join(h.repo, a.json), 'utf8'));
    writeFileSync(join(h.repo, a.json), JSON.stringify({ ...doc, empreintes: {} }, null, 2));
    commite(h.repo, a.json, 'test(L1): acceptation aux empreintes vides');
    await runLot(h.lot('L1', screen, { ...config, accept: 'true', test: 'true' }));
    expect(kinds(h)[0]).toBe('maquette');
  });

  it('une acceptation non scellée (sans empreintes) ne prouve rien : la maquette est relue', async () => {
    const h = harness({ lots, script: { maquette: [ok], accept: [() => claudeOut(acceptReport())], implement: [impl], review: [ok] } });
    ecrit(h.repo);
    ecritAcceptation(h.repo, { sansFiche: true });
    const c = h.lot('L1', screen, { ...config, accept: 'true', test: 'true' });
    await runLot(c);
    expect(kinds(h)).toEqual(['maquette', 'accept', 'accept']);
    expect(c.lot.status).toBe('failed');
  });

  it('une acceptation commitée mais non scellée rejoue accept, même sans revue de maquette (orchestrate.maquette: false)', async () => {
    const h = harness({ lots, script: { accept: [() => claudeOut(acceptReport())], implement: [impl], review: [ok] } });
    ecrit(h.repo);
    ecritAcceptation(h.repo, { sansFiche: true });
    const c = h.lot('L1', screen, { maquette: false, accept: 'true', test: 'true' });
    await runLot(c);
    expect(kinds(h)[0]).toBe('accept');
    expect(kinds(h)).not.toContain('implement');
  });

  it('sans fiche, la maquette est sautée et l’avertissement le dit', async () => {
    const h = harness({ lots, script: { implement: [impl], review: [ok] } });
    const c = h.lot('L1', { visible: true, screen: 'page' as const }, config);
    c.lot.next = 'maquette';
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.warnings.join('\n')).toMatch(/revue de la maquette ignorée : aucune fiche/);
  });

  it('une sortie sous le seuil de la spec ne déclenche aucune revue de maquette', async () => {
    const h = harness({ lots, script: { spec: [() => claudeOut(specReport({ sousSeuil: 'aucun écran' }))], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', screen, config));
    expect(kinds(h)).toEqual(['spec', 'implement', 'review']);
  });

  it('un lot sans screen: ne passe jamais par la maquette', async () => {
    const h = harness({ lots: [{ title: 'Autre', visible: true }], script: { implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', { visible: true }, config));
    expect(kinds(h)).toEqual(['implement', 'review']);
  });
});

describe('revue de la maquette : la session', () => {
  it('agent ux-reviewer, Playwright chargé, effort de maquette, brief : fiche, maquette, captures, cohérence', async () => {
    const h = harness({ lots, script: { spec: [spec], maquette: [ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen, { ...config, effort: { ...readOrchestrateConfig('/nope').effort, maquette: 'low' } });
    await runLot(c);
    const call = h.calls[1];
    expect(call.args[call.args.indexOf('--agent') + 1]).toBe('ux-reviewer');
    expect(call.args).toContain('--mcp-config');
    expect(call.effort).toBe('low');
    for (const attendu of ['L1', 'docs/specs/prochain-match/fiche.yaml', 'docs/specs/prochain-match/maquette.html', 'maquette-<état>-<largeur>.png', '1440', '390', 'data-testid', 'etat-', 'first review', 'sousTaches']) {
      expect(call.brief, attendu).toContain(attendu);
    }
    expect(call.brief).not.toContain('the running app');
  });

  it('mcpServersFor charge Playwright pour la maquette, même sur un lot non visible', () => {
    expect(Object.keys(mcpServersFor('maquette', true, '/run/p--L1/playwright'))).toEqual(['playwright']);
    expect(Object.keys(mcpServersFor('maquette', false, '/run/p--L1/playwright'))).toEqual(['playwright']);
  });

  it('la revue ne modifie pas le dépôt : une session qui y écrit rend le lot', async () => {
    const h = harness({ lots, script: { spec: [spec], maquette: [(call) => { commitFile(call.opts.cwd, 'intrus.txt', 'feat(L1): intrus'); return claudeOut(reviewReport()); }] } });
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(kinds(h)).toEqual(['spec', 'maquette']);
  });
});

describe('revue de la maquette : la boucle, deux passes au plus', () => {
  it('un majeur renvoie à la spec avec le constat, puis la maquette est relue', async () => {
    const h = harness({ lots, script: { spec: [spec, spec], maquette: [() => major(), ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'maquette', 'spec', 'maquette', 'implement', 'review']);
    const second = h.calls[2].brief;
    expect(second).toContain('le message de R3 n’est pas visible dans #etat-erreur');
    expect(second).toContain('maquette.html:12');
    expect(second).toMatch(/UX review of your mockup/);
    expect(h.calls[3].brief).toContain('second and last review');
    expect(c.lot.maquette).toMatchObject({ passes: 2, conforme: true });
    expect(c.lot.status).toBe('ready');
  });

  it('un bloquant fait de même', async () => {
    const blocking = () => claudeOut(reviewReport({ bloquants: 1, constats: [{ gravite: 'bloquant', texte: 'contraste 2:1 du texte d’erreur' }], verdict: 'non conforme : 1 bloquant' }));
    const h = harness({ lots, script: { spec: [spec, spec], maquette: [blocking, ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', screen, config));
    expect(kinds(h)).toEqual(['spec', 'maquette', 'spec', 'maquette', 'implement', 'review']);
  });

  it('non conforme après la passe 2 : le lot est rendu au lead avec ce qui reste, sans implement', async () => {
    const h = harness({ lots, script: { spec: [spec, spec], maquette: [() => major(), () => major('R2 : le bouton Réessayer manque')] } });
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'maquette', 'spec', 'maquette']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('R2 : le bouton Réessayer manque');
    expect(c.lot.maquette).toMatchObject({ passes: 2, conforme: false });
  });

  it('les mineurs vont en notes du lot (propositions), sans renvoyer à la spec', async () => {
    const minor = () => claudeOut(reviewReport({ mineurs: 1, constats: [{ gravite: 'mineur', fichier: 'docs/specs/prochain-match/maquette.html', texte: 'espacement entre les cartes' }], verdict: 'conforme : 1 mineur' }));
    const h = harness({ lots, script: { spec: [spec], maquette: [minor], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'maquette', 'implement', 'review']);
    expect(c.lot.proposals.join('\n')).toContain('[mineur maquette]');
    expect(c.lot.proposals.join('\n')).toContain('espacement entre les cartes');
  });

  it('un constat annoncé majeur par les seuls totaux n’est pas cru conforme', async () => {
    const h = harness({ lots, script: { spec: [spec, spec], maquette: [() => claudeOut(reviewReport({ majeurs: 1, verdict: 'non conforme' })), ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', screen, config));
    expect(kinds(h)).toEqual(['spec', 'maquette', 'spec', 'maquette', 'implement', 'review']);
  });
});

describe('revue de la maquette : agent et configuration', () => {
  it('l’agent ux-reviewer décrit le mode maquette : captures, cohérence maquette ↔ fiche, lecture seule', () => {
    const a = readAgents(AGENTS_DIR)['ux-reviewer'];
    expect(a.prompt).toMatch(/mockup mode/i);
    for (const attendu of ['maquette.html', 'fiche.yaml', 'data-testid', 'etat', 'message', '1440', '390']) expect(a.prompt, attendu).toContain(attendu);
    expect(a.prompt).toMatch(/not\W+raf ux/i);
  });

  it('orchestrate.maquette : booléen, vrai par défaut, effort.maquette accepté', () => {
    const dir = tempDir();
    const write = (y: string) => {
      writeFileSync(join(dir, 'cadence.yaml'), y);
      return readOrchestrateConfig(join(dir, 'cadence.yaml'));
    };
    expect(readOrchestrateConfig('/nope').maquette).toBe(true);
    expect(readOrchestrateConfig('/nope').effort.maquette).toBe('high');
    expect(write('orchestrate:\n  maquette: false\n  effort:\n    maquette: low\n')).toMatchObject({ maquette: false, effort: { maquette: 'low' } });
    expect(() => write('orchestrate:\n  maquette: oui\n')).toThrow(/maquette/);
  });
});
