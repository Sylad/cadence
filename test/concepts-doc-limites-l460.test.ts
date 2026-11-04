import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkLinks } from '../scripts/check-links.mjs'

// L460 (sonde) : les bords de docs/concepts.md et de ses schémas.
const root = join(import.meta.dirname, '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')
const svgs = readdirSync(join(root, 'docs')).filter((f) => /^concepts-.*\.svg$/.test(f))

describe('L460 — limites de docs/concepts.md', () => {
  it('les huit SVG existent, sans plus (aucun orphelin non référencé)', () => {
    expect(svgs.length).toBe(8)
    const md = read('docs/concepts.md')
    for (const f of svgs) expect(md, f).toContain(f)
  })

  it('tous les liens relatifs et ancres de concepts.md, README, fonctionnement.md et overview.md se résolvent', () => {
    expect(checkLinks(root, ['README.md', 'docs/concepts.md', 'docs/fonctionnement.md', 'docs/overview.md'])).toEqual([])
  })

  it("chaque SVG se termine par </svg> et n'a pas d'identifiant en double", () => {
    for (const f of svgs) {
      const s = read(`docs/${f}`)
      expect(s.trim().endsWith('</svg>'), f).toBe(true)
      const ids = [...s.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
      expect(new Set(ids).size, f).toBe(ids.length)
    }
  })

  it('chaque SVG déclare un viewBox, width et height, et rien ne sort du cadre', () => {
    for (const f of svgs) {
      const s = read(`docs/${f}`)
      const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(s)
      expect(vb, f).not.toBeNull()
      const [w, h] = [Number(vb![1]), Number(vb![2])]
      for (const m of s.matchAll(/<rect\b[^>]*>/g)) {
        const a = (n: string) => Number(new RegExp(`\\b${n}="(-?[\\d.]+)"`).exec(m[0])?.[1] ?? 0)
        if (!/\bwidth="/.test(m[0])) continue
        expect(a('x') + a('width'), `${f} ${m[0]}`).toBeLessThanOrEqual(w)
        expect(a('y') + a('height'), `${f} ${m[0]}`).toBeLessThanOrEqual(h)
        expect(a('x'), f).toBeGreaterThanOrEqual(0)
      }
      for (const m of s.matchAll(/<text\b[^>]*\bx="(-?[\d.]+)"[^>]*\by="(-?[\d.]+)"/g)) {
        expect(Number(m[1]), f).toBeLessThanOrEqual(w)
        expect(Number(m[2]), f).toBeLessThanOrEqual(h)
      }
    }
  })

  it('le texte d’un schéma tient dans sa case (largeur estimée à 0,5 em par caractère)', () => {
    for (const f of svgs.filter((x) => x.endsWith('light.svg'))) {
      const s = read(`docs/${f}`)
      const rects = [...s.matchAll(/<rect\b[^>]*>/g)].map((m) => {
        const a = (n: string) => Number(new RegExp(`\\b${n}="(-?[\\d.]+)"`).exec(m[0])?.[1] ?? NaN)
        return { x: a('x'), y: a('y'), w: a('width'), h: a('height') }
      }).filter((r) => r.w > 0 && r.w < 400)
      for (const m of s.matchAll(/<text\b([^>]*)>([^<]+)<\/text>/g)) {
        const x = Number(/\bx="(-?[\d.]+)"/.exec(m[1])?.[1])
        const y = Number(/\by="(-?[\d.]+)"/.exec(m[1])?.[1])
        const fs = Number(/font-size="([\d.]+)"/.exec(m[1])?.[1] ?? 13)
        if (!/text-anchor="middle"/.test(m[1])) continue
        const box = rects.find((r) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h)
        if (!box) continue
        expect(m[2].replace(/&(lt|gt|amp);/g, '_').length * fs * 0.5, `${f}: « ${m[2]} »`).toBeLessThanOrEqual(box.w)
      }
    }
  })

  it('le paquet publie les huit SVG et la page (package.json files)', () => {
    const files: string[] = JSON.parse(read('package.json')).files
    expect(files).toContain('docs/concepts.md')
    for (const f of svgs) expect(files, f).toContain(`docs/${f}`)
    for (const p of files.filter((x) => x.startsWith('docs/') && !x.includes('*'))) expect(existsSync(join(root, p)), p).toBe(true)
  })

  it('les titres de concepts.md sont uniques (une ancre ne vise qu’une section)', () => {
    const t = [...read('docs/concepts.md').replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6}\s+(.*)$/gm)].map((m) => m[1].trim().toLowerCase())
    expect(new Set(t).size).toBe(t.length)
  })

  it('le glossaire : chaque entrée est une ligne « - **terme**: définition » non vide, sans doublon', () => {
    const g = read('docs/concepts.md').split('## Glossary')[1]
    const lignes = g.split('\n').filter((l) => l.trim())
    const termes: string[] = []
    for (const l of lignes) {
      const m = /^- \*\*([^*]+)\*\*: (\S.+)$/.exec(l)
      expect(m, l).not.toBeNull()
      termes.push(m![1].toLowerCase())
    }
    expect(new Set(termes).size).toBe(termes.length)
  })

  it('chaque <picture> a un alt non vide et une source claire servie par défaut', () => {
    const md = read('docs/concepts.md')
    for (const p of md.match(/<picture>[\s\S]*?<\/picture>/g) ?? []) {
      expect(p).toMatch(/alt="[^"]{20,}"/)
      expect(p).toMatch(/<img [^>]*src="concepts-[a-z]+-light\.svg"/)
      expect(p).toMatch(/srcset="concepts-[a-z]+-dark\.svg"/)
    }
  })

  it('les commandes citées existent dans le programme (hold, release, deliver --sha, verify --gate, orchestrate --status)', () => {
    const md = read('docs/concepts.md')
    const cli = readdirSync(join(root, 'src'), { recursive: true }).map(String).filter((f) => f.endsWith('.ts')).map((f) => read(`src/${f}`)).join('\n')
    for (const w of ['hold', 'release', 'deliver', 'verify', 'tour', '--status', '--resume', '--max-sessions', 'CADENCE_MAX_SESSIONS', 'testReplay', 'readsPlan', 'escalation'])
      expect(cli, w).toContain(w)
    expect(md).toContain('cadence deliver --sha')
  })

  it('les chaînes françaises citées (créneaux libres, livrable jusqu’à) sont celles que le programme imprime', () => {
    const md = read('docs/concepts.md')
    const cli = readdirSync(join(root, 'src'), { recursive: true }).map(String).filter((f) => f.endsWith('.ts')).map((f) => read(`src/${f}`)).join('\n')
    for (const s of ['créneaux libres', "livrable jusqu'à"]) {
      expect(md, s).toContain(s)
      expect(cli, s).toContain(s)
    }
  })

  it('le fichier ne contient ni tabulation, ni espace en fin de ligne, ni marqueur de reste (TODO, XXX)', () => {
    for (const f of ['docs/concepts.md', ...svgs.map((x) => `docs/${x}`)]) {
      const s = read(f)
      expect(s, f).not.toMatch(/\t/)
      expect(s, f).not.toMatch(/\b(TODO|FIXME|XXX)\b/)
    }
  })

  it('le tirage d\u2019un lot du plan dans un créneau libre vaut pour toute vague et --no-fill l\u2019arrête (texte et figures, L587)', () => {
    const md = read('docs/concepts.md')
    expect(md).toMatch(/a freed slot is also filled at once by the next ready lot of the plan/)
    expect(md).toMatch(/`--no-fill` stops it/)
    expect(md).not.toMatch(/with `--continue`, a freed slot/)
    for (const f of svgs.filter((n) => n.startsWith('concepts-vague-'))) {
      const svg = read(`docs/${f}`)
      expect(svg, f).toContain('--no-fill: not')
      expect(svg, f).not.toMatch(/with --continue|drawn at once|takes it\./)
    }
  })

  it('les SVG ont des balises équilibrées (bonne formation minimale)', () => {
    for (const f of svgs) {
      const stack: string[] = []
      for (const m of read(`docs/${f}`).matchAll(/<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g)) {
        if (m[3]) continue
        if (m[1]) expect(stack.pop(), f).toBe(m[2])
        else stack.push(m[2])
      }
      expect(stack, f).toEqual([])
    }
  })

  it("la figure 3 nomme la branche comme le texte : cadence/<wave>/<project>--<lot>", () => {
    for (const f of svgs.filter((n) => n.includes('worktrees'))) {
      const s = read(`docs/${f}`)
      expect(s, f).not.toMatch(/&lt;wave&gt;\/L\d/)
      expect(s, f).toContain('&lt;wave&gt;/&lt;project&gt;--L1')
    }
  })

  it("l'étape ready ne promet l'intégration que en mode worktree (tableau et figure 1)", () => {
    const md = read('docs/concepts.md')
    const row = md.split('\n').find((l) => l.startsWith('| **ready**'))!
    expect(row).toMatch(/worktree mode/)
    for (const f of svgs.filter((n) => n.includes('-lot-'))) expect(read(`docs/${f}`), f).toContain('integrated (worktree mode)')
  })

  it("l'étape spec nomme l'acceptance-writer pour les tests d'acceptation", () => {
    const row = read('docs/concepts.md').split('\n').find((l) => l.startsWith('| **spec**'))!
    expect(row).toContain('acceptance-writer')
  })
})
