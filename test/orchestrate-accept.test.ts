import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { acceptationFile, checkAcceptation, isAcceptationFile, findAcceptation, lockViolations, lotStartHead, redSha, sealAcceptation, setVert } from '../src/orchestrate/accept.js';
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
  it('un fichier de test qui existait avant la session accept ne peut pas être listé (ses tests ordinaires sortiraient de la CI)', () => {
    const repo = gitRepo();
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'test/prochain-match.acceptation.test.ts'), '// test ordinaire\n');
    commitPaths(repo, 'test: existant', 'test/prochain-match.acceptation.test.ts');
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    const a = ecritAcceptation(repo);
    const p = checkAcceptation(repo, a.json, 'L1', a.fiche, base).join('\n');
    expect(p).toContain(a.test);
    expect(p).toMatch(/existait avant/);
    expect(checkAcceptation(repo, a.json, 'L1', a.fiche).join('\n')).not.toMatch(/existait avant/);
  });

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

  it('un fichier listé en ./test/x.ts est comparé à son empreinte rangée sous le chemin normalisé (L179)', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    const doc = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    doc.fichiers = [`./${a.test}`];
    writeFileSync(join(repo, a.json), JSON.stringify(doc, null, 2));
    sealAcceptation(repo, a.json);
    const sealed = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    sealed.empreintes[a.test] = '0'.repeat(40); // empreinte qui ne correspond pas au fichier, inchangé depuis le commit rouge
    writeFileSync(join(repo, a.json), JSON.stringify(sealed, null, 2));
    commitPaths(repo, 'chore(L179): scellé', a.json);
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(lockViolations(repo, DIR, head).join('\n')).toContain('empreinte différente');
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

  it('un fichier de test supprimé est signalé même quand il est absent à la tête de départ du lot (L184 : absent des deux côtés n\'est pas un bilan nul)', () => {
    const repo = gitRepo();
    writeFileSync(join(repo, 'README.md'), 'x\n');
    commitPaths(repo, 'chore: départ', 'README.md');
    const lotStart = git(repo, 'rev-parse', 'HEAD').trim();
    const a = ecritAcceptation(repo);
    const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'rm', '-q', a.test);
    git(repo, 'commit', '-q', '-m', 'feat(L1): supprime', '--', a.test);
    const p = lockViolations(repo, DIR, head, { lot: 'L1', lotStart }).join('\n');
    expect(p).toContain(a.test);
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

  describe('acceptation à vert: true (lot livré) : la fiche fait évoluer les règles (L183)', () => {
    function livre() {
      const repo = gitRepo();
      const a = ecritAcceptation(repo);
      setVert(repo, a.json);
      commitPaths(repo, 'chore(L1): vert', a.json);
      return { repo, a, head: git(repo, 'rev-parse', 'HEAD') };
    }
    const changeFiche = (repo: string, fiche: string) => writeFileSync(join(repo, fiche), `${readFileSync(join(repo, fiche), 'utf8')}# R7 révisée\n`);

    it('tests modifiés SANS changement de la fiche : écart comme avant', () => {
      const { repo, a, head } = livre();
      writeFileSync(join(repo, a.test), "it('R1', () => {});\n");
      commitPaths(repo, 'feat(L9): change R7', a.test);
      expect(lockViolations(repo, DIR, head).join('\n')).toContain(a.test);
    });

    it('tests ET fiche modifiés dans les commits du même lot : admis', () => {
      const { repo, a, head } = livre();
      writeFileSync(join(repo, a.test), "it('R7 nouvelle', () => {});\n");
      changeFiche(repo, a.fiche);
      commitPaths(repo, 'feat(L9): R7 révisée', a.test, a.fiche);
      expect(lockViolations(repo, DIR, head)).toEqual([]);
    });

    it('la fiche changée dans un commit antérieur du lot (lotBase) admet les tests modifiés par une session suivante', () => {
      const { repo, a, head } = livre();
      changeFiche(repo, a.fiche);
      commitPaths(repo, 'feat(L9): fiche', a.fiche);
      const session = git(repo, 'rev-parse', 'HEAD');
      writeFileSync(join(repo, a.test), "it('R7 nouvelle', () => {});\n");
      commitPaths(repo, 'feat(L9): tests', a.test);
      expect(lockViolations(repo, DIR, session).join('\n')).toContain(a.test);
      expect(lockViolations(repo, DIR, session, { lotBase: head })).toEqual([]);
    });

    it("le lot SUIVANT une évolution admise ne voit aucun écart : les tests sont comparés à la tête d'avant le lot, plus au commit rouge", () => {
      const { repo, a, head } = livre();
      writeFileSync(join(repo, a.test), "it('R7 nouvelle', () => {});\n");
      changeFiche(repo, a.fiche);
      commitPaths(repo, 'feat(L9): R7 révisée', a.test, a.fiche);
      expect(lockViolations(repo, DIR, head)).toEqual([]);
      writeFileSync(join(repo, 'autre.txt'), 'x\n');
      commitPaths(repo, 'feat(L10): sans lien', 'autre.txt');
      const avant = git(repo, 'rev-parse', 'HEAD');
      writeFileSync(join(repo, 'autre.txt'), 'y\n');
      commitPaths(repo, 'feat(L10): suite', 'autre.txt');
      expect(lockViolations(repo, DIR, avant)).toEqual([]);
      expect(lockViolations(repo, DIR, avant, { lotBase: avant })).toEqual([]);
    });

    it("après une évolution admise, un lot suivant qui retouche les tests sans la fiche reste un écart", () => {
      const { repo, a, head } = livre();
      writeFileSync(join(repo, a.test), "it('R7 nouvelle', () => {});\n");
      changeFiche(repo, a.fiche);
      commitPaths(repo, 'feat(L9): R7 révisée', a.test, a.fiche);
      const avant = git(repo, 'rev-parse', 'HEAD');
      expect(head).not.toBe(avant);
      writeFileSync(join(repo, a.test), "it('R1', () => {});\n");
      commitPaths(repo, 'feat(L10): triche', a.test);
      expect(lockViolations(repo, DIR, avant).join('\n')).toContain(a.test);
    });

    it('la fiche changée dans un commit du lot qui précède sa tête de départ (lots) admet les tests modifiés', () => {
      const { repo, a, head } = livre();
      changeFiche(repo, a.fiche);
      commitPaths(repo, 'docs(L9): fiche R7', a.fiche);
      const fiche = git(repo, 'rev-parse', 'HEAD');
      writeFileSync(join(repo, a.test), "it('R7 nouvelle', () => {});\n");
      commitPaths(repo, 'feat(L9): tests', a.test);
      expect(lockViolations(repo, DIR, fiche).join('\n')).toContain(a.test);
      expect(lockViolations(repo, DIR, fiche, { lotCommits: [fiche] })).toEqual([]);
      expect(lockViolations(repo, DIR, fiche, { lotCommits: [head] }).join('\n')).toContain(a.test);
    });

    it("bilan nul sur le lot (L184) : le fichier verrouillé revenu à son état d'avant le premier commit de travail du lot n'est pas un écart ; un fichier encore différent l'est", () => {
      const { repo, a, head } = livre();
      // vague 1 : le lot écrit dans le fichier verrouillé, sans changer la fiche
      writeFileSync(join(repo, a.test), "it('R7 nouvelle', () => {});\n");
      commitPaths(repo, 'feat(L9): ajout', a.test);
      const premier = git(repo, 'rev-parse', 'HEAD');
      expect(lotStartHead(repo, [premier])).toBe(head);
      expect(lockViolations(repo, DIR, premier, { lotBase: premier, lot: 'L10', lotStart: head }).join('\n')).toContain(a.test);
      // vague 2 (reprise) : le lot retire son ajout
      git(repo, 'checkout', '-q', head, '--', a.test);
      commitPaths(repo, 'fix(L9): retire son ajout', a.test);
      const vague2 = git(repo, 'rev-parse', 'HEAD');
      expect(lockViolations(repo, DIR, vague2, { lotBase: premier, lot: 'L10', lotStart: head })).toEqual([]);
      // un fichier encore différent de l'état d'avant le lot reste un écart
      writeFileSync(join(repo, a.test), "it('autre', () => {});\n");
      commitPaths(repo, 'fix(L9): autre', a.test);
      expect(lockViolations(repo, DIR, vague2, { lotBase: premier, lot: 'L10', lotStart: head }).join('\n')).toContain(a.test);
    });

    it("bilan nul sur le lot (L184) après une évolution admise : l'exemption seule retire l'écart (la référence est lotBase, pas le commit rouge)", () => {
      const { repo, a } = livre();
      writeFileSync(join(repo, a.test), "it('R7 nouvelle', () => {});\n");
      changeFiche(repo, a.fiche);
      commitPaths(repo, 'feat(L8): R7 révisée', a.test, a.fiche);
      const debut = git(repo, 'rev-parse', 'HEAD');
      writeFileSync(join(repo, a.test), "it('R7 nouvelle', () => {});\nit('ajout', () => {});\n");
      commitPaths(repo, 'feat(L9): ajout', a.test);
      const premier = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'checkout', '-q', debut, '--', a.test);
      commitPaths(repo, 'fix(L9): retire son ajout', a.test);
      const vague2 = git(repo, 'rev-parse', 'HEAD');
      expect(lockViolations(repo, DIR, vague2, { lotBase: premier, lot: 'L10', lotStart: debut })).toEqual([]);
      expect(lockViolations(repo, DIR, vague2, { lotBase: premier, lot: 'L10' }).join('\n')).toContain(a.test);
    });

    it("bilan nul sur le lot (L184) : la fiche changée depuis la tête de départ du lot (évolution admise d'un autre lot) ôte l'exemption — revenir à l'ancien contenu annule cette évolution", () => {
      const { repo, a, head } = livre();
      writeFileSync(join(repo, 'x.txt'), '1\n');
      commitPaths(repo, 'feat(L2): travail', 'x.txt');
      writeFileSync(join(repo, a.test), "it('R7 nouvelle', () => {});\n");
      changeFiche(repo, a.fiche);
      commitPaths(repo, 'feat(L9): R7 révisée', a.test, a.fiche);
      const base = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'checkout', '-q', head, '--', a.test);
      commitPaths(repo, 'fix(L2): remet le test', a.test);
      const fin = git(repo, 'rev-parse', 'HEAD');
      expect(lockViolations(repo, DIR, fin, { lotBase: base, lot: 'L2', lotStart: head }).join('\n')).toContain(a.test);
    });

    it("lotStartHead (L184) : le parent du plus ancien commit de travail, quel que soit l'ordre ; undefined sans commit ou pour un commit racine", () => {
      const { repo, head } = livre();
      writeFileSync(join(repo, 'x.txt'), '1\n');
      commitPaths(repo, 'feat(L9): a', 'x.txt');
      const a1 = git(repo, 'rev-parse', 'HEAD');
      writeFileSync(join(repo, 'x.txt'), '2\n');
      commitPaths(repo, 'feat(L9): b', 'x.txt');
      const a2 = git(repo, 'rev-parse', 'HEAD');
      expect(lotStartHead(repo, [a2, a1])).toBe(head);
      expect(lotStartHead(repo, [a1, a2])).toBe(head);
      expect(lotStartHead(repo, [])).toBeUndefined();
      expect(lotStartHead(repo, [git(repo, 'rev-list', '--max-parents=0', 'HEAD').trim().split('\n')[0]])).toBeUndefined();
    });

    it('la fiche changée mais non commitée (arbre de travail) compte aussi', () => {
      const { repo, a, head } = livre();
      writeFileSync(join(repo, a.test), "it('R7 nouvelle', () => {});\n");
      changeFiche(repo, a.fiche);
      expect(lockViolations(repo, DIR, head)).toEqual([]);
    });

    it("l'acceptation du lot en cours (opts.lot) garde le verrou entier, même fiche changée dans le lot", () => {
      const { repo, a, head } = livre();
      changeFiche(repo, a.fiche);
      writeFileSync(join(repo, a.test), "it('triche', () => {});\n");
      commitPaths(repo, 'fix(L1): triche', a.test, a.fiche);
      expect(lockViolations(repo, DIR, head, { lotBase: head, lot: 'L1' }).join('\n')).toContain(a.test);
      expect(lockViolations(repo, DIR, head, { lotBase: head, lot: 'L9' })).toEqual([]);
    });

    it("un test réécrit hors vague, fiche inchangée, reste un écart contre le commit rouge même avec lotBase", () => {
      const { repo, a } = livre();
      writeFileSync(join(repo, a.test), "it('R1', () => {});\n");
      commitPaths(repo, 'chore: hors vague', a.test);
      const avant = git(repo, 'rev-parse', 'HEAD');
      expect(lockViolations(repo, DIR, avant, { lotBase: avant }).join('\n')).toContain(a.test);
    });

    it('vert: false : verrou entier, même si la fiche change', () => {
      const repo = gitRepo();
      const a = ecritAcceptation(repo);
      const head = git(repo, 'rev-parse', 'HEAD');
      writeFileSync(join(repo, a.test), "it('R7 nouvelle', () => {});\n");
      changeFiche(repo, a.fiche);
      commitPaths(repo, 'feat(L9): R7', a.test, a.fiche);
      expect(lockViolations(repo, DIR, head).join('\n')).toContain(a.test);
    });

    it('acceptation.json lui-même reste verrouillé (liste réduite) même fiche changée', () => {
      const { repo, a, head } = livre();
      changeFiche(repo, a.fiche);
      const doc = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
      doc.fichiers = [];
      writeFileSync(join(repo, a.json), JSON.stringify(doc));
      commitPaths(repo, 'feat(L9): vide', a.json, a.fiche);
      expect(lockViolations(repo, DIR, head).join('\n')).toContain(a.json);
    });
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
    const a2 = ecritAcceptation(repo2);
    expect(lockViolations(repo2, DIR, head2).join('\n')).toContain('créé');
    expect(lockViolations(repo2, DIR, head2, { skip: a2.json })).toEqual([]);
  });

  it('pendant accept, seul le fichier du lot (skip) peut être créé : l’acceptation d’un autre lot créée au passage est signalée', () => {
    const repo = gitRepo();
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'chore: vide');
    const head = git(repo, 'rev-parse', 'HEAD');
    const own = ecritAcceptation(repo);
    const other = ecritAcceptation(repo, { lot: 'ZZ', ecran: 'autre' });
    const v = lockViolations(repo, DIR, head, { skip: own.json }).join('\n');
    expect(v).toContain(other.json);
    expect(v).toContain('créé');
  });

  it('une réécriture commitée par une session interrompue (tête d’avant la reprise déjà modifiée) est vue par l’ancre du commit rouge', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    sealAcceptation(repo, a.json);
    commitPaths(repo, 'test(L1): scellé', a.json);
    const rouge = redSha(repo, a.json) as string;
    const doc = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    doc.fichiers = ['test/ordinary.test.ts'];
    writeFileSync(join(repo, a.json), JSON.stringify(doc));
    commitPaths(repo, 'feat(L1): réécrit puis coupé', a.json);
    const headReprise = git(repo, 'rev-parse', 'HEAD'); // la reprise part d'ici : la réécriture est déjà dans headBefore
    expect(lockViolations(repo, DIR, headReprise)).toEqual([]); // sans ancre, rien ne bouge par rapport à headBefore
    expect(lockViolations(repo, DIR, headReprise, { rouge: { [a.json]: rouge } }).join('\n')).toContain('commit rouge');
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
