import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tempDir } from './helpers.js';

/** Faux serveur node : écrit son pid dans <dossier>/pid, écoute le port après `delay` ms (jamais si delay < 0). Hors du dépôt testé. */
const SCRIPT = `
const http = require('http');
const fs = require('fs');
const [dir, port, delay] = process.argv.slice(2);
fs.writeFileSync(dir + '/pid', String(process.pid));
console.log('faux serveur lancé');
if (Number(delay) >= 0) setTimeout(() => http.createServer((q, r) => r.end('ok')).listen(Number(port)), Number(delay));
else setInterval(() => {}, 1000);
`;

export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

export async function fakeApp(delay: number): Promise<{ dir: string; url: string; command: string; port: number }> {
  const dir = tempDir();
  writeFileSync(join(dir, 'fake.js'), SCRIPT);
  const port = await freePort();
  return { dir, port, url: `http://127.0.0.1:${port}/`, command: `node ${join(dir, 'fake.js')} ${dir} ${port} ${delay}` };
}
