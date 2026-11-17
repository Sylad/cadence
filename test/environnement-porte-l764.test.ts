// L764 : la porte rendait des rouges trompeurs sur un environnement périmé (cinq fois le 17-11). Avant de jouer, elle lit node_modules contre
// package-lock.json et le Node du PATH contre .nvmrc et engines.node ; périmé, elle ne joue pas et dit la remise à niveau.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { verifyGate } from '../src/verify-gate.js';
import { ecartsLockfile, environnementPerime, satisfait } from '../scripts/environnement-porte.mjs';
import { cleanupTempDirs, gitRepo, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Un lockfile v3 qui demande `paquets` (nom → version). */
const lockfile = (paquets: Record<string, string | { version: string; optional?: boolean }>) =>
  JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'x' }, ...Object.fromEntries(Object.entries(paquets).map(([n, v]) => [`node_modules/${n}`, typeof v === 'string' ? { version: v } : v])) } });

/** Un dossier de projet : package-lock.json, et node_modules/.package-lock.json (ce que npm a installé), éventuellement package.json et .nvmrc. */
function projet(d: string, o: { lock?: Record<string, string>; installe?: Record<string, string>; engines?: string; nvmrc?: string }): string {
  mkdirSync(d, { recursive: true });
  if (o.lock) writeFileSync(join(d, 'package-lock.json'), lockfile(o.lock));
  if (o.installe) {
    mkdirSync(join(d, 'node_modules'), { recursive: true });
    writeFileSync(join(d, 'node_modules', '.package-lock.json'), lockfile(o.installe));
  }
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', ...(o.engines ? { engines: { node: o.engines } } : {}) }));
  if (o.nvmrc) writeFileSync(join(d, '.nvmrc'), `${o.nvmrc}\n`);
  return d;
}

/** Un faux `node` seul sur un PATH, qui répond `version` à --version. */
function pathNode(version: string): Record<string, string | undefined> {
  const bin = join(tempDir(), 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'node'), `#!/bin/sh\necho ${version}\n`);
  chmodSync(join(bin, 'node'), 0o755);
  return { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
}

describe('(a) node_modules contre package-lock.json', () => {
  it('à jour : aucun écart', () => {
    const d = projet(join(tempDir(), 'p'), { lock: { tailwindcss: '4.1.0' }, installe: { tailwindcss: '4.1.0' } });
    expect(ecartsLockfile(d)).toEqual([]);
    expect(environnementPerime(d, process.env, null)).toEqual([]);
  });

  it('installé avant le dernier lockfile (cas ol, avatar, codex, jobmail) : le paquet, ses deux versions et la commande npm ci du bon dossier', () => {
    const racine = tempDir();
    projet(racine, {});
    const front = projet(join(racine, 'frontend'), { lock: { tailwindcss: '4.1.0', vite: '6.0.0' }, installe: { tailwindcss: '3.4.17', vite: '6.0.0' } });
    const p = environnementPerime(racine, process.env, null);
    expect(p).toHaveLength(1);
    expect(p[0].probleme).toBe('frontend/node_modules n\'est pas à jour de frontend/package-lock.json (1 écart(s) : tailwindcss 3.4.17 installé, 4.1.0 au lockfile)');
    expect(p[0].remede).toBe(`cd ${front} && npm ci`);
  });

  it('un paquet demandé et absent compte, un optionnel absent (autre plateforme) non', () => {
    const d = join(tempDir(), 'p');
    mkdirSync(join(d, 'node_modules'), { recursive: true });
    writeFileSync(join(d, 'package-lock.json'), lockfile({ astro: '7.0.0', '@esbuild/darwin-arm64': { version: '0.25.0', optional: true } }));
    writeFileSync(join(d, 'node_modules', '.package-lock.json'), lockfile({}));
    expect(ecartsLockfile(d)).toEqual(['astro absent (7.0.0 au lockfile)']);
  });

  it('sans lockfile caché (installé par un autre outil) ou sans node_modules : rien n\'est jugé', () => {
    const d = projet(join(tempDir(), 'p'), { lock: { a: '1.0.0' } });
    expect(environnementPerime(d, process.env, null)).toEqual([]);
    mkdirSync(join(d, 'node_modules'));
    expect(environnementPerime(d, process.env, null)).toEqual([]);
  });
});

describe('(b) Node du PATH contre .nvmrc et engines.node', () => {
  it.each([
    ['v22.22.3', '>=22.12.0', true],
    ['v22.22.3', '^20.19.0 || >=22.12.0', true],
    ['v22.22.3', '>=24', false],
    ['v18.20.0', '^20.19.0 || >=22.12.0', false],
    ['v20.1.0', '20.x', true],
    ['v21.0.0', '20.x', false],
    ['v20.5.0', '>= 18 < 21', true],
    ['v21.5.0', '18 - 20', false],
    ['v22.0.0', '~22.1', false],
    ['v22.1.9', '~22.1', true],
    ['v22.0.0', 'lts', null],
  ])('%s dans « %s » : %s', (v, plage, attendu) => {
    expect(satisfait(v, plage)).toBe(attendu);
  });

  it('Astro 7 refuse Node 22.22.3 (cas evatosorus, avatar, codex) : engines.node et .nvmrc nommés, avec la remise à niveau', () => {
    const d = projet(join(tempDir(), 'p'), { engines: '>=24.0.0', nvmrc: '24' });
    const p = environnementPerime(d, process.env, 'v22.22.3');
    expect(p.map((x) => x.probleme)).toEqual([
      'le Node du PATH de la porte est v22.22.3, .nvmrc demande 24',
      'le Node du PATH de la porte est v22.22.3, package.json (engines.node) demande >=24.0.0',
    ]);
    expect(p[0].remede).toContain(`cd ${d} && nvm install 24 && nvm use 24`);
    expect(p[0].remede).toContain('relancer cette session');
  });

  it('le Node lu est celui du PATH de la porte, pas celui qui fait tourner cadence', () => {
    const d = projet(join(tempDir(), 'p'), { nvmrc: '24' });
    expect(environnementPerime(d, pathNode('v24.1.0'))).toEqual([]);
    expect(environnementPerime(d, pathNode('v22.22.3')).map((x) => x.probleme)).toEqual(['le Node du PATH de la porte est v22.22.3, .nvmrc demande 24']);
  });

  it('alias (lts/*) ou engines illisible : rien n\'est jugé ; aucune exigence : Node n\'est pas lu', () => {
    expect(environnementPerime(projet(join(tempDir(), 'p'), { nvmrc: 'lts/*', engines: 'lts' }), process.env, 'v10.0.0')).toEqual([]);
    expect(environnementPerime(projet(join(tempDir(), 'q'), {}), process.env, null)).toEqual([]);
  });
});

/** Un dépôt propre dont la porte est `true` et dont l'environnement est périmé de deux façons (node_modules et Node du PATH). */
function depotPerime(yaml = 'orchestrate:\n  test: "true"\n'): { repo: string; sha: string } {
  const repo = gitRepo();
  writeFileSync(join(repo, 'cadence.yaml'), yaml);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'package-lock.json'), lockfile({ tailwindcss: '4.1.0' }));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x', engines: { node: '>=24' } }));
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  mkdirSync(join(repo, 'node_modules'));
  writeFileSync(join(repo, 'node_modules', '.package-lock.json'), lockfile({ tailwindcss: '3.4.17' }));
  return { repo, sha: git(repo, 'rev-parse', 'HEAD') };
}

async function gate(repo: string, sha: string, env: Record<string, string | undefined>) {
  const lines: string[] = [];
  const f = join(repo, 'cadence.yaml');
  const code = await verifyGate({ repo, sha, config: readOrchestrateConfig(f), verify: readVerifyConfig(f), out: (l) => lines.push(l), env });
  return { code, text: lines.join('\n') };
}

describe('verify --gate : environnement périmé détecté avant de jouer', () => {
  it('dans l\'arbre principal : rien n\'est joué, code 2 (pas un verdict), chaque problème avec sa remise à niveau', async () => {
    const { repo, sha } = depotPerime();
    const r = await gate(repo, sha, pathNode('v22.22.3'));
    expect(r.code).toBe(2);
    expect(r.text).toContain(`verify --gate ${sha.slice(0, 7)} : environnement périmé, rien n'est joué`);
    expect(r.text).toContain('tailwindcss 3.4.17 installé, 4.1.0 au lockfile');
    expect(r.text).toContain(`remise à niveau : cd ${repo} && npm ci`);
    expect(r.text).toContain('le Node du PATH de la porte est v22.22.3, package.json (engines.node) demande >=24');
    expect(r.text).not.toMatch(/✓|✗/);
  });

  it('dans une copie jetable : lu dans la copie (dépendances copiées, lockfile au sha)', async () => {
    const { repo, sha } = depotPerime('orchestrate:\n  test: "true"\nverify:\n  inPlace: false\n');
    const r = await gate(repo, sha, pathNode('v24.1.0'));
    expect(r.code).toBe(2);
    expect(r.text).toContain('porte jouée dans une copie jetable');
    expect(r.text).toMatch(/remise à niveau : cd \S*cadence-verify-\S* && npm ci/);
    expect(r.text).not.toContain('le Node du PATH');
  });

  it('CADENCE_PORTE_ENV=jouer : la porte joue quand même et dit qu\'un rouge peut venir de l\'environnement', async () => {
    const { repo, sha } = depotPerime();
    const r = await gate(repo, sha, { ...pathNode('v22.22.3'), CADENCE_PORTE_ENV: 'jouer' });
    expect(r.code).toBe(0);
    expect(r.text).toContain('environnement périmé, porte jouée quand même (CADENCE_PORTE_ENV=jouer)');
    expect(r.text).toContain(`verify --gate ${sha.slice(0, 7)} : vert`);
  });

  it('environnement à jour : la porte joue comme avant', async () => {
    const { repo, sha } = depotPerime();
    writeFileSync(join(repo, 'node_modules', '.package-lock.json'), lockfile({ tailwindcss: '4.1.0' }));
    const r = await gate(repo, sha, pathNode('v24.1.0'));
    expect(r.code).toBe(0);
    expect(r.text).not.toContain('périmé');
  });
});
