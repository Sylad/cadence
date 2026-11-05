import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkLinks } from '../scripts/check-links.mjs'
import { cadenceHome } from '../src/orchestrate/registry.js'

// L602 (E6 + E14 de docs/etudes/ensemble-2026-11.md) : docs/config.md liste les dossiers d'état et réunit les endroits où une porte se déclare.
const root = join(import.meta.dirname, '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')
const page = () => read('docs/config.md')

const STATE_TITLE = '## Where cadence writes'
const GATES_TITLE = '## Where a gate is declared'

/** Les lignes d'un tableau markdown sous le titre `heading` (sans l'en-tête ni le filet), cellules découpées. */
function rows(md: string, heading: string): string[][] {
  const start = md.indexOf(heading)
  expect(start, `titre « ${heading} » absent`).toBeGreaterThan(-1)
  const out: string[][] = []
  let inTable = false
  for (const l of md.slice(start + heading.length).split('\n')) {
    if (l.startsWith('|')) {
      inTable = true
      out.push(l.split('|').slice(1, -1).map((c) => c.trim()))
    } else if (inTable) break
  }
  return out.slice(2)
}

describe('L602 — où cadence écrit', () => {
  it('L602 — la page nomme les quatre dossiers d’état, les deux variables et l’exclusion git', () => {
    const md = page()
    const sec = md.slice(md.indexOf(STATE_TITLE), md.indexOf(GATES_TITLE))
    expect(sec.length).toBeGreaterThan(0)
    for (const d of ['.cadence/', '.cadence/runs/<wave>/', '~/.cadence/orchestrate', '~/.local/share/cadence']) expect(sec, d).toContain(d)
    expect(sec).toContain('CADENCE_HOME')
    expect(sec).toContain('XDG_DATA_HOME')
    expect(sec).toContain('.git/info/exclude')
  })

  it('L602 — les chemins par défaut dits par la page sont ceux du code, CADENCE_HOME les déplace', () => {
    expect(cadenceHome({ HOME: '/h' })).toBe('/h/.cadence/orchestrate')
    expect(cadenceHome({ HOME: '/h', CADENCE_HOME: '/x' })).toBe('/x')
    expect(read('src/ref/store.ts')).toContain("'.local', 'share'), 'cadence', 'references'")
  })

  it('L602 — la page dit que CADENCE_HOME ne couvre pas ~/.local/share/cadence', () => {
    expect(page()).toMatch(/CADENCE_HOME[^\n]*does not[^\n]*\.local\/share/)
  })
})

describe('L602 — où une porte se déclare', () => {
  const gates = () => rows(page(), GATES_TITLE)

  it('L602 — le tableau compte onze portes, chacune avec son endroit et ce qu’elle refuse', () => {
    const g = gates()
    expect(g).toHaveLength(11)
    for (const r of g) {
      expect(r, r[0]).toHaveLength(4)
      expect(['plan', 'cadence.yaml'], r[0]).toContain(r[2])
      expect(r[3].length, r[0]).toBeGreaterThan(10)
    }
  })

  it('L602 — chaque clé citée par le tableau est lue par le code', () => {
    const cfg = read('src/config.ts')
    const orchKeys = cfg.match(/const ORCH_KEYS = \[([^\]]*)\]/)![1]
    const plan = read('src/plan.ts')
    for (const r of gates()) {
      const key = r[1].match(/`([^`]+)`/)![1]
      if (key.startsWith('orchestrate.')) expect(orchKeys, key).toContain(`'${key.slice('orchestrate.'.length)}'`)
      else if (key === 'bounds') expect(read('src/bounds.ts')).toContain("readYamlKey(file, 'bounds')")
      else if (key === 'docs.sync') expect(cfg).toContain("const DOCS_KEYS = ['sync'")
      else expect(plan, key).toContain(`get ${key}()`)
    }
  })

  it('L602 — les portes de revue et d’UX sont au plan, les neuf autres dans cadence.yaml', () => {
    const where = gates().map((r) => r[2])
    expect(where.filter((w) => w === 'plan')).toHaveLength(2)
    expect(where.filter((w) => w === 'cadence.yaml')).toHaveLength(9)
  })

  it('L602 — la page dit où la porte se joue : gate.host et verify.inPlace', () => {
    const sec = page().slice(page().indexOf(GATES_TITLE))
    expect(sec).toContain('orchestrate.gate.host')
    expect(sec).toContain('verify.inPlace')
    expect(read('src/config.ts')).toContain("k !== 'inPlace'")
  })
})

describe('L602 — la page est atteignable', () => {
  it('L602 — README et overview la lient, et tous leurs liens se résolvent', () => {
    expect(read('README.md')).toContain('docs/config.md')
    expect(read('docs/overview.md')).toContain('(config.md)')
    expect(checkLinks(root, ['README.md', 'docs/config.md', 'docs/overview.md'])).toEqual([])
  })
  it('L602 — fonctionnement.md renvoie à la page', () => {
    expect(read('docs/fonctionnement.md')).toContain('(config.md')
  })
})
