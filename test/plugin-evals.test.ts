import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// L139 : la suite `claude plugin eval` (evals/) est facturée à chaque run, on ne la lance pas ici ; on vérifie
// seulement qu'elle est lisible par `claude plugin eval` (clés, types de graders) et qu'elle couvre les pièges.
const root = join(import.meta.dirname, '..');
const evalsDir = join(root, 'evals');
const GRADER_TYPES = ['regex', 'tool_order', 'tool_used', 'file_exists', 'llm', 'baseline'];
const PROMPT_KEYS = ['schema_version', 'name', 'description', 'tags', 'plugins', 'runs', 'expected_outcome',
  'model', 'max_turns', 'timeout_seconds', 'allowed_tools', 'artifact_publish', 'growthbook_overrides', 'append_system_prompt', 'env'];

function frontmatter(file: string): { fm: Record<string, unknown>; body: string } {
  const text = readFileSync(file, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  return { fm: (parse(m[1]!) ?? {}) as Record<string, unknown>, body: m[2]!.trim() };
}

const cases = existsSync(evalsDir)
  ? readdirSync(evalsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'results').map((d) => d.name)
  : [];

describe('suite d\'évaluation du plugin (evals/)', () => {
  it('couvre les quatre pièges relevés à la main', () => {
    expect(cases).toEqual(expect.arrayContaining(['raf-done-sans-revue', 'deliver-sha', 'orchestrate-id-avec-slash', 'livrer-sh-sans-bloc']));
  });

  for (const name of cases) {
    describe(name, () => {
      const dir = join(evalsDir, name);
      const { fm, body } = frontmatter(join(dir, 'prompt.md'));

      it('a un prompt.md lisible, sans clé inconnue ni gabarit TODO', () => {
        expect(body.length).toBeGreaterThan(40);
        expect(body).not.toMatch(/TODO/);
        for (const key of Object.keys(fm)) expect(PROMPT_KEYS, `clé « ${key} » inconnue de claude plugin eval`).toContain(key);
        expect(fm.runs).toBeLessThanOrEqual(5); // chaque run est facturé
        expect(fm.tags).toContain('cadence');
        // pas de scaffold_script : il tourne comme l'utilisateur et demande --scaffold
        expect(fm).not.toHaveProperty('scaffold_script');
      });

      it('borne les tours et les outils (lecture seule, Skill pour le plugin)', () => {
        expect(fm.max_turns).toBeLessThanOrEqual(10);
        const tools = fm.allowed_tools as string[];
        expect(tools).toContain('Skill');
        for (const t of tools) expect(['Read', 'Glob', 'Grep', 'Skill']).toContain(t);
      });

      it('a des graders valides dont un jugé par le modèle et un sûr par motif', () => {
        const gdir = join(dir, 'graders');
        const files = readdirSync(gdir).filter((f) => f.endsWith('.md'));
        const graders = files.map((f) => ({ f, ...frontmatter(join(gdir, f)) }));
        expect(graders.length).toBeGreaterThanOrEqual(2);
        for (const g of graders) {
          expect(GRADER_TYPES, `${g.f} : type`).toContain(g.fm.type);
          expect(g.body + String(g.fm.pattern ?? '')).not.toMatch(/TODO/);
          if (g.fm.type === 'regex') {
            const pattern = (g.fm.pattern as string | undefined) ?? g.body;
            expect(() => new RegExp(pattern, String(g.fm.flags ?? ''))).not.toThrow();
          }
          if (g.fm.type === 'llm') expect(g.body.length, `${g.f} : critères`).toBeGreaterThan(40);
        }
        expect(graders.some((g) => g.fm.type === 'llm')).toBe(true);
        expect(graders.some((g) => g.fm.type === 'regex')).toBe(true);
      });
    });
  }
});

describe('lancement de la suite', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  it('passe par un script npm explicite, plafonné en coût, jamais par `npm test`', () => {
    expect(pkg.scripts['eval:plugin']).toMatch(/claude plugin eval/);
    expect(pkg.scripts['eval:plugin']).toMatch(/--max-cost-usd/);
    expect(pkg.scripts.test).not.toMatch(/eval/);
    expect(pkg.scripts.prepublishOnly).not.toMatch(/eval/);
  });

  it('n\'est pas publiée dans le paquet npm', () => {
    expect(pkg.files).not.toContain('evals');
  });

  it('est décrite dans le README (billed, à la release, baseline)', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toMatch(/npm run eval:plugin/);
    expect(readme).toMatch(/claude plugin eval/);
    expect(readme).toMatch(/billed/i);
  });
});
