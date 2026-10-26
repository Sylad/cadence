import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { cadenceHome, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { sharedStateDir } from '../src/state.js';
import { lockViolations, redSha, resealAcceptation, resealedRouge, sealAcceptation, setVert } from '../src/orchestrate/accept.js';
import { run } from '../src/cli.js';
import { parseOrchestrateArgs } from '../src/orchestrate/command.js';
import { DISALLOWED } from '../src/orchestrate/launch.js';
import { gitRepo, tempDir } from './helpers.js';
import { newLot, RunStore, type LotState, type WaveState } from '../src/orchestrate/state.js';
import { git } from './orchestrate-harness.js';
import { DIR, ecritAcceptation } from './accept-helpers.js';

// L200 : un test d'acceptation scellé qui contredit la fiche du lot en cours se corrige par un chemin tracé (cadence spec reseal), le verrou gardant tout le reste.

const commitPaths = (repo: string, message: string, ...paths: string[]) => {
  git(repo, 'add', '--', ...paths);
  git(repo, 'commit', '-q', '-m', message, '--', ...paths);
};

/** Une vague (état écrit dans `launchDir/.cadence/runs/<id>`) dont chaque lot est dans le statut donné ; `repo` : le dépôt du projet du lot. */
function vagueOuverte(launchDir: string, lots: { project: string; repo: string; lot: string; status: LotState['status'] }[], waveStatus: WaveState['status'] = 'interrupted', id = '2026-10-17-1720') {
  const store = RunStore.reserve(launchDir, id)!;
  store.writeWave({ id: store.id, status: waveStatus, created: 'x', lots: lots.map((l) => `${l.project}:${l.lot}`) } as never);
  for (const l of lots) {
    store.writeLot({ ...newLot({ project: l.project, repo: l.repo, lot: l.lot, title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false }), status: l.status });
  }
}

/** Un lot en cours (L1) dont l'acceptation est scellée et commitée, avec deux fichiers de tests. */
function lotScelle(opts: { vert?: boolean; parent?: string } = {}) {
  const repo = gitRepo(opts.parent);
  const a = ecritAcceptation(repo);
  const second = 'test/autre.acceptation.test.ts';
  writeFileSync(join(repo, second), "it('autre', () => { throw new Error('rouge'); });\n");
  const doc = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
  doc.fichiers.push(second);
  writeFileSync(join(repo, a.json), JSON.stringify(doc, null, 2));
  commitPaths(repo, 'test(L1): second fichier', second, a.json);
  sealAcceptation(repo, a.json);
  commitPaths(repo, 'test(L1): acceptation scellée', a.json);
  if (opts.vert) {
    setVert(repo, a.json);
    commitPaths(repo, 'chore(L1): acceptation verte', a.json);
  }
  return { repo, a, second };
}

describe('resealAcceptation : refaire l’empreinte d’un seul test, la fiche inchangée', () => {
  it('refait l’empreinte du test corrigé, garde celle des autres et note la raison dans acceptation.json', () => {
    const { repo, a, second } = lotScelle();
    const avant = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// regex corrigée\n`);
    const r = resealAcceptation(repo, a.json, a.test, 'regex /\\d{1,2} / contre « T3 2027 annoncée »', '2026-10-12');
    const apres = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    expect(apres.empreintes[a.test]).toBe(git(repo, 'hash-object', a.test).trim());
    expect(apres.empreintes[a.test]).not.toBe(avant.empreintes[a.test]);
    expect(apres.empreintes[second]).toBe(avant.empreintes[second]);
    expect(apres.vert).toBe(false);
    expect(apres.resceaux).toEqual([{ test: a.test, raison: 'regex /\\d{1,2} / contre « T3 2027 annoncée »', date: '2026-10-12', avant: avant.empreintes[a.test], apres: apres.empreintes[a.test] }]);
    expect(r.avant).toBe(avant.empreintes[a.test]);
  });

  it('après le commit du rescellé, le verrou est de nouveau muet ; il garde le reste (un autre test modifié reste un écart)', () => {
    const { repo, a, second } = lotScelle();
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    expect(lockViolations(repo, DIR, head).join('\n')).toContain(a.test); // avant : verrou total
    resealAcceptation(repo, a.json, a.test, 'contredit la fiche', '2026-10-12');
    commitPaths(repo, 'test(L1): acceptation rescellée', a.json, a.test);
    const rescelle = git(repo, 'rev-parse', 'HEAD').trim();
    expect(redSha(repo, a.json)).toBe(rescelle);
    expect(lockViolations(repo, DIR, rescelle)).toEqual([]);
    writeFileSync(join(repo, second), 'modifié\n');
    expect(lockViolations(repo, DIR, rescelle).join('\n')).toContain(second);
  });

  it('refuse un test qui n’est pas listé, une raison vide, un test inchangé', () => {
    const { repo, a } = lotScelle();
    writeFileSync(join(repo, a.test), 'autre\n');
    expect(() => resealAcceptation(repo, a.json, 'test/inconnu.test.ts', 'x', '2026-10-12')).toThrow(/n'est pas listé/);
    expect(() => resealAcceptation(repo, a.json, a.test, '  ', '2026-10-12')).toThrow(/--reason/);
    git(repo, 'checkout', '-q', '--', a.test);
    expect(() => resealAcceptation(repo, a.json, a.test, 'x', '2026-10-12')).toThrow(/inchangé/);
  });

  it('R3 — le test existant (L200) est mis à jour : une fiche modifiée et non commitée est refusée, « modifications non commitées » au lieu de « a changé »', () => {
    const { repo, a } = lotScelle();
    writeFileSync(join(repo, a.test), 'autre\n');
    writeFileSync(join(repo, a.fiche), `${readFileSync(join(repo, a.fiche), 'utf8')}# modifiée\n`);
    expect(() => resealAcceptation(repo, a.json, a.test, 'x', '2026-10-12')).toThrow(/fiche .* a des modifications non commitées/);
  });

  it('refuse si un autre test listé a été touché : le rescellé ne couvre que le test nommé', () => {
    const { repo, a, second } = lotScelle();
    writeFileSync(join(repo, a.test), 'autre\n');
    writeFileSync(join(repo, second), 'touché\n');
    expect(() => resealAcceptation(repo, a.json, a.test, 'x', '2026-10-12')).toThrow(new RegExp(second.replace(/\./g, '\\.')));
  });

  it('à la reprise, l’ancre du commit rouge suit un rescellé commité, mais pas une réécriture ordinaire', () => {
    const { repo, a } = lotScelle();
    const ancre = redSha(repo, a.json)!;
    expect(resealedRouge(repo, a.json, ancre)).toBeNull(); // rien n'a bougé
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    resealAcceptation(repo, a.json, a.test, 'contredit la fiche', '2026-10-12');
    commitPaths(repo, 'test(L1): acceptation rescellée', a.json, a.test);
    const rescelle = git(repo, 'rev-parse', 'HEAD').trim();
    expect(lockViolations(repo, DIR, rescelle, { rouge: { [a.json]: ancre } }).join('\n')).toContain('réécrit depuis son commit rouge'); // l'ancre périmée
    expect(resealedRouge(repo, a.json, ancre)).toBe(rescelle);
    expect(lockViolations(repo, DIR, rescelle, { rouge: { [a.json]: rescelle } })).toEqual([]);
  });

  it('un rescellé fait par une session de la vague n’est pas adopté, celui du lead (hors de toute session) l’est', () => {
    const { repo, a } = lotScelle();
    const ancre = redSha(repo, a.json)!;
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    resealAcceptation(repo, a.json, a.test, 'contredit la fiche', '2026-10-12');
    commitPaths(repo, 'test(L1): acceptation rescellée', a.json, a.test);
    const rescelle = git(repo, 'rev-parse', 'HEAD').trim();
    expect(resealedRouge(repo, a.json, ancre, (sha) => sha === rescelle)).toBeNull();
    expect(resealedRouge(repo, a.json, ancre, () => false)).toBe(rescelle);
  });

  it('une réécriture d’acceptation.json sans journal de rescellé n’est pas adoptée comme nouvelle ancre', () => {
    const { repo, a } = lotScelle();
    const ancre = redSha(repo, a.json)!;
    const doc = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    doc.empreintes[a.test] = 'forgé';
    writeFileSync(join(repo, a.json), JSON.stringify(doc, null, 2));
    commitPaths(repo, 'réécriture par une session', a.json);
    expect(resealedRouge(repo, a.json, ancre)).toBeNull();
  });

  it('refuse une acceptation non scellée', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    writeFileSync(join(repo, a.test), 'autre\n');
    expect(() => resealAcceptation(repo, a.json, a.test, 'x', '2026-10-12')).toThrow(/scellée/);
  });
});

describe('cadence spec reseal <lot> <test> --reason', () => {
  function cli(repo: string, env: Record<string, string>, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-10-12', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-12T10:00:00') });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  function avecPlan(statut = 'doing', parent?: string) {
    const s = lotScelle({ parent });
    cli(s.repo, {}, 'init', '--project', 'demo');
    cli(s.repo, {}, 'add', 'Lot un');
    if (statut === 'doing') cli(s.repo, {}, 'start', 'L1');
    commitPaths(s.repo, 'plan: L1', '.cadence/raf.yaml', '.cadence/notes/.gitkeep', '.gitignore');
    return s;
  }

  it('commite le test et l’acceptation (rescellés), note la raison au lot, et laisse un dépôt propre', () => {
    const { repo, a } = avecPlan();
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'le test contredit la fiche');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(git(repo, 'log', '-2', '--format=%s').split('\n')[1]).toMatch(/^test\(L1\): acceptation rescellée/);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
    expect(readFileSync(join(repo, '.cadence/raf.yaml'), 'utf8')).toContain('le test contredit la fiche');
    expect(lockViolations(repo, DIR, git(repo, 'rev-parse', 'HEAD').trim())).toEqual([]);
  });

  it('L346 — avec plan.onWrite, le fichier produit part dans le commit de la note du lot', () => {
    const { repo, a } = avecPlan();
    writeFileSync(join(repo, 'cadence.yaml'), "plan:\n  onWrite: { command: 'wc -l < .cadence/raf.yaml > plan.json', files: [plan.json] }\n");
    commitPaths(repo, 'chore: onWrite', 'cadence.yaml');
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'le test contredit la fiche');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort()).toEqual(['.cadence/raf.yaml', 'plan.json']);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
  });

  it('L346 — plan.onWrite en échec : le rescellé commité est dit, la note n’est pas écrite, le plan reste inchangé', () => {
    const { repo, a } = avecPlan();
    writeFileSync(join(repo, 'cadence.yaml'), "plan:\n  onWrite: { command: 'exit 9', files: [plan.json] }\n");
    commitPaths(repo, 'chore: onWrite', 'cadence.yaml');
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'le test contredit la fiche');
    const sha = git(repo, 'rev-parse', '--short', 'HEAD').trim();
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toMatch(/^test\(L1\): acceptation rescellée/);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`le rescellé a eu lieu (commit ${sha})`);
    expect(r.err).toContain('plan.onWrite');
    expect(r.err).toContain('la note du lot n’a pas été écrite');
    expect(readFileSync(join(repo, '.cadence/raf.yaml'), 'utf8')).not.toContain('rescellé');
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
  });

  it('un plan tenu par un autre outil (lecture seule) : le rescellé réussit, la note du lot reste à la main du lead', () => {
    const { repo, a } = avecPlan();
    writeFileSync(join(repo, 'cadence.yaml'), 'plan:\n  path: .cadence/raf.yaml\n  lots: lots\n');
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'le test contredit la fiche');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/rescellé/);
    expect(r.out).toMatch(/note à ajouter/);
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toMatch(/^test\(L1\): acceptation rescellée/);
    expect(lockViolations(repo, DIR, git(repo, 'rev-parse', 'HEAD').trim())).toEqual([]);
  });

  it('exige --reason, un lot en cours, et refuse pendant une vague orchestrée', () => {
    const { repo, a } = avecPlan();
    writeFileSync(join(repo, a.test), 'autre\n');
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test).code).not.toBe(0);
    expect(cli(repo, { CADENCE_ORCHESTRATED: 'w1' }, 'spec', 'reseal', 'L1', a.test, '--reason', 'x').err).toMatch(/vague orchestrée/);
    const todo = avecPlan('todo');
    writeFileSync(join(todo.repo, todo.a.test), 'autre\n');
    expect(cli(todo.repo, {}, 'spec', 'reseal', 'L1', todo.a.test, '--reason', 'x').err).toMatch(/pas en cours/);
  });

  it('refuse tant qu’une vague tient le verrou du dépôt (le lot suivant de la file travaille sur la même branche)', () => {
    const { repo, a } = avecPlan();
    writeFileSync(join(repo, a.test), 'autre\n');
    writeFileSync(join(sharedStateDir(repo), REPO_LOCK), JSON.stringify({ pid: process.pid, wave: 'w9', started: 'x' }));
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x');
    expect(r.code).toBe(2);
    expect(r.err).toContain('vague w9 (vivante, pid ');
    expect(r.err).toContain('à attendre');
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('plan: L1');
  });

  // L238 : ol-companion L172 — reseal accepté pendant une vague suspendue (question en attente), puis --resume --answer rendait le lot avec le rescellé pour « premier commit fautif ».
  // Règle : refus dès qu'une vague non terminée garde ouvert un lot DE CE DÉPÔT encore en cours au plan (le lot rescellé ou un autre) ; un lot livré au plan ou absent ne bloque jamais.
  describe('vague non terminée qui garde un lot du dépôt ouvert (L238)', () => {
    const WAVE = '2026-10-17-1720';
    /** Un second lot en cours au plan du dépôt (L2), commité. */
    function avecPlanDeuxLots(parent?: string, deuxieme: 'doing' | 'done' = 'doing') {
      const s = lotScelle({ parent });
      cli(s.repo, {}, 'init', '--project', 'demo');
      cli(s.repo, {}, 'add', 'Lot un');
      cli(s.repo, {}, 'add', 'Lot deux');
      cli(s.repo, {}, 'start', 'L1');
      cli(s.repo, {}, 'start', 'L2');
      if (deuxieme === 'done') cli(s.repo, {}, 'done', 'L2', '--force');
      commitPaths(s.repo, 'plan: L1 L2', '.cadence/raf.yaml', '.gitignore');
      writeFileSync(join(s.repo, s.a.test), `${readFileSync(join(s.repo, s.a.test), 'utf8')}// corrigé\n`);
      return s;
    }
    const corrige = (repo: string, test: string) => writeFileSync(join(repo, test), `${readFileSync(join(repo, test), 'utf8')}// corrigé\n`);
    const reseal = (repo: string, test: string) => cli(repo, {}, 'spec', 'reseal', 'L1', test, '--reason', 'x');
    const sujet = (repo: string) => git(repo, 'log', '-1', '--format=%s').trim();

    it('refuse un lot de ce dépôt en question dans une vague arrêtée, cite la vague, son dossier de lancement et la commande exacte, et ne commite rien', () => {
      const { repo, a } = avecPlan();
      corrige(repo, a.test);
      vagueOuverte(repo, [{ project: 'ici', repo, lot: 'L1', status: 'question' }]);
      const r = reseal(repo, a.test);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`vague ${WAVE} (arrêtée, lancée depuis ${repo}) : ici:L1 (question)`);
      expect(r.err).toContain(`cd ${repo} && cadence orchestrate --resume --wave ${WAVE} --drop ici:L1`);
      expect(sujet(repo)).toBe('plan: L1');
    });

    it('refuse aussi pour un AUTRE lot du dépôt encore en cours au plan : le verrou rend tous les lots ouverts, pas seulement celui du rescellé', () => {
      const { repo, a } = avecPlanDeuxLots();
      vagueOuverte(repo, [{ project: 'ici', repo, lot: 'L2', status: 'question' }]);
      const r = reseal(repo, a.test);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`cd ${repo} && cadence orchestrate --resume --wave ${WAVE} --drop ici:L2`);
      expect(sujet(repo)).toBe('plan: L1 L2');
    });

    it('L309 — la commande à lancer désigne la vague par --wave : un id qui ressemble à un lot (suite2) n\'est pas lu comme un lot à lancer', () => {
      const { repo, a } = avecPlan();
      corrige(repo, a.test);
      vagueOuverte(repo, [{ project: 'ici', repo, lot: 'L1', status: 'question' }], 'interrupted', 'suite2');
      const r = reseal(repo, a.test);
      const printed = /&& (cadence orchestrate [^\n]*)/.exec(r.err)![1];
      expect(printed).toBe('cadence orchestrate --resume --wave suite2 --drop ici:L1');
      expect(parseOrchestrateArgs(printed.replace('cadence orchestrate ', '').split(' '))).toMatchObject({ resume: 'suite2', lots: [], drop: [{ project: 'ici', lot: 'L1' }] });
    });

    it('cite TOUTES les vagues en cause avec UNE commande par vague (un --drop par lot), depuis le dossier de lancement de chacune', () => {
      const parent = tempDir();
      const { repo, a } = avecPlanDeuxLots(parent);
      vagueOuverte(parent, [{ project: 'ici', repo, lot: 'L1', status: 'question' }, { project: 'ici', repo, lot: 'L2', status: 'suspended' }], 'interrupted', '2026-10-17-1000');
      vagueOuverte(repo, [{ project: 'ici', repo, lot: 'L2', status: 'queued' }], 'interrupted', '2026-10-17-1100');
      const r = reseal(repo, a.test);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`cd ${parent} && cadence orchestrate --resume --wave 2026-10-17-1000 --drop ici:L1 --drop ici:L2`);
      expect(r.err).toContain(`cd ${repo} && cadence orchestrate --resume --wave 2026-10-17-1100 --drop ici:L2`);
      expect(r.err.match(/cadence orchestrate --resume --wave 2026-10-17-1000/g)).toHaveLength(1);
      expect(sujet(repo)).toBe('plan: L1 L2');
    });

    it('un lot en file (todo au plan) du même dépôt dans la vague arrêtée est retiré aussi dans la commande : sinon le --resume le relancerait et il reprendrait le verrou', () => {
      const parent = tempDir();
      const { repo, a } = avecPlan('doing', parent);
      cli(repo, {}, 'add', 'Lot deux');
      commitPaths(repo, 'plan: L2', '.cadence/raf.yaml', '.gitignore');
      corrige(repo, a.test);
      vagueOuverte(parent, [{ project: 'ici', repo, lot: 'L1', status: 'question' }, { project: 'ici', repo, lot: 'L2', status: 'queued' }]);
      const r = reseal(repo, a.test);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`cd ${parent} && cadence orchestrate --resume --wave ${WAVE} --drop ici:L1 --drop ici:L2`);
      expect(r.err).toContain('ici:L2 (queued, pas en cours au plan)');
      expect(sujet(repo)).toBe('plan: L2');
    });

    it('la commande est exécutable telle quelle : chemin à espaces entre apostrophes', () => {
      const parent = join(tempDir(), 'mes projets');
      mkdirSync(parent);
      const { repo, a } = avecPlan('doing', parent);
      corrige(repo, a.test);
      vagueOuverte(parent, [{ project: 'ici', repo, lot: 'L1', status: 'question' }]);
      expect(reseal(repo, a.test).err).toContain(`cd '${parent}' && cadence orchestrate --resume --wave ${WAVE} --drop ici:L1`);
    });

    it('trouve une vague lancée depuis un dossier au-dessus du dépôt (le cas réel : le dossier parent des projets), le dossier de lancement figure dans le message', () => {
      const parent = tempDir();
      const { repo, a } = avecPlan('doing', parent);
      corrige(repo, a.test);
      vagueOuverte(parent, [{ project: 'ici', repo, lot: 'L1', status: 'question' }]);
      const r = reseal(repo, a.test);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`cd ${parent} && cadence orchestrate --resume --wave ${WAVE} --drop ici:L1`);
      expect(sujet(repo)).toBe('plan: L1');
    });

    it('accepte quand le lot ouvert de la vague arrêtée est d’un autre dépôt, même s’il porte le même id (les ids sont propres à chaque plan)', () => {
      const { repo, a } = avecPlan();
      corrige(repo, a.test);
      vagueOuverte(repo, [{ project: 'ailleurs', repo: gitRepo(), lot: 'L1', status: 'question' }]);
      const r = reseal(repo, a.test);
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
    });

    it('accepte quand les lots du dépôt sont finis dans la vague arrêtée (prêts), l’état non terminal d’un autre dépôt ne comptant pas', () => {
      const { repo, a } = avecPlan();
      corrige(repo, a.test);
      vagueOuverte(repo, [{ project: 'ici', repo, lot: 'L1', status: 'ready' }, { project: 'ailleurs', repo: gitRepo(), lot: 'L2', status: 'question' }]);
      const r = reseal(repo, a.test);
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
    });

    it('accepte une vieille vague interrompue dont les lots ouverts sont livrés (done) ou absents du plan du dépôt : seuls les lots encore en cours au plan comptent', () => {
      const { repo, a } = avecPlanDeuxLots(undefined, 'done');
      vagueOuverte(repo, [
        { project: 'ici', repo, lot: 'L2', status: 'suspended' }, // done au plan
        { project: 'ici', repo, lot: 'L43', status: 'question' }, // absent du plan
      ]);
      const r = reseal(repo, a.test);
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
    });

    it('accepte quand la vague est terminée (done), même si un lot y est resté en question', () => {
      const { repo, a } = avecPlan();
      corrige(repo, a.test);
      vagueOuverte(repo, [{ project: 'ici', repo, lot: 'L1', status: 'question' }], 'done');
      const r = reseal(repo, a.test);
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
    });

    /** Une vague vivante comme l'orchestrateur la produit : inscrite au registre ET tenant le verrou du dépôt tant qu'un de ses lots n'est pas fini (command.ts : takeLock au départ, libéré quand tous sont finis). */
    function vivante(launchDir: string, repo: string, id: string, lots: { lot: string; status: LotState['status'] }[]) {
      vagueOuverte(launchDir, lots.map((l) => ({ project: 'ici', repo, ...l })), 'running' as never, id);
      writeFileSync(join(sharedStateDir(repo), REPO_LOCK), JSON.stringify({ pid: process.pid, wave: id, started: 'x' }));
      registerWave(cadenceHome(), { pid: process.pid, wave: id, started: '2026-10-17T17:20:00Z', cwd: launchDir, repos: [repo] });
    }
    const finVivante = (repo: string) => {
      unregisterWave(cadenceHome(), process.pid);
      rmSync(join(sharedStateDir(repo), REPO_LOCK), { force: true });
    };

    it('une vague VIVANTE qui tient le verrou avec un lot en question : refus, la vague est dite à attendre (ni suspendue, ni --resume)', () => {
      const { repo, a } = avecPlan();
      corrige(repo, a.test);
      vivante(repo, repo, WAVE, [{ lot: 'L1', status: 'question' }]);
      try {
        const r = reseal(repo, a.test);
        expect(r.code).toBe(2);
        expect(r.err).toContain(`vague ${WAVE} (vivante, pid ${process.pid}, lancée depuis ${repo}) : ici:L1 (question)`);
        expect(r.err).toContain(`vague ${WAVE} : orchestration en cours, à attendre`);
        expect(r.err).not.toMatch(/suspendue|\(arrêtée|--resume|cd /);
        expect(sujet(repo)).toBe('plan: L1');
      } finally {
        finVivante(repo);
      }
    });

    it('vague vivante qui tient le verrou ET vague arrêtée du dépôt : UN seul message, la vivante à attendre, l’arrêtée avec son dossier et sa commande', () => {
      const parent = tempDir();
      const { repo, a } = avecPlanDeuxLots(parent);
      vagueOuverte(parent, [{ project: 'ici', repo, lot: 'L1', status: 'question' }], 'interrupted', '2026-10-17-1000');
      vivante(parent, repo, '2026-10-17-1100', [{ lot: 'L2', status: 'question' }]);
      try {
        const r = reseal(repo, a.test);
        expect(r.code).toBe(2);
        expect(r.err).toContain('2 vagues non terminées gardent');
        expect(r.err).toContain(`vague 2026-10-17-1100 (vivante, pid ${process.pid}, lancée depuis ${parent}) : ici:L2 (question)`);
        expect(r.err).toContain('vague 2026-10-17-1100 : orchestration en cours, à attendre');
        expect(r.err).toContain(`vague 2026-10-17-1000 (arrêtée, lancée depuis ${parent}) : ici:L1 (question)`);
        expect(r.err).toContain(`cd ${parent} && cadence orchestrate --resume --wave 2026-10-17-1000 --drop ici:L1`);
        expect(r.err).not.toContain('--resume --wave 2026-10-17-1100');
        expect(sujet(repo)).toBe('plan: L1 L2');
      } finally {
        finVivante(repo);
      }
    });

    it('la vague qui tient le verrou est nommée même quand ses lots ne sont pas en cours au plan', () => {
      const { repo, a } = avecPlanDeuxLots(undefined, 'done');
      vivante(repo, repo, WAVE, [{ lot: 'L2', status: 'implementing' }]); // L2 est livré au plan : seul le verrou motive le refus
      try {
        const r = reseal(repo, a.test);
        expect(r.code).toBe(2);
        expect(r.err).toContain(`vague ${WAVE} (vivante, pid ${process.pid}, lancée depuis ${repo}) : ici:L2 (ouvert)`);
        expect(r.err).toContain(`vague ${WAVE} : orchestration en cours, à attendre`);
      } finally {
        finVivante(repo);
      }
    });

    it('reconnaît le même dépôt sous un autre chemin (worktree, lien symbolique) : sans la comparaison des .git communs, le refus tombait', () => {
      const { repo, a } = avecPlan();
      corrige(repo, a.test);
      const worktree = join(tempDir(), 'wt');
      git(repo, 'worktree', 'add', '-q', '-b', 'wt', worktree);
      const lien = join(tempDir(), 'lien');
      symlinkSync(repo, lien);
      for (const [nom, autre] of [['worktree', worktree], ['lien symbolique', lien]] as const) {
        vagueOuverte(repo, [{ project: 'ici', repo: autre, lot: 'L1', status: 'question' }], 'interrupted', `2026-10-17-${nom === 'worktree' ? '1000' : '1100'}`);
      }
      const r = reseal(repo, a.test);
      expect(r.code).toBe(2);
      expect(r.err).toContain('2 vagues non terminées gardent');
      expect(r.err).toContain('--resume --wave 2026-10-17-1000 --drop ici:L1');
      expect(r.err).toContain('--resume --wave 2026-10-17-1100 --drop ici:L1');
    });
  });

  it('le commit de la note du plan refusé (commit-msg) : erreur lisible qui dit que le rescellé a eu lieu et que la note reste à commiter', () => {
    const { repo, a } = avecPlan();
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    const hook = join(repo, '.git', 'hooks', 'commit-msg');
    writeFileSync(hook, '#!/bin/sh\ncase "$(head -1 "$1")" in plan:*) echo "plan refusé" >&2; exit 1;; esac\n');
    chmodSync(hook, 0o755);
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'le test contredit la fiche');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/rescellé a eu lieu.*commit [0-9a-f]+.*note.*à commiter.*plan refusé/);
    expect(r.err).not.toMatch(/\n\s+at /);
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toMatch(/^test\(L1\): acceptation rescellée/);
    expect(readFileSync(join(repo, '.cadence/raf.yaml'), 'utf8')).toContain('le test contredit la fiche');
  });
});

describe('cadence spec reseal d’un lot livré (L212)', () => {
  function cli(repo: string, env: Record<string, string>, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-10-13', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-13T10:00:00') });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  /** L1 livré (acceptation verte, lot clos), L2 en cours : le lot porteur du rescellé. */
  function livre() {
    const s = lotScelle({ vert: true });
    cli(s.repo, {}, 'init', '--project', 'demo');
    cli(s.repo, {}, 'add', 'Lot un');
    cli(s.repo, {}, 'add', 'Lot deux');
    cli(s.repo, {}, 'start', 'L1');
    cli(s.repo, {}, 'done', 'L1', '--force');
    cli(s.repo, {}, 'start', 'L2');
    commitPaths(s.repo, 'plan: L1 L2', '.cadence/raf.yaml', '.cadence/notes/.gitkeep', '.gitignore');
    writeFileSync(join(s.repo, s.a.test), `${readFileSync(join(s.repo, s.a.test), 'utf8')}// test instable corrigé\n`);
    return s;
  }

  it('rescelle le test d’un lot livré : le commit cite le lot porteur, le journal porte la date, la raison et le porteur, vert reste vrai', () => {
    const { repo, a } = livre();
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'onglet lu à « blank » en CI', '--porteur', 'L2');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(git(repo, 'log', '-2', '--format=%s').split('\n')[1]).toBe(`test(L2): acceptation rescellée du lot livré L1, ${a.test} : onglet lu à « blank » en CI`);
    const doc = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    expect(doc.vert).toBe(true);
    expect(doc.resceaux).toHaveLength(1);
    expect(doc.resceaux[0]).toMatchObject({ test: a.test, raison: 'onglet lu à « blank » en CI', date: '2026-10-13', porteur: 'L2' });
    expect(readFileSync(join(repo, '.cadence/raf.yaml'), 'utf8')).toContain('onglet lu à « blank » en CI');
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
    expect(lockViolations(repo, DIR, git(repo, 'rev-parse', 'HEAD').trim())).toEqual([]);
  });

  // L238 : le chemin --porteur, la configuration réelle de l'incident (L172 porteur d'un rescellé de L160 livré).
  describe('avec une vague non terminée du dépôt (L238)', () => {
    const vague = (repo: string, lots: { lot: string; status: LotState['status'] }[]) => vagueOuverte(repo, lots.map((l) => ({ project: 'ici', repo, ...l })));
    /** L1 livré, L2 porteur et L3 en cours au plan. */
    function livreTroisLots() {
      const s = livre();
      cli(s.repo, {}, 'add', 'Lot trois');
      cli(s.repo, {}, 'start', 'L3');
      commitPaths(s.repo, 'plan: L3', '.cadence/raf.yaml');
      return s;
    }
    const reseal = (repo: string, test: string) => cli(repo, {}, 'spec', 'reseal', 'L1', test, '--reason', 'x', '--porteur', 'L2');

    it('refuse un lot livré dont un AUTRE lot du dépôt (ni le livré ni le porteur) reste ouvert dans une vague arrêtée', () => {
      const { repo, a } = livreTroisLots();
      vague(repo, [{ lot: 'L3', status: 'question' }]);
      const r = reseal(repo, a.test);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`cd ${repo} && cadence orchestrate --resume --wave 2026-10-17-1720 --drop ici:L3`);
      expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('plan: L3');
    });

    it('refuse aussi quand c’est le lot porteur qui reste ouvert dans la vague arrêtée', () => {
      const { repo, a } = livre();
      vague(repo, [{ lot: 'L2', status: 'suspended' }]);
      const r = reseal(repo, a.test);
      expect(r.code).toBe(2);
      expect(r.err).toContain('--drop ici:L2');
      expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('plan: L1 L2');
    });

    it('accepte quand la vague arrêtée ne garde ouvert que le lot livré (done au plan, ancienne vague abandonnée)', () => {
      const { repo, a } = livre();
      vague(repo, [{ lot: 'L1', status: 'question' }]);
      const r = reseal(repo, a.test);
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(git(repo, 'log', '-2', '--format=%s').split('\n')[1]).toMatch(/^test\(L2\): acceptation rescellée du lot livré L1/);
    });
  });

  it('exige le lot porteur, en cours et distinct du lot livré', () => {
    const { repo, a } = livre();
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x').err).toMatch(/--porteur/);
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x', '--porteur', 'L1').err).toMatch(/porteur/);
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x', '--porteur', 'L9').err).toMatch(/L9/);
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('plan: L1 L2');
  });

  it('refuse un porteur existant mais pas en cours (lot clos)', () => {
    const { repo, a } = livre();
    cli(repo, {}, 'add', 'Lot trois');
    cli(repo, {}, 'start', 'L3');
    cli(repo, {}, 'done', 'L3', '--force');
    commitPaths(repo, 'plan: L3', '.cadence/raf.yaml');
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x', '--porteur', 'L3');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/L3 n'est pas en cours/);
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('plan: L3');
  });

  it('--porteur n’a de sens que pour un lot livré : refusé sur un lot en cours', () => {
    const { repo, a } = avecPlanEnCours();
    writeFileSync(join(repo, a.test), 'autre\n');
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x', '--porteur', 'L2').err).toMatch(/lot livré/);
  });

  it('un lot clos sans acceptation verte reste refusé, --porteur ou non', () => {
    const s = lotScelle();
    cli(s.repo, {}, 'init', '--project', 'demo');
    cli(s.repo, {}, 'add', 'Lot un');
    cli(s.repo, {}, 'add', 'Lot deux');
    cli(s.repo, {}, 'start', 'L1');
    cli(s.repo, {}, 'done', 'L1', '--force');
    cli(s.repo, {}, 'start', 'L2');
    commitPaths(s.repo, 'plan: L1 L2', '.cadence/raf.yaml', '.gitignore');
    writeFileSync(join(s.repo, s.a.test), 'autre\n');
    const r = cli(s.repo, {}, 'spec', 'reseal', 'L1', s.a.test, '--reason', 'x', '--porteur', 'L2');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/L1 n'est pas en cours/);
    expect(git(s.repo, 'log', '-1', '--format=%s').trim()).toBe('plan: L1 L2');
  });

  it('les messages de sortie nomment le lot porteur pour la note, pas le lot livré (plan en lecture seule, puis cas nominal)', () => {
    const ro = livre();
    writeFileSync(join(ro.repo, 'cadence.yaml'), 'plan:\n  path: .cadence/raf.yaml\n  lots: lots\n');
    const r1 = cli(ro.repo, {}, 'spec', 'reseal', 'L1', ro.a.test, '--reason', 'x', '--porteur', 'L2');
    expect(r1.err).toBe('');
    expect(r1.out).toMatch(/note à ajouter au lot L2 /);
    const nom = livre();
    const r2 = cli(nom.repo, {}, 'spec', 'reseal', 'L1', nom.a.test, '--reason', 'x', '--porteur', 'L2');
    expect(r2.out).toMatch(/en note du lot L2/);
  });

  it('refuse pendant une vague orchestrée, comme pour un lot en cours', () => {
    const { repo, a } = livre();
    expect(cli(repo, { CADENCE_ORCHESTRATED: 'w1' }, 'spec', 'reseal', 'L1', a.test, '--reason', 'x', '--porteur', 'L2').err).toMatch(/vague orchestrée/);
  });

  function avecPlanEnCours() {
    const s = lotScelle();
    cli(s.repo, {}, 'init', '--project', 'demo');
    cli(s.repo, {}, 'add', 'Lot un');
    cli(s.repo, {}, 'add', 'Lot deux');
    cli(s.repo, {}, 'start', 'L1');
    cli(s.repo, {}, 'start', 'L2');
    commitPaths(s.repo, 'plan: L1 L2', '.cadence/raf.yaml', '.gitignore');
    return s;
  }
});

describe('rescellé atomique et interdit aux sessions', () => {
  it('un commit refusé (hook pre-commit) restaure acceptation.json et le test, sans index à moitié prêt, et lève une erreur lisible', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    sealAcceptation(repo, a.json);
    commitPaths(repo, 'test(L1): acceptation scellée', a.json);
    const cli = (...argv: string[]) => {
      const err: string[] = [];
      const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-10-12' }, out: () => {}, err: (l) => err.push(l), now: () => new Date('2026-10-12T10:00:00') });
      return { code, err: err.join('\n') };
    };
    cli('init', '--project', 'demo');
    cli('add', 'Lot un');
    cli('start', 'L1');
    commitPaths(repo, 'plan: L1', '.cadence/raf.yaml', '.gitignore');
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    const jsonAvant = readFileSync(join(repo, a.json), 'utf8');
    const testAvant = readFileSync(join(repo, a.test), 'utf8');
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "refusé par le hook" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const r = cli('spec', 'reseal', 'L1', a.test, '--reason', 'le test contredit la fiche');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/commit du rescellé a échoué.*rien n'est rescellé.*refusé par le hook/);
    expect(readFileSync(join(repo, a.json), 'utf8')).toBe(jsonAvant);
    expect(readFileSync(join(repo, a.test), 'utf8')).toBe(testAvant);
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('');
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('plan: L1');
  });

  it('cadence spec reseal est interdit aux sessions, comme raf done/review/ux', () => {
    expect(DISALLOWED).toContain('Bash(cadence spec reseal:*)');
  });

  it('raf spec reseal (même dispatch, bin/raf.js) est interdit aux sessions aussi', () => {
    expect(DISALLOWED).toContain('Bash(raf spec reseal:*)');
  });
});

describe('aide de cadence', () => {
  it('liste cadence spec reseal, le seul chemin de correction d’un test scellé faux', () => {
    expect(readFileSync(join(__dirname, '..', 'bin', 'cadence.js'), 'utf8')).toContain('cadence spec reseal <lot> <test> --reason');
  });
});

// L217 : une fiche amendée par des commits du lot (commitée, citant le lot) ne bloque plus le rescellé.
const refsL = (t: string) => [...t.matchAll(/\bL\d+(?:\/\w+)?/g)].map((m) => { const [lot, task] = m[0].split('/'); return task ? { lot: lot!, task } : { lot: lot! }; });

describe('cadence spec reseal avec une fiche amendée dans le lot (L217)', () => {
  function cli(repo: string, env: Record<string, string>, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-10-15', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-15T10:00:00') });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  /** L1 en cours, acceptation scellée ; `livre` : L1 livré (vert) et L2 en cours. */
  function lot(livre = false) {
    const s = lotScelle({ vert: livre });
    cli(s.repo, {}, 'init', '--project', 'demo');
    cli(s.repo, {}, 'add', 'Lot un');
    cli(s.repo, {}, 'add', 'Lot deux');
    cli(s.repo, {}, 'start', 'L1');
    if (livre) {
      cli(s.repo, {}, 'done', 'L1', '--force');
      cli(s.repo, {}, 'start', 'L2');
    }
    commitPaths(s.repo, 'plan: lots', '.cadence/raf.yaml', '.cadence/notes/.gitkeep', '.gitignore');
    return s;
  }
  const amende = (repo: string, fiche: string, message: string, ajout = '# amendée\n') => {
    writeFileSync(join(repo, fiche), `${readFileSync(join(repo, fiche), 'utf8')}${ajout}`);
    commitPaths(repo, message, fiche);
    return git(repo, 'rev-parse', '--short', 'HEAD').trim();
  };
  const corrige = (repo: string, test: string) => writeFileSync(join(repo, test), `${readFileSync(join(repo, test), 'utf8')}// corrigé ${Math.random()}\n`);
  const journal = (repo: string, json: string) => JSON.parse(readFileSync(join(repo, json), 'utf8')).resceaux as Record<string, string>[];

  it('R1 — fiche amendée par un commit du lot : rescellé accepté, ficheAmendee = sha du commit de la fiche', () => {
    const { repo, a } = lot();
    amende(repo, a.fiche, 'feat(L1): fiche, règle précisée');
    const sha = amende(repo, a.fiche, 'feat(L1): fiche, deuxième précision', '# encore\n');
    corrige(repo, a.test);
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'le test suit la fiche');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(journal(repo, a.json)[0]!.ficheAmendee).toBe(sha);
    expect(r.out).toContain(`fiche amendée en ${sha}`);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
    expect(lockViolations(repo, DIR, git(repo, 'rev-parse', 'HEAD').trim())).toEqual([]);
  });

  it('R1 — l’entrée de resceaux garde avant/apres du test et le journal précédent', () => {
    const { repo, a } = lot();
    corrige(repo, a.test);
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'premier').code).toBe(0);
    const premier = journal(repo, a.json)[0]!;
    const sha = amende(repo, a.fiche, 'feat(L1): fiche amendée');
    corrige(repo, a.test);
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'second').code).toBe(0);
    const j = journal(repo, a.json);
    expect(j).toHaveLength(2);
    expect(j[0]).toEqual(premier);
    expect(j[1]).toMatchObject({ test: a.test, raison: 'second', avant: premier.apres, apres: git(repo, 'hash-object', a.test).trim(), ficheAmendee: sha });
  });

  it('R2 — commit de la fiche citant un autre lot : refus, message avec le sha fautif, fichiers intacts', () => {
    const { repo, a } = lot();
    amende(repo, a.fiche, 'feat(L1): fiche');
    const faute = amende(repo, a.fiche, 'docs(L2): fiche autre lot', '# autre\n');
    corrige(repo, a.test);
    const jsonAvant = readFileSync(join(repo, a.json), 'utf8');
    const testAvant = readFileSync(join(repo, a.test), 'utf8');
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(new RegExp(`la fiche .* a été modifiée depuis le commit rouge [0-9a-f]{7} par un commit qui ne cite pas L1 : ${faute}`));
    expect(readFileSync(join(repo, a.json), 'utf8')).toBe(jsonAvant);
    expect(readFileSync(join(repo, a.test), 'utf8')).toBe(testAvant);
  });

  it('R2 — lot livré : commit de la fiche citant le lot lui-même (sans le porteur) : accepté', () => {
    const { repo, a } = lot(true);
    const sha = amende(repo, a.fiche, 'feat(L1): fiche du lot livré');
    corrige(repo, a.test);
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x', '--porteur', 'L2');
    expect(r.err).toBe('');
    expect(journal(repo, a.json)[0]).toMatchObject({ porteur: 'L2', ficheAmendee: sha });
  });

  it('R2 — fiche supprimée ou renommée depuis le rouge : refus, pas de ficheAmendee', () => {
    const { repo, a } = lot();
    git(repo, 'mv', a.fiche, `${a.fiche}.old`);
    git(repo, 'commit', '-q', '-m', 'feat(L1): fiche renommée');
    corrige(repo, a.test);
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/fiche .* (supprimée|renommée|absente)/);
    expect(readFileSync(join(repo, a.json), 'utf8')).not.toContain('ficheAmendee');
  });

  it('R3 — fiche modifiée mais non commitée : refus, aucun rescellé', () => {
    const { repo, a } = lot();
    amende(repo, a.fiche, 'feat(L1): fiche');
    writeFileSync(join(repo, a.fiche), `${readFileSync(join(repo, a.fiche), 'utf8')}# pas commitée\n`);
    corrige(repo, a.test);
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/a des modifications non commitées : la commiter \(en citant L1\) avant le rescellé/);
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(head);
    git(repo, 'add', '--', a.fiche); // indexée mais non commitée : refusée aussi
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x').err).toMatch(/modifications non commitées/);
  });

  it('R4 — fiche amendée et un second test listé modifié : refus', () => {
    const { repo, a, second } = lot();
    amende(repo, a.fiche, 'feat(L1): fiche');
    corrige(repo, a.test);
    writeFileSync(join(repo, second), 'touché\n');
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x');
    expect(r.err).toContain('autre(s) test(s) listé(s) modifié(s) depuis le commit rouge');
    expect(r.err).toContain(second);
  });

  it('R4 — fiche amendée mais test nommé inchangé : refus « rien à resceller »', () => {
    const { repo, a } = lot();
    amende(repo, a.fiche, 'feat(L1): fiche');
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x');
    expect(r.err).toMatch(/est inchangé depuis le scellé : rien à resceller/);
  });

  it('R5 — fiche amendée puis ramenée à l’identique par un commit d’un autre lot : traitée comme inchangée, sans refus', () => {
    const { repo, a } = lot();
    const orig = readFileSync(join(repo, a.fiche), 'utf8');
    amende(repo, a.fiche, 'docs(L2): fiche');
    writeFileSync(join(repo, a.fiche), orig);
    commitPaths(repo, 'docs(L2): fiche remise', a.fiche);
    corrige(repo, a.test);
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(readFileSync(join(repo, a.json), 'utf8')).not.toContain('ficheAmendee');
  });

  it('R5 — fiche inchangée : entrée de resceaux identique à L200, sans ficheAmendee ; note « fiche inchangée »', () => {
    const { repo, a } = lot();
    corrige(repo, a.test);
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x').code).toBe(0);
    expect(Object.keys(journal(repo, a.json)[0]!).sort()).toEqual(['apres', 'avant', 'date', 'raison', 'test']);
    expect(readFileSync(join(repo, '.cadence/raf.yaml'), 'utf8')).toContain('fiche inchangée');
  });

  it('R5 — fiche amendée : la note du lot et le commit mentionnent « fiche amendée en <sha> »', () => {
    const { repo, a } = lot();
    const sha = amende(repo, a.fiche, 'feat(L1): fiche');
    corrige(repo, a.test);
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x').code).toBe(0);
    const plan = readFileSync(join(repo, '.cadence/raf.yaml'), 'utf8');
    expect(plan).toContain(`fiche amendée en ${sha}`);
    expect(plan).not.toContain('fiche inchangée');
    expect(git(repo, 'log', '-2', '--format=%s').split('\n')[1]).toContain(`fiche amendée en ${sha}`);
  });

  it('R6 — hook pre-commit qui refuse, fiche amendée : journal et test restaurés, fiche intacte', () => {
    const { repo, a } = lot();
    amende(repo, a.fiche, 'feat(L1): fiche');
    corrige(repo, a.test);
    const jsonAvant = readFileSync(join(repo, a.json), 'utf8');
    const testAvant = readFileSync(join(repo, a.test), 'utf8');
    const ficheAvant = readFileSync(join(repo, a.fiche), 'utf8');
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "refusé par le hook" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x');
    expect(r.err).toMatch(/commit du rescellé a échoué.*rien n'est rescellé/);
    expect(readFileSync(join(repo, a.json), 'utf8')).toBe(jsonAvant);
    expect(readFileSync(join(repo, a.test), 'utf8')).toBe(testAvant);
    expect(readFileSync(join(repo, a.fiche), 'utf8')).toBe(ficheAvant);
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(git(repo, 'status', '--porcelain', '--', a.fiche).trim()).toBe('');
  });

  it('R7 — second rescellé après amendement : fiche inchangée depuis le nouveau rouge, pas de ficheAmendee', () => {
    const { repo, a } = lot();
    amende(repo, a.fiche, 'feat(L1): fiche');
    corrige(repo, a.test);
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'un').code).toBe(0);
    corrige(repo, a.test);
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'deux');
    expect(r.err).toBe('');
    const j = journal(repo, a.json);
    expect(j[0]!.ficheAmendee).toBeTruthy();
    expect(j[1]!.ficheAmendee).toBeUndefined();
  });

  it('R7 — resealedRouge adopte le commit d’un rescellé à fiche amendée', () => {
    const { repo, a } = lot();
    const ancre = redSha(repo, a.json)!;
    amende(repo, a.fiche, 'feat(L1): fiche');
    corrige(repo, a.test);
    cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x');
    const rescelle = redSha(repo, a.json)!;
    expect(rescelle).not.toBe(ancre);
    expect(resealedRouge(repo, a.json, ancre)).toBe(rescelle);
  });

  it('R8 — commit « feat(L1/t1): fiche » reconnu comme citant L1', () => {
    const { repo, a } = lot();
    amende(repo, a.fiche, 'feat(L1/t1): fiche');
    corrige(repo, a.test);
    const r = resealAcceptation(repo, a.json, a.test, 'x', '2026-10-15', undefined, refsL);
    expect(r.ficheAmendee).toBeTruthy();
  });

  it('R8 — lot livré : la citation du lot ou celle du porteur est acceptée, un autre lot refusé', () => {
    for (const [message, attendu] of [['feat(L1): fiche', true], ['feat(L2): fiche', true], ['feat(L3): fiche', false]] as const) {
      const { repo, a } = lot(true);
      amende(repo, a.fiche, message);
      corrige(repo, a.test);
      const fn = () => resealAcceptation(repo, a.json, a.test, 'x', '2026-10-15', 'L2', refsL);
      if (attendu) expect(fn).not.toThrow();
      else expect(fn).toThrow(/ne cite ni L1, ni le porteur L2, ni un lot livré : [0-9a-f]{7} \(cite : L3\)/);
    }
  });

  it('R8 — lot en cours : commit dont seul le corps évoque le lot en passant, lu comme citedRefs', () => {
    const corpsSeul = lot();
    amende(corpsSeul.repo, corpsSeul.a.fiche, 'docs: fiche\n\nvu avec L1');
    corrige(corpsSeul.repo, corpsSeul.a.test);
    expect(() => resealAcceptation(corpsSeul.repo, corpsSeul.a.json, corpsSeul.a.test, 'x', '2026-10-15', undefined, refsL)).not.toThrow();
    const autrePortee = lot();
    amende(autrePortee.repo, autrePortee.a.fiche, 'docs(L2): fiche\n\nvu avec L1');
    corrige(autrePortee.repo, autrePortee.a.test);
    expect(() => resealAcceptation(autrePortee.repo, autrePortee.a.json, autrePortee.a.test, 'x', '2026-10-15', undefined, refsL)).toThrow(/ne cite pas L1/);
  });

  it('R9 — fiche amendée sous CADENCE_ORCHESTRATED : refus L200 inchangé', () => {
    const { repo, a } = lot();
    amende(repo, a.fiche, 'feat(L1): fiche');
    corrige(repo, a.test);
    expect(cli(repo, { CADENCE_ORCHESTRATED: 'w1' }, 'spec', 'reseal', 'L1', a.test, '--reason', 'x').err).toMatch(/vague orchestrée/);
  });

  it('R9 — fiche amendée sans --reason : refus L200 inchangé', () => {
    const { repo, a } = lot();
    amende(repo, a.fiche, 'feat(L1): fiche');
    corrige(repo, a.test);
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--reason/);
  });
});

// L229 : un lot livré accepte une fiche amendée par un commit qui cite un autre lot livré (la fiche vivante est la référence).
describe('cadence spec reseal d’un lot livré, fiche amendée par un autre lot livré (L229)', () => {
  function cli(repo: string, env: Record<string, string>, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-10-16', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-16T10:00:00') });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  /** L1 livré (acceptation verte), L2 en cours (le porteur), L3 livré (l'autre lot livré), L4 en cours, L5 à faire. */
  function lots() {
    const s = lotScelle({ vert: true });
    cli(s.repo, {}, 'init', '--project', 'demo');
    for (const t of ['un', 'deux', 'trois', 'quatre', 'cinq']) cli(s.repo, {}, 'add', `Lot ${t}`);
    for (const id of ['L1', 'L3']) {
      cli(s.repo, {}, 'start', id);
      cli(s.repo, {}, 'done', id, '--force');
    }
    cli(s.repo, {}, 'start', 'L2');
    cli(s.repo, {}, 'start', 'L4');
    commitPaths(s.repo, 'plan: lots', '.cadence/raf.yaml', '.gitignore');
    return s;
  }
  const amende = (repo: string, fiche: string, message: string, ajout = `# amendée ${Math.random()}\n`) => {
    writeFileSync(join(repo, fiche), `${readFileSync(join(repo, fiche), 'utf8')}${ajout}`);
    commitPaths(repo, message, fiche);
    return git(repo, 'rev-parse', '--short', 'HEAD').trim();
  };
  const corrige = (repo: string, test: string) => writeFileSync(join(repo, test), `${readFileSync(join(repo, test), 'utf8')}// corrigé ${Math.random()}\n`);
  const journal = (repo: string, json: string) => JSON.parse(readFileSync(join(repo, json), 'utf8')).resceaux as Record<string, string>[];
  const reseal = (repo: string, test: string) => cli(repo, {}, 'spec', 'reseal', 'L1', test, '--reason', 'x', '--porteur', 'L2');

  it('R1 — lot livré : commit de la fiche citant un autre lot livré : rescellé accepté, ficheAmendee = ce commit', () => {
    const { repo, a } = lots();
    const sha = amende(repo, a.fiche, 'fix(L3): fiche amendée par un autre lot livré');
    corrige(repo, a.test);
    const r = reseal(repo, a.test);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(journal(repo, a.json)[0]).toMatchObject({ porteur: 'L2', ficheAmendee: sha });
    expect(r.out).toContain(`fiche amendée en ${sha}`);
  });

  it('R1 — lot livré : commits mêlés (lot, porteur, autre lot livré) : accepté', () => {
    const { repo, a } = lots();
    amende(repo, a.fiche, 'feat(L1): fiche du lot');
    amende(repo, a.fiche, 'fix(L2): fiche du porteur');
    const dernier = amende(repo, a.fiche, 'fix(L3): fiche d’un autre livré');
    corrige(repo, a.test);
    const r = reseal(repo, a.test);
    expect(r.err).toBe('');
    expect(journal(repo, a.json)[0]!.ficheAmendee).toBe(dernier);
  });

  it('R1 — lot livré : commit citant un lot livré et un lot en cours (fix(L3,L4)) : admis, au moins un lot cité suffit', () => {
    const { repo, a } = lots();
    amende(repo, a.fiche, 'fix(L3,L4): fiche');
    corrige(repo, a.test);
    expect(reseal(repo, a.test).err).toBe('');
  });

  it('R2 — lot livré : commit de la fiche citant un autre lot en cours : refus, fichiers intacts', () => {
    const { repo, a } = lots();
    amende(repo, a.fiche, 'fix(L3): fiche');
    const faute = amende(repo, a.fiche, 'docs(L4): fiche d’un lot en cours');
    corrige(repo, a.test);
    const jsonAvant = readFileSync(join(repo, a.json), 'utf8');
    const testAvant = readFileSync(join(repo, a.test), 'utf8');
    const r = reseal(repo, a.test);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(faute);
    expect(readFileSync(join(repo, a.json), 'utf8')).toBe(jsonAvant);
    expect(readFileSync(join(repo, a.test), 'utf8')).toBe(testAvant);
  });

  it('R2 — lot livré : commit de la fiche citant un lot à faire : refus', () => {
    const { repo, a } = lots();
    const faute = amende(repo, a.fiche, 'docs(L5): fiche d’un lot à faire');
    corrige(repo, a.test);
    const r = reseal(repo, a.test);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(faute);
  });

  it('R2 — lot livré : commit de la fiche sans citation de lot : refus', () => {
    const { repo, a } = lots();
    const faute = amende(repo, a.fiche, 'docs: fiche sans lot');
    corrige(repo, a.test);
    const r = reseal(repo, a.test);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`${faute} (cite : aucun lot)`);
  });

  it('R2 — lot livré : commit citant un lot absent du plan : refus', () => {
    const { repo, a } = lots();
    const faute = amende(repo, a.fiche, 'docs(L99): fiche d’un lot inconnu');
    corrige(repo, a.test);
    const r = reseal(repo, a.test);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`${faute} (cite : L99)`);
  });

  it('R3 — refus d’un lot livré : le message nomme le sha fautif, le lot cité, et la voie à suivre (--porteur / commit à citer)', () => {
    const { repo, a } = lots();
    const faute = amende(repo, a.fiche, 'docs(L4): fiche');
    corrige(repo, a.test);
    const r = reseal(repo, a.test);
    expect(r.err).toMatch(new RegExp(`a été modifiée depuis le commit rouge [0-9a-f]{7} par un commit qui ne cite ni L1, ni le porteur L2, ni un lot livré : ${faute} \\(cite : L4\\) — faire citer le porteur ou un lot livré par ce commit \\(le réécrire avant qu'il soit poussé\\) ou, sinon, rescelle à la main avec le lead`));
  });

  it('R3 — refus d’un lot en cours : message L217 inchangé', () => {
    const s = lotScelle();
    cli(s.repo, {}, 'init', '--project', 'demo');
    cli(s.repo, {}, 'add', 'Lot un');
    cli(s.repo, {}, 'add', 'Lot deux');
    cli(s.repo, {}, 'start', 'L1');
    commitPaths(s.repo, 'plan: lots', '.cadence/raf.yaml', '.gitignore');
    const faute = amende(s.repo, s.a.fiche, 'docs(L2): fiche');
    corrige(s.repo, s.a.test);
    const r = cli(s.repo, {}, 'spec', 'reseal', 'L1', s.a.test, '--reason', 'x');
    expect(r.err).toMatch(new RegExp(`par un commit qui ne cite pas L1 : ${faute}$`));
  });

  it('R4 — lot livré : commit citant le lot ou le porteur : accepté comme avant', () => {
    for (const message of ['feat(L1): fiche', 'feat(L2): fiche']) {
      const { repo, a } = lots();
      const sha = amende(repo, a.fiche, message);
      corrige(repo, a.test);
      const r = reseal(repo, a.test);
      expect(r.err).toBe('');
      expect(journal(repo, a.json)[0]).toMatchObject({ porteur: 'L2', ficheAmendee: sha });
    }
  });

  it('R4 — lot en cours : commit de la fiche citant un lot livré : refus, comme avant', () => {
    const s = lotScelle();
    cli(s.repo, {}, 'init', '--project', 'demo');
    cli(s.repo, {}, 'add', 'Lot un');
    cli(s.repo, {}, 'add', 'Lot deux');
    cli(s.repo, {}, 'start', 'L2');
    cli(s.repo, {}, 'done', 'L2', '--force');
    cli(s.repo, {}, 'start', 'L1');
    commitPaths(s.repo, 'plan: lots', '.cadence/raf.yaml', '.gitignore');
    const faute = amende(s.repo, s.a.fiche, 'fix(L2): fiche d’un lot livré');
    corrige(s.repo, s.a.test);
    const r = cli(s.repo, {}, 'spec', 'reseal', 'L1', s.a.test, '--reason', 'x');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(new RegExp(`ne cite pas L1 : ${faute}$`));
  });

  it('R4 — écart net vide : pas de ficheAmendee', () => {
    const { repo, a } = lots();
    const orig = readFileSync(join(repo, a.fiche), 'utf8');
    amende(repo, a.fiche, 'docs(L4): fiche');
    writeFileSync(join(repo, a.fiche), orig);
    commitPaths(repo, 'docs(L4): fiche remise', a.fiche);
    corrige(repo, a.test);
    const r = reseal(repo, a.test);
    expect(r.err).toBe('');
    expect(r.out).not.toContain('fiche amendée');
    expect(journal(repo, a.json)[0]).not.toHaveProperty('ficheAmendee');
  });

  it('R5 — amendement par un lot livré et fiche non commitée : refus', () => {
    const { repo, a } = lots();
    amende(repo, a.fiche, 'fix(L3): fiche');
    writeFileSync(join(repo, a.fiche), `${readFileSync(join(repo, a.fiche), 'utf8')}# pas commitée\n`);
    corrige(repo, a.test);
    expect(reseal(repo, a.test).err).toMatch(/a des modifications non commitées/);
  });

  it('R5 — amendement par un lot livré et un second test modifié : refus', () => {
    const { repo, a, second } = lots();
    amende(repo, a.fiche, 'fix(L3): fiche');
    corrige(repo, a.test);
    writeFileSync(join(repo, second), 'touché\n');
    const r = reseal(repo, a.test);
    expect(r.err).toContain('autre(s) test(s) listé(s) modifié(s) depuis le commit rouge');
  });

  it('R5 — amendement par un lot livré sous CADENCE_ORCHESTRATED : refus inchangé', () => {
    const { repo, a } = lots();
    amende(repo, a.fiche, 'fix(L3): fiche');
    corrige(repo, a.test);
    expect(cli(repo, { CADENCE_ORCHESTRATED: 'w1' }, 'spec', 'reseal', 'L1', a.test, '--reason', 'x', '--porteur', 'L2').err).toMatch(/vague orchestrée/);
  });

  it('R6 — resealAcceptation sans liste de lots livrés : comportement L217', () => {
    const { repo, a } = lots();
    amende(repo, a.fiche, 'fix(L3): fiche');
    corrige(repo, a.test);
    expect(() => resealAcceptation(repo, a.json, a.test, 'x', '2026-10-16', 'L2', refsL)).toThrow(/ne cite ni L1, ni le porteur L2, ni un lot livré/);
  });

  it('R6 — un lot au statut todo ou doing n’est pas admis comme livré', () => {
    const { repo, a } = lots();
    amende(repo, a.fiche, 'fix(L5): fiche');
    corrige(repo, a.test);
    expect(() => resealAcceptation(repo, a.json, a.test, 'x', '2026-10-16', 'L2', refsL, [])).toThrow(/ne cite ni L1/);
    const r = reseal(repo, a.test);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('ne cite ni L1');
  });
});
