import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLinks, DOC_PAGES } from '../scripts/check-links.mjs';

const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const readme = read('README.md');

const PAGES = ['raf', 'orchestrate', 'deliver', 'spec', 'lead', 'stabilite'];

describe('README en page d’accueil (L232)', () => {
  it('R1 — le README tient en moins de 12 ko (il en pesait 208 101) et la mesure avant/après est écrite', () => {
    expect(statSync(join(root, 'README.md')).size).toBeLessThan(12 * 1024);
    const m = read('docs/mesures/readme-accueil-2026-10-16.md');
    expect(m).toContain('208 101');
    expect(m).toMatch(new RegExp(`${statSync(join(root, 'README.md')).size}`.replace(/(\d)(?=(\d{3})+$)/g, '$1 ?')));
  });

  it('R2 — l’accueil dit ce que fait l’outil en 5 lignes au plus, puis montre le cycle d’une vague et le rôle du lead', () => {
    const intro = readme.slice(readme.indexOf('\n# cadence'), readme.indexOf('\n## ', readme.indexOf('\n# cadence')));
    const lignes = intro.split('\n').slice(1).filter((l) => l.trim() && !l.startsWith('<') && !l.startsWith('!') && !l.startsWith('>'));
    expect(lignes.length).toBeLessThanOrEqual(5);
    for (const v of ['light', 'dark']) {
      expect(readme).toContain(`docs/cycle-vague-${v}.svg`);
      const svg = read(`docs/cycle-vague-${v}.svg`);
      for (const mot of ['spec', 'mockup', 'accept', 'implement', 'review', 'ux', 'deliver', 'lead']) expect(svg.toLowerCase(), mot).toContain(mot);
    }
  });

  it('R3 — les trois commandes de départ sont dans un bloc de code de l’accueil', () => {
    const debut = readme.slice(readme.indexOf('\n## Start'), readme.indexOf('\n## ', readme.indexOf('\n## Start') + 5));
    expect(debut).toMatch(/```[\s\S]*raf[\s\S]*```/);
    const bloc = /```[a-z]*\n([\s\S]*?)```/.exec(debut)?.[1] ?? '';
    expect(bloc.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length).toBe(3);
  });

  it('R4 — un sommaire renvoie vers les pages docs/ raf, orchestrate, deliver, spec, lead et stabilité', () => {
    for (const p of PAGES) {
      expect(readme, p).toContain(`docs/${p}.md`);
      expect(existsSync(join(root, `docs/${p}.md`)), p).toBe(true);
    }
    expect(DOC_PAGES).toEqual(expect.arrayContaining(PAGES.map((p) => `docs/${p}.md`)));
  });

  it('R5 — « What’s new » : deux lignes par version au plus, avec renvoi au CHANGELOG', () => {
    const debut = readme.indexOf("## What's new");
    const section = readme.slice(debut, readme.indexOf('\n## ', debut + 5) === -1 ? undefined : readme.indexOf('\n## ', debut + 5));
    const versions = section.split('\n').filter((l) => /^- \*\*\d+\.\d+\.\d+\*\*/.test(l));
    expect(versions.length).toBeGreaterThanOrEqual(8);
    for (const v of versions) expect(v.length, v.slice(0, 40)).toBeLessThanOrEqual(2 * 100 + 40);
    expect(section).toContain('CHANGELOG.md');
    expect(section).toMatch(/\*\*1\.6\.0\*\*/);
  });

  it('R6 — les sections longues sont repliables (<details>) et le contenu d’avant n’est pas perdu', () => {
    expect(readme).toContain('<details>');
    // titres de l’ancien README, chacun retrouvé dans une page de docs/
    const titres = ['Gantt scheduling', 'UX review', 'Code review', 'QA review', 'lead tour', 'corrections',
      'verify: replay the effect checks', 'The accept step', 'The mockup review', 'A lot whose work is in a neighbouring repository',
      'Claude Code skills', 'cadence-hud', 'Releasing', 'Evaluating the plugin', 'Stability', 'Spec step (design, first steps delivered)'];
    const pages = [...DOC_PAGES, 'docs/news.md', 'docs/session.md', 'docs/corrections.md', 'docs/skills.md', 'docs/cadence-hud.md', 'docs/releasing.md']
      .map((p: string) => read(p)).join('\n');
    for (const t of titres) expect(pages, t).toMatch(new RegExp(`^#{1,4} .*${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
  });

  it('R7 — le paquet npm publie les pages docs/ que le README cite', () => {
    const files: string[] = JSON.parse(read('package.json')).files;
    for (const f of ['docs/cycle-vague-light.svg', 'docs/cycle-vague-dark.svg', 'docs/raf.md', 'docs/stabilite.md', 'docs/orchestrate.md']) expect(files, f).toContain(f);
  });

  it('R8 — aucun lien relatif ni ancre cassé dans le README et les pages docs/', () => {
    expect(checkLinks(root)).toEqual([]);
  });

  it('R8 — le contrôle voit un fichier absent, une ancre absente et une image absente', () => {
    const d = mkdtempSync(join(tmpdir(), 'liens-'));
    try {
      mkdirSync(join(d, 'docs'));
      writeFileSync(join(d, 'README.md'), '# t\n[a](docs/x.md) [b](docs/y.md#nope) <img src="docs/z.svg">\n```\n[c](docs/jamais.md)\n```\n');
      writeFileSync(join(d, 'docs/y.md'), '# Titre\n');
      const errs: string[] = checkLinks(d, ['README.md']);
      expect(errs.length).toBe(3);
      expect(errs.join('\n')).toMatch(/docs\/x\.md/);
      expect(errs.join('\n')).toMatch(/#nope/);
      expect(errs.join('\n')).toMatch(/docs\/z\.svg/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('R8 — la CI tests.yml lance le contrôle des liens', () => {
    const y = read('.github/workflows/tests.yml');
    expect(y).toContain('scripts/check-links.mjs');
    expect(execFileSync('node', [join(root, 'scripts/check-links.mjs')], { cwd: root, encoding: 'utf8' })).toMatch(/0 lien cassé/);
  });
});
