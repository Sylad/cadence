import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BancInvalide } from '../src/bench/banc.js';
import { chargerSequence } from '../src/sequence/sequence.js';
import { dossierTemp } from './temp.js';

// L706 : une demande ne cite que les pièces déclarées de son étape ou des étapes d'avant.
// Vécu 10–12-11 : aether-b68-court/etapes/1/demande.md citait la pièce de aether-b68 ; les deux bras l'ouvraient, 4 passages rouges à tort.
const SEQ = (src: string) => `projet: aether
source: ${src}
base: e91b65c
install: npm ci
tests: npm test
suite_projet: { vitest_json: npx vitest run --outputFile=<sortie>/r.json, build: npm run build }
etapes:
  - { k: 1, lot: L1, demande: etapes/1/demande.md, pieces: [etapes/1/pieces/centres.webp], taille: retouche }
  - { k: 2, lot: L2, demande: etapes/2/demande.md, pieces: [etapes/2/pieces/suite.png], taille: fonction }
`;
const SEC = `caches:
  1: { fichiers: [e1.test.ts], commande: npx vitest e1 }
  2: { fichiers: [e2.test.ts], commande: npx vitest e2 }
regression: { a_partir_de: 2, fichiers: [e2.test.ts], commande: npx vitest reg }
`;

function banc(d1: (r: string) => string, d2: (r: string) => string = () => 'x'): string {
  const r = dossierTemp('seq-cit-');
  mkdirSync(join(r, 'src'));
  for (const s of ['aether-b68', 'aether-b68-court']) for (const k of [1, 2]) mkdirSync(join(r, 'sequences', s, 'etapes', String(k), 'pieces'), { recursive: true });
  const d = (s: string, f: string) => join(r, 'sequences', s, f);
  writeFileSync(d('aether-b68', 'etapes/1/pieces/centres-pression.webp'), 'x');
  writeFileSync(d('aether-b68-court', 'etapes/1/pieces/centres.webp'), 'x');
  writeFileSync(d('aether-b68-court', 'etapes/2/pieces/suite.png'), 'x');
  writeFileSync(d('aether-b68-court', 'etapes/1/demande.md'), d1(r));
  writeFileSync(d('aether-b68-court', 'etapes/2/demande.md'), d2(r));
  writeFileSync(d('aether-b68-court', 'sequence.yaml'), SEQ(join(r, 'src')));
  const s = join(r, 'secrets', 'sequences', 'aether-b68-court');
  mkdirSync(s, { recursive: true });
  for (const f of ['e1.test.ts', 'e2.test.ts']) writeFileSync(join(s, f), 'x');
  writeFileSync(join(s, 'sequence-secrets.yaml'), SEC);
  return r;
}
const charger = (r: string) => () => chargerSequence(r, 'aether-b68-court');

describe('L706 : une demande ne cite que les pièces permises', () => {
  it('refuse la pièce d\'une autre séquence (cas vécu), en nommant le chemin cité et les pièces permises', () => {
    const r = banc((r) => `Voir la capture ${join(r, 'sequences/aether-b68/etapes/1/pieces/centres-pression.webp')}.\n`);
    expect(charger(r)).toThrow(BancInvalide);
    expect(charger(r)).toThrow(/étape 1 : la demande cite « .*aether-b68\/etapes\/1\/pieces\/centres-pression\.webp ».*pièces permises : etapes\/1\/pieces\/centres\.webp/);
  });
  it('refuse un chemin ~ ou $HOME hors des pièces, et la pièce d\'une étape ultérieure', () => {
    expect(charger(banc(() => 'Lis ~/bench-cadence/sequences/aether-b68/etapes/1/pieces/x.webp'))).toThrow(/cite « ~\/bench-cadence/);
    expect(charger(banc(() => 'Lis $HOME/notes.md'))).toThrow(/cite « \$HOME\/notes\.md »/);
    expect(charger(banc(() => 'Voir etapes/2/pieces/suite.png'))).toThrow(/étape 1 : la demande cite « etapes\/2\/pieces\/suite\.png »/);
  });
  it('accepte ses pièces (absolues, relatives à la séquence ou à l\'étape), celles d\'avant, et ce qui n\'est pas un fichier', () => {
    const r = banc((r) => `La capture ${join(r, 'sequences/aether-b68-court/etapes/1/pieces/centres.webp')} et pieces/centres.webp ; l'API /api/wind, le fichier src/app/carte.ts.`,
      () => 'Comme en (etapes/1/pieces/centres.webp), avec `etapes/2/pieces/suite.png`.');
    expect(charger(r)().etapes).toHaveLength(2);
  });
});
