// L723 : la branche cible avance pendant la porte (un autre run s'intègre) : le run se rebase seul, rejoue la porte, puis avance rapide.
// Vécu 2 fois le 13-11 (L687 après L707, correctif du HUD après L689) : « refus-integration », repris à la main par --reponse.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executerRun } from '../src/run/run.js';
import { commite, depot, fauxClaude, git, io } from './run-outils.js';

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
/** Porte qui compte ses passages dans `compte` et joue `pendant` (une commande shell) à chaque passage, comme un autre run qui s'intègre pendant elle. */
function porte(repo: string, pendant: string): string {
  const compte = join(repo, '..', 'porte.compte');
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test: test -f fait.txt && echo x >> ${compte} && ${pendant}\n`);
  git(repo, 'add', '.'); git(repo, ...ID, 'commit', '-qm', 'porte');
  return compte;
}
const passages = (compte: string) => (existsSync(compte) ? readFileSync(compte, 'utf8').split('\n').filter(Boolean).length : 0);
const rebaseEnCours = (wt: string) => ['rebase-merge', 'rebase-apply'].some((d) => existsSync(join(wt, git(wt, 'rev-parse', '--git-path', d))));

describe('cadence run : la branche cible avance pendant la porte (L723)', () => {
  it('deux runs : le premier s\'intègre pendant la porte du second ; le second se rebase, rejoue la porte et intègre', () => {
    const repo = depot();
    // Le premier run : sa branche, partie de la même base, qu'il intègre en avance rapide (comme suite() de run.ts) pendant la porte du second.
    const compte = porte(repo, `git -C ${repo} merge -q --ff-only cadence/run-premier`);
    git(repo, 'checkout', '-qb', 'cadence/run-premier'); writeFileSync(join(repo, 'premier.txt'), 'ok'); git(repo, 'add', '.'); git(repo, ...ID, 'commit', '-qm', 'ajoute premier.txt');
    git(repo, 'checkout', '-q', 'main');
    const { l, out } = io();
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('integre');
    expect(git(repo, 'log', '--format=%s', '-3')).toBe('ajoute fait.txt\najoute premier.txt\nporte');
    expect(passages(compte)).toBe(2); // porte rejouée sur le résultat rebasé
    expect(l.join('\n')).toMatch(/main a avancé pendant la porte : rebase et porte rejouée/);
    expect(existsSync(e.worktree)).toBe(false);
  });

  it('conflit au rebase : la même session le résout avec la liste des fichiers, la porte est rejouée, puis intégration', () => {
    const repo = depot(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const exec = fauxClaude([(cwd) => { commite('fait.txt')(cwd); writeFileSync(join(repo, 'fait.txt'), 'autre'); git(repo, 'add', '.'); git(repo, ...ID, 'commit', '-qm', 'fait.txt ailleurs'); },
      (cwd) => { writeFileSync(join(cwd, 'fait.txt'), 'les deux'); git(cwd, 'add', 'fait.txt'); git(cwd, ...ID, '-c', 'core.editor=true', 'rebase', '--continue'); }], appels);
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec, out: () => {} });
    expect(e.etat).toBe('integre');
    const prompt = appels[1].args[appels[1].args.indexOf('-p') + 1];
    expect(appels[1].args).toEqual(expect.arrayContaining(['--resume', 's1']));
    expect(prompt).toMatch(/conflit[\s\S]*fait\.txt[\s\S]*rebase --continue/);
    expect(readFileSync(join(repo, 'fait.txt'), 'utf8')).toBe('les deux');
  });

  it('conflit que la session ne résout pas : rendu au lead (« conflit »), rebase annulé, fichiers nommés', () => {
    const repo = depot(), base = () => git(repo, 'rev-parse', 'HEAD');
    const exec = fauxClaude([(cwd) => { commite('fait.txt')(cwd); writeFileSync(join(repo, 'fait.txt'), 'autre'); git(repo, 'add', '.'); git(repo, ...ID, 'commit', '-qm', 'fait.txt ailleurs'); }, () => {}]);
    const avant = base();
    const e = executerRun({ repo, demande: 'x', exec, out: () => {} });
    expect(e.etat).toBe('conflit');
    expect(e.detail).toMatch(/fait\.txt/);
    expect(e.detail).toMatch(/pas résolu/);
    expect(rebaseEnCours(e.worktree)).toBe(false);
    expect(base()).not.toBe(avant); // seul le commit d'« ailleurs » est sur main
    expect(git(repo, 'log', '--format=%s', '-1')).toBe('fait.txt ailleurs');
  });

  it('la cible avance à chaque porte : rendu au lead après 3 rebases, avec la raison', () => {
    const repo = depot(), compte = porte(repo, `git -C ${repo} ${ID.join(' ')} commit -q --allow-empty -m avance`);
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('fait.txt')]), out: () => {} });
    expect(e.etat).toBe('refus-integration');
    expect(e.detail).toMatch(/main a encore avancé après 3 rebases/);
    expect(passages(compte)).toBe(3);
  });
});

describe('cadence run : arbre principal modifié non commité (L723)', () => {
  it('fichier suivi modifié dans l\'arbre principal et par le run : refus clair qui nomme le fichier, rien intégré', () => {
    const repo = depot();
    writeFileSync(join(repo, 'notes.txt'), 'v1'); git(repo, 'add', '.'); git(repo, ...ID, 'commit', '-qm', 'notes');
    const avant = git(repo, 'rev-parse', 'HEAD');
    const exec = fauxClaude([(cwd) => { writeFileSync(join(cwd, 'notes.txt'), 'v2'); commite('fait.txt')(cwd); writeFileSync(join(repo, 'notes.txt'), 'en cours'); }]);
    const e = executerRun({ repo, demande: 'x', exec, out: () => {} });
    expect(e.etat).toBe('refus-integration');
    expect(e.detail).toMatch(/modifications non commitées dans l'arbre principal .* : notes\.txt/);
    expect(e.detail).not.toMatch(/fait\.txt/);
    expect(e.detail).toMatch(new RegExp(`cadence run --reponse ${e.id}`));
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(avant);
    expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('en cours');
  });

  it('fichier non suivi de l\'arbre principal que le run crée : même refus, fichier nommé', () => {
    const repo = depot();
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([(cwd) => { commite('fait.txt')(cwd); writeFileSync(join(repo, 'fait.txt'), 'à moi'); }]), out: () => {} });
    expect(e.etat).toBe('refus-integration');
    expect(e.detail).toMatch(/: fait\.txt/);
  });

  it('dossier non suivi de l\'arbre principal : refus si le run y crée un fichier déjà là, intégration sinon', () => {
    for (const [present, attendu] of [['nouveau/a.txt', 'refus-integration'], ['nouveau/b.txt', 'integre']] as const) {
      const repo = depot();
      const exec = fauxClaude([(cwd) => { mkdirSync(join(cwd, 'nouveau')); commite('nouveau/a.txt')(cwd); commite('fait.txt')(cwd); mkdirSync(join(repo, 'nouveau')); writeFileSync(join(repo, present), 'à moi'); }]);
      const e = executerRun({ repo, demande: 'x', exec, out: () => {} });
      expect(e.etat).toBe(attendu);
      if (attendu === 'refus-integration') expect(e.detail).toMatch(/: nouveau\/a\.txt\./);
    }
  });

  it('modification de l\'arbre principal sur un autre fichier : intégration normale', () => {
    const repo = depot();
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([(cwd) => { commite('fait.txt')(cwd); writeFileSync(join(repo, 'brouillon.txt'), 'x'); }]), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(existsSync(join(repo, 'brouillon.txt'))).toBe(true);
  });
});
