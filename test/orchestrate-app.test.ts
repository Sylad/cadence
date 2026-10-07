import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { startApp } from '../src/orchestrate/app.js';
import { fakeApp } from './fake-app.js';

const setup = fakeApp;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidOf = (dir: string) => Number(readFileSync(join(dir, 'pid'), 'utf8'));

describe('application de la revue UX lancée par le programme (L60)', () => {
  it('prête : lancée depuis cwd, sortie dans le journal, puis tuée à stop', async () => {
    const t = await setup(300);
    const app = await startApp({ command: t.command, url: t.url, cwd: t.dir, log: t.log, timeoutMs: 15_000, every: 50 });
    expect(app.state).toEqual({ kind: 'ready' });
    expect(realpathSync(readFileSync(join(t.dir, 'cwd'), 'utf8'))).toBe(realpathSync(t.dir));
    expect(readFileSync(t.log, 'utf8')).toContain('démarrage du faux serveur');
    const pid = pidOf(t.dir);
    expect(alive(pid)).toBe(true);
    await app.stop();
    expect(alive(pid)).toBe(false);
  });

  it('un statut 4xx est une réponse, un 5xx n\'en est pas une', async () => {
    const ok = await setup(0, { status: 404 });
    const a = await startApp({ command: ok.command, url: ok.url, cwd: ok.dir, log: ok.log, timeoutMs: 15_000, every: 50 });
    expect(a.state).toEqual({ kind: 'ready' });
    await a.stop();
    const ko = await setup(0, { status: 503 });
    const b = await startApp({ command: ko.command, url: ko.url, cwd: ko.dir, log: ko.log, timeoutMs: 800, every: 50 });
    expect(b.state.kind).toBe('unverified');
  });

  it('jamais prête : non vérifiée avec la fin du journal, et le groupe est déjà tué', async () => {
    const t = await setup(-1);
    const app = await startApp({ command: t.command, url: t.url, cwd: t.dir, log: t.log, timeoutMs: 800, every: 50 });
    expect(app.state.kind).toBe('unverified');
    if (app.state.kind !== 'unverified') return;
    expect(app.state.cause).toContain('démarrage du faux serveur');
    expect(app.state.cause).toContain('n\'a pas répondu');
    expect(alive(pidOf(t.dir))).toBe(false);
  });

  it('la commande s\'arrête avant de répondre : non vérifiée sans attendre le délai', async () => {
    const t = await setup(0);
    const t0 = Date.now();
    const app = await startApp({ command: 'echo boum; exit 3', url: t.url, cwd: t.dir, log: t.log, timeoutMs: 20_000, every: 50 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(app.state.kind === 'unverified' && app.state.cause).toMatch(/code 3[\s\S]*boum/);
  });

  it('port déjà pris : rien n\'est lancé', async () => {
    const t = await setup(0);
    const srv: Server = createServer((_q, r) => r.end('autre')).listen(Number(new URL(t.url).port));
    await new Promise((r) => srv.once('listening', r));
    try {
      const app = await startApp({ command: t.command, url: t.url, cwd: t.dir, log: t.log, timeoutMs: 2_000, every: 50 });
      expect(app.state).toEqual({ kind: 'busy' });
      expect(existsSync(join(t.dir, 'pid'))).toBe(false);
      expect(existsSync(t.log)).toBe(false);
    } finally {
      srv.close();
    }
  });

  it('un enfant qui survit au SIGTERM est tué par le SIGKILL', async () => {
    const t = await setup(0, { stubborn: true });
    const app = await startApp({ command: t.command, url: t.url, cwd: t.dir, log: t.log, timeoutMs: 15_000, every: 50, killAfterMs: 400 });
    expect(app.state).toEqual({ kind: 'ready' });
    const pid = pidOf(t.dir);
    const t0 = Date.now();
    await app.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(alive(pid)).toBe(false);
  });

  it('la commande porte ses préfixes (cd x && PORT=… …)', async () => {
    const t = await setup(0, { prefix: 'cd sub && PORT=1 ' });
    mkdirSync(join(t.dir, 'sub'));
    const app = await startApp({ command: t.command, url: t.url, cwd: t.dir, log: t.log, timeoutMs: 15_000, every: 50 });
    expect(app.state).toEqual({ kind: 'ready' });
    expect(realpathSync(readFileSync(join(t.dir, 'cwd'), 'utf8'))).toBe(realpathSync(join(t.dir, 'sub')));
    await app.stop();
  });
});

describe('signal de la vague (L60)', () => {
  it('stopApps arrête les applications en cours : SIGTERM, puis SIGKILL de celle qui l\'ignore', async () => {
    const { stopApps } = await import('../src/orchestrate/app.js');
    const t = await setup(0, { stubborn: true });
    const app = await startApp({ command: t.command, url: t.url, cwd: t.dir, log: t.log, timeoutMs: 15_000, every: 50, killAfterMs: 400 });
    expect(app.state).toEqual({ kind: 'ready' });
    const pid = pidOf(t.dir);
    await stopApps();
    expect(alive(pid)).toBe(false);
    await app.stop(); // déjà arrêtée : sans effet
  });
});
