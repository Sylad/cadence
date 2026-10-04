import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { installPrePush } from '../src/orchestrate/guard.js';
import { projectLogDir } from '../src/orchestrate/launch.js';
import { tempDir } from './helpers.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

/** Une implémentation qui commite un fichier citant le lot. */
const impl = (file = 'a.txt', over: Record<string, unknown> = {}): Handler => (call) => {
  const c = commitFile(call.opts.cwd, file, `feat(L1): ${file}`);
  return claudeOut(workReport({ commits: [c], ...over }));
};
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const major: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 3, texte: 'bug nommé' }], verdict: 'non conforme' }));
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);

describe('cycle nominal', () => {
  it('implémentation Sonnet → revue Opus neuve conforme → raf review écrit avec le sha relu, raf done non appelé', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.outcome).toBe('prêt à livrer');
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(h.calls[0].model).toBe('sonnet');
    expect(h.calls[1].model).toBe('opus');
    expect(h.calls[1].args).toContain('--agent');
    for (const call of h.calls) {
      expect(call.args).not.toContain('--resume');
      expect(call.opts.cwd).toBe(h.repo);
      expect(call.opts.env.CADENCE_ORCHESTRATED).toBe('w1');
    }
    const lot = h.plan().lot('L1');
    expect(lot.status).toBe('doing'); // raf done reste au lead
    expect(lot.review?.verdict).toContain('conforme : rien à signaler — orchestré (vague w1, 0 passe(s) de correction)');
    const lastWork = git(h.repo, 'log', '--format=%H', '--grep=feat(L1)', '-1');
    expect(lot.review?.commit).toBe(lastWork);
    expect(git(h.repo, 'status', '--porcelain')).toBe('');
    expect(git(h.repo, 'log', '--format=%s').split('\n').slice(0, 3)).toEqual([
      'plan: L1 revue de code enregistrée (orchestrate w1)',
      'feat(L1): a.txt',
      'plan: L1 démarré (orchestrate w1)',
    ]);
    // l'état est écrit : tokens séparés, budget = entrée + écriture + sortie
    const state = h.store.readLot('demo', 'L1')!;
    expect(state.steps[0].tokens).toEqual({ input: 100, cacheWrite: 1000, cacheRead: 50_000, output: 400, counted: 1500 });
    expect(h.wave.budget.consumed).toBe(3000);
    expect(h.wave.budget.cacheRead).toBe(100_000);
    expect(existsSync(join(h.store.dir, 'demo--L1', '1-implement.json'))).toBe(true);
  });

  it('un lot déjà en cours n\'est pas redémarré', async () => {
    const h = harness({ lots: [{ title: 'x', status: 'doing' }], script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(git(h.repo, 'log', '--format=%s')).not.toContain('démarré');
    expect(c.lot.status).toBe('ready');
  });
});

describe('corrections', () => {
  it('revue non conforme → correction en session NEUVE → conforme', async () => {
    const h = harness({ script: { implement: [impl()], review: [major, ok], fix: [fix('b.txt')] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review']);
    expect(c.lot.pass).toBe(1);
    expect(c.lot.status).toBe('ready');
    expect(h.calls[2].model).toBe('sonnet');
    expect(h.calls[2].brief).toContain('[majeur] a.txt:3 — bug nommé');
    expect(h.calls[2].brief).toContain('feat(L1): a.txt');
    expect(h.calls[2].args).not.toContain('--resume');
    expect(h.plan().lot('L1').review?.verdict).toContain('1 passe(s) de correction');
    // la revue qui a validé a lu le dernier commit
    expect(h.plan().lot('L1').review?.commit).toBe(git(h.repo, 'log', '--format=%H', '--grep=fix(L1)', '-1'));
  });

  it('2 passes épuisées → rendu au lead avec les constats restants, aucun verdict écrit', async () => {
    const h = harness({ script: { implement: [impl()], review: [major, major, major], fix: [fix('b.txt'), fix('c.txt')] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/après 2 passe\(s\) de correction/);
    expect(c.lot.constats[0].texte).toBe('bug nommé');
    expect(h.plan().lot('L1').review).toBeUndefined();
  });

  it('les totaux annoncés à 0 ne cachent pas un constat majeur', async () => {
    const liar: Handler = () => claudeOut(reviewReport({ majeurs: 0, constats: [{ gravite: 'majeur', texte: 'x' }] }));
    const h = harness({ script: { implement: [impl()], review: [liar, ok], fix: [fix('b.txt')] } });
    await runLot(h.lot('L1'));
    expect(kinds(h)).toContain('fix');
  });

  it('les mineurs et sous-tâches proposées sont rendus au lead, pas ajoutés au plan', async () => {
    const minor: Handler = () => claudeOut(reviewReport({ mineurs: 1, constats: [{ gravite: 'mineur', fichier: 'a.txt', ligne: 1, texte: 'nommage' }], sousTaches: ['ajouter un test'] }));
    const h = harness({ script: { implement: [impl()], review: [minor] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.proposals).toEqual(['[mineur code] a.txt:1 — nommage', '[sous-tâche code] ajouter un test']);
    expect(h.plan().lot('L1').tasks).toEqual([]);
  });
});

describe('lot visible : UX puis code', () => {
  it('UX d\'abord, revue de code en dernier ; correction issue de l\'UX suivie d\'une revue de code', async () => {
    const uxBad: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'ui.css', texte: 'contraste 2:1 (WCAG 1.4.3)' }], verdict: 'UX non conforme' }));
    const h = harness({
      lots: [{ title: 'Écran', visible: true }],
      script: { implement: [impl()], ux: [uxBad, ok], review: [ok, ok], fix: [fix('b.txt')] },
    });
    const c = h.lot('L1', { visible: true }, { ux: { url: 'http://localhost:4200' } });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'ux', 'review', 'fix', 'ux', 'review']);
    expect(kinds(h).at(-1)).toBe('review');
    expect(h.calls[1].args[h.calls[1].args.indexOf('--agent') + 1]).toBe('ux-reviewer');
    expect(h.calls[1].brief).toContain('http://localhost:4200');
    expect(h.calls[3].brief).toContain('contraste 2:1 (WCAG 1.4.3)');
    expect(c.lot.status).toBe('ready');
    expect(c.lot.uxVerdict).toBe('conforme : rien à signaler');
    // pas de raf ux automatique
    expect(h.plan().lot('L1').ux).toBeUndefined();
    expect(h.plan().lot('L1').review).toBeDefined();
  });

  it('sans application déclarée : pas de session UX, « à faire par le lead »', async () => {
    const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', { visible: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.uxNote).toMatch(/UX à faire par le lead/);
    expect(c.lot.status).toBe('ready');
  });
});

describe('petit lot', () => {
  it('une seule session de revue (Opus), et @haiku ne vaut que pour l\'implémentation', async () => {
    const h = harness({ lots: [{ title: 'petit', estimate: 0.5, visible: true }], script: { implement: [impl()], 'review-small': [ok] } });
    const c = h.lot('L1', { small: true, visible: true, model: 'haiku' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review-small']);
    expect(h.calls[0].model).toBe('haiku');
    expect(h.calls[1].model).toBe('opus');
    expect(h.calls[1].brief).toContain('single pass');
    expect(c.lot.status).toBe('ready');
  });
});

describe('contrôles autour des sessions', () => {
  it('tests annoncés rouges → correction directe (compte une passe), sans revue avant', async () => {
    const h = harness({ script: { implement: [impl('a.txt', { tests: { commande: 'npm test', resultat: '2 failed', vert: false } })], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'review']);
    expect(h.calls[1].brief).toContain('tests annoncés rouges');
    expect(c.lot.pass).toBe(1);
  });

  it('tests rouges quand l\'orchestrateur les lance (orchestrate.test)', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'test -f b.txt || { echo boom >&2; exit 3; }' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'review']);
    expect(h.calls[1].brief).toContain('en échec (code 3)');
    expect(h.calls[1].brief).toContain('boom');
  });

  it('une question arrête le lot ; la réponse relance l\'étape dans une session neuve', async () => {
    const ask: Handler = () => claudeOut(workReport({ questions: ['PostgreSQL ou SQLite ?'] }));
    const h = harness({ script: { implement: [ask, impl()], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('question');
    expect(c.lot.questions).toEqual(['PostgreSQL ou SQLite ?']);
    await runLot(c); // sans réponse : rien ne se relance
    expect(h.calls).toHaveLength(1);
    c.lot.pendingAnswer = 'SQLite';
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'implement', 'review']);
    expect(h.calls[1].brief).toContain('Answer from the human to your earlier question: SQLite');
    expect(c.lot.status).toBe('ready');
  });

  it('session muette (code ≠ 0) : échec nommé, pas de nouvel essai', async () => {
    const h = harness({ script: { implement: [() => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false })] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(c.lot.outcome).toMatch(/implement sans résultat/);
    expect(h.calls).toHaveLength(1);
    expect(readFileSync(join(h.store.dir, 'demo--L1', '1-implement.err'), 'utf8')).toBe('boom');
  });

  it('délai dépassé', async () => {
    const h = harness({ script: { implement: [() => ({ code: 0, stdout: '', stderr: '', timedOut: true })] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.outcome).toMatch(/délai dépassé/);
  });

  it('dépôt sale après une session : rendu au lead, fichiers listés, rien n\'est commité ni jeté', async () => {
    const dirty: Handler = (call) => {
      const c = commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a');
      writeFileSync(join(call.opts.cwd, 'a.txt'), 'modifié après');
      writeFileSync(join(call.opts.cwd, 'oublie.txt'), 'x');
      return claudeOut(workReport({ commits: [c] }));
    };
    const h = harness({ script: { implement: [dirty] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('a.txt');
    expect(c.lot.outcome).toContain('oublie.txt');
    expect(readFileSync(join(h.repo, 'oublie.txt'), 'utf8')).toBe('x');
  });

  it('commit qui ne cite pas le lot : signalé, le lot continue ; commit annoncé introuvable : signalé', async () => {
    const stray: Handler = (call) => {
      const a = commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a');
      commitFile(call.opts.cwd, 'z.txt', 'chore: sans lot');
      return claudeOut(workReport({ commits: [a, { sha: 'deadbee', sujet: 'fantôme' }] }));
    };
    const h = harness({ script: { implement: [stray], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.warnings.some((w) => w.includes('ne cite pas L1') && w.includes('chore: sans lot'))).toBe(true);
    expect(c.lot.warnings.some((w) => w.includes('annoncé absent de git') && w.includes('deadbee'))).toBe(true);
  });

  it('reprise : un commit d\'une session précédente du lot, cité par le rapport, n\'est pas « absent de git » (L25)', async () => {
    let earlier = { sha: '', sujet: '' };
    const resumed: Handler = (call) => {
      const b = commitFile(call.opts.cwd, 'b.txt', 'feat(L1): b');
      return claudeOut(workReport({ commits: [earlier, b, { sha: 'deadbee', sujet: 'fantôme' }] }));
    };
    const h = harness({ script: { implement: [resumed], review: [ok] } });
    earlier = commitFile(h.repo, 'a.txt', 'feat(L1): a (session précédente)');
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    const absent = c.lot.warnings.filter((w) => w.includes('annoncé absent de git'));
    expect(absent).toHaveLength(1);
    expect(absent[0]).toContain('deadbee');
  });

  it('implémentation sans aucun commit : rendu au lead', async () => {
    const h = harness({ script: { implement: [() => claudeOut(workReport())] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toBe('implement sans commit');
  });

  it('une revue qui modifie le dépôt : incident, vague arrêtée, rien enregistré', async () => {
    const touchy: Handler = (call) => {
      commitFile(call.opts.cwd, 'intrus.txt', 'fix(L1): la revue a corrigé');
      return claudeOut(reviewReport());
    };
    const h = harness({ script: { implement: [impl()], review: [touchy] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(h.wave.incident).toMatch(/a modifié le dépôt/);
    expect(h.plan().lot('L1').review).toBeUndefined();
  });

  it('un push (même contourné) arrête la vague', async () => {
    const pushy: Handler = (call) => {
      const c = commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a');
      git(call.opts.cwd, 'push', '-q'); // le hook n'est pas posé dans ce test unitaire : le contrôle d'après-session le voit
      return claudeOut(workReport({ commits: [c] }));
    };
    const h = harness({ script: { implement: [pushy] } });
    const bare = join(h.launch, 'origin.git');
    git(h.launch, 'init', '-q', '--bare', '-b', 'main', bare);
    git(h.repo, 'remote', 'add', 'origin', bare);
    git(h.repo, 'push', '-q', '-u', 'origin', 'main');
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(h.wave.incident).toMatch(/push détecté/);
  });

  it('une session qui supprime le hook de garde exclu de git : incident (L3/t19)', async () => {
    const killer: Handler = (call) => {
      rmSync(join(call.opts.cwd, '.githooks/pre-push'));
      return claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
    };
    const hh = harness({ script: { implement: [killer] } });
    git(hh.repo, 'config', 'core.hooksPath', '.githooks');
    installPrePush(hh.repo, 'w1');
    const c = hh.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(hh.wave.incident).toMatch(/hook pre-push de garde a été supprimé/);
  });

  it('avec le hook pre-push posé, le push de la session échoue', async () => {
    const h = harness({ script: { implement: [] } });
    const bare = join(h.launch, 'origin.git');
    git(h.launch, 'init', '-q', '--bare', '-b', 'main', bare);
    git(h.repo, 'remote', 'add', 'origin', bare);
    git(h.repo, 'push', '-q', '-u', 'origin', 'main');
    installPrePush(h.repo);
    commitFile(h.repo, 'q.txt', 'feat(L1): q');
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('sh', ['-c', 'git push'], { cwd: h.repo, env: { ...process.env, CADENCE_ORCHESTRATED: 'w1' }, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
  });
});

describe('budget et quota', () => {
  it('le budget atteint empêche toute nouvelle session ; la reprise continue à l\'étape suivante', async () => {
    const h = harness({ budget: 1000, script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('suspended');
    expect(c.lot.outcome).toBe('budget atteint');
    expect(c.lot.next).toBe('review');
    expect(kinds(h)).toEqual(['implement']);
    h.wave.budget.limit = 10_000;
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('ready');
  });

  it('quota atteint : session interrompue, aucune autre ; pas de nouvel essai', async () => {
    const quota: Handler = () => ({ code: 1, stdout: JSON.stringify({ is_error: true, subtype: 'success', result: 'Claude AI usage limit reached|1759600000', session_id: 's', num_turns: 1, duration_ms: 1, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } }), stderr: '', timedOut: false });
    const h = harness({ script: { implement: [quota] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('suspended');
    expect(h.wave.quota.hit).toBe(true);
    expect(c.lot.steps[0].status).toBe('interrupted');
    expect(c.lot.next).toBe('implement');
    await runLot(c);
    expect(h.calls).toHaveLength(1);
  });
});

describe('reprise après coupure', () => {
  it('l\'étape interrompue est relancée entière, avec les commits déjà présents dans le brief', async () => {
    const h = harness({ script: { implement: [impl('b.txt')], review: [ok] } });
    const c = h.lot('L1');
    // état laissé par une vague coupée au milieu de l'implémentation
    const head = git(h.repo, 'rev-parse', 'HEAD');
    commitFile(h.repo, 'a.txt', 'feat(L1): a (avant la coupure)');
    c.lot.next = 'implement';
    c.lot.status = 'suspended';
    c.lot.steps.push({ n: 1, kind: 'implement', model: 'sonnet', status: 'interrupted', started: 'x', headBefore: head });
    await runLot(c);
    expect(h.calls[0].brief).toContain('A previous session was interrupted');
    expect(h.calls[0].brief).toContain('feat(L1): a (avant la coupure)');
    expect(c.lot.steps.map((s) => `${s.n}:${s.status}`)).toEqual(['1:interrupted', '2:ok', '3:ok']);
    expect(c.lot.status).toBe('ready');
  });

  it('un lot terminé n\'est jamais rejoué', async () => {
    const h = harness({ script: {} });
    const c = h.lot('L1', { status: 'ready' });
    await runLot(c);
    expect(h.calls).toHaveLength(0);
  });
});

describe('plan en lecture seule', () => {
  it('démarre avec orchestrate.start, note le verdict avec orchestrate.verdict, commite seulement les fichiers du plan', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    // le « plan » du projet est tenu par son propre outil : un script écrit dans le fichier du plan
    const planRel = 'docs/plan/raf.yaml';
    const tool = join(h.repo, 'tool.sh');
    writeFileSync(tool, `#!/bin/sh\necho "# $1 $2 $3" >> ${planRel}\n`, { mode: 0o755 });
    git(h.repo, 'add', '--', 'tool.sh');
    git(h.repo, 'commit', '-q', '-m', 'chore: outil');
    const c = h.lot('L1', { readOnlyPlan: true }, { start: './tool.sh start {lot}', verdict: './tool.sh note {lot} "revue : {verdict}"' });
    const plan = c.loadPlan;
    // le plan reste lisible par raf pour ce test (mais le cycle ne l'écrit pas : readonly simulé)
    c.loadPlan = () => {
      const p = plan();
      Object.defineProperty(p, 'readonly', { get: () => true });
      return p;
    };
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    const text = readFileSync(join(h.repo, planRel), 'utf8');
    expect(text).toContain('# start L1');
    expect(text).toContain('# note L1 revue : conforme : rien à signaler — orchestré');
    expect(git(h.repo, 'log', '--format=%s').split('\n')).toContain('plan: L1 revue de code notée (orchestrate w1)');
    expect(git(h.repo, 'status', '--porcelain')).toBe('');
  });

  it('sans orchestrate.start un lot à faire est refusé', async () => {
    const h = harness({ script: {} });
    const c = h.lot('L1', { readOnlyPlan: true });
    const plan = c.loadPlan;
    c.loadPlan = () => {
      const p = plan();
      Object.defineProperty(p, 'readonly', { get: () => true });
      return p;
    };
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toBe('plan en lecture seule : démarrer le lot avec l\'outil du projet');
    expect(h.calls).toHaveLength(0);
  });

  it('une commande du projet qui touche un autre fichier que le plan arrête le lot, arbre sale', async () => {
    const h = harness({ script: {} });
    writeFileSync(join(h.repo, 'src.txt'), 'x');
    git(h.repo, 'add', '--', 'src.txt');
    git(h.repo, 'commit', '-q', '-m', 'chore: src');
    const c = h.lot('L1', { readOnlyPlan: true }, { start: 'echo y >> src.txt' });
    const plan = c.loadPlan;
    c.loadPlan = () => {
      const p = plan();
      Object.defineProperty(p, 'readonly', { get: () => true });
      return p;
    };
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/arbre sale \(fichiers hors plan\) : src\.txt/);
  });
});

describe('tokens des sessions en échec (L3/t11)', () => {
  const usage = { input_tokens: 7, cache_creation_input_tokens: 200, cache_read_input_tokens: 9000, output_tokens: 30 };
  const failedOut = (over: Record<string, unknown>, code = 0) => ({ code, stdout: JSON.stringify({ is_error: true, subtype: 'error_during_execution', result: 'boom', session_id: 's-ko', num_turns: 1, duration_ms: 1, usage, ...over }), stderr: '', timedOut: false });

  it('is_error : les tokens de la sortie vont au budget', async () => {
    const h = harness({ script: { implement: [() => failedOut({})] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(h.wave.budget.consumed).toBe(237);
    expect(h.wave.budget.cacheRead).toBe(9000);
    expect(c.lot.steps[0].tokens?.counted).toBe(237);
  });

  it('code de sortie non nul avec une sortie lisible : comptés', async () => {
    const good = claudeOut(workReport(), { input: 5, cacheWrite: 50, cacheRead: 0, output: 5 });
    const h = harness({ script: { implement: [() => ({ ...good, code: 3 })] } });
    await runLot(h.lot('L1'));
    expect(h.wave.budget.consumed).toBe(60);
  });

  it('quota atteint : comptés', async () => {
    const h = harness({ script: { implement: [() => failedOut({ subtype: 'success', result: 'Claude AI usage limit reached|1759600000' }, 1)] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('suspended');
    expect(h.wave.budget.consumed).toBe(237);
  });

  it('délai dépassé (rien sur la sortie) : relus dans le journal de SA session (--session-id), jamais celui d\'une autre conversation du dossier', async () => {
    let id = '';
    const h = harness({ script: { implement: [(call) => {
      id = call.args[call.args.indexOf('--session-id') + 1];
      const dir = projectLogDir(h.wave.claudeHome!, call.opts.cwd);
      mkdirSync(dir, { recursive: true });
      const line = (mid: string, i: number, w: number, r: number, o: number) => JSON.stringify({ type: 'assistant', message: { id: mid, usage: { input_tokens: i, cache_creation_input_tokens: w, cache_read_input_tokens: r, output_tokens: o } } });
      // le même message écrit sur deux lignes ne compte qu'une fois
      writeFileSync(join(dir, `${id}.jsonl`), [line('m1', 10, 100, 0, 5), line('m1', 10, 100, 0, 5), line('m2', 4, 20, 110, 6)].join('\n'));
      // une autre conversation du même dossier (celle du lead), plus récente et énorme
      writeFileSync(join(dir, 'autre-conversation.jsonl'), line('x1', 45_000_000, 0, 0, 0));
      return { code: 0, stdout: '', stderr: '', timedOut: true };
    }] } });
    h.wave.claudeHome = tempDir();
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.outcome).toMatch(/délai dépassé/);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.lot.steps[0].sessionId).toBe(id);
    expect(h.wave.budget.consumed).toBe(10 + 100 + 5 + 4 + 20 + 6);
    expect(h.wave.budget.cacheRead).toBe(110);
    expect(c.lot.steps[0].peakContext).toBe(134);
  });

  it('délai dépassé sans journal de la session : rien n\'est compté, aucune autre session devinée', async () => {
    const h = harness({ script: { implement: [(call) => {
      const dir = projectLogDir(h.wave.claudeHome!, call.opts.cwd);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'autre.jsonl'), JSON.stringify({ type: 'assistant', message: { id: 'x', usage: { input_tokens: 999, output_tokens: 1 } } }));
      return { code: 0, stdout: '', stderr: '', timedOut: true };
    }] } });
    h.wave.claudeHome = tempDir();
    await runLot(h.lot('L1'));
    expect(h.wave.budget.consumed).toBe(0);
  });
});

describe('lot non démarré quand la vague est arrêtée (L3/t14)', () => {
  const cases: [string, (h: ReturnType<typeof harness>) => void, string][] = [
    ['budget épuisé', (h) => { h.wave.budget.consumed = h.wave.budget.limit; }, 'budget atteint'],
    ['quota atteint', (h) => { h.wave.quota = { hit: true }; }, 'quota atteint'],
    ['incident', (h) => { h.wave.incident = 'push détecté'; }, 'vague arrêtée : push détecté'],
  ];
  for (const [name, arm, why] of cases) {
    it(`${name} : ni raf start ni commit du plan, le lot reste à faire et suspendu`, async () => {
      const h = harness({ script: {} });
      arm(h);
      const head = git(h.repo, 'rev-parse', 'HEAD');
      const c = h.lot('L1');
      await runLot(c);
      expect(c.lot.status).toBe('suspended');
      expect(c.lot.outcome).toBe(why);
      expect(h.plan().lot('L1').status).toBe('todo');
      expect(git(h.repo, 'rev-parse', 'HEAD')).toBe(head);
      expect(h.calls).toEqual([]);
    });
  }
});

describe('commande orchestrate.test asynchrone (L3/t16)', () => {
  it('la boucle d\'événements reste libre pendant la commande de tests', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'sleep 1' });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    await runLot(c);
    clearInterval(timer);
    expect(c.lot.status).toBe('ready');
    expect(ticks).toBeGreaterThanOrEqual(10); // spawnSync bloquait : un seul tour, après la commande
  });
});
