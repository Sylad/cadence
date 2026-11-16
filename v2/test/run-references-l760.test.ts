// L760, revue r1 (M2) : executerRun lit `references:` avant de créer le worktree (une forme mal formée ne laisse ni worktree, ni branche, ni état) et
// dit la migration de l'ancienne forme dans sa ligne de lancement, le seul canal par lequel cadence run la signale. Les tests de L760 n'appelaient qu'aiguiller.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATION_REFERENCES } from '../../scripts/references.mjs';
import { executerRun } from '../src/run/run.js';
import { commite, depot, fauxClaude, git, io } from './run-outils.js';

/** Un dépôt de test dont le cadence.yaml porte, en plus de la porte, le bloc `references` donné (commité). */
function depotAvec(references: string): string {
  const repo = depot();
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test: test -f fait.txt\n${references}`);
  git(repo, 'add', '.'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'references');
  return repo;
}

describe('cadence run et la clé references (L760, revue r1)', () => {
  it('une forme mal formée est refusée avant le worktree : ni worktree, ni branche, ni état, ni session', () => {
    const repo = depotAvec('references:\n  run:\n    - mots: [sigwx]\n');
    const appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    expect(() => executerRun({ repo, demande: 'Dessine les SIGWX', exec: fauxClaude([commite('fait.txt')], appels), out: () => {} }))
      .toThrow('cadence.yaml : references.run[0].docs : liste non vide de textes attendue');
    expect(appels).toEqual([]);
    expect(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toEqual([`worktree ${repo}`]);
    expect(git(repo, 'branch', '--list', 'cadence/run-*')).toBe('');
    const runs = join(dirname(repo), '.cadence-run');
    expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([]);
  });

  it('l\'ancienne forme (une liste) : le run part, et sa ligne de lancement dit la migration une fois', () => {
    const repo = depotAvec('references:\n  - mots: [sigwx]\n    docs: [cadence.yaml]\n');
    const { l, out } = io();
    const e = executerRun({ repo, demande: 'Dessine les SIGWX', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('integre');
    expect(e.mode).toBe('complet');
    expect(l[0]).toMatch(/^cadence run \S+ : session .* en mode complet \(sigwx → cadence\.yaml\) dans .*; cadence\.yaml : /);
    expect(l[0].endsWith(`; cadence.yaml : ${MIGRATION_REFERENCES}`)).toBe(true);
    expect(l.filter((x) => x.includes('ancienne forme'))).toHaveLength(1);
  });

  it('la forme { run } : la ligne de lancement ne parle pas de migration', () => {
    const repo = depotAvec('references:\n  run:\n    - { mots: [sigwx], docs: [cadence.yaml] }\n');
    const { l, out } = io();
    expect(executerRun({ repo, demande: 'Dessine les SIGWX', exec: fauxClaude([commite('fait.txt')]), out }).mode).toBe('complet');
    expect(l.join('\n')).not.toContain('ancienne forme');
  });
});
