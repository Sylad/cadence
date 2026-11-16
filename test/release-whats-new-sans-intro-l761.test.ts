import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { draftWhatsNew, whatsNewStructureIssue } from '../src/whats-new-forms.js';
import { commit, gitRepo } from './helpers.js';

// L761 (revue de L753, 16-11) : un paragraphe **x.y.z**: en tête de « Version by version » était pris pour l'introduction ; sans
// introduction, la commande écrivait la nouvelle version sous l'ancienne et sortait quand même en 0. La nouvelle version va toujours
// en tête des paragraphes de version ; une structure non reconnue fait échouer la commande avant tout écrit.

const SANS_INTRO = "# What's new\n\n## In two lines\n\n- **1.2.3**: the old release.\n\n## Version by version\n\n**1.2.3**: the old release, in a long paragraph.\n";
const BODY = '\n### Added\n\n- A new thing (L7).\n';

describe('L761 — « Version by version » sans introduction', () => {
  it('le paragraphe long va en tête des paragraphes de version, avant l’ancien', () => {
    const d = draftWhatsNew(SANS_INTRO, '1.2.4', BODY);
    expect(d.written).toEqual(['ligne de « In two lines »', 'paragraphe long']);
    expect(d.text).toContain('## Version by version\n\n**1.2.4**: A new thing (L7).\n\n**1.2.3**: the old release');
  });

  it('une section vide reçoit le paragraphe sous son titre', () => {
    const vide = "# What's new\n\n## In two lines\n\n## Version by version\n";
    const d = draftWhatsNew(vide, '0.1.0', BODY);
    expect(d.text).toBe("# What's new\n\n## In two lines\n\n- **0.1.0**: A new thing.\n\n## Version by version\n\n**0.1.0**: A new thing (L7).\n");
  });

  it('avec une introduction, rien ne change : le paragraphe suit l’introduction', () => {
    const avec = SANS_INTRO.replace('## Version by version\n\n', '## Version by version\n\nIntro.\n\n');
    expect(draftWhatsNew(avec, '1.2.4', BODY).text).toContain('Intro.\n\n**1.2.4**: A new thing (L7).\n\n**1.2.3**:');
  });

  it('une introduction de deux paragraphes reste entière : le paragraphe va après la seconde', () => {
    const deux = SANS_INTRO.replace('## Version by version\n\n', '## Version by version\n\nIntro p1.\n\nIntro p2.\n\n');
    expect(draftWhatsNew(deux, '1.2.4', BODY).text).toContain('Intro p1.\n\nIntro p2.\n\n**1.2.4**: A new thing (L7).\n\n**1.2.3**:');
  });
});

describe('L761 — structure reconnue', () => {
  it('les deux sections, une fois chacune, « In two lines » d’abord : reconnue', () => {
    expect(whatsNewStructureIssue(SANS_INTRO)).toBeNull();
  });
  it.each([
    ['sans « In two lines »', SANS_INTRO.replace('## In two lines\n', ''), /In two lines/],
    ['sans « Version by version »', SANS_INTRO.replace('## Version by version\n', ''), /Version by version/],
    ['sections inversées', "# W\n\n## Version by version\n\nIntro.\n\n## In two lines\n\n- **1.0.0**: x.\n", /avant/],
    ['section en double', `${SANS_INTRO}\n## Version by version\n\nIntro.\n`, /2 fois/],
  ])('%s : refusée', (_n, text, motif) => {
    expect(whatsNewStructureIssue(text)).toMatch(motif);
  });
});

describe('L761 — cadence release', () => {
  function depot(whatsNew: string): string {
    const dir = gitRepo();
    const put = (f: string, t: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); };
    put('v2/bin/cadence2.js', "console.log(\"banc vert sur l'empreinte test\");\n");
    put('package.json', `${JSON.stringify({ name: 'acme-l761', version: '1.2.3', private: true }, null, 2)}\n`);
    put('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-10-01\n\n### Fixed\n\n- Old fix.\n');
    put('changelog.d/README.md', 'mode d’emploi\n');
    put('changelog.d/L10.md', '### Added\n\n- A new thing (L10).\n');
    put('docs/whats-new.md', whatsNew);
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

  it('sans introduction : le paragraphe écrit en tête, la commande sort en 0', () => {
    const dir = depot(SANS_INTRO);
    const r = release(dir, 'patch');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, 'docs/whats-new.md'), 'utf8')).toContain('## Version by version\n\n**1.2.4**: A new thing (L10).\n\n**1.2.3**:');
  });

  it('un paragraphe de la version écrit à la main sous l’ancien, sans introduction : signalé mal placé, code non nul', () => {
    const dir = depot(`${SANS_INTRO}\n**1.2.4**: by hand, below.\n`);
    const r = release(dir, 'patch');
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/paragraphe long mal placé \(après la version 1\.2\.3/);
  });

  it('structure non reconnue : code non nul, message clair, rien n’est écrit', () => {
    const casse = SANS_INTRO.replace('## Version by version\n', '## Versions\n');
    const dir = depot(casse);
    const r = release(dir, 'patch');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/docs\/whats-new\.md.*Version by version/);
    expect(readFileSync(join(dir, 'docs/whats-new.md'), 'utf8')).toBe(casse);
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).not.toContain('1.2.4');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })).toBe('');
  });
});
