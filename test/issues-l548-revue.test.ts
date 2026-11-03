import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { gitRepo, tempDir } from './helpers.js';

const lot = (id: string, status: string, title: string) => `  - id: ${id}\n    title: ${JSON.stringify(title)}\n    status: ${status}\n    estimate: 1\n`;

function writePlan(dir: string, lots: string, changelog = '# Changelog\n\n## [Unreleased]\n'): void {
  mkdirSync(join(dir, '.cadence'), { recursive: true });
  writeFileSync(join(dir, '.cadence/raf.yaml'), `version: 1\nproject: demo\nprefix: L\nlots:\n${lots}`);
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
}

function fakeGh(json: string): NodeJS.ProcessEnv {
  const bin = tempDir();
  writeFileSync(join(bin, 'json'), json);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncat "$(dirname "$0")/json"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { PATH: `${bin}:/usr/bin:/bin` };
}

async function tour(dir: string, env: NodeJS.ProcessEnv, ...extra: string[]) {
  const out: string[] = [];
  await run(['lead', 'tour', ...extra], { cwd: dir, env: { RAF_TODAY: '2026-11-03', CADENCE_HOME: tempDir(), ...env }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-11-03T09:00:00') });
  return out.join('\n');
}

const GH = JSON.stringify([{ number: 20, title: 't' }]);

describe('issues suivies — revue (L548)', () => {
  it('un lot d’un autre projet cité dans le CHANGELOG (« finance L9 ») ne rend pas publié le lot du même numéro', async () => {
    const dir = tempDir();
    const repo = gitRepo(dir);
    writePlan(repo, lot('L9', 'done', 'x (issue #20)'), '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-10-01\n\n- Relancé (finance L9 of the wave 2026-10-23).\n');
    const out = await tour(repo, fakeGh(GH));
    expect(out).not.toMatch(/issue #20 « t » · ouverte, mais/);
  });
  it('« lot L9 », « (L9, » et « under L9 » citent bien le lot', async () => {
    for (const cite of ['lot L9', '(L9, L10)', 'under L9', 'L8 and L9']) {
      const repo = gitRepo();
      writePlan(repo, lot('L9', 'done', 'x (issue #20)'), `# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-10-01\n\n- Fait, ${cite}.\n`);
      expect(await tour(repo, fakeGh(GH))).toMatch(/issue #20 « t » · ouverte, mais L9 est publié/);
    }
  });
  it('tour lancé d’un dossier parent : chaque ligne d’issue porte le chemin du projet', async () => {
    const parent = tempDir();
    for (const name of ['a', 'grp/b']) {
      const p = join(parent, name);
      mkdirSync(p, { recursive: true });
      const repo = gitRepo(p);
      writePlan(repo, lot('L1', 'todo', 'rien'));
    }
    const out = await tour(parent, fakeGh(GH), '--depth', '3');
    expect(out).toMatch(/^a\/depot · issue #20 « t » · ouverte, aucun lot/m);
    expect(out).toMatch(/^grp\/b\/depot · issue #20 « t » · ouverte, aucun lot/m);
  });
});
