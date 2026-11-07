import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BancInvalide, chargerBanc, listerBancs, lireDemande, racineBanc } from '../src/bench/banc.js';

function racineAvec(bancs: Record<string, string>): string {
  const r = mkdtempSync(join(tmpdir(), 'banc-'));
  for (const [id, yaml] of Object.entries(bancs)) {
    mkdirSync(join(r, 'bancs', id), { recursive: true });
    writeFileSync(join(r, 'bancs', id, 'banc.yaml'), yaml);
    writeFileSync(join(r, 'bancs', id, 'demande.md'), `demande de ${id}\n`);
  }
  return r;
}
const YAML = `projet: ol-companion\nsource: /src/ol\nbase: e91b65c\ninstall: npm ci\ntests: npm test\nvisible: true\ntaille: retouche\n`;

describe('bancs', () => {
  it('charge un banc complet, avec les valeurs par défaut', () => {
    const r = racineAvec({ '1-ol-L239': YAML });
    const b = chargerBanc(r, '1-ol-L239');
    expect(b).toMatchObject({ id: '1-ol-L239', projet: 'ol-companion', base: 'e91b65c', visible: true, taille: 'retouche', frais: false, reponses: false });
    expect(b.secrets).toBe(join(r, 'secrets', '1-ol-L239'));
    expect(lireDemande(b)).toBe('demande de 1-ol-L239');
  });
  it('refuse un banc sans base, en nommant le champ', () => {
    const r = racineAvec({ '2-x': YAML.replace('base: e91b65c\n', '') });
    expect(() => chargerBanc(r, '2-x')).toThrow(BancInvalide);
    expect(() => chargerBanc(r, '2-x')).toThrow(/base/);
  });
  it('refuse une taille inconnue', () => {
    const r = racineAvec({ '3-x': YAML.replace('retouche', 'énorme') });
    expect(() => chargerBanc(r, '3-x')).toThrow(/taille/);
  });
  it('liste par numéro et filtre', () => {
    const r = racineAvec({ '10-a': YAML, '2-b': YAML, '1-c': YAML });
    expect(listerBancs(r).map((b) => b.id)).toEqual(['1-c', '2-b', '10-a']);
    expect(listerBancs(r, ['1', '10']).map((b) => b.id)).toEqual(['1-c', '10-a']);
  });
  it('racine : BENCH_ROOT, sinon ~/bench-cadence', () => {
    expect(racineBanc({ BENCH_ROOT: '/x' })).toBe('/x');
    expect(racineBanc({ HOME: '/h' })).toBe('/h/bench-cadence');
  });
});
