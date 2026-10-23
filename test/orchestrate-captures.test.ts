import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { TEMPLATES_DIR, renderBrief, shotsText } from '../src/orchestrate/briefs.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { harness, workReport, commitFile, reviewReport, specReport, claudeOut, type Handler } from './orchestrate-harness.js';
import { ecrit } from './spec-helpers.js';

/** Où le serveur Playwright MCP (0.0.83, mesuré le 23-10) range un nom de fichier donné par la session : `path.resolve(racine de travail, nom)`, et non `--output-dir` (réservé aux fichiers sans nom). */
const landing = (workspace: string, name: string): string => resolve(workspace, name);
const inside = (dir: string, file: string): boolean => !relative(dir, file).startsWith('..') && !isAbsolute(relative(dir, file));

const impl = (): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a.txt')] }));
const ok: Handler = () => claudeOut(reviewReport());

/** Les chemins de fichier que la consigne de captures donne en exemple, quelle que soit la sortie du serveur (image, trace, PDF). */
const examples = (brief: string): string[] => [...brief.matchAll(/`([^`\s<]*\.(?:png|jpe?g|webp|zip|pdf))`/g)].map((m) => m[1]!);
const ROOT = join(TEMPLATES_DIR, '..', '..');

describe('captures Playwright des étapes (L249)', () => {
  it('R1 — shotsText dit que le serveur range un nom de fichier sur le dépôt et exige le chemin absolu du dossier de la vague', () => {
    const t = shotsText('/vague/w1/p-L1/playwright');
    expect(t).toContain('/vague/w1/p-L1/playwright/');
    expect(t).toMatch(/repository, not .*output directory/);
    expect(t).toContain('absolute path');
    expect(t).not.toContain('relative file name only');
  });

  it('R2 — aucun gabarit ni agent ne prescrit plus « nom relatif seulement / jamais de chemin absolu », et chaque gabarit qui parle de Playwright porte {{shots}}', () => {
    const files = readdirSync(TEMPLATES_DIR).map((f) => join(TEMPLATES_DIR, f));
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/relative file name only/);
      expect(text, f).not.toMatch(/Never an absolute path/);
      expect(text, f).not.toMatch(/never an absolute path/);
      if (/Browser \(Playwright\)|Playwright \(browser MCP\)/.test(text)) expect(text, f).toContain('{{shots}}');
    }
    for (const a of ['ux-reviewer', 'qa-reviewer', 'spec-writer']) {
      expect(readFileSync(join(TEMPLATES_DIR, '..', '..', 'agents', `${a}.md`), 'utf8'), a).not.toMatch(/relative file name only/);
    }
  });

  it('R4 — la documentation d\'orchestrate décrit la liste d\'auto-contrôle avec « a file name » et la règle du paragraphe Playwright, plus « with a relative file name »', () => {
    const doc = readFileSync(join(TEMPLATES_DIR, '..', '..', 'docs', 'orchestrate.md'), 'utf8');
    expect(doc).not.toMatch(/at 1440 and 390 px with a relative file name/);
    expect(doc).toMatch(/at 1440 and 390 px with a file name \(where it goes is the Playwright paragraph's rule\)/);
  });

  it('R3 — le brief rendu avec {{shots}} porte le chemin absolu (l\'absence de la consigne sans vague est vérifiée par le --dry-run, orchestrate-command.test.ts)', () => {
    const vars = { chemin: '/r/p', lot: 'L9', titre: 'T', objectif: 'x', commits: '', reponse: '', constats: '', ux: '', choix: '', checks: '', news: '', captures: '' };
    expect(renderBrief('ux', { ...vars, shots: shotsText('/vague/pw') })).toContain('/vague/pw/');
  });

  it.each([['agents/ux-reviewer.md'], ['agents/qa-reviewer.md'], ['docs/skills.md']])('R5 — %s : hors vague, un exemple de capture arrive sous .playwright-mcp/ du dépôt, jamais à sa racine', (rel) => {
    const repo = '/un/depot';
    const names = examples(readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' '));
    expect(names.length, rel).toBeGreaterThan(0);
    for (const n of names) {
      const file = landing(repo, n);
      expect(inside(join(repo, '.playwright-mcp'), file), `${n} → ${file}`).toBe(true);
    }
  });

  it('R5 — aucune copie de la consigne ne dit plus que le serveur range un nom nu sous .playwright-mcp/', () => {
    for (const rel of ['agents/ux-reviewer.md', 'agents/qa-reviewer.md', 'docs/skills.md']) {
      expect(readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' '), rel).not.toContain('a bare file name (e.g. `page-home.png`)');
    }
  });

  it.each([
    ['ux', { visible: true }, { ux: { url: 'http://localhost:4200' } }, 'ux'],
    ['review-small', { small: true, visible: true }, { ux: { url: 'http://localhost:4200' } }, 'review-small'],
    ['implement', { visible: true }, {}, 'implement'],
  ] as const)('R4 — étape %s : une capture nommée comme le brief le dit ne tombe jamais dans le dépôt, elle arrive dans le dossier de la vague', async (_n, lotOpts, cfg, kind) => {
    const h = harness({ lots: [{ title: 'Écran', visible: true, estimate: kind === 'review-small' ? 0.5 : undefined }], script: { implement: [impl()], ux: [ok], review: [ok], 'review-small': [ok] } });
    const c = h.lot('L1', { ...lotOpts }, { ...cfg });
    await runLot(c);
    const brief = h.calls.find((x) => x.kind === kind)!.brief;
    const pw = join(h.store.dir, 'demo--L1', 'playwright');
    const names = examples(brief);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      const file = landing(c.lot.repo, n);
      expect(inside(c.lot.repo, file), `${n} → ${file}`).toBe(false);
      expect(inside(pw, file), `${n} → ${file}`).toBe(true);
    }
  });
});

describe('briefs rendus en vague : {{shots}} rempli pour chaque étape qui charge le serveur (L249)', () => {
  const pwOf = (h: ReturnType<typeof harness>): string => join(h.store.dir, 'demo--L1', 'playwright');
  const major: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 3, texte: 'bug nommé' }], verdict: 'non conforme' }));
  const minor: Handler = () => claudeOut(reviewReport({ mineurs: 1, constats: [{ gravite: 'mineur', fichier: 'a.txt', ligne: 3, texte: 'nommage' }] }));
  const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));

  it('fix et fix-minors d\'un lot visible portent le chemin absolu du dossier de la vague suivi de « / »', async () => {
    const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], review: [major, minor, ok], fix: [fix('b.txt'), fix('c.txt')], 'review-small': [ok] } });
    await runLot(h.lot('L1', { visible: true }));
    const fixes = h.calls.filter((c) => c.kind === 'fix');
    expect(fixes.some((f) => f.brief.includes('A fresh review of the commits'))).toBe(true); // fix
    expect(fixes.some((f) => f.brief.includes('only minor findings'))).toBe(true); // fix-minors
    for (const f of fixes) expect(f.brief).toContain(shotsText(pwOf(h)));
  });

  it('spec et maquette d\'un lot à écran portent le chemin absolu du dossier de la vague', async () => {
    const spec: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }));
    const h = harness({ lots: [{ title: 'Un écran', screen: 'page' }], script: { spec: [spec], maquette: [ok], implement: [impl()], review: [ok] } });
    await runLot(h.lot('L1', { visible: true, screen: 'page' }, { maquette: true }));
    for (const kind of ['spec', 'maquette'] as const) {
      const call = h.calls.find((c) => c.kind === kind);
      expect(call, kind).toBeDefined();
      expect(call!.brief, kind).toContain(shotsText(pwOf(h)));
    }
  });
});
