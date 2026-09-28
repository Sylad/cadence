import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { newsIssues, parseEntry, renderMarkdown } from '../src/news.js';
import type { Lot } from '../src/plan.js';
import { commit, gitRepo } from './helpers.js';

function cli(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, {
    cwd: dir,
    env: { RAF_TODAY: '2026-09-29' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date('2026-09-29T10:12:00'),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const raf = (dir: string, ...a: string[]) => cli(dir, ...a);
const news = (dir: string, ...a: string[]) => cli(dir, 'news', ...a);

function lot(id: string, over: Partial<Lot> = {}): Lot {
  return { id, title: id, status: 'todo', estimate: 1, quickwin: false, visible: false, after: [], notes: [], tasks: [], problems: [], ...over };
}

describe('renderMarkdown', () => {
  it('renders paragraphs, lists, bold, code and links, escaping html', () => {
    const html = renderMarkdown('Un **gras** et `x<y`\nsuite\n\n- a [lien](https://ex.org)\n- b <script>');
    expect(html).toBe(
      '<p>Un <strong>gras</strong> et <code>x&lt;y</code>\nsuite</p>\n' +
        '<ul><li>a <a href="https://ex.org">lien</a></li><li>b &lt;script&gt;</li></ul>',
    );
  });

  it('refuses javascript: links', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).toBe('<p>[x](javascript:alert(1))</p>');
    expect(renderMarkdown('[x](\x01javascript:alert(1))')).not.toContain('<a');
    expect(renderMarkdown('[x](JavaScript:alert(1))')).not.toContain('<a');
  });
});

describe('parseEntry', () => {
  it('reads the front matter and the body', () => {
    const e = parseEntry('2026-09-29-l8.md', '---\ntitle: Montants\ndate: 2026-09-29\nlots: [L8]\ncaptures: [captures/a.png]\n---\nTexte.\n');
    expect(e).toMatchObject({ slug: '2026-09-29-l8', title: 'Montants', date: '2026-09-29', lots: ['L8'], captures: ['captures/a.png'], body: 'Texte.', problems: [] });
  });

  it('reports a missing front matter, an empty title and a bad date', () => {
    expect(parseEntry('a.md', 'rien').problems).toEqual(['en-tête YAML absent (--- … ---)']);
    const e = parseEntry('b.md', '---\ntitle: ""\ndate: 29/09\nlots: L8\n---\n');
    expect(e.lots).toEqual(['L8']);
    expect(e.problems).toEqual(['title vide', 'date « 29/09 » n\'est pas une date AAAA-MM-JJ']);
  });

  it('accepts a UTF-8 BOM and rejects odd capture names', () => {
    const e = parseEntry('d.md', '\uFEFF---\ntitle: D\ndate: 2026-09-29\ncaptures: [captures/a#1.png, captures, notes.txt, captures/ok.webp]\n---\n');
    expect(e.problems).toEqual([
      'capture captures/a#1.png : image .png, .jpg, .webp ou .gif, nom en lettres, chiffres, « . _ - / »',
      'capture captures : image .png, .jpg, .webp ou .gif, nom en lettres, chiffres, « . _ - / »',
      'capture notes.txt : image .png, .jpg, .webp ou .gif, nom en lettres, chiffres, « . _ - / »',
    ]);
  });

  it('refuses captures outside the news folder', () => {
    const e = parseEntry('c.md', '---\ntitle: C\ndate: 2026-09-29\ncaptures: [../secret.png, /etc/x.png, captures/ok.png]\n---\n');
    expect(e.problems).toEqual(['capture hors du dossier des Nouveautés : ../secret.png', 'capture hors du dossier des Nouveautés : /etc/x.png']);
  });
});

describe('newsIssues', () => {
  it('flags visible done lots without entry, unknown lots, missing captures', () => {
    const dir = gitRepo();
    mkdirSync(join(dir, 'captures'));
    writeFileSync(join(dir, 'captures/ok.png'), 'png');
    const entries = [
      parseEntry('a.md', '---\ntitle: A\ndate: 2026-09-29\nlots: [L1, L9]\ncaptures: [captures/ok.png, captures/absente.png]\n---\n'),
      parseEntry('b.md', '---\ntitle: B\ndate: 2026-09-29\nlots: [L3]\n---\n'),
      parseEntry('c.md', '---\ntitle: C\ndate: 2026-09-29\nlots: [L3]\nnocapture: calcul seul\n---\n'),
    ];
    const lots = [lot('L1', { status: 'done', visible: true }), lot('L2', { status: 'done', visible: true }), lot('L3'), lot('L4', { status: 'done' })];
    expect(newsIssues(lots, entries, dir).map((i) => i.message)).toEqual([
      'a.md cite L9, absent du plan',
      'a.md : capture absente captures/absente.png',
      'b.md sans capture (ou « nocapture: raison »)',
      'L2 est visible et terminé sans entrée Nouveautés — cadence news new L2',
    ]);
  });
});

describe('news CLI', () => {
  it('new → check → build, and raf check / raf done / hook remind', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo', '--no-hook');
    expect(raf(dir, 'add', 'Montants', 'français', '--visible').out).toBe('L1');
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).toContain('visible: true');
    raf(dir, 'start', 'L1');
    commit(dir, 'fix(L1): montants');

    const done = raf(dir, 'done', 'L1');
    expect(done.out).toContain('écrire l\'entrée : cadence news new L1');
    const drift = raf(dir, 'check');
    expect(drift.code).toBe(1);
    expect(drift.out).toContain('L1 est visible et terminé sans entrée Nouveautés');

    const created = news(dir, 'new', 'L1');
    const path = join(dir, 'docs/nouveautes/2026-09-29-montants-francais.md');
    expect(created.out).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe(
      '---\ntitle: Montants français\ndate: 2026-09-29\nlots: [L1]\ncaptures: []\n# nocapture: raison, quand une capture n\'a pas de sens\n---\nCe qui change pour l\'utilisateur.\n',
    );
    expect(news(dir, 'new', 'L1').code).toBe(2); // existe déjà
    expect(news(dir, 'check').out).toContain('sans capture');

    mkdirSync(join(dir, 'docs/nouveautes/captures'));
    writeFileSync(join(dir, 'docs/nouveautes/captures/l1.png'), 'png');
    writeFileSync(path, readFileSync(path, 'utf8').replace('captures: []', 'captures: [captures/l1.png]').replace('Ce qui change', 'Les **montants**'));
    expect(news(dir, 'check').code).toBe(0);
    expect(raf(dir, 'check').code).toBe(0);
    expect(news(dir, 'list').out).toBe('2026-09-29  Montants français  (L1)');

    const built = news(dir, 'build', '-o', 'public/nouveautes');
    expect(built.code).toBe(0);
    const out = join(dir, 'public/nouveautes');
    const json = JSON.parse(readFileSync(join(out, 'nouveautes.json'), 'utf8'));
    expect(json).toEqual({
      project: 'demo',
      generated: '2026-09-29 10:12',
      entries: [{ slug: '2026-09-29-montants-francais', title: 'Montants français', date: '2026-09-29', lots: ['L1'], captures: ['captures/l1.png'], html: '<p>Les <strong>montants</strong> pour l\'utilisateur.</p>' }],
    });
    expect(existsSync(join(out, 'captures/l1.png'))).toBe(true);
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).toContain('<img src="captures/l1.png"');
    expect(html).not.toMatch(/https?:\/\/(?!ex)/); // aucun CDN
  });

  it('post-commit hook reminds when a visible lot has no entry', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    raf(dir, 'add', 'Écran', '--visible');
    raf(dir, 'start', 'L1');
    commit(dir, 'feat(L1): écran');
    expect(raf(dir, 'hook', 'post-commit').err).toContain('L1 est visible : cadence news new L1');
  });

  it('news new flattens a multi-line title; a directory named *.md is ignored; a directory capture is missing', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    raf(dir, 'add', 'Écran');
    const path = news(dir, 'new', 'L1', '--title', 'deux\nlignes').out;
    expect(readFileSync(path, 'utf8')).toContain('title: deux lignes\n');
    mkdirSync(join(dir, 'docs/nouveautes/dossier.md'));
    mkdirSync(join(dir, 'docs/nouveautes/captures/x.png'), { recursive: true });
    writeFileSync(path, readFileSync(path, 'utf8').replace('captures: []', 'captures: [captures/x.png]'));
    const r = news(dir, 'check');
    expect(r.out).toContain('capture absente captures/x.png');
    expect(news(dir, 'build').code).toBe(1);
  });

  it('build refuses when entries have problems', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    mkdirSync(join(dir, 'docs/nouveautes'), { recursive: true });
    writeFileSync(join(dir, 'docs/nouveautes/x.md'), 'pas d\'en-tête');
    const r = news(dir, 'build');
    expect(r.code).toBe(1);
    expect(r.out).toContain('x.md : en-tête YAML absent');
  });
});
