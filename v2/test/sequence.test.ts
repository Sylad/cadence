import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BancInvalide } from '../src/bench/banc.js';
import { chargerSequence } from '../src/sequence/sequence.js';

const SEQ = `projet: ol-companion
source: SRC
base: e91b65c
install: npm ci
tests: npm test
etapes:
  - { k: 1, lot: L1, demande: etape-1.md, pieces: [docs/spec.pdf], taille: retouche }
  - { k: 2, lot: L2, demande: etape-2.md, pieces: [], taille: fonction }
`;
const SEC = `caches:
  1: { fichiers: [e1.test.ts], commande: npx vitest e1 }
  2: { fichiers: [e2.test.ts], commande: npx vitest e2 }
regression:
  a_partir_de: 2
  fichiers: [reg.test.ts]
  commande: npx vitest reg
`;

function racine(seq = SEQ, sec = SEC): string {
  const r = mkdtempSync(join(tmpdir(), 'seq-'));
  mkdirSync(join(r, 'src'));
  seq = seq.replace('SRC', join(r, 'src'));
  const d = join(r, 'sequences', 's1');
  const s = join(r, 'secrets', 'sequences', 's1');
  mkdirSync(join(d, 'docs'), { recursive: true });
  mkdirSync(s, { recursive: true });
  for (const f of ['etape-1.md', 'etape-2.md', 'docs/spec.pdf']) writeFileSync(join(d, f), 'x');
  for (const f of ['e1.test.ts', 'e2.test.ts', 'reg.test.ts']) writeFileSync(join(s, f), 'x');
  writeFileSync(join(d, 'sequence.yaml'), seq);
  writeFileSync(join(s, 'sequence-secrets.yaml'), sec);
  return r;
}
const refus = (seq: string, motif: RegExp, sec = SEC) => {
  const r = racine(seq, sec);
  expect(() => chargerSequence(r, 's1')).toThrow(BancInvalide);
  expect(() => chargerSequence(r, 's1')).toThrow(motif);
};

describe('séquence', () => {
  it('charge une séquence valide', () => {
    const r = racine();
    const s = chargerSequence(r, 's1');
    expect(s).toMatchObject({ id: 's1', projet: 'ol-companion', base: 'e91b65c', tests: 'npm test' });
    expect(s.secrets).toBe(join(r, 'secrets', 'sequences', 's1'));
    expect(s.etapes.map((e) => [e.k, e.taille])).toEqual([[1, 'retouche'], [2, 'fonction']]);
    expect(s.etapes[0].demande).toBe(join(s.dir, 'etape-1.md'));
    expect(s.etapes[0].pieces).toEqual([join(s.dir, 'docs/spec.pdf')]);
    expect(s.caches[2]).toEqual({ fichiers: [join(s.secrets, 'e2.test.ts')], commande: 'npx vitest e2' });
    expect(s.regression).toEqual({ a_partir_de: 2, fichiers: [join(s.secrets, 'reg.test.ts')], commande: 'npx vitest reg' });
  });
  it('refuse une séquence sans base', () => refus(SEQ.replace('base: e91b65c\n', ''), /base/));
  it('refuse une taille inconnue', () => refus(SEQ.replace('fonction', 'grosse'), /taille/));
  it('refuse une pièce absente', () => refus(SEQ.replace('docs/spec.pdf', 'docs/nope.pdf'), /pièce.*nope\.pdf/));
  it('refuse des étapes non numérotées 1..n', () => refus(SEQ.replace('k: 2', 'k: 3'), /étape.*1\.\.2/));
  it('refuse une demande absente', () => refus(SEQ.replace('etape-2.md', 'zz.md'), /demande.*zz\.md/));
  it('refuse une séquence sans étapes', () => refus(SEQ.replace(/etapes:[\s\S]*/, 'etapes: []\n'), /etapes/));
  it('refuse un test caché absent ou une étape sans cache', () => {
    refus(SEQ, /caché.*absent\.ts/, SEC.replace('[e1.test.ts]', '[absent.ts]'));
    refus(SEQ, /caches.*2/, SEC.replace(/  2: .*\n/, ''));
  });
  it('refuse des fichiers cachés vides, une clé de cache en trop', () => {
    refus(SEQ, /vide/, SEC.replace('[e1.test.ts]', '[]'));
    refus(SEQ, /clé « 3 »/, SEC.replace('regression:', '  3: { fichiers: [e1.test.ts], commande: x }\nregression:'));
  });
  it('refuse un chemin caché hors du dossier des secrets', () => {
    refus(SEQ, /sort du dossier des secrets/, SEC.replace('[e1.test.ts]', '[../autre.ts]'));
    refus(SEQ, /sort du dossier des secrets/, SEC.replace('[reg.test.ts]', '[/etc/hostname]'));
  });
  it('refuse un chemin public hors du dossier de la séquence', () => {
    refus(SEQ.replace('etape-1.md', '../etape-1.md'), /demande.*sort du dossier/);
    refus(SEQ.replace('docs/spec.pdf', '/etc/hostname'), /pièce.*sort du dossier/);
    refus(SEQ.replace('docs/spec.pdf', '../../../secrets/sequences/s1/e1.test.ts'), /pièce.*sort du dossier/);
  });
  it('refuse une source absente, un yaml absent ou invalide', () => {
    refus(SEQ.replace('SRC', '/nope/xx'), /source/);
    refus('a: [', /YAML invalide.*sequence\.yaml/);
    refus(SEQ, /YAML invalide.*sequence-secrets\.yaml/, 'a: [');
    expect(() => chargerSequence(racine(), 'zz')).toThrow(/sequence\.yaml absent/);
  });
  it('refuse une régression mal définie', () => {
    refus(SEQ, /regression/, SEC.replace(/regression:[\s\S]*/, ''));
    refus(SEQ, /a_partir_de/, SEC.replace('a_partir_de: 2', 'a_partir_de: 9'));
  });
});
