import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJournals } from '../src/corrections.js';
import { precheckBrief, renderBrief } from '../src/orchestrate/briefs.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { checkShape, PRECHECK_SCHEMA, WORK_SCHEMA } from '../src/orchestrate/schemas.js';
import { claudeOut, commitFile, git, harness, precheckReport, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';
import { writeJournal, writeWave } from './perf-helpers.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const implement = read('../templates/orchestrate/implement.md');
const vars = { chemin: '/r/p', lot: 'L9', titre: 'Un titre', objectif: 'faire X', commits: 'c1', reponse: '', constats: 'un constat', ux: '', choix: '', checks: '', news: '', captures: '', fiche: '', repos: '' };
const GRILLE = 'Grid of the code-reviewer (L523)';
const LECTURE = 'Pre-check reading (L523)';
const paragraph = (titre: string) => implement.slice(implement.indexOf(titre)).split('\n\n')[0]!;
const bloc = paragraph(GRILLE);

describe('L523 — la grille dans le brief implement', () => {
  it('R1 — le brief implement porte chaque famille de la grille du code-reviewer', () => {
    const out = renderBrief('implement', vars);
    expect(out).toContain(GRILLE);
    for (const famille of ['code bug', 'wrong result', 'unhandled error', 'input trusted raw', 'architecture drift', 'wrong module', 'duplicated block', 'layer skipped', 'test missing or that cannot fail', 'dead code', 'error swallowed', 'documentation that does not follow', 'written convention of the project']) expect(paragraph(GRILLE), famille).toContain(famille);
  });

  it('R1 — la grille du brief reprend les familles de l\'étape 6 de agents/code-reviewer.md', () => {
    const reviewer = read('../agents/code-reviewer.md');
    for (const [dansAgent, dansBrief] of [['a test that cannot fail', 'cannot fail'], ['a duplicated block', 'duplicated block'], ['dead code', 'dead code'], ['errors swallowed', 'error swallowed'], ['inputs trusted', 'input trusted'], ['a written convention of the project', 'written convention of the project'], ['documentation that does not follow', 'documentation that does not follow']]) {
      expect(reviewer, dansAgent).toContain(dansAgent);
      expect(bloc, dansBrief).toContain(dansBrief);
    }
  });

  it('R2 — le bloc renvoie à l\'étape edge cases de la ligne 24 sans reprendre le marqueur [L447]', () => {
    expect(bloc).toContain('edge cases');
    expect(bloc).not.toContain('[L447]');
    expect(implement.split('[L447]').length - 1).toBe(1);
  });

  it('R2 — le brief implement ordonne d\'écrire d\'abord les tests des cas limites et de les voir échouer avant le code', () => {
    expect(bloc).toMatch(/write its test BEFORE the first line of code/);
    expect(bloc).toMatch(/see it fail for the right reason/);
    expect(bloc.indexOf('BEFORE the first line of code')).toBeLessThan(bloc.indexOf('then code'));
    for (const cas of ['empty', 'absent', 'twice', 'wrong order', 'wrong type', 'refused', 'real shape of the data', 'other callers']) expect(bloc, cas).toContain(cas);
  });

  it('R2 — le brief garde le cas hors fiche sous nonVerifie ou choix', () => {
    expect(bloc).toMatch(/neither coded nor tested/);
    expect(bloc).toContain('"nonVerifie" or "choix"');
  });

  it('R3 — le brief implement demande de relire le diff contre la grille avant le dernier commit et d\'écrire les points non tenus sous choix ou nonVerifie', () => {
    expect(bloc).toMatch(/Before your last commit, re-read your diff against this grid/);
    expect(bloc).toMatch(/point you do not hold goes under "choix" or "nonVerifie"/);
  });

  it('R3 — WORK_SCHEMA n\'a pas de nouveau champ', () => {
    expect(Object.keys(WORK_SCHEMA.properties).sort()).toEqual(['build', 'choix', 'commits', 'echecsDeBase', 'nonVerifie', 'nouveauxEchecs', 'questions', 'resume', 'tests']);
  });

  it('R4 — implement se rend sans accolade restante avec les variables existantes', () => {
    const out = renderBrief('implement', vars);
    expect(out).not.toMatch(/\{\{|\}\}/);
    expect(bloc).not.toMatch(/\{\{|\}\}/);
  });

  it('R4 — fix, fix-minors, spec, accept et review-small n\'ont pas le bloc de la grille', () => {
    for (const nom of ['fix', 'fix-minors', 'spec', 'spec-back', 'accept', 'accept-back', 'review', 'review-small'] as const) expect(renderBrief(nom, vars), nom).not.toContain(GRILLE);
  });

  it('R12 — le bloc de la grille est un paragraphe séparé, entre Limits and rules et Real walkthrough', () => {
    const paragraphes = implement.split('\n\n');
    const i = paragraphes.findIndex((p) => p.startsWith(GRILLE));
    expect(i).toBeGreaterThan(0);
    expect(paragraphes[i - 1]).toMatch(/^Limits and rules, before the walkthrough/);
    expect(paragraphes[i + 1]).toMatch(/^Real walkthrough/);
  });

  it('R12 — implement.md contient [L447] une seule fois et la section Self-check aucune', () => {
    expect(implement.split('[L447]').length - 1).toBe(1);
    expect(paragraph('Self-check before handing back')).not.toContain('[L447]');
    expect(paragraph('Limits and rules, before the walkthrough')).toContain('[L447]');
  });

  it('R12 — la ligne Auto-verification garde ses cinq termes et désigne le bloc, la grille n\'est pas recopiée dessus', () => {
    const ligne = paragraph('Auto-verification once the tests are green');
    for (const mot of ['code bug', 'architecture drift', 'docs/architecture.md', 'edge cases', 'one test per changed behaviour']) expect(ligne, mot).toContain(mot);
    expect(ligne).toContain(GRILLE);
    expect(ligne).not.toContain('dead code');
  });
});

describe('L523 — le précheck rend sa lecture', () => {
  it('R5 — le brief precheck demande les fichiers concernés, le code voisin à imiter et les tests existants', () => {
    const out = renderBrief('precheck', vars);
    expect(out).toContain('`lu`');
    expect(out).toContain('path:line');
    expect(out).toMatch(/neighbouring code to imitate/);
    expect(out).toMatch(/existing tests/);
    expect(out).toMatch(/optional/);
  });

  it('R5 — un rapport de précheck sans lu passe checkShape', () => {
    expect(checkShape(precheckReport(), PRECHECK_SCHEMA)).toMatchObject({ dejaPresent: 'non' });
  });

  it('R5 — lu n\'est pas dans required de PRECHECK_SCHEMA', () => {
    expect(PRECHECK_SCHEMA.required).not.toContain('lu');
    expect(Object.keys(PRECHECK_SCHEMA.properties)).toContain('lu');
  });
});

const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, `f-${Math.random().toString(36).slice(2)}.txt`, 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const localCfg = { precheck: true, precheckLocal: true } as const;
const MARQUEUR = '[…tronqué]';

/** Un lot avec précheck Sonnet (rapports scriptés) ; renvoie le harnais et le lot après `runLot`. */
async function jouer(precheck: Handler[], cfg: { precheck: boolean; precheckLocal?: boolean } = { precheck: true }, script: Record<string, Handler[]> = {}) {
  const h = harness({ script: { precheck, implement: [impl], review: [ok], ...script } });
  const c = h.lot('L1', {}, cfg);
  await runLot(c);
  return { h, c };
}
const rapport = (over: Record<string, unknown>): Handler => () => claudeOut(precheckReport(over));

describe('L523 — le programme range la lecture (R6, R7, R9)', () => {
  it('R6 — verdict non avec lu : precheckLu porte le texte rogné', async () => {
    const { c, h } = await jouer([rapport({ lu: '  a.ts:3 — fonction voisine\n' })]);
    expect(c.lot.precheckLu).toBe('a.ts:3 — fonction voisine');
    expect(c.lot.precheck).toBeUndefined();
    expect(kinds(h)).toEqual(['precheck', 'implement', 'review']);
  });

  it('R6 — verdict partiel avec lu : precheckLu est rangé et precheck garde le constat', async () => {
    const { c } = await jouer([rapport({ dejaPresent: 'partiel', preuves: ['a.ts:1'], resume: 'la moitié', lu: 'b.ts:9' })]);
    expect(c.lot.precheckLu).toBe('b.ts:9');
    expect(c.lot.precheck).toContain('la moitié');
    expect(c.lot.precheck).not.toContain('b.ts:9');
    expect(c.lot.precheckVerdict).toBe('partiel');
  });

  it('R6 — « oui » sans preuve (traité comme partiel) : precheckLu est rangé', async () => {
    const { c } = await jouer([rapport({ dejaPresent: 'oui', preuves: [], resume: 'tout', lu: 'c.ts:2' })]);
    expect(c.lot.precheckVerdict).toBe('partiel');
    expect(c.lot.precheckLu).toBe('c.ts:2');
  });

  it('R6 — lu absent, vide ou d\'espaces : precheckLu absent', async () => {
    for (const lu of [undefined, '', '  \n\t ']) {
      const { c } = await jouer([rapport(lu === undefined ? {} : { lu })]);
      expect(c.lot.precheckLu, JSON.stringify(lu)).toBeUndefined();
      expect(c.lot.warnings.join('\n')).not.toContain('champ lu ignoré');
      expect(c.lot.status).toBe('ready');
    }
  });

  it('R6 — lu non chaîne : precheckLu absent et avertissement', async () => {
    for (const lu of [42, ['a.ts:1'], { f: 'a.ts' }, null]) {
      const { c } = await jouer([rapport({ lu })]);
      expect(c.lot.precheckLu, JSON.stringify(lu)).toBeUndefined();
      expect(c.lot.warnings.join('\n'), JSON.stringify(lu)).toContain('contrôle préalable : champ lu ignoré (mal typé)');
      expect(c.lot.status).toBe('ready');
    }
  });

  it('R6 — oui prouvé : lot rendu, precheckLu absent', async () => {
    const { c, h } = await jouer([rapport({ dejaPresent: 'oui', preuves: ['a.ts:1'], resume: 'tout est là', lu: 'a.ts:1' })]);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.precheckLu).toBeUndefined();
    expect(kinds(h)).toEqual(['precheck']);
  });

  it('R6 — oui du modèle local puis non de Sonnet : precheckLu vient de Sonnet', async () => {
    const { c } = await jouer([rapport({ dejaPresent: 'oui', preuves: ['a.ts:1'], resume: 'tout', lu: 'lecture locale' }), rapport({ lu: 'lecture Sonnet' })], localCfg);
    expect(c.lot.precheckLu).toBe('lecture Sonnet');
  });

  it('R6 — precheck local, non ou partiel du modèle local avec lu : precheckLu absent', async () => {
    for (const dejaPresent of ['non', 'partiel']) {
      const { c, h } = await jouer([rapport({ dejaPresent, preuves: [], resume: 'x', lu: 'lecture locale' })], localCfg);
      expect(kinds(h), dejaPresent).toEqual(['precheck', 'implement', 'review']);
      expect(c.lot.precheckLu, dejaPresent).toBeUndefined();
    }
  });

  it('R6 — precheck local replié sur Sonnet (modèle local en échec) : le lu de Sonnet est rangé', async () => {
    const { c } = await jouer([() => ({ code: 2, stdout: '', stderr: 'Ollama ne répond pas', timedOut: false }), rapport({ lu: 'lecture Sonnet' })], localCfg);
    expect(c.lot.precheckLu).toBe('lecture Sonnet');
  });

  it('R7 — un lu de 4001 caractères est tronqué, finit par le marqueur et fait exactement 4000 caractères', async () => {
    const { c } = await jouer([rapport({ lu: 'x'.repeat(4001) })]);
    expect(c.lot.precheckLu).toHaveLength(4000);
    expect(c.lot.precheckLu!.endsWith(MARQUEUR)).toBe(true);
    expect(c.lot.precheckLu!.startsWith('x'.repeat(4000 - MARQUEUR.length))).toBe(true);
  });

  it('R7 — un lu de 4000 caractères est rangé sans marqueur', async () => {
    const { c } = await jouer([rapport({ lu: 'y'.repeat(4000) })]);
    expect(c.lot.precheckLu).toBe('y'.repeat(4000));
  });

  it('R7 — la longueur se compte après avoir rogné les espaces', async () => {
    const { c } = await jouer([rapport({ lu: `  ${'z'.repeat(4000)}  ` })]);
    expect(c.lot.precheckLu).toBe('z'.repeat(4000));
  });

  it('R9 — le précheck n\'écrit pas la lecture dans precheck ni dans precheckVerdict', async () => {
    const { c } = await jouer([rapport({ dejaPresent: 'partiel', preuves: ['p.ts:1'], resume: 'un résumé', lu: 'LECTURE-UNIQUE' })]);
    expect(c.lot.precheckVerdict).toBe('partiel');
    expect(String(c.lot.precheck)).not.toContain('LECTURE-UNIQUE');
    expect(c.lot.precheck).toBe('A pre-check found part of the deliverable already in the repository (do not redo it): un résumé (p.ts:1)');
  });

  it('R9 — cadence corrections lit toujours precheckVerdict d\'un journal portant precheckLu', () => {
    const runs = tempDir();
    writeWave(runs, 'w1');
    writeJournal(runs, 'w1', 'proj', 'L1', { precheck: 'partiel', steps: [{ kind: 'precheck' }, { kind: 'implement' }] });
    const fichier = join(runs, 'w1', 'proj--L1.json');
    const brut = JSON.parse(readFileSync(fichier, 'utf8'));
    writeFileSync(fichier, JSON.stringify({ ...brut, precheckLu: 'a.ts:1' }));
    const [j] = readJournals(runs);
    expect(j!.precheck).toBe('partiel');
  });
});

describe('L523 — la lecture dans le brief implement (R8, R9)', () => {
  const lire = (c: { lot: { precheck?: string; precheckLu?: string } }, constat?: string, lu?: string) => {
    c.lot.precheck = constat;
    c.lot.precheckLu = lu;
  };

  it('R8 — implement avec precheckLu contient la lecture et la consigne de ne pas relire à froid', async () => {
    const { h } = await jouer([rapport({ lu: 'src/a.ts:12 — le module\ntest/a.test.ts — les tests' })]);
    const brief = h.calls.find((k) => k.kind === 'implement')!.brief;
    expect(brief).toContain(LECTURE);
    expect(brief).toContain('src/a.ts:12 — le module\ntest/a.test.ts — les tests');
    expect(brief).toMatch(/without searching for them again/);
    expect(brief).toMatch(/only to modify it or when this reading is not enough/);
    expect(brief).toMatch(/re-read the lines you edit/);
  });

  it('R8 — implement sans precheckLu est identique au brief d\'avant', async () => {
    const { h } = await jouer([rapport({ dejaPresent: 'partiel', preuves: ['a.ts'], resume: 'la moitié' })]);
    const brief = h.calls.find((k) => k.kind === 'implement')!.brief;
    expect(brief).not.toContain(LECTURE);
    expect(brief).toContain('A pre-check found part of the deliverable already in the repository (do not redo it): la moitié (a.ts)');
  });

  it('R8 — implement sans precheckLu est identique au brief d\'avant : precheckBrief rend exactement l\'ancienne jonction', () => {
    const avant = (commits: string, constat?: string) => (constat ? [commits, constat].filter(Boolean).join('\n') : commits);
    for (const commits of ['', '- abc1234 feat(L1): a']) {
      for (const constat of [undefined, '', 'A pre-check found part of the deliverable: la moitié']) {
        expect(precheckBrief(commits, constat, undefined)).toBe(avant(commits, constat));
        expect(precheckBrief(commits, constat, '')).toBe(avant(commits, constat));
      }
    }
  });

  it('R8 — le brief fix ne contient pas precheckLu', async () => {
    const major: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 3, texte: 'bug nommé' }], verdict: 'non conforme' }));
    const fix: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'fix.txt', 'fix(L1): fix.txt')] }));
    const { h } = await jouer([rapport({ lu: 'LECTURE-UNIQUE' })], { precheck: true }, { review: [major, ok], fix: [fix] });
    expect(kinds(h)).toEqual(['precheck', 'implement', 'review', 'fix', 'review']);
    expect(h.calls.find((k) => k.kind === 'implement')!.brief).toContain('LECTURE-UNIQUE');
    expect(h.calls.find((k) => k.kind === 'fix')!.brief).not.toContain('LECTURE-UNIQUE');
    expect(h.calls.find((k) => k.kind === 'fix')!.brief).not.toContain(LECTURE);
  });

  it('R8 — avec precheck partiel et precheckLu, le brief porte le constat puis la lecture, une seule fois', async () => {
    const { h } = await jouer([rapport({ dejaPresent: 'partiel', preuves: ['a.ts'], resume: 'la moitié', lu: 'LECTURE-UNIQUE' })]);
    const brief = h.calls.find((k) => k.kind === 'implement')!.brief;
    const constat = brief.indexOf('A pre-check found part of the deliverable');
    const lecture = brief.indexOf(LECTURE);
    expect(constat).toBeGreaterThanOrEqual(0);
    expect(lecture).toBeGreaterThan(constat);
    expect(brief.split(LECTURE)).toHaveLength(2);
    expect(brief.split('LECTURE-UNIQUE')).toHaveLength(2);
    expect(brief.slice(constat, lecture)).toMatch(/\(a\.ts\)\n\n$/);
  });

  it('R8 — reprise après interruption avec commits présents et precheckLu : le brief porte le texte de reprise et pas la lecture', async () => {
    const h = harness({ script: { implement: [impl], review: [ok] } });
    const c = h.lot('L1');
    const head = git(h.repo, 'rev-parse', 'HEAD');
    commitFile(h.repo, 'a.txt', 'feat(L1): a (avant la coupure)');
    lire(c, 'A pre-check found part of the deliverable: la moitié', 'LECTURE-UNIQUE');
    c.lot.next = 'implement';
    c.lot.status = 'suspended';
    c.lot.steps.push({ n: 1, kind: 'implement', model: 'sonnet', status: 'interrupted', started: 'x', headBefore: head });
    await runLot(c);
    const brief = h.calls[0]!.brief;
    expect(brief).toContain('A previous session was interrupted; resume from these commits');
    expect(brief).toContain('A pre-check found part of the deliverable: la moitié');
    expect(brief).not.toContain('LECTURE-UNIQUE');
    expect(brief).not.toContain(LECTURE);
  });

  it('R8 — reprise interrompue sans commit : pas de lecture non plus', async () => {
    const h = harness({ script: { implement: [impl], review: [ok] } });
    const c = h.lot('L1');
    lire(c, undefined, 'LECTURE-UNIQUE');
    c.lot.next = 'implement';
    c.lot.status = 'suspended';
    c.lot.steps.push({ n: 1, kind: 'implement', model: 'sonnet', status: 'interrupted', started: 'x', headBefore: git(h.repo, 'rev-parse', 'HEAD') });
    await runLot(c);
    expect(h.calls[0]!.brief).toContain('A previous session was interrupted before any commit');
    expect(h.calls[0]!.brief).not.toContain('LECTURE-UNIQUE');
  });

  it('R9 — un état sans precheckLu se relit et le brief implement est celui d\'avant', async () => {
    const h = harness({ script: { implement: [impl], review: [ok] } });
    const c = h.lot('L1');
    c.lot.precheck = 'A pre-check found part of the deliverable: la moitié';
    c.lot.next = 'implement';
    await runLot(c);
    const brief = h.calls[0]!.brief;
    expect(brief).toContain('\nA pre-check found part of the deliverable: la moitié\n');
    expect(brief).not.toContain(LECTURE);
  });

  it('R8 — precheckLu sans constat (verdict non) : la lecture seule, sans ligne vide en tête', async () => {
    const h = harness({ script: { implement: [impl], review: [ok] } });
    const c = h.lot('L1');
    c.lot.precheckLu = 'LECTURE-UNIQUE';
    c.lot.next = 'implement';
    await runLot(c);
    expect(h.calls[0]!.brief).toContain(`\n${LECTURE}`);
    expect(h.calls[0]!.brief).not.toMatch(/\n\n\n/);
  });
});

describe('L523 — la mesure et la documentation (R10, R11)', () => {
  const DOC = '../docs/mesures/brief-implementation-enrichi-avant-apres.md';
  const mesure = read(DOC);
  const readme = read('../README.md');

  it('R10 — le document de mesure nomme scripts/temps-d-un-lot.mjs, les trois mesures et la borne par création de vague', () => {
    expect(mesure).toContain('scripts/temps-d-un-lot.mjs');
    for (const m of ['passes par lot', 'bug-code', 'dérive d\'architecture', 'allers-retours de lecture']) expect(mesure, m).toContain(m);
    expect(mesure).toMatch(/`<borne>` à relever/);
    expect(mesure).toMatch(/date de création de la vague/);
    expect(mesure).toMatch(/vague à cheval/);
  });

  it('R10 — la ligne « après » du document est un emplacement à renseigner, sans chiffre', () => {
    const apres = /^\| Après[^\n]*$/m.exec(mesure)?.[0];
    expect(apres, 'ligne Après').toBeDefined();
    expect(apres).toContain('à renseigner');
    expect(apres).not.toMatch(/\d/);
  });

  it('R10 — la ligne « avant » reprend 52 %, 223, 10 % et 13,4', () => {
    const avant = /^\| Avant[^\n]*$/m.exec(mesure)?.[0];
    expect(avant, 'ligne Avant').toBeDefined();
    for (const chiffre of ['52 %', '223', '10 %', '13,4']) expect(avant, chiffre).toContain(chiffre);
  });

  it('R10 — le README renvoie au document de mesure avant/après de L523', () => {
    expect(readme).toContain('docs/mesures/brief-implementation-enrichi-avant-apres.md');
  });

  it('R11 — le README décrit la grille du brief implement et la lecture transmise par le précheck', () => {
    expect(readme).toMatch(/grid of the code-reviewer/i);
    expect(readme).toMatch(/pre-check.{0,60}reading|reading.{0,60}pre-check/i);
    const doc = read('../docs/orchestrate.md');
    expect(doc).toContain(GRILLE);
    expect(doc).toContain('precheckLu');
    expect(doc).toMatch(/`lu`/);
  });

  it('R11 — le CHANGELOG cite L523', () => {
    const non = read('../CHANGELOG.md').split('## [1.36.0]')[0]!;
    expect(non).toContain('L523');
    expect(non).toContain('precheckLu');
  });
});
