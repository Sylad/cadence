import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { loadEntries, newsIssues, parseEntry, renderMarkdown } from '../src/news.js';
import { toStamp } from '../src/dates.js';
import type { Lot } from '../src/plan.js';
import { execFileSync } from 'node:child_process';
import { commit, gitRepo, tempDir } from './helpers.js';

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
      parseEntry('a.md', '---\ntitle: A\ndate: 2026-09-29\ncreated: 2026-09-29T10:00\nlots: [L1, L9]\ncaptures: [captures/ok.png, captures/absente.png]\n---\n'),
      parseEntry('b.md', '---\ntitle: B\ndate: 2026-09-29\ncreated: 2026-09-29T10:00\nlots: [L3]\n---\n'),
      parseEntry('c.md', '---\ntitle: C\ndate: 2026-09-29\ncreated: 2026-09-29T10:00\nlots: [L3]\nnocapture: calcul seul\n---\n'),
    ];
    const lots = [lot('L1', { status: 'done', visible: true }), lot('L2', { status: 'done', visible: true }), lot('L3'), lot('L4', { status: 'done' })];
    expect(newsIssues(lots, entries, dir).map((i) => i.message)).toEqual([
      'a.md cite L9, absent du plan',
      'a.md : capture absente captures/absente.png',
      'b.md sans capture (ou « nocapture: raison »)',
      'L2 est visible et terminé sans entrée Nouveautés — cadence news new L2',
    ]);
  });

  it('flags an entry without creation time (hour and minute)', () => {
    const entries = [parseEntry('d.md', '---\ntitle: D\ndate: 2026-09-29\nnocapture: calcul\n---\n')];
    expect(newsIssues([], entries, gitRepo())).toEqual([
      { kind: 'no-time', message: 'd.md sans heure de création (created: AAAA-MM-JJTHH:MM) — cadence news stamp' },
    ]);
  });
});

describe('toStamp', () => {
  it('writes local minute precision with an explicit offset', () => {
    const d = new Date('2026-09-29T10:12:34');
    expect(toStamp(d)).toMatch(/^2026-09-29T10:12[+-]\d{2}:\d{2}$/);
    expect(Date.parse(toStamp(d))).toBe(new Date('2026-09-29T10:12:00').getTime());
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
      `---\ntitle: Montants français\ndate: 2026-09-29\ncreated: ${toStamp(new Date('2026-09-29T10:12:00'))}\nlots: [L1]\ncaptures: []\n# nocapture: raison, quand une capture n'a pas de sens\n---\nCe qui change pour l'utilisateur.\n`,
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

describe('loadEntries order', () => {
  const entry = (lot: string, created?: string) =>
    `---\ntitle: ${lot}\ndate: 2026-09-28\nlots: [${lot}]\n${created ? `created: ${created}\n` : ''}---\n`;
  const L18 = '2026-09-28-une-page-nouveautes-ce-qui-change-avec-une-capture.md';
  const L21 = '2026-09-28-un-tableau-de-bord-plus-lisible-surtout-au-telephone.md';
  const add = (dir: string, file: string, lot: string, date: string) => {
    writeFileSync(join(dir, file), entry(lot));
    execFileSync('git', ['add', file], { cwd: dir, stdio: 'ignore' });
    commit(dir, `docs(${lot}): nouveauté`, date);
  };

  const addAs = (dir: string, file: string, lot: string, author: string, committer: string) => {
    writeFileSync(join(dir, file), entry(lot));
    execFileSync('git', ['add', file], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', `docs(${lot}): nouveauté`], {
      cwd: dir,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_DATE: author, GIT_COMMITTER_DATE: committer },
    });
  };

  it('an accented file name committed is found in git (core.quotepath)', () => {
    const dir = gitRepo();
    add(dir, '2026-09-28-café.md', 'LC', '2026-09-28T20:00:00+02:00');
    add(dir, '2026-09-28-b.md', 'LB', '2026-09-28T21:00:00+02:00');
    writeFileSync(join(dir, '2026-09-28-a.md'), entry('LA'));
    // café commité en premier : le plus ancien, pas « non commité donc le plus récent ».
    expect(loadEntries(dir).map((e) => e.lots[0])).toEqual(['LA', 'LB', 'LC']);
  });

  it('uses the author date: entries rebased in the same second keep their chronological order', () => {
    const dir = gitRepo();
    addAs(dir, L18, 'L18', '2026-09-28T20:07:35+02:00', '2026-09-28T23:00:00+02:00');
    addAs(dir, L21, 'L21', '2026-09-28T22:21:08+02:00', '2026-09-28T23:00:00+02:00');
    expect(loadEntries(dir).map((e) => e.lots[0])).toEqual(['L21', 'L18']);
  });

  it('same day, no created time: the entry committed last comes first, whatever its file name (L18 then L21)', () => {
    const dir = gitRepo();
    add(dir, L18, 'L18', '2026-09-28T20:07:35+02:00');
    add(dir, L21, 'L21', '2026-09-28T22:21:08+02:00');
    expect(loadEntries(dir).map((e) => e.lots[0])).toEqual(['L21', 'L18']);
  });

  it('same day: the created time wins over the commit date; an uncommitted entry without time comes first', () => {
    const dir = gitRepo();
    add(dir, L21, 'L21', '2026-09-28T22:21:08+02:00');
    writeFileSync(join(dir, 'b.md'), entry('LB', '2026-09-28T23:00'));
    writeFileSync(join(dir, 'a.md'), entry('LA', '2026-09-28T08:00'));
    writeFileSync(join(dir, 'z.md'), entry('LZ'));
    expect(loadEntries(dir).map((e) => e.lots[0])).toEqual(['LZ', 'LB', 'L21', 'LA']);
  });

  it('the date still comes first; outside git, the file name decides last', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.md'), entry('LA').replace('2026-09-28', '2026-09-29'));
    writeFileSync(join(dir, 'b.md'), entry('LB'));
    writeFileSync(join(dir, 'c.md'), entry('LC'));
    expect(loadEntries(dir).map((e) => e.lots[0])).toEqual(['LA', 'LC', 'LB']);
  });

  it('news stamp writes the first-commit time into entries without one, then nothing more', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    const nd = join(dir, 'docs/nouveautes');
    mkdirSync(nd, { recursive: true });
    const addIn = (file: string, lot: string, date: string) => {
      writeFileSync(join(nd, file), entry(lot).replace('---\n', '---\n# garder ce commentaire\n') + 'Texte.\n');
      execFileSync('git', ['add', join(nd, file)], { cwd: dir, stdio: 'ignore' });
      commit(dir, `docs(${lot}): nouveauté`, date);
    };
    addIn(L18, 'L18', '2026-09-28T20:07:35+02:00');
    addIn(L21, 'L21', '2026-09-28T22:21:08+02:00');
    writeFileSync(join(nd, 'z.md'), entry('LZ', '2026-09-28T23:59'));
    expect(news(dir, 'check').out).toContain(`${L18} sans heure de création`);

    const r = news(dir, 'stamp');
    expect(r.code).toBe(0);
    const l18 = readFileSync(join(nd, L18), 'utf8');
    expect(l18).toBe(
      `---\n# garder ce commentaire\ntitle: L18\ndate: 2026-09-28\ncreated: ${toStamp(new Date('2026-09-28T20:07:00+02:00'))}\nlots: [L18]\n---\nTexte.\n`,
    );
    expect(r.out.split('\n')).toEqual([`${L21}  created: ${toStamp(new Date('2026-09-28T22:21:00+02:00'))}`, `${L18}  created: ${toStamp(new Date('2026-09-28T20:07:00+02:00'))}`]);
    expect(news(dir, 'check').out).not.toContain('sans heure');
    expect(news(dir, 'stamp').out).toBe('✓ toutes les entrées ont une heure de création');
    expect(loadEntries(nd).map((e) => e.lots[0])).toEqual(['LZ', 'L21', 'L18']);
  });

  it('reports an empty created key; news stamp replaces it instead of adding a second one', () => {
    const empty = 'created vide — cadence news stamp';
    for (const v of ['', ' ~', ' null', ' ""']) {
      expect(parseEntry('x.md', `---\ntitle: X\ndate: 2026-09-28\ncreated:${v}\n---\n`).problems).toEqual([empty]);
    }
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    const nd = join(dir, 'docs/nouveautes');
    mkdirSync(nd, { recursive: true });
    writeFileSync(join(nd, 'x.md'), '---\ntitle: X\ndate: 2026-09-28\ncreated: ~\nlots: [L1]\n---\nTexte.\n');
    expect(news(dir, 'stamp').code).toBe(0);
    const stamp = toStamp(new Date('2026-09-29T10:12:00'));
    expect(readFileSync(join(nd, 'x.md'), 'utf8')).toBe(`---\ntitle: X\ndate: 2026-09-28\ncreated: ${stamp}\nlots: [L1]\n---\nTexte.\n`);
    expect(loadEntries(nd)[0]).toMatchObject({ created: stamp, problems: [] });
  });

  it('rejects a malformed created time', () => {
    expect(parseEntry('x.md', entry('L1', '28/09 22h')).problems).toEqual(['created « 28/09 22h » n\'est pas une heure AAAA-MM-JJTHH:MM']);
  });
});
