import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const section = (): string => {
  const start = readme.indexOf('## Install as a Claude Code plugin')
  expect(start).toBeGreaterThan(-1)
  const next = readme.indexOf('\n## ', start + 1)
  return readme.slice(start, next === -1 ? undefined : next)
}

// L290 : le README dit comment installer cadence comme plugin Claude Code.
describe('README — installer comme plugin Claude Code (L290)', () => {
  it('R1 — la section donne la commande de la place de marché et les deux installations', () => {
    const s = section()
    expect(s).toContain('/plugin marketplace add Sylad/cadence')
    expect(s).toContain('/plugin install cadence@cadence')
    expect(s).toContain('/plugin install cadence-hud@cadence')
  })

  it('R2 — la section dit le lien avec la CLI npm (le plugin cadence en a besoin, cadence-hud non)', () => {
    const s = section()
    expect(s).toContain('@sylad/cadence')
    expect(s).toMatch(/cadence-hud[^\n]*without/i)
  })

  it('R3 — la section vient avant « Where to read more » et pointe vers docs/skills.md et docs/cadence-hud.md', () => {
    expect(readme.indexOf('## Install as a Claude Code plugin')).toBeLessThan(readme.indexOf('## Where to read more'))
    const s = section()
    expect(s).toContain('docs/skills.md')
    expect(s).toContain('docs/cadence-hud.md')
  })

  it('R4 — la place de marché déclare bien les deux plugins nommés par le README', () => {
    const m = JSON.parse(readFileSync(new URL('../.claude-plugin/marketplace.json', import.meta.url), 'utf8')) as {
      name: string
      plugins: { name: string }[]
    }
    expect(m.name).toBe('cadence')
    expect(m.plugins.map((p) => p.name).sort()).toEqual(['cadence', 'cadence-hud'])
  })
})
