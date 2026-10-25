import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAgents } from '../src/orchestrate/launch.js';
import { readDocsConfig } from '../src/config.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { tempDir } from './helpers.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { docText } from './docs-text.js';

const root = join(import.meta.dirname, '..');
const AGENT = readFileSync(join(root, 'agents', 'doc-keeper.md'), 'utf8');
const SYNC = 'docs:\n  sync:\n    - paths: [src-*.txt]\n      docs: [README.md]\n';

const impl = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `feat(L1): ${file}`)] }));
const keep = (file = 'README.md'): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `docs(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);

/** Pose le cadence.yaml du dépôt de test (commité, comme celui d'un projet). */
function withConfig(h: ReturnType<typeof harness>, yaml = SYNC) {
  writeFileSync(join(h.repo, 'cadence.yaml'), yaml);
  git(h.repo, 'add', '--', 'cadence.yaml');
  git(h.repo, 'commit', '-q', '-m', 'chore(L1): docs.sync', '--', 'cadence.yaml');
}

describe('agent bibliothécaire (agents/doc-keeper.md, L306)', () => {
  it('R1 — l\'agent est livré avec le paquet, avec les outils d\'écriture et sans sous-agent', () => {
    const agents = readAgents(join(root, 'agents'));
    expect(Object.keys(agents)).toContain('doc-keeper');
    const tools = agents['doc-keeper'].tools ?? [];
    expect(tools).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']));
    expect(tools).not.toContain('Agent');
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files).toContain('agents');
  });

  it('R2 — il lit le diff du lot et la carte des documents du projet (docs.sync, README, docs/, CHANGELOG, Nouveautés)', () => {
    for (const mot of ['docs.sync', 'README', 'docs/', 'CHANGELOG', 'Nouveautés', 'diff']) expect(AGENT, mot).toContain(mot);
  });

  it('R3 — session d\'écriture : il met les documents à jour et commite ; lecture seule : il les liste sans rien modifier', () => {
    expect(AGENT).toMatch(/read-only/i);
    expect(AGENT).toMatch(/list/i);
    expect(AGENT).toContain('explicit paths');
  });

  it('R4 — un document hors dépôt : seulement par la configuration (docs.articles), et il propose un lot sans l\'écrire dans le plan', () => {
    expect(AGENT).toContain('docs.articles');
    expect(AGENT).not.toContain('describedBy');
    expect(AGENT).toMatch(/never write[^.]*plan|never[^.]*raf add/i);
    expect(AGENT).toMatch(/propose/i);
  });

  it('R5 — rien de propre à un dossier : l\'agent ne nomme aucun projet ni dossier de Sylvain', () => {
    for (const mot of ['maritime', 'sladoire', 'developpeur', 'claude-code-codex', 'aetherwx', 'finance-tracker']) expect(AGENT.toLowerCase(), mot).not.toContain(mot);
  });

  it('R6 — le README et la page orchestrate décrivent le bibliothécaire et la clé docs.articles qu\'il partage avec la livraison', () => {
    const doc = docText();
    expect(doc).toContain('doc-keeper');
    expect(doc).not.toContain('describedBy');
    expect(readFileSync(join(root, 'docs', 'orchestrate.md'), 'utf8')).toContain('docs.articles');
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain('L306');
  });
});

describe('une seule clé pour les documents hors dépôt : docs.articles (L306, L308)', () => {
  const file = () => join(tempDir(), 'cadence.yaml');

  it('R7 — absente par défaut : fichier absent ou sans la clé, aucune entrée', () => {
    const f = file();
    expect(readDocsConfig(f).articles).toBeUndefined();
    writeFileSync(f, 'priority: [cadence]\n');
    expect(readDocsConfig(f).articles).toBeUndefined();
  });

  it('R8 — « ce projet est aussi décrit par tel fichier de tel dépôt » : les entrées de docs.articles du projet', () => {
    const f = file();
    writeFileSync(f, 'docs:\n  articles:\n    - { repo: ../site, file: src/etudes/cadence.mdx }\n');
    expect(readDocsConfig(f).articles).toEqual([{ repo: '../site', file: 'src/etudes/cadence.mdx' }]);
  });

  it('R9 — l\'ancienne clé describedBy (jamais publiée) est refusée avec le chemin de migration vers docs.articles', () => {
    const f = file();
    writeFileSync(f, 'describedBy:\n  - { project: a, repo: b, file: c }\n');
    expect(() => readDocsConfig(f)).toThrow(/describedBy.*docs\.articles/);
  });
});

describe('orchestrate appelle le bibliothécaire avant la revue (L306)', () => {
  it('R10 — docs.sync signale une doc en retard : une passe doc-keeper avec les écarts calculés, puis la revue', async () => {
    const h = harness({ script: { implement: [impl('src-a.txt')], fix: [keep()], review: [ok] } });
    withConfig(h);
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'review']);
    expect(h.calls[1].args).toContain('doc-keeper');
    expect(h.calls[1].brief).toContain('src-a.txt');
    expect(h.calls[1].brief).toContain('README.md');
    expect(c.lot.status).toBe('ready');
    // La revue ne voit plus d'écart : le bibliothécaire a touché le README.
    expect(h.calls[2].brief).not.toContain('ONE MAJOR finding per line');
  });

  it('R11 — pas d\'écart (le lot touche déjà le README) ou pas de règle docs.sync : aucune passe doc-keeper', async () => {
    const a = harness({ script: { implement: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'src-a.txt', 'feat(L1): a'), commitFile(call.opts.cwd, 'README.md', 'docs(L1): r')] }))], review: [ok] } });
    withConfig(a);
    await runLot(a.lot('L1'));
    expect(kinds(a)).toEqual(['implement', 'review']);
    const b = harness({ script: { implement: [impl('src-a.txt')], review: [ok] } });
    await runLot(b.lot('L1'));
    expect(kinds(b)).toEqual(['implement', 'review']);
  });

  it('R12 — une seule fois par lot : un bibliothécaire qui ne touche pas la doc ne fait pas boucler, et le lot est rendu au lead sans revue (L317)', async () => {
    const h = harness({ script: { implement: [impl('src-a.txt')], fix: [keep('notes.txt')], review: [ok] } });
    withConfig(h);
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix']);
    expect(c.lot.pass).toBe(1);
    expect(c.lot.docsGate).toBe(true);
    expect(c.lot.status).toBe('handed-back');
  });

  it('R13 — le brief du bibliothécaire n\'est pas celui d\'une correction de revue : il nomme le lot, la documentation et le préfixe docs(lot)', async () => {
    const h = harness({ script: { implement: [impl('src-a.txt')], fix: [keep()], review: [ok] } });
    withConfig(h);
    await runLot(h.lot('L1'));
    const brief = h.calls[1].brief;
    expect(brief).toContain('documentation');
    expect(brief).toContain('`L1`');
    expect(brief).toContain('docs(L1)');
    expect(brief).not.toContain('found the defects below');
  });

  it('R14 — budget du lot épuisé ou passes de correction déjà faites : pas de passe doc-keeper, avertissement, la revue part', async () => {
    const a = harness({ script: { implement: [impl('src-a.txt')], review: [ok] } });
    withConfig(a);
    const ca = a.lot('L1', { budget: 100 });
    await runLot(ca);
    expect(kinds(a)).toEqual(['implement', 'review']);
    expect(ca.lot.warnings.join('\n')).toContain('bibliothécaire non appelé');
    const b = harness({ script: { implement: [impl('src-a.txt')], review: [ok] } });
    withConfig(b);
    const cb = b.lot('L1', { pass: 1 });
    await runLot(cb);
    expect(kinds(b)).toEqual(['implement', 'review']);
    expect(cb.lot.warnings.join('\n')).toContain('bibliothécaire non appelé');
  });

  const ARTICLES = (repo: string) => `${SYNC}  articles:\n    - { repo: ${repo}, file: src/etudes/demo.mdx }\n`;

  it('R15 — document hors dépôt déclaré dans docs.articles : le brief le cite avec son chemin absolu, interdit de l\'écrire et demande un lot proposé', async () => {
    const parent = tempDir();
    const h = harness({ parent, script: { implement: [impl('src-a.txt')], fix: [keep()], review: [ok] } });
    withConfig(h, ARTICLES('../site'));
    await runLot(h.lot('L1'));
    const brief = h.calls[1].brief;
    expect(brief).toContain('src/etudes/demo.mdx');
    expect(brief).toContain(join(parent, 'site'));
    expect(brief).toContain('do not edit');
    expect(brief).toContain('proposed lot');
  });

  it('R16 — sans docs.articles, le brief ne parle d\'aucun document hors dépôt', async () => {
    const h = harness({ script: { implement: [impl('src-a.txt')], fix: [keep()], review: [ok] } });
    withConfig(h);
    await runLot(h.lot('L1'));
    expect(h.calls[1].brief).not.toContain('proposed lot');
    expect(h.calls[1].brief).not.toContain('outside this repository');
  });

  it('R21 — le brief ne demande pas de lire un document que la session ne peut pas lire : le dépôt du document est passé en --add-dir', async () => {
    const parent = tempDir();
    const h = harness({ parent, script: { implement: [impl('src-a.txt')], fix: [keep()], review: [ok] } });
    withConfig(h, ARTICLES('../site'));
    await runLot(h.lot('L1'));
    const dirs = h.calls[1].args.flatMap((a, i, all) => (all[i - 1] === '--add-dir' ? [a] : []));
    expect(dirs).toContain(join(parent, 'site'));
    // Les autres passes (implémentation, revue) n'ont pas besoin du dépôt du document.
    expect(h.calls[0].args.flatMap((a, i, all) => (all[i - 1] === '--add-dir' ? [a] : []))).not.toContain(join(parent, 'site'));
  });

  it('R22 — un dépôt donné en chemin absolu est résolu tel quel, pas collé au dossier du projet', async () => {
    const site = tempDir();
    const h = harness({ script: { implement: [impl('src-a.txt')], fix: [keep()], review: [ok] } });
    withConfig(h, ARTICLES(site));
    await runLot(h.lot('L1'));
    expect(h.calls[1].brief).toContain(`(${site}, open to this session for reading)`);
    expect(h.calls[1].args).toContain(site);
  });

  it('R23 — une question du bibliothécaire garde la passe doc-keeper : la reprise rejoue son brief, pas celui d\'une correction ordinaire', async () => {
    const ask: Handler = () => claudeOut(workReport({ questions: ['Quel README ?'] }));
    const h = harness({ script: { implement: [impl('src-a.txt')], fix: [ask] } });
    withConfig(h);
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.questions).toEqual(['Quel README ?']);
    expect(c.lot.docsFix).toBe(true);
  });

  it('R24 — les écarts docs.sync sont calculés au même endroit pour la porte du bibliothécaire et le brief de revue', () => {
    const cycle = readFileSync(join(root, 'src', 'orchestrate', 'cycle.ts'), 'utf8');
    expect(cycle.match(/docSyncGaps\(/g)).toHaveLength(1);
  });

  it('R17 — la passe des mineurs ne rappelle pas le bibliothécaire', async () => {
    const h = harness({ script: { fix: [impl('src-b.txt')], 'review-small': [ok] } });
    withConfig(h);
    const c = h.lot('L1');
    commitFile(h.repo, 'src-a.txt', 'feat(L1): a');
    c.lot.minorPass = true;
    c.lot.minorFix = true;
    c.lot.constats = [{ source: 'code', gravite: 'mineur', fichier: 'src-a.txt', ligne: 1, texte: 'nommage' }];
    c.lot.next = 'fix';
    await runLot(c);
    expect(kinds(h)).toEqual(['fix', 'review-small']);
  });

  it('R18 — le lot proposé du bibliothécaire (resume « lot proposé … ») arrive au lead : proposition du lot, donc tableau de fin de vague', async () => {
    const proposal = 'lot proposé — site : src/etudes/demo.mdx, la phrase sur le bibliothécaire';
    const h = harness({ script: { implement: [impl('src-a.txt')], fix: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'README.md', 'docs(L1): README.md')], resume: proposal }))], review: [ok] } });
    withConfig(h);
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.proposals).toEqual([proposal]);
  });

  it('R19 — un resume ordinaire du bibliothécaire ne crée aucune proposition', async () => {
    const h = harness({ script: { implement: [impl('src-a.txt')], fix: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'README.md', 'docs(L1): README.md')], resume: 'README à jour, rien hors dépôt' }))], review: [ok] } });
    withConfig(h);
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.proposals).toEqual([]);
  });
});

describe('le lead appelle le bibliothécaire à la main (L306)', () => {
  const skill = readFileSync(join(root, 'skills', 'lead', 'SKILL.md'), 'utf8');
  const point = skill.split('\n').find((l) => l.startsWith('0b.')) ?? '';

  it('R20 — le skill lead fait lire docs.articles du cadence.yaml du projet et passer la carte hors dépôt (chemins absolus) au bibliothécaire', () => {
    expect(point).not.toBe('');
    expect(point).toContain('docs.articles');
    expect(point).not.toContain('describedBy');
    expect(point).toMatch(/absolute/);
    expect(point).toMatch(/entries/);
    expect(point).toMatch(/no entry/);
  });

  it('R25 — overview.md (le détail du README, L326) sans ligne blanche perdue entre deux puces, docs/stabilite.md range doc-keeper et la clé', () => {
    const readme = readFileSync(join(root, 'docs', 'overview.md'), 'utf8').split('\n');
    const i = readme.findIndex((l) => l.startsWith('- **doc-keeper**'));
    expect(readme[i - 1]).toMatch(/^- /);
    const stab = readFileSync(join(root, 'docs', 'stabilite.md'), 'utf8');
    expect(stab).toContain('doc-keeper');
    expect(stab).toContain('docs.articles');
  });
});
