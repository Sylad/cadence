import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// probe(L513) : bords du lot agents-design-jetons-grille-tics, hors test/agents-design-jetons-grille-tics.test.ts
const root = join(__dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const plat = (s: string) => s.replace(/\s+/g, ' ');
const ux = read('agents/ux-reviewer.md');
const writer = read('agents/spec-writer.md');
const notice = read('NOTICE');
const tous = (d: string): string[] =>
  readdirSync(join(root, d)).flatMap((n) => {
    const p = join(d, n);
    return statSync(join(root, p)).isDirectory() ? tous(p) : [p];
  });

describe('R12 — NOTICE et attribution', () => {
  it('R12 — NOTICE nomme l’auteur et le dépôt de l’original (pas de « not recorded »)', () => {
    expect(notice).not.toMatch(/not recorded|to be read at the source/i);
  });
  it('R12 — NOTICE ne contient pas de ligne de licence qui renvoie à l’énoncé du lot', () => {
    expect(notice).not.toMatch(/request of lot/i);
  });
  it('R12 — NOTICE est dans le paquet npm (npm pack --dry-run)', () => {
    const r = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
    expect(r.stdout + r.stderr).toMatch(/NOTICE/);
  });
  it('R12 — NOTICE n’apparaît qu’une fois dans files de package.json', () => {
    const f: string[] = JSON.parse(read('package.json')).files;
    expect(f.filter((x) => x === 'NOTICE')).toHaveLength(1);
  });
  it('R12 — ux-reviewer.md ne copie ni l’auteur ni le dépôt : aucune URL github', () => {
    expect(ux).not.toMatch(/github\.com/i);
  });
});

describe('R12/L448 — chaînes interdites, casse et variantes, partout sous agents/ et templates/', () => {
  const interdit = ['knowledge-work-plugins', 'design-critique', 'ux-copy', 'accessibility-review', 'anthropic'];
  for (const f of [...tous('agents'), ...tous('templates/orchestrate')]) {
    it(`R12 — ${f} sans chaîne interdite (insensible à la casse)`, () => {
      const t = read(f).toLowerCase();
      for (const s of interdit) expect(t, s).not.toContain(s);
    });
  }
});

describe('R6 — grille', () => {
  it('R6 — le titre « ## Delivery grid » est unique et dernier du fichier', () => {
    expect(ux.match(/^## Delivery grid$/gm)).toHaveLength(1);
    const apres = ux.slice(ux.indexOf('## Delivery grid') + 5);
    expect(apres).not.toMatch(/^## /m);
  });
  it('R6 — la réponse courte reste à 15 lignes au plus et ne cite aucun point de la grille', () => {
    const c = ux.slice(ux.indexOf('## Short reply'), ux.indexOf('## Delivery grid'));
    for (const s of ['prefers-reduced-motion', 'cursor: pointer', '375', 'emoji']) expect(c, s).not.toContain(s);
  });
  it('R6 — chaque largeur 375, 768, 1024, 1440 apparaît exactement dans la grille et le mode maquette garde 390', () => {
    const g = ux.slice(ux.indexOf('## Delivery grid'));
    for (const w of ['375', '768', '1024', '1440']) expect(g, w).toContain(w);
    expect(g).not.toContain('390 px px');
    expect(ux.slice(0, ux.indexOf('## Delivery grid'))).not.toMatch(/\b375\b/);
  });
  it('R6 — la grille dit ce qu’elle fait d’un point non applicable (pas d’élément cliquable / aucune animation)', () => {
    const g = plat(ux.slice(ux.indexOf('## Delivery grid')));
    expect(g).toMatch(/not applicable|n\/a|non applicable|nothing to check/i);
  });
});

describe('R8/R9 — tics', () => {
  const g = ux.slice(ux.indexOf('## Delivery grid'));
  const regles = g.split('\n').filter((l) => /^- `tic-/.test(l));
  it('R8 — chaque règle de tic a un identifiant unique (pas de doublon)', () => {
    const ids = regles.map((l) => l.match(/^- `([^`]+)`/)![1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });
  it('R9 — le texte donne la chaîne exacte « tics d’IA : 0 constat » ou l’équivalent exact attendu par la fiche', () => {
    expect(g).toContain('tics d’IA : 0 constat');
  });
  it('R9 — le texte donne la chaîne « non applicable » pour un lot sans front', () => {
    expect(g).toContain('tics d’IA : non applicable');
  });
  it('R10 — la charte prime : la phrase d’exception figure dans la section tics', () => {
    expect(plat(g)).toMatch(/charter/i);
    expect(plat(g)).toMatch(/choice of the product's charter|charter (makes|documents|chose|prime)|unless the charter|except/i);
  });
});

describe('R11 — pas de catalogue de styles', () => {
  const styles = /glassmorphi|brutalis|neumorph|neomorph|claymorph|skeuomorph|bento|cyberpunk|vaporwave|memphis|aurora/i;
  for (const [n, t] of [['spec-writer', writer], ['ux-reviewer', ux]] as const) {
    it(`R11 — ${n}.md ne nomme aucun style de catalogue`, () => {
      expect(t).not.toMatch(styles);
    });
  }
  it('R11 — le brief spec.md ne nomme aucun style de catalogue', () => {
    expect(read('templates/orchestrate/spec.md')).not.toMatch(styles);
  });
});

describe('R1/R4 — brief et agent cohérents', () => {
  it('R4 — spec-writer.md et spec.md citent le même seuil 4.5:1, aucun autre seuil (3:1, 7:1)', () => {
    for (const t of [writer, read('templates/orchestrate/spec.md')]) {
      expect(t).toContain('4.5:1');
      expect(t).not.toMatch(/\b3:1\b|\b7:1\b/);
    }
  });
  it('R4 — le paragraphe des jetons n’interrompt pas la liste numérotée (étape 3 suit l’étape 2 sans trou)', () => {
    const i = writer.indexOf('**Colours you add');
    const avant = writer.slice(0, i);
    expect(avant.trimEnd().split('\n').pop()).toMatch(/^\s+/);
    expect(writer.slice(i)).toMatch(/^[\s\S]*\n3\. /);
    // le paragraphe est indenté comme la suite de l'étape 2
    expect(writer.slice(i - 3, i)).toMatch(/^\s{3}$|\n   $/);
  });
  it('R4 — contraste.md n’est lu par aucun code source (fichier libre)', () => {
    for (const f of tous('src')) expect(read(f), f).not.toContain('contraste.md');
  });
  it('R13 — les deux agents gardent un front matter fermé et une ligne name/description', () => {
    for (const t of [writer, ux]) {
      expect(t.startsWith('---\n')).toBe(true);
      expect(t.indexOf('\n---\n', 4)).toBeGreaterThan(0);
      expect(t).toMatch(/^name: /m);
      expect(existsSync(join(root, 'NOTICE'))).toBe(true);
    }
  });
});
