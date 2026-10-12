import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// L176 (S8) : la cible de la 3e ligne est fixée par le lead avant la mesure, et la note de conclusion rend un verdict par ligne.
const ROOT = join(__dirname, '..');
const spec = readFileSync(join(ROOT, 'docs', 'superpowers', 'specs', '2026-10-10-etape-spec-design.md'), 'utf8');
const NOTE = join(ROOT, 'docs', 'mesures', 'etape-spec-2026-10-12.md');
const ligne = (md: string, debut: string) => md.split('\n').find((l) => l.startsWith(debut)) ?? '';

describe('mesure de l\'étape spec (L176, S8)', () => {
  it('fixe la 3e ligne à ≤ 8 %, la moitié de la référence de 16 %, comme la ligne 2', () => {
    const l = ligne(spec, '| passes dues à « spec floue »');
    expect(l).toContain('16 % (7 sur 45');
    expect(l).toMatch(/≤ 8 %/);
    expect(l).not.toMatch(/≤ 15 %/);
  });

  it('écrit la note de conclusion avec un verdict par ligne du tableau et le coût à côté des passes évitées', () => {
    expect(existsSync(NOTE)).toBe(true);
    const note = readFileSync(NOTE, 'utf8');
    for (const debut of ['| lots avec au moins 1 correction', '| lots avec au moins 2 corrections', '| passes dues à « spec floue »', '| lot qui revient d\'une revue UX']) {
      expect(ligne(note, debut), debut).toMatch(/\*\*(atteint|non atteint)\*\*/);
    }
    expect(note).toMatch(/≤ 8 %/);
    expect(note).toMatch(/## Coût/);
    expect(note).toMatch(/## Verdict/);
  });

  it('classe 30 passes, et les parts de la note retombent sur le tableau des causes', () => {
    const note = readFileSync(NOTE, 'utf8');
    const cause = (nom: string) => Number(ligne(note, `| ${nom} |`).split('|')[2]?.trim());
    const causes = ['spec floue ou critère absent', 'règle de gestion inventée', 'test manquant', 'dérive d\'architecture', 'bug de code', 'sans revue (tests rouges)'];
    expect(causes.reduce((s, c) => s + cause(c), 0)).toBe(30);
    const trois = cause('spec floue ou critère absent') + cause('règle de gestion inventée') + cause('test manquant');
    expect(ligne(note, '| passes dues à « spec floue »')).toContain(`${Math.round((100 * trois) / 30)} % (${trois} sur 30)`);
  });
});
