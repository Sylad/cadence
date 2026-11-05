import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boundsText, declaredTests, readBounds, violations, type Bound } from '../src/bounds.js';
import { claudeHookContext } from '../src/claude-hook.js';
import { RafError } from '../src/plan.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const root = join(import.meta.dirname, '..');
const lire = (f: string) => readFileSync(join(root, f), 'utf8');

const README: Bound = { paths: ['README.md'], lines: 3, columns: 10, tests: ['test/readme-accueil.test.ts'] };
const CONCEPTS: Bound = { paths: ['docs/concepts.md'], chars: 20, tests: [] };
const CHANGELOG: Bound = { paths: ['CHANGELOG.md', 'package.json'], tests: ['test/changelog.test.ts'] };

function projet(yaml: string, files: Record<string, string> = {}): string {
  const dir = tempDir();
  writeFileSync(join(dir, 'cadence.yaml'), yaml);
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), t);
  }
  return dir;
}

describe('L626 — niveau 1 : CLAUDE.md à la racine du dépôt', () => {
  it('R1 — CLAUDE.md donne les bornes du README, de concepts.md, du CHANGELOG et des pages de docs', () => {
    const t = lire('CLAUDE.md');
    expect(t).toMatch(/README[^\n]*64 lignes[^\n]*160 colonnes/);
    expect(t).toMatch(/docs\/concepts\.md[^\n]*15 Ko/);
    expect(t).toMatch(/CHANGELOG[^\n]*\[Unreleased\][^\n]*titre dupliqué/);
    expect(t).toMatch(/nouvelle page de docs[^\n]*`files`[^\n]*package\.json/);
  });

  it('R1 — les chiffres du CLAUDE.md sont ceux de la clé bounds de cadence.yaml, et les fichiers du dépôt les respectent', () => {
    const bounds = readBounds(join(root, 'cadence.yaml'));
    const of = (f: string) => bounds.find((b) => b.paths.includes(f));
    expect(of('README.md')).toMatchObject({ lines: 64, columns: 160 });
    expect(of('docs/concepts.md')).toMatchObject({ chars: 15 * 1024 });
    for (const f of ['README.md', 'docs/concepts.md']) expect(violations(root, f, bounds), f).toEqual([]);
  });
});

describe('L626 — la clé bounds de cadence.yaml', () => {
  it('R2 — absente : aucune borne ; lue : paths, limites et tests déclarés', () => {
    expect(readBounds(join(projet('docs: {}\n'), 'cadence.yaml'))).toEqual([]);
    expect(readBounds(join(tempDir(), 'cadence.yaml'))).toEqual([]);
    const d = projet('bounds:\n  - paths: [README.md]\n    lines: 64\n    columns: 160\n    tests: [test/a.test.ts]\n  - paths: docs/concepts.md\n    chars: 100\n');
    expect(readBounds(join(d, 'cadence.yaml'))).toEqual([
      { paths: ['README.md'], lines: 64, columns: 160, tests: ['test/a.test.ts'] },
      { paths: ['docs/concepts.md'], chars: 100, tests: [] },
    ]);
  });

  it.each([
    ['liste attendue', 'bounds: 3\n'],
    ['paths absent', 'bounds:\n  - lines: 3\n'],
    ['limite non entière', 'bounds:\n  - paths: [a]\n    lines: 0\n'],
    ['limite texte', 'bounds:\n  - paths: [a]\n    chars: beaucoup\n'],
    ['clé inconnue', 'bounds:\n  - paths: [a]\n    ligne: 3\n'],
    ['test absolu', 'bounds:\n  - paths: [a]\n    tests: [/etc/passwd]\n'],
    ['test avec ..', 'bounds:\n  - paths: [a]\n    tests: [../x.test.ts]\n'],
  ])('R2 — refusée : %s', (_n, yaml) => {
    expect(() => readBounds(join(projet(yaml), 'cadence.yaml'))).toThrow(RafError);
  });
});

describe('L626 — mesure d’un fichier', () => {
  const mesure = (texte: string, b: Bound) => violations(projet('', { 'f.md': texte }), 'f.md', [{ ...b, paths: ['f.md'] }]);

  it('R3 — lignes : à la limite c’est bon, une de plus et le message donne la ligne et la limite', () => {
    expect(mesure('a\nb\nc\n', README)).toEqual([]);
    expect(mesure('a\nb\nc\nd\n', README)).toEqual(['f.md : 4 lignes, limite 3']);
  });

  it('R3 — fichier sans retour final : la dernière ligne compte ; fichier vide : 0 ligne', () => {
    expect(mesure('a\nb\nc\nd', README)).toEqual(['f.md : 4 lignes, limite 3']);
    expect(mesure('', README)).toEqual([]);
  });

  it('R3 — colonnes : la plus longue ligne de texte, hors lignes de balise « < », en caractères', () => {
    expect(mesure('0123456789\n', README)).toEqual([]);
    expect(mesure('01234567890\n', README)).toEqual(['f.md : ligne 1 de 11 colonnes, limite 10']);
    expect(mesure('<img src="une-balise-tres-longue">\nok\n', README)).toEqual([]);
    expect(mesure('éééééééééé\n', README)).toEqual([]);
  });

  it('R3 — caractères : 20 au plus, accents comptés pour un', () => {
    expect(mesure('é'.repeat(20), CONCEPTS)).toEqual([]);
    expect(mesure('é'.repeat(21), CONCEPTS)).toEqual(['f.md : 21 caractères, limite 20']);
  });

  it('R3 — plusieurs limites dépassées : un message chacune ; fichier hors des paths ou absent : rien', () => {
    expect(mesure('a\nb\nc\n0123456789abc\n', README)).toEqual(['f.md : 4 lignes, limite 3', 'f.md : ligne 4 de 13 colonnes, limite 10']);
    const d = projet('', { 'g.md': 'x\n'.repeat(9) });
    expect(violations(d, 'g.md', [README])).toEqual([]);
    expect(violations(d, 'absent.md', [{ ...README, paths: ['absent.md'] }])).toEqual([]);
  });

  it('R3 — un motif de paths joue comme docs.sync (docs/*.md)', () => {
    const d = projet('', { 'docs/a.md': 'x\n'.repeat(9) });
    expect(violations(d, 'docs/a.md', [{ ...README, paths: ['docs/*.md'] }])).toEqual(['docs/a.md : 9 lignes, limite 3']);
  });
});

describe('L626 — niveau 2 : le brief d’implémentation', () => {
  it('R4 — les bornes des fichiers que le lot cite, une ligne par fichier, avec limites', () => {
    const t = boundsText([README, CONCEPTS, CHANGELOG], 'Mettre à jour README.md et docs/concepts.md');
    expect(t).toContain('README.md');
    expect(t).toContain('3 lines');
    expect(t).toContain('10 columns');
    expect(t).toContain('docs/concepts.md');
    expect(t).toContain('20 characters');
    expect(t).not.toContain('CHANGELOG.md');
  });

  it('R4 — aucun fichier cité, ou aucune limite chiffrée (tests seuls) : brief inchangé, texte vide', () => {
    expect(boundsText([README], 'rien à voir')).toBe('');
    expect(boundsText([], 'README.md')).toBe('');
    expect(boundsText([CHANGELOG], 'CHANGELOG.md package.json')).toBe('');
  });

  it('R4 — un nom plus long qui contient le chemin ne compte pas (MON-README.md)', () => {
    expect(boundsText([README], 'voir OLD/MON-README.md.bak')).toBe('');
    expect(boundsText([README], 'voir (README.md).')).toContain('README.md');
  });
});

describe('L626 — niveau 3 : le hook après écriture et la porte', () => {
  const ecrit = (dir: string, file: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: 'PostToolUse', tool_name: 'Write', cwd: dir, tool_input: { file_path: join(dir, file) }, ...extra });
  const yaml = 'bounds:\n  - paths: [README.md]\n    lines: 3\n';

  it('R5 — un fichier trop long : le hook répond la ligne mesurée et la limite, sans attendre le commit', () => {
    const d = projet(yaml, { 'README.md': 'a\nb\nc\nd\ne\n' });
    const said = claudeHookContext('bornes', ecrit(d, 'README.md'));
    expect(said?.event).toBe('PostToolUse');
    expect(said?.text).toContain('README.md : 5 lignes, limite 3');
    expect(said?.deny).toBeUndefined();
  });

  it('R5 — dans la limite, fichier hors des paths, sans cadence.yaml, sans file_path, chemin hors du dépôt, sortie illisible : rien', () => {
    const d = projet(yaml, { 'README.md': 'a\n', 'autre.md': 'x\n'.repeat(9) });
    expect(claudeHookContext('bornes', ecrit(d, 'README.md'))).toBeNull();
    expect(claudeHookContext('bornes', ecrit(d, 'autre.md'))).toBeNull();
    expect(claudeHookContext('bornes', ecrit(tempDir(), 'README.md'))).toBeNull();
    expect(claudeHookContext('bornes', { cwd: d, tool_input: {} })).toBeNull();
    expect(claudeHookContext('bornes', ecrit(d, '../hors.md'))).toBeNull();
    expect(claudeHookContext('bornes', null)).toBeNull();
    expect(claudeHookContext('bornes', ecrit(projet('bounds: 3\n', { 'README.md': 'x\n'.repeat(9) }), 'README.md'))).toBeNull();
  });

  it('R5 — le dossier du dépôt se lit depuis le fichier écrit, pas du cwd (cwd dans un sous-dossier)', () => {
    const d = projet(yaml, { 'README.md': 'a\nb\nc\nd\n', 'src/x.ts': '' });
    expect(claudeHookContext('bornes', { ...ecrit(d, 'README.md'), cwd: join(d, 'src') })?.text).toContain('README.md : 4 lignes');
  });

  it('R5 — hooks.json branche le hook sur Write, Edit et MultiEdit après écriture', () => {
    const hooks = JSON.parse(lire('hooks/hooks.json')).hooks.PostToolUse as { matcher: string; hooks: { command: string }[] }[];
    const h = hooks.find((x) => x.hooks.some((y) => y.command.includes('claude-hook bornes')));
    expect(h?.matcher).toBe('Write|Edit|MultiEdit');
  });

  it('R6 — la porte joue les tests déclarés pour les fichiers touchés, une fois chacun, sans en ajouter pour un fichier non lié', () => {
    expect(declaredTests([README, CHANGELOG], ['README.md', 'src/a.ts'])).toEqual(['test/readme-accueil.test.ts']);
    expect(declaredTests([README, CHANGELOG], ['CHANGELOG.md', 'package.json', 'test/changelog.test.ts'])).toEqual(['test/changelog.test.ts']);
    expect(declaredTests([README, CHANGELOG], ['src/a.ts'])).toEqual([]);
    expect(declaredTests([], ['README.md'])).toEqual([]);
  });

  it('R6 — les tests déclarés du dépôt existent', () => {
    for (const b of readBounds(join(root, 'cadence.yaml'))) for (const t of b.tests) expect(existsSync(join(root, t)), t).toBe(true);
  });
});
