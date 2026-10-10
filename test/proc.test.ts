import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findMarked, killMarked, MAX_SNAPSHOT_AGE_MS, psEnvArgs, readPsProcs, SESSION_MARK_VAR, TreeTracker } from '../src/proc.js';

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
    const sent: [number, unknown][] = [];
    vi.spyOn(process, 'kill').mockImplementation((pid, sig) => (sent.push([pid, sig]), true));
    expect(tracker.alive()).toEqual([]);
    tracker.kill();
    expect(sent.some(([pid]) => pid === 200)).toBe(false); // le pid 200 a pu être repris : jamais signalé
  });

  it('ps durablement en panne : au délai, au moins la racine et son groupe sont tués', () => {
    vi.useFakeTimers();
    let procs: Procs | null = table([100, 1, 'A'], [200, 100, 'X']);
    const tracker = new TreeTracker(100, () => procs);
    tracker.stop();
    tracker.scan();
    procs = null;
    vi.advanceTimersByTime(MAX_SNAPSHOT_AGE_MS + 1);
    const sent: [number, unknown][] = [];
    vi.spyOn(process, 'kill').mockImplementation((pid, sig) => (sent.push([pid, sig]), true));
    tracker.kill();
    expect(sent).toContainEqual([-100, 'SIGKILL']);
    expect(sent).toContainEqual([100, 'SIGKILL']);
    expect(sent.every(([pid]) => pid !== 0 && Math.abs(pid) !== process.pid)).toBe(true);
  });

  it('ps rétabli : pas de repli, jamais le groupe de cadence', () => {
    let procs: Procs | null = null;
    const tracker = new TreeTracker(100, () => procs);
    tracker.stop();
    procs = table([100, 1, 'A']);
    const sent: [number, unknown][] = [];
    vi.spyOn(process, 'kill').mockImplementation((pid, sig) => (sent.push([pid, sig]), true));
    tracker.kill();
    expect(sent.some(([pid]) => pid < 0)).toBe(false);
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

describe('TreeTracker — end() sans racine relevée', () => {
  it('à l\'échéance de la grâce, le repli groupe + racine est appliqué', async () => {
    const tracker = new TreeTracker(100, () => null);
    tracker.stop();
    const sent: [number, unknown][] = [];
    vi.spyOn(process, 'kill').mockImplementation((pid, sig) => (sent.push([pid, sig]), true)); // la racine « vit » toujours
    await tracker.end(120);
    expect(sent).toContainEqual([-100, 'SIGKILL']);
    expect(sent).toContainEqual([100, 'SIGKILL']);
  });

  it('rend la main sans rien tuer quand la racine est déjà partie', async () => {
    const tracker = new TreeTracker(100, () => null);
    tracker.stop();
    const sent: [number, unknown][] = [];
    vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      sent.push([pid, sig]);
      throw new Error('ESRCH');
    });
    await tracker.end(5_000);
    expect(sent.some(([, sig]) => sig === 'SIGKILL')).toBe(false);
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

describe('TreeTracker — repli du kill signalé', () => {
  const mute = () => vi.spyOn(process, 'kill').mockImplementation(() => true);

  it('prévient quand kill() se rabat sur la racine faute de relevé (jamais relevée)', () => {
    mute();
    const blind = vi.fn();
    const tracker = new TreeTracker(100, () => null, () => {}, blind);
    tracker.kill();
    expect(blind).toHaveBeenCalledTimes(1);
  });

  it('prévient aussi quand le relevé tombe en panne après avoir réussi', () => {
    mute();
    let procs: Procs | null = table([100, 1, 'A']);
    const blind = vi.fn();
    const tracker = new TreeTracker(100, () => procs, () => {}, blind);
    procs = null;
    tracker.kill();
    expect(blind).toHaveBeenCalledTimes(1);
  });

  it('se tait quand le relevé est fiable, ou quand la racine est déjà sortie', () => {
    mute();
    const blind = vi.fn();
    const ok = new TreeTracker(100, () => table([100, 1, 'A']), () => {}, blind);
    ok.kill();
    const gone = new TreeTracker(100, () => null, () => {}, blind);
    gone.rootExited();
    gone.kill();
    expect(blind).not.toHaveBeenCalled();
  });

  it('un message qui lève ne casse pas le kill', () => {
    const sent = mute();
    const tracker = new TreeTracker(100, () => null, () => {}, () => { throw new Error('stderr fermé'); });
    expect(() => tracker.kill()).not.toThrow();
    expect(sent).toHaveBeenCalledWith(100, 'SIGKILL');
  });
});

describe('TreeTracker — racine sortie', () => {
  it('une racine relevée après sa sortie (pid repris) n\'est ni adoptée ni signalée', async () => {
    let procs: Procs | null = null;
    const tracker = new TreeTracker(100, () => procs);
    tracker.stop();
    tracker.rootExited(); // la commande est sortie : son pid peut être repris
    procs = table([100, 1, 'AUTRE']); // ps revient, un autre processus porte le pid 100
    const sent: [number, unknown][] = [];
    vi.spyOn(process, 'kill').mockImplementation((pid, sig) => (sent.push([pid, sig]), true));
    expect(tracker.alive()).toEqual([]);
    await tracker.end(120);
    tracker.kill();
    expect(sent).toEqual([]);
  });

  it('la racine relevée tard avant sa sortie est toujours adoptée', () => {
    let procs: Procs | null = null;
    const tracker = new TreeTracker(100, () => procs);
    tracker.stop();
    procs = table([100, 1, 'A']);
    expect(tracker.alive()).toEqual([100]);
  });
});

describe('findMarked — repli sans /proc (macOS)', () => {
  const NO_PROC = '/nonexistent-proc-dir';
  const fakePs = (out: string) => {
    const calls: [string, readonly string[]][] = [];
    const run = ((cmd: string, args: readonly string[]) => (calls.push([cmd, args]), out)) as unknown as typeof execFileSync;
    return { run, calls };
  };

  it('trouve le processus marqué dans la sortie de ps, ignore celui qui ne l\'est pas ni la marque d\'une autre session', () => {
    const { run, calls } = fakePs(
      [
        '  101 1 node server.js PATH=/usr/bin CADENCE_SESSION=s1 HOME=/Users/x',
        '  102 1 node other.js PATH=/usr/bin HOME=/Users/x',
        '  103 1 sleep 9 CADENCE_SESSION=s10 HOME=/Users/x',
        '  104 1 sh CADENCE_SESSION=s1',
        '  105 1 grep XCADENCE_SESSION=s1',
        `  ${process.pid} 1 node cadence CADENCE_SESSION=s1`,
        '',
      ].join('\n'),
    );
    expect(findMarked('s1', { procRoot: NO_PROC, run, platform: 'darwin' })).toEqual([101, 104]);
    expect(calls).toEqual([['ps', ['-axEww', '-o', 'pid=,ppid=,command=']]]);
  });

  it("(L83/t1) un démon partagé (tmux, screen, gpg-agent) et ce qui descend de lui ne sont pas tués, même marqués ; un autre processus marqué l'est", () => {
    const { run } = fakePs(
      [
        '  201 1 tmux: server CADENCE_SESSION=s1',
        '  202 201 -bash CADENCE_SESSION=s1',
        '  203 202 vim CADENCE_SESSION=s1',
        '  204 1 /usr/bin/screen -dmS x CADENCE_SESSION=s1',
        '  205 1 gpg-agent --daemon CADENCE_SESSION=s1',
        '  206 1 node dev-server.js CADENCE_SESSION=s1',
        '  207 206 sh -c tmuxinator CADENCE_SESSION=s1',
        '',
      ].join('\n'),
    );
    expect(findMarked('s1', { procRoot: NO_PROC, run, platform: 'linux' })).toEqual([206, 207]);
  });

  it("(L83/t1) un tmux qui ne porte pas la marque (celui du lead, où tourne cadence) n'épargne rien : ses descendants marqués sont trouvés", () => {
    const { run } = fakePs(
      [
        '  201 1 tmux: server',
        '  202 201 -bash',
        '  203 202 node cadence',
        '  204 203 node dev-server.js CADENCE_SESSION=s1',
        '  205 1 sleep 30 CADENCE_SESSION=s1',
        '',
      ].join('\n'),
    );
    expect(findMarked('s1', { procRoot: NO_PROC, run, platform: 'linux' })).toEqual([204, 205]);
  });

  it("(L83/t1) avec /proc : un serveur tmux démarré par la session et son panneau sont épargnés, le serveur de dev voisin est trouvé", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cadence-shared-'));
    const mark = `test-${process.pid}-${Date.now()}`;
    const env = { ...process.env, [SESSION_MARK_VAR]: mark };
    // un exécutable nommé « tmux » (comm = nom du fichier exécuté) dont l'enfant hérite de la marque
    symlinkSync('/bin/sh', join(dir, 'tmux'));
    const server = spawn(join(dir, 'tmux'), ['-c', 'sleep 30 & wait'], { env, stdio: 'ignore', detached: true });
    const dev = spawn('sleep', ['30'], { env, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(findMarked(mark)).toEqual([dev.pid]);
    } finally {
      process.kill(-server.pid!, 'SIGKILL'); // son groupe : le shell et son enfant sleep
      dev.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ps absent ou en échec : rien à tuer, pas d\'exception', () => {
    const run = (() => {
      throw new Error('ENOENT');
    }) as unknown as typeof execFileSync;
    expect(findMarked('s1', { procRoot: NO_PROC, run, platform: 'darwin' })).toEqual([]);
  });

  it('ps en échec : le relevé impossible est signalé (les orphelins marqués ont pu survivre)', () => {
    const run = (() => {
      throw new Error('ENOENT');
    }) as unknown as typeof execFileSync;
    const warn = vi.fn();
    findMarked('s1', { procRoot: NO_PROC, run, platform: 'linux', onUnavailable: warn });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('killMarked signale une seule fois un relevé impossible', () => {
    const warn = vi.fn();
    const run = (() => {
      throw new Error('ENOENT');
    }) as unknown as typeof execFileSync;
    killMarked('s1', { procRoot: NO_PROC, run, onUnavailable: warn });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('un relevé réussi ne signale rien', () => {
    const warn = vi.fn();
    const run = (() => '') as unknown as typeof execFileSync;
    findMarked('s1', { procRoot: NO_PROC, run, platform: 'linux', onUnavailable: warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('l\'option de ps qui affiche l\'environnement dépend de la plateforme : -E sur macOS (BSD), e sur Linux (procps)', () => {
    expect(psEnvArgs('darwin')).toEqual(['-axEww', '-o', 'pid=,ppid=,command=']);
    expect(psEnvArgs('linux')).toEqual(['axeww', '-o', 'pid=,ppid=,command=']);
  });

  it('le vrai ps de cet hôte voit l\'environnement d\'un processus marqué, et pas celui d\'une autre session', async () => {
    const mark = `test-${process.pid}-${Date.now()}`;
    const child = spawn('sleep', ['30'], { env: { ...process.env, [SESSION_MARK_VAR]: mark }, stdio: 'ignore' });
    const other = spawn('sleep', ['30'], { env: { ...process.env, [SESSION_MARK_VAR]: `${mark}-autre` }, stdio: 'ignore' });
    try {
      const found = findMarked(mark, { procRoot: NO_PROC });
      expect(found).toEqual([child.pid]);
    } finally {
      child.kill('SIGKILL');
      other.kill('SIGKILL');
    }
  });
});
