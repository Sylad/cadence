import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, harness } from './orchestrate-harness.js';
import { lateRefusal } from '../src/orchestrate/cycle/depot-partage.js';
import { leadMoved, toleratedDirty } from '../src/orchestrate/cycle/plan-writes.js';

// L673 — le prédicat `toleratedDirty` : le plan sale du lead passe, sauf si le diff du lot le touche ; un autre fichier sale refuse.
const PLAN = '.cadence/raf.yaml';

function lotTree(touchesPlan: boolean) {
  const h = harness();
  git(h.repo, 'checkout', '-q', '-b', 'lot');
  appendFileSync(join(h.repo, 'a.txt'), 'travail\n');
  git(h.repo, 'add', '--', 'a.txt');
  if (touchesPlan) appendFileSync(join(h.repo, PLAN), '# écrit par le lot\n');
  git(h.repo, 'add', '--', PLAN);
  git(h.repo, 'commit', '-q', '-m', 'feat(L1): travail');
  git(h.repo, 'checkout', '-q', 'main');
  const c = Object.assign(h.lot('L1'), { tree: { dir: h.repo, branch: 'lot', base: 'main', active: true } });
  return { h, c };
}

describe('L673 — toleratedDirty', () => {
  it('L673 — le plan modifié du lead, hors du diff du lot, est toléré ; un autre fichier ne l\'est pas', () => {
    const { h, c } = lotTree(false);
    const tolerated = toleratedDirty(c, 'lot');
    expect(tolerated(PLAN)).toBe(true);
    expect(tolerated('a.txt')).toBe(false);
    expect(tolerated('autre.txt')).toBe(false);
    appendFileSync(join(h.repo, PLAN), '# ajout du lead\n');
    expect(leadMoved(h.repo, 'main', tolerated)).toBeNull();
  });
  it('L673 — le plan que le diff du lot touche n\'est pas toléré : refus « arbre du dépôt modifié »', () => {
    const { h, c } = lotTree(true);
    const tolerated = toleratedDirty(c, 'lot');
    expect(tolerated(PLAN)).toBe(false);
    appendFileSync(join(h.repo, PLAN), '# ajout du lead\n');
    expect(leadMoved(h.repo, 'main', tolerated)).toMatch(/arbre du dépôt modifié \(\.cadence\/raf\.yaml\)/);
  });
  it('L673 — lateRefusal passe le prédicat : plan sale hors diff accepté, plan dans le diff refusé', () => {
    const free = lotTree(false);
    appendFileSync(join(free.h.repo, PLAN), '# ajout du lead\n');
    expect(lateRefusal(free.h.wave, free.h.repo, 'main', toleratedDirty(free.c, 'lot'))).toBeNull();
    expect(lateRefusal(free.h.wave, free.h.repo, 'main')).toMatch(/arbre du dépôt modifié/);
    const taken = lotTree(true);
    appendFileSync(join(taken.h.repo, PLAN), '# ajout du lead\n');
    expect(lateRefusal(taken.h.wave, taken.h.repo, 'main', toleratedDirty(taken.c, 'lot'))).toMatch(/arbre du dépôt modifié/);
  });
  it('L673 — le diff n\'est pas lu tant qu\'aucun fichier du plan n\'est sale : branche absente sans exception, refus nommé du dépôt sur une autre branche', () => {
    const { h, c } = lotTree(false);
    git(h.repo, 'checkout', '-q', '-b', 'ailleurs');
    git(h.repo, 'branch', '-q', '-D', 'lot');
    const tolerated = toleratedDirty(c, 'lot');
    expect(leadMoved(h.repo, 'main', tolerated)).toBe('le dépôt est sur ailleurs et non sur main');
    expect(tolerated('autre.txt')).toBe(false);
  });
  it('L664 — le plan renommé par le lot (git mv) : l\'ancien chemin, modifié chez le lead, n\'est pas toléré (le diff compte les deux chemins)', () => {
    const { h, c } = lotTree(false);
    git(h.repo, 'checkout', '-q', 'lot');
    git(h.repo, 'mv', PLAN, '.cadence/raf-ancien.yaml');
    git(h.repo, 'commit', '-q', '-m', 'feat(L1): plan déplacé');
    git(h.repo, 'checkout', '-q', 'main');
    appendFileSync(join(h.repo, PLAN), '# ajout du lead\n');
    const tolerated = toleratedDirty(c, 'lot');
    expect(tolerated(PLAN)).toBe(false);
    expect(leadMoved(h.repo, 'main', tolerated)).toMatch(/arbre du dépôt modifié \(\.cadence\/raf\.yaml\)/);
  });
  it('L664 — diff du lot illisible (base disparue) : rien n\'est toléré, le refus nomme le plan comme avant L673', () => {
    const { h, c } = lotTree(false);
    appendFileSync(join(h.repo, PLAN), '# ajout du lead\n');
    const tolerated = toleratedDirty({ ...c, tree: { ...c.tree!, base: 'disparue' } }, 'lot');
    expect(tolerated(PLAN)).toBe(false);
    expect(leadMoved(h.repo, 'main', tolerated)).toMatch(/arbre du dépôt modifié \(\.cadence\/raf\.yaml\)/);
  });
  it('L664 — un fichier tenu avec le plan au nom accentué que le lot touche : refusé (le diff le nomme comme le disque, sans C-quoting)', () => {
    const h = harness();
    const kept = 'étapes.md';
    writeFileSync(join(h.repo, kept), 'v1\n');
    git(h.repo, 'add', '--', kept);
    git(h.repo, 'commit', '-q', '-m', 'chore: fichier tenu');
    git(h.repo, 'checkout', '-q', '-b', 'lot');
    appendFileSync(join(h.repo, kept), 'par le lot\n');
    git(h.repo, 'commit', '-q', '-am', 'feat(L1): étapes');
    git(h.repo, 'checkout', '-q', 'main');
    const c = Object.assign(h.lot('L1'), { tree: { dir: h.repo, branch: 'lot', base: 'main', active: true } });
    const loadPlan = c.loadPlan;
    c.loadPlan = () => Object.defineProperty(loadPlan(), 'maintained', { value: [kept] });
    const tolerated = toleratedDirty(c, 'lot');
    expect(tolerated(kept)).toBe(false);
  });
});
