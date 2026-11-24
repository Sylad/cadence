import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ciParityGaps } from '../src/orchestrate/ci-parity.js';
import { git } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

/** La porte de l'issue #65, telle quelle : un PATH calculé par une substitution de commande (guillemets imbriqués, pipes). */
const GATE_65 = 'PATH="$(ls -d "$HOME"/.nvm/versions/node/v$(cat .nvmrc)*/bin | sort -V | tail -1):$PATH" CI=1 VITEST_MAX_WORKERS=1 npx ng test --no-watch';

/** Les commandes de la CI (`run`) que la porte (`gate`, écrite en JSON, donc en YAML valide malgré ses guillemets) ne joue pas. */
function gaps(run: string, gate: string): string[] {
  const dir = join(tempDir(), 'p');
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'cadence.yaml'), `orchestrate:\n  precheck: false\n  test: ${JSON.stringify(gate)}\n  build: npx tsc --noEmit\n`);
  writeFileSync(join(dir, '.github/workflows/ci.yml'), `name: ci\non: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: ${JSON.stringify(run)}\n`);
  return ciParityGaps(dir).map((g) => g.command);
}

describe('parité porte ↔ CI — préfixe d\'environnement calculé par une substitution de commande (L780, issue #65)', () => {
  it('S1 — la porte de l\'issue #65, ligne exacte, couvre npx ng test --no-watch de la CI', () => {
    expect(gaps('npx ng test --no-watch', GATE_65)).toEqual([]);
  });

  it('S2 — valeur entre apostrophes contenant $(…) et des pipes : sautée en entier', () => {
    expect(gaps('npx ng test --no-watch', "PATH='$(ls -d x | sort -V | tail -1):$PATH' CI=1 npx ng test --no-watch")).toEqual([]);
  });

  it('S3 — $(…) non quoté, avec guillemets et pipes dedans : sauté en entier', () => {
    expect(gaps('npx ng test --no-watch', 'PATH=$(ls -d "$HOME"/n/v$(cat .nvmrc)*/bin | sort -V | tail -1):$PATH npx ng test --no-watch')).toEqual([]);
  });

  it('S4 — plusieurs préfixes : $(…) imbriqués entre guillemets, backticks avec pipe, arithmétique $((…))', () => {
    const gate = 'A="$(dirname "$(command -v node)")" B=`echo 1 | tr 1 2` N=$((1 + 2)) CI=1 npx ng test';
    expect(gaps('npx ng test --no-watch', gate)).toEqual([]);
  });

  it('S5 — le même préfixe côté CI : la commande de la CI est reconnue et couverte', () => {
    expect(gaps(GATE_65, 'npx ng test')).toEqual([]);
  });

  it('S6 — un vrai écart reste signalé, préfixe calculé côté porte comme côté CI', () => {
    expect(gaps('npx playwright test', GATE_65)).toEqual(['npx playwright test']);
    const ci = 'BROWSERS="$(ls -d "$HOME"/pw | head -1)" npx playwright test';
    expect(gaps(ci, GATE_65)).toEqual([ci]);
  });

  it('S7 — une commande de test cachée dans un sous-shell après && reste lue, et une substitution non fermée ne fait pas d\'exception', () => {
    expect(gaps('(cd web && npx playwright test)', GATE_65)).toEqual(['npx playwright test']);
    expect(() => gaps('X="$(echo a npx playwright test', GATE_65)).not.toThrow();
  });
});
