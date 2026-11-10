import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { run } from '../src/cli.js';
import { readReleaseConfig } from '../src/release-fumee.js';
import { cleanupTempDirs, commit, gitRepo, tempDir } from './helpers.js';

// L696 (D-11, erreur 2 du relevé du 10-11) : dix versions publiées cassées ou rouges, chaque correctif n'ayant bouché qu'un cas
// (2.0.0 et 2.0.1 sans v2/briefs/bras-A.md : cadence run en mode léger plantait chez un utilisateur npm).
// cadence release essaie le paquet réel avant le tag : npm pack de HEAD, installation dans un dossier vide, commandes de fumée.
afterEach(cleanupTempDirs);

const CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A thing (L7).\n\n## [1.0.0] - 2026-10-01\n\n- Old.\n';

/** Un paquet jouet sans dépendance : `acme` lit lib/msg.txt, que `files` publie ou non. */
function paquet(o: { files?: string[]; smoke?: string[]; msgSuivi?: boolean } = {}): string {
  const dir = gitRepo();
  const put = (f: string, t: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); };
  put('package.json', `${JSON.stringify({ name: 'acme-fumee', version: '1.0.0', bin: { acme: 'bin/acme.js' }, files: o.files ?? ['bin', 'lib'] }, null, 2)}\n`);
  put('bin/acme.js', "#!/usr/bin/env node\nimport { readFileSync } from 'node:fs';\nconsole.log(readFileSync(new URL('../lib/msg.txt', import.meta.url), 'utf8'));\n");
  put('CHANGELOG.md', CHANGELOG);
  if (o.smoke) put('cadence.yaml', `release:\n  smoke:\n${o.smoke.map((c) => `    - ${JSON.stringify(c)}`).join('\n')}\n`);
  execFileSync('git', ['add', '.'], { cwd: dir });
  put('lib/msg.txt', 'acme ok');
  if (o.msgSuivi !== false) execFileSync('git', ['add', '.'], { cwd: dir });
  commit(dir, 'chore: initial');
  return dir;
}

function release(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(['release', ...argv], { cwd: dir, env: { RAF_TODAY: '2026-11-10' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-10T09:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const version = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;

describe('cadence release — le paquet essayé avant le tag (L696)', () => {
  it('sans release.smoke, chaque bin est lancé avec --help depuis le paquet installé ; vert : la release se prépare', () => {
    const dir = paquet();
    const r = release(dir, 'patch');
    expect(r.err).toBe('');
    expect(r.out).toMatch(/fumée du paquet : acme-fumee-1\.0\.0\.tgz installé dans un dossier vide/);
    expect(r.out).toMatch(/✓ acme --help/);
    expect(version(dir)).toBe('1.0.1');
  }, 120_000);

  it('un fichier lu par le bin et absent de files : refus avant toute écriture, avec la commande et sa sortie', () => {
    const dir = paquet({ files: ['bin'] });
    const r = release(dir, 'patch');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/release : la fumée du paquet installé est rouge/);
    expect(r.err).toMatch(/\$ acme --help/);
    expect(r.err).toMatch(/ENOENT[\s\S]*msg\.txt/);
    expect(version(dir)).toBe('1.0.0');
  }, 120_000);

  it('le paquet est fait depuis HEAD : un fichier présent mais non commité ne le sauve pas', () => {
    const dir = paquet({ msgSuivi: false });
    expect(existsSync(join(dir, 'lib/msg.txt'))).toBe(true);
    const r = release(dir, 'patch', '--dry-run');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/ENOENT/);
    expect(execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' }).trim().split('\n')).toHaveLength(1);
  }, 120_000);

  it('release.smoke remplace la liste par défaut ; chaque commande voit le paquet installé et sa racine', () => {
    const dir = paquet({ smoke: ['acme', 'test -f "$CADENCE_FUMEE_PAQUET/bin/acme.js"', 'test -f "$CADENCE_FUMEE_RACINE/CHANGELOG.md"', 'echo cassé; exit 3'] });
    const r = release(dir, 'patch', '--dry-run');
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/✓ acme\n[\s\S]*✓ test -f "\$CADENCE_FUMEE_PAQUET/);
    expect(r.err).toMatch(/\$ echo cassé; exit 3 \(code 3\)\ncassé/);
  }, 120_000);

  it('release.smoke se valide : une liste de commandes non vides, aucune autre clé', () => {
    const f = join(tempDir(), 'cadence.yaml');
    writeFileSync(f, 'release:\n  smoke: [cadence --help]\n');
    expect(readReleaseConfig(f)).toEqual({ smoke: ['cadence --help'] });
    writeFileSync(f, 'release:\n  smoke: [""]\n');
    expect(() => readReleaseConfig(f)).toThrow(/release\.smoke/);
    writeFileSync(f, 'release:\n  fumee: []\n');
    expect(() => readReleaseConfig(f)).toThrow(/release\.fumee inconnu/);
    writeFileSync(f, 'docs: {}\n');
    expect(readReleaseConfig(f)).toEqual({});
  });
});

describe('cadence.yaml de cadence : la fumée demandée par D-11', () => {
  const root = join(import.meta.dirname, '..');
  const smoke: string[] = (parse(readFileSync(join(root, 'cadence.yaml'), 'utf8')) as { release: { smoke: string[] } }).release.smoke;
  it('les quatre aides, cadence run en mode léger avec un faux claude, raf check sur un plan jouet', () => {
    for (const c of ['cadence --help', 'cadence run --help', 'raf --help']) expect(smoke).toContain(c);
    for (const s of ['cadence2-aide.mjs', 'run-leger.sh', 'raf-check.sh']) {
      expect(smoke.some((c) => c.includes(`scripts/fumee/${s}`)), s).toBe(true);
      expect(existsSync(join(root, 'scripts/fumee', s)), s).toBe(true);
    }
  });
});
