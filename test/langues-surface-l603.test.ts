import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLinks } from '../scripts/check-links.mjs';

// L603 (E9 + E11 de docs/etudes/ensemble-2026-11.md) : la convention des langues est écrite,
// les comptes périmés d'overview.md et de stabilite.md sont retirés.
const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const readme = read('README.md');
const stabilite = read('docs/stabilite.md');
const overview = read('docs/overview.md');

const langues = stabilite.slice(stabilite.indexOf('## Languages'), stabilite.indexOf('\n## ', stabilite.indexOf('## Languages') + 1) === -1 ? undefined : stabilite.indexOf('\n## ', stabilite.indexOf('## Languages') + 1));

describe('la surface du compte pro : langues et comptes (L603)', () => {
  it('R1 — le README dit en une ligne : noms en anglais, messages en français, et renvoie à stabilite.md', () => {
    const ligne = readme.split('\n').find((l) => /English/.test(l) && /French/.test(l));
    expect(ligne, 'une ligne du README nomme l’anglais et le français').toBeDefined();
    expect(ligne).toContain('docs/stabilite.md#languages');
    expect(checkLinks(root, ['README.md'])).toEqual([]);
  });

  it('R2 — stabilite.md a une section « Languages » : noms et documentation en anglais, messages en français, nouveaux noms en anglais', () => {
    expect(stabilite).toContain('## Languages');
    expect(langues).toMatch(/names[^.]*English/i);
    expect(langues).toMatch(/messages[^.]*French/i);
    expect(langues).toMatch(/new names? (is|are) in English/i);
  });

  it('R3 — la section liste les noms français garantis (clés et options) et dit qu’aucun alias n’est ajouté', () => {
    for (const n of ['maquette', 'maquetteReviews', 'fiche', '--quoi', '--largeur', '--seuil', '--porteur', '--sans-rendu', '--cache-sous-causes']) {
      expect(langues, n).toContain('`' + n + '`');
    }
    expect(langues).toMatch(/no alias/i);
  });

  it('R4 — chaque option française de la section existe dans src/cli/context.ts, chaque clé dans src/config.ts', () => {
    const context = read('src/cli/context.ts');
    for (const o of ['quoi', 'largeur', 'seuil', 'porteur', 'sans-rendu', 'cache-sous-causes']) expect(context, o).toMatch(new RegExp(`'${o}'|\\b${o}:`));
    const config = read('src/config.ts');
    for (const k of ['maquette', 'maquetteReviews', 'fiche']) expect(config, k).toContain(k);
  });

  const skillsGaranti = stabilite.slice(stabilite.indexOf('names of the skills'), stabilite.indexOf('**and of the agents**'));

  it('R5 — stabilite.md garantit les cinq skills, orchestrate compris', () => {
    for (const s of ['session-start', 'session-close', 'deliver', 'lead', 'orchestrate']) expect(skillsGaranti, s).toContain('`' + s + '`');
  });

  it('R6 — chaque skill du dépôt est garanti dans stabilite.md', () => {
    for (const s of readdirSync(join(root, 'skills'))) expect(skillsGaranti, s).toContain('`' + s + '`');
  });

  it('R7 — overview.md et stabilite.md ne comptent plus les outils, skills et agents en toutes lettres', () => {
    for (const [nom, texte] of [['overview.md', overview], ['stabilite.md', stabilite]] as const) {
      expect(texte, nom).not.toMatch(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|\d+) (tools|skills|reviewer agents|agents)\b/i);
    }
    expect(overview).not.toMatch(/The four tools in short/);
  });

  it('R8 — overview.md nomme toujours les skills, les agents relecteurs et la bande (le retrait des chiffres ne retire pas les noms)', () => {
    for (const n of ['session-start', 'session-close', 'deliver', 'lead', 'orchestrate', 'ux-reviewer', 'code-reviewer', 'qa-reviewer', 'cadence-hud']) expect(overview, n).toContain(n);
    expect(checkLinks(root, ['docs/overview.md', 'docs/stabilite.md'])).toEqual([]);
  });

  it('R9 — la section ne range pas en français des surfaces écrites en anglais (agents, skills, CHANGELOG, gabarits de briefs)', () => {
    expect(langues).not.toMatch(/messages \([^)]*(briefs|agents|skills|CHANGELOG)/i);
    expect(langues).toMatch(/agents[^.]*English/i);
    expect(langues).toMatch(/CHANGELOG[^.]*English/i);
  });

  it('R10 — les options françaises de `ref` suivent son statut expérimental, seules --porteur et --cache-sous-causes sont garanties', () => {
    const ligneRef = langues.split('\n').find((l) => /--quoi/.test(l)) ?? '';
    expect(ligneRef).toMatch(/`cadence ref`/);
    expect(ligneRef).toMatch(/experimental/i);
    const garantie = langues.split('\n').find((l) => /guaranteed surfaces/.test(l)) ?? '';
    expect(garantie).toContain('`--porteur`');
    expect(garantie).toContain('`--cache-sous-causes`');
    for (const o of ['--quoi', '--largeur', '--seuil', '--sans-rendu']) expect(garantie.split('guaranteed surfaces')[0], o).not.toContain(o);
    expect(ligneRef).not.toMatch(/guaranteed like any other/);
  });

  it('R11 — les prompts tenus dans le code sont rangés en français, pas parmi les textes anglais des modèles', () => {
    expect(langues).toMatch(/prompts[^.]*(in the code|held in the code)[^.]*French/i);
  });
});
