import { describe, expect, it } from 'vitest';
import { measureWave, parseJournal, inspectWave, renderInspection } from '../src/inspect.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.js';

// L644 — attente d'intégration différée : `cadence inspect` la compte en « attente de ressource », la retranche de la revue et des minutes actives, l'affiche en cause avec le lot qui tient la ressource.

const at = (min: number, text: string, sec = 0) => `2026-11-06T09:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.000Z ${text}`;
const DIFFEREE = (holder = 'cadence:L2', resource = 'cycle-ts') => `cadence:L1 intégration différée : ${holder} touche la ressource « ${resource} » (src/orchestrate/cycle)`;
const journal = (...lines: string[]) => `${lines.join('\n')}\n`;
const measure = (...lines: string[]) => measureWave(parseJournal(journal(...lines)));

describe('inspect (L644) — attente de ressource', () => {
  it("la ligne « intégration différée » est une attente de ressource de la reprise (→) à l'intégré, retranchée de la revue", () => {
    const m = measure(at(0, 'cadence:L1 → reviewing'), at(10, DIFFEREE()), at(30, 'cadence:L1 intégré : aaa..bbb'), at(31, 'cadence:L1 → ready — prêt'));
    const lot = m.lots.find((l) => l.lot === 'cadence:L1')!;
    expect(lot.states['attente de ressource']).toBe(20);
    expect(lot.states.reviewing).toBe(11);
    expect(m.losses).toContainEqual({ lot: 'cadence:L1', category: 'attente de ressource', cause: 'ressource « cycle-ts »', minutes: 20, level: null, holders: ['cadence:L2'] });
  });

  it("l'attente prend fin à la reprise du lot (transition), pas au-delà", () => {
    const m = measure(at(0, 'cadence:L1 → reviewing'), at(5, DIFFEREE()), at(15, 'cadence:L1 → fixing'), at(25, 'cadence:L1 → ready'));
    const lot = m.lots[0]!;
    expect(lot.states['attente de ressource']).toBe(10);
    expect(lot.states.reviewing).toBe(5);
    expect(lot.states.fixing).toBe(10);
  });

  it("une attente sans fin dans le journal court jusqu'à la dernière ligne de la vague", () => {
    const m = measure(at(0, 'cadence:L1 → reviewing'), at(10, DIFFEREE()), at(40, 'cadence:L9 → implementing'));
    expect(m.lots.find((l) => l.lot === 'cadence:L1')!.states['attente de ressource']).toBe(30);
  });

  it("deux lignes différées dans la même attente (deux lots qui tiennent) : une seule attente, les deux lots cités", () => {
    const m = measure(at(0, 'cadence:L1 → reviewing'), at(10, DIFFEREE('cadence:L2')), at(15, DIFFEREE('cadence:L3', 'docs')), at(20, 'cadence:L1 intégré : a..b'));
    const waits = m.losses.filter((l) => l.category === 'attente de ressource');
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ minutes: 10, holders: ['cadence:L2', 'cadence:L3'] });
  });

  it('deux attentes du même lot (avant et après une correction) sont deux pertes', () => {
    const m = measure(at(0, 'cadence:L1 → reviewing'), at(2, DIFFEREE()), at(4, 'cadence:L1 → fixing'), at(6, 'cadence:L1 → reviewing'), at(7, DIFFEREE()), at(10, 'cadence:L1 intégré : a..b'));
    expect(m.losses.filter((l) => l.category === 'attente de ressource').map((l) => l.minutes)).toEqual([2, 3]);
  });

  it('une ligne différée sans transition avant elle compte l\'attente sans rien retrancher', () => {
    const m = measure(at(10, DIFFEREE()), at(14, 'cadence:L1 intégré : a..b'));
    expect(m.lots[0]!.states).toEqual({ 'attente de ressource': 4 });
  });

  it('une attente de zéro minute ne laisse pas de perte', () => {
    const m = measure(at(0, 'cadence:L1 → reviewing'), at(5, DIFFEREE()), at(5, 'cadence:L1 intégré : a..b'));
    expect(m.losses.filter((l) => l.category === 'attente de ressource')).toEqual([]);
  });

  it("une attente n'est pas du temps actif : elle sort des minutes actives de la vague", () => {
    const root = tempDir();
    mkdirSync(join(root, '2026-11-06-0900'), { recursive: true });
    writeFileSync(join(root, '2026-11-06-0900', 'journal.log'), journal(at(0, 'cadence:L1 → reviewing'), at(10, DIFFEREE()), at(30, 'cadence:L1 intégré : a..b'), at(30, 'cadence:L1 → ready')));
    const i = inspectWave(root, '2026-11-06-0900', []);
    expect(i.totalMinutes).toBe(10);
    expect(i.lostMinutes).toBe(20);
  });

  it("le tableau affiche la cause avec le lot qui tient la ressource", () => {
    const root = tempDir();
    mkdirSync(join(root, '2026-11-06-0900'), { recursive: true });
    writeFileSync(join(root, '2026-11-06-0900', 'journal.log'), journal(at(0, 'cadence:L1 → reviewing'), at(10, DIFFEREE()), at(30, 'cadence:L1 intégré : a..b')));
    const text = renderInspection(inspectWave(root, '2026-11-06-0900', [])).join('\n');
    expect(text).toContain('attente de ressource · ressource « cycle-ts » : 20 min, 1 fois, 1 lot(s)');
    expect(text).toContain('tenue par cadence:L2');
  });
});
