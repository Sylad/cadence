// L877 : bancs aether-b68-court r1/r2 et aether-b68 r1 du 25-11. Sortie attendue « grand D rouge / grand A bleu au réglage par
// défaut » : cadence-run 0/3, A 2/3. Les trois sessions cadence-run (brief v2d, norme lue en entier) ont ajouté les grandes lettres
// comme second style, le style normé restant le défaut ; le 22-11 déjà (docs/etudes/banc-b68-court-2026-11-22.md § 3). Le brief v2d
// dit désormais que la demande fixe le résultat visible par défaut, et qu'une référence ne la réduit pas à une option.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { briefRegistre } from '../src/registre.js';

const brief = (b: string) => readFileSync(join(import.meta.dirname, '..', 'briefs', b), 'utf8');
const LIGNE = /^- La demande fixe le résultat ; les pièces et les références disent comment bien le faire, elles ne le réduisent pas\./m;

describe('L877 — brief v2d : la demande se voit au réglage par défaut', () => {
  it('la consigne est dans le brief complet, avec le défaut, l\'option non demandée et le conflit avec une norme', () => {
    const l = brief('bras-sequence-v2d.md').split('\n').find((x) => LIGNE.test(x));
    expect(l).toBeDefined();
    expect(l).toContain('se voit au réglage par défaut');
    expect(l).toContain('sans option qu\'il n\'a pas demandée');
    expect(l).toContain('Si une norme ou une décision du dépôt s\'y oppose, cherche le rendu qui tient les deux ; s\'il n\'existe pas, pose la question.');
  });

  it('elle vient après la lecture des références, et avant le travail', () => {
    const t = brief('bras-sequence-v2d.md');
    const i = t.search(LIGNE);
    expect(i).toBeGreaterThan(t.indexOf('Avant d\'écrire du code, lis en entier'));
    expect(i).toBeLessThan(t.indexOf('Fais le changement avec ses tests'));
  });

  it('cadence run la garde dans le brief envoyé, quel que soit le choix du registre', () => {
    // mêmes filtres que executerRun (run.ts) : registre, puis ligne « Taille » retirée
    for (const choix of [undefined, 'humaine', 'D-3']) {
      const envoye = briefRegistre(choix)(brief('bras-sequence-v2d.md')).split('\n').filter((l) => !l.startsWith('- Taille fixée par le gardien')).join('\n');
      expect(envoye, String(choix)).toMatch(LIGNE);
    }
  });

  it('le bras A, la référence du banc, reste Claude seul : il ne la reçoit pas', () => {
    expect(brief('bras-A.md')).not.toMatch(LIGNE);
  });
});
