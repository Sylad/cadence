import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bench } from '../src/bench/cli.js';
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
  const depot = () => { const p = mkdtempSync(join(tmpdir(), 'proj-')); git(p, 'init', '-q', '-b', 'main'); return p; };
  const base = (p: string, lot = 'L1') => ({ racine: mkdtempSync(join(tmpdir(), 'b-')), projetDir: p, lot, demande: 'd', install: 'true', tests: 'true', taille: 'fonction' as const, visible: false });
  it('source absolue, bancs/<id> ne contient que banc.yaml et demande.md', () => {
    const p = depot(); git(p, 'commit', '-q', '--allow-empty', '-m', 'x'); git(p, 'commit', '-q', '--allow-empty', '-m', 'feat(L1): a');
    const o = base(p); const id = ajouterBanc({ ...o, projetDir: relative(process.cwd(), p) });
    expect(chargerBanc(o.racine, id).source).toBe(p);
    expect(readdirSync(join(o.racine, 'bancs', id)).sort()).toEqual(['banc.yaml', 'demande.md']);
  });
  it('premier commit du lot = racine : erreur claire', () => {
    const p = depot(); git(p, 'commit', '-q', '--allow-empty', '-m', 'feat(L1): a');
    expect(() => ajouterBanc(base(p))).toThrow(/racine du dépôt, pas de base possible/);
  });
  it('filtre des tests : latest.ts exclu, __tests__ et .spec. pris, docs/ exclu', () => {
    const p = depot(); git(p, 'commit', '-q', '--allow-empty', '-m', 'x');
    mkdirSync(join(p, '__tests__')); mkdirSync(join(p, 'docs'));
    for (const f of ['latest.ts', '__tests__/b.ts', 'c.spec.ts', 'docs/d.test.ts']) writeFileSync(join(p, f), f);
    git(p, 'add', '.'); git(p, 'commit', '-qm', 'feat(L1): a');
    const o = base(p); const id = ajouterBanc(o); const t = join(o.racine, 'secrets', id, 'tests-origine');
    expect(existsSync(join(t, '__tests__', 'b.ts')) && existsSync(join(t, 'c.spec.ts'))).toBe(true);
    expect(existsSync(join(t, 'latest.ts')) || existsSync(join(t, 'docs'))).toBe(false);
  });
  it('fichier de test supprimé par le lot : ignoré', () => {
    const p = depot(); writeFileSync(join(p, 'a.test.ts'), 't'); git(p, 'add', '.'); git(p, 'commit', '-qm', 'x');
    git(p, 'rm', '-q', 'a.test.ts'); git(p, 'commit', '-qm', 'feat(L1): rm');
    const o = base(p); const id = ajouterBanc(o);
    expect(existsSync(join(o.racine, 'secrets', id, 'tests-origine', 'a.test.ts'))).toBe(false);
  });
  it('--visible : mesure.md a une section Écran ; sinon non', () => {
    const p = depot(); git(p, 'commit', '-q', '--allow-empty', '-m', 'x'); git(p, 'commit', '-q', '--allow-empty', '-m', 'feat(L1): a');
    const o = base(p); const v = ajouterBanc({ ...o, visible: true }); const n = ajouterBanc({ ...o, lot: 'L1' });
    expect(readFileSync(join(o.racine, 'secrets', v, 'mesure.md'), 'utf8')).toMatch(/## Écran[\s\S]*1440 et 390/);
    expect(readFileSync(join(o.racine, 'secrets', n, 'mesure.md'), 'utf8')).not.toMatch(/## Écran/);
  });
  it('CLI : erreur = message + rc 1 ; taille invalide = rc 2 ; chemin relatif résolu', async () => {
    const p = depot(); git(p, 'commit', '-q', '--allow-empty', '-m', 'x'); git(p, 'commit', '-q', '--allow-empty', '-m', 'feat(L1): a');
    const r = mkdtempSync(join(tmpdir(), 'b-')); const dem = join(r, 'dem.md'); writeFileSync(dem, 'fais');
    const sorties: string[] = []; const erreurs: string[] = [];
    const io = { cwd: dirname(p), env: { BENCH_ROOT: r }, out: (l: string) => sorties.push(l), err: (l: string) => erreurs.push(l), now: () => new Date() };
    expect(await bench(['ajouter', p, 'L9', dem], io)).toBe(1);
    expect(erreurs.join('\n')).toMatch(/^cadence2 bench ajouter : lot L9 : aucun commit/);
    expect(await bench(['ajouter', p, 'L1', dem, '--taille', 'enorme'], io)).toBe(2);
    expect(await bench(['ajouter', basename(p), 'L1', dem], io)).toBe(0);
    expect(sorties.join()).toMatch(/banc ajouté : 1-/);
    expect(chargerBanc(r, readdirSync(join(r, 'bancs'))[0]).source).toBe(p);
  });
});
