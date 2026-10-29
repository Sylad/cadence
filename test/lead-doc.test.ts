import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { docText } from './docs-text.js';

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

  it("réserve les étapes spec, maquette et accept à screen: page (L209)", () => {
    const md = read('docs/lead.md')
    expect(md).toContain('`screen:` of `page`')
    expect(md).not.toContain('only for a lot that declares `screen:`')
    expect(md).toMatch(/`screen: component`|`component`/)
  })

  it("légende de la figure : precheck conditionnel, spec/accept pour screen: page ou spec: true (L211)", () => {
    const md = read('docs/lead.md')
    const legend = md.split('\n').find((l) => l.startsWith('Dashed boxes')) ?? ''
    expect(legend).toContain('`screen: page`')
    expect(legend).toContain('`spec: true`')
    expect(legend).toContain('precheck')
    expect(legend).not.toContain('(the spec and accept steps run only for a `screen: page` lot)')
    expect(md).not.toContain('only for a lot with a screen')
  })

  it("CHANGELOG : l'entrée L209 dit ce que raf spec on|off fait sur component et journey", () => {
    const entry = read('CHANGELOG.md').split('\n').find((l) => l.includes('(L209)')) ?? ''
    expect(entry).toContain('raf spec <id> off')
    expect(entry).toContain('raf spec <id> on')
  })

  it("aide de raf screen, ligne README et libellés des SVG : seule la valeur page adopte l'étape spec (L210)", () => {
    expect(read('src/cli.ts')).toMatch(/raf screen <id>[^\n]*seule la valeur page adopte l'étape spec/)
    const row = docText().split('\n').find((l) => l.startsWith('| `raf screen <id>')) ?? ''
    expect(row).toContain('only `page` adopts the [spec step]')
    for (const [variant, f] of Object.entries(svgs)) {
      const svg = read(f)
      expect(svg, variant).toContain('lots with screen: page')
      expect(svg, variant).toContain('Spec (screen: page)')
      expect(svg, variant).not.toContain('lots with a screen')
      expect(svg, variant).not.toContain('Spec (screen lots)')
    }
  })

  it("README, vue d'ensemble du lead : seul screen: page passe par spec, maquette et accept (L209)", () => {
    const readme = docText()
    expect(readme).toContain('a lot with `screen: page` first goes through the [spec, mockup review and accept steps]')
    expect(readme).not.toContain('a lot with a `screen:` first goes through')
  })

  it("décrit l'étape fiche d'un lot spec: true et le relais des hypothèses (L188)", () => {
    const md = read('docs/lead.md')
    for (const s of ['`spec: true`', '**fiche**', '`orchestrate.fiche: false`', 'hypothèse de la fiche']) expect(md, s).toContain(s)
    expect(read('skills/lead/SKILL.md')).toContain('hypothèse de la fiche')
  })

  it('décrit le réglage lead.ux : le lead peut poser le verdict UX, l\'humain consulté en cas de doute (L197)', () => {
    const md = read('docs/lead.md')
    const skill = read('skills/lead/SKILL.md')
    for (const [name, text] of [['docs/lead.md', md], ['skill', skill], ['README', docText()]] as const) {
      expect(text, name).toContain('lead.ux')
      expect(text, name).toMatch(/lead\.ux: lead/)
      expect(text, name).toMatch(/doubt|doute/)
    }
    expect(skill).toMatch(/lead\.ux.*human/s)
    expect(docText()).toContain('verdict UX : lead')
  })

  it("décrit le rescellé avec une fiche amendée par des commits du lot (L217, R1/R3)", () => {
    const row = read('docs/lead.md').split('\n').find((l) => l.includes('cadence spec reseal'))!
    expect(row).not.toContain('sheet unchanged')
    expect(row).toContain('amended sheet')
    expect(row).toMatch(/committed.*cit/)
  })

  it("R12 — la ligne lots du tour --json (L401) décrit le champ reviewed posé quand le plan porte la revue de code (L413)", () => {
    const row = read('docs/lead.md').split('\n').find((l) => l.includes('also carries `lots`')) ?? ''
    expect(row).toContain('reviewed?')
    expect(row).toMatch(/`reviewed: true`.*(code review|review)/)
    expect(row).toContain('cycle')
  })

  it('décrit les règles permanentes et les codes de sortie', () => {
    const md = read('docs/lead.md')
    expect(md).toMatch(/^## .*[Rr]ules/m)
    expect(md).toMatch(/^## .*[Ee]xit codes/m)
    expect(md).toContain('60 %')
    expect(md).toContain('as many subagents as the session cap') // le plafond est réglé par l'humain, plus 2 en dur (L208)
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

describe('cadence spec reseal : le chemin du lead pour un test scellé faux (L200)', () => {
  it('est décrit par le README, le skill lead et docs/lead.md', () => {
    for (const [name, text] of [['README', docText()], ['skill', read('skills/lead/SKILL.md')], ['docs/lead.md', read('docs/lead.md')]] as const) {
      expect(text, name).toContain('cadence spec reseal')
      expect(text, name).toContain('--reason')
    }
    expect(docText()).toContain('resceaux')
  })

  it('L212 : le rescellé d’un lot livré (--porteur) est décrit par le README, le CHANGELOG, le skill lead et docs/lead.md', () => {
    for (const [name, text] of [['README', docText()], ['CHANGELOG', read('CHANGELOG.md')], ['skill', read('skills/lead/SKILL.md')], ['docs/lead.md', read('docs/lead.md')]] as const) expect(text, name).toContain('--porteur')
  })
})

// L366 : un lot clos à la main avec acceptation-<lot>.json à vert: false verrouille les vagues suivantes ; spec reseal ne le débloque pas
// (il exige un lot doing, ou vert: true avec --porteur), le chemin du lead est cadence spec green.
describe('cadence spec green : le chemin du lead pour un lot clos à vert: false (L366)', () => {
  const pages = () => [['skill', read('skills/lead/SKILL.md')], ['docs/lead.md', read('docs/lead.md')], ['docs/spec.md', read('docs/spec.md')]] as const

  it('est décrit par le skill lead, docs/lead.md et docs/spec.md, avec le cas qu\'il couvre (vert: false, lot clos)', () => {
    for (const [name, text] of pages()) {
      expect(text, name).toContain('cadence spec green')
      expect(text, name).toContain('vert: false')
    }
  })

  it('le passage « verrou des tests d\'acceptation » du skill lead et de docs/lead.md mène à spec green, pas seulement à spec reseal', () => {
    for (const [name, text] of [['skill', read('skills/lead/SKILL.md')], ['docs/lead.md', read('docs/lead.md')]] as const) {
      const passage = text.split('\n').filter((l) => l.includes("verrou des tests d'acceptation") || l.includes('cadence spec reseal'))
      expect(passage.length, name).toBeGreaterThan(0)
      expect(passage.some((l) => l.includes('cadence spec green')), `${name} : la ligne du verrou cite spec green`).toBe(true)
    }
  })

  it('la liste des sous-commandes spec (docs/overview.md, docs/fonctionnement.md) cite green', () => {
    expect(read('docs/overview.md')).toContain('`cadence spec check\\|qa\\|reseal\\|green`')
    expect(read('docs/fonctionnement.md')).toContain('cadence spec green')
  })
})
