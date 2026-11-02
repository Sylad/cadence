import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// L460 : docs/concepts.md — le guide des notions de cadence pour un humain, quatre schémas clair/sombre.
const root = join(import.meta.dirname, '..')
const read = (file: string) => readFileSync(join(root, file), 'utf8')
const figures = ['lot', 'vague', 'worktrees', 'livraison']
const svg = (name: string, variant: string) => `docs/concepts-${name}-${variant}.svg`

describe('docs/concepts.md (L460)', () => {
  it('R1 — affiche les quatre schémas en deux variantes selon le thème GitHub', () => {
    const md = read('docs/concepts.md')
    expect(md.match(/<picture>/g)?.length).toBe(4)
    expect(md).toContain('prefers-color-scheme: dark')
    for (const name of figures) for (const v of ['light', 'dark']) {
      expect(existsSync(join(root, svg(name, v))), svg(name, v)).toBe(true)
      expect(md).toContain(svg(name, v).replace('docs/', ''))
    }
  })

  it('R2 — chaque schéma est autonome (ni CSS externe, ni lien), titré, et ses deux variantes ne diffèrent que par les couleurs', () => {
    const strip = (s: string) => s.replace(/#[0-9a-fA-F]{6}/g, 'C')
    for (const name of figures) {
      const light = read(svg(name, 'light'))
      const dark = read(svg(name, 'dark'))
      expect(light, name).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
      expect(light, name).toContain('<title>')
      expect(light, name).toContain('<desc>')
      expect(light + dark, name).not.toMatch(/var\(--|<style|<link|href=|@import|class=/)
      expect(strip(dark), name).toBe(strip(light))
      expect(dark, name).not.toBe(light)
    }
  })

  it('R3 — explique chaque notion de la liste du lot, dans l’ordre où on les rencontre', () => {
    const md = read('docs/concepts.md')
    const titres = ['Plan and lot', 'Verdicts', 'Session and wave', 'The steps of a lot', 'The test gate', 'One worktree per lot',
      'Deliverable up to', 'Lead and delivery agent', 'Slots and holds', 'Escalation', 'Putting into service and release', 'Glossary']
    let at = -1
    for (const t of titres) {
      const i = md.search(new RegExp(`^## .*${t}`, 'm'))
      expect(i, t).toBeGreaterThan(at)
      at = i
    }
  })

  it('R4 — dit QUI fait chaque étape d’un lot', () => {
    const md = read('docs/concepts.md')
    const etapes = md.slice(md.indexOf('## The steps of a lot'), md.indexOf('## The test gate'))
    for (const s of ['spec-writer', 'code-reviewer', 'ux-reviewer', 'the program', 'the lead', 'the human', 'fresh session'])
      expect(etapes, s).toContain(s)
  })

  it('R5 — le glossaire définit chaque terme de la liste', () => {
    const md = read('docs/concepts.md')
    const glossaire = md.slice(md.indexOf('## Glossary'))
    for (const t of ['plan', 'lot', 'verdict', 'session', 'wave', 'gate', 'worktree', 'integration', 'deliverable up to', 'lead',
      'delivery agent', 'slot', 'hold', 'escalation', 'service', 'release', 'readsPlan'])
      expect(glossaire.toLowerCase(), t).toContain(`**${t.toLowerCase()}**`)
  })

  it('R6 — les faits cités sont ceux de la doc détaillée (plafond, jeton, commandes, fichiers)', () => {
    const md = read('docs/concepts.md')
    for (const s of ['CADENCE_MAX_SESSIONS', 'cadence lead hold', 'npm run service', 'cadence release', 'git push origin <sha>:main',
      'orchestrate.worktrees', 'orchestrate.escalation', 'orchestrate.testReplay', 'readsPlan', '.cadence/raf.yaml', 'cadence verify --gate'])
      expect(md, s).toContain(s)
  })

  it('R7 — chaque notion renvoie vers la page technique qui la détaille', () => {
    const md = read('docs/concepts.md')
    for (const p of ['raf.md', 'orchestrate.md', 'lead.md', 'deliver.md', 'releasing.md', 'fonctionnement.md', 'spec.md'])
      expect(md, p).toContain(`](${p}`)
  })

  it('R8 — est lié en tête du README, depuis fonctionnement.md et depuis overview.md, et contrôlé par check-links', () => {
    const readme = read('README.md')
    expect(readme.indexOf('docs/concepts.md')).toBeGreaterThan(-1)
    expect(readme.indexOf('docs/concepts.md')).toBeLessThan(readme.indexOf('## Start'))
    expect(read('docs/fonctionnement.md')).toContain('concepts.md')
    expect(read('docs/overview.md')).toContain('concepts.md')
    expect(read('scripts/check-links.mjs')).toContain('docs/concepts.md')
  })
})
