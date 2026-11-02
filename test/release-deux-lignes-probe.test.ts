import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { commit, gitRepo } from './helpers.js';

// Sonde L418 : le contrôle « In two lines » de `cadence release` face au test R5 de test/readme-accueil.test.ts.
const PKG = { name: 'acme-tool', version: '1.2.3', scripts: { test: 'vitest run' } };
const LOCK = { name: 'acme-tool', version: '1.2.3', lockfileVersion: 3, packages: { '': { name: 'acme-tool', version: '1.2.3' } } };
const CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A (L7).\n\n## [1.2.3] - 2026-10-01\n\n### Fixed\n\n- Old.\n';

function project(whatsNew: string): string {
  const dir = gitRepo();
  const put = (f: string, t: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); };
  put('package.json', `${JSON.stringify(PKG, null, 2)}\n`);
  put('package-lock.json', `${JSON.stringify(LOCK, null, 2)}\n`);
  put('CHANGELOG.md', CHANGELOG);
  put('docs/whats-new.md', whatsNew);
  execFileSync('git', ['add', '.'], { cwd: dir });
  commit(dir, 'chore: initial');
  return dir;
}
function release(dir: string) {
  const out: string[] = [];
  const code = run(['release', 'patch'], { cwd: dir, env: { RAF_TODAY: '2026-10-26' }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date('2026-10-26T09:00:00') }) as number;
  return { code, out: out.join('\n') };
}
const doc = (short: string, long = '**1.2.4**: long.\n') => `# W\n\n## In two lines\n\n${short}\n## Version by version\n\nIntro.\n\n${long}`;

describe('L418 sonde — « In two lines » lu en entier avant le tag', () => {
  it('une ligne de 240 caractères exactement (limite incluse) passe', () => {
    const l = `- **1.2.3**: ${'x'.repeat(240 - 13)}`;
    expect(l.length).toBe(240);
    expect(release(project(doc(`- **1.2.4**: s.\n${l}\n`))).code).toBe(0);
  });
  it('une ligne de 241 caractères d’une autre version est signalée', () => {
    const l = `- **1.2.3**: ${'x'.repeat(241 - 13)}`;
    const r = release(project(doc(`- **1.2.4**: s.\n${l}\n`)));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/1\.2\.3 fait 241/);
  });
  it('un fichier CRLF aux lignes courtes n’est pas signalé à tort', () => {
    const r = release(project(doc('- **1.2.4**: s.\n- **1.2.3**: old.\n').replace(/\n/g, '\r\n')));
    expect(r.out).not.toMatch(/« In two lines » :/);
  });
  it('la version qui sort listée deux fois, la seconde ligne trop longue, est signalée (R5 la lit)', () => {
    const l = `- **1.2.4**: ${'x'.repeat(260)}`;
    const r = release(project(doc(`- **1.2.4**: s.\n${l}\n`)));
    expect(r.code).toBe(1);
  });
  it('une ligne de liste sans « : » après la version, trop longue, est signalée (R5 filtre sur ^- **x.y.z** seul)', () => {
    const l = `- **1.2.3** ${'x'.repeat(260)}`;
    const r = release(project(doc(`- **1.2.4**: s.\n${l}\n`)));
    expect(r.code).toBe(1);
  });
  it('le fichier sans « Version by version » : paragraphe long de la version qui sort signalé, pas de plantage', () => {
    const r = release(project('# W\n\n## In two lines\n\n- **1.2.4**: s.\n\n**1.2.4**: long.\n'));
    expect(r.code).toBe(1);
  });
  it('fichier vide : exit 1 avec écarts, pas d’exception', () => {
    const r = release(project(''));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/whats-new/);
  });
  it('une section intermédiaire avant « Version by version » n’est pas lue par R5 : une ligne longue y reste sans effet', () => {
    const d = `# W\n\n## In two lines\n\n- **1.2.4**: s.\n\n## Archive\n\n- **1.0.0**: ${'x'.repeat(300)}\n\n## Version by version\n\nIntro.\n\n**1.2.4**: long.\n`;
    expect(release(project(d)).code).toBe(0);
  });
  it('le vrai docs/whats-new.md du dépôt ne produit aucun écart « In two lines » sur ses lignes', () => {
    const real = readFileSync(join(__dirname, '..', 'docs/whats-new.md'), 'utf8');
    const top = /^- \*\*(\d+)\.(\d+)\.(\d+)\*\*:/m.exec(real)!;
    const next = `${top[1]}.${top[2]}.${Number(top[3]) + 1}`;
    const doc2 = real.replace('## In two lines\n\n', `## In two lines\n\n- **${next}**: s.\n`).replace(/(## Version by version\n\n[^\n]*\n\n)/, `$1**${next}**: long.\n\n`);
    const dir = project(doc2);
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ ...PKG, version: `${top[1]}.${top[2]}.${top[3]}` }, null, 2)}\n`);
    const r = release(dir);
    expect(r.out).not.toMatch(/« In two lines » :/);
  });
});
