import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SNAPSHOT_AGE_MS, readPsProcs, TreeTracker } from '../src/proc.js';

type Procs = NonNullable<ReturnType<typeof readPsProcs>>;
const table = (...rows: [pid: number, ppid: number, start: string][]): Procs =>
  new Map(rows.map(([pid, ppid, start]) => [pid, { ppid, start, zombie: false }]));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('TreeTracker — pid repris', () => {
  it('un pid réutilisé (autre heure de démarrage) n\'est ni suivi, ni vivant, ni signalé', () => {
    let procs = table([100, 1, 'A'], [200, 100, 'X']);
    const tracker = new TreeTracker(100, () => procs);
    tracker.stop();
    expect(tracker.alive()).toEqual([100, 200]);

    // 200 est mort, son pid est repris par un autre processus ; 100 est mort, son pid repris lui aussi, avec un enfant
    procs = table([100, 1, 'B'], [200, 1, 'Y'], [300, 100, 'Z'], [400, 200, 'W']);
    expect(tracker.alive()).toEqual([]);
    expect(tracker.scan().has(300)).toBe(true); // présent dans le relevé…
    expect(tracker.alive()).toEqual([]); // …mais jamais suivi : son parent n'est pas celui qu'on suivait

    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    tracker.kill();
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('TreeTracker — relevé indisponible (ps en échec)', () => {
  it('scan et alive ne lèvent pas : le dernier relevé fait foi', () => {
    let procs: Procs | null = table([100, 1, 'A'], [200, 100, 'X']);
    const tracker = new TreeTracker(100, () => procs);
    tracker.stop();
    tracker.scan();
    procs = null;
    expect(() => tracker.scan()).not.toThrow();
    expect(tracker.alive()).toEqual([100, 200]);
  });

  it('kill : un relevé qui échoue après le SIGSTOP ne laisse aucun processus arrêté', () => {
    let procs: Procs | null = table([100, 1, 'A'], [200, 100, 'X']);
    const tracker = new TreeTracker(100, () => procs);
    tracker.stop();
    const sent: [number, unknown][] = [];
    vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      sent.push([pid, sig]);
      procs = null; // ps tombe dès le premier signal
      return true;
    });
    expect(() => tracker.kill()).not.toThrow();
    for (const pid of [100, 200]) expect(sent).toContainEqual([pid, 'SIGKILL']);
  });

  it('kill : même si le relevé lève, ce qui est arrêté est tué et rien ne remonte', () => {
    let calls = 0;
    const tracker = new TreeTracker(100, () => {
      if (++calls > 3) throw new Error('boom');
      return table([100, 1, 'A']);
    });
    tracker.stop();
    const sent: [number, unknown][] = [];
    vi.spyOn(process, 'kill').mockImplementation((pid, sig) => (sent.push([pid, sig]), true));
    expect(() => tracker.kill()).not.toThrow();
    expect(sent).toContainEqual([100, 'SIGKILL']);
  });

  it('readPsProcs rend null quand ps échoue', () => {
    expect(
      readPsProcs(() => {
        throw new Error('ps: introuvable');
      }),
    ).toBeNull();
  });
});

describe('TreeTracker — relevé indisponible dès la construction', () => {
  it('kill : repli sur le groupe de la commande et sur sa racine', () => {
    const tracker = new TreeTracker(100, () => null);
    tracker.stop();
    const sent: [number, unknown][] = [];
    vi.spyOn(process, 'kill').mockImplementation((pid, sig) => (sent.push([pid, sig]), true));
    expect(() => tracker.kill()).not.toThrow();
    expect(sent).toContainEqual([-100, 'SIGKILL']);
    expect(sent).toContainEqual([100, 'SIGKILL']);
    expect(sent.every(([pid]) => pid !== 0 && Math.abs(pid) !== process.pid)).toBe(true);
  });

  it('kill : pas de repli quand la racine a été relevée (jamais le groupe de cadence)', () => {
    const tracker = new TreeTracker(100, () => table([100, 1, 'A']));
    tracker.stop();
    const sent: [number, unknown][] = [];
    vi.spyOn(process, 'kill').mockImplementation((pid, sig) => (sent.push([pid, sig]), true));
    tracker.kill();
    expect(sent.some(([pid]) => pid < 0)).toBe(false);
  });
});

describe('TreeTracker — relevé périmé (ps en échec prolongé)', () => {
  it('un pid repris pendant l\'échec de ps n\'est pas signalé d\'après le relevé périmé', () => {
    vi.useFakeTimers();
    let procs: Procs | null = table([100, 1, 'A'], [200, 100, 'X']);
    const tracker = new TreeTracker(100, () => procs);
    tracker.stop();
    tracker.scan();
    procs = null; // ps tombe : le dernier relevé n'est plus qu'un souvenir
    vi.advanceTimersByTime(MAX_SNAPSHOT_AGE_MS + 1);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(tracker.alive()).toEqual([]);
    tracker.kill();
    expect(kill).not.toHaveBeenCalled();
  });

  it('un échec bref garde le dernier relevé', () => {
    vi.useFakeTimers();
    let procs: Procs | null = table([100, 1, 'A'], [200, 100, 'X']);
    const tracker = new TreeTracker(100, () => procs);
    tracker.stop();
    procs = null;
    vi.advanceTimersByTime(MAX_SNAPSHOT_AGE_MS - 1);
    expect(tracker.alive()).toEqual([100, 200]);
  });
});

describe('TreeTracker — relevé indisponible signalé', () => {
  it('prévient une seule fois, au premier échec', () => {
    let procs: Procs | null = table([100, 1, 'A']);
    const warn = vi.fn();
    const tracker = new TreeTracker(100, () => procs, warn);
    tracker.stop();
    expect(warn).not.toHaveBeenCalled();
    procs = null;
    tracker.scan();
    tracker.scan();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('prévient aussi quand le relevé lève, dès la construction', () => {
    const warn = vi.fn();
    const tracker = new TreeTracker(100, () => { throw new Error('boom'); }, warn);
    tracker.stop();
    tracker.scan();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
