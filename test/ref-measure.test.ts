import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { encodePng } from '../src/ref/png.js';
import { tempDir, testPackage } from './helpers.js';
import { stubTools, writePdf, type FixturePage } from './ref-fixture.js';

type Rgb = [number, number, number];

/** Image générée à valeurs connues : fond plein, rectangles pleins (sans anticrénelage). */
function paint(width: number, height: number, bg: Rgb, rects: { x: number; y: number; l: number; h: number; c: Rgb }[]): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r = rects.find((q) => x >= q.x && x < q.x + q.l && y >= q.y && y < q.y + q.h);
      const [R, G, B] = r ? r.c : bg;
      rgba.set([R, G, B, 255], (y * width + x) * 4);
    }
  }
  return encodePng(width, height, rgba);
}

const WHITE: Rgb = [255, 255, 255];
const RED: Rgb = [200, 30, 40];
const BLUE: Rgb = [10, 90, 200];
const TEXT: FixturePage[] = [{ lines: [{ x: 72, y: 700, t: 'Hello Wide Bold 2026' }] }];

/** Environnement d'un test : PATH réel (poppler, tesseract), faux ImageMagick (non appelé par measure) ; un document enregistré par `ref add`. */
function setup(pages: FixturePage[] = TEXT) {
  const base = tempDir();
  const stubs = stubTools(base, ['magick']);
  const refs = join(base, 'refs');
  const env = { RAF_TODAY: '2026-10-23', PATH: `${stubs}:${process.env.PATH}`, XDG_DATA_HOME: join(base, 'xdg') } as NodeJS.ProcessEnv;
  const cwd = join(base, 'work');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'cadence.yaml'), `references:\n  dir: ${refs}\n`);
  const ref = (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(['ref', ...argv], { cwd, env, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-23T10:00:00') });
    return { code: code as number, out: out.join('\n'), err: err.join('\n') };
  };
  const added = ref('add', writePdf(base, 'doc.pdf', pages), '--slug', 'doc');
  expect(added.code, added.err).toBe(0);
  /** Remplace la page 1 rendue par une image générée. */
  const paste = (png: Buffer) => writeFileSync(join(refs, 'doc', 'pages', 'page-1.png'), png);
  const json = (zone: string, ...argv: string[]) => {
    const r = ref('measure', 'doc', '1', zone, ...argv, '--json');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    return JSON.parse(r.out) as any;
  };
  return { base, refs, env, cwd, ref, paste, json };
}

const SHAPES = paint(400, 300, WHITE, [
  { x: 50, y: 40, l: 100, h: 60, c: RED },
  { x: 250, y: 150, l: 80, h: 80, c: BLUE },
]);

describe('cadence ref measure (L262)', () => {
  it('couleurs : un point donne la couleur exacte du pixel', () => {
    const t = setup();
    t.paste(SHAPES);
    const m = t.json('100,70', '--quoi', 'couleurs');
    expect(m.couleurs.point).toEqual({ hex: '#c81e28', rgb: RED });
    expect(t.json('5,5', '--quoi', 'couleurs').couleurs.point.hex).toBe('#ffffff');
  });

  it('couleurs : un carré donne la moyenne, arrondie, et les couleurs dominantes par part de surface', () => {
    const t = setup();
    t.paste(SHAPES);
    // moitié rouge (x 50..99), moitié blanc : (227.5, 142.5, 147.5) arrondi, à ±1 près
    const half = t.json('0,40,100,60', '--quoi', 'couleurs').couleurs;
    expect(half.moyenne.rgb[0]).toBeGreaterThanOrEqual(227);
    expect(half.moyenne.rgb[0]).toBeLessThanOrEqual(228);
    expect(half.moyenne.rgb[1]).toBeGreaterThanOrEqual(142);
    expect(half.moyenne.rgb[1]).toBeLessThanOrEqual(143);
    // la page entière : blanc, rouge, bleu dans l'ordre de leur surface (120000 − 6000 − 6400, 6000, 6400 → blanc, bleu, rouge)
    const all = t.json('page', '--quoi', 'couleurs').couleurs.dominantes;
    expect(all.map((c: any) => c.hex)).toEqual(['#ffffff', '#0a5ac8', '#c81e28']);
    expect(all[1].part).toBe(0.05); // 6400 / 120000, arrondi à 2 décimales
  });

  it('contraste : rapport WCAG 2.2 connu (noir sur blanc 21, #767676 sur blanc 4,54, #777777 sur blanc 4,48) et seuils AA / AAA', () => {
    const t = setup();
    const ratio = (c: Rgb) => {
      t.paste(paint(200, 100, WHITE, [{ x: 20, y: 20, l: 60, h: 30, c }]));
      return t.json('page', '--quoi', 'contraste').contraste;
    };
    const black = ratio([0, 0, 0]);
    expect(black.rapport).toBe(21);
    expect(black).toMatchObject({ fond: { hex: '#ffffff' }, texte: { hex: '#000000' }, aa: true, aaGrand: true, aaa: true });
    const grey76 = ratio([0x76, 0x76, 0x76]);
    expect(grey76.rapport).toBe(4.54);
    expect(grey76).toMatchObject({ aa: true, aaa: false, aaGrand: true });
    const grey77 = ratio([0x77, 0x77, 0x77]);
    expect(grey77.rapport).toBe(4.48);
    expect(grey77).toMatchObject({ aa: false, aaGrand: true });
    const yellow = ratio([255, 255, 0]);
    expect(yellow.rapport).toBe(1.07);
    expect(yellow).toMatchObject({ aa: false, aaGrand: false });
  });

  it('contraste : une zone d\'une seule couleur n\'a pas de contraste à mesurer', () => {
    const t = setup();
    t.paste(SHAPES);
    expect(t.json('5,5,30,30', '--quoi', 'contraste').contraste).toBeNull();
  });

  it('boîtes : les rectangles pleins sont retrouvés à leur position exacte, du plus grand au plus petit, en pixels de la page', () => {
    const t = setup();
    t.paste(SHAPES);
    // --largeur 400 : l'échelle est 1, les valeurs sont celles de l'image
    const m = t.json('page', '--quoi', 'boites', '--largeur', '400').boites;
    expect(m.fond.hex).toBe('#ffffff');
    expect(m.contenu).toEqual({ x: 50, y: 40, l: 280, h: 190 });
    expect(m.boites).toEqual([
      { x: 250, y: 150, l: 80, h: 80 },
      { x: 50, y: 40, l: 100, h: 60 },
    ]);
  });

  it('boîtes : une zone ne mesure que ce qu\'elle contient, les coordonnées restent celles de la page', () => {
    const t = setup();
    t.paste(SHAPES);
    const m = t.json('200,100,200,200', '--quoi', 'boites', '--largeur', '400').boites;
    expect(m.boites).toEqual([{ x: 250, y: 150, l: 80, h: 80 }]);
  });

  it('boîtes : une zone d\'une seule couleur ne contient aucune boîte', () => {
    const t = setup();
    t.paste(SHAPES);
    expect(t.json('0,0,40,30', '--quoi', 'boites').boites).toMatchObject({ contenu: null, boites: [] });
  });

  it('échelle : les mesures sont ramenées à la largeur de référence, 1440 px par défaut', () => {
    const t = setup();
    t.paste(SHAPES);
    // 400 px → 1440 px : ×3,6
    const m = t.json('page', '--quoi', 'boites');
    expect(m.echelle).toEqual({ largeur: 1440, facteur: 3.6 });
    expect(m.boites.boites[1]).toEqual({ x: 180, y: 144, l: 360, h: 216 });
    expect(t.json('page', '--quoi', 'boites', '--largeur', '200').boites.boites[1]).toEqual({ x: 25, y: 20, l: 50, h: 30 });
  });

  it('texte : l\'OCR tesseract rend les mots, leurs boîtes à l\'échelle, et la taille de police estimée dans la tolérance déclarée', () => {
    const t = setup();
    const m = t.json('page', '--quoi', 'texte');
    const words = m.texte.mots.map((w: any) => w.texte);
    expect(words).toEqual(['Hello', 'Wide', 'Bold', '2026']);
    const hello = m.texte.mots[0];
    // x = 72 pt à 200 dpi = 200 px sur 1700, ramenés à 1440 : 169 px
    expect(Math.abs(hello.x - 169)).toBeLessThanOrEqual(3);
    expect(hello.l).toBeGreaterThan(40);
    // 12 pt à 200 dpi = 33,3 px sur 1700, ramenés à 1440 : 28,2 px
    const vrai = (12 * 200 / 72) * (1440 / 1700);
    const police = m.texte.police;
    expect(police.px).toBeGreaterThan(vrai * 0.88);
    expect(police.px).toBeLessThan(vrai * 1.12);
    expect(Math.abs(police.px - vrai) / vrai * 100).toBeLessThanOrEqual(police.tolerancePourcent);
    expect(police.tolerancePourcent).toBeLessThanOrEqual(12);
  });

  it('texte : une zone sans texte ne rend aucun mot et aucune taille de police', () => {
    const t = setup();
    t.paste(SHAPES);
    expect(t.json('page', '--quoi', 'texte').texte).toEqual({ mots: [], police: null });
  });

  it('tolérance déclarée : couleurs, boîtes (à l\'échelle) et police, dans la sortie lue et dans le JSON', () => {
    const t = setup();
    t.paste(SHAPES);
    const m = t.json('page');
    expect(m.tolerance).toEqual({ couleurs: 1, boitesPx: 4, policePourcent: 5 });
    const r = t.ref('measure', 'doc', '1', 'page');
    expect(r.out).toMatch(/tolérance : couleurs ±1\/255 par canal, boîtes ±4 px, police ±5 % plus un pixel de hauteur de capitale/);
  });

  it('--quoi ne garde que la mesure demandée dans la sortie lue', () => {
    const t = setup();
    t.paste(SHAPES);
    const r = t.ref('measure', 'doc', '1', 'page', '--quoi', 'contraste');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^contraste : /m);
    expect(r.out).not.toMatch(/^couleurs|^boîtes|^texte/m);
  });

  it('refuse, sortie 2 et rien de mesuré : document inconnu, page non rendue ou absente, zone illisible ou hors de la page, point hors couleurs, --quoi inconnu', () => {
    const t = setup([...TEXT, ...TEXT]);
    t.paste(SHAPES);
    rmSync(join(t.refs, 'doc', 'pages', 'page-2.png'));
    const refus = (re: RegExp, ...argv: string[]) => {
      const r = t.ref('measure', ...argv);
      expect(r.code, r.out).toBe(2);
      expect(r.err).toMatch(re);
    };
    refus(/document inconnu/, 'autre', '1', 'page');
    refus(/page 2 non rendue.*--sections 2/, 'doc', '2', 'page');
    refus(/page 9 absente/, 'doc', '9', 'page');
    refus(/zone invalide/, 'doc', '1', '10,20,30');
    refus(/zone invalide/, 'doc', '1', '10,20,0,30');
    refus(/hors de la page/, 'doc', '1', '350,250,100,100');
    refus(/hors de la page/, 'doc', '1', '400,10');
    refus(/un point ne se mesure qu'en couleurs/, 'doc', '1', '10,10', '--quoi', 'boites');
    refus(/--quoi invalide/, 'doc', '1', 'page', '--quoi', 'formes');
    refus(/--largeur invalide/, 'doc', '1', 'page', '--largeur', '0');
    refus(/usage : cadence ref measure/, 'doc', '1');
  });

  it('un outil absent du PATH est nommé avec sa commande d\'installation, sortie 2', () => {
    const t = setup();
    const vide = join(t.base, 'vide');
    mkdirSync(vide);
    const out: string[] = [];
    const err: string[] = [];
    const code = run(['ref', 'measure', 'doc', '1', 'page'], { cwd: t.cwd, env: { ...t.env, PATH: vide }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-23T10:00:00') });
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/tesseract : sudo apt install tesseract-ocr/);
    expect(out).toEqual([]);
  });

  it('le binaire cadence exécute « ref measure » et son aide le nomme', () => {
    const t = setup();
    t.paste(SHAPES);
    const bin = join(testPackage(), 'bin/cadence.js');
    const out = execFileSync(process.execPath, [bin, 'ref', 'measure', 'doc', '1', '5,5', '--json'], { cwd: t.cwd, env: t.env, encoding: 'utf8' });
    expect(JSON.parse(out).couleurs.point.hex).toBe('#ffffff');
    expect(execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' })).toMatch(/^\s*cadence ref measure <slug> <page>/m);
  });

  it('une page entière à 200 dpi (1700 × 2200 px) se mesure sans dépassement', () => {
    const t = setup();
    t.paste(paint(1700, 2200, WHITE, [{ x: 200, y: 300, l: 600, h: 100, c: [0, 0, 0] }]));
    const m = t.json('page', '--quoi', 'contraste');
    expect(m.contraste.rapport).toBe(21);
    expect(t.json('page', '--quoi', 'boites', '--largeur', '1700').boites.boites).toEqual([{ x: 200, y: 300, l: 600, h: 100 }]);
  });

  it('une zone sans couleur dominante (photo, dégradé fin) se mesure : le fond est la couleur la plus étendue, sans plantage', () => {
    const t = setup();
    const w = 200, h = 200;
    const rgba = Buffer.alloc(w * h * 4);
    let seed = 7;
    for (let i = 0; i < w * h; i++) {
      for (let c = 0; c < 3; c++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        rgba[i * 4 + c] = (seed >> 8) & 0xff;
      }
      rgba[i * 4 + 3] = 255;
    }
    t.paste(encodePng(w, h, rgba));
    const m = t.json('page');
    expect(m.contraste.rapport).toBeGreaterThan(1);
    expect(m.boites.fond.hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(m.couleurs.dominantes).toEqual([]);
  });
});
