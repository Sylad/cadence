import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { holdRepo, readPending } from '../src/repo-held.js';
import { gitRepo, tempDir } from './helpers.js';

// L841 (issue 74 du compte pro) : raf demande new "<texte>" crée l'entrée suivante du registre ; sur une branche tenue, elle attend comme raf add et
// son D-n est réservé tout de suite. Critères tirés de la fiche du lot, pas du code.

function raf(dir: string, today: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let code: number;
  try {
    code = run(argv, { cwd: dir, env: { RAF_TODAY: today }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${today}T10:00:00Z`) }) as number;
  } catch (e) {
    return { code: -1, out: out.join('\n'), err: `${err.join('\n')}${(e as Error).message}` };
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const DIR = '.cadence/demandes';
const rawEntry = (dir: string, id: string) => readFileSync(join(dir, DIR, `${id}.json`), 'utf8');
const entry = (dir: string, id: string) => JSON.parse(rawEntry(dir, id)) as Record<string, unknown>;
const ids = (dir: string) => (existsSync(join(dir, DIR)) ? readdirSync(join(dir, DIR)).sort() : []);

/** Un dépôt avec son plan et deux entrées écrites à la main (D-1, D-3 : le suivant est D-4), tout commité. */
function project(): string {
  const dir = gitRepo(tempDir());
  raf(dir, '2026-11-25', 'init', '--no-hook');
  mkdirSync(join(dir, DIR), { recursive: true });
  for (const n of [1, 3]) writeFileSync(join(dir, DIR, `D-${n}.json`), `${JSON.stringify({ id: `D-${n}`, texte: `demande ${n}`, date: '2026-11-10', etat: 'ouverte', preuve: null, precisions: [] }, null, 1)}\n`);
  spawnSync('git', ['add', '-A'], { cwd: dir });
  expect(spawnSync('git', ['commit', '-qm', 'chore: registre'], { cwd: dir }).status).toBe(0);
  return dir;
}

describe('L841 : raf demande new sur une branche libre', () => {
  it('crée D-<n suivant> avec le texte mot pour mot, la date du jour, ouverte, preuve null, precisions [] et imprime « Noté D-n : … »', () => {
    const dir = project();
    const texte = 'Au passage : la légende doit suivre le style choisi, « pour plus tard »  (deux espaces gardées)';
    const r = raf(dir, '2026-11-25', 'demande', 'new', texte);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(new RegExp(`^Noté D-4 : ${texte.replace(/[()]/g, '\\$&')} — \\.cadence/demandes/D-4\\.json créé, à commiter$`));
    expect(entry(dir, 'D-4')).toEqual({ id: 'D-4', texte, date: '2026-11-25', etat: 'ouverte', preuve: null, precisions: [] });
    // Même format que les entrées écrites à la main : JSON indenté d'une espace, clés dans cet ordre, fin de ligne.
    expect(rawEntry(dir, 'D-4')).toBe(`${JSON.stringify({ id: 'D-4', texte, date: '2026-11-25', etat: 'ouverte', preuve: null, precisions: [] }, null, 1)}\n`);
    expect(raf(dir, '2026-11-25', 'demande', 'new', 'seconde').out).toMatch(/^Noté D-5 : seconde/);
    expect(raf(dir, '2026-11-25', 'demande').out).toMatch(/D-5 {2}ouverte {2}seconde/);
  });

  it('un texte sur plusieurs lignes ou qui commence par « - » est gardé tel quel ; un texte vide est refusé sans rien écrire', () => {
    const dir = project();
    expect(raf(dir, '2026-11-25', 'demande', 'new', 'ligne 1\nligne 2').out).toMatch(/^Noté D-4 : ligne 1 … —/);
    expect(entry(dir, 'D-4').texte).toBe('ligne 1\nligne 2');
    expect(raf(dir, '2026-11-25', 'demande', 'new', '--', '- une puce').code).toBe(0);
    expect(entry(dir, 'D-5').texte).toBe('- une puce');
    const vide = raf(dir, '2026-11-25', 'demande', 'new', '  ');
    expect(vide.code).toBe(2);
    expect(vide.err).toMatch(/texte vide/);
    expect(ids(dir)).toEqual(['D-1.json', 'D-3.json', 'D-4.json', 'D-5.json']);
  });

  it('crée le dossier du registre quand il n existe pas encore (D-1)', () => {
    const dir = gitRepo(tempDir());
    raf(dir, '2026-11-25', 'init', '--no-hook');
    expect(raf(dir, '2026-11-25', 'demande', 'new', 'première').out).toMatch(/^Noté D-1 : première/);
    expect(entry(dir, 'D-1').etat).toBe('ouverte');
  });

  it('--id et --jour, internes au plan en attente, sont refusés à la main', () => {
    const dir = project();
    expect(raf(dir, '2026-11-25', 'demande', 'new', '--id', 'D-9', 'x').err).toMatch(/--id et --jour de raf demande new sont réservés au plan en attente/);
    expect(raf(dir, '2026-11-25', 'demande', 'new', '--jour', '2026-01-01', 'x').err).toMatch(/réservés au plan en attente/);
    expect(ids(dir)).toEqual(['D-1.json', 'D-3.json']);
  });
});

describe('L841 : raf demande new sur une branche tenue par un programme', () => {
  it('va au plan en attente comme raf add, réserve le D-n tout de suite (deux new : deux numéros), appliquée garde le jour de la demande', () => {
    const dir = project();
    const unhold = holdRepo(dir, 'porte', 'cadence verify --gate abc1234');
    try {
      const a = raf(dir, '2026-11-25', 'demande', 'new', 'première demande');
      expect(a.code).toBe(0);
      expect(a.out).toMatch(/^Noté D-4 : première demande — mis en attente : raf demande new --id D-4 --jour 2026-11-25 -- première demande — la branche \S+ est tenue par cadence verify --gate abc1234/);
      const b = raf(dir, '2026-11-25', 'demande', 'new', '--', '-- texte');
      expect(b.out).toMatch(/^Noté D-5 : -- texte — mis en attente/);
      // Une précision sur une demande réservée mais pas encore écrite attend après elle.
      expect(raf(dir, '2026-11-25', 'demande', 'D-5', 'precision', 'datée').code).toBe(0);
      expect(raf(dir, '2026-11-25', 'demande', 'D-6', 'precision', 'x').err).toMatch(/D-6 absente du registre/);
      expect(ids(dir)).toEqual(['D-1.json', 'D-3.json']);
      expect(readPending(dir).map((w) => w.argv)).toEqual([
        ['demande', 'new', '--id', 'D-4', '--jour', '2026-11-25', '--', 'première demande'],
        ['demande', 'new', '--id', 'D-5', '--jour', '2026-11-25', '--', '-- texte'],
        ['demande', 'D-5', 'precision', 'datée'],
      ]);
      expect(raf(dir, '2026-11-25', 'attente', 'appliquer').err).toMatch(/encore tenue/);
    } finally {
      unhold();
    }
    // Appliquée le lendemain : chaque entrée garde son numéro réservé et le jour où elle a été demandée.
    const ok = raf(dir, '2026-11-26', 'attente', 'appliquer');
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/Noté D-4 : première demande — \.cadence\/demandes\/D-4\.json créé/);
    expect(ok.out).toMatch(/3 écriture\(s\) appliquée\(s\)/);
    expect(entry(dir, 'D-4')).toEqual({ id: 'D-4', texte: 'première demande', date: '2026-11-25', etat: 'ouverte', preuve: null, precisions: [] });
    expect(entry(dir, 'D-5')).toEqual({ id: 'D-5', texte: '-- texte', date: '2026-11-25', etat: 'ouverte', preuve: null, precisions: [{ date: '2026-11-26', texte: 'datée' }] });
    expect(readPending(dir)).toEqual([]);
  });

  it('compte les entrées que le cadence run qui tient la branche a inscrites dans son worktree', () => {
    const dir = project();
    const wt = tempDir();
    mkdirSync(join(wt, DIR), { recursive: true });
    writeFileSync(join(wt, DIR, 'D-4.json'), '{}\n');
    const unhold = holdRepo(dir, 'porte', 'porte');
    // Le fichier du programme qui tient la branche porte son worktree (format partagé avec v2/src/run/run.ts).
    const held = join(dir, '.git/cadence/tenu', `porte-${process.pid}.json`);
    writeFileSync(held, JSON.stringify({ ...JSON.parse(readFileSync(held, 'utf8')), worktree: wt }));
    try {
      expect(raf(dir, '2026-11-25', 'demande', 'new', 'après le run').out).toMatch(/^Noté D-5 : après le run/);
    } finally {
      unhold();
    }
  });

  it('appliquée alors que son numéro a été pris entre-temps, l entrée passe au suivant et la ligne le dit', () => {
    const dir = project();
    const unhold = holdRepo(dir, 'porte', 'porte');
    try {
      raf(dir, '2026-11-25', 'demande', 'new', 'réservée');
    } finally {
      unhold();
    }
    writeFileSync(join(dir, DIR, 'D-4.json'), `${JSON.stringify({ id: 'D-4', texte: 'intégrée par un run', etat: 'ouverte' }, null, 1)}\n`);
    const ok = raf(dir, '2026-11-25', 'attente', 'appliquer');
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/Noté D-5 : réservée \(D-4, réservée, a été prise entre-temps dans le registre\)/);
    expect(entry(dir, 'D-4').texte).toBe('intégrée par un run');
    expect(entry(dir, 'D-5').texte).toBe('réservée');
  });

  // Revue L841 r1 (bloquant) : le lot, la précision et l'état mis en attente pour le D-n réservé allaient à la demande du run qui avait pris ce numéro.
  it('renumérotée, elle emmène les écritures en attente qui visaient son D-n : la demande du run qui a pris le numéro n est pas touchée', () => {
    const dir = project();
    const unhold = holdRepo(dir, 'porte', 'porte');
    try {
      expect(raf(dir, '2026-11-25', 'demande', 'new', 'demande du lead').out).toMatch(/^Noté D-4 : demande du lead/);
      expect(raf(dir, '2026-11-25', 'demande', 'D-4', 'lot', 'L9').code).toBe(0);
      expect(raf(dir, '2026-11-25', 'demande', 'D-4', 'precision', 'vue avec Sylvain').code).toBe(0);
      expect(raf(dir, '2026-11-25', 'demande', 'D-4', 'etat', 'abandonnee', 'plus utile').code).toBe(0);
    } finally {
      unhold();
    }
    // Le run intègre sa propre entrée D-4, prise sur son seul worktree.
    const duRun = { id: 'D-4', texte: 'demande du run', date: '2026-11-25', etat: 'ouverte', preuve: null, precisions: [] };
    writeFileSync(join(dir, DIR, 'D-4.json'), `${JSON.stringify(duRun, null, 1)}\n`);
    const ok = raf(dir, '2026-11-25', 'attente', 'appliquer');
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/Noté D-5 : demande du lead \(D-4, réservée, a été prise entre-temps/);
    expect(ok.out).toMatch(/D-4 → D-5 : 3 écriture\(s\) en attente qui visaient D-4/);
    expect(entry(dir, 'D-4')).toEqual(duRun);
    expect(entry(dir, 'D-5')).toMatchObject({ texte: 'demande du lead', etat: 'abandonnée', raison: 'plus utile', lots: ['L9'], precisions: [{ texte: 'vue avec Sylvain' }] });
    expect(readPending(dir)).toEqual([]);
  });

  it('renumérotée, ses écritures restées en attente derrière un échec visent déjà le nouveau numéro', () => {
    const dir = project();
    const unhold = holdRepo(dir, 'porte', 'porte');
    try {
      raf(dir, '2026-11-25', 'demande', 'new', 'demande du lead');
      expect(raf(dir, '2026-11-25', 'demande', 'D-1', 'precision', 'sur une entrée existante').code).toBe(0);
      expect(raf(dir, '2026-11-25', 'demande', 'D-4', 'lot', 'L9').code).toBe(0);
    } finally {
      unhold();
    }
    writeFileSync(join(dir, DIR, 'D-4.json'), `${JSON.stringify({ id: 'D-4', texte: 'demande du run', etat: 'ouverte' }, null, 1)}\n`);
    // D-1 devient illisible : sa précision échoue et retient ce qui la suit.
    writeFileSync(join(dir, DIR, 'D-1.json'), '{');
    expect(raf(dir, '2026-11-25', 'attente', 'appliquer').code).toBe(1);
    expect(readPending(dir).map((w) => w.argv)).toEqual([['demande', 'D-1', 'precision', 'sur une entrée existante'], ['demande', 'D-5', 'lot', 'L9']]);
    writeFileSync(join(dir, DIR, 'D-1.json'), `${JSON.stringify({ id: 'D-1', texte: 'demande 1', etat: 'ouverte' }, null, 1)}\n`);
    expect(raf(dir, '2026-11-25', 'attente', 'appliquer').code).toBe(0);
    expect(entry(dir, 'D-4').lots).toBeUndefined();
    expect(entry(dir, 'D-5').lots).toEqual(['L9']);
  });
});

describe('L841 r1 : --jour hors de raf demande', () => {
  it('est refusé comme option inconnue, sans rien écrire', () => {
    const dir = project();
    const r = raf(dir, '2026-11-25', 'add', 'un lot', '--jour', '2026-01-01');
    expect(r.err).toMatch(/option inconnue : --jour/);
    expect(raf(dir, '2026-11-25', 'list').out).not.toMatch(/un lot/);
  });
});
