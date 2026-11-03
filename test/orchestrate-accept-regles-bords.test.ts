import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { checkAcceptation, sealAcceptation } from '../src/orchestrate/accept.js';
import { gitRepo } from './helpers.js';
import { git } from './orchestrate-harness.js';

// Sonde L552 (fiche accept-regles-du-lot) : les bords de R2, R3, R4, R7, R8, R10, R12.

const DIR = 'docs/specs/x';
const FICHE = `${DIR}/fiche.yaml`;
const refsOf = (text: string) => [...text.matchAll(/L\d+/g)].map((m) => ({ lot: m[0] }));
const ctx = { dir: 'docs/specs', refsOf };
const IDS = ['R1', 'R2', 'R3', 'R4', 'R5'];

const commit = (repo: string, message: string, ...paths: string[]) => {
  git(repo, 'add', '--', ...paths);
  git(repo, 'commit', '-q', '-m', message, '--', ...paths);
};
const regle = (id: string, enonce = 'énoncé') => ({ id, cas: ['C1'], enonce, tests: [`${id} — cas`] });
const ecritFiche = (repo: string, enonces: Record<string, string> = {}, ids = IDS) => {
  mkdirSync(join(repo, DIR), { recursive: true });
  writeFileSync(join(repo, FICHE), stringify({ regles: ids.map((id) => regle(id, enonces[id])) }));
};
const ecritTests = (repo: string, file: string, ids: string[]) => {
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, file), ids.map((id) => `it('${id} — cas', () => {});`).join('\n'));
};
const ecritAcc = (repo: string, lot: string, fichiers: string[], o: { scelle?: boolean; regles?: unknown; fiche?: string; nom?: string } = {}) => {
  const json = `${DIR}/${o.nom ?? `acceptation-${lot}.json`}`;
  writeFileSync(join(repo, json), JSON.stringify({ lot, fiche: o.fiche ?? FICHE, fichiers, vert: false, ...('regles' in o ? { regles: o.regles } : {}) }, null, 2));
  if (o.scelle) sealAcceptation(repo, json);
  return json;
};
function monde(o: { scelleL9?: boolean; fichiersL9?: string[]; fiche9?: string; nomL9?: string } = {}): string {
  const repo = gitRepo();
  ecritFiche(repo);
  ecritTests(repo, 'test/l9.test.ts', IDS);
  const j9 = ecritAcc(repo, 'L9', o.fichiersL9 ?? ['test/l9.test.ts'], { scelle: o.scelleL9, fiche: o.fiche9, nom: o.nomL9 });
  commit(repo, 'spec(L9): fiche', FICHE);
  commit(repo, 'test(L9): acceptation (rouge)', 'test/l9.test.ts', j9);
  return repo;
}
const amende = (repo: string, sujet: string, enonces: Record<string, string>, ids = IDS, corps?: string) => {
  const prev = parse(readFileSync(join(repo, FICHE), 'utf8')) as { regles: { id: string; enonce: string }[] };
  const cur: Record<string, string> = Object.fromEntries(prev.regles.map((r) => [r.id, r.enonce]));
  ecritFiche(repo, { ...cur, ...enonces }, ids);
  git(repo, 'add', '--', FICHE);
  git(repo, 'commit', '-q', '-m', sujet, ...(corps ? ['-m', corps] : []), '--', FICHE);
};
const testsL1 = (repo: string, ids: string[], o: { regles?: unknown } = {}) => {
  ecritTests(repo, 'test/l1.test.ts', ids);
  const json = ecritAcc(repo, 'L1', ['test/l1.test.ts'], 'regles' in o ? { regles: o.regles } : {});
  commit(repo, 'test(L1): acceptation (rouge)', 'test/l1.test.ts', json);
  return json;
};
const verifie = (repo: string, json: string, c: typeof ctx | null = ctx) => checkAcceptation(repo, json, 'L1', FICHE, undefined, c ?? undefined);
const manquants = (p: string[]) => p.filter((m) => m.includes('(nom prévu dans la fiche)')).map((m) => m.split(' ')[0]);

describe('L552 R2 — bords du sujet', () => {
  it('R2 bord — sujet sans portée « spec: … L1 » : le lot est lu dans le message entier', () => {
    const repo = monde();
    amende(repo, 'spec: fiche amendée pour L1', { R2: 'nouveau' });
    expect(manquants(verifie(repo, testsL1(repo, ['R2'])))).toEqual([]);
  });
  it('R2 bord — sujet « docs(L1)!: » (rupture) compte', () => {
    const repo = monde();
    amende(repo, 'docs(L1)!: R2', { R2: 'nouveau' });
    expect(manquants(verifie(repo, testsL1(repo, ['R2'])))).toEqual([]);
  });
  it('R2 bord — portée multiple spec(L1,L2) compte pour L1', () => {
    const repo = monde();
    amende(repo, 'spec(L1,L2): R2', { R2: 'nouveau' });
    expect(manquants(verifie(repo, testsL1(repo, ['R2'])))).toEqual([]);
  });
  it('R2 bord — feat(L1) et fix(L1) qui touchent la fiche ne comptent pas : repli sur toutes les règles', () => {
    const repo = monde();
    amende(repo, 'feat(L1): R2', { R2: 'nouveau' });
    amende(repo, 'fix(L1): R3', { R3: 'nouveau' });
    expect(manquants(verifie(repo, testsL1(repo, ['R2'])))).toEqual(['R1', 'R3', 'R4', 'R5']);
  });
});

describe('L552 R3 — bords de la comparaison des règles', () => {
  it('R3 bord — le commit du lot qui crée la fiche (commit racine) : toutes les règles sont nouvelles', () => {
    const repo = gitRepo();
    ecritFiche(repo);
    commit(repo, 'spec(L1): fiche', FICHE);
    ecritTests(repo, 'test/l9.test.ts', IDS);
    const j9 = ecritAcc(repo, 'L9', ['test/l9.test.ts']);
    commit(repo, 'test(L9): acceptation', 'test/l9.test.ts', j9);
    expect(manquants(verifie(repo, testsL1(repo, ['R1'])))).toEqual(['R2', 'R3', 'R4', 'R5']);
  });
  it('R3 bord — règle supprimée par le commit du lot : non exigée, les autres amendées le sont', () => {
    const repo = monde();
    amende(repo, 'spec(L1): R3 supprimée, R2 amendée', { R2: 'nouveau' }, ['R1', 'R2', 'R4', 'R5']);
    expect(manquants(verifie(repo, testsL1(repo, ['R2'])))).toEqual([]);
  });
  it('R3 bord — commit du lot qui supprime seulement une règle : repli sur toutes les règles restantes', () => {
    const repo = monde();
    amende(repo, 'spec(L1): R3 supprimée', {}, ['R1', 'R2', 'R4', 'R5']);
    expect(manquants(verifie(repo, testsL1(repo, ['R1'])))).toEqual(['R2', 'R4', 'R5']);
  });
  it('R3 bord — la même règle amendée deux fois par le lot n\'est exigée qu\'une fois', () => {
    const repo = monde();
    amende(repo, 'spec(L1): R2 v1', { R2: 'un' });
    amende(repo, 'docs(L1): R2 v2', { R2: 'deux' });
    const p = verifie(repo, testsL1(repo, []));
    expect(manquants(p)).toEqual(['R2']);
  });
  it('R3 bord — fiche du lot devenue illisible dans un commit du lot : repli sûr, pas de plantage', () => {
    const repo = monde();
    writeFileSync(join(repo, FICHE), 'regles: [ {{{');
    commit(repo, 'spec(L1): casse', FICHE);
    ecritFiche(repo);
    commit(repo, 'docs(L1): répare', FICHE);
    expect(() => verifie(repo, testsL1(repo, ['R1']))).not.toThrow();
  });
});

describe('L552 R4 — bords de la clé « regles »', () => {
  const attendu = `${DIR}/acceptation-L1.json : clé « regles » : liste non vide d'ids de règles de la fiche attendue`;
  const essai = (regles: unknown) => {
    const repo = monde();
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    return verifie(repo, testsL1(repo, ['R2'], { regles }));
  };
  it('R4 bord — regles: null est un écart nommé', () => {
    expect(essai(null)).toEqual([attendu]);
  });
  it('R4 bord — regles: objet {} est un écart nommé', () => {
    expect(essai({})).toEqual([attendu]);
  });
  it('R4 bord — regles: chaîne "R2" est un écart nommé', () => {
    expect(essai('R2')).toEqual([attendu]);
  });
  it('R4 bord — id en double ["R2","R2"] : toléré, pas d\'écart', () => {
    expect(essai(['R2', 'R2'])).toEqual([]);
  });
  it('R4 bord — id inconnu en double : un seul écart', () => {
    expect(essai(['R9', 'R9'])).toEqual([`${DIR}/acceptation-L1.json : clé « regles » : règle « R9 » absente de la fiche`]);
  });
  it('R4 bord — id en casse ou espaces différents (« r2 », « R2 ») : inconnu', () => {
    expect(essai(['r2', ' R2'])).toHaveLength(2);
  });
  it('R4 bord — id valide + id inconnu : seul l\'inconnu est signalé, aucun test absent n\'est ajouté', () => {
    expect(essai(['R2', 'R7'])).toEqual([`${DIR}/acceptation-L1.json : clé « regles » : règle « R7 » absente de la fiche`]);
  });
  it('R4 bord — règle déclarée supprimée de la fiche au HEAD : id absent', () => {
    const repo = monde();
    amende(repo, 'spec(L1): R3 supprimée', {}, ['R1', 'R2', 'R4', 'R5']);
    expect(verifie(repo, testsL1(repo, ['R3'], { regles: ['R3'] }))).toEqual([`${DIR}/acceptation-L1.json : clé « regles » : règle « R3 » absente de la fiche`]);
  });
  it('R4 bord — fiche illisible avec regles déclarée : « fiche illisible », sans plantage', () => {
    const repo = monde();
    const json = testsL1(repo, ['R2'], { regles: ['R2'] });
    writeFileSync(join(repo, FICHE), 'regles: [ {{{');
    expect(verifie(repo, json)).toContain(`${FICHE} : fiche illisible`);
  });
  it('R4 bord — regles déclarée dont les tests sont présents seulement chez un voisin scellé : accepté', () => {
    const repo = monde({ scelleL9: true });
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    expect(verifie(repo, testsL1(repo, [], { regles: ['R2'] }))).toEqual([]);
  });
});

describe('L552 R7/R8/R12 — bords des acceptations voisines', () => {
  it('R8 bord — la fiche du voisin écrite « ./docs/specs/x/fiche.yaml » désigne la même fiche', () => {
    const repo = monde({ fiche9: `./${FICHE}` });
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    expect(manquants(verifie(repo, testsL1(repo, ['R2'])))).toEqual([]);
  });
  it('R8 bord — un second fichier d\'acceptation du même lot (acceptation-L1-bis.json) ne partage pas la fiche', () => {
    const repo = monde();
    rmSync(join(repo, DIR, 'acceptation-L9.json'));
    git(repo, 'rm', '-q', '--cached', '--', `${DIR}/acceptation-L9.json`);
    git(repo, 'commit', '-q', '-m', 'chore: retire L9');
    ecritTests(repo, 'test/l1b.test.ts', ['R1']);
    const bis = ecritAcc(repo, 'L1', ['test/l1b.test.ts'], { nom: 'acceptation-L1-bis.json' });
    commit(repo, 'test(L1): bis', 'test/l1b.test.ts', bis);
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    expect(manquants(verifie(repo, testsL1(repo, ['R2'])))).toEqual(['R1', 'R3', 'R4', 'R5']);
  });
  it('R8 bord — spec.dir inexistant : pas de plantage, fiche non partagée, tout exigé', () => {
    const repo = monde();
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    expect(manquants(verifie(repo, testsL1(repo, ['R2']), { dir: 'nulle/part', refsOf }))).toEqual(['R1', 'R3', 'R4', 'R5']);
  });
  it('R7 bord — voisin scellé dont la liste de fichiers est vide : pas de plantage, rien n\'est accepté', () => {
    const repo = monde({ scelleL9: true, fichiersL9: [] });
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    expect(() => verifie(repo, testsL1(repo, ['R2']))).not.toThrow();
  });
  it('R7 bord — voisin scellé dont le fichier de tests listé s\'écrit « ./test/l9.test.ts » : lu au HEAD', () => {
    const repo = monde({ scelleL9: true, fichiersL9: ['./test/l9.test.ts'] });
    amende(repo, 'spec(L1): R1', { R1: 'nouveau' });
    expect(manquants(verifie(repo, testsL1(repo, [])))).toEqual([]);
  });
  it('R7 bord — voisin scellé mais ses tests ne sont que dans l\'arbre de travail (non commités) : signalé', () => {
    const repo = monde({ scelleL9: true });
    amende(repo, 'spec(L1): R1', { R1: 'nouveau' });
    const json = testsL1(repo, []);
    writeFileSync(join(repo, 'test/l9.test.ts'), 'rien');
    git(repo, 'commit', '-q', '-m', 'test(L9): vidé', '--', 'test/l9.test.ts');
    writeFileSync(join(repo, 'test/l9.test.ts'), "it('R1 — cas', () => {});");
    expect(manquants(verifie(repo, json))).toEqual(['R1']);
  });
  it('R12 bord — voisin dont la clé fiche n\'est pas une chaîne : sauté, aucun écart', () => {
    const repo = monde();
    writeFileSync(join(repo, DIR, 'acceptation-L8.json'), JSON.stringify({ lot: 'L8', fiche: 3, fichiers: [], vert: false }));
    commit(repo, 'test(L8): bizarre', `${DIR}/acceptation-L8.json`);
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    expect(manquants(verifie(repo, testsL1(repo, ['R2'])))).toEqual([]);
  });
  it('R12 bord — voisin scellé avec fichier de tests supprimé du HEAD : aucun écart, nom non compté', () => {
    const repo = monde({ scelleL9: true });
    git(repo, 'rm', '-q', '--', 'test/l9.test.ts');
    git(repo, 'commit', '-q', '-m', 'chore: retire les tests L9');
    amende(repo, 'spec(L1): R1', { R1: 'nouveau' });
    expect(manquants(verifie(repo, testsL1(repo, [])))).toEqual(['R1']);
  });
});

describe('L552 R10 — bords de la fiche, comme avant', () => {
  const brut = (yaml: string) => {
    const repo = gitRepo();
    mkdirSync(join(repo, DIR), { recursive: true });
    writeFileSync(join(repo, FICHE), yaml);
    ecritTests(repo, 'test/l1.test.ts', ['R1']);
    const json = ecritAcc(repo, 'L1', ['test/l1.test.ts']);
    commit(repo, 'test(L1): acceptation', FICHE, 'test/l1.test.ts', json);
    return checkAcceptation(repo, json, 'L1', FICHE);
  };
  it('R10 bord — fiche sans clé regles : aucun écart', () => {
    expect(brut('sujet: {id: x}\n')).toEqual([]);
  });
  it('R10 bord — regles est une chaîne : comme avant, pas de « fiche illisible »', () => {
    expect(brut('regles: abc\n')).toEqual([]);
  });
  it('R10 bord — règle sans tests ni id : comme avant, aucun écart', () => {
    expect(brut('regles:\n  - {cas: [C1]}\n')).toEqual([]);
  });
  it('R10 bord — règle dont tests n\'est pas une liste : ignorée comme avant', () => {
    expect(brut('regles:\n  - {id: R1, tests: "R9 — x"}\n')).toEqual([]);
  });
  it('R10 bord — id numérique : test exigé comme avant', () => {
    expect(brut('regles:\n  - {id: 1, tests: ["absent"]}\n')).toEqual(['1 : test « absent » (nom prévu dans la fiche) absent des fichiers listés']);
  });
});
