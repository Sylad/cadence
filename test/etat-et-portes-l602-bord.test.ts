import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// L602 (E6 + E14) : les faits que docs/config.md avance, rejoués contre le code et les pages qu'elle cite.
const root = join(import.meta.dirname, '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')
const page = () => read('docs/config.md')
const slug = (h: string) => h.toLowerCase().replace(/[`()]/g, '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/ /g, '-')

describe('L602 — bord : la page contre le code', () => {
  it('L602 — chaque ancre citée par config.md existe comme titre de la page visée', () => {
    for (const m of page().matchAll(/\]\(([a-z-]+\.md)#([^)]+)\)/g)) {
      const heads = read(`docs/${m[1]}`).split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, '')))
      expect(heads, `${m[1]}#${m[2]}`).toContain(m[2])
    }
  })

  it('L602 — chaque page liée par config.md existe', () => {
    for (const m of page().matchAll(/\]\(([a-z-]+\.md)[#)]/g)) expect(() => read(`docs/${m[1]}`), m[1]).not.toThrow()
  })

  it('L602 — « the copy in service and the 3 before it » = KEPT_BEFORE', () => {
    expect(read('scripts/mise-en-service.mjs')).toContain('const KEPT_BEFORE = 3')
    expect(page()).toContain('the 3 before it')
  })

  it('L602 — les sous-dossiers de ~/.cadence/orchestrate nommés par la page existent dans le code', () => {
    const src = ['src/orchestrate/registry.ts', 'src/orchestrate/attente.ts', 'src/hud-context.ts', 'src/orchestrate/worktree.ts'].map(read).join('\n')
    for (const d of ['waves', 'slots', 'holds', 'waiters', 'hud-context', 'worktrees']) expect(src, d).toMatch(new RegExp(`'${d}'`))
  })

  it('L602 — l’exclusion git porte sur runs/ et corrections.json, comme dit', () => {
    const st = read('src/orchestrate/state.ts')
    expect(st).toContain('`${base}runs/`')
    expect(st).toContain('`${base}corrections.json`')
  })

  it('L602 — les clés annexes citées (testReplay, testRelated, docs.since, gate.host, gate.install, plan:) sont lues', () => {
    const cfg = read('src/config.ts')
    for (const k of ['testReplay', 'testRelated', 'host?', 'install?']) expect(cfg, k).toContain(k)
    expect(cfg).toContain("const DOCS_KEYS = ['sync', 'since'")
    expect(cfg).toMatch(/`plan:`/)
    expect(read('src/cli/lot-commands.ts')).toContain('docs-ok')
  })

  it('L602 — « on by default » : precheck, maquette, fiche sont vrais sans cadence.yaml, probe ne l’est pas', () => {
    const cfg = read('src/config.ts')
    expect(cfg).toMatch(/\{ precheck: true, maquette: true,[^}]*fiche: true/)
    expect(cfg).not.toMatch(/\{ precheck: true[^}]*probe: true/)
    const row = (n: string) => page().split('\n').find((l) => l.startsWith(`| ${n} |`)) ?? ''
    for (const n of ['Pre-check', 'Mockup', 'Back-end sheet']) expect(row(n), n).toContain('on by default')
    expect(row('Edge-case probe')).not.toContain('on by default')
  })

  it('L602 — une clé de porte inconnue du code reste refusée : la page ne cite aucune clé orchestrate hors ORCH_KEYS', () => {
    const orch = read('src/config.ts').match(/const ORCH_KEYS = \[([^\]]*)\]/)![1]
    for (const m of page().matchAll(/`orchestrate\.([a-zA-Z]+)/g)) expect(orch, m[1]).toContain(`'${m[1]}'`)
  })
})
