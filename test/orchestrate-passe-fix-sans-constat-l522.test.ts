import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { noteTight, noteUnstable } from '../src/orchestrate/gate-notes.js';
import { measure } from '../src/corrections.js';
import { TEMPLATES_DIR } from '../src/orchestrate/briefs.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

const impl = (over: Record<string, unknown> = {}): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')], ...over }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const replaying = (test: string) => ({ test, testReplay: `${test} {files}` });
const WHY = (b: number, m: number) => `revue non conforme sans constat actionnable (${b} bloquant(s), ${m} majeur(s) annoncé(s), aucun constat lisible) : pas de passe de correction`;
const major: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 3, texte: 'bug nommé' }], verdict: 'non conforme' }));
const noFinding: Handler = () => claudeOut(reviewReport({ bloquants: 1, verdict: 'non conforme' }));
const withLog = (h: ReturnType<typeof harness>): string[] => {
  const lines: string[] = [];
  h.wave.log = (m: string) => void lines.push(m);
  return lines;
};

describe('L522 R1 — une revue non conforme sans constat actionnable n\'ouvre pas de passe de correction', () => {
  it('R1 — revue annonçant 1 bloquant sans aucun constat listé : aucune session fix, next inchangé, lot rendu', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [noFinding] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.pass).toBe(0);
    expect(c.lot.next).toBeNull();
    expect(c.lot.status).toBe('handed-back');
  });
  it('R1 — revue UX non conforme sans constat actionnable : aucune session fix', async () => {
    const uxBad: Handler = () => claudeOut(reviewReport({ majeurs: 2, verdict: 'UX non conforme' }));
    const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], review: [ok], ux: [uxBad], fix: [fix('b.txt')] } });
    const c = h.lot('L1', { visible: true }, { ux: { url: 'http://localhost:4200' } });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'ux']);
    expect(c.lot.pass).toBe(0);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.constats).toEqual([]); // une reprise ne rouvre pas la passe (cycle.ts : resumedFrom && constats.length)
    expect(c.lot.outcome).toBe(WHY(0, 2));
  });
});

describe('L522 R1 — cas limite : revue neuve de l\'escalade (L337)', () => {
  it('R1 — la revue neuve de l\'escalade non conforme sans constat actionnable rend le lot, escalade « rendu »', async () => {
    const h = harness({ script: { implement: [impl()], review: [major, major, major, noFinding], fix: [fix('b.txt'), fix('c.txt'), fix('d.txt')] } });
    const c = h.lot('L1', {}, { escalation: { model: 'fable' } });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toBe(WHY(1, 0));
    expect(c.lot.escalation?.issue).toBe('rendu');
  });
  it('R1 — l\'escalade rendue sans constat lisible est tracée au journal comme celle de toFix', async () => {
    const h = harness({ script: { implement: [impl()], review: [major, major, major, noFinding], fix: [fix('b.txt'), fix('c.txt'), fix('d.txt')] } });
    const lines = withLog(h);
    await runLot(h.lot('L1', {}, { escalation: { model: 'fable' } }));
    expect(lines.some((l) => l.includes("escalade fable : lot rendu malgré l'escalade"))).toBe(true);
  });
});

describe('L522 R2 — le lot est rendu avec la cause nommant les totaux annoncés', () => {
  it('R2 — lot rendu : statut handed-back et cause nommant les totaux annoncés', async () => {
    const rep: Handler = () => claudeOut(reviewReport({ bloquants: 2, majeurs: 3, verdict: 'non conforme' }));
    const h = harness({ script: { implement: [impl()], review: [rep] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toBe(WHY(2, 3));
  });
  it('R2 — la ligne du journal de la vague porte le même texte', async () => {
    const h = harness({ script: { implement: [impl()], review: [noFinding] } });
    const lines = withLog(h);
    await runLot(h.lot('L1'));
    expect(lines.some((l) => l.includes(WHY(1, 0)))).toBe(true);
  });
});

describe('L522 R3 — un constat actionnable est bloquant ou majeur, au texte non vide une fois rogné', () => {
  const rep = (texte: string): Handler => () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 3, texte }], verdict: 'non conforme' }));
  it('R3 — un majeur au texte vide ne compte pas, un majeur au texte lisible ouvre la passe', async () => {
    const blank = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [rep('   ')] } });
    await runLot(blank.lot('L1'));
    expect(kinds(blank)).toEqual(['implement', 'review']);
    const readable = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [rep('bug nommé'), ok] } });
    const c = readable.lot('L1');
    await runLot(c);
    expect(kinds(readable)).toEqual(['implement', 'review', 'fix', 'review']);
    expect(c.lot.pass).toBe(1);
  });
  it('R3 — des mineurs seuls n\'ouvrent pas de passe par ce chemin', async () => {
    const minors: Handler = () => claudeOut(reviewReport({ bloquants: 1, mineurs: 1, constats: [{ gravite: 'mineur', fichier: 'a.txt', ligne: 1, texte: 'nommage' }], verdict: 'non conforme' }));
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [minors] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('handed-back');
  });
});

describe('L522 R4 — une revue conforme garde son comportement', () => {
  it('R4 — revue conforme avec mineurs : passe des mineurs ouverte comme avant', async () => {
    const minor: Handler = () => claudeOut(reviewReport({ mineurs: 1, constats: [{ gravite: 'mineur', fichier: 'a.txt', ligne: 1, texte: 'nommage' }], verdict: 'conforme avec un mineur' }));
    const h = harness({ script: { implement: [impl()], review: [minor], fix: [fix('b.txt')], 'review-small': [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review-small']);
    expect(c.lot.status).toBe('ready');
  });
  it('R4 — revue conforme sans mineur : le lot conclut, aucune passe', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.pass).toBe(0);
  });
});

describe('L522 R5-R8 — un rouge de la porte est rejoué seul ; vert seul, il est proposé « à stabiliser »', () => {
  const LOG = () => join(tempDir(), 'rejeux.log');
  const gate = (log: string, alone: 'vert' | 'rouge') =>
    `f() { [ -f a.txt ] || exit 0; if [ -n "$1" ]; then echo "$@" >> ${log}; echo " ✓ $@"; ${alone === 'vert' ? 'exit 0' : 'echo " FAIL  test/a.test.ts > charge"; exit 1'}; fi; echo " FAIL  test/a.test.ts > charge"; exit 1; }; f`;
  const proposal = (t: string) => `[instable] ${t} — rouge dans la suite, vert rejoué seul : à stabiliser`;

  it('R5 — un test rouge seul aux deux rejeux : constat unique de la passe, instable absent', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', {}, replaying(gate(log, 'rouge')));
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(h.calls[1].brief).toContain('test/a.test.ts > charge');
    expect(c.lot.instables ?? []).toEqual([]);
    expect(c.lot.proposals.filter((p) => p.startsWith('[instable]'))).toEqual([]);
  });
  it('R5 — un test vert au rejeu : aucune passe de correction', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', {}, replaying(gate(LOG(), 'vert')));
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.pass).toBe(0);
  });
  it('R6 — un test instable : une proposition « [instable] … à stabiliser » dans les propositions du lot', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, replaying(gate(LOG(), 'vert')));
    await runLot(c);
    expect(c.lot.proposals).toContain(proposal('test/a.test.ts > charge'));
    expect(c.lot.proposals.filter((p) => p.startsWith('[instable]'))).toEqual(c.lot.instables!.map(proposal));
  });
  it('R6 — le même test instable deux fois : une seule proposition et un seul avertissement', () => {
    const h = harness({ script: {} });
    const c = h.lot('L1');
    noteUnstable(c, ['t > x']);
    noteUnstable(c, ['t > x']);
    expect(c.lot.proposals.filter((p) => p === proposal('t > x'))).toHaveLength(1);
    expect(c.lot.warnings.filter((w) => w.includes('instable(s) sous charge'))).toHaveLength(1);
  });
  it('R6 — avertissement, journal et liste instables inchangés', () => {
    const h = harness({ script: {} });
    const lines = withLog(h);
    const c = h.lot('L1');
    noteUnstable(c, ['t > x']);
    const text = '1 test(s) instable(s) sous charge (rouge(s) dans la suite, vert(s) rejoué(s) seul(s)), pas de passe de correction : t > x';
    expect(c.lot.warnings).toContain(text);
    expect(lines).toContain(`demo:L1 · ${text}`);
    expect(c.lot.instables).toEqual(['t > x']);
  });
  it('R7 — sans testReplay : un rouge ouvre la passe, aucune proposition d\'instabilité', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', {}, { test: gate(LOG(), 'vert') });
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(c.lot.proposals.filter((p) => p.startsWith('[instable]'))).toEqual([]);
  });
  it('R8 — délai trop juste : avertissement inchangé, aucune proposition « [instable] »', async () => {
    const test = `f() { [ -f a.txt ] || exit 0; if [ -n "$1" ]; then echo " ✓ $1 > plan-data 25012ms"; exit 0; fi; echo ' FAIL  test/a.test.ts > plan-data'; echo 'Error: Test timed out in 30000ms.'; exit 1; }; f`;
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, replaying(test));
    await runLot(c);
    expect(c.lot.warnings.some((w) => /délai trop juste, pas un bug \(pas de passe de correction\).*relever le délai du test/.test(w))).toBe(true);
    expect(c.lot.proposals.filter((p) => p.startsWith('[instable]'))).toEqual([]);
    const d = harness({ script: {} });
    const k = d.lot('L1');
    noteTight(k, [{ test: 't > y', ms: 25000, limit: 30000 }]);
    expect(k.lot.proposals).toEqual([]);
  });
});

describe('L522 R11 — les briefs implement et fix ne promettent plus une passe quand la porte est verte', () => {
  it.each(['implement.md', 'fix.md'])('R11 — le brief %s dit que nouveauxEchecs ne déclenche rien quand la porte du programme est verte', (f) => {
    expect(readFileSync(join(TEMPLATES_DIR, f), 'utf8')).toContain("unless the program's gate is green (L522)");
  });
});

describe('L522 R9 — le brief fix demande de rejouer seul un rouge avant de le corriger', () => {
  const brief = readFileSync(join(TEMPLATES_DIR, 'fix.md'), 'utf8');
  it('R9 — le brief fix contient la consigne de rejeu seul et de rangement sous « choix » d\'un test vert seul', () => {
    expect(brief).toMatch(/replay each red test named/i);
    expect(brief).toMatch(/alone/i);
    expect(brief).toMatch(/green when replayed alone/i);
    expect(brief).toContain('« choix »');
    expect(brief).toMatch(/unstable/i);
  });
  it('R9 — le brief fix garde la règle « sans commit, choix dit pourquoi »', () => {
    expect(brief).toMatch(/If you make no commit at all, "choix" MUST say why/);
  });
});

describe('L522 R10 — la mesure lit la ligne sans-constat, classification inchangée', () => {
  it('R10 — cadence corrections --json compte toujours une passe sans constat dans sans-constat (classification inchangée)', () => {
    const data = { lots: [{ project: 'p', lot: 'L1', visible: false, fixes: 1 }], passes: [{ key: 'w/p--L1/2', project: 'p', lot: 'L1', visible: false, findings: [], commits: [] }] };
    const m = measure(data, new Map());
    expect(m.byCause['sans-constat']).toBe(1);
  });
  it('R10 — docs/orchestrate-gate.md cite la mesure de départ 73 sur 580', () => {
    const doc = readFileSync(join(TEMPLATES_DIR, '..', '..', 'docs', 'orchestrate-gate.md'), 'utf8');
    expect(doc).toMatch(/73 passes (out of|sur) 580/);
    expect(doc).toMatch(/48 of (those|these) 73/);
  });
});

describe('L522 R11 — la porte du programme verte l\'emporte sur l\'annonce de tests rouges', () => {
  const rouge = { commande: 'npm test', resultat: '24 failed', vert: false };
  const TEXT = 'tests annoncés rouges par la session, mais la porte du programme verte (exit 0, code 0) : l\'annonce n\'est pas crue, pas de correction';
  const warns = (c: { lot: { warnings: string[] } }) => c.lot.warnings.filter((w) => w.includes('porte du programme verte'));
  it('R11 — porte verte, session annonçant des tests rouges sans échecs de base déclarés : avertissement au texte exact, revue, aucune passe', async () => {
    const h = harness({ script: { implement: [impl({ tests: rouge })], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'exit 0' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.pass).toBe(0);
    expect(warns(c)).toEqual([TEXT]);
  });
  it('R11 — porte verte et échecs de base déclarés avec nouveauxEchecs vide (L361) : même issue et même texte exact, l\'ancien texte « aucun nouvel échec déclaré » n\'apparaît plus', async () => {
    const h = harness({ script: { implement: [impl({ tests: rouge, echecsDeBase: ['autre-lot > cas ancien'], nouveauxEchecs: [] })], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'exit 0' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(warns(c)).toEqual([TEXT]);
    expect(c.lot.warnings.join('\n')).not.toContain('aucun nouvel échec déclaré');
  });
  it('R11 — porte verte et nouveauxEchecs non vide : aucune passe de correction, revue normale, texte exact (remplace test/orchestrate-cycle.test.ts:2807)', async () => {
    const h = harness({ script: { implement: [impl({ tests: rouge, echecsDeBase: ['autre-lot > cas ancien'], nouveauxEchecs: ['lot > nouveau'] })], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'exit 0' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.pass).toBe(0);
    expect(warns(c)).toEqual([TEXT]);
  });
  it('R11 — porte verte, echecsDeBase seul ou nouveauxEchecs vide seul : aucune passe de correction (remplace test/orchestrate-cycle.test.ts:2813)', async () => {
    for (const extra of [{ echecsDeBase: ['autre-lot > cas ancien'] }, { nouveauxEchecs: [] as string[] }]) {
      const h = harness({ script: { implement: [impl({ tests: rouge, ...extra })], fix: [fix('b.txt')], review: [ok] } });
      const c = h.lot('L1', {}, { test: 'exit 0' });
      await runLot(c);
      expect(kinds(h)).toEqual(['implement', 'review']);
      expect(warns(c)).toEqual([TEXT]);
    }
  });
  it('R11 — porte rouge (code non nul) et annonce rouge : passe de correction comme avant', async () => {
    const h = harness({ script: { implement: [impl({ tests: rouge })], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'test -f b.txt' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'review']);
    expect(warns(c)).toEqual([]);
  });
  it('R11 — sans orchestrate.test, l\'annonce reste régie par les règles L215 inchangées (cycle.ts:2252)', async () => {
    const h = harness({ script: { implement: [impl({ tests: rouge })], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'review']);
  });
  it('R11 — docs/orchestrate-gate.md ne dit plus que l\'annonce sans les deux champs déclenche la correction quand la porte est verte', () => {
    const doc = readFileSync(join(TEMPLATES_DIR, '..', '..', 'docs', 'orchestrate-gate.md'), 'utf8');
    expect(doc).not.toContain('without those two fields the claim of red tests still triggers the correction');
    expect(doc).toMatch(/own gate is green[^]*never believed/);
  });
});
