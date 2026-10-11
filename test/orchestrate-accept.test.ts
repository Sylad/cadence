import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { acceptationFile, checkAcceptation, isAcceptationFile, findAcceptation, lockViolations, redSha, sealAcceptation, setVert } from '../src/orchestrate/accept.js';
import { gitRepo } from './helpers.js';
import { git } from './orchestrate-harness.js';
import { DIR, ecritAcceptation } from './accept-helpers.js';

// L173 (spec etape-spec, S5) : ce que le programme sait de l'étape accept — le fichier acceptation.json et le verrou des tests rouges.

const commitPaths = (repo: string, message: string, ...paths: string[]) => {
  git(repo, 'add', '--', ...paths);
  git(repo, 'commit', '-q', '-m', message, '--', ...paths);
};

describe('acceptation-<lot>.json : un fichier par lot', () => {
  it('le chemin suit le lot (id réduit aux caractères sûrs) et reste reconnu comme fichier d’acceptation', () => {
    expect(acceptationFile('docs/specs/x/fiche.yaml', 'L173')).toBe('docs/specs/x/acceptation-L173.json');
    expect(acceptationFile('docs/specs/x/fiche.yaml', 'app/L7')).toBe('docs/specs/x/acceptation-app-L7.json');
    expect(isAcceptationFile('docs/specs/x/acceptation-app-L7.json')).toBe(true);
    expect(isAcceptationFile('docs/specs/x/acceptation.json')).toBe(true);
    expect(isAcceptationFile('docs/specs/x/acceptation-notes.txt')).toBe(false);
    expect(isAcceptationFile('docs/specs/x/fiche.yaml')).toBe(false);
  });
});

describe('acceptation.json : lecture et contrôles de l’étape', () => {
  it('un fichier conforme ne relève aucun écart', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    expect(checkAcceptation(repo, a.json, 'L1', a.fiche)).toEqual([]);
  });

  it('un test cité par la fiche et absent des fichiers listés est un écart', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo, { tests: "it('R1 — le score est absent avant le coup d\\'envoi', () => { throw new Error('x'); });" });
    const p = checkAcceptation(repo, a.json, 'L1', a.fiche);
    expect(p.join('\n')).toContain('R2 — état vide : le message s\'affiche, pas d\'équipe');
  });

  it('vert: true à l’écriture, lot différent, fichier listé non commité : autant d’écarts', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo, { vert: true, lot: 'L9' });
    const p = checkAcceptation(repo, a.json, 'L1', a.fiche).join('\n');
    expect(p).toContain('vert');
    expect(p).toContain('L9');
    const repo2 = gitRepo();
    const c = ecritAcceptation(repo2);
    const doc = JSON.parse(readFileSync(join(repo2, c.json), 'utf8'));
    doc.fichiers.push('test/absent.test.ts');
    writeFileSync(join(repo2, c.json), JSON.stringify(doc));
    expect(checkAcceptation(repo2, c.json, 'L1', c.fiche).join('\n')).toContain('test/absent.test.ts');
  });

  it('acceptation.json absent : écart nommé', () => {
    const repo = gitRepo();
    expect(checkAcceptation(repo, 'docs/specs/x/acceptation.json', 'L1', 'docs/specs/x/fiche.yaml')[0]).toMatch(/absent/);
  });

  it('findAcceptation retrouve celui du lot, redSha le commit qui l’a ajouté', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    expect(findAcceptation(repo, DIR, 'L1')).toBe(a.json);
    expect(findAcceptation(repo, DIR, 'L2')).toBeNull();
    expect(redSha(repo, a.json)).toBe(a.sha);
  });
});

describe('verrou des tests d’acceptation (toutes les sessions du dépôt)', () => {
  it('aucun écart quand rien n’a bougé', () => {
    const repo = gitRepo();
    ecritAcceptation(repo);
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(lockViolations(repo, DIR, head)).toEqual([]);
  });

  it('un fichier de test modifié depuis le commit rouge est signalé, même d’un autre lot', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo, { lot: 'L1' });
    const head = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, a.test), "it('R1', () => {});\n");
    commitPaths(repo, 'feat(L2): triche', a.test);
    const v = lockViolations(repo, DIR, head).join('\n');
    expect(v).toContain(a.test);
    expect(v).toContain('L1');
  });

  it('une modification restée dans l’arbre (non commitée) est signalée aussi', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    const head = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, a.test), 'autre\n');
    expect(lockViolations(repo, DIR, head).join('\n')).toContain(a.test);
  });

  it('un fichier de test supprimé est signalé', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'rm', '-q', a.test);
    git(repo, 'commit', '-q', '-m', 'feat(L1): supprime', '--', a.test);
    expect(lockViolations(repo, DIR, head).join('\n')).toContain(a.test);
  });

  it('seule la clé vert, posée par le cycle, est tolérée : setVert ne déclenche aucun écart au contrôle suivant', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    setVert(repo, a.json);
    commitPaths(repo, 'chore(L1): vert', a.json);
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(JSON.parse(readFileSync(join(repo, a.json), 'utf8')).vert).toBe(true);
    // le lot suivant (B) voit un diff non vide par rapport au sha rouge mais aucun écart
    expect(lockViolations(repo, DIR, head)).toEqual([]);
  });

  it('une session qui pose vert: true elle-même est signalée', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    const head = git(repo, 'rev-parse', 'HEAD');
    const doc = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    doc.vert = true;
    writeFileSync(join(repo, a.json), JSON.stringify(doc));
    commitPaths(repo, 'feat(L1): vert', a.json);
    expect(lockViolations(repo, DIR, head).join('\n')).toMatch(/vert/);
  });

  it('une autre clé d’acceptation.json réécrite (liste de fichiers réduite) est signalée', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    const head = git(repo, 'rev-parse', 'HEAD');
    const doc = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    doc.fichiers = [];
    writeFileSync(join(repo, a.json), JSON.stringify(doc));
    commitPaths(repo, 'feat(L1): vide la liste', a.json);
    expect(lockViolations(repo, DIR, head).join('\n')).toContain(a.json);
  });

  it('un acceptation.json supprimé ou créé par une session d’implémentation est signalé', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'rm', '-q', a.json);
    git(repo, 'commit', '-q', '-m', 'feat(L1): supprime', '--', a.json);
    expect(lockViolations(repo, DIR, head).join('\n')).toContain('supprimé');
    const repo2 = gitRepo();
    git(repo2, 'commit', '-q', '--allow-empty', '-m', 'chore: vide');
    const head2 = git(repo2, 'rev-parse', 'HEAD');
    ecritAcceptation(repo2);
    expect(lockViolations(repo2, DIR, head2).join('\n')).toContain('créé');
    expect(lockViolations(repo2, DIR, head2, { created: 'allow' })).toEqual([]);
  });
});

describe('scellé par le programme : empreintes et commit rouge', () => {
  const sceller = (repo: string, json: string) => {
    sealAcceptation(repo, json);
    commitPaths(repo, 'test(L1): acceptation scellée', json);
    return git(repo, 'rev-parse', 'HEAD');
  };

  it('le scellé ajoute l’empreinte de chaque fichier listé ; le commit rouge est alors le commit du scellé', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    const seal = sceller(repo, a.json);
    const doc = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    expect(doc.empreintes[a.test]).toBe(git(repo, 'hash-object', a.test));
    expect(redSha(repo, a.json)).toBe(seal);
    expect(redSha(repo, a.json)).not.toBe(a.sha);
  });

  it('une passe de correction des tests avant le scellé ne laisse aucun écart : le commit rouge est celui du scellé', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}\n// passe 2\n`);
    commitPaths(repo, 'test(L1): passe 2', a.test);
    const head = sceller(repo, a.json);
    expect(lockViolations(repo, DIR, head)).toEqual([]);
  });

  it('un test modifié après le scellé est signalé ; la clé vert posée ensuite reste tolérée', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    sceller(repo, a.json);
    setVert(repo, a.json);
    commitPaths(repo, 'chore(L1): vert', a.json);
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(lockViolations(repo, DIR, head)).toEqual([]);
    writeFileSync(join(repo, a.test), 'modifié\n');
    commitPaths(repo, 'feat(L2): touche', a.test);
    const v = lockViolations(repo, DIR, head).join('\n');
    expect(v).toContain(a.test);
    expect(v).toMatch(/empreinte/);
  });

  it('skip : l’acceptation.json du lot en cours d’écriture n’est pas contrôlée', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    const head = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, a.test), 'autre\n');
    expect(lockViolations(repo, DIR, head, { skip: a.json })).toEqual([]);
  });
});
