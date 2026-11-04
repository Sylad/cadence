import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// L572 : les pages publiées décrivent la 3ᵉ revue de fiche, la mesure chiffre ce que la règle sauve.
const root = join(import.meta.dirname, '..')
const read = (file: string) => readFileSync(join(root, file), 'utf8')

describe('la revue de fiche converge — documentation (L572)', () => {
  it('docs/fonctionnement.md décrit la 3ᵉ revue de fiche quand elle converge', () => {
    const md = read('docs/fonctionnement.md')
    expect(md).toMatch(/sheet mode, two passes at most, a third when the review converges/)
  })

  it('docs/lead.md décrit la 3ᵉ revue de fiche quand elle converge', () => {
    const md = read('docs/lead.md')
    expect(md).not.toContain('reviews the back-end sheet (two passes at most, then')
    expect(md).toMatch(/reviews the back-end sheet \(two passes at most, a third when the review converges/)
  })

  it('la mesure donne le nombre de fiches qui auraient eu leur 3ᵉ revue (10 sur 12), pas un plafond', () => {
    const md = read('docs/mesures/fiche-converge-2026-11-04.md')
    expect(md).not.toContain('cannot be read back')
    expect(md).toMatch(/10 of these 12/)
    expect(md).toMatch(/L512/)
    expect(md).toMatch(/L558/)
  })
})
