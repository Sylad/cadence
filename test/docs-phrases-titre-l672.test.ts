import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { briefFor } from '../src/orchestrate/cycle/brief.js';
import { docsPhrasesText, phrasesOf } from '../src/doc-readers.js';
import { harness } from './orchestrate-harness.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// L672 : le brief d'implement et de fix liste les pages de docs/ qui contiennent les phrases citées du titre du lot.

afterEach(cleanupTempDirs);
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

function repo(): string {
  const root = tempDir();
  mkdirSync(join(root, 'docs/sous'), { recursive: true });
  writeFileSync(join(root, 'docs/gate.md'), '# gate\nla porte est rejouée après « Main  a avancé » sauf delta sans lien\nautre ligne\n');
  writeFileSync(join(root, 'docs/sous/lead.md'), 'quand main a avancé, le lead relance\n');
  writeFileSync(join(root, 'docs/rien.md'), 'rien à voir\n');
  writeFileSync(join(root, 'README.md'), 'main a avancé\n');
  return root;
}

describe('L672 — phrases du titre', () => {
  it('R1 — les phrases citées (« », “ ”, "", accents graves), 5 caractères au moins, espaces réduits, sans doublon', () => {
    expect(phrasesOf('a « main a  avancé » b “le contenu” c "base absente" d `x` e « main a avancé » f « ok »')).toEqual(['main a avancé', 'le contenu', 'base absente']);
    expect(phrasesOf('aucune phrase citée')).toEqual([]);
    expect(phrasesOf('')).toEqual([]);
  });
  it('R2 — les pages de docs/ (imbriquées comprises) dont une ligne contient la phrase, casse et espaces ignorés, avec la ligne ; ni README ni page sans la phrase', () => {
    const text = docsPhrasesText(repo(), 'Moins de portes : après « main a avancé » la porte');
    expect(text).toContain('- `docs/gate.md`: line 2 (« main a avancé »)');
    expect(text).toContain('- `docs/sous/lead.md`: line 1 (« main a avancé »)');
    expect(text).not.toContain('rien.md');
    expect(text).not.toContain('README');
  });
  it('R2 — titre sans phrase citée, phrase absente des pages, sans dossier docs/ : rien', () => {
    expect(docsPhrasesText(repo(), 'titre sans guillemets')).toBe('');
    expect(docsPhrasesText(repo(), 'une « phrase inconnue » ici')).toBe('');
    expect(docsPhrasesText(tempDir(), 'une « main a avancé » ici')).toBe('');
  });
  it('R2 — au plus 3 lignes par page, le reste compté', () => {
    const root = tempDir();
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/p.md'), Array.from({ length: 5 }, () => 'la phrase dite').join('\n'));
    expect(docsPhrasesText(root, '« phrase dite »')).toContain('line 1 (« phrase dite »), 2 (« phrase dite »), 3 (« phrase dite »), and 2 more');
  });
});

function lotIn(title: string) {
  const h = harness();
  const c = Object.assign(h.lot('L1', {}, { test: 'true' }), { tree: { dir: h.repo, branch: 'cadence/x', base: 'main', active: true } });
  c.lot.goal = title;
  mkdirSync(join(h.repo, 'docs'), { recursive: true });
  writeFileSync(join(h.repo, "docs/gate.md"), "la porte après « main a avancé »\n");
  return { h, c };
}

describe('L672 — brief', () => {
  it('R3 — implement et fix reçoivent la consigne ; la revue non', () => {
    const { h, c } = lotIn('rejouer la porte après « main a avancé »');
    try {
      for (const kind of ['implement', 'fix'] as const) expect(briefFor(c, kind), kind).toContain('`docs/gate.md`: line 1');
      expect(briefFor(c, 'review')).not.toContain('Usage pages that contain');
    } finally {
      h.store.removeTmpDir(c.lot.project, c.lot.lot);
    }
  });
  it('R3 — un titre sans phrase citée : pas de consigne', () => {
    const { h, c } = lotIn('corriger un message');
    try {
      expect(briefFor(c, 'implement')).not.toContain('Usage pages that contain');
    } finally {
      h.store.removeTmpDir(c.lot.project, c.lot.lot);
    }
  });
});
