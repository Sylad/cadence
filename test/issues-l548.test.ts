import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { issueNumbers } from '../src/issues.js';
import { gitRepo, tempDir } from './helpers.js';

/** Un lot natif écrit à la main : titre libre, notes facultatives. */
const lot = (id: string, status: string, title: string, notes = '') => `  - id: ${id}\n    title: ${JSON.stringify(title)}\n    status: ${status}\n    estimate: 1\n${notes ? `    notes:\n      - { date: 2026-11-03, text: ${JSON.stringify(notes)} }\n` : ''}`;

function project(lots: string, changelog = '# Changelog\n\n## [Unreleased]\n'): string {
  const dir = gitRepo();
  mkdirSync(join(dir, '.cadence'));
  writeFileSync(join(dir, '.cadence/raf.yaml'), `version: 1\nproject: demo\nprefix: L\nlots:\n${lots}`);
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}

/** Un faux `gh` en tête du PATH : `issue list` répond `json` (ou échoue, ou n'existe pas quand `json` est null). */
function fakeGh(json: string | null, exit = 0): NodeJS.ProcessEnv {
  const bin = tempDir();
  if (json !== null) {
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$*" >> "$(dirname "$0")/appels"\nif [ "$1 $2" != "issue list" ]; then echo "appel inattendu: $*" >&2; exit 9; fi\ncat <<'EOF_JSON'\n${json}\nEOF_JSON\nexit ${exit}\n`);
    chmodSync(join(bin, 'gh'), 0o755);
  }
  return { PATH: `${bin}:/usr/bin:/bin` };
}

async function tour(dir: string, env: NodeJS.ProcessEnv, ...extra: string[]) {
  const out: string[] = [];
  const code = await run(['lead', 'tour', ...extra], { cwd: dir, env: { RAF_TODAY: '2026-11-03', CADENCE_HOME: tempDir(), ...env }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-11-03T09:00:00') });
  return { code, out: out.join('\n') };
}

const issues = (...n: number[]) => JSON.stringify(n.map((number) => ({ number, title: `Titre de l'issue ${number}` })));
const RELEASED = '# Changelog\n\n## [Unreleased]\n\n## [1.38.1] - 2026-11-01\n\n- Corrigé (L526).\n';

describe('issueNumbers — « issue #n » dans le texte d’un lot (L548)', () => {
  it('R1 — « issue #n », sans tenir compte de la casse, chaque numéro une fois', () => {
    expect(issueNumbers('GitHub issue #20, puis Issue #21 et encore issue #20')).toEqual([20, 21]);
  });
  it('R1 — « issues #20 et #21 » et « issues #20, #21 » : les deux numéros', () => {
    expect(issueNumbers('issues #20 et #21')).toEqual([20, 21]);
    expect(issueNumbers('issues #20, #21')).toEqual([20, 21]);
  });
  it('R1 — pas de numéro sans le mot issue : « #20 » seul, « issue 20 », « reissue #3 », un id de lot', () => {
    expect(issueNumbers('voir #20 et issue 20, reissue #3, L548')).toEqual([]);
    expect(issueNumbers('')).toEqual([]);
  });
});

describe('cadence lead tour — issues ouvertes (L548)', () => {
  it('R2 — une issue ouverte qu’aucun lot ne cite est listée', async () => {
    const dir = project(lot('L1', 'todo', 'Autre chose'));
    const { out } = await tour(dir, fakeGh(issues(7)));
    expect(out).toMatch(/issue #7 « Titre de l'issue 7 » · ouverte, aucun lot du plan ne la cite/);
  });
  it('R2 — une issue citée par un lot non clos (titre ou note) n’est pas listée', async () => {
    const dir = project(lot('L1', 'todo', 'Corriger (issue #7)') + lot('L2', 'doing', 'Autre', 'voir issue #8'));
    const { out } = await tour(dir, fakeGh(issues(7, 8)));
    expect(out).not.toMatch(/issue #[78] «/);
  });
  it('R3 — une issue dont le lot est clos et cité dans une version publiée du CHANGELOG est listée avec le lot', async () => {
    const dir = project(lot('L526', 'done', 'Réglée (issue #20)'), RELEASED);
    const { out } = await tour(dir, fakeGh(issues(20)));
    expect(out).toMatch(/issue #20 « Titre de l'issue 20 » · ouverte, mais L526 est publié — la fermer : gh issue close 20/);
  });
  it('R3 — lot clos cité seulement dans [Unreleased], ou absent du CHANGELOG : pas encore publié, rien à dire', async () => {
    const unreleased = project(lot('L526', 'done', 'Réglée (issue #20)'), '# Changelog\n\n## [Unreleased]\n\n- Corrigé (L526).\n\n## [1.0.0] - 2026-10-01\n\n- Autre (L1).\n');
    expect((await tour(unreleased, fakeGh(issues(20)))).out).not.toMatch(/issue #20 «/);
    const none = project(lot('L526', 'done', 'Réglée (issue #20)'));
    expect((await tour(none, fakeGh(issues(20)))).out).not.toMatch(/issue #20 «/);
  });
  it('R3 — deux lots citent l’issue, l’un publié, l’autre encore ouvert : elle reste suivie, pas de ligne', async () => {
    const dir = project(lot('L526', 'done', 'Réglée (issue #20)') + lot('L530', 'todo', 'Suite de l’issue #20'), RELEASED);
    expect((await tour(dir, fakeGh(issues(20)))).out).not.toMatch(/issue #20 «/);
  });
  it('R3 — « L52 » publié ne vaut pas pour L526 (le numéro entier)', async () => {
    const dir = project(lot('L52', 'done', 'x') + lot('L5', 'done', 'Réglée (issue #20)'), '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-10-01\n\n- (L52).\n');
    expect((await tour(dir, fakeGh(issues(20)))).out).not.toMatch(/issue #20 «/);
  });
  it('R4 — gh absent, en échec, ou sans JSON : le tour tourne, sans ligne d’issue ni erreur', async () => {
    const dir = project(lot('L1', 'todo', 'Autre'));
    for (const env of [fakeGh(null), fakeGh('[]', 1), fakeGh('pas du json'), fakeGh('{"number":3}')]) {
      const { code, out } = await tour(dir, env);
      expect(code).toBe(0);
      expect(out).not.toMatch(/issue #\d+ «/);
      expect(out).toMatch(/^demo|^[^ ]+ · en cours/m);
    }
  });
  it('R4 — aucune issue ouverte : aucune ligne', async () => {
    const dir = project(lot('L1', 'todo', 'Autre'));
    expect((await tour(dir, fakeGh('[]'))).out).not.toMatch(/issue #\d+ «/);
  });
  it('R5 — rien n’est fermé : le seul appel à gh est « issue list »', async () => {
    const dir = project(lot('L526', 'done', 'Réglée (issue #20)'), RELEASED);
    const env = fakeGh(issues(20));
    expect((await tour(dir, env)).code).toBe(0);
    const calls = readFileSync(join(env.PATH!.split(':')[0]!, 'appels'), 'utf8').trim().split('\n');
    expect(calls.every((c) => c.startsWith('issue list '))).toBe(true);
  });
  it('R6 — --json ne porte pas les lignes d’issue (aucun appel à gh)', async () => {
    const dir = project(lot('L1', 'todo', 'Autre'));
    const { out } = await tour(dir, fakeGh(issues(7)), '--json');
    expect(out).not.toMatch(/issue #7 «/);
    expect(() => JSON.parse(out)).not.toThrow();
  });
});
