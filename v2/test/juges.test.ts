import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Banc } from '../src/bench/banc.js';
import type { Executeur } from '../src/bench/bras.js';
import { anonymiser, juger, validerAveugle, validerMeca } from '../src/bench/juges.js';

const meca = { suite_ok: true, caches_passes: 2, caches_total: 2, mutations_tuees: 5, mutations_total: 6, attendu: 'oui', mutations: [] };
const aveugle = { X: { bloquants: 0, majeurs: 1, mineurs: 0 }, Y: { bloquants: 0, majeurs: 0, mineurs: 2 }, prefere: 'Y', ui: 'na', raisons: 'r' };

function decor(): { b: Banc; clones: Record<string, string>; dirEval: string } {
  const r = mkdtempSync(join(tmpdir(), 'juges-'));
  const dir = join(r, 'bancs', '1-t'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'demande.md'), 'd');
  const secrets = join(r, 'secrets', '1-t'); mkdirSync(secrets, { recursive: true }); writeFileSync(join(secrets, 'mesure.md'), 'm');
  const clones: Record<string, string> = {};
  for (const nom of ['A', 'cand']) {
    const c = join(r, 'runs', nom); mkdirSync(c, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: c });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: c });
    clones[nom] = c;
  }
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clones.A, encoding: 'utf8' }).trim();
  return { b: { id: '1-t', dir, secrets, projet: 't', source: '/s', base, install: 'true', tests: 'true', visible: false, taille: 'retouche', frais: false, reponses: false },
    clones, dirEval: join(r, 'runs', 'eval') };
}
/** Faux claude : écrit dans le fichier SORTIE du brief les JSON donnés, un par appel. */
function fauxJuge(sorties: object[], vus: string[][] = [], dirEvalVu = ''): Executeur {
  let i = 0;
  return (args, o) => {
    vus.push(args);
    expect(o.env.KUBECONFIG).toBe('/nonexistent');
    const p = args[args.indexOf('-p') + 1];
    if (i === 0 && dirEvalVu) { expect(existsSync(join(dirEvalVu, 'X', '.git'))).toBe(false); expect(existsSync(join(dirEvalVu, 'X.patch'))).toBe(true); }
    const m = /dans (\S+\.json)/.exec(p);
    writeFileSync(m![1], JSON.stringify(sorties[i++] ?? {}));
    return { stdout: JSON.stringify({ session_id: `j${i}`, total_cost_usd: 0, modelUsage: {} }), code: 0 };
  };
}

describe('juges', () => {
  it('anonymise selon le tirage', () => {
    expect(anonymiser(['A', 'cand'], () => 0.2)).toEqual({ X: 'A', Y: 'cand' });
    expect(anonymiser(['A', 'cand'], () => 0.8)).toEqual({ X: 'cand', Y: 'A' });
  });
  it('valide les JSON des juges', () => {
    expect(validerMeca({ X: meca, Y: meca })).toEqual([]);
    expect(validerMeca({ X: meca })).toEqual(['Y manquant']);
    expect(validerMeca({ X: { ...meca, caches_passes: 3 }, Y: meca })).toEqual(['X.caches_passes > caches_total']);
    expect(validerAveugle(aveugle)).toEqual([]);
    expect(validerAveugle({ ...aveugle, prefere: 'Z' })).toEqual(['prefere doit valoir X, Y ou egal']);
  });
  it('désanonymise le jugement (X = A, Y = cand), garde-fous prod sur les sessions', () => {
    const { b, clones, dirEval } = decor();
    const vus: string[][] = [];
    const j = juger(b, clones, dirEval, 'opus', fauxJuge([{ X: meca, Y: { ...meca, caches_passes: 1 } }, aveugle], vus, dirEval), () => 0.2);
    expect(j!.meca.cand.caches_passes).toBe(1);
    expect(j!.defauts.A.majeurs).toBe(1);
    expect(j!.prefere).toBe('cand');
    expect(readFileSync(join(dirEval, 'demande.md'), 'utf8')).toBe('d');
    expect(vus.every((a) => a[a.indexOf('--disallowedTools') + 1].includes('Bash(kubectl:*)'))).toBe(true);
  });
  it('JSON invalide deux fois : banc non jugé (null), jamais un vert par défaut', () => {
    const { b, clones, dirEval } = decor();
    expect(juger(b, clones, dirEval, 'opus', fauxJuge([{}, {}]), () => 0.2)).toBeNull();
  });
  it('sortie claude illisible ou code non nul : null, sans exception (R7)', () => {
    const { b, clones, dirEval } = decor();
    expect(juger(b, clones, dirEval, 'opus', () => ({ stdout: 'boum', code: 1 }), () => 0.2)).toBeNull();
    const erreur: Executeur = () => ({ stdout: JSON.stringify({ session_id: 's', is_error: true }), code: 0 });
    expect(juger(b, clones, dirEval, 'opus', erreur, () => 0.2)).toBeNull();
  });
  it('clone qui n\'est pas un dépôt git : null, sans exception', () => {
    const { b, clones, dirEval } = decor();
    clones.cand = mkdtempSync(join(tmpdir(), 'pasgit-'));
    expect(juger(b, clones, dirEval, 'opus', fauxJuge([]), () => 0.2)).toBeNull();
  });
  it('le juge aveugle voit des copies fraîches, sans les mutations du mécanique', () => {
    const { b, clones, dirEval } = decor();
    let n = 0;
    const exec: Executeur = (args) => {
      const m = /dans (\S+\.json)/.exec(args[args.indexOf('-p') + 1])!;
      if (n++ === 0) { writeFileSync(join(dirEval, 'X', 'MUTATION'), 'm'); writeFileSync(m[1], JSON.stringify({ X: meca, Y: meca })); }
      else { expect(existsSync(join(dirEval, 'X', 'MUTATION'))).toBe(false); writeFileSync(m[1], JSON.stringify(aveugle)); }
      return { stdout: JSON.stringify({ session_id: `s${n}` }), code: 0 };
    };
    expect(juger(b, clones, dirEval, 'opus', exec, () => 0.2)).not.toBeNull();
    expect(n).toBe(2);
  });
  it('tirage 0.8 : X = cand, Y = A', () => {
    const { b, clones, dirEval } = decor();
    const j = juger(b, clones, dirEval, 'opus', fauxJuge([{ X: { ...meca, caches_passes: 1 }, Y: meca }, aveugle]), () => 0.8);
    expect(j!.meca.cand.caches_passes).toBe(1);
    expect(j!.meca.A.caches_passes).toBe(2);
    expect(j!.defauts.cand.majeurs).toBe(1);
    expect(j!.defauts.A.mineurs).toBe(2);
    expect(j!.prefere).toBe('A');
  });
  it('premier JSON invalide, relance valide : accepté', () => {
    const { b, clones, dirEval } = decor();
    const j = juger(b, clones, dirEval, 'opus', fauxJuge([{}, { X: meca, Y: meca }, aveugle]), () => 0.2);
    expect(j).not.toBeNull();
    expect(j!.prefere).toBe('cand');
  });
});
