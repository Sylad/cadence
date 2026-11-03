import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { issueNumbers } from '../src/issues.js';
import { gitRepo, tempDir } from './helpers.js';

const lot = (id: string, status: string, title: string, notes = '') => `  - id: ${id}\n    title: ${JSON.stringify(title)}\n    status: ${status}\n    estimate: 1\n${notes ? `    notes:\n      - { date: 2026-11-03, text: ${JSON.stringify(notes)} }\n` : ''}`;

function project(lots: string, changelog = '# Changelog\n\n## [Unreleased]\n'): string {
  const dir = gitRepo();
  mkdirSync(join(dir, '.cadence'));
  writeFileSync(join(dir, '.cadence/raf.yaml'), `version: 1\nproject: demo\nprefix: L\nlots:\n${lots}`);
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}

function fakeGh(json: string): NodeJS.ProcessEnv {
  const bin = tempDir();
  writeFileSync(join(bin, 'json'), json);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncat "$(dirname "$0")/json"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { PATH: `${bin}:/usr/bin:/bin` };
}

async function tour(dir: string, env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const code = await run(['lead', 'tour'], { cwd: dir, env: { RAF_TODAY: '2026-11-03', CADENCE_HOME: tempDir(), ...env }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-11-03T09:00:00') });
  return { code, out: out.join('\n') };
}

describe('issueNumbers — bords (L548)', () => {
  it('ponctuation finale : « issue #20. » et « (issue #20) »', () => {
    expect(issueNumbers('Réglée (issue #20).')).toEqual([20]);
    expect(issueNumbers('voir issue #20.')).toEqual([20]);
  });
  it('trois numéros : « issues #20, #21 et #22 »', () => {
    expect(issueNumbers('issues #20, #21 et #22')).toEqual([20, 21, 22]);
  });
  it('« issue #20 and #21 » et « issues #20 & #21 »', () => {
    expect(issueNumbers('issue #20 and #21')).toEqual([20, 21]);
    expect(issueNumbers('issues #20 & #21')).toEqual([20, 21]);
  });
  it('un #n après une conjonction éloignée n’est pas cité', () => {
    expect(issueNumbers('issue #20 puis plus tard #21')).toEqual([20]);
  });
  it('texte enveloppé : « issue\\n#20 » ou deux espaces', () => {
    expect(issueNumbers('issue\n#20')).toEqual([20]);
    expect(issueNumbers('issue  #20')).toEqual([20]);
  });
  it('numéro suivi de lettres : « issue #20a » ne cite pas 20', () => {
    expect(issueNumbers('issue #20abc')).toEqual([]);
  });
  it('mot collé : « issues#20 » et « tissue #20 » ne citent rien', () => {
    expect(issueNumbers('tissue #20')).toEqual([]);
  });
});

describe('cadence lead tour — issues, bords (L548)', () => {
  it('un titre d’issue sur plusieurs lignes reste sur une seule ligne du tour', async () => {
    const dir = project(lot('L1', 'todo', 'Autre'));
    const { out } = await tour(dir, fakeGh(JSON.stringify([{ number: 7, title: 'ligne un\nligne deux' }])));
    const l = out.split('\n').find((x) => x.includes('issue #7'));
    expect(l).toBeDefined();
    expect(l).toMatch(/aucun lot du plan ne la cite/);
  });
  it('une entrée mal formée (numéro en chaîne, titre null) n’empêche pas les valides', async () => {
    const dir = project(lot('L1', 'todo', 'Autre'));
    const { code, out } = await tour(dir, fakeGh(JSON.stringify([{ number: '3', title: 'x' }, { number: 4, title: null }, null, { number: 5, title: 'ok' }])));
    expect(code).toBe(0);
    expect(out).toMatch(/issue #5 « ok »/);
    expect(out).not.toMatch(/issue #3 «/);
  });
  it('la même issue deux fois dans la liste gh : une seule ligne', async () => {
    const dir = project(lot('L1', 'todo', 'Autre'));
    const { out } = await tour(dir, fakeGh(JSON.stringify([{ number: 5, title: 'ok' }, { number: 5, title: 'ok' }])));
    expect(out.match(/issue #5 «/g) ?? []).toHaveLength(1);
  });
  it('lot publié mais pas clos (doing) cité dans une version : pas de ligne « la fermer »', async () => {
    const dir = project(lot('L9', 'doing', 'x (issue #20)'), '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-10-01\n\n- (L9).\n');
    const { out } = await tour(dir, fakeGh(JSON.stringify([{ number: 20, title: 't' }])));
    expect(out).not.toMatch(/issue #20 «/);
  });
  it('lot publié cité dans une version de plusieurs sections : [Unreleased] au milieu n’efface pas la version suivante', async () => {
    const dir = project(lot('L9', 'done', 'x (issue #20)'), '# Changelog\n\n## [Unreleased]\n\n- rien\n\n## [1.0.0] - 2026-10-01\n\n- (L9).\n');
    const { out } = await tour(dir, fakeGh(JSON.stringify([{ number: 20, title: 't' }])));
    expect(out).toMatch(/issue #20 « t » · ouverte, mais L9 est publié/);
  });
  it('CHANGELOG avec fins de ligne CRLF : le lot publié est reconnu', async () => {
    const dir = project(lot('L9', 'done', 'x (issue #20)'), '# Changelog\r\n\r\n## [Unreleased]\r\n\r\n## [1.0.0] - 2026-10-01\r\n\r\n- (L9).\r\n');
    const { out } = await tour(dir, fakeGh(JSON.stringify([{ number: 20, title: 't' }])));
    expect(out).toMatch(/issue #20 « t » · ouverte, mais L9 est publié/);
  });
  it('plan absent (pas de .cadence) : le tour tourne, sans ligne d’issue', async () => {
    const dir = gitRepo();
    const { code, out } = await tour(dir, fakeGh(JSON.stringify([{ number: 7, title: 't' }])));
    expect(typeof code).toBe('number');
    expect(out).not.toMatch(/issue #7 «/);
  });
  it('la même issue citée par deux lots publiés, tous deux clos : une ligne qui nomme les deux', async () => {
    const dir = project(lot('L1', 'done', 'a (issue #20)') + lot('L2', 'done', 'b (issue #20)'), '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-10-01\n\n- (L1) (L2).\n');
    const { out } = await tour(dir, fakeGh(JSON.stringify([{ number: 20, title: 't' }])));
    expect(out).toMatch(/L1, L2 sont publiés/);
    expect(out.match(/issue #20 «/g)).toHaveLength(1);
  });
});
