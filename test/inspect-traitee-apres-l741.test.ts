import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectWave, renderInspection, tourSummary } from '../src/inspect.js';
import { tempDir } from './helpers.js';

/** Le motif de L676 dans la vague 2026-11-07-0800, rendu à 08:25:46 et repris à 10:03:23 (97,6 min). */
const RENDU = "→ handed-back — correction non jouée (budget) : budget du lot : 559676 / 600000 tokens comptés, 175000 retenus pour l'escalade sur 775000 (dérivé de l'estimate), il ne reste pas de quoi payer la correction et la revue courte qui la suivrait (155000 réservés) : étape « fix » non jouée, à décider par le lead";
const journal = (day: string) => `${day}T08:25:46.671Z cadence:L676 ${RENDU}\n${day}T10:03:23.078Z cadence:L676 → suspended — intégration reprise (--resume --integrate) : revue conforme du lead hors vague, 0e2370b\n`;

function runs(): string {
  const root = tempDir();
  for (const [wave, day] of [['2026-11-06-2230', '2026-11-06'], ['2026-11-07-0800', '2026-11-07']] as const) {
    mkdirSync(join(root, '.cadence', 'runs', wave), { recursive: true });
    writeFileSync(join(root, '.cadence', 'runs', wave, 'journal.log'), journal(day));
  }
  return join(root, '.cadence', 'runs');
}

const nonJouee = (i: ReturnType<typeof inspectWave>) => i.causes.find((c) => c.cause === 'correction non jouée')!;
const L682 = { project: 'cadence', id: 'L682', title: 'Budget : correction non jouée après revue finale non conforme', status: 'done' };

describe("inspect : une cause traitée par un lot terminé après la vague n'est pas une récidive à rouvrir (L741)", () => {
  it('R1 — vague du 07-11, L682 terminé le 12-11 : ni récidive, ni raf add ; la ligne dit le lot et sa date, à mesurer sur la vague suivante', () => {
    const i = inspectWave(runs(), '2026-11-07-0800', [{ ...L682, finished: '2026-11-12' }]);
    const c = nonJouee(i);
    expect(c).toMatchObject({ category: 'reprise du lead', cause: 'correction non jouée', minutes: 97.6, seenIn: ['2026-11-06-2230'], recidive: false, proposal: null });
    expect(c.planLot).toEqual({ id: 'cadence:L682', status: 'done', finished: '2026-11-12', after: true });
    expect(renderInspection(i)).toContain('    traitée après la vague : cadence:L682 (done le 2026-11-12), à mesurer sur la vague suivante');
    expect(tourSummary(i) ?? '').not.toContain('correction non jouée');
  });

  it('R2 — le lot terminé avant la vague, ou le jour même, ou sans date : la cause reste une récidive et la commande raf add est proposée, comme avant', () => {
    for (const finished of ['2026-11-05', '2026-11-07', undefined]) {
      const c = nonJouee(inspectWave(runs(), '2026-11-07-0800', [{ ...L682, ...(finished ? { finished } : {}) }]));
      expect(c.recidive).toBe(true);
      expect(c.planLot?.after).toBeUndefined();
      expect(c.proposal).toContain('raf add');
    }
  });

  it("R3 — une vague à nom libre n'a pas de date : la règle ne s'applique pas", () => {
    const dir = runs();
    mkdirSync(join(dir, 'cadence-l1'), { recursive: true });
    writeFileSync(join(dir, 'cadence-l1', 'journal.log'), journal('2026-11-07'));
    const c = nonJouee(inspectWave(dir, 'cadence-l1', [{ ...L682, finished: '2026-11-12' }]));
    expect(c.planLot?.after).toBeUndefined();
    expect(c.proposal).toContain('raf add');
  });
});
