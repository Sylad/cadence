// L796 (2) (issue #70 du compte pro) : la branche cible avance pendant la porte par des commits sur des fichiers que le run ne touche pas (le lead
// commite son plan ou une doc, ce que L796 (1) lui permet désormais) : le run se rebase et intègre en avance rapide, sans rejouer la porte (le hook
// pre-push exige de toute façon une porte de verify au sha poussé). Un vrai chevauchement garde le chemin de L723 (porte rejouée, conflit rendu).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executerRun } from '../src/run/run.js';
import { commite, depot, fauxClaude, git, io } from './run-outils.js';

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
function porte(repo: string, pendant: string): string {
  const compte = join(repo, '..', 'porte.compte');
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test: test -f fait.txt && echo x >> ${compte} && ${pendant}\n`);
  git(repo, 'add', '.'); git(repo, ...ID, 'commit', '-qm', 'porte');
  return compte;
}
const passages = (compte: string) => (existsSync(compte) ? readFileSync(compte, 'utf8').split('\n').filter(Boolean).length : 0);
/** Commande shell de la porte : au premier passage seulement, le lead commite `fichier` sur main. */
const uneFois = (repo: string, fichier: string) => `( test -f ${repo}/../avance.faite || { touch ${repo}/../avance.faite && echo '# lead' >> ${repo}/${fichier} && git -C ${repo} add ${fichier} && git -C ${repo} ${ID.join(' ')} commit -qm 'lead ${fichier}'; } )`;

describe('cadence run : la cible avance pendant la porte sur des fichiers disjoints (L796)', () => {
  it('rebase puis avance rapide, porte jouée une seule fois, le détail le dit', () => {
    const repo = depot(), compte = porte(repo, uneFois(repo, 'plan.txt')), { l, out } = io();
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('integre');
    expect(passages(compte)).toBe(1);
    expect(git(repo, 'log', '--format=%s', '-3')).toBe('ajoute fait.txt\nlead plan.txt\nporte');
    expect(e.detail).toMatch(/main a avancé pendant la porte sur des fichiers que le run ne touche pas \(1 commit : plan\.txt\) : rebasé et intégré sans rejouer la porte/);
    expect(l.join('\n')).not.toMatch(/rebase et porte rejouée/);
  });

  it('chaque porte voit main avancer sur des fichiers disjoints : intégré quand même, jamais refus-integration', () => {
    const repo = depot(), compte = porte(repo, `echo lead >> ${repo}/plan.txt && git -C ${repo} add plan.txt && git -C ${repo} ${ID.join(' ')} commit -qm avance`);
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('fait.txt')]), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(passages(compte)).toBe(1);
  });

  it('cadence.yaml changé sur main pendant la porte : pas disjoint (la porte a changé), porte rejouée comme en L723', () => {
    const repo = depot(), compte = porte(repo, uneFois(repo, 'cadence.yaml'));
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('fait.txt')]), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(passages(compte)).toBe(2);
  });
});
