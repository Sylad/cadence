import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// L626 — borne « toute nouvelle page de docs figure dans `files` de package.json » : déclarée dans `bounds` de cadence.yaml, jouée par la porte ciblée dès qu'un lot touche package.json ou une page docs/*.md.
const root = join(import.meta.dirname, '..');

describe('L626 — les pages docs/*.md sont publiées avec le paquet', () => {
  it('R7 — toute page docs/*.md du dépôt figure dans files de package.json', () => {
    const files: string[] = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files;
    const pages = readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`);
    expect(pages.length).toBeGreaterThanOrEqual(20);
    expect(pages.filter((p) => !files.includes(p))).toEqual([]);
  });
});
