import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readAgents } from '../src/orchestrate/launch.js';
import { readDescribedBy } from '../src/config.js';
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

  it('R4 — un document hors dépôt : seulement par la configuration, et il propose un lot sans l\'écrire dans le plan', () => {
    expect(AGENT).toContain('describedBy');
    expect(AGENT).toMatch(/never write[^.]*plan|never[^.]*raf add/i);
    expect(AGENT).toMatch(/propose/i);
  });

  it('R5 — rien de propre à un dossier : l\'agent ne nomme aucun projet ni dossier de Sylvain', () => {
    for (const mot of ['maritime', 'sladoire', 'developpeur', 'claude-code-codex', 'aetherwx', 'finance-tracker']) expect(AGENT.toLowerCase(), mot).not.toContain(mot);
  });

  it('R6 — le README et la page orchestrate décrivent le bibliothécaire et la clé describedBy', () => {
    const doc = docText();
    expect(doc).toContain('doc-keeper');
    expect(doc).toContain('describedBy');
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain('L306');
  });
});

describe('describedBy : documents hors dépôt, par configuration (L306)', () => {
  const file = () => join(tempDir(), 'cadence.yaml');

  it('R7 — absente par défaut : fichier absent ou sans la clé, aucune entrée', () => {
    const f = file();
    expect(readDescribedBy(f, 'cadence')).toEqual([]);
    writeFileSync(f, 'priority: [cadence]\n');
    expect(readDescribedBy(f, 'cadence')).toEqual([]);
  });

  it('R8 — « tel projet est aussi décrit par tel fichier de tel dépôt » : les entrées du projet, pas celles des autres', () => {
    const f = file();
    writeFileSync(f, 'describedBy:\n  - { project: cadence, repo: site, file: src/etudes/cadence.mdx }\n  - { project: autre, repo: site, file: src/etudes/autre.mdx }\n');
    expect(readDescribedBy(f, 'cadence')).toEqual([{ project: 'cadence', repo: 'site', file: 'src/etudes/cadence.mdx' }]);
    expect(readDescribedBy(f, 'inconnu')).toEqual([]);
  });

  it('R9 — une entrée invalide est refusée avec le nom de la clé', () => {
    const f = file();
    for (const [yaml, mot] of [
      ['describedBy: oui', 'describedBy'],
      ['describedBy: [oui]', 'describedBy[0]'],
      ['describedBy: [{ project: a, repo: b }]', 'describedBy[0].file'],
      ['describedBy: [{ project: a, repo: b, file: "" }]', 'describedBy[0].file'],
      ['describedBy: [{ project: a, repo: b, file: c, nope: 1 }]', 'describedBy[0].nope'],
    ] as const) {
      writeFileSync(f, `${yaml}\n`);
      expect(() => readDescribedBy(f, 'a'), yaml).toThrow(mot);
    }
  });
});

describe('orchestrate appelle le bibliothécaire avant la revue (L306)', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const f of created.splice(0)) rmSync(f, { force: true });
  });

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

  it('R12 — une seule fois par lot : un bibliothécaire qui ne touche pas la doc ne fait pas boucler, la revue part et porte l\'écart', async () => {
    const h = harness({ script: { implement: [impl('src-a.txt')], fix: [keep('notes.txt')], review: [ok] } });
    withConfig(h);
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'review']);
    expect(c.lot.pass).toBe(1);
    expect(c.lot.docsGate).toBe(true);
    expect(h.calls[2].brief).toContain('- src-a.txt changed, but none of README.md was touched');
  });

  it('R13 — le brief du bibliothécaire n'est pas celui d'une correction de revue : il nomme le lot, la documentation et le préfixe docs(lot)', async () => {
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

  it('R15 — document hors dépôt déclaré dans le cadence.yaml du dossier parent : le brief le cite, interdit de l\'écrire et demande un lot proposé', async () => {
    const h = harness({ script: { implement: [impl('src-a.txt')], fix: [keep()], review: [ok] } });
    withConfig(h);
    const parent = join(dirname(h.repo), 'cadence.yaml');
    created.push(parent);
    writeFileSync(parent, `describedBy:\n  - { project: ${basename(h.repo)}, repo: site, file: src/etudes/demo.mdx }\n`);
    await runLot(h.lot('L1'));
    const brief = h.calls[1].brief;
    expect(brief).toContain('src/etudes/demo.mdx');
    expect(brief).toContain(join(dirname(h.repo), 'site'));
    expect(brief).toContain('do not edit');
    expect(brief).toContain('proposed lot');
  });

  it('R16 — sans clé describedBy, le brief ne parle d\'aucun document hors dépôt', async () => {
    const h = harness({ script: { implement: [impl('src-a.txt')], fix: [keep()], review: [ok] } });
    withConfig(h);
    await runLot(h.lot('L1'));
    expect(h.calls[1].brief).not.toContain('proposed lot');
    expect(h.calls[1].brief).not.toContain('describedBy');
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
});
