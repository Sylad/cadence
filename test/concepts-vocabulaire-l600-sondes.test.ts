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
    // `raf hook install` pose post-commit et pre-commit ; le pre-push est temporaire, posé par orchestrate.
    expect(/pre-push/.test(l) && /raf hook install/.test(l) && !/orchestrate/.test(l)).toBe(false)
  })

  it('la voie express dit qu’elle exclut un lot à écran ou à spec (isExpress)', () => {
    const i = md.indexOf('| **express** |')
    expect(i).toBeGreaterThan(-1)
    const ligne = md.slice(i, md.indexOf('\n', i))
    expect(ligne).toMatch(/screen|écran|spec/i)
  })
})
