import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { startApp, takeUrlLock, uxLockFile } from '../src/orchestrate/app.js';
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

describe('verrou par hôte:port de l\'URL (L60)', () => {
  const opts = (t: Awaited<ReturnType<typeof fakeApp>>, timeoutMs = 15_000) => ({ command: t.command, url: t.url, cwd: t.dir, log: t.log, timeoutMs, every: 50, killAfterMs: 400 });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('le nom du verrou suit hôte et port ; le verrou est rendu après l\'arrêt, après « port occupé » et après un échec', async () => {
    expect(uxLockFile('http://127.0.0.1:4200/x')).toMatch(/cadence-ux-4200\.lock$/);
    for (const h of ['localhost', '127.0.0.1', '[::1]']) expect(basename(uxLockFile(`http://${h}:4200/`))).toBe('cadence-ux-4200.lock');
    expect(basename(uxLockFile('http://localhost/'))).toBe('cadence-ux-80.lock');
    expect(uxLockFile('http://example.org:4200/')).toMatch(/cadence-ux-example\.org-4200\.lock$/);
    expect(uxLockFile('https://example.org/')).toMatch(/cadence-ux-example\.org-443\.lock$/);
    const t = await fakeApp(0);
    const lock = uxLockFile(t.url);
    const app = await startApp(opts(t));
    expect(app.state).toEqual({ kind: 'ready' });
    expect(readFileSync(lock, 'utf8').trim()).toBe(String(process.pid));
    await app.stop();
    expect(existsSync(lock)).toBe(false);

    const dead = await fakeApp(-1);
    const bad = await startApp(opts(dead, 600));
    expect(bad.state.kind).toBe('unverified');
    expect(existsSync(uxLockFile(dead.url))).toBe(false);

    const busy = await fakeApp(0);
    const srv: Server = createServer((_q, r) => r.end('autre')).listen(busy.port);
    await new Promise((r) => srv.once('listening', r));
    try {
      expect((await startApp(opts(busy))).state).toEqual({ kind: 'busy' });
      expect(existsSync(uxLockFile(busy.url))).toBe(false);
    } finally {
      srv.close();
    }
  });

  it('un verrou d\'un pid mort est repris', async () => {
    const t = await fakeApp(0);
    const gone = spawnSync('true');
    // pid d'un processus terminé : on prend un pid qui ne vit plus
    const pid = (gone.pid as number) || 999_999;
    writeFileSync(uxLockFile(t.url), String(pid));
    const app = await startApp(opts(t));
    expect(app.state).toEqual({ kind: 'ready' });
    expect(readFileSync(uxLockFile(t.url), 'utf8').trim()).toBe(String(process.pid));
    await app.stop();
  });

  it('reprise d\'un verrou périmé : atomique, un seul porteur, rien ne traîne', async () => {
    const t = await fakeApp(0);
    const lock = uxLockFile(t.url);
    const gone = spawnSync('true').pid as number;
    writeFileSync(lock, String(gone));
    expect(takeUrlLock(lock, process.ppid)).toBe(true);
    expect(readFileSync(lock, 'utf8')).toBe(String(process.ppid));
    expect(takeUrlLock(lock, process.pid)).toBe(false); // le porteur vit : le verrou reste à lui
    expect(readFileSync(lock, 'utf8')).toBe(String(process.ppid));
    const leftovers = readdirSync(dirname(lock)).filter((f) => f.startsWith(basename(lock) + '.'));
    expect(leftovers).toEqual([]);
    rmSync(lock, { force: true });
  });

  it('même URL, deux lots : le second attend l\'arrêt du premier, sans rien lancer, puis démarre', async () => {
    const a = await fakeApp(0);
    const b = await fakeApp(0, { port: a.port });
    const first = await startApp(opts(a));
    expect(first.state).toEqual({ kind: 'ready' });
    const second = startApp(opts(b));
    await sleep(500);
    expect(existsSync(join(b.dir, 'pid'))).toBe(false);
    await first.stop();
    const run = await second;
    expect(run.state).toEqual({ kind: 'ready' });
    await run.stop();
  });

  it('même URL tenue au-delà du délai : non vérifiée « url tenue par une autre vague », rien lancé, le détenteur intact', async () => {
    const a = await fakeApp(0);
    const b = await fakeApp(0, { port: a.port });
    const first = await startApp(opts(a));
    const second = await startApp(opts(b, 700));
    expect(second.state.kind === 'unverified' && second.state.cause).toContain('url tenue par une autre vague');
    expect(existsSync(join(b.dir, 'pid'))).toBe(false);
    expect(alive(pidOf(a.dir))).toBe(true);
    expect(readFileSync(uxLockFile(a.url), 'utf8').trim()).toBe(String(process.pid));
    await first.stop();
  });

  it('deux processus sur la même URL : celui qui n\'a pas le verrou attend la fin de l\'autre', async () => {
    const pkg = process.env.CADENCE_TEST_PACKAGE as string;
    const a = await fakeApp(0);
    const b = await fakeApp(0, { port: a.port });
    const script = `
      import { startApp } from ${JSON.stringify(join(pkg, 'dist/orchestrate/app.js'))};
      const o = JSON.parse(process.argv[1]);
      const app = await startApp(o);
      console.log(JSON.stringify(app.state));
      process.stdin.on('data', async () => { await app.stop(); process.exit(0); });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(opts(a))], { stdio: ['pipe', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((r, j) => {
        child.stdout.once('data', (d) => (String(d).includes('ready') ? r() : j(new Error(String(d)))));
        child.once('exit', () => j(new Error('le processus fils s\'est arrêté')));
      });
      expect(readFileSync(uxLockFile(a.url), 'utf8').trim()).toBe(String(child.pid));
      const second = startApp(opts(b));
      await sleep(500);
      expect(existsSync(join(b.dir, 'pid'))).toBe(false);
      child.stdin.write('stop\n');
      const run = await second;
      expect(run.state).toEqual({ kind: 'ready' });
      expect(readFileSync(uxLockFile(a.url), 'utf8').trim()).toBe(String(process.pid));
      await run.stop();
      expect(existsSync(uxLockFile(a.url))).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('prête seulement si le groupe lancé vit encore quand l\'URL répond', async () => {
    const t = await fakeApp(0);
    // la commande s'arrête aussitôt ; un autre serveur prend l'URL après le 1er sondage
    const other: Server = createServer((_q, r) => r.end('autre'));
    const timer = setTimeout(() => other.listen(t.port), 100);
    try {
      const app = await startApp({ ...opts(t), command: 'exit 0', every: 400 });
      expect(app.state.kind).toBe('unverified');
    } finally {
      clearTimeout(timer);
      other.close();
    }
  });

  it('verrou vide (pose en cours) : respecté tant qu\'il est récent, volé au bout de 5 s', async () => {
    const t = await fakeApp(0);
    const lock = uxLockFile(t.url);
    writeFileSync(lock, '');
    const waiting = await startApp({ ...opts(t), timeoutMs: 600 });
    expect(waiting.state.kind === 'unverified' && waiting.state.cause).toContain('url tenue par une autre vague');
    expect(existsSync(join(t.dir, 'pid'))).toBe(false);
    const old = new Date(Date.now() - 6_000);
    utimesSync(lock, old, old);
    const app = await startApp(opts(t));
    expect(app.state).toEqual({ kind: 'ready' });
    await app.stop();
  });

  it('verrou obtenu après le délai : rien n\'est lancé, verrou rendu, « url tenue par une autre vague »', async () => {
    const t = await fakeApp(0);
    const lock = uxLockFile(t.url);
    writeFileSync(lock, String(process.pid));
    const timer = setTimeout(() => rmSync(lock, { force: true }), 100); // rendu avant le délai, mais repris après : la sonde suivante tombe à 1 s
    try {
      const app = await startApp({ ...opts(t), timeoutMs: 400, every: 1_000 });
      expect(app.state.kind === 'unverified' && app.state.cause).toContain('url tenue par une autre vague');
      expect(existsSync(join(t.dir, 'pid'))).toBe(false);
      expect(existsSync(lock)).toBe(false);
    } finally {
      clearTimeout(timer);
    }
  });

  it('délai dépassé après une attente du verrou : le message annonce le délai restant, pas le délai complet', async () => {
    const t = await fakeApp(-1);
    const lock = uxLockFile(t.url);
    writeFileSync(lock, String(process.pid));
    const timer = setTimeout(() => rmSync(lock, { force: true }), 2_000);
    try {
      const app = await startApp({ ...opts(t), timeoutMs: 3_000 });
      expect(app.state.kind).toBe('unverified');
      if (app.state.kind !== 'unverified') return;
      expect(app.state.cause).toContain('n\'a pas répondu en 1 s');
      expect(app.state.cause).not.toContain('en 3 s');
    } finally {
      clearTimeout(timer);
    }
  });
});
