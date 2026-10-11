import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sealAcceptation, setVert } from '../src/orchestrate/accept.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { readAgents } from '../src/orchestrate/launch.js';
import { AGENTS_DIR } from '../src/skills.js';
import { DIR, ecritAcceptation } from './accept-helpers.js';
import { acceptReport, claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { ecrit } from './spec-helpers.js';

// L173 (spec etape-spec, S5) : l'étape accept d'orchestrate, entre spec et implement, et le verrou qui suit.
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const ok: Handler = () => claudeOut(reviewReport());
const screen = { visible: true, screen: 'page' as const };
const lots = [{ title: 'Un écran', screen: 'page' as const }];
const JSON_PATH = `${DIR}/prochain-match/acceptation-L1.json`;
const config = { accept: 'test -f done.flag', test: 'true' };

/** Un agent accept : tests rouges, acceptation.json, un seul commit. */
const accept = (o: Parameters<typeof ecritAcceptation>[1] = {}, over: Record<string, unknown> = {}): Handler => (call) => {
  ecritAcceptation(call.opts.cwd, { sansFiche: true, ...o });
  return claudeOut(acceptReport(over));
};
/** Une implémentation qui rend les tests verts : le drapeau que lit la commande dédiée. */
const green: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'done.flag', 'feat(L1): a')] }));
const notGreen: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));

const prepared = (script: NonNullable<Parameters<typeof harness>[0]>['script'], l: { title: string; screen?: 'page' }[] = lots) => {
  const h = harness({ lots: l, script });
  ecrit(h.repo);
  return h;
};

describe('étape accept : où elle s’insère', () => {
  it('spec → accept → implement → revue, l’acceptation du lot est retenue avec son commit rouge', async () => {
    const h = prepared({ accept: [accept()], implement: [green], review: [ok] });
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['accept', 'implement', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.accept).toMatchObject({ acceptation: JSON_PATH });
    expect(c.lot.accept?.rouge).toMatch(/^[0-9a-f]{40}$/);
  });

  it('sans orchestrate.accept l’étape n’a pas lieu : avertissement, implement directement', async () => {
    const h = prepared({ implement: [notGreen], review: [ok] });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.warnings.join('\n')).toContain('étape accept ignorée');
  });

  it('une acceptation déjà commitée et conforme (reprise) évite de rejouer accept', async () => {
    const h = prepared({ implement: [green], review: [ok] });
    const a = ecritAcceptation(h.repo, { sansFiche: true });
    sealAcceptation(h.repo, a.json);
    git(h.repo, 'add', '--', a.json);
    git(h.repo, 'commit', '-q', '-m', 'test(L1): acceptation scellée', '--', a.json);
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.accept?.acceptation).toBe(JSON_PATH);
  });

  it('une acceptation scellée qui liste un chemin ./… est reconnue à la reprise (empreinte cherchée sous le chemin normalisé) (L178)', async () => {
    const h = prepared({ implement: [green], review: [ok] });
    const a = ecritAcceptation(h.repo, { sansFiche: true });
    const doc = JSON.parse(readFileSync(join(h.repo, a.json), 'utf8'));
    doc.fichiers = [`./${a.test}`];
    writeFileSync(join(h.repo, a.json), JSON.stringify(doc, null, 2));
    sealAcceptation(h.repo, a.json);
    expect(Object.keys(JSON.parse(readFileSync(join(h.repo, a.json), 'utf8')).empreintes)).toEqual([a.test]);
    git(h.repo, 'add', '--', a.json);
    git(h.repo, 'commit', '-q', '-m', 'test(L1): acceptation scellée', '--', a.json);
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('une acceptation commitée mais jamais scellée par le programme ne prouve rien : accept est rejoué', async () => {
    const h = prepared({ accept: [accept()], implement: [green], review: [ok] });
    const a = ecritAcceptation(h.repo, { sansFiche: true }); // commitée sans empreintes (écrite à la main, ou scellé perdu)
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['accept', 'implement', 'review']);
    expect(JSON.parse(readFileSync(join(h.repo, a.json), 'utf8')).empreintes).toBeTruthy();
  });

  it('un lot déjà vert (vert: true scellé), relancé dans une nouvelle vague, passe à implement et à la revue sans rejouer accept', async () => {
    const h = prepared({ implement: [green], review: [ok] });
    const a = ecritAcceptation(h.repo, { sansFiche: true });
    sealAcceptation(h.repo, a.json);
    setVert(h.repo, a.json);
    git(h.repo, 'add', '--', a.json);
    git(h.repo, 'commit', '-q', '-m', 'chore(L1): acceptation verte', '--', a.json);
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.accept?.acceptation).toBe(a.json);
  });

  it('un second lot sur le même écran a son propre fichier : le verrou et les tests du premier restent intacts', async () => {
    const h = prepared({ accept: [accept({ lot: 'L2' })], implement: [green, green], review: [ok, ok] }, [{ title: 'Un écran', screen: 'page' }, { title: 'Le même écran', screen: 'page' }]);
    const premier = ecritAcceptation(h.repo, { sansFiche: true });
    sealAcceptation(h.repo, premier.json);
    git(h.repo, 'add', '--', premier.json);
    git(h.repo, 'commit', '-q', '-m', 'test(L1): acceptation scellée', '--', premier.json);
    const avant = readFileSync(join(h.repo, premier.json), 'utf8');
    ecrit(h.repo, { fiche: (d) => { d.ecran.lot = 'L2'; } }); // la fiche de l'écran appartient désormais à L2
    const c = h.lot('L2', screen, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['accept', 'implement', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.accept?.acceptation).toBe(`${DIR}/prochain-match/acceptation-L2.json`);
    expect(readFileSync(join(h.repo, premier.json), 'utf8')).toBe(avant);
    expect(existsSync(join(h.repo, `${DIR}/prochain-match/acceptation-L2.json`))).toBe(true);
  });

  it('un second lot dont les tests réécrivent ceux du premier est rendu, avec le fichier du premier nommé', async () => {
    let premierTest = '';
    const reecrit: Handler = (call) => {
      ecritAcceptation(call.opts.cwd, { lot: 'L2', sansFiche: true });
      writeFileSync(join(call.opts.cwd, premierTest), "it('R1', () => {});\n");
      git(call.opts.cwd, 'add', '--', premierTest);
      git(call.opts.cwd, 'commit', '-q', '--allow-empty', '-m', 'test(L2): réécrit', '--', premierTest);
      return claudeOut(acceptReport());
    };
    const h = prepared({ accept: [reecrit, reecrit] }, [{ title: 'Un écran', screen: 'page' }, { title: 'Le même écran', screen: 'page' }]);
    const premier = ecritAcceptation(h.repo, { sansFiche: true });
    sealAcceptation(h.repo, premier.json);
    git(h.repo, 'add', '--', premier.json);
    git(h.repo, 'commit', '-q', '-m', 'test(L1): acceptation scellée', '--', premier.json);
    ecrit(h.repo, { fiche: (d) => { d.ecran.lot = 'L2'; } });
    premierTest = premier.test;
    const c = h.lot('L2', screen, config);
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain(premier.test);
  });

  it('un lot sans screen: ne passe jamais par accept', async () => {
    const h = harness({ lots: [{ title: 'Autre' }], script: { implement: [notGreen], review: [ok] } });
    await runLot(h.lot('L1', {}, config));
    expect(kinds(h)).toEqual(['implement', 'review']);
  });
});

describe('étape accept : la session', () => {
  it('Sonnet, agent acceptance-writer, brief : fiche, maquette, commande dédiée, gabarit du lanceur ; ni l’objectif ni l’implémentation', async () => {
    const h = prepared({ accept: [accept()], implement: [green], review: [ok] });
    await runLot(h.lot('L1', screen, { ...config, accept: 'test -f done.flag # CMD' }));
    const call = h.calls[0];
    expect(call.model).toBe('sonnet');
    expect(call.args[call.args.indexOf('--agent') + 1]).toBe('acceptance-writer');
    for (const attendu of ['L1', 'docs/specs/prochain-match/fiche.yaml', 'docs/specs/prochain-match/maquette.html', 'test -f done.flag # CMD', 'CADENCE_ACCEPTATION', 'acceptation.json', 'vert: false', 'data-testid', 'acceptationIgnored', 'acceptationOnly', '(rouge)', 'R1']) {
      expect(call.brief, attendu).toContain(attendu);
    }
    expect(call.brief).not.toContain('Notes of the lot');
    expect(call.brief).not.toContain('Sub-tasks');
  });

  it('l’agent acceptance-writer du paquet existe, écrit des tests rouges, ne lance ni sous-agent ni push', () => {
    const a = readAgents(AGENTS_DIR)['acceptance-writer'];
    expect(a).toBeDefined();
    expect(a.tools).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Bash', 'StructuredOutput']));
    expect(a.prompt).toMatch(/rouge|red/i);
    expect(a.prompt).toMatch(/implementation/i);
  });

  it('une question de la session est rendue au lead, l’étape reprend ensuite', async () => {
    const h = prepared({ accept: [() => claudeOut(acceptReport({ questions: ['Quel lanceur de tests ?'] }))] });
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(c.lot.status).toBe('question');
    expect(c.lot.next).toBe('accept');
  });

  it('un dépôt sale après la session rend le lot', async () => {
    const h = prepared({ accept: [(call) => { writeFileSync(join(call.opts.cwd, 'docs/plan/raf.yaml'), 'x'); return claudeOut(acceptReport()); }] });
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/dépôt sale après accept/);
  });
});

describe('étape accept : ce que le programme contrôle', () => {
  it('des tests déjà verts ne prouvent rien : seconde passe avec l’écart, puis le lot est rendu', async () => {
    const h = prepared({ accept: [accept(), accept()] });
    const c = h.lot('L1', screen, { ...config, accept: 'true' });
    await runLot(c);
    expect(kinds(h)).toEqual(['accept', 'accept']);
    expect(h.calls[1].brief).toMatch(/commande dédiée .* passe/);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/accept non conforme après 2 passes/);
  });

  it('un fichier de tests déjà présent avant la première session accept est refusé par le cycle, aux deux passes', async () => {
    const h = prepared({ accept: [accept(), accept()] });
    mkdirSync(join(h.repo, 'test'), { recursive: true });
    writeFileSync(join(h.repo, 'test/prochain-match.acceptation.test.ts'), "it('ordinaire', () => {});\n");
    git(h.repo, 'add', '--', 'test/prochain-match.acceptation.test.ts');
    git(h.repo, 'commit', '-q', '-m', 'test: un test ordinaire', '--', 'test/prochain-match.acceptation.test.ts');
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['accept', 'accept']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/existait avant la session accept/);
  });

  it('config.test qui échoue avec les tests rouges commités (exclusion absente) : écart, jamais d’implémentation', async () => {
    const h = prepared({ accept: [accept(), accept()] });
    const c = h.lot('L1', screen, { ...config, test: 'false' });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/orchestrate\.test/);
    expect(kinds(h)).not.toContain('implement');
  });

  it('sans orchestrate.test rien ne prouve l’exclusion des tests rouges : avertissement du lot', async () => {
    const h = prepared({ accept: [accept()], implement: [green], review: [ok] });
    const c = h.lot('L1', screen, { accept: config.accept });
    await runLot(c);
    expect(c.lot.warnings.join('\n')).toMatch(/orchestrate\.test absent/);
  });

  it('un test cité par la fiche et absent des fichiers : écart rendu à la seconde passe, qui le corrige', async () => {
    const partiel = accept({ tests: "it('R1 — le score est absent avant le coup d\\'envoi', () => { throw new Error('x'); });" });
    const h = prepared({ accept: [partiel, accept({ ecran: 'prochain-match', tests: undefined })], implement: [green], review: [ok] });
    // la seconde passe réécrit les tests dans un nouveau commit : le premier acceptation.json n’est pas recréé, on le laisse tel quel
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(h.calls[1]?.brief).toContain('absent des fichiers listés');
  });

  it('l’acceptation.json écrit avec vert: true est un écart', async () => {
    const h = prepared({ accept: [accept({ vert: true }), accept({ vert: true })] });
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/vert/);
  });
});

describe('verrou et retour au vert pendant implement / fix', () => {
  it('quand la commande dédiée passe, le cycle pose vert: true et le commite, avec le numéro du lot', async () => {
    const h = prepared({ accept: [accept()], implement: [green], review: [ok] });
    const c = h.lot('L1', screen, { ...config, accept: 'test "$CADENCE_ACCEPTATION" = "{acceptation}" && test -f "{acceptation}" && test -f done.flag' });
    await runLot(c);
    expect(JSON.parse(readFileSync(join(h.repo, JSON_PATH), 'utf8')).vert).toBe(true);
    expect(git(h.repo, 'status', '--porcelain', '--', JSON_PATH)).toBe('');
    expect(git(h.repo, 'log', '-1', '--format=%s', '--', JSON_PATH)).toMatch(/L1.*vert/);
    expect(c.lot.status).toBe('ready');
  });

  it('commande dédiée rouge à la fin d’implement : passe fix avec le constat, puis vert', async () => {
    const h = prepared({ accept: [accept()], implement: [notGreen], fix: [green], review: [ok] });
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['accept', 'implement', 'fix', 'review']);
    expect(h.calls[2].brief).toMatch(/acceptation/i);
    expect(JSON.parse(readFileSync(join(h.repo, JSON_PATH), 'utf8')).vert).toBe(true);
  });

  it('une implémentation qui modifie un test d’acceptation rend le lot, sans revue', async () => {
    const h = prepared({
      accept: [accept()],
      implement: [(call) => {
        writeFileSync(join(call.opts.cwd, 'test/prochain-match.acceptation.test.ts'), "it('R1', () => {});\n");
        git(call.opts.cwd, 'add', '--', 'test/prochain-match.acceptation.test.ts');
        git(call.opts.cwd, 'commit', '-q', '-m', 'feat(L1): triche', '--', 'test/prochain-match.acceptation.test.ts');
        return claudeOut(workReport({ commits: [{ sha: git(call.opts.cwd, 'rev-parse', 'HEAD'), sujet: 'feat(L1): triche' }] }));
      }],
    });
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/verrou des tests d'acceptation.*prochain-match\.acceptation\.test\.ts/);
    expect(kinds(h)).toEqual(['accept', 'implement']);
  });

  it('une implémentation qui pose vert: true elle-même rend le lot', async () => {
    const h = prepared({
      accept: [accept()],
      implement: [(call) => {
        const f = join(call.opts.cwd, JSON_PATH);
        writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), vert: true }));
        git(call.opts.cwd, 'add', '--', JSON_PATH);
        git(call.opts.cwd, 'commit', '-q', '-m', 'feat(L1): vert', '--', JSON_PATH);
        return claudeOut(workReport({ commits: [{ sha: git(call.opts.cwd, 'rev-parse', 'HEAD'), sujet: 'feat(L1): vert' }] }));
      }],
    });
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/vert/);
  });

  it('une réécriture des tests commitée par une session interrompue est attrapée à la fin de la session suivante, par rapport au commit rouge', async () => {
    const h = prepared({ implement: [green], review: [ok] });
    const a = ecritAcceptation(h.repo, { sansFiche: true });
    sealAcceptation(h.repo, a.json);
    git(h.repo, 'add', '--', a.json);
    git(h.repo, 'commit', '-q', '-m', 'test(L1): acceptation scellée', '--', a.json);
    const rouge = git(h.repo, 'rev-parse', 'HEAD');
    const f = join(h.repo, a.json);
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), fiche: 'ailleurs.yaml' }, null, 2));
    git(h.repo, 'add', '--', a.json);
    git(h.repo, 'commit', '-q', '-m', 'feat(L1): réécrit avant la coupure', '--', a.json);
    const head = git(h.repo, 'rev-parse', 'HEAD');
    const c = h.lot('L1', screen, config);
    c.lot.accept = { acceptation: a.json, rouge };
    c.lot.next = 'implement';
    c.lot.status = 'suspended';
    c.lot.steps.push({ n: 1, kind: 'implement', model: 'sonnet', status: 'interrupted', started: 'x', headBefore: head });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/verrou des tests d'acceptation.*réécrit depuis son commit rouge/);
  });

  it('le verrou vaut pour les autres lots du dépôt : L2 ne touche pas aux tests de L1, même sans screen: ni orchestrate.accept', async () => {
    const h = harness({
      lots: [{ title: 'Un écran', screen: 'page' }, { title: 'Un autre lot' }],
      script: {
        implement: [(call) => {
          const f = 'test/prochain-match.acceptation.test.ts';
          writeFileSync(join(call.opts.cwd, f), "it('R1', () => {});\n");
          git(call.opts.cwd, 'add', '--', f);
          git(call.opts.cwd, 'commit', '-q', '-m', 'feat(L2): au passage', '--', f);
          return claudeOut(workReport({ commits: [{ sha: git(call.opts.cwd, 'rev-parse', 'HEAD'), sujet: 'feat(L2): au passage' }] }));
        }],
      },
    });
    ecritAcceptation(h.repo, { lot: 'L1', sansFiche: true });
    const c = h.lot('L2', {});
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/L1/);
  });

  it('après le vert de L1, le lot suivant ne voit aucun écart (seule la clé vert diffère du commit rouge)', async () => {
    const h = prepared({ accept: [accept()], implement: [green, notGreen], review: [ok, ok] }, [{ title: 'Un écran', screen: 'page' }, { title: 'Suite' }]);
    await runLot(h.lot('L1', screen, config));
    const c2 = h.lot('L2', {}, config);
    await runLot(c2);
    expect(c2.lot.status).toBe('ready');
    expect(existsSync(join(h.repo, JSON_PATH))).toBe(true);
  });
});
