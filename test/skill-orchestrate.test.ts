import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILLS_DIR } from '../src/skills.js';

const file = readFileSync(join(SKILLS_DIR, 'orchestrate', 'SKILL.md'), 'utf8');
const end = file.indexOf('\n---\n', 4);
const header = file.slice(0, end).replace(/\s+/g, ' ');
const body = file.slice(end + 5);

describe('skill orchestrate (L335) : la ligne de commande d\'une vague sans passer par /lead', () => {
  it('L335 — le skill se déclenche sur « lancer une vague orchestrate » (description, FR et EN)', () => {
    expect(header).toMatch(/^---\s*name: orchestrate\b/);
    expect(header).toMatch(/description:/);
    expect(header).toMatch(/cadence orchestrate/);
    expect(header).toMatch(/vague/i);
    expect(header).toMatch(/wave/i);
    expect(header).toMatch(/--resume/);
  });

  it('L335 — porte la forme <projet>:<lot>[@modèle] et l\'id avec « / » gardé tel quel', () => {
    expect(body).toContain('cadence orchestrate <project>:<lot>[@<model>]');
    expect(body).toContain('cadence orchestrate maritime-atlas:Q4/accueil-4-ux12@haiku');
    expect(body).toMatch(/first `:`/);
    expect(body).toMatch(/never escape|not escape/i);
  });

  it('L335 — dit que --lot et --model n\'existent pas', () => {
    expect(body).toMatch(/no `--lot`/);
    expect(body).toMatch(/`--model`/);
  });

  it('L335 — porte la reprise par --resume [--wave] et l\'état par --status', () => {
    expect(body).toContain('cadence orchestrate --resume --wave <wave>');
    expect(body).toContain('cadence orchestrate --resume');
    expect(body).toContain('cadence orchestrate --status');
  });

  it('L335 — renvoie au skill lead et à la documentation pour le reste, sans le dupliquer', () => {
    expect(body).toContain('docs/orchestrate.md');
    expect(body).toMatch(/cadence:lead/);
    expect(body.length).toBeLessThan(4500);
  });
});
