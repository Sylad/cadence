import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// L167 : docs/lead.md — le schéma du workflow du skill lead, générique, clair/sombre.
const root = join(import.meta.dirname, '..')
const read = (file: string) => readFileSync(join(root, file), 'utf8')
const svgs = { light: 'docs/lead-workflow-light.svg', dark: 'docs/lead-workflow-dark.svg' }

describe('docs/lead.md', () => {
  it('existe et affiche le schéma en deux variantes selon le thème GitHub', () => {
    const md = read('docs/lead.md')
    expect(md).toMatch(/<picture>/)
    expect(md).toContain('prefers-color-scheme: dark')
    for (const f of Object.values(svgs)) {
      expect(md).toContain(f.replace('docs/', ''))
      expect(existsSync(join(root, f)), f).toBe(true)
    }
  })

  it("décrit les étapes spec, maquette et accept d'un lot à écran (L177)", () => {
    const md = read('docs/lead.md')
    expect(md).toContain('`screen:`')
    for (const s of ['spec-writer', 'mockup', '`orchestrate.accept`', 'conformity', '`orchestrate.maquette']) expect(md, s).toContain(s)
    expect(md).toMatch(/precheck.*spec.*maquette.*accept.*implement.*ux.*review/s)
  })

  it("décrit l'étape fiche d'un lot spec: true et le relais des hypothèses (L188)", () => {
    const md = read('docs/lead.md')
    for (const s of ['`spec: true`', '**fiche**', '`orchestrate.fiche: false`', 'hypothèse de la fiche']) expect(md, s).toContain(s)
    expect(read('skills/lead/SKILL.md')).toContain('hypothèse de la fiche')
  })

  it('décrit le réglage lead.ux : le lead peut poser le verdict UX, l\'humain consulté en cas de doute (L197)', () => {
    const md = read('docs/lead.md')
    const skill = read('skills/lead/SKILL.md')
    for (const [name, text] of [['docs/lead.md', md], ['skill', skill], ['README', read('README.md')]] as const) {
      expect(text, name).toContain('lead.ux')
      expect(text, name).toMatch(/lead\.ux: lead/)
      expect(text, name).toMatch(/doubt|doute/)
    }
    expect(skill).toMatch(/lead\.ux.*human/s)
    expect(read('README.md')).toContain('verdict UX : lead')
  })

  it('décrit les règles permanentes et les codes de sortie', () => {
    const md = read('docs/lead.md')
    expect(md).toMatch(/^## .*[Rr]ules/m)
    expect(md).toMatch(/^## .*[Ee]xit codes/m)
    expect(md).toContain('60 %')
    expect(md).toContain('two subagents')
    for (const code of ['0', '1', '2', '3']) expect(md).toMatch(new RegExp(`\\| \`${code}\` \\|`))
  })

  it('reste générique : aucun nom de personne, de projet ni de chemin local', () => {
    const all = [read('docs/lead.md'), ...Object.values(svgs).map(read)].join('\n')
    expect(all).not.toMatch(/\/home\/|\/mnt\/|~\/|[A-Z]:\\|sylvain|ladoire|developpeur|aetherwx|maritime|dark-blue|big-blue/i)
  })

  it('est liée depuis le README', () => {
    expect(read('README.md')).toContain('docs/lead.md')
  })
})

describe.each(Object.entries(svgs))('schéma %s', (variant, file) => {
  const svg = read(file)

  it('est un SVG autonome et équilibré', () => {
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/)
    expect(svg).toMatch(/<title[^>]*>.+<\/title>/)
    expect(svg).not.toMatch(/<script|href="http|<image/)
    const open = (svg.match(/<(g|text|marker|defs|style)[\s>]/g) ?? []).length
    const close = (svg.match(/<\/(g|text|marker|defs|style)>/g) ?? []).length
    expect(open).toBe(close)
  })

  it("montre les étapes spec, maquette et accept avant l'implémentation (L177)", () => {
    for (const s of ['spec-writer', 'Mockup review', 'Accept', 'red tests', 'Spec']) {
      expect(svg, `${variant}: ${s}`).toContain(s)
    }
    const y = (id: string) => Number(new RegExp(`<g id="${id}"><rect x="(\\d+)" y="(\\d+)"`).exec(svg)?.[2])
    const x = (id: string) => Number(new RegExp(`<g id="${id}"><rect x="(\\d+)"`).exec(svg)?.[1])
    // les trois étapes sont dans le couloir orchestrate, au-dessus de l'implémentation, de gauche à droite
    expect(x('spec')).toBeLessThan(x('mockup'))
    expect(x('mockup')).toBeLessThan(x('accept'))
    expect(y('spec')).toBeLessThan(y('implement'))
    // aucune boîte ne sort du cadre
    const h = Number(/viewBox="0 0 \d+ (\d+)"/.exec(svg)?.[1])
    for (const id of ['spec', 'mockup', 'accept', 'implement', 'next']) expect(y(id) + 66, id).toBeLessThan(h)
  })

  it('a trois couloirs et les étapes du workflow', () => {
    for (const s of ['Human', 'Lead session', 'orchestrate', 'cadence lead tour', '--wave', 'journal.log',
      '--resume --answer', 'raf ux', 'raf done', 'qa-reviewer', '60 %', 'session-close', 'session next', 'cadence deliver']) {
      expect(svg, `${variant}: ${s}`).toContain(s)
    }
  })
})

it('les variantes clair et sombre diffèrent par les couleurs seulement', () => {
  const strip = (s: string) => s.replace(/#[0-9a-fA-F]{6}/g, '#')
  expect(strip(read(svgs.light))).toBe(strip(read(svgs.dark)))
  expect(read(svgs.light)).not.toBe(read(svgs.dark))
})
