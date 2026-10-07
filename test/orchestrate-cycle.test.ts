import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { renderTable } from '../src/orchestrate/table.js';
import { Plan } from '../src/plan.js';
import { TEMPLATES_DIR } from '../src/orchestrate/briefs.js';
import { isNonQuestion, runLot } from '../src/orchestrate/cycle.js';
import { installPrePush } from '../src/orchestrate/guard.js';
import { projectLogDir } from '../src/orchestrate/launch.js';
import { createServer } from 'node:http';
import { tempDir } from './helpers.js';
import { fakeApp } from './fake-app.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

/** Une implémentation qui commite un fichier citant le lot. */
const impl = (file = 'a.txt', over: Record<string, unknown> = {}): Handler => (call) => {
  const c = commitFile(call.opts.cwd, file, `feat(L1): ${file}`);
  return claudeOut(workReport({ commits: [c], ...over }));
};
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const major: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 3, texte: 'bug nommé' }], verdict: 'non conforme' }));
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);

/** Enregistre dans le plan une revue de code du lot, rattachée au commit donné (HEAD par défaut), et la commite. */
function recordReview(h: ReturnType<typeof harness>, verdict: string, commit = git(h.repo, 'rev-parse', 'HEAD')): void {
  const plan = h.plan();
  plan.recordReview('L1', verdict, '2026-10-04', commit);
  plan.save();
  git(h.repo, 'add', '--', 'docs/plan/raf.yaml');
  git(h.repo, 'commit', '-q', '-m', 'plan: L1 revue', '--', 'docs/plan/raf.yaml');
}

describe('cycle nominal', () => {
  it('implémentation Sonnet → revue Opus neuve conforme → raf review écrit avec le sha relu, raf done non appelé', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.outcome).toBe('prêt à livrer');
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(h.calls[0].model).toBe('sonnet');
    expect(h.calls[1].model).toBe('opus');
    expect(h.calls[1].args).toContain('--agent');
    for (const call of h.calls) {
      expect(call.args).not.toContain('--resume');
      expect(call.opts.cwd).toBe(h.repo);
      expect(call.opts.env.CADENCE_ORCHESTRATED).toBe('w1');
    }
    const lot = h.plan().lot('L1');
    expect(lot.status).toBe('doing'); // raf done reste au lead
    expect(lot.review?.verdict).toContain('conforme : rien à signaler — orchestré (vague w1, 0 passe(s) de correction)');
    const lastWork = git(h.repo, 'log', '--format=%H', '--grep=feat(L1)', '-1');
    expect(lot.review?.commit).toBe(lastWork);
    expect(git(h.repo, 'status', '--porcelain')).toBe('');
    expect(git(h.repo, 'log', '--format=%s').split('\n').slice(0, 3)).toEqual([
      'plan: L1 revue de code enregistrée (orchestrate w1)',
      'feat(L1): a.txt',
      'plan: L1 démarré (orchestrate w1)',
    ]);
    // l'état est écrit : tokens séparés, budget = entrée + écriture + sortie
    const state = h.store.readLot('demo', 'L1')!;
    expect(state.steps[0].tokens).toEqual({ input: 100, cacheWrite: 1000, cacheRead: 50_000, output: 400, counted: 1500 });
    expect(h.wave.budget.consumed).toBe(3000);
    expect(h.wave.budget.cacheRead).toBe(100_000);
    expect(existsSync(join(h.store.dir, 'demo--L1', '1-implement.json'))).toBe(true);
  });

  it('un lot déjà en cours n\'est pas redémarré', async () => {
    const h = harness({ lots: [{ title: 'x', status: 'doing' }], script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(git(h.repo, 'log', '--format=%s')).not.toContain('démarré');
    expect(c.lot.status).toBe('ready');
  });
});

describe('corrections', () => {
  it('revue non conforme → correction en session NEUVE → conforme', async () => {
    const h = harness({ script: { implement: [impl()], review: [major, ok], fix: [fix('b.txt')] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review']);
    expect(c.lot.pass).toBe(1);
    expect(c.lot.status).toBe('ready');
    expect(h.calls[2].model).toBe('sonnet');
    expect(h.calls[2].brief).toContain('[majeur] a.txt:3 — bug nommé');
    expect(h.calls[2].brief).toContain('feat(L1): a.txt');
    expect(h.calls[2].args).not.toContain('--resume');
    expect(h.plan().lot('L1').review?.verdict).toContain('1 passe(s) de correction');
    // la revue qui a validé a lu le dernier commit
    expect(h.plan().lot('L1').review?.commit).toBe(git(h.repo, 'log', '--format=%H', '--grep=fix(L1)', '-1'));
  });

  it('2 passes épuisées → rendu au lead avec les constats restants, aucun verdict écrit', async () => {
    const h = harness({ script: { implement: [impl()], review: [major, major, major], fix: [fix('b.txt'), fix('c.txt')] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/après 2 passe\(s\) de correction/);
    expect(c.lot.constats[0].texte).toBe('bug nommé');
    expect(h.plan().lot('L1').review).toBeUndefined();
  });

  it('les totaux annoncés à 0 ne cachent pas un constat majeur', async () => {
    const liar: Handler = () => claudeOut(reviewReport({ majeurs: 0, constats: [{ gravite: 'majeur', texte: 'x' }] }));
    const h = harness({ script: { implement: [impl()], review: [liar, ok], fix: [fix('b.txt')] } });
    await runLot(h.lot('L1'));
    expect(kinds(h)).toContain('fix');
  });

  it('revue conforme avec mineurs → UNE passe de correction des mineurs (session neuve), puis revue courte', async () => {
    const minor: Handler = () => claudeOut(reviewReport({ mineurs: 1, constats: [{ gravite: 'mineur', fichier: 'a.txt', ligne: 1, texte: 'nommage' }], sousTaches: ['ajouter un test'] }));
    const h = harness({ script: { implement: [impl()], review: [minor], fix: [fix('b.txt')], 'review-small': [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review-small']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.pass).toBe(0); // la passe des mineurs ne consomme pas les passes de correction des défauts
    expect(h.calls[2].model).toBe('sonnet');
    expect(h.calls[2].args).not.toContain('--resume');
    expect(h.calls[2].brief).toContain('[mineur] a.txt:1 — nommage');
    expect(h.calls[3].model).toBe('opus');
    // le mineur corrigé n'est plus proposé ; la sous-tâche reste rendue au lead
    expect(c.lot.proposals).toEqual(['[sous-tâche code] ajouter un test']);
    expect(h.plan().lot('L1').tasks).toEqual([]);
    expect(h.plan().lot('L1').review?.verdict).toContain('passe des mineurs');
    expect(h.plan().lot('L1').review?.commit).toBe(git(h.repo, 'log', '--format=%H', '--grep=fix(L1)', '-1'));
  });

  it('la revue courte qui suit la passe des mineurs conclut même avec de nouveaux mineurs : rendus au lead, pas de seconde passe', async () => {
    const minor: Handler = () => claudeOut(reviewReport({ mineurs: 1, constats: [{ gravite: 'mineur', texte: 'encore' }] }));
    const h = harness({ script: { implement: [impl()], review: [minor], fix: [fix('b.txt')], 'review-small': [minor] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review-small']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.proposals).toEqual(['[mineur code] encore']);
  });

  it('un défaut majeur trouvé par la revue courte suit le chemin des corrections (passes comptées)', async () => {
    const minor: Handler = () => claudeOut(reviewReport({ mineurs: 1, constats: [{ gravite: 'mineur', texte: 'm' }] }));
    const h = harness({ script: { implement: [impl()], review: [minor], fix: [fix('b.txt'), fix('c.txt')], 'review-small': [major, ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review-small', 'fix', 'review-small']);
    expect(c.lot.pass).toBe(1);
    expect(c.lot.status).toBe('ready');
  });

  it('une sous-tâche seule (sans constat mineur) ne déclenche aucune passe', async () => {
    const sub: Handler = () => claudeOut(reviewReport({ sousTaches: ['ajouter un test'] }));
    const h = harness({ script: { implement: [impl()], review: [sub] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.proposals).toEqual(['[sous-tâche code] ajouter un test']);
  });
});

describe('choix faits', () => {
  it('les choix du rapport d\'implémentation sont gardés et joints au brief de la revue', async () => {
    const h = harness({ script: { implement: [impl('x.txt', { choix: ['SQLite plutôt que PostgreSQL'] })], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.choix).toEqual(['SQLite plutôt que PostgreSQL']);
    const review = h.calls.find((k) => k.kind === 'review')!;
    expect(review.brief).toContain('- SQLite plutôt que PostgreSQL');
    expect(review.brief).toContain('re-read each choice');
  });

  it('sans champ « choix » (ancien rapport) le lot passe, la revue ne reçoit rien', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.choix).toEqual([]);
  });
});

describe('lot visible : UX puis code', () => {
  it('UX d\'abord, revue de code en dernier ; correction issue de l\'UX suivie d\'une revue de code', async () => {
    const uxBad: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'ui.css', texte: 'contraste 2:1 (WCAG 1.4.3)' }], verdict: 'UX non conforme' }));
    const h = harness({
      lots: [{ title: 'Écran', visible: true }],
      script: { implement: [impl()], ux: [uxBad, ok], review: [ok, ok], fix: [fix('b.txt')] },
    });
    const c = h.lot('L1', { visible: true }, { ux: { url: 'http://localhost:4200' } });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'ux', 'review', 'fix', 'ux', 'review']);
    expect(kinds(h).at(-1)).toBe('review');
    expect(h.calls[1].args[h.calls[1].args.indexOf('--agent') + 1]).toBe('ux-reviewer');
    expect(h.calls[1].brief).toContain('http://localhost:4200');
    expect(h.calls[3].brief).toContain('contraste 2:1 (WCAG 1.4.3)');
    expect(c.lot.status).toBe('ready');
    expect(c.lot.uxVerdict).toBe('conforme : rien à signaler');
    // pas de raf ux automatique
    expect(h.plan().lot('L1').ux).toBeUndefined();
    expect(h.plan().lot('L1').review).toBeDefined();
  });

  it('le brief d\'implémentation d\'un lot visible porte l\'entrée Nouveautés ; celui d\'un lot sans écran, non (L48)', async () => {
    const hv = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], ux: [ok], review: [ok] } });
    await runLot(hv.lot('L1', { visible: true }, { ux: { url: 'http://localhost:4200' } }));
    expect(hv.calls[0].brief).toContain('cadence news new L1');
    expect(hv.calls[1].brief).not.toContain('news new'); // ux : pas de consigne d'écriture
    const hn = harness({ lots: [{ title: 'Sans écran' }], script: { implement: [impl()], review: [ok] } });
    await runLot(hn.lot('L1'));
    expect(hn.calls[0].brief).not.toContain('news new');
  });

  it("le brief d'implement d'un lot visible donne le dossier Playwright de la vague et la session l'a en --add-dir ; lot sans écran : ni l'un ni l'autre (L48/t4)", async () => {
    const hv = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], ux: [ok], review: [ok] } });
    await runLot(hv.lot('L1', { visible: true }, { ux: { url: 'http://localhost:4200' }, addDirs: ['/tmp/x'] }));
    const dir = join(hv.store.dir, 'demo--L1', 'playwright');
    const impl0 = hv.calls[0]!;
    expect(isAbsolute(dir)).toBe(true);
    expect(impl0.brief).toContain(`\`${dir}\``);
    const adds = impl0.args.flatMap((a, i) => (impl0.args[i - 1] === '--add-dir' ? [a] : []));
    expect(adds).toEqual(['/tmp/x', dir]);
    expect(hv.calls[1]!.args).not.toContain(dir); // ux
    const hn = harness({ lots: [{ title: 'Sans écran' }], script: { implement: [impl()], review: [ok] } });
    await runLot(hn.lot('L1'));
    expect(hn.calls[0]!.args).not.toContain('--add-dir');
    expect(hn.calls[0]!.brief).not.toContain('playwright');
  });

  it("fix et fix-minors d'un lot visible donnent le dossier Playwright de la vague (celui du --add-dir) ; lot sans écran : rien (L48/t6)", async () => {
    const hv = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], review: [major, minorReview(), ok], fix: [fix('b.txt'), fix('c.txt')], 'review-small': [ok] } });
    await runLot(hv.lot('L1', { visible: true }, { addDirs: ['/tmp/x'] }));
    const dir = join(hv.store.dir, 'demo--L1', 'playwright');
    const fixes = hv.calls.filter((c) => c.kind === 'fix');
    expect(fixes.length).toBeGreaterThanOrEqual(2);
    expect(fixes[0]!.brief).toContain('A fresh review of the commits'); // fix
    expect(fixes.some((f) => f.brief.includes('only minor findings'))).toBe(true); // fix-minors
    for (const f of fixes) {
      expect(f.brief).toContain(`\`${dir}\``);
      expect(f.brief).not.toMatch(/\{\{/);
      const adds = f.args.flatMap((a, i) => (f.args[i - 1] === '--add-dir' ? [a] : []));
      expect(adds).toEqual(['/tmp/x', dir]);
    }
    const hn = harness({ lots: [{ title: 'Sans écran' }], script: { implement: [impl()], review: [major, minorReview(), ok], fix: [fix('b.txt'), fix('c.txt')], 'review-small': [ok] } });
    await runLot(hn.lot('L1'));
    for (const f of hn.calls.filter((c) => c.kind === 'fix')) expect(f.brief).not.toContain('.cadence');
  });

  it('chaque session reçoit --strict-mcp-config et son fichier dans le dossier du lot ; lot visible : Playwright pour implement et ux (pas review), captures dans la vague (L74)', async () => {
    const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], ux: [ok], review: [ok] } });
    const c = h.lot('L1', { visible: true }, { ux: { url: 'http://localhost:4200' } });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'ux', 'review']);
    const lotDir = join(h.store.dir, 'demo--L1');
    for (const call of h.calls) {
      expect(call.args).toContain('--strict-mcp-config');
      const file = call.args[call.args.indexOf('--mcp-config') + 1];
      expect(file).toBe(join(lotDir, `mcp-${call.kind}.json`));
      const servers = JSON.parse(readFileSync(file, 'utf8')).mcpServers;
      if (call.kind === 'ux' || call.kind === 'implement') expect(Object.keys(servers), call.kind).toEqual(['playwright']);
      else expect(servers).toEqual({});
    }
    const ux = JSON.parse(readFileSync(join(lotDir, 'mcp-ux.json'), 'utf8')).mcpServers.playwright.args;
    expect(ux.at(-1)).toBe(join(lotDir, 'playwright'));
    expect(ux.at(-2)).toBe('--output-dir');
    expect(c.lot.uxCaptures).toBe(join(lotDir, 'playwright'));
  });

  it('lot visible sans étape ux : implement charge Playwright et uxCaptures pointe le dossier ; lot sans écran : aucun serveur, pas de captures (L74)', async () => {
    const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', { visible: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    const lotDir = join(h.store.dir, 'demo--L1');
    expect(Object.keys(JSON.parse(readFileSync(join(lotDir, 'mcp-implement.json'), 'utf8')).mcpServers)).toEqual(['playwright']);
    expect(JSON.parse(readFileSync(join(lotDir, 'mcp-review.json'), 'utf8')).mcpServers).toEqual({});
    expect(c.lot.uxCaptures).toBe(join(lotDir, 'playwright'));
    const h2 = harness({ lots: [{ title: 'Back' }], script: { implement: [impl()], review: [ok] } });
    const c2 = h2.lot('L1', { visible: false });
    await runLot(c2);
    expect(JSON.parse(readFileSync(join(h2.store.dir, 'demo--L1', 'mcp-implement.json'), 'utf8')).mcpServers).toEqual({});
    expect(c2.lot.uxCaptures).toBeUndefined();
  });

  it('brief ux rendu avec orchestrate.ux : la consigne de captures est celle de l\'étape (noms relatifs, dossier de la vague), jamais un dossier tmp ni un chemin absolu (L74/t3)', async () => {
    const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], ux: [ok], review: [ok] } });
    const c = h.lot('L1', { visible: true }, { ux: { url: 'http://localhost:4200' } });
    await runLot(c);
    const brief = h.calls.find((x) => x.kind === 'ux')!.brief;
    expect(brief).toContain('http://localhost:4200');
    expect(brief).toContain('1440');
    expect(brief).toContain('relative file name');
    expect(brief).not.toMatch(/tmp folder|shared tmp|OS temp/i);
  });

  it('command seule : le brief garde la consigne de lancement, le programme ne lance rien (L60)', async () => {
    const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], ux: [ok], review: [ok] } });
    await runLot(h.lot('L1', { visible: true }, { ux: { command: 'npm start' } }));
    expect(h.calls.find((x) => x.kind === 'ux')!.brief).toContain('Start the app with: npm start');
  });

  it('sans application déclarée : pas de session UX, « à faire par le lead »', async () => {
    const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', { visible: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.uxNote).toMatch(/UX à faire par le lead/);
    expect(c.lot.status).toBe('ready');
  });
});

describe('petit lot', () => {
  it('une seule session de revue (Opus), et @haiku ne vaut que pour l\'implémentation', async () => {
    const h = harness({ lots: [{ title: 'petit', estimate: 0.5, visible: true }], script: { implement: [impl()], 'review-small': [ok] } });
    const c = h.lot('L1', { small: true, visible: true, model: 'haiku' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review-small']);
    expect(h.calls[0].model).toBe('haiku');
    expect(h.calls[1].model).toBe('opus');
    expect(h.calls[1].brief).toContain('single pass');
    expect(c.lot.status).toBe('ready');
  });

  it('petit lot visible : review-small charge Playwright (captures dans la vague), son brief donne les noms relatifs ; petit lot sans écran : revue de code sans MCP (L74/t4)', async () => {
    const h = harness({ lots: [{ title: 'petit', estimate: 0.5, visible: true }], script: { implement: [impl()], 'review-small': [ok] } });
    const c = h.lot('L1', { small: true, visible: true }, { ux: { url: 'http://localhost:4200' } });
    await runLot(c);
    const lotDir = join(h.store.dir, 'demo--L1');
    expect(Object.keys(JSON.parse(readFileSync(join(lotDir, 'mcp-review-small.json'), 'utf8')).mcpServers)).toEqual(['playwright']);
    expect(c.lot.uxCaptures).toBe(join(lotDir, 'playwright'));
    const rs = h.calls.find((x) => x.kind === 'review-small')!;
    expect(JSON.parse(rs.args[rs.args.indexOf('--agents') + 1])['code-reviewer'].tools).toContain('mcp__playwright');
    const brief = h.calls.find((x) => x.kind === 'review-small')!.brief;
    expect(brief).toContain('relative file name');
    expect(brief).not.toContain('no browser MCP server is loaded');
    expect(brief).not.toMatch(/tmp folder|shared tmp/i);
    const h2 = harness({ lots: [{ title: 'petit', estimate: 0.5 }], script: { implement: [impl()], review: [ok] } });
    const c2 = h2.lot('L1', { small: true, visible: false });
    await runLot(c2);
    expect(kinds(h2)).toEqual(['implement', 'review']);
    const rv = h2.calls.find((x) => x.kind === 'review')!;
    expect(JSON.parse(rv.args[rv.args.indexOf('--agents') + 1])['code-reviewer'].tools).not.toContain('mcp__playwright');
    expect(JSON.parse(readFileSync(join(h2.store.dir, 'demo--L1', 'mcp-review.json'), 'utf8')).mcpServers).toEqual({});
    expect(c2.lot.uxCaptures).toBeUndefined();
  });
});

describe('contrôles autour des sessions', () => {
  it('tests annoncés rouges → correction directe (compte une passe), sans revue avant', async () => {
    const h = harness({ script: { implement: [impl('a.txt', { tests: { commande: 'npm test', resultat: '2 failed', vert: false } })], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'review']);
    expect(h.calls[1].brief).toContain('tests annoncés rouges');
    expect(c.lot.pass).toBe(1);
  });

  it('tests rouges quand l\'orchestrateur les lance (orchestrate.test)', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'test -f b.txt || { echo boom >&2; exit 3; }' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'review']);
    expect(h.calls[1].brief).toContain('en échec (code 3)');
    expect(h.calls[1].brief).toContain('boom');
  });

  it('tests et build lancés par le programme : résultat passé au relecteur, qui ne les refait pas (L75)', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'true', build: 'true' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    const brief = h.calls[1].brief;
    expect(brief).toContain('already ran these checks');
    expect(brief).toContain('`true` (tests): green');
    expect(brief).toContain('`true` (build): green');
    expect(brief).toContain('do not rebuild');
  });

  it('build rouge → correction directe, jamais de revue avant (L75)', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'true', build: 'test -f b.txt || { echo cassé >&2; exit 4; }' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'review']);
    expect(h.calls[1].brief).toContain('en échec (code 4)');
    expect(h.calls[2].brief).toContain('(build): green');
  });

  it('sans commande de tests ni de build, la revue ne reçoit aucun résultat (L75)', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    await runLot(h.lot('L1'));
    expect(h.calls[1].brief).not.toContain('already ran');
  });

  it('des « questions » vides ou de non-questions (« aucune question ») n\'arrêtent pas le lot (L52)', async () => {
    const none: Handler = () => claudeOut(workReport({ questions: ['', '  ', 'Aucune question.', 'Je n\'ai pas de question', 'No questions', 'N/A', 'none'] }));
    const h = harness({ script: { implement: [none], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).not.toBe('question');
    expect(c.lot.questions).toEqual([]);
  });

  it('isNonQuestion : liste fermée, jamais une entrée avec « ? » (L52/t1)', () => {
    for (const q of ['', '  ', '-', 'Aucune question.', 'AUCUNE  QUESTION !', 'Pas de question', "Je n'ai pas de question", 'Aucune question bloquante', 'No question', 'No questions.', 'No open questions', 'No open question', 'None', 'N/A', 'rien', 'Néant', 'Aucune autre question']) {
      expect(isNonQuestion(q), JSON.stringify(q)).toBe(true);
    }
    for (const q of ['No question except SQLite?', 'No blocking question except: SQLite?', 'No question but PostgreSQL?', 'Aucune question hors schéma ?', 'No, the question is SQLite?', 'No further question about X?', 'Aucune question ?', 'No question except SQLite', 'PostgreSQL ou SQLite ?']) {
      expect(isNonQuestion(q), JSON.stringify(q)).toBe(false);
    }
  });

  it('isNonQuestion : « vide » et les pluriels manquants (L86)', () => {
    for (const q of ['vide', 'Vide.', '(vide)', '(Vide)', 'pas de questions bloquantes', 'Pas de questions bloquantes.', "je n'ai pas de questions bloquantes", 'Je n’ai pas de questions bloquantes', "je n'ai aucune question bloquante", 'i have no blocking question', 'i have no blocking questions']) {
      expect(isNonQuestion(q), JSON.stringify(q)).toBe(true);
    }
    for (const q of ['vide ?', '(vide) ?', 'pas de questions bloquantes sauf SQLite ?', 'vide de sens', 'Le schéma est vide, que faire ?']) {
      expect(isNonQuestion(q), JSON.stringify(q)).toBe(false);
    }
  });

  it('isNonQuestion : apostrophe typographique (L52/t3)', () => {
    for (const q of ['Je n’ai pas de question', 'Je n’ai aucune question.', 'JE N’AI PAS DE QUESTION']) expect(isNonQuestion(q), q).toBe(true);
    expect(isNonQuestion('Je n’ai pas de question sauf SQLite ?')).toBe(false);
  });

  it('une question filtrée est tracée dans les avertissements et visible dans le tableau de fin de vague (L52/t2)', async () => {
    const none: Handler = () => claudeOut(workReport({ questions: ['', 'Aucune question.', 'No questions'] }));
    const h = harness({ script: { implement: [none], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.warnings).toContain('question ignorée (non-question) : « Aucune question. »');
    expect(c.lot.warnings).toContain('question ignorée (non-question) : « No questions »');
    expect(c.lot.warnings.filter((w) => w.startsWith('question ignorée'))).toHaveLength(2);
    expect(renderTable({ id: 'w1', created: '2026-10-07T10:00:00Z', cwd: '/x', budget: 2_000_000, consumed: 0, cacheRead: 0, status: 'done', pid: 1, lots: ['demo:L1'] }, [c.lot]).join('\n')).toContain('⚠ question ignorée (non-question) : « Aucune question. »');
  });

  it('une vraie question n\'est pas tracée comme ignorée (L52/t2)', async () => {
    const ask: Handler = () => claudeOut(workReport({ questions: ['Aucune autre question', 'No question except SQLite?'] }));
    const h = harness({ script: { implement: [ask] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.questions).toEqual(['No question except SQLite?']);
    expect(c.lot.warnings.filter((w) => w.startsWith('question ignorée'))).toEqual(['question ignorée (non-question) : « Aucune autre question »']);
  });

  it('une vraie question mêlée à des non-questions arrête le lot, seule la vraie est gardée (L52)', async () => {
    const ask: Handler = () => claudeOut(workReport({ questions: ['Aucune autre question', 'PostgreSQL ou SQLite ?'] }));
    const h = harness({ script: { implement: [ask] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('question');
    expect(c.lot.questions).toEqual(['PostgreSQL ou SQLite ?']);
  });

  it('une question arrête le lot ; la réponse relance l\'étape dans une session neuve', async () => {
    const ask: Handler = () => claudeOut(workReport({ questions: ['PostgreSQL ou SQLite ?'] }));
    const h = harness({ script: { implement: [ask, impl()], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('question');
    expect(c.lot.questions).toEqual(['PostgreSQL ou SQLite ?']);
    await runLot(c); // sans réponse : rien ne se relance
    expect(h.calls).toHaveLength(1);
    c.lot.pendingAnswer = 'SQLite';
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'implement', 'review']);
    expect(h.calls[1].brief).toContain('Answer from the human to your earlier question: SQLite');
    expect(c.lot.status).toBe('ready');
  });

  it('session muette (code ≠ 0) : échec nommé, pas de nouvel essai', async () => {
    const h = harness({ script: { implement: [() => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false })] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(c.lot.outcome).toMatch(/implement sans résultat/);
    expect(h.calls).toHaveLength(1);
    expect(readFileSync(join(h.store.dir, 'demo--L1', '1-implement.err'), 'utf8')).toBe('boom');
  });

  it('délai dépassé', async () => {
    const h = harness({ script: { implement: [() => ({ code: 0, stdout: '', stderr: '', timedOut: true })] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.outcome).toMatch(/délai dépassé/);
  });

  it('sorties de Playwright MCP écrites dans le dépôt (L50) : pas un dépôt sale, nettoyées à la fin du lot', async () => {
    const pw: Handler = (call) => {
      const c = commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a');
      mkdirSync(join(call.opts.cwd, '.playwright-mcp'), { recursive: true });
      writeFileSync(join(call.opts.cwd, '.playwright-mcp/page-1.yml'), 'x');
      writeFileSync(join(call.opts.cwd, '.playwright-mcp/shot.png'), 'x');
      return claudeOut(workReport({ commits: [c] }));
    };
    const h = harness({ script: { implement: [pw], review: [ok] } });
    installPrePush(h.repo, 'w1');
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(existsSync(join(h.repo, '.playwright-mcp'))).toBe(false);
  });

  it('dépôt sale après une session : rendu au lead, fichiers listés, rien n\'est commité ni jeté', async () => {
    const dirty: Handler = (call) => {
      const c = commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a');
      writeFileSync(join(call.opts.cwd, 'a.txt'), 'modifié après');
      writeFileSync(join(call.opts.cwd, 'oublie.txt'), 'x');
      return claudeOut(workReport({ commits: [c] }));
    };
    const h = harness({ script: { implement: [dirty] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('a.txt');
    expect(c.lot.outcome).toContain('oublie.txt');
    expect(readFileSync(join(h.repo, 'oublie.txt'), 'utf8')).toBe('x');
  });

  it('commit qui ne cite pas le lot : signalé, le lot continue ; commit annoncé introuvable : signalé', async () => {
    const stray: Handler = (call) => {
      const a = commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a');
      commitFile(call.opts.cwd, 'z.txt', 'chore: sans lot');
      return claudeOut(workReport({ commits: [a, { sha: 'deadbee', sujet: 'fantôme' }] }));
    };
    const h = harness({ script: { implement: [stray], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.warnings.some((w) => w.includes('ne cite pas L1') && w.includes('chore: sans lot'))).toBe(true);
    expect(c.lot.warnings.some((w) => w.includes('annoncé absent de git') && w.includes('deadbee'))).toBe(true);
  });

  it('reprise : un commit d\'une session précédente du lot, cité par le rapport, n\'est pas « absent de git » (L25)', async () => {
    let earlier = { sha: '', sujet: '' };
    const resumed: Handler = (call) => {
      const b = commitFile(call.opts.cwd, 'b.txt', 'feat(L1): b');
      return claudeOut(workReport({ commits: [earlier, b, { sha: 'deadbee', sujet: 'fantôme' }] }));
    };
    const h = harness({ script: { implement: [resumed], review: [ok] } });
    earlier = commitFile(h.repo, 'a.txt', 'feat(L1): a (session précédente)');
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    const absent = c.lot.warnings.filter((w) => w.includes('annoncé absent de git'));
    expect(absent).toHaveLength(1);
    expect(absent[0]).toContain('deadbee');
  });

  it('un commit annoncé hors plage, existant mais étranger au lot : « n\'appartient pas au lot », pas « absent de git » (L27)', async () => {
    let foreign = { sha: '', sujet: '' };
    const h0: Handler = (call) => {
      const b = commitFile(call.opts.cwd, 'b.txt', 'feat(L1): b');
      return claudeOut(workReport({ commits: [foreign, b] }));
    };
    const h = harness({ script: { implement: [h0], review: [ok] } });
    foreign = commitFile(h.repo, 'x.txt', 'feat(L9): autre lot');
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.warnings.filter((w) => w.includes('annoncé absent de git'))).toHaveLength(0);
    const foreignW = c.lot.warnings.filter((w) => w.includes("commit annoncé n'appartient pas à L1"));
    expect(foreignW).toHaveLength(1);
    expect(foreignW[0]).toContain('autre lot');
  });

  it('un commit de plan du lot (« plan: … L1 »), cité en reprise hors plage, n\'est pas signalé étranger au lot (L29)', async () => {
    let planned = { sha: '', sujet: '' };
    const h0: Handler = (call) => {
      const b = commitFile(call.opts.cwd, 'b.txt', 'feat(L1): b');
      return claudeOut(workReport({ commits: [planned, b] }));
    };
    const h = harness({ script: { implement: [h0], review: [ok] } });
    const planFile = join(h.repo, 'docs/plan/raf.yaml');
    writeFileSync(planFile, `${readFileSync(planFile, 'utf8')}# note\n`);
    git(h.repo, 'add', '--', 'docs/plan/raf.yaml');
    git(h.repo, 'commit', '-q', '-m', 'plan: L1 démarré', '--', 'docs/plan/raf.yaml');
    planned = { sha: git(h.repo, 'rev-parse', 'HEAD'), sujet: 'plan: L1 démarré' };
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.warnings.filter((w) => w.includes("n'appartient pas") || w.includes('absent de git'))).toHaveLength(0);
  });

  it('implémentation sans aucun commit : rendu au lead', async () => {
    const h = harness({ script: { implement: [() => claudeOut(workReport())] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toBe('implement sans commit');
  });

  it("après une réponse, une implémentation sans nouveau commit alors que le lot a déjà ses commits passe à la revue (L28)", async () => {
    const ask: Handler = (call) => {
      const a = commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a');
      return claudeOut(workReport({ commits: [a], questions: ['SQLite ?'] }));
    };
    const h = harness({ script: { implement: [ask, () => claudeOut(workReport())], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('question');
    c.lot.pendingAnswer = 'oui';
    c.lot.answers.push('oui');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'implement', 'review']);
    expect(c.lot.status).toBe('ready');
  });

  it("la garde alreadyDone qui passe à la revue sans nouveau commit le signale dans warnings (L29)", async () => {
    const ask: Handler = (call) => {
      const a = commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a');
      return claudeOut(workReport({ commits: [a], questions: ['SQLite ?'] }));
    };
    const h = harness({ script: { implement: [ask, () => claudeOut(workReport())], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.warnings.filter((w) => w.includes('sans nouveau commit'))).toHaveLength(0);
    c.lot.pendingAnswer = 'oui';
    c.lot.answers.push('oui');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.warnings.filter((w) => w.includes('sans nouveau commit'))).toHaveLength(1);
  });

  it('une implémentation sans nouveau commit sur un lot déjà commité passe à la revue, sans réponse du lead (L53)', async () => {
    const h = harness({ script: { implement: [() => claudeOut(workReport())], review: [ok] } });
    commitFile(h.repo, 'a.txt', 'feat(L1): a');
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.warnings.filter((w) => w.includes('sans nouveau commit'))).toHaveLength(1);
  });

  it("après une réponse, une implémentation sans commit alors que le lot n'a aucun commit reste rendue au lead (L28)", async () => {
    const ask: Handler = () => claudeOut(workReport({ questions: ['SQLite ?'] }));
    const h = harness({ script: { implement: [ask, () => claudeOut(workReport())] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('question');
    c.lot.pendingAnswer = 'oui';
    c.lot.answers.push('oui');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'implement']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toBe('implement sans commit');
  });

  it('une correction sans nouveau commit sur un lot déjà commité enchaîne sur une revue neuve, avec avertissement (L56)', async () => {
    const h = harness({ script: { implement: [impl()], review: [major, ok], fix: [() => claudeOut(workReport())] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.pass).toBe(1);
    expect(c.lot.warnings).toContain('fix sans nouveau commit : revue lancée sur les commits du lot');
  });

  it('deux corrections sans commit de suite : le plafond de passes est atteint, rendu au lead (L56)', async () => {
    const h = harness({ script: { implement: [impl()], review: [major, major, major], fix: [() => claudeOut(workReport()), () => claudeOut(workReport())] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('après 2 passe(s) de correction');
  });

  it('une correction sans commit sur un lot sans aucun commit reste rendue au lead (L56)', async () => {
    const h = harness({ script: { fix: [() => claudeOut(workReport())] } });
    const c = h.lot('L1');
    c.lot.next = 'fix';
    c.lot.pass = 1;
    c.lot.constats = [{ source: 'code', gravite: 'majeur', texte: 'bug nommé' }];
    await runLot(c);
    expect(kinds(h)).toEqual(['fix']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toBe('fix sans commit');
  });

  it('une revue qui modifie le dépôt : incident, vague arrêtée, rien enregistré', async () => {
    const touchy: Handler = (call) => {
      commitFile(call.opts.cwd, 'intrus.txt', 'fix(L1): la revue a corrigé');
      return claudeOut(reviewReport());
    };
    const h = harness({ script: { implement: [impl()], review: [touchy] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(h.wave.incident).toMatch(/a modifié le dépôt/);
    expect(h.plan().lot('L1').review).toBeUndefined();
  });

  it('un push (même contourné) arrête la vague', async () => {
    const pushy: Handler = (call) => {
      const c = commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a');
      git(call.opts.cwd, 'push', '-q'); // le hook n'est pas posé dans ce test unitaire : le contrôle d'après-session le voit
      return claudeOut(workReport({ commits: [c] }));
    };
    const h = harness({ script: { implement: [pushy] } });
    const bare = join(h.launch, 'origin.git');
    git(h.launch, 'init', '-q', '--bare', '-b', 'main', bare);
    git(h.repo, 'remote', 'add', 'origin', bare);
    git(h.repo, 'push', '-q', '-u', 'origin', 'main');
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(h.wave.incident).toMatch(/push détecté/);
  });

  it('une session qui supprime le hook de garde exclu de git : incident (L3/t19)', async () => {
    const killer: Handler = (call) => {
      rmSync(join(call.opts.cwd, '.githooks/pre-push'));
      return claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
    };
    const hh = harness({ script: { implement: [killer] } });
    git(hh.repo, 'config', 'core.hooksPath', '.githooks');
    installPrePush(hh.repo, 'w1');
    const c = hh.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(hh.wave.incident).toMatch(/hook pre-push de garde a été supprimé/);
  });

  it('avec le hook pre-push posé, le push de la session échoue', async () => {
    const h = harness({ script: { implement: [] } });
    const bare = join(h.launch, 'origin.git');
    git(h.launch, 'init', '-q', '--bare', '-b', 'main', bare);
    git(h.repo, 'remote', 'add', 'origin', bare);
    git(h.repo, 'push', '-q', '-u', 'origin', 'main');
    installPrePush(h.repo);
    commitFile(h.repo, 'q.txt', 'feat(L1): q');
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('sh', ['-c', 'git push'], { cwd: h.repo, env: { ...process.env, CADENCE_ORCHESTRATED: 'w1' }, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
  });
});

describe('budget et quota', () => {
  it('le budget atteint empêche toute nouvelle session ; la reprise continue à l\'étape suivante', async () => {
    const h = harness({ budget: 1000, script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('suspended');
    expect(c.lot.outcome).toBe('budget atteint');
    expect(c.lot.next).toBe('review');
    expect(kinds(h)).toEqual(['implement']);
    h.wave.budget.limit = 10_000;
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('ready');
  });

  it('quota atteint : session interrompue, aucune autre ; pas de nouvel essai', async () => {
    const quota: Handler = () => ({ code: 1, stdout: JSON.stringify({ is_error: true, subtype: 'success', result: 'Claude AI usage limit reached|1759600000', session_id: 's', num_turns: 1, duration_ms: 1, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } }), stderr: '', timedOut: false });
    const h = harness({ script: { implement: [quota] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('suspended');
    expect(h.wave.quota.hit).toBe(true);
    expect(c.lot.steps[0].status).toBe('interrupted');
    expect(c.lot.next).toBe('implement');
    await runLot(c);
    expect(h.calls).toHaveLength(1);
  });
});

describe('reprise après coupure', () => {
  it('l\'étape interrompue est relancée entière, avec les commits déjà présents dans le brief', async () => {
    const h = harness({ script: { implement: [impl('b.txt')], review: [ok] } });
    const c = h.lot('L1');
    // état laissé par une vague coupée au milieu de l'implémentation
    const head = git(h.repo, 'rev-parse', 'HEAD');
    commitFile(h.repo, 'a.txt', 'feat(L1): a (avant la coupure)');
    c.lot.next = 'implement';
    c.lot.status = 'suspended';
    c.lot.steps.push({ n: 1, kind: 'implement', model: 'sonnet', status: 'interrupted', started: 'x', headBefore: head });
    await runLot(c);
    expect(h.calls[0].brief).toContain('A previous session was interrupted');
    expect(h.calls[0].brief).toContain('feat(L1): a (avant la coupure)');
    expect(c.lot.steps.map((s) => `${s.n}:${s.status}`)).toEqual(['1:interrupted', '2:ok', '3:ok']);
    expect(c.lot.status).toBe('ready');
  });

  it('un lot terminé n\'est jamais rejoué', async () => {
    const h = harness({ script: {} });
    const c = h.lot('L1', { status: 'ready' });
    await runLot(c);
    expect(h.calls).toHaveLength(0);
  });
});

describe('plan en lecture seule', () => {
  it('démarre avec orchestrate.start, note le verdict avec orchestrate.verdict, commite seulement les fichiers du plan', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    // le « plan » du projet est tenu par son propre outil : un script écrit dans le fichier du plan
    const planRel = 'docs/plan/raf.yaml';
    const tool = join(h.repo, 'tool.sh');
    writeFileSync(tool, `#!/bin/sh\necho "# $1 $2 $3" >> ${planRel}\n`, { mode: 0o755 });
    git(h.repo, 'add', '--', 'tool.sh');
    git(h.repo, 'commit', '-q', '-m', 'chore: outil');
    const c = h.lot('L1', { readOnlyPlan: true }, { start: './tool.sh start {lot}', verdict: './tool.sh note {lot} "revue : {verdict}"' });
    const plan = c.loadPlan;
    // le plan reste lisible par raf pour ce test (mais le cycle ne l'écrit pas : readonly simulé)
    c.loadPlan = () => {
      const p = plan();
      Object.defineProperty(p, 'readonly', { get: () => true });
      return p;
    };
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    const text = readFileSync(join(h.repo, planRel), 'utf8');
    expect(text).toContain('# start L1');
    expect(text).toContain('# note L1 revue : conforme : rien à signaler — orchestré');
    expect(git(h.repo, 'log', '--format=%s').split('\n')).toContain('plan: L1 revue de code notée (orchestrate w1)');
    expect(git(h.repo, 'status', '--porcelain')).toBe('');
  });

  it('sans orchestrate.start un lot à faire est refusé', async () => {
    const h = harness({ script: {} });
    const c = h.lot('L1', { readOnlyPlan: true });
    const plan = c.loadPlan;
    c.loadPlan = () => {
      const p = plan();
      Object.defineProperty(p, 'readonly', { get: () => true });
      return p;
    };
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toBe('plan en lecture seule : démarrer le lot avec l\'outil du projet');
    expect(h.calls).toHaveLength(0);
  });

  it('une commande du projet qui touche un autre fichier que le plan arrête le lot, arbre sale', async () => {
    const h = harness({ script: {} });
    writeFileSync(join(h.repo, 'src.txt'), 'x');
    git(h.repo, 'add', '--', 'src.txt');
    git(h.repo, 'commit', '-q', '-m', 'chore: src');
    const c = h.lot('L1', { readOnlyPlan: true }, { start: 'echo y >> src.txt' });
    const plan = c.loadPlan;
    c.loadPlan = () => {
      const p = plan();
      Object.defineProperty(p, 'readonly', { get: () => true });
      return p;
    };
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/arbre sale \(fichiers hors plan\) : src\.txt/);
  });

  it('(L65/t1) un fichier d\'attendus QA et un plan.files modifiés au démarrage sont commités avec le plan ; un fichier étranger arrête toujours le lot', async () => {
    const setup = (start: string) => {
      const h = harness({ script: { implement: [impl()], review: [ok] } });
      mkdirSync(join(h.repo, 'docs/qa'), { recursive: true });
      for (const f of ['docs/qa/expectations.md', 'journal.ndjson', 'src.txt']) writeFileSync(join(h.repo, f), 'v0\n');
      git(h.repo, 'add', '--', 'docs/qa/expectations.md', 'journal.ndjson', 'src.txt');
      git(h.repo, 'commit', '-q', '-m', 'chore: fichiers');
      const c = h.lot('L1', { readOnlyPlan: true }, { start });
      c.loadPlan = () => {
        const p = Plan.load(join(h.repo, 'docs/plan/raf.yaml'), { files: ['journal.ndjson'] });
        Object.defineProperty(p, 'readonly', { get: () => true });
        return p;
      };
      return { h, c };
    };
    const ok1 = setup('echo v1 >> docs/qa/expectations.md && echo v1 >> journal.ndjson');
    await runLot(ok1.c);
    expect(ok1.c.lot.outcome ?? '').not.toMatch(/arbre sale/);
    expect(ok1.c.lot.status).toBe('ready');
    const first = git(ok1.h.repo, 'log', '--format=%s', '--grep=démarré').split('\n')[0];
    expect(first).toBe('plan: L1 démarré (orchestrate w1)');
    expect(git(ok1.h.repo, 'show', '--name-only', '--format=', '--grep=démarré', '-n1')).toBe('docs/qa/expectations.md\njournal.ndjson');
    expect(git(ok1.h.repo, 'status', '--porcelain')).toBe('');

    const ko = setup('echo v1 >> docs/qa/expectations.md && echo v1 >> src.txt');
    await runLot(ko.c);
    expect(ko.c.lot.status).toBe('handed-back');
    expect(ko.c.lot.outcome).toMatch(/arbre sale \(fichiers hors plan\) : src\.txt/);
  });
});

describe('tokens des sessions en échec (L3/t11)', () => {
  const usage = { input_tokens: 7, cache_creation_input_tokens: 200, cache_read_input_tokens: 9000, output_tokens: 30 };
  const failedOut = (over: Record<string, unknown>, code = 0) => ({ code, stdout: JSON.stringify({ is_error: true, subtype: 'error_during_execution', result: 'boom', session_id: 's-ko', num_turns: 1, duration_ms: 1, usage, ...over }), stderr: '', timedOut: false });

  it('is_error : les tokens de la sortie vont au budget', async () => {
    const h = harness({ script: { implement: [() => failedOut({})] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(h.wave.budget.consumed).toBe(237);
    expect(h.wave.budget.cacheRead).toBe(9000);
    expect(c.lot.steps[0].tokens?.counted).toBe(237);
  });

  it('code de sortie non nul avec une sortie lisible : comptés', async () => {
    const good = claudeOut(workReport(), { input: 5, cacheWrite: 50, cacheRead: 0, output: 5 });
    const h = harness({ script: { implement: [() => ({ ...good, code: 3 })] } });
    await runLot(h.lot('L1'));
    expect(h.wave.budget.consumed).toBe(60);
  });

  it('quota atteint : comptés', async () => {
    const h = harness({ script: { implement: [() => failedOut({ subtype: 'success', result: 'Claude AI usage limit reached|1759600000' }, 1)] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('suspended');
    expect(h.wave.budget.consumed).toBe(237);
  });

  it('délai dépassé (rien sur la sortie) : relus dans le journal de SA session (--session-id), jamais celui d\'une autre conversation du dossier', async () => {
    let id = '';
    const h = harness({ script: { implement: [(call) => {
      id = call.args[call.args.indexOf('--session-id') + 1];
      const dir = projectLogDir(h.wave.claudeHome!, call.opts.cwd);
      mkdirSync(dir, { recursive: true });
      const line = (mid: string, i: number, w: number, r: number, o: number) => JSON.stringify({ type: 'assistant', message: { id: mid, usage: { input_tokens: i, cache_creation_input_tokens: w, cache_read_input_tokens: r, output_tokens: o } } });
      // le même message écrit sur deux lignes ne compte qu'une fois
      writeFileSync(join(dir, `${id}.jsonl`), [line('m1', 10, 100, 0, 5), line('m1', 10, 100, 0, 5), line('m2', 4, 20, 110, 6)].join('\n'));
      // une autre conversation du même dossier (celle du lead), plus récente et énorme
      writeFileSync(join(dir, 'autre-conversation.jsonl'), line('x1', 45_000_000, 0, 0, 0));
      return { code: 0, stdout: '', stderr: '', timedOut: true };
    }] } });
    h.wave.claudeHome = tempDir();
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.outcome).toMatch(/délai dépassé/);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.lot.steps[0].sessionId).toBe(id);
    expect(h.wave.budget.consumed).toBe(10 + 100 + 5 + 4 + 20 + 6);
    expect(h.wave.budget.cacheRead).toBe(110);
    expect(c.lot.steps[0].peakContext).toBe(134);
  });

  it('délai dépassé sans journal de la session : rien n\'est compté, aucune autre session devinée', async () => {
    const h = harness({ script: { implement: [(call) => {
      const dir = projectLogDir(h.wave.claudeHome!, call.opts.cwd);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'autre.jsonl'), JSON.stringify({ type: 'assistant', message: { id: 'x', usage: { input_tokens: 999, output_tokens: 1 } } }));
      return { code: 0, stdout: '', stderr: '', timedOut: true };
    }] } });
    h.wave.claudeHome = tempDir();
    await runLot(h.lot('L1'));
    expect(h.wave.budget.consumed).toBe(0);
  });
});

describe('lot non démarré quand la vague est arrêtée (L3/t14)', () => {
  const cases: [string, (h: ReturnType<typeof harness>) => void, string][] = [
    ['budget épuisé', (h) => { h.wave.budget.consumed = h.wave.budget.limit; }, 'budget atteint'],
    ['quota atteint', (h) => { h.wave.quota = { hit: true }; }, 'quota atteint'],
    ['incident', (h) => { h.wave.incident = 'push détecté'; }, 'vague arrêtée : push détecté'],
  ];
  for (const [name, arm, why] of cases) {
    it(`${name} : ni raf start ni commit du plan, le lot reste à faire et suspendu`, async () => {
      const h = harness({ script: {} });
      arm(h);
      const head = git(h.repo, 'rev-parse', 'HEAD');
      const c = h.lot('L1');
      await runLot(c);
      expect(c.lot.status).toBe('suspended');
      expect(c.lot.outcome).toBe(why);
      expect(h.plan().lot('L1').status).toBe('todo');
      expect(git(h.repo, 'rev-parse', 'HEAD')).toBe(head);
      expect(h.calls).toEqual([]);
    });
  }
});

describe('commande orchestrate.test asynchrone (L3/t16)', () => {
  it('la boucle d\'événements reste libre pendant la commande de tests', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'sleep 1' });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    await runLot(c);
    clearInterval(timer);
    expect(c.lot.status).toBe('ready');
    expect(ticks).toBeGreaterThanOrEqual(10); // spawnSync bloquait : un seul tour, après la commande
  });
});

const minorFinding = { gravite: 'mineur', fichier: 'a.txt', ligne: 1, texte: 'nommage' };
const minorReview = (over: Record<string, unknown> = {}): Handler => () => claudeOut(reviewReport({ mineurs: 1, constats: [minorFinding], ...over }));

describe('passe des mineurs (L38/t1)', () => {
  it('sans commit (mineur jugé faux) : le lot conclut sur la revue conforme d\'origine, mineurs en propositions, choix gardé', async () => {
    const rejected: Handler = () => claudeOut(workReport({ choix: ['mineur « nommage » refusé : le nom suit la convention du module'] }));
    const h = harness({ script: { implement: [impl()], review: [minorReview()], fix: [rejected] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.outcome).toBe('prêt à livrer');
    expect(c.lot.proposals).toEqual(['[mineur code] a.txt:1 — nommage']);
    expect(c.lot.choix).toEqual(['mineur « nommage » refusé : le nom suit la convention du module']);
    expect(c.lot.minorFix).toBeFalsy();
    const lot = h.plan().lot('L1');
    expect(lot.review?.verdict).toContain('passe des mineurs sans commit');
    expect(lot.review?.commit).toBe(git(h.repo, 'log', '--format=%H', '--grep=feat(L1)', '-1'));
    expect(c.lot.warnings).toEqual([expect.stringContaining('passe des mineurs sans commit')]);
    expect(git(h.repo, 'status', '--porcelain')).toBe('');
  });

  it('question posée par la passe des mineurs sans commit : le lot conclut quand même, la question est rendue en proposition', async () => {
    const ask: Handler = () => claudeOut(workReport({ questions: ['Le mineur « nommage » est faux, on le garde ?'] }));
    const h = harness({ script: { implement: [impl()], review: [minorReview()], fix: [ask] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.questions).toEqual([]);
    expect(c.lot.proposals).toContain('[question passe des mineurs] Le mineur « nommage » est faux, on le garde ?');
    expect(c.lot.proposals).toContain('[mineur code] a.txt:1 — nommage');
  });

  it('la passe a son propre brief : pas de « stop and report the question », les mineurs refusés vont en choix ; la revue courte relit ces choix', async () => {
    const partly: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'b.txt', 'fix(L1): b')], choix: ['mineur « autre » refusé : hors périmètre'] }));
    const h = harness({ script: { implement: [impl()], review: [minorReview()], fix: [partly], 'review-small': [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review-small']);
    const brief = h.calls[2].brief;
    expect(brief).toContain('found only minor findings');
    expect(brief).toContain('[mineur] a.txt:1 — nommage');
    expect(brief).toContain('Do not stop to ask');
    expect(brief).not.toContain('stop and report the question');
    expect(h.calls[3].brief).toContain('- mineur « autre » refusé : hors périmètre');
    expect(c.lot.status).toBe('ready');
    expect(c.lot.choix).toEqual(['mineur « autre » refusé : hors périmètre']);
  });

  it('dépôt sale après la passe des mineurs : rendu au lead (rien n\'est conclu sur du travail non commité)', async () => {
    const dirty: Handler = (call) => {
      writeFileSync(join(call.opts.cwd, 'a.txt'), 'modifié\n');
      return claudeOut(workReport());
    };
    const h = harness({ script: { implement: [impl()], review: [minorReview()], fix: [dirty] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(h.plan().lot('L1').review).toBeUndefined();
  });

  it('tests rouges après la passe des mineurs : correction de défauts avec le brief des défauts, pas celui des mineurs', async () => {
    const red: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'b.txt', 'fix(L1): b')], tests: { commande: 'npm test', resultat: '1 failed', vert: false } }));
    const h = harness({ script: { implement: [impl()], review: [minorReview()], fix: [red, fix('c.txt')], 'review-small': [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'fix', 'review-small']);
    expect(h.calls[2].brief).toContain('found only minor findings');
    expect(h.calls[3].brief).toContain('found the defects below');
    expect(c.lot.pass).toBe(1);
    expect(c.lot.status).toBe('ready');
  });
});

describe('lot visible et passe des mineurs (L38/t2)', () => {
  const uxOk: Handler = () => claudeOut(reviewReport({ verdict: 'ergonomie conforme (UX)' }));
  const withUx = { ux: { url: 'http://localhost:4200' } };

  it('le verdict de l\'agent UX n\'est pas écrasé par la revue courte ; l\'UX est rejouée après la passe des mineurs', async () => {
    const h = harness({
      lots: [{ title: 'Écran', visible: true }],
      script: { implement: [impl()], ux: [uxOk, uxOk], review: [minorReview({ verdict: 'code conforme avec un mineur' })], fix: [fix('b.txt')], 'review-small': [() => claudeOut(reviewReport({ verdict: 'relecture courte conforme' }))] },
    });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'ux', 'review', 'fix', 'ux', 'review-small']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.uxVerdict).toBe('ergonomie conforme (UX)');
    expect(c.lot.ux?.verdict).toBe('ergonomie conforme (UX)');
    expect(c.lot.code?.verdict).toBe('relecture courte conforme');
    expect(h.calls[5].brief).toContain('short re-review');
  });

  it('UX rejouée après une correction de défaut, même quand elle était conforme avant', async () => {
    const h = harness({
      lots: [{ title: 'Écran', visible: true }],
      script: { implement: [impl()], ux: [uxOk, uxOk], review: [major, ok], fix: [fix('b.txt')] },
    });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'ux', 'review', 'fix', 'ux', 'review']);
    expect(c.lot.status).toBe('ready');
  });

  it('une UX non conforme après la passe des mineurs mène à une correction de défaut, pas à un verdict', async () => {
    const uxBad: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'ui.css', texte: 'contraste 2:1 (WCAG 1.4.3)' }], verdict: 'UX non conforme' }));
    const h = harness({
      lots: [{ title: 'Écran', visible: true }],
      script: { implement: [impl()], ux: [uxOk, uxBad, uxOk], review: [minorReview()], fix: [fix('b.txt'), fix('c.txt')], 'review-small': [ok, ok] },
    });
    const c = h.lot('L1', { visible: true }, withUx);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'ux', 'review', 'fix', 'ux', 'review-small', 'fix', 'ux', 'review-small']);
    expect(h.calls[6].brief).toContain('contraste 2:1 (WCAG 1.4.3)');
    expect(c.lot.pass).toBe(1);
    expect(c.lot.status).toBe('ready');
  });

  it('petit lot visible : la passe unique porte toujours le verdict d\'ergonomie, y compris après la passe des mineurs', async () => {
    const h = harness({
      lots: [{ title: 'petit', estimate: 0.5, visible: true }],
      script: { implement: [impl()], 'review-small': [minorReview({ verdict: 'passe unique' }), () => claudeOut(reviewReport({ verdict: 'passe unique 2' }))], fix: [fix('b.txt')] },
    });
    const c = h.lot('L1', { small: true, visible: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review-small', 'fix', 'review-small']);
    expect(h.calls[3].brief).toContain('single pass');
    expect(c.lot.uxVerdict).toBe('passe unique 2');
  });
});

const quotaOut = () => ({ code: 1, stdout: JSON.stringify({ is_error: true, subtype: 'success', result: 'Claude AI usage limit reached|1759600000', session_id: 's', num_turns: 1, duration_ms: 1, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } }), stderr: '', timedOut: false });

describe('passe des mineurs interrompue puis reprise (L38/t6)', () => {
  it('commit de la passe puis quota ; la session neuve ne trouve plus rien : le commit est relu par la revue courte, pas rendu au lead', async () => {
    const commitThenQuota: Handler = (call) => {
      commitFile(call.opts.cwd, 'b.txt', 'fix(L1): nommage');
      return quotaOut();
    };
    const nothingLeft: Handler = () => claudeOut(workReport({ choix: ['rien à corriger de plus'] }));
    const h = harness({ script: { implement: [impl()], review: [minorReview()], fix: [commitThenQuota, nothingLeft], 'review-small': [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('suspended');
    expect(c.lot.minorFix).toBe(true);
    h.wave.quota = { hit: false };
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'fix', 'review-small']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.outcome).toBe('prêt à livrer');
    const lot = h.plan().lot('L1');
    expect(lot.review?.verdict).toContain('orchestré');
    expect(lot.review?.commit).toBe(git(h.repo, 'log', '--format=%H', '--grep=fix(L1)', '-1'));
    expect(c.lot.proposals).toEqual([]);
  });

  it('reprise sans commit et HEAD inchangé depuis la revue conforme : conclusion sur la revue d\'origine (comportement t1 gardé)', async () => {
    const quotaOnly: Handler = () => quotaOut();
    const rejected: Handler = () => claudeOut(workReport({ choix: ['mineur refusé'] }));
    const h = harness({ script: { implement: [impl()], review: [minorReview()], fix: [quotaOnly, rejected] } });
    const c = h.lot('L1');
    await runLot(c);
    h.wave.quota = { hit: false };
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'fix']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.proposals).toEqual(['[mineur code] a.txt:1 — nommage']);
  });
});

describe('propositions : seul ce qui reste non traité (L38/t7)', () => {
  const stillMinor = { gravite: 'mineur', fichier: 'a.txt', ligne: 1, texte: 'nommage' };

  it('mineur d\'une revue non conforme, corrigé ensuite par la passe des mineurs : il ne reste pas en proposition', async () => {
    const review1: Handler = () => claudeOut(reviewReport({ majeurs: 1, mineurs: 1, verdict: 'non conforme', constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 3, texte: 'bug nommé' }, stillMinor] }));
    const h = harness({ script: { implement: [impl()], review: [review1, minorReview()], fix: [fix('b.txt'), fix('c.txt')], 'review-small': [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review-small']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.proposals).toEqual([]);
  });

  it('mineur proposé par la revue non conforme, repris par la revue conforme à une autre ligne : traité par la passe, il ne reste pas en proposition', async () => {
    const review1: Handler = () => claudeOut(reviewReport({ majeurs: 1, mineurs: 1, verdict: 'non conforme', constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 3, texte: 'bug nommé' }, stillMinor] }));
    const shifted: Handler = () => claudeOut(reviewReport({ mineurs: 1, verdict: 'conforme avec mineurs', constats: [{ ...stillMinor, ligne: 7 }] }));
    const h = harness({ script: { implement: [impl()], review: [review1, shifted], fix: [fix('b.txt'), fix('c.txt')], 'review-small': [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review-small']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.proposals).toEqual([]);
  });

  it('deux mineurs de même fichier et même texte à deux lignes : le traité ne retire pas l\'autre, qui reste en proposition', async () => {
    const review1: Handler = () => claudeOut(reviewReport({ majeurs: 1, mineurs: 2, verdict: 'non conforme', constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 3, texte: 'bug nommé' }, { ...stillMinor, ligne: 1 }, { ...stillMinor, ligne: 9 }] }));
    // La revue conforme ne signale plus que celui de la ligne 1 : celui de la ligne 9 n'est pas confié à la passe.
    const only1: Handler = () => claudeOut(reviewReport({ mineurs: 1, verdict: 'conforme avec mineurs', constats: [{ ...stillMinor, ligne: 1 }] }));
    const h = harness({ script: { implement: [impl()], review: [review1, only1], fix: [fix('b.txt'), fix('c.txt')], 'review-small': [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.proposals).toEqual(['[mineur code] a.txt:9 — nommage']);
  });

  it('mineur reformulé par la revue conforme : non reconnu, il reste en proposition (limite connue, côté prudent)', async () => {
    const review1: Handler = () => claudeOut(reviewReport({ majeurs: 1, mineurs: 1, verdict: 'non conforme', constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 3, texte: 'bug nommé' }, stillMinor] }));
    const reworded: Handler = () => claudeOut(reviewReport({ mineurs: 1, verdict: 'conforme avec mineurs', constats: [{ ...stillMinor, texte: 'nom peu clair' }] }));
    const h = harness({ script: { implement: [impl()], review: [review1, reworded], fix: [fix('b.txt'), fix('c.txt')], 'review-small': [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.proposals).toEqual(['[mineur code] a.txt:1 — nommage']);
  });

  it('mineur traité mais que la revue courte signale encore : il reste en proposition', async () => {
    const review1: Handler = () => claudeOut(reviewReport({ majeurs: 1, mineurs: 1, verdict: 'non conforme', constats: [{ gravite: 'majeur', texte: 'bug nommé' }, stillMinor] }));
    const h = harness({ script: { implement: [impl()], review: [review1, minorReview()], fix: [fix('b.txt'), fix('c.txt')], 'review-small': [minorReview()] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.proposals).toEqual(['[mineur code] a.txt:1 — nommage']);
  });

  it('passe des mineurs refusée (sans commit) : le mineur d\'une revue non conforme reste en proposition', async () => {
    const review1: Handler = () => claudeOut(reviewReport({ majeurs: 1, mineurs: 1, verdict: 'non conforme', constats: [{ gravite: 'majeur', texte: 'bug nommé' }, stillMinor] }));
    const rejected: Handler = () => claudeOut(workReport({ choix: ['mineur refusé'] }));
    const h = harness({ script: { implement: [impl()], review: [review1, minorReview()], fix: [fix('b.txt'), rejected] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.proposals).toEqual(['[mineur code] a.txt:1 — nommage']);
  });
});

describe('correction ordinaire interrompue puis reprise (L40)', () => {
  it('commit de la correction puis quota ; la session neuve ne trouve plus rien : le commit est relu, pas rendu au lead', async () => {
    const commitThenQuota: Handler = (call) => {
      commitFile(call.opts.cwd, 'b.txt', 'fix(L1): bug nommé');
      return quotaOut();
    };
    const nothingLeft: Handler = () => claudeOut(workReport({ choix: ['rien à corriger de plus'] }));
    const h = harness({ script: { implement: [impl()], review: [major, ok], fix: [commitThenQuota, nothingLeft] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('suspended');
    h.wave.quota = { hit: false };
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'fix', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(h.plan().lot('L1').review?.commit).toBe(git(h.repo, 'log', '--format=%H', '--grep=fix(L1)', '-1'));
  });

  it('tests rouges juste après l\'implémentation (aucune revue encore) : le commit de la correction coupée est relu', async () => {
    const commitThenQuota: Handler = (call) => {
      commitFile(call.opts.cwd, 'b.txt', 'fix(L1): bug nommé');
      return quotaOut();
    };
    const nothingLeft: Handler = () => claudeOut(workReport({ choix: ['rien à corriger de plus'] }));
    const h = harness({ script: { implement: [impl()], fix: [commitThenQuota, nothingLeft], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'test -f b.txt' });
    await runLot(c);
    expect(c.lot.status).toBe('suspended');
    h.wave.quota = { hit: false };
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'fix', 'review']);
    expect(c.lot.status).toBe('ready');
  });

  it('deux passes sans coupure : la seconde sans commit relance une revue (lot commité), jamais prise pour une reprise (L56)', async () => {
    const nothing: Handler = () => claudeOut(workReport());
    // La 1re correction commite mais annonce ses tests rouges : le lot repart en correction, la 2e passe n'a rien à ajouter.
    const redFix: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'b.txt', 'fix(L1): b')], tests: { commande: 'npm test', resultat: '1 failed', vert: false } }));
    const h = harness({ script: { implement: [impl()], review: [major, ok], fix: [redFix, nothing] } });
    const c = h.lot('L1', {}, { test: 'test -f a.txt' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'fix', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.warnings.join('\n')).not.toContain('reprise sans nouveau commit');
    expect(c.lot.warnings).toContain('fix sans nouveau commit : revue lancée sur les commits du lot');
  });
});

describe('brief de la revue courte (L38/t3)', () => {
  it('lot non visible : revue courte de code, ni « This lot is small » ni revue d\'ergonomie', async () => {
    const h = harness({ script: { implement: [impl()], review: [minorReview()], fix: [fix('b.txt')], 'review-small': [ok] } });
    await runLot(h.lot('L1', {}, { ux: { command: 'npm start' } }));
    const brief = h.calls[3].brief;
    expect(brief).toContain('short re-review');
    expect(brief).not.toContain('This lot is small');
    expect(brief).not.toContain('usability');
    expect(brief).not.toContain('Start the app');
  });

  it('petit lot non visible : une revue de code ordinaire (pas de revue d\'ergonomie annoncée)', async () => {
    const h = harness({ lots: [{ title: 'petit', estimate: 0.5 }], script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', { small: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(h.calls[1].brief).not.toContain('usability');
    expect(c.lot.status).toBe('ready');
  });
});

describe('budget épuisé après une revue conforme avec mineurs (L38/t4)', () => {
  it('le lot conclut sur la revue conforme (prêt, verdict enregistré), mineurs en propositions, au lieu de rester suspendu', async () => {
    const h = harness({ budget: 3000, script: { implement: [impl()], review: [minorReview()] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(h.wave.budget.exhausted).toBe(true);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.proposals).toEqual(['[mineur code] a.txt:1 — nommage']);
    expect(c.lot.warnings.join('\n')).toContain('passe des mineurs');
    const lot = h.plan().lot('L1');
    expect(lot.review?.verdict).toContain('orchestré');
    expect(lot.review?.verdict).not.toContain('passe des mineurs');
    expect(lot.review?.commit).toBe(git(h.repo, 'log', '--format=%H', '--grep=feat(L1)', '-1'));
  });
});

describe('gabarits : instantané de la vague (L39)', () => {
  it('un gabarit modifié (ou cassé) pendant la vague ne change pas les briefs de cette vague', async () => {
    const dir = tempDir();
    cpSync(TEMPLATES_DIR, dir, { recursive: true });
    const edit: Handler = (call) => {
      // le lot modifie templates/orchestrate pendant la vague : nouveau nom de variable, gabarit supprimé
      writeFileSync(join(dir, 'review.md'), 'Nouveau gabarit {{variable_inconnue}}\n');
      rmSync(join(dir, 'fix.md'));
      return impl()(call);
    };
    const h = harness({ templatesDir: dir, script: { implement: [edit], review: [major, ok], fix: [fix('b.txt')] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review']);
    for (const call of h.calls.filter((k) => k.kind === 'review')) {
      expect(call.brief).toContain('Review lot `L1`');
      expect(call.brief).not.toContain('Nouveau gabarit');
    }
    expect(h.calls[2].brief).toContain('found the defects below');
  });
});

describe('lot déjà commité : implement tourne toujours (L53)', () => {
  it('commit de spec seul, sans revue : implement tourne', async () => {
    const h = harness({ script: { implement: [impl('b.txt')], review: [ok] } });
    commitFile(h.repo, 'a.txt', 'docs(L1): spec');
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.warnings).toEqual([]);
  });

  it('plan en lecture seule (aucun champ review) et lot commité : implement tourne', async () => {
    const h = harness({ script: { implement: [impl('b.txt')], review: [ok] } });
    commitFile(h.repo, 'a.txt', 'docs(L1): spec');
    const c = h.lot('L1', { readOnlyPlan: true }, { start: 'true' });
    const plan = c.loadPlan;
    c.loadPlan = () => {
      const p = plan();
      Object.defineProperty(p, 'readonly', { get: () => true });
      return p;
    };
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('ready');
  });

  it('vague interrompue après un 1er commit, relancée sans --resume : implement tourne', async () => {
    const h = harness({ script: { implement: [impl('b.txt')], review: [ok] } });
    commitFile(h.repo, 'a.txt', 'feat(L1): a');
    const c = h.lot('L1', { status: 'queued' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('revue non conforme plus ancienne que le dernier commit : implement tourne', async () => {
    const h = harness({ script: { implement: [impl('c.txt')], review: [ok] } });
    commitFile(h.repo, 'a.txt', 'feat(L1): a');
    recordReview(h, 'non conforme : un bug nommé');
    commitFile(h.repo, 'b.txt', 'feat(L1): b');
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('revue conforme à jour sur le dernier commit : implement tourne', async () => {
    const h = harness({ script: { implement: [impl('b.txt')], review: [ok] } });
    commitFile(h.repo, 'a.txt', 'feat(L1): a');
    recordReview(h, 'conforme : rien à signaler');
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('verdict non conforme à jour : implement tourne quand même (ses sous-tâches portent les constats)', async () => {
    const h = harness({ script: { implement: [impl('b.txt')], review: [ok] } });
    commitFile(h.repo, 'a.txt', 'feat(L1): a');
    recordReview(h, 'non conforme : un bug nommé');
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.warnings).toEqual([]);
  });

  it('lot neuf (aucun commit) : implement puis revue', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.warnings).toEqual([]);
  });
});

describe('le programme lance l\'application de la revue UX (L60)', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('prête : brief « The running app is at <url> » sans consigne de lancement, journal dans le dossier du lot, application tuée après l\'étape', async () => {
    const app = await fakeApp(200);
    const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], ux: [ok], review: [ok] } });
    let during = false;
    h.wave.claude = ((orig) => async (args: string[], o: Parameters<typeof orig>[1]) => {
      if (args.includes('ux-reviewer')) during = alive(Number(readFileSync(join(app.dir, 'pid'), 'utf8')));
      return orig(args, o);
    })(h.wave.claude);
    const c = h.lot('L1', { visible: true }, { ux: { command: app.command, url: app.url, timeout: 20 } });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'ux', 'review']);
    const brief = h.calls.find((x) => x.kind === 'ux')!.brief;
    expect(brief).toContain(`The running app is at ${app.url}`);
    expect(brief).not.toContain('Start the app');
    expect(during).toBe(true);
    expect(readFileSync(join(h.store.dir, 'demo--L1', 'ux-app.log'), 'utf8')).toContain('démarrage du faux serveur');
    expect(alive(Number(readFileSync(join(app.dir, 'pid'), 'utf8')))).toBe(false);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.uxNote).toBeUndefined();
  });

  it('L98 : le lot a un .nvmrc résolu : l\'application est lancée avec le Node du dossier de liens (faux node), comme les sessions', async () => {
    const app = await fakeApp(0);
    const link = join(app.dir, 'node-bin');
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, 'node'), `#!/bin/sh\necho "$0" > ${app.dir}/fake-node-used\nexec ${process.execPath} "$@"\n`, { mode: 0o755 });
    const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], ux: [ok], review: [ok] } });
    const c = h.lot('L1', { visible: true }, { ux: { command: app.command, url: app.url, timeout: 20 } });
    c.lot.node = { version: 'v22.1.0', wanted: '22', bin: '/inutile', link };
    await runLot(c);
    expect(readFileSync(join(app.dir, 'fake-node-used'), 'utf8').trim()).toBe(join(link, 'node'));
    expect(c.lot.uxNote).toBeUndefined();
  });

  it('jamais prête : pas de session UX, note avec la fin du journal, le lot continue vers la revue de code, jamais d\'échec', async () => {
    const app = await fakeApp(-1);
    const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', { visible: true }, { ux: { command: app.command, url: app.url, timeout: 0.8 } });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.uxNote).toMatch(/UX non vérifiée.*n'a pas répondu[\s\S]*démarrage du faux serveur/);
    expect(c.lot.status).toBe('ready');
    expect(alive(Number(readFileSync(join(app.dir, 'pid'), 'utf8')))).toBe(false);
  });

  it('revue UX non conforme puis application muette : la revue périmée est effacée, ses constats ne repartent pas en correction, le lot conclut sur la revue de code', async () => {
    const app = await fakeApp(0);
    const uxBad: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'ui.css', texte: 'contraste 2:1 (WCAG 1.4.3)' }], verdict: 'UX non conforme' }));
    const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], ux: [uxBad], review: [ok, ok], fix: [fix('b.txt')] } });
    const ux = { command: app.command, url: app.url, timeout: 20 };
    const c = h.lot('L1', { visible: true }, { ux });
    // après la passe de correction, l'application ne démarre plus
    const fixing = h.wave.claude;
    h.wave.claude = (async (args: string[], o: Parameters<typeof fixing>[1]) => {
      const r = await fixing(args, o);
      if (h.calls.some((x) => x.kind === 'fix')) ux.command = 'exit 1';
      return r;
    }) as typeof fixing;
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'ux', 'review', 'fix', 'review']);
    expect(c.lot.uxNote).toMatch(/UX non vérifiée/);
    expect(c.lot.ux).toBeUndefined();
    expect(c.lot.uxVerdict).toBeNull();
    expect(c.lot.constats.filter((k) => k.source === 'ux')).toEqual([]);
    expect(c.lot.status).toBe('ready');
  });

  it('application muette à la 1re étape UX puis prête à la 2e : la note « UX non vérifiée » de la tentative précédente est effacée, seul le verdict UX reste', async () => {
    const app = await fakeApp(0);
    const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], ux: [ok], review: [major, ok], fix: [fix('b.txt')] } });
    const ux = { command: 'exit 1', url: app.url, timeout: 20 };
    const c = h.lot('L1', { visible: true }, { ux });
    // après la passe de correction, l'application démarre
    const fixing = h.wave.claude;
    h.wave.claude = (async (args: string[], o: Parameters<typeof fixing>[1]) => {
      const r = await fixing(args, o);
      if (h.calls.some((x) => x.kind === 'fix')) ux.command = app.command;
      return r;
    }) as typeof fixing;
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'ux', 'review']);
    expect(c.lot.uxNote).toBeUndefined();
    expect(c.lot.uxVerdict).not.toBeNull();
    expect(c.lot.status).toBe('ready');
  });

  it('port déjà pris : rien n\'est lancé, « port occupé », le lot continue', async () => {
    const app = await fakeApp(0);
    const srv = createServer((_q, r) => r.end('autre')).listen(Number(new URL(app.url).port));
    await new Promise((r) => srv.once('listening', r));
    try {
      const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], review: [ok] } });
      const c = h.lot('L1', { visible: true }, { ux: { command: app.command, url: app.url, timeout: 5 } });
      await runLot(c);
      expect(kinds(h)).toEqual(['implement', 'review']);
      expect(c.lot.uxNote).toMatch(/port occupé/);
      expect(existsSync(join(app.dir, 'pid'))).toBe(false);
      expect(c.lot.status).toBe('ready');
    } finally {
      srv.close();
    }
  });

  it('vague arrêtée avant l\'étape UX (incident, quota, budget) : suspendu, l\'application n\'est pas lancée', async () => {
    const arms: [string, (h: ReturnType<typeof harness>) => void, string][] = [
      ['incident', (h) => { h.wave.incident = 'push détecté'; }, 'vague arrêtée : push détecté'],
      ['quota', (h) => { h.wave.quota = { hit: true }; }, 'quota atteint'],
      ['budget', (h) => { h.wave.budget.consumed = h.wave.budget.limit; }, 'budget atteint'],
    ];
    for (const [, arm, why] of arms) {
      const app = await fakeApp(0);
      const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], ux: [ok], review: [ok] } });
      const c = h.lot('L1', { visible: true }, { ux: { command: app.command, url: app.url, timeout: 5 } });
      const before = h.wave.claude;
      h.wave.claude = (async (args: string[], o: Parameters<typeof before>[1]) => {
        const r = await before(args, o);
        arm(h);
        return r;
      }) as typeof before;
      await runLot(c);
      expect(kinds(h)).toEqual(['implement']);
      expect(c.lot.status).toBe('suspended');
      expect(c.lot.outcome).toBe(why);
      expect(existsSync(join(app.dir, 'pid'))).toBe(false);
    }
  });

  it('étape en erreur : l\'application est tuée quand même', async () => {
    const app = await fakeApp(0);
    const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], ux: [() => ({ code: 1, stdout: '', stderr: 'boum', timedOut: false })] } });
    const c = h.lot('L1', { visible: true }, { ux: { command: app.command, url: app.url, timeout: 20 } });
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(alive(Number(readFileSync(join(app.dir, 'pid'), 'utf8')))).toBe(false);
  });

  it('petit lot visible (review-small) : même règle — brief avec l\'URL, application tuée ; port non tenu : la passe a lieu sur le code seul', async () => {
    const app = await fakeApp(0);
    const h = harness({ lots: [{ title: 'petit', estimate: 0.5, visible: true }], script: { implement: [impl()], 'review-small': [ok] } });
    const c = h.lot('L1', { small: true, visible: true }, { ux: { command: app.command, url: app.url, timeout: 20 } });
    await runLot(c);
    expect(h.calls.find((x) => x.kind === 'review-small')!.brief).toContain(`The running app is at ${app.url}`);
    expect(alive(Number(readFileSync(join(app.dir, 'pid'), 'utf8')))).toBe(false);

    const dead = await fakeApp(-1);
    const h2 = harness({ lots: [{ title: 'petit', estimate: 0.5, visible: true }], script: { implement: [impl()], 'review-small': [ok] } });
    const c2 = h2.lot('L1', { small: true, visible: true }, { ux: { command: dead.command, url: dead.url, timeout: 0.8 } });
    await runLot(c2);
    expect(kinds(h2)).toEqual(['implement', 'review-small']);
    expect(h2.calls[1].brief).toContain('could not be verified');
    expect(c2.lot.uxNote).toMatch(/UX non vérifiée/);
    expect(c2.lot.status).toBe('ready');
  });
});
