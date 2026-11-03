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

const WF = (steps: string, extra = '') => `name: ci\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n${extra}    steps:\n${steps}`;
const GATE = 'orchestrate:\n  precheck: false\n  test: npx vitest run\n  build: npx tsc --noEmit\n';

function project(files: Record<string, string>, config = GATE): string {
  const dir = join(tempDir(), 'p');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'cadence.yaml'), config);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}
const ci = (run: string, files: Record<string, string> = {}, config = GATE) =>
  ciParityGaps(project({ '.github/workflows/ci.yml': WF(`      - run: ${run}\n`), ...files }, config)).map((g) => g.command);

describe('parité porte ↔ CI — bords (L499)', () => {
  it('E1 — python -m pytest est un lanceur reconnu (la clé coupée au « -m » ne le perd pas)', () => {
    expect(ci('python -m pytest')).toEqual(['python -m pytest']);
  });

  it('E2 — mvn -B test est signalé (option avant la cible)', () => {
    expect(ci('mvn -B test')).toEqual(['mvn -B test']);
  });

  it('E3 — xvfb-run npx playwright test est vu comme un test', () => {
    expect(ci('xvfb-run npx playwright test')).toEqual(['xvfb-run npx playwright test']);
  });

  it('E4 — une variable d\'environnement entre guillemets avec espace n\'empêche pas la reconnaissance', () => {
    expect(ci('FOO="a b" npx playwright test')).toEqual(['FOO="a b" npx playwright test']);
  });

  it('E5 — cd backend && npm test lit le package.json de backend/', () => {
    const files = { 'backend/package.json': '{"scripts":{"test":"playwright test"}}' };
    expect(ci('cd backend && npm test', files)).toEqual(['playwright test']);
  });

  it('E6 — un test dans un if/then multi-ligne est vu', () => {
    expect(ci('|\n          if [ -n "$X" ]; then\n            npx playwright test\n          fi')).toEqual(['npx playwright test']);
  });

  it('E7 — npx vitest-foo (autre outil) n\'est pas un lanceur de test', () => {
    expect(ci('npx jest-junit-merge')).toEqual([]);
  });

  it('E8 — pnpm test / yarn test sans package.json sont signalés comme npm test', () => {
    expect(ci('pnpm test')).toEqual(['pnpm test']);
    expect(ci('yarn test')).toEqual(['yarn test']);
  });

  it('E9 — scripts npm cycliques a → b → a : termine, sans exception', () => {
    const files = { 'package.json': '{"scripts":{"a":"npm run b","b":"npm run a"}}' };
    expect(() => ci('npm run a', files, 'orchestrate:\n  test: npm run a\n')).not.toThrow();
  });

  it('E10 — continuation de ligne en CRLF : une seule commande, couverte par la porte', () => {
    const wf = WF('      - run: |\r\n          npx vitest run \\\r\n            --coverage\r\n');
    expect(ciParityGaps(project({ '.github/workflows/ci.yml': wf })).map((g) => g.command)).toEqual([]);
  });

  it('E11 — working-directory hors du dépôt (../) ne lit pas de package.json extérieur et ne lève pas', () => {
    const wf = WF('      - run: npm test\n        working-directory: ../../etc\n');
    expect(() => ciParityGaps(project({ '.github/workflows/ci.yml': wf }))).not.toThrow();
  });

  it('E12 — working-directory numérique ou expression ${{ }} : ne lève pas', () => {
    const wf = WF('      - run: npx playwright test\n        working-directory: ${{ matrix.dir }}\n      - run: npx jest\n        working-directory: 12\n');
    expect(ciParityGaps(project({ '.github/workflows/ci.yml': wf })).map((g) => g.command)).toEqual(['npx playwright test', 'npx jest']);
  });

  it('E13 — workflow vide, null, liste, jobs null, steps objet : aucune erreur', () => {
    for (const body of ['', 'null', '- a\n- b\n', 'jobs:\n', 'jobs:\n  t:\n    steps:\n      run: x\n', 'jobs: [1,2]\n']) {
      expect(ciParityGaps(project({ '.github/workflows/ci.yml': body }))).toEqual([]);
    }
  });

  it('E14 — un dossier nommé x.yml dans workflows/ ne fait pas échouer la lecture', () => {
    const repo = project({ '.github/workflows/ci.yml': WF('      - run: npx jest\n'), '.github/workflows/x.yml/keep': 'a' });
    expect(ciParityGaps(repo).map((g) => g.command)).toEqual(['npx jest']);
  });

  it('E15 — .github/workflows est un fichier : pas d\'exception', () => {
    expect(ciParityGaps(project({ '.github/workflows': 'oops' }))).toEqual([]);
  });

  it('E16 — appel répété : même résultat (pas d\'état partagé)', () => {
    const repo = project({ '.github/workflows/ci.yml': WF('      - run: npx jest\n') });
    expect(ciParityGaps(repo)).toEqual(ciParityGaps(repo));
  });

  it('E17 — une commande de test entre guillemets dans un echo n\'est pas signalée', () => {
    expect(ci('echo "npx playwright test && x"')).toEqual([]);
    expect(ci('echo "a && npx playwright test"')).toEqual([]);
  });

  it('E18 — porte en parties : un dossier avec .. ou absolu ne lève pas', () => {
    const cfg = 'orchestrate:\n  test:\n    - { dir: ., run: npx vitest run }\n    - { dir: sub, run: npm test }\n';
    expect(() => ci('npm test', { 'sub/package.json': '{"scripts":{"test":"jest"}}' }, cfg)).not.toThrow();
  });

  it('E19 — le workflow réel du dépôt : npm test (= vitest run) est couvert, rien de faux n\'est signalé', () => {
    expect(ciParityGaps(process.cwd()).map((g) => g.command)).toEqual([]);
  });

  it('E20 — sous-shells : (cd backend && npm test) && (cd frontend && npx vitest run) est lu, le cd ne fuit pas hors de la parenthèse', () => {
    const files = { 'backend/package.json': '{"scripts":{"test":"jest"}}', 'frontend/package.json': '{"scripts":{"test":"vitest run"}}' };
    const gate = 'orchestrate:\n  test:\n    - { dir: backend, run: npm test }\n    - { dir: frontend, run: npx vitest run }\n';
    expect(ci('(cd backend && npm test) && (cd frontend && npx vitest run)', files, gate)).toEqual([]);
    expect(ci('(cd frontend && npm test)', files, gate)).toEqual([]);
    expect(ci('(cd backend && true); npm test', { ...files, 'package.json': '{"scripts":{"test":"playwright test"}}' }, gate)).toEqual(['playwright test']);
  });

  it('E21 — une option qui désigne une autre suite (-c, --config, --project) fait une autre commande', () => {
    expect(ci('npx vitest run -c vitest.e2e.config.ts')).toEqual(['npx vitest run -c vitest.e2e.config.ts']);
    expect(ci('npx jest --config ./test/jest-e2e.json', {}, 'orchestrate:\n  test: npx jest\n')).toEqual(['npx jest --config ./test/jest-e2e.json']);
    const pw = 'orchestrate:\n  test: npx playwright test --project=chromium\n';
    expect(ci('npx playwright test --project=firefox', {}, pw)).toEqual(['npx playwright test --project=firefox']);
    expect(ci('npx playwright test --project=chromium --headed', {}, pw)).toEqual([]);
  });

  it('E22 — le script test:e2e d\'un package.json (vitest run -c …) n\'est pas couvert par une porte vitest run', () => {
    const files = { 'package.json': '{"scripts":{"test:e2e":"vitest run -c vitest.e2e.config.ts"}}' };
    expect(ci('npm run test:e2e', files)).toEqual(['vitest run -c vitest.e2e.config.ts']);
  });
  it('E23 — une variable d\'environnement devant un script npm ne l\'empêche pas d\'être déplié (CI=true npm test, DEBUG=… npm run test:e2e -- …)', () => {
    const files = { 'package.json': '{"scripts":{"test":"vitest run"}}' };
    expect(ci('CI=true npm test', files)).toEqual([]);
    const wh = { 'frontend/package.json': '{"scripts":{"test:e2e":"vitest run -c vitest.e2e.config.ts"}}' };
    const gate = 'orchestrate:\n  test:\n    - { dir: frontend, run: npm run test:e2e }\n';
    const wf = WF('      - run: DEBUG=pw:api npm run test:e2e -- --reporter=junit\n        working-directory: frontend\n');
    expect(ciParityGaps(project({ '.github/workflows/ci.yml': wf, ...wh }, gate)).map((g) => g.command)).toEqual([]);
    expect(ciParityGaps(project({ '.github/workflows/ci.yml': wf, ...wh })).map((g) => g.command)).toEqual(['vitest run -c vitest.e2e.config.ts']);
  });

  it('E24 — une redirection (2>&1 | tee, > out.log, 2>/dev/null) ne coupe pas la commande et ne compte pas dans la clé', () => {
    expect(ci('npx vitest run 2>&1 | tee log')).toEqual([]);
    expect(ci('npx vitest run > out.log')).toEqual([]);
    expect(ci('npx vitest run 2>/dev/null')).toEqual([]);
    expect(ci('npx vitest run 2>&1 -c vitest.e2e.config.ts')).toEqual(['npx vitest run 2>&1 -c vitest.e2e.config.ts']);
    expect(ci('npx playwright test --reporter=line 2>&1 | tee e2e.log')).toEqual(['npx playwright test --reporter=line 2>&1']);
  });
});
