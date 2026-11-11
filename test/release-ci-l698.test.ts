import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { workflowsCI } from '../src/release-ci.js';
import { cleanupTempDirs, commit, gitRepo, tempDir } from './helpers.js';

// L698 (D-14, erreur 2 du relevé du 10-11, suite de L696) : 7 des 10 versions cassées l'ont été dans la CI de publication (publish.yml),
// que la porte jouée dans l'arbre du lead et la fumée du paquet installé ne couvrent pas. Avant tout écrit, cadence release rejoue,
// dans un clone neuf du commit de version (HEAD + fichiers de version, tagué v<version>), les étapes `run` du workflow déclenché par un tag.
afterEach(() => { vi.unstubAllEnvs(); cleanupTempDirs(); });

const CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A thing (L7).\n\n## [1.0.0] - 2026-10-01\n\n- Old.\n';
const WHATS_NEW_SANS = "# What's new\n\n## In two lines\n\n- **1.0.0**: old.\n\n## Version by version\n\nIntro.\n\n**1.0.0**: old long.\n";
const WHATS_NEW_AVEC = "# What's new\n\n## In two lines\n\n- **1.0.1**: new.\n- **1.0.0**: old.\n\n## Version by version\n\nIntro.\n\n**1.0.1**: new long.\n\n**1.0.0**: old long.\n";

/** La trace qu'écrit un script du paquet jouet : où il tourne, sur quel commit, avec quel environnement. */
const TRACE = `const fs = require('fs'), cp = require('child_process');
const sh = (c) => { try { return cp.execSync(c, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'erreur'; } };
fs.writeFileSync(process.env.ACME_TRACE, JSON.stringify({
  cwd: process.cwd(), version: require('./package.json').version, tag: sh('git describe --tags --exact-match'),
  nonSuivi: fs.existsSync('non-suivi.txt'), prepare: fs.existsSync('prepare.txt'), ref: process.env.GITHUB_REF_NAME, ci: process.env.CI,
  whatsNew: fs.readFileSync('docs/whats-new.md', 'utf8'), cadenceVar: process.env.CADENCE_ESSAI ?? null, gitVar: process.env.GIT_AUTHOR_NAME ?? null,
  statut: sh('git status --porcelain'), head: sh('git rev-parse HEAD'),
}));
`;

const WORKFLOW = `name: publish
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - run: npm install -g npm@^11.5.1
      - name: Le tag correspond à package.json
        run: |
          test "v$(node -p "require('./package.json').version")" = "$GITHUB_REF_NAME" \\
            || { echo "tag $GITHUB_REF_NAME ≠ version"; exit 1; }
      - run: |
          sudo apt-get update
          sudo apt-get install -y poppler-utils
      - run: npm ci
      - run: npm test
      - name: La version est-elle déjà au registre
        id: registry
        run: npm view acme-ci version
      - name: Publier sur npm
        if: steps.registry.outputs.published != 'true'
        run: npm publish --access public --provenance
      - name: Release GitHub
        run: gh release create "$GITHUB_REF_NAME"
`;

/** Un paquet jouet sans dépendance, avec son workflow de publication ; `prepublishOnly` écrit la trace. */
function paquet(o: { test?: string; workflow?: string | null; whatsNew?: string } = {}): string {
  const dir = gitRepo();
  const put = (f: string, t: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); };
  const scripts = { prepublishOnly: 'node trace.cjs', prepare: 'node -e "require(\'fs\').writeFileSync(\'prepare.txt\', \'ok\')"', test: o.test ?? 'echo test' };
  put('package.json', `${JSON.stringify({ name: 'acme-ci', version: '1.0.0', scripts, files: ['trace.cjs'] }, null, 2)}\n`);
  put('package-lock.json', `${JSON.stringify({ name: 'acme-ci', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'acme-ci', version: '1.0.0' } } }, null, 2)}\n`);
  put('trace.cjs', TRACE);
  put('CHANGELOG.md', CHANGELOG);
  put('docs/whats-new.md', WHATS_NEW_SANS);
  put('.gitignore', 'prepare.txt\nnode_modules\n');
  if (o.workflow !== null) put('.github/workflows/publish.yml', o.workflow ?? WORKFLOW);
  execFileSync('git', ['add', '.'], { cwd: dir });
  commit(dir, 'chore: initial');
  // Un fichier non suivi, présent dans l'arbre du lead et absent de tout clone (la 1.25.0) ; whats-new modifié mais non commité (le commit de version l'embarque).
  put('non-suivi.txt', 'présent seulement ici');
  put('docs/whats-new.md', o.whatsNew ?? WHATS_NEW_AVEC);
  return dir;
}

function release(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(['release', ...argv], { cwd: dir, env: { RAF_TODAY: '2026-11-11' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-11T09:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const version = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
const git = (dir: string, ...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

function trace() {
  const f = join(tempDir(), 'trace.json');
  vi.stubEnv('ACME_TRACE', f);
  return () => JSON.parse(readFileSync(f, 'utf8')) as Record<string, string | boolean | null>;
}

describe('cadence release — la CI de publication rejouée dans un clone neuf du commit de version (L698)', () => {
  it('vert : chaque étape run rejouable passe dans un clone neuf qui porte le commit de version et son tag ; le clone est retiré ; les étapes système, registre et GitHub sont listées non rejouées', () => {
    const dir = paquet();
    const head = git(dir, 'rev-parse', 'HEAD');
    const lire = trace();
    vi.stubEnv('CADENCE_ESSAI', 'héritée de la session');
    vi.stubEnv('GIT_AUTHOR_NAME', 'héritée d’un hook');
    const r = release(dir, 'patch');
    vi.unstubAllEnvs();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const t = lire();
    // un clone neuf : hors du dépôt, sans le fichier non suivi, retiré après ; le commit de version et le tag que la CI verrait
    expect(String(t.cwd).startsWith(dir)).toBe(false);
    expect(existsSync(String(t.cwd))).toBe(false);
    expect(t.nonSuivi).toBe(false);
    expect(t.version).toBe('1.0.1');
    expect(t.tag).toBe('v1.0.1');
    expect(t.ref).toBe('v1.0.1');
    expect(t.ci).toBe('true');
    expect(t.statut).toBe('');
    expect(t.head).not.toBe(head);
    expect(t.whatsNew).toContain('**1.0.1**: new long.');
    expect(t.prepare).toBe(true);
    expect(t.cadenceVar).toBeNull();
    expect(t.gitVar).toBeNull();
    // le dépôt du lead n'a ni commit ni tag de plus ; les fichiers de version sont écrits après le vert
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(dir, 'tag', '--list')).toBe('');
    expect(version(dir)).toBe('1.0.1');
    expect(r.out).toMatch(/CI de publication rejouée dans un clone neuf du commit de version \(\.github\/workflows\/publish\.yml, tag v1\.0\.1\)/);
    expect(r.out).toMatch(/✓ Le tag correspond à package\.json/);
    expect(r.out).toMatch(/✓ npm ci/);
    expect(r.out).toMatch(/✓ npm test/);
    expect(r.out).toMatch(/✓ Publier sur npm → npm run prepublishOnly --if-present && npm pack --dry-run/);
    for (const s of ['actions/checkout@v5 (action GitHub)', 'npm install -g npm@^11.5.1 (installation globale)', 'sudo apt-get update (commande sudo)', 'La version est-elle déjà au registre (lit le registre npm)', 'Release GitHub (GitHub (gh))']) {
      expect(r.out).toContain(`– non rejouée : ${s}`);
    }
    // le rejeu précède l'écriture et les étapes du lead, qui ne portent plus de clone à jouer à la main
    expect(r.out.indexOf('✓ npm ci')).toBeLessThan(r.out.indexOf('release : 1.0.0 → 1.0.1'));
    expect(r.out).not.toMatch(/git clone/);
  }, 180_000);

  it('rouge : une étape qui échoue refuse la release avec le fichier, l’étape, la commande et sa sortie ; rien n’est écrit, le clone est retiré', () => {
    const lire = trace();
    const dir = paquet({ test: 'node trace.cjs; echo "cassé dans la CI"; exit 3' });
    const r = release(dir, 'patch');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/release : la CI de publication rejouée dans un clone neuf est rouge, rien n'est écrit — \.github\/workflows\/publish\.yml, étape « npm test » \(code 3\)\n\$ npm test\n[\s\S]*cassé dans la CI/);
    expect(r.out).toMatch(/✓ npm ci/);
    expect(r.out).not.toMatch(/✓ npm test/);
    expect(version(dir)).toBe('1.0.0');
    expect(git(dir, 'status', '--porcelain')).not.toMatch(/package\.json/);
    expect(existsSync(String(lire().cwd))).toBe(false);
  }, 180_000);

  it('un test qui dépend d’un fichier non suivi (la 1.25.0) : vert dans l’arbre du lead, rouge dans le clone, release refusée', () => {
    const dir = paquet({ test: 'test -f non-suivi.txt' });
    expect(existsSync(join(dir, 'non-suivi.txt'))).toBe(true);
    const r = release(dir, 'patch');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/étape « npm test » \(code 1\)/);
    expect(version(dir)).toBe('1.0.0');
  }, 180_000);

  it('--dry-run : les étapes qui seraient rejouées sont listées, aucune n’est jouée', () => {
    const lire = trace();
    const dir = paquet();
    const r = release(dir, 'patch', '--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/CI de publication \(\.github\/workflows\/publish\.yml\) : --dry-run ne la rejoue pas ; sans --dry-run, rejouée dans un clone neuf du commit de version :/);
    expect(r.out).toMatch(/▸ npm ci/);
    expect(r.out).toMatch(/▸ Publier sur npm → npm run prepublishOnly/);
    expect(r.out).toMatch(/– non rejouée : Release GitHub/);
    expect(() => lire()).toThrow();
    expect(version(dir)).toBe('1.0.0');
  }, 60_000);

  it('sans workflow déclenché par un tag (publication à la main, ou workflow sur une branche) : rien à rejouer, et c’est dit', () => {
    const lire = trace();
    const sans = paquet({ workflow: null });
    const r1 = release(sans, 'patch');
    expect(r1.code).toBe(0);
    expect(r1.out).toMatch(/CI de publication : aucun workflow déclenché par un tag dans \.github\/workflows — rien à rejouer/);
    const branche = paquet({ workflow: WORKFLOW.replace("tags: ['v*']", 'branches: [main]') });
    const r2 = release(branche, 'patch');
    expect(r2.code).toBe(0);
    expect(r2.out).toMatch(/aucun workflow déclenché par un tag/);
    expect(() => lire()).toThrow();
  }, 60_000);

  it('workflow illisible : refus qui nomme le fichier', () => {
    const dir = paquet({ workflow: 'on: [\n' });
    const r = release(dir, 'patch', '--dry-run');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/release : \.github\/workflows\/publish\.yml illisible/);
  });

  it('le clone est retiré même quand une étape lève (délai, signal) : aucun dossier cadence-ci-* ne reste', () => {
    const dir = paquet({ test: 'exit 7' });
    const r = release(dir, 'patch');
    expect(r.code).toBe(2);
    const tmp = process.env.TMPDIR ?? '/tmp';
    expect(execFileSync('ls', [tmp], { encoding: 'utf8' }).split('\n').filter((d) => d.startsWith('cadence-ci-'))).toEqual([]);
  }, 180_000);
});

describe('publish.yml de cadence : ce que la release rejoue et ce qu’elle laisse à la CI', () => {
  const root = join(import.meta.dirname, '..');
  it('rejouées : le contrôle du tag, la section du CHANGELOG, npm ci et la publication (prepublishOnly puis npm pack --dry-run, qui joue prepare) ; non rejouées : actions, npm global, apt, identité git globale, registre, gh', () => {
    const wfs = workflowsCI(root);
    expect(wfs.map((w) => w.fichier)).toEqual(['.github/workflows/publish.yml']);
    const etapes = wfs[0].etapes;
    const jouees = etapes.filter((e) => e.commande).map((e) => e.nom);
    expect(jouees).toEqual([
      'Le tag correspond à package.json et aux fichiers du plugin',
      'Le CHANGELOG a une section pour le tag',
      'npm ci',
      'Publier sur npm → npm run prepublishOnly --if-present && npm pack --dry-run',
    ]);
    const sautees = etapes.filter((e) => e.sautee).map((e) => `${e.nom} (${e.sautee})`);
    expect(sautees).toEqual([
      'actions/checkout@v5 (action GitHub)',
      'actions/setup-node@v5 (action GitHub)',
      'npm install -g npm@^11.5.1 (installation globale)',
      'git config --global user.name "cadence-ci" (git hors du clone)',
      'sudo apt-get update (commande sudo)',
      'La version est-elle déjà au registre (lit le registre npm)',
      'Release GitHub avec la section du CHANGELOG (GitHub (gh))',
    ]);
    // la commande rejouée pour la publication est bien ce que npm publish joue avant d'envoyer, et prepublishOnly porte la suite
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.prepublishOnly).toMatch(/npm test/);
    expect(pkg.scripts.prepare).toMatch(/tsc/);
  });
});
