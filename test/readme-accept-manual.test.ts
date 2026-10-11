import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// L182 : le README dit comment lancer à la main la commande orchestrate.accept (hors vague).
describe('README, étape accept lancée à la main', () => {
  const text = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const start = text.indexOf('Out of the ordinary test run and the CI')
  const section = text.slice(start, text.indexOf('**What the program checks**', start))

  it('explique que la commande échoue hors vague sans CADENCE_ACCEPTATION', () => {
    expect(start).toBeGreaterThan(-1)
    expect(section).toMatch(/outside a wave[^.]*fails|fails[^.]*outside a wave/)
  })

  it('donne la forme CADENCE_ACCEPTATION=<chemin> <commande>', () => {
    expect(section).toContain('CADENCE_ACCEPTATION=<path of the acceptation file> <command>')
  })

  it("dit que les tests verts rejoignent le lanceur ordinaire", () => {
    expect(section).toMatch(/green[^.]*join[^.]*ordinary (runner|test)/)
  })
})
