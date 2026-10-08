import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// L119 : l'exemple de la bande doit suivre le rendu, qui coupe avec « ... » (ASCII), jamais « … ».
describe.each(['plugins/cadence-hud/README.md', 'README.md'])('exemple de la bande dans %s', (file) => {
  it("coupe les titres avec « ... », pas « … »", () => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    const start = text.indexOf('ctx ▰')
    const example = text.slice(start, text.indexOf('```', start))
    expect(start).toBeGreaterThan(-1)
    expect(example).toContain('...')
    expect(example).not.toContain('…')
  })
})
