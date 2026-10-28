import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// L398 — les sessions de vague désactivent les plugins (`--settings {"enabledPlugins": …}`) ; les trois documents disent la même chose, avec les chiffres mesurés.
const root = join(import.meta.dirname, '..');
const lire = (p: string) => readFileSync(join(root, p), 'utf8');
const mesure = () => lire('docs/mesures/contexte-session-2026-10-28.md');
const paragraphe = () => /\*\*Context of a session \(L398\)\*\*[^\n]*/.exec(lire('docs/orchestrate.md'))?.[0] ?? '';
const ligne = () => lire('CHANGELOG.md').split('\n').find((l) => l.includes('(L398)')) ?? '';

describe('L398 — la mesure, la doc et le CHANGELOG décrivent la désactivation des plugins', () => {
  it('L398 — les trois documents nomment enabledPlugins, --settings, CLAUDE_CONFIG_DIR et les chiffres mesurés du premier tour', () => {
    for (const texte of [mesure(), paragraphe(), ligne()]) {
      expect(texte).toMatch(/enabledPlugins/);
      expect(texte).toMatch(/--settings/);
      expect(texte).toMatch(/CLAUDE_CONFIG_DIR/);
      expect(texte).toMatch(/42[  ]?541/);
      expect(texte).toMatch(/38[  ]?330/);
    }
  });

  it('L398 — la mesure consigne la vérification réelle (hook de démarrage non enregistré, skills disparus) et dit que −29 % ne vaut plus', () => {
    const m = mesure();
    expect(m).toMatch(/will NOT register/);
    expect(m).toMatch(/0 skill/);
    expect(m).toMatch(/−29 %[^\n]*ne vaut plus/);
  });

  it('L398 — la doc et le CHANGELOG ne décrivent plus la conception abandonnée : ni --setting-sources ni fichier user-settings.json ; tout le reste des réglages reste', () => {
    for (const texte of [paragraphe(), ligne()]) {
      expect(texte).not.toMatch(/setting-sources/);
      expect(texte).not.toMatch(/user-settings\.json/);
      expect(texte).toMatch(/[Nn]othing else/);
    }
  });
});
