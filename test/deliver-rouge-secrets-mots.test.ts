import { describe, expect, it } from 'vitest';
import { maskSecrets } from '../src/state.js';

describe('L294 — secrets du journal des livraisons rouges : noms en un mot, guillemets non fermés', () => {
  it('R1 — un nom en un seul mot qui finit par un mot sensible est masqué (APIKEY, ACCESSTOKEN, GITHUBTOKEN)', () => {
    expect(maskSecrets('APIKEY=abc123')).toBe('APIKEY=***');
    expect(maskSecrets('ACCESSTOKEN=abc123')).toBe('ACCESSTOKEN=***');
    expect(maskSecrets('GITHUBTOKEN=abc123')).toBe('GITHUBTOKEN=***');
    expect(maskSecrets('export clientsecret=abc123')).toBe('export clientsecret=***');
    expect(maskSecrets('https://api.test/x?apikey=abc123&page=2')).toBe('https://api.test/x?apikey=***&page=2');
  });

  it('R2 — une valeur entre guillemets jamais refermés (coupée par la borne de 8192, ou sur plusieurs lignes) est masquée jusqu\'à la fin de la ligne', () => {
    expect(maskSecrets('API_KEY="abc def ghi')).toBe('API_KEY=***');
    expect(maskSecrets("DB_PASSWORD='hunter 2")).toBe('DB_PASSWORD=***');
    expect(maskSecrets('GITHUBTOKEN="abc')).toBe('GITHUBTOKEN=***');
  });

  it('R3 — les valeurs fermées gardent leur comportement et les noms ordinaires restent intacts', () => {
    expect(maskSecrets('API_KEY="abc def" suite')).toBe('API_KEY=*** suite');
    expect(maskSecrets('KEYBOARD=azerty')).toBe('KEYBOARD=azerty');
    expect(maskSecrets('MODE="a b')).toBe('MODE="a b');
    expect(maskSecrets('SECRETARY=bob')).toBe('SECRETARY=bob');
    expect(maskSecrets('page=2')).toBe('page=2');
  });

  it('R4 — un guillemet non fermé au nom ordinaire ne cache pas un secret placé plus loin sur la ligne', () => {
    expect(maskSecrets('MODE="a b API_KEY=abc123')).toBe('MODE="a b API_KEY=***');
    expect(maskSecrets('msg="failed API_KEY=abc123')).toBe('msg="failed API_KEY=***');
    expect(maskSecrets("DESC='x TOKEN=abc")).toBe("DESC='x TOKEN=***");
    expect(maskSecrets('MODE="a API_KEY=abc" suite')).toBe('MODE="a API_KEY=***" suite');
  });
});
