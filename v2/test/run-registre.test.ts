import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executerRun } from '../src/run/run.js';
import { cmdRun } from '../src/run/cli.js';
import { commite, depot, fauxClaude, git } from './run-outils.js';

// L701 : le registre des demandes ne garde que les demandes de l'humain ; une consigne du lead (brief de correction, relevé d'erreurs) n'y entre pas.
const demandes = (repo: string) => (existsSync(join(repo, '.cadence', 'demandes')) ? readdirSync(join(repo, '.cadence', 'demandes')).sort() : []);
const entree = (repo: string, id: string) => JSON.parse(readFileSync(join(repo, '.cadence', 'demandes', `${id}.json`), 'utf8')) as Record<string, unknown>;
const prompt = (a: { args: string[] }) => a.args[a.args.indexOf('-p') + 1];
/** Un dépôt dont le registre a déjà D-1 et D-2 (commités). */
function depotAvecRegistre(): string {
  const repo = depot(), d = join(repo, '.cadence', 'demandes');
  mkdirSync(d, { recursive: true });
  for (const n of [1, 2]) writeFileSync(join(d, `D-${n}.json`), JSON.stringify({ id: `D-${n}`, texte: `demande ${n}`, date: '2026-11-01', etat: 'ouverte', preuve: '' }, null, 1));
  git(repo, 'add', '-A'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'registre');
  return repo;
}
const commiteTout = (cwd: string) => { writeFileSync(join(cwd, 'fait.txt'), 'ok'); git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'travail'); };

describe('cadence run et le registre des demandes (L701)', () => {
  for (const mode of [{ nom: 'complet', pieces: ['cadence.yaml'] }, { nom: 'léger', pieces: [] }]) {
    it(`sans option, mode ${mode.nom} : rien n'est inscrit, la session reçoit la consigne de ne pas écrire au registre et le run cite seulement le lot`, () => {
      const repo = depotAvecRegistre(), avant = git(repo, 'rev-parse', 'HEAD:.cadence/demandes'), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
      const e = executerRun({ repo, demande: 'Corriger les 2 majeurs de la revue L9 (pièce jointe)', pieces: mode.pieces, lot: 'L9', exec: fauxClaude([commite('fait.txt')], appels), out: () => {} });
      expect(e.etat).toBe('integre');
      expect(git(repo, 'rev-parse', 'HEAD:.cadence/demandes')).toBe(avant);
      expect(demandes(repo)).toEqual(['D-1.json', 'D-2.json']);
      const p = prompt(appels[0]);
      expect(p).toMatch(/consigne du lead, pas une demande de Sylvain : n'écris rien dans \.cadence\/demandes\//);
      expect(p).toMatch(/Lot du plan : L9\./);
      expect(p).not.toMatch(/Crée une entrée pour CHAQUE demande|relis le registre/);
    });
  }

  it('sans option, une session qui écrit quand même au registre (CLAUDE.md global) est reprise une fois pour le rendre ; sinon rien n\'est intégré', () => {
    const repo = depotAvecRegistre(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const ecrit = (cwd: string) => { writeFileSync(join(cwd, '.cadence', 'demandes', 'D-3.json'), '{"id":"D-3"}'); commiteTout(cwd); };
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([ecrit, (cwd) => { git(cwd, 'rm', '-q', '.cadence/demandes/D-3.json'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'retire D-3'); }], appels), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(demandes(repo)).toEqual(['D-1.json', 'D-2.json']);
    expect(prompt(appels[1])).toMatch(/registre des demandes modifié sans --demande-humaine ni --registre : \.cadence\/demandes\/D-3\.json/);
    const r = depotAvecRegistre(), b = git(r, 'rev-parse', 'HEAD');
    const e2 = executerRun({ repo: r, demande: 'x', exec: fauxClaude([ecrit, () => {}]), out: () => {} });
    expect(e2).toMatchObject({ etat: 'porte-rouge' });
    expect(e2.detail).toMatch(/D-3\.json/);
    expect(git(r, 'rev-parse', 'HEAD')).toBe(b);
  });

  it('--registre D-n : le run complète cette entrée (lot, run) sans en créer d\'autre ni réécrire son texte, et la session le sait', () => {
    const repo = depotAvecRegistre(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const e = executerRun({ repo, demande: 'Corriger la revue de D-2', lot: 'L9', registre: 'D-2', exec: fauxClaude([commite('fait.txt')], appels), out: () => {} });
    expect(e).toMatchObject({ etat: 'integre', registre: 'D-2' });
    expect(demandes(repo)).toEqual(['D-1.json', 'D-2.json']);
    expect(entree(repo, 'D-2')).toMatchObject({ id: 'D-2', texte: 'demande 2', etat: 'ouverte', lots: ['L9'], runs: [e.id] });
    expect(entree(repo, 'D-1')).not.toHaveProperty('lots');
    expect(prompt(appels[0])).toMatch(/ce run sert l'entrée D-2 du registre/);
  });

  it('--registre D-n en mode complet (revue L701-r1) : le brief rendu ne fait plus créer d\'entrée, garde la lecture et la relecture du registre', () => {
    const repo = depotAvecRegistre(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const e = executerRun({ repo, demande: 'Corriger les majeurs de la revue L9 (pièce jointe)', pieces: ['cadence.yaml'], lot: 'L9', registre: 'D-2',
      exec: fauxClaude([commite('fait.txt')], appels), out: () => {} });
    expect(e).toMatchObject({ etat: 'integre', mode: 'complet', registre: 'D-2' });
    const p = prompt(appels[0]);
    expect(p).not.toMatch(/Crée une entrée pour CHAQUE demande/);
    expect(p).toMatch(/^- Registre des demandes : .*\/\.cadence\/demandes\/ garde chaque demande/m);
    expect(p).toMatch(/^- Avant de commiter, relis le registre/m);
    expect(p).toMatch(/ce run sert l'entrée D-2 du registre/);
    expect(demandes(repo)).toEqual(['D-1.json', 'D-2.json']);
  });

  it('--registre D-n : une entrée neuve créée par la session est refusée en porte (reprise une fois, sinon porte-rouge) ; D-n et les états des autres passent', () => {
    const repo = depotAvecRegistre(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const ecrit = (cwd: string) => { writeFileSync(join(cwd, '.cadence', 'demandes', 'D-3.json'), '{"id":"D-3"}'); commiteTout(cwd); };
    const retire = (cwd: string) => { git(cwd, 'rm', '-q', '.cadence/demandes/D-3.json'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'retire D-3'); };
    const e = executerRun({ repo, demande: 'x', pieces: ['cadence.yaml'], registre: 'D-2', exec: fauxClaude([ecrit, retire], appels), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(demandes(repo)).toEqual(['D-1.json', 'D-2.json']);
    expect(prompt(appels[1])).toMatch(/entrée neuve au registre des demandes : \.cadence\/demandes\/D-3\.json ; ce run sert D-2/);
    const r = depotAvecRegistre(), b = git(r, 'rev-parse', 'HEAD');
    const e2 = executerRun({ repo: r, demande: 'x', registre: 'D-2', exec: fauxClaude([ecrit, () => {}]), out: () => {} });
    expect(e2).toMatchObject({ etat: 'porte-rouge' });
    expect(e2.detail).toMatch(/D-3\.json/);
    expect(git(r, 'rev-parse', 'HEAD')).toBe(b);
    const r3 = depotAvecRegistre();
    const livre = (cwd: string) => { writeFileSync(join(cwd, '.cadence', 'demandes', 'D-1.json'), '{"id":"D-1","texte":"demande 1","etat":"livrée"}'); commiteTout(cwd); };
    expect(executerRun({ repo: r3, demande: 'x', registre: 'D-2', exec: fauxClaude([livre]), out: () => {} }).etat).toBe('integre');
    expect(entree(r3, 'D-1')).toMatchObject({ etat: 'livrée' });
  });

  it('--registre D-n inconnu : refusé avant toute création', () => {
    const repo = depotAvecRegistre();
    expect(() => executerRun({ repo, demande: 'x', registre: 'D-7', exec: fauxClaude([]), out: () => {} })).toThrow(/D-7 absente du registre/);
    expect(existsSync(join(repo, '..', '.cadence-run'))).toBe(false);
  });

  it('--demande-humaine : la demande est inscrite mot pour mot sous le numéro suivant, avec le lot, et commitée avec le travail', () => {
    const repo = depotAvecRegistre(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const texte = 'au passage, il faudra gérer le quota « hebdo »\nsur deux lignes';
    const e = executerRun({ repo, demande: texte, lot: 'L9', registre: 'humaine', exec: fauxClaude([commiteTout], appels), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(entree(repo, 'D-3')).toMatchObject({ id: 'D-3', texte, etat: 'ouverte', lots: ['L9'], runs: [e.id] });
    expect(prompt(appels[0])).toMatch(/inscrite en D-3/);
  });

  it('CLI : --demande-humaine et --registre D-n sont lus ; les deux ensemble, ou un --registre mal formé, sont refusés avant toute création', async () => {
    const repo = depotAvecRegistre(), sortie: string[] = [], erreurs: string[] = [];
    const cli = { cwd: repo, env: {}, now: () => new Date(), out: (l: string) => sortie.push(l), err: (l: string) => erreurs.push(l) };
    expect(await cmdRun(['x', '--demande-humaine', '--registre', 'D-1'], cli, fauxClaude([]))).toBe(2);
    expect(await cmdRun(['x', '--registre', 'L9'], cli, fauxClaude([]))).toBe(2);
    expect(await cmdRun(['x', '--registre'], cli, fauxClaude([]))).toBe(2);
    expect(existsSync(join(repo, '..', '.cadence-run'))).toBe(false);
    expect(await cmdRun(['Crée fait.txt', '--registre', 'D-1', '--lot', 'L9'], cli, fauxClaude([commite('fait.txt')]))).toBe(0);
    expect(entree(repo, 'D-1')).toMatchObject({ lots: ['L9'] });
    expect(await cmdRun(['Crée autre', '--demande-humaine'], cli, fauxClaude([commiteTout]))).toBe(0);
    expect(entree(repo, 'D-3')).toMatchObject({ texte: 'Crée autre' });
  });
});
