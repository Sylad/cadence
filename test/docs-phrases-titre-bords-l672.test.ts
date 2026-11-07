import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { docsPhrasesText, phrasesOf } from '../src/doc-readers.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// L672 (bords) : les phrases citées du titre cherchées dans docs/.

afterEach(cleanupTempDirs);

describe('L672 bords — phrasesOf', () => {
  it('guillemets non fermés ou vides : aucune phrase, pas d\'exception', () => {
    expect(phrasesOf('« jamais fermée')).toEqual([]);
    expect(phrasesOf('« » “” "" ``')).toEqual([]);
  });
  it('phrase de 4 caractères exclue, de 5 retenue', () => {
    expect(phrasesOf('« abcd » « abcde »')).toEqual(['abcde']);
  });
  it('la même phrase sous deux types de guillemets : une seule fois', () => {
    expect(phrasesOf('« main a avancé » et "main a avancé"')).toEqual(['main a avancé']);
  });
});

describe('L672 bords — docsPhrasesText', () => {
  it('fins de ligne CRLF : la ligne est trouvée', () => {
    const root = tempDir();
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/w.md'), 'a\r\nla main a avancé ici\r\n');
    expect(docsPhrasesText(root, '« main a avancé »')).toContain('`docs/w.md`: line 2');
  });
  it('plus de 12 pages : 12 listées, le reste compté', () => {
    const root = tempDir();
    mkdirSync(join(root, 'docs'));
    for (let i = 0; i < 15; i++) writeFileSync(join(root, `docs/p${String(i).padStart(2, '0')}.md`), 'la phrase dite\n');
    const t = docsPhrasesText(root, '« phrase dite »');
    expect(t.match(/^- `docs\//gm)?.length).toBe(12);
    expect(t).toContain('and 3 more page(s)');
  });
  it('fichier non .md ou page hors docs/ ignorés ; docs vide : rien', () => {
    const root = tempDir();
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/x.txt'), 'la phrase dite\n');
    expect(docsPhrasesText(root, '« phrase dite »')).toBe('');
  });
  it('titre vide : rien', () => {
    expect(docsPhrasesText(tempDir(), '')).toBe('');
  });
  it('deux phrases sur la même ligne : les deux citées', () => {
    const root = tempDir();
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/x.md'), 'alpha beta et gamma delta\n');
    expect(docsPhrasesText(root, '« alpha beta » « gamma delta »')).toContain('line 1 (« alpha beta », « gamma delta »)');
  });
});
