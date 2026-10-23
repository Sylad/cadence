import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { TEMPLATES_DIR, renderBrief, shotsText } from '../src/orchestrate/briefs.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { harness, workReport, commitFile, reviewReport, claudeOut, type Handler } from './orchestrate-harness.js';

/** Où le serveur Playwright MCP (0.0.83, mesuré le 23-10) range un nom de fichier donné par la session : `path.resolve(racine de travail, nom)`, et non `--output-dir` (réservé aux fichiers sans nom). */
const landing = (workspace: string, name: string): string => resolve(workspace, name);
const inside = (dir: string, file: string): boolean => !relative(dir, file).startsWith('..') && !isAbsolute(relative(dir, file));

const impl = (): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a.txt')] }));
const ok: Handler = () => claudeOut(reviewReport());

/** Les chemins de fichier image que la consigne de captures donne en exemple. */
const examples = (brief: string): string[] => [...brief.matchAll(/`([^`\s]*\.png)`/g)].map((m) => m[1]!);

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

  it('R3 — le brief rendu avec {{shots}} porte le chemin absolu ; sans vague (délégation à la main) la consigne est absente', () => {
    const vars = { chemin: '/r/p', lot: 'L9', titre: 'T', objectif: 'x', commits: '', reponse: '', constats: '', ux: '', choix: '', checks: '', news: '', captures: '' };
    expect(renderBrief('ux', { ...vars, shots: shotsText('/vague/pw') })).toContain('/vague/pw/');
    expect(renderBrief('ux', vars)).not.toContain('/vague/pw');
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
