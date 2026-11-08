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
suite_projet: { vitest_json: npx vitest run --outputFile=<sortie>/r.json, build: npm run build }
etapes:
  - { k: 1, lot: L1, demande: e1/demande.md, pieces: [docs/spec.pdf], references_depot: [docs/norme.md], taille: retouche }
  - { k: 2, lot: L2, demande: e2/demande.md, pieces: [], taille: fonction }
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
  for (const x of ['docs', 'e1', 'e2']) mkdirSync(join(d, x), { recursive: true });
  mkdirSync(s, { recursive: true });
  for (const f of ['e1/demande.md', 'e2/demande.md', 'docs/spec.pdf']) writeFileSync(join(d, f), 'x');
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
    expect(s.etapes[0].demande).toBe(join(s.dir, 'e1/demande.md'));
    expect(s.etapes.map((e) => e.references_depot)).toEqual([['docs/norme.md'], []]);
    expect(s.suite_projet).toEqual({ vitest_json: 'npx vitest run --outputFile=<sortie>/r.json', build: 'npm run build', portee: 'Suite mesurée : tout le dépôt' });
    const avecCd = chargerSequence(racine(SEQ.replace('vitest_json: npx', 'vitest_json: cd frontend && npx')), 's1').suite_projet.portee;
    expect(avecCd).toBe('Suite mesurée : frontend uniquement (le reste du dépôt est vu par le juge final)');
    expect(chargerSequence(racine(SEQ.replace('build: npm run build', 'build: npm run build, portee: "Suite mesurée : frontend uniquement (API et SLD vus par le juge final)"')), 's1')
      .suite_projet.portee).toBe('Suite mesurée : frontend uniquement (API et SLD vus par le juge final)');
    expect(s.etapes[0].pieces).toEqual([join(s.dir, 'docs/spec.pdf')]);
    expect(s.caches[2]).toEqual({ fichiers: [join(s.secrets, 'e2.test.ts')], commande: 'npx vitest e2' });
    expect(s.regression).toEqual({ a_partir_de: 2, fichiers: [join(s.secrets, 'reg.test.ts')], commande: 'npx vitest reg' });
  });
  it('refuse une séquence sans base', () => refus(SEQ.replace('base: e91b65c\n', ''), /base/));
  it('refuse une taille inconnue', () => refus(SEQ.replace('fonction', 'grosse'), /taille/));
  it('refuse une pièce absente', () => refus(SEQ.replace('docs/spec.pdf', 'docs/nope.pdf'), /pièce.*nope\.pdf/));
  it('refuse des étapes non numérotées 1..n', () => refus(SEQ.replace('k: 2', 'k: 3'), /étape.*1\.\.2/));
  it('refuse une demande absente', () => refus(SEQ.replace('e2/demande.md', 'zz/demande.md'), /demande.*zz\/demande\.md/));
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
    refus(SEQ.replace('e1/demande.md', '../e1/demande.md'), /demande.*sort du dossier/);
    refus(SEQ.replace('docs/spec.pdf', '/etc/hostname'), /pièce.*sort du dossier/);
    refus(SEQ.replace('docs/spec.pdf', '../../../secrets/sequences/s1/e1.test.ts'), /pièce.*sort du dossier/);
  });
  it('refuse une source absente, un yaml absent ou invalide', () => {
    refus(SEQ.replace('SRC', '/nope/xx'), /source/);
    refus('a: [', /YAML invalide.*sequence\.yaml/);
    refus(SEQ, /YAML invalide.*sequence-secrets\.yaml/, 'a: [');
    expect(() => chargerSequence(racine(), 'zz')).toThrow(/sequence\.yaml absent/);
  });
  it('refuse une demande hors de son dossier d\'étape, une référence hors du dépôt, une suite_projet sans <sortie>', () => {
    refus(SEQ.replace('e1/demande.md', 'docs/spec.pdf'), /demande\.md/);
    refus(SEQ.replace('e1/demande.md', 'demande.md'), /dossier de l'étape/);
    refus(SEQ.replace('[docs/norme.md]', '[../x.md]'), /référence.*hors du dépôt/);
    refus(SEQ.replace('[docs/norme.md]', '[/etc/hostname]'), /référence.*hors du dépôt/);
    refus(SEQ.replace('<sortie>/r.json', 'r.json'), /suite_projet/);
    refus(SEQ.replace(', build: npm run build', ''), /suite_projet/);
  });
  it('refuse une régression mal définie', () => {
    refus(SEQ, /regression/, SEC.replace(/regression:[\s\S]*/, ''));
    refus(SEQ, /a_partir_de/, SEC.replace('a_partir_de: 2', 'a_partir_de: 9'));
  });
});
