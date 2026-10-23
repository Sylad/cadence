import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { gitRepo, tempDir, testPackage } from './helpers.js';
import { NORME, stubTools, writePdf, type FixturePage } from './ref-fixture.js';

interface Doc {
  slug: string;
  sha256: string;
  pages: { n: number; width: number; height: number; rendered: boolean; lines: { text: string; x: number; y: number; l: number; h: number }[] }[];
  images: { page: number; file: string | null; x: number; y: number; l: number; h: number }[];
  figures: { label: string; kind: string; page: number; line: number; caption: string; regions: number[]; citations: { page: number; line: number; extrait: string; type: string }[] }[];
  unresolved: { label: string; page: number; extrait: string }[];
  tools: Record<string, string>;
}

/** Environnement d'un test : PATH réel + faux magick / tesseract, dossier de références à part, aucun dépôt autour. */
function setup(extraTools: string[] = ['magick', 'tesseract']) {
  const base = tempDir();
  const stubs = stubTools(base, extraTools);
  const refs = join(base, 'refs');
  const env = { RAF_TODAY: '2026-10-23', PATH: `${stubs}:${process.env.PATH}`, XDG_DATA_HOME: join(base, 'xdg') } as NodeJS.ProcessEnv;
  const cwd = join(base, 'work');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'cadence.yaml'), `references:\n  dir: ${refs}\n`);
  return { base, refs, env, cwd };
}

function ref(cwd: string, env: NodeJS.ProcessEnv, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(['ref', ...argv], { cwd, env, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-23T10:00:00') });
  return { code: code as number, out: out.join('\n'), err: err.join('\n') };
}

const readDoc = (refs: string, slug: string): Doc => JSON.parse(readFileSync(join(refs, slug, 'document.json'), 'utf8')) as Doc;
const pngSize = (file: string) => {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

describe('cadence ref add (L261)', () => {
  it('rend chaque page visée à 200 dpi', () => {
    const { base, refs, env, cwd } = setup();
    const pdf = writePdf(base, 'norme.pdf', NORME);
    const r = ref(cwd, env, 'add', pdf, '--slug', 'norme');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    // 612 × 792 pt à 200 dpi : 1700 × 2200 px
    expect(pngSize(join(refs, 'norme', 'pages', 'page-2.png'))).toEqual({ w: 1700, h: 2200 });
    expect(readDoc(refs, 'norme').pages.map((p) => [p.width, p.height])).toEqual([[1700, 2200], [1700, 2200], [1700, 2200]]);
  });

  it('garde le texte positionné, en pixels de la page rendue', () => {
    const { base, refs, env, cwd } = setup();
    ref(cwd, env, 'add', writePdf(base, 'norme.pdf', NORME), '--slug', 'norme');
    const line = readDoc(refs, 'norme').pages[1]!.lines.find((l) => l.text === 'Figure 1 Station model')!;
    expect(line).toBeDefined();
    // x = 72 pt → 200 px ; la ligne de base est à y = 380 pt du bas, soit ≈ 1146 px du haut
    expect(line.x).toBe(200);
    expect(line.y).toBeGreaterThan(1110);
    expect(line.y).toBeLessThan(1150);
    expect(line.l).toBeGreaterThan(300);
    expect(line.h).toBeGreaterThan(20);
  });

  it('extrait les images incluses et leur région, en pixels de la page rendue', () => {
    const { base, refs, env, cwd } = setup();
    ref(cwd, env, 'add', writePdf(base, 'norme.pdf', NORME), '--slug', 'norme');
    const doc = readDoc(refs, 'norme');
    expect(doc.images).toHaveLength(1);
    const img = doc.images[0]!;
    expect(img.page).toBe(2);
    expect(existsSync(join(refs, 'norme', img.file!))).toBe(true);
    // image posée en (72, 400) pt, 200 × 100 pt : 200 px du bord, 556 × 278 px, haut à (792 − 500) pt = 811 px
    expect(img).toMatchObject({ x: 200, y: 811, l: 556, h: 278 });
  });

  it("indexe les figures : légende, région d'image, passages qui les citent", () => {
    const { base, refs, env, cwd } = setup();
    ref(cwd, env, 'add', writePdf(base, 'norme.pdf', NORME), '--slug', 'norme');
    const doc = readDoc(refs, 'norme');
    const fig = doc.figures.find((f) => f.label === 'Figure 1')!;
    expect(fig).toMatchObject({ kind: 'figure', page: 2, caption: 'Figure 1 Station model' });
    expect(fig.regions).toEqual([0]);
    expect(fig.citations).toEqual([{ page: 1, line: 1, extrait: 'The station model is drawn in Figure 1 on page two.', type: 'nommee' }]);
    const table = doc.figures.find((f) => f.label === 'Table 2')!;
    expect(table).toMatchObject({ kind: 'table', page: 3, regions: [] });
    // cité par la page 1 (nommée) et par « As shown below » de la page 3 (désignée, rattachée à la légende de la page)
    expect(table.citations.map((c) => [c.page, c.type])).toEqual([[1, 'nommee'], [3, 'designee']]);
  });

  it("liste « lien non résolu » une figure citée sans légende, et la dit dans la sortie", () => {
    const { base, refs, env, cwd } = setup();
    const r = ref(cwd, env, 'add', writePdf(base, 'norme.pdf', NORME), '--slug', 'norme');
    expect(readDoc(refs, 'norme').unresolved).toEqual([{ label: 'Figure 9', page: 3, extrait: 'As shown below, see also Figure 9.' }]);
    expect(r.out).toContain('liens non résolus : 1');
  });

  it("enregistre la somme sha256 du document", () => {
    const { base, refs, env, cwd } = setup();
    const pdf = writePdf(base, 'norme.pdf', NORME);
    ref(cwd, env, 'add', pdf, '--slug', 'norme');
    expect(readDoc(refs, 'norme').sha256).toBe(createHash('sha256').update(readFileSync(pdf)).digest('hex'));
  });

  it("un sommaire et une prose coupée avant la légende ne placent pas la figure : --sections rend la page de la légende, pas celle du sommaire", () => {
    const { base, refs, env, cwd } = setup();
    const pages: FixturePage[] = [
      { lines: [{ x: 72, y: 700, t: 'Figure 1 - Station model' }, { x: 72, y: 680, t: '......................................... 3' }] },
      { lines: [{ x: 72, y: 700, t: 'Figure 1 The station model is a' }] },
      { lines: [{ x: 72, y: 380, t: 'Figure 1 - Station model' }], image: { x: 72, y: 400, w: 200, h: 100 } },
      { lines: [{ x: 72, y: 700, t: 'The model is drawn in Figure 1.' }] },
    ];
    ref(cwd, env, 'add', writePdf(base, 'norme.pdf', pages), '--slug', 'norme', '--sections', '4');
    const doc = readDoc(refs, 'norme');
    expect(doc.figures).toMatchObject([{ label: 'Figure 1', page: 3, regions: [0] }]);
    expect(readdirSync(join(refs, 'norme', 'pages')).sort()).toEqual(['page-3.png', 'page-4.png']);
  });

  it('--sections ne rend que les pages visées et celles des figures qu\'elles citent', () => {
    const { base, refs, env, cwd } = setup();
    const pdf = writePdf(base, 'norme.pdf', NORME);
    ref(cwd, env, 'add', pdf, '--slug', 'a', '--sections', '3');
    expect(readdirSync(join(refs, 'a', 'pages'))).toEqual(['page-3.png']);
    // la page 1 cite la Figure 1 (page 2) et la Table 2 (page 3), ailleurs dans le document
    ref(cwd, env, 'add', pdf, '--slug', 'b', '--sections', '1');
    expect(readdirSync(join(refs, 'b', 'pages')).sort()).toEqual(['page-1.png', 'page-2.png', 'page-3.png']);
    ref(cwd, env, 'add', pdf, '--slug', 'c', '--sections', '2');
    expect(readdirSync(join(refs, 'c', 'pages'))).toEqual(['page-2.png']);
    expect(readDoc(refs, 'c').pages.map((p) => p.rendered)).toEqual([false, true, false]);
  });

  it("sans --sections, un grand document n'est pas rendu : seul l'index est construit", () => {
    const { base, refs, env, cwd } = setup();
    const pages: FixturePage[] = Array.from({ length: 31 }, (_, i) => ({ lines: [{ x: 72, y: 700, t: i === 30 ? 'Figure 1 Last' : `Page ${i + 1} text` }] }));
    const r = ref(cwd, env, 'add', writePdf(base, 'gros.pdf', pages), '--slug', 'gros');
    expect(r.code).toBe(0);
    expect(existsSync(join(refs, 'gros', 'pages')) ? readdirSync(join(refs, 'gros', 'pages')) : []).toEqual([]);
    const doc = readDoc(refs, 'gros');
    expect(doc.pages).toHaveLength(31);
    expect(doc.figures.map((f) => f.label)).toEqual(['Figure 1']);
    expect(r.out).toContain('rendues : 0');
  });

  it('refuse un outil absent en le nommant avec sa commande d\'installation, sortie 2, sans rien écrire', () => {
    const { base, refs, env, cwd } = setup(['tesseract']);
    const pdf = writePdf(base, 'norme.pdf', NORME);
    // un PATH qui ne garde que poppler et tesseract : ni magick ni convert
    const poppler = join(base, 'poppler');
    mkdirSync(poppler);
    const r = ref(cwd, { ...env, PATH: `${join(base, 'stubs')}:${realToolDirs(poppler)}` }, 'add', pdf, '--slug', 'norme');
    expect(r.code).toBe(2);
    expect(r.err).toContain('magick');
    expect(r.err).toContain('sudo apt install imagemagick');
    expect(r.err).not.toContain('tesseract');
    expect(r.err).not.toContain('pdftoppm');
    expect(existsSync(refs)).toBe(false);
  });

  it('nomme chaque outil absent, avec le paquet qui le fournit', () => {
    const { base, env, cwd } = setup([]);
    const empty = join(base, 'vide');
    mkdirSync(empty);
    const r = ref(cwd, { ...env, PATH: empty }, 'add', writePdf(base, 'norme.pdf', NORME));
    expect(r.code).toBe(2);
    for (const t of ['pdftoppm', 'pdftotext', 'pdfimages', 'pdfinfo', 'pdftohtml']) expect(r.err).toContain(t);
    expect(r.err).toContain('sudo apt install poppler-utils');
    expect(r.err).toContain('sudo apt install imagemagick');
    expect(r.err).toContain('sudo apt install tesseract-ocr');
  });

  it('accepte convert (ImageMagick 6) à la place de magick', () => {
    const { base, env, cwd } = setup(['convert', 'tesseract']);
    expect(ref(cwd, env, 'add', writePdf(base, 'norme.pdf', NORME), '--slug', 'norme').code).toBe(0);
  });

  it('refuse un dossier de références dans un dépôt Git, sortie 2', () => {
    const { base, env } = setup();
    const repo = gitRepo();
    writeFileSync(join(repo, 'cadence.yaml'), `references:\n  dir: ${join(repo, 'references')}\n`);
    const r = ref(repo, env, 'add', writePdf(base, 'norme.pdf', NORME));
    expect(r.code).toBe(2);
    expect(r.err).toContain('dépôt Git');
    expect(existsSync(join(repo, 'references'))).toBe(false);
  });

  it('sans references.dir, range les documents sous $XDG_DATA_HOME/cadence/references', () => {
    const { base, env } = setup();
    const cwd = join(base, 'nu');
    mkdirSync(cwd);
    const r = ref(cwd, env, 'add', writePdf(base, 'norme.pdf', NORME));
    expect(r.code).toBe(0);
    expect(existsSync(join(base, 'xdg', 'cadence', 'references', 'norme', 'document.json'))).toBe(true);
  });

  it('refuse un slug déjà pris par un autre document, et complète le même document relancé', () => {
    const { base, refs, env, cwd } = setup();
    const pdf = writePdf(base, 'norme.pdf', NORME);
    expect(ref(cwd, env, 'add', pdf, '--slug', 'norme', '--sections', '2').code).toBe(0);
    expect(ref(cwd, env, 'add', pdf, '--slug', 'norme', '--sections', '3').code).toBe(0);
    expect(readdirSync(join(refs, 'norme', 'pages')).sort()).toEqual(['page-2.png', 'page-3.png']);
    const autre = writePdf(base, 'autre.pdf', [{ lines: [{ x: 72, y: 700, t: 'Autre' }] }]);
    const r = ref(cwd, env, 'add', autre, '--slug', 'norme');
    expect(r.code).toBe(2);
    expect(r.err).toContain('norme');
    expect(r.err).toContain('--slug');
  });

  it('refuse un fichier absent, abîmé ou qui n\'est pas un PDF, avec la raison', () => {
    const { base, refs, env, cwd } = setup();
    expect(ref(cwd, env, 'add', join(base, 'nulle-part.pdf')).err).toContain('introuvable');
    const abime = join(base, 'abime.pdf');
    writeFileSync(abime, 'ceci n\'est pas un PDF');
    const r = ref(cwd, env, 'add', abime);
    expect(r.code).toBe(2);
    expect(r.err).toContain('abîmé');
    expect(existsSync(refs)).toBe(false);
  });

  it('refuse une page demandée hors du document et une plage mal écrite', () => {
    const { base, env, cwd } = setup();
    const pdf = writePdf(base, 'norme.pdf', NORME);
    expect(ref(cwd, env, 'add', pdf, '--sections', '7').err).toContain('3 pages');
    expect(ref(cwd, env, 'add', pdf, '--sections', '2-x').code).toBe(2);
    expect(ref(cwd, env, 'add', pdf, '--sections', '3-1').code).toBe(2);
  });

  it("signale les pages sans texte (scannées) et fait des vignettes de toutes les pages d'un grand document", () => {
    const { base, refs, env, cwd } = setup();
    const scan: FixturePage[] = Array.from({ length: 31 }, (_, i) => ({ lines: i === 4 ? [{ x: 72, y: 700, t: 'Un titre assez long pour compter.' }] : [], image: { x: 72, y: 400, w: 200, h: 100 } }));
    const r = ref(cwd, env, 'add', writePdf(base, 'scan.pdf', scan), '--slug', 'scan');
    expect(r.code).toBe(0);
    expect(r.out).toContain('pages sans texte : 30 (1-4, 6-31)');
    expect(r.out).toContain('rendues : 0');
    expect(existsSync(join(refs, 'scan', 'thumbs', 'page-1.png'))).toBe(true);
    expect(existsSync(join(refs, 'scan', 'thumbs', 'page-31.png'))).toBe(true);
    expect(existsSync(join(refs, 'scan', 'pages', 'page-1.png'))).toBe(false);
    expect(pngSize(join(refs, 'scan', 'thumbs', 'page-1.png')).w).toBe(340);
  });

  it('un document dont toutes les pages ont du texte ne signale aucune page sans texte', () => {
    const { base, env, cwd } = setup();
    expect(ref(cwd, env, 'add', writePdf(base, 'norme.pdf', NORME), '--slug', 'norme').out).not.toContain('sans texte');
  });

  it('refuse un PDF chiffré avec mot de passe, et un PDF chiffré dont la copie est interdite, sortie 2', () => {
    const { base, refs, env, cwd } = setup();
    const pdf = writePdf(base, 'norme.pdf', NORME);
    const faux = (name: string, body: string): NodeJS.ProcessEnv => {
      const dir = join(base, name);
      mkdirSync(dir);
      writeFileSync(join(dir, 'pdfinfo'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return { ...env, PATH: `${dir}:${env.PATH}` };
    };
    const mdp = ref(cwd, faux('mdp', 'echo "Command Line Error: Incorrect password" >&2; exit 1'), 'add', pdf);
    expect(mdp.code).toBe(2);
    expect(mdp.err).toContain('PDF chiffré (mot de passe demandé)');
    const copie = ref(cwd, faux('copie', 'echo "Pages:          3"; echo "Encrypted:      yes (print:yes copy:no change:no addNotes:no algorithm:AES)"'), 'add', pdf);
    expect(copie.code).toBe(2);
    expect(copie.err).toContain('copie est interdite');
    expect(existsSync(refs)).toBe(false);
  });

  it('un PDF chiffré dont la copie est permise est lu', () => {
    const { base, env, cwd } = setup();
    const dir = join(base, 'permis');
    mkdirSync(dir);
    const real = execFileSync('which', ['pdfinfo'], { encoding: 'utf8' }).trim();
    writeFileSync(join(dir, 'pdfinfo'), `#!/bin/sh\n${real} "$@" | sed 's/^Encrypted:.*/Encrypted:      yes (print:yes copy:yes)/'\n`, { mode: 0o755 });
    expect(ref(cwd, { ...env, PATH: `${dir}:${env.PATH}` }, 'add', writePdf(base, 'norme.pdf', NORME), '--slug', 'norme').code).toBe(0);
  });

  it('refuse une clé references: mal formée de cadence.yaml, sortie 2, avec la raison', () => {
    const { base, env, cwd } = setup();
    const pdf = writePdf(base, 'norme.pdf', NORME);
    const essai = (yaml: string) => {
      writeFileSync(join(cwd, 'cadence.yaml'), yaml);
      return ref(cwd, env, 'add', pdf);
    };
    for (const [yaml, raison] of [
      ['references: abc\n', 'doit être un objet'],
      ['references:\n  dossier: x\n', 'references.dossier inconnu'],
      ['references:\n  dir: ""\n', 'references.dir : chemin attendu'],
      ['references:\n  dir: 12\n', 'references.dir : chemin attendu'],
    ] as const) {
      const r = essai(yaml);
      expect(r.code).toBe(2);
      expect(r.err).toContain(raison);
    }
  });

  it('sans document ou avec un sous-verbe inconnu, donne l\'usage', () => {
    const { env, cwd } = setup();
    const usage = 'usage : cadence ref add <document.pdf> [--sections 3-5,9] [--slug nom]';
    const r = ref(cwd, env, 'add');
    expect(r.code).toBe(2);
    expect(r.err.trim()).toBe(`raf: ${usage}`);
    // un sous-verbe inconnu donne l'usage de chaque sous-verbe (L262 : ref measure)
    for (const argv of [['plus'], ['norme.pdf'], ['list']]) {
      const s = ref(cwd, env, ...argv);
      expect(s.code).toBe(2);
      expect(s.err.trim().split('\n')[0]).toBe(`raf: ${usage}`);
      expect(s.err).toMatch(/\n\s+cadence ref measure <slug>/);
    }
  });
});

describe('le binaire cadence (L261)', () => {
  it('« cadence ref add » est routé vers la commande : le binaire du paquet l\'exécute au lieu d\'imprimer l\'aide générale', () => {
    const { base, refs, env, cwd } = setup();
    const out = execFileSync(process.execPath, [join(testPackage(), 'bin/cadence.js'), 'ref', 'add', writePdf(base, 'norme.pdf', NORME), '--slug', 'norme'], { cwd, env, encoding: 'utf8' });
    expect(out).toContain('figures : 2');
    expect(readDoc(refs, 'norme').figures.map((f) => f.label)).toEqual(['Figure 1', 'Table 2']);
  });

  it('l\'aide du binaire nomme « cadence ref add »', () => {
    const aide = execFileSync(process.execPath, [join(testPackage(), 'bin/cadence.js'), '--help'], { encoding: 'utf8' });
    expect(aide).toMatch(/^\s*cadence ref add <document\.pdf>/m);
  });
});

/** Les outils poppler de la machine, liés dans un seul dossier (sans magick ni convert, qu'une machine peut avoir). */
function realToolDirs(into: string): string {
  for (const t of ['pdftoppm', 'pdftotext', 'pdfimages', 'pdfinfo', 'pdftohtml']) symlinkSync(execFileSync('which', [t], { encoding: 'utf8' }).trim(), join(into, t));
  return into;
}
