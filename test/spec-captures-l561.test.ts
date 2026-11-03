import { describe, expect, it } from 'vitest';
import { checkSpec } from '../src/orchestrate/spec.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, harness, reviewReport, specReport, type Handler } from './orchestrate-harness.js';
import { gitRepo } from './helpers.js';
import { ecrit } from './spec-helpers.js';

// L561 (issue #29) : deux captures d'états différents à la même largeur qui ont la même empreinte, ou une capture sombre identique à sa claire, sont des captures copiées.

const repo = (o: Parameters<typeof ecrit>[1] = {}) => {
  const dir = gitRepo();
  return { dir, fiche: ecrit(dir, o) };
};

describe('contrôle des captures copiées après l\'étape spec (L561, issue #29)', () => {
  it('captures toutes distinctes : aucun écart', () => {
    const { dir, fiche } = repo();
    expect(checkSpec(dir, fiche, 'L1')).toEqual([]);
  });

  it('deux états différents à la même largeur avec la même empreinte : un écart qui nomme les deux fichiers', () => {
    const { dir, fiche } = repo({ contenu: (f) => (f === 'maquette-erreur-1440.png' || f === 'maquette-vide-1440.png' ? 'copie' : undefined) });
    const p = checkSpec(dir, fiche, 'L1');
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('maquette-vide-1440.png');
    expect(p[0]).toContain('maquette-erreur-1440.png');
    expect(p[0]).toMatch(/même empreinte/);
  });

  it('la même empreinte à deux largeurs différentes n\'est pas un écart', () => {
    const { dir, fiche } = repo({ contenu: (f) => (f === 'maquette-vide-1440.png' || f === 'maquette-vide-390.png' ? 'copie' : undefined) });
    expect(checkSpec(dir, fiche, 'L1')).toEqual([]);
  });

  it('trois états copiés à une largeur : un seul écart qui les nomme tous', () => {
    const { dir, fiche } = repo({ contenu: (f) => (/^maquette-(vide|erreur|chargement)-390\.png$/.test(f) ? 'copie' : undefined) });
    const p = checkSpec(dir, fiche, 'L1');
    expect(p).toHaveLength(1);
    for (const e of ['vide', 'erreur', 'chargement']) expect(p[0]).toContain(`maquette-${e}-390.png`);
  });

  it('une capture sombre identique à sa claire : un écart ; différente : aucun', () => {
    const copie = repo({ captures: ['maquette-vide-sombre-1440.png'], contenu: (f) => (f === 'maquette-vide-sombre-1440.png' ? 'png vide 1440' : undefined) });
    const p = checkSpec(copie.dir, copie.fiche, 'L1');
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('maquette-vide-sombre-1440.png');
    expect(p[0]).toContain('maquette-vide-1440.png');
    expect(p[0]).toMatch(/sombre/);
    const bonne = repo({ captures: ['maquette-vide-sombre-1440.png'] });
    expect(checkSpec(bonne.dir, bonne.fiche, 'L1')).toEqual([]);
  });

  it('une capture manquante n\'ajoute pas d\'écart de copie : seul « absent » est relevé', () => {
    const { dir, fiche } = repo({ sansCapture: ['maquette-vide-1440.png'] });
    const p = checkSpec(dir, fiche, 'L1');
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/absent/);
  });

  it('deux captures vides (0 octet) à la même largeur sont signalées comme copies', () => {
    const { dir, fiche } = repo({ contenu: (f) => (f === 'maquette-vide-1440.png' || f === 'maquette-erreur-1440.png' ? '' : undefined) });
    expect(checkSpec(dir, fiche, 'L1').join('\n')).toMatch(/même empreinte/);
  });

  it('une capture copiée renvoie le lot à une session spec dont le brief nomme les deux fichiers ; la session suivante la corrige', async () => {
    const copie: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd, { contenu: (f) => (f === 'maquette-erreur-1440.png' || f === 'maquette-vide-1440.png' ? 'copie' : undefined) }) }));
    const bonne: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }));
    const ok: Handler = () => claudeOut(reviewReport());
    const h = harness({ lots: [{ title: 'Une page', screen: 'page' as const }], script: { spec: [copie, bonne], maquette: [ok] } });
    await runLot(h.lot('L1', { visible: true, screen: 'page' }, { maquette: true }));
    expect(h.calls.slice(0, 3).map((c) => c.kind)).toEqual(['spec', 'spec', 'maquette']);
    expect(h.calls[1].brief).toContain('maquette-vide-1440.png');
    expect(h.calls[1].brief).toContain('maquette-erreur-1440.png');
    expect(h.calls[1].brief).toMatch(/même empreinte/);
  });
});
