import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contraste = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Les textes du schéma avec le fond sur lequel ils sont posés : le dernier <rect> rempli dont la boîte contient le point d'ancrage. */
function textesSurFond(svg: string): { texte: string; fill: string; fond: string }[] {
  const fondGeneral = svg.match(/<rect width="\d+" height="\d+" fill="(#[0-9a-f]{6})"/)![1];
  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*fill="(#[0-9a-f]{6})"/g)]
    .map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], fill: m[5] }));
  return [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*fill="(#[0-9a-f]{6})"[^>]*>([^<]*)</g)].map((m) => {
    const [x, y] = [+m[1], +m[2]];
    const dessous = rects.filter((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h).pop();
    return { texte: m[4], fill: m[3], fond: dessous?.fill ?? fondGeneral };
  });
}

describe('suites de L358 (L374)', () => {
  it.each(['docs/quickstart-dark.svg', 'docs/quickstart-light.svg'])('R2 — chaque texte de %s a un contraste d\'au moins 4,5:1 avec son fond (WCAG 2.2 AA, 1.4.3)', (f) => {
    const textes = textesSurFond(read(f));
    expect(textes.length).toBeGreaterThan(10);
    const sous = textes.filter((t) => contraste(t.fill, t.fond) < 4.5).map((t) => `${t.texte} ${t.fill} sur ${t.fond} = ${contraste(t.fill, t.fond).toFixed(2)}`);
    expect(sous).toEqual([]);
  });

  it('R3 — la carte des pages de docs/overview.md cite docs/quickstart.md', () => {
    const carte = read('docs/overview.md').split('## Where to read more')[1]?.split(/\n## /)[0] ?? '';
    expect(carte).toMatch(/\[docs\/quickstart\.md\]\(quickstart\.md\)/);
  });
});
