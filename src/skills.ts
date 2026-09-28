import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RafError } from './plan.js';

/** Skills livrés avec le paquet (à la racine, à côté de dist/ et src/). */
export const SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url));
/** Agents livrés avec le paquet. */
export const AGENTS_DIR = fileURLToPath(new URL('../agents', import.meta.url));

export interface Installed {
  name: string;
  status: 'installed' | 'updated' | 'unchanged';
}

/** Installe chaque skill sous « cadence-<nom> » ; refuse d'écraser une copie modifiée sans force. */
export function installSkills(src: string, dest: string, force: boolean, dryRun = false): Installed[] {
  const skills = readdirSync(src, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(src, d.name, 'SKILL.md')))
    .map((d) => {
      const name = `cadence-${d.name}`;
      const text = readFileSync(join(src, d.name, 'SKILL.md'), 'utf8').replace(/^name: .*$/m, `name: ${name}`);
      const target = join(dest, name, 'SKILL.md');
      // Un dossier présent sans SKILL.md compte comme une copie différente : ne pas le fusionner.
      const current = existsSync(target) ? readFileSync(target, 'utf8') : existsSync(join(dest, name)) ? '' : null;
      return { from: join(src, d.name), name, text, target, current };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const conflicts = skills.filter((s) => s.current !== null && s.current !== s.text);
  if (conflicts.length && !force) {
    throw new RafError(`${conflicts.map((s) => s.name).join(', ')} modifié(s) localement : --force pour écraser`);
  }
  if (dryRun) return [];
  return skills.map((s): Installed => {
    if (s.current === s.text) return { name: s.name, status: 'unchanged' };
    cpSync(s.from, join(dest, s.name), { recursive: true });
    writeFileSync(s.target, s.text);
    return { name: s.name, status: s.current === null ? 'installed' : 'updated' };
  });
}

/** Installe chaque agent `<nom>.md` sous « cadence-<nom>.md » ; mêmes règles que les skills. */
export function installAgents(src: string, dest: string, force: boolean, dryRun = false): Installed[] {
  const agents = readdirSync(src)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const name = `cadence-${f.slice(0, -3)}`;
      const text = readFileSync(join(src, f), 'utf8').replace(/^name: .*$/m, `name: ${name}`);
      const target = join(dest, `${name}.md`);
      const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
      return { name, text, target, current };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const conflicts = agents.filter((a) => a.current !== null && a.current !== a.text);
  if (conflicts.length && !force) {
    throw new RafError(`${conflicts.map((a) => a.name).join(', ')} modifié(s) localement : --force pour écraser`);
  }
  if (dryRun) return [];
  return agents.map((a): Installed => {
    if (a.current === a.text) return { name: a.name, status: 'unchanged' };
    mkdirSync(dest, { recursive: true });
    writeFileSync(a.target, a.text);
    return { name: a.name, status: a.current === null ? 'installed' : 'updated' };
  });
}
