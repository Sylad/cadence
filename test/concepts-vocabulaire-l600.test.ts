import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkLinks } from '../scripts/check-links.mjs'

// L600 : docs/concepts.md explique la taille des lots, les quatre sens de « hook » et docs-ok.
const root = join(import.meta.dirname, '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')
const md = read('docs/concepts.md')
const section = (titre: string) => {
  const i = md.search(new RegExp(`^## .*${titre}`, 'm'))
  expect(i, titre).toBeGreaterThan(-1)
  const rest = md.slice(i + 3)
  const next = rest.search(/^## /m)
  return next < 0 ? rest : rest.slice(0, next)
}
const glossaire = () => md.slice(md.indexOf('## Glossary'))

describe('L600 — vocabulaire de concepts.md', () => {
  it('R1 — une section « The size of a lot » donne les trois seuils du code, et quickwin', () => {
    const s = section('The size of a lot')
    for (const w of ['express', 'light', 'small', 'full', 'quickwin']) expect(s, w).toContain(w)
    expect(s).toContain(String(read('src/orchestrate/express.ts').match(/EXPRESS_MAX_ESTIMATE = ([\d.]+)/)![1]))
    expect(s).toContain('0.1')
    expect(s).toContain('0.25')
    expect(s).toContain('0.5')
    expect(s).toContain('orchestrate.review.threshold')
    expect(s).toContain('raf quickwins')
  })

  it('R1b — les seuils écrits sont ceux du code (express, light, small)', () => {
    expect(read('src/orchestrate/express.ts')).toMatch(/EXPRESS_MAX_ESTIMATE = 0\.1;/)
    expect(read('src/config.ts')).toMatch(/review: \{ threshold: 0\.25,/)
    expect(read('src/orchestrate/preflight.ts')).toContain('lot.estimate <= 0.5 || lot.quickwin')
  })

  it('R2 — le glossaire définit express, light, small, full et quickwin', () => {
    const g = glossaire().toLowerCase()
    for (const t of ['express', 'light', 'small', 'full', 'quickwin']) expect(g, t).toContain(`**${t}**`)
  })

  it('R3 — le glossaire distingue les quatre sens de « hook »', () => {
    const g = glossaire()
    for (const t of ['git hook', 'Claude Code hook', 'plan.onWrite', 'mod hook']) expect(g, t).toContain(`**${t}**`)
    expect(g).toContain('raf hook install')
    expect(g).toContain('cadence claude-hook')
    expect(g).toContain('hooks/hooks.json')
    expect(g).toContain('plugins/cadence-hud/hooks/')
  })

  it('R4 — le glossaire dit les trois graphies de docs-ok et leur lien', () => {
    const g = glossaire()
    expect(g).toContain('**docs-ok**')
    for (const w of ['raf docs-ok', '.cadence/docs-ok.yaml', 'docs_ok', 'docsOk']) expect(g, w).toContain(w)
  })

  it('R4b — les trois graphies existent bien dans le code', () => {
    expect(read('src/plan.ts')).toContain('docs_ok')
    expect(read('src/plan.ts')).toContain('docsOk')
    expect(read('src/docs-ok-file.ts')).toContain('docs-ok.yaml')
  })

  it('R5 — les liens de concepts.md se résolvent', () => {
    expect(checkLinks(root, ['docs/concepts.md'])).toEqual([])
  })
})
