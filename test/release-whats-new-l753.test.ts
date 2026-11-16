import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { changelogEntries, draftWhatsNew, entryHead, longParagraph, relinkForDocs, shortLine, SHORT_LINE_MAX } from '../src/whats-new-forms.js';
import { commit, gitRepo } from './helpers.js';

// L753 : cadence release écrit elle-même les deux formes de docs/whats-new.md qui manquent, tirées des fragments de changelog.d/
// (vécu deux fois le 16-11, 2.0.11 et 2.0.12 : la commande s'arrêtait et un agent écrivait les formes).

const WHATS_NEW = "# What's new\n\n## In two lines\n\n- **1.2.3**: the old release.\n\n## Version by version\n\nIntro of the long form.\nIts second line.\n\n**1.2.3**: the old release, in a long paragraph.\n";

describe('L753 — les entrées et leur tête', () => {
  it('une entrée sur plusieurs lignes est jointe ; titres et lignes blanches séparent', () => {
    expect(changelogEntries('\n### Added\n\n- First\n  continued (L1).\n- Second.\n\n### Fixed\n\n- Third.\n')).toEqual(['First continued (L1).', 'Second.', 'Third.']);
  });

  it('la tête s’arrête à la première fin de proposition hors code, parenthèses, liens et guillemets', () => {
    expect(entryHead('`raf done` refuses a lot; the rest.')).toBe('`raf done` refuses a lot');
    expect(entryHead('`a; b. c (d)` stays whole (L1).')).toBe('`a; b. c (d)` stays whole');
    expect(entryHead('Livreur : « rien (pas de clé) ; vide » ne vaut que sans clé (L754).')).toBe('Livreur : « rien (pas de clé) ; vide » ne vaut que sans clé');
    expect(entryHead('See [the page (long)](docs/a.md) now. Then more.')).toBe('See [the page (long)](docs/a.md) now');
    expect(entryHead('Version 2.0.12 keeps its dots — then a dash.')).toBe('Version 2.0.12 keeps its dots');
  });

  it('les liens relatifs à la racine sont réécrits pour docs/ ; absolus, ancres et URL inchangés', () => {
    expect(relinkForDocs('[a](docs/releasing.md#x) [b](CHANGELOG.md) [c](https://x.y/z) [d](#here) [e](/abs)')).toBe('[a](releasing.md#x) [b](../CHANGELOG.md) [c](https://x.y/z) [d](#here) [e](/abs)');
  });
});

describe('L753 — la ligne courte et le paragraphe long', () => {
  it('la ligne garde les têtes qui tiennent dans 240 caractères, dans l’ordre, et saute une tête trop longue', () => {
    const long = `${'word '.repeat(60)}end`;
    const line = shortLine('2.0.13', ['First thing (L1).', long, 'Third thing.'])!;
    expect(line).toBe('- **2.0.13**: First thing; Third thing.');
  });

  it('une première tête trop longue est coupée à une virgule ou une espace hors code, avec « … », jamais au-delà de 240', () => {
    const head = `\`${'x'.repeat(20)} y\` ${'alpha, '.repeat(40)}omega`;
    const line = shortLine('2.0.13', [head])!;
    expect(line.length).toBeLessThanOrEqual(SHORT_LINE_MAX);
    expect(line.endsWith('…')).toBe(true);
    expect((line.match(/`/g) ?? []).length % 2).toBe(0);
  });

  it('le paragraphe long tient sur une ligne, chaque entrée close par un point', () => {
    expect(longParagraph('1.0.0', ['A (L1)', 'B.'])).toBe('**1.0.0**: A (L1). B.');
    expect(longParagraph('1.0.0', [])).toBeNull();
  });
});

describe('L753 — draftWhatsNew', () => {
  const body = '\n### Added\n\n- A new thing (L7).\n\n### Fixed\n\n- A fix; details (L8).\n';

  it('écrit les deux formes absentes à leur place : en tête de la liste, après l’introduction (même sur deux lignes)', () => {
    const d = draftWhatsNew(WHATS_NEW, '1.2.4', body);
    expect(d.written).toEqual(['ligne de « In two lines »', 'paragraphe long']);
    expect(d.text).toContain('## In two lines\n\n- **1.2.4**: A new thing; A fix.\n- **1.2.3**:');
    expect(d.text).toContain('Its second line.\n\n**1.2.4**: A new thing (L7). A fix; details (L8).\n\n**1.2.3**:');
  });

  it('une forme déjà écrite (à sa place ou non) n’est ni réécrite ni doublée', () => {
    const avecLigne = WHATS_NEW.replace('- **1.2.3**', '- **1.2.4**: by hand.\n- **1.2.3**');
    const d = draftWhatsNew(avecLigne, '1.2.4', body);
    expect(d.written).toEqual(['paragraphe long']);
    expect(d.text.match(/^- \*\*1\.2\.4\*\*/gm)).toHaveLength(1);
    expect(d.text).toContain('- **1.2.4**: by hand.');

    const malPlace = WHATS_NEW.replace('## Version by version', '**1.2.4**: misplaced.\n\n## Version by version');
    const m = draftWhatsNew(malPlace, '1.2.4', body);
    expect(m.written).toEqual(['ligne de « In two lines »']);
    expect(m.text.match(/^\*\*1\.2\.4\*\*:/gm)).toHaveLength(1);
  });

  it('sans section, ou sans entrée : rien n’est écrit pour la forme concernée', () => {
    expect(draftWhatsNew("# What's new\n", '1.2.4', body)).toEqual({ text: "# What's new\n", written: [] });
    expect(draftWhatsNew(WHATS_NEW, '1.2.4', '\n### Added\n\n').written).toEqual([]);
  });

  it('une liste « In two lines » encore vide reçoit la ligne sous son titre', () => {
    const vide = "# What's new\n\n## In two lines\n\n## Version by version\n\nIntro.\n";
    const d = draftWhatsNew(vide, '0.1.0', body);
    expect(d.text).toBe("# What's new\n\n## In two lines\n\n- **0.1.0**: A new thing; A fix.\n\n## Version by version\n\nIntro.\n\n**0.1.0**: A new thing (L7). A fix; details (L8).\n");
  });
});

describe('L753 — cadence release dans un dépôt à fragments', () => {
  function depot(): string {
    const dir = gitRepo();
    const put = (f: string, t: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); };
    put('v2/bin/cadence2.js', "console.log(\"banc vert sur l'empreinte test\");\n");
    put('package.json', `${JSON.stringify({ name: 'acme-l753', version: '1.2.3', private: true }, null, 2)}\n`);
    put('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-10-01\n\n### Fixed\n\n- Old fix.\n');
    put('changelog.d/README.md', 'mode d’emploi\n');
    put('changelog.d/L10.md', '### Added\n\n- `cadence eval <lot>` replays the cases, see [releasing](docs/releasing.md#x) (L10).\n');
    put('changelog.d/L11.md', '### Fixed\n\n- The deliver skill no longer says « nothing to deliver » (L11).\n');
    put('docs/whats-new.md', WHATS_NEW);
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'chore: initial');
    return dir;
  }
  const release = (dir: string, ...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(['release', ...argv], { cwd: dir, env: { RAF_TODAY: '2026-11-16' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-16T09:00:00') }) as number;
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('les deux formes tirées des fragments sont écrites, la commande sort en 0 et le commit de version embarque docs/whats-new.md', () => {
    const dir = depot();
    const r = release(dir, 'patch');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const text = readFileSync(join(dir, 'docs/whats-new.md'), 'utf8');
    expect(text).toContain('- **1.2.4**: `cadence eval <lot>` replays the cases, see [releasing](releasing.md#x); The deliver skill no longer says « nothing to deliver ».\n- **1.2.3**');
    expect(text).toContain('**1.2.4**: `cadence eval <lot>` replays the cases, see [releasing](releasing.md#x) (L10). The deliver skill no longer says « nothing to deliver » (L11).');
    expect(r.out).toMatch(/les deux formes de 1\.2\.4 sont là/);
    expect(r.out).toMatch(/git add [^\n]*docs\/whats-new\.md/);
  });

  it('--dry-run dit ce qu’elle écrirait, sort en 0 et laisse docs/whats-new.md intact', () => {
    const dir = depot();
    const r = release(dir, 'patch', '--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/écrirait : docs\/whats-new\.md \(ligne de « In two lines » et paragraphe long de 1\.2\.4/);
    expect(readFileSync(join(dir, 'docs/whats-new.md'), 'utf8')).toBe(WHATS_NEW);
  });
});
