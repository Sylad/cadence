import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestrateConfig } from '../src/config.js';
import { reposText, tiersText } from '../src/orchestrate/briefs.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { newLot, RunStore } from '../src/orchestrate/state.js';
import { readTier, tierRepos } from '../src/orchestrate/tiers.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

const WIP = 'wip/demo-L1';

/** Un dépôt frère du lot, dans le dossier parent, avec un premier commit sur `branch` (aucun commit : `commit: false`). */
function sibling(parent: string, name: string, opts: { branch?: string; commit?: boolean } = {}): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', opts.branch ?? 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  if (opts.commit !== false) commitFile(dir, 'README.md', 'init');
  return dir;
}

/** Une implémentation qui commite dans le dépôt du projet puis agit (`act`) dans le dépôt tiers. */
const impl = (tier: string, act: (tier: string) => void = () => {}): Handler => (call) => {
  const p = commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a');
  act(tier);
  return claudeOut(workReport({ commits: [p] }));
};
const ok: Handler = () => claudeOut(reviewReport());

/** Un lot L1 dont le dépôt a un frère `gitops` dans son dossier parent ; `act` joue dans ce frère pendant l'implémentation. */
function world(act: (tier: string) => void = () => {}, config: Partial<OrchestrateConfig> = {}, tierOpts: { branch?: string; commit?: boolean } = {}) {
  const parent = tempDir();
  const tier = sibling(parent, 'gitops', tierOpts);
  const h = harness({ parent, script: { implement: [impl(tier, act)], review: [ok] } });
  const logs: string[] = [];
  h.wave.log = (l) => logs.push(l);
  return { h, parent, tier, logs, c: h.lot('L1', {}, config) };
}

const commitOnMain = (t: string) => commitFile(t, 'chart.yaml', 'feat(L1): deploy.sh');

describe('L456 R1 — le brief d\'écriture interdit et donne la voie', () => {
  it('R1 — brief d\'écriture : l\'interdiction et wip/<projet>-<lot> sont présents', async () => {
    const { h, c } = world();
    await runLot(c);
    const brief = h.calls[0].brief;
    expect(brief).toMatch(/Never commit on the main branch \(.*\) of any repository other than/);
    expect(brief).toContain(`\`${WIP}\``);
    expect(tiersText('demo', 'L1')).toContain(`\`${WIP}\``);
    expect(h.calls.find((k) => k.kind === 'review')?.brief).not.toContain(WIP);
  });

  it('R1 — brief d\'écriture avec voisin déclaré : reposText inchangé', async () => {
    const parent = tempDir();
    const nb = sibling(parent, 'neighbour');
    const h = harness({ parent, script: { implement: [impl(nb)], review: [ok] } });
    const repos = [{ rel: '../neighbour', path: nb }];
    await runLot(h.lot('L1', { repos }));
    const text = reposText('write', 'L1', repos);
    expect(text).not.toContain('wip/');
    expect(h.calls[0].brief).toContain(text);
    expect(h.calls[0].brief).toContain(WIP);
  });
});

describe('L456 R1 — passe de correction', () => {
  it('R1 — le brief de la passe fix porte aussi l\'interdiction et wip/<projet>-<lot>', async () => {
    const major: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 3, texte: 'bug nommé' }], verdict: 'non conforme' }));
    const fix: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'b.txt', 'fix(L1): b')] }));
    const parent = tempDir();
    const h = harness({ parent, script: { implement: [impl('')], review: [major, ok], fix: [fix] } });
    await runLot(h.lot('L1'));
    const brief = h.calls.find((k) => k.kind === 'fix')?.brief ?? '';
    expect(brief).toContain(`\`${WIP}\``);
  });
});

describe('L456 C1 — commit sur la branche principale d\'un dépôt tiers', () => {
  it('R2 — commit sur main d\'un dépôt tiers : lot rendu avec le constat', async () => {
    const { h, c, tier } = world(commitOnMain);
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('incident : commit sur la branche principale d\'un autre dépôt (gitops, main) pendant demo:L1 (implement)');
    expect(h.calls.map((k) => k.kind)).toEqual(['implement']);
    expect(c.lot.steps[0].status).toBe('failed');
    expect(c.wave.dirtyRepos?.get(tier)).toBe('demo:L1');
  });

  it('R2 — commit fait puis HEAD remis ailleurs : constat quand même', async () => {
    const { c } = world((t) => {
      commitOnMain(t);
      git(t, 'checkout', '-q', '-b', 'ailleurs');
    });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('(gitops, main)');
  });

  it('R2 — branche principale inchangée : aucun incident', async () => {
    const { h, c } = world();
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(h.calls.map((k) => k.kind)).toEqual(['implement', 'review']);
  });

  it('R3 — commit sur main d\'un dépôt non cité du dossier parent : lot rendu', async () => {
    const parent = tempDir();
    const other = sibling(parent, 'jamais-cite');
    const h = harness({ parent, script: { implement: [impl(other, commitOnMain)] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(h.plan().lot('L1').title).not.toContain('jamais-cite');
    expect(c.lot.outcome).toContain('(jamais-cite, main)');
  });

  it('R3 — enfant du dossier parent qui n\'est pas un dépôt git : ignoré, vague continue', async () => {
    const parent = tempDir();
    mkdirSync(join(parent, 'docs-vrac'));
    writeFileSync(join(parent, 'docs-vrac', 'a.txt'), 'x');
    writeFileSync(join(parent, 'fichier.txt'), 'x');
    const h = harness({ parent, script: { implement: [impl('', () => {})], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
  });

  it('R4 — origin/HEAD pointe develop : commit sur develop détecté', async () => {
    const { c } = world(
      (t) => commitOnMain(t),
      {},
      { branch: 'develop' },
    );
    const parentOf = c.lot.repo.replace(/\/depot$/, '');
    git(join(parentOf, 'gitops'), 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(join(parentOf, 'gitops'), 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    await runLot(c);
    expect(c.lot.outcome).toContain('(gitops, develop)');
  });

  it('R4 — dépôt tiers avec branche par défaut master : commit détecté', async () => {
    const { c } = world(commitOnMain, {}, { branch: 'master' });
    await runLot(c);
    expect(c.lot.outcome).toContain('(gitops, master)');
  });

  it('R4 — main et master présentes : un commit sur master est détecté', async () => {
    const { c } = world((t) => {
      git(t, 'checkout', '-q', 'master');
      commitOnMain(t);
    });
    const tier = join(c.lot.repo.replace(/\/depot$/, ''), 'gitops');
    git(tier, 'branch', 'master');
    await runLot(c);
    expect(c.lot.outcome).toContain('(gitops, master)');
  });

  it('R4 — commit sur une branche autre que principale : aucun incident', async () => {
    const { c } = world((t) => {
      git(t, 'checkout', '-q', '-b', 'feature');
      commitOnMain(t);
    });
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.warnings.join('\n')).not.toContain('dépôt tiers');
  });

  it('R5 — commit sur wip/<projet>-<lot> d\'un dépôt tiers : pas d\'incident', async () => {
    const { c, tier } = world((t) => {
      git(t, 'checkout', '-q', '-b', WIP);
      commitOnMain(t);
      git(t, 'checkout', '-q', 'main');
    });
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(git(tier, 'log', '-1', '--format=%s', WIP)).toBe('feat(L1): deploy.sh');
    expect(c.lot.warnings.join('\n')).not.toContain('dépôt tiers');
  });

  it('R6 — constat : dépôt, branche, sha court, sujet et wip/<projet>-<lot> présents', async () => {
    const { c, tier } = world((t) => {
      commitFile(t, 'a.yaml', 'feat(L1): premier');
      commitFile(t, 'b.yaml', 'feat(L1): second');
    });
    await runLot(c);
    const sha = (rev: string) => git(tier, 'rev-parse', '--short=7', rev);
    expect(c.lot.outcome).toContain(`${sha('HEAD')} feat(L1): second`);
    expect(c.lot.outcome).toContain(`${sha('HEAD~1')} feat(L1): premier`);
    expect(c.lot.outcome).toContain(`; la voie est la branche ${WIP}`);
    expect(c.lot.steps[0].cause).toContain('gitops');
  });

  it('R6 — constat rendu avant le lancement des tests du lot', async () => {
    const marker = join(tempDir(), 'tests-lances');
    const gate = { test: `touch ${marker}`, build: 'true' };
    const clean = world(() => {}, gate);
    await runLot(clean.c);
    expect(readFileSync(marker, 'utf8')).toBe('');
    const bad = join(tempDir(), 'tests-lances');
    const { c } = world(commitOnMain, { test: `touch ${bad}`, build: 'true' });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(() => readFileSync(bad)).toThrow();
  });

  it('R7 — le test crée un commit sur main du tiers, laisse le programme constater, puis vérifie que le sha de main est celui du commit fautif et que git reflog n\'a aucune entrée reset ou checkout ajoutée par le programme', async () => {
    let fault = '';
    let reflogAfterCommit = '';
    const { c, tier } = world((t) => {
      fault = commitOnMain(t).sha;
      reflogAfterCommit = git(t, 'reflog', '--format=%H %gs', 'HEAD') + '\n' + git(t, 'reflog', '--format=%H %gs', 'refs/heads/main');
    });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(git(tier, 'rev-parse', 'main')).toBe(fault);
    expect(git(tier, 'reflog', '--format=%H %gs', 'HEAD') + '\n' + git(tier, 'reflog', '--format=%H %gs', 'refs/heads/main')).toBe(reflogAfterCommit);
    expect(reflogAfterCommit).not.toMatch(/reset|checkout|revert/);
  });

  it('R8 — voisin déclaré aussi enfant du dossier parent : jamais compté comme tiers', async () => {
    const parent = tempDir();
    const nb = sibling(parent, 'neighbour');
    const h = harness({ parent, script: { implement: [impl(nb, commitOnMain)], review: [ok] } });
    const c = h.lot('L1', { repos: [{ rel: '../neighbour', path: nb }] });
    await runLot(c);
    expect(c.lot.status).toBe('ready');
  });

  it('R8 — dépôt du lot lui-même : jamais compté comme tiers', async () => {
    const { h, c } = world();
    expect(tierRepos(c.lot.repo, [c.lot.repo]).map((r) => r.replace(/.*\//, ''))).toEqual(['gitops']);
    await runLot(c);
    expect(h.calls.map((k) => k.kind)).toEqual(['implement', 'review']);
  });

  it('R8 — dépôt à deux niveaux sous le dossier parent : non surveillé', async () => {
    const parent = tempDir();
    const deep = sibling(parent, 'groupe/profond');
    const h = harness({ parent, script: { implement: [impl(deep, commitOnMain)], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
  });

  it('R9 — session de revue sans commit tiers : comportement inchangé', async () => {
    const { h, c } = world();
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(h.calls.map((k) => k.kind)).toEqual(['implement', 'review']);
  });

  it('R9 — la revue ne relève pas les tiers : un commit sur leur main pendant la revue n\'est pas le constat de R2', async () => {
    const parent = tempDir();
    const tier = sibling(parent, 'gitops');
    const h = harness({ parent, script: { implement: [impl(tier)], review: [() => { commitOnMain(tier); return claudeOut(reviewReport()); }] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.outcome ?? '').not.toContain('autre dépôt');
  });

  it('R10 — la doc d\'orchestrate cite l\'interdiction, wip/<projet>-<lot> et les dépôts non surveillés', () => {
    const doc = readFileSync(new URL('../docs/orchestrate.md', import.meta.url), 'utf8');
    const at = doc.indexOf('## A session never commits on another repository');
    expect(at).toBeGreaterThan(-1);
    const section = doc.slice(at, doc.indexOf('\n## ', at + 5));
    expect(section).toContain('wip/<project>-<lot>');
    expect(section.replace(/\s+/g, ' ')).toMatch(/never commits on the main branch/);
    expect(section).toMatch(/direct child/);
    expect(section).toMatch(/other lots of the same wave/);
    expect(section).toMatch(/linked worktree/);
    expect(section).toMatch(/does not undo/);
  });

  it('R11 — HEAD resté sur wip dans un tiers : avertissement, branche non remise, aucun incident', async () => {
    const { c, tier } = world((t) => {
      git(t, 'checkout', '-q', '-b', WIP);
      commitOnMain(t);
    });
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(git(tier, 'branch', '--show-current')).toBe(WIP);
    expect(c.lot.warnings).toContain(`implement : la session a laissé le dépôt tiers gitops sur la branche ${WIP} ; elle n'est pas remise`);
  });

  it('R11 — tiers resté sur sa branche : aucun avertissement', async () => {
    const { c } = world();
    await runLot(c);
    expect(c.lot.warnings.join('\n')).not.toContain('dépôt tiers');
  });

  it('R12 — voisin déclaré basculé sur une autre branche : remise avec avertissement, comme avant', async () => {
    const parent = tempDir();
    const nb = sibling(parent, 'neighbour');
    const h = harness({ parent, script: { implement: [impl(nb, (t) => git(t, 'checkout', '-q', '-b', 'autre'))], review: [ok] } });
    const c = h.lot('L1', { repos: [{ rel: '../neighbour', path: nb }] });
    await runLot(c);
    expect(git(nb, 'branch', '--show-current')).toBe('main');
    expect(c.lot.warnings.some((w) => w.includes('dans ../neighbour') && /remise/.test(w))).toBe(true);
  });

  it('R13 — sha illisible après la session : ignoré, ligne du journal, vague continue', async () => {
    const { c, logs } = world((t) => writeFileSync(join(t, '.git', 'HEAD'), 'garbage\n'));
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(logs.some((l) => /dépôt tiers gitops ignoré : lecture impossible \(.+\)/.test(l))).toBe(true);
  });

  it('R13 — dépôt sans commit : ignoré', async () => {
    const { c, logs } = world(() => {}, {}, { commit: false });
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(logs.some((l) => l.includes('dépôt tiers gitops ignoré'))).toBe(true);
  });

  it('R13 — branche main créée avec un commit pendant la session : constat', async () => {
    const { c } = world(commitOnMain, {}, { commit: false });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('(gitops, main)');
  });

  it('R13 — branche main créée sur l\'historique de master : constat sans les commits anciens', async () => {
    const { c } = world(
      (t) => {
        git(t, 'checkout', '-q', '-b', 'main');
        commitOnMain(t);
      },
      {},
      { branch: 'master' },
    );
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('(gitops, main)');
    expect(c.lot.outcome).toContain('feat(L1): deploy.sh');
    expect(c.lot.outcome).not.toMatch(/[0-9a-f]{7} init/);
  });

  it('R13 — branche main créée sans commit neuf : « branche créée », pas les commits anciens', async () => {
    const { c } = world((t) => git(t, 'branch', 'main'), {}, { branch: 'master' });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('(gitops, main)');
    expect(c.lot.outcome).toContain('branche créée');
    expect(c.lot.outcome).not.toMatch(/[0-9a-f]{7} init/);
  });

  it('R13 — branche master supprimée pendant la session : constat', async () => {
    const { c } = world(
      (t) => {
        git(t, 'checkout', '-q', '-b', 'ailleurs');
        git(t, 'branch', '-D', 'master');
      },
      {},
      { branch: 'master' },
    );
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/\(gitops, master\).*supprimée/);
  });

  it('R14 — deux lots de projets frères dans la même vague, l\'un avance sa branche principale : aucun constat sur l\'autre', async () => {
    const parent = tempDir();
    const sibRepo = sibling(parent, 'frere');
    const sibNeighbour = sibling(parent, 'frere-voisin');
    const h = harness({ parent, script: { implement: [impl(sibRepo, (t) => { commitOnMain(t); commitOnMain(sibNeighbour); })], review: [ok] } });
    h.store.writeLot({ ...newLot({ project: 'frere', repo: sibRepo, lot: 'L9', title: 'autre', visible: false, small: false, model: 'sonnet', readOnlyPlan: false }), repos: [{ rel: '../frere-voisin', path: sibNeighbour }] });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
  });

  it('R17 — une autre vague en cours du même dossier : ses lots ne sont pas surveillés', async () => {
    const parent = tempDir();
    const sibRepo = sibling(parent, 'frere');
    const h = harness({ parent, script: { implement: [impl(sibRepo, commitOnMain)], review: [ok] } });
    const autre = new RunStore(h.launch, 'w2');
    writeFileSync(join(autre.dir, 'wave.json'), JSON.stringify({ id: 'w2', created: '2026-10-04', cwd: h.launch, budget: 1, consumed: 0, cacheRead: 0, status: 'running', pid: process.pid, lots: ['frere:L9'] }));
    autre.writeLot(newLot({ project: 'frere', repo: sibRepo, lot: 'L9', title: 'autre', visible: false, small: false, model: 'sonnet', readOnlyPlan: false }));
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    writeFileSync(join(autre.dir, 'wave.json'), JSON.stringify({ id: 'w2', created: '2026-10-04', cwd: h.launch, budget: 1, consumed: 0, cacheRead: 0, status: 'done', pid: process.pid, lots: ['frere:L9'] }));
  });

  it('R17 — une autre vague terminée : ses lots sont surveillés', async () => {
    const parent = tempDir();
    const sibRepo = sibling(parent, 'frere');
    const h = harness({ parent, script: { implement: [impl(sibRepo, commitOnMain)], review: [ok] } });
    const autre = new RunStore(h.launch, 'w2');
    writeFileSync(join(autre.dir, 'wave.json'), JSON.stringify({ id: 'w2', created: '2026-10-04', cwd: h.launch, budget: 1, consumed: 0, cacheRead: 0, status: 'done', pid: process.pid, lots: ['frere:L9'] }));
    autre.writeLot(newLot({ project: 'frere', repo: sibRepo, lot: 'L9', title: 'autre', visible: false, small: false, model: 'sonnet', readOnlyPlan: false }));
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
  });

  it('R14 — dépôt absent de la vague : surveillé', async () => {
    const { c } = world(commitOnMain);
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
  });

  it('R15 — enfant worktree lié : ignoré', async () => {
    const parent = tempDir();
    const main = sibling(tempDir(), 'source');
    git(main, 'worktree', 'add', '-q', '-b', 'master', join(parent, 'lie'));
    const wt = join(parent, 'lie');
    const h = harness({ parent, script: { implement: [impl(wt, (t) => commitOnMain(t)) ], review: [ok] } });
    const c = h.lot('L1');
    expect(tierRepos(c.lot.repo, [c.lot.repo])).toEqual([]);
    await runLot(c);
    expect(c.lot.status).toBe('ready');
  });

  it('R15 — lien symbolique vers un dépôt déjà enfant : compté une fois', () => {
    const parent = tempDir();
    const real = sibling(parent, 'gitops');
    symlinkSync(real, join(parent, 'a-alias'));
    mkdirSync(join(parent, 'depot'));
    const found = tierRepos(join(parent, 'depot'), []);
    expect(found).toHaveLength(1);
  });

  it('R15 — dossier parent dépôt git : non surveillé', async () => {
    const parent = tempDir();
    git(parent, 'init', '-q', '-b', 'main');
    git(parent, 'config', 'user.email', 'test@example.com');
    git(parent, 'config', 'user.name', 'Test');
    git(parent, 'config', 'commit.gpgsign', 'false');
    commitFile(parent, 'README.md', 'init');
    const h = harness({ parent, script: { implement: [impl(parent, commitOnMain)], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
  });

  it('R16 — relevé des tiers : aucun appel à ls-remote ni fetch', () => {
    const parent = tempDir();
    const tier = sibling(parent, 'gitops');
    git(tier, 'remote', 'add', 'origin', join(parent, 'nulle-part'));
    const trace = join(tempDir(), 'trace.txt');
    process.env.GIT_TRACE = trace;
    try {
      readTier(tier);
    } finally {
      delete process.env.GIT_TRACE;
    }
    const text = readFileSync(trace, 'utf8');
    expect(text).not.toMatch(/ls-remote|fetch/);
    expect(text.split('\n').filter((l) => /built-in: git |run_command: git /.test(l))).toHaveLength(1);
  });

  it('R16 — vingt enfants du dossier parent : une lecture de références par dépôt, aucun ls-remote', () => {
    const parent = tempDir();
    mkdirSync(join(parent, 'depot'));
    for (let i = 0; i < 20; i++) sibling(parent, `d${i}`);
    const trace = join(tempDir(), 'trace.txt');
    process.env.GIT_TRACE = trace;
    try {
      for (const r of tierRepos(join(parent, 'depot'), [])) readTier(r);
    } finally {
      delete process.env.GIT_TRACE;
    }
    const lines = readFileSync(trace, 'utf8').split('\n').filter((l) => /built-in: git |run_command: git /.test(l));
    expect(lines).toHaveLength(20);
    expect(lines.every((l) => l.includes('for-each-ref'))).toBe(true);
  });

  describe('fin de session sans sortie « ok »', () => {
    const quota = { code: 1, stdout: JSON.stringify({ is_error: true, subtype: 'success', result: 'Claude AI usage limit reached|1759600000', session_id: 's', num_turns: 1, duration_ms: 1, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } }), stderr: '', timedOut: false };
    const endings: [string, { code: number; stdout: string; stderr: string; timedOut: boolean }][] = [
      ['en échec (code 1)', { code: 1, stdout: '', stderr: 'boom', timedOut: false }],
      ['coupée au délai', { code: 0, stdout: '', stderr: '', timedOut: true }],
      ['au quota', quota],
    ];
    for (const [label, ending] of endings) {
      it(`R2 — session ${label} après un commit sur main d'un dépôt tiers : lot rendu avec le constat`, async () => {
        const parent = tempDir();
        const tier = sibling(parent, 'gitops');
        const h = harness({ parent, script: { implement: [() => { commitOnMain(tier); return ending; }] } });
        const c = h.lot('L1');
        await runLot(c);
        expect(c.lot.status).toBe('handed-back');
        expect(c.lot.outcome).toContain('incident : commit sur la branche principale d\'un autre dépôt (gitops, main) pendant demo:L1 (implement)');
        expect(c.lot.outcome).toContain('feat(L1): deploy.sh');
        expect(c.wave.dirtyRepos?.get(tier)).toBe('demo:L1');
      });
    }

    it('R2 — session au quota après un commit sur main d\'un dépôt tiers : la vague le sait', async () => {
      const parent = tempDir();
      const tier = sibling(parent, 'gitops');
      const h = harness({ parent, script: { implement: [() => { commitOnMain(tier); return quota; }] } });
      const c = h.lot('L1');
      await runLot(c);
      expect(c.wave.quota?.hit).toBe(true);
    });

    it('R2 — session en échec sans commit sur un dépôt tiers : l\'échec reste un échec', async () => {
      const parent = tempDir();
      sibling(parent, 'gitops');
      const h = harness({ parent, script: { implement: [() => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false })] } });
      const c = h.lot('L1');
      await runLot(c);
      expect(c.lot.status).toBe('failed');
      expect(c.lot.outcome).toMatch(/implement sans résultat/);
    });
  });

  describe('R18 — commits du lead', () => {
    const PLAN = '.cadence/raf.yaml';
    const leadPlan = (t: string) => {
      mkdirSync(join(t, '.cadence'), { recursive: true });
      commitFile(t, PLAN, 'plan: add L126');
    };

    it('R18 — commit « plan: » ne changeant que le fichier du plan : pas d\'incident', async () => {
      const { c } = world(leadPlan);
      await runLot(c);
      expect(c.lot.status).toBe('ready');
    });

    it('R18 — commit « plan: » qui touche aussi un autre fichier : constat', async () => {
      const { c } = world((t) => {
        writeFileSync(join(t, 'values.yaml'), 'tag: sha-1\n');
        mkdirSync(join(t, '.cadence'), { recursive: true });
        writeFileSync(join(t, PLAN), 'plan\n');
        git(t, 'add', '--', 'values.yaml', PLAN);
        git(t, 'commit', '-q', '-m', 'plan: add L126');
      });
      await runLot(c);
      expect(c.lot.status).toBe('handed-back');
      expect(c.lot.outcome).toContain('plan: add L126');
    });

    it('R18 — le commit du lead à côté de celui de la session : le constat ne nomme que le second', async () => {
      const { c } = world((t) => { leadPlan(t); commitOnMain(t); });
      await runLot(c);
      expect(c.lot.status).toBe('handed-back');
      expect(c.lot.outcome).toContain('feat(L1): deploy.sh');
      expect(c.lot.outcome).not.toContain('plan: add L126');
    });
  });
});
