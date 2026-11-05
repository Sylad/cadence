import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const lire = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const readme = lire('plugins/cadence-hud/README.md')
const page = lire('docs/cadence-hud.md')

// L604 (E13) : une seule documentation de la bande. `docs/cadence-hud.md` fait foi ; le README du plugin est la fiche courte.
describe('documentation unique de cadence-hud (L604)', () => {
  it('R1 — le README du plugin est une fiche courte (moins de 60 lignes) qui renvoie à docs/cadence-hud.md', () => {
    expect(readme.split('\n').length).toBeLessThan(60)
    expect(readme).toContain('../../docs/cadence-hud.md')
  })

  it('R2 — la fiche donne l\'installation, les segments et /hud lots', () => {
    expect(readme).toContain('/plugin marketplace add Sylad/cadence')
    expect(readme).toContain('/plugin install cadence-hud@cadence')
    expect(readme).toMatch(/segments/i)
    expect(readme).toContain('/hud lots')
  })

  it('R3 — la fiche dit que la page de docs fait foi, et la page ne renvoie plus au README pour « le détail »', () => {
    expect(readme).toMatch(/docs\/cadence-hud\.md[^\n]*(faire foi|fait foi|reference)/i)
    expect(page).not.toContain('its own README has the details')
  })

  it.each([
    ['le fichier de contexte que lit cadence session context', 'hud-context'],
    ['la largeur ambiguë', 'CADENCE_HUD_AMBIGUOUS'],
    ['la chute des segments par priorité', 'quota windows go last'],
    ['les commandes d\'arrière-plan arrêtées par TaskStop', 'TaskStop'],
    ['le sous-agent synchrone', 'backgroundEndsWithFinalResponse'],
    ['l\'étape marquée en cours dont le processus est mort', '✝'],
    ['les seuils de couleur de la consommation', '60 % and 85 %'],
    ['la vérification du plugin', 'claude plugin validate'],
  ])('R4 — le détail du README d\'avant vit dans la page de docs : %s', (_nom, mot) => {
    expect(page).toContain(mot)
  })

  it('R5 — le README du plugin ne répète plus le détail (pas de segment « 2 cmd » détaillé)', () => {
    expect(readme).not.toContain('TaskStop')
    expect(readme).not.toContain('CADENCE_HUD_AMBIGUOUS')
  })
})
