import { describe, expect, it } from 'vitest';
import { reconnaitreQuota } from '../src/run/quota.js';

// D-15 : en claude -p, la fin de quota ne se reconnaît qu'au texte du résultat. Heure de référence : mercredi 11-11-2026 17:00 à Paris (16:00 UTC).
const MAINTENANT = new Date('2026-11-11T16:00:00Z');

describe('reconnaitreQuota', () => {
  it('limite hebdo avec jour, heure et fuseau : reprise au prochain jour dit, dans ce fuseau', () => {
    expect(reconnaitreQuota("You've hit your weekly limit · resets Thu 9am (Europe/Paris)", MAINTENANT))
      .toEqual({ limite: 'hebdo', reprise: '2026-11-12T08:00:00.000Z', texte: "You've hit your weekly limit · resets Thu 9am (Europe/Paris)" });
  });

  it('limite hebdo, même jour de la semaine mais heure passée : la semaine suivante', () => {
    expect(reconnaitreQuota("You've hit your weekly limit · resets Wed 9am (Europe/Paris)", MAINTENANT)?.reprise).toBe('2026-11-18T08:00:00.000Z');
  });

  it('limite hebdo avec mois et jour, minutes et fuseau UTC', () => {
    expect(reconnaitreQuota("You’ve hit your weekly limit · resets Nov 14, 5:30pm (UTC)", MAINTENANT)?.reprise).toBe('2026-11-14T17:30:00.000Z');
  });

  it('limite hebdo avec seulement une heure : aujourd hui si elle est à venir, sinon demain', () => {
    expect(reconnaitreQuota("You've hit your weekly limit · resets 8pm (Europe/Paris)", MAINTENANT)?.reprise).toBe('2026-11-11T19:00:00.000Z');
    expect(reconnaitreQuota("You've hit your weekly limit · resets 9am (Europe/Paris)", MAINTENANT)?.reprise).toBe('2026-11-12T08:00:00.000Z');
  });

  it('heure sur 24 h et jour en toutes lettres', () => {
    expect(reconnaitreQuota("You've hit your weekly limit · resets Saturday 21:00 (Europe/Paris)", MAINTENANT)?.reprise).toBe('2026-11-14T20:00:00.000Z');
  });

  it('limite Opus, avec ou sans heure de reprise', () => {
    expect(reconnaitreQuota("You've hit your Opus limit · resets Fri 10am (Europe/Paris)", MAINTENANT)).toMatchObject({ limite: 'opus', reprise: '2026-11-13T09:00:00.000Z' });
    expect(reconnaitreQuota("You've hit your Opus limit", MAINTENANT)).toMatchObject({ limite: 'opus', reprise: null });
  });

  it('revue L700 r1 (D-18) : le jour de la semaine n est jamais lu dans le nom du fuseau', () => {
    // Montevideo, Monaco contiennent « mon », Thunder_Bay « thu » : la reprise est la prochaine 9 h, jeudi 12-11, pas lundi ni la semaine suivante
    expect(reconnaitreQuota("You've hit your weekly limit · resets 9am (America/Montevideo)", MAINTENANT)?.reprise).toBe('2026-11-12T12:00:00.000Z');
    expect(reconnaitreQuota("You've hit your weekly limit · resets 9am (Europe/Monaco)", MAINTENANT)?.reprise).toBe('2026-11-12T08:00:00.000Z');
    expect(reconnaitreQuota("You've hit your weekly limit · resets 8pm (America/Thunder_Bay)", MAINTENANT)?.reprise).toBe('2026-11-12T01:00:00.000Z');
    // un jour dit hors de la parenthèse reste lu
    expect(reconnaitreQuota("You've hit your weekly limit · resets Fri 9am (America/Montevideo)", MAINTENANT)?.reprise).toBe('2026-11-13T12:00:00.000Z');
  });

  it('heure de reprise illisible : quota reconnu, reprise inconnue', () => {
    expect(reconnaitreQuota("You've hit your weekly limit · resets soon", MAINTENANT)).toMatchObject({ limite: 'hebdo', reprise: null });
  });

  it('un résultat ordinaire, ou qui cite le message au milieu d un compte rendu, n est pas un quota', () => {
    expect(reconnaitreQuota('fini', MAINTENANT)).toBeNull();
    expect(reconnaitreQuota('', MAINTENANT)).toBeNull();
    expect(reconnaitreQuota("J'ai ajouté la reconnaissance de « You've hit your weekly limit · resets Thu 9am » au module.\nfini", MAINTENANT)).toBeNull();
  });
});
