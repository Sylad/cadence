import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const lire = (p: string) => readFileSync(join(root, p), 'utf8');
const mots = (liste: string) => [...liste.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();

describe('classe de taille d’un lot : cadence perf et le collecteur du mod (L414)', () => {
  it('R1 — la chaîne spec du collecteur Python (collect.ts) est celle de cadence perf (src/perf.ts) : la classe « +spec » du panneau est celle de `lotMinutes`', () => {
    const perf = /const SPEC_CHAIN = new Set\(\[([^\]]*)\]\)/.exec(lire('src/perf.ts'));
    const mod = /^SPEC_CHAIN = \(([^)]*)\)/m.exec(lire('plugins/cadence-hud/hooks/collect.ts'));
    expect(perf, 'SPEC_CHAIN introuvable dans src/perf.ts').not.toBeNull();
    expect(mod, 'SPEC_CHAIN introuvable dans collect.ts').not.toBeNull();
    expect(mots(mod![1]!)).toEqual(mots(perf![1]!));
    expect(mots(perf![1]!).length).toBeGreaterThan(0);
  });
});
