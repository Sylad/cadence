import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// L164 : la 1.0.0 fige un contrat — le README le liste, les versions et le CHANGELOG suivent.
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

describe('release 1.0.0 (L164)', () => {
  it('la version du paquet, du plugin et de la place de marché est 1.0.0', () => {
    expect(JSON.parse(read('package.json')).version).toBe('1.0.0')
    expect(JSON.parse(read('.claude-plugin/plugin.json')).version).toBe('1.0.0')
    const market = JSON.parse(read('.claude-plugin/marketplace.json'))
    expect(market.plugins.find((p: { name: string }) => p.name === 'cadence').version).toBe('1.0.0')
  })

  it('le CHANGELOG a une section 1.0.0 datée qui ouvre sur l’engagement semver', () => {
    const log = read('CHANGELOG.md')
    expect(log).toContain('## [1.0.0] - 2026-10-10')
    const after = log.slice(log.indexOf('## [1.0.0]')).split('\n').slice(1)
    const first = after.find((l) => l.trim() !== '') ?? ''
    expect(first).toMatch(/semantic versioning|semver/i)
  })

  it('le README ouvre « What’s new » sur 1.0.0', () => {
    expect(read('README.md')).toMatch(/## What's new\n\n\*\*1\.0\.0\*\*/)
  })

  it('le README liste la surface garantie et celle qui ne l’est pas', () => {
    const readme = read('README.md')
    const start = readme.indexOf('\n## Stability')
    expect(start).toBeGreaterThan(-1)
    const section = readme.slice(start, readme.indexOf('\n## ', start + 5))
    for (const word of ['raf', 'cadence orchestrate', 'cadence.yaml', 'raf.yaml', 'session-start', 'qa-reviewer',
      'cadence-hud', '.cadence/runs', 'schema version', 'precheck-reader', 'unknown fields']) expect(section).toContain(word)
    expect(section).toMatch(/not guaranteed/i)
  })
})
