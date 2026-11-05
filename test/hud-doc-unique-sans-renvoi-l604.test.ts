import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const lire = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

// L604 (E13) : le README du plugin n'est plus qu'une fiche courte ; aucune page ne doit renvoyer au README pour « le détail ».
describe('aucun renvoi au README du plugin pour le détail (L604)', () => {
  it('R6 — docs/cadence-hud.md ne dit plus « Details in the plugin\'s README »', () => {
    expect(lire('docs/cadence-hud.md')).not.toMatch(/plugin's README/i)
  })

  it('R7 — la page de docs ne renvoie au README du plugin que pour dire que c\'est la fiche courte', () => {
    const page = lire('docs/cadence-hud.md')
    const phrases = page.split('\n').filter((l) => /\bREADME\b/.test(l) && !/^\[← /.test(l))
    for (const l of phrases) expect(l).toMatch(/short card/)
  })
})
