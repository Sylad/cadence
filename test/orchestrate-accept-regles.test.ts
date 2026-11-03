import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { checkAcceptation, parseAcceptation, redSha, sealAcceptation } from '../src/orchestrate/accept.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { gitRepo } from './helpers.js';
import { acceptReport, claudeOut, commitFile, git, harness, reviewReport, workReport } from './orchestrate-harness.js';
import { ecritAcceptation } from './accept-helpers.js';
import { ecrit, EXEMPLE } from './spec-helpers.js';

// L552 (fiche accept-regles-du-lot, issue #25) : sur une fiche partagée par plusieurs lots, checkAcceptation n'exige que les tests des règles du lot.

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
const ecritFiche = (repo: string, enonces: Record<string, string> = {}, ids = IDS, texte?: (y: string) => string) => {
  mkdirSync(join(repo, DIR), { recursive: true });
  const y = stringify({ regles: ids.map((id) => regle(id, enonces[id])) });
  writeFileSync(join(repo, FICHE), texte ? texte(y) : y);
};
const ecritTests = (repo: string, file: string, ids: string[]) => {
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, file), ids.map((id) => `it('${id} — cas', () => {});`).join('\n'));
};
/** Écrit acceptation-<lot>.json (scellée avec `scelle`) pour les fichiers donnés. */
const ecritAcc = (repo: string, lot: string, fichiers: string[], o: { scelle?: boolean; regles?: unknown; fiche?: string; nom?: string } = {}) => {
  const json = `${DIR}/${o.nom ?? `acceptation-${lot}.json`}`;
  writeFileSync(join(repo, json), JSON.stringify({ lot, fiche: o.fiche ?? FICHE, fichiers, vert: false, ...('regles' in o ? { regles: o.regles } : {}) }, null, 2));
  if (o.scelle) sealAcceptation(repo, json);
  return json;
};

/** L9 a écrit la fiche (5 règles) et son acceptation (non scellée, tous les noms) ; rien du lot L1 encore. */
function monde(o: { scelleL9?: boolean; testsL9?: string[] } = {}): string {
  const repo = gitRepo();
  ecritFiche(repo);
  ecritTests(repo, 'test/l9.test.ts', o.testsL9 ?? IDS);
  const j9 = ecritAcc(repo, 'L9', ['test/l9.test.ts'], { scelle: o.scelleL9 });
  commit(repo, 'spec(L9): fiche', FICHE);
  commit(repo, 'test(L9): acceptation (rouge)', 'test/l9.test.ts', j9);
  return repo;
}
/** Le lot L1 amende des règles dans un commit de ce sujet. */
const amende = (repo: string, sujet: string, enonces: Record<string, string>, ids = IDS) => {
  const prev = parse(readFileSync(join(repo, FICHE), 'utf8')) as { regles: { id: string; enonce: string }[] };
  const cur: Record<string, string> = Object.fromEntries(prev.regles.map((r) => [r.id, r.enonce]));
  ecritFiche(repo, { ...cur, ...enonces }, ids);
  commit(repo, sujet, FICHE);
};
/** Les tests de L1 (ids donnés) et son acceptation, commités en test(L1). */
const testsL1 = (repo: string, ids: string[], o: { regles?: unknown } = {}) => {
  ecritTests(repo, 'test/l1.test.ts', ids);
  const json = ecritAcc(repo, 'L1', ['test/l1.test.ts'], 'regles' in o ? { regles: o.regles } : {});
  commit(repo, 'test(L1): acceptation (rouge)', 'test/l1.test.ts', json);
  return json;
};
const verifie = (repo: string, json: string, c: typeof ctx | null = ctx) => checkAcceptation(repo, json, 'L1', FICHE, undefined, c ?? undefined);
const manquants = (p: string[]) => p.filter((m) => m.includes('(nom prévu dans la fiche)')).map((m) => m.split(' ')[0]);


describe('L552 R1/R2 — fiche partagée : seuls les tests des règles du lot', () => {
  it('R1 — fiche partagée, lot qui amende 2 règles sur 5 : seuls leurs tests sont exigés', () => {
    const repo = monde();
    amende(repo, 'spec(L1): règles 2 et 3 amendées', { R2: 'nouveau', R3: 'nouveau' });
    expect(verifie(repo, testsL1(repo, ['R2', 'R3']))).toEqual([]);
    rmSync(join(repo, 'test/l1.test.ts'));
    const json = testsL1(repo, ['R3']);
    expect(manquants(verifie(repo, json))).toEqual(['R2']);
  });

  it('R2 — un commit spec(<lot>) compte', () => {
    const repo = monde();
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    expect(manquants(verifie(repo, testsL1(repo, ['R1'])))).toEqual(['R2']);
  });

  it('R2 — un commit docs(<lot>) compte', () => {
    const repo = monde();
    amende(repo, 'docs(L1): réponse du lead sur R4', { R4: 'tranché' });
    expect(manquants(verifie(repo, testsL1(repo, ['R1'])))).toEqual(['R4']);
  });

  it('R2 — un commit test(<lot>) qui touche la fiche ne compte pas', () => {
    const repo = monde();
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    amende(repo, 'test(L1): fiche touchée au passage', { R3: 'nouveau' });
    expect(verifie(repo, testsL1(repo, ['R2']))).toEqual([]);
  });

  it('R2 — un commit d\'un autre lot ne compte pas (la portée est lue comme citedRefs)', () => {
    const repo = monde();
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    amende(repo, 'docs(L7): autre lot', { R3: 'nouveau' });
    expect(verifie(repo, testsL1(repo, ['R2']))).toEqual([]);
  });
});

describe('L552 R3/R5/R6 — ce qu\'est une règle du lot et le repli sûr', () => {
  it('R3 — règle ajoutée : exigée', () => {
    const repo = monde();
    ecritFiche(repo, {}, [...IDS, 'R6']);
    commit(repo, 'spec(L1): R6 ajoutée', FICHE);
    expect(manquants(verifie(repo, testsL1(repo, ['R1'])))).toEqual(['R6']);
  });

  it('R3 — règle modifiée dans un commit docs(<lot>) : exigée', () => {
    const repo = monde();
    amende(repo, 'docs(L1): R5 précisée', { R5: 'précisé' });
    expect(manquants(verifie(repo, testsL1(repo, ['R1'])))).toEqual(['R5']);
  });

  it('R3 — règle inchangée ou reformatée seulement : non exigée', () => {
    const repo = monde();
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    ecritFiche(repo, { R2: 'nouveau' }, IDS, (y) => `# commentaire\n${y.replace(/^/gm, '').replace(/enonce: /g, 'enonce:   ')}`);
    commit(repo, 'spec(L1): mise en forme', FICHE);
    expect(verifie(repo, testsL1(repo, ['R2']))).toEqual([]);
  });

  it('R3 — règles du lot réparties sur deux commits : union exigée', () => {
    const repo = monde();
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    amende(repo, 'docs(L1): R3', { R3: 'nouveau' });
    expect(manquants(verifie(repo, testsL1(repo, ['R1'])))).toEqual(['R2', 'R3']);
  });

  it('R5 — aucun commit du lot sur la fiche partagée : toutes les règles exigées', () => {
    const repo = monde();
    expect(manquants(verifie(repo, testsL1(repo, ['R2'])))).toEqual(['R1', 'R3', 'R4', 'R5']);
  });

  it('R5 — historique de la fiche illisible : toutes les règles exigées', () => {
    const repo = monde();
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    const json = testsL1(repo, ['R2']);
    const premier = git(repo, 'rev-list', '--max-parents=0', 'HEAD').trim();
    rmSync(join(repo, '.git/objects', premier.slice(0, 2), premier.slice(2)));
    expect(manquants(verifie(repo, json))).toEqual(['R1', 'R3', 'R4', 'R5']);
  });

  it('R6 — commits du lot sur la fiche sans règle touchée : toutes les règles exigées', () => {
    const repo = monde();
    ecritFiche(repo, {}, IDS, (y) => `# relu\n${y}`);
    commit(repo, 'spec(L1): commentaire', FICHE);
    expect(manquants(verifie(repo, testsL1(repo, ['R2'])))).toEqual(['R1', 'R3', 'R4', 'R5']);
  });
});

describe('L552 R4 — la clé « regles »', () => {
  const attendu = 'docs/specs/x/acceptation-L1.json : clé « regles » : liste non vide d\'ids de règles de la fiche attendue';
  const ecart = (valeur: unknown) => {
    const repo = monde();
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    return verifie(repo, testsL1(repo, ['R2'], { regles: valeur }));
  };
  it('R4 — regles non tableau : écart nommé', () => {
    expect(ecart('R2')).toEqual([attendu]);
  });
  it('R4 — regles vide : écart nommé', () => {
    expect(ecart([])).toEqual([attendu]);
  });
  it('R4 — id inconnu : écart nommé', () => {
    expect(ecart(['R2', 'R9'])).toEqual(['docs/specs/x/acceptation-L1.json : clé « regles » : règle « R9 » absente de la fiche']);
  });
  it('R4 — id non chaîne ou vide : écart nommé', () => {
    expect(ecart([2])).toEqual([attendu]);
    expect(ecart([''])).toEqual([attendu]);
  });
  it('R4 — une liste valide prime sur les commits, sur fiche partagée', () => {
    const repo = monde();
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    expect(manquants(verifie(repo, testsL1(repo, ['R2'], { regles: ['R2', 'R4'] })))).toEqual(['R4']);
  });
});

describe('L552 R7/R8/R12 — les autres acceptations de la fiche', () => {
  it('R7 — nom présent dans l\'acceptation scellée d\'un autre lot : accepté', () => {
    const repo = monde({ scelleL9: true });
    expect(verifie(repo, testsL1(repo, ['R2']))).toEqual([]); // repli : toutes exigées, R1 R3 R4 R5 viennent de L9
  });
  it('R7 — nom présent dans une acceptation non scellée : toujours signalé', () => {
    const repo = monde();
    expect(manquants(verifie(repo, testsL1(repo, ['R2'])))).toEqual(['R1', 'R3', 'R4', 'R5']);
  });
  it('R7 — nom absent de partout : toujours signalé', () => {
    const repo = monde({ scelleL9: true, testsL9: ['R1', 'R3', 'R4'] });
    expect(manquants(verifie(repo, testsL1(repo, ['R2'])))).toEqual(['R5']);
  });
  it('R8 — autre acceptation non scellée sur la même fiche : la fiche est partagée', () => {
    const repo = monde();
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    expect(verifie(repo, testsL1(repo, ['R2']))).toEqual([]);
  });
  it('R8 — autre acceptation sur une autre fiche : fiche non partagée', () => {
    const repo = monde();
    const autre = join(repo, DIR, 'acceptation-L9.json');
    writeFileSync(autre, JSON.stringify({ lot: 'L9', fiche: `${DIR}/autre.yaml`, fichiers: ['test/l9.test.ts'], vert: false }));
    commit(repo, 'test(L9): autre fiche', `${DIR}/acceptation-L9.json`);
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    expect(manquants(verifie(repo, testsL1(repo, ['R2'])))).toEqual(['R1', 'R3', 'R4', 'R5']);
  });
  it('R8 — la propre acceptation du lot ne partage pas la fiche', () => {
    const repo = gitRepo();
    ecritFiche(repo);
    commit(repo, 'spec(L1): fiche', FICHE);
    ecritTests(repo, 'test/l1.test.ts', ['R2']);
    const json = ecritAcc(repo, 'L1', ['test/l1.test.ts']);
    const ancien = ecritAcc(repo, 'L1', ['test/l1.test.ts'], { nom: 'acceptation.json' });
    commit(repo, 'test(L1): rouge', 'test/l1.test.ts', json, ancien);
    expect(manquants(verifie(repo, json))).toEqual(['R1', 'R3', 'R4', 'R5']);
  });
  it('R12 — acceptation voisine illisible : aucun écart pour le lot courant', () => {
    const repo = monde();
    writeFileSync(join(repo, DIR, 'acceptation-L8.json'), '{ pas du json');
    const sansFichier = ecritAcc(repo, 'L7', ['test/disparu.test.ts'], { scelle: false });
    const scellee = JSON.parse(readFileSync(join(repo, sansFichier), 'utf8'));
    writeFileSync(join(repo, sansFichier), JSON.stringify({ ...scellee, empreintes: { 'test/disparu.test.ts': 'abc' } }));
    commit(repo, 'test(L8): voisines', `${DIR}/acceptation-L8.json`, sansFichier);
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    expect(verifie(repo, testsL1(repo, ['R2']))).toEqual([]);
    expect(manquants(verifie(repo, testsL1(repo, ['R1'])))).toEqual(['R2']);
  });
});

describe('L552 R9/R10/R11 — verrou, fiche seule, appelants', () => {
  it('R9 — le scellé conserve la clé regles', () => {
    const repo = monde();
    const json = testsL1(repo, ['R2'], { regles: ['R2'] });
    sealAcceptation(repo, json);
    expect(JSON.parse(readFileSync(join(repo, json), 'utf8')).regles).toEqual(['R2']);
    expect((parseAcceptation(readFileSync(join(repo, json), 'utf8')) as { regles?: unknown }).regles).toEqual(['R2']);
  });
  it('R9 — la clé regles modifiée après le commit rouge change le commit rouge', () => {
    const repo = monde();
    const json = testsL1(repo, ['R2'], { regles: ['R2'] });
    const rouge = redSha(repo, json);
    const doc = JSON.parse(readFileSync(join(repo, json), 'utf8'));
    writeFileSync(join(repo, json), JSON.stringify({ ...doc, regles: ['R3'] }, null, 2));
    commit(repo, 'test(L1): regles changé', json);
    expect(redSha(repo, json)).not.toBe(rouge);
  });
  it('R10 — fiche à un seul lot, sans regles : toutes les règles exigées comme avant', () => {
    const repo = gitRepo();
    ecritFiche(repo);
    commit(repo, 'spec(L1): fiche', FICHE);
    const json = testsL1(repo, ['R2']);
    expect(verifie(repo, json)).toEqual(checkAcceptation(repo, json, 'L1', FICHE));
    expect(manquants(verifie(repo, json))).toEqual(['R1', 'R3', 'R4', 'R5']);
  });
  it('R10 — fiche à un seul lot, regles déclarée : la liste est appliquée', () => {
    const repo = gitRepo();
    ecritFiche(repo);
    commit(repo, 'spec(L1): fiche', FICHE);
    expect(manquants(verifie(repo, testsL1(repo, ['R2'], { regles: ['R2', 'R3'] })))).toEqual(['R3']);
  });
  it('R11 — sans la sixième entrée, la fiche est tenue pour non partagée', () => {
    const repo = monde();
    amende(repo, 'spec(L1): R2', { R2: 'nouveau' });
    expect(manquants(verifie(repo, testsL1(repo, ['R2']), null))).toEqual(['R1', 'R3', 'R4', 'R5']);
  });
});

describe('L552 R11 — les deux appelants de cycle.ts passent le même contexte', () => {
  it('R11 — acceptProblems et acceptationProof donnent le même verdict sur une fiche partagée', async () => {
    const h = harness({ lots: [{ title: 'Un écran', screen: 'page' }], script: { accept: [(call) => { ecritAcceptation(call.opts.cwd, { sansFiche: true, tests: nomsDe('R2').map((n) => `it('${n}', () => { throw new Error('rouge'); });`).join('\n') }); return claudeOut(acceptReport()); }], implement: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'done.flag', 'feat(L1): a')] }))], review: [() => claudeOut(reviewReport())] } });
    const fiche = ecrit(h.repo);
    ecritAcceptation(h.repo, { lot: 'L9', sansFiche: true, extra: [] }); // un autre lot sur la même fiche, non scellé
    const doc = parse(readFileSync(join(h.repo, fiche), 'utf8')) as any;
    doc.regles.find((r: any) => r.id === 'R2').enonce += ' (amendée)';
    writeFileSync(join(h.repo, fiche), stringify(doc));
    git(h.repo, 'add', '--', fiche);
    git(h.repo, 'commit', '-q', '-m', 'spec(L1): R2 amendée', '--', fiche);
    const c = h.lot('L1', { visible: true, screen: 'page' as const }, { accept: 'test -f done.flag' });
    await runLot(c);
    expect(c.lot.acceptProblems).toBeUndefined(); // acceptProblems : R1, R3, R4 ne sont pas exigés
    expect(h.calls.map((k) => k.kind)).toEqual(['accept', 'implement', 'review']);
    const preuve = checkAcceptation(h.repo, 'docs/specs/prochain-match/acceptation-L1.json', 'L1', fiche, undefined, { dir: 'docs/specs', refsOf: c.loadPlan().refs });
    expect(preuve.filter((m) => m.includes('nom prévu dans la fiche'))).toEqual([]); // le cycle a posé vert: true depuis : seul le verdict sur les tests est comparé
  });
});

function nomsDe(id: string): string[] {
  const doc = parse(readFileSync(EXEMPLE, 'utf8')) as any;
  return doc.regles.find((r: any) => r.id === id).tests;
}
