import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../src/cli.js'
import { findLeadDir } from '../src/lead.js'
import { tempDir } from './helpers.js'

const NOW = '2026-10-30T18:30:00'
const at = new Date(NOW).getTime()

async function ctx(cwd: string, tokens: number) {
  const home = tempDir()
  mkdirSync(join(home, 'hud-context'), { recursive: true })
  writeFileSync(join(home, 'hud-context', 's.json'), JSON.stringify({ cwd, percent: tokens / 10_000, tokens, window: 1_000_000, at: at - 1000 }))
  const out: string[] = []
  const err: string[] = []
  const code = await run(['session', 'context'], { cwd, env: { CADENCE_HOME: home }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(NOW) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

function tree(parentYaml: string | null, childYaml: string | null = null) {
  const parent = tempDir()
  const sub = join(parent, 'avatar-pandora', 'src')
  mkdirSync(sub, { recursive: true })
  if (parentYaml !== null) writeFileSync(join(parent, 'cadence.yaml'), parentYaml)
  if (childYaml !== null) writeFileSync(join(parent, 'avatar-pandora', 'cadence.yaml'), childYaml)
  return { parent, child: join(parent, 'avatar-pandora'), sub }
}

describe('session context depuis un sous-projet (L457)', () => {
  it('R1 — depuis un sous-projet, le seuil du lead (premier parent qui porte lead:) est lu, et le fichier est nommé', async () => {
    const t = tree('lead:\n  contextThreshold: 500000\n', 'name: x\n')
    const r = await ctx(t.child, 390_000)
    expect(r.out).toContain(`seuil 500000 tokens : sous le seuil (lu dans ${join(t.parent, 'cadence.yaml')})`)
  })

  it('R2 — un parent qui porte seulement priority: est le dossier du lead', () => {
    const t = tree('priority: [a]\n')
    expect(findLeadDir(t.sub)).toBe(t.parent)
  })

  it('R3 — le cadence.yaml du dossier courant l’emporte quand il porte lead: ; la sortie ne nomme alors aucun fichier', async () => {
    const t = tree('lead:\n  contextThreshold: 500000\n', 'lead:\n  contextThreshold: 100000\n')
    const r = await ctx(t.child, 390_000)
    expect(r.out).toContain('seuil 100000 tokens : atteint')
    expect(r.out).not.toContain('lu dans')
  })

  it('R4 — aucun parent ne porte lead: ni priority: : le dossier courant et le défaut 150000', async () => {
    const t = tree('depth: 2\n', 'name: x\n')
    expect(findLeadDir(t.sub)).toBe(t.sub)
    expect((await ctx(t.sub, 390_000)).out).toContain('seuil 150000 tokens : atteint')
  })

  it('R5 — un yaml illisible en chemin est sauté ; la valeur invalide du lead trouvé reste refusée (exit 2)', async () => {
    const bad = tree('lead:\n  contextThreshold: 500000\n', 'a: [unclosed\n')
    expect(findLeadDir(bad.sub)).toBe(bad.parent)
    const inv = tree('lead:\n  contextThreshold: 0\n')
    const r = await ctx(inv.child, 1000)
    expect(r.code).toBe(2)
    expect(r.err).toContain('lead.contextThreshold')
  })
})
