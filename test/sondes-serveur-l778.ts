// L778, revue r1 : un petit serveur HTTP et WebSocket local pour prouver que les sondes n'écrivent rien. Il sert les pages de
// test/fixtures/sondes/ et note TOUT ce qu'il reçoit : chaque requête HTTP (méthode et chemin) et chaque message WebSocket.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';

interface Recu { http: string[]; websocket: string[]; connexions: number }

/** Les messages texte d'un tampon de trames client (masquées), courtes ou moyennes : assez pour un test. */
function trames(tampon: Buffer): { textes: string[]; reste: Buffer } {
  const textes: string[] = [];
  let i = 0;
  while (tampon.length - i >= 6) {
    const op = tampon[i]! & 0x0f;
    let long = tampon[i + 1]! & 0x7f;
    let tete = 2;
    if (long === 126) { if (tampon.length - i < 8) break; long = tampon.readUInt16BE(i + 2); tete = 4; }
    if (tampon.length - i < tete + 4 + long) break;
    const masque = tampon.subarray(i + tete, i + tete + 4);
    const charge = Buffer.from(tampon.subarray(i + tete + 4, i + tete + 4 + long).map((b, k) => b ^ masque[k % 4]!));
    if (op === 1 || op === 2) textes.push(charge.toString('utf8'));
    i += tete + 4 + long;
  }
  return { textes, reste: tampon.subarray(i) };
}

export async function serveurSondes(dossier: string): Promise<{ url: string; recu: Recu; fermer: () => Promise<void> }> {
  const recu: Recu = { http: [], websocket: [], connexions: 0 };
  const sockets = new Set<Socket>();
  const serveur: Server = createServer((req, res) => {
    recu.http.push(`${req.method} ${req.url}`);
    const chemin = (req.url ?? '/').split(/[?#]/)[0]!;
    try {
      const corps = readFileSync(join(dossier, chemin.replace(/^\/+/, '')));
      const type = chemin.endsWith('.html') ? 'text/html; charset=utf-8' : chemin.endsWith('.js') ? 'text/javascript' : 'text/plain';
      res.writeHead(200, { 'content-type': type }).end(corps);
    } catch {
      res.writeHead(req.method === 'GET' ? 404 : 200).end('ok');
    }
  });
  serveur.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  serveur.on('upgrade', (req, socket) => {
    recu.connexions += 1;
    const cle = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${cle}\r\n\r\n`);
    let reste: Buffer = Buffer.alloc(0);
    socket.on('data', (d: Buffer) => {
      const lu = trames(Buffer.concat([reste, d]));
      reste = lu.reste;
      recu.websocket.push(...lu.textes);
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((ok) => serveur.listen(0, '127.0.0.1', ok));
  const port = (serveur.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    recu,
    fermer: () => new Promise<void>((ok) => { for (const s of sockets) s.destroy(); serveur.close(() => ok()); }),
  };
}
