import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tempDir } from './helpers.js';

/**
 * Faux serveur node : écrit son pid et son cwd dans <dossier>/pid et <dossier>/cwd, écoute le port après `delay` ms
 * (jamais si delay < 0), répond `status`, ignore SIGTERM si `stubborn`. Hors du dépôt testé.
 */
const SCRIPT = `
const http = require('http');
const fs = require('fs');
const [dir, port, delay, stubborn, status] = process.argv.slice(2);
fs.writeFileSync(dir + '/pid', String(process.pid));
fs.writeFileSync(dir + '/cwd', process.cwd());
if (stubborn === '1') process.on('SIGTERM', () => {});
console.log('démarrage du faux serveur');
if (Number(delay) >= 0) setTimeout(() => http.createServer((q, r) => { r.statusCode = Number(status); r.end('ok'); }).listen(Number(port)), Number(delay));
else setInterval(() => {}, 1000);
`;

export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

export interface FakeAppOpts {
  stubborn?: boolean;
  status?: number;
  /** Devant la commande (ex. `cd sub && PORT=1 `). */
  prefix?: string;
  /** Port imposé (deux lots sur la même URL). */
  port?: number;
}

export async function fakeApp(delay: number, opts: FakeAppOpts = {}): Promise<{ dir: string; url: string; command: string; port: number; log: string }> {
  const dir = tempDir();
  writeFileSync(join(dir, 'fake.js'), SCRIPT);
  const port = opts.port ?? (await freePort());
  const command = `${opts.prefix ?? ''}node ${join(dir, 'fake.js')} ${dir} ${port} ${delay} ${opts.stubborn ? 1 : 0} ${opts.status ?? 200}`;
  return { dir, port, url: `http://127.0.0.1:${port}/`, command, log: join(dir, 'ux-app.log') };
}
