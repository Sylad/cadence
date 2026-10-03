import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { AGENTS_DIR, installSkills, SKILLS_DIR } from '../src/skills.js';
import { gitRepo, tempDir } from './helpers.js';

describe('skills install', () => {
  it('copie les skills préfixés, idempotent, refuse un écrasement sans --force', () => {
    const dest = join(tempDir(), '.claude/skills');
    expect(installSkills(SKILLS_DIR, dest, false)).toEqual([
      { name: 'cadence-deliver', status: 'installed' },
      { name: 'cadence-lead', status: 'installed' },
      { name: 'cadence-session-close', status: 'installed' },
      { name: 'cadence-session-start', status: 'installed' },
    ]);
    const file = join(dest, 'cadence-session-start/SKILL.md');
    expect(readFileSync(file, 'utf8')).toMatch(/^---\nname: cadence-session-start\n/);
    expect(installSkills(SKILLS_DIR, dest, false).every((r) => r.status === 'unchanged')).toBe(true);

    writeFileSync(file, 'modifié à la main');
    expect(() => installSkills(SKILLS_DIR, dest, false)).toThrow(/cadence-session-start.*--force/);
    expect(readFileSync(file, 'utf8')).toBe('modifié à la main');
    expect(installSkills(SKILLS_DIR, dest, true).find((r) => r.name === 'cadence-session-start')?.status).toBe('updated');

    const other = join(tempDir(), 'skills');
    mkdirSync(join(other, 'cadence-deliver'), { recursive: true });
    expect(() => installSkills(SKILLS_DIR, other, false)).toThrow(/cadence-deliver/);
  });

  it('CLI : installe dans .claude/skills du dépôt par défaut', async () => {
    const dir = gitRepo();
    const out: string[] = [];
    const code = await run(['skills', 'install'], { cwd: dir, env: {}, out: (l) => out.push(l), err: () => {}, now: () => new Date() });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('cadence-deliver : installé');
    expect(readFileSync(join(dir, '.claude/skills/cadence-deliver/SKILL.md'), 'utf8')).toContain('name: cadence-deliver');
    expect(out.join('\n')).toContain('cadence-ux-reviewer (agent) : installé');
    expect(readFileSync(join(dir, '.claude/agents/cadence-ux-reviewer.md'), 'utf8')).toMatch(/^---\nname: cadence-ux-reviewer\n/);

    writeFileSync(join(dir, '.claude/agents/cadence-ux-reviewer.md'), 'à la main');
    const again = await run(['skills', 'install'], { cwd: dir, env: {}, out: () => {}, err: () => {}, now: () => new Date() });
    expect(again).toBe(2);
    expect(readFileSync(join(dir, '.claude/agents/cadence-ux-reviewer.md'), 'utf8')).toBe('à la main');
  });

  it('CLI : installe aussi l’agent code-reviewer, en lecture seule et sans outil d’écriture', async () => {
    const dir = gitRepo();
    const out: string[] = [];
    const code = await run(['skills', 'install'], { cwd: dir, env: {}, out: (l) => out.push(l), err: () => {}, now: () => new Date() });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('cadence-code-reviewer (agent) : installé');
    const agent = readFileSync(join(dir, '.claude/agents/cadence-code-reviewer.md'), 'utf8');
    expect(agent).toMatch(/^---\nname: cadence-code-reviewer\ndescription: .+\ntools: Read, Grep, Glob, Bash\n---\n/);
    expect(agent).toContain('raf review <lot> "…"');
  });

  it('agent code-reviewer : le contrat amendé après sa première revue réelle', () => {
    const agent = readFileSync(join(AGENTS_DIR, 'code-reviewer.md'), 'utf8');
    // Les commits viennent de l'outil ; le grep n'est qu'un repli, avec la garde droite qui écarte NC2.4 de NC2.
    expect(agent).toContain('`raf commits <id>`');
    expect(agent).toContain("--grep='(^|[^[:alnum:]_/.-])<id>($|[^[:alnum:]_.-]|\\.($|[^[:alnum:]_]))'");
    expect(agent).toMatch(/Only\s+when `raf` is not available, fall back to/);
    expect(agent).not.toContain('<id>($|[^[:alnum:]_-])');
    const text = agent.replace(/\s+/g, ' ');
    for (const clause of [
      'If the repository has no CLAUDE.md, say so in the report',
      "a parent folder's CLAUDE.md does not count unless it names this project",
      'in the README, then in the manifest (`package.json` scripts, Makefile, `pyproject.toml`…)',
      'A linter or coverage tool the project does not have goes under "not verified": it is not a finding',
      'never run a build whose output directory is used live',
      'a `bin` entry or a symlink on the PATH points to',
      'in a temporary directory outside the repository, removed afterwards: the working tree is left as you found it',
      'When the lot has only a title, also read the bodies of its commits and any spec the lot cites',
      "on a read-only plan (`cadence.yaml` maps the fields of a file kept by another tool), plain lines for the project's own tool",
      'Untested code that is practically unreachable, and a rule that holds as written while an edge defeats its purpose, are *minor* — unless they can lose or corrupt data',
      'It is the last line of the review; extra sections a caller asks for come after it',
    ]) expect(text).toContain(clause);
  });

  it('les skills lead et session-close nomment la porte de revue de code', () => {
    const skill = (name: string) => readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    expect(skill('lead')).toContain('The `code-reviewer` agent');
    expect(skill('lead')).toContain('`raf review <lot> "…"`');
    expect(skill('lead')).toContain('do not push, deliver, run `raf done`, `raf ux` or\n> `raf review`.');
    expect(skill('session-close')).toContain('`raf review <id> "…"`');
  });
});
