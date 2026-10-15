import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// L211 : docs/fonctionnement.md — la mécanique de cadence en quatre figures autonomes, clair/sombre.
const root = join(import.meta.dirname, '..')
const read = (file: string) => readFileSync(join(root, file), 'utf8')
const figures = ['lot', 'wave', 'lead', 'service']
const svg = (name: string, variant: string) => `docs/fonctionnement-${name}-${variant}.svg`

describe('docs/fonctionnement.md (L211)', () => {
  it('affiche les quatre figures en deux variantes selon le thème GitHub', () => {
    const md = read('docs/fonctionnement.md')
    expect(md.match(/<picture>/g)?.length).toBe(4)
    expect(md).toContain('prefers-color-scheme: dark')
    for (const name of figures) for (const v of ['light', 'dark']) {
      expect(existsSync(join(root, svg(name, v))), svg(name, v)).toBe(true)
      expect(md).toContain(svg(name, v).replace('docs/', ''))
    }
  })

  it('chaque figure est autonome : ni CSS externe, ni variable, ni lien, un titre et un texte alternatif', () => {
    for (const name of figures) for (const v of ['light', 'dark']) {
      const s = read(svg(name, v))
      expect(s, svg(name, v)).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
      expect(s).toContain('<title>')
      expect(s).not.toMatch(/var\(--|<style|<link|href=|@import|class=/)
    }
  })

  it('les deux variantes d’une figure ont la même structure, seules les couleurs changent', () => {
    const strip = (s: string) => s.replace(/#[0-9a-fA-F]{6}/g, 'C')
    for (const name of figures) {
      expect(strip(read(svg(name, 'dark'))), name).toBe(strip(read(svg(name, 'light'))))
      expect(read(svg(name, 'dark')), name).not.toBe(read(svg(name, 'light')))
    }
  })

  it('dit les faits vérifiés contre le code : budgets, plafond, étapes, service', () => {
    const md = read('docs/fonctionnement.md')
    for (const s of ['540 k', '750 k', '570 k', '1.3 M', '450 k', '155 k', 'CADENCE_MAX_SESSIONS', 'hook.autostart', '`lead.ux: lead`',
      'cadence spec reseal', 'npm run service', '~/.local/share/cadence', 'screen: page', 'spec: true', 'raf check']) expect(md, s).toContain(s)
  })

  it('le petit lot : revue ergonomie seulement s’il est visible, sinon revue de code (doc et figure)', () => {
    const md = read('docs/fonctionnement.md')
    expect(md).toContain('code `review` otherwise')
    for (const v of ['light', 'dark']) {
      const s = read(`docs/fonctionnement-wave-${v}.svg`)
      expect(s, v).not.toContain('for code and UX')
      expect(s, v).toContain('review-small if visible')
    }
  })

  it('est lié depuis le README et depuis docs/lead.md', () => {
    expect(read('README.md')).toContain('docs/fonctionnement.md')
    expect(read('docs/lead.md')).toContain('fonctionnement.md')
  })
})

describe('schéma du lead remis à jour (L211)', () => {
  it('le plafond réglé, le précontrôle, la revue de fiche, la 3e passe et lead.ux y figurent', () => {
    for (const v of ['light', 'dark']) {
      const s = read(`docs/lead-workflow-${v}.svg`)
      expect(s, v).not.toContain('At most two sessions')
      for (const t of ['CADENCE_MAX_SESSIONS', 'Precheck', 'Sheet review', 'spec: true', '3rd if it converges', 'lead.ux']) expect(s, `${v} ${t}`).toContain(t)
    }
  })
})

describe('précontrôle conditionnel (L211)', () => {
  it('la doc et les figures le disent conditionnel : lot sans commit, sauf orchestrate.precheck: false', () => {
    expect(read('docs/fonctionnement.md')).toContain('orchestrate.precheck: false')
    expect(read('docs/fonctionnement.md')).not.toContain('Every lot starts with')
    for (const f of ['docs/fonctionnement.md', 'docs/fonctionnement-wave-light.svg', 'docs/fonctionnement-wave-dark.svg']) expect(read(f), f).not.toContain('Each lot goes through a precheck')
    expect(read('docs/fonctionnement.md')).toContain('1.3 M at least')
    expect(read('docs/fonctionnement.md')).toContain('750 k at least')
    for (const v of ['light', 'dark']) expect(read(`docs/fonctionnement-wave-${v}.svg`), v).toContain('unless it already has a sheet')
    for (const v of ['light', 'dark']) {
      expect(read(`docs/fonctionnement-wave-${v}.svg`), v).toMatch(/<rect x="20" y="140"[^>]*stroke-dasharray=/)
      expect(read(`docs/lead-workflow-${v}.svg`), v).toMatch(/<g id="precheck"><rect[^>]*stroke-dasharray=/)
    }
  })
})
