// L764 : la porte d'un cadence run (1) lisait cadence.yaml dans le dépôt principal, si bien qu'un run qui corrigeait sa propre commande de porte restait rouge ;
// (2) jouait sur un environnement périmé (node_modules en retard sur package-lock.json, Node du PATH hors de .nvmrc / engines.node) et demandait à la session de
// « corriger » un rouge qui n'était pas le sien.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executerRun, repondreRun, type Etat } from '../src/run/run.js';
import { commite, depot, fauxClaude, git, io } from './run-outils.js';
import { dossierTemp } from './temp.js';

const relire = (e: Etat) => JSON.parse(readFileSync(e.fichier, 'utf8')) as Etat;
const lockfile = (v: string) => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'x' }, 'node_modules/tailwindcss': { version: v } } });
/** Écrit cadence.yaml (porte `porte`) dans le worktree et le commite. */
const changePorte = (porte: string) => (cwd: string) => {
  writeFileSync(join(cwd, 'cadence.yaml'), `orchestrate:\n  test: ${porte}\n`);
  git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'porte corrigée');
};

describe('cadence run : porte lue au commit du run (L764 c)', () => {
  it('un run qui corrige sa propre commande de porte est jugé par elle, et la sortie dit qu\'elle diffère de celle de l\'arbre principal', () => {
    const repo = depot('test -f introuvable.txt'), { l, out } = io(), appels: unknown[] = [];
    const e = executerRun({ repo, demande: 'corrige la porte', exec: fauxClaude([changePorte('test -f cadence.yaml')], appels as never), out });
    expect(relire(e).etat).toBe('integre');
    expect(appels).toHaveLength(1); // aucune session de correction : la porte du run était verte
    expect(l.join('\n')).toContain('porte lue au commit du run (cadence.yaml changé par le run) : test -f cadence.yaml — l\'arbre principal (main) aurait joué : test -f introuvable.txt');
  });

  it('porte inchangée par le run : aucune ligne de plus', () => {
    const repo = depot(), { l, out } = io();
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('fait.txt')]), out });
    expect(relire(e).etat).toBe('integre');
    expect(l.join('\n')).not.toContain('porte lue au commit du run');
  });

  it('la session de correction corrige la commande de porte : la porte rejouée est la nouvelle', () => {
    const repo = depot('test -f introuvable.txt'), { out } = io();
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('a.txt'), changePorte('test -f a.txt')]), out });
    expect(relire(e).etat).toBe('integre');
    expect(relire(e).corrections?.map((c) => c.verte)).toEqual([true]);
  });
});

describe('cadence run : environnement périmé avant la porte (L764 a)', () => {
  /** Dépôt dont package-lock.json demande tailwindcss 4.1.0 alors que node_modules (lié dans le worktree) a 3.4.17. */
  function depotPerime(): string {
    const repo = depot('test -f fait.txt');
    writeFileSync(join(repo, 'package-lock.json'), lockfile('4.1.0'));
    git(repo, 'add', '-A'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'lockfile');
    writeFileSync(join(repo, 'node_modules', '.package-lock.json'), lockfile('3.4.17'));
    return repo;
  }

  it('rien n\'est joué, aucune correction demandée à la session : état environnement-perime, la remise à niveau et la reprise dites', () => {
    const repo = depotPerime(), { l, out } = io(), appels: unknown[] = [];
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('fait.txt')], appels as never), out });
    const etat = relire(e);
    expect(etat.etat).toBe('environnement-perime');
    expect(appels).toHaveLength(1);
    expect(etat.corrections).toBeUndefined();
    expect(etat.detail).toContain('porte du run : environnement périmé, rien n\'est joué');
    expect(etat.detail).toContain('tailwindcss 3.4.17 installé, 4.1.0 au lockfile');
    expect(etat.detail).toContain(`remise à niveau : cd ${e.worktree} && npm ci`);
    expect(etat.detail).toContain(`cadence run --reponse ${e.id} "environnement remis à niveau"`);
    expect(l.join('\n')).toContain(`cadence run ${e.id} : environnement-perime`);
  });

  it('remis à niveau puis --reponse : la porte est jouée et le run intégré', () => {
    const repo = depotPerime(), exec = fauxClaude([commite('fait.txt'), () => {}]);
    const e1 = executerRun({ repo, demande: 'x', exec, out: () => {} });
    expect(e1.etat).toBe('environnement-perime');
    writeFileSync(join(e1.worktree, 'node_modules', '.package-lock.json'), lockfile('4.1.0'));
    const e2 = repondreRun(e1.id, repo, 'environnement remis à niveau', { exec, out: () => {} });
    expect(relire(e2).etat).toBe('integre');
  });
});

describe('cadence run : Node du PATH hors de engines.node (L764 b)', () => {
  it('la porte hérite du PATH de la session qui a lancé le run : Node 22.22.3 contre engines >=24, rien n\'est joué, la remise à niveau dit de relancer la session', () => {
    const repo = depot('test -f fait.txt');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x', engines: { node: '>=24' } }));
    git(repo, 'add', '-A'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'engines');
    const bin = join(dossierTemp('node-'), 'bin');
    mkdirSync(bin); writeFileSync(join(bin, 'node'), '#!/bin/sh\necho v22.22.3\n'); chmodSync(join(bin, 'node'), 0o755);
    const avant = process.env.PATH;
    process.env.PATH = `${bin}:${avant}`;
    try {
      const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('fait.txt')]), out: () => {} });
      expect(relire(e).etat).toBe('environnement-perime');
      expect(relire(e).detail).toContain('le Node du PATH de la porte est v22.22.3, package.json (engines.node) demande >=24');
      expect(relire(e).detail).toContain('relancer cette session');
    } finally { process.env.PATH = avant; }
  });
});
