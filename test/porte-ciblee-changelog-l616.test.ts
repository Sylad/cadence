import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gateText } from '../src/orchestrate/briefs.js';
import { integratedChecks, programChecks } from '../src/orchestrate/cycle/checks.js';
import { commitFile, harness } from './orchestrate-harness.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// L616 : un lot qui touche CHANGELOG.md joue test/changelog.test.ts dès la porte d'écriture (aucun test n'importe le journal : `vitest related` ne le trouve pas).

afterEach(cleanupTempDirs);
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

/** Le dernier « REL <fichiers> » écrit par la commande liée. */
async function relatedFiles(files: string[], withChangelogTest = true): Promise<string[]> {
  const log = join(tempDir(), 'portes.log');
  const h = harness();
  const config = { test: 'true', testRelated: `echo "REL {files}" >> ${log}; true` };
  const c = Object.assign(h.lot('L1', {}, config), { tree: { dir: h.repo, branch: 'cadence/x', base: 'main', active: true } });
  if (withChangelogTest) {
    mkdirSync(join(h.repo, 'test'));
    commitFile(h.repo, 'test/changelog.test.ts', 'test: changelog');
  }
  // Un commit qui ne touche que CHANGELOG.md est « une simple version » pour le plan, sans sha de départ : un premier commit de code le précède.
  for (const f of ['a.txt', ...files]) commitFile(h.repo, f, 'feat(L1): x');
  await programChecks(c, [], [] as Awaited<ReturnType<typeof integratedChecks>>['runs']);
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return (lines.at(-1) ?? '').replace(/^REL /, '').split(' ').filter(Boolean);
}

describe('L616 — la porte ciblée joue test/changelog.test.ts quand le lot touche CHANGELOG.md', () => {
  it('un lot qui touche CHANGELOG.md : le test du journal s\'ajoute aux fichiers du diff', async () => {
    expect(await relatedFiles(['CHANGELOG.md'])).toEqual(['CHANGELOG.md', 'a.txt', 'test/changelog.test.ts']);
  });
  it('un lot qui ne touche pas CHANGELOG.md : rien ne s\'ajoute', async () => {
    expect(await relatedFiles(['b.txt'])).toEqual(['a.txt', 'b.txt']);
  });
  it('test/changelog.test.ts absent du dépôt (autre projet) : rien ne s\'ajoute', async () => {
    expect(await relatedFiles(['CHANGELOG.md'], false)).toEqual(['CHANGELOG.md', 'a.txt']);
  });
  it('le lot touche déjà test/changelog.test.ts : une seule fois', async () => {
    expect(await relatedFiles(['CHANGELOG.md', 'test/changelog.test.ts'])).toEqual(['CHANGELOG.md', 'a.txt', 'test/changelog.test.ts']);
  });
  it('le brief d\'implémentation dit que CHANGELOG.md se joue avec test/changelog.test.ts et s\'écrit sous [Unreleased]', () => {
    const text = gateText({ test: 'npx vitest run', build: 'npx tsc --noEmit' });
    expect(text).toContain('CHANGELOG.md');
    expect(text).toContain('test/changelog.test.ts');
    expect(text).toContain('[Unreleased]');
  });
});
