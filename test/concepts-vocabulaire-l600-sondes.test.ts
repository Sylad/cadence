import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Sondes de L600 : ce que concepts.md affirme du code doit rester exact.
const root = join(import.meta.dirname, '..')
const md = readFileSync(join(root, 'docs/concepts.md'), 'utf8')
const glossaire = md.slice(md.indexOf('## Glossary'))
const entree = (terme: string) => glossaire.split('\n').find((l) => l.startsWith(`- **${terme}**`)) ?? ''

describe('L600 sondes — exactitude du vocabulaire', () => {
  it('« git hook » ne prétend pas que raf hook install pose le pre-push (le code ne le pose que dans une vague)', () => {
    const l = entree('git hook')
    expect(l).not.toBe('')
    // `raf hook install` pose post-commit et pre-commit ; le pre-push vient d'orchestrate (temporaire, ou laissé avec une porte).
    expect(l).toMatch(/orchestrate[^;]*pre-push|pre-push[^;]*orchestrate/)
    expect(l).not.toMatch(/raf hook install[^;`]*`?[^;]*installs[^;]*pre-push/)
    const install = l.split(';')[0] ?? ''
    expect(/pre-push/.test(install.split('raf hook install')[1] ?? '')).toBe(false)
  })

  it('la voie express dit qu’elle exclut un lot à écran ou à spec (isExpress)', () => {
    const i = md.indexOf('| **express** |')
    expect(i).toBeGreaterThan(-1)
    const ligne = md.slice(i, md.indexOf('\n', i))
    expect(ligne).toMatch(/no screen/i)
    expect(ligne).toMatch(/not a spec lot/i)
    expect(ligne).not.toMatch(/\ba spec lot too\b/i)
  })

  it('« les mots s’emboîtent » est dit avec le seuil par défaut (light est calculé à part)', () => {
    const i = md.indexOf('the words nest')
    expect(i).toBeGreaterThan(-1)
    expect(md.slice(i, md.indexOf('\n', i))).toMatch(/default threshold/)
  })

  it('« git hook » dit que la vague laisse un hook de la porte quand une porte est déclarée (keepGateGuard)', () => {
    const l = entree('git hook')
    expect(l).toMatch(/gate/i)
    expect(l).toMatch(/leaves|left|stays|remains|permanent/i)
  })

  it('la ligne small distingue review-small (lot visible) et review de code (sinon), comme firstReview', () => {
    const i = md.indexOf('| **small** |')
    expect(i).toBeGreaterThan(-1)
    const ligne = md.slice(i, md.indexOf('\n', i))
    expect(ligne).toMatch(/visible/)
    expect(ligne).toMatch(/`review`/)
    expect(ligne).not.toMatch(/one (single )?review pass/)
    expect(ligne).toMatch(/minor/)
    expect(glossaire).not.toMatch(/one single review pass/)
  })
})
