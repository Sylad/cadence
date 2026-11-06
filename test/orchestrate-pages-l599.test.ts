import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKED, checkLinks } from '../scripts/check-links.mjs';

const root = join(import.meta.dirname, '..');
const read = (f: string): string => readFileSync(join(root, f), 'utf8');
// Liste figée des sections (## sur leur page) que L599 a réellement déplacées d'orchestrate.md, titre + page.
// Une section absente de cette liste (neuve ou future) n'exige aucun renvoi. Les ### déplacées sont couvertes par R11.
const DEPLACEES: Array<[string, string]> = [
  ['The `orchestrate` keys of `cadence.yaml` (reference)', 'orchestrate-cycle.md'],
  ['The spec step of a lot with `screen:`', 'orchestrate-spec.md'],
  ['The light mockup (L459)', 'orchestrate-spec.md'],
  ['The spec step of a lot with `spec: true`', 'orchestrate-spec.md'],
  ['The mockup review: before any code', 'orchestrate-spec.md'],
  ['Brief size (L559)', 'orchestrate-spec.md'],
  ['The accept step: red acceptance tests and their lock', 'orchestrate-spec.md'],
  ['Elements of a reference document in the briefs (L367)', 'orchestrate-spec.md'],
  ['The downstream briefs: sheet, rule → test → green, conformity, Hypothèses', 'orchestrate-spec.md'],
  ['Proposals the lot\'s own commits may have treated (L422)', 'orchestrate-cycle.md'],
  ['Reviews converge: follow-ups and a wall cap (L622)', 'orchestrate-cycle.md'],
  ['Express lane (L519)', 'orchestrate-cycle.md'],
  ['Cost in euros, before and after a wave (L529)', 'orchestrate-cycle.md'],
  ['Sealed tests and shared files: the pre-check of what a lot may collide with (L500)', 'orchestrate-gate.md'],
  ['The edge-case probe (`orchestrate.probe`, L497)', 'orchestrate-gate.md'],
  ['The subject of the plan commits (`plan.commit`, L343)', 'orchestrate-cycle.md'],
  ['One worktree per lot (`orchestrate.worktrees`, L279)', 'orchestrate-worktrees.md'],
  ['A lot whose work is in a neighbouring repository', 'orchestrate-worktrees.md'],
  ['A session never commits on another repository (L456)', 'orchestrate-worktrees.md'],
];
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

  it('R5 — chaque section de la liste figée des sections déplacées par L599 vit sur sa page ; orchestrate.md garde son ancre avec une ligne de renvoi, sans le titre ## (une section hors liste n\'exige rien)', () => {
    const main = read('docs/orchestrate.md');
    const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const [title, p] of DEPLACEES) {
      expect(main, `renvoi ${title}`).toMatch(new RegExp(`^### ${esc(title)}\\n\\nMoved to \\[${p}\\]\\(${p}#`, 'm'));
      expect(main, `titre ${title}`).not.toMatch(new RegExp(`^## ${esc(title)}$`, 'm'));
      expect(read(`docs/${p}`), `section ${title} sur ${p}`).toMatch(new RegExp(`^## ${esc(title)}$`, 'm'));
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

  it('R9 — la référence des clés `orchestrate.*` de cadence.yaml a son titre sur orchestrate-cycle.md ; le sommaire et les pages d\'usage y mènent', () => {
    const title = 'The `orchestrate` keys of `cadence.yaml` (reference)';
    const anchor = 'orchestrate-cycle.md#the-orchestrate-keys-of-cadenceyaml-reference';
    const cycle = read('docs/orchestrate-cycle.md');
    expect(cycle).toContain(`\n## ${title}\n`);
    const section = cycle.slice(cycle.indexOf(`\n## ${title}\n`));
    for (const key of ['worktreeDeps', 'testReplay', 'testRelated', 'gate: { host']) expect(section, key).toContain(`  ${key}`);
    expect(cycle).toContain('`orchestrate.budgetTopUp`');
    expect(read('docs/orchestrate.md')).not.toContain('worktreeDeps:');
    const main = read('docs/orchestrate.md');
    const sommaire = main.slice(main.indexOf('## The five pages'), main.indexOf('```sh'));
    expect(sommaire).toContain(`](${anchor})`);
    expect(sommaire).toContain('`worktreeDeps`');
    for (const usage of ['quickstart.md', 'overview.md']) expect(read(`docs/${usage}`), usage).toContain(`](${anchor})`);
    expect(read('docs/quickstart.md')).not.toMatch(/The reference for every other key is \[orchestrate\]\(orchestrate\.md\)/);
    expect(read('docs/quickstart.md')).not.toMatch(/How waves, budgets and reviews work: \[orchestrate\]\(orchestrate\.md\)\./);
    for (const p of SUITE) expect(read('docs/overview.md'), p).toContain(`](${p})`);
  });

  it('R10 — un renvoi sans titre vers orchestrate.md qui cite un paragraphe, une clé ou une commande déplacés vise la page qui les porte (news, qualite, raf)', () => {
    const pages = Object.fromEntries(['orchestrate.md', ...SUITE].map((p) => [p, read(`docs/${p}`)]));
    const where = (needle: string): string[] => Object.keys(pages).filter((p) => pages[p].includes(needle));
    for (const [usage, cited, needle, stale] of [
      ['news.md', 'orchestrate-cycle.md', '**Librarian before the review', /« Librarian before the review » in \[orchestrate\]\(orchestrate\.md\)/],
      ['qualite.md', 'orchestrate-gate.md', '**The build is played before the tests (L333)**', /build runs before the tests \(\[orchestrate\.md\]\(orchestrate\.md\)\)/],
      ['raf.md', 'orchestrate-spec.md', '`cadence spec green <lot>`', /unfinished wave keeps a lot of the repository open; see \[orchestrate\]\(orchestrate\.md\)/],
      ['raf.md', 'orchestrate-worktrees.md', 'Resources deduced from the diff', /\(orchestrate\.md#[a-z0-9-]+\) \(« Resources deduced from the diff »\)/],
    ] as const) {
      expect(where(needle), needle).toEqual([cited]);
      const t = read(`docs/${usage}`);
      expect(t, `${usage} → ${cited}`).toContain(`](${cited}`);
      expect(t, `${usage} stale`).not.toMatch(stale);
    }
    expect(checkLinks(root, ['docs/news.md', 'docs/qualite.md', 'docs/raf.md', 'docs/quickstart.md', 'docs/overview.md'])).toEqual([]);
  });
  it('R11 — les renvois « below » de la page d\'entrée, les ancres ### déplacées, le gabarit accept et l\'index du README suivent les paragraphes', () => {
    const main = read('docs/orchestrate.md');
    expect(main).not.toMatch(/\*\*formatting retry\*\* \(below\)/);
    expect(main).toContain('« Formatting retry » in [orchestrate-cycle.md](orchestrate-cycle.md)');
    expect(main).not.toMatch(/except the light review below/);
    expect(main).toContain('« Review sized to the lot » in [orchestrate-cycle.md](orchestrate-cycle.md)');
    for (const [title, anchor] of [
      ['`plan.onWrite`: the published plan follows every write (L346)', 'planonwrite-the-published-plan-follows-every-write-l346'],
      ['Time limit of a write step (L298)', 'time-limit-of-a-write-step-l298'],
    ]) {
      expect(read('docs/orchestrate-cycle.md'), title).toContain(`\n### ${title}\n`);
      expect(main, title).toContain(`### ${title}\n\nMoved to [orchestrate-cycle.md](orchestrate-cycle.md#${anchor})`);
    }
    const tpl = read('templates/acceptation-runner.mjs');
    expect(tpl).toContain('docs/orchestrate-spec.md');
    expect(tpl).not.toContain('docs/orchestrate.md');
  });

  it('R12 — la maquette légère, concepts.md et stabilite.md citent la page qui porte la voie express, les tailles de lot et les codes de sortie', () => {
    const spec = read('docs/orchestrate-spec.md');
    expect(spec).not.toContain('(the express lane, below, stays one session)');
    expect(spec).toContain('[the express lane](orchestrate-cycle.md#express-lane-l519)');
    const concepts = read('docs/concepts.md');
    expect(concepts).not.toContain('Detail: [orchestrate.md](orchestrate.md#orchestrate).');
    expect(concepts).toContain('Detail: « Review sized to the lot » in [orchestrate-cycle.md](orchestrate-cycle.md)');
    const stab = read('docs/stabilite.md');
    expect(stab).toContain('[orchestrate](orchestrate.md)');
    for (const p of SUITE) expect(stab, p).toContain(`](${p})`);
    expect(checkLinks(root, ['docs/orchestrate-spec.md', 'docs/concepts.md', 'docs/stabilite.md'])).toEqual([]);
  });
});
