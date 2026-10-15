import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// L221 — le document de la mesure avant/après de la revue UX jouée une seule fois.
const root = join(import.meta.dirname, '..');
const doc = () => readFileSync(join(root, 'docs/mesures/ux-une-fois-2026-10-15.md'), 'utf8');

describe('mesure avant/après de la revue UX (L221)', () => {
  it('R10 — le document de mesure existe, nomme L221 et donne les sessions ux de finance L75 (avant : 3, vérifiées dans les journaux .cadence/runs)', () => {
    const md = doc();
    expect(md).toContain('L221');
    expect(md).toMatch(/finance L75/);
    expect(md).toMatch(/\| Avant \| 3 \(/);
    // Le journal vit dans le dossier des projets, hors de ce dépôt : relu s'il est là.
    const journal = join(root, '..', '.cadence/runs/2026-10-15-1606/finance-tracker--L75.json');
    if (existsSync(journal)) {
      const steps = (JSON.parse(readFileSync(journal, 'utf8')).steps as { kind: string; status: string }[]).filter((s) => s.kind === 'ux' && s.status === 'ok');
      expect(steps).toHaveLength(3);
    }
  })

  it('R10 — sans journal postérieur, le document porte « après : à relever » et non un nombre inventé', () => {
    const md = doc();
    expect(md).toMatch(/Après : à relever/);
    const apres = md.split('\n').find((l) => l.startsWith('| Après |'))!
    expect(apres).toMatch(/à relever/)
    expect(apres).not.toMatch(/\d/)
  })

  it('R10 — le README renvoie au document de mesure', () => {
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('docs/mesures/ux-une-fois-2026-10-15.md');
  })
})
