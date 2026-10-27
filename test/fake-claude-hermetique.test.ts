import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const SAMPLE = fileURLToPath(new URL('./fixtures/claude-result.sample.json', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

/** Lance le faux claude pour une étape implement qui commite a.txt, dans `cwd`, avec le brief donné. */
function runFake(cwd: string, brief: string) {
  const dir = tempDir();
  const scenario = join(dir, 'scenario.json');
  const log = join(dir, 'calls.jsonl');
  writeFileSync(scenario, JSON.stringify({ implement: [{ commits: [{ file: 'a.txt', message: 'feat({lot}): travail' }] }] }));
  writeFileSync(log, '');
  // GIT_DIR inexistant : même si la garde manquait, aucun commit ne peut atterrir dans le vrai dépôt.
  const env = { ...process.env, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_SAMPLE: SAMPLE, GIT_DIR: join(dir, 'pas-de-depot') };
  return spawnSync(process.execPath, [FAKE, '-p', brief], { cwd, env, encoding: 'utf8' });
}

describe('faux claude hermétique (L391)', () => {
  it('refuse d\'écrire et de commiter quand son cwd est dans le dépôt cadence', () => {
    const a = join(REPO, 'a.txt');
    const existait = existsSync(a);
    try {
      const r = runFake(REPO, 'Work on lot `L1` of the plan');
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/hermétique/);
      expect(existsSync(a)).toBe(existait);
    } finally {
      if (!existait) rmSync(a, { force: true });
    }
  });

  it('refuse quand le lot du brief n\'est pas résolu ({lot} deviendrait « ? »), même dans un dossier temporaire', () => {
    const cwd = tempDir();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd });
    const r = runFake(cwd, 'un brief sans lot');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/lot non résolu/);
    expect(existsSync(join(cwd, 'a.txt'))).toBe(false);
  });

  it('accepte un dossier temporaire hors du dépôt avec un lot résolu', () => {
    const cwd = tempDir();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd });
    const r = runFake(cwd, 'Work on lot `L1` of the plan');
    expect(r.stderr).not.toMatch(/hermétique|lot non résolu/);
  });
});
