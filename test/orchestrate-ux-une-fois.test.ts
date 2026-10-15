import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { fakeApp } from './fake-app.js';

// L221 — la revue UX de conformité ne passe qu'une fois, après la revue de code conforme.

const impl = (file = 'a.txt'): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `feat(L1): ${file}`)] }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const major: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 3, texte: 'bug nommé' }], verdict: 'non conforme' }));
const uxBad: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'ui.css', texte: 'contraste 2:1 (WCAG 1.4.3)' }], verdict: 'UX non conforme' }));
const uxOk: Handler = () => claudeOut(reviewReport({ verdict: 'ergonomie conforme (UX)' }));
const minorFinding = { gravite: 'mineur', fichier: 'a.txt', ligne: 1, texte: 'nommage' };
const minorReview: Handler = () => claudeOut(reviewReport({ mineurs: 1, constats: [minorFinding], verdict: 'code conforme avec un mineur' }));
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const withUx = { ux: { url: 'http://localhost:4200' } };
const visible = { lots: [{ title: 'Écran', visible: true }] };

describe('R1 — après une écriture, la revue de code, jamais ux', () => {
  it('R1 — lot visible : après implement, la première étape jouée est review, pas ux', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], review: [ok], ux: [uxOk] } });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'review']);
  });

  it('R1 — lot visible après une passe de correction : l\'étape suivante est review, aucune session ux', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], review: [major, ok], fix: [fix('b.txt')], ux: [uxOk] } });
    await runLot(h.lot('L1', { visible: true }, withUx));
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'ux']);
  });
});

describe('R2 — l\'UX finale', () => {
  it('R2 — revue de code conforme d\'un lot visible : une session ux part avant conclude', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], review: [ok], ux: [uxOk] } });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'ux']);
    expect(h.calls[2].args[h.calls[2].args.indexOf('--agent') + 1]).toBe('ux-reviewer');
    expect(h.calls[2].brief).toContain('http://localhost:4200');
  });

  it('R2 — revue de code conforme et UX conforme : le lot conclut, uxVerdict est enregistré', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], review: [ok], ux: [uxOk] } });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.uxVerdict).toBe('ergonomie conforme (UX)');
    expect(h.plan().lot('L1').review).toBeDefined();
    expect(h.plan().lot('L1').ux).toBeUndefined(); // pas de raf ux automatique
  });
});

describe('R3 — pas d\'UX entre les corrections', () => {
  it('R3 — revue non conforme puis conforme sur un lot visible : une seule étape ux dans le journal', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], review: [major, ok], fix: [fix('b.txt')], ux: [uxOk] } });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    expect(c.lot.steps.filter((s) => s.kind === 'ux')).toHaveLength(1);
    expect(c.lot.status).toBe('ready');
  });

  it('R3 — deux passes de correction sur un lot visible : zéro session ux avant la revue conforme', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], review: [major, major, ok], fix: [fix('b.txt'), fix('c.txt')], ux: [uxOk] } });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    const order = kinds(h);
    expect(order).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review', 'ux']);
    expect(order.indexOf('ux')).toBe(order.lastIndexOf('review') + 1);
  });
});

describe('R4 — les mineurs avant l\'UX', () => {
  it('R4 — revue conforme avec mineurs sur un lot visible : fix des mineurs, review-small conforme, puis ux, dans cet ordre', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], review: [minorReview], fix: [fix('b.txt')], 'review-small': [ok], ux: [uxOk] } });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review-small', 'ux']);
    expect(c.lot.status).toBe('ready');
  });
});

describe('R2 — passe des mineurs sans commit', () => {
  it('R2 — passe des mineurs sans commit sur un lot visible : ux puis conclusion', async () => {
    const rejected: Handler = () => claudeOut(workReport({ choix: ['mineur « nommage » refusé : le nom suit la convention du module'] }));
    const h = harness({ ...visible, script: { implement: [impl()], review: [minorReview], fix: [rejected], ux: [uxOk] } });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'ux']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.uxVerdict).toBe('ergonomie conforme (UX)');
    expect(h.plan().lot('L1').review?.verdict).toContain('passe des mineurs sans commit');
  });
});

describe('R5 — UX non conforme', () => {
  it('R5 — UX non conforme : passe de correction avec les constats UX, revue de code, puis nouvelle étape ux', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], review: [ok, ok], ux: [uxBad, uxOk], fix: [fix('b.txt')] } });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'ux', 'fix', 'review', 'ux']);
    expect(h.calls[3].brief).toContain('contraste 2:1 (WCAG 1.4.3)');
    expect(c.lot.pass).toBe(1);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.uxVerdict).toBe('ergonomie conforme (UX)');
  });

  it('R5 — UX non conforme après le plafond de passes : le lot est rendu au lead avec les constats', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], review: [ok, ok, ok], ux: [uxBad, uxBad, uxBad], fix: [fix('b.txt'), fix('c.txt')] } });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'ux', 'fix', 'review', 'ux', 'fix', 'review', 'ux']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/après 2 passe\(s\) de correction/);
    expect(c.lot.constats.map((k) => k.texte)).toContain('contraste 2:1 (WCAG 1.4.3)');
    expect(h.plan().lot('L1').review).toBeUndefined();
  });
});

describe('R6 — pas d\'UX possible', () => {
  it('R6 — orchestrate.ux absent : revue de code conforme, aucune session ux, uxNote posée, le lot conclut', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', { visible: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.uxNote).toMatch(/UX à faire par le lead/);
    expect(c.lot.status).toBe('ready');
  });

  it('R6 — port occupé : aucune session ux, note « UX non vérifiée », le lot conclut', async () => {
    const app = await fakeApp(0);
    const { createServer } = await import('node:http');
    const srv = createServer((_q, r) => r.end('autre')).listen(Number(new URL(app.url).port));
    try {
      const h = harness({ ...visible, script: { implement: [impl()], review: [ok], ux: [uxOk] } });
      const c = h.lot('L1', { visible: true }, { ux: { command: app.command, url: app.url, timeout: 5 } });
      await runLot(c);
      expect(kinds(h)).toEqual(['implement', 'review']);
      expect(c.lot.uxNote).toMatch(/UX non vérifiée.*port occupé/);
      expect(c.lot.status).toBe('ready');
      expect(h.plan().lot('L1').review).toBeDefined();
    } finally {
      srv.close();
    }
  });
});

describe('R7 — les parcours inchangés', () => {
  it('R7 — petit lot visible : review-small seule, aucune session ux', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], 'review-small': [ok], ux: [uxOk] } });
    const c = h.lot('L1', { visible: true, small: true }, withUx);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review-small']);
    expect(c.lot.status).toBe('ready');
  });

  it('R7 — lot non visible : review seule, aucune session ux', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok], ux: [uxOk] } });
    const c = h.lot('L1', {}, withUx);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('ready');
  });
});

describe('R9 — reprise d\'un état écrit avec l\'ancien aiguillage', () => {
  it('R9 — état repris avec next = ux et sans revue de code conforme : la revue de code part d\'abord, puis ux', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], review: [ok], ux: [uxOk] } });
    const c = h.lot('L1', { visible: true }, withUx);
    // état d'avant la mise en service : implement fait (commit citant le lot), next = ux, aucune revue de code
    commitFile(h.repo, 'a.txt', 'feat(L1): a.txt');
    const plan = h.plan();
    plan.setStatus('L1', 'doing', '2026-10-04');
    plan.save();
    git(h.repo, 'add', '--', 'docs/plan/raf.yaml');
    git(h.repo, 'commit', '-q', '-m', 'plan: L1 démarré', '--', 'docs/plan/raf.yaml');
    c.lot.status = 'implementing';
    c.lot.next = 'ux';
    await runLot(c);
    expect(kinds(h)).toEqual(['review', 'ux']);
    expect(c.lot.status).toBe('ready');
  });

  it('R9 — état repris avec next = ux et revue de code conforme au HEAD courant : la session ux part, puis le lot conclut, sans revue de code', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], review: [ok], ux: [uxOk] } });
    const c = h.lot('L1', { visible: true }, withUx);
    // un 1er passage s'arrête avant l'UX (budget de la vague), la reprise repart de ux
    h.wave.budget.limit = 2200; // implement (1500) + review (1500) > 2200 : la suspension tombe avant ux
    await runLot(c);
    expect(c.lot.next).toBe('ux');
    expect(kinds(h)).toEqual(['implement', 'review']);
    h.wave.budget.limit = 1_000_000;
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'ux']);
    expect(c.lot.status).toBe('ready');
  });
});

describe('R11 — budgets', () => {
  it('R11 — budget du lot dépassé après la revue de code conforme : la session ux part quand même', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], review: [ok], ux: [uxOk] } });
    const c = h.lot('L1', { visible: true, budget: 1000 }, withUx); // l'implémentation compte 1500
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'ux']);
    expect(c.lot.status).toBe('ready');
  });

  it('R11 — budget de la vague épuisé après la revue de code conforme : aucune session ux, le lot est suspendu comme avant', async () => {
    const h = harness({ ...visible, budget: 2200, script: { implement: [impl()], review: [ok], ux: [uxOk] } });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('suspended');
    expect(c.lot.outcome).toBe('budget atteint');
    expect(c.lot.next).toBe('ux');
    expect(h.plan().lot('L1').review).toBeUndefined();
  });
});

describe('R12 — état UX périmé', () => {
  it('R12 — UX non conforme, fix, revue de code conforme : la session ux repart (l.ux périmé n\'envoie pas la revue conforme vers fix)', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], review: [ok, ok], ux: [uxBad, uxOk], fix: [fix('b.txt')] } });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    expect(kinds(h).filter((k) => k === 'fix')).toHaveLength(1);
    expect(kinds(h).at(-1)).toBe('ux');
    expect(c.lot.status).toBe('ready');
  });

  it('R12 — après un fix, l.ux, l.uxVerdict et les constats de source ux sont vides', async () => {
    let seen: { ux: unknown; verdict: unknown; constats: string[] } | undefined;
    const h = harness({ ...visible, script: { implement: [impl()], review: [ok, ok], ux: [uxBad, uxOk], fix: [fix('b.txt')] } });
    const c = h.lot('L1', { visible: true }, withUx);
    const review2: Handler = () => {
      seen = { ux: c.lot.ux, verdict: c.lot.uxVerdict, constats: c.lot.constats.filter((k) => k.source === 'ux').map((k) => k.texte) };
      return claudeOut(reviewReport());
    };
    h.wave.claude = ((orig) => async (args: string[], o: Parameters<typeof orig>[1]) => {
      if (args.join(' ').includes('--agent code-reviewer') && h.calls.some((x) => x.kind === 'fix')) return review2(null as never);
      return orig(args, o);
    })(h.wave.claude);
    await runLot(c);
    expect(seen).toEqual({ ux: undefined, verdict: null, constats: [] });
  });

  it('R12 — revue de code non conforme après une UX non conforme : les constats UX périmés ne sont pas rejoints à la correction', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], review: [ok, major, ok], ux: [uxBad, uxOk], fix: [fix('b.txt'), fix('c.txt')] } });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'ux', 'fix', 'review', 'fix', 'review', 'ux']);
    expect(h.calls[3].brief).toContain('contraste 2:1 (WCAG 1.4.3)');
    expect(h.calls[5].brief).toContain('bug nommé');
    expect(h.calls[5].brief).not.toContain('contraste 2:1 (WCAG 1.4.3)');
  });
});

describe('R13 — enregistrement et commit postérieur', () => {
  it('R13 — UX conforme : recordReview reçoit le sha de la revue de code et son verdict, pas ceux de l\'UX', async () => {
    const h = harness({ ...visible, script: { implement: [impl()], review: [() => claudeOut(reviewReport({ verdict: 'code conforme RC' }))], ux: [uxOk] } });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    const rec = h.plan().lot('L1').review;
    expect(rec?.verdict).toContain('code conforme RC');
    expect(rec?.verdict).not.toContain('ergonomie conforme (UX)');
    expect(rec?.commit).toBe(git(h.repo, 'log', '--format=%H', '--grep=feat(L1)', '-1'));
    expect(c.lot.code?.verdict).toBe('code conforme RC');
    expect(c.lot.uxVerdict).toBe('ergonomie conforme (UX)');
  });

  it('R13 — commit postérieur à la revue de code pendant l\'UX : lot handed-back, verdict non enregistré', async () => {
    // une session en lecture seule qui commite est un incident (garde de la session) : le commit tiers tombe entre la fin de l'UX et la conclusion
    const h = harness({ ...visible, script: { implement: [impl()], review: [ok], ux: [uxOk] } });
    const c = h.lot('L1', { visible: true }, withUx);
    const load = c.loadPlan;
    let moved = false;
    c.loadPlan = () => {
      if (!moved && h.calls.some((x) => x.kind === 'ux')) {
        moved = true;
        commitFile(h.repo, 'tiers.txt', 'feat(L1): commit tiers');
      }
      return load();
    };
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/un commit est postérieur à la revue : verdict non enregistré/);
    expect(h.plan().lot('L1').review).toBeUndefined();
  });
});

describe('R14 — rapport ux mal formé', () => {
  it('R14 — rapport ux mal formé : étape failed, lot arrêté, aucun verdict enregistré', async () => {
    const bad: Handler = () => claudeOut({ nimporte: 'quoi' });
    const h = harness({ ...visible, script: { implement: [impl()], review: [ok], ux: [bad] } });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(c.lot.steps.at(-1)?.status).toBe('failed');
    expect(c.lot.outcome).toMatch(/^ux : /);
    expect(h.plan().lot('L1').review).toBeUndefined();
  });
});

