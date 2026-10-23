import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FixtureLine {
  x: number;
  y: number;
  t: string;
}
export interface FixtureImage {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface FixturePage {
  lines: FixtureLine[];
  image?: FixtureImage;
}

/** PDF minimal (Helvetica 12, page 612×792 pt, image 2×2 RVB en ASCIIHex), écrit à la main : pas d'outil de génération à installer. */
export function buildPdf(pages: FixturePage[]): string {
  const objs: string[] = [];
  const add = (s: string): number => objs.push(s);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];
  const pageDicts = new Map<number, { content: number; xobject: string }>();
  for (const p of pages) {
    let content = '';
    let xobject = '';
    for (const l of p.lines) content += `BT /F1 12 Tf ${l.x} ${l.y} Td (${l.t}) Tj ET\n`;
    if (p.image) {
      const data = 'FF0000 00FF00 0000FF FFFFFF>';
      const img = add(`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${data.length} >>\nstream\n${data}\nendstream`);
      content += `q ${p.image.w} 0 0 ${p.image.h} ${p.image.x} ${p.image.y} cm /Im1 Do Q\n`;
      xobject = `/XObject << /Im1 ${img} 0 R >>`;
    }
    const cid = add(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
    const pid = add('');
    pageDicts.set(pid, { content: cid, xobject });
    pageIds.push(pid);
  }
  const root = add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  for (const [pid, d] of pageDicts) {
    objs[pid - 1] = `<< /Type /Page /Parent ${root} 0 R /MediaBox [0 0 612 792] /Contents ${d.content} 0 R /Resources << /Font << /F1 ${font} 0 R >> ${d.xobject} >> >>`;
  }
  const cat = add(`<< /Type /Catalog /Pages ${root} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

/** Le document de fixture : p.1 cite la Figure 1 et la Table 2, p.2 porte la Figure 1 (image + légende), p.3 la Table 2 (sans image) et cite une Figure 9 inexistante. */
export const NORME: FixturePage[] = [
  { lines: [{ x: 72, y: 700, t: 'The station model is drawn in Figure 1 on page two.' }, { x: 72, y: 680, t: 'Codes are listed in Table 2.' }] },
  { lines: [{ x: 72, y: 380, t: 'Figure 1 Station model' }], image: { x: 72, y: 400, w: 200, h: 100 } },
  { lines: [{ x: 72, y: 700, t: 'Table 2 Codes' }, { x: 72, y: 680, t: 'As shown below, see also Figure 9.' }] },
];

export function writePdf(dir: string, name: string, pages: FixturePage[]): string {
  const file = join(dir, name);
  writeFileSync(file, buildPdf(pages));
  return file;
}

/** Dossier de faux outils (`magick`, `tesseract`) : la suite ne dépend pas de ce que la machine a installé en plus de poppler. */
export function stubTools(dir: string, names: string[]): string {
  const bin = join(dir, 'stubs');
  mkdirSync(bin, { recursive: true });
  for (const n of names) {
    writeFileSync(join(bin, n), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, n), 0o755);
  }
  return bin;
}
