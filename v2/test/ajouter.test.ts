import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ajouterBanc } from '../src/bench/ajouter.js';
import { chargerBanc } from '../src/bench/banc.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();

describe('ajouterBanc', () => {
  it('base = parent du premier commit du lot ; tests du lot mis au secret', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'proj-')), 'ol'); mkdirSync(join(p, 'src'), { recursive: true });
    git(mkdtempSync(join(tmpdir(), 'x-')), 'init', '-q', '-b', 'main', p);
    writeFileSync(join(p, 'src', 'a.ts'), '1'); git(p, 'add', '.'); git(p, 'commit', '-qm', 'départ');
    const base = git(p, 'rev-parse', 'HEAD');
    writeFileSync(join(p, 'src', 'a.ts'), '2'); writeFileSync(join(p, 'src', 'a.test.ts'), 'test'); git(p, 'add', '.'); git(p, 'commit', '-qm', 'feat(L900): séparateur');
    writeFileSync(join(p, 'src', 'a.ts'), '3'); git(p, 'commit', '-qam', 'fix(L900): marge');
    const r = mkdtempSync(join(tmpdir(), 'bench-')); mkdirSync(join(r, 'bancs', '8-x'), { recursive: true });
    const id = ajouterBanc({ racine: r, projetDir: p, lot: 'L900', demande: 'mets un trait', install: 'true', tests: 'true', taille: 'retouche', visible: true });
    expect(id).toBe('9-ol-L900');
    const b = chargerBanc(r, id);
    expect(b).toMatchObject({ base, frais: true, taille: 'retouche', source: p });
    expect(readFileSync(join(b.secrets, 'tests-origine', 'src', 'a.test.ts'), 'utf8')).toBe('test');
    expect(readFileSync(join(b.secrets, 'diff-origine.patch'), 'utf8')).toMatch(/marge/);
    expect(existsSync(join(b.secrets, 'mesure.md'))).toBe(true);
    expect(statSync(b.secrets).mode & 0o077).toBe(0);
  });
  it('lot sans commit : erreur', () => {
    const p = mkdtempSync(join(tmpdir(), 'proj-')); git(p, 'init', '-q', '-b', 'main'); git(p, 'commit', '-q', '--allow-empty', '-m', 'x');
    expect(() => ajouterBanc({ racine: mkdtempSync(join(tmpdir(), 'b-')), projetDir: p, lot: 'L1', demande: 'd', install: 'true', tests: 'true', taille: 'fonction', visible: false }))
      .toThrow(/aucun commit/);
  });
  it('L1 ne prend pas un commit qui cite seulement L10', () => {
    const p = mkdtempSync(join(tmpdir(), 'proj-')); git(p, 'init', '-q', '-b', 'main'); git(p, 'commit', '-q', '--allow-empty', '-m', 'x');
    git(p, 'commit', '-q', '--allow-empty', '-m', 'feat(L10): autre');
    expect(() => ajouterBanc({ racine: mkdtempSync(join(tmpdir(), 'b-')), projetDir: p, lot: 'L1', demande: 'd', install: 'true', tests: 'true', taille: 'fonction', visible: false }))
      .toThrow(/aucun commit/);
  });
  it('métacaractères du lot échappés', () => {
    const p = mkdtempSync(join(tmpdir(), 'proj-')); git(p, 'init', '-q', '-b', 'main'); git(p, 'commit', '-q', '--allow-empty', '-m', 'x');
    git(p, 'commit', '-q', '--allow-empty', '-m', 'feat(LXA): autre');
    expect(() => ajouterBanc({ racine: mkdtempSync(join(tmpdir(), 'b-')), projetDir: p, lot: 'L.A', demande: 'd', install: 'true', tests: 'true', taille: 'fonction', visible: false }))
      .toThrow(/aucun commit/);
  });
});
