import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plan } from '../src/plan.js';
import { lastDelivery } from '../src/state.js';
import { DAY, edit, fx, go, head, planOf, sh, ship, STATES, write } from './l469-fixture.js';
import { cleanupTempDirs } from './helpers.js';

afterEach(cleanupTempDirs);

const closed = (...ids: string[]) => (p: Plan) => ids.forEach((id) => p.setStatus(id, 'done', '2026-10-05'));

/** Première livraison jouée : le journal a une ligne d'où partir. */
async function started(o: Parameters<typeof fx>[0] = {}) {
  const f = fx(o);
  expect(await go(f)).toBe(0);
  f.out.length = 0;
  return f;
}

describe('C1 — deliver marque livrés les lots terminés', () => {
  it('R1 — lot done cité dans la plage : delivered {date du jour, sha livré} écrit', async () => {
    const f = await started();
    ship(f, ['src/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    expect(await go(f)).toBe(0);
    expect(planOf(f).lot('L1').delivered).toEqual({ date: DAY, sha: lastDelivery(f.state) });
    expect(planOf(f).lot('L2').delivered).toBeUndefined();
  });
  it('R1 — commit « plan seul » qui cite le lot : lot non marqué', async () => {
    const f = await started();
    edit(f, closed('L1')); // « plan: maj » est plan seul ; son message ne cite pas L1, on en écrit un qui le cite
    write(f.dir, '.cadence/raf.yaml', readFileSync(f.planFile, 'utf8') + '\n');
    sh(f.dir, 'add', '-A', '.cadence');
    sh(f.dir, 'commit', '-q', '-m', 'plan: L1 terminé');
    sh(f.dir, 'push', '-q');
    expect(await go(f)).toBe(0);
    expect(planOf(f).lot('L1').delivered).toBeUndefined();
  });
  it('R2 — lot fermé par le script de livraison : marqué livré', async () => {
    const f = await started({ yaml: 'deliver:\n  script: ./livre.sh\n  verify:\n    - command: "true"\n' });
    ship(f, ['src/a.ts'], 'feat(L1): a');
    const exec = (cmd: string) => {
      if (cmd === './livre.sh') {
        const p = planOf(f);
        p.setStatus('L1', 'done', DAY);
        p.save();
        sh(f.dir, 'add', '-A', '.cadence');
        sh(f.dir, 'commit', '-q', '-m', 'plan: L1 terminé par le script');
      }
      return 0;
    };
    expect(await go(f, { exec })).toBe(0);
    expect(planOf(f).lot('L1').delivered?.date).toBe(DAY);
  });
  it('R2 — plan modifié par le script : modification conservée après le marquage', async () => {
    const f = await started({ yaml: 'deliver:\n  script: ./livre.sh\n  verify:\n    - command: "true"\n' });
    ship(f, ['src/a.ts'], 'feat(L1): a');
    const exec = (cmd: string) => {
      if (cmd === './livre.sh') {
        const p = planOf(f);
        p.setStatus('L1', 'done', DAY);
        p.note('L2', 'noté par le script', DAY);
        p.save();
        sh(f.dir, 'add', '-A', '.cadence');
        sh(f.dir, 'commit', '-q', '-m', 'plan: script');
      }
      return 0;
    };
    expect(await go(f, { exec })).toBe(0);
    expect(planOf(f).lot('L2').notes.map((n) => n.text)).toEqual(['noté par le script']);
    expect(planOf(f).lot('L1').delivered).toBeDefined();
  });
  it('R3 — lot done cité seulement par L1/t1 : marqué livré', async () => {
    const f = await started({ prelude: (p) => { p.addTask('L1', 'étape'); p.save(); } });
    ship(f, ['src/a.ts'], 'feat(L1/t1): étape');
    edit(f, (p) => { p.setStatus('L1/t1', 'done', DAY); closed('L1')(p); });
    expect(await go(f)).toBe(0);
    expect(planOf(f).lot('L1').delivered?.date).toBe(DAY);
    expect(f.out.join('\n')).toContain('lots marqués livrés : L1');
  });
  it('R3 — lot done cité par L1 et par L1/t1 : un seul marquage', async () => {
    const f = await started({ prelude: (p) => { p.addTask('L1', 'étape'); p.save(); } });
    ship(f, ['src/a.ts'], 'feat(L1/t1): étape');
    ship(f, ['src/b.ts'], 'feat(L1): suite');
    edit(f, (p) => { p.setStatus('L1/t1', 'done', DAY); closed('L1')(p); });
    expect(await go(f)).toBe(0);
    expect(readFileSync(f.planFile, 'utf8').match(/delivered:/g)).toHaveLength(1);
    expect(f.out.filter((l) => l.startsWith('lots marqués livrés'))).toHaveLength(1);
  });
  it('R4 — lot doing cité par L1/t1 : ni delivered ni état modifiés', async () => {
    const f = await started({ settings: STATES, prelude: (p) => { p.addTask('L1', 'étape'); p.save(); } });
    ship(f, ['src/a.ts'], 'feat(L1/t1): étape');
    const before = readFileSync(f.planFile, 'utf8');
    expect(await go(f)).toBe(0);
    expect(readFileSync(f.planFile, 'utf8')).toBe(before);
    expect(f.out.some((l) => l.startsWith('livré : L1'))).toBe(true);
  });
  it('R4 — lot todo cité : non marqué', async () => {
    const f = await started({ prelude: (p) => { p.setStatus('L2', 'done', DAY); } });
    edit(f, (p) => p.putBack('L2', DAY, '', () => 0));
    ship(f, ['src/a.ts'], 'feat(L2): a');
    expect(await go(f)).toBe(0);
    expect(planOf(f).lot('L2').delivered).toBeUndefined();
    expect(planOf(f).lot('L2').status).toBe('todo');
  });
  it('R5 — lot déjà livré cité par une seconde livraison : delivered inchangé, aucun commit de plan créé', async () => {
    const f = await started();
    ship(f, ['src/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    await go(f);
    const first = planOf(f).lot('L1').delivered;
    ship(f, ['src/b.ts'], 'fix(L1): b');
    const tip = head(f);
    f.out.length = 0;
    expect(await go(f)).toBe(0);
    expect(planOf(f).lot('L1').delivered).toEqual(first);
    expect(head(f)).toBe(tip);
    expect(f.out.some((l) => l.startsWith('lots marqués livrés'))).toBe(false);
  });
});

describe('C1 — états', () => {
  it('R6 — état termine : passe à livre avec delivered', async () => {
    const f = await started({ settings: STATES });
    ship(f, ['src/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    expect(planOf(f).lot('L1').state).toBe('termine');
    await go(f);
    expect(planOf(f).lot('L1')).toMatchObject({ state: 'livre', delivered: { date: DAY } });
  });
  it('R6 — état done autre que doneState : état inchangé, delivered écrit', async () => {
    const f = await started({ settings: STATES });
    ship(f, ['src/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    writeFileSync(f.planFile, readFileSync(f.planFile, 'utf8').replace('state: termine', 'state: autre'));
    sh(f.dir, 'commit', '-qam', 'plan: autre');
    sh(f.dir, 'push', '-q');
    await go(f);
    expect(planOf(f).lot('L1')).toMatchObject({ state: 'autre', delivered: { date: DAY } });
  });
  it('R6 — sans deliveredState : état inchangé', async () => {
    const settings = { states: { ...STATES.states!, delivered: undefined } };
    const f = await started({ settings });
    ship(f, ['src/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    await go(f);
    expect(planOf(f).lot('L1')).toMatchObject({ state: 'termine', delivered: { date: DAY } });
  });
  it('R7 — transition refusée : lot non marqué, avertissement, code 0', async () => {
    const settings = { states: { ...STATES.states!, transitions: { en_cours: ['termine'], termine: ['en_cours'] } } };
    const f = await started({ settings });
    ship(f, ['src/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    expect(await go(f)).toBe(0);
    expect(planOf(f).lot('L1')).toMatchObject({ state: 'termine' });
    expect(planOf(f).lot('L1').delivered).toBeUndefined();
    expect(f.err).toContain('deliver : L1 non marqué livré : transition termine → livre refusée par plan.transitions');
    expect(sh(f.dir, 'status', '--porcelain')).toBe('');
  });
  it('R7 — transition permise : lot marqué', async () => {
    const settings = { states: { ...STATES.states!, transitions: { en_cours: ['termine'], termine: ['livre'] } } };
    const f = await started({ settings });
    ship(f, ['src/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    await go(f);
    expect(planOf(f).lot('L1')).toMatchObject({ state: 'livre', delivered: { date: DAY } });
  });
});

describe('C1 — plan, archive, écriture', () => {
  it('R8 — plan en lecture seule : plan inchangé, annonce identique à celle d\'avant', async () => {
    const readonly = { format: { lots: 'lots', fields: {}, statuses: {}, estimates: {} } };
    const f = await started({ settings: readonly });
    ship(f, ['src/a.ts'], 'feat(L1): a');
    const before = readFileSync(f.planFile, 'utf8');
    expect(await go(f)).toBe(0);
    expect(readFileSync(f.planFile, 'utf8')).toBe(before);
    expect(f.out).toContain("livré : L1 — à fermer avec l'outil du projet si l'effet est celui attendu");
    expect(f.out.some((l) => l.startsWith('lots marqués'))).toBe(false);
  });
  it('R9 — lot archivé : delivered écrit dans le fichier d\'année', async () => {
    const f = await started();
    ship(f, ['src/a.ts'], 'feat(L1): a');
    edit(f, (p) => { closed('L1')(p); p.save(); p.archive(DAY); });
    expect(existsSync(join(f.dir, '.cadence/archive/2026.yaml'))).toBe(true);
    await go(f);
    expect(readFileSync(join(f.dir, '.cadence/archive/2026.yaml'), 'utf8')).toContain('delivered:');
    expect(readFileSync(f.planFile, 'utf8')).not.toContain('delivered:');
  });
  it('R9 — après deliver, git status est propre (plan et archive commités)', async () => {
    const f = await started();
    ship(f, ['src/a.ts'], 'feat(L1): a');
    edit(f, (p) => { closed('L1')(p); p.save(); p.archive(DAY); });
    await go(f);
    expect(sh(f.dir, 'status', '--porcelain')).toBe('');
    expect(sh(f.dir, 'show', '--stat', '--format=%s', 'HEAD')).toContain('.cadence/archive/2026.yaml');
    expect(f.out.join('\n')).toMatch(/lots marqués livrés : L1 — delivered: 2026-10-09 [0-9a-f]{7} \(plan commité [0-9a-f]+\)/);
  });
  it('R10 — plan modifié avant la livraison : marquage écrit, pas de commit, message', async () => {
    const f = await started({ yaml: 'deliver:\n  script: ./livre.sh\n  verify:\n    - command: "true"\n' });
    ship(f, ['src/a.ts'], 'feat(L1): a');
    const tip = head(f);
    const exec = (cmd: string) => {
      if (cmd === './livre.sh') {
        const p = planOf(f);
        p.setStatus('L1', 'done', DAY);
        p.save(); // le script laisse le plan modifié, non commité
      }
      return 0;
    };
    expect(await go(f, { exec })).toBe(0);
    expect(planOf(f).lot('L1').delivered?.date).toBe(DAY);
    expect(head(f)).toBe(tip);
    expect(f.out.join('\n')).toContain('plan déjà modifié avant la livraison, non commité : à commiter avec vos modifications');
  });
  it('R11 — --dry-run : plan inchangé', async () => {
    const f = await started();
    ship(f, ['src/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    const before = readFileSync(f.planFile, 'utf8');
    expect(await go(f, { dryRun: true })).toBe(0);
    expect(readFileSync(f.planFile, 'utf8')).toBe(before);
  });
  it('R11 — première livraison : aucun lot marqué', async () => {
    const f = fx();
    ship(f, ['src/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    expect(await go(f)).toBe(0);
    expect(planOf(f).lot('L1').delivered).toBeUndefined();
  });
  it('R11 — livraison précédente hors historique : aucun lot marqué', async () => {
    const f = fx();
    write(f.state, 'deliveries.log', `2026-10-01 ${'e'.repeat(40)}\n`);
    ship(f, ['src/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    expect(await go(f)).toBe(0);
    expect(planOf(f).lot('L1').delivered).toBeUndefined();
  });
  it('R12 — plan non inscriptible : avertissement, ligne verte conservée, code 0', async () => {
    const f = await started();
    ship(f, ['src/a.ts'], 'feat(L1): a');
    edit(f, closed('L1'));
    chmodSync(f.planFile, 0o444);
    expect(await go(f)).toBe(0);
    chmodSync(f.planFile, 0o644);
    expect(f.err.some((l) => l.startsWith('deliver : lots livrés non marqués : écriture du plan refusée'))).toBe(true);
    expect(lastDelivery(f.state)).toBe(head(f));
  });
  it('R29 — annonce d\'avant inchangée ; ligne « lots marqués livrés » seulement si un lot est marqué', async () => {
    const f = await started();
    ship(f, ['src/a.ts'], 'feat(L1): a');
    ship(f, ['src/b.ts'], 'feat(L2): b');
    edit(f, closed('L1'));
    await go(f);
    const i = f.out.indexOf('livré : L1, L2 — raf done si l\'effet est celui attendu');
    expect(i).toBeGreaterThan(-1);
    expect(f.out[i + 1]).toMatch(/^lots marqués livrés : L1 — delivered: 2026-10-09 [0-9a-f]{7}/);
    f.out.length = 0;
    ship(f, ['src/c.ts'], 'feat(L2): c');
    await go(f);
    expect(f.out.some((l) => l.startsWith('lots marqués'))).toBe(false);
  });
});
