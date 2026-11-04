import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { hypothesesOf } from '../src/audit.js';
import { gitRepo } from './helpers.js';
import { git } from './orchestrate-harness.js';

// L570 (issue #33) : sur une fiche partagée, `cadence news check` n'attend que les hypothèses du lot (clé « regles », sinon les règles touchées par ses commits spec/docs).
const DIR = 'docs/specs/x';
const FICHE = `${DIR}/fiche.yaml`;
const refsOf = (text: string) => [...text.matchAll(/L\d+/g)].map((m) => ({ lot: m[0] }));
const regle = (id: string, statut: string, enonce = 'énoncé') => ({ id, statut, enonce });
const REGLES = [regle('R1', 'sourcee'), regle('R2', 'hypothese'), regle('R3', 'hypothese'), regle('R4', 'hypothese')];

const commit = (repo: string, message: string, ...paths: string[]) => {
  git(repo, 'add', '--', ...paths);
  git(repo, 'commit', '-q', '-m', message, '--', ...paths);
};
const ecritFiche = (repo: string, regles = REGLES) => {
  mkdirSync(join(repo, DIR), { recursive: true });
  writeFileSync(join(repo, FICHE), stringify({ ecran: { lot: 'L9' }, regles }));
};
const ecritAcc = (repo: string, lot: string, regles?: unknown) => {
  const json = `${DIR}/acceptation-${lot}.json`;
  writeFileSync(join(repo, json), JSON.stringify({ lot, fiche: FICHE, fichiers: ['test/x.test.ts'], vert: false, ...(regles === undefined ? {} : { regles }) }));
  return json;
};
/** La fiche existe (commit hors spec/docs : aucune règle n'est au lot L9) ; L9 la possède ; `voisin` : un autre lot L1 a son acceptation sur la même fiche. */
const monde = (o: { voisin?: boolean; reglesL9?: unknown } = {}) => {
  const repo = gitRepo();
  ecritFiche(repo);
  const j9 = ecritAcc(repo, 'L9', o.reglesL9);
  commit(repo, 'chore: fiche initiale', FICHE, j9);
  if (o.voisin) commit(repo, 'test(L1): acceptation', ecritAcc(repo, 'L1'));
  return repo;
};
const lues = (repo: string) => hypothesesOf(repo, join(repo, 'cadence.yaml'), refsOf).get('L9');

describe('hypothesesOf : fiche partagée (L570)', () => {
  it('R1 — la clé « regles » du lot restreint les hypothèses attendues à ses règles', () => {
    expect(lues(monde({ reglesL9: ['R1', 'R3'] }))).toEqual(['R3']);
  });

  it('R2 — sans clé, sur fiche partagée, les règles que ses commits spec/docs ajoutent ou modifient', () => {
    const repo = monde({ voisin: true });
    ecritFiche(repo, REGLES.map((r) => (r.id === 'R4' ? { ...r, enonce: 'modifié' } : r)));
    commit(repo, 'spec(L9): R4 amendée', FICHE);
    expect(lues(repo)).toEqual(['R4']);
  });

  it("R2 — le commit d'un autre lot ne compte pas", () => {
    const repo = monde({ voisin: true });
    ecritFiche(repo, REGLES.map((r) => (r.id === 'R4' ? { ...r, enonce: 'modifié' } : r)));
    commit(repo, 'spec(L1): R4 amendée', FICHE);
    expect(lues(repo)).toEqual(['R2', 'R3', 'R4']);
  });

  it('R3 — rien ne restreint (fiche non partagée, sans clé) : la fiche entière', () => {
    expect(lues(monde())).toEqual(['R2', 'R3', 'R4']);
  });

  it('R3 — fiche partagée mais aucune règle touchée par le lot : la fiche entière', () => {
    expect(lues(monde({ voisin: true }))).toEqual(['R2', 'R3', 'R4']);
  });

  it('R4 — une restriction qui ne désigne aucune hypothèse n\'en attend aucune', () => {
    expect(lues(monde({ reglesL9: ['R1'] }))).toBeUndefined();
  });

  it('R5 — sans refsOf, la fiche entière comme avant (appelants sans plan)', () => {
    const repo = monde({ reglesL9: ['R3'] });
    expect(hypothesesOf(repo, join(repo, 'cadence.yaml')).get('L9')).toEqual(['R2', 'R3', 'R4']);
  });
});
