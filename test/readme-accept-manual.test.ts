import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { docText } from './docs-text.js';

// L182 : le README dit comment lancer à la main la commande orchestrate.accept (hors vague).
describe('README, étape accept lancée à la main', () => {
  const text = docText()
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

  it('dit de poser CADENCE_ACCEPTATION_ROOT pour un lanceur d’une liste, sinon la racine est le dépôt', () => {
    expect(section).toContain('CADENCE_ACCEPTATION_ROOT=<root of the command>')
    expect(section).toMatch(/list[^.]*CADENCE_ACCEPTATION_ROOT|CADENCE_ACCEPTATION_ROOT[^.]*list/)
  })

  it('la consigne de la session accept le dit aussi', () => {
    const agent = readFileSync(new URL('../agents/acceptance-writer.md', import.meta.url), 'utf8')
    expect(agent).toContain('CADENCE_ACCEPTATION_ROOT')
  })

  // L203 : la section accept et l'agent disent l'exception e2e, sans règle absolue contraire.
  it("la section accept dit que l'acceptation e2e ne rejoint jamais le lanceur ordinaire", () => {
    expect(section).toContain('"e2e": true')
    expect(section).toContain('acceptationE2e()')
    expect(section).toMatch(/except an `"e2e": true` acceptation/)
  })

  it("l'agent acceptance-writer connaît la clé e2e", () => {
    const agent = readFileSync(new URL('../agents/acceptance-writer.md', import.meta.url), 'utf8')
    expect(agent).toContain('"e2e": true')
    expect(agent).toContain('acceptationE2e()')
  })

  it("la règle e2e n'est écrite qu'à un endroit : la section accept, pas l'étape spec", () => {
    expect(text.match(/End-to-end acceptance \(browser, build required\)/g)).toBeNull()
    expect(section).toMatch(/must build and start what the browser needs/)
  })
})
