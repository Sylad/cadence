import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// L603, bords : les faits que la section « Languages » affirme se lisent dans le dépôt réel.
const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const stabilite = read('docs/stabilite.md');
const debut = stabilite.indexOf('## Languages');
const langues = stabilite.slice(debut);

describe('langues-surface L603 — bords', () => {
  it('B1 — la section Languages est la dernière et existe une seule fois', () => {
    expect(stabilite.split('## Languages').length).toBe(2);
    expect(stabilite.slice(debut + 1)).not.toMatch(/^## /m);
  });

  it('B2 — les fichiers et dossiers français cités existent', () => {
    for (const [nom, chemin] of [['acceptation-<lot>.json', null], ['acceptation.json', null], ['qualite-baseline.json', 'qualite-baseline.json'], ['docs/nouveautes/', 'docs/nouveautes']] as const) {
      expect(langues, nom).toContain('`' + nom + '`');
      if (chemin) expect(existsSync(join(root, chemin)), chemin).toBe(true);
    }
    expect(read('src/orchestrate/accept.ts')).toContain('acceptation-<lot>.json');
    for (const f of ['templates/fiche.yaml', 'templates/fiche-back.yaml', 'templates/inventaire.json']) {
      expect(existsSync(join(root, f)), f).toBe(true);
      expect(langues, f).toContain(f.split('/')[1]);
    }
    for (const cle of ['sujet', 'cas', 'ecran', 'regles']) expect(langues, cle).toContain('`' + cle + '`');
    expect(langues).toContain('claude-hook');
    for (const sous of ['retour', 'attente']) {
      expect(read('hooks/hooks.json'), sous).toContain('claude-hook ' + sous);
    }
  });

  it('B3 — les clés françaises sont celles de ORCH_KEYS, et seulement elles (aucune autre clé en français non listée)', () => {
    const m = /const ORCH_KEYS = \[([^\]]*)\]/.exec(read('src/config.ts'));
    const cles = [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(cles.length).toBeGreaterThan(20);
    for (const k of ['maquette', 'maquetteReviews', 'fiche']) expect(cles).toContain(k);
    const anglais = new Set(cles.filter((k) => !/maquette|fiche/i.test(k)));
    const attendu = cles.filter((k) => /maquette|fiche/i.test(k)).sort();
    expect(attendu).toEqual(['fiche', 'maquette', 'maquetteReviews']);
    expect(anglais.size + attendu.length).toBe(cles.length);
    for (const k of attendu) expect(langues, k).toContain('`' + k + '`');
  });

  it('B4 — les options françaises listées sont déclarées comme options du CLI, pas seulement citées', () => {
    const context = read('src/cli/context.ts');
    for (const o of ['quoi', 'largeur', 'seuil', 'porteur', 'sans-rendu', 'cache-sous-causes']) {
      expect(context, o).toMatch(new RegExp(`(^|\\s)'?${o}'?: *\\{ *type`, 'm'));
    }
  });

  it('B5 — la ligne du README sur stabilite.md tient en 160 caractères', () => {
    const ligne = read('README.md').split('\n').find((l) => l.includes('docs/stabilite.md#languages'));
    expect(ligne).toBeDefined();
    expect((ligne ?? '').length).toBeLessThanOrEqual(160);
  });
});
