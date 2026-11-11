import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  home: process.env.HOME, homeFichiers: fs.readdirSync(process.env.HOME), origine: sh('git remote get-url origin'), refsOrigine: sh('git branch -r'), pousse: sh('git push -q origin HEAD:refs/heads/essai'), gitGlobal: sh('git config --global --list'),
  jetons: ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'].filter((v) => process.env[v] !== undefined),
  jetonNpm: sh('npm config get //registry.npmjs.org/:_authToken'),
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
function paquet(o: { test?: string; workflow?: string | null; whatsNew?: string; scripts?: Record<string, string> } = {}): string {
  const dir = gitRepo();
  const put = (f: string, t: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); };
  const scripts = { prepublishOnly: 'node trace.cjs', prepare: 'node -e "require(\'fs\').writeFileSync(\'prepare.txt\', \'ok\')"', test: o.test ?? 'echo test', ...o.scripts };
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
    expect(r.out).toMatch(/✓ npm ci/);
    expect(r.out).toMatch(/✓ npm test/);
    expect(r.out).toMatch(/✓ Publier sur npm → npm run prepublishOnly --if-present && npm pack --dry-run/);
    for (const s of ['actions/checkout@v5 (action GitHub)', 'npm install -g npm@^11.5.1 (installation globale)', 'Le tag correspond à package.json (hors liste blanche', 'sudo apt-get update (commande sudo)', 'La version est-elle déjà au registre (lit le registre npm)', 'Release GitHub (GitHub (gh))']) {
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

  it('le clone est retiré quand une étape est tuée par un signal (statut null), et quand le clone lui-même échoue', () => {
    const tmp = tempDir();
    vi.stubEnv('TMPDIR', tmp);
    // npm lui-même tué : spawnSync rend status null et signal SIGKILL
    const tue = release(paquet({ test: 'kill -KILL $PPID' }), 'patch');
    expect(tue.code).toBe(2);
    expect(tue.err).toMatch(/étape « npm test » \(code SIGKILL\)/);
    expect(readdirSync(tmp).filter((d) => d.startsWith('cadence-ci-'))).toEqual([]);
    // HEAD détaché sur un commit que le clone ne voit pas : le checkout du clone lève avant toute étape
    const dir = paquet();
    git(dir, 'checkout', '-q', '--detach');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'hors branche');
    git(dir, 'branch', '-q', '-D', 'main');
    const casse = release(dir, 'patch');
    expect(casse.code).toBe(2);
    expect(readdirSync(tmp).filter((d) => d.startsWith('cadence-ci-'))).toEqual([]);
  }, 180_000);
});

describe('cadence release — le rejeu ne publie, ne pousse ni n’appelle le réseau avec les identifiants de l’utilisateur (revue L698 r1, D-16)', () => {
  /** Chaque forme de la revue, plus les sous-shells, tubes et redirections : un marqueur (touch) dans chaque étape prouve qu'elle n'a pas tourné. */
  const FORMES: [string, string, RegExp][] = [
    ['echo puis git push', 'echo "tagging" && touch m-push && git push origin --tags', /pousse \(git push\)/],
    ['echo puis curl', 'echo start; touch m-curl; curl -X POST https://x', /réseau/],
    ['if then else', 'if [ -n "$X" ]; then echo skip; else touch m-if; fi', /caractère « \[ » du shell/],
    ['point-virgule', 'npm test; touch m-pv', /caractère « ; » du shell/],
    ['et logique', 'npm test && touch m-et', /caractère « & » du shell/],
    ['tube', 'npm test | touch m-tube', /caractère « \| » du shell/],
    ['sous-shell', '(touch m-sous && npm test)', /caractère « \( » du shell/],
    ['substitution', 'npm test $(touch m-subst)', /caractère « \$ » du shell/],
    ['accent grave', 'npm test `touch m-grave`', /caractère « ` » du shell/],
    ['redirection', 'npm test > m-redir', /caractère « > » du shell/],
    ['ligne inconnue', 'npm ci\ntouch m-ligne', /« touch » n'est pas une commande reconnue/],
    ['pnpm publish', 'touch m-pnpm && pnpm publish', /publication \(pnpm\/yarn\/changeset\/semantic-release\)/],
    ['yarn publish', 'yarn publish --non-interactive', /publication \(pnpm\/yarn\/changeset\/semantic-release\)/],
    ['changeset publish', 'npx changeset publish', /publication \(pnpm\/yarn\/changeset\/semantic-release\)/],
    ['semantic-release', 'npx semantic-release', /publication \(pnpm\/yarn\/changeset\/semantic-release\)/],
    ['git -C push', 'git -C . push', /pousse \(git push\)/],
    ['docker push', 'docker push acme/ci', /pousse \(docker push\)/],
    ['wrangler deploy', 'npx wrangler pages deploy dist', /déploiement/],
    ['npm run publish', 'npm run publish', /script npm « publish »/],
    ['npm run d’un script qui publie', 'npm run livrer', /le script npm « livrer » publie ou pousse/],
    ['npm run d’un script qui en appelle un qui pousse', 'npm run tout', /le script npm « pousser » publie ou pousse/],
    ['npm test dont le posttest publie', 'npm test', /le script npm « posttest » publie ou pousse/],
    ['autre sous-commande npm', 'npm exec -- touch m-exec', /« npm exec » n'est pas une commande reconnue/],
  ];
  const workflow = (runs: string[]) => `name: publish\non:\n  push:\n    tags: ['v*']\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n${runs.map((r, i) => `      - name: forme ${i}\n        run: |\n${r.split('\n').map((l) => `          ${l}`).join('\n')}\n`).join('')}`;
  const scripts = { livrer: 'npm run build && npm publish', tout: 'npm run pousser', pousser: 'git push origin HEAD', posttest: 'changeset publish' };

  it('chaque forme est classée non rejouée, avec sa raison', () => {
    const dir = paquet({ workflow: workflow(FORMES.map(([, r]) => r)), scripts });
    const etapes = workflowsCI(dir)[0].etapes;
    expect(etapes).toHaveLength(FORMES.length);
    FORMES.forEach(([forme, , raison], i) => {
      expect(etapes[i].commandes, forme).toBeUndefined();
      expect(etapes[i].sautee, forme).toMatch(raison);
    });
  });

  it('cadence release joue le workflow de toutes ces formes sans en exécuter aucune : aucun marqueur, aucun tag poussé dans le dépôt du lead', () => {
    const m = tempDir();
    const dir = paquet({ workflow: workflow(FORMES.map(([, r]) => r.replace(/m-/g, `${m}/m-`))), scripts });
    const r = release(dir, 'patch');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    FORMES.forEach(([forme], i) => expect(r.out, forme).toContain(`– non rejouée : forme ${i} (`));
    expect(r.out).not.toMatch(/✓ forme/);
    expect(readdirSync(m)).toEqual([]);
    expect(git(dir, 'tag', '--list')).toBe('');
  }, 180_000);

  it('npm publish, même chaîné après un echo, n’est jamais joué : remplacé par prepublishOnly puis npm pack --dry-run, le reste de l’étape ne tourne pas', () => {
    const m = tempDir();
    const etapes = [`echo "Publishing $V" && touch ${m}/m-a && npm publish --access public`, `echo ok; touch ${m}/m-b; npm publish`];
    const dir = paquet({ workflow: workflow(etapes) });
    const lire = trace();
    const r = release(dir, 'patch');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('✓ forme 0 → npm run prepublishOnly --if-present && npm pack --dry-run');
    expect(r.out).toContain('✓ forme 1 → npm run prepublishOnly --if-present && npm pack --dry-run');
    expect(readdirSync(m)).toEqual([]);
    expect(lire().version).toBe('1.0.1');
  }, 180_000);

  it('une publication remplacée dont prepublishOnly publie : non rejouée', () => {
    const dir = paquet({ workflow: workflow(['npm publish']), scripts: { prepublishOnly: 'npm run livrer', livrer: 'npm publish' } });
    expect(workflowsCI(dir)[0].etapes[0].sautee).toMatch(/le script npm « livrer » publie ou pousse/);
  });

  it('environnement sans identifiants : HOME vide et temporaire (identité git seule), ni .npmrc ni configuration git de l’utilisateur, jetons retirés, origin du clone qui ne mène nulle part', () => {
    const maison = tempDir();
    writeFileSync(join(maison, '.npmrc'), '//registry.npmjs.org/:_authToken=SECRET-NPMRC\n');
    writeFileSync(join(maison, '.gitconfig'), '[user]\n\tname = Utilisateur\n[credential]\n\thelper = store\n');
    const dir = paquet({ workflow: workflow(['npm ci', 'npm publish']) });
    const lire = trace();
    vi.stubEnv('HOME', maison);
    for (const v of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) vi.stubEnv(v, `secret-${v}`);
    vi.stubEnv('NPM_CONFIG_USERCONFIG', join(maison, '.npmrc'));
    const r = release(dir, 'patch');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const t = lire();
    expect(String(t.home).startsWith(maison)).toBe(false);
    expect(t.homeFichiers).toEqual(['.gitconfig']);
    expect(t.gitGlobal).toBe('user.name=cadence-ci\nuser.email=cadence-ci@cadence.invalid');
    expect(t.jetons).toEqual([]);
    expect(t.jetonNpm).not.toContain('SECRET');
    // origin garde ses refs (des tests lisent origin/main) mais ne mène pas au dépôt du lead : le push échoue, rien n'y arrive
    expect(String(t.refsOrigine)).toContain('origin/main');
    expect(String(t.origine).startsWith(dir)).toBe(false);
    expect(t.pousse).toBe('erreur');
    expect(git(dir, 'branch', '--list', 'essai')).toBe('');
    expect(r.out).toMatch(/environnement sans identifiants : HOME vide et temporaire/);
  }, 180_000);

  it('le workflow est lu dans le clone du commit de version : un workflow absent du commit (non suivi) n’est pas rejoué (revue L698 r1, point 2)', () => {
    const dir = paquet({ workflow: workflow(['npm ci']) });
    writeFileSync(join(dir, '.github/workflows/brouillon.yml'), workflow(['npm run inexistant']).replace('forme 0', 'brouillon'));
    expect(workflowsCI(dir).map((w) => w.fichier)).toContain('.github/workflows/brouillon.yml');
    for (const argv of [['patch', '--dry-run'], ['patch']]) {
      const r = release(dir, ...argv);
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/forme 0/);
      expect(r.out).not.toMatch(/brouillon|npm run inexistant/);
    }
  }, 180_000);
});

describe('publish.yml de cadence : ce que la release rejoue et ce qu’elle laisse à la CI', () => {
  const root = join(import.meta.dirname, '..');
  it('rejouées : npm ci et la publication (prepublishOnly puis npm pack --dry-run, qui joue prepare) ; non rejouées : actions, npm global, contrôles en shell, apt, identité git globale, registre, gh', () => {
    const wfs = workflowsCI(root);
    expect(wfs.map((w) => w.fichier)).toEqual(['.github/workflows/publish.yml']);
    const etapes = wfs[0].etapes;
    const jouees = etapes.filter((e) => e.commandes).map((e) => e.nom);
    expect(jouees).toEqual([
      'npm ci',
      'Publier sur npm → npm run prepublishOnly --if-present && npm pack --dry-run',
    ]);
    const sautees = etapes.filter((e) => e.sautee).map((e) => `${e.nom} (${e.sautee})`);
    expect(sautees).toEqual([
      'actions/checkout@v5 (action GitHub)',
      'actions/setup-node@v5 (action GitHub)',
      'npm install -g npm@^11.5.1 (installation globale)',
      'Le tag correspond à package.json et aux fichiers du plugin (hors liste blanche : caractère « ; » du shell)',
      'Le CHANGELOG a une section pour le tag (hors liste blanche : caractère « " » du shell)',
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
