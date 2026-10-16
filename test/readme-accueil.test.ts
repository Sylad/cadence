import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLinks, DOC_PAGES } from '../scripts/check-links.mjs';

const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const readme = read('README.md');

const PAGES = ['raf', 'orchestrate', 'deliver', 'spec', 'lead', 'stabilite'];

/** Lignes de texte de l’introduction : du début du README (le titre `# cadence` est à l’offset 0) à la première section `## `, hors titre, lignes vides, balises (`<picture>`, `<source>`, `<img>`, indentées ou non), images et citations. */
const lignesIntro = (texte: string): string[] => {
  const fin = texte.indexOf('\n## ');
  const intro = texte.slice(0, fin === -1 ? undefined : fin);
  return intro.split('\n').slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith('<') && !l.startsWith('!') && !l.startsWith('>'));
};

describe('README en page d’accueil (L232)', () => {
  it('R1 — le README tient en moins de 12 ko (il en pesait 208 101) et la mesure avant/après est écrite', () => {
    expect(statSync(join(root, 'README.md')).size).toBeLessThan(12 * 1024);
    const m = read('docs/mesures/readme-accueil-2026-10-16.md');
    expect(m).toContain('208 101');
  });

  it('R2 — l’accueil dit ce que fait l’outil en 5 lignes au plus, puis montre le cycle d’une vague et le rôle du lead', () => {
    const lignes = lignesIntro(readme);
    expect(lignes.length, lignes.join('\n')).toBeGreaterThan(0);
    expect(lignes.length, lignes.join('\n')).toBeLessThanOrEqual(5);
    for (const v of ['light', 'dark']) {
      expect(readme).toContain(`docs/cycle-vague-${v}.svg`);
      const svg = read(`docs/cycle-vague-${v}.svg`);
      for (const mot of ['spec', 'mockup', 'accept', 'implement', 'review', 'ux', 'deliver', 'lead']) expect(svg.toLowerCase(), mot).toContain(mot);
    }
  });

  it('R2 — le compte des lignes d’introduction rougit quand l’introduction dépasse 5 lignes (mutation d’une copie du README)', () => {
    const base = lignesIntro(readme).length;
    const mute = readme.replace('\n<picture>', '\n' + Array.from({ length: 6 }, (_, i) => `Une ligne de plus, numéro ${i}.`).join('\n') + '\n\n<picture>');
    expect(mute).not.toBe(readme);
    expect(lignesIntro(mute).length).toBe(base + 6);
    expect(lignesIntro(mute).length).toBeGreaterThan(5);
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
    // README d’avant L232, figé (test/fixtures/readme-avant-L232.json) : chaque titre et chaque phrase-clé se retrouve dans README + docs/*.md
    const avant: { titres: string[]; phrases: string[] } = JSON.parse(read('test/fixtures/readme-avant-L232.json'));
    expect(avant.titres.length).toBeGreaterThanOrEqual(30);
    expect(avant.phrases.length).toBeGreaterThanOrEqual(15);
    const sources = ['README.md', ...readdirSync(join(root, 'docs')).filter((f: string) => f.endsWith('.md')).map((f: string) => `docs/${f}`)];
    const texte = sources.map((p: string) => read(p)).join('\n');
    const titres = new Set([...texte.matchAll(/^#{1,6} (.*)$/gm)].map((m) => m[1].trim()));
    for (const t of avant.titres) expect(titres.has(t), `titre perdu : ${t}`).toBe(true);
    const plat = texte.replace(/\s+/g, ' ');
    for (const f of avant.phrases) expect(plat.includes(f.replace(/\s+/g, ' ')), `phrase perdue : ${f.slice(0, 60)}`).toBe(true);
  });

  it('R9 — aucun renvoi en texte du code ni des gabarits ne pointe vers une section déplacée du README', () => {
    const cli = read('src/cli.ts');
    expect(cli).not.toMatch(/« cadence\.yaml » dans le README/);
    expect(cli).toContain('docs/deliver.md');
    expect(cli).not.toMatch(/correspondance des champs, voir le README/);
    expect(cli).toContain('docs/raf.md');
    for (const f of ['fiche.yaml', 'fiche-back.yaml']) expect(read(`templates/${f}`), f).toContain('docs/spec.md');
    expect(read('templates/acceptation-runner.mjs')).toContain('docs/orchestrate.md');
    for (const f of ['fiche.yaml', 'fiche-back.yaml', 'acceptation-runner.mjs']) expect(read(`templates/${f}`), f).not.toMatch(/du README de cadence|dans le README de cadence/);
  });

  it('R7 — le paquet npm publie les pages docs/ que le README cite', () => {
    const files: string[] = JSON.parse(read('package.json')).files;
    // tout fichier docs/ visé par un lien, une image ou un srcset du README (ancre retirée)
    const cites = new Set([...readme.matchAll(/(docs\/[\w./-]+?\.(?:md|svg))/g)].map((m) => m[1]));
    expect(cites.size).toBeGreaterThanOrEqual(10);
    for (const f of cites) expect(files, f).toContain(f);
    for (const f of ['docs/cycle-vague-light.svg', 'docs/cycle-vague-dark.svg', 'docs/raf.md', 'docs/stabilite.md', 'docs/orchestrate.md']) expect(cites.has(f), f).toBe(true);
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
