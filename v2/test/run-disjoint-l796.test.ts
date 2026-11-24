// L796 (2) (issue #70 du compte pro) : la branche cible avance pendant la porte par des commits sur des fichiers que le run ne touche pas (le lead
// commite son plan ou une doc, ce que L796 (1) lui permet désormais) : le run se rebase. Revue r1 (M1) : « disjoint » ne compare que des chemins, un
// test, un module importé ou un manifeste arrivés changent ce que la porte juge ; la porte est donc rejouée sur le sha rebasé, sans compter parmi les
// trois rebases de L723 (un commit disjoint ne rend plus le lot). Seuls des commits du plan ou du registre des demandes, que la porte ne lit pas,
// laissent intégrer sans la rejouer. Un vrai chevauchement garde le chemin de L723 (porte rejouée, conflit rendu).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executerRun } from '../src/run/run.js';
import { commite, depot, fauxClaude, git, io } from './run-outils.js';

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
function porte(repo: string, pendant: string, suite = ''): string {
  const compte = join(repo, '..', 'porte.compte');
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test: test -f fait.txt && echo x >> ${compte} && ${pendant}\n${suite}`);
  git(repo, 'add', '.'); git(repo, ...ID, 'commit', '-qm', 'porte');
  return compte;
}
const passages = (compte: string) => (existsSync(compte) ? readFileSync(compte, 'utf8').split('\n').filter(Boolean).length : 0);
/** Commande shell : le lead commite `fichiers` sur main (dossiers créés), en un commit. */
const lead = (repo: string, fichiers: string[]) => `{ ${fichiers.map((f) => `mkdir -p "$(dirname ${repo}/${f})" && echo '# lead' >> ${repo}/${f}`).join(' && ')} `
  + `&& git -C ${repo} add ${fichiers.join(' ')} && git -C ${repo} ${ID.join(' ')} commit -qm 'lead ${fichiers.join(' ')}'; }`;
/** Commande shell de la porte : aux `n` premiers passages seulement, le lead commite `fichiers` sur main. */
const nFois = (repo: string, n: number, ...fichiers: string[]) => `( c=$(cat ${repo}/../avances 2>/dev/null || echo 0); test "$c" -ge ${n} `
  + `|| { echo $((c + 1)) > ${repo}/../avances && ${lead(repo, fichiers)}; } )`;
const uneFois = (repo: string, ...fichiers: string[]) => nFois(repo, 1, ...fichiers);

describe('cadence run : la cible avance pendant la porte sur des fichiers disjoints (L796)', () => {
  it('commits du plan et du registre seuls : rebase puis avance rapide, porte jouée une seule fois, le détail le dit', () => {
    const repo = depot(), compte = porte(repo, uneFois(repo, '.cadence/raf.yaml', 'docs/plan/L1.md', '.cadence/demandes/D-1.json')), { l, out } = io();
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('integre');
    expect(passages(compte)).toBe(1);
    expect(git(repo, 'log', '--format=%s', '-2')).toBe('ajoute fait.txt\nlead .cadence/raf.yaml docs/plan/L1.md .cadence/demandes/D-1.json');
    expect(e.detail).toMatch(/main a avancé pendant la porte sur des fichiers que le run ne touche pas \(1 commit : [^)]*raf\.yaml[^)]*\) : rebasé, intégré sans rejouer la porte, qui a jugé [0-9a-f]{7} : ils ne touchent que le plan ou le registre des demandes/);
    expect(e.cible_avancee?.map((a) => a.plan_seul)).toEqual([true]);
    expect(l.join('\n')).not.toMatch(/porte rejouée/);
    expect(e.detail).not.toMatch(/pre-push/);
  });

  it('chaque porte voit main avancer sur le plan : intégré après une seule porte, jamais refus-integration', () => {
    const repo = depot(), compte = porte(repo, `( ${lead(repo, ['.cadence/raf.yaml'])} )`);
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('fait.txt')]), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(passages(compte)).toBe(1);
  });

  it('M1 : un commit disjoint hors du plan (un module que la porte lit) : rebase, porte rejouée sur le sha rebasé, hors du compte des rebases de L723', () => {
    const repo = depot(), compte = porte(repo, uneFois(repo, 'src/b.ts')), { l, out } = io();
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('integre');
    expect(passages(compte)).toBe(2);
    expect(git(repo, 'log', '--format=%s', '-2')).toBe('ajoute fait.txt\nlead src/b.ts');
    expect(e.detail).toMatch(/main a avancé pendant la porte sur des fichiers que le run ne touche pas \(1 commit : src\/b\.ts\) : rebasé, porte rejouée sur le sha rebasé \(L796\)/);
    expect(e.detail).not.toMatch(/sans rejouer la porte|pre-push/);
    expect(l.join('\n')).not.toMatch(/\(2\/3\)/); // pas un rebase de L723
  });

  it('plusieurs avances successives hors du plan : une porte rejouée par avance, intégré, chaque avance au détail', () => {
    const repo = depot(), compte = porte(repo, nFois(repo, 4, 'src/b.ts'));
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('fait.txt')]), out: () => {} });
    expect(e.etat).toBe('integre'); // 4 avances : au-delà des 3 rebases de L723, le lot n'est pas rendu
    expect(passages(compte)).toBe(5);
    expect(e.cible_avancee?.length).toBe(4);
    expect(e.detail.match(/porte rejouée sur le sha rebasé/g)?.length).toBe(4);
  });

  it('DISJOINTS_MAX atteint : la cible qui avance sans fin finit par le chemin de L723, refus-integration après 3 rebases', () => {
    const repo = depot(), compte = porte(repo, `( ${lead(repo, ['src/b.ts'])} )`), { l, out } = io();
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('refus-integration');
    expect(e.cible_avancee?.length).toBe(10);
    expect(passages(compte)).toBe(13); // 1 + 10 portes rejouées après rebase disjoint + 2 rebases de L723
    expect(l.join('\n')).toMatch(/rebase et porte rejouée \(3\/3\)/);
    expect(e.detail).toMatch(/main a encore avancé après 3 rebases/);
  });

  it('cadence.yaml changé sur main pendant la porte : pas disjoint (la porte a changé), porte rejouée comme en L723', () => {
    const repo = depot(), compte = porte(repo, uneFois(repo, 'cadence.yaml'));
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('fait.txt')]), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(passages(compte)).toBe(2);
    expect(e.cible_avancee).toBeUndefined();
  });

  it('run à commit de régénération (L781) : même un commit du plan seul repasse par L723 (régénération rejouée, porte rejouée)', () => {
    const repo = depot(), compte = porte(repo, uneFois(repo, '.cadence/raf.yaml'), 'run:\n  regenerate:\n    - { command: "date +%s%N > gen.txt" }\n'), { l, out } = io();
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('integre');
    expect(passages(compte)).toBe(2);
    expect(e.cible_avancee).toBeUndefined();
    expect(l.join('\n')).toMatch(/rebase et porte rejouée \(2\/3\)/);
  });
});
