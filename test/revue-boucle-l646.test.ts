import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classeOf, fixConstatsText } from '../src/orchestrate/constat-classes.js';
import { blockingConstats } from '../src/orchestrate/cycle/shared.js';
import { convergeBrief, countReview } from '../src/orchestrate/cycle/converge.js';
import { REVIEW_SCHEMA } from '../src/orchestrate/schemas.js';
import { testsVertsSansCode } from '../src/test-sans-code.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import type { Constat } from '../src/orchestrate/state.js';

// L646 : revue en boucle. R1 le brief de fix donne les constats par classe et exige la correction de la classe ; R2 un test ajouté vert avec et sans le code du lot est refusé ;
// R3 la revue suivante ne relit pas un mineur déjà noté.
const k = (texte: string, extra: Partial<Constat> = {}): Constat => ({ source: 'code', gravite: 'majeur', texte, ...extra });
const lot = () => harness({ script: {} }).lot('L1').lot;

describe('R1 — le brief de fix donne les constats par classe et exige la correction de la classe', () => {
  it('R1 — deux constats de la même classe sont sous un seul titre, avec leur nombre', () => {
    const t = fixConstatsText([k('a', { classe: 'bug-code', fichier: 'x.ts', ligne: 3 }), k('b', { classe: 'bug-code' }), k('c', { classe: 'documentation' })]);
    expect(t).toContain('Class « bug-code » (2 findings)');
    expect(t).toContain('Class « documentation » (1 finding)');
    expect(t.match(/Class « bug-code »/g)).toHaveLength(1);
    expect(t).toContain('- [majeur] x.ts:3 — a');
  });
  it('R1 — le brief exige de corriger la classe entière, pas la seule ligne citée', () => {
    expect(fixConstatsText([k('a', { classe: 'bug-code' })])).toMatch(/every other instance of the class/);
  });
  it('R1 — un constat sans classe va sous « other » ; sans aucune classe la liste reste plate et la consigne de classe est tout de même donnée', () => {
    const mixte = fixConstatsText([k('a', { classe: 'bug-code' }), k('sans')]);
    expect(mixte).toContain('Class « other » (1 finding)');
    const plat = fixConstatsText([k('sans')]);
    expect(plat).not.toContain('Class «');
    expect(plat).toContain('- [majeur] sans');
    expect(plat).toMatch(/every other instance of the class/);
  });
  it('R1 — la source non code (UX, tests) reste dans le libellé du constat', () => {
    expect(fixConstatsText([k('rouge', { source: 'tests', gravite: 'bloquant' })])).toContain('- [bloquant / tests] rouge');
  });
  it('R1 — aucun constat : texte vide', () => {
    expect(fixConstatsText([])).toBe('');
  });
  it('R1 — classeOf ne garde que les classes connues (une valeur inventée ou d’un autre type est écartée)', () => {
    expect(classeOf('bug-code')).toBe('bug-code');
    expect(classeOf('inventée')).toBeUndefined();
    expect(classeOf(7)).toBeUndefined();
    expect(classeOf(undefined)).toBeUndefined();
  });
  it('R1 — le schéma de revue offre la classe, enum des classes connues, et blockingConstats la garde', () => {
    expect(REVIEW_SCHEMA.properties.constats.items.properties.classe.enum).toContain('bug-code');
    const rep = reviewReport({ constats: [{ gravite: 'majeur', texte: 'x', classe: 'test' }, { gravite: 'majeur', texte: 'y', classe: 'faux' }] as never });
    expect(blockingConstats(rep, 'code').map((c) => c.classe)).toEqual(['test', undefined]);
  });
});

describe('R3 — la revue suivante ne relit pas un mineur déjà noté', () => {
  const rapport = (constats: object[]) => JSON.parse(JSON.stringify(reviewReport({ mineurs: constats.length, constats, verdict: 'conforme' })));
  it('R3 — le brief de la revue 2 sépare les mineurs notés (« ne pas rapporter ») des constats que l’auteur devait corriger', () => {
    const l = lot();
    l.reviewCounts = [1] as never;
    l.codeConstats = [k('un majeur'), k('un mineur', { gravite: 'mineur', fichier: 'a.ts', ligne: 2 })];
    const b = convergeBrief('review', l);
    const fixIdx = b.indexOf('had to fix');
    const noteIdx = b.indexOf('already noted');
    expect(b.slice(fixIdx, noteIdx)).toContain('un majeur');
    expect(b.slice(fixIdx, noteIdx)).not.toContain('un mineur');
    expect(b.slice(noteIdx)).toContain('a.ts:2 — un mineur');
    expect(b.slice(noteIdx)).toMatch(/do not report/);
  });
  it('R3 — sans mineur noté, pas de section « already noted » ; sans majeur, pas de section « had to fix »', () => {
    const l = lot();
    l.reviewCounts = [1] as never;
    l.codeConstats = [k('un majeur')];
    expect(convergeBrief('review', l)).not.toContain('already noted');
    l.codeConstats = [k('m', { gravite: 'mineur' })];
    expect(convergeBrief('review', l)).not.toContain('had to fix');
  });
  it('R3 — un mineur que la revue précédente avait noté, redit mot pour mot, ne compte pas : « ecarte-deja-note », avertissement', () => {
    const l = lot();
    l.reviewCounts = [1] as never;
    l.codeConstats = [k('même mineur', { gravite: 'mineur', fichier: 'a.ts' })];
    const { summary, decisions } = countReview(rapport([{ gravite: 'mineur', texte: 'même mineur', fichier: 'a.ts' }, { gravite: 'mineur', texte: 'mineur neuf' }]), 'review', l, 'abc');
    expect(decisions.map((d) => d.decision)).toEqual(['ecarte-deja-note', 'compte']);
    expect(summary.mineurs).toBe(1);
    expect(l.warnings.some((w) => w.includes('même mineur'))).toBe(true);
  });
  it('R3 — le même texte dans un autre fichier est un mineur neuf, il compte', () => {
    const l = lot();
    l.reviewCounts = [1] as never;
    l.codeConstats = [k('texte', { gravite: 'mineur', fichier: 'a.ts' })];
    const { decisions } = countReview(rapport([{ gravite: 'mineur', texte: 'texte', fichier: 'b.ts' }]), 'review', l, 'abc');
    expect(decisions.map((d) => d.decision)).toEqual(['compte']);
  });
  it('R3 — un majeur qui reprend le texte d’un mineur noté compte (seul un mineur est écarté)', () => {
    const l = lot();
    l.reviewCounts = [1] as never;
    l.codeConstats = [k('texte', { gravite: 'mineur' })];
    const { decisions } = countReview(JSON.parse(JSON.stringify(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', texte: 'texte' }], verdict: 'non conforme' }))), 'review', l, 'abc');
    expect(decisions.map((d) => d.decision)).toEqual(['compte']);
  });
  it('R3 — revue 1 (rien de noté avant) : aucun mineur écarté', () => {
    const { decisions } = countReview(rapport([{ gravite: 'mineur', texte: 'x' }]), 'review', lot(), 'abc');
    expect(decisions.map((d) => d.decision)).toEqual(['compte']);
  });
});

describe('R2 — un test ajouté vert avec et sans le code du lot est refusé', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  const write = (dir: string, rel: string, text: string) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const isCode = (f: string) => f.startsWith('src/');
  const isTest = (f: string) => f.startsWith('test/');
  /** Un dépôt de départ (src/a.txt = « old ») puis un lot qui change src/a.txt en « new » et ajoute les tests donnés. */
  function repo(tests: Record<string, string>, extra: (d: string) => void = () => undefined) {
    const d = mkdtempSync(join(tmpdir(), 'l646-'));
    git(d, 'init', '-q', '-b', 'main');
    write(d, 'src/a.txt', 'old');
    write(d, 'test/ancien.test.txt', 'x');
    git(d, 'add', '.');
    git(d, 'commit', '-qm', 'base');
    const start = git(d, 'rev-parse', 'HEAD');
    write(d, 'src/a.txt', 'new');
    for (const [f, t] of Object.entries(tests)) write(d, f, t);
    extra(d);
    git(d, 'add', '.');
    git(d, 'commit', '-qm', 'feat(L1)');
    return { d, start };
  }
  // Le « test » d'essai : un fichier test/*.txt dont le contenu dit ce que le code doit être ; vert si src/a.txt vaut « new ».
  const run = async (command: string, cwd: string) => {
    const file = command.replace('check ', '');
    const want = readFileSync(join(cwd, file), 'utf8').trim();
    const have = readFileSync(join(cwd, 'src/a.txt'), 'utf8').trim();
    return { code: want === 'always' || want === have ? 0 : 1, output: '' };
  };
  const play = (d: string, start: string, over: Partial<Parameters<typeof testsVertsSansCode>[0]> = {}) =>
    testsVertsSansCode({ dir: d, start, isCode, isTest, replay: 'check {files}', run, ...over });

  it('R2 — un test ajouté vert même sans le code du lot (« always ») est refusé', async () => {
    const { d, start } = repo({ 'test/vide.test.txt': 'always' });
    try {
      expect(await play(d, start)).toEqual({ refuses: ['test/vide.test.txt'], ignores: [] });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('R2 — un test ajouté qui tombe sans le code du lot (rouge avec l’ancien src/a.txt) est gardé', async () => {
    const { d, start } = repo({ 'test/vrai.test.txt': 'new' });
    try {
      expect((await play(d, start)).refuses).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('R2 — seul le test qui ne peut pas échouer est nommé quand deux tests sont ajoutés', async () => {
    const { d, start } = repo({ 'test/vrai.test.txt': 'new', 'test/vide.test.txt': 'always' });
    try {
      expect((await play(d, start)).refuses).toEqual(['test/vide.test.txt']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('R2 — un code AJOUTÉ par le lot est retiré de l’arbre sans le code (un test vert parce que le fichier manque est refusé)', async () => {
    const { d, start } = repo({ 'test/lit.test.txt': 'new' }, (dir) => write(dir, 'src/b.txt', 'b'));
    const run2 = async (command: string, cwd: string) => ({ code: existsSync(join(cwd, 'src/b.txt')) ? 1 : 0, output: command });
    try {
      expect((await play(d, start, { run: run2 })).refuses).toEqual(['test/lit.test.txt']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('R2 — aucun test ajouté (seulement modifié) : rien à jouer, la commande n’est pas lancée', async () => {
    const { d, start } = repo({ 'test/ancien.test.txt': 'modifié' });
    let called = 0;
    try {
      expect(await play(d, start, { run: async () => ((called += 1), { code: 0, output: '' }) })).toEqual({ refuses: [], ignores: [] });
      expect(called).toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('R2 — aucun fichier de code changé par le lot : le contrôle ne dit rien (pas de « sans le code » à comparer)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'l646-'));
    try {
      git(d, 'init', '-q', '-b', 'main');
      write(d, 'src/a.txt', 'old');
      git(d, 'add', '.');
      git(d, 'commit', '-qm', 'base');
      const start = git(d, 'rev-parse', 'HEAD');
      write(d, 'test/seul.test.txt', 'always');
      git(d, 'add', '.');
      git(d, 'commit', '-qm', 'test(L1)');
      expect(await play(d, start)).toEqual({ refuses: [], ignores: [] });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('R2 — au-delà de la borne de fichiers, les derniers ne sont pas joués et sont rendus dans « ignores »', async () => {
    const { d, start } = repo({ 'test/a.test.txt': 'always', 'test/b.test.txt': 'always', 'test/c.test.txt': 'always' });
    try {
      const r = await play(d, start, { max: 2 });
      expect(r.refuses).toEqual(['test/a.test.txt', 'test/b.test.txt']);
      expect(r.ignores).toEqual(['test/c.test.txt']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('R2 — l’arbre de lot n’est pas touché et le worktree d’essai est retiré', async () => {
    const { d, start } = repo({ 'test/vide.test.txt': 'always' });
    try {
      await play(d, start);
      expect(git(d, 'status', '--porcelain')).toBe('');
      expect(git(d, 'worktree', 'list').split('\n')).toHaveLength(1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('R2 — une commande qui ne peut pas être lancée (code 127) n’est pas un test vert : rien n’est refusé', async () => {
    const { d, start } = repo({ 'test/x.test.txt': 'always' });
    try {
      expect((await play(d, start, { run: async () => ({ code: 127, output: 'introuvable' }) })).refuses).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('R2 — la porte du cycle : un test ajouté vert sans le code repart en correction', () => {
  const GATE = { code: ['*.ts'], tests: ['*.spec.ts'], except: [] as string[], threshold: 1 };
  const impl: Handler = (call) => claudeOut(workReport({ commits: ['a.ts', 'a.spec.ts'].map((f) => commitFile(call.opts.cwd, f, `feat(L1): ${f}`)) }));
  const fix: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.spec.ts', 'fix(L1): a.spec.ts')] }));
  const ok: Handler = () => claudeOut(reviewReport());
  const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
  const cfg = (replay: string | undefined) => ({ testGate: GATE, ...(replay ? { testReplay: replay } : {}) });

  it('R2 — rejeu vert sans le code : correction directe (sans revue avant), le brief nomme le test et sa classe', async () => {
    const h = harness({ script: { implement: [impl], fix: [fix], review: [ok] } });
    const c = h.lot('L1', {}, cfg('true {files}'));
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'review']);
    expect(h.calls[1].brief).toContain('a.spec.ts');
    expect(h.calls[1].brief).toContain('Class « test »');
    expect(c.lot.testVert).toBe(true);
  });
  it('R2 — rejeu rouge sans le code : le test garde quelque chose, la revue part', async () => {
    const h = harness({ script: { implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', {}, cfg('false {files}')));
    expect(kinds(h)).toEqual(['implement', 'review']);
  });
  it('R2 — sans orchestrate.testReplay la porte ne joue pas', async () => {
    const h = harness({ script: { implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', {}, cfg(undefined)));
    expect(kinds(h)).toEqual(['implement', 'review']);
  });
  it('R2 — la porte ne joue qu’une fois : la correction qui laisse le test vert ne boucle pas', async () => {
    const h = harness({ script: { implement: [impl], fix: [fix], review: [ok] } });
    const c = h.lot('L1', {}, cfg('true {files}'));
    await runLot(c);
    expect(c.lot.pass).toBe(1);
  });
  it('R2 — budget : la correction n’est pas payée, avertissement et revue', async () => {
    const h = harness({ script: { implement: [impl], review: [ok] } });
    const c = h.lot('L1', { budget: 100 }, cfg('true {files}'));
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.warnings.join('\n')).toContain('porte « test vert sans le code »');
  });
});
