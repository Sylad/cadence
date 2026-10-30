import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../src/cli.js'
import { readLeadContextThreshold } from '../src/lead.js'
import { validateConfig } from '../src/config-set.js'
import { tempDir } from './helpers.js'

const NOW = '2026-10-30T18:30:00'
const at = new Date(NOW).getTime()
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

function setup(yaml: string | null, tokens: number, window = 1_000_000) {
  const home = tempDir()
  const dir = tempDir()
  if (yaml !== null) writeFileSync(join(dir, 'cadence.yaml'), yaml)
  mkdirSync(join(home, 'hud-context'), { recursive: true })
  writeFileSync(join(home, 'hud-context', 's.json'), JSON.stringify({ cwd: dir, percent: (tokens / window) * 100, tokens, window, at: at - 1000 }))
  return { home, dir }
}

async function ctx(dir: string, home: string) {
  const out: string[] = []
  const err: string[] = []
  const code = await run(['session', 'context'], { cwd: dir, env: { CADENCE_HOME: home }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(NOW) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('lead.contextThreshold en tokens (L437)', () => {
  it('R1 — sans réglage, le seuil est de 150000 tokens, quelle que soit la fenêtre (460k sur 1M = atteint, 100k = sous le seuil)', async () => {
    const hi = setup(null, 460_000)
    expect((await ctx(hi.dir, hi.home)).out).toBe('ctx 46 % (460000/1000000)\nseuil 150000 tokens : atteint')
    const lo = setup(null, 100_000)
    expect((await ctx(lo.dir, lo.home)).out).toBe('ctx 10 % (100000/1000000)\nseuil 150000 tokens : sous le seuil')
  })

  it('R2 — le seuil du cadence.yaml du dossier remplace le défaut', async () => {
    const a = setup('lead:\n  contextThreshold: 80000\n', 90_000)
    expect((await ctx(a.dir, a.home)).out).toContain('seuil 80000 tokens : atteint')
    const b = setup('lead:\n  contextThreshold: 300000\n', 200_000)
    expect((await ctx(b.dir, b.home)).out).toContain('seuil 300000 tokens : sous le seuil')
  })

  it('R3 — à pile le seuil, il est atteint (« à partir de »)', async () => {
    const e = setup('lead:\n  contextThreshold: 150000\n', 150_000)
    expect((await ctx(e.dir, e.home)).out).toContain(': atteint')
    const u = setup('lead:\n  contextThreshold: 150000\n', 149_999)
    expect((await ctx(u.dir, u.home)).out).toContain(': sous le seuil')
  })

  it('R4 — absent, null, ou lead sans la clé (lead.ux seul) : le défaut', () => {
    for (const y of [null, '', 'lead:\n', 'lead:\n  ux: lead\n', 'lead:\n  contextThreshold:\n', 'depth: 2\n']) {
      const d = tempDir()
      if (y !== null) writeFileSync(join(d, 'cadence.yaml'), y)
      expect(readLeadContextThreshold(d), JSON.stringify(y)).toBe(150_000)
    }
  })

  it('R5 — une valeur qui n’est pas un entier ≥ 1 est refusée, avec le nom de la clé (exit 2, à lire comme au seuil)', async () => {
    for (const v of ['0', '-5', '1.5', '"150k"', 'true', '[1]', '{a: 1}']) {
      const s = setup(`lead:\n  contextThreshold: ${v}\n`, 10_000)
      const r = await ctx(s.dir, s.home)
      expect(r.code, v).toBe(2)
      expect(r.err, v).toContain('lead.contextThreshold')
    }
  })

  it('R6 — un lead qui n’est pas une table, ou un YAML illisible, est refusé', () => {
    for (const y of ['lead: 5\n', 'lead: [a]\n', 'lead: [\n']) {
      const d = tempDir()
      writeFileSync(join(d, 'cadence.yaml'), y)
      expect(() => readLeadContextThreshold(d), y).toThrow()
    }
  })

  it('R7 — le chiffre illisible reste un échec (exit 2) même avec un seuil posé', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'cadence.yaml'), 'lead:\n  contextThreshold: 100000\n')
    const r = await ctx(dir, tempDir())
    expect(r.code).toBe(2)
    expect(r.err).toContain('contexte illisible')
  })

  it('R8 — cadence config set relit lead.contextThreshold : une valeur invalide arrête la pose', () => {
    const d = tempDir()
    const f = join(d, 'cadence.yaml')
    writeFileSync(f, 'lead:\n  contextThreshold: 0\n')
    expect(() => validateConfig(f, d)).toThrow(/lead\.contextThreshold/)
    writeFileSync(f, 'lead:\n  contextThreshold: 120000\n')
    expect(() => validateConfig(f, d)).not.toThrow()
  })

  it('R9 — le skill lead et docs/lead.md lisent le seuil en tokens de session context, plus un 60 %', () => {
    for (const p of ['skills/lead/SKILL.md', 'docs/lead.md']) {
      const md = read(p)
      expect(md, p).toContain('lead.contextThreshold')
      expect(md, p).toContain('150000')
      expect(md, p).not.toMatch(/\*\*60 %\*\*|from 60 %/i)
    }
    expect(read('docs/session.md')).toContain('lead.contextThreshold')
    expect(read('CHANGELOG.md')).toContain('lead.contextThreshold')
  })
})
