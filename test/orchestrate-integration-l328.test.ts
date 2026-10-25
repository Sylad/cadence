import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { redExcerpt } from '../src/orchestrate/cycle.js';
import { readOrchestrateConfig } from '../src/config.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// L328 — le précheck de cadence sur Sonnet, et le motif d'un refus à l'intégration qui nomme les tests rouges.
describe('L328 R1 — le précheck de cadence part sur Sonnet', () => {
  it('R1 — le cadence.yaml du projet active le précheck et ne le confie pas au modèle local', () => {
    const cfg = readOrchestrateConfig(join(ROOT, 'cadence.yaml'));
    expect(cfg.precheck).toBe(true);
    expect(cfg.precheckLocal).toBe(false);
  });
});

describe('L328 R3 — redExcerpt nomme les tests rouges', () => {
  const bloquant = (texte: string) => ({ source: 'tests' as const, gravite: 'bloquant' as const, texte });
  it('R3 — constat avec tests nommés : la commande puis chaque nom, sans le deux-points final ni la ligne des déjà rouges', () => {
    const k = bloquant("npx vitest run en échec (code 1) : 2 test(s) rouge(s) qui ne l'étaient pas au sha de départ :\n- test/a.test.ts > R1 — un\n- test/b.test.ts > R2 — deux\n(3 autre(s) test(s) déjà rouge(s) au sha de départ : à ne pas corriger)");
    const out = redExcerpt(k);
    expect(out).toContain('test/a.test.ts > R1 — un');
    expect(out).toContain('test/b.test.ts > R2 — deux');
    expect(out).not.toContain('déjà rouge');
  });
  it('R3 — constat sans nom : la fin de la sortie, jamais « en échec (code 1) : » seul', () => {
    const out = redExcerpt(bloquant('npx vitest run en échec (code 1) :\nligne 1\nFAIL combo\nligne 3'));
    expect(out).toBe('npx vitest run en échec (code 1) ; ligne 1 ; FAIL combo ; ligne 3');
  });
  it('R3 — au-delà de dix tests nommés : dix, puis le nombre des autres', () => {
    const names = Array.from({ length: 13 }, (_, i) => `- t${i}`).join('\n');
    const out = redExcerpt(bloquant(`cmd en échec (code 1) : 13 test(s) rouge(s) :\n${names}`));
    expect(out).toContain('- t9');
    expect(out).not.toContain('- t10');
    expect(out).toContain('… (+3)');
  });
});
