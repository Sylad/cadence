import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// L164 : la 1.0.0 fige un contrat — le README le liste, les versions et le CHANGELOG suivent.
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

describe('release 1.0.0 (L164)', () => {
  it('la version du paquet, du plugin et de la place de marché est au moins 1.0.0', () => {
    const major = (v: string) => Number(v.split('.')[0])
    expect(major(JSON.parse(read('package.json')).version)).toBeGreaterThanOrEqual(1)
    expect(major(JSON.parse(read('.claude-plugin/plugin.json')).version)).toBeGreaterThanOrEqual(1)
    const market = JSON.parse(read('.claude-plugin/marketplace.json'))
    expect(major(market.plugins.find((p: { name: string }) => p.name === 'cadence').version)).toBeGreaterThanOrEqual(1)
  })

  it('le CHANGELOG a une section 1.0.0 datée qui ouvre sur l’engagement semver', () => {
    const log = read('CHANGELOG.md')
    expect(log).toContain('## [1.0.0] - 2026-10-10')
    const after = log.slice(log.indexOf('## [1.0.0]')).split('\n').slice(1)
    const first = after.find((l) => l.trim() !== '') ?? ''
    expect(first).toMatch(/semantic versioning|semver/i)
  })

  it('le README garde la ligne 1.0.0 dans « What’s new » et la page docs/whats-new.md son paragraphe', () => {
    const whatsNew = read('docs/whats-new.md')
    expect(whatsNew.slice(whatsNew.indexOf('## In two lines'))).toMatch(/\*\*1\.0\.0\*\*: the first major release/)
    expect(read('docs/whats-new.md')).toMatch(/\*\*1\.0\.0\*\*: the first major release/)
  })

  it('le README liste la surface garantie et celle qui ne l’est pas', () => {
    const readme = read('docs/stabilite.md')
    const start = readme.indexOf('\n# Stability')
    expect(start).toBeGreaterThan(-1)
    const section = readme.slice(start)
    for (const word of ['raf', 'cadence orchestrate', 'cadence.yaml', 'raf.yaml', 'session-start', 'qa-reviewer',
      'cadence-hud', '.cadence/runs', 'schema version', 'precheck-reader', 'unknown fields']) expect(section).toContain(word)
    expect(section).toMatch(/not guaranteed/i)
  })

  it('la page Stability renvoie aux pages docs/ qui documentent les options, pas au README', () => {
    const stab = read('docs/stabilite.md')
    expect(stab).not.toMatch(/this README documents/)
    expect(stab).toMatch(/their options and exit codes as (the|these) .*pages? .*documents?/i)
    // toutes les commandes garanties ont leur page nommée (L232 : la garantie couvre news, session, lead tour, corrections et skills, pas seulement 4 pages)
    for (const page of ['raf', 'orchestrate', 'deliver', 'spec', 'news', 'session', 'lead', 'corrections', 'skills']) expect(stab).toContain(`${page}.md`)
  })
})
