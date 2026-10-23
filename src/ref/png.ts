import { inflateSync, deflateSync } from 'node:zlib';
import { RafError } from '../plan.js';

export interface Raster {
  width: number;
  height: number;
  /** RVBA, 4 octets par pixel, ligne par ligne. */
  data: Buffer;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Type de couleur PNG → nombre de canaux (0 gris, 2 RVB, 4 gris + alpha, 6 RVBA). La palette (3) n'est pas lue. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Décode un PNG 8 bits non entrelacé (ce que `pdftoppm` écrit) en RVBA. Un PNG d'un autre genre est refusé avec la raison :
 * `measure` mesure les pixels, il ne les devine pas.
 */
export function decodePng(buf: Buffer, what: string): Raster {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new RafError(`ref : ${what} n'est pas un PNG`);
  let width = 0;
  let height = 0;
  let type = -1;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(at);
    const name = buf.toString('latin1', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (name === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      type = body[9]!;
      if (body[8] !== 8) throw new RafError(`ref : ${what} : PNG à ${body[8]} bits par canal, seuls les PNG 8 bits sont lus`);
      if (body[12] !== 0) throw new RafError(`ref : ${what} : PNG entrelacé, non lu`);
    } else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    at += 12 + len;
  }
  const channels = CHANNELS[type];
  if (channels === undefined || width < 1 || height < 1) throw new RafError(`ref : ${what} : PNG de type de couleur ${type} non lu (gris, RVB, avec ou sans alpha)`);
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    throw new RafError(`ref : ${what} : PNG abîmé (données illisibles)`);
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new RafError(`ref : ${what} : PNG tronqué`);
  const data = Buffer.alloc(width * height * 4);
  const line = Buffer.alloc(stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]!;
      const a = i >= channels ? line[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new RafError(`ref : ${what} : PNG abîmé (filtre ${filter})`);
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (channels <= 2) data.set([line[s]!, line[s]!, line[s]!, channels === 2 ? line[s + 1]! : 255], o);
      else data.set([line[s]!, line[s + 1]!, line[s + 2]!, channels === 4 ? line[s + 3]! : 255], o);
    }
    prev = Buffer.from(line);
  }
  return { width, height, data };
}

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(name: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(name, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Encode du RVBA en PNG RVBA 8 bits (sans filtre) : le recadrage que tesseract lit, et les images générées des tests. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
