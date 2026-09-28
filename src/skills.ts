import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RafError } from './plan.js';

/** Skills livrés avec le paquet (à la racine, à côté de dist/ et src/). */
export const SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url));

export interface Installed {
  name: string;
  status: 'installed' | 'updated' | 'unchanged';
}

/** Installe chaque skill sous « cadence-<nom> » ; refuse d'écraser une copie modifiée sans force. */
export function installSkills(src: string, dest: string, force: boolean): Installed[] {
  const skills = readdirSync(src, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(src, d.name, 'SKILL.md')))
    .map((d) => {
      const name = `cadence-${d.name}`;
      const text = readFileSync(join(src, d.name, 'SKILL.md'), 'utf8').replace(/^name: .*$/m, `name: ${name}`);
      const target = join(dest, name, 'SKILL.md');
      const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
      return { from: join(src, d.name), name, text, target, current };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const conflicts = skills.filter((s) => s.current !== null && s.current !== s.text);
  if (conflicts.length && !force) {
    throw new RafError(`${conflicts.map((s) => s.name).join(', ')} modifié(s) localement : --force pour écraser`);
  }
  return skills.map((s): Installed => {
    if (s.current === s.text) return { name: s.name, status: 'unchanged' };
    cpSync(s.from, join(dest, s.name), { recursive: true });
    writeFileSync(s.target, s.text);
    return { name: s.name, status: s.current === null ? 'installed' : 'updated' };
  });
}
