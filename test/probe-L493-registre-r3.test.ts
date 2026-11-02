import { describe, expect, it } from 'vitest';
import { acquireSlot, addHold, liveSlots } from '../src/orchestrate/registry.js';
import { tempDir } from './helpers.js';

describe('probe L493 — R3 du registre : hold échu', () => {
  it('R3 — plusieurs holds échus ne retiennent rien (cap 2 : deux créneaux pris sans attente)', async () => {
    const home = tempDir();
    addHold(home, 'e1', 1, new Date(Date.now() - 3600_000));
    addHold(home, 'e2', 1, new Date(Date.now() - 7200_000));
    const a = await acquireSlot(home, 2, { wave: 'a', pollMs: 10 });
    const b = await acquireSlot(home, 2, { wave: 'b', pollMs: 10 });
    expect(liveSlots(home)).toHaveLength(2);
    a();
    b();
    expect(liveSlots(home)).toHaveLength(0);
  });

  it('R3 — un TTL de 0 minute (échu immédiatement) ne retient pas de créneau', async () => {
    const home = tempDir();
    addHold(home, 'zero', 0, new Date(Date.now() - 1000));
    const r = await acquireSlot(home, 1, { wave: 'a', pollMs: 10 });
    expect(liveSlots(home)).toHaveLength(1);
    r();
  });

  it('R3 — un hold encore vivant retient, alors qu\'un échu à côté ne retient pas (cap 2)', async () => {
    const home = tempDir();
    addHold(home, 'vivant', 60, new Date());
    addHold(home, 'echu', 1, new Date(Date.now() - 3600_000));
    const a = await acquireSlot(home, 2, { wave: 'a', pollMs: 10 });
    let got = false;
    const p = acquireSlot(home, 2, { wave: 'b', pollMs: 10 }).then((r) => { got = true; return r; });
    await new Promise((r) => setTimeout(r, 80));
    expect(got).toBe(false); // 1 session + 1 hold vivant = 2/2
    a();
    (await p)();
  });

  it('R3 — la release appelée deux fois ne casse pas le registre', async () => {
    const home = tempDir();
    addHold(home, 'vieille', 10, new Date(Date.now() - 3600_000));
    const r = await acquireSlot(home, 1, { wave: 'a', pollMs: 10 });
    r();
    expect(() => r()).not.toThrow();
    expect(liveSlots(home)).toHaveLength(0);
  });
});
