import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// L358 — la première vague du quickstart doit pouvoir passer sa porte de tests sur un dépôt neuf.
const page = readFileSync(join(import.meta.dirname, '..', 'docs/quickstart.md'), 'utf8');

describe('quickstart : la porte de tests de la première vague (L358)', () => {
  it('Démarrage — le dossier neuf n\'a pas de package.json : la porte ne lance pas npm test', () => {
    const bloc = page.split('## The parent folder')[1].split('Then, from the parent folder')[0];
    expect(bloc).toContain('mkdir alpha');
    expect(bloc).not.toMatch(/^\s*test:\s*npm test/m);
    expect(bloc).toMatch(/^\s*test:\s*test -f hello\.txt/m);
  });

  it('Démarrage — le premier lot demande le fichier que la porte vérifie', () => {
    expect(page).toMatch(/raf add "[^"]*hello\.txt[^"]*"/);
  });

  it('Démarrage — la page dit de remplacer la porte par la vraie commande d\'un projet existant', () => {
    expect(page).toMatch(/real test command|own test command/);
  });
});
