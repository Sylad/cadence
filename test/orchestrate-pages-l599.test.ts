import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKED, checkLinks } from '../scripts/check-links.mjs';

const root = join(import.meta.dirname, '..');
const read = (f: string): string => readFileSync(join(root, f), 'utf8');
const SUITE = ['orchestrate-cycle.md', 'orchestrate-gate.md', 'orchestrate-spec.md', 'orchestrate-worktrees.md'];

describe('L599 — orchestrate.md en cinq pages', () => {
  it('R1 — les quatre pages nouvelles sont publiées (files de package.json) et contrôlées (CHECKED)', () => {
    const files: string[] = JSON.parse(read('package.json')).files;
    for (const p of SUITE) {
      expect(files, p).toContain(`docs/${p}`);
      expect(CHECKED, p).toContain(`docs/${p}`);
    }
  });

  it('R2 — orchestrate.md porte un sommaire qui lie les quatre pages, et aucune page ne dépasse 110 Ko (308 Ko avant)', () => {
    const main = read('docs/orchestrate.md');
    expect(main).toContain('## The five pages');
    for (const p of SUITE) expect(main, p).toContain(`](${p})`);
    for (const p of ['orchestrate.md', ...SUITE]) expect(Buffer.byteLength(read(`docs/${p}`)), p).toBeLessThan(110_000);
  });

  it('R3 — chaque page porte la navigation vers les quatre autres et le retour au README', () => {
    for (const p of SUITE) {
      const t = read(`docs/${p}`);
      expect(t, p).toContain('[← cadence](../README.md)');
      for (const q of ['orchestrate.md', ...SUITE].filter((x) => x !== p)) expect(t, `${p} → ${q}`).toContain(`](${q})`);
    }
  });

  it('R4 — la sonde vit dans orchestrate-gate.md avec son titre, et le README y renvoie', () => {
    expect(read('docs/orchestrate-gate.md')).toMatch(/^## The edge-case probe \(`orchestrate\.probe`, L497\)$/m);
    expect(read('README.md')).toContain('docs/orchestrate-gate.md#the-edge-case-probe-orchestrateprobe-l497');
    expect(read('docs/orchestrate.md')).not.toMatch(/^## The edge-case probe/m);
  });

  it('R5 — une section déplacée ne vit que sur une page ; l\'ancienne page garde son ancre avec une ligne de renvoi', () => {
    const main = read('docs/orchestrate.md');
    for (const p of SUITE) {
      for (const m of read(`docs/${p}`).matchAll(/^## (.+)$/gm)) {
        const title = m[1]!;
        expect(main, `renvoi ${title}`).toMatch(new RegExp(`^### ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\nMoved to \\[${p}\\]\\(${p}#`, 'm'));
        expect(main, `titre ${title}`).not.toMatch(new RegExp(`^## ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
      }
    }
  });

  it('R6 — aucun lien relatif cassé dans les cinq pages (ancres comprises)', () => {
    expect(checkLinks(root, ['docs/orchestrate.md', ...SUITE.map((p) => `docs/${p}`)])).toEqual([]);
  });

  it('R7 — le sommaire est du markdown rendu : aucune ligne du sommaire ne tombe dans un bloc de code', () => {
    let inFence = false;
    const inside: number[] = [];
    read('docs/orchestrate.md').split('\n').forEach((line, i) => {
      if (/^```/.test(line)) inFence = !inFence;
      else if (inFence && (line.startsWith('## The five pages') || /^- \[orchestrate-[a-z]+\.md\]/.test(line))) inside.push(i + 1);
    });
    expect(inside).toEqual([]);
  });

  it('R8 — une page d\'usage qui cite « docs/orchestrate*.md, « Titre » » ou une clé nommée pointe la page qui porte le paragraphe', () => {
    const pages = Object.fromEntries(['orchestrate.md', ...SUITE].map((p) => [p, read(`docs/${p}`)]));
    const where = (needle: string): string[] => Object.keys(pages).filter((p) => pages[p].includes(needle));
    for (const [usage, cited, needle] of [
      ['deliver.md', 'orchestrate-gate.md', 'A red test is replayed alone'],
      ['deliver.md', 'orchestrate-gate.md', 'A gate declared in parts'],
      ['perf.md', 'orchestrate-cycle.md', 'Budget set by the measure'],
      ['fonctionnement.md', 'orchestrate-cycle.md', 'Budget set by the measure'],
    ]) {
      expect(where(needle), needle).toContain(cited);
      expect(read(`docs/${usage}`), `${usage} → ${cited}`).toMatch(new RegExp(`${cited.replace('.', '\\.')}[^«]{0,30}« ${needle} »`));
    }
    for (const usage of ['deliver.md', 'perf.md', 'fonctionnement.md']) {
      expect(read(`docs/${usage}`), usage).not.toMatch(/docs\/orchestrate\.md[^«]{0,30}« (A red test is replayed alone|A gate declared in parts|Budget set by the measure) »/);
    }
  });
});
