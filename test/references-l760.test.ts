// L760 : la clé `references:` de cadence.yaml avait deux lecteurs incompatibles — cadence run (v2/src/run/aiguillage.ts) attendait une liste de
// { mots, docs }, cadence ref (readReferencesConfig) un objet { dir } — et un même cadence.yaml ne pouvait servir les deux (vu le 16-11, expertise-gis L5).
// Une seule forme, `references: { dir, run: [{ mots, docs }] }`, lue par scripts/references.mjs dans les deux commandes ; l'ancienne liste est acceptée
// avec un message de migration, jamais ignorée en silence ; validateConfig refuse une forme mal formée.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { readReferencesConfig } from '../src/config.js';
import { validateConfig } from '../src/config-set.js';
import { RafError } from '../src/plan.js';
import { aiguiller, BRAS_COMPLET } from '../v2/src/run/aiguillage.js';
import { parse } from 'yaml';
import { lireReferences, MIGRATION_REFERENCES } from '../scripts/references.mjs';
import { tempDir } from './helpers.js';
import { NORME, stubTools, writePdf } from './ref-fixture.js';

/** Un dépôt (hors git : cadence ref refuse un references.dir dans un dépôt) avec un cadence.yaml, une norme et le PDF de cadence ref. */
function projet(yaml: (refs: string) => string) {
  const base = tempDir();
  const refs = join(base, 'refs');
  const cwd = join(base, 'projet');
  mkdirSync(join(cwd, 'docs', 'normes'), { recursive: true });
  writeFileSync(join(cwd, 'docs', 'normes', 'sigwx.md'), '# SIGWX');
  writeFileSync(join(cwd, 'cadence.yaml'), yaml(refs));
  const env = { RAF_TODAY: '2026-11-16', PATH: `${stubTools(base, ['magick', 'tesseract'])}:${process.env.PATH}`, XDG_DATA_HOME: join(base, 'xdg') } as NodeJS.ProcessEnv;
  return { base, refs, cwd, env, pdf: writePdf(base, 'norme.pdf', NORME), xdg: join(base, 'xdg', 'cadence', 'references') };
}

function refAdd(p: ReturnType<typeof projet>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(['ref', 'add', p.pdf, '--slug', 'norme'], { cwd: p.cwd, env: p.env, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-16T10:00:00') });
  return { code: code as number, err: err.join('\n') };
}

const UNIQUE = (refs: string) => `references:
  dir: ${refs}
  run:
    - mots: [sigwx, jet]
      docs: [docs/normes/sigwx.md]
`;

describe('L760 : un même cadence.yaml sert cadence ref et cadence run', () => {
  it('la forme documentée { dir, run } : cadence ref range sous dir, cadence run aiguille sur run, aucun message de migration', () => {
    const p = projet(UNIQUE);
    expect(() => validateConfig(join(p.cwd, 'cadence.yaml'), p.cwd)).not.toThrow();
    const r = refAdd(p);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('ancienne forme');
    expect(existsSync(join(p.refs, 'norme', 'document.json'))).toBe(true);
    const a = aiguiller('Dessine les SIGWX du niveau 250', p.cwd, []);
    expect(a).toMatchObject({ mode: 'complet', bras: BRAS_COMPLET, pieces: ['docs/normes/sigwx.md'] });
    expect(a.migration).toBeUndefined();
  });

  it('dir seul ou run seul : chaque commande prend sa partie, l\'autre la valeur par défaut', () => {
    const seulDir = projet((refs) => `references:\n  dir: ${refs}\n`);
    expect(refAdd(seulDir).code).toBe(0);
    expect(existsSync(join(seulDir.refs, 'norme', 'document.json'))).toBe(true);
    expect(aiguiller('Dessine les SIGWX', seulDir.cwd, []).mode).toBe('leger');
    const seulRun = projet(() => 'references:\n  run:\n    - { mots: [sigwx], docs: [docs/normes/sigwx.md] }\n');
    expect(refAdd(seulRun).code).toBe(0);
    expect(existsSync(join(seulRun.xdg, 'norme', 'document.json'))).toBe(true);
    expect(aiguiller('Dessine les SIGWX', seulRun.cwd, []).pieces).toEqual(['docs/normes/sigwx.md']);
  });

  it('l\'ancienne forme de cadence run (une liste) : acceptée par les deux commandes et par validateConfig, avec le message de migration', () => {
    const p = projet(() => 'references:\n  - mots: [sigwx]\n    docs: [docs/normes/sigwx.md]\n');
    expect(() => validateConfig(join(p.cwd, 'cadence.yaml'), p.cwd)).not.toThrow();
    const a = aiguiller('Dessine les SIGWX', p.cwd, []);
    expect(a.pieces).toEqual(['docs/normes/sigwx.md']);
    expect(a.migration).toBe(MIGRATION_REFERENCES);
    const r = refAdd(p);
    expect(r.code).toBe(0);
    expect(existsSync(join(p.xdg, 'norme', 'document.json'))).toBe(true);
    expect(r.err.split('\n').filter((l) => l.includes('ancienne forme'))).toEqual([`cadence ref : ${MIGRATION_REFERENCES}`]);
    expect(MIGRATION_REFERENCES).toMatch(/references\.run/);
    expect(MIGRATION_REFERENCES).toMatch(/docs\/config\.md#references/);
  });

  it('une forme mal formée est refusée pareil par validateConfig, cadence ref et cadence run, en nommant la clé', () => {
    for (const [yaml, raison] of [
      ['references: abc\n', 'references doit être un objet'],
      ['references:\n  dossier: x\n', 'references.dossier inconnu (attendu : dir, run)'],
      ['references:\n  dir: ""\n', 'references.dir : chemin attendu'],
      ['references:\n  run: oui\n', 'references.run : liste de { mots: [...], docs: [...] } attendue'],
      ['references:\n  run:\n    - mots: [sigwx]\n', 'references.run[0].docs : liste non vide de textes attendue'],
      ['references:\n  run:\n    - { mots: [], docs: [a.md] }\n', 'references.run[0].mots : liste non vide de textes attendue'],
      ['references:\n  run:\n    - { mots: [sigwx], docs: [a.md], doc: b.md }\n', 'references.run[0].doc inconnu (attendu : mots, docs)'],
      ['references:\n  run:\n    - { mots: [sigwx, 12], docs: [a.md] }\n', 'references.run[0].mots[1] : texte non vide attendu'],
      ['references:\n  - mots: oui\n    docs: [a.md]\n', 'references[0].mots : liste non vide de textes attendue'],
    ] as const) {
      const p = projet(() => yaml);
      const file = join(p.cwd, 'cadence.yaml');
      expect(() => validateConfig(file, p.cwd), yaml).toThrow(RafError);
      expect(() => validateConfig(file, p.cwd), yaml).toThrow(raison);
      expect(() => readReferencesConfig(file), yaml).toThrow(raison);
      const r = refAdd(p);
      expect(r.code, yaml).toBe(2);
      expect(r.err, yaml).toContain(raison);
      expect(() => aiguiller('Dessine les SIGWX', p.cwd, []), yaml).toThrow(raison);
    }
  });

  it('docs/config.md documente la forme unique, et docs/v2 ne montre plus l\'ancienne', () => {
    const doc = readFileSync(join(import.meta.dirname, '..', 'docs', 'config.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## References: `cadence ref` and `cadence run`'));
    expect(section.length).toBeLessThan(doc.length);
    const bloc = /```yaml\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
    // l'exemple de la page se lit avec le lecteur des deux commandes, sans migration
    expect(lireReferences((parse(bloc) as { references: unknown }).references, 'docs/config.md')).toEqual({ dir: '~/kb/references', run: [{ mots: ['sigwx', 'jet', 'cb'], docs: ['docs/normes/sigwx.md'] }] });
    const run = readFileSync(join(import.meta.dirname, '..', 'docs', 'v2', '2026-11-09-cadence-run.md'), 'utf8');
    expect(run).not.toMatch(/references:\n {2}- mots:/);
    expect(run).toContain('references.run');
  });
});
