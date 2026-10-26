import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPlanConfig } from '../src/config.js';
import { commitMsgHook, commitMsgRefusal, leadAnswerMessage, planCommitMessage } from '../src/plan-commit.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { run as cadence } from '../src/cli.js';
import { gitRepo, removeDryRunBriefs, tempDir } from './helpers.js';
import { commitFile, git, harness, reviewReport, specReport, workReport, claudeOut, type Handler } from './orchestrate-harness.js';
import { fake, planOf, run, setup, store, until } from './orchestrate-worktree-harness.js';
import { ecritBack } from './spec-helpers.js';
import { ecritAcceptation } from './accept-helpers.js';
import { sealAcceptation } from '../src/orchestrate/accept.js';

// L343 — le message des commits de plan est réglable (plan.commit) et le dry-run le passe au hook commit-msg réel du dépôt (issue #15).

const yaml = (commit: string) => `plan:\n  commit: ${JSON.stringify(commit)}\n`;
const config = (text: string) => {
  const f = join(tempDir(), 'cadence.yaml');
  writeFileSync(f, text);
  return () => readPlanConfig(f);
};

/** Un hook commit-msg qui refuse tout sujet commençant par « plan: » comme le fait commitlint config-conventional (type-enum). */
function hookConventionnel(repo: string, via: 'defaut' | 'husky'): string {
  const body = '#!/bin/sh\nif head -n1 "$1" | grep -q "^plan:"; then echo "✖   type must be one of [build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test] [type-enum]" >&2; exit 1; fi\n';
  const dir = via === 'husky' ? join(repo, '.husky/_') : join(repo, '.git/hooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'commit-msg'), body);
  chmodSync(join(dir, 'commit-msg'), 0o755);
  if (via === 'husky') git(repo, 'config', 'core.hooksPath', '.husky/_');
  return join(dir, 'commit-msg');
}

const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a.txt')] }));
const ok: Handler = () => claudeOut(reviewReport());

describe('R1 — plan.commit : le gabarit est lu et validé', () => {
  it('R1 — absent, aucun gabarit ; posé, il est lu tel quel', () => {
    expect(config('plan:\n  project: x\n')()?.commit).toBeUndefined();
    expect(config(yaml('chore({lot}): {action}'))()?.commit).toBe('chore({lot}): {action}');
  });
  it('R1 — un gabarit sans {lot}, vide, sur deux lignes ou avec un mot inconnu est refusé', () => {
    expect(config(yaml('chore: {action}'))).toThrow(/plan\.commit doit contenir \{lot\}/);
    expect(config(yaml(' '))).toThrow(/plan\.commit est vide/);
    expect(config(yaml('chore({lot}):\n{action}'))).toThrow(/une ligne/);
    expect(config(yaml('chore({lot}): {actoin}'))).toThrow(/\{actoin\} inconnu/);
    expect(config('plan:\n  commit: 3\n')).toThrow(/plan\.commit doit être un gabarit/);
  });
});

describe('R2 — le message : défaut inchangé, gabarit avec lot, action, vague', () => {
  it('R2 — sans gabarit, les messages d\'avant, en vague et hors vague', () => {
    expect(planCommitMessage(undefined, { lot: 'L17', action: 'démarré', wave: 'w1' })).toBe('plan: L17 démarré (orchestrate w1)');
    expect(planCommitMessage(undefined, { lot: 'L17', action: "test d'acceptation rescellé (t.ts)" })).toBe("plan: L17 test d'acceptation rescellé (t.ts)");
  });
  it('R2 — le gabarit remplace {lot}, {action} et {vague}', () => {
    expect(planCommitMessage('chore({lot}): {action} [{vague}]', { lot: 'L17', action: 'démarré', wave: 'w1' })).toBe('chore(L17): démarré [w1]');
  });
  it('R2 — hors vague, le groupe entre parenthèses qui porte {vague} disparaît au lieu de laisser « (orchestrate ) »', () => {
    expect(planCommitMessage('chore({lot}): {action} (orchestrate {vague})', { lot: 'L17', action: 'rescellé' })).toBe('chore(L17): rescellé');
  });
  it('R2 — un $& ou $1 dans une action reste littéral', () => {
    expect(planCommitMessage('chore({lot}): {action}', { lot: 'L1', action: 'cout $& $1' })).toBe('chore(L1): cout $& $1');
  });
});

describe('R3 — le gabarit s\'applique à tous les commits de plan écrits par cadence', () => {
  it('R3 — la vague : démarrage et revue enregistrée portent le gabarit du projet', async () => {
    const h = harness({ script: { implement: [impl], review: [ok] } });
    writeFileSync(join(h.repo, 'cadence.yaml'), yaml('chore({lot}): plan {action}'));
    await runLot(h.lot('L1'));
    const sujets = git(h.repo, 'log', '--format=%s').split('\n');
    expect(sujets).toContain('chore(L1): plan démarré');
    expect(sujets).toContain('chore(L1): plan revue de code enregistrée');
    expect(sujets.filter((s) => s.startsWith('plan:'))).toEqual([]);
  });
  it('R3 — la vague sans gabarit garde le message d\'avant', async () => {
    const h = harness({ script: { implement: [impl], review: [ok] } });
    await runLot(h.lot('L1'));
    expect(git(h.repo, 'log', '--format=%s')).toContain('plan: L1 démarré (orchestrate w1)');
  });
  it('R3 — spec reseal : le commit de la note du lot porte le gabarit', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    const cli = (...argv: string[]) => cadence(argv, { cwd: repo, env: { RAF_TODAY: '2026-10-12' }, out: () => {}, err: () => {}, now: () => new Date('2026-10-12T10:00:00') });
    cli('init', '--project', 'demo');
    cli('add', 'Lot un');
    cli('start', 'L1');
    writeFileSync(join(repo, 'cadence.yaml'), yaml('chore({lot}): {action}'));
    git(repo, 'add', '--', 'cadence.yaml', a.test, a.json, '.cadence');
    git(repo, 'commit', '-q', '-m', 'test(L1): base');
    sealAcceptation(repo, a.json);
    git(repo, 'add', '--', a.json);
    git(repo, 'commit', '-q', '-m', 'test(L1): scellée');
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    expect(cli('spec', 'reseal', 'L1', a.test, '--reason', 'le test contredit la fiche')).toBe(0);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe(`chore(L1): test d'acceptation rescellé (${a.test})`);
  });
});

describe('R5 — un refus du hook ne laisse pas le plan indexé, et le message de la réponse du lead est conforme', () => {
  it('R5 — le commit de plan refusé par le hook désindexe le plan : le lot suivant ne trouve pas un dépôt sale', async () => {
    const h = harness({ script: { implement: [impl], review: [ok] } });
    hookConventionnel(h.repo, 'defaut');
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(git(h.repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });
  it('R5 — un commit de plan refusé garde ce que le lead avait modifié dans le plan sans commiter : seule l\'écriture de cadence est défaite', async () => {
    // Deux lots en worktree (le dépôt du lead reste libre) : pendant la session spec de L1, le lead note le plan sans commiter (raf note) ; le commit
    // des hypothèses de la fiche, écrit après la session, est refusé par le hook (header-max-length). Le scénario de l'issue #15.
    const { parent, repo } = setup([{ title: 'un', spec: true }, { title: 'deux' }]);
    const dir = join(repo, '.git/hooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'commit-msg'), '#!/bin/sh\nif head -n1 "$1" | grep -q "hypothèses"; then echo "✖   header must not be longer than 100 characters [header-max-length]" >&2; exit 1; fi\n');
    chmodSync(join(dir, 'commit-msg'), 0o755);
    const home = process.env.CADENCE_HOME;
    process.env.CADENCE_HOME = tempDir();
    let lead = '';
    try {
      const f: ReturnType<typeof fake> = fake({
        spec: async (cwd) => {
          await until(() => f.calls.some((k) => k.lot === 'L2')); // L2 a déjà écrit son raf start
          const plan = planOf(repo);
          plan.note('L1', 'note du lead pendant la session', '2026-10-04');
          plan.save();
          lead = readFileSync(plan.path, 'utf8');
          return claudeOut(specReport({ fiche: ecritBack(cwd) }));
        },
      });
      await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    } finally {
      process.env.CADENCE_HOME = home;
    }
    expect(store(parent).readLot('a', 'L1')!.status).toBe('failed');
    expect(lead).toContain('note du lead pendant la session');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(readFileSync(join(repo, '.cadence/raf.yaml'), 'utf8')).toBe(lead); // la note du lead est là, les notes d'hypothèses de cadence n'y sont plus
  });
  it('R5 — le sujet de la réponse du lead commence en minuscule, comme l\'exige subject-case de config-conventional', () => {
    expect(leadAnswerMessage('L1', ['R3'], 'w1')).toBe('docs(L1): règle R3 sourcée par la réponse du lead (orchestrate w1)');
    expect(leadAnswerMessage('L1', ['R3', 'R5'], 'w1')).toBe('docs(L1): règles R3, R5 sourcées par la réponse du lead (orchestrate w1)');
  });
  it('R5 — le dry-run passe aussi le message de la réponse du lead au hook et nomme le refus', async () => {
    const { parent, repo } = setup([{ title: 'un', spec: true }]);
    const dir = join(repo, '.git/hooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'commit-msg'), '#!/bin/sh\nif head -n1 "$1" | grep -q "sourcée"; then echo "✖   subject must not be sentence-case [subject-case]" >&2; exit 1; fi\n');
    chmodSync(join(dir, 'commit-msg'), 0o755);
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.out).toMatch(/✗ message de plan refusé par le hook commit-msg : « docs\(L1\): règle R3 sourcée .*subject-case/);
  });
});

describe('R4 — le dry-run passe chaque message au hook commit-msg réel du dépôt', () => {
  it('R4 — le hook est trouvé par core.hooksPath (husky) comme dans .git/hooks, et absent sans hook', () => {
    const none = gitRepo();
    expect(commitMsgHook(none)).toBeNull();
    const a = gitRepo();
    expect(commitMsgHook(a)).toBeNull();
    const path = hookConventionnel(a, 'defaut');
    expect(commitMsgHook(a)).toBe(path);
    const b = gitRepo();
    expect(commitMsgHook(b)).toBeNull();
    const husky = hookConventionnel(b, 'husky');
    expect(commitMsgHook(b)).toBe(husky);
  });
  it('R4 — un message refusé rend ce que le hook a dit, un message accepté rend null', () => {
    const repo = gitRepo();
    hookConventionnel(repo, 'husky');
    expect(commitMsgRefusal(repo, 'plan: L17 démarré (orchestrate w1)')).toContain('type-enum');
    expect(commitMsgRefusal(repo, 'chore(L17): démarré')).toBeNull();
  });
  it('R4 — le dry-run nomme le message que le hook refuserait, avec le gabarit par défaut', async () => {
    const { parent, repo } = setup([{ title: 'un' }]);
    hookConventionnel(repo, 'husky');
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/✗ message de plan refusé par le hook commit-msg : « plan: L1 démarré \(orchestrate [^)]+\) » — .*type-enum/);
    expect(r.out).toContain('plan.commit');
  });
  it('R4 — avec un gabarit accepté par le hook, le dry-run le dit et ne refuse rien', async () => {
    const { parent, repo } = setup([{ title: 'un' }]);
    hookConventionnel(repo, 'husky');
    writeFileSync(join(repo, 'cadence.yaml'), `${readFileSync(join(repo, 'cadence.yaml'), 'utf8')}${yaml('chore({lot}): {action}')}`);
    git(repo, 'commit', '-q', '-am', 'chore: gabarit');
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.err).toBe('');
    expect(r.out).not.toContain('✗ message de plan');
    expect(r.out).toMatch(/messages de plan : 3 message\(s\) acceptés par le hook commit-msg/); // un lot sans étape spec n'écrit ni hypothèses, ni mineurs de fiche, ni réponse du lead
  });
  it('R4 — sans hook, rien de plus dans le dry-run quand le gabarit est celui d\'avant', async () => {
    const { parent } = setup([{ title: 'un' }]);
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.out).not.toContain('messages de plan');
  });
});

/** Un hook commit-msg qui applique `header-max-length` (100) de config-conventional, comme commitlint. */
function hookLongueur(repo: string): void {
  const dir = join(repo, '.git/hooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'commit-msg'), '#!/bin/sh\nif [ "$(head -n1 "$1" | LC_ALL=C.UTF-8 awk \'{ print length($0) }\')" -gt 100 ]; then echo "✖   header must not be longer than 100 characters, current length is $(head -n1 "$1" | LC_ALL=C.UTF-8 awk \'{ print length($0) }\') [header-max-length]" >&2; exit 1; fi\n');
  chmodSync(join(dir, 'commit-msg'), 0o755);
}
const SUJET_LONG = 'orchestrate-budget-correction-et-reprise'; // 40 caractères : « plan: L1 hypothèses de la fiche … notées (orchestrate 2026-10-04-1412) » en fait 109
const ficheBack = (sujet: string, lot: string, hypotheses: string[]) => `sujet:\n  id: ${sujet}\n  lot: ${lot}\nregles:\n${hypotheses.map((id) => `  - id: ${id}\n    statut: hypothese\n    texte: x\n`).join('')}`;
function ecritFiche(repo: string, sujet: string, lot: string, hypotheses: string[]): void {
  mkdirSync(join(repo, 'docs/specs', sujet), { recursive: true });
  writeFileSync(join(repo, 'docs/specs', sujet, 'fiche.yaml'), ficheBack(sujet, lot, hypotheses));
  git(repo, 'add', '--', `docs/specs/${sujet}/fiche.yaml`);
  git(repo, 'commit', '-q', '-m', `docs(${lot}): fiche ${sujet}`);
}

describe('R6 — le dry-run mesure les messages de la fiche avec un sujet de longueur réelle, pas « <sujet> »', () => {
  it('R6 — la fiche du lot est écrite : son sujet et ses hypothèses font le message des hypothèses et celui de la réponse du lead', async () => {
    const { parent, repo } = setup([{ title: 'un', spec: true }]);
    hookLongueur(repo);
    ecritFiche(repo, SUJET_LONG, 'L1', ['R1', 'R2']);
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.out).toMatch(new RegExp(`✗ message de plan refusé par le hook commit-msg : « plan: L1 hypothèses de la fiche ${SUJET_LONG} notées \\(orchestrate [^)]+\\) » — .*header-max-length`));
    expect(r.out).toContain(`fiche du lot : docs/specs/${SUJET_LONG}/fiche.yaml (hypothèses R1, R2)`);
    expect(r.out).not.toContain('<sujet>');
    // la réponse du lead est mesurée avec les hypothèses de la fiche, pas avec une règle R3 inventée
    expect(r.out).not.toContain('règle R3');
  });
  it('R6 — la fiche du lot n\'est pas encore écrite : le sujet le plus long du dossier des fiches sert de mesure, et le dry-run le dit', async () => {
    const { parent, repo } = setup([{ title: 'un', spec: true }]);
    hookLongueur(repo);
    ecritFiche(repo, 'court', 'L9', ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']); // 6 règles : « docs(L1): règles R1, …, R6 sourcées par la réponse du lead (orchestrate 2026-10-04-1412) » en fait 101
    ecritFiche(repo, SUJET_LONG, 'L8', ['R1']);
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.out).toMatch(new RegExp(`✗ message de plan refusé par le hook commit-msg : « plan: L1 hypothèses de la fiche ${SUJET_LONG} notées`));
    expect(r.out).toMatch(/✗ message de plan refusé par le hook commit-msg : « docs\(L1\): règles R1, R2, R3, R4, R5, R6 sourcées par la réponse du lead/);
    expect(r.out).toContain(`fiche du lot pas encore écrite : mesure avec le sujet le plus long de docs/specs (${SUJET_LONG}) et 6 règle(s)`);
  });
  it('R6 — un lot sans étape spec ne joue pas les messages de la fiche : un sujet long dans le dossier ne le fait pas refuser', async () => {
    const { parent, repo } = setup([{ title: 'un' }]);
    hookLongueur(repo);
    ecritFiche(repo, SUJET_LONG, 'L8', ['R1']);
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.out).not.toContain('✗ message de plan');
    expect(r.out).toMatch(/messages de plan : 3 message\(s\) acceptés/);
    expect(r.out).not.toContain('fiche du lot');
  });
  it('R6 — sans aucune fiche dans le dépôt, le dry-run mesure avec « <sujet> » et prévient que la mesure est courte', async () => {
    const { parent, repo } = setup([{ title: 'un', spec: true }]);
    hookLongueur(repo);
    const r = await run(parent, ['a:L1', '--dry-run'], fake());
    removeDryRunBriefs(r.out);
    expect(r.out).not.toContain('✗ message de plan');
    expect(r.out).toContain('aucune fiche dans docs/specs : les messages de la fiche sont mesurés avec « <sujet> » (7 caractères) et 1 règle ; un sujet réel plus long peut dépasser une limite du hook');
  });
});
