import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { inspectWave, measureWave, parseJournal, renderInspection, tourSummary } from '../src/inspect.js';
import { endOfWaveLines } from '../src/inspect-read.js';
import { withPlace } from '../src/orchestrate/gate-place.js';
import { tempDir } from './helpers.js';

/** Une ligne de journal à `min` minutes après 09:00 (`sec` secondes en plus). */
const at = (min: number, text: string, sec = 0) => `2026-11-06T${String(9 + Math.floor((min * 60 + sec) / 3600)).padStart(2, '0')}:${String(Math.floor(((min * 60 + sec) % 3600) / 60)).padStart(2, '0')}:${String((min * 60 + sec) % 60).padStart(2, '0')}.000Z ${text}`;
const journal = (...lines: string[]) => `${lines.join('\n')}\n`;

function runs(waves: Record<string, string>): string {
  const root = tempDir();
  for (const [wave, text] of Object.entries(waves)) {
    mkdirSync(join(root, '.cadence', 'runs', wave), { recursive: true });
    writeFileSync(join(root, '.cadence', 'runs', wave, 'journal.log'), text);
  }
  return root;
}
const measure = (text: string) => measureWave(parseJournal(text));

describe('cadence inspect (L627)', () => {
  it('R1 — le temps de chaque lot par état vient des transitions du journal ; un état final n\'accumule rien', () => {
    const { lots } = measure(journal(
      at(0, 'cadence:L1 → implementing'), at(0, 'cadence:L1 · session 1 implement (sonnet)'),
      at(10, 'cadence:L1 → reviewing'), at(25, 'cadence:L1 → fixing'), at(30, 'cadence:L1 → reviewing'), at(40, 'cadence:L1 → ready — prêt à livrer'),
      at(50, 'cadence:L2 → implementing'),
    ));
    const l1 = lots.find((l) => l.lot === 'cadence:L1')!;
    expect(l1.states).toEqual({ implementing: 10, reviewing: 25, fixing: 5 });
    expect(l1.sessions).toBe(1);
    // de la première revue (10) à la dernière ligne du lot (ready à 40), pas à celle de la vague (L2 écrit à 50)
    expect(l1.afterFirstReview).toBe(30);
    // L2, dernier lot : son état court jusqu'à la dernière ligne du journal (0 ici).
    expect(lots.find((l) => l.lot === 'cadence:L2')!.states).toEqual({ implementing: 0 });
  });

  it('R2 — le début et la fin de chaque porte isolent le temps de porte ; une porte imbriquée compte une fois, une fin sans début ou un début sans fin ne comptent pas', () => {
    const { lots } = measure(journal(
      at(0, 'cadence:L1 → reviewing'),
      at(1, 'cadence:L1 · porte : début'), at(3, 'cadence:L1 · porte : début (ligne de base abc1234)'), at(5, 'cadence:L1 · porte : fin (ligne de base abc1234)'), at(9, 'cadence:L1 · porte : fin'),
      at(20, 'cadence:L1 · porte : fin'), at(21, 'cadence:L1 · porte : début'),
    ));
    expect(lots[0]).toMatchObject({ gateMinutes: 8, gates: 3 });
  });

  it('R2 — withPlace écrit « début » puis « fin » autour de la porte, la fin aussi quand la porte lève', async () => {
    const said: string[] = [];
    const traced: string[] = [];
    const o = { config: {}, repo: '/x', sha: null, dir: '/x', needClean: false, label: 'porte du lot L9', local: async () => ({ code: 0, out: '' }), say: (l: string) => said.push(l), trace: (l: string) => traced.push(l) } as unknown as Parameters<typeof withPlace>[0];
    await withPlace(o, async () => 1);
    await expect(withPlace({ ...o, detail: '(ligne de base abc1234)' }, async () => { throw new Error('rouge'); })).rejects.toThrow('rouge');
    expect(traced).toEqual(['porte : début', 'porte : fin', 'porte : début (ligne de base abc1234)', 'porte : fin (ligne de base abc1234)']);
    expect(said).toEqual([]);
  });

  it('R3 — les pertes se classent en refus d\'intégration, reprise du lead, attente de créneau et conflit, chacune avec ses minutes', () => {
    const { losses } = measure(journal(
      at(0, 'cadence:L1 → handed-back — intégration refusée : tests rouges au sommet intégré (npx vitest run en échec)'), at(12, 'cadence:L1 → suspended — intégration reprise (--resume --integrate)'), at(15, 'cadence:L1 → ready — prêt'),
      at(0, 'cadence:L2 → handed-back — intégration impossible : conflit en rebasant cadence/w/cadence--L2 sur main'), at(7, 'cadence:L2 → ready — prêt'),
      at(0, 'cadence:L3 → question — R2 est posée comme hypothèse'), at(20, 'cadence:L3 → implementing'),
      at(0, 'cadence:L4 · créneau de session obtenu après 2 min 30 s d\'attente (1/1 en cours : w)'),
      at(0, 'cadence:L4 · créneau de session obtenu après 40 s d\'attente (1/1 en cours : w)'),
      at(30, 'cadence:L5 · porte du lot L5 : en attente d\'un créneau de porte sur mini (2 porte(s) simultanée(s) au plus)'), at(34, 'cadence:L5 · porte du lot L5 : porte jouée sur l\'hôte mini (sha abc1234, cache)'),
    ));
    expect(losses.map((l) => [l.lot, l.category, l.cause, l.minutes])).toEqual([
      ['cadence:L1', 'refus d\'intégration', 'tests rouges au sommet intégré', 12],
      ['cadence:L1', 'reprise du lead', 'intégration reprise par le lead', 3],
      ['cadence:L2', 'conflit', 'conflit de rebase', 7],
      ['cadence:L3', 'reprise du lead', 'réponse du lead à une question', 20],
      ['cadence:L4', 'attente de créneau', 'créneau de session', 2.5],
      ['cadence:L4', 'attente de créneau', 'créneau de session', 0.7],
      ['cadence:L5', 'attente de créneau', 'créneau de porte', 4],
    ]);
  });

  it('R3 — un refus rendu sans suite se compte (0 min mesurée), un créneau obtenu sans attente ne se compte pas, une ligne illisible est ignorée', () => {
    const { losses } = measure(journal('pas une ligne de journal', at(0, 'cadence:L1 → handed-back — intégration refusée : revue non conforme'), at(1, 'cadence:L2 · créneau de session obtenu après 0 s d\'attente (1/1 en cours : w)')));
    expect(losses.map((l) => [l.cause, l.minutes])).toEqual([['revue non conforme', 0]]);
  });

  it('R4 — une cause déjà vue dans une vague d\'avant est une récidive et passe en tête, même avec moins de minutes', () => {
    const refus = (min: number) => journal(at(0, 'cadence:L1 → handed-back — intégration refusée : tests rouges au sommet intégré (x)'), at(min, 'cadence:L1 → suspended — intégration reprise'), at(min + 1, 'cadence:L1 → ready — prêt'));
    const conflit = journal(at(0, 'cadence:L2 → handed-back — intégration impossible : conflit en rebasant a sur b'), at(30, 'cadence:L2 → ready — prêt'));
    const root = runs({ '2026-11-04-0800': refus(5), '2026-11-06-0900': refus(2) + conflit });
    const i = inspectWave(join(root, '.cadence', 'runs'), '2026-11-06-0900', []);
    expect(i.causes.map((c) => [c.cause, c.minutes, c.recidive, c.seenIn])).toEqual([
      ['tests rouges au sommet intégré', 2, true, ['2026-11-04-0800']],
      ['intégration reprise par le lead', 1, true, ['2026-11-04-0800']],
      ['conflit de rebase', 30, false, []],
    ]);
  });

  it('R4 — une vague plus récente que celle inspectée n\'est pas « déjà vue »', () => {
    const t = journal(at(0, 'cadence:L2 → handed-back — intégration impossible : conflit en rebasant a sur b'), at(3, 'cadence:L2 → ready — prêt'));
    const root = runs({ '2026-11-06-0900': t, '2026-11-07-0900': t });
    expect(inspectWave(join(root, '.cadence', 'runs'), '2026-11-06-0900', []).causes[0]).toMatchObject({ recidive: false, seenIn: [] });
  });

  it('R5 — la cause se rattache au lot du plan qui la traite ; sans lot, ou avec un lot terminé qui n\'a pas suffi, la commande raf add est proposée', () => {
    const t = journal(at(0, 'cadence:L2 → handed-back — intégration impossible : conflit en rebasant a sur b'), at(3, 'cadence:L2 → ready — prêt'));
    const root = runs({ '2026-11-05-0900': t, '2026-11-06-0900': t });
    const dir = join(root, '.cadence', 'runs');
    const sans = inspectWave(dir, '2026-11-06-0900', [{ project: 'cadence', id: 'L1', title: 'autre chose', status: 'todo' }, { project: 'cadence', id: 'L627', title: 'inspect : refus, reprise, attente de créneau, conflit)', status: 'doing' }]).causes[0]!;
    expect(sans.planLot).toBeNull();
    expect(sans.proposal).toMatch(/^raf add --estimate 0\.25 -- "conflit de rebase : .*niveau : source/);
    const ouvert = inspectWave(dir, '2026-11-06-0900', [{ project: 'cadence', id: 'L599', title: 'Ressources pour éviter un conflit de CHANGELOG', status: 'todo' }]).causes[0]!;
    expect(ouvert).toMatchObject({ planLot: { id: 'cadence:L599', status: 'todo' }, proposal: null, recidive: true });
    const livre = inspectWave(dir, '2026-11-06-0900', [{ project: 'cadence', id: 'L599', title: 'conflit de rebase', status: 'done' }]).causes[0]!;
    expect(livre.planLot).toMatchObject({ status: 'done' });
    expect(livre.proposal).toContain('raf add');
    expect(inspectWave(dir, '2026-11-06-0900', [{ project: 'cadence', id: 'L599', title: 'conflit de rebase', status: 'dropped' }]).causes[0]!.planLot).toBeNull();
  });

  it('R6 — le tableau imprime une ligne par lot et par cause avec le niveau de détection, et le résumé du tour ne dit que la première récidive', () => {
    const t = journal(at(0, 'cadence:L1 → implementing'), at(5, 'cadence:L1 → reviewing'), at(9, 'cadence:L1 → handed-back — intégration impossible : conflit en rebasant a sur b'), at(12, 'cadence:L1 → ready — prêt'));
    const root = runs({ '2026-11-05-0900': t, '2026-11-06-0900': t });
    const i = inspectWave(join(root, '.cadence', 'runs'), '2026-11-06-0900', []);
    const lines = renderInspection(i);
    expect(lines[0]).toBe('inspection de la vague 2026-11-06-0900 : 1 lot(s), 9 min actives, 3 min perdues');
    expect(lines.join('\n')).toMatch(/cadence:L1 +5 +4 +0 +0 +7 +0/);
    expect(lines.join('\n')).toContain('⚠ conflit · conflit de rebase : 3 min, 1 fois, 1 lot(s) · détectée à : intégration · RÉCIDIVE (déjà vue : 2026-11-05-0900)');
    expect(tourSummary(i)).toMatch(/^⚠ inspect 2026-11-06-0900 : récidive « conflit de rebase » \(conflit, 3 min, déjà vue dans 1 vague\(s\)\) · raf add/);
    expect(tourSummary({ ...i, causes: [] })).toBeNull();
    expect(renderInspection({ ...i, causes: [], lots: [] }).slice(1)).toEqual([expect.stringContaining('lot'), 'aucune perte mesurée']);
  });

  it('R6 — cadence inspect lit la dernière vague, --wave en nomme une, --json donne l\'inspection, un dossier sans journal sort en 1', () => {
    const t = journal(at(0, 'cadence:L1 → handed-back — intégration impossible : conflit en rebasant a sur b'), at(3, 'cadence:L1 → ready — prêt'));
    const root = runs({ '2026-11-05-0900': t, '2026-11-06-0900': journal(at(0, 'cadence:L7 → implementing')) });
    const go = (...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = run(argv, { cwd: root, env: {}, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-06T12:00:00Z') });
      return { code, out: out.join('\n'), err: err.join('\n') };
    };
    expect(go('inspect')).toMatchObject({ code: 0, out: expect.stringContaining('vague 2026-11-06-0900 : 1 lot(s)') });
    expect(go('inspect', '--wave', '2026-11-05-0900').out).toContain('conflit de rebase');
    expect(JSON.parse(go('inspect', '--json').out)).toMatchObject({ wave: '2026-11-06-0900', causes: [] });
    expect(go('inspect', '--wave', 'absente')).toMatchObject({ code: 1, err: expect.stringContaining('n\'a pas de journal') });
    expect(go('inspect', tempDir())).toMatchObject({ code: 1, err: expect.stringContaining('aucun journal de vague') });
    expect(go('inspect', 'a', 'b')).toMatchObject({ code: 1, err: expect.stringContaining('usage : cadence inspect') });
  });

  it('R7 — le tableau de fin de vague est celui de la vague, et une vague sans journal n\'ôte rien : la raison part dans warn', () => {
    const root = runs({ '2026-11-06-0900': journal(at(0, 'cadence:L1 → implementing')) });
    const warns: string[] = [];
    expect(endOfWaveLines(join(root, '.cadence', 'runs', '2026-11-06-0900'), (w) => warns.push(w))[0]).toContain('inspection de la vague 2026-11-06-0900');
    expect(endOfWaveLines(join(root, '.cadence', 'runs', 'absente'), (w) => warns.push(w))).toEqual([]);
    expect(warns).toEqual(['orchestrate : inspect : la vague absente n\'a pas de journal dans ' + join(root, '.cadence', 'runs')]);
  });

  it('R8 — cadence lead tour ajoute le résumé de la récidive de la dernière vague après les projets, et rien sans récidive', () => {
    const t = journal(at(0, 'cadence:L1 → handed-back — intégration impossible : conflit en rebasant a sur b'), at(3, 'cadence:L1 → ready — prêt'));
    const root = runs({ '2026-11-05-0900': t, '2026-11-06-0900': t });
    mkdirSync(join(root, 'alpha', '.cadence'), { recursive: true });
    writeFileSync(join(root, 'alpha', '.cadence', 'raf.yaml'), 'version: 1\nproject: "alpha"\nprefix: L\nlots:\n  - id: L1\n    title: "t"\n    status: todo\n');
    const tour = () => {
      const out: string[] = [];
      run(['lead', 'tour', root], { cwd: root, env: { CADENCE_HOME: join(root, 'home') }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-11-06T12:00:00Z') });
      return out;
    };
    expect(tour().some((l) => l.startsWith('⚠ inspect 2026-11-06-0900 : récidive « conflit de rebase »'))).toBe(true);
    writeFileSync(join(root, '.cadence', 'runs', '2026-11-06-0900', 'journal.log'), journal(at(0, 'cadence:L1 → implementing')));
    expect(tour().some((l) => l.includes('inspect'))).toBe(false);
  });
});
