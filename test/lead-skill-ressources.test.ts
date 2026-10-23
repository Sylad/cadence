import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// L253 (issue #13, 3/3) : le skill lead relit la liste « prêts, ressources libres » avant d'attendre.
const root = join(import.meta.dirname, '..')
const skill = readFileSync(join(root, 'skills/lead/SKILL.md'), 'utf8')
const section = skill.split('\n').find((l) => l.startsWith('**Free resources')) ?? ''

describe('skills/lead/SKILL.md — ressources libres (L253)', () => {
  it('R1 — le skill a un paragraphe « Free resources » qui nomme la ligne « prêts, ressources libres » et la commande qui l\'imprime', () => {
    expect(section).not.toBe('')
    expect(section).toContain('prêts, ressources libres')
    expect(section).toContain('cadence lead tour')
    expect(section).toContain('cadence orchestrate --continue')
  })

  it("R2 — la liste se relit à chaque retour d'agent et à chaque blocage", () => {
    expect(section).toMatch(/each time an agent (comes back|returns)/i)
    expect(section).toMatch(/each time a lot is blocked/i)
  })

  it("R3 — la relecture se fait avant d'attendre, et un lot libre se lance au lieu d'attendre", () => {
    expect(section).toMatch(/before (waiting|it waits)/i)
    expect(section).toMatch(/start (it|that lot)|instead of waiting/i)
  })

  it('R4 — la liste est un affichage : elle ne verrouille rien et ne lève pas le plafond de créneaux', () => {
    expect(section).toMatch(/display|nothing (is )?locked/i)
    expect(section).toContain('créneaux libres')
  })

  it('R5 — le paragraphe est dans la section de délégation par vague (2b), avant la 2c', () => {
    const at = skill.indexOf('**Free resources')
    expect(at).toBeGreaterThan(skill.indexOf('### 2b.'))
    expect(at).toBeLessThan(skill.indexOf('### 2c.'))
  })
})
