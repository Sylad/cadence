import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { hypothesesOf } from '../src/audit.js';
import { run } from '../src/cli.js';
import * as accept from '../src/orchestrate/accept.js';
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

describe('hypothesesOf : acceptation et coût (L570, correctifs de revue)', () => {
  it("l'acceptation d'un lot sur une autre fiche ne restreint pas la fiche parcourue", () => {
    const repo = monde();
    mkdirSync(join(repo, 'docs/specs/a'), { recursive: true });
    const autre = 'docs/specs/a/acceptation-L9.json';
    writeFileSync(join(repo, autre), JSON.stringify({ lot: 'L9', fiche: 'docs/specs/a/fiche.yaml', fichiers: ['test/x.test.ts'], vert: false, regles: ['R2'] }));
    commit(repo, 'test(L9): acceptation voisine', autre);
    expect(lues(repo)).toEqual(['R2', 'R3', 'R4']);
  });

  it("ne cherche l'acceptation que pour une fiche qui a une hypothèse", () => {
    const repo = gitRepo();
    ecritFiche(repo, [regle('R1', 'sourcee')]);
    commit(repo, 'chore: fiche', FICHE);
    const spy = vi.spyOn(accept, 'findAcceptation');
    try {
      expect(lues(repo)).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('cadence news check : fiche partagée (L570)', () => {
  it('news check et raf check n\'attendent que les hypothèses du lot', () => {
    const repo = monde({ reglesL9: ['R1', 'R3'] });
    const cli = (...argv: string[]) => {
      const out: string[] = [];
      const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-10-11' }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date('2026-10-11T10:12:00') });
      return { code, out: out.join('\n') };
    };
    cli('init', '--project', 'demo', '--no-hook');
    cli('add', 'Écran', '--visible');
    writeFileSync(join(repo, FICHE), stringify({ ecran: { lot: 'L1' }, regles: REGLES }));
    const json = `${DIR}/acceptation-L1.json`;
    writeFileSync(join(repo, json), JSON.stringify({ lot: 'L1', fiche: FICHE, fichiers: ['test/x.test.ts'], vert: false, regles: ['R1', 'R3'] }));
    git(repo, 'rm', '-q', '--cached', `${DIR}/acceptation-L9.json`);
    writeFileSync(join(repo, `${DIR}/acceptation-L9.json`), JSON.stringify({ lot: 'L9', fiche: FICHE, fichiers: ['test/x.test.ts'], vert: false }));
    commit(repo, 'chore: acceptations', FICHE, json, `${DIR}/acceptation-L9.json`);
    cli('start', 'L1');
    mkdirSync(join(repo, 'docs/nouveautes'), { recursive: true });
    const file = join(repo, 'docs/nouveautes/2026-10-11-ecran.md');
    const head = '---\ntitle: Écran\ndate: 2026-10-11\ncreated: 2026-10-11T10:00+00:00\nlots: [L1]\nnocapture: maquette\n---\n';
    writeFileSync(file, `${head}Un écran.\n\n## Hypothèses\n- R3 — x. À confirmer.\n`);
    for (const cmd of [['news', 'check'], ['check']]) {
      const r = cli(...cmd);
      expect(r.out).not.toContain('R2');
      expect(r.out).not.toContain('R4');
      expect(r.out).not.toContain('pas de ligne pour R3');
    }
  });
});
