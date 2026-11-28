// L941 : sur mini-blue, chaque chemin de Big-Blue d'une source devient celui de son miroir local, dans la ligne « source: » comme dans
// les commandes qui le citent (banc complet rouge du 28-11 : install: git -C /home/…/ol-companion show eb3bada:… gardait le chemin
// de Big-Blue, absent là-bas). Un chemin dont la source n'est qu'un préfixe (ol-companion-x) reste tel quel.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dossierTemp } from './temp.js';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'banc-mini-blue-distant.sh');
/** Les fonctions du script, sans son aiguillage final. */
const FONCTIONS = readFileSync(SCRIPT, 'utf8').split('\nlance()')[0];
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();

/** awk de la machine, puis mawk (celui d'Ubuntu par défaut, donc de mini-blue) et gawk quand ils sont là. */
const AWKS = ['awk', ...['/usr/bin/mawk', '/usr/bin/gawk'].filter(existsSync)];
const resourcer = (awk: string, fichier: string, o: string, n: string) => {
  const t = dossierTemp('l941-awk-'); mkdirSync(join(t, 'bin'));
  if (awk !== 'awk') writeFileSync(join(t, 'bin', 'awk'), `#!/bin/sh\nexec ${awk} "$@"\n`, { mode: 0o755 });
  const r = spawnSync('bash', ['-c', `${FONCTIONS}\nresourcer "$@"`, 'x', fichier, o, n], { env: { ...process.env, PATH: `${join(t, 'bin')}:${process.env.PATH}` }, encoding: 'utf8' });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
};

describe('chemins des sources réécrits vers le miroir de mini-blue (L941)', () => {
  const O = '/home/u/projects/ol-companion', N = '/home/sylva/banc-mini-blue/sources/0123456789ab';
  const AVANT = [
    'projet: ol-companion',
    `source: "${O}"`,
    'base: eb3bada',
    `install: git -C ${O} show eb3bada:backend/package.json > /dev/null && cp -r ${O}/fixtures . && cat ${O}-x/a ${O}x/b /x${O}/c`,
    `tests: "cd '${O}' && npm test"`,
    `notes: ${O}`,
    '',
  ].join('\n');
  const APRES = [
    'projet: ol-companion',
    `source: "${N}"`,
    'base: eb3bada',
    `install: git -C ${N} show eb3bada:backend/package.json > /dev/null && cp -r ${N}/fixtures . && cat ${O}-x/a ${O}x/b /x${O}/c`,
    `tests: "cd '${N}' && npm test"`,
    `notes: ${N}`,
    '',
  ].join('\n');

  for (const awk of AWKS) {
    it(`chaque occurrence entière du chemin, jamais un chemin plus long qui le contient (${awk})`, () => {
      const f = join(dossierTemp('l941-'), 'banc.yaml');
      writeFileSync(f, AVANT);
      resourcer(awk, f, O, N);
      expect(readFileSync(f, 'utf8')).toBe(APRES);
      resourcer(awk, f, O, N); // une seconde passe ne change rien
      expect(readFileSync(f, 'utf8')).toBe(APRES);
    });
  }

  it('la commande install réécrite tourne sur le miroir nu : git -C <miroir> show <base>:<fichier>', () => {
    const t = dossierTemp('l941-miroir-');
    const source = join(t, 'bigblue', 'ol-companion'), miroir = join(t, 'mb', 'sources', 'abc');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'package.json'), '{"name":"ol"}\n');
    git(source, 'init', '-q', '-b', 'main'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'base');
    const base = git(source, 'rev-parse', '--short', 'HEAD');
    git(source, 'bundle', 'create', '-q', join(t, '1.bundle'), '--all');
    mkdirSync(join(t, 'mb', 'sources'), { recursive: true });
    git(t, 'clone', '-q', '--mirror', join(t, '1.bundle'), miroir);
    const f = join(t, 'banc.yaml');
    writeFileSync(f, `source: ${source}\nbase: ${base}\ninstall: git -C ${source} show ${base}:package.json > pkg.json\n`);
    resourcer('awk', f, source, miroir);
    const install = readFileSync(f, 'utf8').match(/^install: (.*)$/m)?.[1] ?? '';
    expect(install).not.toContain(source);
    execFileSync('rm', ['-rf', source]); // comme sur mini-blue : le chemin de Big-Blue n'existe pas
    execFileSync('bash', ['-c', install], { cwd: t });
    expect(readFileSync(join(t, 'pkg.json'), 'utf8')).toBe('{"name":"ol"}\n');
  });
});
