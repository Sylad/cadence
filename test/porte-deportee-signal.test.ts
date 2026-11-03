import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestrateConfig } from '../src/config.js';
import { fakeRemote } from './fake-ssh.js';
import { cleanupTempDirs } from './helpers.js';
import { git as hgit, harness } from './orchestrate-harness.js';

// Les signaux ne se testent pas dans le processus du test : les nettoyages inscrits sont capturés puis joués à la main, comme le ferait le gestionnaire de signal.
const registered = vi.hoisted(() => new Set<(sig: NodeJS.Signals) => void | Promise<void>>());
vi.mock('../src/proc.js', async (orig) => ({
  ...(await orig<typeof import('../src/proc.js')>()),
  onTermination: (f: (sig: NodeJS.Signals) => void | Promise<void>) => {
    registered.add(f);
    return () => registered.delete(f);
  },
}));
const { withPlace } = await import('../src/orchestrate/gate-place.js');

afterEach(() => {
  registered.clear();
  cleanupTempDirs();
});

const alive = (pattern: string): boolean => {
  try {
    execFileSync('pgrep', ['-f', pattern], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('L403 — signal pendant la porte déportée (R10, R19)', () => {
  it('R19 — vague, signal pendant la porte d\'un lot : la commande distante est arrêtée et le worktree retiré', async () => {
    const remote = fakeRemote();
    const h = harness();
    const env = { ...process.env, ...remote.env };
    // L555 : marqueur propre à ce processus de test (pgrep -f voit toute la machine, dont les sessions de vague parallèles), ancré en fin de ligne
    const marker = `sleep 31337.${process.pid}`;
    const pattern = `sleep 31337\\.${process.pid}$`;
    const run = withPlace({ config: { gate: { host: 'machine' }, test: marker } as OrchestrateConfig, repo: h.repo, sha: hgit(h.repo, 'rev-parse', 'HEAD'), dir: h.repo, needClean: false, label: 'porte du lot L1', local: async () => ({ code: 0, output: '' }), say: () => {}, env }, async (place) => {
      await place.run(marker);
    });
    const wt = join(remote.home, '.cadence-gate', h.repo.split('/').pop()!, 'wt');
    for (let i = 0; i < 100 && !alive(pattern); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(pattern)).toBe(true);
    expect(registered.size).toBeGreaterThan(0);
    await Promise.all([...registered].map((f) => f('SIGTERM')));
    await run;
    // l'arrêt du groupe n'est pas instantané sous charge : jusqu'à 10 s au dernier processus pour disparaître
    for (let t = 0; t < 10_000 && alive(pattern); t += 100) await new Promise((r) => setTimeout(r, 100));
    expect(alive(pattern)).toBe(false);
    expect(existsSync(wt) ? readdirSync(wt) : []).toEqual([]);
    expect(registered.size).toBe(0);
  }, 30_000);
});
