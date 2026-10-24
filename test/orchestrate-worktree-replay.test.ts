import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, git, reviewReport, specReport } from './orchestrate-harness.js';
import { ecritBack } from './spec-helpers.js';
import { fake, planOf, run, setup, store, WAVE, type Handler } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// L279 — R26 hors intégration : un lot rendu sur une écriture de plan refusée (notes d'hypothèses, mineurs de la fiche) est rejoué par --resume --replay
// (décision du lead du 24-10 : l'option de l'intégration, généralisée et renommée).
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

/** Le lead modifie un fichier suivi de son dépôt pendant que la spec travaille : l'écriture de plan qui suit est refusée. */
const dirtyRepo = (repo: string): Handler => (cwd) => {
  writeFileSync(join(repo, 'base.txt'), 'modifié par le lead\n');
  return claudeOut(specReport({ fiche: ecritBack(cwd) }));
};

const wave = (repo: string, fiche?: Handler) =>
  fake({ spec: dirtyRepo(repo), ...(fiche ? { fiche } : {}) });

async function refused(fiche?: Handler) {
  const { parent, repo } = setup([{ title: 'un', spec: true }, { title: 'deux' }]);
  const f = wave(repo, fiche);
  await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
  git(repo, 'checkout', '--', 'base.txt'); // le lead range son dépôt
  return { parent, repo, f };
}

describe('R26 — un lot rendu sur une écriture de plan refusée est reprenable (--replay)', () => {
  it('notes d\'hypothèses refusées : lot rendu avec son étape, --resume seul ne le rejoue pas, --replay le reprend et pose les notes', async () => {
    const { parent, repo } = await refused();
    const l = store(parent).readLot('a', 'L1')!;
    expect(l.status).toBe('handed-back');
    expect(l.next).toBe('implement');
    expect(l.outcome).toMatch(/^notes des hypothèses de la fiche : écriture du plan refusée : arbre du dépôt modifié \(base\.txt\)/);
    expect(planOf(repo).lot('L1').notes.filter((n) => n.text.startsWith('Hypothèses'))).toEqual([]);

    const plain = await run(parent, ['--resume', WAVE], fake());
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back'); // rien n'est rejoué en silence
    expect(plain.out).not.toContain('reprise');

    const g = fake();
    const r = await run(parent, ['--resume', WAVE, '--replay', 'a:L1'], g);
    expect(r.out).toContain("a:L1 → suspended — écriture du plan reprise à l'étape implement (--resume --replay)");
    expect(g.calls.filter((c) => c.lot === 'L1').map((c) => c.kind)).toEqual(['implement', 'review']); // la spec et sa revue ne sont pas rejouées
    expect(store(parent).readLot('a', 'L1')!.status).toBe('ready');
    expect(planOf(repo).lot('L1').notes.filter((n) => n.text.startsWith('Hypothèses')).length).toBeGreaterThan(0);
  });

  it('mineurs de la revue de fiche refusés : --replay rejoue la revue, les notes sont posées, le compte de passes n\'est pas doublé', async () => {
    const minor: Handler = () => claudeOut(reviewReport({ mineurs: 1, constats: [{ gravite: 'mineur', fichier: 'fiche.yaml', ligne: 3, texte: 'libellé à préciser' }], verdict: 'conforme, un mineur' }));
    const { parent, repo } = await refused(minor);
    const l = store(parent).readLot('a', 'L1')!;
    expect(l.status).toBe('handed-back');
    expect(l.next).toBe('fiche');
    expect(l.outcome).toMatch(/^notes des mineurs de la revue de la fiche : écriture du plan refusée/);

    const g = fake({ fiche: minor });
    const r = await run(parent, ['--resume', WAVE, '--replay', 'a:L1'], g);
    expect(r.out).toContain("a:L1 → suspended — écriture du plan reprise à l'étape fiche (--resume --replay)");
    const after = store(parent).readLot('a', 'L1')!;
    expect(after.status).toBe('ready');
    expect(after.fiche?.passes).toBe(1);
    expect(planOf(repo).lot('L1').notes.some((n) => n.text.includes('libellé à préciser'))).toBe(true);
  });

  it('--replay refuse un lot qui n\'est ni rendu à l\'intégration ni sur une écriture de plan refusée ; --integrate garde son sens', async () => {
    const { parent } = await refused();
    store(parent).writeLot({ ...store(parent).readLot('a', 'L2')!, status: 'handed-back', next: null, outcome: 'revue : constats' }); // un rendu qui ne se rejoue pas
    const r = await run(parent, ['--resume', WAVE, '--replay', 'a:L2'], fake());
    expect(r.code).toBe(2);
    expect(r.err).toContain("--replay a:L2 : le lot n'est pas rendu à l'étape d'intégration ni sur une écriture de plan refusée (handed-back, étape aucune : revue : constats)");
    const i = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    expect(i.code).toBe(2);
    expect(i.err).toContain("--integrate a:L1 : le lot n'est pas rendu à l'étape d'intégration");
  });

  it('--replay sans --resume est refusé', async () => {
    const { parent } = setup();
    await expect(run(parent, ['--replay', 'a:L1'], fake())).rejects.toThrow('--replay ne vaut qu\'avec --resume');
  });
});
