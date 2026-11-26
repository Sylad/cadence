// L877 : bancs aether-b68-court r1/r2 et aether-b68 r1 du 25-11. Sortie attendue « grand D rouge / grand A bleu au réglage par
// défaut » : cadence-run 0/3, A 2/3. Les trois sessions cadence-run (brief v2d, norme lue en entier) ont ajouté les grandes lettres
// comme second style, le style normé restant le défaut. Sur les 7 passages des 22 et 25-11, ce geste revient 5 fois chez cadence-run
// et 3 fois chez A : un écart, pas une règle (docs/etudes/banc-b68-2026-11-25.md § 2). Le brief v2d
// dit désormais que la demande fixe le résultat visible par défaut, et qu'une référence ne la réduit pas à une option.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { briefEnvoye } from '../src/run/run.js';

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
    // la fonction même qu'appelle executerRun (run.ts) : registre, commandes cadence permises, ligne « Taille » retirée
    for (const choix of [undefined, 'humaine', 'D-3']) for (const o of [{}, { specCheck: true, analyse: true }]) {
      const envoye = briefEnvoye(brief('bras-sequence-v2d.md'), choix, o);
      expect(envoye, `${String(choix)} ${JSON.stringify(o)}`).toMatch(LIGNE);
      expect(envoye).not.toMatch(/^- Taille fixée par le gardien/m);
    }
  });

  it('le bras A, la référence du banc, reste Claude seul : il ne la reçoit pas', () => {
    expect(brief('bras-A.md')).not.toMatch(LIGNE);
  });
});
